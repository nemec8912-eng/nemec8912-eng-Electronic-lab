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
 *
 * Узкие места: если что-то не развелось, недостающие соединения ведутся ещё раз поверх результата
 * дорожкой минимальной ширины из правил (например, между выводами DIP при зазоре 0,25 мм).
 *
 * Перемычки (односторонняя плата): если дорожкой не пройти, соединение может «перепрыгнуть» проволочной
 * перемычкой со стороны деталей — прямой по горизонтали или вертикали, длиной кратной 2,54 мм (до 25 мм).
 * Провод не должен касаться выводов других цепей и других перемычек, отверстия — не под корпусами.
 * Перемычка стоит дорого (её паять вручную), поэтому ставится, только когда без неё не обойтись или
 * обход очень длинный.
 */
import { distToShape, polyMask } from './field';
import { logChange, touch } from './factory';
import { newId } from './ids';
import type { Jumper, Point, ProjectDoc, Track, TrackEnd, Via } from './model';
import {
  allPads, bodyRect, boardPolygon, boardVias, checkTrack, copperGroups, copperLayers, drc, jumperEnds, jumperHole, jumperShape, JUMPER_GAP, JUMPER_MIN_MM, JUMPER_WIRE_R,
  netName, padKey, padShape, rulesOf, trackShapes, viaLayers, viaShape,
  type Layer, type PadInfo, type Shape,
} from './pcb';

export interface AutorouteOptions {
  /** Ширина новых дорожек (по умолчанию — из правил платы). */
  widthMm?: number;
  /** Шаг сетки, мм (по умолчанию 0,3175 — четверть шага 1,27; на больших платах крупнее). */
  stepMm?: number;
  /** Число попыток с разным порядком соединений. */
  passes?: number;
  /** Проволочные перемычки на односторонней плате (по умолчанию — да). */
  jumpers?: boolean;
  /** Узкие дорожки (минимальная ширина из правил) там, где обычной не пройти (по умолчанию — да). */
  narrow?: boolean;
  /** Ход работы (для индикатора): номер попытки и их число. */
  onProgress?(done: number, total: number): void;
}

/** Самая длинная перемычка автотрассировки, мм. */
export const JUMPER_MAX_MM = 25;
/** «Цена» перемычки в шагах сетки: столько стоит обход, чтобы обойтись без неё. */
const JUMPER_COST = 60;

export interface AutorouteResult {
  doc: ProjectDoc;
  routed: number;
  total: number;
  failed: Array<{ netId: string; net: string; from: string; to: string }>;
  vias: number;
  /** Поставлено перемычек. */
  jumpers: number;
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
  if (!board) return { doc: doc0, routed: 0, total: 0, failed: [], vias: 0, jumpers: 0, lengthMm: 0 };
  const rules = rulesOf(doc0);
  const w = opts.widthMm ?? rules.trackMm;
  // Заливка ненадёжна как соединение (новые дорожки меняют её форму): сначала разводим всё дорожками,
  // потом убираем дорожки цепи заливки, без которых соединение через заливку сохраняется.
  const conns0 = missingConnections(doc0, false);
  // Сколько соединений не хватает на самом деле (с учётом заливки) — это и показывается пользователю.
  const need = missingConnections(doc0, true).length;
  if (!conns0.length || !need) return { doc: doc0, routed: 0, total: 0, failed: [], vias: 0, jumpers: 0, lengthMm: 0 };
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
    return { ...r, doc: pruned.doc, failed, total: need, routed: Math.max(0, need - failed.length), lengthMm: r.lengthMm - pruned.lengthMm };
  };
  let best: AutorouteResult | null = null;
  // Сначала без перемычек; если что-то не развелось на односторонней плате — ещё раз, с перемычками.
  // Попытка без перемычек одна: перестановки порядка редко спасают, а каждая неудачная попытка долгая.
  const withJ = board.layers === 1 && opts.jumpers !== false;
  const plain = withJ ? 1 : passes;
  const runs = withJ ? plain + passes : passes;
  for (let pass = 0; pass < runs; pass++) {
    const jumpers = pass >= plain;
    if (jumpers && pass === plain) { order = sorted; seed = 12345; }
    opts.onProgress?.(pass, runs);
    const raw = routeOnce(doc0, order, w, opts.stepMm, jumpers);
    let r = finish(raw);
    // Узкие места: недостающее — ещё раз поверх, дорожкой минимальной ширины
    const minW = rules.minTrackMm;
    if (r.failed.length && opts.narrow !== false && minW < w - 1e-9) {
      const failedNets = new Set(r.failed.map((f) => f.netId));
      const rest = missingConnections(r.doc, false).filter((c) => failedNets.has(c.netId)).sort((a, b) => a.len - b.len);
      if (rest.length) {
        const raw2 = routeOnce(r.doc, rest, minW, opts.stepMm, jumpers);
        const r2 = finish({ ...raw2, vias: r.vias + raw2.vias, jumpers: r.jumpers + raw2.jumpers, lengthMm: r.lengthMm + raw2.lengthMm });
        if (r2.failed.length < r.failed.length) r = r2;
      }
    }
    if (!best || r.failed.length < best.failed.length || (r.failed.length === best.failed.length && r.jumpers < best.jumpers) || (r.failed.length === best.failed.length && r.jumpers === best.jumpers && r.lengthMm < best.lengthMm)) best = r;
    if (r.failed.length === 0) break;
    // Неразведённые — первыми; со второй половины попыток — ещё и случайный порядок остальных
    const failedKeys = new Set(raw.failed.map((f) => `${f.from}|${f.to}`));
    const rest = order.filter((c) => !failedKeys.has(label(c)));
    if ((jumpers ? pass - plain : pass) >= passes / 2) for (let k = rest.length - 1; k > 0; k--) { const m = Math.floor(rnd() * (k + 1)); [rest[k], rest[m]] = [rest[m]!, rest[k]!]; }
    order = [...order.filter((c) => failedKeys.has(label(c))), ...rest];
  }
  const res = best!;
  opts.onProgress?.(runs, runs);
  if (res.total - res.failed.length === 0 && res.doc.pcb.tracks.length === doc0.pcb.tracks.length) return { ...res, doc: doc0, routed: 0 };
  const msg = `Автотрассировка: разведено ${res.routed} из ${res.total}${res.vias ? `, переходов ${res.vias}` : ''}${res.jumpers ? `, перемычек ${res.jumpers}` : ''}${res.failed.length ? `; не удалось: ${res.failed.map((f) => `${f.from}–${f.to}`).join(', ')}` : ''}`;
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

function routeOnce(doc0: ProjectDoc, conns: Conn[], w: number, stepOpt?: number, allowJumpers = true): AutorouteResult {
  const board = doc0.pcb.board!;
  const rules = rulesOf(doc0);
  const cuLayers = copperLayers(doc0);
  // Слои поиска: медь платы и (на односторонней плате) «слой перемычек» — сторона деталей.
  const useJ = board.layers === 1 && allowJumpers;
  const layers: Layer[] = useJ ? ['bottom', 'top'] : cuLayers;
  const J = useJ ? 1 : -1;
  const isCu = layers.map((l) => cuLayers.includes(l));
  const poly = boardPolygon(board);
  const W = board.widthMm, H = board.heightMm;
  const step = stepOpt ?? Math.max(0.3175, Math.sqrt((W * H) / 150_000));
  const base = new Grid(step, 0, 0, W, H, layers);
  // Запас на дискретность сетки: ось трассы проходит через узлы, отрезки между ними чуть ближе к круглым
  // площадкам (стрелка ≈ шаг²/8R). Остаток ловит проверка DRC в конце.
  const margin = step * 0.12 + 0.02;
  const keep = rules.clearanceMm + w / 2 + margin;
  const jh = jumperHole(doc0);
  const viaR = (useJ ? jh.diameterMm : rules.viaDiameterMm) / 2;
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
      base.claim(base.track[li]!, s, isCu[li] ? edgeKeep : JUMPER_WIRE_R + margin, -1);
      base.claim(base.via[li]!, s, edgeKeepVia, -1);
    }
  }
  const claimBase = (layer: Layer, s: Shape, net: number) => {
    const li = layers.indexOf(layer);
    if (li < 0 || !isCu[li]) return;
    base.claim(base.track[li]!, s, keep, net);
    base.claim(base.via[li]!, s, keepVia, net);
  };
  const pads = allPads(doc0);
  for (const p of pads) for (const l of p.layers) claimBase(l, padShape(p), idx(p.netId ?? `pad:${padKey(p.ref)}`));
  for (const t of doc0.pcb.tracks) for (const s of trackShapes(t)) claimBase(t.layer as Layer, s, idx(t.netId));
  for (const v of boardVias(doc0)) for (const l of viaLayers(doc0)) claimBase(l, viaShape(v), idx(v.netId));
  if (useJ) {
    // Сторона деталей: провод не касается выводов чужих цепей и чужих перемычек; отверстие перемычки —
    // не ближе 0,25 мм к другим отверстиям и не под корпусом детали.
    const GAP = JUMPER_GAP;
    for (const p of pads) {
      if (!p.drill) continue;
      const hole: Shape = { pts: [p.pos], closed: false, r: p.drill / 2 };
      base.claim(base.track[J]!, hole, JUMPER_WIRE_R + GAP + margin, idx(p.netId ?? `pad:${padKey(p.ref)}`));
      base.claim(base.via[J]!, hole, jh.drillMm / 2 + 0.25 + margin, -1);
    }
    for (const v of boardVias(doc0)) base.claim(base.via[J]!, { pts: [v.position], closed: false, r: v.drillMm / 2 }, jh.drillMm / 2 + 0.25 + margin, -1);
    for (const j of doc0.pcb.jumpers) { const e = jumperEnds(doc0, j); if (e) base.claim(base.track[J]!, jumperShape(e), 2 * JUMPER_WIRE_R + GAP + margin, idx(j.netId)); }
    for (const pl of doc0.pcb.placements) {
      const b = pl.side === 'top' ? bodyRect(doc0, pl) : null;
      if (b) base.claim(base.via[J]!, { pts: [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }], closed: true, r: 0 }, jh.diameterMm / 2, -1);
    }
  }

  // Согласованная трассировка (PathFinder): занятость клеток трассами по цепям, история перегрузки
  // Занятость считается для осей трасс: ось чужой дорожки ближе (ширина + зазор) — наложение;
  // для перехода — ближе (радиус площадки + зазор + половина ширины).
  const sepT = w + rules.clearanceMm + margin, sepV = Math.max(viaR + rules.clearanceMm + w / 2, 2 * viaR + rules.clearanceMm) + margin;
  const sepJ = 2 * JUMPER_WIRE_R + JUMPER_GAP + margin;
  const rV = Math.ceil(Math.max(sepT, sepV) / step);
  const discT: Array<[number, number]> = [], discV: Array<[number, number]> = [], discJ: Array<[number, number]> = [];
  for (let dj = -rV; dj <= rV; dj++) for (let di = -rV; di <= rV; di++) {
    const d = Math.hypot(di, dj) * step;
    if (d < sepT) discT.push([di, dj]);
    if (d < sepV) discV.push([di, dj]);
    if (d < sepJ) discJ.push([di, dj]);
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
      stamp(q.li, q.k, q.li === J ? discJ : discT);
      if (n > 0 && path[n - 1]!.li !== q.li) for (let li = 0; li < L; li++) if (isCu[li] || li === J) stamp(li, q.k, li === J ? discJ : discV);
    }
  };
  const ok = (o: number, net: number) => o === 0 || o === net;

  const jMin = Math.ceil(JUMPER_MIN_MM / step - 1e-9), jMax = Math.floor(JUMPER_MAX_MM / step);
  const jStride = Math.max(1, Math.round(2.54 / step));
  const ORTHO = [0, 2, 4, 6];

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
        for (const l of p.layers) { const li = layers.indexOf(l); if (li >= 0 && isCu[li] && cellCost(li, k) >= 0) out.push({ li, k }); }
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
      if (L === 2 && !useJ) {
        const vc = viaCost(k);
        const ol = 1 - li;
        if (vc >= 0 && cellCost(ol, k) >= 0) {
          const ns = (ol * N + k) * 9 + 8;
          const nc = cost + 12 + vc;
          if (nc < gs[ns]!) { gs[ns] = nc; from[ns] = st; heap.push(nc + hfun(k), ns); }
        }
      }
      if (useJ) {
        // Перемычка: прыжок по прямой на n клеток (n кратно шагу 2,54 мм) — в клетку, где можно поставить отверстие.
        const vc0 = viaCost(k);
        if (vc0 < 0) continue;
        // Только что приземлились с перемычки — сразу вторую не ставим (отверстия совпали бы).
        const pst = from[st]!;
        if (pst >= 0) {
          const pk = ((pst - (pst % 9)) / 9) % N, pi = pk % nx, pj = (pk - pi) / nx;
          if (Math.max(Math.abs(pi - i), Math.abs(pj - j)) > 1) continue;
        }
        for (const d of ORTHO) {
          const [dx, dy] = DIRS[d]!;
          let acc = 0;
          for (let n = 1; n <= jMax; n++) {
            const ni = i + dx * n, nj = j + dy * n;
            if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) break;
            const nk = nj * nx + ni;
            const jc = cellCost(J, nk);
            if (jc < 0) break;
            acc += jc;
            if (n < jMin || n % jStride) continue;
            const pc = cellCost(li, nk);
            if (pc < 0) continue;
            const vc1 = viaCost(nk);
            if (vc1 < 0) continue;
            const ns = (li * N + nk) * 9 + 8;
            const nc = cost + JUMPER_COST + n * 0.5 + acc + vc0 + vc1 + pc;
            if (nc < gs[ns]!) { gs[ns] = nc; from[ns] = st; heap.push(nc + hfun(nk), ns); }
          }
        }
      }
    }
    if (found < 0) return null;
    const rev: Path = [];
    for (let st = found; st >= 0; st = from[st]!) { const lk = (st - (st % 9)) / 9; const li = Math.floor(lk / N); rev.push({ li, k: lk - li * N }); }
    rev.reverse();
    // Прыжок (соседние точки пути не рядом) — перемычка: вставить клетки провода на слое перемычек.
    const path: Path = [];
    for (let n = 0; n < rev.length; n++) {
      const q = rev[n]!;
      const prev = rev[n - 1];
      if (prev) {
        const pi = prev.k % nx, pj = (prev.k - pi) / nx, qi = q.k % nx, qj = (q.k - qi) / nx;
        const len = Math.max(Math.abs(qi - pi), Math.abs(qj - pj));
        if (len > 1) {
          const sx = Math.sign(qi - pi), sy = Math.sign(qj - pj);
          for (let m = 0; m <= len; m++) path.push({ li: J, k: (pj + sy * m) * nx + pi + sx * m });
        }
      }
      path.push(q);
    }
    return path;
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

  // Трассы → дорожки, переходы и перемычки
  const newTracks: Track[] = [];
  const newVias: Via[] = [];
  const newJumpers: Jumper[] = [];
  let length = 0;
  const simplify = (pts: Point[]) => pts.filter((p, n) => {
    if (n === 0 || n === pts.length - 1) return true;
    const a = pts[n - 1]!, b = pts[n + 1]!;
    return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-9;
  });
  const round = (q: Point): Point => ({ x: Number(q.x.toFixed(4)), y: Number(q.y.toFixed(4)) });
  const byConn = new Map<number, { tracks: Track[]; vias: Via[]; jumpers: Jumper[] }>();
  for (const [ci, path] of paths) {
    const c = conns[ci]!;
    const legs: Array<{ li: number; pts: Point[] }> = [];
    let cur = { li: path[0]!.li, pts: [] as Point[] };
    for (const q of path) {
      if (q.li !== cur.li) { legs.push(cur); cur = { li: q.li, pts: [] }; }
      cur.pts.push(base.pt(q.k));
    }
    legs.push(cur);
    const mine = { tracks: [] as Track[], vias: [] as Via[], jumpers: [] as Jumper[] };
    // Концы участков меди: площадка, переход или отверстие перемычки
    const ends: Array<{ end: TrackEnd; pt: Point }> = [{ end: { kind: 'pad', ...c.a.ref }, pt: c.a.pos }];
    const cuLegs: Array<{ layer: Layer; pts: Point[] }> = [];
    for (let n = 0; n < legs.length; n++) {
      const leg = legs[n]!;
      if (leg.li === J) {
        const a: Via = { id: newId(), netId: c.netId, position: round(leg.pts[0]!), ...jh };
        const b: Via = { id: newId(), netId: c.netId, position: round(leg.pts[leg.pts.length - 1]!), ...jh };
        mine.vias.push(a, b);
        mine.jumpers.push({ id: newId(), netId: c.netId, aViaId: a.id, bViaId: b.id });
        ends.push({ end: { kind: 'via', viaId: a.id }, pt: a.position });
        ends.push({ end: { kind: 'via', viaId: b.id }, pt: b.position });
        continue;
      }
      cuLegs.push({ layer: layers[leg.li]!, pts: leg.pts });
      if (n < legs.length - 1 && legs[n + 1]!.li !== J) {
        const vp = round(leg.pts[leg.pts.length - 1]!);
        const via: Via = { id: newId(), netId: c.netId, position: vp, drillMm: rules.viaDrillMm, diameterMm: rules.viaDiameterMm };
        mine.vias.push(via);
        ends.push({ end: { kind: 'via', viaId: via.id }, pt: via.position });
      }
    }
    ends.push({ end: { kind: 'pad', ...c.b.ref }, pt: c.b.pos });
    // ends: [начало, (конец участка, начало следующего)…, конец]; для перехода конец и начало — одна точка
    const pairs: Array<[{ end: TrackEnd; pt: Point }, { end: TrackEnd; pt: Point }]> = [];
    {
      let n = 0;
      const seq: Array<{ end: TrackEnd; pt: Point }> = [];
      for (const e of ends) seq.push(e);
      // Переход общий для двух участков — дублируем его в последовательности.
      const flat: Array<{ end: TrackEnd; pt: Point }> = [seq[0]!];
      for (let m = 1; m < seq.length - 1; m++) {
        const e = seq[m]!;
        const isJumperEnd = e.end.kind === 'via' && mine.jumpers.some((j) => j.aViaId === (e.end as { viaId: string }).viaId || j.bViaId === (e.end as { viaId: string }).viaId);
        flat.push(e);
        if (!isJumperEnd) flat.push(e);
      }
      flat.push(seq[seq.length - 1]!);
      for (; n + 1 < flat.length; n += 2) pairs.push([flat[n]!, flat[n + 1]!]);
    }
    for (const [n, leg] of cuLegs.entries()) {
      const [s0, e0] = pairs[n]!;
      const pts = simplify([s0.pt, ...leg.pts, e0.pt]).map(round);
      const dedup = pts.filter((q, m) => m === 0 || q.x !== pts[m - 1]!.x || q.y !== pts[m - 1]!.y);
      if (dedup.length < 2) dedup.push(e0.pt);
      mine.tracks.push({ id: newId(), netId: c.netId, layer: leg.layer, widthMm: w, from: s0.end, to: e0.end, points: dedup });
      for (let m = 1; m < dedup.length; m++) length += Math.hypot(dedup[m]!.x - dedup[m - 1]!.x, dedup[m]!.y - dedup[m - 1]!.y);
    }
    byConn.set(ci, mine);
    newTracks.push(...mine.tracks); newVias.push(...mine.vias); newJumpers.push(...mine.jumpers);
  }
  let doc: ProjectDoc = { ...doc0, pcb: { ...doc0.pcb, tracks: [...doc0.pcb.tracks, ...newTracks], vias: [...doc0.pcb.vias, ...newVias], jumpers: [...doc0.pcb.jumpers, ...newJumpers] } };
  const label = (c: Conn) => ({ netId: c.netId, net: netName(doc0, c.netId), from: `${c.a.refDes}.${c.a.ref.pad}`, to: `${c.b.refDes}.${c.b.ref.pad}` });
  const failed = [...unroutable].map((ci) => label(conns[ci]!));
  // Страховка: трасса, давшая ошибку DRC (зазор, замыкание, отверстия), убирается (соединение — в неудачные)
  const before = new Set(drc(doc0).filter((i) => i.severity === 'error').map((i) => i.message));
  const bad = new Set<number>();
  for (const i of drc(doc)) {
    if (i.severity !== 'error' || before.has(i.message)) continue;
    for (const [ci, m] of byConn) if (m.tracks.some((t) => i.ids.includes(t.id)) || m.vias.some((v) => i.ids.includes(v.id)) || m.jumpers.some((j) => i.ids.includes(j.id))) bad.add(ci);
  }
  if (bad.size) {
    const dropT = new Set([...bad].flatMap((ci) => byConn.get(ci)!.tracks.map((t) => t.id)));
    const dropV = new Set([...bad].flatMap((ci) => byConn.get(ci)!.vias.map((v) => v.id)));
    const dropJ = new Set([...bad].flatMap((ci) => byConn.get(ci)!.jumpers.map((j) => j.id)));
    doc = { ...doc, pcb: { ...doc.pcb, tracks: doc.pcb.tracks.filter((t) => !dropT.has(t.id)), vias: doc.pcb.vias.filter((v) => !dropV.has(v.id)), jumpers: doc.pcb.jumpers.filter((j) => !dropJ.has(j.id)) } };
    for (const ci of bad) { failed.push(label(conns[ci]!)); byConn.delete(ci); }
  }
  for (const m of byConn.values()) for (const t of m.tracks) {
    if (!t.from || !t.to) continue;
    const ck = checkTrack(doc, { from: t.from, to: t.to, layer: t.layer as Layer, widthMm: t.widthMm });
    if ('error' in ck) throw new Error(`Автотрассировка: недопустимая дорожка: ${ck.error}`);
  }
  const vals = [...byConn.values()];
  return {
    doc, routed: byConn.size, total: conns.length, failed,
    vias: vals.reduce((a, m) => a + m.vias.length - 2 * m.jumpers.length, 0),
    jumpers: vals.reduce((a, m) => a + m.jumpers.length, 0),
    lengthMm: length,
  };
}
