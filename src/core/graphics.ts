/**
 * Условные графические обозначения (IEC 60617 / ГОСТ 2.728–2.730, 2.743-подобные) как набор простых
 * фигур. Один источник рисунка для полотна (React), превью каталога и экспорта SVG/PNG/PDF.
 * Координаты — в системе символа (до поворота), шаг сетки 10 единиц = 2,54 мм.
 */
import type { SymbolDef } from './model';

export type Prim =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; cls?: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; cls?: string }
  | { t: 'circle'; cx: number; cy: number; r: number; cls?: string }
  | { t: 'path'; d: string; cls?: string }
  | { t: 'text'; x: number; y: number; text: string; cls?: string; anchor?: 'start' | 'middle' | 'end' };

const L = (x1: number, y1: number, x2: number, y2: number, cls?: string): Prim => ({ t: 'line', x1, y1, x2, y2, cls });
const R = (x: number, y: number, w: number, h: number, cls?: string): Prim => ({ t: 'rect', x, y, w, h, cls });
const P = (d: string, cls?: string): Prim => ({ t: 'path', d, cls });
const T = (x: number, y: number, text: string, cls = 'sym-sign', anchor?: 'start' | 'middle' | 'end'): Prim => ({ t: 'text', x, y, text, cls, anchor });

function diode(zener = false, led = false): Prim[] {
  return [
    L(-30, 0, -8, 0), P('M -8 -9 L -8 9 L 8 0 Z', 'fill'), L(8, -9, 8, 9, 'thick'),
    ...(zener ? [P('M 8 -9 L 12 -12 M 8 9 L 4 12')] : []),
    L(8, 0, 30, 0),
    ...(led ? [P('M 2 -12 L 9 -19 M 6 -19 L 9 -19 L 9 -16 M 8 -10 L 15 -17 M 12 -17 L 15 -17 L 15 -14')] : []),
  ];
}

function bjt(pnp: boolean): Prim[] {
  const s = pnp ? -1 : 1;
  return [
    { t: 'circle', cx: 2, cy: 0, r: 15 }, L(-30, 0, -6, 0), L(-6, -10, -6, 10, 'thick'),
    L(-6, -5 * s, 10, -18 * s), L(10, -18 * s, 10, -30 * s), L(-6, 5 * s, 10, 18 * s), L(10, 18 * s, 10, 30 * s),
    pnp ? P('M -1 -11 L -6 -6 L 1 -5') : P('M 3 10 L 9 17 L 1 17'),
  ];
}

function mos(p: boolean): Prim[] {
  return [
    { t: 'circle', cx: 2, cy: 0, r: 16 }, L(-30, p ? -10 : 10, -8, p ? -10 : 10), L(-8, -10, -8, 10),
    L(-4, -12, -4, -5, 'thick'), L(-4, -3, -4, 3, 'thick'), L(-4, 5, -4, 12, 'thick'),
    L(-4, -9, 10, -9), L(10, -9, 10, -30), L(-4, 9, 10, 9), L(10, 9, 10, 30), L(-4, 0, 10, 0), L(10, 0, 10, 9),
    p ? P('M 2 -3 L -2 0 L 2 3') : P('M 0 -3 L 4 0 L 0 3'),
  ];
}

export function boxOf(symbol: SymbolDef) {
  if (symbol.box) return symbol.box;
  const xs = symbol.pins.map((p) => p.x), ys = symbol.pins.map((p) => p.y);
  const x = Math.min(-20, ...xs) + 20, y = Math.min(-20, ...ys);
  return { x, y, w: Math.max(40, Math.max(20, ...xs) - 20 - x), h: Math.max(20, ...ys) - y };
}

function boxSymbol(symbol: SymbolDef): Prim[] {
  const b = boxOf(symbol);
  const out: Prim[] = [R(b.x, b.y, b.w, b.h)];
  for (const p of symbol.pins) {
    const left = p.x < b.x, right = p.x > b.x + b.w, top = p.y < b.y, bottom = p.y > b.y + b.h;
    const ex = left ? b.x : right ? b.x + b.w : p.x;
    const ey = top ? b.y : bottom ? b.y + b.h : p.y;
    out.push(L(p.x, p.y, ex, ey));
    out.push(top || bottom ? T(p.x + 3, (p.y + ey) / 2 + 3, p.number, 'pin-num', 'start') : T((p.x + ex) / 2, (p.y + ey) / 2 - 2, p.number, 'pin-num', 'middle'));
    out.push(T(left ? b.x + 3 : right ? b.x + b.w - 3 : p.x, top ? b.y + 10 : bottom ? b.y + b.h - 3 : p.y + 3.5, p.name, 'pin-label', left ? 'start' : right ? 'end' : 'middle'));
  }
  return out;
}

/** Фигуры обозначения. Неизвестный вид рисуется прямоугольником по выводам. */
export function symbolPrims(symbol: SymbolDef): Prim[] {
  switch (symbol.graphic) {
    case 'iec-resistor': return [L(-30, 0, -16, 0), R(-16, -6, 32, 12), L(16, 0, 30, 0)];
    case 'varistor': return [L(-30, 0, -16, 0), R(-16, -6, 32, 12), P('M -20 10 L -12 10 L 14 -10'), L(16, 0, 30, 0), T(-6, -9, 'U')];
    case 'fuse': return [L(-30, 0, -16, 0), R(-16, -5, 32, 10), L(-16, 0, 16, 0), L(16, 0, 30, 0)];
    case 'iec-capacitor': return [L(-30, 0, -4, 0), L(-4, -12, -4, 12, 'thick'), L(4, -12, 4, 12, 'thick'), L(4, 0, 30, 0)];
    case 'iec-capacitor-polar': return [L(-30, 0, -4, 0), L(-4, -12, -4, 12, 'thick'), R(3, -12, 4, 24, 'fill'), L(7, 0, 30, 0), T(-15, -14, '+')];
    case 'iec-inductor': return [L(-40, 0, -24, 0), P('M -24 0 A 6 6 0 0 1 -12 0 A 6 6 0 0 1 0 0 A 6 6 0 0 1 12 0 A 6 6 0 0 1 24 0'), L(24, 0, 40, 0)];
    case 'diode': return diode();
    case 'zener': return diode(true);
    case 'led': return diode(false, true);
    case 'bridge': return [
      P('M -28 0 L 0 -28 L 28 0 L 0 28 Z'), L(-40, 0, -28, 0), L(28, 0, 40, 0), L(0, -40, 0, -28), L(0, 28, 0, 40),
      P('M -18 -6 L -10 -14 L -6 -10 Z', 'fill'), P('M 6 -10 L 14 -18 L 18 -14 Z', 'fill'), P('M -18 6 L -10 14 L -14 18 Z', 'fill'), P('M 10 14 L 18 6 L 14 2 Z', 'fill'),
    ];
    case 'npn': return bjt(false);
    case 'pnp': return bjt(true);
    case 'nmos': return mos(false);
    case 'pmos': return mos(true);
    case 'thyristor': return [...diode(), L(8, 6, 10, 30)];
    case 'triac': return [
      L(-30, 0, -8, 0), L(8, 0, 30, 0), L(-8, -12, -8, 12, 'thick'), L(8, -12, 8, 12, 'thick'),
      P('M -8 -12 L 8 -6 L -8 0 Z', 'fill'), P('M 8 0 L -8 6 L 8 12 Z', 'fill'), L(8, 8, 10, 30),
    ];
    case 'switch': return [L(-30, 0, -12, 0), L(-12, 0, 12, -12), L(12, 0, 30, 0)];
    case 'relay': return [
      R(-30, -12, 20, 24), L(-40, -20, -20, -20), L(-20, -20, -20, -12), L(-40, 20, -20, 20), L(-20, 20, -20, 12),
      L(40, 0, 20, 0), L(20, 0, 30, -16), L(40, -20, 28, -20), L(40, 20, 24, 20), L(24, 20, 24, 6), L(-10, 0, 18, 0, 'dash'),
    ];
    case 'transformer': return [
      L(-40, -30, -12, -30), L(-40, 30, -12, 30),
      P('M -12 -30 A 7.5 7.5 0 0 1 -12 -15 A 7.5 7.5 0 0 1 -12 0 A 7.5 7.5 0 0 1 -12 15 A 7.5 7.5 0 0 1 -12 30'),
      L(-3, -28, -3, 28), L(3, -28, 3, 28),
      P('M 12 -30 A 7.5 7.5 0 0 0 12 -15 A 7.5 7.5 0 0 0 12 0 A 7.5 7.5 0 0 0 12 15 A 7.5 7.5 0 0 0 12 30'),
      L(12, -30, 40, -30), L(12, 30, 40, 30),
    ];
    case 'iec-dc-source': return [
      L(0, -30, 0, -15), { t: 'circle', cx: 0, cy: 0, r: 15 }, L(0, -10, 0, 10), P('M -4 -6 L 0 -10 L 4 -6', 'arrow'), T(7, -18, '+'), L(0, 15, 0, 30),
    ];
    case 'iec-ac-source': return [
      L(0, -30, 0, -15), { t: 'circle', cx: 0, cy: 0, r: 15 }, P('M -9 0 C -6 -9 -3 -9 0 0 C 3 9 6 9 9 0', 'nofill'), T(7, -18, '+'), L(0, 15, 0, 30),
    ];
    case 'iec-pulse-source': return [
      L(0, -30, 0, -15), { t: 'circle', cx: 0, cy: 0, r: 15 }, P('M -9 5 L -5 5 L -5 -5 L 1 -5 L 1 5 L 5 5 L 5 -5 L 9 -5', 'nofill'), T(7, -18, '+'), L(0, 15, 0, 30),
    ];
    case 'iec-current-source': return [
      // Источник тока (ГОСТ 2.728): стрелка с двойным острием — отличается от источника ЭДС.
      L(0, -30, 0, -15), { t: 'circle', cx: 0, cy: 0, r: 15 }, L(0, 10, 0, -10), P('M -4 -5 L 0 -10 L 4 -5', 'arrow'), P('M -4 -1 L 0 -6 L 4 -1', 'arrow'), L(0, 15, 0, 30),
    ];
    case 'ground': return [L(0, -10, 0, 0), L(-12, 0, 12, 0, 'thick'), L(-8, 4, 8, 4), L(-4, 8, 4, 8)];
    default: return boxSymbol(symbol);
  }
}

/** Габарит символа (для подписи, выделения и попадания мышью). */
export function symbolBounds(symbol: SymbolDef): { x: number; y: number; w: number; h: number } {
  switch (symbol.graphic) {
    case 'iec-resistor': case 'iec-capacitor': case 'iec-capacitor-polar': case 'diode': case 'zener': case 'led':
    case 'varistor': case 'fuse': case 'switch':
      return { x: -30, y: -13, w: 60, h: 26 };
    case 'thyristor': case 'triac': return { x: -30, y: -13, w: 60, h: 43 };
    case 'iec-inductor': return { x: -40, y: -10, w: 80, h: 20 };
    case 'bridge': return { x: -40, y: -40, w: 80, h: 80 };
    case 'npn': case 'pnp': case 'nmos': case 'pmos': return { x: -30, y: -30, w: 48, h: 60 };
    case 'relay': return { x: -40, y: -24, w: 80, h: 48 };
    case 'transformer': return { x: -40, y: -32, w: 80, h: 64 };
    case 'iec-dc-source': case 'iec-ac-source': case 'iec-pulse-source': case 'iec-current-source': return { x: -16, y: -30, w: 32, h: 60 };
    case 'ground': return { x: -13, y: -10, w: 26, h: 20 };
    default: {
      const xs = symbol.pins.map((p) => p.x), ys = symbol.pins.map((p) => p.y);
      const b = symbol.box;
      const x = Math.min(b?.x ?? 0, ...xs), y = Math.min(b?.y ?? 0, ...ys);
      const X = Math.max(b ? b.x + b.w : 0, ...xs), Y = Math.max(b ? b.y + b.h : 0, ...ys);
      return { x, y, w: X - x, h: Y - y };
    }
  }
}

/**
 * Текст в повёрнутой/отражённой детали должен читаться: отражение и поворот на 180° не переворачивают
 * надписи. Возвращает преобразование SVG для текста (вокруг его точки привязки) и выравнивание.
 */
export function readableText(p: Extract<Prim, { t: 'text' }>, rotation: number, mirrored: boolean): { transform: string | undefined; anchor: 'start' | 'middle' | 'end' } {
  const a = p.anchor ?? 'start';
  const flip = (x: 'start' | 'middle' | 'end') => (x === 'start' ? 'end' : x === 'end' ? 'start' : 'middle');
  const parts: string[] = [];
  let anchor = a;
  if (mirrored) { parts.push(`translate(${2 * p.x} 0) scale(-1 1)`); anchor = flip(anchor); }
  // После отражения угол поворота на экране меняет знак; 180° в обоих случаях переворачивает текст.
  if (rotation === 180) { parts.push(`rotate(180 ${p.x} ${p.y - 3.5})`); anchor = flip(anchor); }
  return { transform: parts.length ? parts.join(' ') : undefined, anchor };
}

/** Символ метки цепи: флажок с именем (net) или стрелка/черта питания (power). Точка подключения — (0,0). */
export function labelPrims(name: string, kind: 'net' | 'power'): Prim[] {
  if (kind === 'power') {
    const neg = name.startsWith('-') || /^V(SS|EE)/i.test(name);
    return neg
      ? [L(0, 0, 0, -10), L(-8, -10, 8, -10, 'thick'), T(0, -14, name, 'label-text', 'middle')]
      : [L(0, 0, 0, -12), P('M -6 -8 L 0 -14 L 6 -8', 'nofill'), T(0, -18, name, 'label-text', 'middle')];
  }
  const w = Math.max(16, name.length * 6.6 + 8);
  return [P(`M 0 0 L 5 -6 L ${w + 5} -6 L ${w + 5} 6 L 5 6 Z`, 'label-flag'), T(8, 4, name, 'label-text', 'start')];
}
