/**
 * Per-project tool servers, the part both the agent host (a chat's launch) and the web server (Settings, the composer chip) use: the
 * servers the agents' own config files name for a folder (read only), the project's choice (store.ts), what a chat of the project is
 * launched with, and the view the page draws. Design: aib-shared/designs/tool-servers/ (prototype.html, research.md, probe.md).
 */
import { AGENT_NAMES, type AgentId, discoverServers, diskFiles, type FoundServer, hostEnv } from './discover.ts';
import { type Choice, type Effective, effective, effectiveHash, serverOn, ToolServersStore, toolsOff } from './store.ts';
import { REACH, REACH_WSL } from './apply.ts';
import { testHomeEnv } from '../acp/launch_env.ts';
import { projectKey } from '../desktop/project_delete.ts';
import { wslLocOf } from '../platform/location.ts';
import { NEW_TOOLS } from '../allow/own_tools.ts';

/** Reads the servers of a WSL project's distro through its helper (null: it can't be read now). */
export type WslDiscover = (distro: string, linuxPath: string) => Promise<FoundServer[] | null>;

export interface ToolRow {
  name: string;
  on: boolean;
}
export interface ServerRow {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  fromText: string;
  agents: string[];
  on: boolean;
  locked: boolean;
  /** Tool names AIB has seen this server offer (empty: none seen yet). */
  tools: ToolRow[];
  /** When the tool list was last seen (ms), 0: never. */
  toolsAt: number;
  memory: { procs: number; mb: number; measured: boolean; at: number };
}
export interface View {
  project: string;
  path: string;
  wsl: boolean;
  servers: ServerRow[];
  summary: { procs: number; mb: number; allProcs: number; allMb: number; estimate: boolean };
  reach: typeof REACH;
  /** Open chats of the project that still run an older list (they restart when idle). Ids from the `chats` the page passed. */
  stale: string[];
  /** The rule a new project starts with, as the New projects page shows it. */
  rule: { offLocal: boolean };
}

/** What one local server is guessed to cost per chat before a run measured it (labelled "estimate" on the page). */
export const ESTIMATE = { procs: 1, mb: 60 };
const SEEN_TTL_MS = 15_000;

/**
 * The environment the agents' own folders are found from. Production: the process's own. Under test (AGENT_STUDIO_TEST=1) the throwaway
 * home a real agent gets (acp/launch_env.ts testHomeEnv) and none of the per-agent folder variables, so a test never reads the owner's
 * ~/.claude, ~/.codex, ~/.gemini, ~/.qwen or ~/.copilot; a test that wants servers writes its config into that home.
 */
export function discoveryEnv(): Record<string, string> {
  const env = Deno.env.toObject();
  if (env.AGENT_STUDIO_TEST !== '1') return env;
  for (const name of ['GEMINI_CLI_HOME', 'QWEN_HOME', 'COPILOT_HOME', 'QWEN_CODE_SYSTEM_SETTINGS_PATH']) delete env[name];
  return { ...env, ...testHomeEnv([Deno.execPath()]) };
}

export class ToolServers {
  readonly store: ToolServersStore;
  readonly #cache = new Map<string, { at: number; found: FoundServer[] }>();

  constructor(
    stateDir: string,
    private readonly opts: { wsl?: WslDiscover; wslCanWrite?: (distro: string) => boolean; servedHash?: (chatId: string) => string | null } = {},
  ) {
    this.store = new ToolServersStore(stateDir);
  }

  /** The servers the agents' config files name for this project folder (a path or a WSL ref); cached a few seconds. Never throws. */
  async discover(path: string): Promise<FoundServer[]> {
    const hit = this.#cache.get(path);
    if (hit && Date.now() - hit.at < SEEN_TTL_MS) return hit.found;
    let found: FoundServer[] = [];
    try {
      const wsl = wslLocOf(path);
      if (wsl) {
        const read = await this.opts.wsl?.(wsl.distro, wsl.linuxPath);
        if (!read) return []; // the distro's helper could not answer now: nothing is cached, nothing is switched off
        found = read;
      } else found = discoverServers(diskFiles, hostEnv(path, discoveryEnv()));
    } catch { /* an unreadable config lists nothing */ }
    this.#cache.set(path, { at: Date.now(), found });
    return found;
  }

  /**
   * The hash of what a chat of this project would be launched with now, synchronously (the stale check runs in a timer and before a
   * send). A Windows project's files are read here; a WSL project's answer is the last one its helper gave (null before that).
   */
  hashFor(path: string): string | null {
    const key = this.keyOf(path);
    if (!key) return null;
    let found = this.#cache.get(path);
    if (!found || Date.now() - found.at >= SEEN_TTL_MS) {
      if (wslLocOf(path)) return found ? effectiveHash(effective(this.store.choice(key), found.found)) : null;
      try {
        found = { at: Date.now(), found: discoverServers(diskFiles, hostEnv(path, discoveryEnv())) };
      } catch {
        return null;
      }
      this.#cache.set(path, found);
    }
    return effectiveHash(effective(this.store.choice(key), found.found));
  }

  forget(): void {
    this.#cache.clear();
  }

  /** The key of a project folder in this store (the page's own project key). */
  keyOf(path: string): string {
    return path === '_new' ? '_new' : projectKey(path);
  }

  /** What a chat opened in this project is launched with: the switches that are off (empty: nothing to add). */
  async launch(path: string): Promise<{ key: string; found: FoundServer[]; effective: Effective; hash: string }> {
    const key = this.keyOf(path);
    const found = await this.discover(path);
    const e = effective(key ? this.store.choice(key) : null, found);
    return { key, found, effective: e, hash: effectiveHash(e) };
  }

  /** A project that is new gets the New projects list as its own, once (called before the folder is added as a project). */
  seedIfNew(path: string, known: boolean): void {
    const key = this.keyOf(path);
    if (!known && key) this.store.seedProject(key);
  }

  async view(path: string, chats: string[] = []): Promise<View> {
    const isNew = path === '_new';
    const key = this.keyOf(path);
    const wsl = !isNew && !!wslLocOf(path);
    const found = await this.discover(isNew ? hostEnv('', discoveryEnv()).home : path);
    const choice: Choice | null = isNew ? this.store.newProjects() : this.store.choice(key);
    const servers: ServerRow[] = [
      {
        id: 'studio_artifact',
        name: 'AIB tools',
        kind: 'local',
        fromText: 'AIB · docs, artifacts, drawings, helpers',
        agents: ['Every agent'],
        on: true,
        locked: true,
        tools: [...NEW_TOOLS].map((name) => ({ name, on: true })),
        toolsAt: 0,
        memory: { procs: 0, mb: 0, measured: true, at: 0 },
      },
    ];
    let procs = 0, mb = 0, allProcs = 0, allMb = 0, estimate = false;
    for (const s of found) {
      const on = serverOn(choice, s);
      const seen = this.store.seen(s.id);
      const off = new Set(toolsOff(choice, s.id));
      const names = [...new Set([...(seen?.tools ?? []), ...off])].sort();
      const m = this.store.memory(s.id);
      const memory = s.kind === 'remote'
        ? { procs: 0, mb: 0, measured: true, at: 0 }
        : m
        ? { procs: m.procs, mb: m.mb, measured: true, at: m.at }
        : { ...ESTIMATE, measured: false, at: 0 };
      servers.push({
        id: s.id,
        name: s.id,
        kind: s.kind,
        fromText: s.fromText,
        agents: s.agents.map((a: AgentId) => AGENT_NAMES[a]),
        on,
        locked: false,
        tools: names.map((name) => ({ name, on: !off.has(name) })),
        toolsAt: seen?.at ?? 0,
        memory,
      });
      allProcs += memory.procs;
      allMb += memory.mb;
      if (on) {
        procs += memory.procs;
        mb += memory.mb;
      }
      if (s.kind === 'local' && !memory.measured) estimate = true;
    }
    const hash = effectiveHash(effective(choice, found));
    const stale = isNew || !this.opts.servedHash ? [] : chats.filter((id) => {
      const had = this.opts.servedHash!(id);
      return had !== null && had !== hash;
    });
    return {
      project: key,
      path,
      wsl,
      servers,
      summary: { procs, mb, allProcs, allMb, estimate },
      reach: wsl && !this.opts.wslCanWrite?.(wslLocOf(path)!.distro) ? REACH_WSL : REACH,
      stale,
      rule: { offLocal: !!choice?.offLocal },
    };
  }
}
