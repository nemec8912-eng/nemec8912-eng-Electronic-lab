/** Авторасстановка и автотрассировка: всё разведено, DRC чист, медь разных цепей разделяется фрезой. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { autoplace } from '../../src/core/autoplace';
import { autoroute, missingConnections } from '../../src/core/autoroute';
import { cncPlan } from '../../src/core/cnc';
import { drc } from '../../src/core/pcb';
import { readElab } from '../../src/storage/elab';

const load = async (f: string) => (await readElab(readFileSync(path.resolve(import.meta.dirname, '../../examples', f)))).doc;

describe('Авторасстановка и автотрассировка', () => {
  for (const f of ['пример-светодиод.elab', 'пример-rc-фильтр.elab', 'пример-мультивибратор-ne555.elab', 'пример-стабилизатор-lm317.elab']) {
    test(`${f}: расставить и развести заново — DRC без ошибок, все соединения есть, ЧПУ без ошибок`, async () => {
      let d = await load(f);
      d = { ...d, pcb: { ...d.pcb, tracks: [] } };
      const p = autoplace(d);
      assert.deepEqual(p.notPlaced, []);
      const r = autoroute(p.doc);
      assert.deepEqual(r.failed, [], JSON.stringify(r.failed));
      assert.equal(missingConnections(r.doc).length, 0);
      assert.deepEqual(drc(r.doc).filter((i) => i.severity === 'error').map((i) => i.message), []);
      assert.deepEqual(cncPlan(r.doc).issues.filter((i) => i.severity === 'error'), []);
      assert.ok(r.doc.changelog.at(-1)!.summary.startsWith('Автотрассировка'));
    });
  }
});
