/** Общие помощники для тестов расчёта: сборка RC/делителя через операции редактора и поиск ngspice. */
import * as path from 'node:path';
import { createProject } from '../src/core/factory';
import { BUILTIN_PARTS } from '../src/core/library';
import type { PinRef, ProjectDoc } from '../src/core/model';
import { connectPins, placeBuiltin, setValue } from '../src/core/schematic';
import { locateNgspice } from '../src/sim/runner';

export const CAT = {
  R: BUILTIN_PARTS[0]!.catalogId,
  C: BUILTIN_PARTS[1]!.catalogId,
  V: BUILTIN_PARTS[2]!.catalogId,
  GND: BUILTIN_PARTS[3]!.catalogId,
};

export function ngspiceForTests(): string | null {
  return locateNgspice({ env: process.env.ELAB_NGSPICE, appRoot: path.resolve(import.meta.dirname, '..') });
}

/** Если ngspice обязателен (CI), отсутствие — ошибка, а не пропуск. */
export const requireNgspice = process.env.ELAB_REQUIRE_NGSPICE === '1';

export class Builder {
  doc: ProjectDoc;
  constructor(name = 'Тест') { this.doc = createProject(name); }
  place(kind: keyof typeof CAT, x: number, y: number): string {
    const r = placeBuiltin(this.doc, CAT[kind], { x, y });
    this.doc = r.doc;
    return r.id;
  }
  value(id: string, key: string, value: number, unit: string) { this.doc = setValue(this.doc, id, key, { value, unit }); }
  wire(a: PinRef, b: PinRef) {
    const r = connectPins(this.doc, a, b);
    if (r.error) throw new Error(r.error);
    this.doc = r.doc;
  }
}

export const p = (instanceId: string, pin: string): PinRef => ({ instanceId, pin });

/** Источник V → R → C → земля; R=10 кОм, C=100 нФ (τ = 1 мс), V = 5 В. */
export function rcCircuit() {
  const b = new Builder('RC-цепь');
  const v = b.place('V', 0, 100), r = b.place('R', 100, 50), c = b.place('C', 200, 100), g = b.place('GND', 100, 200);
  b.value(v, 'voltage', 5, 'V');
  b.wire(p(v, '+'), p(r, '1'));
  b.wire(p(r, '2'), p(c, '1'));
  b.wire(p(c, '2'), p(g, '1'));
  b.wire(p(v, '-'), p(g, '1'));
  return { doc: b.doc, v, r, c, g };
}

/** Делитель: 10 В, R1 = 10 кОм, R2 = 10 кОм. */
export function dividerCircuit(r1v = 10_000, r2v = 10_000, volts = 10) {
  const b = new Builder('Делитель');
  const v = b.place('V', 0, 100), r1 = b.place('R', 100, 50), r2 = b.place('R', 200, 100), g = b.place('GND', 100, 200);
  b.value(v, 'voltage', volts, 'V');
  b.value(r1, 'resistance', r1v, 'Ω');
  b.value(r2, 'resistance', r2v, 'Ω');
  b.wire(p(v, '+'), p(r1, '1'));
  b.wire(p(r1, '2'), p(r2, '1'));
  b.wire(p(r2, '2'), p(g, '1'));
  b.wire(p(v, '-'), p(g, '1'));
  return { doc: b.doc, v, r1, r2, g };
}
