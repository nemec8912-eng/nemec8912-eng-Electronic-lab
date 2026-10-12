import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { builtinCatalog } from '../../src/catalog/builtin';
import { checkLibrary, lintBundle } from '../../src/core/catalog';
import { addPackage, addPad, copyBundle, fitBody, mapByNumber, newBundle, newCustomPackage, removePackage, removePad, setCategory, setIcPins, setPad, setPinPad, setVerified } from '../../src/core/partEditor';
import { overlappingPads } from '../../src/core/packages';

const ne = () => builtinCatalog().find((b) => b.part.partNumber === 'NE555')!;
const libOf = (b: ReturnType<typeof ne>) => ({ parts: [b.part], symbols: [b.symbol], packages: b.packages, models: b.model ? [b.model] : [] });

test('новая микросхема: 8 выводов, DIP-8 и SOIC-8 сопоставляются по номерам, без ошибок при заполненных полях', () => {
  let b = newBundle('ic-digital', 8);
  b = { ...b, part: { ...b.part, name: 'Моя ИС' } };
  b = setIcPins(b, b.symbol.pins.map((p, i) => ({ number: p.number, name: i === 7 ? 'VCC' : i === 3 ? 'GND' : `IO${i}`, electricalType: i === 7 ? 'power-in' : i === 3 ? 'ground' : 'bidirectional' })));
  b = addPackage(b, 'DIP', { pins: 8 });
  b = addPackage(b, 'SOIC', { pins: 8 });
  assert.equal(b.part.packages.length, 2);
  assert.ok(b.part.packages.every((pk) => pk.pinMap.length === 8));
  assert.deepEqual(lintBundle(b).filter((l) => l.severity === 'error'), []);
  assert.deepEqual(checkLibrary(libOf(b)), []);
  assert.equal(b.part.refPrefix, 'DD');
});

test('изменение пиновки: удалённый вывод уходит из соответствия, добавленный сопоставляется по номеру', () => {
  let b = addPackage(newBundle('ic-analog', 8), 'DIP', { pins: 8 });
  b = setIcPins(b, b.symbol.pins.slice(0, 6).map((p) => ({ number: p.number, name: p.name, electricalType: p.electricalType })));
  assert.equal(b.part.packages[0]!.pinMap.length, 6);
  assert.ok(lintBundle(b).some((l) => /площадки без вывода: 7, 8/.test(l.message)), 'лишние площадки — предупреждение');
  b = setIcPins(b, [...b.symbol.pins.map((p) => ({ number: p.number, name: p.name, electricalType: p.electricalType })), { number: '8', name: 'VCC', electricalType: 'power-in' }]);
  assert.ok(b.part.packages[0]!.pinMap.some((m) => m.symbolPin === '8' && m.pad === '8'));
});

test('ручное соответствие: площадка не может принадлежать двум выводам', () => {
  let b = addPackage(newBundle('bjt'), 'TO-92');
  const pkgId = b.packages[0]!.id;
  b = setPinPad(b, pkgId, '2', '1'); // C → 1 (было B → 1 по номеру)
  b = setPinPad(b, pkgId, '1', '2'); // B → 2
  const map = Object.fromEntries(b.part.packages[0]!.pinMap.map((m) => [m.symbolPin, m.pad]));
  assert.deepEqual(map, { '2': '1', '1': '2', '3': '3' });
  assert.deepEqual(lintBundle({ ...b, part: { ...b.part, name: 'x' } }).filter((l) => l.severity === 'error'), []);
  b = setPinPad(b, pkgId, '3', null);
  assert.ok(lintBundle(b).some((l) => /не назначен/.test(l.message)));
  b = mapByNumber(b, ['3'], pkgId);
  assert.ok(b.part.packages[0]!.pinMap.some((m) => m.symbolPin === '3' && m.pad === '3'));
  b = removePackage(b, pkgId);
  assert.equal(b.part.packages.length, 0);
});

test('категория: стандартный символ и идеальная модель; номинал своего вида', () => {
  let b = newBundle('resistor');
  assert.equal(b.symbol.graphic, 'iec-resistor');
  assert.equal(b.model?.kind, 'spice-primitive');
  b = { ...b, part: { ...b.part, values: { resistance: { value: 1000, unit: 'Ω' } } } };
  b = setCategory(b, 'diode');
  assert.equal(b.symbol.graphic, 'diode');
  assert.equal(b.model, null);
  assert.deepEqual(b.part.values, {});
  assert.equal(b.part.refPrefix, 'VD');
  b = setCategory(b, 'ic-analog');
  assert.equal(b.symbol.graphic, 'box');
  assert.equal(b.symbol.pins.length, 2, 'выводы сохранены');
});

test('категория у детали с корпусами: обозначение и соответствие выводов не меняются', () => {
  let b = addPackage(newBundle('ic-analog', 3), 'TO-92');
  const before = structuredClone(b.symbol);
  b = setCategory(b, 'bjt');
  assert.equal(b.part.category, 'bjt');
  assert.equal(b.part.refPrefix, 'VT');
  assert.deepEqual(b.symbol, before);
  assert.equal(b.part.packages[0]!.pinMap.length, 3);
});

test('копия встроенной детали: новые id, «не сверено», пометка об основе; отметка проверки ставит дату', () => {
  const c = copyBundle(ne());
  assert.notEqual(c.part.id, ne().part.id);
  assert.notEqual(c.symbol.id, ne().symbol.id);
  assert.ok(c.packages.every((p, i) => p.id !== ne().packages[i]!.id));
  assert.match(c.part.origin.notes, /на основе «Таймер NE555»/);
  assert.deepEqual(checkLibrary(libOf(c)), []);
  const v = setVerified(c, true, new Date('2026-10-11T10:00:00Z'));
  assert.equal(v.part.origin.verified, true);
  assert.equal(v.part.origin.checkedAt, '2026-10-11T10:00:00.000Z');
});

describe('Свой корпус по координатам', () => {
  test('новый корпус: площадка на каждый вывод, правка координат и номера переносит соответствие, проверки площадок', () => {
    let b = newBundle('relay');
    assert.equal(b.model?.name, 'Реле (параметры катушки на схеме)', 'реле сразу получает типовую модель');
    assert.deepEqual(Object.keys(b.part.values).sort(), ['coilResistance', 'dropOut', 'pullIn']);
    b = newCustomPackage(b);
    const pkg = b.packages[0]!;
    assert.equal(pkg.pads.length, 5);
    assert.equal(pkg.generator, null);
    assert.deepEqual(b.part.packages[0]!.pinMap.map((m) => `${m.symbolPin}>${m.pad}`), ['1>1', '2>2', '3>3', '4>4', '5>5']);
    // Перемещение и переименование площадки
    let r = setPad(b, pkg.id, 4, { x: 12.2, y: 12, number: 'NC' });
    assert.equal(r.error, null);
    b = r.b;
    assert.equal(b.part.packages[0]!.pinMap.find((m) => m.symbolPin === '5')!.pad, 'NC');
    // Отверстие не меньше площадки, пустой номер — отказ
    assert.match(setPad(b, pkg.id, 0, { drill: 2 }).error!, /не меньше площадки/);
    assert.match(setPad(b, pkg.id, 0, { number: ' ' }).error!, /пустой/);
    // Перекрытие площадок разных выводов — ошибка проверки детали
    r = setPad(b, pkg.id, 1, { x: 0.5, y: 0 });
    assert.ok(lintBundle(r.b).some((l) => l.severity === 'error' && /площадки 1 и 2 перекрываются/.test(l.message)));
    // Удаление площадки убирает её из соответствия; контур по площадкам
    b = removePad(b, pkg.id, 4);
    assert.ok(!b.part.packages[0]!.pinMap.some((m) => m.pad === 'NC'));
    b = addPad(b, pkg.id);
    assert.equal(b.packages[0]!.pads.length, 5);
    b = fitBody(b, pkg.id);
    const body = b.packages[0]!.body!;
    for (const p of b.packages[0]!.pads) assert.ok(p.x - p.w / 2 >= body.x && p.x + p.w / 2 <= body.x + body.w);
  });

  test('сгенерированный корпус после правки помечается изменённым; TO-92 с шагом 1,27 — узкие площадки без перекрытия', () => {
    let b = addPackage(newBundle('bjt'), 'TO-92', { pitch: 1.27 });
    assert.deepEqual(overlappingPads(b.packages[0]!), []);
    b = setPad(b, b.packages[0]!.id, 0, { y: 0.5 }).b;
    assert.equal(b.packages[0]!.generator, null);
    assert.match(b.packages[0]!.family, /изменён/);
    assert.deepEqual(overlappingPads(addPackage(newBundle('bjt'), 'TO-92').packages[0]!), []);
  });
});
