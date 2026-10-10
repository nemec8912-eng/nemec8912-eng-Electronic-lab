/**
 * Условные графические обозначения (IEC 60617 / ГОСТ 2.728–2.730, 2.743-подобные).
 * Рисуются в системе координат символа (до поворота); выводы — в точках, заданных в SymbolDef.
 */
import type { SymbolDef } from '../core/model';

const Diode = ({ zener = false, led = false }: { zener?: boolean; led?: boolean }) => (
  <>
    <line x1={-30} y1={0} x2={-8} y2={0} />
    <path d="M -8 -9 L -8 9 L 8 0 Z" className="fill" />
    <line x1={8} y1={-9} x2={8} y2={9} className="thick" />
    {zener && <path d="M 8 -9 L 12 -12 M 8 9 L 4 12" />}
    <line x1={8} y1={0} x2={30} y2={0} />
    {led && <path d="M 2 -12 L 9 -19 M 6 -19 L 9 -19 L 9 -16 M 8 -10 L 15 -17 M 12 -17 L 15 -17 L 15 -14" />}
  </>
);

const Bjt = ({ pnp }: { pnp: boolean }) => (
  <>
    <circle cx={2} cy={0} r={15} />
    <line x1={-30} y1={0} x2={-6} y2={0} />
    <line x1={-6} y1={-10} x2={-6} y2={10} className="thick" />
    <line x1={-6} y1={pnp ? 5 : -5} x2={10} y2={pnp ? 18 : -18} />
    <line x1={10} y1={pnp ? 18 : -18} x2={10} y2={pnp ? 30 : -30} />
    <line x1={-6} y1={pnp ? -5 : 5} x2={10} y2={pnp ? -18 : 18} />
    <line x1={10} y1={pnp ? -18 : 18} x2={10} y2={pnp ? -30 : 30} />
    {pnp ? <path d="M -1 -11 L -6 -6 L 1 -5" /> : <path d="M 3 10 L 9 17 L 1 17" />}
  </>
);

const Mos = ({ p }: { p: boolean }) => (
  <>
    <circle cx={2} cy={0} r={16} />
    <line x1={-30} y1={p ? -10 : 10} x2={-8} y2={p ? -10 : 10} />
    <line x1={-8} y1={-10} x2={-8} y2={10} />
    <line x1={-4} y1={-12} x2={-4} y2={-5} className="thick" />
    <line x1={-4} y1={-3} x2={-4} y2={3} className="thick" />
    <line x1={-4} y1={5} x2={-4} y2={12} className="thick" />
    <line x1={-4} y1={-9} x2={10} y2={-9} /><line x1={10} y1={-9} x2={10} y2={-30} />
    <line x1={-4} y1={9} x2={10} y2={9} /><line x1={10} y1={9} x2={10} y2={30} />
    <line x1={-4} y1={0} x2={10} y2={0} /><line x1={10} y1={0} x2={10} y2={9} />
    {p ? <path d="M 2 -3 L -2 0 L 2 3" /> : <path d="M 0 -3 L 4 0 L 0 3" />}
  </>
);

export function SymbolGraphic({ symbol }: { symbol: SymbolDef }) {
  switch (symbol.graphic) {
    case 'iec-resistor':
      return <g className="sym"><line x1={-30} y1={0} x2={-16} y2={0} /><rect x={-16} y={-6} width={32} height={12} /><line x1={16} y1={0} x2={30} y2={0} /></g>;
    case 'varistor':
      return <g className="sym"><line x1={-30} y1={0} x2={-16} y2={0} /><rect x={-16} y={-6} width={32} height={12} /><path d="M -20 10 L -12 10 L 14 -10" /><line x1={16} y1={0} x2={30} y2={0} /><text x={-6} y={-9} className="sym-sign">U</text></g>;
    case 'fuse':
      return <g className="sym"><line x1={-30} y1={0} x2={-16} y2={0} /><rect x={-16} y={-5} width={32} height={10} /><line x1={-16} y1={0} x2={16} y2={0} /><line x1={16} y1={0} x2={30} y2={0} /></g>;
    case 'iec-capacitor':
      return <g className="sym"><line x1={-30} y1={0} x2={-4} y2={0} /><line x1={-4} y1={-12} x2={-4} y2={12} className="thick" /><line x1={4} y1={-12} x2={4} y2={12} className="thick" /><line x1={4} y1={0} x2={30} y2={0} /></g>;
    case 'iec-capacitor-polar':
      return (
        <g className="sym">
          <line x1={-30} y1={0} x2={-4} y2={0} /><line x1={-4} y1={-12} x2={-4} y2={12} className="thick" />
          <rect x={3} y={-12} width={4} height={24} className="fill" /><line x1={7} y1={0} x2={30} y2={0} />
          <text x={-15} y={-14} className="sym-sign">+</text>
        </g>
      );
    case 'iec-inductor':
      return (
        <g className="sym">
          <line x1={-40} y1={0} x2={-24} y2={0} />
          <path d="M -24 0 A 6 6 0 0 1 -12 0 A 6 6 0 0 1 0 0 A 6 6 0 0 1 12 0 A 6 6 0 0 1 24 0" />
          <line x1={24} y1={0} x2={40} y2={0} />
        </g>
      );
    case 'diode': return <g className="sym"><Diode /></g>;
    case 'zener': return <g className="sym"><Diode zener /></g>;
    case 'led': return <g className="sym"><Diode led /></g>;
    case 'bridge':
      return (
        <g className="sym">
          <path d="M -28 0 L 0 -28 L 28 0 L 0 28 Z" />
          <line x1={-40} y1={0} x2={-28} y2={0} /><line x1={28} y1={0} x2={40} y2={0} />
          <line x1={0} y1={-40} x2={0} y2={-28} /><line x1={0} y1={28} x2={0} y2={40} />
          <path d="M -18 -6 L -10 -14 L -6 -10 Z" className="fill" /><path d="M 6 -10 L 14 -18 L 18 -14 Z" className="fill" />
          <path d="M -18 6 L -10 14 L -14 18 Z" className="fill" /><path d="M 10 14 L 18 6 L 14 2 Z" className="fill" />
        </g>
      );
    case 'npn': return <g className="sym"><Bjt pnp={false} /></g>;
    case 'pnp': return <g className="sym"><Bjt pnp /></g>;
    case 'nmos': return <g className="sym"><Mos p={false} /></g>;
    case 'pmos': return <g className="sym"><Mos p /></g>;
    case 'thyristor':
      return <g className="sym"><Diode /><line x1={8} y1={6} x2={10} y2={30} /></g>;
    case 'triac':
      return (
        <g className="sym">
          <line x1={-30} y1={0} x2={-8} y2={0} /><line x1={8} y1={0} x2={30} y2={0} />
          <line x1={-8} y1={-12} x2={-8} y2={12} className="thick" /><line x1={8} y1={-12} x2={8} y2={12} className="thick" />
          <path d="M -8 -12 L 8 -6 L -8 0 Z" className="fill" /><path d="M 8 0 L -8 6 L 8 12 Z" className="fill" />
          <line x1={8} y1={8} x2={10} y2={30} />
        </g>
      );
    case 'switch':
      return <g className="sym"><line x1={-30} y1={0} x2={-12} y2={0} /><line x1={-12} y1={0} x2={12} y2={-12} /><line x1={12} y1={0} x2={30} y2={0} /></g>;
    case 'relay':
      return (
        <g className="sym">
          <rect x={-30} y={-12} width={20} height={24} />
          <line x1={-40} y1={-20} x2={-20} y2={-20} /><line x1={-20} y1={-20} x2={-20} y2={-12} />
          <line x1={-40} y1={20} x2={-20} y2={20} /><line x1={-20} y1={20} x2={-20} y2={12} />
          <line x1={40} y1={0} x2={20} y2={0} /><line x1={20} y1={0} x2={30} y2={-16} />
          <line x1={40} y1={-20} x2={28} y2={-20} /><line x1={40} y1={20} x2={24} y2={20} /><line x1={24} y1={20} x2={24} y2={6} />
          <line x1={-10} y1={0} x2={18} y2={0} className="dash" />
        </g>
      );
    case 'transformer':
      return (
        <g className="sym">
          <line x1={-40} y1={-30} x2={-12} y2={-30} /><line x1={-40} y1={30} x2={-12} y2={30} />
          <path d="M -12 -30 A 7.5 7.5 0 0 1 -12 -15 A 7.5 7.5 0 0 1 -12 0 A 7.5 7.5 0 0 1 -12 15 A 7.5 7.5 0 0 1 -12 30" />
          <line x1={-3} y1={-28} x2={-3} y2={28} /><line x1={3} y1={-28} x2={3} y2={28} />
          <path d="M 12 -30 A 7.5 7.5 0 0 0 12 -15 A 7.5 7.5 0 0 0 12 0 A 7.5 7.5 0 0 0 12 15 A 7.5 7.5 0 0 0 12 30" />
          <line x1={12} y1={-30} x2={40} y2={-30} /><line x1={12} y1={30} x2={40} y2={30} />
        </g>
      );
    case 'iec-dc-source':
      return (
        <g className="sym">
          <line x1={0} y1={-30} x2={0} y2={-15} /><circle cx={0} cy={0} r={15} />
          <line x1={0} y1={-10} x2={0} y2={10} /><path d="M -4 -6 L 0 -10 L 4 -6" className="arrow" />
          <text x={7} y={-18} className="sym-sign">+</text><line x1={0} y1={15} x2={0} y2={30} />
        </g>
      );
    case 'ground':
      return <g className="sym"><line x1={0} y1={-10} x2={0} y2={0} /><line x1={-12} y1={0} x2={12} y2={0} className="thick" /><line x1={-8} y1={4} x2={8} y2={4} /><line x1={-4} y1={8} x2={4} y2={8} /></g>;
    default:
      return <BoxSymbol symbol={symbol} />;
  }
}

/** Прямоугольник микросхемы: отрезки выводов до корпуса, номер у отрезка, имя внутри. */
function BoxSymbol({ symbol }: { symbol: SymbolDef }) {
  const b = symbol.box ?? boxFromPins(symbol);
  return (
    <g className="sym">
      <rect x={b.x} y={b.y} width={b.w} height={b.h} />
      {symbol.pins.map((p) => {
        const left = p.x < b.x, right = p.x > b.x + b.w, top = p.y < b.y, bottom = p.y > b.y + b.h;
        const ex = left ? b.x : right ? b.x + b.w : p.x;
        const ey = top ? b.y : bottom ? b.y + b.h : p.y;
        const nameX = left ? b.x + 3 : right ? b.x + b.w - 3 : p.x;
        const nameY = top ? b.y + 10 : bottom ? b.y + b.h - 3 : p.y + 3.5;
        const anchor = left ? 'start' : right ? 'end' : 'middle';
        return (
          <g key={p.number}>
            <line x1={p.x} y1={p.y} x2={ex} y2={ey} />
            {top || bottom
              ? <text x={p.x + 3} y={(p.y + ey) / 2 + 3} className="pin-num" textAnchor="start">{p.number}</text>
              : <text x={(p.x + ex) / 2} y={(p.y + ey) / 2 - 2} className="pin-num" textAnchor="middle">{p.number}</text>}
            <text x={nameX} y={nameY} className="pin-label" textAnchor={anchor}>{p.name}</text>
          </g>
        );
      })}
    </g>
  );
}

function boxFromPins(symbol: SymbolDef) {
  const xs = symbol.pins.map((p) => p.x), ys = symbol.pins.map((p) => p.y);
  const x = Math.min(-20, ...xs) + 20, y = Math.min(-20, ...ys);
  return { x, y, w: Math.max(40, Math.max(20, ...xs) - 20 - x), h: Math.max(20, ...ys) - y };
}

/** Габарит символа для подписи и попадания мышью (в координатах символа). */
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
    case 'iec-dc-source': return { x: -16, y: -30, w: 32, h: 60 };
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
