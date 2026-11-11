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
 * Rich blocks Markdown can't hold (doc.aibdoc keeps them exactly; the .md copy gets a readable fallback, markdown.ts richOf):
 *   callout     `variant` info | warning | success; holds text, lists and code (never another callout: live_doc.ts refuses one)
 *   columns     2 or 3 `column`s side by side (each with `width`, a fraction, null = equal); only at the top of a page (group
 *               'layout', which only the doc takes), any other block inside a column
 *   toggle      its first paragraph is the line you click; the blocks after it open and close. Open or closed is per viewer, never
 *               in the doc
 *   textColor   mark, `color` by name (TEXT_COLORS); highlight: mark, `color` by name (HIGHLIGHTS: no teal or blue, the agent tints)
 *   align       left | center | right on paragraphs and headings (table cells have TipTap's own `align`); cells merge with
 *               colspan/rowspan, header row/column = tableHeader cells
 * Changes here change both sides: rebuild the page bundle (tools/docs-vendor) in the same commit.
 */
import { type AnyExtension, Extension, Mark, mergeAttributes, Node } from '@tiptap/core';
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
export const SCHEMA_VERSION = 3;

export const CALLOUT_VARIANTS = ['info', 'warning', 'success'];
export const TEXT_COLORS = ['grey', 'red', 'orange', 'green', 'blue', 'purple'];
export const HIGHLIGHTS = ['yellow', 'green', 'pink', 'purple', 'grey'];
export const ALIGNS = ['left', 'center', 'right'];
/** The blocks a callout holds. */
const CALLOUT_CONTENT = '(paragraph | heading | bulletList | orderedList | taskList | codeBlock | horizontalRule | pending)+';

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

/** The doc: blocks, plus columns (group 'layout'), which sit only at the top of a page. */
const Doc = Node.create({ name: 'doc', topNode: true, content: '(block | layout)+' });

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: CALLOUT_CONTENT,
  defining: true,
  addAttributes() {
    return { variant: { default: 'info', parseHTML: (el: DomEl) => el.getAttribute('data-variant') ?? 'info' } };
  },
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ node }) => ['div', { 'data-callout': '', 'data-variant': node.attrs.variant, class: `callout callout-${node.attrs.variant}` }, 0],
});

export const Columns = Node.create({
  name: 'columns',
  group: 'layout',
  content: 'column{2,3}',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: () => ['div', { 'data-columns': '', class: 'columns' }, 0],
});

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el: DomEl) => {
          const w = Number(el.getAttribute('data-width'));
          return w > 0 && w < 1 ? w : null;
        },
        renderHTML: (a: Record<string, unknown>) => (a.width ? { 'data-width': a.width, style: `flex: ${a.width} 1 0` } : {}),
      },
    };
  },
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-column': '', class: 'column' }, HTMLAttributes), 0],
});

/** A toggle: its first paragraph is the line, the blocks after it the body. Open/closed is the viewer's, not the doc's. */
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-toggle]' }],
  renderHTML: () => ['div', { 'data-toggle': '', class: 'toggle' }, 0],
});

const colorMark = (name: string, tag: string, names: string[], fallback: string) =>
  Mark.create({
    name,
    addAttributes() {
      return {
        color: {
          default: fallback,
          parseHTML: (el: DomEl) => {
            const c = el.getAttribute('data-color');
            return c && names.includes(c) ? c : fallback;
          },
          renderHTML: (a: Record<string, unknown>) => ({ 'data-color': a.color }),
        },
      };
    },
    parseHTML: () => [{ tag: `${tag}[data-${name}]` }],
    renderHTML: ({ HTMLAttributes }) => [tag, mergeAttributes({ [`data-${name}`]: '', class: name }, HTMLAttributes), 0],
  });

export const TextColor = colorMark('textColor', 'span', TEXT_COLORS, 'grey');
export const Highlight = colorMark('highlight', 'mark', HIGHLIGHTS, 'yellow');

/** `align` on paragraphs and headings (null = the default, left). */
export const BlockAlign = Extension.create({
  name: 'blockAlign',
  addGlobalAttributes: () => [{
    types: ['paragraph', 'heading'],
    attributes: {
      align: {
        default: null,
        parseHTML: (el: DomEl) => {
          const a = el.getAttribute('data-align');
          return a && ALIGNS.includes(a) ? a : null;
        },
        renderHTML: (a: Record<string, unknown>) => (a.align ? { 'data-align': a.align, style: `text-align: ${a.align}` } : {}),
      },
    },
  }],
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
    Doc,
    StarterKit.configure({
      document: false, // Doc: blocks and columns
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
    Callout,
    Columns,
    Column,
    Toggle,
    TextColor,
    Highlight,
    BlockAlign,
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
