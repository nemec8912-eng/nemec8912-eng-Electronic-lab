/**
 * Операции редактора схемы. Связность — граф (connectivity.ts): провода соединяют выводы, узлы и
 * метки; сети пересчитываются по графу после каждого изменения (UUID сетей сохраняются).
 * Все функции чистые: возвращают новый документ или прежний, если ничего не изменилось.
 */
import { builtinBundle, type PartBundle } from './catalog';
import { endKey, graphOf, rebuildNets } from './connectivity';
import { logChange, touch } from './factory';
import { dropInstrumentPins } from './instruments';
import { newId } from './ids';
import { builtinByCatalogId, formatQuantity, PARAMS } from './library';
import type { Annotation, ComponentInstance, Junction, Net, NetLabel, PinRef, Point, ProjectDoc, Quantity, SimModel, SymbolDef, Wire, WireEnd } from './model';

export const GRID = 10;
export const snap = (v: number) => Math.round(v / GRID) * GRID;
export const snapPt = (p: Point): Point => ({ x: snap(p.x), y: snap(p.y) });
export const samePin = (a: PinRef, b: PinRef) => a.instanceId === b.instanceId && a.pin === b.pin;
export const pinEnd = (p: PinRef): WireEnd => ({ kind: 'pin', instanceId: p.instanceId, pin: p.pin });
const samePt = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
type Rot = ComponentInstance['rotation'];

// ---------- Геометрия ----------

export function rotatePoint(p: Point, rotation: number, mirrored: boolean): Point {
  const x = mirrored ? -p.x : p.x;
  switch (rotation) {
    case 90: return { x: -p.y, y: x };
    case 180: return { x: -x, y: -p.y };
    case 270: return { x: p.y, y: -x };
    default: return { x, y: p.y };
  }
}

export function symbolOf(doc: ProjectDoc, inst: ComponentInstance): SymbolDef | undefined {
  const part = doc.library.parts.find((p) => p.id === inst.partId);
  return part ? doc.library.symbols.find((s) => s.id === part.symbolId) : undefined;
}

/** Точка вывода на полотне с учётом положения, поворота и отражения детали. */
export function pinPosition(doc: ProjectDoc, ref: PinRef): Point | null {
  const inst = doc.schematic.instances.find((i) => i.id === ref.instanceId);
  if (!inst) return null;
  const pin = symbolOf(doc, inst)?.pins.find((p) => p.number === ref.pin);
  if (!pin) return null;
  const r = rotatePoint({ x: pin.x, y: pin.y }, inst.rotation, inst.mirrored);
  return { x: inst.position.x + r.x, y: inst.position.y + r.y };
}

/** Положение конца провода (свободный конец — null). */
export function endPosition(doc: ProjectDoc, e: WireEnd): Point | null {
  if (e.kind === 'pin') return pinPosition(doc, e);
  if (e.kind === 'junction') return doc.schematic.junctions.find((j) => j.id === e.junctionId)?.position ?? null;
  if (e.kind === 'label') return doc.schematic.labels.find((l) => l.id === e.labelId)?.position ?? null;
  return null;
}

/** Ломаная из двух отрезков (горизонталь, затем вертикаль). */
export function routeWire(a: Point, b: Point): Point[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  return [a, { x: b.x, y: a.y }, b];
}

type Seg = [Point, Point];
export const segsOf = (pts: Point[]): Seg[] => pts.slice(1).map((q, i) => [pts[i]!, q] as Seg);

function overlapCollinear(a: Seg, b: Seg): boolean {
  const [a1, a2] = a, [b1, b2] = b;
  if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
    const lo = Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)), hi = Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
    return hi - lo > 0;
  }
  if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
    const lo = Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)), hi = Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
    return hi - lo > 0;
  }
  return false;
}

/** Точка лежит на отрезке (отрезки параллельны осям). */
export function onSeg(p: Point, [a, b]: Seg): boolean {
  if (a.x === b.x) return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  if (a.y === b.y) return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  return false;
}

/** Убрать повторы точек и промежуточные точки на прямой. */
export function simplify(pts: Point[]): Point[] {
  const d = pts.filter((q, i) => i === 0 || !samePt(q, pts[i - 1]!));
  const out: Point[] = [];
  for (const q of d) {
    const a = out[out.length - 2], b = out[out.length - 1];
    if (a && b && ((a.x === b.x && b.x === q.x) || (a.y === b.y && b.y === q.y))) out[out.length - 1] = q;
    else out.push(q);
  }
  return out.length >= 2 ? out : [d[0]!, d[d.length - 1] ?? d[0]!];
}

/** Сделать ломаную ортогональной: между неосевыми соседями вставляется угол (сначала по горизонтали). */
export function orthogonal(pts: Point[]): Point[] {
  const out: Point[] = [pts[0]!];
  for (const q of pts.slice(1)) {
    const prev = out[out.length - 1]!;
    if (prev.x !== q.x && prev.y !== q.y) out.push({ x: q.x, y: prev.y });
    out.push(q);
  }
  return simplify(out);
}

/** Трассировка без наложения на провода и выводы других цепей (иначе на рисунке это выглядит как соединение). */
export function routeAvoiding(doc: ProjectDoc, a: Point, b: Point, netId: string | null, skipWireId?: string): Point[] {
  const g = graphOf(doc);
  const foreign: Seg[] = doc.schematic.wires
    .filter((w) => w.id !== skipWireId && (netId === null || g.netOfWire.get(w.id) !== netId))
    .flatMap((w) => segsOf(w.points));
  const foreignPins: Point[] = [];
  for (const inst of doc.schematic.instances) for (const pin of symbolOf(doc, inst)?.pins ?? []) {
    const ref = { instanceId: inst.id, pin: pin.number };
    if (netId !== null && netOfPin(doc, ref)?.id === netId) continue;
    const pos = pinPosition(doc, ref)!;
    if (samePt(pos, a) || samePt(pos, b)) continue;
    foreignPins.push(pos);
  }
  const ok = (pts: Point[]) => segsOf(pts).every((sg) => !foreign.some((f) => overlapCollinear(sg, f)) && !foreignPins.some((fp) => onSeg(fp, sg)));
  const candidates: Point[][] = [routeWire(a, b), [a, { x: a.x, y: b.y }, b]];
  for (const off of [GRID * 2, -GRID * 2, GRID * 4, -GRID * 4, GRID * 6, -GRID * 6]) {
    const mx = snap((a.x + b.x) / 2) + off, my = snap((a.y + b.y) / 2) + off;
    candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
    candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
    candidates.push([a, { x: a.x + off, y: a.y }, { x: a.x + off, y: b.y }, b]);
    candidates.push([a, { x: a.x, y: a.y + off }, { x: b.x, y: a.y + off }, b]);
  }
  for (const c of candidates) { const d = simplify(c); if (ok(d)) return d; }
  return routeWire(a, b);
}

/** Сдвинуть концы ломаной в новые точки, сохранив её середину (ручные провода). */
export function adjustEnds(points: Point[], a: Point, b: Point): Point[] {
  if (points.length <= 2) return routeWire(a, b);
  const mid = points.slice(1, -1);
  return orthogonal([a, ...mid, b]);
}

/** Перестроить провода, у которых сдвинулись концы. */
function rerouteWires(doc: ProjectDoc, movedEnds: Set<string>): ProjectDoc {
  let d = doc;
  for (const w of doc.schematic.wires) {
    const ka = endKey(w.a), kb = endKey(w.b);
    if (!(ka && movedEnds.has(ka)) && !(kb && movedEnds.has(kb))) continue;
    const a = endPosition(d, w.a) ?? w.points[0]!, b = endPosition(d, w.b) ?? w.points[w.points.length - 1]!;
    if (samePt(a, w.points[0]!) && samePt(b, w.points[w.points.length - 1]!)) continue;
    const points = w.manual || w.a.kind === 'free' || w.b.kind === 'free'
      ? adjustEnds(w.points, a, b)
      : routeAvoiding(d, a, b, graphOf(d).netOfWire.get(w.id) ?? null, w.id);
    d = { ...d, schematic: { ...d.schematic, wires: d.schematic.wires.map((x) => (x.id === w.id ? { ...x, points } : x)) } };
  }
  return d;
}

const instPinKeys = (doc: ProjectDoc, inst: ComponentInstance) => (symbolOf(doc, inst)?.pins ?? []).map((p) => `p:${inst.id}#${p.number}`);

/** Завершение любой правки: уборка узлов, пересчёт сетей, отметка ревизии. */
function finish(doc: ProjectDoc): ProjectDoc {
  return touch(rebuildNets(normalize(doc)));
}

// ---------- Детали ----------

/**
 * Встраивает комплект детали каталога в библиотеку проекта (один раз на деталь каталога) и возвращает
 * id детали проекта. Копия получает новые id; связь с каталогом — origin.catalogPartId.
 */
export function embedBundle(doc: ProjectDoc, b: PartBundle): { doc: ProjectDoc; partId: string } {
  const catalogPartId = b.part.origin.catalogPartId ?? b.part.id;
  const existing = doc.library.parts.find((p) => p.origin.catalogPartId === catalogPartId);
  if (existing) return { doc, partId: existing.id };
  const symbolId = newId();
  const modelId = b.model ? newId() : null;
  const pkgIds = new Map(b.packages.map((p) => [p.id, newId()]));
  const partId = newId();
  const library = {
    symbols: [...doc.library.symbols, { ...structuredClone(b.symbol), id: symbolId }],
    packages: [...doc.library.packages, ...b.packages.map((p) => ({ ...structuredClone(p), id: pkgIds.get(p.id)! }))],
    models: b.model && modelId ? [...doc.library.models, { ...structuredClone(b.model), id: modelId }] : doc.library.models,
    parts: [...doc.library.parts, {
      ...structuredClone(b.part),
      id: partId, symbolId, modelId,
      packages: b.part.packages.filter((p) => pkgIds.has(p.packageId)).map((p) => ({ packageId: pkgIds.get(p.packageId)!, pinMap: structuredClone(p.pinMap) })),
      origin: { ...b.part.origin, catalogPartId },
    }],
  };
  return { doc: { ...doc, library }, partId };
}

export function nextRefDes(doc: ProjectDoc, prefix: string, taken: Set<string> = new Set()): string {
  const used = new Set([...doc.schematic.instances.map((i) => i.refDes.toUpperCase()), ...[...taken].map((t) => t.toUpperCase())]);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`.toUpperCase())) return `${prefix}${n}`;
}

export function placeBuiltin(doc: ProjectDoc, catalogId: string, position: Point, id: string = newId()): { doc: ProjectDoc; id: string } {
  const b = builtinByCatalogId(catalogId);
  if (!b) throw new Error(`Неизвестная деталь ${catalogId}`);
  return placeBundle(doc, builtinBundle(b), position, id);
}

/** Разместить деталь каталога на схеме. Номиналы экземпляра берутся из номиналов детали. */
export function placeBundle(doc: ProjectDoc, bundle: PartBundle, position: Point, id: string = newId()): { doc: ProjectDoc; id: string } {
  const embedded = embedBundle(doc, bundle);
  const d = embedded.doc;
  const part = d.library.parts.find((p) => p.id === embedded.partId)!;
  const inst: ComponentInstance = {
    id, partId: embedded.partId, refDes: nextRefDes(d, part.refPrefix), position: snapPt(position),
    rotation: 0, mirrored: false, values: structuredClone(part.values),
  };
  return { doc: finish({ ...d, schematic: { ...d.schematic, instances: [...d.schematic.instances, inst] } }), id };
}

export function setValue(doc: ProjectDoc, id: string, key: string, q: Quantity): ProjectDoc {
  const inst = doc.schematic.instances.find((i) => i.id === id);
  if (!inst) return doc;
  const cur = inst.values[key];
  if (cur && cur.value === q.value && cur.unit === q.unit) return doc;
  const instances = doc.schematic.instances.map((i) => (i.id === id ? { ...i, values: { ...i.values, [key]: q } } : i));
  const unit = PARAMS[key]?.unitRu ?? q.unit;
  const what = `${inst.refDes}: ${(PARAMS[key]?.label ?? key).toLowerCase()} ${cur ? formatQuantity(cur.value, unit, 4) : '—'} → ${formatQuantity(q.value, unit, 4)}`;
  return logChange(touch({ ...doc, schematic: { ...doc.schematic, instances } }), 'value', what);
}

export const REFDES_RE = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_]{0,31}$/;

export function renameRefDes(doc: ProjectDoc, id: string, refDes: string): { doc: ProjectDoc; error: string | null } {
  const r = refDes.trim();
  if (!REFDES_RE.test(r)) return { doc, error: 'Обозначение: буква, затем буквы, цифры или «_» (до 32 символов)' };
  if (doc.schematic.instances.some((i) => i.id !== id && i.refDes.toUpperCase() === r.toUpperCase())) return { doc, error: `Обозначение ${r} уже занято` };
  const inst = doc.schematic.instances.find((i) => i.id === id);
  if (!inst || inst.refDes === r) return { doc, error: null };
  const instances = doc.schematic.instances.map((i) => (i.id === id ? { ...i, refDes: r } : i));
  return { doc: touch({ ...doc, schematic: { ...doc.schematic, instances } }), error: null };
}

/**
 * Перенумерация позиционных обозначений по листу: для каждого префикса — слева направо по строкам
 * сверху вниз (ГОСТ 2.710). Возвращает таблицу «было → стало».
 */
export function renumber(doc: ProjectDoc): { doc: ProjectDoc; changes: Array<{ from: string; to: string }> } {
  const prefixOf = (i: ComponentInstance) => doc.library.parts.find((p) => p.id === i.partId)?.refPrefix ?? i.refDes.replace(/\d+$/, '');
  const byPrefix = new Map<string, ComponentInstance[]>();
  for (const i of doc.schematic.instances) {
    const part = doc.library.parts.find((p) => p.id === i.partId);
    if (part?.category === 'reference') continue;
    const k = prefixOf(i);
    byPrefix.set(k, [...(byPrefix.get(k) ?? []), i]);
  }
  const ROW = GRID * 8;
  const next = new Map<string, string>();
  for (const [prefix, list] of byPrefix) {
    list.sort((a, b) => Math.round(a.position.y / ROW) - Math.round(b.position.y / ROW) || a.position.x - b.position.x);
    list.forEach((inst, k) => next.set(inst.id, `${prefix}${k + 1}`));
  }
  const changes = doc.schematic.instances.filter((i) => next.has(i.id) && next.get(i.id) !== i.refDes).map((i) => ({ from: i.refDes, to: next.get(i.id)! }));
  if (!changes.length) return { doc, changes };
  const instances = doc.schematic.instances.map((i) => (next.has(i.id) ? { ...i, refDes: next.get(i.id)! } : i));
  return { doc: touch({ ...doc, schematic: { ...doc.schematic, instances } }), changes };
}

// ---------- Соединения ----------

export function netOfPin(doc: ProjectDoc, p: PinRef): Net | undefined {
  return doc.schematic.nets.find((n) => n.connections.some((c) => samePin(c, p)));
}

/** Куда ведёт конец рисуемого провода: вершина, точка на проводе (будет узел) или свободная точка. */
export type Terminal =
  | { kind: 'end'; end: Exclude<WireEnd, { kind: 'free' }> }
  | { kind: 'wire'; wireId: string; at: Point }
  | { kind: 'free'; at: Point };

/** Разделить провод в точке, вставив вершину (узел или метку). Точка проецируется на провод. */
export function splitWireAt(doc: ProjectDoc, wireId: string, at: Point, vertex: Exclude<WireEnd, { kind: 'pin' | 'free' }>): ProjectDoc | null {
  const w = doc.schematic.wires.find((x) => x.id === wireId);
  if (!w) return null;
  const segs = segsOf(w.points);
  const i = segs.findIndex((sg) => onSeg(at, sg));
  if (i < 0) return null;
  const first = simplify([...w.points.slice(0, i + 1), at]);
  const second = simplify([at, ...w.points.slice(i + 1)]);
  if ((samePt(at, w.points[0]!) && w.a.kind !== 'free') || (samePt(at, w.points[w.points.length - 1]!) && w.b.kind !== 'free')) return null;
  const w1: Wire = { id: w.id, a: w.a, b: vertex, points: first, manual: true };
  const w2: Wire = { id: newId(), a: vertex, b: w.b, points: second, manual: true };
  return { ...doc, schematic: { ...doc.schematic, wires: doc.schematic.wires.flatMap((x) => (x.id === w.id ? [w1, w2] : [x])) } };
}

function resolveTerminal(doc: ProjectDoc, t: Terminal): { doc: ProjectDoc; end: WireEnd; at: Point } | { error: string } {
  if (t.kind === 'free') return { doc, end: { kind: 'free' }, at: snapPt(t.at) };
  if (t.kind === 'end') {
    const at = endPosition(doc, t.end);
    return at ? { doc, end: t.end, at } : { error: 'Точка подключения не найдена' };
  }
  const w = doc.schematic.wires.find((x) => x.id === t.wireId);
  if (!w) return { error: 'Провод не найден' };
  const at = snapPt(t.at);
  // Конец провода — уже вершина: подключаемся к ней.
  if (samePt(at, w.points[0]!) && w.a.kind !== 'free') return { doc, end: w.a, at };
  if (samePt(at, w.points[w.points.length - 1]!) && w.b.kind !== 'free') return { doc, end: w.b, at };
  const j: Junction = { id: newId(), position: at };
  const d = splitWireAt({ ...doc, schematic: { ...doc.schematic, junctions: [...doc.schematic.junctions, j] } }, w.id, at, { kind: 'junction', junctionId: j.id });
  if (!d) {
    // Свободный конец провода: продолжаем его через узел.
    const atStart = samePt(at, w.points[0]!), atEnd = samePt(at, w.points[w.points.length - 1]!);
    if (atStart || atEnd) {
      const end = { kind: 'junction' as const, junctionId: j.id };
      const wires = doc.schematic.wires.map((x) => (x.id === w.id ? (atStart ? { ...x, a: end } : { ...x, b: end }) : x));
      return { doc: { ...doc, schematic: { ...doc.schematic, wires, junctions: [...doc.schematic.junctions, j] } }, end, at };
    }
    return { error: 'Точка не на проводе' };
  }
  return { doc: d, end: { kind: 'junction', junctionId: j.id }, at };
}

/**
 * Нарисовать провод от start до end через точки изгиба. Без изгибов провод трассируется сам и
 * перестраивается при перемещении деталей; с изгибами — ломаная пользователя (manual).
 */
export function drawWire(doc: ProjectDoc, start: Terminal, bends: Point[], end: Terminal, wireId: string = newId()): { doc: ProjectDoc; error: string | null; wireId: string | null } {
  const s = resolveTerminal(doc, start);
  if ('error' in s) return { doc, error: s.error, wireId: null };
  const e = resolveTerminal(s.doc, end);
  if ('error' in e) return { doc, error: e.error, wireId: null };
  let d = e.doc;
  const ka = endKey(s.end), kb = endKey(e.end);
  if (ka && kb && ka === kb) return { doc, error: null, wireId: null };
  if (s.end.kind === 'free' && e.end.kind === 'free' && samePt(s.at, e.at)) return { doc, error: null, wireId: null };
  if (ka && kb && d.schematic.wires.some((w) => { const x = endKey(w.a), y = endKey(w.b); return (x === ka && y === kb) || (x === kb && y === ka); })) {
    return { doc, error: 'Эти точки уже соединены проводом', wireId: null };
  }
  const manual = bends.length > 0 || s.end.kind === 'free' || e.end.kind === 'free';
  const g = graphOf(d);
  const netId = (ka && g.netOfVertex.get(ka)) ?? (kb && g.netOfVertex.get(kb)) ?? null;
  const points = manual ? orthogonal([s.at, ...bends.map(snapPt), e.at]) : routeAvoiding(d, s.at, e.at, netId);
  const wire: Wire = { id: wireId, a: s.end, b: e.end, points, manual };
  d = { ...d, schematic: { ...d.schematic, wires: [...d.schematic.wires, wire] } };
  return { doc: finish(d), error: null, wireId };
}

/** Соединить два вывода проводом (как раньше: щелчок по выводу, затем по второму). */
export function connectPins(doc: ProjectDoc, a: PinRef, b: PinRef): { doc: ProjectDoc; error: string | null } {
  if (samePin(a, b)) return { doc, error: null };
  if (!pinPosition(doc, a) || !pinPosition(doc, b)) return { doc, error: 'Вывод не найден' };
  const r = drawWire(doc, { kind: 'end', end: pinEnd(a) as Extract<WireEnd, { kind: 'pin' }> }, [], { kind: 'end', end: pinEnd(b) as Extract<WireEnd, { kind: 'pin' }> });
  if (r.error) return { doc, error: r.error.replace('Эти точки уже соединены проводом', 'Эти выводы уже соединены') };
  return { doc: r.doc, error: null };
}

// ---------- Метки цепей ----------

export const LABEL_NAME_RE = /^[^\s].{0,63}$/u;
export const POWER_NAMES = ['+5V', '+3V3', '+12V', '+15V', '-12V', '-15V', '+24V', 'VCC', 'VDD', 'VEE', 'VSS', '+9V'];

/**
 * Поставить метку цепи. На проводе — провод делится меткой; на выводе — метка ставится рядом и
 * соединяется коротким проводом; иначе — отдельная метка (к ней можно провести провод).
 */
export function addLabel(doc: ProjectDoc, name: string, kind: NetLabel['kind'], at: Terminal, rotation: Rot = 0, id: string = newId()): { doc: ProjectDoc; error: string | null; id: string } {
  const n = name.trim();
  if (!n || n.length > 64) return { doc, error: 'Имя метки: от 1 до 64 символов', id };
  if (/\s/.test(n)) return { doc, error: 'Имя метки без пробелов (например, +5V, OUT, SDA)', id };
  const label: NetLabel = { id, name: n, kind, position: { x: 0, y: 0 }, rotation };
  const lend = { kind: 'label' as const, labelId: id };
  if (at.kind === 'wire') {
    const p = snapPt(at.at);
    const base = { ...doc, schematic: { ...doc.schematic, labels: [...doc.schematic.labels, { ...label, position: p }] } };
    const d = splitWireAt(base, at.wireId, p, lend);
    if (!d) {
      // Конец провода: метка становится этим концом (свободным) или подключается к вершине.
      const w = doc.schematic.wires.find((x) => x.id === at.wireId);
      if (w) {
        const atStart = samePt(p, w.points[0]!), atEnd = samePt(p, w.points[w.points.length - 1]!);
        const vertex = atStart ? w.a : atEnd ? w.b : null;
        if (vertex && vertex.kind === 'free') {
          const wires = base.schematic.wires.map((x) => (x.id === w.id ? (atStart ? { ...x, a: lend } : { ...x, b: lend }) : x));
          return { doc: finish({ ...base, schematic: { ...base.schematic, wires } }), error: null, id };
        }
        if (vertex) return addLabel(doc, n, kind, { kind: 'end', end: vertex as Exclude<WireEnd, { kind: 'free' }> }, rotation, id);
      }
      return { doc, error: 'Точка не на проводе', id };
    }
    return { doc: finish(d), error: null, id };
  }
  if (at.kind === 'end') {
    const p = endPosition(doc, at.end);
    if (!p) return { doc, error: 'Точка подключения не найдена', id };
    const off = labelOffset(doc, at.end);
    const lp = { x: p.x + off.x, y: p.y + off.y };
    const base = { ...doc, schematic: { ...doc.schematic, labels: [...doc.schematic.labels, { ...label, position: lp, rotation: off.rotation }] } };
    const wire: Wire = { id: newId(), a: at.end, b: lend, points: [p, lp], manual: true };
    return { doc: finish({ ...base, schematic: { ...base.schematic, wires: [...base.schematic.wires, wire] } }), error: null, id };
  }
  const base = { ...doc, schematic: { ...doc.schematic, labels: [...doc.schematic.labels, { ...label, position: snapPt(at.at) }] } };
  return { doc: finish(base), error: null, id };
}

/** Метку у вывода ставим наружу от детали (по направлению вывода), на два шага сетки. */
function labelOffset(doc: ProjectDoc, end: WireEnd): Point & { rotation: Rot } {
  if (end.kind === 'pin') {
    const inst = doc.schematic.instances.find((i) => i.id === end.instanceId);
    const p = pinPosition(doc, end);
    if (inst && p) {
      const dx = p.x - inst.position.x, dy = p.y - inst.position.y;
      if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? { x: 0, y: -GRID * 2, rotation: 0 } : { x: 0, y: GRID * 2, rotation: 180 };
      return dx < 0 ? { x: -GRID * 2, y: 0, rotation: 270 } : { x: GRID * 2, y: 0, rotation: 90 };
    }
  }
  return { x: 0, y: -GRID * 2, rotation: 0 };
}

export function renameLabel(doc: ProjectDoc, id: string, name: string): { doc: ProjectDoc; error: string | null } {
  const n = name.trim();
  if (!n || n.length > 64 || /\s/.test(n)) return { doc, error: 'Имя метки: 1–64 символа без пробелов' };
  const l = doc.schematic.labels.find((x) => x.id === id);
  if (!l || l.name === n) return { doc, error: null };
  const labels = doc.schematic.labels.map((x) => (x.id === id ? { ...x, name: n } : x));
  return { doc: finish({ ...doc, schematic: { ...doc.schematic, labels } }), error: null };
}

// ---------- Выделение: перемещение, поворот, отражение, удаление ----------

export type ItemKind = 'inst' | 'wire' | 'junction' | 'label' | 'note';
export interface ItemRef { kind: ItemKind; id: string }

export function kindOf(doc: ProjectDoc, id: string): ItemKind | null {
  const s = doc.schematic;
  if (s.instances.some((x) => x.id === id)) return 'inst';
  if (s.wires.some((x) => x.id === id)) return 'wire';
  if (s.junctions.some((x) => x.id === id)) return 'junction';
  if (s.labels.some((x) => x.id === id)) return 'label';
  if (s.annotations.some((x) => x.id === id)) return 'note';
  return null;
}

/** Выделение с учётом групп: выбранный член группы тянет за собой всю группу. */
export function expandGroups(doc: ProjectDoc, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  for (const g of doc.schematic.groups) if (g.memberIds.some((m) => out.has(m))) for (const m of g.memberIds) out.add(m);
  return out;
}

/** Сдвинуть выделенное на (dx, dy). Провода между сдвигаемыми вершинами едут целиком, остальные перестраиваются. */
export function moveItems(doc: ProjectDoc, ids: Set<string>, delta: Point): ProjectDoc {
  const dx = snap(delta.x), dy = snap(delta.y);
  if (!dx && !dy) return doc;
  const s = doc.schematic;
  const sh = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  const moved = new Set<string>();
  for (const i of s.instances) if (ids.has(i.id)) for (const k of instPinKeys(doc, i)) moved.add(k);
  for (const j of s.junctions) if (ids.has(j.id)) moved.add(`j:${j.id}`);
  for (const l of s.labels) if (ids.has(l.id)) moved.add(`l:${l.id}`);
  const endMoves = (e: WireEnd, wireSelected: boolean) => { const k = endKey(e); return k ? moved.has(k) : wireSelected; };
  const wholeWires = new Set(s.wires.filter((w) => endMoves(w.a, ids.has(w.id)) && endMoves(w.b, ids.has(w.id)) && (ids.has(w.id) || endKey(w.a) || endKey(w.b))).map((w) => w.id));
  let d: ProjectDoc = {
    ...doc,
    schematic: {
      ...s,
      instances: s.instances.map((i) => (ids.has(i.id) ? { ...i, position: sh(i.position) } : i)),
      junctions: s.junctions.map((j) => (ids.has(j.id) ? { ...j, position: sh(j.position) } : j)),
      labels: s.labels.map((l) => (ids.has(l.id) ? { ...l, position: sh(l.position) } : l)),
      annotations: s.annotations.map((a) => (ids.has(a.id) ? { ...a, position: sh(a.position) } : a)),
      wires: s.wires.map((w) => (wholeWires.has(w.id) ? { ...w, points: w.points.map(sh) } : w)),
    },
  };
  // Провода с одним сдвинутым концом перестраиваются (свободный конец остаётся на месте);
  // целиком сдвинутые провода уже совпадают концами и не меняются.
  d = rerouteWires(d, moved);
  return touch(rebuildNets(d));
}

export function moveInstance(doc: ProjectDoc, id: string, position: Point): ProjectDoc {
  const inst = doc.schematic.instances.find((i) => i.id === id);
  if (!inst) return doc;
  const p = snapPt(position);
  return moveItems(doc, new Set([id]), { x: p.x - inst.position.x, y: p.y - inst.position.y });
}

/** Поворот на 90° по часовой стрелке (детали и метки — каждая вокруг своей точки). */
export function rotateItems(doc: ProjectDoc, ids: Set<string>): ProjectDoc {
  const s = doc.schematic;
  const insts = s.instances.filter((i) => ids.has(i.id));
  const labels = s.labels.filter((l) => ids.has(l.id));
  if (!insts.length && !labels.length) return doc;
  const moved = new Set(insts.flatMap((i) => instPinKeys(doc, i)));
  const d: ProjectDoc = {
    ...doc,
    schematic: {
      ...s,
      instances: s.instances.map((i) => (ids.has(i.id) ? { ...i, rotation: ((i.rotation + 90) % 360) as Rot } : i)),
      labels: s.labels.map((l) => (ids.has(l.id) ? { ...l, rotation: ((l.rotation + 90) % 360) as Rot } : l)),
    },
  };
  return touch(rebuildNets(rerouteWires(d, moved)));
}

export const rotateInstance = (doc: ProjectDoc, id: string) => rotateItems(doc, new Set([id]));

/** Отражение деталей слева направо (меняет местами выводы по горизонтали). */
export function mirrorItems(doc: ProjectDoc, ids: Set<string>): ProjectDoc {
  const insts = doc.schematic.instances.filter((i) => ids.has(i.id));
  if (!insts.length) return doc;
  const moved = new Set(insts.flatMap((i) => instPinKeys(doc, i)));
  const d: ProjectDoc = { ...doc, schematic: { ...doc.schematic, instances: doc.schematic.instances.map((i) => (ids.has(i.id) ? { ...i, mirrored: !i.mirrored } : i)) } };
  return touch(rebuildNets(rerouteWires(d, moved)));
}

/**
 * Удалить выделенное. Провода к удалённым деталям удаляются; провода к удалённым узлам и меткам
 * остаются со свободными концами. Щупы с удалённых деталей снимаются. Плата синхронизируется явно.
 */
export function deleteItems(doc: ProjectDoc, ids: Set<string>): ProjectDoc {
  const s = doc.schematic;
  const goneInst = new Set(s.instances.filter((i) => ids.has(i.id)).map((i) => i.id));
  const goneVert = new Set([...s.junctions.filter((j) => ids.has(j.id)).map((j) => `j:${j.id}`), ...s.labels.filter((l) => ids.has(l.id)).map((l) => `l:${l.id}`)]);
  if (!goneInst.size && !goneVert.size && !s.wires.some((w) => ids.has(w.id)) && !s.annotations.some((a) => ids.has(a.id))) return doc;
  const freeIfGone = (e: WireEnd): WireEnd => { const k = endKey(e); return k && goneVert.has(k) ? { kind: 'free' } : e; };
  const wires = s.wires
    .filter((w) => !ids.has(w.id) && !(w.a.kind === 'pin' && goneInst.has(w.a.instanceId)) && !(w.b.kind === 'pin' && goneInst.has(w.b.instanceId)))
    .map((w) => ({ ...w, a: freeIfGone(w.a), b: freeIfGone(w.b) }));
  let settings = doc.instruments.settings;
  for (const id of goneInst) settings = dropInstrumentPins(settings, id);
  const keepId = (id: string) => !ids.has(id) && !goneInst.has(id);
  const d: ProjectDoc = {
    ...doc,
    schematic: {
      ...s,
      instances: s.instances.filter((i) => !goneInst.has(i.id)),
      junctions: s.junctions.filter((j) => !ids.has(j.id)),
      labels: s.labels.filter((l) => !ids.has(l.id)),
      annotations: s.annotations.filter((a) => !ids.has(a.id)),
      wires,
      groups: s.groups.map((g) => ({ ...g, memberIds: g.memberIds.filter(keepId) })).filter((g) => g.memberIds.length > 1),
    },
    instruments: { ...doc.instruments, settings },
  };
  return finish(d);
}

export const deleteInstance = (doc: ProjectDoc, id: string) => deleteItems(doc, new Set([id]));
export const deleteWire = (doc: ProjectDoc, id: string) => deleteItems(doc, new Set([id]));


/**
 * Уборка графа: узел без проводов удаляется; узел с одним проводом превращается в свободный конец;
 * узел ровно с двумя проводами (не меткой) сливает их в один; провода нулевой длины между одной вершиной удаляются.
 */
export function normalize(doc: ProjectDoc): ProjectDoc {
  let s = doc.schematic;
  let changed = false;
  for (let guard = 0; guard < 10_000; guard++) {
    let step = false;
    const loops = s.wires.filter((w) => { const a = endKey(w.a); return a !== null && a === endKey(w.b); });
    if (loops.length) { s = { ...s, wires: s.wires.filter((w) => !loops.includes(w)) }; step = true; }
    for (const j of s.junctions) {
      const k = `j:${j.id}`;
      const att = s.wires.filter((w) => endKey(w.a) === k || endKey(w.b) === k);
      if (att.length === 0) { s = { ...s, junctions: s.junctions.filter((x) => x.id !== j.id) }; step = true; break; }
      if (att.length === 1) {
        const w = att[0]!;
        const free = { kind: 'free' as const };
        s = { ...s, junctions: s.junctions.filter((x) => x.id !== j.id), wires: s.wires.map((x) => (x.id === w.id ? { ...x, a: endKey(x.a) === k ? free : x.a, b: endKey(x.b) === k ? free : x.b, manual: true } : x)) };
        step = true; break;
      }
      if (att.length === 2 && att[0]!.id !== att[1]!.id) {
        const [w1, w2] = att as [Wire, Wire];
        // w1: ... → J, w2: J → ... (ориентируем)
        const p1 = endKey(w1.b) === k ? w1.points : [...w1.points].reverse();
        const e1 = endKey(w1.b) === k ? w1.a : w1.b;
        const p2 = endKey(w2.a) === k ? w2.points : [...w2.points].reverse();
        const e2 = endKey(w2.a) === k ? w2.b : w2.a;
        const merged: Wire = { id: w1.id, a: e1, b: e2, points: simplify([...p1, ...p2.slice(1)]), manual: true };
        s = { ...s, junctions: s.junctions.filter((x) => x.id !== j.id), wires: s.wires.filter((x) => x.id !== w2.id).map((x) => (x.id === w1.id ? merged : x)) };
        step = true; break;
      }
    }
    if (!step) break;
    changed = true;
  }
  return changed ? { ...doc, schematic: s } : doc;
}

// ---------- Группы ----------

export function groupItems(doc: ProjectDoc, ids: Set<string>, id: string = newId()): ProjectDoc {
  const members = [...ids].filter((x) => kindOf(doc, x));
  if (members.length < 2) return doc;
  const set = new Set(members);
  const groups = doc.schematic.groups.map((g) => ({ ...g, memberIds: g.memberIds.filter((m) => !set.has(m)) })).filter((g) => g.memberIds.length > 1);
  return touch({ ...doc, schematic: { ...doc.schematic, groups: [...groups, { id, memberIds: members }] } });
}

export function ungroupItems(doc: ProjectDoc, ids: Set<string>): ProjectDoc {
  const groups = doc.schematic.groups.filter((g) => !g.memberIds.some((m) => ids.has(m)));
  return groups.length === doc.schematic.groups.length ? doc : touch({ ...doc, schematic: { ...doc.schematic, groups } });
}

// ---------- Буфер обмена ----------

/** Фрагмент схемы для копирования: объекты и определения деталей, нужные для вставки в любой проект. */
export interface Clipboard {
  format: 'electronic-lab-schematic-fragment';
  instances: ComponentInstance[];
  wires: Wire[];
  junctions: Junction[];
  labels: NetLabel[];
  annotations: Annotation[];
  library: ProjectDoc['library'];
}

export function copyItems(doc: ProjectDoc, ids: Set<string>): Clipboard | null {
  const s = doc.schematic;
  const instances = s.instances.filter((i) => ids.has(i.id));
  const junctions = s.junctions.filter((j) => ids.has(j.id));
  const labels = s.labels.filter((l) => ids.has(l.id));
  const annotations = s.annotations.filter((a) => ids.has(a.id));
  const keys = new Set<string>([...instances.flatMap((i) => instPinKeys(doc, i)), ...junctions.map((j) => `j:${j.id}`), ...labels.map((l) => `l:${l.id}`)]);
  // Провод копируется, если оба конца копируются (или свободны и провод выделен).
  const inside = (e: WireEnd, sel: boolean) => { const k = endKey(e); return k ? keys.has(k) : sel; };
  const wires = s.wires.filter((w) => inside(w.a, ids.has(w.id)) && inside(w.b, ids.has(w.id)) && (ids.has(w.id) || endKey(w.a) !== null || endKey(w.b) !== null));
  if (!instances.length && !wires.length && !labels.length && !annotations.length) return null;
  const partIds = new Set(instances.map((i) => i.partId));
  const parts = doc.library.parts.filter((p) => partIds.has(p.id));
  return structuredClone({
    format: 'electronic-lab-schematic-fragment' as const,
    instances, wires, junctions, labels, annotations,
    library: {
      parts,
      symbols: doc.library.symbols.filter((x) => parts.some((p) => p.symbolId === x.id)),
      packages: doc.library.packages.filter((x) => parts.some((p) => p.packages.some((k) => k.packageId === x.id))),
      models: doc.library.models.filter((x) => parts.some((p) => p.modelId === x.id)),
    },
  });
}

/** Вставить фрагмент со сдвигом. Новые UUID; позиционные обозначения — свободные (при занятости — следующие номера). */
export function pasteItems(doc: ProjectDoc, clip: Clipboard, delta: Point, makeId: () => string = newId): { doc: ProjectDoc; ids: string[] } {
  let d = doc;
  const partMap = new Map<string, string>();
  for (const p of clip.library.parts) {
    if (d.library.parts.some((x) => x.id === p.id)) { partMap.set(p.id, p.id); continue; }
    const bundle: PartBundle = {
      part: p,
      symbol: clip.library.symbols.find((x) => x.id === p.symbolId)!,
      packages: clip.library.packages.filter((x) => p.packages.some((k) => k.packageId === x.id)),
      model: p.modelId ? clip.library.models.find((x) => x.id === p.modelId) ?? null : null,
    };
    const e = embedBundle(d, bundle);
    d = e.doc;
    partMap.set(p.id, e.partId);
  }
  const idMap = new Map<string, string>();
  const nid = (old: string) => { const v = idMap.get(old) ?? makeId(); idMap.set(old, v); return v; };
  const sh = (p: Point) => ({ x: p.x + snap(delta.x), y: p.y + snap(delta.y) });
  const taken = new Set<string>();
  const instances = clip.instances.map((i) => {
    const part = d.library.parts.find((p) => p.id === partMap.get(i.partId));
    const prefix = part?.refPrefix ?? i.refDes.replace(/\d+$/, '');
    const free = !d.schematic.instances.some((x) => x.refDes.toUpperCase() === i.refDes.toUpperCase()) && !taken.has(i.refDes.toUpperCase());
    const refDes = free ? i.refDes : nextRefDes(d, prefix, taken);
    taken.add(refDes.toUpperCase());
    return { ...i, id: nid(i.id), partId: partMap.get(i.partId) ?? i.partId, refDes, position: sh(i.position) };
  });
  const mapEnd = (e: WireEnd): WireEnd =>
    e.kind === 'pin' ? { ...e, instanceId: nid(e.instanceId) } : e.kind === 'junction' ? { ...e, junctionId: nid(e.junctionId) } : e.kind === 'label' ? { ...e, labelId: nid(e.labelId) } : e;
  const junctions = clip.junctions.map((j) => ({ ...j, id: nid(j.id), position: sh(j.position) }));
  const labels = clip.labels.map((l) => ({ ...l, id: nid(l.id), position: sh(l.position) }));
  const annotations = clip.annotations.map((a) => ({ ...a, id: nid(a.id), position: sh(a.position), targetId: a.targetId && idMap.has(a.targetId) ? idMap.get(a.targetId)! : null }));
  const wires = clip.wires.map((w) => ({ ...w, id: nid(w.id), a: mapEnd(w.a), b: mapEnd(w.b), points: w.points.map(sh) }));
  d = {
    ...d,
    schematic: {
      ...d.schematic,
      instances: [...d.schematic.instances, ...instances],
      junctions: [...d.schematic.junctions, ...junctions],
      labels: [...d.schematic.labels, ...labels],
      annotations: [...d.schematic.annotations, ...annotations],
      wires: [...d.schematic.wires, ...wires],
    },
  };
  return { doc: finish(d), ids: [...instances, ...junctions, ...labels, ...annotations, ...wires].map((x) => x.id) };
}

// ---------- Попадание мышью ----------

/** Ближайший вывод к точке в пределах радиуса. */
export function hitPin(doc: ProjectDoc, p: Point, radius = 8): PinRef | null {
  let best: { ref: PinRef; d: number } | null = null;
  for (const inst of doc.schematic.instances) {
    for (const pin of symbolOf(doc, inst)?.pins ?? []) {
      const ref = { instanceId: inst.id, pin: pin.number };
      const pos = pinPosition(doc, ref)!;
      const d = Math.hypot(pos.x - p.x, pos.y - p.y);
      if (d <= radius && (!best || d < best.d)) best = { ref, d };
    }
  }
  return best?.ref ?? null;
}

/** Провод под точкой и ближайшая точка сетки на нём. */
export function hitWire(doc: ProjectDoc, p: Point, tol = 5): { wireId: string; at: Point } | null {
  for (const w of [...doc.schematic.wires].reverse()) {
    for (const [a, b] of segsOf(w.points)) {
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      if (a.y === b.y && Math.abs(p.y - a.y) <= tol && p.x >= minX - tol && p.x <= maxX + tol) {
        return { wireId: w.id, at: { x: Math.min(maxX, Math.max(minX, snap(p.x))), y: a.y } };
      }
      if (a.x === b.x && Math.abs(p.x - a.x) <= tol && p.y >= minY - tol && p.y <= maxY + tol) {
        return { wireId: w.id, at: { x: a.x, y: Math.min(maxY, Math.max(minY, snap(p.y))) } };
      }
    }
  }
  return null;
}

/** Вершина (вывод, узел, метка) под точкой. */
export function hitVertex(doc: ProjectDoc, p: Point, radius = 7): Exclude<WireEnd, { kind: 'free' }> | null {
  for (const j of doc.schematic.junctions) if (Math.hypot(j.position.x - p.x, j.position.y - p.y) <= radius) return { kind: 'junction', junctionId: j.id };
  for (const l of doc.schematic.labels) if (Math.hypot(l.position.x - p.x, l.position.y - p.y) <= radius) return { kind: 'label', labelId: l.id };
  const pin = hitPin(doc, p, radius);
  return pin ? (pinEnd(pin) as Extract<WireEnd, { kind: 'pin' }>) : null;
}

/** Объекты, целиком попавшие в прямоугольник выделения. */
export function itemsInRect(doc: ProjectDoc, r: { x0: number; y0: number; x1: number; y1: number }, instBounds: (i: ComponentInstance) => { x: number; y: number; w: number; h: number }): string[] {
  const inR = (p: Point) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  const s = doc.schematic;
  const out: string[] = [];
  for (const i of s.instances) { const b = instBounds(i); if (inR({ x: b.x, y: b.y }) && inR({ x: b.x + b.w, y: b.y + b.h })) out.push(i.id); }
  for (const w of s.wires) if (w.points.every(inR)) out.push(w.id);
  for (const j of s.junctions) if (inR(j.position)) out.push(j.id);
  for (const l of s.labels) if (inR(l.position)) out.push(l.id);
  for (const a of s.annotations) if (inR(a.position)) out.push(a.id);
  return out;
}

/** Габарит детали на полотне (с учётом поворота) по габариту символа. */
export function instanceBox(inst: ComponentInstance, sb: { x: number; y: number; w: number; h: number }) {
  const corners = [{ x: sb.x, y: sb.y }, { x: sb.x + sb.w, y: sb.y }, { x: sb.x, y: sb.y + sb.h }, { x: sb.x + sb.w, y: sb.y + sb.h }]
    .map((c) => rotatePoint(c, inst.rotation, inst.mirrored));
  const xs = corners.map((c) => c.x + inst.position.x), ys = corners.map((c) => c.y + inst.position.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Где на схеме рисовать жирные точки соединения: узлы с тремя и более проводами и выводы с двумя и более. */
export function junctionDots(doc: ProjectDoc): Point[] {
  const g = graphOf(doc);
  const out: Point[] = [];
  for (const j of doc.schematic.junctions) if ((g.degree.get(`j:${j.id}`) ?? 0) >= 3) out.push(j.position);
  for (const [k, n] of g.degree) {
    if (!k.startsWith('p:') || n < 2) continue;
    const [instanceId, pin] = k.slice(2).split('#') as [string, string];
    const pos = pinPosition(doc, { instanceId, pin });
    if (pos) out.push(pos);
  }
  return out;
}

/**
 * Скопировать модель (например, из каталога) в деталь проекта, у которой её нет. Модель получает новый id;
 * остальные сведения детали в проекте не меняются (правка каталога не меняет проект молча).
 */
export function adoptModel(doc: ProjectDoc, partId: string, model: SimModel): ProjectDoc {
  const part = doc.library.parts.find((p) => p.id === partId);
  if (!part || part.modelId) return doc;
  const copy = { ...structuredClone(model), id: newId() };
  return touch({
    ...doc,
    library: {
      ...doc.library,
      models: [...doc.library.models, copy],
      parts: doc.library.parts.map((p) => (p.id === partId ? { ...p, modelId: copy.id } : p)),
    },
  });
}
