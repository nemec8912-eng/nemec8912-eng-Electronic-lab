/**
 * Фрезерование печатной платы на станке с ЧПУ под GRBL (CNC 3018 и подобные).
 *
 * Что получается — набор файлов G-code, каждый под один инструмент (GRBL не меняет инструмент сам):
 *  - изоляция меди V-фрезой: фреза обходит медь каждой цепи по контуру на расстоянии своего радиуса,
 *    несколько проходов расширяют канавку;
 *  - сверловка — по файлу на каждый диаметр сверла;
 *  - обрезка по контуру платы концевой фрезой за несколько проходов с перемычками; крупные отверстия
 *    фрезеруются той же фрезой по кругу.
 *
 * Координаты: ноль X/Y — левый нижний угол заготовки, плата отступает от него на marginMm; ноль Z —
 * поверхность меди. Односторонняя плата фрезеруется медью вверх, то есть со стороны пайки: всё
 * зеркально по X. Двусторонняя: сторона A (верх, без зеркала) — изоляция верха и сверловка вместе с
 * реперными отверстиями; затем заготовка переворачивается вокруг вертикальной оси, сторона B —
 * изоляция низа и обрезка. Реперные отверстия стоят на оси переворота и после него совпадают.
 *
 * Траектории считаются по полю расстояний до меди (см. field.ts), шаг сетки 0,025 мм на обычных платах.
 * Медь, которую фреза не может разделить (зазор между разными цепями меньше ширины реза), — ошибка:
 * такие цепи на готовой плате окажутся замкнуты.
 */
import { APP_VERSION } from './appinfo';
import { contours, distanceTransform, loopArea, loopLength, newField, pointInPoly, polyMask, simplifyLoop, stampShape, type Field } from './field';
import type { CncSettings, Point, ProjectDoc } from './model';
import { DEFAULT_CNC } from './model';
import { allPads, boardPolygon, netName, padShape, trackShapes, viaShape, type Layer, type Shape } from './pcb';
import { logChange, touch } from './factory';

export interface CncIssue { severity: 'error' | 'warning'; message: string; at?: Point }

export interface CncPath {
  kind: 'iso' | 'drill' | 'cut' | 'hole' | 'align';
  layer: Layer | null;
  /** Точки в координатах платы (мм, без зеркала) — для предпросмотра поверх платы. */
  pts: Point[];
  closed: boolean;
  /** Для отверстий — диаметр. */
  d?: number;
}

export interface CncFile {
  name: string;
  /** Что делает файл, по-русски — для списка и readme. */
  title: string;
  side: 'A' | 'B';
  tool: string;
  gcode: string;
  cutMm: number;
  minutes: number;
}

export interface CncPlan {
  files: CncFile[];
  issues: CncIssue[];
  paths: CncPath[];
  stock: { w: number; h: number };
  /** Ширина реза изоляции на заданной глубине. */
  isoWidthMm: number;
  readme: string;
}

const RAPID_MM_MIN = 1000; // типичная скорость холостых перемещений CNC 3018 ($110/$111)

export const cncOf = (doc: ProjectDoc): CncSettings => doc.pcb.cnc ?? DEFAULT_CNC;

/** Ширина канавки: V-фреза — вершина плюс конус на глубине; концевая — диаметр. */
export function isoWidth(s: CncSettings): number {
  return s.iso.tool === 'vbit' ? s.iso.tipMm + 2 * s.iso.depthMm * Math.tan((s.iso.angleDeg * Math.PI) / 360) : s.iso.diameterMm;
}

const ru = (n: number, d = 2) => String(Number(n.toFixed(d))).replace('.', ',');

// ---------- Проверка настроек ----------

export function settingsProblems(s: CncSettings): string[] {
  const out: string[] = [];
  if (s.iso.tool === 'vbit' && !(s.iso.angleDeg > 0 && s.iso.angleDeg < 180)) out.push('Угол V-фрезы — от 1 до 179°');
  if (s.iso.depthMm > 0.5) out.push('Глубина изоляции больше 0,5 мм — медь на текстолите 0,018–0,07 мм, обычно хватает 0,05–0,1 мм');
  if (s.iso.overlapPct >= 90) out.push('Перекрытие проходов — меньше 90 %');
  if (s.cut.stepDownMm > s.thicknessMm + s.drill.throughMm) out.push('Шаг по глубине обрезки больше толщины платы');
  if (s.cut.tabs > 0 && s.cut.tabHeightMm >= s.thicknessMm) out.push('Высота перемычки должна быть меньше толщины платы');
  if (s.spindle > 100_000) out.push('Обороты шпинделя: на GRBL это значение S, у CNC 3018 обычно до 1000');
  return out;
}

// ---------- Медь слоя ----------

interface CopperItem { shape: Shape; net: string; label: string }

function copperOf(doc: ProjectDoc, layer: Layer): CopperItem[] {
  const out: CopperItem[] = [];
  for (const p of allPads(doc)) if (p.layers.includes(layer)) out.push({ shape: padShape(p), net: p.netId ?? `pad:${p.ref.placementId}#${p.ref.pad}`, label: `${p.refDes}.${p.ref.pad}` });
  if (doc.pcb.board?.layers === 2) for (const v of doc.pcb.vias) out.push({ shape: viaShape(v), net: v.netId, label: `переход (${netName(doc, v.netId)})` });
  for (const t of doc.pcb.tracks) if (t.layer === layer) for (const s of trackShapes(t)) out.push({ shape: s, net: t.netId, label: `дорожка ${netName(doc, t.netId)}` });
  return out;
}

function bboxOf(shapes: Shape[], extra: Point[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const p of s.pts) { x0 = Math.min(x0, p.x - s.r); y0 = Math.min(y0, p.y - s.r); x1 = Math.max(x1, p.x + s.r); y1 = Math.max(y1, p.y + s.r); }
  for (const p of extra) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}

const gridStep = (w: number, h: number) => Math.max(0.025, Math.sqrt((w * h) / 6e6));

/** Поле расстояний до меди слоя (вместе с заливкой). */
export function copperField(doc: ProjectDoc, layer: Layer, reach: number): Field {
  const board = doc.pcb.board!;
  const poly = boardPolygon(board);
  const items = copperOf(doc, layer);
  const bb = bboxOf(items.map((i) => i.shape), poly);
  const m = reach + 0.5;
  const step = gridStep(bb.x1 - bb.x0 + 2 * m, bb.y1 - bb.y0 + 2 * m);
  const f = newField(bb.x0 - m, bb.y0 - m, bb.x1 + m, bb.y1 + m, step);
  for (const it of items) stampShape(f, it.shape, reach + 2 * step);
  for (const pour of doc.pcb.pours) {
    if (pour.layer !== layer) continue;
    const others = newField(f.x0, f.y0, f.x0 + (f.nx - 1) * step, f.y0 + (f.ny - 1) * step, step);
    for (const it of items) if (it.net !== pour.netId) stampShape(others, it.shape, pour.clearanceMm + 2 * step);
    const edge = newField(f.x0, f.y0, f.x0 + (f.nx - 1) * step, f.y0 + (f.ny - 1) * step, step);
    const edgeMm = board.rules.edgeMm;
    for (let i = 0; i < poly.length; i++) stampShape(edge, { pts: [poly[i]!, poly[(i + 1) % poly.length]!], closed: false, r: 0 }, edgeMm + 2 * step);
    const inside = polyMask(f, poly);
    for (let k = 0; k < inside.length; k++) if (inside[k] && (others.d[k]! < pour.clearanceMm || edge.d[k]! < edgeMm)) inside[k] = 0;
    const dt = distanceTransform(f.nx, f.ny, inside, step);
    for (let k = 0; k < dt.length; k++) if (dt[k]! < f.d[k]!) f.d[k] = dt[k]!;
  }
  return f;
}

/** Пары разных цепей, между которыми фреза шириной w не пройдёт. */
export function isolationConflicts(doc: ProjectDoc, layer: Layer, w: number): CncIssue[] {
  const items = copperOf(doc, layer);
  const out: CncIssue[] = [];
  const seen = new Set<string>();
  const bb = items.map((it) => bboxOf([it.shape], []));
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const A = items[a]!, B = items[b]!;
      if (A.net === B.net) continue;
      const p = bb[a]!, q = bb[b]!;
      if (p.x1 + w < q.x0 || q.x1 + w < p.x0 || p.y1 + w < q.y0 || q.y1 + w < p.y0) continue;
      const g = gapOf(A.shape, B.shape);
      if (g >= w - 1e-3) continue;
      const key = [A.label, B.label].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const at = { x: (p.x0 + p.x1 + q.x0 + q.x1) / 4, y: (p.y0 + p.y1 + q.y0 + q.y1) / 4 };
      out.push({ severity: 'error', at, message: `${layer === 'top' ? 'Верх' : 'Низ'}: ${A.label} и ${B.label} — зазор ${ru(Math.max(0, g))} мм, а фреза режет ${ru(w)} мм. Медь не разделится, цепи замкнутся` });
    }
  }
  for (const pour of doc.pcb.pours) if (pour.layer === layer && pour.clearanceMm < w - 1e-3) {
    out.push({ severity: 'error', message: `Заливка ${netName(doc, pour.netId)}: зазор ${ru(pour.clearanceMm)} мм меньше ширины реза ${ru(w)} мм — увеличьте зазор заливки` });
  }
  return out;
}

function gapOf(a: Shape, b: Shape): number {
  // Расстояние между краями: перебор отрезков (фигуры маленькие)
  const segs = (s: Shape): Array<[Point, Point]> => {
    if (s.pts.length === 1) return [[s.pts[0]!, s.pts[0]!]];
    const o: Array<[Point, Point]> = [];
    for (let i = 0; i + 1 < s.pts.length; i++) o.push([s.pts[i]!, s.pts[i + 1]!]);
    if (s.closed) o.push([s.pts[s.pts.length - 1]!, s.pts[0]!]);
    return o;
  };
  if ((a.closed && b.pts.some((p) => pointInPoly(a.pts, p))) || (b.closed && a.pts.some((p) => pointInPoly(b.pts, p)))) return -a.r - b.r;
  let d = Infinity;
  for (const [p, q] of segs(a)) for (const [r, s] of segs(b)) d = Math.min(d, ssd(p, q, r, s));
  return d - a.r - b.r;
}
function ssd(a1: Point, a2: Point, b1: Point, b2: Point): number {
  const ccw = (p: Point, q: Point, r: Point) => (r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x);
  const d1 = ccw(b1, b2, a1), d2 = ccw(b1, b2, a2), d3 = ccw(a1, a2, b1), d4 = ccw(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const sd = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  return Math.min(sd(a1, b1, b2), sd(a2, b1, b2), sd(b1, a1, a2), sd(b2, a1, a2));
}

/** Траектории изоляции слоя: замкнутые контуры на расстояниях r, r + шаг, … от меди. */
export function isolationLoops(doc: ProjectDoc, layer: Layer, s: CncSettings): Point[][][] {
  const w = isoWidth(s);
  const r = w / 2;
  const stepover = w * (1 - Math.min(0.9, s.iso.overlapPct / 100));
  const levels = Array.from({ length: s.iso.passes }, (_, k) => r + k * stepover);
  const f = copperField(doc, layer, levels[levels.length - 1]! + w);
  const tol = Math.min(0.01, f.step / 2);
  return levels.map((lv) => contours(f, lv).map((l) => simplifyLoop(l, tol)).filter((l) => l.length >= 3 && Math.abs(loopArea(l)) > 1e-4));
}

/** Траектория обрезки: контур платы, отодвинутый наружу на радиус фрезы. */
export function cutoutLoop(doc: ProjectDoc, toolMm: number): Point[] {
  const board = doc.pcb.board!;
  const poly = boardPolygon(board);
  const r = toolMm / 2;
  const bb = bboxOf([], poly);
  const m = r + 1;
  const step = gridStep(bb.x1 - bb.x0 + 2 * m, bb.y1 - bb.y0 + 2 * m);
  const f = newField(bb.x0 - m, bb.y0 - m, bb.x1 + m, bb.y1 + m, step);
  for (let i = 0; i < poly.length; i++) stampShape(f, { pts: [poly[i]!, poly[(i + 1) % poly.length]!], closed: false, r: 0 }, r + 2 * step);
  // Внутри платы — «медь» (значение 0): контур уровня r идёт только снаружи
  const mask = polyMask(f, poly);
  for (let k = 0; k < mask.length; k++) if (mask[k]) f.d[k] = 0;
  const loops = contours(f, r).map((l) => simplifyLoop(l, Math.min(0.01, step / 2)));
  loops.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
  return loops[0] ?? [];
}

// ---------- G-code ----------

const num = (v: number) => {
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

class Gcode {
  lines: string[] = [];
  pos: Point = { x: 0, y: 0 };
  z = 0;
  cut = 0;
  travel = 0;
  minutes = 0;
  constructor(public s: CncSettings, title: string[]) {
    for (const t of title) this.lines.push(`(${t.replace(/[()]/g, '')})`);
    this.lines.push('G21 G90 G94 G17', `G0 Z${num(s.safeZMm + 3)}`, `M3 S${num(s.spindle)}`);
    if (s.spinUpS > 0) this.lines.push(`G4 P${num(s.spinUpS)}`);
    this.z = s.safeZMm + 3;
    this.minutes += s.spinUpS / 60;
  }
  up() { if (this.z < this.s.safeZMm) { this.lines.push(`G0 Z${num(this.s.safeZMm)}`); this.minutes += (this.s.safeZMm - this.z) / RAPID_MM_MIN / 2; this.z = this.s.safeZMm; } }
  rapid(p: Point) {
    this.up();
    const d = Math.hypot(p.x - this.pos.x, p.y - this.pos.y);
    if (d < 1e-4) return;
    this.lines.push(`G0 X${num(p.x)} Y${num(p.y)}`);
    this.travel += d; this.minutes += d / RAPID_MM_MIN;
    this.pos = p;
  }
  plunge(z: number, feed: number) {
    if (Math.abs(z - this.z) < 1e-4) return;
    if (z > this.z) { this.lines.push(`G0 Z${num(z)}`); this.z = z; return; }
    if (this.z > 0.5) { this.lines.push('G0 Z0.5'); this.z = 0.5; }
    this.lines.push(`G1 Z${num(z)} F${num(feed)}`);
    this.minutes += (this.z - z) / feed;
    this.z = z;
  }
  line(p: Point, feed: number, z?: number) {
    const d = Math.hypot(p.x - this.pos.x, p.y - this.pos.y);
    const dz = z === undefined ? 0 : Math.abs(z - this.z);
    if (d < 1e-4 && dz < 1e-4) return;
    this.lines.push(`G1 X${num(p.x)} Y${num(p.y)}${z !== undefined && dz >= 1e-4 ? ` Z${num(z)}` : ''} F${num(feed)}`);
    if (z !== undefined) this.z = z;
    this.cut += d; this.minutes += Math.hypot(d, dz) / feed;
    this.pos = p;
  }
  end(): string {
    this.lines.push(`G0 Z${num(this.s.safeZMm + 3)}`, 'M5', 'G0 X0 Y0', 'M30', '');
    this.minutes += Math.hypot(this.pos.x, this.pos.y) / RAPID_MM_MIN;
    return this.lines.join('\n');
  }
}

/** Ближайший сосед: порядок замкнутых контуров и точка входа в каждый. */
function orderLoops(loops: Point[][], start: Point): Point[][] {
  const left = loops.slice();
  const out: Point[][] = [];
  let cur = start;
  while (left.length) {
    let bi = 0, bk = 0, bd = Infinity;
    left.forEach((l, i) => l.forEach((p, k) => { const d = (p.x - cur.x) ** 2 + (p.y - cur.y) ** 2; if (d < bd) { bd = d; bi = i; bk = k; } }));
    const l = left.splice(bi, 1)[0]!;
    const rot = [...l.slice(bk), ...l.slice(0, bk)];
    out.push(rot);
    cur = rot[0]!;
  }
  return out;
}

function orderPoints<T extends { x: number; y: number }>(pts: T[], start: Point): T[] {
  const left = pts.slice();
  const out: T[] = [];
  let cur: Point = start;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((p, i) => { const d = (p.x - cur.x) ** 2 + (p.y - cur.y) ** 2; if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0]!;
    out.push(cur as T);
  }
  return out;
}

interface Hole { x: number; y: number; d: number; kind: 'drill' | 'align' }

function holesOf(doc: ProjectDoc): Hole[] {
  const out: Hole[] = [];
  for (const p of allPads(doc)) if (p.drill) out.push({ x: p.pos.x, y: p.pos.y, d: p.drill, kind: 'drill' });
  if (doc.pcb.board?.layers === 2) for (const v of doc.pcb.vias) out.push({ x: v.position.x, y: v.position.y, d: v.drillMm, kind: 'drill' });
  return out;
}

/** Полный план фрезерования платы. */
export function cncPlan(doc: ProjectDoc): CncPlan {
  const board = doc.pcb.board;
  const s = cncOf(doc);
  const issues: CncIssue[] = [];
  const paths: CncPath[] = [];
  const files: CncFile[] = [];
  if (!board) return { files, issues: [{ severity: 'error', message: 'Сначала создайте плату' }], paths, stock: { w: 0, h: 0 }, isoWidthMm: 0, readme: '' };
  for (const p of settingsProblems(s)) issues.push({ severity: 'error', message: p });
  const W = board.widthMm, H = board.heightMm, M = s.marginMm;
  const stock = { w: W + 2 * M, h: H + 2 * M };
  if (stock.w > s.areaXMm || stock.h > s.areaYMm) {
    const turned = stock.h <= s.areaXMm && stock.w <= s.areaYMm;
    issues.push({ severity: 'error', message: `Заготовка ${ru(stock.w, 1)} × ${ru(stock.h, 1)} мм не помещается в рабочее поле ${ru(s.areaXMm, 0)} × ${ru(s.areaYMm, 0)} мм${turned ? ' — поверните плату на 90° (ширина ↔ высота)' : ''}` });
  }
  const two = board.layers === 2;
  const w = isoWidth(s);
  const layers: Layer[] = two ? ['top', 'bottom'] : ['bottom'];
  for (const l of layers) issues.push(...isolationConflicts(doc, l, w));
  if (!two && doc.pcb.tracks.some((t) => t.layer === 'top')) issues.push({ severity: 'warning', message: 'На односторонней плате есть дорожки верхнего слоя — они не фрезеруются' });

  // Машинные координаты
  const mx = (p: Point, mirror: boolean): Point => ({ x: M + (mirror ? W - p.x : p.x), y: M + (H - p.y) });
  const sideOf = (l: Layer): { side: 'A' | 'B'; mirror: boolean } => (two ? (l === 'top' ? { side: 'A', mirror: false } : { side: 'B', mirror: true }) : { side: 'A', mirror: true });

  let n = 1;
  const pad2 = (k: number) => String(k);
  const isoTool = s.iso.tool === 'vbit' ? `V-bit ${num(s.iso.angleDeg)} deg tip ${num(s.iso.tipMm)} mm` : `end mill ${num(s.iso.diameterMm)} mm`;
  const isoToolRu = s.iso.tool === 'vbit' ? `V-фреза ${ru(s.iso.angleDeg, 0)}°, вершина ${ru(s.iso.tipMm)} мм` : `концевая фреза ${ru(s.iso.diameterMm)} мм`;
  const head = (what: string, side: 'A' | 'B', mirror: boolean, tool: string) => [
    `Electronic Lab ${APP_VERSION} - ${what}`,
    `Project: ${translit(doc.name)}`,
    `Side ${side}${two ? (side === 'A' ? ' - top side up' : ' - board flipped left-right, bottom side up') : ' - copper side up'}${mirror ? ', mirrored X' : ''}`,
    `Tool: ${tool}`,
    `Zero: X0 Y0 = lower-left corner of stock, Z0 = copper surface`,
    `Stock ${num(stock.w)} x ${num(stock.h)} mm, board ${num(W)} x ${num(H)} mm at ${num(M)} mm margin`,
  ];

  // 1. Изоляция
  const isoJobs: Array<{ layer: Layer; loops: Point[][] }> = [];
  for (const l of layers) {
    const passes = isolationLoops(doc, l, s);
    const all = passes.flat();
    for (const loop of all) paths.push({ kind: 'iso', layer: l, pts: loop, closed: true });
    isoJobs.push({ layer: l, loops: all });
  }
  const drillHoles = holesOf(doc);
  // Свёрла из набора: ближайшее не меньше отверстия (допуск −0,05 мм)
  if (s.drill.sizes.length) {
    const kit = [...s.drill.sizes].sort((a, b) => a - b);
    for (const h of drillHoles) {
      const pick = kit.find((k) => k >= h.d - 0.05);
      const canMill = s.drill.millAboveMm > 0 && h.d > s.drill.millAboveMm && h.d >= s.cut.toolMm + 0.1;
      if (pick !== undefined && !canMill) {
        if (pick - h.d > 0.25) issues.push({ severity: 'warning', message: `Отверстие ${ru(h.d)} мм сверлится сверлом ${ru(pick)} мм — заметно больше; добавьте подходящее сверло в набор` });
        h.d = pick;
      } else if (pick === undefined && !canMill) {
        issues.push({ severity: 'warning', message: `Для отверстия ${ru(h.d)} мм нет сверла в наборе (${kit.map((k) => ru(k)).join('; ')} мм) — сверлится как в проекте` });
      }
    }
  }
  const milled = drillHoles.filter((h) => s.drill.millAboveMm > 0 && h.d > s.drill.millAboveMm && h.d >= s.cut.toolMm + 0.1);
  const drilled = drillHoles.filter((h) => !milled.includes(h));
  const align: Hole[] = [];
  if (two && s.alignHoles) {
    const yOff = M / 2;
    if (M < s.alignDrillMm + 1) issues.push({ severity: 'warning', message: `Реперные отверстия: отступ платы ${ru(M)} мм мал для сверла ${ru(s.alignDrillMm)} мм — увеличьте отступ` });
    align.push({ x: W / 2, y: -yOff, d: s.alignDrillMm, kind: 'align' }, { x: W / 2, y: H + yOff, d: s.alignDrillMm, kind: 'align' });
  }

  const emitIso = (job: { layer: Layer; loops: Point[][] }) => {
    const { side, mirror } = sideOf(job.layer);
    const g = new Gcode(s, [...head(`isolation ${job.layer}`, side, mirror, isoTool), `Cut width ${num(w)} mm at depth ${num(s.iso.depthMm)} mm, ${s.iso.passes} pass(es)`]);
    const loops = orderLoops(job.loops.map((l) => l.map((p) => mx(p, mirror))), { x: 0, y: 0 });
    for (const l of loops) {
      g.rapid(l[0]!);
      g.plunge(-s.iso.depthMm, s.iso.plunge);
      for (const p of l.slice(1)) g.line(p, s.iso.feed);
      g.line(l[0]!, s.iso.feed);
    }
    const name = `${pad2(n++)}_isolation_${job.layer}.nc`;
    files.push({ name, title: `Изоляция ${job.layer === 'top' ? 'верхнего' : 'нижнего'} слоя`, side, tool: isoToolRu, gcode: g.end(), cutMm: g.cut, minutes: g.minutes });
  };
  const emitDrill = () => {
    const mirror = two ? false : true;
    const side: 'A' | 'B' = 'A';
    const all = [...drilled, ...align];
    const sizes = [...new Set(all.map((h) => Number(h.d.toFixed(2))))].sort((a, b) => a - b);
    const zEnd = -(s.thicknessMm + s.drill.throughMm);
    for (const d of sizes) {
      const hs = orderPoints(all.filter((h) => Number(h.d.toFixed(2)) === d).map((h) => ({ ...mx(h, mirror), src: h })), { x: 0, y: 0 });
      const g = new Gcode(s, head(`drill ${num(d)} mm`, side, mirror, `drill ${num(d)} mm`));
      for (const h of hs) {
        g.rapid(h);
        g.plunge(zEnd, s.drill.feed);
        g.up();
        paths.push({ kind: h.src.kind === 'align' ? 'align' : 'drill', layer: null, pts: [{ x: h.src.x, y: h.src.y }], closed: false, d });
      }
      const name = `${pad2(n++)}_drill_${num(d)}mm.nc`;
      files.push({ name, title: `Сверловка ${ru(d)} мм: ${hs.length} отв.${hs.some((h) => h.src.kind === 'align') ? ' (с реперными)' : ''}`, side, tool: `сверло ${ru(d)} мм`, gcode: g.end(), cutMm: 0, minutes: g.minutes });
    }
  };
  const emitCut = () => {
    const { side, mirror } = two ? { side: 'B' as const, mirror: true } : { side: 'A' as const, mirror: true };
    const tool = s.cut.toolMm;
    const g = new Gcode(s, [...head('board cutout', side, mirror, `end mill ${num(tool)} mm`), `${s.cut.tabs} tab(s) ${num(s.cut.tabWidthMm)} mm wide, ${num(s.cut.tabHeightMm)} mm high`]);
    const zEnd = -(s.thicknessMm + 0.1);
    const depths: number[] = [];
    for (let z = -s.cut.stepDownMm; z > zEnd + 1e-6; z -= s.cut.stepDownMm) depths.push(z);
    depths.push(zEnd);
    // Крупные отверстия — по кругу той же фрезой
    for (const h of orderPoints(milled.map((x) => ({ ...mx(x, mirror), src: x })), { x: 0, y: 0 })) {
      const rc = (h.src.d - tool) / 2;
      const circle = Array.from({ length: 48 }, (_, k) => ({ x: h.x + rc * Math.cos((k / 48) * 2 * Math.PI), y: h.y + rc * Math.sin((k / 48) * 2 * Math.PI) }));
      g.rapid(circle[0]!);
      for (const z of depths) { g.plunge(z, s.cut.plunge); for (const p of circle.slice(1)) g.line(p, s.cut.feed); g.line(circle[0]!, s.cut.feed); }
      g.up();
      paths.push({ kind: 'hole', layer: null, pts: [{ x: h.src.x, y: h.src.y }], closed: false, d: h.src.d });
    }
    const loop = cutoutLoop(doc, tool);
    if (loop.length < 3) { issues.push({ severity: 'error', message: 'Не удалось построить контур обрезки' }); return; }
    paths.push({ kind: 'cut', layer: null, pts: loop, closed: true });
    const ml = orderLoops([loop.map((p) => mx(p, mirror))], { x: 0, y: 0 })[0]!;
    const per = loopLength(ml);
    const tabTop = -(s.thicknessMm - s.cut.tabHeightMm);
    const half = s.cut.tabWidthMm / 2 + tool / 2;
    const tabs = s.cut.tabs > 0 && s.cut.tabWidthMm > 0 && s.cut.tabHeightMm > 0 ? Array.from({ length: s.cut.tabs }, (_, k) => ((k + 0.5) * per) / s.cut.tabs) : [];
    if (tabs.length && per / tabs.length < 2 * half + 1) issues.push({ severity: 'warning', message: 'Перемычек слишком много для такого контура' });
    const inTab = (dist: number) => tabs.some((c) => Math.abs(dist - c) <= half);
    g.rapid(ml[0]!);
    for (const z of depths) {
      const useTabs = tabs.length > 0 && z < tabTop;
      g.plunge(useTabs && inTab(0) ? tabTop : z, s.cut.plunge);
      let acc = 0;
      const pts = [...ml.slice(1), ml[0]!];
      let prev = ml[0]!;
      for (const p of pts) {
        const segLen = Math.hypot(p.x - prev.x, p.y - prev.y);
        if (!useTabs) { g.line(p, s.cut.feed, z); acc += segLen; prev = p; continue; }
        // Разбиваем отрезок на границах перемычек
        const cuts = [0, 1];
        for (const c of tabs) for (const b of [c - half, c + half]) { const t = (b - acc) / segLen; if (t > 0 && t < 1) cuts.push(t); }
        cuts.sort((a, b) => a - b);
        for (let i = 1; i < cuts.length; i++) {
          const t0 = cuts[i - 1]!, t1 = cuts[i]!;
          const mid = acc + ((t0 + t1) / 2) * segLen;
          const zz = inTab(mid) ? tabTop : z;
          const q = { x: prev.x + (p.x - prev.x) * t1, y: prev.y + (p.y - prev.y) * t1 };
          if (Math.abs(zz - g.z) > 1e-4) {
            // Подъём/спуск на перемычку в начале участка
            const st = { x: prev.x + (p.x - prev.x) * t0, y: prev.y + (p.y - prev.y) * t0 };
            g.line(st, zz < g.z ? s.cut.plunge : s.cut.feed, zz);
          }
          g.line(q, s.cut.feed);
        }
        acc += segLen;
        prev = p;
      }
    }
    const name = `${pad2(n++)}_cutout.nc`;
    files.push({ name, title: `Обрезка по контуру${milled.length ? ` и ${milled.length} крупн. отв.` : ''}`, side, tool: `концевая фреза ${ru(tool)} мм`, gcode: g.end(), cutMm: g.cut, minutes: g.minutes });
  };

  if (two) { emitIso(isoJobs[0]!); emitDrill(); emitIso(isoJobs[1]!); emitCut(); }
  else { emitIso(isoJobs[0]!); emitDrill(); emitCut(); }

  const plan: CncPlan = { files, issues, paths, stock, isoWidthMm: w, readme: '' };
  plan.readme = readme(doc, plan, s, isoToolRu);
  return plan;
}

function readme(doc: ProjectDoc, plan: CncPlan, s: CncSettings, isoTool: string): string {
  const b = doc.pcb.board!;
  const two = b.layers === 2;
  const total = plan.files.reduce((a, f) => a + f.minutes, 0);
  return [
    `Фрезерование платы «${doc.name}» на станке с ЧПУ (GRBL, CNC 3018)`,
    `Электронная лаборатория ${APP_VERSION}`,
    '',
    `Заготовка: не меньше ${ru(plan.stock.w, 1)} × ${ru(plan.stock.h, 1)} мм, толщина ${ru(s.thicknessMm)} мм. Плата ${ru(b.widthMm, 1)} × ${ru(b.heightMm, 1)} мм с отступом ${ru(s.marginMm)} мм.`,
    'Ноль станка: X0 Y0 — левый нижний угол заготовки, Z0 — поверхность меди (щупом или листом бумаги).',
    'Перед изоляцией снимите карту высот (в Candle — «Карта высот»): текстолит редко лежит ровно, а глубина реза — сотые доли мм.',
    two
      ? 'Двусторонняя плата: сторона A — верхом вверх; затем переверните заготовку слева направо (вокруг вертикальной оси), вставьте штифты в реперные отверстия, снова выставьте ноль в левом нижнем углу — сторона B.'
      : 'Односторонняя плата: медь вверх (вид со стороны пайки, поэтому всё зеркально — так и должно быть).',
    '',
    'Порядок:',
    ...plan.files.map((f) => `  ${f.name} — сторона ${f.side}: ${f.title}; инструмент: ${f.tool}; около ${Math.max(1, Math.round(f.minutes))} мин`),
    '',
    `Изоляция: ${isoTool}, глубина ${ru(s.iso.depthMm)} мм, ширина реза ${ru(plan.isoWidthMm)} мм, проходов ${s.iso.passes}, подача ${s.iso.feed} мм/мин.`,
    `Шпиндель: S${s.spindle}. Между файлами меняйте инструмент и заново выставляйте Z0.`,
    `Общее время — около ${Math.max(1, Math.round(total))} мин (по подачам; разгон станка не учтён).`,
    '',
    ...(plan.issues.length ? ['ВНИМАНИЕ:', ...plan.issues.map((i) => `  ${i.severity === 'error' ? 'ОШИБКА' : 'Предупреждение'}: ${i.message}`), ''] : []),
    'Файлы — обычный G-code (G0/G1, M3/M5, G4), без смены инструмента и без циклов сверления: GRBL их не поддерживает.',
  ].join('\r\n');
}

const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
/** Комментарии G-code — только ASCII: не все программы управления станком понимают кириллицу. */
export function translit(s: string): string {
  return [...s].map((c) => {
    const l = c.toLowerCase();
    const t = TR[l];
    if (t === undefined) return /[\x20-\x7e]/.test(c) ? c : '?';
    return c === l ? t : t.charAt(0).toUpperCase() + t.slice(1);
  }).join('').replace(/[()]/g, '');
}

// ---------- Правка настроек ----------

export function setCnc(doc: ProjectDoc, patch: Partial<Omit<CncSettings, 'iso' | 'drill' | 'cut'>> & { iso?: Partial<CncSettings['iso']>; drill?: Partial<CncSettings['drill']>; cut?: Partial<CncSettings['cut']> }): { doc: ProjectDoc; error: string | null } {
  const cur = cncOf(doc);
  const next: CncSettings = { ...cur, ...patch, iso: { ...cur.iso, ...(patch.iso ?? {}) }, drill: { ...cur.drill, ...(patch.drill ?? {}) }, cut: { ...cur.cut, ...(patch.cut ?? {}) } };
  const bad = Object.entries({ ...next, ...next.iso, ...next.drill, ...next.cut }).find(([, v]) => typeof v === 'number' && !(Number.isFinite(v) && v >= 0));
  if (bad) return { doc, error: 'Значения должны быть числами не меньше нуля' };
  const p = settingsProblems(next);
  if (p.length) return { doc, error: p[0]! };
  if (JSON.stringify(next) === JSON.stringify(cur)) return { doc, error: null };
  return { doc: logChange(touch({ ...doc, pcb: { ...doc.pcb, cnc: next } }), 'pcb-cnc', 'Настройки фрезерования изменены'), error: null };
}
