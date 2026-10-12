/**
 * Правая панель вкладки «Плата»: синхронизация со схемой (отчёт → «Применить»), параметры платы и
 * правила проектирования, выделенный объект, DRC, вывод (1:1 для ЛУТ, сборочный чертёж, Gerber/Excellon).
 */
import { useEffect, useState } from 'react';
import { gerberFiles } from '../core/gerber';
import type { DesignRules, ProjectDoc } from '../core/model';
import {
  deleteTrack, deleteVia, flipPlacement, fmtLen, LAYER_NAME, netName, parseLen, rotatePlacement, setBoard, setOutline, setTrackWidth,
  syncFromSchematic, type DrcIssue, type Layer, type SyncReport,
} from '../core/pcb';
import { artworkSvg, assemblySvg, lutMirror, type Artwork } from '../core/pcbExport';
import { api, errorText, unwrap } from './api';
import type { BoardSel } from './BoardPanel';
import { useDialogs } from './Dialogs';
import { NewBoard, PourPanel, ShapeEditor } from './BoardShape';

interface Props {
  doc: ProjectDoc;
  issues: DrcIssue[];
  selection: BoardSel;
  onSelect(s: BoardSel): void;
  onEdit(label: string, fn: (d: ProjectDoc) => ProjectDoc): void;
  toast(text: string, kind?: 'ok' | 'error'): void;
  onShowIssue(i: DrcIssue): void;
  onRouteFromVia(viaId: string): void;
}

function LenField({ label, mm, units, onCommit, min = 0 }: { label: string; mm: number; units: 'mm' | 'inch'; min?: number; onCommit(mm: number): void }) {
  return (
    <label className="field inline">
      <span>{label}</span>
      <input aria-label={label} key={`${mm}${units}`} defaultValue={fmtLen(mm, units, 3)}
        onBlur={(e) => { const v = parseLen(e.target.value, units); if (v !== null && v > min && v <= 1000) onCommit(Number(v.toFixed(4))); else e.target.value = fmtLen(mm, units, 3); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

const RULES: Array<[keyof DesignRules, string, number]> = [
  ['trackMm', 'Ширина новой дорожки', 0], ['minTrackMm', 'Минимальная ширина дорожки', 0], ['clearanceMm', 'Зазор', -1],
  ['edgeMm', 'Отступ от края', -1], ['viaDrillMm', 'Переход: сверло', 0], ['viaDiameterMm', 'Переход: площадка', 0],
  ['minDrillMm', 'Минимальное сверло', 0], ['minAnnularMm', 'Минимальный поясок', -1],
];

export function BoardSide(p: Props) {
  const { doc, issues } = p;
  const dialogs = useDialogs();
  const [preview, setPreview] = useState<{ report: SyncReport; revision: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Сообщение об отказе правки не «залипает»: следующая правка документа его убирает.
  useEffect(() => { setError(null); }, [doc.revision]);
  const board = doc.pcb.board;
  const units = board?.units ?? 'mm';
  const two = board?.layers === 2;
  const [outLayer, setOutLayer] = useState<Layer>('bottom');
  const layer: Layer = two ? outLayer : 'bottom';
  const [mirror, setMirror] = useState<boolean | null>(null);
  const mirrored = mirror ?? lutMirror(layer);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  const board_ = (label: string, patch: Parameters<typeof setBoard>[1]) => {
    const r = setBoard(doc, patch);
    if (r.error) { setError(r.error); return; }
    setError(null);
    p.onEdit(label, (d) => setBoard(d, patch).doc);
  };

  const syncPreview = () => setPreview({ report: syncFromSchematic(doc).report, revision: doc.revision });
  const syncApply = () => {
    p.onEdit('Синхронизация платы со схемой', (d) => syncFromSchematic(d).doc);
    setPreview((x) => (x ? { ...x, revision: -1 } : x));
  };

  const save = async (kind: 'svg' | 'pdf' | 'print', art: Artwork) => {
    try {
      if (kind === 'svg') { const r = await unwrap(api().files.saveSvg(art.title, art.svg)); if (r) p.toast(`Сохранено: ${r.path}`); }
      else if (kind === 'pdf') { const r = await unwrap(api().files.savePdf(art.title, art.svg, art.widthMm, art.heightMm)); if (r) p.toast(`Сохранено: ${r.path}`); }
      else { const r = await unwrap(api().files.print(art.svg, art.widthMm, art.heightMm)); if (!r.printed && r.reason) p.toast(`Печать не выполнена: ${r.reason}`, 'error'); }
    } catch (e) {
      await dialogs.alert('Не сохранено', errorText(e));
    }
  };
  const saveGerber = async () => {
    if (errors.length) {
      const ok = await dialogs.confirm('Gerber с ошибками DRC', `Проверка платы нашла ошибок: ${errors.length}. Плата с такими ошибками может не работать. Всё равно сохранить Gerber и сверловку?`, 'Сохранить');
      if (!ok) return;
    }
    try {
      const r = await unwrap(api().files.saveGerber(doc.name, gerberFiles(doc)));
      if (r) p.toast(`Gerber и сверловка: ${r.files} файлов → ${r.path}`);
    } catch (e) {
      await dialogs.alert('Не сохранено', errorText(e));
    }
  };

  const sel = p.selection;
  const track = sel?.kind === 'track' ? doc.pcb.tracks.find((t) => t.id === sel.id) : undefined;
  const via = sel?.kind === 'via' ? doc.pcb.vias.find((v) => v.id === sel.id) : undefined;
  const placement = sel?.kind === 'placement' ? doc.pcb.placements.find((x) => x.id === sel.id) : undefined;
  const plRef = placement ? doc.schematic.instances.find((i) => i.id === placement.instanceId)?.refDes ?? 'удалена' : '';

  return (
    <aside className="test-side board-side" aria-label="Плата: настройки">
      <section>
        <h3>Схема → плата</h3>
        <button className="btn primary" onClick={syncPreview}>Синхронизировать со схемой</button>
        {preview && (
          <div className="sync-report" data-testid="sync-report">
            <p>Добавлено: {preview.report.added.length ? preview.report.added.join(', ') : 'нет'}</p>
            <p>Удалено: {preview.report.removed.length ? preview.report.removed.join('; ') : 'нет'}{preview.report.removedTracks ? `, дорожек: ${preview.report.removedTracks}` : ''}</p>
            <p>Изменено: {preview.report.changed.length ? preview.report.changed.join('; ') : 'нет'}</p>
            <p>Без изменений: {preview.report.kept}</p>
            {preview.report.notPlaced.map((n) => <p key={n.refDes} className="muted small">{n.refDes}: {n.reason}</p>)}
            {preview.report.problems.map((m, i) => <p key={i} className="error-text small">{m}</p>)}
            {preview.report.hasChanges && preview.revision === doc.revision && (
              <div className="row">
                <button className="btn primary small" onClick={syncApply}>Применить</button>
                <button className="btn small" onClick={() => setPreview(null)}>Отмена</button>
              </div>
            )}
            {preview.revision === -1 && <p className="ok-text small">Применено. Отменить — Ctrl+Z.</p>}
            {!preview.report.hasChanges && <p className="muted small">Плата соответствует схеме.</p>}
            {preview.report.hasChanges && preview.revision >= 0 && preview.revision !== doc.revision && <p className="muted small">Документ изменился — синхронизируйте ещё раз.</p>}
          </div>
        )}
      </section>

      {board ? (
        <section>
          <h3>Плата</h3>
          <ShapeEditor units={units} initial={board} submitLabel="Задать размеры и форму"
            onSubmit={(outline, w, h) => {
              const size = outline.kind === 'polygon' ? undefined : { widthMm: w, heightMm: h };
              const r = setOutline(doc, outline, size);
              if (r.error) { setError(r.error); return; }
              setError(null);
              p.onEdit('Размеры и форма платы', (d) => setOutline(d, outline, size).doc);
            }} />
          <p className="muted small" data-testid="board-size">Габарит {fmtLen(board.widthMm, units)} × {fmtLen(board.heightMm, units)}</p>
          <div className="seg" role="radiogroup" aria-label="Слои меди">
            {([1, 2] as const).map((n) => <button key={n} role="radio" aria-checked={board.layers === n} className={`btn small ${board.layers === n ? 'on' : ''}`} onClick={() => board_('Слои платы', { layers: n })}>{n === 1 ? 'Односторонняя' : 'Двухсторонняя'}</button>)}
          </div>
          <div className="seg" role="radiogroup" aria-label="Единицы">
            {(['mm', 'inch'] as const).map((u) => <button key={u} role="radio" aria-checked={units === u} className={`btn small ${units === u ? 'on' : ''}`} onClick={() => board_('Единицы платы', { units: u })}>{u === 'mm' ? 'мм' : 'дюймы'}</button>)}
          </div>
          {error && <p className="error-text small" role="alert">{error}</p>}
          <p className="muted small">{two ? 'Медь с обеих сторон, переходные отверстия.' : 'Медь снизу, выводные детали сверху; SMD-детали — со стороны меди.'}</p>
          <details className="rules">
            <summary>Правила проектирования</summary>
            {RULES.map(([k, label, min]) => <LenField key={k} label={label} mm={board.rules[k]} units={units} min={min} onCommit={(v) => board_('Правила платы', { rules: { [k]: v } as Partial<DesignRules> })} />)}
            <p className="muted small">По умолчанию — для домашнего изготовления (ЛУТ): дорожка 0,8 мм, зазор 0,4 мм, поясок 0,25 мм.</p>
          </details>
        </section>
      ) : <NewBoard doc={doc} onEdit={p.onEdit} />}
      {board && <PourPanel doc={doc} onEdit={p.onEdit} />}

      {(track || via || placement) && (
        <section aria-label="Выделено">
          <h3>Выделено</h3>
          {placement && <>
            <p>{plRef}: X {fmtLen(placement.position.x, units)}, Y {fmtLen(placement.position.y, units)}, поворот {placement.rotation}°, {placement.side === 'top' ? 'сверху' : 'снизу'}</p>
            <div className="row">
              <button className="btn" onClick={() => p.onEdit('Поворот детали на плате', (d) => rotatePlacement(d, placement.id))}>Повернуть деталь (R)</button>
              <button className="btn" onClick={() => p.onEdit('Деталь на другую сторону платы', (d) => flipPlacement(d, placement.id))}>На другую сторону (F)</button>
            </div>
          </>}
          {track && <>
            <p>Дорожка: {netName(doc, track.netId)}, {LAYER_NAME[track.layer as Layer]}</p>
            <LenField label="Ширина выделенной дорожки" mm={track.widthMm} units={units} onCommit={(v) => p.onEdit('Ширина дорожки', (d) => setTrackWidth(d, track.id, v))} />
            <button className="btn danger" onClick={() => { p.onEdit('Удаление дорожки', (d) => deleteTrack(d, track.id)); p.onSelect(null); }}>Удалить дорожку</button>
          </>}
          {via && <>
            <p>Переходное отверстие: {netName(doc, via.netId)}, сверло {fmtLen(via.drillMm, units)}, площадка {fmtLen(via.diameterMm, units)}</p>
            <div className="row">
              <button className="btn" onClick={() => p.onRouteFromVia(via.id)}>Вести дорожку от перехода</button>
              <button className="btn danger" onClick={() => { p.onEdit('Удаление переходного отверстия', (d) => deleteVia(d, via.id).doc); p.onSelect(null); }}>Удалить переход</button>
            </div>
          </>}
        </section>
      )}

      <section>
        <h3>Проверка (DRC)</h3>
        <p className="muted small" data-testid="drc-summary">Ошибок: {errors.length}, предупреждений: {warnings.length}</p>
        <ul className="issues" aria-label="Проверка платы" data-testid="drc">
          {issues.length === 0 && <li className="ok">Ошибок нет, всё разведено</li>}
          {issues.map((i, k) => (
            <li key={k} className={i.severity}>
              {i.at || i.ids.length ? <button className="linklike" onClick={() => p.onShowIssue(i)}>{i.message}</button> : i.message}
            </li>
          ))}
        </ul>
        <p className="muted small">DRC проверяет геометрию по правилам. Он не заменяет электрическую проверку и испытание готовой платы.</p>
      </section>

      {board && (
        <section>
          <h3>Изготовление</h3>
          {two && (
            <div className="seg" role="radiogroup" aria-label="Слой для печати">
              {(['top', 'bottom'] as const).map((l) => <button key={l} role="radio" aria-checked={layer === l} className={`btn small ${layer === l ? 'on' : ''}`} onClick={() => { setOutLayer(l); setMirror(null); }}>{l === 'top' ? 'Верхний слой' : 'Нижний слой'}</button>)}
            </div>
          )}
          <label className="check"><input type="checkbox" checked={mirrored} onChange={(e) => setMirror(e.target.checked)} /> Зеркально</label>
          <p className={`small ${mirrored === lutMirror(layer) ? 'muted' : 'warning-text'}`} data-testid="lut-hint">
            {mirrored === lutMirror(layer)
              ? `Для ЛУТ: ${layer === 'bottom' ? 'нижний слой печатается без зеркала' : 'верхний слой печатается зеркально'} — при переносе тонера на медь рисунок развернётся правильно.`
              : 'Внимание: такая ориентация не подходит для ЛУТ — рисунок на меди получится зеркальным.'}
          </p>
          <div className="row wrap">
            <button className="btn" onClick={() => void save('svg', artworkSvg(doc, { layer, mirror: mirrored }))}>Медь: SVG</button>
            <button className="btn" onClick={() => void save('pdf', artworkSvg(doc, { layer, mirror: mirrored }))}>Медь: PDF</button>
            <button className="btn" onClick={() => void save('print', artworkSvg(doc, { layer, mirror: mirrored }))}>Медь: печать…</button>
          </div>
          <p className="muted small">Печатайте с масштабом 100 % («Фактический размер»), без «вписать в страницу», и проверьте квадрат 10×10 мм линейкой.</p>
          <div className="row wrap">
            <button className="btn" onClick={() => void save('svg', assemblySvg(doc))}>Сборочный чертёж: SVG</button>
            <button className="btn" onClick={() => void save('pdf', assemblySvg(doc))}>Сборочный чертёж: PDF</button>
          </div>
          <button className="btn" onClick={() => void saveGerber()}>Gerber и сверловка (.zip)</button>
          <p className="muted small">Gerber RS-274X и Excellon, мм. Экспорт проверен автотестами (обратное чтение, сравнение цепей), но не производителем — перед заказом откройте файлы в просмотрщике Gerber.</p>
        </section>
      )}
    </aside>
  );
}
