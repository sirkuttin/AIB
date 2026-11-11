/**
 * Drawing storage on a Y.Doc (spike, branch spike/local-docs-drawing).
 *
 * Layout: doc.getMap('drawings') / <drawingId> (Y.Map) / 'elements' (Y.Map) / <elementId> (Y.Map, one key per field).
 * Field-level maps are the point: the user moving a box (x, y) and the agent relabelling it (text) touch different keys,
 * so both survive a concurrent merge. Excalidraw's own sync is last-writer-wins per whole element and would lose one.
 *
 * Every element map carries:
 *   v          a counter bumped by one in every transaction that changes the element (the agent's ifV guard reads it);
 *   createdBy  'user' | 'agent' (deleting a user-made element needs allowDetach);
 *   z          a number that orders elements (Excalidraw's fractional `index` is rebuilt from it).
 * Labels are fields of their container (`text`, `fontSize`, `fontFamily`, `labelId`): Excalidraw's separate bound text
 * element is expanded from them in scene.ts and folded back in binding.ts. `boundElements` is never stored; it is derived.
 */
import { Y } from './deps.ts';

export { Y };

/** Transaction origins. The page's binding uses USER, the agent tools use AGENT, file import uses FILE. */
export const USER = 'user';
export const AGENT = 'agent';
export const FILE = 'file';

/** A plain copy of one element map. */
export type Model = Record<string, unknown> & { id: string; type: string; v: number; createdBy?: string; z?: number };

/** The fields one element may store. Anything else Excalidraw sends is dropped (derived or transient). */
export const FIELDS = [
  'type',
  'x',
  'y',
  'width',
  'height',
  'angle',
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
  'roundness',
  'seed',
  'groupIds',
  'frameId',
  'link',
  'locked',
  // text, on a text element or as the label of a container or arrow
  'text',
  'fontSize',
  'fontFamily',
  'textAlign',
  'verticalAlign',
  'labelId',
  // arrows, lines, freedraw
  'points',
  'startBinding',
  'endBinding',
  'startArrowhead',
  'endArrowhead',
  'elbowed',
  'pressures',
  'simulatePressure',
  // frames
  'name',
  // bookkeeping
  'v',
  'createdBy',
  'z',
] as const;

export const CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond']);
export const LINEAR = new Set(['arrow', 'line']);

export function drawingsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('drawings') as Y.Map<Y.Map<unknown>>;
}

/** The elements map of one drawing, made on first use (in its own transaction, so call it before a guarded edit). */
export function elementsMap(doc: Y.Doc, drawingId: string, create = true): Y.Map<Y.Map<unknown>> | null {
  const drawings = drawingsMap(doc);
  let d = drawings.get(drawingId);
  if (!d) {
    if (!create) return null;
    doc.transact(() => {
      d = new Y.Map();
      d.set('elements', new Y.Map());
      drawings.set(drawingId, d);
    });
  }
  return d!.get('elements') as Y.Map<Y.Map<unknown>>;
}

export function toModel(id: string, m: Y.Map<unknown>): Model {
  const out: Record<string, unknown> = { id };
  for (const [k, val] of m.entries()) out[k] = val;
  if (typeof out.v !== 'number') out.v = 0;
  return out as Model;
}

/** Every element of a drawing as plain objects, in z order. */
export function readModels(doc: Y.Doc, drawingId: string): Model[] {
  const els = elementsMap(doc, drawingId, false);
  if (!els) return [];
  const list = [...els.entries()].map(([id, m]) => toModel(id, m));
  return list.sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : 1));
}

export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === undefined || b === undefined || a === null || b === null) return a == b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Writes only the fields that differ, bumps `v` once, inside the caller's transaction. Returns whether anything changed.
 * Writing only changed keys is what lets a concurrent change to other keys of the same element survive.
 */
export function writeFields(map: Y.Map<unknown>, fields: Record<string, unknown>): boolean {
  let changed = false;
  for (const [k, val] of Object.entries(fields)) {
    if (k === 'id' || k === 'v') continue;
    const cur = map.get(k);
    if (val === undefined) {
      if (map.has(k)) {
        map.delete(k);
        changed = true;
      }
    } else if (!same(cur, val)) {
      map.set(k, clone(val));
      changed = true;
    }
  }
  if (changed) map.set('v', ((map.get('v') as number) ?? 0) + 1);
  return changed;
}

export function newElementMap(fields: Record<string, unknown>): Y.Map<unknown> {
  const entries = Object.entries(fields).filter(([k, val]) => k !== 'id' && val !== undefined).map(([k, val]) =>
    [k, clone(val)] as [string, unknown]
  );
  if (!entries.some(([k]) => k === 'v')) entries.push(['v', 1]);
  return new Y.Map<unknown>(entries);
}

export function clone<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

/** Short readable ids for agent-made elements (b = box, a = arrow, f = frame), the lowest free number. */
export function newId(prefix: string, taken: (id: string) => boolean): string {
  for (let n = 1;; n++) if (!taken(`${prefix}${n}`)) return `${prefix}${n}`;
}
