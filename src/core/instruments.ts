/**
 * Настройки виртуальных приборов в документе (instruments.settings). Этап 1b: мультиметр, режим DC V —
 * красный и чёрный щупы на выводах деталей. Щуп привязан к выводу (instanceId + номер вывода), а сеть
 * определяется по графу связности в момент измерения — поэтому показания не зависят от координат.
 */
import { touch } from './factory';
import type { PinRef, ProjectDoc, SimulationSettings } from './model';
import { samePin } from './schematic';

export type ProbeColor = 'red' | 'black';

export interface MultimeterSettings {
  red: PinRef | null;
  black: PinRef | null;
}

export function multimeter(doc: ProjectDoc): MultimeterSettings {
  const mm = doc.instruments.settings.multimeter as Partial<MultimeterSettings> | undefined;
  const ok = (p: unknown): PinRef | null => {
    const r = p as PinRef | null | undefined;
    return r && typeof r.instanceId === 'string' && typeof r.pin === 'string' ? r : null;
  };
  return { red: ok(mm?.red), black: ok(mm?.black) };
}

export function setProbe(doc: ProjectDoc, color: ProbeColor, pin: PinRef | null): ProjectDoc {
  const cur = multimeter(doc);
  const prev = cur[color];
  if ((prev === null && pin === null) || (prev && pin && samePin(prev, pin))) return doc;
  const next = { ...cur, [color]: pin };
  return touch({ ...doc, instruments: { ...doc.instruments, settings: { ...doc.instruments.settings, multimeter: next } } });
}

export function setTranSettings(doc: ProjectDoc, patch: Partial<SimulationSettings['tran']>): ProjectDoc {
  const tran = { ...doc.simulation.tran, ...patch };
  const cur = doc.simulation.tran;
  if (tran.stopS === cur.stopS && tran.stepS === cur.stepS && tran.startFromZero === cur.startFromZero) return doc;
  return touch({ ...doc, simulation: { ...doc.simulation, tran } });
}
