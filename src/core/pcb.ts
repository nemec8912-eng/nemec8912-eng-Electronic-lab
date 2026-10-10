/**
 * Печатная плата (этап 1b — односторонняя, медь снизу, выводные детали сверху).
 * Координаты в мм, начало — левый верхний угол платы, вид со стороны деталей.
 * Цепь площадки определяется так: площадка → вывод символа (явный pinMap корпуса детали) → сеть схемы.
 * Изменения схемы переносятся на плату только явной синхронизацией с отчётом; разводка не удаляется молча.
 */
import { touch } from './factory';
import { newId } from './ids';
import type { Net, PackageDef, PadRef, PartDef, Placement, Point, ProjectDoc, Track } from './model';
import { netOfPin } from './schematic';

export const PCB_GRID = 1.27; // мм (0,05")
export const snapMm = (v: number) => Math.round(v / PCB_GRID) * PCB_GRID;
export const DEFAULT_BOARD = { widthMm: 60, heightMm: 40 };
export const DEFAULT_TRACK_MM = 0.8;

export interface DrcRules { clearanceMm: number; minTrackMm: number; edgeMm: number }
export const DEFAULT_RULES: DrcRules = { clearanceMm: 0.4, minTrackMm: 0.4, edgeMm: 0.5 };

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

export interface PadInfo {
  ref: PadRef;
  pos: Point;
  shape: 'round' | 'rect' | 'oval';
  w: number;
  h: number;
  drill: number | null;
  netId: string | null;
  refDes: string;
}

export function padsOf(doc: ProjectDoc, pl: Placement): PadInfo[] {
  const { pkg, pinMap } = placementContext(doc, pl);
  const inst = doc.schematic.instances.find((i) => i.id === pl.instanceId);
  if (!pkg || !inst) return [];
  return pkg.pads.map((pad) => {
    const r = rot({ x: pad.x, y: pad.y }, pl.rotation);
    const swap = pl.rotation === 90 || pl.rotation === 270;
    const symbolPin = pinMap.find((m) => m.pad === pad.number)?.symbolPin;
    const net = symbolPin ? netOfPin(doc, { instanceId: inst.id, pin: symbolPin }) : undefined;
    return {
      ref: { placementId: pl.id, pad: pad.number },
      pos: { x: pl.position.x + r.x, y: pl.position.y + r.y },
      shape: pad.shape, w: swap ? pad.h : pad.w, h: swap ? pad.w : pad.h, drill: pad.drill,
      netId: net?.id ?? null,
      refDes: inst.refDes,
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

/** Контур корпуса на плате (для шелкографии и проверки выхода за край). */
export function bodyRect(doc: ProjectDoc, pl: Placement): { x: number; y: number; w: number; h: number } | null {
  const { pkg } = placementContext(doc, pl);
  if (!pkg?.body) return null;
  const b = pkg.body;
  const corners = [rot({ x: b.x, y: b.y }, pl.rotation), rot({ x: b.x + b.w, y: b.y + b.h }, pl.rotation)];
  const xs = corners.map((c) => c.x + pl.position.x), ys = corners.map((c) => c.y + pl.position.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1]! - xs[0]!), h: Math.abs(ys[1]! - ys[0]!) };
}

// ---------- Плата и синхронизация ----------

export function setBoard(doc: ProjectDoc, widthMm: number, heightMm: number): ProjectDoc {
  const b = doc.pcb.board;
  if (b && b.widthMm === widthMm && b.heightMm === heightMm) return doc;
  const board = { id: b?.id ?? newId(), widthMm, heightMm, layers: 1 as const };
  return touch({ ...doc, pcb: { ...doc.pcb, board } });
}

export interface SyncReport {
  added: string[];
  removed: string[];
  removedTracks: number;
  kept: number;
  notPlaced: Array<{ refDes: string; reason: string }>;
  problems: string[];
}

/** Перенос деталей и цепей из схемы на плату. Возвращает новый документ и отчёт о том, что изменилось. */
export function syncFromSchematic(doc: ProjectDoc): { doc: ProjectDoc; report: SyncReport } {
  const report: SyncReport = { added: [], removed: [], removedTracks: 0, kept: 0, notPlaced: [], problems: [] };
  let d = doc.pcb.board ? doc : { ...doc, pcb: { ...doc.pcb, board: { id: newId(), ...DEFAULT_BOARD, layers: 1 as const } } };
  const board = d.pcb.board!;
  const instIds = new Set(d.schematic.instances.map((i) => i.id));

  // Удалённые из схемы детали: их размещения и дорожки к их площадкам убираются (с отчётом).
  const gone = d.pcb.placements.filter((pl) => !instIds.has(pl.instanceId));
  const goneIds = new Set(gone.map((g) => g.id));
  for (const g of gone) {
    const pkg = d.library.packages.find((x) => x.id === g.packageId);
    report.removed.push(`деталь, удалённая из схемы (корпус «${pkg?.name ?? '?'}»)`);
  }
  const tracks = d.pcb.tracks.filter((t) => {
    const hit = (t.from && goneIds.has(t.from.placementId)) || (t.to && goneIds.has(t.to.placementId));
    if (hit) report.removedTracks++;
    return !hit;
  });
  let placements = d.pcb.placements.filter((pl) => !goneIds.has(pl.id));
  report.kept = placements.length;

  // Новые детали — в свободные места рядами.
  let cursorX = 6, cursorY = 8;
  const placedIds = new Set(placements.map((p) => p.instanceId));
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
    const width = Math.max(...pkg.pads.map((p) => p.x)) - Math.min(...pkg.pads.map((p) => p.x)) + 6;
    if (cursorX + width > board.widthMm - 4) { cursorX = 6; cursorY += 12; }
    placements = [...placements, { id: newId(), instanceId: inst.id, packageId: pkg.id, position: { x: snapMm(cursorX), y: snapMm(cursorY) }, rotation: 0, side: 'top' }];
    report.added.push(inst.refDes);
    cursorX += width + 6;
  }
  d = { ...d, pcb: { ...d.pcb, placements, tracks } };

  // Дорожки, которые после изменения схемы соединяют разные цепи, не удаляются, а попадают в отчёт и DRC.
  for (const t of d.pcb.tracks) {
    const m = trackMismatch(d, t);
    if (m) report.problems.push(m);
  }
  const changed = report.added.length > 0 || report.removed.length > 0 || d.pcb.board !== doc.pcb.board;
  return { doc: changed ? touch(d) : doc, report };
}

function trackMismatch(doc: ProjectDoc, t: Track): string | null {
  const a = t.from ? findPad(doc, t.from) : undefined, b = t.to ? findPad(doc, t.to) : undefined;
  const names = (p?: PadInfo) => (p ? `${p.refDes}.${p.ref.pad}` : '?');
  if (!a || !b) return `Дорожка ${t.id.slice(0, 8)}: конец не на площадке (деталь удалена из схемы — выполните синхронизацию)`;
  if (!a.netId || !b.netId || a.netId !== b.netId || a.netId !== t.netId) {
    return `Дорожка ${names(a)} — ${names(b)} соединяет разные цепи (схема изменилась после разводки)`;
  }
  return null;
}

// ---------- Редактирование ----------

export function movePlacement(doc: ProjectDoc, id: string, pos: Point): ProjectDoc {
  const p = { x: snapMm(pos.x), y: snapMm(pos.y) };
  const pl = doc.pcb.placements.find((x) => x.id === id);
  if (!pl || (pl.position.x === p.x && pl.position.y === p.y)) return doc;
  const placements = doc.pcb.placements.map((x) => (x.id === id ? { ...x, position: p } : x));
  return touch(rerouteTracks({ ...doc, pcb: { ...doc.pcb, placements } }, id));
}

export function rotatePlacement(doc: ProjectDoc, id: string): ProjectDoc {
  const pl = doc.pcb.placements.find((x) => x.id === id);
  if (!pl) return doc;
  const rotation = ((pl.rotation + 90) % 360) as Placement['rotation'];
  const placements = doc.pcb.placements.map((x) => (x.id === id ? { ...x, rotation } : x));
  return touch(rerouteTracks({ ...doc, pcb: { ...doc.pcb, placements } }, id));
}

function rerouteTracks(doc: ProjectDoc, placementId: string): ProjectDoc {
  const tracks = doc.pcb.tracks.map((t) => {
    if (t.from?.placementId !== placementId && t.to?.placementId !== placementId) return t;
    const a = t.from ? findPad(doc, t.from) : undefined, b = t.to ? findPad(doc, t.to) : undefined;
    return a && b ? { ...t, points: [a.pos, b.pos] } : t;
  });
  return { ...doc, pcb: { ...doc.pcb, tracks } };
}

export function addTrack(doc: ProjectDoc, from: PadRef, to: PadRef, widthMm = DEFAULT_TRACK_MM): { doc: ProjectDoc; error: string | null } {
  if (from.placementId === to.placementId && from.pad === to.pad) return { doc, error: null };
  const a = findPad(doc, from), b = findPad(doc, to);
  if (!a || !b) return { doc, error: 'Площадка не найдена' };
  if (!a.netId || !b.netId) return { doc, error: `Площадка ${!a.netId ? `${a.refDes}.${a.ref.pad}` : `${b.refDes}.${b.ref.pad}`} не подключена ни к одной цепи схемы` };
  if (a.netId !== b.netId) return { doc, error: `${a.refDes}.${a.ref.pad} и ${b.refDes}.${b.ref.pad} — разные цепи схемы. Дорожка закоротила бы их.` };
  if (doc.pcb.tracks.some((t) => t.from && t.to && ((sameRef(t.from, from) && sameRef(t.to, to)) || (sameRef(t.from, to) && sameRef(t.to, from))))) {
    return { doc, error: 'Эти площадки уже соединены дорожкой' };
  }
  const track: Track = { id: newId(), netId: a.netId, layer: 'bottom', widthMm, from, to, points: [a.pos, b.pos] };
  return { doc: touch({ ...doc, pcb: { ...doc.pcb, tracks: [...doc.pcb.tracks, track] } }), error: null };
}

const sameRef = (x: PadRef, y: PadRef) => x.placementId === y.placementId && x.pad === y.pad;

export function deleteTrack(doc: ProjectDoc, id: string): ProjectDoc {
  const tracks = doc.pcb.tracks.filter((t) => t.id !== id);
  return tracks.length === doc.pcb.tracks.length ? doc : touch({ ...doc, pcb: { ...doc.pcb, tracks } });
}

// ---------- Неразведённые соединения ----------

export interface RatLine { netId: string; a: Point; b: Point }

export function ratsnest(doc: ProjectDoc): RatLine[] {
  const pads = allPads(doc);
  const key = (r: PadRef) => `${r.placementId}#${r.pad}`;
  const parent = new Map<string, string>();
  const find = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const r = find(p); parent.set(k, r); return r; };
  for (const p of pads) parent.set(key(p.ref), key(p.ref));
  for (const t of doc.pcb.tracks) {
    if (!t.from || !t.to || trackMismatch(doc, t)) continue;
    parent.set(find(key(t.from)), find(key(t.to)));
  }
  const byNet = new Map<string, PadInfo[]>();
  for (const p of pads) if (p.netId) byNet.set(p.netId, [...(byNet.get(p.netId) ?? []), p]);
  const lines: RatLine[] = [];
  for (const [netId, list] of byNet) {
    // Группы, уже соединённые дорожками; соединяем группы цепочкой ближайших площадок.
    const groups = new Map<string, PadInfo[]>();
    for (const p of list) { const r = find(key(p.ref)); groups.set(r, [...(groups.get(r) ?? []), p]); }
    const gs = [...groups.values()];
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

// ---------- DRC ----------

export interface DrcIssue { severity: 'error' | 'warning'; message: string; at: Point | null }

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segSegDist(a1: Point, a2: Point, b1: Point, b2: Point): number {
  const ccw = (p: Point, q: Point, r: Point) => (r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x);
  const d1 = ccw(b1, b2, a1), d2 = ccw(b1, b2, a2), d3 = ccw(a1, a2, b1), d4 = ccw(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist(a1, b1, b2), segDist(a2, b1, b2), segDist(b1, a1, a2), segDist(b2, a1, a2));
}

const padRadius = (p: PadInfo) => Math.max(p.w, p.h) / 2;

export function drc(doc: ProjectDoc, rules: DrcRules = DEFAULT_RULES): DrcIssue[] {
  const out: DrcIssue[] = [];
  const board = doc.pcb.board;
  if (!board) return [{ severity: 'error', message: 'Размеры платы не заданы', at: null }];
  const pads = allPads(doc);
  for (const p of pads) {
    const r = padRadius(p) + rules.edgeMm;
    if (p.pos.x - r < 0 || p.pos.y - r < 0 || p.pos.x + r > board.widthMm || p.pos.y + r > board.heightMm) {
      out.push({ severity: 'error', message: `${p.refDes}.${p.ref.pad}: площадка за краем платы (или ближе ${rules.edgeMm} мм)`, at: p.pos });
    }
  }
  for (const t of doc.pcb.tracks) {
    const m = trackMismatch(doc, t);
    if (m) out.push({ severity: 'error', message: m, at: t.points[0] ?? null });
    if (t.widthMm < rules.minTrackMm) out.push({ severity: 'error', message: `Дорожка уже ${rules.minTrackMm} мм`, at: t.points[0] ?? null });
    // Зазор дорожка — чужая площадка
    for (let i = 0; i + 1 < t.points.length; i++) {
      const a = t.points[i]!, b = t.points[i + 1]!;
      for (const p of pads) {
        if (p.netId === t.netId) continue;
        const gap = segDist(p.pos, a, b) - padRadius(p) - t.widthMm / 2;
        if (gap < rules.clearanceMm) out.push({ severity: 'error', message: `Зазор между дорожкой и площадкой ${p.refDes}.${p.ref.pad} ${Math.max(0, gap).toFixed(2)} мм < ${rules.clearanceMm} мм`, at: p.pos });
      }
    }
  }
  // Зазор дорожка — дорожка разных цепей
  const ts = doc.pcb.tracks;
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    const x = ts[i]!, y = ts[j]!;
    if (x.netId === y.netId) continue;
    let min = Infinity;
    for (let a = 0; a + 1 < x.points.length; a++) for (let b = 0; b + 1 < y.points.length; b++) {
      min = Math.min(min, segSegDist(x.points[a]!, x.points[a + 1]!, y.points[b]!, y.points[b + 1]!));
    }
    const gap = min - x.widthMm / 2 - y.widthMm / 2;
    if (gap < rules.clearanceMm) out.push({ severity: 'error', message: `Дорожки разных цепей ближе ${rules.clearanceMm} мм${min === 0 ? ' (пересекаются — короткое замыкание)' : ''}`, at: x.points[0] ?? null });
  }
  // Площадки разных цепей слишком близко
  for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) {
    const a = pads[i]!, b = pads[j]!;
    if (a.netId && a.netId === b.netId) continue;
    const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) - padRadius(a) - padRadius(b);
    if (gap < rules.clearanceMm) out.push({ severity: 'error', message: `Площадки ${a.refDes}.${a.ref.pad} и ${b.refDes}.${b.ref.pad} ближе ${rules.clearanceMm} мм`, at: a.pos });
  }
  for (const pl of doc.pcb.placements) {
    if (!doc.schematic.instances.some((i) => i.id === pl.instanceId)) out.push({ severity: 'error', message: 'На плате есть деталь, удалённая из схемы — выполните синхронизацию', at: pl.position });
  }
  const unrouted = ratsnest(doc).length;
  if (unrouted > 0) out.push({ severity: 'warning', message: `Не разведено соединений: ${unrouted}`, at: null });
  return out;
}

export function netName(doc: ProjectDoc, netId: string): string {
  const n: Net | undefined = doc.schematic.nets.find((x) => x.id === netId);
  return n?.name ?? `цепь ${netId.slice(0, 4)}`;
}

// ---------- Вывод 1:1 для ЛУТ ----------

export interface CopperSvgOptions {
  /** true — вид со стороны меди (как смотрим на нижнюю сторону); false — вид со стороны деталей. */
  copperSide: boolean;
}

const f = (n: number) => Number(n.toFixed(3)).toString();

/**
 * SVG в миллиметрах (width="…mm") — при печати «100 %, без масштабирования» размеры совпадают с платой.
 * Калибровочный квадрат 10×10 мм и надпись для проверки ориентации включены.
 */
export function copperSvg(doc: ProjectDoc, opts: CopperSvgOptions): string {
  const board = doc.pcb.board ?? { widthMm: DEFAULT_BOARD.widthMm, heightMm: DEFAULT_BOARD.heightMm };
  const margin = 5, cal = 10;
  const W = board.widthMm + margin * 3 + cal, H = Math.max(board.heightMm, cal + 8) + margin * 2 + 8;
  const ox = margin, oy = margin;
  const mirror = opts.copperSide ? `translate(${f(ox * 2 + board.widthMm)} 0) scale(-1 1)` : '';
  const parts: string[] = [];
  parts.push(`<rect x="${f(ox)}" y="${f(oy)}" width="${f(board.widthMm)}" height="${f(board.heightMm)}" fill="none" stroke="#000" stroke-width="0.15"/>`);
  for (const t of doc.pcb.tracks) {
    parts.push(`<polyline points="${t.points.map((p) => `${f(ox + p.x)},${f(oy + p.y)}`).join(' ')}" fill="none" stroke="#000" stroke-width="${f(t.widthMm)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const p of allPads(doc)) {
    const cx = ox + p.pos.x, cy = oy + p.pos.y;
    if (p.shape === 'rect') parts.push(`<rect x="${f(cx - p.w / 2)}" y="${f(cy - p.h / 2)}" width="${f(p.w)}" height="${f(p.h)}" fill="#000"/>`);
    else parts.push(`<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(p.w / 2)}" ry="${f(p.h / 2)}" fill="#000"/>`);
    if (p.drill) parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(Math.min(p.drill / 2, 0.4))}" fill="#fff"/>`); // керн для сверления
  }
  // Вид со стороны меди — зеркало вида со стороны деталей относительно вертикальной оси платы.
  // Надписей в меди нет (они могли бы замкнуть дорожки); ориентацию поясняет подпись на поле листа.
  const copperGroup = opts.copperSide ? `<g transform="${mirror}">${parts.join('')}</g>` : `<g>${parts.join('')}</g>`;
  const calX = ox + board.widthMm + margin;
  const calibration = `<rect x="${f(calX)}" y="${f(oy)}" width="${cal}" height="${cal}" fill="none" stroke="#000" stroke-width="0.2"/>` +
    `<text x="${f(calX)}" y="${f(oy + cal + 4)}" font-size="2.6" font-family="Arial, sans-serif">10×10 мм</text>`;
  const caption = `<text x="${f(ox)}" y="${f(H - 3)}" font-size="2.6" font-family="Arial, sans-serif">${opts.copperSide ? 'Вид со стороны меди' : 'Вид со стороны деталей (для ЛУТ при меди снизу)'} · печать 1:1, масштаб 100 % · проверьте квадрат линейкой</text>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">` +
    `<rect width="100%" height="100%" fill="#fff"/>${copperGroup}${calibration}${caption}</svg>\n`;
}
