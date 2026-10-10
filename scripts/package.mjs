// Портативная сборка: официальный архив Electron + собранное приложение + portable.flag.
// Использование: node scripts/package.mjs win32|linux
// Архив Electron берётся из папки ELAB_ELECTRON_ZIP_DIR (или vendor-cache/), а если его нет — скачивается
// с GitHub-релиза Electron. Контрольная сумма всегда сверяется с SHASUMS256.txt того же релиза.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { copyDir } from './copy-dir.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const platform = process.argv[2];
if (!['win32', 'linux'].includes(platform)) {
  console.error('Укажите платформу: win32 или linux');
  process.exit(1);
}
const ev = pkg.electronVersion;
const zipName = `electron-v${ev}-${platform}-x64.zip`;
const releaseUrl = `https://github.com/electron/electron/releases/download/v${ev}`;
const cacheDir = process.env.ELAB_ELECTRON_ZIP_DIR || join(root, 'vendor-cache');
mkdirSync(cacheDir, { recursive: true });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function obtain(name) {
  const p = join(cacheDir, name);
  if (!existsSync(p)) {
    console.log(`Скачивание ${name}…`);
    const res = await fetch(`${releaseUrl}/${name}`);
    if (!res.ok) throw new Error(`Не удалось скачать ${name}: HTTP ${res.status}`);
    writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(p);
}

const sums = (await obtain('SHASUMS256.txt')).toString('utf8');
const expected = sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, n]) => n === zipName)?.[0];
if (!expected) throw new Error(`В SHASUMS256.txt нет ${zipName}`);
const electronZip = await obtain(zipName);
const actual = sha256(electronZip);
if (actual !== expected) throw new Error(`Контрольная сумма ${zipName} не совпадает: ${actual} ≠ ${expected}`);
console.log(`Electron ${ev} (${platform}) — контрольная сумма совпадает`);

const appName = 'ElectronLab';
const base = `${appName}-${pkg.version}-${platform === 'win32' ? 'win' : 'linux'}-x64-portable`;
const releaseDir = join(root, 'release');
const outDir = join(releaseDir, base);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Распаковка Electron с сохранением прав на исполнение
const ez = await JSZip.loadAsync(electronZip);
for (const f of Object.values(ez.files)) {
  const target = join(outDir, f.name);
  if (!target.startsWith(outDir)) throw new Error(`Недопустимый путь в архиве Electron: ${f.name}`);
  if (f.dir) { mkdirSync(target, { recursive: true }); continue; }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await f.async('nodebuffer'));
  const mode = f.unixPermissions;
  if (platform === 'linux' && typeof mode === 'number' && mode & 0o111) chmodSync(target, mode & 0o777);
}

// Переименование исполняемого файла и удаление демонстрационного приложения Electron
const exeFrom = join(outDir, platform === 'win32' ? 'electron.exe' : 'electron');
const exeTo = join(outDir, platform === 'win32' ? `${appName}.exe` : appName);
copyFileSync(exeFrom, exeTo);
if (platform === 'linux') chmodSync(exeTo, 0o755);
rmSync(exeFrom);
rmSync(join(outDir, 'resources', 'default_app.asar'), { force: true });

// Приложение: package.json + dist без карт исходников
const appDir = join(outDir, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main, private: true,
}, null, 2));
copyDir(join(root, 'dist'), join(appDir, 'dist'), (src) => !src.endsWith('.map'));

// Симулятор ngspice (ADR-0002): для Windows — официальная сборка из vendor/ngspice/win32-x64
// (scripts/fetch-ngspice.mjs). Без неё пакет не собирается, кроме явного ELAB_ALLOW_NO_NGSPICE=1.
const ngspiceSrc = join(root, 'vendor', 'ngspice', `${platform}-x64`);
const ngspiceExe = join(ngspiceSrc, 'bin', platform === 'win32' ? 'ngspice_con.exe' : 'ngspice');
if (existsSync(ngspiceExe)) {
  copyDir(ngspiceSrc, join(outDir, 'resources', 'ngspice'));
  console.log(`ngspice включён: ${ngspiceSrc}`);
} else if (platform === 'linux') {
  console.log('ngspice в Linux-пакет не включается: используется системный (пакет ngspice).');
} else if (process.env.ELAB_ALLOW_NO_NGSPICE === '1') {
  console.log('ВНИМАНИЕ: пакет собран БЕЗ ngspice — расчёт в нём будет недоступен (ELAB_ALLOW_NO_NGSPICE=1).');
} else {
  throw new Error(`Нет ${ngspiceExe}. Выполните node scripts/fetch-ngspice.mjs или задайте ELAB_ALLOW_NO_NGSPICE=1.`);
}

// Портативный режим: данные в папке data рядом с программой
writeFileSync(join(outDir, 'portable.flag'), 'Портативный режим: данные хранятся в папке data рядом с программой.\n');
writeFileSync(join(outDir, 'ПРОЧТИ МЕНЯ.txt'), [
  `Электронная лаборатория ${pkg.version} — портативная версия`,
  '',
  `Запуск: ${platform === 'win32' ? `${appName}.exe` : appName}. Установка и интернет не нужны.`,
  'Все проекты, каталог, настройки и журнал хранятся в папке data рядом с программой.',
  'Чтобы перенести всё на другой компьютер — скопируйте эту папку целиком (например, на флешку)',
  'или используйте кнопки «Экспорт проекта» и «Резервная копия всего».',
  '',
  'Не удаляйте файл portable.flag — без него данные будут храниться в профиле пользователя Windows.',
  '',
].join(platform === 'win32' ? '\r\n' : '\n'), 'utf8');

// Архив для переноса
const outZip = new JSZip();
const addDir = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = `${base}/${relative(outDir, p).split('\\').join('/')}`;
    const st = statSync(p);
    if (st.isDirectory()) addDir(p);
    else outZip.file(rel, readFileSync(p), { unixPermissions: st.mode & 0o777, binary: true });
  }
};
addDir(outDir);
const zipPath = join(releaseDir, `${base}.zip`);
const zipBuf = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
writeFileSync(zipPath, zipBuf);
writeFileSync(`${zipPath}.sha256`, `${sha256(zipBuf)}  ${base}.zip\n`);
console.log(`Готово: ${relative(root, zipPath)} (${(zipBuf.length / 1024 / 1024).toFixed(1)} МБ)`);
