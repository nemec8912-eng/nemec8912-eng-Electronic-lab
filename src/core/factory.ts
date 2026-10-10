/** Создание документа и базовые операции изменения (без побочных эффектов). */
import { newId } from './ids';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SIMULATION, type Annotation, type ProjectDoc, type Point } from './model';

export const CHANGELOG_LIMIT = 2000;

export function emptyCollections(): Pick<ProjectDoc, 'schematic' | 'library' | 'pcb' | 'instruments' | 'simulation' | 'tests' | 'attachments' | 'changelog'> {
  return {
    schematic: { instances: [], nets: [], wires: [], annotations: [] },
    library: { symbols: [], parts: [], packages: [], models: [] },
    pcb: { board: null, placements: [], tracks: [], vias: [] },
    instruments: { settings: {} },
    simulation: structuredClone(DEFAULT_SIMULATION),
    tests: [],
    attachments: [],
    changelog: [],
  };
}

export function createProject(name: string, now: Date = new Date()): ProjectDoc {
  const at = now.toISOString();
  const doc: ProjectDoc = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name: normalizeName(name),
    description: '',
    createdAt: at,
    updatedAt: at,
    revision: 0,
    ...emptyCollections(),
  };
  return logChange(doc, 'create', `Проект «${doc.name}» создан`, now);
}

export function normalizeName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, 200);
  return n || 'Без названия';
}

/** Обязательная обёртка любого изменения содержимого: ревизия +1, время изменения. */
export function touch(doc: ProjectDoc, now: Date = new Date()): ProjectDoc {
  return { ...doc, revision: doc.revision + 1, updatedAt: now.toISOString() };
}

/** Запись значимой операции в журнал изменений проекта (не каждое движение мыши). */
export function logChange(doc: ProjectDoc, action: string, summary: string, now: Date = new Date()): ProjectDoc {
  const entry = { id: newId(), at: now.toISOString(), revision: doc.revision, action, summary: summary.slice(0, 1000) };
  const changelog = [...doc.changelog, entry];
  return { ...doc, changelog: changelog.length > CHANGELOG_LIMIT ? changelog.slice(-CHANGELOG_LIMIT) : changelog };
}

// ---------- Операции этапа 1 ----------

export function renameProject(doc: ProjectDoc, name: string): ProjectDoc {
  const n = normalizeName(name);
  if (n === doc.name) return doc;
  return logChange(touch({ ...doc, name: n }), 'rename', `Переименован: «${doc.name}» → «${n}»`);
}

export function setDescription(doc: ProjectDoc, description: string): ProjectDoc {
  if (description === doc.description) return doc;
  return touch({ ...doc, description: description.slice(0, 100_000) });
}

export function addAnnotation(doc: ProjectDoc, position: Point, text = 'Заметка', id: string = newId()): { doc: ProjectDoc; id: string } {
  const a: Annotation = { id, kind: 'text', text, position: roundPoint(position), targetId: null };
  return { doc: touch({ ...doc, schematic: { ...doc.schematic, annotations: [...doc.schematic.annotations, a] } }), id: a.id };
}

export function updateAnnotation(doc: ProjectDoc, id: string, patch: Partial<Pick<Annotation, 'text' | 'position'>>): ProjectDoc {
  let changed = false;
  const annotations = doc.schematic.annotations.map((a) => {
    if (a.id !== id) return a;
    const next = { ...a, ...patch, ...(patch.position ? { position: roundPoint(patch.position) } : {}) };
    changed = next.text !== a.text || next.position.x !== a.position.x || next.position.y !== a.position.y;
    return next;
  });
  return changed ? touch({ ...doc, schematic: { ...doc.schematic, annotations } }) : doc;
}

export function removeAnnotation(doc: ProjectDoc, id: string): ProjectDoc {
  const annotations = doc.schematic.annotations.filter((a) => a.id !== id);
  return annotations.length === doc.schematic.annotations.length
    ? doc
    : touch({ ...doc, schematic: { ...doc.schematic, annotations } });
}

function roundPoint(p: Point): Point {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}
