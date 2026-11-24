/**
 * Track C's one door to the WSL hosts (docs/wsl/design.md sections 2, 4, 5, 8): agents, terminals, the Files view and Changes of a WSL
 * project reach their distro only through here. It wraps Track B's registry (wsl/hosts.ts `wslHosts()`) and distro list (wsl/detect.ts),
 * so tests put a FakeWslHost in with setWslHostResolver and never need a real distro. Pure helpers for refs, names and the Linux side
 * of an agent spawn live here too. Nothing here touches Windows files for a WSL path.
 */
import type { KeeperLink } from '../keeper/link.ts';
import { type HelperMethods, WslHelperError, type WslHost } from './contract.ts';
import { wslHosts, wslHostsInUse } from './hosts.ts';
import { detectWsl, type WslDistro } from './detect.ts';
import { locOf } from '../platform/location.ts';
import { ValueError } from '../core/py.ts';
import { urlGate } from './open_urls.ts';
import { mcpTunnelGate } from './mcp_tunnel.ts';
import { WSL_TOOL_GROUPS } from '../artifacts/mcp.ts';
import { isDistroRemoved } from './removed.ts';

/** A distro of this PC as the page and the routes see it (wsl/detect.ts WslDistro). */
export type DistroInfo = Pick<WslDistro, 'name' | 'version'> & Partial<WslDistro>;

type Resolver = (distro: string) => WslHost | null;
let resolver: Resolver | null = null;
let distroSource: (() => Promise<DistroInfo[]>) | null = null;
/** Display names by folded key, from the last distro list (a ref keeps only the folded name). */
const names = new Map<string, string>();
const watched = new WeakSet<WslHost>();

/** Tests: where wslHost() gets its hosts (null: Track B's registry). */
export function setWslHostResolver(fn: Resolver | null): void {
  resolver = fn;
}

/** Tests: where wsl2Distros() gets the distro list (null: wsl/detect.ts). */
export function setDistroSource(fn: (() => Promise<DistroInfo[]>) | null): void {
  distroSource = fn;
  names.clear();
}

/** {distro, linuxPath} of a WSL ref, or null for a Windows path. The distro is the folded key the ref holds. */
export function wslLoc(path: unknown): { distro: string; linuxPath: string } | null {
  if (typeof path !== 'string') return null;
  const loc = locOf(path);
  return loc?.kind === 'wsl' ? { distro: loc.distro, linuxPath: loc.linuxPath } : null;
}

export function isWslPath(path: unknown): boolean {
  return wslLoc(path) !== null;
}

/**
 * The host of a distro (by any casing) for work in it, or null when AIB has none for it (not a WSL2 distro of this PC, or AIB has no
 * WSL set-up: no data folder). The first time, the distro starts in the background (its state says how far it is: notReady) and its
 * URL requests go through the gate.
 */
export function wslHost(distro: string): WslHost | null {
  const key = String(distro).toLowerCase();
  if (isDistroRemoved(key)) return null; // AIB removed itself from it: nothing starts it (or installs AIB) until "Set up again"
  let host: WslHost | null = null;
  try {
    host = resolver ? resolver(key) : wslHosts()?.get(key) ?? null;
  } catch {
    host = null;
  }
  if (host && !watched.has(host)) {
    watched.add(host);
    urlGate.watch(host);
    mcpTunnelGate.watch(host); // tool calls from the distro's agents (phase 2 tunnel)
  }
  const begun = host as (WslHost & { begun?: boolean }) | null;
  if (begun && begun.begun === false) host!.start().catch(() => {}); // the failure is the host's state and note
  return host;
}

/** The host of a distro only if this AIB already uses it (status lines, saved sessions): never makes or starts one. */
export function peekWslHost(distro: string): WslHost | null {
  const key = String(distro).toLowerCase();
  if (isDistroRemoved(key)) return null; // removed: reads as 'off'
  try {
    return resolver ? resolver(key) : wslHostsInUse()?.peek(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The state the page shows for a host from peekWslHost, never starting it: 'off' when there is none or nothing has asked it to start
 * yet (on this PC, but AIB has not used it since it started), else the host's own state.
 */
export function peekState(host: WslHost | null): WslHost['state'] | 'off' {
  return !host || (host as WslHost & { begun?: boolean }).begun === false ? 'off' : host.state;
}

/**
 * The host of a distro once it is ready, starting it when needed and waiting up to `timeoutMs` (the first start after a Windows
 * boot, or the first-time set-up, takes a while). ValueError with the line the user sees when it does not get ready.
 */
export async function hostWhenReady(distro: string, timeoutMs = 180_000): Promise<WslHost> {
  const host = wslHost(distro);
  const deadline = Date.now() + timeoutMs;
  // A start that failed only because the helper was being replaced (an earlier AIB's helper too old to take over, a helper that
  // ended while it started) is tried again within the wait: the next start makes a fresh helper. Anything else is answered at once.
  for (let attempt = 0; host && host.state !== 'ready' && attempt < START_TRIES; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      host.start().then(() => null, (error: unknown) => error ?? new Error('not ready')),
      new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())))),
    ]);
    clearTimeout(timer);
    if (outcome === null || outcome === 'timeout' || !retriableStart(outcome)) break;
    const wait = Math.min(START_RETRY_MS * 2 ** attempt, deadline - Date.now());
    if (wait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return readyHost(distro);
}

/** How often hostWhenReady starts a distro whose helper was being replaced, and the first pause between starts (doubling). */
const START_TRIES = 4;
const START_RETRY_MS = 500;
/** The helper failures a second start fixes (wsl/hosts.ts WslHelperError codes): the helper itself was replaced or ended. */
const RETRIABLE_START = new Set(['helper_restart', 'helper_exited', 'helper_gone', 'helper_timeout']);

function retriableStart(error: unknown): boolean {
  return error instanceof WslHelperError && RETRIABLE_START.has(error.code);
}

/** The WSL2 distros of this PC (WSL1 is refused in phase 1). Never throws: none when WSL is missing or detection fails. */
export async function wsl2Distros(): Promise<DistroInfo[]> {
  let found: DistroInfo[] = [];
  try {
    found = distroSource ? await distroSource() : detectWsl().distros;
  } catch {
    found = [];
  }
  const two = found.filter((d) => d && typeof d.name === 'string' && d.version === 2);
  for (const d of two) names.set(d.name.toLowerCase(), d.name);
  return two;
}

/**
 * WSL on this PC for Settings (GET /api/live/wsl/status): whether wsl.exe is there, why nothing is offered ('' when something is),
 * the WSL2 distros AIB can use (WSL's default first, `isDefault`) and the ones left out with why (WSL1, another app's distro, not fully
 * installed). From the registry only (wsl/detect.ts): never runs wsl.exe, never starts a distro. Never throws.
 */
export async function wslOverview(): Promise<{
  exe: boolean;
  problem: string;
  distros: DistroInfo[];
  skipped: { name: string; why: string }[];
}> {
  if (distroSource) {
    // tests: a distro list; the WSL1 ones are what the registry would leave out
    let found: DistroInfo[] = [];
    try {
      found = (await distroSource()).filter((d) => d && typeof d.name === 'string');
    } catch {
      found = [];
    }
    const distros = found.filter((d) => d.version === 2);
    for (const d of distros) names.set(d.name.toLowerCase(), d.name);
    const skipped = found.filter((d) => d.version !== 2).map((d) => ({
      name: d.name,
      why: 'it is a WSL1 distro; convert it with `wsl --set-version <name> 2`',
    }));
    return { exe: true, problem: distros.length ? '' : skipped.length ? 'No WSL2 distro AIB can use' : 'No WSL distro', distros, skipped };
  }
  let seen: ReturnType<typeof detectWsl>;
  try {
    seen = detectWsl();
  } catch (error) {
    const problem = `WSL could not be checked (${error instanceof Error ? error.message : error})`;
    return { exe: false, problem, distros: [], skipped: [] };
  }
  for (const d of seen.distros) names.set(d.name.toLowerCase(), d.name);
  return {
    exe: !!seen.wslExe,
    problem: seen.problem,
    distros: seen.distros.filter((d) => d.version === 2),
    skipped: seen.skipped.map((s) => ({ name: s.name, why: s.why })),
  };
}

/** The distro as the user named it ("Ubuntu"), from its host or the last distro list; else the key itself. */
export function distroName(distro: string): string {
  const key = String(distro).toLowerCase();
  return peekWslHost(key)?.distro || names.get(key) || detectWsl().distros.find((d) => d.name.toLowerCase() === key)?.name || distro;
}

/** The Linux keeper link of a host (contract.ts types it unknown: it is a KeeperLink). */
export function linkOf(host: WslHost): KeeperLink {
  return host.link as KeeperLink;
}

/** What a WSL chat, Files view or terminal says while AIB is removed from its distro (wsl/removed.ts). */
export function removedLine(name: string): string {
  return `AIB was removed from ${name}. To use it there again, open Settings > AIB Linking (WSL) and click Set up again.`;
}

/** '' when the host can take work now, else the line the user sees (its note, or what the state means). */
export function notReady(host: WslHost | null, distro: string): string {
  const name = distroName(distro);
  if (!host && isDistroRemoved(distro)) return removedLine(name);
  if (!host) return `${name} is not available to AIB.`;
  if (host.state === 'ready') return '';
  if (host.note) return host.note;
  if (host.state === 'starting') return `Starting ${name}…`;
  if (host.state === 'installing') return `Setting up AIB in ${name} (first time, ~100 MB)`;
  if (host.state === 'reconnecting') return `Reconnecting to ${name}…`;
  if (host.state === 'stopped') return `${name} stopped. Reconnect`;
  return `${name} is not available to AIB.`;
}

/** The host of a distro when it is ready, else ValueError with the line the user sees. */
export function readyHost(distro: string): WslHost {
  const host = wslHost(distro);
  const why = notReady(host, distro);
  if (why) throw new ValueError(why);
  return host!;
}

/** A helper call on a ready host. */
export function helperCall<M extends keyof HelperMethods>(
  distro: string,
  method: M,
  params: HelperMethods[M]['params'],
  opts?: { timeoutMs?: number },
): Promise<HelperMethods[M]['result']> {
  return readyHost(distro).call(method, params, opts);
}

/** The title of a distro terminal: the shell's name and the distro, "bash (Ubuntu)". */
export function shellTitle(shell: string, distro: string): string {
  const base = String(shell || 'bash').split('/').pop() || 'bash';
  return `${base} (${distroName(distro)})`;
}

/**
 * A Windows path as WSL sees it under its default automount root: `C:\Users\u\x.exe` -> `/mnt/c/Users/u/x.exe`. null for anything
 * that is not a drive path (a UNC path never crosses).
 */
export function windowsPathInWsl(path: string): string | null {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(path));
  if (!match) return null;
  const rest = match[2].split(/[\\/]+/).filter(Boolean).join('/');
  return `/mnt/${match[1].toLowerCase()}/${rest}`;
}

/** Phase 1 without the interop MCP entry: what the chat says instead of failing silently (design section 8, item 5). */
export const WSL_TOOLS_NOTICE = 'AIB tools (docs, artifacts, merge) are not available in WSL projects yet.';
/** With the interop MCP entry: the artifact tools that need no project file (section 11 decision), docs, and merge for a chat in its own copy. */
export const WSL_TOOLS_LIMITED = "In WSL projects, AIB tools are limited to artifacts (publish, list, update), docs and merging a chat's own copy.";

const MERGE_TOOLS = "merging a chat's own copy";
/** The artifacts part of the note: publish and update take the text or a file inside the project (images too), as a snapshot. */
const WSL_ARTIFACTS_PART = 'artifacts (publish and update by content or by a file path inside the project, images included; list, archive)';

/**
 * What a WSL chat with AIB tools says about them (tunnel or interop: the same tools), worded from mcp.ts WSL_TOOL_GROUPS so a group
 * switched on there shows here too. With today's groups: "In WSL projects, AIB tools cover artifacts (publish and update by content
 * or by a file path inside the project, images included; list, archive), docs and merging a chat's own copy; helper chats are not
 * available yet."
 */
export function wslToolsNotice(groups: Readonly<Record<'artifacts' | 'merge' | 'swarm' | 'docs', boolean>> = WSL_TOOL_GROUPS): string {
  const on: string[] = [];
  const off: string[] = [];
  (groups.artifacts ? on : off).push(groups.artifacts ? WSL_ARTIFACTS_PART : 'artifacts');
  (groups.docs ? on : off).push('docs');
  (groups.merge ? on : off).push(MERGE_TOOLS);
  (groups.swarm ? on : off).push('helper chats');
  const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  if (!on.length) return WSL_TOOLS_NOTICE;
  const verb = off.length === 1 && off[0] === MERGE_TOOLS ? 'is' : 'are'; // "helper chats are", "merging ... is"
  return `In WSL projects, AIB tools cover ${list(on)}${off.length ? `; ${list(off)} ${verb} not available yet` : ''}.`;
}

/** Install commands the agent picker shows for an agent missing in a distro (the user runs them; AIB never runs npm in phase 1). */
export const WSL_INSTALL: Readonly<Record<string, string>> = {
  claude: 'npm i -g @agentclientprotocol/claude-agent-acp',
  codex: 'npm i -g @agentclientprotocol/codex-acp',
};

/**
 * Under test (AGENT_STUDIO_TEST=1), the home a WSL agent gets: HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and the XDG folders inside the
 * test's AIB_WSL_ROOT, so a test never reads or writes the owner's Linux ~/.claude or ~/.codex. {} outside tests.
 */
export function wslTestHomeEnv(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): Record<string, string> {
  if (env('AGENT_STUDIO_TEST') !== '1') return {};
  const root = env('AIB_WSL_ROOT') ?? '';
  if (!root.startsWith('/')) {
    throw new ValueError('Test guard: a WSL agent under test needs AIB_WSL_ROOT (an absolute Linux temp folder)');
  }
  const home = root.replace(/\/+$/, '') + '/home';
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: home + '/.claude',
    CODEX_HOME: home + '/.codex',
    XDG_CONFIG_HOME: home + '/.config',
    XDG_DATA_HOME: home + '/.local/share',
    XDG_STATE_HOME: home + '/.local/state',
    XDG_CACHE_HOME: home + '/.cache',
  };
}

/**
 * The test guard for agents in a distro: under test, a WSL agent may only be a fixture copied into the test's AIB_WSL_ROOT (or a
 * Windows fixture under work/, which a FakeWslHost runs). Anything else would start a real agent in the owner's distro.
 */
export function guardRealWslAgent(command: string[], windowsFixture: boolean, env: (name: string) => string | undefined = (n) => Deno.env.get(n)): void {
  if (env('AGENT_STUDIO_TEST') !== '1' || env('STUDIO_REAL_ADAPTER_TESTS') === '1' || env('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1') return;
  if (windowsFixture) return;
  const root = (env('AIB_WSL_ROOT') ?? '').replace(/\/+$/, '');
  if (root.startsWith('/') && command.some((part) => String(part).startsWith(root + '/'))) return;
  throw new ValueError(`Test guard: refusing to start a real agent in WSL: ${JSON.stringify(command)}. Use a fixture inside AIB_WSL_ROOT.`);
}
