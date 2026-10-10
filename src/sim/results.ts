/**
 * Привязка результатов ngspice к объектам проекта и проверка пределов деталей.
 * Знаки токов: ток резистора/конденсатора — от вывода 1 к выводу 2 через деталь;
 * ток источника — как в ngspice: через источник от «+» к «−» (отрицательный, когда источник отдаёт мощность).
 */
import { formatQuantity, RATINGS } from '../core/library';
import type { ProjectDoc } from '../core/model';
import type { Netlist, SimIssue } from './netlist';
import type { RawPlot } from './raw';

export interface OpResult {
  /** id сети → напряжение относительно земли, В. Сети «земли» — 0. */
  node: Record<string, number>;
  /** id экземпляра R/C/V → ток, А. */
  current: Record<string, number>;
}

export interface TranResult {
  time: number[];
  node: Record<string, number[]>;
  current: Record<string, number[]>;
}

export interface LimitWarning {
  instanceId: string;
  kind: 'power' | 'voltage';
  value: number;
  limit: number;
  message: string;
}

export interface SimResult {
  status: 'ok' | 'blocked' | 'failed';
  /** Ревизия документа, по которой выполнен расчёт: по ней интерфейс понимает, что результат устарел. */
  revision: number;
  issues: SimIssue[];
  error: { code: string; message: string; details: string[] } | null;
  op: OpResult | null;
  tran: TranResult | null;
  limits: LimitWarning[];
  engine: { name: 'ngspice'; version: string | null };
  netlist: string;
  warnings: string[];
  durationMs: number;
}

const nodeVector = (node: string) => `v(${node})`;

/** Ток элемента: источник — i(v1) (или v1#branch); сохранённый ток R/C — i(@r1[i]) (или @r1[i]). */
function currentVector(plot: RawPlot, el: string, saved: string | undefined): number[] | undefined {
  if (el.startsWith('v')) return plot.values[`i(${el})`] ?? plot.values[`${el}#branch`];
  if (!saved) return undefined;
  return plot.values[`i(${saved})`] ?? plot.values[saved];
}

export function mapOp(plot: RawPlot, nl: Netlist): OpResult {
  const node: Record<string, number> = {};
  for (const [netId, n] of nl.nodeOfNet) node[netId] = n === '0' ? 0 : plot.values[nodeVector(n)]?.[0] ?? NaN;
  const current: Record<string, number> = {};
  for (const [instId, el] of nl.elementOf) {
    const v = currentVector(plot, el, nl.currentVectors.get(instId));
    if (v) current[instId] = v[0]!;
  }
  return { node, current };
}

export function mapTran(plot: RawPlot, nl: Netlist): TranResult {
  const time = plot.values.time ?? [];
  const node: Record<string, number[]> = {};
  for (const [netId, n] of nl.nodeOfNet) node[netId] = n === '0' ? time.map(() => 0) : plot.values[nodeVector(n)] ?? [];
  const current: Record<string, number[]> = {};
  for (const [instId, el] of nl.elementOf) {
    const v = currentVector(plot, el, nl.currentVectors.get(instId));
    if (v) current[instId] = v;
  }
  return { time, node, current };
}

/** Напряжение на детали (вывод 1 − вывод 2) по рабочей точке/переходному процессу. */
function pinNets(doc: ProjectDoc, instanceId: string): string[] {
  const out: string[] = [];
  for (const pin of ['1', '2']) {
    const n = doc.schematic.nets.find((x) => x.connections.some((c) => c.instanceId === instanceId && c.pin === pin));
    if (n) out.push(n.id);
  }
  return out;
}

export function checkLimits(doc: ProjectDoc, op: OpResult | null, tran: TranResult | null): LimitWarning[] {
  const out: LimitWarning[] = [];
  for (const inst of doc.schematic.instances) {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    if (!part) continue;
    const nets = pinNets(doc, inst.id);
    if (nets.length !== 2) continue;
    const [a, b] = nets as [string, string];
    const vAt = (src: { node: Record<string, number | number[]> }, i?: number) => {
      const va = src.node[a], vb = src.node[b];
      const x = Array.isArray(va) ? va[i!] : va, y = Array.isArray(vb) ? vb[i!] : vb;
      return (x ?? NaN) - (y ?? NaN);
    };
    let maxV = 0, maxP = 0;
    if (op) {
      const v = vAt(op);
      maxV = Math.max(maxV, Math.abs(v));
      if (op.current[inst.id] !== undefined) maxP = Math.max(maxP, Math.abs(v * op.current[inst.id]!));
    }
    if (tran) {
      const cur = tran.current[inst.id];
      for (let i = 0; i < tran.time.length; i++) {
        const v = vAt(tran, i);
        if (Number.isFinite(v)) maxV = Math.max(maxV, Math.abs(v));
        if (cur && Number.isFinite(v)) maxP = Math.max(maxP, Math.abs(v * cur[i]!));
      }
    }
    const power = part.ratings.power?.value;
    if (part.category === 'resistor' && power !== undefined && maxP > power) {
      out.push({ instanceId: inst.id, kind: 'power', value: maxP, limit: power,
        message: `${inst.refDes}: расчётная мощность ${formatQuantity(maxP, RATINGS.power!.unitRu)} больше допустимой ${formatQuantity(power, RATINGS.power!.unitRu)} — риск перегрева. Оценка без тепловой модели.` });
    }
    const vmax = part.ratings.voltage?.value;
    if (part.category === 'capacitor' && vmax !== undefined && maxV > vmax) {
      out.push({ instanceId: inst.id, kind: 'voltage', value: maxV, limit: vmax,
        message: `${inst.refDes}: напряжение ${formatQuantity(maxV, 'В')} больше допустимого ${formatQuantity(vmax, 'В')} — риск пробоя.` });
    }
  }
  return out;
}

/** Значение в момент t линейной интерполяцией (для курсора и эталонных проверок). */
export function valueAt(time: number[], values: number[], t: number): number {
  if (time.length === 0) return NaN;
  if (t <= time[0]!) return values[0]!;
  for (let i = 1; i < time.length; i++) {
    if (time[i]! >= t) {
      const t0 = time[i - 1]!, t1 = time[i]!;
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return values[i - 1]! + k * (values[i]! - values[i - 1]!);
    }
  }
  return values[values.length - 1]!;
}
