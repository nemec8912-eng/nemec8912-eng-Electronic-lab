/**
 * Локальное хранилище: проекты, автосохранение, восстановление, контрольные версии, корзина, журнал,
 * импорт/экспорт .elab и полный бэкап. Не зависит от Electron — тестируется напрямую на Node.js.
 * Раскладка папки данных — docs/ARCHITECTURE.md, раздел 6.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { DATA_LAYOUT_VERSION } from '../core/appinfo';
import { logChange, normalizeName, createProject as makeProject } from '../core/factory';
import { isUuid, newId } from '../core/ids';
import { describeLoadError, loadDocument } from '../core/migrations';
import { CheckpointSchema, type Checkpoint, type CheckpointInfo, type ProjectDoc } from '../core/model';
import { remapDocs } from '../core/remap';
import { AppError } from '../core/result';
import { bundleOf, checkLibrary, emptyCatalog, lintBundle, loadCatalog, removePart, upsertBundle, type CatalogFile, type PartBundle } from '../core/catalog';
import { attachmentPath, readElab, writeElab, type ElabReadResult, type ProjectBundle } from './elab';
import { ensureDir, exists, readJson, timestampForFile, writeFileAtomic, writeJsonAtomic } from './fsutil';

export const AUTO_CHECKPOINTS_KEPT = 20;

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  revision: number;
  /** Есть рабочая копия с несохранёнными изменениями (после сбоя или незакрытого сеанса). */
  hasRecovery: boolean;
  recoveryAt: string | null;
  /** Проект не читается — показывается в списке с ошибкой, а не пропадает молча. */
  error: string | null;
}

export interface OpenedProject {
  doc: ProjectDoc;
  recovery: { doc: ProjectDoc; autosavedAt: string } | null;
  recoveryError: string | null;
}

export type ImportMode = 'new' | 'replace' | 'copy';

export interface ImportPreview {
  read: ElabReadResult;
  existing: ProjectSummary | null;
}

const AutosaveSchema = z.object({ autosavedAt: z.string(), doc: z.unknown() }).strict();

const EMPTY_CATALOG = emptyCatalog();
const DEFAULT_SETTINGS = { schemaVersion: 1, autosaveDelayMs: 1500 };

export interface StoreOptions {
  /** Не проверять живой процесс-владелец блокировки (для тестов аварийного завершения). */
  ignoreLiveLock?: boolean;
}

export class DataStore {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly root: string,
    readonly crashedLastSession: boolean,
    readonly restoreRecovered: string | null,
  ) {}

  // ---------- Пути ----------
  get projectsDir() { return path.join(this.root, 'projects'); }
  get libraryDir() { return path.join(this.root, 'library'); }
  get trashDir() { return path.join(this.root, 'trash'); }
  get backupsDir() { return path.join(this.root, 'backups'); }
  get settingsFile() { return path.join(this.root, 'settings.json'); }
  get journalFile() { return path.join(this.root, 'journal.jsonl'); }
  get lockFile() { return path.join(this.root, 'session.lock'); }
  projectDir(id: string) {
    if (!isUuid(id)) throw new AppError('bad-id', `Некорректный ID проекта: ${id}`);
    return path.join(this.projectsDir, id);
  }

  // ---------- Открытие / закрытие ----------

  static async open(root: string, opts: StoreOptions = {}): Promise<DataStore> {
    await ensureDir(root);
    const restoreRecovered = await recoverInterruptedRestore(root);
    const lockFile = path.join(root, 'session.lock');
    let crashed = false;
    if (await exists(lockFile)) {
      crashed = true;
      try {
        const lock = (await readJson(lockFile)) as { pid?: number; host?: string };
        if (!opts.ignoreLiveLock && lock.host === os.hostname() && typeof lock.pid === 'number' && lock.pid !== process.pid && isAlive(lock.pid)) {
          throw new AppError('locked', 'Папка данных уже открыта другой копией программы на этом компьютере. Закройте её и повторите.');
        }
      } catch (e) {
        if (e instanceof AppError && e.code === 'locked') throw e;
      }
    }
    for (const d of ['projects', 'library', 'trash', 'backups']) await ensureDir(path.join(root, d));
    const metaFile = path.join(root, 'meta.json');
    if (!(await exists(metaFile))) await writeJsonAtomic(metaFile, { layoutVersion: DATA_LAYOUT_VERSION, createdAt: new Date().toISOString() });
    const catalog = path.join(root, 'library', 'catalog.json');
    if (!(await exists(catalog))) await writeJsonAtomic(catalog, EMPTY_CATALOG);
    const settings = path.join(root, 'settings.json');
    if (!(await exists(settings))) await writeJsonAtomic(settings, DEFAULT_SETTINGS);
    await writeJsonAtomic(lockFile, { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
    const store = new DataStore(root, crashed, restoreRecovered);
    await store.journal('session-start', { crashedLastSession: crashed, ...(restoreRecovered ? { restoreRecovered } : {}) });
    return store;
  }

  /** Нормальное завершение: снимает признак незавершённого сеанса. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.serial(async () => {
      await this.journal('session-end', {});
      await fs.rm(this.lockFile, { force: true });
      this.closed = true;
    });
  }

  /** Все записывающие операции выполняются строго по очереди. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppError('closed', 'Хранилище закрыто'));
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async journal(action: string, details: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), action, ...details }) + '\n';
    try {
      await fs.appendFile(this.journalFile, line, 'utf8');
    } catch {
      /* журнал не должен ломать основную операцию */
    }
  }

  // ---------- Проекты ----------

  async listProjects(): Promise<ProjectSummary[]> {
    const entries = await fs.readdir(this.projectsDir, { withFileTypes: true });
    const out: ProjectSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !isUuid(e.name)) continue;
      out.push(await this.summarize(e.name));
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async summarize(id: string): Promise<ProjectSummary> {
    const dir = this.projectDir(id);
    const autosaveFile = path.join(dir, 'autosave.json');
    let recoveryAt: string | null = null;
    if (await exists(autosaveFile)) {
      try {
        recoveryAt = AutosaveSchema.parse(await readJson(autosaveFile)).autosavedAt;
      } catch {
        recoveryAt = 'повреждена';
      }
    }
    try {
      const doc = await this.readSaved(id);
      return { id, name: doc.name, updatedAt: doc.updatedAt, revision: doc.revision, hasRecovery: recoveryAt !== null, recoveryAt, error: null };
    } catch (e) {
      return { id, name: `Проект ${id.slice(0, 8)}`, updatedAt: '', revision: 0, hasRecovery: recoveryAt !== null, recoveryAt, error: (e as Error).message };
    }
  }

  /** Читает сохранённый project.json; если он повреждён, а .bak цел — сообщает и предлагает .bak через ошибку. */
  private async readSaved(id: string): Promise<ProjectDoc> {
    const file = path.join(this.projectDir(id), 'project.json');
    if (!(await exists(file))) throw new AppError('not-found', 'Проект не найден');
    const loaded = loadDocument(await readJson(file));
    if (!loaded.ok) throw new AppError(`project-${loaded.error.code}`, describeLoadError(loaded.error));
    if (loaded.doc.id !== id) throw new AppError('id-mismatch', 'ID внутри project.json не совпадает с папкой проекта');
    return loaded.doc;
  }

  async createProject(name: string): Promise<ProjectDoc> {
    return this.serial(async () => {
      const doc = makeProject(name);
      await this.writeNewProject({ doc, checkpoints: [], attachments: new Map() });
      await this.journal('project-create', { projectId: doc.id, name: doc.name });
      return doc;
    });
  }

  async openProject(id: string): Promise<OpenedProject> {
    const doc = await this.readSaved(id);
    const autosaveFile = path.join(this.projectDir(id), 'autosave.json');
    if (!(await exists(autosaveFile))) return { doc, recovery: null, recoveryError: null };
    try {
      const a = AutosaveSchema.parse(await readJson(autosaveFile));
      const loaded = loadDocument(a.doc);
      if (!loaded.ok) return { doc, recovery: null, recoveryError: describeLoadError(loaded.error) };
      if (loaded.doc.id !== id) return { doc, recovery: null, recoveryError: 'Рабочая копия относится к другому проекту' };
      return { doc, recovery: { doc: loaded.doc, autosavedAt: a.autosavedAt }, recoveryError: null };
    } catch (e) {
      return { doc, recovery: null, recoveryError: (e as Error).message };
    }
  }

  /** «Сохранить»: проверка → .bak → project.json → удаление рабочей копии → автоматическая контрольная версия. */
  async saveProject(input: ProjectDoc): Promise<{ savedAt: string; revision: number }> {
    return this.serial(async () => {
      const doc = this.validateForWrite(input);
      const dir = this.projectDir(doc.id);
      if (!(await exists(path.join(dir, 'project.json')))) {
        throw new AppError('not-found', 'Проект удалён или перемещён — сохраните его через «Сохранить как»');
      }
      const file = path.join(dir, 'project.json');
      await fs.copyFile(file, `${file}.bak`).catch(() => undefined);
      await writeJsonAtomic(file, doc);
      await fs.rm(path.join(dir, 'autosave.json'), { force: true });
      await this.writeCheckpoint(doc, `Сохранение (ревизия ${doc.revision})`, 'on-save');
      await this.pruneAutoCheckpoints(doc.id);
      await this.journal('project-save', { projectId: doc.id, revision: doc.revision });
      return { savedAt: new Date().toISOString(), revision: doc.revision };
    });
  }

  async autosave(input: ProjectDoc): Promise<{ autosavedAt: string }> {
    return this.serial(async () => {
      const doc = this.validateForWrite(input);
      const dir = this.projectDir(doc.id);
      if (!(await exists(path.join(dir, 'project.json')))) throw new AppError('not-found', 'Проект удалён — автосохранение невозможно');
      const autosavedAt = new Date().toISOString();
      await writeJsonAtomic(path.join(dir, 'autosave.json'), { autosavedAt, doc });
      return { autosavedAt };
    });
  }

  async discardRecovery(id: string): Promise<void> {
    return this.serial(async () => {
      await fs.rm(path.join(this.projectDir(id), 'autosave.json'), { force: true });
      await this.journal('recovery-discard', { projectId: id });
    });
  }

  /** Переименование проекта из списка (сохранённая версия и рабочая копия, если есть). */
  async renameProject(id: string, name: string): Promise<ProjectSummary> {
    return this.serial(async () => {
      const n = normalizeName(name);
      const doc = await this.readSaved(id);
      if (doc.name !== n) {
        const renamed = logChange({ ...doc, name: n, revision: doc.revision + 1, updatedAt: new Date().toISOString() }, 'rename', `Переименован: «${doc.name}» → «${n}»`);
        await writeJsonAtomic(path.join(this.projectDir(id), 'project.json'), renamed);
        const opened = await this.openProject(id);
        if (opened.recovery) {
          await writeJsonAtomic(path.join(this.projectDir(id), 'autosave.json'), {
            autosavedAt: opened.recovery.autosavedAt,
            doc: { ...opened.recovery.doc, name: n },
          });
        }
        await this.journal('project-rename', { projectId: id, from: doc.name, to: n });
      }
      return this.summarize(id);
    });
  }

  /** Дублирование сохранённой версии проекта: новая копия с новыми UUID. */
  async duplicateProject(id: string, newName?: string): Promise<ProjectDoc> {
    const source = await this.readSaved(id);
    const attachments = await this.readAttachments(source);
    return this.saveAsInternal(source, attachments, newName ?? `${source.name} (копия)`, 'duplicate');
  }

  /** «Сохранить как»: текущее состояние редактора — в новый проект с новым именем. */
  async saveAs(doc: ProjectDoc, newName: string): Promise<ProjectDoc> {
    const valid = this.validateForWrite(doc);
    const attachments = await this.readAttachments(valid);
    return this.saveAsInternal(valid, attachments, newName, 'save-as');
  }

  private async saveAsInternal(source: ProjectDoc, attachments: Map<string, Buffer>, newName: string, action: string): Promise<ProjectDoc> {
    return this.serial(async () => {
      const { docs: [copied], map } = remapDocs([source]);
      const now = new Date().toISOString();
      let doc: ProjectDoc = { ...copied!, name: normalizeName(newName), createdAt: now, updatedAt: now };
      doc = logChange(doc, action, `Создан как копия проекта «${source.name}»`);
      const remappedAttachments = new Map<string, Buffer>();
      for (const [oldId, data] of attachments) remappedAttachments.set(map.get(oldId) ?? oldId, data);
      await this.writeNewProject({ doc, checkpoints: [], attachments: remappedAttachments });
      await this.journal(`project-${action}`, { from: source.id, projectId: doc.id, name: doc.name });
      return doc;
    });
  }

  /** Удаление — перенос в корзину, не стирание. */
  async deleteProject(id: string): Promise<{ trashedTo: string }> {
    return this.serial(async () => {
      const dir = this.projectDir(id);
      if (!(await exists(dir))) throw new AppError('not-found', 'Проект не найден');
      const target = path.join(this.trashDir, `${id}-${timestampForFile()}`);
      await fs.rename(dir, target);
      await this.journal('project-delete', { projectId: id, trashedTo: path.relative(this.root, target) });
      return { trashedTo: target };
    });
  }

  // ---------- Личный каталог деталей ----------

  get catalogFile() { return path.join(this.libraryDir, 'catalog.json'); }

  /** Чтение личного каталога. Повреждённый файл не перезаписывается — пользователь получает ошибку. */
  async readCatalog(): Promise<CatalogFile> {
    if (!(await exists(this.catalogFile))) return emptyCatalog();
    let raw: unknown;
    try {
      raw = await readJson(this.catalogFile);
    } catch (e) {
      throw new AppError('catalog-invalid', `Файл личного каталога повреждён и не изменён: ${(e as Error).message}. Восстановите его из резервной копии или library/catalog.json.bak.`);
    }
    const r = loadCatalog(raw);
    if (!r.ok) throw new AppError('catalog-invalid', `${r.message}. Файл ${this.catalogFile} не изменён; восстановите его из резервной копии или library/catalog.json.bak.`, r.details);
    return r.catalog;
  }

  private async writeCatalog(cat: CatalogFile): Promise<void> {
    const issues = checkLibrary(cat);
    if (issues.length) throw new AppError('catalog-integrity', 'Запись каталога отменена: нарушена целостность', issues.slice(0, 10).map((i) => i.message));
    await fs.copyFile(this.catalogFile, `${this.catalogFile}.bak`).catch(() => undefined);
    await writeJsonAtomic(this.catalogFile, cat);
  }

  /** Сохранить деталь в личный каталог (новую или изменённую). Ошибки проверок не дают сохранить. */
  async saveCatalogPart(bundle: PartBundle, builtinParts: PartBundle[] = []): Promise<PartBundle> {
    return this.serial(async () => {
      const cat = await this.readCatalog();
      const errors = lintBundle(bundle, cat.parts, builtinParts.map((b) => b.part)).filter((l) => l.severity === 'error');
      if (errors.length) throw new AppError('part-invalid', 'Деталь не сохранена: есть ошибки', errors.map((e) => e.message));
      const b: PartBundle = { ...bundle, part: { ...bundle.part, origin: { ...bundle.part.origin, catalogPartId: bundle.part.id } } };
      await this.writeCatalog(upsertBundle(cat, b));
      await this.journal('catalog-save', { partId: b.part.id, name: b.part.name });
      return b;
    });
  }

  async deleteCatalogPart(partId: string): Promise<void> {
    return this.serial(async () => {
      const cat = await this.readCatalog();
      if (!cat.parts.some((p) => p.id === partId)) throw new AppError('not-found', 'Детали нет в личном каталоге');
      await this.writeCatalog(removePart(cat, partId));
      await this.journal('catalog-delete', { partId });
    });
  }

  /**
   * Добавить в личный каталог деталь из проекта (например, полученного с другого ПК). Создаётся новая
   * запись каталога с новыми id; проект не меняется.
   */
  async addProjectPartToCatalog(doc: ProjectDoc, projectPartId: string, builtinParts: PartBundle[] = []): Promise<PartBundle> {
    const src = bundleOf(doc.library, projectPartId);
    if (!src) throw new AppError('not-found', 'Деталь не найдена в проекте');
    const pkgIds = new Map(src.packages.map((p) => [p.id, newId()]));
    const partId = newId();
    const b: PartBundle = {
      part: {
        ...structuredClone(src.part), id: partId, symbolId: newId(), modelId: src.model ? newId() : null,
        packages: src.part.packages.map((p) => ({ packageId: pkgIds.get(p.packageId)!, pinMap: structuredClone(p.pinMap) })),
        origin: { ...src.part.origin, catalogPartId: partId, notes: [src.part.origin.notes, `Добавлена из проекта «${doc.name}».`].filter(Boolean).join(' ') },
      },
      symbol: { ...structuredClone(src.symbol), id: '' },
      packages: src.packages.map((p) => ({ ...structuredClone(p), id: pkgIds.get(p.id)! })),
      model: src.model ? { ...structuredClone(src.model), id: '' } : null,
    };
    b.symbol.id = b.part.symbolId;
    if (b.model) b.model.id = b.part.modelId!;
    return this.saveCatalogPart(b, builtinParts);
  }

  // ---------- Контрольные версии ----------

  async listCheckpoints(id: string): Promise<CheckpointInfo[]> {
    return (await this.readCheckpoints(id)).map(({ doc: _doc, ...info }) => info).reverse();
  }

  async createCheckpoint(input: ProjectDoc, label: string, kind: Checkpoint['kind'] = 'manual'): Promise<CheckpointInfo> {
    return this.serial(async () => {
      const doc = this.validateForWrite(input);
      if (!(await exists(path.join(this.projectDir(doc.id), 'project.json')))) throw new AppError('not-found', 'Проект не найден');
      const cp = await this.writeCheckpoint(doc, label.trim().slice(0, 200) || 'Контрольная версия', kind);
      await this.journal('checkpoint-create', { projectId: doc.id, checkpointId: cp.id, kind });
      const { doc: _d, ...info } = cp;
      return info;
    });
  }

  async readCheckpoint(projectId: string, checkpointId: string): Promise<Checkpoint> {
    const cp = (await this.readCheckpoints(projectId)).find((c) => c.id === checkpointId);
    if (!cp) throw new AppError('not-found', 'Контрольная версия не найдена');
    return cp;
  }

  private async writeCheckpoint(doc: ProjectDoc, label: string, kind: Checkpoint['kind']): Promise<Checkpoint> {
    const cp: Checkpoint = { id: newId(), label, kind, createdAt: new Date().toISOString(), revision: doc.revision, doc };
    await writeJsonAtomic(path.join(this.projectDir(doc.id), 'checkpoints', `${cp.id}.json`), cp);
    return cp;
  }

  private async readCheckpoints(id: string): Promise<Checkpoint[]> {
    const dir = path.join(this.projectDir(id), 'checkpoints');
    if (!(await exists(dir))) return [];
    const out: Checkpoint[] = [];
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = CheckpointSchema.parse(await readJson(path.join(dir, f)));
        const loaded = loadDocument(raw.doc);
        if (loaded.ok) out.push({ ...raw, doc: loaded.doc });
      } catch {
        /* повреждённая контрольная версия пропускается, остальные доступны */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private async pruneAutoCheckpoints(id: string): Promise<void> {
    const auto = (await this.readCheckpoints(id)).filter((c) => c.kind === 'on-save');
    for (const cp of auto.slice(0, Math.max(0, auto.length - AUTO_CHECKPOINTS_KEPT))) {
      await fs.rm(path.join(this.projectDir(id), 'checkpoints', `${cp.id}.json`), { force: true });
    }
  }

  // ---------- Экспорт / импорт .elab ----------

  /** Экспорт текущего состояния редактора вместе с контрольными версиями и вложениями. */
  async exportProject(input: ProjectDoc): Promise<Buffer> {
    const doc = this.validateForWrite(input);
    const checkpoints = await this.readCheckpoints(doc.id).catch(() => []);
    const attachments = await this.readAttachments(doc);
    const buf = await writeElab({ doc, checkpoints, attachments });
    await this.journal('project-export', { projectId: doc.id, bytes: buf.length });
    return buf;
  }

  async previewImport(buf: Buffer): Promise<ImportPreview> {
    const read = await readElab(buf);
    const existing = (await exists(path.join(this.projectDir(read.doc.id), 'project.json'))) ? await this.summarize(read.doc.id) : null;
    return { read, existing };
  }

  async importProject(read: ElabReadResult, mode: ImportMode): Promise<ProjectDoc> {
    return this.serial(async () => {
      const id = read.doc.id;
      const existsAlready = await exists(this.projectDir(id));
      if (mode === 'new' && existsAlready) throw new AppError('conflict', 'Проект с таким ID уже есть — выберите «Заменить» или «Как копию»');
      let bundle: ProjectBundle = { doc: read.doc, checkpoints: read.checkpoints, attachments: read.attachments };
      if (mode === 'copy') {
        const { docs, map } = remapDocs([read.doc, ...read.checkpoints.map((c) => c.doc)]);
        const [doc, ...cpDocs] = docs;
        const attachments = new Map<string, Buffer>();
        for (const [oldId, data] of read.attachments) attachments.set(map.get(oldId) ?? oldId, data);
        bundle = {
          doc: logChange({ ...doc!, name: normalizeName(`${read.doc.name} (импорт)`) }, 'import-copy', 'Импортирован как копия'),
          checkpoints: read.checkpoints.map((c, i) => ({ ...c, id: newId(), doc: cpDocs[i]! })),
          attachments,
        };
      } else {
        bundle = { ...bundle, doc: logChange(bundle.doc, 'import', 'Импортирован из файла .elab') };
      }
      if (mode === 'replace' && existsAlready) {
        await fs.rename(this.projectDir(id), path.join(this.trashDir, `${id}-${timestampForFile()}-replaced`));
      }
      await this.writeNewProject(bundle);
      await this.journal('project-import', { projectId: bundle.doc.id, mode, migratedFrom: read.migratedFrom });
      return bundle.doc;
    });
  }

  /** Записывает проект во временную папку и атомарно переносит на место. */
  private async writeNewProject(bundle: ProjectBundle): Promise<void> {
    const doc = this.validateForWrite(bundle.doc);
    const finalDir = this.projectDir(doc.id);
    if (await exists(finalDir)) throw new AppError('conflict', 'Проект с таким ID уже существует');
    const staging = path.join(this.projectsDir, `.incoming-${doc.id}-${Date.now()}`);
    await ensureDir(staging);
    try {
      await writeJsonAtomic(path.join(staging, 'project.json'), doc);
      for (const cp of bundle.checkpoints) await writeJsonAtomic(path.join(staging, 'checkpoints', `${cp.id}.json`), cp);
      for (const ref of doc.attachments) {
        const data = bundle.attachments.get(ref.id);
        if (!data) throw new AppError('missing-attachment', `Нет данных вложения «${ref.fileName}»`);
        await writeFileAtomic(path.join(staging, attachmentPath(ref.id, ref.fileName)), data);
      }
      await fs.rename(staging, finalDir);
    } catch (e) {
      await fs.rm(staging, { recursive: true, force: true });
      throw e;
    }
  }

  private async readAttachments(doc: ProjectDoc): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    for (const ref of doc.attachments) {
      const file = path.join(this.projectDir(doc.id), attachmentPath(ref.id, ref.fileName));
      try {
        out.set(ref.id, await fs.readFile(file));
      } catch {
        throw new AppError('missing-attachment', `Не найден файл вложения «${ref.fileName}»`);
      }
    }
    return out;
  }

  // ---------- Проверка перед записью ----------

  private validateForWrite(doc: ProjectDoc): ProjectDoc {
    const loaded = loadDocument(doc);
    if (!loaded.ok) throw new AppError(`invalid-${loaded.error.code}`, `Запись отменена: ${describeLoadError(loaded.error)}`);
    if (loaded.migratedFrom !== null) throw new AppError('stale-version', 'Запись отменена: документ в устаревшем формате');
    return loaded.doc;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Если восстановление из бэкапа было прервано (сбой питания во время замены папок),
 * возвращает папку данных в согласованное состояние. Возвращает описание действия или null.
 */
export async function recoverInterruptedRestore(root: string): Promise<string | null> {
  let entries: string[] = [];
  try { entries = await fs.readdir(root); } catch { return null; }
  const old = entries.filter((e) => e.startsWith('.restore-old-'));
  const staging = entries.filter((e) => e.startsWith('.restore-staging-'));
  let action: string | null = null;
  for (const o of old) {
    const oldDir = path.join(root, o);
    const marker = path.join(oldDir, 'swap-complete');
    if (await exists(marker)) {
      await fs.rm(oldDir, { recursive: true, force: true });
      action = 'Завершено прерванное восстановление из резервной копии';
    } else {
      // Замена не завершена: возвращаем прежние данные на место.
      for (const name of await fs.readdir(oldDir)) {
        const target = path.join(root, name);
        await fs.rm(target, { recursive: true, force: true });
        await fs.rename(path.join(oldDir, name), target);
      }
      await fs.rm(oldDir, { recursive: true, force: true });
      action = 'Прерванное восстановление из резервной копии отменено, прежние данные возвращены';
    }
  }
  for (const s of staging) await fs.rm(path.join(root, s), { recursive: true, force: true });
  return action;
}
