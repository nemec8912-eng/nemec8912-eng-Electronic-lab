/**
 * Фрезерный станок с ЧПУ (GRBL, CNC 3018): настройки фрез и станка, расчёт траекторий, проверка,
 * предпросмотр на плате и сохранение файлов G-code в папку.
 */
import { useEffect, useState } from 'react';
import { cncOf, cncPlan, isoWidth, setCnc, type CncPath, type CncPlan } from '../core/cnc';
import type { CncSettings, ProjectDoc } from '../core/model';
import { DEFAULT_CNC } from '../core/model';
import { api, errorText, unwrap } from './api';
import { useDialogs } from './Dialogs';

interface Props {
  doc: ProjectDoc;
  onEdit(label: string, fn: (d: ProjectDoc) => ProjectDoc): void;
  toast(text: string, kind?: 'ok' | 'error'): void;
  onPreview(paths: CncPath[] | null, isoWidthMm: number, cutToolMm: number): void;
}

type Patch = Parameters<typeof setCnc>[1];
const ru = (n: number) => String(Number(n.toFixed(3))).replace('.', ',');
const parse = (s: string): number | null => {
  const v = Number(s.trim().replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(v) ? v : null;
};

function Num({ label, value, unit, onCommit, int }: { label: string; value: number; unit?: string; int?: boolean; onCommit(v: number): string | null }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <label className="field inline">
      <span>{label}{unit ? `, ${unit}` : ''}</span>
      <input aria-label={label} key={value} defaultValue={ru(value)}
        onBlur={(e) => {
          const v = parse(e.target.value);
          if (v === null || v < 0 || (int && !Number.isInteger(v))) { e.target.value = ru(value); setErr(int ? 'Целое число' : 'Число не меньше нуля'); return; }
          if (v === value) { setErr(null); return; }
          const msg = onCommit(v);
          setErr(msg);
          if (msg) e.target.value = ru(value);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {err && <small className="error-text">{err}</small>}
    </label>
  );
}

export function CncPanel(p: Props) {
  const { doc } = p;
  const s = cncOf(doc);
  const dialogs = useDialogs();
  const [plan, setPlan] = useState<{ plan: CncPlan; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(true);
  const two = doc.pcb.board?.layers === 2;
  const fresh = plan && plan.revision === doc.revision ? plan.plan : null;

  useEffect(() => {
    p.onPreview(fresh && show ? fresh.paths : null, isoWidth(s), s.cut.toolMm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, show]);
  useEffect(() => () => p.onPreview(null, 0, 0), []); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: Patch): string | null => {
    const r = setCnc(doc, patch);
    if (r.error) return r.error;
    p.onEdit('Настройки фрезерования', (d) => setCnc(d, patch).doc);
    return null;
  };
  const calc = () => {
    setBusy(true);
    // Даём интерфейсу показать «Считаю…»: расчёт занимает до пары секунд на больших платах
    setTimeout(() => {
      try { setPlan({ plan: cncPlan(doc), revision: doc.revision }); }
      catch (e) { p.toast(`Траектории не рассчитаны: ${errorText(e)}`, 'error'); }
      finally { setBusy(false); }
    }, 30);
  };
  const save = async () => {
    if (!fresh) return;
    const errors = fresh.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      const ok = await dialogs.confirm('Файлы с ошибками', `Найдено ошибок: ${errors.length}. Например: ${errors[0]!.message}. Плата может получиться неработающей. Всё равно сохранить файлы?`, 'Сохранить');
      if (!ok) return;
    }
    try {
      const r = await unwrap(api().files.saveCnc(doc.name, [...fresh.files.map((f) => ({ name: f.name, content: f.gcode })), { name: 'ПРОЧТИ.txt', content: fresh.readme }]));
      if (r) p.toast(`Файлы для станка (${r.files}) → ${r.path}`);
    } catch (e) {
      await dialogs.alert('Не сохранено', errorText(e));
    }
  };
  const iso = s.iso;
  const total = fresh ? fresh.files.reduce((a, f) => a + f.minutes, 0) : 0;

  return (
    <section aria-label="Фрезерный станок">
      <h3>Фрезерный станок (ЧПУ, GRBL)</h3>
      <p className="muted small">CNC 3018 и подобные: G-code для изоляции меди, сверловки и обрезки платы. Ширина реза изоляции: <b data-testid="iso-width">{ru(isoWidth(s))} мм</b>.</p>
      <details className="rules">
        <summary>Фрезы и станок</summary>
        <h4>Изоляция дорожек</h4>
        <div className="seg" role="radiogroup" aria-label="Фреза изоляции">
          {(['vbit', 'endmill'] as const).map((t) => <button key={t} role="radio" aria-checked={iso.tool === t} className={`btn small ${iso.tool === t ? 'on' : ''}`} onClick={() => edit({ iso: { tool: t } })}>{t === 'vbit' ? 'V-фреза (гравер)' : 'Концевая фреза'}</button>)}
        </div>
        {iso.tool === 'vbit' ? <>
          <Num label="Вершина V-фрезы" unit="мм" value={iso.tipMm} onCommit={(v) => edit({ iso: { tipMm: v } })} />
          <Num label="Угол V-фрезы" unit="°" value={iso.angleDeg} onCommit={(v) => edit({ iso: { angleDeg: v } })} />
        </> : <Num label="Диаметр фрезы изоляции" unit="мм" value={iso.diameterMm} onCommit={(v) => edit({ iso: { diameterMm: v } })} />}
        <Num label="Глубина изоляции" unit="мм" value={iso.depthMm} onCommit={(v) => edit({ iso: { depthMm: v } })} />
        <Num label="Проходов изоляции" int value={iso.passes} onCommit={(v) => (v < 1 || v > 10 ? 'От 1 до 10' : edit({ iso: { passes: v } }))} />
        <Num label="Перекрытие проходов" unit="%" value={iso.overlapPct} onCommit={(v) => edit({ iso: { overlapPct: v } })} />
        <Num label="Подача изоляции" unit="мм/мин" value={iso.feed} onCommit={(v) => edit({ iso: { feed: v } })} />
        <Num label="Врезание изоляции" unit="мм/мин" value={iso.plunge} onCommit={(v) => edit({ iso: { plunge: v } })} />
        <h4>Сверловка</h4>
        <label className="field inline">
          <span>Свёрла в наборе, мм</span>
          <input aria-label="Свёрла в наборе" key={s.drill.sizes.join(';')} defaultValue={s.drill.sizes.map(ru).join('; ')}
            onBlur={(e) => {
              const list = e.target.value.split(/[;\s]+/).filter(Boolean).map(parse);
              if (list.some((v) => v === null || v <= 0)) { e.target.value = s.drill.sizes.map(ru).join('; '); return; }
              edit({ drill: { sizes: [...new Set(list as number[])].sort((a, b) => a - b) } });
            }} />
        </label>
        <p className="muted small">Пусто — сверлить как в проекте. Иначе отверстие берёт ближайшее сверло не меньше себя.</p>
        <Num label="Подача сверления" unit="мм/мин" value={s.drill.feed} onCommit={(v) => edit({ drill: { feed: v } })} />
        <Num label="Выход сверла ниже платы" unit="мм" value={s.drill.throughMm} onCommit={(v) => edit({ drill: { throughMm: v } })} />
        <Num label="Фрезеровать отверстия больше" unit="мм (0 — нет)" value={s.drill.millAboveMm} onCommit={(v) => edit({ drill: { millAboveMm: v } })} />
        <h4>Обрезка по контуру</h4>
        <Num label="Фреза обрезки" unit="мм" value={s.cut.toolMm} onCommit={(v) => edit({ cut: { toolMm: v } })} />
        <Num label="Шаг по глубине" unit="мм" value={s.cut.stepDownMm} onCommit={(v) => edit({ cut: { stepDownMm: v } })} />
        <Num label="Подача обрезки" unit="мм/мин" value={s.cut.feed} onCommit={(v) => edit({ cut: { feed: v } })} />
        <Num label="Врезание обрезки" unit="мм/мин" value={s.cut.plunge} onCommit={(v) => edit({ cut: { plunge: v } })} />
        <Num label="Перемычек" int value={s.cut.tabs} onCommit={(v) => (v > 12 ? 'Не больше 12' : edit({ cut: { tabs: v } }))} />
        <Num label="Ширина перемычки" unit="мм" value={s.cut.tabWidthMm} onCommit={(v) => edit({ cut: { tabWidthMm: v } })} />
        <Num label="Высота перемычки" unit="мм" value={s.cut.tabHeightMm} onCommit={(v) => edit({ cut: { tabHeightMm: v } })} />
        <h4>Станок и заготовка</h4>
        <Num label="Рабочее поле X" unit="мм" value={s.areaXMm} onCommit={(v) => edit({ areaXMm: v })} />
        <Num label="Рабочее поле Y" unit="мм" value={s.areaYMm} onCommit={(v) => edit({ areaYMm: v })} />
        <Num label="Отступ платы от края заготовки" unit="мм" value={s.marginMm} onCommit={(v) => edit({ marginMm: v })} />
        <Num label="Толщина текстолита" unit="мм" value={s.thicknessMm} onCommit={(v) => edit({ thicknessMm: v })} />
        <Num label="Безопасная высота" unit="мм" value={s.safeZMm} onCommit={(v) => edit({ safeZMm: v })} />
        <Num label="Обороты шпинделя (S)" value={s.spindle} onCommit={(v) => edit({ spindle: v })} />
        <Num label="Разгон шпинделя" unit="с" value={s.spinUpS} onCommit={(v) => edit({ spinUpS: v })} />
        {two && <>
          <label className="check"><input type="checkbox" checked={s.alignHoles} onChange={(e) => edit({ alignHoles: e.target.checked })} /> Реперные отверстия для переворота</label>
          <Num label="Сверло реперных отверстий" unit="мм" value={s.alignDrillMm} onCommit={(v) => edit({ alignDrillMm: v })} />
        </>}
        <button className="btn small" onClick={() => edit({ ...DEFAULT_CNC })}>Вернуть настройки CNC 3018 по умолчанию</button>
      </details>
      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={calc}>{busy ? 'Считаю траектории…' : 'Рассчитать траектории'}</button>
        {fresh && <button className="btn" onClick={() => void save()}>Сохранить файлы для станка…</button>}
      </div>
      {plan && !fresh && <p className="muted small">Плата или настройки изменились — рассчитайте траектории заново.</p>}
      {fresh && (
        <div data-testid="cnc-result">
          <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Показать траектории на плате</label>
          <p className="small">Заготовка {ru(fresh.stock.w)} × {ru(fresh.stock.h)} мм, всего около {Math.max(1, Math.round(total))} мин.</p>
          <ol className="cnc-files" aria-label="Файлы для станка">
            {fresh.files.map((f) => (
              <li key={f.name}><b>{f.name}</b> — сторона {f.side}: {f.title}; {f.tool}; ~{Math.max(1, Math.round(f.minutes))} мин</li>
            ))}
          </ol>
          <ul className="issues" aria-label="Проверка фрезерования" data-testid="cnc-issues">
            {fresh.issues.length === 0 && <li className="ok">Медь всех цепей разделяется фрезой, плата помещается на станке</li>}
            {fresh.issues.map((i, k) => <li key={k} className={i.severity}>{i.message}</li>)}
          </ul>
          <p className="muted small">Ноль: X0 Y0 — левый нижний угол заготовки, Z0 — поверхность меди. {two ? 'Сторона A — верхом вверх, сторона B — после переворота слева направо.' : 'Медь вверх: рисунок зеркальный — так и должно быть.'} Перед изоляцией снимите карту высот (Candle).</p>
        </div>
      )}
    </section>
  );
}
