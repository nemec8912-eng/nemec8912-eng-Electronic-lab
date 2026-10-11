/**
 * Сквозной вертикальный прототип (раздел 10 ТЗ), всё через интерфейс:
 * схема R + R + источник → сохранение → netlist → расчёт ngspice → показание щупов →
 * простая односторонняя плата → печать 1:1 → переносимый файл .elab → другой ПК → тот же расчёт.
 * Требует ngspice (в CI — обязательно; локально без ngspice тест пропускается).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { locateNgspice } from '../../src/sim/runner';
import { APP_DIR, launch, reportAndCleanup, stubMessageBox, stubOpenDialog, stubSaveDialog, type Launched } from './launch';

const ngspice = locateNgspice({ env: process.env.ELAB_NGSPICE, appRoot: APP_DIR });
test.skip(!ngspice && process.env.ELAB_REQUIRE_NGSPICE !== '1', 'ngspice не найден');

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const pin = (page: Page, label: string) => page.locator(`[data-pin-label="${label}"] .pin-hit`);
const pad = (page: Page, label: string) => page.locator(`[data-pad-label="${label}"]`).first();

async function closeWindow(l: Launched) {
  const exited = new Promise<void>((r) => l.app.process().once('exit', () => r()));
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
}

/** Переместить корпус на плате в точку (мм): перетаскивание за контур на нужное смещение. */
async function dragPlacement(page: Page, refDes: string, target: { x: number; y: number }) {
  const g = page.locator(`[data-placement-id][data-refdes="${refDes}"]`);
  const x0 = Number(await g.getAttribute('data-x')), y0 = Number(await g.getAttribute('data-y'));
  const box = (await g.locator('.pl-body').boundingBox())!;
  const scale = 9; // пикселей на мм — начальный масштаб вкладки «Плата»
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (target.x - x0) * scale / 2, sy + (target.y - y0) * scale / 2, { steps: 4 });
  await page.mouse.move(sx + (target.x - x0) * scale, sy + (target.y - y0) * scale, { steps: 4 });
  await page.mouse.up();
  await expect(g).toHaveAttribute('data-x', String(target.x));
  await expect(g).toHaveAttribute('data-y', String(target.y));
}

test('прототип: схема → ngspice → щупы → плата → печать 1:1 → .elab → другой ПК', async () => {
  const flash = temp('e2e-proto-flash-');
  let l = await launch({ dataDir: temp('e2e-proto-pc1-') });
  const { page } = l;
  await page.getByLabel('Название нового проекта').fill('Делитель');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  // --- Схема ---
  const canvas = page.locator('svg.canvas');
  const place = async (name: string, x: number, y: number) => {
    await page.getByRole('button', { name, exact: true }).click();
    await canvas.click({ position: { x, y } });
  };
  // Координаты в пределах 340 пикселей по высоте: на маленьком экране Windows-раннера полотно низкое.
  await place('Источник постоянного напряжения', 120, 200);
  await place('Резистор', 300, 110);
  await place('Резистор', 300, 250);
  await place('Земля (общий провод)', 120, 330);
  for (const [a, b] of [['V1.+', 'R1.1'], ['R1.2', 'R2.1'], ['R2.2', 'GND1.GND'], ['V1.−', 'GND1.GND']] as const) {
    await pin(page, a).click({ force: true });
    await pin(page, b).click({ force: true });
  }
  await expect(page.locator('g.wire')).toHaveCount(4);
  await expect(page.locator('[data-refdes="R1"] .inst-label')).toContainText('10 кОм');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.indicator')).toHaveAttribute('data-state', 'saved');

  // --- Тест: расчёт и щупы ---
  await page.getByRole('tab', { name: 'Тест' }).click();
  await expect(page.getByTestId('mm-reading')).toHaveText('нет расчёта');
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByTestId('sim-status')).toContainText('ngspice');
  await pin(page, 'R1.2').click({ force: true });
  await page.getByRole('radio', { name: 'Чёрный (COM)' }).click();
  await pin(page, 'GND1.GND').click({ force: true });
  await expect(page.getByTestId('mm-reading')).toHaveText('2,5 В');
  await expect(page.locator('svg.trace')).toBeVisible();
  // Перестановка щупов меняет знак, но не «устаревает» расчёт
  await page.getByRole('radio', { name: 'Красный (+)' }).click();
  await pin(page, 'GND1.GND').click({ force: true });
  await page.getByRole('radio', { name: 'Чёрный (COM)' }).click();
  await pin(page, 'R1.2').click({ force: true });
  await expect(page.getByTestId('mm-reading')).toHaveText('-2,5 В');
  await page.getByRole('radio', { name: 'Красный (+)' }).click();
  await pin(page, 'R1.2').click({ force: true });
  await page.getByRole('radio', { name: 'Чёрный (COM)' }).click();
  await pin(page, 'GND1.GND').click({ force: true });

  // Номинал изменился → старое показание не выводится, после перезапуска — новое
  await page.getByRole('tab', { name: 'Схема' }).click();
  await page.locator('[data-refdes="R2"] .inst-hit').click({ force: true });
  await page.getByLabel('Сопротивление').fill('4,7к');
  await page.getByLabel('Сопротивление').press('Enter');
  await expect(page.locator('[data-refdes="R2"] .inst-label')).toContainText('4,7 кОм');
  await page.getByRole('tab', { name: 'Тест' }).click();
  await expect(page.getByTestId('mm-reading')).toHaveText('нет расчёта');
  await expect(page.getByText('результаты устарели')).toBeVisible();
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByTestId('mm-reading')).toHaveText('1,599 В'); // 5 В × 4,7 / 14,7

  // Без земли расчёт не отправляется в ngspice, причина названа
  await page.getByRole('tab', { name: 'Схема' }).click();
  await page.locator('[data-refdes="GND1"] .inst-hit').click({ force: true });
  await page.keyboard.press('Delete');
  await page.getByRole('tab', { name: 'Тест' }).click();
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByTestId('sim-status')).toContainText('в схеме есть ошибки');
  await expect(page.getByLabel('Проверка схемы')).toContainText(/земл/i);
  await expect(page.getByTestId('mm-reading')).not.toContainText('В');
  await page.keyboard.press('Control+z');
  await page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(page.getByTestId('mm-reading')).toHaveText('1,599 В');

  // --- Плата ---
  await page.getByRole('tab', { name: 'Плата' }).click();
  await page.getByRole('button', { name: 'Синхронизировать со схемой' }).click();
  await expect(page.getByTestId('sync-report')).toContainText('Добавлено: V1, R1, R2');
  await expect(page.getByTestId('drc')).toContainText('Не разведено соединений: 3');
  // Расстановка без пересечений: R1 повёрнут на 90°, R2 — на 270°
  await page.locator('[data-refdes="R1"] .pl-body').click();
  await page.getByRole('button', { name: 'Повернуть деталь (R)' }).click();
  await page.locator('[data-refdes="R2"] .pl-body').click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Повернуть деталь (R)' }).click();
  await dragPlacement(page, 'R2', { x: 11.43, y: 25.4 });
  await dragPlacement(page, 'R1', { x: 6.35, y: 15.24 });
  // Дорожка между разными цепями запрещена
  await pad(page, 'V1.1').click({ force: true });
  await pad(page, 'R2.2').click({ force: true });
  await expect(page.getByRole('alert')).toContainText('разные цепи');
  for (const [a, b] of [['V1.1', 'R1.1'], ['R1.2', 'R2.1'], ['R2.2', 'V1.2']] as const) {
    await pad(page, a).click({ force: true });
    await pad(page, b).click({ force: true });
  }
  await expect(page.locator('g.track')).toHaveCount(3);
  await expect(page.getByTestId('drc')).toHaveText(/Ошибок нет, всё разведено/);
  const svgPath = path.join(flash, 'плата.svg');
  await stubSaveDialog(l.app, svgPath);
  await page.getByRole('button', { name: 'SVG — вид со стороны деталей' }).click();
  await expect(page.locator('.toast').last()).toContainText('Сохранено');
  const svg = readFileSync(svgPath, 'utf8');
  expect(svg).toMatch(/width="[\d.]+mm"/);
  expect(svg).toContain('width="10" height="10"');
  expect((svg.match(/<polyline/g) ?? []).length).toBe(3);

  // --- Сохранение и перенос ---
  await page.keyboard.press('Control+s');
  await expect(page.locator('.indicator')).toHaveAttribute('data-state', 'saved');
  const elab = path.join(flash, 'Делитель.elab');
  await stubSaveDialog(l.app, elab);
  await page.getByRole('button', { name: 'Экспорт проекта' }).click();
  await expect(page.locator('.toast').last()).toContainText('Проект экспортирован');
  await closeWindow(l);
  expect(existsSync(elab)).toBe(true);

  l = await launch({ dataDir: temp('e2e-proto-pc2-') });
  await stubOpenDialog(l.app, elab);
  await l.page.getByRole('button', { name: 'Импорт проекта' }).click();
  await l.page.getByRole('dialog').getByRole('button', { name: 'Открыть' }).click();
  await expect(l.page.locator('g.wire')).toHaveCount(4);
  await l.page.getByRole('tab', { name: 'Тест' }).click();
  await expect(l.page.getByTestId('probe-red')).toHaveText('R1, вывод 2');
  await l.page.getByRole('button', { name: 'Запустить тест' }).click();
  await expect(l.page.getByTestId('mm-reading')).toHaveText('1,599 В');
  await l.page.getByRole('tab', { name: 'Плата' }).click();
  await expect(l.page.locator('g.track')).toHaveCount(3);
  await expect(l.page.getByTestId('drc')).toHaveText(/Ошибок нет/);
  await stubMessageBox(l.app, 1);
  await closeWindow(l);
});
