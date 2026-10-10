/**
 * Операции редактирования схемы. Связность — сети (nets): соединение выводов объединяет сети,
 * удаление провода пересчитывает сеть по оставшимся проводам и при необходимости делит её.
 * Провода хранят концы (вывод → вывод) и точки ломаной; при перемещении деталей точки пересчитываются.
 * Все функции чистые: возвращают новый документ или прежний, если ничего не изменилось.
 */
import { touch } from './factory';
import { newId } from './ids';
import { builtinBundle, type PartBundle } from './catalog';
import { builtinByCatalogId } from './library';
import type { ComponentInstance, Net, PinRef, Point, ProjectDoc, Quantity, SymbolDef, Wire } from './model';

export const GRID = 10;
export const snap = (v: number) => Math.round(v / GRID) * GRID;
export const samePin = (a: PinRef, b: PinRef) => a.instanceId === b.instanceId && a.pin === b.pin;
const pinKey = (p: PinRef) => `${p.instanceId}#${p.pin}`;

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

/** Точка вывода на полотне с учётом положения и поворота детали. */
export function pinPosition(doc: ProjectDoc, ref: PinRef): Point | null {
  const inst = doc.schematic.instances.find((i) => i.id === ref.instanceId);
  if (!inst) return null;
  const pin = symbolOf(doc, inst)?.pins.find((p) => p.number === ref.pin);
  if (!pin) return null;
  const r = rotatePoint({ x: pin.x, y: pin.y }, inst.rotation, inst.mirrored);
  return { x: inst.position.x + r.x, y: inst.position.y + r.y };
}

/** Ломаная из двух отрезков (горизонталь, затем вертикаль). */
export function routeWire(a: Point, b: Point): Point[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  return [a, { x: b.x, y: a.y }, b];
}

type Seg = [Point, Point];

const segsOf = (pts: Point[]): Seg[] => pts.slice(1).map((q, i) => [pts[i]!, q] as Seg);

/** Отрезки лежат на одной прямой и перекрываются на участке ненулевой длины. */
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

/** Точка лежит на отрезке (оси параллельны сетке). */
function onSeg(p: Point, [a, b]: Seg): boolean {
  if (a.x === b.x) return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  if (a.y === b.y) return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  return false;
}

/**
 * Трассировка провода так, чтобы он не ложился на провода других цепей и не проходил через выводы
 * других цепей (иначе на рисунке это выглядит как соединение). Перебираются Г- и П-образные варианты.
 */
export function routeAvoiding(doc: ProjectDoc, a: Point, b: Point, netId: string | null, skipWireId?: string): Point[] {
  const foreign: Seg[] = doc.schematic.wires.filter((w) => w.id !== skipWireId && w.netId !== netId).flatMap((w) => segsOf(w.points));
  const foreignPins: Point[] = [];
  for (const inst of doc.schematic.instances) for (const pin of symbolOf(doc, inst)?.pins ?? []) {
    const ref = { instanceId: inst.id, pin: pin.number };
    const n = netOfPin(doc, ref);
    if (netId !== null && n?.id === netId) continue;
    const pos = pinPosition(doc, ref)!;
    if ((pos.x === a.x && pos.y === a.y) || (pos.x === b.x && pos.y === b.y)) continue;
    foreignPins.push(pos);
  }
  const ok = (pts: Point[]) => segsOf(pts).every((sg) => !foreign.some((f) => overlapCollinear(sg, f)) && !foreignPins.some((fp) => onSeg(fp, sg)));
  const dedupe = (pts: Point[]) => pts.filter((q, i) => i === 0 || q.x !== pts[i - 1]!.x || q.y !== pts[i - 1]!.y);
  const candidates: Point[][] = [routeWire(a, b), [a, { x: a.x, y: b.y }, b]];
  for (const off of [GRID * 2, -GRID * 2, GRID * 4, -GRID * 4, GRID * 6, -GRID * 6]) {
    const mx = snap((a.x + b.x) / 2) + off, my = snap((a.y + b.y) / 2) + off;
    candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
    candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
    candidates.push([a, { x: a.x + off, y: a.y }, { x: a.x + off, y: b.y }, b]);
    candidates.push([a, { x: a.x, y: a.y + off }, { x: b.x, y: a.y + off }, b]);
  }
  for (const c of candidates) { const d = dedupe(c); if (ok(d)) return d; }
  return routeWire(a, b);
}

function rerouteWires(doc: ProjectDoc, instanceIds: Set<string>): ProjectDoc {
  let changed = false;
  let d = doc;
  for (const w of doc.schematic.wires) {
    if (!w.from || !w.to || (!instanceIds.has(w.from.instanceId) && !instanceIds.has(w.to.instanceId))) continue;
    const a = pinPosition(d, w.from), b = pinPosition(d, w.to);
    if (!a || !b) continue;
    changed = true;
    const points = routeAvoiding(d, a, b, w.netId, w.id);
    d = { ...d, schematic: { ...d.schematic, wires: d.schematic.wires.map((x) => (x.id === w.id ? { ...x, points } : x)) } };
  }
  return changed ? d : doc;
}

// ---------- Размещение деталей ----------

/**
 * Встраивает комплект детали каталога в библиотеку проекта (один раз на деталь каталога) и возвращает
 * id детали проекта. Копия получает новые id; связь с каталогом — origin.catalogPartId. Если деталь уже
 * встроена, используется копия проекта: правка каталога не меняет проект молча.
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
      id: partId,
      symbolId,
      modelId,
      packages: b.part.packages.filter((p) => pkgIds.has(p.packageId)).map((p) => ({ packageId: pkgIds.get(p.packageId)!, pinMap: structuredClone(p.pinMap) })),
      origin: { ...b.part.origin, catalogPartId },
    }],
  };
  return { doc: { ...doc, library }, partId };
}

export function nextRefDes(doc: ProjectDoc, prefix: string): string {
  const used = new Set(doc.schematic.instances.map((i) => i.refDes));
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
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
    id,
    partId: embedded.partId,
    refDes: nextRefDes(d, part.refPrefix),
    position: { x: snap(position.x), y: snap(position.y) },
    rotation: 0,
    mirrored: false,
    values: structuredClone(part.values),
  };
  return { doc: touch({ ...d, schematic: { ...d.schematic, instances: [...d.schematic.instances, inst] } }), id };
}

export function moveInstance(doc: ProjectDoc, id: string, position: Point): ProjectDoc {
  const p = { x: snap(position.x), y: snap(position.y) };
  const inst = doc.schematic.instances.find((i) => i.id === id);
  if (!inst || (inst.position.x === p.x && inst.position.y === p.y)) return doc;
  const instances = doc.schematic.instances.map((i) => (i.id === id ? { ...i, position: p } : i));
  return touch(rerouteWires({ ...doc, schematic: { ...doc.schematic, instances } }, new Set([id])));
}

export function rotateInstance(doc: ProjectDoc, id: string): ProjectDoc {
  const inst = doc.schematic.instances.find((i) => i.id === id);
  if (!inst) return doc;
  const rotation = ((inst.rotation + 90) % 360) as ComponentInstance['rotation'];
  const instances = doc.schematic.instances.map((i) => (i.id === id ? { ...i, rotation } : i));
  return touch(rerouteWires({ ...doc, schematic: { ...doc.schematic, instances } }, new Set([id])));
}

export function setValue(doc: ProjectDoc, id: string, key: string, q: Quantity): ProjectDoc {
  const inst = doc.schematic.instances.find((i) => i.id === id);
  if (!inst) return doc;
  const cur = inst.values[key];
  if (cur && cur.value === q.value && cur.unit === q.unit) return doc;
  const instances = doc.schematic.instances.map((i) => (i.id === id ? { ...i, values: { ...i.values, [key]: q } } : i));
  return touch({ ...doc, schematic: { ...doc.schematic, instances } });
}

export function renameRefDes(doc: ProjectDoc, id: string, refDes: string): { doc: ProjectDoc; error: string | null } {
  const r = refDes.trim();
  if (!/^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_]{0,31}$/.test(r)) return { doc, error: 'Обозначение: буква, затем буквы, цифры или «_» (до 32 символов)' };
  if (doc.schematic.instances.some((i) => i.id !== id && i.refDes.toUpperCase() === r.toUpperCase())) return { doc, error: `Обозначение ${r} уже занято` };
  const inst = doc.schematic.instances.find((i) => i.id === id);
  if (!inst || inst.refDes === r) return { doc, error: null };
  const instances = doc.schematic.instances.map((i) => (i.id === id ? { ...i, refDes: r } : i));
  return { doc: touch({ ...doc, schematic: { ...doc.schematic, instances } }), error: null };
}

/** Удаление детали вместе с её проводами; сети пересчитываются; размещения на плате не трогаются (синхронизация — явная). */
export function deleteInstance(doc: ProjectDoc, id: string): ProjectDoc {
  if (!doc.schematic.instances.some((i) => i.id === id)) return doc;
  let d: ProjectDoc = doc;
  for (const w of doc.schematic.wires) {
    if (w.from?.instanceId === id || w.to?.instanceId === id) d = removeWireRaw(d, w.id);
  }
  // Выводы детали, оставшиеся в сетях без проводов (например, из v1), тоже убираются.
  const nets = d.schematic.nets
    .map((n) => ({ ...n, connections: n.connections.filter((c) => c.instanceId !== id) }))
    .filter((n) => n.connections.length > 0 || d.schematic.wires.some((w) => w.netId === n.id));
  const instances = d.schematic.instances.filter((i) => i.id !== id);
  const settings = dropProbesOf(d.instruments.settings, id);
  return touch({ ...d, schematic: { ...d.schematic, instances, nets }, instruments: { ...d.instruments, settings } });
}

function dropProbesOf(settings: Record<string, unknown>, instanceId: string): Record<string, unknown> {
  const mm = settings.multimeter as { red?: PinRef | null; black?: PinRef | null } | undefined;
  if (!mm) return settings;
  return {
    ...settings,
    multimeter: {
      ...mm,
      red: mm.red?.instanceId === instanceId ? null : mm.red ?? null,
      black: mm.black?.instanceId === instanceId ? null : mm.black ?? null,
    },
  };
}

// ---------- Соединения ----------

export function netOfPin(doc: ProjectDoc, p: PinRef): Net | undefined {
  return doc.schematic.nets.find((n) => n.connections.some((c) => samePin(c, p)));
}

/** Соединить два вывода проводом. Сети объединяются; первая по порядку сохраняет id и имя. */
export function connectPins(doc: ProjectDoc, a: PinRef, b: PinRef): { doc: ProjectDoc; error: string | null } {
  if (samePin(a, b)) return { doc, error: null };
  const pa = pinPosition(doc, a), pb = pinPosition(doc, b);
  if (!pa || !pb) return { doc, error: 'Вывод не найден' };
  if (doc.schematic.wires.some((w) => w.from && w.to && ((samePin(w.from, a) && samePin(w.to, b)) || (samePin(w.from, b) && samePin(w.to, a))))) {
    return { doc, error: 'Эти выводы уже соединены' };
  }
  const na = netOfPin(doc, a), nb = netOfPin(doc, b);
  let nets = [...doc.schematic.nets];
  let wires = [...doc.schematic.wires];
  let netId: string;
  if (na && nb && na.id !== nb.id) {
    // объединение: всё из nb переходит в na
    netId = na.id;
    nets = nets.filter((n) => n.id !== nb.id).map((n) => (n.id === na.id ? { ...n, name: n.name ?? nb.name, connections: [...n.connections, ...nb.connections] } : n));
    wires = wires.map((w) => (w.netId === nb.id ? { ...w, netId: na.id } : w));
  } else if (na || nb) {
    const n = (na ?? nb)!;
    netId = n.id;
    const add = na ? b : a;
    nets = nets.map((x) => (x.id === n.id && !x.connections.some((c) => samePin(c, add)) ? { ...x, connections: [...x.connections, add] } : x));
  } else {
    netId = newId();
    nets.push({ id: netId, name: null, connections: [a, b] });
  }
  const merged = { ...doc, schematic: { ...doc.schematic, nets, wires } };
  const wire: Wire = { id: newId(), netId, from: a, to: b, points: routeAvoiding(merged, pa, pb, netId) };
  wires.push(wire);
  const d = { ...doc, schematic: { ...doc.schematic, nets, wires } };
  return { doc: touch(withGroundNames(d)), error: null };
}

/** Удаление провода без отметки ревизии (используется и при удалении деталей). */
function removeWireRaw(doc: ProjectDoc, wireId: string): ProjectDoc {
  const wire = doc.schematic.wires.find((w) => w.id === wireId);
  if (!wire) return doc;
  const wires = doc.schematic.wires.filter((w) => w.id !== wireId);
  const net = doc.schematic.nets.find((n) => n.id === wire.netId);
  if (!net) return { ...doc, schematic: { ...doc.schematic, wires } };
  // Компоненты связности сети по оставшимся проводам этой сети.
  const netWires = wires.filter((w) => w.netId === net.id && w.from && w.to);
  const parent = new Map<string, string>();
  const find = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const r = find(p); parent.set(k, r); return r; };
  const union = (x: string, y: string) => { parent.set(find(x), find(y)); };
  for (const c of net.connections) parent.set(pinKey(c), pinKey(c));
  const covered = new Set<string>();
  for (const w of netWires) { union(pinKey(w.from!), pinKey(w.to!)); covered.add(pinKey(w.from!)); covered.add(pinKey(w.to!)); }
  // Выводы, к которым не идёт ни один провод этой сети, из сети выходят — но только те, что были
  // концами удалённого провода (соединения из v1 без проводов не трогаем).
  const endKeys = new Set([wire.from, wire.to].filter(Boolean).map((p) => pinKey(p!)));
  const keep = net.connections.filter((c) => covered.has(pinKey(c)) || !endKeys.has(pinKey(c)));
  const groups = new Map<string, PinRef[]>();
  for (const c of keep) {
    const root = find(pinKey(c));
    groups.set(root, [...(groups.get(root) ?? []), c]);
  }
  const parts = [...groups.values()].filter((g) => g.length >= 1);
  const otherNets = doc.schematic.nets.filter((n) => n.id !== net.id);
  if (parts.length === 0) {
    return { ...doc, schematic: { ...doc.schematic, wires, nets: otherNets } };
  }
  // Самая большая часть сохраняет id и имя сети; остальные — новые сети.
  parts.sort((x, y) => y.length - x.length);
  const newNets: Net[] = parts.map((g, i) => (i === 0 ? { ...net, connections: g } : { id: newId(), name: null, connections: g }));
  const ownerOf = new Map<string, string>();
  for (const n of newNets) for (const c of n.connections) ownerOf.set(pinKey(c), n.id);
  const rewired = wires.map((w) => (w.netId === net.id && w.from ? { ...w, netId: ownerOf.get(pinKey(w.from)) ?? w.netId } : w));
  // Одиночный вывод без проводов — не сеть.
  const finalNets = newNets.filter((n) => n.connections.length > 1 || rewired.some((w) => w.netId === n.id));
  return withGroundNames({ ...doc, schematic: { ...doc.schematic, wires: rewired, nets: [...otherNets, ...finalNets] } });
}

export function deleteWire(doc: ProjectDoc, wireId: string): ProjectDoc {
  const d = removeWireRaw(doc, wireId);
  return d === doc ? doc : touch(d);
}

/** Сети, к которым подключена «земля», получают имя GND (если имени не было). */
function withGroundNames(doc: ProjectDoc): ProjectDoc {
  const groundPins = new Set<string>();
  for (const inst of doc.schematic.instances) {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    const model = part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
    if (model?.kind === 'ground') for (const pin of symbolOf(doc, inst)?.pins ?? []) groundPins.add(`${inst.id}#${pin.number}`);
  }
  const nets = doc.schematic.nets.map((n) => (n.name === null && n.connections.some((c) => groundPins.has(pinKey(c))) ? { ...n, name: 'GND' } : n));
  return { ...doc, schematic: { ...doc.schematic, nets } };
}

/** Ближайший вывод к точке в пределах радиуса (для щелчков мышью). */
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
