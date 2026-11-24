/**
 * The 3-way merge of a doc.aibdoc edited on both PCs (sync between PCs, slice V5). Pure: text in, text out.
 *
 * ours = this PC's file, theirs = the other PC's, base = the version both last agreed on (null: never agreed, e.g. the same doc made
 * on both PCs). Per page, the top-level blocks are matched by their stable block id:
 *   changed on one side only      that side's version
 *   the same block changed on both  ours stays, and the other PC's version is inserted right below it, after a small line
 *                                  "from <pc>" (nothing is ever dropped)
 *   deleted on one side, edited on the other   the edit stays (an edit beats a delete)
 *   added on one side             stays, next to the block it followed
 * Page titles, the doc title, comment threads and drawings are merged the same way (by id; the same one changed on both keeps ours).
 * The result is returned only when it is a valid doc.aibdoc (parseAib and every block checked against the schema); else null.
 */
import { type AibDoc, type AibNode, type AibPage, blockKey, pageNodes, parseAib, stringifyAib, stripIds } from '../docs/aibdoc.ts';


const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const idOf = (n: AibNode) => (typeof n.id === 'string' && n.id ? n.id : `~${blockKey(stripIds(n))}`);
const keyOf = (n: AibNode | undefined) => (n ? blockKey(stripIds(n)) : null);

/**
 * The copy of the other PC's block: the same content, every id (the block's and its children's) suffixed ".copy", so both PCs name the
 * copy the same way (ids that each store made up would not match, and the next merge would copy the copies again).
 */
function copyOf(n: AibNode): AibNode {
  const walk = (x: AibNode): AibNode => {
    const out = { ...x } as AibNode & { content?: AibNode[] };
    if (typeof out.id === 'string' && out.id) out.id = `${out.id}.copy`;
    if (Array.isArray(out.content)) out.content = out.content.map((c) => walk(c as AibNode));
    return out;
  };
  return walk(n);
}

/** The line above the other PC's copy. Its id comes from the copy's, so it is the same on both PCs. */
function marker(pc: string, of: AibNode): AibNode {
  const id = typeof of.id === 'string' && of.id ? { id: `${of.id}.from` } : {};
  return { ...id, type: 'paragraph', content: [{ type: 'text', text: `from ${pc}`, marks: [{ type: 'italic' }] }] } as AibNode;
}

/** The blocks of one page, merged. `pc` is the name of the PC whose version `theirs` is. */
function mergeBlocks(base: AibNode[] | null, ours: AibNode[], theirs: AibNode[], pc: string): AibNode[] {
  const b = new Map((base ?? []).map((n) => [idOf(n), n]));
  const o = new Map(ours.map((n) => [idOf(n), n]));
  const t = new Map(theirs.map((n) => [idOf(n), n]));
  const baseIds = (base ?? []).map(idOf);
  const common = (ids: string[]) => ids.filter((id) => b.has(id));
  // the order: ours, unless only the other PC reordered the blocks both had since the base
  const oursIds = ours.map(idOf), theirsIds = theirs.map(idOf);
  const theirsMoved = base !== null && common(oursIds).join() === baseIds.filter((id) => o.has(id)).join() &&
    common(theirsIds).join() !== baseIds.filter((id) => t.has(id)).join();
  const primary = theirsMoved ? theirsIds : oursIds;
  const secondary = theirsMoved ? oursIds : theirsIds;
  const verdict = (id: string): { keep: AibNode[] } => {
    const bn = b.get(id), on = o.get(id), tn = t.get(id);
    if (on && tn) {
      if (same(keyOf(on), keyOf(tn))) return { keep: [on] };
      if (bn && same(keyOf(on), keyOf(bn))) return { keep: [tn] };
      if (bn && same(keyOf(tn), keyOf(bn))) return { keep: [on] };
      return { keep: [on, marker(pc, tn), copyOf(tn)] }; // changed on both PCs: both stay
    }
    const only = (on ?? tn)!;
    if (!bn) return { keep: [only] }; // added on one side
    // deleted on one side: it goes only when the other side did not touch it
    return same(keyOf(only), keyOf(bn)) ? { keep: [] } : { keep: [only] };
  };
  const out = new Map<string, AibNode[]>();
  const result: string[] = [];
  for (const id of primary) {
    result.push(id);
    out.set(id, verdict(id).keep);
  }
  // blocks only the other order has (added there, or kept against a delete here): after the block they followed
  let prev: string | null = null;
  for (const id of secondary) {
    if (!out.has(id)) {
      out.set(id, verdict(id).keep);
      const at: number = prev === null ? 0 : result.indexOf(prev) + 1;
      result.splice(at, 0, id);
    }
    prev = id;
  }
  return result.flatMap((id) => out.get(id) ?? []);
}

/** A 3-way merge of a scalar: the side that changed wins; both changed: ours. */
const scalar = <T>(
  base: T | undefined,
  ours: T,
  theirs: T,
): T => (same(ours, theirs) ? ours : base !== undefined && same(ours, base) ? theirs : ours);

/** Lists of things with an id (comment threads, drawings): the side that changed each one wins; one deleted on a side goes only when the other did not touch it. */
function mergeById<T extends { id: string }>(base: T[], ours: T[], theirs: T[]): T[] {
  const b = new Map(base.map((x) => [String(x.id), x]));
  const t = new Map(theirs.map((x) => [String(x.id), x]));
  const o = new Map(ours.map((x) => [String(x.id), x]));
  const out: T[] = [];
  for (const x of ours) {
    const id = String(x.id), bx = b.get(id), tx = t.get(id);
    if (!tx) {
      if (!bx || !same(x, bx)) out.push(x); // theirs deleted it: gone only when ours did not change it
      continue;
    }
    out.push(bx && same(x, bx) ? tx : x);
  }
  for (const x of theirs) {
    const id = String(x.id), bx = b.get(id);
    if (o.has(id)) continue;
    if (!bx || !same(x, bx)) out.push(x); // ours deleted it: it stays only when theirs changed it
  }
  return out;
}

/** A node without who-typed-it: no `by`, no agentEdit marks, neighbouring text with the same marks as one text node. */
function plain(n: AibNode, top = false): AibNode {
  const { by: _by, ...rest } = n as AibNode & { by?: string };
  if (!top) delete (rest as { id?: string }).id; // only a top-level block id is the doc's: the ids inside a block are each store's own
  const out = rest as AibNode & { marks?: { type?: string }[]; content?: AibNode[]; text?: string };
  if (out.marks) {
    out.marks = out.marks.filter((m) => m?.type !== 'agentEdit');
    if (!out.marks.length) delete out.marks;
  }
  if (Array.isArray(out.content)) {
    const kids: AibNode[] = [];
    for (const c of out.content.map((k) => plain(k as AibNode))) {
      const last = kids.at(-1) as (AibNode & { text?: string; marks?: unknown }) | undefined;
      const next = c as AibNode & { text?: string; marks?: unknown };
      if (last && last.type === 'text' && next.type === 'text' && same(last.marks, next.marks)) last.text = (last.text ?? '') + (next.text ?? '');
      else kids.push(c);
    }
    out.content = kids.filter((k) => !(k.type === 'text' && !(k as { text?: string }).text));
  }
  return out;
}

/** The doc.aibdoc's canonical text: the same content gives the same text on every PC whoever typed it (throws when it is not a doc). */
export function canonAib(text: string): string {
  const doc = parseAib(text);
  return stringifyAib({ ...doc, pages: doc.pages.map((p) => ({ ...p, content: p.content.map((n) => plain(n, true)) })) });
}

export function mergeAibdocs(baseText: string | null, oursText: string, theirsText: string, pc: string): string | null {
  try {
    const ours = parseAib(oursText), theirs = parseAib(theirsText);
    let base: AibDoc | null = null;
    if (baseText !== null) {
      try {
        base = parseAib(baseText);
      } catch { /* no usable base: merged as if never agreed */ }
    }
    const bp = new Map((base?.pages ?? []).map((p) => [p.id, p]));
    const op = new Map(ours.pages.map((p) => [p.id, p]));
    const tp = new Map(theirs.pages.map((p) => [p.id, p]));
    const merged = (id: string): AibPage | null => {
      const bn = bp.get(id), on = op.get(id), tn = tp.get(id);
      if (on && tn) {
        return {
          id,
          title: scalar(bn?.title, on.title, tn.title),
          content: mergeBlocks(bn ? bn.content : null, on.content, tn.content, pc),
        };
      }
      const only = (on ?? tn)!;
      if (!bn) return only; // a page added on one side
      return same(blockKeyOf(only), blockKeyOf(bn)) ? null : only; // deleted on one side: edited on the other, so it stays
    };
    const order = ours.pages.map((p) => p.id);
    const out = new Map<string, AibPage>();
    const result: string[] = [];
    for (const id of order) {
      result.push(id);
      const page = merged(id);
      if (page) out.set(id, page);
    }
    let prev: string | null = null;
    for (const p of theirs.pages) {
      if (!out.has(p.id) && !op.has(p.id)) {
        const page = merged(p.id);
        if (page) {
          out.set(p.id, page);
          result.splice(prev === null ? 0 : result.indexOf(prev) + 1, 0, p.id);
        }
      }
      if (out.has(p.id)) prev = p.id;
    }
    const doc: AibDoc = {
      format: ours.format,
      version: Math.max(ours.version, theirs.version),
      title: scalar(base?.title, ours.title, theirs.title),
      pages: result.filter((id) => out.has(id)).map((id) => out.get(id)!),
      comments: mergeById(base?.comments ?? [], ours.comments, theirs.comments),
      drawings: mergeById(base?.drawings ?? [], ours.drawings, theirs.drawings),
    };
    if (!doc.pages.length) return null;
    const text = stringifyAib(doc);
    for (const p of parseAib(text).pages) pageNodes(p); // the schema's check: a merge that does not fit is never written
    return text;
  } catch {
    return null;
  }
}

const blockKeyOf = (p: AibPage) => p.content.map((n) => keyOf(n)).join('|') + '|' + p.title;
