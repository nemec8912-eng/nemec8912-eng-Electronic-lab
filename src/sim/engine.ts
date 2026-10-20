/**
 * Запуск ngspice в пакетном режиме (`ngspice -b circuit.cir`) — общая часть для программы и браузера.
 * Сам запуск — «исполнитель»: на ПК это процесс ngspice (runner.ts, путь к программе), в браузерной
 * демо-версии — ngspice, собранный в WebAssembly (web/ngspiceWasm.ts). Здесь — разбор результата и ошибок.
 */
import { AppError } from '../core/result';
import { parseRaw, RawParseError, type RawPlot } from './raw';

/** Предел времени одного расчёта: схемы с КМОП-логикой (металлоискатель) считаются до полуминуты, на медленном ПК — дольше. */
export const NGSPICE_TIMEOUT_MS = 120_000;

export type PlotKind = 'op' | 'tran' | 'dc' | 'ac';

export interface RunOutput {
  plots: Partial<Record<PlotKind, RawPlot>>;
  log: string;
  version: string | null;
  warnings: string[];
}

/** Итог запуска: код выхода, вывод ngspice, файлы *.raw (текст). */
export interface ExecResult { code: number | null; log: string; timedOut: boolean; files: Partial<Record<string, string>> }
export interface NgspiceExec { exec(netlist: string, opts: { timeoutMs: number; files: string[] }): Promise<ExecResult> }
/** ngspice: путь к программе (ПК) или исполнитель (браузер). */
export type Ngspice = string | NgspiceExec;

/** Ошибки ngspice → понятное объяснение. Исходный текст ngspice сохраняется в details. */
export function classifyNgspiceOutput(log: string): { code: string; message: string } | null {
  const l = log.toLowerCase();
  if (/singular matrix/.test(l)) {
    return { code: 'singular', message: 'Расчёт невозможен: матрица схемы вырождена. Обычно это узел без пути постоянного тока к земле, контур только из источников напряжения или разомкнутая цепь.' };
  }
  if (/timestep too small/.test(l)) {
    return { code: 'convergence', message: 'Ошибка сходимости: шаг времени стал слишком малым. Проверьте номиналы и уменьшите шаг/время расчёта.' };
  }
  if (/(no convergence|gmin stepping failed|source stepping failed|iteration limit reached|doanalyses: iteration limit)/.test(l)) {
    return { code: 'convergence', message: 'Ошибка сходимости: ngspice не нашёл решение. Проверьте номиналы и подключение деталей.' };
  }
  if (/(error on line|unknown device|unknown model|could not find|syntax error|error:)/.test(l)) {
    return { code: 'netlist', message: 'ngspice отклонил описание схемы. Это ошибка программы или модели — сообщите о ней (подробности ниже).' };
  }
  return null;
}

export async function runNgspice(ng: Ngspice, netlist: string, opts: { timeoutMs?: number; expect: PlotKind[] }): Promise<RunOutput> {
  const timeoutMs = opts.timeoutMs ?? NGSPICE_TIMEOUT_MS;
  const files = opts.expect.map((k) => `${k}.raw`);
  const exec = typeof ng === 'string' ? (await import('./runner')).processExec(ng) : ng;
  const { code, log, timedOut, files: out } = await exec.exec(netlist, { timeoutMs, files });
  if (timedOut) throw new AppError('timeout', `Расчёт прерван: дольше ${Math.round(timeoutMs / 1000)} с. Уменьшите время моделирования или увеличьте шаг.`);
  const version = /ngspice-(\d+(?:\.\d+)?)/i.exec(log)?.[1] ?? null;
  const problem = classifyNgspiceOutput(log);
  const plots: RunOutput['plots'] = {};
  for (const kind of opts.expect) {
    const text = out[`${kind}.raw`];
    if (text === undefined) continue;
    try {
      const parsed = parseRaw(text);
      if (parsed[0]) plots[kind] = parsed[0];
    } catch (e) {
      if (e instanceof RawParseError) throw new AppError('bad-output', `Не удалось прочитать результат ngspice: ${e.message}`, tail(log));
      throw e;
    }
  }
  const missing = opts.expect.filter((k) => !plots[k]);
  if (missing.length || (code !== 0 && code !== null)) {
    if (problem) throw new AppError(problem.code, problem.message, tail(log));
    throw new AppError('no-output', `ngspice завершился без результата (${missing.join(', ') || `код ${code}`}).`, tail(log));
  }
  const warnings = log.split(/\r?\n/).filter((x) => /warning/i.test(x)).slice(0, 20);
  return { plots, log, version, warnings };
}

const tail = (log: string) => log.split(/\r?\n/).filter((x) => x.trim()).slice(-25);
