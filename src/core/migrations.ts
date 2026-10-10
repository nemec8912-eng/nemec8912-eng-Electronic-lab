/**
 * Миграции документа проекта и единая точка загрузки: миграция → проверка структуры → проверка целостности.
 */
import { CURRENT_SCHEMA_VERSION, validateDocShape, type ProjectDoc, type ValidationIssue } from './model';
import { checkIntegrity, type IntegrityIssue } from './integrity';
import { emptyCollections } from './factory';

type Migration = { from: number; to: number; migrate: (raw: Record<string, unknown>) => Record<string, unknown> };

/**
 * Версия 0 — формат раннего прототипа: { version: 0, id, title, notes[{id,text,x,y}], created, modified }.
 * Сохранена как фикстура для проверки цепочки миграций (tests/fixtures/project-v0.json).
 */
const migrations: Migration[] = [
  {
    from: 0,
    to: 1,
    migrate: (raw) => {
      const notes = Array.isArray(raw.notes) ? (raw.notes as Array<Record<string, unknown>>) : [];
      const created = typeof raw.created === 'string' ? raw.created : new Date(0).toISOString();
      const modified = typeof raw.modified === 'string' ? raw.modified : created;
      const base = emptyCollections();
      return {
        schemaVersion: 1,
        id: raw.id,
        name: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Без названия',
        description: '',
        createdAt: created,
        updatedAt: modified,
        revision: 0,
        ...base,
        schematic: {
          ...base.schematic,
          annotations: notes.map((n) => ({
            id: n.id,
            kind: 'text',
            text: typeof n.text === 'string' ? n.text : '',
            position: { x: Number(n.x ?? 0), y: Number(n.y ?? 0) },
            targetId: null,
          })),
        },
      };
    },
  },
];

export function detectSchemaVersion(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const v = r.schemaVersion ?? r.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export type LoadError =
  | { code: 'not-a-project'; message: string }
  | { code: 'newer-version'; message: string; version: number }
  | { code: 'no-migration'; message: string; version: number }
  | { code: 'invalid-structure'; message: string; issues: ValidationIssue[] }
  | { code: 'integrity'; message: string; issues: IntegrityIssue[] };

export type LoadResult = { ok: true; doc: ProjectDoc; migratedFrom: number | null } | { ok: false; error: LoadError };

/** Поднимает сырой JSON до текущей версии, проверяет структуру и целостность. Входные данные не изменяет. */
export function loadDocument(raw: unknown): LoadResult {
  const version = detectSchemaVersion(raw);
  if (version === null) {
    return { ok: false, error: { code: 'not-a-project', message: 'Это не документ проекта: нет номера версии формата' } };
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: 'newer-version',
        version,
        message: `Проект сохранён более новой версией программы (формат ${version}, поддерживается до ${CURRENT_SCHEMA_VERSION}). Обновите программу.`,
      },
    };
  }
  let current = structuredClone(raw) as Record<string, unknown>;
  let v = version;
  while (v < CURRENT_SCHEMA_VERSION) {
    const step = migrations.find((m) => m.from === v);
    if (!step) {
      return { ok: false, error: { code: 'no-migration', version: v, message: `Нет миграции с версии формата ${v}` } };
    }
    current = step.migrate(current);
    v = step.to;
  }
  const shape = validateDocShape(current);
  if (!shape.ok) {
    return { ok: false, error: { code: 'invalid-structure', message: 'Документ проекта повреждён или имеет неверную структуру', issues: shape.issues } };
  }
  const integrity = checkIntegrity(shape.doc);
  if (integrity.length > 0) {
    return { ok: false, error: { code: 'integrity', message: 'Нарушена целостность связей проекта', issues: integrity } };
  }
  return { ok: true, doc: shape.doc, migratedFrom: version === CURRENT_SCHEMA_VERSION ? null : version };
}

export function describeLoadError(e: LoadError): string {
  switch (e.code) {
    case 'invalid-structure':
      return `${e.message}:\n${e.issues.slice(0, 10).map((i) => `• ${i.path}: ${i.message}`).join('\n')}`;
    case 'integrity':
      return `${e.message}:\n${e.issues.slice(0, 10).map((i) => `• ${i.message}`).join('\n')}`;
    default:
      return e.message;
  }
}
