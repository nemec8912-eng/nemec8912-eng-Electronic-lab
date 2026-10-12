import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleOf } from '../../src/core/catalog';
import { checkIntegrity } from '../../src/core/integrity';
import { syncFromSchematic } from '../../src/core/pcb';
import { replaceProjectPart } from '../../src/core/projectPart';
import { setValue } from '../../src/core/schematic';
import { addRecord, keepJournal, newRecord } from '../../src/core/testlog';
import { Builder, p } from '../sim-helpers';

function divider() {
  const b = new Builder('Деталь в проекте');
  const g = b.place('GND', 0, 300);
  const v = b.vsrc(10, 0, 100, g);
  const r1 = b.part('Резистор 0,25 Вт выводной', 150, 0), r2 = b.part('Резистор 0,25 Вт выводной', 300, 150);
  b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
  return { b, r1, r2 };
}

test('деталь меняется только в проекте: допуск и модель; журнал изменений; связи защищены', () => {
  const { b, r1 } = divider();
  let doc = syncFromSchematic(b.doc).doc;
  const partId = doc.schematic.instances.find((i) => i.id === r1)!.partId;
  const src = bundleOf(doc.library, partId)!;
  const edited = { ...structuredClone(src), part: { ...src.part, tolerancePct: 5 }, model: { ...src.model!, verified: false, name: 'Резистор (свой)' } };
  const r = replaceProjectPart(doc, edited);
  assert.equal(r.error, null);
  assert.ok(r.changes.some((c) => c.includes('допуск 1 → 5 %')), r.changes.join('; '));
  assert.ok(r.changes.some((c) => c.includes('снята отметка «проверена»')), r.changes.join('; '));
  doc = r.doc;
  assert.equal(doc.library.parts.find((x) => x.id === partId)!.tolerancePct, 5);
  assert.deepEqual(checkIntegrity(doc), []);
  assert.match(doc.changelog.at(-1)!.summary, /изменена в проекте: .*допуск/);
  assert.equal(doc.changelog.at(-1)!.action, 'part-edit');
  // Вывод с проводом убрать нельзя
  const noPin2 = { ...structuredClone(src), symbol: { ...src.symbol, pins: src.symbol.pins.filter((x) => x.number !== '2') } };
  assert.match(replaceProjectPart(doc, noPin2).error ?? '', /к выводу 2 подключён провод/);
  // Корпус, стоящий на плате, убрать нельзя
  const noPkg = { ...structuredClone(src), part: { ...src.part, packages: [] }, packages: [] };
  assert.match(replaceProjectPart(doc, noPkg).error ?? '', /стоит на плате/);
  // Без изменений — тот же документ
  assert.equal(replaceProjectPart(doc, bundleOf(doc.library, partId)!).doc, doc);
});

test('журнал изменений: номинал, синхронизация платы, испытание, возврат ревизии', () => {
  const { b, r2 } = divider();
  let doc = syncFromSchematic(b.doc).doc;
  assert.match(doc.changelog.at(-1)!.summary, /Синхронизация платы со схемой: плата создана; добавлено: V1, R1, R2/);
  const old = doc;
  doc = setValue(doc, r2, 'resistance', { value: 4700, unit: 'Ω' });
  assert.equal(doc.changelog.at(-1)!.summary, 'R2: сопротивление 10 кОм → 4,7 кОм');
  doc = addRecord(doc, newRecord(doc, 'Первое', null));
  assert.match(doc.changelog.at(-1)!.summary, /Испытание «Первое»/);
  const back = keepJournal(old, doc, 'до замены');
  assert.match(back.changelog.at(-1)!.summary, /возвращены к ревизии \d+ \(«до замены»\); журнал испытаний сохранён/);
  assert.equal(back.changelog.length, doc.changelog.length + 1, 'журнал изменений не теряется при возврате');
});
