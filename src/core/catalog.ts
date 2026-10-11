/**
 * Каталог деталей (этап 2). Деталь хранится «комплектом»: сведения о детали, символ (УГО), корпуса с явным
 * соответствием «вывод символа ↔ площадка» и электрическая модель (может отсутствовать). Каталог бывает
 * встроенный (только чтение) и личный (library/catalog.json). При размещении на схеме комплект копируется
 * в библиотеку проекта, поэтому проект самодостаточен и не меняется молча при правке каталога.
 */
import { z } from 'zod';
import { checkIntegrity, type IntegrityIssue } from './integrity';
import { isUuid } from './ids';
import { checkModelTemplate, templatePins } from './spice';
import { formatQuantity, parseQuantity, PARAMS, type BuiltinPart } from './library';
import { upgradeLibraryV2toV3 } from './migrations';
import {
  CURRENT_SCHEMA_VERSION, PackageDefSchema, PartDefSchema, SimModelSchema, SymbolDefSchema,
  type PackageDef, type PartDef, type ProjectDoc, type SimModel, type SymbolDef,
} from './model';
import { emptyCollections } from './factory';

export const CATALOG_VERSION = 2;

export type Library = ProjectDoc['library'];

export interface PartBundle {
  part: PartDef;
  symbol: SymbolDef;
  packages: PackageDef[];
  model: SimModel | null;
}

export const CatalogFileSchema = z.object({
  schemaVersion: z.literal(CATALOG_VERSION),
  symbols: z.array(SymbolDefSchema),
  parts: z.array(PartDefSchema),
  packages: z.array(PackageDefSchema),
  models: z.array(SimModelSchema),
}).strict();
export type CatalogFile = z.infer<typeof CatalogFileSchema>;

export const emptyCatalog = (): CatalogFile => ({ schemaVersion: CATALOG_VERSION, symbols: [], parts: [], packages: [], models: [] });

/** Категории (ГОСТ 2.710 — буквенные коды позиционных обозначений). */
export const CATEGORIES: Array<{ id: string; label: string; prefix: string }> = [
  { id: 'resistor', label: 'Резисторы', prefix: 'R' },
  { id: 'capacitor', label: 'Конденсаторы неполярные', prefix: 'C' },
  { id: 'capacitor-polar', label: 'Конденсаторы полярные', prefix: 'C' },
  { id: 'inductor', label: 'Катушки и дроссели', prefix: 'L' },
  { id: 'diode', label: 'Диоды', prefix: 'VD' },
  { id: 'zener', label: 'Стабилитроны', prefix: 'VD' },
  { id: 'led', label: 'Светодиоды', prefix: 'HL' },
  { id: 'bridge', label: 'Диодные мосты', prefix: 'VD' },
  { id: 'bjt', label: 'Биполярные транзисторы', prefix: 'VT' },
  { id: 'mosfet', label: 'Полевые транзисторы (MOSFET)', prefix: 'VT' },
  { id: 'thyristor', label: 'Тиристоры', prefix: 'VS' },
  { id: 'triac', label: 'Симисторы', prefix: 'VS' },
  { id: 'varistor', label: 'Варисторы', prefix: 'RU' },
  { id: 'fuse', label: 'Предохранители', prefix: 'FU' },
  { id: 'relay', label: 'Реле', prefix: 'K' },
  { id: 'transformer', label: 'Трансформаторы', prefix: 'T' },
  { id: 'connector', label: 'Разъёмы и клеммники', prefix: 'X' },
  { id: 'switch', label: 'Переключатели и кнопки', prefix: 'SA' },
  { id: 'source', label: 'Источники', prefix: 'G' },
  { id: 'sensor', label: 'Датчики', prefix: 'B' },
  { id: 'ic-analog', label: 'Аналоговые микросхемы', prefix: 'DA' },
  { id: 'ic-digital', label: 'Цифровые микросхемы', prefix: 'DD' },
  { id: 'mcu', label: 'Микроконтроллеры', prefix: 'DD' },
  { id: 'reference', label: 'Опорный узел (земля)', prefix: 'GND' },
  { id: 'other', label: 'Прочее', prefix: 'U' },
];
export const categoryLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;

// ---------- Загрузка файла каталога ----------

export type CatalogLoad = { ok: true; catalog: CatalogFile; migratedFrom: number | null } | { ok: false; message: string; details: string[] };

export function loadCatalog(raw: unknown): CatalogLoad {
  const r = (raw ?? {}) as Record<string, unknown>;
  const v = typeof r.schemaVersion === 'number' ? r.schemaVersion : null;
  if (v === null) return { ok: false, message: 'Файл каталога повреждён: нет версии формата', details: [] };
  if (v > CATALOG_VERSION) return { ok: false, message: `Каталог создан более новой версией программы (формат ${v}). Обновите программу.`, details: [] };
  let cur: Record<string, unknown> = structuredClone(r);
  if (v === 1) cur = { ...upgradeLibraryV2toV3(cur as Record<string, unknown>), schemaVersion: 2 };
  const parsed = CatalogFileSchema.safeParse(cur);
  if (!parsed.success) {
    return { ok: false, message: 'Файл каталога повреждён', details: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const issues = checkLibrary(parsed.data);
  if (issues.length) return { ok: false, message: 'Нарушена целостность каталога', details: issues.slice(0, 20).map((i) => i.message) };
  return { ok: true, catalog: parsed.data, migratedFrom: v === CATALOG_VERSION ? null : v };
}

const LIB_DOC_ID = '00000000-0000-4000-8000-000000000001';

/** Проверка ссылочной целостности библиотеки: та же, что для библиотеки проекта. */
export function checkLibrary(lib: Library): IntegrityIssue[] {
  const now = new Date(0).toISOString();
  const doc: ProjectDoc = {
    schemaVersion: CURRENT_SCHEMA_VERSION, id: LIB_DOC_ID, name: 'каталог', description: '', createdAt: now, updatedAt: now, revision: 0,
    ...emptyCollections(),
    library: { symbols: lib.symbols, parts: lib.parts, packages: lib.packages, models: lib.models },
  };
  return checkIntegrity(doc);
}

// ---------- Комплекты ----------

export function bundleOf(lib: Library, partId: string): PartBundle | null {
  const part = lib.parts.find((p) => p.id === partId);
  if (!part) return null;
  const symbol = lib.symbols.find((s) => s.id === part.symbolId);
  if (!symbol) return null;
  const packages = part.packages.map((pk) => lib.packages.find((x) => x.id === pk.packageId)).filter((x): x is PackageDef => !!x);
  const model = part.modelId ? lib.models.find((m) => m.id === part.modelId) ?? null : null;
  return { part, symbol, packages, model };
}

/** Добавить или заменить комплект (по id детали). Неиспользуемые символы, корпуса и модели удаляются. */
export function upsertBundle(cat: CatalogFile, b: PartBundle): CatalogFile {
  const replace = <T extends { id: string }>(list: T[], items: T[]) => [...list.filter((x) => !items.some((i) => i.id === x.id)), ...items];
  const next: CatalogFile = {
    ...cat,
    parts: replace(cat.parts, [b.part]),
    symbols: replace(cat.symbols, [b.symbol]),
    packages: replace(cat.packages, b.packages),
    models: b.model ? replace(cat.models, [b.model]) : cat.models,
  };
  return collectGarbage(next);
}

export function removePart(cat: CatalogFile, partId: string): CatalogFile {
  return collectGarbage({ ...cat, parts: cat.parts.filter((p) => p.id !== partId) });
}

function collectGarbage(cat: CatalogFile): CatalogFile {
  const usedSym = new Set(cat.parts.map((p) => p.symbolId));
  const usedPkg = new Set(cat.parts.flatMap((p) => p.packages.map((x) => x.packageId)));
  const usedModel = new Set(cat.parts.map((p) => p.modelId).filter(Boolean) as string[]);
  return {
    ...cat,
    symbols: cat.symbols.filter((s) => usedSym.has(s.id)),
    packages: cat.packages.filter((p) => usedPkg.has(p.id)),
    models: cat.models.filter((m) => usedModel.has(m.id)),
  };
}

// ---------- Проверки детали для редактора ----------

export interface PartLint { severity: 'error' | 'warning'; field: string; message: string }

/**
 * Проверки, которые показываются в редакторе детали. Ошибки не дают сохранить деталь; предупреждения —
 * честные оговорки (нет модели, сведения не проверены, нет ключа первого вывода).
 */
export function lintBundle(b: PartBundle, others: PartDef[] = [], builtin: PartDef[] = []): PartLint[] {
  const out: PartLint[] = [];
  const err = (field: string, message: string) => out.push({ severity: 'error', field, message });
  const warn = (field: string, message: string) => out.push({ severity: 'warning', field, message });
  const p = b.part;
  if (!p.name.trim()) err('name', 'Укажите название');
  if (p.partNumber) {
    const dup = others.find((o) => o.id !== p.id && o.partNumber && o.partNumber.toUpperCase() === p.partNumber!.toUpperCase()
      && (o.manufacturer ?? '').toUpperCase() === (p.manufacturer ?? '').toUpperCase());
    if (dup) err('partNumber', `Деталь ${p.partNumber}${p.manufacturer ? ` (${p.manufacturer})` : ''} уже есть в каталоге: «${dup.name}»`);
    const inBuiltin = builtin.find((o) => o.id !== p.id && o.partNumber?.toUpperCase() === p.partNumber!.toUpperCase());
    if (inBuiltin) warn('partNumber', `Во встроенном справочнике есть «${inBuiltin.name}» с тем же партномером — ваша деталь будет показана рядом с ней`);
  }
  // Выводы символа
  const nums = new Map<string, number>();
  for (const pin of b.symbol.pins) nums.set(pin.number, (nums.get(pin.number) ?? 0) + 1);
  for (const [n, c] of nums) if (c > 1) err('pins', `Номер вывода «${n}» повторяется`);
  if (b.symbol.pins.length === 0) err('pins', 'У детали нет выводов');
  for (const pin of b.symbol.pins) if (!pin.number.trim()) err('pins', 'Есть вывод без номера');
  const powerIn = b.symbol.pins.filter((x) => x.electricalType === 'power-in').length;
  const ground = b.symbol.pins.filter((x) => x.electricalType === 'ground').length;
  if ((p.category.startsWith('ic') || p.category === 'mcu') && powerIn === 0) warn('pins', 'У микросхемы нет вывода питания — проверьте типы выводов');
  if ((p.category.startsWith('ic') || p.category === 'mcu') && ground === 0) warn('pins', 'У микросхемы нет вывода «земля» — проверьте типы выводов');
  // Корпуса и соответствие выводов
  if (b.packages.length === 0 && p.category !== 'reference') warn('packages', 'Нет корпуса — деталь нельзя разместить на плате');
  for (const pkg of b.packages) {
    const ref = p.packages.find((x) => x.packageId === pkg.id);
    if (!ref) { err('packages', `Корпус ${pkg.name} не привязан к детали`); continue; }
    const pads = new Set(pkg.pads.map((x) => x.number));
    const padCounts = new Map<string, number>();
    for (const pad of pkg.pads) padCounts.set(pad.number, (padCounts.get(pad.number) ?? 0) + 1);
    for (const [n, c] of padCounts) if (c > 1) err('packages', `${pkg.name}: номер площадки «${n}» повторяется`);
    const mappedPins = new Set<string>();
    const mappedPads = new Set<string>();
    for (const m of ref.pinMap) {
      if (!nums.has(m.symbolPin)) err('pinmap', `${pkg.name}: вывода символа «${m.symbolPin}» нет`);
      if (!pads.has(m.pad)) err('pinmap', `${pkg.name}: площадки «${m.pad}» нет в корпусе`);
      if (mappedPins.has(m.symbolPin)) err('pinmap', `${pkg.name}: вывод «${m.symbolPin}» назначен на несколько площадок`);
      if (mappedPads.has(m.pad)) err('pinmap', `${pkg.name}: на площадку «${m.pad}» назначено несколько выводов`);
      mappedPins.add(m.symbolPin); mappedPads.add(m.pad);
    }
    for (const pin of b.symbol.pins) if (!mappedPins.has(pin.number) && pin.electricalType !== 'nc') err('pinmap', `${pkg.name}: вывод ${pin.number} (${pin.name || 'без имени'}) не назначен ни на одну площадку`);
    const unused = pkg.pads.filter((x) => !mappedPads.has(x.number));
    if (unused.length) warn('pinmap', `${pkg.name}: площадки без вывода: ${unused.map((x) => x.number).join(', ')} (будут неподключёнными)`);
    if (pkg.pads.length > 2 && !pkg.pin1Marker) warn('packages', `${pkg.name}: не указан ключ первого вывода`);
  }
  if (b.model && (b.model.kind === 'spice-primitive' || b.model.kind === 'spice-subckt')) {
    for (const e of checkModelTemplate(b.model.text)) err('model', `Модель: ${e}`);
    for (const n of templatePins(b.model.text)) if (!nums.has(n)) err('model', `Модель подключается к выводу «${n}», которого нет у обозначения`);
  }
  if (!b.model) warn('model', 'Нет SPICE-модели — деталь не моделируется; схема с ней не рассчитывается');
  else if (!b.model.verified) warn('model', 'SPICE-модель не проверена');
  if (!p.origin.verified && p.category !== 'reference') warn('origin', 'Сведения не сверены с даташитом');
  if (p.datasheetUrl === null && p.partNumber) warn('datasheet', 'Нет ссылки на даташит');
  return out;
}

// ---------- Поиск ----------

/** Текст, по которому ищется деталь: название, партномер, маркировка, производитель, описание, корпуса, номиналы. */
function haystack(b: PartBundle): string {
  const values = Object.entries(b.part.values).map(([k, q]) => {
    const unit = PARAMS[k]?.unitRu ?? q.unit;
    return formatQuantity(q.value, unit);
  });
  return [b.part.name, b.part.partNumber, b.part.marking, b.part.manufacturer, b.part.description, categoryLabel(b.part.category),
    ...b.packages.map((p) => `${p.name} ${p.family}`), ...values].filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е');
}

/** Поиск: все слова запроса должны встретиться; число с единицей («47 мк», «10к») сравнивается с номиналами ±1 %. */
export function searchBundles(list: PartBundle[], query: string, category: string | null = null): PartBundle[] {
  const q = query.trim().toLowerCase().replace(/ё/g, 'е');
  const byCat = category ? list.filter((b) => b.part.category === category) : list;
  if (!q) return byCat;
  const words = q.split(/\s+/);
  return byCat.filter((b) => {
    const h = haystack(b);
    return words.every((w) => {
      if (h.includes(w)) return true;
      const v = parseQuantity(w, '');
      if (v === null || v === 0) return false;
      return Object.values(b.part.values).some((x) => Math.abs(x.value - v) <= Math.abs(v) * 0.01);
    });
  });
}

// ---------- Детерминированные UUID для встроенного каталога ----------

/** UUID из строки-«семени»: одинаковый при каждом запуске (для встроенных деталей). */
export function stableId(seed: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h3 = Math.imul(h3 + c, 0x27d4eb2d) >>> 0;
    h4 = Math.imul(h4 ^ (c + i), 0x165667b1) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  if (!isUuid(id)) throw new Error('stableId: некорректный UUID');
  return id;
}

/** Комплект встроенной детали. Id детали = catalogId (стабилен между версиями), остальные id — производные. */
export function builtinBundle(b: BuiltinPart): PartBundle {
  const symbolId = stableId(`${b.catalogId}/symbol`);
  const modelId = b.model ? stableId(`${b.catalogId}/model`) : null;
  const packages = b.packages.map((p, i) => ({ ...structuredClone(p.pkg), id: stableId(`${b.catalogId}/package/${i}`) }));
  return {
    part: {
      ...structuredClone(b.part),
      id: b.catalogId,
      symbolId,
      modelId,
      packages: b.packages.map((p, i) => ({ packageId: packages[i]!.id, pinMap: structuredClone(p.pinMap) })),
      origin: { ...b.part.origin, catalogPartId: b.catalogId },
    },
    symbol: { ...structuredClone(b.symbol), id: symbolId },
    packages,
    model: b.model && modelId ? { ...structuredClone(b.model), id: modelId } : null,
  };
}
