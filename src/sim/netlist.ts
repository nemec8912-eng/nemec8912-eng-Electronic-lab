/**
 * Преобразование документа проекта в netlist ngspice. Чистая функция, без Node.js.
 * Перед построением — проверки, которые объясняют пользователю, почему расчёт невозможен,
 * вместо загадочной ошибки симулятора. Ничего не «додумывает»: деталь без модели не моделируется.
 *
 * Токи выводов. У приборов (диоды, транзисторы, MOSFET, подсхемы микросхем) в каждый вывод
 * последовательно включается источник 0 В — «амперметр» ngspice. Так известен ток каждого вывода
 * (втекающий в деталь), а значит — мощность детали Σ U·I и токи коллектора, стока и т. п.
 * У R, C, L и источников ток берётся из самого элемента.
 */
import { modelParams, PARAMS, paramInRange } from '../core/library';
import type { ComponentInstance, PartDef, PinRef, ProjectDoc, SimModel } from '../core/model';
import { symbolOf } from '../core/schematic';
import { checkModelTemplate, evalExpr } from '../core/spice';

/** Выводы, которые можно оставить свободными: выходы и «не подключать». */
const FREE_OK = new Set(['output', 'nc']);

export interface SimIssue {
  severity: 'error' | 'warning';
  code:
    | 'empty' | 'no-ground' | 'no-model' | 'not-simulated' | 'unsupported-model' | 'bad-model' | 'unconnected-pin' | 'missing-value'
    | 'bad-value' | 'dangling-node' | 'no-dc-path' | 'shorted-source' | 'bad-settings' | 'no-ac-source' | 'no-sweep-source' | 'unverified-model' | 'meter';
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
  /** id экземпляра → вектор тока элемента (R, C, L: @r1[i]; источники: i(v1)). */
  currentVectors: Map<string, string>;
  /** id экземпляра → (номер вывода → вектор тока, втекающего в вывод). */
  pinCurrentVectors: Map<string, Map<string, string>>;
  issues: SimIssue[];
  /** Вектор тока амперметра мультиметра (включён последовательно с выводом), если он есть. */
  ammeterVector: string | null;
}

/**
 * Дополнительные условия расчёта для приборов (этап 5).
 * ammeter — идеальный амперметр (источник 0 В) последовательно с выводом: ток, втекающий в вывод;
 * powerOff — «питание отключено»: источники (категория «источник») из схемы убираются, как при
 * измерении сопротивления, прозвонке, проверке диодов и ESR; leak — к каждому узлу 1 ТОм на землю,
 * чтобы обесточенная схема с разомкнутыми участками была определена (проверки «висящих» узлов не нужны);
 * refNet — если в схеме нет земли, этот узел (COM прибора) становится опорным; extra — строки прибора
 * (источник тестового тока и т. п.), им передаётся имя узла цепи; acSingleHz — частотный анализ в одной точке.
 */
export interface NetlistOptions {
  ammeter?: { instanceId: string; pin: string } | null;
  powerOff?: boolean;
  leak?: boolean;
  refNet?: string | null;
  extra?: (nodeOfPin: (ref: PinRef) => string | null) => string[];
  acSingleHz?: number;
}

export interface Analyses {
  op: boolean;
  tran: { stopS: number; stepS: number; startFromZero: boolean } | null;
  /** Развёртка по постоянному току: экземпляр-источник, пределы и шаг. */
  dc?: { sourceId: string; start: number; stop: number; step: number } | null;
  ac?: { fStartHz: number; fStopHz: number; pointsPerDecade: number } | null;
}

/** Анализы по настройкам проекта: рабочая точка всегда, плюс выбранный. */
export function analysesFor(doc: ProjectDoc, analysis: 'op' | 'tran' | 'dc' | 'ac'): Analyses {
  const s = doc.simulation;
  return {
    op: true,
    tran: analysis === 'tran' ? s.tran : null,
    dc: analysis === 'dc' ? { sourceId: s.dc.sourceId ?? '', start: s.dc.start, stop: s.dc.stop, step: s.dc.step } : null,
    ac: analysis === 'ac' ? s.ac : null,
  };
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

const DIGITAL = new Set(['ic-digital', 'mcu']);
/** Элементы, ток которых ngspice даёт сам (без амперметров на выводах). */
const TWO_TERMINAL = new Set(['R', 'C', 'L', 'V', 'I']);

export function buildNetlist(doc: ProjectDoc, analyses: Analyses, title = 'Электронная лаборатория', opts: NetlistOptions = {}): Netlist {
  const issues: SimIssue[] = [];
  const err = (code: SimIssue['code'], message: string, refs: string[] = []) => issues.push({ severity: 'error', code, message, refs });
  const warn = (code: SimIssue['code'], message: string, refs: string[] = []) => issues.push({ severity: 'warning', code, message, refs });
  const nodeOfNet = new Map<string, string>();
  const elementOf = new Map<string, string>();
  const currentVectors = new Map<string, string>();
  const pinCurrentVectors = new Map<string, Map<string, string>>();
  const freePinNodes = new Map<string, string>();

  const resolved: Resolved[] = doc.schematic.instances.map((inst) => {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    const model = part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
    return { inst, part, model };
  });
  if (resolved.length === 0) err('empty', 'Схема пуста — нечего рассчитывать.');

  const freeOutputs = new Set<string>();
  const netOfPin = new Map<string, string>();
  for (const n of doc.schematic.nets) for (const c of n.connections) netOfPin.set(`${c.instanceId}#${c.pin}`, n.id);

  // Узлы: сети с выводом «земли» — узел 0.
  const groundNets = new Set<string>();
  for (const r of resolved) {
    if (r.model?.kind !== 'ground') continue;
    for (const pin of symbolOf(doc, r.inst)?.pins ?? []) {
      const n = netOfPin.get(`${r.inst.id}#${pin.number}`);
      if (n) groundNets.add(n);
      else if (!opts.leak) err('unconnected-pin', `Символ земли ${r.inst.refDes} ни к чему не подключён.`, [r.inst.id]);
    }
  }
  if (groundNets.size === 0 && opts.refNet) groundNets.add(opts.refNet);
  // Разъёмы — не элементы цепи: в netlist не попадают, их выводы лишь продолжают цепи.
  // При «питание отключено» источники из схемы убираются (разомкнуты), как при измерении прибором.
  const devices = resolved.filter((r) => r.model?.kind !== 'ground' && r.model?.kind !== 'connector' && !(opts.powerOff && r.part?.category === 'source'));
  if (devices.length > 0 && groundNets.size === 0 && !opts.leak) {
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
  const cards = new Map<string, string[]>(); // id модели → карточки (.model/.subckt), по одному разу
  const usedElements = new Set<string>();
  const nodeUse = new Map<string, Array<{ inst: string; pin: string }>>();
  const dcEdges: Array<[string, string]> = []; // проводящие по постоянному току связи
  let hasAcSource = false;
  let ammeterVector: string | null = null;
  for (const r of devices) {
    const { inst, part, model } = r;
    if (!part || !model) {
      if (part && DIGITAL.has(part.category)) {
        err('not-simulated', `${inst.refDes} (${part.name}): у этой цифровой микросхемы нет модели — микроконтроллеры (прошивка не исполняется), счётчики и регистры не моделируются; простая логика (CD4011, CD4093, CD4001, CD4069, 74HC00, 74HC14) моделируется. Уберите деталь из схемы для расчёта или замените её источником сигнала.`, [inst.id]);
      } else {
        err('no-model', `${inst.refDes}: нет электрической модели — деталь не может быть рассчитана. Описание выводов само по себе не создаёт модель поведения; модель можно добавить в редакторе детали.`, [inst.id]);
      }
      continue;
    }
    if (model.kind !== 'spice-primitive' && model.kind !== 'spice-subckt') {
      err('unsupported-model', `${inst.refDes}: модель вида «${model.kind}» не поддерживается.`, [inst.id]);
      continue;
    }
    const problems = checkModelTemplate(model.text);
    if (problems.length) {
      err('bad-model', `${inst.refDes}: модель «${model.name}» не принята: ${problems.join('; ')}`, [inst.id]);
      continue;
    }
    if (!model.verified) warn('unverified-model', `${inst.refDes}: модель «${model.name}» не проверена — результат приблизительный.`, [inst.id]);
    const [elementTpl, ...cardLines] = model.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'));
    const letter = elementTpl![0]!.toUpperCase();
    let el = /^[A-Za-z][A-Za-z0-9_]*$/.test(inst.refDes) && inst.refDes[0]!.toUpperCase() === letter ? inst.refDes : `${letter}_${/^[A-Za-z0-9_]+$/.test(inst.refDes) ? inst.refDes : `x${usedElements.size + 1}`}`;
    while (usedElements.has(el.toLowerCase())) el = `${el}_`;
    usedElements.add(el.toLowerCase());
    const elLower = el.toLowerCase();
    // Карточки с параметрами экземпляра ({v:…}, {e:…}) — своя копия модели у каждого экземпляра.
    const perInstance = cardLines.some((l) => /\{[ve]:/.test(l));
    const modelName = `m_${model.id.replace(/-/g, '').slice(0, 12)}${perInstance ? `_${elLower}` : ''}`;

    let ok = true;
    const nodes: string[] = [];
    const ammeters: string[] = [];
    const pinVectors = new Map<string, string>();
    const withAmmeters = !TWO_TERMINAL.has(letter);
    let pinIndex = 0;
    let line = elementTpl!.replace(/^[A-Za-z]/, el);
    line = line.replace(/\{n:([^}]+)\}/g, (_m, pin: string) => {
      const net = netOfPin.get(`${inst.id}#${pin}`);
      // Свободный выход микросхемы или вывод «не подключать» — нормальная ситуация: свой узел без ошибки.
      const freeOk = !net && !opts.leak && FREE_OK.has(symbolOf(doc, inst)?.pins.find((x) => x.number === pin)?.electricalType ?? '');
      if (freeOk) {
        const free = `fo${freeOutputs.size + 1}`;
        freeOutputs.add(free);
        nodes.push(free);
        nodeUse.set(free, [{ inst: inst.id, pin }]);
        if (!withAmmeters) return free;
        pinIndex += 1;
        const inner = `${elLower}_p${pinIndex}`;
        ammeters.push(`v_${elLower}_${pinIndex} ${free} ${inner} 0`);
        pinVectors.set(pin, `i(v_${elLower}_${pinIndex})`);
        return inner;
      }
      if (!net && opts.leak) {
        // Измерение прибором: свободный вывод — свой узел (щуп можно приложить прямо к выводу детали).
        let free = freePinNodes.get(`${inst.id}#${pin}`);
        if (!free) { free = `f${freePinNodes.size + 1}`; freePinNodes.set(`${inst.id}#${pin}`, free); }
        nodes.push(free);
        nodeUse.set(free, [...(nodeUse.get(free) ?? []), { inst: inst.id, pin }]);
        if (!withAmmeters) return free;
        pinIndex += 1;
        const inner = `${elLower}_p${pinIndex}`;
        ammeters.push(`v_${elLower}_${pinIndex} ${free} ${inner} 0`);
        pinVectors.set(pin, `i(v_${elLower}_${pinIndex})`);
        return inner;
      }
      if (!net) {
        ok = false;
        err('unconnected-pin', `${inst.refDes}: вывод ${pin} ни к чему не подключён.`, [inst.id]);
        return '?';
      }
      const node = nodeOfNet.get(net)!;
      nodes.push(node);
      nodeUse.set(node, [...(nodeUse.get(node) ?? []), { inst: inst.id, pin }]);
      // Амперметр мультиметра: цепь перестраивается — вывод отсоединяется от узла и подключается через прибор.
      let attach = node;
      if (opts.ammeter && opts.ammeter.instanceId === inst.id && opts.ammeter.pin === pin) {
        if (!ammeterVector) ammeters.push(`v_meter ${node} n_meter 0`);
        ammeterVector = 'i(v_meter)';
        attach = 'n_meter';
      }
      if (!withAmmeters) return attach;
      if (pinVectors.has(pin)) return `${elLower}_p${[...pinVectors.keys()].indexOf(pin) + 1}`;
      pinIndex += 1;
      const inner = `${elLower}_p${pinIndex}`;
      const src = `v_${elLower}_${pinIndex}`;
      ammeters.push(`${src} ${attach} ${inner} 0`);
      pinVectors.set(pin, `i(${src})`);
      return inner;
    });
    const vars: Record<string, number> = {};
    for (const key of modelParams(model)) {
      const q = inst.values[key];
      const def = PARAMS[key];
      if (!q) { ok = false; err('missing-value', `${inst.refDes}: не задан параметр «${def?.label ?? key}».`, [inst.id]); continue; }
      if (!paramInRange(key, q.value)) {
        ok = false;
        err('bad-value', `${inst.refDes}: недопустимое значение «${def?.label ?? key}» (${q.value} ${def?.unitRu ?? ''}).`, [inst.id]);
        continue;
      }
      vars[key] = q.value;
    }
    const subst = (text: string) => text
      .replace(/\{v:([A-Za-z_]+)\}/g, (_m, key: string) => (inst.values[key] ? spiceNumber(inst.values[key]!.value) : '?'))
      .replace(/\{e:([^}]+)\}/g, (_m, expr: string) => {
        try { return spiceNumber(evalExpr(expr, vars)); } catch { ok = false; return '?'; }
      })
      .replace(/\{model\}/g, modelName);
    line = subst(line);
    const instCards = cardLines.map(subst);
    if (!ok) continue;
    if ((letter === 'V' || letter === 'I') && nodes.length === 2 && nodes[0] === nodes[1]) {
      err('shorted-source', `${inst.refDes}: оба вывода источника соединены друг с другом — короткое замыкание источника.`, [inst.id]);
      continue;
    }
    if ((letter === 'V' || letter === 'I') && /\sAC\s/i.test(` ${line} `)) hasAcSource = true;
    // Пути постоянного тока: R, L, V — между своими узлами; приборы и подсхемы — между всеми выводами,
    // кроме затвора MOSFET (изолирован).
    if (letter === 'R' || letter === 'V' || letter === 'L') dcEdges.push([nodes[0]!, nodes[1]!]);
    else if (letter === 'M') { if (nodes[0] && nodes[2]) dcEdges.push([nodes[0], nodes[2]]); }
    else if (letter !== 'C' && letter !== 'I') for (let i = 1; i < nodes.length; i++) dcEdges.push([nodes[0]!, nodes[i]!]);
    if (letter === 'R' || letter === 'C' || letter === 'L') currentVectors.set(inst.id, `@${elLower}[i]`);
    if (letter === 'V') currentVectors.set(inst.id, `i(${elLower})`);
    if (pinVectors.size) pinCurrentVectors.set(inst.id, pinVectors);
    elementOf.set(inst.id, elLower);
    lines.push(...ammeters, line);
    const cardKey = perInstance ? `${model.id}/${inst.id}` : model.id;
    if (cardLines.length && !cards.has(cardKey)) cards.set(cardKey, instCards);
  }

  if (opts.ammeter && !ammeterVector) {
    warn('meter', 'Амперметр не подключён: вывод под красным щупом не участвует в расчёте (деталь удалена, вывод свободен или деталь не моделируется).');
  }
  // Висящие узлы: подключён ровно один вывод (кроме земли).
  for (const [node, uses] of nodeUse) {
    if (opts.leak || node === '0' || uses.length > 1 || freeOutputs.has(node)) continue;
    const inst = doc.schematic.instances.find((i) => i.id === uses[0]!.inst);
    err('dangling-node', `${inst?.refDes}.${uses[0]!.pin}: узел соединён только с этим выводом — цепь разомкнута.`, [uses[0]!.inst]);
  }
  // Путь по постоянному току до земли. Узел только через конденсаторы — рабочая точка не определена.
  if (groundNets.size > 0 && !opts.leak) {
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
      if (reach.has(node) || freeOutputs.has(node)) continue;
      const net = [...nodeOfNet.entries()].find(([, v]) => v === node)?.[0];
      err('no-dc-path', `Узел ${node} не имеет пути постоянного тока к земле (подключён только через конденсаторы, затвор MOSFET или источник тока) — рабочая точка не определена.`, net ? [net] : []);
    }
  }

  // Анализы
  if (analyses.tran) {
    const { stopS, stepS } = analyses.tran;
    if (!(stopS > 0 && stepS > 0 && stepS <= stopS && stopS / stepS <= 2_000_000)) {
      err('bad-settings', 'Переходный процесс: время должно быть больше шага, не более 2 000 000 точек.');
    }
  }
  let dcLine: string | null = null;
  if (analyses.dc) {
    const d = analyses.dc;
    const el = elementOf.get(d.sourceId);
    const inst = doc.schematic.instances.find((i) => i.id === d.sourceId);
    if (!inst) err('no-sweep-source', 'Развёртка DC: выберите источник, значение которого будет меняться.');
    else if (!el || !(el.startsWith('v') || el.startsWith('i'))) err('no-sweep-source', `Развёртка DC: ${inst.refDes} — не источник напряжения или тока.`, [inst.id]);
    const n = Math.abs(d.stop - d.start) / d.step;
    if (!(d.step > 0) || !Number.isFinite(n) || n < 1 || n > 100_000) err('bad-settings', 'Развёртка DC: шаг должен быть больше нуля и меньше диапазона, не более 100 000 точек.');
    if (el) dcLine = `dc ${el} ${spiceNumber(d.start)} ${spiceNumber(d.stop)} ${spiceNumber(d.stop >= d.start ? d.step : -d.step)}`;
  }
  if (analyses.ac) {
    const a = analyses.ac;
    if (!hasAcSource && !opts.leak) err('no-ac-source', 'Частотный анализ: нужен источник синусоидального напряжения — его амплитуда задаёт уровень входного сигнала. Остальные источники в частотном анализе дают 0.');
    if (!(a.fStartHz > 0 && a.fStopHz > a.fStartHz && a.fStopHz <= 1e12 && a.pointsPerDecade >= 1 && Math.log10(a.fStopHz / a.fStartHz) * a.pointsPerDecade <= 100_000)) {
      err('bad-settings', 'Частотный анализ: начальная частота больше нуля и меньше конечной, не более 100 000 точек.');
    }
  }

  const control = ['.control', 'set filetype=ascii', 'set noaskquit'];
  const saves = [...currentVectors.values()].filter((v) => v.startsWith('@'));
  control.push(`save all${saves.length ? ' ' + saves.join(' ') : ''}`);
  if (analyses.op) control.push('op', 'write op.raw all');
  if (analyses.tran) control.push(`tran ${spiceNumber(analyses.tran.stepS)} ${spiceNumber(analyses.tran.stopS)}${analyses.tran.startFromZero ? ' uic' : ''}`, 'write tran.raw all');
  if (dcLine) control.push(dcLine, 'write dc.raw all');
  // В частотном анализе ngspice не даёт токи деталей (@c1[i]) и из-за них отказывается писать «all» —
  // записываются только напряжения узлов, их и использует интерфейс.
  const acNodes = [...new Set([...nodeOfNet.values(), ...freePinNodes.values()].filter((n) => n !== '0'))].map((n) => `v(${n})`);
  if (analyses.ac) control.push(`ac dec ${analyses.ac.pointsPerDecade} ${spiceNumber(analyses.ac.fStartHz)} ${spiceNumber(analyses.ac.fStopHz)}`, `write ac.raw ${acNodes.join(' ') || 'all'}`);
  else if (opts.acSingleHz) control.push(`ac lin 1 ${spiceNumber(opts.acSingleHz)} ${spiceNumber(opts.acSingleHz)}`, `write ac.raw ${acNodes.join(' ') || 'all'}`);
  control.push('quit', '.endc');
  const safeTitle = title.replace(/[^\x20-\x7e]/g, '_').slice(0, 80);
  const modelCards = [...cards.values()].flat();
  const usedNodeNames = [...new Set([...nodeOfNet.values(), ...freePinNodes.values()].filter((n) => n !== '0'))];
  if (opts.leak) usedNodeNames.forEach((n, i) => lines.push(`r_leak${i + 1} ${n} 0 1e12`));
  if (opts.extra) {
    lines.push(...opts.extra((ref) => {
      const net = netOfPin.get(`${ref.instanceId}#${ref.pin}`);
      return net ? nodeOfNet.get(net) ?? null : freePinNodes.get(`${ref.instanceId}#${ref.pin}`) ?? null;
    }));
  }
  // Поведенческие модели логики и компараторов (резкие переключения, защёлка триггера Шмитта) жёсткие:
  // трапеции дают численный «звон», и шаг падает до наносекунд. Для таких схем — метод Гира.
  const options = modelCards.some((c) => c.includes('tanh(')) ? ['.options method=gear'] : [];
  const text = [`* ${safeTitle}`, ...lines, ...(modelCards.length ? ['* модели', ...modelCards] : []), ...options, ...control, '.end', ''].join('\n');
  return { text, nodeOfNet, elementOf, currentVectors, pinCurrentVectors, issues, ammeterVector };
}
