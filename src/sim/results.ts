/**
 * Привязка результатов ngspice к объектам проекта и проверка пределов деталей.
 * Знаки токов: ток резистора/конденсатора/катушки — от вывода 1 к выводу 2 через деталь;
 * ток источника — как в ngspice: через источник от «+» к «−» (отрицательный, когда источник отдаёт мощность);
 * ток вывода прибора (pins) — втекающий в вывод. Мощность детали — Σ U·I по выводам (поглощаемая).
 */
import { formatQuantity, RATINGS } from '../core/library';
import type { ComponentInstance, ProjectDoc } from '../core/model';
import { symbolOf } from '../core/schematic';
import type { Netlist, SimIssue } from './netlist';
import type { RawPlot } from './raw';

export interface OpResult {
  /** id сети → напряжение относительно земли, В. Сети «земли» — 0. */
  node: Record<string, number>;
  /** id экземпляра R/C/L/V → ток, А. */
  current: Record<string, number>;
  /** id экземпляра прибора → ток, втекающий в вывод (номер вывода → А). */
  pins: Record<string, Record<string, number>>;
  /** Ток через амперметр мультиметра (втекающий в вывод под красным щупом), если он включён. */
  meter?: number;
}

export interface TranResult {
  time: number[];
  node: Record<string, number[]>;
  current: Record<string, number[]>;
  pins: Record<string, Record<string, number[]>>;
  meter?: number[];
}

export interface DcResult {
  /** Экземпляр-источник, значение которого менялось; x — его значения (В или А). */
  sourceId: string;
  x: number[];
  node: Record<string, number[]>;
  current: Record<string, number[]>;
  pins: Record<string, Record<string, number[]>>;
}

export interface AcResult {
  freq: number[];
  /** Комплексные напряжения узлов (относительно земли): действительная и мнимая части. */
  re: Record<string, number[]>;
  im: Record<string, number[]>;
}

export type LimitKind = 'power' | 'voltage' | 'reverse-voltage' | 'polarity' | 'current' | 'vce' | 'vds' | 'supply-high' | 'supply-low';

export interface LimitWarning {
  instanceId: string;
  kind: LimitKind;
  value: number;
  limit: number;
  message: string;
}

export interface SweepRun {
  value: number;
  status: 'ok' | 'blocked' | 'failed';
  error: { code: string; message: string; details: string[] } | null;
  op: OpResult | null;
  tran: TranResult | null;
  dc: DcResult | null;
  ac: AcResult | null;
}

export type AnalysisKind = 'op' | 'tran' | 'dc' | 'ac';

export interface SimResult {
  status: 'ok' | 'blocked' | 'failed';
  analysis: AnalysisKind;
  /** Ревизия документа, по которой выполнен расчёт: по ней интерфейс понимает, что результат устарел. */
  revision: number;
  issues: SimIssue[];
  error: { code: string; message: string; details: string[] } | null;
  op: OpResult | null;
  tran: TranResult | null;
  dc: DcResult | null;
  ac: AcResult | null;
  /** Параметрический прогон: тот же анализ для нескольких значений параметра детали. */
  sweep: { instanceId: string; param: string; runs: SweepRun[] } | null;
  limits: LimitWarning[];
  engine: { name: 'ngspice'; version: string | null };
  netlist: string;
  warnings: string[];
  durationMs: number;
}

/** Вектор по имени из netlist: «i(v1)» — ток источника (в старых ngspice — «v1#branch»), «@r1[i]» — сохранённый ток. */
function vector(plot: RawPlot, name: string): number[] | undefined {
  const v = plot.values;
  if (name.startsWith('i(')) return v[name] ?? v[`${name.slice(2, -1)}#branch`];
  if (name.startsWith('@')) return v[`i(${name})`] ?? v[name];
  return v[name];
}

function mapSeries(plot: RawPlot, nl: Netlist, len: number) {
  const node: Record<string, number[]> = {};
  for (const [netId, n] of nl.nodeOfNet) node[netId] = n === '0' ? new Array(len).fill(0) : plot.values[`v(${n})`] ?? [];
  const current: Record<string, number[]> = {};
  for (const [instId, name] of nl.currentVectors) {
    const v = vector(plot, name);
    if (v) current[instId] = v;
  }
  const pins: Record<string, Record<string, number[]>> = {};
  for (const [instId, map] of nl.pinCurrentVectors) {
    const out: Record<string, number[]> = {};
    for (const [pin, name] of map) { const v = vector(plot, name); if (v) out[pin] = v; }
    pins[instId] = out;
  }
  const meter = nl.ammeterVector ? vector(plot, nl.ammeterVector) : undefined;
  return { node, current, pins, ...(meter ? { meter } : {}) };
}

export function mapOp(plot: RawPlot, nl: Netlist): OpResult {
  const s = mapSeries(plot, nl, 1);
  const first = (r: Record<string, number[]>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v[0] ?? NaN]));
  return {
    node: first(s.node),
    current: first(s.current),
    pins: Object.fromEntries(Object.entries(s.pins).map(([k, v]) => [k, first(v)])),
    ...(s.meter ? { meter: s.meter[0] ?? NaN } : {}),
  };
}

export function mapTran(plot: RawPlot, nl: Netlist): TranResult {
  const time = plot.values.time ?? [];
  return { time, ...mapSeries(plot, nl, time.length) };
}

export function mapDc(plot: RawPlot, nl: Netlist, sourceId: string): DcResult {
  const sweepVar = plot.variables[0]?.name ?? '';
  const x = plot.values[sweepVar] ?? [];
  return { sourceId, x, ...mapSeries(plot, nl, x.length) };
}

export function mapAc(plot: RawPlot, nl: Netlist): AcResult {
  const freq = plot.values.frequency ?? [];
  const re: Record<string, number[]> = {};
  const im: Record<string, number[]> = {};
  for (const [netId, n] of nl.nodeOfNet) {
    if (n === '0') { re[netId] = freq.map(() => 0); im[netId] = freq.map(() => 0); continue; }
    re[netId] = plot.values[`v(${n})`] ?? [];
    im[netId] = plot.imag[`v(${n})`] ?? [];
  }
  return { freq, re, im };
}

// ---------- Пределы деталей ----------

interface Samples {
  len: number;
  /** Время выборок (только переходный процесс). */
  time?: number[];
  node: Record<string, number[] | number>;
  current: Record<string, number[] | number>;
  pins: Record<string, Record<string, number[] | number>>;
  /** Подпись момента: «t = 1,2 мс», «при V1 = 3 В». */
  where(i: number): string;
}

const at = (x: number[] | number | undefined, i: number) => (x === undefined ? NaN : Array.isArray(x) ? x[i] ?? NaN : x);

function samplesOf(op: OpResult | null, tran: TranResult | null, dc: DcResult | null, doc: ProjectDoc): Samples[] {
  const out: Samples[] = [];
  if (op) out.push({ len: 1, node: op.node, current: op.current, pins: op.pins, where: () => 'в рабочей точке' });
  if (tran) out.push({ len: tran.time.length, time: tran.time, node: tran.node, current: tran.current, pins: tran.pins, where: (i) => `при t = ${formatQuantity(tran.time[i]!, 'с')}` });
  if (dc) {
    const src = doc.schematic.instances.find((x) => x.id === dc.sourceId)?.refDes ?? 'источнике';
    out.push({ len: dc.x.length, node: dc.node, current: dc.current, pins: dc.pins, where: (i) => `при ${src} = ${formatQuantity(dc.x[i]!, '')}`.trim() });
  }
  return out;
}

/** Электрические величины детали в точке выборки: напряжения и втекающие токи выводов. */
function deviceProbe(doc: ProjectDoc, inst: ComponentInstance) {
  const pins = symbolOf(doc, inst)?.pins ?? [];
  const netOf = new Map<string, string>();
  for (const n of doc.schematic.nets) for (const c of n.connections) if (c.instanceId === inst.id) netOf.set(c.pin, n.id);
  const byName = (name: string) => pins.find((p) => p.name.toUpperCase() === name)?.number;
  const v = (s: Samples, pin: string | undefined, i: number) => (pin && netOf.has(pin) ? at(s.node[netOf.get(pin)!], i) : NaN);
  /** Ток, втекающий в вывод. Для двухвыводных — из тока элемента (от вывода 1 к выводу 2). */
  const iin = (s: Samples, pin: string | undefined, i: number): number => {
    if (!pin) return NaN;
    const pc = s.pins[inst.id];
    if (pc && pc[pin] !== undefined) return at(pc[pin], i);
    const c = s.current[inst.id];
    if (c === undefined || pins.length !== 2) return NaN;
    return pin === pins[0]!.number ? at(c, i) : -at(c, i);
  };
  const power = (s: Samples, i: number) => {
    let p = 0;
    for (const pin of pins) {
      const vi = v(s, pin.number, i), ii = iin(s, pin.number, i);
      if (!Number.isFinite(vi) || !Number.isFinite(ii)) return NaN;
      p += vi * ii;
    }
    return p;
  };
  return { pins, byName, v, iin, power };
}

/**
 * Проверка пределов по результатам расчёта: мощность резисторов и приборов, напряжение и полярность
 * конденсаторов, обратное напряжение и ток диодов и светодиодов, Uкэ/Uси и ток транзисторов,
 * напряжение питания микросхем, ток нагрузки стабилизаторов. Оценка без тепловой модели.
 */
export function checkLimits(doc: ProjectDoc, op: OpResult | null, tran: TranResult | null, dc: DcResult | null = null, suffix = ''): LimitWarning[] {
  const out: LimitWarning[] = [];
  const sets = samplesOf(op, tran, dc, doc);
  if (!sets.length) return out;
  for (const inst of doc.schematic.instances) {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    if (!part) continue;
    const d = deviceProbe(doc, inst);
    if (d.pins.length === 0) continue;
    const R = part.ratings;
    const cat = part.category;
    /** Наибольшее значение f по всем выборкам и где оно достигнуто. */
    const peak = (f: (s: Samples, i: number) => number) => {
      let best = -Infinity, where = '';
      for (const s of sets) for (let i = 0; i < s.len; i++) {
        const x = f(s, i);
        if (Number.isFinite(x) && x > best) { best = x; where = s.where(i); }
      }
      return { value: best, where };
    };
    const add = (kind: LimitKind, limit: number | undefined, f: (s: Samples, i: number) => number, text: (v: number, lim: number, where: string) => string) => {
      if (limit === undefined) return;
      const p = peak(f);
      if (p.value > limit) out.push({ instanceId: inst.id, kind, value: p.value, limit, message: `${inst.refDes}: ${text(p.value, limit, p.where)}${suffix}` });
    };
    const W = (x: number) => formatQuantity(x, RATINGS.power!.unitRu);
    const V = (x: number) => formatQuantity(x, 'В');
    const A = (x: number) => formatQuantity(x, 'А');
    const [p1, p2] = d.pins.map((p) => p.number);
    const vAcross = (s: Samples, i: number) => d.v(s, p1, i) - d.v(s, p2, i);

    if (cat === 'resistor') {
      add('power', R.power?.value, (s, i) => Math.abs(d.power(s, i)), (v, l, w) => `расчётная мощность ${W(v)} больше допустимой ${W(l)} (${w}) — риск перегрева. Оценка без тепловой модели.`);
    } else if (cat === 'capacitor' || cat === 'capacitor-polar') {
      add('voltage', R.voltage?.value, (s, i) => Math.abs(vAcross(s, i)), (v, l, w) => `напряжение ${V(v)} больше допустимого ${V(l)} (${w}) — риск пробоя.`);
      if (cat === 'capacitor-polar' || part.polarized) {
        add('polarity', 1, (s, i) => -vAcross(s, i), (v, _l, w) => `обратное напряжение ${V(v)} на полярном конденсаторе (${w}) — электролитический конденсатор может выйти из строя. Проверьте полярность.`);
      }
    } else if (cat === 'inductor') {
      add('current', R.current?.value, (s, i) => Math.abs(d.iin(s, p1, i)), (v, l, w) => `ток ${A(v)} больше допустимого ${A(l)} (${w}) — перегрев или насыщение сердечника.`);
    } else if (cat === 'diode' || cat === 'zener' || cat === 'led') {
      const a = d.byName('A'), kk = d.byName('K');
      if (a && kk) {
        if (cat !== 'zener') add('reverse-voltage', R.reverseVoltage?.value, (s, i) => d.v(s, kk, i) - d.v(s, a, i), (v, l, w) => `обратное напряжение ${V(v)} больше допустимого ${V(l)} (${w}) — риск пробоя.`);
        if (cat === 'diode' && R.surgeCurrent && R.current) {
          // Выпрямительный диод: «допустимый ток» — средний прямой (IF(AV)). Пики при заряде конденсатора
          // фильтра в разы больше и нормальны; их сравниваем с ударным током (IFSM, полупериод 50/60 Гц).
          const lim = R.current.value, surge = R.surgeCurrent.value;
          for (const set of sets) {
            if (!set.time) {
              for (let i = 0; i < set.len; i++) {
                const x = d.iin(set, a, i);
                if (Number.isFinite(x) && x > lim) { out.push({ instanceId: inst.id, kind: 'current', value: x, limit: lim, message: `${inst.refDes}: прямой ток ${A(x)} больше допустимого ${A(lim)} (${set.where(i)}).${suffix}` }); break; }
              }
              continue;
            }
            const t = set.time, n = set.len;
            if (n < 2) continue;
            const t0 = t[n - 1]! / 2;
            let area = 0, span = 0, pk = -Infinity, pkAt = 0;
            for (let i = 1; i < n; i++) {
              const x0 = Math.max(0, d.iin(set, a, i - 1)), x1 = Math.max(0, d.iin(set, a, i));
              if (Number.isFinite(x1) && x1 > pk) { pk = x1; pkAt = i; }
              if (t[i]! <= t0 || !Number.isFinite(x0) || !Number.isFinite(x1)) continue;
              const dt = t[i]! - Math.max(t[i - 1]!, t0);
              area += ((x0 + x1) / 2) * dt; span += dt;
            }
            const avg = span > 0 ? area / span : NaN;
            if (Number.isFinite(avg) && avg > lim) out.push({ instanceId: inst.id, kind: 'current', value: avg, limit: lim, message: `${inst.refDes}: средний прямой ток ${A(avg)} больше допустимого ${A(lim)} (вторая половина расчёта) — диод перегреется.${suffix}` });
            if (pk > surge) out.push({ instanceId: inst.id, kind: 'current', value: pk, limit: surge, message: `${inst.refDes}: импульсный ток ${A(pk)} больше ударного ${A(surge)} (${set.where(pkAt)}) — нужен резистор или термистор для ограничения пускового тока.${suffix}` });
          }
        } else {
          add('current', R.current?.value, (s, i) => d.iin(s, a, i), (v, l, w) => cat === 'led'
            ? `ток светодиода ${A(v)} больше допустимого ${A(l)} (${w}) — светодиод перегреется. Нужен токоограничивающий резистор побольше.`
            : `прямой ток ${A(v)} больше допустимого ${A(l)} (${w}).`);
        }
      }
      add('power', R.power?.value, (s, i) => d.power(s, i), (v, l, w) => `рассеиваемая мощность ${W(v)} больше допустимой ${W(l)} (${w}) — риск перегрева. Оценка без тепловой модели.`);
    } else if (cat === 'bjt') {
      const c = d.byName('C'), e = d.byName('E');
      add('vce', R.vce?.value, (s, i) => Math.abs(d.v(s, c, i) - d.v(s, e, i)), (v, l, w) => `напряжение коллектор–эмиттер ${V(v)} больше допустимого ${V(l)} (${w}) — риск пробоя.`);
      add('current', R.current?.value, (s, i) => Math.abs(d.iin(s, c, i)), (v, l, w) => `ток коллектора ${A(v)} больше допустимого ${A(l)} (${w}).`);
      add('power', R.power?.value, (s, i) => d.power(s, i), (v, l, w) => `рассеиваемая мощность ${W(v)} больше допустимой ${W(l)} (${w}) — риск перегрева. Оценка без тепловой модели.`);
    } else if (cat === 'mosfet') {
      const dd = d.byName('D'), ss = d.byName('S');
      add('vds', R.vds?.value, (s, i) => Math.abs(d.v(s, dd, i) - d.v(s, ss, i)), (v, l, w) => `напряжение сток–исток ${V(v)} больше допустимого ${V(l)} (${w}) — риск пробоя.`);
      add('current', R.current?.value, (s, i) => Math.abs(d.iin(s, dd, i)), (v, l, w) => `ток стока ${A(v)} больше допустимого ${A(l)} (${w}).`);
      add('power', R.power?.value, (s, i) => d.power(s, i), (v, l, w) => `рассеиваемая мощность ${W(v)} больше допустимой ${W(l)} (${w}) — без радиатора и тепловой модели оценка условная.`);
    } else if (cat.startsWith('ic') || cat === 'mcu') {
      const sym = d.pins;
      const supply = sym.filter((p) => p.electricalType === 'power-in').map((p) => p.number);
      const ground = sym.filter((p) => p.electricalType === 'ground').map((p) => p.number);
      const vsup = (s: Samples, i: number) => {
        if (!supply.length) return NaN;
        const hi = Math.max(...supply.map((p) => d.v(s, p, i)));
        const lo = ground.length ? Math.min(...ground.map((p) => d.v(s, p, i))) : 0;
        return hi - lo;
      };
      add('supply-high', R.supplyMax?.value, vsup, (v, l, w) => `напряжение питания ${V(v)} больше максимального ${V(l)} (${w}) — микросхема может выйти из строя.`);
      if (op && R.supplyMin) {
        const s0 = sets[0]!;
        const v = vsup(s0, 0);
        if (Number.isFinite(v) && v > 0.1 && v < R.supplyMin.value) {
          out.push({ instanceId: inst.id, kind: 'supply-low', value: v, limit: R.supplyMin.value,
            message: `${inst.refDes}: напряжение питания ${V(v)} ниже минимального ${V(R.supplyMin.value)} — реальная микросхема может работать неправильно; поведенческая модель этого не учитывает.${suffix}` });
        }
      }
      const outs = sym.filter((p) => p.electricalType === 'output' || p.electricalType === 'power-out').map((p) => p.number);
      add('current', R.current?.value, (s, i) => Math.max(...outs.map((p) => Math.abs(d.iin(s, p, i)))), (v, l, w) => `ток выхода ${A(v)} больше допустимого ${A(l)} (${w}) — в реальной микросхеме сработает ограничение или защита; модель его не воспроизводит.`);
    } else if (cat === 'fuse') {
      add('current', R.current?.value, (s, i) => Math.abs(d.iin(s, p1, i)), (v, l, w) => `ток ${A(v)} больше номинала вставки ${A(l)} (${w}) — предохранитель перегорит (в расчёте он остаётся целым).`);
    } else if (cat === 'relay') {
      const a1 = d.byName('A1'), a2 = d.byName('A2'), com = d.byName('COM');
      if (a1 && a2) add('voltage', R.voltage?.value, (s, i) => Math.abs(d.v(s, a1, i) - d.v(s, a2, i)), (v, l, w) => `напряжение на катушке ${V(v)} больше допустимого ${V(l)} (${w}) — катушка перегреется.`);
      if (com) add('current', R.current?.value, (s, i) => Math.abs(d.iin(s, com, i)), (v, l, w) => `ток контактов ${A(v)} больше допустимого ${A(l)} (${w}) — контакты обгорят.`);
    } else if (cat === 'thyristor' || cat === 'triac') {
      add('current', R.current?.value, (s, i) => Math.abs(d.iin(s, p1, i)), (v, l, w) => `ток ${A(v)} больше допустимого ${A(l)} (${w}) — нужен радиатор или более мощный прибор.`);
    } else if (cat === 'optocoupler') {
      add('current', R.current?.value, (s, i) => Math.abs(d.iin(s, p1, i)), (v, l, w) => `ток светодиода оптопары ${A(v)} больше допустимого ${A(l)} (${w}).`);
    } else {
      add('power', R.power?.value, (s, i) => Math.abs(d.power(s, i)), (v, l, w) => `мощность ${W(v)} больше допустимой ${W(l)} (${w}). Оценка без тепловой модели.`);
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

/** Модуль (раз) и фаза (градусы) комплексного отношения a/b по точкам частотного анализа. */
export function transfer(ac: AcResult, outNet: string, refNet: string | null, inNet: string | null): { mag: number[]; phaseDeg: number[] } {
  const n = ac.freq.length;
  const mag: number[] = [], phaseDeg: number[] = [];
  const sub = (net: string | null, k: number): [number, number] => (net ? [ac.re[net]?.[k] ?? NaN, ac.im[net]?.[k] ?? NaN] : [0, 0]);
  for (let k = 0; k < n; k++) {
    const [or, oi] = sub(outNet, k), [rr, ri] = sub(refNet, k);
    let re = or - rr, im = oi - ri;
    if (inNet) {
      const [ir, ii] = sub(inNet, k);
      const den = ir * ir + ii * ii;
      [re, im] = [(re * ir + im * ii) / den, (im * ir - re * ii) / den];
    }
    mag.push(Math.hypot(re, im));
    phaseDeg.push((Math.atan2(im, re) * 180) / Math.PI);
  }
  return { mag, phaseDeg };
}
