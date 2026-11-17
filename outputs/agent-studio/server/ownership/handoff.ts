/**
 * Open elsewhere: AIB lets go of a Claude Code chat that another app opened (private/designs/open-elsewhere/research.md, section 5).
 *
 * Detection: Claude Code's live-session registry (claude_sessions.ts). The folder of every Windows Claude chat's config is watched
 * (Deno.watchFs, debounced) with a 10 s rescan as a backup; a live record that names a chat's session and whose process is not one of
 * AIB's own (not below any of AIB's agent processes: the adapter starts claude.exe as its child) means another app holds it.
 * WSL chats are checked inside their distro by its AIB helper (`sessions.held`, helper/bgtasks.ts) on the same 10 s beat.
 *
 * Hand-off (Connection.handOff / tryRelease): an idle chat closes its session at once (session/close: the Claude process ends, the
 * adapter and its keeper channel stay); a chat whose turn is running closes when the turn ends; background helpers or shells still
 * running wait too (closing would stop them). Queued messages wait. Coming back (Connection.reclaim): sending, or Open here, checks the
 * registry again; free: session/load, which brings in the turns written elsewhere; still held: one line with Open here anyway, and
 * nothing is sent until it is chosen.
 *
 * Never throws out of a timer; costs one readdir and a few small reads per scan, and nothing while no Claude chat is open.
 */
import type { Connection } from '../acp/connection.ts';
import { isFixture, testHomeEnv } from '../acp/connection.ts';
import { getLogger } from '../core/log.ts';
import { descendants, refreshDescendants } from '../platform/descendants.ts';
import { claudeConfigDir } from '../subagents/claude_config.ts';
import { WIN } from '../platform/ospath.ts';
import { type Holder, holderOf, liveRecords, type SessionRecord, sessionsDir } from './claude_sessions.ts';

const log = getLogger('handoff');

export const RESCAN_MS = 10_000;
export const DEBOUNCE_MS = 300;
/** While a chat waits for its turn (or helpers) to end before it lets go: how often it looks again. */
export const PENDING_MS = 1_000;

/** Providers whose agent is Claude Code (they write the registry). */
const CLAUDE_PROVIDERS = new Set(['claude']);

export interface HandoffHost {
  connections(): Iterable<Connection>;
  /** WSL: who else holds these sessions in the distro (its helper's answer); {} when it cannot tell. */
  wslHeld?(distro: string, sessionIds: string[], chatPids: number[]): Promise<Record<string, Holder>>;
}

/** The Claude config folder a Windows chat's agent reads (the throwaway home under test, as the agent gets it). */
export function chatConfigDir(c: Connection): string {
  return claudeConfigDir({ ...Deno.env.toObject(), ...testHomeEnv(c.command), ...(c.env ?? {}) });
}

/**
 * Under test, a fixture agent (or no real agent allowed at all): it writes no registry, and its config folder would be the owner's
 * own ~/.claude, so nothing is watched or read for it.
 */
function fixtureUnderTest(command: string[]): boolean {
  if (Deno.env.get('AGENT_STUDIO_TEST') !== '1') return false;
  const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
  return !realAllowed || isFixture(command);
}

function watched(c: Connection): boolean {
  return CLAUDE_PROVIDERS.has(c.provider) && !c.closed && c.ready && !!c.sessionId && !c.replaying && !c.rebuildError &&
    !fixtureUnderTest(c.command);
}

export class Handoff {
  readonly host: HandoffHost;
  #watchers = new Map<string, Deno.FsWatcher>();
  #rescan: ReturnType<typeof setInterval> | null = null;
  #pending: ReturnType<typeof setInterval> | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #scanning = false;
  #closed = false;

  constructor(host: HandoffHost) {
    this.host = host;
  }

  /** Start or stop the watchers for the chats open now. Studio calls it when a chat opens or closes; cheap to call often. */
  refresh(): void {
    if (this.#closed) return;
    const dirs = new Set<string>();
    let wsl = false;
    for (const c of this.host.connections()) {
      if (!CLAUDE_PROVIDERS.has(c.provider) || c.closed || fixtureUnderTest(c.command)) continue;
      if (c.wsl) wsl = true;
      else dirs.add(sessionsDir(chatConfigDir(c)));
    }
    for (const [dir, watcher] of [...this.#watchers]) {
      if (dirs.has(dir)) continue;
      this.#watchers.delete(dir);
      try {
        watcher.close();
      } catch { /* closed */ }
    }
    for (const dir of dirs) if (!this.#watchers.has(dir)) this.#watch(dir);
    // the backup beat runs only while a Claude chat is open: it follows the open chats (a folder that appeared is watched) and checks
    if (dirs.size || wsl) {
      if (this.#rescan === null) {
        const timer = setInterval(() => {
          this.refresh();
          this.poke(true);
        }, RESCAN_MS);
        Deno.unrefTimer(timer);
        this.#rescan = timer;
      }
    } else if (this.#rescan !== null) {
      clearInterval(this.#rescan);
      this.#rescan = null;
    }
  }

  /** A saved conversation's holder other than this AIB (Windows: the default Claude config folder AIB's agents get); null: none. */
  savedHolder(provider: string, sessionId: string): Holder | null {
    if (!CLAUDE_PROVIDERS.has(provider) || !WIN || fixtureUnderTest([provider])) return null;
    const dir = claudeConfigDir({ ...Deno.env.toObject(), ...testHomeEnv([provider]) });
    const records = liveRecords(dir);
    if (!records.some((r) => r.sessionId === sessionId)) return null;
    return holderOf(records, sessionId, this.#ownPids(true));
  }

  #watch(dir: string): void {
    // never made here (read-only: Claude Code makes it on its first run); a folder that is not there yet is watched from the next
    // backup beat after it appears
    try {
      if (!Deno.statSync(dir).isDirectory) return;
    } catch {
      return;
    }
    let watcher: Deno.FsWatcher;
    try {
      watcher = Deno.watchFs(dir, { recursive: false });
    } catch (error) {
      log.info(
        'handoff: cannot watch %s (%s); the %s s rescan covers it',
        dir,
        error instanceof Error ? error.message : error,
        RESCAN_MS / 1000,
      );
      return;
    }
    this.#watchers.set(dir, watcher);
    void (async () => {
      try {
        for await (const _ of watcher) this.poke();
      } catch { /* closed */ }
    })();
  }

  /** Something changed (or the backup beat): scan soon, once. */
  poke(withWsl = false): void {
    if (this.#closed) return;
    if (withWsl) void this.#scanWsl().catch((error) => log.exception(error, 'handoff: WSL scan failed'));
    if (this.#debounce !== null) return;
    const timer = setTimeout(() => {
      this.#debounce = null;
      void this.scan().catch((error) => log.exception(error, 'handoff: scan failed'));
    }, DEBOUNCE_MS);
    Deno.unrefTimer(timer);
    this.#debounce = timer;
  }

  /** AIB's own agent processes: every Windows chat's adapter and everything below it (claude.exe, its tools). */
  #ownPids(fresh: boolean): Set<number> {
    if (fresh) refreshDescendants();
    const own = new Set<number>([Deno.pid]);
    for (const c of this.host.connections()) {
      const pid = c.process?.pid;
      if (c.wsl || !pid) continue;
      own.add(pid);
      for (const d of descendants(pid) ?? []) own.add(d.pid);
    }
    return own;
  }

  /** The holder of a Windows chat's session other than AIB, from records read now; checked twice against a fresh process list. */
  #windowsHolder(c: Connection, records: SessionRecord[]): Holder | null {
    if (!records.some((r) => r.sessionId === c.sessionId)) return null;
    const own = (fresh: boolean) => {
      const pids = this.#ownPids(fresh);
      for (const pid of c.overriddenHolders) pids.add(pid); // Open here anyway was chosen over these
      return pids;
    };
    let holder = holderOf(records, c.sessionId!, own(false));
    // claude.exe writes its record as it starts: a process list a second old may not have it yet, so look again with a fresh one
    if (holder) holder = holderOf(records, c.sessionId!, own(true));
    return holder;
  }

  /** Who else holds this chat's session now (null: nobody, or AIB cannot tell). Used when the person comes back. */
  async holderNow(c: Connection): Promise<Holder | null> {
    if (!CLAUDE_PROVIDERS.has(c.provider) || !c.sessionId) return null;
    if (c.wsl) {
      if (!this.host.wslHeld) return null;
      const held = await this.host.wslHeld(c.wsl.distro, [c.sessionId], this.#wslChatPids(c.wsl.distro));
      return held[c.sessionId] ?? null;
    }
    return this.#windowsHolder(c, liveRecords(chatConfigDir(c)));
  }

  #wslChatPids(distro: string): number[] {
    return [...this.host.connections()].filter((c) => !c.closed && c.wsl?.distro === distro && c.process).map((c) => c.process!.pid);
  }

  /** One pass over the Windows chats: hand off the ones another app holds, retry the ones waiting for their turn to end. */
  async scan(): Promise<void> {
    if (this.#closed || this.#scanning) return;
    this.#scanning = true;
    try {
      const byDir = new Map<string, SessionRecord[]>();
      for (const c of [...this.host.connections()]) {
        if (!watched(c) || c.wsl) continue;
        if (c.elsewhere) {
          if (!c.elsewhere.released) await c.tryRelease();
          continue;
        }
        const dir = chatConfigDir(c);
        let records = byDir.get(dir);
        if (!records) byDir.set(dir, records = liveRecords(dir));
        const holder = this.#windowsHolder(c, records);
        if (holder) {
          log.info('handoff: chat %s (%s) is open in %s (pid %s, %s)', c.id, c.sessionId, holder.app, holder.pid, holder.entrypoint || '?');
          c.handOff(holder);
        }
      }
    } finally {
      this.#scanning = false;
      this.#armPending();
    }
  }

  /** WSL chats: their distro's helper reads the registry there (Windows cannot check a Linux pid). */
  async #scanWsl(): Promise<void> {
    if (!this.host.wslHeld) return;
    const byDistro = new Map<string, Connection[]>();
    for (const c of this.host.connections()) {
      if (!watched(c) || !c.wsl) continue;
      if (c.elsewhere) {
        if (!c.elsewhere.released) await c.tryRelease();
        continue;
      }
      const list = byDistro.get(c.wsl.distro) ?? [];
      list.push(c);
      byDistro.set(c.wsl.distro, list);
    }
    for (const [distro, chats] of byDistro) {
      const held = await this.host.wslHeld(distro, chats.map((c) => c.sessionId!), this.#wslChatPids(distro));
      for (const c of chats) {
        const holder = held[c.sessionId!];
        if (holder && !c.closed && !c.elsewhere) {
          log.info('handoff: WSL chat %s (%s) is open in %s (pid %s)', c.id, c.sessionId, holder.app, holder.pid);
          c.handOff(holder);
        }
      }
    }
    this.#armPending();
  }

  /** While a chat waits to let go, look again every second (its turn's end also tries at once). */
  #armPending(): void {
    const waiting = [...this.host.connections()].some((c) => !c.closed && c.elsewhere && !c.elsewhere.released);
    if (waiting && this.#pending === null && !this.#closed) {
      const timer = setInterval(() => {
        const still = [...this.host.connections()].some((c) => !c.closed && c.elsewhere && !c.elsewhere.released);
        if (!still) {
          clearInterval(timer);
          this.#pending = null;
          return;
        }
        for (const c of this.host.connections()) {
          if (!c.closed && c.elsewhere && !c.elsewhere.released) void c.tryRelease();
        }
      }, PENDING_MS);
      Deno.unrefTimer(timer);
      this.#pending = timer;
    }
  }

  close(): void {
    this.#closed = true;
    for (const watcher of this.#watchers.values()) {
      try {
        watcher.close();
      } catch { /* closed */ }
    }
    this.#watchers.clear();
    for (const t of [this.#rescan, this.#pending]) if (t !== null) clearInterval(t);
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#rescan = this.#pending = this.#debounce = null;
  }
}
