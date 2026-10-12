/**
 * Экспорт для производства: Gerber RS-274X (X2-атрибуты файла) и сверловка Excellon.
 * Единицы — мм, формат координат 4.6, начало — левый нижний угол платы, ось Y вверх (как принято
 * в Gerber; на экране Y направлена вниз, поэтому y_gerber = высота − y).
 *
 * Состав: медь (верх — только у двухсторонней платы, низ), маска (открыты площадки, переходы закрыты),
 * шелкография (контуры корпусов), контур платы, отверстия. Позиционные обозначения в шелкографию не
 * выводятся (нужен векторный шрифт) — это сказано в readme архива.
 */
import { APP_VERSION } from './appinfo';
import type { ProjectDoc } from './model';
import { allPads, bodyRect, boardPolygon, copperLayers, type Layer, type PadInfo } from './pcb';

export interface GerberFile { name: string; content: string }

const MASK_EXPANSION = 0.05; // мм на сторону
const SILK_LINE = 0.15;
const OUTLINE_LINE = 0.1;

const c6 = (mm: number) => Math.round(mm * 1e6).toString();
const n6 = (mm: number) => Number(mm.toFixed(6)).toString();

type Aperture = { kind: 'C'; d: number } | { kind: 'R' | 'O'; w: number; h: number };
const apKey = (a: Aperture) => (a.kind === 'C' ? `C${n6(a.d)}` : `${a.kind}${n6(a.w)}x${n6(a.h)}`);

class GerberWriter {
  private aps = new Map<string, number>();
  private apDefs: string[] = [];
  private body: string[] = [];
  private current: number | null = null;
  constructor(private readonly heightMm: number) {}
  private ap(a: Aperture): number {
    const k = apKey(a);
    let code = this.aps.get(k);
    if (code === undefined) {
      code = 10 + this.aps.size;
      this.aps.set(k, code);
      this.apDefs.push(`%ADD${code}${a.kind === 'C' ? `C,${n6(a.d)}` : `${a.kind},${n6(a.w)}X${n6(a.h)}`}*%`);
    }
    return code;
  }
  private select(a: Aperture) {
    const code = this.ap(a);
    if (code !== this.current) { this.body.push(`D${code}*`); this.current = code; }
  }
  private xy(x: number, y: number) { return `X${c6(x)}Y${c6(this.heightMm - y)}`; }
  flash(a: Aperture, x: number, y: number) { this.select(a); this.body.push(`${this.xy(x, y)}D03*`); }
  line(d: number, pts: Array<{ x: number; y: number }>) {
    if (pts.length < 2) return;
    this.select({ kind: 'C', d });
    this.body.push(`${this.xy(pts[0]!.x, pts[0]!.y)}D02*`);
    for (const p of pts.slice(1)) this.body.push(`${this.xy(p.x, p.y)}D01*`);
  }
  /** Смена полярности: D — медь, C — вырез (стирает уже нарисованное). */
  polarity(p: 'D' | 'C') { this.body.push(`%LP${p}*%`); }
  /** Заполненная область (G36/G37) по замкнутому контуру. */
  region(pts: Array<{ x: number; y: number }>) {
    this.body.push('G36*', `${this.xy(pts[0]!.x, pts[0]!.y)}D02*`);
    for (const p of [...pts.slice(1), pts[0]!]) this.body.push(`${this.xy(p.x, p.y)}D01*`);
    this.body.push('G37*');
  }
  text(fileFunction: string, polarity: 'Positive' | 'Negative' = 'Positive'): string {
    return [
      `%TF.GenerationSoftware,ElectronicLab,Electronic Lab,${APP_VERSION}*%`,
      `%TF.FileFunction,${fileFunction}*%`,
      `%TF.FilePolarity,${polarity}*%`,
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%LPD*%',
      ...this.apDefs,
      'G01*',
      ...this.body,
      'M02*',
      '',
    ].join('\n');
  }
}

const padAperture = (p: PadInfo, grow = 0): Aperture =>
  p.shape === 'round' || (p.shape === 'oval' && p.w === p.h)
    ? { kind: 'C', d: Math.max(p.w, p.h) + 2 * grow }
    : { kind: p.shape === 'rect' ? 'R' : 'O', w: p.w + 2 * grow, h: p.h + 2 * grow };

/** Имена файлов внутри архива (латиница — так их понимают производители и просмотрщики). */
export function gerberFiles(doc: ProjectDoc, base = 'board'): GerberFile[] {
  const board = doc.pcb.board;
  if (!board) throw new Error('Плата не создана');
  const H = board.heightMm;
  const layers = copperLayers(doc);
  const pads = allPads(doc);
  const out: GerberFile[] = [];
  const twoLayer = board.layers === 2;
  const poly = boardPolygon(board);

  const copper = (layer: Layer) => {
    const g = new GerberWriter(H);
    const pour = doc.pcb.pours.find((p) => p.layer === layer);
    if (pour) {
      // Заливка: контур платы → вырез отступа от края и чужой меди с зазором → поверх вся медь слоя.
      const c = pour.clearanceMm;
      g.region(poly);
      g.polarity('C');
      g.line(2 * board.rules.edgeMm, [...poly, poly[0]!]);
      for (const t of doc.pcb.tracks) if (t.layer === layer && t.netId !== pour.netId) g.line(t.widthMm + 2 * c, t.points);
      for (const p of pads) if (p.layers.includes(layer) && p.netId !== pour.netId) g.flash(padAperture(p, c), p.pos.x, p.pos.y);
      if (twoLayer) for (const v of doc.pcb.vias) if (v.netId !== pour.netId) g.flash({ kind: 'C', d: v.diameterMm + 2 * c }, v.position.x, v.position.y);
      g.polarity('D');
    }
    for (const t of doc.pcb.tracks) if (t.layer === layer) g.line(t.widthMm, t.points);
    for (const p of pads) if (p.layers.includes(layer)) g.flash(padAperture(p), p.pos.x, p.pos.y);
    if (twoLayer) for (const v of doc.pcb.vias) g.flash({ kind: 'C', d: v.diameterMm }, v.position.x, v.position.y);
    const n = layer === 'top' ? 1 : board.layers;
    return g.text(`Copper,L${n},${layer === 'top' ? 'Top' : 'Bot'}`);
  };
  const mask = (layer: Layer) => {
    const g = new GerberWriter(H);
    for (const p of pads) if (p.layers.includes(layer)) g.flash(padAperture(p, MASK_EXPANSION), p.pos.x, p.pos.y);
    return g.text(`Soldermask,${layer === 'top' ? 'Top' : 'Bot'}`, 'Negative');
  };
  const silk = (layer: Layer) => {
    const g = new GerberWriter(H);
    for (const pl of doc.pcb.placements) {
      if (pl.side !== layer) continue;
      const b = bodyRect(doc, pl);
      if (b) g.line(SILK_LINE, [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }, { x: b.x, y: b.y }]);
    }
    return g.text(`Legend,${layer === 'top' ? 'Top' : 'Bot'}`);
  };

  if (layers.includes('top')) out.push({ name: `${base}-F_Cu.gtl`, content: copper('top') });
  out.push({ name: `${base}-B_Cu.gbl`, content: copper('bottom') });
  if (layers.includes('top')) out.push({ name: `${base}-F_Mask.gts`, content: mask('top') });
  out.push({ name: `${base}-B_Mask.gbs`, content: mask('bottom') });
  out.push({ name: `${base}-F_SilkS.gto`, content: silk('top') });
  if (doc.pcb.placements.some((p) => p.side === 'bottom')) out.push({ name: `${base}-B_SilkS.gbo`, content: silk('bottom') });
  const edge = new GerberWriter(H);
  edge.line(OUTLINE_LINE, [...poly, poly[0]!]);
  out.push({ name: `${base}-Edge_Cuts.gm1`, content: edge.text('Profile,NP') });
  out.push({ name: `${base}-PTH.drl`, content: excellon(doc) });
  out.push({ name: 'readme.txt', content: readme(doc, out.map((x) => x.name)) });
  return out;
}

/** Сверловка Excellon: метрическая, координаты с десятичной точкой, начало — левый нижний угол. */
export function excellon(doc: ProjectDoc): string {
  const board = doc.pcb.board!;
  const H = board.heightMm;
  const hits: Array<{ d: number; x: number; y: number }> = [];
  for (const p of allPads(doc)) if (p.drill) hits.push({ d: p.drill, x: p.pos.x, y: p.pos.y });
  if (board.layers === 2) for (const v of doc.pcb.vias) hits.push({ d: v.drillMm, x: v.position.x, y: v.position.y });
  const sizes = [...new Set(hits.map((h) => Number(h.d.toFixed(3))))].sort((a, b) => a - b);
  const lines = ['M48', `; Электронная лаборатория ${APP_VERSION}`, '; FILE_FORMAT=decimal mm, origin bottom-left', '; TYPE=PLATED', 'METRIC', 'FMAT,2'];
  sizes.forEach((d, i) => lines.push(`T${i + 1}C${d.toFixed(3)}`));
  lines.push('%', 'G90', 'G05');
  sizes.forEach((d, i) => {
    lines.push(`T${i + 1}`);
    for (const h of hits) if (Number(h.d.toFixed(3)) === d) lines.push(`X${h.x.toFixed(3)}Y${(H - h.y).toFixed(3)}`);
  });
  lines.push('T0', 'M30', '');
  return lines.join('\n');
}

function readme(doc: ProjectDoc, names: string[]): string {
  const b = doc.pcb.board!;
  return [
    `Проект: ${doc.name} (ревизия ${doc.revision})`,
    `Плата: ${b.widthMm} × ${b.heightMm} мм, слоёв меди: ${b.layers}`,
    `Программа: Электронная лаборатория ${APP_VERSION}`,
    '',
    'Файлы:',
    ...names.map((n) => `  ${n}`),
    '  readme.txt',
    '',
    'Gerber RS-274X, мм, формат 4.6, начало координат — левый нижний угол платы.',
    'Сверловка Excellon, мм, десятичные координаты; все отверстия металлизированные (для двусторонней платы).',
    'Маска открыта над площадками (+0,05 мм на сторону); переходные отверстия закрыты маской.',
    'Шелкография: только контуры корпусов, без позиционных обозначений.',
    `Контур платы: ${({ rect: 'прямоугольник', rounded: 'скруглённые углы', circle: 'круг', polygon: 'многоугольник' } as Record<string, string>)[b.outline.kind]}; дуги переданы отрезками по 3°.`,
    ...doc.pcb.pours.map((p) => `Медная заливка: слой ${p.layer === 'top' ? 'верхний' : 'нижний'}, зазор ${p.clearanceMm} мм; площадки соединены сплошь (без термобарьеров); вырезы — полярностью LPC.`),
    '',
    'Экспорт проверен автотестами (обратное чтение и сравнение с моделью платы), но не производителем.',
    'Перед заказом откройте файлы в просмотрщике Gerber и сверьте с платой.',
    '',
  ].join('\n');
}
