/**
 * Build plan 1b, 2.3: an Own-copy chat's merge waits behind the chats that work in the project folder. merge_into_project, called
 * while one of them works, is queued instead of refused: it runs when the copy chat's turn has ended and every folder chat is idle
 * (Merge itself then holds their landing lock, merge.ts holdFolderChats), as a folder chat's helper landing waits for its parent
 * (swarm/service.ts). The queue is also the journal (SF 3): each stage is written before git changes anything, so a merge cut off by a
 * stop is finished (its branch already moved) or put back in the queue at the next start, with a stash it made put back.
 *
 * One entry per copy chat in <state dir>/copy-merge-queue.json; only the web process writes it. The swarm watcher runs `poll()`.
 */
import * as merge from './merge.ts';
import * as wt from './worktrees.ts';
import { pathOf } from '../state/paths.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import { isDict, pyStr, pyStrip } from '../core/py.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('merge_queue');

export const QUEUE_FILE = merge.COPY_MERGE_QUEUE_FILE;
/** As the helper queue (swarm/service.ts): one line after this many refusals, another after this long queued. */
export const TRIES_NOTE = 3;
export const WAIT_NOTE_S = 600;
/** Refusals a later try may not meet (the expected waits, folder_busy and busy, are tried again silently). */
const RETRY_CODES = new Set(['locked', 'moving', 'ff_failed', 'running', 'stash_failed', 'failed']);
const WAITS = new Set(['folder_busy', 'busy']);

type Json = Record<string, unknown>;

export interface QueuedMerge {
  chat: string; // the live id when queued (found again by `lasting` after a restart)
  lasting: string; // provider:sessionId
  title: string;
  base: string;
  queuedAt: number; // seconds
  stage: 'queued' | 'landing' | 'stashed' | 'built' | 'moved';
  waitsFor: string; // the folder chat it waits for, as last seen
  tries: number;
  lastRefusal: string;
  toldWait: boolean;
  toldTries: boolean;
  stashSha: string;
  stashName: string;
  stashFolder: string;
  landed: string;
  tipBefore: string;
}

export interface QueueHost {
  liveList(): Promise<unknown>;
  liveState(id: unknown, after?: unknown): unknown;
  liveCall(name: string, body: unknown): Promise<[number, unknown]> | [number, unknown];
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Json => (isDict(v) ? v : {});
const lastingOf = (c: Json) => (s(c.provider) && s(c.sessionId) ? `${s(c.provider)}:${s(c.sessionId)}` : '');
const lower = (t: string) => (t ? t[0].toLowerCase() + t.slice(1) : t).replace(/[.\s]+$/, '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- the file ------------------------------------------------------------------------------------------------------
function fileOf(stateDir: string): string {
  return pathOf(stateDir, QUEUE_FILE);
}

/** Every queued merge, by the copy chat's worktree key. */
export function readQueue(stateDir: string): Map<string, QueuedMerge> {
  const [status, raw] = readJsonFile(fileOf(stateDir));
  const out = new Map<string, QueuedMerge>();
  if (status !== 'ok' || !isDict(raw)) return out;
  for (const [key, value] of Object.entries(raw)) if (isDict(value)) out.set(key, value as unknown as QueuedMerge);
  return out;
}

let writes: Promise<unknown> = Promise.resolve();
/** One read-modify-write at a time (in this process: only the web process writes the queue). */
function change(stateDir: string, fn: (items: Map<string, QueuedMerge>) => void): Promise<void> {
  const run = writes.then(() => {
    const items = readQueue(stateDir);
    fn(items);
    saveJson(fileOf(stateDir), Object.fromEntries(items), '.studio-merge-queue-');
  });
  writes = run.catch(() => {});
  return run;
}

function patch(stateDir: string, key: string, fields: Partial<QueuedMerge>): Promise<void> {
  return change(stateDir, (items) => {
    const cur = items.get(key);
    if (cur) items.set(key, { ...cur, ...fields });
  });
}

function drop(stateDir: string, key: string): Promise<void> {
  return change(stateDir, (items) => void items.delete(key));
}

/** The queued merge of a chat (by live id or lasting name), or null. */
export function queuedFor(stateDir: string, chatId: string, lasting = ''): [string, QueuedMerge] | null {
  for (const [key, item] of readQueue(stateDir)) {
    if (item.chat === chatId || (lasting && item.lasting === lasting)) return [key, item];
  }
  return null;
}

export function queuedLine(base: string, busy: string): string {
  return `Your work merges into ${base} when “${busy || 'the chat in the project folder'}” pauses (it works in the project folder). ` +
    'Finish your turn; the result is in your next message.';
}

// ---- the tool ------------------------------------------------------------------------------------------------------
/**
 * merge_into_project for a copy chat: as merge.mergeFromTool, but while a chat that works in the project folder is busy the merge is
 * queued ({state: 'queued', message}) instead of refused, and the watcher runs it once that chat and this one are idle.
 */
export async function mergeFromToolQueued(aib: merge.MergeHost, chatId: unknown): Promise<merge.MergeResult> {
  const id = typeof chatId === 'string' ? chatId : '';
  const state = id ? obj(await Promise.resolve(aib.liveState(id)).catch(() => null)) : {};
  const lasting = lastingOf(state);
  const already = id ? queuedFor(aib.stateDir, id, lasting) : null;
  if (already) {
    const [, item] = already;
    return { ok: true, state: 'queued', message: queuedLine(item.base, item.waitsFor), target: item.base };
  }
  try {
    return await merge.mergeFromTool(aib, chatId);
  } catch (error) {
    if (!(error instanceof merge.Refused) || error.code !== 'folder_busy') throw error;
    const record = wt.recordForPath(aib.stateDir, state.cwd);
    const key = record?.key;
    if (!key) throw error;
    const base = s(error.extra.target) || 'main';
    const busy = s(error.extra.busy);
    const title = pyStrip(pyStr(state.title || ''));
    await change(aib.stateDir, (items) => {
      items.set(key, newEntry(id, lasting, title, base, busy));
    });
    try {
      await aib.liveCall(merge.NOTE_OP, { id, message: `Merge into ${base} waits for “${busy || 'the chat in the project folder'}” to pause.` });
    } catch (e) {
      log.exception(e, 'Could not post the queued-merge line');
    }
    return { ok: true, state: 'queued', message: queuedLine(base, busy), target: base, started: error.extra.started };
  }
}

function newEntry(chat: string, lasting: string, title: string, base: string, busy: string): QueuedMerge {
  return {
    chat,
    lasting,
    title,
    base,
    queuedAt: Date.now() / 1000,
    stage: 'queued',
    waitsFor: busy,
    tries: 0,
    lastRefusal: '',
    toldWait: false,
    toldTries: false,
    stashSha: '',
    stashName: '',
    stashFolder: '',
    landed: '',
    tipBefore: '',
  };
}

// ---- the watcher ---------------------------------------------------------------------------------------------------
/** Runs the queued merges (from the swarm watcher, every 2 s). */
export class CopyMergeQueue {
  readonly #running = new Set<string>();
  #busy: Promise<void> | null = null;

  constructor(readonly stateDir: string, readonly host: QueueHost, readonly clock: () => number = () => Date.now()) {}

  #aib(): merge.MergeHost {
    return merge.liveMergeAib(this.stateDir, {
      liveState: (id, after) => this.host.liveState(id, after),
      liveCall: async (name, body) => await this.host.liveCall(name, body),
    });
  }

  poll(): Promise<void> {
    if (this.#busy) return this.#busy;
    const run = this.#poll().catch((error) =>
      log.info('Could not look at the queued merges (%s)', error instanceof Error ? error.message : error)
    ).finally(() => (this.#busy = null));
    this.#busy = run;
    return run;
  }

  async #poll(): Promise<void> {
    const items = readQueue(this.stateDir);
    if (!items.size) return;
    const listing = obj(await this.host.liveList());
    if (listing.instanceId === 'host-unavailable') return;
    const chats = (Array.isArray(listing.connections) ? listing.connections : []).map(obj).filter((c) => !c.closed);
    for (const [key, item0] of items) {
      if (this.#running.has(key)) continue;
      let item = item0;
      const chat = (item.lasting ? chats.find((c) => lastingOf(c) === item.lasting) : undefined) ?? chats.find((c) => s(c.id) === item.chat);
      const live = chat ? s(chat.id) : '';
      if (live && live !== item.chat) {
        await patch(this.stateDir, key, { chat: live });
        item = { ...item, chat: live };
      }
      if (item.stage !== 'queued') {
        await this.#recover(key, item);
        item = readQueue(this.stateDir).get(key) ?? item;
        if (item.stage !== 'queued') continue;
      }
      if (!live) continue; // closed: it waits until the chat is open again
      if (!item.toldWait && this.clock() / 1000 - item.queuedAt > WAIT_NOTE_S) {
        await patch(this.stateDir, key, { toldWait: true });
        await this.#note(live, `Still waiting for the chats in the project folder to pause to merge this chat into ${item.base}.`);
      }
      await this.#run(key, item, live);
    }
  }

  async #note(id: string, message: string): Promise<void> {
    try {
      await this.host.liveCall(merge.NOTE_OP, { id, message });
    } catch (error) {
      log.exception(error, 'Could not post a queued-merge line');
    }
  }

  async #context(id: string, line: string): Promise<void> {
    await Promise.resolve(this.host.liveCall('prompt-context', { id, line })).catch(() => {});
  }

  /** One try: the merge, as the Merge button's (the chat must be idle), with the journal; then what it did, told. */
  async #run(key: string, item: QueuedMerge, live: string): Promise<void> {
    this.#running.add(key);
    let out: merge.MergeResult;
    try {
      await patch(this.stateDir, key, { stage: 'landing' });
      out = await merge.merge(this.#aib(), live, item.title, false, {
        journal: (stage, data) =>
          patch(this.stateDir, key, {
            stage: stage as QueuedMerge['stage'],
            ...(typeof data.stashSha === 'string' ? { stashSha: data.stashSha, stashName: s(data.stashName), stashFolder: s(data.folder) } : {}),
            ...(typeof data.landed === 'string' ? { landed: data.landed, tipBefore: s(data.tipBefore) } : {}),
          }),
      });
    } catch (error) {
      out = error instanceof merge.Refused
        ? { state: 'refused', code: error.code, message: error.message, busy: s(error.extra.busy) }
        : { state: 'refused', code: 'failed', message: error instanceof Error ? error.message : String(error) };
      if (!(error instanceof merge.Refused)) log.exception(error, 'A queued merge failed');
    } finally {
      this.#running.delete(key);
    }
    await this.#after(key, item, live, out);
  }

  async #after(key: string, item: QueuedMerge, live: string, out: merge.MergeResult): Promise<void> {
    const state = s(out.state), code = s(out.code);
    const reset = { stage: 'queued' as const, stashSha: '', stashName: '', stashFolder: '', landed: '', tipBefore: '' };
    if (state === 'merged') {
      await drop(this.stateDir, key); // merge.ts posted "Merged into <base> (n commits)" in the chat
      const commits = Number(out.commits) || 0;
      await this.#context(live, `While you were idle, your queued merge landed in ${s(out.base) || item.base} (${plural(commits, 'commit')}).`);
      return;
    }
    if (state === 'conflicts') { // the chat was asked to resolve them (merge.ts): a new merge_into_project goes from there
      await drop(this.stateDir, key);
      return;
    }
    if (WAITS.has(code)) {
      await patch(this.stateDir, key, { ...reset, ...(s(out.busy) ? { waitsFor: s(out.busy) } : {}) });
      return;
    }
    if (RETRY_CODES.has(code)) {
      const tries = item.tries + 1;
      const tell = tries >= TRIES_NOTE && !item.toldTries;
      await patch(this.stateDir, key, { ...reset, tries, lastRefusal: s(out.message), ...(tell ? { toldTries: true } : {}) });
      if (tell) {
        await this.#note(
          live,
          `Couldn't merge into ${item.base} yet: ${lower(s(out.message))}. It will try again when the chats in the project folder are next idle.`,
        );
      }
      return;
    }
    await drop(this.stateDir, key); // done for good: nothing to merge, the workspace is gone, ...
    await this.#note(live, `Couldn't merge into ${item.base}: ${lower(s(out.message))}.`);
    await this.#context(live, `Your queued merge into ${item.base} did not land: ${lower(s(out.message))}.`);
  }

  /**
   * SF 3: a merge found mid-stage that nothing here runs (AIB stopped during it). A stash it made is put back (or named in the chat);
   * a merge whose branch already moved is finished, any other goes back in the queue. The folder chats' landing locks end on their own.
   */
  async #recover(key: string, item: QueuedMerge): Promise<void> {
    this.#running.add(key);
    try {
      if (item.stashSha && item.stashFolder) await this.#putBackStash(item);
      const project = item.stashFolder || this.#projectOf(key);
      const tip = project && item.base ? await merge.rev(project, `refs/heads/${item.base}`).catch(() => '') : '';
      if (item.landed && tip && (await merge.isAncestor(project, item.landed, tip))) {
        await drop(this.stateDir, key);
        const count = Number((await wt.git(['rev-list', '--count', `${item.tipBefore}..${item.landed}`], project, { check: false })).stdout.trim()) || 1;
        await this.#note(item.chat, `Merged into ${item.base} (${plural(count, 'commit')}) · finished after a restart`);
        return;
      }
      await patch(this.stateDir, key, { stage: 'queued', stashSha: '', stashName: '', stashFolder: '', landed: '', tipBefore: '' });
    } finally {
      this.#running.delete(key);
    }
  }

  #projectOf(key: string): string {
    return s(new wt.Registry(this.stateDir).get(key)?.project);
  }

  async #putBackStash(item: QueuedMerge): Promise<void> {
    const listed = (await wt.git(['stash', 'list', '--format=%H %gd'], item.stashFolder, { check: false })).stdout.split(/\r?\n/);
    const entry = listed.map((line) => line.split(' ')).find(([sha]) => sha === item.stashSha);
    if (!entry) return; // put back before the stop
    const back = await wt.git(['stash', 'apply', '--index', item.stashSha], item.stashFolder, { check: false });
    if (back.returncode === 0) {
      await wt.git(['stash', 'drop', entry[1]], item.stashFolder, { check: false });
      await this.#note(item.chat, 'AIB stopped while merging this chat. The uncommitted edits in the project folder were set aside then and are back now.');
    } else {
      await this.#note(
        item.chat,
        `AIB stopped while merging this chat. The uncommitted edits in the project folder are kept in the stash “${item.stashName}” ` +
          `(${item.stashSha.slice(0, 8)}); nothing was lost.`,
      );
    }
  }
}
