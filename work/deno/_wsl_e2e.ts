/**
 * Shared set-up of the real-WSL e2e tests (wsl_*_e2e_test.ts; docs/wsl/design.md section 7). They run only with AIB_WSL_E2E=<distro>
 * and that distro present as WSL2; otherwise every test is ignored. They need Track A's Linux keeper and helper and Track B's
 * wsl/hosts.ts (merged), and use them unchanged.
 *
 * Isolation: a temp Windows data folder per test, AIB_WSL_ROOT=/tmp/aib-wsl-test-<random> instead of ~/.aib-server (the agents' HOME,
 * CLAUDE_CONFIG_DIR and CODEX_HOME go inside it: wsl/access.ts wslTestHomeEnv), the fake agent work/fake_acp.py copied over stdin and
 * run with the distro's python3. Never `wsl --shutdown` or `--terminate`, never the owner's ~/.claude or ~/.codex, never a real agent.
 * wsl.exe runs with piped stdio and a minimal environment (it inherits this process's hidden console: no window).
 *
 * One process, several files: the state they share is this module's (ROOT, STATE, AIB_WSL_ROOT, the keeper and helper paths) and
 * wsl/hosts.ts's configured hosts. Every test ends with cleanRoot(), which shuts its Linux keeper down, drops the hosts (newAib) and
 * removes ROOT, and the next test's prepareRoot() and first host start make them again, so files can share a process (checked with
 * wsl_fixes, wsl_sessions, wsl_worktrees and wsl_merge in one `deno test`). wsl_sync_e2e is the exception that looked like shared
 * state: it also fails alone, intermittently, waiting for "m.txt pending" after its Merge step (7 of 8 runs on 2026-11-14 failed, with and
 * without that day's Studio changes), so run it in its own process and treat a failure there as that flake until it is fixed.
 */
import { detectWsl } from '../../outputs/agent-studio/server/wsl/detect.ts';
import type { WslHost } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { wslHost } from '../../outputs/agent-studio/server/wsl/access.ts';
import { configureWslHosts, type WslHostsOptions, wslHostsInUse } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { urlGate } from '../../outputs/agent-studio/server/wsl/open_urls.ts';
import type { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';

export const DISTRO = Deno.env.get('AIB_WSL_E2E') ?? '';
const found = DISTRO ? detectWsl(true).distros : [];
/** True when the real-WSL tests can run here. */
export const WSL_E2E = !!DISTRO && found.some((d) => d.name.toLowerCase() === DISTRO.toLowerCase() && d.version === 2);
export const KEY = DISTRO.toLowerCase();
export const ROOT = `/tmp/aib-wsl-test-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
/** The Linux programs: `deno run -A tools/build.ts --wsl-only` (dist/wsl/linux-<arch>/), unless AIB_WSL_KEEPER_BIN/HELPER_BIN say. */
const BUILT = new URL(`../../dist/wsl/linux-${Deno.build.arch === 'aarch64' ? 'arm64' : 'x64'}/`, import.meta.url);
/** The Windows data folder of the AIB under test (the Linux keeper's data-<hash> folder is named after it). */
export const STATE = WSL_E2E ? Deno.makeTempDirSync({ prefix: 'aib-wsl-e2e-state-' }) : '';
if (WSL_E2E) {
  Deno.env.set('AGENT_STUDIO_TEST', '1');
  Deno.env.set('AIB_WSL_ROOT', ROOT); // before any host starts: the Linux keeper data and the agents' homes go inside it
  const path = (name: string) => decodeURIComponent(new URL(name, BUILT).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  if (!Deno.env.get('AIB_WSL_KEEPER_BIN')) Deno.env.set('AIB_WSL_KEEPER_BIN', path('AIB-keeper-linux'));
  if (!Deno.env.get('AIB_WSL_HELPER_BIN')) Deno.env.set('AIB_WSL_HELPER_BIN', path('AIB-wsl-helper-linux'));
  newAib();
  globalThis.addEventListener('unload', () => {
    try {
      Deno.removeSync(STATE, { recursive: true });
    } catch { /* in use or gone */ }
  });
}

/**
 * This process becomes a new AIB as far as WSL goes: the hosts made so far are dropped without touching the distro (their transport
 * ends, as when AIB crashes or quits), and the next wslHost() makes a fresh one that connects to the same Linux keeper.
 */
export function newAib(options: Partial<WslHostsOptions> = {}): void {
  for (const host of wslHostsInUse()?.all() ?? []) host.stop();
  configureWslHosts({ stateDir: STATE, wslExe: null, ...options });
}

/** A Windows keeper link for the keep-alive (tests that check the hold): newAib({windowsLink: () => link, wslExe: undefined}). */
export function withWindowsKeeper(link: KeeperLink): Partial<WslHostsOptions> {
  return { windowsLink: () => link, wslExe: undefined };
}

const WORK = new URL('../', import.meta.url);
const SYSTEM_ROOT = Deno.env.get('SystemRoot') ?? 'C:\\Windows';

/** Run `sh -c script` in the distro (args after it as $1..), stdin optional. */
export async function inDistro(script: string, args: string[] = [], stdin?: Uint8Array): Promise<{ code: number; out: string; err: string }> {
  const child = new Deno.Command(`${SYSTEM_ROOT}\\System32\\wsl.exe`, {
    args: ['--distribution', DISTRO, '--cd', '~', '--exec', 'sh', '-c', script, 'sh', ...args],
    env: { SystemRoot: SYSTEM_ROOT, WSL_UTF8: '1', WSLENV: '' },
    clearEnv: true,
    stdin: stdin ? 'piped' : 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  if (stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(stdin);
    await writer.close();
  }
  const done = await child.output();
  return { code: done.code, out: new TextDecoder().decode(done.stdout), err: new TextDecoder().decode(done.stderr) };
}

/** The test root with the fake agent in it (and python3 present), plus a git repo at ROOT/repo. */
export async function prepareRoot(): Promise<void> {
  const fake = Deno.readFileSync(new URL('fake_acp.py', WORK));
  const made = await inDistro('mkdir -p "$1/repo" && chmod 700 "$1" && cat > "$1/fake_acp.py" && command -v python3', [ROOT], fake);
  if (made.code !== 0) throw new Error(`could not prepare ${ROOT} in ${DISTRO}: ${made.err}`);
  const git = await inDistro('cd "$1/repo" && git init -q && git config user.email t@e && git config user.name t && echo one > a.txt && git add a.txt && git commit -qm one', [ROOT]);
  if (git.code !== 0) throw new Error(`git in ${DISTRO}: ${git.err}`);
}

/**
 * End the test's WSL side: the Linux keeper this test started is shut down (its agents, shells and helper with it), the hosts are
 * dropped, and the test root inside the distro is removed (only it: ROOT is a fresh /tmp/aib-wsl-test-<random>).
 */
export async function cleanRoot(): Promise<void> {
  for (const host of wslHostsInUse()?.all() ?? []) {
    try {
      const client = await host.link.client(false);
      await client?.shutdown(true);
    } catch { /* not running */ }
  }
  newAib();
  if (/^\/tmp\/aib-wsl-test-[0-9a-f]{12}$/.test(ROOT)) {
    // the keeper leaves within a few seconds of the shutdown; its folder goes after it
    for (let i = 0; i < 20; i++) {
      const left = await inDistro('ls "$1"/data-*/keeper/keeper.sock >/dev/null 2>&1 && echo busy || echo free', [ROOT]).catch(() => null);
      if (!left || left.out.trim() !== 'busy') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await inDistro('rm -rf -- "$1"', [ROOT]).catch(() => {});
  }
}

/** The distro's host once it is ready (Track B starts it on first use). */
export async function readyHost(seconds = 180): Promise<WslHost> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const host = wslHost(KEY);
    if (host?.state === 'ready') return host;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${DISTRO} did not get ready (${wslHost(KEY)?.state}: ${wslHost(KEY)?.note})`);
}

/** Record URLs instead of opening a browser. */
export function recordUrls(): string[] {
  const opened: string[] = [];
  urlGate.setForTests((url) => opened.push(url));
  return opened;
}

export const T = { sanitizeResources: false, sanitizeOps: false, ignore: !WSL_E2E };
