/**
 * A fake K4 (ctx.desktopWindows, server/desktop/windows_contract.ts) for the Phase 1 tests: an in-memory window list, no real
 * window. It records what the real one (Phase 2A, server/desktop/windows.ts) would do: the URL each window is navigated to (built
 * with the contract's windowUrl), its title, focus calls and the opens it delivers through a window's openFromDesktop.
 *
 * On purpose it records a new window only after its (simulated, `makeMs`) creation finished, like a naive implementation: the
 * route's own queue and list check must still make two quick clicks one window (F3).
 */
import {
  cleanTitle,
  type DesktopWindows,
  type OpenRequest,
  type RouteTarget,
  showsAlready,
  WINDOW_CAP,
  WindowCapError,
  type WindowInfo,
  type WindowSpec,
  windowUrl,
} from '../../app/server/desktop/windows_contract.ts';

export interface FakeWindow extends WindowInfo {
  url: string;
  title: string;
}

export class FakeDesktopWindows implements DesktopWindows {
  windows: FakeWindow[] = [];
  /** Every focus(w) call, in order. */
  focused: string[] = [];
  /** Opens delivered to another window by route(): [window, target]. */
  delivered: [string, RouteTarget][] = [];
  /** How many windows open() made. */
  made = 0;

  constructor(
    readonly origin = 'http://127.0.0.1:1',
    readonly launchKey = 'launch-key', // kept for the callers' argument order; window URLs never carry a key now
    readonly makeMs = 0,
    withMain = true,
  ) {
    if (withMain) this.#add({ w: 'm', kind: 'main' }, 'AIB');
  }

  /** A window as if restored from the saved list (no open() call): a pop-out with the window it was moved out of. */
  restore(spec: WindowSpec, title: string, from?: string): FakeWindow {
    const x = this.#add(spec, title);
    if (from) x.from = from;
    return x;
  }

  #add(spec: WindowSpec, title: string): FakeWindow {
    const info: FakeWindow = {
      w: spec.w,
      kind: spec.kind,
      project: spec.kind === 'main' ? null : spec.project,
      chat: spec.kind === 'chat' ? spec.chat : null,
      doc: spec.kind === 'doc' ? { project: spec.project, name: spec.name } : null,
      visible: true,
      url: windowUrl(this.origin, spec),
      title,
    };
    this.windows.push(info);
    return info;
  }

  #freeId(): string {
    for (let n = 2; n <= WINDOW_CAP; n++) if (!this.windows.some((x) => x.w === `w${n}`)) return `w${n}`;
    throw new WindowCapError('At most 8 AIB windows');
  }

  async open(req: OpenRequest, from: string): Promise<{ w: string; existed: boolean }> {
    const there = this.windows.find((x) => showsAlready(x, req));
    if (there) {
      this.focus(there.w);
      return { w: there.w, existed: true };
    }
    if (this.windows.length >= WINDOW_CAP) throw new WindowCapError('At most 8 AIB windows');
    if (this.makeMs) await new Promise((r) => setTimeout(r, this.makeMs));
    const w = this.#freeId();
    this.made++;
    if ('project' in req) this.#add({ w, kind: 'project', project: req.project.key }, `AIB · ${cleanTitle(req.project.name)}`);
    else if ('chat' in req) {
      this.#add({ w, kind: 'chat', chat: req.chat.key, project: req.chat.project }, `${cleanTitle(req.chat.title) || 'Chat'} · AIB`).from = from;
    } else this.#add({ w, kind: 'doc', project: req.doc.project, name: req.doc.name }, `${cleanTitle(req.doc.name)} · AIB`).from = from;
    this.focus(w);
    return { w, existed: false };
  }

  /** The B6 chooser: the pop-out with that chat (or doc), then the window pinned to its project, then main (made if needed). */
  route(target: RouteTarget, from: string): Promise<{ to: 'self' } | { to: string }> {
    const find = (f: (x: FakeWindow) => boolean) => this.windows.find(f);
    const pick = (target.chat && find((x) => x.kind === 'chat' && x.chat === target.chat)) ||
      (target.doc && find((x) => x.kind === 'doc' && x.doc?.project === target.doc!.project && x.doc?.name === target.doc!.name)) ||
      find((x) => x.kind === 'project' && x.project === target.project) ||
      find((x) => x.kind === 'main') ||
      this.#add({ w: 'm', kind: 'main' }, 'AIB'); // only the main window has the id 'm'
    if (pick.w === from) return Promise.resolve({ to: 'self' });
    this.focus(pick.w);
    this.delivered.push([pick.w, target]);
    return Promise.resolve({ to: pick.w });
  }

  focus(w: string): boolean {
    if (!this.windows.some((x) => x.w === w)) return false;
    this.focused.push(w);
    return true;
  }

  close(w: string): boolean {
    const at = this.windows.findIndex((x) => x.w === w);
    if (at < 0) return false;
    this.windows.splice(at, 1);
    return true;
  }

  list(): WindowInfo[] {
    return this.windows.map(({ w, kind, project, chat, doc, visible, from }) => ({
      w,
      kind,
      project,
      chat,
      doc: doc ? { ...doc } : null,
      visible,
      from: from ?? null,
    }));
  }

  othersAlive(w: string): boolean {
    return this.windows.some((x) => x.w !== w);
  }
}
