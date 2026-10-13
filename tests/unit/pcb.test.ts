import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { checkIntegrity } from '../../src/core/integrity';
import { loadDocument } from '../../src/core/migrations';
import { CURRENT_SCHEMA_VERSION, DEFAULT_RULES, type ProjectDoc, type Track } from '../../src/core/model';
import {
  addRoute, addTrack, addVia, allPads, deleteTrack, deleteVia, drc, edgeGap, findPad, flipPlacement, fmtLen, footprintBox,
  movePlacement, padsOf, parseLen, ratsnest, rotatePlacement, setBoard, setTrackWidth, shapeGap, syncFromSchematic, unroutedNets,
} from '../../src/core/pcb';
import { artworkSvg, assemblySvg, lutMirror } from '../../src/core/pcbExport';
import { copperField } from '../../src/core/cnc';
import { gerberFiles } from '../../src/core/gerber';
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
const pad = (doc: ProjectDoc, instanceId: string, n: string) => ({ kind: 'pad' as const, placementId: placementOf(doc, instanceId).id, pad: n });
const ok = <T extends { error: string | null }>(r: T): T => { assert.equal(r.error, null); return r; };
const board = (doc: ProjectDoc, patch: Parameters<typeof setBoard>[1]) => ok(setBoard(doc, patch)).doc;
const synced = () => { const d = divider(); return { ...d, doc: syncFromSchematic(d.b.doc).doc }; };

describe('Плата: перенос из схемы', () => {
  test('детали размещаются внутри платы без перекрытий, земля — нет; повторная синхронизация ничего не меняет', () => {
    const { b } = divider();
    const { doc, report } = syncFromSchematic(b.doc);
    assert.deepEqual(report.added.sort(), ['R1', 'R2', 'V1']);
    assert.deepEqual(report.notPlaced, []);
    assert.equal(report.hasChanges, true);
    assert.equal(doc.pcb.placements.length, 3);
    assert.equal(doc.pcb.board!.layers, 1);
    assert.deepEqual(doc.pcb.board!.rules, DEFAULT_RULES);
    const boxes = doc.pcb.placements.map((pl) => footprintBox(doc, pl));
    for (const bx of boxes) assert.ok(bx.x >= 0 && bx.y >= 0 && bx.x + bx.w <= 60 && bx.y + bx.h <= 40, JSON.stringify(bx));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, c = boxes[j]!;
      assert.ok(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y, 'детали не перекрываются');
    }
    assert.deepEqual(checkIntegrity(doc), []);
    const again = syncFromSchematic(doc);
    assert.equal(again.doc, doc, 'без изменений схемы документ тот же');
    assert.equal(again.report.hasChanges, false);
  });

  test('цепь площадки — через явное соответствие вывод ↔ площадка корпуса', () => {
    const { doc, v, r1 } = synced();
    const netOfPin = (inst: string, pin: string) => doc.schematic.nets.find((n) => n.connections.some((c) => c.instanceId === inst && c.pin === pin))!.id;
    const vPads = padsOf(doc, placementOf(doc, v));
    assert.equal(vPads.find((x) => x.ref.pad === '1')!.netId, netOfPin(v, '+'), 'площадка 1 клеммника — «+» источника');
    assert.equal(vPads.find((x) => x.ref.pad === '2')!.netId, netOfPin(v, '-'));
    const part = doc.library.parts.find((x) => x.category === 'resistor')!;
    const swapped: ProjectDoc = structuredClone(doc);
    swapped.library.parts.find((x) => x.id === part.id)!.packages[0]!.pinMap = [{ symbolPin: '1', pad: '2' }, { symbolPin: '2', pad: '1' }];
    const before = padsOf(doc, placementOf(doc, r1)), after = padsOf(swapped, placementOf(swapped, r1));
    assert.equal(after.find((x) => x.ref.pad === '1')!.netId, before.find((x) => x.ref.pad === '2')!.netId);
    assert.equal(after.find((x) => x.ref.pad === '2')!.netId, before.find((x) => x.ref.pad === '1')!.netId);
  });

  test('вывод, не сопоставленный площадке, попадает в отчёт', () => {
    const { doc, r1 } = synced();
    const broken: ProjectDoc = structuredClone(doc);
    const part = broken.library.parts.find((x) => x.id === broken.schematic.instances.find((i) => i.id === r1)!.partId)!;
    part.packages[0]!.pinMap = [{ symbolPin: '1', pad: '1' }];
    const s = syncFromSchematic(broken);
    assert.ok(s.report.problems.some((m) => /R1: вывод 2 .*не сопоставлен/.test(m)), s.report.problems.join('\n'));
  });

  test('удаление детали из схемы → при синхронизации уходит с платы вместе с её дорожками, с отчётом', () => {
    const { b, v, r1 } = divider();
    let { doc } = syncFromSchematic(b.doc);
    doc = ok(addTrack(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), layer: 'bottom', widthMm: 0.8 })).doc;
    doc = deleteInstance(doc, r1);
    assert.equal(doc.pcb.placements.length, 3, 'удаление в схеме само по себе плату не трогает');
    assert.deepEqual(checkIntegrity(doc), [], 'до синхронизации документ целостен — его можно сохранить');
    const s = syncFromSchematic(doc);
    assert.equal(s.report.removed.length, 1);
    assert.match(s.report.removed[0]!, /удалённая из схемы/);
    assert.equal(s.report.removedTracks, 1);
    assert.equal(s.doc.pcb.placements.length, 2);
    assert.deepEqual(checkIntegrity(s.doc), []);
  });

  test('смена корпуса детали: место и поворот сохраняются, дорожки к оставшимся площадкам — тоже; отчёт «изменено»', () => {
    let { doc, v, r1 } = synced();
    doc = ok(addTrack(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), layer: 'bottom', widthMm: 0.8 })).doc;
    doc = rotatePlacement(doc, placementOf(doc, r1).id);
    const before = placementOf(doc, r1);
    // У резисторов проекта — другой корпус (как после правки детали): вместо выводного 0,25 Вт — тот же корпус под новым id
    const changed: ProjectDoc = structuredClone(doc);
    const part = changed.library.parts.find((x) => x.id === changed.schematic.instances.find((i) => i.id === r1)!.partId)!;
    const oldPkg = changed.library.packages.find((x) => x.id === part.packages[0]!.packageId)!;
    const copy = { ...structuredClone(oldPkg), id: crypto.randomUUID(), name: `${oldPkg.name} (новый)`, pads: oldPkg.pads.filter((x) => x.number === '1').concat([{ ...oldPkg.pads[1]!, number: '3' }]) };
    changed.library.packages.push(copy);
    part.packages = [{ packageId: copy.id, pinMap: [{ symbolPin: '1', pad: '1' }, { symbolPin: '2', pad: '3' }] }];
    const s = syncFromSchematic(changed);
    assert.equal(s.report.changed.length, 2, s.report.changed.join('; '));
    assert.match(s.report.changed[0]!, /корпус .* → .*\(новый\)/);
    const after = placementOf(s.doc, r1);
    assert.deepEqual([after.position, after.rotation], [before.position, before.rotation]);
    assert.equal(after.packageId, copy.id);
    assert.equal(s.doc.pcb.tracks.length, 1, 'дорожка к площадке 1 сохранилась');
    assert.deepEqual(checkIntegrity(s.doc), []);
  });

  test('дорожка, ставшая «чужой» после изменения схемы, не удаляется, а показывается в отчёте и DRC', () => {
    let { doc, v, r1 } = synced();
    doc = ok(addTrack(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), layer: 'bottom', widthMm: 0.8 })).doc;
    const wire = doc.schematic.wires.find((w) => touches(w, v))!;
    doc = deleteWire(doc, wire.id);
    assert.deepEqual(checkIntegrity(doc), []);
    const s = syncFromSchematic(doc);
    assert.equal(s.doc.pcb.tracks.length, 1, 'дорожка сохранена');
    assert.ok(s.report.problems.some((m) => /разные цепи/.test(m)));
    assert.ok(drc(s.doc).some((i) => i.code === 'net'));
  });

  test('SMD-деталь на односторонней плате ставится со стороны меди (зеркально)', () => {
    const b = new Builder('SMD');
    const r = b.part('Резистор 0805 (0,125 Вт)', 0, 0);
    const s = syncFromSchematic(b.doc);
    const pl = placementOf(s.doc, r);
    assert.equal(pl.side, 'bottom');
    assert.ok(s.report.changed.some((m) => /SMD/.test(m)));
    const pads = padsOf(s.doc, pl);
    assert.deepEqual(pads.map((x) => x.layers), [['bottom'], ['bottom']]);
    assert.ok(pads.find((x) => x.ref.pad === '1')!.pos.x > pads.find((x) => x.ref.pad === '2')!.pos.x, 'снизу корпус виден зеркально: площадка 1 справа');
    const top = flipPlacement(s.doc, pl.id);
    assert.ok(drc(top).some((i) => i.code === 'layer' && /SMD-площадка на стороне без меди/.test(i.message)));
  });
});

describe('Плата: параметры, единицы', () => {
  test('размеры, слои, правила; на одностороннюю нельзя, пока есть верхний слой', () => {
    let { doc, v, r1 } = synced();
    assert.match(setBoard(doc, { widthMm: 0.5 }).error ?? '', /от 1 до 2000/);
    assert.equal(setBoard(doc, { widthMm: 1500 }).error, null, 'большая плата допустима');
    assert.match(setBoard(doc, { rules: { viaDrillMm: 2 } }).error ?? '', /больше сверла/);
    doc = board(doc, { layers: 2, units: 'inch', rules: { clearanceMm: 0.3 } });
    assert.equal(doc.pcb.board!.rules.clearanceMm, 0.3);
    assert.equal(doc.pcb.board!.rules.trackMm, DEFAULT_RULES.trackMm, 'остальные правила не меняются');
    doc = ok(addTrack(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), layer: 'top', widthMm: 0.8 })).doc;
    assert.match(setBoard(doc, { layers: 1 }).error ?? '', /верхнем слое 1 дорожек/);
  });

  test('единицы: разбор и вывод длины в мм и дюймах', () => {
    assert.equal(parseLen('1,6'), 1.6);
    assert.equal(parseLen('0.1"'), 2.54);
    assert.equal(parseLen('40 mil'), 1.016);
    assert.equal(parseLen('0,1', 'inch'), 2.54);
    assert.equal(parseLen('2 мм', 'inch'), 2);
    assert.equal(parseLen('abc'), null);
    assert.equal(fmtLen(2.54), '2,54 мм');
    assert.equal(fmtLen(2.54, 'inch'), '0,100″');
  });
});

describe('Плата: дорожки, переходы, связность', () => {
  test('дорожка только внутри одной цепи; ratsnest уменьшается до нуля', () => {
    let { doc, v, r1, r2 } = synced();
    assert.equal(ratsnest(doc).length, 3, 'IN, OUT, GND — по одному соединению');
    assert.equal(unroutedNets(doc).length, 3);
    const wrong = addTrack(doc, { from: pad(doc, v, '1'), to: pad(doc, r2, '2'), layer: 'bottom', widthMm: 0.8 });
    assert.match(wrong.error ?? '', /разные цепи/);
    assert.equal(wrong.doc, doc);
    assert.match(addTrack(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), layer: 'top', widthMm: 0.8 }).error ?? '', /медь только снизу/);
    for (const [a, c] of [[pad(doc, v, '1'), pad(doc, r1, '1')], [pad(doc, r1, '2'), pad(doc, r2, '1')], [pad(doc, r2, '2'), pad(doc, v, '2')]] as const) {
      doc = ok(addTrack(doc, { from: a, to: c, layer: 'bottom', widthMm: 0.8 })).doc;
    }
    assert.equal(ratsnest(doc).length, 0);
    assert.deepEqual(checkIntegrity(doc), []);
    doc = deleteTrack(doc, doc.pcb.tracks[0]!.id);
    assert.equal(ratsnest(doc).length, 1);
  });

  test('изгибы дорожки сохраняются при перемещении и повороте детали; концы следуют за площадками', () => {
    let { doc, v, r1 } = synced();
    const a = findPad(doc, pad(doc, v, '1'))!.pos;
    const bends = [{ x: a.x, y: 30 }, { x: 40, y: 30 }];
    doc = ok(addTrack(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), layer: 'bottom', widthMm: 0.8, bends })).doc;
    const p1 = placementOf(doc, r1).id;
    doc = movePlacement(doc, p1, { x: 30, y: 20 });
    doc = rotatePlacement(doc, p1);
    const t = doc.pcb.tracks[0]!;
    assert.deepEqual(t.points.slice(1, 3), bends, 'изгибы на месте');
    assert.deepEqual(t.points.at(-1), findPad(doc, pad(doc, r1, '1'))!.pos);
    assert.deepEqual(t.points[0], a);
    doc = setTrackWidth(doc, t.id, 1.2);
    assert.equal(doc.pcb.tracks[0]!.widthMm, 1.2);
  });

  test('двухсторонняя: трасса с переходом соединяет площадки; переход удаляется вместе с дорожками', () => {
    let { doc, v, r1 } = synced();
    assert.match(addVia(doc, { x: 20, y: 30 }, doc.schematic.nets[0]!.id).error ?? '', /только на двухсторонней/);
    doc = board(doc, { layers: 2 });
    const a = findPad(doc, pad(doc, v, '1'))!.pos, c = findPad(doc, pad(doc, r1, '1'))!.pos;
    const r = ok(addRoute(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), widthMm: 0.6, legs: [{ layer: 'top', bends: [{ x: a.x, y: 32 }] }, { layer: 'bottom', bends: [{ x: c.x, y: 32 }] }], vias: [{ x: 30, y: 32 }] }));
    doc = r.doc;
    assert.equal(doc.pcb.vias.length, 1);
    assert.equal(doc.pcb.tracks.length, 2);
    assert.deepEqual(doc.pcb.tracks.map((t) => t.layer), ['top', 'bottom']);
    assert.equal(doc.pcb.vias[0]!.diameterMm, DEFAULT_RULES.viaDiameterMm);
    assert.equal(unroutedNets(doc).some((n) => n.name === netOfV1(doc, v)), false, 'цепь V1+ разведена через переход');
    assert.deepEqual(checkIntegrity(doc), []);
    const del = deleteVia(doc, doc.pcb.vias[0]!.id);
    assert.equal(del.tracks, 2);
    assert.equal(del.doc.pcb.tracks.length, 0);
  });
});

const netOfV1 = (doc: ProjectDoc, v: string) => {
  const n = doc.schematic.nets.find((x) => x.connections.some((c) => c.instanceId === v && c.pin === '+'))!;
  return n.name ?? unroutedNets(doc).find((u) => u.netId === n.id)?.name;
};

describe('Плата: геометрия и DRC', () => {
  test('расстояния между фигурами: круг, прямоугольник, капсула', () => {
    const circle = (x: number, y: number, r: number) => ({ pts: [{ x, y }], closed: false, r });
    const rect = { pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }], closed: true, r: 0 };
    assert.ok(Math.abs(shapeGap(circle(5, 0.5, 1), rect) - 2) < 1e-9, 'от края прямоугольника по X');
    assert.ok(Math.abs(shapeGap(circle(3, 2, 0) , rect) - Math.SQRT2) < 1e-9, 'до угла');
    assert.ok(shapeGap(circle(1, 0.5, 0.1), rect) < 0, 'внутри — перекрытие');
    const seg = (y: number) => ({ pts: [{ x: 0, y }, { x: 10, y }], closed: false, r: 0.4 });
    assert.ok(Math.abs(shapeGap(seg(0), seg(1.1)) - 0.3) < 1e-9);
    assert.ok(Math.abs(edgeGap(circle(1, 5, 0.5), { widthMm: 10, heightMm: 10 }) - 0.5) < 1e-9);
  });

  const withTracks = (doc: ProjectDoc, gap: number, layers: ['top' | 'bottom', 'top' | 'bottom'] = ['bottom', 'bottom']) => {
    // Две дорожки разных цепей шириной 0,8 мм параллельно; расстояние между краями — gap.
    const nets = doc.pcb.tracks.length ? [] : doc.schematic.nets.slice(0, 2);
    const ends = allPads(doc).filter((x) => x.netId === nets[0]!.id || x.netId === nets[1]!.id);
    const mk = (net: string, y: number, layer: 'top' | 'bottom'): Track => {
      const e = ends.filter((x) => x.netId === net).slice(0, 2);
      return { id: crypto.randomUUID(), netId: net, layer, widthMm: 0.8, from: { kind: 'pad', ...e[0]!.ref }, to: { kind: 'pad', ...e[1]!.ref }, points: [{ x: 5, y }, { x: 40, y }] };
    };
    return { ...doc, pcb: { ...doc.pcb, tracks: [mk(nets[0]!.id, 34, layers[0]), mk(nets[1]!.id, 34 + 0.8 + gap, layers[1])] } };
  };

  test('зазор между дорожками: 0,3 мм — ошибка с числом, 0,5 мм — нет; на разных слоях не мешают; касание — короткое замыкание', () => {
    let { doc } = synced();
    doc = board(doc, { layers: 2 });
    const near = drc(withTracks(doc, 0.3)).filter((i) => i.code === 'clearance');
    assert.equal(near.length, 1, JSON.stringify(near));
    assert.match(near[0]!.message, /Зазор 0,3 мм < 0,4 мм: дорожка/);
    assert.equal(drc(withTracks(doc, 0.5)).filter((i) => i.code === 'clearance').length, 0);
    assert.equal(drc(withTracks(doc, 0.3, ['top', 'bottom'])).filter((i) => i.code === 'clearance' || i.code === 'short').length, 0);
    assert.ok(drc(withTracks(doc, -0.1)).some((i) => i.code === 'short' && /Короткое замыкание/.test(i.message)));
  });

  test('край платы, ширина дорожки, отверстие и поясок, деталь удалена из схемы, неразведённые цепи', () => {
    let { doc, r1, r2 } = synced();
    const p1 = placementOf(doc, r1).id;
    doc = movePlacement(doc, p1, { x: 58, y: 20 });
    assert.ok(drc(doc).some((i) => i.code === 'edge' && /выходит за край/.test(i.message)));
    doc = movePlacement(doc, p1, { x: 15, y: 25 });
    doc = board(doc, { rules: { minDrillMm: 1.0, minAnnularMm: 0.6 } });
    const issues = drc(doc);
    assert.ok(issues.some((i) => i.code === 'drill' && /меньше минимального 1 мм/.test(i.message)));
    assert.ok(issues.some((i) => i.code === 'annular'));
    assert.ok(issues.some((i) => i.code === 'unrouted' && /Не разведено: цепь/.test(i.message)));
    doc = board(doc, { rules: { minTrackMm: 1 , trackMm: 1 } });
    doc = { ...doc, pcb: { ...doc.pcb, tracks: [{ ...withTracks(doc, 2).pcb.tracks[0]!, widthMm: 0.5 }] } };
    assert.ok(drc(doc).some((i) => i.code === 'track-width'));
    doc = deleteInstance(doc, r2);
    assert.ok(drc(doc).some((i) => i.code === 'orphan'));
  });

  test('чистая разведённая плата — без ошибок', () => {
    let { doc, v, r1, r2 } = synced();
    for (const [a, c] of [[pad(doc, v, '1'), pad(doc, r1, '1')], [pad(doc, r1, '2'), pad(doc, r2, '1')], [pad(doc, r2, '2'), pad(doc, v, '2')]] as const) {
      doc = ok(addTrack(doc, { from: a, to: c, layer: 'bottom', widthMm: 0.8 })).doc;
    }
    const errors = drc(doc).filter((i) => i.severity === 'error');
    // Прямые дорожки могут пройти рядом с чужими площадками — здесь проверяется только отсутствие ложных ошибок цепей
    assert.equal(errors.filter((i) => i.code === 'net' || i.code === 'layer' || i.code === 'orphan').length, 0, JSON.stringify(errors));
    assert.equal(drc(doc).filter((i) => i.code === 'unrouted').length, 0);
  });
});

describe('Плата: вывод 1:1 для ЛУТ', () => {
  test('SVG в мм, квадрат 10 мм; нижний слой для ЛУТ — без зеркала, верхний — зеркально; переходы на обоих слоях', () => {
    let { doc, v, r1 } = synced();
    doc = board(doc, { widthMm: 50, heightMm: 30 });
    assert.equal(lutMirror('bottom'), false);
    assert.equal(lutMirror('top'), true);
    const bottom = artworkSvg(doc, { layer: 'bottom', mirror: false });
    assert.equal(bottom.widthMm, 50 + 5 * 3 + 10);
    assert.match(bottom.svg, new RegExp(`width="${bottom.widthMm}mm" height="${bottom.heightMm}mm" viewBox="0 0 ${bottom.widthMm} ${bottom.heightMm}"`));
    assert.match(bottom.svg, /width="10" height="10" fill="none" stroke="#000" stroke-width="0.2" data-calibration/);
    assert.match(bottom.svg, /<path d="M0 0H50V30H0Z" fill="none" stroke="#000" stroke-width="0.15" data-outline="1"/);
    assert.doesNotMatch(bottom.svg, /scale\(-1 1\)/);
    assert.match(bottom.svg, /для ЛУТ/);
    assert.equal((bottom.svg.match(/data-pad=/g) ?? []).length, 6, '3 детали × 2 площадки');
    const wrong = artworkSvg(doc, { layer: 'bottom', mirror: true });
    assert.match(wrong.svg, /НЕ для ЛУТ/);
    assert.match(wrong.svg, /translate\(50 0\) scale\(-1 1\)/);
    doc = board(doc, { layers: 2 });
    doc = ok(addRoute(doc, { from: pad(doc, v, '1'), to: pad(doc, r1, '1'), widthMm: 0.6, legs: [{ layer: 'top', bends: [] }, { layer: 'bottom', bends: [] }], vias: [{ x: 25, y: 25 }] })).doc;
    const top = artworkSvg(doc, { layer: 'top', mirror: true });
    assert.match(top.svg, /Верхний слой · зеркально — для ЛУТ/);
    assert.equal((top.svg.match(/data-via=/g) ?? []).length, 1);
    assert.equal((top.svg.match(/data-track=/g) ?? []).length, 1);
    assert.equal((artworkSvg(doc, { layer: 'bottom', mirror: false }).svg.match(/data-track=/g) ?? []).length, 1);
    assert.match(assemblySvg(doc).svg, />R1</);
  });
});

describe('Формат v6', () => {
  test('проект v5 с платой открывается: концы дорожек — площадки, правила по умолчанию, разводка та же', () => {
    const raw = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures/project-v5-pcb.json'), 'utf8'));
    const r = loadDocument(raw);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    if (!r.ok) return;
    assert.equal(r.migratedFrom, 5);
    assert.equal(r.doc.schemaVersion, CURRENT_SCHEMA_VERSION);
    const t = r.doc.pcb.tracks[0]!;
    assert.equal(t.from?.kind, 'pad');
    assert.deepEqual(t.points, raw.pcb.tracks[0].points);
    assert.deepEqual(r.doc.pcb.board!.rules, DEFAULT_RULES);
    assert.equal(r.doc.pcb.board!.units, 'mm');
    assert.equal(r.doc.pcb.placements.length, raw.pcb.placements.length);
    assert.equal(ratsnest(r.doc).length, 2, 'разведено одно соединение из трёх');
  });
});

// ---------- Форма платы и заливка ----------
import { normalizePolygon, outlineArea, outlineSvgPath, polygonProblem } from '../../src/core/outline';
import { addPour, deletePour, inIsland, isIsland, islandStrips, pourResults } from '../../src/core/pour';
import { setOutline } from '../../src/core/pcb';

describe('Плата: форма контура', () => {
  test('прямоугольник, скругление, круг, многоугольник: проверки, нормализация, площадь, путь SVG', () => {
    let { doc } = synced();
    assert.match(setOutline(doc, { kind: 'rounded', radiusMm: 25 }).error ?? '', /Радиус скругления больше половины/);
    const rounded = ok(setOutline(doc, { kind: 'rounded', radiusMm: 5 })).doc.pcb.board!;
    assert.ok(Math.abs(outlineArea(rounded) - (60 * 40 - (4 - Math.PI) * 25)) < 0.05, 'площадь со скруглениями');
    assert.match(outlineSvgPath(rounded), /^M5 0H55A5 5 0 0 1 60 5/);
    const circle = ok(setOutline(doc, { kind: 'circle' }, { widthMm: 30 })).doc.pcb.board!;
    assert.deepEqual([circle.widthMm, circle.heightMm], [30, 30]);
    assert.ok(Math.abs(outlineArea(circle) - Math.PI * 225) < 0.5, "дуга отрезками по 3°");
    // Круг остаётся кругом при смене размера
    const c2 = ok(setBoard(ok(setOutline(doc, { kind: 'circle' }, { widthMm: 30 })).doc, { heightMm: 44 })).doc.pcb.board!;
    assert.deepEqual([c2.widthMm, c2.heightMm], [44, 44]);
    assert.match(polygonProblem([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]) ?? '', /пересекаются/);
    assert.equal(polygonProblem([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'Нужно не меньше трёх точек');
    const n = normalizePolygon([{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 25 }, { x: 25, y: 35 }, { x: 5, y: 25 }]);
    assert.deepEqual([n.widthMm, n.heightMm, n.points[0]], [40, 30, { x: 0, y: 0 }]);
    doc = ok(setOutline(doc, { kind: 'polygon', points: [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 25 }, { x: 25, y: 35 }, { x: 5, y: 25 }] })).doc;
    assert.deepEqual([doc.pcb.board!.widthMm, doc.pcb.board!.heightMm], [40, 30]);
    // Масштаб многоугольника вместе с габаритом
    const big = ok(setBoard(doc, { widthMm: 80 })).doc.pcb.board!;
    assert.equal(big.outline.kind === 'polygon' && big.outline.points[1]!.x, 80);
  });

  test('деталь у срезанного угла многоугольника — за краем; расстановка учитывает форму', () => {
    let { doc, r1 } = synced();
    doc = ok(setOutline(doc, { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 30, y: 40 }, { x: 0, y: 40 }] })).doc;
    doc = movePlacement(doc, placementOf(doc, r1).id, { x: 48, y: 33 });
    assert.ok(drc(doc).some((i) => i.code === 'edge' && /R1/.test(i.message)), JSON.stringify(drc(doc).map((i) => i.message)));
    // Новая синхронизация на круглой плате кладёт детали внутрь круга
    const b = divider().b;
    let d2 = ok(setOutline(b.doc, { kind: 'circle' }, { widthMm: 50 })).doc;
    d2 = syncFromSchematic(d2).doc;
    assert.equal(drc(d2).filter((i) => i.code === 'edge').length, 0, JSON.stringify(drc(d2).filter((i) => i.code === 'edge').map((i) => i.message)));
  });
});

describe('Плата: медная заливка', () => {
  test('заливка соединяет площадки цепи; правила; остров; удаление', () => {
    let { doc, v, r2 } = synced();
    const gnd = findPad(doc, pad(doc, r2, '2'))!.netId!;
    assert.match(addPour(doc, { netId: gnd, layer: 'top', clearanceMm: 0.5 }).error ?? '', /медь только снизу/);
    assert.match(addPour(doc, { netId: gnd, layer: 'bottom', clearanceMm: 0.2 }).error ?? '', /не меньше общего зазора/);
    const before = unroutedNets(doc).length;
    doc = ok(addPour(doc, { netId: gnd, layer: 'bottom', clearanceMm: 0.5 })).doc;
    assert.match(addPour(doc, { netId: gnd, layer: 'bottom', clearanceMm: 0.5 }).error ?? '', /уже есть заливка/);
    assert.equal(unroutedNets(doc).length, before - 1, 'GND разведена заливкой');
    const r = pourResults(doc)[0]!;
    assert.ok(r.components.some((c) => c.keys.size >= 2));
    // Отгородим угол дорожкой другой цепи — получится остров
    const vin = findPad(doc, pad(doc, v, '1'))!.netId!;
    const fence: Track = { id: crypto.randomUUID(), netId: vin, layer: 'bottom', widthMm: 0.8, from: pad(doc, v, '1'), to: pad(doc, v, '1'), points: [{ x: 0, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 40 }] };
    const fenced = { ...doc, pcb: { ...doc.pcb, tracks: [...doc.pcb.tracks, fence] } };
    // Остров удаляется: в DRC не замечание, на станке и в Gerber — не медь
    const rf = pourResults(fenced)[0]!;
    assert.ok(rf.components.some(isIsland), 'остров есть');
    assert.ok(inIsland(rf, 3, 36));
    assert.ok(!inIsland(rf, 40, 10));
    assert.ok(!drc(fenced).some((i) => i.code === 'island'), JSON.stringify(drc(fenced).map((i) => i.message)));
    assert.ok(islandStrips(rf).length > 0);
    const cf = copperField(fenced, 'bottom', 1);
    const at = (x: number, y: number) => cf.d[Math.round((y - cf.y0) / cf.step) * cf.nx + Math.round((x - cf.x0) / cf.step)]!;
    assert.ok(at(3, 36) > 0, 'в острове меди нет');
    assert.ok(at(40, 10) <= 0, 'основная заливка — медь');
    const regions = (g: string) => (g.match(/G36\*/g) ?? []).length;
    const gb = gerberFiles(fenced).find((x) => x.name.endsWith('B_Cu.gbl'))!.content;
    const gbAll = gerberFiles(doc).find((x) => x.name.endsWith('B_Cu.gbl'))!.content;
    assert.ok(regions(gb) > regions(gbAll), 'вырезы островов в Gerber');
    assert.equal(deletePour(doc, doc.pcb.pours[0]!.id).pcb.pours.length, 0);
  });
});
