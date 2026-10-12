/** Тест работоспособности из интерфейса: условие на выходе стабилизатора, итог, изменение требования. */
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

test('проверка работы: LM317 — «работает», завышенное требование — «не работает», замер', async () => {
  const { page } = await launch({ dataDir: temp('e2e-checks-') });
  await page.getByRole('button', { name: 'Открыть пример Пример — стабилизатор 5 В на LM317' }).click();
  await page.getByRole('tab', { name: 'Проверка работы' }).click();
  await page.getByRole('button', { name: 'Добавить условие' }).click();
  const item = page.getByTestId('check-item').first();
  await item.getByRole('textbox', { name: 'Название условия' }).fill('Выход 5 В');
  await item.getByRole('combobox', { name: 'Где измерять (вывод)' }).selectOption({ label: 'DA1.2 (OUT)' });
  await item.getByRole('textbox', { name: 'Не меньше' }).fill('4,8');
  await item.getByRole('textbox', { name: 'Не больше' }).fill('5,2 В');
  await item.getByRole('textbox', { name: 'Замер' }).fill('4,97');
  await item.getByRole('textbox', { name: 'Замер' }).press('Enter');
  await expect(item.locator('.check-desc')).toHaveText('Выход 5 В: постоянное напряжение (рабочая точка) DA1.2 относительно земли — от 4,8 В до 5,2 В');
  await page.getByRole('button', { name: 'Проверить работоспособность' }).click();
  await expect(page.getByTestId('verdict')).toContainText('✔ Работает: выполнены все условия (1), детали не перегружены');
  await expect(item.getByTestId('check-result')).toContainText(/Расчёт: 5,0\d В — выполнено · Замер 4,97 В — в диапазоне/);
  await shot(page, 'checks-works');

  await item.getByRole('textbox', { name: 'Не меньше' }).fill('5,5');
  await item.getByRole('textbox', { name: 'Не меньше' }).press('Enter');
  await item.getByRole('textbox', { name: 'Не больше' }).fill('6');
  await item.getByRole('textbox', { name: 'Не больше' }).press('Enter');
  await expect(page.getByTestId('verdict')).toContainText('Схема или условия изменились после проверки');
  await page.getByRole('button', { name: 'Проверить работоспособность' }).click();
  await expect(page.getByTestId('verdict')).toContainText('✘ Не работает: выполнено 0 из 1');
  await expect(item.getByTestId('check-result')).toContainText('не выполнено (нужно от 5,5 В до 6 В)');
  await expect(item.getByTestId('check-result')).toContainText('Замер 4,97 В — вне диапазона');
  await shot(page, 'checks-fails');
});
