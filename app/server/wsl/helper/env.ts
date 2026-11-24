/**
 * The WSL helper's login environment (design 3): captured once per helper start from the user's login shell, so agents, git and
 * `which` see the PATH a terminal in the distro sees. `$SHELL -lic` first (an interactive login shell reads .bashrc / .zshrc, where
 * nvm and friends live), then `-lc`, then the helper's own environment. Windows' folders (/mnt/<drive>/...) are dropped from PATH:
 * WSL appends every one of them by default, and a Windows `node.exe` or `git.exe` found there must never run on a Linux project.
 */

export const ENV_MARK = '\0AIBENV\0';
export const CAPTURE_TIMEOUT_MS = 10_000;
/** Shell bookkeeping that describes the capture's own shell, not the user's environment. */
const DROPPED = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD']);

/** KEY=VALUE entries after the last ENV_MARK in `env -0` output (values may hold newlines), or null without the mark. */
export function parseEnvDump(bytes: Uint8Array): Record<string, string> | null {
  const text = new TextDecoder().decode(bytes);
  const at = text.lastIndexOf(ENV_MARK);
  if (at < 0) return null;
  const env: Record<string, string> = {};
  for (const entry of text.slice(at + ENV_MARK.length).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!DROPPED.has(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = entry.slice(eq + 1);
  }
  return env;
}

/** PATH without empty entries, repeats and Windows' folders (/mnt/<anything>). */
export function cleanPath(path: string): string {
  const out: string[] = [];
  for (const dir of path.split(':')) {
    if (!dir || dir === '/mnt' || dir.startsWith('/mnt/') || out.includes(dir)) continue;
    out.push(dir);
  }
  return out.join(':');
}

/** The environment agents and git get: the login one, PATH cleaned, BROWSER the aib-open shim, AIB_OPEN_FIFO where it writes. */
export function agentEnv(login: Record<string, string>, extra: { browser?: string; openFifo?: string } = {}): Record<string, string> {
  const env = { ...login };
  env.PATH = cleanPath(env.PATH ?? '') || '/usr/local/bin:/usr/bin:/bin';
  if (extra.browser) env.BROWSER = extra.browser;
  if (extra.openFifo) env.AIB_OPEN_FIFO = extra.openFifo;
  return env;
}

/** The user's login shell: $SHELL when it is an absolute path, else the passwd entry of this uid, else /bin/sh. */
export function loginShell(env: Record<string, string | undefined>, passwd: string | null, uid: number | null): string {
  if (env.SHELL && env.SHELL.startsWith('/')) return env.SHELL;
  for (const line of (passwd ?? '').split('\n')) {
    const f = line.split(':');
    if (f.length >= 7 && uid !== null && Number(f[2]) === uid && f[6].startsWith('/')) return f[6].trim();
  }
  return '/bin/sh';
}

export type Runner = (shell: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<Uint8Array | null>;

/** Runs the shell with a clean environment, stdin closed, output kept; null on a failure or timeout. */
export const runShell: Runner = async (shell, args, env, timeoutMs) => {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(shell, { args, env, clearEnv: true, stdin: 'null', stdout: 'piped', stderr: 'null' }).spawn();
  } catch {
    return null;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch { /* gone */ }
  }, timeoutMs);
  try {
    const out = await child.output();
    return out.stdout;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export interface Captured {
  env: Record<string, string>;
  shell: string;
  how: '-lic' | '-lc' | 'none';
}

/**
 * The login environment of `shell`. The shell starts from the few variables a login sets up anyway (HOME, USER, LOGNAME, SHELL, a
 * basic PATH, LANG), never the helper's own environment, which came from Windows through wsl.exe.
 */
export async function captureLoginEnv(
  shell: string,
  base: Record<string, string | undefined>,
  run: Runner = runShell,
  timeoutMs = CAPTURE_TIMEOUT_MS,
): Promise<Captured> {
  const start: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'dumb', SHELL: shell };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'WSL_DISTRO_NAME', 'WSL_INTEROP']) {
    const v = base[key];
    if (v) start[key] = v;
  }
  const script = `printf '\\0AIBENV\\0'; env -0`;
  for (const how of ['-lic', '-lc'] as const) {
    const out = await run(shell, [how, script], start, timeoutMs);
    const env = out && parseEnvDump(out);
    if (env && env.PATH) return { env, shell, how };
  }
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DROPPED.has(k)) own[k] = v;
  return { env: own, shell, how: 'none' };
}
