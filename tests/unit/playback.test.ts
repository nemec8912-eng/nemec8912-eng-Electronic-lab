/**
 * Воспроизведение переходного процесса и индикаторы на схеме: интерполяция между точками ngspice,
 * шаги по точкам, скорость, стрелки условного тока (знаки как в results.ts), шкала потенциалов.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectDoc } from '../../src/core/model';
import {
  advance, flowArrows, frameAt, frameOfOp, indexAt, potentialColor, simSecondsPerSecond, speedText, stepPoint, voltageRange, ZERO_CURRENT_A,
} from '../../src/sim/playback';
import type { TranResult } from '../../src/sim/results';

const tran: TranResult = {
  time: [0, 1e-3, 2e-3, 4e-3],
  node: { a: [0, 1, 2, 4], gnd: [0, 0, 0, 0] },
  current: { r1: [0, 1e-3, -2e-3, 4e-3] },
  pins: { u1: { '1': [0, 1e-6, 2e-6, 3e-6], '2': [0, -1e-6, -2e-6, -3e-6] } },
};

/** Минимальный документ: R1 (два вывода), U1 (прибор с токами выводов). */
const doc = {
  schematic: { instances: [{ id: 'r1', partId: 'pr' }, { id: 'u1', partId: 'pu' }] },
  library: {
    parts: [{ id: 'pr', symbolId: 'sr' }, { id: 'pu', symbolId: 'su' }],
    symbols: [{ id: 'sr', pins: [{ number: '1' }, { number: '2' }] }, { id: 'su', pins: [{ number: '1' }, { number: '2' }, { number: '3' }] }],
  },
} as unknown as ProjectDoc;

test('номер точки: двоичный поиск и края', () => {
  assert.equal(indexAt(tran.time, -1), 0);
  assert.equal(indexAt(tran.time, 0), 0);
  assert.equal(indexAt(tran.time, 1.5e-3), 1);
  assert.equal(indexAt(tran.time, 2e-3), 2);
  assert.equal(indexAt(tran.time, 3.9e-3), 2);
  assert.equal(indexAt(tran.time, 9), 3);
  assert.equal(indexAt([], 1), -1);
});

test('кадр: в точке расчёта — точное значение, между точками — линейная интерполяция', () => {
  const f1 = frameAt(tran, 1e-3);
  assert.equal(f1.exact, true);
  assert.equal(f1.node.a, 1);
  assert.equal(f1.current.r1, 1e-3);
  const f = frameAt(tran, 3e-3); // между 2 мс (2 В) и 4 мс (4 В)
  assert.equal(f.exact, false);
  assert.equal(f.index, 2);
  assert.ok(Math.abs(f.node.a! - 3) < 1e-12);
  assert.ok(Math.abs(f.current.r1! - 1e-3) < 1e-15);
  assert.ok(Math.abs(f.pins.u1!['1']! - 2.5e-6) < 1e-18);
  assert.equal(frameAt(tran, 1).t, 4e-3, 'время прижимается к концу записи');
  assert.equal(frameAt(tran, 1).node.a, 4);
  assert.equal(frameAt(tran, -1).node.a, 0);
});

test('шаг по точкам расчёта вперёд и назад', () => {
  assert.equal(stepPoint(tran, 0, 1), 1e-3);
  assert.equal(stepPoint(tran, 1e-3, 1), 2e-3);
  assert.equal(stepPoint(tran, 1.5e-3, 1), 2e-3);
  assert.equal(stepPoint(tran, 4e-3, 1), 4e-3);
  assert.equal(stepPoint(tran, 2e-3, -1), 1e-3);
  assert.equal(stepPoint(tran, 1.5e-3, -1), 1e-3);
  assert.equal(stepPoint(tran, 0, -1), 0);
});

test('скорость: при ×1 весь расчёт — за 10 с; конец записи останавливает воспроизведение', () => {
  assert.ok(Math.abs(simSecondsPerSecond(tran, 1) - 4e-4) < 1e-15);
  assert.ok(Math.abs(simSecondsPerSecond(tran, 0.5) - 2e-4) < 1e-15);
  assert.deepEqual(advance(tran, 0, 1, 1), { t: 4e-4, done: false });
  assert.deepEqual(advance(tran, 3.9e-3, 1, 1), { t: 4e-3, done: true });
  assert.match(speedText(tran, 1), /^1 с на экране = 400 мкс схемы$/);
});

test('стрелки условного тока: знак тока задаёт направление, малые токи не показываются', () => {
  let arrows = flowArrows(doc, frameAt(tran, 1e-3));
  const r = arrows.find((a) => a.instanceId === 'r1')!;
  assert.deepEqual([r.from.pin, r.to?.pin], ['1', '2'], 'положительный ток — от вывода 1 к выводу 2');
  arrows = flowArrows(doc, frameAt(tran, 2e-3));
  const r2 = arrows.find((a) => a.instanceId === 'r1')!;
  assert.deepEqual([r2.from.pin, r2.to?.pin], ['2', '1'], 'отрицательный — наоборот');
  assert.equal(r2.amps, 2e-3);
  assert.equal(r2.label, '2 мА');
  assert.equal(r2.weight, 1, 'наибольший ток кадра — полная толщина');
  const u = arrows.filter((a) => a.instanceId === 'u1');
  assert.equal(u.length, 2);
  assert.equal(u.find((a) => a.from.pin === '1')!.inward, true, 'втекающий ток — внутрь');
  assert.equal(u.find((a) => a.from.pin === '2')!.inward, false);
  assert.ok(u[0]!.weight > 0 && u[0]!.weight < 1, 'ток в 1000 раз меньше — тоньше');
  assert.equal(flowArrows(doc, frameAt(tran, 0)).length, 0, 'нулевые токи — без стрелок');
  const tiny = frameOfOp({ node: {}, current: { r1: ZERO_CURRENT_A / 2 }, pins: {} });
  assert.equal(flowArrows(doc, tiny).length, 0);
});

test('шкала потенциалов: 0 В всегда серый, максимум — красный, минимум — синий', () => {
  const range = voltageRange(tran.node);
  assert.deepEqual(range, { min: 0, max: 4 });
  assert.deepEqual(voltageRange({ x: [-5, 3], y: 1 }), { min: -5, max: 3 });
  assert.equal(potentialColor(0, range), 'hsl(0 15% 55%)');
  assert.equal(potentialColor(4, range), 'hsl(0 85% 45%)');
  assert.equal(potentialColor(-5, { min: -5, max: 3 }), 'hsl(220 85% 45%)');
  assert.equal(potentialColor(NaN, range), 'hsl(0 0% 55%)');
});
