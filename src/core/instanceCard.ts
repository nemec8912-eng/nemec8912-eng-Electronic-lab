/**
 * Карточка детали на схеме (двойной щелчок): характеристики конкретного экземпляра.
 *
 * Номиналы (сопротивление, ёмкость…) — у экземпляра. Маркировка, пределы, допуск, модель, корпус и
 * назначение выводов — у детали проекта; если этой деталью пользуются и другие экземпляры, перед правкой
 * она копируется («ответвляется»), чтобы изменения касались только выбранного. Общий каталог не меняется.
 * Всё — одна правка документа (Ctrl+Z отменяет целиком).
 *
 * Программа не придумывает распиновку: у шаблона транзистора в TO-92 выводы не назначены, пока их не
 * назначит пользователь или не возьмёт деталь из справочника по маркировке.
 */
import type { PartBundle } from './catalog';
import { logChange, touch } from './factory';
import { newId } from './ids';
import { formatQuantity, modelParams, PARAMS, paramInRange, parseQuantity, RATINGS } from './library';
import type { PartDef, ProjectDoc, Quantity } from './model';
import { renameRefDes, symbolOf } from './schematic';
import { standardSymbol } from './symbols';
import * as STD from './stdModels';

/** Какие пределы спрашивать у детали этой категории (ключи RATINGS). */
export const CARD_RATINGS: Record<string, string[]> = {
  resistor: ['power'], capacitor: ['voltage'], 'capacitor-polar': ['voltage'], inductor: ['current'],
  diode: ['reverseVoltage', 'current'], led: ['current', 'reverseVoltage'], zener: ['power'],
  bjt: ['vce', 'current', 'power'], mosfet: ['vds', 'current'], thyristor: ['reverseVoltage', 'current'], triac: ['voltage', 'current'],
  fuse: ['current', 'voltage'], varistor: ['voltage'], relay: ['voltage', 'current'], switch: ['current'], potentiometer: ['power'],
};
/** Есть ли у категории «маркировка/модель» (у пассивных номинал важнее маркировки). */
export const HAS_MARKING = (category: string) => !['resistor', 'capacitor', 'capacitor-polar', 'inductor', 'reference', 'source'].includes(category);
/** Вид обозначения, который можно сменить без перестройки выводов. */
export const GRAPHIC_CHOICES: Record<string, Array<{ graphic: string; label: string }>> = {
  bjt: [{ graphic: 'npn', label: 'n-p-n' }, { graphic: 'pnp', label: 'p-n-p' }],
  mosfet: [{ graphic: 'nmos', label: 'n-канальный' }, { graphic: 'pmos', label: 'p-канальный' }],
};

export interface CardDraft {
  refDes: string;
  /** Номиналы экземпляра: ключ PARAMS → значение в единицах СИ. */
  values: Record<string, number>;
  /** Пределы детали: ключ RATINGS → значение или null (не задано). */
  ratings: Record<string, number | null>;
  tolerancePct: number | null;
  name: string;
  marking: string;
  partNumber: string;
  graphic: string | null;
  /** Модель: оставить, убрать или взять из детали справочника (id детали в каталоге). */
  model: { kind: 'keep' } | { kind: 'none' } | { kind: 'catalog'; partId: string };
  /** Корпус: оставить, выбрать другой из корпусов детали или вариант-шаблон (id детали-шаблона в каталоге). */
  pkg: { kind: 'keep' } | { kind: 'own'; packageId: string } | { kind: 'template'; partId: string };
  /** Назначение выводов для текущего (выбранного) корпуса: вывод символа → площадка; null — не менять. */
  pinMap: Array<{ symbolPin: string; pad: string }> | null;
  /** Взять из детали справочника назначение выводов (если корпус совпадает) вместе с моделью. */
  takePinout: boolean;
}

export function draftOf(doc: ProjectDoc, instId: string): CardDraft | null {
  const inst = doc.schematic.instances.find((i) => i.id === instId);
  const part = inst ? doc.library.parts.find((p) => p.id === inst.partId) : undefined;
  if (!inst || !part) return null;
  const sym = symbolOf(doc, inst);
  const ratings: Record<string, number | null> = {};
  for (const k of CARD_RATINGS[part.category] ?? []) ratings[k] = part.ratings[k]?.value ?? null;
  return {
    refDes: inst.refDes,
    values: Object.fromEntries(Object.entries(inst.values).map(([k, q]) => [k, q.value])),
    ratings, tolerancePct: part.tolerancePct, name: part.name, marking: part.marking ?? '', partNumber: part.partNumber ?? '',
    graphic: GRAPHIC_CHOICES[part.category] ? sym?.graphic ?? null : null,
    model: { kind: 'keep' }, pkg: { kind: 'keep' }, pinMap: null, takePinout: false,
  };
}

/** Разбор номинала с проверкой диапазона; сообщение — по-русски. */
export function parseValue(key: string, text: string): { value: number | null; error: string | null } {
  const def = PARAMS[key];
  if (!def) return { value: null, error: 'Неизвестный параметр' };
  const t = text.trim();
  if (!t) return { value: null, error: `${def.label}: введите значение` };
  const v = parseQuantity(t, def.unitRu);
  if (v === null) return { value: null, error: `${def.label}: не понял «${t}». Примеры: ${EXAMPLES[def.unit] ?? '10, 4,7, 1к'}` };
  if (!paramInRange(key, v)) return { value: null, error: `${def.label}: допустимо ${def.signed ? `от ${formatQuantity(def.min, def.unitRu)}` : `больше ${formatQuantity(def.min, def.unitRu)}`} и не более ${formatQuantity(def.max, def.unitRu)}` };
  return { value: v, error: null };
}
const EXAMPLES: Record<string, string> = {
  'Ω': '10 Ом, 4,7 кОм, 4k7, 10k, 1M, 4700', F: '47 мкФ, 47uF, 100nF, 220pF, 0,1 мк', H: '100 мкГн, 10uH, 1 мГн', V: '5 В, 12, 3,3', Hz: '1 кГц, 50, 4 МГц', A: '0,5 А, 100 мА, 1',
};
export function parseRating(key: string, text: string): { value: number | null; error: string | null } {
  const def = RATINGS[key];
  if (!def) return { value: null, error: 'Неизвестный предел' };
  const t = text.trim();
  if (!t) return { value: null, error: null };
  const v = parseQuantity(t, def.unitRu);
  if (v === null || !(v > 0) || v > 1e6) return { value: null, error: `${def.label}: не понял «${t}» — нужно положительное число, например 0,25 или 50` };
  return { value: v, error: null };
}

export interface CardRisk { message: string }

/** Опасные последствия сохранения: смена корпуса или выводов у детали на плате с дорожками, отключение проводов. */
export function cardRisks(doc: ProjectDoc, instId: string, d: CardDraft): CardRisk[] {
  const out: CardRisk[] = [];
  const pl = doc.pcb.placements.find((p) => p.instanceId === instId);
  const tracks = pl ? doc.pcb.tracks.filter((t) => (t.from?.kind === 'pad' && t.from.placementId === pl.id) || (t.to?.kind === 'pad' && t.to.placementId === pl.id)).length : 0;
  if (pl && (d.pkg.kind !== 'keep' || d.pinMap || d.takePinout)) {
    out.push({ message: `Деталь стоит на плате${tracks ? `, к ней подведено дорожек: ${tracks}` : ''}. После смены корпуса или выводов синхронизируйте плату${tracks ? ' — дорожки к этой детали придётся проверить и, возможно, проложить заново' : ''}.` });
  }
  return out;
}

/** Применить карточку. Ошибка — документ не меняется. */
export function applyCard(doc0: ProjectDoc, instId: string, d: CardDraft, catalog: PartBundle[]): { doc: ProjectDoc; error: string | null; warnings: string[] } {
  const inst0 = doc0.schematic.instances.find((i) => i.id === instId);
  const part0 = inst0 ? doc0.library.parts.find((p) => p.id === inst0.partId) : undefined;
  if (!inst0 || !part0) return { doc: doc0, error: 'Деталь не найдена', warnings: [] };
  const warnings: string[] = [];
  const changes: string[] = [];
  let doc = doc0;

  // 1. Обозначение
  if (d.refDes.trim() !== inst0.refDes) {
    const r = renameRefDes(doc, instId, d.refDes);
    if (r.error) return { doc: doc0, error: r.error, warnings };
    doc = r.doc;
    changes.push(`обозначение ${inst0.refDes} → ${d.refDes.trim()}`);
  }

  // 2. Деталь проекта: что меняется
  const ratings: Record<string, Quantity> = { ...part0.ratings };
  for (const [k, v] of Object.entries(d.ratings)) {
    if (v === null) delete ratings[k];
    else ratings[k] = { value: v, unit: RATINGS[k]?.unit ?? '' };
  }
  const trimmed = (s: string) => s.trim().slice(0, 64) || null;
  const nextName = d.name.trim().slice(0, 128) || part0.name;
  const partPatch: Partial<PartDef> = {};
  if (JSON.stringify(ratings) !== JSON.stringify(part0.ratings)) { partPatch.ratings = ratings; changes.push('пределы'); }
  if (d.tolerancePct !== part0.tolerancePct) {
    if (d.tolerancePct !== null && !(d.tolerancePct > 0 && d.tolerancePct <= 50)) return { doc: doc0, error: 'Допуск — от 0 до 50 %', warnings };
    partPatch.tolerancePct = d.tolerancePct; changes.push('допуск');
  }
  if (nextName !== part0.name) { partPatch.name = nextName; changes.push(`название «${nextName}»`); }
  if (trimmed(d.marking) !== part0.marking) { partPatch.marking = trimmed(d.marking); changes.push(`маркировка «${d.marking.trim()}»`); }
  if (trimmed(d.partNumber) !== part0.partNumber) { partPatch.partNumber = trimmed(d.partNumber); changes.push(`модель/партномер «${d.partNumber.trim()}»`); }
  const sym0 = symbolOf(doc0, inst0);
  const graphicChange = !!(d.graphic && sym0 && d.graphic !== sym0.graphic && GRAPHIC_CHOICES[part0.category]?.some((g) => g.graphic === d.graphic));
  const partLevel = Object.keys(partPatch).length > 0 || graphicChange || d.model.kind !== 'keep' || d.pkg.kind !== 'keep' || d.pinMap !== null;

  if (partLevel) {
    // Ответвление: деталью пользуются другие экземпляры — правим копию
    const shared = doc.schematic.instances.some((i) => i.id !== instId && i.partId === part0.id);
    let partId = part0.id;
    if (shared) {
      partId = newId();
      const copy: PartDef = { ...structuredClone(part0), id: partId, origin: { ...part0.origin, catalogPartId: partId } };
      doc = { ...doc, library: { ...doc.library, parts: [...doc.library.parts, copy] }, schematic: { ...doc.schematic, instances: doc.schematic.instances.map((i) => (i.id === instId ? { ...i, partId } : i)) } };
    }
    let lib = doc.library;
    let part = lib.parts.find((p) => p.id === partId)!;
    part = { ...part, ...partPatch };
    // Вид обозначения (n-p-n ↔ p-n-p, n- ↔ p-канальный): новый символ с теми же номерами выводов
    if (graphicChange) {
      const s = { ...standardSymbol(d.graphic!), id: newId() };
      if (sym0 && s.pins.map((p) => p.number).join() !== sym0.pins.map((p) => p.number).join()) return { doc: doc0, error: 'У этого обозначения другие выводы', warnings };
      lib = { ...lib, symbols: [...lib.symbols, s] };
      part = { ...part, symbolId: s.id };
      changes.push(`обозначение ${GRAPHIC_CHOICES[part0.category]!.find((g) => g.graphic === d.graphic)!.label}`);
    }
    // Модель
    let source: PartBundle | undefined;
    if (d.model.kind === 'none' && part.modelId) { part = { ...part, modelId: null }; changes.push('модель убрана'); }
    if (d.model.kind === 'catalog') {
      const partIdC = d.model.partId;
      source = catalog.find((b) => b.part.id === partIdC);
      if (!source?.model) return { doc: doc0, error: 'У выбранной детали справочника нет модели', warnings };
      const m = { ...structuredClone(source.model), id: newId() };
      lib = { ...lib, models: [...lib.models, m] };
      part = { ...part, modelId: m.id };
      changes.push(`модель «${m.name}»${m.verified ? '' : ' (не проверена)'}`);
      if (!m.verified) warnings.push(`Модель «${m.name}» не проверена — результат расчёта приблизительный.`);
    }
    // Корпус
    if (d.pkg.kind === 'own') {
      const pid = d.pkg.packageId;
      const ref = part.packages.find((p) => p.packageId === pid);
      if (!ref) return { doc: doc0, error: 'Корпус не найден у детали', warnings };
      part = { ...part, packages: [ref, ...part.packages.filter((p) => p.packageId !== pid)] };
      changes.push(`корпус «${lib.packages.find((p) => p.id === pid)?.name ?? '?'}»`);
    } else if (d.pkg.kind === 'template') {
      const tplId = d.pkg.partId;
      const tpl = catalog.find((b) => b.part.id === tplId);
      const tpkg = tpl?.packages[0];
      if (!tpl || !tpkg) return { doc: doc0, error: 'Вариант корпуса не найден', warnings };
      const pkg = { ...structuredClone(tpkg), id: newId() };
      const tmap = tpl.part.packages[0]?.pinMap ?? [];
      // Назначение выводов: у пассивных и микросхем — как у шаблона (номер вывода = площадка);
      // у транзисторов — прежнее, если такие площадки есть, иначе не задано.
      const prev = part.packages[0]?.pinMap ?? [];
      const keepPrev = tmap.length === 0 && prev.length > 0 && prev.every((m) => pkg.pads.some((p) => p.number === m.pad));
      const pinMap = tmap.length ? structuredClone(tmap) : keepPrev ? prev : [];
      const symNow = lib.symbols.find((s) => s.id === part.symbolId);
      const symPins = new Set(symNow?.pins.map((p) => p.number) ?? []);
      if (pinMap.some((m) => !symPins.has(m.symbolPin))) return { doc: doc0, error: 'Этот корпус не подходит: выводы шаблона не совпадают с выводами детали', warnings };
      lib = { ...lib, packages: [...lib.packages, pkg] };
      part = { ...part, packages: [{ packageId: pkg.id, pinMap }] };
      changes.push(`корпус «${pkg.name}»`);
      if (!pinMap.length) warnings.push('Выводы нового корпуса не назначены — назначьте их, иначе цепи детали не попадут на плату.');
    }
    // Назначение выводов из справочника (если у детали справочника есть такой же корпус)
    if (d.takePinout && source) {
      const cur = lib.packages.find((p) => p.id === part.packages[0]?.packageId);
      const match = source.packages.find((p) => cur && p.family === cur.family && p.pads.length === cur.pads.length);
      const smap = match ? source.part.packages.find((x) => x.packageId === match.id)?.pinMap : undefined;
      if (cur && smap?.length) {
        part = { ...part, packages: [{ packageId: cur.id, pinMap: structuredClone(smap) }, ...part.packages.slice(1)] };
        changes.push(`выводы по справочнику (${source.part.name})`);
        if (!source.part.origin.verified) warnings.push(`Распиновка «${source.part.name}» в справочнике не сверена с даташитом — проверьте по даташиту своей детали.`);
      } else {
        warnings.push(`В справочнике у «${source.part.name}» нет корпуса «${cur?.name ?? '?'}» — назначьте выводы вручную по даташиту.`);
      }
    }
    // Назначение выводов вручную
    if (d.pinMap) {
      const cur = lib.packages.find((p) => p.id === part.packages[0]?.packageId);
      if (!cur) return { doc: doc0, error: 'У детали нет корпуса — назначать выводы некуда', warnings };
      const symNow = lib.symbols.find((s) => s.id === part.symbolId);
      const pins = symNow?.pins.map((p) => p.number) ?? [];
      const map = d.pinMap.filter((m) => m.pad);
      const pads = map.map((m) => m.pad);
      if (new Set(pads).size !== pads.length) return { doc: doc0, error: 'Одна площадка назначена нескольким выводам', warnings };
      if (map.some((m) => !cur.pads.some((p) => p.number === m.pad) || !pins.includes(m.symbolPin))) return { doc: doc0, error: 'Назначение выводов ссылается на несуществующую площадку', warnings };
      if (map.length > 0 && map.length < pins.length) return { doc: doc0, error: `Назначьте все выводы (${map.length} из ${pins.length}) — или ни одного`, warnings };
      const prev = part.packages[0]!.pinMap;
      if (JSON.stringify(map) !== JSON.stringify(prev)) {
        part = { ...part, packages: [{ ...part.packages[0]!, pinMap: map }, ...part.packages.slice(1)] };
        changes.push('назначение выводов');
      }
    }
    // Подсказка шаблона «назначьте выводы» больше не нужна, когда выводы назначены
    if (part.description.startsWith('Распиновка в этом корпусе') && (part.packages[0]?.pinMap.length ?? 0) > 0) part = { ...part, description: '' };
    lib = { ...lib, parts: lib.parts.map((p) => (p.id === partId ? part : p)) };
    doc = { ...doc, library: lib };
  }

  // Катушка: сопротивление обмотки задано — модель «L + R» (у идеальной катушки сопротивления нет)
  if (part0.category === 'inductor' && d.values.resistance !== undefined && d.values.resistance > 0) {
    const ip = doc.schematic.instances.find((i) => i.id === instId)!;
    let pp = doc.library.parts.find((p) => p.id === ip.partId)!;
    const mm = pp.modelId ? doc.library.models.find((m) => m.id === pp.modelId) : undefined;
    if (!mm || !modelParams(mm).includes('resistance')) {
      if (doc.schematic.instances.some((i) => i.id !== instId && i.partId === pp.id)) {
        const nid = newId();
        pp = { ...structuredClone(pp), id: nid, origin: { ...pp.origin, catalogPartId: nid } };
        doc = { ...doc, library: { ...doc.library, parts: [...doc.library.parts, pp] }, schematic: { ...doc.schematic, instances: doc.schematic.instances.map((i) => (i.id === instId ? { ...i, partId: nid } : i)) } };
      }
      const m = { ...structuredClone(STD.L_WITH_R), id: newId() };
      pp = { ...pp, modelId: m.id };
      doc = { ...doc, library: { ...doc.library, models: [...doc.library.models, m], parts: doc.library.parts.map((p) => (p.id === pp.id ? pp : p)) } };
      changes.push('модель катушки с сопротивлением обмотки');
    }
  }

  // 3. Номиналы экземпляра (по параметрам текущей модели)
  const instNow = doc.schematic.instances.find((i) => i.id === instId)!;
  const partNow = doc.library.parts.find((p) => p.id === instNow.partId)!;
  const modelNow = partNow.modelId ? doc.library.models.find((m) => m.id === partNow.modelId) : undefined;
  const needed = new Set([...modelParams(modelNow), ...Object.keys(instNow.values)]);
  const values: Record<string, Quantity> = {};
  for (const k of needed) {
    const def = PARAMS[k];
    if (!def) continue;
    const v = d.values[k] ?? instNow.values[k]?.value ?? partNow.values[k]?.value;
    if (v === undefined) continue;
    if (!paramInRange(k, v)) return { doc: doc0, error: `${def.label}: значение вне допустимых пределов`, warnings };
    values[k] = { value: v, unit: def.unit };
  }
  for (const [k, q] of Object.entries(values)) {
    const old = instNow.values[k];
    if (!old || old.value !== q.value) changes.push(`${PARAMS[k]!.label.toLowerCase()} ${old ? formatQuantity(old.value, PARAMS[k]!.unitRu, 4) : '—'} → ${formatQuantity(q.value, PARAMS[k]!.unitRu, 4)}`);
  }
  if (JSON.stringify(values) !== JSON.stringify(instNow.values)) {
    doc = { ...doc, schematic: { ...doc.schematic, instances: doc.schematic.instances.map((i) => (i.id === instId ? { ...i, values } : i)) } };
  }
  // Деталь без модели — честное предупреждение
  if (!modelNow && partNow.category !== 'reference' && partNow.category !== 'connector') warnings.push('Нет SPICE-модели — схема с этой деталью не рассчитывается. Выберите модель или найдите деталь по маркировке.');
  if (!changes.length) return { doc: doc0, error: null, warnings };
  // Неиспользуемые символы, корпуса и модели проекта не удаляются: на них могут ссылаться контрольные версии и плата
  const ref = doc.schematic.instances.find((i) => i.id === instId)!.refDes;
  return { doc: logChange(touch(doc), 'card', `${ref}: ${changes.join('; ')}`), error: null, warnings };
}

/** Детали справочника той же категории с моделью — кандидаты «взять модель». */
export function modelCandidates(catalog: PartBundle[], category: string): PartBundle[] {
  const cats = category === 'capacitor-polar' ? ['capacitor-polar'] : [category];
  return catalog.filter((b) => b.model && cats.includes(b.part.category) && (b.part.partNumber || b.model.name)).sort((a, b) => (a.part.partNumber ?? a.part.name).localeCompare(b.part.partNumber ?? b.part.name));
}

/** Поиск детали справочника по маркировке или партномеру (без учёта регистра и пробелов). */
export function findByMarking(catalog: PartBundle[], text: string): PartBundle[] {
  const norm = (s: string | null) => (s ?? '').toUpperCase().replace(/[\s-]/g, '');
  const t = norm(text);
  if (t.length < 3) return [];
  return catalog.filter((b) => [b.part.partNumber, b.part.marking].some((x) => norm(x) && (norm(x) === t || norm(x).startsWith(t) || t.startsWith(norm(x)))));
}
