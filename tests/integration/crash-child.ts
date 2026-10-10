/**
 * Дочерний процесс для тестов аварийного завершения. Режимы:
 *  autosave-then-kill <root> <projectId>  — добавить заметки, автосохранить, убить себя SIGKILL;
 *  hammer <root> <projectId>               — бесконечно сохранять/автосохранять (родитель убивает в случайный момент).
 */
import { addAnnotation } from '../../src/core/factory';
import { DataStore } from '../../src/storage/store';

const [mode, root, projectId] = process.argv.slice(2) as [string, string, string];

async function main() {
  const store = await DataStore.open(root, { ignoreLiveLock: true });
  let { doc } = await store.openProject(projectId);
  if (mode === 'autosave-then-kill') {
    doc = addAnnotation(doc, { x: 10, y: 10 }, 'несохранённая 1').doc;
    doc = addAnnotation(doc, { x: 20, y: 20 }, 'несохранённая 2').doc;
    await store.autosave(doc);
    process.kill(process.pid, 'SIGKILL');
  }
  if (mode === 'hammer') {
    process.stdout.write('ready\n');
    for (let i = 0; ; i++) {
      doc = addAnnotation(doc, { x: i, y: i }, `заметка ${i} `.repeat(50)).doc;
      if (i % 3 === 0) await store.saveProject(doc);
      else await store.autosave(doc);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
