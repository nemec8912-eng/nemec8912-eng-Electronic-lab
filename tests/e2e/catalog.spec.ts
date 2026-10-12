/**
 * Этап 2, проверки по ТЗ через интерфейс: значения и корпуса в карточке, редактор выводов микросхемы,
 * ключ первого вывода, два корпуса с соответствием «вывод ↔ площадка», проверка дубликатов и пиновки,
 * сохранение своей детали и перенос на другой ПК, характеристики на схеме, предупреждение «нет модели».
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { locateNgspice } from '../../src/sim/runner';
import { APP_DIR, launch, reportAndCleanup, stubOpenDialog, stubSaveDialog, type Launched } from './launch';

const ngspice = locateNgspice({ env: process.env.ELAB_NGSPICE, appRoot: APP_DIR });
const temps: string[] = [];
const temp = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(d); return d; };
const shots = process.env.ELAB_SCREENSHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });
test.afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

async function closeWindow(l: Launched) {
  const exited = new Promise<void>((r) => l.app.process().once('exit', () => r()));
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
}

const PINS: Array<[string, string, string]> = [
  ['GND', 'Земля', 'общий'], ['TRIG', 'Вход', 'запуск'], ['OUT', 'Выход', 'выход'], ['RESET', 'Вход', 'сброс'],
  ['CTRL', 'Вход', 'управление'], ['THR', 'Вход', 'порог'], ['DIS', 'Выход', 'разряд'], ['VCC', 'Питание', '+4,5…16 В'],
];

test('каталог: карточка, своя микросхема (DIP-8 + SOIC-8), проверки, схема, перенос на другой ПК', async () => {
  test.setTimeout(240_000);
  const dataPc1 = temp('e2e-cat-pc1-');
  let l = await launch({ dataDir: dataPc1 });
  let { page } = l;

  // --- Карточка встроенной детали: номиналы, корпуса, выводы, «нет модели» ---
  await page.getByRole('button', { name: 'Каталог деталей' }).click();
  await page.getByLabel('Поиск деталей').fill('NE555');
  await page.locator('.part-row', { hasText: 'Таймер NE555' }).click();
  const card = page.locator('.part-card');
  await expect(card.locator('.badge', { hasText: 'модель не проверена' })).toBeVisible();
  await expect(card.locator('.badge', { hasText: 'не сверено' })).toBeVisible();
  await expect(card).toContainText('NE555 (поведенческая)');
  await expect(card).toContainText('пороги 1/3 и 2/3 питания');
  await expect(card.getByLabel('Корпус', { exact: true })).toContainText('SOIC-8');
  await expect(card.locator('.pins-table tbody tr')).toHaveCount(8);
  await expect(card.locator('.pkg-pad.first[data-pad-number="1"] rect')).toHaveCount(1); // ключ: квадратная площадка 1
  await shot(page, 'catalog-card-ne555');
  // Поиск по номиналу
  await page.getByLabel('Поиск деталей').fill('470 В');
  await expect(page.locator('.part-row', { hasText: 'Варистор 470 В' })).toBeVisible();

  // --- Новая микросхема: выводы, типы, функции ---
  page.once('dialog', () => undefined);
  await page.getByRole('button', { name: 'Новая микросхема' }).click();
  await page.getByRole('dialog').locator('input').fill('8');
  await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click();
  const editor = page.locator('.part-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Сохранить в мой каталог' })).toBeDisabled(); // нет названия
  await editor.getByLabel('Название', { exact: true }).fill('Таймер ТСТ555');
  await editor.getByLabel('Категория').selectOption('ic-analog');
  await editor.getByLabel('Партномер').fill('TST555');
  await editor.getByRole('tab', { name: /Выводы/ }).click();
  for (const [i, [name, type, fn]] of PINS.entries()) {
    const n = String(i + 1);
    await editor.getByLabel(`Имя вывода ${n}`, { exact: true }).fill(name);
    await editor.getByLabel(`Тип вывода ${n}`, { exact: true }).selectOption({ label: type });
    await editor.getByLabel(`Функция вывода ${n}`, { exact: true }).fill(fn);
  }
  await expect(page.locator('.editor-preview svg .pin-label', { hasText: 'VCC' })).toHaveCount(1);

  // --- Корпуса: DIP-8 и SOIC-8, соответствие по номерам, ключ первого вывода ---
  await editor.getByRole('tab', { name: /Корпуса/ }).click();
  await editor.getByLabel('Семейство корпуса').selectOption('DIP');
  await editor.getByRole('button', { name: 'Добавить корпус' }).click();
  await editor.getByLabel('Семейство корпуса').selectOption('SOIC');
  await editor.getByRole('button', { name: 'Добавить корпус' }).click();
  const dip = editor.locator('.pkg-block').nth(0), soic = editor.locator('.pkg-block').nth(1);
  await expect(dip.getByLabel('Название корпуса')).toHaveValue(/DIP-8/);
  await expect(soic.getByLabel('Название корпуса')).toHaveValue('SOIC-8');
  await expect(dip.locator('.pkg-pad[data-pad-number]')).toHaveCount(8);
  await expect(dip.locator('.pkg-pad.first[data-pad-number="1"] rect')).toHaveCount(1);
  await expect(dip.getByLabel(/Ключ первого вывода/)).toHaveValue(/выемка/);
  await expect(soic.getByLabel('Площадка для вывода 8, SOIC-8')).toHaveValue('8');

  // Ошибка пиновки: вывод 2 на площадку 1 — вывод 1 остаётся без площадки, сохранить нельзя.
  await soic.getByLabel('Площадка для вывода 2, SOIC-8').selectOption('1');
  await expect(editor.locator('.editor-lint')).toContainText('SOIC-8: вывод 1 (GND) не назначен');
  await expect(editor.getByRole('button', { name: 'Сохранить в мой каталог' })).toBeDisabled();
  await shot(page, 'part-editor-pinmap-error');
  await soic.getByRole('button', { name: 'Сопоставить по номерам' }).click();
  await expect(editor.locator('.editor-lint')).not.toContainText('не назначен');

  await editor.getByRole('tab', { name: /Источник/ }).click();
  await editor.getByLabel('Откуда сведения').fill('Даташит TI SLFS022I');
  await editor.getByRole('tab', { name: /Модель/ }).click();
  await expect(editor).toContainText('Нет модели');
  await shot(page, 'part-editor');
  await editor.getByRole('button', { name: 'Сохранить в мой каталог' }).click();
  await expect(page.locator('.part-card .part-title')).toHaveText('Таймер ТСТ555');
  await expect(page.locator('.part-card .badge.mine')).toBeVisible();
  const saved = JSON.parse(readFileSync(path.join(dataPc1, 'library', 'catalog.json'), 'utf8'));
  expect(saved.parts.map((p: { partNumber: string }) => p.partNumber)).toEqual(['TST555']);
  expect(saved.packages).toHaveLength(2);

  // --- Проверка дубликатов ---
  await page.getByRole('button', { name: 'Новая деталь' }).click();
  await editor.getByLabel('Название', { exact: true }).fill('Ещё один');
  await editor.getByLabel('Партномер').fill('tst555');
  await expect(editor.locator('.editor-lint')).toContainText('уже есть в каталоге');
  await expect(editor.getByRole('button', { name: 'Сохранить в мой каталог' })).toBeDisabled();
  await editor.getByRole('button', { name: 'Отмена' }).click();

  // --- Схема: размещение из каталога, характеристики, предупреждение «нет модели» ---
  await page.getByRole('button', { name: '← Проекты' }).click();
  await page.getByLabel('Название нового проекта').fill('Таймер');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.getByLabel('Поиск детали для схемы').fill('TST555');
  await page.getByRole('button', { name: 'Таймер ТСТ555', exact: true }).click();
  await page.locator('svg.canvas').click({ position: { x: 300, y: 250 } });
  await expect(page.locator('[data-refdes="DA1"] .inst-label')).toContainText('TST555');
  await expect(page.getByTestId('no-model-warning')).toBeVisible();
  await page.getByLabel('Поиск детали для схемы').fill('47 мк');
  await page.getByRole('button', { name: 'Конденсатор электролитический', exact: true }).click();
  await page.locator('svg.canvas').click({ position: { x: 500, y: 250 } });
  await expect(page.locator('[data-refdes="C1"] .inst-label')).toContainText('47 мкФ');
  await expect(page.locator('[data-refdes="C1"] .inst-label')).toContainText('50 В');
  await shot(page, 'schematic-catalog');
  if (ngspice) {
    await page.getByRole('tab', { name: 'Тест' }).click();
    await page.getByRole('button', { name: 'Запустить тест' }).click();
    await expect(page.getByLabel('Проверка схемы')).toContainText('DA1: нет электрической модели');
    await page.getByRole('tab', { name: 'Схема' }).click();
  }
  await page.keyboard.press('Control+s');
  await expect(page.locator('.indicator')).toHaveAttribute('data-state', 'saved');
  const elab = path.join(temp('e2e-cat-flash-'), 'Таймер.elab');
  await stubSaveDialog(l.app, elab);
  await page.getByRole('button', { name: 'Экспорт проекта' }).click();
  await expect(page.locator('.toast').last()).toContainText('экспортирован');
  await closeWindow(l);

  // Каталог переживает перезапуск
  l = await launch({ dataDir: dataPc1 });
  page = l.page;
  await page.getByRole('button', { name: 'Каталог деталей' }).click();
  await page.getByRole('radio', { name: 'Мои' }).click();
  await expect(page.locator('.part-row')).toHaveCount(1);
  await closeWindow(l);

  // --- Второй ПК: проект открывается с деталью, деталь можно добавить в свой каталог ---
  l = await launch({ dataDir: temp('e2e-cat-pc2-') });
  page = l.page;
  await stubOpenDialog(l.app, elab);
  await page.getByRole('button', { name: 'Импорт проекта' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Открыть' }).click();
  const da1 = page.locator('[data-refdes="DA1"]');
  await expect(da1.locator('.inst-label')).toContainText('TST555');
  await da1.locator('.inst-hit').click({ force: true });
  await expect(page.getByTestId('no-model-warning')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить в мой каталог' }).click();
  await expect(page.getByRole('dialog')).toContainText('в мой каталог?');
  await page.getByRole('dialog').getByRole('button', { name: 'Добавить' }).click();
  await expect(page.locator('.toast').last()).toContainText('добавлена в мой каталог');
  await page.getByRole('tab', { name: 'Каталог' }).click();
  await page.getByRole('radio', { name: 'Мои' }).click();
  await page.locator('.part-row', { hasText: 'Таймер ТСТ555' }).click();
  await expect(page.locator('.part-card .pins-table tbody tr')).toHaveCount(8);
  await expect(page.locator('.part-card')).toContainText('VCC');
  await page.getByRole('button', { name: 'Поставить на схему' }).click();
  await expect(page.getByRole('tab', { name: 'Схема' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.catalog-item[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Таймер ТСТ555');
  await page.locator('svg.canvas').click({ position: { x: 300, y: 400 } });
  await expect(page.locator('[data-refdes="DA2"]')).toHaveCount(1);
});

test('импорт из KiCad: официальная библиотека (тестовые файлы вместо gitlab.com) и файлы с компьютера', async () => {
  test.setTimeout(120_000);
  const FIX = path.join(APP_DIR, 'tests', 'fixtures', 'kicad');
  process.env.ELAB_KICAD_FIXTURE_DIR = FIX;
  let l: Launched;
  try { l = await launch({ dataDir: temp('e2e-kicad-') }); } finally { delete process.env.ELAB_KICAD_FIXTURE_DIR; }
  const { page } = l;
  await page.getByRole('button', { name: 'Каталог деталей' }).click();
  await page.getByRole('button', { name: 'Импорт из KiCad…' }).click();
  const imp = page.locator('.kicad-import');

  // Неизвестная библиотека — понятная ошибка
  await imp.getByLabel('Библиотека KiCad').fill('NoSuchLib');
  await imp.getByRole('button', { name: 'Загрузить из интернета' }).click();
  await expect(imp.getByRole('alert')).toContainText('не найдена');

  await imp.getByLabel('Библиотека KiCad').fill('Timer');
  await imp.getByRole('button', { name: 'Загрузить из интернета' }).click();
  await imp.getByRole('button', { name: 'NE555P', exact: true }).click();
  await expect(imp.getByLabel('Посадочные места KiCad')).toHaveValue('Package_DIP:DIP-8_W7.62mm');
  await imp.getByLabel('Посадочные места KiCad').fill('Package_DIP:DIP-8_W7.62mm, Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
  await imp.getByRole('button', { name: 'Показать деталь' }).click();
  const prev = imp.getByLabel('Предпросмотр импорта');
  await expect(prev).toContainText('CC-BY-SA 4.0');
  await expect(prev).toContainText('gitlab.com/kicad/libraries/kicad-symbols');
  await expect(prev.locator('.package-preview')).toHaveCount(2);
  await expect(prev.locator('.pins-table tbody tr')).toHaveCount(8);
  await expect(prev.locator('.pins-table tbody tr').nth(7)).toContainText('VCC');
  await shot(page, 'kicad-import-preview');
  await imp.getByRole('button', { name: 'Проверить и сохранить…' }).click();
  const editor = page.locator('.part-editor');
  await expect(editor.locator('.editor-lint')).not.toContainText('Ошибка');
  await editor.getByRole('button', { name: 'Сохранить в мой каталог' }).click();
  const card = page.locator('.part-card');
  await expect(card.locator('.part-title')).toHaveText('NE555P');
  await expect(card).toContainText('CC-BY-SA 4.0');
  await expect(card.locator('.badge', { hasText: 'не сверено' })).toBeVisible();

  // Библиотека-папка KiCad 9: сведения символа подгружаются при выборе, посадочное место подставляется
  await page.getByRole('button', { name: 'Импорт из KiCad…' }).click();
  await imp.getByLabel('Библиотека KiCad').fill('Timer9');
  await imp.getByRole('button', { name: 'Загрузить из интернета' }).click();
  await imp.getByRole('button', { name: 'NE555D', exact: true }).click();
  await expect(imp.getByLabel('Посадочные места KiCad')).toHaveValue('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
  await imp.getByRole('button', { name: 'Показать деталь' }).click();
  await expect(prev.locator('.package-preview')).toHaveCount(1);
  await expect(prev).toContainText('Timer9.kicad_symdir/NE555D.kicad_sym');
  await imp.getByRole('button', { name: 'Отмена' }).click();

  // Файлы с компьютера: символ BC547 (1=C, 2=B, 3=E) и посадочное место TO-92
  await page.getByRole('button', { name: 'Импорт из KiCad…' }).click();
  await stubOpenDialog(l.app, path.join(FIX, 'symbols', 'Transistor_BJT.kicad_sym'));
  await imp.getByRole('button', { name: 'Файл с компьютера…' }).click();
  await imp.getByRole('button', { name: 'BC547', exact: true }).click();
  await imp.getByLabel('Посадочные места KiCad').fill('');
  await stubOpenDialog(l.app, path.join(FIX, 'footprints', 'Package_TO_SOT_THT.pretty', 'TO-92_Inline.kicad_mod'));
  await imp.getByRole('button', { name: '…и файлы .kicad_mod с компьютера' }).click();
  await expect(prev).toContainText('не известна');
  await expect(prev.locator('.pins-table tbody tr').nth(1)).toContainText('B');
  await expect(prev.locator('.symbol-preview')).toHaveCount(1);
  await imp.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.locator('.catalog-head h2')).toHaveText('Каталог деталей');
});
