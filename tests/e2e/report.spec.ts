/** Акт проверки для клиента: стабилизатор LM317 → расчёт ожидаемых значений → вывод → PDF. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { launch, reportAndCleanup, stubSaveDialog } from './launch';

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

test('акт для клиента: вывод по сравнению с расчётом, мастерская запоминается, PDF', async () => {
  const dir = temp('e2e-report-');
  const l = await launch({ dataDir: dir });
  await l.page.getByRole('button', { name: 'Открыть пример Пример — стабилизатор 5 В на LM317' }).click();
  await l.page.getByRole('tab', { name: 'Испытания' }).click();
  await l.page.locator('.journal-item', { hasText: 'Первое включение' }).click();
  const report = l.page.getByRole('region', { name: 'Акт для клиента' });
  await expect(report.getByTestId('report-verdict')).toContainText('не сравнены');
  await l.page.getByRole('button', { name: 'Рассчитать ожидаемые значения' }).click();
  await expect(report.getByTestId('report-verdict')).toContainText('Все измерения (1) в пределах допуска');
  await report.getByLabel('Мастерская').fill('Ремонт техники');
  await report.getByLabel('Клиент и устройство').fill('Блок питания, зав. № 7');
  await shot(l.page, 'client-report');
  const pdf = path.join(dir, 'акт.pdf');
  await stubSaveDialog(l.app, pdf);
  await report.getByRole('button', { name: 'Акт: PDF…' }).click();
  await expect(l.page.locator('.toast').last()).toContainText('Сохранено');
  expect(existsSync(pdf)).toBe(true);
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  // Мастерская запоминается на этом ПК (другой проект, другая запись)
  await l.page.keyboard.press('Control+s');
  await l.page.getByRole('button', { name: '← Проекты' }).click();
  await l.page.getByRole('button', { name: 'Открыть пример Пример — стабилизатор 5 В на LM317' }).click();
  await l.page.getByRole('tab', { name: 'Испытания' }).click();
  await l.page.locator('.journal-item', { hasText: 'Первое включение' }).click();
  await expect(l.page.getByRole('region', { name: 'Акт для клиента' }).getByLabel('Мастерская')).toHaveValue('Ремонт техники');
});
