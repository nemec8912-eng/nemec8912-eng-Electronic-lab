/**
 * Этап 5 через интерфейс: RC-цепь от лабораторного блока питания — мультиметр (V⎓, Ω с отключением
 * питания), блок питания (CV/CC, выключение выхода), осциллограф (заряд конденсатора, синхронизация,
 * автоизмерения, курсоры), амперметр в разрыв цепи, ESR-метр электролита.
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
const run = async (page: Page) => {
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByTestId('sim-status')).toContainText('ngspice');
};

test('RC-цепь от блока питания: мультиметр, БП, осциллограф, амперметр, ESR-метр', async () => {
  test.setTimeout(240_000);
  const { page } = await launch({ dataDir: temp('e2e-inst-') });
  await page.getByLabel('Название нового проекта').fill('Приборы');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await place(page, 'блок питания', 'Лабораторный блок питания', 120, 200);
  await place(page, '', 'Резистор', 300, 110);
  await place(page, '', 'Конденсатор неполярный', 450, 220);
  await place(page, '', 'Земля (общий провод)', 120, 330);
  await wires(page, [['G1.+', 'R1.1'], ['R1.2', 'C1.1'], ['C1.2', 'GND1.GND'], ['G1.−', 'GND1.GND']]);
  await expect(page.locator('g.wire')).toHaveCount(4);

  await page.getByRole('tab', { name: 'Тест' }).click();
  // Мультиметр V⎓: рабочая точка — конденсатор заряжен до 5 В
  await pin(page, 'C1.1').click({ force: true });
  await page.getByRole('radio', { name: 'Чёрный (COM)' }).click();
  await pin(page, 'GND1.GND').click({ force: true });
  await page.getByRole('radio', { name: 'Рабочая точка' }).click();
  await run(page);
  await expect(page.getByTestId('mm-reading')).toHaveText('5 В');
  await expect(page.getByTestId('mm-method')).toContainText('рабочей точке');

  // Ω: питание отключается, прибор подаёт свой ток
  await page.getByRole('radio', { name: 'Ω' }).click();
  await page.getByRole('radio', { name: 'Красный (+)' }).click();
  await pin(page, 'R1.1').click({ force: true });
  await page.getByRole('radio', { name: 'Чёрный (COM)' }).click();
  await pin(page, 'R1.2').click({ force: true });
  await page.getByRole('button', { name: 'Измерить' }).click();
  await expect(page.getByTestId('mm-reading')).toHaveText('10 кОм');
  await expect(page.getByTestId('mm-method')).toContainText('Питание схемы отключено');
  await shot(page, 'inst-ohm');

  // Блок питания: CV; ограничение тока 0,1 мА при нагрузке через R1 на землю (перемычка C1 → прозвонка не нужна)
  await page.getByRole('tab', { name: 'Блок питания' }).click();
  await expect(page.getByTestId('psu-mode')).toHaveText('CV');
  await expect(page.getByTestId('psu-vout')).toHaveText('5 В');
  await page.getByRole('button', { name: 'Выход: ВКЛ' }).click();
  await expect(page.getByText('Изменения вступают в силу после запуска теста')).toBeVisible();
  await run(page);
  await expect(page.getByTestId('psu-mode')).toHaveText('OFF');
  await page.getByRole('button', { name: 'Выход: ВЫКЛ' }).click();
  await run(page);
  await expect(page.getByTestId('psu-mode')).toHaveText('CV');

  // Осциллограф: заряд C1 через R1 (τ = 1 мс), запуск по фронту на 2,5 В
  await page.getByRole('tab', { name: 'Осциллограф' }).click();
  await page.getByRole('button', { name: 'Выбрать переходный процесс' }).click();
  await page.getByLabel('Время', { exact: true }).fill('6м');
  await page.getByLabel('Время', { exact: true }).press('Enter');
  await page.getByLabel('Шаг', { exact: true }).fill('2мк');
  await page.getByLabel('Шаг', { exact: true }).press('Enter');
  await page.getByLabel('Включение питания при t = 0').check();
  await pin(page, 'C1.1').click({ force: true });
  await expect(page.getByTestId('scope-ch1-pin')).toHaveText('C1, вывод 1');
  await page.getByLabel('Время на деление').selectOption({ label: '500 мкс/дел' });
  await page.getByLabel('CH1 смещение').fill('-2,5');
  await page.getByLabel('CH1 смещение').press('Enter');
  await page.getByLabel('Уровень', { exact: true }).fill('2,5');
  await page.getByLabel('Уровень', { exact: true }).press('Enter');
  await run(page);
  await expect(page.getByTestId('scope-status')).toContainText('Запуск: CH1, фронт');
  await expect(page.getByRole('img', { name: 'Осциллограмма' })).toBeVisible();
  await expect(page.getByTestId('scope-stats')).toContainText('CH1');
  await page.getByLabel(/Курсоры времени/).check();
  await expect(page.getByTestId('scope-cursors')).toContainText(/Δt\s*2 мс/);
  await expect(page.getByTestId('scope-cursors')).toContainText(/1\/Δt\s*500 Гц/);
  await shot(page, 'inst-scope');

  // Амперметр в разрыв: ток заряда, втекающий в R1.1, в среднем за вторую половину — почти 0 (конденсатор заряжен);
  // в рабочей точке — 0. Выбор режима A делает расчёт устаревшим (схема перестраивается).
  await page.getByRole('tab', { name: 'Мультиметр' }).click();
  await page.getByRole('radio', { name: 'A⎓' }).click();
  await expect(page.getByText('результаты устарели')).toBeVisible();
  await pin(page, 'R1.1').click({ force: true });
  await run(page);
  await expect(page.getByTestId('mm-reading')).toContainText('А');
  await expect(page.getByTestId('mm-method')).toContainText('последовательно');

  // ESR-метр: электролит из каталога, ESR 0,6 Ом на 100 кГц
  await page.getByRole('tab', { name: 'Схема' }).click();
  await place(page, 'электролит', 'Конденсатор электролитический', 560, 110);
  await page.getByRole('tab', { name: 'Тест' }).click();
  await page.getByRole('tab', { name: 'ESR-метр' }).click();
  await pin(page, 'C2.+').click({ force: true });
  await page.getByRole('radio', { name: 'Щуп «−»' }).click();
  await pin(page, 'C2.−').click({ force: true });
  await page.getByRole('button', { name: 'Измерить' }).click();
  await expect(page.getByTestId('esr-reading')).toHaveText('ESR 600 мОм');
  await shot(page, 'inst-esr');
});
