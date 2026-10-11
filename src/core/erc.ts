/**
 * Проверка электрических правил (ERC). Работает по графу связности и типам выводов. Каждое замечание —
 * с местом на схеме, объяснением и уровнем критичности. ERC ищет типовые ошибки соединений и НЕ
 * гарантирует, что схема делает то, что задумано.
 */
import { endKey, GROUND_NAME, graphOf, netDisplayName } from './connectivity';
import type { ComponentInstance, Net, PartDef, Point, ProjectDoc, SimModel, SymbolDef } from './model';
import { endPosition, onSeg, pinPosition, segsOf, symbolOf } from './schematic';

export type ErcSeverity = 'error' | 'warning' | 'info';

export interface ErcIssue {
  /** Устойчивый ключ замечания (код + объекты) — для «пометить как проверенное» в будущем и для тестов. */
  key: string;
  code: ErcCode;
  severity: ErcSeverity;
  message: string;
  /** Где на схеме. */
  at: Point | null;
  /** Объекты для подсветки и выделения: детали, провода, метки, сети. */
  refs: string[];
}

export type ErcCode =
  | 'no-ground' | 'unconnected-power' | 'unconnected-input' | 'unconnected-pin' | 'ground-unconnected'
  | 'output-conflict' | 'power-output-conflict' | 'unpowered' | 'power-label-no-source' | 'power-on-ground'
  | 'ground-pin-not-ground' | 'power-short' | 'power-to-ground-short' | 'source-shorted' | 'two-names'
  | 'input-only' | 'nc-connected' | 'single-pin-net' | 'dangling-wire' | 'lonely-label' | 'touching-not-connected'
  | 'no-model';

/** Объяснения кодов — для справки в интерфейсе. */
export const ERC_HELP: Record<ErcCode, string> = {
  'no-ground': 'Без опорного узла (символа «Земля») напряжения в схеме не определены — расчёт невозможен.',
  'unconnected-power': 'Вывод питания микросхемы ни к чему не подключён — микросхема не будет работать.',
  'unconnected-input': 'Неподключённый вход «висит»: его уровень не определён (наводки, ложные срабатывания).',
  'unconnected-pin': 'Вывод ни к чему не подключён. Если так задумано, это можно не исправлять.',
  'ground-unconnected': 'Символ «Земля» стоит на схеме, но ни к чему не подключён.',
  'output-conflict': 'Два выхода в одной цепи «спорят»: при разных уровнях через них течёт ток короткого замыкания.',
  'power-output-conflict': 'Два выхода питания соединены — источники закорочены друг на друга.',
  'unpowered': 'В цепи есть входы питания, но нет ни источника, ни выхода питания, ни метки питания.',
  'power-label-no-source': 'Метка питания только называет цепь, но не создаёт напряжения: нужен источник или выход питания.',
  'power-on-ground': 'Вывод питания соединён с землёй — микросхема не получит питания (или это короткое замыкание).',
  'ground-pin-not-ground': 'Вывод «земля» детали подключён к цепи, которая не является землёй.',
  'power-short': 'В одной цепи разные метки питания — это короткое замыкание между источниками.',
  'power-to-ground-short': 'Цепь питания соединена с землёй — короткое замыкание.',
  'source-shorted': 'Оба вывода источника в одной цепи — источник закорочен.',
  'two-names': 'У одной цепи несколько имён (меток). Проверьте, не соединены ли цепи по ошибке.',
  'input-only': 'В цепи только входы — нечему задать уровень сигнала.',
  'nc-connected': 'Вывод, помеченный «не подключать», соединён с цепью.',
  'single-pin-net': 'Цепь из одного вывода: провод от него никуда не ведёт.',
  'dangling-wire': 'Конец провода ни к чему не подключён.',
  'lonely-label': 'Метка ни к чему не подключена и ни с чем не соединяет.',
  'touching-not-connected': 'На рисунке вывод касается провода или другого вывода, но электрически они не соединены. Это легко принять за соединение.',
  'no-model': 'У детали нет модели для расчёта — схему можно проверять ERC и разводить, но не рассчитывать.',
};

const SEVERITY_ORDER: Record<ErcSeverity, number> = { error: 0, warning: 1, info: 2 };
const NEG_SUPPLY = /^(V(SS|EE)|V-|-V|AVSS|DVSS)/i;

interface PinInfo {
  inst: ComponentInstance;
  part: PartDef | undefined;
  model: SimModel | undefined;
  pin: SymbolDef['pins'][number];
  net: Net | undefined;
  at: Point | null;
  label: string;
}

export function runErc(doc: ProjectDoc): ErcIssue[] {
  const out: ErcIssue[] = [];
  const add = (code: ErcCode, severity: ErcSeverity, message: string, at: Point | null, refs: string[]) =>
    out.push({ key: `${code}:${refs.join(',')}:${message}`, code, severity, message, at, refs });
  const s = doc.schematic;
  const g = graphOf(doc);
  const netByPin = new Map<string, Net>();
  for (const n of s.nets) for (const c of n.connections) netByPin.set(`${c.instanceId}#${c.pin}`, n);

  const pins: PinInfo[] = [];
  for (const inst of s.instances) {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    const model = part?.modelId ? doc.library.models.find((m) => m.id === part.modelId) : undefined;
    for (const pin of symbolOf(doc, inst)?.pins ?? []) {
      const ref = { instanceId: inst.id, pin: pin.number };
      pins.push({ inst, part, model, pin, net: netByPin.get(`${inst.id}#${pin.number}`), at: pinPosition(doc, ref), label: `${inst.refDes}.${pin.name && pin.name !== pin.number ? `${pin.number} (${pin.name})` : pin.number}` });
    }
  }
  const isGroundPart = (p: PinInfo) => p.model?.kind === 'ground';
  const isSource = (p: PinInfo) => p.part?.category === 'source' || /^[VI]\b|^[VI]\s/i.test(p.model?.text ?? '');
  const isConnector = (p: PinInfo) => p.model?.kind === 'connector' || p.part?.category === 'connector';

  // 1. Земля для расчёта
  const devices = s.instances.filter((i) => {
    const part = doc.library.parts.find((p) => p.id === i.partId);
    return part?.category !== 'reference';
  });
  if (devices.length > 0 && !pins.some(isGroundPart)) {
    add('no-ground', 'error', 'Нет символа «Земля» (опорного узла). Для расчёта он обязателен.', null, []);
  }

  // 2. Неподключённые выводы
  for (const p of pins) {
    if (p.net || p.pin.electricalType === 'nc') continue;
    if (isGroundPart(p)) { add('ground-unconnected', 'warning', `${p.inst.refDes}: символ «Земля» ни к чему не подключён`, p.at, [p.inst.id]); continue; }
    if (p.pin.electricalType === 'power-in') add('unconnected-power', 'error', `${p.label}: вывод питания не подключён`, p.at, [p.inst.id]);
    else if (p.pin.electricalType === 'input') add('unconnected-input', 'warning', `${p.label}: вход не подключён`, p.at, [p.inst.id]);
    else if (!isConnector(p)) add('unconnected-pin', 'warning', `${p.label}: вывод не подключён`, p.at, [p.inst.id]);
  }

  // 3. Правила по цепям
  const labelsOfNet = new Map<string, Array<{ id: string; name: string; kind: string }>>();
  for (const l of s.labels) {
    const n = g.netOfVertex.get(`l:${l.id}`);
    if (n) labelsOfNet.set(n, [...(labelsOfNet.get(n) ?? []), l]);
  }
  for (const net of s.nets) {
    const np = pins.filter((p) => p.net?.id === net.id);
    const name = netDisplayName(doc, net);
    const at = np[0]?.at ?? null;
    const t = (type: string) => np.filter((p) => p.pin.electricalType === type);
    const sources = np.filter(isSource);
    const outputs = t('output'), powerOut = t('power-out').filter((p) => !isSource(p)), powerIn = t('power-in'), inputs = t('input'), bidir = t('bidirectional'), passive = t('passive'), nc = t('nc');
    const groundHere = np.some(isGroundPart) || net.name === GROUND_NAME;
    const labels = labelsOfNet.get(net.id) ?? [];
    const powerLabels = [...new Set(labels.filter((l) => l.kind === 'power').map((l) => l.name))];
    const allNames = [...new Set(labels.map((l) => l.name))];
    const plusTerms = sources.filter((p) => /^\+$|^\+V|^POS/i.test(p.pin.name));

    if (outputs.length >= 2) add('output-conflict', 'error', `Цепь ${name}: соединены выходы ${outputs.map((p) => p.label).join(', ')}`, at, [net.id, ...outputs.map((p) => p.inst.id)]);
    if (powerOut.length >= 2) add('power-output-conflict', 'error', `Цепь ${name}: соединены выходы питания ${powerOut.map((p) => p.label).join(', ')}`, at, [net.id, ...powerOut.map((p) => p.inst.id)]);
    if (plusTerms.length >= 2) add('power-output-conflict', 'error', `Цепь ${name}: источники ${plusTerms.map((p) => p.inst.refDes).join(', ')} соединены параллельно`, at, [net.id, ...plusTerms.map((p) => p.inst.id)]);
    if (powerOut.length >= 1 && outputs.length >= 1) add('output-conflict', 'error', `Цепь ${name}: выход ${outputs[0]!.label} соединён с выходом питания ${powerOut[0]!.label}`, at, [net.id, outputs[0]!.inst.id, powerOut[0]!.inst.id]);

    if (groundHere) {
      for (const p of powerIn) {
        if (NEG_SUPPLY.test(p.pin.name)) continue;
        add('power-on-ground', 'error', `${p.label}: вывод питания соединён с землёй`, p.at, [net.id, p.inst.id]);
      }
      if (powerLabels.length) add('power-to-ground-short', 'error', `Метка питания ${powerLabels.join(', ')} соединена с землёй`, at, [net.id, ...labels.map((l) => l.id)]);
      for (const p of powerOut) add('power-to-ground-short', 'error', `Выход питания ${p.label} соединён с землёй`, p.at, [net.id, p.inst.id]);
    } else {
      for (const p of t('ground')) add('ground-pin-not-ground', 'warning', `${p.label}: вывод «земля» подключён к цепи ${name}, а не к земле`, p.at, [net.id, p.inst.id]);
      const fed = powerOut.length > 0 || plusTerms.length > 0 || powerLabels.length > 0;
      if (powerIn.length && !fed) add('unpowered', 'error', `Цепь ${name}: питание ${powerIn.map((p) => p.label).join(', ')} ни от чего не подаётся`, at, [net.id, ...powerIn.map((p) => p.inst.id)]);
    }
    if (powerLabels.length >= 2) add('power-short', 'error', `Метки питания ${powerLabels.join(' и ')} в одной цепи — короткое замыкание`, at, [net.id, ...labels.map((l) => l.id)]);
    else if (allNames.length >= 2) add('two-names', 'warning', `У цепи несколько имён: ${allNames.join(', ')}`, at, [net.id, ...labels.map((l) => l.id)]);
    if (powerLabels.length >= 1 && !groundHere && plusTerms.length === 0 && powerOut.length === 0) {
      add('power-label-no-source', 'warning', `Цепь ${powerLabels[0]}: нет источника или выхода питания — метка напряжения не создаёт`, at, [net.id, ...labels.map((l) => l.id)]);
    }
    for (const p of sources) {
      const other = np.filter((q) => q.inst.id === p.inst.id);
      if (other.length >= 2 && other[0] === p) add('source-shorted', 'error', `${p.inst.refDes}: оба вывода источника в цепи ${name}`, p.at, [net.id, p.inst.id]);
    }
    const drivers = outputs.length + powerOut.length + bidir.length + passive.length + sources.length + (labels.length ? 1 : 0);
    if (inputs.length && !drivers && !groundHere) add('input-only', 'warning', `Цепь ${name}: только входы (${inputs.map((p) => p.label).join(', ')})`, at, [net.id, ...inputs.map((p) => p.inst.id)]);
    if (nc.length && np.length > 1) for (const p of nc) add('nc-connected', 'warning', `${p.label}: вывод «не подключать» соединён с цепью ${name}`, p.at, [net.id, p.inst.id]);
    if (np.length === 1 && labels.length === 0 && !isGroundPart(np[0]!)) add('single-pin-net', 'warning', `${np[0]!.label}: провод от вывода никуда не ведёт`, at, [net.id, np[0]!.inst.id]);
  }

  // 4. Провода и метки
  for (const w of s.wires) {
    for (const [end, pt] of [[w.a, w.points[0]!], [w.b, w.points[w.points.length - 1]!]] as const) {
      if (end.kind !== 'free') continue;
      add('dangling-wire', 'warning', 'Конец провода ни к чему не подключён', pt, [w.id]);
    }
  }
  const nameCount = new Map<string, number>();
  for (const l of s.labels) nameCount.set(l.name, (nameCount.get(l.name) ?? 0) + 1);
  for (const l of s.labels) {
    if ((g.degree.get(`l:${l.id}`) ?? 0) === 0 && (nameCount.get(l.name) ?? 0) < 2 && !(l.name === GROUND_NAME && pins.some(isGroundPart))) {
      add('lonely-label', 'warning', `Метка «${l.name}» ни к чему не подключена`, l.position, [l.id]);
    }
  }

  // 5. Касание без соединения: вывод лежит на чужом проводе или совпадает с выводом другой цепи.
  const vertexNet = (k: string | null) => (k ? g.netOfVertex.get(k) ?? null : null);
  for (const p of pins) {
    if (!p.at) continue;
    const myKey = `p:${p.inst.id}#${p.pin.number}`;
    const myNet = vertexNet(myKey);
    for (const w of s.wires) {
      if (endKey(w.a) === myKey || endKey(w.b) === myKey) continue;
      const wn = g.netOfWire.get(w.id) ?? null;
      if (myNet && wn === myNet) continue;
      if (segsOf(w.points).some((sg) => onSeg(p.at!, sg))) {
        add('touching-not-connected', 'warning', `${p.label} касается провода, но не соединён с ним`, p.at, [p.inst.id, w.id]);
        break;
      }
    }
    for (const q of pins) {
      if (q === p || q.inst.id <= p.inst.id || !q.at || q.at.x !== p.at.x || q.at.y !== p.at.y) continue;
      if (myNet && myNet === vertexNet(`p:${q.inst.id}#${q.pin.number}`)) continue;
      add('touching-not-connected', 'warning', `${p.label} и ${q.label} совпадают на рисунке, но не соединены`, p.at, [p.inst.id, q.inst.id]);
    }
  }
  for (const w of s.wires) {
    for (const [end, pt] of [[w.a, w.points[0]!], [w.b, w.points[w.points.length - 1]!]] as const) {
      if (end.kind !== 'free') continue;
      const other = s.wires.find((x) => x.id !== w.id && segsOf(x.points).some((sg) => onSeg(pt, sg)));
      if (other) add('touching-not-connected', 'warning', 'Конец провода лежит на другом проводе, но не соединён с ним (нет узла)', pt, [w.id, other.id]);
    }
  }

  // 6. Модели (сведения для расчёта)
  for (const inst of s.instances) {
    const part = doc.library.parts.find((p) => p.id === inst.partId);
    if (!part || part.category === 'reference' || part.modelId) continue;
    add('no-model', 'info', `${inst.refDes}: нет модели для расчёта`, endPosition(doc, { kind: 'pin', instanceId: inst.id, pin: symbolOf(doc, inst)?.pins[0]?.number ?? '1' }) ?? inst.position, [inst.id]);
  }

  // Повторы (одна и та же пара) убираем, порядок — по важности.
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true))).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export const ERC_DISCLAIMER = 'ERC проверяет типовые ошибки соединений по типам выводов. Он не гарантирует, что схема правильно делает то, что задумано.';
