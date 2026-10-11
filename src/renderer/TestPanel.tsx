/**
 * Вкладка «Тест» (этапы 4–5): расчёт ngspice — рабочая точка, переходный процесс, развёртка по постоянному
 * току, частотный анализ, параметрический прогон; приборы (мультиметр, осциллограф, ESR-метр, блок
 * питания — Instruments.tsx), графики по щупам, токи и мощности деталей, проверки схемы и пределов деталей. Показания строятся только по результату расчёта
 * для текущей схемы; если схема изменилась — результат помечается устаревшим и показания не выводятся.
 */
import { useMemo, useState } from 'react';
import { multimeter, setProbeTarget, type ProbeTarget } from '../core/instruments';
import { formatQuantity, modelParams, PARAMS, parseQuantity } from '../core/library';
import type { PinRef, ProjectDoc, SimulationSettings } from '../core/model';
import { netOfPin, symbolOf } from '../core/schematic';
import { EsrPanel, MultimeterPanel, probeMarks, PsuPanel, QField, ScopeControls, ScopeScreen, type InstrumentTab } from './Instruments';
import type { SimResult } from '../shared/api';
import { circuitKey } from '../sim/key';
import { transfer, type SweepRun } from '../sim/results';
import { Plot, type Series } from './Plot';
import { SchematicCanvas } from './SchematicCanvas';

type Analysis = SimulationSettings['analysis'];

interface Props {
  doc: ProjectDoc;
  ngspice: string | null;
  result: SimResult | null;
  /** Электрический ключ схемы, по которой выполнен расчёт. */
  resultKey: string | null;
  running: boolean;
  onRun(): void;
  /** Правка документа из приборов (щупы, режимы, ручки БП) — через историю Undo/Redo. */
  onEdit(label: string, fn: (d: ProjectDoc) => ProjectDoc): void;
  onTranSettings(patch: { stopS?: number; stepS?: number; startFromZero?: boolean }): void;
  onSimSettings(patch: Partial<Omit<SimulationSettings, 'tran'>>): void;
}

const ANALYSES: Array<[Analysis, string]> = [['op', 'Рабочая точка'], ['tran', 'Переходный процесс'], ['dc', 'Развёртка DC'], ['ac', 'Частотный (AC)']];

const modelOf = (doc: ProjectDoc, instanceId: string) => {
  const inst = doc.schematic.instances.find((i) => i.id === instanceId);
  const part = inst && doc.library.parts.find((p) => p.id === inst.partId);
  return part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
};

const TABS: Array<[InstrumentTab, string]> = [['mm', 'Мультиметр'], ['scope', 'Осциллограф'], ['esr', 'ESR-метр'], ['psu', 'Блок питания']];
const FIRST_TARGET: Record<InstrumentTab, ProbeTarget | null> = { mm: 'mm.red', scope: 'scope.ch1', esr: 'esr.red', psu: null };
const TARGET_TEXT: Record<ProbeTarget, string> = {
  'mm.red': 'красный щуп мультиметра', 'mm.black': 'чёрный щуп мультиметра', 'scope.ch1': 'щуп CH1 осциллографа',
  'scope.ch2': 'щуп CH2 осциллографа', 'esr.red': 'щуп «+» ESR-метра', 'esr.black': 'щуп «−» ESR-метра',
};

export function TestPanel({ doc, ngspice, result, resultKey, running, onRun, onEdit, onTranSettings, onSimSettings }: Props) {
  const [tab, setTab] = useState<InstrumentTab>('mm');
  const [target, setTarget] = useState<ProbeTarget>('mm.red');
  const probes = multimeter(doc);
  const openTab = (t: InstrumentTab) => { setTab(t); const f = FIRST_TARGET[t]; if (f) setTarget(f); };
  const marks = probeMarks(doc, tab);
  const key = useMemo(() => circuitKey(doc), [doc]);
  const fresh = result !== null && resultKey === key;
  const usable = fresh && result.status === 'ok';
  const sim = doc.simulation;

  const netV = (ref: PinRef | null, src: Record<string, number> | undefined): number | null => {
    if (!ref || !src) return null;
    const net = netOfPin(doc, ref);
    if (!net) return null; // вывод ни к чему не подключён — потенциал не определён
    const v = src[net.id];
    return v === undefined || !Number.isFinite(v) ? null : v;
  };

  const nodeLabels = useMemo(() => {
    if (!usable || !result.op) return undefined;
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries(result.op.node)) if (Number.isFinite(v)) out[id] = formatQuantity(v, 'В', 3);
    return out;
  }, [usable, result]);

  const flagged = useMemo(() => new Set((fresh ? result.issues.filter((i) => i.severity === 'error') : []).flatMap((i) => i.refs)), [fresh, result]);
  const probeNets = useMemo(() => ({
    red: probes.red ? netOfPin(doc, probes.red)?.id ?? null : null,
    black: probes.black ? netOfPin(doc, probes.black)?.id ?? null : null,
  }), [doc, probes.red, probes.black]);

  /** Кривые «красный − чёрный» для основного расчёта и прогонов. */
  const curves = useMemo(() => {
    if (!usable || !probeNets.red || !probeNets.black) return null;
    const { red, black } = probeNets;
    const diff = (node: Record<string, number[]> | undefined) => {
      const a = node?.[red], b = node?.[black];
      return a && b ? a.map((x, i) => x - b[i]!) : null;
    };
    const runs: Array<{ label: string; run: Pick<SweepRun, 'tran' | 'dc' | 'ac'> }> = [{ label: 'схема', run: result }];
    if (result.sweep) {
      const inst = doc.schematic.instances.find((i) => i.id === result.sweep!.instanceId);
      for (const r of result.sweep.runs) if (r.status === 'ok') runs.push({ label: `${inst?.refDes ?? '?'} = ${formatQuantity(r.value, PARAMS[result.sweep.param]?.unitRu ?? '')}`, run: r });
    }
    if (result.analysis === 'tran' && result.tran) {
      const series = runs.flatMap(({ label, run }) => { const y = run.tran ? diff(run.tran.node) : null; return y ? [{ label, y }] : []; });
      return { kind: 'tran' as const, x: result.tran.time, series };
    }
    if (result.analysis === 'dc' && result.dc) {
      const series = runs.flatMap(({ label, run }) => { const y = run.dc ? diff(run.dc.node) : null; return y ? [{ label, y }] : []; });
      return { kind: 'dc' as const, x: result.dc.x, series };
    }
    if (result.analysis === 'ac' && result.ac) {
      const srcAmp = acSourceAmplitude(doc);
      const mags: Series[] = [], phases: Series[] = [];
      for (const { label, run } of runs) {
        if (!run.ac) continue;
        const t = transfer(run.ac, red, black, null);
        mags.push({ label, y: t.mag.map((m) => 20 * Math.log10(m / (srcAmp?.value ?? 1))) });
        phases.push({ label, y: t.phaseDeg });
      }
      return { kind: 'ac' as const, x: result.ac.freq, series: mags, phases, srcAmp };
    }
    return null;
  }, [usable, result, probeNets, doc]);

  type Row = { id: string; ref: string; v: number | null; i: number | null; pinText: string | null; p: number | null };
  const rows = useMemo((): Row[] => {
    if (!usable || !result.op) return [];
    const op = result.op;
    return doc.schematic.instances.flatMap((inst): Row[] => {
      const pins = symbolOf(doc, inst)?.pins ?? [];
      const pinCur = op.pins[inst.id];
      if (pinCur) {
        let p = 0;
        for (const pin of pins) {
          const v = netV({ instanceId: inst.id, pin: pin.number }, op.node), i = pinCur[pin.number];
          if (v === null || i === undefined) { p = NaN; break; }
          p += v * i;
        }
        const text = pins.filter((x) => pinCur[x.number] !== undefined).map((x) => `${x.name || x.number}: ${formatQuantity(pinCur[x.number]!, 'А')}`).join(', ');
        return [{ id: inst.id, ref: inst.refDes, v: null, i: null, pinText: text, p: Number.isFinite(p) ? p : null }];
      }
      const i = op.current[inst.id];
      if (i === undefined) return [];
      const va = netV(pins[0] ? { instanceId: inst.id, pin: pins[0].number } : null, op.node);
      const vb = netV(pins[1] ? { instanceId: inst.id, pin: pins[1].number } : null, op.node);
      const v = va !== null && vb !== null ? va - vb : null;
      return [{ id: inst.id, ref: inst.refDes, v, i, pinText: null, p: v !== null ? v * i : null }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, result, doc]);

  const sources = doc.schematic.instances.filter((i) => /^[VI]/i.test(modelOf(doc, i.id)?.text.trim() ?? ''));
  const sweepable = doc.schematic.instances.filter((i) => modelParams(modelOf(doc, i.id)).length > 0);
  const failedRuns = fresh && result.sweep ? result.sweep.runs.filter((r) => r.status !== 'ok') : [];

  return (
    <div className="test-tab">
      <div className="test-main">
      <div className="test-canvas">
        <SchematicCanvas
          doc={doc}
          mode="probe"
          selection={[]}
          onSelect={() => undefined}
          onPinClick={(pin) => { if (FIRST_TARGET[tab]) onEdit('Щуп', (d) => setProbeTarget(d, target, pin)); }}
          probes={marks}
          nodeLabels={nodeLabels}
          flagged={flagged}
          hint={FIRST_TARGET[tab] ? `Щёлкните вывод — подключить ${TARGET_TEXT[target]}` : 'Ручки блока питания — на панели справа'}
          banner="Результаты — расчёт ngspice по моделям деталей. Модели приближённые; расчёт не гарантирует безопасность и работоспособность реальной платы."
        />
      </div>
      {usable && tab === 'scope' && result.analysis === 'tran' && (
        <div className="test-charts" aria-label="Графики">
          <ScopeScreen doc={doc} result={result} onEdit={onEdit} />
        </div>
      )}
      {usable && result.analysis !== 'op' && tab !== 'scope' && (
        <div className="test-charts" aria-label="Графики">
        {!curves && (
          <p className="muted small">Поставьте оба щупа, чтобы увидеть график «красный − чёрный».</p>
        )}
        {curves?.kind === 'tran' && (
          <section className="chart">
            <h3>Осциллограмма (красный − чёрный)</h3>
            <Plot x={curves.x} series={curves.series} xUnit="с" yUnit="В" ariaLabel="Осциллограмма" />
          </section>
        )}
        {curves?.kind === 'dc' && (
          <section className="chart">
            <h3>Развёртка DC (красный − чёрный)</h3>
            <Plot x={curves.x} series={curves.series} xUnit={sourceUnit(doc, result!.dc!.sourceId)} yUnit="В" ariaLabel="Развёртка DC" />
            <p className="muted small">По оси X — значение источника {doc.schematic.instances.find((i) => i.id === result!.dc!.sourceId)?.refDes}.</p>
          </section>
        )}
        {curves?.kind === 'ac' && (
          <div className="chart-row">
          <section className="chart">
            <h3>АЧХ (красный − чёрный)</h3>
            <Plot x={curves.x} series={curves.series} xUnit="Гц" yUnit="дБ" logX ariaLabel="АЧХ" yFormat={(v) => `${v.toFixed(Math.abs(v) < 10 ? 1 : 0).replace('.', ',')} дБ`} />
            <AcSummary freq={curves.x} db={curves.series[0]?.y ?? []} phase={curves.phases[0]?.y ?? []} />
          </section>
          <section className="chart">
            <h3>ФЧХ</h3>
            <Plot x={curves.x} series={curves.phases} xUnit="Гц" yUnit="°" logX ariaLabel="ФЧХ" yFormat={(v) => `${Math.round(v)}°`} />
            <p className="muted small">
              {curves.srcAmp
                ? `0 дБ — амплитуда источника ${curves.srcAmp.ref} (${formatQuantity(curves.srcAmp.value, 'В')}): показан коэффициент передачи.`
                : '0 дБ — 1 В. Источников синуса несколько — показана амплитуда в дБ относительно 1 В.'}
              {' '}Частотный анализ — малосигнальный (линеаризация в рабочей точке): ограничения и насыщение в нём не видны — для них нужен переходный процесс.
            </p>
          </section>
          </div>
        )}

        </div>
      )}
      </div>
      <aside className="test-side" aria-label="Приборы">
        <section>
          <h3>Расчёт</h3>
          {!ngspice && <p className="error-text">Симулятор ngspice не найден — расчёт недоступен.</p>}
          <div className="seg analysis-seg" role="radiogroup" aria-label="Анализ">
            {ANALYSES.map(([k, l]) => (
              <button key={k} role="radio" aria-checked={sim.analysis === k} className={`btn small ${sim.analysis === k ? 'on' : ''}`} onClick={() => onSimSettings({ analysis: k })}>{l}</button>
            ))}
          </div>
          {sim.analysis === 'tran' && <TranSettings doc={doc} onChange={onTranSettings} />}
          {sim.analysis === 'dc' && <DcSettings doc={doc} sources={sources} onChange={onSimSettings} />}
          {sim.analysis === 'ac' && <AcSettings doc={doc} onChange={onSimSettings} />}
          {sim.analysis === 'op' && <p className="muted small">Постоянные напряжения и токи установившегося режима: конденсаторы — разрыв, катушки — перемычка.</p>}
          <SweepSettings doc={doc} candidates={sweepable} onChange={onSimSettings} />
          <button className="btn primary" disabled={running || !ngspice} onClick={onRun}>{running ? 'Расчёт…' : 'Запустить тест'}</button>
          {result && !fresh && <p className="muted small">Схема или настройки изменились после расчёта — результаты устарели, запустите тест снова.</p>}
          {fresh && result.status === 'ok' && <p className="muted small" data-testid="sim-status">Рассчитано: {result.engine.name} {result.engine.version ?? ''}, {result.durationMs} мс{result.sweep ? `, прогонов: ${result.sweep.runs.length + 1}` : ''}</p>}
          {fresh && result.status === 'blocked' && <p className="error-text" data-testid="sim-status">Расчёт не выполнен: в схеме есть ошибки (см. ниже).</p>}
          {fresh && result.status === 'failed' && result.error && (
            <div className="error-text" data-testid="sim-status">
              {result.error.message}
              {result.error.details.length > 0 && <details><summary>Подробности ngspice</summary><pre>{result.error.details.join('\n')}</pre></details>}
            </div>
          )}
          {failedRuns.length > 0 && (
            <ul className="issues">{failedRuns.map((r, i) => <li key={i} className="warning">Прогон {formatQuantity(r.value, PARAMS[result!.sweep!.param]?.unitRu ?? '')}: {r.error?.message ?? 'не выполнен'}</li>)}</ul>
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

        <section className="instruments">
          <div className="tabs-row" role="tablist" aria-label="Приборы">
            {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn small ${tab === k ? 'on' : ''}`} onClick={() => openTab(k)}>{l}</button>)}
          </div>
          {tab === 'mm' && <MultimeterPanel doc={doc} docKey={key} result={result} usable={usable} target={target} onTarget={setTarget} onEdit={onEdit} ngspice={ngspice} />}
          {tab === 'scope' && (
            <>
              {sim.analysis !== 'tran' && (
                <p className="muted small">Осциллограф показывает переходный процесс. <button className="btn small" onClick={() => onSimSettings({ analysis: 'tran' })}>Выбрать переходный процесс</button></p>
              )}
              {sim.analysis === 'tran' && !usable && <p className="muted small">Запустите тест — осциллограмма появится под схемой.</p>}
              <ScopeControls doc={doc} target={target} onTarget={setTarget} onEdit={onEdit} />
            </>
          )}
          {tab === 'esr' && <EsrPanel doc={doc} docKey={key} target={target} onTarget={setTarget} onEdit={onEdit} ngspice={ngspice} />}
          {tab === 'psu' && <PsuPanel doc={doc} result={result} usable={usable} onEdit={onEdit} />}
          {FIRST_TARGET[tab] && <button className="btn small" onClick={() => onEdit('Снять щупы', (d) => probeMarks(d, tab).reduce((acc, m) => setProbeTarget(acc, targetOf(tab, m.cls), null), d))}>Снять щупы</button>}
        </section>

        {fresh && result.limits.length > 0 && (
          <section>
            <h3>Пределы деталей</h3>
            <ul className="issues" aria-label="Пределы деталей">{result.limits.map((l, k) => <li key={k} className="warning">{l.message}</li>)}</ul>
          </section>
        )}

        {rows.length > 0 && (
          <section>
            <h3>Рабочая точка</h3>
            <table className="op-table" aria-label="Токи и мощности">
              <thead><tr><th>Деталь</th><th>U</th><th>I</th><th>P</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.ref}</td>
                    {r.pinText !== null
                      ? <td colSpan={2} className="pin-currents">{r.pinText}</td>
                      : <><td>{r.v === null ? '—' : formatQuantity(r.v, 'В')}</td><td>{formatQuantity(r.i!, 'А')}</td></>}
                    <td>{r.p === null ? '—' : formatQuantity(r.p, 'Вт')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">U — между выводами 1 и 2 (у источника: «+» и «−»); ток R, C, L — от вывода 1 к 2; ток источника — через него от «+» к «−» (отрицательный, когда он отдаёт мощность). У приборов — ток, втекающий в каждый вывод; P — рассеиваемая мощность.</p>
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

function targetOf(tab: InstrumentTab, cls: string): ProbeTarget {
  if (tab === 'scope') return cls === 'ch2' ? 'scope.ch2' : 'scope.ch1';
  if (tab === 'esr') return cls === 'black' ? 'esr.black' : 'esr.red';
  return cls === 'black' ? 'mm.black' : 'mm.red';
}

function sourceUnit(doc: ProjectDoc, id: string): string {
  return /^I/i.test(modelOf(doc, id)?.text.trim() ?? '') ? 'А' : 'В';
}

/** Амплитуда единственного источника синуса — опорный уровень 0 дБ. */
function acSourceAmplitude(doc: ProjectDoc): { ref: string; value: number } | null {
  const list = doc.schematic.instances.filter((i) => /\sAC\s/i.test(` ${modelOf(doc, i.id)?.text ?? ''} `) && i.values.amplitude);
  if (list.length !== 1) return null;
  const v = list[0]!.values.amplitude!.value;
  return v > 0 ? { ref: list[0]!.refDes, value: v } : null;
}

function AcSummary({ freq, db, phase }: { freq: number[]; db: number[]; phase: number[] }) {
  if (!freq.length) return null;
  let iMax = 0;
  db.forEach((v, i) => { if (v > db[iMax]!) iMax = i; });
  const peak = db[iMax]!;
  // Ближайшая к максимуму частота, где уровень упал на 3 дБ, — выше и ниже максимума (интерполяция по логарифму частоты).
  const cross = (from: number, dir: 1 | -1): number | null => {
    for (let i = from; i + dir >= 0 && i + dir < db.length; i += dir) {
      const j = i + dir;
      if (db[i]! >= peak - 3 && db[j]! < peak - 3) {
        const k = (peak - 3 - db[i]!) / (db[j]! - db[i]!);
        return 10 ** (Math.log10(freq[i]!) + k * (Math.log10(freq[j]!) - Math.log10(freq[i]!)));
      }
    }
    return null;
  };
  const hi = cross(iMax, 1), lo = cross(iMax, -1);
  return (
    <dl className="meta" data-testid="ac-summary">
      <dt>Максимум</dt><dd>{peak.toFixed(2).replace('.', ',')} дБ на {formatQuantity(freq[iMax]!, 'Гц', 4)}</dd>
      {lo !== null && <><dt>Нижняя −3 дБ</dt><dd>{formatQuantity(lo, 'Гц', 4)}</dd></>}
      {hi !== null && <><dt>Верхняя −3 дБ</dt><dd>{formatQuantity(hi, 'Гц', 4)}</dd></>}
      {hi === null && lo === null && <><dt>Полоса −3 дБ</dt><dd>за пределами диапазона</dd></>}
      <dt>Фаза на {formatQuantity(freq[iMax]!, 'Гц', 3)}</dt><dd>{Math.round(phase[iMax] ?? NaN)}°</dd>
    </dl>
  );
}

function TranSettings({ doc, onChange }: { doc: ProjectDoc; onChange(p: { stopS?: number; stepS?: number; startFromZero?: boolean }): void }) {
  const t = doc.simulation.tran;
  return (
    <div className="tran-settings">
      <QField label="Время" value={t.stopS} unit="с" positive onCommit={(v) => onChange({ stopS: v })} />
      <QField label="Шаг" value={t.stepS} unit="с" positive onCommit={(v) => onChange({ stepS: v })} />
      <label className="check"><input type="checkbox" checked={t.startFromZero} onChange={(e) => onChange({ startFromZero: e.target.checked })} /> Включение питания при t = 0</label>
    </div>
  );
}

function DcSettings({ doc, sources, onChange }: { doc: ProjectDoc; sources: ProjectDoc['schematic']['instances']; onChange(p: Partial<Omit<SimulationSettings, 'tran'>>): void }) {
  const d = doc.simulation.dc;
  const unit = d.sourceId ? sourceUnit(doc, d.sourceId) : 'В';
  return (
    <div className="tran-settings">
      <label className="field">
        <span>Источник</span>
        <select aria-label="Источник для развёртки" value={d.sourceId ?? ''} onChange={(e) => onChange({ dc: { ...d, sourceId: e.target.value || null } })}>
          <option value="">— выберите —</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.refDes}</option>)}
        </select>
      </label>
      <QField label="От" value={d.start} unit={unit} onCommit={(v) => onChange({ dc: { ...d, start: v } })} />
      <QField label="До" value={d.stop} unit={unit} onCommit={(v) => onChange({ dc: { ...d, stop: v } })} />
      <QField label="Шаг развёртки" value={d.step} unit={unit} positive onCommit={(v) => onChange({ dc: { ...d, step: v } })} />
    </div>
  );
}

function AcSettings({ doc, onChange }: { doc: ProjectDoc; onChange(p: Partial<Omit<SimulationSettings, 'tran'>>): void }) {
  const a = doc.simulation.ac;
  return (
    <div className="tran-settings">
      <QField label="Частота от" value={a.fStartHz} unit="Гц" positive onCommit={(v) => onChange({ ac: { ...a, fStartHz: v } })} />
      <QField label="Частота до" value={a.fStopHz} unit="Гц" positive onCommit={(v) => onChange({ ac: { ...a, fStopHz: v } })} />
      <label className="field inline">
        <span>Точек на декаду</span>
        <input aria-label="Точек на декаду" key={a.pointsPerDecade} defaultValue={a.pointsPerDecade}
          onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 1000) onChange({ ac: { ...a, pointsPerDecade: n } }); else e.target.value = String(a.pointsPerDecade); }} />
      </label>
      <p className="muted small">Нужен источник синусоидального напряжения: его амплитуда — уровень входного сигнала.</p>
    </div>
  );
}

function SweepSettings({ doc, candidates, onChange }: { doc: ProjectDoc; candidates: ProjectDoc['schematic']['instances']; onChange(p: Partial<Omit<SimulationSettings, 'tran'>>): void }) {
  const s = doc.simulation.sweep;
  const inst = s.instanceId ? doc.schematic.instances.find((i) => i.id === s.instanceId) : undefined;
  const params = inst ? modelParams(modelOf(doc, inst.id)) : [];
  const unit = PARAMS[s.param]?.unitRu ?? '';
  const [text, setText] = useState(s.values.map((v) => formatQuantity(v, unit, 4)).join('; '));
  const [error, setError] = useState<string | null>(null);
  const commit = (t: string) => {
    const parts = t.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
    const vals = parts.map((x) => parseQuantity(x, unit));
    if (vals.some((v) => v === null)) { setError('Не понял значение. Пример: 1к; 4,7к; 10к'); return; }
    if (vals.length > 12) { setError('Не более 12 значений'); return; }
    setError(null);
    onChange({ sweep: { ...s, values: vals as number[] } });
  };
  return (
    <details className="sweep" open={Boolean(inst)}>
      <summary>Параметрический прогон{inst ? `: ${inst.refDes}` : ''}</summary>
      <label className="field">
        <span>Деталь</span>
        <select aria-label="Деталь для прогона" value={s.instanceId ?? ''} onChange={(e) => {
          const id = e.target.value || null;
          const p = id ? modelParams(modelOf(doc, id))[0] ?? '' : '';
          onChange({ sweep: { instanceId: id, param: p, values: [] } });
          setText('');
        }}>
          <option value="">— нет прогона —</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.refDes}</option>)}
        </select>
      </label>
      {inst && params.length > 1 && (
        <label className="field">
          <span>Параметр</span>
          <select aria-label="Параметр прогона" value={s.param} onChange={(e) => { onChange({ sweep: { ...s, param: e.target.value, values: [] } }); setText(''); }}>
            {params.map((p) => <option key={p} value={p}>{PARAMS[p]?.label ?? p}</option>)}
          </select>
        </label>
      )}
      {inst && (
        <label className="field">
          <span>Значения «{PARAMS[s.param]?.label ?? s.param}» через «;»</span>
          <input aria-label="Значения прогона" value={text} placeholder="1к; 4,7к; 10к" onChange={(e) => setText(e.target.value)} onBlur={() => commit(text)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          {error && <em className="error-text small">{error}</em>}
        </label>
      )}
      <p className="muted small">Тот же анализ повторяется для каждого значения; на графике — по кривой на значение. Схема в проекте не меняется.</p>
    </details>
  );
}
