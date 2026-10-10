// CI: прямой пробный запуск портативной сборки с диагностикой (ELAB_DEBUG), без Playwright.
// Запуск 1 — из папки сборки; запуск 2 — из копии в папке с кириллицей и пробелами в пути.
// Строки вывода — аннотации GitHub.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copyDir } from '../copy-dir.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const isWin = process.platform === 'win32';
const built = resolve('release', `ElectronLab-${pkg.version}-${isWin ? 'win' : 'linux'}-x64-portable`);
const exeName = isWin ? 'ElectronLab.exe' : 'ElectronLab';

async function probe(label, dir) {
  const note = (s) => console.log(`::warning title=portable-probe ${label}::${String(s).replace(/\r?\n/g, ' ')}`);
  note(`exe существует: ${existsSync(join(dir, exeName))}; файлов в папке: ${existsSync(dir) ? readdirSync(dir).length : 'папки нет'}`);
  const child = spawn(join(dir, exeName), isWin ? [] : ['--no-sandbox'], { env: { ...process.env, ELAB_DEBUG: '1' } });
  child.on('error', (e) => note(`ошибка запуска: ${e.message}`));
  let ready = false;
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (d) => d.split(/\r?\n/).filter(Boolean).forEach((l) => {
      if (l.includes('[elab] ready-to-show') || l.includes('[elab] хранилище') || l.includes('[elab] единственный') || /error|ошибк/i.test(l)) note(l);
      if (l.includes('ready-to-show')) ready = true;
    }));
  }
  const deadline = Date.now() + 30_000;
  while (!ready && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 250));
  const data = join(dir, 'data');
  note(`путь: ${dir} → окно показано: ${ready}; код выхода: ${child.exitCode}; data: ${existsSync(data) ? readdirSync(data).join(',') : 'нет'}`);
  if (child.exitCode === null) {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); else child.kill('SIGKILL');
  }
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(data, { recursive: true, force: true }); // пробные данные не должны попасть в e2e
  return ready;
}

const ok1 = await probe('сборка', built);
const cyr = resolve('release', 'Проверка кириллицы', 'Электронная лаборатория');
rmSync(resolve('release', 'Проверка кириллицы'), { recursive: true, force: true });
mkdirSync(cyr, { recursive: true });
try {
  copyDir(built, cyr);
} catch (e) {
  console.log(`::warning title=portable-probe копирование::${e.message}`);
}
console.log(`::warning title=portable-probe копирование::release: ${readdirSync(resolve('release')).join(' | ')}; в копии: ${existsSync(cyr) ? readdirSync(cyr).length : 'нет'}`);
const ok2 = await probe('кириллица', cyr);
rmSync(resolve('release', 'Проверка кириллицы'), { recursive: true, force: true });
process.exit(ok1 && ok2 ? 0 : 1);
