/**
 * Helpers the web server and the in-process Studio both use (studio_shared.py): the agent list of the Settings page and the New chat
 * dropdown, the install and sign-in rows read from their job files, the banner notices, and the validated conversation action.
 *
 * The "studio" argument is a small interface (StudioContext) so server/web/server.ts can pass its own context: the options, the
 * settings and conversation stores, the agent host's live list and calls, and a worktree lookup. JSON keys and messages are Python's.
 */
import * as adapters from '../agents/adapters.ts';
import { BUILTIN_NAMES, commandStatus, type CustomAgent, hiddenEnv, letterOf } from '../agents/agent_registry.ts';
import * as installer from '../agents/installer.ts';
import * as signin from '../agents/signin.ts';
import { isDict, ValueError } from '../core/py.ts';
import { codeWarning, HostUnavailable } from '../host/host_client.ts';
import { packageContext, packageLabel } from '../state/paths.ts';
import { Registry } from '../worktrees/worktrees.ts';

/** The command-line options these helpers read (server/core/options.ts has them all; migration comes from the state-folder setup). */
export interface AgentOptions {
  stateDir?: string | null;
  nodeCommand?: string;
  ompCommand?: string;
  claudeLauncher?: string;
  codexLauncher?: string;
  migration?: Record<string, unknown> | null;
}

export interface SettingsLike {
  launcher(agentId: string): string;
  snapshot(): { agents: { builtin: Record<string, boolean>; custom: CustomAgent[] } };
  public(): Record<string, unknown>;
}

export interface ConversationsLike {
  apply(
    action: unknown,
    provider: unknown,
    sessionId: unknown,
    title?: unknown,
    cwd?: unknown,
    agentDeleted?: unknown,
    note?: unknown,
    projectRoot?: unknown,
  ): Promise<unknown> | unknown;
  revision(): string;
}

/** What the web server (or an in-process Studio) passes as `self`. */
export interface StudioContext {
  options: AgentOptions;
  settings: SettingsLike;
  conversations: ConversationsLike;
  liveList(): Promise<Record<string, unknown>> | Record<string, unknown>;
  liveCall(name: string, body: unknown): Promise<[number, unknown]> | [number, unknown];
  studioOwns(provider: unknown, sessionId: unknown): Promise<boolean> | boolean;
  /** The agent host's info (its code hash and version), for the "older code" warning. */
  hostInfo?: unknown;
  /** Chats another AIB version still has working: this one switches over when they finish. */
  waitingChats?: number;
  /** The chat's own Studio worktree, or null/undefined. Default: worktrees Registry(options.stateDir).find(null, session). */
  findWorktree?(session: string): unknown | Promise<unknown>;
}

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** The adapters lookup for one built-in agent: flag, then Settings, then Studio's own install, then the global adapter. */
export async function builtinLaunch(
  options: AgentOptions,
  settings: Pick<SettingsLike, 'launcher'> | null,
  agentId: string,
): Promise<adapters.LaunchRow> {
  const node = options.nodeCommand || '';
  if (agentId === 'omp') return adapters.resolveOmp(options.ompCommand || '');
  const flag = String((agentId === 'claude' ? options.claudeLauncher : agentId === 'codex' ? options.codexLauncher : '') || '');
  const saved = settings !== null ? settings.launcher(agentId) : '';
  const stateDir = options.stateDir ?? null; // Studio's own installs live under it; read fresh on every call
  const resolve = agentId === 'claude' ? adapters.resolveClaude : adapters.resolveCodex;
  return await resolve({ flag, saved, nodeCommand: node, stateDir });
}

/** The Studio install job of a built-in agent while it is running or has failed, else null. Read from the job's state file. */
export function installState(options: AgentOptions, agentId: string): installer.InstallView | null {
  const stateDir = options.stateDir;
  if (!stateDir || !hasOwn(adapters.STUDIO_PACKAGES, agentId)) return null;
  const view = installer.readStatus(stateDir, agentId);
  return view.state === 'running' || view.state === 'failed' ? view : null;
}

export interface SigninView {
  state: signin.SignState;
  checkedAt: number;
  job: signin.JobView | null;
}

/** The Status column of a built-in agent, read from disk only (the cache and the job file); an open chat overrides the cache. */
export function signinView(options: AgentOptions, agentId: string, liveStatus = ''): SigninView | null {
  const stateDir = options.stateDir;
  if (!stateDir || !hasOwn(adapters.STUDIO_PACKAGES, agentId)) return null;
  const cached = signin.readCached(stateDir, agentId);
  const job = signin.readJob(stateDir, agentId);
  return { state: signin.effectiveState(cached.state, liveStatus), checkedAt: cached.checkedAt, job: job.state !== 'idle' ? job : null };
}

/**
 * The agent list the Settings page and the New chat dropdown read: built-ins first, then user-added agents.
 * status is '' (nothing known), 'running' (a chat of this agent is open and ready) or 'signin' (an open chat waits for sign-in);
 * it comes from chats already open, so nothing is started to find it out.
 */
export async function describeAgents(
  options: AgentOptions,
  settings: Pick<SettingsLike, 'launcher' | 'snapshot'>,
  connections: unknown[] = [],
  recheck = false,
): Promise<Record<string, unknown>[]> {
  const state: Record<string, string> = {};
  for (const c of connections ?? []) {
    if (!isDict(c) || c.closed) continue;
    const provider = String(c.provider);
    if (c.auth) state[provider] = 'signin';
    else if (c.ready && state[provider] !== 'signin') state[provider] = 'running';
  }
  const snap = settings.snapshot();
  const out: Record<string, unknown>[] = [];
  let block = '';
  let nodeFound = true;
  let sizes: Record<string, unknown> = {};
  if (Object.keys(adapters.STUDIO_PACKAGES).length) {
    try {
      [block, nodeFound] = await installer.nodeBlock(options.nodeCommand || '', recheck);
      const list = installer.loadAllowList();
      sizes = Object.fromEntries(Object.entries(list).map(([k, v]) => [k, isDict(v) ? v.packageBytes : undefined]));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !(error.name === 'ValueError' || error instanceof Deno.errors.NotFound || error instanceof Deno.errors.PermissionDenied)
      ) {
        throw error;
      }
    }
  }
  for (const [agentId, letter] of [['omp', 'O'], ['claude', 'C'], ['codex', 'X']] as const) {
    const row = await builtinLaunch(options, settings, agentId);
    const installable = hasOwn(adapters.STUDIO_PACKAGES, agentId);
    // `launcher`: read-only text for Settings saying which program starts this agent (and where it came from)
    out.push({
      id: agentId,
      name: BUILTIN_NAMES[agentId],
      letter,
      builtin: true,
      enabled: snap.agents.builtin[agentId],
      command: row.text,
      launcher: row.text,
      launcherSource: row.source,
      args: [],
      env: [],
      found: row.found,
      resolved: row.found ? row.path : '',
      problem: row.problem,
      status: state[agentId] ?? '',
      install: installState(options, agentId),
      installable,
      installBlock: installable && row.source === 'missing' ? block : '',
      installHint: agentId === 'codex' && !nodeFound && row.source === 'missing'
        ? 'Or install it yourself with: ' + adapters.CODEX_INSTALL
        : '',
      packageBytes: sizes[agentId] || 0,
      signin: row.found ? signinView(options, agentId, state[agentId] ?? '') : null,
    });
  }
  for (const a of snap.agents.custom) {
    const [found, problem] = commandStatus(a.command);
    out.push({
      id: a.id,
      name: a.name,
      letter: letterOf(a.name),
      builtin: false,
      enabled: a.enabled,
      command: a.command,
      launcher: a.command,
      launcherSource: 'custom',
      args: [...a.args],
      env: hiddenEnv(a.env),
      found: !!found,
      resolved: found,
      problem,
      status: state[a.id] ?? '',
    });
  }
  return out;
}

function quietError(error: unknown): boolean {
  return error instanceof HostUnavailable ||
    (error instanceof Error && ['ValueError', 'RuntimeError', 'OSError'].includes(error.name)) ||
    Object.values(Deno.errors).some((type) => error instanceof type);
}

/** GET /api/live/settings: the stored settings, the agent list with live status, and the revision other windows compare. */
export async function settingsView(self: StudioContext, recheck = false): Promise<Record<string, unknown>> {
  let connections: unknown[] = [];
  try {
    const listed = (await self.liveList()).connections;
    connections = Array.isArray(listed) ? listed : [];
  } catch (error) {
    if (!quietError(error)) throw error;
    connections = [];
  }
  return {
    ...self.settings.public(),
    agents: await describeAgents(self.options, self.settings, connections, recheck),
    ...(await notices(self)),
  };
}

let packageCache: { value: string | null } | null = null; // packageContext() of this process (it cannot change while running)

/** The amber line when Studio itself runs inside a packaged app's sandbox (its data is then in that app's private folder). */
export function packageNotice(pkg: string | null | undefined, stateDir: unknown): string {
  if (!pkg) return '';
  return `Studio is running inside ${packageLabel(pkg)}'s sandbox, so its data is stored in that app's private folder (${stateDir}). ` +
    'Restart Studio from outside that app to use your normal data folder.';
}

/** The line for a data folder held in a packaged app's sandbox that this (unpackaged) Studio did not move: waiting, conflict, or refused. */
export function sandboxNotice(migration: Record<string, unknown> | null | undefined): string {
  const m = migration || {};
  if (m.kind !== 'sandbox' || m.state === undefined || m.state === null || m.state === 'none') return '';
  const left = (m.worktreesLeft as number) || 0;
  if (m.state === 'done') {
    return left
      ? `${left} chat worktree${left !== 1 ? 's' : ''} stay${left !== 1 ? '' : 's'} in the old folder (${
        pyText(m.source)
      }): moving a git worktree would break its link to the repository. ` +
        'Nothing was deleted there.'
      : '';
  }
  const source = m.source ? pyText(m.source) : "the Claude app's private folder";
  if (m.state === 'conflict') {
    return `Studio data exists in two places: your normal folder and the Claude app's private folder (${source}). Studio is using the normal folder ` +
      'and has not merged or overwritten anything. Decide which one to keep and move the other aside; Studio will not choose for you.';
  }
  if (m.state === 'waiting') {
    return `Waiting to move your data from the Claude app's private folder (${source}): ${
      m.reason ? pyText(m.reason) : 'something there is still running'
    }. ` +
      'Studio keeps using that folder for now and tries again at its next start, once no chat is working and the agent host there has stopped.';
  }
  return `Moving your data from the Claude app's private folder (${source}) did not happen: ${
    m.reason ? pyText(m.reason) : pyText(m.state)
  }. Studio is using your normal folder.`;
}

/** f'{value}' for the values a migration record holds (strings, numbers, None). */
function pyText(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

/**
 * What the page may show as a banner: migration, hostCodeWarning (the running agent host loaded older code than this web server),
 * packageNotice, sandboxNotice, packageContext and hostTakeoverWaiting.
 */
export async function notices(self: Pick<StudioContext, 'options' | 'hostInfo' | 'waitingChats'>): Promise<Record<string, unknown>> {
  packageCache ??= { value: packageContext() };
  const migration = self.options.migration || { state: 'none' };
  return {
    migration,
    hostCodeWarning: await codeWarning(self.hostInfo ?? null),
    packageContext: packageCache.value,
    packageNotice: packageNotice(packageCache.value, self.options.stateDir ?? ''),
    sandboxNotice: sandboxNotice(migration),
    hostTakeoverWaiting: self.waitingChats || 0,
  };
}

/** Validated pin/archive/delete/restore request. Returns [status, payload]. Throws ValueError (a 400) for a bad request. */
export async function conversationAction(self: StudioContext, body: unknown): Promise<[number, Record<string, unknown>]> {
  if (!isDict(body)) throw new ValueError('Invalid request');
  const { action, provider, sessionId } = body;
  if (action === 'delete' && await self.studioOwns(provider, sessionId)) {
    return [409, {
      error: 'This conversation is live in Studio. End the Studio session first; nothing was deleted.',
      code: 'session_live',
    }];
  }
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const entry = await self.conversations.apply(
    action,
    provider,
    sessionId,
    str(body.title),
    str(body.cwd),
    false,
    str(body.note),
    str(body.projectRoot),
  );
  const payload: Record<string, unknown> = { ok: true, entry, revision: self.conversations.revision() };
  if ((action === 'archive' || action === 'delete') && typeof provider === 'string' && typeof sessionId === 'string') {
    const removal = await worktreeAfter(self, provider, sessionId);
    if (removal !== null && removal !== undefined) payload.worktree = removal;
  }
  return [200, payload];
}

/**
 * A chat in its own Studio worktree that is archived or deleted: ask the side that owns the agents to remove a worktree without
 * changes; one with changes is kept. null for every other chat (nothing is called). Never fails the action.
 */
export async function worktreeAfter(
  self: Pick<StudioContext, 'findWorktree' | 'liveCall' | 'options'>,
  provider: string,
  sessionId: string,
): Promise<unknown> {
  let status: number;
  let answer: unknown;
  try {
    const session = `${provider}:${sessionId}`;
    const found = self.findWorktree ? await self.findWorktree(session) : new Registry(String(self.options.stateDir)).find(null, session);
    if (!found) return null;
    [status, answer] = await self.liveCall('worktree-archive', { provider, sessionId });
  } catch (error) {
    console.error("Checking the chat's worktree after archive failed", error);
    return null;
  }
  return status === 200 && isDict(answer) ? answer.worktree ?? null : null;
}
