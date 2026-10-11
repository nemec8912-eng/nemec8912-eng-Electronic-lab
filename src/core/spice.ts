/**
 * Шаблоны SPICE-моделей деталей и разбор моделей пользователя. Чистые функции.
 *
 * Шаблон модели (SimModel.text) — несколько строк:
 *   1-я строка — элемент схемы: буква элемента и подстановки
 *        {n:вывод}  — узел, к которому подключён вывод символа с этим номером;
 *        {v:имя}    — значение параметра экземпляра (сопротивление, напряжение…);
 *        {e:выраж.} — выражение из параметров: duty/100/frequency (только + − * / и скобки);
 *        {model}    — уникальное имя модели в netlist;
 *   следующие строки — карточки модели: .model, .subckt … .ends, .param, строки элементов внутри
 *   подсхемы, продолжения «+», комментарии «*». В карточках допустимы {model}, {v:…} и {e:…};
 *   с параметрами экземпляра модель выводится в netlist отдельно для каждого экземпляра.
 * Команды управления расчётом и доступ к файлам (.control, .include, .lib, .option, анализы) запрещены:
 * модель — это описание детали, а не программа.
 */

export const ELEMENT_LETTERS = 'RCLVIDQMJXKBEGFHSWZT';

const FORBIDDEN_DOT = /^\.(control|endc|include|inc|lib|endl|option|options|opt|op|tran|ac|dc|noise|tf|sens|pz|disto|four|save|print|plot|probe|meas|measure|end|ic|nodeset|temp|global|csparam|width|func|if|else|endif)\b/i;
const ALLOWED_DOT = /^\.(model|subckt|ends|param)\b/i;

/** Проверка шаблона модели: безопасность и синтаксис подстановок. */
export function checkModelTemplate(text: string): string[] {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return ['Пустая модель'];
  const first = lines[0]!;
  if (!new RegExp(`^[${ELEMENT_LETTERS}]`, 'i').test(first)) errors.push(`Первая строка должна описывать элемент (начинаться с буквы элемента SPICE): «${first.slice(0, 60)}»`);
  if (!/\{n:[^}]+\}/.test(first)) errors.push('В строке элемента нет ни одного вывода {n:…}');
  for (const m of first.matchAll(/\{([a-z]+):?([^}]*)\}/g)) {
    if (!['n', 'v', 'e', 'model'].includes(m[1]!)) errors.push(`Неизвестная подстановка {${m[1]}${m[2] ? ':' + m[2] : ''}}`);
    if (m[1] === 'e' && !/^[A-Za-z_0-9.+\-*/() ]+$/.test(m[2]!)) errors.push(`Недопустимое выражение {e:${m[2]}}`);
  }
  let depth = 0;
  for (const [i, raw] of lines.entries()) {
    const l = raw;
    if (/^\*/.test(l)) continue;
    if (/\bshell\b/i.test(l) || /`/.test(l)) errors.push(`Строка ${i + 1}: недопустимая команда`);
    if (l.startsWith('.')) {
      if (FORBIDDEN_DOT.test(l) && !/^\.ends\b/i.test(l)) { errors.push(`Строка ${i + 1}: команда «${l.split(/\s/)[0]}» в модели запрещена — модель описывает деталь, а не расчёт`); continue; }
      if (!ALLOWED_DOT.test(l)) { errors.push(`Строка ${i + 1}: неизвестная директива «${l.split(/\s/)[0]}»`); continue; }
      if (/^\.subckt\b/i.test(l)) depth++;
      if (/^\.ends\b/i.test(l)) depth--;
      if (depth < 0) errors.push(`Строка ${i + 1}: .ends без .subckt`);
    } else if (i > 0 && !/^\+/.test(l) && depth === 0) {
      errors.push(`Строка ${i + 1}: элемент вне подсхемы — вне .subckt допускается только один элемент (первая строка)`);
    }
    if (i > 0) {
      // {model} (и производные имена вида {model}_m) — единственная подстановка в карточках.
      // В карточках: {model}, а также параметры экземпляра {v:…}/{e:…} — тогда модель создаётся для каждого экземпляра.
      for (const m of l.matchAll(/\{([^}]*)\}/g)) {
        if (m[1] === 'model' || /^v:[A-Za-z_]+$/.test(m[1]!)) continue;
        if (/^e:[A-Za-z_0-9.+\-*/() ]+$/.test(m[1]!)) continue;
        errors.push(`Строка ${i + 1}: недопустимая подстановка {${m[1]}} — в карточках допускаются {model}, {v:…} и {e:…}`);
      }
    }
  }
  if (depth !== 0) errors.push('Не закрыта подсхема: нет .ends');
  return [...new Set(errors)];
}

/** Номера выводов, которые использует шаблон. */
export function templatePins(text: string): string[] {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return [...first.matchAll(/\{n:([^}]+)\}/g)].map((m) => m[1]!);
}

// ---------- Безопасное вычисление {e:…} ----------

/** Вычисление выражения из чисел, имён параметров и + − * / ( ). Без eval. */
export function evalExpr(expr: string, vars: Record<string, number>): number {
  const tokens = expr.match(/\d+(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[-+*/()]/gi) ?? [];
  if (tokens.join('') !== expr.replace(/\s+/g, '')) throw new Error(`Недопустимое выражение: ${expr}`);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): number => {
    const t = next();
    if (t === undefined) throw new Error('Неполное выражение');
    if (t === '(') { const v = sum(); if (next() !== ')') throw new Error('Нет закрывающей скобки'); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (/^[A-Za-z_]/.test(t)) { const v = vars[t]; if (v === undefined) throw new Error(`Нет параметра ${t}`); return v; }
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error(`Не число: ${t}`);
    return v;
  };
  const product = (): number => {
    let v = primary();
    while (peek() === '*' || peek() === '/') { const op = next(); const r = primary(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = product(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const v = sum();
  if (i !== tokens.length) throw new Error(`Лишние символы в выражении: ${expr}`);
  if (!Number.isFinite(v)) throw new Error(`Выражение не даёт конечного числа: ${expr}`);
  return v;
}

// ---------- Модели пользователя из даташита ----------

export type DeviceType = 'D' | 'NPN' | 'PNP' | 'NMOS' | 'PMOS' | 'VDMOS' | 'NJF' | 'PJF';

/** Выводы прибора для карточки .model: роль → подпись. */
export const DEVICE_ROLES: Record<DeviceType, Array<{ role: string; label: string }>> = {
  D: [{ role: 'A', label: 'анод' }, { role: 'K', label: 'катод' }],
  NPN: [{ role: 'C', label: 'коллектор' }, { role: 'B', label: 'база' }, { role: 'E', label: 'эмиттер' }],
  PNP: [{ role: 'C', label: 'коллектор' }, { role: 'B', label: 'база' }, { role: 'E', label: 'эмиттер' }],
  NMOS: [{ role: 'D', label: 'сток' }, { role: 'G', label: 'затвор' }, { role: 'S', label: 'исток' }],
  PMOS: [{ role: 'D', label: 'сток' }, { role: 'G', label: 'затвор' }, { role: 'S', label: 'исток' }],
  VDMOS: [{ role: 'D', label: 'сток' }, { role: 'G', label: 'затвор' }, { role: 'S', label: 'исток' }],
  NJF: [{ role: 'D', label: 'сток' }, { role: 'G', label: 'затвор' }, { role: 'S', label: 'исток' }],
  PJF: [{ role: 'D', label: 'сток' }, { role: 'G', label: 'затвор' }, { role: 'S', label: 'исток' }],
};

export type ParsedModel =
  | { kind: 'model'; name: string; type: DeviceType; body: string }
  | { kind: 'subckt'; name: string; ports: string[]; body: string };

/**
 * Разбор модели, вставленной из даташита: одна карточка .model (диод, транзистор, MOSFET) или одна
 * подсхема .subckt. Продолжения «+» склеиваются, комментарии убираются.
 */
export function parseUserModel(text: string): { ok: true; model: ParsedModel } | { ok: false; error: string } {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/;.*$/, '').replace(/\s+$/, '');
    if (!l.trim() || /^\s*\*/.test(l)) continue;
    if (/^\s*\+/.test(l) && lines.length) lines[lines.length - 1] += ' ' + l.trim().slice(1).trim();
    else lines.push(l.trim());
  }
  if (lines.length === 0) return { ok: false, error: 'Текст модели пуст' };
  const sub = lines.findIndex((l) => /^\.subckt\s/i.test(l));
  if (sub >= 0) {
    const head = lines[sub]!.split(/\s+/);
    const name = head[1];
    const ports = head.slice(2).filter((p) => !/=/.test(p) && !/^params:$/i.test(p));
    if (!name || ports.length === 0) return { ok: false, error: 'У подсхемы .subckt нет имени или выводов' };
    if (!lines.some((l) => /^\.ends\b/i.test(l))) return { ok: false, error: 'Подсхема не закрыта (.ends)' };
    if (lines.filter((l) => /^\.subckt\s/i.test(l)).length > 1 && !lines.slice(sub + 1).some((l) => /^\.ends\b/i.test(l))) return { ok: false, error: 'Не удалось разобрать подсхему' };
    const re = new RegExp(`(^|[\\s(])${escapeRe(name)}(?=$|[\\s)])`, 'gi');
    const body = lines.map((l) => (/^\.subckt\s/i.test(l) || /^x/i.test(l) || /^\.ends/i.test(l) ? l.replace(re, '$1{model}') : l)).join('\n');
    return { ok: true, model: { kind: 'subckt', name, ports, body } };
  }
  const models = lines.filter((l) => /^\.model\s/i.test(l));
  if (models.length !== 1) return { ok: false, error: models.length ? 'Вставьте одну карточку .model (или одну подсхему .subckt)' : 'Не найдено ни .model, ни .subckt' };
  const m = /^\.model\s+(\S+)\s+([A-Za-z]+)\s*(\(.*\)|.*)$/i.exec(models[0]!);
  if (!m) return { ok: false, error: 'Не удалось разобрать .model' };
  const type = m[2]!.toUpperCase();
  if (!(type in DEVICE_ROLES)) return { ok: false, error: `Тип модели ${type} не поддерживается (поддерживаются D, NPN, PNP, NMOS, PMOS, VDMOS, NJF, PJF)` };
  return { ok: true, model: { kind: 'model', name: m[1]!, type: type as DeviceType, body: `.model {model} ${type}${m[3]!.startsWith('(') ? m[3] : ` ${m[3]}`}` } };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Шаблон модели по разобранной модели и соответствию: роль/порт → номер вывода символа.
 * Для MOSFET уровня 1–3 подложка соединяется с истоком (как у дискретных транзисторов).
 */
export function templateFromParsed(m: ParsedModel, map: Record<string, string>): { text: string; missing: string[] } {
  const n = (k: string) => `{n:${map[k] ?? '?'}}`;
  const need = m.kind === 'model' ? DEVICE_ROLES[m.type].map((r) => r.role) : m.ports;
  const missing = need.filter((k) => !map[k]);
  if (m.kind === 'subckt') return { text: [`X ${m.ports.map(n).join(' ')} {model}`, m.body].join('\n'), missing };
  const el = m.type === 'D' ? `D ${n('A')} ${n('K')} {model}`
    : m.type === 'NPN' || m.type === 'PNP' ? `Q ${n('C')} ${n('B')} ${n('E')} {model}`
      : m.type === 'VDMOS' ? `M ${n('D')} ${n('G')} ${n('S')} {model}`
        : m.type === 'NJF' || m.type === 'PJF' ? `J ${n('D')} ${n('G')} ${n('S')} {model}`
          : `M ${n('D')} ${n('G')} ${n('S')} ${n('S')} {model}`;
  return { text: [el, m.body].join('\n'), missing };
}
