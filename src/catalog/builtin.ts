/**
 * Встроенный справочник деталей (только чтение). Две группы:
 *  • типовые детали — номинал задаёт пользователь на схеме (резистор, конденсатор, катушка, разъёмы…);
 *  • распространённые реальные детали — с партномером, разводкой корпуса и предельными параметрами
 *    по типовым данным даташитов. Все они помечены «не сверено с даташитом» (origin.verified = false):
 *    перед применением пользователь сверяет сведения с даташитом своего производителя.
 * SPICE-модели (этап 4) — src/catalog/spiceModels.ts: модели производителей и упрощённые/поведенческие модели
 * по даташиту, все помечены «не проверены». Простая логика КМОП, реле, тиристоры, оптопары — поведенческие модели.
 * Микроконтроллеры не моделируются — это показывается явно. Диодный мост рассчитывается моделью из четырёх
 * диодов, но корпус у него не задан: разводка выводов у мостов разных серий разная.
 */
import { builtinBundle, stableId, type PartBundle } from '../core/catalog';
import { BUILTIN_PARTS, PART_INFO_DEFAULTS } from '../core/library';
import type { PartDef, Quantity, SimModel } from '../core/model';
import { generatePackage, type GenParams, type PackageTemplate } from '../core/packages';
import * as SM from './spiceModels';
import * as STDM from '../core/stdModels';
import { icSymbol, standardSymbol, type IcPinInput, type SymbolTemplate } from '../core/symbols';

type PinMap = Array<[symbolPin: string, pad: string]> | 'identity';

interface Def {
  key: string;
  name: string;
  category: string;
  refPrefix: string;
  description: string;
  manufacturer?: string;
  partNumber?: string;
  marking?: string;
  values?: Record<string, Quantity>;
  ratings?: Record<string, Quantity>;
  tolerancePct?: number;
  temperature?: { minC: number; maxC: number };
  polarized?: boolean;
  symbol: SymbolTemplate;
  packages: Array<{ family: string; params?: GenParams; pinMap: PinMap } | { custom: PackageTemplate; pinMap: PinMap }>;
  model: Omit<SimModel, 'id'> | null;
  generic: boolean;
  /** Шаблон «тип + корпус». */
  template?: boolean;
}

const q = (value: number, unit: string): Quantity => ({ value, unit });
const R_MODEL = { name: 'Идеальный резистор', kind: 'spice-primitive', text: 'R {n:1} {n:2} {v:resistance}', source: 'ngspice: элемент R', verified: true } as const;
const C_MODEL = { name: 'Идеальный конденсатор', kind: 'spice-primitive', text: 'C {n:1} {n:2} {v:capacitance}', source: 'ngspice: элемент C', verified: true } as const;
const L_MODEL = { name: 'Идеальная катушка', kind: 'spice-primitive', text: 'L {n:1} {n:2} {v:inductance}', source: 'ngspice: элемент L', verified: true } as const;
const CONNECTOR = { name: 'Разъём (не элемент цепи)', kind: 'connector', text: '', source: null, verified: true } as const;

function make(d: Def): PartBundle {
  const id = (s: string) => stableId(`builtin/${d.key}/${s}`);
  const symbolId = id('symbol');
  const modelId = d.model ? id('model') : null;
  const packages = d.packages.map((p, i) => ({ ...('custom' in p ? p.custom : generatePackage(p.family, p.params ?? {})), id: id(`package/${i}`) }));
  const part: PartDef = {
    id: id('part'),
    name: d.name,
    category: d.category,
    refPrefix: d.refPrefix,
    manufacturer: d.manufacturer ?? null,
    partNumber: d.partNumber ?? null,
    symbolId,
    packages: d.packages.map((p, i) => {
      const pkg = packages[i]!;
      const pinMap = p.pinMap === 'identity'
        ? d.symbol.pins.map((pin) => ({ symbolPin: pin.number, pad: pin.number })).filter((m) => pkg.pads.some((x) => x.number === m.pad))
        : p.pinMap.map(([symbolPin, pad]) => ({ symbolPin, pad }));
      return { packageId: pkg.id, pinMap };
    }),
    modelId,
    description: d.description,
    ...PART_INFO_DEFAULTS,
    marking: d.marking ?? null,
    values: d.values ?? {},
    ratings: d.ratings ?? {},
    tolerancePct: d.tolerancePct ?? null,
    temperature: d.temperature ?? null,
    polarized: d.polarized ?? false,
    origin: {
      catalogPartId: null,
      source: d.template ? TEMPLATE_SOURCE : d.generic ? 'встроенный справочник: типовая деталь' : 'встроенный справочник: типовые данные из даташитов',
      license: null,
      verified: false,
      checkedAt: null,
      notes: d.template
        ? 'Шаблон: номиналы, маркировка, модель и назначение выводов задаются у детали на схеме. Без модели деталь не рассчитывается.'
        : d.generic
        ? 'Типовая деталь: номинал задаётся на схеме, пределы — типичные для такого исполнения. Сверьте с выбранной реальной деталью.'
        : 'Данные внесены по типовым значениям даташитов разных производителей и могут отличаться у конкретного изготовителя. Сверьте с даташитом.',
    },
  };
  part.origin.catalogPartId = part.id;
  return { part, symbol: { ...d.symbol, id: symbolId }, packages, model: d.model && modelId ? { ...d.model, id: modelId } : null };
}

const sym = standardSymbol;

/** Корпус по координатам площадок (мм, вид сверху). Источник координат — в описании детали. */
function custom(name: string, pads: Array<[number: string, x: number, y: number, size: number, drill: number, rect?: boolean]>, body: { x: number; y: number; w: number; h: number }, extra: Partial<PackageTemplate> = {}): PackageTemplate {
  return {
    name, family: 'CUSTOM', mount: 'THT', generator: null, pitchMm: null, numbering: null, pin1Marker: null, body,
    pads: pads.map(([number, x, y, size, drill, rect]) => ({ number, x, y, shape: rect ? 'rect' : 'round', w: size, h: size, drill })),
    ...extra,
  };
}

/** Координаты площадок — по библиотеке посадочных мест KiCad (CC-BY-SA 4.0 с исключением для проектов). */
const PKG_SRD = custom('Реле SRD (Songle/Sanyou, форма C)', [
  ['1', 0, 0, 3, 1.3], ['2', 1.95, 6.05, 2.5, 1], ['3', 14.15, 6.05, 3, 1.3], ['4', 14.2, -6, 3, 1.3], ['5', 1.95, -5.95, 2.5, 1],
], { x: -1.3, y: -7.7, w: 19.6, h: 15.4 }, { numbering: '1 — COM, 2 и 5 — катушка, 3 — NO, 4 — NC (по KiCad SANYOU_SRD)', pin1Marker: 'вывод 1 — в середине короткой стороны' });
const PKG_3296W = custom('Подстроечный 3296W (вертикальный)', [['1', 0, 0, 1.44, 0.8], ['2', -2.54, 0, 1.44, 0.8], ['3', -5.08, 0, 1.44, 0.8]],
  { x: -7.305, y: -2.41, w: 9.53, h: 4.83 }, { pitchMm: 2.54, numbering: 'в ряд: 1, 2 (движок), 3' });
const PKG_PT10V = custom('Подстроечный PT-10 (вертикальный)', [['1', 0, 0, 2.34, 1.3], ['2', 10, -2.5, 2.34, 1.3], ['3', 0, -5, 2.34, 1.3]],
  { x: -0.5, y: -7.5, w: 11.5, h: 10 }, { numbering: '1 и 3 — концы, 2 (движок) — напротив' });
const PKG_HC49 = custom('HC-49/U (вертикальный)', [['1', 0, 0, 1.5, 0.8], ['2', 4.88, 0, 1.5, 0.8]], { x: -0.685, y: -2.325, w: 6.25, h: 4.65 }, { pitchMm: 4.88 });
const PKG_BUZZER12 = custom('Зуммер ∅12 мм, шаг 7,6', [['1', 0, 0, 2, 1, true], ['2', 7.6, 0, 2, 1]], { x: -2.2, y: -6, w: 12, h: 12 }, { pitchMm: 7.6, pin1Marker: 'квадратная площадка — «+»' });
const PKG_TACT6 = custom('Кнопка 6×6 мм (4 вывода)', [['1', 0, 0, 2, 1.1], ['1', 6.5, 0, 2, 1.1], ['2', 0, 4.5, 2, 1.1], ['2', 6.5, 4.5, 2, 1.1]],
  { x: 0.25, y: -0.75, w: 6, h: 6 }, { numbering: 'выводы 1 соединены внутри, выводы 2 — тоже' });
const ic = (name: string, pins: Array<[string, string, IcPinInput['electricalType'], string?]>) =>
  icSymbol(name, pins.map(([number, n, electricalType, description]) => ({ number, name: n, electricalType, description: description ?? '' })));

const DEFS: Def[] = [
  // ---------- Типовые пассивные ----------
  { key: 'res/tht-025', name: 'Резистор 0,25 Вт выводной', category: 'resistor', refPrefix: 'R', description: 'Металлоплёночный резистор общего применения', generic: true,
    values: { resistance: q(10_000, 'Ω') }, ratings: { power: q(0.25, 'W'), voltage: q(250, 'V') }, tolerancePct: 1, temperature: { minC: -55, maxC: 155 },
    symbol: sym('iec-resistor'), packages: [{ family: 'AXIAL', params: { pitch: 10.16, bodyL: 6.3, bodyD: 2.5 }, pinMap: 'identity' }], model: R_MODEL },
  { key: 'res/0805', name: 'Резистор 0805 (0,125 Вт)', category: 'resistor', refPrefix: 'R', description: 'Толстоплёночный чип-резистор', generic: true,
    values: { resistance: q(10_000, 'Ω') }, ratings: { power: q(0.125, 'W'), voltage: q(150, 'V') }, tolerancePct: 1, temperature: { minC: -55, maxC: 155 },
    symbol: sym('iec-resistor'), packages: [{ family: 'CHIP', params: { size: '0805' }, pinMap: 'identity' }], model: R_MODEL },
  { key: 'res/tht-2w', name: 'Резистор 2 Вт выводной', category: 'resistor', refPrefix: 'R', description: 'Мощный металлооксидный резистор', generic: true,
    values: { resistance: q(100, 'Ω') }, ratings: { power: q(2, 'W'), voltage: q(350, 'V') }, tolerancePct: 5,
    symbol: sym('iec-resistor'), packages: [{ family: 'AXIAL', params: { pitch: 15.24, bodyL: 11, bodyD: 4.5, drill: 1 }, pinMap: 'identity' }], model: R_MODEL },
  { key: 'cap/ceramic-tht', name: 'Конденсатор керамический выводной', category: 'capacitor', refPrefix: 'C', description: 'Многослойный керамический конденсатор', generic: true,
    values: { capacitance: q(100e-9, 'F') }, ratings: { voltage: q(50, 'V') }, tolerancePct: 10,
    symbol: sym('iec-capacitor'), packages: [{ family: 'RADIAL', params: { pitch: 5.08, diameter: 5, polar: false }, pinMap: 'identity' }], model: C_MODEL },
  { key: 'cap/ceramic-0805', name: 'Конденсатор керамический 0805', category: 'capacitor', refPrefix: 'C', description: 'Чип-конденсатор X7R', generic: true,
    values: { capacitance: q(100e-9, 'F') }, ratings: { voltage: q(50, 'V') }, tolerancePct: 10,
    symbol: sym('iec-capacitor'), packages: [{ family: 'CHIP', params: { size: '0805' }, pinMap: 'identity' }], model: C_MODEL },
  { key: 'cap/electrolytic', name: 'Конденсатор электролитический', category: 'capacitor-polar', refPrefix: 'C', description: 'Алюминиевый электролитический, радиальный', generic: true,
    ratings: { voltage: q(50, 'V') }, tolerancePct: 20, polarized: true, temperature: { minC: -40, maxC: 105 },
    symbol: sym('iec-capacitor-polar'), packages: [{ family: 'RADIAL', params: { pitch: 2.5, diameter: 6.3, polar: true }, pinMap: 'identity' }],
    values: { capacitance: q(47e-6, 'F'), esr: q(0.6, 'Ω') },
    model: SM.C_ELECTROLYTIC_ESR },
  { key: 'ind/radial', name: 'Дроссель радиальный', category: 'inductor', refPrefix: 'L', description: 'Катушка индуктивности на ферритовом сердечнике', generic: true,
    values: { inductance: q(100e-6, 'H') }, ratings: { current: q(0.5, 'A') }, tolerancePct: 10,
    symbol: sym('iec-inductor'), packages: [{ family: 'RADIAL', params: { pitch: 5, diameter: 8, polar: false }, pinMap: 'identity' }], model: L_MODEL },
  { key: 'fuse/5x20', name: 'Предохранитель 5×20 мм в держателе', category: 'fuse', refPrefix: 'FU', description: 'Плавкая вставка в держателе для печатной платы', generic: true,
    ratings: { current: q(1, 'A'), voltage: q(250, 'V') },
    symbol: sym('fuse'), packages: [{ family: 'AXIAL', params: { pitch: 22.6, bodyL: 20, bodyD: 5, drill: 1.3 }, pinMap: 'identity' }], model: SM.FUSE_1A },
  { key: 'varistor/14d471', name: 'Варистор 470 В', category: 'varistor', refPrefix: 'RU', description: 'Металлооксидный варистор ∅14 мм для сети 230 В', generic: false, partNumber: '14D471K', marking: '14D471K',
    ratings: { voltage: q(300, 'V') },
    symbol: sym('varistor'), packages: [{ family: 'RADIAL', params: { pitch: 7.5, diameter: 15.5, drill: 1, polar: false }, pinMap: 'identity' }], model: SM.VARISTOR_471 },
  { key: 'conn/header-1x2', name: 'Штыревой разъём 1×2', category: 'connector', refPrefix: 'X', description: 'PLS, шаг 2,54 мм', generic: true,
    symbol: ic('Разъём 1×2', [['1', '1', 'passive'], ['2', '2', 'passive']]), packages: [{ family: 'HEADER', params: { rows: 1, pins: 2 }, pinMap: 'identity' }], model: CONNECTOR },
  { key: 'conn/header-1x4', name: 'Штыревой разъём 1×4', category: 'connector', refPrefix: 'X', description: 'PLS, шаг 2,54 мм', generic: true,
    symbol: ic('Разъём 1×4', [['1', '1', 'passive'], ['2', '2', 'passive'], ['3', '3', 'passive'], ['4', '4', 'passive']]), packages: [{ family: 'HEADER', params: { rows: 1, pins: 4 }, pinMap: 'identity' }], model: CONNECTOR },
  { key: 'conn/terminal-2', name: 'Клеммник винтовой 2 контакта', category: 'connector', refPrefix: 'X', description: 'Шаг 5,08 мм', generic: true,
    ratings: { current: q(10, 'A') },
    symbol: ic('Клеммник 2', [['1', '1', 'passive'], ['2', '2', 'passive']]), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: 'identity' }], model: CONNECTOR },
  { key: 'switch/tact', name: 'Кнопка тактовая 6×6', category: 'switch', refPrefix: 'SB', description: 'Без фиксации. Корпус не задан: у кнопок 6×6 четыре вывода, попарно соединённых внутри, — добавьте корпус по даташиту', generic: true,
    ratings: { current: q(0.05, 'A'), voltage: q(12, 'V') },
    values: { closed: q(0, '') }, symbol: sym('switch'), packages: [], model: SM.SWITCH_SPST },
  { key: 'led/5mm-red', name: 'Светодиод 5 мм красный', category: 'led', refPrefix: 'HL', description: 'Индикаторный светодиод; вывод катода короче, у катода срез на корпусе', generic: true,
    ratings: { current: q(0.02, 'A'), reverseVoltage: q(5, 'V') },
    symbol: sym('led'), packages: [{ family: 'RADIAL', params: { pitch: 2.54, diameter: 5, polar: false }, pinMap: [['1', '1'], ['2', '2']] }], model: SM.D_LED_RED },

  // ---------- Источники сигналов (этап 4) ----------
  { key: 'src/sine', name: 'Источник синусоидального напряжения', category: 'source', refPrefix: 'G', description: 'Генератор синуса: амплитуда, частота, постоянная составляющая. Его амплитуда — уровень входного сигнала в частотном анализе.', generic: true,
    values: { amplitude: q(1, 'V'), frequency: q(1000, 'Hz'), offset: q(0, 'V') },
    symbol: sym('iec-ac-source'), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: [['+', '1'], ['-', '2']] }], model: SM.SRC_SINE },
  { key: 'src/pulse', name: 'Источник прямоугольных импульсов', category: 'source', refPrefix: 'G', description: 'Генератор импульсов от 0 до заданного напряжения: частота и заполнение.', generic: true,
    values: { voltage: q(5, 'V'), frequency: q(1000, 'Hz'), duty: q(50, '%') },
    symbol: sym('iec-pulse-source'), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: [['+', '1'], ['-', '2']] }], model: SM.SRC_PULSE },
  { key: 'src/current', name: 'Источник постоянного тока', category: 'source', refPrefix: 'G', description: 'Идеальный источник тока: ток выходит из вывода «+».', generic: true,
    values: { current: q(0.01, 'A') },
    symbol: sym('iec-current-source'), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: [['+', '1'], ['-', '2']] }], model: SM.SRC_CURRENT },

  { key: 'src/lab-psu', name: 'Лабораторный блок питания', category: 'source', refPrefix: 'G', description: 'Регулируемый блок питания: напряжение, ограничение тока, включение выхода; режимы CV и CC. Управляется на панели «Блок питания» вкладки «Тест».', generic: true,
    values: { voltage: q(5, 'V'), currentLimit: q(0.1, 'A'), enabled: q(1, '') },
    symbol: sym('lab-psu'), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: [['+', '1'], ['-', '2']] }], model: SM.SRC_LAB_PSU },

  // ---------- Диоды ----------
  { key: 'diode/1n4007', name: 'Диод выпрямительный 1N4007', category: 'diode', refPrefix: 'VD', description: 'Выпрямительный диод 1 А, 1000 В', generic: false, partNumber: '1N4007', marking: '1N4007',
    ratings: { reverseVoltage: q(1000, 'V'), current: q(1, 'A'), surgeCurrent: q(30, 'A') }, temperature: { minC: -65, maxC: 175 },
    symbol: sym('diode'), packages: [{ family: 'AXIAL', params: { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 }, pinMap: [['1', '1'], ['2', '2']] }], model: SM.D_1N4007 },
  { key: 'diode/1n4148', name: 'Диод импульсный 1N4148', category: 'diode', refPrefix: 'VD', description: 'Быстрый кремниевый диод малой мощности', generic: false, partNumber: '1N4148', marking: '4148',
    ratings: { reverseVoltage: q(100, 'V'), current: q(0.15, 'A') },
    symbol: sym('diode'), packages: [{ family: 'AXIAL', params: { pitch: 7.62, bodyL: 3.9, bodyD: 1.9, drill: 0.7 }, pinMap: [['1', '1'], ['2', '2']] }], model: SM.D_1N4148 },
  { key: 'diode/1n5819', name: 'Диод Шоттки 1N5819', category: 'diode', refPrefix: 'VD', description: 'Диод Шоттки 1 А, 40 В', generic: false, partNumber: '1N5819',
    ratings: { reverseVoltage: q(40, 'V'), current: q(1, 'A') },
    symbol: sym('diode'), packages: [{ family: 'AXIAL', params: { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 }, pinMap: [['1', '1'], ['2', '2']] }], model: SM.D_1N5819 },
  { key: 'zener/1n4733a', name: 'Стабилитрон 1N4733A (5,1 В, 1 Вт)', category: 'zener', refPrefix: 'VD', description: 'Стабилитрон 5,1 В, 1 Вт', generic: false, partNumber: '1N4733A',
    values: { zenerVoltage: q(5.1, 'V') }, ratings: { power: q(1, 'W') }, tolerancePct: 5,
    symbol: sym('zener'), packages: [{ family: 'AXIAL', params: { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 }, pinMap: [['1', '1'], ['2', '2']] }], model: SM.D_1N4733A },
  { key: 'zener/bzx55c5v1', name: 'Стабилитрон BZX55C5V1 (5,1 В, 0,5 Вт)', category: 'zener', refPrefix: 'VD', description: 'Стабилитрон 5,1 В, 0,5 Вт', generic: false, partNumber: 'BZX55C5V1',
    values: { zenerVoltage: q(5.1, 'V') }, ratings: { power: q(0.5, 'W') }, tolerancePct: 5,
    symbol: sym('zener'), packages: [{ family: 'AXIAL', params: { pitch: 7.62, bodyL: 3.9, bodyD: 1.9, drill: 0.7 }, pinMap: [['1', '1'], ['2', '2']] }], model: SM.D_BZX55C5V1 },
  { key: 'bridge/generic', name: 'Диодный мост (типовой)', category: 'bridge', refPrefix: 'VD', description: 'Однофазный выпрямительный мост. Корпус не задан: разводка выводов у мостов разных серий разная — добавьте корпус по даташиту своей детали.', generic: true,
    ratings: { reverseVoltage: q(1000, 'V'), current: q(1, 'A') },
    symbol: sym('bridge'), packages: [], model: SM.BRIDGE_1A },

  // ---------- Транзисторы ----------
  { key: 'bjt/bc547', name: 'Транзистор BC547 (n-p-n)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный n-p-n транзистор общего применения', generic: false, partNumber: 'BC547', marking: 'BC547',
    ratings: { vce: q(45, 'V'), current: q(0.1, 'A'), power: q(0.5, 'W') },
    symbol: sym('npn'), packages: [{ family: 'TO-92', params: { pitch: 2.54 }, pinMap: [['2', '1'], ['1', '2'], ['3', '3']] }], model: SM.Q_BC547B },
  { key: 'bjt/bc557', name: 'Транзистор BC557 (p-n-p)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный p-n-p транзистор общего применения', generic: false, partNumber: 'BC557', marking: 'BC557',
    ratings: { vce: q(45, 'V'), current: q(0.1, 'A'), power: q(0.5, 'W') },
    symbol: sym('pnp'), packages: [{ family: 'TO-92', params: { pitch: 2.54 }, pinMap: [['2', '1'], ['1', '2'], ['3', '3']] }], model: SM.Q_BC557B },
  { key: 'bjt/2n3904', name: 'Транзистор 2N3904 (n-p-n)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный n-p-n транзистор', generic: false, partNumber: '2N3904',
    ratings: { vce: q(40, 'V'), current: q(0.2, 'A'), power: q(0.625, 'W') },
    symbol: sym('npn'), packages: [{ family: 'TO-92', params: { pitch: 2.54 }, pinMap: [['3', '1'], ['1', '2'], ['2', '3']] }], model: SM.Q_2N3904 },
  { key: 'bjt/2n3906', name: 'Транзистор 2N3906 (p-n-p)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный p-n-p транзистор', generic: false, partNumber: '2N3906',
    ratings: { vce: q(40, 'V'), current: q(0.2, 'A'), power: q(0.625, 'W') },
    symbol: sym('pnp'), packages: [{ family: 'TO-92', params: { pitch: 2.54 }, pinMap: [['3', '1'], ['1', '2'], ['2', '3']] }], model: SM.Q_2N3906 },
  { key: 'mos/irf540n', name: 'MOSFET IRF540N (n-канал)', category: 'mosfet', refPrefix: 'VT', description: 'Мощный n-канальный MOSFET 100 В, 33 А', generic: false, partNumber: 'IRF540N',
    ratings: { vds: q(100, 'V'), current: q(33, 'A'), rdsOn: q(0.044, 'Ω') },
    symbol: sym('nmos'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['1', '1'], ['2', '2'], ['3', '3']] }], model: SM.M_IRF540N },
  { key: 'mos/irlz44n', name: 'MOSFET IRLZ44N (n-канал, логический уровень)', category: 'mosfet', refPrefix: 'VT', description: 'n-канальный MOSFET с управлением от 5 В логики', generic: false, partNumber: 'IRLZ44N',
    ratings: { vds: q(55, 'V'), current: q(47, 'A'), rdsOn: q(0.022, 'Ω') },
    symbol: sym('nmos'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['1', '1'], ['2', '2'], ['3', '3']] }], model: SM.M_IRLZ44N },
  { key: 'mos/2n7000', name: 'MOSFET 2N7000 (n-канал, малый)', category: 'mosfet', refPrefix: 'VT', description: 'Маломощный n-канальный MOSFET 60 В, 0,2 А', generic: false, partNumber: '2N7000',
    ratings: { vds: q(60, 'V'), current: q(0.2, 'A') },
    symbol: sym('nmos'), packages: [{ family: 'TO-92', params: { pitch: 2.54 }, pinMap: [['3', '1'], ['1', '2'], ['2', '3']] }], model: SM.M_2N7000 },
  { key: 'thy/bt151', name: 'Тиристор BT151-500R', category: 'thyristor', refPrefix: 'VS', description: 'Тиристор 500 В, 12 А (действующее значение)', generic: false, partNumber: 'BT151-500R',
    ratings: { reverseVoltage: q(500, 'V'), current: q(12, 'A') },
    symbol: sym('thyristor'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['2', '1'], ['1', '2'], ['3', '3']] }], model: SM.SCR_BT151 },
  { key: 'triac/bt136', name: 'Симистор BT136-600', category: 'triac', refPrefix: 'VS', description: 'Симистор 600 В, 4 А (действующее значение)', generic: false, partNumber: 'BT136-600',
    ratings: { voltage: q(600, 'V'), current: q(4, 'A') },
    symbol: sym('triac'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['1', '1'], ['2', '2'], ['3', '3']] }], model: SM.TRIAC_BT136 },

  // ---------- Микросхемы ----------
  { key: 'ic/ne555', name: 'Таймер NE555', category: 'ic-analog', refPrefix: 'DA', description: 'Универсальный таймер: генератор, одновибратор', generic: false, partNumber: 'NE555',
    ratings: { supplyMin: q(4.5, 'V'), supplyMax: q(16, 'V'), current: q(0.2, 'A') }, temperature: { minC: 0, maxC: 70 },
    symbol: ic('NE555', [['2', 'TR', 'input', 'запуск (ниже 1/3 Uпит)'], ['6', 'THR', 'input', 'порог (выше 2/3 Uпит)'], ['4', 'R', 'input', 'сброс (активный низкий)'], ['5', 'CV', 'input', 'управляющее напряжение'],
      ['3', 'Q', 'output', 'выход'], ['7', 'DIS', 'output', 'разряд (открытый коллектор)'], ['8', 'VCC', 'power-in', 'питание +4,5…16 В'], ['1', 'GND', 'ground', 'общий']]),
    packages: [{ family: 'DIP', params: { pins: 8 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 8 }, pinMap: 'identity' }], model: SM.IC_NE555 },
  { key: 'ic/lm358', name: 'Сдвоенный ОУ LM358', category: 'ic-analog', refPrefix: 'DA', description: 'Два операционных усилителя с однополярным питанием', generic: false, partNumber: 'LM358',
    ratings: { supplyMin: q(3, 'V'), supplyMax: q(32, 'V') },
    symbol: ic('LM358', [['3', '+IN A', 'input'], ['2', '−IN A', 'input'], ['5', '+IN B', 'input'], ['6', '−IN B', 'input'],
      ['1', 'OUT A', 'output'], ['7', 'OUT B', 'output'], ['8', 'V+', 'power-in', 'питание 3…32 В'], ['4', 'GND', 'ground', 'общий / V−']]),
    packages: [{ family: 'DIP', params: { pins: 8 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 8 }, pinMap: 'identity' }], model: SM.IC_LM358 },
  { key: 'ic/lm317', name: 'Регулируемый стабилизатор LM317', category: 'ic-analog', refPrefix: 'DA', description: 'Линейный регулируемый стабилизатор 1,25…37 В, 1,5 А', generic: false, partNumber: 'LM317T',
    ratings: { outputMin: q(1.25, 'V'), outputMax: q(37, 'V'), current: q(1.5, 'A') },
    symbol: ic('LM317', [['3', 'IN', 'power-in', 'вход'], ['2', 'OUT', 'power-out', 'выход'], ['1', 'ADJ', 'input', 'регулировка']]),
    packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: 'identity' }], model: SM.IC_LM317 },
  { key: 'ic/l7805', name: 'Стабилизатор L7805 (+5 В)', category: 'ic-analog', refPrefix: 'DA', description: 'Линейный стабилизатор +5 В, 1,5 А', generic: false, partNumber: 'L7805CV',
    ratings: { supplyMax: q(35, 'V'), current: q(1.5, 'A') },
    symbol: ic('7805', [['1', 'IN', 'power-in', 'вход 7…35 В'], ['3', 'OUT', 'power-out', 'выход +5 В'], ['2', 'GND', 'ground', 'общий']]),
    packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: 'identity' }], model: SM.IC_L7805 },
  { key: 'ic/74hc00', name: '4 элемента 2И-НЕ 74HC00', category: 'ic-digital', refPrefix: 'DD', description: 'Четыре логических элемента 2И-НЕ, КМОП', generic: false, partNumber: '74HC00',
    ratings: { supplyMin: q(2, 'V'), supplyMax: q(6, 'V') },
    symbol: ic('74HC00', [['1', '1A', 'input'], ['2', '1B', 'input'], ['4', '2A', 'input'], ['5', '2B', 'input'], ['9', '3A', 'input'], ['10', '3B', 'input'], ['12', '4A', 'input'], ['13', '4B', 'input'],
      ['3', '1Y', 'output'], ['6', '2Y', 'output'], ['8', '3Y', 'output'], ['11', '4Y', 'output'], ['14', 'VCC', 'power-in'], ['7', 'GND', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 14 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 14 }, pinMap: 'identity' }], model: SM.IC_74HC00 },
  { key: 'mcu/atmega328p', name: 'Микроконтроллер ATmega328P', category: 'mcu', refPrefix: 'DD', description: '8-битный AVR, 32 КБ Flash (как в Arduino Uno). Прошивка не исполняется.', generic: false, partNumber: 'ATMEGA328P-PU', manufacturer: 'Microchip',
    ratings: { supplyMin: q(1.8, 'V'), supplyMax: q(5.5, 'V') },
    symbol: ic('ATmega328P', [
      ['1', 'PC6/RESET', 'input'], ['9', 'PB6/XTAL1', 'input'], ['10', 'PB7/XTAL2', 'output'], ['21', 'AREF', 'input'],
      ['2', 'PD0/RXD', 'bidirectional'], ['3', 'PD1/TXD', 'bidirectional'], ['4', 'PD2', 'bidirectional'], ['5', 'PD3', 'bidirectional'], ['6', 'PD4', 'bidirectional'],
      ['11', 'PD5', 'bidirectional'], ['12', 'PD6', 'bidirectional'], ['13', 'PD7', 'bidirectional'], ['14', 'PB0', 'bidirectional'], ['15', 'PB1', 'bidirectional'],
      ['16', 'PB2', 'bidirectional'], ['17', 'PB3/MOSI', 'bidirectional'], ['18', 'PB4/MISO', 'bidirectional'], ['19', 'PB5/SCK', 'bidirectional'],
      ['23', 'PC0/ADC0', 'bidirectional'], ['24', 'PC1/ADC1', 'bidirectional'], ['25', 'PC2/ADC2', 'bidirectional'], ['26', 'PC3/ADC3', 'bidirectional'],
      ['27', 'PC4/SDA', 'bidirectional'], ['28', 'PC5/SCL', 'bidirectional'],
      ['7', 'VCC', 'power-in'], ['20', 'AVCC', 'power-in'], ['8', 'GND', 'ground'], ['22', 'GND', 'ground'],
    ]),
    packages: [{ family: 'DIP', params: { pins: 28 }, pinMap: 'identity' }], model: null },

  // ---------- Этап 8: коммутация, датчики, звук, логика ----------
  { key: 'relay/srd-05vdc', name: 'Реле SRD-05VDC-SL-C (5 В, 10 А)', category: 'relay', refPrefix: 'K', generic: false, partNumber: 'SRD-05VDC-SL-C', manufacturer: 'Songle',
    description: 'Электромагнитное реле: катушка 5 В / 70 Ом, переключающий контакт 10 А. Проверьте прозвонкой: без питания NC замкнут с COM.',
    ratings: { voltage: q(6.5, 'V'), current: q(10, 'A') },
    symbol: sym('relay'), packages: [{ custom: PKG_SRD, pinMap: [['1', '2'], ['2', '5'], ['3', '1'], ['4', '3'], ['5', '4']] }], model: SM.REL_SRD05 },
  { key: 'tr/generic', name: 'Трансформатор (вне платы, клеммы)', category: 'transformer', refPrefix: 'T', generic: true,
    description: 'Сетевой или согласующий трансформатор: индуктивность первичной обмотки и коэффициент трансформации задаются на схеме. По умолчанию 230 В → 12,6 В. На плате — клеммник на 4 провода.',
    values: { inductance: q(10, 'H'), turnsRatio: q(18.25, '') },
    symbol: sym('transformer'), packages: [{ family: 'TERMINAL', params: { pins: 4 }, pinMap: 'identity' }], model: SM.TR_GENERIC },
  { key: 'pot/3296w', name: 'Резистор подстроечный 3296W', category: 'potentiometer', refPrefix: 'R', generic: true,
    description: 'Многооборотный подстроечный резистор; положение движка задаётся на схеме (0 % — у вывода 1).',
    values: { resistance: q(10_000, 'Ω'), position: q(50, '%') }, ratings: { power: q(0.5, 'W') }, tolerancePct: 10,
    symbol: sym('potentiometer'), packages: [{ custom: PKG_3296W, pinMap: 'identity' }], model: SM.POT },
  { key: 'pot/pt10', name: 'Резистор подстроечный PT-10', category: 'potentiometer', refPrefix: 'R', generic: true,
    description: 'Однооборотный подстроечный резистор 10 мм; положение движка задаётся на схеме.',
    values: { resistance: q(10_000, 'Ω'), position: q(50, '%') }, ratings: { power: q(0.15, 'W') }, tolerancePct: 20,
    symbol: sym('potentiometer'), packages: [{ custom: PKG_PT10V, pinMap: 'identity' }], model: SM.POT },
  { key: 'pot/panel', name: 'Потенциометр (на корпусе прибора, провода)', category: 'potentiometer', refPrefix: 'R', generic: true,
    description: 'Переменный резистор с ручкой, подключается к плате проводами через клеммник на 3 контакта.',
    values: { resistance: q(10_000, 'Ω'), position: q(50, '%') }, ratings: { power: q(0.25, 'W') }, tolerancePct: 20,
    symbol: sym('potentiometer'), packages: [{ family: 'TERMINAL', params: { pins: 3 }, pinMap: 'identity' }], model: SM.POT },
  { key: 'xtal/hc49', name: 'Кварцевый резонатор HC-49', category: 'crystal', refPrefix: 'ZQ', generic: true,
    description: 'Кварц в корпусе HC-49/U; частота задаётся на схеме. Нагрузочные конденсаторы — по даташиту (обычно 15–22 пФ).',
    values: { frequency: q(4_000_000, 'Hz') },
    symbol: sym('crystal'), packages: [{ custom: PKG_HC49, pinMap: 'identity' }], model: SM.XTAL },
  { key: 'opto/pc817', name: 'Оптопара PC817', category: 'optocoupler', refPrefix: 'U', generic: false, partNumber: 'PC817', manufacturer: 'Sharp',
    description: 'Транзисторная оптопара: светодиод (1 — анод, 2 — катод) и фототранзистор (3 — эмиттер, 4 — коллектор). Ток светодиода до 50 мА.',
    ratings: { current: q(0.05, 'A') },
    symbol: ic('PC817', [['1', 'A', 'passive', 'анод светодиода'], ['2', 'K', 'passive', 'катод светодиода'], ['4', 'C', 'passive', 'коллектор'], ['3', 'E', 'passive', 'эмиттер']]),
    packages: [{ family: 'DIP', params: { pins: 4 }, pinMap: 'identity' }], model: SM.OPTO_PC817 },
  { key: 'snd/speaker8', name: 'Динамик 8 Ом (провода)', category: 'acoustic', refPrefix: 'BA', generic: true,
    description: 'Малогабаритный громкоговоритель 8 Ом 0,5 Вт; подключается проводами через клеммник.',
    ratings: { power: q(0.5, 'W') },
    symbol: sym('speaker'), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: 'identity' }], model: SM.SPEAKER_8 },
  { key: 'snd/buzzer-active', name: 'Зуммер активный 5 В ∅12 мм', category: 'acoustic', refPrefix: 'HA', generic: true,
    description: 'Зуммер со встроенным генератором: звучит при подаче постоянного 5 В; вывод 1 — «+» (длинный).',
    ratings: { power: q(0.25, 'W') },
    symbol: sym('buzzer'), packages: [{ custom: PKG_BUZZER12, pinMap: 'identity' }], model: SM.BUZZER_ACTIVE },
  { key: 'snd/piezo', name: 'Пьезоизлучатель ∅12 мм (без генератора)', category: 'acoustic', refPrefix: 'HA', generic: true,
    description: 'Пассивный пьезоизлучатель: звучит от переменного сигнала (генератор, выход микросхемы).',
    symbol: sym('buzzer'), packages: [{ custom: PKG_BUZZER12, pinMap: 'identity' }], model: SM.PIEZO },
  { key: 'sens/ntc10k', name: 'Терморезистор NTC 10 кОм (B 3950)', category: 'sensor', refPrefix: 'RK', generic: true,
    description: 'Терморезистор с отрицательным ТКС: 10 кОм при 25 °C. Температура задаётся на схеме — можно проверить схему при нагреве и охлаждении.',
    values: { temperature: q(25, '°C') }, tolerancePct: 1,
    symbol: sym('thermistor'), packages: [{ family: 'RADIAL', params: { pitch: 2.54, diameter: 4, polar: false }, pinMap: 'identity' }], model: SM.NTC_10K },
  { key: 'sens/gl5528', name: 'Фоторезистор GL5528', category: 'sensor', refPrefix: 'R', generic: false, partNumber: 'GL5528',
    description: 'Фоторезистор: около 10 кОм при 10 лк, около 1 МОм в темноте. Освещённость задаётся на схеме.',
    values: { illuminance: q(10, 'lx') }, ratings: { power: q(0.1, 'W') },
    symbol: sym('photoresistor'), packages: [{ family: 'RADIAL', params: { pitch: 3.4, diameter: 5, polar: false }, pinMap: 'identity' }], model: SM.LDR_GL5528 },
  { key: 'sw/tact6', name: 'Кнопка тактовая 6×6 (4 вывода)', category: 'switch', refPrefix: 'SB', generic: true,
    description: 'Кнопка без фиксации; выводы попарно соединены внутри. Нажата или нет — параметр «Замкнут (1/0)» на схеме.',
    values: { closed: q(0, '') }, ratings: { current: q(0.05, 'A') },
    symbol: sym('button'), packages: [{ custom: PKG_TACT6, pinMap: 'identity' }], model: SM.SWITCH_SPST },
  { key: 'sw/toggle', name: 'Выключатель (тумблер, провода)', category: 'switch', refPrefix: 'SA', generic: true,
    description: 'Выключатель на корпусе прибора, подключается проводами. Положение — параметр «Замкнут (1/0)».',
    values: { closed: q(1, '') }, ratings: { current: q(3, 'A') },
    symbol: sym('switch'), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: 'identity' }], model: SM.SWITCH_SPST },
  { key: 'ind/search-coil', name: 'Катушка с сопротивлением (выносная)', category: 'inductor', refPrefix: 'L', generic: true,
    description: 'Катушка с заметным сопротивлением провода — например, поисковая катушка металлоискателя. Подключается проводами.',
    values: { inductance: q(300e-6, 'H'), resistance: q(2, 'Ω') }, ratings: { current: q(1, 'A') },
    symbol: sym('iec-inductor'), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: 'identity' }], model: SM.L_WITH_R },
  { key: 'zener/generic', name: 'Стабилитрон 0,5 Вт (напряжение — на схеме)', category: 'zener', refPrefix: 'VD', generic: true,
    description: 'Типовой стабилитрон в корпусе DO-35: напряжение стабилизации задаётся на схеме.',
    values: { zenerVoltage: q(5.1, 'V') }, ratings: { power: q(0.5, 'W') }, tolerancePct: 5,
    symbol: sym('zener'), packages: [{ family: 'AXIAL', params: { pitch: 7.62, bodyL: 3.9, bodyD: 1.9, drill: 0.7 }, pinMap: [['1', '1'], ['2', '2']] }], model: SM.D_ZENER_GENERIC },

  // ---------- Логика КМОП ----------
  { key: 'ic/cd4011', name: '4 элемента 2И-НЕ CD4011 (К561ЛА7)', category: 'ic-digital', refPrefix: 'DD', generic: false, partNumber: 'CD4011B',
    description: 'Четыре элемента 2И-НЕ, КМОП, питание 3…18 В. Отечественный аналог — К561ЛА7.',
    ratings: { supplyMin: q(3, 'V'), supplyMax: q(18, 'V') },
    symbol: ic('CD4011', [['1', '1A', 'input'], ['2', '1B', 'input'], ['5', '2A', 'input'], ['6', '2B', 'input'], ['8', '3A', 'input'], ['9', '3B', 'input'], ['12', '4A', 'input'], ['13', '4B', 'input'],
      ['3', '1Y', 'output'], ['4', '2Y', 'output'], ['10', '3Y', 'output'], ['11', '4Y', 'output'], ['14', 'VDD', 'power-in'], ['7', 'VSS', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 14 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 14 }, pinMap: 'identity' }], model: SM.IC_CD4011 },
  { key: 'ic/cd4093', name: '4 элемента 2И-НЕ с триггером Шмитта CD4093 (К561ТЛ1)', category: 'ic-digital', refPrefix: 'DD', generic: false, partNumber: 'CD4093B',
    description: 'Четыре элемента 2И-НЕ с гистерезисом, КМОП 3…18 В — генераторы на RC, формирователи. Аналог — К561ТЛ1.',
    ratings: { supplyMin: q(3, 'V'), supplyMax: q(18, 'V') },
    symbol: ic('CD4093', [['1', '1A', 'input'], ['2', '1B', 'input'], ['5', '2A', 'input'], ['6', '2B', 'input'], ['8', '3A', 'input'], ['9', '3B', 'input'], ['12', '4A', 'input'], ['13', '4B', 'input'],
      ['3', '1Y', 'output'], ['4', '2Y', 'output'], ['10', '3Y', 'output'], ['11', '4Y', 'output'], ['14', 'VDD', 'power-in'], ['7', 'VSS', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 14 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 14 }, pinMap: 'identity' }], model: SM.IC_CD4093 },
  { key: 'ic/cd4001', name: '4 элемента 2ИЛИ-НЕ CD4001 (К561ЛЕ5)', category: 'ic-digital', refPrefix: 'DD', generic: false, partNumber: 'CD4001B',
    description: 'Четыре элемента 2ИЛИ-НЕ, КМОП, питание 3…18 В. Аналог — К561ЛЕ5.',
    ratings: { supplyMin: q(3, 'V'), supplyMax: q(18, 'V') },
    symbol: ic('CD4001', [['1', '1A', 'input'], ['2', '1B', 'input'], ['5', '2A', 'input'], ['6', '2B', 'input'], ['8', '3A', 'input'], ['9', '3B', 'input'], ['12', '4A', 'input'], ['13', '4B', 'input'],
      ['3', '1Y', 'output'], ['4', '2Y', 'output'], ['10', '3Y', 'output'], ['11', '4Y', 'output'], ['14', 'VDD', 'power-in'], ['7', 'VSS', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 14 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 14 }, pinMap: 'identity' }], model: SM.IC_CD4001 },
  { key: 'ic/cd4069', name: '6 инверторов CD4069 (К561ЛН2)', category: 'ic-digital', refPrefix: 'DD', generic: false, partNumber: 'CD4069UB',
    description: 'Шесть инверторов, КМОП 3…18 В. Аналог — К561ЛН2.',
    ratings: { supplyMin: q(3, 'V'), supplyMax: q(18, 'V') },
    symbol: ic('CD4069', [['1', '1A', 'input'], ['3', '2A', 'input'], ['5', '3A', 'input'], ['9', '4A', 'input'], ['11', '5A', 'input'], ['13', '6A', 'input'],
      ['2', '1Y', 'output'], ['4', '2Y', 'output'], ['6', '3Y', 'output'], ['8', '4Y', 'output'], ['10', '5Y', 'output'], ['12', '6Y', 'output'], ['14', 'VDD', 'power-in'], ['7', 'VSS', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 14 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 14 }, pinMap: 'identity' }], model: SM.IC_CD4069 },
  { key: 'ic/74hc14', name: '6 инверторов с триггером Шмитта 74HC14', category: 'ic-digital', refPrefix: 'DD', generic: false, partNumber: '74HC14',
    description: 'Шесть инверторов с гистерезисом, 74HC, питание 2…6 В.',
    ratings: { supplyMin: q(2, 'V'), supplyMax: q(6, 'V') },
    symbol: ic('74HC14', [['1', '1A', 'input'], ['3', '2A', 'input'], ['5', '3A', 'input'], ['9', '4A', 'input'], ['11', '5A', 'input'], ['13', '6A', 'input'],
      ['2', '1Y', 'output'], ['4', '2Y', 'output'], ['6', '3Y', 'output'], ['8', '4Y', 'output'], ['10', '5Y', 'output'], ['12', '6Y', 'output'], ['14', 'VCC', 'power-in'], ['7', 'GND', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 14 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 14 }, pinMap: 'identity' }], model: SM.IC_74HC14 },
  { key: 'ic/lm393', name: 'Сдвоенный компаратор LM393', category: 'ic-analog', refPrefix: 'DA', generic: false, partNumber: 'LM393',
    description: 'Два компаратора с выходом «открытый коллектор» (нужен подтягивающий резистор), питание 2…36 В.',
    ratings: { supplyMin: q(2, 'V'), supplyMax: q(36, 'V'), current: q(0.02, 'A') },
    symbol: ic('LM393', [['3', '+IN A', 'input'], ['2', '−IN A', 'input'], ['5', '+IN B', 'input'], ['6', '−IN B', 'input'],
      ['1', 'OUT A', 'output', 'открытый коллектор'], ['7', 'OUT B', 'output', 'открытый коллектор'], ['8', 'V+', 'power-in'], ['4', 'GND', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 8 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 8 }, pinMap: 'identity' }], model: SM.IC_LM393 },
];

// ---------- Шаблоны «тип + корпус» (быстрое добавление; номиналы задаются в карточке на схеме) ----------

export const TEMPLATE_SOURCE = 'шаблон: тип и корпус, характеристики задаются на схеме';

interface Tpl { key: string; category: string; prefix: string; type: string; variant: string; symbol: SymbolTemplate; pkg: { family: string; params?: GenParams } | { custom: PackageTemplate };
  pinMap: PinMap; model: Omit<SimModel, 'id'> | null; values?: Record<string, Quantity>; ratings?: Record<string, Quantity>; tolerancePct?: number; polarized?: boolean; note?: string }

/** Существующие типовые детали, которые служат шаблонами (их id не меняются — старые проекты на них ссылаются). */
const EXISTING_TEMPLATES: Array<{ key: string; group: string; variant: string }> = [
  { key: 'res/tht-025', group: 'resistor', variant: 'Выводной 0,25 Вт' },
  { key: 'res/0805', group: 'resistor', variant: 'SMD 0805' },
  { key: 'res/tht-2w', group: 'resistor', variant: 'Выводной 2 Вт' },
  { key: 'cap/ceramic-tht', group: 'capacitor', variant: 'Керамический выводной' },
  { key: 'cap/ceramic-0805', group: 'capacitor', variant: 'Керамический SMD 0805' },
  { key: 'cap/electrolytic', group: 'capacitor', variant: 'Электролитический ∅6,3 мм' },
  { key: 'ind/radial', group: 'inductor', variant: 'Дроссель радиальный' },
  { key: 'zener/generic', group: 'zener', variant: 'DO-35 (выводной)' },
  { key: 'fuse/5x20', group: 'fuse', variant: '5×20 мм в держателе' },
  { key: 'conn/header-1x2', group: 'connector', variant: 'Штыри 1×2' },
  { key: 'conn/header-1x4', group: 'connector', variant: 'Штыри 1×4' },
  { key: 'conn/terminal-2', group: 'connector', variant: 'Клеммник на 2 провода' },
  { key: 'sw/tact6', group: 'switch', variant: 'Кнопка 6×6 мм' },
  { key: 'sw/toggle', group: 'switch', variant: 'Тумблер (провода)' },
];

const R_POWER: Record<string, number> = { '0402': 0.063, '0603': 0.1, '0805': 0.125, '1206': 0.25, '2512': 1 };
const TEMPLATES: Tpl[] = [
  ...['0402', '0603', '1206', '2512'].map((size): Tpl => ({ key: `tpl/res/${size}`, category: 'resistor', prefix: 'R', type: 'Резистор', variant: `SMD ${size}`, symbol: sym('iec-resistor'),
    pkg: { family: 'CHIP', params: { size } }, pinMap: 'identity', model: R_MODEL, values: { resistance: q(10_000, 'Ω') }, ratings: { power: q(R_POWER[size]!, 'W') } })),
  { key: 'tpl/res/tht-05', category: 'resistor', prefix: 'R', type: 'Резистор', variant: 'Выводной 0,5 Вт', symbol: sym('iec-resistor'),
    pkg: { family: 'AXIAL', params: { pitch: 12.7, bodyL: 9, bodyD: 3.2, drill: 0.8 } }, pinMap: 'identity', model: R_MODEL, values: { resistance: q(10_000, 'Ω') }, ratings: { power: q(0.5, 'W') } },
  ...['0402', '0603', '1206'].map((size): Tpl => ({ key: `tpl/cap/${size}`, category: 'capacitor', prefix: 'C', type: 'Конденсатор керамический', variant: `SMD ${size}`, symbol: sym('iec-capacitor'),
    pkg: { family: 'CHIP', params: { size } }, pinMap: 'identity', model: C_MODEL, values: { capacitance: q(100e-9, 'F') }, ratings: { voltage: q(50, 'V') } })),
  { key: 'tpl/cap/film', category: 'capacitor', prefix: 'C', type: 'Конденсатор плёночный', variant: 'Плёночный выводной, шаг 5 мм', symbol: sym('iec-capacitor'),
    pkg: { family: 'RADIAL', params: { pitch: 5.08, diameter: 7, polar: false } }, pinMap: 'identity', model: C_MODEL, values: { capacitance: q(100e-9, 'F') }, ratings: { voltage: q(63, 'V') } },
  ...([[5, 2], [8, 3.5], [10, 5]] as const).map(([d, pitch]): Tpl => ({ key: `tpl/cap/el-${d}`, category: 'capacitor-polar', prefix: 'C', type: 'Конденсатор электролитический', variant: `Электролитический ∅${d} мм`,
    symbol: sym('iec-capacitor-polar'), pkg: { family: 'RADIAL', params: { pitch, diameter: d, polar: true } }, pinMap: 'identity', model: SM.C_ELECTROLYTIC_ESR,
    values: { capacitance: q(47e-6, 'F'), esr: q(0.6, 'Ω') }, ratings: { voltage: q(25, 'V') }, polarized: true })),
  { key: 'tpl/ind/axial', category: 'inductor', prefix: 'L', type: 'Катушка', variant: 'Выводная аксиальная', symbol: sym('iec-inductor'),
    pkg: { family: 'AXIAL', params: { pitch: 12.7, bodyL: 9, bodyD: 4, drill: 0.8 } }, pinMap: 'identity', model: L_MODEL, values: { inductance: q(100e-6, 'H') }, ratings: { current: q(0.3, 'A') } },
  ...['0805', '1210'].map((size): Tpl => ({ key: `tpl/ind/${size}`, category: 'inductor', prefix: 'L', type: 'Катушка', variant: `SMD ${size}`, symbol: sym('iec-inductor'),
    pkg: { family: 'CHIP', params: { size } }, pinMap: 'identity', model: L_MODEL, values: { inductance: q(10e-6, 'H') }, ratings: { current: q(0.2, 'A') } })),
  // Диоды: вывод 1 корпуса — катод (полоса на корпусе); модель выбирается в карточке
  ...([['DO-41', { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 }], ['DO-35', { pitch: 7.62, bodyL: 3.9, bodyD: 1.9, drill: 0.7 }], ['DO-201', { pitch: 15.24, bodyL: 9.5, bodyD: 5.3, drill: 1.3 }]] as const)
    .map(([name, params]): Tpl => ({ key: `tpl/diode/${name}`, category: 'diode', prefix: 'VD', type: 'Диод', variant: `${name} (выводной)`, symbol: sym('diode'),
      pkg: { family: 'AXIAL', params: { ...params } }, pinMap: [['1', '1'], ['2', '2']], model: null })),
  ...['SMA', 'SMB', 'SMC'].map((size): Tpl => ({ key: `tpl/diode/${size}`, category: 'diode', prefix: 'VD', type: 'Диод', variant: `SMD ${size}`, symbol: sym('diode'),
    pkg: { family: 'SMA', params: { size } }, pinMap: [['1', '1'], ['2', '2']], model: null })),
  ...([[3, 2.54], [5, 2.54]] as const).map(([d, pitch]): Tpl => ({ key: `tpl/led/${d}mm`, category: 'led', prefix: 'HL', type: 'Светодиод', variant: `${d} мм`, symbol: sym('led'),
    pkg: { family: 'RADIAL', params: { pitch, diameter: d, polar: false } }, pinMap: [['1', '1'], ['2', '2']], model: null, ratings: { current: q(0.02, 'A'), reverseVoltage: q(5, 'V') } })),
  ...['0805', '1206'].map((size): Tpl => ({ key: `tpl/led/${size}`, category: 'led', prefix: 'HL', type: 'Светодиод', variant: `SMD ${size}`, symbol: sym('led'),
    pkg: { family: 'CHIP', params: { size } }, pinMap: [['1', '1'], ['2', '2']], model: null, ratings: { current: q(0.02, 'A'), reverseVoltage: q(5, 'V') } })),
  { key: 'tpl/zener/do41', category: 'zener', prefix: 'VD', type: 'Стабилитрон', variant: 'DO-41 (выводной, 1 Вт)', symbol: sym('zener'),
    pkg: { family: 'AXIAL', params: { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 } }, pinMap: [['1', '1'], ['2', '2']], model: SM.D_ZENER_GENERIC, values: { zenerVoltage: q(5.1, 'V') }, ratings: { power: q(1, 'W') } },
  { key: 'tpl/zener/sma', category: 'zener', prefix: 'VD', type: 'Стабилитрон', variant: 'SMD SMA', symbol: sym('zener'),
    pkg: { family: 'SMA', params: { size: 'SMA' } }, pinMap: [['1', '1'], ['2', '2']], model: SM.D_ZENER_GENERIC, values: { zenerVoltage: q(5.1, 'V') }, ratings: { power: q(1, 'W') } },
  // Транзисторы, тиристоры: распиновка у разных деталей в одном корпусе разная — не задана, назначается в карточке
  ...(['TO-92', 'TO-220', 'TO-247', 'SOT-23'] as const).flatMap((fam): Tpl[] => [
    { key: `tpl/bjt/${fam}`, category: 'bjt', prefix: 'VT', type: 'Транзистор биполярный', variant: fam, symbol: sym('npn'), pkg: { family: fam, params: fam === 'SOT-23' ? { pins: '3' } : {} }, pinMap: [], model: null,
      note: 'Распиновка в этом корпусе зависит от транзистора — назначьте выводы в карточке (двойной щелчок) или найдите транзистор по маркировке.' },
    { key: `tpl/mos/${fam}`, category: 'mosfet', prefix: 'VT', type: 'Транзистор MOSFET', variant: fam, symbol: sym('nmos'), pkg: { family: fam, params: fam === 'SOT-23' ? { pins: '3' } : {} }, pinMap: [], model: null,
      note: 'Распиновка в этом корпусе зависит от транзистора — назначьте выводы в карточке или найдите транзистор по маркировке.' },
  ]),
  ...(['TO-92', 'TO-220'] as const).flatMap((fam): Tpl[] => [
    { key: `tpl/thy/${fam}`, category: 'thyristor', prefix: 'VS', type: 'Тиристор', variant: fam, symbol: sym('thyristor'), pkg: { family: fam }, pinMap: [], model: null },
    { key: `tpl/triac/${fam}`, category: 'triac', prefix: 'VS', type: 'Симистор', variant: fam, symbol: sym('triac'), pkg: { family: fam }, pinMap: [], model: null },
  ]),
  // Микросхемы: номер вывода = номер площадки; назначение выводов и модель — в карточке
  ...([['DIP', [8, 14, 16, 20]], ['SOIC', [8, 14, 16]], ['SOP', [8, 16]], ['TSSOP', [14, 16, 20]], ['QFP', [32, 44, 64]], ['QFN', [16, 32]]] as const)
    .flatMap(([fam, counts]) => counts.map((n): Tpl => ({ key: `tpl/ic/${fam}-${n}`, category: 'ic-analog', prefix: 'DA', type: 'Микросхема', variant: `${fam}-${n}`,
      symbol: icPins(n), pkg: { family: fam, params: { pins: n } }, pinMap: 'identity', model: null }))),
  { key: 'tpl/ic/BGA-64', category: 'ic-analog', prefix: 'DA', type: 'Микросхема', variant: 'BGA-64 (8×8)', symbol: icPins(64, (i) => `${'ABCDEFGH'[Math.floor(i / 8)]}${(i % 8) + 1}`),
    pkg: { family: 'BGA', params: { rows: 8, cols: 8 } }, pinMap: 'identity', model: null },
  ...([[7, 5], [10, 7.5], [14, 7.5]] as const).map(([d, pitch]): Tpl => ({ key: `tpl/var/${d}`, category: 'varistor', prefix: 'RU', type: 'Варистор', variant: `∅${d} мм`, symbol: sym('varistor'),
    pkg: { family: 'RADIAL', params: { pitch, diameter: d + 1.5, drill: 1, polar: false } }, pinMap: 'identity', model: STDM.VARISTOR_PARAM, values: { clampVoltage: q(470, 'V') } })),
  { key: 'tpl/conn/header-1x3', category: 'connector', prefix: 'X', type: 'Разъём', variant: 'Штыри 1×3', symbol: ic('Разъём 1×3', [['1', '1', 'passive'], ['2', '2', 'passive'], ['3', '3', 'passive']]),
    pkg: { family: 'HEADER', params: { rows: 1, pins: 3 } }, pinMap: 'identity', model: CONNECTOR },
  { key: 'tpl/conn/terminal-3', category: 'connector', prefix: 'X', type: 'Разъём', variant: 'Клеммник на 3 провода', symbol: ic('Клеммник 3', [['1', '1', 'passive'], ['2', '2', 'passive'], ['3', '3', 'passive']]),
    pkg: { family: 'TERMINAL', params: { pins: 3 } }, pinMap: 'identity', model: CONNECTOR },
];

function icPins(n: number, name: (i: number) => string = (i) => String(i + 1)): SymbolTemplate {
  if (name(0) === '1') return ic(`Микросхема (${n} выв.)`, Array.from({ length: n }, (_, i) => [String(i + 1), String(i + 1), 'passive'] as [string, string, 'passive']));
  return ic(`Микросхема (${n} выв.)`, Array.from({ length: n }, (_, i) => [name(i), name(i), 'passive'] as [string, string, 'passive']));
}

const TEMPLATE_DEFS: Def[] = TEMPLATES.map((t) => ({
  key: t.key, name: `${t.type} ${t.variant}`, category: t.category, refPrefix: t.prefix, generic: true, description: t.note ?? `${t.type}, корпус ${t.variant}. Характеристики задаются в карточке детали на схеме (двойной щелчок).`,
  values: t.values, ratings: t.ratings, tolerancePct: t.tolerancePct, polarized: t.polarized, symbol: t.symbol,
  packages: ['custom' in t.pkg ? { custom: t.pkg.custom, pinMap: t.pinMap } : { family: t.pkg.family, params: t.pkg.params, pinMap: t.pinMap }], model: t.model, template: true,
}));

export interface TemplateGroup { category: string; label: string; items: Array<{ partId: string; variant: string; packageName: string }> }

/** Шаблоны по типам: категория → варианты корпуса (для быстрого добавления на схему). */
export function partTemplates(): TemplateGroup[] {
  const cat = builtinCatalog();
  const byKey = (key: string) => cat.find((b) => b.part.id === stableId(`builtin/${key}/part`));
  const groups = new Map<string, TemplateGroup>();
  const add = (category: string, key: string, variant: string) => {
    const b = byKey(key);
    if (!b) return;
    const g = groups.get(category) ?? { category, label: TEMPLATE_GROUP_LABEL[category] ?? category, items: [] };
    g.items.push({ partId: b.part.id, variant, packageName: b.packages[0]?.name ?? 'без корпуса' });
    groups.set(category, g);
  };
  for (const e of EXISTING_TEMPLATES) add(e.group, e.key, e.variant);
  for (const t of TEMPLATES) add(t.category === 'capacitor-polar' ? 'capacitor' : t.category, t.key, t.category === 'capacitor-polar' || t.type.startsWith('Конденсатор плёночный') ? t.variant : t.category === 'capacitor' ? `Керамический ${t.variant}` : t.variant);
  // «Другие»: остальные типовые детали справочника (реле, кварц, потенциометры, звук, датчики…)
  const listed = new Set([...groups.values()].flatMap((g) => g.items.map((i) => i.partId)));
  for (const b of cat) {
    if (listed.has(b.part.id) || b.part.category === 'reference' || b.part.category === 'source' || !(b.part.origin.source ?? '').includes('типовая')) continue;
    const g = groups.get('other') ?? { category: 'other', label: TEMPLATE_GROUP_LABEL.other!, items: [] };
    g.items.push({ partId: b.part.id, variant: b.part.name, packageName: b.packages[0]?.name ?? 'без корпуса' });
    groups.set('other', g);
  }
  return TEMPLATE_ORDER.map((c) => groups.get(c)).filter((g): g is TemplateGroup => !!g && g.items.length > 0);
}

const TEMPLATE_GROUP_LABEL: Record<string, string> = {
  resistor: 'Резисторы', capacitor: 'Конденсаторы', inductor: 'Катушки индуктивности', diode: 'Диоды', led: 'Светодиоды', zener: 'Стабилитроны',
  bjt: 'Биполярные транзисторы', mosfet: 'MOSFET-транзисторы', thyristor: 'Тиристоры', triac: 'Симисторы', 'ic-analog': 'Микросхемы',
  fuse: 'Предохранители', varistor: 'Варисторы', connector: 'Разъёмы', switch: 'Кнопки и переключатели', other: 'Другие',
};
const TEMPLATE_ORDER = ['resistor', 'capacitor', 'inductor', 'diode', 'led', 'zener', 'bjt', 'mosfet', 'thyristor', 'triac', 'ic-analog', 'fuse', 'varistor', 'connector', 'switch', 'other'];

/** Деталь — шаблон «тип + корпус» (характеристики задаёт пользователь). */
export const isTemplatePart = (source: string | null) => source === TEMPLATE_SOURCE;

let cache: PartBundle[] | null = null;

/** Все детали встроенного справочника: 4 идеальные детали прототипа + типовые + реальные. */
export function builtinCatalog(): PartBundle[] {
  if (!cache) cache = [...BUILTIN_PARTS.map(builtinBundle), ...DEFS.map(make), ...TEMPLATE_DEFS.map(make)];
  return cache;
}

export const isBuiltinPart = (partId: string) => builtinCatalog().some((b) => b.part.id === partId);
