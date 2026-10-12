/**
 * Встроенные детали прототипа (этап 1b): резистор, конденсатор, источник постоянного напряжения, земля.
 * Это не каталог реальных компонентов (этап 2), а минимальный набор для сквозной проверки
 * «схема → расчёт ngspice → щупы → плата». При размещении определения копируются в библиотеку проекта,
 * поэтому проект остаётся самодостаточным; origin.catalogPartId указывает на встроенный шаблон.
 */
import type { PackageDef, PartDef, Quantity, SimModel, SymbolDef } from './model';

/** Параметры номиналов, которые подставляются в шаблоны моделей как {v:имя}. */
export interface ParamDef {
  key: string;
  label: string;
  unit: string; // единица СИ в данных
  unitRu: string; // подпись в интерфейсе
  min: number; // строго больше (для signed — не меньше)
  max: number;
  /** Может быть нулём и отрицательным (напряжение, ток источника, смещение). */
  signed?: boolean;
}

export const PARAMS: Record<string, ParamDef> = {
  resistance: { key: 'resistance', label: 'Сопротивление', unit: 'Ω', unitRu: 'Ом', min: 0, max: 1e12 },
  capacitance: { key: 'capacitance', label: 'Ёмкость', unit: 'F', unitRu: 'Ф', min: 0, max: 10 },
  voltage: { key: 'voltage', label: 'Напряжение', unit: 'V', unitRu: 'В', min: -1e4, max: 1e4, signed: true },
  amplitude: { key: 'amplitude', label: 'Амплитуда', unit: 'V', unitRu: 'В', min: 0, max: 1e4 },
  offset: { key: 'offset', label: 'Постоянная составляющая', unit: 'V', unitRu: 'В', min: -1e4, max: 1e4, signed: true },
  frequency: { key: 'frequency', label: 'Частота', unit: 'Hz', unitRu: 'Гц', min: 0, max: 1e9 },
  duty: { key: 'duty', label: 'Заполнение', unit: '%', unitRu: '%', min: 1, max: 99 },
  current: { key: 'current', label: 'Ток', unit: 'A', unitRu: 'А', min: -1e3, max: 1e3, signed: true },
  currentLimit: { key: 'currentLimit', label: 'Ограничение тока', unit: 'A', unitRu: 'А', min: 0, max: 100 },
  /** Выход блока питания: 1 — включён, 0 — выключен (переключается кнопкой на панели прибора). */
  enabled: { key: 'enabled', label: 'Выход включён (1/0)', unit: '', unitRu: '', min: 0, max: 1, signed: true },
  esr: { key: 'esr', label: 'ESR (эквивалентное последовательное сопротивление)', unit: 'Ω', unitRu: 'Ом', min: 0, max: 1e6 },
  inductance: { key: 'inductance', label: 'Индуктивность', unit: 'H', unitRu: 'Гн', min: 0, max: 1e4 },
  zenerVoltage: { key: 'zenerVoltage', label: 'Напряжение стабилизации', unit: 'V', unitRu: 'В', min: 0, max: 1e3 },
  /** Положение движка потенциометра: 0 % — у вывода 1, 100 % — у вывода 3. */
  position: { key: 'position', label: 'Положение движка (0 % — у вывода 1)', unit: '%', unitRu: '%', min: 0, max: 100, signed: true },
  turnsRatio: { key: 'turnsRatio', label: 'Коэффициент трансформации (первичная / вторичная)', unit: '', unitRu: '', min: 0.001, max: 1e4 },
  temperature: { key: 'temperature', label: 'Температура датчика', unit: '°C', unitRu: '°C', min: -55, max: 200, signed: true },
  illuminance: { key: 'illuminance', label: 'Освещённость', unit: 'lx', unitRu: 'лк', min: 0.01, max: 1e5 },
  /** Кнопка или выключатель: 1 — замкнут, 0 — разомкнут. */
  coilResistance: { key: 'coilResistance', label: 'Сопротивление катушки', unit: 'Ω', unitRu: 'Ом', min: 0, max: 1e6 },
  pullIn: { key: 'pullIn', label: 'Напряжение срабатывания', unit: 'V', unitRu: 'В', min: 0, max: 1000 },
  dropOut: { key: 'dropOut', label: 'Напряжение отпускания', unit: 'V', unitRu: 'В', min: 0, max: 1000 },
  clampVoltage: { key: 'clampVoltage', label: 'Напряжение классификации (при 1 мА)', unit: 'V', unitRu: 'В', min: 0, max: 1e5 },
  closed: { key: 'closed', label: 'Замкнут (1/0)', unit: '', unitRu: '', min: 0, max: 1, signed: true },
};

/** Пределы деталей (ratings) — для предупреждений о перегрузке. */
export const RATINGS: Record<string, { label: string; unit: string; unitRu: string }> = {
  power: { label: 'Допустимая мощность', unit: 'W', unitRu: 'Вт' },
  voltage: { label: 'Допустимое напряжение', unit: 'V', unitRu: 'В' },
  current: { label: 'Допустимый ток', unit: 'A', unitRu: 'А' },
  reverseVoltage: { label: 'Максимальное обратное напряжение', unit: 'V', unitRu: 'В' },
  surgeCurrent: { label: 'Ударный ток', unit: 'A', unitRu: 'А' },
  vce: { label: 'Напряжение коллектор–эмиттер', unit: 'V', unitRu: 'В' },
  vds: { label: 'Напряжение сток–исток', unit: 'V', unitRu: 'В' },
  rdsOn: { label: 'Сопротивление открытого канала', unit: 'Ω', unitRu: 'Ом' },
  supplyMin: { label: 'Питание, минимум', unit: 'V', unitRu: 'В' },
  supplyMax: { label: 'Питание, максимум', unit: 'V', unitRu: 'В' },
  outputMin: { label: 'Выходное напряжение, минимум', unit: 'V', unitRu: 'В' },
  outputMax: { label: 'Выходное напряжение, максимум', unit: 'V', unitRu: 'В' },
};

export interface BuiltinPart {
  /** Стабильный идентификатор шаблона (UUID), попадает в origin.catalogPartId. */
  catalogId: string;
  refPrefix: string;
  part: Omit<PartDef, 'id' | 'symbolId' | 'modelId' | 'packages'>;
  symbol: Omit<SymbolDef, 'id'>;
  packages: Array<{ pkg: Omit<PackageDef, 'id'>; pinMap: Array<{ symbolPin: string; pad: string }> }>;
  model: Omit<SimModel, 'id'> | null;
  defaults: Record<string, Quantity>;
}

const TWO_PIN_THT = (name: string, pitch: number, body: PackageDef['body']): Omit<PackageDef, 'id'> => ({
  name,
  family: 'THT',
  pin1Marker: null,
  mount: 'THT',
  pitchMm: pitch,
  numbering: null,
  generator: null,
  body,
  pads: [
    { number: '1', x: 0, y: 0, shape: 'round', w: 1.8, h: 1.8, drill: 0.9 },
    { number: '2', x: pitch, y: 0, shape: 'round', w: 1.8, h: 1.8, drill: 0.9 },
  ],
});

const origin = (catalogId: string) => ({ catalogPartId: catalogId, source: 'встроенная идеальная деталь', license: null, verified: true, checkedAt: null, notes: 'Идеальная модель: без допусков, паразитных параметров и нагрева.' });

/** Нейтральные значения полей сведений о детали. */
export const PART_INFO_DEFAULTS = { marking: null, tolerancePct: null, temperature: null, polarized: false, datasheetUrl: null } as const;

export const BUILTIN_PARTS: BuiltinPart[] = [
  {
    catalogId: '0b6a9f1e-1c2d-4e3f-8a5b-6c7d8e9f0a11',
    refPrefix: 'R',
    part: { name: 'Резистор', category: 'resistor', refPrefix: 'R', description: 'Идеальный резистор', ...PART_INFO_DEFAULTS, values: { resistance: { value: 10_000, unit: 'Ω' } }, manufacturer: null, partNumber: null, ratings: { power: { value: 0.25, unit: 'W' } }, origin: origin('0b6a9f1e-1c2d-4e3f-8a5b-6c7d8e9f0a11') },
    symbol: { name: 'Резистор', standard: 'IEC 60617 / ГОСТ 2.728', graphic: 'iec-resistor', box: null, pins: [
      { number: '1', name: '1', electricalType: 'passive', x: -30, y: 0, description: '' },
      { number: '2', name: '2', electricalType: 'passive', x: 30, y: 0, description: '' },
    ] },
    packages: [{ pkg: TWO_PIN_THT('Выводной, шаг 10,16 мм (0,4")', 10.16, { x: 2.2, y: -1.25, w: 5.76, h: 2.5 }), pinMap: [{ symbolPin: '1', pad: '1' }, { symbolPin: '2', pad: '2' }] }],
    model: { name: 'Идеальный резистор', kind: 'spice-primitive', text: 'R {n:1} {n:2} {v:resistance}', source: 'ngspice: элемент R', verified: true },
    defaults: { resistance: { value: 10_000, unit: 'Ω' } },
  },
  {
    catalogId: '1c7b0a2f-2d3e-4f40-9b6c-7d8e9f0a1b22',
    refPrefix: 'C',
    part: { name: 'Конденсатор неполярный', category: 'capacitor', refPrefix: 'C', description: 'Идеальный конденсатор', ...PART_INFO_DEFAULTS, values: { capacitance: { value: 100e-9, unit: 'F' } }, manufacturer: null, partNumber: null, ratings: { voltage: { value: 50, unit: 'V' } }, origin: origin('1c7b0a2f-2d3e-4f40-9b6c-7d8e9f0a1b22') },
    symbol: { name: 'Конденсатор', standard: 'IEC 60617 / ГОСТ 2.728', graphic: 'iec-capacitor', box: null, pins: [
      { number: '1', name: '1', electricalType: 'passive', x: -30, y: 0, description: '' },
      { number: '2', name: '2', electricalType: 'passive', x: 30, y: 0, description: '' },
    ] },
    packages: [{ pkg: TWO_PIN_THT('Радиальный, шаг 5,08 мм', 5.08, { x: -1, y: -3, w: 7.08, h: 6 }), pinMap: [{ symbolPin: '1', pad: '1' }, { symbolPin: '2', pad: '2' }] }],
    model: { name: 'Идеальный конденсатор', kind: 'spice-primitive', text: 'C {n:1} {n:2} {v:capacitance}', source: 'ngspice: элемент C', verified: true },
    defaults: { capacitance: { value: 100e-9, unit: 'F' } },
  },
  {
    catalogId: '2d8c1b30-3e4f-4051-8c7d-8e9f0a1b2c33',
    refPrefix: 'V',
    part: { name: 'Источник постоянного напряжения', category: 'source', refPrefix: 'V', description: 'Идеальный источник ЭДС', ...PART_INFO_DEFAULTS, values: { voltage: { value: 5, unit: 'V' } }, manufacturer: null, partNumber: null, ratings: {}, origin: origin('2d8c1b30-3e4f-4051-8c7d-8e9f0a1b2c33') },
    symbol: { name: 'Источник ЭДС', standard: 'IEC 60617 / ГОСТ 2.728', graphic: 'iec-dc-source', box: null, pins: [
      { number: '+', name: '+', electricalType: 'power-out', x: 0, y: -30, description: '' },
      { number: '-', name: '−', electricalType: 'power-out', x: 0, y: 30, description: '' },
    ] },
    // На плате источник — внешний блок питания, подключаемый к клеммнику.
    packages: [{ pkg: TWO_PIN_THT('Клеммник 2 конт., шаг 5,08 мм', 5.08, { x: -2.5, y: -4, w: 10.08, h: 8 }), pinMap: [{ symbolPin: '+', pad: '1' }, { symbolPin: '-', pad: '2' }] }],
    model: { name: 'Идеальный источник напряжения', kind: 'spice-primitive', text: 'V {n:+} {n:-} DC {v:voltage}', source: 'ngspice: элемент V', verified: true },
    defaults: { voltage: { value: 5, unit: 'V' } },
  },
  {
    catalogId: '3e9d2c41-4f50-4162-9d8e-9f0a1b2c3d44',
    refPrefix: 'GND',
    part: { name: 'Земля (общий провод)', category: 'reference', refPrefix: 'GND', description: 'Опорный узел схемы (0 В)', ...PART_INFO_DEFAULTS, values: {}, manufacturer: null, partNumber: null, ratings: {}, origin: origin('3e9d2c41-4f50-4162-9d8e-9f0a1b2c3d44') },
    symbol: { name: 'Земля', standard: 'IEC 60617 / ГОСТ 2.721', graphic: 'ground', box: null, pins: [
      { number: '1', name: 'GND', electricalType: 'ground', x: 0, y: -10, description: '' },
    ] },
    packages: [], // на плате не размещается
    model: { name: 'Опорный узел 0', kind: 'ground', text: '', source: 'ngspice: узел 0', verified: true },
    defaults: {},
  },
];

export const builtinByCatalogId = (id: string) => BUILTIN_PARTS.find((b) => b.catalogId === id);

/** Параметры, которые требует модель: {v:resistance} → ['resistance']. */
export function modelParams(model: SimModel | undefined): string[] {
  if (!model || (model.kind !== 'spice-primitive' && model.kind !== 'spice-subckt')) return [];
  const keys = new Set<string>();
  for (const m of model.text.matchAll(/\{v:([A-Za-z_]+)\}/g)) keys.add(m[1]!);
  // Имена параметров внутри выражений {e:…}: duty/100/frequency → duty, frequency.
  for (const m of model.text.matchAll(/\{e:([^}]+)\}/g)) for (const w of m[1]!.matchAll(/[A-Za-z_]+/g)) if (PARAMS[w[0]]) keys.add(w[0]);
  return [...keys];
}

/** Значение параметра в допустимых пределах? */
export function paramInRange(key: string, v: number): boolean {
  const d = PARAMS[key];
  if (!d) return Number.isFinite(v);
  return d.signed ? v >= d.min && v <= d.max : v > d.min && v <= d.max;
}

// ---------- Форматирование величин ----------

const PREFIXES: Array<[number, string]> = [[1e9, 'Г'], [1e6, 'М'], [1e3, 'к'], [1, ''], [1e-3, 'м'], [1e-6, 'мк'], [1e-9, 'н'], [1e-12, 'п']];

/** 4.7e-5, 'Ф' → «47 мкФ»; 10000, 'Ом' → «10 кОм». */
export function formatQuantity(value: number, unitRu: string, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return `0 ${unitRu}`;
  const abs = Math.abs(value);
  const [mul, pre] = PREFIXES.find(([m]) => abs >= m * 0.9995) ?? PREFIXES[PREFIXES.length - 1]!;
  const n = Number((value / mul).toPrecision(digits));
  return `${String(n).replace('.', ',')} ${pre}${unitRu}`;
}

const PARSE_PREFIX: Record<string, number> = {
  'Г': 1e9, 'G': 1e9, 'М': 1e6, 'M': 1e6, 'к': 1e3, 'k': 1e3, 'K': 1e3, 'м': 1e-3, 'm': 1e-3,
  'мк': 1e-6, 'u': 1e-6, 'µ': 1e-6, 'μ': 1e-6, 'н': 1e-9, 'n': 1e-9, 'п': 1e-12, 'p': 1e-12,
};

/**
 * Разбор ввода пользователя: «47 мк», «47мкФ», «4,7k», «10к», «0.1u», «2.2e-6». Регистр важен:
 * «М» — мега, «м» — милли (как в обозначениях). Возвращает null, если ввод не понят.
 */
export function parseQuantity(input: string, unitRu: string): number | null {
  let s = input.trim().replace(/\s+/g, '').replace(',', '.');
  for (const u of [unitRu, unitRu.toLowerCase(), 'Ohm', 'ohm', 'Ω', 'F', 'V']) if (u && s.endsWith(u)) { s = s.slice(0, -u.length); break; }
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(мк|[ГGМMкkKмmuµμнnпp])?$/.exec(s);
  if (!m) return null;
  // Округление убирает хвосты двоичной арифметики: 100 × 1e-9 → 1e-7, а не 1.0000000000000001e-7.
  const v = Number((Number(m[1]) * (m[2] ? PARSE_PREFIX[m[2]]! : 1)).toPrecision(15));
  return Number.isFinite(v) ? v : null;
}
