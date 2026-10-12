/**
 * Вкладка «Проверка работы»: условия работоспособности, запуск расчёта и итог «работает / не работает».
 * Для каждого условия — расчётное значение и, если введён, результат замера на собранном устройстве.
 */
import { useMemo, useState } from 'react';
import { addCheck, CHECK_KINDS, checkKind, checkProblem, deleteCheck, describeCheck, fmtValue, newCheck, rangeText, setNoOverload, updateCheck, type CheckQuantity } from '../core/checks';
import { formatQuantity, parseQuantity } from '../core/library';
import type { Check, PinRef, ProjectDoc } from '../core/model';
import type { CheckReport } from '../sim/checks';
import { api, errorText, unwrap } from './api';

interface Props {
  doc: ProjectDoc;
  ngspice: string | null;
  onEdit(label: string, fn: (d: ProjectDoc) => ProjectDoc, coalesceKey?: string): void;
}

const pinKey = (p: PinRef | null) => (p ? `${p.instanceId}|${p.pin}` : '');
const parsePin = (k: string): PinRef | null => (k ? { instanceId: k.split('|')[0]!, pin: k.split('|')[1]! } : null);

function usePins(doc: ProjectDoc) {
  return useMemo(() => {
    const out: Array<{ key: string; label: string }> = [];
    const sorted = [...doc.schematic.instances].sort((a, b) => a.refDes.localeCompare(b.refDes, 'ru', { numeric: true }));
    for (const inst of sorted) {
      const part = doc.library.parts.find((p) => p.id === inst.partId);
      const sym = part ? doc.library.symbols.find((s) => s.id === part.symbolId) : undefined;
      if (!sym || part?.category === 'reference') continue;
      for (const pin of sym.pins) out.push({ key: `${inst.id}|${pin.number}`, label: `${inst.refDes}.${pin.number}${pin.name && pin.name !== pin.number ? ` (${pin.name})` : ''}` });
    }
    return out;
  }, [doc.schematic.instances, doc.library]);
}

function PinSelect({ label, value, pins, allowGround, onChange }: { label: string; value: PinRef | null; pins: Array<{ key: string; label: string }>; allowGround?: boolean; onChange(p: PinRef | null): void }) {
  return (
    <label className="field inline">
      <span>{label}</span>
      <select aria-label={label} value={pinKey(value)} onChange={(e) => onChange(parsePin(e.target.value))}>
        <option value="">{allowGround ? 'земля' : '— выберите вывод —'}</option>
        {pins.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
    </label>
  );
}

function QField({ label, value, unit, onCommit }: { label: string; value: number | null; unit: string; onCommit(v: number | null): void }) {
  const shown = value === null ? '' : formatQuantity(value, unit, 6);
  return (
    <label className="field inline">
      <span>{label}</span>
      <input aria-label={label} key={shown} defaultValue={shown} placeholder="—"
        onBlur={(e) => {
          const t = e.target.value.trim();
          if (!t) { if (value !== null) onCommit(null); return; }
          const v = parseQuantity(t, unit);
          if (v === null) { e.target.value = shown; return; }
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

export function ChecksPanel({ doc, ngspice, onEdit }: Props) {
  const pins = usePins(doc);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<CheckQuantity>('dc-v');
  const stale = report !== null && report.revision !== doc.revision;
  const items = doc.checks.items;

  const run = async () => {
    setRunning(true); setError(null);
    try { setReport(await unwrap(api().sim.checks(doc))); }
    catch (e) { setError(errorText(e)); }
    finally { setRunning(false); }
  };
  const upd = (c: Check, patch: Partial<Omit<Check, 'id'>>, label = 'Условие работоспособности') => onEdit(label, (d) => updateCheck(d, c.id, patch), `check:${c.id}:${Object.keys(patch).join(',')}`);
  const outcome = (id: string) => (report && !stale ? report.outcomes.find((o) => o.id === id) : undefined);

  return (
    <div className="checks-page">
      <section className={`verdict ${report && !stale ? report.verdict : 'none'}`} aria-label="Итог проверки" data-testid="verdict">
        {!report && <p>Задайте условия, при которых устройство считается работающим, и нажмите «Проверить работоспособность».</p>}
        {report && stale && <p>Схема или условия изменились после проверки — проверьте заново.</p>}
        {report && !stale && <p className="verdict-text">{report.verdict === 'works' ? '✔ ' : report.verdict === 'fails' ? '✘ ' : '? '}{report.summary}</p>}
        {report && !stale && report.errors.map((m, i) => <p key={i} className="error-text small">{m}</p>)}
        {report && !stale && report.overload.length > 0 && (
          <ul className="small" aria-label="Перегрузка деталей">{report.overload.map((m, i) => <li key={i} className={doc.checks.noOverload ? 'error-text' : 'warning-text'}>{m}</li>)}</ul>
        )}
        <div className="row wrap">
          <button className="btn primary" disabled={running || !ngspice} onClick={() => void run()}>{running ? 'Считаю…' : 'Проверить работоспособность'}</button>
          {!ngspice && <span className="error-text small">ngspice не найден — расчёт невозможен</span>}
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <p className="muted small">Проверка считает схему в ngspice: рабочую точку, а если нужно — переходный процесс (время — на вкладке «Тест») и частотный анализ. «Замер» — значение, которое вы измерили на собранном устройстве: оно сверяется с тем же диапазоном.</p>
      </section>

      <section aria-label="Условия работоспособности">
        <h3>Условия</h3>
        <label className="check"><input type="checkbox" checked={doc.checks.noOverload} onChange={(e) => onEdit('Условие «без перегрузки»', (d) => setNoOverload(d, e.target.checked))} /> Ни одна деталь не перегружена (мощность, ток, напряжение — по пределам деталей)</label>
        {items.length === 0 && <p className="muted">Условий пока нет. Например: «на выходе стабилизатора 4,8…5,2 В», «генератор: частота 200…250 кГц», «ток потребления не больше 50 мА».</p>}
        <ol className="checks-list">
          {items.map((c) => {
            const k = checkKind(c.quantity);
            const o = outcome(c.id);
            const problem = checkProblem(c);
            const unit = c.quantity === 'ac-gain' ? '' : k.unitRu;
            return (
              <li key={c.id} className={`check-item ${o?.status ?? ''}`} data-testid="check-item">
                <div className="row wrap">
                  <label className="field inline grow">
                    <span>Название</span>
                    <input aria-label="Название условия" key={c.name} defaultValue={c.name} placeholder={k.label}
                      onBlur={(e) => { if (e.target.value !== c.name) upd(c, { name: e.target.value.slice(0, 200) }); }} />
                  </label>
                  <label className="field inline">
                    <span>Величина</span>
                    <select aria-label="Величина" value={c.quantity} onChange={(e) => {
                      const q = e.target.value as CheckQuantity;
                      upd(c, { quantity: q, freqHz: q === 'ac-gain' ? c.freqHz ?? 1000 : c.freqHz, min: null, max: null, measured: null });
                    }}>
                      {CHECK_KINDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                  </label>
                  <button className="btn small danger" aria-label="Удалить условие" onClick={() => onEdit('Удаление условия', (d) => deleteCheck(d, c.id))}>×</button>
                </div>
                <div className="row wrap">
                  <PinSelect label={c.quantity === 'dc-i' ? 'Вывод' : c.quantity === 'ac-gain' ? 'Выход (вывод)' : 'Где измерять (вывод)'} value={c.at} pins={pins} onChange={(p) => upd(c, { at: p })} />
                  {k.needs.includes('ref') && <PinSelect label="Относительно" value={c.ref} pins={pins} allowGround onChange={(p) => upd(c, { ref: p })} />}
                  {k.needs.includes('input') && <PinSelect label="Вход (вывод)" value={c.input} pins={pins} onChange={(p) => upd(c, { input: p })} />}
                  {k.needs.includes('freq') && <QField label="Частота" unit="Гц" value={c.freqHz} onCommit={(v) => upd(c, { freqHz: v })} />}
                  {k.needs.includes('from') && <QField label="Окно с момента" unit="с" value={c.fromS} onCommit={(v) => upd(c, { fromS: v })} />}
                </div>
                <div className="row wrap">
                  <QField label="Не меньше" unit={unit} value={c.min} onCommit={(v) => upd(c, { min: v })} />
                  <QField label="Не больше" unit={unit} value={c.max} onCommit={(v) => upd(c, { max: v })} />
                  <QField label="Замер" unit={unit} value={c.measured} onCommit={(v) => upd(c, { measured: v })} />
                </div>
                <p className="small check-desc">{describeCheck(doc, c)}</p>
                {problem && <p className="warning-text small">{problem}</p>}
                {o && (
                  <p className="small check-result" data-testid="check-result">
                    Расчёт: {o.value !== null ? fmtValue(c.quantity, o.value) : '—'} — <b className={o.status}>{o.status === 'pass' ? 'выполнено' : o.status === 'fail' ? `не выполнено (нужно ${rangeText(c)})` : `не посчитано: ${o.reason}`}</b>
                    {o.status === 'fail' && o.reason && <> ({o.reason})</>}
                    {o.measuredStatus && <> · Замер {fmtValue(c.quantity, c.measured!)} — <b className={o.measuredStatus}>{o.measuredStatus === 'pass' ? 'в диапазоне' : 'вне диапазона'}</b></>}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
        <div className="row wrap">
          <select aria-label="Вид нового условия" value={newKind} onChange={(e) => setNewKind(e.target.value as CheckQuantity)}>
            {CHECK_KINDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
          <button className="btn" onClick={() => onEdit('Новое условие работоспособности', (d) => addCheck(d, newCheck(newKind)))}>Добавить условие</button>
        </div>
      </section>
    </div>
  );
}
