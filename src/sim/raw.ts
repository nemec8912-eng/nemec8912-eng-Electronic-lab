/** Разбор ASCII raw-файла ngspice (`set filetype=ascii` + `write`). Поддерживает вещественные и комплексные данные. */

export interface RawPlot {
  title: string;
  plotname: string;
  complex: boolean;
  variables: Array<{ name: string; type: string }>;
  /** Значения по переменным: для комплексных — модуль в values и фаза (рад) в phase. */
  values: Record<string, number[]>;
  imag: Record<string, number[]>;
  points: number;
}

export class RawParseError extends Error {}

export function parseRaw(text: string): RawPlot[] {
  const lines = text.split(/\r?\n/);
  const plots: RawPlot[] = [];
  let i = 0;
  while (i < lines.length) {
    // Заголовок
    const header: Record<string, string> = {};
    while (i < lines.length && !/^Variables:/i.test(lines[i]!)) {
      const m = /^([A-Za-z. ]+):\s*(.*)$/.exec(lines[i]!);
      if (m) header[m[1]!.trim().toLowerCase()] = m[2]!.trim();
      i++;
    }
    if (i >= lines.length) break;
    i++; // Variables:
    const nVars = Number(header['no. variables']);
    const nPoints = Number(header['no. points']);
    if (!Number.isInteger(nVars) || nVars <= 0 || !Number.isInteger(nPoints) || nPoints < 0) {
      throw new RawParseError('raw-файл повреждён: нет числа переменных или точек');
    }
    const complex = /complex/i.test(header.flags ?? '');
    const variables: RawPlot['variables'] = [];
    for (let v = 0; v < nVars; v++, i++) {
      const parts = (lines[i] ?? '').trim().split(/\s+/);
      if (parts.length < 3) throw new RawParseError(`raw-файл повреждён: строка переменной ${v}`);
      variables.push({ name: parts[1]!.toLowerCase(), type: parts[2]! });
    }
    if (!/^Values:/i.test(lines[i] ?? '')) throw new RawParseError('raw-файл повреждён: нет раздела Values');
    i++;
    const values: Record<string, number[]> = {};
    const imag: Record<string, number[]> = {};
    for (const v of variables) { values[v.name] = []; imag[v.name] = []; }
    // Числа идут подряд: индекс точки, затем по одному значению на переменную.
    const tokens: string[] = [];
    const need = nPoints * (nVars + 1);
    while (i < lines.length && tokens.length < need) {
      const line = lines[i]!.trim();
      if (/^[A-Za-z][A-Za-z. ]*:/.test(line) && !/^[-+\d.]/.test(line)) break; // следующий график
      if (line) tokens.push(...line.split(/\s+/));
      i++;
    }
    if (tokens.length < need) throw new RawParseError(`raw-файл обрезан: ${tokens.length} из ${need} чисел`);
    let t = 0;
    for (let p = 0; p < nPoints; p++) {
      t++; // индекс точки
      for (const v of variables) {
        const tok = tokens[t++]!;
        if (complex) {
          const [re, im] = tok.split(',').map(Number);
          values[v.name]!.push(re!);
          imag[v.name]!.push(im ?? 0);
        } else {
          const x = Number(tok);
          if (!Number.isFinite(x)) throw new RawParseError(`raw-файл: нечисловое значение «${tok}»`);
          values[v.name]!.push(x);
        }
      }
    }
    plots.push({ title: header.title ?? '', plotname: header.plotname ?? '', complex, variables, values, imag, points: nPoints });
  }
  return plots;
}
