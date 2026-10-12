/** Примеры проектов считаются на настоящем ngspice и дают ожидаемые по формулам значения. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import type { ProjectDoc } from '../../src/core/model';
import { netOfPin } from '../../src/core/schematic';
import { psuStates, scopeView, waveStats } from '../../src/sim/readings';
import { transfer } from '../../src/sim/results';
import { simulate } from '../../src/sim/simulate';
import { readElab } from '../../src/storage/elab';
import { DEFAULT_SCOPE } from '../../src/core/instruments';
import { ngspiceForTests, requireNgspice } from '../sim-helpers';

const NG = ngspiceForTests();
const skip = !NG && !requireNgspice ? 'ngspice не найден' : false;
const load = async (f: string) => (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples', f)))).doc;
const inst = (d: ProjectDoc, ref: string) => d.schematic.instances.find((i) => i.refDes === ref)!;

describe('Примеры проектов (ngspice)', { skip }, () => {
  test('светодиод: ток 14…16 мА, предел не превышен', async () => {
    const d = await load('пример-светодиод.elab');
    const r = await simulate(d, NG);
    assert.equal(r.status, 'ok', JSON.stringify(r.error ?? r.issues));
    const led = d.schematic.instances.find((i) => i.refDes.startsWith('HL'))!;
    const i = Object.values(r.op!.pins[led.id]!).map(Math.abs)[0]!;
    assert.ok(i > 0.014 && i < 0.016, `I = ${i}`);
    assert.equal(r.limits.length, 0);
  });

  test('RC-фильтр: АЧХ совпадает с формулой, fc = 159 Гц', async () => {
    const d = await load('пример-rc-фильтр.elab');
    const r = await simulate(d, NG);
    assert.equal(r.status, 'ok');
    const c = inst(d, 'C1');
    const out = netOfPin(d, { instanceId: c.id, pin: '1' })!.id, gnd = netOfPin(d, { instanceId: c.id, pin: '2' })!.id;
    const t = transfer(r.ac!, out, gnd, null);
    const fc = 1 / (2 * Math.PI * 10_000 * 100e-9);
    // На каждой точке частотного анализа |K| = 1/√(1 + (f/fc)²)
    r.ac!.freq.forEach((f, k) => assert.ok(Math.abs(t.mag[k]! - 1 / Math.hypot(1, f / fc)) < 1e-3, `|K| на ${f} Гц = ${t.mag[k]}`));
  });

  test('мультивибратор NE555: частота на выходе 6,9 кГц ± 5 %', async () => {
    const d = await load('пример-мультивибратор-ne555.elab');
    const r = await simulate(d, NG);
    assert.equal(r.status, 'ok', JSON.stringify(r.error ?? r.issues));
    const u = inst(d, 'DA1');
    const outNet = netOfPin(d, { instanceId: u.id, pin: '3' })!.id;
    const st = waveStats(r.tran!.time, r.tran!.node[outNet]!)!;
    const f0 = 1 / (Math.LN2 * (1000 + 2 * 10_000) * 10e-9);
    assert.ok(Math.abs(st.freq! - f0) / f0 < 0.05, `f = ${st.freq}, ожидалось ${f0}`);
    assert.ok(scopeView(d, r, { ...DEFAULT_SCOPE, ch1: { ...DEFAULT_SCOPE.ch1, pin: { instanceId: u.id, pin: '3' } }, timeDiv: 50e-6, trigger: { ...DEFAULT_SCOPE.trigger, level: 4 } })!.triggered);
  });

  test('стабилизатор LM317: 5,04 В на выходе, БП в режиме CV', async () => {
    const d = await load('пример-стабилизатор-lm317.elab');
    const r = await simulate(d, NG);
    assert.equal(r.status, 'ok');
    const u = inst(d, 'DA1');
    const vout = r.op!.node[netOfPin(d, { instanceId: u.id, pin: '2' })!.id]!;
    assert.ok(Math.abs(vout - (1.25 * (1 + 720 / 240) + 50e-6 * 720)) < 0.05, `Uвых = ${vout}`);
    assert.equal(psuStates(d, r)[0]!.mode, 'CV');
    assert.equal(d.tests.length, 1);
  });
});
