/**
 * `env.prereqs` (docs/wsl/linking-design.md sections 3 and 12): what the distro has for AIB's agent installs, in one answer for the
 * Settings checklist. Read-only: it runs `node --version`, `node -p process.execPath`, `git --version` and `df -Pk` and looks at a few
 * files; it never installs or changes anything.
 *
 * - Node.js (>= 22.19) through the login PATH (Windows' /mnt folders are never on it). Who manages it comes from the path found:
 *   asdf / mise shims, nvm (~/.nvm or NVM_DIR), AIB's own folder, else the system. A shim that runs but has no version set is
 *   'shim_unset' (asdf: "No version is set"); a node that does not start is 'broken'; one below 22.19 is 'old'.
 * - npm next to the node that really runs (installer.ts findNpmCli on the found path, then on `process.execPath`: an asdf shim has no
 *   npm beside it, the real node has); its version from npm's package.json.
 * - git and curl on the login PATH; the free space of the home filesystem (`df -Pk`).
 * - canInstallNode: AIB may offer nvm's installer only when the node is not a version manager's shim, the login shell is bash or zsh
 *   with its start-up file present (nvm adds itself there: PROFILE is set to it), and curl is there to fetch the installer.
 */
import { findNpmCli } from '../../agents/installer.ts';
import { isVersionManagerShim } from '../../agents/adapters.ts';
import type { EnvPrereqs } from '../contract.ts';
import { cleanPath } from './env.ts';

/** Kimi Code's engines field: the highest minimum of the agents AIB installs. */
export const MIN_NODE = [22, 19, 0] as const;
export const MIN_NODE_TEXT = MIN_NODE.join('.');
const RUN_TIMEOUT_MS = 15_000;

export type EnvMode = EnvPrereqs['envMode'];
type Manager = NonNullable<EnvPrereqs['node']['manager']>;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PrereqDeps {
  /** The login environment (PATH, HOME, NVM_DIR, ZDOTDIR). */
  env: Record<string, string>;
  home: string;
  arch: string;
  loginShell: string;
  envMode: EnvMode;
  /** AIB's folder in the distro (a node inside it is 'aib'). */
  root?: string;
  /** Tests: the program runner, the file checks, npm's lookup and the free space. */
  run?: (argv: string[]) => Promise<RunResult | null>;
  isFile?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
  findNpmCli?: (node: string) => string;
  isShim?: (path: string) => boolean;
  readText?: (path: string) => string | null;
  diskFree?: (path: string) => Promise<number | null>;
}

function fileOk(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function executable(path: string): boolean {
  try {
    const st = Deno.statSync(path);
    return st.isFile && (st.mode === null || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function readOr(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

/** Runs argv with the helper's (login) environment, stdin closed, with a timeout; null when it could not start. */
export async function runQuiet(argv: string[]): Promise<RunResult | null> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(argv[0], { args: argv.slice(1), stdin: 'null', stdout: 'piped', stderr: 'piped' }).spawn();
  } catch {
    return null;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch { /* gone */ }
  }, RUN_TIMEOUT_MS);
  try {
    const out = await child.output();
    const dec = new TextDecoder();
    return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Free bytes of the filesystem holding `path`, from `df -Pk` (the 4th field of its second line, in KiB); null when unknown. */
export function parseDf(text: string): number | null {
  const line = text.split('\n').filter((l) => l.trim())[1];
  const kb = line ? Number(line.trim().split(/\s+/)[3]) : NaN;
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

async function dfFree(path: string): Promise<number | null> {
  const done = await runQuiet(['df', '-Pk', '--', path]);
  return done && done.code === 0 ? parseDf(done.stdout) : null;
}

/** [major, minor, patch] of '22.19.0' / 'v22.19.0', or null. */
export function versionParts(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(v: [number, number, number], min: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** The first `name` on PATH that is an executable file (never a /mnt folder), or ''. */
export function whichOn(name: string, path: string, isExe: (p: string) => boolean = executable): string {
  for (const dir of cleanPath(path).split(':')) {
    if (!dir.startsWith('/')) continue;
    const candidate = `${dir.replace(/\/+$/, '')}/${name}`;
    if (isExe(candidate)) return candidate;
  }
  return '';
}

/** Who manages the node at `path` (as found on PATH, then the program it really is). */
export function managerOf(path: string, env: Record<string, string>, home: string, root = ''): Manager {
  const p = path.replaceAll('\\', '/');
  if (root && (p === root || p.startsWith(root.replace(/\/+$/, '') + '/'))) return 'aib';
  if (/\/\.?asdf\//.test(p) || (env.ASDF_DATA_DIR && p.startsWith(env.ASDF_DATA_DIR.replace(/\/+$/, '') + '/'))) return 'asdf';
  if (/\/(mise|rtx)\//.test(p) || (env.MISE_DATA_DIR && p.startsWith(env.MISE_DATA_DIR.replace(/\/+$/, '') + '/'))) return 'mise';
  const nvmDir = (env.NVM_DIR || (home ? `${home}/.nvm` : '')).replace(/\/+$/, '');
  if ((nvmDir && p.startsWith(nvmDir + '/')) || /\/\.nvm\//.test(p)) return 'nvm';
  return 'system';
}

/** The start-up file nvm should write to for this login shell, or '' when nvm cannot use the shell. */
export function profileFor(shell: string, env: Record<string, string>, home: string): string {
  const name = shell.slice(shell.lastIndexOf('/') + 1);
  if (!home) return '';
  if (name === 'zsh') return `${(env.ZDOTDIR || home).replace(/\/+$/, '')}/.zshrc`;
  if (name === 'bash') return `${home}/.bashrc`;
  return '';
}

function shimHelp(manager: Manager): string {
  if (manager === 'mise') {
    return 'mise has a node shim but no Node.js version is set for your home folder. In a terminal run: mise use -g node@lts';
  }
  return 'asdf has a node shim but no Node.js version is set for your home folder. In a terminal run: asdf install nodejs latest, ' +
    'then asdf set -u nodejs latest (asdf older than 0.16: asdf global nodejs latest)';
}

export async function envPrereqs(d: PrereqDeps): Promise<EnvPrereqs> {
  const run = d.run ?? runQuiet;
  const isExe = d.isExecutable ?? executable;
  const isFile = d.isFile ?? fileOk;
  const npmOf = d.findNpmCli ?? findNpmCli;
  const isShim = d.isShim ?? isVersionManagerShim;
  const read = d.readText ?? readOr;
  const path = d.env.PATH ?? '';
  const home = d.home || d.env.HOME || '';

  // ---- Node.js and npm
  const node: EnvPrereqs['node'] = { state: 'missing', manager: '' };
  const npm: EnvPrereqs['npm'] = { state: 'missing' };
  const nodePath = whichOn('node', path, isExe);
  let shim = false;
  if (nodePath) {
    node.path = nodePath;
    let manager = managerOf(nodePath, d.env, home, d.root);
    shim = (manager === 'asdf' || manager === 'mise') && (/\/shims\//.test(nodePath) || isShim(nodePath));
    const version = await run([nodePath, '--version']);
    const parts = version && version.code === 0 ? versionParts(version.stdout) : null;
    if (!parts) {
      const said = `${version?.stderr ?? ''}\n${version?.stdout ?? ''}`;
      if (shim && /no version|version is not set|not installed|no preset/i.test(said)) {
        node.state = 'shim_unset';
        node.note = shimHelp(manager);
      } else {
        node.state = 'broken';
        node.note = `Node.js was found at ${nodePath} but did not start${version ? ` (exit code ${version.code})` : ''}.`;
      }
    } else {
      node.version = parts.join('.');
      const exec = await run([nodePath, '-p', 'process.execPath']);
      const real = exec && exec.code === 0 ? exec.stdout.trim() : '';
      const realPath = real.startsWith('/') && !real.includes('\n') ? real : '';
      if (manager === 'system' && realPath) manager = managerOf(realPath, d.env, home, d.root);
      node.state = atLeast(parts, MIN_NODE) ? 'ok' : 'old';
      if (node.state === 'old') node.note = `AIB's agents need Node.js ${MIN_NODE_TEXT} or newer; this one is ${node.version}.`;
      const cli = npmOf(nodePath) || (realPath && realPath !== nodePath ? npmOf(realPath) : '');
      if (cli && isFile(cli)) {
        npm.state = 'ok';
        try {
          const pkg = JSON.parse(read(cli.replace(/\/bin\/npm-cli\.js$/, '/package.json')) ?? '');
          if (typeof pkg?.version === 'string' && versionParts(pkg.version)) npm.version = pkg.version;
        } catch { /* no version shown */ }
      }
    }
    node.manager = manager;
  }

  // ---- git, curl, disk
  const git: EnvPrereqs['git'] = { state: 'missing' };
  const gitPath = whichOn('git', path, isExe);
  if (gitPath) {
    git.state = 'ok';
    const done = await run([gitPath, '--version']);
    const m = done && done.code === 0 ? /(\d+\.\d+(?:\.\d+)?)/.exec(done.stdout) : null;
    if (m) git.version = m[1];
  }
  const curl: EnvPrereqs['curl'] = { state: whichOn('curl', path, isExe) ? 'ok' : 'missing' };
  let free: number | null = null;
  try {
    free = home ? await (d.diskFree ?? dfFree)(home) : null;
  } catch {
    free = null;
  }

  // ---- nvm and whether AIB may offer its installer
  const nvmDir = d.env.NVM_DIR || (home ? `${home}/.nvm` : '');
  const nvm = { present: !!nvmDir && isFile(`${nvmDir.replace(/\/+$/, '')}/nvm.sh`) };
  const shellName = d.loginShell.slice(d.loginShell.lastIndexOf('/') + 1) || d.loginShell;
  const profile = profileFor(d.loginShell, d.env, home);
  let blocked = '';
  if (shim || node.manager === 'asdf' || node.manager === 'mise') {
    const tool = node.manager === 'mise' ? 'mise' : 'asdf';
    blocked = `Node.js here is managed by ${tool}. AIB does not install a second Node.js with nvm next to it; ` +
      (node.state === 'shim_unset' ? shimHelp(node.manager as Manager) : `use ${tool} to install or update Node.js.`);
  } else if (!profile) {
    blocked =
      `Your login shell is ${shellName}. nvm's installer only sets itself up for bash and zsh, so install Node.js ${MIN_NODE_TEXT} ` +
      'or newer yourself (from nodejs.org or your package manager).';
  } else if (!isFile(profile)) {
    blocked = `Your login shell is ${shellName} but ${profile} does not exist, so nvm would have nowhere to add itself. ` +
      `Create it (touch ${profile}) and check again.`;
  } else if (curl.state !== 'ok') {
    blocked = "curl is needed to download nvm's installer. Install it with: sudo apt install curl";
  }

  return {
    node,
    npm,
    git,
    curl,
    diskFreeMB: free === null ? null : Math.floor(free / (1024 * 1024)),
    arch: d.arch,
    loginShell: d.loginShell,
    envMode: d.envMode,
    nvm,
    canInstallNode: !blocked,
    ...(blocked ? { nodeInstallBlocked: blocked } : {}),
  };
}

/** The capture mode of helper/env.ts as env.prereqs names it. */
export function envModeOf(how: '-lic' | '-lc' | 'none'): EnvMode {
  return how === '-lic' ? 'login-interactive' : how === '-lc' ? 'login' : 'plain';
}
