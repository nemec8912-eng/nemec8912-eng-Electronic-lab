/** Перемычки на односторонней плате: пример «Металлоискатель», удаление, автотрассировка, J при прокладке. */
import { mkdtempSync, rmSync } from 'node:fs';
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

test('металлоискатель: перемычки на плате, удаление и повторная автотрассировка, J при ручной прокладке', async () => {
  test.setTimeout(240_000);
  const { page } = await launch({ dataDir: temp('e2e-jumpers-') });
  await page.getByRole('button', { name: 'Открыть пример Пример — металлоискатель на биениях' }).click();
  await page.getByRole('tab', { name: 'Плата' }).click();
  const jumpers = page.locator('g.jumper');
  const n = await jumpers.count();
  expect(n).toBeGreaterThan(0);
  await expect(page.getByTestId('drc-summary')).toContainText('Ошибок: 0');
  await page.getByRole('button', { name: 'Показать всё' }).click();
  await shot(page, 'jumpers-board');

  // Выделить конец перемычки П1 → сведения и удаление
  const end = page.locator('g.via.jumper-end').first();
  await end.click({ force: true });
  const sel = page.getByRole('region', { name: 'Выделено' });
  await expect(sel).toContainText(/Перемычка П\d: .*длина/);
  await sel.getByRole('button', { name: 'Удалить перемычку' }).click();
  await expect(jumpers).toHaveCount(n - 1);
  // Автотрассировка восстанавливает соединение (дорожкой или перемычкой — как получится)
  const auto = page.getByRole('region', { name: 'Автоматически' });
  await auto.getByRole('button', { name: 'Развести дорожки (1)' }).click();
  await expect(page.getByTestId('auto-result')).toContainText('Разведено 1 из 1', { timeout: 180_000 });
  await expect(auto.getByRole('button', { name: 'Развести дорожки' })).toBeDisabled();
  await expect(page.getByTestId('drc-summary')).toContainText('Ошибок: 0');
  await page.keyboard.press('Control+z');
  await expect(auto.getByRole('button', { name: 'Развести дорожки (1)' })).toBeEnabled();
  await expect(jumpers).toHaveCount(n - 1);

  // Ручная прокладка: от площадки, J — перемычка, Esc — отмена
  const padEl = page.locator('g.pad.tht').first();
  await padEl.click({ force: true });
  await expect(page.getByTestId('route-status')).toContainText('Дорожка');
  await page.getByRole('button', { name: 'Перемычка (J)' }).click();
  await expect(page.getByTestId('route-status')).toContainText('Перемычка');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('route-status')).toHaveCount(0);
});
