/**
 * Validation for ACP v1 form-mode elicitation schemas and responses (elicitation.py).
 *
 * Implements the flat primitive/enum subset documented by ACP's linked MCP 2026-07-28 elicitation schema: strings,
 * numbers, integers, booleans, and arrays of enum strings. Nested objects and general JSON Schema are rejected.
 * Error messages are Python's word for word (they reach the HTTP API).
 */
import { isDict, isInt, isStr, PY_SPACE, pyLen, pyRepr, pyStrip, ValueError } from '../core/py.ts';

export { ValueError };

const MAX_SCHEMA_BYTES = 65536;
const MAX_PROPERTIES = 100;
const MAX_ENUM_VALUES = 256;
const MAX_STRING_LENGTH = 100000;
const FORMATS = new Set(['email', 'uri', 'date', 'date-time']);
const ROOT_KEYS = new Set(['type', 'title', 'description', 'properties', 'required']);
const COMMON_KEYS = ['title', 'description', 'default', 'writeOnly'];

type Json = Record<string, unknown>;

function fail(message: string): never {
  throw new ValueError(message);
}

const has = (obj: Json, key: string) => Object.hasOwn(obj, key);
const get = (obj: Json, key: string): unknown => (has(obj, key) ? obj[key] : undefined);
/** dict.get(key, default): the default only when the key is missing. */
const getOr = <T>(obj: Json, key: string, fallback: T): unknown => (has(obj, key) ? obj[key] : fallback);
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** `value in {set of str}` raises TypeError for a list or dict, as Python does. */
function inSet(set: Set<string>, value: unknown): boolean {
  if (Array.isArray(value) || isDict(value)) throw new TypeError(`unhashable type: '${Array.isArray(value) ? 'list' : 'dict'}'`);
  return isStr(value) && set.has(value);
}

/** sorted() of strings: by code point, not UTF-16 unit. */
function sortedStr(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => {
    const x = Array.from(a, (c) => c.codePointAt(0)!);
    const y = Array.from(b, (c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}

const unique = (values: unknown[]) => new Set(values).size === values.length;

function mapping(value: unknown, what: string): Json {
  if (!isDict(value)) fail(`${what} must be an object`);
  return value;
}

function boundedText(value: unknown, what: string): string {
  if (!isStr(value)) fail(`${what} must be a string`);
  if (pyLen(value) > MAX_STRING_LENGTH) fail(`${what} is too long`);
  return value;
}

function uniqueStrings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((x) => !isStr(x))) fail(`${what} must be an array of strings`);
  if (value.length > MAX_ENUM_VALUES || !unique(value)) fail(`${what} is too large or contains duplicates`);
  return value as string[];
}

function enumValues(spec: Json): string[] | null {
  const hasEnum = has(spec, 'enum');
  const hasOneOf = has(spec, 'oneOf');
  if (hasEnum && hasOneOf) fail('enum and oneOf cannot be combined');
  let vals: string[];
  if (hasEnum) {
    const raw = spec.enum;
    if (!Array.isArray(raw) || !raw.length || raw.some((v) => !isStr(v))) fail('enum must be a non-empty array of strings');
    vals = raw as string[];
  } else if (hasOneOf) {
    const options = spec.oneOf;
    if (!Array.isArray(options) || !options.length) fail('oneOf must be a non-empty array');
    vals = [];
    for (const raw of options) {
      const option = mapping(raw, 'oneOf choice');
      if (Object.keys(option).some((k) => !['const', 'title', 'description'].includes(k)) || !has(option, 'const')) {
        fail('oneOf supports only {const, title, description} string choices');
      }
      if (!isStr(option.const)) fail('oneOf const choices must be strings');
      if (has(option, 'title')) boundedText(option.title, 'choice title');
      if (has(option, 'description')) boundedText(option.description, 'choice description');
      vals.push(option.const);
    }
  } else return null;
  if (vals.length > MAX_ENUM_VALUES || !unique(vals)) fail('enum is too large or contains duplicates');
  return vals;
}

function checkCommon(spec: Json): void {
  for (const key of ['title', 'description']) if (has(spec, key)) boundedText(spec[key], key);
  if (has(spec, 'writeOnly') && typeof spec.writeOnly !== 'boolean') fail('writeOnly must be boolean');
  if (get(spec, 'writeOnly') === true || get(spec, 'format') === 'password') fail('secret/password fields are unsupported in form mode');
}

function checkScalarSpec(raw: unknown): Json {
  const spec = mapping(raw, 'property schema');
  if (has(spec, '$ref')) fail('$ref is unsupported');
  checkCommon(spec);
  const typ = get(spec, 'type');
  if (!inSet(new Set(['string', 'number', 'integer', 'boolean']), typ)) {
    fail('only string, number, integer, and boolean properties are supported');
  }
  const allowed = new Set(COMMON_KEYS);
  if (typ === 'string') {
    for (const k of ['type', 'minLength', 'maxLength', 'format', 'enum', 'oneOf']) allowed.add(k);
    const choices = enumValues(spec);
    if (has(spec, 'format')) {
      if (!inSet(FORMATS, spec.format)) fail('unsupported string format');
      if (choices !== null) fail('formatted strings cannot also be enums');
    }
    for (const key of ['minLength', 'maxLength']) {
      if (has(spec, key) && (!isInt(spec[key]) || (spec[key] as number) < 0 || (spec[key] as number) > MAX_STRING_LENGTH)) {
        fail(`${key} must be a bounded non-negative integer`);
      }
    }
    if ((getOr(spec, 'minLength', 0) as number) > (getOr(spec, 'maxLength', MAX_STRING_LENGTH) as number)) {
      fail('minLength exceeds maxLength');
    }
  } else if (typ === 'number' || typ === 'integer') {
    for (const k of ['type', 'minimum', 'maximum']) allowed.add(k);
    if (has(spec, 'minimum')) finiteNumber(spec.minimum, 'minimum');
    if (has(spec, 'maximum')) finiteNumber(spec.maximum, 'maximum');
    if ((getOr(spec, 'minimum', -Infinity) as number) > (getOr(spec, 'maximum', Infinity) as number)) fail('minimum exceeds maximum');
  } else allowed.add('type');
  const unknown = Object.keys(spec).filter((k) => !allowed.has(k));
  if (unknown.length) fail('unsupported schema keyword(s): ' + sortedStr(unknown).join(', '));
  if (has(spec, 'default')) validateValue(spec, spec.default, 'default');
  return spec;
}

function finiteNumber(value: unknown, what: string): asserts value is number {
  if (!isNumber(value) || !Number.isFinite(value)) fail(`${what} must be a finite number`);
}

// ---- URLs ------------------------------------------------------------------

interface SplitResult {
  scheme: string;
  netloc: string;
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;

/** urllib.parse.urlsplit (Python 3.11.0) as far as these checks need it: scheme and netloc, with its ValueErrors. */
function urlsplit(input: string): SplitResult {
  let url = input.replace(/[\t\r\n]/g, '');
  let scheme = '';
  let netloc = '';
  const i = url.indexOf(':');
  if (i > 0 && SCHEME_CHARS.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') {
      const at = url.indexOf(c, 2);
      if (at >= 0) delim = Math.min(delim, at);
    }
    netloc = url.slice(2, delim);
    if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) fail('Invalid IPv6 URL');
  }
  checkNetloc(netloc);
  return { scheme, netloc };
}

/** Characters like U+2100 that expand to 'a/c' under NFKC would change the host after IDNA. */
function checkNetloc(netloc: string): void {
  if (!netloc || [...netloc].every((c) => c.charCodeAt(0) < 0x80)) return;
  const n = netloc.replace(/[@:#?]/g, '');
  const normalized = n.normalize('NFKC');
  if (n === normalized) return;
  for (const c of '/?#@:') {
    if (normalized.includes(c)) fail(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
}

/** SplitResult.hostname / .port: the host (or null) and whether the port is valid. */
function hostAndPort(netloc: string): { host: string | null; portOk: boolean } {
  const hostinfo = netloc.slice(netloc.lastIndexOf('@') + 1);
  let hostname: string;
  let port: string;
  const open = hostinfo.indexOf('[');
  if (open >= 0) {
    const bracketed = hostinfo.slice(open + 1);
    const close = bracketed.indexOf(']');
    hostname = close >= 0 ? bracketed.slice(0, close) : bracketed;
    const rest = close >= 0 ? bracketed.slice(close + 1) : '';
    const colon = rest.indexOf(':');
    port = colon >= 0 ? rest.slice(colon + 1) : '';
  } else {
    const colon = hostinfo.indexOf(':');
    hostname = colon >= 0 ? hostinfo.slice(0, colon) : hostinfo;
    port = colon >= 0 ? hostinfo.slice(colon + 1) : '';
  }
  if (!port) return { host: hostname || null, portOk: true };
  const value = pyInt(port);
  return { host: hostname || null, portOk: value !== null && value >= 0 && value <= 65535 };
}

const PY_INT = new RegExp(`^[${PY_SPACE}]*[+-]?\\p{Nd}(?:_?\\p{Nd})*[${PY_SPACE}]*$`, 'u');

/** int(text, 10) in Python (spaces, sign, underscores and any Unicode decimal digits), or null where Python raises. */
function pyInt(text: string): number | null {
  if (!PY_INT.test(text)) return null;
  const body = pyStrip(text);
  let value = 0;
  for (const ch of body.replace(/^[+-]/, '').replaceAll('_', '')) {
    // Unicode decimal digits come in runs that start at a zero and repeat 0-9.
    const code = ch.codePointAt(0)!;
    let first = code;
    while (/\p{Nd}/u.test(String.fromCodePoint(first - 1))) first--;
    value = value * 10 + ((code - first) % 10);
  }
  return body.startsWith('-') ? -value : value;
}

/** Validate a URL-mode elicitation destination: absolute http(s), no credentials. */
export function validateUrl(url: unknown): string {
  if (!isStr(url) || !url || pyLen(url) > 2048) fail('url must be a non-empty string of at most 2048 characters');
  for (const ch of url) {
    const code = ch.codePointAt(0)!;
    if (code <= 32 || code === 127) fail('url cannot contain spaces or control characters');
  }
  let parts: SplitResult;
  let host: string | null;
  try {
    parts = urlsplit(url);
    const info = hostAndPort(parts.netloc);
    if (!info.portOk) throw new ValueError('port');
    host = info.host;
  } catch {
    fail('url is malformed');
  }
  if (parts.scheme !== 'http' && parts.scheme !== 'https') fail('only http and https URLs can be opened');
  if (!host) fail('url must include a host name');
  if (parts.netloc.includes('@')) fail('urls containing credentials are not allowed');
  return url;
}

/** Validate URL-mode elicitation params; returns the validated URL. */
export function validateUrlRequest(raw: unknown): string {
  const params = mapping(raw, 'params');
  if (has(params, 'requestedSchema')) fail('url-mode requests cannot include requestedSchema');
  const eid = get(params, 'elicitationId');
  if (!isStr(eid) || pyLen(eid) < 1 || pyLen(eid) > 256) fail('url-mode requests require an elicitationId string');
  return validateUrl(get(params, 'url'));
}

// ---- schema ----------------------------------------------------------------

/** Validate an ACP form requestedSchema, throwing ValueError if unsupported. */
export function validateSchema(raw: unknown): null {
  const schema = mapping(raw, 'schema');
  let size: number;
  try {
    size = new TextEncoder().encode(pyRepr(schema)).length;
  } catch {
    fail('schema is malformed or too deeply nested');
  }
  if (size > MAX_SCHEMA_BYTES) fail('schema exceeds size limit');
  if (has(schema, '$ref')) fail('$ref is unsupported');
  if (get(schema, 'type') !== 'object') fail('form schema must have type object');
  if (Object.keys(schema).some((k) => !ROOT_KEYS.has(k))) fail('unsupported root schema keyword(s)');
  if (has(schema, 'title')) boundedText(schema.title, 'title');
  if (has(schema, 'description')) boundedText(schema.description, 'description');
  const props = mapping(get(schema, 'properties'), 'properties');
  if (Object.keys(props).length > MAX_PROPERTIES) fail('too many properties');
  for (const [key, spec] of Object.entries(props)) {
    boundedText(key, 'property name');
    if (!key) fail('property names cannot be empty');
    if (!isDict(spec)) fail('property schema must be an object');
    if (get(spec, 'type') === 'array') {
      const allowed = new Set([...COMMON_KEYS, 'type', 'items', 'minItems', 'maxItems']);
      checkCommon(spec);
      if (Object.keys(spec).some((k) => !allowed.has(k))) fail('unsupported array schema keyword(s)');
      const item = mapping(get(spec, 'items'), 'array items');
      if (getOr(item, 'type', has(item, 'anyOf') ? 'string' : null) !== 'string') fail('only arrays of enum strings are supported');
      if (Object.keys(item).some((k) => !['type', 'enum', 'anyOf'].includes(k))) fail('unsupported enum item schema keyword(s)');
      let vals: string[];
      if (has(item, 'enum')) vals = enumValues({ enum: item.enum })!;
      else if (has(item, 'anyOf')) vals = enumValues({ oneOf: item.anyOf })!;
      else fail('array items must define enum or named anyOf choices');
      for (const k of ['minItems', 'maxItems']) {
        if (has(spec, k) && (!isInt(spec[k]) || (spec[k] as number) < 0 || (spec[k] as number) > MAX_ENUM_VALUES)) {
          fail(`${k} must be a bounded non-negative integer`);
        }
      }
      if ((getOr(spec, 'minItems', 0) as number) > (getOr(spec, 'maxItems', MAX_ENUM_VALUES) as number)) fail('minItems exceeds maxItems');
      if (has(spec, 'default')) validateArray(spec, vals, spec.default, 'default');
    } else checkScalarSpec(spec);
  }
  const required = uniqueStrings(getOr(schema, 'required', []), 'required');
  if (required.some((name) => !has(props, name))) fail('required names must exist in properties');
  return null;
}

// ---- values ----------------------------------------------------------------

const EMAIL = new RegExp(`^[^${PY_SPACE}@<>]+@[^${PY_SPACE}@<>]+\\.[^${PY_SPACE}@<>]+$`, 'u');

function formatValid(fmt: unknown, value: string): boolean {
  if (fmt === 'email') return pyLen(value) <= 254 && EMAIL.test(value);
  if (fmt === 'uri') {
    try {
      const p = urlsplit(value);
      return Boolean(p.scheme) && (['http', 'https', 'ftp'].includes(p.scheme) ? Boolean(p.netloc) : true);
    } catch {
      return false;
    }
  }
  if (fmt === 'date') return isoDate(value);
  if (fmt === 'date-time') {
    if (!isoDateTime(value.replaceAll('Z', '+00:00'))) return false;
    const tail = Array.from(value).slice(10).join('');
    return value.includes('T') && (value.includes('Z') || tail.includes('+') || tail.includes('-'));
  }
  return true;
}

function validateArray(spec: Json, choices: string[], value: unknown, label: string): void {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length < (getOr(spec, 'minItems', 0) as number) || value.length > (getOr(spec, 'maxItems', MAX_ENUM_VALUES) as number)) {
    fail(`${label} violates array item count constraints`);
  }
  if (value.some((item) => !isStr(item) || !choices.includes(item))) fail(`${label} contains a value outside the allowed choices`);
  if (!unique(value)) fail(`${label} cannot contain duplicate choices`);
}

function validateValue(spec: Json, value: unknown, label: string): void {
  const typ = spec.type;
  if (typ === 'string') {
    if (!isStr(value)) fail(`${label} must be a string`);
    const length = pyLen(value);
    if (length < (getOr(spec, 'minLength', 0) as number) || length > (getOr(spec, 'maxLength', MAX_STRING_LENGTH) as number)) {
      fail(`${label} violates string length constraints`);
    }
    const choices = enumValues(spec);
    if (choices !== null && !choices.includes(value)) fail(`${label} is not an allowed choice`);
    if (has(spec, 'format') && !formatValid(spec.format, value)) fail(`${label} is not a valid ${spec.format}`);
  } else if (typ === 'number' || typ === 'integer') {
    finiteNumber(value, label);
    if (typ === 'integer' && !Number.isInteger(value)) fail(`${label} must be an integer`);
    if (value < (getOr(spec, 'minimum', -Infinity) as number) || value > (getOr(spec, 'maximum', Infinity) as number)) {
      fail(`${label} is outside its allowed range`);
    }
  } else if (typ === 'boolean') {
    if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  } else fail('unsupported value type');
}

/** Return a shallow copy of validated form content or throw ValueError. */
export function validateContent(schema: unknown, raw: unknown): Json {
  validateSchema(schema);
  const content = mapping(raw, 'content');
  const props = (schema as Json).properties as Record<string, Json>;
  const unknown = Object.keys(content).filter((k) => !has(props, k));
  if (unknown.length) fail('unknown content field(s): ' + sortedStr(unknown).join(', '));
  const missing = new Set((getOr(schema as Json, 'required', []) as string[]).filter((k) => !has(content, k)));
  if (missing.size) fail('missing required field(s): ' + sortedStr(missing).join(', '));
  const result: Json = { ...content };
  for (const [name, value] of Object.entries(result)) {
    const spec = props[name];
    if (spec.type === 'array') {
      const item = spec.items as Json;
      let choices = get(item, 'enum') as string[] | null | undefined;
      if (choices === undefined || choices === null) choices = (item.anyOf as Json[]).map((x) => x.const as string);
      validateArray(spec, choices, value, name);
    } else validateValue(spec, value, name);
  }
  return result;
}

// ---- ISO dates: CPython 3.11's C date/datetime.fromisoformat, byte for byte ----

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysIn = (y: number, m: number) => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m]);

function ymdToOrd(y: number, m: number, d: number): number {
  const p = y - 1;
  let days = p * 365 + Math.floor(p / 4) - Math.floor(p / 100) + Math.floor(p / 400);
  for (let i = 1; i < m; i++) days += daysIn(y, i);
  return days + d;
}

function ordToYmd(ordinal: number): [number, number, number] {
  const date = new Date(Date.UTC(2000, 0, 1) + (ordinal - ymdToOrd(2000, 1, 1)) * 86400000);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

/** The ISO-8601 parser works on the UTF-8 bytes; reading past the end gives 0 like C's terminating NUL. */
class Bytes {
  readonly data: Uint8Array;
  constructor(text: string) {
    this.data = new TextEncoder().encode(text);
  }
  get length() {
    return this.data.length;
  }
  at(i: number): number {
    return i < this.data.length ? this.data[i] : 0;
  }
  isDigit(i: number): boolean {
    const c = this.at(i);
    return c >= 0x30 && c <= 0x39;
  }
  /** parse_digits: n ASCII digits from pos, or null. */
  digits(pos: number, n: number): [number, number] | null {
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (!this.isDigit(pos + i)) return null;
      value = value * 10 + this.at(pos + i) - 0x30;
    }
    return [value, pos + n];
  }
}

const DASH = 0x2d;
const W = 0x57;

/** parse_isoformat_date: [year, month, day] (unchecked) or null. */
function parseDate(b: Bytes, start: number, len: number): [number, number, number] | null {
  const year = b.digits(start, 4);
  if (!year) return null;
  let p = year[1];
  const sep = b.at(p) === DASH;
  if (sep) p++;
  if (b.at(p) === W) {
    const week = b.digits(p + 1, 2);
    if (!week) return null;
    p = week[1];
    let day = 1;
    if (p - start < len) {
      if (sep && b.at(p++) !== DASH) return null;
      const d = b.digits(p, 1);
      if (!d) return null;
      day = d[0];
    }
    return isoToYmd(year[0], week[0], day);
  }
  const month = b.digits(p, 2);
  if (!month) return null;
  p = month[1];
  if (sep && b.at(p++) !== DASH) return null;
  const day = b.digits(p, 2);
  return day ? [year[0], month[0], day[0]] : null;
}

function isoToYmd(year: number, week: number, day: number): [number, number, number] | null {
  if (year < 1) return null;
  if (week <= 0 || week >= 53) {
    const first = (ymdToOrd(year, 1, 1) + 6) % 7;
    if (!(week === 53 && (first === 3 || (first === 2 && isLeap(year))))) return null;
  }
  if (day <= 0 || day >= 8) return null;
  const firstDay = ymdToOrd(year, 1, 1);
  const firstWeekday = (firstDay + 6) % 7;
  let monday = firstDay - firstWeekday;
  if (firstWeekday > 3) monday += 7;
  return ordToYmd(monday + (week - 1) * 7 + day - 1);
}

const validDate = ([y, m, d]: [number, number, number]) => y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);

/** date.fromisoformat(value) succeeds. */
function isoDate(value: string): boolean {
  if (!value.isWellFormed()) return false;
  const b = new Bytes(value);
  if (![7, 8, 10].includes(b.length)) return false;
  const date = parseDate(b, 0, b.length);
  return date !== null && validDate(date);
}

function separatorLocation(b: Bytes): number {
  const len = b.length;
  if (len === 7) return 7;
  if (b.at(4) === DASH) {
    if (b.at(5) === W) {
      if (len < 8) return -1;
      if (len > 8 && b.at(8) === DASH) {
        if (len === 9) return -1;
        return len > 10 && b.isDigit(10) ? 8 : 10;
      }
      return 8;
    }
    return 10;
  }
  if (b.at(4) === W) {
    let idx = 7;
    while (idx < len && b.isDigit(idx)) idx++;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

/** parse_hh_mm_ss_ff: {rv, values} where rv < 0 is an error and 1 means "not at the end of the string". */
function parseTime(b: Bytes, start: number, end: number): { rv: number; vals: number[] } {
  const vals = [0, 0, 0, 0];
  let p = start;
  let hasSep = true;
  for (let i = 0; i < 3; i++) {
    const got = b.digits(p, 2);
    if (!got) return { rv: -3, vals };
    vals[i] = got[0];
    p = got[1];
    const c = b.at(p++);
    if (i === 0) hasSep = c === 0x3a;
    if (p >= end) return { rv: c !== 0 ? 1 : 0, vals };
    else if (hasSep && c === 0x3a) continue;
    else if (c === 0x2e || c === 0x2c) break;
    else if (!hasSep) p--;
    else return { rv: -4, vals };
  }
  const toParse = Math.min(end - p, 6);
  const frac = b.digits(p, toParse);
  if (!frac) return { rv: -3, vals };
  vals[3] = frac[0] * 10 ** (6 - toParse);
  p = frac[1];
  while (b.isDigit(p)) p++;
  return { rv: b.at(p) !== 0 ? 1 : 0, vals };
}

/** datetime.fromisoformat(value) succeeds. */
function isoDateTime(input: string): boolean {
  const points = Array.from(input);
  if (points.length < 7) return false;
  // CPython allows a lone surrogate only as the separator (positions 7, 8 or 10) and treats it as 'T'.
  for (const pos of [7, 8, 10]) {
    if (pos > points.length) break;
    if (pos < points.length && /^[\ud800-\udfff]$/.test(points[pos])) {
      points[pos] = 'T';
      break;
    }
  }
  const value = points.join('');
  if (!value.isWellFormed()) return false;
  const b = new Bytes(value);
  const len = b.length;
  const sepAt = separatorLocation(b);
  if (sepAt < 0) return false;
  const date = parseDate(b, 0, sepAt);
  if (!date || !validDate(date)) return false;
  if (len <= sepAt) return true;
  const start = sepAt + 1;
  const end = len;
  let tz = start;
  do {
    const c = b.at(tz);
    if (c === 0x5a || c === 0x2b || c === DASH) break;
  } while (++tz < end);
  const time = parseTime(b, start, tz);
  if (time.rv < 0) return false;
  const [hh, mm, ss, us] = time.vals;
  if (hh > 23 || mm > 59 || ss > 59 || us > 999999) return false;
  if (tz === end) return time.rv !== 1;
  if (b.at(tz) === 0x5a) return b.at(tz + 1) === 0;
  const offset = parseTime(b, tz + 1, end);
  if (offset.rv !== 0) return false;
  const [th, tm, ts, tus] = offset.vals;
  const seconds = th * 3600 + tm * 60 + ts;
  return seconds === 0 || seconds * 1e6 + tus < 86400e6;
}
