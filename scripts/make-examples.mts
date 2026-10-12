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
  check(d, true);
  projects.push({ file: 'пример-rc-фильтр.elab', doc: d });
}

// 3. Мультивибратор на NE555: Ra = 1 кОм, Rb = 10 кОм, C = 10 нФ → f ≈ 1,44/((Ra + 2Rb)·C) ≈ 6,9 кГц.
{
  const b = new B('Пример — мультивибратор на NE555', 'Лабораторный БП 9 В, NE555 в автоколебательном режиме: Ra = 1 кОм, Rb = 10 кОм, C = 10 нФ, частота около 6,9 кГц. Тест → «Переходный процесс», осциллограф на выход (вывод 3). Плата: детали расставлены, земля залита, остальное — развести самостоятельно.');
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
  d = board(d, 60, 45);
  const gnd = netOfPin(d, p(g, '1'))!.id;
  d = addPour(d, { netId: gnd, layer: 'bottom', clearanceMm: 0.6 }).doc;
  check(d, false);
  projects.push({ file: 'пример-мультивибратор-ne555.elab', doc: d });
}

// 4. Стабилизатор на LM317: R1 = 240 Ом, R2 = 720 Ом → Uвых = 1,25·(1 + 720/240) + 50 мкА·720 ≈ 5,04 В.
{
  const b = new B('Пример — стабилизатор 5 В на LM317', 'Лабораторный БП 12 В, LM317, R1 = 240 Ом, R2 = 720 Ом, нагрузка 100 Ом: выход около 5,04 В, мощность на LM317 около 0,35 Вт. Есть запись журнала испытаний «Первое включение» — нажмите «Рассчитать ожидаемые значения».');
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
  d = board(d, 70, 45);
  d = setOutline(d, { kind: 'rounded', radiusMm: 3 }).doc;
  const gnd = netOfPin(d, p(g, '1'))!.id;
  d = addPour(d, { netId: gnd, layer: 'bottom', clearanceMm: 0.6 }).doc;
  check(d, false);
  const rec = { ...newRecord(d, 'Первое включение', null), supplyV: 12, instruments: 'мультиметр', conditions: 'нагрузка 100 Ом, 20 °C' };
  d = addRecord(d, rec);
  const out1 = netOfPin(d, p(u, '2'))!.id;
  const m = { ...newMeasurement(d, { kind: 'net', netId: out1 }, 'V'), measured: 5.02, instrument: 'мультиметр' };
  d = { ...d, tests: d.tests.map((t) => (t.id === rec.id ? { ...t, measurements: [m] } : t)) };
  projects.push({ file: 'пример-стабилизатор-lm317.elab', doc: d });
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
