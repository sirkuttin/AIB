/**
 * Is the owner at the PC? The page tells the server (POST /api/live/presence) whether its window has focus and how long ago the
 * person last typed, clicked or scrolled in it; it does so when that changes and every 20 s while it has focus. A report older
 * than 45 s counts as "not focused": the window was closed, AIB was quit, or the page stopped.
 *
 *   focused()   an AIB window has focus now: no desktop notification (the page's own badge, list and toasts show it).
 *   active()    focused, and input in the last 2 minutes: no phone push either (the owner is working at the PC right now).
 */
export const STALE_MS = 45_000;
export const ACTIVE_MS = 120_000;

export class Presence {
  #focused = false;
  #at = 0;
  #inputAt = 0;

  constructor(readonly clock: () => number = Date.now) {}

  /** A page's report: its window has focus or not, and the time since its last input (ms). */
  report(focused: unknown, idleMs: unknown): void {
    const now = this.clock();
    const idle = Number(idleMs);
    this.#focused = focused === true;
    this.#at = now;
    if (Number.isFinite(idle) && idle >= 0) this.#inputAt = Math.max(this.#inputAt, now - Math.min(idle, 7 * 86400_000));
  }

  focused(): boolean {
    return this.#focused && this.clock() - this.#at < STALE_MS;
  }

  active(): boolean {
    return this.focused() && this.clock() - this.#inputAt < ACTIVE_MS;
  }
}
