/**
 * Open elsewhere: AIB lets go of a Claude Code chat that another app opened (aib-shared/designs/open-elsewhere/research.md, section 5).
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
 * Codex chats (codex_threads.ts): Codex lets one process write a thread and refuses a second opener without leaving a trace, so
 * the sign AIB can see is a Codex CLI process whose command line names the thread (`codex resume <id>`: the TUI waits on its "open in
 * another app, r to retry" card), found on the same 10 s beat (one process snapshot, command lines of codex/node processes only).
 * Letting go is the same session/close (codex-acp: thread/unsubscribe; AIB gives Codex thread_unload_delay_secs = 0, so the thread
 * unloads and its writer lock goes at once and the other app's Retry works). Coming back: the CLI process still there, or the
 * thread's writer lock held by someone (read without locking), means still held; Codex never lets two apps write, so there is no
 * Open here anyway, only Open here again once it is closed there. VS Code's and Codex Desktop's Codex start `codex app-server`,
 * which names no thread: AIB cannot see which chat they want. So, on the same beat, a `codex app-server` that is new (pid and start
 * time not seen since AIB first looked: ones already running then, like a Codex Desktop open all day, are only noted) and was started by VS Code or Codex Desktop (codex_apps.ts: not AIB's own, not a terminal's) makes AIB let go
 * of every IDLE Codex chat (Connection.letGoIdle: a working chat, helpers, shells or an open question are never touched), once per
 * process. WSL Codex chats are checked inside their distro by its helper (`codex.scan`: ps, /proc/locks), the same way, which also
 * covers VS Code Remote-WSL (its extension host and the extension's folder show in the distro's process list).
 *
 * Never throws out of a timer; costs one readdir and a few small reads per scan, and nothing while no Claude or Codex chat is open.
 */
import { isClaudeFamily, isCodexFamily } from '../agents/claude_family.ts';
import type { Connection } from '../acp/connection.ts';
import { isFixture, testHomeEnv } from '../acp/connection.ts';
import { getLogger } from '../core/log.ts';
import { descendants, refreshDescendants } from '../platform/descendants.ts';
import { claudeConfigDir } from '../subagents/claude_config.ts';
import { WIN } from '../platform/ospath.ts';
import { type Holder, holderOf, liveRecords, type SessionRecord, sessionsDir } from './claude_sessions.ts';
import { cliHolder, type CodexProcess, writerLockPath, writerLockState } from './codex_threads.ts';
import { type AppServer, appServerLine, appServers, appServerWho, processTable } from './codex_apps.ts';
import { codexHome } from '../subagents/codex.ts';

const log = getLogger('handoff');

/** The backup beat (10 s). Test runs (AGENT_STUDIO_TEST=1) may shorten it with AIB_TEST_RESCAN_MS. */
export const RESCAN_MS = (() => {
  try {
    const test = Deno.env.get('AGENT_STUDIO_TEST') === '1' ? Number(Deno.env.get('AIB_TEST_RESCAN_MS')) : NaN;
    if (Number.isFinite(test) && test >= 200) return test;
  } catch { /* no env access */ }
  return 10_000;
})();
export const DEBOUNCE_MS = 300;
/** While a chat waits for its turn (or helpers) to end before it lets go: how often it looks again. */
export const PENDING_MS = 1_000;

/** Providers whose agent is Claude Code (they write the registry). */
const CLAUDE_PROVIDERS = { has: (p: string) => isClaudeFamily(p) };
/** Providers whose agent is Codex (one writer per thread: codex_threads.ts). */
const CODEX_PROVIDERS = { has: (p: string) => isCodexFamily(p) };

const isCodex = (c: Connection) => CODEX_PROVIDERS.has(c.provider);

export interface HandoffHost {
  connections(): Iterable<Connection>;
  /** WSL: who else holds these sessions in the distro (its helper's answer); {} when it cannot tell. */
  wslHeld?(distro: string, sessionIds: string[], chatPids: number[]): Promise<Record<string, Holder>>;
  /** WSL Codex: the distro's helper's answer (codex.scan); null when it cannot tell. */
  wslCodex?(distro: string, sessionIds: string[], chatPids: number[], codexHome?: string): Promise<WslCodexScan | null>;
  /** A model-server Codex entry's own CODEX_HOME on this PC (`codex@strata`: <data folder>/codex-home/strata); null for plain Codex. */
  codexHomeOf?(provider: string): string | null;
}

/** What the distro's helper sees for Codex chats: a CLI naming a thread, a thread's writer lock held, and the app-servers there. */
export interface WslCodexScan {
  cli: Record<string, Holder>;
  locked: Record<string, Holder>;
  appServers: AppServer[];
}

/** The Claude config folder a Windows chat's agent reads (the throwaway home under test, as the agent gets it). */
export function chatConfigDir(c: Connection): string {
  return claudeConfigDir({ ...Deno.env.toObject(), ...testHomeEnv(c.command), ...(c.env ?? {}) });
}

/** The Codex home a Windows Codex chat's agent uses (CODEX_HOME, else ~/.codex; the throwaway home under test). */
export function chatCodexHome(c: Connection): string {
  return codexHome({ ...Deno.env.toObject(), ...testHomeEnv(c.command), ...(c.env ?? {}) });
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
  return (CLAUDE_PROVIDERS.has(c.provider) || isCodex(c)) && !c.closed && c.ready && !!c.sessionId && !c.replaying && !c.rebuildError &&
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

  /** Start or stop the watchers for the chats open now. AIB calls it when a chat opens or closes; cheap to call often. */
  refresh(): void {
    if (this.#closed) return;
    const dirs = new Set<string>();
    let wsl = false;
    let codex = false;
    for (const c of this.host.connections()) {
      if (isCodex(c) && !c.closed && !fixtureUnderTest(c.command)) { // no folder to watch: the beat looks
        if (c.wsl) wsl = true;
        else codex = true;
      }
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
    // the backup beat runs only while a Claude or Codex chat is open: it follows the open chats (a folder that appeared is watched)
    // and checks
    if (dirs.size || wsl || codex) {
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
    if (CODEX_PROVIDERS.has(provider)) return this.#savedCodexHolder(sessionId, this.host.codexHomeOf?.(provider) ?? null);
    if (!CLAUDE_PROVIDERS.has(provider) || !WIN || fixtureUnderTest([provider])) return null;
    const dir = claudeConfigDir({ ...Deno.env.toObject(), ...testHomeEnv([provider]) });
    const records = liveRecords(dir);
    if (!records.some((r) => r.sessionId === sessionId)) return null;
    return holderOf(records, sessionId, this.#ownPids(true));
  }

  /**
   * A saved Codex thread another app has open (the default Codex home AIB's agents get): a Codex CLI naming it, or its writer lock
   * held (AIB holds no saved conversation: the probe asks only for those). Codex would refuse to open it here.
   */
  #savedCodexHolder(threadId: string, entryHome: string | null = null): Holder | null {
    if (fixtureUnderTest(['codex'])) return null;
    const cli = cliHolder(this.#codexProcesses(), threadId, this.#ownPids(true));
    if (cli) return cli;
    const home = entryHome ?? codexHome({ ...Deno.env.toObject(), ...testHomeEnv(['codex']) });
    const lock = writerLockState(writerLockPath(home, threadId));
    return lock.state === 'held' ? { pid: lock.pid, entrypoint: 'codex-writer-lock', status: '', app: 'another app' } : null;
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

  #codexSnapshot: { at: number; procs: CodexProcess[] } | null = null;

  /**
   * Codex processes now ([] when the list cannot be read: no sign is no hand-off, never a wrong one). One snapshot serves for a
   * second (the probe asking about several saved chats); `fresh` (the person came back: a CLI that just quit must not count) reads
   * the list again.
   */
  #codexProcesses(fresh = false): CodexProcess[] {
    const now = Date.now();
    if (!fresh && this.#codexSnapshot && now - this.#codexSnapshot.at < 1000) return this.#codexSnapshot.procs;
    let procs: CodexProcess[] = [];
    try {
      procs = processTable();
    } catch (error) {
      log.info('handoff: cannot list Codex processes (%s)', error instanceof Error ? error.message : error);
    }
    this.#codexSnapshot = { at: now, procs };
    return procs;
  }

  /** A Codex CLI process outside AIB whose command line names this chat's thread; checked twice against a fresh process list. */
  #codexCliHolder(c: Connection, procs: CodexProcess[]): Holder | null {
    let holder = cliHolder(procs, c.sessionId!, this.#ownPids(false));
    if (holder) holder = cliHolder(procs, c.sessionId!, this.#ownPids(true)); // a CLI the agent started a moment ago is AIB's own
    return holder;
  }

  /**
   * Who else has a Codex chat's thread now: a Codex CLI naming it, or (AIB let go of it, so its own app-server unloaded it) a held
   * writer lock: another app writes it. Null: nobody, or AIB cannot tell (its own session/load then meets Codex's refusal).
   */
  async #codexHolderNow(c: Connection): Promise<Holder | null> {
    if (c.wsl) {
      // inside the distro: its helper reads the process list and /proc/locks (codex.scan)
      const found = await this.host.wslCodex?.(c.wsl.distro, [c.sessionId!], this.#wslChatPids(c.wsl.distro), c.env?.CODEX_HOME);
      return found?.cli[c.sessionId!] ?? (c.elsewhere?.released ? found?.locked[c.sessionId!] : null) ?? null;
    }
    const cli = this.#codexCliHolder(c, this.#codexProcesses(true));
    if (cli) return cli;
    if (!c.elsewhere?.released) return null;
    const lock = writerLockState(writerLockPath(chatCodexHome(c), c.sessionId!));
    return lock.state === 'held' ? { pid: lock.pid, entrypoint: 'codex-writer-lock', status: '', app: 'another app' } : null;
  }

  /** Who else holds this chat's session now (null: nobody, or AIB cannot tell). Used when the person comes back. */
  async holderNow(c: Connection): Promise<Holder | null> {
    if (isCodex(c) && c.sessionId) return await this.#codexHolderNow(c);
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
      let procs: CodexProcess[] | null = null;
      const appChats: Connection[] = [];
      for (const c of [...this.host.connections()]) {
        if (!watched(c) || c.wsl) continue;
        if (c.elsewhere) {
          if (!c.elsewhere.released) await c.tryRelease();
          continue;
        }
        if (isCodex(c)) {
          procs ??= this.#codexProcesses(true);
          const holder = this.#codexCliHolder(c, procs);
          if (holder) {
            log.info('handoff: Codex chat %s (%s) is open in %s (pid %s)', c.id, c.sessionId, holder.app, holder.pid);
            c.handOff(holder);
          } else appChats.push(c);
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
      // the same beat, the same process list: a VS Code / Codex Desktop app-server that is new lets go of the idle Codex chats
      if (procs && appChats.length) await this.#appServerLetGo('this PC', appServers(procs, this.#ownPids(true)), appChats);
    } finally {
      this.#scanning = false;
      this.#armPending();
    }
  }

  /** WSL chats: their distro's helper reads the registry (Claude) or the processes and locks (Codex) there (Windows cannot check a Linux pid). */
  async #scanWsl(): Promise<void> {
    const byDistro = new Map<string, Connection[]>();
    const codexByDistro = new Map<string, Connection[]>();
    for (const c of this.host.connections()) {
      if (!watched(c) || !c.wsl) continue;
      if (c.elsewhere) {
        if (!c.elsewhere.released) await c.tryRelease();
        continue;
      }
      // a model-server Codex entry has its own CODEX_HOME in the distro: its writer locks are looked up there
      const key = isCodex(c) ? `${c.wsl.distro}|${c.env?.CODEX_HOME ?? ''}` : c.wsl.distro;
      const groups = isCodex(c) ? codexByDistro : byDistro;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    if (this.host.wslHeld) {
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
    }
    if (this.host.wslCodex) {
      for (const chats of codexByDistro.values()) {
        const distro = chats[0].wsl!.distro;
        const found = await this.host.wslCodex(distro, chats.map((c) => c.sessionId!), this.#wslChatPids(distro), chats[0].env?.CODEX_HOME);
        if (!found) continue; // the helper cannot tell (an older one): no sign is no hand-off
        const rest: Connection[] = [];
        for (const c of chats) {
          const holder = found.cli[c.sessionId!];
          if (c.closed || c.elsewhere) continue;
          if (holder) {
            log.info('handoff: WSL Codex chat %s (%s) is open in %s (pid %s)', c.id, c.sessionId, holder.app, holder.pid);
            c.handOff(holder);
          } else rest.push(c);
        }
        if (rest.length) await this.#appServerLetGo(`WSL ${distro}`, found.appServers, rest);
      }
    }
    this.#armPending();
  }

  /** App-servers already seen (scope:pid:start): each new foreign one acts once. */
  #seenAppServers = new Set<string>();
  /** Scopes (this PC, a distro) looked at once already: what ran then is noted, not acted on. */
  #baselined = new Set<string>();

  /**
   * A `codex app-server` of VS Code or Codex Desktop that AIB has not seen before (by pid and start time) lets go of every idle Codex
   * chat in `chats` (the same scope: this PC, or one distro). Working chats, chats with helpers, shells or an open question are left
   * alone (letGoIdle), and are not let go of later for the same process either. Never throws.
   */
  async #appServerLetGo(scope: string, servers: AppServer[], chats: Connection[]): Promise<void> {
    try {
      const prefix = `${scope}:`;
      const present = new Set<string>();
      const fresh: AppServer[] = [];
      for (const s of servers) {
        if (s.kind !== 'vscode' && s.kind !== 'desktop') continue;
        const key = `${prefix}${s.pid}:${s.start}`;
        present.add(key);
        if (!this.#seenAppServers.has(key)) {
          this.#seenAppServers.add(key);
          fresh.push(s);
        }
      }
      for (const key of [...this.#seenAppServers]) if (key.startsWith(prefix) && !present.has(key)) this.#seenAppServers.delete(key);
      // the first look at a scope only takes note of what already runs (Codex Desktop or VS Code are often open all day, long before
      // this chat): "appears" means after that
      if (!this.#baselined.has(scope)) {
        this.#baselined.add(scope);
        if (fresh.length) log.info('handoff: %s: %d Codex app-server(s) already running, noted', scope, fresh.length);
        return;
      }
      if (!fresh.length) return;
      const app = fresh[0].app;
      log.info('handoff: %s started a Codex app-server (pid %s, %s): letting go of idle Codex chats', app, fresh[0].pid, scope);
      for (const c of chats) {
        if (c.closed || c.elsewhere) continue;
        const holder: Holder = { pid: fresh[0].pid, entrypoint: 'codex-app-server', status: '', app: appServerWho(app) };
        const result = await c.letGoIdle(holder, appServerLine(app));
        log.info(
          'handoff: Codex chat %s (%s): %s',
          c.id,
          c.sessionId,
          result === 'released' ? 'let go' : result === 'busy' ? 'working, kept' : 'not let go',
        );
      }
    } catch (error) {
      log.exception(error, 'handoff: app-server check failed');
    }
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
