/** Главный компонент: начальный экран со списком проектов или рабочее место открытого проекта. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addAnnotation, removeAnnotation, renameProject, setDescription, updateAnnotation } from '../core/factory';
import { newId } from '../core/ids';
import { setProbe, setSimSettings, setTranSettings } from '../core/instruments';
import type { CheckpointInfo, ProjectDoc } from '../core/model';
import { addTrack, copperSvg, deleteTrack, movePlacement, rotatePlacement, setBoard, syncFromSchematic } from '../core/pcb';
import { deleteItems, kindOf, placeBundle, renameRefDes, renumber, rotateItems, setValue } from '../core/schematic';
import { runErc, type ErcIssue } from '../core/erc';
import { connectionListText } from '../core/netlist';
import type { AppInfo, ProjectSummary, SimResult } from '../shared/api';
import { BoardPanel } from './BoardPanel';
import { TestPanel } from './TestPanel';
import { circuitKey } from '../sim/key';
import { api, errorText, fmtBytes, fmtDateTime, fmtTime, unwrap } from './api';
import { useDialogs } from './Dialogs';
import { CatalogView } from './CatalogView';
import { CatalogPanel, PropertiesPanel } from './Panels';
import { useCatalog, type CatalogState } from './useCatalog';
import { ProjectList } from './ProjectList';
import { SchematicCanvas } from './SchematicCanvas';
import { ErcPanel, ExportDialog } from './SchematicTools';
import { useEditor, type Editor } from './useEditor';

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
type Opened = { doc: ProjectDoc; savedRevision: number; session: number };

export function App() {
  const dialogs = useDialogs();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalog = useCatalog();
  const sessionCounter = useRef(0);
  /** Рабочее место регистрирует сюда функцию «закрыть проект с вопросом о сохранении». */
  const closeCurrent = useRef<(() => Promise<boolean>) | null>(null);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 12000 : 6000);
  }, []);

  const showError = useCallback((title: string, e: unknown) => dialogs.alert(title, errorText(e)), [dialogs]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await unwrap(api().projects.list()));
    } catch (e) {
      await showError('Не удалось получить список проектов', e);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    (async () => {
      try {
        const i = await unwrap(api().app.info());
        setInfo(i);
        if (i.restoreRecovered) await dialogs.alert('Восстановление данных', i.restoreRecovered);
        if (i.crashedLastSession) toast('Предыдущий сеанс завершился аварийно. Проекты с несохранёнными изменениями отмечены в списке.', 'error');
      } catch (e) {
        await showError('Ошибка запуска', e);
      }
      await refresh();
    })();
  }, [dialogs, refresh, showError, toast]);

  const openProject = useCallback(async (id: string) => {
    try {
      const dto = await unwrap(api().projects.open(id));
      let doc = dto.doc;
      if (dto.recoveryError) {
        await dialogs.alert('Рабочая копия повреждена', `Несохранённые изменения прочитать не удалось, открыта сохранённая версия.\n${dto.recoveryError}`);
      }
      if (dto.recovery) {
        const answer = await dialogs.choose(
          'Найдены несохранённые изменения',
          `У проекта «${dto.doc.name}» есть несохранённые изменения от ${fmtDateTime(dto.recovery.autosavedAt)} ` +
            `(возможно, программа была закрыта аварийно).\n\nВосстановить их? Если отбросить, откроется последняя сохранённая версия.`,
          [
            { label: 'Отмена', value: 'cancel' },
            { label: 'Отбросить', value: 'discard', kind: 'danger' },
            { label: 'Восстановить', value: 'restore', kind: 'primary' },
          ],
        );
        if (answer === 'cancel') return;
        if (answer === 'restore') {
          doc = { ...dto.recovery.doc, revision: Math.max(dto.recovery.doc.revision, dto.doc.revision + 1) };
        } else {
          await unwrap(api().projects.discardRecovery(id));
        }
      }
      setOpened({ doc, savedRevision: dto.doc.revision, session: ++sessionCounter.current });
    } catch (e) {
      await showError('Не удалось открыть проект', e);
      await refresh();
    }
  }, [dialogs, refresh, showError]);

  const closeProject = useCallback(async () => {
    setOpened(null);
    closeCurrent.current = null;
    await refresh();
  }, [refresh]);

  /** Закрыть текущий проект (с вопросом о сохранении). false — пользователь отменил. */
  const ensureClosed = useCallback(async () => {
    if (closeCurrent.current) return closeCurrent.current();
    return true;
  }, []);

  const createProject = async (name: string) => {
    try {
      const doc = await unwrap(api().projects.create(name));
      setOpened({ doc, savedRevision: doc.revision, session: ++sessionCounter.current });
    } catch (e) {
      await showError('Не удалось создать проект', e);
    }
  };

  const fileActions: FileActions = {
    importProject: async () => {
      try {
        const r = await unwrap(api().files.importProject());
        if (!r) return;
        let doc: ProjectDoc | null = null;
        if (r.status === 'imported') {
          doc = r.doc;
        } else {
          const answer = await dialogs.choose(
            'Такой проект уже есть',
            `Проект «${r.existing.name}» (изменён ${fmtDateTime(r.existing.updatedAt)}) уже есть на этом компьютере.\n` +
              `В файле — «${r.incoming.name}» от ${fmtDateTime(r.incoming.updatedAt)}.\n\n` +
              `«Заменить» — текущий проект уйдёт в корзину. «Как копию» — появится второй проект с новыми идентификаторами.`,
            [
              { label: 'Отмена', value: 'cancel' },
              { label: 'Заменить', value: 'replace', kind: 'danger' },
              { label: 'Как копию', value: 'copy', kind: 'primary' },
            ],
          );
          if (answer === 'replace' && opened && opened.doc.id === r.existing.id) {
            if (!(await ensureClosed())) { await unwrap(api().files.resolveImport(r.token, 'cancel')); return; }
          }
          doc = await unwrap(api().files.resolveImport(r.token, answer as 'replace' | 'copy' | 'cancel'));
          if (!doc) return;
        }
        const warnings = r.warnings.length ? `\nПредупреждения:\n${r.warnings.join('\n')}` : '';
        const migrated = r.status === 'imported' && r.migratedFrom !== null ? `\nФайл был в старом формате (${r.migratedFrom}) и обновлён.` : '';
        await refresh();
        const go = await dialogs.choose('Проект импортирован', `«${doc.name}» добавлен в список проектов.${migrated}${warnings}`,
          [{ label: 'Позже', value: 'later' }, { label: 'Открыть', value: 'open', kind: 'primary' }]);
        if (go === 'open' && (await ensureClosed())) await openProject(doc.id);
      } catch (e) {
        await showError('Импорт не выполнен', e);
      }
    },
    backupAll: async (flush?: () => Promise<void>) => {
      try {
        await flush?.();
        const r = await unwrap(api().files.backupAll());
        if (r) toast(`Резервная копия сохранена: ${r.path} (проектов: ${r.projects}, ${fmtBytes(r.bytes)})`);
      } catch (e) {
        await showError('Резервная копия не создана', e);
      }
    },
    restoreBackup: async () => {
      if (!(await ensureClosed())) return;
      try {
        const r = await unwrap(api().files.restoreBackup());
        if (!r) return;
        await refresh();
        await dialogs.alert('Данные восстановлены', `Восстановлено проектов: ${r.projects}.` +
          (r.safetyBackup ? `\nПрежние данные сохранены в файл:\n${r.safetyBackup}` : ''));
      } catch (e) {
        await showError('Восстановление не выполнено', e);
      }
    },
  };

  const listActions = {
    rename: async (p: ProjectSummary) => {
      const name = await dialogs.prompt('Переименовать проект', 'Новое название', p.name, 'Переименовать');
      if (!name) return;
      try { await unwrap(api().projects.rename(p.id, name)); await refresh(); } catch (e) { await showError('Не удалось переименовать', e); }
    },
    duplicate: async (p: ProjectSummary) => {
      const name = await dialogs.prompt('Дублировать проект', 'Название копии', `${p.name} (копия)`, 'Дублировать');
      if (!name) return;
      try { await unwrap(api().projects.duplicate(p.id, name)); await refresh(); toast(`Создана копия «${name}»`); } catch (e) { await showError('Не удалось дублировать', e); }
    },
    remove: async (p: ProjectSummary) => {
      const okDel = await dialogs.confirm('Удалить проект', `Удалить проект «${p.name}»?\nОн будет перемещён в папку trash внутри папки данных и не попадёт в список.`, 'Удалить', true);
      if (!okDel) return;
      try { await unwrap(api().projects.remove(p.id)); await refresh(); toast(`Проект «${p.name}» перемещён в корзину`); } catch (e) { await showError('Не удалось удалить', e); }
    },
  };

  return (
    <div className="app">
      {opened ? (
        <Workspace
          key={opened.session}
          opened={opened}
          info={info}
          fileActions={fileActions}
          registerClose={(fn) => { closeCurrent.current = fn; }}
          onClosed={closeProject}
          onSwitch={(doc) => setOpened({ doc, savedRevision: doc.revision, session: ++sessionCounter.current })}
          toast={toast}
          catalog={catalog}
        />
      ) : (
        <>
          <TopBar info={info} fileActions={fileActions} onCatalog={() => setCatalogOpen((o) => !o)} catalogOpen={catalogOpen} />
          {catalogOpen ? (
            <CatalogView catalog={catalog} onClose={() => setCatalogOpen(false)} toast={toast} />
          ) : (
            <main className="start">
              <ProjectList projects={projects} loading={loading} onCreate={createProject} onOpen={openProject}
                onRename={listActions.rename} onDuplicate={listActions.duplicate} onDelete={listActions.remove} />
            </main>
          )}
          <StatusBar info={info} />
        </>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

interface FileActions {
  importProject(): Promise<void>;
  backupAll(flush?: () => Promise<void>): Promise<void>;
  restoreBackup(): Promise<void>;
}

function TopBar({ info, fileActions, editor, projectActions, onCatalog, catalogOpen }: {
  info: AppInfo | null;
  fileActions: FileActions;
  onCatalog?(): void;
  catalogOpen?: boolean;
  editor?: Editor;
  projectActions?: { back(): void; save(): void; saveAs(): void; exportProject(): void };
}) {
  return (
    <header className="topbar">
      <div className="brand">Электронная лаборатория</div>
      {projectActions && <button className="btn" onClick={projectActions.back} title="К списку проектов">← Проекты</button>}
      <div className="toolbar" role="toolbar" aria-label="Файл">
        <button className="btn primary" disabled={!editor} onClick={projectActions?.save} title="Ctrl+S">Сохранить</button>
        <button className="btn" disabled={!editor} onClick={projectActions?.saveAs}>Сохранить как…</button>
        <button className="btn" disabled={!editor} onClick={projectActions?.exportProject}>Экспорт проекта</button>
        <button className="btn" onClick={() => fileActions.importProject()}>Импорт проекта</button>
        <span className="sep" />
        <button className="btn" onClick={() => fileActions.backupAll(editor?.flushAutosave)}>Резервная копия всего</button>
        <button className="btn" onClick={() => fileActions.restoreBackup()}>Восстановить резервную копию</button>
        {onCatalog && <><span className="sep" /><button className={`btn ${catalogOpen ? 'on' : ''}`} aria-pressed={catalogOpen} onClick={onCatalog}>Каталог деталей</button></>}
      </div>
      {!info && <span className="muted">Загрузка…</span>}
    </header>
  );
}

function SaveIndicator({ editor }: { editor: Editor }) {
  const a = editor.autosave;
  if (!editor.dirty) {
    return <span className="indicator ok" data-state="saved">Сохранено{editor.lastSavedAt ? ` в ${fmtTime(editor.lastSavedAt)}` : ''}</span>;
  }
  const detail =
    a.kind === 'done' ? `автосохранено в ${fmtTime(a.at)}` :
    a.kind === 'writing' ? 'автосохранение…' :
    a.kind === 'pending' ? 'ожидание автосохранения' :
    a.kind === 'error' ? `ошибка автосохранения: ${a.message}` : '';
  return (
    <span className={`indicator ${a.kind === 'error' ? 'error' : 'warn'}`} data-state={a.kind === 'done' ? 'autosaved' : a.kind === 'error' ? 'error' : 'unsaved'} title={detail}>
      Есть несохранённые изменения{detail ? ` · ${detail}` : ''}
    </span>
  );
}

function StatusBar({ info, editor }: { info: AppInfo | null; editor?: Editor }) {
  return (
    <footer className="statusbar">
      {editor && <SaveIndicator editor={editor} />}
      <span className="muted" title={info?.dataRoot}>
        {info ? `${info.portable ? 'Портативный режим' : 'Данные'}: ${info.dataRoot}` : ''}
      </span>
      <span className="muted">Работает без интернета · версия {info?.version ?? '…'}</span>
    </footer>
  );
}

type Tab = 'schematic' | 'test' | 'board' | 'catalog';

function Workspace({ opened, info, fileActions, registerClose, onClosed, onSwitch, toast, catalog }: {
  opened: Opened;
  info: AppInfo | null;
  fileActions: FileActions;
  registerClose(fn: () => Promise<boolean>): void;
  onClosed(): Promise<void>;
  onSwitch(doc: ProjectDoc): void;
  toast(text: string, kind?: 'ok' | 'error'): void;
  catalog: CatalogState;
}) {
  const dialogs = useDialogs();
  const editor = useEditor(opened.doc, opened.savedRevision);
  const { doc } = editor;
  const [tab, setTab] = useState<Tab>('schematic');
  const [selection, setSelection] = useState<string[]>([]);
  const [ercOpen, setErcOpen] = useState(false);
  const [ercPick, setErcPick] = useState<ErcIssue | null>(null);
  const [focus, setFocus] = useState<{ at: { x: number; y: number }; seq: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [placing, setPlacing] = useState<string | null>(null);
  const [boardSel, setBoardSel] = useState<{ kind: 'track' | 'placement'; id: string } | null>(null);
  const [sim, setSim] = useState<{ result: SimResult; key: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const ercIssues = useMemo(() => (ercOpen ? runErc(doc) : []), [ercOpen, doc]);
  // Выделение, ставшее недействительным (удалено, отменено), очищается.
  useEffect(() => {
    if (selection.some((id) => !kindOf(doc, id))) setSelection((sel) => sel.filter((id) => kindOf(doc, id)));
  }, [doc, selection]);

  const runSim = async () => {
    setRunning(true);
    try {
      const d = editorRef.current.doc;
      const result = await unwrap(api().sim.run(d, {}));
      setSim({ result, key: circuitKey(d) });
    } catch (e) {
      await dialogs.alert('Расчёт не выполнен', errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const loadCheckpoints = useCallback(async () => {
    try { setCheckpoints(await unwrap(api().checkpoints.list(doc.id))); } catch { setCheckpoints([]); }
  }, [doc.id]);
  useEffect(() => { void loadCheckpoints(); }, [loadCheckpoints]);

  const save = useCallback(async () => {
    try {
      await editorRef.current.save();
      await loadCheckpoints();
      return true;
    } catch (e) {
      await dialogs.alert('Сохранение не выполнено', `${errorText(e)}\n\nИзменения остаются в рабочей копии.`);
      return false;
    }
  }, [dialogs, loadCheckpoints]);

  /** Закрыть проект: при несохранённых изменениях спросить. */
  const close = useCallback(async (): Promise<boolean> => {
    const ed = editorRef.current;
    if (await ed.settle()) {
      const answer = await dialogs.choose('Несохранённые изменения', `Сохранить изменения в проекте «${ed.doc.name}»?`, [
        { label: 'Отмена', value: 'cancel' },
        { label: 'Не сохранять', value: 'discard', kind: 'danger' },
        { label: 'Сохранить', value: 'save', kind: 'primary' },
      ]);
      if (answer === 'cancel') return false;
      if (answer === 'save' && !(await save())) return false;
      if (answer === 'discard') await unwrap(api().projects.discardRecovery(ed.doc.id)).catch(() => undefined);
    }
    await api().app.setDirty(false);
    await onClosed();
    return true;
  }, [dialogs, onClosed, save]);

  useEffect(() => { registerClose(close); }, [registerClose, close]);

  // Закрытие окна программы с несохранёнными изменениями (вопрос задаёт главный процесс).
  useEffect(() => api().app.onCloseRequest(async (choice) => {
    if (choice === 'save') {
      if (!(await save())) return;
    } else {
      await unwrap(api().projects.discardRecovery(editorRef.current.doc.id)).catch(() => undefined);
    }
    await api().app.closeConfirmed();
  }), [save]);

  // Горячие клавиши (по физическим клавишам — работают и в русской раскладке).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyS') { e.preventDefault(); void save(); return; }
      if (typing) return;
      if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); editorRef.current.undo(); }
      else if (mod && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); editorRef.current.redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        const ed = editorRef.current;
        if (tab === 'board' && boardSel?.kind === 'track') {
          e.preventDefault();
          ed.apply('Удаление дорожки', (d) => deleteTrack(d, boardSel.id));
          setBoardSel(null);
        }
      } else if (e.code === 'KeyR' && !mod) {
        const ed = editorRef.current;
        if (tab === 'board' && boardSel?.kind === 'placement') ed.apply('Поворот детали на плате', (d) => rotatePlacement(d, boardSel.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, boardSel, tab]);

  const projectActions = {
    back: () => { void close(); },
    save: () => { void save(); },
    saveAs: async () => {
      const name = await dialogs.prompt('Сохранить как', 'Название нового проекта', `${doc.name} (копия)`, 'Сохранить');
      if (!name) return;
      try {
        const created = await unwrap(api().projects.saveAs(editorRef.current.doc, name));
        toast(`Сохранено как новый проект «${created.name}»`);
        await api().app.setDirty(false);
        onSwitch(created);
      } catch (e) {
        await dialogs.alert('«Сохранить как» не выполнено', errorText(e));
      }
    },
    exportProject: async () => {
      try {
        const r = await unwrap(api().files.exportProject(editorRef.current.doc));
        if (r) toast(`Проект экспортирован: ${r.path} (${fmtBytes(r.bytes)})`);
      } catch (e) {
        await dialogs.alert('Экспорт не выполнен', errorText(e));
      }
    },
  };

  const createCheckpoint = async () => {
    const label = await dialogs.prompt('Контрольная версия', 'Подпись (например, «до замены транзистора»)', `Версия от ${new Date().toLocaleString('ru-RU')}`, 'Создать');
    if (!label) return;
    try {
      await unwrap(api().checkpoints.create(editorRef.current.doc, label));
      await loadCheckpoints();
      toast('Контрольная версия создана');
    } catch (e) {
      await dialogs.alert('Контрольная версия не создана', errorText(e));
    }
  };

  const restoreCheckpoint = async (cp: CheckpointInfo) => {
    const okRestore = await dialogs.confirm('Вернуть контрольную версию',
      `Вернуть проект к версии «${cp.label}» от ${fmtDateTime(cp.createdAt)}?\nТекущее состояние будет сохранено как отдельная контрольная версия, а возврат можно отменить (Ctrl+Z).`, 'Вернуть');
    if (!okRestore) return;
    try {
      const restored = await unwrap(api().checkpoints.restore(editorRef.current.doc, cp.id));
      editorRef.current.apply(`Возврат к «${cp.label}»`, () => restored);
      setSelection([]);
      await loadCheckpoints();
    } catch (e) {
      await dialogs.alert('Не удалось вернуть версию', errorText(e));
    }
  };

  return (
    <>
      <TopBar info={info} fileActions={fileActions} editor={editor} projectActions={projectActions} />
      <nav className="tabs" role="tablist">
        <span className="project-title" title={doc.name}>{doc.name}</span>
        {([['schematic', 'Схема'], ['test', 'Тест'], ['board', 'Плата'], ['catalog', 'Каталог']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
        <div className="toolbar tabs-right" role="toolbar" aria-label="Правка">
          <button className="btn small" disabled={!editor.canUndo} onClick={editor.undo} title={`Ctrl+Z${editor.undoLabel ? ` — ${editor.undoLabel}` : ''}`} aria-label="Отменить">↶ Отменить</button>
          <button className="btn small" disabled={!editor.canRedo} onClick={editor.redo} title={`Ctrl+Y${editor.redoLabel ? ` — ${editor.redoLabel}` : ''}`} aria-label="Повторить">↷ Повторить</button>
        </div>
      </nav>
      {tab === 'schematic' && (
        <main className="workspace">
          <CatalogPanel catalog={catalog} placing={placing} onPick={setPlacing} onOpenCatalog={() => setTab('catalog')} />
          <section className="center column">
            <SchematicCanvas
              doc={doc}
              mode="edit"
              selection={selection}
              onSelect={setSelection}
              onEdit={editor.apply}
              onError={(t) => toast(t, 'error')}
              placing={placing}
              onCancelPlace={() => setPlacing(null)}
              onPlace={(partId, p) => {
                const bundle = catalog.byId(partId);
                if (!bundle) { toast('Деталь не найдена в каталоге', 'error'); setPlacing(null); return; }
                const id = newId();
                editor.apply(`Размещение: ${bundle.part.name}`, (d) => placeBundle(d, bundle, p, id).doc);
                setSelection([id]);
                setPlacing(null);
              }}
              onAddNote={(p) => {
                const id = newId();
                editor.apply('Добавление заметки', (d) => addAnnotation(d, p, 'Заметка', id).doc);
                setSelection([id]);
              }}
              flagged={ercOpen && ercPick ? new Set(ercPick.refs) : undefined}
              markers={ercOpen ? ercIssues.filter((i) => i.at && i.severity !== 'info').map((i) => ({ key: i.key, at: i.at!, severity: i.severity })) : undefined}
              focus={focus}
              hint="Вывод → вывод — провод · W провод · L метка · R поворот · X отражение · Del удалить · F всё"
              toolbarExtra={(
                <>
                  <button className={`btn small ${ercOpen ? 'on' : ''}`} aria-pressed={ercOpen} onClick={() => setErcOpen((o) => !o)}>Проверка (ERC)</button>
                  <button className="btn small" onClick={() => {
                    const r = renumber(editorRef.current.doc);
                    if (!r.changes.length) { toast('Нумерация уже по порядку'); return; }
                    editor.apply('Перенумерация', () => r.doc);
                    toast(`Перенумеровано: ${r.changes.map((c) => `${c.from}→${c.to}`).join(', ')}`);
                  }} title="Позиционные обозначения по порядку: слева направо, сверху вниз">Перенумеровать</button>
                  <button className="btn small" onClick={() => setExportOpen(true)}>Экспорт / печать…</button>
                  <button className="btn small" onClick={async () => {
                    try {
                      const r = await unwrap(api().files.saveDrawing(`${editorRef.current.doc.name} — список соединений`, 'txt', connectionListText(editorRef.current.doc)));
                      if (r) toast(`Список соединений сохранён: ${r.path}`);
                    } catch (e) { await dialogs.alert('Не сохранено', errorText(e)); }
                  }}>Список соединений</button>
                </>
              )}
            />
            {ercOpen && (
              <ErcPanel issues={ercIssues} onClose={() => { setErcOpen(false); setErcPick(null); }} onPick={(i) => {
                setErcPick(i);
                const ids = i.refs.filter((id) => kindOf(editorRef.current.doc, id));
                if (ids.length) setSelection(ids);
                if (i.at) setFocus({ at: i.at, seq: Date.now() });
              }} />
            )}
          </section>
          <PropertiesPanel
            doc={doc}
            selection={selection}
            onSelect={setSelection}
            onEdit={editor.apply}
            checkpoints={checkpoints}
            onRename={(name) => editor.apply('Переименование проекта', (d) => renameProject(d, name))}
            onDescription={(t) => editor.apply('Изменение описания', (d) => setDescription(d, t), 'description')}
            onNoteText={(id, t) => editor.apply('Изменение текста заметки', (d) => updateAnnotation(d, id, { text: t }), `note-text:${id}`)}
            onNoteDelete={(id) => { editor.apply('Удаление заметки', (d) => removeAnnotation(d, id)); setSelection([]); }}
            onInstValue={(id, key, value, unit) => editor.apply('Изменение номинала', (d) => setValue(d, id, key, { value, unit }))}
            onInstRefDes={(id, ref) => {
              const r = renameRefDes(editorRef.current.doc, id, ref);
              if (!r.error) editor.apply('Позиционное обозначение', (d) => renameRefDes(d, id, ref).doc);
              return r.error;
            }}
            onInstRotate={(id) => editor.apply('Поворот детали', (d) => rotateItems(d, new Set([id])))}
            onInstDelete={(id) => { editor.apply('Удаление детали', (d) => deleteItems(d, new Set([id]))); setSelection([]); }}
            onAddToCatalog={async (partId) => {
              try {
                const saved = await unwrap(api().catalog.fromProject(editorRef.current.doc, partId));
                await catalog.reload();
                toast(`«${saved.part.name}» добавлена в мой каталог`);
              } catch (e) {
                await dialogs.alert('Деталь не добавлена в каталог', errorText(e));
              }
            }}
            onWireDelete={(id) => { editor.apply('Удаление провода', (d) => deleteItems(d, new Set([id]))); setSelection([]); }}
            onCreateCheckpoint={createCheckpoint}
            onRestoreCheckpoint={restoreCheckpoint}
          />
          {exportOpen && (
            <ExportDialog doc={doc} toast={toast} onClose={() => setExportOpen(false)}
              onSheet={(patch) => editor.apply('Настройки листа', (d) => ({ ...d, schematic: { ...d.schematic, sheet: { ...d.schematic.sheet, ...patch } } }), 'sheet')} />
          )}
        </main>
      )}
      {tab === 'catalog' && (
        <CatalogView catalog={catalog} toast={toast} onClose={() => setTab('schematic')}
          onPlace={(partId) => { setPlacing(partId); setTab('schematic'); }} />
      )}
      {tab === 'test' && (
        <main className="workspace single">
          <TestPanel
            doc={doc}
            ngspice={info?.ngspice ?? null}
            result={sim?.result ?? null}
            resultKey={sim?.key ?? null}
            running={running}
            onRun={runSim}
            onProbe={(color, pin) => editor.apply(pin ? 'Щуп' : 'Снять щуп', (d) => setProbe(d, color, pin))}
            onTranSettings={(patch) => editor.apply('Настройки расчёта', (d) => setTranSettings(d, patch))}
            onSimSettings={(patch) => editor.apply('Настройки расчёта', (d) => setSimSettings(d, patch))}
          />
        </main>
      )}
      {tab === 'board' && (
        <main className="workspace single">
          <BoardPanel
            doc={doc}
            selectedTrack={boardSel?.kind === 'track' ? boardSel.id : null}
            selectedPlacement={boardSel?.kind === 'placement' ? boardSel.id : null}
            onSelect={setBoardSel}
            onSync={() => {
              const r = syncFromSchematic(editorRef.current.doc);
              if (r.doc !== editorRef.current.doc) editor.apply('Синхронизация платы со схемой', () => r.doc);
              return r.report;
            }}
            onBoard={(w, h) => editor.apply('Размер платы', (d) => setBoard(d, w, h))}
            onMove={(id, p, dragId) => editor.apply('Перемещение детали на плате', (d) => movePlacement(d, id, p), dragId)}
            onRotate={(id) => editor.apply('Поворот детали на плате', (d) => rotatePlacement(d, id))}
            onTrack={(a, b, w) => {
              const r = addTrack(editorRef.current.doc, a, b, w);
              if (!r.error) editor.apply('Дорожка', (d) => addTrack(d, a, b, w).doc);
              return r.error;
            }}
            onDeleteTrack={(id) => { editor.apply('Удаление дорожки', (d) => deleteTrack(d, id)); setBoardSel(null); }}
            onExport={async (copperSide) => {
              try {
                const svg = copperSvg(editorRef.current.doc, { copperSide });
                const r = await unwrap(api().files.saveSvg(`${editorRef.current.doc.name} — ${copperSide ? 'сторона меди' : 'сторона деталей'}`, svg));
                if (r) toast(`Сохранено: ${r.path}`);
              } catch (e) {
                await dialogs.alert('Рисунок не сохранён', errorText(e));
              }
            }}
          />
        </main>
      )}
      <StatusBar info={info} editor={editor} />
    </>
  );
}
