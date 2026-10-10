/** Модальные окна внутри приложения: подтверждение, ввод текста, сообщение. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface Button<T> { label: string; value: T; kind?: 'primary' | 'danger' | 'default' }

type DialogSpec =
  | { type: 'choice'; title: string; message: string; buttons: Button<string>[]; resolve: (v: string) => void }
  | { type: 'prompt'; title: string; label: string; initial: string; okLabel: string; resolve: (v: string | null) => void };

interface DialogsApi {
  choose(title: string, message: string, buttons: Button<string>[]): Promise<string>;
  confirm(title: string, message: string, okLabel?: string, danger?: boolean): Promise<boolean>;
  alert(title: string, message: string): Promise<void>;
  prompt(title: string, label: string, initial?: string, okLabel?: string): Promise<string | null>;
}

const Ctx = createContext<DialogsApi | null>(null);

export function useDialogs(): DialogsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('DialogsProvider отсутствует');
  return c;
}

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogSpec[]>([]);
  const push = useCallback((d: DialogSpec) => setQueue((q) => [...q, d]), []);
  const pop = useCallback(() => setQueue((q) => q.slice(1)), []);

  const apiValue = useRef<DialogsApi>({
    choose: (title, message, buttons) => new Promise((resolve) => push({ type: 'choice', title, message, buttons, resolve })),
    confirm: (title, message, okLabel = 'OK', danger = false) =>
      new Promise((resolve) => push({
        type: 'choice', title, message,
        buttons: [{ label: 'Отмена', value: 'no' }, { label: okLabel, value: 'yes', kind: danger ? 'danger' : 'primary' }],
        resolve: (v) => resolve(v === 'yes'),
      })),
    alert: (title, message) => new Promise((resolve) => push({ type: 'choice', title, message, buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }], resolve: () => resolve() })),
    prompt: (title, label, initial = '', okLabel = 'OK') => new Promise((resolve) => push({ type: 'prompt', title, label, initial, okLabel, resolve })),
  });

  const current = queue[0];
  return (
    <Ctx.Provider value={apiValue.current}>
      {children}
      {current && <DialogView key={queue.length + current.title} spec={current} done={pop} />}
    </Ctx.Provider>
  );
}

function DialogView({ spec, done }: { spec: DialogSpec; done: () => void }) {
  const [text, setText] = useState(spec.type === 'prompt' ? spec.initial : '');
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (spec.type === 'prompt') { inputRef.current?.focus(); inputRef.current?.select(); } else primaryRef.current?.focus();
  }, [spec]);

  const finish = (v: string | null) => {
    done();
    if (spec.type === 'prompt') spec.resolve(v);
    else spec.resolve(v ?? spec.buttons[0]!.value);
  };

  return (
    <div className="modal-backdrop" onKeyDown={(e) => { if (e.key === 'Escape') finish(null); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={spec.title}>
        <h2>{spec.title}</h2>
        {spec.type === 'choice' ? (
          <>
            <p className="modal-message">{spec.message}</p>
            <div className="modal-buttons">
              {spec.buttons.map((b, i) => (
                <button key={b.value} ref={i === spec.buttons.length - 1 ? primaryRef : undefined} className={`btn ${b.kind ?? ''}`} onClick={() => finish(b.value)}>
                  {b.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) finish(text); }}>
            <label className="field">
              <span>{spec.label}</span>
              <input ref={inputRef} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className="modal-buttons">
              <button type="button" className="btn" onClick={() => finish(null)}>Отмена</button>
              <button type="submit" className="btn primary" disabled={!text.trim()}>{spec.okLabel}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
