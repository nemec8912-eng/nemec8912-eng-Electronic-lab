/**
 * Список соединений (netlist) — единый интерфейс передачи схемы в расчёт и на плату. Строится по
 * сетям (они производные от графа связности) и соответствию «вывод ↔ площадка» выбранного корпуса.
 * Расчёт (src/sim/netlist.ts) и плата (src/core/pcb.ts) работают с теми же UUID сетей.
 */
import { netDisplayName } from './connectivity';
import { formatQuantity, PARAMS } from './library';
import type { ProjectDoc } from './model';
import { symbolOf } from './schematic';

export interface NetlistComponent {
  instanceId: string;
  refDes: string;
  part: string;
  partNumber: string | null;
  value: string;
  /** Корпус для платы: размещённый на плате или первый из корпусов детали. */
  package: string | null;
  hasModel: boolean;
}

export interface NetlistNet {
  netId: string;
  name: string;
  nodes: Array<{ instanceId: string; refDes: string; pin: string; pinName: string; pad: string | null }>;
}

export interface ConnectionList {
  project: string;
  revision: number;
  components: NetlistComponent[];
  nets: NetlistNet[];
}

export function connectionList(doc: ProjectDoc): ConnectionList {
  const parts = new Map(doc.library.parts.map((p) => [p.id, p]));
  const pkgName = new Map(doc.library.packages.map((p) => [p.id, p.name]));
  const placementPkg = new Map(doc.pcb.placements.map((pl) => [pl.instanceId, pl.packageId]));
  const instById = new Map(doc.schematic.instances.map((i) => [i.id, i]));
  const pkgOf = (instanceId: string): string | null => {
    const inst = instById.get(instanceId);
    const part = inst ? parts.get(inst.partId) : undefined;
    return placementPkg.get(instanceId) ?? part?.packages[0]?.packageId ?? null;
  };
  const components: NetlistComponent[] = doc.schematic.instances
    .filter((i) => parts.get(i.partId)?.category !== 'reference')
    .map((i) => {
      const part = parts.get(i.partId);
      const value = Object.entries(i.values).map(([k, q]) => formatQuantity(q.value, PARAMS[k]?.unitRu ?? q.unit)).join(', ');
      const pk = pkgOf(i.id);
      return { instanceId: i.id, refDes: i.refDes, part: part?.name ?? '?', partNumber: part?.partNumber ?? null, value, package: pk ? pkgName.get(pk) ?? null : null, hasModel: !!part?.modelId };
    })
    .sort((a, b) => a.refDes.localeCompare(b.refDes, 'ru', { numeric: true }));
  const nets: NetlistNet[] = doc.schematic.nets.map((n) => ({
    netId: n.id,
    name: netDisplayName(doc, n),
    nodes: n.connections.map((c) => {
      const inst = instById.get(c.instanceId);
      const part = inst ? parts.get(inst.partId) : undefined;
      const pk = pkgOf(c.instanceId);
      const pad = pk ? part?.packages.find((x) => x.packageId === pk)?.pinMap.find((m) => m.symbolPin === c.pin)?.pad ?? null : null;
      const pinName = inst ? symbolOf(doc, inst)?.pins.find((x) => x.number === c.pin)?.name ?? '' : '';
      return { instanceId: c.instanceId, refDes: inst?.refDes ?? '?', pin: c.pin, pinName, pad };
    }).sort((a, b) => a.refDes.localeCompare(b.refDes, 'ru', { numeric: true }) || a.pin.localeCompare(b.pin, 'en', { numeric: true })),
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  return { project: doc.name, revision: doc.revision, components, nets };
}

/** Текстовый список соединений для печати и сверки с платой. */
export function connectionListText(doc: ProjectDoc, now = new Date()): string {
  const cl = connectionList(doc);
  const lines = [
    `Список соединений — ${cl.project}`,
    `Ревизия ${cl.revision} · ${now.toLocaleString('ru-RU')}`,
    '',
    'Детали:',
    ...cl.components.map((c) => `  ${c.refDes.padEnd(8)} ${c.part}${c.partNumber ? ` (${c.partNumber})` : ''}${c.value ? `, ${c.value}` : ''}${c.package ? ` · корпус ${c.package}` : ' · корпус не задан'}${c.hasModel ? '' : ' · нет модели'}`),
    '',
    'Цепи:',
    ...cl.nets.map((n) => `  ${n.name}: ${n.nodes.map((x) => `${x.refDes}.${x.pin}${x.pinName && x.pinName !== x.pin ? `(${x.pinName})` : ''}${x.pad && x.pad !== x.pin ? `[пл. ${x.pad}]` : ''}`).join(', ')}`),
    '',
  ];
  return lines.join('\n');
}
