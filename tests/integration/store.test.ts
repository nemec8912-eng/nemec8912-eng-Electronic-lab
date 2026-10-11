import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { addAnnotation, renameProject } from '../../src/core/factory';
import { newId } from '../../src/core/ids';
import { AppError } from '../../src/core/result';
import { createBackup, restoreBackup, verifyBackup } from '../../src/storage/backup';
import { sha256 } from '../../src/storage/fsutil';
import { AUTO_CHECKPOINTS_KEPT, DataStore } from '../../src/storage/store';
import { linkSignature, makeRichDoc, tempDir } from '../helpers';

const CHILD = path.join(import.meta.dirname, 'crash-child.ts');
const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanups) await c(); });

async function freshStore(name = 'pc') {
  const t = await tempDir(`elab-${name}-`);
  cleanups.push(t.cleanup);
  const root = path.join(t.dir, 'data');
  return { root, store: await DataStore.open(root) };
}

describe('Проекты: жизненный цикл', () => {
  test('создать → изменить → сохранить → закрыть → открыть', async () => {
    const { root, store } = await freshStore();
    let doc = await store.createProject('Блок питания');
    doc = addAnnotation(doc, { x: 1, y: 2 }, 'C1 47 мкФ 50 В').doc;
    await store.saveProject(doc);
    await store.close();
    assert.ok(!existsSync(path.join(root, 'session.lock')), 'нормальный выход снимает признак сеанса');

    const again = await DataStore.open(root);
    assert.equal(again.crashedLastSession, false);
    const list = await again.listProjects();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'Блок питания');
    assert.equal(list[0]!.hasRecovery, false);
    const opened = await again.openProject(doc.id);
    assert.deepEqual(opened.doc, doc);
    assert.equal(opened.recovery, null);
    await again.close();
  });

  test('переименование, дублирование (новые UUID, связи целы), удаление в корзину', async () => {
    const { root, store } = await freshStore();
    const created = await store.createProject('Исходный');
    const rich = { ...makeRichDoc('Исходный'), id: created.id };
    await store.saveProject(rich);

    const renamed = await store.renameProject(created.id, 'Переименованный');
    assert.equal(renamed.name, 'Переименованный');

    const dup = await store.duplicateProject(created.id);
    assert.notEqual(dup.id, created.id);
    assert.equal(dup.name, 'Переименованный (копия)');
    assert.deepEqual(linkSignature(dup), linkSignature((await store.openProject(created.id)).doc));
    assert.equal((await store.listProjects()).length, 2);

    await store.deleteProject(created.id);
    const list = await store.listProjects();
    assert.deepEqual(list.map((p) => p.id), [dup.id]);
    const trash = await fs.readdir(path.join(root, 'trash'));
    assert.equal(trash.length, 1);
    assert.ok(existsSync(path.join(root, 'trash', trash[0]!, 'project.json')), 'удалённый проект физически сохранён в корзине');
    await store.close();
  });

  test('«Сохранить как» создаёт новый проект и не трогает исходный', async () => {
    const { store } = await freshStore();
    const a = await store.createProject('А');
    const edited = addAnnotation(a, { x: 0, y: 0 }, 'правка').doc;
    const b = await store.saveAs(edited, 'Б');
    assert.notEqual(b.id, a.id);
    assert.equal(b.schematic.annotations[0]!.text, 'правка');
    assert.equal((await store.openProject(a.id)).doc.schematic.annotations.length, 0);
    await store.close();
  });

  test('сохранение повреждённого документа отклоняется, файл на диске не меняется', async () => {
    const { root, store } = await freshStore();
    const doc = await store.createProject('Цел');
    const file = path.join(root, 'projects', doc.id, 'project.json');
    const before = readFileSync(file);
    const broken = structuredClone(doc);
    broken.schematic.annotations.push({ id: doc.id, kind: 'text', text: 'дубликат ID', position: { x: 0, y: 0 }, targetId: null });
    await assert.rejects(store.saveProject(broken), (e: unknown) => e instanceof AppError && e.code === 'invalid-integrity');
    assert.deepEqual(readFileSync(file), before);
    await store.close();
  });

  test('.bak предыдущего сохранения и ограничение автоматических контрольных версий', async () => {
    const { root, store } = await freshStore();
    let doc = await store.createProject('Версии');
    for (let i = 0; i < AUTO_CHECKPOINTS_KEPT + 5; i++) {
      doc = addAnnotation(doc, { x: i, y: 0 }, `з${i}`).doc;
      await store.saveProject(doc);
    }
    await store.createCheckpoint(doc, 'Перед экспериментом');
    const cps = await store.listCheckpoints(doc.id);
    assert.equal(cps.filter((c) => c.kind === 'on-save').length, AUTO_CHECKPOINTS_KEPT);
    assert.equal(cps.filter((c) => c.kind === 'manual').length, 1);
    assert.equal(cps[0]!.label, 'Перед экспериментом', 'список — от новых к старым');
    const bak = JSON.parse(readFileSync(path.join(root, 'projects', doc.id, 'project.json.bak'), 'utf8'));
    assert.equal(bak.schematic.annotations.length, AUTO_CHECKPOINTS_KEPT + 4);
    const manual = await store.readCheckpoint(doc.id, cps[0]!.id);
    assert.deepEqual(manual.doc, doc);
    await store.close();
  });

  test('повреждённый project.json виден в списке с ошибкой, а не исчезает', async () => {
    const { root, store } = await freshStore();
    const doc = await store.createProject('Сломанный');
    await fs.writeFile(path.join(root, 'projects', doc.id, 'project.json'), '{ обрыв');
    const list = await store.listProjects();
    assert.equal(list.length, 1);
    assert.match(list[0]!.error ?? '', /повреждён/);
    await store.close();
  });

  test('операции выполняются по очереди: параллельные автосохранения и сохранение не портят файлы', async () => {
    const { store } = await freshStore();
    let doc = await store.createProject('Очередь');
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      doc = addAnnotation(doc, { x: i, y: i }, `${i}`).doc;
      ops.push(i % 5 === 4 ? store.saveProject(doc) : store.autosave(doc));
    }
    await Promise.all(ops);
    const opened = await store.openProject(doc.id);
    assert.equal(opened.doc.schematic.annotations.length, 30);
    assert.equal(opened.recovery, null, 'последней операцией было сохранение');
    await store.close();
  });
});

describe('Аварийное завершение и восстановление', () => {
  test('SIGKILL после автосохранения → при запуске сбой обнаружен и изменения восстанавливаются', async () => {
    const { root, store } = await freshStore('crash');
    const doc = await store.createProject('Авария');
    await store.close();

    const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, 'autosave-then-kill', root, doc.id], { encoding: 'utf8' });
    // В Linux процесс завершается сигналом, в Windows — принудительно с ненулевым кодом.
    assert.ok(r.signal === 'SIGKILL' || (process.platform === 'win32' && r.status !== 0), r.stderr);

    const reopened = await DataStore.open(root, { ignoreLiveLock: true });
    assert.equal(reopened.crashedLastSession, true);
    const summary = (await reopened.listProjects())[0]!;
    assert.equal(summary.hasRecovery, true);
    const opened = await reopened.openProject(doc.id);
    assert.equal(opened.doc.schematic.annotations.length, 0, 'сохранённая версия не тронута');
    assert.deepEqual(opened.recovery!.doc.schematic.annotations.map((a) => a.text), ['несохранённая 1', 'несохранённая 2']);

    await reopened.saveProject(opened.recovery!.doc);
    const after = await reopened.openProject(doc.id);
    assert.equal(after.doc.schematic.annotations.length, 2);
    assert.equal(after.recovery, null);
    await reopened.close();
  });

  test('отказ от восстановления удаляет рабочую копию', async () => {
    const { store } = await freshStore();
    const doc = await store.createProject('Отказ');
    await store.autosave(addAnnotation(doc, { x: 0, y: 0 }).doc);
    assert.ok((await store.openProject(doc.id)).recovery);
    await store.discardRecovery(doc.id);
    assert.equal((await store.openProject(doc.id)).recovery, null);
    await store.close();
  });

  test('многократное убийство процесса во время записи не оставляет повреждённых файлов', { timeout: 120_000 }, async () => {
    const { root, store } = await freshStore('hammer');
    const doc = await store.createProject('Молоток');
    await store.close();
    for (let round = 0; round < 6; round++) {
      const child = spawn(process.execPath, ['--import', 'tsx', CHILD, 'hammer', root, doc.id], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 400));
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      const s = await DataStore.open(root, { ignoreLiveLock: true });
      const list = await s.listProjects();
      assert.equal(list[0]!.error, null, `раунд ${round}: ${list[0]!.error}`);
      const opened = await s.openProject(doc.id);
      assert.equal(opened.recoveryError, null, `раунд ${round}: рабочая копия читается`);
      await s.close();
    }
  });
});

describe('Перенос на другой ПК (две независимые папки данных)', () => {
  test('экспорт .elab на «ПК 1» → импорт на чистом «ПК 2» → редактирование → обратно', async () => {
    const pc1 = await freshStore('pc1');
    const created = await pc1.store.createProject('Переносимый');
    const rich = { ...makeRichDoc('Переносимый'), id: created.id };
    await pc1.store.saveProject(rich);
    await pc1.store.createCheckpoint(rich, 'Перед переносом');
    const unsaved = addAnnotation(rich, { x: 5, y: 5 }, 'добавлено перед экспортом').doc;
    const file = await pc1.store.exportProject(unsaved);

    const pc2 = await freshStore('pc2');
    const preview = await pc2.store.previewImport(file);
    assert.equal(preview.existing, null);
    const imported = await pc2.store.importProject(preview.read, 'new');
    assert.equal(imported.id, created.id, 'ID сохраняются при импорте без конфликта');
    assert.deepEqual(linkSignature(imported), linkSignature(unsaved));
    assert.equal(imported.schematic.annotations.length, 2);
    const cps = await pc2.store.listCheckpoints(imported.id);
    assert.ok(cps.some((c) => c.label === 'Перед переносом'));

    // продолжить редактирование на ПК 2
    const edited = addAnnotation(imported, { x: 9, y: 9 }, 'правка на ПК 2').doc;
    await pc2.store.saveProject(edited);
    const back = await pc2.store.exportProject(edited);

    // вернуть на ПК 1: конфликт ID → выбор пользователя
    const preview1 = await pc1.store.previewImport(back);
    assert.ok(preview1.existing, 'конфликт обнаружен');
    await assert.rejects(pc1.store.importProject(preview1.read, 'new'), (e: unknown) => e instanceof AppError && e.code === 'conflict');
    const asCopy = await pc1.store.importProject(preview1.read, 'copy');
    assert.notEqual(asCopy.id, created.id);
    assert.deepEqual(linkSignature(asCopy), linkSignature(edited));
    assert.equal((await pc1.store.listCheckpoints(asCopy.id)).length, preview1.read.checkpoints.length, 'контрольные версии перенесены с копией');
    assert.ok(preview1.read.checkpoints.length >= 3);
    const replaced = await pc1.store.importProject(preview1.read, 'replace');
    assert.equal(replaced.id, created.id);
    assert.equal((await pc1.store.openProject(created.id)).doc.schematic.annotations.at(-1)!.text, 'правка на ПК 2');
    assert.equal((await fs.readdir(path.join(pc1.root, 'trash'))).length, 1, 'заменённый проект ушёл в корзину');
    await pc1.store.close();
    await pc2.store.close();
  });

  test('вложения переносятся с проверкой контрольных сумм', async () => {
    const pc1 = await freshStore('att1');
    const doc0 = await pc1.store.createProject('С даташитом');
    const data = Buffer.from('условный PDF', 'utf8');
    const attId = newId();
    const attDir = path.join(pc1.root, 'projects', doc0.id, 'attachments', attId);
    await fs.mkdir(attDir, { recursive: true });
    await fs.writeFile(path.join(attDir, 'LM317.pdf'), data);
    const doc = { ...doc0, revision: 1, attachments: [{ id: attId, fileName: 'LM317.pdf', size: data.length, sha256: sha256(data), mime: 'application/pdf' }] };
    await pc1.store.saveProject(doc);
    const file = await pc1.store.exportProject(doc);
    const pc2 = await freshStore('att2');
    const imported = await pc2.store.importProject((await pc2.store.previewImport(file)).read, 'new');
    assert.deepEqual(readFileSync(path.join(pc2.root, 'projects', imported.id, 'attachments', attId, 'LM317.pdf')), data);
    await pc1.store.close();
    await pc2.store.close();
  });
});

describe('Полная резервная копия', () => {
  let pc1: Awaited<ReturnType<typeof freshStore>>;
  let backup: Buffer;
  const ids: string[] = [];

  before(async () => {
    pc1 = await freshStore('bk1');
    for (const n of ['Первый', 'Второй', 'Третий']) {
      const d = await pc1.store.createProject(n);
      ids.push(d.id);
      await pc1.store.saveProject(addAnnotation(d, { x: 0, y: 0 }, `заметка ${n}`).doc);
    }
    // несохранённая работа тоже попадает в бэкап
    const opened = await pc1.store.openProject(ids[0]!);
    await pc1.store.autosave(addAnnotation(opened.doc, { x: 1, y: 1 }, 'не сохранено').doc);
    await fs.writeFile(path.join(pc1.root, 'library', 'catalog.json'), JSON.stringify({ schemaVersion: 1, symbols: [], parts: [{ marker: 'личная деталь' }], packages: [], models: [] }));
    backup = (await createBackup(pc1.store)).buffer;
  });

  test('восстановление на чистом ПК: все проекты, рабочие копии, каталог, журнал', async () => {
    const pc2 = await freshStore('bk2');
    const verified = await verifyBackup(backup);
    assert.equal(verified.manifest.projects.length, 3);
    const res = await restoreBackup(pc2.store, verified);
    assert.equal(res.projects, 3);
    await pc2.store.close();
    const s = await DataStore.open(pc2.root);
    const list = await s.listProjects();
    assert.deepEqual(list.map((p) => p.id).sort(), [...ids].sort());
    const first = await s.openProject(ids[0]!);
    assert.equal(first.recovery!.doc.schematic.annotations.at(-1)!.text, 'не сохранено');
    assert.match(readFileSync(path.join(pc2.root, 'library', 'catalog.json'), 'utf8'), /личная деталь/);
    const journal = readFileSync(path.join(pc2.root, 'journal.jsonl'), 'utf8');
    assert.match(journal, /project-create/);
    assert.match(journal, /backup-restore/);
    // продолжить редактирование
    await s.saveProject(addAnnotation(first.doc, { x: 3, y: 3 }, 'после восстановления').doc);
    await s.close();
  });

  test('перед восстановлением делается копия текущих данных, и её можно вернуть', async () => {
    const pc3 = await freshStore('bk3');
    const mine = await pc3.store.createProject('Мой локальный');
    const res = await restoreBackup(pc3.store, await verifyBackup(backup));
    assert.ok(res.safetyBackup && existsSync(res.safetyBackup));
    await pc3.store.close();
    let s = await DataStore.open(pc3.root);
    assert.ok(!(await s.listProjects()).some((p) => p.id === mine.id), 'данные заменены');
    await restoreBackup(s, await verifyBackup(readFileSync(res.safetyBackup!)));
    await s.close();
    s = await DataStore.open(pc3.root);
    assert.deepEqual((await s.listProjects()).map((p) => p.id), [mine.id]);
    await s.close();
  });

  test('повреждённый бэкап отклоняется до изменения данных', async () => {
    const pc4 = await freshStore('bk4');
    const mine = await pc4.store.createProject('Не трогать');
    // Порча данных самого большого файла архива (а не служебного поля вроде времени в заголовке ZIP,
    // которое на содержимое не влияет).
    const broken = Buffer.from(backup);
    let target = { at: -1, size: 0 };
    for (let i = 0; i + 30 < broken.length; i++) {
      if (broken.readUInt32LE(i) !== 0x04034b50) continue;
      const size = broken.readUInt32LE(i + 18), data = i + 30 + broken.readUInt16LE(i + 26) + broken.readUInt16LE(i + 28);
      if (size > target.size) target = { at: data + Math.floor(size / 2), size };
    }
    assert.ok(target.at > 0);
    broken[target.at] = broken[target.at]! ^ 0xff;
    await assert.rejects(verifyBackup(broken), AppError);
    await assert.rejects(verifyBackup(await pc4.store.exportProject(mine)), (e: unknown) => e instanceof AppError && e.code === 'wrong-format');
    assert.deepEqual((await pc4.store.listProjects()).map((p) => p.id), [mine.id]);
    await pc4.store.close();
  });

  test('прерванная замена папок исправляется при следующем запуске', async () => {
    const pc5 = await freshStore('bk5');
    const mine = await pc5.store.createProject('Сбой при восстановлении');
    await pc5.store.close();
    // Имитация: папка projects уже перенесена в .restore-old-*, новые данные не переложены, маркера нет.
    const old = path.join(pc5.root, '.restore-old-test');
    await fs.mkdir(old);
    await fs.rename(path.join(pc5.root, 'projects'), path.join(old, 'projects'));
    await fs.mkdir(path.join(pc5.root, '.restore-staging-test'));
    const s = await DataStore.open(pc5.root);
    assert.match(s.restoreRecovered ?? '', /отменено/);
    assert.deepEqual((await s.listProjects()).map((p) => p.id), [mine.id]);
    assert.ok(!existsSync(old));
    await s.close();
  });

  after(async () => pc1.store.close());
});

test('вторая копия программы на той же папке данных блокируется', async () => {
  const { root, store } = await freshStore('lock');
  // Признак сеанса с PID живого процесса на этом же компьютере
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)']);
  const lock = JSON.parse(readFileSync(path.join(root, 'session.lock'), 'utf8'));
  await fs.writeFile(path.join(root, 'session.lock'), JSON.stringify({ ...lock, pid: child.pid }));
  await assert.rejects(DataStore.open(root), (e: unknown) => e instanceof AppError && e.code === 'locked');
  child.kill();
  await store.close().catch(() => undefined);
});

test('переименование из списка меняет и рабочую копию', async () => {
  const { store } = await freshStore();
  const d = await store.createProject('Старое');
  await store.autosave(renameProject(addAnnotation(d, { x: 0, y: 0 }).doc, 'Старое'));
  await store.renameProject(d.id, 'Новое');
  const o = await store.openProject(d.id);
  assert.equal(o.doc.name, 'Новое');
  assert.equal(o.recovery!.doc.name, 'Новое');
  await store.close();
});

test('кириллица и пробелы в пути к папке данных (например, D:\\Программы\\Электронная лаборатория)', async () => {
  const t = await tempDir('elab-cyr-');
  cleanups.push(t.cleanup);
  const root = path.join(t.dir, 'Мои документы', 'Электронная лаборатория', 'data');
  let s = await DataStore.open(root);
  const d = await s.createProject('Проект «Ёлка» №1');
  await s.saveProject(addAnnotation(d, { x: 0, y: 0 }, 'кириллица').doc);
  const bak = (await createBackup(s)).buffer;
  const exported = await s.exportProject((await s.openProject(d.id)).doc);
  await s.close();
  s = await DataStore.open(root);
  assert.equal((await s.openProject(d.id)).doc.schematic.annotations[0]!.text, 'кириллица');
  const other = path.join(t.dir, 'Флешка', 'Резерв');
  const s2 = await DataStore.open(other);
  await restoreBackup(s2, await verifyBackup(bak));
  await s2.close();
  const s3 = await DataStore.open(other);
  assert.equal((await s3.listProjects())[0]!.name, 'Проект «Ёлка» №1');
  await s3.close();
  assert.equal((await s.previewImport(exported)).existing?.id, d.id);
  await s.close();
});

describe('Личный каталог в хранилище', () => {
  test('сохранить, изменить, удалить деталь; каталог переживает перезапуск и входит в бэкап', async () => {
    const { builtinCatalog } = await import('../../src/catalog/builtin');
    const ne = builtinCatalog().find((b) => b.part.partNumber === 'NE555')!;
    const { root, store } = await freshStore('cat');
    const mine = structuredClone(ne);
    mine.part.id = newId();
    mine.part.name = 'NE555 из моей коробки';
    const saved = await store.saveCatalogPart(mine, builtinCatalog());
    assert.equal(saved.part.origin.catalogPartId, mine.part.id);
    // дубль внутри личного каталога — ошибка
    const dup = structuredClone(mine);
    dup.part.id = newId();
    await assert.rejects(store.saveCatalogPart(dup, builtinCatalog()), (e: unknown) => e instanceof AppError && e.code === 'part-invalid');
    await store.close();
    const again = await DataStore.open(root);
    assert.equal((await again.readCatalog()).parts[0]!.name, 'NE555 из моей коробки');
    const bk = await createBackup(again);
    const other = await freshStore('cat2');
    await restoreBackup(other.store, await verifyBackup(bk.buffer));
    await other.store.close();
    const s2 = await DataStore.open(other.root);
    assert.equal((await s2.readCatalog()).parts.length, 1, 'каталог перенесён бэкапом');
    await s2.close();
    await again.deleteCatalogPart(mine.part.id);
    assert.equal((await again.readCatalog()).parts.length, 0);
    await again.close();
  });

  test('деталь из полученного проекта добавляется в каталог; повреждённый каталог не перезаписывается', async () => {
    const { builtinCatalog } = await import('../../src/catalog/builtin');
    const { placeBundle } = await import('../../src/core/schematic');
    const { createProject } = await import('../../src/core/factory');
    const lm = builtinCatalog().find((b) => b.part.partNumber === 'LM358')!;
    const custom = structuredClone(lm);
    custom.part.id = newId(); custom.part.partNumber = 'LM358-МОЙ'; custom.part.name = 'Мой ОУ';
    custom.part.origin = { ...custom.part.origin, catalogPartId: custom.part.id }; // как в личном каталоге другого ПК
    const doc = placeBundle(createProject('С другого ПК'), custom, { x: 0, y: 0 }).doc;
    const { root, store } = await freshStore('cat3');
    const added = await store.addProjectPartToCatalog(doc, doc.library.parts[0]!.id, builtinCatalog());
    assert.equal(added.part.name, 'Мой ОУ');
    assert.match(added.part.origin.notes, /Добавлена из проекта/);
    assert.notEqual(added.part.id, doc.library.parts[0]!.id);
    assert.equal(added.part.id, custom.part.id, 'каталожный id с другого ПК сохранён');
    const again = placeBundle(doc, added, { x: 100, y: 0 }).doc;
    assert.equal(again.library.parts.length, 1, 'повторное размещение использует копию в проекте');
    await assert.rejects(store.addProjectPartToCatalog(doc, doc.library.parts[0]!.id, builtinCatalog()),
      (e: unknown) => e instanceof AppError && e.code === 'part-invalid' && (e.details ?? []).some((d) => /уже есть в каталоге/.test(d)), 'дубликат не добавляется');
    const file = path.join(root, 'library', 'catalog.json');
    await fs.writeFile(file, '{ сломано');
    await assert.rejects(store.readCatalog(), (e: unknown) => e instanceof AppError && e.code === 'catalog-invalid');
    await assert.rejects(store.saveCatalogPart(added, builtinCatalog()), AppError);
    assert.equal(readFileSync(file, 'utf8'), '{ сломано', 'повреждённый файл не перезаписан');
    await store.close();
  });
});
