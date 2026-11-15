/**
 * Live sync for WSL chats' worktrees, Windows side (docs/wsl/design.md section 4 phase 2, section 5 item 1). The engine
 * (worktrees/sync.ts) runs whole in the distro's helper (wsl/helper/sync.ts, `sync.*`): a Windows watcher on a WSL path gets no change
 * events, so the watching (inotify), the scans, the copies, the 3-way merges and the lost-update guard all happen there, over the
 * worktree registry and the locks Merge uses. AIB makes only coarse calls:
 *
 *   sync.chats         the whole set of open WSL chats in their own copy, per distro, in order: when a chat opens or closes, and every
 *                      KEEP_SECONDS while there are any (a helper that died is started again by the call and watches them again)
 *   sync.turnStarted   Studio's onTurnStart for a WSL chat (the lost-update guard of the last turn, catch-up, the pending merges)
 *   sync.contextFor    the <studio-context> note for the prompt (or steer), as sync.ts contextFor makes it
 *   sync.contextSent   the note went out
 *   sync.turnEnded     Studio's turnEnded hook
 *
 * each with the chat's public state (helperState: no message text crosses). Live sync never starts a distro: a distro that is not
 * ready is skipped, and a helper without the methods means no live sync, as before. Windows chats never come here.
 */
import { getLogger } from '../core/log.ts';
import { isDict } from '../core/py.ts';
import { peekWslHost, wslLoc } from './access.ts';
import { type HelperMethods, WslHelperError, type WslHost } from './contract.ts';
import { helperState } from './merge.ts';

const log = getLogger('wsl_sync');

/** Mutable so tests can shorten them. */
export const wslSyncSettings = {
  KEEP_SECONDS: 10, // the set of open chats is sent again this often while there are any
  CALL_TIMEOUT_MS: 60_000,
  TURN_TIMEOUT_MS: 300_000, // a turn hook merges files in the distro (git merge-file per file)
  FINISH_TIMEOUT_MS: 3_000, // AIB closes: the empty set, at most this long per distro
};

/** A chat as WSL live sync sees it (a Connection). */
export interface WslSyncConnection {
  id: string;
  cwd: string;
  closed?: boolean;
  worktree?: unknown;
  public(since?: number): unknown;
}

/** What WSL live sync needs from Studio. */
export interface WslSyncStudio {
  connections: { values(): Iterable<WslSyncConnection> };
  settings: { worktreePerChat(): boolean };
}

/** The distro and worktree Linux folder of a live WSL chat working in its own copy; null for every other chat. */
export function wslSyncChat(c: WslSyncConnection | null | undefined): { distro: string; linuxPath: string } | null {
  if (!c || c.closed || !c.worktree) return null;
  return wslLoc(c.cwd);
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The helper does not offer sync.* (an older helper, or one without its data folder): no live sync there. */
function noSync(error: unknown): boolean {
  return error instanceof WslHelperError && (error.code === 'unknown_method' || error.code === 'no_method');
}

/** The host of a distro AIB already uses and that is ready now; live sync never makes or starts one. */
function readyHost(distro: string): WslHost | null {
  const host = peekWslHost(distro);
  return host && host.state === 'ready' ? host : null;
}

type Item = { chat: string; cwd: string };

export class WslSync {
  #closed = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** Distros whose helper holds a non-empty set from this AIB (it gets the empty one when the last chat there goes). */
  readonly #told = new Set<string>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(readonly studio: WslSyncStudio) {}

  enabled(): boolean {
    return !this.#closed && this.studio.settings.worktreePerChat();
  }

  /** The open WSL chats in their own copy, per distro. */
  open(): Map<string, Item[]> {
    const out = new Map<string, Item[]>();
    if (!this.enabled()) return out;
    for (const c of this.studio.connections.values()) {
      const wsl = wslSyncChat(c);
      if (!wsl) continue;
      const items = out.get(wsl.distro) ?? [];
      items.push({ chat: c.id, cwd: wsl.linuxPath });
      out.set(wsl.distro, items);
    }
    return out;
  }

  /** Tell each distro's helper its open chats (a chat opened or closed, or the periodic keep). Never throws. */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const open = this.open();
    this.#keep(open.size > 0);
    const distros = new Set([...open.keys(), ...this.#told]);
    return Promise.all([...distros].map((d) => this.#send(d, () => this.open().get(d) ?? []))).then(() => {});
  }

  /** One sync.chats per distro at a time, in order; the set is read when the call goes, so the last one sent is the latest. */
  #send(distro: string, items: () => Item[], timeoutMs = wslSyncSettings.CALL_TIMEOUT_MS): Promise<void> {
    const run = (this.#queues.get(distro) ?? Promise.resolve()).then(async () => {
      const host = readyHost(distro);
      if (!host) return;
      const chats = items();
      try {
        await host.call('sync.chats', { chats }, { timeoutMs });
        if (chats.length) this.#told.add(distro);
        else this.#told.delete(distro);
      } catch (error) {
        if (!noSync(error)) log.warning('wsl: live sync in %s could not be told the open chats: %s', distro, text(error));
      }
    });
    const settled = run.catch(() => {});
    this.#queues.set(distro, settled);
    return settled;
  }

  #keep(on: boolean): void {
    if (on && this.#timer === null && !this.#closed) {
      this.#timer = setInterval(() => void this.refresh(), wslSyncSettings.KEEP_SECONDS * 1000);
      Deno.unrefTimer(this.#timer);
    } else if (!on && this.#timer !== null && !this.#told.size) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** A WSL chat is ready in its own copy (new, continued, or taken over from the keeper): its helper watches its project. */
  chatOpened(_connection: WslSyncConnection): Promise<void> {
    return this.refresh();
  }

  async #hook<M extends 'sync.turnStarted' | 'sync.turnEnded' | 'sync.contextFor' | 'sync.contextSent'>(
    c: WslSyncConnection,
    method: M,
    extra: Record<string, unknown> = {},
    timeoutMs = wslSyncSettings.CALL_TIMEOUT_MS,
  ): Promise<HelperMethods[M]['result'] | null> {
    const wsl = wslSyncChat(c);
    if (!wsl || !this.enabled()) return null;
    const host = readyHost(wsl.distro);
    if (!host) return null;
    let state: unknown;
    try {
      state = await c.public(0);
    } catch {
      return null;
    }
    const params = { chat: c.id, state: helperState({ id: c.id, ...wsl, state: isDict(state) ? state : {} }), ...extra };
    try {
      return await host.call(method, params as HelperMethods[M]['params'], { timeoutMs });
    } catch (error) {
      if (!noSync(error)) log.warning('wsl: live sync %s of %s failed: %s', method, c.cwd, text(error));
      return null;
    }
  }

  /** Studio's onTurnStart for a WSL chat. */
  async turnStarted(c: WslSyncConnection): Promise<void> {
    await this.#hook(c, 'sync.turnStarted', {}, wslSyncSettings.TURN_TIMEOUT_MS);
  }

  /** Studio's turn-end hook for a WSL chat. */
  async turnEnded(c: WslSyncConnection): Promise<void> {
    await this.#hook(c, 'sync.turnEnded', {}, wslSyncSettings.TURN_TIMEOUT_MS);
  }

  /** [text, token] of the note for the chat's next prompt, or null (Connection.contextForPrompt). */
  async contextFor(c: WslSyncConnection): Promise<[string, unknown] | null> {
    const answer = await this.#hook(c, 'sync.contextFor');
    const context = answer?.context;
    return Array.isArray(context) && typeof context[0] === 'string' && context[0] ? [context[0], context[1]] : null;
  }

  async contextSent(c: WslSyncConnection, token: unknown): Promise<void> {
    await this.#hook(c, 'sync.contextSent', { token });
  }

  /** AIB stops (quit, update, restart): nothing more is sent; the helpers keep syncing the chats that go on running in the keeper. */
  stopAll(): void {
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** AIB closed every chat: each helper this AIB told is given the empty set (best effort, briefly), so it stops watching. */
  async finish(): Promise<void> {
    this.stopAll();
    await Promise.all([...this.#told].map((d) => this.#send(d, () => [], wslSyncSettings.FINISH_TIMEOUT_MS)));
  }
}

/** Resume on the amber line of a WSL project (its ref): the storm pause in its distro ends. False when nothing was paused there. */
export async function wslResumeSync(projectRef: unknown): Promise<boolean> {
  const wsl = wslLoc(projectRef);
  if (!wsl) return false;
  const host = readyHost(wsl.distro);
  if (!host) return false;
  try {
    return (await host.call('sync.resume', { project: wsl.linuxPath }, { timeoutMs: wslSyncSettings.CALL_TIMEOUT_MS })).resumed === true;
  } catch (error) {
    if (!noSync(error)) log.warning('wsl: resuming live sync of %s failed: %s', projectRef, text(error));
    return false;
  }
}
