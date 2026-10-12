/**
 * Поле расстояний на сетке и контуры уровня — основа траекторий фрезы.
 *
 * Поле хранит в каждом узле сетки расстояние до ближайшей меди (внутри меди — отрицательное или 0).
 * Для фигур (площадки, дорожки, переходы, контур платы) расстояние считается точно; для заливки,
 * у которой нет простого описания, — преобразованием расстояний по растру (точность — полшага сетки).
 * Контур на уровне d — линия, где расстояние равно d: по ней идёт центр фрезы радиуса d.
 */
import type { Point } from './model';
import type { Shape } from './pcb';

export interface Field { x0: number; y0: number; step: number; nx: number; ny: number; d: Float32Array }

export function newField(x0: number, y0: number, x1: number, y1: number, step: number, fill = 1e9): Field {
  const nx = Math.ceil((x1 - x0) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1;
  const d = new Float32Array(nx * ny);
  d.fill(fill);
  return { x0, y0, step, nx, ny, d };
}

/** Расстояние от точки до фигуры (отрицательное — внутри). */
export function distToShape(p: Point, s: Shape): number {
  if (s.closed && s.pts.length > 2 && pointInPoly(s.pts, p)) {
    // Внутри многоугольника: минус расстояние до границы
    let d = Infinity;
    for (let i = 0; i < s.pts.length; i++) d = Math.min(d, segDist(p, s.pts[i]!, s.pts[(i + 1) % s.pts.length]!));
    return -d - s.r;
  }
  let d = Infinity;
  const n = s.pts.length;
  if (n === 1) d = Math.hypot(p.x - s.pts[0]!.x, p.y - s.pts[0]!.y);
  else for (let i = 0; i < (s.closed ? n : n - 1); i++) d = Math.min(d, segDist(p, s.pts[i]!, s.pts[(i + 1) % n]!));
  return d - s.r;
}

export function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointInPoly(poly: Point[], p: Point): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Узлы сетки внутри многоугольника (построчно, по пересечениям — быстро для больших сеток). */
export function polyMask(f: Pick<Field, 'x0' | 'y0' | 'step' | 'nx' | 'ny'>, poly: Point[]): Uint8Array {
  const out = new Uint8Array(f.nx * f.ny);
  for (let j = 0; j < f.ny; j++) {
    const y = f.y0 + j * f.step;
    const xs: number[] = [];
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const a = poly[i]!, b = poly[k]!;
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((u, v) => u - v);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q]! - f.x0) / f.step)), i1 = Math.min(f.nx - 1, Math.floor((xs[q + 1]! - f.x0) / f.step));
      for (let i = i0; i <= i1; i++) out[j * f.nx + i] = 1;
    }
  }
  return out;
}

/** Внести фигуру в поле: в окрестности reach от фигуры значение = min(текущее, расстояние). */
export function stampShape(f: Field, s: Shape, reach: number): void {
  const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y);
  const m = s.r + reach + f.step;
  const i0 = Math.max(0, Math.floor((Math.min(...xs) - m - f.x0) / f.step)), i1 = Math.min(f.nx - 1, Math.ceil((Math.max(...xs) + m - f.x0) / f.step));
  const j0 = Math.max(0, Math.floor((Math.min(...ys) - m - f.y0) / f.step)), j1 = Math.min(f.ny - 1, Math.ceil((Math.max(...ys) + m - f.y0) / f.step));
  for (let j = j0; j <= j1; j++) {
    const y = f.y0 + j * f.step;
    for (let i = i0; i <= i1; i++) {
      const k = j * f.nx + i;
      const v = distToShape({ x: f.x0 + i * f.step, y }, s);
      if (v < f.d[k]!) f.d[k] = v;
    }
  }
}

/** Признак «внутри» в узлах сетки → расстояние до ближайшего узла «внутри» (евклидово, по Фельценшвальбу). */
export function distanceTransform(nx: number, ny: number, inside: Uint8Array, step: number): Float32Array {
  const INF = 1e20;
  const g = new Float64Array(nx * ny);
  for (let k = 0; k < g.length; k++) g[k] = inside[k] ? 0 : INF;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
    }
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = g[j * nx + i]!;
    pass(ny);
    for (let j = 0; j < ny; j++) g[j * nx + i] = d[j]!;
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = g[j * nx + i]!;
    pass(nx);
    for (let i = 0; i < nx; i++) g[j * nx + i] = d[i]!;
  }
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < out.length; k++) out[k] = g[k]! >= INF / 2 ? 1e9 : Math.sqrt(g[k]!) * step;
  return out;
}

/**
 * Замкнутые контуры уровня level (marching squares с линейной интерполяцией).
 * Узлы на краю сетки должны быть выше уровня — тогда все контуры замкнуты.
 */
export function contours(f: Field, level: number): Point[][] {
  const { nx, ny, d, x0, y0, step } = f;
  const val = (i: number, j: number) => d[j * nx + i]! - level;
  // Точка пересечения на ребре: горизонтальное ребро (i,j)-(i+1,j) — id 2k, вертикальное (i,j)-(i,j+1) — 2k+1
  const pts = new Map<number, Point>();
  const edgePoint = (id: number): Point => {
    let p = pts.get(id);
    if (p) return p;
    const k = id >> 1, i = k % nx, j = (k - i) / nx;
    const a = val(i, j);
    if ((id & 1) === 0) { const b = val(i + 1, j); const t = a / (a - b); p = { x: x0 + (i + t) * step, y: y0 + j * step }; }
    else { const b = val(i, j + 1); const t = a / (a - b); p = { x: x0 + i * step, y: y0 + (j + t) * step }; }
    pts.set(id, p);
    return p;
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = val(i, j), b = val(i + 1, j), c = val(i + 1, j + 1), e = val(i, j + 1);
      const code = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (e < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const k = j * nx + i;
      const top = 2 * k, left = 2 * k + 1, bottom = 2 * (k + nx), right = 2 * (k + 1) + 1;
      switch (code) {
        case 1: case 14: link(top, left); break;
        case 2: case 13: link(top, right); break;
        case 4: case 11: link(right, bottom); break;
        case 8: case 7: link(bottom, left); break;
        case 3: case 12: link(left, right); break;
        case 6: case 9: link(top, bottom); break;
        case 5: case 10: {
          // Седло: решает значение в центре клетки
          const center = (a + b + c + e) / 4 < 0;
          if ((code === 5) === center) { link(top, right); link(bottom, left); } else { link(top, left); link(right, bottom); }
          break;
        }
      }
    }
  }
  for (const id of adj.keys()) edgePoint(id);
  const seen = new Set<number>();
  const out: Point[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: Point[] = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(pts.get(cur)!);
      const nb = adj.get(cur)!;
      const next = nb[0] !== prev ? nb[0]! : nb[1]!;
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) out.push(loop);
  }
  return out;
}

/** Упрощение замкнутой ломаной (Дуглас — Пекер) с допуском tol. */
export function simplifyLoop(loop: Point[], tol: number): Point[] {
  if (loop.length < 4) return loop;
  // Разрезаем в самой дальней от первой точке, упрощаем две половины
  let far = 0, fd = -1;
  for (let i = 1; i < loop.length; i++) { const d = Math.hypot(loop[i]!.x - loop[0]!.x, loop[i]!.y - loop[0]!.y); if (d > fd) { fd = d; far = i; } }
  const a = dp([...loop.slice(0, far + 1)], tol), b = dp([...loop.slice(far), loop[0]!], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function dp(pts: Point[], tol: number): Point[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let idx = -1, md = tol;
    for (let i = s + 1; i < e; i++) { const d = segDist(pts[i]!, pts[s]!, pts[e]!); if (d > md) { md = d; idx = i; } }
    if (idx >= 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function loopLength(loop: Point[], closed = true): number {
  let l = 0;
  for (let i = 1; i < loop.length; i++) l += Math.hypot(loop[i]!.x - loop[i - 1]!.x, loop[i]!.y - loop[i - 1]!.y);
  if (closed && loop.length > 1) l += Math.hypot(loop[0]!.x - loop[loop.length - 1]!.x, loop[0]!.y - loop[loop.length - 1]!.y);
  return l;
}

export function loopArea(loop: Point[]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) a += (loop[j]!.x + loop[i]!.x) * (loop[j]!.y - loop[i]!.y);
  return a / 2;
}
