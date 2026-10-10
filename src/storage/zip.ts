/** Общие функции ZIP-контейнеров (.elab, .elabbak): безопасное чтение, запись, манифест с контрольными суммами. */
import JSZip from 'jszip';
import { z } from 'zod';
import { AppError } from '../core/result';
import { sha256 } from './fsutil';

export const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3; // 2 ГБ сжатого
export const MAX_UNPACKED_BYTES = 4 * 1024 ** 3; // 4 ГБ распакованного
export const MAX_ENTRIES = 100_000;

export const FileEntrySchema = z.object({
  path: z.string().min(1).max(512),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** Путь внутри архива: только относительный, без «..», обратных слешей, дисков и управляющих символов. */
export function isSafeArchivePath(p: string): boolean {
  if (!p || p.length > 512) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[a-zA-Z]:/.test(p)) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Читает архив целиком в память, проверяя пути и лимиты. Каталоги пропускаются. */
export async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  if (buf.length > MAX_ARCHIVE_BYTES) throw new AppError('too-large', 'Файл слишком большой (больше 2 ГБ)');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf, { checkCRC32: true });
  } catch (e) {
    throw new AppError('corrupt-archive', `Файл повреждён или не является архивом проекта: ${(e as Error).message}`);
  }
  const all = Object.values(zip.files);
  // JSZip «очищает» опасные имена (../) при чтении; проверяем исходное имя из архива.
  const original = (f: JSZip.JSZipObject) => (f as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? f.name;
  const badAll = all.filter((f) => original(f) !== f.name || (!f.dir && !isSafeArchivePath(original(f)))).map(original);
  const entries = all.filter((f) => !f.dir);
  if (entries.length > MAX_ENTRIES) throw new AppError('too-many-files', 'В архиве слишком много файлов');
  const bad = badAll;
  if (bad.length) throw new AppError('unsafe-path', 'Архив содержит недопустимые пути к файлам', bad.slice(0, 20));
  const out = new Map<string, Buffer>();
  let total = 0;
  for (const f of entries) {
    if (out.has(f.name)) throw new AppError('duplicate-path', `В архиве повторяется файл ${f.name}`);
    let data: Buffer;
    try {
      data = await f.async('nodebuffer');
    } catch (e) {
      throw new AppError('corrupt-archive', `Не удалось распаковать ${f.name}: ${(e as Error).message}`);
    }
    total += data.length;
    if (total > MAX_UNPACKED_BYTES) throw new AppError('too-large', 'Распакованное содержимое больше 4 ГБ');
    out.set(f.name, data);
  }
  return out;
}

export async function writeZip(files: Map<string, Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  // Фиксированная дата делает архив воспроизводимым для одинакового содержимого.
  const date = new Date(Date.UTC(2020, 0, 1));
  for (const [p, data] of files) {
    if (!isSafeArchivePath(p)) throw new AppError('unsafe-path', `Недопустимый путь в архиве: ${p}`);
    zip.file(p, data, { date, binary: true });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
}

export function fileEntries(files: Map<string, Buffer>): FileEntry[] {
  return [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, d]) => ({ path: p, size: d.length, sha256: sha256(d) }));
}

/** Сверка перечня и контрольных сумм. Возвращает список расхождений (пусто — всё в порядке). */
export function verifyEntries(declared: FileEntry[], files: Map<string, Buffer>, manifestPath = 'manifest.json'): {
  problems: string[];
  extra: string[];
} {
  const problems: string[] = [];
  const declaredPaths = new Set<string>();
  for (const e of declared) {
    if (declaredPaths.has(e.path)) { problems.push(`файл ${e.path} указан в манифесте дважды`); continue; }
    declaredPaths.add(e.path);
    const data = files.get(e.path);
    if (!data) { problems.push(`нет файла ${e.path}`); continue; }
    if (data.length !== e.size) problems.push(`${e.path}: размер ${data.length} вместо ${e.size}`);
    else if (sha256(data) !== e.sha256) problems.push(`${e.path}: контрольная сумма не совпадает`);
  }
  const extra = [...files.keys()].filter((p) => p !== manifestPath && !declaredPaths.has(p));
  return { problems, extra };
}

export function parseJsonBuffer(data: Buffer, name: string): unknown {
  try {
    const text = data.toString('utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new AppError('bad-json', `${name} повреждён (не JSON): ${(e as Error).message}`);
  }
}

export const jsonBuffer = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8');
