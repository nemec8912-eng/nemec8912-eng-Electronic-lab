/** ngspice WebAssembly (браузерная демо-версия): тот же расчёт, что у ngspice на ПК, на примерах. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import type { NgspiceExec } from '../../src/sim/engine';
import { runChecks } from '../../src/sim/checks';
import { simulate } from '../../src/sim/simulate';
import { readElab } from '../../src/storage/elab';

const dir = path.resolve(import.meta.dirname, '../../vendor/ngspice-wasm');
const skip = existsSync(path.join(dir, 'spice.wasm')) ? false : 'ngspice WebAssembly не собран (vendor/ngspice-wasm)';
const load = async (f: string) => (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples', f)))).doc;

/** Тот же порядок, что в Web Worker демо-версии (src/web/ngspiceWasm.ts), но в Node.js. */
function nodeWasm(): NgspiceExec {
  const create = createRequire(import.meta.url)(path.join(dir, 'spice.js'));
  return {
    async exec(netlist, opts) {
      let log = '', code = 0;
      const m = await create({ print: (s: string) => { log += s + '\n'; }, printErr: (s: string) => { log += s + '\n'; }, noInitialRun: true });
      m.FS.writeFile('/circuit.cir', netlist); m.FS.chdir('/');
      try { m.callMain(['-b', 'circuit.cir']); } catch (e) { const x = e as { name?: string; status?: number }; if (x?.name === 'ExitStatus') code = x.status ?? 0; else { log += String(e); code = 1; } }
      const files: Record<string, string> = {};
      for (const f of opts.files) { try { files[f] = m.FS.readFile('/' + f, { encoding: 'utf8' }); } catch { /* нет файла */ } }
      return { code, log, timedOut: false, files };
    },
  };
}

describe('ngspice WebAssembly', { skip }, () => {
  test('светодиод, RC-фильтр, NE555, LM317, блок питания 5 В: условия выполнены, как на ПК', async () => {
    const ng = nodeWasm();
    for (const f of ['пример-светодиод.elab', 'пример-rc-фильтр.elab', 'пример-мультивибратор-ne555.elab', 'пример-стабилизатор-lm317.elab', 'пример-блок-питания-5в.elab']) {
      const r = await runChecks(await load(f), ng);
      assert.equal(r.verdict, 'works', `${f}: ${r.summary} ${r.errors.join(' ')}`);
    }
  });
  test('LM317: 5,04 В на выходе; ошибка схемы — понятное сообщение', async () => {
    const ng = nodeWasm();
    const d = await load('пример-стабилизатор-lm317.elab');
    const r = await simulate(d, ng, { analysis: 'op' });
    assert.equal(r.status, 'ok');
    const out = d.schematic.nets.find((n) => n.connections.some((c) => d.schematic.instances.find((i) => i.id === c.instanceId)?.refDes === 'DA1' && c.pin === '2'))!;
    assert.ok(Math.abs(r.op!.node[out.id]! - 5.04) < 0.05, String(r.op!.node[out.id]));
    // Без земли — ngspice не считает: ошибка, а не выдуманные числа
    const noGnd = { ...d, schematic: { ...d.schematic, instances: d.schematic.instances.filter((i) => !/^GND/.test(i.refDes)) } };
    const bad = await simulate(noGnd, ng, { analysis: 'op' });
    assert.notEqual(bad.status, 'ok');
  });
});
