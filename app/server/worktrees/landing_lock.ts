/**
 * Build plan 1b, 2.3 (MF 2): the web side of the host's landing lock. A landing (a folder chat's helper, an Own-copy chat's Merge, a
 * helper's Undo or Merge again) changes files in a project folder. While it runs, no chat that works in that folder may start a turn:
 * the host's `landing-lock` checks the chat is idle and holds it in one step, and from then on every prompt source queues in that chat
 * (the page, a steer while idle, the phone, a helper's report, a merge prompt). The lock is renewed every RENEW_MS while the work runs;
 * the host lets it go on its own only after TTL_MS without a renewal (this process died mid-landing; the swarm journal finishes it).
 */
import { isDict } from '../core/py.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('landing_lock');

export const RENEW_MS = 10_000;
export const TTL_MS = 60_000;
export const timing = { renewMs: RENEW_MS, ttlMs: TTL_MS };

export interface LockHost {
  liveCall(op: string, payload: Record<string, unknown>): [number, unknown] | Promise<[number, unknown]>;
}

export interface FolderChat {
  id: string;
  title: string;
  /** '' when idle, else what it is doing. */
  idle: string;
  /** The title of what is landing there now ('' when nothing). */
  landing: string;
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** The open chats that work in `folder` itself (not copies, not helpers). [] when the host can't say (an older host). */
export async function folderChats(host: LockHost, folder: string): Promise<FolderChat[]> {
  try {
    const [code, payload] = await host.liveCall('folder-chats', { folder });
    if (code !== 200 || !isDict(payload) || !Array.isArray(payload.chats)) return [];
    return payload.chats.filter(isDict).map((c) => ({ id: s(c.id), title: s(c.title), idle: s(c.idle), landing: s(c.landing) }));
  } catch {
    return [];
  }
}

export function newLockId(): string {
  return 'land_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/** Locks held on some chats, renewed until released. */
export class Held {
  #timer: ReturnType<typeof setInterval> | null = null;
  constructor(readonly host: LockHost, readonly lock: string, readonly ids: string[]) {
    if (ids.length) {
      this.#timer = setInterval(() => void this.renew(), timing.renewMs);
    }
  }

  async renew(): Promise<void> {
    for (const id of this.ids) {
      try {
        await this.host.liveCall('landing-renew', { id, lock: this.lock, ttlMs: timing.ttlMs });
      } catch (error) {
        log.info('Renewing the landing lock of %s failed: %s', id, error instanceof Error ? error.message : error);
      }
    }
  }

  async release(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const id of this.ids) {
      try {
        await this.host.liveCall('landing-release', { id, lock: this.lock });
      } catch (error) {
        log.info('Releasing the landing lock of %s failed: %s', id, error instanceof Error ? error.message : error);
      }
    }
  }
}

/**
 * Lock every chat in `ids` (all or none): {held} on success, else {busy: [id, reason]} for the first chat that is not idle (and the
 * ones already taken are let go).
 */
export async function lockChats(
  host: LockHost,
  ids: string[],
  title: string,
  owner: string,
  lock = newLockId(),
  /** A builder's landing (a subagent or helper that finished): the gate is the one of Connection.builderLandingReason, not an idle chat. */
  builder = false,
): Promise<{ held: Held; busy: null } | { held: null; busy: [string, string] }> {
  const taken: string[] = [];
  for (const id of ids) {
    let why = 'the chat did not answer';
    try {
      const [code, payload] = await host.liveCall('landing-lock', { id, lock, owner, title, ttlMs: timing.ttlMs, ...(builder ? { builder: true } : {}) });
      if (code === 200 && isDict(payload)) why = payload.ok ? '' : s(payload.reason) || 'busy';
      else if (code === 400) why = ''; // no such chat (it closed meanwhile): nothing to hold
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
    if (why) {
      await new Held(host, lock, taken).release();
      return { held: null, busy: [id, why] };
    }
    taken.push(id);
  }
  return { held: new Held(host, lock, taken), busy: null };
}
