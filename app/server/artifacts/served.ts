/**
 * What AIB served each chat: the names of the AIB tools its last `tools/list` answered, and the AIB system prompt it was last sent
 * (architect review 0.15, must-fix 2). Kept in the state folder, so a newer AIB that takes the chat over from the keeper still knows
 * what the running agent was given, and a later slice can tell a stale chat (served != current) from a fresh one.
 *
 * <state>/served-tools.json: { "<chat id>": { tools: {hash, names, at}, prompt: {hash, at}, app } }. A tools/list through the HTTP
 * endpoint (the keeper forwarder, the WSL tunnel) writes `tools`; the session/new or session/load that sends the prompt writes
 * `prompt`. Written only when the value changed. Entries not touched for 60 days are dropped.
 */
import { createHash } from 'node:crypto';
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { isDict } from '../core/py.ts';

export const SERVED_FILE = 'served-tools.json';
const KEEP_MS = 60 * 86400_000;

export interface ServedTools {
  hash: string;
  names: string[];
  at: number;
}
export interface Served {
  tools?: ServedTools;
  /** `base`: the hash of AIB's own fixed prompt texts only (the staleness test; the full `hash` also holds per-chat facts). */
  prompt?: { hash: string; base?: string; at: number };
  /** The last automatic restart of this chat to pick up new AIB tools: at most one try per app version. */
  restart?: { app: string; at: number; ok: boolean; error?: string };
  app: string;
}

export { toolSignature } from './mcp_tools.ts';

/** A short stable hash of the sorted tool signatures: each tool's name and its action list (toolSignature in mcp_tools.ts; review M6). */
export function toolsHash(names: readonly string[]): string {
  return createHash('sha256').update([...names].sort().join('\n')).digest('hex').slice(0, 16);
}

/** A short stable hash of the prompt text ('' = AIB sent no prompt). */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

export class ServedRecord {
  readonly #path: string;
  #all: Record<string, Served> | null = null;

  constructor(stateDir: string, private readonly app: string, private readonly clock: () => number = Date.now) {
    this.#path = pathOf(stateDir, SERVED_FILE);
  }

  #load(): Record<string, Served> {
    if (this.#all) return this.#all;
    const all: Record<string, Served> = {};
    try {
      const [status, raw] = readJsonFile(this.#path);
      if (status === 'ok' && isDict(raw)) {
        for (const [id, value] of Object.entries(raw)) if (isDict(value)) all[id] = value as unknown as Served;
      }
    } catch { /* unreadable: start clean */ }
    return (this.#all = all);
  }

  #save(): void {
    const all = this.#load();
    const cutoff = this.clock() - KEEP_MS;
    for (const [id, v] of Object.entries(all)) {
      if (Math.max(v.tools?.at ?? 0, v.prompt?.at ?? 0, v.restart?.at ?? 0) < cutoff) delete all[id];
    }
    try {
      saveJson(this.#path, all, '.served-tools-');
    } catch { /* the record is a hint: a failed write never fails a tool call */ }
  }

  /** The record of one chat, or null. Re-read from the file, so a record another AIB wrote shows. */
  get(id: string): Served | null {
    this.#all = null;
    return this.#load()[id] ?? null;
  }

  /** A tools/list answered these tool names to the chat. */
  tools(id: string, names: string[]): void {
    this.#all = null; // another AIB (an update's) may have written since
    const all = this.#load();
    const hash = toolsHash(names);
    const entry = all[id] ?? (all[id] = { app: this.app });
    if (entry.tools?.hash === hash && entry.app === this.app) return;
    entry.tools = { hash, names: [...names].sort(), at: this.clock() };
    entry.app = this.app;
    this.#save();
  }

  /** The chat was sent this AIB system prompt text ('' = none). */
  prompt(id: string, text: string, base?: string): void {
    this.#all = null;
    const all = this.#load();
    const hash = promptHash(text);
    const entry = all[id] ?? (all[id] = { app: this.app });
    if (entry.prompt?.hash === hash && entry.prompt.base === base && entry.app === this.app) return;
    entry.prompt = { hash, ...(base === undefined ? {} : { base }), at: this.clock() };
    entry.app = this.app;
    this.#save();
  }

  /** True when this app version already tried to restart the chat (it succeeded or not): never tried twice, so never a loop. */
  restartTried(id: string): boolean {
    return this.get(id)?.restart?.app === this.app;
  }

  /** Note a restart attempt (written before it starts, so a crash in it counts as the one try). */
  restartNoted(id: string, ok: boolean, error?: string): void {
    this.#all = null;
    const all = this.#load();
    const entry = all[id] ?? (all[id] = { app: this.app });
    entry.restart = { app: this.app, at: this.clock(), ok, ...(error ? { error: error.slice(0, 300) } : {}) };
    this.#save();
  }
}

/** What AIB would serve a chat now (tools: names; promptBase: hash of its fixed prompt texts), null = not known. */
export interface ServedNow {
  tools: string[] | null;
  promptBase: string | null;
}

/**
 * Why a chat is stale: what it was served differs from what this AIB serves now. An empty list = fresh, or not known well enough to
 * say. `adopted`: the chat was taken over from the keeper. One with no tools record at all ran its tool list before AIB recorded
 * them (an older AIB): stale. A chat with a record that holds no tool list (only its prompt), or one this AIB started, has not asked for its tools yet: not stale.
 */
export function staleReasons(served: Served | null, now: ServedNow, adopted: boolean): string[] {
  const why: string[] = [];
  if (now.tools) {
    if (served?.tools) {
      if (served.tools.hash !== toolsHash(now.tools)) why.push('tools');
    } else if (adopted && !served) why.push('tools (no record: it started before AIB kept one)');
  }
  if (now.promptBase && served?.prompt?.base && served.prompt.base !== now.promptBase) why.push('prompt');
  return why;
}
