/**
 * A drawing on disk, next to the doc's Markdown mirror:
 *   <name>.excalidraw      plain Excalidraw JSON (clean diffs; agents with file tools can edit it);
 *   <name>.excalidraw.svg  a picture any viewer shows, with the same scene embedded the way Excalidraw embeds it
 *                          (payload-version 2, uncompressed), so Excalidraw and AIB reopen it editable.
 * The SVG is drawn here, headless, by a small renderer (clean shapes, not Excalidraw's hand-drawn strokes): Excalidraw's own
 * exportToSvg needs a browser DOM and its fonts.
 *
 * Import goes element by element through drawing_edit with the same guards: an element changed since the export (its
 * `version` in the file is the `v` it was exported at), or one the user is busy with, is refused and reported; the rest apply.
 */
import { FILE, LINEAR, type Model, readModels, same } from './model.ts';
import { modelsToScene, sceneToModels, type XEl } from './scene.ts';
import { boxOf, union } from './geometry.ts';
import { drawing_edit, type DrawingHub, type Op, type Refusal } from './tools.ts';

export function exportScene(hub: DrawingHub, drawingId: string) {
  const models = readModels(hub.doc, drawingId);
  return {
    type: 'excalidraw',
    version: 2,
    source: 'aib',
    elements: modelsToScene(models),
    appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
    files: {},
    // AIB's own key (Excalidraw ignores it): which elements were exported at which v, so a removed one reads as a delete.
    aib: { doc: hub.doc.guid, drawing: drawingId, versions: Object.fromEntries(models.map((m) => [m.id, m.v])) },
  };
}

export function exportJson(hub: DrawingHub, drawingId: string): string {
  return JSON.stringify(exportScene(hub, drawingId), null, 2) + '\n';
}

// ---------- SVG ----------

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = 'Excalifont, Virgil, Segoe UI, Helvetica, sans-serif';

function toByteString(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) out += String.fromCharCode(b);
  return out;
}
function fromByteString(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
}

function shape(e: XEl, ox: number, oy: number): string {
  const stroke = esc(e.strokeColor ?? '#1e1e1e');
  const fill = !e.backgroundColor || e.backgroundColor === 'transparent' ? 'none' : esc(e.backgroundColor);
  const dash = e.strokeStyle === 'dashed' ? ' stroke-dasharray="8 6"' : e.strokeStyle === 'dotted' ? ' stroke-dasharray="2 5"' : '';
  const common = `stroke="${stroke}" stroke-width="${e.strokeWidth ?? 2}"${dash} opacity="${(e.opacity ?? 100) / 100}"`;
  const x = e.x + ox, y = e.y + oy, w = e.width, h = e.height;
  switch (e.type) {
    case 'rectangle':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}"${
        e.roundness ? ` rx="${Math.min(16, w / 4, h / 4)}"` : ''
      } fill="${fill}" ${common}/>`;
    case 'ellipse':
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" ${common}/>`;
    case 'diamond':
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${fill}" ${common}/>`;
    case 'frame':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="none" stroke="#bbb" stroke-width="1"/>` +
        (e.name ? `<text x="${x}" y="${y - 6}" font-family="${FONT}" font-size="14" fill="#888">${esc(e.name)}</text>` : '');
    case 'arrow':
    case 'line':
    case 'freedraw': {
      const pts = (e.points as [number, number][]).map(([px, py]) => [x + px, y + py]);
      let out = `<polyline points="${
        pts.map((p) => p.join(',')).join(' ')
      }" fill="none" stroke-linecap="round" stroke-linejoin="round" ${common}/>`;
      if (e.type === 'arrow' && e.endArrowhead && pts.length > 1) out += head(pts[pts.length - 2], pts[pts.length - 1], stroke);
      if (e.type === 'arrow' && e.startArrowhead && pts.length > 1) out += head(pts[1], pts[0], stroke);
      return out;
    }
    case 'text': {
      const lines = String(e.text ?? '').split('\n');
      const fs = e.fontSize ?? 20, lh = fs * (e.lineHeight ?? 1.25);
      const anchor = e.textAlign === 'center' ? 'middle' : e.textAlign === 'right' ? 'end' : 'start';
      const tx = anchor === 'middle' ? x + w / 2 : anchor === 'end' ? x + w : x;
      const spans = lines.map((l, i) => `<tspan x="${tx}" y="${y + fs * 0.9 + i * lh}">${esc(l)}</tspan>`).join('');
      return `<text font-family="${FONT}" font-size="${fs}" fill="${stroke}" text-anchor="${anchor}">${spans}</text>`;
    }
    default:
      return '';
  }
}

function head(a: number[], b: number[], stroke: string): string {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), len = 14, spread = 0.45;
  const p1 = [b[0] - len * Math.cos(ang - spread), b[1] - len * Math.sin(ang - spread)];
  const p2 = [b[0] - len * Math.cos(ang + spread), b[1] - len * Math.sin(ang + spread)];
  return `<polyline points="${p1.join(',')} ${b.join(',')} ${
    p2.join(',')
  }" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function exportSvg(hub: DrawingHub, drawingId: string): string {
  const scene = exportScene(hub, drawingId);
  const els = scene.elements.filter((e) => !e.isDeleted);
  const pad = 20;
  const boxes = els.map((e) => boxOf({ ...e, v: 0 } as Model)).concat(
    els.filter((e) => e.type === 'frame').map((e) => ({ x: e.x, y: e.y - 24, w: 1, h: 1 })),
  );
  const bb = boxes.length ? union(boxes) : { x: 0, y: 0, w: 1, h: 1 };
  const W = Math.ceil(bb.w + 2 * pad), H = Math.ceil(bb.h + 2 * pad), ox = pad - bb.x, oy = pad - bb.y;
  const json = JSON.stringify(scene);
  const payload = btoa(JSON.stringify({ version: '1', encoding: 'bstring', compressed: false, encoded: toByteString(json) }));
  const ordered = [...els.filter((e) => e.type === 'frame'), ...els.filter((e) => e.type !== 'frame')];
  return [
    `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<!-- svg-source:excalidraw -->`,
    `<metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-version:2 --><!-- payload-start -->${payload}<!-- payload-end --></metadata>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`,
    ...ordered.map((e) => shape(e, ox, oy)).filter(Boolean),
    `</svg>`,
    '',
  ].join('\n');
}

/** The scene JSON embedded in an .excalidraw.svg (ours or Excalidraw's own, uncompressed or compressed). */
export async function sceneFromSvg(svg: string): Promise<string> {
  const m = svg.match(/<!-- payload-start -->\s*(.+?)\s*<!-- payload-end -->/s);
  if (!m) throw new Error('No Excalidraw scene in this SVG.');
  const version = svg.match(/<!-- payload-version:(\d+) -->/)?.[1] ?? '1';
  const raw = atob(m[1]);
  const json = version === '1' ? fromByteString(raw) : raw;
  const data = JSON.parse(json);
  if (!('encoded' in data)) return json;
  if (!data.compressed) return fromByteString(data.encoded);
  const bytes = Uint8Array.from(data.encoded as string, (c) => c.charCodeAt(0));
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')));
  return await out.text();
}

// ---------- import ----------

export type ImportResult = { ok: true; applied: string[]; refused: Refusal[] };

/** Back from a file (after an agent edited it with file tools): each element on its own, through the guarded edit. */
export function importJson(hub: DrawingHub, drawingId: string, text: string, opts: { allowDetach?: boolean } = {}): ImportResult {
  const data = JSON.parse(text);
  const fileEls: XEl[] = (data.elements ?? []).filter((e: XEl) => !e.isDeleted);
  const fileModels = sceneToModels(fileEls);
  const fileVersion = new Map(fileEls.map((e) => [e.id, e.version as number]));
  const exported: Record<string, number> = data.aib?.doc === hub.doc.guid && data.aib?.drawing === drawingId ? data.aib.versions ?? {} : {};
  const current = readModels(hub.doc, drawingId);
  const byId = new Map(current.map((m) => [m.id, m]));
  // Compare like with like: the current state through the same conversion, so defaults the file spells out are no change.
  const currentAsFile = sceneToModels(modelsToScene(current));
  const applied: string[] = [], refused: Refusal[] = [];
  const run = (ops: Op[], id: string) => {
    const res = drawing_edit(hub, { drawing: drawingId, ops }, FILE);
    if (res.ok) applied.push(id);
    else refused.push(res);
  };
  // New elements keep the file's stacking order (they are applied arrows first, below).
  const zBase = Math.max(0, ...current.map((m) => m.z ?? 0)) + 1;
  const zOf = new Map([...fileModels.keys()].map((id, i) => [id, zBase + i]));
  // Arrows first: a moved box re-routes its arrows, which would make the file's own arrow change look stale.
  const order = [...fileModels].sort(([, a], [, b]) => Number(!LINEAR.has(a.type as string)) - Number(!LINEAR.has(b.type as string)));
  for (const [id, fields] of order) {
    const now = byId.get(id);
    if (!now) {
      if (id in exported) {
        refused.push({ ok: false, error: 'stale', id, message: `${id} was deleted in the drawing after the export.` });
        continue;
      }
      run(
        [{ op: 'add_raw', element: { ...fields, id, type: fields.type as string, v: 1, createdBy: 'agent', z: zOf.get(id) } as Model }],
        id,
      );
      continue;
    }
    const was = currentAsFile.get(id) ?? {};
    const diff: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(fields), ...Object.keys(was)])) if (!same(fields[k], was[k])) diff[k] = fields[k];
    if (!Object.keys(diff).length) continue;
    run([{ op: 'patch', id, ifV: fileVersion.get(id) ?? -1, fields: diff }], id);
  }
  for (const [id, v] of Object.entries(exported)) {
    if (!fileModels.has(id) && byId.has(id)) run([{ op: 'delete', id, ifV: v, allowDetach: opts.allowDetach }], id);
  }
  return { ok: true, applied, refused };
}

export async function importFile(hub: DrawingHub, drawingId: string, path: string, opts: { allowDetach?: boolean } = {}) {
  const text = await Deno.readTextFile(path);
  return importJson(hub, drawingId, path.endsWith('.svg') ? await sceneFromSvg(text) : text, opts);
}

export async function exportFiles(hub: DrawingHub, drawingId: string, basePath: string) {
  await Deno.writeTextFile(`${basePath}.excalidraw`, exportJson(hub, drawingId));
  await Deno.writeTextFile(`${basePath}.excalidraw.svg`, exportSvg(hub, drawingId));
}
