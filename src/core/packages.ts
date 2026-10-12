/**
 * Генераторы корпусов (посадочных мест). Координаты — мм, вид сверху (со стороны деталей), начало —
 * у первого вывода или в центре корпуса (для SMD-матриц). Размеры площадок типовые (близкие к IPC-7351);
 * для изготовления их нужно сверить с даташитом конкретной детали — об этом говорит интерфейс.
 */
import type { PackageDef } from './model';

type Pad = PackageDef['pads'][number];
export type PackageTemplate = Omit<PackageDef, 'id'>;
export type GenParams = Record<string, number | string | boolean>;

export interface FamilyInfo {
  id: string;
  label: string;
  mount: 'THT' | 'SMD';
  params: Array<{ key: string; label: string; kind: 'int' | 'mm' | 'choice' | 'bool'; def: number | string | boolean; min?: number; max?: number; step?: number; choices?: string[] }>;
}

export const FAMILIES: FamilyInfo[] = [
  { id: 'DIP', label: 'DIP (выводной, два ряда)', mount: 'THT', params: [
    { key: 'pins', label: 'Выводов', kind: 'int', def: 8, min: 4, max: 64, step: 2 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 2.54 },
    { key: 'span', label: 'Расстояние между рядами, мм', kind: 'mm', def: 7.62 },
    { key: 'drill', label: 'Отверстие, мм', kind: 'mm', def: 0.8 },
  ] },
  { id: 'SOIC', label: 'SOIC (SMD, шаг 1,27)', mount: 'SMD', params: [
    { key: 'pins', label: 'Выводов', kind: 'int', def: 8, min: 4, max: 32, step: 2 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 1.27 },
    { key: 'span', label: 'Между центрами площадок, мм', kind: 'mm', def: 5.4 },
    { key: 'padW', label: 'Длина площадки, мм', kind: 'mm', def: 1.55 },
    { key: 'padH', label: 'Ширина площадки, мм', kind: 'mm', def: 0.6 },
  ] },
  { id: 'SOP', label: 'SOP (SMD, широкий)', mount: 'SMD', params: [
    { key: 'pins', label: 'Выводов', kind: 'int', def: 8, min: 4, max: 44, step: 2 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 1.27 },
    { key: 'span', label: 'Между центрами площадок, мм', kind: 'mm', def: 7.4 },
    { key: 'padW', label: 'Длина площадки, мм', kind: 'mm', def: 1.9 },
    { key: 'padH', label: 'Ширина площадки, мм', kind: 'mm', def: 0.6 },
  ] },
  { id: 'TSSOP', label: 'TSSOP (SMD, шаг 0,65)', mount: 'SMD', params: [
    { key: 'pins', label: 'Выводов', kind: 'int', def: 14, min: 8, max: 64, step: 2 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 0.65 },
    { key: 'span', label: 'Между центрами площадок, мм', kind: 'mm', def: 5.8 },
    { key: 'padW', label: 'Длина площадки, мм', kind: 'mm', def: 1.45 },
    { key: 'padH', label: 'Ширина площадки, мм', kind: 'mm', def: 0.4 },
  ] },
  { id: 'QFP', label: 'QFP (SMD, четыре стороны)', mount: 'SMD', params: [
    { key: 'pins', label: 'Выводов', kind: 'int', def: 32, min: 8, max: 256, step: 4 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 0.8 },
    { key: 'span', label: 'Между центрами противоположных площадок, мм', kind: 'mm', def: 8.4 },
    { key: 'padW', label: 'Длина площадки, мм', kind: 'mm', def: 1.5 },
    { key: 'padH', label: 'Ширина площадки, мм', kind: 'mm', def: 0.5 },
  ] },
  { id: 'QFN', label: 'QFN (SMD, без выводов)', mount: 'SMD', params: [
    { key: 'pins', label: 'Выводов (без теплоотвода)', kind: 'int', def: 16, min: 8, max: 128, step: 4 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 0.5 },
    { key: 'span', label: 'Между центрами противоположных площадок, мм', kind: 'mm', def: 2.9 },
    { key: 'padW', label: 'Длина площадки, мм', kind: 'mm', def: 0.8 },
    { key: 'padH', label: 'Ширина площадки, мм', kind: 'mm', def: 0.25 },
    { key: 'ep', label: 'Теплоотвод (площадка снизу), мм; 0 — нет', kind: 'mm', def: 1.7 },
  ] },
  { id: 'BGA', label: 'BGA (матрица шариков)', mount: 'SMD', params: [
    { key: 'rows', label: 'Рядов', kind: 'int', def: 8, min: 2, max: 40 },
    { key: 'cols', label: 'Столбцов', kind: 'int', def: 8, min: 2, max: 40 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 0.8 },
    { key: 'ball', label: 'Площадка, мм', kind: 'mm', def: 0.4 },
  ] },
  { id: 'SOT-23', label: 'SOT-23 (3/5/6 выводов)', mount: 'SMD', params: [
    { key: 'pins', label: 'Выводов', kind: 'choice', def: '3', choices: ['3', '5', '6'] },
  ] },
  { id: 'SOT-223', label: 'SOT-223', mount: 'SMD', params: [] },
  { id: 'TO-92', label: 'TO-92 (выводной, 3 вывода)', mount: 'THT', params: [
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 2.54 },
  ] },
  { id: 'TO-220', label: 'TO-220 (выводной, 3 вывода)', mount: 'THT', params: [
    { key: 'pins', label: 'Выводов', kind: 'int', def: 3, min: 2, max: 7 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 2.54 },
  ] },
  { id: 'AXIAL', label: 'Аксиальный (резистор, диод DO-41)', mount: 'THT', params: [
    { key: 'pitch', label: 'Между отверстиями, мм', kind: 'mm', def: 10.16 },
    { key: 'drill', label: 'Отверстие, мм', kind: 'mm', def: 0.8 },
    { key: 'bodyL', label: 'Длина корпуса, мм', kind: 'mm', def: 6.3 },
    { key: 'bodyD', label: 'Диаметр корпуса, мм', kind: 'mm', def: 2.5 },
  ] },
  { id: 'RADIAL', label: 'Радиальный (конденсатор)', mount: 'THT', params: [
    { key: 'pitch', label: 'Между выводами, мм', kind: 'mm', def: 2.5 },
    { key: 'diameter', label: 'Диаметр корпуса, мм', kind: 'mm', def: 6.3 },
    { key: 'drill', label: 'Отверстие, мм', kind: 'mm', def: 0.8 },
    { key: 'polar', label: 'Полярный (вывод 1 — «+»)', kind: 'bool', def: true },
  ] },
  { id: 'CHIP', label: 'Чип SMD (0402…2512)', mount: 'SMD', params: [
    { key: 'size', label: 'Типоразмер', kind: 'choice', def: '0805', choices: ['0402', '0603', '0805', '1206', '1210', '2010', '2512'] },
  ] },
  { id: 'SMA', label: 'DO-214 SMA/SMB/SMC (диод SMD)', mount: 'SMD', params: [
    { key: 'size', label: 'Типоразмер', kind: 'choice', def: 'SMA', choices: ['SMA', 'SMB', 'SMC'] },
  ] },
  { id: 'HEADER', label: 'Штыревой разъём (шаг 2,54)', mount: 'THT', params: [
    { key: 'rows', label: 'Рядов', kind: 'int', def: 1, min: 1, max: 2 },
    { key: 'pins', label: 'Выводов в ряду', kind: 'int', def: 4, min: 1, max: 40 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 2.54 },
  ] },
  { id: 'TERMINAL', label: 'Клеммник винтовой', mount: 'THT', params: [
    { key: 'pins', label: 'Контактов', kind: 'int', def: 2, min: 2, max: 12 },
    { key: 'pitch', label: 'Шаг, мм', kind: 'mm', def: 5.08 },
  ] },
];

const r2 = (v: number) => Math.round(v * 1000) / 1000;
const num = (p: GenParams, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : Number(p[k] ?? d) || d);
const str = (p: GenParams, k: string, d: string) => (p[k] === undefined ? d : String(p[k]));
const bool = (p: GenParams, k: string, d: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);

function tht(n: string, x: number, y: number, drill: number, first = false, pad = Math.max(1.6, drill + 0.8)): Pad {
  return { number: n, x: r2(x), y: r2(y), shape: first ? 'rect' : 'round', w: r2(pad), h: r2(pad), drill: r2(drill) };
}
function smd(n: string, x: number, y: number, w: number, h: number, shape: Pad['shape'] = 'rect'): Pad {
  return { number: n, x: r2(x), y: r2(y), shape, w: r2(w), h: r2(h), drill: null };
}
function bodyAround(pads: Pad[], margin: number): PackageTemplate['body'] {
  const xs = pads.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]), ys = pads.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2]);
  const x = Math.min(...xs) - margin, y = Math.min(...ys) - margin;
  return { x: r2(x), y: r2(y), w: r2(Math.max(...xs) + margin - x), h: r2(Math.max(...ys) + margin - y) };
}

/** Два ряда, нумерация против часовой стрелки от вывода 1 (вид сверху): вниз по левому ряду, вверх по правому. */
function dualRow(pins: number, pitch: number, span: number, mk: (n: string, x: number, y: number, first: boolean) => Pad): Pad[] {
  const half = pins / 2;
  const pads: Pad[] = [];
  for (let i = 0; i < half; i++) pads.push(mk(String(i + 1), 0, i * pitch, i === 0));
  for (let i = 0; i < half; i++) pads.push(mk(String(half + i + 1), span, (half - 1 - i) * pitch, false));
  return pads;
}

/** Четыре стороны, против часовой стрелки от вывода 1 (верх левой стороны), центр корпуса — (0,0). */
function quad(pins: number, pitch: number, span: number, padW: number, padH: number): Pad[] {
  const side = pins / 4;
  const off = ((side - 1) * pitch) / 2;
  const pads: Pad[] = [];
  let n = 1;
  for (let i = 0; i < side; i++) pads.push(smd(String(n++), -span / 2, -off + i * pitch, padW, padH));       // левая, сверху вниз
  for (let i = 0; i < side; i++) pads.push(smd(String(n++), -off + i * pitch, span / 2, padH, padW));        // нижняя, слева направо
  for (let i = 0; i < side; i++) pads.push(smd(String(n++), span / 2, off - i * pitch, padW, padH));         // правая, снизу вверх
  for (let i = 0; i < side; i++) pads.push(smd(String(n++), off - i * pitch, -span / 2, padH, padW));        // верхняя, справа налево
  return pads;
}

const BGA_ROWS = 'ABCDEFGHJKLMNPRTUVWY'; // JEDEC: без I, O, Q, S, X, Z
function bgaRowName(i: number): string {
  if (i < BGA_ROWS.length) return BGA_ROWS[i]!;
  return BGA_ROWS[Math.floor(i / BGA_ROWS.length) - 1]! + BGA_ROWS[i % BGA_ROWS.length]!;
}

const CHIP_SIZES: Record<string, { pitch: number; w: number; h: number; body: [number, number] }> = {
  '0402': { pitch: 1.0, w: 0.6, h: 0.6, body: [1.0, 0.5] },
  '0603': { pitch: 1.6, w: 0.9, h: 0.95, body: [1.6, 0.8] },
  '0805': { pitch: 1.9, w: 1.0, h: 1.3, body: [2.0, 1.25] },
  '1206': { pitch: 3.0, w: 1.15, h: 1.8, body: [3.2, 1.6] },
  '1210': { pitch: 3.0, w: 1.15, h: 2.7, body: [3.2, 2.5] },
  '2010': { pitch: 4.4, w: 1.3, h: 2.6, body: [5.0, 2.5] },
  '2512': { pitch: 5.8, w: 1.5, h: 3.4, body: [6.3, 3.2] },
};
const SMA_SIZES: Record<string, { pitch: number; w: number; h: number; body: [number, number] }> = {
  SMA: { pitch: 4.0, w: 2.5, h: 1.7, body: [4.3, 2.6] },
  SMB: { pitch: 4.3, w: 2.5, h: 2.3, body: [4.6, 3.6] },
  SMC: { pitch: 6.8, w: 2.5, h: 3.3, body: [7.0, 5.9] },
};

/** Число с десятичной запятой для названий корпусов. */
const ru = (v: number) => String(v).replace('.', ',');

/** Построить корпус по семейству и параметрам. Бросает ошибку с понятным текстом при недопустимых параметрах. */
export function generatePackage(family: string, params: GenParams = {}): PackageTemplate {
  const fam = FAMILIES.find((f) => f.id === family);
  if (!fam) throw new Error(`Неизвестное семейство корпусов: ${family}`);
  const p: GenParams = {};
  for (const d of fam.params) p[d.key] = params[d.key] ?? d.def;
  for (const d of fam.params) {
    if ((d.kind === 'int' || d.kind === 'mm') && (typeof p[d.key] !== 'number' || !Number.isFinite(p[d.key] as number) || (p[d.key] as number) <= 0)) {
      throw new Error(`${d.label}: нужно положительное число`);
    }
    if (d.kind === 'int' && (!Number.isInteger(p[d.key]) || (d.min !== undefined && (p[d.key] as number) < d.min) || (d.max !== undefined && (p[d.key] as number) > d.max))) {
      throw new Error(`${d.label}: целое от ${d.min} до ${d.max}`);
    }
  }
  const base = { family, mount: fam.mount, generator: { family, params: p } } as const;
  switch (family) {
    case 'DIP': {
      const pins = num(p, 'pins', 8), pitch = num(p, 'pitch', 2.54), span = num(p, 'span', 7.62), drill = num(p, 'drill', 0.8);
      if (pins % 2) throw new Error('DIP: число выводов должно быть чётным');
      const pads = dualRow(pins, pitch, span, (n, x, y, first) => tht(n, x, y, drill, first));
      return { ...base, name: `DIP-${pins} (${span === 15.24 ? '600 mil' : `${ru(span)} мм`})`, pads, body: { x: r2(0.8), y: r2(-1.3), w: r2(span - 1.6), h: r2((pins / 2 - 1) * pitch + 2.6) },
        pin1Marker: 'выемка у вывода 1, квадратная площадка', pitchMm: pitch, numbering: 'против часовой стрелки от вывода 1, вид сверху' };
    }
    case 'SOIC': case 'SOP': case 'TSSOP': {
      const pins = num(p, 'pins', 8), pitch = num(p, 'pitch', 1.27), span = num(p, 'span', 5.4), w = num(p, 'padW', 1.5), h = num(p, 'padH', 0.6);
      if (pins % 2) throw new Error(`${family}: число выводов должно быть чётным`);
      const pads = dualRow(pins, pitch, span, (n, x, y) => smd(n, x, y, w, h));
      return { ...base, name: `${family}-${pins}`, pads, body: { x: r2(w / 2 + 0.2), y: r2(-0.6), w: r2(span - w - 0.4), h: r2((pins / 2 - 1) * pitch + 1.2) },
        pin1Marker: 'точка или скос у вывода 1', pitchMm: pitch, numbering: 'против часовой стрелки от вывода 1, вид сверху' };
    }
    case 'QFP': case 'QFN': {
      const pins = num(p, 'pins', 32), pitch = num(p, 'pitch', 0.8), span = num(p, 'span', 8.4), w = num(p, 'padW', 1.5), h = num(p, 'padH', 0.5);
      if (pins % 4) throw new Error(`${family}: число выводов должно делиться на 4`);
      const pads = quad(pins, pitch, span, w, h);
      if (family === 'QFN' && num(p, 'ep', 0) > 0) pads.push(smd(String(pins + 1), 0, 0, num(p, 'ep', 0), num(p, 'ep', 0)));
      const half = span / 2 - w / 2 - 0.15;
      return { ...base, name: `${family}-${pins} шаг ${ru(pitch)}`, pads, body: { x: r2(-half), y: r2(-half), w: r2(half * 2), h: r2(half * 2) },
        pin1Marker: 'точка у вывода 1 (левый верхний угол)', pitchMm: pitch,
        numbering: `против часовой стрелки от вывода 1, вид сверху${family === 'QFN' && num(p, 'ep', 0) > 0 ? `; теплоотвод — вывод ${pins + 1}` : ''}` };
    }
    case 'BGA': {
      const rows = num(p, 'rows', 8), cols = num(p, 'cols', 8), pitch = num(p, 'pitch', 0.8), ball = num(p, 'ball', 0.4);
      const pads: Pad[] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        pads.push(smd(`${bgaRowName(r)}${c + 1}`, (c - (cols - 1) / 2) * pitch, (r - (rows - 1) / 2) * pitch, ball, ball, 'round'));
      }
      return { ...base, name: `BGA-${rows * cols} ${rows}×${cols} шаг ${ru(pitch)}`, pads, body: bodyAround(pads, pitch / 2),
        pin1Marker: 'метка в углу A1', pitchMm: pitch, numbering: 'ряды A, B, C… (без I, O, Q, S, X, Z), столбцы 1, 2, 3…; A1 — левый верхний, вид сверху' };
    }
    case 'SOT-23': {
      const pins = str(p, 'pins', '3');
      const pads = pins === '3'
        ? [smd('1', -0.95, 1.1, 0.6, 0.9), smd('2', 0.95, 1.1, 0.6, 0.9), smd('3', 0, -1.1, 0.6, 0.9)]
        : pins === '5'
          ? [smd('1', -0.95, 1.1, 0.6, 0.9), smd('2', 0, 1.1, 0.6, 0.9), smd('3', 0.95, 1.1, 0.6, 0.9), smd('4', 0.95, -1.1, 0.6, 0.9), smd('5', -0.95, -1.1, 0.6, 0.9)]
          : [smd('1', -0.95, 1.1, 0.6, 0.9), smd('2', 0, 1.1, 0.6, 0.9), smd('3', 0.95, 1.1, 0.6, 0.9), smd('4', 0.95, -1.1, 0.6, 0.9), smd('5', 0, -1.1, 0.6, 0.9), smd('6', -0.95, -1.1, 0.6, 0.9)];
      return { ...base, name: `SOT-23${pins === '3' ? '' : `-${pins}`}`, pads, body: { x: -1.45, y: -0.65, w: 2.9, h: 1.3 },
        pin1Marker: 'вывод 1 — левый нижний (вид сверху, маркировка читается)', pitchMm: 0.95, numbering: 'против часовой стрелки от вывода 1, вид сверху' };
    }
    case 'SOT-223': {
      const pads = [smd('1', -2.3, 3.15, 1.0, 2.0), smd('2', 0, 3.15, 1.0, 2.0), smd('3', 2.3, 3.15, 1.0, 2.0), smd('4', 0, -3.15, 3.3, 2.0)];
      return { ...base, name: 'SOT-223', pads, body: { x: -3.25, y: -1.75, w: 6.5, h: 3.5 }, pin1Marker: 'вывод 1 — левый нижний; вывод 4 — теплоотвод', pitchMm: 2.3, numbering: 'выводы 1–3 снизу слева направо, 4 — теплоотвод сверху' };
    }
    case 'TO-92': {
      const pitch = num(p, 'pitch', 1.27);
      // Шаг 1,27 — узкие овальные площадки (как в KiCad), иначе медь соседних выводов сольётся;
      // шаг 2,54 («выводы разогнуты») — круглые площадки, удобно для ЛУТ и фрезерования.
      const narrow = pitch < 2;
      const pad = (n: string, x: number): Pad => narrow
        ? { number: n, x: r2(x), y: 0, shape: n === '1' ? 'rect' : 'oval', w: r2(Math.min(1.05, pitch - 0.25)), h: 1.5, drill: 0.75 }
        : tht(n, x, 0, 0.8, n === '1', Math.min(1.6, pitch - 0.6));
      const pads = [pad('1', 0), pad('2', pitch), pad('3', pitch * 2)];
      return { ...base, name: `TO-92 (шаг ${ru(pitch)}${narrow ? '' : ', выводы разогнуты'})`, pads, body: { x: r2(pitch - 2.4), y: -1.6, w: 4.8, h: 3.2 }, pin1Marker: 'плоская сторона к себе, вывод 1 слева', pitchMm: pitch, numbering: 'слева направо, плоской стороной к себе, выводами вниз' };
    }
    case 'TO-220': {
      const pins = num(p, 'pins', 3), pitch = num(p, 'pitch', 2.54);
      const pads = Array.from({ length: pins }, (_, i) => tht(String(i + 1), i * pitch, 0, 1.1, i === 0, 2.0));
      return { ...base, name: `TO-220-${pins}`, pads, body: { x: r2(((pins - 1) * pitch) / 2 - 5.1), y: -3.2, w: 10.2, h: 4.6 }, pin1Marker: 'надписью к себе, вывод 1 слева', pitchMm: pitch, numbering: 'слева направо, маркировкой к себе, выводами вниз' };
    }
    case 'AXIAL': {
      const pitch = num(p, 'pitch', 10.16), drill = num(p, 'drill', 0.8), L = num(p, 'bodyL', 6.3), D = num(p, 'bodyD', 2.5);
      if (L >= pitch) throw new Error('Корпус длиннее расстояния между отверстиями');
      const pads = [tht('1', 0, 0, drill, false), tht('2', pitch, 0, drill, false)];
      return { ...base, name: `Аксиальный, шаг ${ru(pitch)} мм`, pads, body: { x: r2((pitch - L) / 2), y: r2(-D / 2), w: L, h: D }, pin1Marker: null, pitchMm: pitch, numbering: 'для диода вывод 1 — катод (полоса на корпусе)' };
    }
    case 'RADIAL': {
      const pitch = num(p, 'pitch', 2.5), d = num(p, 'diameter', 6.3), drill = num(p, 'drill', 0.8), polar = bool(p, 'polar', true);
      const pads = [tht('1', 0, 0, drill, polar), tht('2', pitch, 0, drill, false)];
      return { ...base, name: `Радиальный ∅${ru(d)}, шаг ${ru(pitch)}`, pads, body: { x: r2(pitch / 2 - d / 2), y: r2(-d / 2), w: d, h: d },
        pin1Marker: polar ? 'вывод 1 — «+» (квадратная площадка); «−» отмечен полосой на корпусе' : null, pitchMm: pitch, numbering: null };
    }
    case 'CHIP': case 'SMA': {
      const size = str(p, 'size', family === 'CHIP' ? '0805' : 'SMA');
      const d = (family === 'CHIP' ? CHIP_SIZES : SMA_SIZES)[size];
      if (!d) throw new Error(`Неизвестный типоразмер ${size}`);
      const pads = [smd('1', -d.pitch / 2, 0, d.w, d.h), smd('2', d.pitch / 2, 0, d.w, d.h)];
      return { ...base, name: family === 'CHIP' ? `${size} (чип)` : `DO-214 ${size}`, pads, body: { x: r2(-d.body[0] / 2), y: r2(-d.body[1] / 2), w: d.body[0], h: d.body[1] },
        pin1Marker: family === 'SMA' ? 'вывод 1 — катод (полоса)' : null, pitchMm: d.pitch, numbering: null };
    }
    case 'HEADER': {
      const rows = num(p, 'rows', 1), per = num(p, 'pins', 4), pitch = num(p, 'pitch', 2.54);
      const pads: Pad[] = [];
      // Двухрядный: нечётные — первый ряд, чётные — второй (как у типовых штыревых разъёмов).
      for (let i = 0; i < per; i++) for (let r = 0; r < rows; r++) {
        const n = rows === 1 ? i + 1 : i * 2 + r + 1;
        pads.push(tht(String(n), r * pitch, i * pitch, 1.0, n === 1, 1.7));
      }
      return { ...base, name: `Штыревой ${rows}×${per}, шаг ${ru(pitch)}`, pads, body: bodyAround(pads, 0.4), pin1Marker: 'квадратная площадка — вывод 1', pitchMm: pitch,
        numbering: rows === 1 ? 'по порядку' : 'нечётные — левый ряд, чётные — правый' };
    }
    case 'TERMINAL': {
      const pins = num(p, 'pins', 2), pitch = num(p, 'pitch', 5.08);
      const pads = Array.from({ length: pins }, (_, i) => tht(String(i + 1), i * pitch, 0, 1.3, i === 0, 2.4));
      return { ...base, name: `Клеммник ${pins} конт., шаг ${ru(pitch)}`, pads, body: { x: -2.5, y: -4, w: r2((pins - 1) * pitch + 5), h: 8 }, pin1Marker: 'контакт 1 — квадратная площадка', pitchMm: pitch, numbering: 'по порядку' };
    }
  }
  throw new Error(`Семейство ${family} не реализовано`);
}

/** Перекрытия площадок с разными номерами (медь сольётся) — для проверки детали. */
export function overlappingPads(pkg: Pick<PackageTemplate, 'pads'>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < pkg.pads.length; i++) for (let j = i + 1; j < pkg.pads.length; j++) {
    const a = pkg.pads[i]!, c = pkg.pads[j]!;
    if (a.number === c.number) continue;
    if (Math.abs(a.x - c.x) < (a.w + c.w) / 2 - 1e-6 && Math.abs(a.y - c.y) < (a.h + c.h) / 2 - 1e-6) out.push([a.number, c.number]);
  }
  return out;
}
