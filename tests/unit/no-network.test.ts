/**
 * Офлайн-гарантия: модули ядра, хранилища, главного процесса и интерфейса не используют сетевые API.
 * Сеть разрешена только будущему модулю импорта деталей (этап 2) по действию пользователя.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../src');
const ALLOWED_DIRS = new Set<string>(['catalog-import']);
const FORBIDDEN = [
  /from ['"]node:(http|https|net|tls|dgram|dns|http2)['"]/,
  /require\(['"](node:)?(http|https|net|tls|dgram|dns|http2)['"]\)/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bnet\.request\b/,
  /https?:\/\/(?!www\.w3\.org\/2000\/svg)/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return ALLOWED_DIRS.has(n) ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

test('в src нет обращений к сети', () => {
  const offenders: string[] = [];
  for (const f of files(ROOT)) {
    const text = readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) if (re.test(text)) offenders.push(`${path.relative(ROOT, f)}: ${re}`);
  }
  assert.deepEqual(offenders, []);
});
