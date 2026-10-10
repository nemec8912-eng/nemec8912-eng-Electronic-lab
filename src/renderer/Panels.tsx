/** Левая панель (каталог) и правая панель (свойства проекта / выбранного объекта). */
import { useEffect, useState } from 'react';
import type { Annotation, CheckpointInfo, ProjectDoc } from '../core/model';
import { fmtDateTime } from './api';

const CATEGORIES = [
  'Резисторы', 'Конденсаторы', 'Катушки', 'Диоды и стабилитроны', 'Диодные мосты', 'Транзисторы', 'MOSFET',
  'Тиристоры и симисторы', 'Варисторы', 'Предохранители', 'Реле', 'Трансформаторы', 'Разъёмы', 'Переключатели',
  'Источники', 'Датчики', 'Аналоговые ИС', 'Цифровые ИС', 'Микроконтроллеры',
];

export function CatalogPanel() {
  return (
    <aside className="panel left" aria-label="Каталог">
      <h3>Каталог</h3>
      <p className="stage-note small">Каталог реальных компонентов — этап 2. Пока детали недоступны.</p>
      <ul className="catalog-cats" aria-disabled="true">
        {CATEGORIES.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </aside>
  );
}

interface PropsPanelProps {
  doc: ProjectDoc;
  selected: Annotation | null;
  checkpoints: CheckpointInfo[];
  onRename(name: string): void;
  onDescription(text: string): void;
  onNoteText(id: string, text: string): void;
  onNoteDelete(id: string): void;
  onCreateCheckpoint(): void;
  onRestoreCheckpoint(cp: CheckpointInfo): void;
}

const KIND_LABEL: Record<CheckpointInfo['kind'], string> = {
  manual: 'вручную',
  'on-save': 'при сохранении',
  'before-restore': 'перед возвратом',
};

export function PropertiesPanel(p: PropsPanelProps) {
  return (
    <aside className="panel right" aria-label="Свойства">
      {p.selected ? <NoteProps note={p.selected} onText={p.onNoteText} onDelete={p.onNoteDelete} /> : <ProjectProps {...p} />}
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
        <dt>Заметок</dt><dd>{doc.schematic.annotations.length}</dd>
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
