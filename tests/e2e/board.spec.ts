/**
 * Этап 6 через интерфейс: делитель → синхронизация с отчётом и «Применить» → размеры платы →
 * дорожки с изгибами → DRC без ошибок → изменение схемы → синхронизация (удалено/добавлено, Ctrl+Z) →
 * медь 1:1 SVG и PDF (масштаб) → Gerber (архив читается и сверяется) → двухсторонняя плата: переход V,
 * запрет вернуть одностороннюю, верхний слой печатается зеркально.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { expect, test, type Page } from 'playwright/test';
import { readExcellon, readGerber } from '../gerber-reader';
import { launch, reportAndCleanup, stubSaveDialog } from './launch';

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const pin = (page: Page, label: string) => page.locator(`[data-pin-label="${label}"] .pin-hit`).first();
const pad = (page: Page, label: string) => page.locator(`[data-pad-label="${label}"]`).first();

async function view(page: Page) {
  const svg = page.locator('svg.board-canvas');
  const box = (await svg.boundingBox())!;
  const [s, vx, vy] = await Promise.all(['data-scale', 'data-vx', 'data-vy'].map(async (a) => Number(await svg.getAttribute(a))));
  return { at: (x: number, y: number) => ({ x: box.x + (x - vx!) * s!, y: box.y + (y - vy!) * s! }), scale: s! };
}
/** Щелчок по точке платы (мм). */
async function boardClick(page: Page, x: number, y: number) {
  const v = await view(page);
  const p = v.at(x, y);
  await page.mouse.click(p.x, p.y);
}
async function dragPlacement(page: Page, refDes: string, target: { x: number; y: number }) {
  const g = page.locator(`[data-placement-id][data-refdes="${refDes}"]`);
  const x0 = Number(await g.getAttribute('data-x')), y0 = Number(await g.getAttribute('data-y'));
  const box = (await g.locator('.pl-body').boundingBox())!;
  const { scale } = await view(page);
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (target.x - x0) * scale / 2, sy + (target.y - y0) * scale / 2, { steps: 4 });
  await page.mouse.move(sx + (target.x - x0) * scale, sy + (target.y - y0) * scale, { steps: 4 });
  await page.mouse.up();
  await expect(g).toHaveAttribute('data-x', String(target.x));
  await expect(g).toHaveAttribute('data-y', String(target.y));
}
async function route(page: Page, from: string, bends: Array<[number, number]>, to: string) {
  await pad(page, from).click({ force: true });
  await expect(page.getByTestId('route-status')).toBeVisible();
  for (const [x, y] of bends) await boardClick(page, x, y);
  await pad(page, to).click({ force: true });
  await expect(page.getByTestId('route-status')).toHaveCount(0);
}

test('плата: синхронизация, разводка с изгибами, DRC, изменение схемы, вывод 1:1, Gerber, двухсторонняя', async () => {
  test.setTimeout(240_000);
  const out = temp('e2e-board-out-');
  const { app, page } = await launch({ dataDir: temp('e2e-board-') });
  await page.getByLabel('Название нового проекта').fill('Плата делителя');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const canvas = page.locator('svg.canvas');
  const place = async (name: string, x: number, y: number) => {
    await page.getByRole('button', { name, exact: true }).click();
    await canvas.click({ position: { x, y } });
  };
  await place('Источник постоянного напряжения', 120, 200);
  await place('Резистор', 300, 110);
  await place('Резистор', 300, 250);
  await place('Земля (общий провод)', 120, 330);
  for (const [a, b] of [['V1.+', 'R1.1'], ['R1.2', 'R2.1'], ['R2.2', 'GND1.GND'], ['V1.−', 'GND1.GND']] as const) {
    await pin(page, a).click({ force: true });
    await pin(page, b).click({ force: true });
  }
  await expect(page.locator('g.wire')).toHaveCount(4);

  // --- Синхронизация: сначала отчёт, потом «Применить» ---
  await page.getByRole('tab', { name: 'Плата' }).click();
  await expect(page.getByText('Плата ещё не создана')).toBeVisible();
  await page.getByRole('button', { name: 'Синхронизировать со схемой' }).click();
  await expect(page.getByTestId('sync-report')).toContainText('Добавлено: V1, R1, R2');
  await expect(page.locator('[data-placement-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.locator('[data-placement-id]')).toHaveCount(3);
  await page.getByLabel('Ширина платы').fill('50');
  await page.getByLabel('Ширина платы').press('Enter');
  await page.getByLabel('Высота платы').fill('40');
  await page.getByLabel('Высота платы').press('Enter');
  await page.getByRole('button', { name: 'Показать всё' }).click();
  await dragPlacement(page, 'V1', { x: 10.16, y: 20.32 });
  await dragPlacement(page, 'R1', { x: 25.4, y: 10.16 });
  await dragPlacement(page, 'R2', { x: 25.4, y: 30.48 });
  await expect(page.getByTestId('drc').locator('li', { hasText: 'Не разведено: цепь' })).toHaveCount(3);

  // --- Разводка: дорожка между разными цепями запрещена; дорожки с изгибами ---
  await pad(page, 'V1.1').click({ force: true });
  await pad(page, 'R2.2').click({ force: true });
  await expect(page.getByRole('alert')).toContainText('разные цепи');
  await route(page, 'V1.1', [[10.16, 10.16]], 'R1.1');
  await route(page, 'R1.2', [[35.56, 20.32], [25.4, 20.32]], 'R2.1');
  // Backspace убирает последний изгиб, Esc отменяет
  await pad(page, 'R2.2').click({ force: true });
  await boardClick(page, 40, 39);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await expect(page.locator('g.track')).toHaveCount(2);
  await route(page, 'R2.2', [[35.56, 36.83], [15.24, 36.83]], 'V1.2');
  await expect(page.locator('g.track')).toHaveCount(3);
  await expect(page.locator('g.track polyline').nth(1)).toHaveAttribute('points', /^35\.56,10\.16 35\.56,20\.32 25\.4,20\.32 25\.4,30\.48$/);
  await expect(page.getByTestId('drc-summary')).toHaveText('Ошибок: 0, предупреждений: 0');
  await expect(page.getByTestId('drc')).toHaveText(/Ошибок нет, всё разведено/);
  await shot(page, 'board-routed');

  // --- Вывод 1:1: SVG и PDF нижнего слоя (для ЛУТ — без зеркала) ---
  await expect(page.getByTestId('lut-hint')).toContainText('нижний слой печатается без зеркала');
  const svgPath = path.join(out, 'медь.svg');
  await stubSaveDialog(app, svgPath);
  await page.getByRole('button', { name: 'Медь: SVG' }).click();
  await expect(page.locator('.toast').last()).toContainText('Сохранено');
  const svg = readFileSync(svgPath, 'utf8');
  expect(svg).toContain('width="75mm" height="58mm"'); // 50 + 3×5 + 10; 40 + 2×5 + 8
  expect(svg).toContain('<rect x="0" y="0" width="50" height="40"');
  expect((svg.match(/data-track=/g) ?? []).length).toBe(3);
  expect(svg).not.toContain('scale(-1 1)');
  const pdfPath = path.join(out, 'медь.pdf');
  await stubSaveDialog(app, pdfPath);
  await page.getByRole('button', { name: 'Медь: PDF' }).click();
  await expect(page.locator('.toast').last()).toContainText('медь.pdf');
  const pdf = readFileSync(pdfPath).toString('latin1');
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf);
  expect(box, 'MediaBox').toBeTruthy();
  expect(Math.abs(Number(box![1]) - 75 * 72 / 25.4)).toBeLessThan(1.5); // 212,6 пункта
  expect(Math.abs(Number(box![2]) - 58 * 72 / 25.4)).toBeLessThan(1.5);

  // --- Gerber: архив читается независимым читателем ---
  const zipPath = path.join(out, 'gerber.zip');
  await stubSaveDialog(app, zipPath);
  await page.getByRole('button', { name: 'Gerber и сверловка (.zip)' }).click();
  await expect(page.locator('.toast').last()).toContainText('Gerber и сверловка: 6 файлов');
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  expect(Object.keys(zip.files).sort()).toEqual(['board-B_Cu.gbl', 'board-B_Mask.gbs', 'board-Edge_Cuts.gm1', 'board-F_SilkS.gto', 'board-PTH.drl', 'readme.txt']);
  const cu = readGerber(await zip.file('board-B_Cu.gbl')!.async('string'));
  expect(cu.flashes).toHaveLength(6);
  expect(cu.draws).toHaveLength(2 + 3 + 3);
  expect(readExcellon(await zip.file('board-PTH.drl')!.async('string')).hits).toHaveLength(6);

  // --- Изменение схемы: R2 удалён → отчёт и дорожки; Ctrl+Z возвращает ---
  await page.getByRole('tab', { name: 'Схема' }).click();
  await page.locator('[data-refdes="R2"] .inst-hit').click({ force: true });
  await page.keyboard.press('Delete');
  await page.getByRole('tab', { name: 'Плата' }).click();
  await expect(page.getByTestId('drc')).toContainText('удалённая из схемы');
  await page.getByRole('button', { name: 'Синхронизировать со схемой' }).click();
  await expect(page.getByTestId('sync-report')).toContainText('Удалено: деталь, удалённая из схемы');
  await expect(page.getByTestId('sync-report')).toContainText('дорожек: 2');
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.locator('[data-placement-id]')).toHaveCount(2);
  await expect(page.locator('g.track')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator('g.track')).toHaveCount(3);
  await page.getByRole('tab', { name: 'Схема' }).click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-refdes="R2"]')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Плата' }).click();
  await expect(page.getByTestId('drc-summary')).toHaveText('Ошибок: 0, предупреждений: 0');

  // --- Двухсторонняя: перенос GND на верхний слой через переход ---
  await page.getByRole('radio', { name: 'Двухсторонняя' }).click();
  await boardClick(page, 25, 36.83);
  await page.getByRole('button', { name: 'Удалить дорожку' }).click();
  await expect(page.locator('g.track')).toHaveCount(2);
  await page.getByRole('radio', { name: 'Верхний слой' }).first().click();
  await pad(page, 'R2.2').click({ force: true });
  await boardClick(page, 35.56, 36.83);
  await boardClick(page, 30.48, 36.83);
  await page.keyboard.press('v');
  await boardClick(page, 15.24, 36.83);
  await pad(page, 'V1.2').click({ force: true });
  await expect(page.locator('g.via')).toHaveCount(1);
  await expect(page.locator('g.track[data-layer="top"]')).toHaveCount(1);
  await expect(page.locator('g.track[data-layer="bottom"]')).toHaveCount(3);
  await expect(page.getByTestId('drc-summary')).toHaveText('Ошибок: 0, предупреждений: 0');
  await shot(page, 'board-two-layer');
  // Вернуть одностороннюю нельзя, пока есть верхний слой
  await page.getByRole('radio', { name: 'Односторонняя' }).click();
  await expect(page.getByRole('alert')).toContainText('Нельзя сделать плату односторонней');
  // Верхний слой для ЛУТ — зеркально
  await page.getByRole('radiogroup', { name: 'Слой для печати' }).getByRole('radio', { name: 'Верхний слой' }).click();
  await expect(page.getByLabel('Зеркально')).toBeChecked();
  const topPath = path.join(out, 'верх.svg');
  await stubSaveDialog(app, topPath);
  await page.getByRole('button', { name: 'Медь: SVG' }).click();
  await expect(page.locator('.toast').last()).toContainText('верх.svg');
  const top = readFileSync(topPath, 'utf8');
  expect(top).toContain('translate(50 0) scale(-1 1)');
  expect(top).toContain('Верхний слой · зеркально — для ЛУТ');
  expect((top.match(/data-via=/g) ?? []).length).toBe(1);
  await page.getByLabel('Зеркально').uncheck();
  await expect(page.getByTestId('lut-hint')).toContainText('не подходит для ЛУТ');
  await shot(page, 'board-output');
});
