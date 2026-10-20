// Сборка браузерной демо-версии в один HTML-файл (dist-web/index.html): интерфейс программы
// с хранилищем браузера вместо диска; расчёт ngspice, файлы и печать — только в программе для ПК.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-web');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/web/main.tsx')],
  outdir: out,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  // Модули Node (запуск ngspice процессом на ПК) в браузере не вызываются — только ленивый импорт.
  external: ['node:*'],
});
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const js = readFileSync(join(out, 'main.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(out, 'main.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
// ngspice WebAssembly (vendor/ngspice-wasm — сборка GitHub Actions): код и модуль встраиваются в страницу.
const wasmDir = join(root, 'vendor', 'ngspice-wasm');
let ngspice = '';
if (existsSync(join(wasmDir, 'spice.wasm'))) {
  const sjs = readFileSync(join(wasmDir, 'spice.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const b64 = readFileSync(join(wasmDir, 'spice.wasm')).toString('base64');
  ngspice = `<script type="text/plain" id="ngspice-js">${sjs}</script>\n<script type="application/octet-stream;base64" id="ngspice-wasm">${b64}</script>\n`;
  console.log(`ngspice WebAssembly встроен (${Math.round(b64.length / 1024)} КБ)`);
} else console.log('ngspice WebAssembly не найден (vendor/ngspice-wasm) — демо без расчёта');
const html = `<title>Электронная лаборатория</title>
<style>
html, body { height: 100%; }
body { background: #f4f5f7; color: #1d2228; }
#root { height: calc(100% - 30px); }
.web-demo-bar { height: 30px; display: flex; align-items: center; gap: 8px; padding: 0 16px; font: 12.5px "Segoe UI", system-ui, sans-serif;
  background: #fff4d6; color: #6b4a00; border-bottom: 1px solid #e8d9a8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
${css}
</style>
<div class="web-demo-bar" role="note">Демо-версия ${version} в браузере: проекты хранятся только в этом браузере; ${ngspice ? 'расчёт ngspice работает прямо здесь (медленнее, чем в программе), а' : 'расчёт ngspice,'} файлы и печать — в программе для ПК.</div>
<div id="root"></div>
${ngspice}<script>${js}</script>
`;
writeFileSync(join(out, 'index.html'), html);
console.log(`Готово: dist-web/index.html (${Math.round(html.length / 1024)} КБ)`);
