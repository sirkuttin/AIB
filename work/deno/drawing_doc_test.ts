/**
 * Drawings inside a doc (server/docs/drawing/ on the doc core): the drawing block in the schema and the Markdown copy, the agent's
 * drawing tools through runDocTool, a drawing surviving a restart, the Markdown round trip with the drawing's .excalidraw and
 * .excalidraw.svg files, and a file-tool edit of the .excalidraw JSON taken in element by element with the guards, where the user's
 * selection arrives through the doc socket's awareness.
 */
import { assert, assertEquals } from './_assert.ts';
import * as encoding from 'lib0/encoding';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { DocStore, mdBody, type OpenDoc } from '../../outputs/agent-studio/server/docs/store.ts';
import { runDocTool } from '../../outputs/agent-studio/server/docs/tools.ts';
import { parseBlockMarkdown, serializeBlock } from '../../outputs/agent-studio/server/docs/markdown.ts';
import { readModels, USER } from '../../outputs/agent-studio/server/docs/drawing/model.ts';
import { Binding } from '../../outputs/agent-studio/server/docs/drawing/binding.ts';
import type { XEl } from '../../outputs/agent-studio/server/docs/drawing/scene.ts';
import { UserClient } from './_docs.ts';
import { studioAsset } from '../../outputs/agent-studio/server/web/server.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
type Json = Record<string, unknown>;

async function tempDirs() {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-drawing-doc-' })).replace(/^\\\\\?\\/, '');
  const state = `${root}${sep}state`, project = `${root}${sep}project`;
  await Deno.mkdir(state), await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  return { root, state, project, done: () => Deno.remove(root, { recursive: true }).catch(() => {}) };
}

/** An agent's tool call; throws on a refusal unless `refused` is asked for. */
async function tool(store: DocStore, project: string, name: string, args: Json, refused = false): Promise<Json> {
  const [ok, result] = await runDocTool(store, project, 'claude', name, args);
  if (ok === refused) throw new Error(`${name} ${refused ? 'went through' : 'was refused'}: ${JSON.stringify(result)}`);
  return result;
}

const lineOf = (text: string, id: string) => text.split('\n').find((l) => l.startsWith(id + ' ')) ?? '';
const vOf = (text: string, id: string) => Number(/ v=(\d+)/.exec(lineOf(text, id))?.[1]);

Deno.test('the drawing block: Markdown picture in, the same picture out; other images stay images', () => {
  const md = '![Release flow](plan.assets/release-flow.excalidraw.svg)';
  const [node] = parseBlockMarkdown(md);
  assertEquals(node, {
    type: 'drawing',
    attrs: { drawing: 'release-flow', caption: 'Release flow', src: 'plan.assets/release-flow.excalidraw.svg' },
  });
  assertEquals(serializeBlock(node), md);
  const spaced = '![A *starred* [flow]](<my plan.assets/d-2.excalidraw.svg>)';
  const [n2] = parseBlockMarkdown(spaced);
  assertEquals([n2.type, n2.attrs?.drawing, n2.attrs?.src], ['drawing', 'd-2', 'my plan.assets/d-2.excalidraw.svg']);
  assertEquals(parseBlockMarkdown(serializeBlock(n2)), [n2]);
  for (
    const other of [
      '![x](pic.svg)', // not in an assets folder
      '![x](plan.assets/x.svg)', // not a drawing
      'See ![x](plan.assets/x.excalidraw.svg) here', // in text
      '![x](plan.assets/x.excalidraw.svg "titled")', // a title is kept: an image
      '[![x](plan.assets/x.excalidraw.svg)](https://example.com)', // a linked image
      '![x](../plan.assets/x.excalidraw.svg)', // outside the docs folder
    ]
  ) assertEquals(parseBlockMarkdown(other)[0].type, 'paragraph', other);
});

Deno.test('the drawing tools through runDocTool: create in a doc, read, edit, Mermaid; refusals carry a code', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  try {
    await tool(store, dirs.project, 'doc_create', { doc: 'plan', markdown: '# Plan\n\nIntro.\n\n## Later\n' });
    const intro = ((await tool(store, dirs.project, 'doc_read', { doc: 'plan' })).blocks as { id: string; md?: string }[])
      .find((b) => b.md === 'Intro.')!.id;
    const made = await tool(store, dirs.project, 'drawing_create', { doc: 'plan', caption: 'Release flow', after: intro });
    assertEquals(made.drawing, 'release-flow');
    const again = await tool(store, dirs.project, 'drawing_create', {
      doc: 'plan',
      caption: 'Release flow',
      mermaid: 'flowchart LR\n A[Plan] --> B[Ship]',
    });
    assertEquals(again.drawing, 'release-flow-2');
    assertEquals((again.mermaid as Json).created, ['m1_A', 'm1_B', 'm1_A_B']);
    // The block sits after "Intro." and doc_read shows it as its Markdown picture.
    const blocks = (await tool(store, dirs.project, 'doc_read', { doc: 'plan' })).blocks as { id: string; type: string; md?: string }[];
    assertEquals(blocks.map((b) => b.type), ['heading', 'paragraph', 'drawing', 'heading', 'drawing']);
    assertEquals(blocks[2].md, '![Release flow](assets/release-flow.excalidraw.svg)');
    assertEquals(blocks[2].id, made.block);

    const ack = await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'release-flow',
      ops: [{ op: 'add_box', text: 'Build', id: 'B' }, { op: 'add_box', text: 'Test', near: 'B', id: 'T' }, {
        op: 'add_arrow',
        from: 'B',
        to: 'T',
      }],
    });
    assertEquals(ack.created, ['B', 'T', 'a1']);
    const read = (await tool(store, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'release-flow' })).text as string;
    assert(/^B rectangle "Build" x=\d+ y=\d+ w=160 h=70 out=a1 v=1 by=agent$/m.test(read), read);
    const list = (await tool(store, dirs.project, 'drawing_read', { doc: 'plan' })).drawings as Json[];
    assertEquals(list.map((d) => [d.drawing, d.caption, d.shapes]), [['release-flow', 'Release flow', 3], [
      'release-flow-2',
      'Release flow',
      3,
    ]]);

    const stale = await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'release-flow',
      ops: [{ op: 'set_text', id: 'B', text: 'x', ifV: 7 }],
    }, true);
    assertEquals([stale.code, stale.id], ['stale', 'B']);
    const internal = await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'release-flow',
      ops: [{ op: 'add_raw', element: { id: 'z', type: 'rectangle' } }],
    }, true);
    assertEquals(internal.code, 'bad_op');
    const missing = await tool(store, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'nope' }, true);
    assertEquals(missing.code, 'no_drawing');
    assert(String(missing.message).includes('release-flow, release-flow-2'), String(missing.message));
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('a drawing inside a doc survives a restart; its files sit next to the Markdown copy', async () => {
  const dirs = await tempDirs();
  let store = new DocStore(dirs.state, { idleMs: 60_000 });
  const assets = `${dirs.project}${sep}docs${sep}plan${sep}assets${sep}`;
  let before = '';
  try {
    await tool(store, dirs.project, 'doc_create', { doc: 'plan', markdown: '# Plan\n' });
    await tool(store, dirs.project, 'drawing_create', { doc: 'plan', caption: 'Flow' });
    await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'flow',
      ops: [{ op: 'add_box', text: 'Build', id: 'B' }, { op: 'add_box', text: 'Ship', near: 'B', id: 'S' }, {
        op: 'add_arrow',
        from: 'B',
        to: 'S',
      }],
    });
    const v = vOf((await tool(store, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'flow' })).text as string, 'B');
    const open = await store.open(dirs.project, 'plan');
    await store.flush(open);
    assert(!open.dirty);
    await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'flow',
      ops: [{ op: 'set_text', id: 'B', text: 'Build it', ifV: v }],
    });
    assert(open.dirty, 'a change to shapes alone marks the doc for saving');
    assert(open.timer !== null, 'and starts the idle save');
    before = (await tool(store, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'flow' })).text as string;
    await store.close();

    // The files: the Markdown links the picture; the JSON and the SVG hold the scene.
    assertEquals(
      mdBody(await Deno.readTextFile(`${dirs.project}${sep}docs${sep}plan${sep}01-page-1.md`)),
      '# Plan\n\n![Flow](assets/flow.excalidraw.svg)\n',
    );
    const json = JSON.parse(await Deno.readTextFile(`${assets}flow.excalidraw`));
    assertEquals(json.type, 'excalidraw');
    assert(json.elements.some((e: XEl) => e.containerId === 'B' && e.text === 'Build it'));
    const svg = await Deno.readTextFile(`${assets}flow.excalidraw.svg`);
    assert(svg.includes('>Build it<') && svg.includes('payload-start'), 'svg');

    // Without the files: the shapes come back from the saved state alone (and the files are written again).
    await Deno.remove(assets, { recursive: true });
    store = new DocStore(dirs.state, { idleMs: 60_000 });
    const after = (await tool(store, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'flow' })).text as string;
    assertEquals(after, before);
    // And the next edit goes on from the saved versions.
    await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'flow',
      ops: [{ op: 'move', id: 'S', by: { dx: 0, dy: 100 }, ifV: vOf(after, 'S') }],
    });
    await store.flush(await store.open(dirs.project, 'plan'));
    assert(JSON.parse(await Deno.readTextFile(`${assets}flow.excalidraw`)).elements.length > 3);
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('Markdown round trip with a drawing: read in from the .md and its files, byte for byte; from the SVG alone too', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  const md = `${dirs.project}${sep}docs${sep}plan${sep}01-page-1.md`;
  const assets = `${dirs.project}${sep}docs${sep}plan${sep}assets${sep}`;
  try {
    await tool(store, dirs.project, 'doc_create', { doc: 'plan', markdown: '# Plan\n\nIntro.\n' });
    await tool(store, dirs.project, 'drawing_create', { doc: 'plan', caption: 'Release flow' });
    await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'release-flow',
      ops: [
        { op: 'add_box', text: 'Plan', id: 'P' },
        { op: 'add_box', text: 'Ship', near: 'P', id: 'S', shape: 'diamond' },
        { op: 'add_arrow', from: 'P', to: 'S', label: 'go' },
        { op: 'add_frame', title: 'Release', around: ['P', 'S'] },
      ],
    });
    // A shape the user drew keeps being the user's through the files.
    const doc = await store.open(dirs.project, 'plan');
    const user = new Binding(doc.live.doc, 'release-flow', USER);
    user.scene();
    user.push([...user.scene(), { id: 'u1', type: 'ellipse', x: -500, y: -400, width: 120, height: 80, version: 1, isDeleted: false }]);
    await store.flush(doc);
    const text = await Deno.readTextFile(md);
    assertEquals(mdBody(text), '# Plan\n\nIntro.\n\n![Release flow](assets/release-flow.excalidraw.svg)\n');
    const json = await Deno.readTextFile(`${assets}release-flow.excalidraw`);
    const svg = await Deno.readTextFile(`${assets}release-flow.excalidraw.svg`);
    const shapes = (s: string) => s.split('\n').slice(1).map((l) => l.replace(/ v=\d+/, '')).sort();
    const want = shapes((await tool(store, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'release-flow' })).text as string);
    assert(want.some((l) => /^u1 ellipse .* by=user$/.test(l)), want.join('\n'));
    await store.close();

    // A fresh AIB (no saved state, e.g. a clone): the doc is rebuilt from doc.aibdoc; the drawing's files agree with it.
    for (const from of ['json', 'svg only']) {
      if (from === 'svg only') await Deno.remove(`${assets}release-flow.excalidraw`);
      const fresh = new DocStore(`${dirs.root}${sep}state-${from.replace(' ', '-')}`, { idleMs: 60_000 });
      try {
        const blocks = (await tool(fresh, dirs.project, 'doc_read', { doc: 'plan' })).blocks as { type: string }[];
        assertEquals(blocks.map((b) => b.type), ['heading', 'paragraph', 'drawing'], from);
        const got = shapes((await tool(fresh, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'release-flow' })).text as string);
        assertEquals(got, want, from);
        await fresh.flush(await fresh.open(dirs.project, 'plan'));
        assertEquals(await Deno.readTextFile(md), text, from);
        // The picture is drawn the same (the embedded scene differs in versions only: a rebuilt drawing starts at v=1).
        const drawn = (s: string) => s.replace(/<metadata>.*<\/metadata>/s, '');
        assertEquals(drawn(await Deno.readTextFile(`${assets}release-flow.excalidraw.svg`)), drawn(svg), from);
        if (from === 'json') {
          const strip = (s: string) => JSON.parse(s, (k, v) => (['version', 'versionNonce', 'versions'].includes(k) ? undefined : v));
          assertEquals(strip(await Deno.readTextFile(`${assets}release-flow.excalidraw`)), strip(json));
        } else assert(await Deno.stat(`${assets}release-flow.excalidraw`), 'the JSON is written again');
      } finally {
        await fresh.close();
      }
    }
  } finally {
    await dirs.done();
  }
});

/** The user's presence in a drawing, sent the way the page sends it: an awareness message over the doc socket. */
function present(user: UserClient, p: Json) {
  const awareness = new Awareness(user.doc);
  awareness.setLocalState({ who: 'user', drawing: 'flow', selected: [], dragging: [], editing: null, ...p });
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, [user.doc.clientID]));
  user.link.onmessage!(encoding.toUint8Array(e));
  awareness.destroy();
}

Deno.test('a file-tool edit of the .excalidraw JSON is taken in element by element, with the guards; refusals are kept', async () => {
  const dirs = await tempDirs();
  const store = new DocStore(dirs.state, { idleMs: 60_000 });
  const path = `${dirs.project}${sep}docs${sep}plan${sep}assets${sep}flow.excalidraw`;
  try {
    await tool(store, dirs.project, 'doc_create', { doc: 'plan', markdown: '# Plan\n' });
    await tool(store, dirs.project, 'drawing_create', { doc: 'plan', caption: 'Flow' });
    await tool(store, dirs.project, 'drawing_edit', {
      doc: 'plan',
      drawing: 'flow',
      ops: ['A', 'B', 'C'].map((id) => ({ op: 'add_box', text: `Box ${id}`, id })),
    });
    const doc: OpenDoc = await store.open(dirs.project, 'plan');
    await store.flush(doc);
    const exported = await Deno.readTextFile(path);

    // The user, on the doc socket: selects B, and recolours C in Excalidraw (after the export).
    const user = new UserClient(doc.live);
    const binding = new Binding(user.doc, 'flow', USER);
    let els = binding.scene();
    els = els.map((e) => (e.id === 'C' ? { ...e, strokeColor: '#e03131', version: e.version + 1 } : e));
    binding.push(els);
    present(user, { selected: ['B'] });
    assert(
      lineOf((await tool(store, dirs.project, 'drawing_read', { doc: 'plan', drawing: 'flow' })).text as string, 'B').includes(
        'selectedByUser',
      ),
    );

    // An agent edits the JSON with file tools: relabels A, B and C, moves A, adds a box N.
    const data = JSON.parse(exported);
    for (const e of data.elements as XEl[]) {
      if (e.containerId) e.text = e.originalText = `${e.text} v2`;
      if (e.id === 'A') e.x += 40;
    }
    data.elements.push({ id: 'N', type: 'rectangle', x: 900, y: 900, width: 120, height: 60, version: 1 });
    await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
    await store.syncMirror(doc);

    const models = new Map(readModels(doc.live.doc, 'flow').map((m) => [m.id, m]));
    assertEquals(models.get('A')!.text, 'Box A v2');
    assertEquals(models.get('A')!.x, data.elements.find((e: XEl) => e.id === 'A').x);
    assertEquals(models.get('B')!.text, 'Box B'); // the user has it selected
    assertEquals([models.get('C')!.text, models.get('C')!.strokeColor], ['Box C', '#e03131']); // changed by the user since the export
    assertEquals([models.get('N')!.type, models.get('N')!.createdBy], ['rectangle', 'agent']);
    assertEquals(doc.skipped.map((s) => [s.reason, s.id]).sort(), [['refused', 'flow/B'], ['refused', 'flow/C']]);
    assert(doc.skipped.find((s) => s.id === 'flow/B')!.file.includes('The user is selecting B'), JSON.stringify(doc.skipped));
    assert(doc.skipped.find((s) => s.id === 'flow/C')!.file.includes('changed since you read it'), JSON.stringify(doc.skipped));

    // The file is written again from the doc (the refused edits are not left standing), and a second sync changes nothing.
    const now = JSON.parse(await Deno.readTextFile(path));
    assertEquals(now.elements.find((e: XEl) => e.containerId === 'B').text, 'Box B');
    const count = doc.skipped.length;
    await store.syncMirror(doc);
    assertEquals(doc.skipped.length, count);
    // Not JSON: refused as a whole, the doc stands, the file is written again.
    await Deno.writeTextFile(path, '{ not json');
    await store.syncMirror(doc);
    assertEquals(doc.skipped.at(-1)!.id, 'flow');
    assertEquals(JSON.parse(await Deno.readTextFile(path)).type, 'excalidraw');
    doc.live.detach(user.link);
  } finally {
    await store.close();
    await dirs.done();
  }
});

Deno.test('Studio serves the Excalidraw bundle (code, chunks, CSS, fonts), not the server-only Mermaid converter', () => {
  for (
    const path of [
      'drawing.js',
      'drawing.css',
      'chunks/24BXRY42-IYCRJHVD.js',
      'assets/Assistant-Bold-ZDZZ6JHA.woff2',
      'fonts/Excalifont/Excalifont-Regular-349fac6ca4700ffec595a7150a0d1e1d.woff2',
    ]
  ) assertEquals(studioAsset(`/vendor/excalidraw/${path}`), `vendor/excalidraw/${path}`, path);
  for (
    const path of ['mermaid_headless.js', 'VERSIONS.txt', 'LICENSE-yjs', 'chunks/../drawing.js', 'fonts/../../docs/editor.js', 'missing.js']
  ) assertEquals(studioAsset(`/vendor/excalidraw/${path}`), null, path);
});
