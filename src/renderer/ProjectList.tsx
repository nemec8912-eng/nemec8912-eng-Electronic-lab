/** Начальный экран: список проектов и действия над ними. */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { ProjectSummary } from '../shared/api';
import { fmtDateTime } from './api';

interface Props {
  projects: ProjectSummary[];
  loading: boolean;
  onCreate(name: string): void;
  onOpen(id: string): void;
  onRename(p: ProjectSummary): void;
  onDuplicate(p: ProjectSummary): void;
  onDelete(p: ProjectSummary): void;
  onOpenExample(file: string): void;
}

export function ProjectList({ projects, loading, onCreate, onOpen, onRename, onDuplicate, onDelete, onOpenExample }: Props) {
  const [name, setName] = useState('');
  const [examples, setExamples] = useState<Array<{ file: string; name: string; description: string }>>([]);
  useEffect(() => { api().projects.examples().then((r) => { if (r.ok) setExamples(r.value); }).catch(() => undefined); }, []);
  return (
    <div className="project-list">
      <section className="card">
        <h2>Новый проект</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); onCreate(name); setName(''); }}>
          <input aria-label="Название нового проекта" placeholder="Название проекта" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn primary">Создать</button>
        </form>
      </section>

      {examples.length > 0 && (
        <section className="card">
          <h2>Примеры</h2>
          <ul className="examples-list" aria-label="Примеры">
            {examples.map((x) => (
              <li key={x.file}>
                <div className="project-open static">
                  <span className="example-name">{x.name.replace(/^Пример — /, '')}</span>
                  <span className="project-meta">{x.description}</span>
                </div>
                <div className="project-actions">
                  <button className="btn small" onClick={() => onOpenExample(x.file)} aria-label={`Открыть пример ${x.name}`}>Открыть копию</button>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted small">Открывается копия примера — её можно менять, сам пример остаётся прежним.</p>
        </section>
      )}

      <section className="card">
        <h2>Проекты {loading ? '…' : `(${projects.length})`}</h2>
        {projects.length === 0 && !loading && <p className="muted">Проектов пока нет. Создайте новый или импортируйте файл .elab.</p>}
        <ul className="projects" aria-label="Список проектов">
          {projects.map((p) => (
            <li key={p.id} className={p.error ? 'broken' : ''} data-project-id={p.id}>
              <button className="project-open" disabled={!!p.error} onClick={() => onOpen(p.id)} title="Открыть">
                <span className="project-name">{p.name}</span>
                <span className="project-meta">
                  {p.error ? `Не читается: ${p.error}` : `Изменён ${fmtDateTime(p.updatedAt)}`}
                </span>
                {p.hasRecovery && <span className="badge warn">Есть несохранённые изменения</span>}
              </button>
              <div className="project-actions">
                <button className="btn small" disabled={!!p.error} onClick={() => onRename(p)}>Переименовать</button>
                <button className="btn small" disabled={!!p.error} onClick={() => onDuplicate(p)}>Дублировать</button>
                <button className="btn small danger" onClick={() => onDelete(p)}>Удалить</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
