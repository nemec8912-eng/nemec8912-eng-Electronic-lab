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
  assert.deepEqual(multimeter(d), { red: p(r, '1'), black: p(v, '-'), mode: 'dcv' });
  assert.equal(setProbe(d, 'red', p(r, '1')), d, 'тот же вывод — без изменений');
  d = deleteInstance(d, r);
  assert.deepEqual(multimeter(d), { red: null, black: p(v, '-'), mode: 'dcv' });
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

// ---------- Этап 5 ----------
import { DEFAULT_SCOPE, esrMeter, scope, setMeterMode, setProbeTarget, setScope } from '../../src/core/instruments';
import { analysesFor, buildNetlist } from '../../src/sim/netlist';
import { meterReading, psuStates, scopeView, waveStats } from '../../src/sim/readings';
import type { SimResult } from '../../src/sim/results';
import type { ProjectDoc } from '../../src/core/model';

const divider = () => {
  const b = new Builder();
  const g = b.place('GND', 0, 300);
  const v = b.vsrc(10, 0, 100, g), r1 = b.res(10_000, 150, 0), r2 = b.res(10_000, 300, 150);
  b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
  return { b, v, r1, r2, g };
};

test('настройки приборов: щупы осциллографа и ESR-метра; повреждённые значения заменяются умолчаниями; удаление детали снимает все щупы', () => {
  const { b, r1, r2 } = divider();
  let d = setProbeTarget(b.doc, 'scope.ch1', p(r2, '1'));
  d = setProbeTarget(d, 'esr.red', p(r1, '1'));
  d = setProbeTarget(d, 'mm.red', p(r1, '2'));
  assert.deepEqual(scope(d).ch1.pin, p(r2, '1'));
  assert.deepEqual(esrMeter(d).red, p(r1, '1'));
  d = setScope(d, { timeDiv: -1 as number });
  assert.equal(scope(d).timeDiv, DEFAULT_SCOPE.timeDiv, 'отрицательная развёртка не принимается');
  const broken = { ...d, instruments: { ...d.instruments, settings: { ...d.instruments.settings, multimeter: { mode: 'kV', red: 5 } } } } as ProjectDoc;
  assert.deepEqual(multimeter(broken), { red: null, black: null, mode: 'dcv' });
  d = deleteInstance(d, r1);
  assert.equal(esrMeter(d).red, null);
  assert.equal(multimeter(d).red, null);
  assert.deepEqual(scope(d).ch1.pin, p(r2, '1'));
});

test('режим A меняет схему расчёта (ключ), режим V — нет', () => {
  const { b, r1 } = divider();
  const d = setProbe(b.doc, 'red', p(r1, '2'));
  const k = circuitKey(d);
  assert.equal(circuitKey(setMeterMode(d, 'acv')), k);
  assert.notEqual(circuitKey(setMeterMode(d, 'dca')), k);
});

test('netlist прибора: амперметр в разрыв, питание отключено, утечки, свободные выводы', () => {
  const { b, r1, r2 } = divider();
  const am = buildNetlist(b.doc, analysesFor(b.doc, 'op'), 't', { ammeter: p(r1, '2') });
  assert.match(am.text, /^v_meter (\S+) n_meter 0$/m);
  assert.match(am.text, /^R1 \S+ n_meter 10000$/m, 'вывод R1.2 подключён через амперметр');
  assert.equal(am.ammeterVector, 'i(v_meter)');
  const off = buildNetlist(b.doc, analysesFor(b.doc, 'op'), 't', { powerOff: true, leak: true, extra: (nodeOf) => [`i_meter ${nodeOf(p(r2, '2'))} ${nodeOf(p(r2, '1'))} DC 0.001`] });
  assert.doesNotMatch(off.text, /^V1 /m, 'источник убран');
  assert.match(off.text, /^r_leak1 \S+ 0 1e12$/m);
  assert.match(off.text, /^i_meter 0 \S+ DC 0.001$/m);
  assert.equal(off.issues.filter((i) => i.severity === 'error').length, 0);
  // Свободная деталь: в обычном расчёте — ошибка, при измерении — свои узлы
  const c = b.place('C', 500, 0);
  assert.ok(buildNetlist(b.doc, analysesFor(b.doc, 'op')).issues.some((i) => i.code === 'unconnected-pin'));
  let free: [string | null, string | null] = [null, null];
  const m = buildNetlist(b.doc, analysesFor(b.doc, 'op'), 't', { powerOff: true, leak: true, extra: (nodeOf) => { free = [nodeOf(p(c, '1')), nodeOf(p(c, '2'))]; return []; } });
  assert.equal(m.issues.filter((i) => i.severity === 'error').length, 0);
  assert.deepEqual(free, ['f1', 'f2']);
});

const tranResult = (doc: ProjectDoc, netId: string, t: number[], v: number[]): SimResult => ({
  status: 'ok', analysis: 'tran', revision: doc.revision, issues: [], error: null,
  op: { node: { [netId]: v[v.length - 1]! }, current: {}, pins: {} },
  tran: { time: t, node: { [netId]: v }, current: {}, pins: {} },
  dc: null, ac: null, sweep: null, limits: [], engine: { name: 'ngspice', version: '47' }, netlist: '', warnings: [], durationMs: 0,
} as unknown as SimResult);

test('мультиметр по переходному процессу: V⎓ — среднее, V~ — RMS переменной составляющей; Ω без «Измерить» не выдумывается', () => {
  const { b, r2, g } = divider();
  const net = b.doc.schematic.nets.find((n) => n.connections.some((c) => c.instanceId === r2 && c.pin === '1'))!.id;
  const t = Array.from({ length: 4001 }, (_, i) => i * 1e-5);
  const v = t.map((x) => 2 + 3 * Math.sin(2 * Math.PI * 500 * x));
  const res = tranResult(b.doc, net, t, v);
  const gnd = b.doc.schematic.nets.find((n) => n.connections.some((c) => c.instanceId === g))!.id;
  res.tran!.node[gnd] = t.map(() => 0);
  const dc = meterReading(b.doc, res, 'dcv', p(r2, '1'), p(g, '1'));
  assert.ok(Math.abs(dc.value! - 2) < 1e-3, `V⎓ ${dc.value}`);
  const ac = meterReading(b.doc, res, 'acv', p(r2, '1'), p(g, '1'));
  assert.ok(Math.abs(ac.value! - 3 / Math.SQRT2) < 1e-3, `V~ ${ac.value}`);
  assert.match(ac.method, /500 Гц/);
  assert.equal(meterReading(b.doc, res, 'ohm', p(r2, '1'), p(g, '1')).value, null);
  assert.equal(meterReading(b.doc, null, 'dcv', p(r2, '1'), p(g, '1')).display, 'нет расчёта');
  assert.equal(meterReading(b.doc, res, 'dcv', p(r2, '1'), null).value, null, 'без второго щупа показания нет');
});

test('waveStats: постоянный сигнал — частота не определена; меандр — точные среднее, RMS и частота при неравномерном шаге', () => {
  const flat = waveStats([0, 1, 2, 3], [5, 5, 5, 5])!;
  assert.equal(flat.mean, 5); assert.equal(flat.vpp, 0); assert.equal(flat.freq, null); assert.equal(flat.acRms, 0);
  const t: number[] = [], v: number[] = [];
  for (let k = 0; k < 20; k++) { // 1 кГц, фронты 1 мкс, неравномерные точки
    const t0 = k * 1e-3;
    t.push(t0, t0 + 1e-6, t0 + 0.2e-3, t0 + 0.5e-3, t0 + 0.5e-3 + 1e-6, t0 + 0.9e-3);
    v.push(0, 1, 1, 1, 0, 0);
  }
  const st = waveStats(t, v, 0)!;
  assert.ok(Math.abs(st.mean - 0.5) < 0.01, `${st.mean}`);
  assert.ok(Math.abs(st.freq! - 1000) < 1, `${st.freq}`);
  assert.equal(waveStats([0], [1]), null);
});

test('осциллограф: запуск по фронту ставит точку запуска на 1 деление; ждущий режим без запуска — пусто', () => {
  const { b, r2 } = divider();
  const net = b.doc.schematic.nets.find((n) => n.connections.some((c) => c.instanceId === r2 && c.pin === '1'))!.id;
  const t = Array.from({ length: 10001 }, (_, i) => i * 1e-6);
  const v = t.map((x) => Math.sin(2 * Math.PI * 1000 * x));
  const res = tranResult(b.doc, net, t, v);
  const s = { ...DEFAULT_SCOPE, ch1: { ...DEFAULT_SCOPE.ch1, pin: p(r2, '1') }, timeDiv: 0.2e-3 };
  const view = scopeView(b.doc, res, s)!;
  assert.equal(view.triggered, true);
  const tTrig = view.t0 + 0.2e-3;
  assert.ok(Math.abs(tTrig * 1000 - Math.round(tTrig * 1000)) < 1e-6, `запуск в момент перехода через 0 вверх: ${tTrig}`);
  assert.ok(tTrig + 1.8e-3 <= 10e-3 + 1e-12, 'экран помещается в запись');
  const fall = scopeView(b.doc, res, { ...s, trigger: { ...s.trigger, edge: 'fall' } })!;
  assert.ok(Math.abs(((fall.t0 + 0.2e-3) * 1000) % 1 - 0.5) < 1e-6, 'спад — через полпериода');
  const none = scopeView(b.doc, res, { ...s, trigger: { ...s.trigger, level: 2, mode: 'normal' } })!;
  assert.equal(none.triggered, false); assert.deepEqual(none.channels, [null, null]);
  const auto = scopeView(b.doc, res, { ...s, trigger: { ...s.trigger, level: 2 } })!;
  assert.equal(auto.triggered, false); assert.ok(auto.channels[0]);
  assert.equal(scopeView(b.doc, null, s), null);
});

test('блок питания: без расчёта — уставки без показаний; режим по току', () => {
  const b = new Builder();
  const g = b.place('GND', 0, 300);
  const u = b.part('Лабораторный блок питания', 0, 100);
  b.wire(p(u, '-'), p(g, '1'));
  const [s] = psuStates(b.doc, null);
  assert.equal(s!.vset, 5); assert.equal(s!.ilim, 0.1); assert.equal(s!.enabled, true); assert.equal(s!.mode, null);
});
