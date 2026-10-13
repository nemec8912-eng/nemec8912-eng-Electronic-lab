/**
 * Портативная сборка для текущей ОС (в CI на Windows проверяется настоящий ElectronLab.exe):
 * данные создаются в папке data рядом с программой; папку целиком можно перенести («флешка») и продолжить работу.
 * Запускается после `npm run package:linux`; без собранного пакета тест пропускается.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test } from 'playwright/test';
import { copyDir } from '../../scripts/copy-dir.mjs';
import { launch, reportAndCleanup, APP_DIR } from './launch';

const pkg = require(path.join(APP_DIR, 'package.json')) as { version: string };
const isWin = process.platform === 'win32';
const built = path.join(APP_DIR, 'release', `ElectronLab-${pkg.version}-${isWin ? 'win' : 'linux'}-x64-portable`);
const exeName = isWin ? 'ElectronLab.exe' : 'ElectronLab';

test.afterEach(async ({}, info) => { await reportAndCleanup(info.status !== info.expectedStatus, info.title); });

test.skip(!existsSync(built), `нет портативной сборки (npm run package:${isWin ? 'win' : 'linux'})`);

test('портативный режим: данные рядом с программой, перенос папки целиком', async () => {
  const flash = mkdtempSync(path.join(tmpdir(), 'e2e-portable-'));
  try {
    // Первый запуск — прямо из папки сборки («флешка»); затем папка целиком копируется на «другой ПК».
    const onFlash = built;
    rmSync(path.join(onFlash, 'data'), { recursive: true, force: true });
    const exe = path.join(onFlash, exeName);

    let l = await launch({ executable: exe });
    await expect(l.page.locator('.statusbar')).toContainText(`Портативный режим: ${path.join(onFlash, 'data')}`);
    // Примеры проектов входят в сборку
    await expect(l.page.getByRole('list', { name: 'Примеры' }).locator('li')).toHaveCount(6);
    await l.page.getByLabel('Название нового проекта').fill('С флешки');
    await l.page.getByRole('button', { name: 'Создать', exact: true }).click();
    await l.page.locator('svg.canvas').dblclick({ position: { x: 60, y: 200 } });
    await l.page.getByLabel('Текст заметки').fill('сделано на ПК 1');
    // Симулятор найден в составе портативной сборки (Windows) или в системе (Linux)
    await l.page.getByRole('tab', { name: 'Тест' }).click();
    await expect(l.page.getByRole('button', { name: 'Запустить тест' })).toBeEnabled();
    await expect(l.page.getByText('ngspice не найден')).toHaveCount(0);
    await l.page.getByRole('tab', { name: 'Схема' }).click();
    await l.page.keyboard.press('Control+s');
    await expect(l.page.locator('.indicator')).toHaveAttribute('data-state', 'saved');
    let exited = new Promise((r) => l.app.process().once('exit', r));
    await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await exited;
    expect(readdirSync(path.join(onFlash, 'data', 'projects')).length).toBe(1);

    // «Другой ПК»: папка скопирована в другое место, исходная удалена
    // Кириллица в пути намеренно: программа должна работать из папок вроде «D:\\Программы».
    const otherPc = path.join(flash, 'другой ПК', 'Электронная лаборатория');
    copyDir(onFlash, otherPc);
    rmSync(path.join(onFlash, 'data'), { recursive: true, force: true });
    l = await launch({ executable: path.join(otherPc, exeName) });
    await expect(l.page.locator('.statusbar')).toContainText(path.join(otherPc, 'data'));
    await l.page.getByRole('button', { name: /С флешки/ }).click();
    await expect(l.page.locator('g.note')).toContainText('сделано на ПК 1');
    exited = new Promise((r) => l.app.process().once('exit', r));
    await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await exited;
  } finally {
    rmSync(flash, { recursive: true, force: true });
  }
});
