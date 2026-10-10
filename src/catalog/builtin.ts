/**
 * Встроенный справочник деталей (только чтение). Две группы:
 *  • типовые детали — номинал задаёт пользователь на схеме (резистор, конденсатор, катушка, разъёмы…);
 *  • распространённые реальные детали — с партномером, разводкой корпуса и предельными параметрами
 *    по типовым данным даташитов. Все они помечены «не сверено с даташитом» (origin.verified = false):
 *    перед применением пользователь сверяет сведения с даташитом своего производителя.
 * SPICE-моделей у полупроводников и микросхем на этапе 2 нет — это показывается явно (этап 4).
 */
import { builtinBundle, stableId, type PartBundle } from '../core/catalog';
import { BUILTIN_PARTS, PART_INFO_DEFAULTS } from '../core/library';
import type { PartDef, Quantity, SimModel } from '../core/model';
import { generatePackage, type GenParams } from '../core/packages';
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
  packages: Array<{ family: string; params?: GenParams; pinMap: PinMap }>;
  model: Omit<SimModel, 'id'> | null;
  generic: boolean;
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
  const packages = d.packages.map((p, i) => ({ ...generatePackage(p.family, p.params ?? {}), id: id(`package/${i}`) }));
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
      source: d.generic ? 'встроенный справочник: типовая деталь' : 'встроенный справочник: типовые данные из даташитов',
      license: null,
      verified: false,
      checkedAt: null,
      notes: d.generic
        ? 'Типовая деталь: номинал задаётся на схеме, пределы — типичные для такого исполнения. Сверьте с выбранной реальной деталью.'
        : 'Данные внесены по типовым значениям даташитов разных производителей и могут отличаться у конкретного изготовителя. Сверьте с даташитом.',
    },
  };
  part.origin.catalogPartId = part.id;
  return { part, symbol: { ...d.symbol, id: symbolId }, packages, model: d.model && modelId ? { ...d.model, id: modelId } : null };
}

const sym = standardSymbol;
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
    values: { capacitance: q(47e-6, 'F') }, ratings: { voltage: q(50, 'V') }, tolerancePct: 20, polarized: true, temperature: { minC: -40, maxC: 105 },
    symbol: sym('iec-capacitor-polar'), packages: [{ family: 'RADIAL', params: { pitch: 2.5, diameter: 6.3, polar: true }, pinMap: 'identity' }],
    model: { ...C_MODEL, name: 'Идеальный конденсатор (полярность не моделируется)' } },
  { key: 'ind/radial', name: 'Дроссель радиальный', category: 'inductor', refPrefix: 'L', description: 'Катушка индуктивности на ферритовом сердечнике', generic: true,
    values: { inductance: q(100e-6, 'H') }, ratings: { current: q(0.5, 'A') }, tolerancePct: 10,
    symbol: sym('iec-inductor'), packages: [{ family: 'RADIAL', params: { pitch: 5, diameter: 8, polar: false }, pinMap: 'identity' }], model: L_MODEL },
  { key: 'fuse/5x20', name: 'Предохранитель 5×20 мм в держателе', category: 'fuse', refPrefix: 'FU', description: 'Плавкая вставка в держателе для печатной платы', generic: true,
    ratings: { current: q(1, 'A'), voltage: q(250, 'V') },
    symbol: sym('fuse'), packages: [{ family: 'AXIAL', params: { pitch: 22.6, bodyL: 20, bodyD: 5, drill: 1.3 }, pinMap: 'identity' }], model: null },
  { key: 'varistor/14d471', name: 'Варистор 470 В', category: 'varistor', refPrefix: 'RU', description: 'Металлооксидный варистор ∅14 мм для сети 230 В', generic: false, partNumber: '14D471K', marking: '14D471K',
    ratings: { voltage: q(300, 'V') },
    symbol: sym('varistor'), packages: [{ family: 'RADIAL', params: { pitch: 7.5, diameter: 15.5, drill: 1, polar: false }, pinMap: 'identity' }], model: null },
  { key: 'conn/header-1x2', name: 'Штыревой разъём 1×2', category: 'connector', refPrefix: 'X', description: 'PLS, шаг 2,54 мм', generic: true,
    symbol: ic('Разъём 1×2', [['1', '1', 'passive'], ['2', '2', 'passive']]), packages: [{ family: 'HEADER', params: { rows: 1, pins: 2 }, pinMap: 'identity' }], model: CONNECTOR },
  { key: 'conn/header-1x4', name: 'Штыревой разъём 1×4', category: 'connector', refPrefix: 'X', description: 'PLS, шаг 2,54 мм', generic: true,
    symbol: ic('Разъём 1×4', [['1', '1', 'passive'], ['2', '2', 'passive'], ['3', '3', 'passive'], ['4', '4', 'passive']]), packages: [{ family: 'HEADER', params: { rows: 1, pins: 4 }, pinMap: 'identity' }], model: CONNECTOR },
  { key: 'conn/terminal-2', name: 'Клеммник винтовой 2 контакта', category: 'connector', refPrefix: 'X', description: 'Шаг 5,08 мм', generic: true,
    ratings: { current: q(10, 'A') },
    symbol: ic('Клеммник 2', [['1', '1', 'passive'], ['2', '2', 'passive']]), packages: [{ family: 'TERMINAL', params: { pins: 2 }, pinMap: 'identity' }], model: CONNECTOR },
  { key: 'switch/tact', name: 'Кнопка тактовая 6×6', category: 'switch', refPrefix: 'SB', description: 'Без фиксации. Корпус не задан: у кнопок 6×6 четыре вывода, попарно соединённых внутри, — добавьте корпус по даташиту', generic: true,
    ratings: { current: q(0.05, 'A'), voltage: q(12, 'V') },
    symbol: sym('switch'), packages: [], model: null },
  { key: 'led/5mm-red', name: 'Светодиод 5 мм красный', category: 'led', refPrefix: 'HL', description: 'Индикаторный светодиод; вывод катода короче, у катода срез на корпусе', generic: true,
    ratings: { current: q(0.02, 'A'), reverseVoltage: q(5, 'V') },
    symbol: sym('led'), packages: [{ family: 'RADIAL', params: { pitch: 2.54, diameter: 5, polar: false }, pinMap: [['1', '1'], ['2', '2']] }], model: null },

  // ---------- Диоды ----------
  { key: 'diode/1n4007', name: 'Диод выпрямительный 1N4007', category: 'diode', refPrefix: 'VD', description: 'Выпрямительный диод 1 А, 1000 В', generic: false, partNumber: '1N4007', marking: '1N4007',
    ratings: { reverseVoltage: q(1000, 'V'), current: q(1, 'A'), surgeCurrent: q(30, 'A') }, temperature: { minC: -65, maxC: 175 },
    symbol: sym('diode'), packages: [{ family: 'AXIAL', params: { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 }, pinMap: [['1', '1'], ['2', '2']] }], model: null },
  { key: 'diode/1n4148', name: 'Диод импульсный 1N4148', category: 'diode', refPrefix: 'VD', description: 'Быстрый кремниевый диод малой мощности', generic: false, partNumber: '1N4148', marking: '4148',
    ratings: { reverseVoltage: q(100, 'V'), current: q(0.15, 'A') },
    symbol: sym('diode'), packages: [{ family: 'AXIAL', params: { pitch: 7.62, bodyL: 3.9, bodyD: 1.9, drill: 0.7 }, pinMap: [['1', '1'], ['2', '2']] }], model: null },
  { key: 'diode/1n5819', name: 'Диод Шоттки 1N5819', category: 'diode', refPrefix: 'VD', description: 'Диод Шоттки 1 А, 40 В', generic: false, partNumber: '1N5819',
    ratings: { reverseVoltage: q(40, 'V'), current: q(1, 'A') },
    symbol: sym('diode'), packages: [{ family: 'AXIAL', params: { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 }, pinMap: [['1', '1'], ['2', '2']] }], model: null },
  { key: 'zener/1n4733a', name: 'Стабилитрон 1N4733A (5,1 В, 1 Вт)', category: 'zener', refPrefix: 'VD', description: 'Стабилитрон 5,1 В, 1 Вт', generic: false, partNumber: '1N4733A',
    values: { zenerVoltage: q(5.1, 'V') }, ratings: { power: q(1, 'W') }, tolerancePct: 5,
    symbol: sym('zener'), packages: [{ family: 'AXIAL', params: { pitch: 10.16, bodyL: 5.2, bodyD: 2.7, drill: 1 }, pinMap: [['1', '1'], ['2', '2']] }], model: null },
  { key: 'zener/bzx55c5v1', name: 'Стабилитрон BZX55C5V1 (5,1 В, 0,5 Вт)', category: 'zener', refPrefix: 'VD', description: 'Стабилитрон 5,1 В, 0,5 Вт', generic: false, partNumber: 'BZX55C5V1',
    values: { zenerVoltage: q(5.1, 'V') }, ratings: { power: q(0.5, 'W') }, tolerancePct: 5,
    symbol: sym('zener'), packages: [{ family: 'AXIAL', params: { pitch: 7.62, bodyL: 3.9, bodyD: 1.9, drill: 0.7 }, pinMap: [['1', '1'], ['2', '2']] }], model: null },
  { key: 'bridge/generic', name: 'Диодный мост (типовой)', category: 'bridge', refPrefix: 'VD', description: 'Однофазный выпрямительный мост. Корпус не задан: разводка выводов у мостов разных серий разная — добавьте корпус по даташиту своей детали.', generic: true,
    ratings: { reverseVoltage: q(1000, 'V'), current: q(1, 'A') },
    symbol: sym('bridge'), packages: [], model: null },

  // ---------- Транзисторы ----------
  { key: 'bjt/bc547', name: 'Транзистор BC547 (n-p-n)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный n-p-n транзистор общего применения', generic: false, partNumber: 'BC547', marking: 'BC547',
    ratings: { vce: q(45, 'V'), current: q(0.1, 'A'), power: q(0.5, 'W') },
    symbol: sym('npn'), packages: [{ family: 'TO-92', params: { pitch: 1.27 }, pinMap: [['2', '1'], ['1', '2'], ['3', '3']] }], model: null },
  { key: 'bjt/bc557', name: 'Транзистор BC557 (p-n-p)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный p-n-p транзистор общего применения', generic: false, partNumber: 'BC557', marking: 'BC557',
    ratings: { vce: q(45, 'V'), current: q(0.1, 'A'), power: q(0.5, 'W') },
    symbol: sym('pnp'), packages: [{ family: 'TO-92', params: { pitch: 1.27 }, pinMap: [['2', '1'], ['1', '2'], ['3', '3']] }], model: null },
  { key: 'bjt/2n3904', name: 'Транзистор 2N3904 (n-p-n)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный n-p-n транзистор', generic: false, partNumber: '2N3904',
    ratings: { vce: q(40, 'V'), current: q(0.2, 'A'), power: q(0.625, 'W') },
    symbol: sym('npn'), packages: [{ family: 'TO-92', params: { pitch: 1.27 }, pinMap: [['3', '1'], ['1', '2'], ['2', '3']] }], model: null },
  { key: 'bjt/2n3906', name: 'Транзистор 2N3906 (p-n-p)', category: 'bjt', refPrefix: 'VT', description: 'Маломощный p-n-p транзистор', generic: false, partNumber: '2N3906',
    ratings: { vce: q(40, 'V'), current: q(0.2, 'A'), power: q(0.625, 'W') },
    symbol: sym('pnp'), packages: [{ family: 'TO-92', params: { pitch: 1.27 }, pinMap: [['3', '1'], ['1', '2'], ['2', '3']] }], model: null },
  { key: 'mos/irf540n', name: 'MOSFET IRF540N (n-канал)', category: 'mosfet', refPrefix: 'VT', description: 'Мощный n-канальный MOSFET 100 В, 33 А', generic: false, partNumber: 'IRF540N',
    ratings: { vds: q(100, 'V'), current: q(33, 'A'), rdsOn: q(0.044, 'Ω') },
    symbol: sym('nmos'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['1', '1'], ['2', '2'], ['3', '3']] }], model: null },
  { key: 'mos/irlz44n', name: 'MOSFET IRLZ44N (n-канал, логический уровень)', category: 'mosfet', refPrefix: 'VT', description: 'n-канальный MOSFET с управлением от 5 В логики', generic: false, partNumber: 'IRLZ44N',
    ratings: { vds: q(55, 'V'), current: q(47, 'A'), rdsOn: q(0.022, 'Ω') },
    symbol: sym('nmos'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['1', '1'], ['2', '2'], ['3', '3']] }], model: null },
  { key: 'mos/2n7000', name: 'MOSFET 2N7000 (n-канал, малый)', category: 'mosfet', refPrefix: 'VT', description: 'Маломощный n-канальный MOSFET 60 В, 0,2 А', generic: false, partNumber: '2N7000',
    ratings: { vds: q(60, 'V'), current: q(0.2, 'A') },
    symbol: sym('nmos'), packages: [{ family: 'TO-92', params: { pitch: 1.27 }, pinMap: [['3', '1'], ['1', '2'], ['2', '3']] }], model: null },
  { key: 'thy/bt151', name: 'Тиристор BT151-500R', category: 'thyristor', refPrefix: 'VS', description: 'Тиристор 500 В, 12 А (действующее значение)', generic: false, partNumber: 'BT151-500R',
    ratings: { reverseVoltage: q(500, 'V'), current: q(12, 'A') },
    symbol: sym('thyristor'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['2', '1'], ['1', '2'], ['3', '3']] }], model: null },
  { key: 'triac/bt136', name: 'Симистор BT136-600', category: 'triac', refPrefix: 'VS', description: 'Симистор 600 В, 4 А (действующее значение)', generic: false, partNumber: 'BT136-600',
    ratings: { voltage: q(600, 'V'), current: q(4, 'A') },
    symbol: sym('triac'), packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: [['1', '1'], ['2', '2'], ['3', '3']] }], model: null },

  // ---------- Микросхемы ----------
  { key: 'ic/ne555', name: 'Таймер NE555', category: 'ic-analog', refPrefix: 'DA', description: 'Универсальный таймер: генератор, одновибратор', generic: false, partNumber: 'NE555',
    ratings: { supplyMin: q(4.5, 'V'), supplyMax: q(16, 'V'), current: q(0.2, 'A') }, temperature: { minC: 0, maxC: 70 },
    symbol: ic('NE555', [['2', 'TR', 'input', 'запуск (ниже 1/3 Uпит)'], ['6', 'THR', 'input', 'порог (выше 2/3 Uпит)'], ['4', 'R', 'input', 'сброс (активный низкий)'], ['5', 'CV', 'input', 'управляющее напряжение'],
      ['3', 'Q', 'output', 'выход'], ['7', 'DIS', 'output', 'разряд (открытый коллектор)'], ['8', 'VCC', 'power-in', 'питание +4,5…16 В'], ['1', 'GND', 'ground', 'общий']]),
    packages: [{ family: 'DIP', params: { pins: 8 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 8 }, pinMap: 'identity' }], model: null },
  { key: 'ic/lm358', name: 'Сдвоенный ОУ LM358', category: 'ic-analog', refPrefix: 'DA', description: 'Два операционных усилителя с однополярным питанием', generic: false, partNumber: 'LM358',
    ratings: { supplyMin: q(3, 'V'), supplyMax: q(32, 'V') },
    symbol: ic('LM358', [['3', '+IN A', 'input'], ['2', '−IN A', 'input'], ['5', '+IN B', 'input'], ['6', '−IN B', 'input'],
      ['1', 'OUT A', 'output'], ['7', 'OUT B', 'output'], ['8', 'V+', 'power-in', 'питание 3…32 В'], ['4', 'GND', 'ground', 'общий / V−']]),
    packages: [{ family: 'DIP', params: { pins: 8 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 8 }, pinMap: 'identity' }], model: null },
  { key: 'ic/lm317', name: 'Регулируемый стабилизатор LM317', category: 'ic-analog', refPrefix: 'DA', description: 'Линейный регулируемый стабилизатор 1,25…37 В, 1,5 А', generic: false, partNumber: 'LM317T',
    ratings: { outputMin: q(1.25, 'V'), outputMax: q(37, 'V'), current: q(1.5, 'A') },
    symbol: ic('LM317', [['3', 'IN', 'power-in', 'вход'], ['2', 'OUT', 'power-out', 'выход'], ['1', 'ADJ', 'input', 'регулировка']]),
    packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: 'identity' }], model: null },
  { key: 'ic/l7805', name: 'Стабилизатор L7805 (+5 В)', category: 'ic-analog', refPrefix: 'DA', description: 'Линейный стабилизатор +5 В, 1,5 А', generic: false, partNumber: 'L7805CV',
    ratings: { supplyMax: q(35, 'V'), current: q(1.5, 'A') },
    symbol: ic('7805', [['1', 'IN', 'power-in', 'вход 7…35 В'], ['3', 'OUT', 'power-out', 'выход +5 В'], ['2', 'GND', 'ground', 'общий']]),
    packages: [{ family: 'TO-220', params: { pins: 3 }, pinMap: 'identity' }], model: null },
  { key: 'ic/74hc00', name: '4 элемента 2И-НЕ 74HC00', category: 'ic-digital', refPrefix: 'DD', description: 'Четыре логических элемента 2И-НЕ, КМОП', generic: false, partNumber: '74HC00',
    ratings: { supplyMin: q(2, 'V'), supplyMax: q(6, 'V') },
    symbol: ic('74HC00', [['1', '1A', 'input'], ['2', '1B', 'input'], ['4', '2A', 'input'], ['5', '2B', 'input'], ['9', '3A', 'input'], ['10', '3B', 'input'], ['12', '4A', 'input'], ['13', '4B', 'input'],
      ['3', '1Y', 'output'], ['6', '2Y', 'output'], ['8', '3Y', 'output'], ['11', '4Y', 'output'], ['14', 'VCC', 'power-in'], ['7', 'GND', 'ground']]),
    packages: [{ family: 'DIP', params: { pins: 14 }, pinMap: 'identity' }, { family: 'SOIC', params: { pins: 14 }, pinMap: 'identity' }], model: null },
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
];

let cache: PartBundle[] | null = null;

/** Все детали встроенного справочника: 4 идеальные детали прототипа + типовые + реальные. */
export function builtinCatalog(): PartBundle[] {
  if (!cache) cache = [...BUILTIN_PARTS.map(builtinBundle), ...DEFS.map(make)];
  return cache;
}

export const isBuiltinPart = (partId: string) => builtinCatalog().some((b) => b.part.id === partId);
