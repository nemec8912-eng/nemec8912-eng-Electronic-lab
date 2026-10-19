/**
 * Вкладка «Испытания» (этап 7): журнал проверок реальной платы. Запись привязана к ревизии проекта
 * (контрольной версии): измерения сравниваются с расчётом этой ревизии с учётом допусков, её можно
 * сравнить с текущей и восстановить (журнал при этом не стирается). Отказы и замены деталей, фото.
 */
import { useEffect, useMemo, useState } from 'react';
import { diffDocs, type DiffItem } from '../core/diff';
import { formatQuantity, parseQuantity } from '../core/library';
import type { CheckpointInfo, Measurement, MeasureTarget, ProjectDoc, TestRecord } from '../core/model';
import { netDisplayName } from '../core/connectivity';
import {
  addRecord, attachPhoto, compare, deleteRecord, detachPhoto, EVENT_KINDS, fmtDay, hypotheses, newEvent, newMeasurement, newRecord, quantityUnit,
  recordSummary, setEvents, setMeasurements, updateRecord,
} from '../core/testlog';
import { api, errorText, fmtDateTime, unwrap } from './api';
import { useDialogs } from './Dialogs';
import { testReportSvg, verdictText } from '../core/testReport';

interface Props {
  doc: ProjectDoc;
  checkpoints: CheckpointInfo[];
  onEdit(label: string, fn: (d: ProjectDoc) => ProjectDoc, coalesceKey?: string): void;
  onCheckpointsChanged(): Promise<void>;
  onRestore(cp: CheckpointInfo): Promise<void>;
  toast(text: string, kind?: 'ok' | 'error'): void;
}

const Q_OPTIONS: Array<[Measurement['quantity'], string]> = [['V', 'напряжение, В'], ['A', 'ток, А'], ['Ω', 'сопротивление, Ом'], ['other', 'другое']];

export function JournalPanel(p: Props) {
  const { doc } = p;
  const dialogs = useDialogs();
  const [selId, setSelId] = useState<string | null>(doc.tests[doc.tests.length - 1]?.id ?? null);
  const rec = doc.tests.find((t) => t.id === selId) ?? null;
  useEffect(() => { if (!rec && doc.tests.length) setSelId(doc.tests[doc.tests.length - 1]!.id); }, [rec, doc.tests]);

  const create = async () => {
    const title = await dialogs.prompt('Новое испытание', 'Что проверяем (например, «Первое включение»)', `Испытание ${doc.tests.length + 1}`, 'Создать');
    if (!title) return;
    try {
      // Снимок ревизии: с ним сравнивается расчёт, его можно сравнить с текущей и восстановить.
      const cp = await unwrap(api().checkpoints.create(doc, `Испытание: ${title}`, 'test'));
      const r = newRecord(doc, title, cp.id);
      p.onEdit('Новое испытание', (d) => addRecord(d, { ...r, revision: d.revision }));
      setSelId(r.id);
      await p.onCheckpointsChanged();
    } catch (e) {
      await dialogs.alert('Запись не создана', errorText(e));
    }
  };

  return (
    <div className="journal-tab">
      <aside className="journal-list" aria-label="Испытания">
        <button className="btn primary" onClick={() => void create()}>Новое испытание</button>
        {doc.tests.length === 0 && <p className="muted small">Записей пока нет. Испытание фиксирует ревизию схемы и платы, измерения на реальной плате, отказы и замены деталей, фото.</p>}
        <ul>
          {[...doc.tests].reverse().map((t) => {
            const s = recordSummary(t);
            return (
              <li key={t.id}>
                <button className={`journal-item ${t.id === selId ? 'on' : ''}`} onClick={() => setSelId(t.id)}>
                  <strong>{t.title}</strong>
                  <span className="muted small">{fmtDay(t.date)} · ревизия {t.revision}</span>
                  <span className="small">
                    {s.match > 0 && <span className="tag ok">совпало {s.match}</span>}
                    {s.mismatch > 0 && <span className="tag bad">расхождений {s.mismatch}</span>}
                    {t.events.length > 0 && <span className="tag warn">отказы/замены {t.events.length}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="journal-main">
        {rec ? <RecordView key={rec.id} {...p} rec={rec} onDeleted={() => setSelId(null)} /> : <p className="muted">Выберите запись или создайте новую.</p>}
      </main>
    </div>
  );
}

function RecordView(p: Props & { rec: TestRecord; onDeleted(): void }) {
  const { doc, rec } = p;
  const dialogs = useDialogs();
  const upd = (label: string, patch: Partial<TestRecord>, key?: string) => p.onEdit(label, (d) => updateRecord(d, rec.id, patch), key);
  const cp = rec.checkpointId ? p.checkpoints.find((c) => c.id === rec.checkpointId) ?? null : null;
  const [revDoc, setRevDoc] = useState<{ doc: ProjectDoc | null; error: string | null }>({ doc: null, error: null });
  // Сравнение пересчитывается при каждой правке — показывает отличия от текущего состояния, а не от момента щелчка.
  const [showDiff, setShowDiff] = useState(false);
  const diff: DiffItem[] | null = useMemo(() => (showDiff && revDoc.doc ? diffDocs(revDoc.doc, doc) : null), [showDiff, revDoc.doc, doc]);
  const [busy, setBusy] = useState(false);
  const [calcMsg, setCalcMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!rec.checkpointId) { setRevDoc({ doc: null, error: 'Снимок ревизии не сохранён (запись создана старой версией программы) — сравнение ведётся с текущей схемой.' }); return; }
    api().checkpoints.get(doc.id, rec.checkpointId).then((r) => {
      if (!alive) return;
      setRevDoc(r.ok ? { doc: r.value, error: null } : { doc: null, error: `Снимок ревизии недоступен: ${r.error.message}` });
    }).catch((e) => alive && setRevDoc({ doc: null, error: errorText(e) }));
    return () => { alive = false; };
  }, [doc.id, rec.checkpointId]);
  const base = revDoc.doc ?? doc;

  const calc = async () => {
    setBusy(true); setCalcMsg(null);
    try {
      const out = await unwrap(api().sim.expected(base, rec));
      const at = new Date().toISOString();
      p.onEdit('Расчётные значения', (d) => setMeasurements(d, rec.id, (ms) => ms.map((m) => {
        const v = out.values.find((x) => x.measurementId === m.id);
        if (!v) return m;
        return { ...m, expected: v.value === null ? null : { value: v.value, band: v.band, method: v.method, revision: rec.revision, at } };
      })));
      const skipped = out.values.filter((v) => v.value === null);
      setCalcMsg(out.message ?? `Рассчитано (ngspice, запусков: ${out.runs})${skipped.length ? `; не рассчитано: ${skipped.length} — ${skipped.map((s) => s.reason).join('; ')}` : ''}.`);
    } catch (e) {
      setCalcMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const addPhotos = async () => {
    try {
      const refs = await unwrap(api().attachments.add(doc.id));
      if (!refs) return;
      p.onEdit('Фото к испытанию', (d) => refs.reduce((acc, r) => attachPhoto(acc, rec.id, r), d));
    } catch (e) {
      await dialogs.alert('Фото не добавлено', errorText(e));
    }
  };

  const restore = async () => {
    if (!cp) return;
    await p.onRestore(cp);
  };

  const mismatches = rec.measurements.filter((m) => compare(m).status === 'mismatch');

  return (
    <div className="record" aria-label={`Испытание «${rec.title}»`}>
      <div className="row wrap record-head">
        <label className="field grow"><span>Название</span>
          <input aria-label="Название испытания" defaultValue={rec.title} key={`t${rec.title}`} onBlur={(e) => upd('Название испытания', { title: e.target.value.trim() || 'Испытание' })} />
        </label>
        <label className="field"><span>Дата</span>
          <input type="date" aria-label="Дата испытания" value={rec.date.slice(0, 10)} onChange={(e) => e.target.value && upd('Дата испытания', { date: `${e.target.value}T12:00:00.000Z` })} />
        </label>
        <button className="btn danger small" onClick={async () => {
          if (await dialogs.confirm('Удалить запись', `Удалить запись «${rec.title}» из журнала? Отменить можно Ctrl+Z.`, 'Удалить', true)) { p.onEdit('Удаление записи журнала', (d) => deleteRecord(d, rec.id)); p.onDeleted(); }
        }}>Удалить запись</button>
      </div>

      <section className="record-rev" data-testid="record-revision">
        <h3>Ревизия</h3>
        <p>Ревизия проекта {rec.revision}{cp ? `, снимок «${cp.label}» от ${fmtDateTime(cp.createdAt)}` : ''}. Сейчас — ревизия {doc.revision}.</p>
        {revDoc.error && <p className="muted small">{revDoc.error}</p>}
        <div className="row wrap">
          <button className="btn" disabled={!revDoc.doc} onClick={() => setShowDiff(true)}>Сравнить с текущей</button>
          <button className="btn" disabled={!cp} onClick={() => void restore()}>Восстановить эту ревизию</button>
        </div>
        {diff && (
          <div className="diff" data-testid="revision-diff">
            {diff.length === 0 ? <p className="muted">Схема, детали и плата не изменились.</p> : (
              <ul>{diff.map((d, i) => <li key={i}><span className="muted small">{d.section}:</span> {d.text}</li>)}</ul>
            )}
            <p className="muted small">«Восстановить» вернёт схему, детали и плату этой ревизии; журнал испытаний и фото останутся. Текущее состояние сохранится как контрольная версия, возврат отменяется Ctrl+Z. После возврата синхронизируйте плату.</p>
          </div>
        )}
      </section>

      <section>
        <h3>Условия</h3>
        <div className="row wrap">
          <label className="field"><span>Напряжение питания (измерено)</span>
            <input aria-label="Напряжение питания" key={`s${rec.supplyV}`} defaultValue={rec.supplyV === null ? '' : formatQuantity(rec.supplyV, 'В', 4)} placeholder="например, 11,8 В"
              onBlur={(e) => { const t = e.target.value.trim(); if (!t) upd('Напряжение питания', { supplyV: null }); else { const v = parseQuantity(t, 'В'); if (v !== null) upd('Напряжение питания', { supplyV: v }); else e.target.value = rec.supplyV === null ? '' : formatQuantity(rec.supplyV, 'В', 4); } }} />
          </label>
          <label className="field grow"><span>Приборы</span>
            <input aria-label="Приборы" defaultValue={rec.instruments} key={`i${rec.instruments}`} onBlur={(e) => upd('Приборы', { instruments: e.target.value })} placeholder="мультиметр DT-830, лабораторный БП" />
          </label>
        </div>
        <label className="field"><span>Условия</span>
          <textarea aria-label="Условия испытания" rows={2} defaultValue={rec.conditions} key={`c${rec.id}`} onChange={(e) => upd('Условия испытания', { conditions: e.target.value }, `cond:${rec.id}`)} placeholder="нагрузка, температура, что подключено" />
        </label>
      </section>

      <section>
        <h3>Измерения</h3>
        <MeasureTable doc={doc} rec={rec} onEdit={p.onEdit} />
        <div className="row wrap">
          <button className="btn primary" disabled={busy || rec.measurements.length === 0} onClick={() => void calc()}>{busy ? 'Расчёт…' : 'Рассчитать ожидаемые значения'}</button>
        </div>
        {calcMsg && <p className="small" data-testid="calc-status">{calcMsg}</p>}
        <p className="muted small">Ожидаемое значение — расчёт ngspice для ревизии этого испытания (при измеренном питании, если оно указано и источник один). Совпадение: |измерено − расчёт| ≤ разброс из-за допусков деталей + погрешность прибора.</p>
        {mismatches.length > 0 && (
          <div className="hypotheses" data-testid="hypotheses">
            <h4>Расхождения: что проверить</h4>
            <p className="muted small">Это гипотезы по данным записи и схемы, а не диагноз.</p>
            {mismatches.map((m) => (
              <div key={m.id}>
                <strong>{m.label}</strong>: {compare(m).text}
                <ul>{hypotheses(base, rec, m).map((h, i) => <li key={i}>{h}</li>)}</ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>Отказы и замены деталей</h3>
        <EventsEditor doc={doc} rec={rec} onEdit={p.onEdit} />
      </section>

      <section>
        <h3>Фото и примечания</h3>
        <Photos doc={doc} rec={rec} onRemove={(id) => p.onEdit('Удаление фото', (d) => detachPhoto(d, rec.id, id))} />
        <button className="btn" onClick={() => void addPhotos()}>Добавить фото…</button>
        <label className="field"><span>Примечания</span>
          <textarea aria-label="Примечания" rows={4} defaultValue={rec.notes} key={`n${rec.id}`} onChange={(e) => upd('Примечания', { notes: e.target.value }, `notes:${rec.id}`)} />
        </label>
      </section>

      <ClientReport doc={doc} rec={rec} toast={p.toast} />
    </div>
  );
}

/** Акт проверки для клиента: PDF или печать. Мастерская запоминается на этом ПК. */
function ClientReport({ doc, rec, toast }: { doc: ProjectDoc; rec: TestRecord; toast(text: string, kind?: 'ok' | 'error'): void }) {
  const read = () => { try { return localStorage.getItem('elab.workshop') ?? ''; } catch { return ''; } };
  const [workshop, setWorkshop] = useState(read);
  const [client, setClient] = useState('');
  const sheet = () => testReportSvg(doc, rec, { workshop, client });
  const v = verdictText(rec);
  const run = async (kind: 'pdf' | 'print') => {
    try {
      const a = sheet();
      if (kind === 'pdf') { const r = await unwrap(api().files.savePdf(a.title, a.svg, a.widthMm, a.heightMm)); if (r) toast(`Сохранено: ${r.path}`); }
      else { const r = await unwrap(api().files.print(a.svg, a.widthMm, a.heightMm)); if (!r.printed && r.reason) toast(`Печать не выполнена: ${r.reason}`, 'error'); }
    } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <section aria-label="Акт для клиента">
      <h3>Акт для клиента</h3>
      <div className="row wrap">
        <label className="field grow"><span>Мастерская / мастер</span>
          <input aria-label="Мастерская" value={workshop} placeholder="например: Ремонт техники, Константин, тел. …"
            onChange={(e) => { setWorkshop(e.target.value); try { localStorage.setItem('elab.workshop', e.target.value); } catch { /* без памяти */ } }} />
        </label>
        <label className="field grow"><span>Клиент, устройство</span>
          <input aria-label="Клиент и устройство" value={client} placeholder="ФИО, модель, серийный номер" onChange={(e) => setClient(e.target.value)} />
        </label>
      </div>
      <p className={`small ${v.ok === true ? 'ok-text' : v.ok === false ? 'warning-text' : 'muted'}`} data-testid="report-verdict">Вывод в акте: {v.text}</p>
      <div className="row wrap">
        <button className="btn" onClick={() => void run('pdf')}>Акт: PDF…</button>
        <button className="btn" onClick={() => void run('print')}>Акт: печать</button>
      </div>
      <p className="muted small">В акте: условия, измерения с расчётом и допуском, заменённые детали, примечания и вывод — только по сравнению замеров с расчётом. Фото в акт не входят.</p>
    </section>
  );
}

function targetOptions(doc: ProjectDoc): Array<{ key: string; label: string; target: MeasureTarget }> {
  const nets = doc.schematic.nets.filter((n) => n.connections.length > 0).map((n) => ({ key: `net:${n.id}`, label: `Узел ${netDisplayName(doc, n)}`, target: { kind: 'net' as const, netId: n.id } }));
  const parts = doc.schematic.instances
    .filter((i) => doc.library.parts.find((x) => x.id === i.partId)?.category !== 'reference')
    .sort((a, b) => a.refDes.localeCompare(b.refDes, 'ru', { numeric: true }))
    .map((i) => ({ key: `part:${i.id}`, label: `Деталь ${i.refDes}`, target: { kind: 'part' as const, instanceId: i.id, pin: null } }));
  return [...nets, ...parts, { key: 'text', label: 'Другая точка (описать словами)', target: { kind: 'text' } }];
}

function MeasureTable({ doc, rec, onEdit }: { doc: ProjectDoc; rec: TestRecord; onEdit: Props['onEdit'] }) {
  const options = useMemo(() => targetOptions(doc), [doc]);
  const [tKey, setTKey] = useState(options[0]?.key ?? 'text');
  const [quantity, setQuantity] = useState<Measurement['quantity']>('V');
  const [textLabel, setTextLabel] = useState('');
  const set = (label: string, id: string, patch: Partial<Measurement>, key?: string) =>
    onEdit(label, (d) => setMeasurements(d, rec.id, (ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m))), key);
  const add = () => {
    const opt = options.find((o) => o.key === tKey);
    if (!opt) return;
    const q = opt.target.kind === 'text' ? 'other' : opt.target.kind === 'net' && quantity !== 'V' ? 'V' : quantity;
    const m = newMeasurement(doc, opt.target, q, opt.target.kind === 'text' ? textLabel.trim() || 'точка' : undefined);
    onEdit('Новое измерение', (d) => setMeasurements(d, rec.id, (ms) => [...ms, m]));
  };
  return (
    <>
      <table className="op-table measure-table" aria-label="Измерения">
        <thead><tr><th>Точка</th><th>Величина</th><th>Измерено</th><th>Прибор</th><th>Погрешность, %</th><th>Расчёт</th><th>Итог</th><th /></tr></thead>
        <tbody>
          {rec.measurements.map((m) => {
            const v = compare(m);
            const u = m.quantity === 'other' ? m.unit : quantityUnit(m.quantity);
            return (
              <tr key={m.id} data-testid={`m-${m.label}`}>
                <td>{m.label}</td>
                <td>{m.quantity === 'other' ? 'другое' : m.quantity}</td>
                <td><input aria-label={`Измерено ${m.label}`} className="num" key={`v${m.measured}`} defaultValue={m.measured === null ? '' : formatQuantity(m.measured, u, 4)}
                  onBlur={(e) => {
                    const t = e.target.value.trim();
                    if (!t) { set('Измерение', m.id, { measured: null }); return; }
                    const val = parseQuantity(t, u);
                    if (val !== null) set('Измерение', m.id, { measured: val }); else e.target.value = m.measured === null ? '' : formatQuantity(m.measured, u, 4);
                  }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></td>
                <td><input aria-label={`Прибор ${m.label}`} defaultValue={m.instrument} onBlur={(e) => set('Прибор', m.id, { instrument: e.target.value })} /></td>
                <td><input aria-label={`Погрешность ${m.label}`} className="num small-num" defaultValue={String(m.accuracyPct).replace('.', ',')}
                  onBlur={(e) => { const x = Number(e.target.value.replace(',', '.')); if (x >= 0 && x <= 50) set('Погрешность прибора', m.id, { accuracyPct: x }); }} /></td>
                <td title={m.expected?.method ?? ''}>{m.expected ? `${formatQuantity(m.expected.value, u, 4)} ± ${formatQuantity(m.expected.band, u, 2)}` : '—'}</td>
                <td className={`verdict ${v.status}`} data-testid="verdict">{v.status === 'match' ? '✓ ' : v.status === 'mismatch' ? '✗ ' : ''}{v.text}</td>
                <td><button className="btn small" aria-label={`Удалить измерение ${m.label}`} onClick={() => onEdit('Удаление измерения', (d) => setMeasurements(d, rec.id, (ms) => ms.filter((x) => x.id !== m.id)))}>×</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row wrap add-measure">
        <select aria-label="Точка измерения" value={tKey} onChange={(e) => setTKey(e.target.value)}>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {tKey === 'text'
          ? <input aria-label="Описание точки" value={textLabel} onChange={(e) => setTextLabel(e.target.value)} placeholder="например, «вывод 3 микросхемы»" />
          : (
            <select aria-label="Величина" value={tKey.startsWith('net:') ? 'V' : quantity} disabled={tKey.startsWith('net:')} onChange={(e) => setQuantity(e.target.value as Measurement['quantity'])}>
              {Q_OPTIONS.filter(([q]) => q !== 'other').map(([q, l]) => <option key={q} value={q}>{l}</option>)}
            </select>
          )}
        <button className="btn" onClick={add}>Добавить измерение</button>
      </div>
      <p className="muted small">Узел — напряжение относительно земли схемы. Деталь: напряжение между выводами 1 и 2, ток через деталь, сопротивление — выпаянной детали (сравнивается с номиналом и допуском).</p>
    </>
  );
}

function EventsEditor({ doc, rec, onEdit }: { doc: ProjectDoc; rec: TestRecord; onEdit: Props['onEdit'] }) {
  const parts = doc.schematic.instances.filter((i) => doc.library.parts.find((x) => x.id === i.partId)?.category !== 'reference')
    .sort((a, b) => a.refDes.localeCompare(b.refDes, 'ru', { numeric: true }));
  const [inst, setInst] = useState(parts[0]?.id ?? '');
  const [kind, setKind] = useState<TestRecord['events'][number]['kind']>('burned');
  const set = (label: string, id: string, patch: Partial<TestRecord['events'][number]>, key?: string) =>
    onEdit(label, (d) => setEvents(d, rec.id, (es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e))), key);
  return (
    <>
      {rec.events.length === 0 && <p className="muted small">Не отмечено.</p>}
      <ul className="events">
        {rec.events.map((e) => (
          <li key={e.id} data-testid={`event-${e.refDes}`}>
            <strong>{e.refDes}</strong>
            <select aria-label={`Что с ${e.refDes}`} value={e.kind} onChange={(x) => set('Событие детали', e.id, { kind: x.target.value as typeof e.kind })}>
              {EVENT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input aria-label={`Замена ${e.refDes}`} defaultValue={e.replacement} placeholder="чем заменена" onBlur={(x) => set('Замена детали', e.id, { replacement: x.target.value })} />
            <textarea aria-label={`Обстоятельства ${e.refDes}`} rows={2} defaultValue={e.circumstances} placeholder="что делали, признаки: нагрев, запах, щелчок" onChange={(x) => set('Обстоятельства', e.id, { circumstances: x.target.value }, `ev:${e.id}`)} />
            <button className="btn small" aria-label={`Удалить событие ${e.refDes}`} onClick={() => onEdit('Удаление события', (d) => setEvents(d, rec.id, (es) => es.filter((x) => x.id !== e.id)))}>×</button>
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <select aria-label="Деталь" value={inst} onChange={(e) => setInst(e.target.value)}>
          {parts.map((i) => <option key={i.id} value={i.id}>{i.refDes}</option>)}
        </select>
        <select aria-label="Событие" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {EVENT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn" disabled={!inst} onClick={() => onEdit('Отказ/замена детали', (d) => setEvents(d, rec.id, (es) => [...es, newEvent(d, inst, kind)]))}>Отметить</button>
      </div>
      <p className="muted small">Отметка относится к этому испытанию. Номинал, модель или схему меняйте на вкладке «Схема» — это отдельная правка с историей; общий каталог из-за одного наблюдения не меняется.</p>
    </>
  );
}

function Photos({ doc, rec, onRemove }: { doc: ProjectDoc; rec: TestRecord; onRemove(id: string): void }) {
  const [urls, setUrls] = useState<Record<string, string | { error: string }>>({});
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    for (const id of rec.photoIds) {
      if (urls[id]) continue;
      const ref = doc.attachments.find((a) => a.id === id);
      if (!ref) continue;
      api().attachments.read(doc.id, ref).then((r) => alive && setUrls((u) => ({ ...u, [id]: r.ok ? r.value : { error: r.error.message } })));
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.photoIds, doc.attachments, doc.id]);
  if (rec.photoIds.length === 0) return <p className="muted small">Фото нет.</p>;
  return (
    <div className="photos">
      {rec.photoIds.map((id) => {
        const ref = doc.attachments.find((a) => a.id === id);
        const u = urls[id];
        return (
          <figure key={id} className="photo">
            {typeof u === 'string' ? <img src={u} alt={ref?.fileName ?? 'фото'} onClick={() => setBig(u)} /> : <div className="photo-missing">{u ? u.error : 'загрузка…'}</div>}
            <figcaption className="small">{ref?.fileName}<button className="btn small" aria-label={`Убрать фото ${ref?.fileName}`} onClick={() => onRemove(id)}>×</button></figcaption>
          </figure>
        );
      })}
      {big && <div className="photo-modal" role="dialog" aria-label="Фото" onClick={() => setBig(null)}><img src={big} alt="фото" /></div>}
    </div>
  );
}
