/**
 * Расчётные значения для журнала испытаний (этап 7): рабочая точка ngspice для ревизии испытания и
 * разброс из-за допусков деталей.
 *
 * Разброс — наихудший случай в линейном приближении: каждое сопротивление с допуском по очереди
 * ставится на +допуск и −допуск, отклонения складываются по модулю. В рабочей точке ёмкости и
 * индуктивности на результат не влияют, поэтому их допуски не перебираются. Допуски источников и
 * разброс параметров полупроводников не учитываются — это сказано в описании метода.
 * Если в записи указано измеренное питание и источник питания на схеме один — расчёт ведётся при нём.
 */
import type { Ngspice } from './engine';
import { formatQuantity } from '../core/library';
import type { Measurement, ProjectDoc, TestRecord } from '../core/model';
import { netOfPin, setValue, symbolOf } from '../core/schematic';
import { nominalResistance, schematicSupply } from '../core/testlog';
import type { OpResult } from './results';
import { simulate } from './simulate';

export const MAX_TOLERANCED = 20;

export interface ExpectedValue {
  measurementId: string;
  value: number | null;
  band: number;
  method: string;
  /** Почему не рассчитано. */
  reason: string | null;
}

export interface ExpectedOutcome {
  status: 'ok' | 'failed';
  values: ExpectedValue[];
  message: string | null;
  runs: number;
}

function valueOf(doc: ProjectDoc, op: OpResult, m: Measurement): number | null {
  const t = m.target;
  if (m.quantity === 'V') {
    if (t.kind === 'net') return op.node[t.netId] ?? null;
    if (t.kind === 'part') {
      const inst = doc.schematic.instances.find((i) => i.id === t.instanceId);
      const pins = inst ? symbolOf(doc, inst)?.pins ?? [] : [];
      if (pins.length < 2) return null;
      const na = netOfPin(doc, { instanceId: t.instanceId, pin: pins[0]!.number }), nb = netOfPin(doc, { instanceId: t.instanceId, pin: pins[1]!.number });
      const va = na ? op.node[na.id] : undefined, vb = nb ? op.node[nb.id] : undefined;
      return va !== undefined && vb !== undefined ? va - vb : null;
    }
  }
  if (m.quantity === 'A' && t.kind === 'part') {
    if (t.pin) return op.pins[t.instanceId]?.[t.pin] ?? null;
    return op.current[t.instanceId] ?? null;
  }
  return null;
}

const describe = (m: Measurement) => (m.quantity === 'V' ? (m.target.kind === 'net' ? 'напряжение узла относительно земли' : 'напряжение между выводами 1 и 2') : m.target.kind === 'part' && m.target.pin ? 'ток, втекающий в вывод' : 'ток через деталь (от вывода 1 к 2)');

export async function expectedValues(revisionDoc: ProjectDoc, ngspicePath: Ngspice | null, rec: TestRecord): Promise<ExpectedOutcome> {
  const values: ExpectedValue[] = [];
  const needSim = rec.measurements.filter((m) => m.quantity === 'V' || m.quantity === 'A');
  // Сопротивление детали — номинал и допуск, без расчёта схемы.
  for (const m of rec.measurements) {
    if (m.quantity !== 'Ω') continue;
    const n = m.target.kind === 'part' ? nominalResistance(revisionDoc, m.target.instanceId) : null;
    values.push(n ? { measurementId: m.id, value: n.value, band: n.band, method: n.method, reason: null } : { measurementId: m.id, value: null, band: 0, method: '', reason: 'у детали нет сопротивления' });
  }
  if (needSim.length === 0) return { status: 'ok', values, message: null, runs: 0 };
  if (!ngspicePath) return { status: 'failed', values, message: 'Симулятор ngspice не найден — расчётные значения не получены.', runs: 0 };

  // Измеренное питание
  let doc: ProjectDoc = { ...revisionDoc, simulation: { ...revisionDoc.simulation, analysis: 'op', sweep: { ...revisionDoc.simulation.sweep, instanceId: null, values: [] } } };
  const notes: string[] = [];
  if (rec.supplyV !== null) {
    const sources = doc.schematic.instances.filter((i) => doc.library.parts.find((p) => p.id === i.partId)?.category === 'source' && i.values.voltage && !i.values.amplitude);
    if (sources.length === 1) {
      doc = setValue(doc, sources[0]!.id, 'voltage', { value: rec.supplyV, unit: 'V' });
      notes.push(`питание ${formatQuantity(rec.supplyV, 'В', 4)} (измерено) вместо ${formatQuantity(schematicSupply(revisionDoc)[0] ?? NaN, 'В', 4)} по схеме`);
    } else if (sources.length > 1) notes.push('измеренное питание не подставлено: на схеме несколько источников');
  }

  const base = await simulate(doc, ngspicePath, { analysis: 'op' });
  if (base.status !== 'ok' || !base.op) {
    const msg = base.status === 'blocked' ? `Расчёт не выполнен: ${base.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ')}` : `Расчёт не выполнен: ${base.error?.message ?? 'ошибка ngspice'}`;
    return { status: 'failed', values, message: msg, runs: 1 };
  }
  const v0 = new Map(needSim.map((m) => [m.id, valueOf(doc, base.op!, m)]));
  const band = new Map(needSim.map((m) => [m.id, 0]));

  const toleranced = doc.schematic.instances.filter((i) => {
    const part = doc.library.parts.find((p) => p.id === i.partId);
    return (part?.tolerancePct ?? 0) > 0 && i.values.resistance;
  });
  const used = toleranced.slice(0, MAX_TOLERANCED);
  let runs = 1;
  for (const inst of used) {
    const tol = doc.library.parts.find((p) => p.id === inst.partId)!.tolerancePct! / 100;
    const r = inst.values.resistance!.value;
    const d = new Map<string, number>();
    for (const k of [1 + tol, 1 - tol]) {
      const res = await simulate(setValue(doc, inst.id, 'resistance', { value: r * k, unit: 'Ω' }), ngspicePath, { analysis: 'op' });
      runs++;
      if (res.status !== 'ok' || !res.op) continue;
      for (const m of needSim) {
        const a = v0.get(m.id), b = valueOf(doc, res.op, m);
        if (a === null || a === undefined || b === null) continue;
        d.set(m.id, Math.max(d.get(m.id) ?? 0, Math.abs(b - a)));
      }
    }
    for (const [id, x] of d) band.set(id, band.get(id)! + x);
  }
  const tolText = used.length
    ? `разброс — наихудший случай по допускам сопротивлений ${used.map((i) => i.refDes).join(', ')}${toleranced.length > used.length ? ` (учтены первые ${MAX_TOLERANCED} из ${toleranced.length})` : ''}`
    : 'допуски деталей не указаны — разброс не учтён';
  for (const m of needSim) {
    const v = v0.get(m.id);
    if (v === null || v === undefined || !Number.isFinite(v)) {
      values.push({ measurementId: m.id, value: null, band: 0, method: '', reason: m.target.kind === 'text' ? 'точка описана словами' : 'эта величина в расчёте не определена (деталь удалена или не моделируется)' });
      continue;
    }
    values.push({
      measurementId: m.id, value: v, band: band.get(m.id)!, reason: null,
      method: [`рабочая точка ngspice, ${describe(m)}`, ...notes, tolText, 'допуски источников и разброс полупроводников не учитываются'].join('; '),
    });
  }
  return { status: 'ok', values, message: null, runs };
}
