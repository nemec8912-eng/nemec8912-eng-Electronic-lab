/** Модели деталей этапа 8 на настоящем ngspice: результат сверяется с формулой или с поведением по даташиту. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { netOfPin } from '../../src/core/schematic';
import { setSimSettings, setTranSettings } from '../../src/core/instruments';
import type { ProjectDoc } from '../../src/core/model';
import { waveStats } from '../../src/sim/readings';
import { simulate } from '../../src/sim/simulate';
import { buildNetlist, analysesFor } from '../../src/sim/netlist';
import { Builder, ngspiceForTests, p, requireNgspice } from '../sim-helpers';

const NG = ngspiceForTests();
const skip = !NG && !requireNgspice ? 'ngspice не найден' : false;

let pos = 0;
const at = () => { pos += 1; return { x: (pos % 6) * 150, y: Math.floor(pos / 6) * 150 }; };
const make = (name: string) => { pos = 0; const b = new Builder(name); const g = b.place('GND', 400, 900); return { b, g }; };
const part = (b: Builder, pn: string) => { const a = at(); return b.part(pn, a.x, a.y); };
const res = (b: Builder, ohms: number) => { const a = at(); return b.res(ohms, a.x, a.y); };
const vsrc = (b: Builder, volts: number, g: string) => { const a = at(); return b.vsrc(volts, a.x, a.y, g); };
const node = (d: ProjectDoc, id: string, pin: string) => netOfPin(d, p(id, pin))!.id;
const op = async (d: ProjectDoc) => {
  const r = await simulate(d, NG, { analysis: 'op', sweep: false });
  assert.equal(r.status, 'ok', JSON.stringify(r.error ?? r.issues));
  return r.op!;
};
const tran = async (d: ProjectDoc, stopS: number, stepS: number) => {
  const r = await simulate(setTranSettings(setSimSettings(d, { analysis: 'tran' }), { stopS, stepS, startFromZero: true }), NG, { analysis: 'tran', sweep: false });
  assert.equal(r.status, 'ok', JSON.stringify(r.error ?? r.issues));
  return r;
};

describe('Модели этапа 8 (ngspice)', { skip }, () => {
  test('реле SRD-05VDC: 5 В — контакт NO замкнут, 0,3 В — замкнут NC', async () => {
    for (const [coil, no, nc] of [[5, 5, 0], [0.3, 0, 5]] as const) {
      const { b, g } = make('Реле');
      const k = part(b, 'SRD-05VDC-SL-C');
      const v = vsrc(b, coil, g), v5 = vsrc(b, 5, g);
      const rno = res(b, 1000), rnc = res(b, 1000);
      b.wire(p(v, '+'), p(k, '1')); b.wire(p(k, '2'), p(g, '1'));
      b.wire(p(v5, '+'), p(k, '3'));
      b.wire(p(k, '4'), p(rno, '1')); b.wire(p(rno, '2'), p(g, '1'));
      b.wire(p(k, '5'), p(rnc, '1')); b.wire(p(rnc, '2'), p(g, '1'));
      const o = await op(b.doc);
      assert.ok(Math.abs(o.node[node(b.doc, k, '4')]! - no) < 0.01, `NO при ${coil} В`);
      assert.ok(Math.abs(o.node[node(b.doc, k, '5')]! - nc) < 0.01, `NC при ${coil} В`);
    }
  });

  test('трансформатор 230 → 12,6 В: амплитуда на нагрузке 100 Ом ≈ 17,6 В', async () => {
    const { b, g } = make('Трансформатор');
    const a = at();
    const src = b.part('Источник синусоидального напряжения', a.x, a.y);
    b.value(src, 'amplitude', 325, 'V'); b.value(src, 'frequency', 50, 'Hz');
    const t = part(b, 'Трансформатор (вне платы, клеммы)');
    const rl = res(b, 100);
    b.wire(p(src, '+'), p(t, '1')); b.wire(p(src, '-'), p(g, '1')); b.wire(p(t, '2'), p(g, '1'));
    b.wire(p(t, '3'), p(rl, '1')); b.wire(p(t, '4'), p(rl, '2'));
    const r = await tran(b.doc, 0.1, 2e-5);
    const s1 = r.tran!.node[node(b.doc, t, '3')]!, s2 = r.tran!.node[node(b.doc, t, '4')]!;
    const st = waveStats(r.tran!.time, s1.map((v, i) => v - s2[i]!), 0.02)!;
    assert.ok(st.max > 16.5 && st.max < 18, `Uмакс = ${st.max}`);
    assert.ok(Math.abs(st.freq! - 50) < 1, `f = ${st.freq}`);
  });

  test('потенциометр 10 кОм, движок 25 %: делитель 7,5 В из 10 В; NTC при 50 °C и фоторезистор при 10 лк', async () => {
    const { b, g } = make('Датчики');
    const v = vsrc(b, 10, g);
    const pot = part(b, 'Резистор подстроечный 3296W');
    b.value(pot, 'position', 25, '%');
    const load = res(b, 1e9); // вывод движка не может висеть: нагрузка 1 ГОм не меняет делитель
    b.wire(p(v, '+'), p(pot, '1')); b.wire(p(pot, '3'), p(g, '1')); b.wire(p(pot, '2'), p(load, '1')); b.wire(p(load, '2'), p(g, '1'));
    const v5 = vsrc(b, 5, g);
    const rt = res(b, 10_000), ntc = part(b, 'Терморезистор NTC 10 кОм (B 3950)');
    b.value(ntc, 'temperature', 50, '°C');
    b.wire(p(v5, '+'), p(rt, '1')); b.wire(p(rt, '2'), p(ntc, '1')); b.wire(p(ntc, '2'), p(g, '1'));
    const rl = res(b, 10_000), ldr = part(b, 'GL5528');
    b.wire(p(v5, '+'), p(rl, '1')); b.wire(p(rl, '2'), p(ldr, '1')); b.wire(p(ldr, '2'), p(g, '1'));
    const o = await op(b.doc);
    assert.ok(Math.abs(o.node[node(b.doc, pot, '2')]! - 7.5) < 0.01, `движок ${o.node[node(b.doc, pot, '2')]}`);
    const Rn = 10_000 * Math.exp(3950 * (1 / 323.15 - 1 / 298.15));
    assert.ok(Math.abs(o.node[node(b.doc, ntc, '1')]! - (5 * Rn) / (Rn + 10_000)) < 1e-3);
    assert.ok(Math.abs(o.node[node(b.doc, ldr, '1')]! - 2.5) < 1e-3, 'фоторезистор 10 кОм при 10 лк');
  });

  test('CD4093: RC-генератор на триггере Шмитта — частота по формуле порогов (±10 %); CD4011 — логика И-НЕ', async () => {
    const { b, g } = make('Генератор');
    const v = vsrc(b, 5, g);
    const dd = part(b, 'CD4093B');
    const r = res(b, 100_000);
    const a = at();
    const c = b.part('Конденсатор керамический выводной', a.x, a.y);
    b.value(c, 'capacitance', 1e-9, 'F');
    b.wire(p(v, '+'), p(dd, '14')); b.wire(p(dd, '7'), p(g, '1'));
    b.wire(p(dd, '1'), p(dd, '2')); b.wire(p(dd, '3'), p(r, '2')); b.wire(p(r, '1'), p(dd, '1'));
    b.wire(p(c, '1'), p(dd, '1')); b.wire(p(c, '2'), p(g, '1'));
    // Неиспользуемые входы — на землю (как требует КМОП)
    for (const pin of ['5', '6', '8', '9', '12', '13']) b.wire(p(dd, pin), p(g, '1'));
    const run = await tran(b.doc, 2e-3, 2e-7);
    const st = waveStats(run.tran!.time, run.tran!.node[node(b.doc, dd, '3')]!, 1e-3)!;
    const f = 1 / (1e5 * 1e-9 * (Math.log((5 - 0.39 * 5) / (5 - 0.59 * 5)) + Math.log(0.59 / 0.39)));
    assert.ok(Math.abs(st.freq! / f - 1) < 0.1, `f = ${st.freq}, по формуле ${f}`);
    assert.ok(st.max > 4.8 && st.min < 0.2);

    const t = make('И-НЕ');
    const vv = vsrc(t.b, 5, t.g);
    const u = part(t.b, 'CD4011B');
    t.b.wire(p(vv, '+'), p(u, '14')); t.b.wire(p(u, '7'), p(t.g, '1'));
    t.b.wire(p(u, '1'), p(vv, '+')); t.b.wire(p(u, '2'), p(vv, '+')); // 1 И 1 → 0
    t.b.wire(p(u, '5'), p(vv, '+')); t.b.wire(p(u, '6'), p(t.g, '1')); // 1 И 0 → 1
    for (const pin of ['8', '9', '12', '13']) t.b.wire(p(u, pin), p(t.g, '1'));
    // Выходы 3 и 4 — на нагрузки, чтобы прочитать уровни; выходы 10 и 11 свободны — это не ошибка
    const l3 = res(t.b, 100_000), l4 = res(t.b, 100_000);
    t.b.wire(p(u, '3'), p(l3, '1')); t.b.wire(p(l3, '2'), p(t.g, '1'));
    t.b.wire(p(u, '4'), p(l4, '1')); t.b.wire(p(l4, '2'), p(t.g, '1'));
    const o = await op(t.b.doc);
    assert.ok(o.node[node(t.b.doc, u, '3')]! < 0.05);
    assert.ok(o.node[node(t.b.doc, u, '4')]! > 4.95);
  });

  test('оптопара PC817: 10 мА через светодиод открывают транзистор; LM393: выход по сравнению входов', async () => {
    const { b, g } = make('Оптопара');
    const v5 = vsrc(b, 5, g);
    const u = part(b, 'PC817');
    const rl = res(b, 330), rc = res(b, 1000);
    b.wire(p(v5, '+'), p(rl, '1')); b.wire(p(rl, '2'), p(u, '1')); b.wire(p(u, '2'), p(g, '1'));
    b.wire(p(v5, '+'), p(rc, '1')); b.wire(p(rc, '2'), p(u, '4')); b.wire(p(u, '3'), p(g, '1'));
    const cmp = part(b, 'LM393');
    const ra = res(b, 10_000), rb = res(b, 10_000), rpu = res(b, 10_000);
    const v3 = vsrc(b, 3, g);
    b.wire(p(v5, '+'), p(cmp, '8')); b.wire(p(cmp, '4'), p(g, '1'));
    b.wire(p(v5, '+'), p(ra, '1')); b.wire(p(ra, '2'), p(rb, '1')); b.wire(p(rb, '2'), p(g, '1')); // 2,5 В
    b.wire(p(cmp, '3'), p(ra, '2')); b.wire(p(cmp, '2'), p(v3, '+')); // + 2,5 В, − 3 В → выход низкий
    b.wire(p(rpu, '1'), p(v5, '+')); b.wire(p(rpu, '2'), p(cmp, '1'));
    b.wire(p(cmp, '5'), p(v3, '+')); b.wire(p(cmp, '6'), p(ra, '2')); // + 3 В, − 2,5 В → выход отпущен
    const o = await op(b.doc);
    assert.ok(o.node[node(b.doc, u, '4')]! < 0.3, `Uкэ = ${o.node[node(b.doc, u, '4')]}`);
    assert.ok(o.node[node(b.doc, cmp, '1')]! < 0.2);
    // Выход B свободен (открытый коллектор без подтяжки) — расчёт не блокируется
  });

  test('тиристор BT151: импульс управления включает, после импульса ток удерживается; кнопка', async () => {
    const { b, g } = make('Тиристор');
    const v12 = vsrc(b, 12, g);
    const rl = res(b, 100);
    const vs = part(b, 'BT151-500R');
    const a = at();
    const pulse = b.part('Источник прямоугольных импульсов', a.x, a.y);
    b.value(pulse, 'voltage', 5, 'V'); b.value(pulse, 'frequency', 100, 'Hz'); b.value(pulse, 'duty', 10, '%');
    const rg = res(b, 220);
    const sw = part(b, 'Кнопка тактовая 6×6 (4 вывода)');
    b.wire(p(v12, '+'), p(rl, '1')); b.wire(p(rl, '2'), p(sw, '1')); b.wire(p(sw, '2'), p(vs, '1')); b.wire(p(vs, '2'), p(g, '1'));
    b.wire(p(pulse, '+'), p(rg, '1')); b.wire(p(rg, '2'), p(vs, '3')); b.wire(p(pulse, '-'), p(g, '1'));
    // Кнопка разомкнута — ток не идёт
    let r = await tran(b.doc, 5e-3, 1e-5);
    let va = r.tran!.node[node(b.doc, vs, '1')]!;
    assert.ok(Math.max(...va) < 0.5, `кнопка разомкнута — на аноде почти нет напряжения: ${Math.max(...va)}`);
    b.value(sw, 'closed', 1, '');
    r = await tran(b.doc, 5e-3, 1e-5);
    va = r.tran!.node[node(b.doc, vs, '1')]!;
    const t = r.tran!.time;
    const at4 = va[t.findIndex((x) => x >= 4e-3)]!;
    assert.ok(at4 > 0.6 && at4 < 1.5, `после импульса тиристор открыт: ${at4} В`);
  });

  test('варистор 470 В: при 200 В ток микроамперы, при 800 В через 1 кОм напряжение ограничено; кварц в netlist', async () => {
    for (const [volts, check] of [[200, (v: number) => Math.abs(v - 200) < 0.1], [800, (v: number) => v < 600 && v > 450]] as const) {
      const { b, g } = make('Варистор');
      const v = vsrc(b, volts, g);
      const r1 = res(b, 1000);
      const ru = part(b, '14D471K');
      b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(ru, '1')); b.wire(p(ru, '2'), p(g, '1'));
      const o = await op(b.doc);
      const x = o.node[node(b.doc, ru, '1')]!;
      assert.ok(check(x), `${volts} В → ${x}`);
    }
    const { b, g } = make('Кварц');
    const q = part(b, 'Кварцевый резонатор HC-49');
    b.wire(p(q, '2'), p(g, '1'));
    const r1 = res(b, 1000);
    b.wire(p(r1, '1'), p(q, '1'));
    const nl = buildNetlist(b.doc, analysesFor(b.doc, 'op'), 'кварц');
    // Lm = 1/((2π·4 МГц)²·15 фФ) ≈ 0,1055 Гн
    assert.match(nl.text, /Lm m1 m2 0\.10\d+/);
  });
});
