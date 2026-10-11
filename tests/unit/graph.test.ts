/** Этап 3: граф связности — ветвления, пересечения, узлы, метки, группы, копирование, перемещение. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { graphOf, netDisplayName, wireNetId } from '../../src/core/connectivity';
import { checkIntegrity } from '../../src/core/integrity';
import { loadDocument } from '../../src/core/migrations';
import { remapIds } from '../../src/core/remap';
import {
  addLabel, copyItems, deleteItems, drawWire, expandGroups, groupItems, hitWire, junctionDots, mirrorItems, moveItems, netOfPin,
  pasteItems, pinEnd, pinPosition, renameLabel, renumber, rotateItems, ungroupItems,
} from '../../src/core/schematic';
import type { ProjectDoc, WireEnd } from '../../src/core/model';
import { Builder, p } from '../sim-helpers';

const pe = (inst: string, pin: string) => ({ kind: 'end' as const, end: pinEnd(p(inst, pin)) as Extract<WireEnd, { kind: 'pin' }> });
const ok = (doc: ProjectDoc) => {
  assert.deepEqual(checkIntegrity(doc), []);
  const r = loadDocument(JSON.parse(JSON.stringify(doc)));
  assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
};
const sameNet = (doc: ProjectDoc, a: [string, string], b: [string, string]) => {
  const na = netOfPin(doc, p(...a)), nb = netOfPin(doc, p(...b));
  return !!na && na.id === nb?.id;
};

/** Три резистора в ряд: R1 (0,0), R2 (200,0), R3 (100,150). */
function three() {
  const b = new Builder();
  const r1 = b.place('R', 0, 0), r2 = b.place('R', 200, 0), r3 = b.place('R', 100, 150);
  return { b, r1, r2, r3 };
}

describe('Граф связности', () => {
  test('ветвление: провод от середины другого провода создаёт узел, точку и одну цепь', () => {
    const { b, r1, r2, r3 } = three();
    let d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc; // горизонталь y=0 от x=30 до x=170
    const w = d.schematic.wires[0]!;
    const hit = hitWire(d, { x: 101, y: 2 })!;
    assert.equal(hit.wireId, w.id);
    assert.deepEqual(hit.at, { x: 100, y: 0 });
    const r = drawWire(d, { kind: 'wire', wireId: w.id, at: hit.at }, [], pe(r3, '1'));
    assert.equal(r.error, null);
    d = r.doc;
    assert.equal(d.schematic.junctions.length, 1);
    assert.equal(d.schematic.wires.length, 3, 'провод разделён узлом');
    assert.ok(sameNet(d, [r1, '2'], [r3, '1']) && sameNet(d, [r2, '1'], [r3, '1']));
    assert.deepEqual(junctionDots(d), [{ x: 100, y: 0 }], 'точка соединения — в узле с тремя проводами');
    ok(d);
    // Удаление ответвления: узел с двумя проводами сливается обратно в один провод
    const branch = d.schematic.wires.find((x) => x.b.kind === 'pin' && x.b.instanceId === r3)!;
    const back = deleteItems(d, new Set([branch.id]));
    assert.equal(back.schematic.junctions.length, 0);
    assert.equal(back.schematic.wires.length, 1);
    assert.ok(sameNet(back, [r1, '2'], [r2, '1']));
    assert.equal(netOfPin(back, p(r3, '1')), undefined);
    ok(back);
  });

  test('пересечение проводов без узла не соединяет цепи', () => {
    const b = new Builder();
    const a1 = b.place('R', 0, 100), a2 = b.place('R', 300, 100), c1 = b.place('R', 150, 0), c2 = b.place('R', 150, 300);
    b.doc = drawWire(b.doc, pe(a1, '2'), [], pe(a2, '1')).doc; // горизонталь y=100
    b.doc = drawWire(b.doc, pe(c1, '2'), [{ x: 180, y: 50 }, { x: 160, y: 50 }, { x: 160, y: 250 }], pe(c2, '1')).doc; // пересекает y=100 при x=160
    assert.equal(b.doc.schematic.nets.length, 2);
    assert.ok(!sameNet(b.doc, [a1, '2'], [c1, '2']));
    assert.deepEqual(junctionDots(b.doc), []);
    ok(b.doc);
  });

  test('метки с одинаковым именем — одна цепь; переименование метки разделяет', () => {
    const { b, r1, r2 } = three();
    let d = addLabel(b.doc, 'SIG', 'net', pe(r1, '2')).doc;
    d = addLabel(d, 'SIG', 'net', pe(r2, '1')).doc;
    assert.ok(sameNet(d, [r1, '2'], [r2, '1']));
    const net = netOfPin(d, p(r1, '2'))!;
    assert.equal(net.name, 'SIG');
    ok(d);
    const l2 = d.schematic.labels[1]!;
    const split = renameLabel(d, l2.id, 'OTHER').doc;
    assert.ok(!sameNet(split, [r1, '2'], [r2, '1']));
    assert.equal(netOfPin(split, p(r1, '2'))!.id, net.id, 'UUID сети сохранён');
    assert.equal(netOfPin(split, p(r2, '1'))!.name, 'OTHER');
    ok(split);
    assert.match(renameLabel(d, l2.id, 'с пробелом').error ?? '', /без пробелов/);
  });

  test('метка на проводе делит его; удаление метки оставляет провода со свободными концами', () => {
    const { b, r1, r2 } = three();
    let d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc;
    const w = d.schematic.wires[0]!;
    d = addLabel(d, 'MID', 'net', { kind: 'wire', wireId: w.id, at: { x: 100, y: 0 } }).doc;
    assert.equal(d.schematic.wires.length, 2);
    assert.equal(netOfPin(d, p(r1, '2'))!.name, 'MID');
    ok(d);
    const gone = deleteItems(d, new Set([d.schematic.labels[0]!.id]));
    assert.ok(gone.schematic.wires.every((x) => x.a.kind === 'free' || x.b.kind === 'free'));
    assert.ok(!sameNet(gone, [r1, '2'], [r2, '1']), 'без метки провода больше не соединены');
    ok(gone);
  });

  test('метка питания и «земля»: GND без провода объединяет все выводы земли', () => {
    const b = new Builder();
    const v = b.place('V', 0, 0), g1 = b.place('GND', 0, 100), r = b.place('R', 200, 0), g2 = b.place('GND', 200, 100);
    b.wire(p(v, '-'), p(g1, '1'));
    b.wire(p(r, '2'), p(g2, '1'));
    assert.ok(sameNet(b.doc, [v, '-'], [r, '2']), 'две «земли» — одна цепь GND');
    assert.equal(netOfPin(b.doc, p(v, '-'))!.name, 'GND');
    let d = addLabel(b.doc, '+5V', 'power', pe(v, '+')).doc;
    d = addLabel(d, '+5V', 'power', pe(r, '1')).doc;
    assert.ok(sameNet(d, [v, '+'], [r, '1']));
    assert.equal(netOfPin(d, p(v, '+'))!.name, '+5V');
    ok(d);
  });

  test('перемещение и поворот группы не теряют соединений; провод между выделенными едет целиком', () => {
    const { b, r1, r2, r3 } = three();
    let d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc;
    d = drawWire(d, pe(r2, '2'), [], pe(r3, '2')).doc;
    const nets = JSON.stringify(d.schematic.nets);
    const inner = d.schematic.wires[0]!;
    const moved = moveItems(d, new Set([r1, r2, inner.id]), { x: 40, y: 20 });
    assert.equal(JSON.stringify(moved.schematic.nets), nets, 'сети не изменились');
    assert.deepEqual(moved.schematic.wires[0]!.points, inner.points.map((q) => ({ x: q.x + 40, y: q.y + 20 })));
    for (const w of moved.schematic.wires) {
      if (w.a.kind === 'pin') assert.deepEqual(w.points[0], pinPosition(moved, w.a));
      if (w.b.kind === 'pin') assert.deepEqual(w.points.at(-1), pinPosition(moved, w.b));
    }
    ok(moved);
    const rot = rotateItems(moved, new Set([r3]));
    const mir = mirrorItems(rot, new Set([r3]));
    assert.equal(mir.schematic.instances.find((i) => i.id === r3)!.mirrored, true);
    for (const w of mir.schematic.wires) if (w.b.kind === 'pin') assert.deepEqual(w.points.at(-1), pinPosition(mir, w.b));
    assert.equal(JSON.stringify(mir.schematic.nets), nets);
    ok(mir);
  });

  test('копирование и вставка: новые UUID, свободные обозначения, внутренние провода сохранены', () => {
    const { b, r1, r2 } = three();
    let d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc;
    d = addLabel(d, 'X', 'net', pe(r1, '1')).doc;
    const ids = new Set([r1, r2, ...d.schematic.wires.map((w) => w.id), d.schematic.labels[0]!.id]);
    const clip = copyItems(d, ids)!;
    assert.equal(clip.instances.length, 2);
    const r = pasteItems(d, clip, { x: 0, y: 300 });
    const refs = r.doc.schematic.instances.map((i) => i.refDes);
    assert.deepEqual(refs, ['R1', 'R2', 'R3', 'R4', 'R5']);
    assert.equal(r.doc.schematic.wires.length, 4);
    const [n1, n2] = r.ids.filter((id) => r.doc.schematic.instances.some((i) => i.id === id));
    assert.ok(sameNet(r.doc, [n1!, '2'], [n2!, '1']), 'внутренний провод копии соединяет копии');
    assert.ok(!sameNet(r.doc, [r1, '2'], [n1!, '2']), 'копия не соединена с оригиналом проводом…');
    assert.ok(sameNet(r.doc, [r1, '1'], [n1!, '1']), '…но одинаковые метки «X» соединяют их — это честно показывается');
    ok(r.doc);
    // Вставка в другой проект — определения деталей переносятся
    const other = new Builder('Другой');
    const r2doc = pasteItems(other.doc, clip, { x: 0, y: 0 });
    assert.equal(r2doc.doc.library.parts.length, 1);
    ok(r2doc.doc);
  });

  test('группы: участник тянет группу; разгруппировка; удаление участника', () => {
    const { b, r1, r2, r3 } = three();
    let d = groupItems(b.doc, new Set([r1, r2]));
    assert.deepEqual([...expandGroups(d, [r1])].sort(), [r1, r2].sort());
    ok(d);
    d = groupItems(d, new Set([r2, r3]));
    assert.equal(d.schematic.groups.length, 1, 'объект не может быть в двух группах: старая группа распалась');
    ok(d);
    d = ungroupItems(d, new Set([r3]));
    assert.equal(d.schematic.groups.length, 0);
  });

  test('автонумерация: по строкам сверху вниз, слева направо; таблица изменений', () => {
    const b = new Builder();
    const a = b.place('R', 300, 0), c = b.place('R', 0, 0), e = b.place('R', 100, 200);
    const r = renumber(b.doc);
    const ref = (id: string) => r.doc.schematic.instances.find((i) => i.id === id)!.refDes;
    assert.deepEqual([ref(c), ref(a), ref(e)], ['R1', 'R2', 'R3']);
    assert.deepEqual(r.changes, [{ from: 'R1', to: 'R2' }, { from: 'R2', to: 'R1' }]);
    ok(r.doc);
  });

  test('переназначение UUID сохраняет граф (узлы, метки, группы)', () => {
    const { b, r1, r2, r3 } = three();
    let d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc;
    d = drawWire(d, { kind: 'wire', wireId: d.schematic.wires[0]!.id, at: { x: 100, y: 0 } }, [], pe(r3, '1')).doc;
    d = addLabel(d, 'A', 'net', pe(r3, '2')).doc;
    d = groupItems(d, new Set([r1, r2]));
    const copy = remapIds(d).doc;
    ok(copy);
    assert.equal(copy.schematic.groups[0]!.memberIds.every((m) => copy.schematic.instances.some((i) => i.id === m)), true);
    assert.equal(copy.schematic.nets.length, d.schematic.nets.length);
  });

  test('целостность: сети, расходящиеся с проводами, и висячие концы провода обнаруживаются', () => {
    const { b, r1, r2 } = three();
    const d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc;
    const broken = { ...d, schematic: { ...d.schematic, nets: [] } };
    assert.ok(checkIntegrity(broken).some((i) => i.code === 'nets-mismatch'));
    const dangling = { ...d, schematic: { ...d.schematic, wires: d.schematic.wires.map((w) => ({ ...w, b: { kind: 'junction' as const, junctionId: w.id } })) } };
    assert.ok(checkIntegrity(dangling).some((i) => i.code === 'dangling-ref'));
  });

  test('имя цепи без метки — по первому выводу; провод знает свою цепь', () => {
    const { b, r1, r2 } = three();
    const d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc;
    const net = d.schematic.nets[0]!;
    assert.equal(netDisplayName(d, net), 'N(R1.2)');
    assert.equal(wireNetId(d, d.schematic.wires[0]!), net.id);
    assert.equal(graphOf(d).degree.get(`p:${r1}#2`), 1);
  });

  test('провод со свободным концом и продолжение от него', () => {
    const { b, r1, r2 } = three();
    let r = drawWire(b.doc, pe(r1, '2'), [{ x: 100, y: 0 }], { kind: 'free', at: { x: 100, y: 60 } });
    assert.equal(r.error, null);
    let d = r.doc;
    assert.equal(d.schematic.nets.length, 1, 'вывод с проводом — цепь из одного вывода');
    r = drawWire(d, { kind: 'wire', wireId: d.schematic.wires[0]!.id, at: { x: 100, y: 60 } }, [], pe(r2, '1'));
    d = r.doc;
    assert.ok(sameNet(d, [r1, '2'], [r2, '1']));
    ok(d);
  });
});
