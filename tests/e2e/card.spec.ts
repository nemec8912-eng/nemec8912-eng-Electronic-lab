/**
 * Тип + корпус → размещение под курсором → двойной щелчок → карточка → «Сохранить».
 * Проверки ТЗ: резистор 0805 = 10 кОм и перезапуск; электролит 47 мкФ / 50 В; «Отмена» и Esc;
 * Ctrl+Z / Ctrl+Y; экспорт .elab → импорт на другом «ПК»; транзистор — выводы не придумываются.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { launch, reportAndCleanup, stubOpenDialog, stubSaveDialog } from './launch';

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

async function pickTemplate(page: Page, group: string, variant: string) {
  const g = page.locator('details.template-group', { has: page.locator('summary', { hasText: new RegExp(`^${group}$`) }) });
  if (!(await g.getAttribute('open'))) await g.locator('summary').click();
  await g.getByRole('button', { name: `${group}: ${variant}`, exact: true }).click();
}
const label = (page: Page, ref: string) => page.locator(`[data-refdes="${ref}"] .inst-label`);
async function openCard(page: Page, ref: string) {
  await page.locator(`[data-refdes="${ref}"] .inst-hit`).dblclick({ force: true });
  await expect(page.getByRole('dialog', { name: `Карточка ${ref}` })).toBeVisible();
  return page.getByRole('dialog', { name: `Карточка ${ref}` });
}

test('карточка детали: резистор 0805, электролит, отмена, Undo/Redo, перезапуск, экспорт и импорт', async () => {
  const dataDir = temp('e2e-card-');
  let l = await launch({ dataDir });
  let page = l.page;
  await page.getByLabel('Название нового проекта').fill('Карточки');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const canvas = page.locator('svg.canvas');

  // Тест 1: Резисторы → SMD 0805, деталь идёт за курсором, ставится щелчком
  await pickTemplate(page, 'Резисторы', 'SMD 0805');
  await canvas.hover({ position: { x: 300, y: 200 } });
  await expect(page.getByTestId('place-ghost')).toBeVisible();
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(page.locator('[data-refdes="R1"]')).toHaveCount(1);
  await expect(page.getByTestId('place-ghost')).toHaveCount(0);
  let card = await openCard(page, 'R1');
  await expect(card.getByLabel('Корпус')).toHaveValue('keep');
  await expect(card.getByLabel('Корпус').locator('option:checked')).toHaveText(/0805/);
  await card.getByLabel('Сопротивление', { exact: true }).fill('10k');
  await card.getByLabel('Мощность').fill('0,125');
  await card.getByLabel('Допуск').fill('1');
  await shot(page, 'card-resistor');
  await card.getByLabel('Сопротивление', { exact: true }).press('Enter');
  await expect(card).toHaveCount(0);
  await expect(label(page, 'R1')).toHaveText('R110 кОм');
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '10 кОм']);

  // Тест 3: отмена кнопкой и Esc — значение прежнее
  card = await openCard(page, 'R1');
  await card.getByLabel('Сопротивление', { exact: true }).fill('22k');
  await card.getByRole('button', { name: '✕ Отмена' }).click();
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '10 кОм']);
  card = await openCard(page, 'R1');
  await card.getByLabel('Сопротивление', { exact: true }).fill('33k');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '10 кОм']);
  // Неверное значение — понятная ошибка, карточка не закрывается
  card = await openCard(page, 'R1');
  await card.getByLabel('Сопротивление', { exact: true }).fill('десять');
  await card.getByRole('button', { name: '✓ Сохранить' }).click();
  await expect(card.getByRole('alert')).toContainText('не понял «десять»');
  await card.getByLabel('Сопротивление', { exact: true }).fill('4k7');
  await card.getByRole('button', { name: '✓ Сохранить' }).click();
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '4,7 кОм']);

  // Тест 4: Undo/Redo
  await canvas.click({ position: { x: 600, y: 420 } });
  await page.keyboard.press('Control+z');
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '10 кОм']);
  await page.keyboard.press('Control+y');
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '4,7 кОм']);

  // Тест 2: электролитический конденсатор 47 мкФ / 50 В
  await pickTemplate(page, 'Конденсаторы', 'Электролитический ∅6,3 мм');
  await canvas.click({ position: { x: 450, y: 300 } });
  card = await openCard(page, 'C1');
  await card.getByLabel('Ёмкость', { exact: true }).fill('47uF');
  await card.getByLabel('Рабочее напряжение').fill('50');
  await card.getByRole('button', { name: '✓ Сохранить' }).click();
  await expect(label(page, 'C1').locator('tspan')).toHaveText(['C1', '47 мкФ / 50 В']);

  // Транзистор в TO-92: распиновка не придумывается — предупреждение и назначение в карточке
  await pickTemplate(page, 'Биполярные транзисторы', 'TO-92');
  await canvas.click({ position: { x: 200, y: 380 } });
  card = await openCard(page, 'VT1');
  await expect(card).toContainText('Выводы не назначены');
  await expect(card).toContainText('Нет модели');
  await card.getByLabel('Модель (партномер)').fill('BC547');
  await card.getByRole('button', { name: /Взять BC547: модель и выводы/ }).click();
  await card.getByRole('button', { name: '✓ Сохранить' }).click();
  await expect(label(page, 'VT1').locator('tspan')).toHaveText(['VT1', 'BC547']);
  await shot(page, 'card-schematic');

  // Сохранение, перезапуск: значения на месте
  await page.keyboard.press('Control+s');
  await expect(page.locator('.indicator')).toContainText('Сохранено');
  await l.app.close();
  l = await launch({ dataDir });
  page = l.page;
  await page.locator('.projects li', { hasText: 'Карточки' }).locator('.project-open').click();
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '4,7 кОм']);
  await expect(label(page, 'C1').locator('tspan')).toHaveText(['C1', '47 мкФ / 50 В']);

  // Тест 7: экспорт .elab → импорт на другом «ПК»
  const elab = path.join(temp('e2e-card-usb-'), 'карточки.elab');
  await stubSaveDialog(l.app, elab);
  await page.getByRole('button', { name: 'Экспорт проекта' }).click();
  await expect(page.locator('.toast').last()).toContainText('Проект экспортирован');
  await l.app.close();
  l = await launch({ dataDir: temp('e2e-card-pc2-') });
  page = l.page;
  await stubOpenDialog(l.app, elab);
  await page.getByRole('button', { name: 'Импорт проекта' }).click();
  await expect(page.getByRole('dialog')).toContainText('Проект импортирован');
  await page.getByRole('dialog').getByRole('button', { name: 'Открыть' }).click();
  await expect(label(page, 'R1').locator('tspan')).toHaveText(['R1', '4,7 кОм']);
  await expect(label(page, 'C1').locator('tspan')).toHaveText(['C1', '47 мкФ / 50 В']);
  await expect(label(page, 'VT1').locator('tspan')).toHaveText(['VT1', 'BC547']);
  card = await openCard(page, 'R1');
  await expect(card.getByLabel('Мощность')).toHaveValue('125 мВт');
  await expect(card.getByLabel('Допуск')).toHaveValue('1');
});
