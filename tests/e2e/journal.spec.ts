/**
 * Этап 7 через интерфейс, по проверкам ТЗ: зафиксировать отказ резистора → сравнить измерения с
 * расчётом (расхождение и гипотезы) → изменить номинал → пересчитать (совпадение) → синхронизировать
 * плату → сравнить ревизии → восстановить старую (журнал остаётся) → фото → перенос на другой ПК.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { locateNgspice } from '../../src/sim/runner';
import { APP_DIR, launch, reportAndCleanup, stubMessageBox, stubOpenDialog, stubSaveDialog, type Launched } from './launch';

const ngspice = locateNgspice({ env: process.env.ELAB_NGSPICE, appRoot: APP_DIR });
test.skip(!ngspice && process.env.ELAB_REQUIRE_NGSPICE !== '1', 'ngspice не найден');

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const pin = (page: Page, label: string) => page.locator(`[data-pin-label="${label}"] .pin-hit`).first();
async function closeWindow(l: Launched) {
  const exited = new Promise<void>((r) => l.app.process().once('exit', () => r()));
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function newRecord(page: Page, title: string) {
  await page.getByRole('button', { name: 'Новое испытание' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('input').fill(title);
  await dlg.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByLabel('Название испытания')).toHaveValue(title);
}
async function addMeasure(page: Page, target: string, quantity: 'V' | 'Ω', value: string) {
  await page.getByLabel('Точка измерения').selectOption({ label: target });
  await page.getByLabel('Величина').selectOption(quantity);
  await page.getByRole('button', { name: 'Добавить измерение' }).click();
  const input = page.getByLabel(`Измерено ${target.replace(/^Деталь /, '')}`).last();
  await input.fill(value);
  await input.press('Enter');
}

test('журнал испытаний: отказ, расчёт с допусками, новый номинал, плата, сравнение и возврат ревизии, фото, перенос', async () => {
  test.setTimeout(240_000);
  const flash = temp('e2e-journal-flash-');
  const photo = path.join(flash, 'плата-после-включения.png');
  writeFileSync(photo, PNG);
  let l = await launch({ dataDir: temp('e2e-journal-pc1-') });
  let page = l.page;
  await page.getByLabel('Название нового проекта').fill('Делитель на макетке');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const canvas = page.locator('svg.canvas');
  const place = async (search: string, name: string, x: number, y: number) => {
    await page.getByLabel('Поиск детали для схемы').fill(search);
    await page.getByRole('button', { name, exact: true }).click();
    await canvas.click({ position: { x, y } });
  };
  // Резисторы из справочника: допуск ±1 % — он входит в расчёт разброса
  await place('', 'Источник постоянного напряжения', 120, 200);
  await place('выводной', 'Резистор 0,25 Вт выводной', 300, 110);
  await place('выводной', 'Резистор 0,25 Вт выводной', 300, 250);
  await place('', 'Земля (общий провод)', 120, 330);
  for (const [a, b] of [['V1.+', 'R1.1'], ['R1.2', 'R2.1'], ['R2.2', 'GND1.GND'], ['V1.−', 'GND1.GND']] as const) {
    await pin(page, a).click({ force: true });
    await pin(page, b).click({ force: true });
  }
  await expect(page.locator('g.wire')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Плата' }).click();
  await page.getByRole('button', { name: 'Синхронизировать со схемой' }).click();
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.keyboard.press('Control+s');

  // --- Испытание 1: R2 сгорел ---
  await page.getByRole('tab', { name: 'Испытания' }).click();
  await newRecord(page, 'Первое включение');
  await page.getByLabel('Напряжение питания').fill('5');
  await page.getByLabel('Напряжение питания').press('Tab');
  await addMeasure(page, 'Деталь R2', 'V', '4,9');
  await addMeasure(page, 'Деталь R2', 'Ω', '15к');
  await page.getByLabel('Деталь', { exact: true }).selectOption({ label: 'R2' });
  await page.getByLabel('Событие', { exact: true }).selectOption('burned');
  await page.getByRole('button', { name: 'Отметить' }).click();
  await page.getByLabel('Обстоятельства R2').fill('Потемнел и запахло после 10 с');
  await page.getByRole('button', { name: 'Рассчитать ожидаемые значения' }).click();
  await expect(page.getByTestId('calc-status')).toContainText('Рассчитано');
  const rows = page.locator('.measure-table tbody tr');
  await expect(rows.nth(0).getByTestId('verdict')).toContainText('расхождение');
  await expect(rows.nth(0)).toContainText('2,5 В ± 25 мВ'); // 1 % R1 и 1 % R2: по 12,5 мВ
  await expect(rows.nth(1).getByTestId('verdict')).toContainText('расхождение');
  await expect(rows.nth(1)).toContainText('10 кОм ± 100 Ом');
  await expect(page.getByTestId('hypotheses')).toContainText('не диагноз');
  await expect(page.getByTestId('hypotheses')).toContainText('обрыв');
  await expect(page.getByTestId('hypotheses')).toContainText('R2 — сгорела');
  // Фото
  await stubOpenDialog(l.app, photo);
  await page.getByRole('button', { name: 'Добавить фото…' }).click();
  await expect(page.locator('.photo img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await shot(page, 'journal-failure');

  // --- Изменить номинал R2 → 4,7 кОм ---
  await page.getByRole('tab', { name: 'Схема' }).click();
  await page.locator('[data-refdes="R2"] .inst-hit').click({ force: true });
  await page.getByLabel('Сопротивление').fill('4,7к');
  await page.getByLabel('Сопротивление').press('Enter');
  await expect(page.locator('[data-refdes="R2"] .inst-label')).toContainText('4,7 кОм');
  // Плата: номинал корпус не меняет — синхронизация сообщает, что плата соответствует схеме
  await page.getByRole('tab', { name: 'Плата' }).click();
  await page.getByRole('button', { name: 'Синхронизировать со схемой' }).click();
  await expect(page.getByTestId('sync-report')).toContainText('Плата соответствует схеме');

  // --- Испытание 2: пересчёт — совпадение ---
  await page.getByRole('tab', { name: 'Испытания' }).click();
  await newRecord(page, 'После замены R2');
  await page.getByLabel('Напряжение питания').fill('5');
  await page.getByLabel('Напряжение питания').press('Tab');
  await addMeasure(page, 'Деталь R2', 'V', '1,6');
  await page.getByRole('button', { name: 'Рассчитать ожидаемые значения' }).click();
  await expect(page.getByTestId('calc-status')).toContainText('Рассчитано');
  await expect(rows.nth(0).getByTestId('verdict')).toContainText('в пределах допуска');
  await expect(rows.nth(0)).toContainText(/1,599 В/);
  await expect(page.locator('.journal-item')).toHaveCount(2);

  // --- Сравнить ревизии и восстановить старую ---
  await page.locator('.journal-item', { hasText: 'Первое включение' }).click();
  await page.getByRole('button', { name: 'Сравнить с текущей' }).click();
  await expect(page.getByTestId('revision-diff')).toContainText('R2: сопротивление 10 кОм → 4,7 кОм');
  await shot(page, 'journal-diff');
  await page.getByRole('button', { name: 'Восстановить эту ревизию' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Вернуть' }).click();
  await expect(page.locator('.journal-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Сравнить с текущей' }).click();
  await expect(page.getByTestId('revision-diff')).toContainText('не изменились');
  await page.getByRole('tab', { name: 'Схема' }).click();
  await expect(page.locator('[data-refdes="R2"] .inst-label')).toContainText('10 кОм');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.indicator')).toHaveAttribute('data-state', 'saved');

  // --- Перенос: .elab с журналом, снимками ревизий и фото ---
  const elab = path.join(flash, 'Делитель.elab');
  await stubSaveDialog(l.app, elab);
  await page.getByRole('button', { name: 'Экспорт проекта' }).click();
  await expect(page.locator('.toast').last()).toContainText('Проект экспортирован');
  await closeWindow(l);

  l = await launch({ dataDir: temp('e2e-journal-pc2-') });
  page = l.page;
  await stubOpenDialog(l.app, elab);
  await page.getByRole('button', { name: 'Импорт проекта' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Открыть' }).click();
  await page.getByRole('tab', { name: 'Испытания' }).click();
  await expect(page.locator('.journal-item')).toHaveCount(2);
  await page.locator('.journal-item', { hasText: 'Первое включение' }).click();
  await expect(page.getByTestId('event-R2')).toBeVisible();
  await expect(page.locator('.photo img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.locator('.journal-item', { hasText: 'После замены R2' }).click();
  await page.getByRole('button', { name: 'Сравнить с текущей' }).click();
  await expect(page.getByTestId('revision-diff')).toContainText('R2: сопротивление 4,7 кОм → 10 кОм');
  await stubMessageBox(l.app, 1);
  await closeWindow(l);
});
