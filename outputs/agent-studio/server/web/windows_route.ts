/**
 * K3: POST /api/live/desktop/windows, the page's one way to open, pop out, route to, focus or close an AIB window (design
 * section 4). Page token only (scope 'write': an artifact key is refused, see security.ts), body at most 2 KB (server.ts
 * SMALL_BODY), at most 10 calls per 10 s. No win.bind(): bindings reach artifact iframes, this route does not (F1).
 *
 *   {op:'open',   from, project:{key,name,path}}   -> {w, existed}     one project, one window (D1a): existed = focused it
 *   {op:'popout', from, chat:{key,project,title}}  -> {w, existed}
 *   {op:'popout', from, doc:{project,name}}        -> {w, existed}
 *   {op:'route',  from, target:{chat?,project,doc?}} -> {to:'self'} | {to:w}
 *   {op:'focus',  w}                               -> {ok:true}
 *   {op:'close',  from, w}                         -> {ok:true}         a window closes only itself
 *   errors: 400 bad shape · 403 closing another window · 404 no such window · 409 {cap: 8} · 429 rate · 501 {browser: true}
 *
 * The page never sends a URL: the desktop side builds each one from these fields (windows_contract.ts windowPath). open and
 * popout run one at a time and look at the window list first, so two quick clicks for one project make one window (F3), and
 * the cap holds whatever the desktop side does.
 */
import {
  type DesktopWindows,
  type OpenRequest,
  parseWindowsRequest,
  RateLimit,
  showsAlready,
  WINDOW_CAP,
  WindowCapError,
} from '../desktop/windows_contract.ts';
import type { Presence } from '../attention/presence.ts';

export interface WindowsRouteContext {
  desktopWindows: DesktopWindows | null;
  presence: Presence;
}

type Reply = [number, Record<string, unknown>];

export class WindowsRoute {
  readonly rate: RateLimit;
  /** open/popout one at a time (F3): the next one sees the window the previous one made. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(clock: () => number = Date.now) {
    this.rate = new RateLimit(undefined, undefined, clock);
  }

  async call(c: WindowsRouteContext, body: unknown): Promise<Reply> {
    if (!this.rate.take()) return [429, { error: 'Too many window requests; try again in a moment', code: 'rate' }];
    const req = parseWindowsRequest(body); // a ValueError: 400
    const dw = c.desktopWindows;
    if (!dw) return [501, { error: 'Windows are opened by the AIB desktop app', browser: true }];
    if (req.op === 'open' || req.op === 'popout') return await this.#open(dw, req.req, req.from);
    if (req.op === 'route') {
      const to = await dw.route(req.target, req.from);
      return [200, to.to === 'self' ? { to: 'self' } : { to: to.to }];
    }
    if (req.op === 'focus') return dw.focus(req.w) ? [200, { ok: true }] : [404, { error: 'No such window' }];
    // close
    if (req.from !== req.w) return [403, { error: 'A window can close only itself' }];
    if (!dw.close(req.w)) return [404, { error: 'No such window' }];
    c.presence.leave(req.w); // B8: a closed window is not looking any more
    return [200, { ok: true }];
  }

  #open(dw: DesktopWindows, req: OpenRequest, from: string): Promise<Reply> {
    const run = this.#chain.then(async (): Promise<Reply> => {
      const there = dw.list().find((info) => showsAlready(info, req));
      if (there) {
        dw.focus(there.w);
        return [200, { w: there.w, existed: true }];
      }
      if (dw.list().length >= WINDOW_CAP) return [409, { error: 'At most 8 AIB windows can be open', cap: WINDOW_CAP }];
      try {
        const made = await dw.open(req, from);
        return [200, { w: made.w, existed: !!made.existed }];
      } catch (error) {
        if (error instanceof WindowCapError) return [409, { error: 'At most 8 AIB windows can be open', cap: WINDOW_CAP }];
        throw error;
      }
    });
    this.#chain = run.catch(() => {});
    return run;
  }
}
