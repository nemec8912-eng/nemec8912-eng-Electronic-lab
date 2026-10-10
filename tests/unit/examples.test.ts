import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { readElab } from '../../src/storage/elab';

const dir = path.resolve(import.meta.dirname, '../../examples');

test('все примеры в examples/ открываются и проходят проверки', async () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.elab'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const r = await readElab(readFileSync(path.join(dir, f)));
    assert.ok(r.doc.schematic.annotations.length > 0, f);
  }
});
