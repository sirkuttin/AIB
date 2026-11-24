/**
 * Reading and writing the JSON state files exactly as state_store.py does, so Python and Deno processes can share them.
 *
 * parseJson is json.loads: it also accepts NaN / Infinity / -Infinity, and it remembers each object's key order as written
 * (a plain JS object would move integer-like keys such as "12" first; Python keeps file order, which decides what is pruned).
 * keysOf / entriesOf give that order back. dumpJson is json.dump(ensure_ascii=False, separators=(',', ':')) for plain values
 * and Maps (a Map keeps insertion order for every key), writing NaN / Infinity as Python does.
 */
import { writeJsonAtomic } from '../core/fs.ts';

const ORDER = Symbol('keyOrder');
type Dict = Record<string, unknown> & { [ORDER]?: string[] };

/** Set an own property even for '__proto__' (plain assignment would change the prototype). */
export function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  else target[key] = value;
}

/** The keys of a dict in the order they were written in the file (insertion order for dicts built here). */
export function keysOf(value: Record<string, unknown>): string[] {
  return (value as Dict)[ORDER] ?? Object.keys(value);
}

export function entriesOf(value: Record<string, unknown>): [string, unknown][] {
  return keysOf(value).map((key) => [key, value[key]]);
}

class ParseError extends Error {}

/** json.loads(text). Throws on what Python refuses (also a BOM, control characters in strings and extra data). */
export function parseJson(text: string): unknown {
  let i = 0;
  const fail = (): never => {
    throw new ParseError(`invalid JSON at ${i}`);
  };
  const space = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const string = (): string => {
    i++; // opening quote
    let out = '';
    let start = i;
    for (;;) {
      if (i >= text.length) fail();
      const code = text.charCodeAt(i);
      if (code === 34) break;
      if (code < 32) fail();
      if (code === 92) {
        out += text.slice(start, i);
        const esc = text[i + 1];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (esc in simple) {
          out += simple[esc];
          i += 2;
        } else if (esc === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else fail();
        start = i;
        continue;
      }
      i++;
    }
    out += text.slice(start, i);
    i++;
    return out;
  };
  const value = (): unknown => {
    space();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const obj: Dict = {};
      const order: string[] = [];
      space();
      if (text[i] === '}') {
        i++;
      } else {
        for (;;) {
          space();
          if (text[i] !== '"') fail();
          const key = string();
          space();
          if (text[i] !== ':') fail();
          i++;
          const item = value();
          if (!Object.prototype.hasOwnProperty.call(obj, key)) order.push(key);
          put(obj, key, item);
          space();
          if (text[i] === ',') {
            i++;
            continue;
          }
          if (text[i] === '}') {
            i++;
            break;
          }
          fail();
        }
      }
      if (order.some((key) => /^(0|[1-9][0-9]*)$/.test(key))) {
        Object.defineProperty(obj, ORDER, { value: order, enumerable: false });
      }
      return obj;
    }
    if (ch === '[') {
      i++;
      const list: unknown[] = [];
      space();
      if (text[i] === ']') {
        i++;
        return list;
      }
      for (;;) {
        list.push(value());
        space();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return list;
        }
        fail();
      }
    }
    if (ch === '"') return string();
    for (const [word, result] of [['true', true], ['false', false], ['null', null], ['NaN', NaN], ['Infinity', Infinity]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return result;
      }
    }
    if (text.startsWith('-Infinity', i)) {
      i += 9;
      return -Infinity;
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;
    number.lastIndex = i;
    const match = number.exec(text);
    if (!match) fail();
    i += match![0].length;
    return Number(match![0]);
  };
  const result = value();
  space();
  if (i !== text.length) fail();
  return result;
}

function dumpString(value: string): string {
  return JSON.stringify(value);
}

/** json.dumps(value, ensure_ascii=False, separators=(',', ':')) for plain values and Maps. */
export function dumpJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return dumpString(value);
  if (Array.isArray(value)) return '[' + value.map(dumpJson).join(',') + ']';
  const entries = value instanceof Map ? [...value.entries()] : entriesOf(value as Record<string, unknown>);
  return '{' + entries.filter(([, v]) => v !== undefined).map(([k, v]) => dumpString(String(k)) + ':' + dumpJson(v)).join(',') + '}';
}

// ---- files ---------------------------------------------------------------------------------------

export const READ_ATTEMPTS = 5;
/** state_store.READ_BACKOFF in ms (doubled each retry, at most 500 ms). Tests set it to 0, as the Python tests patch it. */
export const timing = { readBackoffMs: 50 };

export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type ReadStatus = 'ok' | 'missing' | 'corrupt' | 'busy';

/**
 * read_json_file: 'ok' with the value, 'missing', 'corrupt' (a real parse or UTF-8 error) or 'busy' (still unreadable after
 * retries: antivirus, an indexer or another process holding it). Synchronous, like Python's, so a store's reads stay atomic.
 */
export function readJsonFile(path: string): [ReadStatus, unknown] {
  let delay = timing.readBackoffMs;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    let bytes: Uint8Array;
    try {
      bytes = Deno.readFileSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return ['missing', null];
      if (attempt === READ_ATTEMPTS - 1) return ['busy', null];
      sleepSync(delay);
      delay = Math.min(delay * 2, 500);
      continue;
    }
    try {
      return ['ok', parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))];
    } catch {
      return ['corrupt', null];
    }
  }
  return ['busy', null];
}

/** (mtime, size, file id) of the file, or null: changes whenever another process replaces it. */
export function fileStamp(path: string): string | null {
  try {
    const info = Deno.statSync(path);
    return `${info.mtime?.getTime() ?? 0}:${info.size}:${info.ino ?? 0}:${info.dev ?? 0}`;
  } catch {
    return null;
  }
}

/** path.with_suffix('.corrupt'): studio-x.json -> studio-x.corrupt. */
export function corruptPath(path: string): string {
  return path.replace(/\.[^.\\/]*$/, '') + '.corrupt';
}

/** os.replace(path, path.with_suffix('.corrupt')), ignoring errors. */
export function quarantine(path: string): void {
  try {
    Deno.renameSync(path, corruptPath(path));
  } catch { /* left where it is */ }
}

/** Atomic compact JSON write with Python's mkstemp prefix (tempfile + fsync + replace with retries). */
export function saveJson(path: string, payload: unknown, prefix: string): void {
  writeJsonAtomic(path, null, { prefix, suffix: '.tmp', text: dumpJson(payload) });
}

/** time.time() */
export function now(): number {
  return Date.now() / 1000;
}
