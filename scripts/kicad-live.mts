/**
 * Проверка импорта из KiCad на настоящих файлах официальных библиотек (gitlab.com). Запускается в CI.
 * Результаты и ошибки выводятся аннотациями GitHub (::notice / ::error), код выхода 1 при ошибке.
 */
import assert from 'node:assert/strict';
import { kicadToBundle } from '../src/catalog-import/kicad';
import { fetchOnlineFootprint, openOnlineLibrary } from '../src/catalog-import/source';
import { checkLibrary, lintBundle } from '../src/core/catalog';

const out = (kind: 'notice' | 'error', msg: string) => process.stdout.write(`::${kind} title=KiCad live::${msg.replace(/\r?\n/g, ' ')}\n`);
let failed = 0;

async function check(name: string, f: () => Promise<void>) {
  try { await f(); out('notice', `OK: ${name}`); } catch (e) { failed++; out('error', `${name}: ${(e as Error).message}`); }
}

await check('NE555P + DIP-8 + SOIC-8', async () => {
  const lib = await openOnlineLibrary('Timer');
  out('notice', `Timer: ${lib.summaries.length} символов, источник ${lib.origin}`);
  assert.ok(lib.summaries.some((s) => s.name === 'NE555P'), 'в библиотеке Timer нет NE555P');
  const { symbol, sources } = await lib.loadSymbol('NE555P');
  const dip = await fetchOnlineFootprint('Package_DIP:DIP-8_W7.62mm');
  const soic = await fetchOnlineFootprint('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
  const { bundle: b, warnings } = kicadToBundle({ symbol, library: 'Timer', footprints: [dip.fp, soic.fp], sources: [...sources, dip.source, soic.source], license: lib.license });
  const pins = Object.fromEntries(b.symbol.pins.map((p) => [p.number, `${p.name}:${p.electricalType}`]));
  out('notice', `NE555P: ${JSON.stringify(pins)}; предупреждения: ${warnings.join(' | ')}`);
  assert.deepEqual(Object.fromEntries(b.symbol.pins.map((p) => [p.number, p.name])), { 1: 'GND', 2: 'TR', 3: 'Q', 4: 'R', 5: 'CV', 6: 'THR', 7: 'DIS', 8: 'VCC' });
  assert.equal(b.symbol.pins.find((p) => p.number === '1')!.electricalType, 'ground');
  assert.equal(b.packages[0]!.pads.length, 8);
  assert.equal(b.packages[0]!.pitchMm, 2.54);
  assert.equal(b.packages[1]!.mount, 'SMD');
  assert.equal(b.packages[1]!.pitchMm, 1.27);
  assert.deepEqual(lintBundle(b).filter((l) => l.severity === 'error'), []);
  assert.deepEqual(checkLibrary({ parts: [b.part], symbols: [b.symbol], packages: b.packages, models: [] }), []);
});

await check('BC547 + TO-92, резистор из Device', async () => {
  const bjt = await openOnlineLibrary('Transistor_BJT');
  const { symbol } = await bjt.loadSymbol('BC547');
  const to92 = await fetchOnlineFootprint('Package_TO_SOT_THT:TO-92_Inline');
  const { bundle: b } = kicadToBundle({ symbol, library: 'Transistor_BJT', footprints: [to92.fp], sources: [], license: bjt.license });
  out('notice', `BC547: ${b.symbol.graphic} ${JSON.stringify(b.symbol.pins.map((p) => `${p.number}=${p.name}`))}, площадки ${JSON.stringify(b.packages[0]?.pads.map((p) => p.number))}`);
  assert.equal(b.part.category, 'bjt');
  assert.deepEqual(b.symbol.pins.map((p) => p.name).sort(), ['B', 'C', 'E']);
  assert.equal(b.packages[0]!.pads.length, 3);
  assert.deepEqual(lintBundle(b).filter((l) => l.severity === 'error'), []);
  const dev = await openOnlineLibrary('Device');
  out('notice', `Device: ${dev.summaries.length} символов, источник ${dev.origin}`);
  const { symbol: r } = await dev.loadSymbol('R');
  const rb = kicadToBundle({ symbol: r, library: 'Device', footprints: [], sources: [], license: dev.license }).bundle;
  assert.equal(rb.symbol.graphic, 'iec-resistor');
});

process.exit(failed ? 1 : 0);
