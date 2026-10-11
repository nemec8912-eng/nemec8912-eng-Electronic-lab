/** Этап 3: лист схемы для экспорта и печати, список соединений (интерфейс к расчёту и плате). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connectionList, connectionListText } from '../../src/core/netlist';
import { addAnnotation } from '../../src/core/factory';
import { contentBounds, MM_PER_UNIT, PAGE_MM, sheetSvg } from '../../src/core/sheet';
import { syncFromSchematic } from '../../src/core/pcb';
import { dividerCircuit } from '../sim-helpers';

const attr = (svg: string, name: string) => new RegExp(`<svg[^>]*\\s${name}="([^"]+)"`).exec(svg)?.[1];

describe('Лист схемы', () => {
  test('A4 альбомный и A3 книжный: размеры страницы в мм, рамка, основная надпись', () => {
    const { doc } = dividerCircuit();
    const a4 = sheetSvg(doc, { size: 'A4', orientation: 'landscape', frame: true, scale: 'fit', notes: false, author: 'Иванов', date: new Date('2026-10-11T10:00:00Z') });
    assert.equal(a4.widthMm, 297);
    assert.equal(a4.heightMm, 210);
    assert.equal(attr(a4.svg, 'width'), '297mm');
    assert.equal(attr(a4.svg, 'height'), '210mm');
    assert.equal(attr(a4.svg, 'viewBox'), '0 0 297 210');
    assert.match(a4.svg, /Схема электрическая принципиальная/);
    assert.match(a4.svg, />Делитель</);
    assert.match(a4.svg, />Иванов</);
    assert.match(a4.svg, />11\.10\.2026</);
    assert.equal(a4.clipped, false);
    const a3 = sheetSvg(doc, { size: 'A3', orientation: 'portrait', frame: true, scale: 1, notes: false });
    assert.deepEqual([a3.widthMm, a3.heightMm], [PAGE_MM.A3[1], PAGE_MM.A3[0]]);
    assert.equal(a3.scale, 1);
    assert.match(a3.svg, />1:1</);
  });

  test('масштаб 1:1 без рамки: шаг сетки 10 единиц = 2,54 мм, поля 10 мм', () => {
    const { doc } = dividerCircuit();
    const b = contentBounds(doc, false)!;
    const r = sheetSvg(doc, { size: 'A4', orientation: 'landscape', frame: false, scale: 1, notes: false });
    assert.equal(MM_PER_UNIT, 0.254);
    assert.ok(Math.abs(r.widthMm - (b.w * 0.254 + 20)) < 1e-6);
    assert.ok(Math.abs(r.heightMm - (b.h * 0.254 + 20)) < 1e-6);
    const r2 = sheetSvg(doc, { size: 'A4', orientation: 'landscape', frame: false, scale: 2, notes: false });
    assert.ok(Math.abs((r2.widthMm - 20) - 2 * (r.widthMm - 20)) < 1e-6, 'масштаб 2:1 вдвое крупнее');
  });

  test('схема не помещается при 2:1 на A4 — признак обрезки; «вписать» — помещается', () => {
    let { doc } = dividerCircuit();
    doc = addAnnotation(doc, { x: 2500, y: 1500 }, 'дальняя заметка').doc;
    const big = sheetSvg(doc, { size: 'A4', orientation: 'landscape', frame: true, scale: 2, notes: true });
    assert.equal(big.clipped, true);
    const fit = sheetSvg(doc, { size: 'A4', orientation: 'landscape', frame: true, scale: 'fit', notes: true });
    assert.equal(fit.clipped, false);
    assert.ok(fit.scale < 1);
    assert.doesNotMatch(sheetSvg(doc, { size: 'A4', orientation: 'landscape', frame: true, scale: 'fit', notes: false }).svg, /дальняя заметка/, 'заметки — по выбору');
  });

  test('текст экранируется; в листе есть обозначения, номиналы и провода', () => {
    let { doc } = dividerCircuit();
    doc = { ...doc, name: 'Схема <A&B>' };
    const r = sheetSvg(doc, { size: 'A4', orientation: 'landscape', frame: true, scale: 'fit', notes: false });
    assert.match(r.svg, /Схема &lt;A&amp;B&gt;/);
    assert.doesNotMatch(r.svg, /<A&B>/);
    assert.match(r.svg, />R1</);
    assert.match(r.svg, />10 кОм</);
    assert.equal((r.svg.match(/class="wire"/g) ?? []).length, doc.schematic.wires.length);
  });
});

describe('Список соединений', () => {
  test('детали, цепи с выводами и площадками корпусов; земля по имени', () => {
    const { doc, r1, r2 } = dividerCircuit();
    const cl = connectionList(doc);
    assert.deepEqual(cl.components.map((c) => c.refDes), ['R1', 'R2', 'V1'], 'земля в перечень не входит');
    assert.equal(cl.components.find((c) => c.refDes === 'R1')!.value, '10 кОм');
    assert.equal(cl.nets.length, 3);
    const mid = cl.nets.find((n) => n.nodes.some((x) => x.instanceId === r1 && x.pin === '2'))!;
    assert.deepEqual(mid.nodes.map((x) => `${x.refDes}.${x.pin}`), ['R1.2', 'R2.1']);
    assert.ok(mid.nodes.every((x) => x.pad !== null), 'площадки — по соответствию корпуса');
    assert.ok(cl.nets.some((n) => n.name === 'GND'));
    const text = connectionListText(doc, new Date('2026-10-11T10:00:00Z'));
    assert.match(text, /R1\.2, R2\.1/);
    assert.match(text, /^Список соединений — Делитель/);
    void r2;
  });

  test('цепи совпадают с теми, что получает плата (те же UUID)', () => {
    const { doc } = dividerCircuit();
    const pcb = syncFromSchematic(doc).doc;
    const ids = new Set(connectionList(pcb).nets.map((n) => n.netId));
    assert.deepEqual(new Set(pcb.schematic.nets.map((n) => n.id)), ids);
  });
});
