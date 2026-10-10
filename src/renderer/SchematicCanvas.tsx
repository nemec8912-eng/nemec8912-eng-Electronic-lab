/**
 * Полотно вкладки «Схема». На этапе 1 — сетка, масштаб, панорама и текстовые заметки (аннотации).
 * Компоненты, провода и соединения появятся на этапе 3; связи тогда будут храниться графом сетей.
 */
import { useCallback, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import type { Annotation, Point } from '../core/model';

interface Props {
  annotations: Annotation[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onAdd(p: Point): void;
  /** dragId одинаков для всего перетаскивания — оно становится одним шагом отмены. */
  onMove(id: string, p: Point, dragId: string): void;
}

const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export function noteSize(text: string) {
  const lines = (text || ' ').split('\n').slice(0, 40);
  const w = Math.min(480, Math.max(60, ...lines.map((l) => l.length * 7.2 + 20)));
  return { w, h: lines.length * 17 + 14, lines };
}

export function SchematicCanvas({ annotations, selectedId, onSelect, onAdd, onMove }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -40, y: -40, scale: 1 });
  const drag = useRef<
    | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
    | { kind: 'note'; id: string; dx: number; dy: number; last: Point; dragId: string }
    | null
  >(null);

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    return { x: view.x + (clientX - r.left) / view.scale, y: view.y + (clientY - r.top) / view.scale };
  }, [view]);

  const onWheel = (e: RWheelEvent) => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const scale = Math.min(8, Math.max(0.2, view.scale * factor));
    const p = toWorld(e.clientX, e.clientY);
    const r = svgRef.current!.getBoundingClientRect();
    setView({ scale, x: p.x - (e.clientX - r.left) / scale, y: p.y - (e.clientY - r.top) / scale });
  };

  const onPointerDown = (e: RPointerEvent) => {
    const target = (e.target as Element).closest('[data-note-id]');
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (target && e.button === 0) {
      const id = target.getAttribute('data-note-id')!;
      const a = annotations.find((n) => n.id === id)!;
      const p = toWorld(e.clientX, e.clientY);
      drag.current = { kind: 'note', id, dx: p.x - a.position.x, dy: p.y - a.position.y, last: a.position, dragId: `drag:${id}:${e.timeStamp}` };
      onSelect(id);
    } else {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
      if (e.button === 0) onSelect(null);
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.vx - (e.clientX - d.startX) / v.scale, y: d.vy - (e.clientY - d.startY) / v.scale }));
    } else {
      const p = toWorld(e.clientX, e.clientY);
      const next = { x: snap(p.x - d.dx), y: snap(p.y - d.dy) };
      if (next.x !== d.last.x || next.y !== d.last.y) {
        d.last = next;
        onMove(d.id, next, d.dragId);
      }
    }
  };

  const onPointerUp = () => { drag.current = null; };

  const onDoubleClick = (e: RMouseEvent) => {
    if ((e.target as Element).closest('[data-note-id]')) return;
    const p = toWorld(e.clientX, e.clientY);
    onAdd({ x: snap(p.x), y: snap(p.y) });
  };

  const gridPx = GRID * view.scale;
  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className="canvas"
        aria-label="Полотно схемы"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <defs>
          <pattern id="grid-small" width={gridPx} height={gridPx} patternUnits="userSpaceOnUse" x={-view.x * view.scale} y={-view.y * view.scale}>
            <circle cx={0.5} cy={0.5} r={0.6} className="grid-dot" />
          </pattern>
        </defs>
        {gridPx >= 4 && <rect width="100%" height="100%" fill="url(#grid-small)" />}
        <g transform={`scale(${view.scale}) translate(${-view.x} ${-view.y})`}>
          {annotations.map((a) => {
            const { w, h, lines } = noteSize(a.text);
            const sel = a.id === selectedId;
            return (
              <g key={a.id} data-note-id={a.id} className={`note ${sel ? 'selected' : ''}`} transform={`translate(${a.position.x} ${a.position.y})`}>
                <rect width={w} height={h} rx={3} />
                <text x={10} y={20}>
                  {lines.map((l, i) => <tspan key={i} x={10} dy={i === 0 ? 0 : 17}>{l || ' '}</tspan>)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="canvas-hint">
        Двойной щелчок — заметка · перетаскивание — перемещение · колесо — масштаб ({Math.round(view.scale * 100)}%)
        <button className="btn small" onClick={() => setView({ x: -40, y: -40, scale: 1 })}>Сбросить вид</button>
      </div>
      <div className="stage-note">Редактор принципиальных схем (компоненты, провода, ERC) — этап 3. Сейчас на полотне доступны только текстовые заметки.</div>
    </div>
  );
}
