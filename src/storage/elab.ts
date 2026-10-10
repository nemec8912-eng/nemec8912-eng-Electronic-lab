/**
 * Переносимый файл проекта .elab (ZIP): manifest.json, project.json, checkpoints/, attachments/.
 * Формат описан в docs/ARCHITECTURE.md, раздел 4.
 */
import { z } from 'zod';
import { APP_NAME, APP_VERSION, ELAB_FORMAT, ELAB_FORMAT_VERSION } from '../core/appinfo';
import { describeLoadError, loadDocument } from '../core/migrations';
import { CheckpointSchema, CURRENT_SCHEMA_VERSION, type Checkpoint, type ProjectDoc } from '../core/model';
import { AppError } from '../core/result';
import { sha256 } from './fsutil';
import { FileEntrySchema, fileEntries, jsonBuffer, parseJsonBuffer, readZip, verifyEntries, writeZip } from './zip';

export const ElabManifestSchema = z.object({
  format: z.literal(ELAB_FORMAT),
  formatVersion: z.number().int().positive(),
  app: z.object({ name: z.string(), version: z.string() }).strict(),
  createdAt: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  files: z.array(FileEntrySchema),
}).strict();
export type ElabManifest = z.infer<typeof ElabManifestSchema>;

export interface ProjectBundle {
  doc: ProjectDoc;
  checkpoints: Checkpoint[];
  /** Данные вложений по id ссылки AttachmentRef. */
  attachments: Map<string, Buffer>;
}

export interface ElabReadResult extends ProjectBundle {
  manifest: ElabManifest;
  warnings: string[];
  migratedFrom: number | null;
}

export const attachmentPath = (id: string, fileName: string) => `attachments/${id}/${fileName}`;

export async function writeElab(bundle: ProjectBundle, now = new Date()): Promise<Buffer> {
  const { doc } = bundle;
  const files = new Map<string, Buffer>();
  files.set('project.json', jsonBuffer(doc));
  for (const cp of bundle.checkpoints) files.set(`checkpoints/${cp.id}.json`, jsonBuffer(cp));
  for (const ref of doc.attachments) {
    const data = bundle.attachments.get(ref.id);
    if (!data) throw new AppError('missing-attachment', `Нет данных вложения «${ref.fileName}»`);
    if (sha256(data) !== ref.sha256) throw new AppError('attachment-mismatch', `Вложение «${ref.fileName}» изменилось или повреждено`);
    files.set(attachmentPath(ref.id, ref.fileName), data);
  }
  const manifest: ElabManifest = {
    format: ELAB_FORMAT,
    formatVersion: ELAB_FORMAT_VERSION,
    app: { name: APP_NAME, version: APP_VERSION },
    createdAt: now.toISOString(),
    projectId: doc.id,
    projectName: doc.name,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    files: fileEntries(files),
  };
  files.set('manifest.json', jsonBuffer(manifest));
  return writeZip(files);
}

/** Полная проверка и чтение .elab. Бросает AppError с понятным сообщением при любой проблеме. */
export async function readElab(buf: Buffer): Promise<ElabReadResult> {
  const files = await readZip(buf);
  return readElabFiles(files);
}

export function parseManifest(files: Map<string, Buffer>): ElabManifest {
  const raw = files.get('manifest.json');
  if (!raw) throw new AppError('no-manifest', 'В файле нет manifest.json — это не файл проекта «Электронной лаборатории»');
  const json = parseJsonBuffer(raw, 'manifest.json') as Record<string, unknown>;
  if (json?.format !== ELAB_FORMAT) {
    throw new AppError('wrong-format', json?.format === 'electronic-lab-backup'
      ? 'Это файл полной резервной копии. Используйте «Восстановить резервную копию».'
      : 'Неизвестный формат файла');
  }
  if (typeof json.formatVersion === 'number' && json.formatVersion > ELAB_FORMAT_VERSION) {
    throw new AppError('newer-format', `Файл создан более новой версией программы (формат файла ${json.formatVersion}, поддерживается до ${ELAB_FORMAT_VERSION}). Обновите программу.`);
  }
  const m = ElabManifestSchema.safeParse(json);
  if (!m.success) {
    throw new AppError('bad-manifest', 'manifest.json повреждён', m.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return m.data;
}

export function readElabFiles(files: Map<string, Buffer>): ElabReadResult {
  const manifest = parseManifest(files);
  const { problems, extra } = verifyEntries(manifest.files, files);
  if (problems.length) throw new AppError('checksum', 'Файл проекта повреждён или изменён: контрольные суммы не совпадают', problems.slice(0, 20));
  const warnings = extra.map((p) => `Лишний файл в архиве проигнорирован: ${p}`);

  const projectRaw = files.get('project.json');
  if (!projectRaw) throw new AppError('no-project', 'В файле нет project.json');
  const loaded = loadDocument(parseJsonBuffer(projectRaw, 'project.json'));
  if (!loaded.ok) throw new AppError(`project-${loaded.error.code}`, describeLoadError(loaded.error));
  const doc = loaded.doc;
  if (doc.id !== manifest.projectId) throw new AppError('id-mismatch', 'ID проекта в manifest.json не совпадает с project.json');

  const checkpoints: Checkpoint[] = [];
  for (const [p, data] of files) {
    if (!p.startsWith('checkpoints/') || !manifest.files.some((f) => f.path === p)) continue;
    const cpRaw = CheckpointSchema.safeParse(parseJsonBuffer(data, p));
    if (!cpRaw.success) throw new AppError('bad-checkpoint', `Контрольная версия ${p} повреждена`);
    const cpDoc = loadDocument(cpRaw.data.doc);
    if (!cpDoc.ok) throw new AppError('bad-checkpoint', `Контрольная версия «${cpRaw.data.label}»: ${describeLoadError(cpDoc.error)}`);
    if (cpDoc.doc.id !== doc.id) throw new AppError('bad-checkpoint', `Контрольная версия «${cpRaw.data.label}» относится к другому проекту`);
    checkpoints.push({ ...cpRaw.data, doc: cpDoc.doc });
  }
  const cpIds = new Set<string>();
  for (const cp of checkpoints) {
    if (cpIds.has(cp.id)) throw new AppError('duplicate-id', `Повторяющийся ID контрольной версии ${cp.id}`);
    cpIds.add(cp.id);
  }
  checkpoints.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const attachments = new Map<string, Buffer>();
  for (const ref of doc.attachments) {
    const data = files.get(attachmentPath(ref.id, ref.fileName));
    if (!data) throw new AppError('missing-attachment', `В файле нет вложения «${ref.fileName}»`);
    if (data.length !== ref.size || sha256(data) !== ref.sha256) {
      throw new AppError('attachment-mismatch', `Вложение «${ref.fileName}» повреждено`);
    }
    attachments.set(ref.id, data);
  }

  return { doc, checkpoints, attachments, manifest, warnings, migratedFrom: loaded.migratedFrom };
}
