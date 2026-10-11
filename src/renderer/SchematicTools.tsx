/** Панель проверки ERC и окно экспорта/печати схемы. */
import { useEffect, useMemo, useState } from 'react';
import { ERC_DISCLAIMER, ERC_HELP, type ErcIssue } from '../core/erc';
import type { ProjectDoc } from '../core/model';
import { PAGE_MM, sheetSvg, type SheetOptions } from '../core/sheet';
import { api, errorText, fmtBytes, unwrap } from './api';

const SEV: Record<ErcIssue['severity'], string> = { error: 'Ошибка', warning: 'Предупреждение', info: 'Сведения' };

export function ErcPanel({ issues, onPick, onClose }: { issues: ErcIssue[]; onPick(i: ErcIssue): void; onClose(): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const count = (s: ErcIssue['severity']) => issues.filter((i) => i.severity === s).length;
  const shown = issues.filter((i) => showInfo || i.severity !== 'info');
  return (
    <section className="erc-panel" aria-label="Проверка схемы (ERC)">
      <div className="erc-head">
        <b>Проверка схемы (ERC)</b>
        <span className="erc-count error">ошибок: {count('error')}</span>
        <span className="erc-count warning">предупреждений: {count('warning')}</span>
        <label className="check small"><input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} /> сведения ({count('info')})</label>
        <span className="grow" />
        <button className="btn small" onClick={onClose} aria-label="Закрыть проверку">×</button>
      </div>
      {issues.length === 0 && <p className="ok-line small">Замечаний нет.</p>}
      <ul className="issues erc-list">
        {shown.map((i) => (
          <li key={i.key} className={i.severity} data-erc-code={i.code}>
            <button className="linklike" onClick={() => { onPick(i); setOpen(open === i.key ? null : i.key); }}>{SEV[i.severity]}: {i.message}</button>
            {open === i.key && <div className="small erc-help">{ERC_HELP[i.code]}</div>}
          </li>
        ))}
      </ul>
      <p className="muted small">{ERC_DISCLAIMER}</p>
    </section>
  );
}

type Fmt = 'pdf' | 'svg' | 'png';

export function ExportDialog({ doc, onClose, onSheet, toast }: {
  doc: ProjectDoc;
  onClose(): void;
  /** Сохранить настройки листа в проект (формат, ориентация, рамка, автор). */
  onSheet(patch: Partial<ProjectDoc['schematic']['sheet']>): void;
  toast(text: string, kind?: 'ok' | 'error'): void;
}) {
  const sheet = doc.schematic.sheet;
  const [fmt, setFmt] = useState<Fmt>('pdf');
  const [scale, setScale] = useState<'fit' | number>('fit');
  const [notes, setNotes] = useState(false);
  const [dpi, setDpi] = useState(200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts: SheetOptions = { size: sheet.size, orientation: sheet.orientation, frame: sheet.frame, scale, notes, author: sheet.author };
  const result = useMemo(() => sheetSvg(doc, opts), [doc, sheet.size, sheet.orientation, sheet.frame, sheet.author, scale, notes]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`, [result.svg]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const scaleText = result.scale === 1 ? '1:1' : result.scale > 1 ? `${result.scale.toFixed(2).replace('.', ',')}:1` : `1:${(1 / result.scale).toFixed(2).replace('.', ',')}`;

  const run = async (f: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await f(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const name = `${doc.name} — схема`;
    if (fmt === 'svg') {
      const r = await unwrap(api().files.saveDrawing(name, 'svg', result.svg));
      if (r) toast(`Схема сохранена: ${r.path} (${fmtBytes(r.bytes)})`);
    } else if (fmt === 'pdf') {
      const r = await unwrap(api().files.savePdf(name, result.svg, result.widthMm, result.heightMm));
      if (r) toast(`PDF сохранён: ${r.path} (${fmtBytes(r.bytes)})`);
    } else {
      const bytes = await rasterize(result.svg, result.widthMm, result.heightMm, dpi);
      const r = await unwrap(api().files.saveDrawing(name, 'png', bytes));
      if (r) toast(`PNG сохранён: ${r.path} (${fmtBytes(r.bytes)})`);
    }
  });
  const print = () => run(async () => {
    const r = await unwrap(api().files.print(result.svg, result.widthMm, result.heightMm));
    if (!r.printed && r.reason && r.reason !== 'cancelled') setError(`Печать не выполнена: ${r.reason}`);
  });

  return (
    <div className="modal-backdrop">
      <div className="modal export-modal" role="dialog" aria-modal="true" aria-label="Экспорт и печать схемы">
        <h2>Экспорт и печать схемы</h2>
        <div className="export-body">
          <div className="export-opts">
            <label className="field"><span>Формат файла</span>
              <select aria-label="Формат файла" value={fmt} onChange={(e) => setFmt(e.target.value as Fmt)}>
                <option value="pdf">PDF (для печати)</option><option value="svg">SVG (векторный рисунок)</option><option value="png">PNG (изображение)</option>
              </select>
            </label>
            <label className="check"><input type="checkbox" aria-label="Рамка и основная надпись" checked={sheet.frame} onChange={(e) => onSheet({ frame: e.target.checked })} /> Рамка и основная надпись</label>
            <label className="field"><span>Лист</span>
              <select aria-label="Формат листа" value={sheet.size} disabled={!sheet.frame} onChange={(e) => onSheet({ size: e.target.value as 'A4' })}>
                {Object.entries(PAGE_MM).map(([k, [w, h]]) => <option key={k} value={k}>{k} ({w}×{h} мм)</option>)}
              </select>
            </label>
            <label className="field"><span>Ориентация</span>
              <select aria-label="Ориентация" value={sheet.orientation} disabled={!sheet.frame} onChange={(e) => onSheet({ orientation: e.target.value as 'landscape' })}>
                <option value="landscape">альбомная</option><option value="portrait">книжная</option>
              </select>
            </label>
            <label className="field"><span>Масштаб</span>
              <select aria-label="Масштаб" value={String(scale)} onChange={(e) => setScale(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}>
                <option value="fit">вписать в лист</option><option value="0.5">1:2</option><option value="1">1:1 (шаг сетки 2,54 мм)</option><option value="2">2:1</option>
              </select>
            </label>
            <label className="field"><span>Разработал (в основную надпись)</span>
              <input aria-label="Разработал" value={sheet.author} maxLength={100} onChange={(e) => onSheet({ author: e.target.value })} />
            </label>
            <label className="check"><input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Печатать заметки</label>
            {fmt === 'png' && (
              <label className="field"><span>Разрешение PNG</span>
                <select aria-label="Разрешение" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                  <option value={100}>100 точек/дюйм</option><option value={200}>200 точек/дюйм</option><option value={300}>300 точек/дюйм</option>
                </select>
              </label>
            )}
            <p className="small muted" data-testid="export-info">
              Размер: {Math.round(result.widthMm)}×{Math.round(result.heightMm)} мм · масштаб {scaleText}
              {fmt === 'png' ? ` · ${Math.round(result.widthMm / 25.4 * dpi)}×${Math.round(result.heightMm / 25.4 * dpi)} точек` : ''}
            </p>
            {result.clipped && <p className="error-text small">Схема не помещается на лист при этом масштабе — края будут обрезаны. Выберите «вписать в лист» или больший формат.</p>}
            {error && <p className="error-text small" role="alert">{error}</p>}
          </div>
          <div className="export-preview"><img src={preview} alt="Предпросмотр листа" /></div>
        </div>
        <div className="modal-buttons">
          <button className="btn" onClick={onClose}>Закрыть</button>
          <button className="btn" disabled={busy} onClick={() => void print()}>Печать…</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>Сохранить…</button>
        </div>
      </div>
    </div>
  );
}

/** SVG → PNG в окне программы (белый фон, заданное разрешение). */
export async function rasterize(svg: string, wMm: number, hMm: number, dpi: number): Promise<Uint8Array> {
  const w = Math.round(wMm / 25.4 * dpi), h = Math.round(hMm / 25.4 * dpi);
  if (w * h > 120e6) throw new Error('Слишком большое изображение — уменьшите разрешение');
  const img = new Image();
  img.decoding = 'sync';
  const sized = svg.replace(/<svg([^>]*?)width="[^"]*"([^>]*?)height="[^"]*"/, `<svg$1width="${w}"$2height="${h}"`);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Не удалось построить изображение'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Не удалось сохранить изображение');
  return setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
}

/** Записать разрешение в PNG (фрагмент pHYs), чтобы при печати сохранялся масштаб. */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const data = new Uint8Array(9);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, ppm); dv.setUint32(4, ppm); data[8] = 1;
  const type = new TextEncoder().encode('pHYs');
  const chunk = new Uint8Array(12 + 9);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set(type, 4); chunk.set(data, 8);
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Сразу после IHDR (8 байт подписи + 25 байт IHDR); старый pHYs, если был, удаляется.
  const parts: Uint8Array[] = [png.subarray(0, 33), chunk];
  let i = 33;
  while (i < png.length) {
    const len = new DataView(png.buffer, png.byteOffset + i).getUint32(0);
    const t = String.fromCharCode(...png.subarray(i + 4, i + 8));
    if (t !== 'pHYs') parts.push(png.subarray(i, i + 12 + len));
    i += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
