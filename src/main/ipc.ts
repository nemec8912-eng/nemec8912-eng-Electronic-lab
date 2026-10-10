/** Обработчики IPC: тонкий слой между окном и хранилищем, плюс системные диалоги выбора файлов. */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { APP_VERSION } from '../core/appinfo';
import { newId } from '../core/ids';
import type { ProjectDoc } from '../core/model';
import { AppError, fail, ok, type Result } from '../core/result';
import { IPC, type AppInfo, type ImportOutcome } from '../shared/api';
import { createBackup, restoreBackup, verifyBackup } from '../storage/backup';
import type { ElabReadResult } from '../storage/elab';
import { safeFileName, timestampForFile, writeFileAtomic } from '../storage/fsutil';
import { DataStore } from '../storage/store';
import { simulate } from '../sim/simulate';
import { locateNgspice } from '../sim/runner';
import { app } from 'electron';

export interface MainContext {
  getStore(): DataStore;
  reopenStore(): Promise<void>;
  getWindow(): BrowserWindow | null;
  portable: boolean;
  setDirty(dirty: boolean): void;
  confirmClose(): void;
}

function wrap<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  return async (_e: unknown, ...args: A): Promise<Result<T>> => {
    try {
      return ok(await fn(...args));
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: e.toShape() };
      console.error(e);
      return fail('internal', `Внутренняя ошибка: ${(e as Error)?.message ?? String(e)}`);
    }
  };
}

const ELAB_FILTER = { name: 'Проект «Электронной лаборатории»', extensions: ['elab'] };
const BACKUP_FILTER = { name: 'Резервная копия «Электронной лаборатории»', extensions: ['elabbak'] };
const SVG_FILTER = { name: 'Рисунок SVG', extensions: ['svg'] };

function findNgspice(): string | null {
  return locateNgspice({ env: process.env.ELAB_NGSPICE, resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath, appRoot: app.getAppPath() });
}

export function registerIpc(ctx: MainContext): void {
  const pendingImports = new Map<string, ElabReadResult>();
  const store = () => ctx.getStore();
  const win = () => ctx.getWindow() ?? undefined;
  let lastDir: string | undefined;

  const askSavePath = async (title: string, defaultName: string, filter: { name: string; extensions: string[] }) => {
    const r = await dialog.showSaveDialog(win()!, { title, defaultPath: path.join(lastDir ?? '', defaultName), filters: [filter] });
    if (r.canceled || !r.filePath) return null;
    let p = r.filePath;
    if (!p.toLowerCase().endsWith(`.${filter.extensions[0]}`)) p += `.${filter.extensions[0]}`;
    lastDir = path.dirname(p);
    return p;
  };
  const askOpenPath = async (title: string, filter: { name: string; extensions: string[] }) => {
    const r = await dialog.showOpenDialog(win()!, { title, defaultPath: lastDir, properties: ['openFile'], filters: [filter, { name: 'Все файлы', extensions: ['*'] }] });
    const p = r.canceled ? undefined : r.filePaths[0];
    if (!p) return null;
    lastDir = path.dirname(p);
    return p;
  };
  const readFileChecked = async (p: string) => {
    try {
      return await fs.readFile(p);
    } catch (e) {
      throw new AppError('read-failed', `Не удалось прочитать файл: ${(e as Error).message}`);
    }
  };
  const writeChecked = async (p: string, data: Buffer) => {
    try {
      await writeFileAtomic(p, data);
      const written = await fs.readFile(p);
      if (!written.equals(data)) throw new Error('записанный файл не совпадает с данными');
    } catch (e) {
      throw new AppError('write-failed', `Не удалось записать файл ${p}: ${(e as Error).message}. Проверьте, что носитель подключён и доступен для записи.`);
    }
  };

  ipcMain.handle(IPC.appInfo, wrap(async (): Promise<AppInfo> => ({
    version: APP_VERSION,
    dataRoot: store().root,
    portable: ctx.portable,
    crashedLastSession: store().crashedLastSession,
    restoreRecovered: store().restoreRecovered,
    platform: process.platform,
    ngspice: findNgspice(),
  })));

  ipcMain.handle(IPC.simRun, wrap((doc: ProjectDoc, opts: { tran: boolean }) => simulate(doc, findNgspice(), { tran: Boolean(opts?.tran) })));
  ipcMain.handle(IPC.setDirty, wrap(async (dirty: boolean) => { ctx.setDirty(Boolean(dirty)); }));
  ipcMain.handle(IPC.closeConfirmed, wrap(async () => { ctx.confirmClose(); }));

  ipcMain.handle(IPC.list, wrap(() => store().listProjects()));
  ipcMain.handle(IPC.create, wrap((name: string) => store().createProject(String(name ?? ''))));
  ipcMain.handle(IPC.open, wrap((id: string) => store().openProject(id)));
  ipcMain.handle(IPC.save, wrap((doc: ProjectDoc) => store().saveProject(doc)));
  ipcMain.handle(IPC.autosave, wrap((doc: ProjectDoc) => store().autosave(doc)));
  ipcMain.handle(IPC.discardRecovery, wrap((id: string) => store().discardRecovery(id)));
  ipcMain.handle(IPC.rename, wrap((id: string, name: string) => store().renameProject(id, String(name ?? ''))));
  ipcMain.handle(IPC.duplicate, wrap((id: string, name?: string) => store().duplicateProject(id, name)));
  ipcMain.handle(IPC.saveAs, wrap((doc: ProjectDoc, name: string) => store().saveAs(doc, String(name ?? ''))));
  ipcMain.handle(IPC.remove, wrap(async (id: string) => { await store().deleteProject(id); }));

  ipcMain.handle(IPC.cpList, wrap((id: string) => store().listCheckpoints(id)));
  ipcMain.handle(IPC.cpCreate, wrap((doc: ProjectDoc, label: string) => store().createCheckpoint(doc, String(label ?? ''))));
  ipcMain.handle(IPC.cpRestore, wrap(async (current: ProjectDoc, checkpointId: string) => {
    const cp = await store().readCheckpoint(current.id, checkpointId);
    await store().createCheckpoint(current, `Перед возвратом к «${cp.label}»`, 'before-restore');
    return cp.doc;
  }));

  ipcMain.handle(IPC.exportProject, wrap(async (doc: ProjectDoc) => {
    const data = await store().exportProject(doc);
    const p = await askSavePath('Экспорт проекта', `${safeFileName(doc.name, 'проект')}.elab`, ELAB_FILTER);
    if (!p) return null;
    await writeChecked(p, data);
    return { path: p, bytes: data.length };
  }));

  ipcMain.handle(IPC.importProject, wrap(async (): Promise<ImportOutcome | null> => {
    const p = await askOpenPath('Импорт проекта', ELAB_FILTER);
    if (!p) return null;
    const preview = await store().previewImport(await readFileChecked(p));
    if (!preview.existing) {
      const doc = await store().importProject(preview.read, 'new');
      return { status: 'imported', doc, warnings: preview.read.warnings, migratedFrom: preview.read.migratedFrom };
    }
    const token = newId();
    pendingImports.set(token, preview.read);
    return {
      status: 'conflict',
      token,
      existing: { id: preview.existing.id, name: preview.existing.name, updatedAt: preview.existing.updatedAt },
      incoming: { name: preview.read.doc.name, updatedAt: preview.read.doc.updatedAt },
      warnings: preview.read.warnings,
    };
  }));

  ipcMain.handle(IPC.resolveImport, wrap(async (token: string, mode: 'replace' | 'copy' | 'cancel') => {
    const read = pendingImports.get(token);
    pendingImports.delete(token);
    if (!read || mode === 'cancel') return null;
    return store().importProject(read, mode === 'replace' ? 'replace' : 'copy');
  }));

  ipcMain.handle(IPC.backupAll, wrap(async () => {
    const { buffer, manifest } = await createBackup(store());
    const p = await askSavePath('Резервная копия всего', `Электронная лаборатория — резервная копия ${timestampForFile()}.elabbak`, BACKUP_FILTER);
    if (!p) return null;
    await writeChecked(p, buffer);
    return { path: p, projects: manifest.projects.length, bytes: buffer.length };
  }));

  ipcMain.handle(IPC.saveSvg, wrap(async (name: string, svg: string) => {
    if (typeof svg !== 'string' || !svg.startsWith('<?xml')) throw new AppError('bad-svg', 'Нечего сохранять');
    const p = await askSavePath('Сохранить рисунок платы', `${safeFileName(String(name ?? 'плата'), 'плата')}.svg`, SVG_FILTER);
    if (!p) return null;
    await writeChecked(p, Buffer.from(svg, 'utf8'));
    return { path: p };
  }));

  ipcMain.handle(IPC.restoreBackup, wrap(async () => {
    const p = await askOpenPath('Восстановить резервную копию', BACKUP_FILTER);
    if (!p) return null;
    const verified = await verifyBackup(await readFileChecked(p));
    const m = verified.manifest;
    const answer = await dialog.showMessageBox(win()!, {
      type: 'warning',
      title: 'Восстановить резервную копию',
      message: `Заменить все текущие данные содержимым резервной копии?`,
      detail: `Копия от ${new Date(m.createdAt).toLocaleString('ru-RU')}, проектов: ${m.projects.length}.\n` +
        `Перед заменой текущие данные будут автоматически сохранены в папку backups — восстановление можно отменить.`,
      buttons: ['Восстановить', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response !== 0) return null;
    const res = await restoreBackup(store(), verified);
    await ctx.reopenStore();
    return res;
  }));
}
