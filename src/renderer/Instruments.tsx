/**
 * Виртуальные приборы вкладки «Тест» (этап 5): мультиметр, осциллограф, ESR-метр, лабораторный блок
 * питания. Все показания V/A, осциллограммы и состояние БП берутся из одного результата расчёта для
 * текущей схемы; Ω, прозвонка, диод и ESR — отдельное измерение прибором с отключённым питанием схемы.
 * Если результат не относится к текущей схеме, показания не выводятся.
 */
import { Fragment, useMemo, useState, type MouseEvent } from 'react';
import {
  esrMeter, METER_MODES, multimeter, scope, setEsr, setMeterMode, setScope, type MeterMode, type ProbeTarget, type ScopeSettings,
} from '../core/instruments';
import { formatQuantity, parseQuantity } from '../core/library';
import type { PinRef, ProjectDoc } from '../core/model';
import { setValue, symbolOf } from '../core/schematic';
import type { SimResult } from '../shared/api';
import type { MeasureKind, MeasureResult } from '../sim/meters';
import { meterReading, psuStates, scopeView, waveStats, type WaveStats } from '../sim/readings';
import { api, errorText, unwrap } from './api';

export type InstrumentTab = 'mm' | 'scope' | 'esr' | 'psu';
type Edit = (label: string, fn: (d: ProjectDoc) => ProjectDoc) => void;

export const pinLabel = (doc: ProjectDoc, ref: PinRef | null) => {
  if (!ref) return 'не подключён';
  const inst = doc.schematic.instances.find((i) => i.id === ref.instanceId);
  const pin = inst ? symbolOf(doc, inst)?.pins.find((p) => p.number === ref.pin) : undefined;
  return inst ? `${inst.refDes}, вывод ${pin?.name || ref.pin}` : 'вывод удалён';
};

export function QField({ label, value, unit, positive, onCommit, digits = 4 }: { label: string; value: number; unit: string; positive?: boolean; digits?: number; onCommit(v: number): void }) {
  return (
    <label className="field inline">
      <span>{label}</span>
      <input
        key={value}
        aria-label={label}
        defaultValue={formatQuantity(value, unit, digits)}
        onBlur={(e) => {
          const v = parseQuantity(e.target.value, unit);
          if (v !== null && (!positive || v > 0)) onCommit(v); else e.target.value = formatQuantity(value, unit, digits);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}

/** Метки щупов на схеме для открытого прибора. */
export function probeMarks(doc: ProjectDoc, tab: InstrumentTab): Array<{ pin: PinRef; cls: string; label: string }> {
  const out: Array<{ pin: PinRef; cls: string; label: string }> = [];
  if (tab === 'mm') {
    const m = multimeter(doc);
    if (m.red) out.push({ pin: m.red, cls: 'red', label: m.mode === 'dca' || m.mode === 'aca' ? 'A' : '+' });
    if (m.black && m.mode !== 'dca' && m.mode !== 'aca') out.push({ pin: m.black, cls: 'black', label: 'COM' });
  } else if (tab === 'scope') {
    const s = scope(doc);
    if (s.ch1.pin) out.push({ pin: s.ch1.pin, cls: 'ch1', label: 'CH1' });
    if (s.ch2.pin) out.push({ pin: s.ch2.pin, cls: 'ch2', label: 'CH2' });
  } else if (tab === 'esr') {
    const e = esrMeter(doc);
    if (e.red) out.push({ pin: e.red, cls: 'red', label: '+' });
    if (e.black) out.push({ pin: e.black, cls: 'black', label: '−' });
  }
  return out;
}

function TargetButtons({ items, target, onTarget }: { items: Array<[ProbeTarget, string, string]>; target: ProbeTarget; onTarget(t: ProbeTarget): void }) {
  return (
    <div className="probe-select" role="radiogroup" aria-label="Щуп">
      {items.map(([t, cls, label]) => (
        <button key={t} role="radio" aria-checked={target === t} className={`btn small probe-btn ${cls} ${target === t ? 'on' : ''}`} onClick={() => onTarget(t)}>{label}</button>
      ))}
    </div>
  );
}

// ---------- Измерения прибором (Ω, прозвонка, диод, ESR) ----------

interface Measured { key: string; res: MeasureResult }

function useMeasure(doc: ProjectDoc, docKey: string) {
  const [state, setState] = useState<Measured | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: MeasureKind, red: PinRef | null, black: PinRef | null, freqHz?: number) => {
    const key = `${docKey}|${kind}|${JSON.stringify([red, black, freqHz ?? null])}`;
    setBusy(true); setError(null);
    try {
      setState({ key, res: await unwrap(api().sim.measure(doc, { kind, red, black, freqHz })) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const current = (kind: MeasureKind, red: PinRef | null, black: PinRef | null, freqHz?: number) =>
    state && state.key === `${docKey}|${kind}|${JSON.stringify([red, black, freqHz ?? null])}` ? state.res : null;
  return { run, current, busy, error, stale: state !== null };
}

// ---------- Мультиметр ----------

export function MultimeterPanel({ doc, docKey, result, usable, target, onTarget, onEdit, ngspice }: {
  doc: ProjectDoc; docKey: string; result: SimResult | null; usable: boolean; target: ProbeTarget; onTarget(t: ProbeTarget): void; onEdit: Edit; ngspice: string | null;
}) {
  const m = multimeter(doc);
  const ammeter = m.mode === 'dca' || m.mode === 'aca';
  const active = m.mode === 'ohm' || m.mode === 'cont' || m.mode === 'diode';
  const meas = useMeasure(doc, docKey);
  const kind = m.mode as MeasureKind;
  const measured = active ? meas.current(kind, m.red, m.black) : null;
  const reading = !active ? meterReading(doc, usable ? result : null, m.mode, m.red, m.black) : null;
  const display = active
    ? measured ? measured.status === 'ok' ? measured.display : '—' : meas.busy ? 'измерение…' : '—'
    : reading!.display;
  const setMode = (mode: MeterMode) => {
    onEdit('Режим мультиметра', (d) => setMeterMode(d, mode));
    if ((mode === 'dca' || mode === 'aca') && target === 'mm.black') onTarget('mm.red');
  };
  return (
    <section aria-label="Мультиметр">
      <div className="seg meter-modes" role="radiogroup" aria-label="Режим мультиметра">
        {METER_MODES.map(([k, l]) => (
          <button key={k} role="radio" aria-checked={m.mode === k} className={`btn small ${m.mode === k ? 'on' : ''}`} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>
      <TargetButtons target={target} onTarget={onTarget}
        items={ammeter ? [['mm.red', 'red', 'Красный (A)']] : [['mm.red', 'red', 'Красный (+)'], ['mm.black', 'black', 'Чёрный (COM)']]} />
      <dl className="meta">
        <dt>Красный</dt><dd data-testid="probe-red">{pinLabel(doc, m.red)}</dd>
        {!ammeter && <><dt>Чёрный</dt><dd data-testid="probe-black">{pinLabel(doc, m.black)}</dd></>}
      </dl>
      <div className={`mm-display ${measured?.beep ? 'beep' : ''}`} data-testid="mm-reading" aria-live="polite">
        {display}
        {m.mode === 'cont' && measured?.status === 'ok' && <span className="beep-tag">{measured.beep ? ' · звуковой сигнал' : ' · без сигнала'}</span>}
      </div>
      {active && (
        <button className="btn primary small" disabled={meas.busy || !ngspice} onClick={() => void meas.run(kind, m.red, m.black)}>{meas.busy ? 'Измерение…' : 'Измерить'}</button>
      )}
      {active && !measured && meas.stale && !meas.busy && <p className="muted small">Схема или щупы изменились — нажмите «Измерить» снова.</p>}
      {measured?.message && <p className="error-text small">{measured.message}</p>}
      {meas.error && <p className="error-text small">{meas.error}</p>}
      <p className="muted small" data-testid="mm-method">
        {active ? measured?.method || 'Схема обесточивается (источники отключаются), прибор подаёт свой тестовый ток: красный щуп — «+».' : reading!.method}
      </p>
      {reading?.warnings.map((w, i) => <p key={i} className="warning-text small">{w}</p>)}
      {ammeter && <p className="muted small">Амперметр включается последовательно: вывод под красным щупом отсоединяется от своей цепи и подключается к ней через прибор. Показание — ток, втекающий в этот вывод. Выбор режима A меняет схему расчёта — запустите тест.</p>}
      {measured && measured.status === 'ok' && measured.netlist && (
        <details><summary>Схема измерения (netlist)</summary><pre className="netlist">{measured.netlist}</pre></details>
      )}
    </section>
  );
}

// ---------- ESR-метр ----------

const ESR_FREQS = [100, 1000, 10_000, 100_000];

export function EsrPanel({ doc, docKey, target, onTarget, onEdit, ngspice }: { doc: ProjectDoc; docKey: string; target: ProbeTarget; onTarget(t: ProbeTarget): void; onEdit: Edit; ngspice: string | null }) {
  const e = esrMeter(doc);
  const meas = useMeasure(doc, docKey);
  const res = meas.current('esr', e.red, e.black, e.freqHz);
  return (
    <section aria-label="ESR-метр">
      <TargetButtons target={target} onTarget={onTarget} items={[['esr.red', 'red', 'Щуп «+»'], ['esr.black', 'black', 'Щуп «−»']]} />
      <dl className="meta">
        <dt>«+»</dt><dd data-testid="esr-red">{pinLabel(doc, e.red)}</dd>
        <dt>«−»</dt><dd data-testid="esr-black">{pinLabel(doc, e.black)}</dd>
      </dl>
      <div className="seg" role="radiogroup" aria-label="Частота ESR-метра">
        {ESR_FREQS.map((f) => (
          <button key={f} role="radio" aria-checked={e.freqHz === f} className={`btn small ${e.freqHz === f ? 'on' : ''}`} onClick={() => onEdit('Частота ESR-метра', (d) => setEsr(d, { freqHz: f }))}>{formatQuantity(f, 'Гц')}</button>
        ))}
      </div>
      <div className="mm-display" data-testid="esr-reading" aria-live="polite">{res ? (res.status === 'ok' ? `ESR ${res.display}` : '—') : meas.busy ? 'измерение…' : '—'}</div>
      <button className="btn primary small" disabled={meas.busy || !ngspice} onClick={() => void meas.run('esr', e.red, e.black, e.freqHz)}>{meas.busy ? 'Измерение…' : 'Измерить'}</button>
      {res?.esr && (
        <dl className="meta">
          <dt>|Z|</dt><dd>{formatQuantity(res.esr.mag, 'Ом', 4)}</dd>
          <dt>X</dt><dd>{formatQuantity(res.esr.im, 'Ом', 4)}</dd>
          <dt>C (по X)</dt><dd>{res.esr.capacitance !== null ? formatQuantity(res.esr.capacitance, 'Ф', 3) : 'не ёмкостный характер'}</dd>
        </dl>
      )}
      {res?.message && <p className="error-text small">{res.message}</p>}
      {meas.error && <p className="error-text small">{meas.error}</p>}
      <p className="muted small">{res?.method || 'ESR — эквивалентное последовательное сопротивление конденсатора. Прибор подаёт малый переменный ток выбранной частоты при отключённом питании схемы. Показание берётся из модели конденсатора: у идеального конденсатора ESR = 0; электролит из каталога имеет параметр «ESR».'}</p>
    </section>
  );
}

// ---------- Лабораторный блок питания ----------

export function PsuPanel({ doc, result, usable, onEdit }: { doc: ProjectDoc; result: SimResult | null; usable: boolean; onEdit: Edit }) {
  const list = psuStates(doc, usable ? result : null);
  if (list.length === 0) {
    return <section aria-label="Блок питания"><p className="muted small">В схеме нет лабораторного блока питания. Добавьте его из каталога: «Источники» → «Лабораторный блок питания».</p></section>;
  }
  return (
    <section aria-label="Блок питания">
      {list.map((s) => (
        <div key={s.instanceId} className="psu" data-testid={`psu-${s.refDes}`}>
          <div className="psu-head">
            <strong>{s.refDes}</strong>
            <span className={`psu-mode ${s.mode ?? 'none'}`} data-testid="psu-mode">{s.mode ?? '—'}</span>
            <button className={`btn small ${s.enabled ? 'on' : ''}`} aria-pressed={s.enabled}
              onClick={() => onEdit(s.enabled ? 'Выключить выход БП' : 'Включить выход БП', (d) => setValue(d, s.instanceId, 'enabled', { value: s.enabled ? 0 : 1, unit: '' }))}>
              {s.enabled ? 'Выход: ВКЛ' : 'Выход: ВЫКЛ'}
            </button>
          </div>
          <QField label="Напряжение" value={s.vset} unit="В" positive onCommit={(v) => onEdit('Напряжение БП', (d) => setValue(d, s.instanceId, 'voltage', { value: v, unit: 'V' }))} />
          <QField label="Ограничение тока" value={s.ilim} unit="А" positive onCommit={(v) => onEdit('Ограничение тока БП', (d) => setValue(d, s.instanceId, 'currentLimit', { value: v, unit: 'A' }))} />
          <div className="psu-readout" aria-live="polite">
            <span data-testid="psu-vout">{s.vout !== null ? formatQuantity(s.vout, 'В', 4) : '— В'}</span>
            <span data-testid="psu-iout">{s.iout !== null ? formatQuantity(Math.abs(s.iout) < 1e-9 ? 0 : s.iout, 'А', 4) : '— А'}</span>
          </div>
          {s.mode === null && <p className="muted small">{usable ? 'Нет данных рабочей точки.' : 'Изменения вступают в силу после запуска теста.'}</p>}
          {s.mode === 'CC' && <p className="warning-text small">Ограничение тока: нагрузка потребляет больше уставки, напряжение на выходе снижено.</p>}
        </div>
      ))}
      <p className="muted small">CV — стабилизация напряжения, CC — стабилизация (ограничение) тока. Показания — рабочая точка расчёта. Модель идеализированная: выходное сопротивление 1 мОм, ток внутрь блок не принимает, переходные процессы самого блока не моделируются.</p>
    </section>
  );
}

// ---------- Осциллограф ----------

const series125 = (from: number, to: number) => {
  const out: number[] = [];
  for (let e = from; e <= to; e++) for (const m of [1, 2, 5]) out.push(Number((m * 10 ** e).toPrecision(3)));
  return out;
};
export const VDIVS = series125(-3, 1);
export const TDIVS = series125(-7, 0);

export function ScopeControls({ doc, target, onTarget, onEdit }: { doc: ProjectDoc; target: ProbeTarget; onTarget(t: ProbeTarget): void; onEdit: Edit }) {
  const s = scope(doc);
  const set = (label: string, patch: Partial<ScopeSettings>) => onEdit(label, (d) => setScope(d, patch));
  const chRow = (key: 'ch1' | 'ch2') => {
    const ch = s[key];
    return (
      <fieldset className={`scope-ch ${key}`} key={key}>
        <legend>{key.toUpperCase()}</legend>
        <label className="check"><input type="checkbox" checked={ch.on} onChange={(e) => set('Канал осциллографа', { [key]: { ...ch, on: e.target.checked } })} /> включён</label>
        <span className="small pin-of" data-testid={`scope-${key}-pin`}>{pinLabel(doc, ch.pin)}</span>
        <label className="field inline"><span>В/дел</span>
          <select aria-label={`${key.toUpperCase()} В/дел`} value={ch.vdiv} onChange={(e) => set('Чувствительность', { [key]: { ...ch, vdiv: Number(e.target.value) } })}>
            {VDIVS.map((v) => <option key={v} value={v}>{formatQuantity(v, 'В')}</option>)}
          </select>
        </label>
        <QField label={`${key.toUpperCase()} смещение`} value={ch.offset} unit="В" onCommit={(v) => set('Смещение канала', { [key]: { ...ch, offset: v } })} digits={3} />
      </fieldset>
    );
  };
  return (
    <section aria-label="Осциллограф">
      <TargetButtons target={target} onTarget={onTarget} items={[['scope.ch1', 'ch1', 'Щуп CH1'], ['scope.ch2', 'ch2', 'Щуп CH2']]} />
      <p className="muted small">Щуп осциллографа меряет напряжение вывода относительно земли схемы.</p>
      {chRow('ch1')}
      {chRow('ch2')}
      <label className="field inline"><span>Развёртка</span>
        <select aria-label="Время на деление" value={s.timeDiv} onChange={(e) => set('Развёртка', { timeDiv: Number(e.target.value) })}>
          {TDIVS.map((v) => <option key={v} value={v}>{formatQuantity(v, 'с')}/дел</option>)}
        </select>
      </label>
      <fieldset className="scope-trig">
        <legend>Синхронизация</legend>
        <div className="seg" role="radiogroup" aria-label="Источник синхронизации">
          {(['ch1', 'ch2'] as const).map((k) => <button key={k} role="radio" aria-checked={s.trigger.source === k} className={`btn small ${s.trigger.source === k ? 'on' : ''}`} onClick={() => set('Синхронизация', { trigger: { ...s.trigger, source: k } })}>{k.toUpperCase()}</button>)}
          {(['rise', 'fall'] as const).map((k) => <button key={k} role="radio" aria-checked={s.trigger.edge === k} className={`btn small ${s.trigger.edge === k ? 'on' : ''}`} onClick={() => set('Синхронизация', { trigger: { ...s.trigger, edge: k } })}>{k === 'rise' ? 'Фронт' : 'Спад'}</button>)}
          {(['auto', 'normal'] as const).map((k) => <button key={k} role="radio" aria-checked={s.trigger.mode === k} className={`btn small ${s.trigger.mode === k ? 'on' : ''}`} onClick={() => set('Синхронизация', { trigger: { ...s.trigger, mode: k } })}>{k === 'auto' ? 'Авто' : 'Ждущий'}</button>)}
        </div>
        <QField label="Уровень" value={s.trigger.level} unit="В" digits={3} onCommit={(v) => set('Уровень синхронизации', { trigger: { ...s.trigger, level: v } })} />
      </fieldset>
      <label className="check"><input type="checkbox" checked={s.cursors !== null} onChange={(e) => set('Курсоры', { cursors: e.target.checked ? [2, 6] : null })} /> Курсоры времени (щелчок по экрану — курсор 1, Shift+щелчок — курсор 2)</label>
    </section>
  );
}

const W = 500, H = 400, DX = W / 10, DY = H / 8;

/** Не более ~2 точек на пиксель: минимум и максимум в каждом столбце. */
function decimate(t: number[], v: number[], t0: number, span: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const cols = new Map<number, { min: number; max: number; first: number; last: number }>();
  let i = 0;
  while (i < t.length && t[i]! < t0) i++;
  const from = Math.max(0, i - 1);
  for (let k = from; k < t.length; k++) {
    const x = ((t[k]! - t0) / span) * W;
    if (x > W + DX) { pts.push([x, v[k]!]); break; }
    const c = Math.round(x);
    const e = cols.get(c);
    if (!e) cols.set(c, { min: v[k]!, max: v[k]!, first: v[k]!, last: v[k]! });
    else { e.min = Math.min(e.min, v[k]!); e.max = Math.max(e.max, v[k]!); e.last = v[k]!; }
  }
  const sorted = [...cols.entries()].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [c, e] of sorted) {
    out.push([c, e.first]);
    if (e.min !== e.first && e.min !== e.last) out.push([c, e.min]);
    if (e.max !== e.first && e.max !== e.last) out.push([c, e.max]);
    if (e.last !== e.first) out.push([c, e.last]);
  }
  return [...out, ...pts];
}

function windowStats(t: number[], v: number[], t0: number, t1: number): WaveStats | null {
  let a = 0;
  while (a < t.length && t[a]! < t0) a++;
  let b = a;
  while (b < t.length && t[b]! <= t1) b++;
  if (b - a < 2) return null;
  return waveStats(t.slice(a, b), v.slice(a, b), t[a]);
}

const valueAt = (t: number[], v: number[], x: number): number | null => {
  if (!t.length || x < t[0]! || x > t[t.length - 1]!) return null;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid]! <= x) lo = mid; else hi = mid; }
  const k = t[hi]! === t[lo]! ? 0 : (x - t[lo]!) / (t[hi]! - t[lo]!);
  return v[lo]! + k * (v[hi]! - v[lo]!);
};

export function ScopeScreen({ doc, result, onEdit }: { doc: ProjectDoc; result: SimResult; onEdit: Edit }) {
  const s = scope(doc);
  const view = useMemo(() => scopeView(doc, result, s), [doc, result, s]);
  const span = 10 * s.timeDiv;
  const traces = useMemo(() => {
    if (!view) return [];
    return view.channels.map((c, idx) => {
      if (!c) return null;
      const ch = idx === 0 ? s.ch1 : s.ch2;
      const pts = decimate(c.t, c.v, view.t0, span).map(([x, v]) => [x, H / 2 - ((v + ch.offset) / ch.vdiv) * DY] as const);
      const stats = windowStats(c.t, c.v, view.t0, view.t0 + span);
      return { key: c.key, d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${Math.max(-50, Math.min(H + 50, y)).toFixed(1)}`).join(''), stats, ch, c };
    });
  }, [view, s.ch1, s.ch2, span]);
  if (!view) return null;
  const tEnd = result.tran!.time[result.tran!.time.length - 1]!;
  const short = view.t0 + span > tEnd + span * 1e-6;
  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!s.cursors) return;
    const r = e.currentTarget.getBoundingClientRect();
    const div = Math.max(0, Math.min(10, ((e.clientX - r.left) / r.width) * 10));
    const c: [number, number] = e.shiftKey ? [s.cursors[0], div] : [div, s.cursors[1]];
    onEdit('Курсор осциллографа', (d) => setScope(d, { cursors: [Number(c[0].toFixed(2)), Number(c[1].toFixed(2))] }));
  };
  const trigCh = s.trigger.source === 'ch1' ? s.ch1 : s.ch2;
  const trigY = H / 2 - ((s.trigger.level + trigCh.offset) / trigCh.vdiv) * DY;
  const curT = s.cursors ? s.cursors.map((d) => view.t0 + d * s.timeDiv) as [number, number] : null;
  const dt = curT ? curT[1] - curT[0] : 0;
  return (
    <section className="chart scope" aria-label="Экран осциллографа">
      <h3>Осциллограф</h3>
      <div className="scope-body">
      <div className="scope-left">
      <svg viewBox={`-2 -2 ${W + 4} ${H + 4}`} className="scope-screen" onClick={onClick} role="img" aria-label="Осциллограмма">
        <rect x={0} y={0} width={W} height={H} className="scope-bg" />
        {Array.from({ length: 11 }, (_, i) => <line key={`v${i}`} x1={i * DX} y1={0} x2={i * DX} y2={H} className={i === 5 ? 'axis' : 'grid'} />)}
        {Array.from({ length: 9 }, (_, i) => <line key={`h${i}`} x1={0} y1={i * DY} x2={W} y2={i * DY} className={i === 4 ? 'axis' : 'grid'} />)}
        <clipPath id="scope-clip"><rect x={0} y={0} width={W} height={H} /></clipPath>
        <g clipPath="url(#scope-clip)">
          {traces.map((tr) => tr && <path key={tr.key} d={tr.d} className={`trace ${tr.key}`} />)}
        </g>
        {view.triggered && <path d={`M${DX - 6},0 L${DX + 6},0 L${DX},9 Z`} className="trig-mark" />}
        {trigY >= 0 && trigY <= H && <path d={`M${W},${trigY - 6} L${W - 9},${trigY} L${W},${trigY + 6} Z`} className={`trig-level ${s.trigger.source}`} />}
        {s.cursors?.map((d, i) => <line key={`c${i}`} x1={d * DX} y1={0} x2={d * DX} y2={H} className="cursor-line" />)}
        {traces.map((tr) => {
          if (!tr) return null;
          const y = H / 2 - (tr.ch.offset / tr.ch.vdiv) * DY;
          if (y < 0 || y > H) return null;
          return <g key={`z${tr.key}`} className={`zero-mark ${tr.key}`}><path d={`M0,${y - 6} L9,${y} L0,${y + 6} Z`} /><text x={12} y={y + 4}>{tr.key === 'ch1' ? '1' : '2'}</text></g>;
        })}
      </svg>
      <div className="scope-info small">
        <span data-testid="scope-status">{view.status}</span>
        <span>{formatQuantity(s.timeDiv, 'с')}/дел</span>
        {traces.map((tr) => tr && <span key={tr.key} className={`ch-tag ${tr.key}`}>{tr.key.toUpperCase()} {formatQuantity(tr.ch.vdiv, 'В')}/дел</span>)}
      </div>
      </div>
      <div className="scope-right">
      {short && <p className="warning-text small">Правая часть экрана — за концом записанного переходного процесса ({formatQuantity(tEnd, 'с')}): там сигнала нет. Увеличьте время расчёта или уменьшите развёртку.</p>}
      <table className="op-table" data-testid="scope-stats">
        <thead><tr><th></th><th>Размах</th><th>Среднее</th><th>RMS~</th><th>Частота</th></tr></thead>
        <tbody>
          {traces.map((tr) => tr && (
            <tr key={tr.key}>
              <td>{tr.key.toUpperCase()}</td>
              <td>{tr.stats ? formatQuantity(tr.stats.vpp, 'В') : '—'}</td>
              <td>{tr.stats ? formatQuantity(tr.stats.mean, 'В') : '—'}</td>
              <td>{tr.stats ? formatQuantity(tr.stats.acRms, 'В') : '—'}</td>
              <td>{tr.stats?.freq ? formatQuantity(tr.stats.freq, 'Гц', 4) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {curT && (
        <dl className="meta" data-testid="scope-cursors">
          <dt>Δt</dt><dd>{formatQuantity(Math.abs(dt), 'с', 4)}</dd>
          <dt>1/Δt</dt><dd>{dt !== 0 ? formatQuantity(1 / Math.abs(dt), 'Гц', 4) : '—'}</dd>
          {traces.map((tr) => {
            if (!tr) return null;
            const a = valueAt(tr.c.t, tr.c.v, curT[0]), b = valueAt(tr.c.t, tr.c.v, curT[1]);
            return <Fragment key={tr.key}><dt>{tr.key.toUpperCase()} ΔU</dt><dd>{a !== null && b !== null ? formatQuantity(b - a, 'В', 4) : '—'}</dd></Fragment>;
          })}
        </dl>
      )}
      <p className="muted small">Метки «1», «2» слева — уровень 0 В канала; треугольник справа — уровень синхронизации, сверху — момент запуска. Автоизмерения — по видимой части экрана. Осциллограмма — переходный процесс ngspice; точки расчёта, а не реальная частота дискретизации прибора.</p>
      </div>
      </div>
    </section>
  );
}
