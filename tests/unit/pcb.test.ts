import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkIntegrity } from '../../src/core/integrity';
import type { ProjectDoc } from '../../src/core/model';
import { addTrack, allPads, copperSvg, deleteTrack, drc, movePlacement, padsOf, ratsnest, rotatePlacement, setBoard, syncFromSchematic } from '../../src/core/pcb';
import { deleteInstance, deleteWire } from '../../src/core/schematic';
import { Builder, p, touches } from '../sim-helpers';

/** Делитель: V1 + → R1 → R2 → GND, V1 − → GND. */
function divider() {
  const b = new Builder('Плата');
  const v = b.place('V', 0, 100), r1 = b.place('R', 100, 0), r2 = b.place('R', 100, 200), g = b.place('GND', 0, 300);
  b.wire(p(v, '+'), p(r1, '1'));
  b.wire(p(r1, '2'), p(r2, '1'));
  b.wire(p(r2, '2'), p(g, '1'));
  b.wire(p(v, '-'), p(g, '1'));
  return { b, v, r1, r2, g };
}

const placementOf = (doc: ProjectDoc, instanceId: string) => doc.pcb.placements.find((x) => x.instanceId === instanceId)!;

describe('Плата: перенос из схемы', () => {
  test('детали с корпусами размещаются, земля — нет; отчёт; повторная синхронизация ничего не меняет', () => {
    const { b } = divider();
    const { doc, report } = syncFromSchematic(b.doc);
    assert.deepEqual(report.added.sort(), ['R1', 'R2', 'V1']);
    assert.deepEqual(report.notPlaced, []);
    assert.equal(doc.pcb.placements.length, 3);
    assert.ok(doc.pcb.board);
    assert.deepEqual(checkIntegrity(doc), []);
    const again = syncFromSchematic(doc);
    assert.equal(again.doc, doc, 'без изменений схемы документ тот же');
    assert.equal(again.report.added.length, 0);
  });

  test('цепь площадки — через явное соответствие вывод ↔ площадка корпуса', () => {
    const { b, v, r1 } = divider();
    const { doc } = syncFromSchematic(b.doc);
    const netOfPin = (inst: string, pin: string) => doc.schematic.nets.find((n) => n.connections.some((c) => c.instanceId === inst && c.pin === pin))!.id;
    const vPads = padsOf(doc, placementOf(doc, v));
    assert.equal(vPads.find((x) => x.ref.pad === '1')!.netId, netOfPin(v, '+'), 'площадка 1 клеммника — «+» источника');
    assert.equal(vPads.find((x) => x.ref.pad === '2')!.netId, netOfPin(v, '-'));
    // Переставим соответствие у резистора: вывод 1 ↔ площадка 2. Цепи площадок должны поменяться местами.
    const part = doc.library.parts.find((x) => x.category === 'resistor')!;
    const swapped: ProjectDoc = structuredClone(doc);
    swapped.library.parts.find((x) => x.id === part.id)!.packages[0]!.pinMap = [{ symbolPin: '1', pad: '2' }, { symbolPin: '2', pad: '1' }];
    const before = padsOf(doc, placementOf(doc, r1)), after = padsOf(swapped, placementOf(swapped, r1));
    assert.equal(after.find((x) => x.ref.pad === '1')!.netId, before.find((x) => x.ref.pad === '2')!.netId);
    assert.equal(after.find((x) => x.ref.pad === '2')!.netId, before.find((x) => x.ref.pad === '1')!.netId);
  });

  test('удаление детали из схемы → при синхронизации уходит с платы вместе с её дорожками, с отчётом', () => {
    const { b, v, r1 } = divider();
    let { doc } = syncFromSchematic(b.doc);
    const pv = placementOf(doc, v), pr = placementOf(doc, r1);
    const t = addTrack(doc, { placementId: pv.id, pad: '1' }, { placementId: pr.id, pad: '1' });
    assert.equal(t.error, null);
    doc = deleteInstance(t.doc, r1);
    assert.equal(doc.pcb.placements.length, 3, 'удаление в схеме само по себе плату не трогает');
    const s = syncFromSchematic(doc);
    assert.equal(s.report.removed.length, 1);
    assert.match(s.report.removed[0]!, /удалённая из схемы/);
    assert.deepEqual(checkIntegrity(doc), [], 'до синхронизации документ тоже целостен — его можно сохранить');
    assert.equal(s.report.removedTracks, 1);
    assert.equal(s.doc.pcb.placements.length, 2);
    assert.deepEqual(checkIntegrity(s.doc), []);
  });
});

describe('Плата: дорожки и неразведённые соединения', () => {
  test('дорожка только внутри одной цепи; ratsnest уменьшается до нуля', () => {
    const { b, v, r1, r2 } = divider();
    let { doc } = syncFromSchematic(b.doc);
    const pv = placementOf(doc, v).id, p1 = placementOf(doc, r1).id, p2 = placementOf(doc, r2).id;
    assert.equal(ratsnest(doc).length, 3, 'IN, OUT, GND — по одному соединению');
    const wrong = addTrack(doc, { placementId: pv, pad: '1' }, { placementId: p2, pad: '2' });
    assert.match(wrong.error ?? '', /разные цепи/);
    assert.equal(wrong.doc, doc);
    for (const [a, c] of [[{ placementId: pv, pad: '1' }, { placementId: p1, pad: '1' }], [{ placementId: p1, pad: '2' }, { placementId: p2, pad: '1' }], [{ placementId: p2, pad: '2' }, { placementId: pv, pad: '2' }]] as const) {
      const r = addTrack(doc, a, c);
      assert.equal(r.error, null);
      doc = r.doc;
    }
    assert.equal(ratsnest(doc).length, 0);
    assert.deepEqual(checkIntegrity(doc), []);
    doc = deleteTrack(doc, doc.pcb.tracks[0]!.id);
    assert.equal(ratsnest(doc).length, 1);
  });

  test('перемещение и поворот корпуса перестраивают концы дорожек', () => {
    const { b, v, r1 } = divider();
    let { doc } = syncFromSchematic(b.doc);
    const pv = placementOf(doc, v).id, p1 = placementOf(doc, r1).id;
    doc = addTrack(doc, { placementId: pv, pad: '1' }, { placementId: p1, pad: '1' }).doc;
    doc = movePlacement(doc, p1, { x: 30, y: 25 });
    doc = rotatePlacement(doc, p1);
    const pad = allPads(doc).find((x) => x.ref.placementId === p1 && x.ref.pad === '1')!;
    assert.deepEqual(doc.pcb.tracks[0]!.points.at(-1), pad.pos);
  });
});

describe('Плата: DRC и вывод 1:1', () => {
  test('площадка за краем платы и пересечение дорожек разных цепей — ошибки', () => {
    const { b, v, r1, r2 } = divider();
    let { doc } = syncFromSchematic(b.doc);
    doc = setBoard(doc, 60, 40);
    const p1 = placementOf(doc, r1).id;
    doc = movePlacement(doc, p1, { x: 58, y: 20 });
    assert.ok(drc(doc).some((i) => /за краем/.test(i.message)));
    doc = movePlacement(doc, p1, { x: 10, y: 20 });
    const pv = placementOf(doc, v).id, p2 = placementOf(doc, r2).id;
    // Дорожки IN (V1.1–R1.1) и OUT (R1.2–R2.1) проложим так, чтобы они пересеклись
    doc = movePlacement(doc, pv, { x: 20, y: 30 });
    doc = movePlacement(doc, p2, { x: 5, y: 32 });
    doc = addTrack(doc, { placementId: pv, pad: '1' }, { placementId: p1, pad: '1' }).doc;
    doc = addTrack(doc, { placementId: p1, pad: '2' }, { placementId: p2, pad: '1' }).doc;
    const issues = drc(doc);
    assert.ok(issues.some((i) => i.severity === 'error' && /Дорожки разных цепей|Зазор/.test(i.message)), JSON.stringify(issues.map((i) => i.message)));
  });

  test('дорожка, ставшая «чужой» после изменения схемы, не удаляется, а показывается в отчёте и DRC', () => {
    const { b, v, r1 } = divider();
    let { doc } = syncFromSchematic(b.doc);
    const pv = placementOf(doc, v).id, p1 = placementOf(doc, r1).id;
    doc = addTrack(doc, { placementId: pv, pad: '1' }, { placementId: p1, pad: '1' }).doc;
    // Удалим провод V1+ — R1.1 в схеме
    const wire = doc.schematic.wires.find((w) => touches(w, v))!;
    doc = deleteWire(doc, wire.id);
    assert.deepEqual(checkIntegrity(doc), [], 'дорожка исчезнувшей цепи не мешает сохранению');
    const s = syncFromSchematic(doc);
    assert.equal(s.doc.pcb.tracks.length, 1, 'дорожка сохранена');
    assert.ok(s.report.problems.some((m) => /разные цепи/.test(m)));
    assert.ok(drc(s.doc).some((i) => /разные цепи/.test(i.message)));
  });

  test('SVG: размеры в мм, калибровочный квадрат 10 мм, вид со стороны меди зеркалится', () => {
    const { b } = divider();
    let { doc } = syncFromSchematic(b.doc);
    doc = setBoard(doc, 50, 30);
    const top = copperSvg(doc, { copperSide: false });
    const bottom = copperSvg(doc, { copperSide: true });
    assert.match(top, /width="\d+(\.\d+)?mm"/);
    assert.match(top, /<rect x="[\d.]+" y="[\d.]+" width="10" height="10"/);
    assert.match(top, /<rect x="5" y="5" width="50" height="30"/, 'контур платы 50×30 мм');
    assert.doesNotMatch(top, /scale\(-1 1\)/);
    assert.match(bottom, /scale\(-1 1\)/);
    assert.equal((top.match(/<ellipse/g) ?? []).length, 6, '3 детали × 2 площадки');
  });
});
