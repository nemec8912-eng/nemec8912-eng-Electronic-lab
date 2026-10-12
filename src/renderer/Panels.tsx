/** Левая панель (каталог) и правая панель (свойства проекта / выбранного объекта). */
import { useEffect, useMemo, useState } from 'react';
import { categoryLabel, searchBundles } from '../core/catalog';
import { formatQuantity, modelParams, paramInRange, PARAMS, parseQuantity, RATINGS } from '../core/library';
import type { Annotation, CheckpointInfo, ComponentInstance, NetLabel, PartDef, ProjectDoc, SimModel, Wire } from '../core/model';
import { graphOf, netDisplayName, wireNetId } from '../core/connectivity';
import { deleteItems, groupItems, kindOf, mirrorItems, renameLabel, rotateItems, symbolOf, ungroupItems } from '../core/schematic';
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
  selection: string[];
  /** Правка через историю (Undo/Redo). */
  onEdit(label: string, fn: (d: ProjectDoc) => ProjectDoc, coalesceKey?: string): void;
  onSelect(ids: string[]): void;
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
  /** Изменить деталь только в этом проекте (характеристики, модель, корпуса). */
  onEditPart(partId: string): void;
  /** Модель той же детали в каталоге (если у копии в проекте её нет). */
  catalogModelFor(part: PartDef): SimModel | null;
  /** Скопировать модель из каталога в деталь проекта. */
  onTakeModel(partId: string): void;
  onWireDelete(id: string): void;
  onCreateCheckpoint(): void;
  onRestoreCheckpoint(cp: CheckpointInfo): void;
}

const KIND_LABEL: Record<CheckpointInfo['kind'], string> = {
  manual: 'вручную',
  test: 'испытание',
  'on-save': 'при сохранении',
  'before-restore': 'перед возвратом',
};

export function PropertiesPanel(p: PropsPanelProps) {
  const sch = p.doc.schematic;
  const one = p.selection.length === 1 ? p.selection[0]! : null;
  const note = one ? sch.annotations.find((x) => x.id === one) : undefined;
  const inst = one ? sch.instances.find((x) => x.id === one) : undefined;
  const wire = one ? sch.wires.find((x) => x.id === one) : undefined;
  const label = one ? sch.labels.find((x) => x.id === one) : undefined;
  const junction = one ? sch.junctions.find((x) => x.id === one) : undefined;
  const live = p.selection.filter((id) => kindOf(p.doc, id));
  return (
    <aside className="panel right" aria-label="Свойства">
      {note && <NoteProps note={note} onText={p.onNoteText} onDelete={p.onNoteDelete} />}
      {inst && <InstProps key={inst.id} {...p} inst={inst} />}
      {wire && <WireProps doc={p.doc} wire={wire} onDelete={p.onWireDelete} />}
      {label && <LabelProps key={label.id} doc={p.doc} label={label} onEdit={p.onEdit} onSelect={p.onSelect} />}
      {junction && <JunctionProps doc={p.doc} id={junction.id} />}
      {live.length > 1 && <MultiProps doc={p.doc} ids={live} onEdit={p.onEdit} onSelect={p.onSelect} />}
      {live.length === 0 && <ProjectProps {...p} />}
    </aside>
  );
}

function NetInfo({ doc, netId }: { doc: ProjectDoc; netId: string | null }) {
  const net = netId ? doc.schematic.nets.find((n) => n.id === netId) : undefined;
  if (!net) return <dl className="meta"><dt>Цепь</dt><dd>не подключена ни к одному выводу</dd></dl>;
  const pins = net.connections.map((c) => {
    const inst = doc.schematic.instances.find((i) => i.id === c.instanceId);
    return inst ? `${inst.refDes}.${c.pin}` : c.pin;
  }).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  return (
    <dl className="meta">
      <dt>Цепь</dt><dd data-testid="net-name">{netDisplayName(doc, net)}</dd>
      <dt>Выводы</dt><dd data-testid="net-pins">{pins.join(', ')}</dd>
    </dl>
  );
}

function LabelProps({ doc, label, onEdit, onSelect }: { doc: ProjectDoc; label: NetLabel; onEdit: PropsPanelProps['onEdit']; onSelect(ids: string[]): void }) {
  const [name, setName] = useState(label.name);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setName(label.name), [label.name]);
  const commit = () => {
    const r = renameLabel(doc, label.id, name);
    if (r.error) { setErr(r.error); return; }
    setErr(null);
    if (name.trim() !== label.name) onEdit(`Метка ${name.trim()}`, (d) => renameLabel(d, label.id, name).doc);
  };
  const same = doc.schematic.labels.filter((l) => l.name === label.name).length;
  return (
    <div>
      <h3>{label.kind === 'power' ? 'Метка питания' : 'Метка цепи'}</h3>
      <label className="field">
        <span>Имя цепи</span>
        <input aria-label="Имя метки" value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        {err && <em className="error-text small">{err}</em>}
      </label>
      <label className="check"><input type="checkbox" checked={label.kind === 'power'} onChange={(e) => {
        const kind = e.target.checked ? 'power' as const : 'net' as const;
        onEdit('Вид метки', (d) => ({ ...d, schematic: { ...d.schematic, labels: d.schematic.labels.map((l) => (l.id === label.id ? { ...l, kind } : l)) } }));
      }} /> Метка питания (символ питания)</label>
      <NetInfo doc={doc} netId={graphOf(doc).netOfVertex.get(`l:${label.id}`) ?? null} />
      <p className="muted small">Меток «{label.name}» на схеме: {same}. {label.kind === 'power' ? 'Метка питания называет цепь, но напряжения не создаёт — для расчёта нужен источник.' : 'Все метки с этим именем — одна цепь.'}</p>
      <div className="row">
        <button className="btn" onClick={() => onEdit('Поворот', (d) => rotateItems(d, new Set([label.id])))}>Повернуть</button>
        <button className="btn danger" onClick={() => { onEdit('Удаление метки', (d) => deleteItems(d, new Set([label.id]))); onSelect([]); }}>Удалить</button>
      </div>
    </div>
  );
}

function JunctionProps({ doc, id }: { doc: ProjectDoc; id: string }) {
  const g = graphOf(doc);
  return (
    <div>
      <h3>Узел</h3>
      <p className="muted small">Точка соединения проводов: {g.degree.get(`j:${id}`) ?? 0}. Узел с тремя и более проводами отмечен точкой.</p>
      <NetInfo doc={doc} netId={g.netOfVertex.get(`j:${id}`) ?? null} />
    </div>
  );
}

function MultiProps({ doc, ids, onEdit, onSelect }: { doc: ProjectDoc; ids: string[]; onEdit: PropsPanelProps['onEdit']; onSelect(ids: string[]): void }) {
  const count = (k: string) => ids.filter((id) => kindOf(doc, id) === k).length;
  const set = new Set(ids);
  const grouped = doc.schematic.groups.some((g) => g.memberIds.every((m) => set.has(m)) && g.memberIds.length === ids.filter((i) => g.memberIds.includes(i)).length && g.memberIds.length === ids.length);
  return (
    <div>
      <h3>Выделено: {ids.length}</h3>
      <dl className="meta">
        {count('inst') > 0 && <><dt>Деталей</dt><dd>{count('inst')}</dd></>}
        {count('wire') > 0 && <><dt>Проводов</dt><dd>{count('wire')}</dd></>}
        {count('label') > 0 && <><dt>Меток</dt><dd>{count('label')}</dd></>}
        {count('junction') > 0 && <><dt>Узлов</dt><dd>{count('junction')}</dd></>}
        {count('note') > 0 && <><dt>Заметок</dt><dd>{count('note')}</dd></>}
      </dl>
      {grouped && <p className="muted small">Это группа: выделяется и перемещается целиком.</p>}
      <div className="row">
        <button className="btn" onClick={() => onEdit('Поворот', (d) => rotateItems(d, set))}>Повернуть</button>
        <button className="btn" onClick={() => onEdit('Отражение', (d) => mirrorItems(d, set))}>Отразить</button>
        {!grouped && <button className="btn" onClick={() => onEdit('Группа', (d) => groupItems(d, set))}>Сгруппировать</button>}
        {grouped && <button className="btn" onClick={() => onEdit('Разгруппировать', (d) => ungroupItems(d, set))}>Разгруппировать</button>}
        <button className="btn danger" onClick={() => { onEdit('Удаление', (d) => deleteItems(d, set)); onSelect([]); }}>Удалить</button>
      </div>
    </div>
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
    if (!paramInRange(paramKey, v)) {
      setError(def.signed ? `Допустимо: от ${formatQuantity(def.min, def.unitRu)} до ${formatQuantity(def.max, def.unitRu)}` : `Допустимо: больше ${formatQuantity(def.min, def.unitRu)} и не более ${formatQuantity(def.max, def.unitRu)}`);
      return;
    }
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

function InstProps({ doc, inst, onInstValue, onInstRefDes, onInstRotate, onInstDelete, onAddToCatalog, onEditPart, catalogModelFor, onTakeModel }: PropsPanelProps & { inst: ComponentInstance }) {
  const part = doc.library.parts.find((x) => x.id === inst.partId);
  const catalogModel = part ? catalogModelFor(part) : null;
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
      {params.map((k) => PARAMS[k] && <ValueField key={k} inst={inst} paramKey={k} onCommit={(v) => onInstValue(inst.id, k, v, PARAMS[k]!.unit)} />)}
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
        <p className="stage-note small" data-testid="no-model-warning">{part.category === 'ic-digital' || part.category === 'mcu'
          ? 'У этой цифровой микросхемы нет модели: прошивка микроконтроллеров, счётчики и регистры не моделируются. Простая логика (CD4011, CD4093, 74HC00 и др.) в справочнике моделируется.'
          : 'Нет SPICE-модели — эта деталь не моделируется. Схему с ней можно рисовать и разводить на плате, но расчёт будет остановлен с объяснением.'}</p>
      )}
      {part && !model && catalogModel && (
        <button className="btn small" onClick={() => onTakeModel(part.id)} title={catalogModel.source ?? ''}>Взять модель из каталога: {catalogModel.name}</button>
      )}
      {model && (model.verified && model.source?.startsWith('ngspice:')
        ? <p className="muted small">Модель идеальная: без допусков, паразитных параметров и тепловой модели.</p>
        : <p className="muted small" data-testid="model-note">Модель приближённая{model.verified ? '' : ', не проверена'}: {model.source ?? 'источник не указан'}.</p>)}
      {part && part.category !== 'reference' && (
        <div className="row wrap">
          <button className="btn small" onClick={() => onEditPart(part.id)} title="Характеристики, модель, корпуса — только в этом проекте; каталог не меняется">Изменить деталь в проекте…</button>
          <button className="btn small" onClick={() => onAddToCatalog(part.id)} title="Сохранить копию этой детали (из проекта) в мой каталог">Добавить в мой каталог</button>
        </div>
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


function WireProps({ doc, wire, onDelete }: { doc: ProjectDoc; wire: Wire; onDelete(id: string): void }) {
  const endText = (e: Wire['a']) => {
    if (e.kind === 'pin') return `${doc.schematic.instances.find((i) => i.id === e.instanceId)?.refDes ?? '?'}.${e.pin}`;
    if (e.kind === 'label') return `метка ${doc.schematic.labels.find((l) => l.id === e.labelId)?.name ?? '?'}`;
    if (e.kind === 'junction') return 'узел';
    return 'свободный конец';
  };
  return (
    <div>
      <h3>Провод</h3>
      <dl className="meta">
        <dt>Соединяет</dt><dd>{endText(wire.a)} — {endText(wire.b)}</dd>
        <dt>Форма</dt><dd>{wire.manual ? 'задана вручную' : 'прокладывается автоматически'}</dd>
      </dl>
      <NetInfo doc={doc} netId={wireNetId(doc, wire)} />
      <p className="muted small">Ответвление: инструмент «Провод» (W), щелчок по этому проводу. Пересечение проводов без точки — не соединение.</p>
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
