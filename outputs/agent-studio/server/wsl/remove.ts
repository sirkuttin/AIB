/**
 * Remove AIB from a distro, the Windows side (docs/wsl/linking-design.md section 13; docs/WSL.md "Remove AIB from a distro"). The
 * helper (helper/aib_remove.ts) measures, refuses and deletes inside the distro; this runs the order around it:
 *
 *   check: AIB's own refusals (chats of this AIB working there, live chats or terminals in its Linux keeper, a sign-in or Node.js
 *          terminal, an install job) + the helper's `aib.remove {mode:'check'}`. Nothing changes.
 *   apply: 1. the same refusals again (any: ok false, nothing changes);
 *          2. the 'removed' flag (wsl/removed.ts): from here wslHost()/hostWhenReady() give no host for the distro, so nothing starts
 *             it or installs AIB into it again until "Set up again";
 *          3. the keep-alive in the Windows keeper is stopped;
 *          4. helper `aib.remove {mode:'apply'}`: it refuses again (then the flag is cleared and the keep-alive comes back: nothing
 *             was deleted), else deletes the chat copies, runs `git worktree prune` in their projects (branches stay), the rest of
 *             this AIB's data folder but keeper/ and helper/, and the shared parts nothing else uses;
 *          5. the helper's channel is ended and the Linux keeper shut down WITHOUT force (a chat that went live meanwhile refuses it);
 *          6. the host stops for good (state 'off' with the flag; never half-started) and is forgotten;
 *          7. the last step, the self-deletion problem: keeper/ (its socket, lock and journals) and helper/ (this helper's sockets) and
 *             the current <ver>/ (the running keeper and helper programs) cannot go while they run, so after step 5 one hidden
 *             `wsl.exe ... /bin/sh -c FINAL_CLEANUP_SCRIPT` (fixed text; the root, the data folder's name, the <ver> or '-', and two
 *             flags as "$1".."$5", all checked again here and in the script) waits up to 15 s for this AIB's processes to end, then
 *             deletes the data folder and the <ver>/ (only when the helper said the shared parts may go and nothing runs from it) with
 *             `rm -rf --one-file-system` (never follows a link), and the root with `rmdir` (only when empty);
 *          8. the chat copies deleted are remembered, so their chats read as "workspace removed";
 *          9. the report: removed, left (and why, in message). A partial failure keeps the flag and the stopped host.
 * Under test (AGENT_STUDIO_TEST=1) a real host is refused unless its root is the test's AIB_WSL_ROOT, a /tmp/aib-wsl-test-* folder.
 */
import { getLogger } from '../core/log.ts';
import type { AibRemoveResult, WslHost } from './contract.ts';
import { WslHelperError } from './contract.ts';
import { rootOverride, runWsl, type WslInstall, type WslRunner } from './install.ts';
import { wslHostsInUse } from './hosts.ts';
import { wslLoc } from './access.ts';
import { lastProgress } from './agent_install.ts';
import { addRemovedWorktrees, clearDistroRemoved, markDistroRemoved } from './removed.ts';

const log = getLogger('wsl');
const DEC = new TextDecoder();

export const DATA_NAME = /^data-[0-9a-f]{12}$/;
export const VERSION_NAME = /^\d+\.\d+\.\d+[0-9A-Za-z.+_-]*-[0-9a-f]{8}$/;
export const TEST_ROOT = /^\/tmp\/aib-wsl-test-[A-Za-z0-9_-]+$/;
export const FINAL_TIMEOUT_MS = 120_000;

/**
 * The last step. $1 = the root, $2 = the data folder's name, $3 = the <ver> to delete or '-', $4 = 1: the root may go (rmdir: only
 * when empty), $5 = 1: under test. Prints removed=<path>, left=<path>: <why>, gone=<root> or error=<why> lines; always exits 0.
 * A process "uses" a folder when it runs from it, works in it or names it in its arguments; this script's own processes never do
 * (their arguments carry the root and the names apart).
 */
export const FINAL_CLEANUP_SCRIPT = `set -u
root="$1"; name="$2"; ver="$3"; rootok="$4"; test="$5"
say() { printf '%s=%s\\n' "$1" "$2"; }
no() { say error "$1"; exit 0; }
case "$root" in /*/*) ;; *) no 'the AIB folder is not an absolute path below a folder';; esac
case "$root" in */|*//*|*/./*|*/../*|*/.|*/..) no 'the AIB folder is not a plain path';; esac
case "\${root##*/}" in .aib-server|aib-wsl-test-*) ;; *) no 'the AIB folder is not named like one';; esac
case "$root" in /mnt/?|/mnt/?/*) no 'the AIB folder is on a Windows drive';; esac
[ -n "\${HOME:-}" ] || no 'there is no home folder'
[ "$root" != "$HOME" ] || no 'the AIB folder is the home folder'
case "$HOME/" in "$root"/*) no 'the home folder is inside the AIB folder';; esac
if [ "$test" = 1 ]; then
  case "$root" in /tmp/aib-wsl-test-*) ;; *) no 'test guard: not a /tmp/aib-wsl-test-* folder';; esac
  [ "$root" != "$HOME/.aib-server" ] || no 'test guard: never ~/.aib-server'
fi
case "$name" in data-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) no 'not a data folder name';; esac
case "$ver" in
  -) ;;
  *[!0-9A-Za-z.+_-]*) no 'not a version name';;
  [0-9]*.*.*-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) no 'not a version name';;
esac
if [ ! -e "$root" ] && [ ! -L "$root" ]; then say gone "$root"; exit 0; fi
{ [ ! -L "$root" ] && [ -d "$root" ]; } || no 'the AIB folder is not a plain folder'
real=$(cd -P -- "$root" 2>/dev/null && pwd -P) || no 'the AIB folder cannot be read'
[ "$real" = "$root" ] || no 'the path to the AIB folder goes through a link'
uses() {
  for p in /proc/[0-9]*; do
    [ "\${p#/proc/}" != "$$" ] || continue
    e=$(readlink "$p/exe" 2>/dev/null) || e=''
    w=$(readlink "$p/cwd" 2>/dev/null) || w=''
    case "$e/" in "$1"/*) return 0;; esac
    case "$w/" in "$1"/*) return 0;; esac
    c=$(tr '\\000' ' ' < "$p/cmdline" 2>/dev/null) || c=''
    case " $c " in *" $1 "*|*"$1/"*) return 0;; esac
  done
  return 1
}
gone() {
  i=0
  while uses "$1"; do i=$((i + 1)); [ "$i" -lt "$2" ] || break; sleep 0.5; done
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi
  if [ -L "$1" ] || [ ! -d "$1" ]; then say left "$1: it is not a plain folder"; return 0; fi
  if uses "$1"; then say left "$1: a program still uses it"; return 0; fi
  rm -rf --one-file-system -- "$1" 2>/dev/null
  if [ -e "$1" ] || [ -L "$1" ]; then say left "$1: some files could not be deleted"; else say removed "$1"; fi
}
gone "$root/$name" 30
[ "$ver" = - ] || gone "$root/$ver" 20
if [ "$rootok" = 1 ] && rmdir -- "$root" 2>/dev/null; then say removed "$root"; fi
exit 0
`;

/** Plain absolute Linux path (no `.`, `..`, empty part or trailing `/`). */
function plainAbs(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && path !== '/' && !/[\0\n\r]/.test(path) &&
    path.slice(1).split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

/** The test guard: '' when a real host's root may be touched, else why not. Only under AGENT_STUDIO_TEST=1. */
export function testGuard(root: string | null, env: (name: string) => string | undefined = (n) => Deno.env.get(n)): string {
  if (env('AGENT_STUDIO_TEST') !== '1') return '';
  let override: string | null;
  try {
    override = rootOverride(env);
  } catch {
    override = null;
  }
  if (!override || !TEST_ROOT.test(override)) return 'Test guard: Remove under test needs AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>.';
  if (root !== override) return `Test guard: Remove under test only touches ${override}, not ${root ?? 'an unknown folder'}.`;
  return '';
}

/** What the last step printed, read; anything but its own lines is ignored. */
export function parseFinal(out: string): { removed: string[]; left: string[]; error: string; gone: boolean } {
  const done = { removed: [] as string[], left: [] as string[], error: '', gone: false };
  for (const line of out.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at), value = line.slice(at + 1);
    if (key === 'removed') done.removed.push(value);
    else if (key === 'left') done.left.push(value);
    else if (key === 'error') done.error = value;
    else if (key === 'gone') done.gone = true;
  }
  return done;
}

/** The arguments of the last step, checked on this side too (null: refused, with why). */
export function finalArgs(
  root: string,
  final: NonNullable<AibRemoveResult['final']>,
  test: boolean,
): { args: string[] } | { refused: string } {
  if (!plainAbs(root) || (!TEST_ROOT.test(root) && !root.endsWith('/.aib-server'))) return { refused: `${root} is not an AIB folder` };
  if (!DATA_NAME.test(final.data)) return { refused: `${final.data} is not a data folder name` };
  if (final.version !== null && !VERSION_NAME.test(final.version)) return { refused: `${final.version} is not a version name` };
  return { args: [root, final.data, final.version ?? '-', final.root ? '1' : '0', test ? '1' : '0'] };
}

/** One step each, so the order is one function (removeAib) that tests can watch. */
export interface RemoveSteps {
  /** AIB's own refusals (Windows side). */
  refusals(): Promise<string[]>;
  /** '' or why this host may not be touched (the test guard). */
  guard(): string;
  call(mode: 'check' | 'apply'): Promise<AibRemoveResult>;
  markRemoved(): void;
  /** Nothing was deleted after all: the flag goes and the keep-alive comes back. */
  undoMark(): Promise<void>;
  releaseHold(): Promise<void>;
  shutdownKeeper(): Promise<{ ok: boolean; live: number; message: string }>;
  stopHost(): void;
  finalCleanup(final: NonNullable<AibRemoveResult['final']>): Promise<{ removed: string[]; left: string[]; error: string }>;
  rememberCopies(copies: NonNullable<AibRemoveResult['final']>['copies']): void;
}

/** The page's shape (contract section 13): the helper-only `final` never leaves this module. */
function pageShape(r: AibRemoveResult): AibRemoveResult {
  const { final: _final, ...rest } = r;
  return {
    ok: rest.ok === true,
    mode: rest.mode,
    blocked: Array.isArray(rest.blocked) ? rest.blocked.map(String) : [],
    wouldRemove: Array.isArray(rest.wouldRemove) ? rest.wouldRemove : [],
    kept: Array.isArray(rest.kept) ? rest.kept : [],
    removed: Array.isArray(rest.removed) ? rest.removed.map(String) : [],
    left: Array.isArray(rest.left) ? rest.left.map(String) : [],
    ...(typeof rest.message === 'string' && rest.message ? { message: rest.message } : {}),
  };
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Remove AIB from a distro: 'check' changes nothing; 'apply' runs the order above. Never throws for a helper failure. */
export async function removeAib(steps: RemoveSteps, mode: 'check' | 'apply'): Promise<AibRemoveResult> {
  const guard = steps.guard();
  const empty = { mode, wouldRemove: [], kept: [], removed: [], left: [] };
  if (guard) return { ...empty, ok: false, blocked: [guard] };
  const ours = await steps.refusals();
  let check: AibRemoveResult;
  try {
    check = await steps.call('check');
  } catch (error) {
    return { ...empty, ok: false, blocked: [...ours, `The AIB helper could not check what to remove: ${text(error)}`] };
  }
  const blocked = [...ours, ...(check.blocked ?? [])];
  if (mode === 'check' || blocked.length || !check.ok) {
    return pageShape({ ...check, mode, blocked, ok: check.ok && !blocked.length, removed: [], left: [] });
  }
  steps.markRemoved(); // from here nothing starts the distro or installs AIB there again
  await steps.releaseHold();
  let applied: AibRemoveResult;
  try {
    applied = await steps.call('apply');
  } catch (error) {
    // what was deleted is not known: stop everything (state 'off', flag kept), never run the last step blind
    const why = `The AIB helper stopped in the middle (${text(error)}). Some of AIB may be left in this distro: click Set up again, then Remove again.`;
    log.warning('wsl: removing AIB: %s', why);
    await steps.shutdownKeeper();
    steps.stopHost();
    return pageShape({ ...check, mode, ok: false, blocked: [], removed: [], left: [], message: why });
  }
  if (applied.blocked?.length) { // something changed since the check; nothing was deleted
    await steps.undoMark();
    return pageShape({ ...applied, mode, ok: false, removed: [], left: [] });
  }
  const removed = [...(applied.removed ?? [])];
  const left = [...(applied.left ?? [])];
  const notes: string[] = applied.message ? [applied.message] : [];
  let failed = false;
  try {
    const down = await steps.shutdownKeeper();
    steps.stopHost(); // state 'off' with the flag, whatever happens next
    if (!down.ok) {
      failed = true;
      left.push(`${applied.final?.data ?? "this AIB's data folder"}: ${down.message}`);
      notes.push(`The AIB keeper in this distro did not stop (${down.message}), so its folder was left.`);
    } else if (applied.final) {
      const done = await steps.finalCleanup(applied.final);
      removed.push(...done.removed);
      left.push(...done.left);
      if (done.error) {
        failed = true;
        notes.push(`The last step did not run: ${done.error}.`);
      }
    }
  } finally {
    if (applied.final?.copies?.length) steps.rememberCopies(applied.final.copies);
  }
  if (left.length && !notes.length) notes.push('Some of AIB could not be deleted; see what was left.');
  const ok = applied.ok !== false && !failed && left.length === 0;
  return pageShape({ ...applied, mode, ok, removed, left, ...(notes.length ? { message: notes.join(' ') } : {}) });
}

// ---- the real steps -----------------------------------------------------------------------------------------------------------

/** What remove.ts needs of a real host (wsl/hosts.ts WslHostImpl); a test's fake may leave any of it out. */
type RealHost = WslHost & {
  install?: WslInstall | null;
  releaseHold?: () => Promise<void>;
  shutdownKeeper?: () => Promise<{ ok: boolean; live: number; message: string }>;
  stop?: () => void;
  liveCount?: () => Promise<number>;
  keepAlive?: () => void;
};

export interface RefusalFacts {
  /** The folded distro and its name. */
  key: string;
  name: string;
  /** Studio's busy chats ({cwd, state}: LiveBackend busyConnections). */
  busy: { cwd?: unknown }[];
  /** The terminals open now ({key}: TerminalSessions list). */
  terminals: { key?: unknown }[];
  /** Live chats and terminals in the distro's Linux keeper (AIB's own channels left out). */
  live: number;
}

/** AIB's own refusals (Windows side): one plain line each. */
export function windowsRefusals(f: RefusalFacts): string[] {
  const out: string[] = [];
  const working = f.busy.filter((c) => wslLoc(c?.cwd)?.distro === f.key).length;
  if (working) {
    out.push(`${working === 1 ? 'A chat' : `${working} chats`} of AIB in ${f.name} ${working === 1 ? 'is' : 'are'} working. Wait for ${working === 1 ? 'it' : 'them'} to finish, or stop ${working === 1 ? 'it' : 'them'}, then remove.`);
  }
  if (f.live) {
    out.push(`${f.live === 1 ? 'A chat or terminal' : `${f.live} chats or terminals`} still ${f.live === 1 ? 'runs' : 'run'} in ${f.name}. Close ${f.live === 1 ? 'it' : 'them'}, then remove.`);
  }
  const terminal = f.terminals.some((t) => typeof t?.key === 'string' && /^(signin|setup):/.test(t.key) && t.key.endsWith(`@${f.key}`));
  if (terminal) out.push(`A sign-in or Node.js set-up terminal for ${f.name} is open. Close it, then remove.`);
  for (const [id, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    if (lastProgress(f.key, id)?.state === 'running') out.push(`${label} is being installed in ${f.name} right now. Wait for it to finish, or cancel it, then remove.`);
  }
  return out;
}

let runnerForTests: WslRunner | null = null;

/** Tests: what runs the last step (null: wsl.exe). */
export function setFinalRunnerForTests(run: WslRunner | null): void {
  runnerForTests = run;
}

/** The real steps for a host: its helper, its keep-alive, its keeper, the flag, and the last step through wsl.exe. */
export function realSteps(
  host: WslHost,
  facts: Omit<RefusalFacts, 'live'>,
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
): RemoveSteps {
  const h = host as RealHost;
  const test = env('AGENT_STUDIO_TEST') === '1';
  return {
    async refusals() {
      const live = h.liveCount ? await h.liveCount().catch(() => 0) : 0;
      return windowsRefusals({ ...facts, live });
    },
    // a real host always knows its install once ready; a test's fake host has none and touches no distro
    guard: () => h.install ? testGuard(h.install.root, env) : test ? '' : `AIB does not know where it is installed in ${facts.name}.`,
    call: async (mode) => {
      try {
        return await host.call('aib.remove', { mode }, { timeoutMs: mode === 'apply' ? 900_000 : 180_000 });
      } catch (error) {
        if (error instanceof WslHelperError && ['unknown_method', 'no_method'].includes(error.code)) {
          throw new Error(`the AIB helper in ${facts.name} is too old to remove AIB; restart AIB first`);
        }
        throw error;
      }
    },
    markRemoved: () => markDistroRemoved(facts.key),
    undoMark() {
      clearDistroRemoved(facts.key);
      h.keepAlive?.();
      return Promise.resolve();
    },
    releaseHold: async () => await h.releaseHold?.(),
    shutdownKeeper: async () => h.shutdownKeeper ? await h.shutdownKeeper() : { ok: true, live: 0, message: '' },
    stopHost() {
      h.stop?.();
      wslHostsInUse()?.drop(facts.key);
    },
    async finalCleanup(final) {
      if (!h.install) return { removed: [], left: [], error: '' }; // a test's fake host: there is no distro
      const why = testGuard(h.install.root, env);
      if (why) return { removed: [], left: [], error: why };
      const checked = finalArgs(h.install.root, final, test);
      if ('refused' in checked) return { removed: [], left: [], error: checked.refused };
      try {
        const run = runnerForTests ?? runWsl;
        const done = await run(host.distro, ['/bin/sh', '-c', FINAL_CLEANUP_SCRIPT, 'sh', ...checked.args], { timeoutMs: FINAL_TIMEOUT_MS });
        const out = parseFinal(DEC.decode(done.stdout));
        if (done.code !== 0 && !out.error) out.error = done.stderr.trim().slice(0, 300) || `exit ${done.code}`;
        return out;
      } catch (error) {
        return { removed: [], left: [], error: text(error) };
      }
    },
    rememberCopies: (copies) => addRemovedWorktrees(facts.key, copies),
  };
}
