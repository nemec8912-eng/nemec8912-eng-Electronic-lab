/**
 * Условные графические обозначения (IEC 60617 / ГОСТ 2.7xx-подобные). Здесь — только данные символа:
 * вид (graphic) и выводы с координатами; рисует их интерфейс (src/renderer/symbols.tsx).
 * Нумерация выводов — как в библиотеках KiCad (диод: 1 — катод; биполярный транзистор: 1 — база,
 * 2 — коллектор, 3 — эмиттер; MOSFET: 1 — затвор, 2 — сток, 3 — исток). Соответствие выводам корпуса
 * конкретной детали задаёт pinMap, поэтому символ общий, а разводка корпуса — своя у каждой детали.
 */
import type { SymbolDef } from './model';

type Pin = SymbolDef['pins'][number];
export type SymbolTemplate = Omit<SymbolDef, 'id'>;

const pin = (number: string, name: string, electricalType: Pin['electricalType'], x: number, y: number, description = ''): Pin =>
  ({ number, name, electricalType, x, y, description });

const STD = 'IEC 60617 / ГОСТ 2.728–2.730';

export const STANDARD_SYMBOLS: Record<string, () => SymbolTemplate> = {
  'iec-resistor': () => ({ name: 'Резистор', standard: STD, graphic: 'iec-resistor', box: null, pins: [pin('1', '1', 'passive', -30, 0), pin('2', '2', 'passive', 30, 0)] }),
  'iec-capacitor': () => ({ name: 'Конденсатор', standard: STD, graphic: 'iec-capacitor', box: null, pins: [pin('1', '1', 'passive', -30, 0), pin('2', '2', 'passive', 30, 0)] }),
  'iec-capacitor-polar': () => ({ name: 'Конденсатор полярный', standard: STD, graphic: 'iec-capacitor-polar', box: null, pins: [pin('1', '+', 'passive', -30, 0), pin('2', '−', 'passive', 30, 0)] }),
  'iec-inductor': () => ({ name: 'Катушка индуктивности', standard: STD, graphic: 'iec-inductor', box: null, pins: [pin('1', '1', 'passive', -40, 0), pin('2', '2', 'passive', 40, 0)] }),
  'diode': () => ({ name: 'Диод', standard: STD, graphic: 'diode', box: null, pins: [pin('1', 'K', 'passive', 30, 0, 'катод'), pin('2', 'A', 'passive', -30, 0, 'анод')] }),
  'zener': () => ({ name: 'Стабилитрон', standard: STD, graphic: 'zener', box: null, pins: [pin('1', 'K', 'passive', 30, 0, 'катод'), pin('2', 'A', 'passive', -30, 0, 'анод')] }),
  'led': () => ({ name: 'Светодиод', standard: STD, graphic: 'led', box: null, pins: [pin('1', 'K', 'passive', 30, 0, 'катод'), pin('2', 'A', 'passive', -30, 0, 'анод')] }),
  'bridge': () => ({ name: 'Диодный мост', standard: STD, graphic: 'bridge', box: null, pins: [
    pin('1', '~', 'passive', -40, 0, 'переменное напряжение'), pin('2', '+', 'power-out', 0, -40, 'выход +'),
    pin('3', '~', 'passive', 40, 0, 'переменное напряжение'), pin('4', '−', 'power-out', 0, 40, 'выход −')] }),
  'npn': () => ({ name: 'Транзистор n-p-n', standard: STD, graphic: 'npn', box: null, pins: [pin('1', 'B', 'input', -30, 0, 'база'), pin('2', 'C', 'passive', 10, -30, 'коллектор'), pin('3', 'E', 'passive', 10, 30, 'эмиттер')] }),
  'pnp': () => ({ name: 'Транзистор p-n-p', standard: STD, graphic: 'pnp', box: null, pins: [pin('1', 'B', 'input', -30, 0, 'база'), pin('2', 'C', 'passive', 10, 30, 'коллектор'), pin('3', 'E', 'passive', 10, -30, 'эмиттер')] }),
  'nmos': () => ({ name: 'MOSFET n-канальный', standard: STD, graphic: 'nmos', box: null, pins: [pin('1', 'G', 'input', -30, 10, 'затвор'), pin('2', 'D', 'passive', 10, -30, 'сток'), pin('3', 'S', 'passive', 10, 30, 'исток')] }),
  'pmos': () => ({ name: 'MOSFET p-канальный', standard: STD, graphic: 'pmos', box: null, pins: [pin('1', 'G', 'input', -30, -10, 'затвор'), pin('2', 'D', 'passive', 10, 30, 'сток'), pin('3', 'S', 'passive', 10, -30, 'исток')] }),
  'thyristor': () => ({ name: 'Тиристор', standard: STD, graphic: 'thyristor', box: null, pins: [pin('1', 'A', 'passive', -30, 0, 'анод'), pin('2', 'K', 'passive', 30, 0, 'катод'), pin('3', 'G', 'input', 10, 30, 'управляющий электрод')] }),
  'triac': () => ({ name: 'Симистор', standard: STD, graphic: 'triac', box: null, pins: [pin('1', 'T1', 'passive', -30, 0, 'силовой вывод 1'), pin('2', 'T2', 'passive', 30, 0, 'силовой вывод 2'), pin('3', 'G', 'input', 10, 30, 'управляющий электрод')] }),
  'varistor': () => ({ name: 'Варистор', standard: STD, graphic: 'varistor', box: null, pins: [pin('1', '1', 'passive', -30, 0), pin('2', '2', 'passive', 30, 0)] }),
  'fuse': () => ({ name: 'Предохранитель', standard: STD, graphic: 'fuse', box: null, pins: [pin('1', '1', 'passive', -30, 0), pin('2', '2', 'passive', 30, 0)] }),
  'switch': () => ({ name: 'Выключатель', standard: STD, graphic: 'switch', box: null, pins: [pin('1', '1', 'passive', -30, 0), pin('2', '2', 'passive', 30, 0)] }),
  'relay': () => ({ name: 'Реле (катушка и переключающий контакт)', standard: STD, graphic: 'relay', box: null, pins: [
    pin('1', 'A1', 'passive', -40, -20, 'катушка'), pin('2', 'A2', 'passive', -40, 20, 'катушка'),
    pin('3', 'COM', 'passive', 40, 0, 'общий'), pin('4', 'NO', 'passive', 40, -20, 'нормально разомкнутый'), pin('5', 'NC', 'passive', 40, 20, 'нормально замкнутый')] }),
  'transformer': () => ({ name: 'Трансформатор', standard: STD, graphic: 'transformer', box: null, pins: [
    pin('1', 'I1', 'passive', -40, -30, 'первичная обмотка'), pin('2', 'I2', 'passive', -40, 30, 'первичная обмотка'),
    pin('3', 'II1', 'passive', 40, -30, 'вторичная обмотка'), pin('4', 'II2', 'passive', 40, 30, 'вторичная обмотка')] }),
};

/** Стандартный символ категории. */
export const SYMBOL_FOR_CATEGORY: Record<string, string> = {
  resistor: 'iec-resistor', capacitor: 'iec-capacitor', 'capacitor-polar': 'iec-capacitor-polar', inductor: 'iec-inductor',
  diode: 'diode', zener: 'zener', led: 'led', bridge: 'bridge', bjt: 'npn', mosfet: 'nmos', thyristor: 'thyristor', triac: 'triac',
  varistor: 'varistor', fuse: 'fuse', relay: 'relay', transformer: 'transformer', switch: 'switch',
};

export function standardSymbol(graphic: string): SymbolTemplate {
  const f = STANDARD_SYMBOLS[graphic];
  if (!f) throw new Error(`Нет стандартного символа ${graphic}`);
  return f();
}

export interface IcPinInput {
  number: string;
  name: string;
  electricalType: Pin['electricalType'];
  description?: string;
  /** Сторона прямоугольника; если не задана — по типу вывода. */
  side?: 'left' | 'right' | 'top' | 'bottom';
}

const PIN_STEP = 20;
const STUB = 20;

/**
 * Символ микросхемы — прямоугольник с выводами (ГОСТ 2.743-подобно): входы слева, выходы и
 * двунаправленные справа, питание сверху, земля снизу. Порядок внутри стороны — как в списке.
 */
export function icSymbol(name: string, pins: IcPinInput[]): SymbolTemplate {
  const sideOf = (p: IcPinInput): NonNullable<IcPinInput['side']> => p.side ?? (
    p.electricalType === 'power-in' ? 'top'
      : p.electricalType === 'ground' ? 'bottom'
        : p.electricalType === 'output' || p.electricalType === 'bidirectional' || p.electricalType === 'power-out' ? 'right'
          : 'left');
  const groups = { left: [] as IcPinInput[], right: [] as IcPinInput[], top: [] as IcPinInput[], bottom: [] as IcPinInput[] };
  for (const p of pins) groups[sideOf(p)].push(p);
  const rows = Math.max(groups.left.length, groups.right.length, 1);
  const cols = Math.max(groups.top.length, groups.bottom.length, 1);
  // Выводы сверху/снизу разносятся так, чтобы их имена не наезжали друг на друга.
  const tbName = Math.max(0, ...groups.top.map((p) => p.name.length), ...groups.bottom.map((p) => p.name.length));
  const tbStep = Math.max(1, Math.ceil((tbName * 6.5 + 8) / PIN_STEP)) * PIN_STEP;
  const h = Math.max(2, rows + 1) * PIN_STEP;
  const w = Math.max(4 * PIN_STEP, (cols + 1) * tbStep, longestName(groups) * PIN_STEP);
  const x0 = -Math.round(w / 2 / PIN_STEP) * PIN_STEP, y0 = -Math.round(h / 2 / PIN_STEP) * PIN_STEP;
  const box = { x: x0, y: y0, w: Math.round(w / PIN_STEP) * PIN_STEP, h: Math.round(h / PIN_STEP) * PIN_STEP };
  const out: Pin[] = [];
  groups.left.forEach((p, i) => out.push(pinOf(p, box.x - STUB, box.y + (i + 1) * PIN_STEP)));
  groups.right.forEach((p, i) => out.push(pinOf(p, box.x + box.w + STUB, box.y + (i + 1) * PIN_STEP)));
  const tbX = (i: number, n: number) => box.x + Math.round((box.w / 2 + (i - (n - 1) / 2) * tbStep) / PIN_STEP) * PIN_STEP;
  groups.top.forEach((p, i) => out.push(pinOf(p, tbX(i, groups.top.length), box.y - STUB)));
  groups.bottom.forEach((p, i) => out.push(pinOf(p, tbX(i, groups.bottom.length), box.y + box.h + STUB)));
  return { name, standard: 'ГОСТ 2.743-подобный (прямоугольник)', graphic: 'box', box, pins: out };
}

function longestName(g: Record<string, IcPinInput[]>): number {
  const l = Math.max(0, ...g.left!.map((p) => p.name.length)), r = Math.max(0, ...g.right!.map((p) => p.name.length));
  return Math.ceil(((l + r) * 7 + 30) / PIN_STEP);
}

function pinOf(p: IcPinInput, x: number, y: number): Pin {
  return { number: p.number, name: p.name, electricalType: p.electricalType, x, y, description: p.description ?? '' };
}
