/**
 * Rail preferences per project (state_store.ProjectPrefs): display name, colour, hidden / muted / useWorkspace flags and the
 * order of the rail.
 *
 * One small JSON file shared by every browser and every Studio on the state folder. Projects are identified by the page's own
 * project key (a normalised folder path). A display name never renames a folder. Only projects that carry a preference are
 * stored, and every string is validated and size limited.
 */
import { clip, isDict, isStr, pyLen, pySplit, ValueError } from '../core/py.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson, VERSION } from './base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from './json.ts';

export interface ProjectPref {
  name: string;
  color: string;
  hidden: boolean;
  muted?: true;
  useWorkspace?: true;
}

export interface ProjectUpdate {
  set?: unknown;
  order?: unknown;
}

function hasControl(value: string): boolean {
  for (const ch of value) if (ch.codePointAt(0)! < 32) return true;
  return false;
}

export class ProjectPrefs extends JsonFileStore {
  static FILE = 'studio-projects.json';
  static MAX_PROJECTS = 300;
  static MAX_KEY = 512;
  static MAX_NAME = 60;
  static COLORS: readonly string[] = ['blue', 'sky', 'teal', 'indigo', 'violet', 'orchid', 'pink', 'slate']; // keep in sync with workspace-state.js

  /** key -> preference (a Map: any key, kept in file order). */
  projects = new Map<string, ProjectPref>();
  /** project keys, rail order */
  order: string[] = [];

  constructor(stateDir: string | null = null) {
    super();
    this.path = stateDir ? inDir(stateDir, (this.constructor as typeof ProjectPrefs).FILE) : null;
    this.reload();
  }

  #cls(): typeof ProjectPrefs {
    return this.constructor as typeof ProjectPrefs;
  }

  /** A valid project key, or null. */
  static key(value: unknown): string | null {
    if (!isStr(value) || !value || pyLen(value) > this.MAX_KEY || hasControl(value)) return null;
    return value;
  }

  static cleanName(value: unknown): string {
    if (!isStr(value)) return '';
    let out = '';
    for (const ch of value) out += ch.codePointAt(0)! >= 32 ? ch : ' ';
    return clip(pySplit(out).join(' '), this.MAX_NAME);
  }

  static cleanPref(item: unknown): ProjectPref | null {
    if (!isDict(item)) return null;
    const color = isStr(item.color) && this.COLORS.includes(item.color) ? item.color : '';
    const pref: ProjectPref = { name: this.cleanName(item.name), color, hidden: item.hidden === true };
    if (item.muted === true) pref.muted = true; // only stored when set, so older readers and files see the same three fields
    if (item.useWorkspace === true) pref.useWorkspace = true; // "Always open this project's .code-workspace", stored only when set
    return pref.name || pref.color || pref.hidden || pref.muted || pref.useWorkspace ? pref : null;
  }

  static cleanOrder(value: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of Array.isArray(value) ? value : []) {
      const key = this.key(item);
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
      if (out.length >= this.MAX_PROJECTS) break;
    }
    return out;
  }

  protected reload(): void {
    if (this.path === null) {
      this.projects = new Map();
      this.order = [];
      return;
    }
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === 'busy') {
      this.unreadableNow('Saved project preferences could not be read just now; changes are paused.');
      return;
    }
    this.unreadable = false;
    this.projects = new Map();
    this.order = [];
    if (status === 'missing') return;
    if (status === 'corrupt') {
      this.warning = 'Saved project preferences were unreadable and were ignored.';
      quarantine(this.path);
      this.seen = this.stamp();
      return;
    }
    if (!isDict(raw) || raw.version !== VERSION || !isDict(raw.projects)) {
      this.warning = 'Saved project preferences have an unknown format and were ignored.';
      return;
    }
    this.warning = '';
    const cls = this.#cls();
    for (const [key, item] of entriesOf(raw.projects).slice(0, cls.MAX_PROJECTS)) {
      const pref = cls.key(key) ? cls.cleanPref(item) : null;
      if (pref) this.projects.set(key, pref);
    }
    this.order = cls.cleanOrder(raw.order);
  }

  public(): { revision: string; order: string[]; projects: Record<string, ProjectPref>; warning: string } {
    this.sync();
    const projects: Record<string, ProjectPref> = {};
    for (const [key, value] of this.projects) {
      Object.defineProperty(projects, key, { value: { ...value }, enumerable: true, writable: true, configurable: true });
    }
    return { revision: `${this.nonce}.${this.counter}`, order: [...this.order], projects, warning: this.warning };
  }

  #save(): void {
    if (this.path === null) return;
    this.requireReadable();
    saveJson(this.path, { version: VERSION, savedAt: now(), order: this.order, projects: this.projects }, '.studio-projects-');
    this.seen = this.stamp();
  }

  /**
   * Apply {set: {key: {name?, color?, hidden?, muted?, useWorkspace?}}, order: [keys]}; fields not mentioned are kept.
   * An empty name / colour or hidden/muted=false clears that field.
   */
  update(body: unknown): Promise<void> {
    if (!isDict(body)) return Promise.reject(new ValueError('Invalid request'));
    const changes = body.set ?? null;
    const order = body.order ?? null;
    if (changes !== null && !isDict(changes)) return Promise.reject(new ValueError('Invalid project changes'));
    if (order !== null && !Array.isArray(order)) return Promise.reject(new ValueError('Invalid project order'));
    if (changes !== null && Object.keys(changes).length > 50) return Promise.reject(new ValueError('Too many project changes at once'));
    const cls = this.#cls();
    return this.locked(() => {
      this.sync();
      const beforeProjects = deepCopy(this.projects);
      const beforeOrder = [...this.order];
      try {
        for (const [key, patch] of entriesOf(changes ?? {})) {
          if (cls.key(key) === null || !isDict(patch)) throw new ValueError('Invalid project');
          const current: Record<string, unknown> = { ...(this.projects.get(key) ?? { name: '', color: '', hidden: false }) };
          if ('name' in patch) {
            if (!isStr(patch.name)) throw new ValueError('Invalid project name');
            current.name = cls.cleanName(patch.name);
          }
          if ('color' in patch) {
            if (!(isStr(patch.color) && (patch.color === '' || cls.COLORS.includes(patch.color)))) {
              throw new ValueError('Unknown project colour');
            }
            current.color = patch.color;
          }
          if ('hidden' in patch) {
            if (typeof patch.hidden !== 'boolean') throw new ValueError('Invalid hidden flag');
            current.hidden = patch.hidden;
          }
          if ('muted' in patch) {
            if (typeof patch.muted !== 'boolean') throw new ValueError('Invalid muted flag');
            current.muted = patch.muted;
          }
          if ('useWorkspace' in patch) {
            if (typeof patch.useWorkspace !== 'boolean') throw new ValueError('Invalid workspace flag');
            current.useWorkspace = patch.useWorkspace;
          }
          const cleaned = cls.cleanPref(current);
          if (cleaned) this.projects.set(key, cleaned);
          else this.projects.delete(key);
        }
        if (order !== null) this.order = cls.cleanOrder(order);
        if (this.projects.size > cls.MAX_PROJECTS) throw new ValueError('Too many projects with saved preferences');
      } catch (error) {
        this.projects = beforeProjects;
        this.order = beforeOrder;
        throw error;
      }
      if (sameJson(this.projects, beforeProjects) && sameJson(this.order, beforeOrder)) return;
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.projects = beforeProjects;
        this.order = beforeOrder;
        this.warning = `AIB could not save project preferences: ${errorText(error)}`;
        throw new ValueError(this.warning);
      }
      this.warning = '';
      this.counter++;
    });
  }
}
