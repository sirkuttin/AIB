/**
 * Swarm phase 1: the helper registry (<state>/swarm-helpers.json). A chat is a helper if and only if this file says so; every other
 * chat that works in its own worktree is a main chat (architect review 2026-11-13, option C). The web process writes it (swarm/service.ts);
 * AIB (in-process, the keeper or the split agent host) only reads it, to give a helper its role when it is opened again after a
 * restart, a keeper take-over or a Continue (review break 1).
 *
 * Records are keyed on lasting names, not live ids: `provider:sessionId` for the parent and the helper, and the helper's worktree path.
 * Live connection ids change across restarts; the service refreshes them from the chat list.
 */
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { isDict } from '../core/py.ts';
import { normcase, realpath } from '../platform/ospath.ts';

export const FILE = 'swarm-helpers.json';

/** `discarded`: its worktree and branch were removed without a merge (the chat was deleted, or a merge was undone after cleanup). */
export type HelperState = 'starting' | 'working' | 'waiting' | 'done' | 'merged' | 'stopped' | 'failed' | 'discarded';
/** States of a helper that is working now (stop_helper "all" stops these). */
export const RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting']);
/**
 * States that count toward the "helpers at once" cap and the owns clash: a helper that works, waits for an answer, or is done but
 * not merged yet (its files are still its own until the main agent merges or discards it). A read-only helper holds nothing.
 */
export const HOLDING_STATES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting', 'done']);

export interface Brief {
  goal: string;
  owns: string[];
  avoid: string[];
  done_when: string;
  reply_with: string;
  test_cmd: string;
  read_only: boolean;
  context_files: string[];
}

export interface Note {
  at: number;
  kind: string;
  text: string;
  actions?: string[];
  delivered: boolean;
}

export interface Report {
  n: number;
  at: number;
  text: string;
  delivered: boolean;
  how: '' | 'steer' | 'prompt' | 'queued';
}

export interface Helper {
  id: string;
  title: string;
  /** The repository root: caps are per project. */
  project: string;
  parent: { live: string; lasting: string };
  /** `label`: how a model-server entry reads ("Claude Code · strata"), kept so a later rename or removal of the server doesn't change the lines. */
  chat: { live: string; lasting: string; provider: string; model: string; mode: string; label?: string };
  brief: Brief;
  picked_by: 'rule' | 'main agent';
  rule: string;
  why: string;
  /** landOn (build plan 2.4): the folder branch a folder chat's helper lands on, from its worktree record; missing for a copy parent. */
  worktree: { path: string; branch: string; base: string; start: string; landOn?: string };
  /** The landing queue and its journal (build plan 2.2, SF 3); null or missing when nothing waits or runs. */
  landing?: Landing | null;
  state: HelperState;
  reason: string;
  createdAt: number;
  /** When it stopped or failed (seconds; build plan 1b 5.3 MF 5: its copy goes 7 days later when nothing is unmerged). */
  endedAt?: number;
  /** The helper's last turn end that has been reported (its attention.turnEndedAt), and the event cursor read up to. */
  turnEndedAt: string;
  cursor: number;
  reports: Report[];
  /**
   * When AIB ended this finished helper's chat, so its agent and every process under it stopped (service.ts #endHelper): the Activity
   * rows of its processes read "stopped: helper finished" from then on (stoppedWhyIn). `processes`: how many ran under it.
   */
  ended?: { at: number; why: string; processes: number };
  /** When its worktree and branch were removed (cleanup: after a merge, once its chat is closed). */
  cleanedAt?: number;
  /** The chat's name ("<title> (<agent>)") was written to the chat names once; an owner's rename or clear is never put back. */
  named?: boolean;
  merge: null | {
    tipBefore: string;
    landed: string;
    commits: number;
    at: number;
    /** The helper's branch tip right after the merge: cleanup removes its worktree and branch only while the branch is still there. */
    branchTip?: string;
    undo: null | { revert: string; at: number };
    again: null | { commit: string; at: number };
  };
  notes: Note[];
  /**
   * Subagent worktrees P2: this entry is a Claude subagent's work, not a helper chat (no chat of its own: `chat` is empty). It lands
   * through the same queue, journal, recovery, Undo and Merge again as a folder chat's helper (owner 2026-11-16).
   */
  kind?: 'subagent';
  sub?: SubagentLanding;
}

/** What the swarm knows of a subagent entry (AIB's subagent-worktrees.json record is the source; this side only reads it). */
export interface SubagentLanding {
  /** Its record id in subagent-worktrees.json (also this entry's id). */
  record: string;
  agentType: string;
  /** The parent's folder: where it lands (the project folder, or a helper's worktree). */
  folder: string;
  /** Made by the user's own WorktreeCreate hook: landed only, never removed. */
  userHook: boolean;
  /** The parent's turn end at the last refusal: a touched-dirty landing is tried again at the parent's next turn end (design 3.5). */
  turn: string;
  /** P3, Activity's line per subagent: its agentId (the adapter's child session id), files it landed, and "nothing to land". */
  agentId?: string;
  files?: number;
  empty?: boolean;
  /**
   * Scratch files (scratchFiles): new, uncommitted files with a page or note extension at the top of its worktree, left out of the
   * landing and kept in its worktree (it is not removed while they are there); the parent is told. merge_helper lands them too.
   */
  kept?: string[];
  /** When the kept files were left (seconds): its worktree goes KEPT_DAYS later unless the parent calls merge_helper first. */
  keptAt?: number;
  /** merge_helper asked for everything, scratch files included. */
  landScratch?: boolean;
}

/**
 * One queued or running landing of a helper (build plan 2.2): its merge, or the page's Undo / Merge again, waiting for the folder
 * chat to be idle. It is also the journal (SF 3): `stage` is written before git changes anything, so a landing found mid-stage at
 * start is finished (the branch already moved) or rolled back (put back in the queue; a copy parent's stash re-applied).
 */
export interface Landing {
  what: 'merge' | 'undo' | 'again';
  /** 'tool' (merge_helper) or 'page' (Undo, Merge again). */
  by: 'tool' | 'page';
  queuedAt: number;
  /** Refusals so far (busy, locked, moving): after 3 the chat gets one line. */
  tries: number;
  lastRefusal: string;
  /** 'touched-dirty': waits until merge_helper (or the button) is used again; '' otherwise. */
  waitsFor: string;
  stage: 'queued' | 'landing' | 'stashed' | 'built' | 'moved';
  lockId: string;
  stashSha: string;
  stashName: string;
  stashFolder: string;
  landed: string;
  tipBefore: string;
  toldTries: boolean;
  toldWait: boolean;
  /** The last refusal the parent was woken for (a key: code and files, or the busy reason and how long): the same one is not told twice. */
  told?: string;
  /** When a landing that waited for the user's files was last let go to try again. */
  retriedAt?: number;
}

interface Doc {
  version: 1;
  helpers: Record<string, Helper>;
}

const same = (a: string, b: string) => !!a && !!b && normcase(realpath(a)) === normcase(realpath(b));

/** The file read fresh (AIB side reads it this way; small, and read only when a chat opens). Never throws. */
export function readHelpers(stateDir: string): Record<string, Helper> {
  try {
    const file = pathOf(stateDir, FILE);
    // the file is 350 KB with the owner's ~90 helpers and every chat's stale check, hand-over and list asked for it: parsed again only
    // when its size or time changed. Callers only read what comes back.
    let sig = '';
    try {
      const info = Deno.statSync(file);
      sig = `${info.size}:${info.mtime?.getTime() ?? 0}`;
    } catch { /* missing: read as empty below */ }
    const kept = HELPERS_READ.get(file);
    if (sig && kept && kept.sig === sig && Date.now() - kept.at < 5000) return kept.helpers;
    const [status, raw] = readJsonFile(file);
    if (status !== 'ok' || !isDict(raw) || !isDict(raw.helpers)) return {};
    const helpers = raw.helpers as Record<string, Helper>;
    if (sig) HELPERS_READ.set(file, { sig, at: Date.now(), helpers });
    return helpers;
  } catch {
    return {};
  }
}

const HELPERS_READ = new Map<string, { sig: string; at: number; helpers: Record<string, Helper> }>();

/** The helper a chat is, by its live id, lasting name (provider:sessionId) or worktree folder; null for a non-helper chat. */
export function helperOf(
  helpers: Record<string, Helper>,
  chat: { live?: string | null; lasting?: string | null; path?: string | null },
): Helper | null {
  for (const h of Object.values(helpers)) {
    if (!isDict(h) || !isDict(h.chat)) continue;
    if (chat.live && h.chat.live === chat.live) return h;
    if (chat.lasting && h.chat.lasting === chat.lasting) return h;
    if (chat.path && h.worktree?.path && same(h.worktree.path, chat.path)) return h;
  }
  return null;
}

/**
 * Owner decision 2026-11-23: a helper's chat is left out of the chat lists (the PC's left list, the phone's, a paired PC's). It stays
 * reachable from its main chat's Activity row, search and a direct link, and is never archived or deleted. This is the ONE predicate: a
 * later rule that tucks a helper under its main chat (like Claude Code desktop) changes only this function. A subagent's landing entry
 * has no chat, so there is nothing to list. Every state counts: a helper that is done or merged stays out of the list too.
 */
export function hiddenFromLists(h: Helper | null | undefined): boolean {
  return !!h && isDict(h) && h.kind !== 'subagent' && isDict(h.chat);
}

/** The chats the lists leave out: their live ids and lasting names (`provider:sessionId`), from the registry file. */
export function hiddenChats(helpers: Record<string, Helper>): { live: Set<string>; lasting: Set<string> } {
  const live = new Set<string>(), lastingKeys = new Set<string>();
  for (const h of Object.values(helpers)) {
    if (!hiddenFromLists(h)) continue;
    if (h.chat.live) live.add(h.chat.live);
    if (h.chat.lasting) lastingKeys.add(h.chat.lasting);
  }
  return { live, lasting: lastingKeys };
}

/** One in-process lock: every write of the file goes through it (only the web process writes). */
class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/** One lock per registry file, so two Registry objects of the same state folder (the service's, project removal's) never race. */
const LOCKS = new Map<string, Mutex>();

export class Registry {
  readonly #lock: Mutex;
  constructor(readonly stateDir: string) {
    const key = normcase(pathOf(stateDir, FILE));
    let lock = LOCKS.get(key);
    if (!lock) LOCKS.set(key, lock = new Mutex());
    this.#lock = lock;
  }

  get path(): string {
    return pathOf(this.stateDir, FILE);
  }

  all(): Helper[] {
    return Object.values(readHelpers(this.stateDir));
  }

  get(id: string): Helper | null {
    return readHelpers(this.stateDir)[id] ?? null;
  }

  find(chat: { live?: string | null; lasting?: string | null; path?: string | null }): Helper | null {
    return helperOf(readHelpers(this.stateDir), chat);
  }

  /** Change one record (or add it); the whole file is written atomically. Returns the record as saved. */
  update(id: string, change: (h: Helper | null) => Helper | null): Promise<Helper | null> {
    return this.#lock.run(() => {
      const helpers = readHelpers(this.stateDir);
      const next = change(helpers[id] ? structuredClone(helpers[id]) : null);
      if (next === null) delete helpers[id];
      else helpers[id] = next;
      const doc: Doc = { version: 1, helpers };
      saveJson(this.path, doc, '.swarm-helpers-');
      return next;
    });
  }

  patch(id: string, fields: Partial<Helper>): Promise<Helper | null> {
    return this.update(id, (h) => (h ? { ...h, ...fields } : null));
  }

  /**
   * Project removal (build plan 1b, 5.4): the records of `project`'s helpers whose copy is gone (the cleanup removed it, or the folder
   * was deleted) and that do not run now (`live`: folders and provider:sessionId of the open chats). A helper whose copy was kept
   * (unmerged work the user chose to keep) keeps its record, so it is still a helper, with its Undo, when it is opened again.
   * Returns the ids dropped.
   */
  dropProject(project: string, live: Iterable<string> = []): Promise<string[]> {
    const running = [...live];
    const ofProject = (h: Helper) =>
      project.startsWith('wsl://') || String(h.project ?? '').startsWith('wsl://') ? h.project === project : same(String(h.project ?? ''), project);
    const runs = (h: Helper) =>
      (!!h.chat?.lasting && running.includes(h.chat.lasting)) || running.some((p) => !!h.worktree?.path && same(h.worktree.path, p));
    const copyThere = (h: Helper) => {
      const path = String(h.worktree?.path ?? '');
      if (!path || path.startsWith('wsl://')) return false;
      try {
        Deno.statSync(path);
        return true;
      } catch {
        return false;
      }
    };
    return this.#lock.run(() => {
      const helpers = readHelpers(this.stateDir);
      const dropped = Object.values(helpers).filter((h) => isDict(h) && ofProject(h) && !runs(h) && !copyThere(h)).map((h) => h.id);
      if (!dropped.length) return [];
      for (const id of dropped) delete helpers[id];
      saveJson(this.path, { version: 1, helpers } as Doc, '.swarm-helpers-');
      return dropped;
    });
  }
}

export function newHelperId(): string {
  return 'h_' + crypto.randomUUID().replaceAll('-', '').slice(0, 8);
}

/**
 * Why a saved chat's background commands stopped, by transcript key ("claude/<folder>/<sessionId>.jsonl"): "helper finished" when the
 * key is the chat of a helper AIB ended (Helper.ended), else ''. The Activity rows of such a chat turn grey (transcripts/monitor.ts).
 */
export function stoppedWhyIn(stateDir: string): (key: string) => string {
  return (key: string) => {
    for (const h of Object.values(readHelpers(stateDir))) {
      if (!h.ended || !h.chat.lasting) continue;
      const at = h.chat.lasting.indexOf(':');
      if (at < 1) continue;
      const provider = h.chat.lasting.slice(0, at).split('@')[0];
      const session = h.chat.lasting.slice(at + 1);
      if (session && key.startsWith(provider + '/') && key.includes(session)) return 'helper finished';
    }
    return '';
  };
}
