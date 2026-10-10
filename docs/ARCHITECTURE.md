# Архитектура «Электронной лаборатории»

Документ описывает границы модулей, модель данных, формат файлов и хранилище. Изменения архитектуры — только через новый ADR в `docs/adr/` и с согласия пользователя.

Решения: [ADR-0001 — оболочка, офлайн, портативность](adr/0001-desktop-shell-and-portability.md).

## 1. Модули и границы

```
┌──────────────────────────── Electron ────────────────────────────┐
│  Главный процесс (Node.js)                 Окно (Chromium)       │
│  src/main      — окно, меню, диалоги, IPC   src/renderer — React │
│  src/storage   — диск, .elab, бэкап   ◄──►  src/preload — мост   │
│        ▲                     IPC (window.elab)        ▲          │
│        └───────── src/core — чистая модель (без Node/DOM) ───────┘
└──────────────────────────────────────────────────────────────────┘
```

| Модуль | Ответственность | Может зависеть от | Не должен |
|---|---|---|---|
| `src/core` | Типы и схема проекта (zod), проверка целостности, миграции форматов, переназначение UUID, история Undo/Redo, операции над документом | ничего, кроме `zod` | обращаться к диску, сети, DOM |
| `src/storage` | Папка данных, атомарная запись, автосохранение и восстановление, контрольные версии, корзина, журнал, формат `.elab`, полный бэкап | `core`, Node `fs/crypto/path`, `jszip` | знать про Electron и интерфейс; ходить в сеть |
| `src/main` | Запуск Electron, определение портативного режима, диалоги выбора файлов, IPC-обработчики, защита от закрытия с несохранёнными изменениями | `storage`, `core`, Electron | содержать бизнес-логику хранения |
| `src/preload` | Узкий типизированный API `window.elab` | Electron `contextBridge` | давать интерфейсу доступ к Node |
| `src/renderer` | Интерфейс: вкладки «Схема/Тест/Плата», каталог, полотно, свойства, кнопки файлов, индикаторы | `core` (типы и чистые функции), `window.elab` | писать на диск напрямую |

Будущие модули (по этапам, отдельными папками): `src/catalog` (этап 2), `src/schematic` (граф связности, ERC — этап 3), `src/sim` (адаптер ngspice — этап 4), `src/instruments` (этап 5), `src/pcb` (этап 6), `src/testlog` (этап 7). Каждый работает с тем же документом проекта и ссылается на сущности только по UUID и номерам выводов.

## 2. Модель данных проекта (schemaVersion 1)

Единственный источник истины — документ проекта `ProjectDoc` (`src/core/model.ts`). У каждой сущности стабильный UUID v4 (`id`). Экранные координаты — только атрибут отображения, связи по ним не определяются.

```
ProjectDoc
├─ schemaVersion: 1, id, name, description, createdAt, updatedAt, revision
├─ schematic
│  ├─ instances[]   ComponentInstance { id, partId, refDes, position, rotation, mirrored, values{имя→Quantity} }
│  ├─ nets[]        Net { id, name|null, connections[ {instanceId, pin} ] }      ← электрическая связность
│  ├─ wires[]       Wire { id, netId, points[] }                                ← только графика провода
│  └─ annotations[] Annotation { id, kind:'text', text, position, targetId|null } ← (д) пользовательские аннотации
├─ library          встроенные определения всего, что использует проект (проект самодостаточен)
│  ├─ symbols[]     SymbolDef  { id, name, standard, pins[ {number, name, electricalType} ] }          ← (а) УГО
│  ├─ parts[]       PartDef    { id, name, category, manufacturer, partNumber, symbolId,                  ← (б) физ. компонент
│  │                             packages[ {packageId, pinMap[ {symbolPin, pad} ]} ], modelId|null,
│  │                             ratings{имя→Quantity}, origin{catalogPartId, source, checkedAt} }
│  ├─ packages[]    PackageDef { id, name, family, pads[ {number} ], pin1Marker }                       ← (в) корпус/footprint
│  └─ models[]      SimModel   { id, name, kind, text, source, verified }                              ← (г) электрическая модель
├─ pcb              { board|null, placements[], tracks[], vias[] }
├─ instruments      { settings }   настройки приборов
├─ tests[]          TestRecord { id, createdAt, revision, conditions, notes, measurements[] }
├─ attachments[]    AttachmentRef { id, fileName, size, sha256, mime }
└─ changelog[]      ChangeEntry { id, at, revision, action, summary }
```

Разделение (а)–(д) из ТЗ соблюдено: символ, деталь, корпус, модель и аннотации — разные сущности. Смена корпуса меняет только `packageId` размещения; соответствие «вывод символа ↔ площадка» задаётся явно в `pinMap` каждого корпуса детали, поэтому назначение выводов не может измениться незаметно.

`Quantity = { value: number, unit: string }` — значение хранится в базовых единицах СИ (`value: 4.7e-5, unit: 'F'`), отображение «47 мкФ» строится интерфейсом.

На этапе 1 используются `name`, `description`, `annotations`, `changelog`; остальные коллекции уже входят в формат (пустые), чтобы будущие этапы не ломали файлы.

### Инварианты (проверяет `checkIntegrity`)

1. Все `id` — корректные UUID и уникальны во всём документе.
2. Ссылки существуют: `instance.partId → parts`, `part.symbolId → symbols`, `part.packages[].packageId → packages`, `part.modelId → models|null`, `net.connections → instances` и вывод есть в символе детали, `wire.netId → nets`, `placement.instanceId → instances` и корпус входит в корпуса детали, `track/via.netId → nets`, `annotation.targetId → любой id|null`.
3. В `pinMap` вывод символа и площадка существуют, без повторов.
4. Один вывод экземпляра — не более чем в одной сети. Позиционные обозначения (`refDes`) уникальны.
5. `revision` — целое ≥ 0, растёт при каждом изменении документа.

Ошибки целостности **не исправляются молча**: файл с повторяющимися ID или висячими ссылками не импортируется, пользователь получает список проблем.

## 3. Миграции

`src/core/migrations.ts`: цепочка шагов `from → to`. При открытии/импорте документ поднимается до текущей `schemaVersion`, затем проходит zod-валидацию и проверку целостности. Документ более новой версии, чем знает программа, не открывается (сообщение «создан более новой версией программы»), ничего не перезаписывается. Версия 0 — формат раннего прототипа, хранится как фикстура `tests/fixtures/project-v0.json` для проверки цепочки.

## 4. Файл проекта `.elab`

ZIP-контейнер:

```
manifest.json          { format: "electronic-lab-project", formatVersion: 1, app{name,version},
                         createdAt, projectId, projectName, schemaVersion,
                         files[ {path, size, sha256} ] }
project.json           ProjectDoc
checkpoints/<id>.json  контрольные версии { id, label, kind, createdAt, revision, doc }
attachments/<id>/<имя> вложения (даташиты, изображения), размер и SHA-256 в manifest
```

Проверки при импорте, по порядку: это ZIP → есть `manifest.json` и `format` совпадает → `formatVersion` поддерживается → пути без `..`, абсолютных путей и повторов → каждый файл из `files[]` есть и SHA-256/размер совпадают → `project.json` мигрирован, валиден, целостен → каждая контрольная версия тоже. Лишние файлы игнорируются с предупреждением. При совпадении `projectId` с уже существующим проектом пользователь выбирает «заменить» (старый уходит в корзину) или «импортировать как копию» (все UUID переназначаются согласованно, связи сохраняются).

## 5. Полный бэкап `.elabbak`

ZIP с `manifest.json` (`format: "electronic-lab-backup"`), всеми проектами (`projects/<id>/project.json`, `autosave.json` если есть, `checkpoints/`, `attachments/`), личным каталогом `library/`, `settings.json`, `journal.jsonl`. Корзина не включается. Восстановление: архив сначала полностью проверяется, затем текущее состояние автоматически сохраняется в `backups/before-restore-<время>.elabbak`, после чего данные заменяются. Отменить восстановление можно, восстановив этот файл.

## 6. Папка данных

```
data/
  meta.json                       { layoutVersion, createdAt }
  session.lock                    признак незавершённого сеанса (удаляется при нормальном выходе)
  projects/<id>/project.json      сохранённое состояние («Сохранить»)
  projects/<id>/project.json.bak  предыдущее сохранённое состояние
  projects/<id>/autosave.json     { autosavedAt, baseRevision, doc } — рабочая копия с несохранёнными изменениями
  projects/<id>/checkpoints/*.json
  projects/<id>/attachments/
  library/catalog.json            личный каталог (наполняется с этапа 2)
  settings.json
  journal.jsonl                   журнал операций (создание, сохранение, импорт, экспорт, бэкап, ошибки)
  trash/<id>-<время>/             удалённые проекты (не стираются сразу)
  backups/                        автоматические копии перед восстановлением
```

Запись файлов атомарная: `файл.tmp` → `fsync` → переименование поверх. Обрывы питания оставляют либо старый, либо новый файл, никогда половину. Остатки `.tmp` при запуске игнорируются.

Сохранение работает в два уровня:

- **Автосохранение** (через ~1,5 с после изменения) пишет `autosave.json`. Индикатор: «Автосохранено ЧЧ:ММ».
- **«Сохранить»** пишет `project.json`, удаляет `autosave.json`, создаёт автоматическую контрольную версию (хранятся последние 20 автоматических; ручные — без ограничения).

Если при открытии проекта найден `autosave.json` новее сохранённой ревизии — предлагается «Восстановить» или «Отбросить». При закрытии окна с несохранёнными изменениями — «Сохранить / Не сохранять / Отмена».

## 7. Undo/Redo

`src/core/history.ts`: неизменяемые снимки документа (структурное разделение при обновлении), до 200 шагов, в пределах сеанса. Каждое изменение документа идёт через одну функцию `applyChange(label, fn)`, которая увеличивает `revision`, обновляет `updatedAt` и кладёт снимок в историю. Контрольные версии — постоянные снимки на диске, переживают закрытие программы.

## 8. IPC (`window.elab`)

Все вызовы асинхронные, ответ `{ ok: true, value } | { ok: false, error: { code, message, details? } }`.

`app.info`, `app.setDirty`, `projects.list/create/open/save/autosave/discardRecovery/rename/duplicate/saveAs/delete`, `checkpoints.list/create/restore`, `files.exportProject/importProject/resolveImportConflict/backupAll/restoreBackup`. Диалоги выбора файлов показывает главный процесс; в тестах они подменяются.

## 9. Безопасность и офлайн

`contextIsolation`, `sandbox`, без `nodeIntegration`; CSP `default-src 'self'`; запрет навигации и новых окон. Модули `core`, `storage`, `main` не используют сетевые API — это проверяется автотестом `tests/unit/no-network.test.ts`. Сеть появится только в модуле импорта деталей (этап 2) и только по действию пользователя.
