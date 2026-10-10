/**
 * «Электрический ключ» документа: всё, что влияет на расчёт, и ничего лишнего (положения деталей,
 * изгибы проводов, заметки, щупы, плата не входят). Результат расчёта считается актуальным,
 * пока ключ не изменился, — поэтому установка щупа или перемещение детали его не «устаревают».
 */
import type { ProjectDoc } from '../core/model';

export function circuitKey(doc: ProjectDoc): string {
  const s = doc.schematic;
  return JSON.stringify({
    i: s.instances.map((x) => [x.id, x.partId, x.values]),
    n: s.nets.map((x) => [x.id, x.connections]),
    p: doc.library.parts.map((x) => [x.id, x.symbolId, x.modelId, x.ratings]),
    m: doc.library.models,
    y: doc.library.symbols.map((x) => [x.id, x.pins.map((q) => [q.number, q.electricalType])]),
    t: doc.simulation,
  });
}
