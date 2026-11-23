/**
 * The rest of web_handler.py's routes, served by the Deno web server: settings and the conversation marks (studio_shared.py), the
 * editor launcher, the folder routes, the Prompts find box, the Changes view and branch, the worktree Merge / clash routes (Resume of
 * a paused live sync included), the update routes, and the artifact routes with their own gate order (the agent key is checked after
 * the body is read). Payloads and messages are Python's.
 */
import { isDict, ValueError } from '../core/py.ts';
import { conversationAction, modelServersView, settingsView, type StudioContext } from './shared.ts';
import { cleanServerUrl, inspectModelServer, isLoopbackAddress, serverHealth, WSL_LOOPBACK_NOTE } from '../agents/model_servers.ts';
import { EditorError, knownRoots, Launcher } from '../desktop/editors.ts';
import * as folders from '../desktop/folders.ts';
import { presence } from '../desktop/folder_presence.ts';
import { pyInt } from '../transcripts/pycompat.ts';
import { findPrompts } from '../transcripts/prompts.ts';
import { branchOf, changesFolder, changesResponse, type ChatStudio } from '../worktrees/chat_folders.ts';
import * as merge from '../worktrees/merge.ts';
import * as mergeQueue from '../worktrees/merge_queue.ts';
import { ArtifactError, FROM_DOC_RESOLVED, MAX_BODY_BYTES, type RequestLike, WSL_FILE_RESOLVED } from '../artifacts/artifacts.ts';
import { BLOCKED_MESSAGE, isBlocked } from '../remote/path_guard.ts';
import { wslPublishFile, WslReadError } from '../wsl/artifact_read.ts';
import { wslRecord } from '../wsl/worktrees.ts';
import { getUpdate, getUpdateNotes, postUpdateCheck, postUpdateInstall, postUpdateNotes } from '../desktop/updater.ts';
import { parseQs } from '../artifacts/origin.ts';
import { authorize, pageAllowed, type Principal, Refusal, REMOTE_PC, SCOPE_ARTIFACTS_TOOL } from './security.ts';
import { projectChanges, sectionDiff } from '../worktrees/project_changes.ts';
import { ChatFolderCache, projectArtifacts } from '../artifacts/project_list.ts';
import { ProjectResolver } from '../worktrees/worktrees.ts';
import * as changes from '../worktrees/changes.ts';
import { readSubagents } from '../subagents/service.ts';
import { WslHelperError } from '../wsl/contract.ts';
import { check as checkArtifactKey } from '../artifacts/keys.ts';
import { ROUTES } from './routes.ts';
import type { WebContext } from './server.ts';
import { wslProjectReply } from './wsl_routes.ts';
import { wslLocOf } from '../platform/location.ts';
import { bringBack, restoreFolders } from './project_routes.ts';
import { DOCS_TOOL, docsTool, resolveFromDoc } from './docs_routes.ts';
import { DocRefusal } from '../docs/live_doc.ts';
import { chatName, Swarm } from '../swarm/service.ts';
import { agentProblem } from '../swarm/ready.ts';
import { setSwarmEnabled, swarmEnabled } from '../swarm/settings.ts';
import * as wslMerge from '../wsl/merge.ts';
import { wslResumeSync } from '../wsl/sync.ts';

type Json = Record<string, unknown>;
export type Reply = [number, unknown];
/** A native route: [status, payload]. */
export type StudioHandler = (ctx: WebContext, url: URL, body: Json | null, request: Request, principal?: Principal) => Promise<Reply>;

/** parse_qs(query) and args.get(name, [fallback])[0]. */
function argsOf(url: URL): Record<string, string[]> {
  return parseQs(url.search.slice(1));
}
const one = (args: Record<string, string[]>, name: string, fallback = '') => Object.hasOwn(args, name) ? args[name][0] : fallback;

/** The StudioContext the shared helpers read (RemoteStudio's attributes: options, stores, host calls, host info). */
export function studioOf(ctx: WebContext): StudioContext {
  return {
    options: ctx.agentOptions,
    settings: ctx.settings,
    conversations: ctx.conversations,
    liveList: () => ctx.host.liveList(),
    liveCall: (name, body) => ctx.host.liveCall(name, body),
    studioOwns: (provider, sessionId) => ctx.host.studioOwns(provider, sessionId),
    hostInfo: ctx.host.hostInfo,
    waitingChats: ctx.host.waitingChats,
  };
}

/** What chat_folders reads from a Studio. savedCwd: the saved-transcript folder looked up before the call (it is synchronous). */
export function chatStudioOf(ctx: WebContext, saved: Map<string, string> = new Map()): ChatStudio {
  return {
    liveState: (ident, limit) => ctx.host.liveState(ident, limit),
    conversations: ctx.conversations as unknown as ChatStudio['conversations'],
    store: null,
    savedCwd: (provider, sessionId) => saved.get(`${provider}:${sessionId}`) ?? '',
    token: ctx.token,
    stateDir: ctx.stateDir,
  };
}

/** chat_folders.SAVED_CWD (catalog.session_cwd) for a 'provider:sessionId' id, looked up ahead of the synchronous use. */
export async function savedFolders(ctx: WebContext, ident: string): Promise<Map<string, string>> {
  const saved = new Map<string, string>();
  const source = ctx.transcripts as { sessionCwd?: (provider: string, sessionId: string) => Promise<string> };
  if (typeof source.sessionCwd === 'function' && /^[a-z0-9_-]+:/.test(ident) && ident.length <= 600) {
    const at = ident.indexOf(':');
    saved.set(ident, await source.sessionCwd(ident.slice(0, at), ident.slice(at + 1)));
  }
  return saved;
}

/** How long GET /api/live/worktree waits for a chat's worktree status before it answers "still checking". */
export const WORKTREE_STATUS_WAIT_MS = 20_000;
const statusRuns = new Map<string, Promise<Record<string, unknown>>>();

/**
 * One chat's worktree status for GET /api/live/worktree (read only: the page has no Merge button any more, owner 2026-11-16; the
 * status stays for the e2e suites and tools that watch a copy chat's merge state): concurrent requests for the same chat share one
 * run, and a run that takes longer than WORKTREE_STATUS_WAIT_MS is answered as "still checking" while it goes on (the next request
 * joins it and gets its result), so a slow git never holds a caller. A finished answer is never reused: an answer from before a
 * merge would be stale.
 */
export async function worktreeStatus(
  id: string,
  run: () => Promise<Record<string, unknown>>,
  waitMs = WORKTREE_STATUS_WAIT_MS,
): Promise<Record<string, unknown>> {
  let pending = statusRuns.get(id);
  if (!pending) {
    const started = run();
    pending = started;
    statusRuns.set(id, started);
    started.catch(() => {}).finally(() => {
      if (statusRuns.get(id) === started) statusRuns.delete(id);
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
  try {
    const value = await Promise.race([pending, late]);
    return value ?? { worktree: true, enabled: false, state: 'checking', message: 'Still checking this chat’s changes…', base: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** A merge or clash action changed this chat's worktree: the next status starts a fresh run (a run already going may predate it). */
export function forgetWorktreeStatus(id: unknown): void {
  if (typeof id === 'string') statusRuns.delete(id);
}

const changesRuns = new Map<string, Promise<Reply>>();

/** One run for identical concurrent requests: the first starts it, the rest wait for the same answer. */
export function shared<T>(runs: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  let pending = runs.get(key);
  if (!pending) {
    pending = run().finally(() => runs.delete(key));
    runs.set(key, pending);
  }
  return pending;
}

function mergeStudio(ctx: WebContext): merge.MergeStudio {
  return merge.liveMergeStudio(ctx.stateDir, ctx.host); // with the folder chats: a merge holds their landing lock (build plan 2.3)
}

/** The editor launcher, as studio.create_server builds it: roots are the folders Studio knows, preferred the Settings default. */
export function makeLauncher(ctx: () => WebContext, listing: () => Json): Launcher {
  return new Launcher(
    () => knownRoots({ liveList: () => listing(), conversations: ctx().conversations as never, projectPrefs: ctx().projectPrefs }),
    { preferred: () => ctx().settings.snapshot().editors.default },
  );
}

async function refusedReply<T>(work: () => Promise<T> | T): Promise<Reply> {
  try {
    return [200, await work()];
  } catch (error) {
    if (error instanceof merge.Refused) return [error.status, { ...error.extra, error: error.message, code: error.code }];
    if (error instanceof EditorError) return [error.status, { error: error.message, code: error.code }];
    throw error;
  }
}

/** The live list for the editor roots (known_roots reads it synchronously): refreshed before each editor request. */
async function refreshList(ctx: WebContext): Promise<void> {
  try {
    ctx.editorList = await ctx.host.liveList();
  } catch (error) { // a host problem must not hide the roots we do have
    console.error('Listing live conversations for editor roots failed', error);
    ctx.editorList = {};
  }
}

export function studioRoutes(): Map<string, StudioHandler> {
  const routes = new Map<string, StudioHandler>();
  // ---- settings and conversation marks ----
  routes.set('GET /api/live/settings', async (ctx, url) => [200, {
    ...(await settingsView(studioOf(ctx), one(argsOf(url), 'recheck') === '1', { offThread: true })),
    keepAwake: ctx.keepAwake.status(),
    swarm: { enabled: swarmEnabled(ctx.stateDir) },
  }]);
  routes.set('POST /api/live/settings', async (ctx, _url, body) => {
    // swarm.enabled lives in swarm-settings.json (swarm/settings.ts), not in Settings: split it off before the Settings patch
    let rest = body;
    if (isDict(body) && 'swarm' in body) {
      const { swarm, ...others } = body;
      if (!isDict(swarm) || typeof swarm.enabled !== 'boolean') return [400, { error: 'swarm.enabled must be true or false' }];
      setSwarmEnabled(ctx.stateDir, swarm.enabled);
      rest = others;
    }
    // only a body that held nothing but swarm skips the Settings patch; anything else (an empty body too) goes through it as before
    if (!(rest !== body && isDict(rest) && !Object.keys(rest).length)) await ctx.settings.update(rest);
    ctx.keepAwake.apply(ctx.settings.keepAwake()); // on or off takes effect now; a refusal comes back as keepAwake.error
    return [200, { ...(await settingsView(studioOf(ctx), false, { offThread: true })), keepAwake: ctx.keepAwake.status(), swarm: { enabled: swarmEnabled(ctx.stateDir) }, ok: true }];
  });
  // Model servers (agents/model_servers.ts): the list and its edits go through POST /api/live/settings {agents: {modelServer: {upsert |
  // remove}}} and GET /api/live/settings (settings.agents.modelServers, no keys; agents[] rows with modelServer: true and
  // modelServerInfo). This asks a server for its models: {id} for a saved server, or {url, key?} for one being typed.
  routes.set('POST /api/live/model-servers/check', async (ctx, _url, body) => {
    if (!isDict(body)) return [400, { error: 'Invalid request' }];
    let url = '', key = '';
    let saved: { id: string; url: string } | null = null;
    if (typeof body.id === 'string' && body.id) {
      const server = ctx.settings.modelServer(body.id);
      if (!server) return [404, { error: 'That model server is not in Settings (it may have been removed)', code: 'not_found' }];
      saved = server;
      url = server.url;
      key = typeof body.key === 'string' && body.key ? body.key : ctx.settings.betaKey(server.id);
    } else {
      url = cleanServerUrl(body.url);
      key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!url) return [400, { error: 'The address must be one http:// or https:// address', code: 'bad_address' }];
    }
    // Check again always asks the server (and refreshes what New chat keeps for 30 seconds); no model output is generated
    const result = saved && !(typeof body.key === 'string' && body.key) ? await serverHealth.check(saved, key, true) : await inspectModelServer(url, key);
    return [200, {
      reachable: result.reachable,
      models: result.models,
      error: result.error,
      status: result.status,
      kinds: result.kinds.filter((k) => k.speaks).map((k) => k.kind),
      needsKey: result.needsKey,
      keyRefused: result.status === 401 || result.status === 403,
      address: url,
      wslNote: isLoopbackAddress(url) ? WSL_LOOPBACK_NOTE : '',
    }];
  });
  // The Model servers section's list with each server's health (asked now, or kept up to 30 s: the same cache New chat reads).
  routes.set('GET /api/live/model-servers', async (ctx, url) => [200, {
    servers: await modelServersView(studioOf(ctx), { health: true, fresh: one(argsOf(url), 'fresh') === '1' }),
  }]);
  routes.set('POST /api/live/conversation-state', async (ctx, _url, body) => {
    const folders = restoreFolders(ctx.conversations, body);
    const reply = await conversationAction(studioOf(ctx), body);
    if (reply[0] === 200) await bringBack(ctx.removedProjects, folders, ctx.addedProjects); // restoring a chat brings its removed project back
    return reply;
  });
  // ---- editors ----
  routes.set('GET /api/live/editors', async (ctx, url) => {
    await refreshList(ctx);
    return refusedReply(() => ctx.launcher.listing(one(argsOf(url), 'project') || null));
  });
  routes.set('POST /api/live/open', async (ctx, _url, body) => {
    await refreshList(ctx);
    return refusedReply(() => ctx.launcher.open(body));
  });
  // ---- folders ----
  routes.set('GET /api/live/folders/check', async (_ctx, url) => {
    const args = argsOf(url);
    const wsl = wslLocOf(one(args, 'path'));
    if (wsl) return await wslProjectReply(wsl, (host, linux) => host.call('folder.project', { path: linux, name: one(args, 'name') }));
    return [200, folders.checkProject(one(args, 'path'), one(args, 'name'))];
  });
  routes.set('GET /api/live/folders/kinds', (_ctx, url) => {
    const args = argsOf(url);
    const wanted: unknown[] = [...(args.path ?? [])];
    try { // the page sends one JSON list in `paths`; repeated `path` parameters work too
      const extra = JSON.parse(one(args, 'paths', '[]'));
      if (Array.isArray(extra)) wanted.push(...extra);
    } catch { /* ignored, as Python's ValueError */ }
    return Promise.resolve([200, { kinds: folders.folderKinds(wanted, one(args, 'parents') === '1') }]);
  });
  // Project folders that no longer exist (cached on the server, read-only): the page leaves their projects out of the list.
  routes.set('GET /api/live/folders/gone', (_ctx, url) => {
    const args = argsOf(url);
    const wanted: unknown[] = [...(args.path ?? [])];
    try {
      const extra = JSON.parse(one(args, 'paths', '[]'));
      if (Array.isArray(extra)) wanted.push(...extra);
    } catch { /* not JSON: nothing asked */ }
    return Promise.resolve([200, { gone: presence.gone(wanted) }]);
  });
  routes.set('GET /api/live/folders/start', (ctx) => Promise.resolve([200, folders.startFolder(ctx.folderMemory)]));
  routes.set('POST /api/live/folders/create', async (ctx, _url, body) => {
    const gitInit = body && Object.hasOwn(body, 'gitInit') ? body.gitInit : false;
    if (typeof body?.path !== 'string' || typeof gitInit !== 'boolean') throw new ValueError('Invalid request');
    const wsl = wslLocOf(body.path);
    if (wsl) {
      const name = Object.hasOwn(body, 'name') && typeof body.name === 'string' ? body.name : '';
      return await wslProjectReply(wsl, (host, linux) => host.call('folder.createProject', { path: linux, name, gitInit }));
    }
    const named = Object.hasOwn(body, 'name'); // with a name: <path>\<name>, made or used; without: <path> itself, made
    if (named && typeof body.name !== 'string') throw new ValueError('Invalid request');
    let result: folders.CreateResult;
    try {
      result = named
        ? await folders.createProject(body.path, body.name, gitInit)
        : await folders.createFolder(folders.normalizeFolder(body.path), gitInit);
    } catch (error) {
      if (error instanceof folders.FolderError) return [400, { error: error.message, code: error.code }];
      throw error;
    }
    ctx.folderMemory.rememberProject(result.path);
    return [200, result];
  });
  routes.set('POST /api/live/folders/remember', (ctx, _url, body) => {
    try {
      return Promise.resolve([200, { ok: true, parent: ctx.folderMemory.rememberProject(body?.path) }]);
    } catch (error) {
      if (error instanceof folders.FolderError) return Promise.resolve([400, { error: error.message, code: error.code }]);
      throw error;
    }
  });
  routes.set('POST /api/live/folders/pick', async (_ctx, _url, body) => {
    const start = body && Object.hasOwn(body, 'start') ? body.start : '';
    if (typeof start !== 'string') throw new ValueError('Invalid request');
    return await folders.pickFolder(start);
  });
  // ---- the Prompts view's find box ----
  routes.set('GET /api/live/prompts', async (ctx, url) => {
    const args = argsOf(url);
    const key = one(args, 'key');
    if (!key) return [400, { error: 'Name the chat to search' }];
    const limit = Math.min(1000, Math.max(1, pyInt(one(args, 'limit', '200'))));
    const source = ctx.transcripts;
    const transcript = await source.load(await source.resolve(key) as never);
    return await transcript.lock.run(() => {
      let events = transcript.events as Json[];
      if (one(args, 'thinking') !== '1') events = events.filter((e) => e.kind !== 'thinking'); // the same filter /api/transcript applies
      return [200, findPrompts(events, one(args, 'q'), limit)] as Reply;
    });
  });
  // ---- Changes view, branch, worktree Merge and clashes ----
  for (const path of ['/api/live/changes', '/api/live/changes/file']) {
    routes.set(`GET ${path}`, (ctx, url, _body, request, principal) => {
      // identical requests at once (several views of one chat poll it) share one run of git; who asks is part of the key: the
      // page token, or a remote computer's principal (never a token it sent)
      const who = principal?.kind === REMOTE_PC ? `pc:${principal.device}` : request.headers.get('X-Studio-Token') ?? '';
      const key = `${who}|${path}|${url.search}`;
      return shared(changesRuns, key, async () => {
        const args = argsOf(url);
        const reply = await changesResponse(
          chatStudioOf(ctx, await savedFolders(ctx, one(args, 'id'))),
          path,
          args,
          request.headers,
          principal ?? null,
        );
        return principal?.kind === REMOTE_PC ? remoteChanges(ctx, path, reply) : reply;
      });
    });
  }
  // The project's Changes (right panel): main plus the worktrees of the project's active subagents and helpers, in one read.
  // `id` names any chat of the project (the folder comes from it); `fold` / `unfold` are comma lists of section ids. A worktree's file
  // diff is asked by its section id (a record id), never by a path.
  for (const path of ['/api/live/project/changes', '/api/live/project/changes/file']) {
    routes.set(`GET ${path}`, (ctx, url, _body, request, principal) => {
      const who = principal?.kind === REMOTE_PC ? `pc:${principal.device}` : request.headers.get('X-Studio-Token') ?? '';
      return shared(changesRuns, `${who}|${path}|${url.search}`, async () => {
        const args = argsOf(url);
        const studio = chatStudioOf(ctx, await savedFolders(ctx, one(args, 'id')));
        if (!pageAllowed(principal ?? null, request.headers, studio.token ?? '')) {
          return [403, { error: 'Invalid local session token' }] as Reply;
        }
        const chatFolder = await changesFolder(studio, one(args, 'id'));
        if (chatFolder === null) return [404, { error: 'This chat has no known project folder.', code: 'unknown_folder' }] as Reply;
        // the PROJECT's folder, never the open chat's worktree: another chat of the project must change nothing
        const folder = projectFolderOf(ctx.stateDir ?? '', chatFolder);
        const list = (name: string) => new Set(one(args, name).split(',').filter(Boolean).slice(0, 200));
        const targets = {
          folder,
          stateDir: ctx.stateDir ?? null,
          subs: ctx.stateDir ? readSubagents(ctx.stateDir) : {},
          helpers: swarmOf(ctx).registry.all(),
          fold: list('fold'),
          unfold: list('unfold'),
          onlyMain: one(args, 'only') === 'main',
        };
        try {
          if (path.endsWith('/file')) {
            const diff = await sectionDiff(targets, one(args, 'section'), one(args, 'path'));
            if (!diff) return [404, { error: 'That worktree is not in use any more.', code: 'unknown_section' }] as Reply;
            return principal?.kind === REMOTE_PC ? remoteChanges(ctx, '/api/live/changes/file', [200, diff]) : [200, diff] as Reply;
          }
          const offset = one(args, 'offset', '0');
          const reply = await projectChanges(targets, /^\d+$/.test(offset) ? Number(offset) : 0);
          return principal?.kind === REMOTE_PC ? remoteProject(ctx, [200, reply]) : [200, reply] as Reply;
        } catch (error) {
          if (error instanceof changes.ChangesError) return [400, { error: error.message, code: error.code }] as Reply;
          if (error instanceof WslHelperError) return [error.code === 'wsl_unavailable' ? 409 : 400, { error: error.message, code: error.code }] as Reply;
          throw error;
        }
      });
    });
  }
  routes.set('GET /api/live/branch', async (_ctx, url) => [200, { branch: await branchOf(one(argsOf(url), 'cwd')) }]); // a WSL ref: its helper
  // A WSL chat's merge runs in its distro's helper (wsl/merge.ts); every other chat's here (merge.ts).
  routes.set('GET /api/live/worktree', async (ctx, url) => {
    const studio = mergeStudio(ctx), id = one(argsOf(url), 'id');
    return [200, await worktreeStatus(id, async () => {
      const wsl = await wslMerge.wslMergeChat(studio, id);
      return wsl ? await wslMerge.wslMergeStatus(wsl) : await merge.status(studio, id);
    })];
  });
  routes.set('GET /api/live/worktree/clash', async (ctx, url) => {
    const project = one(argsOf(url), 'project');
    return [200, wslLocOf(project) ? await wslMerge.wslClashStatus(project) : await merge.clashStatus(ctx, project)];
  });
  routes.set('POST /api/live/worktree/merge', async (ctx, _url, body) => {
    const title = typeof body?.title === 'string' ? body.title : '';
    const studio = mergeStudio(ctx), wsl = await wslMerge.wslMergeChat(studio, body?.id);
    try {
      return await refusedReply(() => wsl ? wslMerge.wslMerge(studio, wsl, title) : merge.merge(studio, body?.id, title));
    } finally {
      forgetWorktreeStatus(body?.id);
    }
  });
  routes.set('POST /api/live/worktree/clash', async (ctx, _url, body) => {
    if (body?.action === 'resume-sync') {
      if (wslLocOf(body.project)) return [200, { ok: true, resumed: await wslResumeSync(body.project) }]; // in its distro's helper
      return [200, { ok: true, resumed: await merge.resumeSync(ctx.stateDir, body.project) }];
    }
    const action = typeof body?.action === 'string' ? body.action : '';
    const studio = mergeStudio(ctx), wsl = await wslMerge.wslMergeChat(studio, body?.id);
    try {
      return await refusedReply(() => wsl ? wslMerge.wslResolveClash(studio, wsl, action) : merge.resolveClash(studio, body?.id, action));
    } finally {
      forgetWorktreeStatus(body?.id);
    }
  });
  // ---- swarm phase 1: the merge line's Undo / Merge again, and a chat's helpers (page only; never the agent key) ----
  routes.set('POST /api/live/swarm/undo', (ctx, _url, body) => swarmOf(ctx).undo(body?.helper));
  routes.set('POST /api/live/swarm/merge-again', (ctx, _url, body) => swarmOf(ctx).mergeAgain(body?.helper));
  routes.set('GET /api/live/swarm', (ctx, url) => {
    const id = one(argsOf(url), 'conversationId');
    const swarm = swarmOf(ctx);
    const helpers = swarm.registry.all().filter((h) => !id || h.parent.live === id || h.chat.live === id).map((h) => ({
      id: h.id,
      kind: h.kind ?? 'helper', // 'subagent': a landing entry of a Claude subagent, not a helper chat (Activity lists helper chats only)
      title: h.title,
      provider: h.chat.provider,
      label: chatName(h), // "Codex", "Claude Code · strata": Activity's row says which agent it is
      model: h.chat.model,
      chat: h.chat.live,
      chatKey: h.chat.lasting, // provider:sessionId, the page's chat key (live ids change across restarts)
      parent: h.parent.live,
      parentKey: h.parent.lasting,
      createdAt: h.createdAt,
      endedAt: h.endedAt || h.merge?.at || h.reports.at(-1)?.at || 0,
      state: h.state,
      reason: h.reason,
      rule: h.rule,
      picked_by: h.picked_by,
      branch: h.worktree.branch,
      brief: h.brief,
      merged: !!h.merge && !h.merge.undo,
    }));
    return Promise.resolve([200, { helpers }]);
  });
  // ---- updates ----
  routes.set('GET /api/live/update', (ctx) => Promise.resolve(getUpdate(ctx.updates)));
  routes.set('POST /api/live/update/check', (ctx, _url, body) => Promise.resolve(postUpdateCheck(ctx.updates, body ?? {})));
  routes.set('POST /api/live/update/install', (ctx, _url, body) => postUpdateInstall(ctx.updates, body ?? {}));
  routes.set('GET /api/live/update/notes', (ctx) => Promise.resolve(getUpdateNotes(ctx.updates)));
  routes.set('POST /api/live/update/notes', (ctx, _url, body) => Promise.resolve(postUpdateNotes(ctx.updates, body ?? {})));
  // ---- artifacts (GET; the gate already ran, with the agent key for the list) ----
  const artifactGets = [
    '/api/live/artifacts',
    '/api/live/artifacts/item',
    '/api/live/artifacts/source',
    '/api/live/artifacts/diff',
    '/api/live/artifacts/states',
    '/api/live/artifacts/by-source',
  ];
  // The project's artifacts (right panel): every chat's, newest first, tagged with its chat. `id` names any chat of the project (its
  // folder comes from it, as for Changes); `deleted=1` adds Recently deleted. The project of each artifact is computed here.
  routes.set('GET /api/live/project/artifacts', async (ctx, url, _body, request, principal) => {
    const args = argsOf(url), id = one(args, 'id');
    const studio = chatStudioOf(ctx, await savedFolders(ctx, id));
    if (!pageAllowed(principal ?? null, request.headers, studio.token ?? '')) return [403, { error: 'Invalid local session token' }] as Reply;
    await ctx.artifacts.prepare(false, null);
    let folder: string | null;
    try {
      folder = await changesFolder(studio, id);
    } catch (error) {
      if (error instanceof ValueError) return [400, { error: error.message, code: 'invalid' }] as Reply;
      throw error;
    }
    if (folder === null) return [404, { error: 'This chat has no known project folder.', code: 'unknown_folder' }] as Reply;
    const resolver = new ProjectResolver(ctx.stateDir ?? '');
    // chat -> folder is kept between reads (a lookup scans transcripts or asks a WSL helper); dropped when the live chats change
    const cache = chatFolders(ctx);
    cache.reset(ctx.artifacts.openConnections().map((c) => String(c.id)).sort().join('|'));
    const reply = await projectArtifacts(ctx.artifacts.store, folder, {
      mainOf: (path) => resolver.resolve(path)?.project ?? path,
      // a chat that is running is asked by its connection id, as the artifact routes do (artifactFolder); a saved one by its lasting id
      chatFolder: (chat) =>
        cache.get(chat, async () => changesFolder(chatStudioOf(ctx, await savedFolders(ctx, chat)), ctx.artifacts.connectionOf(chat) || chat)),
    }, { deleted: one(args, 'deleted') === '1' });
    return [200, reply] as Reply;
  });
  for (const path of artifactGets) {
    routes.set(`GET ${path}`, async (ctx, url, _body, request, principal) => {
      const args = argsOf(url);
      await ctx.artifacts.prepare(path === '/api/live/artifacts', null);
      return artifactCall(() => ctx.artifacts.service.handleGet(asked(request, principal), path, args));
    });
  }
  return routes;
}

const CHAT_FOLDERS = new WeakMap<WebContext, ChatFolderCache>();
function chatFolders(ctx: WebContext): ChatFolderCache {
  let cache = CHAT_FOLDERS.get(ctx);
  if (!cache) CHAT_FOLDERS.set(ctx, cache = new ChatFolderCache());
  return cache;
}

/** The project's main folder for the folder a chat works in: a worktree maps to its project (as the artifacts route does); a WSL ref and any other folder stay. */
function projectFolderOf(stateDir: string, folder: string): string {
  if (wslLocOf(folder)) return folder;
  try {
    return new ProjectResolver(stateDir).resolve(folder)?.project ?? folder;
  } catch {
    return folder;
  }
}

const SWARMS = new WeakMap<WebContext, Swarm>();

/** The web server's swarm service (one per server), its helper watcher started on first use. */
export function swarmOf(ctx: WebContext): Swarm {
  let swarm = SWARMS.get(ctx);
  if (!swarm) {
    swarm = new Swarm({ stateDir: ctx.stateDir, host: ctx.host, settings: ctx.settings, agentProblem: (provider) => agentProblem(ctx, provider) });
    SWARMS.set(ctx, swarm);
    swarm.startWatching();
  }
  return swarm;
}

/** artifact_route's error mapping: Python answers KeyError/ValueError/TypeError/OSError/RuntimeError with 400 (the Service already maps its own). */
/**
 * The Changes view for a remote computer (security review MF1 audit): the chat's folder can hold a blocked folder (a project that
 * is a home folder), so a diff is refused by the file it RESOLVES to (its `abs`, real path checked too), and the list leaves out the
 * rows inside blocked folders.
 */
function remoteChanges(ctx: WebContext, path: string, reply: [number, unknown]): [number, unknown] {
  const [status, payload] = reply;
  if (status !== 200 || !isDict(payload)) return reply;
  const blocked = (p: unknown) => typeof p === 'string' && !!p && isBlocked(p, ctx.stateDir ?? null);
  if (path === '/api/live/changes/file') {
    if (payload.git && typeof payload.abs !== 'string') return [403, { error: BLOCKED_MESSAGE, code: 'blocked_folder' }];
    return blocked(payload.abs) ? [403, { error: BLOCKED_MESSAGE, code: 'blocked_folder' }] : reply;
  }
  const root = typeof payload.root === 'string' ? payload.root.replace(/[\\/]+$/, '') : '';
  if (!root || !Array.isArray(payload.files)) return reply;
  const files = (payload.files as unknown[]).filter((f) => !(isDict(f) && typeof f.path === 'string' && blocked(`${root}/${f.path}`)));
  return [status, { ...payload, files }];
}

/** The project's Changes for a remote computer: every section's rows inside blocked folders are left out (as remoteChanges does). */
function remoteProject(ctx: WebContext, reply: [number, unknown]): [number, unknown] {
  const [status, payload] = reply;
  if (status !== 200 || !isDict(payload)) return reply;
  const filter = (sec: unknown) => {
    if (!isDict(sec) || !isDict(sec.changes)) return sec;
    const [, kept] = remoteChanges(ctx, '/api/live/changes', [200, sec.changes]);
    return { ...sec, changes: kept };
  };
  return [status, {
    ...payload,
    main: filter(payload.main),
    sections: (payload.sections as unknown[]).map(filter),
    left: (payload.left as unknown[]).map(filter),
  }];
}

function artifactCall(work: () => Reply): Reply {
  try {
    return work();
  } catch (error) {
    if (error instanceof Error && ['KeyError', 'ValueError', 'TypeError', 'OSError', 'RuntimeError', 'RangeError'].includes(error.name)) {
      return [400, { error: error.message }];
    }
    throw error;
  }
}

/** Python's json.loads error for a body that is not JSON (only the status is a contract; the text is close). */
function jsonError(error: unknown): string {
  return `Expecting value: ${error instanceof Error ? error.message : String(error)}`;
}

/** Read a JSON body within (0, limit] bytes for the own-gate routes: [body or {}, null] or [null, 400 reply]. */
async function ownGateBody(request: Request, limit: number): Promise<[Json, null] | [null, Reply]> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (!(declared > 0 && declared <= limit)) {
    await request.body?.cancel().catch(() => {});
    return [null, [400, { error: 'Invalid request size' }]];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await request.arrayBuffer()));
  } catch (error) {
    return [null, [400, { error: jsonError(error) }]];
  }
  return [isDict(parsed) ? parsed : {}, null];
}

/** The gate for one route, as web_handler.Handler.gate: security.authorize with this route's scope (and the agent key check). */
export function gateFor(ctx: WebContext, request: Request, path: string, conversationId: unknown): Refusal | object {
  return authorize(
    { method: 'POST', path, headers: request.headers },
    ctx.gate,
    ROUTES.scopeFor('POST', path),
    typeof conversationId === 'string'
      ? conversationId
      : conversationId === null || conversationId === undefined
      ? null
      : String(conversationId),
    checkArtifactKey,
  );
}

/**
 * The POST routes that run their own gate (web_handler.post_artifacts and post_worktree_tool): the agent key is bound to the body's
 * conversation, so the body is read before the key is checked. Returns [status, payload].
 */
export async function ownGatePost(ctx: WebContext, request: Request, url: URL): Promise<Reply> {
  const path = url.pathname;
  if (path === '/api/live/worktree/tool') {
    const [body, bad] = await ownGateBody(request, 100000);
    if (bad) return bad;
    const conversation = body.conversationId;
    const allowed = gateFor(ctx, request, path, conversation);
    if (allowed instanceof Refusal) return [allowed.status, { error: allowed.message(path) }];
    const action = typeof body.action === 'string' ? body.action : 'merge';
    // A helper's key never merges its own branch: its main chat merges it with merge_helper (swarm review break 3).
    if (action === 'merge' && swarmOf(ctx).isHelper(conversation)) {
      return [403, { error: 'Helpers are merged by their main chat: report back instead', code: 'helper' }];
    }
    const studio = mergeStudio(ctx), wsl = await wslMerge.wslMergeChat(studio, conversation); // a WSL chat: its distro's helper merges
    try {
      if (action === 'merge') return await refusedReply(() => wsl ? wslMerge.wslMerge(studio, wsl, '', true) : mergeQueue.mergeFromToolQueued(studio, conversation));
      return await refusedReply(() => wsl ? wslMerge.wslResolveClash(studio, wsl, action, true) : merge.resolveClash(studio, conversation, action, true));
    } finally {
      forgetWorktreeStatus(conversation);
    }
  }
  if (path === '/api/live/swarm/tool') { // swarm phase 1: the key is bound to the body's conversation; the role is checked in the service
    const [body, bad] = await ownGateBody(request, 200000);
    if (bad) return bad;
    const allowed = gateFor(ctx, request, path, body.conversationId);
    if (allowed instanceof Refusal) return [allowed.status, { error: allowed.message(path) }];
    return await swarmOf(ctx).tool(body.conversationId, body.action, body.args);
  }
  if (path === DOCS_TOOL) { // an agent's doc tool: the key is bound to the body's conversation, as for publish
    const [body, bad] = await ownGateBody(request, 4 * 1024 * 1024);
    if (bad) return bad;
    const allowed = gateFor(ctx, request, path, body.conversationId);
    if (allowed instanceof Refusal) return [allowed.status, { error: allowed.message(path) }];
    await ctx.artifacts.prepare(true, body.conversationId);
    return await docsTool(ctx, body);
  }
  // /api/live/artifacts/*: publish is for the agent tool (its key, bound to the body's conversation), the rest for the page.
  const toolRoute = ROUTES.scopeFor('POST', path) === SCOPE_ARTIFACTS_TOOL;
  if (!toolRoute) {
    const allowed = gateFor(ctx, request, path, null);
    if (allowed instanceof Refusal) {
      await request.body?.cancel().catch(() => {});
      return [allowed.status, { error: allowed.message(path) }];
    }
  }
  const [body, bad] = await ownGateBody(request, MAX_BODY_BYTES);
  if (bad) return bad;
  if (toolRoute) {
    const allowed = gateFor(ctx, request, path, body.conversationId);
    if (allowed instanceof Refusal) return [allowed.status, { error: allowed.message(path) }];
  }
  return await artifactPost(ctx, request, path, body);
}

/** What an artifact route reads of the request: its headers and the principal the server passed in (never from a header). */
export function asked(request: Request, principal?: Principal | null): RequestLike {
  return { headers: request.headers, principal: principal ?? null };
}

/**
 * An /api/live/artifacts/* POST once its caller is known: ownGatePost after its gate, or the remote computer bridge
 * (remote/pc_bridge.ts) for the page-side actions it allows, with its principal in `who` (it never reaches the agent-key routes).
 */
export async function artifactPost(ctx: WebContext, who: RequestLike, path: string, body: Json): Promise<Reply> {
  if (who.principal?.kind === REMOTE_PC) {
    // a computer's preview path resolves against the chat's folder: the RESOLVED file must not be in a blocked folder (review MF1)
    who = {
      ...who,
      pathGuard: (real) => {
        if (isBlocked(real, ctx.stateDir ?? null)) throw new ArtifactError(BLOCKED_MESSAGE, 403, 'blocked_folder');
      },
    };
  }
  const publishing = path === '/api/live/artifacts/publish' || path === '/api/live/artifacts/preview';
  // Delete and Restore move the source file: they need the OWNER chat's folder (an artifact opened from another chat's link too),
  // resolved from the manifest, never the requesting chat's and never manifest.project (the main checkout of a worktree chat).
  let owner: unknown = null;
  if (path === '/api/live/artifacts/delete' || path === '/api/live/artifacts/undelete') {
    try {
      owner = ctx.artifacts.service.store.get(body.id).conversationId ?? null;
    } catch { /* the route says what is wrong */ }
  }
  await ctx.artifacts.prepare(publishing, publishing ? body.conversationId : owner);
  delete body[FROM_DOC_RESOLVED];
  delete body[WSL_FILE_RESOLVED];
  if (path === '/api/live/artifacts/preview' && body.path !== null && body.path !== undefined) {
    // "Open in Artifacts" on a WSL project's file: read through its distro's helper, as a WSL publish by path (0.13.0)
    const refused = await attachWslFile(ctx, body);
    if (refused) return refused;
  }
  if (path === '/api/live/artifacts/publish') {
    // "Built from <doc › page>": the tool's fromDoc, or (an update without one) the link the artifact has, at the page's rev now
    let from: unknown = body.fromDoc;
    if (from === undefined && typeof body.id === 'string') {
      try {
        from = ctx.artifacts.service.store.get(body.id).fromDoc;
      } catch { /* the publish says what is wrong */ }
      if (from && typeof from === 'object') from = { doc: (from as Json).doc, page: (from as Json).page };
    }
    if (from !== undefined && from !== null) {
      try {
        body[FROM_DOC_RESOLVED] = await resolveFromDoc(ctx, String(body.conversationId ?? ''), from);
      } catch (error) {
        if (!(error instanceof DocRefusal)) throw error;
        if (body.fromDoc !== undefined) return [400, { error: error.message, code: error.code }];
        // an update of an artifact whose doc page is gone: published, the old link kept
      }
    }
    delete body.fromDoc;
    // a WSL chat's `path`: its distro's helper reads the file (wsl/artifact_read.ts); artifacts.ts publishes the bytes
    if (body.path !== null && body.path !== undefined) {
      const refused = await attachWslFile(ctx, body);
      if (refused) return refused;
    }
  }
  return artifactCall(() => ctx.artifacts.service.handlePost(who, path, body));
}

/**
 * Publish by `path` from a WSL chat: its folder is a wsl:// ref, so the file is read through its distro's helper (with the realpath
 * checks done there) and put on the body under WSL_FILE_RESOLVED for artifacts.ts; null when done or not a WSL chat (a Windows chat's
 * path is resolved by artifacts.ts as before). A refusal is the reply: one line naming the Linux path.
 */
export async function attachWslFile(ctx: WebContext, body: Json): Promise<Reply | null> {
  const id = body.conversationId;
  if (typeof id !== 'string' || !id || id.length > 600) return null;
  const artifacts = ctx.artifacts;
  const chat = artifacts.service.chat(id);
  if (artifacts.service.cwdFor(chat)) return null; // a Windows folder (prepare() found it): artifacts.ts resolves the path
  let folder: string | null;
  try {
    folder = await changesFolder(await artifacts.chatStudio(chat), artifacts.connectionOf(chat) || chat);
  } catch (error) {
    if (error instanceof ValueError) return null;
    throw error;
  }
  if (!folder || !wslLocOf(folder)) return null;
  // the project's main folder for a chat in its own worktree (its local-only files live there); else the chat's own folder
  const record = await wslRecord(folder).catch(() => null);
  const project = record?.project ?? artifacts.projectRootOf(chat);
  try {
    body[WSL_FILE_RESOLVED] = await wslPublishFile(folder, project, body.path);
  } catch (error) {
    if (error instanceof WslReadError) return [error.status, { error: error.message, code: error.code }];
    throw error;
  }
  return null;
}
