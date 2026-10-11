/**
 * Браузерная демо-версия: реализация window.elab поверх хранилища браузера (localStorage).
 * Проекты, контрольные версии и мой каталог живут только в этом браузере. Расчёт ngspice, работа с
 * файлами, импорт из KiCad и печать доступны только в программе для ПК — здесь они честно отвечают
 * «недоступно в браузере», ничего не изображая.
 */
import { builtinCatalog } from '../catalog/builtin';
import { bundleOf, emptyCatalog, lintBundle, removePart, upsertBundle, type CatalogFile, type PartBundle } from '../core/catalog';
import { createProject, normalizeName, renameProject, touch } from '../core/factory';
import { newId } from '../core/ids';
import { loadDocument } from '../core/migrations';
import type { CheckpointInfo, ProjectDoc } from '../core/model';
import { remapIds } from '../core/remap';
import { fail, ok, type Result } from '../core/result';
import { connectPins, placeBundle } from '../core/schematic';
import { APP_VERSION } from '../core/appinfo';
import type { ElabApi, ProjectSummary, SimResult } from '../shared/api';
import { analysesFor, buildNetlist } from '../sim/netlist';

const P = 'elab-web/';
const mem = new Map<string, string>();
function get(key: string): string | null {
  try { return localStorage.getItem(P + key); } catch { return mem.get(key) ?? null; }
}
function set(key: string, value: string) {
  try { localStorage.setItem(P + key, value); } catch { mem.set(key, value); }
}
function del(key: string) {
  try { localStorage.removeItem(P + key); } catch { mem.delete(key); }
}
const json = <T>(key: string, def: T): T => { try { const s = get(key); return s ? (JSON.parse(s) as T) : def; } catch { return def; } };

interface Stored { doc: ProjectDoc; autosave: { doc: ProjectDoc; at: string } | null }
interface StoredCp extends CheckpointInfo { doc: ProjectDoc }

const ids = () => json<string[]>('projects', []);
const setIds = (v: string[]) => set('projects', JSON.stringify(v));
const readProject = (id: string): Stored | null => json<Stored | null>(`p/${id}`, null);
const writeProject = (s: Stored) => set(`p/${s.doc.id}`, JSON.stringify(s));
const cps = (id: string) => json<StoredCp[]>(`cp/${id}`, []);
const setCps = (id: string, v: StoredCp[]) => set(`cp/${id}`, JSON.stringify(v.slice(-30)));

const NOT_HERE = 'В браузерной демо-версии это недоступно: работа с файлами, печать, импорт из KiCad и расчёт ngspice есть в программе для ПК (Windows).';
const noWeb = <T>() => Promise.resolve(fail<T>('web-demo', NOT_HERE));

function summary(s: Stored): ProjectSummary {
  return { id: s.doc.id, name: s.doc.name, updatedAt: s.doc.updatedAt, revision: s.doc.revision, hasRecovery: Boolean(s.autosave), recoveryAt: s.autosave?.at ?? null, error: null };
}

function checked(doc: ProjectDoc): Result<ProjectDoc> {
  const r = loadDocument(doc);
  if (!r.ok) return fail('invalid', r.error.message);
  return ok(r.doc);
}

function addProject(doc: ProjectDoc) {
  writeProject({ doc, autosave: null });
  setIds([...ids().filter((x) => x !== doc.id), doc.id]);
}

/** Примеры, чтобы было что открыть сразу. Собираются теми же операциями редактора. */
function seed() {
  if (get('seeded')) return;
  set('seeded', '1');
  const cat = builtinCatalog();
  const byName = (n: string) => cat.find((b) => b.part.name === n || b.part.partNumber === n)!;
  const build = (name: string, description: string, parts: Array<[string, number, number]>, wires: Array<[number, string, number, string]>) => {
    let doc = { ...createProject(name), description };
    const inst: string[] = [];
    for (const [n, x, y] of parts) { const r = placeBundle(doc, byName(n), { x, y }); doc = r.doc; inst.push(r.id); }
    for (const [a, pa, b, pb] of wires) {
      const r = connectPins(doc, { instanceId: inst[a]!, pin: pa }, { instanceId: inst[b]!, pin: pb });
      if (!r.error) doc = r.doc;
    }
    return { doc, inst };
  };
  const rc = build('Пример: RC-фильтр', 'Фильтр нижних частот 10 кОм / 100 нФ, частота среза ≈ 159 Гц.',
    [['Источник синусоидального напряжения', 100, 200], ['Резистор', 260, 100], ['Конденсатор неполярный', 420, 200], ['Земля (общий провод)', 100, 340]],
    [[0, '+', 1, '1'], [1, '2', 2, '1'], [2, '2', 3, '1'], [0, '-', 3, '1']]);
  rc.doc = { ...rc.doc, simulation: { ...rc.doc.simulation, analysis: 'ac' } };
  addProject(rc.doc);
  const led = build('Пример: светодиод', 'Светодиод от 5 В через резистор 330 Ом.',
    [['Источник постоянного напряжения', 100, 200], ['Резистор', 260, 100], ['Светодиод 5 мм красный', 420, 200], ['Земля (общий провод)', 100, 340]],
    [[0, '+', 1, '1'], [1, '2', 2, '2'], [2, '1', 3, '1'], [0, '-', 3, '1']]);
  const r = led.doc.schematic.instances.find((i) => i.id === led.inst[1])!;
  led.doc = { ...led.doc, schematic: { ...led.doc.schematic, instances: led.doc.schematic.instances.map((i) => (i.id === r.id ? { ...i, values: { resistance: { value: 330, unit: 'Ω' } } } : i)) } };
  addProject(led.doc);
}

export function webApi(): ElabApi {
  seed();
  const catalog = (): CatalogFile => json<CatalogFile>('catalog', emptyCatalog());
  const setCatalog = (c: CatalogFile) => set('catalog', JSON.stringify(c));
  const bundles = (c: CatalogFile): PartBundle[] => c.parts.map((p) => bundleOf(c, p.id)).filter((b): b is PartBundle => b !== null);
  const builtin = builtinCatalog();

  const saveBundle = (b: PartBundle): Result<PartBundle> => {
    const c = catalog();
    const errors = lintBundle(b, c.parts, builtin.map((x) => x.part)).filter((l) => l.severity === 'error');
    if (errors.length) return fail('part-invalid', 'Деталь не сохранена: есть ошибки', errors.map((e) => e.message));
    setCatalog(upsertBundle(c, b));
    return ok(b);
  };

  return {
    app: {
      info: async () => ok({ version: APP_VERSION, dataRoot: 'хранилище этого браузера', portable: false, crashedLastSession: false, restoreRecovered: null, platform: 'web', ngspice: 'web' }),
      setDirty: async () => ok(undefined),
      closeConfirmed: async () => ok(undefined),
      onCloseRequest: () => () => undefined,
      openExternal: async (url) => {
        if (!/^https?:\/\/\S+$/i.test(url)) return fail('bad-url', 'Ссылка должна начинаться с http:// или https://');
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        a.click();
        return ok(undefined);
      },
    },
    projects: {
      list: async () => ok(ids().map(readProject).filter((s): s is Stored => s !== null).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
      create: async (name) => {
        const n = normalizeName(name);
        if (!n) return fail('bad-name', 'Введите название проекта');
        const doc = createProject(n);
        addProject(doc);
        return ok(doc);
      },
      open: async (id) => {
        const s = readProject(id);
        if (!s) return fail('not-found', 'Проект не найден');
        const d = checked(s.doc);
        if (!d.ok) return d;
        const rec = s.autosave ? checked(s.autosave.doc) : null;
        return ok({ doc: d.value, recovery: rec?.ok ? { doc: rec.value, autosavedAt: s.autosave!.at } : null, recoveryError: rec && !rec.ok ? rec.error.message : null });
      },
      save: async (doc) => {
        const d = checked(doc);
        if (!d.ok) return d;
        writeProject({ doc: d.value, autosave: null });
        const now = new Date().toISOString();
        setCps(doc.id, [...cps(doc.id), { id: newId(), label: `Сохранение ${new Date().toLocaleString('ru-RU')}`, kind: 'on-save', createdAt: now, revision: doc.revision, doc: d.value }]);
        return ok({ savedAt: now, revision: doc.revision });
      },
      autosave: async (doc) => {
        const s = readProject(doc.id);
        if (!s) return fail('not-found', 'Проект не найден');
        const at = new Date().toISOString();
        writeProject({ ...s, autosave: { doc, at } });
        return ok({ autosavedAt: at });
      },
      discardRecovery: async (id) => { const s = readProject(id); if (s) writeProject({ ...s, autosave: null }); return ok(undefined); },
      rename: async (id, name) => {
        const s = readProject(id);
        if (!s) return fail('not-found', 'Проект не найден');
        const doc = renameProject(s.doc, name);
        writeProject({ doc, autosave: s.autosave ? { ...s.autosave, doc: renameProject(s.autosave.doc, name) } : null });
        return ok(summary({ doc, autosave: s.autosave }));
      },
      duplicate: async (id, name) => {
        const s = readProject(id);
        if (!s) return fail('not-found', 'Проект не найден');
        const doc = touch({ ...remapIds(s.doc).doc, name: normalizeName(name ?? `${s.doc.name} (копия)`), revision: 0 });
        addProject(doc);
        return ok(doc);
      },
      saveAs: async (doc, name) => {
        const copy = touch({ ...remapIds(doc).doc, name: normalizeName(name), revision: 0 });
        addProject(copy);
        return ok(copy);
      },
      remove: async (id) => { del(`p/${id}`); del(`cp/${id}`); setIds(ids().filter((x) => x !== id)); return ok(undefined); },
    },
    checkpoints: {
      list: async (id) => ok(cps(id).map(({ doc: _d, ...info }) => info).reverse()),
      create: async (doc, label) => {
        const cp: StoredCp = { id: newId(), label: label.trim() || 'Контрольная версия', kind: 'manual', createdAt: new Date().toISOString(), revision: doc.revision, doc };
        setCps(doc.id, [...cps(doc.id), cp]);
        const { doc: _d, ...info } = cp;
        return ok(info);
      },
      restore: async (current, cpId) => {
        const list = cps(current.id);
        const cp = list.find((c) => c.id === cpId);
        if (!cp) return fail('not-found', 'Контрольная версия не найдена');
        setCps(current.id, [...list, { id: newId(), label: 'Перед возвратом', kind: 'before-restore', createdAt: new Date().toISOString(), revision: current.revision, doc: current }]);
        return ok({ ...cp.doc, revision: current.revision + 1 });
      },
    },
    catalog: {
      list: async () => ok(bundles(catalog())),
      save: async (b) => saveBundle(b),
      remove: async (id) => { setCatalog(removePart(catalog(), id)); return ok(undefined); },
      fromProject: async (doc, partId) => {
        const b = bundleOf(doc.library, partId);
        if (!b) return fail('not-found', 'Деталь не найдена в проекте');
        const pkgIds = new Map(b.packages.map((p) => [p.id, newId()]));
        const id = newId(), symbolId = newId(), modelId = b.model ? newId() : null;
        return saveBundle({
          part: { ...b.part, id, symbolId, modelId, packages: b.part.packages.map((p) => ({ packageId: pkgIds.get(p.packageId)!, pinMap: p.pinMap })), origin: { ...b.part.origin, catalogPartId: id } },
          symbol: { ...b.symbol, id: symbolId },
          packages: b.packages.map((p) => ({ ...p, id: pkgIds.get(p.id)! })),
          model: b.model && modelId ? { ...b.model, id: modelId } : null,
        });
      },
    },
    kicad: { openOnline: noWeb, openFile: noWeb, describe: noWeb, build: noWeb },
    sim: {
      // ngspice в браузере не запускается. Проверки схемы (netlist) работают — их и показываем.
      run: async (doc, opts) => {
        const analysis = opts.analysis ?? doc.simulation.analysis;
        const nl = buildNetlist(doc, analysesFor(doc, analysis), doc.name);
        const blocked = nl.issues.some((i) => i.severity === 'error');
        const res: SimResult = {
          status: blocked ? 'blocked' : 'failed', analysis, revision: doc.revision, issues: nl.issues,
          error: blocked ? null : { code: 'web-demo', message: 'Схема прошла проверки, но расчёт в браузерной демо-версии не выполняется: симулятор ngspice работает только в программе для ПК. Netlist для ngspice — ниже.', details: [] },
          op: null, tran: null, dc: null, ac: null, sweep: null, limits: [], engine: { name: 'ngspice', version: null }, netlist: nl.text, warnings: [], durationMs: 0,
        };
        return ok(res);
      },
      measure: async (_doc, req) => ok({
        kind: req.kind, status: 'failed', display: '—', value: null, beep: false, method: '', esr: null, netlist: '',
        message: 'В браузерной демо-версии измерения не выполняются: прибор считает схему через ngspice, который работает только в программе для ПК.',
      }),
    },
    files: {
      exportProject: noWeb, importProject: noWeb, resolveImport: noWeb, backupAll: noWeb, restoreBackup: noWeb,
      saveSvg: noWeb, saveDrawing: noWeb, savePdf: noWeb, saveGerber: noWeb,
      print: async () => ok({ printed: false, reason: NOT_HERE }),
    },
  };
}
