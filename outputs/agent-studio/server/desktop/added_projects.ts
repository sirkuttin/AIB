/**
 * The projects the user added to AIB (studio-added-projects.json in the data folder). A project exists in AIB only when the user
 * adds it: with New project, or by starting a chat in a folder through AIB (Studio.connect, so auto-reconnect, a keeper take-over
 * and agent-started chats count too). Every data folder starts with an empty list. Saved chats the agents keep on disk (Claude
 * Code's ~/.claude/projects, OMP's sessions, a session/list answer) are shown only when they belong to an added project; the rest
 * is never listed, and never changed or deleted on disk either.
 *
 * A chat in a git worktree belongs to its main checkout: a worktree folder counts as added when its main checkout is.
 *
 * Its own file, not studio-projects.json: older AIB builds rewrite that file with only the fields they know, and it only keeps
 * projects that carry a display preference. Its own format version (STORE_VERSION), not the version the other stores share.
 * The agents' history never fills the list:
 *   - every save also writes studio-added-projects.backup.json; an unreadable list (kept aside as *.corrupt) or a missing one
 *     is restored from the backup, else the list is empty.
 *   - a file written by a newer AIB (a higher version) is read as far as it can be and never overwritten; adding and removing
 *     are refused until AIB is updated.
 */
import { isDict, isStr, ValueError } from '../core/py.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson } from '../state/base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from '../state/json.ts';
import { projectKey } from './project_delete.ts';
import { worktreeParent } from './folders.ts';
import { isNetworkPath } from '../web/security.ts';

/** This file's own format version. */
export const STORE_VERSION = 1;

export interface Added {
  path: string;
  at: number;
}

/** path -> the main checkout of a git worktree folder, or null. Tests pass their own. */
export type ParentOf = (path: string) => string | null;
const defaultParentOf: ParentOf = (path) => worktreeParent(path)?.[0] ?? null;

/** How long a "not a worktree" answer is trusted (a folder can become a worktree later). */
export const NO_PARENT_TTL_MS = 60_000;

type Parsed = { ok: true; newer: boolean; added: Map<string, Added> } | { ok: false };

function parse(raw: unknown, max: number): Parsed {
  if (!isDict(raw) || typeof raw.version !== 'number' || raw.version < 1 || !isDict(raw.added)) return { ok: false };
  const added = new Map<string, Added>();
  for (const [key, item] of entriesOf(raw.added).slice(0, max)) {
    if (!isDict(item) || !isStr(item.path) || projectKey(item.path) !== key) continue;
    added.set(key, { path: item.path, at: typeof item.at === 'number' && item.at > 0 ? item.at : 0 });
  }
  return { ok: true, newer: raw.version > STORE_VERSION, added };
}

export class AddedProjects extends JsonFileStore {
  static FILE = 'studio-added-projects.json';
  static BACKUP = 'studio-added-projects.backup.json';
  static MAX = 2000;
  added = new Map<string, Added>();
  /** The list was written by a newer AIB: it is read, never written. */
  newer = false;
  #backupPath: string | null = null;
  #parents = new Map<string, { parent: string | null; at: number }>();
  readonly #parentOf: ParentOf;
  /** Tests move the clock of the "not a worktree" cache. */
  clock: () => number = () => Date.now();

  constructor(stateDir: string | null = null, options: { parentOf?: ParentOf } = {}) {
    super();
    this.#parentOf = options.parentOf ?? defaultParentOf;
    this.path = stateDir ? inDir(stateDir, AddedProjects.FILE) : null;
    this.#backupPath = stateDir ? inDir(stateDir, AddedProjects.BACKUP) : null;
    this.reload();
  }

  protected reload(): void {
    this.added = new Map();
    this.newer = false;
    if (this.path === null) return;
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === 'busy') {
      this.unreadableNow('The list of added projects could not be read just now; changes are paused.');
      return;
    }
    this.unreadable = false;
    const parsed = status === 'ok' ? parse(raw, AddedProjects.MAX) : { ok: false as const };
    if (!parsed.ok && status !== 'missing') {
      this.warning = 'The list of added projects was unreadable; AIB used its backup copy.';
      quarantine(this.path); // kept aside, never lost
      this.seen = this.stamp();
    }
    let use = parsed;
    if (!use.ok && this.#backupPath) {
      const [bStatus, bRaw] = readJsonFile(this.#backupPath);
      use = bStatus === 'ok' ? parse(bRaw, AddedProjects.MAX) : { ok: false };
    }
    if (use.ok) {
      this.added = use.added;
      this.newer = use.newer;
    }
  }

  public(): { revision: string; added: Record<string, Added>; newer: boolean } {
    this.sync();
    const added: Record<string, Added> = {};
    for (const [key, value] of this.added) {
      Object.defineProperty(added, key, { value: { ...value }, enumerable: true, writable: true, configurable: true });
    }
    return { revision: `${this.nonce}.${this.counter}`, added, newer: this.newer };
  }

  /** The main checkout of a worktree folder (cached: it reads the disk; a "none" answer only for a minute), or null. */
  parentOf(path: string): string | null {
    if (!isStr(path) || !path || isNetworkPath(path)) return null;
    const at = this.clock();
    const hit = this.#parents.get(path);
    if (hit && (hit.parent !== null || at - hit.at < NO_PARENT_TTL_MS)) return hit.parent;
    let found: string | null = null;
    try {
      found = this.#parentOf(path);
    } catch {
      found = null;
    }
    if (this.#parents.size >= 5000) this.#parents.clear();
    const parent = found && projectKey(found) && projectKey(found) !== projectKey(path) ? found : null;
    this.#parents.set(path, { parent, at });
    return parent;
  }

  /** The project a folder belongs to: the main checkout of a worktree, else the folder itself. */
  projectFolder(path: string): string {
    return this.parentOf(path) ?? path;
  }

  /** Is a chat in this folder (its projectRoot, else its cwd) shown? */
  shows(folder: unknown): boolean {
    this.sync();
    if (!isStr(folder) || !folder) return false;
    if (this.added.has(projectKey(folder))) return true;
    const parent = this.parentOf(folder);
    return parent !== null && this.added.has(projectKey(parent));
  }

  #change(work: (map: Map<string, Added>) => void): Promise<boolean> {
    return this.locked(() => {
      this.sync();
      if (this.newer) throw new ValueError('The project list was saved by a newer AIB; update AIB to change it');
      const before = deepCopy(this.added);
      work(this.added);
      while (this.added.size > AddedProjects.MAX) this.added.delete(this.added.keys().next().value!);
      if (sameJson(this.added, before)) return false;
      if (this.path !== null) {
        this.requireReadable();
        const payload = { version: STORE_VERSION, savedAt: now(), added: this.added };
        try {
          saveJson(this.path, payload, '.studio-added-projects-');
          saveJson(this.#backupPath!, payload, '.studio-added-projects-backup-');
        } catch (error) {
          if (!isOSError(error)) throw error;
          this.added = before;
          throw new ValueError(`AIB could not save the project list: ${errorText(error)}`);
        }
        this.seen = this.stamp();
      }
      this.counter++;
      return true;
    });
  }

  /** Add projects (New project, a chat opened in its folder, a chat restored from Recently deleted). Worktrees add their main
   * checkout. Returns true when the list changed. */
  add(...paths: unknown[]): Promise<boolean> {
    const fresh = paths.filter((p): p is string => isStr(p) && !!p.trim() && p.length <= 1024)
      .map((p) => this.projectFolder(p.trim()))
      .filter((p) => projectKey(p));
    this.sync();
    if (!fresh.length || fresh.every((p) => this.added.has(projectKey(p)))) return Promise.resolve(false);
    return this.#change((map) => {
      for (const path of fresh) if (!map.has(projectKey(path))) map.set(projectKey(path), { path, at: now() });
    });
  }

  /** A chat the agent host opened: its folder becomes a project. Never throws (a newer AIB's list is left alone). */
  async addOpened(path: unknown): Promise<boolean> {
    try {
      return await this.add(path);
    } catch {
      return false;
    }
  }

  /** "Delete project…": the project leaves the list, so its saved chats do not bring it back. A folder the list files under
   * another one (a worktree of an added main checkout) takes that one off. */
  remove(path: unknown): Promise<boolean> {
    const key = projectKey(path);
    if (!key) return Promise.reject(new ValueError('Choose a project folder'));
    this.sync();
    const target = this.added.has(key) ? key : isStr(path) ? projectKey(this.projectFolder(path)) : '';
    if (!target || !this.added.has(target)) return Promise.resolve(false);
    return this.#change((map) => {
      map.delete(target);
    });
  }
}
