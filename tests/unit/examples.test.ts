import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkIntegrity } from '../../src/core/integrity';
import { CURRENT_SCHEMA_VERSION } from '../../src/core/model';
import { drc } from '../../src/core/pcb';
import { readElab } from '../../src/storage/elab';

const dir = path.resolve(import.meta.dirname, '../../examples');

test('все примеры в examples/ открываются, текущего формата, целостны; на платах примеров нет ошибок DRC', async () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.elab'));
  assert.ok(files.length >= 5, files.join(', '));
  for (const f of files) {
    const r = await readElab(readFileSync(path.join(dir, f)));
    assert.equal(r.doc.schemaVersion, CURRENT_SCHEMA_VERSION, `${f}: пересоздайте примеры (npm run examples)`);
    assert.deepEqual(checkIntegrity(r.doc), [], f);
    assert.ok(r.doc.description.length > 20, `${f}: нет описания`);
    if (r.doc.pcb.board) assert.equal(drc(r.doc).filter((i) => i.severity === 'error').length, 0, f);
  }
});
