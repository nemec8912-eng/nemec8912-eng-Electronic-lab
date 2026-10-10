/**
 * Условные графические обозначения (IEC 60617 / ГОСТ 2.728-подобные): резистор — прямоугольник,
 * конденсатор — две пластины, источник ЭДС — окружность со знаками полярности, земля — три убывающие линии.
 * Рисуются в системе координат символа (до поворота); выводы — в точках, заданных в SymbolDef.
 */
import type { SymbolDef } from '../core/model';

export function SymbolGraphic({ symbol }: { symbol: SymbolDef }) {
  switch (symbol.graphic) {
    case 'iec-resistor':
      return (
        <g className="sym">
          <line x1={-30} y1={0} x2={-16} y2={0} />
          <rect x={-16} y={-6} width={32} height={12} />
          <line x1={16} y1={0} x2={30} y2={0} />
        </g>
      );
    case 'iec-capacitor':
      return (
        <g className="sym">
          <line x1={-30} y1={0} x2={-4} y2={0} />
          <line x1={-4} y1={-12} x2={-4} y2={12} className="thick" />
          <line x1={4} y1={-12} x2={4} y2={12} className="thick" />
          <line x1={4} y1={0} x2={30} y2={0} />
        </g>
      );
    case 'iec-dc-source':
      return (
        <g className="sym">
          <line x1={0} y1={-30} x2={0} y2={-15} />
          <circle cx={0} cy={0} r={15} />
          <line x1={0} y1={-10} x2={0} y2={10} />
          <path d="M -4 -6 L 0 -10 L 4 -6" className="arrow" />
          <text x={7} y={-18} className="sym-sign">+</text>
          <line x1={0} y1={15} x2={0} y2={30} />
        </g>
      );
    case 'ground':
      return (
        <g className="sym">
          <line x1={0} y1={-10} x2={0} y2={0} />
          <line x1={-12} y1={0} x2={12} y2={0} className="thick" />
          <line x1={-8} y1={4} x2={8} y2={4} />
          <line x1={-4} y1={8} x2={4} y2={8} />
        </g>
      );
    default: {
      const xs = symbol.pins.map((p) => p.x), ys = symbol.pins.map((p) => p.y);
      const minX = Math.min(-20, ...xs) + 10, maxX = Math.max(20, ...xs) - 10;
      const minY = Math.min(-15, ...ys), maxY = Math.max(15, ...ys);
      return (
        <g className="sym">
          <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} />
          {symbol.pins.map((p) => <text key={p.number} x={p.x} y={p.y - 4} className="pin-label">{p.name}</text>)}
        </g>
      );
    }
  }
}

/** Габарит символа для подписи и попадания мышью (в координатах символа). */
export function symbolBounds(symbol: SymbolDef): { x: number; y: number; w: number; h: number } {
  switch (symbol.graphic) {
    case 'iec-resistor':
    case 'iec-capacitor':
      return { x: -30, y: -13, w: 60, h: 26 };
    case 'iec-dc-source':
      return { x: -16, y: -30, w: 32, h: 60 };
    case 'ground':
      return { x: -13, y: -10, w: 26, h: 20 };
    default: {
      const xs = symbol.pins.map((p) => p.x), ys = symbol.pins.map((p) => p.y);
      const x = Math.min(-20, ...xs), y = Math.min(-15, ...ys);
      return { x, y, w: Math.max(20, ...xs) - x, h: Math.max(15, ...ys) - y };
    }
  }
}
