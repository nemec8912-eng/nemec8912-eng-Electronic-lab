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
import { icSymbol, standardSymbol, SYMBOL_FOR_CATEGORY, type IcPinInput } from './symbols';

export const IDEAL_MODELS: Record<string, Omit<SimModel, 'id'>> = {
  resistor: { name: 'Идеальный резистор', kind: 'spice-primitive', text: 'R {n:1} {n:2} {v:resistance}', source: 'ngspice: элемент R', verified: true },
  capacitor: { name: 'Идеальный конденсатор', kind: 'spice-primitive', text: 'C {n:1} {n:2} {v:capacitance}', source: 'ngspice: элемент C', verified: true },
  'capacitor-polar': { name: 'Идеальный конденсатор (полярность не моделируется)', kind: 'spice-primitive', text: 'C {n:1} {n:2} {v:capacitance}', source: 'ngspice: элемент C', verified: true },
  inductor: { name: 'Идеальная катушка', kind: 'spice-primitive', text: 'L {n:1} {n:2} {v:inductance}', source: 'ngspice: элемент L', verified: true },
  connector: { name: 'Разъём (не элемент цепи)', kind: 'connector', text: '', source: null, verified: true },
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
  return withModel({ part: blankPart(category, symbolId), symbol, packages: [], model: null }, category);
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

/** Смена категории: стандартный символ и идеальная модель — по новой категории; соответствия выводов пересобираются. */
export function setCategory(b: PartBundle, category: string): PartBundle {
  const cat = CATEGORIES.find((c) => c.id === category);
  if (!cat || cat.id === b.part.category) return b;
  let symbol = b.symbol;
  if (!isIcLike(category)) symbol = { ...standardSymbol(SYMBOL_FOR_CATEGORY[category]!), id: b.symbol.id };
  else if (!isIcLike(b.part.category)) symbol = { ...icSymbol(b.part.name || 'Микросхема', b.symbol.pins.map((p) => ({ number: p.number, name: p.name, electricalType: p.electricalType, description: p.description }))), id: b.symbol.id };
  const valueKey = VALUE_FOR_CATEGORY[category];
  const values = valueKey ? (b.part.values[valueKey] ? { [valueKey]: b.part.values[valueKey]! } : {}) : {};
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
