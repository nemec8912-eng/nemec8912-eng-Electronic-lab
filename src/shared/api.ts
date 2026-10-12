/** Контракт IPC между окном и главным процессом (window.elab). Только типы. */
import type { AttachmentRef, CheckpointInfo, ProjectDoc, TestRecord } from '../core/model';
import type { ExpectedOutcome } from '../sim/expected';
import type { Result } from '../core/result';
import type { ProjectSummary } from '../storage/store';
import type { SimResult } from '../sim/results';
import type { MeasureRequest, MeasureResult } from '../sim/meters';
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
    /** Примеры проектов, поставляемые с программой. */
    examples(): Promise<Result<Array<{ file: string; name: string; description: string }>>>;
    /** Открыть пример: в папку данных записывается его копия (новые UUID), пример не меняется. */
    openExample(file: string): Promise<Result<ProjectDoc>>;
  };
  checkpoints: {
    list(projectId: string): Promise<Result<CheckpointInfo[]>>;
    /** kind 'test' — снимок ревизии для записи журнала испытаний (не удаляется автоматически). */
    create(doc: ProjectDoc, label: string, kind?: 'manual' | 'test'): Promise<Result<CheckpointInfo>>;
    /** Документ контрольной версии (для сравнения ревизий и расчёта по ревизии испытания). */
    get(projectId: string, checkpointId: string): Promise<Result<ProjectDoc>>;
    /**
     * Возвращает документ контрольной версии (схема, детали, плата) с текущим журналом испытаний и
     * вложениями; перед этим сохраняет текущее состояние как контрольную версию.
     */
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
    /** Расчёт текущего состояния документа: рабочая точка и выбранный анализ (по умолчанию — из настроек проекта). */
    run(doc: ProjectDoc, opts: { analysis?: 'op' | 'tran' | 'dc' | 'ac' }): Promise<Result<SimResult>>;
    /** Измерение прибором со своим тестовым сигналом (Ω, прозвонка, диод, ESR); питание схемы отключается. */
    measure(doc: ProjectDoc, req: MeasureRequest): Promise<Result<MeasureResult>>;
    /** Расчётные значения и разброс по допускам для измерений записи журнала (doc — ревизия испытания). */
    expected(doc: ProjectDoc, record: TestRecord): Promise<Result<ExpectedOutcome>>;
  };
  attachments: {
    /** Выбрать фото на компьютере и скопировать их в папку проекта. null — выбор отменён. */
    add(projectId: string): Promise<Result<AttachmentRef[] | null>>;
    /** Содержимое вложения как data: URL (для показа фото). */
    read(projectId: string, ref: AttachmentRef): Promise<Result<string>>;
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
    /** Архив Gerber/Excellon (.zip) через диалог выбора файла. Имена файлов — латиница, цифры, «-_.». */
    saveGerber(defaultName: string, files: Array<{ name: string; content: string }>): Promise<Result<{ path: string; bytes: number; files: number } | null>>;
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
  cpGet: 'checkpoints:get',
  examples: 'projects:examples',
  openExample: 'projects:open-example',
  simExpected: 'sim:expected',
  attAdd: 'attachments:add',
  attRead: 'attachments:read',
  exportProject: 'files:export-project',
  importProject: 'files:import-project',
  resolveImport: 'files:resolve-import',
  backupAll: 'files:backup-all',
  restoreBackup: 'files:restore-backup',
  simRun: 'sim:run',
  simMeasure: 'sim:measure',
  catList: 'catalog:list',
  catSave: 'catalog:save',
  catRemove: 'catalog:remove',
  catFromProject: 'catalog:from-project',
  saveSvg: 'files:save-svg',
  saveDrawing: 'files:save-drawing',
  savePdf: 'files:save-pdf',
  print: 'files:print',
  saveGerber: 'files:save-gerber',
  kicadOpenOnline: 'kicad:open-online',
  kicadOpenFile: 'kicad:open-file',
  kicadBuild: 'kicad:build',
  kicadDescribe: 'kicad:describe',
} as const;
