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
import { outlineSvgPath } from './outline';
import { allPads, bodyRect, boardVias, DEFAULT_BOARD, fmtLen, jumperEnds, jumperLength, jumperName, newBoard, type Layer, padsOf, viaLayers } from './pcb';

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

/** Медь слоя: дорожки, площадки, переходы; grow — расширение (для вырезов заливки), skipNet — цепь, которую пропустить. */
function copperMarkup(doc: ProjectDoc, layer: Layer, color: string, grow = 0, skipNet: string | null = null, tag = true): string {
  const board = doc.pcb.board!;
  const out: string[] = [];
  const keep = (net: string | null) => skipNet === null || net !== skipNet;
  for (const t of doc.pcb.tracks) {
    if (t.layer !== layer || !keep(t.netId)) continue;
    out.push(`<polyline${tag ? ` data-track="${t.id}"` : ''} points="${t.points.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${f(t.widthMm + 2 * grow)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const p of allPads(doc)) {
    if (!p.layers.includes(layer) || !keep(p.netId)) continue;
    const { x, y } = p.pos;
    const w = p.w + 2 * grow, h = p.h + 2 * grow;
    const attr = tag ? ` data-pad="${p.refDes}.${p.ref.pad}"` : '';
    if (p.shape === 'rect') out.push(`<rect${attr} x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" fill="${color}"/>`);
    else if (p.shape === 'oval' && p.w !== p.h) {
      const r = Math.min(w, h) / 2;
      out.push(`<rect${attr} x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(r)}" ry="${f(r)}" fill="${color}"/>`);
    } else out.push(`<circle${attr} cx="${f(x)}" cy="${f(y)}" r="${f(Math.max(w, h) / 2)}" fill="${color}"/>`);
  }
  if (viaLayers(doc).includes(layer)) {
    for (const v of boardVias(doc)) {
      if (!keep(v.netId)) continue;
      out.push(`<circle${tag ? ` data-via="${v.id}"` : ''} cx="${f(v.position.x)}" cy="${f(v.position.y)}" r="${f(v.diameterMm / 2 + grow)}" fill="${color}"/>`);
    }
  }
  return out.join('');
}

/** Рисунок меди одного слоя 1:1: заливка, дорожки, площадки, переходы, контур платы. */
export function artworkSvg(doc: ProjectDoc, opts: ArtworkOptions): Artwork {
  const board = doc.pcb.board ?? newBoard();
  const outline = outlineSvgPath(board, f);
  const parts: string[] = [];
  const pour = doc.pcb.pours.find((p) => p.layer === opts.layer);
  if (pour && doc.pcb.board) {
    // Заливка: контур → белым отступ от края и чужая медь с зазором → поверх вся медь слоя.
    parts.push(`<path data-pour="${pour.id}" d="${outline}" fill="#000"/>`);
    parts.push(`<path d="${outline}" fill="none" stroke="#fff" stroke-width="${f(2 * board.rules.edgeMm)}"/>`);
    parts.push(copperMarkup(doc, opts.layer, '#fff', pour.clearanceMm, pour.netId, false));
  }
  parts.push(`<path d="${outline}" fill="none" stroke="#000" stroke-width="0.15" data-outline="1"/>`);
  if (doc.pcb.board) parts.push(copperMarkup(doc, opts.layer, '#000'));
  const holes: string[] = [];
  if (opts.drillMarks !== false && doc.pcb.board) {
    for (const p of allPads(doc)) if (p.drill && p.layers.includes(opts.layer)) holes.push(`<circle cx="${f(p.pos.x)}" cy="${f(p.pos.y)}" r="${f(Math.min(p.drill / 2, 0.4))}" fill="#fff"/>`);
    for (const v of boardVias(doc)) if (viaLayers(doc).includes(opts.layer)) holes.push(`<circle cx="${f(v.position.x)}" cy="${f(v.position.y)}" r="${f(Math.min(v.drillMm / 2, 0.3))}" fill="#fff"/>`);
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
  const board = doc.pcb.board ?? newBoard();
  const parts: string[] = [`<path d="${outlineSvgPath(board, f)}" fill="none" stroke="#000" stroke-width="0.2"/>`];
  for (const pl of doc.pcb.placements) {
    const inst = doc.schematic.instances.find((i) => i.id === pl.instanceId);
    const b = bodyRect(doc, pl);
    const dash = pl.side === 'bottom' ? ' stroke-dasharray="0.8 0.5"' : '';
    if (b) parts.push(`<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="none" stroke="#000" stroke-width="0.15"${dash}/>`);
    for (const p of padsOf(doc, pl)) parts.push(`<circle cx="${f(p.pos.x)}" cy="${f(p.pos.y)}" r="${f(Math.min(p.w, p.h) / 2)}" fill="none" stroke="#666" stroke-width="0.1"/>`);
    const at = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 + 0.9 } : pl.position;
    parts.push(`<text x="${f(at.x)}" y="${f(at.y)}" font-size="1.8" text-anchor="middle" font-family="Arial, sans-serif">${esc(inst?.refDes ?? '?')}${pl.side === 'bottom' ? ' (снизу)' : ''}</text>`);
  }
  for (const j of doc.pcb.jumpers) {
    const e = jumperEnds(doc, j);
    if (!e) continue;
    const A = e.a.position, B = e.b.position;
    parts.push(`<line data-jumper="${j.id}" x1="${f(A.x)}" y1="${f(A.y)}" x2="${f(B.x)}" y2="${f(B.y)}" stroke="#000" stroke-width="0.5" stroke-linecap="round"/>`);
    for (const q of [A, B]) parts.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="${f(e.a.diameterMm / 2)}" fill="#fff" stroke="#000" stroke-width="0.15"/>`);
    const vert = Math.abs(B.y - A.y) > Math.abs(B.x - A.x);
    const mx = (A.x + B.x) / 2 + (vert ? 1.2 : 0), my = (A.y + B.y) / 2 + (vert ? 0.6 : -0.8);
    parts.push(`<text x="${f(mx)}" y="${f(my)}" font-size="1.5" text-anchor="${vert ? 'start' : 'middle'}" font-family="Arial, sans-serif">${esc(jumperName(doc, j))} ${esc(fmtLen(jumperLength(e)))}</text>`);
  }
  return sheet(doc, parts.join(''), doc.pcb.jumpers.length ? 'Сборочный чертёж · вид со стороны деталей · пунктир — детали снизу · П — проволочные перемычки · масштаб 1:1' : 'Сборочный чертёж · вид со стороны деталей · пунктир — детали снизу · масштаб 1:1', `${doc.name} — сборочный чертёж`);
}
