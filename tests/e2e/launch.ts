/** Запуск собранного приложения в Electron для e2e-тестов, с отдельной папкой данных. */
import { spawnSync } from 'node:child_process';
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

/** Последнее запущенное приложение — для диагностики при падении теста. */
export let lastLaunched: Launched | null = null;

/** При падении: текст окна — в аннотацию GitHub (в CI логи недоступны), приложение — завершить. */
export async function reportAndCleanup(failed: boolean, title: string): Promise<void> {
  const l = lastLaunched;
  lastLaunched = null;
  if (!l) return;
  if (failed) {
    try {
      const text = await l.page.evaluate(() => document.body.innerText);
      const dialogs = await l.page.evaluate(() => Array.from(document.querySelectorAll('[role=dialog]')).map((d) => (d as HTMLElement).innerText).join(' || '));
      process.stdout.write(`\n::warning title=e2e-окно ${title.slice(0, 60)}::${(text + ' ## ДИАЛОГИ: ' + dialogs).replace(/\s+/g, ' ').slice(0, 1500)}\n`);
    } catch (e) {
      process.stdout.write(`\n::warning title=e2e-окно ${title.slice(0, 60)}::окно недоступно: ${(e as Error).message.split('\n')[0]}\n`);
    }
  }
  let alive = false;
  try { const proc = l.app.process(); alive = !!proc && proc.exitCode === null && proc.signalCode === null; } catch { /* уже закрыто */ }
  if (alive) await killHard(l.app).catch(() => undefined);
}

export async function launch(opts: { dataDir?: string; appDir?: string; executable?: string } = {}): Promise<Launched> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELAB_DEBUG = '1';
  if (opts.dataDir) env.ELAB_DATA_DIR = opts.dataDir; else delete env.ELAB_DATA_DIR;
  const args = opts.executable ? ['--no-sandbox'] : [opts.appDir ?? APP_DIR, '--no-sandbox'];
  // Только что скопированный .exe Windows (антивирус) может кратковременно не дать запустить — повторяем.
  let app: ElectronApplication | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      app = await electron.launch({ executablePath: opts.executable ?? electronPath(), args, env, timeout: 60_000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      process.stdout.write(`\n::warning title=e2e-запуск::попытка ${attempt}: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}\n`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  lastLaunched = { app, page };
  return lastLaunched;
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

/**
 * Имитация аварии: мгновенно завершить всё дерево процессов приложения.
 * В Windows дочерние процессы Electron не завершаются вместе с главным, поэтому — taskkill /T /F.
 */
export async function killHard(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
  else proc.kill('SIGKILL');
  await exited;
  if (process.platform === 'win32') await new Promise((r) => setTimeout(r, 1500));
}
