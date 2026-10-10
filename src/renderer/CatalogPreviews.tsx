/** Превью условного обозначения и посадочного места (вид сверху, мм) для каталога и редактора. */
import type { PackageDef, SymbolDef } from '../core/model';
import { SymbolGraphic, symbolBounds } from './symbols';

export function SymbolPreview({ symbol, height = 160 }: { symbol: SymbolDef; height?: number }) {
  const b = symbolBounds(symbol);
  const pad = 24;
  const vb = `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`;
  return (
    <svg className="preview symbol-preview" viewBox={vb} style={{ height }} role="img" aria-label={`УГО: ${symbol.name}`}>
      <SymbolGraphic symbol={symbol} />
      {symbol.graphic !== 'box' && symbol.pins.map((p) => (
        <g key={p.number}>
          <circle cx={p.x} cy={p.y} r={2.5} className="pin-dot-preview" />
          <text x={p.x} y={p.y - 6} className="pin-num" textAnchor="middle">{p.number}{p.name && p.name !== p.number ? ` ${p.name}` : ''}</text>
        </g>
      ))}
    </svg>
  );
}

/** Посадочное место: площадки с номерами, отверстия, контур корпуса, ключ первого вывода выделен. */
export function PackagePreview({ pkg, height = 180, highlight }: { pkg: PackageDef; height?: number; highlight?: string | null }) {
  const xs = pkg.pads.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]).concat(pkg.body ? [pkg.body.x, pkg.body.x + pkg.body.w] : []);
  const ys = pkg.pads.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2]).concat(pkg.body ? [pkg.body.y, pkg.body.y + pkg.body.h] : []);
  if (xs.length === 0) return <p className="muted small">Нет площадок</p>;
  const m = 1.5;
  const x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m, w = Math.max(...xs) + m - x0, h = Math.max(...ys) + m - y0;
  const font = Math.max(0.5, Math.min(1.2, Math.min(...pkg.pads.map((p) => Math.min(p.w, p.h))) * 0.7));
  const first = pkg.pads[0];
  return (
    <svg className="preview package-preview" viewBox={`${x0} ${y0} ${w} ${h}`} style={{ height }} role="img" aria-label={`Корпус ${pkg.name}`}>
      {pkg.body && <rect x={pkg.body.x} y={pkg.body.y} width={pkg.body.w} height={pkg.body.h} className="pkg-body" />}
      {pkg.pads.map((p) => (
        <g key={p.number} className={`pkg-pad ${p.number === '1' || p.number === 'A1' ? 'first' : ''} ${highlight === p.number ? 'hl' : ''}`} data-pad-number={p.number}>
          {p.shape === 'rect'
            ? <rect x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} />
            : <ellipse cx={p.x} cy={p.y} rx={p.w / 2} ry={p.h / 2} />}
          {p.drill && <circle cx={p.x} cy={p.y} r={p.drill / 2} className="pkg-hole" />}
          <text x={p.x} y={p.y + font * 0.35} fontSize={font} textAnchor="middle" className="pkg-num">{p.number}</text>
        </g>
      ))}
      {first && pkg.pads.length > 2 && <circle cx={first.x - first.w / 2 - 0.6} cy={first.y - first.h / 2 - 0.6} r={0.35} className="pkg-key" />}
    </svg>
  );
}
