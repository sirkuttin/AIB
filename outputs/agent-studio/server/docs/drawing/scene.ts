/**
 * Model <-> Excalidraw elements. Used by the page binding (browser), the exporters and the importer (server).
 *
 * modelsToScene expands a container's `text` into Excalidraw's separate bound text element and derives `boundElements`;
 * sceneToModels folds them back. Excalidraw element shape follows @excalidraw/excalidraw 0.18 (restoreElements fills the rest).
 */
import { CONTAINERS, FIELDS, LINEAR, type Model } from './model.ts';
import { boxOf, center, textSize } from './geometry.ts';

// deno-lint-ignore no-explicit-any
export type XEl = Record<string, any>;
export type Measure = (text: string, fontSize: number, fontFamily: number) => { w: number; h: number };

const DEFAULTS: XEl = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  link: null,
  locked: false,
  isDeleted: false,
  updated: 1,
};

const OWN = new Set(['v', 'z', 'createdBy', 'labelId']);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 2 ** 31;
}

export const labelIdOf = (m: Model) => (m.labelId as string) || `${m.id}-label`;
const hasLabel = (m: Model) => (CONTAINERS.has(m.type) || m.type === 'arrow') && typeof m.text === 'string' && m.text !== '';

export function modelsToScene(models: Model[], measure: Measure = (t, f) => textSize(t, f)): XEl[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const bound = new Map<string, { id: string; type: string }[]>();
  const add = (owner: string, e: { id: string; type: string }) => (bound.get(owner) ?? bound.set(owner, []).get(owner)!).push(e);
  for (const m of models) {
    if (hasLabel(m)) add(m.id, { id: labelIdOf(m), type: 'text' });
    if (m.type === 'arrow') {
      for (const b of [m.startBinding, m.endBinding] as ({ elementId?: string } | null)[]) {
        if (b?.elementId && byId.has(b.elementId)) add(b.elementId, { id: m.id, type: 'arrow' });
      }
    }
  }
  const out: XEl[] = [];
  for (const m of models) {
    const el: XEl = { ...DEFAULTS, id: m.id, version: m.v, versionNonce: hash(`${m.id}:${m.v}`), seed: hash(m.id) };
    for (const [k, val] of Object.entries(m)) if (!OWN.has(k) && val !== undefined) el[k] = val;
    el.boundElements = bound.get(m.id) ?? null;
    el.customData = { createdBy: m.createdBy ?? 'user' };
    if (m.type === 'text') {
      const fontSize = (m.fontSize as number) ?? 20, fontFamily = (m.fontFamily as number) ?? 5;
      const size = measure(String(m.text ?? ''), fontSize, fontFamily);
      Object.assign(el, {
        text: m.text ?? '',
        originalText: m.text ?? '',
        fontSize,
        fontFamily,
        lineHeight: 1.25,
        autoResize: true,
        textAlign: m.textAlign ?? 'left',
        verticalAlign: m.verticalAlign ?? 'top',
        containerId: null,
        width: m.width ?? size.w,
        height: m.height ?? size.h,
      });
    } else if (CONTAINERS.has(m.type) || m.type === 'arrow') {
      delete el.text, delete el.fontSize, delete el.fontFamily, delete el.textAlign, delete el.verticalAlign;
    }
    if (LINEAR.has(m.type)) {
      Object.assign(el, {
        points: m.points ?? [[0, 0], [100, 0]],
        lastCommittedPoint: null,
        startBinding: m.startBinding ?? null,
        endBinding: m.endBinding ?? null,
        startArrowhead: m.startArrowhead ?? null,
        endArrowhead: m.endArrowhead ?? (m.type === 'arrow' ? 'arrow' : null),
        elbowed: m.elbowed ?? false,
      });
      const b = boxOf(m);
      el.width = b.w, el.height = b.h;
      if (m.type === 'arrow' && el.roundness == null) el.roundness = { type: 2 };
    }
    if (m.type === 'frame') el.name = m.name ?? null;
    if (CONTAINERS.has(m.type) && el.roundness == null && m.type === 'rectangle') el.roundness = { type: 3 };
    out.push(el);
    if (hasLabel(m)) {
      const fontSize = (m.fontSize as number) ?? 20, fontFamily = (m.fontFamily as number) ?? 5;
      const text = String(m.text);
      const size = measure(text, fontSize, fontFamily);
      const c = m.type === 'arrow' ? arrowMid(m) : center(boxOf(m));
      out.push({
        ...DEFAULTS,
        id: labelIdOf(m),
        type: 'text',
        version: m.v,
        versionNonce: hash(`${labelIdOf(m)}:${m.v}`),
        seed: hash(labelIdOf(m)),
        x: c.x - size.w / 2,
        y: c.y - size.h / 2,
        width: size.w,
        height: size.h,
        text,
        originalText: text,
        fontSize,
        fontFamily,
        lineHeight: 1.25,
        autoResize: true,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: m.id,
        boundElements: null,
        strokeColor: m.strokeColor ?? DEFAULTS.strokeColor,
        frameId: m.frameId ?? null,
        groupIds: m.groupIds ?? [],
      });
    }
  }
  return out;
}

function arrowMid(m: Model) {
  const pts = (m.points as [number, number][]) ?? [[0, 0]];
  const a = pts[0], b = pts[pts.length - 1];
  return { x: (m.x as number) + (a[0] + b[0]) / 2, y: (m.y as number) + (a[1] + b[1]) / 2 };
}

/**
 * Excalidraw elements -> stored fields per element id (no v, z or createdBy). Deleted elements are left out. A bound text
 * element is folded into its container as text/fontSize/fontFamily/labelId; its own position is not stored (derived).
 */
export function sceneToModels(elements: XEl[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const live = elements.filter((e) => !e.isDeleted);
  const ids = new Set(live.map((e) => e.id));
  for (const e of live) {
    if (e.type === 'text' && e.containerId && ids.has(e.containerId)) continue;
    const f: Record<string, unknown> = {};
    for (const k of FIELDS) if (!OWN.has(k) && e[k] !== undefined) f[k] = e[k];
    if (CONTAINERS.has(e.type) || e.type === 'arrow') {
      delete f.text, delete f.fontSize, delete f.fontFamily, delete f.textAlign, delete f.verticalAlign;
    }
    if (e.type !== 'frame') delete f.name;
    if (e.type === 'text') delete f.points;
    if (LINEAR.has(e.type)) delete f.width, delete f.height;
    if (e.startBinding) f.startBinding = pickBinding(e.startBinding);
    if (e.endBinding) f.endBinding = pickBinding(e.endBinding);
    out.set(e.id, f);
  }
  for (const e of live) {
    if (e.type !== 'text' || !e.containerId || !out.has(e.containerId)) continue;
    Object.assign(out.get(e.containerId)!, {
      text: e.originalText ?? e.text,
      fontSize: e.fontSize,
      fontFamily: e.fontFamily,
      labelId: e.id,
    });
  }
  for (const f of out.values()) if ((CONTAINERS.has(f.type as string) || f.type === 'arrow') && !('text' in f)) f.text = undefined;
  return out;
}

function pickBinding(b: XEl) {
  const o: XEl = { elementId: b.elementId, focus: b.focus ?? 0, gap: b.gap ?? 8 };
  if (b.fixedPoint) o.fixedPoint = b.fixedPoint;
  return o;
}
