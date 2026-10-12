/**
 * Контур платы: прямоугольник, скруглённые углы, круг, многоугольник. Для проверок, расстановки,
 * растра и Gerber контур — многоугольник (дуги — отрезками по 3°, отклонение от дуги радиусом 20 мм
 * меньше 0,007 мм); для SVG — точный путь с дугами.
 */
import type { Board, BoardOutline, Point } from './model';

const ARC_STEP = (3 * Math.PI) / 180;

function arc(cx: number, cy: number, r: number, a0: number, a1: number): Point[] {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / ARC_STEP));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

/** Контур как замкнутый многоугольник (первая точка не повторяется), обход по часовой стрелке на экране. */
export function outlinePolygon(board: Pick<Board, 'widthMm' | 'heightMm' | 'outline'>): Point[] {
  const W = board.widthMm, H = board.heightMm, o = board.outline;
  switch (o.kind) {
    case 'rounded': {
      const r = Math.min(o.radiusMm, W / 2, H / 2);
      return [
        ...arc(W - r, r, r, -Math.PI / 2, 0), ...arc(W - r, H - r, r, 0, Math.PI / 2),
        ...arc(r, H - r, r, Math.PI / 2, Math.PI), ...arc(r, r, r, Math.PI, (3 * Math.PI) / 2),
      ];
    }
    case 'circle': {
      const pts = arc(W / 2, H / 2, Math.min(W, H) / 2, 0, 2 * Math.PI);
      pts.pop();
      return pts;
    }
    case 'polygon':
      return o.points.map((p) => ({ ...p }));
    default:
      return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  }
}

export function pointInPolygon(poly: Point[], p: Point): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Точный путь SVG контура (дуги — дугами). */
export function outlineSvgPath(board: Pick<Board, 'widthMm' | 'heightMm' | 'outline'>, f: (n: number) => string = (n) => String(Number(n.toFixed(4)))): string {
  const W = board.widthMm, H = board.heightMm, o = board.outline;
  if (o.kind === 'rect') return `M0 0H${f(W)}V${f(H)}H0Z`;
  if (o.kind === 'circle') {
    const r = Math.min(W, H) / 2;
    return `M${f(W / 2 - r)} ${f(H / 2)}A${f(r)} ${f(r)} 0 1 0 ${f(W / 2 + r)} ${f(H / 2)}A${f(r)} ${f(r)} 0 1 0 ${f(W / 2 - r)} ${f(H / 2)}Z`;
  }
  if (o.kind === 'rounded') {
    const r = Math.min(o.radiusMm, W / 2, H / 2);
    return `M${f(r)} 0H${f(W - r)}A${f(r)} ${f(r)} 0 0 1 ${f(W)} ${f(r)}V${f(H - r)}A${f(r)} ${f(r)} 0 0 1 ${f(W - r)} ${f(H)}H${f(r)}A${f(r)} ${f(r)} 0 0 1 0 ${f(H - r)}V${f(r)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0Z`;
  }
  return `M${o.points.map((p) => `${f(p.x)} ${f(p.y)}`).join('L')}Z`;
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Проверка многоугольника: не меньше 3 точек, ненулевая площадь, без самопересечений. */
export function polygonProblem(points: Point[]): string | null {
  if (points.length < 3) return 'Нужно не меньше трёх точек';
  const n = points.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
    if (segmentsCross(points[i]!, points[(i + 1) % n]!, points[j]!, points[(j + 1) % n]!)) return `Стороны ${i + 1} и ${j + 1} пересекаются`;
  }
  let area = 0;
  for (let i = 0; i < n; i++) { const a = points[i]!, b = points[(i + 1) % n]!; area += a.x * b.y - b.x * a.y; }
  if (Math.abs(area) < 1) return 'Площадь контура меньше 0,5 мм²';
  return null;
}

/** Нормализация многоугольника: габарит начинается в (0; 0). Возвращает точки и размеры. */
export function normalizePolygon(points: Point[]): { points: Point[]; widthMm: number; heightMm: number } {
  const x0 = Math.min(...points.map((p) => p.x)), y0 = Math.min(...points.map((p) => p.y));
  const pts = points.map((p) => ({ x: Number((p.x - x0).toFixed(4)), y: Number((p.y - y0).toFixed(4)) }));
  return { points: pts, widthMm: Math.max(...pts.map((p) => p.x)), heightMm: Math.max(...pts.map((p) => p.y)) };
}

/** Разбор точек «x; y» по строкам (единицы — мм или дюймы платы). */
export function parsePoints(text: string, toMm: (v: string) => number | null): { points: Point[] } | { error: string } {
  const pts: Point[] = [];
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const parts = line.split(/\s*[;\t]\s*|\s+/).filter(Boolean);
    if (parts.length !== 2) return { error: `Строка ${i + 1}: нужно «x; y»` };
    const x = toMm(parts[0]!), y = toMm(parts[1]!);
    if (x === null || y === null) return { error: `Строка ${i + 1}: не понял число` };
    pts.push({ x, y });
  }
  return { points: pts };
}

export const OUTLINE_KINDS: Array<[BoardOutline['kind'], string]> = [['rect', 'Прямоугольник'], ['rounded', 'Скруглённые углы'], ['circle', 'Круг'], ['polygon', 'Многоугольник']];

/** Площадь контура, мм². */
export function outlineArea(board: Pick<Board, 'widthMm' | 'heightMm' | 'outline'>): number {
  const p = outlinePolygon(board);
  let a = 0;
  for (let i = 0; i < p.length; i++) { const u = p[i]!, v = p[(i + 1) % p.length]!; a += u.x * v.y - v.x * u.y; }
  return Math.abs(a) / 2;
}
