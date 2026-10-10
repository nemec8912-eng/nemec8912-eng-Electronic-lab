// Получение официальной Windows-сборки ngspice для портативного пакета (ADR-0002).
// Скачивает архив с SourceForge, сверяет SHA-256 с scripts/ngspice-win.json и распаковывает
// содержимое Spice64 в vendor/ngspice/win32-x64 (bin/ngspice_con.exe, share/…).
// Если контрольная сумма ещё не закреплена (sha256: null), архив принимается только при
// ELAB_NGSPICE_PIN=1, а его сумма выводится для закрепления в репозитории.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'scripts', 'ngspice-win.json'), 'utf8'));
const cache = process.env.ELAB_ELECTRON_ZIP_DIR || join(root, 'vendor-cache');
const target = join(root, 'vendor', 'ngspice', 'win32-x64');
mkdirSync(cache, { recursive: true });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const note = (kind, msg) => console.log(process.env.GITHUB_ACTIONS ? `::${kind} title=ngspice::${msg}` : msg);

async function download() {
  const local = join(cache, cfg.file);
  if (existsSync(local)) return readFileSync(local);
  for (const url of cfg.urls) {
    try {
      console.log(`Скачивание ${url}`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { console.log(`  HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) { console.log(`  слишком маленький ответ (${buf.length} байт) — вероятно, страница, а не архив`); continue; }
      writeFileSync(local, buf);
      return buf;
    } catch (e) {
      console.log(`  ошибка: ${e.message}`);
    }
  }
  throw new Error(`Не удалось скачать ${cfg.file}`);
}

const buf = await download();
const actual = sha256(buf);
if (cfg.sha256) {
  if (actual !== cfg.sha256) throw new Error(`SHA-256 ${cfg.file} не совпадает: ${actual} ≠ ${cfg.sha256}`);
  note('notice', `${cfg.file}: контрольная сумма совпадает`);
} else if (process.env.ELAB_NGSPICE_PIN === '1') {
  note('warning', `${cfg.file} (${buf.length} байт) SHA-256 = ${actual} — закрепите в scripts/ngspice-win.json`);
} else {
  throw new Error(`SHA-256 для ${cfg.file} не закреплена в scripts/ngspice-win.json (получено ${actual}). Запустите с ELAB_NGSPICE_PIN=1 и закрепите значение.`);
}

// Распаковка 7z: в Windows-раннере 7z установлен; локально — 7z/7za, если есть.
const tmp = join(cache, 'ngspice-extract');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const archive = join(cache, cfg.file);
if (cfg.file.endsWith('.zip')) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  for (const f of Object.values(zip.files)) {
    const out = join(tmp, f.name);
    if (!out.startsWith(tmp)) throw new Error(`Недопустимый путь в архиве: ${f.name}`);
    if (f.dir) { mkdirSync(out, { recursive: true }); continue; }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, await f.async('nodebuffer'));
  }
} else {
  const sevenZip = ['7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe'].find((c) => { try { execFileSync(c, ['i'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!sevenZip) throw new Error('Не найден 7z для распаковки ngspice');
  execFileSync(sevenZip, ['x', '-y', `-o${tmp}`, archive], { stdio: 'inherit' });
}

// Ищем папку, в которой лежит bin/ngspice_con.exe
function findRoot(dir, depth = 0) {
  if (existsSync(join(dir, 'bin', 'ngspice_con.exe'))) return dir;
  if (depth > 3) return null;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { const r = findRoot(p, depth + 1); if (r) return r; }
  }
  return null;
}
const found = findRoot(tmp);
if (!found) throw new Error('В архиве ngspice нет bin/ngspice_con.exe');
rmSync(target, { recursive: true, force: true });
copyDir(found, target);
writeFileSync(join(target, 'SOURCE.txt'), `ngspice ${cfg.version}, официальная сборка для Windows (64 бит)\nИсточник: ${cfg.urls[0]}\nSHA-256 архива: ${actual}\nЛицензия: модифицированная BSD (см. https://ngspice.sourceforge.io/)\n`);
rmSync(tmp, { recursive: true, force: true });
note('notice', `ngspice ${cfg.version} для Windows подготовлен: ${target}`);
