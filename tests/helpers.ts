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
  const r1 = newId(), r2 = newId(), netIn = newId(), netMid = newId(), netGnd = newId(), pl1 = newId(), pl2 = newId();
  doc = {
    ...doc,
    library: {
      symbols: [{ id: symR, name: 'Резистор', standard: 'IEC 60617', graphic: 'iec-resistor', pins: [
        { number: '1', name: '1', electricalType: 'passive', x: -30, y: 0 },
        { number: '2', name: '2', electricalType: 'passive', x: 30, y: 0 },
      ] }],
      packages: [
        { id: pkg0805, name: '0805', family: 'SMD', pin1Marker: null, body: { x: -1, y: -0.625, w: 2, h: 1.25 }, pads: [
          { number: '1', x: -0.95, y: 0, shape: 'rect', w: 0.9, h: 1.3, drill: null },
          { number: '2', x: 0.95, y: 0, shape: 'rect', w: 0.9, h: 1.3, drill: null },
        ] },
        { id: pkgAxial, name: 'Выводной 0.4"', family: 'THT', pin1Marker: null, body: { x: 2, y: -1.2, w: 6.16, h: 2.4 }, pads: [
          { number: 'A', x: 0, y: 0, shape: 'round', w: 1.8, h: 1.8, drill: 0.9 },
          { number: 'B', x: 10.16, y: 0, shape: 'round', w: 1.8, h: 1.8, drill: 0.9 },
        ] },
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
      wires: [{ id: newId(), netId: netMid, from: { instanceId: r1, pin: '2' }, to: { instanceId: r2, pin: '1' }, points: [{ x: 100, y: 130 }, { x: 100, y: 170 }] }],
      annotations: [],
    },
    pcb: {
      board: { id: newId(), widthMm: 50, heightMm: 30, layers: 1 },
      placements: [
        { id: pl1, instanceId: r1, packageId: pkgAxial, position: { x: 10, y: 10 }, rotation: 0, side: 'top' },
        { id: pl2, instanceId: r2, packageId: pkg0805, position: { x: 30, y: 10 }, rotation: 90, side: 'bottom' },
      ],
      tracks: [{ id: newId(), netId: netMid, layer: 'bottom', widthMm: 0.8, from: { placementId: pl1, pad: 'B' }, to: { placementId: pl2, pad: '1' }, points: [{ x: 20.16, y: 10 }, { x: 30, y: 9.05 }] }],
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
