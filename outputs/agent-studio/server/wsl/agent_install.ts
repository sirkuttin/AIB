/**
 * AIB-managed agent installs in a distro, the Windows side (phase 2; docs/wsl/design.md section 11, decision 5). The job itself runs in
 * the distro's helper (helper/agent_install.ts: agents/installer.ts natively, into ~/.aib-server/agents/<id>/<version>), where it
 * outlives AIB and the web server just as a Windows install job outlives the web server in the agent host. This module gives the
 * helper what may be installed (AIB's agent_versions.json entry and the reviewed lockfile text, the same ones the Windows installer
 * uses), adds what the agent panel shows (the pinned version, whether an update is due, why an install cannot run yet and the command
 * that fixes it), and turns helper errors into the routes' replies. AIB never installs Node.js or any other system package.
 */
import { pathOf } from '../state/paths.ts';
import { APP_ROOT } from '../core/app.ts';
import { isDict } from '../core/py.ts';
import { agentName } from '../agents/agent_registry.ts';
import { ALLOW_LIST, loadAllowList, MIN_NODE_MAJOR } from '../agents/installer.ts';
import { WslHelperError, type WslHost, type WslInstallParams, type WslInstallView } from './contract.ts';

/** The agents AIB installs into a distro (helper/agent_install.ts WSL_MANAGED). */
export const WSL_MANAGED: readonly string[] = ['claude', 'codex'];

/**
 * How to get Node.js into a distro without root: nvm, the way nodejs.org's download page offers it for Linux. The user runs it in the
 * distro's terminal; AIB only shows it. nvm puts node on the login shell's PATH (.bashrc), which the helper reads.
 */
export const NODE_INSTALL =
  `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install ${MIN_NODE_MAJOR}`;

/** The helper's installCheck codes, as the one line the agent panel shows ('' when installs can run). */
export function nodeBlockLine(code: string, agent: string, distro: string, nodeVersion = ''): string {
  const name = agentName(agent);
  if (!code) return '';
  if (code === 'node_missing') return `Node.js ${MIN_NODE_MAJOR} or newer is needed in ${distro} to install ${name}, and ${distro} has no Node.js.`;
  if (code === 'node_old') {
    return `Node.js ${MIN_NODE_MAJOR} or newer is needed in ${distro} to install ${name}; ${distro} has Node.js ${nodeVersion || 'older'}.`;
  }
  if (code === 'node_broken') return `Node.js ${MIN_NODE_MAJOR} or newer is needed in ${distro} to install ${name}, but Node.js there did not start.`;
  if (code === 'npm_missing') return `npm was not found next to Node.js in ${distro}. Install Node.js again (with npm) and try again.`;
  return `${name} cannot be installed in ${distro} yet.`;
}

/** Tests: where the allow-list and the lockfiles are read from (default: agent_versions.json and agent_locks/ in APP_ROOT). */
export const installSource: { allowList: () => Record<string, unknown>; readLock: (relative: string) => string } = {
  allowList: () => loadAllowList(ALLOW_LIST),
  readLock: (relative) => Deno.readTextFileSync(pathOf(APP_ROOT, relative)),
};

/** The params of an agents.install* call for one agent: AIB's pinned entry and lockfile. null when AIB does not install it in WSL. */
export function installParams(agent: string): WslInstallParams | null {
  if (!WSL_MANAGED.includes(agent)) return null;
  let found: unknown;
  try {
    found = installSource.allowList()[agent];
  } catch {
    return null;
  }
  if (!isDict(found) || typeof found.package !== 'string' || typeof found.version !== 'string') return null;
  const entry: WslInstallParams['entry'] = { package: found.package, version: found.version };
  for (const key of ['packageBytes', 'minFreeBytes'] as const) {
    const v = found[key];
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) entry[key] = v;
  }
  let lock: string | null = null;
  if (typeof found.lockfile === 'string' && found.lockfile) {
    try {
      lock = installSource.readLock(found.lockfile);
    } catch {
      return null; // a missing reviewed lockfile is an AIB bug: never fall back to an unpinned install
    }
  }
  return { agent, entry, lock };
}

/** The pinned version AIB installs for an agent, or ''. */
export function pinnedVersion(agent: string): string {
  return installParams(agent)?.entry.version ?? '';
}

// ---- the last progress each helper sent (agents.installProgress) -------------------------------------------------------------------

const latest = new Map<string, WslInstallView & { at: number }>();
const followed = new WeakSet<WslHost>();

/** Keep the progress notifications of a host (once per host). */
export function followInstalls(host: WslHost, key: string): void {
  if (followed.has(host) || !host.onNotify) return;
  followed.add(host);
  host.onNotify((method, params) => {
    if (method !== 'agents.installProgress' || typeof params.agent !== 'string' || !WSL_MANAGED.includes(params.agent)) return;
    latest.set(`${key}\0${params.agent}`, { ...(params as unknown as WslInstallView), at: Date.now() });
  });
}

/** The last progress a distro's helper sent for an agent (null when none since AIB started). */
export function lastProgress(key: string, agent: string): (WslInstallView & { at: number }) | null {
  return latest.get(`${String(key).toLowerCase()}\0${agent}`) ?? null;
}

/** Tests: forget the notifications. */
export function resetInstallProgress(): void {
  latest.clear();
}

// ---- the three calls ------------------------------------------------------------------------------------------------------------

type Reply = [number, unknown];

/**
 * Start, cancel or read the install of `agent` in the distro of `host` (key: its folded name, name: as the user named it). The answer
 * is the job's state, as the Windows install routes answer. A refusal is 409 with its one line; a missing Node.js is 409 with the
 * line, `code` and `nodeInstall` (the command the panel shows).
 */
export async function wslInstallCall(host: WslHost, key: string, name: string, action: 'start' | 'cancel' | 'status', agent: unknown): Promise<Reply> {
  if (typeof agent !== 'string' || !WSL_MANAGED.includes(agent)) return [400, { error: 'AIB cannot install that agent in WSL.', code: 'install_refused' }];
  const params = installParams(agent);
  if (!params) return [409, { error: `AIB has no reviewed version of ${agentName(agent)} to install.`, code: 'install_refused' }];
  followInstalls(host, key);
  const method = action === 'start' ? 'agents.install' : action === 'cancel' ? 'agents.installCancel' : 'agents.installStatus';
  try {
    const view = await host.call(method, params, { timeoutMs: action === 'cancel' ? 75_000 : 30_000 });
    return [200, { ...view, ok: true }];
  } catch (error) {
    if (!(error instanceof WslHelperError)) throw error;
    if (error.code === 'install_refused') return [409, { error: error.message, code: error.code }];
    if (error.code.startsWith('node_') || error.code === 'npm_missing') {
      let version = '';
      try {
        version = (await host.call('agents.installCheck', {})).nodeVersion;
      } catch { /* the line goes without the version */ }
      return [409, { error: nodeBlockLine(error.code, agent, name, version), code: error.code, nodeInstall: NODE_INSTALL }];
    }
    if (error.code === 'unknown_method') {
      return [409, { error: `The AIB helper in ${name} is too old to install agents. Restart AIB.`, code: 'install_refused' }];
    }
    // The helper is restarting: a status read answers the last progress it sent, so the page keeps its bar instead of an error
    const last = action === 'status' ? lastProgress(key, agent) : null;
    if (last) return [200, { ...last, ok: true, stale: true }];
    return [400, { error: error.message, code: error.code }];
  }
}

/**
 * The install facts of the agent panel's rows (GET /api/live/wsl/agents): `installable`, `pinned`, `managed` (AIB's own install
 * runs), `update` (AIB's install is older than the pinned version), `job` (an install that runs or failed), and, when an install or
 * update is what the row offers but cannot run yet, `installBlock` (one line) with `nodeInstall` (the command that fixes it).
 */
export async function installFacts(
  host: WslHost,
  key: string,
  name: string,
  rows: { id: string; found: boolean; version?: string; source?: string }[],
  force = false,
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  const methods = (host as { methods?: string[] }).methods;
  if (Array.isArray(methods) && !methods.includes('agents.install')) return out; // an older helper: the copyable command only
  followInstalls(host, key);
  let check: { code: string; nodeVersion: string } | null = null;
  for (const row of rows) {
    const params = installParams(row.id);
    if (!params) continue;
    const managed = row.found && row.source === 'studio';
    const facts: Record<string, unknown> = { installable: true, pinned: params.entry.version, managed };
    if (managed && row.version && row.version !== params.entry.version) facts.update = true;
    if (!row.found || facts.update) {
      try {
        const job = await host.call('agents.installStatus', params, { timeoutMs: 10_000 });
        if (job.state === 'running' || job.state === 'failed') facts.job = job;
      } catch { /* no job state: the row offers Install */ }
      try {
        check ??= await host.call('agents.installCheck', { force }, { timeoutMs: 20_000 });
        if (check.code) {
          facts.installBlock = nodeBlockLine(check.code, row.id, name, check.nodeVersion);
          facts.nodeInstall = NODE_INSTALL;
        }
      } catch { /* checked again when Install is pressed */ }
    }
    out[row.id] = facts;
  }
  return out;
}
