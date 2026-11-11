/**
 * The agent registry (agent_registry.py): built-in agents (OMP, Claude Code, Codex) plus ACP agents the user added in Settings.
 *
 * Pure helpers, no I/O beyond looking a command up on disk / PATH. A user agent is {id, name, command, args, env, enabled}:
 *   id       "custom-<slug>", made once from the name and never changed (conversations are stored under it)
 *   command  an existing executable file path, or a bare name found on PATH; never run through a shell
 *   args     list of strings (one per line in the form)
 *   env      list of {name, value}; names match [A-Za-z_][A-Za-z0-9_]*. Values are stored as plain text in the state folder and
 *            are never sent to the page (hiddenEnv); an edit that leaves a value out keeps the stored one.
 * Error messages are Python's exactly: they reach the HTTP API.
 */
import { clip, isDict, isStr, pyLen, pySplit, pyStr, pyStrip, ValueError } from '../core/py.ts';
import { executable, expandUser, isAbsolute, isFile, resolvePath, which } from '../platform/pypath.ts';
import { BETA_IDS, BETA_NAMES, isBeta } from './beta_catalog.ts';

export const BUILTIN_IDS = ['omp', 'claude', 'codex'] as const;
export const BUILTIN_NAMES: Record<string, string> = { omp: 'OMP', claude: 'Claude Code', codex: 'Codex' };
/** The Beta agents (beta_catalog.ts): known to AIB like the built-ins, off until turned on. */
export { BETA_IDS, BETA_NAMES, isBeta };

/** The name people know an agent id by (built-in or Beta), else the id itself. */
export function agentName(id: string): string {
  return BUILTIN_NAMES[id] ?? BETA_NAMES[id] ?? id;
}
export const CUSTOM_PREFIX = 'custom-';
/** re.match(r'^custom-[a-z0-9]+(?:-[a-z0-9]+)*$'): Python's '$' also matches before one final newline. */
export const ID_RE = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*\n?$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*\n?$/;
export const MAX_AGENTS = 20;
export const MAX_NAME = 40;
export const MAX_COMMAND = 1024;
export const MAX_ARGS = 50;
export const MAX_ARG = 2000;
export const MAX_ENV = 50;
export const MAX_ENV_VALUE = 4000;

export interface EnvVar {
  name: string;
  value: string;
}

export interface CustomAgent {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: EnvVar[];
  enabled: boolean;
}

export function isBuiltin(value: unknown): boolean {
  return isStr(value) && (BUILTIN_IDS as readonly string[]).includes(value);
}

/** A provider id Studio can store and launch: a built-in or a well-formed user-agent id. */
export function isProvider(value: unknown): value is string {
  return isStr(value) && (isBuiltin(value) || isBeta(value) || (pyLen(value) <= 48 && ID_RE.test(value)));
}

export function isCustom(value: unknown): value is string {
  return isStr(value) && pyLen(value) <= 48 && ID_RE.test(value);
}

/** One-line text: control characters become spaces, runs of spaces collapse. */
function lineText(value: unknown, limit: number): string {
  if (!isStr(value)) return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    out += code >= 32 && code !== 127 ? ch : ' ';
  }
  return clip(pySplit(out).join(' '), limit);
}

export function slug(name: unknown): string {
  const text = pyStrip(lineText(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-'), '-');
  return pyStrip(clip(text, 30), '-') || 'agent';
}

/** custom-<slug>, with -2, -3 ... when the slug is already used. */
export function makeId(name: unknown, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = CUSTOM_PREFIX + slug(name);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

function hasControl(text: string, below = 32): boolean {
  for (const ch of text) if (ch.codePointAt(0)! < below) return true;
  return false;
}

/** text[1] == ':' with Python's code point indexing. */
function secondIsColon(text: string): boolean {
  const chars = [...text];
  return chars.length > 1 && chars[1] === ':';
}

/** The absolute path of an existing executable file, or a bare name found on PATH. Throws ValueError otherwise. */
export function checkCommand(command: unknown): string {
  if (!isStr(command)) throw new ValueError('Command must be text');
  let text = pyStrip(command);
  if (text.length >= 2 && text[0] === text[text.length - 1] && (text[0] === '"' || text[0] === "'")) text = pyStrip(text.slice(1, -1));
  if (!text || pyLen(text) > MAX_COMMAND || hasControl(text)) {
    throw new ValueError('Enter the command to start the agent (a file path, or a program name on PATH)');
  }
  if (text.includes('/') || text.includes('\\') || secondIsColon(text)) {
    const path = expandUser(text);
    if (!isAbsolute(path)) throw new ValueError('Use a full path to the program, or just its name if it is on PATH');
    if (!isFile(path)) throw new ValueError(`No file at ${text}`);
    if (Deno.build.os !== 'windows' && !executable(path)) throw new ValueError(`${text} is not executable`);
    return resolvePath(path);
  }
  const found = which(text);
  if (!found) throw new ValueError(`"${text}" was not found on PATH`);
  return resolvePath(found);
}

/** [resolved path or '', problem text or ''] without throwing; for the Agents list. */
export function commandStatus(command: unknown): [string, string] {
  try {
    return [checkCommand(command), ''];
  } catch (error) {
    if (error instanceof ValueError) return ['', error.message];
    throw error;
  }
}

/** A list of strings, or the text of the form field (one argument per line; blank lines dropped). */
export function cleanArgs(value: unknown): string[] {
  const items = isStr(value) ? value.split('\n') : value;
  if (!Array.isArray(items)) throw new ValueError('Arguments must be a list');
  const out: string[] = [];
  for (const raw of items) {
    if (!isStr(raw)) throw new ValueError('Each argument must be text');
    const item = raw.replace(/\r+$/, '');
    if (!pyStrip(item)) continue;
    if (pyLen(item) > MAX_ARG || item.includes('\x00') || item.includes('\n')) {
      throw new ValueError('An argument is too long or contains a control character');
    }
    out.push(item);
  }
  if (out.length > MAX_ARGS) throw new ValueError(`At most ${MAX_ARGS} arguments`);
  return out;
}

/** NAME=value lines -> [{name, value}]. Blank lines and lines starting with # are ignored. */
export function parseEnvText(text: unknown): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of pyStr(text || '').split('\n')) {
    const line = raw.replace(/\r+$/, '');
    if (!pyStrip(line) || pyStrip(line).startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 0) throw new ValueError(`Environment line "${clip(line, 40)}" needs the form NAME=value`);
    out.push({ name: pyStrip(line.slice(0, index)), value: line.slice(index + 1) });
  }
  return out;
}

export function cleanEnv(value: unknown): EnvVar[] {
  const items = isStr(value) ? parseEnvText(value) : value;
  if (!Array.isArray(items)) throw new ValueError('Environment variables must be a list');
  const out: EnvVar[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isDict(item) || !isStr(item.name) || !isStr('value' in item ? item.value : '')) {
      throw new ValueError('Each environment variable needs a name and a value');
    }
    const name = pyStrip(item.name);
    const val = ('value' in item ? item.value : '') as string;
    if (!ENV_NAME_RE.test(name) || pyLen(name) > 128) {
      throw new ValueError(`"${clip(name, 40)}" is not a valid variable name (letters, digits and _; not starting with a digit)`);
    }
    if (pyLen(val) > MAX_ENV_VALUE || val.includes('\x00') || val.includes('\n')) {
      throw new ValueError(`The value of ${name} is too long or contains a control character`);
    }
    if (seen.has(name.toUpperCase())) throw new ValueError(`${name} is listed twice`);
    seen.add(name.toUpperCase());
    out.push({ name, value: val });
  }
  if (out.length > MAX_ENV) throw new ValueError(`At most ${MAX_ENV} environment variables`);
  return out;
}

/** What the page may see of an agent's environment: names only, {name, set: true}. Values never leave the state folder. */
export function hiddenEnv(env: unknown): { name: string; set: true }[] {
  return (Array.isArray(env) ? env : []).filter((e) => isDict(e) && isStr(e.name)).map((e) => ({ name: e.name as string, set: true }));
}

/**
 * An edit may leave a value out (or send null): that variable keeps the value already stored under the same name (an empty
 * value when it is new). Items that carry a value replace it. Text-form env (NAME=value lines) is left alone.
 */
export function keepStoredValues(items: unknown, stored: unknown): unknown {
  if (!Array.isArray(items)) return items;
  const old = new Map<string, unknown>();
  for (const e of Array.isArray(stored) ? stored : []) {
    if (isDict(e) && isStr(e.name)) old.set(e.name, 'value' in e ? e.value : '');
  }
  return items.map((item) => {
    if (isDict(item) && (item.value === null || item.value === undefined)) {
      const name = item.name;
      return { name, value: isStr(name) ? (old.get(pyStrip(name)) ?? '') : '' };
    }
    return item;
  });
}

/**
 * Validate one user agent from the form / a patch. existing: the stored agent being edited (keeps its id).
 * check=false skips the "command exists" test (used when loading the file: an agent may be temporarily missing).
 */
export function cleanAgent(
  raw: unknown,
  takenIds: Iterable<string> = [],
  existing: Record<string, unknown> | null = null,
  check = true,
): CustomAgent {
  if (!isDict(raw)) throw new ValueError('Invalid agent');
  const name = lineText(raw.name, MAX_NAME);
  if (!name) throw new ValueError('Give the agent a name');
  let command = raw.command;
  if (check) {
    command = checkCommand(command);
    // keep what the user typed when it was a bare name found on PATH: it follows PATH changes
    const typed = pyStrip(pyStrip(pyStr(raw.command)), '"\'');
    if (typed && !typed.includes('/') && !typed.includes('\\') && !secondIsColon(typed)) command = typed;
  } else {
    command = isStr(command) ? lineText(command, MAX_COMMAND) : '';
    if (!command) throw new ValueError('Missing command');
  }
  const old = existing ?? {};
  const agentId = (old.id || makeId(name, [...takenIds, ...BUILTIN_IDS])) as unknown;
  if (!isCustom(agentId)) throw new ValueError('Invalid agent id');
  const enabled = 'enabled' in raw ? raw.enabled : ('enabled' in old ? old.enabled : true);
  if (typeof enabled !== 'boolean') throw new ValueError('enabled must be true or false');
  const storedEnv = old.env || [];
  const env = 'env' in raw ? keepStoredValues(raw.env, storedEnv) : storedEnv; // no env sent on an edit: keep what is stored
  const args = cleanArgs('args' in raw ? raw.args : []);
  return { id: agentId, name, command: command as string, args, env: cleanEnv(env), enabled };
}

export function letterOf(name: unknown): string {
  return (clip(pyStrip(pyStr(name)), 1) || '?').toUpperCase();
}
