/**
 * Вкладка «Плата» (этап 6): односторонняя и двухсторонняя плата.
 * Полотно — вид со стороны деталей; детали перетаскиваются, R — поворот, F — на другую сторону.
 * Дорожка: щелчок по площадке → щелчки по полю ставят изгибы → щелчок по площадке той же цепи.
 * На двухсторонней плате V (или кнопка «Переход») ставит переходное отверстие и меняет слой.
 * Backspace — убрать последний изгиб, Esc — отмена. Настройки, DRC и вывод — BoardSide.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import type { Point, ProjectDoc, TrackEnd } from '../core/model';
import {
  addRoute, allPads, bodyRect, copperLayers, deleteTrack, deleteVia, drc, endInfo, flipPlacement, fmtLen, footprintBox, type Layer,
  movePlacement, netName, parseLen, ratsnest, rotatePlacement, rulesOf, snapMm, type DrcIssue,
} from '../core/pcb';
import { BoardSide } from './BoardSide';
import { outlineSvgPath } from '../core/outline';

export type BoardSel = { kind: 'track' | 'placement' | 'via'; id: string } | null;

interface Props {
  doc: ProjectDoc;
  selection: BoardSel;
  onSelect(s: BoardSel): void;
  onEdit(label: string, fn: (d: ProjectDoc) => ProjectDoc, coalesceKey?: string): void;
  toast(text: string, kind?: 'ok' | 'error'): void;
}

interface Route {
  from: TrackEnd;
  netId: string;
  legs: Array<{ layer: Layer; bends: Point[] }>;
  vias: Point[];
}

const lastPoint = (doc: ProjectDoc, r: Route): Point => {
  const leg = r.legs[r.legs.length - 1]!;
  if (leg.bends.length) return leg.bends[leg.bends.length - 1]!;
  if (r.vias.length) return r.vias[r.vias.length - 1]!;
  return endInfo(doc, r.from)?.pos ?? { x: 0, y: 0 };
};

export function BoardPanel(p: Props) {
  const { doc, selection } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -5, y: -5, scale: 9 }); // px на мм
  const [route, setRoute] = useState<Route | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [layer, setLayer] = useState<Layer>('bottom');
  const [show, setShow] = useState<Record<Layer, boolean>>({ top: true, bottom: true });
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<DrcIssue | null>(null);
  const drag = useRef<{ kind: 'pan'; sx: number; sy: number; vx: number; vy: number } | { kind: 'pl'; id: string; dx: number; dy: number; dragId: string } | null>(null);

  const board = doc.pcb.board;
  const layers = copperLayers(doc);
  const two = layers.length === 2;
  const units = board?.units ?? 'mm';
  const rules = rulesOf(doc);
  const [width, setWidth] = useState(rules.trackMm);
  useEffect(() => setWidth(rules.trackMm), [rules.trackMm]);
  useEffect(() => { if (!two) setLayer('bottom'); }, [two]);

  const pads = useMemo(() => allPads(doc), [doc]);
  const rats = useMemo(() => ratsnest(doc), [doc]);
  const issues = useMemo(() => drc(doc), [doc]);

  // Вписать плату в окно при первом показе.
  const fit = useCallback(() => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x0 = 0, y0 = 0, x1 = board?.widthMm ?? 60, y1 = board?.heightMm ?? 40;
    for (const pl of doc.pcb.placements) { const b = footprintBox(doc, pl); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    const scale = Math.max(2, Math.min(60, Math.min((r.width - 40) / (x1 - x0), (r.height - 40) / (y1 - y0))));
    setView({ scale, x: x0 - (r.width / scale - (x1 - x0)) / 2, y: y0 - (r.height / scale - (y1 - y0)) / 2 });
  }, [board, doc]);
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && svgRef.current && svgRef.current.getBoundingClientRect().width > 0) { fitted.current = true; fit(); } }, [fit]);

  const toMm = (cx: number, cy: number): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: view.x + (cx - r.left) / view.scale, y: view.y + (cy - r.top) / view.scale };
  };
  const snap = (q: Point): Point => ({ x: snapMm(q.x), y: snapMm(q.y) });

  const startRoute = (from: TrackEnd) => {
    const e = endInfo(doc, from);
    if (!e) return;
    if (!e.netId) { setError(`${e.label}: площадка не подключена ни к одной цепи схемы`); return; }
    const l: Layer = e.layers.includes(layer) && layers.includes(layer) ? layer : (e.layers.find((x) => layers.includes(x)) ?? layer);
    if (!e.layers.some((x) => layers.includes(x))) { setError(`${e.label}: SMD-площадка на стороне без меди — переверните деталь (F)`); return; }
    setLayer(l);
    setRoute({ from, netId: e.netId, legs: [{ layer: l, bends: [] }], vias: [] });
  };
  const finishRoute = (to: TrackEnd) => {
    if (!route) return;
    const spec = { from: route.from, to, widthMm: width, legs: route.legs, vias: route.vias };
    // Проверка на текущем документе: правка применяется, только если трасса допустима.
    const check = addRoute(doc, spec);
    if (check.error) { setError(check.error); setRoute(null); return; }
    p.onEdit(route.vias.length ? 'Дорожка с переходом' : 'Дорожка', (d) => addRoute(d, spec).doc);
    setRoute(null);
  };
  const placeVia = useCallback(() => {
    if (!route || !two) return;
    const at = cursor ? snap(cursor) : lastPoint(doc, route);
    const next: Layer = route.legs[route.legs.length - 1]!.layer === 'top' ? 'bottom' : 'top';
    setRoute({ ...route, vias: [...route.vias, at], legs: [...route.legs, { layer: next, bends: [] }] });
    setLayer(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, two, cursor, doc]);
  const undoPoint = useCallback(() => {
    if (!route) return;
    const leg = route.legs[route.legs.length - 1]!;
    if (leg.bends.length) setRoute({ ...route, legs: [...route.legs.slice(0, -1), { ...leg, bends: leg.bends.slice(0, -1) }] });
    else if (route.vias.length) { setRoute({ ...route, vias: route.vias.slice(0, -1), legs: route.legs.slice(0, -1) }); setLayer(route.legs[route.legs.length - 2]!.layer); }
    else setRoute(null);
  }, [route]);

  // Клавиши платы. Во время прокладки дорожки перехватываются раньше общих (Backspace не удаляет выделение).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (route) {
        if (e.key === 'Escape') setRoute(null);
        else if (e.key === 'Backspace') undoPoint();
        else if (e.code === 'KeyV') placeVia();
        else return;
        e.preventDefault(); e.stopImmediatePropagation();
        return;
      }
      if (!selection) { if (e.key === 'Escape') setError(null); return; }
      const sel = selection;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.kind === 'track') p.onEdit('Удаление дорожки', (d) => deleteTrack(d, sel.id));
        else if (sel.kind === 'via') p.onEdit('Удаление переходного отверстия', (d) => deleteVia(d, sel.id).doc);
        else return;
        p.onSelect(null);
      } else if (e.code === 'KeyR' && sel.kind === 'placement') p.onEdit('Поворот детали на плате', (d) => rotatePlacement(d, sel.id));
      else if (e.code === 'KeyF' && sel.kind === 'placement') p.onEdit('Деталь на другую сторону платы', (d) => flipPlacement(d, sel.id));
      else if (e.key === 'Escape') p.onSelect(null);
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [route, selection, p, undoPoint, placeVia]);

  const endFromTarget = (t: Element): TrackEnd | null => {
    const padEl = t.closest('[data-pad]');
    if (padEl) return { kind: 'pad', placementId: padEl.getAttribute('data-placement')!, pad: padEl.getAttribute('data-pad')! };
    const viaEl = t.closest('[data-via-id]');
    if (viaEl) return { kind: 'via', viaId: viaEl.getAttribute('data-via-id')! };
    return null;
  };

  const onPointerDown = (e: RPointerEvent) => {
    const t = e.target as Element;
    const m = toMm(e.clientX, e.clientY);
    if (e.button === 2) { if (route) setRoute(null); return; }
    if (e.button === 1) { drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; (e.currentTarget as Element).setPointerCapture(e.pointerId); return; }
    if (e.button !== 0) return;
    setError(null);
    const end = endFromTarget(t);
    if (route) {
      if (end) finishRoute(end);
      else {
        const leg = route.legs[route.legs.length - 1]!;
        setRoute({ ...route, legs: [...route.legs.slice(0, -1), { ...leg, bends: [...leg.bends, snap(m)] }] });
      }
      return;
    }
    if (end?.kind === 'pad') { startRoute(end); return; }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (end?.kind === 'via') { p.onSelect({ kind: 'via', id: end.viaId }); return; }
    const plEl = t.closest('[data-placement-id]');
    const trEl = t.closest('[data-track-id]');
    if (trEl) p.onSelect({ kind: 'track', id: trEl.getAttribute('data-track-id')! });
    else if (plEl) {
      const id = plEl.getAttribute('data-placement-id')!;
      const pl = doc.pcb.placements.find((x) => x.id === id)!;
      drag.current = { kind: 'pl', id, dx: m.x - pl.position.x, dy: m.y - pl.position.y, dragId: `drag:pl:${id}:${e.timeStamp}` };
      p.onSelect({ kind: 'placement', id });
    } else {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      p.onSelect(null);
    }
  };
  const onPointerMove = (e: RPointerEvent) => {
    const m = toMm(e.clientX, e.clientY);
    setCursor(m);
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.vx - (e.clientX - d.sx) / v.scale, y: d.vy - (e.clientY - d.sy) / v.scale }));
    else p.onEdit('Перемещение детали на плате', (doc2) => movePlacement(doc2, d.id, { x: m.x - d.dx, y: m.y - d.dy }), d.dragId);
  };
  const zoomAt = (k: number, cx?: number, cy?: number) => {
    const el = svgRef.current!;
    const r = el.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
    const m = toMm(px, py);
    const scale = Math.min(80, Math.max(1.5, view.scale * k));
    setView({ scale, x: m.x - (px - r.left) / scale, y: m.y - (py - r.top) / scale });
  };
  const onWheel = (e: RWheelEvent) => zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);

  const showIssue = (i: DrcIssue) => {
    setFocus(i);
    if (i.at && svgRef.current) {
      const r = svgRef.current.getBoundingClientRect();
      setView((v) => ({ ...v, x: i.at!.x - r.width / v.scale / 2, y: i.at!.y - r.height / v.scale / 2 }));
    }
    const id = i.ids[0];
    if (id) {
      if (doc.pcb.tracks.some((t) => t.id === id)) p.onSelect({ kind: 'track', id });
      else if (doc.pcb.vias.some((v) => v.id === id)) p.onSelect({ kind: 'via', id });
      else if (doc.pcb.placements.some((x) => x.id === id)) p.onSelect({ kind: 'placement', id });
    }
  };

  const routeNet = route?.netId ?? null;
  const activeLayer = route ? route.legs[route.legs.length - 1]!.layer : layer;
  const layerOrder: Layer[] = activeLayer === 'top' ? ['bottom', 'top'] : ['top', 'bottom'];
  const routePts = route ? (() => {
    const start = endInfo(doc, route.from)?.pos;
    const segs: Array<{ layer: Layer; pts: Point[] }> = [];
    let prev = start ? [start] : [];
    route.legs.forEach((leg, i) => {
      const pts = [...prev, ...leg.bends];
      if (i < route.vias.length) pts.push(route.vias[i]!);
      segs.push({ layer: leg.layer, pts });
      prev = pts.length ? [pts[pts.length - 1]!] : [];
    });
    return segs;
  })() : [];
  const cursorSnap = cursor ? snap(cursor) : null;
  const tail = route && cursorSnap ? lastPoint(doc, route) : null;

  return (
    <div className="board-tab">
      <div className="canvas-wrap board-wrap">
        <div className="canvas-toolbar" role="toolbar" aria-label="Плата: вид">
          {two && (
            <div className="seg" role="radiogroup" aria-label="Слой дорожки">
              {(['top', 'bottom'] as const).map((l) => (
                <button key={l} role="radio" aria-checked={activeLayer === l} className={`btn small layer-btn ${l} ${activeLayer === l ? 'on' : ''}`}
                  onClick={() => { if (route) { const leg = route.legs[route.legs.length - 1]!; setRoute({ ...route, legs: [...route.legs.slice(0, -1), { ...leg, layer: l }] }); } setLayer(l); }}>
                  {l === 'top' ? 'Верхний слой' : 'Нижний слой'}
                </button>
              ))}
            </div>
          )}
          <label className="field inline compact"><span>Ширина дорожки</span>
            <input aria-label="Ширина дорожки" key={`${width}${units}`} defaultValue={fmtLen(width, units)}
              onBlur={(e) => { const v = parseLen(e.target.value, units); if (v && v > 0 && v < 10) setWidth(Number(v.toFixed(4))); else e.target.value = fmtLen(width, units); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          </label>
          {two && <>
            <label className="check"><input type="checkbox" checked={show.top} onChange={(e) => setShow({ ...show, top: e.target.checked })} /> верх</label>
            <label className="check"><input type="checkbox" checked={show.bottom} onChange={(e) => setShow({ ...show, bottom: e.target.checked })} /> низ</label>
          </>}
          <span className="spacer" />
          <button className="btn small" onClick={() => zoomAt(1.25)} aria-label="Крупнее">+</button>
          <button className="btn small" onClick={() => zoomAt(0.8)} aria-label="Мельче">−</button>
          <button className="btn small" onClick={fit}>Показать всё</button>
        </div>
        <svg ref={svgRef} className={`canvas board-canvas ${route ? 'routing' : ''} ${two ? 'two-layer' : 'one-layer'}`} aria-label="Плата" data-scale={view.scale} data-vx={view.x} data-vy={view.y} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={() => { drag.current = null; }} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}>
          <g transform={`scale(${view.scale}) translate(${-view.x} ${-view.y})`}>
            {board && <path d={outlineSvgPath(board)} className="board-outline" data-outline={board.outline.kind} />}
            {board && doc.pcb.pours.filter((pr) => layers.includes(pr.layer) && show[pr.layer]).map((pr) => (
              <g key={pr.id} className={`pour ${pr.layer} ${pr.layer === activeLayer ? 'active' : 'inactive'}`} data-pour={pr.id}>
                <mask id={`pour-${pr.id}`} maskUnits="userSpaceOnUse">
                  <path d={outlineSvgPath(board)} fill="#fff" />
                  <path d={outlineSvgPath(board)} fill="none" stroke="#000" strokeWidth={2 * board.rules.edgeMm} />
                  {doc.pcb.tracks.filter((t) => t.layer === pr.layer && t.netId !== pr.netId).map((t) => (
                    <polyline key={t.id} points={t.points.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke="#000" strokeWidth={t.widthMm + 2 * pr.clearanceMm} strokeLinecap="round" strokeLinejoin="round" />
                  ))}
                  {pads.filter((pd) => pd.layers.includes(pr.layer) && pd.netId !== pr.netId).map((pd) => {
                    const w = pd.w + 2 * pr.clearanceMm, h = pd.h + 2 * pr.clearanceMm;
                    return <rect key={`${pd.ref.placementId}#${pd.ref.pad}`} x={pd.pos.x - w / 2} y={pd.pos.y - h / 2} width={w} height={h} rx={pd.shape === 'rect' ? 0 : Math.min(w, h) / 2} fill="#000" />;
                  })}
                  {two && doc.pcb.vias.filter((v) => v.netId !== pr.netId).map((v) => <circle key={v.id} cx={v.position.x} cy={v.position.y} r={v.diameterMm / 2 + pr.clearanceMm} fill="#000" />)}
                </mask>
                <path d={outlineSvgPath(board)} mask={`url(#pour-${pr.id})`} className="pour-fill" />
              </g>
            ))}
            {doc.pcb.placements.map((pl) => {
              const b = bodyRect(doc, pl);
              const inst = doc.schematic.instances.find((i) => i.id === pl.instanceId);
              const sel = selection?.kind === 'placement' && selection.id === pl.id;
              const fb = b ?? footprintBox(doc, pl);
              return (
                <g key={pl.id} data-placement-id={pl.id} data-x={pl.position.x} data-y={pl.position.y} data-rot={pl.rotation} data-side={pl.side} data-refdes={inst?.refDes ?? '?'}
                  className={`pl ${sel ? 'selected' : ''} ${inst ? '' : 'orphan'} side-${pl.side}`}>
                  <rect x={fb.x} y={fb.y} width={Math.max(fb.w, 0.5)} height={Math.max(fb.h, 0.5)} className="pl-body" />
                  <text x={fb.x + 0.3} y={fb.y - 0.5} className="pl-label">{inst?.refDes ?? 'удалена'}{pl.side === 'bottom' ? ' (снизу)' : ''}</text>
                </g>
              );
            })}
            {layerOrder.filter((l) => layers.includes(l) && show[l]).map((l) => (
              <g key={l} className={`cu-layer ${l} ${l === activeLayer ? 'active' : 'inactive'}`}>
                {doc.pcb.tracks.filter((t) => t.layer === l).map((t) => (
                  <g key={t.id} data-track-id={t.id} data-layer={t.layer} className={`track ${selection?.kind === 'track' && selection.id === t.id ? 'selected' : ''} ${routeNet && t.netId === routeNet ? 'same-net' : ''}`}>
                    <polyline points={t.points.map((q) => `${q.x},${q.y}`).join(' ')} strokeWidth={t.widthMm} className="track-line" />
                  </g>
                ))}
              </g>
            ))}
            {rats.map((r, i) => <line key={i} x1={r.a.x} y1={r.a.y} x2={r.b.x} y2={r.b.y} className={`rat ${routeNet === r.netId ? 'same-net' : ''}`} />)}
            {pads.map((pd) => {
              const hl = routeNet !== null && pd.netId === routeNet;
              const isFrom = route?.from.kind === 'pad' && route.from.placementId === pd.ref.placementId && route.from.pad === pd.ref.pad;
              return (
                <g key={`${pd.ref.placementId}#${pd.ref.pad}`} data-pad={pd.ref.pad} data-placement={pd.ref.placementId} data-pad-label={`${pd.refDes}.${pd.ref.pad}`} data-net={pd.netId ?? ''}
                  className={`pad ${hl ? 'same-net' : ''} ${isFrom ? 'active' : ''} ${pd.drill ? 'tht' : `smd ${pd.layers[0]}`}`}>
                  <title>{`${pd.refDes}.${pd.ref.pad} — ${netName(doc, pd.netId)}`}</title>
                  {pd.shape === 'rect'
                    ? <rect x={pd.pos.x - pd.w / 2} y={pd.pos.y - pd.h / 2} width={pd.w} height={pd.h} className="pad-cu" />
                    : <rect x={pd.pos.x - pd.w / 2} y={pd.pos.y - pd.h / 2} width={pd.w} height={pd.h} rx={Math.min(pd.w, pd.h) / 2} className="pad-cu" />}
                  {pd.drill && <circle cx={pd.pos.x} cy={pd.pos.y} r={pd.drill / 2} className="pad-hole" />}
                </g>
              );
            })}
            {doc.pcb.vias.map((v) => (
              <g key={v.id} data-via-id={v.id} className={`via ${selection?.kind === 'via' && selection.id === v.id ? 'selected' : ''} ${routeNet === v.netId ? 'same-net' : ''}`}>
                <title>{`Переходное отверстие — ${netName(doc, v.netId)}`}</title>
                <circle cx={v.position.x} cy={v.position.y} r={v.diameterMm / 2} className="via-cu" />
                <circle cx={v.position.x} cy={v.position.y} r={v.drillMm / 2} className="pad-hole" />
              </g>
            ))}
            {routePts.map((s, i) => s.pts.length > 1 && <polyline key={i} points={s.pts.map((q) => `${q.x},${q.y}`).join(' ')} strokeWidth={width} className={`track-rubber ${s.layer}`} />)}
            {route?.vias.map((v, i) => <circle key={i} cx={v.x} cy={v.y} r={rules.viaDiameterMm / 2} className="via-ghost" />)}
            {tail && cursorSnap && <line x1={tail.x} y1={tail.y} x2={cursorSnap.x} y2={cursorSnap.y} strokeWidth={width} className={`track-rubber ${activeLayer}`} />}
            {focus?.at && <circle cx={focus.at.x} cy={focus.at.y} r={Math.max(1.2, 12 / view.scale)} className="drc-mark" />}
          </g>
        </svg>
        <div className="canvas-hint">
          Вид со стороны деталей · {two ? 'двухсторонняя' : 'медь снизу'} · сетка 1,27 мм
          {cursor && ` · X ${fmtLen(cursor.x, units)} Y ${fmtLen(cursor.y, units)}`}
        </div>
        {route && (
          <div className="canvas-status" data-testid="route-status">
            Дорожка {netName(doc, route.netId)}, {activeLayer === 'top' ? 'верхний слой' : 'нижний слой'}: щелчок по полю — изгиб, по площадке той же цепи — конец.
            {two && <> <button className="btn small" onClick={placeVia}>Переход (V)</button></>} Backspace — назад, Esc — отмена
          </div>
        )}
        {error && <div className="canvas-error" role="alert">{error}</div>}
      </div>
      <BoardSide doc={doc} issues={issues} selection={selection} onSelect={p.onSelect} onEdit={p.onEdit} toast={p.toast} onShowIssue={showIssue}
        onRouteFromVia={(viaId) => startRoute({ kind: 'via', viaId })} />
    </div>
  );
}
