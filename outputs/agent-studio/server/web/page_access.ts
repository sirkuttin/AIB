/**
 * Who may be given the page token (GET /api/live/bootstrap). Before this, bootstrap handed the token to any local caller that set
 * a loopback Host header, so any program on the PC (an agent's shell command included) could take it and act as the page:
 * approve its own permission requests, answer questions, change settings, merge any chat.
 *
 * The approach is the one Jupyter and VS Code's server use (a secret in the link the app opens, traded for a lasting credential),
 * with browser storage instead of a cookie, because a cookie on 127.0.0.1 is also sent to every other port (the artifact origin
 * and any server an agent starts).
 *
 *   launch key   random per AIB process, kept in memory only. The app opens its window on `/#aib-key=<key>` (a URL fragment never
 *                reaches a server or a log); `serve --open` opens the browser the same way; `serve` prints the link only to a
 *                console (never into a redirected log). A launcher may choose it with AIB_PAGE_KEY (tests); AIB removes that
 *                variable from its own environment at once (not in a test run), so no agent, terminal or keeper it starts inherits it.
 *   page session random, made by POST /api/live/page-session for a page that shows the launch key; the page keeps it in its own
 *                origin's localStorage (port-specific, unlike a cookie), so a reload or an AIB restart needs no new link. Only its
 *                SHA-256 is on disk (<state>/page-sessions.json): reading that file does not give a working session.
 *
 * Bootstrap gives the token to a request with the launch key (X-AIB-Page-Key) or a known page session (X-AIB-Page-Session);
 * anyone else gets every other field and an empty token.
 */
import { createHash } from 'node:crypto';
import { registerSecret } from '../core/log.ts';
import { newToken, tokenMatches } from './security.ts';

export const PAGE_KEY_HEADER = 'X-AIB-Page-Key';
export const PAGE_SESSION_HEADER = 'X-AIB-Page-Session';
/** The environment variable a launcher (a test harness) may set to choose the launch key. Removed from the environment at start. */
export const PAGE_KEY_ENV = 'AIB_PAGE_KEY';
export const SESSIONS_FILE = 'page-sessions.json';
/** The URL fragment parameter the page reads the launch key from. */
export const KEY_FRAGMENT = 'aib-key';
/** At most this many page sessions are remembered (oldest dropped): one per browser or window profile that opened AIB. */
export const MAX_SESSIONS = 20;

const KEY_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

/**
 * The launch key from AIB_PAGE_KEY (when well formed), and the variable removed from this process's environment either way, so
 * nothing AIB starts inherits it. A test run (AGENT_STUDIO_TEST=1) keeps it: an AIB that the test's AIB starts again (an update, the
 * keeper's restart) answers the test with the same key.
 */
export function takeLaunchKeyFromEnv(): string | null {
  let value: string | undefined;
  try {
    value = Deno.env.get(PAGE_KEY_ENV);
    if (Deno.env.get('AGENT_STUDIO_TEST') !== '1') {
      Deno.env.delete(PAGE_KEY_ENV);
    }
  } catch {
    return null; // no env access
  }
  return value && KEY_SHAPE.test(value) ? value : null;
}

/** In a test run (AGENT_STUDIO_TEST=1) a server made in the test's own process uses the run's AIB_PAGE_KEY; otherwise none. */
function testRunKey(): string | null {
  try {
    return Deno.env.get('AGENT_STUDIO_TEST') === '1' ? Deno.env.get(PAGE_KEY_ENV) ?? null : null;
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Entry {
  hash: string;
  at: number;
}

export class PageAccess {
  readonly launchKey: string;
  readonly #file: string | null;
  #entries: Entry[] = [];
  #mtime = -1;

  /** stateDir null: sessions are kept in memory only (tests). */
  constructor(stateDir: string | null, launchKey: string | null = null) {
    this.launchKey = [launchKey, testRunKey()].find((k) => !!k && KEY_SHAPE.test(k)) ??
      newToken();
    registerSecret(this.launchKey); // the window's URL is logged ("window: opening ..."): the key is blanked there
    this.#file = stateDir ? `${stateDir.replace(/[\\/]+$/, '')}${SEP}${SESSIONS_FILE}` : null;
    this.#load();
  }

  /** The page URL that carries the launch key (base: http://127.0.0.1:<port>). */
  pageUrl(base: string): string {
    return `${base.replace(/\/+$/, '')}/#${KEY_FRAGMENT}=${this.launchKey}`;
  }

  /** True when these request headers prove the caller is the page: the launch key, or a page session made with it. */
  allows(headers: Headers): boolean {
    const key = headers.get(PAGE_KEY_HEADER);
    if (key && tokenMatches(key, this.launchKey)) return true;
    const session = headers.get(PAGE_SESSION_HEADER);
    return !!session && this.knows(session);
  }

  /** True for a page session made by pair() (in this or another AIB of the same data folder). */
  knows(session: string): boolean {
    if (!KEY_SHAPE.test(session)) return false;
    const hash = sha256(session);
    if (this.#entries.some((e) => tokenMatches(hash, e.hash))) return true;
    if (this.#load()) {
      return this.#entries.some((e) => tokenMatches(hash, e.hash)); // another process paired since
    }
    return false;
  }

  /** A page session for a caller that shows the launch key (the one it has when it is still known, else a new one), or null. */
  pair(key: unknown, existing: unknown = null): string | null {
    if (typeof key !== 'string' || !tokenMatches(key, this.launchKey)) {
      return null;
    }
    if (typeof existing === 'string' && existing && this.knows(existing)) {
      return existing;
    }
    const session = newToken();
    this.#load();
    this.#entries = [...this.#entries, {
      hash: sha256(session),
      at: Date.now() / 1000,
    }].slice(-MAX_SESSIONS);
    this.#save();
    return session;
  }

  /** Re-read the file when it changed. True when it was read. */
  #load(): boolean {
    if (!this.#file) return false;
    let mtime: number;
    try {
      mtime = Deno.statSync(this.#file).mtime?.getTime() ?? 0;
    } catch {
      return false;
    }
    if (mtime === this.#mtime) return false;
    try {
      const data = JSON.parse(Deno.readTextFileSync(this.#file));
      const list = Array.isArray(data?.sessions) ? data.sessions : [];
      this.#entries = list
        .filter((e: unknown) =>
          !!e && typeof (e as Entry).hash === 'string' &&
          /^[0-9a-f]{64}$/.test((e as Entry).hash)
        )
        .map((e: Entry) => ({ hash: e.hash, at: Number(e.at) || 0 }))
        .slice(-MAX_SESSIONS);
      this.#mtime = mtime;
      return true;
    } catch {
      return false; // half written by another process: the next miss reads it again
    }
  }

  #save(): void {
    if (!this.#file) return;
    const temp = `${this.#file}.${Deno.pid}.tmp`;
    try {
      Deno.writeTextFileSync(
        temp,
        JSON.stringify({ format: 1, sessions: this.#entries }, null, 1),
        { mode: 0o600 },
      );
      Deno.renameSync(temp, this.#file);
      this.#mtime = Deno.statSync(this.#file).mtime?.getTime() ?? 0;
    } catch {
      try {
        Deno.removeSync(temp);
      } catch { /* not there */ }
      // not saved: the session works until this AIB exits
    }
  }
}
