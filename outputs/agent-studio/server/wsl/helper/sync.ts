/**
 * Live sync for the worktree per chat of WSL projects (docs/wsl/design.md section 4 phase 2, section 5 item 1): worktrees/sync.ts runs
 * whole here, natively in the distro, over the same `<data>` folder as the worktree registry and Merge (helper/worktrees.ts,
 * helper/merge.ts). A Windows watcher on a `\\wsl.localhost` path gets no change events, so the watching has to happen in the distro:
 * the LiveSync here is made with watchHere, which makes Deno.watchFs (inotify underneath) poke each project's scan; the 2 s poll goes on
 * next to it, exactly as on Windows. Nothing in sync.ts changes for this; its file rules, locks and records are the Windows ones.
 *
 * AIB tells the helper which WSL chats are open in their own copy (`sync.chats`, the whole set, sent in order per distro) and calls the
 * turn hooks with the chat's public state, as Studio calls them for a Windows chat: `sync.turnStarted`, `sync.contextFor`,
 * `sync.contextSent`, `sync.turnEnded`. There are no per-file calls: the scans, the copies, the 3-way merges and the lost-update guard
 * all run here. What live sync shows on Windows comes back the way it does there: the <studio-context> note for the chat's next prompt
 * (sync.contextFor), the clash line from the records (merge.status) and the storm pause line (merge.clashStatus; Resume is
 * `sync.resume`).
 *
 * The open chats are kept in `<data>/wsl-sync-chats.json`, so a helper that was restarted (it crashed, or a new AIB version replaced it)
 * watches the same projects again at its start and catches the chats up on what changed meanwhile, before AIB says anything; AIB's
 * next `sync.chats` corrects the set. The helper keeps syncing while AIB is away and its WSL agents keep running in the keeper.
 */
import * as osp from '../../platform/ospath.ts';
import * as wt from '../../worktrees/worktrees.ts';
import { LiveSync, Mutex, resumeSync, settings, type SyncConnection } from '../../worktrees/sync.ts';
import { isDict } from '../../core/py.ts';
import { entriesOf, readJsonFile, saveJson } from '../../state/json.ts';
import { pathOf } from '../../state/paths.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';

export const CHATS_FILE = 'wsl-sync-chats.json';
export const MAX_CHATS = 200;

/** One open WSL chat as live sync sees it: its worktree's Linux folder and the public state AIB sent last. */
export class HelperChat implements SyncConnection {
  closed = false;
  worktree = true;
  state: Record<string, unknown> = {};
  constructor(readonly id: string, readonly cwd: string) {}

  public(): unknown {
    return { ...this.state, cwd: this.cwd };
  }
}

export interface HelperSyncOptions {
  settle?: number;
  poll?: number;
  /** Use the folder watcher (inotify in the distro). Default true. */
  watch?: boolean;
}

function chatId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('\0')) throw new RpcError('chat must be a chat id', BAD_PARAMS);
  return value;
}

function absPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !osp.isabs(value)) {
    throw new RpcError(`${name} must be an absolute path`, BAD_PARAMS);
  }
  return osp.normpath(value);
}

/** The chat's public state as AIB sent it (its cwd must be the worktree's Linux path). */
function stateOf(params: Record<string, unknown>): Record<string, unknown> {
  if (!isDict(params.state)) throw new RpcError('state must be an object', BAD_PARAMS);
  return { ...params.state, cwd: absPath(params.state.cwd, 'state.cwd') };
}

/** The live sync of one helper: one LiveSync over `<data>`, its chats the WSL chats AIB has open in their own copy. */
export class HelperSync {
  readonly chats = new Map<string, HelperChat>();
  readonly live: LiveSync;
  readonly registry: wt.Registry;
  readonly #lock = new Mutex();

  constructor(readonly data: string, options: HelperSyncOptions = {}) {
    this.registry = new wt.Registry(data);
    const studio = {
      stateDir: data,
      worktrees: { registry: this.registry },
      settings: { worktreePerChat: () => true },
      connections: this.chats,
    };
    this.live = new LiveSync(studio, options.settle ?? settings.SETTLE, options.poll ?? settings.POLL, true, options.watch ?? true);
  }

  get file(): string {
    return pathOf(this.data, CHATS_FILE);
  }

  #save(): void {
    const chats: Record<string, unknown> = {};
    for (const [id, chat] of this.chats) chats[id] = { cwd: chat.cwd };
    try {
      saveJson(this.file, { version: 1, chats }, '.wsl-sync-');
    } catch (error) {
      console.error(`AIB-wsl-helper: could not save the live sync chats (${error instanceof Error ? error.message : error})`);
    }
  }

  /** The chats of the last run ([] when none were saved or the file is unreadable). */
  saved(): { chat: string; cwd: string }[] {
    const [status, raw] = readJsonFile(this.file);
    if (status !== 'ok' || !isDict(raw) || !isDict(raw.chats)) return [];
    const out: { chat: string; cwd: string }[] = [];
    for (const [id, value] of entriesOf(raw.chats)) {
      if (isDict(value) && typeof value.cwd === 'string' && osp.isabs(value.cwd) && id.length <= 200) out.push({ chat: id, cwd: value.cwd });
    }
    return out.slice(0, MAX_CHATS);
  }

  /**
   * The open chats are exactly `wanted` from now on: the new ones are watched and caught up on what the user saved meanwhile (in the
   * background, as Studio's chatOpened), the ones that went stop being synced. Returns the ids added and removed.
   */
  setChats(wanted: { chat: string; cwd: string }[]): Promise<{ chats: number; added: string[]; removed: string[] }> {
    return this.#lock.run(async () => {
      const next = new Map<string, string>();
      for (const item of wanted.slice(0, MAX_CHATS)) next.set(item.chat, osp.normpath(item.cwd));
      const removed: string[] = [], added: HelperChat[] = [];
      for (const [id, chat] of [...this.chats]) {
        if (next.get(id) === chat.cwd) continue;
        chat.closed = true;
        this.chats.delete(id);
        removed.push(id);
      }
      for (const [id, cwd] of next) {
        if (this.chats.has(id)) continue;
        const chat = new HelperChat(id, cwd);
        this.chats.set(id, chat);
        added.push(chat);
      }
      if (removed.length || added.length) this.#save();
      if (removed.length) await this.live.refresh(); // the last chat of a project went: its watcher stops
      for (const chat of added) await this.live.chatOpened(chat);
      return { chats: this.chats.size, added: added.map((c) => c.id).filter((id) => !removed.includes(id)), removed: removed.filter((id) => !next.has(id)) };
    });
  }

  /** The chat a turn hook names, added when this helper did not know it yet (it was restarted since AIB last told it). */
  async chat(params: Record<string, unknown>): Promise<HelperChat> {
    const id = chatId(params.chat);
    const state = stateOf(params);
    let chat = this.chats.get(id);
    if (!chat || chat.cwd !== state.cwd) {
      const others = [...this.chats.values()].filter((c) => c.id !== id).map((c) => ({ chat: c.id, cwd: c.cwd }));
      await this.setChats([...others, { chat: id, cwd: String(state.cwd) }]);
      chat = this.chats.get(id)!;
    }
    chat.state = state;
    return chat;
  }

  /** At the helper's start: the chats of the last run are watched again and caught up (only those whose worktree is still there). */
  async resumeSaved(): Promise<number> {
    const saved = this.saved().filter((c) => this.registry.find(c.cwd) !== null);
    if (!saved.length) {
      if (this.saved().length) this.#save(); // nothing left to watch: the stale list goes
      return 0;
    }
    return (await this.setChats(saved)).added.length;
  }

  /** What is watched (tests and diagnostics): the chats and, per project, whether its folder watcher runs and how many events it saw. */
  status(): Record<string, unknown> {
    return {
      chats: [...this.chats.values()].map((c) => ({ chat: c.id, cwd: c.cwd })),
      projects: [...this.live.projects.values()].map((p) => ({
        project: p.project,
        watching: !!p.notifier?.alive,
        events: p.notifier?.events ?? 0,
      })),
    };
  }

  /** Resume on the amber line (a storm paused the project): the flag goes, and the project's scan is poked to catch the chats up. */
  async resume(project: string): Promise<boolean> {
    const resumed = await resumeSync(this.data, project);
    for (const sync of this.live.projects.values()) if (wt.same(sync.project, project)) sync.poke('');
    return resumed;
  }
}

/** The `sync.*` helper methods over one HelperSync. */
export function syncMethods(sync: HelperSync): Handlers {
  return {
    /** The open WSL chats in their own copy: [{chat, cwd}] with cwd the worktree's Linux path. The whole set, every time. */
    'sync.chats': async (p) => {
      if (!Array.isArray(p.chats)) throw new RpcError('chats must be a list', BAD_PARAMS);
      if (p.chats.length > MAX_CHATS) throw new RpcError(`at most ${MAX_CHATS} chats`, BAD_PARAMS);
      const wanted = p.chats.map((item) => {
        if (!isDict(item)) throw new RpcError('chats must be a list of {chat, cwd}', BAD_PARAMS);
        return { chat: chatId(item.chat), cwd: absPath(item.cwd, 'cwd') };
      });
      return await sync.setChats(wanted);
    },

    /** A prompt is about to go to the chat's agent (Studio's onTurnStart). */
    'sync.turnStarted': async (p) => {
      await sync.live.turnStarted(await sync.chat(p));
      return { ok: true };
    },

    /** The agent finished a turn (Studio's turnEnded): the lost-update guard, then the files both sides changed. */
    'sync.turnEnded': async (p) => {
      await sync.live.turnEnded(await sync.chat(p));
      return { ok: true };
    },

    /** The <studio-context> note for the chat's next prompt or steer: [text, token], or null. */
    'sync.contextFor': async (p) => ({ context: sync.live.contextFor(await sync.chat(p)) }),

    /** The note went out with the prompt: it is not sent again. */
    'sync.contextSent': async (p) => {
      await sync.live.contextSent(await sync.chat(p), p.token);
      return { ok: true };
    },

    /** Resume on the amber line of a WSL project (its Linux path). */
    'sync.resume': async (p) => ({ resumed: await sync.resume(absPath(str(p, 'project'), 'project')) }),

    'sync.status': () => sync.status(),
  };
}
