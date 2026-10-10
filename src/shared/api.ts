/** Контракт IPC между окном и главным процессом (window.elab). Только типы. */
import type { CheckpointInfo, ProjectDoc } from '../core/model';
import type { Result } from '../core/result';
import type { ProjectSummary } from '../storage/store';
import type { SimResult } from '../sim/results';
import type { PartBundle } from '../core/catalog';

export type { ProjectSummary, SimResult, PartBundle };

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
  };
}

export const IPC = {
  appInfo: 'app:info',
  setDirty: 'app:set-dirty',
  closeConfirmed: 'app:close-confirmed',
  closeRequest: 'app:close-request',
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
} as const;
