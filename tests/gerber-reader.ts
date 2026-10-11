/**
 * Независимый читатель Gerber RS-274X и Excellon для тестов экспорта платы. Написан по спецификации
 * (Ucamco Gerber Layer Format, XNC/Excellon), без кода экспорта: разбирает формат координат, единицы,
 * апертуры C/R/O, выбор апертуры, D01/D02/D03 и модальные координаты; растеризует медь в битовую
 * карту и находит связные области — так проверяется соответствие сетей, а не только текст файла.
 */

export type Ap = { kind: 'C'; d: number } | { kind: 'R' | 'O'; w: number; h: number };
export interface Flash { x: number; y: number; ap: Ap }
export interface Draw { x1: number; y1: number; x2: number; y2: number; ap: Ap }
export interface GerberData { units: 'mm' | 'in'; apertures: Map<number, Ap>; flashes: Flash[]; draws: Draw[]; attributes: string[]; polarity: string[] }

export function readGerber(text: string): GerberData {
  const data: GerberData = { units: 'mm', apertures: new Map(), flashes: [], draws: [], attributes: [], polarity: [] };
  let xInt = 0, xDec = 0, yInt = 0, yDec = 0, fsSeen = false, moSeen = false, ended = false;
  let cur: number | null = null, x = 0, y = 0;
  const statements: Array<{ ext: boolean; s: string }> = [];
  const re = /%([^%]*)%|([^%*]*)\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) for (const s of m[1].split('*').map((t) => t.trim()).filter(Boolean)) statements.push({ ext: true, s });
    else if (m[2]!.trim()) statements.push({ ext: false, s: m[2]!.trim() });
  }
  const coord = (raw: string, dec: number) => {
    if (raw.includes('.')) throw new Error(`Десятичная точка в координате Gerber: ${raw}`);
    return Number(raw) / 10 ** dec;
  };
  for (const { ext, s } of statements) {
    if (ended) throw new Error('Данные после M02');
    if (ext) {
      if (s.startsWith('FS')) {
        const f = s.match(/^FSLAX(\d)(\d)Y(\d)(\d)$/);
        if (!f) throw new Error(`Неподдерживаемый формат ${s}`);
        [xInt, xDec, yInt, yDec] = f.slice(1).map(Number) as [number, number, number, number];
        fsSeen = true;
      } else if (s === 'MOMM') { data.units = 'mm'; moSeen = true; }
      else if (s === 'MOIN') { data.units = 'in'; moSeen = true; }
      else if (s.startsWith('AD')) {
        const a = s.match(/^ADD(\d+)([CRO]),([\d.]+)(?:X([\d.]+))?$/);
        if (!a) throw new Error(`Апертура не разобрана: ${s}`);
        const code = Number(a[1]);
        if (code < 10) throw new Error('Код апертуры меньше 10');
        data.apertures.set(code, a[2] === 'C' ? { kind: 'C', d: Number(a[3]) } : { kind: a[2] as 'R' | 'O', w: Number(a[3]), h: Number(a[4]) });
      } else if (s.startsWith('LP')) data.polarity.push(s);
      else if (/^T[FAOD]/.test(s)) data.attributes.push(s);
      else throw new Error(`Неизвестная расширенная команда ${s}`);
      continue;
    }
    if (s === 'M02') { ended = true; continue; }
    if (s === 'G01' || s === 'G75' || s.startsWith('G04')) continue;
    const sel = s.match(/^(?:G54)?D(\d+)$/);
    if (sel && Number(sel[1]) >= 10) {
      if (!data.apertures.has(Number(sel[1]))) throw new Error(`Апертура D${sel[1]} не определена`);
      cur = Number(sel[1]);
      continue;
    }
    const op = s.match(/^(?:X(-?\d+))?(?:Y(-?\d+))?D0([123])$/);
    if (!op) throw new Error(`Неизвестная команда ${s}`);
    if (!fsSeen || !moSeen) throw new Error('Координаты до FS/MO');
    void xInt; void yInt;
    const nx = op[1] !== undefined ? coord(op[1], xDec) : x, ny = op[2] !== undefined ? coord(op[2], yDec) : y;
    if (op[3] !== '2') {
      if (cur === null) throw new Error('Операция без выбранной апертуры');
      const ap = data.apertures.get(cur)!;
      if (op[3] === '1') data.draws.push({ x1: x, y1: y, x2: nx, y2: ny, ap });
      else data.flashes.push({ x: nx, y: ny, ap });
    }
    x = nx; y = ny;
  }
  if (!ended) throw new Error('Нет M02 в конце файла');
  return data;
}

export interface DrillData { units: 'mm' | 'in'; tools: Map<number, number>; hits: Array<{ x: number; y: number; d: number }> }

export function readExcellon(text: string): DrillData {
  const out: DrillData = { units: 'mm', tools: new Map(), hits: [] };
  let header = false, tool: number | null = null, done = false;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith(';')) continue;
    if (s === 'M48') { header = true; continue; }
    if (header) {
      if (s === '%' || s === 'M95') { header = false; continue; }
      if (s.startsWith('METRIC')) { out.units = 'mm'; continue; }
      if (s.startsWith('INCH')) { out.units = 'in'; continue; }
      const t = s.match(/^T(\d+)C([\d.]+)$/);
      if (t) { out.tools.set(Number(t[1]), Number(t[2])); continue; }
      if (s.startsWith('FMAT')) continue;
      throw new Error(`Неизвестная строка заголовка ${s}`);
    }
    if (s === 'G90' || s === 'G05') continue;
    if (s === 'M30') { done = true; continue; }
    const t = s.match(/^T(\d+)$/);
    if (t) { tool = Number(t[1]); if (tool !== 0 && !out.tools.has(tool)) throw new Error(`Инструмент T${tool} не описан`); continue; }
    const h = s.match(/^X(-?[\d.]+)Y(-?[\d.]+)$/);
    if (h) {
      if (!h[1]!.includes('.') || !h[2]!.includes('.')) throw new Error('Ожидались десятичные координаты');
      if (!tool) throw new Error('Отверстие без инструмента');
      out.hits.push({ x: Number(h[1]), y: Number(h[2]), d: out.tools.get(tool)! });
      continue;
    }
    throw new Error(`Неизвестная команда сверловки ${s}`);
  }
  if (!done) throw new Error('Нет M30');
  return out;
}

/** Битовая карта меди: шаг res мм, область [0..w]×[0..h] (координаты Gerber, ось Y вверх). */
export class Raster {
  readonly nx: number;
  readonly ny: number;
  readonly bits: Uint8Array;
  constructor(readonly w: number, readonly h: number, readonly res = 0.02) {
    this.nx = Math.ceil(w / res) + 1; this.ny = Math.ceil(h / res) + 1;
    this.bits = new Uint8Array(this.nx * this.ny);
  }
  private fill(x0: number, y0: number, x1: number, y1: number, test: (x: number, y: number) => boolean) {
    const i0 = Math.max(0, Math.floor(x0 / this.res)), i1 = Math.min(this.nx - 1, Math.ceil(x1 / this.res));
    const j0 = Math.max(0, Math.floor(y0 / this.res)), j1 = Math.min(this.ny - 1, Math.ceil(y1 / this.res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (test(i * this.res, j * this.res)) this.bits[j * this.nx + i] = 1;
  }
  capsule(x1: number, y1: number, x2: number, y2: number, r: number) {
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    this.fill(Math.min(x1, x2) - r, Math.min(y1, y2) - r, Math.max(x1, x2) + r, Math.max(y1, y2) + r, (x, y) => {
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= r;
    });
  }
  flash(f: Flash) {
    const a = f.ap;
    if (a.kind === 'C') return this.capsule(f.x, f.y, f.x, f.y, a.d / 2);
    if (a.kind === 'R') return this.fill(f.x - a.w / 2, f.y - a.h / 2, f.x + a.w / 2, f.y + a.h / 2, (x, y) => Math.abs(x - f.x) <= a.w / 2 && Math.abs(y - f.y) <= a.h / 2);
    const r = Math.min(a.w, a.h) / 2, d = (Math.max(a.w, a.h) - Math.min(a.w, a.h)) / 2;
    return a.w >= a.h ? this.capsule(f.x - d, f.y, f.x + d, f.y, r) : this.capsule(f.x, f.y - d, f.x, f.y + d, r);
  }
  draw(d: Draw) {
    if (d.ap.kind !== 'C') throw new Error('Рисование некруглой апертурой');
    this.capsule(d.x1, d.y1, d.x2, d.y2, d.ap.d / 2);
  }
  static of(g: GerberData, w: number, h: number, res = 0.02): Raster {
    const r = new Raster(w, h, res);
    for (const d of g.draws) r.draw(d);
    for (const f of g.flashes) r.flash(f);
    return r;
  }
  at(x: number, y: number): number { return this.bits[Math.round(y / this.res) * this.nx + Math.round(x / this.res)] ?? 0; }
  /** Метки связных областей (4-связность), 0 — нет меди. */
  label(): Int32Array {
    const lab = new Int32Array(this.bits.length);
    let next = 0;
    const stack: number[] = [];
    for (let k = 0; k < this.bits.length; k++) {
      if (!this.bits[k] || lab[k]) continue;
      next++;
      lab[k] = next; stack.push(k);
      while (stack.length) {
        const c = stack.pop()!;
        const i = c % this.nx, j = (c - i) / this.nx;
        for (const n of [i > 0 ? c - 1 : -1, i < this.nx - 1 ? c + 1 : -1, j > 0 ? c - this.nx : -1, j < this.ny - 1 ? c + this.nx : -1]) {
          if (n >= 0 && this.bits[n] && !lab[n]) { lab[n] = next; stack.push(n); }
        }
      }
    }
    return lab;
  }
}

/**
 * Связность меди по всем слоям: области каждого слоя + металлизированные отверстия, соединяющие слои.
 * Возвращает функцию «точка → номер электрической области» (null — нет меди ни на одном слое).
 */
export function copperRegions(layers: Raster[], holes: Array<{ x: number; y: number }>): (x: number, y: number) => string | null {
  const labels = layers.map((r) => r.label());
  const parent = new Map<string, string>();
  const find = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const r = find(p); parent.set(k, r); return r; };
  const at = (li: number, x: number, y: number) => {
    const r = layers[li]!;
    const v = labels[li]![Math.round(y / r.res) * r.nx + Math.round(x / r.res)] ?? 0;
    return v ? `${li}:${v}` : null;
  };
  for (const h of holes) {
    const ks = layers.map((_, li) => at(li, h.x, h.y)).filter((k): k is string => k !== null);
    for (let i = 1; i < ks.length; i++) parent.set(find(ks[i]!), find(ks[0]!));
  }
  return (x, y) => {
    for (let li = 0; li < layers.length; li++) { const k = at(li, x, y); if (k) return find(k); }
    return null;
  };
}
