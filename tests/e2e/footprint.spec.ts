/** Свой корпус по координатам: реле с нестандартной разводкой выводов, проверки площадок, сохранение. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { launch, reportAndCleanup } from './launch';

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

test('свой корпус: реле 12 В — площадки по даташиту, перекрытие и большое отверстие не принимаются, сохранение в каталог', async () => {
  const dataDir = temp('e2e-footprint-');
  const { page } = await launch({ dataDir });
  await page.getByRole('button', { name: 'Каталог деталей' }).click();
  await page.getByRole('button', { name: 'Новая деталь' }).click();
  const editor = page.locator('.part-editor');
  await editor.getByLabel('Название', { exact: true }).fill('Реле 12 В JQC-3FF');
  await editor.getByLabel('Категория').selectOption('relay');
  await editor.getByLabel('Партномер').fill('JQC-3FF-12');
  await editor.getByRole('tab', { name: /Корпуса/ }).click();
  await editor.getByRole('button', { name: 'Свой корпус (площадки по координатам)' }).click();
  const pkg = editor.locator('.pkg-block').first();
  await pkg.getByText(/Площадки по координатам/).click();
  // Координаты по даташиту: катушка 1 и 2, COM 3, NO 4, NC 5
  const coords: Array<[string, string, string, string]> = [['1', '0', '0', '1,3'], ['2', '0', '12', '1,3'], ['3', '-2', '6', '1,3'], ['4', '12,2', '0', '1,3'], ['5', '12,2', '12', '1,3']];
  for (const [n, x, y] of coords) {
    await pkg.getByLabel(`X площадки ${n}`).fill(x); await pkg.getByLabel(`X площадки ${n}`).press('Enter');
    await pkg.getByLabel(`Y площадки ${n}`).fill(y); await pkg.getByLabel(`Y площадки ${n}`).press('Enter');
  }
  // Отверстие больше площадки — отказ с объяснением
  await pkg.getByLabel('Отверстие площадки 3').fill('2');
  await pkg.getByLabel('Отверстие площадки 3').press('Enter');
  await expect(pkg.getByRole('alert')).toContainText('не меньше площадки');
  await pkg.getByLabel('Отверстие площадки 3').fill('1,1');
  await pkg.getByLabel('Отверстие площадки 3').press('Enter');
  // Перекрытие: площадка 4 поверх площадки 1 — ошибка проверки детали
  await pkg.getByLabel('X площадки 4').fill('0,5'); await pkg.getByLabel('X площадки 4').press('Enter');
  await pkg.getByLabel('Y площадки 4').fill('0'); await pkg.getByLabel('Y площадки 4').press('Enter');
  await expect(editor.locator('.editor-lint')).toContainText('площадки 1 и 4 перекрываются');
  await expect(editor.getByRole('button', { name: 'Сохранить в мой каталог' })).toBeDisabled();
  await pkg.getByLabel('X площадки 4').fill('12,2'); await pkg.getByLabel('X площадки 4').press('Enter');
  await expect(editor.locator('.editor-lint')).not.toContainText('перекрываются');
  await pkg.getByRole('button', { name: 'Контур корпуса по площадкам' }).click();
  await expect(pkg.locator('.pkg-pad[data-pad-number]')).toHaveCount(5);
  await shot(page, 'footprint-editor');
  await editor.getByRole('tab', { name: /Источник/ }).click();
  await editor.getByLabel('Откуда сведения').fill('Даташит JQC-3FF');
  await editor.getByRole('button', { name: 'Сохранить в мой каталог' }).click();
  await expect(page.locator('.part-card .part-title')).toHaveText('Реле 12 В JQC-3FF');
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'library', 'catalog.json'), 'utf8'));
  const pads = saved.packages[0].pads.map((p: { number: string; x: number; y: number; drill: number }) => [p.number, p.x, p.y, p.drill]);
  expect(pads).toEqual([['1', 0, 0, 0.9], ['2', 0, 12, 0.9], ['3', -2, 6, 1.1], ['4', 12.2, 0, 0.9], ['5', 12.2, 12, 0.9]]);
  expect(saved.packages[0].generator).toBeNull();
});
