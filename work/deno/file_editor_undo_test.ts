/**
 * The file editor's undo history (owner 2026-11-17: "if a user edits a file and closes the file tab but then reopens it, I want the
 * undo/redo history to persist"). The history is the server's (files/live_file.ts: one Y.UndoManager per file that tracks the page
 * sockets' edits, stored with the Y update), so it outlives the tab. Temp folders only; the file socket on a test web server.
 *   - every edit steps back in order and redoes; an agent's change merged between edits is never undone
 *   - closing the file (let go from memory after the grace) and opening it again keeps it, across a save and a disk change meanwhile
 *   - "Don't save" in the last view keeps it: the drop is one more undo step
 *   - a restart keeps it, including bringing back deleted text (kept from Yjs' GC) and Yjs' redone links
 *   - at most 500 steps, oldest dropped, the text untouched; the history ends when the file is deleted or the project removed
 *   - over the socket: {type: 'undo'} from a page, the caret offset back; two windows share one history; a new socket (a reload) too
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { LiveFiles } from '../../app/server/files/live_files.ts';
import { type LiveFile, TEST_PAGE_ORIGIN, UNDO_LIMIT } from '../../app/server/files/live_file.ts';
import { makeContext, WebServer } from '../../app/server/web/server.ts';
import type { LiveBackend } from '../../app/server/host/backend.ts';
import type { UpdateService } from '../../app/server/desktop/updater.ts';
import type { Source } from '../../app/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const FAST = { pollMs: 200, tickMs: 100, settleMs: 60, storeMs: 50, closeGraceMs: 300, saveWaitMs: 600 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function temp(prefix: string): Promise<string> {
  return Deno.realPathSync(await Deno.makeTempDir({ prefix })).replace(/^\\\\\?\\/, '');
}
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}
const host = () => ({
  liveCall: (name: string) => Promise.resolve([200, name === 'files-changed' ? { instance: 'i', seq: 0, events: [] } : { chats: [] }] as [number, unknown]),
  conversations: () => [],
  connectionOf: () => null,
});
function files(state: string): LiveFiles {
  const f = new LiveFiles({ stateDir: state, ...host() }, FAST);
  f.start();
  return f;
}
function open(f: LiveFiles, dir: string, rel: string): LiveFile {
  const got = f.open(dir, rel);
  assert('file' in got, `opens ${rel}`);
  return (got as { file: LiveFile }).file;
}
/** A page edit (one undo step of its own). */
function edit(lf: LiveFile, work: (t: Y.Text) => void): void {
  lf.undo.stopCapturing();
  lf.doc.transact(() => work(lf.text), TEST_PAGE_ORIGIN);
  lf.undo.stopCapturing();
}
const typeAt = (lf: LiveFile, at: number, s: string) => edit(lf, (t) => t.insert(at, s));
const typeEnd = (lf: LiveFile, s: string) => edit(lf, (t) => t.insert(t.length, s));
const cut = (lf: LiveFile, at: number, n: number) => edit(lf, (t) => t.delete(at, n));
const storeFiles = (f: LiveFiles) => {
  const out: string[] = [];
  try {
    for (const d of Deno.readDirSync(f.storeDir)) for (const x of Deno.readDirSync(f.storeDir + sep + d.name)) if (x.name.endsWith('.json')) out.push(x.name);
  } catch { /* none */ }
  return out;
};

Deno.test('every edit steps back in order and redoes; an agent change merged between edits is never undone', async () => {
  const state = await temp('aib-undo-state-'), dir = await temp('aib-undo-proj-');
  const file = `${dir}${sep}a.txt`;
  Deno.writeTextFileSync(file, 'one\ntwo\nthree\n');
  const f = files(state);
  try {
    const lf = open(f, dir, 'a.txt');
    typeEnd(lf, 'A');
    typeEnd(lf, 'B');
    await sleep(50);
    Deno.writeTextFileSync(file, 'ONE agent\ntwo\nthree\n' + lf.text.toString().slice('one\ntwo\nthree\n'.length)); // the agent's write
    await f.check(lf, true);
    assertEquals(lf.text.toString(), 'ONE agent\ntwo\nthree\nAB');
    typeEnd(lf, 'C');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'ONE agent\ntwo\nthree\nAB');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'ONE agent\ntwo\nthree\nA');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'ONE agent\ntwo\nthree\n', "the agent's line stays: only the person's edits are undone");
    assertEquals(lf.step('undo').ok, false, 'nothing more to undo');
    for (const want of ['A', 'AB', 'ABC']) {
      assertEquals(lf.step('redo').ok, true);
      assertEquals(lf.text.toString(), 'ONE agent\ntwo\nthree\n' + want);
    }
    assertEquals(lf.step('redo').ok, false);
  } finally {
    f.close();
  }
});

Deno.test('closing the file and opening it again keeps the history: across a save, a disk change meanwhile, and Don\'t save', async () => {
  const state = await temp('aib-undo-state-'), dir = await temp('aib-undo-proj-');
  const file = `${dir}${sep}b.txt`;
  Deno.writeTextFileSync(file, 'base\n');
  const f = files(state);
  try {
    let lf = open(f, dir, 'b.txt');
    const id = lf.id, lineage = lf.lineage;
    typeEnd(lf, 'one\n');
    typeEnd(lf, 'two\n');
    assertEquals((await f.save(id, {})).ok, true);
    cut(lf, 0, 'base\n'.length); // a delete: undo must bring the text back
    assertEquals((await f.save(id, {})).ok, true);
    assertEquals(Deno.readTextFileSync(file), 'one\ntwo\n');
    f.closeView(id, 'v1', false);
    await until(() => f.get(id) === null, 'let go from memory after the grace');
    assertEquals(storeFiles(f).length, 1, 'stored with its history');
    // while closed, an agent appends a line
    Deno.writeTextFileSync(file, 'one\ntwo\nagent\n');
    lf = open(f, dir, 'b.txt');
    assertEquals(lf.lineage, lineage, 'the same lineage: the stored steps still apply');
    assertEquals(lf.text.toString(), 'one\ntwo\nagent\n', 'the disk change merged in on open');
    assert(lf.isClean(), 'nothing unsaved');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'base\none\ntwo\nagent\n', 'the deleted text is back');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'base\none\nagent\n');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'base\nagent\n', "back to before every edit; the agent's line stays");
    lf.step('redo');
    lf.step('redo');
    lf.step('redo');
    assertEquals(lf.text.toString(), 'one\ntwo\nagent\n', 'redo all the way');
    // Don't save in the last view: the text goes back to the disk's, as one more step
    typeEnd(lf, 'unsaved\n');
    assertEquals(f.closeView(id, 'v1', true), { closed: true, discarded: true });
    assertEquals(lf.text.toString(), 'one\ntwo\nagent\n', "Don't save drops the unsaved text");
    assertEquals(Deno.readTextFileSync(file), 'one\ntwo\nagent\n', 'and writes nothing');
    await until(() => f.get(id) === null, 'let go again');
    lf = open(f, dir, 'b.txt');
    assertEquals(lf.text.toString(), 'one\ntwo\nagent\n', 'opens with the disk text');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'one\ntwo\nagent\nunsaved\n', "Ctrl+Z brings back what Don't save dropped");
  } finally {
    f.close();
  }
});

Deno.test('a restart keeps the history: deleted text comes back, redone links hold, unsaved and clean files alike', async () => {
  const state = await temp('aib-undo-state-'), dir = await temp('aib-undo-proj-');
  Deno.writeTextFileSync(`${dir}${sep}c.txt`, 'keep\n');
  Deno.writeTextFileSync(`${dir}${sep}d.txt`, 'xyz\n');
  let f = files(state);
  let c = open(f, dir, 'c.txt'), d = open(f, dir, 'd.txt');
  const cid = c.id, did = d.id;
  // c: insert X, then delete it in a later step, then undo that delete (Yjs sets X.redone, in memory only); saved, so clean
  typeAt(c, 0, 'X');
  cut(c, 0, 1);
  c.step('undo');
  assertEquals(c.text.toString(), 'Xkeep\n');
  assertEquals((await f.save(cid, {})).ok, true);
  // d: a delete, unsaved
  cut(d, 0, 3);
  assertEquals(d.text.toString(), '\n');
  f.close(); // the server stops: every file with unsaved text or history is stored
  f = files(state);
  try {
    assert(f.get(did), 'the unsaved file is loaded at start');
    assertEquals(f.get(cid), null, 'a clean file with history waits until it is opened');
    d = f.get(did)!;
    assertEquals(d.step('undo').ok, true);
    assertEquals(d.text.toString(), 'xyz\n', 'the deleted text came back after the restart');
    c = open(f, dir, 'c.txt');
    assertEquals(c.text.toString(), 'Xkeep\n');
    assertEquals(c.step('undo').ok, true, 'undo the insert of X (its copy, through the stored redone link)');
    assertEquals(c.text.toString(), 'keep\n', 'the re-inserted X goes too');
    assertEquals(c.step('redo').ok, true);
    assertEquals(c.text.toString(), 'Xkeep\n');
  } finally {
    f.close();
  }
});

Deno.test(`at most ${UNDO_LIMIT} steps, oldest dropped, the text untouched; the history ends with the file or the project`, async () => {
  const state = await temp('aib-undo-state-'), dir = await temp('aib-undo-proj-');
  Deno.writeTextFileSync(`${dir}${sep}e.txt`, '');
  Deno.writeTextFileSync(`${dir}${sep}g.txt`, 'g\n');
  let f = files(state);
  try {
    const lf = open(f, dir, 'e.txt');
    for (let i = 0; i < UNDO_LIMIT + 100; i++) typeEnd(lf, String(i % 10));
    const text = lf.text.toString();
    assertEquals(text.length, UNDO_LIMIT + 100);
    assertEquals(lf.undo.undoStack.length, UNDO_LIMIT, 'the oldest steps were dropped');
    assertEquals(lf.text.toString(), text, 'dropping steps never touches the text');
    let n = 0;
    while (lf.step('undo').ok) n++;
    assertEquals(n, UNDO_LIMIT);
    assertEquals(lf.text.toString(), text.slice(0, 100), 'the first 100 edits stay (their steps are gone)');
    // the history ends when the file is deleted
    assertEquals((await f.save(lf.id, {})).ok, true);
    f.closeView(lf.id, 'v', false);
    await until(() => f.get(lf.id) === null, 'let go');
    assertEquals(storeFiles(f).length, 1);
    Deno.removeSync(`${dir}${sep}e.txt`);
    await until(() => storeFiles(f).length === 0, 'the deleted file\'s history is gone', 5000);
    // ... also when it is deleted while AIB is closed
    const g = open(f, dir, 'g.txt');
    typeEnd(g, 'more\n');
    assertEquals((await f.save(g.id, {})).ok, true); // nothing unsaved (unsaved text of a deleted file is kept: Save writes it back)
    f.close();
    Deno.removeSync(`${dir}${sep}g.txt`);
    assertEquals(storeFiles(f).length, 1);
    f = files(state);
    assertEquals(storeFiles(f).length, 0, 'at start: a deleted file\'s history is gone');
    // ... and when the project is removed
    Deno.writeTextFileSync(`${dir}${sep}g.txt`, 'g\n');
    const g2 = open(f, dir, 'g.txt');
    typeEnd(g2, 'x');
    await f.save(g2.id, {});
    f.closeView(g2.id, 'v', false);
    await until(() => f.get(g2.id) === null && storeFiles(f).length === 1, 'kept for its history');
    f.forgetProject(dir);
    assertEquals(storeFiles(f).length, 0, 'the removed project\'s history is gone');
    assert(!open(f, dir, 'g.txt').hasHistory(), 'opens with no history');
  } finally {
    f.close();
  }
});

// ---- over the file socket -----------------------------------------------------------------------------------------------------------
async function startServer(stateDir: string) {
  const ctx = makeContext({
    stateDir,
    host: { liveCall: host().liveCall } as unknown as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
  });
  ctx.liveFiles = new LiveFiles({ stateDir, ...host() }, FAST);
  const server = new WebServer(ctx);
  const port = await server.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: Json) => {
    const r = await fetch(origin + path, { method: 'POST', headers: { 'X-Studio-Token': ctx.token, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Json };
  };
  return { ctx, port, origin, post, close: () => server.close() };
}

/** A page: y-protocols sync over the file socket, typing, and Ctrl+Z / Ctrl+Y as the editor sends them. */
function page(origin: string, port: number, file: string, token: string, view: string) {
  const ydoc = new Y.Doc();
  // @ts-ignore: Deno's WebSocket takes headers
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/files/socket?file=${file}&view=${view}`, { protocols: ['aib-file', 'aib-token.' + token], headers: { Origin: origin } });
  ws.binaryType = 'arraybuffer';
  const send = (build: (e: encoding.Encoder) => void) => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    build(e);
    if (ws.readyState === 1) ws.send(encoding.toUint8Array(e));
  };
  ydoc.on('update', (u: Uint8Array, o: unknown) => {
    if (o !== ws) send((e) => syncProtocol.writeUpdate(e, u));
  });
  ws.onopen = () => send((e) => syncProtocol.writeSyncStep1(e, ydoc));
  const answers = new Map<number, Json>();
  let synced = false, n = 0;
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const m = JSON.parse(event.data) as Json;
      if (m.type === 'undone') answers.set(Number(m.id), m);
      return;
    }
    const d = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
    if (decoding.readVarUint(d) !== 0) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    if (syncProtocol.readSyncMessage(d, e, ydoc, ws) === syncProtocol.messageYjsSyncStep2) synced = true;
    if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
  };
  const closed = new Promise((r) => ws.addEventListener('close', r));
  const text = ydoc.getText('file');
  return {
    text,
    synced: () => synced,
    type: (at: number, s: string) => ydoc.transact(() => text.insert(at, s), 'keyboard'),
    sv: () => btoa(String.fromCharCode(...Y.encodeStateVector(ydoc))),
    async step(op: 'undo' | 'redo'): Promise<Json> {
      const id = ++n;
      ws.send(JSON.stringify({ type: op, id }));
      await until(() => answers.has(id), `the ${op} answer`);
      return answers.get(id)!;
    },
    async close() {
      ws.close();
      await closed;
    },
  };
}

Deno.test('over the socket: Ctrl+Z / Ctrl+Y from a page, the caret offset back; two windows and a reload share one history', async () => {
  const state = await temp('aib-undo-state-'), dir = await temp('aib-undo-proj-');
  Deno.writeTextFileSync(`${dir}${sep}s.txt`, 'hello\n');
  const s = await startServer(state);
  try {
    await s.ctx.addedProjects.add(dir);
    const opened = await s.post('/api/live/files/open', { root: 'project', project: dir, path: 's.txt' });
    const id = String(opened.body.file);
    const a = page(s.origin, s.port, id, s.ctx.token, 'win-a');
    const b = page(s.origin, s.port, id, s.ctx.token, 'win-b');
    await until(() => a.synced() && b.synced() && a.text.toString() === 'hello\n', 'both windows synced');
    a.type(5, ' world');
    await until(() => b.text.toString() === 'hello world\n', 'window B sees A\'s typing');
    await sleep(600); // the next typing is a step of its own (UndoManager's 500 ms capture)
    b.type(0, '> ');
    await until(() => a.text.toString() === '> hello world\n', 'window A sees B\'s typing');
    const u1 = await a.step('undo');
    assertEquals([u1.ok, u1.at], [true, 0], "A's Ctrl+Z undoes the person's last edit, made in B; the caret goes to 0");
    await until(() => a.text.toString() === 'hello world\n' && b.text.toString() === 'hello world\n', 'both windows show the undo');
    await a.close();
    await b.close();
    // a reload: a new page, a new socket, the same history
    const c = page(s.origin, s.port, id, s.ctx.token, 'win-c');
    await until(() => c.synced() && c.text.toString() === 'hello world\n', 'the reloaded page synced');
    const u2 = await c.step('undo');
    assertEquals([u2.ok, u2.at], [true, 5]);
    assertEquals(c.text.toString(), 'hello\n');
    const r = await c.step('redo');
    assertEquals([r.ok, r.at], [true, 11]);
    await until(() => c.text.toString() === 'hello world\n', 'redone');
    assertEquals((await c.step('redo')).ok, true, 'B\'s edit is redone too');
    await until(() => c.text.toString() === '> hello world\n', 'redone twice');
    assertEquals((await c.step('redo')).ok, false, 'nothing more to redo');
    await c.close();
    // Don't save right after a keystroke: the server waits for it (the page's state vector), then drops the text as one step
    const d = page(s.origin, s.port, id, s.ctx.token, 'win-d');
    await until(() => d.synced() && d.text.toString() === '> hello world\n', 'another page synced');
    d.type(0, 'late ');
    const dropped = await s.post('/api/live/files/close', { file: id, view: 'win-d', discard: true, sv: d.sv() });
    assertEquals(dropped.body, { closed: true, discarded: true });
    const lf = s.ctx.liveFiles!.get(id)!;
    assertEquals(lf.text.toString(), 'hello\n', "Don't save: the disk's text");
    await sleep(100);
    assertEquals(lf.text.toString(), 'hello\n', 'no keystroke landed after the drop');
    assertEquals(lf.step('undo').ok, true);
    assertEquals(lf.text.toString(), 'late > hello world\n', 'Ctrl+Z brings it all back, the last keystroke too');
    await d.close();
  } finally {
    await s.close();
  }
});
