// Генерация примеров проектов в examples/. Запуск: npm run examples
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { addAnnotation, createProject, setDescription } from '../src/core/factory';
import { writeElab } from '../src/storage/elab';

const out = path.resolve(import.meta.dirname, '../examples');

let doc = createProject('Пример — заметки к блоку питания');
doc = setDescription(doc, 'Пример проекта этапа 1: только текстовые заметки. Компоненты и соединения появятся на этапе 3.');
const notes: Array<[number, number, string]> = [
  [40, 40, 'Вход: ~230 В, предохранитель F1 1 А'],
  [40, 120, 'Диодный мост VD1…VD4 (1N4007)'],
  [320, 120, 'C1 470 мкФ 35 В — после моста'],
  [320, 200, 'Стабилизатор U1 LM317, радиатор обязателен'],
  [40, 280, 'Проверить: пульсации на C1 под нагрузкой 0,5 А'],
];
for (const [x, y, t] of notes) doc = addAnnotation(doc, { x, y }, t).doc;

const buf = await writeElab({ doc, checkpoints: [], attachments: new Map() });
const file = path.join(out, 'пример-заметки-блок-питания.elab');
writeFileSync(file, buf);
console.log(`Записан ${path.relative(process.cwd(), file)} (${buf.length} байт)`);
