/**
 * A doc's drawings in its folder (aib-docs/<doc>/), next to its pages' Markdown copies:
 *
 *   aib-docs/<doc>/NN-<page>.md                    the drawing block: ![caption](assets/<drawing>.excalidraw.svg)
 *   aib-docs/<doc>/assets/<drawing>.excalidraw.svg  the picture, with the scene embedded (files.ts), so viewers show it and AIB reopens it
 *   aib-docs/<doc>/assets/<drawing>.excalidraw      the scene as plain JSON: clean diffs, and what agents edit with file tools
 *
 * syncDrawings runs at the start of the store's file sync and at the end of its write (store.ts), for every drawing a block of the doc
 * shows:
 *   - a drawing the Y.Doc does not hold (a Markdown copy read in, a block a file edit added) is rebuilt from its .excalidraw file, else
 *     from the scene embedded in its .excalidraw.svg;
 *   - a .excalidraw file that differs from what AIB last wrote (a file-tool edit) is imported element by element with the agent
 *     tools' guards (files.ts importJson): an element changed in the doc since that export, or one the user is busy with, is refused
 *     and recorded in the doc's skipped edits, never overwritten;
 *   - then both files are written again from the doc when they differ from it.
 * A drawing whose block is gone keeps its shapes in the Y.Doc (an undo brings the block back) and its files stay where they are.
 */
import * as Y from 'yjs';
import { drawingsMap } from './model.ts';
import { exportJson, exportSvg, importJson, sceneFromSvg } from './files.ts';
import type { LiveDoc } from '../live_doc.ts';
import { DRAWING_SRC } from '../markdown.ts';
import type { OpenDoc, SkippedEdit } from '../store.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';

export interface DrawingRef {
  drawing: string;
  caption: string;
  src: string;
  /** The page the block is on. */
  page: string;
}

/** The drawing blocks of a doc, in doc order, page by page (anywhere: top level, in a list item, in a quote). */
export function drawingBlocks(live: LiveDoc): DrawingRef[] {
  const out: DrawingRef[] = [];
  const walk = (p: Y.XmlFragment | Y.XmlElement, page: string) => {
    for (const c of p.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      if (c.nodeName === 'drawing') {
        const a = c.getAttributes() as Record<string, unknown>;
        out.push({ drawing: String(a.drawing ?? ''), caption: String(a.caption ?? ''), src: String(a.src ?? ''), page });
      } else walk(c, page);
    }
  };
  for (const { page, frag } of live.pageFrags()) walk(frag, page);
  return out;
}

/** The src a new drawing block gets: relative to the Markdown copies, so GitHub and other viewers show the picture. */
export function drawingSrc(drawing: string): string {
  return `assets/${drawing}.excalidraw.svg`;
}

/** The two files of a drawing block, or null for a src that is not a drawing in the doc folder's assets folder. */
export function drawingFiles(dir: string, src: string): { svg: string; json: string } | null {
  if (!DRAWING_SRC.test(src)) return null;
  const svg = `${dir}${sep}${src.replace(/^\.\//, '').replace(/\//g, sep)}`;
  return { svg, json: svg.slice(0, -'.svg'.length) };
}

/** What AIB last wrote (or read and found equal) per drawing file, so an agent's file edit shows as a difference. */
const written = new WeakMap<OpenDoc, Map<string, string>>();

async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf(sep)), { recursive: true });
  const tmp = `${path}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}

/** Take in file edits to the doc's drawings and write their files from the doc. Returns the refused element edits (also in doc.skipped). */
export async function syncDrawings(doc: OpenDoc): Promise<SkippedEdit[]> {
  const live = doc.live;
  let last = written.get(doc);
  if (!last) written.set(doc, last = new Map());
  const skipped: SkippedEdit[] = [];
  const seen = new Set<string>();
  for (const ref of drawingBlocks(live)) {
    const files = drawingFiles(doc.dir, ref.src);
    if (!files || !ref.drawing || seen.has(files.json)) continue;
    seen.add(files.json);
    let text = await readText(files.json);
    const svgText = await readText(files.svg);
    if (text === null && svgText !== null) text = await sceneFromSvg(svgText).catch(() => null);
    const held = drawingsMap(live.doc).has(ref.drawing);
    if (text !== null) {
      const origin = live.originFor('file', 'file edit');
      try {
        if (!held) importJson(live, ref.drawing, text, { key: doc.id, origin, rebuild: true });
        else if (text !== (last.get(files.json) ?? exportJson(live, ref.drawing, doc.id))) {
          const res = importJson(live, ref.drawing, text, { key: doc.id, origin });
          for (const r of res.refused) {
            skipped.push({
              at: new Date().toISOString(),
              reason: 'refused',
              id: `${ref.drawing}/${r.id ?? ''}`,
              mirror: '',
              now: r.current ?? r.message,
              file: r.message,
            });
          }
        }
      } catch (error) {
        // Not JSON, or not a scene: the doc's drawing stands and the file is written again from it.
        skipped.push({ at: new Date().toISOString(), reason: 'refused', id: ref.drawing, mirror: '', now: '', file: String(error) });
      }
    }
    if (!drawingsMap(live.doc).has(ref.drawing)) continue; // nothing to write: no shapes yet and no file to start from
    const json = exportJson(live, ref.drawing, doc.id);
    if (text !== json) await writeAtomic(files.json, json);
    if (text !== json || svgText === null) await writeAtomic(files.svg, exportSvg(live, ref.drawing, doc.id));
    last.set(files.json, json);
  }
  if (skipped.length) {
    doc.skipped.push(...skipped);
    if (doc.skipped.length > 50) doc.skipped.splice(0, doc.skipped.length - 50);
  }
  return skipped;
}
