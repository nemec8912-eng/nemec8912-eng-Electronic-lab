/**
 * График результатов расчёта: время, развёртка DC или частота (логарифмическая ось), несколько кривых
 * (параметрический прогон), сетка с «круглыми» делениями и курсор с показаниями под мышью.
 */
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { formatQuantity } from '../core/library';

export interface Series { label: string; y: number[]; color?: string }

const COLORS = ['#7cf29b', '#ffd166', '#6fb3ff', '#ff8fa3', '#c792ea', '#5eead4', '#fca5a5', '#fde68a', '#a5b4fc', '#f9a8d4', '#86efac', '#fdba74'];

function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export function Plot({ x, series, xUnit, yUnit, logX = false, height = 170, ariaLabel, yFormat }: {
  x: number[];
  series: Series[];
  xUnit: string;
  yUnit: string;
  logX?: boolean;
  height?: number;
  ariaLabel: string;
  yFormat?: (v: number) => string;
}) {
  const W = 320, H = height, L = 50, B = 22, T = 8, R = 10;
  const svgRef = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const fy = yFormat ?? ((v: number) => formatQuantity(v, yUnit, 3));
  const geo = useMemo(() => {
    const fin = (v: number) => Number.isFinite(v);
    const xs = x.filter((v) => fin(v) && (!logX || v > 0));
    if (xs.length < 2) return null;
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x1 === x0) x1 = x0 + 1;
    const ys = series.flatMap((s) => s.y.filter(fin));
    if (!ys.length) return null;
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y1 - y0 < 1e-12 * Math.max(1, Math.abs(y1))) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.08;
    y0 = y0 >= 0 && !yFormat ? Math.max(0, y0 - pad) : y0 - pad;
    y1 = y1 <= 0 && !yFormat ? Math.min(0, y1 + pad) : y1 + pad;
    const tx = (v: number) => (logX ? Math.log10(v) : v);
    const X0 = tx(x0), X1 = tx(x1);
    const px = (v: number) => L + ((tx(v) - X0) / (X1 - X0)) * (W - L - R);
    const py = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const xt = logX
      ? Array.from({ length: Math.floor(Math.log10(x1)) - Math.ceil(Math.log10(x0)) + 1 }, (_, i) => 10 ** (Math.ceil(Math.log10(x0)) + i))
      : niceTicks(x0, x1, 4);
    return { x0, x1, y0, y1, px, py, xt, yt: niceTicks(y0, y1, 4) };
  }, [x, series, logX, H, yFormat]);
  if (!geo) return <p className="muted small">Нет данных для графика</p>;
  const { px, py, xt, yt } = geo;
  const step = Math.max(1, Math.floor(x.length / 700));
  const paths = series.map((s) => {
    const pts: string[] = [];
    for (let i = 0; i < x.length; i += step) {
      const yv = s.y[i];
      if (yv === undefined || !Number.isFinite(yv) || (logX && !(x[i]! > 0))) continue;
      pts.push(`${px(x[i]!).toFixed(1)},${py(yv).toFixed(1)}`);
    }
    return pts.join(' ');
  });
  const onMove = (e: MouseEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const sx = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    for (let i = 0; i < x.length; i++) { const d = Math.abs(px(x[i]!) - sx); if (d < bd) { bd = d; best = i; } }
    setCursor(best);
  };
  return (
    <div className="plot">
      <svg ref={svgRef} className="trace" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseMove={onMove} onMouseLeave={() => setCursor(null)}>
        <rect x={L} y={T} width={W - L - R} height={H - T - B} className="trace-bg" />
        {xt.map((v) => <line key={`x${v}`} x1={px(v)} x2={px(v)} y1={T} y2={H - B} className="trace-grid" />)}
        {yt.map((v) => <line key={`y${v}`} x1={L} x2={W - R} y1={py(v)} y2={py(v)} className={v === 0 ? 'trace-zero' : 'trace-grid'} />)}
        {paths.map((d, i) => <polyline key={i} points={d} className="trace-line" style={{ stroke: series[i]!.color ?? COLORS[i % COLORS.length] }} />)}
        {yt.map((v) => <text key={`ty${v}`} x={L - 4} y={py(v) + 3} className="trace-axis" textAnchor="end">{fy(v)}</text>)}
        {xt.map((v) => <text key={`tx${v}`} x={px(v)} y={H - 7} className="trace-axis" textAnchor="middle">{formatQuantity(v, xUnit, 3)}</text>)}
        {cursor !== null && <line x1={px(x[cursor]!)} x2={px(x[cursor]!)} y1={T} y2={H - B} className="trace-cursor" />}
      </svg>
      {cursor !== null && (
        <div className="plot-readout small" data-testid="plot-readout">
          {formatQuantity(x[cursor]!, xUnit, 4)}: {series.map((s, i) => <span key={i} style={{ color: s.color ?? COLORS[i % COLORS.length] }}>{series.length > 1 ? `${s.label} ` : ''}{fy(s.y[cursor] ?? NaN)} </span>)}
        </div>
      )}
      {series.length > 1 && (
        <div className="plot-legend small">{series.map((s, i) => <span key={i}><i style={{ background: s.color ?? COLORS[i % COLORS.length] }} />{s.label}</span>)}</div>
      )}
    </div>
  );
}
