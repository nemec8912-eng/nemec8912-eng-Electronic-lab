/**
 * Акт проверки для клиента: одна страница A4 (длиннее, если измерений много) по записи журнала испытаний —
 * устройство, дата, условия, измерения с расчётом и допуском, заменённые детали, примечания, вывод.
 * Вывод формулируется только из сравнения «замер ↔ расчёт» (без догадок): «все в допуске»,
 * «расхождения: N» или «не все точки сравнены».
 */
import { APP_VERSION } from './appinfo';
import { formatQuantity } from './library';
import type { ProjectDoc, TestRecord } from './model';
import { compare, eventLabel, fmtDay, quantityUnit, recordSummary } from './testlog';

export interface ReportSheet { svg: string; widthMm: number; heightMm: number; title: string }
export interface ReportOptions {
  /** Мастерская или мастер — в шапке и подписи. */
  workshop?: string;
  /** Клиент и устройство (свободный текст). */
  client?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (n: number) => Number(n.toFixed(3)).toString();

/** Перенос по словам на строки не длиннее n символов. */
export function wrap(text: string, n: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = w;
      else if ((line + ' ' + w).length <= n) line += ' ' + w;
      else { out.push(line); line = w; }
      while (line.length > n) { out.push(line.slice(0, n)); line = line.slice(n); }
    }
    out.push(line);
  }
  return out;
}

export function verdictText(rec: TestRecord): { text: string; ok: boolean | null } {
  const s = recordSummary(rec);
  const total = rec.measurements.length;
  if (total === 0) return { text: 'Измерения не записаны.', ok: null };
  if (s.mismatch > 0) return { text: `Есть расхождения с расчётом: ${s.mismatch} из ${total}. Устройство требует проверки.`, ok: false };
  if (s.open > 0 || s.match < total) return { text: `В допуске: ${s.match} из ${total}; остальные точки не сравнены (нет замера или расчёта).`, ok: null };
  return { text: `Все измерения (${total}) в пределах допуска расчёта. Устройство работает в соответствии со схемой.`, ok: true };
}

export function testReportSvg(doc: ProjectDoc, rec: TestRecord, opts: ReportOptions = {}): ReportSheet {
  const W = 210, M = 15, inner = W - 2 * M;
  const body: string[] = [];
  let y = M;
  const text = (x: number, s: string, size = 3.5, weight = 'normal', anchor = 'start') => {
    body.push(`<text x="${f(x)}" y="${f(y)}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="Arial, sans-serif">${esc(s)}</text>`);
  };
  const para = (s: string, size = 3.5, indent = 0) => {
    const n = Math.floor((inner - indent) / (size * 0.52));
    for (const line of wrap(s, n)) { text(M + indent, line, size); y += size * 1.45; }
  };
  const rule = () => { body.push(`<line x1="${M}" y1="${f(y)}" x2="${W - M}" y2="${f(y)}" stroke="#000" stroke-width="0.25"/>`); y += 5; };

  if (opts.workshop?.trim()) { text(M, opts.workshop.trim(), 3.2); y += 9; }
  text(W / 2, 'Акт проверки устройства', 6, 'bold', 'middle'); y += 8;
  text(W / 2, `${rec.title || 'Испытание'} · ${fmtDay(rec.date)}`, 3.8, 'normal', 'middle'); y += 8;
  rule();
  const row = (k: string, v: string) => {
    text(M, k, 3.5, 'bold');
    const n = Math.floor((inner - 45) / (3.5 * 0.52));
    const lines = wrap(v || '—', n);
    for (const [i, line] of lines.entries()) { text(M + 45, line); if (i < lines.length - 1) y += 5; }
    y += 6;
  };
  if (opts.client?.trim()) row('Клиент, устройство', opts.client.trim());
  row('Проект (схема)', `${doc.name}, ревизия ${rec.revision}`);
  row('Питание', rec.supplyV === null ? '—' : formatQuantity(rec.supplyV, 'В'));
  row('Приборы', rec.instruments);
  row('Условия', rec.conditions);
  y += 2;

  // Измерения
  text(M, 'Измерения', 4.2, 'bold'); y += 7;
  const cols = [M, M + 52, M + 82, M + 122];
  const head = ['Точка', 'Замер', 'Расчёт (± разброс)', 'Итог'];
  head.forEach((h, i) => text(cols[i]!, h, 3.2, 'bold'));
  y += 2; rule(); y -= 1;
  if (rec.measurements.length === 0) { text(M, 'Измерений нет', 3.4); y += 6; }
  for (const m of rec.measurements) {
    const u = quantityUnit(m.quantity);
    const v = compare(m);
    const meas = m.measured === null ? '—' : formatQuantity(m.measured, u, 4);
    const exp = m.expected ? `${formatQuantity(m.expected.value, u, 4)} ± ${formatQuantity(m.expected.band, u, 3)}` : '—';
    const verdict = v.status === 'match' ? 'в допуске' : v.status === 'mismatch' ? 'РАСХОЖДЕНИЕ' : v.text;
    const lines = wrap(m.label || '—', 24);
    text(cols[0]!, lines[0]!, 3.3); text(cols[1]!, meas, 3.3); text(cols[2]!, exp, 3.3); text(cols[3]!, verdict, 3.3, v.status === 'mismatch' ? 'bold' : 'normal');
    for (const extra of lines.slice(1)) { y += 4.6; text(cols[0]!, extra, 3.3); }
    y += 6;
    if (m.note.trim()) { y -= 1; para(`  ${m.note.trim()}`, 2.9, 4); }
  }
  y += 3;

  if (rec.events.length) {
    text(M, 'Детали', 4.2, 'bold'); y += 7;
    for (const e of rec.events) para(`${e.refDes}: ${eventLabel(e.kind).toLowerCase()}${e.replacement ? ` → ${e.replacement}` : ''}${e.circumstances ? ` (${e.circumstances})` : ''}`, 3.4, 2);
    y += 3;
  }
  if (rec.notes.trim()) {
    text(M, 'Примечания', 4.2, 'bold'); y += 7;
    para(rec.notes.trim(), 3.4, 2);
    y += 3;
  }

  const vt = verdictText(rec);
  text(M, 'Вывод', 4.2, 'bold'); y += 7;
  para(vt.text, 3.7, 2);
  y += 10;
  text(M, 'Проверил: ____________________', 3.5);
  text(W - M, 'Дата: ______________', 3.5, 'normal', 'end');
  y += 12;
  for (const line of wrap(`Расчётные значения — модель ngspice по схеме проекта (ревизия ${rec.revision}); допуск = разброс номиналов деталей + погрешность прибора. Составлено в «Электронной лаборатории» ${APP_VERSION}.`, Math.floor(inner / (2.6 * 0.5)))) {
    body.push(`<text x="${M}" y="${f(y)}" font-size="2.6" fill="#555" font-family="Arial, sans-serif">${esc(line)}</text>`);
    y += 3.8;
  }
  const H = Math.max(297, Math.ceil(y + M));
  const title = `Акт проверки — ${doc.name} — ${fmtDay(rec.date)}`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">` +
    `<title>${esc(title)}</title><rect width="100%" height="100%" fill="#fff"/>${body.join('')}</svg>\n`;
  return { svg, widthMm: W, heightMm: H, title };
}
