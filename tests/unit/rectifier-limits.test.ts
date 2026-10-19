/** Выпрямительный диод: «допустимый ток» — средний; пики заряда конденсатора сравниваются с ударным током. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkLimits, type TranResult } from '../../src/sim/results';
import { Builder, p } from '../sim-helpers';

function setup() {
  const b = new Builder('Мост');
  const vd = b.part('1N4007', 0, 0), r = b.place('R', 200, 0), g = b.place('GND', 0, 200);
  b.wire(p(vd, '1'), p(r, '1')); b.wire(p(r, '2'), p(g, '1')); b.wire(p(vd, '2'), p(g, '1'));
  return { doc: b.doc, vd };
}
/** Ток диода (от вывода 1 к 2 — со знаком «минус» прямой): импульсы 3 А длительностью 10 % каждого периода. */
function tran(vd: string, peakA: number, duty: number): TranResult {
  const time: number[] = [], i: number[] = [];
  for (let k = 0; k <= 2000; k++) { const t = k * 1e-4; time.push(t); i.push(((t * 100) % 1) < duty ? -peakA : 0); }
  return { time, node: {}, current: { [vd]: i }, pins: {} };
}

describe('Пределы выпрямительного диода', () => {
  test('пики 3 А при среднем 0,3 А — норма; средний 1,5 А — перегрев; пик 40 А — больше ударного', () => {
    const { doc, vd } = setup();
    assert.deepEqual(checkLimits(doc, null, tran(vd, 3, 0.1)).map((l) => l.message), []);
    const hot = checkLimits(doc, null, tran(vd, 3, 0.5));
    assert.ok(hot.some((l) => /средний прямой ток 1,5 А больше допустимого 1 А/.test(l.message)), JSON.stringify(hot));
    const surge = checkLimits(doc, null, tran(vd, 40, 0.01));
    assert.ok(surge.some((l) => /импульсный ток 40 А больше ударного 30 А/.test(l.message)), JSON.stringify(surge));
  });
});
