/**
 * Автотрассировка: недостающие соединения ведутся по сетке лабиринтным поиском (A*) с учётом зазоров,
 * отступа от края, ширины дорожки и (на двухсторонней плате) переходных отверстий.
 *
 * Как устроено:
 *  - на каждом слое строится карта «чья это клетка»: клетка в пределах зазора + половины ширины дорожки
 *    от меди цепи X принадлежит X; если рядом медь двух разных цепей или край платы — клетка закрыта;
 *  - соединение (две площадки соседних групп одной цепи, как у линий связей) ищется от клеток внутри
 *    первой площадки до клеток внутри второй; поворот и переход стоят дороже прямого хода;
 *  - найденная трасса упрощается до изгибов и добавляется дорожками и переходами; её медь сразу
 *    становится препятствием для следующих цепей;
 *  - если что-то не развелось, порядок меняется (неразведённые — первыми) и попытка повторяется;
 *    остаётся лучший результат. В конце DRC: дорожка, нарушившая зазор, убирается.
 * Существующие дорожки не трогаются. Заливка не считается препятствием: она обтекает новые дорожки.
 */
import { distToShape, polyMask } from './field';
import { logChange, touch } from './factory';
import { newId } from './ids';
import type { Point, ProjectDoc, Track, TrackEnd, Via } from './model';
import {
  allPads, boardPolygon, checkTrack, copperGroups, copperLayers, drc, netName, padKey, padShape, rulesOf, trackShapes, viaShape,
  type Layer, type PadInfo, type Shape,
} from './pcb';

export interface AutorouteOptions {
  /** Ширина новых дорожек (по умолчанию — из правил платы). */
  widthMm?: number;
  /** Шаг сетки, мм (по умолчанию 0,3175 — четверть шага 1,27; на больших платах крупнее). */
  stepMm?: number;
  /** Число попыток с разным порядком соединений. */
  passes?: number;
}

export interface AutorouteResult {
  doc: ProjectDoc;
  routed: number;
  total: number;
  failed: Array<{ netId: string; net: string; from: string; to: string }>;
  vias: number;
  lengthMm: number;
}

interface Conn { netId: string; a: PadInfo; b: PadInfo; len: number }

const DIRS: Array<[number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Недостающие соединения: для каждой цепи — пары площадок между группами уже соединённой меди (минимальное дерево). */
export function missingConnections(doc: ProjectDoc, withPours = true): Conn[] {
  const find = copperGroups(doc, withPours);
  const byNet = new Map<string, PadInfo[]>();
  for (const p of allPads(doc)) if (p.netId) byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), p]);
  const out: Conn[] = [];
  for (const [netId, pads] of byNet) {
    const groups = new Map<string, PadInfo[]>();
    for (const p of pads) { const r = find(padKey(p.ref)); groups.set(r, [...(groups.get(r) ?? []), p]); }
    const gs = [...groups.values()];
    if (gs.length < 2) continue;
    const connected = [gs.shift()!];
    while (gs.length) {
      let best = { gi: 0, a: connected[0]![0]!, b: gs[0]![0]!, d: Infinity };
      for (const cg of connected) for (const [gi, g] of gs.entries()) for (const a of cg) for (const b of g) {
        const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        if (d < best.d) best = { gi, a, b, d };
      }
      out.push({ netId, a: best.a, b: best.b, len: best.d });
      connected.push(gs.splice(best.gi, 1)[0]!);
    }
  }
  return out;
}

class Grid {
  nx: number; ny: number; x0: number; y0: number;
  /** Владелец клетки на слое: 0 — свободна, n > 0 — цепь n, −1 — закрыта. Для дорожки и для перехода — отдельно. */
  track: Int32Array[]; via: Int32Array[];
  constructor(public step: number, x0: number, y0: number, x1: number, y1: number, public layers: Layer[]) {
    this.x0 = x0; this.y0 = y0;
    this.nx = Math.ceil((x1 - x0) / step) + 1; this.ny = Math.ceil((y1 - y0) / step) + 1;
    this.track = layers.map(() => new Int32Array(this.nx * this.ny));
    this.via = layers.map(() => new Int32Array(this.nx * this.ny));
  }
  pt(c: number): Point { const i = c % this.nx; return { x: this.x0 + i * this.step, y: this.y0 + ((c - i) / this.nx) * this.step }; }
  /** Пометить клетки в пределах reach от фигуры как принадлежащие цепи net. */
  claim(map: Int32Array, s: Shape, reach: number, net: number) {
    const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y);
    const m = s.r + reach + this.step;
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - m - this.x0) / this.step)), i1 = Math.min(this.nx - 1, Math.ceil((Math.max(...xs) + m - this.x0) / this.step));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - m - this.y0) / this.step)), j1 = Math.min(this.ny - 1, Math.ceil((Math.max(...ys) + m - this.y0) / this.step));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * this.nx + i;
      const cur = map[k]!;
      if (cur === -1 || cur === net) continue;
      if (distToShape({ x: this.x0 + i * this.step, y: this.y0 + j * this.step }, s) < reach) map[k] = cur === 0 ? net : -1;
    }
  }
}

class Heap {
  k: number[] = []; v: number[] = [];
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p]! <= key) break; k[i] = k[p]!; v[i] = v[p]!; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0]!;
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < k.length && k[l]! < mk) { m = l; mk = k[l]!; }
        if (r < k.length && k[r]! < mk) { m = r; mk = k[r]!; }
        if (m === i) break;
        k[i] = k[m]!; v[i] = v[m]!; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

/** Развести недостающие соединения. Одна правка документа (отменяется Ctrl+Z). */
export function autoroute(doc0: ProjectDoc, opts: AutorouteOptions = {}): AutorouteResult {
  const board = doc0.pcb.board;
  if (!board) return { doc: doc0, routed: 0, total: 0, failed: [], vias: 0, lengthMm: 0 };
  const rules = rulesOf(doc0);
  const w = opts.widthMm ?? rules.trackMm;
  // Заливка ненадёжна как соединение (новые дорожки меняют её форму): сначала разводим всё дорожками,
  // потом убираем дорожки цепи заливки, без которых соединение через заливку сохраняется.
  const conns0 = missingConnections(doc0, false);
  if (!conns0.length) return { doc: doc0, routed: 0, total: 0, failed: [], vias: 0, lengthMm: 0 };
  const passes = opts.passes ?? 3;
  const pourNets = new Set(doc0.pcb.pours.map((p) => p.netId));
  const label = (c: Conn) => `${c.a.refDes}.${c.a.ref.pad}|${c.b.refDes}.${c.b.ref.pad}`;
  // Цепи с заливкой — последними: их соединения может взять на себя заливка
  const sorted = conns0.slice().sort((a, b) => (pourNets.has(a.netId) ? 1 : 0) - (pourNets.has(b.netId) ? 1 : 0) || a.len - b.len);
  let order = sorted;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  /** Итог попытки: что не соединено с учётом заливки после чистки лишних дорожек земли. */
  const finish = (r: AutorouteResult): AutorouteResult => {
    const pruned = prunePourTracks(r.doc, doc0);
    const still = missingConnections(pruned.doc, true);
    const failed = still.map((c) => ({ netId: c.netId, net: netName(doc0, c.netId), from: `${c.a.refDes}.${c.a.ref.pad}`, to: `${c.b.refDes}.${c.b.ref.pad}` }));
    return { ...r, doc: pruned.doc, failed, routed: Math.max(0, r.total - failed.length), lengthMm: r.lengthMm - pruned.lengthMm };
  };
  let best: AutorouteResult | null = null;
  for (let pass = 0; pass < passes; pass++) {
    const raw = routeOnce(doc0, order, w, opts.stepMm);
    const r = finish(raw);
    if (!best || r.failed.length < best.failed.length || (r.failed.length === best.failed.length && r.lengthMm < best.lengthMm)) best = r;
    if (r.failed.length === 0) break;
    // Неразведённые — первыми; со второй половины попыток — ещё и случайный порядок остальных
    const failedKeys = new Set(raw.failed.map((f) => `${f.from}|${f.to}`));
    const rest = order.filter((c) => !failedKeys.has(label(c)));
    if (pass >= passes / 2) for (let k = rest.length - 1; k > 0; k--) { const m = Math.floor(rnd() * (k + 1)); [rest[k], rest[m]] = [rest[m]!, rest[k]!]; }
    order = [...order.filter((c) => failedKeys.has(label(c))), ...rest];
  }
  const res = best!;
  if (res.total - res.failed.length === 0 && res.doc.pcb.tracks.length === doc0.pcb.tracks.length) return { ...res, doc: doc0, routed: 0 };
  const msg = `Автотрассировка: разведено ${res.routed} из ${res.total}${res.vias ? `, переходов ${res.vias}` : ''}${res.failed.length ? `; не удалось: ${res.failed.map((f) => `${f.from}–${f.to}`).join(', ')}` : ''}`;
  return { ...res, doc: logChange(touch(res.doc), 'pcb-autoroute', msg) };
}

/** Убрать новые дорожки цепей с заливкой, если заливка и без них соединяет всё, что они соединяли. */
function prunePourTracks(doc: ProjectDoc, doc0: ProjectDoc): { doc: ProjectDoc; lengthMm: number } {
  const pourNets = new Set(doc.pcb.pours.map((p) => p.netId));
  if (!pourNets.size) return { doc, lengthMm: 0 };
  const old = new Set(doc0.pcb.tracks.map((t) => t.id));
  const len = (t: Track) => t.points.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - t.points[i]!.x, p.y - t.points[i]!.y), 0);
  const candidates = doc.pcb.tracks.filter((t) => !old.has(t.id) && pourNets.has(t.netId) && t.from?.kind === 'pad' && t.to?.kind === 'pad').sort((a, b) => len(b) - len(a));
  const missing = (d: ProjectDoc) => missingConnections(d, true).length;
  const base = missing(doc);
  let removed = 0;
  for (const t of candidates) {
    const next = { ...doc, pcb: { ...doc.pcb, tracks: doc.pcb.tracks.filter((x) => x.id !== t.id) } };
    if (missing(next) <= base) { doc = next; removed += len(t); }
  }
  return { doc, lengthMm: removed };
}

function routeOnce(doc0: ProjectDoc, conns: Conn[], w: number, stepOpt?: number): AutorouteResult {
  const board = doc0.pcb.board!;
  const rules = rulesOf(doc0);
  const layers = copperLayers(doc0);
  const poly = boardPolygon(board);
  const W = board.widthMm, H = board.heightMm;
  const step = stepOpt ?? Math.max(0.3175, Math.sqrt((W * H) / 150_000));
  const base = new Grid(step, 0, 0, W, H, layers);
  const margin = step * 0.36 + 0.01;
  const keep = rules.clearanceMm + w / 2 + margin;
  const viaR = rules.viaDiameterMm / 2;
  const keepVia = rules.clearanceMm + viaR + margin;
  const nx = base.nx, ny = base.ny;
  const N = nx * ny, L = layers.length;

  const netIdx = new Map<string, number>();
  const idx = (key: string) => {
    let n = netIdx.get(key);
    if (!n) { n = netIdx.size + 1; netIdx.set(key, n); }
    return n;
  };
  // Неподвижные препятствия: край платы, площадки, уже проложенная медь
  const inside = polyMask(base, poly);
  const edgeKeep = rules.edgeMm + w / 2 + margin, edgeKeepVia = rules.edgeMm + viaR + margin;
  for (let li = 0; li < L; li++) {
    for (let k = 0; k < inside.length; k++) if (!inside[k]) { base.track[li]![k] = -1; base.via[li]![k] = -1; }
    for (let i = 0; i < poly.length; i++) {
      const s: Shape = { pts: [poly[i]!, poly[(i + 1) % poly.length]!], closed: false, r: 0 };
      base.claim(base.track[li]!, s, edgeKeep, -1);
      base.claim(base.via[li]!, s, edgeKeepVia, -1);
    }
  }
  const claimBase = (layer: Layer, s: Shape, net: number) => {
    const li = layers.indexOf(layer);
    if (li < 0) return;
    base.claim(base.track[li]!, s, keep, net);
    base.claim(base.via[li]!, s, keepVia, net);
  };
  for (const p of allPads(doc0)) for (const l of p.layers) claimBase(l, padShape(p), idx(p.netId ?? `pad:${padKey(p.ref)}`));
  for (const t of doc0.pcb.tracks) for (const s of trackShapes(t)) claimBase(t.layer as Layer, s, idx(t.netId));
  if (board.layers === 2) for (const v of doc0.pcb.vias) for (const l of layers) claimBase(l, viaShape(v), idx(v.netId));

  // Согласованная трассировка (PathFinder): занятость клеток трассами по цепям, история перегрузки
  // Занятость считается для осей трасс: ось чужой дорожки ближе (ширина + зазор) — наложение;
  // для перехода — ближе (радиус площадки + зазор + половина ширины).
  const sepT = w + rules.clearanceMm + margin, sepV = Math.max(viaR + rules.clearanceMm + w / 2, 2 * viaR + rules.clearanceMm) + margin;
  const rV = Math.ceil(Math.max(sepT, sepV) / step);
  const discT: Array<[number, number]> = [], discV: Array<[number, number]> = [];
  for (let dj = -rV; dj <= rV; dj++) for (let di = -rV; di <= rV; di++) {
    const d = Math.hypot(di, dj) * step;
    if (d < sepT) discT.push([di, dj]);
    if (d < sepV) discV.push([di, dj]);
  }
  const total = layers.map(() => new Uint16Array(N));
  const perNet = new Map<number, Uint16Array[]>();
  const own = (net: number) => { let a = perNet.get(net); if (!a) { a = layers.map(() => new Uint16Array(N)); perNet.set(net, a); } return a; };
  const hist = layers.map(() => new Float32Array(N));
  type Path = Array<{ li: number; k: number }>;
  const paths = new Map<number, Path>();
  /** Отметить (sign = +1) или снять (−1) занятость клеток вокруг трассы. */
  const mark = (ci: number, path: Path, sign: number) => {
    const net = idx(conns[ci]!.netId);
    const o = own(net);
    const stamp = (li: number, k: number, disc: Array<[number, number]>) => {
      const i = k % nx, j = (k - i) / nx;
      for (const [di, dj] of disc) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const kk = b * nx + a;
        const tl = total[li]!, ol = o[li]!;
        tl[kk] = tl[kk]! + sign; ol[kk] = ol[kk]! + sign;
      }
    };
    for (let n = 0; n < path.length; n++) {
      const q = path[n]!;
      stamp(q.li, q.k, discT);
      if (n > 0 && path[n - 1]!.li !== q.li) for (let li = 0; li < L; li++) stamp(li, q.k, discV);
    }
  };
  const ok = (o: number, net: number) => o === 0 || o === net;

  const search = (ci: number, pres: number): Path | null => {
    const c = conns[ci]!;
    const net = idx(c.netId);
    const o = own(net);
    const cellCost = (li: number, k: number): number => {
      if (!ok(base.track[li]![k]!, net)) return -1;
      const others = total[li]![k]! - o[li]![k]!;
      return hist[li]![k]! + (others > 0 ? pres * others : 0);
    };
    const viaCost = (k: number): number => {
      let extra = 0;
      for (let li = 0; li < L; li++) {
        if (!ok(base.via[li]![k]!, net)) return -1;
        const others = total[li]![k]! - o[li]![k]!;
        extra += hist[li]![k]! + (others > 0 ? pres * others : 0);
      }
      return extra;
    };
    const cellsIn = (p: PadInfo) => {
      const sh = padShape(p);
      const out: Path = [];
      const r = Math.max(p.w, p.h) / 2 + step;
      const i0 = Math.max(0, Math.floor((p.pos.x - r) / step)), i1 = Math.min(nx - 1, Math.ceil((p.pos.x + r) / step));
      const j0 = Math.max(0, Math.floor((p.pos.y - r) / step)), j1 = Math.min(ny - 1, Math.ceil((p.pos.y + r) / step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (distToShape(base.pt(k), sh) > -0.05) continue;
        for (const l of p.layers) { const li = layers.indexOf(l); if (li >= 0 && cellCost(li, k) >= 0) out.push({ li, k }); }
      }
      return out;
    };
    const starts = cellsIn(c.a), goals = cellsIn(c.b);
    if (!starts.length || !goals.length) return null;
    const goalSet = new Set(goals.map((x) => x.li * N + x.k));
    const tx = c.b.pos.x, ty = c.b.pos.y;
    const S = N * L * 9;
    const gs = new Float32Array(S).fill(Infinity);
    const from = new Int32Array(S).fill(-1);
    const heap = new Heap();
    const hfun = (k: number) => { const p = base.pt(k); const dx = Math.abs(p.x - tx) / step, dy = Math.abs(p.y - ty) / step; return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    for (const s0 of starts) { const st = (s0.li * N + s0.k) * 9 + 8; gs[st] = 0; heap.push(hfun(s0.k), st); }
    let found = -1;
    let budget = 1_500_000;
    while (heap.size && budget-- > 0) {
      const st = heap.pop();
      const dir = st % 9, lk = (st - dir) / 9, li = Math.floor(lk / N), k = lk - li * N;
      const cost = gs[st]!;
      if (goalSet.has(lk)) { found = st; break; }
      const i = k % nx, j = (k - i) / nx;
      for (let d = 0; d < 8; d++) {
        const [dx, dy] = DIRS[d]!;
        const ni = i + dx, nj = j + dy;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        const pc = cellCost(li, nk);
        if (pc < 0) continue;
        if (dx && dy && (cellCost(li, j * nx + ni) < 0 || cellCost(li, nj * nx + i) < 0)) continue;
        const turn = dir === 8 || dir === d ? 0 : 0.6;
        const nc = cost + (dx && dy ? 1.414 : 1) + turn + pc;
        const ns = (li * N + nk) * 9 + d;
        if (nc < gs[ns]!) { gs[ns] = nc; from[ns] = st; heap.push(nc + hfun(nk), ns); }
      }
      if (L === 2) {
        const vc = viaCost(k);
        const ol = 1 - li;
        if (vc >= 0 && cellCost(ol, k) >= 0) {
          const ns = (ol * N + k) * 9 + 8;
          const nc = cost + 12 + vc;
          if (nc < gs[ns]!) { gs[ns] = nc; from[ns] = st; heap.push(nc + hfun(k), ns); }
        }
      }
    }
    if (found < 0) return null;
    const path: Path = [];
    for (let st = found; st >= 0; st = from[st]!) { const lk = (st - (st % 9)) / 9; const li = Math.floor(lk / N); path.push({ li, k: lk - li * N }); }
    return path.reverse();
  };
  /** Цепи, с которыми трасса делит клетки. */
  const conflicted = (ci: number): boolean => {
    const path = paths.get(ci);
    if (!path) return false;
    const o = own(idx(conns[ci]!.netId));
    return path.some((q) => total[q.li]![q.k]! - o[q.li]![q.k]! > 0);
  };

  const unroutable = new Set<number>();
  let pres = 0.5;
  const ITER = 60;
  for (let it = 0; it < ITER; it++) {
    const todo = it === 0 ? conns.map((_, ci) => ci) : conns.map((_, ci) => ci).filter((ci) => !unroutable.has(ci) && (!paths.has(ci) || conflicted(ci)));
    if (it > 0 && todo.length === 0) break;
    for (const ci of todo) {
      const old = paths.get(ci);
      if (old) { mark(ci, old, -1); paths.delete(ci); }
      const p = search(ci, pres);
      if (!p) { unroutable.add(ci); continue; }
      paths.set(ci, p);
      mark(ci, p, +1);
    }
    // История: клетки, где трассы разных цепей наложились, дорожают
    let conflicts = 0;
    for (const [ci, path] of paths) {
      const o = own(idx(conns[ci]!.netId));
      for (const q of path) if (total[q.li]![q.k]! - o[q.li]![q.k]! > 0) { hist[q.li]![q.k] = hist[q.li]![q.k]! + 1; conflicts++; }
    }
    if (conflicts === 0 && it > 0) break;
    pres *= 1.3;
  }
  // Оставшиеся конфликты: снимаем трассы с наибольшим числом наложений, пока не станет чисто
  for (;;) {
    let worst = -1, worstN = 0;
    for (const [ci, path] of paths) {
      const o = own(idx(conns[ci]!.netId));
      const n = path.reduce((a, q) => a + (total[q.li]![q.k]! - o[q.li]![q.k]! > 0 ? 1 : 0), 0);
      if (n > worstN) { worstN = n; worst = ci; }
    }
    if (worst < 0) break;
    mark(worst, paths.get(worst)!, -1);
    paths.delete(worst);
    unroutable.add(worst);
  }

  // Трассы → дорожки и переходы
  const newTracks: Track[] = [];
  const newVias: Via[] = [];
  let length = 0;
  const simplify = (pts: Point[]) => pts.filter((p, n) => {
    if (n === 0 || n === pts.length - 1) return true;
    const a = pts[n - 1]!, b = pts[n + 1]!;
    return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-9;
  });
  const byConn = new Map<number, { tracks: Track[]; vias: Via[] }>();
  for (const [ci, path] of paths) {
    const c = conns[ci]!;
    const legs: Array<{ layer: Layer; pts: Point[] }> = [];
    let cur = { layer: layers[path[0]!.li]!, pts: [] as Point[] };
    for (const q of path) {
      if (layers[q.li] !== cur.layer) { legs.push(cur); cur = { layer: layers[q.li]!, pts: [] }; }
      cur.pts.push(base.pt(q.k));
    }
    legs.push(cur);
    const mine = { tracks: [] as Track[], vias: [] as Via[] };
    let startEnd: TrackEnd = { kind: 'pad', ...c.a.ref };
    let prevPt: Point = c.a.pos;
    for (let n = 0; n < legs.length; n++) {
      const leg = legs[n]!;
      let endEnd: TrackEnd, endPt: Point;
      if (n === legs.length - 1) { endEnd = { kind: 'pad', ...c.b.ref }; endPt = c.b.pos; }
      else {
        const vp = leg.pts[leg.pts.length - 1]!;
        const via: Via = { id: newId(), netId: c.netId, position: { x: Number(vp.x.toFixed(4)), y: Number(vp.y.toFixed(4)) }, drillMm: rules.viaDrillMm, diameterMm: rules.viaDiameterMm };
        mine.vias.push(via);
        endEnd = { kind: 'via', viaId: via.id }; endPt = via.position;
      }
      const pts = simplify([prevPt, ...leg.pts, endPt]).map((q) => ({ x: Number(q.x.toFixed(4)), y: Number(q.y.toFixed(4)) }));
      const dedup = pts.filter((q, m) => m === 0 || q.x !== pts[m - 1]!.x || q.y !== pts[m - 1]!.y);
      if (dedup.length < 2) dedup.push(endPt);
      mine.tracks.push({ id: newId(), netId: c.netId, layer: leg.layer, widthMm: w, from: startEnd, to: endEnd, points: dedup });
      for (let m = 1; m < dedup.length; m++) length += Math.hypot(dedup[m]!.x - dedup[m - 1]!.x, dedup[m]!.y - dedup[m - 1]!.y);
      startEnd = endEnd; prevPt = endPt;
    }
    byConn.set(ci, mine);
    newTracks.push(...mine.tracks); newVias.push(...mine.vias);
  }
  let doc: ProjectDoc = { ...doc0, pcb: { ...doc0.pcb, tracks: [...doc0.pcb.tracks, ...newTracks], vias: [...doc0.pcb.vias, ...newVias] } };
  const label = (c: Conn) => ({ netId: c.netId, net: netName(doc0, c.netId), from: `${c.a.refDes}.${c.a.ref.pad}`, to: `${c.b.refDes}.${c.b.ref.pad}` });
  const failed = [...unroutable].map((ci) => label(conns[ci]!));
  // Страховка: дорожка, давшая ошибку зазора или замыкания, убирается (соединение — в неудачные)
  const before = new Set(drc(doc0).filter((i) => i.severity === 'error').map((i) => i.message));
  const bad = new Set<number>();
  for (const i of drc(doc)) {
    if (i.severity !== 'error' || before.has(i.message)) continue;
    for (const [ci, m] of byConn) if (m.tracks.some((t) => i.ids.includes(t.id)) || m.vias.some((v) => i.ids.includes(v.id))) bad.add(ci);
  }
  if (bad.size) {
    const dropT = new Set([...bad].flatMap((ci) => byConn.get(ci)!.tracks.map((t) => t.id)));
    const dropV = new Set([...bad].flatMap((ci) => byConn.get(ci)!.vias.map((v) => v.id)));
    doc = { ...doc, pcb: { ...doc.pcb, tracks: doc.pcb.tracks.filter((t) => !dropT.has(t.id)), vias: doc.pcb.vias.filter((v) => !dropV.has(v.id)) } };
    for (const ci of bad) { failed.push(label(conns[ci]!)); byConn.delete(ci); }
  }
  for (const m of byConn.values()) for (const t of m.tracks) {
    if (t.from?.kind !== 'pad' || t.to?.kind !== 'pad') continue;
    const ck = checkTrack(doc, { from: t.from, to: t.to, layer: t.layer as Layer, widthMm: t.widthMm });
    if ('error' in ck) throw new Error(`Автотрассировка: недопустимая дорожка: ${ck.error}`);
  }
  return { doc, routed: byConn.size, total: conns.length, failed, vias: [...byConn.values()].reduce((a, m) => a + m.vias.length, 0), lengthMm: length };
}
