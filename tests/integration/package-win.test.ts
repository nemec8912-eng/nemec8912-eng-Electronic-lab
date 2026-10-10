/**
 * Структурная проверка портативного Windows-архива (запустить .exe в Linux нельзя — это делается
 * по чек-листу ADR-0001 на реальном ПК). Пропускается, если архив не собран (npm run package:win).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const base = `ElectronLab-${pkg.version}-win-x64-portable`;
const zipPath = path.join(root, 'release', `${base}.zip`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('портативный архив для Windows собран правильно', { skip: !existsSync(zipPath) && 'архив не собран' }, async () => {
  const buf = readFileSync(zipPath);
  const recorded = readFileSync(`${zipPath}.sha256`, 'utf8').split(/\s+/)[0];
  assert.equal(sha(buf), recorded, 'контрольная сумма архива совпадает с .sha256');

  const zip = await JSZip.loadAsync(buf);
  const has = (p: string) => zip.file(`${base}/${p}`) !== null;
  for (const p of [
    'ElectronLab.exe', 'portable.flag', 'ПРОЧТИ МЕНЯ.txt', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak',
    'v8_context_snapshot.bin', 'resources/app/package.json', 'resources/app/dist/main/main.js',
    'resources/app/dist/preload/preload.js', 'resources/app/dist/renderer/index.html',
    'resources/app/dist/renderer/main.js', 'resources/app/dist/renderer/main.css',
  ]) assert.ok(has(p), `нет ${p}`);
  assert.ok(!has('electron.exe'), 'исполняемый файл переименован');
  assert.ok(!has('resources/default_app.asar'), 'демонстрационное приложение Electron удалено');
  assert.ok(!Object.keys(zip.files).some((n) => n.endsWith('.map')), 'карты исходников не поставляются');

  const appPkg = JSON.parse(await zip.file(`${base}/resources/app/package.json`)!.async('string'));
  assert.equal(appPkg.version, pkg.version);
  assert.ok(has(`resources/app/${appPkg.main}`), 'точка входа существует');

  // Исполняемый файл — без изменений из официального релиза Electron (сверка с его архивом, если он есть).
  const electronZip = path.join(process.env.ELAB_ELECTRON_ZIP_DIR ?? path.join(root, 'vendor-cache'), `electron-v${pkg.electronVersion}-win32-x64.zip`);
  if (existsSync(electronZip)) {
    const ez = await JSZip.loadAsync(readFileSync(electronZip));
    const original = await ez.file('electron.exe')!.async('nodebuffer');
    const ours = await zip.file(`${base}/ElectronLab.exe`)!.async('nodebuffer');
    assert.equal(sha(ours), sha(original));
  }

  // Интерфейс не загружает ничего из сети
  const html = await zip.file(`${base}/resources/app/dist/renderer/index.html`)!.async('string');
  assert.match(html, /default-src 'self'/);
  assert.doesNotMatch(html, /https?:\/\//);
});
