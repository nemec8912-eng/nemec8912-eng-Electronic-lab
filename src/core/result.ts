/** Единый формат результата для хранилища и IPC. Сообщения — по-русски, для пользователя. */
export interface AppErrorShape {
  code: string;
  message: string;
  details?: string[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppErrorShape };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(code: string, message: string, details?: string[]): Result<T> => ({
  ok: false,
  error: details && details.length ? { code, message, details } : { code, message },
});

export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: string[]) {
    super(message);
    this.name = 'AppError';
  }
  toShape(): AppErrorShape {
    return this.details && this.details.length
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}
