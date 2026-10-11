/**
 * Эталонные расчёты на настоящем ngspice: результаты сверяются с аналитическими формулами.
 * В CI ngspice обязателен (ELAB_REQUIRE_NGSPICE=1): его отсутствие — ошибка, а не пропуск.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deleteInstance, setValue } from '../../src/core/schematic';
import { AppError } from '../../src/core/result';
import { netOfPin } from '../../src/core/schematic';
import { valueAt } from '../../src/sim/results';
import { runNgspice } from '../../src/sim/runner';
import { simulate } from '../../src/sim/simulate';
import { dividerCircuit, ngspiceForTests, p, rcCircuit, requireNgspice } from '../sim-helpers';

const NG = ngspiceForTests();
const skip = !NG && !requireNgspice ? 'ngspice не найден (ELAB_NGSPICE или vendor/ngspice)' : false;

const close = (actual: number, expected: number, relTol: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relTol + 1e-12, `${what}: ${actual} вместо ${expected} (допуск ${relTol * 100}%)`);

describe('Эталонные задачи ngspice', { skip }, () => {
  test('ngspice найден', () => assert.ok(NG, 'ngspice обязателен в CI'));

  test('делитель 10 В на 10 кОм / 10 кОм: 5 В, 0,5 мА, источник отдаёт 0,5 мА', async () => {
    const { doc, v, r1, r2 } = dividerCircuit();
    const res = await simulate(doc, NG, { tran: false });
    assert.equal(res.status, 'ok', JSON.stringify(res.error ?? res.issues));
    const mid = netOfPin(doc, p(r1, '2'))!.id;
    close(res.op!.node[mid]!, 5, 1e-6, 'V(out)');
    close(res.op!.current[r1]!, 0.5e-3, 1e-6, 'I(R1)');
    close(res.op!.current[r2]!, 0.5e-3, 1e-6, 'I(R2)');
    close(res.op!.current[v]!, -0.5e-3, 1e-6, 'I(V1) по соглашению ngspice');
    assert.deepEqual(res.limits, []);
    assert.match(res.engine.version ?? '', /^\d+/);
  });

  test('делитель 3:1 — проверка формулы Vout = V·R2/(R1+R2)', async () => {
    const { doc, r1 } = dividerCircuit(30_000, 10_000, 12);
    const res = await simulate(doc, NG, { tran: false });
    close(res.op!.node[netOfPin(doc, p(r1, '2'))!.id]!, 3, 1e-6, 'V(out)');
  });

  test('перегрузка резистора: 12 В на 100 Ом + 100 Ом → 0,36 Вт > 0,25 Вт', async () => {
    const { doc, r1, r2 } = dividerCircuit(100, 100, 12);
    const res = await simulate(doc, NG, { tran: false });
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.limits.map((l) => [l.instanceId, l.kind]).sort(), [[r1, 'power'], [r2, 'power']].sort());
    close(res.limits[0]!.value, 0.36, 1e-6, 'P');
    assert.match(res.limits[0]!.message, /риск перегрева.*без тепловой модели/);
  });

  test('заряд RC (τ = 1 мс) при включении: 63,2 % при t = τ, 99,3 % при 5τ; рабочая точка — 5 В', async () => {
    const { doc, c, r } = rcCircuit();
    const res = await simulate(doc, NG);
    assert.equal(res.status, 'ok', JSON.stringify(res.error ?? res.issues));
    const out = netOfPin(doc, p(c, '1'))!.id;
    const { time, node, current } = res.tran!;
    assert.ok(Math.abs(valueAt(time, node[out]!, 0)) < 5e-3, `Vc(0) ≈ 0: ${valueAt(time, node[out]!, 0)}`);
    close(valueAt(time, node[out]!, 1e-3), 5 * (1 - Math.exp(-1)), 0.005, 'Vc(τ)');
    close(valueAt(time, node[out]!, 5e-3), 5 * (1 - Math.exp(-5)), 0.005, 'Vc(5τ)');
    close(valueAt(time, current[r]!, 1e-3), 0.5e-3 * Math.exp(-1), 0.01, 'I(τ)');
    close(res.op!.node[out]!, 5, 1e-6, 'Vc в установившемся режиме');
    assert.ok(Math.abs(res.op!.current[c]!) < 1e-12, 'ток конденсатора в рабочей точке — 0');
  });

  test('без «включения при t = 0» переходный процесс начинается с заряженного конденсатора', async () => {
    const { doc, c } = rcCircuit();
    const d = { ...doc, simulation: { ...doc.simulation, tran: { ...doc.simulation.tran, startFromZero: false } } };
    const res = await simulate(d, NG);
    const out = netOfPin(doc, p(c, '1'))!.id;
    close(valueAt(res.tran!.time, res.tran!.node[out]!, 0), 5, 1e-6, 'Vc(0)');
  });

  test('напряжение на конденсаторе выше допустимого → «риск пробоя»', async () => {
    const { doc, v, c } = rcCircuit();
    const d = setValue(doc, v, 'voltage', { value: 63, unit: 'V' });
    const res = await simulate(d, NG, { tran: false });
    const w = res.limits.find((l) => l.instanceId === c);
    assert.ok(w && w.kind === 'voltage', JSON.stringify(res.limits));
    assert.match(w.message, /риск пробоя/);
  });

  test('схема с ошибкой не отправляется в ngspice, причина объяснена', async () => {
    const { doc, g } = rcCircuit();
    const res = await simulate(deleteInstance(doc, g), NG);
    assert.equal(res.status, 'blocked');
    assert.ok(res.issues.some((i) => i.code === 'no-ground'));
    assert.equal(res.op, null);
  });

  test('вырожденная схема (два источника параллельно) — понятная ошибка ngspice', async () => {
    const netlist = ['* singular', 'V1 a 0 DC 5', 'V2 a 0 DC 3', 'R1 a 0 1k', '.control', 'set filetype=ascii', 'op', 'write op.raw all', 'quit', '.endc', '.end', ''].join('\n');
    await assert.rejects(runNgspice(NG!, netlist, { expect: ['op'] }), (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, 'singular', e.message + (e.details ?? []).join('\n'));
      assert.ok((e.details ?? []).length > 0, 'вывод ngspice сохранён для диагностики');
      return true;
    });
  });

  test('таймаут: долгий расчёт прерывается', async () => {
    const netlist = ['* long', 'V1 a 0 SIN(0 1 1meg)', 'R1 a b 1k', 'C1 b 0 1n', '.control', 'set filetype=ascii', 'tran 1n 100m', 'write tran.raw all', 'quit', '.endc', '.end', ''].join('\n');
    await assert.rejects(runNgspice(NG!, netlist, { expect: ['tran'], timeoutMs: 300 }), (e: unknown) => e instanceof AppError && e.code === 'timeout');
  });
});

test('нет ngspice — честная ошибка вместо результата', async () => {
  const { doc } = rcCircuit();
  const res = await simulate(doc, null);
  assert.equal(res.status, 'failed');
  assert.equal(res.error!.code, 'no-simulator');
  await assert.rejects(runNgspice('/нет/такого/ngspice', '* x\n.end\n', { expect: ['op'] }), (e: unknown) => e instanceof AppError && e.code === 'no-simulator');
});
