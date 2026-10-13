/**
 * Авторасстановка деталей на плате: жадно, от самой «многовыводной» детали к простым. Каждая деталь
 * ставится в узел сетки 1,27 мм (поворот 0° или 90°), где сумма расстояний от её площадок до уже
 * поставленных площадок тех же цепей минимальна, без перекрытий (зазор между корпусами) и с отступом
 * от края. Разъёмы и клеммники тянутся к краю платы — к ним подходят провода.
 * Дорожки деталей, которые переставлены, удаляются: их форма больше не подходит (одна правка, Ctrl+Z).
 * Если с обычными полями вокруг деталей поместилось не всё, расстановка повторяется с полями уже
 * (до 1/4): плотнее, зато всё на плате (разводить такую плату труднее — помогут перемычки).
 */
import { logChange, touch } from './factory';
import type { Placement, Point, ProjectDoc } from './model';
import { boardPolygon, footprintBox, padsOf, PCB_GRID, rectInside } from './pcb';
import { pointInPoly } from './field';

export interface AutoplaceResult { doc: ProjectDoc; placed: number; notPlaced: string[] }

/** Поле вокруг детали: у микросхем шире — к их выводам подходит много дорожек. */
const fieldOf = (pads: number) => (pads >= 8 ? 3.2 : 1.3);
const EDGE = 1.5; // мм от края платы

export function autoplace(doc0: ProjectDoc): AutoplaceResult {
  const board0 = doc0.pcb.board;
  if (!board0 || !doc0.pcb.placements.length) return { doc: doc0, placed: 0, notPlaced: [] };
  const board = board0;
  const refOf = (pl: Placement) => doc0.schematic.instances.find((i) => i.id === pl.instanceId)?.refDes ?? '?';
  const catOf = (pl: Placement) => {
    const inst = doc0.schematic.instances.find((i) => i.id === pl.instanceId);
    const part = inst ? doc0.library.parts.find((p) => p.id === inst.partId) : undefined;
    const pkg = doc0.library.packages.find((p) => p.id === pl.packageId);
    return { cat: part?.category ?? '', terminal: pkg?.family === 'TERMINAL' || part?.category === 'connector' };
  };
  // Локальная геометрия при повороте: площадки и габарит относительно позиции
  const local = (pl: Placement, rotation: Placement['rotation']) => {
    const p0 = { ...pl, position: { x: 0, y: 0 }, rotation };
    const box = footprintBox(doc0, p0);
    const pads = padsOf(doc0, p0).map((p) => ({ x: p.pos.x, y: p.pos.y, net: p.netId }));
    return { box, pads };
  };
  const order = doc0.pcb.placements.slice().sort((a, b) => padsOf(doc0, b).length - padsOf(doc0, a).length);
  const W = board.widthMm, H = board.heightMm;
  const poly = boardPolygon(board);
  const center: Point = { x: W / 2, y: H / 2 };
  const g = PCB_GRID;
  // Геометрия поворотов считается один раз на деталь
  const geo = new Map(order.map((pl) => [pl.id, ([0, 90, 180, 270] as const).map((rotation) => ({ rotation, ...local(pl, rotation) }))]));
  let attempt = { result: new Map<string, { position: Point; rotation: Placement['rotation'] }>(), notPlaced: [] as string[] };
  for (const k of [1, 0.7, 0.45, 0.25]) {
    attempt = placeAll(k);
    if (!attempt.notPlaced.length) break;
  }
  const { result, notPlaced } = attempt;

  function placeAll(fieldK: number) {
  const placedRects: Array<{ x: number; y: number; w: number; h: number; f: number }> = [];
  const placedPads: Array<{ x: number; y: number; net: string | null }> = [];
  const result = new Map<string, { position: Point; rotation: Placement['rotation'] }>();
  const notPlaced: string[] = [];
  for (const pl of order) {
    const { terminal } = catOf(pl);
    const field = fieldOf(padsOf(doc0, pl).length) * fieldK;
    let best: { score: number; position: Point; rotation: Placement['rotation']; rect: { x: number; y: number; w: number; h: number }; pads: Array<{ x: number; y: number; net: string | null }> } | null = null;
    for (const { rotation, box, pads } of geo.get(pl.id)!) {
      for (let y = Math.ceil(-box.y / g) * g; y + box.y + box.h <= H; y += g) {
        for (let x = Math.ceil(-box.x / g) * g; x + box.x + box.w <= W; x += g) {
          const rect = { x: box.x + x, y: box.y + y, w: box.w, h: box.h };
          if (!pointInPoly(poly, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })) continue;
          if (!rectInside(board, rect, EDGE)) continue;
          if (placedRects.some((o) => o.x < rect.x + rect.w + field + o.f && rect.x < o.x + o.w + field + o.f && o.y < rect.y + rect.h + field + o.f && rect.y < o.y + o.h + field + o.f)) continue;
          let score = 0;
          for (const p of pads) {
            if (!p.net) continue;
            let dmin = Infinity;
            for (const q of placedPads) if (q.net === p.net) { const d = Math.hypot(p.x + x - q.x, p.y + y - q.y); if (d < dmin) dmin = d; }
            if (Number.isFinite(dmin)) score += dmin;
          }
          const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
          score += 0.15 * Math.hypot(cx - center.x, cy - center.y);
          if (terminal) score += 1.5 * Math.min(rect.x, rect.y, W - rect.x - rect.w, H - rect.y - rect.h);
          if (!best || score < best.score - 1e-9) best = { score, position: { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) }, rotation, rect, pads: pads.map((p) => ({ x: p.x + x, y: p.y + y, net: p.net })) };
        }
      }
    }
    if (!best) { notPlaced.push(refOf(pl)); continue; }
    placedRects.push({ ...best.rect, f: field });
    placedPads.push(...best.pads);
    result.set(pl.id, { position: best.position, rotation: best.rotation });
  }
  return { result, notPlaced };
  }
  if (!result.size) return { doc: doc0, placed: 0, notPlaced };
  const moved = new Set(result.keys());
  const placements = doc0.pcb.placements.map((pl) => (result.has(pl.id) ? { ...pl, ...result.get(pl.id)! } : pl));
  const tracks = doc0.pcb.tracks.filter((t) => !((t.from?.kind === 'pad' && moved.has(t.from.placementId)) || (t.to?.kind === 'pad' && moved.has(t.to.placementId))));
  const removed = doc0.pcb.tracks.length - tracks.length;
  // Переходы и перемычки, к которым больше не подходит ни одна дорожка, тоже убираются.
  const usedVias = new Set(tracks.flatMap((t) => [t.from, t.to]).flatMap((e) => (e?.kind === 'via' ? [e.viaId] : [])));
  const jumpers = doc0.pcb.jumpers.filter((j) => usedVias.has(j.aViaId) || usedVias.has(j.bViaId));
  const jumperVias = new Set(jumpers.flatMap((j) => [j.aViaId, j.bViaId]));
  const vias = doc0.pcb.vias.filter((v) => usedVias.has(v.id) || jumperVias.has(v.id));
  let doc: ProjectDoc = touch({ ...doc0, pcb: { ...doc0.pcb, placements, tracks, vias, jumpers } });
  doc = logChange(doc, 'pcb-autoplace', `Авторасстановка: деталей ${result.size}${removed ? `, удалено дорожек ${removed}` : ''}${notPlaced.length ? `; не поместились: ${notPlaced.join(', ')}` : ''}`);
  return { doc, placed: result.size, notPlaced };
}
