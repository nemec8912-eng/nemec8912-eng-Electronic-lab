/**
 * Вывод платы для изготовления дома: рисунок меди 1:1 (SVG в миллиметрах — для печати, PDF и ЛУТ),
 * сборочный чертёж. Gerber и Excellon — gerber.ts.
 *
 * Ориентация. На плате всё задано видом сверху (со стороны деталей). Нижний слой меди, если смотреть
 * на него снизу, виден зеркально. При ЛУТ отпечаток кладут тонером на медь — изображение зеркалится
 * ещё раз. Поэтому для ЛУТ нижний слой печатается БЕЗ зеркала (вид сверху «сквозь плату»), верхний —
 * С зеркалом. Подпись на поле листа говорит, что напечатано.
 */
import type { ProjectDoc } from './model';
import { allPads, bodyRect, DEFAULT_BOARD, type Layer, padsOf } from './pcb';

export interface ArtworkOptions {
  layer: Layer;
  /** Зеркально относительно вертикальной оси платы. */
  mirror: boolean;
  /** Белые точки-керны в центрах отверстий (помогают сверлить). */
  drillMarks?: boolean;
}

/** Зеркалить ли слой для ЛУТ (переноса тонера на медь). */
export const lutMirror = (layer: Layer) => layer === 'top';

export interface Artwork { svg: string; widthMm: number; heightMm: number; title: string }

const f = (n: number) => Number(n.toFixed(4)).toString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MARGIN = 5, CAL = 10;

function sheet(doc: ProjectDoc, inner: string, caption: string, title: string): Artwork {
  const board = doc.pcb.board ?? { ...DEFAULT_BOARD };
  const W = board.widthMm + MARGIN * 3 + CAL, H = Math.max(board.heightMm, CAL + 8) + MARGIN * 2 + 8;
  const calX = MARGIN + board.widthMm + MARGIN;
  const calibration = `<rect x="${f(calX)}" y="${f(MARGIN)}" width="${CAL}" height="${CAL}" fill="none" stroke="#000" stroke-width="0.2" data-calibration="10"/>` +
    `<text x="${f(calX)}" y="${f(MARGIN + CAL + 4)}" font-size="2.6" font-family="Arial, sans-serif">10×10 мм</text>`;
  const cap = `<text x="${f(MARGIN)}" y="${f(H - 3)}" font-size="2.6" font-family="Arial, sans-serif">${esc(caption)}</text>`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">` +
    `<title>${esc(title)}</title><rect width="100%" height="100%" fill="#fff"/>` +
    `<g transform="translate(${MARGIN} ${MARGIN})">${inner}</g>${calibration}${cap}</svg>\n`;
  return { svg, widthMm: W, heightMm: H, title };
}

/** Рисунок меди одного слоя 1:1: дорожки, площадки, переходы, контур платы. */
export function artworkSvg(doc: ProjectDoc, opts: ArtworkOptions): Artwork {
  const board = doc.pcb.board ?? { ...DEFAULT_BOARD, layers: 1 };
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${f(board.widthMm)}" height="${f(board.heightMm)}" fill="none" stroke="#000" stroke-width="0.15" data-outline="1"/>`);
  for (const t of doc.pcb.tracks) {
    if (t.layer !== opts.layer) continue;
    parts.push(`<polyline data-track="${t.id}" points="${t.points.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}" fill="none" stroke="#000" stroke-width="${f(t.widthMm)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  const holes: string[] = [];
  for (const p of allPads(doc)) {
    if (!p.layers.includes(opts.layer)) continue;
    const { x, y } = p.pos;
    if (p.shape === 'rect') parts.push(`<rect data-pad="${p.refDes}.${p.ref.pad}" x="${f(x - p.w / 2)}" y="${f(y - p.h / 2)}" width="${f(p.w)}" height="${f(p.h)}" fill="#000"/>`);
    else if (p.shape === 'oval' && p.w !== p.h) {
      const r = Math.min(p.w, p.h) / 2;
      parts.push(`<rect data-pad="${p.refDes}.${p.ref.pad}" x="${f(x - p.w / 2)}" y="${f(y - p.h / 2)}" width="${f(p.w)}" height="${f(p.h)}" rx="${f(r)}" ry="${f(r)}" fill="#000"/>`);
    } else parts.push(`<circle data-pad="${p.refDes}.${p.ref.pad}" cx="${f(x)}" cy="${f(y)}" r="${f(Math.max(p.w, p.h) / 2)}" fill="#000"/>`);
    if (p.drill && opts.drillMarks !== false) holes.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(Math.min(p.drill / 2, 0.4))}" fill="#fff"/>`);
  }
  if (board.layers === 2) {
    for (const v of doc.pcb.vias) {
      parts.push(`<circle data-via="${v.id}" cx="${f(v.position.x)}" cy="${f(v.position.y)}" r="${f(v.diameterMm / 2)}" fill="#000"/>`);
      if (opts.drillMarks !== false) holes.push(`<circle cx="${f(v.position.x)}" cy="${f(v.position.y)}" r="${f(Math.min(v.drillMm / 2, 0.3))}" fill="#fff"/>`);
    }
  }
  const content = parts.join('') + holes.join('');
  const g = opts.mirror ? `<g transform="translate(${f(board.widthMm)} 0) scale(-1 1)" data-mirrored="1">${content}</g>` : `<g>${content}</g>`;
  const layerName = opts.layer === 'top' ? 'Верхний слой' : 'Нижний слой';
  const forLut = opts.mirror === lutMirror(opts.layer);
  const view = opts.mirror ? 'зеркально' : 'вид сверху, без зеркала';
  const caption = `${layerName} · ${view}${forLut ? ' — для ЛУТ (тонером на медь)' : ' — НЕ для ЛУТ'} · печать 1:1, масштаб 100 % · проверьте квадрат 10×10 мм линейкой`;
  return sheet(doc, g, caption, `${doc.name} — ${layerName.toLowerCase()}${opts.mirror ? ', зеркально' : ''}`);
}

/** Сборочный чертёж (вид сверху): контур платы, корпуса и позиционные обозначения, площадки контуром. */
export function assemblySvg(doc: ProjectDoc): Artwork {
  const board = doc.pcb.board ?? { ...DEFAULT_BOARD };
  const parts: string[] = [`<rect x="0" y="0" width="${f(board.widthMm)}" height="${f(board.heightMm)}" fill="none" stroke="#000" stroke-width="0.2"/>`];
  for (const pl of doc.pcb.placements) {
    const inst = doc.schematic.instances.find((i) => i.id === pl.instanceId);
    const b = bodyRect(doc, pl);
    const dash = pl.side === 'bottom' ? ' stroke-dasharray="0.8 0.5"' : '';
    if (b) parts.push(`<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="none" stroke="#000" stroke-width="0.15"${dash}/>`);
    for (const p of padsOf(doc, pl)) parts.push(`<circle cx="${f(p.pos.x)}" cy="${f(p.pos.y)}" r="${f(Math.min(p.w, p.h) / 2)}" fill="none" stroke="#666" stroke-width="0.1"/>`);
    const at = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 + 0.9 } : pl.position;
    parts.push(`<text x="${f(at.x)}" y="${f(at.y)}" font-size="1.8" text-anchor="middle" font-family="Arial, sans-serif">${esc(inst?.refDes ?? '?')}${pl.side === 'bottom' ? ' (снизу)' : ''}</text>`);
  }
  return sheet(doc, parts.join(''), 'Сборочный чертёж · вид со стороны деталей · пунктир — детали снизу · масштаб 1:1', `${doc.name} — сборочный чертёж`);
}
