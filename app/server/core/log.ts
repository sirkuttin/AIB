/**
 * Logging for the Agent Studio programs (log_setup.py).
 *
 * Library modules only do `const log = getLogger('module_name')`; nothing is configured at import, so tests and anyone importing a
 * module stay quiet. A program calls setup() once from main():
 *
 *   setup('studio', { level: options.logLevel, stateDir: options.stateDir, filename: 'studio.log' });
 *
 * Output goes to stderr and, when a file name is given, to a rotating file in the state folder (studio.log, 5 MB, 2 old files kept:
 * studio.log.1, studio.log.2), the same files the Python server writes. Line format, as Python's '%(asctime)s %(levelname)s
 * %(name)s: %(message)s':  2026-11-10 14:03:07,412 WARNING artifacts: something odd
 *
 * Where it differs from log_setup.py:
 * - An exception is followed by the JavaScript stack (error.stack) instead of a Python traceback.
 * - Before setup() nothing is printed at all (Python's "last resort" handler would print bare WARNING+ messages of modules without
 *   a NullHandler to stderr).
 * - One level for every logger (the root's); Python loggers could have their own (none of the programs set one).
 * - The rotation check counts bytes for both the file and the new line (Python: file bytes + line characters).
 *
 * Secrets never reach a log line: values registered with registerSecret() (page token, host token, artifact keys, custom agent env
 * values) and anything that looks like `token=...`, `X-Studio-Token: ...`, `Authorization: Bearer ...` or a 64-hex key are
 * blanked in the message and in the stack (same patterns as Python; a parity test keeps redact() equal).
 */
import { PY_SPACE, pyLen, pyRepr } from './py.ts';
import { join } from '../platform/path.ts';

export const ENV_LEVEL = 'AGENT_STUDIO_LOG_LEVEL';
export const DEFAULT_LEVEL = 'WARNING';
export const FORMAT = '%(asctime)s %(levelname)s %(name)s: %(message)s';
export const FILE_MAX_BYTES = 5 * 1024 * 1024;
export const FILE_KEEP = 2;
export const REDACTED = '[redacted]';
export const LEVEL_HELP = `Logging level: DEBUG, INFO, WARNING, ERROR (default WARNING; env ${ENV_LEVEL})`;

export const DEBUG = 10;
export const INFO = 20;
export const WARNING = 30;
export const ERROR = 40;
export const CRITICAL = 50;

/** logging's name table (getLevelName). */
const NAME_TO_LEVEL: Record<string, number> = {
  CRITICAL: 50,
  FATAL: 50,
  ERROR: 40,
  WARN: 30,
  WARNING: 30,
  INFO: 20,
  DEBUG: 10,
  NOTSET: 0,
};
const LEVEL_TO_NAME: Record<number, string> = { 50: 'CRITICAL', 40: 'ERROR', 30: 'WARNING', 20: 'INFO', 10: 'DEBUG', 0: 'NOTSET' };

// ---- redaction ---------------------------------------------------------------------------------
const secrets = new Set<string>();

// Python's re with str patterns: \w is Unicode letters, digits and '_'; \b is the edge between \w and not-\w; \s is Python whitespace.
const W = '[\\p{L}\\p{N}_]';
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const S = `[${PY_SPACE}]`;
const PATTERNS: [RegExp, string][] = [
  // header or field named like a secret: keep the name, drop the value
  [
    new RegExp(
      `(${B}(?:${W}|-)*(?:token|secret|password|passwd|api[-_]?key|artifact[-_]?key|authorization)(?:${W}|-)*["']?${S}*[:=]${S}*["']?)` +
        `(?:bearer${S}+)?[^${PY_SPACE}"',;}&]+`,
      'giu',
    ),
    '$1' + REDACTED,
  ],
  [new RegExp(`${B}bearer${S}+[A-Za-z0-9._~+/=-]{8,}`, 'giu'), 'Bearer ' + REDACTED],
  [new RegExp(`${B}[0-9a-fA-F]{64}${B}`, 'gu'), REDACTED], // an artifact key (HMAC-SHA256 hex)
];

/** Remember a secret value so it is blanked wherever it appears in a log line. Short values are ignored (they would mangle text). */
export function registerSecret(value: unknown): void {
  if (typeof value === 'string' && pyLen(value) >= 8) secrets.add(value);
}

export function forgetSecrets(): void {
  secrets.clear();
}

export function redact<T>(text: T): T {
  if (typeof text !== 'string' || !text) return text;
  let out: string = text;
  for (const value of [...secrets].sort((a, b) => pyLen(b) - pyLen(a))) {
    if (out.includes(value)) out = out.replaceAll(value, REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out as T;
}

// ---- levels ------------------------------------------------------------------------------------
/** 'debug', 'INFO', 10 ... -> a level number; anything unknown falls back to `fallback` (parse_level). */
export function parseLevel(value: unknown, fallback = DEFAULT_LEVEL): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const name = String(value ?? '').trim().toUpperCase();
  if (/^[0-9]+$/.test(name)) return Number(name);
  return NAME_TO_LEVEL[name] ?? NAME_TO_LEVEL[fallback] ?? WARNING;
}

/** logging.getLevelName(number). */
export function levelName(level: number): string {
  return LEVEL_TO_NAME[level] ?? `Level ${level}`;
}

/** The --log-level default: AGENT_STUDIO_LOG_LEVEL, else WARNING (add_arguments). */
export function defaultLevel(): string {
  return Deno.env.get(ENV_LEVEL) || DEFAULT_LEVEL;
}

// ---- records and handlers ----------------------------------------------------------------------
export interface Handler {
  emit(line: string): void;
  close(): void;
}

const root = { level: WARNING, handlers: [] as Handler[], ours: new Set<Handler>() };

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Python's default asctime: local time 'YYYY-MM-DD HH:MM:SS,mmm'. */
export function asctime(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())},${pad(date.getMilliseconds(), 3)}`;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object') return pyRepr(value);
  return String(value);
}

/** msg % args for the conversions the code uses (%s %r %d %i %f %%); with no args the message is left as it is (as Python). */
export function formatMessage(message: string, args: unknown[]): string {
  if (!args.length) return message;
  let index = 0;
  return message.replace(/%([srdif%])/g, (whole, kind: string) => {
    if (kind === '%') return '%';
    if (index >= args.length) return whole;
    const value = args[index++];
    if (kind === 'r') return pyRepr(value);
    if (kind === 'd' || kind === 'i') return String(Math.trunc(Number(value)));
    if (kind === 'f') return Number(value).toFixed(6);
    return asText(value);
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}

/** One formatted, redacted line (plus the stack for an exception). Never throws (RedactFilter's fallback: drop the detail). */
export function formatRecord(name: string, level: number, message: string, args: unknown[], error?: unknown, now = new Date()): string {
  const head = `${asctime(now)} ${levelName(level)} ${name}: `;
  try {
    let line = head + redact(formatMessage(message, args));
    if (error !== undefined) line += '\n' + redact(errorText(error));
    return line;
  } catch {
    return head + REDACTED;
  }
}

function dispatch(name: string, level: number, message: string, args: unknown[], error?: unknown): void {
  if (level < root.level || !root.handlers.length) return;
  const line = formatRecord(name, level, message, args, error);
  for (const handler of root.handlers) {
    try {
      handler.emit(line);
    } catch { /* logging must never raise into the caller */ }
  }
}

/**
 * An INFO line written whatever the level (the program's startup line), so every studio.log shows each start even at the default
 * WARNING level. Not in log_setup.py; use it for one-off lines only.
 */
export function announce(name: string, message: string, ...args: unknown[]): void {
  if (!root.handlers.length) return;
  const line = formatRecord(name, INFO, message, args);
  for (const handler of root.handlers) {
    try {
      handler.emit(line);
    } catch { /* logging must never raise into the caller */ }
  }
}

export class Logger {
  constructor(readonly name: string) {}
  isEnabledFor(level: number): boolean {
    return level >= root.level;
  }
  debug(message: string, ...args: unknown[]): void {
    dispatch(this.name, DEBUG, message, args);
  }
  info(message: string, ...args: unknown[]): void {
    dispatch(this.name, INFO, message, args);
  }
  warning(message: string, ...args: unknown[]): void {
    dispatch(this.name, WARNING, message, args);
  }
  error(message: string, ...args: unknown[]): void {
    dispatch(this.name, ERROR, message, args);
  }
  critical(message: string, ...args: unknown[]): void {
    dispatch(this.name, CRITICAL, message, args);
  }
  /** log.exception(): ERROR with the error's stack after the message (Python: the current traceback). */
  exception(error: unknown, message: string, ...args: unknown[]): void {
    dispatch(this.name, ERROR, message, args, error);
  }
}

const loggers = new Map<string, Logger>();

export function getLogger(name: string): Logger {
  let logger = loggers.get(name);
  if (!logger) loggers.set(name, logger = new Logger(name));
  return logger;
}

/** The current root level and handlers (tests). */
export function rootState(): { level: number; handlers: readonly Handler[] } {
  return { level: root.level, handlers: [...root.handlers] };
}

export function addHandler(handler: Handler): void {
  root.handlers.push(handler);
}

export function removeHandler(handler: Handler): void {
  root.handlers = root.handlers.filter((h) => h !== handler);
}

export function setLevel(level: number): void {
  root.level = level;
}

const encoder = new TextEncoder();

export class StderrHandler implements Handler {
  emit(line: string): void {
    Deno.stderr.writeSync(encoder.encode(line + '\n'));
  }
  close(): void {}
}

/** Python writes its log files in text mode: '\r\n' line ends on Windows. Kept so both servers' lines look the same in one file. */
const EOL = Deno.build.os === 'windows' ? '\r\n' : '\n';

/** logging.handlers.RotatingFileHandler(path, maxBytes, backupCount, encoding='utf-8'): opened at once, appends. */
export class RotatingFileHandler implements Handler {
  #file: Deno.FsFile | null;
  #size: number;
  constructor(readonly path: string, readonly maxBytes = FILE_MAX_BYTES, readonly backupCount = FILE_KEEP) {
    this.#file = Deno.openSync(path, { append: true, create: true });
    this.#size = this.#file.statSync().size;
  }

  emit(line: string): void {
    const data = encoder.encode(line + EOL);
    if (this.maxBytes > 0 && this.#size > 0 && this.#size + data.length >= this.maxBytes) this.#rollover();
    if (this.#file === null) this.#open();
    const file = this.#file!;
    let written = 0;
    while (written < data.length) written += file.writeSync(data.subarray(written));
    this.#size += data.length;
  }

  #open(): void {
    this.#file = Deno.openSync(this.path, { append: true, create: true });
    this.#size = this.#file.statSync().size;
  }

  #rollover(): void {
    this.#file?.close();
    this.#file = null;
    const exists = (p: string) => {
      try {
        Deno.statSync(p);
        return true;
      } catch {
        return false;
      }
    };
    try {
      if (this.backupCount > 0) {
        for (let i = this.backupCount - 1; i > 0; i--) {
          const source = `${this.path}.${i}`;
          const target = `${this.path}.${i + 1}`;
          if (exists(source)) {
            if (exists(target)) Deno.removeSync(target);
            Deno.renameSync(source, target);
          }
        }
        const first = `${this.path}.1`;
        if (exists(first)) Deno.removeSync(first);
        if (exists(this.path)) Deno.renameSync(this.path, first);
      }
    } catch { /* another process holds a file (Windows): keep appending to the current one */ }
    this.#open();
  }

  close(): void {
    this.#file?.close();
    this.#file = null;
  }
}

export interface SetupOptions {
  level?: unknown;
  stateDir?: string | null;
  filename?: string | null;
  stream?: boolean;
}

/**
 * Configure logging for a program. Safe to call again: handlers from an earlier call are replaced.
 * Returns the file path when a file handler was attached, else null.
 */
export function setup(program: string, options: SetupOptions = {}): string | null {
  for (const handler of [...root.ours]) {
    removeHandler(handler);
    try {
      handler.close();
    } catch { /* already closed */ }
  }
  root.ours.clear();
  const number = parseLevel(options.level ?? Deno.env.get(ENV_LEVEL));
  root.level = number;
  const handlers: Handler[] = [];
  let path: string | null = null;
  if (options.stream ?? true) handlers.push(new StderrHandler());
  if (options.filename && options.stateDir) {
    try {
      Deno.mkdirSync(options.stateDir, { recursive: true });
      path = join(options.stateDir, options.filename);
      handlers.push(new RotatingFileHandler(path, FILE_MAX_BYTES, FILE_KEEP));
    } catch (error) { // an unwritable state folder must not stop the program; stderr still works
      path = null;
      console.error(`${program}: could not open the log file in ${options.stateDir}: ${(error as Error)?.message ?? error}`);
    }
  }
  for (const handler of handlers) {
    root.ours.add(handler);
    addHandler(handler);
  }
  getLogger('log_setup').info('%s logging at %s%s', program, levelName(number), path ? `, file ${path}` : '');
  return path;
}
