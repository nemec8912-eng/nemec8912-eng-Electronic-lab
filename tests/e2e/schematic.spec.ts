/**
 * Этап 3, проверки ТЗ через интерфейс: цепи с разветвлениями и пересечениями, метки цепей, перемещение
 * детали без потери соединений, Undo/Redo, ERC с местом и объяснением, экспорт SVG/PDF/PNG и списка
 * соединений, перенумерация, сохранение и перенос на другой ПК с сохранением графа.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { launch, reportAndCleanup, stubOpenDialog, stubSaveDialog, type Launched } from './launch';

const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** Начальный вид полотна: мировая точка (0,0) — в пикселе (60,60), масштаб 1. */
const px = (x: number, y: number) => ({ x: x + 60, y: y + 60 });
const canvas = (page: Page) => page.locator('svg.canvas');
const pin = (page: Page, label: string) => page.locator(`[data-pin-label="${label}"] .pin-hit`);
const netOf = async (page: Page, label: string) => {
  // Цепь вывода — по проводу, который к нему подходит (провода знают свою цепь из графа).
  const id = await page.evaluate((l) => {
    const el = document.querySelector(`[data-pin-label="${l}"] .pin-hit`) as SVGCircleElement | null;
    if (!el) return null;
    const cx = Number(el.getAttribute('cx')), cy = Number(el.getAttribute('cy'));
    for (const w of Array.from(document.querySelectorAll('g.wire'))) {
      const pts = (w.querySelector('.wire-line')!.getAttribute('points') ?? '').split(' ');
      if (pts[0] === `${cx},${cy}` || pts[pts.length - 1] === `${cx},${cy}`) return w.getAttribute('data-net-id');
    }
    return null;
  }, label);
  return id;
};

async function place(page: Page, name: string, x: number, y: number) {
  await page.getByRole('button', { name, exact: true }).click();
  await canvas(page).click({ position: px(x, y) });
}

async function closeWindow(l: Launched) {
  const exited = new Promise<void>((r) => l.app.process().once('exit', () => r()));
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
}

test('редактор схем: ветвление, пересечение, метки, перемещение, Undo/Redo, ERC, экспорт, перенос', async () => {
  test.setTimeout(240_000);
  const flash = temp('e2e-sch-flash-');
  let l = await launch({ dataDir: temp('e2e-sch-pc1-') });
  let { page } = l;
  await page.getByLabel('Название нового проекта').fill('Узлы');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  // R1 (100,100) и R2 (300,100) по горизонтали; R3 под серединой; R5/R6 — для провода «наперерез».
  await place(page, 'Резистор', 100, 100);
  await place(page, 'Резистор', 300, 100);
  await place(page, 'Резистор', 230, 300);
  await place(page, 'Резистор', 220, 20);
  await place(page, 'Резистор', 220, 200);
  await expect(page.locator('g.inst')).toHaveCount(5);
  // Позиционные обозначения выданы автоматически и уникальны.
  for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) await expect(page.locator(`[data-refdes="${r}"]`)).toHaveCount(1);

  // Провод R1.2 → R2.1 (прямой по y = 100)
  await pin(page, 'R1.2').click({ force: true });
  await pin(page, 'R2.1').click({ force: true });
  await expect(page.locator('g.wire')).toHaveCount(1);

  // Ветвление: инструмент «Провод», щелчок по середине провода (200,100), затем по выводу R3.1 (200,300).
  await page.getByRole('button', { name: 'Провод', exact: true }).click();
  await canvas(page).click({ position: px(200, 100) });
  await pin(page, 'R3.1').click({ force: true });
  await expect(page.locator('.junction-dot')).toHaveCount(1);
  await expect(page.locator('g.wire')).toHaveCount(3);
  const main = await netOf(page, 'R1.2');
  expect(main).toBeTruthy();
  expect(await netOf(page, 'R2.1')).toBe(main);
  expect(await netOf(page, 'R3.1')).toBe(main);

  // Пересечение без узла: R4.2 (250,20) → R5.2 (250,200) пересекает провод R1–R2 в (250,100).
  await page.keyboard.press('Escape');
  await pin(page, 'R4.2').click({ force: true });
  await pin(page, 'R5.2').click({ force: true });
  await expect(page.locator('g.wire')).toHaveCount(4);
  await expect(page.locator('.junction-dot')).toHaveCount(1);
  const cross = await netOf(page, 'R4.2');
  expect(cross).toBeTruthy();
  expect(cross).not.toBe(main);

  // Метки: «OUT» на R2.2 и на R5.1 — одна цепь без провода между ними.
  for (const target of ['R2.2', 'R5.1']) {
    await page.getByRole('button', { name: 'Метка', exact: true }).click();
    await pin(page, target).click({ force: true });
    await page.getByRole('dialog').locator('input').fill('OUT');
    await page.getByRole('dialog').getByRole('button', { name: 'Поставить' }).click();
  }
  await expect(page.locator('[data-label-name="OUT"]')).toHaveCount(2);
  const out = await netOf(page, 'R2.2');
  expect(await netOf(page, 'R5.1')).toBe(out);
  expect(out).not.toBe(main);
  await shot(page, 'schematic-graph');

  // Перемещение детали: R2 вниз на 40 — провод следует за выводом, цепи те же.
  const r2 = page.locator('[data-refdes="R2"] .inst-hit');
  const box = (await r2.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 20, { steps: 3 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('[data-pin-label="R2.1"] .pin-hit')).toHaveAttribute('cy', '140');
  expect(await netOf(page, 'R2.1')).toBe(main);
  expect(await netOf(page, 'R2.2')).toBe(out);
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.locator('[data-pin-label="R2.1"] .pin-hit')).toHaveAttribute('cy', '100');
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('[data-pin-label="R2.1"] .pin-hit')).toHaveAttribute('cy', '140');
  expect(await netOf(page, 'R2.1')).toBe(main);

  // Удаление ответвления и отмена: узел исчезает и возвращается.
  const branch = page.locator(`g.wire[data-net-id="${main}"]`).filter({ has: page.locator('polyline[points$="200,300"]') });
  await expect(branch).toHaveCount(1);
  // Щелчок по ответвлению в точке (200,250) — вне других деталей.
  await canvas(page).click({ position: px(200, 250) });
  await expect(page.getByRole('heading', { name: 'Провод' })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('.junction-dot')).toHaveCount(0);
  await expect(page.locator('g.wire')).toHaveCount(4); // ответвление удалено, половины провода слились
  await page.keyboard.press('Control+z');
  await expect(page.locator('.junction-dot')).toHaveCount(1);
  await expect(page.locator('g.wire')).toHaveCount(6);

  // ERC: нет земли — ошибка с объяснением; неподключённые выводы — предупреждения; щелчок показывает место.
  await page.getByRole('button', { name: 'Проверка (ERC)' }).click();
  const erc = page.getByLabel('Проверка схемы (ERC)');
  await expect(erc.locator('li[data-erc-code="no-ground"]')).toHaveCount(1);
  await expect(erc.locator('li.error').first()).toBeVisible();
  await expect(erc.locator('li[data-erc-code="unconnected-pin"]').first()).toBeVisible();
  await erc.locator('li[data-erc-code="no-ground"] button').click();
  await expect(erc.locator('.erc-help')).toContainText('опорного узла');
  await expect(erc).toContainText('не гарантирует');
  await erc.locator('li[data-erc-code="unconnected-pin"] button').first().click();
  await expect(page.locator('.erc-marker').first()).toBeVisible();
  await shot(page, 'schematic-erc');
  await page.getByRole('button', { name: 'Закрыть проверку' }).click();

  // Список соединений: файл с цепями и выводами
  const txt = path.join(flash, 'соединения.txt');
  await stubSaveDialog(l.app, txt);
  await page.getByRole('button', { name: 'Список соединений' }).click();
  await expect(page.locator('.toast').last()).toContainText('Список соединений сохранён');
  const list = readFileSync(txt, 'utf8');
  expect(list).toMatch(/R1\.2, R2\.1, R3\.1/);
  expect(list).toMatch(/OUT: R2\.2, R5\.1/);

  // Экспорт: SVG A4 в мм, PDF A4, PNG 100 точек/дюйм
  await page.getByRole('button', { name: 'Экспорт / печать…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Экспорт и печать схемы' });
  await expect(dlg.getByTestId('export-info')).toContainText('297×210 мм');
  await page.getByLabel('Разработал').fill('Тестов');
  await shot(page, 'schematic-export');
  const svgPath = path.join(flash, 'схема.svg');
  await dlg.getByLabel('Формат файла').selectOption('svg');
  await stubSaveDialog(l.app, svgPath);
  await dlg.getByRole('button', { name: 'Сохранить…' }).click();
  await expect(page.locator('.toast').last()).toContainText('Схема сохранена');
  const svg = readFileSync(svgPath, 'utf8');
  expect(svg).toMatch(/^<\?xml/);
  expect(svg).toMatch(/width="297mm" height="210mm"/);
  expect(svg).toContain('Тестов');
  expect(svg).toContain('>R3<');
  const pdfPath = path.join(flash, 'схема.pdf');
  await dlg.getByLabel('Формат файла').selectOption('pdf');
  await stubSaveDialog(l.app, pdfPath);
  await dlg.getByRole('button', { name: 'Сохранить…' }).click();
  await expect(page.locator('.toast').last()).toContainText('PDF сохранён');
  const pdf = readFileSync(pdfPath);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const box1 = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  expect(box1, 'MediaBox в PDF').toBeTruthy();
  // A4 альбомный: 297 × 210 мм = 841,9 × 595,3 пункта (допуск 1 пункт)
  expect(Math.abs(Number(box1![1]) - 841.89)).toBeLessThan(1.5);
  expect(Math.abs(Number(box1![2]) - 595.28)).toBeLessThan(1.5);
  const pngPath = path.join(flash, 'схема.png');
  await dlg.getByLabel('Формат файла').selectOption('png');
  await dlg.getByLabel('Разрешение').selectOption('100');
  await stubSaveDialog(l.app, pngPath);
  await dlg.getByRole('button', { name: 'Сохранить…' }).click();
  await expect(page.locator('.toast').last()).toContainText('PNG сохранён');
  const png = readFileSync(pngPath);
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(Math.round(297 / 25.4 * 100));
  expect(png.readUInt32BE(20)).toBe(Math.round(210 / 25.4 * 100));
  const phys = png.indexOf(Buffer.from('pHYs'));
  expect(phys).toBeGreaterThan(0);
  expect(png.readUInt32BE(phys + 4)).toBe(Math.round(100 / 0.0254));
  await dlg.getByRole('button', { name: 'Закрыть' }).click();

  // Сохранение и перенос
  await page.keyboard.press('Control+s');
  await expect(page.locator('.indicator')).toHaveAttribute('data-state', 'saved');
  const elab = path.join(flash, 'Узлы.elab');
  await stubSaveDialog(l.app, elab);
  await page.getByRole('button', { name: 'Экспорт проекта' }).click();
  await expect(page.locator('.toast').last()).toContainText('экспортирован');
  await closeWindow(l);

  l = await launch({ dataDir: temp('e2e-sch-pc2-') });
  page = l.page;
  await stubOpenDialog(l.app, elab);
  await page.getByRole('button', { name: 'Импорт проекта' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('g.inst')).toHaveCount(5);
  await expect(page.locator('g.wire')).toHaveCount(6);
  await expect(page.locator('.junction-dot')).toHaveCount(1);
  await expect(page.locator('[data-label-name="OUT"]')).toHaveCount(2);
  const txt2 = path.join(flash, 'соединения-2.txt');
  await stubSaveDialog(l.app, txt2);
  await page.getByRole('button', { name: 'Список соединений' }).click();
  await expect(page.locator('.toast').last()).toContainText('Список соединений сохранён');
  const strip = (s: string) => s.split('\n').filter((x) => !/^Ревизия/.test(x)).join('\n');
  expect(strip(readFileSync(txt2, 'utf8'))).toBe(strip(list));

  // Перенумерация по положению; выделение рамкой и группа
  await page.getByRole('button', { name: 'Перенумеровать' }).click();
  await expect(page.locator('.toast').last()).toContainText(/Перенумеровано|по порядку/);
});
