/**
 * Измерения, при которых прибор сам воздействует на схему (этап 5): сопротивление, прозвонка,
 * проверка диодов, ESR. Схема обесточивается — источники убираются (разомкнуты), как при отключённом
 * питании; прибор подаёт тестовый ток между щупами (красный — «+»), и показание считается ngspice.
 * Нелинейные детали (диоды, транзисторы) дают то же, что и у настоящего прибора: показание зависит
 * от тестового тока и полярности щупов.
 */
import type { Ngspice } from './engine';
import type { PinRef, ProjectDoc } from '../core/model';
import { formatQuantity } from '../core/library';
import { AppError } from '../core/result';
import { netOfPin } from '../core/schematic';
import { buildNetlist, spiceNumber } from './netlist';
import { runNgspice } from './engine';

export type MeasureKind = 'ohm' | 'cont' | 'diode' | 'esr';
export interface MeasureRequest { kind: MeasureKind; red: PinRef | null; black: PinRef | null; freqHz?: number }

export interface MeasureResult {
  kind: MeasureKind;
  status: 'ok' | 'blocked' | 'failed';
  /** Текст индикатора: «47,0 Ом», «OL», «0,652 В». */
  display: string;
  value: number | null;
  /** Прозвонка: цепь замкнута (звуковой сигнал). */
  beep: boolean;
  /** Как измерено: тестовый ток, диапазон, частота. */
  method: string;
  /** ESR: полное сопротивление и реактивная часть. */
  esr: { re: number; im: number; mag: number; freqHz: number; capacitance: number | null } | null;
  message: string | null;
  netlist: string;
}

/** Диапазоны омметра: тестовый ток и верхняя граница диапазона (при напряжении на щупах до 2 В). */
export const OHM_RANGES: Array<{ current: number; max: number }> = [
  { current: 1e-3, max: 2e3 }, { current: 1e-4, max: 2e4 }, { current: 1e-5, max: 2e5 }, { current: 1e-6, max: 2e6 }, { current: 1e-7, max: 2e7 },
];
const OHM_VMAX = 2;
const DIODE_CURRENT = 1e-3;
const DIODE_VMAX = 3;
const CONT_BEEP = 30;

function prepare(doc: ProjectDoc, req: MeasureRequest) {
  if (!req.red || !req.black) return { error: 'Подключите оба щупа прибора к выводам деталей.' } as const;
  const known = (r: PinRef) => doc.schematic.instances.some((i) => i.id === r.instanceId);
  if (!known(req.red) || !known(req.black)) return { error: 'Деталь под щупом удалена — переставьте щуп.' } as const;
  const rn = netOfPin(doc, req.red)?.id ?? null, bn = netOfPin(doc, req.black)?.id ?? null;
  // Один и тот же провод (или один и тот же вывод) под обоими щупами.
  const same = (rn !== null && rn === bn) || (req.red.instanceId === req.black.instanceId && req.red.pin === req.black.pin);
  return { red: req.red, black: req.black, bn, same } as const;
}

async function runOp(doc: ProjectDoc, ng: Ngspice, red: PinRef, black: PinRef, bn: string | null, extra: (r: string, b: string) => string[], ac?: number) {
  let nodes = { r: '', b: '' };
  let missing = false;
  const nl = buildNetlist(doc, { op: true, tran: null }, `${doc.name} (прибор)`, {
    powerOff: true, leak: true, refNet: bn ?? undefined, acSingleHz: ac,
    extra: (nodeOfPin) => {
      const r = nodeOfPin(red), b = nodeOfPin(black);
      if (r === null || b === null) { missing = true; return []; }
      nodes = { r, b };
      return extra(r, b);
    },
  });
  const blocking = nl.issues.filter((i) => i.severity === 'error');
  if (blocking.length) return { nl, blocked: blocking.map((i) => i.message).join(' '), out: null, nodes } as const;
  if (missing) return { nl, blocked: 'Вывод под щупом не участвует в расчёте (деталь без модели или не моделируется) — измерить нельзя.', out: null, nodes } as const;
  const out = await runNgspice(ng, nl.text, { expect: ac ? ['op', 'ac'] : ['op'] });
  return { nl, blocked: null, out, nodes } as const;
}

const v = (plot: { values: Record<string, number[]> } | undefined, node: string) => (node === '0' ? 0 : plot?.values[`v(${node})`]?.[0] ?? NaN);

export async function measure(doc: ProjectDoc, ngspicePath: Ngspice | null, req: MeasureRequest): Promise<MeasureResult> {
  const base: MeasureResult = { kind: req.kind, status: 'blocked', display: '—', value: null, beep: false, method: '', esr: null, message: null, netlist: '' };
  const p = prepare(doc, req);
  if ('error' in p) return { ...base, message: p.error ?? null };
  if (!ngspicePath) return { ...base, status: 'failed', message: 'Симулятор ngspice не найден — измерение невозможно.' };
  const off = 'Питание схемы отключено (источники разомкнуты), прибор подаёт свой ток: красный щуп — «+».';
  try {
    if (p.same && req.kind !== 'esr') {
      const zero = req.kind === 'diode' ? { display: '0 В', value: 0 } : { display: '0 Ом', value: 0 };
      return { ...base, status: 'ok', ...zero, beep: req.kind === 'cont', method: 'Щупы на одной цепи — сопротивление между ними 0.' };
    }
    if (req.kind === 'esr') {
      const f = req.freqHz && req.freqHz > 0 ? req.freqHz : 100_000;
      const r = await runOp(doc, ngspicePath, p.red, p.black, p.bn, (a, b) => [`i_esr ${b} ${a} DC 0 AC 1`], f);
      if (r.blocked) return { ...base, message: r.blocked, netlist: r.nl.text };
      const ac = r.out!.plots.ac!;
      const re = (ac.values[`v(${r.nodes.r})`]?.[0] ?? 0) - (r.nodes.b === '0' ? 0 : ac.values[`v(${r.nodes.b})`]?.[0] ?? 0);
      const im = (ac.imag[`v(${r.nodes.r})`]?.[0] ?? 0) - (r.nodes.b === '0' ? 0 : ac.imag[`v(${r.nodes.b})`]?.[0] ?? 0);
      const mag = Math.hypot(re, im);
      const capacitance = im < 0 ? -1 / (2 * Math.PI * f * im) : null;
      return {
        ...base, status: 'ok', display: formatQuantity(re, 'Ом', 3), value: re, netlist: r.nl.text,
        esr: { re, im, mag, freqHz: f, capacitance },
        method: `ESR — активная часть полного сопротивления между щупами на частоте ${formatQuantity(f, 'Гц')} (малый переменный ток, питание схемы отключено). Показание зависит от модели конденсатора и всего, что подключено параллельно.`,
      };
    }
    if (req.kind === 'diode') {
      const r = await runOp(doc, ngspicePath, p.red, p.black, p.bn, (a, b) => [`i_meter ${b} ${a} DC ${spiceNumber(DIODE_CURRENT)}`]);
      if (r.blocked) return { ...base, message: r.blocked, netlist: r.nl.text };
      const u = v(r.out!.plots.op, r.nodes.r) - v(r.out!.plots.op, r.nodes.b);
      const ol = !(u <= DIODE_VMAX);
      return { ...base, status: 'ok', display: ol ? 'OL' : formatQuantity(u, 'В', 4), value: ol ? null : u, netlist: r.nl.text,
        method: `${off} Тестовый ток 1 мА; OL — напряжение больше 3 В (переход закрыт или цепь разорвана).` };
    }
    // Сопротивление и прозвонка
    const ranges = req.kind === 'cont' ? OHM_RANGES.slice(0, 1) : OHM_RANGES;
    let last = '';
    for (const range of ranges) {
      const r = await runOp(doc, ngspicePath, p.red, p.black, p.bn, (a, b) => [`i_meter ${b} ${a} DC ${spiceNumber(range.current)}`]);
      last = r.nl.text;
      if (r.blocked) return { ...base, message: r.blocked, netlist: r.nl.text };
      const u = v(r.out!.plots.op, r.nodes.r) - v(r.out!.plots.op, r.nodes.b);
      if (Number.isFinite(u) && u <= OHM_VMAX) {
        const ohm = u / range.current;
        return {
          ...base, status: 'ok', display: formatQuantity(ohm, 'Ом', 4), value: ohm, beep: req.kind === 'cont' && ohm < CONT_BEEP, netlist: r.nl.text,
          method: `${off} Тестовый ток ${formatQuantity(range.current, 'А')}, диапазон до ${formatQuantity(range.max, 'Ом')}.${req.kind === 'cont' ? ` Сигнал — при сопротивлении меньше ${CONT_BEEP} Ом.` : ''} Диоды и транзисторы в цепи дают показание, зависящее от тока и полярности, как у настоящего прибора.`,
        };
      }
    }
    return { ...base, status: 'ok', display: 'OL', value: null, netlist: last,
      method: `${off} ${req.kind === 'cont' ? 'Цепь разорвана: сопротивление больше 2 кОм.' : 'Сопротивление больше 20 МОм или цепь разорвана.'}` };
  } catch (e) {
    const err = e instanceof AppError ? e.message : (e as Error).message;
    return { ...base, status: 'failed', message: `Измерение не выполнено: ${err}` };
  }
}
