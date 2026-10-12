/**
 * Проверка ссылочной целостности документа (инварианты из ARCHITECTURE.md, раздел 2).
 * Ничего не исправляет — только сообщает. Исправлять молча запрещено правилами проекта.
 */
import { netsMismatch } from './connectivity';
import type { ProjectDoc } from './model';

export interface IntegrityIssue {
  code:
    | 'duplicate-id'
    | 'dangling-ref'
    | 'unknown-pin'
    | 'duplicate-pin-map'
    | 'pin-in-several-nets'
    | 'duplicate-refdes'
    | 'nets-mismatch'
    | 'group';
  message: string;
  ids: string[];
}

/** Все сущности документа с их «адресом» — для поиска повторов UUID. */
export function collectEntityIds(doc: ProjectDoc): Array<{ id: string; where: string }> {
  const out: Array<{ id: string; where: string }> = [{ id: doc.id, where: 'проект' }];
  const add = (list: Array<{ id: string }>, where: string) => {
    for (const e of list) out.push({ id: e.id, where });
  };
  add(doc.schematic.instances, 'schematic.instances');
  add(doc.schematic.nets, 'schematic.nets');
  add(doc.schematic.wires, 'schematic.wires');
  add(doc.schematic.junctions, 'schematic.junctions');
  add(doc.schematic.labels, 'schematic.labels');
  add(doc.schematic.groups, 'schematic.groups');
  add(doc.schematic.annotations, 'schematic.annotations');
  add(doc.library.symbols, 'library.symbols');
  add(doc.library.parts, 'library.parts');
  add(doc.library.packages, 'library.packages');
  add(doc.library.models, 'library.models');
  if (doc.pcb.board) out.push({ id: doc.pcb.board.id, where: 'pcb.board' });
  add(doc.pcb.placements, 'pcb.placements');
  add(doc.pcb.tracks, 'pcb.tracks');
  add(doc.pcb.vias, 'pcb.vias');
  add(doc.pcb.pours, 'pcb.pours');
  add(doc.tests, 'tests');
  for (const t of doc.tests) { add(t.measurements, 'tests.measurements'); add(t.events, 'tests.events'); }
  add(doc.attachments, 'attachments');
  add(doc.changelog, 'changelog');
  add(doc.checks.items, 'checks.items');
  return out;
}

export function checkIntegrity(doc: ProjectDoc): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];

  // 1. Уникальность UUID во всём документе
  const seen = new Map<string, string>();
  for (const { id, where } of collectEntityIds(doc)) {
    const prev = seen.get(id);
    if (prev !== undefined) {
      issues.push({ code: 'duplicate-id', message: `Повторяющийся ID ${id}: ${prev} и ${where}`, ids: [id] });
    } else {
      seen.set(id, where);
    }
  }

  const dangling = (from: string, field: string, target: string) =>
    issues.push({ code: 'dangling-ref', message: `${from}: ${field} ссылается на несуществующий объект ${target}`, ids: [from, target] });

  const symbols = new Map(doc.library.symbols.map((s) => [s.id, s]));
  const packages = new Map(doc.library.packages.map((p) => [p.id, p]));
  const models = new Set(doc.library.models.map((m) => m.id));
  const parts = new Map(doc.library.parts.map((p) => [p.id, p]));
  const instances = new Map(doc.schematic.instances.map((i) => [i.id, i]));
  const nets = new Set(doc.schematic.nets.map((n) => n.id));

  // 2–3. Детали библиотеки
  for (const part of doc.library.parts) {
    const sym = symbols.get(part.symbolId);
    if (!sym) dangling(part.id, 'symbolId', part.symbolId);
    if (part.modelId !== null && !models.has(part.modelId)) dangling(part.id, 'modelId', part.modelId);
    for (const pk of part.packages) {
      const pkg = packages.get(pk.packageId);
      if (!pkg) { dangling(part.id, 'packages.packageId', pk.packageId); continue; }
      const pads = new Set(pkg.pads.map((p) => p.number));
      const symPins = new Set(sym?.pins.map((p) => p.number) ?? []);
      const usedSym = new Set<string>();
      const usedPad = new Set<string>();
      for (const m of pk.pinMap) {
        if (sym && !symPins.has(m.symbolPin)) {
          issues.push({ code: 'unknown-pin', message: `Деталь ${part.name}: вывода символа «${m.symbolPin}» нет в символе`, ids: [part.id] });
        }
        if (!pads.has(m.pad)) {
          issues.push({ code: 'unknown-pin', message: `Деталь ${part.name}: площадки «${m.pad}» нет в корпусе ${pkg.name}`, ids: [part.id, pkg.id] });
        }
        if (usedSym.has(m.symbolPin) || usedPad.has(m.pad)) {
          issues.push({ code: 'duplicate-pin-map', message: `Деталь ${part.name}, корпус ${pkg.name}: повтор в соответствии выводов (${m.symbolPin} ↔ ${m.pad})`, ids: [part.id, pkg.id] });
        }
        usedSym.add(m.symbolPin);
        usedPad.add(m.pad);
      }
    }
  }

  // Экземпляры
  const refDes = new Map<string, string>();
  for (const inst of doc.schematic.instances) {
    if (!parts.has(inst.partId)) dangling(inst.id, 'partId', inst.partId);
    const prev = refDes.get(inst.refDes);
    if (prev) issues.push({ code: 'duplicate-refdes', message: `Позиционное обозначение ${inst.refDes} повторяется`, ids: [prev, inst.id] });
    else refDes.set(inst.refDes, inst.id);
  }

  // 4. Сети: выводы существуют и каждый вывод — в одной сети
  const pinOwner = new Map<string, string>();
  for (const net of doc.schematic.nets) {
    for (const c of net.connections) {
      const inst = instances.get(c.instanceId);
      if (!inst) { dangling(net.id, 'connections.instanceId', c.instanceId); continue; }
      const part = parts.get(inst.partId);
      const sym = part ? symbols.get(part.symbolId) : undefined;
      if (sym && !sym.pins.some((p) => p.number === c.pin)) {
        issues.push({ code: 'unknown-pin', message: `Сеть ${net.name ?? net.id}: у ${inst.refDes} нет вывода «${c.pin}»`, ids: [net.id, inst.id] });
      }
      const key = `${c.instanceId}#${c.pin}`;
      const owner = pinOwner.get(key);
      if (owner && owner !== net.id) {
        issues.push({ code: 'pin-in-several-nets', message: `Вывод ${inst.refDes}.${c.pin} входит в несколько сетей`, ids: [owner, net.id] });
      }
      pinOwner.set(key, net.id);
    }
  }
  // Провода: концы ссылаются на существующие выводы, узлы и метки.
  const junctionIds = new Set(doc.schematic.junctions.map((j) => j.id));
  const labelIds = new Set(doc.schematic.labels.map((l) => l.id));
  let wireRefsOk = true;
  for (const w of doc.schematic.wires) {
    for (const end of [w.a, w.b]) {
      if (end.kind === 'pin') {
        const inst = instances.get(end.instanceId);
        if (!inst) { dangling(w.id, 'конец провода (деталь)', end.instanceId); wireRefsOk = false; continue; }
        const part = parts.get(inst.partId);
        const sym = part ? symbols.get(part.symbolId) : undefined;
        if (sym && !sym.pins.some((p) => p.number === end.pin)) {
          issues.push({ code: 'unknown-pin', message: `Провод ${w.id}: у ${inst.refDes} нет вывода «${end.pin}»`, ids: [w.id, inst.id] });
          wireRefsOk = false;
        }
      } else if (end.kind === 'junction' && !junctionIds.has(end.junctionId)) { dangling(w.id, 'конец провода (узел)', end.junctionId); wireRefsOk = false; }
      else if (end.kind === 'label' && !labelIds.has(end.labelId)) { dangling(w.id, 'конец провода (метка)', end.labelId); wireRefsOk = false; }
    }
  }
  // Сети — производные от графа и обязаны с ним совпадать.
  if (wireRefsOk && issues.length === 0) {
    for (const m of netsMismatch(doc)) issues.push({ code: 'nets-mismatch', message: m, ids: [] });
  }
  // Группы: члены существуют, объект — не более чем в одной группе.
  const inGroup = new Map<string, string>();
  for (const g of doc.schematic.groups) {
    for (const m of g.memberIds) {
      if (!seen.has(m)) dangling(g.id, 'memberIds', m);
      const prev = inGroup.get(m);
      if (prev && prev !== g.id) issues.push({ code: 'group', message: `Объект ${m} входит в несколько групп`, ids: [prev, g.id] });
      inGroup.set(m, g.id);
    }
  }
  for (const a of doc.schematic.annotations) {
    if (a.targetId !== null && !seen.has(a.targetId)) dangling(a.id, 'targetId', a.targetId);
  }

  // Плата
  // Плата синхронизируется со схемой явно (ТЗ): между изменением схемы и синхронизацией размещение
  // может ссылаться на удалённую деталь, а дорожка — на исчезнувшую цепь. Это не нарушение целостности,
  // а «несинхронизированное» состояние: его показывают отчёт синхронизации и DRC. Корпус и площадки
  // при этом обязаны существовать.
  for (const pl of doc.pcb.placements) {
    if (!packages.has(pl.packageId)) dangling(pl.id, 'packageId', pl.packageId);
    const inst = instances.get(pl.instanceId);
    if (!inst) continue;
    const part = parts.get(inst.partId);
    if (part && !part.packages.some((p) => p.packageId === pl.packageId)) {
      dangling(pl.id, 'packageId (не входит в корпуса детали)', pl.packageId);
    }
  }
  const placements = new Map(doc.pcb.placements.map((p) => [p.id, p]));
  const vias = new Set(doc.pcb.vias.map((v) => v.id));
  for (const t of doc.pcb.tracks) {
    for (const end of [t.from, t.to]) {
      if (!end) continue;
      if (end.kind === 'via') { if (!vias.has(end.viaId)) dangling(t.id, 'from/to.viaId', end.viaId); continue; }
      const pl = placements.get(end.placementId);
      if (!pl) { dangling(t.id, 'from/to.placementId', end.placementId); continue; }
      const pkg = packages.get(pl.packageId);
      if (pkg && !pkg.pads.some((p) => p.number === end.pad)) {
        issues.push({ code: 'unknown-pin', message: `Дорожка ${t.id}: площадки «${end.pad}» нет в корпусе ${pkg.name}`, ids: [t.id] });
      }
    }
  }

  // Журнал испытаний: фото должны быть среди вложений проекта. Ссылки на узлы и детали — история:
  // деталь могли потом удалить, это не нарушение целостности.
  const att = new Set(doc.attachments.map((a) => a.id));
  for (const t of doc.tests) for (const pid of t.photoIds) if (!att.has(pid)) dangling(t.id, 'photoIds', pid);

  return issues;
}
