/**
 * Setting up a Beta agent that is not on this computer yet (Settings > AIB Linking > Beta agents): how it installs here, what it needs
 * first, and the commands AIB runs for both in an AIB terminal panel on the card (the person sees each command before it runs and
 * watches its output; no window ever opens).
 *
 *   npm        an npm package: AIB installs it into its own folder (installer.ts). Needs Node.js (MIN_NODE_MAJOR, or the package's
 *              own engines.node when higher).
 *   terminal   no npm package: the vendor's installer for this OS (beta_catalog.ts vendorInstall), run in the card's terminal panel.
 *   none       the vendor documents no installer for this OS: the docs link only.
 *
 * Prerequisites (PREREQS) are looked up on PATH and in their installers' usual folders; their version comes from `<program> --version`
 * (cached per program file). A missing or too-old one gets an "Install <name>" button that runs its official installer in the same
 * panel; the agent's Install stays off until every prerequisite is there. Windows: installers change PATH in the registry only, so
 * Check again (and every setup terminal) first adds the registry's new PATH folders to AIB's own PATH (refreshWindowsPath).
 *
 * Nothing here downloads or installs anything by itself: it only builds commands; the terminal runs them when the person asks.
 */
import * as adapters from './adapters.ts';
import { type BetaAgent, betaAgent, type BetaSetupStep, type OsName } from './beta_catalog.ts';
import { pathCandidates } from './beta_agents.ts';
import { MIN_NODE_MAJOR } from './installer.ts';
import type { ShellSpec } from '../platform/pty.ts';
import { isFile } from '../platform/pypath.ts';
import { pathOf } from '../state/paths.ts';

/**
 * The Node.js LTS line AIB offers to install. nodejs.org/dist/index.json (read 2026-11-11): the newest entry with lts != false is
 * v26.13.1 "Lithium" (2026-11-10); even majors become Active LTS each October. The install commands ask for "the LTS" (winget
 * OpenJS.NodeJS.LTS, `nvm install --lts`), so they keep working when this number is not updated; only the button text names it.
 */
export const NODE_LTS_MAJOR = 26;

export const THIS_OS: OsName = Deno.build.os === 'windows' ? 'windows' : Deno.build.os === 'darwin' ? 'darwin' : 'linux';

export interface PrereqInstall {
  /** The command for this OS, or null when there is no official one AIB can run (the link is shown then). */
  step: BetaSetupStep | null;
  /** Where the command comes from. */
  source: string;
}

export interface PrereqSpec {
  readonly id: string;
  readonly name: string;
  /** Program names looked up on PATH. */
  readonly programs: readonly string[];
  /** Usual install folders that may not be on AIB's PATH yet: [env var, ...parts] (Windows) or [HOME, ...parts]. */
  readonly known: (os: OsName) => readonly (readonly string[])[];
  /** The official download page (shown when there is no command to run). */
  readonly page: string;
  /** The button text. */
  readonly installLabel: string;
  readonly install: (os: OsName, hasWinget: boolean) => PrereqInstall;
}

const NVM_INSTALL = 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && ' +
  '\\. "$HOME/.nvm/nvm.sh" && nvm install --lts';

export const PREREQS: Readonly<Record<string, PrereqSpec>> = {
  // Node.js: nodejs.org/en/download (read 2026-11-11) gives nvm for macOS and Linux (nvm v0.41.0, then `nvm install <major>`; AIB asks
  // for --lts). Windows: winget's OpenJS.NodeJS.LTS (github.com/microsoft/winget-pkgs manifests/o/OpenJS/NodeJS/LTS, 26.13.1 on
  // 2026-11-11). Without winget: the download page.
  node: {
    id: 'node',
    name: 'Node.js',
    programs: ['node'],
    known: (
      os,
    ) => (os === 'windows' ? [['ProgramFiles', 'nodejs', 'node.exe']] : []),
    page: 'https://nodejs.org/en/download',
    installLabel: `Install Node.js ${NODE_LTS_MAJOR} (LTS)`,
    install: (os, hasWinget) => {
      if (os === 'windows') {
        return {
          step: hasWinget
            ? {
              shell: 'powershell',
              command: 'winget install -e --id OpenJS.NodeJS.LTS',
            }
            : null,
          source: 'https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/OpenJS/NodeJS/LTS',
        };
      }
      return {
        step: { shell: 'bash', command: NVM_INSTALL },
        source: 'https://nodejs.org/en/download',
      };
    },
  },
  // uv: docs.astral.sh/uv/getting-started/installation (read 2026-11-11): `winget install --id=astral-sh.uv  -e`, the PowerShell
  // installer, and `curl -LsSf https://astral.sh/uv/install.sh | sh`. Both installers put uv in ~/.local/bin; winget in its Links folder.
  uv: {
    id: 'uv',
    name: 'uv',
    programs: ['uv'],
    known: (os) =>
      os === 'windows'
        ? [['USERPROFILE', '.local', 'bin', 'uv.exe'], [
          'LOCALAPPDATA',
          'Microsoft',
          'WinGet',
          'Links',
          'uv.exe',
        ]]
        : [['HOME', '.local', 'bin', 'uv'], ['HOME', '.cargo', 'bin', 'uv']],
    page: 'https://docs.astral.sh/uv/getting-started/installation/',
    installLabel: 'Install uv',
    install: (os, hasWinget) => ({
      step: os === 'windows'
        ? hasWinget
          ? {
            shell: 'powershell',
            command: 'winget install --id=astral-sh.uv -e',
          }
          : {
            shell: 'powershell',
            command: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
          }
        : {
          shell: 'sh',
          command: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
        },
      source: 'https://docs.astral.sh/uv/getting-started/installation/',
    }),
  },
};

export type PrereqState = 'found' | 'missing' | 'old';

export interface PrereqView {
  id: string;
  name: string;
  /** What is needed, as the card says it: "Node.js 22 or newer", "uv". */
  need: string;
  state: PrereqState;
  /** The version found ('' when missing or unreadable). */
  version: string;
  min: string;
  /** The command its Install button runs ('' when there is none for this OS: `page` is linked instead). */
  command: string;
  installLabel: string;
  page: string;
  source: string;
}

export interface SetupView {
  kind: 'npm' | 'terminal' | 'none';
  /** The command Install runs (terminal) or the person can run themselves (npm: the global npm command); '' for none. */
  command: string;
  source: string;
  uninstallDocs: string;
  prereqs: PrereqView[];
  /** The agent's Install is off until this is '' ("Install uv first"). */
  blockedBy: string;
}

/** What setup looks at; tests pass their own. */
export interface SetupProbe {
  os: OsName;
  env: Record<string, string | undefined>;
  /** AIB's Node.js program ('' when none): adapters.findNode with the configured command. */
  findNode: () => string;
  /** `<program> --version` output, '' when it does not run. */
  version: (program: string) => Promise<string>;
}

/** The version number in a `--version` line: "v26.13.1" -> "26.13.1", "uv 0.9.9 (abc 2026-11-01)" -> "0.9.9". */
export function parseVersion(text: string): string {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(text || '')?.[1] ?? '';
}

/** a < b for dotted versions (missing parts are 0). */
export function versionBelow(a: string, b: string): boolean {
  const x = a.split('.').map((n) => parseInt(n, 10) || 0),
    y = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

/** The lowest Node.js an npm agent needs: MIN_NODE_MAJOR, or its own engines.node when higher. */
export function nodeMinimum(agent: BetaAgent): string {
  const own = agent.npm?.minNode ?? '';
  return own && versionBelow(String(MIN_NODE_MAJOR), own) ? own : String(MIN_NODE_MAJOR);
}

function shortVersion(v: string): string {
  return v.replace(/(\.0)+$/, '');
}

/** The install step for this agent on this OS, and the prerequisites it needs. */
export function installPlan(
  agent: BetaAgent,
  os: OsName,
): { kind: SetupView['kind']; step: BetaSetupStep | null; needs: string[] } {
  if (agent.npm) return { kind: 'npm', step: null, needs: ['node'] };
  const step = agent.vendorInstall?.[os] ?? null;
  if (!step) return { kind: 'none', step: null, needs: [] };
  return { kind: 'terminal', step, needs: [...(step.needs ?? [])] };
}

/** winget on this computer (Windows): on PATH, or in the App Installer's usual folder. */
export function hasWinget(
  env: Record<string, string | undefined>,
  os: OsName,
): boolean {
  if (os !== 'windows') return false;
  if (pathCandidates('winget', env, true).length) return true;
  if (!env.LOCALAPPDATA) return false;
  try {
    // An app execution alias (a reparse point that stat cannot follow): lstat sees it.
    Deno.lstatSync(
      pathOf(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe'),
    );
    return true;
  } catch {
    return false;
  }
}

/** Where a prerequisite's program is: PATH first, then its usual folders. '' when not found. */
export function findPrereq(spec: PrereqSpec, probe: SetupProbe): string {
  if (spec.id === 'node') {
    const node = probe.findNode();
    if (node) return node;
  }
  for (const name of spec.programs) {
    const hit = pathCandidates(name, probe.env, probe.os === 'windows')[0];
    if (hit) return hit;
  }
  for (const [base, ...parts] of spec.known(probe.os)) {
    const root = probe.env[base];
    if (root && isFile(pathOf(root, ...parts))) return pathOf(root, ...parts);
  }
  return '';
}

const versionCache = new Map<string, [number, string]>();

/** `<program> --version`, cached per program file and its modification time. */
export async function programVersion(
  program: string,
  force = false,
): Promise<string> {
  let mtime = 0;
  try {
    mtime = Deno.statSync(program).mtime?.getTime() ?? 0;
  } catch { /* gone: run it anyway (it fails) */ }
  const hit = versionCache.get(program);
  if (hit && hit[0] === mtime && !force) return hit[1];
  let out = '';
  try {
    out = (await adapters.runCapture([program, '--version'], { timeout: 15 }))
      .stdout;
  } catch { /* does not start */ }
  versionCache.set(program, [mtime, out]);
  return out;
}

export function defaultProbe(nodeCommand = '', force = false): SetupProbe {
  return {
    os: THIS_OS,
    env: Deno.env.toObject(),
    findNode: () => adapters.findNode(nodeCommand),
    version: (program) => programVersion(program, force),
  };
}

/** One prerequisite's state on this computer. */
export async function checkPrereq(
  id: string,
  min: string,
  probe: SetupProbe,
): Promise<PrereqView> {
  const spec = PREREQS[id];
  const path = findPrereq(spec, probe);
  const version = path ? parseVersion(await probe.version(path)) : '';
  const state: PrereqState = !path ? 'missing' : min && (!version || versionBelow(version, min)) ? 'old' : 'found';
  const install = spec.install(probe.os, hasWinget(probe.env, probe.os));
  return {
    id,
    name: spec.name,
    need: min ? `${spec.name} ${shortVersion(min)} or newer` : spec.name,
    state,
    version,
    min,
    command: install.step?.command ?? '',
    installLabel: spec.installLabel,
    page: spec.page,
    source: install.source,
  };
}

/** The card's setup: install kind and command, and every prerequisite with its state. */
export async function setupView(
  agent: BetaAgent,
  probe: SetupProbe,
): Promise<SetupView> {
  const plan = installPlan(agent, probe.os);
  const prereqs: PrereqView[] = [];
  for (const id of plan.needs) {
    prereqs.push(
      await checkPrereq(id, id === 'node' ? nodeMinimum(agent) : '', probe),
    );
  }
  const missing = prereqs.find((p) => p.state !== 'found');
  return {
    kind: plan.kind,
    command: plan.kind === 'npm' ? agent.install : plan.step?.command ?? '',
    source: agent.vendorInstall?.source ?? agent.docs,
    uninstallDocs: agent.vendorInstall?.uninstallDocs ?? '',
    prereqs,
    blockedBy: missing ? `Install ${missing.name} first` : '',
  };
}

/** How a step runs in a terminal: Windows PowerShell -Command, or bash / sh -c. */
export function stepShell(
  step: BetaSetupStep,
  os: OsName,
  env: Record<string, string | undefined>,
): ShellSpec {
  if (step.shell === 'powershell') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    const file = os === 'windows' ? pathOf(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
    return {
      file,
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        step.command,
      ],
    };
  }
  return {
    file: step.shell === 'bash' ? '/bin/bash' : '/bin/sh',
    args: ['-c', step.command],
  };
}

/**
 * The program a setup terminal runs for a Beta agent's card: `install` (the vendor's installer) or `prereq:<id>` (a prerequisite the
 * agent needs). The command is always the catalog's, never the page's. A string is the one-line reason it cannot run.
 */
export async function setupCommand(
  agentId: string,
  what: string,
  probe: SetupProbe,
): Promise<ShellSpec | string> {
  const agent = betaAgent(agentId);
  if (!agent) return 'AIB does not know that agent.';
  const plan = installPlan(agent, probe.os);
  if (what === 'install') {
    if (plan.kind !== 'terminal' || !plan.step) {
      return `AIB cannot run an installer for ${agent.name} on this computer.`;
    }
    const view = await setupView(agent, probe);
    if (view.blockedBy) return `${view.blockedBy}.`;
    return stepShell(plan.step, probe.os, probe.env);
  }
  const id = what.startsWith('prereq:') ? what.slice(7) : '';
  if (
    !plan.needs.includes(id) ||
    !Object.prototype.hasOwnProperty.call(PREREQS, id)
  ) {
    return `${agent.name} does not need that installed first.`;
  }
  const step = PREREQS[id].install(probe.os, hasWinget(probe.env, probe.os)).step;
  if (!step) {
    return `AIB has no installer it can run for ${PREREQS[id].name} here. Get it from ${PREREQS[id].page}`;
  }
  return stepShell(step, probe.os, probe.env);
}

// ---- Windows PATH ------------------------------------------------------------------------------------------------------

/** The Path value of a `reg query ... /v Path` output, '' when there is none. */
export function regPathValue(output: string): string {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output || '');
  return m ? m[1].trim() : '';
}

/** %NAME% expanded from env (case-insensitive names, as Windows does); unknown names stay as they are. */
export function expandWindowsVars(
  text: string,
  env: Record<string, string | undefined>,
): string {
  const lower = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return text.replace(
    /%([^%;]+)%/g,
    (all, name: string) => lower[name.toLowerCase()] ?? all,
  );
}

/**
 * The PATH with the folders that the registry's machine and user Path have and the current one lacks, added at the end (an installer
 * such as winget changes only the registry; AIB keeps the PATH it started with). Current order and entries stay.
 */
export function mergedPath(
  current: string,
  machine: string,
  user: string,
  env: Record<string, string | undefined>,
): string {
  const have = current.split(';').map((d) => d.trim()).filter(Boolean);
  const seen = new Set(have.map((d) => d.replace(/\\+$/, '').toLowerCase()));
  for (const part of `${machine};${user}`.split(';')) {
    const dir = expandWindowsVars(part.trim(), env);
    const key = dir.replace(/\\+$/, '').toLowerCase();
    if (!dir || seen.has(key)) continue;
    seen.add(key);
    have.push(dir);
  }
  return have.join(';');
}

export type RegQuery = (key: string) => Promise<string>;

const regQuery: RegQuery = async (key) => {
  const root = Deno.env.get('SystemRoot') || 'C:\\Windows';
  try {
    return (await adapters.runCapture([
      pathOf(root, 'System32', 'reg.exe'),
      'query',
      key,
      '/v',
      'Path',
    ], { timeout: 10 })).stdout;
  } catch {
    return '';
  }
};

/** Windows: add the registry's new PATH folders to AIB's own PATH (after an installer ran). True when PATH changed. */
export async function refreshWindowsPath(
  query: RegQuery = regQuery,
  os: OsName = THIS_OS,
): Promise<boolean> {
  if (os !== 'windows') return false;
  const machine = regPathValue(
    await query(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    ),
  );
  const user = regPathValue(await query('HKCU\\Environment'));
  const env = Deno.env.toObject();
  const current = env.PATH ?? env.Path ?? '';
  const next = mergedPath(current, machine, user, env);
  if (next === current) return false;
  Deno.env.set('PATH', next);
  return true;
}
