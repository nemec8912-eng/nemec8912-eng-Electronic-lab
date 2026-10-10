/** Запуск собранного приложения в Electron для e2e-тестов, с отдельной папкой данных. */
import * as path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

// Playwright компилирует тесты в CommonJS: используются __dirname и require.
export const APP_DIR = path.resolve(__dirname, '../..');

export function electronPath(): string {
  if (process.env.ELECTRON_PATH) return process.env.ELECTRON_PATH;
  // В обычной установке путь даёт npm-пакет electron.
  return require('electron') as string;
}

export interface Launched { app: ElectronApplication; page: Page }

export async function launch(opts: { dataDir?: string; appDir?: string; executable?: string } = {}): Promise<Launched> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELAB_DEBUG = '1';
  if (opts.dataDir) env.ELAB_DATA_DIR = opts.dataDir; else delete env.ELAB_DATA_DIR;
  const args = opts.executable ? ['--no-sandbox'] : [opts.appDir ?? APP_DIR, '--no-sandbox'];
  const app = await electron.launch({ executablePath: opts.executable ?? electronPath(), args, env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Подменяет системные диалоги выбора файла: следующий вызов вернёт указанный путь. */
export async function stubSaveDialog(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, filePath);
}
export async function stubOpenDialog(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, filePath);
}
/** Ответ системного окна-вопроса (номер кнопки). */
export async function stubMessageBox(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = (async () => ({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox;
  }, response);
}
