/**
 * The agent host's side of the history Worker (store_worker.ts): one Worker for every chat's store, a promise per call. Errors keep
 * their code: 'fenced' (another owner took the store; it closed itself), 'closed', 'checkpoint', 'worker'.
 */
import type {
  Checkpoint,
  HistoryStore,
  OpenInfo,
  Page,
  RangeOptions,
  SearchHit,
  StoredEvent,
  StoreEvent,
  StoreOptions,
  WriteResult,
} from './store.ts';

export class HistoryError extends Error {
  constructor(readonly code: string, message: string, name = 'HistoryError') {
    super(message);
    this.name = name;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class HistoryClient {
  #worker: Worker;
  #next = 1;
  #pending = new Map<number, Pending>();
  #ready: Promise<unknown>;
  #stopped = false;
  /** A call the Worker never answers fails after this long (no caller waits for ever). */
  static callTimeoutMs = 30_000;

  constructor(dir: string, options: Omit<StoreOptions, 'now'> = {}) {
    this.#worker = new Worker(new URL('./store_worker.ts', import.meta.url).href, { type: 'module' });
    this.#worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; ok: boolean; result?: unknown; error?: { name: string; code: string; message: string } };
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new HistoryError(m.error!.code, m.error!.message, m.error!.name));
    };
    this.#worker.onerror = (e) => {
      e.preventDefault();
      for (const p of this.#pending.values()) p.reject(new HistoryError('worker', e.message));
      this.#pending.clear();
    };
    this.#ready = this.#call({ op: 'init', dir, options });
  }

  #call(message: Record<string, unknown>): Promise<unknown> {
    if (this.#stopped) return Promise.reject(new HistoryError('closed', 'history worker stopped'));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new HistoryError('timeout', `history worker: no answer to ${String(message.op)} in ${HistoryClient.callTimeoutMs} ms`));
      }, HistoryClient.callTimeoutMs);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#worker.postMessage({ ...message, id });
    });
  }

  async #op<T>(message: Record<string, unknown>): Promise<T> {
    await this.#ready;
    return await this.#call(message) as T;
  }

  open(chat: string, options: { eventsId?: string | null; mainSession?: string | null } = {}): Promise<OpenInfo> {
    return this.#op({ op: 'open', chat, ...options });
  }
  claim(chat: string, epoch: number): Promise<void> {
    return this.#op({ op: 'claim', chat, epoch });
  }
  checkEpoch(chat: string): Promise<boolean> {
    return this.#op({ op: 'checkEpoch', chat });
  }
  setMainSession(chat: string, session: string | null): Promise<void> {
    return this.#op({ op: 'mainSession', chat, session });
  }
  append(chat: string, events: StoreEvent[]): Promise<WriteResult> {
    return this.#op({ op: 'append', chat, events });
  }
  tail(chat: string, options?: RangeOptions): Promise<Page> {
    return this.#op({ op: 'tail', chat, options });
  }
  before(chat: string, seq: number, options?: RangeOptions): Promise<Page> {
    return this.#op({ op: 'before', chat, seq, options });
  }
  after(chat: string, seq: number, options?: RangeOptions): Promise<Page> {
    return this.#op({ op: 'after', chat, seq, options });
  }
  helper(chat: string, session: string, options?: RangeOptions & { before?: number }): Promise<Page> {
    return this.#op({ op: 'helper', chat, session, options });
  }
  helpers(chat: string): Promise<{ session: string; count: number; last: number }[]> {
    return this.#op({ op: 'helpers', chat });
  }
  event(chat: string, seq: number): Promise<StoredEvent | null> {
    return this.#op({ op: 'event', chat, seq });
  }
  getCheckpoint(chat: string): Promise<{ writtenSeq: number; ckpt: Checkpoint | null }> {
    return this.#op({ op: 'getCheckpoint', chat });
  }
  setCheckpoint(chat: string, ckpt: Checkpoint): Promise<boolean> {
    return this.#op({ op: 'setCheckpoint', chat, ckpt });
  }
  truncateBefore(chat: string): Promise<number> {
    return this.#op({ op: 'truncateBefore', chat });
  }
  dropProvisional(chat: string, above?: number): Promise<number> {
    return this.#op({ op: 'dropProvisional', chat, above });
  }
  reset(chat: string, eventsId: string): Promise<void> {
    return this.#op({ op: 'reset', chat, eventsId });
  }
  search(chat: string, query: string, limit?: number): Promise<SearchHit[]> {
    return this.#op({ op: 'search', chat, query, limit });
  }
  info(chat: string): Promise<ReturnType<HistoryStore['info']>> {
    return this.#op({ op: 'info', chat });
  }
  close(chat: string): Promise<void> {
    return this.#op({ op: 'close', chat });
  }
  /** Delete the store for good (the person deleted the chat; tests). Quitting, an agent exit or closing a chat use release(). */
  delete(chat: string): Promise<void> {
    return this.#op({ op: 'delete', chat });
  }
  /** The chat stopped: close the store and keep it ('empty': a store with no event was removed). */
  release(chat: string): Promise<'kept' | 'empty'> {
    return this.#op({ op: 'release', chat });
  }
  /** Copy the store to archive/, then remove it (a store that cannot go on as this chat's). */
  archive(chat: string, why: string): Promise<string> {
    return this.#op({ op: 'archive', chat, why });
  }
  /** A reopened conversation: the store goes on under the new keeper channel's epoch, from this checkpoint. */
  continueAt(chat: string, epoch: number, ckpt: Checkpoint): Promise<void> {
    return this.#op({ op: 'continueAt', chat, epoch, ckpt });
  }
  /** The stores of one conversation, newest first. */
  find(provider: string, session: string): Promise<{ chat: string; last: number; lastTime: number }[]> {
    return this.#op({ op: 'find', provider, session });
  }
  /** The person deleted the conversation: every store of it is removed. Returns their chat ids. */
  forget(provider: string, session: string): Promise<string[]> {
    return this.#op({ op: 'forget', provider, session });
  }

  /** Close every store and stop the Worker. */
  async shutdown(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#op({ op: 'closeAll' });
    } finally {
      this.#stopped = true;
      this.#worker.terminate();
      for (const p of this.#pending.values()) p.reject(new HistoryError('closed', 'history worker stopped'));
      this.#pending.clear();
    }
  }
}
