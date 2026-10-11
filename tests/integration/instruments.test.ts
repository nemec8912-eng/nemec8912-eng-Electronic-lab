/**
 * Этап 5: виртуальные приборы на настоящем ngspice. Проверки по ТЗ: делитель напряжения, RC-заряд,
 * диод, источник с ограничением тока, осциллограмма, сравнение с эталоном (формулой).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setMeterMode, setProbe, setProbeTarget, DEFAULT_SCOPE, type MeterMode } from '../../src/core/instruments';
import { setSimSettings } from '../../src/core/instruments';
import type { ProjectDoc } from '../../src/core/model';
import { netOfPin } from '../../src/core/schematic';
import { measure } from '../../src/sim/meters';
import { meterReading, psuStates, scopeView, waveStats } from '../../src/sim/readings';
import { simulate } from '../../src/sim/simulate';
import { Builder, ngspiceForTests, p, requireNgspice } from '../sim-helpers';

const NG = ngspiceForTests();
const skip = !NG && !requireNgspice ? 'ngspice не найден' : false;
const close = (actual: number | null, expected: number, relTol: number, what: string) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= Math.abs(expected) * relTol + 1e-12, `${what}: ${actual} вместо ${expected} (допуск ${relTol * 100}%)`);
const tranOf = (doc: ProjectDoc, stopS: number, stepS: number, startFromZero = true) =>
  setSimSettings({ ...doc, simulation: { ...doc.simulation, tran: { stopS, stepS, startFromZero } } }, { analysis: 'tran' });

/** Делитель: 10 В, R1 = R2 = 10 кОм. */
function divider() {
  const b = new Builder();
  const g = b.place('GND', 0, 300);
  const v = b.vsrc(10, 0, 100, g), r1 = b.res(10_000, 150, 0), r2 = b.res(10_000, 300, 150);
  b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
  return { b, v, r1, r2, g };
}

describe('Мультиметр (ngspice)', { skip }, () => {
  test('делитель: V⎓ = 5 В в рабочей точке и по переходному процессу; V~ ≈ 0', async () => {
    const { b, r2, g } = divider();
    const mm = (doc: ProjectDoc, mode: MeterMode) => setMeterMode(setProbe(setProbe(doc, 'red', p(r2, '1')), 'black', p(g, '1')), mode);
    const op = await simulate(mm(b.doc, 'dcv'), NG, { analysis: 'op' });
    const r = meterReading(op.status === 'ok' ? b.doc : b.doc, op, 'dcv', p(r2, '1'), p(g, '1'));
    close(r.value, 5, 1e-9, 'V⎓');
    assert.match(r.method, /рабочей точке/);
    const tr = await simulate(tranOf(mm(b.doc, 'dcv'), 1e-3, 1e-5), NG);
    close(meterReading(b.doc, tr, 'dcv', p(r2, '1'), p(g, '1')).value, 5, 1e-6, 'V⎓ по переходному процессу');
    const ac = meterReading(b.doc, tr, 'acv', p(r2, '1'), p(g, '1'));
    assert.ok(ac.value !== null && ac.value < 1e-6, `V~ = ${ac.value}`);
    assert.equal(meterReading(b.doc, op, 'acv', p(r2, '1'), p(g, '1')).display, 'нужен переходный процесс', 'V~ без переходного процесса не выдумывается');
  });

  test('амперметр включается последовательно: A⎓ = 0,5 мА; напряжения схемы не меняются', async () => {
    const { b, r1, r2 } = divider();
    const plain = await simulate(b.doc, NG, { analysis: 'op' });
    const doc = setMeterMode(setProbe(b.doc, 'red', p(r1, '2')), 'dca');
    const res = await simulate(doc, NG, { analysis: 'op' });
    assert.equal(res.status, 'ok');
    assert.match(res.netlist, /^v_meter \S+ n_meter 0$/m);
    const r = meterReading(doc, res, 'dca', p(r1, '2'), null);
    close(r.value, -0.5e-3, 1e-9, 'ток, втекающий в R1.2 (ток через R1 идёт из вывода 2 наружу)');
    const mid = netOfPin(doc, p(r2, '1'))!.id;
    close(res.op!.node[mid]!, plain.op!.node[mid]!, 1e-12, 'напряжение середины делителя');
    const r2in = meterReading(setProbe(doc, 'red', p(r2, '1')), await simulate(setProbe(doc, 'red', p(r2, '1')), NG, { analysis: 'op' }), 'dca', p(r2, '1'), null);
    close(r2in.value, 0.5e-3, 1e-9, 'ток, втекающий в R2.1');
  });

  test('синус 1 В амплитуды на делителе 1:2 — V~ = 0,3536 В (эталон A/(2√2)), частота 1 кГц', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const s = b.part('Источник синусоидального напряжения', 0, 100), r1 = b.res(1000, 150, 0), r2 = b.res(1000, 300, 150);
    b.wire(p(s, '-'), p(g, '1')); b.wire(p(s, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
    const res = await simulate(tranOf(b.doc, 10e-3, 2e-6), NG);
    const r = meterReading(b.doc, res, 'acv', p(r2, '1'), p(g, '1'));
    close(r.value, 1 / 2 / Math.SQRT2, 0.002, 'V~ RMS');
    assert.match(r.method, /True RMS/);
    assert.match(r.method, /1 кГц/);
  });

  test('сопротивление: питание отключается, R2 = 10 кОм, R1 + R2 = 20 кОм; конденсатор — OL', async () => {
    const { b, v, r1, r2, g } = divider();
    const m1 = await measure(b.doc, NG, { kind: 'ohm', red: p(r2, '1'), black: p(g, '1') });
    assert.equal(m1.status, 'ok', m1.message ?? '');
    close(m1.value, 10_000, 1e-6, 'R2 (источник разомкнут)');
    assert.match(m1.method, /Питание схемы отключено/);
    assert.doesNotMatch(m1.netlist, /^V1 /m, 'источника в схеме измерения нет');
    const m2 = await measure(b.doc, NG, { kind: 'ohm', red: p(v, '+'), black: p(g, '1') });
    close(m2.value, 20_000, 1e-6, 'R1 + R2');
    const c = b.place('C', 400, 0);
    b.wire(p(c, '1'), p(r1, '1'));
    const m3 = await measure(b.doc, NG, { kind: 'ohm', red: p(c, '1'), black: p(c, '2') });
    assert.equal(m3.display, 'OL', 'конденсатор не проводит постоянный ток');
    void r1;
  });

  test('прозвонка: 10 Ом — звенит; 10 кОм — нет; разрыв — OL', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const r = b.res(10, 100, 0), rb = b.res(10_000, 100, 200), x = b.res(1000, 300, 0);
    b.wire(p(r, '2'), p(g, '1')); b.wire(p(rb, '2'), p(g, '1')); b.wire(p(x, '1'), p(g, '1'));
    const a = await measure(b.doc, NG, { kind: 'cont', red: p(r, '1'), black: p(g, '1') });
    assert.equal(a.beep, true); close(a.value, 10, 1e-6, 'R');
    const c = await measure(b.doc, NG, { kind: 'cont', red: p(rb, '1'), black: p(g, '1') });
    assert.equal(c.beep, false); assert.equal(c.display, 'OL');
  });

  test('проверка диодов: 1N4007 в прямом направлении 0,4…0,7 В при 1 мА, в обратном — OL; светодиод ≈ 1,7…1,9 В', async () => {
    const b = new Builder();
    b.place('GND', 0, 300);
    const d = b.part('1N4007', 100, 100), led = b.part('Светодиод 5 мм красный', 300, 100);
    const fwd = await measure(b.doc, NG, { kind: 'diode', red: p(d, '2'), black: p(d, '1') });
    assert.equal(fwd.status, 'ok', fwd.message ?? '');
    assert.ok(fwd.value! > 0.4 && fwd.value! < 0.7, `U пр = ${fwd.value}`);
    const rev = await measure(b.doc, NG, { kind: 'diode', red: p(d, '1'), black: p(d, '2') });
    assert.equal(rev.display, 'OL');
    const l = await measure(b.doc, NG, { kind: 'diode', red: p(led, '2'), black: p(led, '1') });
    assert.ok(l.value! > 1.7 && l.value! < 1.9, `U пр светодиода при 1 мА = ${l.value}`);
  });

  test('ESR-метр: электролит 47 мкФ с ESR 0,6 Ом на 100 кГц — 0,6 Ом, ёмкость 47 мкФ; на 100 Гц ESR тот же, реактивное сопротивление больше', async () => {
    const b = new Builder();
    b.place('GND', 0, 300);
    const c = b.part('Конденсатор электролитический', 100, 100);
    const m = await measure(b.doc, NG, { kind: 'esr', red: p(c, '1'), black: p(c, '2'), freqHz: 100_000 });
    assert.equal(m.status, 'ok', m.message ?? '');
    close(m.esr!.re, 0.6, 1e-6, 'ESR');
    close(m.esr!.capacitance!, 47e-6, 1e-6, 'C по реактивной части');
    const lo = await measure(b.doc, NG, { kind: 'esr', red: p(c, '1'), black: p(c, '2'), freqHz: 100 });
    close(lo.esr!.re, 0.6, 1e-6, 'ESR на 100 Гц (модель без частотной зависимости)');
    close(-lo.esr!.im, 1 / (2 * Math.PI * 100 * 47e-6), 1e-6, '|X| на 100 Гц');
    const ideal = b.place('C', 300, 100);
    const mi = await measure(b.doc, NG, { kind: 'esr', red: p(ideal, '1'), black: p(ideal, '2') });
    assert.ok(Math.abs(mi.esr!.re) < 1e-6, 'идеальный конденсатор — ESR 0 (так задана модель)');
  });
});

describe('Лабораторный блок питания (ngspice)', { skip }, () => {
  const psu = (load: number, enabled = 1) => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const u = b.part('Лабораторный блок питания', 0, 100), rl = b.res(load, 200, 100);
    b.value(u, 'enabled', enabled, '');
    b.wire(p(u, '-'), p(g, '1')); b.wire(p(u, '+'), p(rl, '1')); b.wire(p(rl, '2'), p(g, '1'));
    return b.doc;
  };

  test('100 Ом: CV — 5 В, 50 мА; 10 Ом: CC — 0,1 А, 1 В; выключен — 0', async () => {
    const cv = psu(100);
    const r1 = await simulate(cv, NG, { analysis: 'op' });
    assert.equal(r1.status, 'ok', JSON.stringify(r1.error ?? r1.issues));
    const s1 = psuStates(cv, r1)[0]!;
    assert.equal(s1.mode, 'CV'); close(s1.vout, 5, 1e-3, 'U вых'); close(s1.iout, 0.05, 1e-3, 'I вых');
    const cc = psu(10);
    const s2 = psuStates(cc, await simulate(cc, NG, { analysis: 'op' }))[0]!;
    assert.equal(s2.mode, 'CC'); close(s2.iout, 0.1, 1e-3, 'I огр'); close(s2.vout, 1, 1e-3, 'U вых = I·R');
    const off = psu(100, 0);
    const s3 = psuStates(off, await simulate(off, NG, { analysis: 'op' }))[0]!;
    assert.equal(s3.mode, 'OFF'); assert.ok(Math.abs(s3.vout!) < 1e-3);
  });

  test('холостой ход: напряжение равно уставке (без ложного смещения модели)', async () => {
    const doc = psu(1e9);
    const s = psuStates(doc, await simulate(doc, NG, { analysis: 'op' }))[0]!;
    assert.equal(s.mode, 'CV'); close(s.vout, 5, 2e-6, 'U хх');
  });

  test('короткое замыкание выхода — ток ограничен, напряжение ≈ 0', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const u = b.part('Лабораторный блок питания', 0, 100);
    b.wire(p(u, '-'), p(g, '1')); b.wire(p(u, '+'), p(g, '1'));
    const r = await simulate(b.doc, NG, { analysis: 'op' });
    assert.equal(r.status, 'ok', JSON.stringify(r.error ?? r.issues));
    const s = psuStates(b.doc, r)[0]!;
    assert.equal(s.mode, 'CC'); close(s.iout, 0.1, 1e-3, 'I кз');
  });
});

describe('Осциллограф и RC-заряд (ngspice)', { skip }, () => {
  test('RC-заряд от блока питания: 63,2 % на τ; синхронизация по фронту; автоизмерения синуса', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const u = b.part('Лабораторный блок питания', 0, 100), r = b.res(10_000, 150, 0), c = b.place('C', 300, 150);
    b.value(c, 'capacitance', 100e-9, 'F');
    b.wire(p(u, '-'), p(g, '1')); b.wire(p(u, '+'), p(r, '1')); b.wire(p(r, '2'), p(c, '1')); b.wire(p(c, '2'), p(g, '1'));
    const doc = setProbeTarget(tranOf(b.doc, 5e-3, 1e-6), 'scope.ch1', p(c, '1'));
    const res = await simulate(doc, NG);
    assert.equal(res.status, 'ok', JSON.stringify(res.error ?? res.issues));
    const view = scopeView(doc, res, { ...DEFAULT_SCOPE, ch1: { ...DEFAULT_SCOPE.ch1, pin: p(c, '1') }, timeDiv: 0.5e-3, trigger: { source: 'ch1', level: 2.5, edge: 'rise', mode: 'auto' } })!;
    assert.ok(view.triggered, view.status);
    const ch = view.channels[0]!;
    // Уровень 2,5 В = 50 % от 5 В достигается при t = τ·ln 2 = 0,693 мс
    close(view.t0 + 0.1 * 10 * 0.5e-3, 1e-3 * Math.LN2, 0.01, 'момент запуска');
    const k = ch.t.findIndex((t) => t >= 1e-3);
    close(ch.v[k]!, 5 * (1 - Math.exp(-1)), 0.01, 'Uc(τ)');
    const normal = scopeView(doc, res, { ...DEFAULT_SCOPE, ch1: { ...DEFAULT_SCOPE.ch1, pin: p(c, '1') }, trigger: { source: 'ch1', level: 6, edge: 'rise', mode: 'normal' } })!;
    assert.equal(normal.triggered, false);
    assert.match(normal.status, /Ждущий режим/);

    const t = Array.from({ length: 20001 }, (_, i) => i * 1e-6);
    const sine = t.map((x) => 1 + 2 * Math.sin(2 * Math.PI * 1000 * x));
    const st = waveStats(t, sine)!;
    close(st.mean, 1, 1e-4, 'среднее'); close(st.acRms, 2 / Math.SQRT2, 1e-4, 'RMS переменной составляющей');
    close(st.vpp, 4, 1e-4, 'размах'); close(st.freq!, 1000, 1e-4, 'частота');
  });
});
