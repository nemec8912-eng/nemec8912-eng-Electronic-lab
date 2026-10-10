import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PackageDefSchema } from '../../src/core/model';
import { FAMILIES, generatePackage } from '../../src/core/packages';
import { newId } from '../../src/core/ids';

describe('Генераторы корпусов', () => {
  test('каждое семейство с параметрами по умолчанию даёт корректный корпус без повторов номеров', () => {
    for (const f of FAMILIES) {
      const t = generatePackage(f.id);
      const r = PackageDefSchema.safeParse({ ...t, id: newId() });
      assert.ok(r.success, `${f.id}: ${JSON.stringify(!r.success && r.error.issues[0])}`);
      const nums = t.pads.map((p) => p.number);
      assert.equal(new Set(nums).size, nums.length, `${f.id}: повтор номера площадки`);
      assert.equal(t.mount, f.mount);
      if (t.pads.length > 2) assert.ok(t.pin1Marker, `${f.id}: нет ключа первого вывода`);
      if (f.mount === 'THT') assert.ok(t.pads.every((p) => p.drill), `${f.id}: у выводного корпуса нет отверстий`);
      else assert.ok(t.pads.every((p) => p.drill === null), `${f.id}: у SMD есть отверстия`);
    }
  });

  test('DIP-8: вывод 1 квадратный слева сверху, нумерация против часовой стрелки, вывод 8 напротив вывода 1', () => {
    const t = generatePackage('DIP', { pins: 8 });
    const at = (n: string) => t.pads.find((p) => p.number === n)!;
    assert.equal(at('1').shape, 'rect');
    assert.deepEqual([at('1').x, at('1').y], [0, 0]);
    assert.deepEqual([at('4').x, at('4').y], [0, 7.62]);
    assert.deepEqual([at('5').x, at('5').y], [7.62, 7.62]);
    assert.deepEqual([at('8').x, at('8').y], [7.62, 0]);
    assert.equal(t.pitchMm, 2.54);
    assert.match(t.pin1Marker ?? '', /выемка/);
  });

  test('QFP-32: по 8 выводов на сторону, против часовой стрелки; QFN с теплоотводом получает вывод 17', () => {
    const q = generatePackage('QFP', { pins: 32, pitch: 0.8 });
    assert.equal(q.pads.length, 32);
    const p1 = q.pads[0]!, p9 = q.pads[8]!, p17 = q.pads[16]!, p25 = q.pads[24]!;
    assert.ok(p1.x < 0 && p1.y < 0, 'вывод 1 — левая сторона, вверху');
    assert.ok(p9.y > 0, 'вывод 9 — нижняя сторона');
    assert.ok(p17.x > 0, 'вывод 17 — правая сторона');
    assert.ok(p25.y < 0, 'вывод 25 — верхняя сторона');
    const n = generatePackage('QFN', { pins: 16, ep: 1.7 });
    assert.equal(n.pads.length, 17);
    assert.equal(n.pads.at(-1)!.number, '17');
  });

  test('BGA: имена шариков без I, O, Q, S; A1 — левый верхний', () => {
    const b = generatePackage('BGA', { rows: 10, cols: 2 });
    const rows = [...new Set(b.pads.map((p) => p.number.replace(/\d+$/, '')))];
    assert.deepEqual(rows, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K']);
    const a1 = b.pads.find((p) => p.number === 'A1')!;
    assert.ok(a1.x < 0 && a1.y < 0);
  });

  test('недопустимые параметры — понятная ошибка', () => {
    assert.throws(() => generatePackage('DIP', { pins: 7 }), /чётным|целое/);
    assert.throws(() => generatePackage('QFP', { pins: 30 }), /делиться на 4|целое/);
    assert.throws(() => generatePackage('AXIAL', { pitch: 5, bodyL: 6 }), /длиннее/);
    assert.throws(() => generatePackage('НЕТ'), /Неизвестное/);
  });
});
