/**
 * Экспорт платы для производства, проверка независимым читателем (tests/gerber-reader.ts):
 * масштаб и контур, площадки и их размеры, отверстия, маска, и главное — соответствие сетей:
 * медь растеризуется, связные области сравниваются с цепями схемы.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { gerberFiles } from '../../src/core/gerber';
import type { ProjectDoc } from '../../src/core/model';
import { addRoute, addTrack, allPads, drc, findPad, movePlacement, setBoard, syncFromSchematic } from '../../src/core/pcb';
import { copperRegions, Raster, readExcellon, readGerber } from '../gerber-reader';
import { Builder, p } from '../sim-helpers';

function layout(layers: 1 | 2, routeAll = true) {
  const b = new Builder('Экспорт');
  const v = b.place('V', 0, 100), r1 = b.place('R', 100, 0), r2 = b.place('R', 100, 200), g = b.place('GND', 0, 300);
  b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1')); b.wire(p(v, '-'), p(g, '1'));
  let d = syncFromSchematic(b.doc).doc;
  d = setBoard(d, { widthMm: 50, heightMm: 40, layers }).doc;
  const pl = (id: string) => d.pcb.placements.find((x) => x.instanceId === id)!.id;
  d = movePlacement(d, pl(v), { x: 10, y: 20 }); d = movePlacement(d, pl(r1), { x: 25, y: 10 }); d = movePlacement(d, pl(r2), { x: 25, y: 30 });
  const pad = (id: string, n: string) => ({ kind: 'pad' as const, placementId: pl(id), pad: n });
  const pos = (id: string, n: string) => findPad(d, pad(id, n))!.pos;
  const add = (a: ReturnType<typeof pad>, c: ReturnType<typeof pad>, bends: Array<{ x: number; y: number }>) => {
    const r = addTrack(d, { from: a, to: c, layer: 'bottom', widthMm: 0.8, bends });
    assert.equal(r.error, null); d = r.doc;
  };
  add(pad(v, '1'), pad(r1, '1'), [{ x: pos(v, '1').x, y: pos(r1, '1').y }]);
  add(pad(r1, '2'), pad(r2, '1'), [{ x: pos(r1, '2').x, y: 20.32 }, { x: pos(r2, '1').x, y: 20.32 }]);
  if (routeAll) {
    if (layers === 2) {
      const r = addRoute(d, { from: pad(r2, '2'), to: pad(v, '2'), widthMm: 0.8, vias: [{ x: 30.48, y: 36.83 }], legs: [{ layer: 'top', bends: [{ x: pos(r2, '2').x, y: 36.83 }] }, { layer: 'bottom', bends: [{ x: pos(v, '2').x, y: 36.83 }] }] });
      assert.equal(r.error, null); d = r.doc;
    } else add(pad(r2, '2'), pad(v, '2'), [{ x: pos(r2, '2').x, y: 36.83 }, { x: pos(v, '2').x, y: 36.83 }]);
  }
  return d;
}

const file = (files: ReturnType<typeof gerberFiles>, suffix: string) => {
  const f = files.find((x) => x.name.endsWith(suffix));
  assert.ok(f, `нет файла *${suffix}: ${files.map((x) => x.name).join(', ')}`);
  return f!.content;
};

/** Проверка соответствия сетей по растру: площадки одной цепи — одна область, разных — разные. */
function checkNets(doc: ProjectDoc, files: ReturnType<typeof gerberFiles>) {
  const B = doc.pcb.board!;
  const layers = [file(files, '-B_Cu.gbl')];
  if (B.layers === 2) layers.push(file(files, '-F_Cu.gtl'));
  const rasters = layers.map((t) => Raster.of(readGerber(t), B.widthMm, B.heightMm));
  const drill = readExcellon(file(files, '-PTH.drl'));
  const region = copperRegions(rasters, B.layers === 2 ? drill.hits : []);
  const byNet = new Map<string, Set<string>>();
  const byRegion = new Map<string, Set<string>>();
  for (const pd of allPads(doc)) {
    const r = region(pd.pos.x, B.heightMm - pd.pos.y);
    assert.ok(r, `${pd.refDes}.${pd.ref.pad}: нет меди в центре площадки`);
    const net = pd.netId ?? `нет:${pd.refDes}.${pd.ref.pad}`;
    byNet.set(net, (byNet.get(net) ?? new Set()).add(r!));
    byRegion.set(r!, (byRegion.get(r!) ?? new Set()).add(net));
  }
  return { byNet, byRegion };
}

describe('Gerber и Excellon: обратное чтение и сравнение с платой', () => {
  test('односторонняя: состав файлов, единицы, контур 50 × 40 мм, площадки и отверстия на своих местах', () => {
    const doc = layout(1);
    assert.equal(drc(doc).filter((i) => i.severity === 'error').length, 0, JSON.stringify(drc(doc).map((i) => i.message)));
    const files = gerberFiles(doc);
    assert.deepEqual(files.map((f) => f.name.replace(/^board-/, '')).sort(), ['B_Cu.gbl', 'B_Mask.gbs', 'Edge_Cuts.gm1', 'F_SilkS.gto', 'PTH.drl', 'readme.txt'].sort());
    const edge = readGerber(file(files, '-Edge_Cuts.gm1'));
    const xs = edge.draws.flatMap((d) => [d.x1, d.x2]), ys = edge.draws.flatMap((d) => [d.y1, d.y2]);
    assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 50, 0, 40]);
    assert.ok(edge.attributes.includes('TF.FileFunction,Profile,NP'));

    const cu = readGerber(file(files, '-B_Cu.gbl'));
    assert.equal(cu.units, 'mm');
    assert.ok(cu.attributes.includes('TF.FileFunction,Copper,L1,Bot'));
    const pads = allPads(doc);
    assert.equal(cu.flashes.length, pads.length);
    for (const pd of pads) {
      const f = cu.flashes.find((x) => Math.abs(x.x - pd.pos.x) < 1e-6 && Math.abs(x.y - (40 - pd.pos.y)) < 1e-6);
      assert.ok(f, `нет площадки ${pd.refDes}.${pd.ref.pad} в (${pd.pos.x}; ${40 - pd.pos.y})`);
      assert.deepEqual(f!.ap, { kind: 'C', d: pd.w }, 'размер площадки 1:1');
    }
    // Дорожки: ширина апертуры = ширина дорожки, суммарная длина совпадает
    const len = (pts: Array<{ x: number; y: number }>) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - pts[i]!.x, q.y - pts[i]!.y), 0);
    const want = doc.pcb.tracks.reduce((s, t) => s + len(t.points), 0);
    const got = cu.draws.reduce((s, d) => s + Math.hypot(d.x2 - d.x1, d.y2 - d.y1), 0);
    assert.ok(Math.abs(want - got) < 1e-6, `длина дорожек ${got} вместо ${want}`);
    assert.ok(cu.draws.every((d) => d.ap.kind === 'C' && d.ap.d === 0.8));

    const drill = readExcellon(file(files, '-PTH.drl'));
    assert.equal(drill.units, 'mm');
    assert.equal(drill.hits.length, pads.filter((x) => x.drill).length);
    for (const pd of pads) assert.ok(drill.hits.some((h) => Math.abs(h.x - pd.pos.x) < 1e-3 && Math.abs(h.y - (40 - pd.pos.y)) < 1e-3 && h.d === pd.drill));

    const mask = readGerber(file(files, '-B_Mask.gbs'));
    assert.equal(mask.flashes.length, pads.length);
    assert.ok(mask.flashes.every((f) => f.ap.kind === 'C' && Math.abs(f.ap.d - 1.9) < 1e-9), 'маска шире площадки на 0,05 мм с каждой стороны');
  });

  test('односторонняя: медь каждой цепи — одна связная область, разные цепи не касаются', () => {
    const doc = layout(1);
    const { byNet, byRegion } = checkNets(doc, gerberFiles(doc));
    for (const [net, regions] of byNet) assert.equal(regions.size, 1, `цепь ${net}: ${regions.size} областей`);
    for (const [region, nets] of byRegion) assert.equal(nets.size, 1, `область ${region} замыкает цепи ${[...nets].join(', ')}`);
    assert.equal(byNet.size, 3);
  });

  test('неразведённая цепь остаётся разорванной и в Gerber', () => {
    const doc = layout(1, false);
    const { byNet } = checkNets(doc, gerberFiles(doc));
    assert.deepEqual([...byNet.values()].map((s) => s.size).sort(), [1, 1, 2]);
  });

  test('двухсторонняя: верхний слой, переход в меди обоих слоёв и в сверловке; цепь GND собрана через переход', () => {
    const doc = layout(2);
    assert.equal(drc(doc).filter((i) => i.severity === 'error').length, 0, JSON.stringify(drc(doc).map((i) => i.message)));
    const files = gerberFiles(doc);
    const top = readGerber(file(files, '-F_Cu.gtl'));
    assert.ok(top.attributes.includes('TF.FileFunction,Copper,L1,Top'));
    assert.ok(readGerber(file(files, '-B_Cu.gbl')).attributes.includes('TF.FileFunction,Copper,L2,Bot'));
    const via = doc.pcb.vias[0]!;
    assert.ok(top.flashes.some((f) => f.ap.kind === 'C' && f.ap.d === via.diameterMm && Math.abs(f.x - via.position.x) < 1e-6));
    const drill = readExcellon(file(files, '-PTH.drl'));
    assert.ok(drill.hits.some((h) => h.d === via.drillMm && Math.abs(h.x - via.position.x) < 1e-3));
    const { byNet, byRegion } = checkNets(doc, files);
    for (const [, regions] of byNet) assert.equal(regions.size, 1);
    for (const [, nets] of byRegion) assert.equal(nets.size, 1);
    // Без металлизации перехода цепь GND распалась бы на две области
    const B = doc.pcb.board!;
    const rasters = [file(files, '-B_Cu.gbl'), file(files, '-F_Cu.gtl')].map((t) => Raster.of(readGerber(t), B.widthMm, B.heightMm));
    const noVia = copperRegions(rasters, drill.hits.filter((h) => h.d !== via.drillMm));
    const gnd = allPads(doc).filter((x) => x.netId === doc.pcb.tracks.find((t) => t.layer === 'top')!.netId);
    assert.equal(new Set(gnd.map((x) => noVia(x.pos.x, 40 - x.pos.y))).size, 2);
  });

  test('короткое замыкание на плате видно и в Gerber: DRC и растр согласны', () => {
    let doc = layout(1);
    const t = doc.pcb.tracks[0]!;
    // Дорожку IN проведём через площадку R2.1 (цепь OUT)
    const r2 = allPads(doc).find((x) => x.refDes === 'R2' && x.ref.pad === '1')!;
    doc = { ...doc, pcb: { ...doc.pcb, tracks: doc.pcb.tracks.map((x) => (x.id === t.id ? { ...x, points: [x.points[0]!, r2.pos, ...x.points.slice(1)] } : x)) } };
    assert.ok(drc(doc).some((i) => i.code === 'short'));
    const { byRegion } = checkNets(doc, gerberFiles(doc));
    assert.ok([...byRegion.values()].some((nets) => nets.size > 1));
  });
});
