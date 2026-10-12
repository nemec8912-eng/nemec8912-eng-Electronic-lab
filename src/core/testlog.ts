/**
 * Журнал испытаний (этап 7): записи о проверке реальной платы — измерения в узлах и на деталях,
 * события деталей (сгорела, неисправна, заменена, снята), фото, условия, напряжение питания.
 * Каждая запись привязана к ревизии проекта (контрольной версии): с ней сравнивается расчёт, её можно
 * сравнить с текущей и восстановить. Журнал — история: возврат к старой ревизии его не стирает.
 *
 * Сравнение с расчётом: |измерено − расчёт| ≤ разброс из-за допусков деталей + погрешность прибора.
 * Гипотезы причин строятся только из фактов записи и схемы и подаются как «что проверить», а не диагноз.
 */
import { logChange, touch } from './factory';
import { newId } from './ids';
import { formatQuantity, PARAMS } from './library';
import type { AttachmentRef, Measurement, MeasureTarget, PartEvent, ProjectDoc, TestRecord } from './model';
import { netDisplayName } from './connectivity';
import { symbolOf } from './schematic';

export const EVENT_KINDS: Array<[PartEvent['kind'], string]> = [
  ['burned', 'сгорела'], ['failed', 'неисправна'], ['replaced', 'заменена'], ['removed', 'снята'],
];
export const eventLabel = (k: PartEvent['kind']) => EVENT_KINDS.find(([x]) => x === k)?.[1] ?? k;

const UNIT: Record<Measurement['quantity'], string> = { V: 'В', A: 'А', 'Ω': 'Ом', other: '' };
export const quantityUnit = (q: Measurement['quantity']) => UNIT[q];
/** Погрешность прибора по умолчанию: ±(1 % + 1 единица младшего разряда типичного мультиметра). */
export const DEFAULT_ACCURACY: Record<Measurement['quantity'], { pct: number; abs: number }> = {
  V: { pct: 1, abs: 0.01 }, A: { pct: 1.5, abs: 0.001 }, 'Ω': { pct: 1, abs: 0.1 }, other: { pct: 0, abs: 0 },
};

// ---------- Записи ----------

/** Дата испытания хранится как календарный день (полдень UTC), чтобы не «съезжать» из-за часового пояса. */
export const dayIso = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T12:00:00.000Z`;
export const fmtDay = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}.${y}`; };

export function newRecord(doc: ProjectDoc, title: string, checkpointId: string | null, now = new Date()): TestRecord {
  return {
    id: newId(), createdAt: now.toISOString(), revision: doc.revision, title: title.slice(0, 200) || 'Испытание', date: dayIso(now),
    checkpointId, supplyV: null, instruments: '', conditions: '', notes: '', measurements: [], events: [], photoIds: [],
  };
}

export function addRecord(doc: ProjectDoc, rec: TestRecord): ProjectDoc {
  return logChange(touch({ ...doc, tests: [...doc.tests, rec] }), 'test', `Испытание «${rec.title}» (ревизия ${rec.revision})`);
}
export function updateRecord(doc: ProjectDoc, id: string, patch: Partial<Omit<TestRecord, 'id' | 'createdAt'>>): ProjectDoc {
  const cur = doc.tests.find((t) => t.id === id);
  if (!cur) return doc;
  const next = { ...cur, ...patch };
  if (JSON.stringify(next) === JSON.stringify(cur)) return doc;
  return touch({ ...doc, tests: doc.tests.map((t) => (t.id === id ? next : t)) });
}
/** Удаление записи. Фото, на которые больше никто не ссылается, убираются из списка вложений проекта. */
export function deleteRecord(doc: ProjectDoc, id: string): ProjectDoc {
  const rec = doc.tests.find((t) => t.id === id);
  if (!rec) return doc;
  const tests = doc.tests.filter((t) => t.id !== id);
  const used = new Set(tests.flatMap((t) => t.photoIds));
  return logChange(touch({ ...doc, tests, attachments: doc.attachments.filter((a) => !rec.photoIds.includes(a.id) || used.has(a.id)) }), 'test-delete', `Запись журнала «${rec.title}» удалена`);
}

export function targetLabel(doc: ProjectDoc, t: MeasureTarget): string {
  if (t.kind === 'net') {
    const n = doc.schematic.nets.find((x) => x.id === t.netId);
    return n ? netDisplayName(doc, n) : 'цепь удалена';
  }
  if (t.kind === 'part') {
    const inst = doc.schematic.instances.find((i) => i.id === t.instanceId);
    if (!inst) return 'деталь удалена';
    if (!t.pin) return inst.refDes;
    const pin = symbolOf(doc, inst)?.pins.find((p) => p.number === t.pin);
    return `${inst.refDes}.${pin?.name || t.pin}`;
  }
  return '';
}

export function newMeasurement(doc: ProjectDoc, target: MeasureTarget, quantity: Measurement['quantity'], label?: string): Measurement {
  const acc = DEFAULT_ACCURACY[quantity];
  return {
    id: newId(), target, label: (label ?? targetLabel(doc, target)).slice(0, 128), quantity, measured: null, unit: UNIT[quantity],
    instrument: '', accuracyPct: acc.pct, accuracyAbs: acc.abs, expected: null, note: '',
  };
}

export function setMeasurements(doc: ProjectDoc, recordId: string, fn: (ms: Measurement[]) => Measurement[]): ProjectDoc {
  const rec = doc.tests.find((t) => t.id === recordId);
  return rec ? updateRecord(doc, recordId, { measurements: fn(rec.measurements) }) : doc;
}
export function setEvents(doc: ProjectDoc, recordId: string, fn: (es: PartEvent[]) => PartEvent[]): ProjectDoc {
  const rec = doc.tests.find((t) => t.id === recordId);
  return rec ? updateRecord(doc, recordId, { events: fn(rec.events) }) : doc;
}
export function newEvent(doc: ProjectDoc, instanceId: string, kind: PartEvent['kind']): PartEvent {
  const inst = doc.schematic.instances.find((i) => i.id === instanceId);
  return { id: newId(), instanceId, refDes: inst?.refDes ?? '?', kind, replacement: '', circumstances: '' };
}

/** Фото к записи: ссылка на вложение добавляется в проект и в запись одной правкой. */
export function attachPhoto(doc: ProjectDoc, recordId: string, ref: AttachmentRef): ProjectDoc {
  const rec = doc.tests.find((t) => t.id === recordId);
  if (!rec) return doc;
  const attachments = doc.attachments.some((a) => a.id === ref.id) ? doc.attachments : [...doc.attachments, ref];
  return touch({ ...doc, attachments, tests: doc.tests.map((t) => (t.id === recordId ? { ...t, photoIds: [...t.photoIds, ref.id] } : t)) });
}
export function detachPhoto(doc: ProjectDoc, recordId: string, attachmentId: string): ProjectDoc {
  const tests = doc.tests.map((t) => (t.id === recordId ? { ...t, photoIds: t.photoIds.filter((x) => x !== attachmentId) } : t));
  const used = new Set(tests.flatMap((t) => t.photoIds));
  return touch({ ...doc, tests, attachments: doc.attachments.filter((a) => a.id !== attachmentId || used.has(a.id)) });
}

/**
 * Возврат к старой ревизии без потери журнала: схема, детали, плата и настройки — из старого документа,
 * журнал испытаний, вложения и журнал изменений — текущие. Так «восстановить старую» не стирает
 * записи о том, что было сделано после неё.
 */
export function keepJournal(restored: ProjectDoc, current: ProjectDoc, label?: string): ProjectDoc {
  const merged: ProjectDoc = {
    ...restored,
    name: current.name,
    description: current.description,
    tests: current.tests,
    attachments: current.attachments,
    changelog: current.changelog,
    revision: Math.max(restored.revision, current.revision),
  };
  return logChange(merged, 'restore', `Схема, детали и плата возвращены к ревизии ${restored.revision}${label ? ` («${label}»)` : ''}; журнал испытаний сохранён`);
}

// ---------- Сравнение с расчётом ----------

export interface Verdict {
  status: 'match' | 'mismatch' | 'no-expected' | 'not-measured' | 'not-comparable';
  /** Измерено − расчёт. */
  delta: number | null;
  deltaPct: number | null;
  /** Допустимое отклонение: разброс допусков + погрешность прибора. */
  allowed: number | null;
  text: string;
}

export function compare(m: Measurement): Verdict {
  const none = (status: Verdict['status'], text: string): Verdict => ({ status, delta: null, deltaPct: null, allowed: null, text });
  if (m.quantity === 'other' || m.target.kind === 'text') return none('not-comparable', 'с расчётом не сравнивается');
  if (m.measured === null) return none('not-measured', 'не измерено');
  if (!m.expected) return none('no-expected', 'нет расчёта');
  const u = UNIT[m.quantity];
  const delta = m.measured - m.expected.value;
  const deltaPct = m.expected.value !== 0 ? (delta / Math.abs(m.expected.value)) * 100 : null;
  const instrument = Math.abs(m.measured) * m.accuracyPct / 100 + m.accuracyAbs;
  const allowed = m.expected.band + instrument;
  const ok = Math.abs(delta) <= allowed;
  const pct = deltaPct === null ? '' : ` (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1).replace('.', ',')} %)`;
  return {
    status: ok ? 'match' : 'mismatch', delta, deltaPct, allowed,
    text: `${ok ? 'в пределах допуска' : 'расхождение'}: ${delta >= 0 ? '+' : ''}${formatQuantity(delta, u, 3)}${pct}, допустимо ±${formatQuantity(allowed, u, 3)}`,
  };
}

/** Ожидаемое сопротивление детали — номинал и допуск из сведений детали (без расчёта схемы). */
export function nominalResistance(doc: ProjectDoc, instanceId: string): { value: number; band: number; method: string } | null {
  const inst = doc.schematic.instances.find((i) => i.id === instanceId);
  const part = inst && doc.library.parts.find((p) => p.id === inst.partId);
  const r = inst?.values.resistance?.value;
  if (!inst || !part || r === undefined) return null;
  const tol = part.tolerancePct ?? 0;
  return {
    value: r, band: r * tol / 100,
    method: `номинал ${formatQuantity(r, 'Ом', 4)}${tol ? ` ± ${String(tol).replace('.', ',')} % (допуск детали)` : ', допуск не указан'}; деталь выпаяна из схемы — иначе параллельные цепи уменьшают показание`,
  };
}

// ---------- Гипотезы ----------

/** Детали, подключённые к узлу. */
function partsOnNet(doc: ProjectDoc, netId: string): string[] {
  const n = doc.schematic.nets.find((x) => x.id === netId);
  if (!n) return [];
  const ids = [...new Set(n.connections.map((c) => c.instanceId))];
  return ids.map((id) => doc.schematic.instances.find((i) => i.id === id)).filter((i) => i && doc.library.parts.find((p) => p.id === i.partId)?.category !== 'reference').map((i) => i!.refDes);
}

/** Напряжение источников питания на схеме (для сравнения с измеренным). */
export function schematicSupply(doc: ProjectDoc): number[] {
  return doc.schematic.instances.flatMap((i) => {
    const part = doc.library.parts.find((p) => p.id === i.partId);
    return part?.category === 'source' && i.values.voltage && !i.values.amplitude ? [i.values.voltage.value] : [];
  });
}

/**
 * Что проверить при расхождении. Только из фактов: значения измерения и расчёта, детали узла,
 * события деталей в этой записи, непроверенные модели, измеренное и схемное питание.
 */
export function hypotheses(doc: ProjectDoc, rec: TestRecord, m: Measurement): string[] {
  const v = compare(m);
  if (v.status !== 'mismatch' || m.measured === null || !m.expected) return [];
  const out: string[] = [];
  const exp = m.expected.value, got = m.measured;
  const supply = rec.supplyV ?? schematicSupply(doc)[0] ?? null;
  if (m.quantity === 'V') {
    if (Math.abs(got) < Math.max(0.02 * Math.abs(exp), 0.05)) out.push('Напряжение почти нулевое: проверьте, подано ли питание и есть ли общий провод у прибора; обрыв цепи от источника к этому узлу; замыкание узла на землю.');
    else if (supply !== null && Math.abs(got - supply) < 0.05 * Math.abs(supply) && Math.abs(exp - supply) > 0.1 * Math.abs(supply)) out.push(`Напряжение почти равно питанию (${formatQuantity(supply, 'В', 3)}): возможен обрыв цепи от этого узла к земле — непропай или деталь, сгоревшая в обрыв.`);
    else if (Math.abs(got) > Math.abs(exp)) out.push('Напряжение больше расчётного: проверьте номиналы деталей между узлом и землёй (меньше нужного или обрыв) и между узлом и питанием (больше или замыкание).');
    else out.push('Напряжение меньше расчётного: проверьте номиналы деталей между узлом и питанием и утечку или замыкание от узла к земле; учтите нагрузку от прибора с малым входным сопротивлением.');
  } else if (m.quantity === 'A') {
    if (Math.abs(got) < 0.02 * Math.abs(exp)) out.push('Тока почти нет: обрыв в цепи или прибор включён не последовательно (щупы не в разрыв), сгорел предохранитель прибора.');
    else out.push(`Ток ${Math.abs(got) > Math.abs(exp) ? 'больше' : 'меньше'} расчётного: проверьте номиналы деталей в этой ветви и напряжение питания.`);
  } else if (m.quantity === 'Ω') {
    if (got > exp) out.push('Сопротивление больше номинала: обрыв или выгорание резистора, плохой контакт щупов. При измерении в схеме показание бывает только меньше номинала — значит, деталь, скорее всего, неисправна.');
    else out.push('Сопротивление меньше номинала: если мерили не выпаивая — параллельные цепи схемы уменьшают показание; иначе возможна неисправность детали или перепутан номинал.');
  }
  if (supply !== null && rec.supplyV !== null) {
    const sch = schematicSupply(doc);
    if (sch.length === 1 && Math.abs(sch[0]! - rec.supplyV) > 0.03 * Math.abs(sch[0]!)) out.push(`Питание измерено ${formatQuantity(rec.supplyV, 'В', 3)}, на схеме — ${formatQuantity(sch[0]!, 'В', 3)}.${m.expected.method.includes('измерено') ? ' Расчёт уже выполнен при измеренном питании.' : ' Пересчитайте ожидаемые значения: расчёт подставит измеренное питание.'}`);
  }
  const related = m.target.kind === 'net' ? partsOnNet(doc, m.target.netId) : m.target.kind === 'part' ? [m.label.split('.')[0]!] : [];
  if (related.length) out.push(`К этой точке подключены: ${related.join(', ')} — их стоит проверить в первую очередь.`);
  const failed = rec.events.filter((e) => related.includes(e.refDes));
  if (failed.length) out.push(`В этой записи отмечено: ${failed.map((e) => `${e.refDes} — ${eventLabel(e.kind)}`).join('; ')}.`);
  const unverified = doc.schematic.instances.filter((i) => related.includes(i.refDes)).filter((i) => {
    const part = doc.library.parts.find((p) => p.id === i.partId);
    const model = part?.modelId ? doc.library.models.find((x) => x.id === part.modelId) : undefined;
    return model && !model.verified;
  }).map((i) => i.refDes);
  if (unverified.length) out.push(`Модели ${unverified.join(', ')} не проверены — реальная деталь может вести себя иначе, чем в расчёте.`);
  return out;
}

/** Сводка записи: сколько измерений совпало, сколько расходится. */
export function recordSummary(rec: TestRecord): { match: number; mismatch: number; open: number } {
  let match = 0, mismatch = 0, open = 0;
  for (const m of rec.measurements) {
    const s = compare(m).status;
    if (s === 'match') match++; else if (s === 'mismatch') mismatch++; else if (s === 'no-expected' || s === 'not-measured') open++;
  }
  return { match, mismatch, open };
}

/** Параметры, которые меняются как «номинал» детали и учитываются при расчёте разброса. */
export const TOLERANCED = ['resistance', 'capacitance', 'inductance'] as const;
export const paramUnit = (key: string) => PARAMS[key]?.unitRu ?? '';
