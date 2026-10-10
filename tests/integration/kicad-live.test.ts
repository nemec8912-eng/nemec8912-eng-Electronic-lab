/**
 * Проверка импорта на настоящих файлах официальных библиотек KiCad (gitlab.com).
 * Выполняется только при ELAB_LIVE_KICAD=1 (в CI); без сети пропускается.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kicadToBundle } from '../../src/catalog-import/kicad';
import { fetchOnlineFootprint, openOnlineLibrary } from '../../src/catalog-import/source';
import { checkLibrary, lintBundle } from '../../src/core/catalog';

const live = process.env.ELAB_LIVE_KICAD === '1';
const note = (msg: string) => process.stdout.write(`\n::notice title=KiCad live::${msg}\n`);

test('KiCad (gitlab.com): NE555P + DIP-8 + SOIC-8 — выводы как в даташите', { skip: !live && 'нужен ELAB_LIVE_KICAD=1' }, async () => {
  const lib = await openOnlineLibrary('Timer');
  note(`Timer: ${lib.summaries.length} символов, источник ${lib.origin}`);
  assert.ok(lib.summaries.some((s) => s.name === 'NE555P'), 'в библиотеке Timer есть NE555P');
  const { symbol, sources } = await lib.loadSymbol('NE555P');
  const dip = await fetchOnlineFootprint('Package_DIP:DIP-8_W7.62mm');
  const soic = await fetchOnlineFootprint('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
  const { bundle: b, warnings } = kicadToBundle({ symbol, library: 'Timer', footprints: [dip.fp, soic.fp], sources: [...sources, dip.source, soic.source], license: lib.license });
  const pins = Object.fromEntries(b.symbol.pins.map((p) => [p.number, p.name]));
  note(`NE555P выводы: ${JSON.stringify(pins)}; предупреждения: ${warnings.join(' | ')}`);
  assert.deepEqual(pins, { 1: 'GND', 2: 'TR', 3: 'Q', 4: 'R', 5: 'CV', 6: 'THR', 7: 'DIS', 8: 'VCC' });
  assert.equal(b.symbol.pins.find((p) => p.number === '1')!.electricalType, 'ground');
  assert.equal(b.packages[0]!.pads.length, 8);
  assert.equal(b.packages[0]!.pitchMm, 2.54);
  assert.equal(b.packages[1]!.mount, 'SMD');
  assert.equal(b.packages[1]!.pitchMm, 1.27);
  assert.deepEqual(lintBundle(b).filter((l) => l.severity === 'error'), []);
  assert.deepEqual(checkLibrary({ parts: [b.part], symbols: [b.symbol], packages: b.packages, models: [] }), []);
});

test('KiCad (gitlab.com): BC547 — стандартное обозначение n-p-n, выводы по именам; резистор из Device', { skip: !live && 'нужен ELAB_LIVE_KICAD=1' }, async () => {
  const bjt = await openOnlineLibrary('Transistor_BJT');
  const { symbol } = await bjt.loadSymbol('BC547');
  const to92 = await fetchOnlineFootprint('Package_TO_SOT_THT:TO-92_Inline');
  const { bundle: b } = kicadToBundle({ symbol, library: 'Transistor_BJT', footprints: [to92.fp], sources: [], license: bjt.license });
  note(`BC547: ${b.symbol.graphic} ${JSON.stringify(b.symbol.pins.map((p) => `${p.number}=${p.name}`))}`);
  assert.equal(b.part.category, 'bjt');
  assert.deepEqual(b.symbol.pins.map((p) => p.name).sort(), ['B', 'C', 'E']);
  assert.equal(b.packages[0]!.pads.length, 3);
  assert.deepEqual(lintBundle(b).filter((l) => l.severity === 'error'), []);
  const dev = await openOnlineLibrary('Device');
  const { symbol: r } = await dev.loadSymbol('R');
  const rb = kicadToBundle({ symbol: r, library: 'Device', footprints: [], sources: [], license: dev.license }).bundle;
  assert.equal(rb.symbol.graphic, 'iec-resistor');
});
