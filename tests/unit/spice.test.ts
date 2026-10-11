import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinCatalog } from '../../src/catalog/builtin';
import { setSimSettings } from '../../src/core/instruments';
import { checkModelTemplate, evalExpr, parseUserModel, templateFromParsed, templatePins } from '../../src/core/spice';
import { buildNetlist } from '../../src/sim/netlist';
import { analysesFor } from '../../src/sim/simulate';
import { Builder, p } from '../sim-helpers';

test('шаблоны встроенных моделей проходят проверку, выводы шаблона есть у символа', () => {
  for (const b of builtinCatalog()) {
    if (!b.model || (b.model.kind !== 'spice-primitive' && b.model.kind !== 'spice-subckt')) continue;
    assert.deepEqual(checkModelTemplate(b.model.text), [], b.part.name);
    const pins = new Set(b.symbol.pins.map((x) => x.number));
    for (const n of templatePins(b.model.text)) assert.ok(pins.has(n), `${b.part.name}: вывод ${n} есть у символа`);
  }
});

test('модель не может управлять расчётом или читать файлы', () => {
  const bad = (t: string) => checkModelTemplate(t).length > 0;
  assert.ok(bad('D {n:1} {n:2} {model}\n.include /etc/passwd'));
  assert.ok(bad('D {n:1} {n:2} {model}\n.control\nshell rm -rf /\n.endc'));
  assert.ok(bad('D {n:1} {n:2} {model}\n.lib x.lib'));
  assert.ok(bad('D {n:1} {n:2} {model}\n.tran 1u 1m'));
  assert.ok(bad('D {n:1} {n:2} {model}\n.options gmin=1'));
  assert.ok(bad('D {n:1} {n:2} {model}\nR1 a b 1k'), 'второй элемент вне подсхемы');
  assert.ok(bad('X {n:1} {model}\n.subckt {model} a\nR1 a 0 1'), 'не закрыта подсхема');
  assert.ok(bad('.model x D'), 'первая строка — не элемент');
  assert.ok(bad('D {n:1} {n:2} {model}\n.model {model} D(IS={v:x})'), 'параметры экземпляра — только в строке элемента');
  assert.deepEqual(checkModelTemplate('D {n:2} {n:1} {model}\n* комментарий\n.model {model} D(IS=1n\n+ N=1.5)'), []);
});

test('вычисление выражений без eval', () => {
  assert.equal(evalExpr('duty/100/frequency-0.01/frequency', { duty: 50, frequency: 1000 }), 0.00049);
  assert.equal(evalExpr('-(2+3)*4', {}), -20);
  assert.equal(evalExpr('1e3*2', {}), 2000);
  assert.throws(() => evalExpr('process.exit()', {}));
  assert.throws(() => evalExpr('x', {}), /Нет параметра/);
  assert.throws(() => evalExpr('1/0', {}), /конечного/);
});

test('разбор модели из даташита: .model с продолжениями и комментариями; .subckt с портами', () => {
  const m = parseUserModel('* BC337\n.MODEL BC337 NPN(IS=1E-14 BF=300 ; усиление\n+ VAF=100)\n');
  assert.ok(m.ok && m.model.kind === 'model' && m.model.type === 'NPN');
  if (!m.ok || m.model.kind !== 'model') return;
  assert.equal(m.model.body, '.model {model} NPN(IS=1E-14 BF=300 VAF=100)');
  const t = templateFromParsed(m.model, { C: '2', B: '1', E: '3' });
  assert.equal(t.text.split('\n')[0], 'Q {n:2} {n:1} {n:3} {model}');
  assert.deepEqual(checkModelTemplate(t.text), []);
  assert.deepEqual(templateFromParsed(m.model, { C: '2' }).missing, ['B', 'E']);

  const s = parseUserModel('.SUBCKT TL431 K A REF\nR1 K A 1MEG\n.ENDS TL431');
  assert.ok(s.ok && s.model.kind === 'subckt');
  if (!s.ok || s.model.kind !== 'subckt') return;
  assert.deepEqual(s.model.ports, ['K', 'A', 'REF']);
  const ts = templateFromParsed(s.model, { K: '1', A: '2', REF: '3' });
  assert.equal(ts.text.split('\n')[0], 'X {n:1} {n:2} {n:3} {model}');
  assert.match(ts.text, /^\.SUBCKT \{model\} K A REF$/m);
  assert.match(ts.text, /^\.ENDS \{model\}$/m);
  assert.deepEqual(checkModelTemplate(ts.text), []);

  assert.equal(parseUserModel('').ok, false);
  assert.equal(parseUserModel('.model X SW(VT=1)').ok, false, 'тип SW не поддерживается');
  assert.equal(parseUserModel('.subckt X a\nR1 a 0 1').ok, false, 'нет .ends');
});

test('netlist: амперметры на выводах приборов, карточка модели один раз, анализы DC и AC', () => {
  const b = new Builder();
  const g = b.place('GND', 0, 300);
  const v = b.vsrc(5, 0, 100, g), r1 = b.res(1000, 150, 0), r2 = b.res(1000, 150, 200);
  const d1 = b.part('1N4148', 300, 50), d2 = b.part('1N4148', 300, 250);
  b.wire(p(v, '+'), p(r1, '1')); b.wire(p(r1, '2'), p(d1, '2')); b.wire(p(d1, '1'), p(g, '1'));
  b.wire(p(v, '+'), p(r2, '1')); b.wire(p(r2, '2'), p(d2, '2')); b.wire(p(d2, '1'), p(g, '1'));
  const nl = buildNetlist(b.doc, { op: true, tran: null });
  assert.deepEqual(nl.issues.filter((i) => i.severity === 'error'), []);
  assert.equal((nl.text.match(/^\.model /gm) ?? []).length, 1, 'одна карточка на модель');
  assert.match(nl.text, /^v_d_vd1_1 n2 d_vd1_p1 0$/m, 'амперметр анода: узел цепи → внутренний узел');
  assert.match(nl.text, /^D_VD1 d_vd1_p1 d_vd1_p2 m_[0-9a-f]+$/m, 'буква элемента — D (обозначение VD1 начинается с V)');
  assert.deepEqual([...nl.pinCurrentVectors.get(d1)!.entries()], [['2', 'i(v_d_vd1_1)'], ['1', 'i(v_d_vd1_2)']]);

  const dc = buildNetlist(setSimSettings(b.doc, { analysis: 'dc', dc: { sourceId: v, start: 0, stop: 5, step: 0.5 } }), analysesFor(setSimSettings(b.doc, { analysis: 'dc', dc: { sourceId: v, start: 0, stop: 5, step: 0.5 } }), 'dc'));
  assert.match(dc.text, /^dc v1 0 5 0\.5$/m);
  const dcBad = buildNetlist(b.doc, { op: true, tran: null, dc: { sourceId: r1, start: 0, stop: 1, step: 0.1 } });
  assert.ok(dcBad.issues.some((i) => i.code === 'no-sweep-source' && /не источник/.test(i.message)));
  const ac = buildNetlist(b.doc, { op: true, tran: null, ac: { fStartHz: 10, fStopHz: 1e5, pointsPerDecade: 10 } });
  assert.ok(ac.issues.some((i) => i.code === 'no-ac-source'));
});

test('импульсный источник: период и длительность из частоты и заполнения', () => {
  const b = new Builder();
  const g = b.place('GND', 0, 300);
  const s = b.part('Источник прямоугольных импульсов', 0, 100), r = b.res(1000, 200, 100);
  b.value(s, 'frequency', 2000, 'Hz'); b.value(s, 'duty', 25, '%');
  b.wire(p(s, '-'), p(g, '1')); b.wire(p(s, '+'), p(r, '1')); b.wire(p(r, '2'), p(g, '1'));
  const nl = buildNetlist(b.doc, { op: true, tran: null });
  assert.match(nl.text, /PULSE\(0 5 0 0\.000005 0\.000005 0\.00012 0\.0005\)/);
  b.value(s, 'duty', 150, '%');
  assert.ok(buildNetlist(b.doc, { op: true, tran: null }).issues.some((i) => i.code === 'bad-value'));
});
