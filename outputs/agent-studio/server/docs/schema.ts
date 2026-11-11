/**
 * The one schema of a local doc, shared by AIB's Deno server (server/docs/*) and the page's editor bundle (tools/docs-vendor builds
 * vendor/docs/editor.js from this very file). Both sides bind it to the Y.Doc with @tiptap/y-tiptap, so a block the server writes is
 * the block the page shows, and the two can't drift: work/deno/docs_schema_test.ts checks the bundle's schema against this one.
 *
 * TipTap 3 extensions (MIT): StarterKit (paragraph, heading, blockquote, lists, code block, rule, hard break, bold, italic, strike,
 * code, link), tables, task lists, inline images. AIB's own:
 *   rawBlock    text kept verbatim and shown read-only: front matter, raw HTML blocks, link definitions (Markdown the editor can't hold)
 *   htmlInline  an inline raw HTML tag (<kbd>, <br>, ...), kept verbatim
 *   pending     a placeholder an agent planted ("intent"), to be filled by a later call; the user may type into it or delete it
 *   agentEdit   the mark on text an agent wrote (attribute `by`); never part of the Markdown
 *   drawing     an Excalidraw drawing: `drawing` is its id under the Y.Doc's 'drawings' map (server/docs/drawing/), `caption` its
 *               caption, `src` its picture next to the Markdown copy (<name>.assets/<id>.excalidraw.svg)
 * Changes here change both sides: rebuild the page bundle (tools/docs-vendor) in the same commit.
 */
import { type AnyExtension, Mark, mergeAttributes, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Code from '@tiptap/extension-code';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';

/** The bit of a DOM element the parse rules read (the server has no DOM types). */
interface DomEl {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

export const AGENT_MARK = 'agentEdit';
/** Bumped whenever the schema changes; the page refuses to bind to a server with another one. */
export const SCHEMA_VERSION = 2;

export const AgentEdit = Mark.create({
  name: AGENT_MARK,
  inclusive: false,
  addAttributes() {
    return {
      by: {
        default: 'agent',
        parseHTML: (el: DomEl) => el.getAttribute('data-by'),
        renderHTML: (a: Record<string, unknown>) => ({ 'data-by': a.by, title: 'Written by ' + a.by }),
      },
    };
  },
  parseHTML: () => [{ tag: 'span[data-agent-edit]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes({ 'data-agent-edit': '', class: 'agent-edit' }, HTMLAttributes), 0],
});

export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { kind: { default: 'html' }, text: { default: '' } };
  },
  parseHTML: () => [{
    tag: 'pre[data-raw-block]',
    getAttrs: (el: DomEl) => ({ kind: el.getAttribute('data-kind') || 'html', text: el.textContent ?? '' }),
  }],
  renderHTML: ({ node }) => ['pre', { 'data-raw-block': '', 'data-kind': node.attrs.kind, class: 'raw-block' }, String(node.attrs.text)],
});

export const HtmlInline = Node.create({
  name: 'htmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { html: { default: '' } };
  },
  parseHTML: () => [{ tag: 'code[data-html-inline]', getAttrs: (el: DomEl) => ({ html: el.textContent ?? '' }) }],
  renderHTML: ({ node }) => ['code', { 'data-html-inline': '', class: 'html-inline' }, String(node.attrs.html)],
});

export const Pending = Node.create({
  name: 'pending',
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return { intent: { default: '' } };
  },
  parseHTML: () => [{ tag: 'div[data-pending]', getAttrs: (el: DomEl) => ({ intent: el.getAttribute('data-intent') ?? '' }) }],
  renderHTML: ({ node }) => ['div', { 'data-pending': '', 'data-intent': node.attrs.intent, class: 'pending' }, 0],
});

/** A drawing block: the shapes live in the Y.Doc's 'drawings' map under `drawing`; the block only places it in the doc. */
export const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { drawing: { default: '' }, caption: { default: '' }, src: { default: '' } };
  },
  parseHTML: () => [{
    tag: 'figure[data-drawing]',
    getAttrs: (el: DomEl) => ({
      drawing: el.getAttribute('data-drawing') ?? '',
      caption: el.getAttribute('data-caption') ?? '',
      src: el.getAttribute('data-src') ?? '',
    }),
  }],
  renderHTML: ({ node }) => [
    'figure',
    { 'data-drawing': node.attrs.drawing, 'data-caption': node.attrs.caption, 'data-src': node.attrs.src, class: 'drawing' },
  ],
});

/** Inline image (Markdown images sit in text); `href` holds the link of a linked image ([![alt](src)](href)). */
const InlineImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), href: { default: null } };
  },
}).configure({ inline: true });

/** Code that can also be bold or a link, as Markdown allows (TipTap's code excludes every other mark). */
const CodeMark = Code.extend({ excludes: 'code' });

/** The extensions, in order. The page adds Collaboration (and its UI) on top; the server only builds the schema from them. */
export function docExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: false, // Yjs undo (per author) instead
      trailingNode: false, // would add a paragraph the user never typed
      underline: false, // Markdown has none
      code: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: true, HTMLAttributes: { target: null, rel: null, class: null } },
      dropcursor: false,
      gapcursor: false,
    }),
    CodeMark,
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    InlineImage,
    RawBlock,
    HtmlInline,
    Pending,
    Drawing,
    AgentEdit,
  ];
}

interface SchemaLike {
  nodes: Record<string, { spec: Record<string, unknown> }>;
  marks: Record<string, { spec: Record<string, unknown> }>;
}

/** A plain-data fingerprint of a schema (node and mark names, content, groups, attrs and defaults), for the page-vs-server check. */
export function schemaSummary(schema: SchemaLike): Record<string, unknown> {
  const attrs = (spec: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries((spec.attrs ?? {}) as Record<string, { default?: unknown }>).map(([k, v]) => [k, v?.default ?? null]).sort(),
    );
  const pick = (spec: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]]));
  return {
    version: SCHEMA_VERSION,
    nodes: Object.entries(schema.nodes).map(([name, t]) => ({
      name,
      ...pick(t.spec, ['content', 'group', 'inline', 'atom', 'marks', 'code', 'defining', 'isolating']),
      attrs: attrs(t.spec),
    })),
    marks: Object.entries(schema.marks).map(([name, t]) => ({
      name,
      ...pick(t.spec, ['excludes', 'inclusive', 'spanning']),
      attrs: attrs(t.spec),
    })),
  };
}
