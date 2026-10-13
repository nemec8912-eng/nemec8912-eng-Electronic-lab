/**
 * Медная заливка (этап 6, доработка): вся площадь платы на слое, отданная одной цепи, с зазором до
 * меди других цепей и отступом от края. Геометрия вывода (SVG, Gerber) точная: заливка — контур платы,
 * из которого вырезаны отступ от края и увеличенная на зазор чужая медь, поверх — вся медь слоя.
 *
 * Связность заливки считается по растру с шагом 0,1 мм (на больших платах — крупнее): какие площадки,
 * переходы и дорожки своей цепи касаются каких связных участков заливки. Участок без своей меди —
 * «остров»: он удаляется из меди везде (Gerber, печать 1:1, станок, полотно) — полосами растра,
 * расширенными на клетку (рядом с островом — только зазор; своя и чужая медь рисуется поверх).
 * Площадки соединяются с заливкой сплошь, без термобарьеров.
 */
import { newId } from './ids';
import { logChange, touch } from './factory';
import type { Layer } from './pcb';
import { allPads, boardPolygon, copperLayers, endKey, padKey, padShape, rulesOf, trackShapes, viaShape, boardVias, type Shape } from './pcb';
import type { Point, Pour, ProjectDoc } from './model';

export const DEFAULT_POUR_CLEARANCE = 0.5;
const MAX_CELLS = 1_500_000;

export interface PourComponent {
  /** Ключи площадок и переходов своей цепи, соединённых через этот участок. */
  keys: Set<string>;
  cells: number;
  areaMm2: number;
  sample: Point;
}
export interface PourResult {
  pour: Pour; res: number; nx: number; ny: number; cells: Uint8Array; components: PourComponent[];
  /** Номер участка клетки (1…), 0 — не заливка. */
  labels: Int32Array;
}

/** Участок — остров (своей меди не касается). */
export const isIsland = (c: PourComponent) => c.keys.size === 0;

/** Точка (мм) лежит в острове заливки. */
export function inIsland(r: PourResult, x: number, y: number): boolean {
  const i = Math.floor(x / r.res), j = Math.floor(y / r.res);
  if (i < 0 || j < 0 || i >= r.nx || j >= r.ny) return false;
  const l = r.labels[j * r.nx + i]!;
  return l > 0 && isIsland(r.components[l - 1]!);
}

/** Острова заливки как прямоугольники (полосы строк растра), расширенные на клетку, — для вырезания. */
export function islandStrips(r: PourResult): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (!r.components.some(isIsland)) return out;
  const g = r.res;
  for (let j = 0; j < r.ny; j++) {
    let start = -1;
    for (let i = 0; i <= r.nx; i++) {
      const l = i < r.nx ? r.labels[j * r.nx + i]! : 0;
      const on = l > 0 && isIsland(r.components[l - 1]!);
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push({ x: start * g - g, y: j * g - g, w: (i - start) * g + 2 * g, h: 3 * g }); start = -1; }
    }
  }
  return out;
}

interface Stamp { shape: Shape; grow: number }

function distToShape(p: Point, s: Shape): number {
  if (s.closed) {
    let inside = false;
    const q = s.pts;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      const a = q[i]!, b = q[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    if (inside) return -s.r;
  }
  let d = Infinity;
  const n = s.pts.length;
  const segs = n === 1 ? [[s.pts[0]!, s.pts[0]!]] : Array.from({ length: s.closed ? n : n - 1 }, (_, i) => [s.pts[i]!, s.pts[(i + 1) % n]!]);
  for (const [a, b] of segs) {
    const dx = b!.x - a!.x, dy = b!.y - a!.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a!.x) * dx + (p.y - a!.y) * dy) / l2));
    d = Math.min(d, Math.hypot(p.x - (a!.x + t * dx), p.y - (a!.y + t * dy)));
  }
  return d - s.r;
}

const cache = new WeakMap<ProjectDoc, PourResult[]>();

/** Растр и связные участки всех заливок документа (с кэшем на документ). */
export function pourResults(doc: ProjectDoc): PourResult[] {
  const hit = cache.get(doc);
  if (hit) return hit;
  const out = doc.pcb.board ? doc.pcb.pours.filter((p) => copperLayers(doc).includes(p.layer)).map((p) => computePour(doc, p)) : [];
  cache.set(doc, out);
  return out;
}

function computePour(doc: ProjectDoc, pour: Pour): PourResult {
  const board = doc.pcb.board!;
  const rules = rulesOf(doc);
  const W = board.widthMm, H = board.heightMm;
  const res = Math.max(0.1, Math.sqrt((W * H) / MAX_CELLS));
  const nx = Math.ceil(W / res), ny = Math.ceil(H / res);
  const cells = new Uint8Array(nx * ny);
  const poly = boardPolygon(board);
  // Заполнение контура по строкам (центры ячеек).
  for (let j = 0; j < ny; j++) {
    const y = (j + 0.5) * res;
    const xs: number[] = [];
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const a = poly[i]!, b = poly[k]!;
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((u, v) => u - v);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil(xs[q]! / res - 0.5)), i1 = Math.min(nx - 1, Math.floor(xs[q + 1]! / res - 0.5));
      for (let i = i0; i <= i1; i++) cells[j * nx + i] = 1;
    }
  }
  const stamp = (s: Shape, grow: number, value: 0) => {
    const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y);
    const m = s.r + grow + res;
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - m) / res)), i1 = Math.min(nx - 1, Math.ceil((Math.max(...xs) + m) / res));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - m) / res)), j1 = Math.min(ny - 1, Math.ceil((Math.max(...ys) + m) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (cells[j * nx + i] && distToShape({ x: (i + 0.5) * res, y: (j + 0.5) * res }, s) < grow) cells[j * nx + i] = value;
    }
  };
  // Отступ от края
  for (let i = 0; i < poly.length; i++) stamp({ pts: [poly[i]!, poly[(i + 1) % poly.length]!], closed: false, r: 0 }, rules.edgeMm, 0);
  // Чужая медь слоя
  const own: Array<{ shape: Shape; key: string }> = [];
  const stamps: Stamp[] = [];
  for (const p of allPads(doc)) {
    if (!p.layers.includes(pour.layer)) continue;
    if (p.netId === pour.netId) own.push({ shape: padShape(p), key: padKey(p.ref) });
    else stamps.push({ shape: padShape(p), grow: pour.clearanceMm });
  }
  {
    for (const v of boardVias(doc)) {
      if (v.netId === pour.netId) own.push({ shape: viaShape(v), key: `via:${v.id}` });
      else stamps.push({ shape: viaShape(v), grow: pour.clearanceMm });
    }
  }
  for (const t of doc.pcb.tracks) {
    if (t.layer !== pour.layer) continue;
    const keys = [t.from, t.to].filter((e): e is NonNullable<typeof e> => !!e).map(endKey);
    for (const s of trackShapes(t)) {
      if (t.netId === pour.netId) for (const k of keys.length ? keys : [`track:${t.id}`]) own.push({ shape: s, key: k });
      else stamps.push({ shape: s, grow: pour.clearanceMm });
    }
  }
  for (const st of stamps) stamp(st.shape, st.grow, 0);

  // Связные участки (4-связность)
  const lab = new Int32Array(nx * ny);
  const comps: PourComponent[] = [];
  const stack: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    if (!cells[k] || lab[k]) continue;
    const id = comps.length + 1;
    let count = 0;
    lab[k] = id; stack.push(k);
    while (stack.length) {
      const c = stack.pop()!;
      count++;
      const i = c % nx, j = (c - i) / nx;
      if (i > 0 && cells[c - 1] && !lab[c - 1]) { lab[c - 1] = id; stack.push(c - 1); }
      if (i < nx - 1 && cells[c + 1] && !lab[c + 1]) { lab[c + 1] = id; stack.push(c + 1); }
      if (j > 0 && cells[c - nx] && !lab[c - nx]) { lab[c - nx] = id; stack.push(c - nx); }
      if (j < ny - 1 && cells[c + nx] && !lab[c + nx]) { lab[c + nx] = id; stack.push(c + nx); }
    }
    const i = k % nx, j = (k - i) / nx;
    comps.push({ keys: new Set(), cells: count, areaMm2: count * res * res, sample: { x: (i + 0.5) * res, y: (j + 0.5) * res } });
  }
  // Своя медь, касающаяся участков (на клетку шире — касание по краю).
  for (const o of own) {
    const s = o.shape;
    const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y);
    const m = s.r + res * 1.5;
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - m) / res)), i1 = Math.min(nx - 1, Math.ceil((Math.max(...xs) + m) / res));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - m) / res)), j1 = Math.min(ny - 1, Math.ceil((Math.max(...ys) + m) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const l = lab[j * nx + i]!;
      if (l && distToShape({ x: (i + 0.5) * res, y: (j + 0.5) * res }, s) <= res * 0.75) comps[l - 1]!.keys.add(o.key);
    }
  }
  return { pour, res, nx, ny, cells, components: comps, labels: lab };
}

// ---------- Правка ----------

export function addPour(doc: ProjectDoc, p: { netId: string; layer: Layer; clearanceMm: number }): { doc: ProjectDoc; error: string | null } {
  if (!doc.pcb.board) return { doc, error: 'Сначала создайте плату' };
  if (!copperLayers(doc).includes(p.layer)) return { doc, error: 'На односторонней плате медь только снизу' };
  if (!doc.schematic.nets.some((n) => n.id === p.netId)) return { doc, error: 'Цепь не найдена в схеме' };
  if (doc.pcb.pours.some((x) => x.layer === p.layer)) return { doc, error: `На слое «${p.layer === 'top' ? 'верх' : 'низ'}» уже есть заливка — удалите её или выберите другой слой` };
  const min = rulesOf(doc).clearanceMm;
  if (!(p.clearanceMm >= min)) return { doc, error: `Зазор заливки не меньше общего зазора платы (${String(min).replace('.', ',')} мм)` };
  const pour: Pour = { id: newId(), ...p };
  return { doc: logChange(touch({ ...doc, pcb: { ...doc.pcb, pours: [...doc.pcb.pours, pour] } }), 'pcb-pour', `Медная заливка: слой ${p.layer === 'top' ? 'верхний' : 'нижний'}, зазор ${p.clearanceMm} мм`), error: null };
}

export function deletePour(doc: ProjectDoc, id: string): ProjectDoc {
  const pours = doc.pcb.pours.filter((p) => p.id !== id);
  return pours.length === doc.pcb.pours.length ? doc : touch({ ...doc, pcb: { ...doc.pcb, pours } });
}
