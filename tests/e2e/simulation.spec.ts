/**
 * Этап 4 через интерфейс: частотный анализ RC-фильтра и частота среза, параметрический прогон,
 * развёртка DC, переходный процесс; светодиод — токи выводов и предупреждение о перегрузке;
 * своя SPICE-модель из даташита в редакторе детали.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { locateNgspice } from '../../src/sim/runner';
import { APP_DIR, launch, reportAndCleanup } from './launch';

const ngspice = locateNgspice({ env: process.env.ELAB_NGSPICE, appRoot: APP_DIR });
test.skip(!ngspice && process.env.ELAB_REQUIRE_NGSPICE !== '1', 'ngspice не найден');

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const pin = (page: Page, label: string) => page.locator(`[data-pin-label="${label}"] .pin-hit`).first();

async function newProject(page: Page, name: string) {
  await page.getByLabel('Название нового проекта').fill(name);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
}
async function place(page: Page, search: string, name: string, x: number, y: number) {
  await page.getByLabel('Поиск детали для схемы').fill(search);
  await page.getByRole('button', { name, exact: true }).click();
  await page.locator('svg.canvas').click({ position: { x, y } });
}
async function wires(page: Page, pairs: Array<[string, string]>) {
  for (const [a, b] of pairs) {
    await pin(page, a).click({ force: true });
    await pin(page, b).click({ force: true });
  }
}
async function probes(page: Page, red: string, black: string) {
  await page.getByRole('radio', { name: 'Красный (+)' }).click();
  await pin(page, red).click({ force: true });
  await page.getByRole('radio', { name: 'Чёрный (COM)' }).click();
  await pin(page, black).click({ force: true });
}

test('RC-фильтр: частотный анализ, параметрический прогон, развёртка DC, переходный процесс', async () => {
  test.setTimeout(180_000);
  const { page } = await launch({ dataDir: temp('e2e-sim-') });
  await newProject(page, 'RC-фильтр');
  await place(page, 'синус', 'Источник синусоидального напряжения', 120, 200);
  await place(page, '', 'Резистор', 300, 110);
  await place(page, '', 'Конденсатор неполярный', 450, 220);
  await place(page, '', 'Земля (общий провод)', 120, 330);
  await wires(page, [['G1.+', 'R1.1'], ['R1.2', 'C1.1'], ['C1.2', 'GND1.GND'], ['G1.−', 'GND1.GND']]);
  await expect(page.locator('g.wire')).toHaveCount(4);

  await page.getByRole('tab', { name: 'Тест' }).click();
  await probes(page, 'C1.1', 'GND1.GND');
  await page.getByRole('radio', { name: 'Частотный (AC)' }).click();
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByTestId('sim-status')).toContainText('ngspice');
  // R = 10 кОм, C = 100 нФ: fc = 1/(2πRC) = 159,2 Гц
  await expect(page.getByTestId('ac-summary')).toContainText(/Верхняя −3 дБ\s*159(,\d)? Гц/);
  await expect(page.getByRole('img', { name: 'АЧХ' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'ФЧХ' })).toBeVisible();
  await shot(page, 'test-ac');

  // Параметрический прогон: R1 = 1 кОм и 100 кОм
  const sweep = page.locator('details.sweep');
  if (!(await sweep.getAttribute('open'))) await sweep.locator('summary').click();
  await page.getByLabel('Деталь для прогона').selectOption({ label: 'R1' });
  await page.getByLabel('Значения прогона').fill('1к; 100к');
  await page.getByLabel('Значения прогона').press('Enter');
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByTestId('sim-status')).toContainText('прогонов: 3');
  await expect(page.locator('.plot-legend').first()).toContainText('R1 = 1 кОм');
  await expect(page.locator('.plot-legend').first()).toContainText('R1 = 100 кОм');
  await shot(page, 'test-ac-sweep');

  // Развёртка DC по постоянной составляющей источника: на конденсаторе в установившемся режиме — то же напряжение
  await page.getByLabel('Деталь для прогона').selectOption({ label: '— нет прогона —' });
  await page.getByRole('radio', { name: 'Развёртка DC' }).click();
  await page.getByLabel('Источник для развёртки').selectOption({ label: 'G1' });
  await page.getByLabel('От', { exact: true }).fill('0');
  await page.getByLabel('До', { exact: true }).fill('5');
  await page.getByLabel('Шаг развёртки').fill('1');
  await page.getByLabel('Шаг развёртки').press('Enter');
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByRole('img', { name: 'Развёртка DC' })).toBeVisible();
  const plot = page.getByRole('img', { name: 'Развёртка DC' });
  await plot.scrollIntoViewIfNeeded();
  const box = (await plot.boundingBox())!;
  await plot.hover({ position: { x: box.width - 12, y: box.height / 2 } });
  await expect(page.getByTestId('plot-readout')).toContainText('5 В: 5 В');

  // Переходный процесс
  await page.getByRole('radio', { name: 'Переходный процесс' }).click();
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByRole('img', { name: 'Осциллограмма' })).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.indicator')).toHaveAttribute('data-state', 'saved');
});

test('светодиод от 12 В через 100 Ом: токи выводов, предупреждение о перегрузке; модель из каталога', async () => {
  test.setTimeout(120_000);
  const { page } = await launch({ dataDir: temp('e2e-led-') });
  await newProject(page, 'Светодиод');
  await place(page, '', 'Источник постоянного напряжения', 120, 200);
  await page.getByLabel('Напряжение', { exact: true }).fill('12');
  await page.getByLabel('Напряжение', { exact: true }).press('Enter');
  await place(page, '', 'Резистор', 300, 110);
  await page.getByLabel('Сопротивление', { exact: true }).fill('100');
  await page.getByLabel('Сопротивление', { exact: true }).press('Enter');
  await place(page, 'светодиод', 'Светодиод 5 мм красный', 450, 220);
  await expect(page.getByTestId('model-note')).toContainText('около 2 В при 20 мА');
  await place(page, '', 'Земля (общий провод)', 120, 330);
  await wires(page, [['V1.+', 'R1.1'], ['R1.2', 'HL1.A'], ['HL1.K', 'GND1.GND'], ['V1.−', 'GND1.GND']]);

  await page.getByRole('tab', { name: 'Тест' }).click();
  await page.getByRole('radio', { name: 'Рабочая точка' }).click();
  await probes(page, 'HL1.A', 'HL1.K');
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByLabel('Пределы деталей')).toContainText('светодиод перегреется');
  await expect(page.getByLabel('Токи и мощности')).toContainText(/HL1.*A: 9\d мА/);
  const v = await page.getByTestId('mm-reading').textContent();
  const volts = Number(v!.replace(/[^\d,.-]/g, '').replace(',', '.'));
  expect(volts).toBeGreaterThan(1.9);
  expect(volts).toBeLessThan(2.6);
  await expect(page.getByLabel('Проверка схемы')).toContainText('не проверена');
  await shot(page, 'test-led-limits');
});

test('своя SPICE-модель из даташита: вставка, сопоставление выводов, сохранение в каталог', async () => {
  test.setTimeout(120_000);
  const { page } = await launch({ dataDir: temp('e2e-model-') });
  await page.getByRole('button', { name: 'Каталог деталей' }).click();
  await page.getByLabel('Поиск деталей').fill('1N4148');
  await page.locator('.part-row', { hasText: '1N4148' }).first().click();
  await page.getByRole('button', { name: 'Создать на основе' }).click();
  const editor = page.locator('.part-editor');
  await editor.getByLabel('Партномер').fill('1N4148-МОЙ');
  await editor.getByRole('tab', { name: /Модель/ }).click();
  await editor.getByRole('radio', { name: /Своя SPICE-модель/ }).check();
  await editor.getByLabel('Текст SPICE-модели').fill('* Vishay\n.MODEL D1N4148V D(IS=2.682n N=1.836 RS=0.5664 BV=100 IBV=100u\n+ CJO=4p M=0.3333 TT=11.54n)');
  await expect(editor.getByLabel('Вывод обозначения для A')).toHaveValue('2');
  await expect(editor.getByLabel('Вывод обозначения для K')).toHaveValue('1');
  await editor.getByLabel('Источник модели').fill('сайт Vishay, файл 1N4148.lib');
  await editor.getByRole('button', { name: 'Применить модель' }).click();
  await expect(editor).toContainText('D1N4148V (из даташита)');
  await shot(page, 'part-editor-model');
  await editor.getByRole('button', { name: 'Сохранить в мой каталог' }).click();
  await expect(page.locator('.part-card')).toContainText('D1N4148V (из даташита)');
  await expect(page.locator('.part-card')).toContainText('сайт Vishay');

  // Запрещённая команда в модели — понятная ошибка
  await page.getByRole('button', { name: 'Создать на основе' }).click();
  await editor.getByRole('tab', { name: /Модель/ }).click();
  await editor.getByRole('radio', { name: /Своя SPICE-модель/ }).check();
  await editor.getByLabel('Текст SPICE-модели').fill('.subckt EVIL a k\n.include /etc/passwd\n.ends');
  await editor.getByLabel('Вывод обозначения для a').selectOption('2');
  await editor.getByLabel('Вывод обозначения для k').selectOption('1');
  await expect(editor.locator('.model-box .issues')).toContainText('запрещена');
  await expect(editor.getByRole('button', { name: 'Применить модель' })).toBeDisabled();
});
