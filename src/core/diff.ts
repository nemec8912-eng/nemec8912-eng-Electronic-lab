/**
 * Сравнение двух ревизий проекта (этап 7): что изменилось в схеме, деталях и моделях, соединениях,
 * на плате и в настройках расчёта. Сравнение по UUID, а не по координатам; соединения — по составу
 * цепей (какие выводы каких деталей в них входят), поэтому перерисовка проводов изменением не считается.
 */
import { netDisplayName } from './connectivity';
import { formatQuantity, PARAMS } from './library';
import type { PartDef, ProjectDoc } from './model';

export interface DiffItem { section: 'Детали' | 'Номиналы' | 'Модели и сведения' | 'Соединения' | 'Плата' | 'Расчёт'; text: string }

const q = (key: string, v: number) => formatQuantity(v, PARAMS[key]?.unitRu ?? '', 4);

function partSummary(doc: ProjectDoc, part: PartDef): Record<string, string> {
  const model = part.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
  return {
    'модель': model ? `${model.name}\n${model.text}` : 'нет',
    'модель проверена': model ? (model.verified ? 'да' : 'нет') : '—',
    'допуск': part.tolerancePct === null ? 'не указан' : `${part.tolerancePct} %`,
    'пределы': JSON.stringify(part.ratings),
    'корпуса': part.packages.map((p) => doc.library.packages.find((x) => x.id === p.packageId)?.name ?? '?').join(', '),
    'соответствие выводов': JSON.stringify(part.packages.map((p) => p.pinMap)),
    'название': part.name,
  };
}

export function diffDocs(a: ProjectDoc, b: ProjectDoc): DiffItem[] {
  const out: DiffItem[] = [];
  const instA = new Map(a.schematic.instances.map((i) => [i.id, i]));
  const instB = new Map(b.schematic.instances.map((i) => [i.id, i]));
  const partName = (d: ProjectDoc, partId: string) => d.library.parts.find((p) => p.id === partId)?.name ?? '?';

  for (const [id, i] of instB) if (!instA.has(id)) out.push({ section: 'Детали', text: `Добавлена ${i.refDes} (${partName(b, i.partId)})` });
  for (const [id, i] of instA) if (!instB.has(id)) out.push({ section: 'Детали', text: `Удалена ${i.refDes} (${partName(a, i.partId)})` });
  for (const [id, x] of instA) {
    const y = instB.get(id);
    if (!y) continue;
    if (x.refDes !== y.refDes) out.push({ section: 'Детали', text: `${x.refDes} переименована в ${y.refDes}` });
    if (x.partId !== y.partId) out.push({ section: 'Детали', text: `${y.refDes}: деталь «${partName(a, x.partId)}» → «${partName(b, y.partId)}»` });
    for (const key of new Set([...Object.keys(x.values), ...Object.keys(y.values)])) {
      const va = x.values[key]?.value, vb = y.values[key]?.value;
      if (va === vb) continue;
      const label = PARAMS[key]?.label ?? key;
      out.push({ section: 'Номиналы', text: `${y.refDes}: ${label.toLowerCase()} ${va === undefined ? '—' : q(key, va)} → ${vb === undefined ? '—' : q(key, vb)}` });
    }
  }

  // Детали проекта (сведения, модели): только те, что используются в обеих ревизиях
  for (const pb of b.library.parts) {
    const pa = a.library.parts.find((p) => p.id === pb.id);
    if (!pa) continue;
    const sa = partSummary(a, pa), sb = partSummary(b, pb);
    const changed = Object.keys(sb).filter((k) => sa[k] !== sb[k]);
    if (changed.length) {
      const users = b.schematic.instances.filter((i) => i.partId === pb.id).map((i) => i.refDes);
      out.push({ section: 'Модели и сведения', text: `«${pb.name}»${users.length ? ` (${users.join(', ')})` : ''}: изменено — ${changed.join(', ')}` });
    }
  }

  // Соединения: состав цепей по выводам «R1.1»
  const sig = (d: ProjectDoc) => {
    const ref = new Map(d.schematic.instances.map((i) => [i.id, i.refDes]));
    const byPin = new Map<string, string>();
    for (const n of d.schematic.nets) for (const c of n.connections) byPin.set(`${c.instanceId}#${c.pin}`, n.id);
    return { ref, byPin, nets: d.schematic.nets };
  };
  const A = sig(a), B = sig(b);
  const pinName = (key: string) => {
    const [iid, pin] = key.split('#');
    return `${B.ref.get(iid!) ?? A.ref.get(iid!) ?? '?'}.${pin}`;
  };
  // Пары выводов, соединённые в одной ревизии и разъединённые в другой (среди деталей, что есть в обеих).
  // Вывод без соединений — сам себе «цепь».
  const both = new Set([...instA.keys()].filter((id) => instB.has(id)));
  const common = [...new Set([...A.byPin.keys(), ...B.byPin.keys()])].filter((k) => both.has(k.split('#')[0]!));
  for (const k of common) { if (!A.byPin.has(k)) A.byPin.set(k, `solo:${k}`); if (!B.byPin.has(k)) B.byPin.set(k, `solo:${k}`); }
  const groupA = new Map<string, string[]>(), groupB = new Map<string, string[]>();
  for (const k of common) {
    groupA.set(A.byPin.get(k)!, [...(groupA.get(A.byPin.get(k)!) ?? []), k]);
    groupB.set(B.byPin.get(k)!, [...(groupB.get(B.byPin.get(k)!) ?? []), k]);
  }
  const seen = new Set<string>();
  for (const g of groupA.values()) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      if (B.byPin.get(g[i]!) !== B.byPin.get(g[j]!)) {
        const t = `${pinName(g[i]!)} и ${pinName(g[j]!)} больше не соединены`;
        if (!seen.has(t)) { seen.add(t); out.push({ section: 'Соединения', text: t }); }
      }
    }
  }
  for (const g of groupB.values()) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      if (A.byPin.get(g[i]!) !== A.byPin.get(g[j]!)) {
        const t = `${pinName(g[i]!)} и ${pinName(g[j]!)} теперь соединены`;
        if (!seen.has(t)) { seen.add(t); out.push({ section: 'Соединения', text: t }); }
      }
    }
  }
  for (const n of B.nets) {
    const old = A.nets.find((x) => x.id === n.id);
    if (old && (old.name ?? null) !== (n.name ?? null)) out.push({ section: 'Соединения', text: `Цепь «${netDisplayName(a, old)}» названа «${netDisplayName(b, n)}»` });
  }

  // Плата
  const ba = a.pcb.board, bb = b.pcb.board;
  if (!ba && bb) out.push({ section: 'Плата', text: 'Плата создана' });
  if (ba && bb) {
    if (ba.widthMm !== bb.widthMm || ba.heightMm !== bb.heightMm) out.push({ section: 'Плата', text: `Размер ${ba.widthMm} × ${ba.heightMm} → ${bb.widthMm} × ${bb.heightMm} мм` });
    if (ba.layers !== bb.layers) out.push({ section: 'Плата', text: `Слоёв меди: ${ba.layers} → ${bb.layers}` });
    if (JSON.stringify(ba.rules) !== JSON.stringify(bb.rules)) out.push({ section: 'Плата', text: 'Изменены правила проектирования' });
  }
  const plA = new Map(a.pcb.placements.map((p) => [p.id, p]));
  let moved = 0;
  for (const p of b.pcb.placements) {
    const o = plA.get(p.id);
    const ref = instB.get(p.instanceId)?.refDes ?? instA.get(p.instanceId)?.refDes ?? '?';
    if (!o) out.push({ section: 'Плата', text: `На плату добавлена ${ref}` });
    else if (o.position.x !== p.position.x || o.position.y !== p.position.y || o.rotation !== p.rotation || o.side !== p.side) moved++;
    else if (o.packageId !== p.packageId) out.push({ section: 'Плата', text: `${ref}: сменён корпус` });
  }
  for (const p of a.pcb.placements) if (!b.pcb.placements.some((x) => x.id === p.id)) out.push({ section: 'Плата', text: `С платы убрана ${instA.get(p.instanceId)?.refDes ?? 'деталь'}` });
  if (moved) out.push({ section: 'Плата', text: `Перемещено или повёрнуто деталей: ${moved}` });
  const tracks = (d: ProjectDoc) => new Map(d.pcb.tracks.map((t) => [t.id, JSON.stringify([t.points, t.widthMm, t.layer])]));
  const ta = tracks(a), tb = tracks(b);
  const addedT = [...tb.keys()].filter((k) => !ta.has(k)).length, removedT = [...ta.keys()].filter((k) => !tb.has(k)).length;
  const changedT = [...tb.entries()].filter(([k, v]) => ta.has(k) && ta.get(k) !== v).length;
  if (addedT || removedT || changedT) out.push({ section: 'Плата', text: `Дорожки: добавлено ${addedT}, удалено ${removedT}, изменено ${changedT}` });
  if (a.pcb.vias.length !== b.pcb.vias.length) out.push({ section: 'Плата', text: `Переходных отверстий: ${a.pcb.vias.length} → ${b.pcb.vias.length}` });
  if (a.pcb.jumpers.length !== b.pcb.jumpers.length) out.push({ section: 'Плата', text: `Перемычек: ${a.pcb.jumpers.length} → ${b.pcb.jumpers.length}` });

  if (JSON.stringify(a.simulation) !== JSON.stringify(b.simulation)) out.push({ section: 'Расчёт', text: 'Изменены настройки расчёта' });
  return out;
}
