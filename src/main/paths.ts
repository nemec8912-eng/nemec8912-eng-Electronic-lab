/** Где хранить данные: портативный режим (рядом с программой) или профиль пользователя. */
import * as path from 'node:path';

export const PORTABLE_FLAG = 'portable.flag';

export interface DataRootInput {
  envDataDir: string | undefined;
  exePath: string;
  userDataPath: string;
  exists: (p: string) => boolean;
}

export interface DataRootChoice {
  root: string;
  portable: boolean;
  reason: 'env' | 'portable-flag' | 'user-profile';
}

export function resolveDataRoot(i: DataRootInput): DataRootChoice {
  if (i.envDataDir && i.envDataDir.trim()) return { root: path.resolve(i.envDataDir), portable: false, reason: 'env' };
  const exeDir = path.dirname(i.exePath);
  if (i.exists(path.join(exeDir, PORTABLE_FLAG))) return { root: path.join(exeDir, 'data'), portable: true, reason: 'portable-flag' };
  return { root: path.join(i.userDataPath, 'data'), portable: false, reason: 'user-profile' };
}
