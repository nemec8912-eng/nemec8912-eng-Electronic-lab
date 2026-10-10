/**
 * Операции редактирования схемы. Связность — сети (nets): соединение выводов объединяет сети,
 * удаление провода пересчитывает сеть по оставшимся проводам и при необходимости делит её.
 * Провода хранят концы (вывод → вывод) и точки ломаной; при перемещении деталей точки пересчитываются.
 * Все функции чистые: возвращают новый документ или прежний, если ничего не изменилось.
 */
import { touch } from './factory';
import { newId } from './ids';
import { builtinByCatalogId, type BuiltinPart } from './library';
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

function rerouteWires(doc: ProjectDoc, instanceIds: Set<string>): ProjectDoc {
  let changed = false;
  const wires = doc.schematic.wires.map((w) => {
    if (!w.from || !w.to || (!instanceIds.has(w.from.instanceId) && !instanceIds.has(w.to.instanceId))) return w;
    const a = pinPosition(doc, w.from), b = pinPosition(doc, w.to);
    if (!a || !b) return w;
    changed = true;
    return { ...w, points: routeWire(a, b) };
  });
  return changed ? { ...doc, schematic: { ...doc.schematic, wires } } : doc;
}

// ---------- Размещение деталей ----------

/** Копирует определения встроенной детали в библиотеку проекта (один раз) и возвращает id детали проекта. */
function ensurePart(doc: ProjectDoc, b: BuiltinPart): { doc: ProjectDoc; partId: string } {
  const existing = doc.library.parts.find((p) => p.origin.catalogPartId === b.catalogId);
  if (existing) return { doc, partId: existing.id };
  const symbolId = newId();
  const modelId = newId();
  const pkgs = b.packages.map((p) => ({ ...structuredClone(p.pkg), id: newId(), pinMap: p.pinMap }));
  const partId = newId();
  const library = {
    symbols: [...doc.library.symbols, { ...structuredClone(b.symbol), id: symbolId }],
    packages: [...doc.library.packages, ...pkgs.map(({ pinMap: _pm, ...pkg }) => pkg)],
    models: [...doc.library.models, { ...structuredClone(b.model), id: modelId }],
    parts: [...doc.library.parts, {
      ...structuredClone(b.part),
      id: partId,
      symbolId,
      modelId,
      packages: pkgs.map((p) => ({ packageId: p.id, pinMap: structuredClone(p.pinMap) })),
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
  const ensured = ensurePart(doc, b);
  const inst: ComponentInstance = {
    id,
    partId: ensured.partId,
    refDes: nextRefDes(ensured.doc, b.refPrefix),
    position: { x: snap(position.x), y: snap(position.y) },
    rotation: 0,
    mirrored: false,
    values: structuredClone(b.defaults),
  };
  const d = ensured.doc;
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
  const wire: Wire = { id: newId(), netId, from: a, to: b, points: routeWire(pa, pb) };
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
