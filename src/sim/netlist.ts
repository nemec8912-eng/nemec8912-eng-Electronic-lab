/**
 * Преобразование документа проекта в netlist ngspice. Чистая функция, без Node.js.
 * Перед построением — проверки, которые объясняют пользователю, почему расчёт невозможен,
 * вместо загадочной ошибки симулятора. Ничего не «додумывает»: деталь без модели не моделируется.
 */
import { modelParams, PARAMS } from '../core/library';
import type { ComponentInstance, PartDef, ProjectDoc, SimModel } from '../core/model';
import { symbolOf } from '../core/schematic';

export interface SimIssue {
  severity: 'error' | 'warning';
  code:
    | 'empty' | 'no-ground' | 'no-model' | 'unsupported-model' | 'unconnected-pin' | 'missing-value'
    | 'bad-value' | 'dangling-node' | 'no-dc-path' | 'shorted-source' | 'bad-settings';
  message: string;
  /** Связанные объекты: id экземпляров и сетей — для подсветки. */
  refs: string[];
}

export interface Netlist {
  text: string;
  /** id сети → имя узла в netlist ("0" — земля). */
  nodeOfNet: Map<string, string>;
  /** id экземпляра → имя элемента в netlist (в нижнем регистре, как его возвращает ngspice). */
  elementOf: Map<string, string>;
  /** Элементы, для которых сохраняются токи (@r1[i]). */
  currentVectors: Map<string, string>;
  issues: SimIssue[];
}

export interface Analyses {
  op: boolean;
  tran: { stopS: number; stepS: number; startFromZero: boolean } | null;
}

/** Число в виде, который ngspice разбирает однозначно: без суффиксов (в SPICE и «m», и «M» — это милли, мега — «meg»). */
export function spiceNumber(v: number): string {
  if (!Number.isFinite(v)) throw new Error('нечисловое значение');
  return v.toPrecision(12).replace(/\.?0+(e|$)/, '$1');
}

interface Resolved {
  inst: ComponentInstance;
  part: PartDef | undefined;
  model: SimModel | undefined;
}

export function buildNetlist(doc: ProjectDoc, analyses: Analyses, title = 'Электронная лаборатория'): Netlist {
  const issues: SimIssue[] = [];
  const err = (code: SimIssue['code'], message: string, refs: string[] = []) => issues.push({ severity: 'error', code, message, refs });
  const nodeOfNet = new Map<string, string>();
  const elementOf = new Map<string, string>();
  const currentVectors = new Map<string, string>();

  const resolved: Resolved[] = doc.schematic.instances.map((inst) => {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    const model = part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
    return { inst, part, model };
  });
  if (resolved.length === 0) err('empty', 'Схема пуста — нечего рассчитывать.');

  const netOfPin = new Map<string, string>();
  for (const n of doc.schematic.nets) for (const c of n.connections) netOfPin.set(`${c.instanceId}#${c.pin}`, n.id);

  // Узлы: сети с выводом «земли» — узел 0.
  const groundNets = new Set<string>();
  for (const r of resolved) {
    if (r.model?.kind !== 'ground') continue;
    for (const pin of symbolOf(doc, r.inst)?.pins ?? []) {
      const n = netOfPin.get(`${r.inst.id}#${pin.number}`);
      if (n) groundNets.add(n);
      else err('unconnected-pin', `Символ земли ${r.inst.refDes} ни к чему не подключён.`, [r.inst.id]);
    }
  }
  const devices = resolved.filter((r) => r.model?.kind !== 'ground');
  if (devices.length > 0 && groundNets.size === 0) {
    err('no-ground', 'Нет опорного узла: добавьте символ «Земля» и подключите его к общему проводу. Без него напряжения в схеме не определены.');
  }
  let k = 1;
  const usedNodes = new Set<string>(['0']);
  for (const n of doc.schematic.nets) {
    if (groundNets.has(n.id)) { nodeOfNet.set(n.id, '0'); continue; }
    let name = n.name && /^[A-Za-z][A-Za-z0-9_]*$/.test(n.name) && n.name.toLowerCase() !== 'gnd' ? `n_${n.name.toLowerCase()}` : `n${k++}`;
    while (usedNodes.has(name)) name = `n${k++}`;
    usedNodes.add(name);
    nodeOfNet.set(n.id, name);
  }

  // Элементы
  const lines: string[] = [];
  const usedElements = new Set<string>();
  const nodeUse = new Map<string, Array<{ inst: string; pin: string }>>();
  const dcEdges: Array<[string, string]> = []; // проводящие по постоянному току связи (R, V)
  for (const r of devices) {
    const { inst, part, model } = r;
    if (!part || !model) {
      err('no-model', `${inst.refDes}: нет электрической модели — деталь не может быть рассчитана. Описание выводов само по себе не создаёт модель поведения.`, [inst.id]);
      continue;
    }
    if (model.kind !== 'spice-primitive') {
      err('unsupported-model', `${inst.refDes}: модель вида «${model.kind}» пока не поддерживается.`, [inst.id]);
      continue;
    }
    const letter = model.text.trim()[0]!.toUpperCase();
    let el = /^[A-Za-z][A-Za-z0-9_]*$/.test(inst.refDes) && inst.refDes[0]!.toUpperCase() === letter ? inst.refDes : `${letter}_${/^[A-Za-z0-9_]+$/.test(inst.refDes) ? inst.refDes : `x${usedElements.size + 1}`}`;
    while (usedElements.has(el.toLowerCase())) el = `${el}_`;
    usedElements.add(el.toLowerCase());

    let ok = true;
    const nodes: string[] = [];
    let line = model.text.trim().replace(/^[A-Za-z]/, el);
    line = line.replace(/\{n:([^}]+)\}/g, (_m, pin: string) => {
      const net = netOfPin.get(`${inst.id}#${pin}`);
      if (!net) {
        ok = false;
        err('unconnected-pin', `${inst.refDes}: вывод ${pin} ни к чему не подключён.`, [inst.id]);
        return '?';
      }
      const node = nodeOfNet.get(net)!;
      nodes.push(node);
      nodeUse.set(node, [...(nodeUse.get(node) ?? []), { inst: inst.id, pin }]);
      return node;
    });
    for (const key of modelParams(model)) {
      const q = inst.values[key];
      const def = PARAMS[key];
      if (!q) { ok = false; err('missing-value', `${inst.refDes}: не задан параметр «${def?.label ?? key}».`, [inst.id]); continue; }
      const inRange = def ? (key === 'voltage' ? q.value >= def.min && q.value <= def.max : q.value > def.min && q.value <= def.max) : true;
      if (!inRange && def) {
        ok = false;
        err('bad-value', `${inst.refDes}: недопустимое значение «${def.label}» (${q.value} ${def.unitRu}).`, [inst.id]);
      }
    }
    line = line.replace(/\{v:([a-z_]+)\}/g, (_m, key: string) => (inst.values[key] ? spiceNumber(inst.values[key]!.value) : '?'));
    if (!ok) continue;
    if (letter === 'V' && nodes.length === 2 && nodes[0] === nodes[1]) {
      err('shorted-source', `${inst.refDes}: оба вывода источника соединены друг с другом — короткое замыкание источника.`, [inst.id]);
      continue;
    }
    if ((letter === 'R' || letter === 'V' || letter === 'L') && nodes.length === 2) dcEdges.push([nodes[0]!, nodes[1]!]);
    if (letter === 'R' || letter === 'C') currentVectors.set(inst.id, `@${el.toLowerCase()}[i]`);
    elementOf.set(inst.id, el.toLowerCase());
    lines.push(line);
  }

  // Висящие узлы: подключён ровно один вывод (кроме земли).
  for (const [node, uses] of nodeUse) {
    if (node === '0' || uses.length > 1) continue;
    const inst = doc.schematic.instances.find((i) => i.id === uses[0]!.inst);
    err('dangling-node', `${inst?.refDes}.${uses[0]!.pin}: узел соединён только с этим выводом — цепь разомкнута.`, [uses[0]!.inst]);
  }
  // Путь по постоянному току до земли (R, V, L). Узел только через конденсаторы — рабочая точка не определена.
  if (groundNets.size > 0) {
    const reach = new Set(['0']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [a, b] of dcEdges) {
        if (reach.has(a) && !reach.has(b)) { reach.add(b); grew = true; }
        if (reach.has(b) && !reach.has(a)) { reach.add(a); grew = true; }
      }
    }
    for (const node of nodeUse.keys()) {
      if (reach.has(node)) continue;
      const net = [...nodeOfNet.entries()].find(([, v]) => v === node)?.[0];
      err('no-dc-path', `Узел ${node} не имеет пути постоянного тока к земле (подключён только через конденсаторы) — рабочая точка не определена.`, net ? [net] : []);
    }
  }

  if (analyses.tran) {
    const { stopS, stepS } = analyses.tran;
    if (!(stopS > 0 && stepS > 0 && stepS <= stopS && stopS / stepS <= 2_000_000)) {
      err('bad-settings', 'Переходный процесс: время должно быть больше шага, не более 2 000 000 точек.');
    }
  }

  const control = ['.control', 'set filetype=ascii', 'set noaskquit'];
  const saves = [...currentVectors.values()];
  control.push(`save all${saves.length ? ' ' + saves.join(' ') : ''}`);
  if (analyses.op) control.push('op', 'write op.raw all');
  if (analyses.tran) control.push(`tran ${spiceNumber(analyses.tran.stepS)} ${spiceNumber(analyses.tran.stopS)}${analyses.tran.startFromZero ? ' uic' : ''}`, 'write tran.raw all');
  control.push('quit', '.endc');
  const safeTitle = title.replace(/[^\x20-\x7e]/g, '_').slice(0, 80);
  const text = [`* ${safeTitle}`, ...lines, ...control, '.end', ''].join('\n');
  return { text, nodeOfNet, elementOf, currentVectors, issues };
}
