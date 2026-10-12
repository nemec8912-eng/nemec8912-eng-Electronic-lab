/**
 * Лист схемы для экспорта и печати: SVG с размерами в миллиметрах, рамкой и основной надписью
 * (упрощённо по ГОСТ 2.104). Тот же рисунок обозначений, что на полотне (graphics.ts).
 * Масштаб: 10 единиц полотна (шаг сетки) = 2,54 мм при масштабе 1:1.
 */
import { labelPrims, readableText, symbolBounds, symbolPrims, type Prim } from './graphics';
import { formatQuantity, PARAMS } from './library';
import type { ComponentInstance, ProjectDoc, Sheet } from './model';
import { instanceBox, junctionDots, rotatePoint, symbolOf } from './schematic';

export const MM_PER_UNIT = 0.254;
export const PAGE_MM: Record<Sheet['size'], [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };

/** Подписи детали на схеме: обозначение, номиналы, напряжение конденсатора, партномер для ИС. */
export function instanceLabel(doc: ProjectDoc, inst: ComponentInstance): string[] {
  const part = doc.library.parts.find((p) => p.id === inst.partId);
  if (!part || part.category === 'reference') return [];
  const lines = [inst.refDes];
  const passive = ['resistor', 'capacitor', 'capacitor-polar', 'inductor', 'source'].includes(part.category);
  // Транзисторы, диоды, микросхемы: что за деталь — модель (партномер) или маркировка
  const ident = part.partNumber ?? part.marking;
  if (!passive && ident) lines.push(ident);
  const cap = part.category === 'capacitor' || part.category === 'capacitor-polar';
  for (const [k, q] of Object.entries(inst.values)) {
    const def = PARAMS[k];
    if (!def) continue;
    if (k === 'offset' && q.value === 0) continue; // нулевая постоянная составляющая генератора — не загромождать
    if (k === 'esr' || (k === 'resistance' && part.category === 'inductor')) continue; // второстепенное — в карточке
    // У генераторов несколько величин: подписываем, что есть что (амплитуда, заполнение).
    const prefix = k === 'amplitude' ? 'A ' : k === 'offset' ? '= ' : k === 'duty' ? 'D ' : '';
    let text = prefix + formatQuantity(q.value, def.unitRu);
    // Конденсатор: «47 мкФ / 50 В»
    if (cap && k === 'capacitance' && part.ratings.voltage) text += ` / ${formatQuantity(part.ratings.voltage.value, 'В')}`;
    lines.push(text);
  }
  return lines;
}

/** Где ставить подпись детали (в координатах полотна относительно её начала, без поворота текста). */
export function instanceLabelPos(inst: ComponentInstance, sb: { x: number; y: number; w: number; h: number }, lines: number): { x: number; y: number } {
  const corner = rotatePoint({ x: sb.x + sb.w, y: sb.y }, inst.rotation, inst.mirrored);
  const vertical = inst.rotation === 90 || inst.rotation === 270;
  return vertical ? { x: Math.abs(corner.x) + 6, y: -sb.w / 2 + 10 } : { x: -sb.w / 2, y: -Math.abs(sb.y) - 6 - (lines - 1) * 13 };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 1000) / 1000);

function primSvg(p: Prim, rotation = 0, mirrored = false): string {
  const c = p.cls ? ` class="${p.cls}"` : '';
  switch (p.t) {
    case 'line': return `<line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}"${c}/>`;
    case 'rect': return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"${c}/>`;
    case 'circle': return `<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}"${c}/>`;
    case 'path': return `<path d="${p.d}"${c}/>`;
    case 'text': {
      const r = readableText(p, rotation, mirrored);
      return `<text x="${n(p.x)}" y="${n(p.y)}"${c} text-anchor="${r.anchor}"${r.transform ? ` transform="${r.transform}"` : ''}>${esc(p.text)}</text>`;
    }
  }
}

/** Стили листа (встраиваются в SVG — файл самодостаточен). Толщины — в единицах полотна. */
export const SHEET_CSS = `
.sym line,.sym rect,.sym circle,.sym path{stroke:#000;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}
.sym .thick{stroke-width:3}.sym .fill{fill:#000}.sym .dash{stroke-dasharray:4 3}
.sym-sign,.pin-label{font-size:11px;fill:#000}.pin-num{font-size:8px;fill:#333}
.wire{stroke:#000;stroke-width:1.6;fill:none;stroke-linejoin:round}
.dot{fill:#000}
.lbl line,.lbl path{stroke:#000;stroke-width:1.4;fill:none}.lbl .thick{stroke-width:3}.lbl .label-flag{fill:#fff}
.label-text{font-size:11px;font-weight:600;fill:#000}
.inst-label{font-size:11.5px;fill:#000}.refdes{font-weight:700}
.note rect{fill:#fff;stroke:#777;stroke-width:0.8;stroke-dasharray:3 2}.note text{font-size:12px;fill:#000}
.frame{fill:none;stroke:#000;stroke-width:0.5}.frame-thin{fill:none;stroke:#000;stroke-width:0.25}
.tb{font-size:3.5px;fill:#000}.tb-big{font-size:5px;font-weight:700;fill:#000}.tb-small{font-size:2.5px;fill:#333}
text{font-family:"Segoe UI","Liberation Sans",Arial,sans-serif}
`;

export interface SheetOptions {
  size: Sheet['size'];
  orientation: Sheet['orientation'];
  /** Рамка и основная надпись. Без рамки лист обрезается по схеме с полями 10 мм. */
  frame: boolean;
  /** 'fit' — вписать в лист (не крупнее 2:1); число — масштаб (1 = 1:1). */
  scale: 'fit' | number;
  notes: boolean;
  title?: string;
  author?: string;
  date?: Date;
}

export interface SheetResult {
  svg: string;
  widthMm: number;
  heightMm: number;
  /** Фактический масштаб схемы (1 = 1:1). */
  scale: number;
  /** Схема не поместилась на лист при заданном масштабе. */
  clipped: boolean;
}

/** Габарит всего нарисованного на полотне. */
export function contentBounds(doc: ProjectDoc, notes = true): { x: number; y: number; w: number; h: number } | null {
  const xs: number[] = [], ys: number[] = [];
  const addPt = (x: number, y: number) => { xs.push(x); ys.push(y); };
  for (const inst of doc.schematic.instances) {
    const sym = symbolOf(doc, inst);
    if (!sym) continue;
    const sb = symbolBounds(sym);
    const b = instanceBox(inst, sb);
    addPt(b.x, b.y); addPt(b.x + b.w, b.y + b.h);
    const lines = instanceLabel(doc, inst);
    if (lines.length) {
      const lp = instanceLabelPos(inst, sb, lines.length);
      const w = Math.max(...lines.map((l) => l.length)) * 7;
      addPt(inst.position.x + lp.x, inst.position.y + lp.y - 12);
      addPt(inst.position.x + lp.x + w, inst.position.y + lp.y + (lines.length - 1) * 13 + 4);
    }
  }
  for (const w of doc.schematic.wires) for (const p of w.points) addPt(p.x, p.y);
  for (const l of doc.schematic.labels) { addPt(l.position.x - 20, l.position.y - 24); addPt(l.position.x + l.name.length * 7 + 20, l.position.y + 24); }
  if (notes) for (const a of doc.schematic.annotations) {
    const lines = (a.text || ' ').split('\n');
    addPt(a.position.x, a.position.y);
    addPt(a.position.x + Math.min(480, Math.max(60, ...lines.map((l) => l.length * 7.2 + 20))), a.position.y + lines.length * 17 + 14);
  }
  if (!xs.length) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Рисунок схемы в единицах полотна (без рамки). */
export function schematicBody(doc: ProjectDoc, notes: boolean): string {
  const out: string[] = [];
  for (const w of doc.schematic.wires) out.push(`<polyline class="wire" points="${w.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')}"/>`);
  for (const p of junctionDots(doc)) out.push(`<circle class="dot" cx="${n(p.x)}" cy="${n(p.y)}" r="3.2"/>`);
  for (const inst of doc.schematic.instances) {
    const sym = symbolOf(doc, inst);
    if (!sym) continue;
    out.push(`<g transform="translate(${n(inst.position.x)} ${n(inst.position.y)})"><g class="sym" transform="rotate(${inst.rotation})${inst.mirrored ? ' scale(-1 1)' : ''}">${symbolPrims(sym).map((p) => primSvg(p, inst.rotation, inst.mirrored)).join('')}</g>`);
    const lines = instanceLabel(doc, inst);
    if (lines.length) {
      const lp = instanceLabelPos(inst, symbolBounds(sym), lines.length);
      out.push(`<text class="inst-label" x="${n(lp.x)}" y="${n(lp.y)}">${lines.map((l, i) => `<tspan x="${n(lp.x)}" dy="${i === 0 ? 0 : 13}"${i === 0 ? ' class="refdes"' : ''}>${esc(l)}</tspan>`).join('')}</text>`);
    }
    out.push('</g>');
  }
  for (const l of doc.schematic.labels) {
    out.push(`<g class="lbl" transform="translate(${n(l.position.x)} ${n(l.position.y)}) rotate(${l.rotation})">${labelPrims(l.name, l.kind).map((p) => primSvg(p, l.rotation, false)).join('')}</g>`);
  }
  if (notes) for (const a of doc.schematic.annotations) {
    const lines = (a.text || ' ').split('\n').slice(0, 40);
    const w = Math.min(480, Math.max(60, ...lines.map((l) => l.length * 7.2 + 20)));
    out.push(`<g class="note" transform="translate(${n(a.position.x)} ${n(a.position.y)})"><rect width="${n(w)}" height="${lines.length * 17 + 14}" rx="3"/><text x="10" y="20">${lines.map((l, i) => `<tspan x="10" dy="${i === 0 ? 0 : 17}">${esc(l || ' ')}</tspan>`).join('')}</text></g>`);
  }
  return out.join('\n');
}

/** Основная надпись (упрощённая, 185 × 40 мм) в правом нижнем углу рамки. */
function titleBlock(x: number, y: number, o: { title: string; doc: ProjectDoc; author: string; date: Date; scale: number; size: string }): string {
  const W = 185, H = 40;
  const x0 = x - W, y0 = y - H;
  const scaleText = o.scale === 1 ? '1:1' : o.scale > 1 ? `${n(Math.round(o.scale * 100) / 100).replace('.', ',')}:1` : `1:${n(Math.round(100 / o.scale) / 100).replace('.', ',')}`;
  const cells = [
    `<rect class="frame" x="${x0}" y="${y0}" width="${W}" height="${H}"/>`,
    `<line class="frame" x1="${x0 + 120}" y1="${y0}" x2="${x0 + 120}" y2="${y0 + H}"/>`,
    `<line class="frame-thin" x1="${x0}" y1="${y0 + 15}" x2="${x0 + 120}" y2="${y0 + 15}"/>`,
    `<line class="frame-thin" x1="${x0}" y1="${y0 + 25}" x2="${x0 + 120}" y2="${y0 + 25}"/>`,
    `<line class="frame-thin" x1="${x0 + 120}" y1="${y0 + 20}" x2="${x + 0}" y2="${y0 + 20}"/>`,
    `<line class="frame-thin" x1="${x0 + 150}" y1="${y0 + 20}" x2="${x0 + 150}" y2="${y0 + H}"/>`,
    `<text class="tb-big" x="${x0 + 4}" y="${y0 + 10}">${esc(o.title.slice(0, 48))}</text>`,
    `<text class="tb" x="${x0 + 4}" y="${y0 + 21.5}">Схема электрическая принципиальная</text>`,
    `<text class="tb-small" x="${x0 + 4}" y="${y0 + 30}">Разработал</text>`,
    `<text class="tb" x="${x0 + 30}" y="${y0 + 30}">${esc(o.author.slice(0, 30) || '—')}</text>`,
    `<text class="tb-small" x="${x0 + 4}" y="${y0 + 36}">Дата</text>`,
    `<text class="tb" x="${x0 + 30}" y="${y0 + 36}">${o.date.toLocaleDateString('ru-RU')}</text>`,
    `<text class="tb-small" x="${x0 + 124}" y="${y0 + 6}">Электронная лаборатория</text>`,
    `<text class="tb" x="${x0 + 124}" y="${y0 + 14}">Ревизия ${o.doc.revision}</text>`,
    `<text class="tb-small" x="${x0 + 124}" y="${y0 + 25}">Масштаб</text>`,
    `<text class="tb" x="${x0 + 124}" y="${y0 + 32}">${scaleText}</text>`,
    `<text class="tb-small" x="${x0 + 154}" y="${y0 + 25}">Формат</text>`,
    `<text class="tb" x="${x0 + 154}" y="${y0 + 32}">${o.size}</text>`,
  ];
  return cells.join('\n');
}

/** Лист схемы в SVG (размеры в мм). */
export function sheetSvg(doc: ProjectDoc, o: SheetOptions): SheetResult {
  const b = contentBounds(doc, o.notes) ?? { x: 0, y: 0, w: 100, h: 60 };
  const date = o.date ?? new Date();
  const body = schematicBody(doc, o.notes);
  if (!o.frame) {
    const s = o.scale === 'fit' ? 1 : o.scale;
    const pad = 10;
    const W = b.w * MM_PER_UNIT * s + pad * 2, H = b.h * MM_PER_UNIT * s + pad * 2;
    const k = MM_PER_UNIT * s;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}mm" height="${n(H)}mm" viewBox="0 0 ${n(W)} ${n(H)}"><style>${SHEET_CSS}</style><rect width="100%" height="100%" fill="#fff"/><g transform="translate(${n(pad - b.x * k)} ${n(pad - b.y * k)}) scale(${n(k)})">${body}</g></svg>`;
    return { svg, widthMm: W, heightMm: H, scale: s, clipped: false };
  }
  const [pw, ph] = PAGE_MM[o.size];
  const [W, H] = o.orientation === 'landscape' ? [pw, ph] : [ph, pw];
  // Рамка: слева 20 мм (подшивка), остальные 5 мм; над основной надписью — 40 мм.
  const fx = 20, fy = 5, fw = W - 25, fh = H - 10;
  const area = { x: fx + 5, y: fy + 5, w: fw - 10, h: fh - 10 - 40 };
  const fit = Math.min(area.w / (b.w * MM_PER_UNIT || 1), area.h / (b.h * MM_PER_UNIT || 1), 2);
  const s = o.scale === 'fit' ? fit : o.scale;
  const k = MM_PER_UNIT * s;
  const clipped = b.w * k > area.w + 0.01 || b.h * k > area.h + 0.01;
  const ox = area.x + Math.max(0, (area.w - b.w * k) / 2) - b.x * k;
  const oy = area.y + Math.max(0, (area.h - b.h * k) / 2) - b.y * k;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
    `<style>${SHEET_CSS}</style>`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<defs><clipPath id="area"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh - 40}"/></clipPath></defs>`,
    `<g clip-path="url(#area)"><g transform="translate(${n(ox)} ${n(oy)}) scale(${n(k)})">${body}</g></g>`,
    `<rect class="frame" x="${fx}" y="${fy}" width="${fw}" height="${fh}"/>`,
    titleBlock(fx + fw, fy + fh, { title: o.title ?? doc.name, doc, author: o.author ?? '', date, scale: s, size: o.size }),
    '</svg>',
  ].join('\n');
  return { svg, widthMm: W, heightMm: H, scale: s, clipped };
}

