/**
 * Where a Beta agent's program is on this computer, and the argv that starts it (beta_catalog.ts has the list). Never downloads or
 * installs anything: an agent that is not found gets its official install command and docs link instead.
 *
 * Lookup order (first hit wins):
 *   1. AIB's own install of its npm package (<state>/agents/<id>/<version>/, written by the installer), run with node
 *   2. a global `npm i -g` of that package, its package.json bin run with node (no .cmd shim involved)
 *   3. the agent's program names on PATH: a native .exe first, then an npm .cmd/.bat shim, which is started through cmd.exe
 *      (`cmd.exe /d /c <shim> <args>`): a batch file is not a program Windows can start by itself
 *   4. known install folders that are not always on PATH (Windows)
 * A PATH hit that is VS Code's `copilot` install-prompt shim never counts (isVsCodeCopilotShim).
 *
 * Every child is started hidden like any other agent (the process's hidden console on Windows): no console window ever appears.
 */
import * as adapters from './adapters.ts';
import { type BetaAgent, betaAgent } from './beta_catalog.ts';
import { pathOf } from '../state/paths.ts';
import { isFile } from '../platform/pypath.ts';

const WIN = Deno.build.os === 'windows';

export interface BetaLaunch extends adapters.LaunchRow {
  /** The program part of argv (argv without the ACP arguments): a terminal sign-in method's args go after it. */
  base: string[];
  /** True when argv starts an npm .cmd/.bat shim through cmd.exe. */
  shim: boolean;
  /** The cmd.exe that starts a shim (ComSpec). */
  comspec?: string;
}

export interface BetaLookOptions {
  stateDir?: string | null;
  nodeCommand?: string;
  /** The environment the PATH and known folders come from (default: this process's). */
  env?: Record<string, string | undefined>;
  windows?: boolean;
  /** npm global folders (default: adapters.globalRoots, which may run `npm root -g` once). */
  globalRoots?: (node: string) => string[] | Promise<string[]>;
  findNode?: (configured: string) => string;
}

/** Characters cmd.exe would read as syntax. Only fixed catalog arguments and file paths go through it; anything else is refused. */
const CMD_SPECIAL = /[&|<>^%!"\r\n]/;

/** `cmd.exe /d /c <shim> <args>`: how an npm .cmd/.bat shim is started (never with /s: the quoted shim path must stay quoted). */
export function shimArgv(shim: string, args: readonly string[], comspec = ''): string[] {
  for (const part of [shim, ...args]) {
    if (CMD_SPECIAL.test(part)) throw new Error(`Refusing to start ${shim} through cmd.exe: "${part}" holds a character cmd.exe reads`);
  }
  return [comspec || 'cmd.exe', '/d', '/c', shim, ...args];
}

export function isShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

/**
 * VS Code (its Copilot Chat extension) puts a `copilot` program on PATH that only prints a prompt to install the real CLI. Such a file
 * is not the Copilot CLI. Seen as: a path inside VS Code's own folders, or a small script that mentions VS Code and not the npm package.
 * UNCONFIRMED: the exact folder and file name VS Code uses; both checks are kept broad on purpose.
 */
export function isVsCodeCopilotShim(path: string, read: (path: string) => string | null = readSmall): boolean {
  const p = path.replaceAll('\\', '/').toLowerCase();
  if (
    p.includes('/microsoft vs code/') || p.includes('/code - insiders/') || p.includes('/code/user/globalstorage/') ||
    p.includes('github.copilot-chat') || p.includes('/.vscode/') || p.includes('/.vscode-insiders/')
  ) return true;
  if (!/\.(cmd|bat|ps1|sh)$/.test(p) && /\.(exe|com)$/.test(p)) return false;
  const text = read(path);
  if (text === null) return false;
  return /vs ?code|visual studio code|copilot-chat/i.test(text) && !/node_modules|@github[\\/]copilot/i.test(text);
}

/** A file's text when it is small (a script), else null. */
function readSmall(path: string): string | null {
  try {
    if (Deno.statSync(path).size > 64 * 1024) return null;
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

/** Every file named `name` (Windows: name.exe, name.com, then name.cmd, name.bat) in the PATH folders, in PATH order. Never the
 * current folder. */
export function pathCandidates(name: string, env: Record<string, string | undefined>, windows = WIN): string[] {
  const value = env.PATH ?? env.Path ?? '';
  const out: string[] = [];
  const dirs = value.split(windows ? ';' : ':').map((d) => d.trim().replace(/^"|"$/g, '')).filter((d) => d && d !== '.');
  // Native programs first across the whole PATH, then the shims: an .exe later on PATH beats an npm shim earlier on it.
  for (const group of windows ? [['.exe', '.com'], ['.cmd', '.bat']] : [['']]) {
    for (const dir of dirs) {
      for (const ext of group) {
        const full = pathOf(dir, name + ext);
        if (isFile(full) && !out.includes(full)) out.push(full);
      }
    }
  }
  return out;
}

function row(agent: BetaAgent, base: string[], source: string, path: string, shim: boolean, note: string, comspec = ''): BetaLaunch {
  const argv = shim ? shimArgv(base[0], agent.args, comspec) : [...base, ...agent.args];
  return { argv, base, source, path, found: true, problem: '', text: note || argv.join(' '), shim, comspec };
}

function missing(agent: BetaAgent, problem = ''): BetaLaunch {
  return {
    argv: [],
    base: [],
    source: 'missing',
    path: '',
    found: false,
    problem: problem || `Not installed. Install it with: ${agent.install}`,
    text: 'Not installed',
    shim: false,
  };
}

/** The global npm install of a Beta agent's package: its bin file (inside the package folder), or ''. */
async function globalEntry(agent: BetaAgent, node: string, roots: (node: string) => string[] | Promise<string[]>): Promise<string> {
  if (!agent.npm) return '';
  const pkg: adapters.Package = [agent.npm.package, agent.npm.entry, agent.npm.bin];
  for (const root of await roots(node)) {
    const folder = pathOf(root, ...agent.npm.package.split('/'));
    const entry = adapters.packageEntryIn(folder, folder, pkg);
    if (entry) return entry;
  }
  return '';
}

/** How to start this Beta agent. Never throws for a missing program. */
export async function resolveBeta(id: string, options: BetaLookOptions = {}): Promise<BetaLaunch> {
  const agent = betaAgent(id);
  if (!agent) throw new Error(`Unknown Beta agent: ${id}`);
  const env = options.env ?? Deno.env.toObject();
  const windows = options.windows ?? WIN;
  const comspec = env.ComSpec || env.COMSPEC || '';
  const node = agent.npm ? (options.findNode ?? adapters.findNode)(options.nodeCommand || '') : '';
  if (agent.npm) {
    const own = adapters.findStudioInstall(id, options.stateDir);
    if (own && node) {
      return row(agent, [node, own.entry], 'studio', own.entry, false, `AIB's own install ${own.version}: ${own.entry} (run with node)`);
    }
    if (node) {
      const entry = await globalEntry(agent, node, options.globalRoots ?? ((n) => adapters.globalRoots(n)));
      if (entry) return row(agent, [node, entry], 'installed', entry, false, `Installed with npm: ${entry} (run with node)`);
    }
  }
  let sawVsCode = false;
  for (const name of agent.commands) {
    for (const path of pathCandidates(name, env, windows)) {
      const need = agent.pathMustContain?.[name];
      if (need && !path.toLowerCase().includes(need.toLowerCase())) continue;
      if (agent.vscodeShim && isVsCodeCopilotShim(path)) {
        sawVsCode = true;
        continue;
      }
      const shim = windows && isShim(path);
      return row(agent, [path], 'path', path, shim, `${path} on PATH`, comspec);
    }
  }
  if (windows) {
    for (const known of agent.known ?? []) {
      const base = env[known.base];
      if (!base) continue;
      const path = pathOf(base, ...known.parts);
      if (isFile(path)) return row(agent, [path], 'path', path, isShim(path), path, comspec);
    }
  }
  if (sawVsCode) {
    return missing(
      agent,
      `The "copilot" on PATH is VS Code's install prompt, not the Copilot CLI. Install the CLI with: ${agent.install}`,
    );
  }
  return missing(agent);
}

/**
 * The argv of a terminal sign-in: the agent's program with the method's arguments (from the agent's own initialize.authMethods when it
 * advertised one, else the catalog's). Shims go through cmd.exe. null when the agent is not found or has no terminal sign-in.
 */
export function signinArgv(launch: BetaLaunch, agentId: string, methodArgs?: readonly string[] | null): string[] | null {
  const agent = betaAgent(agentId);
  const args = methodArgs && methodArgs.length ? methodArgs : agent?.signin.terminalArgs;
  if (!agent || !launch.found || !launch.base.length || !args || !args.length) return null;
  return launch.shim ? shimArgv(launch.base[0], args, launch.comspec) : [...launch.base, ...args];
}
