/**
 * The doc's blocks in the Y.Doc, through @tiptap/y-tiptap (the binding the page's editor uses, with the same schema: schema.ts), so
 * what the server writes is exactly what the page reads and the other way round:
 *   nodeOf(el)          a Y.XmlElement as a ProseMirror node (y-tiptap's own conversion)
 *   insertNodes(...)    new blocks from ProseMirror JSON (y-tiptap's updateYFragment fills each new element)
 *   updateNode(...)     reshape an existing element to a node in place, keeping the ids of the children that stay
 *   applyTextEdits(...) small character edits in a textblock that keep the formatting around them (re-word in place)
 * Ids are Yjs item ids (`<client>.<clock>`): stable while the element lives.
 */
import * as Y from 'yjs';
import { updateYFragment, yXmlFragmentToProseMirrorFragment } from '@tiptap/y-tiptap';
import type { Node as PMNode } from 'prosemirror-model';
import { AGENT_MARK } from './schema.ts';
import { type PMJson, schema } from './markdown.ts';

export const FIELD = 'doc';
// deno-lint-ignore no-explicit-any
export type YType = Y.AbstractType<any>;
export type Attrs = Record<string, unknown>;
/** The text of a textblock as the agent sees it: a hard break is "\n", any other inline atom (image, HTML tag) U+FFFC. */
export const ATOM = '￼';

export function idOf(type: YType): string {
  const id = type._item!.id;
  return `${id.client}.${id.clock}`;
}

const meta = () => ({ mapping: new Map(), isOMark: new Map() });

/** The element as a ProseMirror node, read by y-tiptap exactly as the page reads it. */
export function nodeOf(el: Y.XmlElement): PMNode {
  const frag = yXmlFragmentToProseMirrorFragment({ toArray: () => [el] } as unknown as Y.XmlFragment, schema);
  if (frag.childCount !== 1) throw new Error(`unreadable block ${el.nodeName}`);
  return frag.firstChild!;
}

export function jsonOf(el: Y.XmlElement): PMJson {
  return nodeOf(el).toJSON() as PMJson;
}

/** Can text directly inside this node type carry marks (a code block's cannot)? */
function marksAllowed(type: string): boolean {
  return schema.nodes[type]?.spec.marks !== '';
}

/** The node with the agent's mark on all its text (not inside code blocks), for a block an agent wrote. */
export function withMark(
  json: PMJson,
  mark: Attrs | null,
  parentType = 'doc',
): PMJson {
  if (!mark) return json;
  if (json.type === 'text') {
    if (!marksAllowed(parentType)) return json;
    return { ...json, marks: [...(json.marks ?? []).filter((m) => m.type !== AGENT_MARK), { type: AGENT_MARK, attrs: mark }] };
  }
  if (!json.content) return json;
  return { ...json, content: json.content.map((c) => withMark(c, mark, json.type)) };
}

/** New elements for `nodes` at `index` of `parent`. Must run inside a transaction. Returns the new elements. */
export function insertNodes(
  doc: Y.Doc,
  parent: Y.XmlFragment,
  index: number,
  nodes: PMJson[],
): Y.XmlElement[] {
  const pm = nodes.map((n) => schema.nodeFromJSON(n));
  const els = pm.map((n) => new Y.XmlElement(n.type.name));
  parent.insert(index, els);
  els.forEach((el, k) => updateYFragment(doc, el, pm[k], meta()));
  return els;
}

/** Reshape `el` to `node` (same type) with y-tiptap's reconciliation: children that stay keep their ids. Inside a transaction. */
export function updateNode(doc: Y.Doc, el: Y.XmlElement, node: PMJson): void {
  updateYFragment(doc, el, schema.nodeFromJSON(node), meta());
}

/** The text of a textblock (see ATOM). */
export function textOf(el: Y.XmlElement): string {
  let out = '';
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) out += deltaText(child);
    else if (child instanceof Y.XmlElement) out += child.nodeName === 'hardBreak' ? '\n' : ATOM;
  }
  return out;
}

function deltaText(t: Y.XmlText): string {
  return (t.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : ATOM)).join('');
}

/** Positions (in textOf) of inline atoms: hard breaks, images, HTML tags. */
export function atomsOf(el: Y.XmlElement): number[] {
  const out: number[] = [];
  let at = 0;
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) at += child.length;
    else {
      out.push(at);
      at += 1;
    }
  }
  return out;
}

export interface TextEdit {
  /** Position in the textblock's text as it was before any edit of this batch. */
  at: number;
  del: number;
  ins: string;
}

interface Run {
  node: Y.XmlText | Y.XmlElement;
  start: number;
  length: number;
}

function runsOf(el: Y.XmlElement): Run[] {
  const runs: Run[] = [];
  let at = 0;
  for (const node of el.toArray()) {
    const length = node instanceof Y.XmlText ? node.length : 1;
    runs.push({ node: node as Y.XmlText | Y.XmlElement, start: at, length });
    at += length;
  }
  return runs;
}

function attrsAt(text: Y.XmlText, offset: number): Attrs {
  let at = 0;
  for (const d of text.toDelta() as { insert: unknown; attributes?: Attrs }[]) {
    const n = typeof d.insert === 'string' ? d.insert.length : 1;
    if (offset < at + n) return { ...(d.attributes ?? {}) };
    at += n;
  }
  return {};
}

/**
 * Apply edits (old-text positions, any order, not overlapping) to a textblock. Inserted text takes the formatting of the character
 * before it (else after it), plus `extra` (the agent's mark) where marks are allowed; the text around it is left alone.
 */
export function applyTextEdits(
  el: Y.XmlElement,
  edits: TextEdit[],
  extra: Attrs | null,
): void {
  const mark = extra && marksAllowed(el.nodeName) ? { [AGENT_MARK]: extra } : null;
  const runs = runsOf(el);
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    // a replacement takes the formatting of the first character it replaces
    let replaced: Attrs | null = null;
    if (edit.del > 0 && edit.ins) {
      const first = runs.find((r) => r.start <= edit.at && edit.at < r.start + r.length);
      if (first && first.node instanceof Y.XmlText) replaced = attrsAt(first.node, edit.at - first.start);
    }
    if (edit.del > 0) {
      const end = edit.at + edit.del;
      for (let r = runs.length - 1; r >= 0; r--) {
        const run = runs[r];
        const from = Math.max(edit.at, run.start),
          to = Math.min(end, run.start + run.length);
        if (from >= to) continue;
        if (run.node instanceof Y.XmlText) {
          run.node.delete(from - run.start, to - from);
        } else el.delete(r, 1);
      }
    }
    if (!edit.ins) continue;
    let target: Run | undefined = edit.at > 0 ? runs.find((r) => r.start < edit.at && edit.at <= r.start + r.length) : undefined;
    let style: Attrs = {};
    if (target && target.node instanceof Y.XmlText) {
      style = attrsAt(target.node, edit.at - 1 - target.start);
      // a link ends where its words end: words added right after a link do not extend it
      if (
        !replaced && 'link' in style && !('link' in attrsAt(target.node, edit.at - target.start))
      ) delete style.link;
    } else {
      target = runs.find((r) => r.start === edit.at && r.node instanceof Y.XmlText);
      if (target) style = attrsAt(target.node as Y.XmlText, 0);
    }
    if (replaced) style = replaced;
    delete style[AGENT_MARK];
    if (!marksAllowed(el.nodeName)) style = {};
    const attributes = { ...style, ...(mark ?? {}) };
    if (target && target.node instanceof Y.XmlText) {
      const offset = target.start < edit.at ? edit.at - target.start : 0;
      target.node.insert(offset, edit.ins, attributes); // exactly these marks (an empty set: plain text)
    } else {
      const text = new Y.XmlText();
      text.applyDelta([{ insert: edit.ins, ...(Object.keys(attributes).length ? { attributes } : {}) }]);
      const index = runs.findIndex((r) => r.start >= edit.at);
      el.insert(index < 0 ? el.length : index, [text]);
    }
  }
}

// ---------- word diff ----------

const TOKEN = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu;

/** The smallest set of word-level edits that turns `a` into `b` (Myers diff over words, spaces and punctuation). */
export function diffText(a: string, b: string): TextEdit[] {
  if (a === b) return [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) suf++;
  const ta = a.slice(pre, a.length - suf).match(TOKEN) ?? [],
    tb = b.slice(pre, b.length - suf).match(TOKEN) ?? [];
  const edits: TextEdit[] = [];
  let pos = pre, ia = 0, ib = 0;
  let cur: TextEdit | null = null;
  for (const step of myers(ta, tb)) {
    if (step === '=') {
      if (cur) edits.push(cur);
      cur = null;
      pos += ta[ia++].length;
      ib++;
    } else if (step === '-') {
      cur ??= { at: pos, del: 0, ins: '' };
      cur.del += ta[ia].length;
      pos += ta[ia++].length;
    } else {
      cur ??= { at: pos, del: 0, ins: '' };
      cur.ins += tb[ib++];
    }
  }
  if (cur) edits.push(cur);
  return edits;
}

/** Myers' O(ND) diff: '=' keep a token, '-' drop a token of a, '+' add a token of b. Falls back to replace-all when very different. */
function myers(a: string[], b: string[]): ('=' | '-' | '+')[] {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, 4000);
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let found = -1;
  for (let d = 0; d <= limit; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1)! : v.get(k - 1)! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v.set(k, x);
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [...a.map(() => '-' as const), ...b.map(() => '+' as const)];
  const out: ('=' | '-' | '+')[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK)!, prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push('='), x--, y--;
    if (x === prevX) out.push('+'), y--;
    else out.push('-'), x--;
  }
  while (x > 0 && y > 0) out.push('='), x--, y--;
  return out.reverse();
}

// ---------- colour and highlight ----------

/** Set (or with null, clear) marks on the characters from..to of a textblock (textOf positions), leaving the words alone. */
export function formatText(el: Y.XmlElement, from: number, to: number, marks: Record<string, Attrs | null>): void {
  for (const run of runsOf(el)) {
    if (!(run.node instanceof Y.XmlText)) continue;
    const a = Math.max(from, run.start), b = Math.min(to, run.start + run.length);
    if (a < b) run.node.format(a - run.start, b - a, marks);
  }
}

export interface StyleRun {
  from: number;
  to: number;
  color?: string;
  highlight?: string;
}

/** The coloured and highlighted stretches of a textblock (textOf positions), for an agent's read. */
export function stylesOf(el: Y.XmlElement): StyleRun[] {
  const out: StyleRun[] = [];
  let at = 0;
  for (const child of el.toArray()) {
    if (!(child instanceof Y.XmlText)) {
      at += 1;
      continue;
    }
    for (const d of child.toDelta() as { insert: unknown; attributes?: Record<string, { color?: string } | null> }[]) {
      const n = typeof d.insert === 'string' ? d.insert.length : 1;
      const color = d.attributes?.textColor?.color, highlight = d.attributes?.highlight?.color;
      if (color || highlight) {
        const last = out[out.length - 1];
        if (last && last.to === at && last.color === color && last.highlight === highlight) last.to += n;
        else out.push({ from: at, to: at + n, ...(color ? { color } : {}), ...(highlight ? { highlight } : {}) });
      }
      at += n;
    }
  }
  return out;
}
