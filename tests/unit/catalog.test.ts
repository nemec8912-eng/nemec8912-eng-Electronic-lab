import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { builtinCatalog } from '../../src/catalog/builtin';
import { bundleOf, checkLibrary, emptyCatalog, lintBundle, loadCatalog, removePart, searchBundles, upsertBundle, type PartBundle } from '../../src/core/catalog';
import { createProject } from '../../src/core/factory';
import { checkIntegrity } from '../../src/core/integrity';
import { placeBundle } from '../../src/core/schematic';
import { buildNetlist } from '../../src/sim/netlist';

const all = builtinCatalog();
const byPn = (pn: string) => all.find((b) => b.part.partNumber === pn)!;
const libOf = (list: PartBundle[]) => ({
  parts: list.map((b) => b.part), symbols: list.map((b) => b.symbol), packages: list.flatMap((b) => b.packages), models: list.flatMap((b) => (b.model ? [b.model] : [])),
});

describe('Встроенный справочник', () => {
  test('все комплекты без ошибок; ID уникальны; библиотека целостна', () => {
    assert.ok(all.length >= 35, `деталей: ${all.length}`);
    for (const b of all) {
      const errors = lintBundle(b).filter((l) => l.severity === 'error');
      assert.deepEqual(errors, [], b.part.name);
    }
    const ids = all.flatMap((b) => [b.part.id, b.symbol.id, ...b.packages.map((p) => p.id), ...(b.model ? [b.model.id] : [])]);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(checkLibrary(libOf(all)), []);
    assert.equal(builtinCatalog()[5]!.part.id, all[5]!.part.id, 'ID встроенных деталей стабильны');
  });

  test('реальные детали помечены «не сверено»; модели приборов «не проверены»; без модели — предупреждение', () => {
    const ne = byPn('NE555');
    assert.equal(ne.part.origin.verified, false);
    const lint = lintBundle(ne);
    assert.ok(lint.some((l) => l.field === 'model' && /не проверена/.test(l.message)), 'поведенческая модель NE555 есть, но не проверена');
    assert.ok(lint.some((l) => l.field === 'origin'));
    const thy = byPn('BT151-500R');
    assert.equal(thy.model, null);
    assert.ok(lintBundle(thy).some((l) => l.field === 'model' && /не моделируется/.test(l.message)));
    for (const pn of ['1N4007', '1N4148', '1N5819', '1N4733A', 'BZX55C5V1', 'BC547', 'BC557', '2N3904', '2N3906', 'IRF540N', 'IRLZ44N', '2N7000', 'LM358', 'LM317T', 'L7805CV']) {
      const m = byPn(pn).model;
      assert.ok(m && !m.verified && m.source, `${pn}: модель с источником, «не проверена»`);
    }
    assert.equal(byPn('74HC00').model, null, 'цифровые микросхемы не моделируются');
    assert.equal(byPn('ATMEGA328P-PU').model, null);
    assert.equal(ne.packages.length, 2, 'DIP-8 и SOIC-8');
    assert.ok(ne.packages.every((p) => p.pin1Marker));
  });

  test('разводка корпуса через явное соответствие: BC547 в TO-92 — 1 коллектор, 2 база, 3 эмиттер', () => {
    const b = byPn('BC547');
    const map = Object.fromEntries(b.part.packages[0]!.pinMap.map((m) => [b.symbol.pins.find((p) => p.number === m.symbolPin)!.name, m.pad]));
    assert.deepEqual(map, { C: '1', B: '2', E: '3' });
    const n = byPn('2N3904');
    const map2 = Object.fromEntries(n.part.packages[0]!.pinMap.map((m) => [n.symbol.pins.find((p) => p.number === m.symbolPin)!.name, m.pad]));
    assert.deepEqual(map2, { E: '1', B: '2', C: '3' });
  });
});

describe('Поиск', () => {
  test('по партномеру, маркировке, корпусу, номиналу и категории', () => {
    assert.ok(searchBundles(all, '555').some((b) => b.part.partNumber === 'NE555'));
    assert.ok(searchBundles(all, '4148').some((b) => b.part.partNumber === '1N4148'));
    assert.ok(searchBundles(all, 'to-220 mosfet').every((b) => b.part.category === 'mosfet'));
    assert.ok(searchBundles(all, 'TO-220').some((b) => b.part.partNumber === 'IRF540N'));
    assert.ok(searchBundles(all, '47мк').some((b) => b.part.category === 'capacitor-polar'), 'номинал 47 мкФ');
    assert.ok(searchBundles(all, 'стабилизатор').length >= 2);
    assert.ok(searchBundles(all, '', 'bjt').every((b) => b.part.category === 'bjt'));
    assert.deepEqual(searchBundles(all, 'нет-такой-детали'), []);
  });
});

describe('Личный каталог', () => {
  test('добавление, замена, удаление; неиспользуемые символы и корпуса убираются', () => {
    let cat = emptyCatalog();
    const ne = structuredClone(byPn('NE555'));
    cat = upsertBundle(cat, ne);
    assert.equal(cat.parts.length, 1);
    assert.equal(cat.packages.length, 2);
    assert.deepEqual(bundleOf(cat, ne.part.id)?.part.name, 'Таймер NE555');
    const edited = { ...ne, part: { ...ne.part, name: 'NE555 (мой)', packages: ne.part.packages.slice(0, 1) }, packages: ne.packages.slice(0, 1) };
    cat = upsertBundle(cat, edited);
    assert.equal(cat.parts[0]!.name, 'NE555 (мой)');
    assert.equal(cat.packages.length, 1, 'корпус, который больше не используется, удалён');
    assert.deepEqual(checkLibrary(cat), []);
    cat = removePart(cat, ne.part.id);
    assert.deepEqual(cat, emptyCatalog());
  });

  test('проверки редактора: дубликат партномера, повтор номера вывода, ошибки соответствия выводов', () => {
    const ne = structuredClone(byPn('NE555'));
    const copy = structuredClone(ne);
    copy.part.id = '11111111-1111-4111-8111-111111111111';
    assert.ok(lintBundle(copy, [ne.part]).some((l) => l.field === 'partNumber' && l.severity === 'error'));
    const badPins = structuredClone(ne);
    badPins.symbol.pins[1]!.number = badPins.symbol.pins[0]!.number;
    assert.ok(lintBundle(badPins).some((l) => l.field === 'pins' && /повторяется/.test(l.message)));
    const badMap = structuredClone(ne);
    badMap.part.packages[0]!.pinMap[0]!.pad = '99';
    badMap.part.packages[0]!.pinMap[1]!.pad = badMap.part.packages[0]!.pinMap[2]!.pad;
    const msgs = lintBundle(badMap).filter((l) => l.field === 'pinmap' && l.severity === 'error').map((l) => l.message).join('\n');
    assert.match(msgs, /площадки «99» нет/);
    assert.match(msgs, /назначено несколько выводов/);
    const missing = structuredClone(ne);
    missing.part.packages[0]!.pinMap.pop();
    assert.ok(lintBundle(missing).some((l) => /не назначен ни на одну площадку/.test(l.message)));
  });

  test('файл каталога: старая версия обновляется, новее — не открывается, мусор — отклоняется', () => {
    const v1 = loadCatalog({ schemaVersion: 1, symbols: [], parts: [], packages: [], models: [] });
    assert.ok(v1.ok && v1.migratedFrom === 1);
    const future = loadCatalog({ schemaVersion: 9 });
    assert.ok(!future.ok && /более новой/.test(future.message));
    assert.ok(!loadCatalog({ schemaVersion: 2, parts: 'x' }).ok);
    const ok = loadCatalog(upsertBundle(emptyCatalog(), byPn('LM358')));
    assert.ok(ok.ok);
  });
});

describe('Размещение детали каталога на схеме', () => {
  test('74HC00: цифровая микросхема — расчёт честно отказывает с объяснением', () => {
    const r = placeBundle(createProject('Логика'), byPn('74HC00'), { x: 0, y: 0 });
    const nl = buildNetlist(r.doc, { op: true, tran: null });
    assert.ok(nl.issues.some((i) => i.code === 'not-simulated' && /цифровые микросхемы и микроконтроллеры не моделируются/.test(i.message)));
  });

  test('NE555: обозначение DA1, комплект встроен в проект, модель попадает в netlist один раз', () => {
    const r = placeBundle(createProject('Таймер'), byPn('NE555'), { x: 0, y: 0 });
    const inst = r.doc.schematic.instances[0]!;
    assert.equal(inst.refDes, 'DA1');
    assert.deepEqual(checkIntegrity(r.doc), []);
    const part = r.doc.library.parts[0]!;
    assert.equal(part.origin.catalogPartId, byPn('NE555').part.id);
    assert.notEqual(part.id, byPn('NE555').part.id, 'в проекте — собственная копия');
    const again = placeBundle(r.doc, byPn('NE555'), { x: 100, y: 0 });
    assert.equal(again.doc.library.parts.length, 1, 'повторное размещение использует копию проекта');
    assert.equal(again.doc.schematic.instances[1]!.refDes, 'DA2');
    const nl = buildNetlist(again.doc, { op: true, tran: null });
    assert.ok(!nl.issues.some((i) => i.code === 'no-model'));
    assert.ok(nl.issues.some((i) => i.code === 'unconnected-pin' && /DA1/.test(i.message)), 'выводы не подключены — расчёт не отправляется');
  });

  test('номинал детали переходит в экземпляр; разъём не мешает расчёту', () => {
    const cap = all.find((b) => b.part.category === 'capacitor-polar')!;
    const r = placeBundle(createProject('x'), cap, { x: 0, y: 0 });
    assert.deepEqual(r.doc.schematic.instances[0]!.values, { capacitance: { value: 47e-6, unit: 'F' }, esr: { value: 0.6, unit: 'Ω' } });
    const conn = all.find((b) => b.part.category === 'connector')!;
    const r2 = placeBundle(createProject('x'), conn, { x: 0, y: 0 });
    const nl = buildNetlist(r2.doc, { op: true, tran: null });
    assert.ok(!nl.issues.some((i) => i.code === 'no-model'), 'разъём — не элемент цепи');
  });
});
