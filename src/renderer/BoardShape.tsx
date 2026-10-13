/**
 * Форма и размеры платы (создание новой платы и правка существующей) и медная заливка.
 * Размеры — любые от 1 до 2000 мм, в мм или дюймах; форма — прямоугольник, скруглённые углы, круг,
 * многоугольник по точкам.
 */
import { useEffect, useState } from 'react';
import { netDisplayName } from '../core/connectivity';
import type { Board, BoardOutline, ProjectDoc } from '../core/model';
import { OUTLINE_KINDS, parsePoints } from '../core/outline';
import { copperLayers, fmtLen, parseLen, rulesOf, setBoard, setOutline, type Layer } from '../core/pcb';
import { addPour, DEFAULT_POUR_CLEARANCE, deletePour, pourResults } from '../core/pour';

type Edit = (label: string, fn: (d: ProjectDoc) => ProjectDoc) => void;

const fmtPts = (pts: Array<{ x: number; y: number }>, units: 'mm' | 'inch') =>
  pts.map((p) => `${fmtLen(p.x, units, 3).replace(/ мм|″/, '')}; ${fmtLen(p.y, units, 3).replace(/ мм|″/, '')}`).join('\n');

/** Создание новой платы — форма, размеры, слои, единицы. */
export function NewBoard({ doc, onEdit }: { doc: ProjectDoc; onEdit: Edit }) {
  const [units, setUnits] = useState<'mm' | 'inch'>('mm');
  const [layers, setLayers] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Новая плата">
      <h3>Новая плата</h3>
      <div className="seg" role="radiogroup" aria-label="Единицы новой платы">
        {(['mm', 'inch'] as const).map((u) => <button key={u} role="radio" aria-checked={units === u} className={`btn small ${units === u ? 'on' : ''}`} onClick={() => setUnits(u)}>{u === 'mm' ? 'мм' : 'дюймы'}</button>)}
      </div>
      <div className="seg" role="radiogroup" aria-label="Слои новой платы">
        {([1, 2] as const).map((n) => <button key={n} role="radio" aria-checked={layers === n} className={`btn small ${layers === n ? 'on' : ''}`} onClick={() => setLayers(n)}>{n === 1 ? 'Односторонняя' : 'Двухсторонняя'}</button>)}
      </div>
      <ShapeEditor units={units} initial={{ widthMm: 60, heightMm: 40, outline: { kind: 'rect' } }} submitLabel="Создать плату"
        onSubmit={(outline, w, h) => {
          const make = (d: ProjectDoc) => {
            const b = setBoard(d, { widthMm: Math.max(w, 1), heightMm: Math.max(h, 1), layers, units });
            return b.error ? b : setOutline(b.doc, outline, { widthMm: w, heightMm: h });
          };
          const r = make(doc);
          if (r.error) { setError(r.error); return; }
          setError(null);
          onEdit('Новая плата', (d) => make(d).doc);
        }} />
      {error && <p className="error-text small" role="alert">{error}</p>}
      <p className="muted small">Или сразу «Синхронизировать со схемой» — будет создана плата 60 × 40 мм, форму и размеры можно поменять потом.</p>
    </section>
  );
}

/** Форма и размеры: поля зависят от формы. onSubmit получает контур и габарит в мм. */
export function ShapeEditor({ units, initial, submitLabel, onSubmit }: {
  units: 'mm' | 'inch'; initial: Pick<Board, 'widthMm' | 'heightMm' | 'outline'>; submitLabel: string;
  onSubmit(outline: BoardOutline, widthMm: number, heightMm: number): void;
}) {
  const [kind, setKind] = useState<BoardOutline['kind']>(initial.outline.kind);
  const [w, setW] = useState(fmtLen(initial.widthMm, units, 3));
  const [h, setH] = useState(fmtLen(initial.heightMm, units, 3));
  const [r, setR] = useState(fmtLen(initial.outline.kind === 'rounded' ? initial.outline.radiusMm : 3, units, 3));
  const [pts, setPts] = useState(initial.outline.kind === 'polygon' ? fmtPts(initial.outline.points, units)
    : fmtPts([{ x: 0, y: 0 }, { x: initial.widthMm, y: 0 }, { x: initial.widthMm, y: initial.heightMm * 0.6 }, { x: initial.widthMm * 0.6, y: initial.heightMm }, { x: 0, y: initial.heightMm }], units));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setKind(initial.outline.kind); setW(fmtLen(initial.widthMm, units, 3)); setH(fmtLen(initial.heightMm, units, 3));
    if (initial.outline.kind === 'rounded') setR(fmtLen(initial.outline.radiusMm, units, 3));
    if (initial.outline.kind === 'polygon') setPts(fmtPts(initial.outline.points, units));
  }, [initial.widthMm, initial.heightMm, initial.outline, units]);

  const submit = () => {
    const W = parseLen(w, units), H = parseLen(h, units);
    if (kind === 'polygon') {
      const p = parsePoints(pts, (v) => parseLen(v, units));
      if ('error' in p) { setError(p.error); return; }
      setError(null);
      onSubmit({ kind: 'polygon', points: p.points }, 0, 0);
      return;
    }
    if (W === null || !(W > 0) || (kind !== 'circle' && (H === null || !(H > 0)))) { setError('Размер: число больше нуля, например «75», «2,5″», «100 мм»'); return; }
    if (kind === 'rounded') {
      const R = parseLen(r, units);
      if (R === null || !(R > 0)) { setError('Радиус скругления: число больше нуля'); return; }
      setError(null);
      onSubmit({ kind: 'rounded', radiusMm: R }, W, H!);
      return;
    }
    setError(null);
    onSubmit(kind === 'circle' ? { kind: 'circle' } : { kind: 'rect' }, W, kind === 'circle' ? W : H!);
  };
  const u = units === 'mm' ? 'мм' : 'дюймы';
  return (
    <div className="shape-editor">
      <div className="seg" role="radiogroup" aria-label="Форма платы">
        {OUTLINE_KINDS.map(([k, l]) => <button key={k} role="radio" aria-checked={kind === k} className={`btn small ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      {kind !== 'polygon' && (
        <div className="row">
          <label className="field inline"><span>{kind === 'circle' ? `Диаметр, ${u}` : `Ширина, ${u}`}</span>
            <input aria-label={kind === 'circle' ? 'Диаметр платы' : 'Ширина платы'} value={w} onChange={(e) => setW(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </label>
          {kind !== 'circle' && (
            <label className="field inline"><span>Высота, {u}</span>
              <input aria-label="Высота платы" value={h} onChange={(e) => setH(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
            </label>
          )}
        </div>
      )}
      {kind === 'rounded' && (
        <label className="field inline"><span>Радиус углов, {u}</span>
          <input aria-label="Радиус углов" value={r} onChange={(e) => setR(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </label>
      )}
      {kind === 'polygon' && (
        <label className="field"><span>Точки контура «x; y» по строкам, {u} (обход по краю платы)</span>
          <textarea aria-label="Точки контура" rows={6} value={pts} onChange={(e) => setPts(e.target.value)} />
        </label>
      )}
      <button className="btn primary small" onClick={submit}>{submitLabel}</button>
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}

/** Медная заливка: цепь, слой, зазор; список заливок с островами. */
export function PourPanel({ doc, onEdit }: { doc: ProjectDoc; onEdit: Edit }) {
  const layers = copperLayers(doc);
  const nets = doc.schematic.nets.filter((n) => n.connections.length > 1);
  const gnd = nets.find((n) => /^(GND|земля|0)$/i.test(n.name ?? '') || netDisplayName(doc, n).toUpperCase().includes('GND'));
  const [netId, setNetId] = useState(gnd?.id ?? nets[0]?.id ?? '');
  const [layer, setLayer] = useState<Layer>('bottom');
  const units = doc.pcb.board?.units ?? 'mm';
  const minC = rulesOf(doc).clearanceMm;
  const [clr, setClr] = useState(fmtLen(Math.max(DEFAULT_POUR_CLEARANCE, minC), units));
  const [error, setError] = useState<string | null>(null);
  const results = pourResults(doc);
  useEffect(() => { if (!nets.some((n) => n.id === netId)) setNetId(gnd?.id ?? nets[0]?.id ?? ''); }, [nets, netId, gnd]);
  const add = () => {
    const c = parseLen(clr, units);
    if (c === null) { setError('Зазор: число'); return; }
    const r = addPour(doc, { netId, layer: layers.includes(layer) ? layer : 'bottom', clearanceMm: c });
    if (r.error) { setError(r.error); return; }
    setError(null);
    onEdit('Медная заливка', (d) => addPour(d, { netId, layer: layers.includes(layer) ? layer : 'bottom', clearanceMm: c }).doc);
  };
  return (
    <section aria-label="Медная заливка">
      <h3>Медная заливка</h3>
      {doc.pcb.pours.length === 0 && <p className="muted small">Нет. Заливка цепи (обычно земли) уменьшает травление и соединяет площадки цепи без дорожек.</p>}
      <ul className="pours" data-testid="pours">
        {doc.pcb.pours.map((p) => {
          const res = results.find((r) => r.pour.id === p.id);
          const islands = res ? res.components.filter((c) => c.keys.size === 0).length : 0;
          const n = doc.schematic.nets.find((x) => x.id === p.netId);
          return (
            <li key={p.id}>
              <span>{n ? netDisplayName(doc, n) : 'цепь удалена'} · {p.layer === 'top' ? 'верх' : 'низ'} · зазор {fmtLen(p.clearanceMm, units)}{islands ? ` · островов удалено: ${islands}` : ''}</span>
              <button className="btn small" aria-label="Удалить заливку" onClick={() => onEdit('Удаление заливки', (d) => deletePour(d, p.id))}>×</button>
            </li>
          );
        })}
      </ul>
      <div className="row wrap">
        <select aria-label="Цепь заливки" value={netId} onChange={(e) => setNetId(e.target.value)}>
          {nets.map((n) => <option key={n.id} value={n.id}>{netDisplayName(doc, n)}</option>)}
        </select>
        {layers.length === 2 && (
          <select aria-label="Слой заливки" value={layer} onChange={(e) => setLayer(e.target.value as Layer)}>
            <option value="bottom">низ</option><option value="top">верх</option>
          </select>
        )}
        <label className="field inline compact"><span>Зазор</span><input aria-label="Зазор заливки" value={clr} onChange={(e) => setClr(e.target.value)} /></label>
        <button className="btn" disabled={!netId} onClick={add}>Залить</button>
      </div>
      {error && <p className="error-text small" role="alert">{error}</p>}
      <p className="muted small">Площадки цепи соединяются с заливкой сплошь, без термобарьеров — при пайке паяльником их нужно прогревать дольше. Острова (участки без своей цепи) показывает DRC.</p>
    </section>
  );
}
