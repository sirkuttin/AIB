/**
 * Frozen answers of the retired Python reference server (2026-11-23). Tests that used to compare the Deno port with Python
 * (`py.call(module, func, args)`) compare it with the answer Python gave then, kept in work/deno/fixtures/frozen/<test file>.json.
 * The API is the one the live bridge had:
 *
 *   await using py = new Frozen();
 *   assertEquals(port(input), await py.call('rpc_errors', 'describe_auth_methods', [input]));
 *
 * A call is found by module, function, arguments and keyword arguments (the key is `module.func#<sha1 of the request>`). An answer
 * of up to DIGEST_OVER characters is kept as it is; a bigger one is kept as a fingerprint (a FrozenDigest, see _digest.ts), which
 * assertEquals compares with the fingerprint of the value it is given. So the fixtures hold the answers the tests assert, never
 * whole transcripts or trees, and stay small. A temp folder under the OS temp dir is written as a token (<ROOT:..><SEG#n>, numbered
 * in order of first appearance in the arguments), so a new random folder name finds the same answer. A key whose answers differ
 * between calls (state kept by Python) keeps them in order.
 */
import { createHash } from 'node:crypto';
import { WORK } from './_work.ts';
import { assertEquals } from './_assert.ts';
import { digestOf, FrozenDigest } from './_digest.ts';

/** A label for PyParity.frozen from what the run was given: a short fingerprint of the parts (temp folders hidden). */
export function labelOf(...parts: unknown[]): string {
  return digestOf(parts);
}

export type PyReply = { ok: unknown } | { error: string; message: string };

/** One stored answer: {ok}, {error, message}, a fingerprint (string), or {list} (the answers of each item of an array). */
type Answer = { ok: unknown } | { error: string; message: string } | string | { list: Answer[] };
type Stored = Record<string, Answer[]>;

/** The longest answer (in JSON characters) kept as it is. */
export const DIGEST_OVER = 80;

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

/** JSON text with temp folders as tokens: <TMP#n> (key; n numbers the folder names in order of first appearance) or
 *  <ROOT:b|f><SEG#n> (answer; keeps the separator style, backslash or slash, the temp root was spelled with). */
function canonical(value: unknown, folders: Map<string, number>, keepStyle: boolean): string {
  let text = JSON.stringify(value).replace(TMP_RE, (whole, segment: string) => {
    if (!folders.has(segment)) folders.set(segment, folders.size);
    const index = folders.get(segment)!;
    if (!keepStyle) return `<TMP#${index}>`;
    return `<ROOT:${whole.includes('\\\\\\\\') ? 'B' : whole.includes('\\\\') ? 'b' : 'f'}><SEG#${index}>`;
  });
  // the folder name on its own (a `name` field) is the same random text
  for (const [segment, index] of folders) text = text.replaceAll(segment, `<SEGN#${index}>`);
  return text;
}

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

/** The fixture key of a request: readable module.func and a fingerprint of the arguments. */
export function keyOf(request: { module: string; func: string; args: unknown[]; kwargs: Record<string, unknown> }, folders: Map<string, number>): string {
  const text = canonical(request, folders, false);
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/** An array answer the test indexes or filters: each item (to `depth` levels of arrays) is kept or fingerprinted on its own. */
function toItems(items: unknown[], depth: number, folders: Map<string, number>): Answer {
  return { list: items.map((item) => depth > 1 && Array.isArray(item) ? toItems(item, depth - 1, folders) : toAnswer({ ok: item ?? null }, folders)) };
}

function fromItems(answer: Answer, folders: Map<string, number>): unknown {
  if (typeof answer === 'string') return new FrozenDigest(answer);
  if ('list' in answer) return answer.list.map((item) => fromItems(item, folders));
  return (JSON.parse(restore(JSON.stringify(answer), folders)) as { ok: unknown }).ok;
}

/** The answer as it is stored: small ones whole, big ones as a fingerprint. */
export function toAnswer(reply: PyReply, folders: Map<string, number>, whole = false): Answer {
  if ('error' in reply) return reply;
  const text = canonical(reply.ok, folders, true);
  if (whole || text.length <= DIGEST_OVER) return { ok: JSON.parse(text) };
  return digestOf(reply.ok);
}

type Live = { raw(module: string, func: string, args: unknown[], kwargs: Record<string, unknown>): Promise<PyReply>; close(): Promise<void> };

export class PyParity {
  static #files = new Map<string, Stored>();
  static #counters = new Map<string, number>();
  static #recorded = new Map<string, Stored>();
  static #started = new Set<string>();
  #live?: Live;
  #liveReady?: Promise<void>;
  /** Above zero while a frozen() run is live: the calls it makes are part of that run, not answers of their own. */
  #inRun = 0;

  /** While freezing, the live Python bridge, started on the first call. */
  #ensureLive(): Promise<void> {
    return this.#liveReady ??= import('./_parity.ts').then((m) => {
      this.#live = new m.PyParity();
    });
  }

  static #stored(): Stored {
    const name = fixtureName();
    let stored = PyParity.#files.get(name);
    if (!stored) {
      try {
        stored = unpack(JSON.parse(Deno.readTextFileSync(new URL(name, FIXTURES))));
      } catch {
        stored = {};
      }
      PyParity.#files.set(name, stored);
    }
    return stored;
  }

  /** Raw reply: {ok} or {error, message}. */
  async raw(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<PyReply> {
    const folders = new Map<string, number>();
    const key = keyOf({ module, func, args, kwargs }, folders);
    if (FREEZE_MODE) {
      await this.#ensureLive();
      const reply = await this.#live!.raw(module, func, args, kwargs);
      if (this.#inRun > 0) return reply;
      const name = fixtureName();
      const recorded = PyParity.#recorded.get(name) ?? {};
      PyParity.#recorded.set(name, recorded);
      (recorded[key] ??= []).push(toAnswer(reply, folders));
      return reply;
    }
    const answers = PyParity.#stored()[key];
    if (!answers) throw new Error(`No frozen Python answer for ${key} ${JSON.stringify(args).slice(0, 200)} in fixtures/frozen/${fixtureName()}`);
    const counterKey = `${fixtureName()}\n${key}`;
    const at = PyParity.#counters.get(counterKey) ?? 0;
    PyParity.#counters.set(counterKey, at + 1);
    const answer = answers[Math.min(at, answers.length - 1)];
    if (typeof answer === 'string') return { ok: new FrozenDigest(answer) };
    return JSON.parse(restore(JSON.stringify(answer), folders)) as PyReply;
  }

  /** The stored result; throws if Python raised then. A big answer comes back as a FrozenDigest. */
  async call(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    const reply = await this.raw(module, func, args, kwargs);
    if ('error' in reply) throw new Error(`Python ${module}.${func} raised ${reply.error}: ${reply.message}`);
    return reply.ok;
  }

  /**
   * What a Python run gave, found by `label`, for a test that drives Python some other way than through the bridge (a script, a tool
   * over stdio). While freezing (AIB_FREEZE=1) `live` runs and its value is recorded; otherwise the stored answer is returned.
   */
  async frozen<T>(label: string, live?: () => Promise<T>): Promise<T> {
    const folders = new Map<string, number>();
    const key = createHash('sha1').update('frozen:' + label).digest('hex').slice(0, 8);
    if (FREEZE_MODE) {
      this.#inRun++;
      let value: T;
      try {
        value = await live!();
      } finally {
        this.#inRun--;
      }
      const name = fixtureName();
      const recorded = PyParity.#recorded.get(name) ?? {};
      PyParity.#recorded.set(name, recorded);
      (recorded[key] ??= []).push(toAnswer({ ok: value ?? null }, folders));
      PyParity.#flush();
      return value;
    }
    const answers = PyParity.#stored()[key];
    if (!answers) throw new Error(`No frozen Python answer for ${label} in fixtures/frozen/${fixtureName()}`);
    const counterKey = `${fixtureName()}\n${key}`;
    const at = PyParity.#counters.get(counterKey) ?? 0;
    PyParity.#counters.set(counterKey, at + 1);
    const answer = answers[Math.min(at, answers.length - 1)];
    if (typeof answer === 'string') return new FrozenDigest(answer) as T;
    return (JSON.parse(restore(JSON.stringify(answer), folders)) as { ok: T }).ok;
  }

  /** Runs `live` (while freezing) without recording the Python calls it makes: they are part of something else. */
  async quiet<T>(live: () => Promise<T>): Promise<T> {
    this.#inRun++;
    try {
      return await live();
    } finally {
      this.#inRun--;
    }
  }

  /** Like call(), for an object answer whose fields the test reads: each field is kept (or fingerprinted) on its own. */
  async callFields(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const reply = await this.callItems(module, func, [...args], kwargs, 1, true);
    return Object.fromEntries((reply as [string, unknown][]));
  }

  /** Like frozen(), but the value is kept as it is, however long (a list of short fingerprints a test made itself). */
  async frozenWhole<T>(label: string, live?: () => Promise<T>): Promise<T> {
    const folders = new Map<string, number>();
    const key = createHash('sha1').update('frozenwhole:' + label).digest('hex').slice(0, 8);
    if (FREEZE_MODE) {
      const value = await live!();
      const name = fixtureName();
      const recorded = PyParity.#recorded.get(name) ?? {};
      PyParity.#recorded.set(name, recorded);
      recorded[key] = [toAnswer({ ok: value ?? null }, folders, true)];
      PyParity.#flush();
      return value;
    }
    const answers = PyParity.#stored()[key];
    if (!answers) throw new Error(`No frozen Python answer for ${label} in fixtures/frozen/${fixtureName()}`);
    return (answers[0] as { ok: T }).ok;
  }

  /** Like call(), for an array answer the test indexes or filters: each item (to `depth` levels of arrays) is kept on its own. */
  async callItems(module: string, func: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}, depth = 1, fields = false): Promise<unknown[]> {
    const folders = new Map<string, number>();
    const key = keyOf({ module, func, args, kwargs }, folders);
    if (FREEZE_MODE) {
      await this.#ensureLive();
      const reply = await this.#live!.raw(module, func, args, kwargs);
      if ('error' in reply) throw new Error(`Python ${module}.${func} raised ${reply.error}: ${reply.message}`);
      const name = fixtureName();
      const recorded = PyParity.#recorded.get(name) ?? {};
      PyParity.#recorded.set(name, recorded);
      const entries = fields ? Object.entries(reply.ok as Record<string, unknown>) : [];
      const items = fields ? entries : reply.ok as unknown[];
      (recorded[key] ??= []).push(fields ? { list: entries.map(([k, v]) => ({ list: [{ ok: k }, toAnswer({ ok: v ?? null }, folders)] })) } : toItems(items, depth, folders));
      return items;
    }
    const answers = PyParity.#stored()[key];
    if (!answers) throw new Error(`No frozen Python answer for ${key} ${JSON.stringify(args).slice(0, 200)} in fixtures/frozen/${fixtureName()}`);
    return fromItems(answers[0], folders) as unknown[];
  }

  /** Like frozen(), for a run that gives an array: each item (to `depth` levels of arrays) is kept on its own, so the test can index it. */
  async frozenList<T = unknown>(label: string, live?: () => Promise<T[]>, depth = 1): Promise<T[]> {
    const folders = new Map<string, number>();
    const key = createHash('sha1').update('frozenlist:' + label).digest('hex').slice(0, 8);
    if (FREEZE_MODE) {
      this.#inRun++;
      let value: T[];
      try {
        value = await live!();
      } finally {
        this.#inRun--;
      }
      const name = fixtureName();
      const recorded = PyParity.#recorded.get(name) ?? {};
      PyParity.#recorded.set(name, recorded);
      recorded[key] = [toItems(value, depth, folders)];
      PyParity.#flush();
      return value;
    }
    const answers = PyParity.#stored()[key];
    if (!answers) throw new Error(`No frozen Python answer for ${label} in fixtures/frozen/${fixtureName()}`);
    return fromItems(answers[0], folders) as T[];
  }

  /** Assert the port gives what Python gave for each input. `port` returns the same plain JSON shape. */
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

  async close(): Promise<void> {
    if (FREEZE_MODE) {
      await this.#liveReady;
      await this.#live?.close();
      PyParity.#flush();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  static #flush() {
    for (const [name, recorded] of PyParity.#recorded) {
      const merged: Stored = {};
      try {
        Object.assign(merged, unpack(JSON.parse(Deno.readTextFileSync(new URL(name, FIXTURES)))));
      } catch { /* a first recording */ }
      if (!PyParity.#started.has(name)) {
        for (const k of Object.keys(merged)) delete merged[k];
        PyParity.#started.add(name);
      }
      for (const [key, answers] of Object.entries(recorded)) merged[key] = collapse(answers);
      Deno.mkdirSync(FIXTURES, { recursive: true });
      const lines = Object.keys(merged).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(merged[k].length === 1 ? merged[k][0] : merged[k])}`);
      Deno.writeTextFileSync(new URL(name, FIXTURES), '{\n' + lines.join(',\n') + '\n}\n');
    }
  }
}

const FREEZE_MODE = Deno.env.get('AIB_FREEZE') === '1';

/** One answer when every call got the same one; the answers in order when they differ. */
function collapse(answers: Answer[]): Answer[] {
  const first = JSON.stringify(answers[0]);
  return answers.every((a) => JSON.stringify(a) === first) ? [answers[0]] : answers;
}

/** The file keeps one answer as itself and several as an array; in memory every key holds an array. */
function unpack(raw: Record<string, Answer | Answer[]>): Stored {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}
