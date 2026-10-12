/**
 * Карточка детали на схеме (двойной щелчок по детали): номиналы, пределы, маркировка, модель, корпус,
 * назначение выводов. «Сохранить» (Enter) — одна правка (Ctrl+Z отменяет), «Отмена» (Esc) — ничего не меняется.
 */
import { useEffect, useMemo, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import type { PartBundle } from '../core/catalog';
import {
  applyCard, CARD_RATINGS, cardRisks, draftOf, findByMarking, GRAPHIC_CHOICES, HAS_MARKING, modelCandidates, parseRating, parseValue, type CardDraft,
} from '../core/instanceCard';
import { formatQuantity, modelParams, PARAMS, RATINGS } from '../core/library';
import type { ProjectDoc } from '../core/model';
import { symbolOf } from '../core/schematic';

interface Props {
  doc: ProjectDoc;
  instId: string;
  catalog: PartBundle[];
  /** Варианты корпуса той же группы (шаблоны «тип + корпус»): id детали справочника и подпись. */
  variants: Array<{ partId: string; label: string }>;
  onSave(label: string, fn: (d: ProjectDoc) => ProjectDoc, warnings: string[]): void;
  onCancel(): void;
  onAddToCatalog(partId: string): void;
  onEditPart(partId: string): void;
  confirm(title: string, message: string, ok: string): Promise<boolean>;
}

const RATING_LABEL: Record<string, Record<string, string>> = {
  capacitor: { voltage: 'Рабочее напряжение' }, 'capacitor-polar': { voltage: 'Рабочее напряжение' }, resistor: { power: 'Мощность' },
  diode: { reverseVoltage: 'Допустимое обратное напряжение', current: 'Допустимый прямой ток' },
};
const PRIMARY_VALUE: Record<string, string[]> = {
  resistor: ['resistance'], capacitor: ['capacitance'], 'capacitor-polar': ['capacitance', 'esr'], inductor: ['inductance', 'resistance'], zener: ['zenerVoltage'],
};

export function InstanceCard(p: Props) {
  const inst = p.doc.schematic.instances.find((i) => i.id === p.instId);
  const part = inst ? p.doc.library.parts.find((x) => x.id === inst.partId) : undefined;
  const initial = useMemo(() => draftOf(p.doc, p.instId), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [d, setD] = useState<CardDraft | null>(initial);
  const [texts, setTexts] = useState<Record<string, string>>(() => {
    const t: Record<string, string> = {};
    if (!initial || !inst) return t;
    for (const [k, v] of Object.entries(initial.values)) t[`v:${k}`] = formatQuantity(v, PARAMS[k]?.unitRu ?? '', 4);
    for (const [k, v] of Object.entries(initial.ratings)) t[`r:${k}`] = v === null ? '' : formatQuantity(v, RATINGS[k]?.unitRu ?? '', 4);
    t.tol = initial.tolerancePct === null ? '' : String(initial.tolerancePct).replace('.', ',');
    return t;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); p.onCancel(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  if (!inst || !part || !d) return null;
  const cat = part.category;
  const model = part.modelId ? p.doc.library.models.find((m) => m.id === part.modelId) : undefined;
  const sym = symbolOf(p.doc, inst);
  const pkgRef = part.packages[0];
  const pkg = pkgRef ? p.doc.library.packages.find((x) => x.id === pkgRef.packageId) : undefined;
  // Номиналы: основные для категории + параметры модели
  const valueKeys = [...new Set([...(PRIMARY_VALUE[cat] ?? []), ...modelParams(model), ...Object.keys(inst.values)])].filter((k) => PARAMS[k]);
  const ratingKeys = CARD_RATINGS[cat] ?? [];
  const candidates = HAS_MARKING(cat) ? modelCandidates(p.catalog, cat) : [];
  const byMarking = HAS_MARKING(cat) && (d.marking || d.partNumber) ? findByMarking(p.catalog, d.partNumber || d.marking).filter((b) => b.model && b.part.category === cat) : [];
  const chosenModelPart = d.model.kind === 'catalog' ? p.catalog.find((b) => b.part.id === (d.model as { partId: string }).partId) : undefined;
  const mapNow = d.pinMap ?? pkgRef?.pinMap ?? [];
  const pinoutEditable = !!pkg && d.pkg.kind === 'keep' && !d.takePinout && sym && sym.pins.length <= 8;
  const set = (patch: Partial<CardDraft>) => { setError(null); setD({ ...d, ...patch }); };

  const save = async () => {
    // Разбор введённого текста
    const values: Record<string, number> = {};
    for (const k of valueKeys) {
      const t = texts[`v:${k}`];
      if (t === undefined) continue;
      if (t.trim() === '' && k === 'resistance' && cat === 'inductor') continue;
      const r = parseValue(k, t);
      if (r.error) { setError(r.error); return; }
      values[k] = r.value!;
    }
    const ratings: Record<string, number | null> = {};
    for (const k of ratingKeys) {
      const r = parseRating(k, texts[`r:${k}`] ?? '');
      if (r.error) { setError(r.error); return; }
      ratings[k] = r.value;
    }
    let tolerancePct: number | null = d.tolerancePct;
    if (cat === 'resistor' || cat === 'capacitor' || cat === 'capacitor-polar' || cat === 'inductor') {
      const t = (texts.tol ?? '').trim().replace(',', '.').replace('%', '');
      tolerancePct = t === '' ? null : Number(t);
      if (tolerancePct !== null && !(tolerancePct > 0 && tolerancePct <= 50)) { setError('Допуск: число от 0 до 50 (%)'); return; }
    }
    const draft: CardDraft = { ...d, values, ratings, tolerancePct };
    const risks = cardRisks(p.doc, p.instId, draft);
    if (risks.length && !(await p.confirm('Деталь на плате', risks.map((r) => r.message).join('\n'), 'Сохранить'))) return;
    const r = applyCard(p.doc, p.instId, draft, p.catalog);
    if (r.error) { setError(r.error); return; }
    if (r.doc !== p.doc) p.onSave(`Карточка ${d.refDes}`, (doc) => applyCard(doc, p.instId, draft, p.catalog).doc, r.warnings);
    else p.onCancel();
  };
  const onEnter = (e: RKeyboardEvent) => { if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLSelectElement)) { e.preventDefault(); void save(); } };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onCancel(); }}>
      <div className="modal inst-card" role="dialog" aria-modal="true" aria-label={`Карточка ${inst.refDes}`} onKeyDown={onEnter}>
        <h2>{inst.refDes} — {part.name}</h2>
        <div className="card-grid">
          <label className="field"><span>Позиционное обозначение</span>
            <input aria-label="Позиционное обозначение" value={d.refDes} onChange={(e) => set({ refDes: e.target.value })} autoFocus={!valueKeys.length} /></label>
          {valueKeys.map((k, n) => (
            <label key={k} className="field"><span>{k === 'resistance' && cat === 'inductor' ? 'Сопротивление обмотки' : PARAMS[k]!.label}</span>
              <input aria-label={k === 'resistance' && cat === 'inductor' ? 'Сопротивление обмотки' : PARAMS[k]!.label} value={texts[`v:${k}`] ?? ''} autoFocus={n === 0}
                placeholder={k === 'resistance' && cat === 'inductor' ? 'не задано (идеальная)' : ''} onChange={(e) => { setError(null); setTexts({ ...texts, [`v:${k}`]: e.target.value }); }} /></label>
          ))}
          {ratingKeys.map((k) => (
            <label key={k} className="field"><span>{RATING_LABEL[cat]?.[k] ?? RATINGS[k]!.label}</span>
              <input aria-label={RATING_LABEL[cat]?.[k] ?? RATINGS[k]!.label} value={texts[`r:${k}`] ?? ''} placeholder="не задано"
                onChange={(e) => { setError(null); setTexts({ ...texts, [`r:${k}`]: e.target.value }); }} /></label>
          ))}
          {(cat === 'resistor' || cat === 'capacitor' || cat === 'capacitor-polar' || cat === 'inductor') && (
            <label className="field"><span>Допуск, %</span>
              <input aria-label="Допуск" value={texts.tol ?? ''} placeholder="не задан" onChange={(e) => { setError(null); setTexts({ ...texts, tol: e.target.value }); }} /></label>
          )}
          {(cat === 'capacitor' || cat === 'capacitor-polar') && (
            <label className="field"><span>Тип</span>
              <input aria-label="Тип конденсатора" value={d.name} onChange={(e) => set({ name: e.target.value })} /></label>
          )}
          {HAS_MARKING(cat) && <>
            <label className="field"><span>{cat.startsWith('ic') || cat === 'mcu' ? 'Название' : 'Наименование'}</span>
              <input aria-label="Наименование" value={d.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="field"><span>Модель (партномер)</span>
              <input aria-label="Модель (партномер)" value={d.partNumber} placeholder="например, IRFZ44N" onChange={(e) => set({ partNumber: e.target.value })} /></label>
            <label className="field"><span>Маркировка на корпусе</span>
              <input aria-label="Маркировка" value={d.marking} onChange={(e) => set({ marking: e.target.value })} /></label>
          </>}
          {GRAPHIC_CHOICES[cat] && (
            <label className="field"><span>Тип</span>
              <select aria-label="Тип транзистора" value={d.graphic ?? ''} onChange={(e) => set({ graphic: e.target.value })}>
                {GRAPHIC_CHOICES[cat]!.map((g) => <option key={g.graphic} value={g.graphic}>{g.label}</option>)}
              </select></label>
          )}
          <label className="field"><span>Корпус</span>
            <select aria-label="Корпус" value={d.pkg.kind === 'keep' ? 'keep' : d.pkg.kind === 'own' ? `own:${d.pkg.packageId}` : `tpl:${d.pkg.partId}`}
              onChange={(e) => {
                const v = e.target.value;
                set({ pkg: v === 'keep' ? { kind: 'keep' } : v.startsWith('own:') ? { kind: 'own', packageId: v.slice(4) } : { kind: 'template', partId: v.slice(4) }, pinMap: null, takePinout: false });
              }}>
              <option value="keep">{pkg ? pkg.name : 'не задан'}</option>
              {part.packages.slice(1).map((x) => <option key={x.packageId} value={`own:${x.packageId}`}>{p.doc.library.packages.find((y) => y.id === x.packageId)?.name ?? '?'}</option>)}
              {p.variants.filter((v) => !pkg || v.label !== pkg.name).map((v) => <option key={v.partId} value={`tpl:${v.partId}`}>{v.label}</option>)}
            </select></label>
        </div>

        {HAS_MARKING(cat) && cat !== 'connector' && (
          <div className="card-model">
            <label className="field"><span>Электрическая модель</span>
              <select aria-label="Электрическая модель" value={d.model.kind === 'catalog' ? d.model.partId : d.model.kind}
                onChange={(e) => { const v = e.target.value; set({ model: v === 'keep' ? { kind: 'keep' } : v === 'none' ? { kind: 'none' } : { kind: 'catalog', partId: v }, takePinout: false }); }}>
                <option value="keep">{model ? `${model.name}${model.verified ? '' : ' (не проверена)'}` : 'нет модели'}</option>
                {model && <option value="none">убрать модель</option>}
                {candidates.map((b) => <option key={b.part.id} value={b.part.id}>{b.part.partNumber ?? b.part.name}: {b.model!.name}</option>)}
              </select></label>
            {byMarking.length > 0 && d.model.kind === 'keep' && (
              <p className="small">В справочнике есть: {byMarking.slice(0, 3).map((b) => (
                <button key={b.part.id} className="btn small" onClick={() => set({ model: { kind: 'catalog', partId: b.part.id }, takePinout: true, pinMap: null })}>Взять {b.part.partNumber ?? b.part.name}: модель и выводы</button>
              ))}</p>
            )}
            {chosenModelPart && (
              <label className="check small"><input type="checkbox" checked={d.takePinout} onChange={(e) => set({ takePinout: e.target.checked, pinMap: null })} /> Взять и назначение выводов из справочника ({chosenModelPart.part.partNumber ?? chosenModelPart.part.name})</label>
            )}
            {!model && d.model.kind !== 'catalog' && <p className="warning-text small">Нет модели — схема с этой деталью не рассчитывается. Корпус сам по себе не говорит, какой это прибор.</p>}
          </div>
        )}

        {pinoutEditable && sym && (cat === 'bjt' || cat === 'mosfet' || cat === 'thyristor' || cat === 'triac' || mapNow.length === 0) && (
          <div className="card-pins">
            <span className="small">Назначение выводов корпуса «{pkg!.name}» (по даташиту своей детали):</span>
            <div className="row wrap">
              {sym.pins.map((pin) => (
                <label key={pin.number} className="field inline-small"><span>{pin.name || pin.number}{pin.description ? ` (${pin.description})` : ''}</span>
                  <select aria-label={`Площадка для вывода ${pin.name || pin.number}`} value={mapNow.find((m) => m.symbolPin === pin.number)?.pad ?? ''}
                    onChange={(e) => {
                      const rest = mapNow.filter((m) => m.symbolPin !== pin.number && m.pad !== e.target.value);
                      set({ pinMap: e.target.value ? [...rest, { symbolPin: pin.number, pad: e.target.value }] : rest });
                    }}>
                    <option value="">—</option>
                    {pkg!.pads.map((x) => x.number).filter((n, i, a) => a.indexOf(n) === i).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select></label>
              ))}
            </div>
            {mapNow.length === 0 && <p className="warning-text small">Выводы не назначены: на плате цепи этой детали не появятся.</p>}
          </div>
        )}
        {sym && sym.pins.length > 8 && (cat.startsWith('ic') || cat === 'mcu') && (
          <p className="small">Назначение {sym.pins.length} выводов и модель микросхемы — в редакторе детали: <button className="btn small" onClick={() => p.onEditPart(part.id)}>Выводы и модель…</button></p>
        )}

        {error && <p className="error-text" role="alert">{error}</p>}
        <p className="muted small">Изменения касаются только {inst.refDes}; общий каталог не меняется. <button className="linklike small" onClick={() => p.onAddToCatalog(part.id)}>Сохранить эту деталь в мой каталог…</button></p>
        <div className="modal-buttons">
          <button className="btn" onClick={p.onCancel}>✕ Отмена</button>
          <button className="btn primary" onClick={() => void save()}>✓ Сохранить</button>
        </div>
      </div>
    </div>
  );
}
