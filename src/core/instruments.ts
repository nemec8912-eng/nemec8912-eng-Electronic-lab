/**
 * Настройки виртуальных приборов в документе (instruments.settings): мультиметр, осциллограф, ESR-метр.
 * Каждый щуп привязан к выводу детали (instanceId + номер вывода), а сеть определяется по графу
 * связности в момент измерения — поэтому показания не зависят от координат на экране.
 * Настройки читаются защитно: неизвестные или повреждённые значения заменяются значениями по умолчанию.
 */
import { touch } from './factory';
import type { PinRef, ProjectDoc, SimulationSettings } from './model';
import { samePin } from './schematic';

export type ProbeColor = 'red' | 'black';

/** Режимы мультиметра: DC V, AC V, DC A, AC A, сопротивление, прозвонка, проверка диодов. */
export type MeterMode = 'dcv' | 'acv' | 'dca' | 'aca' | 'ohm' | 'cont' | 'diode';
export const METER_MODES: Array<[MeterMode, string]> = [
  ['dcv', 'V⎓'], ['acv', 'V~'], ['dca', 'A⎓'], ['aca', 'A~'], ['ohm', 'Ω'], ['cont', 'Прозвонка'], ['diode', 'Диод'],
];

export interface MultimeterSettings {
  red: PinRef | null;
  black: PinRef | null;
  mode: MeterMode;
}

export interface ScopeChannel { pin: PinRef | null; vdiv: number; offset: number; on: boolean }
export interface ScopeSettings {
  ch1: ScopeChannel;
  ch2: ScopeChannel;
  /** Развёртка, секунд на деление (10 делений по горизонтали). */
  timeDiv: number;
  trigger: { source: 'ch1' | 'ch2'; level: number; edge: 'rise' | 'fall'; mode: 'auto' | 'normal' };
  /** Положение вертикальных курсоров в делениях от левого края (0…10); null — курсоры выключены. */
  cursors: [number, number] | null;
}

export interface EsrSettings { red: PinRef | null; black: PinRef | null; freqHz: number }

/** Цель щупа: какой прибор и какой его вход подключается при щелчке по выводу. */
export type ProbeTarget = 'mm.red' | 'mm.black' | 'scope.ch1' | 'scope.ch2' | 'esr.red' | 'esr.black';

const pinOk = (p: unknown): PinRef | null => {
  const r = p as PinRef | null | undefined;
  return r && typeof r.instanceId === 'string' && typeof r.pin === 'string' ? { instanceId: r.instanceId, pin: r.pin } : null;
};
const num = (v: unknown, def: number, ok: (x: number) => boolean = (x) => x > 0) => (typeof v === 'number' && Number.isFinite(v) && ok(v) ? v : def);

export function multimeter(doc: ProjectDoc): MultimeterSettings {
  const mm = doc.instruments.settings.multimeter as Record<string, unknown> | undefined;
  const mode = METER_MODES.some(([m]) => m === mm?.mode) ? (mm!.mode as MeterMode) : 'dcv';
  return { red: pinOk(mm?.red), black: pinOk(mm?.black), mode };
}

export const DEFAULT_SCOPE: ScopeSettings = {
  ch1: { pin: null, vdiv: 1, offset: 0, on: true },
  ch2: { pin: null, vdiv: 1, offset: 0, on: true },
  timeDiv: 1e-3,
  trigger: { source: 'ch1', level: 0, edge: 'rise', mode: 'auto' },
  cursors: null,
};

export function scope(doc: ProjectDoc): ScopeSettings {
  const s = doc.instruments.settings.scope as Record<string, any> | undefined;
  const ch = (c: any, d: ScopeChannel): ScopeChannel => ({
    pin: pinOk(c?.pin), vdiv: num(c?.vdiv, d.vdiv), offset: num(c?.offset, d.offset, () => true), on: typeof c?.on === 'boolean' ? c.on : d.on,
  });
  const t = s?.trigger ?? {};
  const cur = Array.isArray(s?.cursors) && s.cursors.length === 2 && s.cursors.every((x: unknown) => typeof x === 'number' && x >= 0 && x <= 10) ? [s.cursors[0], s.cursors[1]] as [number, number] : null;
  return {
    ch1: ch(s?.ch1, DEFAULT_SCOPE.ch1),
    ch2: ch(s?.ch2, DEFAULT_SCOPE.ch2),
    timeDiv: num(s?.timeDiv, DEFAULT_SCOPE.timeDiv),
    trigger: {
      source: t.source === 'ch2' ? 'ch2' : 'ch1',
      level: num(t.level, 0, () => true),
      edge: t.edge === 'fall' ? 'fall' : 'rise',
      mode: t.mode === 'normal' ? 'normal' : 'auto',
    },
    cursors: cur,
  };
}

export function esrMeter(doc: ProjectDoc): EsrSettings {
  const e = doc.instruments.settings.esr as Record<string, unknown> | undefined;
  return { red: pinOk(e?.red), black: pinOk(e?.black), freqHz: num(e?.freqHz, 100_000) };
}

function withSettings(doc: ProjectDoc, key: string, value: unknown): ProjectDoc {
  if (JSON.stringify(doc.instruments.settings[key]) === JSON.stringify(value)) return doc;
  return touch({ ...doc, instruments: { ...doc.instruments, settings: { ...doc.instruments.settings, [key]: value } } });
}

export function setProbe(doc: ProjectDoc, color: ProbeColor, pin: PinRef | null): ProjectDoc {
  const cur = multimeter(doc);
  const prev = cur[color];
  if ((prev === null && pin === null) || (prev && pin && samePin(prev, pin))) return doc;
  return withSettings(doc, 'multimeter', { ...cur, [color]: pin });
}

/** Подключить вход прибора к выводу (или снять, pin = null). */
export function setProbeTarget(doc: ProjectDoc, target: ProbeTarget, pin: PinRef | null): ProjectDoc {
  if (target === 'mm.red' || target === 'mm.black') return setProbe(doc, target === 'mm.red' ? 'red' : 'black', pin);
  if (target === 'scope.ch1' || target === 'scope.ch2') {
    const s = scope(doc);
    const k = target === 'scope.ch1' ? 'ch1' : 'ch2';
    return withSettings(doc, 'scope', { ...s, [k]: { ...s[k], pin } });
  }
  const e = esrMeter(doc);
  return withSettings(doc, 'esr', { ...e, [target === 'esr.red' ? 'red' : 'black']: pin });
}

export function setMeterMode(doc: ProjectDoc, mode: MeterMode): ProjectDoc {
  return withSettings(doc, 'multimeter', { ...multimeter(doc), mode });
}
export function setScope(doc: ProjectDoc, patch: Partial<ScopeSettings>): ProjectDoc {
  return withSettings(doc, 'scope', { ...scope(doc), ...patch });
}
export function setEsr(doc: ProjectDoc, patch: Partial<EsrSettings>): ProjectDoc {
  return withSettings(doc, 'esr', { ...esrMeter(doc), ...patch });
}

/** Амперметр мультиметра: в режимах A он включён последовательно с выводом под красным щупом. */
export function ammeterPin(doc: ProjectDoc): PinRef | null {
  const m = multimeter(doc);
  return m.mode === 'dca' || m.mode === 'aca' ? m.red : null;
}

/** Снять все щупы приборов с выводов удаляемой детали. */
export function dropInstrumentPins(settings: Record<string, unknown>, instanceId: string): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.instanceId === 'string' && typeof o.pin === 'string') return o.instanceId === instanceId ? null : o;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(settings) as Record<string, unknown>;
}

export function setTranSettings(doc: ProjectDoc, patch: Partial<SimulationSettings['tran']>): ProjectDoc {
  const tran = { ...doc.simulation.tran, ...patch };
  const cur = doc.simulation.tran;
  if (tran.stopS === cur.stopS && tran.stepS === cur.stepS && tran.startFromZero === cur.startFromZero) return doc;
  return touch({ ...doc, simulation: { ...doc.simulation, tran } });
}

/** Изменение настроек расчёта (выбор анализа, развёртка DC, частотный анализ, параметрический прогон). */
export function setSimSettings(doc: ProjectDoc, patch: Partial<Omit<SimulationSettings, 'tran'>>): ProjectDoc {
  const next: SimulationSettings = {
    ...doc.simulation,
    ...patch,
    dc: { ...doc.simulation.dc, ...(patch.dc ?? {}) },
    ac: { ...doc.simulation.ac, ...(patch.ac ?? {}) },
    sweep: { ...doc.simulation.sweep, ...(patch.sweep ?? {}) },
  };
  if (JSON.stringify(next) === JSON.stringify(doc.simulation)) return doc;
  return touch({ ...doc, simulation: next });
}
