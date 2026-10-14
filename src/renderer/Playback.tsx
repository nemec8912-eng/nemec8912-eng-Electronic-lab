/**
 * Воспроизведение рассчитанного переходного процесса на схеме (ТЗ, раздел 6): «Воспроизвести»,
 * «Пауза», «Стоп», шаг по точкам расчёта, ползунок времени, скорость; легенда индикаторов.
 * Значения берутся только из результата ngspice (sim/playback.ts), между точками — интерполяция.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatQuantity } from '../core/library';
import type { ProjectDoc } from '../core/model';
import { advance, flowArrows, frameAt, frameOfOp, potentialColor, SPEEDS, speedText, stepPoint, voltageRange, type Frame } from '../sim/playback';
import type { OpResult, TranResult } from '../sim/results';

const SLIDER_STEPS = 1000;

export interface PlaybackState {
  /** Текущий момент (с) или null, если переходного процесса нет. */
  t: number | null;
  frame: Frame | null;
  flow: { wireColor: Record<string, string>; arrows: ReturnType<typeof flowArrows> } | null;
  range: { min: number; max: number } | null;
  indicators: boolean;
  setIndicators(on: boolean): void;
  bar: ReactNode;
  legend: ReactNode;
}

/**
 * Состояние воспроизведения для результата расчёта. tran — переходный процесс (или null),
 * op — рабочая точка (стрелки токов без воспроизведения).
 */
export function usePlayback(doc: ProjectDoc, tran: TranResult | null, op: OpResult | null): PlaybackState {
  const [indicators, setIndicators] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const end = tran ? tran.time[tran.time.length - 1] ?? 0 : 0;
  const start = tran ? tran.time[0] ?? 0 : 0;
  const [t, setTState] = useState<number>(end);
  const tRef = useRef(end);
  const setT = useCallback((v: number) => { tRef.current = v; setTState(v); }, []);

  // Новый результат — пауза и конец записи (как было до воспроизведения: виден итог расчёта).
  useEffect(() => { setPlaying(false); setT(end); }, [tran, end, setT]);

  useEffect(() => {
    if (!playing || !tran) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const r = advance(tran, tRef.current, dt, speed);
      setT(r.t);
      if (r.done) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, tran, speed, setT]);

  const frame = useMemo(() => (tran ? frameAt(tran, t) : op ? frameOfOp(op) : null), [tran, op, t]);
  const range = useMemo(() => (tran ? voltageRange(tran.node) : op ? voltageRange(op.node) : null), [tran, op]);
  const flow = useMemo(() => {
    if (!indicators || !frame || !range) return null;
    const wireColor: Record<string, string> = {};
    for (const [net, v] of Object.entries(frame.node)) wireColor[net] = potentialColor(v, range);
    return { wireColor, arrows: flowArrows(doc, frame) };
  }, [indicators, frame, range, doc]);

  const play = () => {
    if (!tran) return;
    if (tRef.current >= end) setT(start);
    setPlaying(true);
  };
  const stop = () => { setPlaying(false); setT(start); };
  const step = (dir: 1 | -1) => { if (!tran) return; setPlaying(false); setT(stepPoint(tran, tRef.current, dir)); };

  const bar = tran && tran.time.length >= 2 ? (
    <div className="playback" role="group" aria-label="Воспроизведение переходного процесса">
      {playing
        ? <button className="btn small" onClick={() => setPlaying(false)}>⏸ Пауза</button>
        : <button className="btn small primary" onClick={play}>▶ Воспроизвести</button>}
      <button className="btn small" onClick={stop} title="В начало записи">⏹ Стоп</button>
      <button className="btn small" onClick={() => step(-1)} aria-label="Предыдущая точка расчёта" title="Предыдущая точка расчёта">◀</button>
      <button className="btn small" onClick={() => step(1)} aria-label="Следующая точка расчёта" title="Следующая точка расчёта">▶|</button>
      <input type="range" aria-label="Момент времени" min={0} max={SLIDER_STEPS} step={1}
        value={end > start ? Math.round(((t - start) / (end - start)) * SLIDER_STEPS) : 0}
        onChange={(e) => { setPlaying(false); setT(start + ((end - start) * Number(e.target.value)) / SLIDER_STEPS); }} />
      <span className="pb-time" data-testid="playback-time">
        t = {formatQuantity(t, 'с', 4)} из {formatQuantity(end, 'с', 3)} · точка {(frame?.index ?? 0) + 1} из {tran.time.length}
        {frame && !frame.exact ? ' (между точками — интерполяция)' : ''}
      </span>
      <label>
        Скорость{' '}
        <select aria-label="Скорость воспроизведения" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => <option key={s} value={s}>×{String(s).replace('.', ',')}</option>)}
        </select>
      </label>
      <span className="muted" data-testid="playback-speed">{speedText(tran, speed)}</span>
      <label className="check"><input type="checkbox" checked={indicators} onChange={(e) => setIndicators(e.target.checked)} /> Токи и напряжения на схеме</label>
    </div>
  ) : op ? (
    <div className="playback" role="group" aria-label="Индикаторы рабочей точки">
      <label className="check"><input type="checkbox" checked={indicators} onChange={(e) => setIndicators(e.target.checked)} /> Токи и напряжения на схеме</label>
    </div>
  ) : null;

  const legend = flow && range ? (
    <div className="flow-legend" data-testid="flow-legend">
      <span>
        Провод — потенциал: {formatQuantity(range.min, 'В', 3)}
        <i className="scale" style={{ background: `linear-gradient(90deg, ${potentialColor(range.min, range)}, ${potentialColor(0, range)}, ${potentialColor(range.max, range)})` }} />
        {formatQuantity(range.max, 'В', 3)} (серый — 0 В)
      </span>
      <span><b className="arrow-key">→</b> направление условного тока (от «+» к «−» во внешней цепи), толщина — величина (логарифмически); не движение электронов</span>
      <span>Токи меньше 1 нА не показаны. Всё — по расчёту ngspice{tran ? ', между точками расчёта — интерполяция' : ' в рабочей точке'}.</span>
    </div>
  ) : null;

  return { t: tran ? t : null, frame, flow, range, indicators, setIndicators, bar, legend };
}
