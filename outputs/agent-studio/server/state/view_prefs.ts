/**
 * The page's view and appearance preferences (Deno only, no Python counterpart): sidebar mode and grouping, open and collapsed
 * groups, panel widths, text size, code font, spacing, chat views, chat display names and the like. The page keeps them in its
 * localStorage, which in the desktop app belongs to the WebView2 profile next to AIB.exe, so every new copy of the app started
 * at the defaults. Kept here, in the state folder, they follow the user's data instead.
 *
 * The page owns the meaning: this store keeps opaque strings under localStorage key names (view-prefs.js lists which keys).
 * The page reads them from chat.html (server.ts writes them into a JSON data block) and writes changes with
 * POST /api/live/view-prefs {set: {key: string | null}} (null removes the key). Each key stands alone: a bad or oversized one is
 * refused (listed in the answer's `refused`) and the rest are saved. This is also where the sidebar's project, its open tabs and
 * last chat per project, the Files tabs and open folders and the inbox's seen turns live, so a new copy of the app unzipped into
 * another folder (a fresh WebView2 profile) opens where the last one left off.
 *
 *   studio-view.json: {"version": 1, "prefs": {key: string}}
 */
import { isDict, ValueError } from '../core/py.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson, VERSION } from './base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from './json.ts';

/** The page's key for chat display names (Rename; view-prefs.js). */
export const CHAT_NAMES = 'studio-conversation-names';

/** The chat display names in a set of view preferences: {provider:sessionId: name} (bad entries left out). */
export function chatNamesOf(prefs: Record<string, string>): Record<string, string> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(prefs[CHAT_NAMES] ?? '{}');
  } catch { /* unreadable: no names */ }
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && v.trim()) out[k] = v;
  return out;
}

export class ViewPrefs extends JsonFileStore {
  static FILE = 'studio-view.json';
  static MAX_KEYS = 200;
  static MAX_VALUE = 256 * 1024; // characters, per key (the per-chat view choices and chat names are the big ones)
  static MAX_TOTAL = 2 * 1024 * 1024; // characters, all values together
  /** A localStorage key name the page uses: 'studio-...', 'aib-...' or 'agentStudio.…', with a bucket suffix like ':<1400'. */
  static KEY = /^(?:studio-|aib-|agentStudio\.)[A-Za-z0-9._:<>=-]{1,100}$/;

  prefs: Record<string, string> = {};

  constructor(stateDir: string | null = null) {
    super();
    this.path = stateDir ? inDir(stateDir, ViewPrefs.FILE) : null;
    this.reload();
  }

  static key(value: unknown): string | null {
    return typeof value === 'string' && ViewPrefs.KEY.test(value) ? value : null;
  }

  static #total(prefs: Record<string, string>): number {
    return Object.values(prefs).reduce((n, v) => n + v.length, 0);
  }

  protected reload(): void {
    this.prefs = {};
    if (this.path === null) return;
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === 'busy') {
      this.unreadableNow('Saved view preferences could not be read just now; changes are paused.');
      return;
    }
    this.unreadable = false;
    if (status === 'missing') {
      this.warning = '';
      return;
    }
    if (status === 'corrupt') {
      this.warning = 'Saved view preferences were unreadable and were ignored.';
      quarantine(this.path);
      this.seen = this.stamp();
      return;
    }
    if (!isDict(raw) || raw.version !== VERSION || !isDict(raw.prefs)) {
      this.warning = 'Saved view preferences have an unknown format and were ignored.';
      return;
    }
    this.warning = '';
    for (const [key, value] of entriesOf(raw.prefs).slice(0, ViewPrefs.MAX_KEYS)) {
      if (ViewPrefs.key(key) && typeof value === 'string' && value.length <= ViewPrefs.MAX_VALUE) this.prefs[key] = value;
    }
  }

  public(): { revision: string; warning: string; prefs: Record<string, string> } {
    this.sync();
    return { revision: `${this.nonce}.${this.counter}`, warning: this.warning, prefs: { ...this.prefs } };
  }

  #save(): void {
    if (this.path === null) return;
    this.requireReadable();
    saveJson(this.path, { version: VERSION, savedAt: now(), prefs: this.prefs }, '.studio-view-');
    this.seen = this.stamp();
  }

  /** Per key, the page and batch number of the last value saved: a page sends without waiting for its previous request, so an
   * older batch of the same page that arrives late must not overwrite a newer one. */
  #order = new Map<string, { page: string; seq: number }>();

  /* Saves on their way (POST /api/live/view-prefs): quitting waits for them (settle), so a project picked just before the window
     closed is on disk before AIB exits. The page sends with keepalive, so a request already sent outlives the closed page while
     the process lives. */
  #inFlight = 0;
  #lastSeen = 0;
  /** The route calls begin() when a save arrives and end() when it is answered. */
  begin(): void {
    this.#inFlight++;
    this.#lastSeen = Date.now();
  }
  end(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#lastSeen = Date.now();
  }
  /**
   * Resolves once no save is on its way and none arrived for quietMs (counted from the call at the earliest: a save the page sent
   * just before its window closed may still be on its way to this process), or after maxMs. True when it settled in time.
   */
  async settle(maxMs = 1500, quietMs = 250): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      const t = Date.now();
      if (this.#inFlight === 0 && t - Math.max(start, this.#lastSeen) >= quietMs) return true;
      if (t - start >= maxMs) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Apply {set: {key: string | null}, page?, seq?} key by key (a key an older batch of the same page brings is skipped): a key with a bad name or value, or one that would push the file past MAX_TOTAL,
   * is refused on its own and the others are still saved (one oversized value must never cost the open project and tabs).
   * Returns {changed, refused: [key]}. A malformed body is a ValueError; a file that cannot be read or written just now is a
   * ViewPrefsBusy (the route answers 503 and the page sends the same keys again a little later).
   */
  update(body: unknown): Promise<{ changed: boolean; refused: string[] }> {
    if (!isDict(body) || !isDict(body.set)) return Promise.reject(new ValueError('Invalid request'));
    const changes = entriesOf(body.set);
    if (changes.length > ViewPrefs.MAX_KEYS) return Promise.reject(new ValueError('Too many view preferences at once'));
    const page = typeof body.page === 'string' ? body.page.slice(0, 64) : '';
    const seq = typeof body.seq === 'number' && Number.isFinite(body.seq) ? body.seq : null;
    const refused: string[] = [];
    const valid: [string, string | null][] = [];
    for (const [key, value] of changes) {
      const last = this.#order.get(key);
      if (page && seq !== null && last && last.page === page && last.seq > seq) continue; // a newer batch of this page saved it
      const ok = ViewPrefs.key(key) && (value === null || (typeof value === 'string' && value.length <= ViewPrefs.MAX_VALUE));
      if (ok) valid.push([key, value as string | null]);
      else refused.push(String(key).slice(0, 120));
    }
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.prefs);
      const next = { ...this.prefs };
      // Removals first, then the new values smallest first, so the small ones (the workspace, a width) always fit.
      for (const [key, value] of valid) if (value === null) delete next[key];
      const sets = valid.filter(([, v]) => v !== null).sort((a, b) => (a[1] as string).length - (b[1] as string).length);
      for (const [key, value] of sets) {
        const had = next[key];
        next[key] = value as string;
        if (Object.keys(next).length > ViewPrefs.MAX_KEYS || ViewPrefs.#total(next) > ViewPrefs.MAX_TOTAL) {
          if (had === undefined) delete next[key];
          else next[key] = had;
          refused.push(key);
        }
      }
      if (page && seq !== null) {
        for (const [key] of valid) if (!refused.includes(key)) this.#order.set(key, { page, seq });
      }
      if (sameJson(next, before)) return { changed: false, refused };
      this.prefs = next;
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.prefs = before;
        this.warning = `AIB could not save view preferences: ${errorText(error)}`;
        throw new ViewPrefsBusy(this.warning);
      }
      this.warning = '';
      this.counter++;
      return { changed: true, refused };
    });
  }

  /** The chat display names (Rename): {provider:sessionId: name}, from the page's studio-conversation-names. */
  chatNames(): Record<string, string> {
    return chatNamesOf(this.public().prefs);
  }

  /**
   * Rename one chat from a phone (or clear its name with ''): the same studio-conversation-names value the PC page writes, changed
   * under this store's lock so a rename on the PC and one on the phone never overwrite each other's other names. The page reads it
   * again when the names' revision in /api/live/list changes (chat.js).
   */
  setChatName(key: string, name: string): Promise<boolean> {
    if (typeof key !== 'string' || !key || key.length > 600) return Promise.reject(new ValueError('Invalid chat'));
    // deno-lint-ignore no-control-regex -- control characters in a name become spaces
    const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return this.locked(() => {
      this.sync();
      const names = chatNamesOf(this.prefs);
      if ((names[key] ?? '') === clean) return false;
      if (clean) names[key] = clean;
      else delete names[key];
      const before = this.prefs;
      const next = { ...this.prefs, [CHAT_NAMES]: JSON.stringify(names) };
      if (next[CHAT_NAMES].length > ViewPrefs.MAX_VALUE || ViewPrefs.#total(next) > ViewPrefs.MAX_TOTAL) {
        throw new ValueError('Too many chat names are saved to add another one.');
      }
      this.prefs = next;
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.prefs = before;
        this.warning = `AIB could not save view preferences: ${errorText(error)}`;
        throw new ViewPrefsBusy(this.warning);
      }
      this.warning = '';
      this.counter++;
      return true;
    });
  }

  /** A short signature of the chat names (the page reads them again when it changes). */
  chatNamesRevision(): string {
    const text = this.public().prefs[CHAT_NAMES] ?? '';
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return `${text.length}.${h.toString(36)}`;
  }
}

/** The state file could not be read or written just now (another program has it open, a full disk): try again later. */
export class ViewPrefsBusy extends Error {
  override name = 'ViewPrefsBusy';
}
