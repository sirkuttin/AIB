/// <reference lib="deno.worker" />
/**
 * The history Worker: owns every chat's store of this agent host (store.ts), so a slow SQLite call never stalls the host's event
 * loop. client.ts posts {id, op, chat, ...} and gets {id, ok: true, result} or {id, ok: false, error: {name, code, message}} back.
 */
import { type Checkpoint, type RangeOptions, type StoreEvent, type StoreOptions, Stores } from './store.ts';

export type Request =
  | { id: number; op: 'init'; dir: string; options?: Omit<StoreOptions, 'now'> }
  | { id: number; op: 'open'; chat: string; eventsId?: string | null; mainSession?: string | null }
  | { id: number; op: 'claim'; chat: string; epoch: number }
  | { id: number; op: 'checkEpoch'; chat: string }
  | { id: number; op: 'mainSession'; chat: string; session: string | null }
  | { id: number; op: 'append'; chat: string; events: StoreEvent[] }
  | { id: number; op: 'tail'; chat: string; options?: RangeOptions }
  | { id: number; op: 'before'; chat: string; seq: number; options?: RangeOptions }
  | { id: number; op: 'after'; chat: string; seq: number; options?: RangeOptions }
  | { id: number; op: 'helper'; chat: string; session: string; options?: RangeOptions & { before?: number } }
  | { id: number; op: 'helpers'; chat: string }
  | { id: number; op: 'event'; chat: string; seq: number }
  | { id: number; op: 'getCheckpoint'; chat: string }
  | { id: number; op: 'setCheckpoint'; chat: string; ckpt: Checkpoint }
  | { id: number; op: 'truncateBefore'; chat: string }
  | { id: number; op: 'dropProvisional'; chat: string; above?: number }
  | { id: number; op: 'reset'; chat: string; eventsId: string }
  | { id: number; op: 'search'; chat: string; query: string; limit?: number }
  | { id: number; op: 'info'; chat: string }
  | { id: number; op: 'close'; chat: string }
  | { id: number; op: 'delete'; chat: string }
  | { id: number; op: 'release'; chat: string }
  | { id: number; op: 'archive'; chat: string; why: string }
  | { id: number; op: 'continueAt'; chat: string; epoch: number; ckpt: Checkpoint }
  | { id: number; op: 'find'; provider: string; session: string }
  | { id: number; op: 'forget'; provider: string; session: string }
  | { id: number; op: 'closeAll' };

let stores: Stores | null = null;

/** One request, answered synchronously (exported for tests). */
export function handle(m: Request): unknown {
  if (m.op === 'init') {
    stores?.closeAll();
    stores = new Stores(m.dir, m.options ?? {});
    return true;
  }
  if (!stores) throw new Error('history worker: init first');
  if (m.op === 'closeAll') return stores.closeAll();
  if (m.op === 'open') return stores.open(m.chat, { eventsId: m.eventsId, mainSession: m.mainSession });
  if (m.op === 'close') return stores.close(m.chat);
  if (m.op === 'delete') return stores.delete(m.chat);
  if (m.op === 'release') return stores.release(m.chat);
  if (m.op === 'archive') return stores.archive(m.chat, m.why);
  if (m.op === 'find') return stores.find(m.provider, m.session);
  if (m.op === 'forget') return stores.forget(m.provider, m.session);
  const s = stores.get(m.chat);
  switch (m.op) {
    case 'claim':
      return s.claim(m.epoch);
    case 'checkEpoch':
      return s.checkEpoch();
    case 'mainSession':
      s.mainSession = m.session;
      return true;
    case 'append':
      return s.append(m.events);
    case 'tail':
      return s.tail(m.options);
    case 'before':
      return s.before(m.seq, m.options);
    case 'after':
      return s.after(m.seq, m.options);
    case 'helper':
      return s.helper(m.session, m.options);
    case 'helpers':
      return s.helpers();
    case 'event':
      return s.event(m.seq);
    case 'getCheckpoint':
      return s.checkpoint();
    case 'setCheckpoint':
      return s.setCheckpoint(m.ckpt);
    case 'truncateBefore':
      return s.truncateBefore();
    case 'dropProvisional':
      return s.dropProvisional(m.above);
    case 'reset':
      return s.reset(m.eventsId);
    case 'continueAt':
      return s.continueAt(m.epoch, m.ckpt);
    case 'search':
      return s.search(m.query, m.limit);
    case 'info':
      return s.info();
  }
}

if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  self.onmessage = (e: MessageEvent<Request>) => {
    const m = e.data;
    try {
      self.postMessage({ id: m.id, ok: true, result: handle(m) ?? null });
    } catch (error) {
      const err = error as { name?: string; code?: string; message?: string };
      self.postMessage({
        id: m.id,
        ok: false,
        error: { name: err?.name ?? 'Error', code: err?.code ?? '', message: err?.message ?? String(error) },
      });
    }
  };
}
