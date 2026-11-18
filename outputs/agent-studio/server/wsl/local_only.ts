/**
 * Local-only files of WSL projects, Windows side (the distro's helper does the work: wsl/helper/local_only.ts, `localOnly.*`).
 *   wslDefaultsAllowed   local_only.defaultsAllowed for a WSL project: a test or demo AIB (temp or no state folder) writes the
 *                        default `/aib-shared` only into projects under the distro's /tmp, never into a real repository
 *   wslEnsureLocalOnly   the default `/aib-shared` line in the distro (local_only.ensureDefault there); never throws
 *   wslChatLocalOnly     what a WSL chat is told and granted (Connection.localOnly, Linux paths of the main folder); null when the
 *                        project has none, or the helper is older and has no localOnly.* (the chat then works as before)
 *   startWslLocalBackups the hourly check of local_backup.ts for WSL projects, run by each ready distro's helper into its own data
 *                        folder; a distro that is not running is never started for it
 */
import { getLogger } from '../core/log.ts';
import { defaultsAllowed } from '../worktrees/local_only.ts';
import { settings } from '../worktrees/local_backup.ts';
import { hostWhenReady, peekState, peekWslHost, wslLoc } from './access.ts';
import { WslHelperError } from './contract.ts';

const log = getLogger('wsl_local_only');

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The helper does not offer the method (an older helper): local-only files stay off for the project, as before. */
export const noMethod = (error: unknown) => error instanceof WslHelperError && (error.code === 'unknown_method' || error.code === 'no_method');

/** True when AIB may write the local-only default into the WSL project `ref` (see the header). */
export function wslDefaultsAllowed(stateDir: string, ref: string): boolean {
  const wsl = wslLoc(ref);
  if (!wsl) return false;
  // a real state folder (not under the Windows temp folder): any project; else only a project under the distro's /tmp
  return defaultsAllowed(stateDir, '\0') || /^\/tmp\/./.test(wsl.linuxPath);
}

/** Sets the default `/aib-shared` up in the distro (idempotent). Never throws. */
export async function wslEnsureLocalOnly(ref: string): Promise<void> {
  const wsl = wslLoc(ref);
  if (!wsl) return;
  try {
    await (await hostWhenReady(wsl.distro)).call('localOnly.ensure', { project: wsl.linuxPath });
  } catch (error) {
    if (!noMethod(error)) log.warning('Setting up the local-only default of %s failed: %s', ref, text(error));
  }
}

/** Connection.localOnly of a WSL chat: AIB's local-only paths, plus (a chat in its own copy) the main folder's other ignored ones. */
export interface WslChatLocalOnly {
  entries: string[];
  dirs: string[];
  shared: string;
  ignored?: { dirs: string[]; files: string[] };
}

/** Connection.localOnly of a WSL chat whose main folder is `mainRef`; null when there is nothing to tell. Never throws. */
export async function wslChatLocalOnly(mainRef: string, worktree: boolean): Promise<WslChatLocalOnly | null> {
  const wsl = wslLoc(mainRef);
  if (!wsl) return null;
  try {
    // a chat in its own copy also gets the main folder's other ignored folders and files (owner: agents read and edit them)
    const answer = await (await hostWhenReady(wsl.distro)).call('localOnly.chat', { project: wsl.linuxPath, worktree, ...(worktree ? { ignored: true } : {}) });
    const lo = answer?.localOnly;
    if (!lo || !Array.isArray(lo.entries) || !Array.isArray(lo.dirs)) return null;
    const linux = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/');
    const out: WslChatLocalOnly = { entries: lo.entries.filter(linux), dirs: lo.dirs.filter(linux), shared: linux(lo.shared) ? lo.shared : '' };
    const ig = lo.ignored;
    if (worktree && ig && Array.isArray(ig.dirs) && Array.isArray(ig.files)) out.ignored = { dirs: ig.dirs.filter(linux), files: ig.files.filter(linux) };
    return out;
  } catch (error) {
    if (!noMethod(error)) log.warning('Looking up the local-only files of %s failed: %s', mainRef, text(error));
    return null;
  }
}

/** One round: the WSL projects of each running distro are backed up by its helper. Distros not running are skipped. */
export async function wslBackupRound(projects: string[]): Promise<Map<string, Record<string, { status: string }>>> {
  const byDistro = new Map<string, Set<string>>();
  for (const ref of projects) {
    const wsl = wslLoc(ref);
    if (!wsl) continue;
    if (!byDistro.has(wsl.distro)) byDistro.set(wsl.distro, new Set());
    byDistro.get(wsl.distro)!.add(wsl.linuxPath);
  }
  const done = new Map<string, Record<string, { status: string }>>();
  for (const [distro, paths] of byDistro) {
    const host = peekWslHost(distro);
    if (!host || peekState(host) !== 'ready') continue; // never started for a backup
    try {
      const answer = await host.call('localOnly.backup', { projects: [...paths] }, { timeoutMs: 600_000 });
      done.set(distro, answer.results ?? {});
    } catch (error) {
      if (!noMethod(error)) log.warning('Backing up the local-only files in %s failed: %s', distro, text(error));
    }
  }
  return done;
}

/** The hourly WSL backup check (local_backup.ts settings: the first a little after start). `projects` lists every added project. */
export function startWslLocalBackups(projects: () => string[]): { stop(): void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;
  const round = async () => {
    if (running) return;
    running = true;
    try {
      await wslBackupRound(projects());
    } catch (error) {
      log.warning('Backing up the local-only files of WSL projects failed: %s', text(error));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void round();
    const every = setInterval(() => void round(), settings.EVERY_MS);
    Deno.unrefTimer(every as unknown as number);
    timers.push(every);
  }, settings.FIRST_MS);
  Deno.unrefTimer(first as unknown as number);
  timers.push(first);
  return {
    stop() {
      for (const t of timers.splice(0)) {
        clearTimeout(t);
        clearInterval(t);
      }
    },
  };
}
