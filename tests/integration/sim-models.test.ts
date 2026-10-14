/**
 * Этап 4: эталонные расчёты на настоящем ngspice с моделями встроенного справочника, источниками
 * сигналов, развёрткой DC, частотным анализом и параметрическим прогоном. Ожидаемые значения — из
 * формул и даташитов; допуски указаны в каждом тесте.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setSimSettings } from '../../src/core/instruments';
import { netOfPin } from '../../src/core/schematic';
import { parseUserModel, templateFromParsed } from '../../src/core/spice';
import { newId } from '../../src/core/ids';
import { transfer, valueAt } from '../../src/sim/results';
import { simulate } from '../../src/sim/simulate';
import { Builder, ngspiceForTests, p, requireNgspice } from '../sim-helpers';

const NG = ngspiceForTests();
const skip = !NG && !requireNgspice ? 'ngspice не найден' : false;
const close = (actual: number, expected: number, relTol: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relTol + 1e-12, `${what}: ${actual} вместо ${expected} (допуск ${relTol * 100}%)`);
const within = (v: number, lo: number, hi: number, what: string) => assert.ok(v >= lo && v <= hi, `${what}: ${v} вне [${lo}; ${hi}]`);
const ok = (res: Awaited<ReturnType<typeof simulate>>) => assert.equal(res.status, 'ok', JSON.stringify(res.error ?? res.issues.filter((i) => i.severity === 'error')));
const VT = 0.025865; // kT/q при 27 °C

describe('Модели приборов (ngspice)', { skip }, () => {
  test('1N4007 в прямом направлении: U = N·φт·ln(I/IS) + I·RS; токи выводов и мощность', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const v = b.vsrc(5, 0, 100, g), r = b.res(470, 150, 0), d = b.part('1N4007', 300, 100);
    b.wire(p(v, '+'), p(r, '1'));
    b.wire(p(r, '2'), p(d, '2')); // анод
    b.wire(p(d, '1'), p(g, '1')); // катод
    const res = await simulate(b.doc, NG, { analysis: 'op' });
    ok(res);
    const vd = res.op!.node[netOfPin(b.doc, p(d, '2'))!.id]!;
    const ia = res.op!.pins[d]!['2']!, ik = res.op!.pins[d]!['1']!;
    close(ia, -ik, 1e-6, 'ток анода = − ток катода');
    close(ia, (5 - vd) / 470, 1e-6, 'ток через резистор');
    close(vd, 1.80803 * VT * Math.log(ia / 7.02767e-9 + 1) + ia * 0.0341512, 0.005, 'уравнение диода');
    within(vd, 0.6, 0.75, 'U пр 1N4007 при ~9 мА');
    assert.deepEqual(res.limits, []);
    assert.ok(res.issues.some((i) => i.code === 'unverified-model'), 'модель не проверена — сказано явно');
  });

  test('диодный мост: выход = вход − 2 прямых падения, при любой полярности входа', async () => {
    for (const reverse of [false, true]) {
      const b = new Builder();
      const g = b.place('GND', 0, 300);
      const v = b.vsrc(12, 0, 100, g), br = b.part('Диодный мост (типовой)', 200, 100), r = b.res(1000, 400, 100);
      // Вход — на выводы «~» (1 и 3), нагрузка 1 кОм — между «+» (2) и «−» (4).
      b.wire(p(v, '+'), p(br, reverse ? '3' : '1'));
      b.wire(p(g, '1'), p(br, reverse ? '1' : '3'));
      b.wire(p(br, '2'), p(r, '1'));
      b.wire(p(r, '2'), p(br, '4'));
      const res = await simulate(b.doc, NG, { analysis: 'op' });
      ok(res);
      const vout = res.op!.node[netOfPin(b.doc, p(br, '2'))!.id]! - res.op!.node[netOfPin(b.doc, p(br, '4'))!.id]!;
      // ≈ 10,7 мА через два диода 1N4007: по 0,6…0,8 В
      within(vout, 12 - 2 * 0.8, 12 - 2 * 0.6, `U выхода моста${reverse ? ' (вход наоборот)' : ''}`);
    }
  });

  test('стабилитрон 1N4733A: 12 В через 1 кОм → 5,1 В ± 5 % (по даташиту)', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const v = b.vsrc(12, 0, 100, g), r = b.res(1000, 150, 0), z = b.part('1N4733A', 300, 100);
    b.wire(p(v, '+'), p(r, '1'));
    b.wire(p(r, '2'), p(z, '1')); // катод к «+»
    b.wire(p(z, '2'), p(g, '1'));
    const res = await simulate(b.doc, NG, { analysis: 'op' });
    ok(res);
    within(res.op!.node[netOfPin(b.doc, p(z, '1'))!.id]!, 4.85, 5.36, 'Uст');
  });

  test('светодиод: 5 В через 330 Ом — около 9 мА; 12 В через 100 Ом — ток больше 20 мА → предупреждение; обратное 12 В → пробой', async () => {
    const make = (volts: number, ohms: number, reverse = false) => {
      const b = new Builder();
      const g = b.place('GND', 0, 300);
      const v = b.vsrc(volts, 0, 100, g), r = b.res(ohms, 150, 0), led = b.part('Светодиод 5 мм красный', 300, 100);
      b.wire(p(v, '+'), p(r, '1'));
      b.wire(p(r, '2'), p(led, reverse ? '1' : '2'));
      b.wire(p(led, reverse ? '2' : '1'), p(g, '1'));
      return { b, led };
    };
    const a = make(5, 330);
    const ra = await simulate(a.b.doc, NG, { analysis: 'op' });
    ok(ra);
    const i = ra.op!.pins[a.led]!['2']!;
    within(i, 8e-3, 10e-3, 'I светодиода');
    within(ra.op!.node[netOfPin(a.b.doc, p(a.led, '2'))!.id]!, 1.8, 2.2, 'U пр красного светодиода');
    const hot = make(12, 100);
    const rh = await simulate(hot.b.doc, NG, { analysis: 'op' });
    assert.ok(rh.limits.some((l) => l.instanceId === hot.led && l.kind === 'current' && /светодиод перегреется/.test(l.message)));
    const rev = make(12, 1000, true);
    const rr = await simulate(rev.b.doc, NG, { analysis: 'op' });
    assert.ok(rr.limits.some((l) => l.instanceId === rev.led && l.kind === 'reverse-voltage'), JSON.stringify(rr.limits));
  });

  test('BC547B в активном режиме: Uбэ 0,55…0,7 В, β в пределах даташита (200…450), сумма токов выводов — 0', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 400);
    const v = b.vsrc(10, 0, 100, g), rb = b.res(1e6, 150, 0), rc = b.res(1000, 300, 0), q = b.part('BC547', 300, 200);
    b.wire(p(v, '+'), p(rb, '1'));
    b.wire(p(v, '+'), p(rc, '1'));
    b.wire(p(rb, '2'), p(q, '1'));
    b.wire(p(rc, '2'), p(q, '2'));
    b.wire(p(q, '3'), p(g, '1'));
    const res = await simulate(b.doc, NG, { analysis: 'op' });
    ok(res);
    const pin = res.op!.pins[q]!;
    const ib = pin['1']!, ic = pin['2']!, ie = pin['3']!;
    assert.ok(Math.abs(ib + ic + ie) < 1e-9, 'закон Кирхгофа для токов выводов');
    within(ic / ib, 200, 450, 'β');
    within(res.op!.node[netOfPin(b.doc, p(q, '1'))!.id]!, 0.55, 0.7, 'Uбэ');
    within(res.op!.node[netOfPin(b.doc, p(q, '2'))!.id]!, 5, 9, 'Uкэ (активный режим)');
  });

  test('BC547 ключ: насыщение (Uкэ < 0,2 В); перегрев 0,5 Вт → предупреждение о мощности', async () => {
    const sw = new Builder();
    const g = sw.place('GND', 0, 400);
    const v = sw.vsrc(5, 0, 100, g), rb = sw.res(10_000, 150, 0), rc = sw.res(1000, 300, 0), q = sw.part('BC547', 300, 200);
    sw.wire(p(v, '+'), p(rb, '1')); sw.wire(p(v, '+'), p(rc, '1'));
    sw.wire(p(rb, '2'), p(q, '1')); sw.wire(p(rc, '2'), p(q, '2')); sw.wire(p(q, '3'), p(g, '1'));
    const r1 = await simulate(sw.doc, NG, { analysis: 'op' });
    ok(r1);
    assert.ok(r1.op!.node[netOfPin(sw.doc, p(q, '2'))!.id]! < 0.2, 'Uкэ нас');

    const hot = new Builder();
    const g2 = hot.place('GND', 0, 400);
    const v2 = hot.vsrc(10, 0, 100, g2), rb2 = hot.res(22_000, 150, 0), q2 = hot.part('BC547', 300, 200);
    hot.wire(p(v2, '+'), p(rb2, '1')); hot.wire(p(v2, '+'), p(q2, '2'));
    hot.wire(p(rb2, '2'), p(q2, '1')); hot.wire(p(q2, '3'), p(g2, '1'));
    const r2 = await simulate(hot.doc, NG, { analysis: 'op' });
    ok(r2);
    const pw = r2.limits.find((l) => l.instanceId === q2 && l.kind === 'power');
    assert.ok(pw, `ожидалось предупреждение о мощности: ${JSON.stringify(r2.limits)} Ic=${r2.op!.pins[q2]!['2']}`);
    assert.match(pw.message, /больше допустимой 500 мВт/);
  });

  test('2N3906 (p-n-p): эмиттер к +10 В, база через 1 МОм на землю — ток коллектора вытекает', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 400);
    const v = b.vsrc(10, 0, 100, g), rb = b.res(1e6, 150, 300), rc = b.res(1000, 300, 300), q = b.part('2N3906', 300, 150);
    b.wire(p(v, '+'), p(q, '3'));
    b.wire(p(q, '1'), p(rb, '1')); b.wire(p(rb, '2'), p(g, '1'));
    b.wire(p(q, '2'), p(rc, '1')); b.wire(p(rc, '2'), p(g, '1'));
    const res = await simulate(b.doc, NG, { analysis: 'op' });
    ok(res);
    const ic = res.op!.pins[q]!['2']!, ib = res.op!.pins[q]!['1']!;
    assert.ok(ic < 0 && ib < 0, 'у p-n-p токи базы и коллектора вытекают');
    within(ic / ib, 80, 400, 'β 2N3906');
  });

  test('IRF540N: Uзи = 10 В — открыт, Uси ≈ I·44 мОм; Uзи = 2 В — закрыт', async () => {
    const make = (vgs: number) => {
      const b = new Builder();
      const g = b.place('GND', 0, 400);
      const v = b.vsrc(12, 0, 100, g), vg = b.vsrc(vgs, 450, 200, g), rl = b.res(10, 300, 0), m = b.part('IRF540N', 300, 200);
      b.wire(p(v, '+'), p(rl, '1')); b.wire(p(rl, '2'), p(m, '2'));
      b.wire(p(vg, '+'), p(m, '1')); b.wire(p(m, '3'), p(g, '1'));
      return { b, m };
    };
    const on = make(10);
    const r1 = await simulate(on.b.doc, NG, { analysis: 'op' });
    ok(r1);
    const id = r1.op!.pins[on.m]!['2']!;
    const vds = r1.op!.node[netOfPin(on.b.doc, p(on.m, '2'))!.id]!;
    close(vds / id, 0.044, 0.25, 'Rси откр.');
    const off = make(2);
    const r2 = await simulate(off.b.doc, NG, { analysis: 'op' });
    ok(r2);
    assert.ok(r2.op!.pins[off.m]!['2']! < 1e-6, 'закрыт: ток стока < 1 мкА');
  });
});

describe('Микросхемы (поведенческие модели)', { skip }, () => {
  test('LM358, неинвертирующий усилитель ×11: 0,3 В → 3,3 В; насыщение у V+ − 1,5 В; полоса ≈ 1 МГц / 11', async () => {
    const make = (vin: number) => {
      const b = new Builder();
      const g = b.place('GND', 0, 500);
      const vcc = b.vsrc(9, 0, 100, g), u = b.part('LM358', 300, 200);
      const sin = b.part('Источник синусоидального напряжения', 100, 300);
      b.value(sin, 'offset', vin, 'V'); b.value(sin, 'amplitude', 0.01, 'V');
      b.wire(p(sin, '-'), p(g, '1'));
      const rf = b.res(100_000, 450, 100), rg = b.res(10_000, 450, 350);
      b.wire(p(vcc, '+'), p(u, '8')); b.wire(p(u, '4'), p(g, '1'));
      b.wire(p(sin, '+'), p(u, '3'));
      b.wire(p(u, '1'), p(rf, '1')); b.wire(p(rf, '2'), p(u, '2')); b.wire(p(u, '2'), p(rg, '1')); b.wire(p(rg, '2'), p(g, '1'));
      // Второй ОУ — повторитель на земле, чтобы входы не висели.
      b.wire(p(u, '5'), p(g, '1')); b.wire(p(u, '6'), p(u, '7'));
      return { b, u };
    };
    const lin = make(0.3);
    const r1 = await simulate(lin.b.doc, NG, { analysis: 'op' });
    ok(r1);
    close(r1.op!.node[netOfPin(lin.b.doc, p(lin.u, '1'))!.id]!, 3.3, 0.01, 'Uвых');
    const sat = make(1);
    const r2 = await simulate(sat.b.doc, NG, { analysis: 'op' });
    within(r2.op!.node[netOfPin(sat.b.doc, p(sat.u, '1'))!.id]!, 7.4, 7.6, 'насыщение');
    let d = setSimSettings(lin.b.doc, { analysis: 'ac', ac: { fStartHz: 100, fStopHz: 10e6, pointsPerDecade: 50 } });
    d = { ...d };
    const r3 = await simulate(d, NG);
    ok(r3);
    const out = netOfPin(d, p(lin.u, '1'))!.id;
    const t = transfer(r3.ac!, out, null, null);
    const gain0 = t.mag[0]! / 0.01;
    close(gain0, 11, 0.01, 'коэффициент усиления на низкой частоте');
    const k = t.mag.findIndex((m) => m / 0.01 < 11 / Math.SQRT2);
    within(r3.ac!.freq[k]!, 60e3, 120e3, 'частота среза −3 дБ');
  });

  test('NE555, мультивибратор: f = 1/(ln2·(Ra+2Rb)·C) ± 3 %, заполнение (Ra+Rb)/(Ra+2Rb) ± 3 %', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 500);
    const vcc = b.vsrc(9, 0, 100, g), u = b.part('NE555', 300, 250);
    const ra = b.res(1000, 500, 50), rb = b.res(10_000, 500, 200);
    const c = b.place('C', 500, 400), cc = b.place('C', 150, 400), rl = b.res(1000, 650, 300);
    b.value(c, 'capacitance', 10e-9, 'F'); b.value(cc, 'capacitance', 10e-9, 'F');
    b.wire(p(vcc, '+'), p(u, '8')); b.wire(p(vcc, '+'), p(u, '4')); b.wire(p(u, '1'), p(g, '1'));
    b.wire(p(vcc, '+'), p(ra, '1')); b.wire(p(ra, '2'), p(u, '7')); b.wire(p(u, '7'), p(rb, '1'));
    b.wire(p(rb, '2'), p(u, '6')); b.wire(p(u, '6'), p(u, '2')); b.wire(p(u, '2'), p(c, '1')); b.wire(p(c, '2'), p(g, '1'));
    b.wire(p(u, '5'), p(cc, '1')); b.wire(p(cc, '2'), p(g, '1'));
    b.wire(p(u, '3'), p(rl, '1')); b.wire(p(rl, '2'), p(g, '1'));
    const doc = { ...b.doc, simulation: { ...b.doc.simulation, analysis: 'tran' as const, tran: { stopS: 3e-3, stepS: 2e-7, startFromZero: true } } };
    const res = await simulate(doc, NG);
    ok(res);
    const out = res.tran!.node[netOfPin(doc, p(u, '3'))!.id]!;
    const t = res.tran!.time;
    const rises: number[] = [], falls: number[] = [];
    for (let i = 1; i < t.length; i++) {
      if (t[i]! < 0.5e-3) continue;
      if (out[i - 1]! < 3.5 && out[i]! >= 3.5) rises.push(t[i]!);
      if (out[i - 1]! >= 3.5 && out[i]! < 3.5) falls.push(t[i]!);
    }
    assert.ok(rises.length >= 5, `колебания есть: ${rises.length}`);
    const period = (rises[rises.length - 1]! - rises[0]!) / (rises.length - 1);
    close(1 / period, 1 / (Math.LN2 * 21e3 * 10e-9), 0.03, 'частота');
    const hi = falls.find((x) => x > rises[0]!)! - rises[0]!;
    close(hi / period, 11 / 21, 0.03, 'заполнение');
    const cn = res.tran!.node[netOfPin(doc, p(c, '1'))!.id]!;
    const tail = cn.slice(Math.floor(cn.length / 2));
    within(Math.min(...tail), 2.9, 3.1, 'нижний порог 1/3 Uпит');
    within(Math.max(...tail), 5.9, 6.1, 'верхний порог 2/3 Uпит');
  });

  test('L7805: 12 В → 5 В; 6 В → около 4 В (падение 2 В); 40 В — выше максимума 35 В; мощность регулятора', async () => {
    const make = (vin: number) => {
      const b = new Builder();
      const g = b.place('GND', 0, 400);
      const v = b.vsrc(vin, 0, 100, g), u = b.part('L7805CV', 250, 100), rl = b.res(50, 450, 200);
      b.wire(p(v, '+'), p(u, '1')); b.wire(p(u, '2'), p(g, '1')); b.wire(p(u, '3'), p(rl, '1')); b.wire(p(rl, '2'), p(g, '1'));
      return { b, u };
    };
    const n = make(12);
    const r = await simulate(n.b.doc, NG, { analysis: 'op' });
    ok(r);
    close(r.op!.node[netOfPin(n.b.doc, p(n.u, '3'))!.id]!, 5, 0.01, 'Uвых');
    const pins = r.op!.pins[n.u]!;
    const p_reg = 12 * pins['1']! + 5 * pins['3']!;
    close(p_reg, (12 - 5) * 0.1 + 12 * 5e-3, 0.03, 'рассеиваемая мощность (12 − 5)·0,1 + Iпокоя·12');
    const low = make(6);
    const r2 = await simulate(low.b.doc, NG, { analysis: 'op' });
    close(r2.op!.node[netOfPin(low.b.doc, p(low.u, '3'))!.id]!, 4, 0.02, 'Uвых при малом входном');
    const high = make(40);
    const r3 = await simulate(high.b.doc, NG, { analysis: 'op' });
    assert.ok(r3.limits.some((l) => l.instanceId === high.u && l.kind === 'supply-high'));
  });

  test('LM317: 240 Ом / 720 Ом → 1,25·(1 + 720/240) + 50 мкА·720 Ом = 5,036 В', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 400);
    const v = b.vsrc(12, 0, 100, g), u = b.part('LM317T', 250, 100), r1 = b.res(240, 450, 150), r2 = b.res(720, 300, 300), rl = b.res(100, 550, 300);
    b.wire(p(v, '+'), p(u, '3'));
    b.wire(p(u, '2'), p(r1, '1')); b.wire(p(r1, '2'), p(u, '1'));
    b.wire(p(u, '1'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
    b.wire(p(u, '2'), p(rl, '1')); b.wire(p(rl, '2'), p(g, '1'));
    const res = await simulate(b.doc, NG, { analysis: 'op' });
    ok(res);
    close(res.op!.node[netOfPin(b.doc, p(u, '2'))!.id]!, 1.25 * 4 + 50e-6 * 720, 0.005, 'Uвых');
  });
});

describe('Анализы и источники (ngspice)', { skip }, () => {
  /** Источник синуса → R → C → земля. */
  const rc = (r: number, c: number) => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const s = b.part('Источник синусоидального напряжения', 0, 100);
    b.wire(p(s, '-'), p(g, '1'));
    const rr = b.res(r, 150, 0), cc = b.place('C', 300, 150);
    b.value(cc, 'capacitance', c, 'F');
    b.wire(p(s, '+'), p(rr, '1')); b.wire(p(rr, '2'), p(cc, '1')); b.wire(p(cc, '2'), p(g, '1'));
    return { b, s, rr, cc };
  };

  test('частотный анализ RC-фильтра: на fc = 1/(2πRC) — 0,707 и −45°', async () => {
    const { b, s, cc } = rc(1000, 1 / (2 * Math.PI * 1000 * 1000));
    const doc = setSimSettings(b.doc, { analysis: 'ac', ac: { fStartHz: 10, fStopHz: 100e3, pointsPerDecade: 100 } });
    const res = await simulate(doc, NG);
    ok(res);
    const t = transfer(res.ac!, netOfPin(doc, p(cc, '1'))!.id, null, netOfPin(doc, p(s, '+'))!.id);
    const k = res.ac!.freq.findIndex((f) => Math.abs(f - 1000) < 1e-6);
    assert.ok(k >= 0, 'точка 1 кГц есть');
    close(t.mag[k]!, Math.SQRT1_2, 0.005, '|K| на fc');
    close(t.phaseDeg[k]!, -45, 0.01, 'фаза на fc');
    close(t.mag[0]!, 1, 0.001, '|K| на низкой частоте');
  });

  test('последовательный RLC: резонанс на f0 = 1/(2π√LC)', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 400);
    const s = b.part('Источник синусоидального напряжения', 0, 100);
    b.wire(p(s, '-'), p(g, '1'));
    const l = b.part('Дроссель радиальный', 150, 0), c = b.place('C', 300, 100), r = b.res(100, 300, 250);
    b.value(l, 'inductance', 10e-3, 'H'); b.value(c, 'capacitance', 100e-9, 'F');
    b.wire(p(s, '+'), p(l, '1')); b.wire(p(l, '2'), p(c, '1')); b.wire(p(c, '2'), p(r, '1')); b.wire(p(r, '2'), p(g, '1'));
    const doc = setSimSettings(b.doc, { analysis: 'ac', ac: { fStartHz: 1e3, fStopHz: 20e3, pointsPerDecade: 400 } });
    const res = await simulate(doc, NG);
    ok(res);
    const t = transfer(res.ac!, netOfPin(doc, p(r, '1'))!.id, null, null);
    const k = t.mag.indexOf(Math.max(...t.mag));
    close(res.ac!.freq[k]!, 1 / (2 * Math.PI * Math.sqrt(10e-3 * 100e-9)), 0.01, 'f0');
    close(t.mag[k]!, 1, 0.01, 'на резонансе всё напряжение — на R');
  });

  test('частотный анализ без источника синуса — честная ошибка', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const v = b.vsrc(5, 0, 100, g), r = b.res(1000, 150, 0);
    b.wire(p(v, '+'), p(r, '1')); b.wire(p(r, '2'), p(g, '1'));
    const res = await simulate(setSimSettings(b.doc, { analysis: 'ac' }), NG);
    assert.equal(res.status, 'blocked');
    assert.ok(res.issues.some((i) => i.code === 'no-ac-source'));
  });

  test('развёртка DC: делитель — Uвых = U/2 в каждой точке; прогон без выбранного источника — ошибка', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const v = b.vsrc(10, 0, 100, g), r1 = b.res(10_000, 150, 0), r2 = b.res(10_000, 300, 150);
    b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
    const none = await simulate(setSimSettings(b.doc, { analysis: 'dc' }), NG);
    assert.ok(none.issues.some((i) => i.code === 'no-sweep-source'));
    const doc = setSimSettings(b.doc, { analysis: 'dc', dc: { sourceId: v, start: 0, stop: 10, step: 1 } });
    const res = await simulate(doc, NG);
    ok(res);
    assert.equal(res.dc!.x.length, 11);
    const mid = res.dc!.node[netOfPin(doc, p(r1, '2'))!.id]!;
    res.dc!.x.forEach((x, i) => close(mid[i]!, x / 2, 1e-6, `Uвых при ${x} В`));
  });

  test('параметрический прогон: делитель с R2 = 1 к, 10 к, 100 к — Uвых = 10·R2/(10 к + R2)', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const v = b.vsrc(10, 0, 100, g), r1 = b.res(10_000, 150, 0), r2 = b.res(10_000, 300, 150);
    b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
    const doc = setSimSettings(b.doc, { analysis: 'op', sweep: { instanceId: r2, param: 'resistance', values: [1e3, 1e4, 1e5] } });
    const res = await simulate(doc, NG);
    ok(res);
    const mid = netOfPin(doc, p(r1, '2'))!.id;
    assert.equal(res.sweep!.runs.length, 3);
    for (const run of res.sweep!.runs) close(run.op!.node[mid]!, (10 * run.value) / (1e4 + run.value), 1e-6, `R2 = ${run.value}`);
    close(res.op!.node[mid]!, 5, 1e-6, 'основной расчёт — со значением схемы');
    assert.equal(doc.schematic.instances.find((i) => i.id === r2)!.values.resistance!.value, 1e4, 'схема не меняется');
  });

  test('импульсный источник 1 кГц, 50 %: 5 В в первой половине периода, 0 — во второй', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const s = b.part('Источник прямоугольных импульсов', 0, 100), r = b.res(1000, 200, 100);
    b.wire(p(s, '-'), p(g, '1')); b.wire(p(s, '+'), p(r, '1')); b.wire(p(r, '2'), p(g, '1'));
    const doc = setSimSettings({ ...b.doc, simulation: { ...b.doc.simulation, tran: { stopS: 2e-3, stepS: 1e-6, startFromZero: true } } }, { analysis: 'tran' });
    const res = await simulate(doc, NG);
    ok(res);
    const n = res.tran!.node[netOfPin(doc, p(r, '1'))!.id]!;
    close(valueAt(res.tran!.time, n, 0.25e-3), 5, 1e-3, 'высокий уровень');
    assert.ok(Math.abs(valueAt(res.tran!.time, n, 0.75e-3)) < 1e-3, 'низкий уровень');
    close(valueAt(res.tran!.time, n, 1.25e-3), 5, 1e-3, 'следующий период');
  });

  test('источник тока 10 мА в 1 кОм → 10 В (ток выходит из «+»)', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const s = b.part('Источник постоянного тока', 0, 100), r = b.res(1000, 200, 100);
    b.wire(p(s, '-'), p(g, '1')); b.wire(p(s, '+'), p(r, '1')); b.wire(p(r, '2'), p(g, '1'));
    const res = await simulate(b.doc, NG, { analysis: 'op' });
    ok(res);
    close(res.op!.node[netOfPin(b.doc, p(r, '1'))!.id]!, 10, 1e-6, 'U');
  });

  test('однополупериодный выпрямитель: синус 10 В 50 Гц, 1N4007, 1 кОм — пик ≈ 10 В − Uпр', async () => {
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const s = b.part('Источник синусоидального напряжения', 0, 100), d = b.part('1N4007', 150, 0), r = b.res(1000, 300, 150);
    b.value(s, 'amplitude', 10, 'V'); b.value(s, 'frequency', 50, 'Hz');
    b.wire(p(s, '-'), p(g, '1')); b.wire(p(s, '+'), p(d, '2')); b.wire(p(d, '1'), p(r, '1')); b.wire(p(r, '2'), p(g, '1'));
    const doc = setSimSettings({ ...b.doc, simulation: { ...b.doc.simulation, tran: { stopS: 40e-3, stepS: 20e-6, startFromZero: true } } }, { analysis: 'tran' });
    const res = await simulate(doc, NG);
    ok(res);
    const out = res.tran!.node[netOfPin(doc, p(r, '1'))!.id]!;
    within(Math.max(...out), 9.25, 9.45, 'пик на нагрузке');
    within(Math.min(...out), -1e-3, 1e-3, 'отрицательная полуволна отсечена');
  });

  test('модель из даташита (.model D … ) подключается к своей детали и считается', async () => {
    const parsed = parseUserModel('* модель из даташита\n.model D1N914 D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p\n+ M=0.4 Tt=20n Bv=100 Ibv=100n) ; комментарий');
    assert.ok(parsed.ok);
    const tpl = templateFromParsed(parsed.model, { A: '2', K: '1' });
    assert.deepEqual(tpl.missing, []);
    const b = new Builder();
    const g = b.place('GND', 0, 300);
    const v = b.vsrc(5, 0, 100, g), r = b.res(1000, 150, 0), d = b.part('1N4148', 300, 100);
    b.wire(p(v, '+'), p(r, '1')); b.wire(p(r, '2'), p(d, '2')); b.wire(p(d, '1'), p(g, '1'));
    const part = b.doc.schematic.instances.find((i) => i.id === d)!.partId;
    const modelId = newId();
    const doc = {
      ...b.doc,
      library: {
        ...b.doc.library,
        models: [...b.doc.library.models, { id: modelId, name: 'D1N914 (из даташита)', kind: 'spice-primitive' as const, text: tpl.text, source: 'даташит', verified: false }],
        parts: b.doc.library.parts.map((x) => (x.id === part ? { ...x, modelId } : x)),
      },
    };
    const res = await simulate(doc, NG, { analysis: 'op' });
    ok(res);
    within(res.op!.node[netOfPin(doc, p(d, '2'))!.id]!, 0.55, 0.75, 'U пр 1N914 при 4 мА');
    assert.match(res.netlist, /\.model m_[0-9a-f]+ D\(Is=2\.52n Rs=0\.568 N=1\.752 Cjo=4p M=0\.4/);
  });
});
