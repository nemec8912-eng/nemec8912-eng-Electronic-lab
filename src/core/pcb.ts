/**
 * Печатная плата (этап 6; начало — прототип 1b). Координаты в мм, начало — левый верхний угол платы,
 * вид со стороны деталей (сверху). Односторонняя плата: медь снизу, выводные детали сверху.
 * Двухсторонняя: медь сверху и снизу, переходные отверстия.
 *
 * Цепь площадки: площадка → вывод символа (явный pinMap корпуса детали) → сеть схемы. Дорожка
 * соединяет площадки и переходные отверстия одной цепи на одном слое. Изменения схемы переносятся на
 * плату только явной синхронизацией с отчётом; разводка молча не удаляется.
 */
import { touch } from './factory';
import { newId } from './ids';
import {
  DEFAULT_RULES, type Board, type DesignRules, type PackageDef, type PadRef, type PartDef, type Placement, type Point,
  type ProjectDoc, type Track, type TrackEnd, type Via,
} from './model';
import { netDisplayName } from './connectivity';
import { netOfPin } from './schematic';

export { DEFAULT_RULES } from './model';
export type Layer = 'top' | 'bottom';

export const PCB_GRID = 1.27; // мм (0,05")
export const snapMm = (v: number) => Number((Math.round(v / PCB_GRID) * PCB_GRID).toFixed(4));
export const DEFAULT_BOARD = { widthMm: 60, heightMm: 40 };
export const DEFAULT_TRACK_MM = DEFAULT_RULES.trackMm;
export const MM_PER_INCH = 25.4;

export function newBoard(): Board {
  return { id: newId(), ...DEFAULT_BOARD, layers: 1, units: 'mm', rules: { ...DEFAULT_RULES } };
}
export const rulesOf = (doc: ProjectDoc): DesignRules => doc.pcb.board?.rules ?? DEFAULT_RULES;
/** Слои меди платы: односторонняя — только нижний. */
export const copperLayers = (doc: ProjectDoc): Layer[] => (doc.pcb.board?.layers === 2 ? ['top', 'bottom'] : ['bottom']);
export const LAYER_NAME: Record<Layer, string> = { top: 'верхний слой (сторона деталей)', bottom: 'нижний слой (сторона пайки)' };

/** Длина в единицах платы: «2,54 мм» или «0,100″». */
export function fmtLen(mm: number, units: 'mm' | 'inch' = 'mm', digits = 2): string {
  if (units === 'inch') return `${(mm / MM_PER_INCH).toFixed(3).replace('.', ',')}″`;
  return `${Number(mm.toFixed(digits)).toString().replace('.', ',')} мм`;
}
/** Разбор длины: «1,6», «1.6 мм», «0,1″», «0.1in», «40 mil». Без единиц — в единицах платы. */
export function parseLen(text: string, units: 'mm' | 'inch' = 'mm'): number | null {
  const m = text.trim().replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*(мм|mm|″|"|in|дюйм|mil|мил)?$/i);
  if (!m) return null;
  const v = Number(m[1]);
  const u = (m[2] ?? '').toLowerCase();
  if (u === 'мм' || u === 'mm') return v;
  if (u === 'mil' || u === 'мил') return v * MM_PER_INCH / 1000;
  if (u) return v * MM_PER_INCH;
  return units === 'inch' ? v * MM_PER_INCH : v;
}

// ---------- Справочные функции ----------

export function placementContext(doc: ProjectDoc, pl: Placement): { part?: PartDef; pkg?: PackageDef; pinMap: Array<{ symbolPin: string; pad: string }> } {
  const inst = doc.schematic.instances.find((i) => i.id === pl.instanceId);
  const part = inst ? doc.library.parts.find((p) => p.id === inst.partId) : undefined;
  const pkg = doc.library.packages.find((p) => p.id === pl.packageId);
  const pinMap = part?.packages.find((p) => p.packageId === pl.packageId)?.pinMap ?? [];
  return { part, pkg, pinMap };
}

function rot(p: Point, rotation: number): Point {
  switch (rotation) {
    case 90: return { x: -p.y, y: p.x };
    case 180: return { x: -p.x, y: -p.y };
    case 270: return { x: p.y, y: -p.x };
    default: return p;
  }
}
/** Локальная точка корпуса → плата. Деталь снизу видна сверху зеркально (по оси X корпуса). */
export function toBoard(pl: Placement, p: Point): Point {
  const q = rot(pl.side === 'bottom' ? { x: -p.x, y: p.y } : p, pl.rotation);
  return { x: pl.position.x + q.x, y: pl.position.y + q.y };
}

export interface PadInfo {
  ref: PadRef;
  pos: Point;
  shape: 'round' | 'rect' | 'oval';
  w: number;
  h: number;
  drill: number | null;
  netId: string | null;
  refDes: string;
  /** Слои, на которых есть медь площадки: выводная — оба, SMD — сторона детали. */
  layers: Layer[];
}

export function padsOf(doc: ProjectDoc, pl: Placement): PadInfo[] {
  const { pkg, pinMap } = placementContext(doc, pl);
  const inst = doc.schematic.instances.find((i) => i.id === pl.instanceId);
  if (!pkg) return [];
  const swap = pl.rotation === 90 || pl.rotation === 270;
  return pkg.pads.map((pad) => {
    const symbolPin = pinMap.find((m) => m.pad === pad.number)?.symbolPin;
    const net = inst && symbolPin ? netOfPin(doc, { instanceId: inst.id, pin: symbolPin }) : undefined;
    return {
      ref: { placementId: pl.id, pad: pad.number },
      pos: toBoard(pl, { x: pad.x, y: pad.y }),
      shape: pad.shape, w: swap ? pad.h : pad.w, h: swap ? pad.w : pad.h, drill: pad.drill,
      netId: net?.id ?? null,
      refDes: inst?.refDes ?? '?',
      layers: pad.drill ? ['top', 'bottom'] : [pl.side],
    };
  });
}

export function allPads(doc: ProjectDoc): PadInfo[] {
  return doc.pcb.placements.flatMap((pl) => padsOf(doc, pl));
}

export function findPad(doc: ProjectDoc, ref: PadRef): PadInfo | undefined {
  const pl = doc.pcb.placements.find((p) => p.id === ref.placementId);
  return pl ? padsOf(doc, pl).find((p) => p.ref.pad === ref.pad) : undefined;
}

export const padKey = (r: PadRef) => `${r.placementId}#${r.pad}`;
export const endKey = (e: TrackEnd) => (e.kind === 'pad' ? padKey(e) : `via:${e.viaId}`);
const sameEnd = (a: TrackEnd | null, b: TrackEnd | null) => !!a && !!b && endKey(a) === endKey(b);

/** Где конец дорожки, какой цепи, на каких слоях. */
export function endInfo(doc: ProjectDoc, e: TrackEnd): { pos: Point; netId: string | null; layers: Layer[]; label: string } | null {
  if (e.kind === 'via') {
    const v = doc.pcb.vias.find((x) => x.id === e.viaId);
    return v ? { pos: v.position, netId: v.netId, layers: ['top', 'bottom'], label: 'переходное отверстие' } : null;
  }
  const p = findPad(doc, e);
  return p ? { pos: p.pos, netId: p.netId, layers: p.layers, label: `${p.refDes}.${p.ref.pad}` } : null;
}

/** Контур корпуса на плате (для шелкографии, проверки края и перекрытий). */
export function bodyRect(doc: ProjectDoc, pl: Placement): { x: number; y: number; w: number; h: number } | null {
  const { pkg } = placementContext(doc, pl);
  if (!pkg?.body) return null;
  const b = pkg.body;
  const corners = [toBoard(pl, { x: b.x, y: b.y }), toBoard(pl, { x: b.x + b.w, y: b.y + b.h })];
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1]! - xs[0]!), h: Math.abs(ys[1]! - ys[0]!) };
}

/** Габарит детали: корпус и площадки. */
export function footprintBox(doc: ProjectDoc, pl: Placement): { x: number; y: number; w: number; h: number } {
  const pads = padsOf(doc, pl);
  const b = bodyRect(doc, pl);
  let x0 = b ? b.x : Infinity, y0 = b ? b.y : Infinity, x1 = b ? b.x + b.w : -Infinity, y1 = b ? b.y + b.h : -Infinity;
  for (const p of pads) {
    x0 = Math.min(x0, p.pos.x - p.w / 2); y0 = Math.min(y0, p.pos.y - p.h / 2);
    x1 = Math.max(x1, p.pos.x + p.w / 2); y1 = Math.max(y1, p.pos.y + p.h / 2);
  }
  if (!Number.isFinite(x0)) return { x: pl.position.x, y: pl.position.y, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function netName(doc: ProjectDoc, netId: string | null): string {
  if (!netId) return 'без цепи';
  const n = doc.schematic.nets.find((x) => x.id === netId);
  return n ? netDisplayName(doc, n) : 'цепь удалена из схемы';
}

// ---------- Геометрия меди ----------

/** Фигура: точка, отрезок (с радиусом — «капсула») или выпуклый многоугольник. */
export interface Shape { pts: Point[]; closed: boolean; r: number }

export function padShape(p: PadInfo): Shape {
  if (p.shape === 'rect') {
    const hw = p.w / 2, hh = p.h / 2, { x, y } = p.pos;
    return { pts: [{ x: x - hw, y: y - hh }, { x: x + hw, y: y - hh }, { x: x + hw, y: y + hh }, { x: x - hw, y: y + hh }], closed: true, r: 0 };
  }
  if (p.shape === 'oval' && p.w !== p.h) {
    const r = Math.min(p.w, p.h) / 2;
    const d = (Math.max(p.w, p.h) - Math.min(p.w, p.h)) / 2;
    const { x, y } = p.pos;
    return p.w > p.h ? { pts: [{ x: x - d, y }, { x: x + d, y }], closed: false, r } : { pts: [{ x, y: y - d }, { x, y: y + d }], closed: false, r };
  }
  return { pts: [p.pos], closed: false, r: Math.max(p.w, p.h) / 2 };
}
export const viaShape = (v: Via): Shape => ({ pts: [v.position], closed: false, r: v.diameterMm / 2 });
export const trackShapes = (t: Track): Shape[] =>
  t.points.slice(1).map((b, i) => ({ pts: [t.points[i]!, b], closed: false, r: t.widthMm / 2 }));
export const holeShape = (at: Point, drill: number): Shape => ({ pts: [at], closed: false, r: drill / 2 });

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function segSegDist(a1: Point, a2: Point, b1: Point, b2: Point): number {
  const ccw = (p: Point, q: Point, r: Point) => (r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x);
  const d1 = ccw(b1, b2, a1), d2 = ccw(b1, b2, a2), d3 = ccw(a1, a2, b1), d4 = ccw(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist(a1, b1, b2), segDist(a2, b1, b2), segDist(b1, a1, a2), segDist(b2, a1, a2));
}

function inside(poly: Point[], p: Point): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
const segsOf = (s: Shape): Array<[Point, Point]> => {
  if (s.pts.length === 1) return [[s.pts[0]!, s.pts[0]!]];
  const out: Array<[Point, Point]> = [];
  for (let i = 0; i + 1 < s.pts.length; i++) out.push([s.pts[i]!, s.pts[i + 1]!]);
  if (s.closed) out.push([s.pts[s.pts.length - 1]!, s.pts[0]!]);
  return out;
};

/** Расстояние между краями фигур (отрицательное — перекрываются). */
export function shapeGap(a: Shape, b: Shape): number {
  let core = Infinity;
  if ((a.closed && b.pts.some((p) => inside(a.pts, p))) || (b.closed && a.pts.some((p) => inside(b.pts, p)))) core = 0;
  else for (const [p, q] of segsOf(a)) for (const [r, s] of segsOf(b)) core = Math.min(core, segSegDist(p, q, r, s));
  return core - a.r - b.r;
}

/** Отступ фигуры от края прямоугольной платы (отрицательный — выходит за край). */
export function edgeGap(s: Shape, board: { widthMm: number; heightMm: number }): number {
  let g = Infinity;
  for (const p of s.pts) g = Math.min(g, p.x - s.r, p.y - s.r, board.widthMm - p.x - s.r, board.heightMm - p.y - s.r);
  return g;
}

// ---------- Плата и синхронизация ----------

/**
 * Изменение параметров платы. Переход на одностороннюю плату не выполняется, пока есть дорожки верхнего
 * слоя или переходные отверстия (иначе разводка пропала бы молча).
 */
export function setBoard(doc: ProjectDoc, patch: Partial<Omit<Board, 'id' | 'rules'>> & { rules?: Partial<DesignRules> }): { doc: ProjectDoc; error: string | null } {
  const cur = doc.pcb.board ?? newBoard();
  const next: Board = { ...cur, ...patch, rules: { ...cur.rules, ...(patch.rules ?? {}) } };
  if (!(next.widthMm >= 5 && next.widthMm <= 1000 && next.heightMm >= 5 && next.heightMm <= 1000)) return { doc, error: 'Размеры платы — от 5 до 1000 мм' };
  const r = next.rules;
  if (r.viaDrillMm >= r.viaDiameterMm) return { doc, error: 'Диаметр площадки переходного отверстия должен быть больше сверла' };
  if (r.trackMm < r.minTrackMm) return { doc, error: 'Ширина новой дорожки меньше минимальной' };
  if (next.layers === 1 && cur.layers === 2) {
    const top = doc.pcb.tracks.filter((t) => t.layer === 'top').length, vias = doc.pcb.vias.length;
    if (top || vias) return { doc, error: `Нельзя сделать плату односторонней: на верхнем слое ${top} дорожек, переходных отверстий ${vias}. Удалите их или перенесите разводку.` };
  }
  if (doc.pcb.board && JSON.stringify(next) === JSON.stringify(doc.pcb.board)) return { doc, error: null };
  return { doc: touch({ ...doc, pcb: { ...doc.pcb, board: next } }), error: null };
}

export interface SyncReport {
  added: string[];
  removed: string[];
  /** Изменения, применённые к существующим деталям («R1: корпус 0207 → 0204»). */
  changed: string[];
  removedTracks: number;
  removedVias: number;
  kept: number;
  notPlaced: Array<{ refDes: string; reason: string }>;
  /** Что требует внимания после синхронизации: дорожки между разными цепями, несопоставленные выводы. */
  problems: string[];
  /** Есть ли что применять. */
  hasChanges: boolean;
}

const rectsOverlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * Перенос деталей и цепей из схемы на плату. Возвращает новый документ и отчёт; интерфейс сначала
 * показывает отчёт и применяет его только по подтверждению. Разводка удаляется только у деталей,
 * удалённых из схемы, и у площадок, которых нет в новом корпусе, — это перечисляется в отчёте.
 */
export function syncFromSchematic(doc: ProjectDoc): { doc: ProjectDoc; report: SyncReport } {
  const report: SyncReport = { added: [], removed: [], changed: [], removedTracks: 0, removedVias: 0, kept: 0, notPlaced: [], problems: [], hasChanges: false };
  const boardCreated = !doc.pcb.board;
  let d: ProjectDoc = boardCreated ? { ...doc, pcb: { ...doc.pcb, board: newBoard() } } : doc;
  const board = d.pcb.board!;
  const instById = new Map(d.schematic.instances.map((i) => [i.id, i]));

  // 1. Детали, удалённые из схемы.
  const gone = d.pcb.placements.filter((pl) => !instById.has(pl.instanceId));
  const goneIds = new Set(gone.map((g) => g.id));
  for (const g of gone) {
    const pkg = d.library.packages.find((x) => x.id === g.packageId);
    report.removed.push(`деталь, удалённая из схемы (корпус «${pkg?.name ?? '?'}»)`);
  }
  let placements = d.pcb.placements.filter((pl) => !goneIds.has(pl.id));

  // 2. Сменился корпус детали (в проекте у детали больше нет корпуса размещения) — первый корпус детали.
  const lostPads = new Set<string>();
  placements = placements.map((pl) => {
    const inst = instById.get(pl.instanceId)!;
    const part = d.library.parts.find((p) => p.id === inst.partId);
    if (!part || part.packages.some((p) => p.packageId === pl.packageId)) return pl;
    const oldPkg = d.library.packages.find((x) => x.id === pl.packageId);
    const nextRef = part.packages[0];
    const newPkg = nextRef ? d.library.packages.find((x) => x.id === nextRef.packageId) : undefined;
    if (!newPkg) {
      goneIds.add(pl.id);
      report.removed.push(`${inst.refDes}: у детали больше нет корпуса`);
      return null;
    }
    for (const pad of oldPkg?.pads ?? []) if (!newPkg.pads.some((q) => q.number === pad.number)) lostPads.add(`${pl.id}#${pad.number}`);
    report.changed.push(`${inst.refDes}: корпус «${oldPkg?.name ?? '?'}» → «${newPkg.name}» (место и поворот сохранены)`);
    return { ...pl, packageId: newPkg.id };
  }).filter((x): x is Placement => x !== null);
  report.kept = placements.length - report.changed.length;

  // 3. Дорожки к удалённым деталям и к исчезнувшим площадкам.
  const endGone = (e: TrackEnd | null) => !!e && e.kind === 'pad' && (goneIds.has(e.placementId) || lostPads.has(padKey(e)));
  const tracks = d.pcb.tracks.filter((t) => {
    const hit = endGone(t.from) || endGone(t.to);
    if (hit) report.removedTracks++;
    return !hit;
  });

  // 4. Новые детали — на свободное место платы (если не помещаются — под платой, с отметкой).
  d = { ...d, pcb: { ...d.pcb, placements, tracks } };
  const placedIds = new Set(placements.map((p) => p.instanceId));
  const occupied = placements.map((pl) => footprintBox(d, pl));
  for (const inst of d.schematic.instances) {
    if (placedIds.has(inst.id)) continue;
    const part = d.library.parts.find((p) => p.id === inst.partId);
    if (!part || part.packages.length === 0) {
      if (part?.category !== 'reference') report.notPlaced.push({ refDes: inst.refDes, reason: 'у детали нет корпуса' });
      continue;
    }
    const pkgRef = part.packages[0]!;
    const pkg = d.library.packages.find((p) => p.id === pkgRef.packageId);
    if (!pkg || pkg.pads.length === 0) { report.notPlaced.push({ refDes: inst.refDes, reason: 'у корпуса не заданы площадки' }); continue; }
    const side: Layer = pkg.mount === 'SMD' && board.layers === 1 ? 'bottom' : 'top';
    const probe: Placement = { id: newId(), instanceId: inst.id, packageId: pkg.id, position: { x: 0, y: 0 }, rotation: 0, side };
    const box0 = footprintBox(d, probe);
    const spot = freeSpot(board, occupied, box0);
    const pl = { ...probe, position: { x: snapMm(spot.x - box0.x), y: snapMm(spot.y - box0.y) } };
    const box = footprintBox(d, pl);
    occupied.push(box);
    placements = [...placements, pl];
    d = { ...d, pcb: { ...d.pcb, placements } };
    report.added.push(inst.refDes);
    if (!spot.inside) report.notPlaced.push({ refDes: inst.refDes, reason: 'не поместилась на плате — поставлена под платой, перенесите её или увеличьте плату' });
    if (side === 'bottom') report.changed.push(`${inst.refDes}: SMD-корпус на односторонней плате — поставлен со стороны меди (снизу)`);
  }

  // 5. Проверка соответствия выводов и площадок; дорожки и переходы, которые теперь соединяют разные цепи.
  for (const pl of d.pcb.placements) {
    const inst = instById.get(pl.instanceId);
    const { part, pkg, pinMap } = placementContext(d, pl);
    if (!inst || !part || !pkg) continue;
    const symbol = d.library.symbols.find((s) => s.id === part.symbolId);
    for (const pin of symbol?.pins ?? []) {
      const connected = netOfPin(d, { instanceId: inst.id, pin: pin.number });
      if (!connected) continue;
      const m = pinMap.find((x) => x.symbolPin === pin.number);
      if (!m) report.problems.push(`${inst.refDes}: вывод ${pin.name || pin.number} подключён на схеме, но не сопоставлен площадке корпуса «${pkg.name}» — цепь не попадёт на плату`);
      else if (!pkg.pads.some((p) => p.number === m.pad)) report.problems.push(`${inst.refDes}: вывод ${pin.name || pin.number} сопоставлен площадке «${m.pad}», которой нет в корпусе «${pkg.name}»`);
    }
  }
  for (const t of d.pcb.tracks) {
    const m = trackProblem(d, t);
    if (m) report.problems.push(m);
  }
  const netIds = new Set(d.schematic.nets.map((n) => n.id));
  for (const v of d.pcb.vias) {
    const used = d.pcb.tracks.filter((t) => (t.from?.kind === 'via' && t.from.viaId === v.id) || (t.to?.kind === 'via' && t.to.viaId === v.id));
    if (!netIds.has(v.netId)) report.problems.push(`Переходное отверстие (${fmtLen(v.position.x)}; ${fmtLen(v.position.y)}): его цепи больше нет в схеме`);
    else if (used.length === 0) report.problems.push(`Переходное отверстие (${fmtLen(v.position.x)}; ${fmtLen(v.position.y)}) ни с чем не соединено`);
  }
  report.hasChanges = boardCreated || report.added.length > 0 || report.removed.length > 0 || report.changed.length > 0 || report.removedTracks > 0;
  return { doc: report.hasChanges ? touch(d) : doc, report };
}

function freeSpot(board: Board, occupied: Array<{ x: number; y: number; w: number; h: number }>, box: { w: number; h: number }): { x: number; y: number; inside: boolean } {
  const m = Math.max(board.rules.edgeMm, 1) + 1, gap = 2;
  for (let y = m; y + box.h <= board.heightMm - m; y += PCB_GRID) {
    for (let x = m; x + box.w <= board.widthMm - m; x += PCB_GRID) {
      const r = { x, y, w: box.w, h: box.h };
      if (!occupied.some((o) => rectsOverlap(o, r, gap))) return { x, y, inside: true };
    }
  }
  // Под платой — рядом друг с другом.
  let x = 0;
  const y = board.heightMm + 6;
  for (const o of occupied) if (o.y >= board.heightMm) x = Math.max(x, o.x + o.w + gap);
  return { x, y, inside: false };
}

/** Почему дорожка неверна (null — в порядке). */
export function trackProblem(doc: ProjectDoc, t: Track): string | null {
  const a = t.from ? endInfo(doc, t.from) : null, b = t.to ? endInfo(doc, t.to) : null;
  if (!a || !b) return 'Дорожка: конец не на площадке (деталь удалена из схемы — выполните синхронизацию)';
  const where = `${a.label} — ${b.label}`;
  if (!a.netId || !b.netId || a.netId !== b.netId || a.netId !== t.netId) return `Дорожка ${where} соединяет разные цепи (схема изменилась после разводки)`;
  if (!a.layers.includes(t.layer) || !b.layers.includes(t.layer)) return `Дорожка ${where} на слое «${t.layer === 'top' ? 'верх' : 'низ'}», а площадка SMD — на другой стороне`;
  if (!copperLayers(doc).includes(t.layer)) return `Дорожка ${where} на верхнем слое, а плата односторонняя`;
  return null;
}

// ---------- Редактирование ----------

/** Концы дорожек детали следуют за её площадками; изгибы сохраняются. */
function followPads(doc: ProjectDoc, placementId: string): ProjectDoc {
  const tracks = doc.pcb.tracks.map((t) => {
    const touchesA = t.from?.kind === 'pad' && t.from.placementId === placementId;
    const touchesB = t.to?.kind === 'pad' && t.to.placementId === placementId;
    if (!touchesA && !touchesB) return t;
    const pts = [...t.points];
    if (touchesA) { const a = endInfo(doc, t.from!); if (a) pts[0] = a.pos; }
    if (touchesB) { const b = endInfo(doc, t.to!); if (b) pts[pts.length - 1] = b.pos; }
    return { ...t, points: pts };
  });
  return { ...doc, pcb: { ...doc.pcb, tracks } };
}

export function movePlacement(doc: ProjectDoc, id: string, pos: Point): ProjectDoc {
  const p = { x: snapMm(pos.x), y: snapMm(pos.y) };
  const pl = doc.pcb.placements.find((x) => x.id === id);
  if (!pl || (pl.position.x === p.x && pl.position.y === p.y)) return doc;
  const placements = doc.pcb.placements.map((x) => (x.id === id ? { ...x, position: p } : x));
  return touch(followPads({ ...doc, pcb: { ...doc.pcb, placements } }, id));
}

export function rotatePlacement(doc: ProjectDoc, id: string): ProjectDoc {
  const pl = doc.pcb.placements.find((x) => x.id === id);
  if (!pl) return doc;
  const rotation = ((pl.rotation + 90) % 360) as Placement['rotation'];
  const placements = doc.pcb.placements.map((x) => (x.id === id ? { ...x, rotation } : x));
  return touch(followPads({ ...doc, pcb: { ...doc.pcb, placements } }, id));
}

/** Перенос детали на другую сторону платы (вид сверху — зеркально). Дорожки к SMD-площадкам проверяет DRC. */
export function flipPlacement(doc: ProjectDoc, id: string): ProjectDoc {
  const pl = doc.pcb.placements.find((x) => x.id === id);
  if (!pl) return doc;
  const side: Layer = pl.side === 'top' ? 'bottom' : 'top';
  const placements = doc.pcb.placements.map((x) => (x.id === id ? { ...x, side } : x));
  return touch(followPads({ ...doc, pcb: { ...doc.pcb, placements } }, id));
}

export interface NewTrack { from: TrackEnd; to: TrackEnd; layer: Layer; widthMm: number; /** Изгибы между концами. */ bends?: Point[] }

/** Проверка будущей дорожки: цепи концов совпадают, слой есть на плате и у обеих площадок. */
export function checkTrack(doc: ProjectDoc, t: NewTrack): { netId: string; a: Point; b: Point } | { error: string } {
  if (sameEnd(t.from, t.to)) return { error: 'Начало и конец дорожки совпадают' };
  const a = endInfo(doc, t.from), b = endInfo(doc, t.to);
  if (!a || !b) return { error: 'Площадка не найдена' };
  if (!a.netId || !b.netId) return { error: `Площадка ${!a.netId ? a.label : b.label} не подключена ни к одной цепи схемы` };
  if (a.netId !== b.netId) return { error: `${a.label} и ${b.label} — разные цепи схемы (${netName(doc, a.netId)} и ${netName(doc, b.netId)}). Дорожка закоротила бы их.` };
  if (!copperLayers(doc).includes(t.layer)) return { error: 'На односторонней плате медь только снизу' };
  for (const e of [a, b]) if (!e.layers.includes(t.layer)) return { error: `${e.label}: площадка SMD на другой стороне платы — дорожку нужно вести по слою «${e.layers[0] === 'top' ? 'верх' : 'низ'}»` };
  if (!(t.widthMm > 0)) return { error: 'Ширина дорожки должна быть больше нуля' };
  return { netId: a.netId, a: a.pos, b: b.pos };
}

export function addTrack(doc: ProjectDoc, t: NewTrack): { doc: ProjectDoc; id: string | null; error: string | null } {
  const c = checkTrack(doc, t);
  if ('error' in c) return { doc, id: null, error: c.error };
  const dup = doc.pcb.tracks.some((x) => x.layer === t.layer && (t.bends ?? []).length === 0 && x.points.length === 2 &&
    ((sameEnd(x.from, t.from) && sameEnd(x.to, t.to)) || (sameEnd(x.from, t.to) && sameEnd(x.to, t.from))));
  if (dup) return { doc, id: null, error: 'Эти площадки уже соединены такой дорожкой' };
  const pts = [c.a, ...(t.bends ?? []), c.b].filter((p, i, arr) => i === 0 || p.x !== arr[i - 1]!.x || p.y !== arr[i - 1]!.y);
  if (pts.length < 2) pts.push(c.b);
  const track: Track = { id: newId(), netId: c.netId, layer: t.layer, widthMm: t.widthMm, from: t.from, to: t.to, points: pts };
  return { doc: touch({ ...doc, pcb: { ...doc.pcb, tracks: [...doc.pcb.tracks, track] } }), id: track.id, error: null };
}

/** Переходное отверстие цепи в точке (только на двухсторонней плате). */
export function addVia(doc: ProjectDoc, pos: Point, netId: string): { doc: ProjectDoc; id: string | null; error: string | null } {
  if (doc.pcb.board?.layers !== 2) return { doc, id: null, error: 'Переходные отверстия — только на двухсторонней плате' };
  if (!doc.schematic.nets.some((n) => n.id === netId)) return { doc, id: null, error: 'Цепь не найдена в схеме' };
  const r = rulesOf(doc);
  const via: Via = { id: newId(), netId, position: { x: snapMm(pos.x), y: snapMm(pos.y) }, drillMm: r.viaDrillMm, diameterMm: r.viaDiameterMm };
  return { doc: touch({ ...doc, pcb: { ...doc.pcb, vias: [...doc.pcb.vias, via] } }), id: via.id, error: null };
}

/**
 * Дорожка с переходами: ломаная от начала до конца, точки перехода меняют слой. Всё — одна правка.
 * segments[i] — слой i-го участка; vias — точки переходов между участками.
 */
export function addRoute(doc: ProjectDoc, r: { from: TrackEnd; to: TrackEnd; widthMm: number; legs: Array<{ layer: Layer; bends: Point[] }>; vias: Point[] }): { doc: ProjectDoc; error: string | null } {
  if (r.legs.length !== r.vias.length + 1) return { doc, error: 'Неверная трасса' };
  const a = endInfo(doc, r.from);
  if (!a?.netId) return { doc, error: 'Начало дорожки не подключено к цепи' };
  let d = doc;
  let start = r.from;
  for (let i = 0; i < r.legs.length; i++) {
    let end: TrackEnd = r.to;
    if (i < r.vias.length) {
      const v = addVia(d, r.vias[i]!, a.netId);
      if (v.error) return { doc, error: v.error };
      d = v.doc; end = { kind: 'via', viaId: v.id! };
    }
    const t = addTrack(d, { from: start, to: end, layer: r.legs[i]!.layer, widthMm: r.widthMm, bends: r.legs[i]!.bends });
    if (t.error) return { doc, error: t.error };
    d = t.doc; start = end;
  }
  return { doc: d, error: null };
}

export function deleteTrack(doc: ProjectDoc, id: string): ProjectDoc {
  const tracks = doc.pcb.tracks.filter((t) => t.id !== id);
  return tracks.length === doc.pcb.tracks.length ? doc : touch({ ...doc, pcb: { ...doc.pcb, tracks } });
}

/** Удаление перехода вместе с дорожками, которые к нему подходят (их число возвращается). */
export function deleteVia(doc: ProjectDoc, id: string): { doc: ProjectDoc; tracks: number } {
  if (!doc.pcb.vias.some((v) => v.id === id)) return { doc, tracks: 0 };
  const at = (e: TrackEnd | null) => e?.kind === 'via' && e.viaId === id;
  const tracks = doc.pcb.tracks.filter((t) => !at(t.from) && !at(t.to));
  return { doc: touch({ ...doc, pcb: { ...doc.pcb, vias: doc.pcb.vias.filter((v) => v.id !== id), tracks } }), tracks: doc.pcb.tracks.length - tracks.length };
}

export function setTrackWidth(doc: ProjectDoc, id: string, widthMm: number): ProjectDoc {
  const t = doc.pcb.tracks.find((x) => x.id === id);
  if (!t || !(widthMm > 0) || t.widthMm === widthMm) return doc;
  return touch({ ...doc, pcb: { ...doc.pcb, tracks: doc.pcb.tracks.map((x) => (x.id === id ? { ...x, widthMm } : x)) } });
}

// ---------- Связность и неразведённые соединения ----------

/** Группы соединённой меди: ключ площадки или перехода → представитель группы. Учитываются только верные дорожки. */
export function copperGroups(doc: ProjectDoc): (key: string) => string {
  const parent = new Map<string, string>();
  const find = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const r = find(p); parent.set(k, r); return r; };
  for (const t of doc.pcb.tracks) {
    if (!t.from || !t.to || trackProblem(doc, t)) continue;
    const a = find(endKey(t.from)), b = find(endKey(t.to));
    if (a !== b) parent.set(a, b);
  }
  return find;
}

export interface RatLine { netId: string; a: Point; b: Point }

export function ratsnest(doc: ProjectDoc): RatLine[] {
  const find = copperGroups(doc);
  type Node = { key: string; pos: Point; pad: boolean };
  const byNet = new Map<string, Node[]>();
  for (const p of allPads(doc)) if (p.netId) byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), { key: padKey(p.ref), pos: p.pos, pad: true }]);
  for (const v of doc.pcb.vias) if (byNet.has(v.netId)) byNet.get(v.netId)!.push({ key: `via:${v.id}`, pos: v.position, pad: false });
  const lines: RatLine[] = [];
  for (const [netId, list] of byNet) {
    const groups = new Map<string, Node[]>();
    for (const n of list) { const r = find(n.key); groups.set(r, [...(groups.get(r) ?? []), n]); }
    // Нужны только группы, в которых есть площадки; одиночные переходы не требуют соединения.
    const gs = [...groups.values()].filter((g) => g.some((n) => n.pad));
    if (gs.length < 2) continue;
    const connected = [gs.shift()!];
    while (gs.length) {
      let best = { gi: 0, a: connected[0]![0]!, b: gs[0]![0]!, d: Infinity };
      for (const cg of connected) for (const [gi, g] of gs.entries()) for (const a of cg) for (const b of g) {
        const dd = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        if (dd < best.d) best = { gi, a, b, d: dd };
      }
      lines.push({ netId, a: best.a.pos, b: best.b.pos });
      connected.push(gs.splice(best.gi, 1)[0]!);
    }
  }
  return lines;
}

/** Цепи, не разведённые полностью: имя и число недостающих соединений. */
export function unroutedNets(doc: ProjectDoc): Array<{ netId: string; name: string; missing: number }> {
  const count = new Map<string, number>();
  for (const r of ratsnest(doc)) count.set(r.netId, (count.get(r.netId) ?? 0) + 1);
  return [...count.entries()].map(([netId, missing]) => ({ netId, name: netName(doc, netId), missing }));
}

// ---------- DRC ----------

export interface DrcIssue {
  severity: 'error' | 'warning';
  /** Вид замечания (для тестов и фильтров). */
  code: 'board' | 'edge' | 'clearance' | 'short' | 'track-width' | 'drill' | 'annular' | 'net' | 'layer' | 'orphan' | 'overlap' | 'unrouted' | 'hole';
  message: string;
  at: Point | null;
  /** Объекты, к которым относится замечание (id размещений, дорожек, переходов). */
  ids: string[];
}

interface CuItem { kind: 'pad' | 'track' | 'via'; id: string; label: string; netId: string | null; layers: Layer[]; shape: Shape; at: Point }

export function drc(doc: ProjectDoc): DrcIssue[] {
  const out: DrcIssue[] = [];
  const board = doc.pcb.board;
  if (!board) return [{ severity: 'error', code: 'board', message: 'Плата не создана: выполните синхронизацию со схемой', at: null, ids: [] }];
  const r = board.rules;
  const L = copperLayers(doc);
  const u = board.units;
  const len = (mm: number) => fmtLen(mm, u);
  const pads = allPads(doc);
  const items: CuItem[] = [];
  for (const p of pads) {
    const layers = p.layers.filter((l) => L.includes(l));
    if (layers.length === 0) {
      out.push({ severity: 'error', code: 'layer', message: `${p.refDes}.${p.ref.pad}: SMD-площадка на стороне без меди (односторонняя плата — медь только снизу). Переверните деталь.`, at: p.pos, ids: [p.ref.placementId] });
      continue;
    }
    items.push({ kind: 'pad', id: p.ref.placementId, label: `площадка ${p.refDes}.${p.ref.pad}`, netId: p.netId, layers, shape: padShape(p), at: p.pos });
  }
  for (const v of doc.pcb.vias) {
    if (board.layers === 1) out.push({ severity: 'error', code: 'layer', message: 'Переходное отверстие на односторонней плате', at: v.position, ids: [v.id] });
    items.push({ kind: 'via', id: v.id, label: 'переходное отверстие', netId: v.netId, layers: ['top', 'bottom'], shape: viaShape(v), at: v.position });
  }
  for (const t of doc.pcb.tracks) {
    const pr = trackProblem(doc, t);
    if (pr) out.push({ severity: 'error', code: pr.includes('слое') || pr.includes('односторонняя') ? 'layer' : 'net', message: pr, at: t.points[0] ?? null, ids: [t.id] });
    if (t.widthMm < r.minTrackMm) out.push({ severity: 'error', code: 'track-width', message: `Дорожка ${len(t.widthMm)} уже минимальной ${len(r.minTrackMm)}`, at: t.points[0] ?? null, ids: [t.id] });
    for (const s of trackShapes(t)) items.push({ kind: 'track', id: t.id, label: 'дорожка', netId: t.netId, layers: [t.layer], shape: s, at: s.pts[0]! });
  }

  // Край платы
  const edgeSeen = new Set<string>();
  for (const it of items) {
    const g = edgeGap(it.shape, board);
    if (g < r.edgeMm && !edgeSeen.has(it.id + it.label)) {
      edgeSeen.add(it.id + it.label);
      out.push({ severity: 'error', code: 'edge', message: `${cap(it.label)}: ${g < 0 ? 'выходит за край платы' : `до края ${len(Math.max(0, g))} < ${len(r.edgeMm)}`}`, at: it.at, ids: [it.id] });
    }
  }

  // Зазоры между медью разных цепей на общем слое
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i]!, b = items[j]!;
    if (a.netId && a.netId === b.netId) continue;
    if (a.kind === 'pad' && b.kind === 'pad' && a.id === b.id && a.label === b.label) continue;
    if (a.kind === 'track' && b.kind === 'track' && a.id === b.id) continue;
    if (!a.layers.some((l) => b.layers.includes(l))) continue;
    const gap = shapeGap(a.shape, b.shape);
    if (gap >= r.clearanceMm) continue;
    const key = [a.id + a.label, b.id + b.label].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const short = gap <= 0;
    out.push({
      severity: 'error', code: short ? 'short' : 'clearance', at: a.at, ids: [a.id, b.id],
      message: short
        ? `Короткое замыкание: ${a.label} (${netName(doc, a.netId)}) касается: ${b.label} (${netName(doc, b.netId)})`
        : `Зазор ${len(gap)} < ${len(r.clearanceMm)}: ${a.label} (${netName(doc, a.netId)}) — ${b.label} (${netName(doc, b.netId)})`,
    });
  }

  // Отверстия: сверло, поясок, расстояние между отверстиями
  const holes: Array<{ at: Point; d: number; label: string; id: string }> = [];
  for (const p of pads) {
    if (!p.drill) continue;
    holes.push({ at: p.pos, d: p.drill, label: `${p.refDes}.${p.ref.pad}`, id: p.ref.placementId });
    if (p.drill < r.minDrillMm) out.push({ severity: 'error', code: 'drill', message: `${p.refDes}.${p.ref.pad}: отверстие ${len(p.drill)} меньше минимального ${len(r.minDrillMm)}`, at: p.pos, ids: [p.ref.placementId] });
    const ring = (Math.min(p.w, p.h) - p.drill) / 2;
    if (ring < r.minAnnularMm) out.push({ severity: 'error', code: 'annular', message: `${p.refDes}.${p.ref.pad}: поясок меди ${len(Math.max(0, ring))} < ${len(r.minAnnularMm)} — площадка порвётся при сверлении`, at: p.pos, ids: [p.ref.placementId] });
  }
  for (const v of doc.pcb.vias) {
    holes.push({ at: v.position, d: v.drillMm, label: 'переходное отверстие', id: v.id });
    if (v.drillMm < r.minDrillMm) out.push({ severity: 'error', code: 'drill', message: `Переходное отверстие: сверло ${len(v.drillMm)} меньше минимального ${len(r.minDrillMm)}`, at: v.position, ids: [v.id] });
    const ring = (v.diameterMm - v.drillMm) / 2;
    if (ring < r.minAnnularMm) out.push({ severity: 'error', code: 'annular', message: `Переходное отверстие: поясок ${len(Math.max(0, ring))} < ${len(r.minAnnularMm)}`, at: v.position, ids: [v.id] });
  }
  for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) {
    const a = holes[i]!, b = holes[j]!;
    const gap = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) - a.d / 2 - b.d / 2;
    if (gap < 0.25) out.push({ severity: 'error', code: 'hole', message: `Отверстия ${a.label} и ${b.label} ${gap < 0 ? 'пересекаются' : `ближе ${len(0.25)}`} — перемычка между ними сломается`, at: a.at, ids: [a.id, b.id] });
  }

  // Детали
  const boxes = doc.pcb.placements.map((pl) => ({ pl, b: bodyRect(doc, pl), ref: doc.schematic.instances.find((i) => i.id === pl.instanceId)?.refDes }));
  for (const { pl, b, ref } of boxes) {
    if (!ref) { out.push({ severity: 'error', code: 'orphan', message: 'На плате есть деталь, удалённая из схемы — выполните синхронизацию', at: pl.position, ids: [pl.id] }); continue; }
    if (b && (b.x < 0 || b.y < 0 || b.x + b.w > board.widthMm || b.y + b.h > board.heightMm)) out.push({ severity: 'warning', code: 'edge', message: `${ref}: корпус выходит за край платы`, at: pl.position, ids: [pl.id] });
    const { pkg } = placementContext(doc, pl);
    if (board.layers === 1 && pkg?.mount === 'THT' && pl.side === 'bottom') out.push({ severity: 'warning', code: 'layer', message: `${ref}: выводная деталь со стороны меди — на односторонней плате её обычно ставят сверху`, at: pl.position, ids: [pl.id] });
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    if (!a.b || !b.b || !a.ref || !b.ref || a.pl.side !== b.pl.side) continue;
    if (rectsOverlap(a.b, b.b, -0.01)) out.push({ severity: 'warning', code: 'overlap', message: `Корпуса ${a.ref} и ${b.ref} перекрываются`, at: a.pl.position, ids: [a.pl.id, b.pl.id] });
  }

  for (const n of unroutedNets(doc)) {
    out.push({ severity: 'warning', code: 'unrouted', message: `Не разведено: цепь ${n.name} — соединений ${n.missing}`, at: null, ids: [] });
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Всего неразведённых соединений (для краткой сводки). */
export const unroutedCount = (doc: ProjectDoc) => ratsnest(doc).length;
