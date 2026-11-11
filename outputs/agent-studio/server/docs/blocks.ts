/**
 * The block model of a local doc, over the Y.XmlFragment that y-prosemirror binds the editor to. Each top-level Y.XmlElement is a
 * block; its id is the Yjs id of the element (`<client>.<clock>`), so it never changes while the block lives. This file is the only
 * place that knows the editor's node names (TipTap StarterKit: paragraph, heading, codeBlock, blockquote, bulletList, orderedList,
 * listItem, horizontalRule, hardBreak; marks bold, italic, strike, code, plus AIB's agentEdit). Another editor (BlockNote) would get
 * its own version of this file; the live doc, the store and the tools only use the functions exported here.
 *
 * Also here: Markdown to blocks and back (the mirror and the agent's `as: "markdown"` sources), the block hash, and the minimal
 * word-level diff that turns a re-wording into small character edits.
 */
import * as Y from './vendor/yjs.js';

export type Attrs = Record<string, unknown>;
export interface InlineRun {
  insert: string;
  attributes?: Attrs;
}
/** A block as plain data: a textblock has `inline`, a container has `children`. */
export interface BlockSpec {
  type: string;
  attrs?: Attrs;
  inline?: InlineRun[];
  children?: BlockSpec[];
}

export const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);
/** The mark the server puts on text an agent (or a file tool) wrote. Not part of the Markdown. */
export const AGENT_MARK = 'agentEdit';

// ---------- ids and hashes ----------

export function idOf(type: Y.AbstractType): string {
  const id = type._item!.id;
  return `${id.client}.${id.clock}`;
}

/** 8-hex FNV-1a of the block's Markdown: its letters, marks, type and level. */
export function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- Y <-> spec ----------

export function elementToSpec(el: Y.XmlElement): BlockSpec {
  const attrs = el.getAttributes();
  const spec: BlockSpec = { type: el.nodeName, ...(Object.keys(attrs).length ? { attrs } : {}) };
  if (TEXTBLOCKS.has(el.nodeName)) {
    spec.inline = [];
    for (const child of el.toArray()) {
      if (child instanceof Y.XmlText) spec.inline.push(...(child.toDelta().filter((d) => typeof d.insert === 'string') as InlineRun[]));
      else spec.inline.push({ insert: '\n' }); // hardBreak
    }
  } else {
    spec.children = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement).map(elementToSpec);
  }
  return spec;
}

/** A new (not yet inserted) element for a spec; `extra` attributes go on all its text (the agent mark). */
export function specToElement(spec: BlockSpec, extra: Attrs | null = null): Y.XmlElement {
  const el = new Y.XmlElement(spec.type);
  for (const [k, v] of Object.entries(spec.attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  if (TEXTBLOCKS.has(spec.type)) {
    const runs = (spec.inline ?? []).filter((r) => r.insert.length);
    if (runs.length) {
      const text = new Y.XmlText();
      text.applyDelta(runs.map((r) => ({ insert: r.insert, attributes: { ...(r.attributes ?? {}), ...(extra ?? {}) } })));
      el.insert(0, [text]);
    }
  } else if (spec.children?.length) {
    el.insert(0, spec.children.map((c) => specToElement(c, extra)));
  }
  return el;
}

export function blockText(spec: BlockSpec): string {
  if (spec.inline) return spec.inline.map((r) => r.insert).join('');
  return (spec.children ?? []).map(blockText).join('\n');
}

// ---------- Markdown out ----------

const MD_MARKS: [string, string][] = [['bold', '**'], ['italic', '*'], ['strike', '~~']];

function inlineToMarkdown(runs: InlineRun[]): string {
  // Merge neighbours with the same Markdown marks (the agent mark does not show in Markdown).
  const merged: { text: string; key: string; attrs: Attrs }[] = [];
  for (const r of runs) {
    const attrs = { ...(r.attributes ?? {}) };
    delete attrs[AGENT_MARK];
    const key = Object.keys(attrs).sort().join(',');
    const last = merged[merged.length - 1];
    if (last && last.key === key) last.text += r.insert;
    else merged.push({ text: r.insert, key, attrs });
  }
  return merged.map(({ text, attrs }) => {
    if (attrs.code) return '`' + text + '`';
    const lead = /^\s*/.exec(text)![0], trail = /\s*$/.exec(text.slice(lead.length))![0];
    let core = text.slice(lead.length, text.length - trail.length);
    if (!core) return text;
    for (const [mark, fence] of MD_MARKS) if (attrs[mark]) core = fence + core + fence;
    return lead + core + trail;
  }).join('');
}

function indent(text: string, pad: string): string {
  return text.split('\n').map((line, i) => (i === 0 || !line ? line : pad + line)).join('\n');
}

export function specToMarkdown(spec: BlockSpec): string {
  const a = spec.attrs ?? {};
  switch (spec.type) {
    case 'heading':
      return '#'.repeat(Math.min(6, Math.max(1, Number(a.level) || 1))) + ' ' + inlineToMarkdown(spec.inline ?? []);
    case 'codeBlock':
      return '```' + (typeof a.language === 'string' ? a.language : '') + '\n' + blockText(spec) + '\n```';
    case 'horizontalRule':
      return '---';
    case 'blockquote':
      return (spec.children ?? []).map(specToMarkdown).join('\n\n').split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
    case 'bulletList':
    case 'orderedList': {
      const start = Number(a.start) || 1;
      return (spec.children ?? []).map((item, i) => {
        const marker = spec.type === 'bulletList' ? '- ' : `${start + i}. `;
        const body = (item.children ?? []).map(specToMarkdown).join('\n\n');
        return marker + indent(body, ' '.repeat(marker.length));
      }).join('\n');
    }
    case 'paragraph':
      return inlineToMarkdown(spec.inline ?? []);
    default:
      return spec.inline ? inlineToMarkdown(spec.inline) : (spec.children ?? []).map(specToMarkdown).join('\n\n');
  }
}

// ---------- Markdown in ----------

const INLINE = /\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)(?<!\s)\*|_(?!\s)(.+?)(?<!\s)_|~~(.+?)~~|`([^`]+)`/g;

export function parseInline(text: string, marks: Attrs = {}): InlineRun[] {
  const out: InlineRun[] = [];
  const push = (insert: string, attrs: Attrs) => {
    if (!insert) return;
    out.push(Object.keys(attrs).length ? { insert, attributes: attrs } : { insert });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(at, m.index), marks);
    if (m[6] !== undefined) push(m[6], { ...marks, code: {} });
    else {
      const [inner, mark] = m[1] ?? m[2] ? [m[1] ?? m[2], 'bold'] : m[3] ?? m[4] ? [m[3] ?? m[4], 'italic'] : [m[5], 'strike'];
      out.push(...parseInline(inner, { ...marks, [mark]: {} }));
    }
    at = m.index! + m[0].length;
  }
  push(text.slice(at), marks);
  return out;
}

const FENCE = /^(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^([-*+])\s+/;
const ORDERED = /^(\d{1,9})[.)]\s+/;
const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || line.startsWith('>') || BULLET.test(line) || ORDERED.test(line);

function parseLines(lines: string[]): BlockSpec[] {
  const out: BlockSpec[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = FENCE.exec(line))) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(m[1])) body.push(lines[i++]);
      i++;
      const text = body.join('\n');
      out.push({ type: 'codeBlock', ...(m[2] ? { attrs: { language: m[2] } } : {}), inline: text ? [{ insert: text }] : [] });
    } else if ((m = HEADING.exec(line))) {
      out.push({ type: 'heading', attrs: { level: m[1].length }, inline: parseInline(m[2].trim()) });
      i++;
    } else if (RULE.test(line)) {
      out.push({ type: 'horizontalRule' });
      i++;
    } else if (line.startsWith('>')) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) inner.push(lines[i++].replace(/^>\s?/, ''));
      out.push({ type: 'blockquote', children: orEmpty(parseLines(inner)) });
    } else if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? ORDERED : BULLET;
      const items: BlockSpec[] = [];
      const start = ordered ? Number(ORDERED.exec(line)![1]) : 1;
      while (i < lines.length && (m = re.exec(lines[i]))) {
        const pad = m[0].length;
        const body = [lines[i].slice(pad)];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (next.startsWith(' '.repeat(pad)) || (next.startsWith('  ') && next.trim())) {
            body.push(next.replace(new RegExp(`^ {1,${pad}}`), ''));
          } else if (!next.trim() && i + 1 < lines.length && lines[i + 1].startsWith('  ')) body.push('');
          else break;
          i++;
        }
        items.push({ type: 'listItem', children: orEmpty(parseLines(body)) });
      }
      out.push({ type: ordered ? 'orderedList' : 'bulletList', ...(ordered && start !== 1 ? { attrs: { start } } : {}), children: items });
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++]);
      out.push({ type: 'paragraph', inline: parseInline(para.join('\n')) });
    }
  }
  return out;
}

function orEmpty(blocks: BlockSpec[]): BlockSpec[] {
  return blocks.length ? blocks : [{ type: 'paragraph', inline: [] }];
}

export function parseMarkdown(md: string): BlockSpec[] {
  return parseLines(md.replace(/\r\n?/g, '\n').split('\n'));
}

export function docToMarkdown(specs: BlockSpec[]): string {
  return specs.map(specToMarkdown).join('\n\n') + '\n';
}

// ---------- text runs and character edits ----------

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
    runs.push({ node, start: at, length });
    at += length;
  }
  return runs;
}

export function textOf(el: Y.XmlElement): string {
  return blockText(elementToSpec(el));
}

function attrsAt(text: Y.XmlText, offset: number): Attrs {
  let at = 0;
  for (const d of text.toDelta()) {
    const n = typeof d.insert === 'string' ? d.insert.length : 1;
    if (offset < at + n) return { ...(d.attributes ?? {}) };
    at += n;
  }
  return {};
}

/**
 * Apply edits (old-text positions, any order, not overlapping) to a textblock. Inserted text keeps the formatting of the character
 * before it (else after it), with `extra` (the agent mark) added; the user's text around it is left alone.
 */
export function applyTextEdits(el: Y.XmlElement, edits: TextEdit[], extra: Attrs | null): void {
  const runs = runsOf(el);
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    if (edit.del > 0) {
      const end = edit.at + edit.del;
      for (let r = runs.length - 1; r >= 0; r--) {
        const run = runs[r];
        const from = Math.max(edit.at, run.start), to = Math.min(end, run.start + run.length);
        if (from >= to) continue;
        if (run.node instanceof Y.XmlText) run.node.delete(from - run.start, to - from);
        else el.delete(r, 1);
      }
    }
    if (!edit.ins) continue;
    let target: Run | undefined = edit.at > 0 ? runs.find((r) => r.start < edit.at && edit.at <= r.start + r.length) : undefined;
    let style: Attrs = {};
    if (target && target.node instanceof Y.XmlText) style = attrsAt(target.node, edit.at - 1 - target.start);
    else {
      target = runs.find((r) => r.start === edit.at && r.node instanceof Y.XmlText);
      if (target) style = attrsAt(target.node as Y.XmlText, 0);
    }
    delete style[AGENT_MARK];
    const attributes = { ...style, ...(extra ?? {}) };
    if (target && target.node instanceof Y.XmlText) {
      const offset = target.start < edit.at ? edit.at - target.start : 0;
      target.node.insert(offset, edit.ins, attributes);
    } else {
      const text = new Y.XmlText();
      text.applyDelta([{ insert: edit.ins, attributes }]);
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
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ta = a.slice(pre, a.length - suf).match(TOKEN) ?? [], tb = b.slice(pre, b.length - suf).match(TOKEN) ?? [];
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
