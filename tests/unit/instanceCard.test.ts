/** Карточка детали на схеме: номиналы экземпляра, ответвление общей детали, модель и выводы по маркировке. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { builtinCatalog, partTemplates } from '../../src/catalog/builtin';
import { createProject } from '../../src/core/factory';
import { applyCard, draftOf, findByMarking, parseValue, type CardDraft } from '../../src/core/instanceCard';
import { parseQuantity } from '../../src/core/library';
import type { ProjectDoc } from '../../src/core/model';
import { drc, setBoard, syncFromSchematic } from '../../src/core/pcb';
import { connectPins, placeBundle } from '../../src/core/schematic';
import { instanceLabel } from '../../src/core/sheet';
import { buildNetlist } from '../../src/sim/netlist';

const cat = builtinCatalog();
const tpl = (group: string, variant: string) => {
  const g = partTemplates().find((x) => x.category === group)!;
  const id = g.items.find((i) => i.variant === variant)!.partId;
  return cat.find((b) => b.part.id === id)!;
};
const place = (doc: ProjectDoc, b: (typeof cat)[0], x: number) => placeBundle(doc, b, { x, y: 0 });
const card = (doc: ProjectDoc, id: string, patch: Partial<CardDraft>) => applyCard(doc, id, { ...draftOf(doc, id)!, ...patch }, cat);
const inst = (doc: ProjectDoc, id: string) => doc.schematic.instances.find((i) => i.id === id)!;
const partOf = (doc: ProjectDoc, id: string) => doc.library.parts.find((p) => p.id === inst(doc, id).partId)!;

describe('Ввод номиналов', () => {
  test('сокращённая запись и единицы: 4k7, 10k, 1M, 4700, 47uF, 100nF, 220pF, 4R7', () => {
    assert.equal(parseQuantity('4k7', 'Ом'), 4700);
    assert.equal(parseQuantity('10k', 'Ом'), 10_000);
    assert.equal(parseQuantity('1M', 'Ом'), 1e6);
    assert.equal(parseQuantity('1 МОм', 'Ом'), 1e6);
    assert.equal(parseQuantity('4700', 'Ом'), 4700);
    assert.equal(parseQuantity('4R7', 'Ом'), 4.7);
    assert.equal(parseQuantity('47uF', 'Ф'), 47e-6);
    assert.equal(parseQuantity('47 мкФ', 'Ф'), 47e-6);
    assert.equal(parseQuantity('100nF', 'Ф'), 1e-7);
    assert.equal(parseQuantity('220pF', 'Ф'), 2.2e-10);
    assert.match(parseValue('resistance', 'десять').error!, /не понял «десять»/);
    assert.match(parseValue('resistance', '-5').error!, /допустимо/);
  });
});

describe('Карточка детали', () => {
  test('резистор 0805: номинал меняется только у выбранного; мощность — ответвление детали, каталог и соседи не меняются', () => {
    let d = createProject('Карточка');
    const r0805 = tpl('resistor', 'SMD 0805');
    const a = place(d, r0805, 0); d = a.doc;
    const b = place(d, r0805, 100); d = b.doc;
    assert.equal(inst(d, a.id).partId, inst(d, b.id).partId, 'один шаблон — одна деталь проекта');
    let r = card(d, a.id, { values: { resistance: 4700 } });
    assert.equal(r.error, null);
    d = r.doc;
    assert.equal(inst(d, a.id).values.resistance!.value, 4700);
    assert.equal(inst(d, b.id).values.resistance!.value, 10_000);
    assert.equal(inst(d, a.id).partId, inst(d, b.id).partId, 'номинал — у экземпляра, ответвление не нужно');
    assert.deepEqual(instanceLabel(d, inst(d, a.id)), ['R1', '4,7 кОм']);
    // Расчёт берёт новое значение: в netlist — 4700 Ом у R1 и прежние 10 кОм у R2
    const nl = buildNetlist(d, { op: true, tran: null }, 'Карточка', { leak: true }).text;
    assert.match(nl, /^R1 \S+ \S+ 4700$/m);
    assert.match(nl, /^R2 \S+ \S+ 10000$/m);
    r = card(d, a.id, { ratings: { power: 0.25 } });
    d = r.doc;
    assert.notEqual(inst(d, a.id).partId, inst(d, b.id).partId, 'пределы — ответвление');
    assert.equal(partOf(d, a.id).ratings.power!.value, 0.25);
    assert.equal(partOf(d, b.id).ratings.power!.value, 0.125);
    assert.equal(r0805.part.ratings.power!.value, 0.125, 'каталог не меняется');
    // Новый резистор из того же шаблона — с исходными пределами, а не с ответвлённой деталью
    const c = place(d, r0805, 200); d = c.doc;
    assert.equal(partOf(d, c.id).ratings.power!.value, 0.125);
    assert.match(d.changelog.at(-1)!.summary, /Размещение|R1|R3/);
  });

  test('электролит: 47 мкФ / 50 В на схеме; корпус меняется на другой вариант с той же разводкой выводов', () => {
    let d = createProject('Конденсатор');
    const c = place(d, tpl('capacitor', 'Электролитический ∅6,3 мм'), 0); d = c.doc;
    d = card(d, c.id, { values: { capacitance: 47e-6, esr: 0.6 }, ratings: { voltage: 50 } }).doc;
    assert.deepEqual(instanceLabel(d, inst(d, c.id)), ['C1', '47 мкФ / 50 В']);
    const el10 = tpl('capacitor', 'Электролитический ∅10 мм');
    d = card(d, c.id, { pkg: { kind: 'template', partId: el10.part.id } }).doc;
    const p = partOf(d, c.id);
    assert.match(d.library.packages.find((x) => x.id === p.packages[0]!.packageId)!.name, /∅10/);
    assert.deepEqual(p.packages[0]!.pinMap.map((m) => `${m.symbolPin}>${m.pad}`).sort(), ['1>1', '2>2']);
  });

  test('транзистор TO-92: распиновка не придумывается — DRC просит назначить; по маркировке BC547 — модель и выводы из справочника', () => {
    let d = createProject('Транзистор');
    const t = place(d, tpl('bjt', 'TO-92'), 0); d = t.doc;
    const r = place(d, tpl('resistor', 'Выводной 0,25 Вт'), 100); d = r.doc;
    // Провода к транзистору
    for (const pin of ['1', '2', '3']) d = connectPins(d, { instanceId: t.id, pin }, { instanceId: r.id, pin: pin === '1' ? '1' : '2' }).doc;
    assert.equal(partOf(d, t.id).packages[0]!.pinMap.length, 0);
    assert.ok(buildNetlist(d, { op: true, tran: null }).issues.some((i) => i.code === 'no-model'), 'без модели — честный отказ');
    let b = setBoard(syncFromSchematic(d).doc, { widthMm: 40, heightMm: 30 }).doc;
    assert.ok(drc(b).some((i) => i.code === 'net' && /выводы корпуса не назначены/.test(i.message)));
    // Неполное назначение — ошибка
    assert.match(card(d, t.id, { pinMap: [{ symbolPin: '1', pad: '2' }] }).error!, /Назначьте все выводы/);
    // Модель и выводы по маркировке
    const found = findByMarking(cat, 'bc547');
    assert.ok(found.some((x) => x.part.partNumber === 'BC547'));
    const bc = found.find((x) => x.part.partNumber === 'BC547')!;
    const res = card(d, t.id, { partNumber: 'BC547', model: { kind: 'catalog', partId: bc.part.id }, takePinout: true });
    assert.equal(res.error, null);
    d = res.doc;
    const part = partOf(d, t.id);
    assert.deepEqual(part.packages[0]!.pinMap, bc.part.packages[0]!.pinMap, 'выводы — как у BC547 в справочнике');
    assert.ok(res.warnings.some((w) => /не сверена/.test(w)), 'распиновка справочника не сверена — предупреждение');
    assert.deepEqual(instanceLabel(d, inst(d, t.id)), ['VT1', 'BC547']);
    assert.ok(!buildNetlist(d, { op: true, tran: null }).issues.some((i) => i.code === 'no-model'));
    b = setBoard(syncFromSchematic(d).doc, { widthMm: 40, heightMm: 30 }).doc;
    assert.ok(!drc(b).some((i) => /выводы корпуса не назначены/.test(i.message)));
    // n-p-n → p-n-p: выводы те же
    d = card(d, t.id, { graphic: 'pnp' }).doc;
    assert.equal(d.library.symbols.find((s) => s.id === partOf(d, t.id).symbolId)!.graphic, 'pnp');
  });

  test('катушка: сопротивление обмотки — модель L + R; отмена (ничего не задано) — документ тот же', () => {
    let d = createProject('Катушка');
    const l = place(d, tpl('inductor', 'Дроссель радиальный'), 0); d = l.doc;
    const same = card(d, l.id, {});
    assert.equal(same.doc, d, 'без изменений — тот же документ');
    d = card(d, l.id, { values: { inductance: 1e-3, resistance: 2 } }).doc;
    const m = d.library.models.find((x) => x.id === partOf(d, l.id).modelId)!;
    assert.match(m.text, /R1 a m \{v:resistance\}/);
    assert.equal(inst(d, l.id).values.resistance!.value, 2);
    assert.deepEqual(instanceLabel(d, inst(d, l.id)), ['L1', '1 мГн']);
  });

  test('обозначение: занятое — ошибка, документ не меняется', () => {
    let d = createProject('Обозначения');
    const a = place(d, tpl('resistor', 'SMD 0805'), 0); d = a.doc;
    const b = place(d, tpl('resistor', 'SMD 0805'), 100); d = b.doc;
    const r = card(d, b.id, { refDes: 'R1', values: { resistance: 1 } });
    assert.match(r.error!, /уже занято/);
    assert.equal(r.doc, d);
  });
});
