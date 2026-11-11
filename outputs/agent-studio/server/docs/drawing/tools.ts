/**
 * The agent's drawing tools: drawing_read, drawing_edit, drawing_from_mermaid. Plain functions with MCP-shaped inputs; the
 * MCP registration and the doc lookup are in agent.ts; here the doc's live state (a LiveDoc: its Y.Doc and awareness) is passed in.
 *
 * The never-overwrite rule (mirrors Claude Docs' guarded edits):
 *   - every change to an existing element carries ifV (the `v` the agent read); a stale one is refused with the element now;
 *   - an element the user has selected, is dragging or is editing (Yjs awareness, see binding.ts) is refused: user_editing;
 *     this also covers elements the agent changes implicitly (a bound arrow re-routed, a frame grown, a child re-framed);
 *   - deleting an element the user made, or one with user-made arrows attached, needs allowDetach;
 *   - a call is atomic: every op is planned against a working copy first; one refusal and nothing is written.
 *     The plan and the write run in one synchronous stretch, so nothing can land in between.
 * New shapes are placed by the server in free space (geometry.ts), so they do not cover the user's.
 */
import type { Awareness } from 'y-protocols/awareness';
import {
  AGENT,
  clone,
  CONTAINERS,
  elementsMap,
  FIELDS,
  LINEAR,
  type Model,
  newElementMap,
  newId,
  readModels,
  same,
  writeFields,
  type Y,
} from './model.ts';
import { type Box, boxOf, findFree, obstacles, placeAnywhere, placeNear, route, textSize, union } from './geometry.ts';
import { busyIds } from './binding.ts';

/**
 * One live doc as the drawing tools see it: the doc core's Y.Doc (drawings live under doc.getMap('drawings')) and the awareness its
 * doc socket feeds (the user's selection, drag and text editing arrive there). A LiveDoc (../live_doc.ts) is one.
 */
export interface DrawingHost {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
}

export type Refusal = { ok: false; error: string; op?: number; id?: string; message: string; current?: string; element?: Model };

class Refuse extends Error {
  constructor(readonly r: Omit<Refusal, 'ok'>) {
    super(r.message);
  }
}

// ---------- drawing_read ----------

const r = (v: unknown) => Math.round(Number(v) || 0);

function arrowsOf(models: Model[]) {
  const ins = new Map<string, string[]>(), outs = new Map<string, string[]>();
  for (const m of models) {
    if (m.type !== 'arrow') continue;
    const s = (m.startBinding as { elementId?: string } | null)?.elementId, e = (m.endBinding as { elementId?: string } | null)?.elementId;
    if (s) (outs.get(s) ?? outs.set(s, []).get(s)!).push(m.id);
    if (e) (ins.get(e) ?? ins.set(e, []).get(e)!).push(m.id);
  }
  return { ins, outs };
}

export function line(m: Model, models: Model[], busy: Map<string, string>): string {
  const { ins, outs } = arrowsOf(models);
  const text = m.type === 'frame' ? m.name : m.text;
  const parts = [m.id, m.type];
  if (typeof text === 'string' && text) parts.push(JSON.stringify(text));
  if (m.type === 'arrow') {
    const s = (m.startBinding as { elementId?: string } | null)?.elementId, e = (m.endBinding as { elementId?: string } | null)?.elementId;
    parts.push(`from=${s ?? '-'}`, `to=${e ?? '-'}`);
  } else {
    const b = boxOf(m);
    parts.push(`x=${r(b.x)} y=${r(b.y)} w=${r(b.w)} h=${r(b.h)}`);
  }
  if (m.frameId) parts.push(`frame=${m.frameId}`);
  if (m.type === 'frame') {
    const kids = models.filter((k) => k.frameId === m.id).map((k) => k.id);
    if (kids.length) parts.push(`contains=${kids.join(',')}`);
  }
  if (ins.get(m.id)) parts.push(`in=${ins.get(m.id)!.join(',')}`);
  if (outs.get(m.id)) parts.push(`out=${outs.get(m.id)!.join(',')}`);
  parts.push(`v=${m.v}`, `by=${m.createdBy ?? 'user'}`);
  const why = busy.get(m.id);
  if (why) parts.push(`selectedByUser${why === 'selected' ? '' : `(${why})`}`);
  return parts.join(' ');
}

export function drawing_read(hub: DrawingHost, input: { drawing: string }): { ok: true; text: string } {
  const models = readModels(hub.doc, input.drawing);
  const busy = busyIds(hub.awareness.getStates().values(), input.drawing);
  const head = `drawing ${input.drawing}: ${models.length} element(s). Change one with drawing_edit and ifV=<its v>.`;
  return { ok: true, text: [head, ...models.map((m) => line(m, models, busy))].join('\n') };
}

// ---------- drawing_edit ----------

type At = { x: number; y: number };
export type Op =
  | {
    op: 'add_box';
    text: string;
    near?: string;
    in?: string;
    at?: At;
    shape?: 'rectangle' | 'ellipse' | 'diamond';
    id?: string;
    style?: Style;
  }
  | { op: 'add_arrow'; from: string; to: string; label?: string; id?: string }
  | { op: 'add_frame'; title: string; around: string[]; ifV?: Record<string, number>; id?: string }
  | { op: 'move'; id: string; to?: At; by?: { dx: number; dy: number }; ifV: number }
  | { op: 'set_text'; id: string; text: string; ifV: number }
  | { op: 'style'; id: string; ifV: number; style: Style }
  | { op: 'delete'; id: string; ifV: number; allowDetach?: boolean }
  | { op: 'add_raw'; element: Model } // internal: drawing_from_mermaid and the file import
  | { op: 'patch'; id: string; ifV: number; fields: Record<string, unknown> }; // internal: the file import

type Style = Partial<{
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  fontSize: number;
  shape: 'rectangle' | 'ellipse' | 'diamond';
}>;
const STYLE_KEYS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'fontSize'];

export type EditResult = { ok: true; created: string[]; changed: Record<string, number>; deleted: string[] } | Refusal;

/** The working copy one call is planned against. */
class Plan {
  readonly work: Map<string, Model>;
  readonly creates: string[] = [];
  readonly deletes = new Set<string>();
  readonly touched = new Set<string>();
  constructor(readonly base: Model[], readonly busy: Map<string, string>, readonly drawing: string) {
    this.work = new Map(base.map((m) => [m.id, clone(m)]));
  }
  get models() {
    return [...this.work.values()];
  }
  maxZ() {
    return Math.max(0, ...this.models.map((m) => m.z ?? 0));
  }
  taken = (id: string) => this.work.has(id) || this.deletes.has(id);
  get(id: string, i: number): Model {
    const m = this.work.get(id);
    if (!m) throw new Refuse({ error: 'not_found', op: i, id, message: `No element ${id} in drawing ${this.drawing}.` });
    return m;
  }
  current(m: Model) {
    const base = this.base.find((b) => b.id === m.id) ?? m;
    return { current: line(base, this.base, this.busy), element: base };
  }
  /** Not selected, dragged or edited by the user (for every element the call changes, asked for or not). */
  free(m: Model, i: number) {
    const why = this.busy.get(m.id);
    if (why && !this.creates.includes(m.id)) {
      throw new Refuse({
        error: 'user_editing',
        op: i,
        id: m.id,
        message: `The user is ${why === 'selected' ? 'selecting' : why} ${m.id}; try again later or pick another element.`,
        ...this.current(m),
      });
    }
  }
  /** An element the agent asked to change: present, free, and still at the version it read. */
  guard(id: string, ifV: number | undefined, i: number): Model {
    const m = this.get(id, i);
    this.free(m, i);
    if (this.creates.includes(id)) return m;
    if (typeof ifV !== 'number') {
      throw new Refuse({
        error: 'ifV_required',
        op: i,
        id,
        message: `Changing ${id} needs ifV (its v from drawing_read).`,
        ...this.current(m),
      });
    }
    const baseV = this.base.find((b) => b.id === id)!.v;
    if (ifV !== baseV) {
      throw new Refuse({
        error: 'stale',
        op: i,
        id,
        message: `${id} changed since you read it (you had v=${ifV}, it is v=${baseV}). Re-read it and decide again.`,
        ...this.current(m),
      });
    }
    return m;
  }
  set(m: Model, fields: Record<string, unknown>) {
    Object.assign(m, clone(fields));
    this.touched.add(m.id);
  }
  create(m: Model) {
    this.work.set(m.id, m);
    this.creates.push(m.id);
  }
  /** Re-route every arrow bound to one of `ids` (implicit changes: each arrow must be free too). */
  reroute(ids: Set<string>, i: number) {
    for (const a of this.models) {
      if (a.type !== 'arrow') continue;
      const s = (a.startBinding as { elementId?: string } | null)?.elementId,
        e = (a.endBinding as { elementId?: string } | null)?.elementId;
      if (!(s && ids.has(s)) && !(e && ids.has(e))) continue;
      const from = s ? this.work.get(s) : undefined, to = e ? this.work.get(e) : undefined;
      if (!from || !to) continue;
      this.free(a, i);
      this.set(a, route(from, to));
    }
  }
}

function sizeFor(text: string, fontSize = 20) {
  const t = textSize(text, fontSize);
  return { w: Math.max(160, Math.ceil(t.w + 48)), h: Math.max(70, Math.ceil(t.h + 36)) };
}

const FRAME_PAD = 30;

function planOp(p: Plan, o: Op, i: number, created: string[]) {
  switch (o.op) {
    case 'add_box': {
      if (typeof o.text !== 'string') throw new Refuse({ error: 'bad_op', op: i, message: 'add_box needs text.' });
      const id = o.id ?? newId('b', p.taken);
      if (p.taken(id)) throw new Refuse({ error: 'bad_op', op: i, id, message: `Id ${id} is taken.` });
      const { w, h } = sizeFor(o.text, o.style?.fontSize);
      let spot: Box;
      let frameId: string | null = null;
      if (o.in) {
        const f = p.get(o.in, i);
        if (f.type !== 'frame') throw new Refuse({ error: 'bad_op', op: i, id: o.in, message: `${o.in} is not a frame.` });
        frameId = f.id;
        const fb = boxOf(f);
        const inner = { x: fb.x + FRAME_PAD, y: fb.y + FRAME_PAD, w: fb.w - 2 * FRAME_PAD, h: fb.h - 2 * FRAME_PAD };
        const obs = obstacles(p.models);
        const hit = findFree({ x: inner.x, y: inner.y }, w, h, obs, inner);
        if (hit) spot = hit;
        else {
          // No room: look below the frame's contents and grow the frame down to it (an implicit change: the frame must be free).
          p.free(f, i);
          const below = { ...inner, w: Math.max(inner.w, w), h: inner.h + 4000 };
          spot = findFree({ x: inner.x, y: inner.y + inner.h - h }, w, h, obs, below)!;
          p.set(f, { height: Math.max(fb.h, spot.y + h + FRAME_PAD - fb.y), width: Math.max(fb.w, spot.x + w + FRAME_PAD - fb.x) });
        }
      } else if (o.near) {
        spot = placeNear(boxOf(p.get(o.near, i)), w, h, obstacles(p.models));
        frameId = (p.get(o.near, i).frameId as string) ?? null;
        if (frameId) {
          const f = p.work.get(frameId);
          if (f && !insideBox(spot, boxOf(f))) frameId = null;
        }
      } else if (o.at) {
        spot = findFree(o.at, w, h, obstacles(p.models))!;
      } else spot = placeAnywhere(w, h, p.models);
      const shape = o.style?.shape ?? o.shape ?? 'rectangle';
      if (!CONTAINERS.has(shape)) throw new Refuse({ error: 'bad_op', op: i, message: `Unknown shape ${shape}.` });
      const style = Object.fromEntries(Object.entries(o.style ?? {}).filter(([k]) => STYLE_KEYS.includes(k)));
      p.create({
        id,
        type: shape,
        v: 1,
        createdBy: 'agent',
        z: p.maxZ() + 1,
        x: spot.x,
        y: spot.y,
        width: w,
        height: h,
        text: o.text,
        fontSize: 20,
        fontFamily: 5,
        frameId,
        ...style,
      });
      created.push(id);
      return;
    }
    case 'add_arrow': {
      const from = p.get(o.from, i), to = p.get(o.to, i);
      if (LINEAR.has(from.type) || LINEAR.has(to.type)) {
        throw new Refuse({ error: 'bad_op', op: i, message: 'Arrows connect shapes, not other arrows.' });
      }
      const id = o.id ?? newId('a', p.taken);
      if (p.taken(id)) throw new Refuse({ error: 'bad_op', op: i, id, message: `Id ${id} is taken.` });
      const frameId = from.frameId && from.frameId === to.frameId ? from.frameId : null;
      p.create({
        id,
        type: 'arrow',
        v: 1,
        createdBy: 'agent',
        z: p.maxZ() + 1,
        ...route(from, to),
        frameId,
        startBinding: { elementId: from.id, focus: 0, gap: 8 },
        endBinding: { elementId: to.id, focus: 0, gap: 8 },
        endArrowhead: 'arrow',
        ...(o.label ? { text: o.label, fontSize: 16, fontFamily: 5 } : {}),
      });
      created.push(id);
      return;
    }
    case 'add_frame': {
      if (!Array.isArray(o.around) || !o.around.length) {
        throw new Refuse({ error: 'bad_op', op: i, message: 'add_frame needs around: [ids].' });
      }
      const kids = o.around.map((id) => p.guard(id, o.ifV?.[id] ?? p.work.get(id)?.v, i));
      const id = o.id ?? newId('f', p.taken);
      if (p.taken(id)) throw new Refuse({ error: 'bad_op', op: i, id, message: `Id ${id} is taken.` });
      const u = union(kids.map(boxOf));
      p.create({
        id,
        type: 'frame',
        v: 1,
        createdBy: 'agent',
        z: Math.min(...kids.map((k) => k.z ?? 0)) - 1,
        x: u.x - FRAME_PAD,
        y: u.y - FRAME_PAD,
        width: u.w + 2 * FRAME_PAD,
        height: u.h + 2 * FRAME_PAD,
        name: o.title,
      });
      for (const k of kids) p.set(k, { frameId: id });
      created.push(id);
      return;
    }
    case 'move': {
      const m = p.guard(o.id, o.ifV, i);
      const b = boxOf(m);
      const dx = o.to ? o.to.x - b.x : o.by?.dx ?? NaN, dy = o.to ? o.to.y - b.y : o.by?.dy ?? NaN;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        throw new Refuse({ error: 'bad_op', op: i, id: o.id, message: 'move needs to:{x,y} or by:{dx,dy}.' });
      }
      const moved = new Set([m.id]);
      p.set(m, { x: (m.x as number) + dx, y: (m.y as number) + dy });
      if (m.type === 'frame') {
        for (const k of p.models.filter((k) => k.frameId === m.id)) {
          p.free(k, i);
          p.set(k, { x: (k.x as number) + dx, y: (k.y as number) + dy });
          moved.add(k.id);
        }
      }
      p.reroute(moved, i);
      return;
    }
    case 'set_text': {
      const m = p.guard(o.id, o.ifV, i);
      if (typeof o.text !== 'string') throw new Refuse({ error: 'bad_op', op: i, id: o.id, message: 'set_text needs text.' });
      if (m.type === 'frame') p.set(m, { name: o.text });
      else if (m.type === 'text') {
        const t = textSize(o.text, (m.fontSize as number) ?? 20);
        p.set(m, { text: o.text, width: t.w, height: t.h });
      } else if (CONTAINERS.has(m.type) || m.type === 'arrow') {
        p.set(m, { text: o.text, ...(m.fontSize ? {} : { fontSize: m.type === 'arrow' ? 16 : 20, fontFamily: 5 }) });
      } else throw new Refuse({ error: 'bad_op', op: i, id: o.id, message: `A ${m.type} has no text.` });
      return;
    }
    case 'style': {
      const m = p.guard(o.id, o.ifV, i);
      const s = o.style ?? {};
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(s).filter(([k]) => STYLE_KEYS.includes(k)));
      if (s.shape) {
        if (!CONTAINERS.has(m.type) || !CONTAINERS.has(s.shape)) {
          throw new Refuse({ error: 'bad_op', op: i, id: o.id, message: 'Only boxes change shape (rectangle, ellipse, diamond).' });
        }
        fields.type = s.shape;
      }
      if (!Object.keys(fields).length) {
        throw new Refuse({ error: 'bad_op', op: i, id: o.id, message: `style needs one of ${STYLE_KEYS.join(', ')}, shape.` });
      }
      p.set(m, fields);
      return;
    }
    case 'delete': {
      const m = p.guard(o.id, o.ifV, i);
      const attached = p.models.filter((a) =>
        a.type === 'arrow' && [a.startBinding, a.endBinding].some((b) => (b as { elementId?: string } | null)?.elementId === m.id)
      );
      const userMade = (m.createdBy ?? 'user') !== 'agent' || attached.some((a) => (a.createdBy ?? 'user') !== 'agent');
      if (userMade && !o.allowDetach) {
        throw new Refuse({
          error: 'needs_allowDetach',
          op: i,
          id: o.id,
          message: `${o.id} was made by the user or has the user's arrows attached; pass allowDetach: true to delete it anyway.`,
          ...p.current(m),
        });
      }
      for (const a of attached) {
        p.free(a, i);
        const fields: Record<string, unknown> = {};
        if ((a.startBinding as { elementId?: string } | null)?.elementId === m.id) fields.startBinding = null;
        if ((a.endBinding as { elementId?: string } | null)?.elementId === m.id) fields.endBinding = null;
        p.set(a, fields);
      }
      if (m.type === 'frame') { for (const k of p.models.filter((k) => k.frameId === m.id)) p.free(k, i), p.set(k, { frameId: null }); }
      p.work.delete(m.id);
      p.touched.delete(m.id);
      p.deletes.add(m.id);
      return;
    }
    case 'add_raw': {
      const m = o.element;
      if (p.taken(m.id)) throw new Refuse({ error: 'bad_op', op: i, id: m.id, message: `Id ${m.id} is taken.` });
      p.create({ ...clone(m), v: 1 });
      created.push(m.id);
      return;
    }
    case 'patch': {
      const m = p.guard(o.id, o.ifV, i);
      const fields = Object.fromEntries(
        Object.entries(o.fields).filter(([k]) => (FIELDS as readonly string[]).includes(k) && !['v', 'z', 'createdBy'].includes(k)),
      );
      p.set(m, fields);
      for (const [k, val] of Object.entries(fields)) if (val === undefined) delete m[k];
      if (!LINEAR.has(m.type) && ['x', 'y', 'width', 'height'].some((k) => k in fields)) p.reroute(new Set([m.id]), i);
      return;
    }
    default:
      throw new Refuse({ error: 'bad_op', op: i, message: `Unknown op ${(o as { op: string }).op}.` });
  }
}

const insideBox = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

export function drawing_edit(hub: DrawingHost, input: { drawing: string; ops: Op[] }, origin: unknown = AGENT): EditResult {
  if (!Array.isArray(input.ops) || !input.ops.length) return { ok: false, error: 'bad_op', message: 'ops must be a non-empty list.' };
  const ymap = elementsMap(hub.doc, input.drawing)!;
  const base = readModels(hub.doc, input.drawing);
  const plan = new Plan(base, busyIds(hub.awareness.getStates().values(), input.drawing), input.drawing);
  const created: string[] = [];
  try {
    input.ops.forEach((o, i) => planOp(plan, o, i, created));
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, ...e.r };
    return { ok: false, error: 'bad_op', message: String((e as Error)?.message ?? e) };
  }
  // Write: only the fields the plan changed, so concurrent changes to other fields of the same element survive.
  const baseById = new Map(base.map((m) => [m.id, m]));
  hub.doc.transact(() => {
    for (const id of plan.deletes) if (baseById.has(id)) ymap.delete(id);
    for (const id of plan.creates) if (plan.work.has(id)) ymap.set(id, newElementMap(plan.work.get(id)!));
    for (const id of plan.touched) {
      if (plan.creates.includes(id) || !baseById.has(id)) continue;
      const before = baseById.get(id)!, after = plan.work.get(id)!;
      const diff: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (k !== 'v' && k !== 'id' && !same(before[k], after[k])) diff[k] = after[k];
      }
      writeFields(ymap.get(id)!, diff);
    }
  }, origin);
  const changed: Record<string, number> = {};
  for (const id of [...plan.creates, ...plan.touched]) {
    const m = ymap.get(id);
    if (m) changed[id] = m.get('v') as number;
  }
  return { ok: true, created, changed, deleted: [...plan.deletes].filter((id) => baseById.has(id)) };
}

// ---------- drawing_from_mermaid ----------

/** The vendored, DOM-free conversion (pele layout + a linkedom DOMParser shim), see tools/drawing/build.mjs. */
const MERMAID = new URL('../../../vendor/excalidraw/mermaid_headless.js', import.meta.url).href;

// deno-lint-ignore no-explicit-any
type Skeleton = Record<string, any>;

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export async function drawing_from_mermaid(
  hub: DrawingHost,
  input: { drawing: string; mermaid: string },
  origin: unknown = AGENT,
): Promise<EditResult> {
  const mod = await import(MERMAID);
  let parsed: { elements: Skeleton[] };
  try {
    parsed = await mod.mermaidToSkeleton(input.mermaid);
  } catch (e) {
    return { ok: false, error: 'bad_mermaid', message: `Mermaid did not parse: ${(e as Error)?.message ?? e}` };
  }
  const els = parsed.elements ?? [];
  if (!els.length || els.some((e) => e.type === 'image')) {
    return {
      ok: false,
      error: 'unsupported',
      message: 'Only Mermaid flowcharts convert into editable shapes (other diagram types come out as one picture).',
    };
  }
  const models = readModels(hub.doc, input.drawing);
  const taken = new Set(models.map((m) => m.id));
  let n = 1;
  while ([...taken].some((id) => id.startsWith(`m${n}_`))) n++;
  const pre = `m${n}_`;
  const shapes = els.filter((e) => !LINEAR.has(e.type));
  const bb = union(
    els.map((e) => ({ x: e.x, y: e.y, w: e.width ?? Math.max(...(e.points ?? [[0, 0]]).map((p: number[]) => p[0])), h: e.height ?? 0 })),
  );
  const spot = placeAnywhere(bb.w, bb.h, models);
  const dx = spot.x - bb.x, dy = spot.y - bb.y;
  let z = Math.max(0, ...models.map((m) => m.z ?? 0)) + 1;
  const ops: Op[] = [];
  for (const e of [...shapes, ...els.filter((e) => LINEAR.has(e.type))]) {
    const m: Model = {
      id: pre + e.id,
      type: e.type,
      v: 1,
      createdBy: 'agent',
      z: z++,
      x: e.x + dx,
      y: e.y + dy,
      strokeWidth: e.strokeWidth ?? 2,
    };
    if (e.width !== undefined) m.width = e.width, m.height = e.height;
    if (e.backgroundColor) m.backgroundColor = e.backgroundColor, m.fillStyle = e.fillStyle ?? 'solid';
    if (e.label?.text) m.text = decode(e.label.text), m.fontSize = e.label.fontSize ?? 20, m.fontFamily = 5;
    if (e.type === 'text') m.text = decode(e.text ?? ''), m.fontSize = e.fontSize ?? 20, m.fontFamily = 5;
    if (LINEAR.has(e.type)) {
      m.points = e.points;
      if (e.start?.id) m.startBinding = { elementId: pre + e.start.id, focus: 0, gap: 5 };
      if (e.end?.id) m.endBinding = { elementId: pre + e.end.id, focus: 0, gap: 5 };
      m.endArrowhead = e.endArrowhead ?? (e.type === 'arrow' ? 'arrow' : null);
      m.startArrowhead = e.startArrowhead ?? null;
    }
    if (e.type === 'frame') m.name = e.name ?? null;
    ops.push({ op: 'add_raw', element: m });
  }
  return drawing_edit(hub, { drawing: input.drawing, ops }, origin);
}
