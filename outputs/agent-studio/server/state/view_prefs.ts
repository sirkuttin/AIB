/**
 * The page's view and appearance preferences (Deno only, no Python counterpart): sidebar mode and grouping, open and collapsed
 * groups, panel widths, text size, code font, spacing, chat views, chat display names and the like. The page keeps them in its
 * localStorage, which in the desktop app belongs to the WebView2 profile next to AIB.exe, so every new copy of the app started
 * at the defaults. Kept here, in the state folder, they follow the user's data instead.
 *
 * The page owns the meaning: this store keeps opaque strings under localStorage key names (view-prefs.js lists which keys).
 * The page reads them from chat.html (server.ts writes them into a JSON data block) and writes changes with
 * POST /api/live/view-prefs {set: {key: string | null}} (null removes the key).
 *
 *   studio-view.json: {"version": 1, "prefs": {key: string}}
 */
import { isDict, ValueError } from '../core/py.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson, VERSION } from './base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from './json.ts';

export class ViewPrefs extends JsonFileStore {
  static FILE = 'studio-view.json';
  static MAX_KEYS = 200;
  static MAX_VALUE = 256 * 1024; // characters, per key (the per-chat view choices and chat names are the big ones)
  static MAX_TOTAL = 1024 * 1024; // characters, all values together
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

  /** Apply {set: {key: string | null}}. The whole patch is refused when any key or value is invalid or the result is too big. */
  update(body: unknown): Promise<boolean> {
    if (!isDict(body) || !isDict(body.set)) return Promise.reject(new ValueError('Invalid request'));
    const changes = entriesOf(body.set);
    if (changes.length > ViewPrefs.MAX_KEYS) return Promise.reject(new ValueError('Too many view preferences at once'));
    for (const [key, value] of changes) {
      if (!ViewPrefs.key(key)) return Promise.reject(new ValueError('Invalid view preference name'));
      if (value !== null && (typeof value !== 'string' || value.length > ViewPrefs.MAX_VALUE)) {
        return Promise.reject(new ValueError('Invalid view preference value'));
      }
    }
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.prefs);
      const next = { ...this.prefs };
      for (const [key, value] of changes) {
        if (value === null) delete next[key];
        else next[key] = value as string;
      }
      if (Object.keys(next).length > ViewPrefs.MAX_KEYS || ViewPrefs.#total(next) > ViewPrefs.MAX_TOTAL) {
        throw new ValueError('View preferences are too big to save');
      }
      if (sameJson(next, before)) return false;
      this.prefs = next;
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.prefs = before;
        this.warning = `AIB could not save view preferences: ${errorText(error)}`;
        throw new ValueError(this.warning);
      }
      this.warning = '';
      this.counter++;
      return true;
    });
  }
}
