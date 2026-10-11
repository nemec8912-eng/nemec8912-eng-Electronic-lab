/**
 * Полотно схемы. Режим «правка»: выделение (щелчок, Shift, рамка), перемещение группой, провода с
 * изгибами и ветвлениями, метки цепей и питания, поворот, отражение, копирование, группы.
 * Режим «щупы» (вкладка «Тест»): щелчок по выводу ставит щуп, поверх — напряжения узлов.
 * Связность берётся из графа документа, а не из рисунка: пересечение проводов без точки — не соединение.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { graphOf } from '../core/connectivity';
import { newId } from '../core/ids';
import { labelPrims } from '../core/graphics';
import type { MultimeterSettings } from '../core/instruments';
import type { PinRef, Point, ProjectDoc, WireEnd } from '../core/model';
import {
  addLabel, copyItems, deleteItems, drawWire, expandGroups, groupItems, hitVertex, hitWire, instanceBox, itemsInRect,
  junctionDots, mirrorItems, moveItems, orthogonal, pasteItems, pinPosition, POWER_NAMES, rotateItems, snap, snapPt, symbolOf,
  ungroupItems, type Clipboard, type Terminal,
} from '../core/schematic';
import { contentBounds, instanceLabel, instanceLabelPos } from '../core/sheet';
import { useDialogs } from './Dialogs';
import { Prims, SymbolGraphic, symbolBounds } from './symbols';

export type Tool = 'select' | 'wire' | 'label' | 'power';

export interface Marker { key: string; at: Point; severity: 'error' | 'warning' | 'info' }

interface Props {
  doc: ProjectDoc;
  mode: 'edit' | 'probe';
  selection: string[];
  onSelect(ids: string[]): void;
  /** Правка документа (через историю Undo/Redo). */
  onEdit?(label: string, fn: (d: ProjectDoc) => ProjectDoc, coalesceKey?: string): void;
  onError?(text: string): void;
  /** Деталь из каталога, ожидающая размещения, или null. */
  placing?: string | null;
  onPlace?(partId: string, p: Point): void;
  onCancelPlace?(): void;
  onAddNote?(p: Point): void;
  onPinClick?(pin: PinRef): void;
  probes?: MultimeterSettings;
  /** id сети → подпись (рассчитанное напряжение). */
  nodeLabels?: Record<string, string>;
  /** id объектов с проблемами (подсветка). */
  flagged?: Set<string>;
  markers?: Marker[];
  /** Показать точку (центрирование вида), seq — чтобы повторять для той же точки. */
  focus?: { at: Point; seq: number } | null;
  hint?: string;
  banner?: string;
  toolbarExtra?: ReactNode;
}

export function noteSize(text: string) {
  const lines = (text || ' ').split('\n').slice(0, 40);
  const w = Math.min(480, Math.max(60, ...lines.map((l) => l.length * 7.2 + 20)));
  return { w, h: lines.length * 17 + 14, lines };
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
  | { kind: 'move'; ids: Set<string>; start: Point; applied: Point; dragId: string }
  | { kind: 'band'; start: Point; additive: boolean };

type WireDraw = { start: Terminal; startPt: Point; bends: Point[] };

/** Буфер обмена внутри программы (общий для всех открытых проектов сеанса). */
let clipboard: Clipboard | null = null;
let pasteCount = 0;

export function SchematicCanvas(p: Props) {
  const { doc } = p;
  const dialogs = useDialogs();
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -60, y: -60, scale: 1 });
  const [cursor, setCursor] = useState<Point | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [wire, setWire] = useState<WireDraw | null>(null);
  const [band, setBand] = useState<{ a: Point; b: Point } | null>(null);
  const drag = useRef<Drag | null>(null);
  const edit = p.mode === 'edit';
  const sel = useMemo(() => new Set(p.selection), [p.selection]);
  const graph = graphOf(doc);
  const docRef = useRef(doc);
  docRef.current = doc;

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: view.x + (clientX - r.left) / view.scale, y: view.y + (clientY - r.top) / view.scale };
  }, [view]);

  const fitAll = useCallback(() => {
    const b = contentBounds(docRef.current, edit);
    const r = svgRef.current?.getBoundingClientRect();
    if (!b || !r || r.width < 10) { setView({ x: -60, y: -60, scale: 1 }); return; }
    const scale = Math.min(4, Math.max(0.2, Math.min(r.width / (b.w + 80), r.height / (b.h + 80))));
    setView({ scale, x: b.x + b.w / 2 - r.width / 2 / scale, y: b.y + b.h / 2 - r.height / 2 / scale });
  }, [edit]);

  useEffect(() => {
    if (!p.focus) return;
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    setView((v) => ({ ...v, x: p.focus!.at.x - r.width / 2 / v.scale, y: p.focus!.at.y - r.height / 2 / v.scale }));
  }, [p.focus]);

  const zoom = (factor: number, cx?: number, cy?: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
    const w = toWorld(px, py);
    const scale = Math.min(8, Math.max(0.2, view.scale * factor));
    setView({ scale, x: w.x - (px - r.left) / scale, y: w.y - (py - r.top) / scale });
  };

  // ---------- Правки ----------
  const edit_ = (label: string, fn: (d: ProjectDoc) => ProjectDoc, key?: string) => p.onEdit?.(label, fn, key);
  const selected = () => expandGroups(docRef.current, p.selection);

  const finishWire = (end: Terminal) => {
    if (!wire) return;
    const r = drawWire(docRef.current, wire.start, wire.bends, end);
    setWire(null);
    if (r.error) { p.onError?.(r.error); return; }
    if (!r.wireId) return;
    const bends = wire.bends, start = wire.start;
    const id = r.wireId;
    edit_('Провод', (d) => drawWire(d, start, bends, end, id).doc);
  };

  const terminalAt = (w: Point, allowFree: boolean): Terminal | null => {
    const v = hitVertex(docRef.current, w, 7 / Math.min(1, view.scale));
    if (v) return { kind: 'end', end: v };
    const hw = hitWire(docRef.current, w, 5 / Math.min(1, view.scale));
    if (hw) return { kind: 'wire', wireId: hw.wireId, at: hw.at };
    return allowFree ? { kind: 'free', at: snapPt(w) } : null;
  };

  const placeLabel = async (kind: 'net' | 'power', w: Point) => {
    const t = terminalAt(w, true)!;
    const name = await dialogs.prompt(kind === 'power' ? 'Метка питания' : 'Метка цепи',
      kind === 'power' ? `Имя цепи питания (${POWER_NAMES.slice(0, 6).join(', ')}…). Метка напряжения не создаёт — нужен источник.` : 'Имя цепи (метки с одинаковым именем соединены)',
      kind === 'power' ? '+5V' : '', 'Поставить');
    if (!name) return;
    const r = addLabel(docRef.current, name, kind, t);
    if (r.error) { p.onError?.(r.error); return; }
    const id = r.id;
    edit_(kind === 'power' ? `Метка питания ${name}` : `Метка ${name}`, (d) => addLabel(d, name, kind, t, 0, id).doc);
    p.onSelect([id]);
    setTool('select');
  };

  const actions = {
    rotate: () => { const ids = selected(); if (ids.size) edit_('Поворот', (d) => rotateItems(d, ids)); },
    mirror: () => { const ids = selected(); if (ids.size) edit_('Отражение', (d) => mirrorItems(d, ids)); },
    remove: () => { const ids = selected(); if (!ids.size) return; edit_('Удаление', (d) => deleteItems(d, ids)); p.onSelect([]); },
    copy: () => { const c = copyItems(docRef.current, selected()); if (c) { clipboard = c; pasteCount = 0; } return !!c; },
    paste: () => {
      if (!clipboard) return;
      const clip = clipboard;
      pasteCount += 1;
      const off = { x: 40 * pasteCount, y: 40 * pasteCount };
      // UUID вставки выдаются заранее и повторяются при применении — выделение указывает на вставленное.
      const gen: string[] = [];
      const r = pasteItems(docRef.current, clip, off, () => { const id = newId(); gen.push(id); return id; });
      edit_('Вставка', (d) => { let k = 0; return pasteItems(d, clip, off, () => gen[k++] ?? newId()).doc; });
      p.onSelect(r.ids);
    },
    duplicate: () => { if (actions.copy()) actions.paste(); },
    cut: () => { if (actions.copy()) actions.remove(); },
    group: () => { const ids = selected(); if (ids.size > 1) edit_('Группа', (d) => groupItems(d, ids)); },
    ungroup: () => { const ids = selected(); if (ids.size) edit_('Разгруппировать', (d) => ungroupItems(d, ids)); },
    selectAll: () => {
      const s = docRef.current.schematic;
      p.onSelect([...s.instances, ...s.wires, ...s.junctions, ...s.labels, ...s.annotations].map((x) => x.id));
    },
  };

  // Горячие клавиши полотна (по физическим клавишам — работают в русской раскладке).
  useEffect(() => {
    if (!edit) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (typing || document.querySelector('[role=dialog]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { setWire(null); setTool('select'); p.onCancelPlace?.(); return; }
      if (mod && e.code === 'KeyC') { e.preventDefault(); actions.copy(); return; }
      if (mod && e.code === 'KeyV') { e.preventDefault(); actions.paste(); return; }
      if (mod && e.code === 'KeyX') { e.preventDefault(); actions.cut(); return; }
      if (mod && e.code === 'KeyD') { e.preventDefault(); actions.duplicate(); return; }
      if (mod && e.code === 'KeyA') { e.preventDefault(); actions.selectAll(); return; }
      if (mod && e.code === 'KeyG') { e.preventDefault(); if (e.shiftKey) actions.ungroup(); else actions.group(); return; }
      if (mod) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actions.remove(); }
      else if (e.code === 'KeyR') actions.rotate();
      else if (e.code === 'KeyX') actions.mirror();
      else if (e.code === 'KeyW') setTool('wire');
      else if (e.code === 'KeyL') setTool('label');
      else if (e.code === 'KeyP') setTool('power');
      else if (e.code === 'KeyF') fitAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- Мышь ----------
  const onWheel = (e: RWheelEvent) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);

  const pinFromTarget = (t: Element): PinRef | null => {
    const el = t.closest('[data-pin]');
    return el ? { instanceId: el.getAttribute('data-inst')!, pin: el.getAttribute('data-pin')! } : null;
  };

  const startMove = (id: string, w: Point, additive: boolean, timeStamp: number) => {
    let ids: Set<string>;
    if (additive) {
      const next = new Set(p.selection);
      const grp = expandGroups(docRef.current, [id]);
      if (next.has(id)) for (const x of grp) next.delete(x); else for (const x of grp) next.add(x);
      p.onSelect([...next]);
      return;
    }
    if (sel.has(id)) ids = selected();
    else { ids = expandGroups(docRef.current, [id]); p.onSelect([...ids]); }
    drag.current = { kind: 'move', ids, start: snapPt(w), applied: { x: 0, y: 0 }, dragId: `drag:move:${id}:${timeStamp}` };
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
    if (!edit) {
      if (pin) { p.onPinClick?.(pin); return; }
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
      return;
    }
    if (p.placing) { p.onPlace?.(p.placing, snapPt(w)); return; }
    if (tool === 'label' || tool === 'power') { void placeLabel(tool === 'power' ? 'power' : 'net', w); return; }
    if (wire) {
      const term = terminalAt(w, false);
      if (term) { finishWire(term); return; }
      setWire({ ...wire, bends: [...wire.bends, snapPt(w)] });
      return;
    }
    // Начало провода: от вывода (всегда), от узла, метки или провода (инструмент «Провод»), с пустого места («Провод»).
    if (pin || tool === 'wire') {
      const term = pin ? { kind: 'end' as const, end: { kind: 'pin' as const, ...pin } } : terminalAt(w, true)!;
      const startPt = term.kind === 'end' ? (term.end.kind === 'pin' ? pinPosition(doc, term.end)! : snapPt(w)) : snapPt(term.at);
      const sp = term.kind === 'end' && term.end.kind !== 'pin' ? (term.end.kind === 'junction' ? doc.schematic.junctions.find((j) => j.id === (term.end as { junctionId: string }).junctionId)!.position : doc.schematic.labels.find((l) => l.id === (term.end as { labelId: string }).labelId)!.position) : startPt;
      setWire({ start: term, startPt: sp, bends: [] });
      return;
    }
    const hitId = (attr: string) => t.closest(`[${attr}]`)?.getAttribute(attr) ?? null;
    const id = hitId('data-inst-id') ?? hitId('data-label-id') ?? hitId('data-junction-id') ?? hitId('data-note-id') ?? hitId('data-wire-id');
    if (id) { startMove(id, w, e.shiftKey || e.ctrlKey, e.timeStamp); return; }
    drag.current = { kind: 'band', start: w, additive: e.shiftKey || e.ctrlKey };
    setBand({ a: w, b: w });
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
    if (d.kind === 'band') { setBand({ a: d.start, b: w }); return; }
    const total = { x: snap(w.x) - d.start.x, y: snap(w.y) - d.start.y };
    const delta = { x: total.x - d.applied.x, y: total.y - d.applied.y };
    if (!delta.x && !delta.y) return;
    d.applied = total;
    const ids = d.ids;
    edit_('Перемещение', (doc2) => moveItems(doc2, ids, delta), d.dragId);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'band' && band) {
      const r = { x0: Math.min(band.a.x, band.b.x), y0: Math.min(band.a.y, band.b.y), x1: Math.max(band.a.x, band.b.x), y1: Math.max(band.a.y, band.b.y) };
      setBand(null);
      if (r.x1 - r.x0 < 3 && r.y1 - r.y0 < 3) { if (!d.additive) p.onSelect([]); return; }
      const inRect = itemsInRect(doc, r, (i) => { const s = symbolOf(doc, i); return s ? instanceBox(i, symbolBounds(s)) : { x: i.position.x, y: i.position.y, w: 0, h: 0 }; });
      const ids = expandGroups(doc, d.additive ? [...p.selection, ...inRect] : inRect);
      p.onSelect([...ids]);
    }
  };

  const onDoubleClick = (e: RMouseEvent) => {
    if (!edit || p.placing) return;
    const w = toWorld(e.clientX, e.clientY);
    if (wire) {
      // Двойной щелчок на пустом месте завершает провод свободным концом в последней точке изгиба.
      const last = wire.bends[wire.bends.length - 1];
      if (last) { setWire({ ...wire, bends: wire.bends.slice(0, -1) }); finishWireFree(last); }
      return;
    }
    if ((e.target as Element).closest('[data-note-id],[data-inst-id],[data-pin],[data-wire-id],[data-label-id],[data-junction-id]')) return;
    p.onAddNote?.(snapPt(w));
  };
  const finishWireFree = (at: Point) => {
    if (!wire) return;
    const bends = wire.bends.slice(0, -1);
    const start = wire.start;
    const end: Terminal = { kind: 'free', at };
    setWire(null);
    const r = drawWire(docRef.current, start, bends, end);
    if (r.error) { p.onError?.(r.error); return; }
    if (!r.wireId) return;
    const id = r.wireId;
    edit_('Провод', (d) => drawWire(d, start, bends, end, id).doc);
  };

  // ---------- Рисование ----------
  const gridPx = 10 * view.scale;
  const probeAt = (color: 'red' | 'black') => { const ref = p.probes?.[color]; return ref ? pinPosition(doc, ref) : null; };
  const dots = junctionDots(doc);
  const freeEnds = doc.schematic.wires.flatMap((w) => [w.a.kind === 'free' ? w.points[0]! : null, w.b.kind === 'free' ? w.points[w.points.length - 1]! : null]).filter((x): x is Point => !!x);
  const preview = wire && cursor ? orthogonal([wire.startPt, ...wire.bends, snapPt(cursor)]) : null;
  const toolHint = p.placing ? 'Щёлкните, чтобы поставить деталь (Esc — отмена)'
    : wire ? 'Провод: щелчок — изгиб, щелчок по выводу/проводу/метке — конец, двойной щелчок — свободный конец, Esc — отмена'
    : tool === 'wire' ? 'Провод: щёлкните начало (вывод, провод, узел, метка или пустое место)'
    : tool === 'label' ? 'Метка цепи: щёлкните провод, вывод или пустое место'
    : tool === 'power' ? 'Метка питания: щёлкните провод, вывод или пустое место'
    : p.hint ?? 'Колесо — масштаб';

  return (
    <div className="canvas-wrap">
      {edit && (
        <div className="canvas-toolbar" role="toolbar" aria-label="Инструменты схемы">
          {([['select', 'Выбор', 'Esc'], ['wire', 'Провод', 'W'], ['label', 'Метка', 'L'], ['power', 'Питание', 'P']] as const).map(([k, l, key]) => (
            <button key={k} className={`btn small ${tool === k && !p.placing ? 'on' : ''}`} aria-pressed={tool === k} title={key} onClick={() => { setTool(k); setWire(null); p.onCancelPlace?.(); }}>{l}</button>
          ))}
          <span className="sep" />
          <button className="btn small" disabled={!p.selection.length} onClick={actions.rotate} title="R">Повернуть</button>
          <button className="btn small" disabled={!p.selection.length} onClick={actions.mirror} title="X">Отразить</button>
          <button className="btn small" disabled={!p.selection.length} onClick={() => actions.copy()} title="Ctrl+C">Копировать</button>
          <button className="btn small" onClick={actions.paste} title="Ctrl+V">Вставить</button>
          <button className="btn small" disabled={p.selection.length < 2} onClick={actions.group} title="Ctrl+G">Группа</button>
          <button className="btn small" disabled={!p.selection.length} onClick={actions.ungroup} title="Ctrl+Shift+G">Разгруппировать</button>
          <button className="btn small danger" disabled={!p.selection.length} onClick={actions.remove} title="Delete">Удалить</button>
          <span className="sep" />
          {p.toolbarExtra}
        </div>
      )}
      <svg
        ref={svgRef}
        className={`canvas ${p.placing ? 'placing' : ''} ${!edit ? 'probe-mode' : ''} tool-${tool}`}
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
            const net = graph.netOfWire.get(w.id) ?? null;
            return (
              <g key={w.id} data-wire-id={w.id} data-net-id={net ?? ''} className={`wire ${sel.has(w.id) ? 'selected' : ''} ${(net && p.flagged?.has(net)) || p.flagged?.has(w.id) ? 'flagged' : ''}`}>
                <polyline points={pts} className="wire-hit" />
                <polyline points={pts} className="wire-line" />
              </g>
            );
          })}
          {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={3.2} className="junction-dot" />)}
          {edit && freeEnds.map((d, i) => <rect key={i} x={d.x - 3} y={d.y - 3} width={6} height={6} className="free-end" />)}
          {doc.schematic.junctions.map((j) => (
            <g key={j.id} data-junction-id={j.id} className={`junction ${sel.has(j.id) ? 'selected' : ''}`}>
              <circle cx={j.position.x} cy={j.position.y} r={6} className="junction-hit" />
            </g>
          ))}
          {doc.schematic.instances.map((inst) => {
            const sym = symbolOf(doc, inst);
            if (!sym) return null;
            const b = symbolBounds(sym);
            const label = instanceLabel(doc, inst);
            const lp = instanceLabelPos(inst, b, label.length);
            return (
              <g key={inst.id} className={`inst ${sel.has(inst.id) ? 'selected' : ''} ${p.flagged?.has(inst.id) ? 'flagged' : ''}`} data-inst-id={inst.id} data-refdes={inst.refDes}
                transform={`translate(${inst.position.x} ${inst.position.y})`} data-rot={inst.rotation} data-mirrored={inst.mirrored ? '1' : '0'}>
                <g transform={`rotate(${inst.rotation})${inst.mirrored ? ' scale(-1 1)' : ''}`}>
                  <rect x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} className="inst-hit" />
                  <SymbolGraphic symbol={sym} rotation={inst.rotation} mirrored={inst.mirrored} />
                </g>
                <text className="inst-label" x={lp.x} y={lp.y}>
                  {label.map((l, i) => <tspan key={i} x={lp.x} dy={i === 0 ? 0 : 13} className={i === 0 ? 'refdes' : ''}>{l}</tspan>)}
                </text>
              </g>
            );
          })}
          {doc.schematic.labels.map((l) => (
            <g key={l.id} data-label-id={l.id} data-label-name={l.name} className={`lbl ${l.kind} ${sel.has(l.id) ? 'selected' : ''} ${p.flagged?.has(l.id) ? 'flagged' : ''}`}
              transform={`translate(${l.position.x} ${l.position.y}) rotate(${l.rotation})`}>
              <rect x={-8} y={-22} width={Math.max(30, l.name.length * 7 + 22)} height={30} className="label-hit" />
              <Prims prims={labelPrims(l.name, l.kind)} rotation={l.rotation} />
            </g>
          ))}
          {doc.schematic.instances.flatMap((inst) => (symbolOf(doc, inst)?.pins ?? []).map((pin) => {
            const pos = pinPosition(doc, { instanceId: inst.id, pin: pin.number })!;
            const connected = graph.netOfVertex.get(`p:${inst.id}#${pin.number}`) != null;
            const active = wire?.start.kind === 'end' && wire.start.end.kind === 'pin' && wire.start.end.instanceId === inst.id && wire.start.end.pin === pin.number;
            return (
              <g key={`${inst.id}#${pin.number}`} data-pin={pin.number} data-inst={inst.id} data-pin-label={`${inst.refDes}.${pin.name}`} className={`pin ${connected ? 'connected' : ''} ${active ? 'active' : ''}`}>
                <circle cx={pos.x} cy={pos.y} r={7} className="pin-hit" />
                <circle cx={pos.x} cy={pos.y} r={connected ? 2.5 : 3} className="pin-dot" />
              </g>
            );
          }))}
          {preview && <polyline className="wire-rubber" points={preview.map((q) => `${q.x},${q.y}`).join(' ')} />}
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
          {edit && doc.schematic.annotations.map((a) => {
            const { w, h, lines } = noteSize(a.text);
            return (
              <g key={a.id} data-note-id={a.id} className={`note ${sel.has(a.id) ? 'selected' : ''}`} transform={`translate(${a.position.x} ${a.position.y})`}>
                <rect width={w} height={h} rx={3} />
                <text x={10} y={20}>{lines.map((l, i) => <tspan key={i} x={10} dy={i === 0 ? 0 : 17}>{l || ' '}</tspan>)}</text>
              </g>
            );
          })}
          {p.markers?.map((m) => (
            <g key={m.key} className={`erc-marker ${m.severity}`} transform={`translate(${m.at.x} ${m.at.y})`} pointerEvents="none">
              <circle r={9} />
            </g>
          ))}
          {band && <rect className="band" x={Math.min(band.a.x, band.b.x)} y={Math.min(band.a.y, band.b.y)} width={Math.abs(band.b.x - band.a.x)} height={Math.abs(band.b.y - band.a.y)} />}
        </g>
      </svg>
      <div className="canvas-hint">
        <span className="hint-text">{toolHint}</span> · {Math.round(view.scale * 100)}%
        <button className="btn small" onClick={() => zoom(1.25)} aria-label="Крупнее">+</button>
        <button className="btn small" onClick={() => zoom(0.8)} aria-label="Мельче">−</button>
        <button className="btn small" onClick={fitAll} title="F">Показать всё</button>
      </div>
      {p.banner && <div className="stage-note">{p.banner}</div>}
      {wire && <div className="canvas-status">Провод: щёлкните точку изгиба или конец (Esc — отмена)</div>}
    </div>
  );
}

export type { WireEnd };
