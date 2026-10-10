/** Получение файлов KiCad (режим тестовых данных вместо gitlab.com): единый файл и библиотека-папка KiCad 9. */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { AppError } from '../../src/core/result';
import * as src from '../../src/catalog-import/source';

process.env.ELAB_KICAD_FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/kicad');
// Источник читает переменную при каждом вызове.

test('библиотека-папка: список по файлам, символ с родителем из другого файла', async () => {
  const lib = await src.openOnlineLibrary('Timer9');
  assert.deepEqual(lib.summaries.map((s) => s.name), ['ICM7555', 'NE555D', 'NE555P']);
  const { symbol, sources } = await lib.loadSymbol('NE555D');
  assert.equal(symbol.pins.length, 8);
  assert.equal(symbol.properties.Footprint, 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
  assert.equal(sources.length, 2, 'загружены файл символа и файл родителя');
  assert.match(sources[0]!, /Timer9\.kicad_symdir\/NE555D\.kicad_sym$/);
});

test('ошибки: нет библиотеки, нет символа, недопустимое имя, неверная ссылка на посадочное место', async () => {
  await assert.rejects(src.openOnlineLibrary('Nope'), (e: unknown) => e instanceof AppError && e.code === 'import-not-found');
  const lib = await src.openOnlineLibrary('Timer');
  await assert.rejects(lib.loadSymbol('NE556'), /нет символа NE556/);
  await assert.rejects(src.openOnlineLibrary('../secret'), (e: unknown) => e instanceof AppError && e.code === 'import-name');
  await assert.rejects(src.fetchOnlineFootprint('DIP-8'), /Библиотека:Имя/);
  await assert.rejects(src.fetchOnlineFootprint('Package_DIP:../../x'), (e: unknown) => e instanceof AppError && e.code === 'import-name');
  const ok = await src.fetchOnlineFootprint('Package_DIP:DIP-8_W7.62mm');
  assert.equal(ok.fp.pads.length, 8);
  assert.match(ok.source, /^https:\/\/gitlab\.com\/kicad\/libraries\/kicad-footprints\/-\/raw\/master\/Package_DIP\.pretty\/DIP-8_W7\.62mm\.kicad_mod$/);
});
