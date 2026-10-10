/**
 * Полная резервная копия .elabbak: все проекты (с рабочими копиями, контрольными версиями, вложениями),
 * личный каталог, настройки, журнал. Восстановление — с предварительной проверкой и
 * автоматической копией текущего состояния. Формат — docs/ARCHITECTURE.md, раздел 5.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { APP_NAME, APP_VERSION, BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from '../core/appinfo';
import { isUuid } from '../core/ids';
import { describeLoadError, loadDocument } from '../core/migrations';
import { CheckpointSchema } from '../core/model';
import { AppError } from '../core/result';
import { ensureDir, exists, timestampForFile, writeFileAtomic } from './fsutil';
import { recoverInterruptedRestore, type DataStore } from './store';
import { FileEntrySchema, fileEntries, isSafeArchivePath, jsonBuffer, parseJsonBuffer, readZip, verifyEntries, writeZip } from './zip';

export const BackupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().positive(),
  app: z.object({ name: z.string(), version: z.string() }).strict(),
  createdAt: z.string(),
  projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  files: z.array(FileEntrySchema),
}).strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/** Что входит в бэкап и заменяется при восстановлении. Корзина и служебные копии — нет. */
const SWAP_NAMES = ['projects', 'library', 'settings.json', 'journal.jsonl'] as const;

async function walk(dir: string, base: string, out: Map<string, Buffer>, skip: (rel: string) => boolean) {
  if (!(await exists(dir))) return;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.posix.join(base, e.name);
    if (skip(rel)) continue;
    if (e.isDirectory()) await walk(abs, rel, out, skip);
    else if (e.isFile()) out.set(rel, await fs.readFile(abs));
  }
}

/** Пропускаем временные файлы атомарной записи и незавершённые импорты. */
const skipTransient = (rel: string) => rel.endsWith('.tmp') || rel.split('/').some((s) => s.startsWith('.incoming-'));

export async function createBackup(store: DataStore, now = new Date()): Promise<{ buffer: Buffer; manifest: BackupManifest }> {
  const files = new Map<string, Buffer>();
  await walk(store.projectsDir, 'projects', files, skipTransient);
  await walk(store.libraryDir, 'library', files, skipTransient);
  for (const f of ['settings.json', 'journal.jsonl'] as const) {
    const abs = path.join(store.root, f);
    if (await exists(abs)) files.set(f, await fs.readFile(abs));
  }
  const projects = (await store.listProjects()).map((p) => ({ id: p.id, name: p.name }));
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: { name: APP_NAME, version: APP_VERSION },
    createdAt: now.toISOString(),
    projects,
    files: fileEntries(files),
  };
  files.set('manifest.json', jsonBuffer(manifest));
  const buffer = await writeZip(files);
  await store.journal('backup-create', { projects: projects.length, bytes: buffer.length });
  return { buffer, manifest };
}

export interface VerifiedBackup {
  manifest: BackupManifest;
  files: Map<string, Buffer>;
  warnings: string[];
}

/** Полная проверка архива бэкапа до каких-либо изменений на диске. */
export async function verifyBackup(buf: Buffer): Promise<VerifiedBackup> {
  const files = await readZip(buf);
  const raw = files.get('manifest.json');
  if (!raw) throw new AppError('no-manifest', 'В файле нет manifest.json — это не резервная копия «Электронной лаборатории»');
  const json = parseJsonBuffer(raw, 'manifest.json') as Record<string, unknown>;
  if (json?.format !== BACKUP_FORMAT) {
    throw new AppError('wrong-format', json?.format === 'electronic-lab-project'
      ? 'Это файл отдельного проекта. Используйте «Импорт проекта».'
      : 'Неизвестный формат файла');
  }
  if (typeof json.formatVersion === 'number' && json.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new AppError('newer-format', `Резервная копия создана более новой версией программы (формат ${json.formatVersion}). Обновите программу.`);
  }
  const parsed = BackupManifestSchema.safeParse(json);
  if (!parsed.success) throw new AppError('bad-manifest', 'manifest.json резервной копии повреждён');
  const manifest = parsed.data;
  const { problems, extra } = verifyEntries(manifest.files, files);
  if (problems.length) throw new AppError('checksum', 'Резервная копия повреждена: контрольные суммы не совпадают', problems.slice(0, 20));
  for (const p of extra) files.delete(p);
  const warnings = extra.map((p) => `Лишний файл проигнорирован: ${p}`);
  files.delete('manifest.json');

  const problemsDeep: string[] = [];
  for (const [p, data] of files) {
    if (!isSafeArchivePath(p)) { problemsDeep.push(`недопустимый путь ${p}`); continue; }
    const top = p.split('/')[0]!;
    if (!(SWAP_NAMES as readonly string[]).includes(top)) { problemsDeep.push(`неожиданный файл ${p}`); continue; }
    const parts = p.split('/');
    if (top === 'projects') {
      const id = parts[1] ?? '';
      if (!isUuid(id)) { problemsDeep.push(`${p}: папка проекта не является UUID`); continue; }
      const name = parts.slice(2).join('/');
      if (name === 'project.json' || name === 'autosave.json') {
        let docRaw = parseJsonBuffer(data, p) as Record<string, unknown>;
        if (name === 'autosave.json') docRaw = docRaw?.doc as Record<string, unknown>;
        const loaded = loadDocument(docRaw);
        if (!loaded.ok) problemsDeep.push(`${p}: ${describeLoadError(loaded.error)}`);
        else if (loaded.doc.id !== id) problemsDeep.push(`${p}: ID проекта не совпадает с папкой`);
      } else if (name.startsWith('checkpoints/') && name.endsWith('.json')) {
        const cp = CheckpointSchema.safeParse(parseJsonBuffer(data, p));
        if (!cp.success) problemsDeep.push(`${p}: контрольная версия повреждена`);
      }
    } else if (p.endsWith('.json')) {
      parseJsonBuffer(data, p);
    }
  }
  for (const proj of manifest.projects) {
    if (!files.has(`projects/${proj.id}/project.json`)) problemsDeep.push(`нет проекта «${proj.name}»`);
  }
  if (problemsDeep.length) throw new AppError('invalid-backup', 'Резервная копия содержит повреждённые данные — восстановление отменено', problemsDeep.slice(0, 20));
  return { manifest, files, warnings };
}

/**
 * Восстановление: проверка → копия текущего состояния в backups/ → подготовка во временной папке →
 * замена папок. Сбой во время замены исправляется при следующем запуске (recoverInterruptedRestore).
 * После вызова экземпляр store нужно закрыть и открыть заново.
 */
export async function restoreBackup(store: DataStore, verified: VerifiedBackup): Promise<{ safetyBackup: string | null; projects: number }> {
  const root = store.root;
  const stamp = timestampForFile();

  // Копия текущего состояния делается всегда: так восстановление можно отменить.
  const { buffer } = await createBackup(store);
  const safetyBackup: string | null = path.join(store.backupsDir, `before-restore-${stamp}.elabbak`);
  await writeFileAtomic(safetyBackup, buffer);

  const staging = path.join(root, `.restore-staging-${stamp}`);
  const oldDir = path.join(root, `.restore-old-${stamp}`);
  await fs.rm(staging, { recursive: true, force: true });
  try {
    for (const [p, data] of verified.files) await writeFileAtomic(path.join(staging, ...p.split('/')), data);
    for (const d of ['projects', 'library']) await ensureDir(path.join(staging, d));
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new AppError('restore-failed', `Не удалось подготовить восстановление: ${(e as Error).message}. Текущие данные не изменены.`);
  }

  await ensureDir(oldDir);
  try {
    for (const name of SWAP_NAMES) {
      const cur = path.join(root, name);
      if (await exists(cur)) await fs.rename(cur, path.join(oldDir, name));
    }
    for (const name of SWAP_NAMES) {
      const next = path.join(staging, name);
      if (await exists(next)) await fs.rename(next, path.join(root, name));
    }
    await fs.writeFile(path.join(oldDir, 'swap-complete'), stamp);
  } catch (e) {
    // Возвращаем прежнее состояние тем же механизмом, что и при сбое.
    await recoverInterruptedRestore(root);
    throw new AppError('restore-failed', `Восстановление прервано: ${(e as Error).message}. Прежние данные возвращены.`);
  }
  await fs.rm(oldDir, { recursive: true, force: true });
  await fs.rm(staging, { recursive: true, force: true });
  await store.journal('backup-restore', { projects: verified.manifest.projects.length, from: verified.manifest.createdAt, safetyBackup: safetyBackup ? path.relative(root, safetyBackup) : null });
  return { safetyBackup, projects: verified.manifest.projects.length };
}
