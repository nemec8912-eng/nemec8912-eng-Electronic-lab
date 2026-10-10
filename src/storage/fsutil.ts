/** Надёжные файловые операции: атомарная запись, чтение JSON, контрольные суммы. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AppError } from '../core/result';

export function sha256(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

let tmpCounter = 0;

/**
 * Атомарная запись: временный файл → fsync → переименование поверх.
 * При обрыве остаётся либо старый, либо новый файл целиком.
 */
export async function writeFileAtomic(file: string, data: Buffer | string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  await fsyncDir(path.dirname(file));
}

/** На Windows переименование может кратковременно блокироваться антивирусом/индексатором. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // на Windows каталог открыть для fsync нельзя
  try {
    const h = await fs.open(dir, 'r');
    try { await h.sync(); } finally { await h.close(); }
  } catch {
    /* не все ФС поддерживают fsync каталога — не критично */
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new AppError('read-failed', `Не удалось прочитать файл ${path.basename(file)}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new AppError('bad-json', `Файл ${path.basename(file)} повреждён (не JSON): ${(e as Error).message}`);
  }
}

/** Безопасное имя файла для Windows и Linux. */
export function safeFileName(name: string, fallback = 'file'): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned)) return fallback;
  return cleaned;
}

export function timestampForFile(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
