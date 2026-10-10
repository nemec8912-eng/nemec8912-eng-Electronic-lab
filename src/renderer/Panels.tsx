/** Левая панель (каталог) и правая панель (свойства проекта / выбранного объекта). */
import { useEffect, useState } from 'react';
import { BUILTIN_PARTS, formatQuantity, modelParams, PARAMS, parseQuantity } from '../core/library';
import type { Annotation, CheckpointInfo, ComponentInstance, ProjectDoc, Wire } from '../core/model';
import { symbolOf } from '../core/schematic';
import { fmtDateTime } from './api';

const CATEGORIES = [
  'Катушки', 'Диоды и стабилитроны', 'Диодные мосты', 'Транзисторы', 'MOSFET',
  'Тиристоры и симисторы', 'Варисторы', 'Предохранители', 'Реле', 'Трансформаторы', 'Разъёмы', 'Переключатели',
  'Датчики', 'Аналоговые ИС', 'Цифровые ИС', 'Микроконтроллеры',
];

export function CatalogPanel({ placing, onPick, enabled }: { placing: string | null; onPick(catalogId: string | null): void; enabled: boolean }) {
  return (
    <aside className="panel left" aria-label="Каталог">
      <h3>Детали прототипа</h3>
      <ul className="catalog-parts">
        {BUILTIN_PARTS.map((b) => (
          <li key={b.catalogId}>
            <button className={`catalog-item ${placing === b.catalogId ? 'on' : ''}`} disabled={!enabled}
              aria-pressed={placing === b.catalogId} onClick={() => onPick(placing === b.catalogId ? null : b.catalogId)}>
              {b.part.name}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">Выберите деталь и щёлкните на полотне. Провод — щелчок по выводу, затем по второму выводу. Esc — отмена.</p>
      <h3>Каталог</h3>
      <p className="stage-note small">Каталог реальных компонентов — этап 2.</p>
      <ul className="catalog-cats" aria-disabled="true">
        {CATEGORIES.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </aside>
  );
}

interface PropsPanelProps {
  doc: ProjectDoc;
  selected: { kind: 'note'; note: Annotation } | { kind: 'inst'; inst: ComponentInstance } | { kind: 'wire'; wire: Wire } | null;
  checkpoints: CheckpointInfo[];
  onRename(name: string): void;
  onDescription(text: string): void;
  onNoteText(id: string, text: string): void;
  onNoteDelete(id: string): void;
  onInstValue(id: string, key: string, value: number, unit: string): void;
  onInstRefDes(id: string, refDes: string): string | null;
  onInstRotate(id: string): void;
  onInstDelete(id: string): void;
  onWireDelete(id: string): void;
  onCreateCheckpoint(): void;
  onRestoreCheckpoint(cp: CheckpointInfo): void;
}

const KIND_LABEL: Record<CheckpointInfo['kind'], string> = {
  manual: 'вручную',
  'on-save': 'при сохранении',
  'before-restore': 'перед возвратом',
};

export function PropertiesPanel(p: PropsPanelProps) {
  const s = p.selected;
  return (
    <aside className="panel right" aria-label="Свойства">
      {s?.kind === 'note' && <NoteProps note={s.note} onText={p.onNoteText} onDelete={p.onNoteDelete} />}
      {s?.kind === 'inst' && <InstProps key={s.inst.id} {...p} inst={s.inst} />}
      {s?.kind === 'wire' && <WireProps doc={p.doc} wire={s.wire} onDelete={p.onWireDelete} />}
      {!s && <ProjectProps {...p} />}
    </aside>
  );
}

function NoteProps({ note, onText, onDelete }: { note: Annotation; onText(id: string, t: string): void; onDelete(id: string): void }) {
  return (
    <div>
      <h3>Заметка</h3>
      <label className="field">
        <span>Текст</span>
        <textarea aria-label="Текст заметки" rows={8} value={note.text} onChange={(e) => onText(note.id, e.target.value)} />
      </label>
      <p className="muted small">Положение: {note.position.x}, {note.position.y}</p>
      <button className="btn danger" onClick={() => onDelete(note.id)}>Удалить заметку</button>
    </div>
  );
}

function ValueField({ inst, paramKey, onCommit }: { inst: ComponentInstance; paramKey: string; onCommit(v: number): void }) {
  const def = PARAMS[paramKey]!;
  const cur = inst.values[paramKey];
  const shown = cur ? formatQuantity(cur.value, def.unitRu, 4) : '';
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(shown); setError(null); }, [shown]);
  const commit = () => {
    const v = parseQuantity(text, def.unitRu);
    if (v === null) { setError(`Не понял значение. Примеры: 10к, 4,7 мк, 0.1u, 2.2e-6`); return; }
    if (!(v > def.min) || v > def.max) { setError(`Допустимо: больше ${formatQuantity(def.min, def.unitRu)} и не более ${formatQuantity(def.max, def.unitRu)}`); return; }
    setError(null);
    onCommit(v);
  };
  return (
    <label className="field">
      <span>{def.label}</span>
      <input aria-label={def.label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <em className="error-text small">{error}</em>}
    </label>
  );
}

function InstProps({ doc, inst, onInstValue, onInstRefDes, onInstRotate, onInstDelete }: PropsPanelProps & { inst: ComponentInstance }) {
  const part = doc.library.parts.find((x) => x.id === inst.partId);
  const model = part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
  const sym = symbolOf(doc, inst);
  const [ref, setRef] = useState(inst.refDes);
  const [refErr, setRefErr] = useState<string | null>(null);
  useEffect(() => setRef(inst.refDes), [inst.refDes]);
  const params = modelParams(model);
  // Для источника допускается и отрицательное/нулевое значение — проверку делает netlist.
  return (
    <div>
      <h3>{part?.name ?? 'Деталь'}</h3>
      {part?.category !== 'reference' && (
        <label className="field">
          <span>Позиционное обозначение</span>
          <input aria-label="Позиционное обозначение" value={ref} onChange={(e) => setRef(e.target.value)}
            onBlur={() => setRefErr(onInstRefDes(inst.id, ref))} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          {refErr && <em className="error-text small">{refErr}</em>}
        </label>
      )}
      {params.map((k) => PARAMS[k] && (
        k === 'voltage'
          ? <SourceVoltage key={k} inst={inst} onCommit={(v) => onInstValue(inst.id, k, v, PARAMS[k]!.unit)} />
          : <ValueField key={k} inst={inst} paramKey={k} onCommit={(v) => onInstValue(inst.id, k, v, PARAMS[k]!.unit)} />
      ))}
      {part && Object.keys(part.ratings).length > 0 && (
        <dl className="meta">
          {part.ratings.power && <><dt>Допустимая мощность</dt><dd>{formatQuantity(part.ratings.power.value, 'Вт')}</dd></>}
          {part.ratings.voltage && <><dt>Допустимое напряжение</dt><dd>{formatQuantity(part.ratings.voltage.value, 'В')}</dd></>}
        </dl>
      )}
      <dl className="meta">
        <dt>Модель</dt><dd>{model ? `${model.name}${model.verified ? '' : ' (не проверена)'}` : 'нет модели — расчёт невозможен'}</dd>
        <dt>Символ</dt><dd>{sym?.standard ?? '—'}</dd>
        <dt>Корпус</dt><dd>{part?.packages.length ? part.packages.map((pk) => doc.library.packages.find((x) => x.id === pk.packageId)?.name).join(', ') : 'на плате не размещается'}</dd>
      </dl>
      <p className="muted small">Детали прототипа идеальные: без допусков, паразитных параметров и тепловой модели.</p>
      <div className="row">
        <button className="btn" onClick={() => onInstRotate(inst.id)} title="R">Повернуть</button>
        <button className="btn danger" onClick={() => onInstDelete(inst.id)} title="Delete">Удалить</button>
      </div>
    </div>
  );
}

function SourceVoltage({ inst, onCommit }: { inst: ComponentInstance; onCommit(v: number): void }) {
  const cur = inst.values.voltage;
  const shown = cur ? formatQuantity(cur.value, 'В', 4) : '';
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(shown); setError(null); }, [shown]);
  return (
    <label className="field">
      <span>Напряжение</span>
      <input aria-label="Напряжение" value={text} onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = parseQuantity(text, 'В');
          if (v === null || Math.abs(v) > 1e4) { setError('Не понял значение (пример: 12, 3,3, 500м)'); return; }
          setError(null); onCommit(v);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {error && <em className="error-text small">{error}</em>}
    </label>
  );
}

function WireProps({ doc, wire, onDelete }: { doc: ProjectDoc; wire: Wire; onDelete(id: string): void }) {
  const net = doc.schematic.nets.find((n) => n.id === wire.netId);
  const refOf = (id: string | undefined) => doc.schematic.instances.find((i) => i.id === id)?.refDes ?? '?';
  return (
    <div>
      <h3>Провод</h3>
      <dl className="meta">
        <dt>Цепь</dt><dd>{net?.name ?? 'без имени'}</dd>
        <dt>Соединяет</dt><dd>{wire.from && wire.to ? `${refOf(wire.from.instanceId)}.${wire.from.pin} — ${refOf(wire.to.instanceId)}.${wire.to.pin}` : '—'}</dd>
        <dt>Выводов в цепи</dt><dd>{net?.connections.length ?? 0}</dd>
      </dl>
      <button className="btn danger" onClick={() => onDelete(wire.id)}>Удалить провод</button>
    </div>
  );
}

function ProjectProps({ doc, checkpoints, onRename, onDescription, onCreateCheckpoint, onRestoreCheckpoint }: PropsPanelProps) {
  const [name, setName] = useState(doc.name);
  useEffect(() => setName(doc.name), [doc.name]);
  const commitName = () => { if (name.trim() && name !== doc.name) onRename(name); else setName(doc.name); };
  return (
    <div>
      <h3>Проект</h3>
      <label className="field">
        <span>Название</span>
        <input aria-label="Название проекта" value={name} maxLength={200} onChange={(e) => setName(e.target.value)}
          onBlur={commitName} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className="field">
        <span>Описание</span>
        <textarea aria-label="Описание проекта" rows={4} value={doc.description} onChange={(e) => onDescription(e.target.value)} />
      </label>
      <dl className="meta">
        <dt>Создан</dt><dd>{fmtDateTime(doc.createdAt)}</dd>
        <dt>Изменён</dt><dd>{fmtDateTime(doc.updatedAt)}</dd>
        <dt>Ревизия</dt><dd>{doc.revision}</dd>
        <dt>Деталей</dt><dd>{doc.schematic.instances.length}</dd>
        <dt>Цепей</dt><dd>{doc.schematic.nets.length}</dd>
      </dl>

      <h3>Контрольные версии</h3>
      <button className="btn" onClick={onCreateCheckpoint}>Создать контрольную версию</button>
      <ul className="checkpoints" aria-label="Контрольные версии">
        {checkpoints.length === 0 && <li className="muted small">Пока нет. Они создаются при каждом сохранении и вручную.</li>}
        {checkpoints.map((cp) => (
          <li key={cp.id}>
            <div>
              <div className="cp-label">{cp.label}</div>
              <div className="muted small">{fmtDateTime(cp.createdAt)} · {KIND_LABEL[cp.kind]} · рев. {cp.revision}</div>
            </div>
            <button className="btn small" onClick={() => onRestoreCheckpoint(cp)}>Вернуть</button>
          </li>
        ))}
      </ul>

      <h3>Журнал изменений</h3>
      <ul className="changelog">
        {[...doc.changelog].reverse().slice(0, 12).map((c) => (
          <li key={c.id}><span className="muted small">{fmtDateTime(c.at)}</span> {c.summary}</li>
        ))}
      </ul>
    </div>
  );
}

export function StageTab({ title, stage, text }: { title: string; stage: number; text: string }) {
  return (
    <div className="stage-tab">
      <h2>{title}</h2>
      <p className="stage-note">Не реализовано — этап {stage}.</p>
      <p>{text}</p>
    </div>
  );
}
