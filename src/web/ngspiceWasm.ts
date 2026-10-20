/**
 * ngspice в браузере: тот же ngspice, собранный в WebAssembly (vendor/ngspice-wasm, сборка — GitHub Actions).
 * Код и модуль wasm встроены в страницу демо-версии (элементы script type="text/plain" и
 * type="application/octet-stream;base64"). Каждый расчёт — в отдельном Web Worker: окно не замирает,
 * по таймауту поток завершается. У ngspice много глобального состояния, поэтому модуль на каждый
 * расчёт создаётся заново (сама компиляция wasm кэшируется).
 */
import type { ExecResult, NgspiceExec } from '../sim/engine';

const WORKER_GLUE = `
self.onmessage = async (e) => {
  const { netlist, files, wasmModule } = e.data;
  let log = '';
  let code = 0;
  try {
    const m = await createNgspice({
      instantiateWasm: (imports, done) => { WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst, wasmModule)); return {}; },
      print: (s) => { if (log.length < 2000000) log += s + '\\n'; },
      printErr: (s) => { if (log.length < 2000000) log += s + '\\n'; },
      noInitialRun: true,
    });
    m.FS.writeFile('/circuit.cir', netlist);
    m.FS.chdir('/');
    try { m.callMain(['-b', 'circuit.cir']); }
    catch (err) { if (err && err.name === 'ExitStatus') code = err.status; else { log += String(err) + '\\n'; code = 1; } }
    const out = {};
    for (const f of files) { try { out[f] = m.FS.readFile('/' + f, { encoding: 'utf8' }); } catch (_) {} }
    self.postMessage({ code, log, files: out });
  } catch (err) {
    self.postMessage({ code: 1, log: log + 'Не удалось запустить ngspice WebAssembly: ' + err, files: {} });
  }
};`;

let compiled: Promise<{ module: WebAssembly.Module; js: string }> | null = null;

/** Есть ли в странице встроенный ngspice. */
export function hasEmbeddedNgspice(): boolean {
  return typeof document !== 'undefined' && !!document.getElementById('ngspice-js') && !!document.getElementById('ngspice-wasm');
}

function load(): Promise<{ module: WebAssembly.Module; js: string }> {
  compiled ??= (async () => {
    const js = document.getElementById('ngspice-js')!.textContent ?? '';
    const b64 = (document.getElementById('ngspice-wasm')!.textContent ?? '').replace(/\s+/g, '');
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return { module: await WebAssembly.compile(bin), js };
  })();
  return compiled;
}

export function wasmExec(): NgspiceExec {
  return {
    async exec(netlist, opts): Promise<ExecResult> {
      const { module, js } = await load();
      const url = URL.createObjectURL(new Blob([js, '\n', WORKER_GLUE], { type: 'text/javascript' }));
      const worker = new Worker(url);
      try {
        return await new Promise<ExecResult>((resolve) => {
          const timer = setTimeout(() => { worker.terminate(); resolve({ code: null, log: '', timedOut: true, files: {} }); }, opts.timeoutMs);
          worker.onmessage = (e: MessageEvent<{ code: number; log: string; files: Record<string, string> }>) => { clearTimeout(timer); resolve({ ...e.data, timedOut: false }); };
          worker.onerror = (e) => { clearTimeout(timer); resolve({ code: 1, log: `ngspice WebAssembly: ${e.message}`, timedOut: false, files: {} }); };
          worker.postMessage({ netlist, files: opts.files, wasmModule: module });
        });
      } finally {
        worker.terminate();
        URL.revokeObjectURL(url);
      }
    },
  };
}
