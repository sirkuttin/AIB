/**
 * Frozen answers recorded from the retired reference server (2026-11-23). Tests that used to compare the Deno port with a live run
 * (`py.call(module, func, args)`) compare it with the recorded answer, kept in work/deno/fixtures/frozen/<test file>.json.
 *
 *   const py = new Frozen();
 *   assertEquals(port(input), await py.call('rpc_errors', 'describe_auth_methods', [input]));
 *
 * A call is found by module, function, arguments and keyword arguments (the key is the sha1 of the request). An answer of up to
 * DIGEST_OVER characters is kept as it is; a bigger one is kept as a fingerprint (a FrozenDigest, see _digest.ts), which assertEquals
 * compares with the fingerprint of the value it is given. So the fixtures hold the answers the tests assert, never whole transcripts or
 * trees, and stay small. Where the checkout the tests run from, the home folder or a temp folder shows in a request, it is written as
 * a token (<REPO>, <HOME>, <ROOT:..><SEG#n>: numbered in order of first appearance in the arguments), so a worktree, the main checkout
 * and a new random folder name all find the same answer. A key whose answers differ between calls (state kept by the recorded program) keeps them
 * in order.
 *
 * The fixtures are no longer recorded: to change an answer, edit the fixture (or turn the check into a plain assertion).
 */
import { createHash } from 'node:crypto';
import { WORK } from './_work.ts';
import { assertEquals } from './_assert.ts';
import { digestOf, FrozenDigest, hideLocal, namesNode } from './_digest.ts';

/** A label for Frozen.frozen from what the run was given: a short fingerprint of the parts (temp folders hidden). */
export function labelOf(...parts: unknown[]): string {
  return digestOf(parts);
}

export type PyReply = { ok: unknown } | { error: string; message: string };

/** One stored answer: {ok}, {error, message}, a fingerprint (string), or {list} (the answers of each item of an array). */
type Answer = { ok: unknown } | { error: string; message: string } | string | { list: Answer[] };
type Stored = Record<string, Answer[]>;

const FIXTURES = new URL('deno/fixtures/frozen/', WORK);

/** The OS temp dir. */
const TMP_ROOT = (() => {
  const probe = Deno.makeTempDirSync({ prefix: 'frozen-probe-' });
  Deno.removeSync(probe);
  return probe.replace(/[\\/][^\\/]+$/, '');
})();
/** In JSON text a backslash is written as two, so a separator is two backslashes or a slash. */
const SEP = String.raw`(?:\\\\|/)+`;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TMP_RE = new RegExp(
  TMP_ROOT.split(/[\\/]+/).filter(Boolean).map(escapeRe).join(SEP) + SEP + String.raw`([^\\/"]+)`,
  'gi',
);

/** A fixture file name for the running test file. */
function fixtureName(): string {
  const match = (Deno.mainModule + '\n' + (new Error().stack ?? '')).match(/([A-Za-z0-9_]+)_test\.ts/);
  return `${match ? match[1] : 'unknown'}.json`;
}

/** JSON text of a request with the checkout, home and temp folders as tokens (<TMP#n>: n numbers the folder names in order of first appearance). */
function canonical(value: unknown, folders: Map<string, number>): string {
  let text = JSON.stringify(value).replace(TMP_RE, (_whole, segment: string) => {
    if (!folders.has(segment)) folders.set(segment, folders.size);
    return `<TMP#${folders.get(segment)}>`;
  });
  // the folder name on its own (a `name` field) is the same random text
  for (const [segment, index] of folders) text = text.replaceAll(segment, `<SEGN#${index}>`);
  return hideLocal(text, true); // as the recording had it (the interpreter and fake agent names, see _digest.ts recordedForm)
}

/** The text of a stored answer with its temp-folder tokens turned back into this run's folder names. */
function restore(text: string, folders: Map<string, number>): string {
  const names = [...folders.entries()].sort((x, y) => x[1] - y[1]).map(([name]) => name);
  const root = (style: string) =>
    style === 'B'
      ? TMP_ROOT.replaceAll('/', '\\').replaceAll('\\', '\\\\\\\\') + '\\\\\\\\'
      : style === 'b'
      ? TMP_ROOT.replaceAll('/', '\\').replaceAll('\\', '\\\\') + '\\\\'
      : TMP_ROOT.replaceAll('\\', '/') + '/';
  return text.replace(/<ROOT:([bBf])><SEG#(\d+)>/g, (token, style: string, index: string) => names[Number(index)] === undefined ? token : root(style) + names[Number(index)])
    .replace(/<SEGN#(\d+)>/g, (token, index: string) => names[Number(index)] ?? token);
}

/** The fixture key of a request: a fingerprint of module, function and arguments. */
export function keyOf(request: { module: string; func: string; args: unknown[]; kwargs: Record<string, unknown> }, folders: Map<string, number>): string {
  const text = canonical(request, folders);
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function fromItems(answer: Answer, folders: Map<string, number>, recorded = false): unknown {
  if (typeof answer === 'string') return new FrozenDigest(answer, recorded);
  if ('list' in answer) return answer.list.map((item) => fromItems(item, folders, recorded));
  return (JSON.parse(restore(JSON.stringify(answer), folders)) as { ok: unknown }).ok;
}

export class Frozen {
  /** recorded: every fingerprint is compared as the recording had it (a test whose values name node where the recording named Python). */
  constructor(readonly recorded = false) {}

  static #files = new Map<string, Stored>();
  static #counters = new Map<string, number>();

  static #stored(): Stored {
    const name = fixtureName();
    let stored = Frozen.#files.get(name);
    if (!stored) {
      try {
        stored = unpack(JSON.parse(Deno.readTextFileSync(new URL(name, FIXTURES))));
      } catch {
        stored = {};
      }
      Frozen.#files.set(name, stored);
    }
    return stored;
  }

  /** Raw reply: {ok} or {error, message}. */
  raw(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<PyReply> {
    const folders = new Map<string, number>();
    const key = keyOf({ module, func, args, kwargs }, folders);
    const answers = Frozen.#stored()[key];
    if (!answers) throw new Error(`No frozen answer for ${key} ${JSON.stringify(args).slice(0, 200)} in fixtures/frozen/${fixtureName()}`);
    const counterKey = `${fixtureName()}\n${key}`;
    const at = Frozen.#counters.get(counterKey) ?? 0;
    Frozen.#counters.set(counterKey, at + 1);
    const answer = answers[Math.min(at, answers.length - 1)];
    if (typeof answer === 'string') return Promise.resolve({ ok: new FrozenDigest(answer, this.recorded || namesNode(JSON.stringify(args))) });
    return Promise.resolve(JSON.parse(restore(JSON.stringify(answer), folders)) as PyReply);
  }

  /** The stored result; throws if the recorded call raised. A big answer comes back as a FrozenDigest. */
  async call(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    const reply = await this.raw(module, func, args, kwargs);
    if ('error' in reply) throw new Error(`The frozen answer for ${module}.${func} is an error: ${reply.error}: ${reply.message}`);
    return reply.ok;
  }

  /** What the recorded run gave, found by `label`, for a test that was driven some other way than through the bridge (a script, a tool over stdio). */
  frozen<T>(label: string): Promise<T> {
    const key = createHash('sha1').update('frozen:' + label).digest('hex').slice(0, 8);
    const answers = Frozen.#stored()[key];
    if (!answers) throw new Error(`No frozen answer for ${label} in fixtures/frozen/${fixtureName()}`);
    const counterKey = `${fixtureName()}\n${key}`;
    const at = Frozen.#counters.get(counterKey) ?? 0;
    Frozen.#counters.set(counterKey, at + 1);
    const answer = answers[Math.min(at, answers.length - 1)];
    if (typeof answer === 'string') return Promise.resolve(new FrozenDigest(answer, this.recorded) as T);
    return Promise.resolve((JSON.parse(restore(JSON.stringify(answer), new Map())) as { ok: T }).ok);
  }

  /** Like call(), for an object answer whose fields the test reads: each field is kept (or fingerprinted) on its own. */
  async callFields(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const reply = await this.callItems(module, func, [...args], kwargs);
    return Object.fromEntries((reply as [string, unknown][]));
  }

  /** Like frozen(), but the value was kept as it is, however long (a list of short fingerprints a test made itself). */
  frozenWhole<T>(label: string): Promise<T> {
    const key = createHash('sha1').update('frozenwhole:' + label).digest('hex').slice(0, 8);
    const answers = Frozen.#stored()[key];
    if (!answers) throw new Error(`No frozen answer for ${label} in fixtures/frozen/${fixtureName()}`);
    return Promise.resolve((answers[0] as { ok: T }).ok);
  }

  /** Like call(), for an array answer the test indexes or filters: each item (to `depth` levels of arrays) was kept on its own. */
  callItems(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown[]> {
    const folders = new Map<string, number>();
    const key = keyOf({ module, func, args, kwargs }, folders);
    const answers = Frozen.#stored()[key];
    if (!answers) throw new Error(`No frozen answer for ${key} ${JSON.stringify(args).slice(0, 200)} in fixtures/frozen/${fixtureName()}`);
    return Promise.resolve(fromItems(answers[0], folders, this.recorded || namesNode(JSON.stringify(args))) as unknown[]);
  }

  /** Like frozen(), for a run that gave an array: each item was kept on its own, so the test can index it. */
  frozenList<T = unknown>(label: string): Promise<T[]> {
    const folders = new Map<string, number>();
    const key = createHash('sha1').update('frozenlist:' + label).digest('hex').slice(0, 8);
    const answers = Frozen.#stored()[key];
    if (!answers) throw new Error(`No frozen answer for ${label} in fixtures/frozen/${fixtureName()}`);
    return Promise.resolve(fromItems(answers[0], folders, this.recorded) as T[]);
  }

  /** Assert the port give what the frozen answers hold for each input. `port` returns the same plain JSON shape. */
  async same(module: string, func: string, inputs: unknown[][], port: (...args: never[]) => unknown): Promise<void> {
    for (const args of inputs) {
      const expected = await this.call(module, func, args);
      assertEquals(
        JSON.parse(JSON.stringify((port as (...a: unknown[]) => unknown)(...args) ?? null)),
        expected,
        `${func}(${JSON.stringify(args)})`,
      );
    }
  }
}

/** The file keeps one answer as itself and several as an array; in memory every key holds an array. */
function unpack(raw: Record<string, Answer | Answer[]>): Stored {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}
