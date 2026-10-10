/** Разбор S-выражений (формат файлов KiCad .kicad_sym / .kicad_mod). Без рекурсии — выдерживает большие библиотеки. */

export type SNode = string | SNode[];

export class SexprError extends Error {}

/** Разобрать текст; возвращает верхнеуровневые списки. */
export function parseSexpr(text: string): SNode[][] {
  const root: SNode[] = [];
  const stack: SNode[][] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 40 /* ( */) { const list: SNode[] = []; stack[stack.length - 1]!.push(list); stack.push(list); i++; continue; }
    if (c === 41 /* ) */) { if (stack.length === 1) throw new SexprError(`Лишняя «)» в позиции ${i}`); stack.pop(); i++; continue; }
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    if (c === 34 /* " */) {
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new SexprError('Незакрытая строка');
        const ch = text[i]!;
        if (ch === '\\') { const nx = text[i + 1]; s += nx === 'n' ? '\n' : nx ?? ''; i += 2; continue; }
        if (ch === '"') { i++; break; }
        s += ch; i++;
      }
      stack[stack.length - 1]!.push(s);
      continue;
    }
    let j = i;
    while (j < n) { const d = text.charCodeAt(j); if (d === 40 || d === 41 || d === 32 || d === 9 || d === 10 || d === 13 || d === 34) break; j++; }
    stack[stack.length - 1]!.push(text.slice(i, j));
    i = j;
  }
  if (stack.length !== 1) throw new SexprError('Не хватает «)» в конце файла');
  return root.filter((x): x is SNode[] => Array.isArray(x));
}

export const head = (x: SNode | undefined): string | null => (Array.isArray(x) && typeof x[0] === 'string' ? x[0] : null);
/** Дочерние списки с заданной головой. */
export const children = (x: SNode | undefined, name: string): SNode[][] =>
  (Array.isArray(x) ? x : []).filter((c): c is SNode[] => Array.isArray(c) && c[0] === name);
export const child = (x: SNode | undefined, name: string): SNode[] | undefined => children(x, name)[0];
/** Атом по индексу (0 — голова). */
export const atom = (x: SNode | undefined, idx: number): string | undefined => {
  const v = Array.isArray(x) ? x[idx] : undefined;
  return typeof v === 'string' ? v : undefined;
};
export const atoms = (x: SNode | undefined): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
export const num = (x: SNode | undefined, idx: number): number | undefined => {
  const s = atom(x, idx);
  if (s === undefined) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};
/** Есть ли флаг: атом `hide` (KiCad 6–7) или список `(hide yes)` (KiCad 8+). */
export const flag = (x: SNode | undefined, name: string): boolean => atoms(x).includes(name) || atom(child(x, name), 1) === 'yes';
