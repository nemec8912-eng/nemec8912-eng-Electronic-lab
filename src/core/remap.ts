/**
 * Согласованное переназначение всех UUID (импорт как копия, дублирование, «Сохранить как»).
 * Заменяются значения полей `id` и `*Id` (ссылки). Поле `catalogPartId` ссылается на общий каталог
 * пользователя, а не на объект проекта, поэтому не меняется.
 * Несколько документов (проект и его контрольные версии) переназначаются одной общей таблицей,
 * чтобы контрольные версии остались версиями того же проекта.
 */
import { newId } from './ids';
import { collectEntityIds } from './integrity';
import type { ProjectDoc } from './model';

const KEEP_FIELDS = new Set(['catalogPartId']);

export function remapDocs(docs: ProjectDoc[]): { docs: ProjectDoc[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  for (const d of docs) for (const { id } of collectEntityIds(d)) if (!map.has(id)) map.set(id, newId());

  const walk = (value: unknown, key: string | null): unknown => {
    if (Array.isArray(value)) {
      // Списки ссылок (memberIds) переназначаются поэлементно.
      if (key !== null && key.endsWith('Ids')) return value.map((v) => (typeof v === 'string' ? map.get(v) ?? v : walk(v, null)));
      return value.map((v) => walk(v, null));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    if (typeof value === 'string' && key !== null && !KEEP_FIELDS.has(key) && (key === 'id' || key.endsWith('Id'))) {
      return map.get(value) ?? value;
    }
    return value;
  };

  return { docs: docs.map((d) => walk(d, null) as ProjectDoc), map };
}

export function remapIds(doc: ProjectDoc): { doc: ProjectDoc; map: Map<string, string> } {
  const r = remapDocs([doc]);
  return { doc: r.docs[0]!, map: r.map };
}
