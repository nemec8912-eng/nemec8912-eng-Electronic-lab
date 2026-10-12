/**
 * Операции редактора деталей и микросхем (чистые функции над комплектом PartBundle).
 * Соответствие «вывод символа ↔ площадка» никогда не меняется молча: при добавлении корпуса оно
 * предлагается по совпадающим номерам, при удалении вывода убираются только его строки.
 */
import { CATEGORIES, type PartBundle } from './catalog';
import { newId } from './ids';
import { PART_INFO_DEFAULTS } from './library';
import type { PackageDef, PartDef, SimModel, SymbolDef } from './model';
import { generatePackage, type GenParams } from './packages';
import * as STD from './stdModels';
import { icSymbol, standardSymbol, SYMBOL_FOR_CATEGORY, type IcPinInput } from './symbols';

export const IDEAL_MODELS: Record<string, Omit<SimModel, 'id'>> = {
  resistor: { name: 'Идеальный резистор', kind: 'spice-primitive', text: 'R {n:1} {n:2} {v:resistance}', source: 'ngspice: элемент R', verified: true },
  capacitor: { name: 'Идеальный конденсатор', kind: 'spice-primitive', text: 'C {n:1} {n:2} {v:capacitance}', source: 'ngspice: элемент C', verified: true },
  'capacitor-polar': { name: 'Идеальный конденсатор (полярность не моделируется)', kind: 'spice-primitive', text: 'C {n:1} {n:2} {v:capacitance}', source: 'ngspice: элемент C', verified: true },
  inductor: { name: 'Идеальная катушка', kind: 'spice-primitive', text: 'L {n:1} {n:2} {v:inductance}', source: 'ngspice: элемент L', verified: true },
  connector: { name: 'Разъём (не элемент цепи)', kind: 'connector', text: '', source: null, verified: true },
  relay: STD.RELAY_PARAM,
  potentiometer: STD.POT,
  transformer: STD.TR_GENERIC,
  crystal: STD.XTAL,
  switch: STD.SWITCH_SPST,
  fuse: STD.FUSE_1A,
  varistor: STD.VARISTOR_PARAM,
};

/** Параметры по умолчанию для типовых моделей категорий (задаются на схеме у каждого экземпляра). */
export const VALUES_FOR_CATEGORY: Record<string, Record<string, { value: number; unit: string }>> = {
  relay: { coilResistance: { value: 400, unit: 'Ω' }, pullIn: { value: 9, unit: 'V' }, dropOut: { value: 1.2, unit: 'V' } },
  potentiometer: { resistance: { value: 10_000, unit: 'Ω' }, position: { value: 50, unit: '%' } },
  transformer: { inductance: { value: 10, unit: 'H' }, turnsRatio: { value: 18.25, unit: '' } },
  crystal: { frequency: { value: 4_000_000, unit: 'Hz' } },
  switch: { closed: { value: 0, unit: '' } },
  varistor: { clampVoltage: { value: 470, unit: 'V' } },
};

/** Номинал, который задаётся у детали данной категории. */
export const VALUE_FOR_CATEGORY: Record<string, string> = {
  resistor: 'resistance', capacitor: 'capacitance', 'capacitor-polar': 'capacitance', inductor: 'inductance', zener: 'zenerVoltage',
};

export const isIcLike = (category: string) => !SYMBOL_FOR_CATEGORY[category];

function blankPart(category: string, symbolId: string): PartDef {
  const cat = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES.find((c) => c.id === 'other')!;
  const id = newId();
  return {
    id, name: '', category: cat.id, refPrefix: cat.prefix, manufacturer: null, partNumber: null, symbolId, packages: [], modelId: null,
    description: '', ...PART_INFO_DEFAULTS, values: {}, ratings: {},
    origin: { catalogPartId: id, source: 'введено вручную', license: null, verified: false, checkedAt: null, notes: '' },
  };
}

function withModel(b: PartBundle, category: string): PartBundle {
  const m = IDEAL_MODELS[category];
  if (!m) return { ...b, model: null, part: { ...b.part, modelId: null } };
  const model = { ...m, id: b.model?.id ?? newId() };
  return { ...b, model, part: { ...b.part, modelId: model.id } };
}

/** Новая деталь со стандартным символом категории (или микросхема с заданным числом выводов). */
export function newBundle(category: string, icPins = 8): PartBundle {
  const symbolId = newId();
  const symbol: SymbolDef = isIcLike(category)
    ? { ...icSymbol('Новая микросхема', Array.from({ length: icPins }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, electricalType: 'passive' as const }))), id: symbolId }
    : { ...standardSymbol(SYMBOL_FOR_CATEGORY[category]!), id: symbolId };
  const part = { ...blankPart(category, symbolId), values: structuredClone(VALUES_FOR_CATEGORY[category] ?? {}) };
  return withModel({ part, symbol, packages: [], model: null }, category);
}

/** Копия для правки: все id новые; встроенная деталь становится личной, сведения — не сверены. */
export function copyBundle(src: PartBundle, nameSuffix = ' (копия)'): PartBundle {
  const pkgIds = new Map(src.packages.map((p) => [p.id, newId()]));
  const partId = newId(), symbolId = newId(), modelId = src.model ? newId() : null;
  return {
    part: {
      ...structuredClone(src.part), id: partId, name: src.part.name + nameSuffix, symbolId, modelId,
      packages: src.part.packages.map((p) => ({ packageId: pkgIds.get(p.packageId)!, pinMap: structuredClone(p.pinMap) })),
      origin: { ...src.part.origin, catalogPartId: partId, verified: false, checkedAt: null, notes: [src.part.origin.notes, `Создана на основе «${src.part.name}».`].filter(Boolean).join(' ') },
    },
    symbol: { ...structuredClone(src.symbol), id: symbolId },
    packages: src.packages.map((p) => ({ ...structuredClone(p), id: pkgIds.get(p.id)! })),
    model: src.model && modelId ? { ...structuredClone(src.model), id: modelId } : null,
  };
}

/** Смена категории: префикс, идеальная модель и (у детали без корпусов) стандартное обозначение — по новой категории. */
export function setCategory(b: PartBundle, category: string): PartBundle {
  const cat = CATEGORIES.find((c) => c.id === category);
  if (!cat || cat.id === b.part.category) return b;
  let symbol = b.symbol;
  // Когда корпуса уже заданы, обозначение не заменяется: иначе номера выводов поменяли бы смысл и
  // соответствие «вывод ↔ площадка» стало бы неверным молча. Обозначение меняется только у новой детали.
  if (b.packages.length > 0) symbol = b.symbol;
  else if (!isIcLike(category)) symbol = { ...standardSymbol(SYMBOL_FOR_CATEGORY[category]!), id: b.symbol.id };
  else if (!isIcLike(b.part.category)) symbol = { ...icSymbol(b.part.name || 'Микросхема', b.symbol.pins.map((p) => ({ number: p.number, name: p.name, electricalType: p.electricalType, description: p.description }))), id: b.symbol.id };
  const valueKey = VALUE_FOR_CATEGORY[category];
  const values = valueKey ? (b.part.values[valueKey] ? { [valueKey]: b.part.values[valueKey]! } : {}) : structuredClone(VALUES_FOR_CATEGORY[category] ?? {});
  const next: PartBundle = { ...b, symbol, part: { ...b.part, category, refPrefix: cat.prefix, values } };
  return pruneMaps(withModel(next, category));
}

/** Выводы микросхемы: символ перестраивается, соответствия удалённых выводов убираются, новые — по номеру. */
export function setIcPins(b: PartBundle, pins: IcPinInput[]): PartBundle {
  const symbol = { ...icSymbol(b.part.name || 'Микросхема', pins), id: b.symbol.id };
  const next = { ...b, symbol };
  const pruned = pruneMaps(next);
  const known = new Set(b.symbol.pins.map((p) => p.number));
  const added = pins.filter((p) => !known.has(p.number)).map((p) => p.number);
  return mapByNumber(pruned, added);
}

/** Описание (функция) вывода стандартного символа. */
export function setPinDescription(b: PartBundle, number: string, description: string): PartBundle {
  return { ...b, symbol: { ...b.symbol, pins: b.symbol.pins.map((p) => (p.number === number ? { ...p, description } : p)) } };
}

export function addPackage(b: PartBundle, family: string, params: GenParams = {}): PartBundle {
  const pkg: PackageDef = { ...generatePackage(family, params), id: newId() };
  return addPackageDef(b, pkg);
}

export function addPackageDef(b: PartBundle, pkg: PackageDef): PartBundle {
  const pinMap = b.symbol.pins.filter((pin) => pkg.pads.some((pad) => pad.number === pin.number)).map((pin) => ({ symbolPin: pin.number, pad: pin.number }));
  return { ...b, packages: [...b.packages, pkg], part: { ...b.part, packages: [...b.part.packages, { packageId: pkg.id, pinMap }] } };
}

export function removePackage(b: PartBundle, packageId: string): PartBundle {
  return { ...b, packages: b.packages.filter((p) => p.id !== packageId), part: { ...b.part, packages: b.part.packages.filter((p) => p.packageId !== packageId) } };
}

/** Назначить вывод символа на площадку (null — снять назначение). Занятая площадка освобождается у прежнего вывода. */
export function setPinPad(b: PartBundle, packageId: string, symbolPin: string, pad: string | null): PartBundle {
  return {
    ...b,
    part: {
      ...b.part,
      packages: b.part.packages.map((pk) => {
        if (pk.packageId !== packageId) return pk;
        const rest = pk.pinMap.filter((m) => m.symbolPin !== symbolPin && (pad === null || m.pad !== pad));
        return { ...pk, pinMap: pad === null ? rest : [...rest, { symbolPin, pad }] };
      }),
    },
  };
}

/** Сопоставить выводы с площадками по совпадающим номерам (для указанных выводов или всех). */
export function mapByNumber(b: PartBundle, pins?: string[], packageId?: string): PartBundle {
  const want = new Set(pins ?? b.symbol.pins.map((p) => p.number));
  return {
    ...b,
    part: {
      ...b.part,
      packages: b.part.packages.map((pk) => {
        if (packageId && pk.packageId !== packageId) return pk;
        const pkg = b.packages.find((x) => x.id === pk.packageId);
        if (!pkg) return pk;
        let map = pk.pinMap;
        for (const n of want) {
          if (!pkg.pads.some((p) => p.number === n)) continue;
          map = [...map.filter((m) => m.symbolPin !== n && m.pad !== n), { symbolPin: n, pad: n }];
        }
        return { ...pk, pinMap: map };
      }),
    },
  };
}

function pruneMaps(b: PartBundle): PartBundle {
  const pins = new Set(b.symbol.pins.map((p) => p.number));
  return { ...b, part: { ...b.part, packages: b.part.packages.map((pk) => ({ ...pk, pinMap: pk.pinMap.filter((m) => pins.has(m.symbolPin)) })) } };
}

/** «Я сверил с даташитом»: отметка и дата проверки. */
export function setVerified(b: PartBundle, verified: boolean, now = new Date()): PartBundle {
  return { ...b, part: { ...b.part, origin: { ...b.part.origin, verified, checkedAt: verified ? now.toISOString() : null } } };
}

// ---------- Свой корпус: площадки по координатам ----------

type Pad = PackageDef['pads'][number];
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Пустой выводной корпус: по площадке на каждый вывод символа в ряд с шагом 2,54 мм — дальше координаты правятся. */
export function newCustomPackage(b: PartBundle, name = 'Свой корпус'): PartBundle {
  const nums = [...b.symbol.pins].map((p) => p.number).sort((x, y) => x.localeCompare(y, 'ru', { numeric: true }));
  const pads: Pad[] = nums.map((n, i) => ({ number: n, x: r3(i * 2.54), y: 0, shape: i === 0 ? 'rect' : 'round', w: 1.8, h: 1.8, drill: 0.9 }));
  const pkg: PackageDef = {
    id: newId(), name, family: 'CUSTOM', mount: 'THT', generator: null, pitchMm: null, numbering: null, pin1Marker: 'квадратная площадка — вывод 1',
    pads, body: padsBody(pads),
  };
  return addPackageDef(b, pkg);
}

/** Контур корпуса вокруг площадок с запасом 0,5 мм. */
export function padsBody(pads: Pad[]): PackageDef['body'] {
  if (!pads.length) return null;
  const x0 = Math.min(...pads.map((p) => p.x - p.w / 2)), x1 = Math.max(...pads.map((p) => p.x + p.w / 2));
  const y0 = Math.min(...pads.map((p) => p.y - p.h / 2)), y1 = Math.max(...pads.map((p) => p.y + p.h / 2));
  return { x: r3(x0 - 0.5), y: r3(y0 - 0.5), w: r3(x1 - x0 + 1), h: r3(y1 - y0 + 1) };
}

const editPkg = (b: PartBundle, packageId: string, f: (p: PackageDef) => PackageDef): PartBundle =>
  ({ ...b, packages: b.packages.map((p) => (p.id === packageId ? f(p) : p)) });

/** Изменённый вручную корпус больше не «генерируется»: параметры генератора снимаются. */
const manual = (p: PackageDef, pads: Pad[]): PackageDef => {
  const smd = pads.length > 0 && pads.every((x) => x.drill === null);
  return { ...p, pads, generator: null, family: p.family === 'CUSTOM' ? 'CUSTOM' : `${p.family} (изменён)`.slice(0, 32), mount: smd ? 'SMD' : 'THT' };
};

export function padProblem(pad: Pad): string | null {
  if (!pad.number.trim()) return 'Номер площадки пустой';
  if (![pad.x, pad.y, pad.w, pad.h].every(Number.isFinite)) return 'Координаты и размеры — числа';
  if (!(pad.w > 0 && pad.h > 0)) return 'Размер площадки больше нуля';
  if (pad.w > 50 || pad.h > 50 || Math.abs(pad.x) > 200 || Math.abs(pad.y) > 200) return 'Слишком большие размеры или координаты';
  if (pad.drill !== null && !(pad.drill > 0)) return 'Отверстие — больше нуля (пусто — SMD)';
  if (pad.drill !== null && pad.drill >= Math.min(pad.w, pad.h)) return `Отверстие ${String(pad.drill).replace('.', ',')} мм не меньше площадки — меди вокруг не останется`;
  return null;
}

/** Изменить площадку (по индексу). Переименование номера переносит его в соответствии выводов. */
export function setPad(b: PartBundle, packageId: string, index: number, patch: Partial<Pad>): { b: PartBundle; error: string | null } {
  const pkg = b.packages.find((p) => p.id === packageId);
  const cur = pkg?.pads[index];
  if (!pkg || !cur) return { b, error: 'Площадка не найдена' };
  const next: Pad = { ...cur, ...patch, number: (patch.number ?? cur.number).trim().slice(0, 16) };
  const problem = padProblem(next);
  if (problem) return { b, error: problem };
  const pads = pkg.pads.map((p, i) => (i === index ? next : p));
  let out = editPkg(b, packageId, (p) => manual(p, pads));
  if (next.number !== cur.number && !pkg.pads.some((p, i) => i !== index && p.number === cur.number)) {
    // Старого номера больше нет — его строки соответствия переходят на новый номер
    out = { ...out, part: { ...out.part, packages: out.part.packages.map((pk) => (pk.packageId !== packageId ? pk : { ...pk, pinMap: pk.pinMap.map((m) => (m.pad === cur.number ? { ...m, pad: next.number } : m)) })) } };
  }
  return { b: out, error: null };
}

export function addPad(b: PartBundle, packageId: string): PartBundle {
  return editPkg(b, packageId, (p) => {
    const last = p.pads[p.pads.length - 1];
    const used = new Set(p.pads.map((x) => x.number));
    let n = p.pads.length + 1;
    while (used.has(String(n))) n++;
    const pad: Pad = last ? { ...last, number: String(n), x: r3(last.x + 2.54), shape: 'round' } : { number: '1', x: 0, y: 0, shape: 'rect', w: 1.8, h: 1.8, drill: 0.9 };
    return manual(p, [...p.pads, pad]);
  });
}

export function removePad(b: PartBundle, packageId: string, index: number): PartBundle {
  const pkg = b.packages.find((p) => p.id === packageId);
  const pad = pkg?.pads[index];
  if (!pkg || !pad) return b;
  const pads = pkg.pads.filter((_, i) => i !== index);
  const gone = !pads.some((p) => p.number === pad.number);
  const out = editPkg(b, packageId, (p) => manual(p, pads));
  return gone ? { ...out, part: { ...out.part, packages: out.part.packages.map((pk) => (pk.packageId !== packageId ? pk : { ...pk, pinMap: pk.pinMap.filter((m) => m.pad !== pad.number) })) } } : out;
}

export function fitBody(b: PartBundle, packageId: string): PartBundle {
  return editPkg(b, packageId, (p) => ({ ...p, body: padsBody(p.pads) }));
}

