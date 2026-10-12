/**
 * Редактор детали/микросхемы: основное, номинал и пределы, выводы, корпуса с соответствием
 * «вывод ↔ площадка», модель, источник сведений. Проверки — сразу, ошибки не дают сохранить.
 */
import { useEffect, useMemo, useState } from 'react';
import { checkModelTemplate, DEVICE_ROLES, parseUserModel, templateFromParsed } from '../core/spice';
import { CATEGORIES, lintBundle, type PartBundle } from '../core/catalog';
import { formatQuantity, PARAMS, parseQuantity, RATINGS } from '../core/library';
import { newId } from '../core/ids';
import type { PartDef, SimModel } from '../core/model';
import { FAMILIES, type GenParams } from '../core/packages';
import {
  addPackage, addPad, fitBody, IDEAL_MODELS, isIcLike, mapByNumber, newCustomPackage, removePackage, removePad, setCategory, setIcPins, setPad, setPinDescription, setPinPad, setVerified, VALUE_FOR_CATEGORY,
} from '../core/partEditor';
import type { IcPinInput } from '../core/symbols';
import { PackagePreview, SymbolPreview } from './CatalogPreviews';
import { PIN_TYPE_LABEL, PIN_TYPES } from './CatalogView';
import { fmtDateTime } from './api';

type Section = 'main' | 'pins' | 'packages' | 'model' | 'origin';
const SECTIONS: Array<[Section, string]> = [['main', 'Основное'], ['pins', 'Выводы'], ['packages', 'Корпуса'], ['model', 'Модель'], ['origin', 'Источник']];
const FIELD_SECTION: Record<string, Section> = { name: 'main', partNumber: 'main', pins: 'pins', packages: 'packages', pinmap: 'packages', model: 'model', origin: 'origin', datasheet: 'origin' };

export function PartEditor({ initial, isNew, others, builtin, onCancel, onSave, saveLabel = 'Сохранить в мой каталог', note }: {
  saveLabel?: string;
  /** Пояснение под заголовком (например, «только в этом проекте»). */
  note?: string;
  initial: PartBundle;
  isNew: boolean;
  others: PartDef[];
  builtin: PartDef[];
  onCancel(): void;
  onSave(b: PartBundle): Promise<boolean>;
}) {
  const [b, setB] = useState(initial);
  const [section, setSection] = useState<Section>('main');
  const [saving, setSaving] = useState(false);
  const lint = useMemo(() => lintBundle(b, others, builtin), [b, others, builtin]);
  const errors = lint.filter((l) => l.severity === 'error');
  const part = b.part;
  const setPart = (patch: Partial<PartDef>) => setB((x) => ({ ...x, part: { ...x.part, ...patch } }));
  const setOrigin = (patch: Partial<PartDef['origin']>) => setB((x) => ({ ...x, part: { ...x.part, origin: { ...x.part.origin, ...patch } } }));

  const save = async () => {
    setSaving(true);
    try { await onSave(b); } finally { setSaving(false); }
  };

  return (
    <main className="catalog-screen part-editor" aria-label="Редактор детали">
      <div className="catalog-head">
        <h2>{isNew ? 'Новая деталь' : 'Изменение детали'}: {part.name || 'без названия'}</h2>
        <span className="grow" />
        <button className="btn" onClick={onCancel}>Отмена</button>
        <button className="btn primary" disabled={errors.length > 0 || saving} onClick={() => void save()}
          title={errors.length ? 'Исправьте ошибки' : saveLabel}>{saveLabel}</button>
      </div>
      {note && <p className="stage-note small part-editor-note">{note}</p>}
      <div className="editor-body">
        <nav className="editor-nav" role="tablist" aria-label="Разделы">
          {SECTIONS.map(([k, l]) => {
            const n = lint.filter((x) => FIELD_SECTION[x.field] === k && x.severity === 'error').length;
            return <button key={k} role="tab" aria-selected={section === k} className={`cat ${section === k ? 'on' : ''}`} onClick={() => setSection(k)}>{l}{n ? <span className="err-count"> · ошибок: {n}</span> : null}</button>;
          })}
          <div className="editor-preview"><SymbolPreview symbol={b.symbol} height={140} /></div>
        </nav>
        <section className="editor-main">
          {section === 'main' && <MainSection b={b} setB={setB} setPart={setPart} />}
          {section === 'pins' && <PinsSection b={b} setB={setB} />}
          {section === 'packages' && <PackagesSection b={b} setB={setB} />}
          {section === 'model' && <ModelSection b={b} setB={setB} />}
          {section === 'origin' && <OriginSection b={b} setB={setB} setPart={setPart} setOrigin={setOrigin} />}
        </section>
        <aside className="editor-lint" aria-label="Проверка детали">
          <h3>Проверка</h3>
          {lint.length === 0 && <p className="issues"><span className="ok-line">Замечаний нет</span></p>}
          <ul className="issues">
            {lint.map((l, i) => (
              <li key={i} className={l.severity}>
                <button className="linklike" onClick={() => setSection(FIELD_SECTION[l.field] ?? 'main')}>{l.severity === 'error' ? 'Ошибка: ' : ''}{l.message}</button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}

type SetB = (f: (b: PartBundle) => PartBundle) => void;

function Text({ label, value, onChange, placeholder, multiline }: { label: string; value: string; onChange(v: string): void; placeholder?: string; multiline?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      {multiline
        ? <textarea aria-label={label} rows={3} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        : <input aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

/** Ввод величины с приставками («47 мк», «10к»); пустое поле — значение не задано. */
function QuantityInput({ label, unitRu, value, onChange, allowNegative }: { label: string; unitRu: string; value: number | null; onChange(v: number | null): void; allowNegative?: boolean }) {
  const shown = value === null ? '' : formatQuantity(value, unitRu, 4);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(shown); setError(null); }, [shown]);
  const commit = () => {
    if (!text.trim()) { setError(null); onChange(null); return; }
    const v = parseQuantity(text, unitRu);
    if (v === null || (!allowNegative && v < 0)) { setError('Не понял значение. Примеры: 10к, 4,7 мк, 0.25, 2.2e-6'); return; }
    setError(null);
    onChange(v);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <em className="error-text small">{error}</em>}
    </label>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number | null; onChange(v: number | null): void }) {
  const [text, setText] = useState(value === null ? '' : String(value).replace('.', ','));
  const [error, setError] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => {
        if (!text.trim()) { setError(false); onChange(null); return; }
        const v = Number(text.replace(',', '.'));
        if (!Number.isFinite(v)) { setError(true); return; }
        setError(false); onChange(v);
      }} />
      {error && <em className="error-text small">Нужно число</em>}
    </label>
  );
}

function MainSection({ b, setB, setPart }: { b: PartBundle; setB: SetB; setPart(p: Partial<PartDef>): void }) {
  const p = b.part;
  const valueKey = VALUE_FOR_CATEGORY[p.category];
  const unusedRatings = Object.keys(RATINGS).filter((k) => !p.ratings[k]);
  const setRating = (k: string, v: number | null) => {
    const r = { ...p.ratings };
    if (v === null) delete r[k]; else r[k] = { value: v, unit: RATINGS[k]!.unit };
    setPart({ ratings: r });
  };
  return (
    <div className="form-grid">
      <Text label="Название" value={p.name} onChange={(v) => setPart({ name: v })} placeholder="Например: Таймер NE555" />
      <label className="field">
        <span>Категория</span>
        <select aria-label="Категория" value={p.category} onChange={(e) => setB((x) => setCategory(x, e.target.value))}>
          {CATEGORIES.filter((c) => c.id !== 'reference').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>
      <Text label="Позиционное обозначение (префикс)" value={p.refPrefix} onChange={(v) => setPart({ refPrefix: v.toUpperCase().replace(/[^A-ZА-ЯЁ]/g, '').slice(0, 4) || p.refPrefix })} />
      <Text label="Партномер" value={p.partNumber ?? ''} onChange={(v) => setPart({ partNumber: v.trim() ? v : null })} placeholder="Например: NE555P" />
      <Text label="Производитель" value={p.manufacturer ?? ''} onChange={(v) => setPart({ manufacturer: v.trim() ? v : null })} />
      <Text label="Маркировка на корпусе" value={p.marking ?? ''} onChange={(v) => setPart({ marking: v.trim() ? v : null })} />
      <div className="span2"><Text label="Назначение" value={p.description} onChange={(v) => setPart({ description: v })} multiline /></div>

      <h4 className="span2">Номинал и пределы</h4>
      {valueKey && PARAMS[valueKey] && (
        <QuantityInput label={`${PARAMS[valueKey]!.label}, ${PARAMS[valueKey]!.unitRu}`} unitRu={PARAMS[valueKey]!.unitRu} value={p.values[valueKey]?.value ?? null}
          onChange={(v) => setPart({ values: v === null ? {} : { [valueKey]: { value: v, unit: PARAMS[valueKey]!.unit } } })} />
      )}
      <NumberInput label="Допуск, ±%" value={p.tolerancePct} onChange={(v) => setPart({ tolerancePct: v === null ? null : Math.abs(v) })} />
      {Object.keys(p.ratings).map((k) => (
        <div key={k} className="rating-row">
          <QuantityInput label={`${RATINGS[k]?.label ?? k}, ${RATINGS[k]?.unitRu ?? ''}`} unitRu={RATINGS[k]?.unitRu ?? ''} value={p.ratings[k]!.value} onChange={(v) => setRating(k, v)} />
          <button className="btn small" aria-label={`Убрать: ${RATINGS[k]?.label ?? k}`} onClick={() => setRating(k, null)}>×</button>
        </div>
      ))}
      {unusedRatings.length > 0 && (
        <label className="field">
          <span>Добавить предельный параметр</span>
          <select aria-label="Добавить предельный параметр" value="" onChange={(e) => { if (e.target.value) setRating(e.target.value, 0); }}>
            <option value="">— выберите —</option>
            {unusedRatings.map((k) => <option key={k} value={k}>{RATINGS[k]!.label}</option>)}
          </select>
        </label>
      )}
      <NumberInput label="Температура, мин., °C" value={p.temperature?.minC ?? null} onChange={(v) => setPart({ temperature: v === null ? null : { minC: v, maxC: p.temperature?.maxC ?? 85 } })} />
      <NumberInput label="Температура, макс., °C" value={p.temperature?.maxC ?? null} onChange={(v) => setPart({ temperature: v === null ? null : { minC: p.temperature?.minC ?? -40, maxC: v } })} />
      <label className="check span2"><input type="checkbox" checked={p.polarized} onChange={(e) => setPart({ polarized: e.target.checked })} /> Полярная деталь (важна ориентация при установке)</label>
    </div>
  );
}

function PinsSection({ b, setB }: { b: PartBundle; setB: SetB }) {
  const ic = isIcLike(b.part.category);
  const rows: IcPinInput[] = b.symbol.pins.map((p) => ({ number: p.number, name: p.name, electricalType: p.electricalType, description: p.description }));
  const update = (i: number, patch: Partial<IcPinInput>) => setB((x) => setIcPins(x, rows.map((r, j) => (j === i ? { ...r, ...patch } : r))));
  const nextNumber = () => { let n = rows.length + 1; while (rows.some((r) => r.number === String(n))) n++; return String(n); };
  if (!ic) {
    return (
      <div>
        <p className="muted small">Условное обозначение стандартное для категории; номера выводов совпадают с номерами в таблице соответствия корпуса. Можно описать функцию каждого вывода.</p>
        <table className="pins-table edit">
          <thead><tr><th>№</th><th>Имя</th><th>Тип</th><th>Функция</th></tr></thead>
          <tbody>
            {b.symbol.pins.map((p) => (
              <tr key={p.number}>
                <td>{p.number}</td><td>{p.name}</td><td>{PIN_TYPE_LABEL[p.electricalType]}</td>
                <td><input aria-label={`Функция вывода ${p.number}`} value={p.description} onChange={(e) => setB((x) => setPinDescription(x, p.number, e.target.value))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div>
      <p className="muted small">Выводы микросхемы по даташиту. Обозначение строится само: входы слева, выходы справа, питание сверху, земля снизу. Описание выводов не создаёт модель для расчёта.</p>
      <table className="pins-table edit" aria-label="Выводы микросхемы">
        <thead><tr><th>№</th><th>Имя</th><th>Тип</th><th>Функция</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input className="narrow" aria-label={`Номер вывода, строка ${i + 1}`} value={r.number} onChange={(e) => update(i, { number: e.target.value.trim().slice(0, 16) })} /></td>
              <td><input aria-label={`Имя вывода ${r.number}`} value={r.name} onChange={(e) => update(i, { name: e.target.value.slice(0, 32) })} /></td>
              <td>
                <select aria-label={`Тип вывода ${r.number}`} value={r.electricalType} onChange={(e) => update(i, { electricalType: e.target.value as IcPinInput['electricalType'] })}>
                  {PIN_TYPES.map((t) => <option key={t} value={t}>{PIN_TYPE_LABEL[t]}</option>)}
                </select>
              </td>
              <td><input aria-label={`Функция вывода ${r.number}`} value={r.description ?? ''} onChange={(e) => update(i, { description: e.target.value })} /></td>
              <td><button className="btn small" aria-label={`Удалить вывод ${r.number}`} onClick={() => setB((x) => setIcPins(x, rows.filter((_, j) => j !== i)))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn" onClick={() => setB((x) => setIcPins(x, [...rows, { number: nextNumber(), name: '', electricalType: 'passive' }]))}>Добавить вывод</button>
    </div>
  );
}

const numRu = (v: number) => String(Number(v.toFixed(3))).replace('.', ',');

/** Таблица площадок корпуса: номер, координаты, форма, размеры, отверстие (пусто — SMD). */
function PadsEditor({ pkg, b, setB }: { pkg: PartBundle['packages'][number]; b: PartBundle; setB: SetB }) {
  const [error, setError] = useState<string | null>(null);
  const commit = (i: number, patch: Parameters<typeof setPad>[3]) => {
    const r = setPad(b, pkg.id, i, patch);
    setError(r.error);
    if (!r.error) setB(() => r.b);
  };
  const num = (i: number, key: 'x' | 'y' | 'w' | 'h', label: string) => (
    <td><input aria-label={`${label} площадки ${pkg.pads[i]!.number}`} key={`${key}${pkg.pads[i]![key]}`} defaultValue={numRu(pkg.pads[i]![key])} className="num"
      onBlur={(e) => { const v = Number(e.target.value.replace(',', '.')); if (!Number.isFinite(v)) { e.target.value = numRu(pkg.pads[i]![key]); return; } if (v !== pkg.pads[i]![key]) commit(i, { [key]: v }); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></td>
  );
  return (
    <details className="pads-editor">
      <summary>Площадки по координатам ({pkg.pads.length})</summary>
      <table className="pins-table edit" aria-label={`Площадки, ${pkg.name}`}>
        <thead><tr><th>№</th><th>X, мм</th><th>Y, мм</th><th>Форма</th><th>Ширина</th><th>Высота</th><th>Отверстие</th><th /></tr></thead>
        <tbody>
          {pkg.pads.map((pad, i) => (
            <tr key={`${i}`}>
              <td><input aria-label={`Номер площадки ${i + 1}`} key={pad.number} defaultValue={pad.number} className="num"
                onBlur={(e) => { if (e.target.value.trim() !== pad.number) commit(i, { number: e.target.value }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></td>
              {num(i, 'x', 'X')}{num(i, 'y', 'Y')}
              <td><select aria-label={`Форма площадки ${pad.number}`} value={pad.shape} onChange={(e) => commit(i, { shape: e.target.value as typeof pad.shape })}>
                <option value="round">круг</option><option value="rect">квадрат</option><option value="oval">овал</option></select></td>
              {num(i, 'w', 'Ширина')}{num(i, 'h', 'Высота')}
              <td><input aria-label={`Отверстие площадки ${pad.number}`} key={`d${pad.drill}`} defaultValue={pad.drill === null ? '' : numRu(pad.drill)} placeholder="SMD" className="num"
                onBlur={(e) => { const t = e.target.value.trim(); const v = t === '' ? null : Number(t.replace(',', '.')); if (v !== null && !Number.isFinite(v)) { e.target.value = pad.drill === null ? '' : numRu(pad.drill); return; } if (v !== pad.drill) commit(i, { drill: v }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></td>
              <td><button className="btn small danger" aria-label={`Убрать площадку ${pad.number}`} onClick={() => { setError(null); setB((x) => removePad(x, pkg.id, i)); }}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="error-text small" role="alert">{error}</p>}
      <div className="row wrap">
        <button className="btn small" onClick={() => setB((x) => addPad(x, pkg.id))}>Добавить площадку</button>
        <button className="btn small" onClick={() => setB((x) => fitBody(x, pkg.id))}>Контур корпуса по площадкам</button>
      </div>
      <p className="muted small">Вид сверху, мм; начало координат — любая точка (обычно вывод 1). Площадки с одинаковым номером соединены внутри корпуса.</p>
    </details>
  );
}

function PackagesSection({ b, setB }: { b: PartBundle; setB: SetB }) {
  const [family, setFamily] = useState(FAMILIES[0]!.id);
  const fam = FAMILIES.find((f) => f.id === family)!;
  const [params, setParams] = useState<GenParams>({});
  const [genError, setGenError] = useState<string | null>(null);
  const [hl, setHl] = useState<{ pkg: string; pad: string } | null>(null);
  useEffect(() => {
    // Число выводов по умолчанию — как у символа (если семейство это допускает).
    const pinsDef = fam.params.find((p) => p.key === 'pins' || p.key === 'n');
    setParams(pinsDef ? { [pinsDef.key]: b.symbol.pins.length } : {});
    setGenError(null);
  }, [family]); // eslint-disable-line react-hooks/exhaustive-deps

  const tryAdd = () => {
    let next: PartBundle;
    try { next = addPackage(b, family, params); } catch (e) { setGenError(e instanceof Error ? e.message : String(e)); return; }
    setGenError(null);
    setB(() => next);
  };

  return (
    <div>
      <p className="muted small">У одного партномера может быть несколько корпусов. Для каждого корпуса задаётся, какой вывод обозначения на какую площадку попадает. Размеры площадок — типовые: перед изготовлением платы сверьте их с даташитом.</p>
      {b.packages.map((pkg) => {
        const ref = b.part.packages.find((x) => x.packageId === pkg.id);
        const map = ref?.pinMap ?? [];
        return (
          <div key={pkg.id} className="pkg-block" data-package={pkg.name}>
            <div className="pkg-block-head">
              <input aria-label="Название корпуса" className="pkg-name" value={pkg.name}
                onChange={(e) => setB((x) => ({ ...x, packages: x.packages.map((p) => (p.id === pkg.id ? { ...p, name: e.target.value.slice(0, 64) } : p)) }))} />
              <span className="muted small">{pkg.mount === 'SMD' ? 'SMD' : 'выводной'} · площадок: {pkg.pads.length}{pkg.pitchMm ? ` · шаг ${String(pkg.pitchMm).replace('.', ',')} мм` : ''}</span>
              <span className="grow" />
              <button className="btn small" onClick={() => setB((x) => mapByNumber(x, undefined, pkg.id))}>Сопоставить по номерам</button>
              <button className="btn small danger" onClick={() => setB((x) => removePackage(x, pkg.id))}>Убрать корпус</button>
            </div>
            <div className="pkg-block-body">
              <div>
                <PackagePreview pkg={pkg} highlight={hl?.pkg === pkg.id ? hl.pad : null} />
                <label className="field">
                  <span>Ключ первого вывода</span>
                  <input aria-label={`Ключ первого вывода ${pkg.name}`} value={pkg.pin1Marker ?? ''} placeholder="Например: выемка, точка у вывода 1"
                    onChange={(e) => setB((x) => ({ ...x, packages: x.packages.map((p) => (p.id === pkg.id ? { ...p, pin1Marker: e.target.value ? e.target.value.slice(0, 200) : null } : p)) }))} />
                </label>
              </div>
              <table className="pins-table edit" aria-label={`Соответствие выводов, ${pkg.name}`}>
                <thead><tr><th>Вывод</th><th>Площадка</th></tr></thead>
                <tbody>
                  {[...b.symbol.pins].sort((x, y) => x.number.localeCompare(y.number, 'ru', { numeric: true })).map((pin) => {
                    const pad = map.find((m) => m.symbolPin === pin.number)?.pad ?? '';
                    return (
                      <tr key={pin.number} onMouseEnter={() => pad && setHl({ pkg: pkg.id, pad })} onMouseLeave={() => setHl(null)}>
                        <td>{pin.number}{pin.name && pin.name !== pin.number ? ` ${pin.name}` : ''}</td>
                        <td>
                          <select aria-label={`Площадка для вывода ${pin.number}, ${pkg.name}`} value={pad}
                            onChange={(e) => setB((x) => setPinPad(x, pkg.id, pin.number, e.target.value || null))}>
                            <option value="">— не назначен —</option>
                            {pkg.pads.map((p) => {
                              const owner = map.find((m) => m.pad === p.number && m.symbolPin !== pin.number);
                              return <option key={p.number} value={p.number}>{p.number}{owner ? ` (сейчас у вывода ${owner.symbolPin})` : ''}</option>;
                            })}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PadsEditor pkg={pkg} b={b} setB={setB} />
          </div>
        );
      })}
      <div className="pkg-add">
        <h4>Добавить корпус</h4>
        <div className="form-grid">
          <label className="field">
            <span>Семейство</span>
            <select aria-label="Семейство корпуса" value={family} onChange={(e) => setFamily(e.target.value)}>
              {FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          {fam.params.map((d) => (
            <label key={d.key} className="field">
              <span>{d.label}</span>
              {d.kind === 'choice' ? (
                <select aria-label={d.label} value={String(params[d.key] ?? d.def)} onChange={(e) => setParams((p) => ({ ...p, [d.key]: e.target.value }))}>
                  {d.choices!.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : d.kind === 'bool' ? (
                <input type="checkbox" aria-label={d.label} checked={Boolean(params[d.key] ?? d.def)} onChange={(e) => setParams((p) => ({ ...p, [d.key]: e.target.checked }))} />
              ) : (
                <input aria-label={d.label} value={String(params[d.key] ?? d.def).replace('.', ',')}
                  onChange={(e) => { const v = Number(e.target.value.replace(',', '.')); setParams((p) => ({ ...p, [d.key]: e.target.value.trim() === '' || !Number.isFinite(v) ? NaN : v })); }} />
              )}
            </label>
          ))}
        </div>
        {genError && <p className="error-text small">{genError}</p>}
        <div className="row wrap">
          <button className="btn" onClick={tryAdd}>Добавить корпус</button>
          <button className="btn" onClick={() => setB((x) => newCustomPackage(x))}>Свой корпус (площадки по координатам)</button>
        </div>
        <p className="muted small">Свой корпус — для реле, трансформаторов, разъёмов и всего, чего нет среди семейств: площадки ставятся по размерам из даташита (вид сверху, мм).</p>
      </div>
    </div>
  );
}

function ModelSection({ b, setB }: { b: PartBundle; setB: SetB }) {
  const ideal = IDEAL_MODELS[b.part.category];
  const hasIdeal = Boolean(b.model && ideal && b.model.text === ideal.text && b.model.kind === ideal.kind);
  const [mode, setMode] = useState<'keep' | 'user'>('keep');
  const setModel = (m: Omit<SimModel, 'id'> | null) => setB((x) => {
    if (!m) return { ...x, model: null, part: { ...x.part, modelId: null } };
    const id = x.model?.id ?? newId();
    return { ...x, model: { ...m, id }, part: { ...x.part, modelId: id } };
  });
  return (
    <div>
      <p className="muted small">Модель для расчёта хранится отдельно от описания выводов: заполненная пиновка не делает деталь моделируемой.</p>
      <label className="check"><input type="radio" name="model" checked={!b.model && mode === 'keep'} onChange={() => { setMode('keep'); setModel(null); }} /> Нет модели — деталь не участвует в расчёте (схема с ней не рассчитывается, программа это сообщит)</label>
      {ideal && (
        <label className="check"><input type="radio" name="model" checked={hasIdeal && mode === 'keep'} onChange={() => { setMode('keep'); setModel(ideal); }} /> {ideal.name}{ideal.kind === 'spice-primitive' ? ' — без допусков, паразитных параметров и нагрева' : ''}</label>
      )}
      {b.model && !hasIdeal && (
        <label className="check"><input type="radio" name="model" checked={mode === 'keep'} onChange={() => setMode('keep')} /> Текущая модель: {b.model.name}</label>
      )}
      <label className="check"><input type="radio" name="model" checked={mode === 'user'} onChange={() => setMode('user')} /> Своя SPICE-модель из даташита (.model или .subckt)</label>
      {mode === 'user' && <UserModel b={b} onApply={(m) => { setModel(m); setMode('keep'); }} />}
      {b.model && !hasIdeal && mode === 'keep' && (
        <div className="model-box">
          <dl className="meta">
            <dt>Модель</dt><dd>{b.model.name}</dd>
            <dt>Источник</dt><dd>{b.model.source ?? '—'}</dd>
          </dl>
          <label className="check"><input type="checkbox" checked={b.model.verified} onChange={(e) => setB((x) => (x.model ? { ...x, model: { ...x.model, verified: e.target.checked } } : x))} /> Модель проверена (сравнена с даташитом или измерениями)</label>
          <details><summary>Текст модели для ngspice</summary><pre className="netlist">{b.model.text}</pre></details>
        </div>
      )}
      <p className="muted small">Поддерживаются карточки .model диодов, биполярных и полевых транзисторов (D, NPN, PNP, NMOS, PMOS, VDMOS, NJF, PJF) и подсхемы .subckt, в том числе поведенческие. Команды расчёта и подключение файлов (.include, .lib, .control) в модели запрещены. Цифровые микросхемы и прошивки не моделируются.</p>
    </div>
  );
}

/** Вставка модели из даташита и сопоставление её выводов с выводами обозначения. */
function UserModel({ b, onApply }: { b: PartBundle; onApply(m: Omit<SimModel, 'id'>): void }) {
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [map, setMap] = useState<Record<string, string>>({});
  const parsed = useMemo(() => (text.trim() ? parseUserModel(text) : null), [text]);
  const roles = parsed?.ok
    ? parsed.model.kind === 'model' ? DEVICE_ROLES[parsed.model.type].map((r) => ({ key: r.role, label: `${r.role} — ${r.label}` })) : parsed.model.ports.map((p) => ({ key: p, label: p }))
    : [];
  // Подсказка соответствия: по имени вывода обозначения (A, K, B, C, E, G, D, S, IN, OUT…), затем по номеру.
  useEffect(() => {
    if (!parsed?.ok) return;
    const next: Record<string, string> = {};
    for (const r of roles) {
      const byName = b.symbol.pins.find((p) => p.name.toUpperCase() === r.key.toUpperCase());
      const byNum = b.symbol.pins.find((p) => p.number === r.key);
      const pin = byName ?? byNum;
      if (pin) next[r.key] = pin.number;
    }
    setMap(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const tpl = parsed?.ok ? templateFromParsed(parsed.model, map) : null;
  const problems = tpl ? [...(tpl.missing.length ? [`не сопоставлены: ${tpl.missing.join(', ')}`] : []), ...checkModelTemplate(tpl.text)] : [];
  const dupPins = Object.values(map).filter((v, i, a) => v && a.indexOf(v) !== i);
  return (
    <div className="model-box">
      <label className="field">
        <span>Текст модели (вставьте из даташита или с сайта производителя)</span>
        <textarea aria-label="Текст SPICE-модели" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'.model 1N4148 D(IS=2.52n RS=0.568 N=1.752 ...)'} spellCheck={false} />
      </label>
      {parsed && !parsed.ok && <p className="error-text small">{parsed.error}</p>}
      {parsed?.ok && (
        <>
          <p className="small">{parsed.model.kind === 'model' ? `Карточка .model «${parsed.model.name}», тип ${parsed.model.type}.` : `Подсхема «${parsed.model.name}», выводов: ${parsed.model.ports.length}.`} Сопоставьте выводы модели с выводами обозначения:</p>
          <table className="pins-table edit" aria-label="Выводы модели">
            <thead><tr><th>Вывод модели</th><th>Вывод обозначения</th></tr></thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td>
                    <select aria-label={`Вывод обозначения для ${r.key}`} value={map[r.key] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [r.key]: e.target.value }))}>
                      <option value="">— не выбран —</option>
                      {b.symbol.pins.map((p) => <option key={p.number} value={p.number}>{p.number}{p.name && p.name !== p.number ? ` ${p.name}` : ''}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="field">
            <span>Источник модели</span>
            <input aria-label="Источник модели" value={source} onChange={(e) => setSource(e.target.value)} placeholder="сайт производителя, файл модели, дата" />
          </label>
          {dupPins.length > 0 && <p className="error-text small">Один вывод обозначения выбран для нескольких выводов модели: {[...new Set(dupPins)].join(', ')}</p>}
          {problems.length > 0 && <ul className="issues">{problems.map((x, i) => <li key={i} className="error">{x}</li>)}</ul>}
          <button className="btn primary" disabled={!tpl || problems.length > 0 || dupPins.length > 0}
            onClick={() => tpl && parsed.ok && onApply({
              name: `${parsed.model.name} (из даташита)`, kind: parsed.model.kind === 'subckt' ? 'spice-subckt' : 'spice-primitive',
              text: tpl.text, source: source.trim() || 'введено пользователем', verified: false,
            })}>Применить модель</button>
          <p className="muted small">Модель сохраняется с деталью и переносится вместе с проектом. Она помечается «не проверена», пока вы не отметите обратное.</p>
        </>
      )}
    </div>
  );
}

function OriginSection({ b, setB, setPart, setOrigin }: { b: PartBundle; setB: SetB; setPart(p: Partial<PartDef>): void; setOrigin(p: Partial<PartDef['origin']>): void }) {
  const o = b.part.origin;
  const [url, setUrl] = useState(b.part.datasheetUrl ?? '');
  const urlOk = !url.trim() || /^https?:\/\/\S+$/i.test(url.trim());
  return (
    <div className="form-grid">
      <label className="field span2">
        <span>Ссылка на даташит</span>
        <input aria-label="Ссылка на даташит" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)}
          onBlur={() => { if (urlOk) setPart({ datasheetUrl: url.trim() || null }); }} />
        {!urlOk && <em className="error-text small">Ссылка должна начинаться с http:// или https://</em>}
      </label>
      <Text label="Откуда сведения" value={o.source ?? ''} onChange={(v) => setOrigin({ source: v.trim() ? v : null })} placeholder="Даташит производителя, ред. …" />
      <Text label="Лицензия данных" value={o.license ?? ''} onChange={(v) => setOrigin({ license: v.trim() ? v : null })} />
      <div className="span2"><Text label="Примечания" value={o.notes} onChange={(v) => setOrigin({ notes: v })} multiline /></div>
      <label className="check span2">
        <input type="checkbox" checked={o.verified} onChange={(e) => setB((x) => setVerified(x, e.target.checked))} />
        Я сверил выводы, корпус и параметры с даташитом{o.verified && o.checkedAt ? ` (${fmtDateTime(o.checkedAt)})` : ''}
      </label>
    </div>
  );
}
