/**
 * Полотно схемы. Режимы: «правка» (размещение деталей, провода вывод→вывод, перемещение, заметки) и
 * «щупы» (вкладка «Тест»: щелчок по выводу ставит выбранный щуп, поверх — рассчитанные напряжения узлов).
 * Связность берётся из сетей документа, а не из рисунка: провод — лишь изображение соединения.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { formatQuantity, PARAMS } from '../core/library';
import type { ComponentInstance, PinRef, Point, ProjectDoc } from '../core/model';
import { pinPosition, rotatePoint, routeWire, samePin, snap, symbolOf } from '../core/schematic';
import type { MultimeterSettings } from '../core/instruments';
import { SymbolGraphic, symbolBounds } from './symbols';

export type Selection = { kind: 'note' | 'inst' | 'wire'; id: string } | null;

interface Props {
  doc: ProjectDoc;
  mode: 'edit' | 'probe';
  selection: Selection;
  onSelect(s: Selection): void;
  /** Деталь из каталога, ожидающая размещения (catalogId), или null. */
  placing?: string | null;
  onPlace?(catalogId: string, p: Point): void;
  onConnect?(a: PinRef, b: PinRef): void;
  onMoveInstance?(id: string, p: Point, dragId: string): void;
  onAddNote?(p: Point): void;
  onMoveNote?(id: string, p: Point, dragId: string): void;
  onPinClick?(pin: PinRef): void;
  probes?: MultimeterSettings;
  /** id сети → подпись (рассчитанное напряжение). */
  nodeLabels?: Record<string, string>;
  /** id объектов с проблемами (подсветка). */
  flagged?: Set<string>;
  hint?: string;
  banner?: string;
}

export function noteSize(text: string) {
  const lines = (text || ' ').split('\n').slice(0, 40);
  const w = Math.min(480, Math.max(60, ...lines.map((l) => l.length * 7.2 + 20)));
  return { w, h: lines.length * 17 + 14, lines };
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
  | { kind: 'note' | 'inst'; id: string; dx: number; dy: number; last: Point; dragId: string };

function instanceLabel(doc: ProjectDoc, inst: ComponentInstance): string[] {
  const part = doc.library.parts.find((p) => p.id === inst.partId);
  if (!part || part.category === 'reference') return [];
  const lines = [inst.refDes];
  for (const [k, q] of Object.entries(inst.values)) {
    const def = PARAMS[k];
    if (def) lines.push(formatQuantity(q.value, def.unitRu));
  }
  // На схеме видны и предельные параметры, если они определяют выбор (например, напряжение конденсатора).
  if (part.category === 'capacitor' && part.ratings.voltage) lines.push(formatQuantity(part.ratings.voltage.value, 'В'));
  return lines;
}

export function SchematicCanvas(p: Props) {
  const { doc } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -60, y: -60, scale: 1 });
  const [cursor, setCursor] = useState<Point | null>(null);
  const [wireFrom, setWireFrom] = useState<PinRef | null>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setWireFrom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: view.x + (clientX - r.left) / view.scale, y: view.y + (clientY - r.top) / view.scale };
  }, [view]);

  const onWheel = (e: RWheelEvent) => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const scale = Math.min(8, Math.max(0.2, view.scale * factor));
    const w = toWorld(e.clientX, e.clientY);
    const r = svgRef.current!.getBoundingClientRect();
    setView({ scale, x: w.x - (e.clientX - r.left) / scale, y: w.y - (e.clientY - r.top) / scale });
  };

  const pinFromTarget = (t: Element): PinRef | null => {
    const el = t.closest('[data-pin]');
    if (!el) return null;
    return { instanceId: el.getAttribute('data-inst')!, pin: el.getAttribute('data-pin')! };
  };

  const onPointerDown = (e: RPointerEvent) => {
    const t = e.target as Element;
    const w = toWorld(e.clientX, e.clientY);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button !== 0) {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
      return;
    }
    const pin = pinFromTarget(t);
    if (p.mode === 'probe') {
      if (pin) { p.onPinClick?.(pin); return; }
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
      return;
    }
    if (p.placing) {
      p.onPlace?.(p.placing, { x: snap(w.x), y: snap(w.y) });
      return;
    }
    if (pin) {
      if (wireFrom) {
        if (!samePin(wireFrom, pin)) p.onConnect?.(wireFrom, pin);
        setWireFrom(null);
      } else {
        setWireFrom(pin);
      }
      return;
    }
    if (wireFrom) { setWireFrom(null); return; }
    const instEl = t.closest('[data-inst-id]');
    const noteEl = t.closest('[data-note-id]');
    const wireEl = t.closest('[data-wire-id]');
    if (instEl) {
      const id = instEl.getAttribute('data-inst-id')!;
      const inst = doc.schematic.instances.find((i) => i.id === id)!;
      drag.current = { kind: 'inst', id, dx: w.x - inst.position.x, dy: w.y - inst.position.y, last: inst.position, dragId: `drag:inst:${id}:${e.timeStamp}` };
      p.onSelect({ kind: 'inst', id });
    } else if (noteEl) {
      const id = noteEl.getAttribute('data-note-id')!;
      const a = doc.schematic.annotations.find((n) => n.id === id)!;
      drag.current = { kind: 'note', id, dx: w.x - a.position.x, dy: w.y - a.position.y, last: a.position, dragId: `drag:note:${id}:${e.timeStamp}` };
      p.onSelect({ kind: 'note', id });
    } else if (wireEl) {
      p.onSelect({ kind: 'wire', id: wireEl.getAttribute('data-wire-id')! });
    } else {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
      p.onSelect(null);
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    setCursor(w);
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.vx - (e.clientX - d.startX) / v.scale, y: d.vy - (e.clientY - d.startY) / v.scale }));
      return;
    }
    const next = { x: snap(w.x - d.dx), y: snap(w.y - d.dy) };
    if (next.x === d.last.x && next.y === d.last.y) return;
    d.last = next;
    if (d.kind === 'inst') p.onMoveInstance?.(d.id, next, d.dragId);
    else p.onMoveNote?.(d.id, next, d.dragId);
  };

  const onPointerUp = () => { drag.current = null; };

  const onDoubleClick = (e: RMouseEvent) => {
    if (p.mode !== 'edit' || p.placing) return;
    if ((e.target as Element).closest('[data-note-id],[data-inst-id],[data-pin],[data-wire-id]')) return;
    const w = toWorld(e.clientX, e.clientY);
    p.onAddNote?.({ x: snap(w.x), y: snap(w.y) });
  };

  const gridPx = 10 * view.scale;
  const probeAt = (color: 'red' | 'black') => {
    const ref = p.probes?.[color];
    return ref ? pinPosition(doc, ref) : null;
  };
  const wireStart = wireFrom ? pinPosition(doc, wireFrom) : null;

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className={`canvas ${p.placing ? 'placing' : ''} ${p.mode === 'probe' ? 'probe-mode' : ''}`}
        aria-label="Полотно схемы"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="grid-small" width={gridPx} height={gridPx} patternUnits="userSpaceOnUse" x={-view.x * view.scale} y={-view.y * view.scale}>
            <circle cx={0.5} cy={0.5} r={0.6} className="grid-dot" />
          </pattern>
        </defs>
        {gridPx >= 4 && <rect width="100%" height="100%" fill="url(#grid-small)" />}
        <g transform={`scale(${view.scale}) translate(${-view.x} ${-view.y})`}>
          {doc.schematic.wires.map((w) => {
            const pts = w.points.map((q) => `${q.x},${q.y}`).join(' ');
            const sel = p.selection?.kind === 'wire' && p.selection.id === w.id;
            return (
              <g key={w.id} data-wire-id={w.id} className={`wire ${sel ? 'selected' : ''} ${p.flagged?.has(w.netId) ? 'flagged' : ''}`}>
                <polyline points={pts} className="wire-hit" />
                <polyline points={pts} className="wire-line" />
              </g>
            );
          })}
          {doc.schematic.instances.map((inst) => {
            const sym = symbolOf(doc, inst);
            if (!sym) return null;
            const b = symbolBounds(sym);
            const sel = p.selection?.kind === 'inst' && p.selection.id === inst.id;
            const label = instanceLabel(doc, inst);
            // Подпись — справа/снизу от символа без поворота текста.
            const corner = rotatePoint({ x: b.x + b.w, y: b.y }, inst.rotation, inst.mirrored);
            const vertical = inst.rotation === 90 || inst.rotation === 270;
            const labelPos = vertical ? { x: Math.abs(corner.x) + 6, y: -b.w / 2 + 10 } : { x: -b.w / 2, y: -Math.abs(b.y) - 6 - (label.length - 1) * 13 };
            return (
              <g key={inst.id} className={`inst ${sel ? 'selected' : ''} ${p.flagged?.has(inst.id) ? 'flagged' : ''}`} data-inst-id={inst.id} data-refdes={inst.refDes}
                transform={`translate(${inst.position.x} ${inst.position.y})`}>
                <g transform={`rotate(${inst.rotation})${inst.mirrored ? ' scale(-1 1)' : ''}`}>
                  <rect x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} className="inst-hit" />
                  <SymbolGraphic symbol={sym} />
                </g>
                <text className="inst-label" x={labelPos.x} y={labelPos.y}>
                  {label.map((l, i) => <tspan key={i} x={labelPos.x} dy={i === 0 ? 0 : 13} className={i === 0 ? 'refdes' : ''}>{l}</tspan>)}
                </text>
              </g>
            );
          })}
          {doc.schematic.instances.flatMap((inst) => (symbolOf(doc, inst)?.pins ?? []).map((pin) => {
            const pos = pinPosition(doc, { instanceId: inst.id, pin: pin.number })!;
            const connected = doc.schematic.nets.some((n) => n.connections.some((c) => c.instanceId === inst.id && c.pin === pin.number));
            const active = wireFrom && wireFrom.instanceId === inst.id && wireFrom.pin === pin.number;
            return (
              <g key={`${inst.id}#${pin.number}`} data-pin={pin.number} data-inst={inst.id} data-pin-label={`${inst.refDes}.${pin.name}`} className={`pin ${connected ? 'connected' : ''} ${active ? 'active' : ''}`}>
                <circle cx={pos.x} cy={pos.y} r={7} className="pin-hit" />
                <circle cx={pos.x} cy={pos.y} r={connected ? 2.5 : 3} className="pin-dot" />
              </g>
            );
          }))}
          {wireStart && cursor && (
            <polyline className="wire-rubber" points={routeWire(wireStart, { x: snap(cursor.x), y: snap(cursor.y) }).map((q) => `${q.x},${q.y}`).join(' ')} />
          )}
          {p.nodeLabels && doc.schematic.nets.map((n) => {
            const label = p.nodeLabels![n.id];
            const first = n.connections[0];
            const pos = first ? pinPosition(doc, first) : null;
            if (!label || !pos) return null;
            return <text key={n.id} className="node-label" x={pos.x + 6} y={pos.y + 16} data-net-label={n.name ?? n.id}>{label}</text>;
          })}
          {(['red', 'black'] as const).map((c) => {
            const pos = probeAt(c);
            if (!pos) return null;
            return (
              <g key={c} className={`probe ${c}`} transform={`translate(${pos.x} ${pos.y})`} pointerEvents="none">
                <line x1={0} y1={0} x2={c === 'red' ? 18 : -18} y2={-28} />
                <circle cx={0} cy={0} r={5} />
              </g>
            );
          })}
          {p.mode === 'edit' && doc.schematic.annotations.map((a) => {
            const { w, h, lines } = noteSize(a.text);
            const sel = p.selection?.kind === 'note' && p.selection.id === a.id;
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
        {p.hint ?? 'Колесо — масштаб'} · {Math.round(view.scale * 100)}%
        <button className="btn small" onClick={() => setView({ x: -60, y: -60, scale: 1 })}>Сбросить вид</button>
      </div>
      {p.banner && <div className="stage-note">{p.banner}</div>}
      {wireFrom && <div className="canvas-status">Провод: щёлкните второй вывод (Esc — отмена)</div>}
    </div>
  );
}
