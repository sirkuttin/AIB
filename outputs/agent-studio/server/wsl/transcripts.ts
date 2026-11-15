/**
 * Saved chats of WSL projects (docs/wsl/design.md section 11, item 5): a chat that ended in a distro must still be listed after an AIB
 * restart, and reopening it resumes it there (Studio.connect with the ref and the session id: session/load runs in the distro).
 *
 * The transcripts are inside the distro (`~/.claude/projects`), so the helper reads them with transcripts/store.ts natively and answers
 * the same items Store.sessions() gives on Windows (`transcripts.sessions`); opening one reads its pages there too (`transcripts.read`,
 * the helper's own /api/transcript answer). A helper without the methods lists nothing. Given the user's WSL project refs, a session
 * whose project is none of them is left out (a chat that ran in a WSL worktree is filed under its project, as the helper's store says). Under test the helper is told the Claude folder inside AIB_WSL_ROOT (wslTestHomeEnv), so
 * a test never lists the owner's own sessions.
 */
import type { WslHost } from './contract.ts';
import { distroName, hostWhenReady, peekWslHost, wsl2Distros, wslTestHomeEnv } from './access.ts';
import { refOf } from '../platform/location.ts';

type Dict = Record<string, unknown>;

export const WSL_SESSION_PROVIDERS = ['claude', 'codex'] as const;
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/** `wsl.<distro>.<provider>/<key>`: never collides with the Windows catalog's `claude/...` and `omp/...` keys. */
export function wslSessionKey(distro: string, provider: string, key: string): string {
  return `wsl.${distro.toLowerCase()}.${provider}/${key}`;
}

/** `provider:sessionId` -> the session's folder (a ref), from the last listing: how a saved WSL chat finds its project for the Files tab. */
const cwdBySession = new Map<string, string>();

function rememberCwd(provider: string, item: Dict, cwd: string): void {
  const last = String(item.key ?? '').replace(/\.jsonl$/, '').split('/').pop() ?? '';
  for (const id of new Set([String(item.sessionId ?? ''), last, last.slice(last.lastIndexOf('_') + 1)])) {
    if (id) cwdBySession.set(`${provider}:${id}`, cwd);
  }
}

/** The folder (a ref) a saved WSL chat ran in, or '' when no listed session has that id. Lists the ready distros once when it is not known yet. */
export async function wslSessionCwd(provider: string, sessionId: string): Promise<string> {
  const id = `${provider}:${sessionId}`;
  if (!cwdBySession.has(id)) await wslSavedSessions();
  return cwdBySession.get(id) ?? '';
}

/** One distro's saved sessions, their folders as refs; [] when the helper cannot list them. */
export async function distroSessions(host: WslHost, distro: string, projects: ReadonlySet<string> | null = null): Promise<Dict[]> {
  const out: Dict[] = [];
  let dirs: { claudeDir?: string };
  try {
    const test = wslTestHomeEnv();
    dirs = test.CLAUDE_CONFIG_DIR ? { claudeDir: test.CLAUDE_CONFIG_DIR } : {};
  } catch {
    return out; // under test without AIB_WSL_ROOT: never the owner's sessions
  }
  // both providers at once: each call may take up to its 10 s time-out
  const lists = await Promise.all(WSL_SESSION_PROVIDERS.map(async (provider) => {
    try {
      return (await host.call('transcripts.sessions', { provider, ...dirs }, { timeoutMs: 10_000 })).sessions ?? [];
    } catch {
      return null; // a helper without the method (it throws), or a read that failed: nothing from this provider
    }
  }));
  for (const [i, provider] of WSL_SESSION_PROVIDERS.entries()) {
    const listed = lists[i];
    if (!listed) continue;
    for (const item of listed) {
      const cwd = typeof item.cwd === 'string' && item.cwd.startsWith('/') ? refOf({ kind: 'wsl', distro, linuxPath: item.cwd }) : '';
      // a chat that ran in its own worktree: the helper's store names its project (projectRoot, a Linux path) and branch
      const root = typeof item.projectRoot === 'string' && item.projectRoot.startsWith('/')
        ? refOf({ kind: 'wsl', distro, linuxPath: item.projectRoot })
        : cwd;
      if (!cwd || (projects && !projects.has(root))) continue;
      rememberCwd(provider, item, cwd);
      out.push({
        ...item,
        cwd,
        projectRoot: root,
        key: wslSessionKey(distro, provider, String(item.key ?? item.sessionId ?? '')),
        provider,
        providerName: NAMES[provider],
        wsl: { distro: distro.toLowerCase(), name: distroName(distro), linuxPath: item.cwd },
      });
    }
  }
  return out;
}

/** The saved sessions of every ready distro (a distro that is not running is not started for this). Never throws. */
export async function wslSavedSessions(projects: ReadonlySet<string> | null = null): Promise<Dict[]> {
  const out: Dict[] = [];
  try {
    for (const d of await wsl2Distros()) {
      const host = peekWslHost(d.name);
      if (host && host.state === 'ready') out.push(...await distroSessions(host, d.name.toLowerCase(), projects));
    }
  } catch { /* none */ }
  return out;
}

/** How long a poll's WSL session list is answered from the last listing without asking the helpers again. */
export const WSL_SESSIONS_FRESH_MS = 3_000;
let quick: { at: number; hosts: WslHost[]; value: Dict[] } | null = null;
let quickRun: Promise<Dict[]> | null = null;

/**
 * wslSavedSessions for the page's /api/sessions poll: one listing at a time (concurrent polls share it), a listing younger than
 * WSL_SESSIONS_FRESH_MS is reused, and an older one is answered at once while a fresh one is fetched for the next poll. Each helper
 * call may take up to 10 s per provider, and the poll must never wait for that once a list is known. Only the first poll waits.
 */
export async function wslSavedSessionsQuick(): Promise<Dict[]> {
  let hosts: WslHost[] = [];
  try {
    for (const d of await wsl2Distros()) {
      const host = peekWslHost(d.name);
      if (host && host.state === 'ready') hosts.push(host);
    }
  } catch {
    hosts = [];
  }
  if (!hosts.length) return [];
  const same = quick !== null && quick.hosts.length === hosts.length && quick.hosts.every((h, i) => h === hosts[i]);
  const refresh = () => {
    if (!quickRun) {
      const started = Date.now();
      quickRun = wslSavedSessions().then((value) => {
        quick = { at: started, hosts, value };
        return value;
      }).finally(() => (quickRun = null));
    }
    return quickRun;
  };
  if (same && quick) {
    if (Date.now() - quick.at >= WSL_SESSIONS_FRESH_MS) void refresh().catch(() => {});
    return quick.value.map((item) => ({ ...item }));
  }
  return (await refresh()).map((item) => ({ ...item }));
}

/** {distro, provider, key} of a wslSessionKey, or null for any other key. */
export function parseWslSessionKey(key: unknown): { distro: string; provider: 'claude' | 'codex'; key: string } | null {
  const match = typeof key === 'string' ? /^wsl\.([a-z0-9._-]{1,64})\.(claude|codex)\/(.+)$/s.exec(key) : null;
  return match ? { distro: match[1], provider: match[2] as 'claude' | 'codex', key: match[3] } : null;
}

/**
 * The viewer's GET for a saved WSL session (the page reads its history as for any saved chat): /api/transcript is answered by the
 * distro's helper; a WSL session lists no subagents or background commands in phase 1. null when the key is not a WSL one.
 */
export async function wslTranscriptGet(path: string, args: Map<string, string[]>): Promise<{ status: number; body: unknown } | null> {
  const key = args.get(path === '/api/transcript' ? 'key' : 'session')?.[0];
  const wsl = parseWslSessionKey(key);
  if (!wsl) return null;
  if (path === '/api/agents') return { status: 200, body: { agents: [], now: Date.now() / 1000 } };
  if (path === '/api/commands') return { status: 200, body: { commands: [], running: 0, total: 0 } };
  if (path !== '/api/transcript') return { status: 400, body: { error: 'Not available for WSL sessions yet' } };
  try {
    const test = wslTestHomeEnv();
    const host = await hostWhenReady(wsl.distro, 60_000);
    const passed: Record<string, string> = {};
    for (const [name, values] of args) if (name !== 'key' && values.length) passed[name] = values[0];
    return await host.call('transcripts.read', {
      provider: wsl.provider,
      key: wsl.key,
      args: passed,
      ...(test.CLAUDE_CONFIG_DIR ? { claudeDir: test.CLAUDE_CONFIG_DIR } : {}),
    }, { timeoutMs: 30_000 });
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}
