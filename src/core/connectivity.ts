/**
 * Граф электрической связности схемы (этап 3). Вершины — выводы деталей, узлы и метки цепей; рёбра —
 * провода. Одинаковые имена меток и выводы «земли» объединяют вершины без провода. Сети (nets)
 * документа — производные от графа: rebuildNets пересчитывает их, сохраняя UUID сетей там, где состав
 * выводов совпадает (на эти UUID ссылаются плата и результаты расчёта).
 */
import { newId } from './ids';
import type { Net, PinRef, Point, ProjectDoc, SymbolDef, Wire, WireEnd } from './model';

export const pinKey = (p: PinRef) => `p:${p.instanceId}#${p.pin}`;
export const endKey = (e: WireEnd): string | null =>
  e.kind === 'pin' ? pinKey(e) : e.kind === 'junction' ? `j:${e.junctionId}` : e.kind === 'label' ? `l:${e.labelId}` : null;

export const GROUND_NAME = 'GND';

function symbolOfInst(doc: ProjectDoc, partId: string): SymbolDef | undefined {
  const part = doc.library.parts.find((p) => p.id === partId);
  return part ? doc.library.symbols.find((s) => s.id === part.symbolId) : undefined;
}

/** Выводы деталей-«земли» (модель kind = ground): все они — одна цепь GND, как и в расчёте. */
function groundPinKeys(doc: ProjectDoc): string[] {
  const out: string[] = [];
  for (const inst of doc.schematic.instances) {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    const model = part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
    if (model?.kind !== 'ground') continue;
    for (const pin of symbolOfInst(doc, inst.partId)?.pins ?? []) out.push(pinKey({ instanceId: inst.id, pin: pin.number }));
  }
  return out;
}

interface Component {
  pins: PinRef[];
  labels: string[]; // имена меток (с повторами — для ERC)
  hasGround: boolean;
  hasWireOrLabel: boolean;
  vertices: string[];
}

class UnionFind {
  private parent = new Map<string, string>();
  add(k: string) { if (!this.parent.has(k)) this.parent.set(k, k); }
  find(k: string): string {
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let x = k;
    while (x !== r) { const n = this.parent.get(x)!; this.parent.set(x, r); x = n; }
    return r;
  }
  union(a: string, b: string) { this.add(a); this.add(b); const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
  keys() { return [...this.parent.keys()]; }
}

/** Компоненты связности графа (все вершины, включая выводы без соединений). */
function components(doc: ProjectDoc): Component[] {
  const s = doc.schematic;
  const uf = new UnionFind();
  const pinOrder: PinRef[] = [];
  for (const inst of s.instances) {
    for (const pin of symbolOfInst(doc, inst.partId)?.pins ?? []) {
      const ref = { instanceId: inst.id, pin: pin.number };
      pinOrder.push(ref);
      uf.add(pinKey(ref));
    }
  }
  for (const j of s.junctions) uf.add(`j:${j.id}`);
  for (const l of s.labels) uf.add(`l:${l.id}`);
  const touched = new Set<string>();
  for (const w of s.wires) {
    const a = endKey(w.a), b = endKey(w.b);
    if (a) touched.add(a);
    if (b) touched.add(b);
    if (a && b) uf.union(a, b);
  }
  const byName = new Map<string, string>();
  for (const l of s.labels) {
    const k = `l:${l.id}`;
    const prev = byName.get(l.name);
    if (prev) uf.union(prev, k); else byName.set(l.name, k);
  }
  const ground = groundPinKeys(doc);
  for (const g of ground) {
    const prev = byName.get(GROUND_NAME);
    if (prev) uf.union(prev, g); else byName.set(GROUND_NAME, g);
  }
  const groundSet = new Set(ground);
  const labelName = new Map(s.labels.map((l) => [`l:${l.id}`, l.name]));
  const comps = new Map<string, Component>();
  const get = (root: string) => {
    let c = comps.get(root);
    if (!c) { c = { pins: [], labels: [], hasGround: false, hasWireOrLabel: false, vertices: [] }; comps.set(root, c); }
    return c;
  };
  for (const ref of pinOrder) {
    const k = pinKey(ref);
    const c = get(uf.find(k));
    c.pins.push(ref);
    c.vertices.push(k);
    if (groundSet.has(k)) c.hasGround = true;
    if (touched.has(k)) c.hasWireOrLabel = true;
  }
  for (const k of uf.keys()) {
    if (k.startsWith('p:')) continue;
    const c = get(uf.find(k));
    c.vertices.push(k);
    c.hasWireOrLabel = true;
    const name = labelName.get(k);
    if (name !== undefined) c.labels.push(name);
  }
  return [...comps.values()];
}

/** Имя цепи по графу: метки (сначала питание, затем по алфавиту), иначе GND для «земли», иначе null. */
function nameOf(doc: ProjectDoc, c: Component): string | null {
  if (c.labels.length) {
    const kinds = new Map(doc.schematic.labels.map((l) => [l.name, l.kind]));
    const uniq = [...new Set(c.labels)].sort((a, b) => (kinds.get(a) === 'power' ? 0 : 1) - (kinds.get(b) === 'power' ? 0 : 1) || a.localeCompare(b));
    return uniq[0]!;
  }
  return c.hasGround ? GROUND_NAME : null;
}

/** Есть ли у компоненты сеть: два и больше выводов, или вывод с проводом/меткой. */
const isNet = (c: Component) => c.pins.length >= 2 || (c.pins.length === 1 && c.hasWireOrLabel);

/**
 * Пересчитать сети по графу. UUID сохраняются по наибольшему совпадению выводов со старыми сетями.
 * Возвращает тот же документ, если сети не изменились.
 */
export function rebuildNets(doc: ProjectDoc, makeId: () => string = newId): ProjectDoc {
  const comps = components(doc).filter(isNet);
  const oldOf = new Map<string, string>();
  for (const n of doc.schematic.nets) for (const c of n.connections) oldOf.set(pinKey(c), n.id);
  // Пары (компонента, старая сеть) по числу общих выводов — жадно, от больших совпадений.
  const pairs: Array<{ ci: number; id: string; n: number }> = [];
  comps.forEach((c, ci) => {
    const count = new Map<string, number>();
    for (const p of c.pins) { const o = oldOf.get(pinKey(p)); if (o) count.set(o, (count.get(o) ?? 0) + 1); }
    for (const [id, n] of count) pairs.push({ ci, id, n });
  });
  pairs.sort((a, b) => b.n - a.n);
  const idOf = new Map<number, string>();
  const used = new Set<string>();
  for (const pr of pairs) {
    if (idOf.has(pr.ci) || used.has(pr.id)) continue;
    idOf.set(pr.ci, pr.id);
    used.add(pr.id);
  }
  const oldIndex = new Map(doc.schematic.nets.map((n, i) => [n.id, i]));
  const nets: Net[] = comps.map((c, ci) => ({ id: idOf.get(ci) ?? makeId(), name: nameOf(doc, c), connections: c.pins }));
  nets.sort((a, b) => (oldIndex.get(a.id) ?? Infinity) - (oldIndex.get(b.id) ?? Infinity));
  if (JSON.stringify(nets) === JSON.stringify(doc.schematic.nets)) return doc;
  return { ...doc, schematic: { ...doc.schematic, nets } };
}

/** Расхождения сохранённых сетей с графом (для проверки целостности). */
export function netsMismatch(doc: ProjectDoc): string[] {
  const comps = components(doc).filter(isNet);
  const want = new Map<string, string>(); // pinKey → ключ компоненты
  comps.forEach((c, i) => { for (const p of c.pins) want.set(pinKey(p), String(i)); });
  const out: string[] = [];
  const seenComp = new Map<string, string>();
  for (const n of doc.schematic.nets) {
    const keys = new Set(n.connections.map((c) => want.get(pinKey(c)) ?? '?'));
    if (keys.size !== 1 || keys.has('?')) { out.push(`Сеть ${n.name ?? n.id} не совпадает с соединениями проводов и меток`); continue; }
    const k = [...keys][0]!;
    if (seenComp.has(k)) { out.push(`Сети ${seenComp.get(k)} и ${n.name ?? n.id} соединены проводами или метками, но записаны раздельно`); continue; }
    seenComp.set(k, n.name ?? n.id);
    const comp = comps[Number(k)]!;
    if (comp.pins.length !== n.connections.length) out.push(`Сеть ${n.name ?? n.id}: состав выводов не совпадает с проводами`);
    else if (nameOf(doc, comp) !== n.name) out.push(`Сеть ${n.name ?? n.id}: имя не совпадает с метками («${nameOf(doc, comp) ?? 'без имени'}»)`);
  }
  if (seenComp.size !== comps.length) out.push('Есть соединения проводами, не записанные в сети');
  return out;
}

// ---------- Быстрый доступ: вершина → сеть (кэш по объекту схемы) ----------

export interface Graph {
  /** Ключ вершины (p:/j:/l:) → id сети или null. */
  netOfVertex: Map<string, string | null>;
  /** id провода → id сети или null (провод не подключён ни к одному выводу). */
  netOfWire: Map<string, string | null>;
  /** Число проводов у вершины. */
  degree: Map<string, number>;
  /** Имена меток, встречающиеся по разу (ничего не соединяют меткой). */
  components: Component[];
}

const cache = new WeakMap<object, Graph>();

export function graphOf(doc: ProjectDoc): Graph {
  const hit = cache.get(doc.schematic);
  if (hit && (hit as Graph & { lib?: object }).lib === doc.library) return hit;
  const comps = components(doc);
  const netByPin = new Map<string, string>();
  for (const n of doc.schematic.nets) for (const c of n.connections) netByPin.set(pinKey(c), n.id);
  const netOfVertex = new Map<string, string | null>();
  for (const c of comps) {
    const id = c.pins.map((p) => netByPin.get(pinKey(p))).find(Boolean) ?? null;
    for (const v of c.vertices) netOfVertex.set(v, id);
  }
  const netOfWire = new Map<string, string | null>();
  const degree = new Map<string, number>();
  for (const w of doc.schematic.wires) {
    const a = endKey(w.a), b = endKey(w.b);
    netOfWire.set(w.id, (a && netOfVertex.get(a)) ?? (b && netOfVertex.get(b)) ?? null);
    for (const k of [a, b]) if (k) degree.set(k, (degree.get(k) ?? 0) + 1);
  }
  const g = Object.assign({ netOfVertex, netOfWire, degree, components: comps }, { lib: doc.library });
  cache.set(doc.schematic, g);
  return g;
}

export const wireNetId = (doc: ProjectDoc, w: Wire) => graphOf(doc).netOfWire.get(w.id) ?? null;

/** Подпись цепи для интерфейса: имя или «N(R1.2)» по первому выводу. */
export function netDisplayName(doc: ProjectDoc, net: Net): string {
  if (net.name) return net.name;
  const refs = net.connections.map((c) => {
    const inst = doc.schematic.instances.find((i) => i.id === c.instanceId);
    return inst ? `${inst.refDes}.${c.pin}` : c.pin;
  }).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  return `N(${refs[0] ?? '?'})`;
}

export type { Component as GraphComponent };

/** Точка конца провода на полотне (свободный конец — null: берётся из точек провода). */
export function endPoint(doc: ProjectDoc, e: WireEnd, pinPos: (p: PinRef) => Point | null): Point | null {
  if (e.kind === 'pin') return pinPos(e);
  if (e.kind === 'junction') return doc.schematic.junctions.find((j) => j.id === e.junctionId)?.position ?? null;
  if (e.kind === 'label') return doc.schematic.labels.find((l) => l.id === e.labelId)?.position ?? null;
  return null;
}
