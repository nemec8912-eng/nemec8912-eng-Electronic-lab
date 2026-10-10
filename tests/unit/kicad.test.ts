import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  footprintToPackage, guessCategory, kicadToBundle, KICAD_LICENSE, parseFootprint, parseSymbolLibrary, splitFootprintRef, summarize, isSafeKicadName,
} from '../../src/catalog-import/kicad';
import { parseSexpr } from '../../src/catalog-import/sexpr';
import { checkLibrary, lintBundle } from '../../src/core/catalog';

const FIX = path.resolve(import.meta.dirname, '../fixtures/kicad');
const sym = (lib: string) => readFileSync(path.join(FIX, 'symbols', `${lib}.kicad_sym`), 'utf8');
const fp = (lib: string, name: string) => readFileSync(path.join(FIX, 'footprints', `${lib}.pretty`, `${name}.kicad_mod`), 'utf8');
const libOf = (b: ReturnType<typeof kicadToBundle>['bundle']) => ({ parts: [b.part], symbols: [b.symbol], packages: b.packages, models: b.model ? [b.model] : [] });

test('S-выражения: строки с экранированием, вложенность, ошибки скобок', () => {
  const r = parseSexpr('(a "b \\"c\\"" (d 1 2) e)');
  assert.deepEqual(r, [['a', 'b "c"', ['d', '1', '2'], 'e']]);
  assert.throws(() => parseSexpr('(a (b)'), /Не хватает/);
  assert.throws(() => parseSexpr('(a))'), /Лишняя/);
});

test('библиотека символов: наследование extends, единицы, скрытые выводы, свойства', () => {
  const lib = parseSymbolLibrary(sym('Timer'));
  assert.deepEqual(lib.map((s) => s.name), ['ICM7555', 'NE555P', 'NE555D']);
  const ne = lib.find((s) => s.name === 'NE555P')!;
  assert.equal(ne.pins.length, 8, 'выводы взяты у родителя');
  const pins = Object.fromEntries(ne.pins.map((p) => [p.number, `${p.name}/${p.type}`]));
  assert.deepEqual(pins, { 1: 'GND/power_in', 8: 'VCC/power_in', 2: 'TR/input', 3: 'Q/output', 4: 'R/input', 5: 'CV/input', 6: 'THR/input', 7: 'DIS/input' });
  const s = summarize(ne);
  assert.equal(s.footprint, 'Package_DIP:DIP-8_W7.62mm');
  assert.equal(s.description, 'Precision Timers, 555 compatible, PDIP-8');
  assert.equal(s.keywords, 'single timer 555', 'свойство родителя');
  assert.equal(summarize(parseSymbolLibrary(sym('Device'))[0]!).datasheet, '', '«~» — нет даташита');
  assert.throws(() => parseSymbolLibrary('(footprint "x")'), /не библиотека символов/);
});

test('посадочное место: DIP-8 (KiCad 7), SOIC-8 (KiCad 8), TO-92 в старом формате module', () => {
  const dip = footprintToPackage(parseFootprint(fp('Package_DIP', 'DIP-8_W7.62mm')));
  assert.equal(dip.pkg.mount, 'THT');
  assert.equal(dip.pkg.family, 'DIP');
  assert.equal(dip.pkg.pads.length, 8);
  assert.deepEqual(dip.pkg.pads.find((p) => p.number === '5'), { number: '5', x: 7.62, y: 7.62, shape: 'oval', w: 1.6, h: 1.6, drill: 0.8 });
  assert.equal(dip.pkg.pads[0]!.shape, 'rect');
  assert.match(dip.pkg.pin1Marker ?? '', /площадка 1 отличается формой/);
  assert.equal(dip.pkg.pitchMm, 2.54);
  assert.deepEqual(dip.pkg.body, { x: 0.635, y: -1.27, w: 6.35, h: 10.16 });
  const so = footprintToPackage(parseFootprint(fp('Package_SO', 'SOIC-8_3.9x4.9mm_P1.27mm')));
  assert.equal(so.pkg.mount, 'SMD');
  assert.equal(so.pkg.pads.every((p) => p.drill === null && p.shape === 'rect'), true);
  assert.equal(so.pkg.pitchMm, 1.27);
  assert.equal(so.pkg.pin1Marker, null, 'у SOIC площадки одинаковые — ключ не выдумывается');
  const to = footprintToPackage(parseFootprint(fp('Package_TO_SOT_THT', 'TO-92_Inline')));
  assert.equal(to.pkg.pads.length, 3, 'крепёжное отверстие без номера пропущено');
  assert.equal(to.pkg.family, 'TO-92');
});

test('повёрнутые и повторяющиеся площадки: размеры меняются местами, дубли — предупреждение', () => {
  const r = footprintToPackage(parseFootprint(`(footprint "QFN-test" (attr smd)
    (pad "1" smd rect (at 0 0 90) (size 1 0.3) (layers "F.Cu"))
    (pad "2" smd custom (at 1 0) (size 0.5 0.5) (layers "F.Cu"))
    (pad "3" smd rect (at 2 2) (size 1 1) (layers "F.Cu"))
    (pad "3" smd rect (at 2.5 2.5) (size 1 1) (layers "F.Cu")))`));
  assert.deepEqual([r.pkg.pads[0]!.w, r.pkg.pads[0]!.h], [0.3, 1]);
  assert.equal(r.pkg.pads.length, 3);
  assert.ok(r.warnings.some((w) => /повторяющимися номерами/.test(w)));
  assert.ok(r.warnings.some((w) => /сложной формы \(custom\)/.test(w)));
});

test('импорт NE555P + DIP-8 + SOIC-8: деталь без ошибок, выводы на свои площадки, источник и лицензия', () => {
  const ne = parseSymbolLibrary(sym('Timer')).find((s) => s.name === 'NE555P')!;
  const { bundle: b, warnings } = kicadToBundle({
    symbol: ne, library: 'Timer', license: KICAD_LICENSE, sources: ['https://example.invalid/Timer.kicad_sym'],
    footprints: [parseFootprint(fp('Package_DIP', 'DIP-8_W7.62mm')), parseFootprint(fp('Package_SO', 'SOIC-8_3.9x4.9mm_P1.27mm'))],
  });
  assert.equal(b.part.category, 'ic-analog');
  assert.equal(b.part.refPrefix, 'DA');
  assert.equal(b.part.partNumber, 'NE555P');
  assert.equal(b.part.datasheetUrl, 'http://www.ti.com/lit/ds/symlink/ne555.pdf');
  assert.equal(b.part.origin.verified, false);
  assert.equal(b.part.origin.license, KICAD_LICENSE);
  assert.match(b.part.origin.notes, /Сверьте выводы/);
  assert.equal(b.model, null);
  assert.ok(warnings.some((w) => /Модель для расчёта не импортируется/.test(w)));
  assert.equal(b.symbol.graphic, 'box');
  assert.equal(b.symbol.pins.find((p) => p.number === '8')!.electricalType, 'power-in');
  assert.equal(b.symbol.pins.find((p) => p.number === '1')!.electricalType, 'ground', 'GND (power_in в KiCad) — земля');
  assert.equal(b.packages.length, 2);
  for (const pk of b.part.packages) assert.equal(pk.pinMap.length, 8);
  assert.deepEqual(lintBundle(b).filter((l) => l.severity === 'error'), []);
  assert.deepEqual(checkLibrary(libOf(b)), []);
});

test('транзистор BC547 (KiCad: 1=C 2=B 3=E): стандартное обозначение перенумеровано по именам', () => {
  const bc = parseSymbolLibrary(sym('Transistor_BJT')).find((s) => s.name === 'BC547')!;
  const { bundle: b } = kicadToBundle({ symbol: bc, library: 'Transistor_BJT', license: KICAD_LICENSE, sources: ['x'], footprints: [parseFootprint(fp('Package_TO_SOT_THT', 'TO-92_Inline'))] });
  assert.equal(b.part.category, 'bjt');
  assert.equal(b.symbol.graphic, 'npn');
  const byName = Object.fromEntries(b.symbol.pins.map((p) => [p.name, p.number]));
  assert.deepEqual(byName, { B: '2', C: '1', E: '3' });
  assert.deepEqual(b.part.packages[0]!.pinMap.map((m) => `${m.symbolPin}→${m.pad}`).sort(), ['1→1', '2→2', '3→3']);
  assert.deepEqual(checkLibrary(libOf(b)), []);
});

test('резистор из Device: общее обозначение, идеальная модель, без партномера', () => {
  const r = parseSymbolLibrary(sym('Device'))[0]!;
  const { bundle: b } = kicadToBundle({ symbol: r, library: 'Device', license: KICAD_LICENSE, sources: ['x'], footprints: [] });
  assert.equal(b.symbol.graphic, 'iec-resistor');
  assert.equal(b.part.partNumber, null);
  assert.equal(b.part.name, 'Resistor');
  assert.equal(b.model?.kind, 'spice-primitive');
});

test('категории и безопасные имена', () => {
  assert.equal(guessCategory('U', 'ATmega328P-PU', 'MCU_Microchip_ATmega').category, 'mcu');
  assert.equal(guessCategory('U', '74HC00', '74xx').category, 'ic-digital');
  assert.deepEqual(guessCategory('Q', 'IRF9540N', 'Transistor_FET', 'P-Channel MOSFET'), { category: 'mosfet', graphic: 'pmos' });
  assert.equal(guessCategory('D', 'LED', 'Device').category, 'led');
  assert.equal(guessCategory('D', 'BZX84Cxx', 'Diode').category, 'zener');
  assert.deepEqual(splitFootprintRef('Package_DIP:DIP-8_W7.62mm'), { library: 'Package_DIP', name: 'DIP-8_W7.62mm' });
  assert.equal(splitFootprintRef('nolib'), null);
  assert.equal(isSafeKicadName('SOIC-8_3.9x4.9mm_P1.27mm'), true);
  assert.equal(isSafeKicadName('../etc/passwd'), false);
  assert.equal(isSafeKicadName('a/b'), false);
});
