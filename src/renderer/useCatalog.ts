/** Каталог для окна: встроенный справочник (в коде) + личный каталог (файл в папке данных, через IPC). */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { builtinCatalog } from '../catalog/builtin';
import type { PartBundle } from '../core/catalog';
import { api, errorText, unwrap } from './api';

const BUILTIN = builtinCatalog();

export interface CatalogState {
  builtin: PartBundle[];
  personal: PartBundle[];
  /** Личные и встроенные; личные первыми. */
  all: PartBundle[];
  error: string | null;
  loaded: boolean;
  reload(): Promise<void>;
  byId(id: string): PartBundle | undefined;
  isPersonal(id: string): boolean;
}

export function useCatalog(): CatalogState {
  const [personal, setPersonal] = useState<PartBundle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try {
      setPersonal(await unwrap(api().catalog.list()));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return useMemo(() => {
    const all = [...personal, ...BUILTIN];
    const ids = new Set(personal.map((b) => b.part.id));
    return {
      builtin: BUILTIN, personal, all, error, loaded, reload,
      byId: (id: string) => all.find((b) => b.part.id === id),
      isPersonal: (id: string) => ids.has(id),
    };
  }, [personal, error, loaded, reload]);
}
