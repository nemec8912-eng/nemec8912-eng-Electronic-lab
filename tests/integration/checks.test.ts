/** Тест работоспособности на настоящем ngspice: условия на примерах, итог «работает / не работает». */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { addCheck, describeCheck, newCheck, updateCheck } from '../../src/core/checks';
import type { Check, ProjectDoc } from '../../src/core/model';
import { remapIds } from '../../src/core/remap';
import { runChecks } from '../../src/sim/checks';
import { readElab } from '../../src/storage/elab';
import { ngspiceForTests, requireNgspice } from '../sim-helpers';

const NG = ngspiceForTests();
const skip = !NG && !requireNgspice ? 'ngspice не найден' : false;
const loadRaw = async (f: string) => (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples', f)))).doc;
/** Пример без его собственных условий (тесты задают свои). */
const load = async (f: string): Promise<ProjectDoc> => { const d = await loadRaw(f); return { ...d, checks: { items: [], noOverload: true } }; };
const pin = (d: ProjectDoc, ref: string, p: string) => ({ instanceId: d.schematic.instances.find((i) => i.refDes === ref)!.id, pin: p });
const add = (d: ProjectDoc, c: Partial<Check> & Pick<Check, 'quantity'>) => addCheck(d, { ...newCheck(c.quantity), ...c });

describe('Тест работоспособности (ngspice)', { skip }, () => {
  for (const f of ['пример-светодиод.elab', 'пример-rc-фильтр.elab', 'пример-мультивибратор-ne555.elab', 'пример-стабилизатор-lm317.elab', 'пример-металлоискатель.elab']) {
    test(`${f}: условия работоспособности примера выполнены`, async () => {
      const d = await loadRaw(f);
      assert.ok(d.checks.items.length > 0);
      const r = await runChecks(d, NG);
      assert.equal(r.verdict, 'works', JSON.stringify({ summary: r.summary, errors: r.errors, outcomes: r.outcomes, overload: r.overload }));
    });
  }

  test('LM317: 5 В на выходе — работает; завышенное требование — не работает; замер вне диапазона виден', async () => {
    let d = await load('пример-стабилизатор-lm317.elab');
    d = add(d, { name: 'Выход 5 В', quantity: 'dc-v', at: pin(d, 'DA1', '2'), min: 4.8, max: 5.2, measured: 4.95 });
    d = add(d, { name: 'Ток нагрузки', quantity: 'dc-i', at: pin(d, 'R3', '1'), min: 0.001 });
    let r = await runChecks(d, NG);
    assert.equal(r.verdict, 'works', JSON.stringify(r));
    assert.match(r.summary, /^Работает: выполнены все условия \(2\)/);
    assert.ok(Math.abs(r.outcomes[0]!.value! - 5.04) < 0.05, `U = ${r.outcomes[0]!.value}`);
    assert.equal(r.outcomes[0]!.measuredStatus, 'pass');
    assert.match(describeCheck(d, d.checks.items[0]!), /Выход 5 В: постоянное напряжение .* DA1\.2 относительно земли — от 4,8 В до 5,2 В/);

    d = updateCheck(d, d.checks.items[0]!.id, { min: 5.5, max: 6 });
    r = await runChecks(d, NG);
    assert.equal(r.verdict, 'fails');
    assert.equal(r.outcomes[0]!.status, 'fail');
    assert.equal(r.outcomes[0]!.measuredStatus, 'fail');
    assert.match(r.summary, /Не работает: выполнено 1 из 2/);
  });

  test('NE555: генератор — частота 6,9 кГц и размах на выходе; без генерации — «не работает»', async () => {
    let d = await load('пример-мультивибратор-ne555.elab');
    d = add(d, { quantity: 'tran-freq', at: pin(d, 'DA1', '3'), min: 6500, max: 7300 });
    d = add(d, { quantity: 'tran-vpp', at: pin(d, 'DA1', '3'), min: 3 });
    let r = await runChecks(d, NG);
    assert.equal(r.verdict, 'works', JSON.stringify(r));
    // На выводе 1 (земля) сигнала нет: частота не выполняется (а не «не посчитано»)
    d = add(d, { quantity: 'tran-freq', at: pin(d, 'DA1', '1'), min: 1000 });
    r = await runChecks(d, NG);
    assert.equal(r.outcomes[2]!.status, 'fail');
    assert.match(r.outcomes[2]!.reason ?? '', /генерации нет/);
  });

  test('RC-фильтр: коэффициент передачи на частоте среза ≈ 0,707', async () => {
    let d = await load('пример-rc-фильтр.elab');
    const fc = 1 / (2 * Math.PI * 10_000 * 100e-9);
    d = add(d, { quantity: 'ac-gain', at: pin(d, 'C1', '1'), input: pin(d, 'G1', '+'), freqHz: fc, min: 0.69, max: 0.72 });
    const r = await runChecks(d, NG);
    assert.equal(r.verdict, 'works', JSON.stringify(r));
    assert.ok(Math.abs(r.outcomes[0]!.value! - Math.SQRT1_2) < 0.01);
  });

  test('не посчитано: пустое условие и удалённая деталь — итог «не всё проверено»; переназначение UUID сохраняет ссылки', async () => {
    let d = await load('пример-светодиод.elab');
    d = add(d, { quantity: 'dc-v', at: null, min: 1 });
    d = add(d, { quantity: 'dc-v', at: { instanceId: '00000000-0000-4000-8000-00000000abcd', pin: '1' }, min: 1 });
    d = add(d, { quantity: 'dc-v', at: pin(d, 'HL1', '2'), min: 1.5, max: 2.5 });
    let r = await runChecks(d, NG);
    assert.equal(r.verdict, 'unknown');
    assert.deepEqual(r.outcomes.map((o) => o.status), ['na', 'na', 'pass']);
    assert.match(r.outcomes[1]!.reason!, /удалена/);
    const copy = remapIds(d).doc;
    assert.notEqual(copy.checks.items[2]!.at!.instanceId, d.checks.items[2]!.at!.instanceId);
    r = await runChecks(copy, NG);
    assert.equal(r.outcomes[2]!.status, 'pass');
  });

  test('перегрузка деталей — «не работает», если включено «без перегрузки»', async () => {
    let d = await load('пример-светодиод.elab');
    d = { ...d, schematic: { ...d.schematic, instances: d.schematic.instances.map((i) => (i.refDes === 'R1' ? { ...i, values: { ...i.values, resistance: { value: 100, unit: 'Ω' } } } : i)) } };
    let r = await runChecks(d, NG);
    assert.equal(r.verdict, 'fails');
    assert.ok(r.overload.length > 0);
    d = { ...d, checks: { ...d.checks, noOverload: false } };
    r = await runChecks(d, NG);
    assert.equal(r.verdict, 'empty');
  });
});
