/** Фрезерный станок: расчёт траекторий из интерфейса, проверка, предпросмотр, сохранение папки с G-code. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { launch, reportAndCleanup, stubOpenDialog } from './launch';
import { parseGcode } from '../gcode-sim';

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

test('ЧПУ: светодиод → траектории, предпросмотр, ошибка широкой фрезы, папка с G-code для GRBL', async () => {
  const { app, page } = await launch({ dataDir: temp('e2e-cnc-') });
  await page.getByRole('button', { name: 'Открыть пример Пример — светодиод от 9 В' }).click();
  await page.getByRole('tab', { name: 'Плата' }).click();
  const panel = page.getByRole('region', { name: 'Фрезерный станок' });
  await expect(panel.getByTestId('iso-width')).toHaveText('0,128 мм');
  await panel.getByRole('button', { name: 'Рассчитать траектории' }).click();
  const files = panel.getByRole('list', { name: 'Файлы для станка' }).locator('li');
  await expect(files).toHaveCount(4);
  await expect(files.first()).toContainText('1_isolation_bottom.nc');
  await expect(panel.getByTestId('cnc-issues')).toContainText('Медь всех цепей разделяется фрезой');
  await expect(page.getByTestId('cnc-preview').locator('polygon.cnc-iso').first()).toBeVisible();
  await page.getByRole('button', { name: 'Показать всё' }).click();
  await shot(page, 'cnc-preview');

  // Широкая концевая фреза: расчёт устарел, после пересчёта — ошибка «цепи замкнутся»
  await panel.getByText('Фрезы и станок').click();
  await panel.getByRole('radio', { name: 'Концевая фреза' }).click();
  const dia = panel.getByRole('textbox', { name: 'Диаметр фрезы изоляции' });
  await dia.fill('3');
  await dia.press('Enter');
  await expect(panel.getByTestId('iso-width')).toHaveText('3 мм');
  await expect(panel.getByText('Плата или настройки изменились — рассчитайте траектории заново.')).toBeVisible();
  await panel.getByRole('button', { name: 'Рассчитать траектории' }).click();
  await expect(panel.getByTestId('cnc-issues')).toContainText('цепи замкнутся');
  // Настройки фрезерования — обычные правки: Ctrl+Z отменяет диаметр, затем выбор фрезы
  await page.keyboard.press('Control+z');
  await expect(panel.getByTestId('iso-width')).toHaveText('0,8 мм');
  await page.keyboard.press('Control+z');
  await expect(panel.getByTestId('iso-width')).toHaveText('0,128 мм');

  // Сохранение: папка «<проект> — ЧПУ» с файлами и ПРОЧТИ.txt
  await panel.getByRole('button', { name: 'Рассчитать траектории' }).click();
  const out = temp('e2e-cnc-out-');
  await stubOpenDialog(app, out);
  await panel.getByRole('button', { name: 'Сохранить файлы для станка…' }).click();
  await expect(page.getByText(/Файлы для станка \(5\)/)).toBeVisible();
  const dirs = readdirSync(out);
  expect(dirs).toHaveLength(1);
  expect(dirs[0]).toMatch(/ — ЧПУ$/);
  const dir = path.join(out, dirs[0]!);
  expect(readdirSync(dir).sort()).toEqual(['1_isolation_bottom.nc', '2_drill_0.8mm.nc', '3_drill_1mm.nc', '4_cutout.nc', 'ПРОЧТИ.txt']);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.nc'))) expect(parseGcode(readFileSync(path.join(dir, f), 'ascii')).errors).toEqual([]);
  const readme = readFileSync(path.join(dir, 'ПРОЧТИ.txt'));
  expect([...readme.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(readme.toString('utf8')).toContain('Ноль станка');
  // Повторное сохранение не затирает первую папку
  await stubOpenDialog(app, out);
  await panel.getByRole('button', { name: 'Сохранить файлы для станка…' }).click();
  await expect.poll(() => readdirSync(out).length).toBe(2);
  expect(existsSync(path.join(dir, '4_cutout.nc'))).toBe(true);
});
