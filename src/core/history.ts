/** История Undo/Redo на неизменяемых снимках. Ограничена по числу шагов. */

export const HISTORY_LIMIT = 200;

export interface History<T> {
  past: Array<{ state: T; label: string }>;
  present: T;
  /** Подпись действия, которое привело к present (для «Отменить: …»). */
  presentLabel: string | null;
  future: Array<{ state: T; label: string }>;
}

export function initHistory<T>(state: T): History<T> {
  return { past: [], present: state, presentLabel: null, future: [] };
}

export function pushState<T>(h: History<T>, state: T, label: string, limit = HISTORY_LIMIT): History<T> {
  if (Object.is(state, h.present)) return h;
  const past = [...h.past, { state: h.present, label: h.presentLabel ?? '' }];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    present: state,
    presentLabel: label,
    future: [],
  };
}

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return {
    past: h.past.slice(0, -1),
    present: prev.state,
    presentLabel: prev.label || null,
    future: [{ state: h.present, label: h.presentLabel ?? '' }, ...h.future],
  };
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (!next) return h;
  return {
    past: [...h.past, { state: h.present, label: h.presentLabel ?? '' }],
    present: next.state,
    presentLabel: next.label || null,
    future: h.future.slice(1),
  };
}

export const canUndo = <T>(h: History<T>) => h.past.length > 0;
export const canRedo = <T>(h: History<T>) => h.future.length > 0;
