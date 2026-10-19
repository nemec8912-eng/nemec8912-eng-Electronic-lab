/**
 * Запуск ngspice отдельным процессом в пакетном режиме (`ngspice -b`), с таймаутом.
 * Работает во временной папке с относительными именами файлов: так кириллица и пробелы
 * в пути к профилю Windows не попадают в аргументы ngspice.
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

export async function runNgspice(ngspicePath: string, netlist: string, opts: { timeoutMs?: number; expect: PlotKind[] }): Promise<RunOutput> {
  if (!existsSync(ngspicePath)) throw new AppError('no-simulator', `Симулятор ngspice не найден: ${ngspicePath}`);
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'elab-sim-'));
  try {
    await fs.writeFile(path.join(dir, 'circuit.cir'), netlist, 'utf8');
    const { code, log, timedOut } = await new Promise<{ code: number | null; log: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(ngspicePath, ['-b', 'circuit.cir'], { cwd: dir, windowsHide: true, env: { ...process.env, SPICE_ASCIIRAWFILE: '1' } });
      let out = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? NGSPICE_TIMEOUT_MS);
      child.stdout.setEncoding('utf8').on('data', (d: string) => { if (out.length < 2_000_000) out += d; });
      child.stderr.setEncoding('utf8').on('data', (d: string) => { if (out.length < 2_000_000) out += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(new AppError('no-simulator', `Не удалось запустить ngspice: ${e.message}`)); });
      child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, log: out, timedOut }); });
    });
    if (timedOut) throw new AppError('timeout', `Расчёт прерван: дольше ${Math.round((opts.timeoutMs ?? NGSPICE_TIMEOUT_MS) / 1000)} с. Уменьшите время моделирования или увеличьте шаг.`);
    const version = /ngspice-(\d+(?:\.\d+)?)/i.exec(log)?.[1] ?? null;
    const problem = classifyNgspiceOutput(log);
    const plots: RunOutput['plots'] = {};
    for (const kind of opts.expect) {
      const file = path.join(dir, `${kind}.raw`);
      if (!existsSync(file)) continue;
      try {
        const parsed = parseRaw(await fs.readFile(file, 'utf8'));
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
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const tail = (log: string) => log.split(/\r?\n/).filter((x) => x.trim()).slice(-25);

/** Где искать ngspice: переменная ELAB_NGSPICE, папка ресурсов сборки, папка vendor проекта, PATH. */
export function locateNgspice(opts: { env?: string; resourcesPath?: string; appRoot?: string; platform?: NodeJS.Platform }): string | null {
  const platform = opts.platform ?? process.platform;
  const exeNames = platform === 'win32' ? ['ngspice_con.exe', 'ngspice.exe'] : ['ngspice'];
  const candidates: string[] = [];
  if (opts.env) candidates.push(opts.env);
  const dirs = [
    opts.resourcesPath && path.join(opts.resourcesPath, 'ngspice', 'bin'),
    opts.appRoot && path.join(opts.appRoot, 'vendor', 'ngspice', `${platform}-x64`, 'bin'),
  ].filter(Boolean) as string[];
  for (const d of dirs) for (const n of exeNames) candidates.push(path.join(d, n));
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) for (const n of exeNames) if (d) candidates.push(path.join(d, n));
  return candidates.find((c) => existsSync(c)) ?? null;
}
