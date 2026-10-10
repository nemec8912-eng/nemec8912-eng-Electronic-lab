/**
 * Сквозные сценарии этапа 1 в настоящем окне Electron:
 * жизненный цикл проекта, Undo/Redo, автосохранение и восстановление после аварии,
 * закрытие с несохранёнными изменениями, контрольные версии, экспорт/импорт, полный бэкап,
 * отказ на повреждённых файлах.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { killHard, launch, stubMessageBox, stubOpenDialog, stubSaveDialog, type Launched } from './launch';

const temps: string[] = [];
function temp(prefix: string) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const dialog = (page: Page) => page.getByRole('dialog');

async function createProject(page: Page, name: string) {
  await page.getByLabel('Название нового проекта').fill(name);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.locator('.project-title')).toHaveText(name);
}

/** Точка на полотне с учётом его фактического размера (на маленьком экране полотно узкое). */
async function canvasPoint(page: Page, x: number, y: number) {
  const box = (await page.locator('svg.canvas').boundingBox())!;
  return { x: Math.max(20, Math.min(x, box.width - 120)), y: Math.max(60, Math.min(y, box.height - 60)) };
}

async function clickEmpty(page: Page) {
  await page.locator('svg.canvas').click({ position: await canvasPoint(page, 40, 10_000) });
}

async function addNote(page: Page, x: number, y: number, text?: string) {
  await page.locator('svg.canvas').dblclick({ position: await canvasPoint(page, x, y) });
  if (text !== undefined) {
    await page.getByLabel('Текст заметки').fill(text);
  }
}

async function saveIndicator(page: Page) {
  return page.locator('.indicator');
}

/** Закрыть окно так, как это делает пользователь (крестик), дождаться выхода. */
async function closeWindow(l: Launched) {
  const exited = new Promise<void>((r) => l.app.process().once('exit', () => r()));
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
}

test('проект: создать, заметки, Undo/Redo, сохранить, закрыть, открыть, переименовать, дублировать, удалить', async () => {
  const dataDir = temp('e2e-life-');
  let l = await launch({ dataDir });
  const { page } = l;
  await createProject(page, 'Блок питания');
  await addNote(page, 300, 200, 'C1 47 мкФ 50 В');
  await addNote(page, 500, 300, 'R1 10 кОм');
  await expect(page.locator('g.note')).toHaveCount(2);
  await expect(await saveIndicator(page)).toHaveAttribute('data-state', /unsaved|autosaved/);

  // Undo/Redo: текст второй заметки (один шаг), сама вторая заметка
  await clickEmpty(page);
  await page.keyboard.press('Control+z');
  await expect(page.locator('g.note').nth(1)).toContainText('Заметка');
  await page.keyboard.press('Control+z');
  await expect(page.locator('g.note')).toHaveCount(1);
  await page.keyboard.press('Control+y');
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('g.note').nth(1)).toContainText('R1 10 кОм');

  await page.keyboard.press('Control+s');
  await expect(await saveIndicator(page)).toHaveAttribute('data-state', 'saved');
  await closeWindow(l);

  l = await launch({ dataDir });
  await l.page.getByRole('button', { name: /Блок питания/ }).click();
  await expect(l.page.locator('g.note')).toHaveCount(2);
  await expect(l.page.locator('g.note').first()).toContainText('C1 47 мкФ 50 В');
  await l.page.getByRole('button', { name: '← Проекты' }).click();

  const row = l.page.locator('.projects li').first();
  await row.getByRole('button', { name: 'Переименовать' }).click();
  await dialog(l.page).getByRole('textbox').fill('Блок питания 12 В');
  await dialog(l.page).getByRole('button', { name: 'Переименовать' }).click();
  await expect(l.page.locator('.project-name').first()).toHaveText('Блок питания 12 В');

  await l.page.locator('.projects li').first().getByRole('button', { name: 'Дублировать' }).click();
  await dialog(l.page).getByRole('button', { name: 'Дублировать' }).click();
  await expect(l.page.locator('.projects li')).toHaveCount(2);

  await l.page.locator('.projects li', { hasText: '(копия)' }).getByRole('button', { name: 'Удалить' }).click();
  await dialog(l.page).getByRole('button', { name: 'Удалить' }).click();
  await expect(l.page.locator('.projects li')).toHaveCount(1);
  expect(readdirSync(path.join(dataDir, 'trash')).length).toBe(1);
  await closeWindow(l);
});

test('аварийное завершение после автосохранения → предложение восстановить → изменения на месте', async () => {
  const dataDir = temp('e2e-crash-');
  let l = await launch({ dataDir });
  await createProject(l.page, 'Авария');
  await l.page.keyboard.press('Control+s');
  await addNote(l.page, 300, 200, 'не успел сохранить');
  await expect(await saveIndicator(l.page)).toHaveAttribute('data-state', 'autosaved', { timeout: 10_000 });
  await killHard(l.app);

  l = await launch({ dataDir });
  await expect(l.page.locator('.toast.error')).toContainText('аварийно');
  await expect(l.page.locator('.badge.warn')).toHaveText('Есть несохранённые изменения');
  await l.page.getByRole('button', { name: /Авария/ }).click();
  await expect(dialog(l.page)).toContainText('Найдены несохранённые изменения');
  await dialog(l.page).getByRole('button', { name: 'Восстановить' }).click();
  await expect(l.page.locator('g.note')).toContainText('не успел сохранить');
  await expect(await saveIndicator(l.page)).not.toHaveAttribute('data-state', 'saved');
  await l.page.keyboard.press('Control+s');
  await expect(await saveIndicator(l.page)).toHaveAttribute('data-state', 'saved');
  await closeWindow(l);
});

test('закрытие окна с несохранёнными изменениями: «Сохранить» и «Не сохранять»', async () => {
  const dataDir = temp('e2e-close-');
  let l = await launch({ dataDir });
  await createProject(l.page, 'Закрытие');
  await addNote(l.page, 300, 200, 'сохранится');
  await stubMessageBox(l.app, 0); // «Сохранить»
  await closeWindow(l);

  l = await launch({ dataDir });
  await expect(l.page.locator('.badge.warn')).toHaveCount(0);
  await l.page.getByRole('button', { name: /Закрытие/ }).click();
  await expect(l.page.locator('g.note')).toContainText('сохранится');
  await addNote(l.page, 500, 300, 'будет отброшено');
  await stubMessageBox(l.app, 1); // «Не сохранять»
  await closeWindow(l);

  l = await launch({ dataDir });
  await expect(l.page.locator('.badge.warn')).toHaveCount(0);
  await l.page.getByRole('button', { name: /Закрытие/ }).click();
  await expect(l.page.locator('g.note')).toHaveCount(1);
  await closeWindow(l);
});

test('контрольные версии: создать, изменить, вернуть, отменить возврат', async () => {
  const l = await launch({ dataDir: temp('e2e-cp-') });
  const { page } = l;
  await createProject(page, 'Версии');
  await addNote(page, 300, 200, 'исходная схема');
  await clickEmpty(page);
  await page.getByRole('button', { name: 'Создать контрольную версию' }).click();
  await dialog(page).getByRole('textbox').fill('до замены транзистора');
  await dialog(page).getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByLabel('Контрольные версии')).toContainText('до замены транзистора');

  await addNote(page, 500, 300, 'после замены');
  await clickEmpty(page);
  await expect(page.locator('g.note')).toHaveCount(2);
  await page.getByLabel('Контрольные версии').locator('li', { hasText: 'до замены транзистора' }).getByRole('button', { name: 'Вернуть' }).click();
  await dialog(page).getByRole('button', { name: 'Вернуть' }).click();
  await expect(page.locator('g.note')).toHaveCount(1);
  await expect(page.getByLabel('Контрольные версии')).toContainText('Перед возвратом');
  await page.keyboard.press('Control+z');
  await expect(page.locator('g.note')).toHaveCount(2);
  await page.keyboard.press('Control+s');
  await expect(await saveIndicator(page)).toHaveAttribute('data-state', 'saved');
  await closeWindow(l);
});

test('перенос: экспорт и полный бэкап на «флешку» с ПК 1 → импорт и восстановление на чистых ПК 2 и ПК 3', async () => {
  const flash = temp('e2e-flash-');
  const pc1 = temp('e2e-pc1-'), pc2 = temp('e2e-pc2-'), pc3 = temp('e2e-pc3-');

  // ПК 1
  let l = await launch({ dataDir: pc1 });
  await createProject(l.page, 'Усилитель');
  await addNote(l.page, 300, 200, 'Q1 КТ315');
  await l.page.keyboard.press('Control+s');
  await l.page.getByRole('button', { name: '← Проекты' }).click();
  await createProject(l.page, 'Зарядное');
  await addNote(l.page, 300, 200, 'несохранённая правка');
  const elab = path.join(flash, 'Зарядное.elab');
  await stubSaveDialog(l.app, elab);
  await l.page.getByRole('button', { name: 'Экспорт проекта' }).click();
  await expect(l.page.locator('.toast').last()).toContainText('Проект экспортирован');
  const bak = path.join(flash, 'всё.elabbak');
  await stubSaveDialog(l.app, bak);
  await l.page.getByRole('button', { name: 'Резервная копия всего' }).click();
  await expect(l.page.locator('.toast').last()).toContainText('проектов: 2');
  await stubMessageBox(l.app, 0);
  await closeWindow(l);

  // ПК 2: импорт одного проекта
  l = await launch({ dataDir: pc2 });
  await expect(l.page.locator('.projects li')).toHaveCount(0);
  await stubOpenDialog(l.app, elab);
  await l.page.getByRole('button', { name: 'Импорт проекта' }).click();
  await expect(dialog(l.page)).toContainText('Проект импортирован');
  await dialog(l.page).getByRole('button', { name: 'Открыть' }).click();
  await expect(l.page.locator('g.note')).toContainText('несохранённая правка');
  await addNote(l.page, 500, 300, 'продолжение на ПК 2');
  await l.page.keyboard.press('Control+s');
  await expect(l.page.locator('g.note')).toHaveCount(2);
  // повторный импорт того же файла → конфликт → как копию
  await stubOpenDialog(l.app, elab);
  await l.page.getByRole('button', { name: 'Импорт проекта' }).click();
  await expect(dialog(l.page)).toContainText('Такой проект уже есть');
  await dialog(l.page).getByRole('button', { name: 'Как копию' }).click();
  await dialog(l.page).getByRole('button', { name: 'Позже' }).click();
  await l.page.getByRole('button', { name: '← Проекты' }).click();
  await expect(l.page.locator('.projects li')).toHaveCount(2);
  await closeWindow(l);

  // ПК 3: восстановление полного бэкапа
  l = await launch({ dataDir: pc3 });
  await stubOpenDialog(l.app, bak);
  await stubMessageBox(l.app, 0); // «Восстановить»
  await l.page.getByRole('button', { name: 'Восстановить резервную копию' }).click();
  await expect(dialog(l.page)).toContainText('Восстановлено проектов: 2');
  await dialog(l.page).getByRole('button', { name: 'OK' }).click();
  await expect(l.page.locator('.projects li')).toHaveCount(2);
  await expect(l.page.locator('.projects li', { hasText: 'Зарядное' }).locator('.badge.warn')).toHaveCount(1);
  await l.page.getByRole('button', { name: /Усилитель/ }).click();
  await expect(l.page.locator('g.note')).toContainText('Q1 КТ315');
  await addNote(l.page, 500, 300, 'правка на ПК 3');
  await l.page.keyboard.press('Control+s');
  await expect(await saveIndicator(l.page)).toHaveAttribute('data-state', 'saved');
  await closeWindow(l);
});

test('повреждённый файл и файл бэкапа вместо проекта — понятная ошибка, данные не меняются', async () => {
  const dir = temp('e2e-bad-');
  const l = await launch({ dataDir: path.join(dir, 'data') });
  const bad = path.join(dir, 'битый.elab');
  writeFileSync(bad, Buffer.from('PK\u0003\u0004 обрывок архива'));
  await stubOpenDialog(l.app, bad);
  await l.page.getByRole('button', { name: 'Импорт проекта' }).click();
  await expect(dialog(l.page)).toContainText('Импорт не выполнен');
  await expect(dialog(l.page)).toContainText('повреждён');
  await dialog(l.page).getByRole('button', { name: 'OK' }).click();

  await createProject(l.page, 'Есть');
  await l.page.getByRole('button', { name: '← Проекты' }).click();
  const bak = path.join(dir, 'копия.elabbak');
  await stubSaveDialog(l.app, bak);
  await l.page.getByRole('button', { name: 'Резервная копия всего' }).click();
  await expect(l.page.locator('.toast').last()).toContainText('Резервная копия сохранена');
  await stubOpenDialog(l.app, bak);
  await l.page.getByRole('button', { name: 'Импорт проекта' }).click();
  await expect(dialog(l.page)).toContainText('Восстановить резервную копию');
  await dialog(l.page).getByRole('button', { name: 'OK' }).click();
  await expect(l.page.locator('.projects li')).toHaveCount(1);
  await closeWindow(l);
});
