import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { APP_VERSION } from '../../src/core/appinfo';
import { addAnnotation, createProject, removeAnnotation, renameProject, updateAnnotation } from '../../src/core/factory';
import { canRedo, canUndo, initHistory, pushState, redo, undo } from '../../src/core/history';
import { isUuid, newId } from '../../src/core/ids';
import { checkIntegrity } from '../../src/core/integrity';
import { loadDocument } from '../../src/core/migrations';
import { CURRENT_SCHEMA_VERSION, type Net } from '../../src/core/model';
import { remapDocs, remapIds } from '../../src/core/remap';
import { linkSignature, makeRichDoc } from '../helpers';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

describe('UUID', () => {
  test('новые ID уникальны и корректны', () => {
    const ids = new Set(Array.from({ length: 2000 }, newId));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.ok(isUuid(id));
  });
});

describe('Документ проекта', () => {
  test('новый проект проходит проверку структуры и целостности', () => {
    const r = loadDocument(createProject('Тест'));
    assert.ok(r.ok);
    assert.equal(r.doc.name, 'Тест');
    assert.equal(r.doc.changelog.length, 1);
  });

  test('насыщенный документ со всеми видами связей целостен', () => {
    assert.deepEqual(checkIntegrity(makeRichDoc()), []);
  });

  test('пустое имя заменяется на «Без названия», пробелы схлопываются', () => {
    assert.equal(createProject('   ').name, 'Без названия');
    assert.equal(createProject('  Мой   проект ').name, 'Мой проект');
  });

  test('изменения увеличивают ревизию, пустые изменения не создают новый документ', () => {
    const d0 = createProject('А');
    const { doc: d1, id } = addAnnotation(d0, { x: 1.234, y: 2 });
    assert.equal(d1.revision, d0.revision + 1);
    assert.deepEqual(d1.schematic.annotations[0]!.position, { x: 1.23, y: 2 });
    assert.equal(updateAnnotation(d1, id, { text: 'Заметка' }), d1);
    const d2 = updateAnnotation(d1, id, { text: 'Новый текст' });
    assert.equal(d2.revision, d1.revision + 1);
    const d3 = removeAnnotation(d2, id);
    assert.equal(d3.schematic.annotations.length, 0);
    assert.equal(renameProject(d3, 'А'), d3);
    assert.equal(renameProject(d3, 'Б').changelog.at(-1)!.action, 'rename');
  });
});

describe('Проверка целостности', () => {
  test('повторяющиеся ID обнаруживаются', () => {
    const doc = makeRichDoc();
    doc.schematic.annotations.push({ ...doc.schematic.annotations[0]! });
    const issues = checkIntegrity(doc);
    assert.ok(issues.some((i) => i.code === 'duplicate-id'));
  });

  test('висячие ссылки, неизвестные выводы, повтор обозначений и вывод в двух сетях', () => {
    const doc = makeRichDoc();
    doc.schematic.instances[0]!.partId = newId();
    doc.schematic.nets[0]!.connections.push({ instanceId: doc.schematic.instances[1]!.id, pin: '9' });
    doc.schematic.instances[1]!.refDes = 'R1';
    doc.schematic.nets[2]!.connections.push({ instanceId: doc.schematic.instances[1]!.id, pin: '1' });
    const codes = new Set(checkIntegrity(doc).map((i) => i.code));
    for (const c of ['dangling-ref', 'unknown-pin', 'duplicate-refdes', 'pin-in-several-nets']) assert.ok(codes.has(c as never), c);
  });

  test('ошибки соответствия «вывод символа ↔ площадка»', () => {
    const doc = makeRichDoc();
    doc.library.parts[0]!.packages[0]!.pinMap = [{ symbolPin: '1', pad: '1' }, { symbolPin: '1', pad: '7' }];
    const codes = checkIntegrity(doc).map((i) => i.code);
    assert.ok(codes.includes('duplicate-pin-map'));
    assert.ok(codes.includes('unknown-pin'));
  });

  test('размещение с корпусом, которого нет у детали, — ошибка', () => {
    const doc = makeRichDoc();
    doc.pcb.placements[0]!.packageId = newId();
    assert.ok(checkIntegrity(doc).some((i) => i.code === 'dangling-ref'));
  });
});

describe('Загрузка и миграции', () => {
  test('миграция версии 0 → текущая сохраняет ID и заметки', () => {
    const v0 = fixture('project-v0.json');
    const r = loadDocument(v0);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.equal(r.migratedFrom, 0);
    assert.equal(r.doc.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(r.doc.id, v0.id);
    assert.equal(r.doc.name, v0.title);
    assert.deepEqual(r.doc.schematic.annotations.map((a) => [a.id, a.text, a.position]), v0.notes.map((n: { id: string; text: string; x: number; y: number }) => [n.id, n.text, { x: n.x, y: n.y }]));
    assert.deepEqual(v0.version, 0, 'исходные данные не изменены');
  });

  test('миграция v1 → v2: связи сохранены, концы проводов и дорожек — null, площадки получили координаты', () => {
    const v1 = fixture('project-v1.json');
    const r = loadDocument(v1);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.equal(r.migratedFrom, 1);
    assert.deepEqual(r.doc.schematic.wires.filter((w) => w.a.kind === 'free').map((w) => [w.a.kind, w.b.kind]), [['free', 'free']], 'провод v1 без концов — графика со свободными концами');
    assert.deepEqual(r.doc.pcb.tracks.map((t) => [t.from, t.to]), [[null, null]]);
    const axial = r.doc.library.packages.find((p) => p.name.startsWith('Выводной'))!;
    assert.deepEqual(axial.pads.map((p) => [p.number, p.x, p.y, p.drill]), [['A', 0, 0, 0.9], ['B', 2.54, 0, 0.9]]);
    assert.deepEqual(r.doc.simulation, { tran: { stopS: 0.01, stepS: 1e-5, startFromZero: true } });
    const sig = linkSignature(r.doc) as Record<string, unknown>;
    assert.equal((sig.nets as unknown[]).length, 3);
    assert.deepEqual(r.doc.schematic.nets, v1.schematic.nets);
  });

  test('файл более новой версии не открывается', () => {
    const r = loadDocument(fixture('project-future-version.json'));
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'newer-version');
  });

  test('файл с повторяющимися ID не загружается', () => {
    const r = loadDocument(fixture('project-duplicate-ids.json'));
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'integrity');
  });

  test('неверная структура и не-проект отклоняются с понятной ошибкой', () => {
    const bad = { ...createProject('x'), revision: -1 };
    const r = loadDocument(bad);
    assert.ok(!r.ok && r.error.code === 'invalid-structure');
    const r2 = loadDocument({ hello: 'world' });
    assert.ok(!r2.ok && r2.error.code === 'not-a-project');
    const r3 = loadDocument({ ...createProject('x'), extra: 1 });
    assert.ok(!r3.ok && r3.error.code === 'invalid-structure', 'неизвестные поля не принимаются молча');
  });
});

describe('Переназначение ID', () => {
  test('все ID новые, связи выводов, сетей и корпусов сохранены, ссылки на каталог не тронуты', () => {
    const doc = makeRichDoc();
    const { doc: copy, map } = remapIds(doc);
    assert.deepEqual(checkIntegrity(copy), []);
    assert.deepEqual(linkSignature(copy), linkSignature(doc));
    assert.notEqual(copy.id, doc.id);
    const oldIds = new Set(map.keys());
    const json = JSON.stringify(copy);
    for (const id of oldIds) assert.ok(!json.includes(id), `старый ID ${id} остался`);
  });

  test('проект и его контрольные версии переназначаются одной таблицей', () => {
    const doc = makeRichDoc();
    const older = { ...doc, name: 'старая' };
    const { docs } = remapDocs([doc, older]);
    assert.equal(docs[0]!.id, docs[1]!.id);
    assert.equal(docs[0]!.schematic.instances[0]!.id, docs[1]!.schematic.instances[0]!.id);
  });
});

describe('История Undo/Redo', () => {
  test('отмена и повтор с подписями действий', () => {
    let h = initHistory(0);
    h = pushState(h, 1, 'первое');
    h = pushState(h, 2, 'второе');
    assert.equal(h.presentLabel, 'второе');
    h = undo(h);
    assert.equal(h.present, 1);
    assert.equal(h.future[0]!.label, 'второе');
    h = redo(h);
    assert.equal(h.present, 2);
    h = undo(undo(h));
    assert.equal(h.present, 0);
    assert.ok(!canUndo(h));
    h = pushState(h, 5, 'ветка');
    assert.ok(!canRedo(h), 'новое действие после отмены сбрасывает повтор');
  });

  test('история ограничена', () => {
    let h = initHistory(0);
    for (let i = 1; i <= 50; i++) h = pushState(h, i, `ш${i}`, 10);
    assert.equal(h.past.length, 10);
  });
});

test('версия в appinfo совпадает с package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});

describe('Миграция v2 → v3 (сведения каталога)', () => {
  test('файл v2 открывается: связи целы, новые поля заполнены нейтрально, ничего не придумано', () => {
    const raw = fixture('project-v2.json');
    const r = loadDocument(raw);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.equal(r.migratedFrom, 2);
    assert.equal(r.doc.schemaVersion, CURRENT_SCHEMA_VERSION);
    const part = r.doc.library.parts[0]!;
    assert.equal(part.refPrefix, 'R');
    assert.equal(part.origin.verified, false, 'старые сведения не считаются проверенными');
    assert.equal(part.datasheetUrl, null);
    assert.deepEqual(part.values, {});
    assert.equal(r.doc.library.packages.find((p) => p.name === '0805')!.mount, 'SMD');
    assert.equal(r.doc.library.packages.find((p) => p.name.startsWith('Выводной'))!.mount, 'THT');
    assert.equal(r.doc.library.symbols[0]!.pins[0]!.description, '');
    assert.equal(r.doc.schematic.nets.length, raw.schematic.nets.length);
  });
});

describe('Миграция v3 → v4 (граф связности)', () => {
  test('RC-цепь v3: провода стали рёбрами графа, сети и их UUID те же, меток не добавлено', () => {
    const raw = fixture('project-v3-rc.json');
    const r = loadDocument(raw);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.equal(r.migratedFrom, 3);
    assert.equal(r.doc.schematic.labels.length, 0);
    assert.equal(r.doc.schematic.wires.length, raw.schematic.wires.length);
    assert.ok(r.doc.schematic.wires.every((w) => w.a.kind === 'pin' && w.b.kind === 'pin' && !w.manual));
    const sorted = (nets: Array<{ id: string; name: string | null; connections: Array<{ instanceId: string; pin: string }> }>) =>
      nets.map((n) => ({ id: n.id, name: n.name, pins: n.connections.map((c) => `${c.instanceId}#${c.pin}`).sort() })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(sorted(r.doc.schematic.nets), sorted(raw.schematic.nets));
    assert.deepEqual(r.doc.schematic.sheet, { size: 'A4', orientation: 'landscape', frame: true, author: '' });
  });

  test('сети v3 без проводов и с именами сохраняются метками; UUID и состав сетей не меняются', () => {
    const raw = fixture('project-v3.json');
    const r = loadDocument(raw);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.deepEqual(r.doc.schematic.labels.map((l) => l.name).sort(), ['GND', 'IN', 'OUT']);
    const docNets: Net[] = r.doc.schematic.nets;
    for (const n of raw.schematic.nets as Net[]) {
      const m: Net = docNets.find((x) => x.id === n.id)!;
      assert.equal(m.name, n.name);
      assert.deepEqual(m.connections.map((c) => c.pin).sort(), n.connections.map((c) => c.pin).sort());
    }
    assert.deepEqual(r.doc.pcb.tracks.map((t) => t.netId), raw.pcb.tracks.map((t: { netId: string }) => t.netId), 'дорожки по-прежнему ссылаются на те же сети');
  });
});
