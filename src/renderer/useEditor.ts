/**
 * Состояние открытого проекта: история Undo/Redo, признак несохранённых изменений, автосохранение.
 * Каждое изменение документа проходит через apply(): ревизия становится строго больше любой
 * встречавшейся в сеансе, поэтому «сохранено/не сохранено» определяется сравнением ревизий.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { canRedo, canUndo, initHistory, pushState, redo as hRedo, undo as hUndo, type History } from '../core/history';
import type { ProjectDoc } from '../core/model';
import { api, errorText, unwrap } from './api';

export type AutosaveState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'writing' }
  | { kind: 'done'; at: string }
  | { kind: 'error'; message: string };

export const AUTOSAVE_DELAY_MS = 1500;
const COALESCE_MS = 1200;

export interface Editor {
  doc: ProjectDoc;
  savedRevision: number;
  dirty: boolean;
  autosave: AutosaveState;
  lastSavedAt: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** coalesceKey: подряд идущие изменения с одним ключом (набор текста) — один шаг отмены. */
  apply(label: string, fn: (d: ProjectDoc) => ProjectDoc, coalesceKey?: string): void;
  undo(): void;
  redo(): void;
  save(): Promise<void>;
  /** Заменить документ после «Сохранить как» / импорта; история начинается заново. */
  replaceDoc(doc: ProjectDoc, savedRevision: number): void;
  flushAutosave(): Promise<void>;
}

export function useEditor(initial: ProjectDoc, initialSavedRevision: number): Editor {
  const [history, setHistory] = useState<History<ProjectDoc>>(() => initHistory(initial));
  const [savedRevision, setSavedRevision] = useState(initialSavedRevision);
  const [autosave, setAutosave] = useState<AutosaveState>({ kind: 'idle' });
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const counter = useRef(Math.max(initial.revision, initialSavedRevision));
  const lastCoalesce = useRef<{ key: string; at: number } | null>(null);
  const autosavedRevision = useRef<number>(initialSavedRevision);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const docRef = useRef(history.present);
  docRef.current = history.present;
  const savedRef = useRef(savedRevision);
  savedRef.current = savedRevision;

  const doc = history.present;
  const dirty = doc.revision !== savedRevision;

  const apply = useCallback((label: string, fn: (d: ProjectDoc) => ProjectDoc, coalesceKey?: string) => {
    setHistory((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      counter.current = Math.max(counter.current, h.present.revision, next.revision) + 1;
      const stamped = { ...next, revision: counter.current };
      const now = Date.now();
      const lc = lastCoalesce.current;
      lastCoalesce.current = coalesceKey ? { key: coalesceKey, at: now } : null;
      const sameDrag = coalesceKey?.startsWith('drag:') ?? false;
      if (coalesceKey && lc && lc.key === coalesceKey && (sameDrag || now - lc.at < COALESCE_MS) && h.past.length > 0) {
        return { ...h, present: stamped, future: [] };
      }
      return pushState(h, stamped, label);
    });
  }, []);

  const undo = useCallback(() => { lastCoalesce.current = null; setHistory((h) => hUndo(h)); }, []);
  const redo = useCallback(() => { lastCoalesce.current = null; setHistory((h) => hRedo(h)); }, []);

  const writeAutosave = useCallback(async () => {
    const current = docRef.current;
    if (current.revision === savedRef.current || current.revision === autosavedRevision.current) {
      setAutosave((s) => (s.kind === 'pending' ? { kind: 'idle' } : s));
      return;
    }
    setAutosave({ kind: 'writing' });
    try {
      const r = await unwrap(api().projects.autosave(current));
      autosavedRevision.current = current.revision;
      setAutosave({ kind: 'done', at: r.autosavedAt });
    } catch (e) {
      setAutosave({ kind: 'error', message: errorText(e) });
    }
  }, []);

  // Автосохранение через паузу после последнего изменения.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!dirty || doc.revision === autosavedRevision.current) return;
    setAutosave({ kind: 'pending' });
    timer.current = setTimeout(() => { void writeAutosave(); }, AUTOSAVE_DELAY_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [doc, dirty, writeAutosave]);

  useEffect(() => { void api().app.setDirty(dirty); }, [dirty]);

  // Отмена вернула документ к сохранённому состоянию — рабочая копия больше не нужна,
  // иначе при следующем открытии будет предложено «восстановить» уже отменённые правки.
  useEffect(() => {
    if (dirty || autosavedRevision.current === savedRevision) return;
    autosavedRevision.current = savedRevision;
    setAutosave({ kind: 'idle' });
    void api().projects.discardRecovery(doc.id);
  }, [dirty, savedRevision, doc.id]);

  const save = useCallback(async () => {
    const current = docRef.current;
    if (timer.current) clearTimeout(timer.current);
    const r = await unwrap(api().projects.save(current));
    setSavedRevision(current.revision);
    autosavedRevision.current = current.revision;
    setLastSavedAt(r.savedAt);
    setAutosave({ kind: 'idle' });
  }, []);

  const replaceDoc = useCallback((next: ProjectDoc, nextSaved: number) => {
    counter.current = Math.max(counter.current, next.revision, nextSaved);
    lastCoalesce.current = null;
    autosavedRevision.current = nextSaved;
    setHistory(initHistory(next));
    setSavedRevision(nextSaved);
    setAutosave({ kind: 'idle' });
  }, []);

  const flushAutosave = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await writeAutosave();
  }, [writeAutosave]);

  return {
    doc,
    savedRevision,
    dirty,
    autosave,
    lastSavedAt,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undoLabel: history.presentLabel,
    redoLabel: history.future[0]?.label ?? null,
    apply,
    undo,
    redo,
    save,
    replaceDoc,
    flushAutosave,
  };
}
