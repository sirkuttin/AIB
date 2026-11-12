/**
 * The agents working in one open doc, per chat (the chat's lasting id is its origin's name, so undo, guards and everything here are
 * per chat): what the page shows while they work and what it is told when their turn ends.
 *
 *   Presence   doc awareness (y-protocols), one awareness client per chat: {user: {name}, agent: {chat, name, page, block, intent},
 *              cursor: {anchor, head} (Y relative positions, y-tiptap's shape) | null}. Set by the chat's doc_edit / doc_claim, cleared
 *              at its turn end, cancel or when its connection goes (turnEnded).
 *   Claims     Y.Map "claims" in the Y.Doc (every viewer and a reload see them): chat -> {chat, name, page, ids, intent, at}. The
 *              blocks a chat is rewriting; released by its replacing edit, its turn end, or the user ("Stop and keep the text": the
 *              chat's next edit of those blocks is refused user_took_back until its turn ends).
 *   Requests   Y.Map "pageRequests": `${page}|${chat}` -> {page, chat, name, title, at}: an agent's page delete waits for the user.
 *   Refused    edits refused during a turn, per chat; at turn end the ones still undone become notes the page shows (sent over the
 *              doc socket as {type: "refused"}) until dismissed.
 *   Notices    words for the chat's next doc tool result ("userNotes"): the user kept a page, took a section back...
 */
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { DocRefusal, type LiveDoc, type Op } from './live_doc.ts';
import { BUILTIN_NAMES } from '../agents/agent_registry.ts';

type Json = Record<string, unknown>;

/** The name the page shows for an author: "You" for the user, the agent's name for a chat ("claude:<session>" -> "Claude Code"). */
export function agentName(who: string): string {
  if (who === 'user') return 'You';
  if (who === 'file') return 'File edit';
  if (who === 'system') return 'AIB';
  const provider = who.includes(':') ? who.slice(0, who.indexOf(':')) : who;
  return BUILTIN_NAMES[provider] ?? provider;
}

/** A history version's `by` ("user+claude:s1") as names: ["You", "Claude Code"]. */
export function authorNames(by: string): string[] {
  return [...new Set(by.split('+').filter(Boolean).map(agentName))];
}

export interface RefusedNote {
  id: string;
  chat: string;
  name: string;
  page: string | null;
  /** The blocks the refused op aimed at. */
  blocks: string[];
  code: string;
  message: string;
  /** What the agent wanted to write (Markdown or text), for "Show what it wrote" / "Insert below mine" / "Copy". */
  wrote: string;
  at: string;
}

export interface Claim {
  chat: string;
  name: string;
  page: string;
  ids: string[];
  intent: string;
  at: string;
}

export interface PageRequest {
  page: string;
  chat: string;
  name: string;
  title: string;
  at: string;
}

/** Block ids an op list aims at (targets and move destinations). */
export function opIds(ops: unknown): string[] {
  const out: string[] = [];
  for (const op of Array.isArray(ops) ? ops as Op[] : []) {
    if (!op || typeof op !== 'object') continue;
    for (const t of [op.target, op.to?.target]) {
      if (t && typeof t === 'object' && t.kind === 'blocks' && Array.isArray(t.ids)) {
        for (const id of t.ids) if (typeof id === 'string' && !out.includes(id)) out.push(id);
      }
    }
  }
  return out;
}

/** The words an op list wanted to write. */
function wroteOf(ops: unknown): string {
  const parts: string[] = [];
  const take = (source: unknown) => {
    const content = (source as { from?: { content?: unknown } } | undefined)?.from?.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) parts.push(...content.filter((c): c is string => typeof c === 'string'));
  };
  for (const op of Array.isArray(ops) ? ops as Op[] : []) {
    if (!op || typeof op !== 'object') continue;
    take(op.source);
    take(op.with);
  }
  return parts.join('\n\n');
}

export class DocAgents {
  readonly claims: Y.Map<Claim>;
  readonly requests: Y.Map<PageRequest>;
  /** Notes the page shows (refused edits still undone at a turn's end), until dismissed. */
  notes: RefusedNote[] = [];
  /** Per chat: the rev of its last read (an agent's rename is refused over a newer user rename). */
  readonly seen = new Map<string, number>();
  #presence = new Map<string, { aw: awarenessProtocol.Awareness; doc: Y.Doc }>();
  #refused = new Map<string, RefusedNote[]>();
  #notices = new Map<string, string[]>();
  #taken = new Map<string, Set<string>>();
  #seq = 0;
  /** Called when something the page lists changed (requests, notes): the store saves. */
  onChange: (() => void) | null = null;

  constructor(readonly live: LiveDoc) {
    this.claims = live.doc.getMap('claims') as Y.Map<Claim>;
    this.requests = live.doc.getMap('pageRequests') as Y.Map<PageRequest>;
    // claims belong to a running turn: none survives a restart
    if (this.claims.size) live.doc.transact(() => this.claims.clear(), live.system);
  }

  // ---------- notices for the chat ----------

  notice(chat: string, text: string): void {
    const list = this.#notices.get(chat) ?? [];
    list.push(text);
    this.#notices.set(chat, list.slice(-10));
  }

  takeNotices(chat: string): string[] {
    const list = this.#notices.get(chat) ?? [];
    this.#notices.delete(chat);
    return list;
  }

  // ---------- presence ----------

  /** Show the chat working at `block` on `page` (the caret at the end of the block's text). */
  present(chat: string, page: string, block: string | null, intent = ''): void {
    let p = this.#presence.get(chat);
    if (!p) {
      const doc = new Y.Doc();
      const aw = new awarenessProtocol.Awareness(doc);
      aw.on('update', () => {
        const update = awarenessProtocol.encodeAwarenessUpdate(aw, [aw.clientID]);
        awarenessProtocol.applyAwarenessUpdate(this.live.awareness, update, 'agent');
      });
      this.#presence.set(chat, p = { aw, doc });
    }
    let cursor: Json | null = null;
    const el = block ? this.live.elementOf(block) : null;
    const text = el?.toArray().filter((c): c is Y.XmlText => c instanceof Y.XmlText).at(-1);
    if (text) {
      const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.length));
      cursor = { anchor: rel, head: rel };
    }
    const name = agentName(chat);
    p.aw.setLocalState({ user: { name }, agent: { chat, name, page, block, intent }, cursor });
  }

  /** The chats shown working now, with what the page shows. */
  presence(): Json[] {
    return [...this.#presence.values()].map((p) => p.aw.getLocalState() as Json).filter(Boolean).map((s) => s.agent as Json);
  }

  #absent(chat: string): void {
    const p = this.#presence.get(chat);
    if (!p) return;
    this.#presence.delete(chat);
    p.aw.setLocalState(null);
    p.aw.destroy();
    p.doc.destroy();
  }

  // ---------- claims ----------

  claimOf(chat: string): Claim | null {
    return this.claims.get(chat) ?? null;
  }

  claim(chat: string, args: Json, page: (id: string) => string): Json {
    if (args.release === true) {
      this.release(chat, 'agent');
      return { ok: true, released: true };
    }
    const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length || ids.length !== (args.ids as unknown[]).length) {
      throw new DocRefusal('bad_op', '`ids` lists the blocks you are about to rewrite (ids from your read)');
    }
    const intent = typeof args.intent === 'string' ? args.intent.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (typeof args.ifRev !== 'number') throw new DocRefusal('missing_guard', 'a claim needs "ifRev": the rev of the read that showed the blocks');
    const ifRev = args.ifRev;
    for (const id of ids) {
      const sub = this.live.subOf(id);
      if (sub === null) throw new DocRefusal('block_gone', `block ${id} is gone; read again`, { id });
      if (sub > ifRev) {
        throw new DocRefusal('guard_mismatch', `block ${id} changed after your read (rev ${ifRev}): read it again before claiming it`, {
          id,
          rev: this.live.rev,
          block: { ...this.live.view(id, true), md: this.live.markdownOf(id) },
        });
      }
    }
    const taken = this.#taken.get(chat);
    const back = ids.filter((id) => taken?.has(id));
    if (back.length) throw this.#tookBack(back);
    for (const [other, c] of this.claims.entries()) {
      if (other === chat) continue;
      const both = c.ids.filter((id) => ids.includes(id));
      if (both.length) {
        throw new DocRefusal('claimed', `${c.name} (another chat) is rewriting ${both.join(', ')} now: leave those blocks to it.`, {
          blocks: both,
          by: c.name,
        });
      }
    }
    const pages = new Set(ids.map(page));
    const claim: Claim = {
      chat,
      name: agentName(chat),
      page: [...pages][0],
      ids: [...new Set([...(this.claims.get(chat)?.ids ?? []), ...ids])],
      intent,
      at: new Date().toISOString(),
    };
    this.live.doc.transact(() => this.claims.set(chat, claim), this.live.system);
    this.present(chat, claim.page, ids[0], intent);
    return { ok: true, claim };
  }

  /** Drop a chat's claim. `user`: the user took the section back; the chat's next edit of those blocks is refused. */
  release(chat: string, by: 'agent' | 'user' | 'turn'): Claim | null {
    const claim = this.claims.get(chat) ?? null;
    if (!claim) return null;
    this.live.doc.transact(() => this.claims.delete(chat), this.live.system);
    if (by === 'user') {
      const taken = this.#taken.get(chat) ?? new Set();
      for (const id of claim.ids) taken.add(id);
      this.#taken.set(chat, taken);
      this.notice(chat, `The user stopped your rewrite (${claim.intent || claim.ids.join(', ')}) and kept their text: leave those blocks as they are.`);
    }
    return claim;
  }

  #tookBack(ids: string[]): DocRefusal {
    return new DocRefusal(
      'user_took_back',
      `Not changed: the user took ${ids.join(', ')} back while you were rewriting them ("Stop and keep the text"). Their text stays; ` +
        'leave those blocks as they are this turn.',
      { blocks: ids },
    );
  }

  /** Before a chat's doc_edit: refused when it aims at blocks the user took back from it. */
  checkEdit(chat: string, ops: unknown): void {
    const taken = this.#taken.get(chat);
    if (!taken?.size) return;
    const back = opIds(ops).filter((id) => taken.has(id));
    if (back.length) throw this.#tookBack(back);
  }

  /** A chat's doc_edit landed: its claim lets go of what it replaced, its refusals that this edit made good go, presence moves. */
  landed(chat: string, ops: unknown, ack: Json): void {
    const aimed = new Set(opIds(ops));
    for (const id of (ack.gone as string[] | undefined) ?? []) aimed.add(id);
    const claim = this.claims.get(chat);
    if (claim) {
      const left = claim.ids.filter((id) => !aimed.has(id) && this.live.has(id));
      this.live.doc.transact(() => {
        if (left.length) this.claims.set(chat, { ...claim, ids: left });
        else this.claims.delete(chat);
      }, this.live.system);
    }
    const changed = ((ack.changed as { id: string }[] | undefined) ?? []).map((c) => c.id);
    for (const id of changed) aimed.add(id);
    const refused = this.#refused.get(chat);
    if (refused?.length) {
      this.#refused.set(chat, refused.filter((n) => !n.blocks.some((id) => aimed.has(id)) && !(n.wrote && this.#inDoc(n.wrote))));
    }
    const last = (ack.created as string[] | undefined)?.at(-1) ?? changed.at(-1) ?? null;
    if (last && this.live.has(last)) this.present(chat, this.live.pageOf(last), last, this.claims.get(chat)?.intent ?? '');
  }

  #inDoc(text: string): boolean {
    const want = text.replace(/\s+/g, ' ').trim();
    if (!want) return false;
    for (const { page } of this.live.pageFrags()) {
      const md = this.live.topBlocks(page).map((b) => this.live.markdownOf(b.id)).join('\n\n').replace(/\s+/g, ' ');
      if (md.includes(want)) return true;
    }
    return false;
  }

  /** A chat's doc_edit (or doc_page) was refused: remembered for its turn's end. */
  refused(chat: string, ops: unknown, error: DocRefusal, page: string | null): void {
    const list = this.#refused.get(chat) ?? [];
    list.push({
      id: `n${Date.now().toString(36)}${(++this.#seq).toString(36)}`,
      chat,
      name: agentName(chat),
      page,
      blocks: opIds(ops),
      code: error.code,
      message: error.message,
      wrote: wroteOf(ops),
      at: new Date().toISOString(),
    });
    this.#refused.set(chat, list.slice(-50));
  }

  /** Refusals of this chat's running turn (not yet notes). */
  pendingRefusals(chat: string): RefusedNote[] {
    return [...(this.#refused.get(chat) ?? [])];
  }

  dismiss(id: unknown): boolean {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => id !== 'all' && n.id !== id);
    if (this.notes.length !== before) this.onChange?.();
    return this.notes.length !== before;
  }

  // ---------- page delete requests ----------

  requestDelete(chat: string, page: string, title: string): PageRequest {
    const request: PageRequest = { page, chat, name: agentName(chat), title, at: new Date().toISOString() };
    this.live.doc.transact(() => this.requests.set(`${page}|${chat}`, request), this.live.system);
    this.onChange?.();
    return request;
  }

  requestsFor(page: string): PageRequest[] {
    return [...this.requests.values()].filter((r) => r.page === page);
  }

  dropRequests(page: string, chat?: string): PageRequest[] {
    const gone = this.requestsFor(page).filter((r) => !chat || r.chat === chat);
    if (gone.length) {
      this.live.doc.transact(() => {
        for (const r of gone) this.requests.delete(`${r.page}|${r.chat}`);
      }, this.live.system);
      this.onChange?.();
    }
    return gone;
  }

  // ---------- the turn's end ----------

  /**
   * The chat's turn ended (or was cancelled, or its connection went): it stops showing, its claim goes, the user's take-backs are
   * forgotten, and its refused edits still undone become notes, sent to the page. Returns the new notes.
   */
  turnEnded(chat: string): RefusedNote[] {
    this.#absent(chat);
    this.release(chat, 'turn');
    this.#taken.delete(chat);
    const notes = this.#refused.get(chat) ?? [];
    this.#refused.delete(chat);
    if (notes.length) {
      this.notes.push(...notes);
      if (this.notes.length > 50) this.notes.splice(0, this.notes.length - 50);
      this.live.sendControl({ type: 'refused', chat, name: agentName(chat), notes });
      this.onChange?.();
    }
    return notes;
  }

  /** Chats with anything running here (presence, a claim, refusals waiting for the turn's end). */
  active(): string[] {
    return [...new Set([...this.#presence.keys(), ...this.claims.keys(), ...[...this.#refused.keys()]])];
  }

  /** What the page and info show. */
  state(): Json {
    return {
      claims: [...this.claims.values()],
      requests: [...this.requests.values()],
      notes: this.notes,
      presence: this.presence(),
    };
  }

  destroy(): void {
    for (const chat of [...this.#presence.keys()]) this.#absent(chat);
  }
}
