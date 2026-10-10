/**
 * Импорт детали из библиотек KiCad: выбор библиотеки и символа, посадочные места, предпросмотр с
 * источником и лицензией. Сохранение — только после проверки в редакторе (подтверждение пользователя).
 */
import { useMemo, useState } from 'react';
import { COMMON_SYMBOL_LIBRARIES } from '../catalog-import/kicad';
import { categoryLabel } from '../core/catalog';
import type { KicadLibraryDto, KicadPreviewDto } from '../shared/api';
import { api, errorText, unwrap } from './api';
import { PackagePreview, SymbolPreview } from './CatalogPreviews';
import { PIN_TYPE_LABEL } from './CatalogView';
import type { PartBundle } from '../core/catalog';

export function KicadImport({ onCancel, onAccept }: { onCancel(): void; onAccept(b: PartBundle): void }) {
  const [library, setLibrary] = useState('Timer');
  const [lib, setLib] = useState<KicadLibraryDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [symbol, setSymbol] = useState<string | null>(null);
  const [fpText, setFpText] = useState('');
  const [preview, setPreview] = useState<KicadPreviewDto | null>(null);

  const run = async <T,>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label); setError(null);
    try { return await f(); } catch (e) { setError(errorText(e)); return undefined; } finally { setBusy(null); }
  };
  const opened = (r: KicadLibraryDto | null | undefined) => {
    if (!r) return;
    setLib(r); setSymbol(null); setPreview(null); setFilter('');
  };
  const pick = async (name: string) => {
    setSymbol(name);
    setPreview(null);
    const known = lib?.symbols.find((s) => s.name === name);
    setFpText(known?.footprint ?? '');
    if (lib && known && !known.description && !known.footprint) {
      // Библиотека-папка KiCad 9: сведения о символе подгружаются при выборе.
      const d = await run('Загрузка символа…', () => unwrap(api().kicad.describe(lib.token, name)));
      if (d) {
        setLib((l) => (l ? { ...l, symbols: l.symbols.map((s) => (s.name === name ? d : s)) } : l));
        setFpText((t) => t || d.footprint);
      }
    }
  };
  const build = async (files: boolean) => {
    if (!lib || !symbol) return;
    const online = fpText.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const r = await run('Загрузка…', () => unwrap(api().kicad.build(lib.token, symbol, { online, files })));
    if (r) setPreview(r);
  };
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = lib?.symbols ?? [];
    return (q ? list.filter((s) => `${s.name} ${s.description} ${s.keywords}`.toLowerCase().includes(q)) : list).slice(0, 300);
  }, [lib, filter]);

  const b = preview?.bundle;
  return (
    <main className="catalog-screen kicad-import" aria-label="Импорт из KiCad">
      <div className="catalog-head">
        <h2>Импорт детали из библиотек KiCad</h2>
        <span className="grow" />
        <button className="btn" onClick={onCancel}>Отмена</button>
        <button className="btn primary" disabled={!b} onClick={() => b && onAccept(b)}>Проверить и сохранить…</button>
      </div>
      <div className="import-body">
        <section className="import-left">
          <h3>1. Библиотека символов</h3>
          <p className="muted small">Официальные библиотеки KiCad загружаются с gitlab.com — нужен интернет, только по этой кнопке. Лицензия данных: CC-BY-SA 4.0 с исключением для проектов. Можно открыть и файл .kicad_sym с компьютера.</p>
          <div className="row">
            <input list="kicad-libs" aria-label="Библиотека KiCad" value={library} onChange={(e) => setLibrary(e.target.value)} placeholder="Timer, Device, Transistor_BJT…" />
            <datalist id="kicad-libs">{COMMON_SYMBOL_LIBRARIES.map((l) => <option key={l} value={l} />)}</datalist>
          </div>
          <div className="row">
            <button className="btn" disabled={!!busy || !library.trim()} onClick={async () => opened(await run('Загрузка библиотеки…', () => unwrap(api().kicad.openOnline(library.trim()))))}>Загрузить из интернета</button>
            <button className="btn" disabled={!!busy} onClick={async () => opened(await run('Открытие файла…', () => unwrap(api().kicad.openFile())))}>Файл с компьютера…</button>
          </div>
          {busy && <p className="muted small" role="status">{busy}</p>}
          {error && <p className="error-text small" role="alert">{error}</p>}
          {lib && (
            <>
              <h3>2. Символ — {lib.library} ({lib.symbols.length})</h3>
              <input type="search" aria-label="Поиск символа" placeholder="Название или описание" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <ul className="kicad-symbols" aria-label="Символы библиотеки">
                {shown.map((s) => (
                  <li key={s.name}>
                    <button className={`part-row ${symbol === s.name ? 'on' : ''}`} onClick={() => void pick(s.name)} aria-label={s.name}>
                      <span className="part-row-name">{s.name}</span>
                      {(s.description || s.footprint) && <span className="part-row-meta">{s.description}{s.footprint ? ` · ${s.footprint}` : ''}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {lib && symbol && (
            <>
              <h3>3. Посадочные места</h3>
              <label className="field">
                <span>Из библиотек KiCad (через запятую, «Библиотека:Имя»)</span>
                <input aria-label="Посадочные места KiCad" value={fpText} onChange={(e) => setFpText(e.target.value)} placeholder="Package_DIP:DIP-8_W7.62mm, Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" />
              </label>
              <div className="row">
                <button className="btn primary" disabled={!!busy} onClick={() => void build(false)}>Показать деталь</button>
                <button className="btn" disabled={!!busy} onClick={() => void build(true)}>…и файлы .kicad_mod с компьютера</button>
              </div>
            </>
          )}
        </section>
        <section className="import-preview" aria-label="Предпросмотр импорта">
          {!b && <p className="muted">Выберите библиотеку и символ, затем нажмите «Показать деталь». Ничего не сохраняется, пока вы не проверите деталь в редакторе.</p>}
          {b && preview && (
            <div className="part-card">
              <h3 className="part-title">{b.part.name}</h3>
              <dl className="meta">
                <dt>Категория</dt><dd>{categoryLabel(b.part.category)} (обозначение {b.part.refPrefix})</dd>
                {b.part.partNumber && <><dt>Партномер</dt><dd>{b.part.partNumber}</dd></>}
                {b.part.description && <><dt>Описание</dt><dd>{b.part.description}</dd></>}
                <dt>Источник</dt><dd className="break">{b.part.origin.source}</dd>
                <dt>Лицензия</dt><dd>{b.part.origin.license ?? 'не известна (файл пользователя) — уточните у источника'}</dd>
                <dt>Модель для расчёта</dt><dd>{b.model ? b.model.name : 'нет — деталь не моделируется'}</dd>
              </dl>
              <div className="previews">
                <figure><SymbolPreview symbol={b.symbol} /><figcaption>Условное обозначение</figcaption></figure>
                {b.packages.map((p) => <figure key={p.id}><PackagePreview pkg={p} /><figcaption>{p.name} · {p.mount === 'SMD' ? 'SMD' : 'выводной'}</figcaption></figure>)}
                {b.packages.length === 0 && <figure><p className="muted small no-pkg">Без посадочного места — на плате не разместить (можно добавить потом).</p></figure>}
              </div>
              {preview.warnings.length > 0 && (
                <>
                  <h4>Что упрощено или требует проверки</h4>
                  <ul className="issues">{preview.warnings.map((w, i) => <li key={i} className="warning">{w}</li>)}</ul>
                </>
              )}
              <h4>Выводы</h4>
              <table className="pins-table">
                <thead><tr><th>№</th><th>Имя</th><th>Тип</th>{b.packages.map((p) => <th key={p.id}>{p.name}</th>)}</tr></thead>
                <tbody>
                  {[...b.symbol.pins].sort((x, y) => x.number.localeCompare(y.number, 'en', { numeric: true })).map((pin) => (
                    <tr key={pin.number}>
                      <td>{pin.number}</td><td>{pin.name}</td><td>{PIN_TYPE_LABEL[pin.electricalType]}</td>
                      {b.part.packages.map((pk) => <td key={pk.packageId}>{pk.pinMap.find((m) => m.symbolPin === pin.number)?.pad ?? '—'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
