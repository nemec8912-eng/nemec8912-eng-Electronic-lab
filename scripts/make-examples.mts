// Генерация примеров проектов в examples/. Запуск: npm run examples
// Каждый пример — настоящий проект: схема из деталей справочника, настройки расчёта, плата.
// Простые примеры разведены полностью (DRC без ошибок), в остальных детали расставлены, земля залита,
// разводка оставлена как упражнение. Скрипт проверяет примеры и падает, если что-то не так.
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { builtinCatalog } from '../src/catalog/builtin';
import { addAnnotation, createProject, setDescription } from '../src/core/factory';
import { setSimSettings, setTranSettings } from '../src/core/instruments';
import { BUILTIN_PARTS } from '../src/core/library';
import type { PinRef, ProjectDoc } from '../src/core/model';
import { addTrack, drc, findPad, movePlacement, setBoard, setOutline, syncFromSchematic } from '../src/core/pcb';
import { addPour } from '../src/core/pour';
import { autoplace } from '../src/core/autoplace';
import { autoroute } from '../src/core/autoroute';
import { addCheck, newCheck } from '../src/core/checks';
import type { Check } from '../src/core/model';
import { connectPins, netOfPin, placeBuiltin, placeBundle, setValue } from '../src/core/schematic';
import { addRecord, newMeasurement, newRecord } from '../src/core/testlog';
import { writeElab } from '../src/storage/elab';

const out = path.resolve(import.meta.dirname, '../examples');

class B {
  doc: ProjectDoc;
  constructor(name: string, description: string) { this.doc = setDescription(createProject(name), description); }
  builtin(i: number, x: number, y: number) { const r = placeBuiltin(this.doc, BUILTIN_PARTS[i]!.catalogId, { x, y }); this.doc = r.doc; return r.id; }
  gnd(x: number, y: number) { return this.builtin(3, x, y); }
  part(name: string, x: number, y: number) {
    const b = builtinCatalog().find((c) => c.part.name === name || c.part.partNumber === name);
    if (!b) throw new Error(`Нет детали ${name}`);
    const r = placeBundle(this.doc, b, { x, y });
    this.doc = r.doc;
    return r.id;
  }
  value(id: string, key: string, value: number, unit: string) { this.doc = setValue(this.doc, id, key, { value, unit }); }
  wire(a: PinRef, b: PinRef) { const r = connectPins(this.doc, a, b); if (r.error) throw new Error(r.error); this.doc = r.doc; }
  note(x: number, y: number, text: string) { this.doc = addAnnotation(this.doc, { x, y }, text).doc; }
}
const p = (instanceId: string, pin: string): PinRef => ({ instanceId, pin });

function board(doc: ProjectDoc, w: number, h: number): ProjectDoc {
  let d = syncFromSchematic(doc).doc;
  d = setBoard(d, { widthMm: w, heightMm: h }).doc;
  return d;
}
const pl = (doc: ProjectDoc, id: string) => doc.pcb.placements.find((x) => x.instanceId === id)!.id;
const pad = (doc: ProjectDoc, id: string, n: string) => ({ kind: 'pad' as const, placementId: pl(doc, id), pad: n });
function track(doc: ProjectDoc, a: [string, string], b: [string, string], bends: Array<[number, number]> = []): ProjectDoc {
  const r = addTrack(doc, { from: pad(doc, ...a), to: pad(doc, ...b), layer: 'bottom', widthMm: 0.8, bends: bends.map(([x, y]) => ({ x, y })) });
  if (r.error) throw new Error(r.error);
  return r.doc;
}
const pos = (doc: ProjectDoc, id: string, n: string) => findPad(doc, pad(doc, id, n))!.pos;
function check(doc: ProjectDoc, routed: boolean) {
  const issues = drc(doc);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) throw new Error(`${doc.name}: ошибки DRC:\n${errors.map((e) => e.message).join('\n')}`);
  if (routed && issues.some((i) => i.code === 'unrouted')) throw new Error(`${doc.name}: не разведено`);
}

const projects: Array<{ file: string; doc: ProjectDoc }> = [];

/** Расставить и развести автоматически; падает, если что-то не развелось. */
function auto(doc: ProjectDoc): ProjectDoc {
  const pl = autoplace(doc);
  if (pl.notPlaced.length) throw new Error(`${doc.name}: не поместились ${pl.notPlaced.join(', ')}`);
  let d = pl.doc;
  const r = autoroute(d);
  if (r.failed.length && process.env.MDDEBUG) { console.log('FAILED', r.failed.map((f) => `${f.from}–${f.to}`)); writeFileSync('/tmp/claude-0/md-debug.json', JSON.stringify(r.doc)); }
  if (r.failed.length) throw new Error(`${doc.name}: не разведено ${r.failed.map((f) => `${f.from}–${f.to}`).join(', ')}`);
  d = r.doc;
  return d;
}
const cond = (d: ProjectDoc, c: Partial<Check> & Pick<Check, 'quantity'>) => addCheck(d, { ...newCheck(c.quantity), ...c });

// 1. Светодиод: 9 В → 470 Ом → светодиод. Ток ≈ (9 − 1,9) / 470 ≈ 15 мА.
{
  const b = new B('Пример — светодиод от 9 В', 'Источник 9 В, резистор 470 Ом и красный светодиод. Тест → «Рабочая точка»: ток светодиода около 15 мА (предел 20 мА). Плата односторонняя, разведена.');
  const g = b.gnd(0, 300);
  const v = b.builtin(2, 0, 120); b.value(v, 'voltage', 9, 'V');
  const r = b.part('Резистор 0,25 Вт выводной', 160, 40); b.value(r, 'resistance', 470, 'Ω');
  const led = b.part('Светодиод 5 мм красный', 320, 140);
  b.wire(p(v, '+'), p(r, '1')); b.wire(p(r, '2'), p(led, '2')); b.wire(p(led, '1'), p(g, '1')); b.wire(p(v, '-'), p(g, '1'));
  b.note(160, -40, 'Попробуйте прогон R1 = 220; 470; 1к — ток светодиода по кривой; при 220 Ом сработает контроль предела тока.');
  let d = setSimSettings(b.doc, { analysis: 'op' });
  d = board(d, 40, 30);
  d = movePlacement(d, pl(d, v), { x: 6.35, y: 15.24 });
  d = movePlacement(d, pl(d, r), { x: 15.24, y: 7.62 });
  d = movePlacement(d, pl(d, led), { x: 30.48, y: 20.32 });
  d = track(d, [v, '1'], [r, '1'], [[pos(d, v, '1').x, 7.62]]);
  d = track(d, [r, '2'], [led, '2'], [[pos(d, led, '2').x, pos(d, r, '2').y]]);
  d = track(d, [led, '1'], [v, '2'], [[pos(d, led, '1').x, 26.67], [pos(d, v, '2').x, 26.67]]);
  d = cond(d, { name: 'Ток светодиода 12…18 мА', quantity: 'dc-i', at: p(led, '2'), min: 0.012, max: 0.018 });
  check(d, true);
  projects.push({ file: 'пример-светодиод.elab', doc: d });
}

// 2. RC-фильтр нижних частот: 10 кОм, 100 нФ, fc = 1/(2πRC) ≈ 159 Гц.
{
  const b = new B('Пример — RC-фильтр', 'Генератор синуса 1 В, R = 10 кОм, C = 100 нФ. Тест → «Частотный (AC)»: частота среза около 159 Гц, наклон −20 дБ/декаду. Плата односторонняя, разведена.');
  const g = b.gnd(0, 300);
  const s = b.part('Источник синусоидального напряжения', 0, 120);
  const r = b.part('Резистор 0,25 Вт выводной', 160, 40);
  const c = b.part('Конденсатор керамический выводной', 320, 140); b.value(c, 'capacitance', 100e-9, 'F');
  b.wire(p(s, '+'), p(r, '1')); b.wire(p(r, '2'), p(c, '1')); b.wire(p(c, '2'), p(g, '1')); b.wire(p(s, '-'), p(g, '1'));
  let d = setSimSettings(b.doc, { analysis: 'ac', ac: { fStartHz: 10, fStopHz: 100_000, pointsPerDecade: 20 } });
  d = board(d, 40, 30);
  d = movePlacement(d, pl(d, s), { x: 6.35, y: 15.24 });
  d = movePlacement(d, pl(d, r), { x: 15.24, y: 7.62 });
  d = movePlacement(d, pl(d, c), { x: 30.48, y: 20.32 });
  d = track(d, [s, '1'], [r, '1'], [[pos(d, s, '1').x, 7.62]]);
  d = track(d, [r, '2'], [c, '1'], [[pos(d, c, '1').x, pos(d, r, '2').y]]);
  d = track(d, [c, '2'], [s, '2'], [[pos(d, c, '2').x, 26.67], [pos(d, s, '2').x, 26.67]]);
  d = cond(d, { name: 'На частоте среза — 0,707', quantity: 'ac-gain', at: p(c, '1'), input: p(s, '+'), freqHz: 159.15, min: 0.68, max: 0.73 });
  d = cond(d, { name: 'На 10 кГц ослабление больше 30 дБ', quantity: 'ac-gain', at: p(c, '1'), input: p(s, '+'), freqHz: 10_000, max: 0.0316 });
  check(d, true);
  projects.push({ file: 'пример-rc-фильтр.elab', doc: d });
}

// 3. Мультивибратор на NE555: Ra = 1 кОм, Rb = 10 кОм, C = 10 нФ → f ≈ 1,44/((Ra + 2Rb)·C) ≈ 6,9 кГц.
{
  const b = new B('Пример — мультивибратор на NE555', 'Лабораторный БП 9 В, NE555 в автоколебательном режиме: Ra = 1 кОм, Rb = 10 кОм, C = 10 нФ, частота около 6,9 кГц. Тест → «Переходный процесс», осциллограф на выход (вывод 3). Плата расставлена и разведена автоматически, земля залита. Вкладка «Проверка работы» — частота и размах на выходе.');
  const g = b.gnd(0, 360);
  const psu = b.part('Лабораторный блок питания', -40, 160); b.value(psu, 'voltage', 9, 'V');
  const u = b.part('NE555', 260, 160);
  const ra = b.part('Резистор 0,25 Вт выводной', 120, 20); b.value(ra, 'resistance', 1000, 'Ω');
  const rb = b.part('Резистор 0,25 Вт выводной', 120, 100); b.value(rb, 'resistance', 10_000, 'Ω');
  const ct = b.part('Конденсатор керамический выводной', 120, 280); b.value(ct, 'capacitance', 10e-9, 'F');
  const cc = b.part('Конденсатор керамический выводной', 260, 320); b.value(cc, 'capacitance', 10e-9, 'F');
  const rl = b.part('Резистор 0,25 Вт выводной', 420, 160); b.value(rl, 'resistance', 470, 'Ω');
  const led = b.part('Светодиод 5 мм красный', 520, 240);
  b.wire(p(psu, '+'), p(u, '8')); b.wire(p(u, '8'), p(u, '4')); b.wire(p(psu, '+'), p(ra, '1'));
  b.wire(p(ra, '2'), p(u, '7')); b.wire(p(u, '7'), p(rb, '1')); b.wire(p(rb, '2'), p(u, '6')); b.wire(p(u, '6'), p(u, '2'));
  b.wire(p(u, '2'), p(ct, '1')); b.wire(p(ct, '2'), p(g, '1')); b.wire(p(u, '5'), p(cc, '1')); b.wire(p(cc, '2'), p(g, '1'));
  b.wire(p(u, '1'), p(g, '1')); b.wire(p(psu, '-'), p(g, '1'));
  b.wire(p(u, '3'), p(rl, '1')); b.wire(p(rl, '2'), p(led, '2')); b.wire(p(led, '1'), p(g, '1'));
  let d = setTranSettings(setSimSettings(b.doc, { analysis: 'tran' }), { stopS: 2e-3, stepS: 1e-6, startFromZero: true });
  d = board(d, 50, 40);
  const gnd = netOfPin(d, p(g, '1'))!.id;
  d = addPour(d, { netId: gnd, layer: 'bottom', clearanceMm: 0.6 }).doc;
  d = auto(d);
  d = cond(d, { name: 'Частота генератора 6,5…7,3 кГц', quantity: 'tran-freq', at: p(u, '3'), min: 6500, max: 7300 });
  d = cond(d, { name: 'Размах на выходе больше 6 В', quantity: 'tran-vpp', at: p(u, '3'), min: 6 });
  check(d, true);
  projects.push({ file: 'пример-мультивибратор-ne555.elab', doc: d });
}

// 4. Стабилизатор на LM317: R1 = 240 Ом, R2 = 720 Ом → Uвых = 1,25·(1 + 720/240) + 50 мкА·720 ≈ 5,04 В.
{
  const b = new B('Пример — стабилизатор 5 В на LM317', 'Лабораторный БП 12 В, LM317, R1 = 240 Ом, R2 = 720 Ом, нагрузка 100 Ом: выход около 5,04 В, мощность на LM317 около 0,35 Вт. Есть запись журнала испытаний «Первое включение» — нажмите «Рассчитать ожидаемые значения». Плата со скруглёнными углами разведена автоматически.');
  const g = b.gnd(0, 360);
  const psu = b.part('Лабораторный блок питания', -40, 160); b.value(psu, 'voltage', 12, 'V'); b.value(psu, 'currentLimit', 0.2, 'A');
  const u = b.part('LM317T', 200, 120);
  const cin = b.part('Конденсатор керамический выводной', 80, 240); b.value(cin, 'capacitance', 100e-9, 'F');
  const r1 = b.part('Резистор 0,25 Вт выводной', 340, 120); b.value(r1, 'resistance', 240, 'Ω');
  const r2 = b.part('Резистор 0,25 Вт выводной', 340, 260); b.value(r2, 'resistance', 720, 'Ω');
  const cout = b.part('Конденсатор электролитический', 460, 200); b.value(cout, 'capacitance', 10e-6, 'F');
  const load = b.part('Резистор 2 Вт выводной', 560, 200); b.value(load, 'resistance', 100, 'Ω');
  b.wire(p(psu, '+'), p(u, '3')); b.wire(p(u, '3'), p(cin, '1')); b.wire(p(cin, '2'), p(g, '1')); b.wire(p(psu, '-'), p(g, '1'));
  b.wire(p(u, '2'), p(r1, '1')); b.wire(p(r1, '2'), p(u, '1')); b.wire(p(u, '1'), p(r2, '1')); b.wire(p(r2, '2'), p(g, '1'));
  b.wire(p(u, '2'), p(cout, '1')); b.wire(p(cout, '2'), p(g, '1')); b.wire(p(u, '2'), p(load, '1')); b.wire(p(load, '2'), p(g, '1'));
  let d = setSimSettings(b.doc, { analysis: 'op' });
  d = board(d, 60, 40);
  d = setOutline(d, { kind: 'rounded', radiusMm: 3 }).doc;
  const gnd = netOfPin(d, p(g, '1'))!.id;
  d = addPour(d, { netId: gnd, layer: 'bottom', clearanceMm: 0.6 }).doc;
  d = auto(d);
  d = cond(d, { name: 'Выход 4,8…5,2 В', quantity: 'dc-v', at: p(u, '2'), min: 4.8, max: 5.2 });
  check(d, true);
  const rec = { ...newRecord(d, 'Первое включение', null), supplyV: 12, instruments: 'мультиметр', conditions: 'нагрузка 100 Ом, 20 °C' };
  d = addRecord(d, rec);
  const out1 = netOfPin(d, p(u, '2'))!.id;
  const m = { ...newMeasurement(d, { kind: 'net', netId: out1 }, 'V'), measured: 5.02, instrument: 'мультиметр' };
  d = { ...d, tests: d.tests.map((t) => (t.id === rec.id ? { ...t, measurements: [m] } : t)) };
  projects.push({ file: 'пример-стабилизатор-lm317.elab', doc: d });
}

// 5. Металлоискатель на биениях (BFO): поисковый генератор на катушке L1 (CD4069, схема Пирса),
// опорный RC-генератор на CD4093 с подстройкой R4, смеситель И-НЕ, фильтр и пьезоизлучатель.
// Металл у катушки меняет её индуктивность → частота поискового генератора → тон биений в излучателе.
{
  const b = new B('Пример — металлоискатель на биениях',
    'Металлоискатель BFO на К561ЛН2 (CD4069) и К561ТЛ1 (CD4093), питание 9 В. Поисковый генератор на выносной катушке L1 (1 мГн) — около 151 кГц; опорный — на CD4093, подстраивается R4 так, чтобы биения были около 1…3 кГц (в примере R4 = 40 %, биения около 2,5 кГц). ' +
    'Металл рядом с катушкой меняет индуктивность: попробуйте прогон L1 = 1 мГн и 0,98 мГн — частота биений растёт. Вкладка «Проверка работы» — частоты генераторов, размах биений, ток потребления (расчёт — несколько секунд). ' +
    'Плата 70 × 50 мм, односторонняя, разведена автоматически с проволочными перемычками (П1…), земля залита; файлы для станка и сборочный чертёж — на вкладке «Плата».');
  const g = b.gnd(300, 620);
  const bat = b.builtin(2, -120, 300); b.value(bat, 'voltage', 9, 'V');
  const dd1 = b.part('CD4069UB', 200, 120);
  const coil = b.part('Катушка с сопротивлением (выносная)', 60, -40); b.value(coil, 'inductance', 1e-3, 'H'); b.value(coil, 'resistance', 3, 'Ω');
  const rf = b.part('Резистор 0,25 Вт выводной', 60, 40); b.value(rf, 'resistance', 1e6, 'Ω');
  const rs = b.part('Резистор 0,25 Вт выводной', 340, -40); b.value(rs, 'resistance', 1000, 'Ω');
  const c1 = b.part('Конденсатор керамический выводной', 0, 200); b.value(c1, 'capacitance', 2.2e-9, 'F');
  const c2 = b.part('Конденсатор керамический выводной', 420, 40); b.value(c2, 'capacitance', 2.2e-9, 'F');
  const dd2 = b.part('CD4093B', 620, 220);
  const r4 = b.part('Резистор 0,25 Вт выводной', 520, 420); b.value(r4, 'resistance', 3300, 'Ω');
  const rp = b.part('Резистор подстроечный 3296W', 680, 420); b.value(rp, 'resistance', 10_000, 'Ω'); b.value(rp, 'position', 40, '%');
  const c3 = b.part('Конденсатор керамический выводной', 820, 420); b.value(c3, 'capacitance', 1e-9, 'F');
  const r6 = b.part('Резистор 0,25 Вт выводной', 820, 200); b.value(r6, 'resistance', 2200, 'Ω');
  const c5 = b.part('Конденсатор керамический выводной', 940, 300); b.value(c5, 'capacitance', 4.7e-9, 'F');
  const c6 = b.part('Конденсатор керамический выводной', 1000, 200); b.value(c6, 'capacitance', 100e-9, 'F');
  const ha = b.part('Пьезоизлучатель ∅12 мм (без генератора)', 1120, 260);
  const cpow = b.part('Конденсатор электролитический', -40, 420); b.value(cpow, 'capacitance', 100e-6, 'F');
  // Питание: батарея 9 В (на плате — клеммы для проводов батареи)
  b.wire(p(bat, '-'), p(g, '1'));
  b.wire(p(bat, '+'), p(dd1, '14')); b.wire(p(dd1, '7'), p(g, '1')); b.wire(p(bat, '+'), p(dd2, '14')); b.wire(p(dd2, '7'), p(g, '1'));
  b.wire(p(cpow, '1'), p(bat, '+')); b.wire(p(cpow, '2'), p(g, '1'));
  // Поисковый генератор: DD1.1 (1→2), Rf 1 МОм, L1 и последовательный R между выходом и входом, C1 и C2 на землю; DD1.2 — буфер (3→4)
  b.wire(p(rf, '1'), p(dd1, '1')); b.wire(p(rf, '2'), p(dd1, '2'));
  b.wire(p(coil, '1'), p(dd1, '1')); b.wire(p(dd1, '2'), p(rs, '1')); b.wire(p(rs, '2'), p(coil, '2'));
  b.wire(p(c1, '1'), p(dd1, '1')); b.wire(p(c1, '2'), p(g, '1')); b.wire(p(c2, '1'), p(coil, '2')); b.wire(p(c2, '2'), p(g, '1'));
  b.wire(p(dd1, '3'), p(dd1, '2'));
  for (const pin of ['5', '9', '11', '13']) b.wire(p(dd1, pin), p(g, '1'));
  // Опорный генератор: DD2.1 (входы 1, 2 вместе), R3 + R4 (подстроечный, движок на конец) обратной связи, C3
  b.wire(p(dd2, '1'), p(dd2, '2')); b.wire(p(dd2, '3'), p(r4, '1')); b.wire(p(r4, '2'), p(rp, '1')); b.wire(p(rp, '2'), p(rp, '3')); b.wire(p(rp, '3'), p(dd2, '1'));
  b.wire(p(c3, '1'), p(dd2, '1')); b.wire(p(c3, '2'), p(g, '1'));
  // Смеситель DD2.2: вход 5 — поиск, 6 — опора; фильтр R6 C5; пьезо через C6
  b.wire(p(dd2, '5'), p(dd1, '4')); b.wire(p(dd2, '6'), p(dd2, '3'));
  b.wire(p(dd2, '4'), p(r6, '1')); b.wire(p(r6, '2'), p(c5, '1')); b.wire(p(c5, '2'), p(g, '1'));
  b.wire(p(c6, '1'), p(r6, '2')); b.wire(p(c6, '2'), p(ha, '1')); b.wire(p(ha, '2'), p(g, '1'));
  for (const pin of ['8', '9', '12', '13']) b.wire(p(dd2, pin), p(g, '1'));
  b.note(60, -140, 'L1 — выносная поисковая катушка (≈ 1 мГн: 50 витков ПЭЛ 0,3 на оправке ∅150 мм), подключается к клеммнику.');
  b.note(620, 520, 'R4 — подстройка частоты опорного генератора: добейтесь низкого тона биений без металла.');
  let d = setTranSettings(setSimSettings(b.doc, { analysis: 'tran', sweep: { instanceId: coil, param: 'inductance', values: [1e-3, 0.98e-3] } }), { stopS: 2e-3, stepS: 2e-7, startFromZero: true });
  d = board(d, Number(process.env.MDW ?? 70), Number(process.env.MDH ?? 50));
  const gnd = netOfPin(d, p(g, '1'))!.id;
  d = addPour(d, { netId: gnd, layer: 'bottom', clearanceMm: 0.6 }).doc;
  d = auto(d);
  d = cond(d, { name: 'Поисковый генератор 140…165 кГц', quantity: 'tran-freq', at: p(dd1, '4'), fromS: 1e-3, min: 140e3, max: 165e3 });
  d = cond(d, { name: 'Опорный генератор 140…165 кГц', quantity: 'tran-freq', at: p(dd2, '3'), fromS: 1e-3, min: 140e3, max: 165e3 });
  d = cond(d, { name: 'Биения на излучателе: размах больше 1 В', quantity: 'tran-vpp', at: p(ha, '1'), fromS: 1e-3, min: 1 });
  d = cond(d, { name: 'Ток потребления в покое не больше 5 мА', quantity: 'dc-i', at: p(bat, '+'), max: 0.005 });
  check(d, true);
  projects.push({ file: 'пример-металлоискатель.elab', doc: d });
}

// 6. Блок питания 5 В: вторичная обмотка трансформатора 9 В~ → мост из четырёх 1N4007 → 1000 мкФ → L7805.
// Амплитуда 9 В·√2 ≈ 12,7 В; после моста ≈ 10,9 В, пульсации на C1 при 100 мА ≈ I/(2fC) ≈ 1 В; L7805 держит 5 В.
{
  const b = new B('Пример — блок питания 5 В',
    'Типовой линейный блок питания: вторичная обмотка трансформатора 9 В~ 50 Гц (клеммы X1), мост из четырёх 1N4007, ' +
    'конденсатор 1000 мкФ, стабилизатор L7805, конденсаторы на выходе, нагрузка 50 Ом (100 мА) — для проверки под нагрузкой. ' +
    'Сам трансформатор (220 В) на плату не ставится — сетевое напряжение на самодельной плате опасно. ' +
    'Тест → «Переходный процесс»: на C1 пульсации около 1 В, на выходе ровные 5 В. Вкладка «Проверка работы» — выход, пульсации, запас по напряжению для L7805. ' +
    'Плата односторонняя, разведена автоматически, земля залита.');
  const g = b.gnd(300, 420);
  const ac = b.part('Источник синусоидального напряжения', -60, 160); b.value(ac, 'amplitude', 12.73, 'V'); b.value(ac, 'frequency', 50, 'Hz');
  const d1 = b.part('1N4007', 80, 60), d2 = b.part('1N4007', 80, 260), d3 = b.part('1N4007', 180, 60), d4 = b.part('1N4007', 180, 260);
  const c1 = b.part('Конденсатор электролитический', 300, 200); b.value(c1, 'capacitance', 1000e-6, 'F');
  const u = b.part('L7805CV', 420, 120);
  const c2 = b.part('Конденсатор керамический выводной', 540, 220); b.value(c2, 'capacitance', 100e-9, 'F');
  const c3 = b.part('Конденсатор электролитический', 620, 220); b.value(c3, 'capacitance', 10e-6, 'F');
  const rl = b.part('Резистор 2 Вт выводной', 720, 220); b.value(rl, 'resistance', 50, 'Ω');
  // Мост: VD1, VD2 — от клемм к «+», VD3, VD4 — от земли к клеммам (у 1N4007 вывод 2 — анод, 1 — катод)
  b.wire(p(ac, '+'), p(d1, '2')); b.wire(p(ac, '-'), p(d2, '2'));
  b.wire(p(d1, '1'), p(c1, '1')); b.wire(p(d2, '1'), p(c1, '1'));
  b.wire(p(d3, '1'), p(ac, '+')); b.wire(p(d4, '1'), p(ac, '-'));
  b.wire(p(d3, '2'), p(g, '1')); b.wire(p(d4, '2'), p(g, '1'));
  b.wire(p(c1, '2'), p(g, '1'));
  b.wire(p(c1, '1'), p(u, '1')); b.wire(p(u, '2'), p(g, '1'));
  b.wire(p(u, '3'), p(c2, '1')); b.wire(p(c2, '2'), p(g, '1'));
  b.wire(p(u, '3'), p(c3, '1')); b.wire(p(c3, '2'), p(g, '1'));
  b.wire(p(u, '3'), p(rl, '1')); b.wire(p(rl, '2'), p(g, '1'));
  b.note(-60, 40, 'X1 — к вторичной обмотке трансформатора 9 В~ (не меньше 0,3 А). Сетевую часть собирайте отдельно, с предохранителем.');
  let d = setTranSettings(setSimSettings(b.doc, { analysis: 'tran' }), { stopS: 0.2, stepS: 1e-4, startFromZero: true });
  d = board(d, 60, 40);
  const gnd = netOfPin(d, p(g, '1'))!.id;
  d = addPour(d, { netId: gnd, layer: 'bottom', clearanceMm: 0.6 }).doc;
  d = auto(d);
  d = cond(d, { name: 'Выход 4,8…5,2 В под нагрузкой 100 мА', quantity: 'tran-avg', at: p(u, '3'), fromS: 0.1, min: 4.8, max: 5.2 });
  d = cond(d, { name: 'Пульсации на выходе меньше 50 мВ', quantity: 'tran-vpp', at: p(u, '3'), fromS: 0.1, max: 0.05 });
  d = cond(d, { name: 'Запас для L7805: на входе не ниже 7,5 В', quantity: 'tran-min', at: p(u, '1'), fromS: 0.1, min: 7.5 });
  check(d, true);
  projects.push({ file: 'пример-блок-питания-5в.elab', doc: d });
}

// 0. Заметки (этап 1) — оставлен для проверки старого сценария.
{
  let doc = createProject('Пример — заметки к блоку питания');
  doc = setDescription(doc, 'Пример проекта этапа 1: только текстовые заметки.');
  const notes: Array<[number, number, string]> = [
    [40, 40, 'Вход: ~230 В, предохранитель F1 1 А'],
    [40, 120, 'Диодный мост VD1…VD4 (1N4007)'],
    [320, 120, 'C1 470 мкФ 35 В — после моста'],
    [320, 200, 'Стабилизатор U1 LM317, радиатор обязателен'],
    [40, 280, 'Проверить: пульсации на C1 под нагрузкой 0,5 А'],
  ];
  for (const [x, y, t] of notes) doc = addAnnotation(doc, { x, y }, t).doc;
  projects.push({ file: 'пример-заметки-блок-питания.elab', doc });
}

for (const { file, doc } of projects) {
  const buf = await writeElab({ doc, checkpoints: [], attachments: new Map() });
  writeFileSync(path.join(out, file), buf);
  console.log(`Записан examples/${file} (${buf.length} байт)`);
}
