/**
 * Small helpers that reproduce Python behaviour the HTTP API depends on, so ported code gives byte-identical answers:
 * string slicing by code point (Python) rather than UTF-16 unit (JS), dict/list type checks, and Python's json.dumps spacing.
 */

/** Python's s[:n] for a str: counts code points, so an emoji is never cut in half. */
export function clip(value: string, limit: number): string {
  if (value.length <= limit) return value; // fast path: UTF-16 length >= code point count
  let count = 0;
  let index = 0;
  while (index < value.length && count < limit) {
    const code = value.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < value.length ? 2 : 1;
    count++;
  }
  return value.slice(0, index);
}

/** len(s) in Python: code points. */
export function pyLen(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** isinstance(value, dict) for parsed JSON. */
export function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** isinstance(value, str) */
export function isStr(value: unknown): value is string {
  return typeof value === 'string';
}

/** isinstance(value, int) for parsed JSON (bool is excluded; Python's bool is an int but JSON true never reaches these checks as int). */
export function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** The value if it is a dict, else {} (Python: x if isinstance(x, dict) else {}). */
export function dictOr(value: unknown): Record<string, unknown> {
  return isDict(value) ? value : {};
}

/** The value if it is a list, else [] . */
export function listOr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** json.dumps(value) with Python's default separators (', ' and ': ') and ensure_ascii=True (or ensure_ascii=False). */
export function pyJsonDumps(value: unknown, ensureAscii = true): string {
  const text = JSON.stringify(value, null, 1);
  if (text === undefined) return 'null';
  // Re-join JSON.stringify's indented output into Python's one-line spacing without touching string contents.
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i];
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '\n') {
      while (text[i + 1] === ' ') i++;
      if (out.endsWith(',')) out += ' ';
    } else if (ch === ':') {
      out += ': ';
      if (text[i + 1] === ' ') i++;
    } else out += ch;
  }
  if (!ensureAscii) return out;
  return out.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Python's ValueError. Ported modules throw it with Python's exact message; the HTTP layer answers it with a 400. */
export class ValueError extends Error {
  override name = 'ValueError';
}

/** The characters Python's str.isspace(), str.strip() and re's \s treat as whitespace (JS \s has U+FEFF, lacks U+001C-1F and U+0085). */
export const PY_SPACE = '\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000';
const SPACE = new RegExp(`[${PY_SPACE}]`);

/** True when the string contains a character for which Python's str.isspace() is true. */
export function pyHasSpace(value: string): boolean {
  return SPACE.test(value);
}

/** Python's s.strip() (Python whitespace) or s.strip(chars) for BMP chars. */
export function pyStrip(value: string, chars?: string): string {
  const strip = chars === undefined ? (c: string) => SPACE.test(c) : (c: string) => chars.includes(c);
  let start = 0;
  let end = value.length;
  while (start < end && strip(value[start])) start++;
  while (end > start && strip(value[end - 1])) end--;
  return value.slice(start, end);
}

const NOT_PRINTABLE = /(?! )[\p{C}\p{Z}]/u;

/** Python's str.isprintable(): no control, format, surrogate, private, unassigned or separator characters except the plain space. */
export function pyIsPrintable(value: string): boolean {
  return !NOT_PRINTABLE.test(value);
}

function strRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const hex = (cp: number, width: number) => cp.toString(16).padStart(width, '0');
  let out = quote;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + hex(cp, 2);
    else if (cp < 0x7f || pyIsPrintable(ch)) out += ch;
    else if (cp <= 0xff) out += '\\x' + hex(cp, 2);
    else if (cp <= 0xffff) out += '\\u' + hex(cp, 4);
    else out += '\\U' + hex(cp, 8);
  }
  return out + quote;
}

function floatRepr(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
  if (Object.is(n, -0)) return '-0.0';
  const [mantissa, expText] = n.toExponential().split('e');
  const exp = Number(expText);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const digits = mantissa.replace('-', '').replace('.', '');
  if (exp >= -4 && exp < 16) {
    if (exp >= digits.length - 1) return sign + digits + '0'.repeat(exp - digits.length + 1) + '.0';
    if (exp >= 0) return sign + digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
    return sign + '0.' + '0'.repeat(-exp - 1) + digits;
  }
  return sign + digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') +
    String(Math.abs(exp)).padStart(2, '0');
}

/**
 * repr() of a parsed JSON value as Python prints it ({'k': [1, True, None]}). JSON numbers that are whole are
 * printed as Python ints (JSON.parse cannot tell 1 from 1.0), other numbers as Python floats.
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 1e21 ? String(value) : floatRepr(value);
  if (typeof value === 'string') return strRepr(value);
  if (Array.isArray(value)) return '[' + value.map(pyRepr).join(', ') + ']';
  if (isDict(value)) return '{' + Object.entries(value).map(([k, v]) => `${strRepr(k)}: ${pyRepr(v)}`).join(', ') + '}';
  return String(value);
}

/** Python's str() of a parsed JSON value (f'{value}'). */
export function pyStr(value: unknown): string {
  return typeof value === 'string' ? value : pyRepr(value);
}

const B64_TABLE = (() => {
  const table = new Int8Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

/**
 * Python's base64.b64decode(value, validate=True) for a str: the bytes, or null where Python raises. validate=True is
 * binascii's strict mode: only alphabet characters then '=' padding; no padding without data; exactly the padding a short
 * last quad needs (2 or 1); any number of '=' after a complete quad; a data length of 4n+1 is refused.
 */
export function pyB64Decode(value: string): Uint8Array | null {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  const pads = value.length - end;
  if (pads && !end) return null; // 'Leading padding not allowed'
  for (let i = 0; i < end; i++) {
    const code = value.charCodeAt(i);
    if (code >= 128 || B64_TABLE[code] < 0) return null; // 'Only base64 data is allowed' / 'Discontinuous padding not allowed'
  }
  const rest = end % 4;
  if (rest === 1 || (rest === 2 && pads !== 2) || (rest === 3 && pads !== 1)) return null; // 'Incorrect padding' / 'Excess data after padding'
  const out = new Uint8Array(Math.floor(end * 3 / 4));
  let o = 0;
  let i = 0;
  for (; i + 4 <= end; i += 4) {
    const n = (B64_TABLE[value.charCodeAt(i)] << 18) | (B64_TABLE[value.charCodeAt(i + 1)] << 12) |
      (B64_TABLE[value.charCodeAt(i + 2)] << 6) |
      B64_TABLE[value.charCodeAt(i + 3)];
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  if (rest >= 2) {
    const n = (B64_TABLE[value.charCodeAt(i)] << 18) | (B64_TABLE[value.charCodeAt(i + 1)] << 12) |
      (rest === 3 ? B64_TABLE[value.charCodeAt(i + 2)] << 6 : 0);
    out[o++] = n >> 16;
    if (rest === 3) out[o++] = (n >> 8) & 255;
  }
  return out;
}

/** Python truthiness of a JSON value: None, False, 0, '', [] and {} are false. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return !!value;
}

/** Python's `a or b`. */
export function pyOr<A, B>(a: A, b: B): A | B {
  return pyTruthy(a) ? a : b;
}

/** type(value).__name__ for a parsed JSON value. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  return Array.isArray(value) ? 'list' : 'dict';
}

const FLOAT_TEXT = new RegExp(
  `^[${PY_SPACE}]*([+-]?(?:(?:[0-9](?:_?[0-9])*)?\.?[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[0-9](?:_?[0-9])*\.(?:[eE][+-]?[0-9](?:_?[0-9])*)?|inf|infinity|nan))[${PY_SPACE}]*$`,
  'i',
);

/** float() of a parsed JSON value: throws ValueError / TypeError (with Python's messages) where Python raises. */
export function pyFloat(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const match = FLOAT_TEXT.exec(value);
    if (!match) throw new ValueError(`could not convert string to float: ${pyRepr(value)}`);
    const text = match[1].replaceAll('_', '').toLowerCase();
    if (text.endsWith('nan')) return NaN;
    if (text.endsWith('inf') || text.endsWith('infinity')) return text.startsWith('-') ? -Infinity : Infinity;
    return Number(text);
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${pyTypeName(value)}'`);
}

/** Python's s.split() with no argument: split on runs of Python whitespace, no empty pieces. */
export function pySplit(value: string): string[] {
  return value.split(new RegExp(`[${PY_SPACE}]+`)).filter((part) => part !== '');
}

/** Python's sorted() order for str: by code point (JS's default sort compares UTF-16 units). */
export function pyCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
