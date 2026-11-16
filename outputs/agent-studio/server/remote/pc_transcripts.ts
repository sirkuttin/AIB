/**
 * Saved transcripts for a paired computer (security review SF1). The transcript viewer's routes read any transcript under the
 * agents' roots by its key; a computer with See chats gets only the chats AIB lists, as the phone does (remote/saved.ts):
 *   GET /api/sessions                       only chats of added projects (never a removed or never-added project's, deleted or not)
 *   GET /api/transcript?key, /image?key     a key of a listed chat, or of one of its subagents (<listed key without .jsonl>/...)
 *   GET /api/agents|commands|command?session  the same rule for the session (its subagents and background-command output)
 * A key it does not know is refused (403 not_listed), so keys built from marks of removed projects (conversation-state carries their
 * cwd and session id) read nothing. The list is the viewer's own /api/sessions, cached LIST_MS and built again once on a miss (a
 * chat that just started), at most every FRESH_MS.
 */
import type { WebContext } from '../web/server.ts';
import { handleGet as monitorGet } from '../transcripts/monitor.ts';
import { folderOfSession } from '../web/project_routes.ts';

type Json = Record<string, unknown>;

export const LIST_MS = 10_000;
export const FRESH_MS = 2_000;

/** The transcript viewer's routes and the query field that names the transcript. */
export const KEY_FIELD: Readonly<Record<string, string>> = {
  '/api/transcript': 'key',
  '/api/transcript/image': 'key',
  '/api/agents': 'session',
  '/api/commands': 'session',
  '/api/command': 'session',
};

/** The sessions a computer is shown: only chats of added projects (the PC's own list also keeps deleted chats of any folder). */
export function listedForComputer(ctx: WebContext, sessions: unknown[]): unknown[] {
  return sessions.filter((s) => {
    try {
      return ctx.addedProjects.shows(folderOfSession(s));
    } catch {
      return false;
    }
  });
}

/** A key a computer may name at all: plain '/'-separated parts, no '.', '..', empty part, backslash or NUL. */
function plainKey(key: string): boolean {
  return key.length <= 2000 && !/[\\\0]/.test(key) && !key.split('/').some((p) => p === '' || p === '.' || p === '..');
}

export class PcTranscripts {
  #at = 0;
  #freshAt = 0;
  #keys = new Set<string>();
  #busy: Promise<Set<string>> | null = null;

  constructor(readonly clock: () => number = Date.now) {}

  async #build(ctx: WebContext): Promise<Set<string>> {
    const out = new Set<string>();
    const reply = await monitorGet(ctx.transcripts, '/api/sessions', '');
    const body = reply.body as Json | null;
    if (reply.status === 200 && body && Array.isArray(body.sessions)) {
      for (const s of listedForComputer(ctx, body.sessions)) {
        const key = s && typeof s === 'object' ? (s as Json).key : null;
        if (typeof key === 'string' && key) out.add(key);
      }
    }
    return out;
  }

  async #list(ctx: WebContext, fresh: boolean): Promise<Set<string>> {
    const now = this.clock();
    if (fresh && now - this.#freshAt < FRESH_MS) return this.#keys;
    if (!fresh && this.#at && now - this.#at < LIST_MS) return this.#keys;
    if (!this.#busy) {
      this.#busy = this.#build(ctx).finally(() => (this.#busy = null));
    }
    try {
      this.#keys = await this.#busy;
    } catch {
      this.#keys = new Set();
    }
    this.#at = this.clock();
    if (fresh) this.#freshAt = this.#at;
    return this.#keys;
  }

  /** May a computer read the transcript `key` (a listed chat's, or one of its subagents')? */
  async allowed(ctx: WebContext, key: unknown): Promise<boolean> {
    if (typeof key !== 'string' || !key || !plainKey(key)) return false;
    const match = (keys: Set<string>) => {
      if (keys.has(key)) return true;
      for (const k of keys) if (k.endsWith('.jsonl') && key.startsWith(k.slice(0, -'.jsonl'.length) + '/')) return true;
      return false;
    };
    return match(await this.#list(ctx, false)) || match(await this.#list(ctx, true));
  }
}
