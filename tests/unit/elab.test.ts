import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import JSZip from 'jszip';
import { newId } from '../../src/core/ids';
import type { Checkpoint } from '../../src/core/model';
import { AppError } from '../../src/core/result';
import { readElab, writeElab } from '../../src/storage/elab';
import { sha256 } from '../../src/storage/fsutil';
import { isSafeArchivePath } from '../../src/storage/zip';
import { linkSignature, makeRichDoc } from '../helpers';

async function expectError(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AppError, String(e));
    assert.equal(e.code, code, e.message);
    return true;
  });
}

async function rewrite(buf: Buffer, edit: (zip: JSZip) => void | Promise<void>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  await edit(zip);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function withAttachment() {
  const doc = makeRichDoc();
  const data = Buffer.from('%PDF-1.4 условный даташит', 'utf8');
  const id = newId();
  doc.attachments.push({ id, fileName: 'datasheet.pdf', size: data.length, sha256: sha256(data), mime: 'application/pdf' });
  const cp: Checkpoint = { id: newId(), label: 'до правок', kind: 'manual', createdAt: new Date().toISOString(), revision: doc.revision, doc };
  return { doc, data, id, cp };
}

describe('.elab: запись и чтение', () => {
  test('круговой перенос сохраняет документ, контрольные версии, вложения и связи', async () => {
    const { doc, data, id, cp } = withAttachment();
    const buf = await writeElab({ doc, checkpoints: [cp], attachments: new Map([[id, data]]) });
    const r = await readElab(buf);
    assert.deepEqual(r.doc, doc);
    assert.deepEqual(linkSignature(r.doc), linkSignature(doc));
    assert.equal(r.checkpoints.length, 1);
    assert.deepEqual(r.checkpoints[0]!.doc, doc);
    assert.deepEqual(r.attachments.get(id), data);
    assert.equal(r.manifest.formatVersion, 1);
    assert.deepEqual(r.warnings, []);
  });

  test('манифест содержит размер и SHA-256 каждого файла', async () => {
    const { doc, data, id } = withAttachment();
    const zip = await JSZip.loadAsync(await writeElab({ doc, checkpoints: [], attachments: new Map([[id, data]]) }));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const paths = manifest.files.map((f: { path: string }) => f.path).sort();
    assert.deepEqual(paths, [`attachments/${id}/datasheet.pdf`, 'project.json']);
    for (const f of manifest.files) {
      const content = await zip.file(f.path)!.async('nodebuffer');
      assert.equal(f.size, content.length);
      assert.equal(f.sha256, sha256(content));
    }
  });

  test('запись отказывается, если данные вложения отсутствуют или не совпадают', async () => {
    const { doc, id } = withAttachment();
    await expectError(writeElab({ doc, checkpoints: [], attachments: new Map() }), 'missing-attachment');
    await expectError(writeElab({ doc, checkpoints: [], attachments: new Map([[id, Buffer.from('другое')]]) }), 'attachment-mismatch');
  });
});

describe('.elab: отказ на плохих файлах', () => {
  const good = () => writeElab({ doc: makeRichDoc(), checkpoints: [], attachments: new Map() });

  test('не ZIP / обрезанный файл', async () => {
    await expectError(readElab(Buffer.from('это не архив')), 'corrupt-archive');
    const buf = await good();
    await expectError(readElab(buf.subarray(0, Math.floor(buf.length / 2))), 'corrupt-archive');
  });

  test('испорченные байты внутри архива (CRC)', async () => {
    const buf = Buffer.from(await good());
    const zip = await JSZip.loadAsync(buf);
    const data = await zip.file('project.json')!.async('nodebuffer');
    // Сохраняем без сжатия, чтобы найти и испортить байт содержимого
    const stored = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const pos = stored.indexOf(data.subarray(0, 40));
    assert.ok(pos > 0);
    stored[pos + 20] = stored[pos + 20]! ^ 0xff;
    await assert.rejects(readElab(stored), (e: unknown) => e instanceof AppError && ['corrupt-archive', 'checksum'].includes(e.code));
  });

  test('подмена содержимого с сохранением ZIP-структуры → контрольная сумма', async () => {
    const buf = await rewrite(await good(), async (zip) => {
      const p = JSON.parse(await zip.file('project.json')!.async('string'));
      p.name = 'подменено';
      zip.file('project.json', JSON.stringify(p));
    });
    await expectError(readElab(buf), 'checksum');
  });

  test('нет manifest.json / чужой формат / бэкап вместо проекта', async () => {
    await expectError(readElab(await rewrite(await good(), (z) => { z.remove('manifest.json'); })), 'no-manifest');
    await expectError(readElab(await rewrite(await good(), (z) => { z.file('manifest.json', '{"format":"other"}'); })), 'wrong-format');
    await expectError(readElab(await rewrite(await good(), (z) => { z.file('manifest.json', '{"format":"electronic-lab-backup"}'); })), 'wrong-format');
  });

  test('файл более новой версии формата', async () => {
    const buf = await rewrite(await good(), async (zip) => {
      const m = JSON.parse(await zip.file('manifest.json')!.async('string'));
      m.formatVersion = 7;
      zip.file('manifest.json', JSON.stringify(m));
    });
    await expectError(readElab(buf), 'newer-format');
  });

  test('опасные пути в архиве (zip-slip)', async () => {
    // JSZip не даёт записать «../» — подменяем имя прямо в байтах заголовков ZIP (той же длины).
    const zipped = await rewrite(await good(), (zip) => { zip.file('XX/XX/evil.txt', 'x', { compression: 'STORE' }); });
    const evil = Buffer.from(zipped.toString('latin1').split('XX/XX/evil.txt').join('../../evil.txt'), 'latin1');
    await expectError(readElab(evil), 'unsafe-path');
    for (const p of ['../a', 'a/../b', '/abs', 'C:/x', 'a\\b', 'a//b', './a']) assert.ok(!isSafeArchivePath(p), p);
    for (const p of ['project.json', 'checkpoints/x.json', 'attachments/id/Даташит 1.pdf']) assert.ok(isSafeArchivePath(p), p);
  });

  test('повторяющиеся ID внутри проекта — импорт отклонён', async () => {
    const doc = makeRichDoc();
    doc.schematic.wires.push({ ...doc.schematic.wires[0]! });
    const files = new Map<string, Buffer>();
    const json = Buffer.from(JSON.stringify(doc));
    files.set('project.json', json);
    const zip = new JSZip();
    zip.file('project.json', json);
    zip.file('manifest.json', JSON.stringify({
      format: 'electronic-lab-project', formatVersion: 1, app: { name: 'x', version: '0' }, createdAt: new Date().toISOString(),
      projectId: doc.id, projectName: doc.name, schemaVersion: 1, files: [{ path: 'project.json', size: json.length, sha256: sha256(json) }],
    }));
    await expectError(readElab(await zip.generateAsync({ type: 'nodebuffer' })), 'project-integrity');
  });

  test('проект версии 0 внутри .elab мигрирует при импорте', async () => {
    const v0 = readFileSync(new URL('../fixtures/project-v0.json', import.meta.url));
    const zip = new JSZip();
    zip.file('project.json', v0);
    zip.file('manifest.json', JSON.stringify({
      format: 'electronic-lab-project', formatVersion: 1, app: { name: 'x', version: '0' }, createdAt: new Date().toISOString(),
      projectId: JSON.parse(v0.toString()).id, projectName: 'v0', schemaVersion: 0, files: [{ path: 'project.json', size: v0.length, sha256: sha256(v0) }],
    }));
    const r = await readElab(await zip.generateAsync({ type: 'nodebuffer' }));
    assert.equal(r.migratedFrom, 0);
    assert.equal(r.doc.schematic.annotations.length, 2);
  });

  test('лишний файл не мешает, но попадает в предупреждения', async () => {
    const r = await readElab(await rewrite(await good(), (z) => { z.file('notes.txt', 'привет'); }));
    assert.equal(r.warnings.length, 1);
  });
});
