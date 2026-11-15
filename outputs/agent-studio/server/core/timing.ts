/**
 * Where start-up and request time goes (history-loading phase 0 found ~7 of 10 s of a real restart outside the history path).
 *
 * - PhaseTimer: one chat's take-over phases (studio.ts #adoptFromNow / #rebuildChat), logged as one INFO line per chat:
 *     keeper: take-over timing claude abc in C:\p: note 12 ms, attach/read 30 ms, replay 4 ms, rebuild 2 ms, lease 1 ms, ... total 60 ms
 * - slowRequestLine / SLOW_REQUEST_MS: any HTTP request whose handler takes 1 s or more (http_serve.ts), path only (a query can
 *   carry a token).
 * Both go out through announce(), so they reach studio.log at the default WARNING level too.
 */
import { announce } from './log.ts';

export const SLOW_REQUEST_MS = 1000;

export class PhaseTimer {
  readonly phases: [string, number][] = [];
  readonly #start: number;
  #last: number;

  constructor(readonly now: () => number = () => performance.now()) {
    this.#start = this.#last = now();
  }

  /** The phase that just ended: the time since the previous mark. */
  mark(phase: string): void {
    const t = this.now();
    this.phases.push([phase, t - this.#last]);
    this.#last = t;
  }

  /** The time since the last mark, split into phases measured elsewhere (a Connection's own marks) and the rest. */
  split(parts: [string, number][], rest: string): void {
    const t = this.now();
    let left = t - this.#last;
    for (const [phase, ms] of parts) {
      this.phases.push([phase, Math.max(0, ms)]);
      left -= Math.max(0, ms);
    }
    if (left >= 1 || !parts.length) this.phases.push([rest, Math.max(0, left)]);
    this.#last = t;
  }

  total(): number {
    return this.now() - this.#start;
  }

  line(label: string): string {
    const parts = this.phases.map(([phase, ms]) => `${phase} ${Math.round(ms)} ms`);
    return `take-over timing ${label}: ${[...parts, `total ${Math.round(this.total())} ms`].join(', ')}`;
  }

  log(label: string): void {
    announce('studio', 'keeper: %s', this.line(label));
  }
}

export function slowRequestLine(method: string, url: string, ms: number, status: number | null): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch { /* a raw path already */ }
  path = path.split('?')[0];
  return `slow request: ${method} ${path} took ${Math.round(ms)} ms${status === null ? ' (failed)' : ` (${status})`}`;
}

/** Log a request that took SLOW_REQUEST_MS or more. */
export function noteRequestTime(method: string, url: string, ms: number, status: number | null): void {
  if (ms >= SLOW_REQUEST_MS) announce('http', '%s', slowRequestLine(method, url, ms, status));
}

/**
 * A rebuilt Connection's own marks (rebuildTimes: adopt, live, replayed, settled; performance.now()) as phases: attach/read (the
 * keeper sends the record up to the live end), replay (snapshot restore and the records after it), rebuild (claim, client
 * terminals, held answers). A step not reached adds nothing.
 */
export function rebuildPhases(
  timer: PhaseTimer,
  t: { adopt: number; live: number; replayed: number; settled: number } = { adopt: 0, live: 0, replayed: 0, settled: 0 },
): void {
  const parts: [string, number][] = [];
  if (t.adopt && t.live) parts.push(['attach/read', t.live - t.adopt]);
  if (t.live && t.replayed) parts.push(['replay', t.replayed - t.live]);
  if (t.replayed && t.settled) parts.push(['rebuild', t.settled - t.replayed]);
  timer.split(parts, 'waiting');
}
