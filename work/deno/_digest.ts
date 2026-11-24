/**
 * A short fingerprint of a value, for answers too big to keep in a fixture (see _frozen.ts). assertEquals (_assert.ts) accepts a
 * FrozenDigest on either side and compares it with the fingerprint of the other value.
 */
import { createHash } from 'node:crypto';
import { NODE } from './_fakes.ts';

/**
 * The answers in fixtures/frozen were recorded with the interpreter that ran the fake agents at this path (the owner's Python). The
 * tests now start node, so wherever a request is fingerprinted, the node program's path stands for the recorded one: a request with
 * [node] gets the key and digest it got with [that Python]. (The fixtures are no longer recorded; see _frozen.ts.)
 */
const RECORDED_INTERPRETER = 'C:\\Program Files\\Python311\\python.exe';
const asJson = (path: string) => JSON.stringify(path).slice(1, -1);
const nodeForms = [NODE, Deno.realPathSync(NODE)]; // the name it is started by and the program it resolves to (a version manager's alias)
const nodeJson = [...new Set(nodeForms.flatMap((p) => [asJson(p), asJson(p.replaceAll('\\', '/'))]))];
/** True when the JSON text names the node program (a request or a value that came from a test that passed node where Python was). */
export const namesNode = (jsonText: string): boolean => nodeJson.some((form) => jsonText.includes(form));
/** The text as the recording had it: the interpreter, and the fake agents' file names (work/fakes/x.mjs was work/x.py). */
function recordedForm(jsonText: string): string {
  let text = jsonText;
  for (const form of nodeJson) text = text.replaceAll(form, asJson(RECORDED_INTERPRETER));
  // in JSON text a backslash is two, so a separator is two backslashes or a slash
  return text.replace(/(work(?:\\\\|\/))fakes(?:\\\\|\/)(\w+)\.mjs/g, '$1$2.py').replace(/(-fixture(?:\\\\|\/)agent)\.mjs/g, '$1.py');
}

let tmpRe: RegExp | null = null;
/** Matches the OS temp folder and the random name under it, in JSON text. */
function tempPattern(): RegExp {
  if (tmpRe) return tmpRe;
  const probe = Deno.makeTempDirSync({ prefix: 'digest-probe-' });
  Deno.removeSync(probe);
  const root = probe.replace(/[\\/][^\\/]+$/, '');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // In JSON text a backslash is two, so a separator is two backslashes or a slash.
  const sep = String.raw`(?:\\\\|/)+`;
  tmpRe = new RegExp(root.split(/[\\/]+/).filter(Boolean).map(escape).join(sep) + sep + String.raw`([^\\/"]+)`, 'gi');
  return tmpRe;
}

/**
 * The OS temp folder of a path (and the random name under it) written as <TMP>, whatever the separator style; the random part of a
 * made-up folder name on its own (`studio-folders-9908069b5cb6beac`, 16 hex digits after a dash) is <R>.
 */
export const hideTemp = (jsonText: string): string => jsonText.replace(tempPattern(), '<TMP>').replace(/([A-Za-z0-9_]-)[0-9a-f]{16}(?![0-9A-Za-z])/g, '$1<R>');

let localRes: [RegExp, string][] | null = null;
/** The repo checkout and the home folder as patterns over JSON text (any separator style, any case), each with its token. */
function localPatterns(): [RegExp, string][] {
  if (localRes) return localRes;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = String.raw`(?:\\\\|/)+`;
  const make = (path: string) => {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    // what follows the folder in the same path is written with slashes whatever the platform (hideLocal does that)
    return new RegExp(parts.map(escape).join(sep) + String.raw`((?:(?:\\\\|/)+[^\\/"]+)*)`, 'gi');
  };
  const repo = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const out: [RegExp, string][] = [[make(repo), '<REPO>']];
  const home = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME');
  if (home) out.push([make(home), '<HOME>']);
  return localRes = out;
}

/**
 * The checkout the tests run from and the home folder written as <REPO> and <HOME> (what follows them in the path with slashes), so
 * a fingerprint is the same in a worktree, in the main checkout and on another machine. Temp folders are hidden first (they sit under home).
 */
export const hideLocal = (jsonText: string, recorded = false): string => {
  let text = hideTemp(recorded ? recordedForm(jsonText) : jsonText);
  for (const [re, token] of localPatterns()) text = text.replace(re, (_whole, rest: string) => token + rest.replace(/(?:\\\\|\/)+/g, '/'));
  return text;
};

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** sha1 (8 hex characters) of the JSON of value, keys sorted, temp folders hidden; undefined and a missing value are null. */
export function digestOf(value: unknown, recorded = false): string {
  const plain = JSON.parse(JSON.stringify(value ?? null));
  return createHash('sha1').update(hideLocal(JSON.stringify(sorted(plain)), recorded)).digest('hex').slice(0, 8);
}

export class FrozenDigest {
  /** recorded: the answer came from a request that named node, so its value is fingerprinted as the recording had it (see recordedForm). */
  constructor(readonly hash: string, readonly recorded = false) {}
  toJSON() {
    return { digest: this.hash };
  }
}
