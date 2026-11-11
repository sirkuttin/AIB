/**
 * The two-way binding between Excalidraw and the field-level Y.Map, without React, so Deno tests drive it with plain
 * element arrays exactly as the page does with Excalidraw's onChange.
 *
 *   Y -> Excalidraw: binding.scene() builds the element list for excalidrawAPI.updateScene (and remembers the versions it handed out).
 *   Excalidraw -> Y: binding.push(elements) writes only the fields that differ for elements whose Excalidraw version moved,
 *                    in one USER transaction (v bumped once per element).
 *   Awareness:       presence(appState, elements) is what the page publishes: the ids the user has selected, is dragging or
 *                    is editing text in (a label's id is reported as its container's).
 */
import { elementsMap, newElementMap, readModels, USER, writeFields, type Y } from './model.ts';
import { type Measure, modelsToScene, sceneToModels, type XEl } from './scene.ts';

export type Presence = { who: 'user' | 'agent'; drawing: string; selected: string[]; dragging: string[]; editing: string | null };

export class Binding {
  /** Excalidraw element id -> the version last exchanged with Y (handed out by scene() or written by push()). */
  private seen = new Map<string, number>();
  constructor(readonly doc: Y.Doc, readonly drawingId: string, readonly origin: unknown = USER) {}

  scene(measure?: Measure): XEl[] {
    const els = modelsToScene(readModels(this.doc, this.drawingId), measure);
    this.seen = new Map(els.map((e) => [e.id, e.version]));
    return els;
  }

  /** After the page has passed scene() through restoreElements: the versions Excalidraw now holds count as synced. */
  remember(elements: XEl[]) {
    for (const e of elements) this.seen.set(e.id, e.version);
  }

  /** Writes the user's changes. Returns the ids of the stored elements that changed, were made or were deleted. */
  push(elements: XEl[]): string[] {
    const changed = elements.filter((e) => this.seen.get(e.id) !== e.version);
    if (!changed.length) return [];
    const byId = new Map(elements.map((e) => [e.id, e]));
    const owners = new Set<string>();
    for (const e of changed) owners.add(e.type === 'text' && e.containerId && byId.has(e.containerId) ? e.containerId : e.id);
    const models = sceneToModels(elements);
    const ymap = elementsMap(this.doc, this.drawingId)!;
    const touched: string[] = [];
    this.doc.transact(() => {
      for (const id of owners) {
        const fields = models.get(id);
        const existing = ymap.get(id);
        if (!fields) {
          if (existing) ymap.delete(id), touched.push(id);
          continue;
        }
        if (existing) {
          if (writeFields(existing, fields)) touched.push(id);
        } else {
          ymap.set(id, newElementMap({ ...fields, createdBy: 'user', z: this.zFor(id, elements, ymap) }));
          touched.push(id);
        }
      }
    }, this.origin);
    for (const e of elements) this.seen.set(e.id, e.version);
    return touched;
  }

  /** A z between the stored neighbours of `id` in Excalidraw's order, so a new element lands where the user put it. */
  private zFor(id: string, elements: XEl[], ymap: Y.Map<Y.Map<unknown>>): number {
    const i = elements.findIndex((e) => e.id === id);
    const zOf = (e: XEl | undefined) => (e ? (ymap.get(e.id)?.get('z') as number | undefined) : undefined);
    let before: number | undefined, after: number | undefined;
    for (let j = i - 1; j >= 0 && before === undefined; j--) before = zOf(elements[j]);
    for (let j = i + 1; j < elements.length && after === undefined; j++) after = zOf(elements[j]);
    if (before === undefined && after === undefined) return 0;
    if (after === undefined) return before! + 1;
    if (before === undefined) return after - 1;
    return (before + after) / 2;
  }
}

// deno-lint-ignore no-explicit-any
export function presence(drawingId: string, appState: Record<string, any>, elements: XEl[]): Presence {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const owner = (id: string) => byId.get(id)?.containerId ?? id;
  const selected = Object.keys(appState.selectedElementIds ?? {}).filter((id) => appState.selectedElementIds[id]).map(owner);
  const moving = appState.selectedElementsAreBeingDragged || appState.isResizing || appState.isRotating;
  const editingText = appState.editingTextElement as XEl | null | undefined;
  const editing = editingText ? owner(editingText.id) : (appState.editingLinearElement?.elementId ?? null);
  return { who: 'user', drawing: drawingId, selected: [...new Set(selected)], dragging: moving ? [...new Set(selected)] : [], editing };
}

/** id -> what the user is doing with it, over every non-agent presence in the awareness states for this drawing. */
export function busyIds(states: Iterable<unknown>, drawingId: string): Map<string, 'selected' | 'dragging' | 'editing'> {
  const out = new Map<string, 'selected' | 'dragging' | 'editing'>();
  for (const s of states) {
    const p = s as Partial<Presence> | null;
    if (!p || p.who === 'agent' || p.drawing !== drawingId) continue;
    for (const id of p.selected ?? []) if (!out.has(id)) out.set(id, 'selected');
    for (const id of p.dragging ?? []) out.set(id, 'dragging');
    if (p.editing) out.set(p.editing, 'editing');
  }
  return out;
}
