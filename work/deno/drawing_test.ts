/**
 * Drawings on the doc core's Y.Doc (server/docs/drawing/): the trial's proofs, now on a LiveDoc. The "user" is a second Y.Doc with its own awareness and the page's
 * Binding, fed Excalidraw-shaped element arrays the way Excalidraw's onChange feeds the page. Updates travel only when a
 * test calls sync(), so a test can make the user's and the agent's edits truly concurrent.
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { readModels, USER } from '../../outputs/agent-studio/server/docs/drawing/model.ts';
import { LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { Binding, type Presence } from '../../outputs/agent-studio/server/docs/drawing/binding.ts';
import {
  drawing_edit,
  drawing_from_mermaid,
  drawing_read,
  type EditResult,
  type Op,
} from '../../outputs/agent-studio/server/docs/drawing/tools.ts';
import { exportJson, exportSvg, importJson, sceneFromSvg } from '../../outputs/agent-studio/server/docs/drawing/files.ts';
import { boxOf, overlaps } from '../../outputs/agent-studio/server/docs/drawing/geometry.ts';
import type { XEl } from '../../outputs/agent-studio/server/docs/drawing/scene.ts';

const D = 'd1';

class User {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  binding = new Binding(this.doc, D, USER);
  /** What Excalidraw holds right now. */
  elements: XEl[] = [];
  load() {
    this.elements = this.binding.scene();
  }
  /** One Excalidraw change: patch an element (bumping its version as Excalidraw does) and hand the list to the binding. */
  change(id: string, patch: Record<string, unknown>) {
    this.elements = this.elements.map((e) => (e.id === id ? { ...e, ...patch, version: e.version + 1 } : e));
    return this.binding.push(this.elements);
  }
  add(el: XEl) {
    this.elements = [...this.elements, { version: 1, isDeleted: false, ...el }];
    return this.binding.push(this.elements);
  }
  present(p: Partial<Presence>) {
    this.awareness.setLocalState({ who: 'user', drawing: D, selected: [], dragging: [], editing: null, ...p });
  }
  destroy() {
    this.awareness.destroy();
  }
}

function sync(hub: LiveDoc, user: User) {
  const a = Y.encodeStateAsUpdate(hub.doc, Y.encodeStateVector(user.doc));
  const b = Y.encodeStateAsUpdate(user.doc, Y.encodeStateVector(hub.doc));
  Y.applyUpdate(user.doc, a, 'remote');
  Y.applyUpdate(hub.doc, b, 'remote');
  applyAwarenessUpdate(hub.awareness, encodeAwarenessUpdate(user.awareness, [user.doc.clientID]), 'remote');
}

function setup() {
  const hub = new LiveDoc();
  const user = new User();
  return { hub, user, [Symbol.dispose]: () => (hub.destroy(), user.destroy()) };
}

function ok(res: EditResult): Extract<EditResult, { ok: true }> {
  if (!res.ok) throw new Error(`refused: ${JSON.stringify(res)}`);
  return res;
}
const el = (doc: Y.Doc, id: string) => readModels(doc, D).find((m) => m.id === id)!;
const edit = (hub: LiveDoc, ...ops: Op[]) => drawing_edit(hub, { drawing: D, ops });

Deno.test('the user moves box B while the agent set_texts B: both survive', () => {
  using t = setup();
  const { hub, user } = t;
  ok(edit(hub, { op: 'add_box', text: 'Build', id: 'B' }));
  sync(hub, user);
  user.load();
  const v = el(hub.doc, 'B').v;
  const x0 = el(hub.doc, 'B').x as number;

  // Concurrently: the user drags B (not yet seen by the server), the agent relabels B at the version it read.
  assertEquals(user.change('B', { x: x0 + 250, y: 400 }), ['B']);
  ok(edit(hub, { op: 'set_text', id: 'B', text: 'Build and test', ifV: v }));
  sync(hub, user);

  for (const doc of [hub.doc, user.doc]) {
    const b = el(doc, 'B');
    assertEquals([b.x, b.y, b.text], [x0 + 250, 400, 'Build and test']);
  }
  // And the page shows both: the label element carries the agent's text, at the user's position.
  user.load();
  const label = user.elements.find((e) => e.containerId === 'B')!;
  assertEquals(label.text, 'Build and test');
  assert(label.x > x0 + 250 && label.x < x0 + 250 + (el(hub.doc, 'B').width as number), 'label inside the moved box');
});

Deno.test("the agent's stale ifV is refused with the element as it is now", () => {
  using t = setup();
  const { hub, user } = t;
  ok(edit(hub, { op: 'add_box', text: 'Build', id: 'B' }));
  const read = el(hub.doc, 'B').v;
  sync(hub, user);
  user.load();
  user.change('B', { strokeColor: '#e03131' });
  sync(hub, user);

  const res = edit(hub, { op: 'set_text', id: 'B', text: 'Ship', ifV: read });
  assert(!res.ok);
  assertEquals([res.error, res.id], ['stale', 'B']);
  assert(res.current!.includes(`v=${read + 1}`), res.current);
  assertEquals(res.element!.strokeColor, '#e03131');
  assertEquals(el(hub.doc, 'B').text, 'Build');
});

Deno.test('the agent edits B while the user has B selected, is dragging it or is typing in it: user_editing', () => {
  using t = setup();
  const { hub, user } = t;
  ok(edit(hub, { op: 'add_box', text: 'Build', id: 'B' }, { op: 'add_box', text: 'Test', id: 'C', near: 'B' }));
  const v = el(hub.doc, 'B').v;

  for (const p of [{ selected: ['B'] }, { selected: ['B'], dragging: ['B'] }, { editing: 'B' }]) {
    user.present(p);
    sync(hub, user);
    assert(drawing_read(hub, { drawing: D }).text.split('\n').find((l) => l.startsWith('B '))!.includes('selectedByUser'));
    for (
      const op of [
        { op: 'set_text', id: 'B', text: 'x', ifV: v },
        { op: 'move', id: 'B', by: { dx: 10, dy: 0 }, ifV: v },
        { op: 'delete', id: 'B', ifV: v },
      ] as Op[]
    ) {
      const res = edit(hub, op);
      assert(!res.ok && res.error === 'user_editing', `${JSON.stringify(p)} ${op.op}: ${JSON.stringify(res)}`);
    }
  }
  // An implicit change counts too: moving C would re-route an arrow the user is dragging.
  ok(edit(hub, { op: 'add_arrow', from: 'B', to: 'C', id: 'a1' }));
  user.present({ selected: ['a1'], dragging: ['a1'] });
  sync(hub, user);
  const res = edit(hub, { op: 'move', id: 'C', by: { dx: 0, dy: 50 }, ifV: el(hub.doc, 'C').v });
  assert(!res.ok && res.error === 'user_editing' && res.id === 'a1', JSON.stringify(res));
  // Once the user lets go, the same edit goes through.
  user.present({});
  sync(hub, user);
  ok(edit(hub, { op: 'set_text', id: 'B', text: 'Build it', ifV: v }));
});

Deno.test('an atomic call with one bad op changes nothing', () => {
  using t = setup();
  const { hub } = t;
  ok(edit(hub, { op: 'add_box', text: 'Build', id: 'B' }));
  const before = Y.encodeStateVector(hub.doc);
  const v = el(hub.doc, 'B').v;
  for (
    const bad of [
      { op: 'move', id: 'nope', by: { dx: 1, dy: 1 }, ifV: 1 },
      { op: 'set_text', id: 'B', text: 'again', ifV: v + 7 },
      { op: 'add_arrow', from: 'B', to: 'missing' },
      { op: 'teleport', id: 'B' },
    ] as Op[]
  ) {
    const res = edit(hub, { op: 'set_text', id: 'B', text: 'Changed', ifV: v }, { op: 'add_box', text: 'New', near: 'B' }, bad);
    assert(!res.ok && res.op === 2, JSON.stringify(res));
    assertEquals(Y.encodeStateVector(hub.doc), before, `nothing written for ${bad.op}`);
  }
  assertEquals(readModels(hub.doc, D).map((m) => [m.id, m.text]), [['B', 'Build']]);
});

Deno.test('an arrow stays bound when its box moves (agent move, frame move)', () => {
  using t = setup();
  const { hub, user } = t;
  ok(
    edit(hub, { op: 'add_box', text: 'A', id: 'A' }, { op: 'add_box', text: 'B', id: 'B', near: 'A' }, {
      op: 'add_arrow',
      from: 'A',
      to: 'B',
      label: 'then',
      id: 'a1',
    }),
  );
  const end = () => {
    const a = el(hub.doc, 'a1');
    const pts = a.points as [number, number][];
    return { x: (a.x as number) + pts[pts.length - 1][0], y: (a.y as number) + pts[pts.length - 1][1] };
  };
  const near = (p: { x: number; y: number }, id: string) => {
    const b = boxOf(el(hub.doc, id));
    return p.x >= b.x - 12 && p.x <= b.x + b.w + 12 && p.y >= b.y - 12 && p.y <= b.y + b.h + 12;
  };
  assert(near(end(), 'B'));
  ok(edit(hub, { op: 'move', id: 'B', by: { dx: 120, dy: 300 }, ifV: el(hub.doc, 'B').v }));
  const a = el(hub.doc, 'a1');
  assertEquals([(a.startBinding as { elementId: string }).elementId, (a.endBinding as { elementId: string }).elementId], ['A', 'B']);
  assert(near(end(), 'B'), `arrow end ${JSON.stringify(end())} follows B ${JSON.stringify(boxOf(el(hub.doc, 'B')))}`);
  assertEquals(a.text, 'then');
  // The page sees B's boundElements list the arrow (derived), so Excalidraw keeps dragging it along.
  sync(hub, user);
  user.load();
  const b = user.elements.find((e) => e.id === 'B')!;
  assert(b.boundElements.some((x: { id: string }) => x.id === 'a1'));
  // A frame move carries its children and their arrows.
  ok(edit(hub, { op: 'add_frame', title: 'Flow', around: ['A', 'B'], id: 'f1' }));
  ok(edit(hub, { op: 'move', id: 'f1', by: { dx: -500, dy: 0 }, ifV: el(hub.doc, 'f1').v }));
  assert(near(end(), 'B'));
});

Deno.test('JSON round-trip: export, import into a fresh drawing, export again; and back into the same drawing with guards', () => {
  using t = setup();
  const { hub, user } = t;
  ok(edit(hub, { op: 'add_box', text: 'Plan', id: 'P' }, { op: 'add_box', text: 'Build', near: 'P', id: 'B', shape: 'diamond' }));
  ok(
    edit(hub, { op: 'add_arrow', from: 'P', to: 'B', label: 'go', id: 'a1' }, {
      op: 'add_frame',
      title: 'Release',
      around: ['P', 'B'],
      id: 'f1',
    }),
  );
  sync(hub, user);
  user.load();
  user.add({ id: 'u1', type: 'ellipse', x: -400, y: -300, width: 120, height: 80, strokeColor: '#1971c2' });
  user.add({ id: 'u1-t', type: 'text', containerId: 'u1', text: 'Mine', originalText: 'Mine', fontSize: 20, fontFamily: 5, x: 0, y: 0 });
  sync(hub, user);
  assertEquals([el(hub.doc, 'u1').createdBy, el(hub.doc, 'u1').text], ['user', 'Mine']);

  const json = exportJson(hub, D);
  const fresh = new LiveDoc();
  try {
    const res = importJson(fresh, D, json);
    assertEquals(res.refused, []);
    const strip = (s: string) =>
      JSON.parse(s).elements.map((e: XEl) => ({ ...e, customData: undefined, version: undefined, versionNonce: undefined }));
    assertEquals(strip(exportJson(fresh, D)), strip(json));
  } finally {
    fresh.destroy();
  }
  // The SVG carries the same scene, and draws the shapes.
  const svg = exportSvg(hub, D);
  assert(svg.includes('<!-- svg-source:excalidraw -->') && svg.includes('>Plan<') && svg.includes('<polygon'), 'svg body');
  return sceneFromSvg(svg).then((embedded) => {
    assertEquals(JSON.parse(embedded), JSON.parse(json));

    // An agent edits the file with file tools: renames B, moves P, deletes its own box... while the user recolours B.
    const data = JSON.parse(json);
    for (const e of data.elements as XEl[]) {
      if (e.containerId === 'B') e.text = e.originalText = 'Build v2';
      if (e.id === 'P') e.x += 40;
    }
    user.change('B', { strokeColor: '#2f9e44' });
    sync(hub, user);
    const back = importJson(hub, D, JSON.stringify(data));
    assertEquals(back.refused.map((r) => [r.id, r.error]), [['B', 'stale']]);
    assert(back.applied.includes('P'));
    assertEquals(el(hub.doc, 'P').x, JSON.parse(json).elements.find((e: XEl) => e.id === 'P').x + 40);
    assertEquals(el(hub.doc, 'B').text, 'Build');
    assertEquals(el(hub.doc, 'B').strokeColor, '#2f9e44');

    // Removing the user's ellipse from the file is a delete that needs allowDetach.
    const fresh2 = JSON.parse(exportJson(hub, D));
    fresh2.elements = fresh2.elements.filter((e: XEl) => e.id !== 'u1' && e.containerId !== 'u1');
    const del = importJson(hub, D, JSON.stringify(fresh2));
    assertEquals(del.refused.map((r) => [r.id, r.error]), [['u1', 'needs_allowDetach']]);
    assert(el(hub.doc, 'u1'));
    assertEquals(importJson(hub, D, JSON.stringify(fresh2), { allowDetach: true }).refused, []);
    assertEquals(el(hub.doc, 'u1'), undefined);
  });
});

Deno.test('deleting a user-made element needs allowDetach; the agent deletes its own freely', () => {
  using t = setup();
  const { hub, user } = t;
  ok(edit(hub, { op: 'add_box', text: 'Mine', id: 'A' }));
  sync(hub, user);
  user.load();
  user.add({ id: 'U', type: 'rectangle', x: 600, y: 600, width: 100, height: 60 });
  sync(hub, user);
  const res = edit(hub, { op: 'delete', id: 'U', ifV: el(hub.doc, 'U').v });
  assert(!res.ok && res.error === 'needs_allowDetach', JSON.stringify(res));
  ok(edit(hub, { op: 'delete', id: 'U', ifV: el(hub.doc, 'U').v, allowDetach: true }));
  ok(edit(hub, { op: 'delete', id: 'A', ifV: el(hub.doc, 'A').v }));
  assertEquals(readModels(hub.doc, D), []);
});

Deno.test('new shapes land in free space: near, in a frame (which grows), at a taken spot', () => {
  using t = setup();
  const { hub, user } = t;
  sync(hub, user);
  user.load();
  user.add({ id: 'U', type: 'rectangle', x: 0, y: 0, width: 300, height: 200 });
  sync(hub, user);
  ok(
    edit(hub, { op: 'add_box', text: 'one', near: 'U' }, { op: 'add_box', text: 'two', near: 'U' }, {
      op: 'add_box',
      text: 'three',
      near: 'U',
    }),
  );
  ok(edit(hub, { op: 'add_box', text: 'on top?', at: { x: 10, y: 10 } }));
  ok(edit(hub, { op: 'add_frame', title: 'Group', around: ['b1', 'b2'] }));
  ok(edit(hub, { op: 'add_box', text: 'inside 1', in: 'f1' }, { op: 'add_box', text: 'inside 2', in: 'f1' }));
  const solids = readModels(hub.doc, D).filter((m) => m.type !== 'frame');
  for (const a of solids) for (const b of solids) if (a.id < b.id) assert(!overlaps(boxOf(a), boxOf(b)), `${a.id} overlaps ${b.id}`);
  const f = boxOf(el(hub.doc, 'f1'));
  for (const id of ['b5', 'b6']) {
    const b = boxOf(el(hub.doc, id));
    assertEquals(el(hub.doc, id).frameId, 'f1');
    assert(b.x >= f.x && b.y >= f.y && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h, `${id} inside f1`);
  }
});

Deno.test('the binding: a user-made box with a typed label lands field by field; drawing_read shows it compactly', () => {
  using t = setup();
  const { hub, user } = t;
  sync(hub, user);
  user.load();
  user.add({ id: 'r1', type: 'rectangle', x: 10, y: 20, width: 200, height: 80 });
  user.add({ id: 'r1-t', type: 'text', containerId: 'r1', text: 'Hel', originalText: 'Hel', fontSize: 20, fontFamily: 5, x: 0, y: 0 });
  user.change('r1-t', { text: 'Hello', originalText: 'Hello' });
  sync(hub, user);
  const m = el(hub.doc, 'r1');
  assertEquals([m.text, m.labelId, m.createdBy, m.x, m.width], ['Hello', 'r1-t', 'user', 10, 200]);
  ok(edit(hub, { op: 'add_box', text: 'Agent', near: 'r1', id: 'b1' }, { op: 'add_arrow', from: 'r1', to: 'b1', id: 'a1' }));
  const text = drawing_read(hub, { drawing: D }).text;
  assert(/^r1 rectangle "Hello" x=10 y=20 w=200 h=80 out=a1 v=\d+ by=user$/m.test(text), text);
  assert(/^a1 arrow from=r1 to=b1 v=1 by=agent$/m.test(text), text);
  // Deleting in Excalidraw (isDeleted) removes the element from the Y map.
  user.change('r1', { isDeleted: true });
  sync(hub, user);
  assertEquals(el(hub.doc, 'r1'), undefined);
});

Deno.test('drawing_from_mermaid makes a first draft of editable, bound shapes, headless', async () => {
  using t = setup();
  const { hub } = t;
  ok(edit(hub, { op: 'add_box', text: 'Existing', id: 'X' }));
  const res = ok(
    await drawing_from_mermaid(hub, {
      drawing: D,
      mermaid: 'flowchart TD\n A[Start] --> B{Ok?}\n B -->|yes| C[Ship]\n B -->|no| D[Fix]\n D --> A',
    }),
  );
  assertEquals(res.created.length, 8); // 4 nodes, 4 arrows
  const ms = readModels(hub.doc, D);
  assertEquals(ms.find((m) => m.id === 'm1_B')!.type, 'diamond');
  assertEquals(ms.find((m) => m.id === 'm1_C')!.text, 'Ship');
  const arrow = ms.find((m) => m.id === 'm1_B_C')!;
  assertEquals(
    [(arrow.startBinding as { elementId: string }).elementId, (arrow.endBinding as { elementId: string }).elementId, arrow.text],
    ['m1_B', 'm1_C', 'yes'],
  );
  for (const m of ms.filter((m) => m.id.startsWith('m1_') && m.type !== 'arrow')) {
    assert(!overlaps(boxOf(m), boxOf(el(hub.doc, 'X'))), `${m.id} clear of X`);
  }
  // The draft is then edited by id like anything else.
  ok(edit(hub, { op: 'set_text', id: 'm1_D', text: 'Fix it', ifV: 1 }));
  const bad = await drawing_from_mermaid(hub, { drawing: D, mermaid: 'sequenceDiagram\n A->>B: hi' });
  assert(!bad.ok, JSON.stringify(bad));
});
