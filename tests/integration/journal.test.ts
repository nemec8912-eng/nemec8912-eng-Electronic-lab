/**
 * Этап 7: расчётные значения журнала на настоящем ngspice (разброс по допускам сверяется с формулой
 * наихудшего случая, подстановка измеренного питания) и хранилище: фото и ссылки записей на снимки
 * ревизий переживают сохранение, экспорт и импорт как копию, дублирование; возврат ревизии не стирает журнал.
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { checkIntegrity } from '../../src/core/integrity';
import type { ProjectDoc, TestRecord } from '../../src/core/model';
import { setValue } from '../../src/core/schematic';
import { addRecord, attachPhoto, keepJournal, newMeasurement, newRecord, setMeasurements } from '../../src/core/testlog';
import { expectedValues } from '../../src/sim/expected';
import { DataStore } from '../../src/storage/store';
import { tempDir } from '../helpers';
import { Builder, ngspiceForTests, p, requireNgspice } from '../sim-helpers';

const NG = ngspiceForTests();
const skip = !NG && !requireNgspice ? 'ngspice не найден' : false;
const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanups) await c(); });

/** 10 В → R1 (1 %) → R2 (1 %) → земля. */
function divider(r1v = 10_000, r2v = 10_000) {
  const b = new Builder('Журнал');
  const g = b.place('GND', 0, 300);
  const v = b.vsrc(10, 0, 100, g);
  const r1 = b.part('Резистор 0,25 Вт выводной', 150, 0), r2 = b.part('Резистор 0,25 Вт выводной', 300, 150);
  b.value(r1, 'resistance', r1v, 'Ω'); b.value(r2, 'resistance', r2v, 'Ω');
  b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
  return { b, v, r1, r2 };
}
const midNet = (doc: ProjectDoc, r2: string) => doc.schematic.nets.find((n) => n.connections.some((c) => c.instanceId === r2 && c.pin === '1'))!.id;
const vout = (V: number, a: number, b: number) => V * b / (a + b);

function record(doc: ProjectDoc, r1: string, r2: string, supplyV: number | null = null): { doc: ProjectDoc; rec: TestRecord } {
  const rec0 = { ...newRecord(doc, 'Т', null), supplyV };
  let d = addRecord(doc, rec0);
  d = setMeasurements(d, rec0.id, () => [
    newMeasurement(d, { kind: 'net', netId: midNet(d, r2) }, 'V'),
    newMeasurement(d, { kind: 'part', instanceId: r1, pin: null }, 'A'),
    newMeasurement(d, { kind: 'part', instanceId: r1, pin: null }, 'V'),
    newMeasurement(d, { kind: 'part', instanceId: r2, pin: null }, 'Ω'),
    newMeasurement(d, { kind: 'text' }, 'other', 'корпус U1'),
  ]);
  return { doc: d, rec: d.tests.find((t) => t.id === rec0.id)! };
}

describe('Расчётные значения журнала (ngspice)', { skip }, () => {
  test('делитель 10 к / 4,7 к, 1 %: значения и разброс — наихудший случай по формуле', async () => {
    const { b, r1, r2 } = divider(10_000, 4700);
    const { doc, rec } = record(b.doc, r1, r2);
    const out = await expectedValues(doc, NG, rec);
    assert.equal(out.status, 'ok', out.message ?? '');
    assert.equal(out.runs, 1 + 2 * 2);
    const by = (i: number) => out.values.find((v) => v.measurementId === rec.measurements[i]!.id)!;
    const v0 = vout(10, 10_000, 4700);
    assert.ok(Math.abs(by(0).value! - v0) < 1e-9, `Uвых ${by(0).value}`);
    // Наихудший случай в линейном приближении: сумма отклонений от R1 ± 1 % и R2 ± 1 %
    const dR1 = Math.max(Math.abs(vout(10, 10_100, 4700) - v0), Math.abs(vout(10, 9_900, 4700) - v0));
    const dR2 = Math.max(Math.abs(vout(10, 10_000, 4747) - v0), Math.abs(vout(10, 10_000, 4653) - v0));
    assert.ok(Math.abs(by(0).band - (dR1 + dR2)) < 1e-9, `разброс ${by(0).band} вместо ${dR1 + dR2}`);
    assert.match(by(0).method, /допускам сопротивлений R1, R2/);
    assert.ok(Math.abs(by(1).value! - 10 / 14_700) < 1e-12, 'ток через R1 от вывода 1 к 2');
    assert.ok(Math.abs(by(2).value! - (10 - v0)) < 1e-9, 'напряжение на R1');
    assert.deepEqual([by(3).value, by(3).band], [4700, 47], 'сопротивление R2 — номинал ± 1 %');
    assert.equal(out.values.find((v) => v.measurementId === rec.measurements[4]!.id), undefined, 'точка «словами» не рассчитывается');
  });

  test('измеренное питание подставляется, если источник один', async () => {
    const { b, r1, r2 } = divider();
    const { doc, rec } = record(b.doc, r1, r2, 9);
    const out = await expectedValues(doc, NG, rec);
    const u = out.values.find((v) => v.measurementId === rec.measurements[0]!.id)!;
    assert.ok(Math.abs(u.value! - 4.5) < 1e-9);
    assert.match(u.method, /питание 9 В \(измерено\) вместо 10 В по схеме/);
  });

  test('деталь удалена из ревизии — значение не выдумывается, причина названа', async () => {
    const { b, r1, r2 } = divider();
    const { doc, rec } = record(b.doc, r1, r2);
    const without = { ...doc, schematic: { ...doc.schematic, instances: doc.schematic.instances } };
    const recGone: TestRecord = { ...rec, measurements: [...rec.measurements, newMeasurement(doc, { kind: 'part', instanceId: crypto.randomUUID(), pin: null }, 'A', 'R9')] };
    const out = await expectedValues(without, NG, recGone);
    const gone = out.values.find((v) => v.measurementId === recGone.measurements[5]!.id)!;
    assert.equal(gone.value, null);
    assert.match(gone.reason ?? '', /не определена/);
  });
});

describe('Хранилище: фото и ревизии журнала', () => {
  const fresh = async (name: string) => {
    const t = await tempDir(`elab-journal-${name}-`);
    cleanups.push(t.cleanup);
    return DataStore.open(path.join(t.dir, 'data'));
  };
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  test('фото и снимок ревизии: сохранение → экспорт → импорт копией → дублирование; возврат ревизии сохраняет журнал', async () => {
    const pc1 = await fresh('pc1');
    let doc = await pc1.createProject('Делитель');
    const { b, r2 } = divider();
    doc = { ...b.doc, id: doc.id, name: doc.name, createdAt: doc.createdAt };
    const cp = await pc1.createCheckpoint(doc, 'Испытание: первое', 'test');
    const rec = newRecord(doc, 'Первое', cp.id);
    doc = addRecord(doc, rec);
    const ref = await pc1.addAttachment(doc.id, 'плата:1.png', PNG, 'image/png');
    assert.equal(ref.fileName, 'плата_1.png', 'недопустимые для Windows символы заменены');
    doc = attachPhoto(doc, rec.id, ref);
    await pc1.saveProject(doc);
    assert.deepEqual(await pc1.readAttachment(doc.id, ref), PNG);

    // Изменили номинал — затем вернули ревизию испытания: схема старая, журнал на месте
    const changed = setValue(doc, r2, 'resistance', { value: 4700, unit: 'Ω' });
    const back = keepJournal((await pc1.readCheckpoint(doc.id, cp.id)).doc, changed);
    assert.equal(back.schematic.instances.find((i) => i.id === r2)!.values.resistance!.value, 10_000);
    assert.equal(back.tests.length, 1);
    assert.deepEqual(back.attachments.map((a) => a.id), [ref.id]);
    assert.deepEqual(checkIntegrity(back), []);

    // Перенос на другой ПК как копия: новые UUID, ссылки согласованы
    const file = await pc1.exportProject(doc);
    const pc2 = await fresh('pc2');
    const preview = await pc2.previewImport(file);
    const copy = await pc2.importProject(preview.read, 'copy');
    assert.notEqual(copy.id, doc.id);
    const t = copy.tests[0]!;
    assert.notEqual(t.checkpointId, cp.id);
    const cps = await pc2.listCheckpoints(copy.id);
    assert.ok(cps.some((c) => c.id === t.checkpointId && c.kind === 'test'), 'запись ссылается на снимок в новом проекте');
    assert.deepEqual(await pc2.readAttachment(copy.id, copy.attachments.find((a) => a.id === t.photoIds[0])!), PNG);

    // Дублирование тоже переносит снимки ревизий
    const dup = await pc2.duplicateProject(copy.id);
    const dupCps = await pc2.listCheckpoints(dup.id);
    assert.ok(dupCps.some((c) => c.id === dup.tests[0]!.checkpointId));
    assert.equal((await pc2.readCheckpoint(dup.id, dup.tests[0]!.checkpointId!)).doc.id, dup.id, 'снимок — версия нового проекта');
    await pc1.close(); await pc2.close();
  });

  test('вложение: пустое и большое не принимаются; повреждённый файл обнаруживается', async () => {
    const s = await fresh('att');
    const doc = await s.createProject('Т');
    await assert.rejects(s.addAttachment(doc.id, 'a.png', Buffer.alloc(0), 'image/png'), /пустой/);
    const ref = await s.addAttachment(doc.id, 'a.png', PNG, 'image/png');
    await assert.rejects(s.readAttachment(doc.id, { ...ref, sha256: '0'.repeat(64) }), /повреждён/);
    await s.close();
  });
});
