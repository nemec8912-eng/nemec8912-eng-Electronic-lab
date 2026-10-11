import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkIntegrity } from '../../src/core/integrity';
import { formatQuantity, parseQuantity } from '../../src/core/library';
import { loadDocument } from '../../src/core/migrations';
import { remapIds } from '../../src/core/remap';
import { connectPins, deleteInstance, deleteWire, hitPin, moveInstance, netOfPin, pinPosition, renameRefDes, rotateInstance } from '../../src/core/schematic';
import { buildNetlist, spiceNumber } from '../../src/sim/netlist';
import { Builder, p, pinOf, rcCircuit, touches } from '../sim-helpers';
import { wireNetId } from '../../src/core/connectivity';

const TRAN = { stopS: 0.005, stepS: 1e-5, startFromZero: true };

describe('Редактор схемы: операции', () => {
  test('RC-цепь: детали, позиционные обозначения, сети (GND названа), целостность', () => {
    const { doc, v, r, c, g } = rcCircuit();
    assert.deepEqual(doc.schematic.instances.map((i) => i.refDes), ['V1', 'R1', 'C1', 'GND1']);
    assert.equal(doc.library.parts.length, 4, 'каждая встроенная деталь копируется в проект один раз');
    assert.equal(doc.schematic.nets.length, 3);
    assert.equal(netOfPin(doc, p(g, '1'))!.name, 'GND');
    assert.equal(netOfPin(doc, p(v, '-'))!.id, netOfPin(doc, p(c, '2'))!.id);
    assert.equal(netOfPin(doc, p(v, '+'))!.id, netOfPin(doc, p(r, '1'))!.id);
    assert.deepEqual(checkIntegrity(doc), []);
    assert.ok(loadDocument(doc).ok);
  });

  test('объединение сетей при соединении выводов разных сетей', () => {
    const b = new Builder();
    const r1 = b.place('R', 0, 0), r2 = b.place('R', 100, 0), r3 = b.place('R', 200, 0);
    b.wire(p(r1, '2'), p(r2, '1'));
    b.wire(p(r3, '1'), p(r3, '2'));
    assert.equal(b.doc.schematic.nets.length, 2);
    b.wire(p(r2, '1'), p(r3, '1'));
    assert.equal(b.doc.schematic.nets.length, 1);
    assert.equal(b.doc.schematic.nets[0]!.connections.length, 4);
    assert.ok(b.doc.schematic.wires.every((w) => wireNetId(b.doc, w) === b.doc.schematic.nets[0]!.id));
    assert.deepEqual(checkIntegrity(b.doc), []);
  });

  test('повторное соединение тех же выводов отклоняется', () => {
    const b = new Builder();
    const r1 = b.place('R', 0, 0), r2 = b.place('R', 100, 0);
    b.wire(p(r1, '2'), p(r2, '1'));
    assert.match(connectPins(b.doc, p(r2, '1'), p(r1, '2')).error ?? '', /уже соединены/);
  });

  test('удаление провода делит сеть по оставшимся проводам', () => {
    const b = new Builder();
    const r1 = b.place('R', 0, 0), r2 = b.place('R', 100, 0), r3 = b.place('R', 200, 0);
    b.wire(p(r1, '2'), p(r2, '1'));
    b.wire(p(r2, '1'), p(r3, '1'));
    b.wire(p(r3, '1'), p(r3, '2'));
    const middle = b.doc.schematic.wires[1]!;
    const d = deleteWire(b.doc, middle.id);
    assert.equal(d.schematic.nets.length, 2);
    assert.ok(netOfPin(d, p(r1, '2')) && netOfPin(d, p(r2, '1')));
    assert.notEqual(netOfPin(d, p(r1, '2'))!.id, netOfPin(d, p(r3, '1'))!.id);
    assert.deepEqual(checkIntegrity(d), []);
    // последний провод сети — сеть исчезает
    const d2 = deleteWire(d, d.schematic.wires.find((w) => touches(w, r1))!.id);
    assert.equal(netOfPin(d2, p(r1, '2')), undefined);
  });

  test('перемещение и поворот: выводы и провода следуют за деталью', () => {
    const { doc, r } = rcCircuit();
    const before = pinPosition(doc, p(r, '1'))!;
    const moved = moveInstance(doc, r, { x: 140, y: 80 });
    const after = pinPosition(moved, p(r, '1'))!;
    assert.deepEqual([after.x - before.x, after.y - before.y], [40, 30]);
    const w = moved.schematic.wires.find((x) => touches(x, r))!;
    const ends = [w.points[0], w.points.at(-1)];
    assert.ok(ends.some((e) => e!.x === after.x && e!.y === after.y), 'конец провода в новой точке вывода');
    const rot = rotateInstance(moved, r);
    assert.equal(rot.schematic.instances.find((i) => i.id === r)!.rotation, 90);
    assert.deepEqual(pinPosition(rot, p(r, '1')), { x: 140, y: 50 });
    assert.deepEqual(checkIntegrity(rot), []);
  });

  test('удаление детали удаляет её провода и выводы из сетей', () => {
    const { doc, r, v } = rcCircuit();
    const d = deleteInstance(doc, r);
    assert.ok(!d.schematic.instances.some((i) => i.id === r));
    assert.ok(!d.schematic.wires.some((w) => touches(w, r)));
    assert.equal(netOfPin(d, p(v, '+')), undefined, 'V1.+ был соединён только с R1');
    assert.deepEqual(checkIntegrity(d), []);
  });

  test('позиционные обозначения: уникальность и формат', () => {
    const { doc, r } = rcCircuit();
    assert.match(renameRefDes(doc, r, 'C1').error ?? '', /занято/);
    assert.match(renameRefDes(doc, r, '1R').error ?? '', /буква/);
    assert.equal(renameRefDes(doc, r, 'Rнагр').error, null);
  });

  test('попадание в вывод мышью', () => {
    const { doc, r } = rcCircuit();
    const pos = pinPosition(doc, p(r, '2'))!;
    assert.deepEqual(hitPin(doc, { x: pos.x + 3, y: pos.y - 2 }), p(r, '2'));
    assert.equal(hitPin(doc, { x: pos.x + 50, y: pos.y + 50 }), null);
  });

  test('переназначение ID сохраняет схему пригодной для расчёта', () => {
    const { doc } = rcCircuit();
    const copy = remapIds(doc).doc;
    assert.deepEqual(checkIntegrity(copy), []);
    assert.equal(buildNetlist(copy, { op: true, tran: null }).issues.length, 0);
  });
});

describe('Величины', () => {
  test('разбор ввода и форматирование', () => {
    assert.equal(parseQuantity('47 мкФ', 'Ф'), 47e-6);
    assert.equal(parseQuantity('4,7k', 'Ом'), 4700);
    assert.equal(parseQuantity('10к', 'Ом'), 10_000);
    assert.equal(parseQuantity('1М', 'Ом'), 1e6);
    assert.equal(parseQuantity('1м', 'Ом'), 1e-3);
    assert.equal(parseQuantity('100n', 'Ф'), 100e-9);
    assert.equal(parseQuantity('2.2e-6', 'Ф'), 2.2e-6);
    assert.equal(parseQuantity('12 В', 'В'), 12);
    assert.equal(parseQuantity('-5', 'В'), -5);
    assert.equal(parseQuantity('abc', 'Ом'), null);
    assert.equal(parseQuantity('10 кк', 'Ом'), null);
    assert.equal(formatQuantity(47e-6, 'Ф'), '47 мкФ');
    assert.equal(formatQuantity(10_000, 'Ом'), '10 кОм');
    assert.equal(formatQuantity(0.25, 'Вт'), '250 мВт');
    assert.equal(formatQuantity(3.1606, 'В'), '3,16 В');
  });
  test('числа для ngspice — без суффиксов', () => {
    assert.equal(spiceNumber(1e-7), '1e-7');
    assert.equal(spiceNumber(10_000), '10000');
    assert.equal(spiceNumber(0.000047), '0.000047');
    assert.doesNotMatch(spiceNumber(1e6), /[a-zA-Z](?!-|\d)/);
  });
});

describe('Netlist и проверки перед расчётом', () => {
  test('RC-цепь: элементы, узлы, сохранение токов, переходный процесс с uic', () => {
    const { doc } = rcCircuit();
    const nl = buildNetlist(doc, { op: true, tran: TRAN });
    assert.deepEqual(nl.issues, []);
    assert.match(nl.text, /^V1 n\d+ 0 DC 5$/m);
    assert.match(nl.text, /^R1 n\d+ n\d+ 10000$/m);
    assert.match(nl.text, /^C1 n\d+ 0 1e-7$/m);
    assert.match(nl.text, /save all @r1\[i\] @c1\[i\]/);
    assert.match(nl.text, /^tran 0\.00001 0\.005 uic$/m);
    assert.ok(nl.text.includes('write op.raw all') && nl.text.includes('write tran.raw all'));
  });

  test('нет земли', () => {
    const b = new Builder();
    const v = b.place('V', 0, 0), r = b.place('R', 100, 0);
    b.wire(p(v, '+'), p(r, '1'));
    b.wire(p(v, '-'), p(r, '2'));
    const codes = buildNetlist(b.doc, { op: true, tran: null }).issues.map((i) => i.code);
    assert.ok(codes.includes('no-ground'));
  });

  test('неподключённый вывод и висящий узел', () => {
    const b = new Builder();
    const v = b.place('V', 0, 0), r1 = b.place('R', 100, 0), r2 = b.place('R', 200, 0), g = b.place('GND', 0, 100);
    b.wire(p(v, '+'), p(r1, '1'));
    b.wire(p(v, '-'), p(g, '1'));
    b.wire(p(r1, '2'), p(r2, '1'));
    const issues = buildNetlist(b.doc, { op: true, tran: null }).issues;
    assert.ok(issues.some((i) => i.code === 'unconnected-pin' && i.message.includes('R2') && i.message.includes('2')));
  });

  test('узел только через конденсатор — нет пути постоянного тока', () => {
    const b = new Builder();
    const v = b.place('V', 0, 0), c1 = b.place('C', 100, 0), r = b.place('R', 200, 0), g = b.place('GND', 0, 100);
    b.wire(p(v, '+'), p(c1, '1'));
    b.wire(p(c1, '2'), p(r, '1'));
    b.wire(p(r, '2'), p(c1, '2'));
    b.wire(p(v, '-'), p(g, '1'));
    const codes = buildNetlist(b.doc, { op: true, tran: null }).issues.map((i) => i.code);
    assert.ok(codes.includes('no-dc-path'), codes.join(','));
  });

  test('закороченный источник, недопустимый номинал, пустая схема', () => {
    const b = new Builder();
    const v = b.place('V', 0, 0), r = b.place('R', 100, 0), g = b.place('GND', 0, 100);
    b.wire(p(v, '+'), p(v, '-'));
    b.wire(p(v, '-'), p(g, '1'));
    b.wire(p(r, '1'), p(g, '1'));
    b.wire(p(r, '2'), p(v, '+'));
    b.value(r, 'resistance', 0, 'Ω');
    const codes = buildNetlist(b.doc, { op: true, tran: null }).issues.map((i) => i.code);
    assert.ok(codes.includes('shorted-source'));
    assert.ok(codes.includes('bad-value'));
    assert.ok(buildNetlist(new Builder().doc, { op: true, tran: null }).issues.some((i) => i.code === 'empty'));
  });

  test('деталь без модели не моделируется', () => {
    const { doc, r } = rcCircuit();
    const part = doc.library.parts.find((x) => x.id === doc.schematic.instances.find((i) => i.id === r)!.partId)!;
    const d = { ...doc, library: { ...doc.library, parts: doc.library.parts.map((x) => (x.id === part.id ? { ...x, modelId: null } : x)) } };
    const issue = buildNetlist(d, { op: true, tran: null }).issues.find((i) => i.code === 'no-model');
    assert.ok(issue && issue.message.includes('R1'));
  });

  test('кириллица в обозначениях не попадает в netlist', () => {
    const { doc, r } = rcCircuit();
    const d = renameRefDes(doc, r, 'Рнагр').doc;
    const nl = buildNetlist(d, { op: true, tran: null });
    assert.deepEqual(nl.issues, []);
    assert.doesNotMatch(nl.text.split('\n').slice(1).join('\n'), /[^\x00-\x7f]/);
  });
});

describe('Трассировка проводов', () => {
  test('провода разных цепей не ложатся друг на друга и не проходят через чужие выводы', async () => {
    const { Builder, p } = await import('../sim-helpers');
    const { pinPosition } = await import('../../src/core/schematic');
    // Та же раскладка, на которой в интерфейсе провода накладывались
    const b = new Builder();
    const v = b.place('V', 120, 250), r1 = b.place('R', 300, 150), r2 = b.place('R', 300, 350), g = b.place('GND', 120, 450);
    b.wire(p(v, '+'), p(r1, '1'));
    b.wire(p(r1, '2'), p(r2, '1'));
    b.wire(p(r2, '2'), p(g, '1'));
    b.wire(p(v, '-'), p(g, '1'));
    const ws = b.doc.schematic.wires;
    const segs = (pts: { x: number; y: number }[]) => pts.slice(1).map((q, i) => [pts[i]!, q] as const);
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
      if (wireNetId(b.doc, ws[i]!) === wireNetId(b.doc, ws[j]!)) continue;
      for (const [a1, a2] of segs(ws[i]!.points)) for (const [b1, b2] of segs(ws[j]!.points)) {
        const vert = a1.x === a2.x && b1.x === b2.x && a1.x === b1.x;
        const hor = a1.y === a2.y && b1.y === b2.y && a1.y === b1.y;
        if (vert) assert.ok(Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) - Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)) <= 0, 'вертикальные отрезки разных цепей перекрываются');
        if (hor) assert.ok(Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) - Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)) <= 0, 'горизонтальные отрезки разных цепей перекрываются');
      }
    }
    // концы проводов — точно на выводах
    for (const w of ws) {
      assert.deepEqual(w.points[0], pinPosition(b.doc, pinOf(w.a)!));
      assert.deepEqual(w.points.at(-1), pinPosition(b.doc, pinOf(w.b)!));
    }
  });
});
