// Сборка приложения в dist/: главный процесс, мост (preload) и интерфейс. Без обращений к сети.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: 'linked', legalComments: 'none', logLevel: 'warning' };

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(out, 'main/main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/preload/preload.ts')],
    outfile: join(out, 'preload/preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/renderer/main.tsx')],
    outfile: join(out, 'renderer/main.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
  }),
]);

mkdirSync(join(out, 'renderer'), { recursive: true });
cpSync(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
console.log('Сборка готова: dist/');
