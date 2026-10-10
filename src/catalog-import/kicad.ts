/**
 * Импорт деталей из библиотек KiCad: символы (.kicad_sym, KiCad 6–9) и посадочные места (.kicad_mod).
 * Чистые функции без сети и файлов. Результат — комплект детали, который пользователь проверяет
 * и подтверждает в редакторе; сведения помечаются «не сверено», модель для расчёта не создаётся
 * (кроме идеальных R, C, L), источник и лицензия записываются в деталь.
 */
import { CATEGORIES, type PartBundle } from '../core/catalog';
import { newId } from '../core/ids';
import { PART_INFO_DEFAULTS } from '../core/library';
import type { PackageDef, SymbolDef } from '../core/model';
import { IDEAL_MODELS } from '../core/partEditor';
import { icSymbol, standardSymbol, type IcPinInput } from '../core/symbols';
import { atom, atoms, child, children, flag, head, num, parseSexpr, type SNode } from './sexpr';

/** Распространённые библиотеки символов KiCad — подсказки в поле ввода. */
export const COMMON_SYMBOL_LIBRARIES = [
  'Device', 'Timer', 'Amplifier_Operational', 'Comparator', 'Regulator_Linear', 'Regulator_Switching', 'Reference_Voltage',
  'Transistor_BJT', 'Transistor_FET', 'Diode', 'Diode_Bridge', 'LED', 'Optocoupler', 'Relay', 'Connector', 'Connector_Generic',
  'Switch', 'Sensor_Temperature', 'Sensor', 'Interface_UART', 'Interface_USB', 'Driver_Motor', 'Driver_LED', 'Logic_LevelTranslator',
  '74xx', '4xxx', 'Memory_EEPROM', 'MCU_Microchip_ATmega', 'MCU_Microchip_ATtiny', 'MCU_Microchip_PIC16', 'MCU_ST_STM32F1', 'MCU_Espressif',
  'Analog_ADC', 'Analog_DAC', 'Audio', 'Power_Protection', 'Battery_Management', 'Display_Character', 'Oscillator', 'Transformer',
];

export const KICAD_LICENSE = 'CC-BY-SA 4.0 с исключением KiCad: проекты и файлы для производства, созданные с этими данными, под лицензию не подпадают';

export interface KicadPin { number: string; name: string; type: string; hidden: boolean; unit: number }
export interface KicadSymbol {
  name: string;
  extends: string | null;
  properties: Record<string, string>;
  pins: KicadPin[];
  units: number;
}
export interface SymbolSummary { name: string; description: string; reference: string; footprint: string; datasheet: string; keywords: string; pinCount: number; extends: string | null }

export class KicadError extends Error {}

// ---------- Символы ----------

/** Разобрать библиотеку символов; наследование (extends) раскрывается. */
export function parseSymbolLibrary(text: string): KicadSymbol[] {
  return resolveExtends(readSymbolsRaw(text));
}

/** Символы файла без раскрытия наследования (для библиотек-папок KiCad 9, где родитель — в другом файле). */
export function readSymbolsRaw(text: string): KicadSymbol[] {
  const top = parseSexpr(text);
  const lib = top.find((x) => head(x) === 'kicad_symbol_lib');
  if (!lib) throw new KicadError('Это не библиотека символов KiCad (нет kicad_symbol_lib). Нужен файл .kicad_sym из KiCad 6 или новее.');
  return children(lib, 'symbol').map(readSymbol);
}

/** Раскрыть extends: выводы и свойства родителя (свойства потомка важнее). */
export function resolveExtends(raw: KicadSymbol[]): KicadSymbol[] {
  const byName = new Map(raw.map((s) => [s.name, s]));
  const resolve = (s: KicadSymbol, depth = 0): KicadSymbol => {
    if (!s.extends) return s;
    const parent = byName.get(s.extends);
    if (!parent || depth > 10) return s;
    const p = resolve(parent, depth + 1);
    const props = { ...p.properties, ...s.properties };
    return { ...s, pins: s.pins.length ? s.pins : p.pins, units: Math.max(s.units, p.units), properties: props };
  };
  return raw.map((s) => resolve(s));
}

function readSymbol(node: SNode[]): KicadSymbol {
  const name = atom(node, 1) ?? '';
  const properties: Record<string, string> = {};
  for (const p of children(node, 'property')) {
    const k = atom(p, 1), v = atom(p, 2);
    if (k !== undefined && v !== undefined) properties[k] = v;
  }
  const pins: KicadPin[] = [];
  const seen = new Set<string>();
  let units = 1;
  const collect = (n: SNode[], unit: number) => {
    for (const pin of children(n, 'pin')) {
      const number = atom(child(pin, 'number'), 1) ?? '';
      if (!number || seen.has(number)) continue;
      seen.add(number);
      pins.push({ number, name: atom(child(pin, 'name'), 1) ?? '', type: atom(pin, 1) ?? 'unspecified', hidden: flag(pin, 'hide'), unit });
    }
  };
  collect(node, 0);
  for (const sub of children(node, 'symbol')) {
    const m = /_(\d+)_(\d+)$/.exec(atom(sub, 1) ?? '');
    const unit = m ? Number(m[1]) : 0;
    const style = m ? Number(m[2]) : 1;
    if (style > 1) continue; // альтернативное начертание (De Morgan) — те же выводы
    units = Math.max(units, unit);
    collect(sub, unit);
  }
  return { name, extends: atom(child(node, 'extends'), 1) ?? null, properties, pins, units };
}

const clean = (s: string | undefined) => (s && s !== '~' ? s : '');

/** Разметка имён выводов KiCad: ~{RST} — черта сверху (инверсия), _{x}/^{x} — индексы. */
export function pinNameText(s: string): string {
  return clean(s)
    .replace(/~\{([^}]*)\}/g, (_, t: string) => [...t].map((c) => `${c}\u0305`).join(''))
    .replace(/[_^]\{([^}]*)\}/g, '$1');
}

export function summarize(s: KicadSymbol): SymbolSummary {
  const p = s.properties;
  return {
    name: s.name,
    description: clean(p.Description ?? p.ki_description),
    reference: clean(p.Reference),
    footprint: clean(p.Footprint),
    datasheet: clean(p.Datasheet),
    keywords: clean(p.ki_keywords),
    pinCount: s.pins.length,
    extends: s.extends,
  };
}

// ---------- Посадочные места ----------

export interface KicadPad { number: string; kind: string; shape: string; x: number; y: number; rot: number; w: number; h: number; drill: number | null }
export interface KicadFootprint {
  name: string;
  description: string;
  attr: string | null;
  pads: KicadPad[];
  fab: Box | null;
  courtyard: Box | null;
}
type Box = { x0: number; y0: number; x1: number; y1: number };

export function parseFootprint(text: string): KicadFootprint {
  const top = parseSexpr(text);
  const fp = top.find((x) => head(x) === 'footprint' || head(x) === 'module');
  if (!fp) throw new KicadError('Это не посадочное место KiCad (нет footprint/module). Нужен файл .kicad_mod.');
  const pads: KicadPad[] = children(fp, 'pad').map((p) => {
    const at = child(p, 'at'), size = child(p, 'size'), drill = child(p, 'drill');
    const drillNums = atoms(drill).slice(1).map(Number).filter((v) => Number.isFinite(v));
    return {
      number: atom(p, 1) ?? '', kind: atom(p, 2) ?? '', shape: atom(p, 3) ?? 'rect',
      x: num(at, 1) ?? 0, y: num(at, 2) ?? 0, rot: num(at, 3) ?? 0,
      w: num(size, 1) ?? 0, h: num(size, 2) ?? num(size, 1) ?? 0,
      drill: drillNums.length ? drillNums[0]! : null,
    };
  });
  const attrNode = child(fp, 'attr');
  return {
    name: atom(fp, 1) ?? '',
    description: atom(child(fp, 'descr'), 1) ?? '',
    attr: attrNode ? (atoms(attrNode).find((a) => a === 'smd' || a === 'through_hole') ?? null) : null,
    pads,
    fab: layerBox(fp, 'F.Fab'),
    courtyard: layerBox(fp, 'F.CrtYd'),
  };
}

function layerBox(fp: SNode[], layer: string): Box | null {
  const pts: Array<[number, number]> = [];
  for (const g of fp) {
    const h = head(g);
    if (!h || !/^fp_(line|rect|circle|poly|arc)$/.test(h)) continue;
    if (atom(child(g, 'layer'), 1) !== layer) continue;
    const xy = (n: SNode[] | undefined) => { const x = num(n, 1), y = num(n, 2); if (x !== undefined && y !== undefined) pts.push([x, y]); };
    if (h === 'fp_circle') {
      const c = child(g, 'center'), e = child(g, 'end');
      const cx = num(c, 1), cy = num(c, 2), ex = num(e, 1), ey = num(e, 2);
      if (cx !== undefined && cy !== undefined && ex !== undefined && ey !== undefined) {
        const r = Math.hypot(ex - cx, ey - cy);
        pts.push([cx - r, cy - r], [cx + r, cy + r]);
      }
    } else if (h === 'fp_poly') {
      for (const p of children(child(g, 'pts'), 'xy')) xy(p);
    } else {
      xy(child(g, 'start')); xy(child(g, 'end')); xy(child(g, 'mid'));
    }
  }
  if (!pts.length) return null;
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const FAMILY_RE = /^(DIP|SOIC|SOP|TSSOP|SSOP|MSOP|LQFP|TQFP|QFP|QFN|DFN|BGA|SOT-23|SOT-223|SOT-89|TO-92|TO-220|TO-247|TO-252|TO-263|SMA|SMB|SMC|SOD-123|SOD-323)/i;

/** Посадочное место KiCad → корпус каталога. Предупреждения — о том, что упрощено. */
export function footprintToPackage(fp: KicadFootprint): { pkg: Omit<PackageDef, 'id'>; warnings: string[] } {
  const warnings: string[] = [];
  const pads: PackageDef['pads'] = [];
  const seen = new Set<string>();
  let skippedDup = 0;
  for (const p of fp.pads) {
    if (!p.number || p.kind === 'np_thru_hole') continue; // крепёжные отверстия без номера
    if (seen.has(p.number)) { skippedDup++; continue; }
    seen.add(p.number);
    if (!(p.w > 0 && p.h > 0)) { warnings.push(`${fp.name}: площадка ${p.number} без размера — пропущена`); continue; }
    const rot = ((p.rot % 360) + 360) % 360;
    if (rot % 90 !== 0) warnings.push(`${fp.name}: площадка ${p.number} повёрнута на ${rot}° — поворот упрощён до прямого угла`);
    const swap = rot === 90 || rot === 270 || (rot % 90 !== 0 && Math.round(rot / 90) % 2 === 1);
    const shape: PackageDef['pads'][number]['shape'] = p.shape === 'circle' ? 'round' : p.shape === 'oval' ? 'oval' : 'rect';
    if (!['rect', 'roundrect', 'circle', 'oval'].includes(p.shape)) warnings.push(`${fp.name}: площадка ${p.number} сложной формы (${p.shape}) — заменена прямоугольником`);
    pads.push({ number: p.number.slice(0, 16), x: r3(p.x), y: r3(p.y), shape, w: r3(swap ? p.h : p.w), h: r3(swap ? p.w : p.h), drill: p.kind === 'thru_hole' && p.drill ? r3(p.drill) : null });
  }
  if (skippedDup) warnings.push(`${fp.name}: ${skippedDup} доп. площад(ки) с повторяющимися номерами (например, теплоотвод из нескольких частей) — импортирована одна площадка на номер`);
  const box = fp.fab ?? fp.courtyard;
  const body = box && box.x1 > box.x0 && box.y1 > box.y0 ? { x: r3(box.x0), y: r3(box.y0), w: r3(box.x1 - box.x0), h: r3(box.y1 - box.y0) } : null;
  // Шаг: наименьшее расстояние между соседними по номеру площадками.
  let pitch: number | null = null;
  const byNum = new Map(pads.map((p) => [p.number, p]));
  for (const p of pads) {
    const n = Number(p.number);
    const next = Number.isInteger(n) ? byNum.get(String(n + 1)) : undefined;
    if (next) { const d = Math.hypot(next.x - p.x, next.y - p.y); if (d > 0 && (pitch === null || d < pitch)) pitch = r3(d); }
  }
  const p1 = byNum.get('1') ?? byNum.get('A1');
  const shapes = pads.filter((p) => p !== p1).map((p) => p.shape);
  const pin1Marker = p1 && shapes.length >= 2 && shapes.every((s) => s !== p1.shape)
    ? `площадка ${p1.number} отличается формой (${p1.shape === 'rect' ? 'прямоугольная' : p1.shape === 'round' ? 'круглая' : 'овальная'}); ключ на корпусе — по даташиту`
    : null;
  const mount = fp.attr === 'smd' ? 'SMD' : fp.attr === 'through_hole' ? 'THT' : pads.some((p) => p.drill) ? 'THT' : 'SMD';
  return {
    pkg: {
      name: fp.name.slice(0, 128) || 'Корпус KiCad',
      family: (FAMILY_RE.exec(fp.name)?.[1]?.toUpperCase() ?? 'KiCad').slice(0, 32),
      pads, body, pin1Marker, mount, pitchMm: pitch, numbering: null, generator: null,
    },
    warnings,
  };
}

// ---------- Деталь ----------

const PIN_TYPE: Record<string, IcPinInput['electricalType']> = {
  input: 'input', output: 'output', bidirectional: 'bidirectional', tri_state: 'output', passive: 'passive',
  free: 'passive', unspecified: 'passive', power_in: 'power-in', power_out: 'power-out',
  open_collector: 'output', open_emitter: 'output', no_connect: 'nc',
};

/** Категория и вид обозначения по позиционному обозначению KiCad, имени и библиотеке. */
export function guessCategory(reference: string, name: string, library: string, keywords = ''): { category: string; graphic: string | null } {
  const ref = reference.replace(/[^A-Za-z]/g, '').toUpperCase();
  const t = `${name} ${library} ${keywords}`;
  if (ref === 'R' && !/potentiometer|trim/i.test(t)) return { category: 'resistor', graphic: 'iec-resistor' };
  if (ref === 'RV' || /varistor/i.test(t)) return { category: 'varistor', graphic: 'varistor' };
  if (ref === 'C') return /polar|elec|C_Pol|CP\b|CP_/i.test(t) ? { category: 'capacitor-polar', graphic: 'iec-capacitor-polar' } : { category: 'capacitor', graphic: 'iec-capacitor' };
  if (ref === 'L') return { category: 'inductor', graphic: 'iec-inductor' };
  if (ref === 'D') {
    if (/LED/i.test(t)) return { category: 'led', graphic: 'led' };
    if (/zener|D_Z|BZX|1N47\d\d/i.test(t)) return { category: 'zener', graphic: 'zener' };
    if (/bridge/i.test(t)) return { category: 'bridge', graphic: 'bridge' };
    return { category: 'diode', graphic: 'diode' };
  }
  if (ref === 'Q') {
    if (/FET|MOS|IRF|IRL/i.test(t)) return { category: 'mosfet', graphic: /P[-_ ]?CH|PMOS|Q_P|P-Channel/i.test(t) ? 'pmos' : 'nmos' };
    if (/thyristor|SCR/i.test(t)) return { category: 'thyristor', graphic: 'thyristor' };
    if (/triac/i.test(t)) return { category: 'triac', graphic: 'triac' };
    return { category: 'bjt', graphic: /PNP/i.test(t) ? 'pnp' : 'npn' };
  }
  if (ref === 'F') return { category: 'fuse', graphic: 'fuse' };
  if (ref === 'K') return { category: 'relay', graphic: null };
  if (ref === 'T' || ref === 'TR') return { category: 'transformer', graphic: null };
  if (ref === 'J' || ref === 'P' || ref === 'X') return { category: 'connector', graphic: null };
  if (ref === 'SW' || ref === 'S') return { category: 'switch', graphic: null };
  if (ref === 'U' || ref === 'IC' || ref === 'DA' || ref === 'DD') {
    if (/^MCU|microcontroller/i.test(t) || /^MCU/i.test(library)) return { category: 'mcu', graphic: null };
    if (/^(74|4xxx|CMOS|Logic)/i.test(library) || /^74|^CD4/i.test(name)) return { category: 'ic-digital', graphic: null };
    return { category: 'ic-analog', graphic: null };
  }
  return { category: 'other', graphic: null };
}

/** Тип вывода; в KiCad «земля» — тоже power_in, её узнаём по имени (GND, VSS, VEE, V-). */
function pinType(p: KicadPin): IcPinInput['electricalType'] {
  const t = PIN_TYPE[p.type] ?? 'passive';
  if (t === 'power-in' && /^(A|D|P|E|S)?GND\w*$|^V(SS|EE)\w*$|^V-$|^0V$/i.test(clean(p.name))) return 'ground';
  return t;
}

const norm = (s: string) => s.replace(/[~{}]/g, '').trim().toUpperCase();

/**
 * Стандартное обозначение, перенумерованное по выводам KiCad (соответствие по именам выводов: K/A, B/C/E, G/D/S…).
 * Если однозначно сопоставить нельзя — null (тогда символ строится прямоугольником по выводам KiCad).
 */
export function standardFromKicad(graphic: string, pins: KicadPin[]): Omit<SymbolDef, 'id'> | null {
  const std = standardSymbol(graphic);
  if (std.pins.length !== pins.length) return null;
  const unnamed = pins.every((p) => !norm(p.name) || norm(p.name) === p.number);
  if (unnamed) {
    const nums = new Set(pins.map((p) => p.number));
    return std.pins.every((p) => nums.has(p.number)) ? std : null;
  }
  const used = new Set<string>();
  const out: SymbolDef['pins'] = [];
  for (const sp of std.pins) {
    const want = norm(sp.name).replace('−', '-');
    const match = pins.filter((p) => !used.has(p.number) && norm(p.name).replace('−', '-') === want);
    if (match.length !== 1) return null;
    used.add(match[0]!.number);
    out.push({ ...sp, number: match[0]!.number });
  }
  return { ...std, pins: out };
}

export interface KicadImportInput {
  symbol: KicadSymbol;
  library: string;
  footprints: KicadFootprint[];
  /** Откуда взяты данные (адреса или пути файлов). */
  sources: string[];
  license: string | null;
}

export function kicadToBundle(input: KicadImportInput): { bundle: PartBundle; warnings: string[] } {
  const { symbol: ks, library } = input;
  const s = summarize(ks);
  const warnings: string[] = [];
  if (ks.pins.length === 0) throw new KicadError(`У символа ${ks.name} нет выводов — импортировать нечего`);
  const { category, graphic } = guessCategory(s.reference, ks.name, library, s.keywords);
  const sortedPins = [...ks.pins].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
  const symbolId = newId();
  const std = graphic ? standardFromKicad(graphic, sortedPins) : null;
  if (graphic && !std) warnings.push('Выводы символа не удалось однозначно сопоставить со стандартным обозначением — построен прямоугольник по выводам KiCad');
  const symbol: SymbolDef = std
    ? { ...std, id: symbolId }
    : {
      ...icSymbol(ks.name.slice(0, 128), sortedPins.map((p) => ({
        number: p.number.slice(0, 16), name: pinNameText(p.name).slice(0, 64), electricalType: pinType(p),
        description: p.hidden ? 'скрытый вывод в KiCad (обычно питание)' : '',
      }))),
      id: symbolId,
    };
  if (ks.units > 1) warnings.push(`В KiCad символ состоит из ${ks.units} частей (секций); здесь он собран в один прямоугольник со всеми выводами`);

  const packages: PackageDef[] = [];
  const pinMaps: PartBundle['part']['packages'] = [];
  for (const fp of input.footprints) {
    const r = footprintToPackage(fp);
    warnings.push(...r.warnings);
    const pkg: PackageDef = { ...r.pkg, id: newId() };
    const pads = new Set(pkg.pads.map((p) => p.number));
    const pinMap = symbol.pins.filter((p) => pads.has(p.number)).map((p) => ({ symbolPin: p.number, pad: p.number }));
    const missing = symbol.pins.filter((p) => !pads.has(p.number) && p.electricalType !== 'nc');
    if (missing.length) warnings.push(`${pkg.name}: нет площадок для выводов ${missing.map((p) => p.number).join(', ')} — проверьте соответствие`);
    packages.push(pkg);
    pinMaps.push({ packageId: pkg.id, pinMap });
  }

  const cat = CATEGORIES.find((c) => c.id === category)!;
  const generic = library === 'Device' || ks.name.length <= 2;
  const ideal = IDEAL_MODELS[category];
  const modelId = ideal ? newId() : null;
  const partId = newId();
  const datasheet = /^https?:\/\/\S+$/i.test(s.datasheet) && s.datasheet.length <= 2048 ? s.datasheet : null;
  const name = (generic && s.description ? s.description : ks.name).slice(0, 128);
  const notes = [
    `Импортировано из библиотеки KiCad «${library}», символ ${ks.name}${input.footprints.length ? `, посадочные места: ${input.footprints.map((f) => f.name).join(', ')}` : ''}.`,
    'Сверьте выводы, корпус и размеры площадок с даташитом своей детали.',
    s.keywords ? `Ключевые слова KiCad: ${s.keywords}.` : '',
  ].filter(Boolean).join(' ');
  const bundle: PartBundle = {
    part: {
      id: partId, name, category, refPrefix: cat.prefix, manufacturer: null,
      partNumber: generic ? null : ks.name.slice(0, 128), symbolId, packages: pinMaps, modelId,
      description: s.description.slice(0, 2000), ...PART_INFO_DEFAULTS, datasheetUrl: datasheet, values: {}, ratings: {},
      polarized: ['capacitor-polar', 'diode', 'zener', 'led', 'bridge'].includes(category),
      origin: {
        catalogPartId: partId, source: input.sources.join(' ; ').slice(0, 1024), license: input.license ? input.license.slice(0, 256) : null,
        verified: false, checkedAt: null, notes: notes.slice(0, 4000),
      },
    },
    symbol,
    packages,
    model: ideal && modelId ? { ...ideal, id: modelId } : null,
  };
  if (!bundle.model) warnings.push('Модель для расчёта не импортируется: деталь не моделируется, пока модель не будет добавлена');
  return { bundle, warnings };
}

/** «Package_DIP:DIP-8_W7.62mm» → { library, name }. */
export function splitFootprintRef(ref: string): { library: string; name: string } | null {
  const m = /^([^:]+):(.+)$/.exec(ref.trim());
  return m ? { library: m[1]!, name: m[2]! } : null;
}

/** Безопасное имя библиотеки/символа/посадочного места KiCad (для адреса или пути). */
export const isSafeKicadName = (s: string) => /^[A-Za-z0-9_.+\-,()]{1,160}$/.test(s) && !s.includes('..');
