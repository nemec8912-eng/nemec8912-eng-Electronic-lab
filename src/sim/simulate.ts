/** Полный цикл расчёта: проверки → netlist → ngspice → привязка результатов → пределы. */
import { AppError } from '../core/result';
import type { ProjectDoc } from '../core/model';
import { buildNetlist } from './netlist';
import { checkLimits, mapOp, mapTran, type SimResult } from './results';
import { runNgspice } from './runner';

export async function simulate(doc: ProjectDoc, ngspicePath: string | null, opts: { tran: boolean } = { tran: true }): Promise<SimResult> {
  const started = Date.now();
  const tran = opts.tran ? doc.simulation.tran : null;
  const nl = buildNetlist(doc, { op: true, tran }, doc.name);
  const base: SimResult = {
    status: 'blocked', revision: doc.revision, issues: nl.issues, error: null, op: null, tran: null, limits: [],
    engine: { name: 'ngspice', version: null }, netlist: nl.text, warnings: [], durationMs: 0,
  };
  if (nl.issues.some((i) => i.severity === 'error')) return { ...base, durationMs: Date.now() - started };
  if (!ngspicePath) {
    return { ...base, status: 'failed', error: { code: 'no-simulator', message: 'Симулятор ngspice не найден в составе программы. Расчёт невозможен.', details: [] }, durationMs: Date.now() - started };
  }
  try {
    const out = await runNgspice(ngspicePath, nl.text, { expect: tran ? ['op', 'tran'] : ['op'] });
    const op = out.plots.op ? mapOp(out.plots.op, nl) : null;
    const tr = out.plots.tran ? mapTran(out.plots.tran, nl) : null;
    return {
      ...base, status: 'ok', op, tran: tr, limits: checkLimits(doc, op, tr),
      engine: { name: 'ngspice', version: out.version }, warnings: out.warnings, durationMs: Date.now() - started,
    };
  } catch (e) {
    const err = e instanceof AppError ? { code: e.code, message: e.message, details: e.details ?? [] } : { code: 'internal', message: (e as Error).message, details: [] };
    return { ...base, status: 'failed', error: err, durationMs: Date.now() - started };
  }
}
