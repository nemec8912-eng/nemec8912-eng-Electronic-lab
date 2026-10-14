/**
 * Воспроизведение рассчитанного переходного процесса и индикаторы на схеме (ТЗ, раздел 6):
 * состояние схемы в момент t (линейная интерполяция между точками ngspice), стрелки направления
 * условного тока, цвет провода по потенциалу. Всё строится только из результата расчёта;
 * между точками расчёта значения интерполируются — так и подписано в интерфейсе.
 * Чистые функции без DOM и Node.
 */
import { formatQuantity } from '../core/library';
import type { PinRef, ProjectDoc } from '../core/model';
import type { OpResult, TranResult } from './results';

/** Состояние схемы в один момент: те же поля, что у рабочей точки. */
export interface Frame {
  /** Время, с (для рабочей точки — null). */
  t: number | null;
  /** Номер ближайшей слева точки расчёта. */
  index: number;
  /** true — момент совпадает с точкой расчёта, false — значение между точками (интерполяция). */
  exact: boolean;
  node: Record<string, number>;
  current: Record<string, number>;
  pins: Record<string, Record<string, number>>;
}

/** Номер точки i, для которой time[i] ≤ t < time[i+1] (двоичный поиск; время в raw не убывает). */
export function indexAt(time: readonly number[], t: number): number {
  const n = time.length;
  if (n === 0) return -1;
  if (!(t > time[0]!)) return 0;
  if (t >= time[n - 1]!) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid]! <= t) lo = mid; else hi = mid;
  }
  return lo;
}

function lerpAll(src: Record<string, number[]>, i: number, k: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(src)) {
    const a = v[i], b = v[i + 1];
    if (a === undefined) continue;
    out[key] = k === 0 || b === undefined ? a : a + (b - a) * k;
  }
  return out;
}

/** Состояние схемы в момент t переходного процесса. t вне диапазона прижимается к краям. */
export function frameAt(tran: TranResult, t: number): Frame {
  const time = tran.time;
  const i = Math.max(0, indexAt(time, t));
  const t0 = time[i] ?? 0, t1 = time[i + 1];
  const tc = Math.min(Math.max(t, time[0] ?? 0), time[time.length - 1] ?? 0);
  const k = t1 === undefined || t1 <= t0 ? 0 : Math.min(1, Math.max(0, (tc - t0) / (t1 - t0)));
  const exact = k === 0 || k === 1;
  const idx = k === 1 ? i + 1 : i;
  const kk = k === 1 ? 0 : k;
  const pins: Record<string, Record<string, number>> = {};
  for (const [id, m] of Object.entries(tran.pins)) pins[id] = lerpAll(m, idx, kk);
  return { t: tc, index: idx, exact, node: lerpAll(tran.node, idx, kk), current: lerpAll(tran.current, idx, kk), pins };
}

/** Рабочая точка как кадр (для стрелок токов в анализе «Рабочая точка»). */
export function frameOfOp(op: OpResult): Frame {
  return { t: null, index: 0, exact: true, node: op.node, current: op.current, pins: op.pins };
}

/** Минимум и максимум потенциалов за весь расчёт — шкала цвета не «прыгает» при воспроизведении. */
export function voltageRange(node: Record<string, number[] | number>): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of Object.values(node)) {
    for (const x of Array.isArray(v) ? v : [v]) if (Number.isFinite(x)) { if (x < min) min = x; if (x > max) max = x; }
  }
  if (min === Infinity) return { min: 0, max: 0 };
  return { min: Math.min(min, 0), max: Math.max(max, 0) };
}

/**
 * Цвет провода по потенциалу: синий — минимум шкалы, серый — 0 В, красный — максимум.
 * Шкала несимметрична, чтобы 0 В всегда был серым (земля).
 */
export function potentialColor(v: number, range: { min: number; max: number }): string {
  if (!Number.isFinite(v)) return 'hsl(0 0% 55%)';
  const s = v >= 0 ? (range.max > 0 ? Math.min(1, v / range.max) : 0) : (range.min < 0 ? Math.min(1, v / range.min) : 0);
  const hue = v >= 0 ? 0 : 220;
  return `hsl(${hue} ${Math.round(15 + 70 * s)}% ${Math.round(55 - 10 * s)}%)`;
}

/** Стрелка условного тока на детали. */
export interface FlowArrow {
  instanceId: string;
  /** Двухвыводная деталь: ток через неё от from к to. */
  from: PinRef;
  /** null — ток вывода прибора: стрелка у вывода from, внутрь детали (inward) или наружу. */
  to: PinRef | null;
  inward: boolean;
  amps: number;
  /** Толщина 0…1 по логарифмической шкале относительно наибольшего тока кадра. */
  weight: number;
  label: string;
}

/** Ток меньше этого (А) считается нулевым: стрелку не рисуем — направление не определено. */
export const ZERO_CURRENT_A = 1e-9;
/** Динамический диапазон толщины стрелок: токи слабее max·10⁻⁶ рисуются самой тонкой стрелкой. */
const DECADES = 6;

function pinsOf(doc: ProjectDoc, instanceId: string): string[] {
  const inst = doc.schematic.instances.find((x) => x.id === instanceId);
  const part = inst && doc.library.parts.find((p) => p.id === inst.partId);
  const sym = part && doc.library.symbols.find((s) => s.id === part.symbolId);
  return sym?.pins.map((p) => p.number) ?? [];
}

/**
 * Стрелки направления условного тока (от «+» к «−» во внешней цепи) по кадру расчёта.
 * Знаки — как в results.ts: ток двухвыводной детали — от вывода 1 к выводу 2 через деталь;
 * ток вывода прибора — втекающий в вывод. Токи ниже ZERO_CURRENT_A не показываются.
 */
export function flowArrows(doc: ProjectDoc, frame: Frame): FlowArrow[] {
  const raw: Array<Omit<FlowArrow, 'weight' | 'label'>> = [];
  for (const [instanceId, i] of Object.entries(frame.current)) {
    if (!Number.isFinite(i) || Math.abs(i) < ZERO_CURRENT_A) continue;
    const pins = pinsOf(doc, instanceId);
    if (pins.length !== 2 || frame.pins[instanceId]) continue;
    const a: PinRef = { instanceId, pin: pins[0]! }, b: PinRef = { instanceId, pin: pins[1]! };
    raw.push(i > 0 ? { instanceId, from: a, to: b, inward: true, amps: i } : { instanceId, from: b, to: a, inward: true, amps: -i });
  }
  for (const [instanceId, m] of Object.entries(frame.pins)) {
    for (const [pin, i] of Object.entries(m)) {
      if (!Number.isFinite(i) || Math.abs(i) < ZERO_CURRENT_A) continue;
      raw.push({ instanceId, from: { instanceId, pin }, to: null, inward: i > 0, amps: Math.abs(i) });
    }
  }
  const max = raw.reduce((m, r) => Math.max(m, r.amps), 0);
  return raw.map((r) => ({
    ...r,
    weight: max > 0 ? Math.max(0, Math.min(1, 1 + Math.log10(r.amps / max) / DECADES)) : 0,
    label: formatQuantity(r.amps, 'А', 3),
  }));
}

/**
 * Скорость воспроизведения: множитель к базовой, при которой весь расчёт проигрывается за
 * BASE_PLAY_S секунд. Возвращает «секунд схемы в секунду экрана».
 */
export const BASE_PLAY_S = 10;
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4] as const;

export function simSecondsPerSecond(tran: TranResult, factor: number): number {
  const span = (tran.time[tran.time.length - 1] ?? 0) - (tran.time[0] ?? 0);
  return span > 0 && factor > 0 ? (span / BASE_PLAY_S) * factor : 0;
}

/** Следующий момент воспроизведения; done — дошли до конца записи. */
export function advance(tran: TranResult, t: number, wallSeconds: number, factor: number): { t: number; done: boolean } {
  const end = tran.time[tran.time.length - 1] ?? 0;
  const next = t + Math.max(0, wallSeconds) * simSecondsPerSecond(tran, factor);
  return next >= end ? { t: end, done: true } : { t: next, done: false };
}

/** Шаг на одну точку расчёта вперёд (+1) или назад (−1) от момента t. */
export function stepPoint(tran: TranResult, t: number, dir: 1 | -1): number {
  const time = tran.time;
  if (!time.length) return 0;
  const i = indexAt(time, t);
  // time[i] ≤ t: следующая точка — i + 1 (и когда t между точками, и когда совпадает с точкой).
  if (dir > 0) return time[Math.min(i + 1, time.length - 1)]!;
  const j = time[i]! < t ? i : i - 1;
  return time[Math.max(0, j)]!;
}

/** Подпись скорости: «1 с на экране = 2 мс схемы». */
export function speedText(tran: TranResult, factor: number): string {
  return `1 с на экране = ${formatQuantity(simSecondsPerSecond(tran, factor), 'с', 3)} схемы`;
}
