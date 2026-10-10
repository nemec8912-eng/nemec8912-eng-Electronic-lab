/** Левая панель (каталог) и правая панель (свойства проекта / выбранного объекта). */
import { useEffect, useMemo, useState } from 'react';
import { categoryLabel, searchBundles } from '../core/catalog';
import { formatQuantity, modelParams, PARAMS, parseQuantity, RATINGS } from '../core/library';
import type { Annotation, CheckpointInfo, ComponentInstance, ProjectDoc, Wire } from '../core/model';
import { symbolOf } from '../core/schematic';
import { fmtDateTime } from './api';
import { Badges } from './CatalogView';
import type { CatalogState } from './useCatalog';

/** Левая панель схемы: поиск по каталогу (встроенный + мой) и выбор детали для размещения. */
export function CatalogPanel({ catalog, placing, onPick, onOpenCatalog }: {
  catalog: CatalogState; placing: string | null; onPick(partId: string | null): void; onOpenCatalog(): void;
}) {
  const [query, setQuery] = useState('');
  const found = useMemo(() => searchBundles(catalog.all, query), [catalog.all, query]);
  const LIMIT = 80;
  return (
    <aside className="panel left" aria-label="Каталог">
      <h3>Детали</h3>
      <input type="search" aria-label="Поиск детали для схемы" placeholder="Поиск: 555, 10к, диод…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="catalog-parts">
        {found.slice(0, LIMIT).map((b) => (
          <li key={b.part.id}>
            <button className={`catalog-item ${placing === b.part.id ? 'on' : ''}`} aria-label={b.part.name} title={b.part.description || b.part.name}
              aria-pressed={placing === b.part.id} onClick={() => onPick(placing === b.part.id ? null : b.part.id)} data-part-id={b.part.id}>
              <span>{b.part.name}</span>
              <Badges b={b} personal={catalog.isPersonal(b.part.id)} />
            </button>
          </li>
        ))}
        {found.length > LIMIT && <li className="muted small">…и ещё {found.length - LIMIT}. Уточните поиск.</li>}
        {found.length === 0 && <li className="muted small">Ничего не найдено.</li>}
      </ul>
      <button className="btn small" onClick={onOpenCatalog}>Открыть каталог…</button>
      <p className="muted small">Выберите деталь и щёлкните на полотне. Провод — щелчок по выводу, затем по второму выводу. Esc — отмена.</p>
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
  /** Добавить деталь проекта в мой каталог. */
  onAddToCatalog(partId: string): void;
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

function InstProps({ doc, inst, onInstValue, onInstRefDes, onInstRotate, onInstDelete, onAddToCatalog }: PropsPanelProps & { inst: ComponentInstance }) {
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
      {part && (
        <dl className="meta">
          <dt>Категория</dt><dd>{categoryLabel(part.category)}</dd>
          {part.partNumber && <><dt>Партномер</dt><dd>{part.partNumber}</dd></>}
          {part.marking && <><dt>Маркировка</dt><dd>{part.marking}</dd></>}
          {part.description && <><dt>Назначение</dt><dd>{part.description}</dd></>}
          {part.tolerancePct !== null && <><dt>Допуск</dt><dd>±{String(part.tolerancePct).replace('.', ',')} %</dd></>}
          {Object.entries(part.ratings).map(([k, q]) => <RatingRow key={k} k={k} value={q.value} />)}
          {part.temperature && <><dt>Температура</dt><dd>{part.temperature.minC}…{part.temperature.maxC} °C</dd></>}
        </dl>
      )}
      <dl className="meta">
        <dt>Модель</dt><dd>{model ? `${model.name}${model.verified ? '' : ' (не проверена)'}` : 'нет'}</dd>
        <dt>Символ</dt><dd>{sym?.name ?? '—'}</dd>
        <dt>Корпус</dt><dd>{part?.packages.length ? part.packages.map((pk) => doc.library.packages.find((x) => x.id === pk.packageId)?.name).join(', ') : 'не задан — на плате не размещается'}</dd>
        <dt>Сверено с даташитом</dt><dd>{part?.origin.verified ? 'да' : 'нет'}</dd>
      </dl>
      {part && part.category !== 'reference' && !model && (
        <p className="stage-note small" data-testid="no-model-warning">Нет SPICE-модели — эта деталь не моделируется. Схему с ней можно рисовать и разводить на плате, но расчёт будет остановлен с объяснением.</p>
      )}
      {model?.kind === 'spice-primitive' && <p className="muted small">Модель идеальная: без допусков, паразитных параметров и тепловой модели.</p>}
      {part && part.category !== 'reference' && (
        <button className="btn small" onClick={() => onAddToCatalog(part.id)} title="Сохранить копию этой детали (из проекта) в мой каталог">Добавить в мой каталог</button>
      )}
      <div className="row">
        <button className="btn" onClick={() => onInstRotate(inst.id)} title="R">Повернуть</button>
        <button className="btn danger" onClick={() => onInstDelete(inst.id)} title="Delete">Удалить</button>
      </div>
    </div>
  );
}

function RatingRow({ k, value }: { k: string; value: number }) {
  const r = RATINGS[k];
  return <><dt>{r?.label ?? k}</dt><dd>{formatQuantity(value, r?.unitRu ?? '')}</dd></>;
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
