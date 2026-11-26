/**
 * The test guard and the launch environment of an agent process: real-agent guards, the test HOME/TEMP folders, program
 * resolution. Moved out of connection.ts (no change).
 */
import { assertTestAuth, testCredentialEnv } from './test_auth_guard.ts';
import { TESTS_DIR } from '../core/app.ts';
import { pyRepr } from '../core/py.ts';
import { SEP, RuntimeError } from './conn_util.ts';

// ---- the test guard -----------------------------------------------------------------------------------------------------------

export function resolvePath(part: string): string {
  try {
    return Deno.realPathSync(part);
  } catch {
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(part) ? part : Deno.cwd() + SEP + part;
    const out: string[] = [];
    for (const piece of absolute.split(/[\\/]+/)) {
      if (piece === '..') out.length > 1 && out.pop();
      else if (piece !== '.' && piece !== '') out.push(piece);
    }
    return (Deno.build.os === 'windows' ? '' : '/') + out.join(SEP);
  }
}

export function normcase(path: string): string {
  return Deno.build.os === 'windows' ? path.replaceAll('/', '\\').toLowerCase() : path;
}

export function isFixture(command: unknown): boolean {
  let fixtures: string;
  try {
    fixtures = normcase(resolvePath(TESTS_DIR)).replace(/[\\/]+$/, '');
  } catch {
    return false;
  }
  for (const part of Array.isArray(command) ? command : [command]) {
    const resolved = normcase(resolvePath(String(part)));
    if (
      resolved.startsWith(fixtures + SEP) &&
      resolved.length > fixtures.length + 1
    ) return true;
  }
  return false;
}

/**
 * Under test (AGENT_STUDIO_TEST=1) a Connection may only start a fixture from the repo's work/ folder; anything else would launch
 * a real agent, so it fails loudly. STUDIO_REAL_ADAPTER_TESTS=1 or AGENT_STUDIO_ALLOW_REAL_AGENT=1 lifts it.
 */
export function guardRealAgent(command: string[]): void {
  if (
    Deno.env.get('AGENT_STUDIO_TEST') !== '1' ||
    Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' ||
    Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1'
  ) return;
  if (isFixture(command)) return;
  throw new RuntimeError(
    `Test guard: refusing to start a real agent process: ${
      pyRepr(command)
    }. Pass connection_factory= to AIB, or use a fixture under work/.`,
  );
}

export let testHome: string | null = null;
export const HOME_VARS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
];

/**
 * The temp-folder variables a real agent under test gets, pointing at <test home>/tmp (architect review MF 12): Claude Code writes
 * task output under %TEMP%\claude\<project>. A list of its own: HOME_VARS is reused elsewhere.
 */
export const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'];

/** Under test, a real (non-fixture) agent gets a throwaway home so it can never write into the owner's ~/.claude. {} otherwise. */
export function testHomeEnv(command: string[]): Record<string, string> {
  if (Deno.env.get('AGENT_STUDIO_TEST') !== '1' || isFixture(command)) {
    return {};
  }
  if (testHome === null) {
    const folder = Deno.makeTempDirSync({ prefix: 'agent-studio-test-home-' });
    testHome = folder;
    globalThis.addEventListener('unload', () => {
      try {
        Deno.removeSync(folder, { recursive: true });
      } catch { /* best effort, as shutil.rmtree(ignore_errors=True) */ }
    });
  }
  const tmp = `${testHome}${SEP}tmp`;
  try {
    Deno.mkdirSync(tmp, { recursive: true });
  } catch { /* made */ }
  return Object.fromEntries([
    ...Object.entries(testCredentialEnv(testHome)),
    ...HOME_VARS.map((name) => [name, testHome!]),
    ...TEMP_VARS.map((name) => [name, tmp]),
  ]);
}

/**
 * Under test a real (non-fixture) agent may only start on an explicit test auth setup: a loopback stub endpoint and a key, never a
 * sign-in (acp/test_auth_guard.ts; incident 2026-11-25). `env`: what the process will see beyond this process's own environment.
 * Throws before the process exists. Checked at every launch path (direct, keeper, WSL) and for the Codex limits probe.
 */
export function guardRealAgentAuth(provider: string, command: string[], env: Record<string, string>, base: Record<string, string> = Deno.env.toObject()): void {
  if (Deno.env.get('AGENT_STUDIO_TEST') !== '1' || isFixture(command) || inTestFixtureRoot(command)) return;
  assertTestAuth(provider, command, { ...base, ...env });
}

/**
 * A built app under test cannot see work/, so isFixture misses its fake agent: the test names the folder that holds its fakes in
 * AIB_TEST_FIXTURE_ROOT, and only a program inside that folder passes. Not a switch that lets any agent through.
 */
export function inTestFixtureRoot(command: string[]): boolean {
  const root = (Deno.env.get('AIB_TEST_FIXTURE_ROOT') ?? '').trim();
  if (!root) return false;
  const dir = normcase(resolvePath(root)).replace(/[\\/]+$/, '');
  return command.some((part) => {
    const p = normcase(resolvePath(String(part)));
    return p.startsWith(dir + SEP) && p.length > dir.length + 1;
  });
}

/**
 * The program a keeper spawn gets: Deno.Command looks a bare name up on PATH itself; the keeper looks in its own PATH, which can
 * be older than ours, so a bare name is resolved here, with the environment the agent gets.
 */
export function resolveProgram(program: string, env: Record<string, string>): string {
  if (/[\\/]/.test(program)) return resolvePath(program);
  const win = Deno.build.os === 'windows';
  const path = env.PATH ?? env.Path ?? Deno.env.get('PATH') ?? '';
  const exts = win ? ['.exe', '.com', ...(env.PATHEXT ?? '.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const hasExt = win && /\.[^\\/.]+$/.test(program);
  for (const dir of path.split(win ? ';' : ':').filter(Boolean)) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = dir.replace(/[\\/]+$/, '') + SEP + program + ext;
      try {
        const info = Deno.statSync(candidate);
        if (info.isFile && (win || ((info.mode ?? 0) & 0o111))) return candidate;
      } catch { /* not here */ }
    }
  }
  return program;
}
