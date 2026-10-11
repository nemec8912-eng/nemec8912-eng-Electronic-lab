/** Этап 3: ERC — каждое замечание с местом, объяснением и уровнем. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { builtinCatalog } from '../../src/catalog/builtin';
import { ERC_HELP, runErc } from '../../src/core/erc';
import type { ProjectDoc, WireEnd } from '../../src/core/model';
import { addLabel, drawWire, pinEnd, pinPosition, placeBundle } from '../../src/core/schematic';
import { Builder, dividerCircuit, p } from '../sim-helpers';

const NE555 = builtinCatalog().find((b) => b.part.partNumber === 'NE555')!;
const pe = (inst: string, pin: string) => ({ kind: 'end' as const, end: pinEnd(p(inst, pin)) as Extract<WireEnd, { kind: 'pin' }> });
const codes = (doc: ProjectDoc) => runErc(doc).map((i) => i.code);
function place555(b: Builder, x: number, y: number) {
  const r = placeBundle(b.doc, NE555, { x, y });
  b.doc = r.doc;
  return r.id;
}

describe('ERC', () => {
  test('правильный делитель — без ошибок и предупреждений', () => {
    const { doc } = dividerCircuit();
    assert.deepEqual(runErc(doc), []);
  });

  test('нет земли — ошибка; у каждого замечания есть объяснение', () => {
    const b = new Builder();
    const v = b.place('V', 0, 0), r = b.place('R', 200, 0);
    b.wire(p(v, '+'), p(r, '1'));
    b.wire(p(v, '-'), p(r, '2'));
    const issues = runErc(b.doc);
    assert.ok(issues.some((i) => i.code === 'no-ground' && i.severity === 'error'));
    for (const i of issues) assert.ok(ERC_HELP[i.code].length > 10);
  });

  test('микросхема: неподключённые питание и входы; у NE555 есть модель — «нет модели» не выводится', () => {
    const b = new Builder();
    const u = place555(b, 300, 200);
    b.place('GND', 0, 0);
    const issues = runErc(b.doc);
    const vcc = issues.find((i) => i.code === 'unconnected-power')!;
    assert.equal(vcc.severity, 'error');
    assert.match(vcc.message, /DA1\.8 \(VCC\)/);
    assert.deepEqual(vcc.at, pinPosition(b.doc, p(u, '8')), 'место — точка вывода');
    assert.equal(issues.filter((i) => i.code === 'unconnected-input').length, 4);
    assert.ok(!issues.some((i) => i.code === 'no-model'));
  });

  test('питание на землю и вход питания без источника', () => {
    const b = new Builder();
    const u = place555(b, 300, 200);
    const g = b.place('GND', 300, 400);
    b.wire(p(u, '1'), p(g, '1'));
    b.wire(p(u, '8'), p(g, '1'));
    assert.ok(codes(b.doc).includes('power-on-ground'));
    const b2 = new Builder();
    const u2 = place555(b2, 300, 200);
    const r = b2.place('R', 100, 0);
    b2.wire(p(u2, '8'), p(r, '1'));
    const issues = runErc(b2.doc);
    assert.ok(issues.some((i) => i.code === 'unpowered' && i.severity === 'error'));
  });

  test('конфликт выходов и закороченные метки питания', () => {
    const b = new Builder();
    const u1 = place555(b, 200, 200), u2 = place555(b, 600, 200);
    b.wire(p(u1, '3'), p(u2, '3'));
    assert.ok(runErc(b.doc).some((i) => i.code === 'output-conflict' && i.severity === 'error' && /DA1\.3/.test(i.message) && /DA2\.3/.test(i.message)));
    const b2 = new Builder();
    const r = b2.place('R', 0, 0);
    let d = addLabel(b2.doc, '+5V', 'power', pe(r, '1')).doc;
    d = drawWire(d, pe(r, '1'), [], { kind: 'free', at: { x: -80, y: 60 } }).doc;
    d = addLabel(d, '+12V', 'power', { kind: 'wire', wireId: d.schematic.wires.at(-1)!.id, at: { x: -80, y: 60 } }).doc;
    const issues = runErc(d);
    assert.ok(issues.some((i) => i.code === 'power-short'), JSON.stringify(issues.map((i) => i.code)));
    assert.ok(issues.some((i) => i.code === 'power-label-no-source'));
  });

  test('висящий провод, одинокая метка, вывод на чужом проводе', () => {
    const b = new Builder();
    const r1 = b.place('R', 0, 0), r2 = b.place('R', 200, 0), r3 = b.place('R', 100, 100);
    let d = drawWire(b.doc, pe(r1, '2'), [], pe(r2, '1')).doc; // y=0 от 30 до 170
    d = drawWire(d, pe(r3, '1'), [{ x: 70, y: 40 }], { kind: 'free', at: { x: 70, y: 40 } }).doc;
    d = addLabel(d, 'LONELY', 'net', { kind: 'free', at: { x: 400, y: 400 } }).doc;
    // R4 ставим так, чтобы его вывод 1 лег на провод R1–R2 (x = 100, y = 0)
    const r4 = (() => { const x = b; x.doc = d; return x.place('R', 130, 0); })();
    d = b.doc;
    const issues = runErc(d);
    assert.ok(issues.some((i) => i.code === 'dangling-wire' && i.at?.x === 70 && i.at.y === 40));
    assert.ok(issues.some((i) => i.code === 'lonely-label'));
    assert.ok(issues.some((i) => i.code === 'touching-not-connected' && i.refs.includes(r4)), JSON.stringify(issues.map((i) => [i.code, i.message])));
  });

  test('сортировка: ошибки, затем предупреждения, затем сведения', () => {
    const b = new Builder();
    place555(b, 300, 200);
    const order = runErc(b.doc).map((i) => i.severity);
    assert.deepEqual(order, [...order].sort((a, c) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(c)));
  });
});
