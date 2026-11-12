/**
 * The live routes that are answered by the agent host (web_handler.py: get_state, get_ownership, post_live_op, the agent install and
 * sign-in routes, post_shutdown). The web server forwards them through the HostProxy, exactly as RemoteStudio does.
 */
import { ValueError } from '../core/py.ts';
import { pyInt } from '../transcripts/pycompat.ts';
import { modelInUse } from '../transcripts/store.ts';
import { refuseNetworkPath } from './security.ts';
import type { WebContext } from './server.ts';
import { afterConnect, discoverAdded } from './project_routes.ts';

/** Studio.LIVE_POST_OPS: the generic POST /api/live/<name> calls. A test keeps this equal to Python's set. */
export const LIVE_POST_OPS = [
  'connect', 'discover', 'forget', 'prompt', 'cancel', 'permission', 'authenticate', 'elicitation', 'config', 'mode', 'cancel-pending',
  'session-op', 'disconnect', 'queue', 'queue-edit', 'queue-remove', 'queue-move', 'queue-resume', 'queue-send-now', 'dismiss-unknown',
  'worktree-discard', 'worktree-archive',
] as const;

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

function installAgent(body: Json | null): string {
  const agent = body?.agent;
  if (typeof agent !== 'string') throw new ValueError('agent must be text');
  return agent;
}

export function liveRoutes(): Map<string, LiveHandler> {
  const routes = new Map<string, LiveHandler>();
  routes.set('GET /api/live/state', async (ctx, url) => {
    const state = await ctx.host.liveState(arg(url, 'id'), pyInt(arg(url, 'after', '0'))) as Json | null;
    if (state === null) {
      return [404, {
        error: 'This AIB connection is no longer available. Your saved conversation can be continued again.',
        code: 'connection_not_found',
      }];
    }
    return [200, { ...state, inUse: await inUse(ctx, state) }];
  });
  routes.set('GET /api/live/ownership', async (ctx, url) => {
    let cwd: string;
    try {
      cwd = refuseNetworkPath(arg(url, 'cwd'));
    } catch (error) {
      throw new ValueError((error as Error).message);
    }
    return [200, await ctx.host.ownershipQuery(arg(url, 'provider'), arg(url, 'id'), cwd)];
  });
  routes.set('GET /api/live/agents/install', (ctx, url) => ctx.host.installCall('status', arg(url, 'agent')));
  routes.set('POST /api/live/agents/install', (ctx, _url, body) => ctx.host.installCall('start', installAgent(body)));
  routes.set('POST /api/live/agents/install/cancel', (ctx, _url, body) => ctx.host.installCall('cancel', installAgent(body)));
  // Deno only (routes.ts DENO_ONLY): a Python agent host answers the unknown action with 404, so nothing is removed there.
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
  for (const name of LIVE_POST_OPS) {
    routes.set(`POST /api/live/${name}`, async (ctx, _url, body) => {
      // "Find more chats via agent" lists only chats of added projects (empty pages skipped); it never adds one.
      const [status, payload] = name === 'discover'
        ? await discoverAdded((b) => ctx.host.liveCall(name, b), ctx.addedProjects, body)
        : await ctx.host.liveCall(name, body);
      // A new chat adds its folder as a project (and brings a removed one back).
      if (name === 'connect') await afterConnect(ctx.removedProjects, body, status, ctx.addedProjects, payload);
      if (name === 'session-op' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const p = payload as Json;
        const deleted = p._deleted;
        delete p._deleted;
        if (Array.isArray(deleted) && deleted.length >= 2) {
          // The agent really deleted its copy: leave a Studio tombstone so the row cannot linger.
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
