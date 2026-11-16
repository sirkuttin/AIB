/**
 * The ownership check of WSL chats (docs/WSL.md "Background tasks and ownership"). Before AIB continues a saved chat it asks whether
 * another agent process holds that session. A WSL chat's agent processes and transcripts are inside its distro, so the distro's helper
 * runs the Windows check natively (`ownership.check`, helper/bgtasks.ts) and AIB adds what only Windows has: the owner announcements
 * of other AIBs and clients (ownership/probe.ts OwnerRegistry). What "another agent owns this session" means in a distro:
 *
 * - strong (refused, the Windows message): a `claude` or `omp` process in the distro whose command line names the session id
 *   (`--resume <id>` / `--session-id <id>`), as ownership.ts findExternalOwner reads Windows command lines; or a live announcement.
 * - weak (asks first, "Another app may be using this conversation"): the transcript in the distro was written in the last two minutes by
 *   someone other than AIB, a process has it open, or a Claude Code process runs in the chat's folder while the transcript was written
 *   by someone other than AIB in the last 30 minutes (probe.ts QUIET_TRANSCRIPT_SECONDS).
 * - folder only (continues, with a note in the chat): a Claude Code process in the chat's folder is the only sign and the transcript has
 *   been quiet for 30 minutes (probe.ts folderOnlyEvidence; the same rule as for a Windows chat).
 * - never: AIB's own agents in that distro (every live pipe channel of this AIB's Linux keeper, and an agent's client terminals, with
 *   all their descendants) and the distro's AIB helper. A Claude Code of another AIB (another Windows data folder) does count.
 *
 * A helper that cannot answer (an older one without the method, or one that does not answer in time) leaves the check to the
 * registry alone, as a Windows check whose process list cannot be read does: never a refusal AIB cannot explain.
 */
import type { WslHost } from './contract.ts';
import { linkOf, wslTestHomeEnv } from './access.ts';
import { CLIENT_TERMINAL_PREFIX } from '../acp/keeper_terminal.ts';
import { type Assessment, type Reason, SUMMARIES, type Verdict } from '../ownership/probe.ts';

/** The pids of this AIB's own channels in a distro's Linux keeper that run an agent (live pipes, the agents' client terminals). */
export async function wslOwnPids(host: WslHost, known: Iterable<number> = []): Promise<number[]> {
  const pids = new Set<number>([...known].filter((p) => Number.isInteger(p) && p > 0));
  try {
    const client = await linkOf(host).client(false);
    for (const info of client ? await client.list() : []) {
      if (!info.live || !Number.isInteger(info.pid) || info.pid <= 0) continue;
      if (info.kind === 'pipe' || info.channel.startsWith(CLIENT_TERMINAL_PREFIX)) pids.add(info.pid);
    }
  } catch { /* the keeper's list is unavailable: the chats AIB knows of still count as its own */ }
  return [...pids].slice(0, 500);
}

/** Under test, the Claude folder the helper reads (inside AIB_WSL_ROOT); {} in real use (the distro user's own). */
function claudeDir(): { claudeDir?: string } {
  const test = wslTestHomeEnv();
  return test.CLAUDE_CONFIG_DIR ? { claudeDir: test.CLAUDE_CONFIG_DIR } : {};
}

export interface WslOwnerAnswer {
  owner: number | null;
  assessment: Assessment;
}

/** The distro's answer, or null when its helper cannot give one (see the module note). */
export async function wslOwnerCheck(
  host: WslHost,
  provider: string,
  sessionId: string,
  options: { cwd?: string; projectRoot?: string; exclude: number[]; releasedAgo?: number | null },
): Promise<WslOwnerAnswer | null> {
  try {
    const answer = await host.call('ownership.check', {
      provider,
      sessionId,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      exclude: options.exclude,
      ...(typeof options.releasedAgo === 'number' && options.releasedAgo >= 0 ? { releasedAgo: options.releasedAgo } : {}),
      ...claudeDir(),
    }, { timeoutMs: 15_000 });
    const owner = Number.isInteger(answer.owner) ? answer.owner : null;
    return { owner, assessment: answer.assessment as unknown as Assessment };
  } catch {
    return null;
  }
}

/** The distro's hints for the conversation list ({} when its helper cannot give them). */
export async function wslOwnerHints(host: WslHost, exclude: number[]): Promise<Record<string, { verdict: string; reasons: Reason[] }>> {
  try {
    const answer = await host.call('ownership.hints', { exclude, ...claudeDir() }, { timeoutMs: 10_000 });
    return (answer.hints ?? {}) as unknown as Record<string, { verdict: string; reasons: Reason[] }>;
  } catch {
    return {};
  }
}

/**
 * One assessment from the distro's (null: none) and the Windows registry's (an OwnershipProbe with only the registry): reasons and
 * notes of both, the verdict and summary worked out again the way probe.assess does. `owner` adds the command-line reason the
 * distro found.
 */
export function mergeAssessment(distro: Assessment | null, registry: Assessment, owner: number | null = null, distroLabel = 'the distro'): Assessment {
  const reasons: Reason[] = [...(distro?.reasons ?? [])];
  if (owner !== null) {
    reasons.unshift({
      signal: 'command-line',
      strength: 'strong',
      pid: owner,
      text: `A ${registry.provider} process (PID ${owner}) in ${distroLabel} was started with this exact session ID.`,
    });
  }
  reasons.push(...registry.reasons);
  const notes = [...(distro?.notes ?? []), ...registry.notes];
  const unavailable = distro ? [...distro.unavailable] : [`check in ${distroLabel} (its AIB helper did not answer)`];
  const verdict: Exclude<Verdict, 'owned_by_studio'> = reasons.some((r) => r.strength === 'strong')
    ? 'owned_elsewhere'
    : reasons.length
    ? 'possibly_active'
    : 'no_evidence';
  return {
    provider: registry.provider,
    sessionId: registry.sessionId,
    reasons,
    notes,
    unavailable,
    checkedAt: distro?.checkedAt ?? registry.checkedAt,
    verdict,
    summary: SUMMARIES[verdict],
    elapsedMs: (distro?.elapsedMs ?? 0) + (registry.elapsedMs ?? 0),
    certainty: verdict === 'no_evidence' && unavailable.length ? 'unknown' : verdict === 'no_evidence' ? 'checked' : 'evidence',
    transcriptQuiet: distro?.transcriptQuiet === true, // the transcript is the distro's (an older helper: unknown, so asks as before)
  };
}
