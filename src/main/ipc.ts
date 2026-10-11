/** Обработчики IPC: тонкий слой между окном и хранилищем, плюс системные диалоги выбора файлов. */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
import { builtinCatalog } from '../catalog/builtin';
import type { PartBundle } from '../core/catalog';
import { locateNgspice } from '../sim/runner';
import { kicadToBundle, KicadError, KICAD_LICENSE, summarize, type KicadFootprint } from '../catalog-import/kicad';
import { fetchOnlineFootprint, openLibraryFile, openOnlineLibrary, readFootprintFile, type OpenedLibrary } from '../catalog-import/source';
import type { KicadLibraryDto } from '../shared/api';
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

/**
 * Лист схемы в скрытом окне (файл во временной папке, без сети и скриптов) — для PDF и печати.
 * Размер страницы задаётся в мм через @page, поля нулевые: масштаб 1:1 сохраняется.
 */
async function renderSheet<T>(svg: string, w: number, h: number, act: (wc: any) => Promise<T>): Promise<T> {
  if (!svg.includes('<svg') || !(w > 0 && w <= 2000 && h > 0 && h <= 2000)) throw new AppError('bad-sheet', 'Нечего печатать');
  const dir = await fs.mkdtemp(path.join(app.getPath('temp'), 'elab-sheet-'));
  const file = path.join(dir, 'sheet.html');
  const body = svg.replace(/^<\?xml[^>]*>\s*/, '');
  await fs.writeFile(file, `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;padding:0;background:#fff}svg{display:block;width:${w}mm;height:${h}mm}</style></head><body>${body}</body></html>`, 'utf8');
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  try {
    await win.loadFile(file);
    return await act(win.webContents);
  } finally {
    win.destroy();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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

  ipcMain.handle(IPC.catList, wrap(async () => {
    const cat = await store().readCatalog();
    return cat.parts.map((p) => {
      const symbol = cat.symbols.find((s) => s.id === p.symbolId)!;
      const packages = p.packages.map((x) => cat.packages.find((k) => k.id === x.packageId)!).filter(Boolean);
      const model = p.modelId ? cat.models.find((m) => m.id === p.modelId) ?? null : null;
      return { part: p, symbol, packages, model } satisfies PartBundle;
    });
  }));
  ipcMain.handle(IPC.catSave, wrap((b: PartBundle) => store().saveCatalogPart(b, builtinCatalog())));
  ipcMain.handle(IPC.catRemove, wrap((id: string) => store().deleteCatalogPart(id)));
  ipcMain.handle(IPC.catFromProject, wrap((doc: ProjectDoc, id: string) => store().addProjectPartToCatalog(doc, id, builtinCatalog())));

  // --- Импорт из KiCad ---
  const kicadLibs = new Map<string, { lib: OpenedLibrary; online: boolean }>();
  const remember = (lib: OpenedLibrary, online: boolean): KicadLibraryDto => {
    const token = newId();
    kicadLibs.set(token, { lib, online });
    while (kicadLibs.size > 5) kicadLibs.delete(kicadLibs.keys().next().value!);
    return { token, library: lib.library, origin: lib.origin, online, symbols: lib.summaries };
  };
  ipcMain.handle(IPC.kicadOpenOnline, wrap(async (library: string) => remember(await openOnlineLibrary(String(library ?? '').trim()), true)));
  ipcMain.handle(IPC.kicadOpenFile, wrap(async () => {
    const p = await askOpenPath('Библиотека символов KiCad', { name: 'Символы KiCad', extensions: ['kicad_sym'] });
    return p ? remember(await openLibraryFile(p), false) : null;
  }));
  ipcMain.handle(IPC.kicadDescribe, wrap(async (token: string, symbolName: string) => {
    const opened = kicadLibs.get(String(token));
    if (!opened) throw new AppError('import-expired', 'Библиотека больше не открыта — откройте её снова');
    return summarize((await opened.lib.loadSymbol(String(symbolName))).symbol);
  }));
  ipcMain.handle(IPC.kicadBuild, wrap(async (token: string, symbolName: string, fps: { online: string[]; files: boolean }) => {
    const opened = kicadLibs.get(String(token));
    if (!opened) throw new AppError('import-expired', 'Библиотека больше не открыта — откройте её снова');
    const footprints: KicadFootprint[] = [];
    const sources: string[] = [];
    const { symbol, sources: symSources } = await opened.lib.loadSymbol(String(symbolName));
    sources.push(...symSources);
    for (const ref of (Array.isArray(fps?.online) ? fps.online : []).map(String).filter((x) => x.trim())) {
      const r = await fetchOnlineFootprint(ref);
      footprints.push(r.fp); sources.push(r.source);
    }
    if (fps?.files) {
      const r = await dialog.showOpenDialog(win()!, { title: 'Посадочные места KiCad', defaultPath: lastDir, properties: ['openFile', 'multiSelections'], filters: [{ name: 'Посадочные места KiCad', extensions: ['kicad_mod'] }] });
      if (r.canceled || !r.filePaths.length) return null;
      lastDir = path.dirname(r.filePaths[0]!);
      for (const f of r.filePaths) { const x = await readFootprintFile(f); footprints.push(x.fp); sources.push(x.source); }
    }
    const onlineFps = sources.some((x) => x.startsWith('https://')) && !opened.online;
    const license = opened.online ? KICAD_LICENSE : onlineFps ? `${KICAD_LICENSE} (посадочные места); символ — из файла пользователя` : null;
    try {
      return kicadToBundle({ symbol, library: opened.lib.library, footprints, sources, license });
    } catch (e) {
      if (e instanceof KicadError) throw new AppError('import-format', e.message);
      throw e;
    }
  }));
  ipcMain.handle(IPC.simRun, wrap((doc: ProjectDoc, opts: { tran: boolean }) => simulate(doc, findNgspice(), { tran: Boolean(opts?.tran) })));
  ipcMain.handle(IPC.setDirty, wrap(async (dirty: boolean) => { ctx.setDirty(Boolean(dirty)); }));
  ipcMain.handle(IPC.openExternal, wrap(async (url: string) => {
    const u = String(url ?? '');
    if (!/^https?:\/\/[^\s]+$/i.test(u) || u.length > 2000) throw new AppError('bad-url', 'Ссылка должна начинаться с http:// или https://');
    await shell.openExternal(u);
  }));
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

  const DRAW_FILTERS: Record<'svg' | 'png' | 'txt' | 'pdf', { name: string; extensions: string[] }> = {
    svg: { name: 'Рисунок SVG', extensions: ['svg'] },
    png: { name: 'Изображение PNG', extensions: ['png'] },
    txt: { name: 'Текст', extensions: ['txt'] },
    pdf: { name: 'Документ PDF', extensions: ['pdf'] },
  };
  ipcMain.handle(IPC.saveDrawing, wrap(async (name: string, kind: 'svg' | 'png' | 'txt', data: string | Uint8Array) => {
    const filter = DRAW_FILTERS[kind];
    if (!filter) throw new AppError('bad-kind', 'Неизвестный формат');
    const buf = typeof data === 'string' ? Buffer.from(kind === 'svg' && !data.startsWith('<?xml') ? `<?xml version="1.0" encoding="UTF-8"?>\n${data}` : data, 'utf8') : Buffer.from(data);
    if (!buf.length || buf.length > 200 * 1024 * 1024) throw new AppError('bad-data', 'Нечего сохранять');
    if (kind === 'png' && buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new AppError('bad-data', 'Повреждённое изображение');
    const p = await askSavePath('Сохранить', `${safeFileName(String(name ?? 'схема'), 'схема')}.${filter.extensions[0]}`, filter);
    if (!p) return null;
    await writeChecked(p, buf);
    return { path: p, bytes: buf.length };
  }));
  ipcMain.handle(IPC.savePdf, wrap(async (name: string, svg: string, w: number, h: number) => {
    const pdf: Uint8Array = await renderSheet(String(svg), Number(w), Number(h), (wc) => wc.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } }));
    const p = await askSavePath('Сохранить PDF', `${safeFileName(String(name ?? 'схема'), 'схема')}.pdf`, DRAW_FILTERS.pdf);
    if (!p) return null;
    await writeChecked(p, Buffer.from(pdf));
    return { path: p, bytes: pdf.length };
  }));
  ipcMain.handle(IPC.print, wrap(async (svg: string, w: number, h: number) => renderSheet(String(svg), Number(w), Number(h), (wc) =>
    new Promise<{ printed: boolean; reason: string | null }>((resolve) => {
      wc.print({ silent: false, printBackground: true, margins: { marginType: 'none' } }, (ok: boolean, reason: string) => resolve({ printed: ok, reason: ok ? null : reason || null }));
    }))));
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
