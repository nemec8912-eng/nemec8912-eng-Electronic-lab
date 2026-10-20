/**
 * ngspice на ПК: отдельный процесс в пакетном режиме (`ngspice -b`), с таймаутом.
 * Работает во временной папке с относительными именами файлов: так кириллица и пробелы
 * в пути к профилю Windows не попадают в аргументы ngspice.
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AppError } from '../core/result';
import type { ExecResult, NgspiceExec } from './engine';

export { classifyNgspiceOutput, NGSPICE_TIMEOUT_MS, runNgspice, type Ngspice, type PlotKind, type RunOutput } from './engine';

/** Исполнитель: процесс ngspice по пути к программе. */
export function processExec(ngspicePath: string): NgspiceExec {
  return {
    async exec(netlist, opts): Promise<ExecResult> {
      if (!existsSync(ngspicePath)) throw new AppError('no-simulator', `Симулятор ngspice не найден: ${ngspicePath}`);
      const dir = await fs.mkdtemp(path.join(tmpdir(), 'elab-sim-'));
      try {
        await fs.writeFile(path.join(dir, 'circuit.cir'), netlist, 'utf8');
        const r = await new Promise<{ code: number | null; log: string; timedOut: boolean }>((resolve, reject) => {
          const child = spawn(ngspicePath, ['-b', 'circuit.cir'], { cwd: dir, windowsHide: true, env: { ...process.env, SPICE_ASCIIRAWFILE: '1' } });
          let out = '';
          let timedOut = false;
          const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
          child.stdout.setEncoding('utf8').on('data', (d: string) => { if (out.length < 2_000_000) out += d; });
          child.stderr.setEncoding('utf8').on('data', (d: string) => { if (out.length < 2_000_000) out += d; });
          child.on('error', (e) => { clearTimeout(timer); reject(new AppError('no-simulator', `Не удалось запустить ngspice: ${e.message}`)); });
          child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, log: out, timedOut }); });
        });
        const files: ExecResult['files'] = {};
        if (!r.timedOut) for (const f of opts.files) { const p = path.join(dir, f); if (existsSync(p)) files[f] = await fs.readFile(p, 'utf8'); }
        return { ...r, files };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

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
