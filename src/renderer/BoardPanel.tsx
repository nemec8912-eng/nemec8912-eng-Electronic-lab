/**
 * Вкладка «Плата» (этап 1b): односторонняя плата, медь снизу, выводные детали сверху.
 * Перенос из схемы — только кнопкой «Синхронизировать» с отчётом. Дорожка — щелчок по площадке, затем
 * по второй площадке той же цепи. Неразведённые соединения — пунктир. DRC — список справа.
 */
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import type { PadRef, Point, ProjectDoc } from '../core/model';
import { allPads, bodyRect, DEFAULT_RULES, drc, netName, ratsnest, type SyncReport } from '../core/pcb';
import { formatQuantity, parseQuantity } from '../core/library';

interface Props {
  doc: ProjectDoc;
  selectedTrack: string | null;
  selectedPlacement: string | null;
  onSelect(s: { kind: 'track' | 'placement'; id: string } | null): void;
  onSync(): SyncReport;
  onBoard(w: number, h: number): void;
  onMove(id: string, p: Point, dragId: string): void;
  onRotate(id: string): void;
  onTrack(a: PadRef, b: PadRef, widthMm: number): string | null;
  onDeleteTrack(id: string): void;
  onExport(copperSide: boolean): void;
}

export function BoardPanel(p: Props) {
  const { doc } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -5, y: -5, scale: 9 }); // px на мм
  const [trackFrom, setTrackFrom] = useState<PadRef | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [width, setWidth] = useState(0.8);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ kind: 'pan'; sx: number; sy: number; vx: number; vy: number } | { kind: 'pl'; id: string; dx: number; dy: number; dragId: string } | null>(null);

  const pads = useMemo(() => allPads(doc), [doc]);
  const rats = useMemo(() => ratsnest(doc), [doc]);
  const issues = useMemo(() => drc(doc), [doc]);
  const board = doc.pcb.board;

  const toMm = (cx: number, cy: number): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: view.x + (cx - r.left) / view.scale, y: view.y + (cy - r.top) / view.scale };
  };

  const onPointerDown = (e: RPointerEvent) => {
    const t = e.target as Element;
    const m = toMm(e.clientX, e.clientY);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setError(null);
    const padEl = t.closest('[data-pad]');
    if (padEl && e.button === 0) {
      const ref = { placementId: padEl.getAttribute('data-placement')!, pad: padEl.getAttribute('data-pad')! };
      if (trackFrom) {
        const err = p.onTrack(trackFrom, ref, width);
        if (err) setError(err);
        setTrackFrom(null);
      } else setTrackFrom(ref);
      return;
    }
    if (trackFrom) { setTrackFrom(null); return; }
    const plEl = t.closest('[data-placement-id]');
    const trEl = t.closest('[data-track-id]');
    if (plEl && e.button === 0) {
      const id = plEl.getAttribute('data-placement-id')!;
      const pl = doc.pcb.placements.find((x) => x.id === id)!;
      drag.current = { kind: 'pl', id, dx: m.x - pl.position.x, dy: m.y - pl.position.y, dragId: `drag:pl:${id}:${e.timeStamp}` };
      p.onSelect({ kind: 'placement', id });
    } else if (trEl && e.button === 0) {
      p.onSelect({ kind: 'track', id: trEl.getAttribute('data-track-id')! });
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
    else p.onMove(d.id, { x: m.x - d.dx, y: m.y - d.dy }, d.dragId);
  };
  const onWheel = (e: RWheelEvent) => {
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const scale = Math.min(60, Math.max(2, view.scale * k));
    const m = toMm(e.clientX, e.clientY);
    const r = svgRef.current!.getBoundingClientRect();
    setView({ scale, x: m.x - (e.clientX - r.left) / scale, y: m.y - (e.clientY - r.top) / scale });
  };

  const fromPad = trackFrom ? pads.find((x) => x.ref.placementId === trackFrom.placementId && x.ref.pad === trackFrom.pad) : undefined;
  const fromNet = fromPad?.netId ?? null;

  return (
    <div className="board-tab">
      <div className="canvas-wrap">
        <svg ref={svgRef} className="canvas board-canvas" aria-label="Плата" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={() => { drag.current = null; }} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}>
          <g transform={`scale(${view.scale}) translate(${-view.x} ${-view.y})`}>
            {board && <rect x={0} y={0} width={board.widthMm} height={board.heightMm} className="board-outline" />}
            {doc.pcb.placements.map((pl) => {
              const b = bodyRect(doc, pl);
              const inst = doc.schematic.instances.find((i) => i.id === pl.instanceId);
              const sel = p.selectedPlacement === pl.id;
              return (
                <g key={pl.id} data-placement-id={pl.id} data-refdes={inst?.refDes ?? '?'} className={`pl ${sel ? 'selected' : ''} ${inst ? '' : 'orphan'}`}>
                  {b && <rect x={b.x} y={b.y} width={b.w} height={b.h} className="pl-body" />}
                  {b && <text x={b.x + 0.3} y={b.y - 0.5} className="pl-label">{inst?.refDes ?? 'удалена'}</text>}
                </g>
              );
            })}
            {doc.pcb.tracks.map((t) => (
              <g key={t.id} data-track-id={t.id} className={`track ${p.selectedTrack === t.id ? 'selected' : ''}`}>
                <polyline points={t.points.map((q) => `${q.x},${q.y}`).join(' ')} strokeWidth={t.widthMm} className="track-line" />
              </g>
            ))}
            {rats.map((r, i) => <line key={i} x1={r.a.x} y1={r.a.y} x2={r.b.x} y2={r.b.y} className="rat" />)}
            {pads.map((pd) => {
              const hl = fromNet !== null && pd.netId === fromNet;
              return (
                <g key={`${pd.ref.placementId}#${pd.ref.pad}`} data-pad={pd.ref.pad} data-placement={pd.ref.placementId} data-pad-label={`${pd.refDes}.${pd.ref.pad}`}
                  className={`pad ${hl ? 'same-net' : ''} ${trackFrom && pd.ref.placementId === trackFrom.placementId && pd.ref.pad === trackFrom.pad ? 'active' : ''}`}>
                  {pd.shape === 'rect'
                    ? <rect x={pd.pos.x - pd.w / 2} y={pd.pos.y - pd.h / 2} width={pd.w} height={pd.h} className="pad-cu" />
                    : <ellipse cx={pd.pos.x} cy={pd.pos.y} rx={pd.w / 2} ry={pd.h / 2} className="pad-cu" />}
                  {pd.drill && <circle cx={pd.pos.x} cy={pd.pos.y} r={pd.drill / 2} className="pad-hole" />}
                </g>
              );
            })}
            {fromPad && cursor && <line x1={fromPad.pos.x} y1={fromPad.pos.y} x2={cursor.x} y2={cursor.y} strokeWidth={width} className="track-rubber" />}
          </g>
        </svg>
        <div className="canvas-hint">Вид со стороны деталей · медь снизу · шаг сетки 1,27 мм · {Math.round(view.scale * 10) / 10} пикс/мм</div>
        {trackFrom && <div className="canvas-status">Дорожка: щёлкните площадку той же цепи{fromNet ? ` (${netName(doc, fromNet)})` : ''}. Esc или щелчок мимо — отмена</div>}
      </div>
      <aside className="test-side" aria-label="Плата: настройки">
        <section>
          <h3>Плата</h3>
          <button className="btn primary" onClick={() => setReport(p.onSync())}>Синхронизировать со схемой</button>
          {report && (
            <div className="sync-report" data-testid="sync-report">
              <p>Добавлено: {report.added.length ? report.added.join(', ') : 'нет'}</p>
              <p>Удалено: {report.removed.length ? report.removed.join('; ') : 'нет'}{report.removedTracks ? `, дорожек: ${report.removedTracks}` : ''}</p>
              <p>Без изменений: {report.kept}</p>
              {report.notPlaced.map((n) => <p key={n.refDes} className="muted small">{n.refDes}: не размещена — {n.reason}</p>)}
              {report.problems.map((m, i) => <p key={i} className="error-text small">{m}</p>)}
            </div>
          )}
          <BoardSize doc={doc} onBoard={p.onBoard} />
          <label className="field inline"><span>Ширина дорожки</span>
            <input aria-label="Ширина дорожки" defaultValue={formatQuantity(width / 1000, 'м', 3)}
              onBlur={(e) => { const v = parseQuantity(e.target.value, 'м'); if (v && v > 0 && v < 0.01) setWidth(Number((v * 1000).toFixed(3))); else e.target.value = formatQuantity(width / 1000, 'м', 3); }} />
          </label>
          {error && <p className="error-text" role="alert">{error}</p>}
          {p.selectedPlacement && <button className="btn" onClick={() => p.onRotate(p.selectedPlacement!)}>Повернуть деталь (R)</button>}
          {p.selectedTrack && <button className="btn danger" onClick={() => p.onDeleteTrack(p.selectedTrack!)}>Удалить дорожку</button>}
        </section>
        <section>
          <h3>Проверка (DRC)</h3>
          <p className="muted small">Зазор {DEFAULT_RULES.clearanceMm} мм, дорожка от {DEFAULT_RULES.minTrackMm} мм, отступ от края {DEFAULT_RULES.edgeMm} мм.</p>
          <ul className="issues" aria-label="Проверка платы" data-testid="drc">
            {issues.length === 0 && <li className="ok">Ошибок нет, всё разведено</li>}
            {issues.map((i, k) => <li key={k} className={i.severity}>{i.message}</li>)}
          </ul>
          <p className="muted small">DRC не заменяет электрическую проверку готовой платы.</p>
        </section>
        <section>
          <h3>Печать 1:1 для ЛУТ</h3>
          <button className="btn" onClick={() => p.onExport(false)}>SVG — вид со стороны деталей</button>
          <button className="btn" onClick={() => p.onExport(true)}>SVG — вид со стороны меди</button>
          <p className="muted small">Медь снизу: для ЛУТ печатайте «вид со стороны деталей» — при переносе тонера изображение зеркалится. Печатайте с масштабом 100 % и проверьте квадрат 10×10 мм линейкой. Gerber/Excellon — этап 6.</p>
        </section>
      </aside>
    </div>
  );
}

function BoardSize({ doc, onBoard }: { doc: ProjectDoc; onBoard(w: number, h: number): void }) {
  const b = doc.pcb.board;
  const [w, setW] = useState(String(b?.widthMm ?? 60));
  const [h, setH] = useState(String(b?.heightMm ?? 40));
  const commit = () => {
    const W = Number(w.replace(',', '.')), H = Number(h.replace(',', '.'));
    if (W >= 5 && W <= 500 && H >= 5 && H <= 500) onBoard(W, H);
    else { setW(String(b?.widthMm ?? 60)); setH(String(b?.heightMm ?? 40)); }
  };
  return (
    <div className="row">
      <label className="field inline"><span>Ширина, мм</span><input aria-label="Ширина платы, мм" value={w} onChange={(e) => setW(e.target.value)} onBlur={commit} /></label>
      <label className="field inline"><span>Высота, мм</span><input aria-label="Высота платы, мм" value={h} onChange={(e) => setH(e.target.value)} onBlur={commit} /></label>
    </div>
  );
}
