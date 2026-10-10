/**
 * Получение файлов KiCad: из официальных библиотек на gitlab.com (только по действию пользователя)
 * или из файлов на компьютере. Единственное место программы, где есть обращение к сети.
 * После импорта деталь хранится в каталоге и доступна без интернета.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AppError } from '../core/result';
import { isSafeKicadName, KicadError, KICAD_LICENSE, parseFootprint, readSymbolsRaw, resolveExtends, splitFootprintRef, summarize, type KicadFootprint, type KicadSymbol, type SymbolSummary } from './kicad';
import { SexprError } from './sexpr';

const SYMBOLS_RAW = 'https://gitlab.com/kicad/libraries/kicad-symbols/-/raw';
const FOOTPRINTS_RAW = 'https://gitlab.com/kicad/libraries/kicad-footprints/-/raw';
const SYMBOLS_TREE = 'https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-symbols/repository/tree';
const ALLOWED_HOST = 'gitlab.com';
const MAX_BYTES = 60 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** Для тестов: вместо gitlab.com читать файлы из папки (symbols/<Lib>.kicad_sym, footprints/<Lib>.pretty/<Name>.kicad_mod). */
const fixtureDir = () => process.env.ELAB_KICAD_FIXTURE_DIR || null;

async function fetchText(url: string): Promise<string | null> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) throw new AppError('import-url', `Адрес вне официальных библиотек KiCad: ${url}`);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    throw new AppError('import-network', `Нет доступа к ${ALLOWED_HOST}: ${(e as Error).message}. Проверьте интернет или импортируйте файлы KiCad с компьютера.`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new AppError('import-network', `${ALLOWED_HOST} ответил ошибкой ${res.status} на ${url}`);
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > MAX_BYTES) throw new AppError('import-too-big', `Файл слишком большой (${Math.round(len / 1048576)} МБ)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new AppError('import-too-big', 'Файл слишком большой');
  return buf.toString('utf8');
}

async function fixtureText(rel: string): Promise<string | null> {
  try { return await fs.readFile(path.join(fixtureDir()!, rel), 'utf8'); } catch { return null; }
}

function checkName(kind: string, s: string) {
  if (!isSafeKicadName(s)) throw new AppError('import-name', `${kind} «${s}»: допустимы латинские буквы, цифры и символы _ . + - , ( )`);
}

function parseError(e: unknown, what: string): never {
  if (e instanceof KicadError || e instanceof SexprError) throw new AppError('import-format', `${what}: ${e.message}`);
  throw e;
}

/** Открытая библиотека символов (держится в памяти главного процесса до построения детали). */
export interface OpenedLibrary {
  library: string;
  /** Где взяли: адрес или путь — попадёт в источник детали. */
  origin: string;
  license: string | null;
  symbols: KicadSymbol[];
  summaries: SymbolSummary[];
  /** Для библиотек-папок KiCad 9 символы подгружаются по одному. */
  loadSymbol(name: string): Promise<{ symbol: KicadSymbol; sources: string[] }>;
}

function combined(library: string, origin: string, license: string | null, text: string): OpenedLibrary {
  let symbols: KicadSymbol[];
  try { symbols = resolveExtends(readSymbolsRaw(text)); } catch (e) { parseError(e, `Библиотека ${library}`); }
  return {
    library, origin, license, symbols, summaries: symbols.map(summarize),
    loadSymbol: async (name) => {
      const s = symbols.find((x) => x.name === name);
      if (!s) throw new AppError('import-not-found', `В библиотеке ${library} нет символа ${name}`);
      return { symbol: s, sources: [origin] };
    },
  };
}

/** Библиотека символов из официального репозитория KiCad (или из папки тестовых данных). */
export async function openOnlineLibrary(library: string): Promise<OpenedLibrary> {
  checkName('Библиотека', library);
  if (fixtureDir()) {
    const text = await fixtureText(path.join('symbols', `${library}.kicad_sym`));
    if (text === null) throw new AppError('import-not-found', `Библиотека символов KiCad «${library}» не найдена`);
    return combined(library, `${SYMBOLS_RAW}/master/${library}.kicad_sym`, KICAD_LICENSE, text);
  }
  const lib = encodeURIComponent(library);
  // 1) Единый файл библиотеки (KiCad 6–8 и ветка master до перехода на папки).
  const mainUrl = `${SYMBOLS_RAW}/master/${lib}.kicad_sym`;
  const text = await fetchText(mainUrl);
  if (text !== null) return combined(library, mainUrl, KICAD_LICENSE, text);
  // 2) Библиотека-папка KiCad 9: <Lib>.kicad_symdir/<Символ>.kicad_sym.
  const names: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const list = await fetchText(`${SYMBOLS_TREE}?ref=master&per_page=100&page=${page}&path=${encodeURIComponent(`${library}.kicad_symdir`)}`);
    if (list === null) break;
    let items: Array<{ name: string; type: string }>;
    try { items = JSON.parse(list); } catch { throw new AppError('import-network', 'Не удалось прочитать список символов с gitlab.com'); }
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) if (it.type === 'blob' && it.name.endsWith('.kicad_sym')) names.push(it.name.slice(0, -'.kicad_sym'.length));
    if (items.length < 100) break;
  }
  if (names.length) {
    const dirUrl = `${SYMBOLS_RAW}/master/${lib}.kicad_symdir`;
    const cache = new Map<string, KicadSymbol>();
    const fetchRaw = async (name: string): Promise<{ syms: KicadSymbol[]; url: string }> => {
      checkName('Символ', name);
      const url = `${dirUrl}/${encodeURIComponent(name)}.kicad_sym`;
      const t = await fetchText(url);
      if (t === null) throw new AppError('import-not-found', `В библиотеке ${library} нет символа ${name}`);
      try { return { syms: readSymbolsRaw(t), url }; } catch (e) { parseError(e, `Символ ${name}`); }
    };
    return {
      library, origin: dirUrl, license: KICAD_LICENSE, symbols: [],
      summaries: names.sort().map((name) => ({ name, description: '', reference: '', footprint: '', datasheet: '', keywords: '', pinCount: 0, extends: null })),
      loadSymbol: async (name) => {
        const sources: string[] = [];
        let want: string | null = name;
        for (let depth = 0; want && depth < 10; depth++) {
          if (cache.has(want)) { want = cache.get(want)!.extends; continue; }
          const r = await fetchRaw(want);
          sources.push(r.url);
          for (const s of r.syms) cache.set(s.name, s);
          want = cache.get(want)?.extends ?? null;
        }
        const resolved = resolveExtends([...cache.values()]).find((s) => s.name === name);
        if (!resolved) throw new AppError('import-not-found', `В библиотеке ${library} нет символа ${name}`);
        return { symbol: resolved, sources };
      },
    };
  }
  throw new AppError('import-not-found', `Библиотека символов KiCad «${library}» не найдена на gitlab.com. Проверьте название (например: Timer, Device, Transistor_BJT).`);
}

/** Библиотека символов из файла на компьютере. */
export async function openLibraryFile(file: string): Promise<OpenedLibrary> {
  const text = await fs.readFile(file, 'utf8');
  const library = path.basename(file).replace(/\.kicad_sym$/i, '');
  return combined(library, file, null, text);
}

/** Посадочное место «Библиотека:Имя» из официального репозитория. */
export async function fetchOnlineFootprint(ref: string): Promise<{ fp: KicadFootprint; source: string }> {
  const r = splitFootprintRef(ref);
  if (!r) throw new AppError('import-name', `Посадочное место указывается как «Библиотека:Имя», например Package_DIP:DIP-8_W7.62mm (получено «${ref}»)`);
  checkName('Библиотека посадочных мест', r.library);
  checkName('Посадочное место', r.name);
  const rel = `${r.library}.pretty/${r.name}.kicad_mod`;
  const url = `${FOOTPRINTS_RAW}/master/${encodeURIComponent(r.library)}.pretty/${encodeURIComponent(r.name)}.kicad_mod`;
  const text = fixtureDir() ? await fixtureText(path.join('footprints', rel)) : await fetchText(url);
  if (text === null) throw new AppError('import-not-found', `Посадочное место ${ref} не найдено в библиотеках KiCad`);
  try { return { fp: parseFootprint(text), source: url }; } catch (e) { parseError(e, `Посадочное место ${ref}`); }
}

export async function readFootprintFile(file: string): Promise<{ fp: KicadFootprint; source: string }> {
  const text = await fs.readFile(file, 'utf8');
  try { return { fp: parseFootprint(text), source: file }; } catch (e) { parseError(e, path.basename(file)); }
}
