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
import { distroName, hostWhenReady, notReady, peekWslHost, wsl2Distros, wslTestHomeEnv } from './access.ts';
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
  for (const provider of WSL_SESSION_PROVIDERS) {
    let listed: Dict[];
    try {
      listed = (await host.call('transcripts.sessions', { provider, ...dirs }, { timeoutMs: 10_000 })).sessions ?? [];
    } catch {
      continue; // a helper without the method (it throws), or a read that failed: nothing from this provider
    }
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

/** {distro, provider, key} of a wslSessionKey, or null for any other key. */
export function parseWslSessionKey(key: unknown): { distro: string; provider: 'claude' | 'codex'; key: string } | null {
  const match = typeof key === 'string' ? /^wsl\.([a-z0-9._-]{1,64})\.(claude|codex)\/(.+)$/s.exec(key) : null;
  return match ? { distro: match[1], provider: match[2] as 'claude' | 'codex', key: match[3] } : null;
}

/** Under test: the folder the helper reads Claude Code's task output from (inside AIB_WSL_ROOT, never the distro's /tmp). */
function testTempDir(): Record<string, string> {
  const test = wslTestHomeEnv();
  return test.HOME ? { tempDir: test.HOME.replace(/\/home$/, '') + '/tmp' } : {};
}

/**
 * The background-task reads of a WSL session (/api/agents, /api/commands, /api/command): the helper runs monitor.ts handleGet on the
 * transcripts in the distro (`transcripts.query`), and the store keys in its answer (the agents' `key`, the commands' `id` and
 * `agentKey`) become WSL session keys, so the page reads a subagent's history and a command's output through here again. Polled, so a
 * distro that is not running is never started for it: then, or with a helper that lacks the method, /api/agents answers no subagents
 * and `unavailable` (the line the user sees), and /api/commands and /api/command a 400 with that line, which the page shows as
 * "Command updates unavailable: …" instead of claiming that nothing runs.
 */
async function wslTaskGet(
  path: '/api/agents' | '/api/commands' | '/api/command',
  wsl: { distro: string; provider: 'claude' | 'codex'; key: string },
  args: Map<string, string[]>,
): Promise<{ status: number; body: unknown }> {
  const prefix = wslSessionKey(wsl.distro, wsl.provider, '');
  const unavailable = (why: string) =>
    path === '/api/agents'
      ? { status: 200, body: { agents: [], now: Date.now() / 1000, unavailable: why } }
      : { status: 400, body: { error: why, code: 'wsl_unavailable' } };
  const passed: Record<string, string> = {};
  const running = args.get('running')?.[0];
  if (running) passed.running = running;
  if (path === '/api/command') {
    const id = args.get('id')?.[0] ?? '';
    if (!id.startsWith(prefix)) return { status: 400, body: { error: 'Unknown background command' } };
    passed.id = id.slice(prefix.length);
  }
  const host = peekWslHost(wsl.distro);
  const why = notReady(host, wsl.distro);
  if (why) return unavailable(why);
  let reply: { status: number; body: unknown };
  try {
    const test = wslTestHomeEnv();
    reply = await host!.call('transcripts.query', {
      provider: wsl.provider,
      path,
      key: wsl.key,
      args: passed,
      ...(test.CLAUDE_CONFIG_DIR ? { claudeDir: test.CLAUDE_CONFIG_DIR } : {}),
      ...testTempDir(),
    }, { timeoutMs: 20_000 });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const body = reply.body as Dict;
  if (reply.status !== 200 || !body || typeof body !== 'object') return reply;
  const keyed = (value: unknown) => (typeof value === 'string' && value ? prefix + value : value);
  if (Array.isArray(body.agents)) body.agents = (body.agents as Dict[]).map((a) => ({ ...a, key: keyed(a.key) }));
  const task = (t: Dict) => ({ ...t, id: keyed(t.id), agentKey: keyed(t.agentKey) });
  if (Array.isArray(body.commands)) body.commands = (body.commands as Dict[]).map(task);
  if (path === '/api/command') return { status: 200, body: task(body) };
  return { status: 200, body };
}

/**
 * The viewer's GET for a saved WSL session (the page reads its history as for any saved chat): /api/transcript is answered by the
 * distro's helper (the distro is started for it), the background-task reads by wslTaskGet. null when the key is not a WSL one.
 */
export async function wslTranscriptGet(path: string, args: Map<string, string[]>): Promise<{ status: number; body: unknown } | null> {
  const key = args.get(path === '/api/transcript' ? 'key' : 'session')?.[0];
  const wsl = parseWslSessionKey(key);
  if (!wsl) return null;
  if (path === '/api/agents' || path === '/api/commands' || path === '/api/command') return await wslTaskGet(path, wsl, args);
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
