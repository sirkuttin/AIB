/**
 * WSL projects on the page (docs/wsl/design.md sections 4 and 8; Deno only: routes.ts DENO_ONLY). Every route needs AIB token, like
 * the Files routes, and reaches a distro only through wsl/access.ts.
 *   GET  /api/live/wsl/status                      {available, distros: [{name, key, state, line, home, helper, problem, alwaysAllow,
 *                                                   isDefault, removed}], openRequests: [{id, distro, name, url, at}], wsl: {exe, problem},
 *                                                   skipped: [{name, why}]}: the Location choice, the distro state line, Settings > About
 *                                                   and AIB Linking (WSL), and the URLs waiting for "Open" (wsl/open_urls.ts). The
 *                                                   registry only (never wsl.exe), never starts a distro. removed: AIB removed itself
 *                                                   from that distro (state 'off' until the next explicit start: wsl/removed.ts)
 *   GET  /api/live/wsl/aib?distro[&peek=1[&start=1]][&force=1]  "AIB in <distro>" (phase 3, linking-design section 13): not ready
 *                                                   -> {distro, name, state, line, usage: null}; ready -> {distro, name, state: 'ready',
 *                                                   line: '', usage: AibUsage} (helper aib.usage; chatsWorking from AIB's busy chats)
 *   POST /api/live/wsl/aib/remove {distro, mode: 'check'|'apply', confirm?}  Remove AIB from the distro (wsl/remove.ts): {ok, mode,
 *                                                   blocked, wouldRemove, kept, removed, left, message?}; 'apply' needs confirm: true
 *                                                   (400 confirm_needed). Never starts the distro (409 wsl_unavailable)
 *   Every start=1 (and Reconnect) is also "Set up again": it clears the removed flag, so the distro's next start installs AIB again
 *   GET  /api/live/wsl/dirs?distro&path            the New / Add project folder browser: fs.listDirs in the distro ('' = its home)
 *   GET  /api/live/wsl/agents?distro[&force=1][&peek=1[&start=1]]  the agent picker: which agents the distro has, the install
 *                                                   command of the others, and AIB's own install of Claude Code / Codex (installable,
 *                                                   pinned, update, job, installBlock + nodeInstall when Node.js is missing; force: look
 *                                                   for Node.js again; bundledCli: the adapter's own vendor program was found). peek=1
 *                                                   (Settings) never starts the distro: not ready -> {distro, name, state, line,
 *                                                   agents: []}, ready -> the same plus state 'ready'; start=1 with it starts it
 *                                                   Every row also has (Linking (WSL) phase 2, docs/wsl/linking-design.md section 12):
 *                                                   enabled (the distro's own On/Off switch, settings agentsByDistro; on when unset),
 *                                                   signin {state: 'signed_in'|'signed_out'|'unknown', account?, note?} (helper
 *                                                   agents.signinStatus; 'unknown' with a note when the helper cannot say),
 *                                                   canUninstall (AIB's own install: source 'studio'); the Codex row limits (the
 *                                                   Limits chip's snapshot from that distro's ~/.codex, null when none)
 *   POST /api/live/wsl/agents/enabled {distro, id, enabled}  the distro's On/Off switch of an agent -> {ok, enabled}; a WSL chat reads
 *                                                   only this switch, never the Windows one (host/aib.ts wslLaunch)
 *   POST /api/live/wsl/agents/uninstall {distro, id}  remove AIB's own install of Claude Code / Codex in the distro (helper
 *                                                   agents.uninstall) -> {ok, removed, message?, blocked?}; refused (ok false, blocked:
 *                                                   the reason, verbatim) while its install job or its sign-in runs, or when the helper
 *                                                   refuses (a chat runs from it). Never starts the distro
 *   GET  /api/live/wsl/prereqs?distro[&peek=1[&start=1]][&force=1]  what the distro has for AIB's agents (helper env.prereqs; force:
 *                                                   read the login PATH again). peek=1 never starts the distro: not ready ->
 *                                                   {distro, name, state, line, prereqs: null}; ready -> {distro, name, state: 'ready',
 *                                                   line: '', prereqs: EnvPrereqs}. start=1 with it starts it (the click)
 *   GET  /api/live/wsl/agents/install?distro&agent[&start=1]  the install job in the distro (wsl/agent_install.ts; the job runs in its
 *                                                   helper). Never starts the distro without start=1: not ready -> {ok, state: 'idle',
 *                                                   distro, name, distroState, line} (while AIB brings it back: the last progress, stale)
 *   POST /api/live/wsl/agents/install {distro, agent}         "Install in Ubuntu" / "Update in Ubuntu": start (or join) the job
 *   POST /api/live/wsl/agents/install/cancel {distro, agent}  Cancel: the job's npm is killed and its half-made folder removed
 *   POST /api/live/wsl/reconnect {distro}          "Reconnect" on a stopped distro's state line
 *   POST /api/live/wsl/open-url {id, action}       the page's answer to "Ubuntu wants to open <url>": open, always (for that distro), dismiss
 * Plus the Files view of a WSL project (wslFiles, called by files_routes.ts): list, search and read through the distro's helper.
 */
import { pageAllowed, type Principal } from './security.ts';
import { Memo } from '../core/memo.ts';
import { issueBytes } from './file_tickets.ts';
import type { WebContext } from './server.ts';
import { parseQs } from '../artifacts/origin.ts';
import { type AibUsage, WslHelperError, type WslHost } from '../wsl/contract.ts';
import { refOf, type WslLoc } from '../platform/location.ts';
import { distroName, hostWhenReady, notReady, peekState, peekWslHost, WSL_INSTALL, wslHost, wslLoc, wslOverview } from '../wsl/access.ts';
import { urlGate } from '../wsl/open_urls.ts';
import { noMethod } from '../wsl/local_only.ts';
import { extOf, type FileRead, IMAGE_EXT, LIMITS, PAGE_EXT } from '../worktrees/files.ts';
import { BUILTIN_IDS } from '../agents/agent_registry.ts';
import { installFacts, lastProgress, wslInstallCall, wslUninstallCall } from '../wsl/agent_install.ts';
import { distroAgentId, type SettingsStore } from '../state/settings.ts';
import { wslCodexLimits } from '../host/usage_limits_feed.ts';
import { wslHostsInUse } from '../wsl/hosts.ts';
import { removeAib, realSteps } from '../wsl/remove.ts';
import { clearDistroRemoved, isDistroRemoved } from '../wsl/removed.ts';

type Reply = [number, unknown];
type Handler = (ctx: WebContext, url: URL, body: unknown, request: Request, principal?: Principal) => Promise<Reply>;

const one = (args: Record<string, string[]>, name: string, fallback = '') => (Object.hasOwn(args, name) ? args[name][0] : fallback);
const DISTRO = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The preview link of a file inside a distro (images, pages, markdown): the bytes the helper sent go into a ticket the artifact origin
 * serves read only (file_tickets.ts issueBytes), exactly as for a Windows file; '' when there is no origin or nothing to show.
 */
export function wslViewUrl(origin: string, ref: string, read: FileRead, bytesB64: string | undefined): string {
  const viewable = (read.image && !read.tooBig) || (read.page && !read.binary && !read.tooBig);
  if (!origin || !viewable || !bytesB64) return '';
  const bytes = Uint8Array.from(atob(bytesB64), (c) => c.charCodeAt(0));
  return origin + '/f/' + issueBytes(ref, bytes) + '/' + encodeURIComponent(read.name) + (/\.(md|markdown)$/i.test(read.name) ? '?view=1' : '');
}

/**
 * The New project dialog's folder check and create for a WSL path: the helper runs the same functions a Windows project uses, with
 * Linux rules; every Linux path in the answer goes back to the page as the project's ref.
 */
export async function wslProjectReply(
  loc: WslLoc,
  call: (host: WslHost, linuxPath: string) => Promise<Record<string, unknown>>,
): Promise<Reply> {
  let host: WslHost;
  try {
    host = await hostWhenReady(loc.distro);
  } catch (error) {
    return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
  }
  try {
    const out = { ...await call(host, loc.linuxPath) };
    for (const key of ['path', 'parent', 'folder']) {
      const value = out[key];
      if (typeof value === 'string' && value.startsWith('/')) out[key] = refOf({ kind: 'wsl', distro: loc.distro, linuxPath: value });
    }
    return [200, out];
  } catch (error) {
    return failed(error);
  }
}

/** A helper failure as a reply: its code, status 400 (409 when the distro is not ready). */
function failed(error: unknown): Reply {
  if (error instanceof WslHelperError) return [error.code === 'not_found' ? 404 : 400, { error: error.message, code: error.code }];
  throw error;
}

/** The distro's line for the state, '' when it is ready (never starts the distro). */
function lineOf(distro: string): string {
  return notReady(peekWslHost(distro), distro);
}

/**
 * The host of a distro for a GET of Settings or the agent picker. peek=1 (Settings): a distro that is not ready is answered as it is
 * (`off`: {distro, name, state, line}), never started; start=1 with it is the "Start Ubuntu and check" click. Without peek (the agent
 * picker of a WSL project) the distro is started and waited for.
 */
async function reach(
  distro: string,
  args: Record<string, string[]>,
): Promise<{ host: WslHost } | { off: { distro: string; name: string; state: string; line: string } } | { reply: Reply }> {
  const key = distro.toLowerCase();
  if (one(args, 'start') === '1') setUpAgain(key); // the click: a distro AIB was removed from gets AIB again
  if (one(args, 'peek') === '1' && one(args, 'start') !== '1') {
    const seen = peekWslHost(key);
    const state = peekState(seen);
    if (!seen || state !== 'ready') return { off: { distro: key, name: distroName(distro), state, line: state === 'off' ? '' : lineOf(key) } };
    return { host: seen };
  }
  try {
    return { host: await hostWhenReady(distro) }; // the first set-up waits here instead of answering 'setting up'
  } catch (error) {
    return { reply: [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }] };
  }
}

/**
 * "Set up again" (an explicit start of a distro AIB removed itself from): the 'removed' flag goes and the stopped host is forgotten,
 * so the next wslHost() makes a fresh one that installs AIB again. Nothing happens for a distro that was not removed.
 */
function setUpAgain(key: string): void {
  if (!isDistroRemoved(key)) return;
  clearDistroRemoved(key);
  wslHostsInUse()?.drop(key);
}

/** A distro's own switch for an agent (on when nothing is saved, or when the context has no settings: tests). */
function distroEnabled(settings: SettingsStore | undefined, key: string, id: string): boolean {
  return settings ? settings.distroAgentEnabled(key, id) : true;
}

type SigninState = { state: 'signed_in' | 'signed_out' | 'unknown'; account?: string; note?: string };

/** Each agent's sign-in in the distro (helper agents.signinStatus); 'unknown' with the reason when the helper cannot say. */
async function signinStates(host: WslHost, ids: string[], name: string): Promise<Record<string, SigninState>> {
  const out: Record<string, SigninState> = {};
  try {
    const answer = await host.call('agents.signinStatus', { ids }, { timeoutMs: 15_000 });
    for (const row of answer.agents ?? []) {
      if (!row || typeof row.id !== 'string' || !['signed_in', 'signed_out', 'unknown'].includes(row.state)) continue;
      out[row.id] = {
        state: row.state,
        ...(typeof row.account === 'string' && row.account ? { account: row.account } : {}),
        ...(typeof row.note === 'string' && row.note ? { note: row.note } : {}),
      };
    }
  } catch (error) {
    const old = error instanceof WslHelperError && ['unknown_method', 'no_method'].includes(error.code);
    const note = old ? `The AIB helper in ${name} cannot check sign-ins yet. Restart AIB.` : `AIB could not check the sign-in in ${name}.`;
    for (const id of ids) out[id] = { state: 'unknown', note };
    return out;
  }
  for (const id of ids) out[id] ??= { state: 'unknown' };
  return out;
}

/** GET /api/live/wsl/status: also the page's poll for URLs waiting to be opened. */
export function wslStatus(ctx: { stateDir?: string | null }): Promise<Record<string, unknown>> {
  // every window polls this; the answer is kept for 2 s (the env.get call into each ready distro was ~1 s of waiting per poll)
  return wslStatusMemo.get('status', () => wslStatusNow(ctx));
}
const wslStatusMemo = new Memo<Record<string, unknown>>(2000, 4);
async function wslStatusNow(ctx: { stateDir?: string | null }): Promise<Record<string, unknown>> {
  urlGate.configure(ctx.stateDir ? String(ctx.stateDir) : null);
  const overview = await wslOverview(); // the registry only: never wsl.exe
  const distros = [];
  for (const d of overview.distros) {
    const key = d.name.toLowerCase();
    const host = peekWslHost(key); // the poll never starts a distro
    const state = peekState(host); // 'off': on this PC, but AIB has not used it since it started
    let home: string | null = null;
    let helper: string | null = null;
    let problem = '';
    if (host && host.state === 'ready') {
      try {
        const env = await host.call('env.get', {}, { timeoutMs: 3000 });
        home = env.home || null;
        helper = host.helperVersion;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    } else if (host && (host.state === 'unavailable' || host.state === 'stopped')) problem = host.note || lineOf(key);
    distros.push({
      name: d.name,
      key,
      state,
      line: state === 'off' ? '' : lineOf(key),
      home,
      helper,
      problem,
      alwaysAllow: urlGate.alwaysAllowed(key),
      isDefault: d.isDefault === true,
      removed: isDistroRemoved(key), // AIB removed itself from it (state 'off' until the next explicit start)
    });
  }
  return {
    available: distros.length > 0,
    distros,
    openRequests: urlGate.waiting().map((r) => ({ ...r, name: distroName(r.distro) })),
    wsl: { exe: overview.exe, problem: overview.problem },
    skipped: overview.skipped,
  };
}

export function wslRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  const guarded = (method: 'GET' | 'POST', path: string, work: (ctx: WebContext, args: Record<string, string[]>, body: Record<string, unknown>) => Promise<Reply>) => {
    routes.set(`${method} ${path}`, async (ctx, url, body, request, principal) => {
      if (!pageAllowed(principal, request.headers, ctx.token)) return [403, { error: 'Invalid local session token' }];
      const args = parseQs(url.search.slice(1));
      const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
      try {
        return await work(ctx, args, fields);
      } catch (error) {
        return failed(error);
      }
    });
  };
  const bodyDistro = (body: Record<string, unknown>) => (typeof body.distro === 'string' ? body.distro : '');
  guarded('GET', '/api/live/wsl/status', async (ctx) => [200, await wslStatus(ctx)]);
  guarded('GET', '/api/live/wsl/dirs', async (_ctx, args) => {
    const distro = one(args, 'distro');
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    let host: WslHost;
    try {
      host = await hostWhenReady(distro); // the first set-up waits here instead of answering 'setting up'
    } catch (error) {
      return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
    }
    let path = one(args, 'path');
    if (path.includes('\0') || path.length > 1024 || (path && !path.startsWith('/'))) return [400, { error: 'Type an absolute Linux path', code: 'bad_path' }];
    if (!path) path = (await host.call('env.get', {})).home || '/';
    return [200, await host.call('fs.listDirs', { path, limit: 500 })];
  });
  guarded('GET', '/api/live/wsl/agents', async (ctx, args) => {
    const distro = one(args, 'distro');
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    const key = distro.toLowerCase();
    const reached = await reach(distro, args);
    if ('reply' in reached) return reached.reply;
    if ('off' in reached) return [200, { ...reached.off, agents: [] }];
    const host = reached.host;
    const found = await host.call('agents.detect', { ids: [...BUILTIN_IDS] });
    const name = distroName(distro);
    const ids = found.agents.map((a) => a.id);
    const [facts, signins, limits] = await Promise.all([
      installFacts(host, key, name, found.agents, one(args, 'force') === '1'),
      signinStates(host, ids, name),
      ids.includes('codex') ? wslCodexLimits(host).catch(() => null) : Promise.resolve(null),
    ]);
    const agents = found.agents.map((a) => ({
      id: a.id,
      found: !!a.found,
      ...(a.version ? { version: a.version } : {}),
      ...(a.note ? { note: a.note } : {}),
      ...(!a.found && WSL_INSTALL[a.id] ? { install: WSL_INSTALL[a.id] } : {}),
      ...(typeof a.bundledCli === 'boolean' ? { bundledCli: a.bundledCli } : {}),
      ...(facts[a.id] ?? {}),
      enabled: distroEnabled(ctx.settings, key, a.id),
      signin: signins[a.id],
      canUninstall: !!a.found && a.source === 'studio',
      ...(a.id === 'codex' ? { limits } : {}),
    }));
    return [200, one(args, 'peek') === '1' ? { distro: key, name, state: 'ready', line: '', agents } : { distro: key, name, agents }];
  });
  guarded('POST', '/api/live/wsl/agents/enabled', async (ctx, _args, body) => {
    const distro = bodyDistro(body);
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    const id = body.id;
    if (!distroAgentId(id)) return [400, { error: 'Choose an agent', code: 'bad_agent' }];
    if (typeof body.enabled !== 'boolean') return [400, { error: 'An agent can only be turned on or off', code: 'bad_enabled' }];
    if (!ctx.settings) return [503, { error: 'Settings are not available', code: 'no_settings' }];
    if (id.startsWith('custom-') && !ctx.settings.customAgent(id)) return [404, { error: 'That agent is not in the list', code: 'bad_agent' }];
    const key = distro.toLowerCase();
    await ctx.settings.update({ agentsByDistro: { [key]: { [id]: body.enabled } } });
    return [200, { ok: true, enabled: ctx.settings.distroAgentEnabled(key, id) }];
  });
  guarded('POST', '/api/live/wsl/agents/uninstall', async (ctx, _args, body) => {
    const distro = bodyDistro(body);
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    const key = distro.toLowerCase();
    const host = peekWslHost(key); // the button is only on a ready distro's card: never started for it
    const why = peekState(host) === 'off' ? `${distroName(distro)} is not running.` : notReady(host, key);
    if (why || !host) return [409, { error: why, code: 'wsl_unavailable' }];
    const id = typeof body.id === 'string' ? body.id : '';
    const signing = (ctx.terminals?.list() ?? []).some((t) => t.key === `signin:${id}@${key}`);
    return await wslUninstallCall(host, key, distroName(distro), body.id, signing);
  });
  guarded('GET', '/api/live/wsl/prereqs', async (_ctx, args) => {
    const distro = one(args, 'distro');
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    const reached = await reach(distro, args);
    if ('reply' in reached) return reached.reply;
    if ('off' in reached) return [200, { ...reached.off, prereqs: null }];
    const prereqs = await reached.host.call('env.prereqs', { force: one(args, 'force') === '1' }, { timeoutMs: 30_000 });
    return [200, { distro: distro.toLowerCase(), name: distroName(distro), state: 'ready', line: '', prereqs }];
  });
  // AIB's own install of an agent in the distro: the job runs in the distro's helper, so it goes on while AIB restarts
  const install = async (distro: string, action: 'start' | 'cancel' | 'status', agent: unknown, start = false): Promise<Reply> => {
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    let host: WslHost;
    if (action === 'status' && !start) {
      // A status read never starts a distro: not ready -> no job, with the distro's state and line. While AIB itself is bringing
      // the distro back (starting, installing, reconnecting) the last progress the helper sent keeps the page's bar.
      const key = distro.toLowerCase();
      const seen = peekWslHost(key);
      const state = peekState(seen);
      if (!seen || state !== 'ready') {
        const last = typeof agent === 'string' && ['starting', 'installing', 'reconnecting'].includes(state) ? lastProgress(key, agent) : null;
        if (last) return [200, { ...last, ok: true, stale: true }];
        return [200, { ok: true, state: 'idle', distro: key, name: distroName(distro), distroState: state, line: state === 'off' ? '' : lineOf(key) }];
      }
    }
    try {
      host = await hostWhenReady(distro);
    } catch (error) {
      return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
    }
    return await wslInstallCall(host, distro.toLowerCase(), distroName(distro), action, agent);
  };
  guarded('GET', '/api/live/wsl/agents/install', (_ctx, args) => install(one(args, 'distro'), 'status', one(args, 'agent'), one(args, 'start') === '1'));
  guarded('POST', '/api/live/wsl/agents/install', (_ctx, _args, body) => install(bodyDistro(body), 'start', body.agent));
  guarded('POST', '/api/live/wsl/agents/install/cancel', (_ctx, _args, body) => install(bodyDistro(body), 'cancel', body.agent));
  guarded('POST', '/api/live/wsl/reconnect', async (_ctx, _args, body) => {
    const distro = typeof body.distro === 'string' ? body.distro : '';
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    setUpAgain(distro.toLowerCase()); // Reconnect is a click too
    const host = wslHost(distro);
    if (!host) return [404, { error: `${distroName(distro)} is not available to AIB.`, code: 'wsl_unavailable' }];
    await host.reconnect().catch(() => {}); // a failure is the host's state and note, answered below
    return [200, { ok: true, state: host.state, line: lineOf(distro) }];
  });
  // "AIB in <distro>" (Linking (WSL) phase 3, docs/wsl/linking-design.md section 13): disk use, and Remove AIB from the distro
  guarded('GET', '/api/live/wsl/aib', async (ctx, args) => {
    const distro = one(args, 'distro');
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    const key = distro.toLowerCase();
    const reached = await reach(distro, args);
    if ('reply' in reached) return reached.reply;
    if ('off' in reached) return [200, { ...reached.off, usage: null }];
    const name = distroName(distro);
    let usage: AibUsage;
    try {
      usage = await reached.host.call('aib.usage', {}, { timeoutMs: 60_000 });
    } catch (error) {
      if (!(error instanceof WslHelperError)) throw error;
      const old = ['unknown_method', 'no_method'].includes(error.code);
      const line = old ? `The AIB helper in ${name} is too old to show this. Restart AIB.` : `AIB could not measure its folder in ${name}: ${error.message}`;
      return [200, { distro: key, name, state: 'ready', line, usage: null }];
    }
    const busy = await ctx.host?.busyConnections().catch(() => []) ?? [];
    usage.chatsWorking = (busy as { cwd?: unknown }[]).filter((c) => wslLoc(c?.cwd)?.distro === key).length;
    return [200, { distro: key, name, state: 'ready', line: '', usage }];
  });
  guarded('POST', '/api/live/wsl/aib/remove', async (ctx, _args, body) => {
    const distro = bodyDistro(body);
    if (!DISTRO.test(distro)) return [400, { error: 'Choose a distro', code: 'bad_distro' }];
    const mode = body.mode;
    if (mode !== 'check' && mode !== 'apply') return [400, { error: "mode must be 'check' or 'apply'", code: 'bad_mode' }];
    if (mode === 'apply' && body.confirm !== true) return [400, { error: 'Confirm the removal first', code: 'confirm_needed' }];
    const key = distro.toLowerCase();
    const host = peekWslHost(key); // the button is only on a ready distro's card: never started for it
    const why = peekState(host) === 'off' ? `${distroName(distro)} is not running.` : notReady(host, key);
    if (why || !host) return [409, { error: why || `${distroName(distro)} is not running.`, code: 'wsl_unavailable' }];
    const busy = await ctx.host?.busyConnections().catch(() => []) ?? [];
    const terminals = ctx.terminals?.list() ?? [];
    // the distro's added projects: the helper tidies up what this AIB made in them before its data folder goes (build plan 1b, 5.4)
    const projects = Object.values(ctx.addedProjects?.public().added ?? {})
      .map((a) => wslLoc(String((a as { path?: unknown })?.path ?? '')))
      .filter((loc) => loc?.distro === key)
      .map((loc) => loc!.linuxPath);
    const steps = realSteps(host, { key, name: distroName(distro), busy: busy as { cwd?: unknown }[], terminals, projects });
    return [200, await removeAib(steps, mode)];
  });
  guarded('POST', '/api/live/wsl/open-url', (ctx, _args, body) => {
    urlGate.configure(ctx.stateDir ? String(ctx.stateDir) : null);
    return Promise.resolve([200, { ok: urlGate.answer(body.id, body.action) }]);
  });
  return routes;
}

// ---- the Files view of a WSL project ------------------------------------------------------------------------------------------

/**
 * A Files request (list, search, read) for a WSL project's folder `{distro, linuxPath}`, through the distro's helper. `main` is the
 * Linux main folder whose local-only paths are laid over it (the folder itself, or a chat copy's project): the helper's localOnly.*
 * answer as files_routes.ts does for a Windows project. A helper without them (older) gets the phase 1 answer: plain files, and the
 * localOnly part of a folder without git (so no exclude hints).
 */
export async function wslFiles(
  kind: 'list' | 'search' | 'read',
  ref: string,
  wsl: { distro: string; linuxPath: string },
  args: Record<string, string[]>,
  origin = '',
  main = wsl.linuxPath,
  /** A remote computer's check of the file the helper really read: its real path in the distro (links followed); true refuses. */
  refuse: ((linuxAbs: string) => boolean) | null = null,
): Promise<Reply> {
  let host: WslHost;
  try {
    host = await hostWhenReady(wsl.distro); // a distro still starting is waited for, not answered with 'starting'
  } catch (error) {
    return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
  }
  try {
    return await wslLocalFiles(host, kind, ref, wsl, args, origin, main, refuse);
  } catch (error) {
    if (!noMethod(error)) return failed(error);
  }
  const localOnly = { main: ref, entries: [], defaultState: 'no-git', sig: '' };
  try {
    if (kind === 'list') {
      const listing = await host.call('files.list', { root: wsl.linuxPath, rel: one(args, 'dir') }) as Record<string, unknown>;
      const { sig: _sig, ...rest } = listing ?? {};
      return [200, { root: ref, ...rest, localOnly, wsl: true }];
    }
    if (kind === 'search') {
      const found = await host.call('files.search', { root: wsl.linuxPath, query: one(args, 'q') }) as Record<string, unknown>;
      return [200, { root: ref, ...(found ?? {}), localOnly, wsl: true }];
    }
    const rel = one(args, 'path').replace(/^\/+/, '');
    const read = await host.call('files.read', { root: wsl.linuxPath, rel, maxBytes: LIMITS.readBytes });
    if (refusedRead(read, refuse)) return BLOCKED_READ;
    const out = fileReadOf(wsl.linuxPath, rel, read);
    return [200, { root: ref, ...out, viewUrl: wslViewUrl(origin, refOf({ kind: 'wsl', distro: wsl.distro, linuxPath: out.abs }), out, read.bytesB64), wsl: true }];
  } catch (error) {
    return failed(error);
  }
}

const BLOCKED_READ: Reply = [403, { error: 'This folder holds sign-ins or AIB data. Open it on the PC itself.', code: 'blocked_folder' }];

/** A remote computer's read (refuse set): the helper answers the real path it read (files.resolveInside); without one (an older
 * helper) a computer gets nothing (review SF5). */
function refusedRead(read: Record<string, unknown>, refuse: ((linuxAbs: string) => boolean) | null): boolean {
  if (!refuse) return false;
  const real: unknown = read?.abs;
  return typeof real !== 'string' || !real.startsWith('/') || refuse(real);
}

/** list, search and read with the main folder's local-only paths (helper/local_only.ts); throws the helper's errors. */
async function wslLocalFiles(
  host: WslHost,
  kind: 'list' | 'search' | 'read',
  ref: string,
  wsl: { distro: string; linuxPath: string },
  args: Record<string, string[]>,
  origin: string,
  main: string,
  refuse: ((linuxAbs: string) => boolean) | null = null,
): Promise<Reply> {
  const scope = { root: wsl.linuxPath, main };
  if (kind === 'list') {
    const listing = await host.call('localOnly.list', { ...scope, dir: one(args, 'dir') });
    return [200, { ...listing, root: ref, wsl: true }];
  }
  if (kind === 'search') {
    const found = await host.call('localOnly.search', { ...scope, query: one(args, 'q') });
    return [200, { ...found, root: ref, wsl: true }];
  }
  const rel = one(args, 'path').replace(/^\/+/, '');
  const read = await host.call('localOnly.read', { ...scope, rel, maxBytes: LIMITS.readBytes });
  if (refusedRead(read, refuse)) return BLOCKED_READ; // a local-only file read from the main folder is checked the same way
  const readRoot = typeof read.readRoot === 'string' && read.readRoot.startsWith('/') ? read.readRoot : wsl.linuxPath;
  const out: FileRead & { local?: true; from?: 'main' } = fileReadOf(readRoot, rel, read);
  if (read.local) out.local = true;
  if (read.from === 'main') out.from = 'main';
  const view = wslViewUrl(origin, refOf({ kind: 'wsl', distro: wsl.distro, linuxPath: out.abs }), out, read.bytesB64);
  return [200, { root: ref, ...out, viewUrl: view, wsl: true }];
}

/**
 * POST files/exclude for a WSL project (scope: refs from files_routes.ts scopeFor): the distro's helper runs local_only.ts addEntry /
 * undoEntry in the project's own repository, and refuses a root that is neither the main folder nor one of its chat copies.
 */
export async function wslLocalPost(scope: { root: string; main: string }, body: Record<string, unknown>): Promise<Reply> {
  const root = wslLoc(scope.root), main = wslLoc(scope.main);
  if (!root || !main || root.distro !== main.distro) return [404, { error: 'This folder cannot be shown', code: 'bad_root' }];
  let host: WslHost;
  try {
    host = await hostWhenReady(root.distro);
  } catch (error) {
    return [409, { error: error instanceof Error ? error.message : String(error), code: 'wsl_unavailable' }];
  }
  const paths = { root: root.linuxPath, main: main.linuxPath };
  try {

    const params = {
      ...paths,
      action: typeof body.action === 'string' ? body.action : '',
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(body.undo !== undefined ? { undo: String(body.undo) } : {}),
    };
    const answer = await host.call('localOnly.exclude', params, { timeoutMs: 120_000 });
    return [answer.status, answer.body];
  } catch (error) {
    if (noMethod(error)) {
      return [409, { error: `The AIB helper in ${distroName(root.distro)} is too old for local-only files. Restart AIB.`, code: 'wsl_unsupported' }];
    }
    return failed(error);
  }
}

/** files.readFile's answer from the helper's bytes (the same rules: binary, too big, image, page); the preview link is wslViewUrl's. */
export function fileReadOf(
  linuxRoot: string,
  rel: string,
  read: { bytesB64: string; size: number; truncated: boolean; mtimeMs: number },
): FileRead {
  const name = rel.slice(rel.lastIndexOf('/') + 1), ext = extOf(name);
  const bytes = Uint8Array.from(atob(read.bytesB64 || ''), (c) => c.charCodeAt(0));
  const out: FileRead = {
    path: rel,
    abs: `${linuxRoot.replace(/\/+$/, '')}/${rel}`,
    name,
    size: read.size,
    mtime: read.mtimeMs / 1000,
    binary: bytes.subarray(0, LIMITS.probe).includes(0),
    tooBig: read.size > LIMITS.readBytes || read.truncated,
    image: IMAGE_EXT.has(ext),
    page: PAGE_EXT.has(ext),
    text: null,
    lines: 0,
  };
  if (!out.binary && !out.tooBig && !(out.image && ext !== '.svg')) {
    out.text = new TextDecoder().decode(bytes);
    out.lines = out.text ? out.text.split('\n').length - (out.text.endsWith('\n') ? 1 : 0) : 0;
  }
  return out;
}
