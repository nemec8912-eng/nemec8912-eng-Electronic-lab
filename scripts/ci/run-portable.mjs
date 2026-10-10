// CI: прямой пробный запуск портативной сборки с диагностикой (ELAB_DEBUG). Строки вывода — аннотации GitHub.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const isWin = process.platform === 'win32';
const dir = join('release', `ElectronLab-${pkg.version}-${isWin ? 'win' : 'linux'}-x64-portable`);
const exe = join(dir, isWin ? 'ElectronLab.exe' : 'ElectronLab');
const note = (s) => console.log(`::warning title=portable-probe::${String(s).replace(/\r?\n/g, ' ')}`);

const child = spawn(exe, isWin ? [] : ['--no-sandbox'], { env: { ...process.env, ELAB_DEBUG: '1' } });
child.on('error', (e) => note(`ошибка запуска: ${e.message}`));
let ready = false;
for (const s of [child.stdout, child.stderr]) {
  s.setEncoding('utf8');
  s.on('data', (d) => d.split(/\r?\n/).filter(Boolean).forEach((l) => { if (l.includes('[elab]')) note(l); if (l.includes('ready-to-show')) ready = true; }));
}
const deadline = Date.now() + 30_000;
while (!ready && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 250));
note(`окно показано: ${ready}; код выхода: ${child.exitCode}`);
note(`data создана: ${existsSync(join(dir, 'data'))} ${existsSync(join(dir, 'data')) ? readdirSync(join(dir, 'data')).join(',') : ''}`);
if (child.exitCode === null) {
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); else child.kill('SIGKILL');
}
await new Promise((r) => setTimeout(r, 1500));
rmSync(join(dir, 'data'), { recursive: true, force: true }); // пробные данные не должны попасть в архив и в e2e
process.exit(ready ? 0 : 1);
