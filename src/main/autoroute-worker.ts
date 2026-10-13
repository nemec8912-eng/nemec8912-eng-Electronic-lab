/**
 * Автотрассировка в отдельном потоке: окно программы не замирает, трассировку можно остановить
 * (главный процесс завершает поток). Сообщения: progress — номер попытки, done — результат, error.
 */
import { parentPort } from 'node:worker_threads';
import { autoroute, type AutorouteOptions } from '../core/autoroute';
import type { ProjectDoc } from '../core/model';

parentPort!.once('message', (msg: { doc: ProjectDoc; opts: Omit<AutorouteOptions, 'onProgress'> }) => {
  try {
    const result = autoroute(msg.doc, { ...msg.opts, onProgress: (done, total) => parentPort!.postMessage({ type: 'progress', done, total }) });
    parentPort!.postMessage({ type: 'done', result });
  } catch (e) {
    parentPort!.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});
