/**
 * Изменение детали внутри проекта (этап 7, ТЗ раздел 9): характеристики, модель, корпуса, выводы.
 * Правка локальна для проекта — общий каталог не меняется; перенос в каталог — отдельным действием
 * с подтверждением. Правка записывается в журнал изменений и отменяется Ctrl+Z.
 * Защита связей: нельзя убрать вывод, к которому на схеме подведён провод, и корпус, стоящий на плате.
 */
import { lintBundle, type PartBundle } from './catalog';
import { logChange, touch } from './factory';
import { isUuid, newId } from './ids';
import type { ProjectDoc } from './model';

export function replaceProjectPart(doc: ProjectDoc, b: PartBundle): { doc: ProjectDoc; error: string | null; changes: string[] } {
  const old = doc.library.parts.find((p) => p.id === b.part.id);
  if (!old) return { doc, error: 'Деталь не найдена в проекте', changes: [] };
  const users = doc.schematic.instances.filter((i) => i.partId === old.id);
  const userIds = new Set(users.map((u) => u.id));
  // Выводы, к которым подведены провода, должны остаться.
  const pins = new Set(b.symbol.pins.map((p) => p.number));
  for (const w of doc.schematic.wires) for (const e of [w.a, w.b]) {
    if (e.kind === 'pin' && userIds.has(e.instanceId) && !pins.has(e.pin)) {
      const ref = users.find((u) => u.id === e.instanceId)!.refDes;
      return { doc, error: `${ref}: к выводу ${e.pin} подключён провод — сначала отключите его на схеме, затем удаляйте вывод`, changes: [] };
    }
  }
  // Корпус, стоящий на плате, должен остаться среди корпусов детали.
  const pkgIds = new Set(b.part.packages.map((p) => p.packageId));
  for (const pl of doc.pcb.placements) {
    if (!userIds.has(pl.instanceId) || pkgIds.has(pl.packageId)) continue;
    const ref = users.find((u) => u.id === pl.instanceId)!.refDes;
    const name = doc.library.packages.find((p) => p.id === pl.packageId)?.name ?? '?';
    return { doc, error: `${ref}: корпус «${name}» стоит на плате. Оставьте его в детали или сначала уберите деталь с платы`, changes: [] };
  }

  const errors = lintBundle(b, [], []).filter((l) => l.severity === 'error');
  if (errors.length) return { doc, error: `Деталь не сохранена: ${errors.map((e) => e.message).join('; ')}`, changes: [] };

  // Новые id для новых сущностей (редактор мог создать модель или корпус без id проекта).
  const used = new Set([...doc.library.models.map((m) => m.id), ...doc.library.packages.map((p) => p.id)]);
  const model = b.model ? { ...b.model, id: isUuid(b.model.id) && (b.model.id === old.modelId || !used.has(b.model.id)) ? b.model.id : newId() } : null;
  const packages = b.packages.map((p) => {
    const keep = isUuid(p.id) && (old.packages.some((x) => x.packageId === p.id) || !used.has(p.id));
    return keep ? p : { ...p, id: newId() };
  });
  const pkgMap = new Map(b.packages.map((p, i) => [p.id, packages[i]!.id]));
  const part = { ...b.part, symbolId: old.symbolId, modelId: model?.id ?? null, packages: b.part.packages.map((x) => ({ ...x, packageId: pkgMap.get(x.packageId) ?? x.packageId })) };
  const symbol = { ...b.symbol, id: old.symbolId };

  const oldModel = old.modelId ? doc.library.models.find((m) => m.id === old.modelId) : undefined;
  const changes: string[] = [];
  if (old.name !== part.name) changes.push(`название «${old.name}» → «${part.name}»`);
  if (old.tolerancePct !== part.tolerancePct) changes.push(`допуск ${old.tolerancePct ?? '—'} → ${part.tolerancePct ?? '—'} %`);
  if (JSON.stringify(old.ratings) !== JSON.stringify(part.ratings)) changes.push('пределы');
  if (JSON.stringify(old.values) !== JSON.stringify(part.values)) changes.push('номиналы по умолчанию');
  if (!oldModel && model) changes.push(`добавлена модель «${model.name}»`);
  else if (oldModel && !model) changes.push('модель удалена');
  else if (oldModel && model && (oldModel.text !== model.text || oldModel.verified !== model.verified || oldModel.name !== model.name)) changes.push(`модель «${model.name}»${oldModel.text !== model.text ? ' — текст' : ''}${oldModel.verified !== model.verified ? (model.verified ? ' — отмечена проверенной' : ' — снята отметка «проверена»') : ''}`);
  if (JSON.stringify(old.packages) !== JSON.stringify(part.packages)) changes.push('корпуса или соответствие выводов');
  const oldSym = doc.library.symbols.find((s) => s.id === old.symbolId);
  if (JSON.stringify(oldSym?.pins) !== JSON.stringify(symbol.pins)) changes.push('выводы обозначения');
  if (JSON.stringify(old.origin) !== JSON.stringify(part.origin) || old.datasheetUrl !== part.datasheetUrl) changes.push('источник сведений');
  if (changes.length === 0) return { doc, error: null, changes };

  const replace = <T extends { id: string }>(list: T[], items: T[]) => [...list.filter((x) => !items.some((i) => i.id === x.id)), ...items];
  let library = {
    ...doc.library,
    parts: doc.library.parts.map((p) => (p.id === part.id ? part : p)),
    symbols: replace(doc.library.symbols, [symbol]),
    packages: replace(doc.library.packages, packages),
    models: model ? replace(doc.library.models, [model]) : doc.library.models,
  };
  // Удаляются только модели и корпуса, на которые больше никто не ссылается.
  const usedModels = new Set(library.parts.map((p) => p.modelId).filter(Boolean));
  const usedPkgs = new Set([...library.parts.flatMap((p) => p.packages.map((x) => x.packageId)), ...doc.pcb.placements.map((p) => p.packageId)]);
  library = { ...library, models: library.models.filter((m) => usedModels.has(m.id)), packages: library.packages.filter((p) => usedPkgs.has(p.id)) };
  const refs = users.map((u) => u.refDes).join(', ');
  const next = logChange(touch({ ...doc, library }), 'part-edit', `Деталь «${part.name}»${refs ? ` (${refs})` : ''} изменена в проекте: ${changes.join('; ')}`);
  return { doc: next, error: null, changes };
}
