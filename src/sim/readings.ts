/**
 * Показания приборов по результатам расчёта (чистые функции, без Node.js): мультиметр V/A (DC и AC),
 * блок питания (CV/CC), осциллограф (синхронизация, автоизмерения). Все числа берутся из одного
 * результата расчёта; если для режима нужен другой анализ, показание не выдумывается — возвращается
 * объяснение, что сделать.
 */
import { formatQuantity } from '../core/library';
import type { PinRef, ProjectDoc } from '../core/model';
import type { MeterMode, ScopeSettings } from '../core/instruments';
import { netOfPin } from '../core/schematic';
import type { SimResult } from './results';

// ---------- Обработка сигналов ----------

export interface WaveStats {
  /** Окно измерения, с. */
  from: number;
  to: number;
  /** Среднее (постоянная составляющая) — интеграл по времени, точки расчёта неравномерны. */
  mean: number;
  /** Среднеквадратичное значение всего сигнала и только переменной составляющей. */
  rms: number;
  acRms: number;
  min: number;
  max: number;
  vpp: number;
  /** Частота по переходам через среднее с гистерезисом 10 % размаха; null — меньше двух периодов. */
  freq: number | null;
}

/** Статистика сигнала на интервале [from; конец] (по умолчанию — вторая половина расчёта: установившийся режим). */
export function waveStats(t: number[], v: number[], from?: number): WaveStats | null {
  const n = Math.min(t.length, v.length);
  if (n < 2) return null;
  const end = t[n - 1]!;
  const start = from ?? t[0]! + (end - t[0]!) / 2;
  let i0 = 0;
  while (i0 < n - 1 && t[i0 + 1]! <= start) i0++;
  let area = 0, area2 = 0, dur = 0, min = Infinity, max = -Infinity;
  for (let i = i0; i < n; i++) {
    min = Math.min(min, v[i]!); max = Math.max(max, v[i]!);
    if (i === i0) continue;
    const dt = t[i]! - t[i - 1]!;
    if (dt <= 0) continue;
    area += ((v[i]! + v[i - 1]!) / 2) * dt;
    area2 += ((v[i]! ** 2 + v[i - 1]! ** 2 + v[i]! * v[i - 1]!) / 3) * dt; // точный интеграл квадрата линейного участка
    dur += dt;
  }
  if (!(dur > 0)) return null;
  const mean = area / dur;
  const rms = Math.sqrt(Math.max(0, area2 / dur));
  const acRms = Math.sqrt(Math.max(0, area2 / dur - mean * mean));
  const vpp = max - min;
  let freq: number | null = null;
  if (vpp > 0) {
    const lo = mean - 0.1 * vpp; // повторный запуск — только после ухода ниже порога (гистерезис)
    let armed = false;
    const rises: number[] = [];
    for (let i = i0 + 1; i < n; i++) {
      if (v[i]! < lo) armed = true;
      if (armed && v[i - 1]! < mean && v[i]! >= mean) {
        const k = (mean - v[i - 1]!) / (v[i]! - v[i - 1]!);
        rises.push(t[i - 1]! + k * (t[i]! - t[i - 1]!));
        armed = false;
      }
    }
    if (rises.length >= 3) freq = (rises.length - 1) / (rises[rises.length - 1]! - rises[0]!);
  }
  return { from: t[i0]!, to: end, mean, rms, acRms, min, max, vpp, freq };
}

// ---------- Мультиметр: напряжение и ток по результату расчёта ----------

export interface Reading {
  /** Текст индикатора («5,000 В», «OL», «—»). */
  display: string;
  value: number | null;
  unit: string;
  /** Как получено показание (метод, окно, частота). */
  method: string;
  /** Предупреждения: перегрузка, неверное подключение. */
  warnings: string[];
}

const fmt = (v: number, unit: string) => formatQuantity(v, unit, 4);

/** Разность потенциалов двух выводов по результату: массив во времени или одно значение. */
function netValue(doc: ProjectDoc, ref: PinRef | null, src: Record<string, number> | Record<string, number[]> | undefined) {
  if (!ref || !src) return undefined;
  const net = netOfPin(doc, ref);
  return net ? src[net.id] : undefined;
}

export function meterReading(doc: ProjectDoc, result: SimResult | null, mode: MeterMode, red: PinRef | null, black: PinRef | null): Reading {
  const none = (display: string, method: string): Reading => ({ display, value: null, unit: '', method, warnings: [] });
  if (mode === 'ohm' || mode === 'cont' || mode === 'diode') return none('—', 'Нажмите «Измерить»: схема обесточивается, прибор подаёт свой тестовый ток.');
  if (!result || result.status !== 'ok') return none('нет расчёта', 'Запустите тест.');
  const warnings: string[] = [];
  if (mode === 'dcv' || mode === 'acv') {
    if (!red || !black) return none('— подключите оба щупа', '');
    const tr = result.tran;
    if (tr) {
      const a = netValue(doc, red, tr.node) as number[] | undefined, b = netValue(doc, black, tr.node) as number[] | undefined;
      if (!a || !b) return none('вывод не подключён к схеме', 'Потенциал свободного вывода не определён.');
      const st = waveStats(tr.time, a.map((x, i) => x - b[i]!));
      if (!st) return none('—', 'Мало точек переходного процесса.');
      const win = `окно ${fmt(st.from, 'с')} … ${fmt(st.to, 'с')} (вторая половина переходного процесса)`;
      if (mode === 'dcv') return { display: fmt(st.mean, 'В'), value: st.mean, unit: 'В', method: `Среднее значение, ${win}.`, warnings };
      return {
        display: fmt(st.acRms, 'В'), value: st.acRms, unit: 'В', warnings,
        method: `Действующее значение переменной составляющей (True RMS, вход с разделительным конденсатором), ${win}; частота ${st.freq ? fmt(st.freq, 'Гц') : 'не определена (меньше двух периодов в окне)'}.`,
      };
    }
    if (mode === 'acv') return none('нужен переходный процесс', 'Переменное напряжение измеряется по переходному процессу: выберите его в «Расчёте» и запустите тест.');
    const a = netValue(doc, red, result.op?.node) as number | undefined, b = netValue(doc, black, result.op?.node) as number | undefined;
    if (a === undefined || b === undefined || !Number.isFinite(a - b)) return none('вывод не подключён к схеме', 'Потенциал свободного вывода не определён.');
    return { display: fmt(a - b, 'В'), value: a - b, unit: 'В', method: 'Постоянное напряжение в рабочей точке. Прибор идеальный: не нагружает схему.', warnings };
  }
  // Амперметр
  if (!red) return none('— выберите вывод', 'Красным щупом щёлкните вывод детали: амперметр включится последовательно между выводом и его цепью.');
  const label = (() => {
    const inst = doc.schematic.instances.find((i) => i.id === red.instanceId);
    return inst ? `${inst.refDes}, вывод ${red.pin}` : 'вывод';
  })();
  const check = (i: number) => { if (Math.abs(i) > 10) warnings.push('Ток больше 10 А — в реальном мультиметре сгорит предохранитель токового входа.'); };
  const tr = result.tran;
  if (tr && tr.meter) {
    const st = waveStats(tr.time, tr.meter);
    if (!st) return none('—', '');
    const win = `окно ${fmt(st.from, 'с')} … ${fmt(st.to, 'с')}`;
    check(Math.max(Math.abs(st.max), Math.abs(st.min)));
    if (mode === 'dca') return { display: fmt(st.mean, 'А'), value: st.mean, unit: 'А', warnings, method: `Средний ток, втекающий в ${label}; амперметр включён последовательно (сопротивление 0); ${win}.` };
    return { display: fmt(st.acRms, 'А'), value: st.acRms, unit: 'А', warnings, method: `Действующее значение переменной составляющей тока (True RMS) через ${label}; ${win}; частота ${st.freq ? fmt(st.freq, 'Гц') : 'не определена'}.` };
  }
  if (mode === 'aca') return none('нужен переходный процесс', 'Переменный ток измеряется по переходному процессу.');
  const i = result.op?.meter;
  if (i === undefined || !Number.isFinite(i)) return none('амперметр не включён', 'Вывод под красным щупом не участвует в расчёте (свободен или деталь без модели). Запустите тест после выбора вывода.');
  check(i);
  return { display: fmt(i, 'А'), value: i, unit: 'А', warnings, method: `Постоянный ток, втекающий в ${label}, в рабочей точке; амперметр включён последовательно (сопротивление 0).` };
}

// ---------- Лабораторный блок питания ----------

export interface PsuState {
  instanceId: string;
  refDes: string;
  enabled: boolean;
  vset: number;
  ilim: number;
  vout: number | null;
  iout: number | null;
  /** CV — стабилизация напряжения, CC — ограничение тока, OFF — выход выключен. */
  mode: 'CV' | 'CC' | 'OFF' | null;
}

export const isPsu = (doc: ProjectDoc, instanceId: string) => {
  const inst = doc.schematic.instances.find((i) => i.id === instanceId);
  const part = inst && doc.library.parts.find((p) => p.id === inst.partId);
  const model = part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
  return Boolean(model && /\{v:currentLimit\}/.test(model.text));
};

export function psuStates(doc: ProjectDoc, result: SimResult | null): PsuState[] {
  return doc.schematic.instances.filter((i) => isPsu(doc, i.id)).map((inst) => {
    const vset = inst.values.voltage?.value ?? NaN, ilim = inst.values.currentLimit?.value ?? NaN;
    const enabled = (inst.values.enabled?.value ?? 1) >= 0.5;
    const base: PsuState = { instanceId: inst.id, refDes: inst.refDes, enabled, vset, ilim, vout: null, iout: null, mode: null };
    const op = result?.status === 'ok' ? result.op : null;
    if (!op) return base;
    const vp = netValue(doc, { instanceId: inst.id, pin: '+' }, op.node) as number | undefined;
    const vn = netValue(doc, { instanceId: inst.id, pin: '-' }, op.node) as number | undefined;
    const iin = op.pins[inst.id]?.['+'];
    if (vp === undefined || vn === undefined || iin === undefined) return base;
    const iout = -iin;
    const mode: PsuState['mode'] = !enabled ? 'OFF' : iout >= ilim * 0.995 ? 'CC' : 'CV';
    return { ...base, vout: vp - vn, iout, mode };
  });
}

// ---------- Осциллограф ----------

export interface ScopeView {
  /** Время левого края экрана, с; ширина экрана — 10 делений. */
  t0: number;
  triggered: boolean;
  /** Сообщение режима синхронизации («ожидание запуска»). */
  status: string;
  channels: Array<{ key: 'ch1' | 'ch2'; t: number[]; v: number[]; stats: WaveStats | null } | null>;
}

/**
 * Синхронизация: последний запуск по фронту выбранного канала, после которого помещается весь экран
 * (точка запуска — в 1 делении от левого края). Режим «авто» без запуска показывает последние 10 делений;
 * «ждущий» без запуска ничего не показывает.
 */
export function scopeView(doc: ProjectDoc, result: SimResult | null, s: ScopeSettings): ScopeView | null {
  const tr = result?.status === 'ok' ? result.tran : null;
  if (!tr || tr.time.length < 2) return null;
  const sig = (key: 'ch1' | 'ch2') => {
    const ch = s[key];
    if (!ch.on || !ch.pin) return null;
    const v = netValue(doc, ch.pin, tr.node) as number[] | undefined;
    return v ? { key, t: tr.time, v, stats: waveStats(tr.time, v) } : null;
  };
  const channels = [sig('ch1'), sig('ch2')];
  const span = 10 * s.timeDiv;
  const tEnd = tr.time[tr.time.length - 1]!, tStart = tr.time[0]!;
  const src = channels.find((c) => c?.key === s.trigger.source) ?? null;
  let tTrig: number | null = null;
  if (src) {
    const { t, v } = src;
    const L = s.trigger.level;
    for (let i = t.length - 1; i > 0; i--) {
      const crossed = s.trigger.edge === 'rise' ? v[i - 1]! < L && v[i]! >= L : v[i - 1]! > L && v[i]! <= L;
      if (!crossed) continue;
      const tc = t[i - 1]! + ((L - v[i - 1]!) / (v[i]! - v[i - 1]!)) * (t[i]! - t[i - 1]!);
      if (tc + 0.9 * span <= tEnd || tTrig === null) tTrig = tc;
      if (tc + 0.9 * span <= tEnd) break;
    }
  }
  if (tTrig !== null) return { t0: tTrig - 0.1 * span, triggered: true, status: `Запуск: ${s.trigger.source.toUpperCase()}, ${s.trigger.edge === 'rise' ? 'фронт' : 'спад'}, ${formatQuantity(s.trigger.level, 'В', 3)}`, channels };
  if (s.trigger.mode === 'normal') return { t0: tStart, triggered: false, status: 'Ждущий режим: запуска нет — уровень синхронизации вне сигнала', channels: [null, null] };
  return { t0: Math.max(tStart, tEnd - span), triggered: false, status: 'Авто: запуска нет, показан конец записи', channels };
}
