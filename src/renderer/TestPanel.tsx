/**
 * Вкладка «Тест» (этап 1b): расчёт ngspice, мультиметр DC V со щупами, осциллограмма по щупам,
 * проверки схемы и пределов деталей. Показания строятся только по результату расчёта для текущей
 * ревизии схемы; если схема изменилась — результат помечается устаревшим и показания не выводятся.
 */
import { useMemo, useState } from 'react';
import { multimeter, type ProbeColor } from '../core/instruments';
import { formatQuantity, parseQuantity } from '../core/library';
import type { PinRef, ProjectDoc } from '../core/model';
import { netOfPin, symbolOf } from '../core/schematic';
import type { SimResult } from '../shared/api';
import { circuitKey } from '../sim/key';
import { SchematicCanvas } from './SchematicCanvas';

interface Props {
  doc: ProjectDoc;
  ngspice: string | null;
  result: SimResult | null;
  /** Электрический ключ схемы, по которой выполнен расчёт. */
  resultKey: string | null;
  running: boolean;
  onRun(tran: boolean): void;
  onProbe(color: ProbeColor, pin: PinRef | null): void;
  onTranSettings(patch: { stopS?: number; stepS?: number; startFromZero?: boolean }): void;
}

const pinLabel = (doc: ProjectDoc, ref: PinRef | null) => {
  if (!ref) return 'не подключён';
  const inst = doc.schematic.instances.find((i) => i.id === ref.instanceId);
  const pin = inst ? symbolOf(doc, inst)?.pins.find((p) => p.number === ref.pin) : undefined;
  return inst ? `${inst.refDes}, вывод ${pin?.name ?? ref.pin}` : 'вывод удалён';
};

export function TestPanel({ doc, ngspice, result, resultKey, running, onRun, onProbe, onTranSettings }: Props) {
  const [active, setActive] = useState<ProbeColor>('red');
  const [withTran, setWithTran] = useState(true);
  const probes = multimeter(doc);
  const key = useMemo(() => circuitKey(doc), [doc]);
  const fresh = result !== null && resultKey === key;
  const usable = fresh && result.status === 'ok';

  const netV = (ref: PinRef | null, src: Record<string, number> | undefined): number | null => {
    if (!ref || !src) return null;
    const net = netOfPin(doc, ref);
    if (!net) return null; // вывод ни к чему не подключён — потенциал не определён
    const v = src[net.id];
    return v === undefined || !Number.isFinite(v) ? null : v;
  };

  const reading = useMemo(() => {
    if (!usable || !result.op) return null;
    if (!probes.red || !probes.black) return { text: '— подключите оба щупа', value: null };
    const a = netV(probes.red, result.op.node), b = netV(probes.black, result.op.node);
    if (a === null || b === null) return { text: 'вывод не подключён к схеме — потенциал не определён', value: null };
    return { text: formatQuantity(a - b, 'В', 4), value: a - b };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, result, probes.red, probes.black, doc]);

  const nodeLabels = useMemo(() => {
    if (!usable || !result.op) return undefined;
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries(result.op.node)) if (Number.isFinite(v)) out[id] = formatQuantity(v, 'В', 3);
    return out;
  }, [usable, result]);

  const flagged = useMemo(() => new Set((fresh ? result.issues : []).flatMap((i) => i.refs)), [fresh, result]);

  const trace = useMemo(() => {
    if (!usable || !result.tran || !probes.red || !probes.black) return null;
    const na = netOfPin(doc, probes.red), nb = netOfPin(doc, probes.black);
    if (!na || !nb) return null;
    const a = result.tran.node[na.id], b = result.tran.node[nb.id];
    if (!a || !b) return null;
    return { t: result.tran.time, v: a.map((x, i) => x - b[i]!) };
  }, [usable, result, probes.red, probes.black, doc]);

  const rows = useMemo(() => {
    if (!usable || !result.op) return [];
    return doc.schematic.instances.flatMap((inst) => {
      const i = result.op!.current[inst.id];
      if (i === undefined) return [];
      const pins = symbolOf(doc, inst)?.pins ?? [];
      const va = netV(pins[0] ? { instanceId: inst.id, pin: pins[0].number } : null, result.op!.node);
      const vb = netV(pins[1] ? { instanceId: inst.id, pin: pins[1].number } : null, result.op!.node);
      const v = va !== null && vb !== null ? va - vb : null;
      return [{ id: inst.id, ref: inst.refDes, v, i, p: v !== null ? v * i : null }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, result, doc]);

  return (
    <div className="test-tab">
      <div className="test-canvas">
        <SchematicCanvas
          doc={doc}
          mode="probe"
          selection={null}
          onSelect={() => undefined}
          onPinClick={(pin) => onProbe(active, pin)}
          probes={probes}
          nodeLabels={nodeLabels}
          flagged={flagged}
          hint={`Щёлкните вывод — поставить ${active === 'red' ? 'красный' : 'чёрный'} щуп`}
          banner="Результаты — расчёт ngspice по моделям деталей. Расчёт не гарантирует безопасность и работоспособность реальной платы."
        />
      </div>
      <aside className="test-side" aria-label="Приборы">
        <section>
          <h3>Расчёт</h3>
          {!ngspice && <p className="error-text">Симулятор ngspice не найден — расчёт недоступен.</p>}
          <label className="check"><input type="checkbox" checked={withTran} onChange={(e) => setWithTran(e.target.checked)} /> Переходный процесс</label>
          {withTran && <TranSettings doc={doc} onChange={onTranSettings} />}
          <button className="btn primary" disabled={running || !ngspice} onClick={() => onRun(withTran)}>{running ? 'Расчёт…' : 'Запустить тест'}</button>
          {result && !fresh && <p className="muted small">Схема изменилась после расчёта — результаты устарели, запустите тест снова.</p>}
          {fresh && result.status === 'ok' && <p className="muted small" data-testid="sim-status">Рассчитано: {result.engine.name} {result.engine.version ?? ''}, {result.durationMs} мс</p>}
          {fresh && result.status === 'blocked' && <p className="error-text" data-testid="sim-status">Расчёт не выполнен: в схеме есть ошибки (см. ниже).</p>}
          {fresh && result.status === 'failed' && result.error && (
            <div className="error-text" data-testid="sim-status">
              {result.error.message}
              {result.error.details.length > 0 && <details><summary>Подробности ngspice</summary><pre>{result.error.details.join('\n')}</pre></details>}
            </div>
          )}
        </section>

        {fresh && result.issues.length > 0 && (
          <section>
            <h3>Проверка схемы</h3>
            <ul className="issues" aria-label="Проверка схемы">
              {result.issues.map((i, k) => <li key={k} className={i.severity}>{i.severity === 'error' ? 'Ошибка' : 'Предупреждение'}: {i.message}</li>)}
            </ul>
          </section>
        )}

        <section>
          <h3>Мультиметр · DC V</h3>
          <div className="probe-select" role="radiogroup" aria-label="Щуп">
            {(['red', 'black'] as const).map((c) => (
              <button key={c} role="radio" aria-checked={active === c} className={`btn small probe-btn ${c} ${active === c ? 'on' : ''}`} onClick={() => setActive(c)}>
                {c === 'red' ? 'Красный (+)' : 'Чёрный (COM)'}
              </button>
            ))}
          </div>
          <dl className="meta">
            <dt>Красный</dt><dd data-testid="probe-red">{pinLabel(doc, probes.red)}</dd>
            <dt>Чёрный</dt><dd data-testid="probe-black">{pinLabel(doc, probes.black)}</dd>
          </dl>
          <div className="mm-display" data-testid="mm-reading" aria-live="polite">
            {reading ? reading.text : usable ? '—' : 'нет расчёта'}
          </div>
          <p className="muted small">Показание — разность потенциалов красного и чёрного щупа в рабочей точке (DC). Прибор идеальный: не нагружает схему. Режимы A, Ω, прозвонка — этап 5.</p>
          <button className="btn small" onClick={() => { onProbe('red', null); onProbe('black', null); }}>Снять щупы</button>
        </section>

        {trace && (
          <section>
            <h3>Осциллограмма (красный − чёрный)</h3>
            <TraceChart t={trace.t} v={trace.v} />
          </section>
        )}

        {fresh && result.limits.length > 0 && (
          <section>
            <h3>Пределы деталей</h3>
            <ul className="issues">{result.limits.map((l, k) => <li key={k} className="warning">{l.message}</li>)}</ul>
          </section>
        )}

        {rows.length > 0 && (
          <section>
            <h3>Рабочая точка</h3>
            <table className="op-table">
              <thead><tr><th>Деталь</th><th>U</th><th>I</th><th>P</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}><td>{r.ref}</td><td>{r.v === null ? '—' : formatQuantity(r.v, 'В')}</td><td>{formatQuantity(r.i, 'А')}</td><td>{r.p === null ? '—' : formatQuantity(r.p, 'Вт')}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">U — между выводами 1 и 2 (у источника: «+» и «−»); ток R и C — от вывода 1 к 2; ток источника — через него от «+» к «−» (отрицательный, когда он отдаёт мощность).</p>
          </section>
        )}

        {fresh && result.netlist && (
          <section>
            <details><summary>Netlist для ngspice</summary><pre className="netlist">{result.netlist}</pre></details>
          </section>
        )}
      </aside>
    </div>
  );
}

function TranSettings({ doc, onChange }: { doc: ProjectDoc; onChange(p: { stopS?: number; stepS?: number; startFromZero?: boolean }): void }) {
  const t = doc.simulation.tran;
  const field = (label: string, value: number, key: 'stopS' | 'stepS') => (
    <label className="field inline">
      <span>{label}</span>
      <input
        key={value}
        aria-label={label}
        defaultValue={formatQuantity(value, 'с', 4)}
        onBlur={(e) => {
          const v = parseQuantity(e.target.value, 'с');
          if (v !== null && v > 0) onChange({ [key]: v }); else e.target.value = formatQuantity(value, 'с', 4);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
  return (
    <div className="tran-settings">
      {field('Время', t.stopS, 'stopS')}
      {field('Шаг', t.stepS, 'stepS')}
      <label className="check"><input type="checkbox" checked={t.startFromZero} onChange={(e) => onChange({ startFromZero: e.target.checked })} /> Включение питания при t = 0</label>
    </div>
  );
}

/** Простая осциллограмма: ось времени и напряжения с подписями крайних значений. */
function TraceChart({ t, v }: { t: number[]; v: number[] }) {
  const W = 300, H = 160, L = 46, B = 22, T = 8, R = 8;
  const t0 = t[0] ?? 0, t1 = t[t.length - 1] ?? 1;
  let vmin = Math.min(...v), vmax = Math.max(...v);
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) return <p className="muted small">Нет данных</p>;
  if (vmax - vmin < 1e-12) { vmin -= 1; vmax += 1; }
  const pad = (vmax - vmin) * 0.08;
  vmin -= pad; vmax += pad;
  const x = (tt: number) => L + ((tt - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (vv: number) => T + (1 - (vv - vmin) / (vmax - vmin)) * (H - T - B);
  const step = Math.max(1, Math.floor(t.length / 600));
  const pts: string[] = [];
  for (let i = 0; i < t.length; i += step) pts.push(`${x(t[i]!).toFixed(1)},${y(v[i]!).toFixed(1)}`);
  return (
    <svg className="trace" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Осциллограмма">
      <rect x={L} y={T} width={W - L - R} height={H - T - B} className="trace-bg" />
      {vmin < 0 && vmax > 0 && <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="trace-zero" />}
      <polyline points={pts.join(' ')} className="trace-line" />
      <text x={L - 4} y={T + 9} className="trace-axis" textAnchor="end">{formatQuantity(vmax, 'В', 3)}</text>
      <text x={L - 4} y={H - B} className="trace-axis" textAnchor="end">{formatQuantity(vmin, 'В', 3)}</text>
      <text x={L} y={H - 6} className="trace-axis">{formatQuantity(t0, 'с', 3)}</text>
      <text x={W - R} y={H - 6} className="trace-axis" textAnchor="end">{formatQuantity(t1, 'с', 3)}</text>
    </svg>
  );
}
