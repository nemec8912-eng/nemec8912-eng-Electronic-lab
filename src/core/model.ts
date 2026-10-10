/**
 * Модель документа проекта, schemaVersion 2 (v1 → v2: геометрия площадок, концы проводов и дорожек,
 * модель «земля», настройки расчёта).
 * Единственный источник истины для схемы, библиотеки, платы, испытаний и истории.
 * Описание полей и инвариантов — docs/ARCHITECTURE.md, раздел 2.
 */
import { z } from 'zod';
import { isUuid } from './ids';

export const CURRENT_SCHEMA_VERSION = 3 as const;

const Id = z.string().refine(isUuid, { message: 'некорректный UUID' });
const IsoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: 'некорректная дата' });
const Finite = z.number().finite();

export const PointSchema = z.object({ x: Finite, y: Finite }).strict();

/** Значение в базовых единицах СИ: 47 мкФ → { value: 4.7e-5, unit: 'F' }. */
export const QuantitySchema = z.object({ value: Finite, unit: z.string().max(16) }).strict();

const Rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const PinElectricalType = z.enum([
  'input', 'output', 'bidirectional', 'power-in', 'power-out', 'ground', 'passive', 'nc',
]);

// ---------- Схема ----------

export const ComponentInstanceSchema = z.object({
  id: Id,
  partId: Id,
  refDes: z.string().min(1).max(32),
  position: PointSchema,
  rotation: Rotation,
  mirrored: z.boolean(),
  values: z.record(z.string(), QuantitySchema),
}).strict();

export const PinRefSchema = z.object({ instanceId: Id, pin: z.string().min(1).max(16) }).strict();

export const NetSchema = z.object({
  id: Id,
  name: z.string().max(64).nullable(),
  connections: z.array(PinRefSchema),
}).strict();

/**
 * Провод — графика соединения двух выводов. Электрическая связность — в сетях (nets);
 * концы from/to говорят, какое соединение провод изображает. null — провод из формата v1 без концов.
 */
export const WireSchema = z.object({
  id: Id,
  netId: Id,
  from: PinRefSchema.nullable(),
  to: PinRefSchema.nullable(),
  points: z.array(PointSchema).min(2),
}).strict();

export const AnnotationSchema = z.object({
  id: Id,
  kind: z.literal('text'),
  text: z.string().max(10_000),
  position: PointSchema,
  targetId: Id.nullable(),
}).strict();

// ---------- Библиотека проекта (встроенные определения) ----------

export const SymbolDefSchema = z.object({
  id: Id,
  name: z.string().min(1).max(128),
  standard: z.string().max(64),
  /** Как рисовать: ключ встроенного изображения (iec-resistor, iec-capacitor, iec-dc-source, ground, box). */
  graphic: z.string().min(1).max(64),
  /** x, y — точка подключения вывода в единицах полотна относительно начала символа (до поворота). */
  pins: z.array(z.object({
    number: z.string().min(1).max(16),
    name: z.string().max(64),
    electricalType: PinElectricalType,
    x: Finite,
    y: Finite,
    /** Функция вывода (для микросхем): «вход запуска», «питание +5…15 В» и т. п. */
    description: z.string().max(500),
  }).strict()),
  /** Корпус обобщённого символа (graphic = 'box') в единицах полотна; null — по выводам. */
  box: z.object({ x: Finite, y: Finite, w: Finite.positive(), h: Finite.positive() }).strict().nullable(),
}).strict();

export const PackageDefSchema = z.object({
  id: Id,
  name: z.string().min(1).max(128),
  family: z.string().max(32),
  /** Площадки в мм относительно начала координат корпуса; drill = null — SMD. */
  pads: z.array(z.object({
    number: z.string().min(1).max(16),
    x: Finite,
    y: Finite,
    shape: z.enum(['round', 'rect', 'oval']),
    w: Finite.positive(),
    h: Finite.positive(),
    drill: Finite.positive().nullable(),
  }).strict()),
  /** Контур корпуса для шелкографии, мм (прямоугольник вокруг начала координат). */
  body: z.object({ x: Finite, y: Finite, w: Finite.positive(), h: Finite.positive() }).strict().nullable(),
  /** Как найти первый вывод: «выемка слева», «точка у вывода 1», «скос корпуса» и т. п. */
  pin1Marker: z.string().max(200).nullable(),
  mount: z.enum(['THT', 'SMD']),
  /** Шаг выводов, мм (null — нерегулярный). */
  pitchMm: Finite.positive().nullable(),
  /** Порядок нумерации выводов словами: «против часовой стрелки от ключа, вид сверху». */
  numbering: z.string().max(200).nullable(),
  /** Параметры генератора, из которых построен корпус (для повторного редактирования); null — задан вручную. */
  generator: z.object({ family: z.string().min(1).max(32), params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])) }).strict().nullable(),
}).strict();

export const SimModelSchema = z.object({
  id: Id,
  name: z.string().min(1).max(128),
  /**
   * spice-primitive: шаблон строки netlist; ground: вывод — опорный узел 0;
   * connector: электрического элемента нет (разъём, клеммник) — выводы лишь продолжают цепи.
   */
  kind: z.enum(['spice-primitive', 'spice-subckt', 'ground', 'connector']),
  text: z.string().max(1_000_000),
  source: z.string().max(1024).nullable(),
  verified: z.boolean(),
}).strict();

export const PartDefSchema = z.object({
  id: Id,
  name: z.string().min(1).max(128),
  category: z.string().max(64),
  manufacturer: z.string().max(128).nullable(),
  partNumber: z.string().max(128).nullable(),
  symbolId: Id,
  packages: z.array(z.object({
    packageId: Id,
    pinMap: z.array(z.object({ symbolPin: z.string().min(1), pad: z.string().min(1) }).strict()),
  }).strict()),
  modelId: Id.nullable(),
  /** Префикс позиционного обозначения (ГОСТ 2.710): R, C, L, VD, VT, DA, DD, FU, K, T, X, SA… */
  refPrefix: z.string().regex(/^[A-Za-zА-Яа-яЁё]{1,4}$/),
  /** Краткое назначение: «таймер», «выпрямительный диод 1 А». */
  description: z.string().max(2000),
  /** Маркировка на корпусе (может отличаться от партномера). */
  marking: z.string().max(64).nullable(),
  /** Номинальные значения детали (сопротивление, ёмкость…); экземпляр на схеме получает их при размещении. */
  values: z.record(z.string(), QuantitySchema),
  /** Предельные параметры: power (Вт), voltage (В), current (А), reverseVoltage (В)… */
  ratings: z.record(z.string(), QuantitySchema),
  /** Допуск номинала, ± %. */
  tolerancePct: Finite.nonnegative().nullable(),
  /** Рабочая температура, °C. */
  temperature: z.object({ minC: Finite, maxC: Finite }).strict().nullable(),
  polarized: z.boolean(),
  datasheetUrl: z.string().max(2048).regex(/^https?:\/\/\S+$/, 'ссылка должна начинаться с http:// или https://').nullable(),
  origin: z.object({
    catalogPartId: Id.nullable(),
    source: z.string().max(1024).nullable(),
    /** Лицензия источника данных (для импортированных сведений). */
    license: z.string().max(256).nullable(),
    /** Пользователь сверил сведения с даташитом. Импортированное и встроенное по умолчанию не проверено. */
    verified: z.boolean(),
    checkedAt: IsoDate.nullable(),
    notes: z.string().max(4000),
  }).strict(),
}).strict();

// ---------- Плата ----------

export const PadRefSchema = z.object({ placementId: Id, pad: z.string().min(1).max(16) }).strict();

export const PcbSchema = z.object({
  board: z.object({
    id: Id,
    widthMm: Finite.positive(),
    heightMm: Finite.positive(),
    layers: z.union([z.literal(1), z.literal(2)]),
  }).strict().nullable(),
  placements: z.array(z.object({
    id: Id, instanceId: Id, packageId: Id, position: PointSchema, rotation: Rotation,
    side: z.enum(['top', 'bottom']),
  }).strict()),
  tracks: z.array(z.object({
    id: Id, netId: Id, layer: z.enum(['top', 'bottom']), widthMm: Finite.positive(),
    from: PadRefSchema.nullable(),
    to: PadRefSchema.nullable(),
    points: z.array(PointSchema).min(2),
  }).strict()),
  vias: z.array(z.object({
    id: Id, netId: Id, position: PointSchema, drillMm: Finite.positive(), diameterMm: Finite.positive(),
  }).strict()),
}).strict();

// ---------- Испытания, вложения, журнал изменений ----------

export const TestRecordSchema = z.object({
  id: Id,
  createdAt: IsoDate,
  revision: z.number().int().nonnegative(),
  conditions: z.string().max(10_000),
  notes: z.string().max(100_000),
  measurements: z.array(z.object({
    id: Id, target: z.string().max(128), quantity: QuantitySchema, instrument: z.string().max(128),
  }).strict()),
}).strict();

export const AttachmentRefSchema = z.object({
  id: Id,
  // Имя файла без путей и символов, недопустимых в Windows: оно же используется как путь внутри .elab.
  fileName: z.string().min(1).max(120).regex(/^[^\u0000-\u001f<>:"/\\|?*]+$/).refine((n) => !/[. ]$/.test(n) && n !== '.' && n !== '..', { message: 'недопустимое имя файла' }),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().max(128),
}).strict();

export const ChangeEntrySchema = z.object({
  id: Id,
  at: IsoDate,
  revision: z.number().int().nonnegative(),
  action: z.string().min(1).max(64),
  summary: z.string().max(1000),
}).strict();

// ---------- Настройки расчёта ----------

export const SimulationSettingsSchema = z.object({
  /**
   * Переходный процесс: время моделирования и шаг вывода, секунды.
   * startFromZero — «включение питания при t = 0»: конденсаторы разряжены (ngspice: uic);
   * иначе расчёт начинается из установившейся рабочей точки.
   */
  tran: z.object({ stopS: Finite.positive(), stepS: Finite.positive(), startFromZero: z.boolean() }).strict(),
}).strict();
export const DEFAULT_SIMULATION = { tran: { stopS: 0.01, stepS: 1e-5, startFromZero: true } };

// ---------- Документ ----------

export const ProjectDocSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: Id,
  name: z.string().min(1).max(200),
  description: z.string().max(100_000),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  revision: z.number().int().nonnegative(),
  schematic: z.object({
    instances: z.array(ComponentInstanceSchema),
    nets: z.array(NetSchema),
    wires: z.array(WireSchema),
    annotations: z.array(AnnotationSchema),
  }).strict(),
  library: z.object({
    symbols: z.array(SymbolDefSchema),
    parts: z.array(PartDefSchema),
    packages: z.array(PackageDefSchema),
    models: z.array(SimModelSchema),
  }).strict(),
  pcb: PcbSchema,
  instruments: z.object({ settings: z.record(z.string(), z.unknown()) }).strict(),
  simulation: SimulationSettingsSchema,
  tests: z.array(TestRecordSchema),
  attachments: z.array(AttachmentRefSchema),
  changelog: z.array(ChangeEntrySchema),
}).strict();

export type Point = z.infer<typeof PointSchema>;
export type Quantity = z.infer<typeof QuantitySchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type PinRef = z.infer<typeof PinRefSchema>;
export type PadRef = z.infer<typeof PadRefSchema>;
export type ComponentInstance = z.infer<typeof ComponentInstanceSchema>;
export type Net = z.infer<typeof NetSchema>;
export type Wire = z.infer<typeof WireSchema>;
export type SymbolDef = z.infer<typeof SymbolDefSchema>;
export type PackageDef = z.infer<typeof PackageDefSchema>;
export type SimModel = z.infer<typeof SimModelSchema>;
export type PartDef = z.infer<typeof PartDefSchema>;
export type Pcb = z.infer<typeof PcbSchema>;
export type Placement = Pcb['placements'][number];
export type Track = Pcb['tracks'][number];
export type SimulationSettings = z.infer<typeof SimulationSettingsSchema>;
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;

/** Контрольная версия — постоянный снимок документа. */
export const CheckpointSchema = z.object({
  id: Id,
  label: z.string().max(200),
  kind: z.enum(['manual', 'on-save', 'before-restore']),
  createdAt: IsoDate,
  revision: z.number().int().nonnegative(),
  doc: z.unknown(),
}).strict();
export type Checkpoint = Omit<z.infer<typeof CheckpointSchema>, 'doc'> & { doc: ProjectDoc };
export type CheckpointInfo = Omit<Checkpoint, 'doc'>;

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Проверка структуры документа (без проверки ссылок — см. integrity.ts). */
export function validateDocShape(input: unknown):
  { ok: true; doc: ProjectDoc } | { ok: false; issues: ValidationIssue[] } {
  const r = ProjectDocSchema.safeParse(input);
  if (r.success) return { ok: true, doc: r.data };
  return {
    ok: false,
    issues: r.error.issues.slice(0, 50).map((i) => ({
      path: i.path.length ? i.path.join('.') : '(корень)',
      message: i.message,
    })),
  };
}
