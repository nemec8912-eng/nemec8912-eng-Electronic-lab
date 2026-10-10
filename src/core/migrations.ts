/**
 * Миграции документа проекта и единая точка загрузки: миграция → проверка структуры → проверка целостности.
 */
import { CURRENT_SCHEMA_VERSION, DEFAULT_SIMULATION, validateDocShape, type ProjectDoc, type ValidationIssue } from './model';
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
  {
    /**
     * v1 → v2. Провода и дорожки v1 не знали своих концов (null — «только графика»).
     * Площадкам v1 не было координат: они расставляются в ряд с шагом 2,54 мм как типовые
     * выводные (∅1,8 мм, отверстие 0,9 мм) — такие корпуса нужно проверить перед изготовлением платы.
     */
    from: 1,
    to: 2,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      const lib = r.library ?? {};
      const pcb = r.pcb ?? {};
      return {
        ...r,
        schemaVersion: 2,
        schematic: {
          ...r.schematic,
          wires: (r.schematic?.wires ?? []).map((w: Record<string, unknown>) => ({ ...w, from: w.from ?? null, to: w.to ?? null })),
        },
        library: {
          ...lib,
          symbols: (lib.symbols ?? []).map((s: Record<string, any>) => ({
            ...s,
            graphic: s.graphic ?? 'box',
            pins: (s.pins ?? []).map((pin: Record<string, unknown>, i: number) => ('x' in pin ? pin : { ...pin, x: i * 20, y: 0 })),
          })),
          packages: (lib.packages ?? []).map((p: Record<string, any>) => ({
            ...p,
            body: p.body ?? null,
            pads: (p.pads ?? []).map((pad: Record<string, unknown>, i: number) =>
              'x' in pad ? pad : { ...pad, x: Math.round(i * 2.54 * 100) / 100, y: 0, shape: 'round', w: 1.8, h: 1.8, drill: 0.9 }),
          })),
        },
        pcb: {
          ...pcb,
          tracks: (pcb.tracks ?? []).map((t: Record<string, unknown>) => ({ ...t, from: t.from ?? null, to: t.to ?? null })),
        },
        simulation: r.simulation ?? structuredClone(DEFAULT_SIMULATION),
      };
    },
  },
  {
    /** v2 → v3: сведения каталога (этап 2). Новые поля заполняются нейтрально; ничего не придумывается. */
    from: 2,
    to: 3,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      return { ...r, schemaVersion: 3, library: upgradeLibraryV2toV3(r.library ?? {}) };
    },
  },
];

/** Перевод библиотечных сущностей v2 → v3 (общий для проекта и личного каталога). */
export function upgradeLibraryV2toV3(lib: Record<string, any>): Record<string, any> {
  return {
    ...lib,
    symbols: (lib.symbols ?? []).map((s: Record<string, any>) => ({
      ...s,
      box: s.box ?? null,
      pins: (s.pins ?? []).map((pin: Record<string, unknown>) => ({ ...pin, description: pin.description ?? '' })),
    })),
    packages: (lib.packages ?? []).map((p: Record<string, any>) => ({
      ...p,
      mount: p.mount ?? ((p.pads ?? []).some((x: Record<string, unknown>) => x.drill) ? 'THT' : 'SMD'),
      pitchMm: p.pitchMm ?? null,
      numbering: p.numbering ?? null,
      generator: p.generator ?? null,
    })),
    parts: (lib.parts ?? []).map((p: Record<string, any>) => ({
      ...p,
      refPrefix: p.refPrefix ?? ({ resistor: 'R', capacitor: 'C', source: 'V', reference: 'GND' } as Record<string, string>)[p.category] ?? 'U',
      description: p.description ?? '',
      marking: p.marking ?? null,
      values: p.values ?? {},
      tolerancePct: p.tolerancePct ?? null,
      temperature: p.temperature ?? null,
      polarized: p.polarized ?? false,
      datasheetUrl: p.datasheetUrl ?? null,
      origin: { license: null, verified: false, notes: '', ...p.origin },
    })),
  };
}

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
