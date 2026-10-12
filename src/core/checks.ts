/**
 * Тест работоспособности: условия «величина в диапазоне», правка списка условий.
 * Расчёт значений — в src/sim/checks.ts (нужны результаты ngspice).
 */
import { logChange, touch } from './factory';
import { newId } from './ids';
import { formatQuantity } from './library';
import type { Check, PinRef, ProjectDoc } from './model';

export type CheckQuantity = Check['quantity'];

export const CHECK_KINDS: Array<{ id: CheckQuantity; label: string; unit: string; unitRu: string; analysis: 'op' | 'tran' | 'ac'; needs: Array<'at' | 'ref' | 'input' | 'freq' | 'from'> }> = [
  { id: 'dc-v', label: 'Постоянное напряжение (рабочая точка)', unit: 'V', unitRu: 'В', analysis: 'op', needs: ['at', 'ref'] },
  { id: 'dc-i', label: 'Ток через вывод, по модулю (рабочая точка)', unit: 'A', unitRu: 'А', analysis: 'op', needs: ['at'] },
  { id: 'tran-avg', label: 'Среднее напряжение (переходный процесс)', unit: 'V', unitRu: 'В', analysis: 'tran', needs: ['at', 'ref', 'from'] },
  { id: 'tran-max', label: 'Максимум напряжения', unit: 'V', unitRu: 'В', analysis: 'tran', needs: ['at', 'ref', 'from'] },
  { id: 'tran-min', label: 'Минимум напряжения', unit: 'V', unitRu: 'В', analysis: 'tran', needs: ['at', 'ref', 'from'] },
  { id: 'tran-vpp', label: 'Размах (от пика до пика)', unit: 'V', unitRu: 'В', analysis: 'tran', needs: ['at', 'ref', 'from'] },
  { id: 'tran-rms', label: 'Действующее значение (RMS)', unit: 'V', unitRu: 'В', analysis: 'tran', needs: ['at', 'ref', 'from'] },
  { id: 'tran-freq', label: 'Частота сигнала', unit: 'Hz', unitRu: 'Гц', analysis: 'tran', needs: ['at', 'ref', 'from'] },
  { id: 'ac-gain', label: 'Коэффициент передачи на частоте (АЧХ)', unit: '', unitRu: 'раз', analysis: 'ac', needs: ['at', 'ref', 'input', 'freq'] },
];
export const checkKind = (q: CheckQuantity) => CHECK_KINDS.find((k) => k.id === q)!;

export function newCheck(quantity: CheckQuantity, at: PinRef | null = null): Check {
  return { id: newId(), name: '', quantity, at, ref: null, input: null, freqHz: quantity === 'ac-gain' ? 1000 : null, fromS: null, min: null, max: null, measured: null };
}

export const pinLabel = (doc: ProjectDoc, p: PinRef | null): string => {
  if (!p) return 'земля';
  const inst = doc.schematic.instances.find((i) => i.id === p.instanceId);
  return inst ? `${inst.refDes}.${p.pin}` : 'деталь удалена';
};

export function fmtValue(q: CheckQuantity, v: number): string {
  const k = checkKind(q);
  if (q === 'ac-gain') return `${formatQuantity(v, '')}× (${(20 * Math.log10(Math.max(v, 1e-12))).toFixed(1).replace('.', ',')} дБ)`;
  return formatQuantity(v, k.unitRu);
}

export function rangeText(c: Check): string {
  const u = (v: number) => (c.quantity === 'ac-gain' ? formatQuantity(v, '') : formatQuantity(v, checkKind(c.quantity).unitRu));
  if (c.min !== null && c.max !== null) return `от ${u(c.min)} до ${u(c.max)}`;
  if (c.min !== null) return `не меньше ${u(c.min)}`;
  if (c.max !== null) return `не больше ${u(c.max)}`;
  return 'диапазон не задан';
}

/** Что проверяется — словами (для списка и журнала). */
export function describeCheck(doc: ProjectDoc, c: Check): string {
  const k = checkKind(c.quantity);
  const where = c.quantity === 'dc-i' ? `в вывод ${pinLabel(doc, c.at)}` : `${pinLabel(doc, c.at)} относительно ${c.ref ? pinLabel(doc, c.ref) : 'земли'}`;
  const extra = c.quantity === 'ac-gain' ? `, вход ${pinLabel(doc, c.input)}, ${formatQuantity(c.freqHz ?? 0, 'Гц')}` : '';
  return `${c.name ? `${c.name}: ` : ''}${k.label.toLowerCase()} ${where}${extra} — ${rangeText(c)}`;
}

export function checkProblem(c: Check): string | null {
  const k = checkKind(c.quantity);
  if (!c.at) return 'Выберите вывод, где измерять';
  if (k.needs.includes('input') && !c.input) return 'Выберите вывод входа';
  if (k.needs.includes('freq') && !(c.freqHz && c.freqHz > 0)) return 'Укажите частоту';
  if (c.min === null && c.max === null) return 'Задайте нижнюю или верхнюю границу';
  if (c.min !== null && c.max !== null && c.min > c.max) return 'Нижняя граница больше верхней';
  return null;
}

// ---------- Правка ----------

export function addCheck(doc: ProjectDoc, c: Check): ProjectDoc {
  return logChange(touch({ ...doc, checks: { ...doc.checks, items: [...doc.checks.items, c] } }), 'check', `Условие работоспособности добавлено: ${describeCheck(doc, c)}`);
}
export function updateCheck(doc: ProjectDoc, id: string, patch: Partial<Omit<Check, 'id'>>): ProjectDoc {
  const cur = doc.checks.items.find((c) => c.id === id);
  if (!cur) return doc;
  const next = { ...cur, ...patch };
  if (JSON.stringify(next) === JSON.stringify(cur)) return doc;
  return touch({ ...doc, checks: { ...doc.checks, items: doc.checks.items.map((c) => (c.id === id ? next : c)) } });
}
export function deleteCheck(doc: ProjectDoc, id: string): ProjectDoc {
  const c = doc.checks.items.find((x) => x.id === id);
  if (!c) return doc;
  return logChange(touch({ ...doc, checks: { ...doc.checks, items: doc.checks.items.filter((x) => x.id !== id) } }), 'check', `Условие работоспособности удалено: ${describeCheck(doc, c)}`);
}
export function setNoOverload(doc: ProjectDoc, on: boolean): ProjectDoc {
  return doc.checks.noOverload === on ? doc : touch({ ...doc, checks: { ...doc.checks, noOverload: on } });
}
