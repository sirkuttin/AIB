/**
 * Python behaviour the transcript viewer (monitor.py) depends on and that core/py.ts does not cover: Python's regex classes
 * (\s, \w, \d are Unicode in Python, ASCII in JS), str.splitlines/title/split, int(), truthiness and `or`, hashing rules,
 * json.dumps(indent=2), urllib.parse.parse_qs, base64.b64decode(validate=True) and datetime.fromisoformat().timestamp().
 * Kept beside monitor.ts because only the transcript port needs them.
 */
import { clip, isDict, PY_SPACE, pyRepr, pyStr, ValueError } from '../core/py.ts';

/** Python's \s as a character-class body (use inside [...] with the u flag). */
export const S = PY_SPACE;
/** Python's \w (str patterns) as a character-class body; needs the u flag. */
export const W = '\\p{L}\\p{N}_';
/** Python's \d (str patterns): Unicode decimal digits. */
export const D = '\\p{Nd}';

/** Python's TypeError (a 400 at the HTTP layer, like ValueError). */
export class PyTypeError extends Error {
  override name = 'TypeError';
}

/** Python's AttributeError: monitor.py does not catch it, so the request fails (the Python server drops the connection). */
export class PyAttributeError extends Error {
  override name = 'AttributeError';
}

/** type(value).__name__ for a parsed JSON value. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

/** d.get(key, default) on a dict; AttributeError when `d` is not a dict (as in Python). */
export function get(d: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(d)) throw new PyAttributeError(`'${pyTypeName(d)}' object has no attribute 'get'`);
  return Object.hasOwn(d, key) ? d[key] : fallback;
}

/** d.get(key, default) for an object known to be a dict. */
export function dget(d: Record<string, unknown>, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(d, key) ? d[key] : fallback;
}

/** Python truthiness of a JSON value. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Python's `a or b or c`: the first truthy value, else the last. */
export function or(...values: unknown[]): unknown {
  for (const value of values) if (truthy(value)) return value;
  return values[values.length - 1];
}

/** A Map key for a value used as a Python dict key or set member (1 == True == 1.0); TypeError when unhashable. */
export function hkey(value: unknown): string {
  if (value === null || value === undefined) return 'N';
  if (typeof value === 'string') return 's' + value;
  if (typeof value === 'boolean') return 'n' + (value ? 1 : 0);
  if (typeof value === 'number') return 'n' + value;
  throw new PyTypeError(`unhashable type: '${pyTypeName(value)}'`);
}

/** isinstance(value, (int, float)) and not bool. */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

/** str + value: TypeError unless value is a str (Python does not coerce). */
export function concat(left: string, right: unknown): string {
  if (typeof right !== 'string') throw new PyTypeError(`can only concatenate str (not "${pyTypeName(right)}") to str`);
  return left + right;
}

/** re functions refuse non-strings. */
export function needStr(value: unknown): string {
  if (typeof value !== 'string') throw new PyTypeError(`expected string or bytes-like object, got '${pyTypeName(value)}'`);
  return value;
}

/** Python's str.splitlines(). */
// deno-lint-ignore no-control-regex -- Python's line breaks include the \x1c-\x1e separators
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
export function splitlines(text: string): string[] {
  const parts = text.split(LINE_BREAK);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Python's bytes.splitlines(): breaks at \n, \r and \r\n only. */
export function bytesSplitlines(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 10 || b === 13) {
      out.push(data.subarray(start, i));
      if (b === 13 && data[i + 1] === 10) i++;
      start = i + 1;
    }
  }
  if (start < data.length) out.push(data.subarray(start));
  return out;
}

const SPACE_RUN = new RegExp(`[${S}]+`, 'u');
/** Python's str.split() with no argument. */
export function pySplit(text: string): string[] {
  return text.split(SPACE_RUN).filter((part) => part !== '');
}

/** Python's str.lstrip(). */
const LEADING_SPACE = new RegExp(`^[${S}]+`, 'u');
export function lstrip(text: string): string {
  return text.replace(LEADING_SPACE, '');
}

/** Python's str.rstrip(chars) for BMP chars. */
export function rstrip(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

const CASED = /\p{Cased}/u;
// The letters whose title case is neither their upper nor their lower case (Unicode digraphs).
const TITLE_CASE: Record<string, string> = Object.fromEntries(
  [['Ǆǅǆ', 'ǅ'], ['Ǉǈǉ', 'ǈ'], ['Ǌǋǌ', 'ǋ'], ['Ǳǲǳ', 'ǲ']]
    .flatMap(([group, title]) => [...group].map((c) => [c, title])),
);
/** Python's str.title() (title case taken as upper case; ß -> Ss). AttributeError for a non-str, as role.title() would raise. */
export function pyTitle(value: unknown): string {
  if (typeof value !== 'string') throw new PyAttributeError(`'${pyTypeName(value)}' object has no attribute 'title'`);
  let out = '';
  let previousCased = false;
  for (const ch of value) {
    if (previousCased) out += ch.toLowerCase();
    else if (Object.hasOwn(TITLE_CASE, ch)) out += TITLE_CASE[ch];
    else {
      const upper = ch.toUpperCase();
      out += upper.length > 1 && [...upper].length > 1 ? upper[0] + upper.slice(1).toLowerCase() : upper;
    }
    previousCased = CASED.test(ch);
  }
  return out;
}

/** Python's str.casefold(), closely enough for a substring search. */
export function casefold(value: string): string {
  return value.toUpperCase().toLowerCase();
}

/** Compare two strings by code point, as Python does (JS < compares UTF-16 units). */
export function strCmp(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const hx = x >= 0xd800 && x <= 0xdfff;
      const hy = y >= 0xd800 && y <= 0xdfff;
      if (hx !== hy) return hx ? 1 : -1; // a surrogate (astral code point) sorts after any BMP unit
      return x - y;
    }
  }
  return a.length - b.length;
}

/** Python's value-or-truncated-copy with the viewer's note (monitor.clipped). */
export const CLIP_NOTE = '\n\n[Display shortened; full text remains in the original transcript.]';

function digitValue(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp >= 48 && cp <= 57) return cp - 48;
  let start = cp;
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1)) && cp - start < 60) start--;
  return (cp - start) % 10;
}

/** int(text) for a str, base 10, with Python's error message. */
export function pyInt(text: string): number {
  const stripped = text.replace(new RegExp(`^[${S}]+|[${S}]+$`, 'gu'), '');
  const m = /^([+-]?)(\p{Nd}+(?:_\p{Nd}+)*)$/u.exec(stripped);
  if (!m) throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(text)}`);
  let value = 0;
  for (const ch of m[2]) if (ch !== '_') value = value * 10 + digitValue(ch);
  return m[1] === '-' ? -value : value;
}

/** int(d) for the digits a Python \d+ group matched. */
export function digitsInt(text: string): number {
  let value = 0;
  for (const ch of text) value = value * 10 + digitValue(ch);
  return value;
}

/** json.dumps(value, ensure_ascii=False, indent=2). Numbers print as Python prints them (whole numbers as ints). */
export function dumpsIndent2(value: unknown, level = 0): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return pyRepr(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  const pad = '  '.repeat(level + 1);
  const end = '\n' + '  '.repeat(level) + (Array.isArray(value) ? ']' : '}');
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '[\n' + value.map((v) => pad + dumpsIndent2(v, level + 1)).join(',\n') + end;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return '{}';
  return '{\n' + entries.map(([k, v]) => pad + JSON.stringify(k) + ': ' + dumpsIndent2(v, level + 1)).join(',\n') + end;
}

/** monitor.clipped: text as is, other values as indented JSON, cut at `limit` code points with a note. */
export function clipped(value: unknown, limit = 32000): string {
  const text = typeof value === 'string' ? value : dumpsIndent2(value);
  const cut = clip(text, limit);
  return cut.length === text.length ? text : cut + CLIP_NOTE;
}

/** str(value) as Python prints it. */
export { pyStr };

// ---- urllib.parse.parse_qs ------------------------------------------------------------------

function unquote(text: string): string {
  if (!text.includes('%')) return text;
  // deno-lint-ignore no-control-regex -- ASCII runs, as urllib.parse.unquote splits them
  return text.replace(/[\x00-\x7f]+/g, (run) => {
    if (!run.includes('%')) return run;
    const bytes: number[] = [];
    const pieces = run.split('%');
    for (const ch of new TextEncoder().encode(pieces[0])) bytes.push(ch);
    for (const item of pieces.slice(1)) {
      const hex = item.slice(0, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        for (const ch of new TextEncoder().encode(item.slice(2))) bytes.push(ch);
      } else {
        for (const ch of new TextEncoder().encode('%' + item)) bytes.push(ch);
      }
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  });
}

/** urllib.parse.parse_qs(query): blank values dropped, '+' is a space, bad escapes kept, bad UTF-8 replaced. */
export function parseQs(query: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    if (at < 0) continue;
    const rawValue = part.slice(at + 1);
    if (!rawValue.length) continue;
    const name = unquote(part.slice(0, at).replaceAll('+', ' '));
    const value = unquote(rawValue.replaceAll('+', ' '));
    if (!out.has(name)) out.set(name, []);
    out.get(name)!.push(value);
  }
  return out;
}

// ---- base64.b64decode(data, validate=True) (Python 3.11 strict mode) ------------------------

const B64 = (() => {
  const table = new Int16Array(256).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

/** The bytes, or a ValueError with Python's message (binascii.Error is a ValueError). */
export function b64decodeStrict(text: string): Uint8Array {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) throw new ValueError('string argument should contain only ASCII characters');
  }
  if (text.length && text[0] === '=') throw new ValueError('Leading padding not allowed');
  const out = new Uint8Array(Math.floor(text.length * 3 / 4) + 3);
  let o = 0;
  let quad = 0;
  let left = 0;
  let pads = 0;
  let padding = false;
  let done = false;
  for (let i = 0; i < text.length && !done; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) {
      padding = true;
      if (quad >= 2 && quad + ++pads >= 4) {
        if (i + 1 < text.length) throw new ValueError('Excess data after padding');
        done = true;
      }
      continue;
    }
    const v = B64[code];
    if (v < 0) throw new ValueError('Only base64 data is allowed');
    if (padding) throw new ValueError('Discontinuous padding not allowed');
    pads = 0;
    switch (quad) {
      case 0:
        quad = 1;
        left = v;
        break;
      case 1:
        quad = 2;
        out[o++] = (left << 2) | (v >> 4);
        left = v & 0x0f;
        break;
      case 2:
        quad = 3;
        out[o++] = (left << 4) | (v >> 2);
        left = v & 0x03;
        break;
      default:
        quad = 0;
        out[o++] = (left << 6) | v;
        left = 0;
    }
  }
  if (!done && quad !== 0) {
    if (quad === 1) {
      throw new ValueError(
        `Invalid base64-encoded string: number of data characters (${Math.floor(o / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`,
      );
    }
    throw new ValueError('Incorrect padding');
  }
  return out.slice(0, o);
}

// ---- datetime.fromisoformat(text).timestamp() (CPython 3.11 C implementation) ---------------

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const ORD_EPOCH = 719163; // date(1970, 1, 1).toordinal()
const ymdToOrd = (y: number, m: number, d: number) => daysFromCivil(y, m, d) + ORD_EPOCH;

class Bytes {
  constructor(readonly b: Uint8Array) {}
  at(i: number): number {
    return i < this.b.length ? this.b[i] : 0;
  }
}

const isDigit = (c: number) => c >= 48 && c <= 57;

function parseDigits(s: Bytes, p: number, n: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < n; i++, p++) {
    const c = s.at(p);
    if (!isDigit(c)) return null;
    value = value * 10 + c - 48;
  }
  return [p, value];
}

function separatorAt(s: Bytes, len: number): number {
  if (len === 7) return 7;
  if (s.at(4) === 45) {
    if (s.at(5) === 87) {
      if (len < 8) return -1;
      if (len > 8 && s.at(8) === 45) {
        if (len === 9) return -1;
        if (len > 10 && isDigit(s.at(10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (s.at(4) === 87) {
    let idx = 7;
    for (; idx < len; idx++) if (!isDigit(s.at(idx))) break;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

function parseDate(s: Bytes, len: number): [number, number, number] | null {
  const year = parseDigits(s, 0, 4);
  if (!year) return null;
  let p = year[0];
  const sep = s.at(p) === 45;
  if (sep) p++;
  if (s.at(p) === 87) {
    p++;
    const week = parseDigits(s, p, 2);
    if (!week) return null;
    p = week[0];
    let day = 1;
    if (p < len) {
      if (sep && s.at(p++) !== 45) return null;
      const d = parseDigits(s, p, 1);
      if (!d) return null;
      day = d[1];
    }
    const y = year[1];
    if (week[1] <= 0 || week[1] >= 53) {
      let out = true;
      if (week[1] === 53) {
        const first = (ymdToOrd(y, 1, 1) + 6) % 7;
        if (first === 3 || (first === 2 && isLeap(y))) out = false;
      }
      if (out) return null;
    }
    if (day <= 0 || day >= 8) return null;
    const firstDay = ymdToOrd(y, 1, 1);
    const firstWeekday = (firstDay + 6) % 7;
    let monday = firstDay - firstWeekday;
    if (firstWeekday > 3) monday += 7;
    return civilFromDays(monday + (week[1] - 1) * 7 + day - 1 - ORD_EPOCH);
  }
  const month = parseDigits(s, p, 2);
  if (!month) return null;
  p = month[0];
  if (sep && s.at(p++) !== 45) return null;
  const day = parseDigits(s, p, 2);
  if (!day) return null;
  return [year[1], month[1], day[1]];
}

/** [rc, h, m, s, us]: rc < 0 failure, 1 when something follows. */
function parseHms(s: Bytes, start: number, end: number): [number, number, number, number, number] {
  const vals = [0, 0, 0];
  let p = start;
  let hasSep = true;
  let i = 0;
  for (; i < 3; i++) {
    const r = parseDigits(s, p, 2);
    if (!r) return [-3, 0, 0, 0, 0];
    p = r[0];
    vals[i] = r[1];
    const c = s.at(p++);
    if (i === 0) hasSep = c === 58;
    if (p >= end) return [c !== 0 ? 1 : 0, vals[0], vals[1], vals[2], 0];
    if (hasSep && c === 58) continue;
    if (c === 46 || c === 44) break;
    if (!hasSep) p--;
    else return [-4, 0, 0, 0, 0];
  }
  const remains = end - p;
  const toParse = remains >= 6 ? 6 : remains;
  const frac = parseDigits(s, p, toParse);
  if (!frac) return [-3, 0, 0, 0, 0];
  p = frac[0];
  let us = frac[1];
  if (toParse < 6) us *= [100000, 10000, 1000, 100, 10][toParse - 1] ?? 1;
  while (isDigit(s.at(p))) p++;
  return [s.at(p) !== 0 ? 1 : 0, vals[0], vals[1], vals[2], us];
}

function invalid(text: string): never {
  throw new ValueError(`Invalid isoformat string: ${pyRepr(text)}`);
}

/** datetime.fromisoformat(text).timestamp(): aware times are exact, naive ones are read as local time. ValueError as Python. */
export function isoTimestamp(text: string): number {
  const bytes = new TextEncoder().encode(text);
  const s = new Bytes(bytes);
  const len = bytes.length;
  const sepAt = separatorAt(s, len);
  if (sepAt < 0) invalid(text);
  const date = parseDate(s, sepAt);
  if (!date) invalid(text);
  let [h, mi, se, us] = [0, 0, 0, 0];
  let tz: number | null = null;
  let tzUs = 0;
  if (len > sepAt) {
    const p = sepAt + 1;
    let tzAt = p;
    do {
      const c = s.at(tzAt);
      if (c === 90 || c === 43 || c === 45) break;
    } while (++tzAt < len);
    const t = parseHms(s, p, tzAt);
    if (t[0] < 0) invalid(text);
    [, h, mi, se, us] = t;
    if (tzAt >= len) {
      if (t[0] === 1) invalid(text);
    } else if (s.at(tzAt) === 90) {
      if (tzAt + 1 !== len) invalid(text);
      tz = 0;
    } else {
      const sign = s.at(tzAt) === 45 ? -1 : 1;
      const z = parseHms(s, tzAt + 1, len);
      if (z[0] !== 0) invalid(text);
      tz = sign * (z[1] * 3600 + z[2] * 60 + z[3]);
      tzUs = sign * z[4];
    }
  }
  const [y, m, d] = date;
  if (y < 1 || y > 9999) throw new ValueError(`year ${y} is out of range`);
  if (m < 1 || m > 12) throw new ValueError('month must be in 1..12');
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d < 1 || d > dim) throw new ValueError('day is out of range for month');
  if (h > 23) throw new ValueError('hour must be in 0..23');
  if (mi > 59) throw new ValueError('minute must be in 0..59');
  if (se > 59) throw new ValueError('second must be in 0..59');
  if (tz !== null && Math.abs(tz * 1e6 + tzUs) >= 86400e6) {
    throw new ValueError('offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24).');
  }
  const days = daysFromCivil(y, m, d);
  if (tz !== null) {
    const micros = ((days * 86400 + h * 3600 + mi * 60 + se) - tz) * 1e6 + us - tzUs;
    return micros / 1e6;
  }
  const local = new Date(2000, 0, 1, h, mi, se, 0);
  local.setFullYear(y, m - 1, d);
  return Math.floor(local.getTime() / 1000) + us / 1e6;
}

/** True for Deno's file-system errors (Python's OSError family). */
export function isOSError(error: unknown): boolean {
  return Object.values(Deno.errors).some((kind) => error instanceof kind);
}
