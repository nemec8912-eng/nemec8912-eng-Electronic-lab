/**
 * Тест работоспособности: расчёт нужных анализов ngspice и сверка каждого условия с диапазоном.
 * Итог «работает» — только если все условия выполнены и (по умолчанию) ни одна деталь не перегружена.
 * Если величину посчитать нельзя, условие не считается ни выполненным, ни проваленным — причина названа.
 */
import type { Ngspice } from './engine';
import { checkKind, checkProblem, pinLabel } from '../core/checks';
import type { Check, PinRef, ProjectDoc } from '../core/model';
import { netOfPin } from '../core/schematic';
import { waveStats } from './readings';
import { transfer, type SimResult } from './results';
import { simulate } from './simulate';

export type CheckStatus = 'pass' | 'fail' | 'na';
export interface CheckOutcome { id: string; status: CheckStatus; value: number | null; reason: string | null; measuredStatus: 'pass' | 'fail' | null }
export interface CheckReport {
  revision: number;
  verdict: 'works' | 'fails' | 'unknown' | 'empty';
  outcomes: CheckOutcome[];
  overload: string[];
  /** Ошибки запуска анализов (схема не рассчитывается и т. п.). */
  errors: string[];
  summary: string;
}

const inRange = (c: Check, v: number) => (c.min === null || v >= c.min - Math.abs(c.min) * 1e-9) && (c.max === null || v <= c.max + Math.abs(c.max) * 1e-9);

function netOf(doc: ProjectDoc, p: PinRef | null): { id: string | null; error: string | null } {
  if (!p) return { id: null, error: null };
  if (!doc.schematic.instances.some((i) => i.id === p.instanceId)) return { id: null, error: 'деталь удалена со схемы' };
  const n = netOfPin(doc, p);
  return n ? { id: n.id, error: null } : { id: null, error: `вывод ${pinLabel(doc, p)} ни к чему не подключён` };
}

export function evaluateChecks(doc: ProjectDoc, runs: Partial<Record<'op' | 'tran' | 'ac', SimResult>>): CheckReport {
  const outcomes: CheckOutcome[] = [];
  const errors: string[] = [];
  for (const [k, r] of Object.entries(runs)) {
    if (r && r.status !== 'ok') {
      const msg = r.error?.message ?? r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ');
      errors.push(`${k === 'op' ? 'Рабочая точка' : k === 'tran' ? 'Переходный процесс' : 'Частотный анализ'}: ${msg || 'расчёт не выполнен'}`);
    }
  }
  for (const c of doc.checks.items) {
    const out = (status: CheckStatus, value: number | null, reason: string | null): CheckOutcome => ({
      id: c.id, status, value, reason,
      measuredStatus: c.measured === null ? null : inRange(c, c.measured) ? 'pass' : 'fail',
    });
    const problem = checkProblem(c);
    if (problem) { outcomes.push(out('na', null, problem)); continue; }
    const kind = checkKind(c.quantity);
    const r = runs[kind.analysis];
    if (!r || r.status !== 'ok') { outcomes.push(out('na', null, 'расчёт не выполнен — см. ошибки выше')); continue; }
    const at = netOf(doc, c.at), ref = netOf(doc, c.ref);
    if (at.error || ref.error) { outcomes.push(out('na', null, at.error ?? ref.error)); continue; }
    let value: number | null = null;
    let reason: string | null = null;
    if (c.quantity === 'dc-v') {
      const v = (id: string | null) => (id ? r.op?.node[id] ?? 0 : 0);
      value = v(at.id) - v(ref.id);
    } else if (c.quantity === 'dc-i') {
      const inst = c.at!.instanceId;
      const pins = r.op?.pins[inst];
      const i = pins && pins[c.at!.pin] !== undefined ? pins[c.at!.pin]! : r.op?.current[inst];
      if (i === undefined) reason = 'ток этого вывода расчёт не даёт';
      else value = Math.abs(i);
    } else if (c.quantity.startsWith('tran-')) {
      const t = r.tran;
      if (!t) reason = 'нет результата переходного процесса';
      else {
        const zero = t.time.map(() => 0);
        const a = at.id ? t.node[at.id] ?? zero : zero, b = ref.id ? t.node[ref.id] ?? zero : zero;
        const sig = a.map((v, k) => v - b[k]!);
        const st = waveStats(t.time, sig, c.fromS ?? undefined);
        if (!st) reason = 'окно измерения пустое — уменьшите «с момента» или увеличьте время расчёта';
        else {
          switch (c.quantity) {
            case 'tran-avg': value = st.mean; break;
            case 'tran-max': value = st.max; break;
            case 'tran-min': value = st.min; break;
            case 'tran-vpp': value = st.vpp; break;
            case 'tran-rms': value = st.rms; break;
            case 'tran-freq':
              if (st.freq === null) reason = st.vpp < 1e-6 ? 'сигнал не меняется — генерации нет' : 'меньше двух периодов на окне — увеличьте время расчёта';
              else value = st.freq;
              break;
          }
          if (c.quantity === 'tran-freq' && value === null && st.vpp < 1e-6) { outcomes.push(out('fail', 0, reason)); continue; }
        }
      }
    } else if (c.quantity === 'ac-gain') {
      const ac = r.ac;
      const inp = netOf(doc, c.input);
      if (!ac) reason = 'нет результата частотного анализа';
      else if (inp.error || !inp.id) reason = inp.error ?? 'вход — земля';
      else {
        const tr = transfer(ac, at.id!, ref.id, inp.id);
        const f = c.freqHz!;
        const fr = ac.freq;
        if (f < fr[0]! || f > fr[fr.length - 1]!) reason = `частота вне диапазона анализа (${Math.round(fr[0]!)}…${Math.round(fr[fr.length - 1]!)} Гц) — поменяйте настройки на вкладке «Тест»`;
        else {
          let k = 0;
          while (k < fr.length - 2 && fr[k + 1]! < f) k++;
          const u = (Math.log(f) - Math.log(fr[k]!)) / (Math.log(fr[k + 1]!) - Math.log(fr[k]!) || 1);
          value = tr.mag[k]! + (tr.mag[k + 1]! - tr.mag[k]!) * Math.max(0, Math.min(1, u));
        }
      }
    }
    if (value === null || !Number.isFinite(value)) { outcomes.push(out('na', null, reason ?? 'значение не получено')); continue; }
    outcomes.push(out(inRange(c, value) ? 'pass' : 'fail', value, null));
  }
  const overload = [...new Set(Object.values(runs).flatMap((r) => (r?.status === 'ok' ? r.limits.map((l) => l.message) : [])))];
  const fails = outcomes.filter((o) => o.status === 'fail').length + (doc.checks.noOverload && overload.length ? 1 : 0);
  const na = outcomes.filter((o) => o.status === 'na').length + errors.length;
  const passed = outcomes.filter((o) => o.status === 'pass').length;
  const total = outcomes.length;
  const verdict: CheckReport['verdict'] = fails ? 'fails' : na ? 'unknown' : total === 0 && !doc.checks.noOverload ? 'empty' : 'works';
  const summary =
    verdict === 'works' ? `Работает: выполнены все условия (${total})${doc.checks.noOverload ? ', детали не перегружены' : ''}`
      : verdict === 'fails' ? `Не работает: выполнено ${passed} из ${total}${doc.checks.noOverload && overload.length ? `; перегружено деталей: ${overload.length}` : ''}`
        : verdict === 'unknown' ? `Не удалось проверить всё: выполнено ${passed} из ${total}, не посчитано ${na}`
          : 'Условия не заданы';
  return { revision: doc.revision, verdict, outcomes, overload, errors, summary };
}

/** Запуск нужных анализов и проверка. */
export async function runChecks(doc: ProjectDoc, ngspicePath: Ngspice | null): Promise<CheckReport> {
  const need = new Set<'op' | 'tran' | 'ac'>(['op']);
  for (const c of doc.checks.items) need.add(checkKind(c.quantity).analysis);
  const runs: Partial<Record<'op' | 'tran' | 'ac', SimResult>> = {};
  for (const a of need) runs[a] = await simulate(doc, ngspicePath, { analysis: a, sweep: false });
  return evaluateChecks(doc, runs);
}
