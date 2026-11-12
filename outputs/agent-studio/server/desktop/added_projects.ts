/**
 * The projects the user added to AIB (studio-added-projects.json in the data folder). A project exists in AIB only when the user
 * adds it: with New project, or by starting a chat in a folder through AIB. Saved chats the agents keep on disk (Claude Code's
 * ~/.claude/projects, OMP's sessions, a session/list answer) are shown only when they belong to an added project; the rest is
 * never listed, and never changed or deleted on disk either.
 *
 * A chat in a git worktree belongs to its main checkout: a worktree folder counts as added when its main checkout is.
 *
 * Its own file, not studio-projects.json: older AIB builds rewrite that file with only the fields they know (the list would be
 * lost on a downgrade), and it only keeps projects that carry a display preference.
 *
 * First start of this version (the file does not exist yet), decided once when the store is made, before anything else writes:
 *   - fresh data folder (none of HISTORY_FILES exists): the list starts empty ('fresh').
 *   - existing user (any of HISTORY_FILES exists): every project the page would have listed becomes added ('existing'), at the
 *     first list (migrate()), so nothing disappears. Until that has run, nothing is filtered.
 * Once the file exists the decision is never made again.
 */
import { isDict, isStr, ValueError } from "../core/py.ts";
import {
  deepCopy,
  errorText,
  inDir,
  isOSError,
  JsonFileStore,
  sameJson,
  VERSION,
} from "../state/base.ts";
import {
  entriesOf,
  now,
  quarantine,
  readJsonFile,
  saveJson,
} from "../state/json.ts";
import { projectKey } from "./project_delete.ts";
import { worktreeParent } from "./folders.ts";

/** Files only a used AIB writes (a chat opened, read, organized, a project named or removed, a folder or worktree used). */
export const HISTORY_FILES: readonly string[] = [
  "studio-conversations.json",
  "studio-projects.json",
  "studio-removed-projects.json",
  "studio-read-state.json",
  "studio-folders.json",
  "studio-worktrees.json",
];

export interface Added {
  path: string;
  at: number;
}

export type Start = "fresh" | "existing";

/** path -> the main checkout of a git worktree folder, or null. Tests pass their own. */
export type ParentOf = (path: string) => string | null;
/** A Claude Code worktree folder (<repo>/.claude/worktrees/<name>) names its repository even after the folder is gone. */
const CLAUDE_WORKTREE =
  /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/i;
const defaultParentOf: ParentOf = (path) =>
  worktreeParent(path)?.[0] ?? path.match(CLAUDE_WORKTREE)?.[1] ?? null;

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

export class AddedProjects extends JsonFileStore {
  static FILE = "studio-added-projects.json";
  static MAX = 2000;
  added = new Map<string, Added>();
  /** How this data folder started ('' until the file exists). */
  start: Start | "" = "";
  /** True while an existing user's list has not been made yet: nothing is filtered until migrate() ran. */
  needsMigration = false;
  #exists = false;
  #migration: Promise<void> | null = null;
  #parents = new Map<string, string | null>();
  readonly #parentOf: ParentOf;
  /** The folders of the projects the page listed before this version (server.ts sets it): an existing user's first list. */
  collect: () => Promise<unknown[]> = () => Promise.resolve([]);

  constructor(
    stateDir: string | null = null,
    options: { parentOf?: ParentOf } = {},
  ) {
    super();
    this.#parentOf = options.parentOf ?? defaultParentOf;
    this.path = stateDir ? inDir(stateDir, AddedProjects.FILE) : null;
    this.reload();
    if (this.path !== null && !this.#exists && !this.unreadable) {
      this.needsMigration = HISTORY_FILES.some((name) =>
        isFile(inDir(stateDir!, name))
      );
    }
  }

  protected reload(): void {
    this.added = new Map();
    this.#exists = false;
    if (this.path === null) return;
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === "busy") {
      this.unreadableNow(
        "The list of added projects could not be read just now; changes are paused.",
      );
      return;
    }
    this.unreadable = false;
    if (status === "missing") return;
    if (status === "corrupt") {
      this.warning =
        "The list of added projects was unreadable and was ignored.";
      quarantine(this.path);
      this.seen = this.stamp();
      return;
    }
    if (!isDict(raw) || raw.version !== VERSION || !isDict(raw.added)) return;
    this.#exists = true;
    this.needsMigration = false;
    this.start = raw.start === "existing" ? "existing" : "fresh";
    for (
      const [key, item] of entriesOf(raw.added).slice(0, AddedProjects.MAX)
    ) {
      if (
        !isDict(item) || !isStr(item.path) || projectKey(item.path) !== key
      ) continue;
      this.added.set(key, {
        path: item.path,
        at: typeof item.at === "number" && item.at > 0 ? item.at : 0,
      });
    }
  }

  public(): {
    revision: string;
    added: Record<string, Added>;
    start: Start | "";
  } {
    this.sync();
    const added: Record<string, Added> = {};
    for (const [key, value] of this.added) {
      Object.defineProperty(added, key, {
        value: { ...value },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return {
      revision: `${this.nonce}.${this.counter}`,
      added,
      start: this.start,
    };
  }

  /** The main checkout of a worktree folder (cached: it reads the disk), or null. */
  parentOf(path: string): string | null {
    if (!isStr(path) || !path) return null;
    if (!this.#parents.has(path)) {
      let found: string | null = null;
      try {
        found = this.#parentOf(path);
      } catch {
        found = null;
      }
      if (this.#parents.size >= 5000) this.#parents.clear();
      this.#parents.set(
        path,
        found && projectKey(found) && projectKey(found) !== projectKey(path)
          ? found
          : null,
      );
    }
    return this.#parents.get(path) ?? null;
  }

  /** The project a folder belongs to: the main checkout of a worktree, else the folder itself. */
  projectFolder(path: string): string {
    return this.parentOf(path) ?? path;
  }

  /** Is a chat in this folder (its projectRoot, else its cwd) shown? Always true until an existing user's list was made. */
  shows(folder: unknown): boolean {
    this.sync();
    if (!this.#exists) return true;
    if (!isStr(folder) || !folder) return false;
    if (this.added.has(projectKey(folder))) return true;
    const parent = this.parentOf(folder);
    return parent !== null && this.added.has(projectKey(parent));
  }

  #change(
    work: (map: Map<string, Added>) => void,
    start: Start = "fresh",
  ): Promise<boolean> {
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.added);
      work(this.added);
      while (this.added.size > AddedProjects.MAX) {
        this.added.delete(this.added.keys().next().value!);
      }
      const first = !this.#exists;
      if (!first && sameJson(this.added, before)) return false;
      if (this.path !== null) {
        this.requireReadable();
        try {
          saveJson(
            this.path,
            {
              version: VERSION,
              savedAt: now(),
              start: this.start || start,
              added: this.added,
            },
            ".studio-added-projects-",
          );
        } catch (error) {
          if (!isOSError(error)) throw error;
          this.added = before;
          throw new ValueError(
            `AIB could not save the project list: ${errorText(error)}`,
          );
        }
        this.seen = this.stamp();
        this.#exists = true;
        if (!this.start) this.start = start;
      } else this.#exists = true;
      this.counter++;
      return true;
    });
  }

  /**
   * Make the list on the first start of this version, once. An existing user's list is every folder `collect` names (the projects
   * the page showed before), mapped to their main checkout; a fresh data folder's list is empty. When `collect` fails, nothing is
   * written and nothing is filtered, and the next call tries again.
   */
  ready(collect: () => Promise<unknown[]> = this.collect): Promise<void> {
    this.sync();
    if (this.#exists || this.path === null) return Promise.resolve();
    if (this.#migration) return this.#migration;
    const run = (async () => {
      if (!this.needsMigration) {
        await this.#change(() => {}, "fresh");
        return;
      }
      const folders = await collect();
      await this.#change((map) => {
        if (this.#exists) return; // another AIB on this data folder made it meanwhile (#change synced first)
        for (const raw of folders) {
          if (!isStr(raw) || !raw.trim()) continue;
          const path = this.projectFolder(raw.trim());
          const key = projectKey(path);
          if (key && !map.has(key)) map.set(key, { path, at: now() });
        }
      }, "existing");
      this.needsMigration = false;
    })();
    this.#migration = run;
    run.catch(() => {}).finally(() => {
      if (this.#migration === run) this.#migration = null;
    });
    return run;
  }

  /** Add a project (New project, a chat started in its folder, a chat restored from Recently deleted). Worktrees add their main
   * checkout. Returns true when the list changed. */
  async add(...paths: unknown[]): Promise<boolean> {
    await this.ready();
    const folders = paths.filter((p): p is string =>
      isStr(p) && !!p.trim() && p.length <= 1024
    ).map((p) => this.projectFolder(p.trim()));
    const fresh = folders.filter((p) => projectKey(p));
    if (!fresh.length) return false;
    this.sync();
    if (fresh.every((p) => this.added.has(projectKey(p)))) return false;
    return await this.#change((map) => {
      for (const path of fresh) {
        if (!map.has(projectKey(path))) {
          map.set(projectKey(path), { path, at: now() });
        }
      }
    });
  }

  /** "Delete project…": the project leaves the list, so its saved chats do not bring it back. */
  async remove(path: unknown): Promise<boolean> {
    const key = projectKey(path);
    if (!key) throw new ValueError("Choose a project folder");
    await this.ready();
    this.sync();
    if (!this.added.has(key)) return false;
    return await this.#change((map) => {
      map.delete(key);
    });
  }
}
