/**
 * Markdown in and out for local docs, in the shared schema's terms (schema.ts), as ProseMirror JSON.
 *
 * In:  CommonMark + GFM blocks (headings ATX/setext, paragraphs, fenced and indented code, quotes, bullet/ordered/task lists nested,
 *      tables with alignment, rules) and inlines (emphasis by CommonMark's delimiter rules, code spans, links, images, linked images,
 *      autolinks, hard breaks, escapes). Front matter, raw HTML blocks and link definitions become `rawBlock`s, inline HTML tags
 *      `htmlInline`s: kept verbatim. CRLF and LF both read; soft line breaks stay in the text.
 * Out: one block at a time (serializeBlock), each checked by parsing it back; a block that would not come back the same is written
 *      again with more escaping.
 * Rich:  callouts, columns, toggles, text colour, highlight, alignment and merged cells (schema.ts) have no Markdown. Their Markdown is
 *      a readable fallback (richOf: lossy): a callout is a quote starting **Note:** / **Warning:** / **Done:**, columns one after the
 *      other, a toggle its line in bold then its body, colours and alignment dropped, a merged cell's value repeated in each cell, a
 *      chart its picture (![title](assets/<chart>.chart.svg "caption"), drawn by charts.ts) then its numbers as a table. That picture
 *      line followed by a table reads back as the chart (bar, its type is not in the Markdown).
 * The file: parseDoc keeps every top-level block's original text (and a list's items', a table's rows'), the blank lines between
 *      them and the line ending. writeDoc writes a doc back reusing the original text of every block whose content is unchanged
 *      (same `sig`), so an untouched file comes out byte for byte and an edit rewrites only the blocks it changed.
 */
import { getSchema } from '@tiptap/core';
import { AGENT_MARK, docExtensions } from './schema.ts';

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMJson[];
  text?: string;
  marks?: PMMark[];
}
/** How the original was written, so a rewritten block keeps its look (bullet char, fence, loose list, setext...). */
export type Style = Record<string, string | boolean>;

export const schema = getSchema(docExtensions());

export const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'pending']);
export const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);
export const ITEMS = new Set(['listItem', 'taskItem']);
const CELLS = new Set(['tableCell', 'tableHeader']);
const RICH_NODES = new Set(['callout', 'columns', 'column', 'toggle', 'chart']);
const RICH_MARKS = new Set(['textColor', 'highlight', 'underline']);
export const CALLOUT_LABELS: Record<string, string> = { info: 'Note', warning: 'Warning', success: 'Done' };

const span = (v: unknown) => Math.max(1, Math.floor(Number(v)) || 1);

/**
 * Does this node hold anything Markdown can't (a callout, columns, a toggle, colour, highlight or underline, alignment, merged cells, a header
 * column, a table without a header row, a table cell aligned apart from its column)? A plain table (header row, column alignment
 * at most) is not rich. Its Markdown is then only a readable fallback: a file edit to it is not taken in.
 */
export function richOf(node: PMJson): boolean {
  if (RICH_NODES.has(node.type)) return true;
  if ((node.type === 'paragraph' || node.type === 'heading') && node.attrs?.align) return true;
  if (node.marks?.some((m) => RICH_MARKS.has(m.type))) return true;
  if (CELLS.has(node.type) && (span(node.attrs?.colspan) > 1 || span(node.attrs?.rowspan) > 1)) return true;
  if (node.type === 'table') {
    const rows = node.content ?? [];
    if ((rows[0]?.content ?? []).some((c) => c.type !== 'tableHeader')) return true;
    if (rows.slice(1).some((r) => (r.content ?? []).some((c) => c.type === 'tableHeader'))) return true;
    // Markdown aligns whole columns (from the header row): a plain table is not rich, a cell aligned on its own is
    const heads = (rows[0]?.content ?? []).map((c) => c.attrs?.align ?? null);
    if (rows.slice(1).some((r) => (r.content ?? []).some((c, k) => (c.attrs?.align ?? null) !== (heads[k] ?? null)))) return true;
  }
  return (node.content ?? []).some(richOf);
}

/** Where a table cell sits: its row and its index in that row. */
export interface CellAt {
  r: number;
  i: number;
}

/**
 * A table's grid: grid[row][col] is the cell covering that square (merged cells cover several), null where no cell does. `start`
 * gives each cell's top-left square ("r,i" -> [row, col]).
 */
export function tableGrid(table: PMJson): { grid: (CellAt | null)[][]; cols: number; start: Map<string, [number, number]> } {
  const rows = table.content ?? [];
  const grid: (CellAt | null)[][] = rows.map(() => []);
  const start = new Map<string, [number, number]>();
  rows.forEach((row, r) => {
    let c = 0;
    (row.content ?? []).forEach((cell, i) => {
      while (grid[r][c]) c++;
      start.set(`${r},${i}`, [r, c]);
      const cs = span(cell.attrs?.colspan), rs = span(cell.attrs?.rowspan);
      for (let dr = 0; dr < rs && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = { r, i };
      }
      c += cs;
    });
  });
  const cols = Math.max(0, ...grid.map((g) => g.length));
  for (const g of grid) for (let c = 0; c < cols; c++) g[c] ??= null;
  return { grid, cols, start };
}

/** Does any cell of the table span more than one square? */
export function hasSpans(table: PMJson): boolean {
  return (table.content ?? []).some((r) => (r.content ?? []).some((c) => span(c.attrs?.colspan) > 1 || span(c.attrs?.rowspan) > 1));
}

/** The table with every merged cell split, its value repeated in each square (the Markdown fallback). */
export function expandTable(table: PMJson): PMJson {
  const { grid } = tableGrid(table);
  const rows = table.content ?? [];
  return {
    ...table,
    content: grid.map((g, r) => ({
      ...rows[r],
      content: g.map((at) => {
        if (!at) return { type: r === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph' }] };
        const cell = rows[at.r].content![at.i];
        return { ...cell, attrs: { ...(cell.attrs ?? {}), colspan: 1, rowspan: 1, colwidth: null } };
      }),
    })),
  };
}

const ALERTS: Record<string, string> = {
  NOTE: 'info',
  INFO: 'info',
  TIP: 'info',
  WARNING: 'warning',
  CAUTION: 'warning',
  IMPORTANT: 'warning',
  SUCCESS: 'success',
  DONE: 'success',
};
const ALERT = /^\[!([A-Za-z]+)\][ \t]*\n?/;

/**
 * For agents' Markdown: a quote that starts with a GitHub alert line ("> [!NOTE]", "[!WARNING]", "[!SUCCESS]"; TIP, CAUTION,
 * IMPORTANT, DONE too) becomes a callout. The .md copies never use this (their callouts are plain quotes), so it is only for input.
 */
export function alertsToCallouts(nodes: PMJson[]): PMJson[] {
  return nodes.map((n) => {
    const content = n.content ? alertsToCallouts(n.content) : undefined;
    const first = content?.[0];
    const text = first?.type === 'paragraph' ? first.content?.[0] : undefined;
    const m = n.type === 'blockquote' && text?.type === 'text' && !text.marks?.length ? ALERT.exec(text.text ?? '') : null;
    const variant = m ? ALERTS[m[1].toUpperCase()] : undefined;
    if (!m || !variant) return content ? { ...n, content } : n;
    const rest = (text!.text ?? '').slice(m[0].length);
    const inline = [...(rest ? [{ ...text!, text: rest }] : []), ...(first!.content ?? []).slice(1)];
    while (inline[0]?.type === 'hardBreak') inline.shift();
    const kids = [...(inline.length ? [{ ...first!, content: inline }] : []), ...content!.slice(1)];
    return { type: 'callout', attrs: { variant }, content: kids.length ? kids : [{ type: 'paragraph' }] };
  });
}

// =====================================================================================================================================
// Normalising and signatures
// =====================================================================================================================================

/** The node without agent marks, without marks on inline atoms, and as ProseMirror builds it (defaults filled, texts merged). */
export function normalize(json: PMJson): PMJson {
  const strip = (n: PMJson): PMJson => {
    const out: PMJson = { type: n.type };
    if (n.attrs) out.attrs = n.attrs;
    if (n.type === 'text') {
      out.text = n.text;
      const marks = (n.marks ?? []).filter((m) => m.type !== AGENT_MARK);
      if (marks.length) out.marks = marks;
    }
    if (n.content) out.content = n.content.map(strip);
    return out;
  };
  return schema.nodeFromJSON(strip(json)).toJSON() as PMJson;
}

export function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The content signature: equal when the Markdown of two blocks would be the same (agent marks don't count). */
export function sigOf(json: PMJson): string {
  return hash8(JSON.stringify(normalize(json)));
}

// =====================================================================================================================================
// Lines
// =====================================================================================================================================

const isBlank = (l: string) => /^[ \t]*$/.test(l);

/** Columns of leading white space (a tab goes to the next multiple of 4). */
function indentOf(l: string): number {
  let col = 0;
  for (const c of l) {
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Remove up to `n` columns of leading white space (a tab that crosses the line is split into spaces). */
function stripCols(l: string, n: number): string {
  let col = 0, i = 0;
  while (i < l.length && col < n) {
    if (l[i] === ' ') col++, i++;
    else if (l[i] === '\t') {
      const w = 4 - (col % 4);
      if (col + w > n) return ' '.repeat(col + w - n) + l.slice(i + 1);
      col += w;
      i++;
    } else break;
  }
  return l.slice(i);
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const BULLET = /^( {0,3})([-+*])([ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const LINKDEF = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*\S/;
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML6 = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:[ \\t>]|/>|$)`, 'i');
const ATTR = `(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?)`;
const OPEN_TAG = `<[A-Za-z][A-Za-z0-9-]*${ATTR}*\\s*/?>`;
const CLOSE_TAG = `</[A-Za-z][A-Za-z0-9-]*\\s*>`;
const HTML7 = new RegExp(`^ {0,3}(?:${OPEN_TAG}|${CLOSE_TAG})[ \\t]*$`);
const PENDING = /^<!--\s*aib:pending:\s?([\s\S]*?)\s*-->$/;

/** The CommonMark HTML block kind a line starts (1-7), or 0. */
function htmlStart(l: string): number {
  if (/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(l)) return 1;
  if (/^ {0,3}<!--/.test(l)) return 2;
  if (/^ {0,3}<\?/.test(l)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(l)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(l)) return 5;
  if (HTML6.test(l)) return 6;
  if (HTML7.test(l)) return 7;
  return 0;
}
const HTML_END: Record<number, RegExp> = { 1: /<\/(?:script|pre|style|textarea)>/i, 2: /-->/, 3: /\?>/, 4: />/, 5: /\]\]>/ };

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur);
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}
const DELIM_CELL = /^:?-+:?$/;
function delimRow(line: string): (string | null)[] | null {
  if (
    !line.includes('-') || (!line.includes('|') && !/^\s*:?-+:?\s*$/.test(line))
  ) return null;
  const cells = splitRow(line);
  if (!cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((
    c,
  ) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}
function tableStart(lines: string[], i: number): (string | null)[] | null {
  if (
    i + 1 >= lines.length || !lines[i].includes('|') || indentOf(lines[i]) >= 4
  ) return null;
  const aligns = delimRow(lines[i + 1]);
  return aligns && aligns.length === splitRow(lines[i]).length ? aligns : null;
}

// =====================================================================================================================================
// Blocks in
// =====================================================================================================================================

interface Parsed {
  node: PMJson;
  /** Line range in the lines given to parseBlocks (end exclusive). */
  start: number;
  end: number;
  style?: Style;
  /** A list's items or a table's rows, with their line ranges in the same lines. */
  kids?: { start: number; end: number }[];
}

const para = (content: PMJson[]): PMJson => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

/**
 * A drawing's picture next to the Markdown copies: assets/<drawing id>.excalidraw.svg (server/docs/drawing/assets.ts). A doc from
 * before pages had <name>.assets/<drawing id>.excalidraw.svg (LEGACY_DRAWING_SRC); it is moved from there.
 */
export const DRAWING_SRC = /^(?:\.\/)?(?:[^/\\<>]+\.)?assets\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.excalidraw\.svg$/;
export const LEGACY_DRAWING_SRC = /^(?:\.\/)?([^/\\<>]+)\.assets\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.excalidraw\.svg$/;

/** A chart's picture next to the Markdown copies (server/docs/charts.ts draws it). */
export const CHART_SRC = /^(?:\.\/)?assets\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.chart\.svg$/;

export function chartSrc(chart: string): string {
  return `assets/${chart}.chart.svg`;
}

/** A paragraph that is just a chart's picture: the chart's id, title and caption; else null. */
function chartPicture(p: PMJson): { chart: string; title: string; caption: string } | null {
  if (p.type !== 'paragraph') return null;
  const img = p.content?.length === 1 ? p.content[0] : null;
  const a = img?.type === 'image' ? img.attrs ?? {} : null;
  const m = a && !a.href && !img!.marks?.length ? CHART_SRC.exec(String(a.src ?? '')) : null;
  return m ? { chart: m[1], title: String(a!.alt ?? ''), caption: String(a!.title ?? '') } : null;
}

/** A chart's picture line right before a table: the two are the chart (its numbers are the table). */
function joinCharts(out: Parsed[]): Parsed[] {
  for (let k = out.length - 2; k >= 0; k--) {
    const pic = chartPicture(out[k].node);
    const table = out[k + 1].node;
    if (!pic || table.type !== 'table') continue;
    out.splice(k, 2, {
      node: { type: 'chart', attrs: { chart: pic.chart, chartType: 'bar', title: pic.title, caption: pic.caption }, content: [table] },
      start: out[k].start,
      end: out[k + 1].end,
    });
  }
  return out;
}

/** A paragraph that is just a drawing's picture (no title, no link) is the drawing block. */
function drawingOf(p: PMJson): PMJson {
  const img = p.content?.length === 1 ? p.content[0] : null;
  const a = img?.type === 'image' ? img.attrs ?? {} : null;
  const m = a && !a.href && !a.title && !img!.marks?.length ? DRAWING_SRC.exec(String(a.src ?? '')) : null;
  return m ? { type: 'drawing', attrs: { drawing: m[1], caption: String(a!.alt ?? ''), src: String(a!.src) } } : p;
}

/** Can `l` end a paragraph (start another block)? */
function interrupts(lines: string[], i: number): boolean {
  const l = lines[i];
  if (
    isBlank(l) || FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l)
  ) return true;
  const h = htmlStart(l);
  if (h >= 1 && h <= 6) return true;
  const b = BULLET.exec(l);
  if (b && b[3]) return true;
  const o = ORDERED.exec(l);
  if (o && o[4] && o[2] === '1') return true;
  return !!tableStart(lines, i);
}

function parseBlocks(lines: string[], top = false): Parsed[] {
  const out: Parsed[] = [];
  const n = lines.length;
  let i = 0;
  if (top && n > 1 && /^---[ \t]*$/.test(lines[0])) {
    for (let j = 1; j < n; j++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j])) {
        out.push({
          node: { type: 'rawBlock', attrs: { kind: 'frontmatter', text: lines.slice(0, j + 1).join('\n') } },
          start: 0,
          end: j + 1,
        });
        i = j + 1;
        break;
      }
    }
  }
  while (i < n) {
    const l = lines[i];
    if (isBlank(l)) {
      i++;
      continue;
    }
    const start = i;
    let m: RegExpExecArray | null;
    if (indentOf(l) >= 4) {
      const body: string[] = [];
      let last = i;
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
        if (!isBlank(lines[i])) last = i;
        body.push(stripCols(lines[i], 4));
        i++;
      }
      i = last + 1;
      const text = body.slice(0, last - start + 1).join('\n');
      out.push({
        node: { type: 'codeBlock', ...(text ? { content: [{ type: 'text', text }] } : {}) },
        start,
        end: i,
        style: { indented: true },
      });
    } else if (
      (m = FENCE.exec(l)) && !(m[2][0] === '`' && m[3].includes('`'))
    ) {
      const pad = m[1].length, fence = m[2], info = m[3].trim();
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < n) {
        if (close.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        body.push(stripCols(lines[i], pad));
        i++;
      }
      const text = body.join('\n');
      out.push({
        node: { type: 'codeBlock', attrs: { language: info || null }, ...(text ? { content: [{ type: 'text', text }] } : {}) },
        start,
        end: i,
        style: { fence, ...(closed ? {} : { unclosed: true }) },
      });
    } else if ((m = ATX.exec(l))) {
      let text = m[2].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) text = '';
      else text = text.replace(/[ \t]+#+$/, '');
      out.push({ node: { type: 'heading', attrs: { level: m[1].length }, content: parseInline(text) }, start, end: ++i });
    } else if (HR.test(l)) {
      out.push({ node: { type: 'horizontalRule' }, start, end: ++i, style: { rule: l.trim() } });
    } else if (QUOTE.test(l)) {
      const inner: string[] = [];
      while (i < n) {
        if (QUOTE.test(lines[i])) {
          const rest = lines[i].replace(/^ {0,3}>/, '');
          inner.push(rest.startsWith(' ') ? rest.slice(1) : rest.startsWith('\t') ? stripCols(rest, 1) : rest);
        } else if (
          !isBlank(lines[i]) && inner.length && !isBlank(inner[inner.length - 1]) && !interrupts(lines, i)
        ) {
          inner.push(lines[i]); // lazy continuation of a quoted paragraph
        } else break;
        i++;
      }
      const kids = parseBlocks(inner).map((p) => p.node);
      out.push({ node: { type: 'blockquote', content: kids.length ? kids : [para([])] }, start, end: i });
    } else if (BULLET.test(l) || ORDERED.test(l)) {
      const list = parseList(lines, i);
      out.push(list);
      i = list.end;
    } else if (
      (m = /^ {0,3}(<!--[\s\S]*?-->)[ \t]*$/.exec(l)) && PENDING.test(m[1])
    ) {
      const intent = PENDING.exec(m[1])![1];
      i++;
      const body: string[] = [];
      while (i < n && !isBlank(lines[i]) && !interrupts(lines, i)) {
        body.push(lines[i++].replace(/^[ \t]+/, ''));
      }
      out.push({ node: { type: 'pending', attrs: { intent }, content: parseInline(body.join('\n')) }, start, end: i });
    } else if (htmlStart(l)) {
      const kind = htmlStart(l);
      if (kind <= 5) {
        while (i < n && !HTML_END[kind].test(lines[i])) i++;
        i = Math.min(i + 1, n);
      } else {
        while (i < n && !isBlank(lines[i])) i++;
      }
      out.push({ node: { type: 'rawBlock', attrs: { kind: 'html', text: lines.slice(start, i).join('\n') } }, start, end: i });
    } else if (tableStart(lines, i)) {
      const aligns = tableStart(lines, i)!;
      const cols = aligns.length;
      const rowNode = (line: string, header: boolean): PMJson => {
        const cells = splitRow(line);
        while (cells.length < cols) cells.push('');
        return {
          type: 'tableRow',
          content: cells.slice(0, cols).map((c, k) => ({
            type: header ? 'tableHeader' : 'tableCell',
            attrs: { align: aligns[k] },
            content: [para(parseInline(c.replace(/\\\|/g, '|')))],
          })),
        };
      };
      const rows = [rowNode(lines[i], true)];
      const kids = [{ start: i, end: i + 1 }];
      i += 2;
      while (
        i < n && !isBlank(lines[i]) && !(interrupts(lines, i) && !lines[i].includes('|'))
      ) {
        rows.push(rowNode(lines[i], false));
        kids.push({ start: i, end: i + 1 });
        i++;
      }
      out.push({ node: { type: 'table', content: rows }, start, end: i, kids, style: { delim: lines[start + 1] } });
    } else if (LINKDEF.test(l)) {
      while (i < n && LINKDEF.test(lines[i])) i++;
      out.push({ node: { type: 'rawBlock', attrs: { kind: 'linkdef', text: lines.slice(start, i).join('\n') } }, start, end: i });
    } else {
      const body: string[] = [l];
      i++;
      let heading = 0;
      while (i < n) {
        const s = SETEXT.exec(lines[i]);
        if (s) {
          heading = s[1][0] === '=' ? 1 : 2;
          i++;
          break;
        }
        if (
          interrupts(lines, i) || (BULLET.test(lines[i]) && /^ {0,3}[-+*][ \t]*$/.test(lines[i]) === false && false)
        ) break;
        body.push(lines[i++]);
      }
      const text = body.map((b) => b.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
      if (heading) {
        out.push({
          node: { type: 'heading', attrs: { level: heading }, content: parseInline(text) },
          start,
          end: i,
          style: { setext: true },
        });
      } else out.push({ node: drawingOf(para(parseInline(text))), start, end: i });
    }
  }
  return joinCharts(out);
}

const TASK = /^\[([ xX])\](?:[ \t]+|$)/;

function parseList(lines: string[], i: number): Parsed {
  const n = lines.length;
  const first = BULLET.exec(lines[i]);
  const ordered = !first;
  const om = ORDERED.exec(lines[i]);
  const bulletChar = first ? first[2] : '';
  const delim = om ? om[3] : '';
  const startNo = om ? Number(om[2]) : 1;
  const start = i;
  const items: { lines: string[]; start: number; end: number }[] = [];
  let loose = false;
  let numbers = '';
  for (;;) {
    const bm = BULLET.exec(lines[i]), nm = ORDERED.exec(lines[i]);
    const m = ordered ? nm : bm;
    if (!m || (ordered ? nm![3] !== delim : bm![2] !== bulletChar)) break;
    if (!ordered && HR.test(lines[i])) break;
    const markerEnd = ordered ? nm![1].length + nm![2].length + 1 : bm![1].length + 1;
    const gap = ordered ? nm![4] : bm![3];
    const gapCols = indentOf(gap);
    const col = gap === '' || gapCols >= 5 ? markerEnd + 1 : markerEnd + gapCols;
    if (ordered) numbers += nm![2] + ',';
    const body = [gap === '' ? '' : gapCols >= 5 ? stripCols(lines[i].slice(markerEnd), 1) : lines[i].slice(markerEnd + gap.length)];
    const itemStart = i;
    let last = i;
    i++;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) {
        body.push('');
        i++;
        continue;
      }
      if (indentOf(l) >= col) {
        body.push(stripCols(l, col));
        last = i++;
        continue;
      }
      if (BULLET.test(l) || ORDERED.test(l)) break; // a list item at this level ends the item (never a lazy line)
      if (
        !isBlank(lines[i - 1]) && !interrupts(lines, i) && !tableStart(lines, i)
      ) {
        // lazy paragraph continuation (only after a paragraph line)
        const prev = body[body.length - 1];
        if (prev && !FENCE.test(prev) && indentOf(prev) < 4) {
          body.push(l.replace(/^[ \t]+/, ''));
          last = i++;
          continue;
        }
      }
      break;
    }
    const kept = body.slice(0, last - itemStart + 1);
    if (
      kept.slice(0, -1).some((b, k) => isBlank(b) && k > 0 && !isBlank(kept[k + 1] ?? 'x'))
    ) {
      // a blank line between two blocks of the item makes the list loose (inside fenced code it does not, but rarely matters)
      const blocks = parseBlocks(kept);
      if (blocks.length > 1) loose = true;
    }
    items.push({ lines: kept, start: itemStart, end: last + 1 });
    i = last + 1;
    let k = i;
    while (k < n && isBlank(lines[k])) k++;
    if (k >= n) break;
    const nb = BULLET.exec(lines[k]), nn = ORDERED.exec(lines[k]);
    const same = ordered ? !!nn && nn[3] === delim : !!nb && nb[2] === bulletChar && !HR.test(lines[k]);
    if (!same || indentOf(lines[k]) > 3) break;
    if (k > i) loose = true;
    i = k;
  }
  const tasks = !ordered && items.every((it) => TASK.test(it.lines[0]));
  const itemNodes = items.map((it) => {
    let body = it.lines;
    let checked = false;
    if (tasks) {
      const t = TASK.exec(body[0])!;
      checked = t[1] !== ' ';
      body = [body[0].slice(t[0].length), ...body.slice(1)];
    }
    let kids = parseBlocks(body).map((p) => p.node);
    if (!kids.length || kids[0].type !== 'paragraph') kids = [para([]), ...kids];
    return tasks ? { type: 'taskItem', attrs: { checked }, content: kids } : { type: 'listItem', content: kids };
  });
  const type = tasks ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
  const nums = numbers.split(',').filter(Boolean).map(Number);
  const style: Style = { loose };
  if (ordered) {
    style.delim = delim;
    if (nums.length > 1 && nums.every((x) => x === nums[0])) style.sameNumber = true;
  } else style.bullet = bulletChar;
  const end = items[items.length - 1].end;
  return {
    node: { type, ...(ordered && startNo !== 1 ? { attrs: { start: startNo } } : {}), content: itemNodes },
    start,
    end,
    style,
    kids: items.map((it) => ({ start: it.start, end: it.end })),
  };
}

// =====================================================================================================================================
// Inlines in
// =====================================================================================================================================

type INode =
  | { k: 'text'; text: string }
  | { k: 'code'; text: string }
  | { k: 'html'; html: string }
  | { k: 'br' }
  | { k: 'img'; src: string; alt: string; title: string | null }
  | { k: 'link'; href: string; title: string | null; kids: INode[] }
  | { k: 'em' | 'strong' | 'del'; kids: INode[] }
  | { k: 'delim'; ch: string; count: number; orig: number; open: boolean; close: boolean }
  | { k: 'bracket'; image: boolean; active: boolean };

const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const isWS = (c: string) => c === '' || /\s/.test(c);
const AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const EMAIL =
  /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;
const INLINE_HTML = new RegExp(
  `^(?:${OPEN_TAG}|${CLOSE_TAG}|<!--[\\s\\S]*?-->|<\\?[\\s\\S]*?\\?>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`,
);

/** `(dest "title")` after a `]` at `at`: the link's parts and where it ends, or null. */
function linkTail(
  s: string,
  at: number,
): { href: string; title: string | null; end: number } | null {
  if (s[at] !== '(') return null;
  let i = at + 1;
  while (i < s.length && /[ \t\n]/.test(s[i])) i++;
  let href = '';
  if (s[i] === '<') {
    const close = s.indexOf('>', i);
    if (close < 0 || s.slice(i + 1, close).includes('\n')) return null;
    href = s.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const from = i;
    while (i < s.length && !/[\s]/.test(s[i])) {
      if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) {
        i += 2;
        continue;
      }
      if (s[i] === '(') depth++;
      if (s[i] === ')') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    href = s.slice(from, i).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  let title: string | null = null;
  const ws = i;
  while (i < s.length && /[ \t\n]/.test(s[i])) i++;
  if (i > ws && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const closeCh = s[i] === '(' ? ')' : s[i];
    const close = s.indexOf(closeCh, i + 1);
    if (close < 0) return null;
    title = s.slice(i + 1, close).replace(/\\([!-/:-@[-`{-~])/g, '$1');
    i = close + 1;
    while (i < s.length && /[ \t\n]/.test(s[i])) i++;
  }
  if (s[i] !== ')') return null;
  return { href, title, end: i + 1 };
}

export function parseInline(src: string): PMJson[] {
  const nodes: INode[] = [];
  const brackets: number[] = [];
  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ k: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1] ?? '';
      if (nx === '\n') {
        flush();
        nodes.push({ k: 'br' });
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
      } else if (nx && ASCII_PUNCT.test(nx)) {
        buf += nx;
        i += 2;
      } else {
        buf += c;
        i++;
      }
    } else if (c === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let j = i + run, found = -1;
      while ((j = src.indexOf(fence, j)) >= 0) {
        if (src[j + run] !== '`' && src[j - 1] !== '`') {
          found = j;
          break;
        }
        while (src[j] === '`') j++;
      }
      if (found < 0) {
        buf += fence;
        i += run;
      } else {
        flush();
        let text = src.slice(i + run, found).replace(/\n/g, ' ');
        if (
          text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim()
        ) text = text.slice(1, -1);
        nodes.push({ k: 'code', text });
        i = found + run;
      }
    } else if (c === '<') {
      const rest = src.slice(i);
      const auto = AUTOLINK.exec(rest);
      const mail = auto ? null : EMAIL.exec(rest);
      const h = !auto && !mail && INLINE_HTML.exec(rest);
      if (auto || mail) {
        flush();
        const a = (auto ?? mail)!;
        nodes.push({ k: 'link', href: auto ? a[1] : 'mailto:' + a[1], title: null, kids: [{ k: 'text', text: a[1] }] });
        i += a[0].length;
      } else if (h) {
        flush();
        nodes.push({ k: 'html', html: h[0] });
        i += h[0].length;
      } else {
        buf += c;
        i++;
      }
    } else if (c === '!' && src[i + 1] === '[') {
      flush();
      brackets.push(nodes.length);
      nodes.push({ k: 'bracket', image: true, active: true });
      i += 2;
    } else if (c === '[') {
      flush();
      brackets.push(nodes.length);
      nodes.push({ k: 'bracket', image: false, active: true });
      i++;
    } else if (c === ']') {
      flush();
      const at = brackets.pop();
      const opener = at === undefined ? null : nodes[at] as INode & { k: 'bracket' };
      const tail = opener && opener.active ? linkTail(src, i + 1) : null;
      if (!opener || !tail) {
        if (opener) nodes[at!] = { k: 'text', text: opener.image ? '![' : '[' };
        buf += ']';
        i++;
        continue;
      }
      const inner = nodes.splice(at! + 1);
      nodes.pop();
      processEmphasis(inner);
      if (opener.image) {
        nodes.push({ k: 'img', src: tail.href, alt: plainOf(inner), title: tail.title });
      } else {
        nodes.push({ k: 'link', href: tail.href, title: tail.title, kids: inner });
        for (const b of brackets) {
          const br = nodes[b] as INode;
          if (br.k === 'bracket' && !br.image) br.active = false;
        }
      }
      i = tail.end;
    } else if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (src[i + run] === c) run++;
      const before = i > 0 ? src[i - 1] : '', after = src[i + run] ?? '';
      const left = !isWS(after) && (!PUNCT.test(after) || isWS(before) || PUNCT.test(before));
      const right = !isWS(before) && (!PUNCT.test(before) || isWS(after) || PUNCT.test(after));
      flush();
      if (c === '~' && run > 2) {
        nodes.push({ k: 'text', text: '~'.repeat(run) });
      } else {
        const open = c === '_' ? left && (!right || PUNCT.test(before)) : left;
        const close = c === '_' ? right && (!left || PUNCT.test(after)) : right;
        nodes.push({ k: 'delim', ch: c, count: run, orig: run, open, close });
      }
      i += run;
    } else if (c === '\n') {
      const m = /( *)$/.exec(buf)!;
      if (m[1].length >= 2) {
        buf = buf.slice(0, -m[1].length);
        flush();
        nodes.push({ k: 'br' });
      } else buf = buf.replace(/[ \t]+$/, '') + '\n';
      i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  for (let k = 0; k < nodes.length; k++) {
    const b = nodes[k];
    if (b.k === 'bracket') nodes[k] = { k: 'text', text: b.image ? '![' : '[' };
  }
  processEmphasis(nodes);
  const out: PMJson[] = [];
  emitInline(nodes, [], out);
  return mergeTexts(out);
}

function plainOf(nodes: INode[]): string {
  return nodes.map((n) =>
    n.k === 'text' || n.k === 'code'
      ? n.text
      : n.k === 'delim'
      ? n.ch.repeat(n.count)
      : 'kids' in n
      ? plainOf(n.kids)
      : n.k === 'img'
      ? n.alt
      : ''
  ).join('');
}

/** CommonMark's "process emphasis" over a flat list (in place). */
function processEmphasis(list: INode[]): void {
  for (let ci = 0; ci < list.length; ci++) {
    const closer = list[ci];
    if (closer.k !== 'delim' || !closer.close) continue;
    let oi = ci - 1;
    for (; oi >= 0; oi--) {
      const op = list[oi];
      if (op.k !== 'delim' || op.ch !== closer.ch || !op.open) continue;
      if (op.ch === '~') {
        if (op.count !== closer.count) continue;
      } else if (
        (op.close || closer.open) && (op.orig + closer.orig) % 3 === 0 && !(op.orig % 3 === 0 && closer.orig % 3 === 0)
      ) continue;
      break;
    }
    if (oi < 0) continue;
    const op = list[oi] as INode & { k: 'delim' };
    const use = op.ch === '~' ? op.count : op.count >= 2 && closer.count >= 2 ? 2 : 1;
    const kids = list.slice(oi + 1, ci);
    const node: INode = { k: op.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em', kids };
    op.count -= use;
    closer.count -= use;
    const repl: INode[] = [];
    if (op.count > 0) repl.push(op);
    repl.push(node);
    if (closer.count > 0) repl.push(closer);
    list.splice(oi, ci - oi + 1, ...repl);
    ci = oi + (op.count > 0 ? 1 : 0) + (closer.count > 0 ? 0 : 0);
    if (closer.count > 0) ci--; // look at the same closer again
  }
  for (let k = 0; k < list.length; k++) {
    const d = list[k];
    if (d.k === 'delim') list[k] = { k: 'text', text: d.ch.repeat(d.count) };
  }
}

function emitInline(nodes: INode[], marks: PMMark[], out: PMJson[]): void {
  const withMarks = (n: PMJson): PMJson => (marks.length ? { ...n, marks: [...marks] } : n);
  for (const n of nodes) {
    switch (n.k) {
      case 'text':
        if (n.text) out.push(withMarks({ type: 'text', text: n.text }));
        break;
      case 'code':
        if (n.text) out.push({ type: 'text', text: n.text, marks: [...marks, { type: 'code' }] });
        break;
      case 'html':
        out.push({ type: 'htmlInline', attrs: { html: n.html } });
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'img':
        out.push({ type: 'image', attrs: { src: n.src, alt: n.alt || null, title: n.title } });
        break;
      case 'link': {
        const kids = n.kids.filter((x) => !(x.k === 'text' && !x.text));
        if (kids.length === 1 && kids[0].k === 'img' && !marks.length) {
          const img = kids[0];
          out.push({ type: 'image', attrs: { src: img.src, alt: img.alt || null, title: img.title, href: n.href } });
          break;
        }
        emitInline(n.kids, [...marks, { type: 'link', attrs: { href: n.href, title: n.title } }], out);
        break;
      }
      case 'em':
        emitInline(n.kids, [...marks, { type: 'italic' }], out);
        break;
      case 'strong':
        emitInline(n.kids, [...marks, { type: 'bold' }], out);
        break;
      case 'del':
        emitInline(n.kids, [...marks, { type: 'strike' }], out);
        break;
      default:
        break;
    }
  }
}

function mergeTexts(nodes: PMJson[]): PMJson[] {
  const out: PMJson[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (
      n.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])
    ) {
      out[out.length - 1] = { ...last, text: last.text! + n.text! };
    } else out.push(n);
  }
  return out;
}

// =====================================================================================================================================
// Out
// =====================================================================================================================================

const MARK_ORDER = ['link', 'strike', 'bold', 'italic', 'code'];
const markKey = (m: PMMark) => m.type + (m.type === 'link' ? JSON.stringify([m.attrs?.href ?? null, m.attrs?.title ?? null]) : '');

function mdMarks(n: PMJson): PMMark[] {
  return (n.marks ?? []).filter((m) => MARK_ORDER.includes(m.type)).sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

function escapeText(text: string, level: number, inTable: boolean): string {
  let s = text.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\');
  if (level >= 1) s = s.replace(/[`*_[\]<~]/g, '\\$&');
  if (level >= 2) {
    s = s.replace(
      /^([ \t]*)([#>+-]|\d+[.)])(?=[ \t]|$)/gm,
      (_m, ws, mk) => ws + mk.replace(/^(\d+)([.)])$/, '$1\\$2').replace(/^([#>+-])$/, '\\$1'),
    );
    s = s.replace(/[!&|]/g, '\\$&');
  }
  if (inTable) s = s.replace(/(?<!\\)\|/g, '\\|');
  return s;
}

function destination(href: string): string {
  if (!href || /[\s<>]/.test(href) || /[()]/.test(href) && !balanced(href)) return '<' + href.replace(/[<>]/g, (c) => '\\' + c) + '>';
  return href;
}
function balanced(s: string): boolean {
  let d = 0;
  for (const c of s) {
    if (c === '(') d++;
    if (c === ')' && --d < 0) return false;
  }
  return d === 0;
}
const titlePart = (t: unknown) => (typeof t === 'string' && t ? ` "${t.replace(/"/g, '\\"')}"` : '');

function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const n = Math.max(0, ...runs.map((r) => r.length)) + 1;
  const fence = '`'.repeat(n === 1 ? 1 : n);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim()) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

interface InlineOpts {
  level: number;
  table?: boolean;
  style?: Style;
}

export function serializeInline(
  content: PMJson[] | undefined,
  opts: InlineOpts,
): string {
  const nodes = mergeTexts((content ?? []).map((n) => (n.type === 'text' ? { ...n, marks: mdMarks(n) } : n)));
  let out = '';
  const active: PMMark[] = [];
  const em = opts.style?.em === '_' ? '_' : '*';
  const strong = opts.style?.strong === '__' ? '__' : '**';
  const open = (
    m: PMMark,
  ): string => (m.type === 'link' ? '[' : m.type === 'bold' ? strong : m.type === 'italic' ? em : m.type === 'strike' ? '~~' : '');
  const close = (m: PMMark): string =>
    m.type === 'link'
      ? `](${destination(String(m.attrs?.href ?? ''))}${titlePart(m.attrs?.title)})`
      : m.type === 'bold'
      ? strong
      : m.type === 'italic'
      ? em
      : m.type === 'strike'
      ? '~~'
      : '';
  const closeTo = (keep: number) => {
    while (active.length > keep) {
      const m = active.pop()!;
      const ws = m.type === 'link' ? '' : /[ \t\n]*$/.exec(out)![0];
      out = out.slice(0, out.length - ws.length) + close(m) + ws;
    }
  };
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (
      n.type === 'text' && !(n.marks ?? []).some((m) => m.type === 'code') && !n.text!.trim() && active.length
    ) {
      // white space between marked runs: keep the marks open around it
      const next = nodes[k + 1];
      const nextMarks = next?.type === 'text' ? (next.marks ?? []).filter((m) => m.type !== 'code') : [];
      const common = active.every((a, x) => nextMarks[x] && markKey(nextMarks[x]) === markKey(a));
      if (common) {
        out += escapeText(n.text!, opts.level, !!opts.table);
        continue;
      }
    }
    // an inline atom (HTML tag, image, break) holds no marks in the doc: keep open the marks the next text goes on with
    const after = n.type === 'text' ? n : nodes.slice(k + 1).find((x) => x.type === 'text');
    const marks = n.type === 'text' || after ? (after?.marks ?? []).filter((m) => m.type !== 'code') : [];
    if (n.type !== 'text') marks.splice(active.length);
    let same = 0;
    while (
      same < active.length && same < marks.length && markKey(active[same]) === markKey(marks[same])
    ) same++;
    closeTo(same);
    if (n.type === 'text') {
      let text = n.text!;
      const isCode = (n.marks ?? []).some((m) => m.type === 'code');
      // an autolink: a link whose text is its address
      const link = marks[same];
      if (link?.type === 'link' && same === marks.length - 1 && !isCode) {
        const href = String(link.attrs?.href ?? '');
        const next = nodes[k + 1];
        const nextSameLink = next?.type === 'text' && (next.marks ?? []).some((m) => m.type === 'link' && markKey(m) === markKey(link));
        if (
          !nextSameLink && !link.attrs?.title && (href === text || href === 'mailto:' + text) && AUTOLINK.test('<' + href + '>')
        ) {
          out += '<' + text + '>';
          continue;
        }
      }
      if (same < marks.length) {
        const lead = /^[ \t]*/.exec(text)![0];
        out += lead;
        text = text.slice(lead.length);
        for (const m of marks.slice(same)) {
          out += open(m);
          active.push(m);
        }
      }
      out += isCode ? codeSpan(opts.table ? text.replace(/\|/g, '\\|') : text) : escapeText(text, opts.level, !!opts.table);
    } else if (n.type === 'hardBreak') {
      out += opts.style?.br === 'spaces' ? '  \n' : '\\\n';
    } else if (n.type === 'image') {
      const a = n.attrs ?? {};
      const img = `![${escapeText(String(a.alt ?? ''), Math.max(opts.level, 1), !!opts.table)}](${destination(String(a.src ?? ''))}${
        titlePart(a.title)
      })`;
      out += a.href ? `[${img}](${destination(String(a.href))})` : img;
    } else if (n.type === 'htmlInline') out += String(n.attrs?.html ?? '');
  }
  closeTo(0);
  return out;
}

function indentLines(text: string, pad: string, firstPad = ''): string {
  return text.split('\n').map((l, i) => (i === 0 ? firstPad + l : l ? pad + l : l)).join('\n');
}

/** The inline style of a paragraph's original Markdown: which emphasis and break characters it used. */
export function inlineStyleOf(raw: string): Style {
  const s: Style = {};
  if (/(^|[^\\_\w])__\S/.test(raw) && !/\*\*\S/.test(raw)) s.strong = '__';
  if (/(^|[^\\_\w])_[^\s_]/.test(raw) && !/(^|[^*\\])\*[^\s*]/.test(raw)) s.em = '_';
  if (/ {2}\r?\n/.test(raw)) s.br = 'spaces';
  return s;
}

/** One block (any node of the schema except inline ones) as Markdown, with '\n' line ends. */
export function serializeBlock(
  node: PMJson,
  style: Style = {},
  level = 0,
): string {
  const a = node.attrs ?? {};
  const inline = (n: PMJson, table = false) => serializeInline(n.content, { level, table, style });
  switch (node.type) {
    case 'paragraph':
      return inline(node);
    case 'heading': {
      const text = inline(node).replace(/\n/g, ' ');
      const lvl = Math.min(6, Math.max(1, Number(a.level) || 1));
      if (style.setext && lvl <= 2 && text) return text + '\n' + (lvl === 1 ? '===' : '---');
      return '#'.repeat(lvl) + (text ? ' ' + text : '');
    }
    case 'pending': {
      const text = inline(node);
      return `<!-- aib:pending: ${String(a.intent ?? '').replace(/-->/g, '-- >')} -->` + (text ? '\n' + text : '');
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((t) => t.text ?? '').join('');
      if (style.indented && text && !a.language) return indentLines(text, '    ', '    ');
      let fence = typeof style.fence === 'string' ? style.fence : '```';
      const ch = fence[0];
      const longest = Math.max(0, ...(text.match(new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}+`, 'gm')) ?? []).map((r) => r.trim().length));
      if (longest >= fence.length) fence = ch.repeat(longest + 1);
      return fence + (a.language ? String(a.language) : '') + '\n' + (text ? text + '\n' : '') + fence;
    }
    case 'horizontalRule':
      return typeof style.rule === 'string' ? style.rule : '---';
    case 'rawBlock':
      return String(a.text ?? '');
    case 'drawing':
      return serializeInline([{ type: 'image', attrs: { src: a.src, alt: a.caption || null, title: null } }], { level, style });
    case 'chart': {
      // its picture, then its numbers as a plain table
      const pic = serializeInline([{
        type: 'image',
        attrs: { src: chartSrc(String(a.chart ?? '')), alt: String(a.title ?? '') || 'Chart', title: String(a.caption ?? '') || null },
      }], { level, style });
      const table = node.content?.[0];
      return table ? pic + '\n\n' + serializeTable(table, {}, level).join('\n') : pic;
    }
    case 'blockquote':
      return serializeChildren(node.content ?? [], {}, level).split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
    case 'callout': {
      // a quote starting with its label: > **Warning:** words
      const label = `**${CALLOUT_LABELS[String(a.variant)] ?? 'Note'}:**`;
      const kids = node.content ?? [];
      const body = kids[0]?.type === 'paragraph'
        ? (label + ' ' + serializeChildren(kids, {}, level)).replace(/^([^\n]*?)[ \t]+(?=\n|$)/, '$1')
        : label + (kids.length ? '\n\n' + serializeChildren(kids, {}, level) : '');
      return body.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
    }
    case 'toggle': {
      // its line in bold, then what it opens
      const [line, ...body] = node.content ?? [];
      const text = line?.content?.length ? inline(line).replace(/\n/g, ' ').trim() : '';
      const head = text ? `**${text}**` : '';
      const rest = serializeChildren(body, {}, level);
      return head && rest ? head + '\n\n' + rest : head || rest;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (node.content ?? []).map((item, i) => serializeItem(node, item, i, style, level)).join(style.loose ? '\n\n' : '\n');
    case 'listItem':
    case 'taskItem':
      return serializeItem({ type: node.type === 'taskItem' ? 'taskList' : 'bulletList' }, node, 0, style, level);
    case 'table':
      return serializeTable(node, style, level).join('\n');
    case 'tableRow':
      return serializeRow(node, level);
    case 'tableCell':
    case 'tableHeader':
      return (node.content ?? []).map((p) => inline(p, true)).join(' ');
    case 'image':
    case 'hardBreak':
    case 'htmlInline':
    case 'text':
      return serializeInline([node], { level, style });
    default:
      return serializeChildren(node.content ?? [], {}, level);
  }
}

function serializeChildren(
  nodes: PMJson[],
  style: Style,
  level: number,
  tight = false,
): string {
  let out = '';
  nodes.forEach((n, i) => {
    if (i) out += tight && LISTS.has(n.type) ? '\n' : '\n\n';
    out += serializeBlock(n, i === 0 ? style : {}, level);
  });
  return out;
}

export function listMarker(list: PMJson, index: number, style: Style): string {
  if (list.type === 'orderedList') {
    const start = Number(list.attrs?.start ?? 1);
    return `${style.sameNumber ? start : start + index}${typeof style.delim === 'string' ? style.delim : '.'} `;
  }
  return `${typeof style.bullet === 'string' ? style.bullet : '-'} `;
}

function serializeItem(
  list: PMJson,
  item: PMJson,
  index: number,
  style: Style,
  level: number,
): string {
  const marker = listMarker(list, index, style);
  const box = item.type === 'taskItem' ? (item.attrs?.checked ? '[x] ' : '[ ] ') : '';
  const kids = item.content ?? [];
  const firstEmpty = kids[0]?.type === 'paragraph' && !kids[0].content?.length;
  const body = firstEmpty && kids.length > 1
    ? '\n' + serializeChildren(kids.slice(1), {}, level, !style.loose)
    : serializeChildren(kids, {}, level, !style.loose);
  const pad = ' '.repeat(marker.length);
  return indentLines((marker + box + body).replace(/[ \t]+$/, ''), pad);
}

function serializeRow(row: PMJson, level: number): string {
  return '| ' + (row.content ?? []).map((c) => serializeBlock(c, {}, level).replace(/\n/g, ' ')).join(' | ') + ' |';
}

function delimFor(table: PMJson): string {
  const first = table.content?.[0]?.content ?? [];
  return '| ' + first.map((c) => {
    const al = c.attrs?.align;
    return al === 'center' ? ':---:' : al === 'right' ? '---:' : al === 'left' ? ':---' : '---';
  }).join(' | ') + ' |';
}

function serializeTable(node: PMJson, _style: Style, level: number): string[] {
  const table = hasSpans(node) ? expandTable(node) : node;
  const rows = (table.content ?? []).map((r) => serializeRow(r, level));
  return [rows[0] ?? '|  |', delimFor(table), ...rows.slice(1)];
}

/** Parse a block's Markdown back (for checks): the nodes it gives. */
export function parseBlockMarkdown(md: string): PMJson[] {
  return parseBlocks(md.replace(/\r\n?/g, '\n').split('\n'), true).map((p) => p.node);
}

/**
 * A block's Markdown that parses back to the same block: the plainest escaping that round-trips, else the most escaped one (and
 * `lossy`). Blocks inside a list item or a table cell are checked as part of their top-level block.
 */
export function blockMarkdown(
  node: PMJson,
  style: Style = {},
): { md: string; lossy: boolean } {
  if (richOf(node)) return { md: serializeBlock(node, style, 0), lossy: true };
  const want = JSON.stringify(normalize(node));
  let first = '';
  for (const level of [0, 1, 2]) {
    const md = serializeBlock(node, style, level);
    if (level === 0) first = md;
    const back = parseBlockMarkdown(md);
    if (back.length === 1 && sameNode(back[0], want)) return { md, lossy: false };
  }
  return { md: first, lossy: true };
}

function sameNode(node: PMJson, want: string): boolean {
  try {
    return JSON.stringify(normalize(node)) === want;
  } catch {
    return false;
  }
}

/** A node's Markdown in the context of its parent: an item gets its marker, a cell its text, anything else serializeBlock. */
export function fragmentMarkdown(node: PMJson): string {
  return serializeBlock(node);
}

// =====================================================================================================================================
// The whole file: original text kept per block
// =====================================================================================================================================

export interface ParsedBlock {
  node: PMJson;
  raw: string;
  /** The text between the previous block (or the start of the file) and this one. */
  gap: string;
  style?: Style;
  /** A list's items or a table's rows: their original text and the text before each. */
  kids?: { raw: string; gap: string }[];
}
export interface ParsedDoc {
  blocks: ParsedBlock[];
  /** The text after the last block. */
  tail: string;
  eol: string;
}

export function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function parseDoc(text: string): ParsedDoc {
  const eol = detectEol(text);
  const lines: string[] = [], starts: number[] = [], ends: number[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index === text.length && !m[0]) break;
    lines.push(m[1]);
    starts.push(m.index);
    ends.push(m.index + m[1].length);
    if (!m[2]) break;
  }
  const parsed = parseBlocks(lines, true);
  const blocks: ParsedBlock[] = [];
  let at = 0;
  for (const p of parsed) {
    const from = starts[p.start], to = ends[p.end - 1];
    const style = {
      ...(p.style ?? {}),
      ...(p.node.type === 'paragraph' || p.node.type === 'heading' ? inlineStyleOf(text.slice(from, to)) : {}),
    };
    const block: ParsedBlock = { node: p.node, raw: text.slice(from, to), gap: text.slice(at, from) };
    if (Object.keys(style).length) block.style = style;
    if (p.kids) {
      let kat = from;
      block.kids = p.kids.map((k) => {
        const kf = starts[k.start], kt = ends[k.end - 1];
        const kid = { raw: text.slice(kf, kt), gap: text.slice(kat, kf) };
        kat = kt;
        return kid;
      });
    }
    blocks.push(block);
    at = to;
  }
  return { blocks, tail: text.slice(at), eol };
}

/** What the mirror remembers per block id: the text written for it, the text before it, its content signature and style. */
export interface Src {
  raw: string;
  gap: string;
  sig: string;
  style?: Style;
}
export type SrcMap = Record<string, Src>;

/** A top-level block of the live doc as the writer sees it: its id, its node, and its direct children's ids (lists, tables). */
export interface DocBlock {
  id: string;
  node: PMJson;
  kidIds?: string[];
  /** sigOf(node), when the caller has it cached. */
  sig?: string;
}

export interface Written {
  text: string;
  map: SrcMap;
  /** Blocks written fresh (not their old text): ids. */
  rewritten: string[];
  /** Blocks whose Markdown does not parse back exactly (rare constructs). */
  lossy: string[];
}

/** Write the doc's Markdown: the old text of every unchanged block (and list item, table row), fresh Markdown for the rest. */
export function writeDoc(
  blocks: DocBlock[],
  map: SrcMap,
  tail: string,
  eol: string,
): Written {
  const out: string[] = [];
  const next: SrcMap = {};
  const rewritten: string[] = [], lossy: string[] = [];
  const fresh = (s: string) => (eol === '\n' ? s : s.replace(/\n/g, eol));
  blocks.forEach((b, index) => {
    const src = map[b.id];
    const sig = b.sig ?? sigOf(b.node);
    const gap = src?.gap ?? (index === 0 ? '' : eol + eol);
    let raw: string;
    if (src && src.sig === sig) raw = src.raw;
    else {
      raw = writeContainer(b, src, map, next, eol) ?? (() => {
        const r = blockMarkdown(b.node, src?.style ?? {});
        if (r.lossy) lossy.push(b.id);
        return fresh(r.md);
      })();
      rewritten.push(b.id);
    }
    if (richOf(b.node) && !lossy.includes(b.id)) lossy.push(b.id);
    out.push(index === 0 && gap === '' ? raw : gap + raw);
    next[b.id] = { raw, gap, sig, ...(src?.style ? { style: src.style } : {}) };
    if (src && src.sig === sig && b.kidIds) { for (const kid of b.kidIds) if (map[kid]) next[kid] = map[kid]; }
  });
  return { text: out.join('') + (blocks.length ? tail : ''), map: next, rewritten, lossy };
}

/**
 * A changed list or table whose items/rows are known: unchanged ones keep their text, changed ones are written fresh. Returns null
 * when the block is not such a container (or nothing of it is known).
 */
function writeContainer(
  b: DocBlock,
  src: Src | undefined,
  map: SrcMap,
  next: SrcMap,
  eol: string,
): string | null {
  if (
    !b.kidIds || !src || !b.node.content || b.kidIds.length !== b.node.content.length || richOf(b.node)
  ) return null;
  const known = b.kidIds.filter((id) => map[id]);
  if (!known.length) return null;
  const style = src.style ?? {};
  const fresh = (s: string) => (eol === '\n' ? s : s.replace(/\n/g, eol));
  const kids = b.node.content;
  if (LISTS.has(b.node.type)) {
    const parts: string[] = [];
    const sep = style.loose ? eol + eol : eol;
    kids.forEach((item, i) => {
      const id = b.kidIds![i];
      const old = map[id];
      const sig = sigOf(item);
      let raw: string;
      if (old && old.sig === sig) {
        raw = old.raw;
        if (b.node.type === 'orderedList' && !style.sameNumber) {
          const want = Number(b.node.attrs?.start ?? 1) + i;
          raw = raw.replace(/^( {0,3})(\d{1,9})(?=[.)])/, (_m, ws, num) => (Number(num) === want ? ws + num : ws + String(want)));
        }
      } else raw = fresh(serializeItem(b.node, item, i, style, 0));
      const gap = i === 0 ? '' : old?.gap ?? sep;
      parts.push(gap + raw);
      next[id] = { raw, gap, sig };
    });
    return parts.join('');
  }
  if (b.node.type === 'table') {
    const lines: string[] = [];
    const delimNow = delimFor(b.node);
    const cols = kids[0]?.content?.length ?? 0;
    kids.forEach((row, i) => {
      const id = b.kidIds![i];
      const old = map[id];
      const sig = sigOf(row);
      const raw = old && old.sig === sig && splitRow(old.raw).length === cols ? old.raw : fresh(serializeRow(row, 0));
      lines.push(raw);
      next[id] = { raw, gap: '', sig };
      if (i === 0) {
        const oldDelim = typeof style.delim === 'string' ? style.delim : null;
        const aligns = oldDelim ? delimRow(oldDelim) : null;
        const nowAligns = (kids[0]?.content ?? []).map((c) => c.attrs?.align ?? null);
        lines.push(aligns && JSON.stringify(aligns) === JSON.stringify(nowAligns) ? oldDelim! : delimNow);
      }
    });
    return lines.join(eol);
  }
  return null;
}

/**
 * Bind a parsed file to the doc's blocks: blocks (and items, rows) whose content matches keep the file's text in the map. Used when a
 * doc is made from a file and after a file-tool edit was taken in, so the file's own spelling of every unchanged block survives.
 */
export function adopt(parsed: ParsedDoc, blocks: DocBlock[]): SrcMap {
  const map: SrcMap = {};
  const fileSigs = parsed.blocks.map((p) => safeSig(p.node));
  const docSigs = blocks.map((b) => sigOf(b.node));
  const pairs = lcsPairs(fileSigs, docSigs);
  const take = (p: ParsedBlock, b: DocBlock, sig: string) => {
    map[b.id] = { raw: p.raw, gap: p.gap, sig, ...(p.style ? { style: p.style } : {}) };
    if (p.kids && b.kidIds && p.node.content && b.node.content) {
      const fk = p.node.content.map((k) => safeSig(k)),
        dk = b.node.content.map((k) => sigOf(k));
      for (const [x, y] of lcsPairs(fk, dk)) {
        map[b.kidIds[y]] = { raw: p.kids[x].raw, gap: p.kids[x].gap, sig: dk[y] };
      }
    }
  };
  let pf = 0, pd = 0;
  for (
    const [x, y] of [...pairs, [parsed.blocks.length, blocks.length] as [number, number]]
  ) {
    // between matches: blocks of the same type, side by side, keep their spelling of the parts that match (items, rows), not the block
    for (let k = 0; pf + k < x && pd + k < y; k++) {
      const p = parsed.blocks[pf + k], b = blocks[pd + k];
      if (p.node.type === b.node.type) take(p, b, '');
    }
    if (x < parsed.blocks.length) take(parsed.blocks[x], blocks[y], docSigs[y]);
    pf = x + 1;
    pd = y + 1;
  }
  return map;
}

function safeSig(node: PMJson): string {
  try {
    return sigOf(node);
  } catch {
    return 'invalid:' + Math.random();
  }
}

/** Longest common subsequence of two lists of strings, as index pairs. */
export function lcsPairs(a: string[], b: string[]): [number, number][] {
  // trim the common ends first (the usual case: one change in a long doc)
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (
    e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]
  ) e++;
  const ma = a.slice(s, a.length - e), mb = b.slice(s, b.length - e);
  const pairs: [number, number][] = [];
  for (let k = 0; k < s; k++) pairs.push([k, k]);
  const n = ma.length, m = mb.length;
  if (n && m && n * m <= 4_000_000) {
    const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i][j] = ma[i] === mb[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) pairs.push([s + i++, s + j++]);
      else if (t[i + 1][j] >= t[i][j + 1]) i++;
      else j++;
    }
  }
  for (let k = e; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

export { CELLS, splitRow };
