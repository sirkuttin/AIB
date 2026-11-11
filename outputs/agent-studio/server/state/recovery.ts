/**
 * Durable Studio recovery state (state_store.StateStore): owned conversations and prompt receipts.
 *
 * One JSON file per Studio (studio-<name>.json) in the shared state folder. It never holds transcripts or prompt text. Prompt
 * receipts keep only a SHA-256 fingerprint and a state, so a retried browser request can be recognised after a server restart.
 * Unlike the other stores this file belongs to one process (its name carries the port or 'host'), so it takes no file lock and
 * saves synchronously, as in Python. Conversations and receipts are Maps: insertion order decides what is pruned first.
 */
import { clip, isDict, isStr, pyFloat, pyLen, pyOr, pyStr } from '../core/py.ts';
import { isProvider } from '../agents/agent_registry.ts';
import type { MessageQueue, QueueStore, SavedItem } from '../acp/msgqueue.ts';
import { errorText, inDir, isOSError, OSError, VERSION } from './base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from './json.ts';

export const MAX_CONVERSATIONS = 50;
export const MAX_RECEIPTS_PER_SESSION = 200;
export const MAX_SESSIONS_WITH_RECEIPTS = 50;
export const RECEIPT_STATES = ['working', 'finished', 'error', 'unknown'] as const;
export type ReceiptState = typeof RECEIPT_STATES[number];

export interface Conversation {
  provider: string;
  sessionId: string;
  cwd: string;
  projectRoot: string;
  title: string;
  openedAt: number;
  lastSeen: number;
}

export interface Receipt {
  fingerprint: string;
  state: ReceiptState;
  at: number;
  dismissed?: true;
}

/** _text(value, limit): the string clipped, or '' for anything else. */
export function text(value: unknown, limit: number): string {
  return isStr(value) ? clip(value, limit) : '';
}

function isReceiptState(value: unknown): value is ReceiptState {
  return isStr(value) && (RECEIPT_STATES as readonly string[]).includes(value);
}

export class StateStore {
  readonly directory: string;
  readonly path: string;
  /** 'provider:sessionId' -> display record, oldest first. */
  conversations = new Map<string, Conversation>();
  /** 'provider:sessionId' -> clientMessageId -> receipt, oldest first. */
  receipts = new Map<string, Map<string, Receipt>>();
  loadedFromPrevious: Conversation[] = [];
  warning = '';
  #unreadable = false;

  constructor(stateDir: string, name = 'recovery') {
    this.directory = stateDir;
    this.path = inDir(stateDir, `studio-${name}.json`);
    this.#load();
  }

  static sessionKey(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
  }

  #load(): void {
    const [status, raw] = readJsonFile(this.path);
    if (status === 'missing') return;
    if (status === 'busy') {
      this.#unreadable = true; // keep what we have and do not overwrite the file until a read succeeds
      this.warning = 'Saved AIB recovery state could not be read just now and was left untouched.';
      return;
    }
    if (status === 'corrupt') {
      this.warning = 'Saved AIB recovery state was unreadable and was ignored.';
      quarantine(this.path);
      return;
    }
    if (!isDict(raw) || raw.version !== VERSION) {
      this.warning = 'Saved AIB recovery state has an unknown version and was ignored.';
      return;
    }
    for (const item of Array.isArray(raw.conversations) ? raw.conversations.slice(0, MAX_CONVERSATIONS) : []) {
      const record = StateStore.cleanConversation(item);
      if (record) this.conversations.set(StateStore.sessionKey(record.provider, record.sessionId), record);
    }
    const receipts = isDict(raw.receipts) ? raw.receipts : {};
    for (const [key, items] of entriesOf(receipts).slice(0, MAX_SESSIONS_WITH_RECEIPTS)) {
      if (!isDict(items)) continue;
      const cleaned = new Map<string, Receipt>();
      for (const [messageId, receipt] of entriesOf(items).slice(-MAX_RECEIPTS_PER_SESSION)) {
        if (pyLen(messageId) >= 1 && pyLen(messageId) <= 128 && isDict(receipt) && isStr(receipt.fingerprint)) {
          // A server that stopped mid-turn cannot know whether the agent received or finished it.
          const raw = receipt.state;
          const state: ReceiptState = raw === 'working' || raw === 'unknown' || !isReceiptState(raw) ? 'unknown' : raw;
          const entry: Receipt = { fingerprint: clip(receipt.fingerprint, 128), state, at: pyFloat(pyOr(receipt.at, 0)) };
          if (state === 'unknown' && receipt.dismissed === true) entry.dismissed = true;
          cleaned.delete(messageId);
          cleaned.set(messageId, entry);
        }
      }
      if (cleaned.size) this.receipts.set(key, cleaned);
    }
    this.loadedFromPrevious = [...this.conversations.values()].map((item) => ({ ...item }));
    if ([...this.receipts.values()].some((items) => [...items.values()].some((r) => r.state === 'unknown'))) this.save();
  }

  static cleanConversation(item: unknown): Conversation | null {
    if (!isDict(item) || !isProvider(item.provider)) return null;
    const sessionId = item.sessionId;
    const cwd = item.cwd;
    if (!isStr(sessionId) || !sessionId || pyLen(sessionId) > 512 || !isStr(cwd) || !cwd) return null;
    const root = item.projectRoot; // records saved before worktree chats have none: the project folder is the cwd
    const projectRoot = isStr(root) && root ? clip(root, 1024) : clip(cwd, 1024);
    return {
      provider: item.provider,
      sessionId,
      cwd: clip(cwd, 1024),
      projectRoot,
      title: text(item.title, 200),
      openedAt: pyFloat(pyOr(item.openedAt, 0)),
      lastSeen: pyFloat(pyOr(item.lastSeen, 0)),
    };
  }

  save(): void {
    const payload = {
      version: VERSION,
      savedAt: now(),
      conversations: [...this.conversations.values()],
      receipts: this.receipts,
    };
    try {
      if (this.#unreadable) {
        // The file could not be read earlier: retry the read, and never overwrite it while it is still unreadable.
        const [status] = readJsonFile(this.path);
        if (status === 'busy') throw new OSError('the saved file could not be read just now, so it was left untouched');
        this.#unreadable = false;
        // Readable again: take what is on disk rather than overwrite it with our empty/stale view.
        this.conversations = new Map();
        this.receipts = new Map();
        this.#load();
        return;
      }
      saveJson(this.path, payload, '.studio-recovery-');
      this.warning = '';
    } catch (error) {
      if (!isOSError(error)) throw error;
      this.warning = `AIB could not save recovery state: ${errorText(error)}`;
    }
  }

  rememberConversation(provider: unknown, sessionId: unknown, cwd: unknown, title: unknown = '', projectRoot: unknown = null): void {
    if (!isProvider(provider) || !isStr(sessionId) || !sessionId) return;
    const key = StateStore.sessionKey(provider, sessionId);
    const time = now();
    const old = this.conversations.get(key);
    this.conversations.delete(key);
    this.conversations.set(key, {
      provider,
      sessionId,
      cwd: clip(pyStr(cwd), 1024),
      projectRoot: clip(pyStr(pyOr(projectRoot, cwd)), 1024),
      title: text(title, 200) || (old?.title ?? ''),
      openedAt: old?.openedAt || time,
      lastSeen: time,
    });
    while (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
    this.save();
  }

  forgetConversation(provider: string, sessionId: string): boolean {
    const removed = this.conversations.delete(StateStore.sessionKey(provider, sessionId));
    if (removed) this.save();
    return removed;
  }

  receipt(provider: string, sessionId: string, messageId: string): Receipt | null {
    const found = this.receipts.get(StateStore.sessionKey(provider, sessionId))?.get(messageId);
    return found ? { ...found } : null;
  }

  setReceipt(provider: string, sessionId: string, messageId: string, fingerprint: string, state: string): void {
    if (!isReceiptState(state) || !messageId) return;
    const key = StateStore.sessionKey(provider, sessionId);
    const items = this.receipts.get(key) ?? new Map<string, Receipt>();
    this.receipts.delete(key);
    items.delete(messageId);
    items.set(messageId, { fingerprint, state, at: now() });
    while (items.size > MAX_RECEIPTS_PER_SESSION) items.delete(items.keys().next().value!);
    this.receipts.set(key, items);
    while (this.receipts.size > MAX_SESSIONS_WITH_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!);
    this.save();
  }

  unknownCount(provider: string, sessionId: string): number {
    return this.unknownReceipts(provider, sessionId).length;
  }

  /** Messages that were mid-send at a restart and not yet dismissed by the user: [{clientMessageId, at}]. */
  unknownReceipts(provider: string, sessionId: string): { clientMessageId: string; at: number }[] {
    const items = this.receipts.get(StateStore.sessionKey(provider, sessionId)) ?? new Map<string, Receipt>();
    return [...items].filter(([, r]) => r.state === 'unknown' && !r.dismissed).map(([id, r]) => ({ clientMessageId: id, at: r.at ?? 0 }));
  }

  /** "It arrived, dismiss": keeps the receipt unknown (a resend of this id stays refused) but stops warning about it. */
  dismissReceipt(provider: string, sessionId: string, messageId: string): boolean {
    const receipt = this.receipts.get(StateStore.sessionKey(provider, sessionId))?.get(messageId);
    if (!receipt || receipt.state !== 'unknown') return false;
    if (!receipt.dismissed) {
      receipt.dismissed = true;
      this.save();
    }
    return true;
  }

  /** Used at orderly shutdown, before the process exits. */
  markWorkingUnknown(): void {
    let changed = false;
    for (const items of this.receipts.values()) {
      for (const receipt of items.values()) {
        if (receipt.state === 'working') {
          receipt.state = 'unknown';
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }
}

/** What Recovery needs of a Connection (acp_connection.Connection). */
export interface RecoverableConnection {
  provider: string;
  sessionId: string | null;
  cwd: string;
  projectRoot?: string | null;
  persisted: boolean;
  queue: Pick<MessageQueue, 'toSaved'>;
  queueRestore(saved: SavedItem[]): void;
}

/** Hook object a Studio installs on each Connection; never throws into the caller. */
export class Recovery {
  shuttingDown = false;
  /** msgqueue.QueueStore, set by Studio. */
  queues: QueueStore | null = null;

  constructor(readonly store: StateStore) {}

  receipt(connection: RecoverableConnection, messageId: string): Receipt | null {
    return this.store.receipt(connection.provider, connection.sessionId ?? '', messageId);
  }

  receiptChanged(connection: RecoverableConnection, messageId: string, receipt: { fingerprint: string; state: string }): void {
    if (this.shuttingDown || !connection.sessionId) return;
    this.store.setReceipt(connection.provider, connection.sessionId, messageId, receipt.fingerprint, receipt.state);
  }

  connectionReady(connection: RecoverableConnection): void {
    if (this.shuttingDown || !connection.sessionId) return;
    connection.persisted = true;
    this.store.rememberConversation(connection.provider, connection.sessionId, connection.cwd, '', connection.projectRoot ?? null);
    if (this.queues) {
      const saved = this.queues.get(connection.provider, connection.sessionId);
      if (saved.length) connection.queueRestore(saved);
    }
  }

  queueChanged(connection: RecoverableConnection): void {
    if (this.queues && !this.shuttingDown && connection.sessionId) {
      this.queues.put(connection.provider, connection.sessionId, connection.queue.toSaved());
    }
  }

  connectionClosed(connection: RecoverableConnection): void {
    // Orderly Studio shutdown keeps the entry so the next start can offer reconnecting.
    if (this.shuttingDown || !connection.persisted || !connection.sessionId) return;
    this.store.forgetConversation(connection.provider, connection.sessionId);
    // the user ended this conversation: its queue goes with it
    if (this.queues) this.queues.forget(connection.provider, connection.sessionId);
  }
}
