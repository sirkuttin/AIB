/**
 * The live routes that are answered by the agent host (web_handler.py: get_state, get_ownership, post_live_op, the agent install and
 * sign-in routes, post_shutdown). The web server forwards them through the HostProxy, exactly as RemoteStudio does.
 */
import { ValueError } from '../core/py.ts';
import { pyInt } from '../transcripts/pycompat.ts';
import { modelInUse } from '../transcripts/store.ts';
import { refuseNetworkPath } from './security.ts';
import { assertWindowsLocal, locOf } from '../platform/location.ts';
import type { WebContext } from './server.ts';
import { answeredElsewhere, answerOf, answersOf } from '../attention/answers.ts';

/** True while the take-over from the keeper at start runs (an in-process AIB; a split agent host never says so). */
function takingOver(ctx: WebContext): boolean {
  return !!(ctx.host as { takingOver?: () => boolean }).takingOver?.();
}
import { afterConnect, discoverAdded } from './project_routes.ts';
import { LIVE_POST_OPS as HOST_LIVE_POST_OPS } from '../host/aib_live_ops.ts';

/** The generic POST /api/live/<name> calls: derived from the host's one live-op table (host/aib_live_ops.ts). */
export const LIVE_POST_OPS: readonly string[] = [...HOST_LIVE_POST_OPS];

type Json = Record<string, unknown>;
type Reply = [number, unknown];
export type LiveHandler = (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply>;

const arg = (url: URL, name: string, fallback = '') => url.searchParams.get(name) ?? fallback;

/** web_handler.model_in_use: the model the replies really come from (transcript first, then the adapter's usage reports). */
async function inUse(ctx: WebContext, state: Json): Promise<Json | null> {
  let found: Json | null = null;
  try {
    found = await modelInUse(String(state.provider ?? ''), state.sessionId as string, ctx.options.claudeProjects, ctx.options.ompSessions);
  } catch {
    found = null;
  }
  if (found === null) {
    const breadth = (state.breadth && typeof state.breadth === 'object' ? state.breadth : {}) as Json;
    const reported = breadth.responseModel;
    if (typeof reported === 'string' && reported) found = { model: reported, source: 'agent-usage' };
  }
  return found;
}

/**
 * Phase 2 (attention/answers.ts): an answer that went through is the PC's own (a paired computer's bridge names itself right after);
 * one that came too late, after another device answered the same card first, says who did ("Already answered on Laptop (Edge).").
 */
function noteAnswer(ctx: WebContext, op: 'permission' | 'elicitation' | 'allow-answer', body: Json | null, reply: Reply): Reply {
  const [status] = reply;
  if (status === 200) {
    const name = (() => {
      try {
        return ctx.phone?.pcName?.() || 'the PC';
      } catch {
        return 'the PC';
      }
    })();
    answersOf(ctx).note(body?.id, body?.key, { by: 'pc', name, ...answerOf(op, body) });
    return reply;
  }
  const first = status >= 400 && status < 500 ? answeredElsewhere(ctx, body?.id, body?.key) : null;
  return first ? [409, { error: first, code: 'answered' }] : reply;
}

function installAgent(body: Json | null): string {
  const agent = body?.agent;
  if (typeof agent !== 'string') throw new ValueError('agent must be text');
  return agent;
}

export function liveRoutes(): Map<string, LiveHandler> {
  const routes = new Map<string, LiveHandler>();
  routes.set('GET /api/live/state', async (ctx, url) => {
    const state = await ctx.host.liveState(arg(url, 'id'), pyInt(arg(url, 'after', '0'))) as Json | null;
    if (state === null && takingOver(ctx)) {
      // The take-over at start is still on its way after liveState's wait (a distro booting): the page keeps the chat and asks
      // again quietly (chat.js taking_over), never "no longer available".
      return [503, { error: 'AIB is still starting this chat.', code: 'taking_over' }];
    }
    if (state === null) {
      return [404, {
        error: 'This AIB connection is no longer available. Your saved conversation can be continued again.',
        code: 'connection_not_found',
      }];
    }
    // phase 2 (attention/answers.ts): who answered this chat's approvals and questions, so a line can say "on Laptop (Edge)"
    const answers = answersOf(ctx).forChat(arg(url, 'id'));
    return [200, { ...state, inUse: await inUse(ctx, state), ...(answers ? { answers } : {}) }];
  });
  // History loading (event_pages.ts): one page of a chat's events. Open: no before/after/around (the tail by bytes, plus turn and
  // helper facts); before=<seq> pages back; after=<seq> deltas; around=<seq> a saved place; session=<helper id> a helper's events;
  // bytes=<page budget>; clip=<characters per tool string, 0 for none>.
  routes.set('GET /api/live/events', async (ctx, url) => {
    const query: Record<string, unknown> = {};
    for (const k of ['session', 'before', 'after', 'around', 'bytes', 'clip']) {
      const v = url.searchParams.get(k);
      if (v !== null && v !== '') query[k] = k === 'session' ? v : pyInt(v);
    }
    const found = await ctx.host.liveEvents(arg(url, 'id'), query) as Json | null;
    if (found === null && takingOver(ctx)) return [503, { error: 'AIB is still starting this chat.', code: 'taking_over' }];
    if (found === null) return [404, { error: 'This AIB connection is no longer available.', code: 'connection_not_found' }];
    return [200, found];
  });
  routes.set('GET /api/live/event', async (ctx, url) => {
    const found = await ctx.host.liveEvent(arg(url, 'id'), pyInt(arg(url, 'seq'))) as Json | null;
    if (found === null) return [404, { error: 'That event is no longer kept.', code: 'event_not_found' }];
    return [200, found];
  });
  routes.set('GET /api/live/ownership', async (ctx, url) => {
    let cwd: string;
    try {
      cwd = refuseNetworkPath(arg(url, 'cwd'));
      // a WSL project's folder is checked in its distro (Aib.ownershipQuery); anything else foreign is refused
      if (locOf(cwd)?.kind !== 'wsl') assertWindowsLocal(cwd, 'folder');
    } catch (error) {
      throw new ValueError((error as Error).message);
    }
    return [200, await ctx.host.ownershipQuery(arg(url, 'provider'), arg(url, 'id'), cwd)];
  });
  routes.set('GET /api/live/agents/install', (ctx, url) => ctx.host.installCall('status', arg(url, 'agent')));
  routes.set('POST /api/live/agents/install', (ctx, _url, body) => ctx.host.installCall('start', installAgent(body)));
  routes.set('POST /api/live/agents/install/cancel', (ctx, _url, body) => ctx.host.installCall('cancel', installAgent(body)));
  // Deno only (routes.ts DENO_ONLY): an older agent host answers the unknown action with 404, so nothing is removed there.
  // {check: true}: every refusal, nothing removed (the page asks this before its confirm question).
  routes.set(
    'POST /api/live/agents/install/uninstall',
    (ctx, _url, body) => ctx.host.installCall(body?.check === true ? 'uninstall-check' : 'uninstall', installAgent(body)),
  );
  routes.set('GET /api/live/agents/signin', (ctx, url) => ctx.host.signinCall('status', arg(url, 'agent')));
  routes.set('POST /api/live/agents/signin', (ctx, _url, body) => ctx.host.signinCall('start', installAgent(body)));
  routes.set('POST /api/live/agents/signin/cancel', (ctx, _url, body) => ctx.host.signinCall('cancel', installAgent(body)));
  routes.set('POST /api/live/agents/signin/check', (ctx, _url, body) => {
    const agent = body?.agent ?? '';
    if (typeof agent !== 'string') throw new ValueError('agent must be text');
    return ctx.host.signinCall('check', agent, body?.force === true);
  });
  // Deno only (routes.ts DENO_ONLY): the model / mode / effort lists a new chat can offer, before its session exists.
  routes.set('POST /api/live/agent-options', (ctx, _url, body) => ctx.host.liveCall('agent-options', body ?? {}));
  routes.set('POST /api/live/tool-servers', (ctx, _url, body) => ctx.host.liveCall('tool-servers', body ?? {})); // Settings > Tool servers (toolservers/*)
  // Allow rules (routes.ts DENO_ONLY): the page's Always choice and Settings; the host's #allowCall.
  for (const op of ['answer', 'rules', 'remove', 'restore', 'review', 'enable', 'builtin']) {
    routes.set(`POST /api/live/allow/${op}`, async (ctx, _url, body) => {
      const reply = await ctx.host.liveCall(`allow-${op}`, body ?? {});
      return op === 'answer' ? noteAnswer(ctx, 'allow-answer', body, reply) : reply;
    });
  }
  for (const name of LIVE_POST_OPS) {
    routes.set(`POST /api/live/${name}`, async (ctx, _url, body) => {
      // "Find more chats via agent" lists only chats of added projects (empty pages skipped); it never adds one.
      const [status, payload] = name === 'discover'
        ? await discoverAdded((b) => ctx.host.liveCall(name, b), ctx.addedProjects, body)
        : await ctx.host.liveCall(name, body);
      if (name === 'permission' || name === 'elicitation') return noteAnswer(ctx, name, body, [status, payload]);
      // A new chat adds its folder as a project (and brings a removed one back).
      if (name === 'connect') await afterConnect(ctx.removedProjects, body, status, ctx.addedProjects, payload);
      if (name === 'session-op' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const p = payload as Json;
        const deleted = p._deleted;
        delete p._deleted;
        if (Array.isArray(deleted) && deleted.length >= 2) {
          // The agent really deleted its copy: leave an AIB tombstone so the row cannot linger.
          const title = typeof body?.title === 'string' ? body.title : '';
          try {
            await ctx.conversations.apply('delete', deleted[0], deleted[1], title, '', true);
          } catch (error) {
            if (!(error instanceof ValueError)) throw error;
          }
        }
      }
      return [status, payload];
    });
  }
  return routes;
}
