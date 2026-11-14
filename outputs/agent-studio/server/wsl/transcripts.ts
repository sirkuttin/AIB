/**
 * Saved chats of WSL projects (docs/wsl/design.md section 11, item 5): a chat that ended in a distro must still be listed after an AIB
 * restart, and reopening it resumes it there (Studio.connect with the ref and the session id: session/load runs in the distro).
 *
 * The transcripts are inside the distro (`~/.claude/projects`, `~/.codex`), so the helper reads them with transcripts/store.ts natively
 * and answers the same items Store.sessions() gives on Windows. That helper method is not in contract.ts yet; it is proposed as:
 *   'transcripts.sessions': { params: { provider: 'claude' | 'codex' }; result: { sessions: Record<string, unknown>[] } }
 * Until a helper lists it, nothing is added. Given the user's WSL project refs, a session whose folder is none of them is left out.
 */
import type { WslHost } from './contract.ts';
import { distroName, wsl2Distros, wslHost } from './access.ts';
import { refOf } from '../platform/location.ts';

type Dict = Record<string, unknown>;

export const WSL_SESSION_PROVIDERS = ['claude', 'codex'] as const;
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/** `wsl.<distro>.<provider>/<key>`: never collides with the Windows catalog's `claude/...` and `omp/...` keys. */
export function wslSessionKey(distro: string, provider: string, key: string): string {
  return `wsl.${distro.toLowerCase()}.${provider}/${key}`;
}

/** One distro's saved sessions, their folders as refs; [] when the helper cannot list them. */
export async function distroSessions(host: WslHost, distro: string, projects: ReadonlySet<string> | null = null): Promise<Dict[]> {
  const out: Dict[] = [];
  const call = host.call.bind(host) as unknown as (method: string, params: Dict, opts?: { timeoutMs?: number }) => Promise<{ sessions?: Dict[] }>;
  for (const provider of WSL_SESSION_PROVIDERS) {
    let listed: Dict[];
    try {
      listed = (await call('transcripts.sessions', { provider }, { timeoutMs: 10_000 })).sessions ?? [];
    } catch {
      continue; // a helper without the method (it throws), or a read that failed: nothing from this provider
    }
    for (const item of listed) {
      const cwd = typeof item.cwd === 'string' && item.cwd.startsWith('/') ? refOf({ kind: 'wsl', distro, linuxPath: item.cwd }) : '';
      if (!cwd || (projects && !projects.has(cwd))) continue;
      out.push({
        ...item,
        cwd,
        projectRoot: cwd,
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
      const host = wslHost(d.name);
      if (host && host.state === 'ready') out.push(...await distroSessions(host, d.name.toLowerCase(), projects));
    }
  } catch { /* none */ }
  return out;
}
