/** Примеры проектов на начальном экране: открывается копия, схема, плата и журнал — на месте. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test } from 'playwright/test';
import { launch, reportAndCleanup } from './launch';

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test('примеры: светодиод с разведённой платой, стабилизатор с журналом; пример не меняется', async () => {
  const { page } = await launch({ dataDir: temp('e2e-examples-') });
  const list = page.getByRole('list', { name: 'Примеры' });
  await expect(list.locator('li')).toHaveCount(6);
  await page.getByRole('button', { name: 'Открыть пример Пример — светодиод от 9 В' }).click();
  await expect(page.locator('[data-refdes="HL1"]')).toBeVisible();
  await page.getByRole('tab', { name: 'Плата' }).click();
  await expect(page.locator('g.track')).toHaveCount(3);
  await expect(page.getByTestId('drc-summary')).toHaveText('Ошибок: 0, предупреждений: 0');
  await page.getByRole('button', { name: '← Проекты' }).click();
  await page.getByRole('button', { name: 'Открыть пример Пример — стабилизатор 5 В на LM317' }).click();
  await page.getByRole('tab', { name: 'Испытания' }).click();
  await expect(page.locator('.journal-item')).toHaveText(/Первое включение/);
  await page.getByRole('tab', { name: 'Плата' }).click();
  await expect(page.locator('path.board-outline')).toHaveAttribute('data-outline', 'rounded');
  await expect(page.locator('g.pour')).toHaveCount(1);
  await page.getByRole('button', { name: '← Проекты' }).click();
  // Копии — отдельные проекты; повторное открытие примера даёт ещё одну копию
  await expect(page.getByRole('list', { name: 'Список проектов' }).locator('li')).toHaveCount(2);
});
