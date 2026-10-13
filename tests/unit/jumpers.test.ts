/** Проволочные перемычки на односторонней плате: ручная прокладка, связность, DRC, вывод, удаление, формат. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { autoroute, missingConnections } from '../../src/core/autoroute';
import { cncPlan } from '../../src/core/cnc';
import { gerberFiles, excellon } from '../../src/core/gerber';
import { checkIntegrity } from '../../src/core/integrity';
import { loadDocument } from '../../src/core/migrations';
import { remapIds } from '../../src/core/remap';
import { type ProjectDoc } from '../../src/core/model';
import {
  addJumper, addRoute, boardVias, copperGroups, deleteVia, drc, findPad, jumperEnds, JUMPER_MIN_MM, movePlacement, setBoard, syncFromSchematic,
} from '../../src/core/pcb';
import { assemblySvg } from '../../src/core/pcbExport';
import { readElab } from '../../src/storage/elab';
import { Builder, p } from '../sim-helpers';

/** V1 + → R1 → R2 → GND; R1 и R2 стоят на плате далеко друг от друга. */
function setup() {
  const b = new Builder('Перемычки');
  const v = b.place('V', 0, 100), r1 = b.place('R', 100, 0), r2 = b.place('R', 100, 200), g = b.place('GND', 0, 300);
  b.wire(p(v, '+'), p(r1, '1'));
  b.wire(p(r1, '2'), p(r2, '1'));
  b.wire(p(r2, '2'), p(g, '1'));
  b.wire(p(v, '-'), p(g, '1'));
  let doc = syncFromSchematic(b.doc).doc;
  const pl = (inst: string) => doc.pcb.placements.find((x) => x.instanceId === inst)!.id;
  doc = movePlacement(doc, pl(v), { x: 8.89, y: 20.32 });
  doc = movePlacement(doc, pl(r1), { x: 20.32, y: 7.62 });
  doc = movePlacement(doc, pl(r2), { x: 20.32, y: 33.02 });
  return { doc, v, r1, r2, pl };
}
const padEnd = (doc: ProjectDoc, placementId: string, pad: string) => ({ kind: 'pad' as const, placementId, pad });

describe('Перемычки на односторонней плате', () => {
  test('дорожка → перемычка (J) → дорожка: одна правка, цепь соединена, DRC без ошибок, всё на выводе', () => {
    const { doc, r1, r2, pl } = setup();
    assert.equal(doc.pcb.board!.layers, 1);
    const a = findPad(doc, { placementId: pl(r1), pad: '2' })!, b = findPad(doc, { placementId: pl(r2), pad: '1' })!;
    const A = { x: 45.72, y: 12.7 }, B = { x: 45.72, y: 27.94 };
    const r = addRoute(doc, { from: padEnd(doc, pl(r1), a.ref.pad), to: padEnd(doc, pl(r2), b.ref.pad), widthMm: 0.8, legs: [{ layer: 'bottom', bends: [{ x: 45.72, y: a.pos.y }] }, { layer: 'top', bends: [] }, { layer: 'bottom', bends: [{ x: b.pos.x, y: B.y }] }], vias: [A, B] });
    assert.equal(r.error, null);
    const d = r.doc;
    assert.equal(d.pcb.jumpers.length, 1);
    assert.equal(d.pcb.vias.length, 2);
    assert.equal(d.pcb.tracks.length, 2);
    assert.ok(d.pcb.tracks.every((t) => t.layer === 'bottom'));
    const e = jumperEnds(d, d.pcb.jumpers[0]!)!;
    assert.deepEqual([e.a.position, e.b.position], [A, B]);
    const find = copperGroups(d);
    assert.equal(find(`${a.ref.placementId}#${a.ref.pad}`), find(`${b.ref.placementId}#${b.ref.pad}`), 'R1.2 и R2.1 соединены через перемычку');
    assert.equal(missingConnections(d).filter((c) => c.netId === a.netId).length, 0);
    assert.deepEqual(drc(d).filter((i) => i.severity === 'error').map((i) => i.message), []);
    assert.deepEqual(checkIntegrity(d), []);
    // Копия проекта (новые UUID): ссылки перемычки на отверстия переназначаются вместе с ними
    const copy = remapIds(d).doc;
    assert.deepEqual(checkIntegrity(copy), []);
    assert.notEqual(copy.pcb.jumpers[0]!.aViaId, d.pcb.jumpers[0]!.aViaId);
    assert.equal(missingConnections(copy).filter((c) => c.netId === copy.pcb.jumpers[0]!.netId).length, 0);
    // Сверловка, медь, маска, шелкография, станок, сборочный чертёж
    const drl = excellon(d);
    for (const q of [A, B]) assert.ok(drl.includes(`X${q.x.toFixed(3)}Y${(d.pcb.board!.heightMm - q.y).toFixed(3)}`), 'отверстие перемычки в сверловке');
    const files = gerberFiles(d);
    assert.ok(!files.some((f) => f.name.endsWith('F_Cu.gtl')), 'верхнего слоя меди нет');
    assert.ok(files.find((f) => f.name === 'readme.txt')!.content.includes('Проволочные перемычки: 1'));
    const plan = cncPlan(d);
    assert.ok(plan.paths.filter((x) => x.kind !== 'iso' && x.kind !== 'cut').some((x) => Math.abs(x.pts[0]!.x - A.x) < 1e-6 && Math.abs(x.pts[0]!.y - A.y) < 1e-6), 'станок сверлит отверстие перемычки');
    assert.ok(plan.readme.includes('П1 — 15,24 мм'), plan.readme);
    assert.ok(assemblySvg(d).svg.includes('data-jumper='));
    // Удаление конца перемычки убирает её целиком вместе с дорожками
    const del = deleteVia(d, e.b.id);
    assert.equal(del.tracks, 2);
    assert.equal(del.doc.pcb.jumpers.length, 0);
    assert.equal(del.doc.pcb.vias.length, 0);
  });

  test('перемычка не может начинаться у площадки, гнуться или быть короче 2,54 мм; переход без перемычки — ошибка', () => {
    const { doc, r1, r2, pl } = setup();
    const from = padEnd(doc, pl(r1), '2'), to = padEnd(doc, pl(r2), '1');
    assert.match(addRoute(doc, { from, to, widthMm: 0.8, legs: [{ layer: 'top', bends: [] }, { layer: 'bottom', bends: [] }], vias: [{ x: 40, y: 20 }] }).error!, /своими отверстиями/);
    assert.match(addRoute(doc, { from, to, widthMm: 0.8, legs: [{ layer: 'bottom', bends: [] }, { layer: 'top', bends: [{ x: 1, y: 1 }] }, { layer: 'bottom', bends: [] }], vias: [{ x: 40, y: 20 }, { x: 45, y: 20 }] }).error!, /без изгибов/);
    assert.match(addRoute(doc, { from, to, widthMm: 0.8, legs: [{ layer: 'bottom', bends: [] }, { layer: 'top', bends: [] }, { layer: 'bottom', bends: [] }], vias: [{ x: 40.64, y: 20.32 }, { x: 41.91, y: 20.32 }] }).error!, /короче/);
    assert.match(addRoute(doc, { from, to, widthMm: 0.8, legs: [{ layer: 'bottom', bends: [] }, { layer: 'bottom', bends: [] }], vias: [{ x: 40, y: 20 }] }).error!, /только перемычки/);
    assert.ok(JUMPER_MIN_MM === 2.54);
  });

  test('DRC: провод над выводом чужой цепи и пересечение перемычек разных цепей — замыкание', () => {
    const { doc, r1, v, pl } = setup();
    const r1a = findPad(doc, { placementId: pl(r1), pad: '1' })!;
    const vNet = findPad(doc, { placementId: pl(v), pad: '2' })!.netId!;
    const mid = findPad(doc, { placementId: pl(r1), pad: '2' })!.netId!;
    // Перемычка цепи «−» поперёк вывода R1.1 (цепь «+»)
    let d = addJumper(doc, { x: r1a.pos.x, y: r1a.pos.y - 5.08 }, { x: r1a.pos.x, y: r1a.pos.y + 5.08 }, vNet).doc;
    assert.ok(drc(d).some((i) => i.code === 'short' && /проходит над выводом R1\.1/.test(i.message)), JSON.stringify(drc(d).map((i) => i.message)));
    // Две перемычки крест-накрест
    d = addJumper(doc, { x: 40.64, y: 15.24 }, { x: 50.8, y: 15.24 }, vNet).doc;
    d = addJumper(d, { x: 45.72, y: 10.16 }, { x: 45.72, y: 20.32 }, mid).doc;
    assert.ok(drc(d).some((i) => i.code === 'short' && /П1 и П2 пересекаются/.test(i.message)));
  });

  test('односторонняя ↔ двухсторонняя: перемычки не мешают; переход без перемычки на односторонней — ошибка DRC', () => {
    const { doc, v, pl } = setup();
    const net = findPad(doc, { placementId: pl(v), pad: '2' })!.netId!;
    const d = addJumper(doc, { x: 40.64, y: 15.24 }, { x: 50.8, y: 15.24 }, net).doc;
    assert.equal(boardVias(d).length, 2);
    const two = setBoard(d, { layers: 2 });
    assert.equal(two.error, null);
    const back = setBoard(two.doc, { layers: 1 });
    assert.equal(back.error, null, 'отверстия перемычек — не переходы');
    const stray = { ...d, pcb: { ...d.pcb, vias: [...d.pcb.vias, { ...d.pcb.vias[0]!, id: '00000000-0000-4000-8000-000000000001', position: { x: 30, y: 30 } }] } };
    assert.ok(drc(stray).some((i) => i.message === 'Переходное отверстие на односторонней плате'));
    assert.equal(boardVias(stray).length, 2, 'на односторонней плате в медь идут только концы перемычек');
  });

  test('формат v9 открывается с пустым списком перемычек', () => {
    const { doc } = setup();
    const old = structuredClone(doc) as unknown as Record<string, any>;
    old.schemaVersion = 9;
    delete old.pcb.jumpers;
    const r = loadDocument(old);
    assert.ok(r.ok);
    assert.equal(r.ok && r.migratedFrom, 9);
    assert.deepEqual(r.ok && r.doc.pcb.jumpers, []);
  });

  test('пример «Металлоискатель»: односторонняя плата разводится заново целиком, с перемычками; DRC и станок без ошибок', async () => {
    const d0 = (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples/пример-металлоискатель.elab')))).doc;
    assert.equal(d0.pcb.board!.layers, 1);
    assert.ok(d0.pcb.jumpers.length > 0);
    const bare = { ...d0, pcb: { ...d0.pcb, tracks: [], vias: [], jumpers: [] } };
    // Перемычки ставятся, только если без них развести не удалось
    const r = autoroute(bare, { passes: 1 });
    assert.deepEqual(r.failed, []);
    assert.ok(r.jumpers > 0);
    assert.equal(missingConnections(r.doc).length, 0);
    assert.deepEqual(drc(r.doc).filter((i) => i.severity === 'error').map((i) => i.message), []);
    assert.deepEqual(cncPlan(r.doc).issues.filter((i) => i.severity === 'error'), []);
    assert.deepEqual(checkIntegrity(r.doc), []);
    assert.match(r.doc.changelog.at(-1)!.summary, /перемычек \d/);
  });
});
