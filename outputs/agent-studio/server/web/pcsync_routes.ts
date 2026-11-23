/**
 * Settings > Sync on the PC (routes.ts DENO_ONLY, page token): view, turn on or off, Start a sync chain, Cancel, Approve or Reject
 * a PC that claimed the code, the Tailscale devices to join from, Join with the six words, Share sync (the one `tailscale serve`
 * command), Remove a paired PC. Page port only; the sync listener (pcsync/service.ts) never answers these and the phone port and
 * the computer bridge refuse them (remote/pc_routes.ts: never).
 */
import { ValueError } from '../core/py.ts';
import { PairingError } from '../remote/pairing.ts';
import type { WebContext } from './server.ts';

type Json = Record<string, unknown>;
type Reply = [number, unknown];
type Handler = (ctx: WebContext, url: URL, body: Json | null, request?: Request) => Promise<Reply> | Reply;

function wrap(handler: Handler): Handler {
  return async (ctx, url, body, request) => {
    try {
      return await handler(ctx, url, body, request);
    } catch (error) {
      if (error instanceof PairingError) return [error.status, { error: error.message, code: error.code }];
      if (error instanceof RangeError) throw new ValueError(error.message);
      throw error;
    }
  };
}

export function pcsyncRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  routes.set('GET /api/live/pcsync', async (ctx) => [200, await ctx.pcsync.view()]);
  routes.set('GET /api/live/pcsync/devices', async (ctx) => [200, { devices: await ctx.pcsync.devices() }]);
  routes.set('POST /api/live/pcsync/on', async (ctx, _url, body) => {
    if (typeof body?.on !== 'boolean') throw new ValueError('on must be true or false');
    await ctx.pcsync.setOn(body.on);
    return [200, { ok: true, ...await ctx.pcsync.view() }];
  });
  routes.set('POST /api/live/pcsync/start', async (ctx) => [200, { ok: true, ...await ctx.pcsync.startChain() }]);
  routes.set('POST /api/live/pcsync/cancel', (ctx) => {
    ctx.pcsync.cancelPairing();
    return [200, { ok: true }];
  });
  routes.set('POST /api/live/pcsync/approve', (ctx, _url, body) => [200, { ok: true, peer: ctx.pcsync.approve(body?.claim) }]);
  routes.set('POST /api/live/pcsync/reject', (ctx, _url, body) => [200, { ok: true, rejected: ctx.pcsync.reject(body?.claim) }]);
  routes.set('POST /api/live/pcsync/join', async (ctx, _url, body) => [200, await ctx.pcsync.join(body?.host, body?.code)]);
  routes.set('POST /api/live/pcsync/share', async (ctx) => [200, await ctx.pcsync.share()]);
  routes.set('POST /api/live/pcsync/remove', async (ctx, _url, body) => [200, { ok: true, ...await ctx.pcsync.remove(body?.id) }]);
  // project matching (slice V3): link by hand, confirm a link the other PC proposed, unlink, the Docs and aib-shared switches
  routes.set('POST /api/live/pcsync/projects/link', async (ctx, _url, body) => {
    const link = await ctx.pcsync.projects.linkByHand(body?.peer, body?.mine, body?.theirs);
    return [200, { ok: true, sync: link.sync }];
  });
  routes.set('POST /api/live/pcsync/projects/confirm', (ctx, _url, body) => [200, { ok: true, sync: ctx.pcsync.projects.confirm(body?.sync).sync }]);
  routes.set('POST /api/live/pcsync/projects/unlink', (ctx, _url, body) => [200, { ok: true, unlinked: ctx.pcsync.projects.unlink(body?.sync) }]);
  routes.set('POST /api/live/pcsync/projects/switch', (ctx, _url, body) => {
    const link = ctx.pcsync.projects.setSwitch(body?.sync, body?.which, body?.on);
    return [200, { ok: true, sync: link.sync, docs: link.docs, shared: link.shared }];
  });
  // a paused batch of deletes (slice V4): Allow applies it, Keep files keeps the files and sends them back
  routes.set('POST /api/live/pcsync/projects/files', (ctx, _url, body) => {
    if (body?.action !== 'allow' && body?.action !== 'keep') throw new ValueError('action must be allow or keep');
    if (typeof body.sync !== 'string' || !ctx.pcsync.files.decide(body.sync, body.action)) {
      throw new PairingError(409, 'not_paused', 'Nothing is waiting for a decision in that project.');
    }
    return [200, { ok: true }];
  });
  for (const [key, handler] of routes) routes.set(key, wrap(handler));
  return routes;
}
