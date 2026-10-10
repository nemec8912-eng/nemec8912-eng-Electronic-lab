import type { Result } from '../core/result';
import type { ElabApi } from '../shared/api';

declare global {
  interface Window {
    elab: ElabApi;
  }
}

export const api = (): ElabApi => window.elab;

export class UiError extends Error {
  constructor(message: string, readonly code: string, readonly details: string[] = []) {
    super(message);
  }
}

export async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw new UiError(r.error.message, r.error.code, r.error.details ?? []);
}

export function errorText(e: unknown): string {
  if (e instanceof UiError) return e.details.length ? `${e.message}\n${e.details.map((d) => `• ${d}`).join('\n')}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDateTime = (iso: string) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtBytes = (n: number) => (n < 1024 ? `${n} Б` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1024 ** 2).toFixed(1)} МБ`);
