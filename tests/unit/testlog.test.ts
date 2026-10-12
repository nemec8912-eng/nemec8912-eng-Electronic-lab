import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { diffDocs } from '../../src/core/diff';
import { newId } from '../../src/core/ids';
import { checkIntegrity } from '../../src/core/integrity';
import { loadDocument } from '../../src/core/migrations';
import type { AttachmentRef, Measurement, ProjectDoc } from '../../src/core/model';
import { movePlacement, syncFromSchematic } from '../../src/core/pcb';
import { remapDocs } from '../../src/core/remap';
import { deleteWire, setValue } from '../../src/core/schematic';
import {
  addRecord, attachPhoto, compare, dayIso, deleteRecord, detachPhoto, fmtDay, hypotheses, keepJournal, newEvent, newMeasurement, newRecord,
  nominalResistance, setEvents, setMeasurements,
} from '../../src/core/testlog';
import { Builder, p, touches } from '../sim-helpers';

function divider() {
  const b = new Builder('Журнал');
  const g = b.place('GND', 0, 300);
  const v = b.vsrc(10, 0, 100, g);
  const r1 = b.part('Резистор 0,25 Вт выводной', 150, 0), r2 = b.part('Резистор 0,25 Вт выводной', 300, 150);
  b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
  return { b, v, r1, r2, g };
}
const mid = (doc: ProjectDoc, r2: string) => doc.schematic.nets.find((n) => n.connections.some((c) => c.instanceId === r2 && c.pin === '1'))!.id;
const withExpected = (m: Measurement, value: number, band: number, measured: number | null): Measurement =>
  ({ ...m, measured, expected: { value, band, method: 'тест', revision: 1, at: new Date().toISOString() } });

describe('Журнал: формат v7', () => {
  test('проект v6 с прежней записью испытания открывается: точка «словами», значение и прибор те же', () => {
    const raw = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures/project-v6.json'), 'utf8'));
    const r = loadDocument(raw);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    if (!r.ok) return;
    assert.equal(r.migratedFrom, 6);
    assert.equal(r.doc.schemaVersion, 8);
    const t = r.doc.tests[0]!;
    assert.equal(t.conditions, raw.tests[0].conditions);
    assert.equal(t.checkpointId, null);
    const m = t.measurements[0]!;
    assert.deepEqual([m.target.kind, m.label, m.measured, m.unit, m.instrument, m.quantity], ['text', 'OUT', 1.6, 'V', 'мультиметр', 'other']);
    assert.equal(compare(m).status, 'not-comparable');
    assert.deepEqual(checkIntegrity(r.doc), []);
  });

  test('фото записи должны быть среди вложений проекта; дата — календарный день', () => {
    const { b } = divider();
    const rec = { ...newRecord(b.doc, 'Т', null), photoIds: [newId()] };
    const doc = addRecord(b.doc, rec);
    assert.ok(checkIntegrity(doc).some((i) => i.message.includes('photoIds')));
    assert.equal(dayIso(new Date(2026, 9, 12, 0, 5)), '2026-10-12T12:00:00.000Z');
    assert.equal(fmtDay('2026-10-12T12:00:00.000Z'), '12.10.2026');
  });
});

describe('Журнал: сравнение с расчётом', () => {
  test('совпадение и расхождение с учётом разброса и погрешности прибора', () => {
    const { b, r2 } = divider();
    const m = newMeasurement(b.doc, { kind: 'net', netId: mid(b.doc, r2) }, 'V');
    assert.equal(m.label.length > 0, true);
    assert.deepEqual([m.accuracyPct, m.accuracyAbs, m.unit], [1, 0.01, 'В']);
    // 5 В ± 0,05; прибор 1 % + 0,01 → при 5,1 В допустимо 0,05 + 0,051 + 0,01 = 0,111
    const ok = compare(withExpected(m, 5, 0.05, 5.1));
    assert.equal(ok.status, 'match');
    assert.ok(Math.abs(ok.allowed! - 0.111) < 1e-12);
    const bad = compare(withExpected(m, 5, 0.05, 5.2));
    assert.equal(bad.status, 'mismatch');
    assert.match(bad.text, /расхождение: \+200 мВ \(\+4,0 %\)/);
    assert.equal(compare(withExpected(m, 5, 0.05, null)).status, 'not-measured');
    assert.equal(compare(m).status, 'not-measured');
    assert.equal(compare({ ...m, measured: 5 }).status, 'no-expected');
  });

  test('сопротивление детали — номинал и допуск детали', () => {
    const { b, r1 } = divider();
    b.value(r1, 'resistance', 4700, 'Ω');
    const n = nominalResistance(b.doc, r1)!;
    assert.deepEqual([n.value, n.band], [4700, 47]);
    assert.match(n.method, /± 1 %/);
  });

  test('гипотезы — только при расхождении и только из фактов', () => {
    const { b, r2, r1 } = divider();
    let doc = b.doc;
    const rec0 = { ...newRecord(doc, 'Т', null), supplyV: 10 };
    const net = { kind: 'net' as const, netId: mid(doc, r2) };
    const zero = withExpected(newMeasurement(doc, net, 'V'), 5, 0.05, 0.01);
    const h0 = hypotheses(doc, rec0, zero);
    assert.match(h0.join('\n'), /почти нулевое/);
    assert.match(h0.join('\n'), /подключены: R1, R2/);
    const supply = withExpected(newMeasurement(doc, net, 'V'), 5, 0.05, 9.9);
    const rec = { ...rec0, events: [newEvent(doc, r2, 'burned')] };
    const h1 = hypotheses(doc, rec, supply).join('\n');
    assert.match(h1, /почти равно питанию/);
    assert.match(h1, /обрыв цепи от этого узла к земле/);
    assert.match(h1, /R2 — сгорела/);
    assert.deepEqual(hypotheses(doc, rec, withExpected(newMeasurement(doc, net, 'V'), 5, 0.05, 5.02)), [], 'при совпадении гипотез нет');
    const ohm = withExpected(newMeasurement(doc, { kind: 'part', instanceId: r1, pin: null }, 'Ω'), 10_000, 100, 1e6);
    assert.match(hypotheses(doc, rec0, ohm).join('\n'), /обрыв или выгорание/);
    // Измеренное питание отличается от схемного
    doc = setValue(doc, doc.schematic.instances.find((i) => i.refDes === 'V1')!.id, 'voltage', { value: 12, unit: 'V' });
    assert.match(hypotheses(doc, rec0, supply).join('\n'), /Питание измерено 10 В, на схеме — 12 В/);
  });
});

describe('Журнал: записи, фото, возврат ревизии', () => {
  test('измерения и события правятся одной операцией; удаление записи убирает её фото из вложений', () => {
    const { b, r2 } = divider();
    const rec = newRecord(b.doc, 'Первое включение', null);
    let doc = addRecord(b.doc, rec);
    doc = setMeasurements(doc, rec.id, (ms) => [...ms, newMeasurement(doc, { kind: 'part', instanceId: r2, pin: null }, 'V')]);
    doc = setEvents(doc, rec.id, (es) => [...es, newEvent(doc, r2, 'replaced')]);
    const ref: AttachmentRef = { id: newId(), fileName: 'фото.png', size: 3, sha256: '0'.repeat(64), mime: 'image/png' };
    doc = attachPhoto(doc, rec.id, ref);
    assert.deepEqual(checkIntegrity(doc), []);
    assert.equal(doc.tests[0]!.measurements[0]!.label, 'R2');
    assert.equal(doc.tests[0]!.events[0]!.refDes, 'R2');
    assert.equal(detachPhoto(doc, rec.id, ref.id).attachments.length, 0);
    const gone = deleteRecord(doc, rec.id);
    assert.equal(gone.tests.length, 0);
    assert.equal(gone.attachments.length, 0);
  });

  test('возврат к старой ревизии не стирает журнал: схема — старая, записи и фото — текущие', () => {
    const { b, r2 } = divider();
    const old = b.doc;
    let cur = setValue(old, r2, 'resistance', { value: 4700, unit: 'Ω' });
    cur = addRecord(cur, newRecord(cur, 'После замены', null));
    const back = keepJournal(old, cur);
    assert.equal(back.schematic.instances.find((i) => i.id === r2)!.values.resistance!.value, 10_000);
    assert.equal(back.tests.length, 1);
    assert.ok(back.revision >= cur.revision);
    assert.deepEqual(checkIntegrity(back), []);
  });

  test('копия проекта: ссылка записи на контрольную версию переназначается вместе с ней', () => {
    const { b } = divider();
    const cpId = newId();
    const doc = addRecord(b.doc, newRecord(b.doc, 'Т', cpId));
    const { docs, map } = remapDocs([doc], [cpId]);
    assert.notEqual(docs[0]!.tests[0]!.checkpointId, cpId);
    assert.equal(docs[0]!.tests[0]!.checkpointId, map.get(cpId));
  });
});

describe('Сравнение ревизий', () => {
  test('номинал, детали, соединения, модель, плата', () => {
    const { b, r1, r2, v } = divider();
    const a = syncFromSchematic(b.doc).doc;
    let c = setValue(a, r2, 'resistance', { value: 4700, unit: 'Ω' });
    const wire = c.schematic.wires.find((w) => touches(w, v))!;
    c = deleteWire(c, wire.id);
    c = movePlacement(c, c.pcb.placements[0]!.id, { x: 40, y: 30 });
    const partId = c.schematic.instances.find((i) => i.id === r1)!.partId;
    c = { ...c, library: { ...c.library, parts: c.library.parts.map((x) => (x.id === partId ? { ...x, tolerancePct: 5 } : x)) } };
    const d = diffDocs(a, c).map((x) => `${x.section}: ${x.text}`);
    assert.ok(d.includes('Номиналы: R2: сопротивление 10 кОм → 4,7 кОм'), d.join('\n'));
    assert.ok(d.some((x) => /Соединения: .*V1\.- .*больше не соединены/.test(x)), d.join("\n"));
    assert.ok(d.some((x) => /Модели и сведения: «Резистор 0,25 Вт выводной» \(R1, R2\): изменено — допуск/.test(x)), d.join('\n'));
    assert.ok(d.includes('Плата: Перемещено или повёрнуто деталей: 1'), d.join('\n'));
    assert.deepEqual(diffDocs(a, a), []);
    const back = diffDocs(c, a).map((x) => x.text);
    assert.ok(back.includes('R2: сопротивление 4,7 кОм → 10 кОм'));
    assert.ok(back.some((x) => /теперь соединены/.test(x)));
  });
});

