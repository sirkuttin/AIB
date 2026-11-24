/** Boxes, free-space placement and arrow routing for the drawing tools. Plain numbers, no Yjs. */
import type { Model } from './model.ts';
import { CONTAINERS, LINEAR } from './model.ts';

export type Box = { x: number; y: number; w: number; h: number };

const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function boxOf(m: Model): Box {
  if (LINEAR.has(m.type) || m.type === 'freedraw') {
    const pts = (m.points as [number, number][] | undefined) ?? [[0, 0]];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return { x: n(m.x) + x0, y: n(m.y) + y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
  }
  return { x: n(m.x), y: n(m.y), w: n(m.width), h: n(m.height) };
}

export const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function overlaps(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

export function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The shapes new elements must not land on: everything solid (not arrows, lines or frames themselves). */
export function obstacles(models: Model[], skip: Set<string> = new Set()): Box[] {
  return models.filter((m) => !skip.has(m.id) && !LINEAR.has(m.type) && m.type !== 'frame').map(boxOf);
}

const GAP = 40;
const STEP = 20;

/**
 * The free spot for a w x h shape closest to `want` (its top-left), keeping GAP clear of every obstacle and, when `inside`
 * is given, staying within it. Searches a widening square of STEP-sized offsets; null when nothing fits within `radius`.
 */
export function findFree(want: { x: number; y: number }, w: number, h: number, obs: Box[], inside?: Box, radius = 2000): Box | null {
  const fits = (x: number, y: number) => {
    const b = { x, y, w, h };
    if (inside && (x < inside.x || y < inside.y || x + w > inside.x + inside.w || y + h > inside.y + inside.h)) return false;
    return !obs.some((o) => overlaps(b, o, GAP - 1));
  };
  if (fits(want.x, want.y)) return { x: want.x, y: want.y, w, h };
  for (let r = STEP; r <= radius; r += STEP) {
    const ring: [number, number][] = [];
    for (let d = -r; d <= r; d += STEP) ring.push([d, -r], [d, r], [-r, d], [r, d]);
    ring.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
    for (const [dx, dy] of ring) if (fits(want.x + dx, want.y + dy)) return { x: want.x + dx, y: want.y + dy, w, h };
  }
  return null;
}

/** A spot next to `target`: right, below, left, then above it, then the nearest free spot to its right. */
export function placeNear(target: Box, w: number, h: number, obs: Box[]): Box {
  const c = center(target);
  const sides = [
    { x: target.x + target.w + GAP * 2, y: c.y - h / 2 },
    { x: c.x - w / 2, y: target.y + target.h + GAP * 2 },
    { x: target.x - GAP * 2 - w, y: c.y - h / 2 },
    { x: c.x - w / 2, y: target.y - GAP * 2 - h },
  ];
  for (const s of sides) {
    const hit = findFree(s, w, h, obs, undefined, 0);
    if (hit) return hit;
  }
  return findFree(sides[0], w, h, obs)!;
}

/** Right of everything there is (or at the origin on an empty drawing). */
export function placeAnywhere(w: number, h: number, models: Model[]): Box {
  const obs = obstacles(models);
  if (!obs.length) return { x: 0, y: 0, w, h };
  const all = union(obs);
  return findFree({ x: all.x + all.w + GAP * 2, y: all.y }, w, h, obs)!;
}

/** Where a ray from the box's centre towards `toward` leaves the box, pushed `gap` further out. */
export function edgePoint(b: Box, toward: { x: number; y: number }, gap: number, type = 'rectangle'): { x: number; y: number } {
  const c = center(b);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = b.w / 2, hh = b.h / 2;
  let t: number;
  if (type === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (type === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  const len = Math.hypot(dx, dy);
  return { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap };
}

/** A straight arrow between two shapes: x, y and the two points, ends on the shapes' outlines. */
export function route(
  from: Model,
  to: Model,
  gap = 8,
): { x: number; y: number; points: [number, number][]; width: number; height: number } {
  const fb = boxOf(from), tb = boxOf(to);
  const a = edgePoint(fb, center(tb), gap, from.type);
  const b = edgePoint(tb, center(fb), gap, to.type);
  return { x: a.x, y: a.y, points: [[0, 0], [b.x - a.x, b.y - a.y]], width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export const isShape = (m: Model) => CONTAINERS.has(m.type) || m.type === 'text' || m.type === 'image' || m.type === 'frame';

/** Rough text size, used where no canvas can measure (the server). The page measures with a canvas instead. */
export function textSize(text: string, fontSize = 20): { w: number; h: number } {
  const lines = String(text ?? '').split('\n');
  return { w: Math.max(...lines.map((l) => l.length)) * fontSize * 0.55, h: lines.length * fontSize * 1.25 };
}
