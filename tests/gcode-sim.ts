/**
 * Независимая проверка G-code для тестов: разбор строк как это делает GRBL и «выфрезеровывание»
 * на растре. Код программы не используется — только текст файла и параметры фрезы.
 */
export interface Move { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; rapid: boolean; feed: number }
export interface Parsed { moves: Move[]; spindleOn: boolean[]; errors: string[]; ended: boolean }

const ALLOWED_G = new Set(['0', '1', '4', '17', '21', '90', '94']);
const ALLOWED_M = new Set(['3', '5', '30']);

export function parseGcode(text: string): Parsed {
  const moves: Move[] = [];
  const errors: string[] = [];
  let x = 0, y = 0, z = 0, mode = 0, feed = 0, spindle = false, ended = false, metric = false, absolute = false;
  const spindleOn: boolean[] = [];
  text.split('\n').forEach((raw, n) => {
    if (raw.length > 80) errors.push(`строка ${n + 1}: длиннее 80 символов`);
    if (/[^\x20-\x7e\r]/.test(raw)) errors.push(`строка ${n + 1}: не ASCII`);
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*/, '').trim().toUpperCase();
    if (!line) return;
    if (ended) errors.push(`строка ${n + 1}: после M30`);
    const words = line.match(/[A-Z][-+]?[0-9.]+/g) ?? [];
    if (words.join('') !== line.replace(/\s+/g, '')) errors.push(`строка ${n + 1}: непонятные символы «${line}»`);
    let nx = x, ny = y, nz = z, moved = false;
    for (const w of words) {
      const L = w[0]!, v = w.slice(1), f = Number(v);
      if (!Number.isFinite(f)) errors.push(`строка ${n + 1}: число «${w}»`);
      switch (L) {
        case 'G':
          if (!ALLOWED_G.has(String(Number(v)))) errors.push(`строка ${n + 1}: G${v} не поддерживается GRBL или не ожидается`);
          if (f === 0 || f === 1) mode = f;
          if (f === 21) metric = true;
          if (f === 90) absolute = true;
          break;
        case 'M':
          if (!ALLOWED_M.has(String(Number(v)))) errors.push(`строка ${n + 1}: M${v}`);
          if (f === 3) spindle = true;
          if (f === 5) spindle = false;
          if (f === 30) ended = true;
          break;
        case 'X': nx = f; moved = true; break;
        case 'Y': ny = f; moved = true; break;
        case 'Z': nz = f; moved = true; break;
        case 'F': feed = f; break;
        case 'S': case 'P': break;
        default: errors.push(`строка ${n + 1}: слово ${w}`);
      }
    }
    if (moved) {
      if (!metric || !absolute) errors.push(`строка ${n + 1}: движение до G21/G90`);
      if (mode === 1 && !(feed > 0)) errors.push(`строка ${n + 1}: G1 без подачи`);
      if (nz < 0 && !spindle) errors.push(`строка ${n + 1}: рез при выключенном шпинделе`);
      if (mode === 0 && nz < 0 && (nx !== x || ny !== y)) errors.push(`строка ${n + 1}: холостой ход ниже поверхности`);
      moves.push({ x0: x, y0: y, z0: z, x1: nx, y1: ny, z1: nz, rapid: mode === 0, feed });
      spindleOn.push(spindle);
      x = nx; y = ny; z = nz;
    }
  });
  if (!ended) errors.push('нет M30 в конце');
  if (spindle) errors.push('шпиндель не выключен (M5)');
  return { moves, spindleOn, errors, ended };
}

/** Растр снятого материала на глубине поверхности меди: ячейка снята, если фреза прошла над ней ниже zMax. */
export class Removal {
  nx: number; ny: number; cut: Uint8Array;
  constructor(public x0: number, public y0: number, x1: number, y1: number, public step: number) {
    this.nx = Math.ceil((x1 - x0) / step) + 1; this.ny = Math.ceil((y1 - y0) / step) + 1;
    this.cut = new Uint8Array(this.nx * this.ny);
  }
  /** radiusAt(z) — радиус фрезы на уровне поверхности при глубине z (z < 0). */
  apply(moves: Move[], radiusAt: (z: number) => number, zMax = -1e-6) {
    for (const m of moves) {
      const z = Math.max(m.z0, m.z1);
      if (z > zMax) continue; // хотя бы один конец выше — считаем по нижнему (врезание по Z — точка)
      const r = radiusAt(z);
      const minx = Math.min(m.x0, m.x1) - r, maxx = Math.max(m.x0, m.x1) + r, miny = Math.min(m.y0, m.y1) - r, maxy = Math.max(m.y0, m.y1) + r;
      const i0 = Math.max(0, Math.floor((minx - this.x0) / this.step)), i1 = Math.min(this.nx - 1, Math.ceil((maxx - this.x0) / this.step));
      const j0 = Math.max(0, Math.floor((miny - this.y0) / this.step)), j1 = Math.min(this.ny - 1, Math.ceil((maxy - this.y0) / this.step));
      const dx = m.x1 - m.x0, dy = m.y1 - m.y0, l2 = dx * dx + dy * dy;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = this.x0 + i * this.step, py = this.y0 + j * this.step;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - m.x0) * dx + (py - m.y0) * dy) / l2));
        if (Math.hypot(px - (m.x0 + t * dx), py - (m.y0 + t * dy)) <= r) this.cut[j * this.nx + i] = 1;
      }
    }
  }
  cell(x: number, y: number): number {
    const i = Math.round((x - this.x0) / this.step), j = Math.round((y - this.y0) / this.step);
    return j * this.nx + i;
  }
  isCut(x: number, y: number): boolean { return this.cut[this.cell(x, y)] === 1; }
  /** Связные области несрезанного материала (4-связность); метка для каждой ячейки. */
  regions(): Int32Array {
    const lab = new Int32Array(this.nx * this.ny);
    let id = 0;
    const st: number[] = [];
    for (let k = 0; k < lab.length; k++) {
      if (this.cut[k] || lab[k]) continue;
      lab[k] = ++id; st.push(k);
      while (st.length) {
        const c = st.pop()!, i = c % this.nx;
        for (const n of [i > 0 ? c - 1 : -1, i < this.nx - 1 ? c + 1 : -1, c - this.nx, c + this.nx]) {
          if (n >= 0 && n < lab.length && !this.cut[n] && !lab[n]) { lab[n] = id; st.push(n); }
        }
      }
    }
    return lab;
  }
}
