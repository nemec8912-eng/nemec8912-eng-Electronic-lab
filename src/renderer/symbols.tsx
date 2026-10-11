/** Отрисовка обозначений на полотне: фигуры берутся из src/core/graphics.ts (тот же рисунок, что в экспорте). */
import { readableText, symbolPrims, type Prim } from '../core/graphics';
import type { SymbolDef } from '../core/model';

export { symbolBounds } from '../core/graphics';

export function Prims({ prims, rotation = 0, mirrored = false }: { prims: Prim[]; rotation?: number; mirrored?: boolean }) {
  return (
    <>
      {prims.map((p, i) => {
        const c = p.cls;
        switch (p.t) {
          case 'line': return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} className={c} />;
          case 'rect': return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} className={c} />;
          case 'circle': return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} className={c} />;
          case 'path': return <path key={i} d={p.d} className={c} />;
          case 'text': {
            const r = readableText(p, rotation, mirrored);
            return <text key={i} x={p.x} y={p.y} className={c} textAnchor={r.anchor} transform={r.transform}>{p.text}</text>;
          }
        }
      })}
    </>
  );
}

export function SymbolGraphic({ symbol, rotation = 0, mirrored = false }: { symbol: SymbolDef; rotation?: number; mirrored?: boolean }) {
  return <g className="sym"><Prims prims={symbolPrims(symbol)} rotation={rotation} mirrored={mirrored} /></g>;
}
