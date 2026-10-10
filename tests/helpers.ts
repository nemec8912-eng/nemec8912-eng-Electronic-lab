import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { addAnnotation, createProject } from '../src/core/factory';
import { newId } from '../src/core/ids';
import type { ProjectDoc } from '../src/core/model';

export async function tempDir(prefix = 'elab-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Документ со всеми видами связей: символ ↔ деталь ↔ корпус (pinMap) ↔ модель, экземпляры, сети, провода,
 * размещения на плате, дорожки, испытание, аннотация. Нужен, чтобы проверять, что импорт/экспорт и
 * переназначение ID не теряют связи выводов, сетей и корпусов.
 */
export function makeRichDoc(name = 'Делитель'): ProjectDoc {
  let doc = createProject(name);
  const symR = newId(), pkg0805 = newId(), pkgAxial = newId(), modelR = newId(), partR = newId();
  const r1 = newId(), r2 = newId(), netIn = newId(), netMid = newId(), netGnd = newId();
  doc = {
    ...doc,
    library: {
      symbols: [{ id: symR, name: 'Резистор', standard: 'IEC 60617', pins: [
        { number: '1', name: '1', electricalType: 'passive' },
        { number: '2', name: '2', electricalType: 'passive' },
      ] }],
      packages: [
        { id: pkg0805, name: '0805', family: 'SMD', pads: [{ number: '1' }, { number: '2' }], pin1Marker: null },
        { id: pkgAxial, name: 'Выводной 0.4"', family: 'THT', pads: [{ number: 'A' }, { number: 'B' }], pin1Marker: null },
      ],
      models: [{ id: modelR, name: 'R', kind: 'spice-primitive', text: 'R {n1} {n2} {value}', source: null, verified: true }],
      parts: [{
        id: partR, name: 'Резистор 0.125 Вт', category: 'resistor', manufacturer: null, partNumber: null, symbolId: symR,
        packages: [
          { packageId: pkg0805, pinMap: [{ symbolPin: '1', pad: '1' }, { symbolPin: '2', pad: '2' }] },
          { packageId: pkgAxial, pinMap: [{ symbolPin: '1', pad: 'B' }, { symbolPin: '2', pad: 'A' }] },
        ],
        modelId: modelR, ratings: { power: { value: 0.125, unit: 'W' } },
        origin: { catalogPartId: newId(), source: 'вручную', checkedAt: null },
      }],
    },
    schematic: {
      instances: [
        { id: r1, partId: partR, refDes: 'R1', position: { x: 100, y: 100 }, rotation: 0, mirrored: false, values: { resistance: { value: 10000, unit: 'Ω' } } },
        { id: r2, partId: partR, refDes: 'R2', position: { x: 100, y: 200 }, rotation: 90, mirrored: false, values: { resistance: { value: 4700, unit: 'Ω' } } },
      ],
      nets: [
        { id: netIn, name: 'IN', connections: [{ instanceId: r1, pin: '1' }] },
        { id: netMid, name: 'OUT', connections: [{ instanceId: r1, pin: '2' }, { instanceId: r2, pin: '1' }] },
        { id: netGnd, name: 'GND', connections: [{ instanceId: r2, pin: '2' }] },
      ],
      wires: [{ id: newId(), netId: netMid, points: [{ x: 100, y: 130 }, { x: 100, y: 170 }] }],
      annotations: [],
    },
    pcb: {
      board: { id: newId(), widthMm: 50, heightMm: 30, layers: 1 },
      placements: [
        { id: newId(), instanceId: r1, packageId: pkgAxial, position: { x: 10, y: 10 }, rotation: 0, side: 'top' },
        { id: newId(), instanceId: r2, packageId: pkg0805, position: { x: 20, y: 10 }, rotation: 90, side: 'bottom' },
      ],
      tracks: [{ id: newId(), netId: netMid, layer: 'bottom', widthMm: 0.8, points: [{ x: 12, y: 10 }, { x: 20, y: 10 }] }],
      vias: [],
    },
    tests: [{ id: newId(), createdAt: new Date().toISOString(), revision: 0, conditions: '5 В', notes: '', measurements: [
      { id: newId(), target: 'OUT', quantity: { value: 1.6, unit: 'V' }, instrument: 'мультиметр' },
    ] }],
  };
  doc = addAnnotation(doc, { x: 40, y: 40 }, 'Проверить делитель').doc;
  return doc;
}

/** Структурное описание связей без UUID — для сравнения до и после переназначения ID. */
export function linkSignature(doc: ProjectDoc): unknown {
  const parts = new Map(doc.library.parts.map((p) => [p.id, p]));
  const pkgs = new Map(doc.library.packages.map((p) => [p.id, p]));
  const inst = new Map(doc.schematic.instances.map((i) => [i.id, i]));
  const nets = new Map(doc.schematic.nets.map((n) => [n.id, n]));
  return {
    instances: doc.schematic.instances.map((i) => ({ refDes: i.refDes, part: parts.get(i.partId)?.name })),
    nets: doc.schematic.nets.map((n) => ({ name: n.name, pins: n.connections.map((c) => `${inst.get(c.instanceId)?.refDes}.${c.pin}`) })),
    pinMaps: doc.library.parts.map((p) => p.packages.map((pk) => ({ pkg: pkgs.get(pk.packageId)?.name, map: pk.pinMap }))),
    placements: doc.pcb.placements.map((pl) => ({ ref: inst.get(pl.instanceId)?.refDes, pkg: pkgs.get(pl.packageId)?.name })),
    tracks: doc.pcb.tracks.map((t) => nets.get(t.netId)?.name),
    catalogRefs: doc.library.parts.map((p) => p.origin.catalogPartId),
  };
}
