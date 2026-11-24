/**
 * What the AttentionWatcher already announced (<state>/attention-fired.json), so a restart of AIB, a take-over from the keeper or a
 * rebuild that replays a chat never announces the same thing twice, while news that came while AIB was down is announced once.
 *
 *   needs|<chat>|<request key>    one question, approval or sign-in of a chat (its permission / elicitation key, or "auth")
 *   turn|<chat>|<turnEndedAt>     one finished turn of a chat
 *
 * <chat> is provider:sessionId (the page's chat key), which stays the same across restarts; a chat without a session id yet uses
 * its connection id. Each entry keeps when it was first seen; entries older than 14 days go, and at most 4000 are kept.
 * `since` is when this file was made: a turn that ended before it (an older AIB, the first start with this file) never fires.
 */
import { inDir } from '../state/base.ts';
import { quarantine, readJsonFile, saveJson } from '../state/json.ts';

export const FIRED_FILE = 'attention-fired.json';
const KEEP_SECONDS = 14 * 86400;
const MAX_ENTRIES = 4000;

export class FiredStore {
  readonly path: string | null;
  since: number;
  #fired = new Map<string, number>();

  constructor(stateDir: string | null, readonly clock: () => number = () => Date.now() / 1000) {
    this.path = stateDir ? inDir(stateDir, FIRED_FILE) : null;
    this.since = this.clock();
    if (!this.path) return;
    const [status, data] = readJsonFile(this.path);
    if (status === 'ok' && data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as { since?: unknown; fired?: unknown };
      if (typeof d.since === 'number' && d.since > 0) this.since = d.since;
      if (d.fired && typeof d.fired === 'object' && !Array.isArray(d.fired)) {
        for (const [k, v] of Object.entries(d.fired as Record<string, unknown>)) {
          if (typeof v === 'number' && k.length <= 1200) this.#fired.set(k, v);
        }
      }
    } else if (status === 'corrupt') {
      quarantine(this.path);
    }
    if (status !== 'ok') this.#save();
  }

  has(key: string): boolean {
    return this.#fired.has(key);
  }

  /** Remember these keys (saved at once: announcements are rare). Returns the ones that were new. */
  add(keys: string[]): string[] {
    const now = this.clock();
    const fresh = keys.filter((k) => !this.#fired.has(k));
    if (!fresh.length) return [];
    for (const k of fresh) this.#fired.set(k, now);
    this.#prune(now);
    this.#save();
    return fresh;
  }

  get size(): number {
    return this.#fired.size;
  }

  #prune(now: number): void {
    for (const [k, at] of this.#fired) if (now - at > KEEP_SECONDS) this.#fired.delete(k);
    while (this.#fired.size > MAX_ENTRIES) this.#fired.delete(this.#fired.keys().next().value!);
  }

  #save(): void {
    if (!this.path) return;
    try {
      saveJson(this.path, { version: 1, since: this.since, fired: Object.fromEntries(this.#fired) }, 'attention-fired-');
    } catch { /* the next announcement tries again; nothing is announced twice in this run either way */ }
  }
}
