/** Контракт IPC между окном и главным процессом (window.elab). Только типы. */
import type { CheckpointInfo, ProjectDoc } from '../core/model';
import type { Result } from '../core/result';
import type { ProjectSummary } from '../storage/store';
import type { SimResult } from '../sim/results';
import type { PartBundle } from '../core/catalog';
import type { SymbolSummary } from '../catalog-import/kicad';

export type { ProjectSummary, SimResult, PartBundle, SymbolSummary };

export interface KicadLibraryDto { token: string; library: string; origin: string; online: boolean; symbols: SymbolSummary[] }
export interface KicadPreviewDto { bundle: PartBundle; warnings: string[] }

export interface AppInfo {
  version: string;
  dataRoot: string;
  portable: boolean;
  crashedLastSession: boolean;
  restoreRecovered: string | null;
  platform: string;
  /** Найденный ngspice (путь) или null — расчёт недоступен. */
  ngspice: string | null;
}

export interface OpenedProjectDto {
  doc: ProjectDoc;
  recovery: { doc: ProjectDoc; autosavedAt: string } | null;
  recoveryError: string | null;
}

export type ImportOutcome =
  | { status: 'imported'; doc: ProjectDoc; warnings: string[]; migratedFrom: number | null }
  | {
      status: 'conflict';
      token: string;
      existing: { id: string; name: string; updatedAt: string };
      incoming: { name: string; updatedAt: string };
      warnings: string[];
    };

/** null в значении означает: пользователь отменил выбор файла. */
export interface ElabApi {
  app: {
    info(): Promise<Result<AppInfo>>;
    setDirty(dirty: boolean): Promise<Result<void>>;
    /** Подтверждение, что окно можно закрыть (после «Сохранить»/«Не сохранять»). */
    closeConfirmed(): Promise<Result<void>>;
    onCloseRequest(cb: (choice: 'save' | 'discard') => void): () => void;
    /** Открыть ссылку (даташит) в браузере системы — только по нажатию пользователя, только http/https. */
    openExternal(url: string): Promise<Result<void>>;
  };
  projects: {
    list(): Promise<Result<ProjectSummary[]>>;
    create(name: string): Promise<Result<ProjectDoc>>;
    open(id: string): Promise<Result<OpenedProjectDto>>;
    save(doc: ProjectDoc): Promise<Result<{ savedAt: string; revision: number }>>;
    autosave(doc: ProjectDoc): Promise<Result<{ autosavedAt: string }>>;
    discardRecovery(id: string): Promise<Result<void>>;
    rename(id: string, name: string): Promise<Result<ProjectSummary>>;
    duplicate(id: string, name?: string): Promise<Result<ProjectDoc>>;
    saveAs(doc: ProjectDoc, name: string): Promise<Result<ProjectDoc>>;
    remove(id: string): Promise<Result<void>>;
  };
  checkpoints: {
    list(projectId: string): Promise<Result<CheckpointInfo[]>>;
    create(doc: ProjectDoc, label: string): Promise<Result<CheckpointInfo>>;
    /** Возвращает документ контрольной версии; перед этим сохраняет текущее состояние как контрольную версию. */
    restore(current: ProjectDoc, checkpointId: string): Promise<Result<ProjectDoc>>;
  };
  catalog: {
    /** Личный каталог (встроенный справочник окно берёт из src/catalog/builtin). */
    list(): Promise<Result<PartBundle[]>>;
    save(bundle: PartBundle): Promise<Result<PartBundle>>;
    remove(partId: string): Promise<Result<void>>;
    /** Добавить деталь из библиотеки проекта в личный каталог (новая запись). */
    fromProject(doc: ProjectDoc, projectPartId: string): Promise<Result<PartBundle>>;
  };
  /** Импорт деталей из библиотек KiCad. Сеть — только в openOnline/build с online-ссылками, по нажатию пользователя. */
  kicad: {
    openOnline(library: string): Promise<Result<KicadLibraryDto>>;
    openFile(): Promise<Result<KicadLibraryDto | null>>;
    /** Сведения о символе (для библиотек-папок KiCad 9 загружаются при выборе). */
    describe(token: string, symbol: string): Promise<Result<SymbolSummary>>;
    /** Построить деталь для проверки; files = true — выбрать файлы .kicad_mod на компьютере. null — выбор файлов отменён. */
    build(token: string, symbol: string, footprints: { online: string[]; files: boolean }): Promise<Result<KicadPreviewDto | null>>;
  };
  sim: {
    /** Расчёт текущего состояния документа (рабочая точка и переходный процесс). */
    run(doc: ProjectDoc, opts: { tran: boolean }): Promise<Result<SimResult>>;
  };
  files: {
    exportProject(doc: ProjectDoc): Promise<Result<{ path: string; bytes: number } | null>>;
    importProject(): Promise<Result<ImportOutcome | null>>;
    resolveImport(token: string, mode: 'replace' | 'copy' | 'cancel'): Promise<Result<ProjectDoc | null>>;
    backupAll(): Promise<Result<{ path: string; projects: number; bytes: number } | null>>;
    restoreBackup(): Promise<Result<{ projects: number; safetyBackup: string | null } | null>>;
    /** Сохранить SVG (печать платы 1:1) через диалог выбора файла. */
    saveSvg(defaultName: string, svg: string): Promise<Result<{ path: string } | null>>;
    /** Сохранить чертёж или текст: svg/txt — строка, png — байты. */
    saveDrawing(defaultName: string, kind: 'svg' | 'png' | 'txt', data: string | Uint8Array): Promise<Result<{ path: string; bytes: number } | null>>;
    /** Лист SVG → PDF заданного размера (мм) через движок печати Chromium. */
    savePdf(defaultName: string, svg: string, widthMm: number, heightMm: number): Promise<Result<{ path: string; bytes: number } | null>>;
    /** Печать листа через системный диалог печати. */
    print(svg: string, widthMm: number, heightMm: number): Promise<Result<{ printed: boolean; reason: string | null }>>;
  };
}

export const IPC = {
  appInfo: 'app:info',
  setDirty: 'app:set-dirty',
  closeConfirmed: 'app:close-confirmed',
  closeRequest: 'app:close-request',
  openExternal: 'app:open-external',
  list: 'projects:list',
  create: 'projects:create',
  open: 'projects:open',
  save: 'projects:save',
  autosave: 'projects:autosave',
  discardRecovery: 'projects:discard-recovery',
  rename: 'projects:rename',
  duplicate: 'projects:duplicate',
  saveAs: 'projects:save-as',
  remove: 'projects:remove',
  cpList: 'checkpoints:list',
  cpCreate: 'checkpoints:create',
  cpRestore: 'checkpoints:restore',
  exportProject: 'files:export-project',
  importProject: 'files:import-project',
  resolveImport: 'files:resolve-import',
  backupAll: 'files:backup-all',
  restoreBackup: 'files:restore-backup',
  simRun: 'sim:run',
  catList: 'catalog:list',
  catSave: 'catalog:save',
  catRemove: 'catalog:remove',
  catFromProject: 'catalog:from-project',
  saveSvg: 'files:save-svg',
  saveDrawing: 'files:save-drawing',
  savePdf: 'files:save-pdf',
  print: 'files:print',
  kicadOpenOnline: 'kicad:open-online',
  kicadOpenFile: 'kicad:open-file',
  kicadBuild: 'kicad:build',
  kicadDescribe: 'kicad:describe',
} as const;
