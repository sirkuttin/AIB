/**
 * URLs a program inside a distro asks Windows to open (the helper's `browser.open`, from the aib-open shim that BROWSER points to;
 * docs/wsl/design.md sections 6 and 11). The rule:
 *   - opened at once within 5 minutes of the user starting a sign-in for that distro (the agent's login page), or when the user chose
 *     "Always allow" for that distro (kept in the data folder);
 *   - otherwise asked first: the page shows "Ubuntu wants to open <url>" with Open, Always allow for Ubuntu and Don't open;
 *   - http and https only, at most 2048 bytes, at most 3 per minute per distro (more are dropped), at most 10 waiting.
 * Nothing here runs a shell: the opener is rundll32's URL handler with the URL as one argument, as desktop/native.ts openExternal.
 */
import type { WslHost } from './contract.ts';
import { getLogger } from '../core/log.ts';
import { clearMemos } from '../core/memo.ts';

const log = getLogger('wsl');

export const SIGNIN_WINDOW_MS = 5 * 60_000;
export const MAX_URL_BYTES = 2048;
export const RATE_PER_MINUTE = 3;
export const MAX_WAITING = 10;
export const ALLOW_FILE = 'wsl-open-urls.json';

export interface UrlRequest {
  id: string;
  distro: string;
  url: string;
  at: number;
}

/** http(s) and short enough; '' when refused. */
export function cleanUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const text = url.trim();
  if (!text || new TextEncoder().encode(text).length > MAX_URL_BYTES || /[\s\0]/.test(text)) return '';
  if (!/^https?:\/\/[^/?#\s]+/i.test(text)) return '';
  return text;
}

function defaultOpener(url: string): void {
  const [cmd, args] = Deno.build.os === 'windows'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : Deno.build.os === 'darwin'
    ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    new Deno.Command(cmd as string, { args: args as string[], stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
  } catch { /* no browser */ }
}

export class WslUrlGate {
  #stateDir: string | null = null;
  #opener: (url: string) => void = defaultOpener;
  #now: () => number = () => Date.now();
  readonly #signIn = new Map<string, number>();
  readonly #recent = new Map<string, number[]>();
  readonly #waiting: UrlRequest[] = [];
  #allowed: Set<string> | null = null;

  /** Where "Always allow" is kept (the data folder; null: kept in memory only). */
  configure(stateDir: string | null): void {
    if (this.#stateDir === stateDir) return;
    this.#stateDir = stateDir;
    this.#allowed = null;
  }

  /** Tests: record instead of opening a browser, and their own clock. */
  setForTests(opener: ((url: string) => void) | null, now: (() => number) | null = null): void {
    this.#opener = opener ?? defaultOpener;
    this.#now = now ?? (() => Date.now());
    this.#signIn.clear();
    this.#recent.clear();
    this.#waiting.length = 0;
    this.#allowed = null;
    this.#stateDir = null;
  }

  /** Follow a host's URL requests. */
  watch(host: WslHost): () => void {
    return host.onOpenUrl((url) => this.offer(host.distro, url));
  }

  /** The user started an agent's sign-in in this distro: its login page opens directly for the next 5 minutes. */
  signInStarted(distro: string): void {
    this.#signIn.set(distro.toLowerCase(), this.#now());
  }

  #allowSet(): Set<string> {
    if (this.#allowed) return this.#allowed;
    this.#allowed = new Set();
    if (this.#stateDir) {
      try {
        const saved = JSON.parse(Deno.readTextFileSync(`${this.#stateDir}/${ALLOW_FILE}`));
        for (const d of Array.isArray(saved?.alwaysAllow) ? saved.alwaysAllow : []) if (typeof d === 'string') this.#allowed.add(d.toLowerCase());
      } catch { /* none yet */ }
    }
    return this.#allowed;
  }

  alwaysAllowed(distro: string): boolean {
    return this.#allowSet().has(distro.toLowerCase());
  }

  allowedList(): string[] {
    return [...this.#allowSet()].sort();
  }

  #saveAllowed(): void {
    if (!this.#stateDir) return;
    try {
      Deno.writeTextFileSync(`${this.#stateDir}/${ALLOW_FILE}`, JSON.stringify({ alwaysAllow: this.allowedList() }));
    } catch (error) {
      log.warning('wsl: could not save the always-allow list: %s', error instanceof Error ? error.message : error);
    }
  }

  /** A URL from a distro: 'opened', 'asked' (waits for the page) or 'refused' (not http(s), too long, too many). */
  offer(distro: string, url: unknown): 'opened' | 'asked' | 'refused' {
    const key = String(distro).toLowerCase();
    const clean = cleanUrl(url);
    if (!clean) return 'refused';
    const now = this.#now();
    const recent = (this.#recent.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= RATE_PER_MINUTE) {
      this.#recent.set(key, recent);
      return 'refused';
    }
    recent.push(now);
    this.#recent.set(key, recent);
    const signIn = this.#signIn.get(key);
    if ((signIn !== undefined && now - signIn <= SIGNIN_WINDOW_MS) || this.alwaysAllowed(key)) {
      this.#opener(clean);
      return 'opened';
    }
    if (this.#waiting.some((w) => w.distro === key && w.url === clean)) return 'asked';
    this.#waiting.push({ id: crypto.randomUUID(), distro: key, url: clean, at: now });
    while (this.#waiting.length > MAX_WAITING) this.#waiting.shift();
    clearMemos(); // the kept WSL status answer carries the waiting URLs: the page's next poll must see this one
    return 'asked';
  }

  /** The URLs waiting for the user, oldest first. */
  waiting(): UrlRequest[] {
    return this.#waiting.map((w) => ({ ...w }));
  }

  /** The page's answer: 'open' once, 'always' (open and allow this distro from now on), 'dismiss'. False for an unknown id. */
  answer(id: unknown, action: unknown): boolean {
    const at = this.#waiting.findIndex((w) => w.id === id);
    if (at < 0 || (action !== 'open' && action !== 'always' && action !== 'dismiss')) return false;
    const [request] = this.#waiting.splice(at, 1);
    clearMemos();
    if (action === 'always') {
      this.#allowSet().add(request.distro);
      this.#saveAllowed();
    }
    if (action !== 'dismiss') this.#opener(request.url);
    return true;
  }

  /** Settings: stop always allowing a distro. */
  disallow(distro: string): void {
    if (this.#allowSet().delete(distro.toLowerCase())) this.#saveAllowed();
  }
}

export const urlGate = new WslUrlGate();
