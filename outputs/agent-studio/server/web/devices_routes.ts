/**
 * Settings > Devices on the PC (routes.ts DENO_ONLY, page token): Phone access on/off, Check again, Add a phone (pairing code, QR,
 * six words), approve or reject a phone that claimed the code, remove one phone or all, and the phone activity log. These run on
 * the page port only; the phone port (remote/server.ts) never answers them.
 */
import { ValueError } from '../core/py.ts';
import { PairingError } from '../remote/pairing.ts';
import type { WebContext } from './server.ts';

type Json = Record<string, unknown>;
type Reply = [number, unknown];
type Handler = (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply> | Reply;

function wrap(handler: Handler): Handler {
  return async (ctx, url, body) => {
    try {
      return await handler(ctx, url, body);
    } catch (error) {
      if (error instanceof PairingError) return [error.status, { error: error.message, code: error.code }];
      if (error instanceof RangeError) throw new ValueError(error.message);
      throw error;
    }
  };
}

export function devicesRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  routes.set('GET /api/live/devices', (ctx) => [200, ctx.phone.view()]);
  routes.set('POST /api/live/devices/access', async (ctx, _url, body) => {
    if (typeof body?.on !== 'boolean') throw new ValueError('on must be true or false');
    await ctx.phone.setOn(body.on);
    return [200, { ok: true, ...ctx.phone.view() }];
  });
  routes.set('POST /api/live/devices/check', async (ctx) => {
    await ctx.phone.check();
    return [200, { ok: true, ...ctx.phone.view() }];
  });
  routes.set('POST /api/live/devices/pair', (ctx) => [200, { ok: true, ...ctx.phone.startPairing() }]);
  routes.set('POST /api/live/devices/pair/cancel', (ctx) => {
    ctx.phone.pairing.cancel();
    return [200, { ok: true }];
  });
  routes.set(
    'POST /api/live/devices/approve',
    async (ctx, _url, body) => [200, { ok: true, device: await ctx.phone.approve(body?.claim, body?.scopes) }],
  );
  routes.set('POST /api/live/devices/reject', (ctx, _url, body) => [200, { ok: true, rejected: ctx.phone.reject(body?.claim) }]);
  routes.set('POST /api/live/devices/remove', async (ctx, _url, body) => [200, { ok: true, removed: await ctx.phone.remove(body?.id) }]);
  routes.set('POST /api/live/devices/remove-all', async (ctx) => [200, { ok: true, removed: await ctx.phone.removeAll() }]);
  routes.set('GET /api/live/devices/activity', (ctx) => [200, { entries: ctx.phone.activity() }]);
  for (const [key, handler] of routes) routes.set(key, wrap(handler));
  return routes;
}
