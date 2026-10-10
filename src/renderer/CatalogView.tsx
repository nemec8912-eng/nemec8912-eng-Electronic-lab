/** Экран «Каталог деталей»: поиск, фильтры, карточка детали, создание и правка своих деталей. */
import { useMemo, useState } from 'react';
import { CATEGORIES, categoryLabel, lintBundle, searchBundles, type PartBundle } from '../core/catalog';
import { formatQuantity, PARAMS, RATINGS } from '../core/library';
import type { SymbolDef } from '../core/model';
import { copyBundle, newBundle } from '../core/partEditor';
import { api, errorText, fmtDateTime, unwrap } from './api';
import { PackagePreview, SymbolPreview } from './CatalogPreviews';
import { useDialogs } from './Dialogs';
import { KicadImport } from './KicadImport';
import { PartEditor } from './PartEditor';
import type { CatalogState } from './useCatalog';

export const PIN_TYPE_LABEL: Record<string, string> = {
  input: 'Вход', output: 'Выход', bidirectional: 'Вход/выход', 'power-in': 'Питание', 'power-out': 'Выход питания',
  ground: 'Земля', passive: 'Пассивный', nc: 'Не подключён',
};
export const PIN_TYPES = Object.keys(PIN_TYPE_LABEL) as Array<SymbolDef['pins'][number]['electricalType']>;

type Source = 'all' | 'builtin' | 'personal';
type Editing = { bundle: PartBundle; isNew: boolean } | null;

export function CatalogView({ catalog, onClose, onPlace, toast }: {
  catalog: CatalogState;
  onClose(): void;
  /** Поставить деталь на схему (есть только при открытом проекте). */
  onPlace?(partId: string): void;
  toast(text: string, kind?: 'ok' | 'error'): void;
}) {
  const dialogs = useDialogs();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [importing, setImporting] = useState(false);

  const pool = source === 'builtin' ? catalog.builtin : source === 'personal' ? catalog.personal : catalog.all;
  const found = useMemo(() => searchBundles(pool, query, category), [pool, query, category]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of searchBundles(pool, query, null)) m.set(b.part.category, (m.get(b.part.category) ?? 0) + 1);
    return m;
  }, [pool, query]);
  const selected = (selectedId && catalog.byId(selectedId)) || null;

  const save = async (b: PartBundle): Promise<boolean> => {
    try {
      const saved = await unwrap(api().catalog.save(b));
      await catalog.reload();
      setEditing(null);
      setImporting(false);
      setSelectedId(saved.part.id);
      toast(`Деталь «${saved.part.name}» сохранена в мой каталог`);
      return true;
    } catch (e) {
      await dialogs.alert('Деталь не сохранена', errorText(e));
      return false;
    }
  };

  const remove = async (b: PartBundle) => {
    if (!(await dialogs.confirm('Удалить деталь', `Удалить «${b.part.name}» из моего каталога?\nПроекты, где она уже стоит, не изменятся: у них своя копия детали.`, 'Удалить', true))) return;
    try {
      await unwrap(api().catalog.remove(b.part.id));
      await catalog.reload();
      setSelectedId(null);
      toast(`Деталь «${b.part.name}» удалена из моего каталога`);
    } catch (e) {
      await dialogs.alert('Не удалось удалить', errorText(e));
    }
  };

  const newIc = async () => {
    const n = await dialogs.prompt('Новая микросхема', 'Число выводов', '8', 'Создать');
    if (!n) return;
    const pins = Number(n);
    if (!Number.isInteger(pins) || pins < 1 || pins > 256) { await dialogs.alert('Новая микросхема', 'Число выводов — целое от 1 до 256.'); return; }
    setEditing({ bundle: newBundle('ic-digital', pins), isNew: true });
  };

  if (importing && !editing) {
    return <KicadImport onCancel={() => setImporting(false)} onAccept={(b) => setEditing({ bundle: b, isNew: true })} />;
  }

  if (editing) {
    return (
      <PartEditor
        key={editing.bundle.part.id}
        initial={editing.bundle}
        isNew={editing.isNew}
        others={catalog.personal.map((b) => b.part)}
        builtin={catalog.builtin.map((b) => b.part)}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    );
  }

  return (
    <main className="catalog-screen">
      <div className="catalog-head">
        <h2>Каталог деталей</h2>
        <button className="btn" onClick={() => setEditing({ bundle: newBundle('resistor'), isNew: true })}>Новая деталь</button>
        <button className="btn" onClick={() => void newIc()}>Новая микросхема</button>
        <button className="btn" onClick={() => setImporting(true)}>Импорт из KiCad…</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>{onPlace ? '← К схеме' : '← Проекты'}</button>
      </div>
      {catalog.error && <p className="error-text catalog-error">Мой каталог не прочитан: {catalog.error}. Файл не изменён; встроенный справочник доступен.</p>}
      <div className="catalog-body">
        <aside className="catalog-filters">
          <input type="search" aria-label="Поиск деталей" placeholder="Название, партномер, номинал (10к, 47мк)…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="seg" role="radiogroup" aria-label="Источник">
            {([['all', 'Все'], ['builtin', 'Встроенные'], ['personal', 'Мои']] as const).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={source === k} className={`btn small ${source === k ? 'on' : ''}`} onClick={() => setSource(k)}>{l}</button>
            ))}
          </div>
          <ul className="cat-list" aria-label="Категории">
            <li><button className={`cat ${category === null ? 'on' : ''}`} onClick={() => setCategory(null)}>Все категории</button></li>
            {CATEGORIES.filter((c) => counts.has(c.id)).map((c) => (
              <li key={c.id}><button className={`cat ${category === c.id ? 'on' : ''}`} onClick={() => setCategory(c.id)}>{c.label} <span className="muted">{counts.get(c.id)}</span></button></li>
            ))}
          </ul>
        </aside>
        <section className="catalog-list" aria-label="Детали">
          {found.length === 0 && <p className="muted">Ничего не найдено.{source === 'personal' && catalog.personal.length === 0 ? ' В моём каталоге пока нет деталей.' : ''}</p>}
          <ul>
            {found.map((b) => (
              <li key={b.part.id}>
                <button className={`part-row ${selectedId === b.part.id ? 'on' : ''}`} onClick={() => setSelectedId(b.part.id)} data-part-id={b.part.id}>
                  <span className="part-row-name">{b.part.name}</span>
                  <span className="part-row-meta">
                    {categoryLabel(b.part.category)}{b.packages.length ? ` · ${b.packages.map((p) => p.name).join(', ')}` : ''}
                  </span>
                  <Badges b={b} personal={catalog.isPersonal(b.part.id)} />
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="catalog-card" aria-label="Карточка детали">
          {selected ? (
            <PartCard
              b={selected}
              personal={catalog.isPersonal(selected.part.id)}
              builtinParts={catalog.builtin.map((x) => x.part)}
              onPlace={onPlace ? () => onPlace(selected.part.id) : undefined}
              onCopy={() => setEditing({ bundle: copyBundle(selected), isNew: true })}
              onEdit={() => setEditing({ bundle: structuredClone(selected), isNew: false })}
              onDelete={() => void remove(selected)}
            />
          ) : <p className="muted">Выберите деталь в списке.</p>}
        </section>
      </div>
    </main>
  );
}

export function Badges({ b, personal }: { b: PartBundle; personal: boolean }) {
  return (
    <span className="badges">
      {personal && <span className="badge mine">мой</span>}
      {!b.model && <span className="badge warn">нет модели</span>}
      {!b.part.origin.verified && b.part.category !== 'reference' && <span className="badge muted-badge">не сверено</span>}
    </span>
  );
}

function PartCard({ b, personal, builtinParts, onPlace, onCopy, onEdit, onDelete }: {
  b: PartBundle; personal: boolean; builtinParts: PartBundle['part'][];
  onPlace?(): void; onCopy(): void; onEdit(): void; onDelete(): void;
}) {
  const dialogs = useDialogs();
  const [pkgIdx, setPkgIdx] = useState(0);
  const [hlPin, setHlPin] = useState<string | null>(null);
  const p = b.part;
  const pkg = b.packages[Math.min(pkgIdx, b.packages.length - 1)];
  const map = pkg ? p.packages.find((x) => x.packageId === pkg.id)?.pinMap ?? [] : [];
  const padOf = (pin: string) => map.find((m) => m.symbolPin === pin)?.pad ?? '—';
  const lint = lintBundle(b, [], personal ? builtinParts : []).filter((l) => l.field !== 'origin' && l.field !== 'model');

  const openDatasheet = async () => {
    if (!p.datasheetUrl) return;
    const go = await dialogs.confirm('Открыть даташит', `Откроется браузер (нужен интернет):\n${p.datasheetUrl}`, 'Открыть');
    if (!go) return;
    try { await unwrap(api().app.openExternal(p.datasheetUrl)); } catch (e) { await dialogs.alert('Не удалось открыть', errorText(e)); }
  };

  return (
    <div className="part-card" data-part-id={p.id}>
      <h3 className="part-title">{p.name}</h3>
      <Badges b={b} personal={personal} />
      <div className="row card-actions">
        {onPlace && <button className="btn primary" onClick={onPlace}>Поставить на схему</button>}
        {personal && <button className="btn" onClick={onEdit}>Изменить</button>}
        <button className="btn" onClick={onCopy}>Создать на основе</button>
        {personal && <button className="btn danger" onClick={onDelete}>Удалить</button>}
      </div>
      <dl className="meta">
        <dt>Категория</dt><dd>{categoryLabel(p.category)} (обозначение {p.refPrefix})</dd>
        {p.partNumber && <><dt>Партномер</dt><dd>{p.partNumber}</dd></>}
        {p.manufacturer && <><dt>Производитель</dt><dd>{p.manufacturer}</dd></>}
        {p.marking && <><dt>Маркировка</dt><dd>{p.marking}</dd></>}
        {p.description && <><dt>Назначение</dt><dd>{p.description}</dd></>}
        {Object.entries(p.values).map(([k, q]) => <Row key={k} label={PARAMS[k]?.label ?? k} value={formatQuantity(q.value, PARAMS[k]?.unitRu ?? q.unit)} />)}
        {p.tolerancePct !== null && <><dt>Допуск</dt><dd>±{String(p.tolerancePct).replace('.', ',')} %</dd></>}
        {Object.entries(p.ratings).map(([k, q]) => <Row key={k} label={RATINGS[k]?.label ?? k} value={formatQuantity(q.value, RATINGS[k]?.unitRu ?? q.unit)} />)}
        {p.temperature && <><dt>Температура</dt><dd>{p.temperature.minC}…{p.temperature.maxC} °C</dd></>}
        {p.polarized && <><dt>Полярность</dt><dd>полярная деталь — важна ориентация</dd></>}
      </dl>

      <div className="previews">
        <figure>
          <SymbolPreview symbol={b.symbol} />
          <figcaption>Условное обозначение</figcaption>
        </figure>
        <figure>
          {pkg ? <PackagePreview pkg={pkg} highlight={hlPin ? padOf(hlPin) : null} /> : <p className="muted small no-pkg">Корпус не задан — деталь нельзя разместить на плате.</p>}
          {pkg && (
            <figcaption>
              {b.packages.length > 1 ? (
                <select aria-label="Корпус" value={pkgIdx} onChange={(e) => setPkgIdx(Number(e.target.value))}>
                  {b.packages.map((x, i) => <option key={x.id} value={i}>{x.name}</option>)}
                </select>
              ) : pkg.name}
              {' · '}{pkg.mount === 'SMD' ? 'SMD' : 'выводной'}{pkg.pitchMm ? ` · шаг ${String(pkg.pitchMm).replace('.', ',')} мм` : ''}
            </figcaption>
          )}
        </figure>
      </div>
      {pkg && <p className="small"><b>Ключ первого вывода:</b> {pkg.pin1Marker ?? 'не указан'}{pkg.numbering ? ` · Нумерация: ${pkg.numbering}` : ''}</p>}

      <h4>Выводы</h4>
      <table className="pins-table">
        <thead><tr><th>№</th><th>Имя</th><th>Тип</th><th>Функция</th>{pkg && <th>Площадка ({pkg.name})</th>}</tr></thead>
        <tbody>
          {[...b.symbol.pins].sort((x, y) => x.number.localeCompare(y.number, 'ru', { numeric: true })).map((pin) => (
            <tr key={pin.number} onMouseEnter={() => setHlPin(pin.number)} onMouseLeave={() => setHlPin(null)}>
              <td>{pin.number}</td><td>{pin.name}</td><td>{PIN_TYPE_LABEL[pin.electricalType]}</td><td>{pin.description}</td>
              {pkg && <td>{padOf(pin.number)}</td>}
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Модель для расчёта</h4>
      {b.model
        ? <p className="small">{b.model.name}{b.model.verified ? '' : ' (не проверена)'}{b.model.source ? ` · ${b.model.source}` : ''}</p>
        : <p className="stage-note small">Нет SPICE-модели — деталь не моделируется: схему с ней можно рисовать и разводить, но расчёт будет остановлен с объяснением. Описание выводов модель не создаёт.</p>}

      <h4>Источник сведений</h4>
      <dl className="meta">
        <dt>Источник</dt><dd>{p.origin.source ?? '—'}</dd>
        <dt>Лицензия</dt><dd>{p.origin.license ?? '—'}</dd>
        <dt>Сверено с даташитом</dt><dd>{p.origin.verified ? `да${p.origin.checkedAt ? `, ${fmtDateTime(p.origin.checkedAt)}` : ''}` : 'нет — проверьте выводы и корпус перед изготовлением платы'}</dd>
        {p.origin.notes && <><dt>Примечания</dt><dd>{p.origin.notes}</dd></>}
        <dt>Даташит</dt><dd>{p.datasheetUrl ? <button className="linklike" onClick={() => void openDatasheet()}>{p.datasheetUrl}</button> : 'не указан'}</dd>
      </dl>
      {lint.length > 0 && (
        <>
          <h4>Замечания</h4>
          <ul className="issues">{lint.map((l, i) => <li key={i} className={l.severity}>{l.message}</li>)}</ul>
        </>
      )}
    </div>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => <><dt>{label}</dt><dd>{value}</dd></>;
