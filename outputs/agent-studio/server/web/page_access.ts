/**
 * Who may be given the page token (GET /api/live/bootstrap). Before this, bootstrap handed the token to any local caller that set
 * a loopback Host header, so any program on the PC (an agent's shell command included) could take it and act as the page:
 * approve its own permission requests, answer questions, change settings, merge any chat.
 *
 * The approach is the one Jupyter and VS Code's server use (a secret the app hands the page, traded for a credential), with the
 * credential in the page's memory instead of a cookie (a cookie on 127.0.0.1 is also sent to every other port: the artifact origin
 * and any server an agent starts) or browser storage (localStorage, sessionStorage and IndexedDB are plain files in the browser's
 * profile, which every program of the user can read: an agent could take the session from there and act as the page).
 *
 *   launch key   one-time: made for one handover (mintKey), kept in this process's memory only (its SHA-256), good once and only
 *                for a short time (KEY_TTL_MS; a link `serve` prints or opens, LINK_TTL_MS), invalid as soon as it is traded. The
 *                app's windows never carry one in their URL: the desktop side hands a fresh one to the page through the window's
 *                private evaluate channel (desktop/window.ts), at every load (a reload, a crash, a second window, a restart). `serve
 *                --open` opens the browser on `/#aib-key=<key>` (a URL fragment never reaches a server or a log); `serve` prints the
 *                link only to a console (never into a redirected log). A launcher may fix one reusable key with AIB_PAGE_KEY
 *                (tests and demo Studios only); AIB removes that variable from its own environment at once (not in a test run), so no
 *                agent, terminal or keeper it starts inherits it.
 *   page session random, made by POST /api/live/page-session for a page that shows a launch key; the page keeps it in its own
 *                memory only (page-auth.js), so nothing on disk holds it. Only its SHA-256 is on disk (<state>/page-sessions.json),
 *                so a browser tab keeps working across an AIB restart; reading that file does not give a working session. Sessions
 *                of the old format (1: the page kept them in localStorage, where any program could read them) are dropped.
 *
 * Bootstrap gives the token to a request with a known page session (X-AIB-Page-Session) or the launcher's fixed key
 * (X-AIB-Page-Key); anyone else gets every other field and an empty token. A one-time key is good only at POST /page-session.
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
/**
 * At most this many page sessions are remembered (oldest dropped). Every page load makes one (the page keeps it in memory only), so
 * this covers the open windows and tabs with room for many reloads; a window whose session was dropped is handed a new key.
 */
export const MAX_SESSIONS = 200;
/** The page-sessions.json format whose sessions are kept (1: sessions the page kept in localStorage; dropped). */
export const SESSIONS_FORMAT = 2;
/** How long a one-time launch key handed to an app window works (the page trades it at once). */
export const KEY_TTL_MS = 60_000;
/** How long the one-time link `serve` prints or opens works (a person may take a while to click it). */
export const LINK_TTL_MS = 15 * 60_000;
/** At most this many one-time keys wait to be used (oldest dropped). */
export const MAX_KEYS = 64;

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
  /** The launcher's fixed, reusable key (AIB_PAGE_KEY: tests and demo Studios), null in a normal start. */
  readonly fixedKey: string | null;
  readonly #file: string | null;
  #entries: Entry[] = [];
  #mtime = -1;
  /** One-time launch keys not used yet: SHA-256 to the time they stop working. */
  readonly #keys = new Map<string, number>();
  readonly #now: () => number;

  /** stateDir null: sessions are kept in memory only (tests). */
  constructor(stateDir: string | null, fixedKey: string | null = null, now: () => number = Date.now) {
    this.fixedKey = [fixedKey, testRunKey()].find((k) => !!k && KEY_SHAPE.test(k)) ?? null;
    if (this.fixedKey) registerSecret(this.fixedKey);
    this.#now = now;
    this.#file = stateDir ? `${stateDir.replace(/[\\/]+$/, '')}${SEP}${SESSIONS_FILE}` : null;
    this.#load();
  }

  /**
   * A new one-time launch key: good for one POST /api/live/page-session within `ttlMs`, then never again. Kept only as a hash in
   * this process's memory.
   */
  mintKey(ttlMs: number = KEY_TTL_MS): string {
    this.#sweep();
    while (this.#keys.size >= MAX_KEYS) this.#keys.delete(this.#keys.keys().next().value!); // the oldest first
    const key = newToken();
    this.#keys.set(sha256(key), this.#now() + Math.max(0, ttlMs));
    return key;
  }

  /** A key that was not handed over after all (the window had left our page): it stops working now. */
  revoke(key: string): void {
    if (typeof key === 'string' && KEY_SHAPE.test(key)) this.#keys.delete(sha256(key));
  }

  /** True when this one-time key is still good (not used, not expired). Does not use it up. */
  keyValid(key: unknown): boolean {
    if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return false;
    this.#sweep();
    return this.#keys.has(sha256(key));
  }

  /** Uses a launch key up: true for a good one-time key (gone from now on) or the launcher's fixed key. */
  #useKey(key: unknown): boolean {
    if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return false;
    if (this.fixedKey && tokenMatches(key, this.fixedKey)) return true;
    const hash = sha256(key);
    const until = this.#keys.get(hash);
    if (until === undefined) return false;
    this.#keys.delete(hash); // once, whatever happens next
    return until >= this.#now();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [hash, until] of this.#keys) if (until < now) this.#keys.delete(hash);
  }

  /**
   * The page URL with a launch key (base: http://127.0.0.1:<port>), for `serve` to print or open: the launcher's fixed key, else a
   * new one-time key good for LINK_TTL_MS. The app's windows never use it (desktop/window.ts hands keys over privately).
   */
  pageUrl(base: string): string {
    let key = this.fixedKey;
    if (!key) {
      key = this.mintKey(LINK_TTL_MS);
      registerSecret(key); // a one-off link: blanked if it ever reaches a log line
    }
    return `${base.replace(/\/+$/, '')}/#${KEY_FRAGMENT}=${key}`;
  }

  /** True when these request headers prove the caller is the page: a known page session, or the launcher's fixed key. */
  allows(headers: Headers): boolean {
    const key = headers.get(PAGE_KEY_HEADER);
    if (key && this.fixedKey && tokenMatches(key, this.fixedKey)) return true;
    const session = headers.get(PAGE_SESSION_HEADER);
    return !!session && this.knows(session);
  }

  /** True when what a page holds (its page session; '' for none) gets it the token: the same rule as allows(). */
  holds(held: { key?: string; session: string }): boolean {
    return (!!held.key && !!this.fixedKey && tokenMatches(held.key, this.fixedKey)) || (!!held.session && this.knows(held.session));
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

  /**
   * A page session for a caller that shows a launch key, or null. The key is used up by this: a one-time key never works twice.
   * `existing`: a session the page still has (a tab that got a new link) is kept when AIB knows it.
   */
  pair(key: unknown, existing: unknown = null): string | null {
    if (!this.#useKey(key)) return null;
    if (typeof existing === 'string' && existing && this.knows(existing)) {
      return existing;
    }
    const session = newToken();
    this.#load();
    this.#entries = [...this.#entries, {
      hash: sha256(session),
      at: this.#now() / 1000,
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
      // Format 1: sessions the page kept in localStorage, a plain file any program could read; they are dropped.
      const list = data?.format === SESSIONS_FORMAT && Array.isArray(data?.sessions) ? data.sessions : [];
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
        JSON.stringify({ format: SESSIONS_FORMAT, sessions: this.#entries }, null, 1),
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
