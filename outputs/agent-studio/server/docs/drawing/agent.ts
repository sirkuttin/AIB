/**
 * The drawing tools, server side: ../tools.ts runDocTool hands drawing_* calls here, with the doc open and its Markdown copy synced.
 * A drawing is created as a block of the doc (drawing_create: one tool rather than a doc_edit insert, so the agent never has to
 * spell the assets path), and its shapes live in the doc's Y.Doc under 'drawings' (model.ts). The user's selection, drag and text
 * editing come from the doc socket's awareness (LiveDoc.awareness), which is what the guards in tools.ts read.
 */
import { DocRefusal } from '../live_doc.ts';
import type { OpenDoc } from '../store.ts';
import { drawingBlocks, drawingSrc } from './assets.ts';
import { drawingsMap, elementsMap, readModels } from './model.ts';
import { drawing_edit, drawing_from_mermaid, drawing_read, type EditResult, type Op } from './tools.ts';

export { DRAWING_TOOL_NAMES, DRAWING_TOOLS } from './tool_defs.ts';

type Json = Record<string, unknown>;

/** Ops only the server uses (Mermaid drafts, file import): never from an agent. */
const INTERNAL_OPS = new Set(['add_raw', 'patch']);

function slug(caption: string): string {
  const s = caption.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 40).replace(/-+$/, '') || 'drawing';
}

/** A new drawing id: the caption as a file name, unique in the doc (its shapes and its blocks). */
function newDrawingId(doc: OpenDoc, caption: string): string {
  const taken = new Set([...drawingsMap(doc.live.doc).keys(), ...drawingBlocks(doc.live).map((b) => b.drawing.toLowerCase())]);
  const base = slug(caption);
  for (let n = 1;; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

function drawingOf(doc: OpenDoc, value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id && drawingsMap(doc.live.doc).has(id)) return id;
  const known = [...drawingsMap(doc.live.doc).keys()];
  throw new DocRefusal(
    'no_drawing',
    `No drawing ${JSON.stringify(id)} in doc "${doc.name}". ` +
      (known.length ? `Its drawings: ${known.join(', ')}.` : 'It has none: drawing_create makes one.'),
  );
}

function answer(res: EditResult, head: Json): [boolean, Json] {
  return res.ok ? [true, { ...head, ...res }] : [false, { ...head, ...res, code: res.error }];
}

/** Run one drawing tool. Returns [ok, payload] like runDocTool; a refusal is ok=false with a `code`. */
export async function runDrawingTool(doc: OpenDoc, agent: string, tool: string, args: Json): Promise<[boolean, Json]> {
  const live = doc.live;
  const origin = live.originFor('agent', agent);
  const head = { doc: doc.name, file: doc.mirrorPath };
  switch (tool) {
    case 'drawing_create': {
      const caption = typeof args.caption === 'string' ? args.caption.trim() : '';
      if (!caption) throw new DocRefusal('bad_op', '`caption` says what the drawing shows, e.g. "Release flow"');
      if (args.mermaid !== undefined && typeof args.mermaid !== 'string') {
        throw new DocRefusal('bad_op', '`mermaid` is a flowchart, as text');
      }
      if (args.after !== undefined && typeof args.after !== 'string') throw new DocRefusal('bad_op', '`after` is a block id from doc_read');
      const drawing = newDrawingId(doc, caption);
      const node = { type: 'drawing', attrs: { drawing, caption, src: drawingSrc(doc.name, drawing) } };
      const source = { from: { kind: 'inline', content: [node] }, as: 'blocks' };
      const op = args.after
        ? { op: 'insert', target: { kind: 'blocks', ids: [args.after] }, side: 'after', source }
        : { op: 'insert', target: { kind: 'root' }, side: 'end', source };
      const ack = live.edit([op], origin) as Json & { created?: string[] };
      elementsMap(live.doc, drawing); // the drawing exists from now on, empty
      const out: Json = { ...head, ok: true, drawing, block: ack.created?.[0], rev: ack.rev };
      if (typeof args.mermaid === 'string' && args.mermaid.trim()) {
        const res = await drawing_from_mermaid(live, { drawing, mermaid: args.mermaid }, origin);
        out.mermaid = res.ok ? { created: res.created } : res;
      }
      return [true, out];
    }
    case 'drawing_read': {
      if (args.drawing === undefined) {
        const captions = new Map(drawingBlocks(live).map((b) => [b.drawing, b.caption]));
        const drawings = [...drawingsMap(live.doc).keys()].sort().map((id) => ({
          drawing: id,
          caption: captions.get(id) ?? null,
          shapes: readModels(live.doc, id).length,
          ...(captions.has(id) ? {} : { inDoc: false }),
        }));
        return [true, { ...head, drawings }];
      }
      const drawing = drawingOf(doc, args.drawing);
      return [true, { ...head, drawing, ...drawing_read(live, { drawing }) }];
    }
    case 'drawing_edit': {
      const drawing = drawingOf(doc, args.drawing);
      const ops = args.ops as Op[];
      const bad = Array.isArray(ops) ? ops.findIndex((o) => INTERNAL_OPS.has((o as { op?: string })?.op ?? '')) : -1;
      if (bad >= 0) throw new DocRefusal('bad_op', `op ${bad}: unknown op ${(ops[bad] as { op: string }).op}`, { op: bad });
      return answer(drawing_edit(live, { drawing, ops }, origin), { ...head, drawing });
    }
    case 'drawing_from_mermaid': {
      const drawing = drawingOf(doc, args.drawing);
      if (typeof args.mermaid !== 'string' || !args.mermaid.trim()) throw new DocRefusal('bad_op', '`mermaid` is a flowchart, as text');
      return answer(await drawing_from_mermaid(live, { drawing, mermaid: args.mermaid }, origin), { ...head, drawing });
    }
    default:
      throw new DocRefusal('bad_tool', `Unknown drawing tool: ${tool}`);
  }
}
