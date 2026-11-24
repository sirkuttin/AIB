/**
 * Comments on a local doc. They live in the doc's own Y.Doc (map "comments", one Y.Map per thread), so they are saved with it,
 * survive a restart and reach every open editor through the same sync. They never go into the Markdown copy.
 *
 * Anchors. A thread on words holds two Yjs relative positions inside the textblock's text: `start` sticks to the first quoted
 * character, `end` to the last one (assoc -1). Typing before the words moves them along; typing inside them widens them. A thread
 * with no anchor is a whole-doc note.
 *
 * Detached. When every anchored character is gone (the user deleted the words, a file edit removed them) the thread stays and is
 * marked `detached` ("Text removed"); an undo that brings the words back re-attaches it. An agent's doc_edit that would delete or
 * replace anchored words is refused (`anchors_affected`) unless the op carries `allowDetach`; then the thread is marked detached
 * even if some of its words remain.
 *
 * `seq` numbers every change to the comments (a thread, a reply, a resolve, a detach), so "only newer than" is `since`.
 */
import * as Y from 'yjs';
import { DocRefusal } from './live_doc.ts';
import { idOf, textOf } from './blocks.ts';

export const COMMENTS = 'comments';
export const DETACHED_NOTE = 'Text removed';
const MAX_TEXT = 10_000;
const MAX_IDS = 20_000;

type Json = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type YType = Y.AbstractType<any>;

export interface Reply {
  by: string;
  at: string;
  seq: number;
  text: string;
}

export interface Detached {
  by: string;
  at: string;
  seq: number;
  /** removed: the words are gone; edited: an agent's allowDetach edit changed them. */
  reason: 'removed' | 'edited';
}

export interface Anchor {
  start: Json;
  end: Json;
}

export interface ThreadView {
  thread: string;
  /** 'words': on quoted words; 'doc': a whole-doc note. */
  on: 'words' | 'doc';
  by: string;
  at: string;
  /** The last change to this thread. */
  seq: number;
  /** The words it hangs on now (detached: the words it was on). */
  quote?: string;
  /** The words when the thread was made, if they changed since. */
  quoted?: string;
  /** The textblock holding the words, and where they are in its text. */
  block?: string;
  /** The page the words are on. */
  page?: string;
  from?: number;
  to?: number;
  anchor?: Anchor;
  detached?: true;
  note?: string;
  detachedBy?: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  sent?: Json;
  replies: Reply[];
}

export interface Range {
  el: Y.XmlElement;
  from: number;
  to: number;
}

/** A thread an agent edit may not take the words from: its anchored characters, by Yjs id. */
export interface AnchorGuard {
  thread: string;
  quote: string;
  by: string;
  ids: Y.ID[];
}

function gone(t: YType | null): boolean {
  for (let x: YType | null = t; x; x = x._item ? (x._item.parent as YType) : null) {
    if (x._item?.deleted) return true;
  }
  return false;
}

function absOf(doc: Y.Doc, json: unknown): Y.AbsolutePosition | null {
  try {
    return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
  } catch {
    return null;
  }
}

/** Where a child text's index is in its textblock's text (textOf: an atom counts one). */
function offsetIn(el: Y.XmlElement, text: Y.XmlText, index: number): number | null {
  let at = 0;
  for (const child of el.toArray()) {
    if (child === text) return at + index;
    at += child instanceof Y.XmlText ? child.length : 1;
  }
  return null;
}

/** The words an anchor stands on in `doc` now, or null when they are gone. */
export function rangeOf(doc: Y.Doc, anchor: Anchor | null | undefined): Range | null {
  if (!anchor) return null;
  const s = absOf(doc, anchor.start), e = absOf(doc, anchor.end);
  if (!s || !e || !(s.type instanceof Y.XmlText) || !(e.type instanceof Y.XmlText)) return null;
  const el = s.type.parent;
  if (!(el instanceof Y.XmlElement) || e.type.parent !== el || gone(s.type) || gone(e.type)) return null;
  const from = offsetIn(el, s.type, s.index), to = offsetIn(el, e.type, e.index);
  if (from === null || to === null || to <= from) return null;
  return { el, from, to };
}

/** Relative positions for the characters [from, to) of a textblock's text. */
export function anchorOf(el: Y.XmlElement, from: number, to: number): Anchor {
  let at = 0;
  let start: Y.RelativePosition | null = null, end: Y.RelativePosition | null = null;
  for (const child of el.toArray()) {
    const length = child instanceof Y.XmlText ? child.length : 1;
    if (child instanceof Y.XmlText) {
      if (!start && at <= from && from < at + length) start = Y.createRelativePositionFromTypeIndex(child, from - at, 0);
      if (!end && at < to && to <= at + length) end = Y.createRelativePositionFromTypeIndex(child, to - at, -1);
    }
    at += length;
  }
  if (!start || !end || to <= from) {
    throw new DocRefusal('bad_op', 'Quote words: the quoted text must start and end on words, not on a line break or image.');
  }
  return { start: Y.relativePositionToJSON(start), end: Y.relativePositionToJSON(end) };
}

/** The Yjs ids of the characters (and inline atoms) a range covers. */
function idsOf(range: Range): Y.ID[] {
  const ids: Y.ID[] = [];
  let at = 0;
  for (const child of range.el.toArray()) {
    if (child instanceof Y.XmlText) {
      let pos = at;
      for (let item = child._start; item && ids.length < MAX_IDS; item = item.right) {
        if (item.deleted || !item.countable) continue;
        for (let k = 0; k < item.length; k++) {
          if (pos + k >= range.from && pos + k < range.to) ids.push(Y.createID(item.id.client, item.id.clock + k));
        }
        pos += item.length;
      }
      at += child.length;
    } else {
      if (at >= range.from && at < range.to && child._item) ids.push(child._item.id);
      at += 1;
    }
  }
  return ids;
}

/** Did `doc` (a copy with the same history) delete any of these characters? */
export function anyDeleted(doc: Y.Doc, ids: Y.ID[]): boolean {
  for (const id of ids) {
    let item: Y.Item | Y.GC;
    try {
      item = Y.getItem(doc.store, id);
    } catch {
      return true;
    }
    if (item.deleted || !(item instanceof Y.Item) || gone(item.parent as YType)) return true;
  }
  return false;
}

function bodyText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DocRefusal('bad_op', '`text` is the comment, as a non-empty string');
  if (value.length > MAX_TEXT) throw new DocRefusal('bad_op', `\`text\` is at most ${MAX_TEXT} characters`);
  return value.trim();
}

export class Comments {
  readonly map: Y.Map<Y.Map<unknown>>;
  /** The page a block is on (LiveDoc sets it): thread views carry it. */
  pageOf: ((block: string) => string | null) | null = null;

  constructor(readonly doc: Y.Doc) {
    this.map = doc.getMap(COMMENTS) as Y.Map<Y.Map<unknown>>;
  }

  /** The latest seq: the number of the last change to the comments. */
  get seq(): number {
    let n = 0;
    for (const t of this.map.values()) n = Math.max(n, Number(t.get('seq')) || 0);
    return n;
  }

  /** Does this transaction change the comments? */
  touches(tr: Y.Transaction): boolean {
    for (const type of tr.changed.keys()) {
      for (let t: YType | null = type; t; t = t._item ? (t._item.parent as YType) : null) {
        if (t === (this.map as unknown as YType)) return true;
      }
    }
    return false;
  }

  #thread(id: unknown): Y.Map<unknown> {
    const t = typeof id === 'string' ? this.map.get(id) : undefined;
    if (!(t instanceof Y.Map)) {
      throw new DocRefusal('no_thread', `There is no comment thread "${String(id)}" on this doc; doc_comments lists them.`);
    }
    return t;
  }

  #touch(t: Y.Map<unknown>, seq: number): void {
    t.set('seq', seq);
  }

  /** A new thread on the words of `range`, or (range null) a whole-doc note. */
  add(by: string, text: unknown, range: Range | null, origin: unknown): ThreadView {
    const body = bodyText(text);
    const anchor = range ? anchorOf(range.el, range.from, range.to) : null;
    const quote = range ? textOf(range.el).slice(range.from, range.to) : null;
    const seq = this.seq + 1;
    let id = `t${seq}`;
    while (this.map.has(id)) id = `t${seq}${Math.random().toString(36).slice(2, 5)}`;
    const at = new Date().toISOString();
    this.doc.transact(() => {
      const t = new Y.Map<unknown>();
      this.map.set(id, t);
      t.set('by', by);
      t.set('at', at);
      t.set('seq', seq);
      t.set('anchor', anchor);
      t.set('quote', quote);
      t.set('resolved', false);
      const replies = new Y.Array<Reply>();
      t.set('replies', replies);
      replies.push([{ by, at, seq, text: body }]);
    }, origin);
    return this.view(id);
  }

  reply(by: string, thread: unknown, text: unknown, origin: unknown): ThreadView {
    const t = this.#thread(thread);
    const body = bodyText(text);
    const seq = this.seq + 1;
    this.doc.transact(() => {
      (t.get('replies') as Y.Array<Reply>).push([{ by, at: new Date().toISOString(), seq, text: body }]);
      this.#touch(t, seq);
    }, origin);
    return this.view(thread as string);
  }

  /**
   * Resolve a thread. An agent may resolve only a thread it started, unless the user asked for it in chat (`userAsked`); the user
   * may resolve any.
   */
  resolve(by: string, thread: unknown, opts: { agent: boolean; userAsked?: unknown }, origin: unknown): ThreadView {
    const t = this.#thread(thread);
    if (opts.agent && t.get('by') !== by && opts.userAsked !== true) {
      throw new DocRefusal(
        'not_yours',
        `Thread ${thread} was started by ${t.get('by') === 'user' ? 'the user' : t.get('by')}: only they resolve it. Reply instead; ` +
          'resolve it only when the user asked you to in chat (then send "userAsked": true).',
        { thread },
      );
    }
    if (t.get('resolved') !== true) {
      const seq = this.seq + 1;
      this.doc.transact(() => {
        t.set('resolved', true);
        t.set('resolvedBy', by);
        t.set('resolvedAt', new Date().toISOString());
        this.#touch(t, seq);
      }, origin);
    }
    return this.view(thread as string);
  }

  /** Open a resolved thread again (the user's action). */
  reopen(by: string, thread: unknown, origin: unknown): ThreadView {
    const t = this.#thread(thread);
    if (t.get('resolved') === true) {
      const seq = this.seq + 1;
      this.doc.transact(() => {
        t.set('resolved', false);
        t.set('reopenedBy', by);
        t.delete('resolvedBy');
        t.delete('resolvedAt');
        this.#touch(t, seq);
      }, origin);
    }
    return this.view(thread as string);
  }

  /** Remember that a thread was sent to a chat (the UI shows it). */
  markSent(thread: string, chat: string, origin: unknown): void {
    const t = this.#thread(thread);
    const seq = this.seq + 1;
    this.doc.transact(() => {
      t.set('sent', { chat, at: new Date().toISOString(), seq });
      this.#touch(t, seq);
    }, origin);
  }

  /** The open anchored threads an agent edit must not take the words from (resolved and detached ones are not guarded). */
  guards(): AnchorGuard[] {
    const out: AnchorGuard[] = [];
    for (const [id, t] of this.map) {
      if (t.get('resolved') === true || t.get('detached')) continue;
      const range = rangeOf(this.doc, t.get('anchor') as Anchor | null);
      if (!range) continue;
      out.push({ thread: id, quote: textOf(range.el).slice(range.from, range.to), by: String(t.get('by')), ids: idsOf(range) });
    }
    return out;
  }

  /** Mark threads detached (an agent's allowDetach edit). */
  detach(threads: string[], by: string, reason: Detached['reason'], origin: unknown): void {
    const todo = threads.map((id) => this.map.get(id)).filter((t): t is Y.Map<unknown> => t instanceof Y.Map && !t.get('detached'));
    if (!todo.length) return;
    let seq = this.seq;
    this.doc.transact(() => {
      for (const t of todo) {
        t.set('detached', { by, at: new Date().toISOString(), seq: ++seq, reason } satisfies Detached);
        this.#touch(t, seq);
      }
    }, origin);
  }

  /**
   * After the text changed: a thread whose words are all gone is marked detached ("Text removed"); one detached that way whose words
   * came back (an undo) is attached again. Cheap: one position lookup per anchored thread.
   */
  recheck(by: string, origin: unknown): void {
    const lost: Y.Map<unknown>[] = [], back: Y.Map<unknown>[] = [];
    for (const t of this.map.values()) {
      const anchor = t.get('anchor') as Anchor | null;
      if (!anchor) continue;
      const here = rangeOf(this.doc, anchor) !== null;
      const detached = t.get('detached') as Detached | undefined;
      if (!here && !detached) lost.push(t);
      else if (here && detached?.reason === 'removed') back.push(t);
    }
    if (!lost.length && !back.length) return;
    let seq = this.seq;
    this.doc.transact(() => {
      for (const t of lost) {
        t.set('detached', { by, at: new Date().toISOString(), seq: ++seq, reason: 'removed' } satisfies Detached);
        this.#touch(t, seq);
      }
      for (const t of back) {
        t.delete('detached');
        this.#touch(t, ++seq);
      }
    }, origin);
  }

  get(thread: unknown): ThreadView {
    this.#thread(thread);
    return this.view(thread as string);
  }

  view(id: string): ThreadView {
    const t = this.#thread(id);
    const anchor = t.get('anchor') as Anchor | null;
    const quoted = t.get('quote') as string | null;
    const detached = t.get('detached') as Detached | undefined;
    const replies = (t.get('replies') as Y.Array<Reply> | undefined)?.toArray() ?? [];
    const v: ThreadView = {
      thread: id,
      on: anchor ? 'words' : 'doc',
      by: String(t.get('by')),
      at: String(t.get('at')),
      seq: Number(t.get('seq')) || 0,
      resolved: t.get('resolved') === true,
      replies: replies.map((r) => ({ ...r })),
    };
    if (anchor) {
      // detached: the words it was on (an allowDetach edit may have left new words between its ends)
      const range = detached ? null : rangeOf(this.doc, anchor);
      if (range) {
        const now = textOf(range.el).slice(range.from, range.to);
        v.quote = now;
        if (quoted !== null && quoted !== now) v.quoted = quoted;
        Object.assign(v, { block: idOf(range.el), from: range.from, to: range.to });
        const page = this.pageOf?.(idOf(range.el));
        if (page) v.page = page;
      } else v.quote = quoted ?? '';
      v.anchor = anchor;
      if (detached || !range) {
        v.detached = true;
        v.note = DETACHED_NOTE;
        if (detached) v.detachedBy = detached.by;
      }
    }
    if (v.resolved) {
      v.resolvedBy = String(t.get('resolvedBy') ?? '');
      v.resolvedAt = String(t.get('resolvedAt') ?? '');
    }
    const sent = t.get('sent');
    if (sent) v.sent = sent as Json;
    return v;
  }

  /** The threads (oldest first), only those changed after `since` when given, and the latest seq. */
  list(since?: number): { seq: number; threads: ThreadView[] } {
    const threads = [...this.map.keys()].map((id) => this.view(id))
      .filter((v) => since === undefined || v.seq > since)
      .sort((a, b) => (a.replies[0]?.seq ?? a.seq) - (b.replies[0]?.seq ?? b.seq));
    return { seq: this.seq, threads };
  }
}

/** A thread as a chat message for the doc's linked chat ("Send to agent"). */
export function commentMessage(docName: string, file: string, v: ThreadView): string {
  const where = v.on === 'doc'
    ? 'a note on the whole doc'
    : `a comment on the words "${v.quote}"${v.detached ? ' (those words have since been removed)' : ''}`;
  const lines = [
    `The user sent you ${where} in the doc "${docName}" (${file}), thread ${v.thread}:`,
    '',
    ...v.replies.map((r) => `${r.by === 'user' ? 'User' : r.by}: ${r.text}`),
    '',
    `Make the change it asks for with doc_edit on "${docName}" (if it asks for one), then answer in the thread with doc_reply ` +
    `{"doc":"${docName}","thread":"${v.thread}"}: say what you changed, or why not. Do not resolve it unless the user asks.`,
  ];
  return lines.join('\n');
}
