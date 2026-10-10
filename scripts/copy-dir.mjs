// Рекурсивное копирование папки без fs.cpSync: в Node.js 22 на Windows cpSync искажает
// кириллические имена путей (обнаружено в CI). Сохраняет права на исполнение.
import { chmodSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function copyDir(from, to, filter = () => true) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (!filter(src)) continue;
    const dst = join(to, name);
    const st = statSync(src);
    if (st.isDirectory()) copyDir(src, dst, filter);
    else {
      copyFileSync(src, dst);
      chmodSync(dst, st.mode & 0o777);
    }
  }
}
