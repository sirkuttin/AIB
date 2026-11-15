/**
 * Swarm phase 1: the helper registry (<state>/swarm-helpers.json). A chat is a helper if and only if this file says so; every other
 * chat that works in its own worktree is a main chat (architect review 2026-11-13, option C). The web process writes it (swarm/service.ts);
 * the Studio (in-process, the keeper or the split agent host) only reads it, to give a helper its role when it is opened again after a
 * restart, a keeper take-over or a Continue (review break 1).
 *
 * Records are keyed on lasting names, not live ids: `provider:sessionId` for the parent and the helper, and the helper's worktree path.
 * Live connection ids change across restarts; the service refreshes them from the chat list.
 */
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { isDict } from '../core/py.ts';
import { normcase, realpath } from '../platform/ospath.ts';

export const FILE = 'swarm-helpers.json';

export type HelperState = 'starting' | 'working' | 'waiting' | 'done' | 'merged' | 'stopped' | 'failed';
/** States that count toward the "helpers at once" cap. */
export const RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting']);

export interface Brief {
  goal: string;
  owns: string[];
  avoid: string[];
  done_when: string;
  reply_with: string;
  test_cmd: string;
  read_only: boolean;
  context_files: string[];
}

export interface Note {
  at: number;
  kind: string;
  text: string;
  actions?: string[];
  delivered: boolean;
}

export interface Report {
  n: number;
  at: number;
  text: string;
  delivered: boolean;
  how: '' | 'steer' | 'prompt' | 'queued';
}

export interface Helper {
  id: string;
  title: string;
  /** The repository root: caps are per project. */
  project: string;
  parent: { live: string; lasting: string };
  chat: { live: string; lasting: string; provider: string; model: string; mode: string };
  brief: Brief;
  picked_by: 'rule' | 'main agent';
  rule: string;
  why: string;
  worktree: { path: string; branch: string; base: string; start: string };
  state: HelperState;
  reason: string;
  createdAt: number;
  /** The helper's last turn end that has been reported (its attention.turnEndedAt), and the event cursor read up to. */
  turnEndedAt: string;
  cursor: number;
  reports: Report[];
  merge: null | {
    tipBefore: string;
    landed: string;
    commits: number;
    at: number;
    undo: null | { revert: string; at: number };
    again: null | { commit: string; at: number };
  };
  notes: Note[];
}

interface Doc {
  version: 1;
  helpers: Record<string, Helper>;
}

const same = (a: string, b: string) => !!a && !!b && normcase(realpath(a)) === normcase(realpath(b));

/** The file read fresh (the Studio side reads it this way; small, and read only when a chat opens). Never throws. */
export function readHelpers(stateDir: string): Record<string, Helper> {
  try {
    const [status, raw] = readJsonFile(pathOf(stateDir, FILE));
    if (status !== 'ok' || !isDict(raw) || !isDict(raw.helpers)) return {};
    return raw.helpers as Record<string, Helper>;
  } catch {
    return {};
  }
}

/** The helper a chat is, by its live id, lasting name (provider:sessionId) or worktree folder; null for a non-helper chat. */
export function helperOf(
  helpers: Record<string, Helper>,
  chat: { live?: string | null; lasting?: string | null; path?: string | null },
): Helper | null {
  for (const h of Object.values(helpers)) {
    if (!isDict(h) || !isDict(h.chat)) continue;
    if (chat.live && h.chat.live === chat.live) return h;
    if (chat.lasting && h.chat.lasting === chat.lasting) return h;
    if (chat.path && h.worktree?.path && same(h.worktree.path, chat.path)) return h;
  }
  return null;
}

/** One in-process lock: every write of the file goes through it (only the web process writes). */
class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export class Registry {
  readonly #lock = new Mutex();
  constructor(readonly stateDir: string) {}

  get path(): string {
    return pathOf(this.stateDir, FILE);
  }

  all(): Helper[] {
    return Object.values(readHelpers(this.stateDir));
  }

  get(id: string): Helper | null {
    return readHelpers(this.stateDir)[id] ?? null;
  }

  find(chat: { live?: string | null; lasting?: string | null; path?: string | null }): Helper | null {
    return helperOf(readHelpers(this.stateDir), chat);
  }

  /** Change one record (or add it); the whole file is written atomically. Returns the record as saved. */
  update(id: string, change: (h: Helper | null) => Helper | null): Promise<Helper | null> {
    return this.#lock.run(() => {
      const helpers = readHelpers(this.stateDir);
      const next = change(helpers[id] ? structuredClone(helpers[id]) : null);
      if (next === null) delete helpers[id];
      else helpers[id] = next;
      const doc: Doc = { version: 1, helpers };
      saveJson(this.path, doc, '.swarm-helpers-');
      return next;
    });
  }

  patch(id: string, fields: Partial<Helper>): Promise<Helper | null> {
    return this.update(id, (h) => (h ? { ...h, ...fields } : null));
  }
}

export function newHelperId(): string {
  return 'h_' + crypto.randomUUID().replaceAll('-', '').slice(0, 8);
}
