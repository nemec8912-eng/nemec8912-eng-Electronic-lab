import assert from 'node:assert/strict';
import { test } from 'node:test';
import { multimeter, setProbe, setTranSettings } from '../../src/core/instruments';
import { deleteInstance, moveInstance, setValue } from '../../src/core/schematic';
import { circuitKey } from '../../src/sim/key';
import { Builder, p } from '../sim-helpers';

test('щупы привязаны к выводам; удаление детали снимает её щупы', () => {
  const b = new Builder();
  const v = b.place('V', 0, 0), r = b.place('R', 100, 0);
  let d = setProbe(b.doc, 'red', p(r, '1'));
  d = setProbe(d, 'black', p(v, '-'));
  assert.deepEqual(multimeter(d), { red: p(r, '1'), black: p(v, '-') });
  assert.equal(setProbe(d, 'red', p(r, '1')), d, 'тот же вывод — без изменений');
  d = deleteInstance(d, r);
  assert.deepEqual(multimeter(d), { red: null, black: p(v, '-') });
});

test('электрический ключ: щупы и перемещение не меняют его, номинал и настройки расчёта — меняют', () => {
  const b = new Builder();
  const r = b.place('R', 0, 0);
  const k0 = circuitKey(b.doc);
  assert.equal(circuitKey(setProbe(b.doc, 'red', p(r, '1'))), k0);
  assert.equal(circuitKey(moveInstance(b.doc, r, { x: 200, y: 200 })), k0);
  assert.notEqual(circuitKey(setValue(b.doc, r, 'resistance', { value: 47, unit: 'Ω' })), k0);
  assert.notEqual(circuitKey(setTranSettings(b.doc, { stopS: 1 })), k0);
});
