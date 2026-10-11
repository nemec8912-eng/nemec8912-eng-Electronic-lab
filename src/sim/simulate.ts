/** Полный цикл расчёта: проверки → netlist → ngspice → привязка результатов → пределы; параметрический прогон. */
import { formatQuantity, PARAMS } from '../core/library';
import type { ProjectDoc } from '../core/model';
import { AppError } from '../core/result';
import { buildNetlist, type Analyses } from './netlist';
import { checkLimits, mapAc, mapDc, mapOp, mapTran, type AnalysisKind, type SimResult, type SweepRun } from './results';
import { runNgspice, type PlotKind } from './runner';

export interface SimulateOptions {
  /** Анализ; по умолчанию — выбранный в проекте. Рабочая точка считается всегда. */
  analysis?: AnalysisKind;
  /** Совместимость с этапом 1b: tran = true → переходный процесс, false → только рабочая точка. */
  tran?: boolean;
  /** Выполнять ли параметрический прогон из настроек проекта (по умолчанию — да). */
  sweep?: boolean;
}

export function analysesFor(doc: ProjectDoc, analysis: AnalysisKind): Analyses {
  const s = doc.simulation;
  return {
    op: true,
    tran: analysis === 'tran' ? s.tran : null,
    dc: analysis === 'dc' ? { sourceId: s.dc.sourceId ?? '', start: s.dc.start, stop: s.dc.stop, step: s.dc.step } : null,
    ac: analysis === 'ac' ? s.ac : null,
  };
}

type RunPart = Pick<SimResult, 'status' | 'issues' | 'error' | 'op' | 'tran' | 'dc' | 'ac' | 'netlist' | 'warnings'> & { version: string | null };

async function runOnce(doc: ProjectDoc, ngspicePath: string | null, analysis: AnalysisKind): Promise<RunPart> {
  const an = analysesFor(doc, analysis);
  const nl = buildNetlist(doc, an, doc.name);
  const base: RunPart = { status: 'blocked', issues: nl.issues, error: null, op: null, tran: null, dc: null, ac: null, netlist: nl.text, warnings: [], version: null };
  if (nl.issues.some((i) => i.severity === 'error')) return base;
  if (!ngspicePath) {
    return { ...base, status: 'failed', error: { code: 'no-simulator', message: 'Симулятор ngspice не найден в составе программы. Расчёт невозможен.', details: [] } };
  }
  const expect: PlotKind[] = ['op'];
  if (an.tran) expect.push('tran');
  if (an.dc) expect.push('dc');
  if (an.ac) expect.push('ac');
  try {
    const out = await runNgspice(ngspicePath, nl.text, { expect });
    return {
      ...base,
      status: 'ok',
      op: out.plots.op ? mapOp(out.plots.op, nl) : null,
      tran: out.plots.tran ? mapTran(out.plots.tran, nl) : null,
      dc: out.plots.dc && an.dc ? mapDc(out.plots.dc, nl, an.dc.sourceId) : null,
      ac: out.plots.ac ? mapAc(out.plots.ac, nl) : null,
      warnings: out.warnings,
      version: out.version,
    };
  } catch (e) {
    const error = e instanceof AppError ? { code: e.code, message: e.message, details: e.details ?? [] } : { code: 'internal', message: (e as Error).message, details: [] };
    return { ...base, status: 'failed', error };
  }
}

/** Копия документа с другим значением параметра экземпляра (для параметрического прогона). */
export function withParam(doc: ProjectDoc, instanceId: string, param: string, value: number): ProjectDoc {
  const unit = PARAMS[param]?.unit ?? '';
  return {
    ...doc,
    schematic: {
      ...doc.schematic,
      instances: doc.schematic.instances.map((i) => (i.id === instanceId ? { ...i, values: { ...i.values, [param]: { value, unit } } } : i)),
    },
  };
}

export async function simulate(doc: ProjectDoc, ngspicePath: string | null, opts: SimulateOptions = {}): Promise<SimResult> {
  const started = Date.now();
  const analysis: AnalysisKind = opts.analysis ?? (opts.tran === undefined ? doc.simulation.analysis : opts.tran ? 'tran' : 'op');
  const main = await runOnce(doc, ngspicePath, analysis);
  const result: SimResult = {
    status: main.status, analysis, revision: doc.revision, issues: main.issues, error: main.error,
    op: main.op, tran: main.tran, dc: main.dc, ac: main.ac, sweep: null,
    limits: main.status === 'ok' ? checkLimits(doc, main.op, main.tran, main.dc) : [],
    engine: { name: 'ngspice', version: main.version }, netlist: main.netlist, warnings: main.warnings, durationMs: 0,
  };
  const sw = doc.simulation.sweep;
  const inst = sw.instanceId ? doc.schematic.instances.find((i) => i.id === sw.instanceId) : undefined;
  if ((opts.sweep ?? true) && main.status === 'ok' && inst && sw.param && sw.values.length > 0) {
    const runs: SweepRun[] = [];
    for (const value of sw.values.slice(0, 12)) {
      const variant = withParam(doc, inst.id, sw.param, value);
      const r = await runOnce(variant, ngspicePath, analysis);
      const label = `${inst.refDes} = ${formatQuantity(value, PARAMS[sw.param]?.unitRu ?? '')}`;
      runs.push({
        value, status: r.status, op: r.op, tran: r.tran, dc: r.dc, ac: r.ac,
        error: r.error ?? (r.status === 'blocked' ? { code: 'blocked', message: r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' '), details: [] } : null),
      });
      if (r.status === 'ok') result.limits.push(...checkLimits(variant, r.op, r.tran, r.dc, ` [прогон: ${label}]`));
    }
    result.sweep = { instanceId: inst.id, param: sw.param, runs };
  }
  result.durationMs = Date.now() - started;
  return result;
}
