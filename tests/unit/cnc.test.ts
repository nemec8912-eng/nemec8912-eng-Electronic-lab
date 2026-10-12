/**
 * Фрезерование на ЧПУ: G-code проверяется независимым разборщиком и «выфрезеровывается» на растре.
 * Главное свойство: медь не задета, а медь разных цепей после изоляции разделена.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { cncPlan, isoWidth, setCnc, translit } from '../../src/core/cnc';
import type { ProjectDoc } from '../../src/core/model';
import { CURRENT_SCHEMA_VERSION, DEFAULT_CNC } from '../../src/core/model';
import { allPads, boardPolygon, padShape, setBoard, trackShapes, type Layer, type Shape } from '../../src/core/pcb';
import { distToShape } from '../../src/core/field';
import { readElab } from '../../src/storage/elab';
import { parseGcode, Removal } from '../gcode-sim';

const load = async (f: string) => (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples', f)))).doc;

/** Медь слоя в координатах станка. */
function machineCopper(doc: ProjectDoc, layer: Layer, mirror: boolean): Array<{ s: Shape; net: string }> {
  const b = doc.pcb.board!, M = doc.pcb.cnc.marginMm;
  const map = (s: Shape): Shape => ({ ...s, pts: s.pts.map((p) => ({ x: M + (mirror ? b.widthMm - p.x : p.x), y: M + (b.heightMm - p.y) })) });
  const out: Array<{ s: Shape; net: string }> = [];
  for (const p of allPads(doc)) if (p.layers.includes(layer)) out.push({ s: map(padShape(p)), net: p.netId ?? `free:${p.refDes}.${p.ref.pad}` });
  for (const t of doc.pcb.tracks) if (t.layer === layer) for (const s of trackShapes(t)) out.push({ s: map(s), net: t.netId });
  return out;
}

function checkIsolation(doc: ProjectDoc, gcode: string, layer: Layer, mirror: boolean) {
  const s = doc.pcb.cnc;
  const g = parseGcode(gcode);
  assert.deepEqual(g.errors, []);
  const plan = { w: doc.pcb.board!.widthMm + 2 * s.marginMm, h: doc.pcb.board!.heightMm + 2 * s.marginMm };
  const rm = new Removal(-1, -1, plan.w + 1, plan.h + 1, 0.02);
  const half = Math.tan((s.iso.angleDeg * Math.PI) / 360);
  rm.apply(g.moves, (z) => s.iso.tipMm / 2 + -z * half);
  // Все резы на одной глубине изоляции
  for (const m of g.moves) if (!m.rapid && m.z1 < 0) assert.ok(Math.abs(m.z1 + s.iso.depthMm) < 1e-6, `глубина ${m.z1}`);
  const copper = machineCopper(doc, layer, mirror);
  // 1) Фреза не заходит в медь (допуск 0,015 мм — шаг растра и аппроксимация)
  let cutCells = 0;
  for (let j = 0; j < rm.ny; j++) for (let i = 0; i < rm.nx; i++) {
    if (!rm.cut[j * rm.nx + i]) continue;
    cutCells++;
    const p = { x: rm.x0 + i * rm.step, y: rm.y0 + j * rm.step };
    for (const c of copper) assert.ok(distToShape(p, c.s) > -0.015, `рез задевает медь ${c.net} в точке ${p.x.toFixed(3)}; ${p.y.toFixed(3)}`);
  }
  assert.ok(cutCells > 1000, 'изоляция есть');
  // 2) Медь разных цепей разделена: у каждой площадки своя область, общая — только у одной цепи
  const lab = rm.regions();
  const regionNet = new Map<number, string>();
  for (const p of allPads(doc)) {
    if (!p.layers.includes(layer)) continue;
    const at = { x: doc.pcb.cnc.marginMm + (mirror ? doc.pcb.board!.widthMm - p.pos.x : p.pos.x), y: doc.pcb.cnc.marginMm + doc.pcb.board!.heightMm - p.pos.y };
    const r = lab[rm.cell(at.x, at.y)]!;
    assert.ok(r > 0, `${p.refDes}.${p.ref.pad}: площадка выфрезерована`);
    const net = p.netId ?? `free:${p.refDes}.${p.ref.pad}`;
    const had = regionNet.get(r);
    assert.ok(had === undefined || had === net, `${p.refDes}.${p.ref.pad}: медь соединена с другой цепью`);
    regionNet.set(r, net);
  }
  return { lab, rm };
}

describe('ЧПУ (GRBL)', () => {
  test('светодиод: изоляция, сверловка, обрезка — без ошибок, медь не задета, цепи разделены', async () => {
    const doc = await load('пример-светодиод.elab');
    assert.equal(doc.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(doc.pcb.cnc, DEFAULT_CNC, 'миграция v8 → v9 ставит настройки по умолчанию');
    assert.deepEqual(doc.checks, { items: [], noOverload: true });
    const plan = cncPlan(doc);
    assert.deepEqual(plan.issues.filter((i) => i.severity === 'error'), []);
    assert.deepEqual(plan.files.map((f) => f.name), ['1_isolation_bottom.nc', '2_drill_0.8mm.nc', '3_drill_1mm.nc', '4_cutout.nc']);
    for (const f of plan.files) assert.deepEqual(parseGcode(f.gcode).errors, [], f.name);
    const iso = plan.files[0]!;
    const { lab, rm } = checkIsolation(doc, iso.gcode, 'bottom', true);
    // Площадки одной цепи, соединённые дорожкой, — одна область меди
    const pads = allPads(doc);
    const M = doc.pcb.cnc.marginMm, W = doc.pcb.board!.widthMm, H = doc.pcb.board!.heightMm;
    const regionOf = (p: (typeof pads)[0]) => lab[rm.cell(M + W - p.pos.x, M + H - p.pos.y)];
    for (const a of pads) for (const b of pads) if (a.netId && a.netId === b.netId) assert.equal(regionOf(a), regionOf(b), `${a.refDes}.${a.ref.pad} и ${b.refDes}.${b.ref.pad} соединены дорожкой`);

    // Сверловка: все отверстия, зеркально, насквозь
    const holes = plan.files.filter((f) => f.name.includes('drill')).flatMap((f) => parseGcode(f.gcode).moves.filter((m) => m.z1 <= -(doc.pcb.cnc.thicknessMm + 0.3)).map((m) => ({ x: m.x1, y: m.y1 })));
    const want = pads.filter((p) => p.drill).map((p) => ({ x: M + W - p.pos.x, y: M + H - p.pos.y }));
    assert.equal(holes.length, want.length);
    for (const w of want) assert.ok(holes.some((h) => Math.hypot(h.x - w.x, h.y - w.y) < 0.002), `отверстие ${w.x}; ${w.y}`);

    // Обрезка: последний проход сквозной, путь на радиус фрезы от контура, перемычки на заданной высоте
    const cut = parseGcode(plan.files[3]!.gcode).moves.filter((m) => !m.rapid);
    const zMin = Math.min(...cut.map((m) => m.z1));
    assert.ok(zMin <= -doc.pcb.cnc.thicknessMm, `сквозной рез ${zMin}`);
    const tabTop = -(doc.pcb.cnc.thicknessMm - doc.pcb.cnc.cut.tabHeightMm);
    assert.ok(cut.some((m) => Math.abs(m.z1 - tabTop) < 1e-6 && (m.x0 !== m.x1 || m.y0 !== m.y1)), 'перемычки');
    const poly = boardPolygon(doc.pcb.board!).map((p) => ({ x: M + W - p.x, y: M + H - p.y }));
    const edge: Shape = { pts: poly, closed: true, r: 0 };
    for (const m of cut) if (m.z1 === zMin) assert.ok(Math.abs(distToShape({ x: m.x1, y: m.y1 }, edge) - doc.pcb.cnc.cut.toolMm / 2) < 0.02, 'фреза идёт снаружи контура на свой радиус');
  });

  test('заливка GND (NE555): изоляция вокруг заливки, площадки GND соединены заливкой, чужие — отделены', async () => {
    const doc = await load('пример-мультивибратор-ne555.elab');
    const plan = cncPlan(doc);
    assert.deepEqual(plan.issues.filter((i) => i.severity === 'error'), []);
    const { lab, rm } = checkIsolation(doc, plan.files[0]!.gcode, 'bottom', true);
    const gnd = doc.pcb.pours[0]!.netId;
    const M = doc.pcb.cnc.marginMm, W = doc.pcb.board!.widthMm, H = doc.pcb.board!.heightMm;
    const gp = allPads(doc).filter((p) => p.netId === gnd).map((p) => lab[rm.cell(M + W - p.pos.x, M + H - p.pos.y)]);
    assert.ok(gp.length >= 2 && new Set(gp).size === 1, 'все площадки GND в одной области — заливке');
  });

  test('двусторонняя: сторона A без зеркала, B зеркально, реперные отверстия на оси переворота', async () => {
    let doc = await load('пример-светодиод.elab');
    doc = setBoard(doc, { layers: 2 }).doc;
    const plan = cncPlan(doc);
    assert.deepEqual(plan.files.map((f) => `${f.side}:${f.name.replace(/_\d[.\d]*mm/, '')}`), ['A:1_isolation_top.nc', 'A:2_drill.nc', 'A:3_drill.nc', 'A:4_drill.nc', 'B:5_isolation_bottom.nc', 'B:6_cutout.nc']);
    checkIsolation(doc, plan.files[0]!.gcode, 'top', false);
    checkIsolation(doc, plan.files[4]!.gcode, 'bottom', true);
    const M = doc.pcb.cnc.marginMm, W = doc.pcb.board!.widthMm;
    const align = plan.files.find((f) => f.name.includes(`${DEFAULT_CNC.alignDrillMm}mm`))!;
    const pts = parseGcode(align.gcode).moves.filter((m) => m.z1 < -1).map((m) => m.x1);
    assert.equal(pts.length, 2);
    for (const x of pts) assert.ok(Math.abs(x - (M + W / 2)) < 1e-6, 'на оси переворота');
  });

  test('фреза шире зазора между цепями — ошибка «цепи замкнутся»; заготовка больше поля — ошибка', async () => {
    let doc = await load('пример-светодиод.elab');
    doc = setCnc(doc, { iso: { tool: 'endmill', diameterMm: 3 } }).doc;
    assert.equal(isoWidth(doc.pcb.cnc), 3);
    let plan = cncPlan(doc);
    assert.ok(plan.issues.some((i) => i.severity === 'error' && /замкнутся/.test(i.message)), JSON.stringify(plan.issues));
    doc = setCnc(doc, { iso: { tool: 'vbit' }, areaXMm: 30 }).doc;
    plan = cncPlan(doc);
    assert.ok(plan.issues.some((i) => /не помещается в рабочее поле/.test(i.message)));
    assert.match(setCnc(doc, { iso: { depthMm: 1 } }).error ?? '', /0,5 мм/);
    assert.equal(setCnc(doc, { spindle: -1 }).error, 'Значения должны быть числами не меньше нуля');
  });

  test('сверла из набора: отверстие берёт ближайшее не меньше себя; крупное — фрезеруется по кругу', async () => {
    let doc = await load('пример-стабилизатор-lm317.elab');
    doc = setCnc(doc, { drill: { sizes: [0.8, 1.0], millAboveMm: 1.05 } }).doc;
    const plan = cncPlan(doc);
    const drills = plan.files.filter((f) => f.name.includes('drill')).map((f) => f.name);
    assert.deepEqual(drills, ['2_drill_0.8mm.nc', '3_drill_1mm.nc']);
    assert.ok(plan.paths.some((p) => p.kind === 'hole'), 'крупные отверстия фрезеруются');
    assert.match(plan.files.at(-1)!.title, /крупн/);
  });

  test('комментарии и имена — только ASCII; readme по-русски с порядком файлов', async () => {
    assert.equal(translit('Пример — светодиод (9 В)'), 'Primer ? svetodiod 9 V');
    const plan = cncPlan(await load('пример-светодиод.elab'));
    for (const f of plan.files) { assert.match(f.name, /^[A-Za-z0-9_.]+$/); assert.ok(!/[^\x00-\x7f]/.test(f.gcode)); }
    assert.match(plan.readme, /Ноль станка: X0 Y0 — левый нижний угол заготовки/);
    for (const f of plan.files) assert.ok(plan.readme.includes(f.name));
  });
});
