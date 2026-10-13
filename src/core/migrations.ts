/**
 * Миграции документа проекта и единая точка загрузки: миграция → проверка структуры → проверка целостности.
 */
import { CURRENT_SCHEMA_VERSION, DEFAULT_CNC, DEFAULT_RULES, DEFAULT_SHEET, DEFAULT_SIMULATION, validateDocShape, type ProjectDoc, type ValidationIssue } from './model';
import { rebuildNets } from './connectivity';
import { newId as cryptoId } from './ids';
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
  {
    /**
     * v3 → v4 (этап 3): провода становятся рёбрами графа (концы — вывод, узел, метка или свободный);
     * появляются узлы, метки цепей, группы и лист. Сети становятся производными от графа. Если сеть v3
     * держалась не на проводах (части без провода между собой) или имела имя, связь сохраняется явно —
     * метками с именем сети у каждой такой части. Ничего не теряется и не соединяется заново.
     */
    from: 3,
    to: 4,
    migrate: (raw) => migrateV3toV4(raw as Record<string, any>),
  },
  {
    /** v4 → v5 (этап 4): выбор анализа, развёртка DC, частотный анализ, параметрический прогон. */
    from: 4,
    to: 5,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      const d = structuredClone(DEFAULT_SIMULATION);
      return { ...r, schemaVersion: 5, simulation: { ...d, ...(r.simulation ?? {}), analysis: d.analysis, dc: d.dc, ac: d.ac, sweep: d.sweep } };
    },
  },
  {
    /**
     * v5 → v6 (этап 6): у платы появляются единицы и правила проектирования (прежние зазор 0,4 мм,
     * дорожка от 0,4 мм и 0,8 мм по умолчанию, отступ от края 0,5 мм сохраняются); концы дорожек
     * становятся «площадка или переходное отверстие». Разводка и размещение не меняются.
     */
    from: 5,
    to: 6,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      const pcb = r.pcb ?? {};
      const end = (e: any) => (e ? { kind: 'pad', placementId: e.placementId, pad: e.pad } : null);
      return {
        ...r,
        schemaVersion: 6,
        pcb: {
          ...pcb,
          board: pcb.board ? { ...pcb.board, units: 'mm', rules: { ...DEFAULT_RULES } } : null,
          tracks: (pcb.tracks ?? []).map((t: Record<string, any>) => ({ ...t, from: end(t.from), to: end(t.to) })),
        },
      };
    },
  },
  {
    /**
     * v6 → v7 (этап 7): журнал испытаний. Прежние записи сохраняются полностью: точка измерения
     * становится подписью «словами» (с расчётом такая точка не сравнивается), значение и прибор — те же.
     */
    from: 6,
    to: 7,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      const tests = (r.tests ?? []).map((t: Record<string, any>) => ({
        id: t.id, createdAt: t.createdAt, revision: t.revision ?? 0, title: 'Испытание', date: t.createdAt, checkpointId: null,
        supplyV: null, instruments: '', conditions: t.conditions ?? '', notes: t.notes ?? '',
        measurements: (t.measurements ?? []).map((m: Record<string, any>) => ({
          id: m.id, target: { kind: 'text' }, label: String(m.target ?? '').slice(0, 128), quantity: 'other',
          measured: m.quantity?.value ?? null, unit: String(m.quantity?.unit ?? '').slice(0, 16), instrument: m.instrument ?? '',
          accuracyPct: 0, accuracyAbs: 0, expected: null, note: '',
        })),
        events: [], photoIds: [],
      }));
      return { ...r, schemaVersion: 7, tests };
    },
  },
  {
    /** v7 → v8: контур платы (прежние платы — прямоугольные) и медные заливки (пока нет). */
    from: 7,
    to: 8,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      const pcb = r.pcb ?? {};
      return { ...r, schemaVersion: 8, pcb: { ...pcb, board: pcb.board ? { ...pcb.board, outline: { kind: 'rect' } } : null, pours: [] } };
    },
  },
  {
    // v9: настройки фрезерования на станке с ЧПУ, тест работоспособности.
    from: 8,
    to: 9,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      return { ...r, schemaVersion: 9, pcb: { ...(r.pcb ?? {}), cnc: structuredClone(DEFAULT_CNC) }, checks: { items: [], noOverload: true } };
    },
  },
  {
    // v10: проволочные перемычки на плате (пока нет).
    from: 9,
    to: 10,
    migrate: (raw) => {
      const r = raw as Record<string, any>;
      return { ...r, schemaVersion: 10, pcb: { ...(r.pcb ?? {}), jumpers: [] } };
    },
  },
];

function migrateV3toV4(r: Record<string, any>): Record<string, unknown> {
  const sch = r.schematic ?? {};
  const lib = r.library ?? {};
  const wires = (sch.wires ?? []).map((w: Record<string, any>) => {
    const end = (e: any) => (e ? { kind: 'pin', instanceId: e.instanceId, pin: e.pin } : { kind: 'free' });
    return { id: w.id, a: end(w.from), b: end(w.to), points: w.points, manual: !w.from || !w.to };
  });
  const labels: Array<Record<string, unknown>> = [];
  const pk = (p: { instanceId: string; pin: string }) => `${p.instanceId}#${p.pin}`;
  // Связность только по проводам v3.
  const parent = new Map<string, string>();
  const find = (k: string): string => { let x = k; while (parent.get(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
  const wired = new Set<string>();
  for (const w of sch.wires ?? []) {
    if (!w.from || !w.to) continue;
    const a = pk(w.from), b = pk(w.to);
    wired.add(a); wired.add(b);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groundParts = new Set((lib.parts ?? []).filter((p: any) => (lib.models ?? []).some((m: any) => m.id === p.modelId && m.kind === 'ground')).map((p: any) => p.id));
  const instById = new Map((sch.instances ?? []).map((i: any) => [i.id, i]));
  const pinPos = (ref: { instanceId: string; pin: string }) => {
    const inst: any = instById.get(ref.instanceId);
    const part = (lib.parts ?? []).find((p: any) => p.id === inst?.partId);
    const sym = (lib.symbols ?? []).find((x: any) => x.id === part?.symbolId);
    const pin = sym?.pins?.find((x: any) => x.number === ref.pin);
    if (!inst || !pin) return null;
    const x0 = inst.mirrored ? -pin.x : pin.x, y0 = pin.y;
    const rot = inst.rotation;
    const [x, y] = rot === 90 ? [-y0, x0] : rot === 180 ? [-x0, -y0] : rot === 270 ? [y0, -x0] : [x0, y0];
    return { x: inst.position.x + x, y: inst.position.y + y };
  };
  let auto = 0;
  const used = new Set((sch.nets ?? []).map((n: any) => n.name).filter(Boolean));
  for (const net of sch.nets ?? []) {
    const parts = new Map<string, Array<{ instanceId: string; pin: string }>>();
    for (const c of net.connections ?? []) {
      const k = wired.has(pk(c)) ? `w:${find(pk(c))}` : `s:${pk(c)}`;
      parts.set(k, [...(parts.get(k) ?? []), c]);
    }
    const list = [...parts.values()];
    const hasGround = (g: Array<{ instanceId: string }>) => g.some((c) => groundParts.has((instById.get(c.instanceId) as any)?.partId));
    let name: string | null = net.name ?? null;
    const need = (g: Array<{ instanceId: string; pin: string }>) =>
      list.length > 1 || (name !== null && !(name === 'GND' && hasGround(g))) || (g.length === 1 && !wired.has(pk(g[0]!)));
    if (!list.some(need)) continue;
    if (name === null || /\s/.test(name)) {
      do { auto += 1; name = `N${auto}`; } while (used.has(name));
      used.add(name);
    }
    for (const g of list) {
      const at = pinPos(g[0]!);
      if (!at) continue;
      const id = cryptoId();
      const pos = { x: at.x, y: at.y - 20 };
      labels.push({ id, name, kind: 'net', position: pos, rotation: 0 });
      wires.push({ id: cryptoId(), a: { kind: 'pin', instanceId: g[0]!.instanceId, pin: g[0]!.pin }, b: { kind: 'label', labelId: id }, points: [at, pos], manual: true });
    }
  }
  const doc = {
    ...r,
    schemaVersion: 4,
    schematic: {
      instances: sch.instances ?? [], nets: sch.nets ?? [], wires, junctions: [], labels, groups: [],
      annotations: sch.annotations ?? [], sheet: { ...DEFAULT_SHEET },
    },
  };
  return rebuildNets(doc as unknown as ProjectDoc) as unknown as Record<string, unknown>;
}

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
