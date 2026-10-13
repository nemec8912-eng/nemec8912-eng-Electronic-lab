/** Авторасстановка и автотрассировка: всё разведено, DRC чист, медь разных цепей разделяется фрезой. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { autoplace } from '../../src/core/autoplace';
import { autoroute, missingConnections } from '../../src/core/autoroute';
import { cncPlan } from '../../src/core/cnc';
import { allPads, drc, movePlacement, rotatePlacement, setBoard, syncFromSchematic } from '../../src/core/pcb';
import { Builder, p } from '../sim-helpers';
import { readElab } from '../../src/storage/elab';

const load = async (f: string) => (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples', f)))).doc;

describe('Авторасстановка и автотрассировка', () => {
  for (const f of ['пример-светодиод.elab', 'пример-rc-фильтр.elab', 'пример-мультивибратор-ne555.elab', 'пример-стабилизатор-lm317.elab']) {
    test(`${f}: расставить и развести заново — DRC без ошибок, все соединения есть, ЧПУ без ошибок`, async () => {
      let d = await load(f);
      d = { ...d, pcb: { ...d.pcb, tracks: [] } };
      const p = autoplace(d);
      assert.deepEqual(p.notPlaced, []);
      const r = autoroute(p.doc);
      assert.deepEqual(r.failed, [], JSON.stringify(r.failed));
      assert.equal(missingConnections(r.doc).length, 0);
      assert.deepEqual(drc(r.doc).filter((i) => i.severity === 'error').map((i) => i.message), []);
      assert.deepEqual(cncPlan(r.doc).issues.filter((i) => i.severity === 'error'), []);
      assert.ok(r.doc.changelog.at(-1)!.summary.startsWith('Автотрассировка'));
    });
  }

  test('узкие места: между выводами DIP — только при тонких правилах (дорожка 0,3 мм, зазор 0,25 мм)', () => {
    // R1 слева от DIP-14, R2 справа; обойти микросхему нельзя — плата по её высоте
    const b = new Builder('DIP');
    const u = b.part('CD4069UB', 200, 0), r1 = b.place('R', 0, 0), r2 = b.place('R', 400, 0);
    b.wire(p(r1, '2'), p(r2, '1'));
    let d = syncFromSchematic(b.doc).doc;
    const pl = (i: string) => d.pcb.placements.find((x) => x.instanceId === i)!.id;
    d = setBoard(d, { widthMm: 48.26, heightMm: 17.78, rules: { edgeMm: 0.45 } }).doc;
    d = movePlacement(d, pl(u), { x: 20.32, y: 1.27 });
    d = rotatePlacement(rotatePlacement(d, pl(r1)), pl(r2));
    d = movePlacement(movePlacement(d, pl(r1), { x: 7.62, y: 2.54 }), pl(r2), { x: 40.64, y: 2.54 });
    assert.deepEqual(drc(d).filter((i) => i.severity === 'error').map((i) => i.message), []);
    const lut = autoroute(d, { jumpers: false });
    assert.equal(lut.failed.length, 1, 'дорожка 0,4 мм при зазоре 0,4 мм между выводами DIP не проходит');
    const fine = setBoard(d, { rules: { trackMm: 0.5, minTrackMm: 0.3, clearanceMm: 0.25 } }).doc;
    const r = autoroute(fine, { jumpers: false });
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.doc.pcb.tracks.map((t) => t.widthMm), [0.3], 'узкая дорожка там, где обычная не прошла');
    // Дорожка действительно идёт между выводами: пересекает оба ряда DIP
    const xs = r.doc.pcb.tracks[0]!.points.map((q) => q.x);
    assert.ok(Math.min(...xs) < 20.32 && Math.max(...xs) > 27.94);
    assert.deepEqual(drc(r.doc).filter((i) => i.severity === 'error').map((i) => i.message), []);
    assert.ok(allPads(r.doc).length === 18);
  });

  test('авторасстановка плотнее, если не помещается: металлоискатель на 60 × 45 мм', async () => {
    const d0 = await load('пример-металлоискатель.elab');
    const d = setBoard({ ...d0, pcb: { ...d0.pcb, tracks: [], vias: [], jumpers: [] } }, { widthMm: 60, heightMm: 45 }).doc;
    const pl = autoplace(d);
    assert.deepEqual(pl.notPlaced, []);
    assert.deepEqual(drc(pl.doc).filter((i) => i.code === 'overlap' || i.code === 'edge'), []);
  });
});
