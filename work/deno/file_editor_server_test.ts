/**
 * The file editor's server (files/live_file.ts, files/live_files.ts, web/live_files_routes.ts; private/designs/file-editor, design v2
 * and the architect review of 2026-11-16) on the real web server with a page's y-protocols client over the file socket:
 *   - open / sync / save; Ctrl+S right after typing saves the last keystrokes (the save waits for the page's state vector);
 *     CRLF and BOM bytes follow the disk version last taken in (must-fixes 5, 8)
 *   - disk changes merge in: clean, dirty without overlap, with overlap (the user's line stays, the agent is told) (must-fix 3)
 *   - a landing's "files changed" event, skipped while the pause lock is held, read once it is let go (must-fixes 4, 7)
 *   - a half-written file is never taken in (settled reads, must-fix 4)
 *   - a save during a landing answers 423 landing_busy; a hidden disk change answers 409 merged, then saves (keep mine)
 *   - a disk version AIB can't edit is never merged; Save needs force (must-fix 8)
 *   - a web-server restart keeps the unsaved text and its lineage, and a page's unsent edits merge in (must-fix 5)
 *   - Don't save in one of two views keeps the text (must-fix 5)
 *   - a paired computer is refused on the socket and the routes (must-fix 6)
 *   - aib-docs, AIB's data, helper worktrees and .git are not editable; keys are case-insensitive on Windows; a link's target is saved
 *   - the agent host's finished write calls feed the poll (WriteTracker.finished, liveCall files-changed)
 */
import { assert, assertEquals } from './_assert.ts';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { makeContext, WebServer } from '../../outputs/agent-studio/server/web/server.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';
import { LiveFiles } from '../../outputs/agent-studio/server/files/live_files.ts';
import { emitFilesChanged } from '../../outputs/agent-studio/server/files/files_changed.ts';
import { filesSocket } from '../../outputs/agent-studio/server/web/live_files_routes.ts';
import { REMOTE_PC } from '../../outputs/agent-studio/server/web/security.ts';
import { pauseLock } from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { WriteTracker } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { entryFor } from '../../outputs/agent-studio/server/remote/pc_routes.ts';

type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const sep = WIN ? '\\' : '/';
const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

async function temp(prefix: string): Promise<string> {
  return Deno.realPathSync(await Deno.makeTempDir({ prefix })).replace(/^\\\\\?\\/, '');
}
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Studio's side, faked: the live calls the file editor makes. */
class FakeHost {
  calls: { name: string; body: Json }[] = [];
  events: { seq: number; paths: string[]; who: string; chat: string }[] = [];
  chats: { id: string; idle: string; landing?: string }[] = [];
  liveCall(name: string, body: unknown): Promise<[number, unknown]> {
    this.calls.push({ name, body: body as Json });
    if (name === 'files-changed') {
      const after = Number((body as Json).after) || 0;
      return Promise.resolve([200, { instance: 'i1', seq: this.events.length, events: this.events.filter((e) => e.seq > after) }]);
    }
    if (name === 'folder-chats') return Promise.resolve([200, { chats: this.chats }]);
    return Promise.resolve([200, { ok: true }]);
  }
  notes(): Json[] {
    return this.calls.filter((c) => c.name === 'prompt-context').map((c) => c.body);
  }
}

const FAST = { pollMs: 200, tickMs: 100, settleMs: 60, storeMs: 50, closeGraceMs: 300, saveWaitMs: 600 };

async function startServer(stateDir: string, host: FakeHost) {
  const ctx = makeContext({
    stateDir,
    host: host as unknown as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
  });
  ctx.liveFiles = new LiveFiles({
    stateDir,
    liveCall: (n, b) => host.liveCall(n, b),
    conversations: () => [],
    connectionOf: () => null,
  }, FAST);
  const server = new WebServer(ctx);
  const port = await server.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: Json) => {
    const r = await fetch(origin + path, { method: 'POST', headers: { 'X-Studio-Token': ctx.token, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Json };
  };
  return { ctx, port, origin, post, close: () => server.close() };
}

/** The page's client: y-protocols sync of the file's Y.Text over the file socket. */
function connect(origin: string, port: number, file: string, token: string, view = 'v1', ydoc = new Y.Doc()) {
  // @ts-ignore: Deno's WebSocket takes headers
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/files/socket?file=${file}&view=${view}`, {
    protocols: ['aib-file', ...(token ? ['aib-token.' + token] : [])],
    headers: { Origin: origin },
  });
  ws.binaryType = 'arraybuffer';
  let live = true; // false: the page is "offline", its edits wait (an unsent edit)
  const send = (build: (e: encoding.Encoder) => void) => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    build(e);
    if (ws.readyState === 1 && live) ws.send(encoding.toUint8Array(e));
  };
  const onUpdate = (update: Uint8Array, o: unknown) => {
    if (o !== ws) send((e) => syncProtocol.writeUpdate(e, update));
  };
  ydoc.on('update', onUpdate);
  ws.onopen = () => send((e) => syncProtocol.writeSyncStep1(e, ydoc));
  const control: Json[] = [];
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') return void control.push(JSON.parse(event.data));
    const d = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
    if (decoding.readVarUint(d) !== 0) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.readSyncMessage(d, e, ydoc, ws);
    if (encoding.length(e) > 1 && live) ws.send(encoding.toUint8Array(e));
  };
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener('close', (e) => r(e as CloseEvent)));
  const text = ydoc.getText('file');
  return {
    ydoc,
    ws,
    control,
    closed,
    text,
    offline: () => (live = false),
    stop: () => ydoc.off('update', onUpdate),
    type: (at: number, s: string) => ydoc.transact(() => text.insert(at, s), 'keyboard'),
    sv: () => b64(Y.encodeStateVector(ydoc)),
  };
}

async function project(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await temp('aib-fe-proj-');
  for (const [rel, body] of Object.entries(files)) {
    const p = dir + sep + rel.replaceAll('/', sep);
    Deno.mkdirSync(p.slice(0, p.lastIndexOf(sep)), { recursive: true });
    Deno.writeFileSync(p, typeof body === 'string' ? enc(body) : body);
  }
  return dir;
}

Deno.test('open, sync, Ctrl+S right after typing saves the last keystrokes; CRLF and BOM bytes stay', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'src/app.ts': '\uFEFFconst a = 1;\r\nconst b = 2;\r\n' });
  const host = new FakeHost();
  const s = await startServer(state, host);
  try {
    await s.ctx.addedProjects.add(dir);
    const opened = await s.post('/api/live/files/open', { root: 'project', project: dir, path: 'src/app.ts' });
    assertEquals(opened.status, 200);
    assertEquals([opened.body.editable, opened.body.eol, opened.body.bom, opened.body.encoding], [true, 'crlf', true, 'utf-8-bom']);
    // without the page token: refused before the upgrade
    const refused = connect(s.origin, s.port, String(opened.body.file), '');
    await refused.closed;
    const page = connect(s.origin, s.port, String(opened.body.file), s.ctx.token);
    await until(() => page.text.toString() === 'const a = 1;\nconst b = 2;\n', 'the first sync');
    assertEquals(page.control[0].type, 'hello');
    assertEquals(page.control[0].lineage, opened.body.lineage);
    // type and save at once: the save carries the page's state vector and waits for those edits
    page.type(page.text.length, 'const c = 3;\n');
    const saved = await s.post('/api/live/files/save', { file: opened.body.file, sv: page.sv() });
    assertEquals(saved.status, 200, JSON.stringify(saved.body));
    const bytes = Deno.readFileSync(`${dir}${sep}src${sep}app.ts`);
    assertEquals(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), '\uFEFFconst a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n', 'BOM and CRLF kept, the last line saved');
    const lf = s.ctx.liveFiles!.get(String(opened.body.file))!;
    await until(() => lf.meta.get('dirty') === false, 'dirty is computed: false after the save');
    await until(() => page.ydoc.getMap('meta').get('savedAt') !== undefined, 'the page sees "Saved"');
    // the agent rewrites the file with LF (Claude's Write on Windows): EOL follows the version last taken in
    Deno.writeTextFileSync(`${dir}${sep}src${sep}app.ts`, '\uFEFFconst a = 10;\nconst b = 2;\nconst c = 3;\n');
    await until(() => page.text.toString().startsWith('const a = 10;'), 'the LF version merged in');
    page.type(page.text.length, '// end\n');
    assertEquals((await s.post('/api/live/files/save', { file: opened.body.file, sv: page.sv() })).status, 200);
    assertEquals(new TextDecoder('utf-8', { ignoreBOM: true }).decode(Deno.readFileSync(`${dir}${sep}src${sep}app.ts`)), '\uFEFFconst a = 10;\nconst b = 2;\nconst c = 3;\n// end\n', 'no CRLF put back');
    page.ws.close();
  } finally {
    await s.close();
  }
});

Deno.test('disk changes merge in: clean, dirty without overlap, and an overlap keeps the user\'s line and tells the agent', async () => {
  const state = await temp('aib-fe-state-');
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join('');
  const dir = await project({ 'a.txt': body });
  const host = new FakeHost();
  const s = await startServer(state, host);
  const file = `${dir}${sep}a.txt`;
  try {
    await s.ctx.addedProjects.add(dir);
    const opened = await s.post('/api/live/files/open', { root: 'project', project: dir, path: 'a.txt' });
    const page = connect(s.origin, s.port, String(opened.body.file), s.ctx.token);
    await until(() => page.text.toString() === body, 'sync');
    Deno.writeTextFileSync(file, body.replace('line 2\n', 'line 2 agent\n'));
    await until(() => page.text.toString().includes('line 2 agent'), 'clean: the change merged in');
    // dirty: the user edits line 9; the agent edits line 4
    page.type(page.text.toString().indexOf('line 9') + 6, ' mine');
    await sleep(50);
    host.events.push({ seq: 1, paths: [file], who: 'Fix login', chat: 'c-1' });
    await sleep(250); // the feed's first look sets its baseline
    Deno.writeTextFileSync(file, body.replace('line 2\n', 'line 2 agent\n').replace('line 4\n', 'line 4 agent\n'));
    host.events.push({ seq: 2, paths: [file], who: 'Fix login', chat: 'c-1' });
    await until(() => page.text.toString().includes('line 4 agent'), 'dirty, no overlap: merged in');
    assert(page.text.toString().includes('line 9 mine'), 'the user\'s edit stays');
    const lf = s.ctx.liveFiles!.get(String(opened.body.file))!;
    assertEquals(lf.meta.get('updatedBy'), 'Fix login', 'attributed to the chat whose write call finished');
    // overlap: the agent changes line 9 too
    Deno.writeTextFileSync(file, body.replace('line 2\n', 'line 2 agent\n').replace('line 4\n', 'line 4 agent\n').replace('line 9\n', 'line 9 agent\n'));
    host.events.push({ seq: 3, paths: [file], who: 'Fix login', chat: 'c-1' });
    await until(() => lf.overlaps.length === 1, 'the overlap recorded');
    assert(page.text.toString().includes('line 9 mine'), 'the user\'s line stays');
    assert(!page.text.toString().includes('line 9 agent'), 'the agent\'s version is not applied over it');
    await until(() => page.ydoc.getArray('overlaps').length === 1, 'the page sees the overlap');
    await until(() => host.notes().length > 0, 'the agent told');
    const note = host.notes().at(-1)!;
    assertEquals(note.id, 'c-1');
    assert(String(note.line).includes('a.txt, lines 9,') || String(note.line).includes('a.txt, lines 9 '), String(note.line));
    // Save = keep mine: the overlap closes; the agent's other lines are kept
    const saved = await s.post('/api/live/files/save', { file: opened.body.file, sv: page.sv() });
    assertEquals(saved.status, 200, JSON.stringify(saved.body));
    assertEquals(Deno.readTextFileSync(file), body.replace('line 2\n', 'line 2 agent\n').replace('line 4\n', 'line 4 agent\n').replace('line 9\n', 'line 9 mine\n'));
    assertEquals(lf.overlaps.length, 0);
    page.ws.close();
  } finally {
    await s.close();
  }
});

Deno.test('a landing\'s files-changed event is not read while the pause lock is held, then merges; a half-written file is never taken in', async () => {
  const state = await temp('aib-fe-state-');
  const body = 'one\ntwo\nthree\n';
  const dir = await project({ 'x.txt': body });
  const host = new FakeHost();
  const lf = new LiveFiles({ stateDir: state, liveCall: (n, b) => host.liveCall(n, b), conversations: () => [], connectionOf: () => null }, { ...FAST, pollMs: 60_000 });
  lf.start();
  const file = `${dir}${sep}x.txt`;
  try {
    const got = lf.open(dir, 'x.txt');
    assert('file' in got);
    const f = got.file;
    f.text.insert(0, '// mine\n'); // unsaved text
    const pause = pauseLock(state, dir, 1);
    await pause.acquire(); // a landing is moving the folder (maybe with the user's work stashed)
    Deno.writeTextFileSync(file, ''); // the stash window: the file looks emptied
    emitFilesChanged({ folder: dir, paths: ['x.txt'], who: 'helper Fix', kind: 'landing' });
    await sleep(400);
    assertEquals(f.text.toString(), '// mine\n' + body, 'nothing read while paused');
    Deno.writeTextFileSync(file, body.replace('two', 'TWO'));
    pause.release();
    await until(() => f.text.toString() === '// mine\none\nTWO\nthree\n', 'read after the landing let go');
    assertEquals(f.meta.get('updatedBy'), 'helper Fix');
    // a partial write: half the bytes, then the rest 40 ms later (inside the settle window): never the half
    const full = 'one\nTWO\nthree\nfour\nfive\n';
    const fd = Deno.openSync(file, { write: true, truncate: true });
    fd.writeSync(enc(full.slice(0, 6)));
    void lf.check(f, true);
    await sleep(40);
    fd.writeSync(enc(full.slice(6)));
    fd.close();
    await until(() => f.text.toString() === '// mine\n' + full, 'the whole version taken in');
    assert(!f.text.toString().includes('three\n\n'), 'no half version was merged');
  } finally {
    lf.close();
  }
});

Deno.test('save: 423 during a landing, 409 merged after a hidden disk change then saves, unmergeable needs force, deleted saves again', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'y.txt': 'a\nb\nc\n' });
  const host = new FakeHost();
  host.chats = [{ id: 'c-9', idle: 'a turn is running', landing: 'Fix login' }];
  const lf = new LiveFiles({ stateDir: state, liveCall: (n, b) => host.liveCall(n, b), conversations: () => [], connectionOf: () => null }, { ...FAST, pollMs: 60_000, saveWaitMs: 300 });
  lf.start();
  const file = `${dir}${sep}y.txt`;
  try {
    const got = lf.open(dir, 'y.txt');
    assert('file' in got);
    const f = got.file;
    const pause = pauseLock(state, dir, 1);
    await pause.acquire();
    const busy = await lf.save(f.id, { text: 'a\nB\nc\n' });
    assertEquals(busy.ok, false);
    assertEquals([!busy.ok && busy.status, !busy.ok && busy.code, !busy.ok && busy.who], [423, 'landing_busy', 'Fix login']);
    pause.release();
    // a hidden disk change touching the user's line: 409 merged, the overlap shows; Save again keeps mine
    Deno.writeTextFileSync(file, 'a\nb2\nc\nd\n');
    const merged = await lf.save(f.id, {});
    assertEquals([!merged.ok && merged.status, !merged.ok && merged.code], [409, 'merged']);
    assertEquals(f.text.toString(), 'a\nB\nc\nd\n', 'the disk\'s d went in, the user\'s B stayed');
    assert((await lf.save(f.id, {})).ok);
    assertEquals(Deno.readTextFileSync(file), 'a\nB\nc\nd\n');
    // the disk becomes a form AIB can't edit: never merged, Save needs a second press
    Deno.writeFileSync(file, new Uint8Array([0x61, 0xe9, 0x0a]));
    const odd = await lf.save(f.id, { text: 'a\nB\nc\nd\ne\n' });
    assertEquals([!odd.ok && odd.code], ['unmergeable']);
    assertEquals(f.text.toString(), 'a\nB\nc\nd\ne\n', 'the user\'s text kept');
    assertEquals(f.meta.get('disk'), 'unmergeable');
    assert((await lf.save(f.id, { force: true })).ok, 'the second press overwrites');
    assertEquals(Deno.readTextFileSync(file), 'a\nB\nc\nd\ne\n');
    // deleted on disk: the first save says so, the second writes it back
    Deno.removeSync(file);
    const gone = await lf.save(f.id, {});
    assertEquals([!gone.ok && gone.code], ['deleted']);
    assert((await lf.save(f.id, {})).ok);
    assertEquals(Deno.readTextFileSync(file), 'a\nB\nc\nd\ne\n');
    // read-only file: the failure row's words
    if (WIN) {
      await new Deno.Command('attrib', { args: ['+r', file] }).output();
      const ro = await lf.save(f.id, { text: 'z\n' });
      assertEquals([!ro.ok && ro.code], ['read_only']);
      await new Deno.Command('attrib', { args: ['-r', file] }).output();
    }
  } finally {
    lf.close();
  }
});

Deno.test('an emoji changed on disk round-trips byte for byte through the live text and a save', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'e.ts': 'const face = "😀";\nconst n = 1;\n' });
  const lf = new LiveFiles({ stateDir: state, liveCall: () => Promise.resolve([200, {}]), conversations: () => [], connectionOf: () => null }, { ...FAST, pollMs: 60_000 });
  lf.start();
  try {
    const got = lf.open(dir, 'e.ts');
    assert('file' in got);
    const f = got.file;
    f.text.insert(f.text.length, '// mine\n');
    Deno.writeTextFileSync(`${dir}${sep}e.ts`, 'const face = "😃";\nconst n = 1;\n');
    await lf.check(f, true);
    assertEquals(f.text.toString(), 'const face = "😃";\nconst n = 1;\n// mine\n');
    assert((await lf.save(f.id, {})).ok);
    assertEquals(Deno.readFileSync(`${dir}${sep}e.ts`), enc('const face = "😃";\nconst n = 1;\n// mine\n'));
  } finally {
    lf.close();
  }
});

Deno.test('a web-server restart keeps the unsaved text and its lineage; a page\'s unsent edits merge in on reconnect', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'r.txt': 'alpha\nbeta\n' });
  const host = new FakeHost();
  let s = await startServer(state, host);
  await s.ctx.addedProjects.add(dir);
  const opened = await s.post('/api/live/files/open', { root: 'project', project: dir, path: 'r.txt' });
  const id = String(opened.body.file);
  const ydoc = new Y.Doc();
  let page = connect(s.origin, s.port, id, s.ctx.token, 'v1', ydoc);
  await until(() => page.text.toString() === 'alpha\nbeta\n', 'sync');
  page.type(0, 'sent ');
  await until(() => !!s.ctx.liveFiles!.get(id)?.text.toString().startsWith('sent '), 'the edit reached the server');
  page.offline();
  page.type(page.text.length, 'unsent\n'); // typed while the server restarts: not on the server
  await s.close(); // writes the store (the text is not the disk's)
  assertEquals(Deno.readTextFileSync(`${dir}${sep}r.txt`), 'alpha\nbeta\n', 'quitting never saved or asked');
  s = await startServer(state, host);
  try {
    const back = s.ctx.liveFiles!.get(id);
    assert(back, 'the unsaved file is loaded at start');
    assertEquals(back!.lineage, opened.body.lineage, 'same lineage: the page can merge its pending edits');
    await until(() => back!.meta.get('restoredAt') !== undefined, 'marked restored');
    page.stop();
    page = connect(s.origin, s.port, id, s.ctx.token, 'v1', ydoc);
    await until(() => back!.text.toString() === 'sent alpha\nbeta\nunsent\n', 'the unsent edit merged in after the reconnect');
    assertEquals(page.control[0].lineage, opened.body.lineage);
    page.ws.close();
  } finally {
    await s.close();
  }
});

Deno.test('Don\'t save in one of two views keeps the text; in the last view it drops it', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'd.txt': 'x\n' });
  const host = new FakeHost();
  const s = await startServer(state, host);
  try {
    await s.ctx.addedProjects.add(dir);
    const opened = await s.post('/api/live/files/open', { root: 'project', project: dir, path: 'd.txt' });
    const id = String(opened.body.file);
    const a = connect(s.origin, s.port, id, s.ctx.token, 'win-a');
    const b = connect(s.origin, s.port, id, s.ctx.token, 'win-b');
    await until(() => a.text.toString() === 'x\n' && b.text.toString() === 'x\n', 'both synced');
    a.type(0, 'typed ');
    await until(() => b.text.toString() === 'typed x\n', 'the other window sees the typing');
    const kept = await s.post('/api/live/files/close', { file: id, view: 'win-a', discard: true });
    assertEquals(kept.body, { closed: true, kept: true });
    a.ws.close();
    await a.closed;
    assertEquals(s.ctx.liveFiles!.get(id)!.text.toString(), 'typed x\n', 'window B still has the text');
    const dropped = await s.post('/api/live/files/close', { file: id, view: 'win-b', discard: true });
    assertEquals(dropped.body, { closed: true, discarded: true });
    assertEquals(s.ctx.liveFiles!.get(id), null);
    assertEquals(Deno.readTextFileSync(`${dir}${sep}d.txt`), 'x\n');
  } finally {
    await s.close();
  }
});

Deno.test('a paired computer is refused: the file socket and every editor route', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'p.txt': 'secret\n' });
  const s = await startServer(state, new FakeHost());
  try {
    await s.ctx.addedProjects.add(dir);
    const opened = await s.post('/api/live/files/open', { root: 'project', project: dir, path: 'p.txt' });
    const req = new Request(`${s.origin}/api/live/files/socket?file=${opened.body.file}`, {
      headers: { Origin: s.origin, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Protocol': 'aib-file', 'Sec-WebSocket-Key': 'x', 'Sec-WebSocket-Version': '13' },
    });
    const answer = filesSocket(s.ctx, req, new URL(req.url), { kind: REMOTE_PC } as never);
    assert('refused' in answer, 'no socket for a remote computer');
    assertEquals((answer as { refused: [number, Json] }).refused[0], 403);
    for (const [method, path] of [['POST', '/api/live/files/open'], ['POST', '/api/live/files/save'], ['POST', '/api/live/files/close'], ['GET', '/api/live/files/compare'], ['GET', '/api/live/files/socket']]) {
      const verdict = entryFor(method, path) as Json;
      assertEquals(verdict.kind, 'never', `${method} ${path} is never reachable from a paired computer`);
    }
    const viaBridge = await s.ctx.dispatchAs!({ kind: REMOTE_PC } as never, 'POST', new URL(`${s.origin}/api/live/files/save`), new Request(s.origin), { file: opened.body.file, text: 'x' });
    assertEquals(viaBridge.status, 403);
    assertEquals(Deno.readTextFileSync(`${dir}${sep}p.txt`), 'secret\n');
  } finally {
    await s.close();
  }
});

Deno.test('not editable: aib-docs, AIB data, helper worktrees, .git; case-insensitive keys; a link\'s target is saved', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'aib-docs/plan/01-page.md': '# P\n', 'src/A.ts': 'a\n', 'real.txt': 'target\n' });
  Deno.mkdirSync(`${dir}${sep}.git`);
  Deno.writeTextFileSync(`${dir}${sep}.git${sep}config`, '[core]\n');
  const lf = new LiveFiles({ stateDir: state, liveCall: () => Promise.resolve([200, {}]), conversations: () => [], connectionOf: () => null }, { ...FAST, pollMs: 60_000 });
  lf.start();
  try {
    assertEquals(lf.open(dir, 'aib-docs/plan/01-page.md'), { refused: 'docs' });
    let threw = '';
    try {
      lf.open(dir, '.git/config');
    } catch (e) {
      threw = (e as { code?: string }).code ?? String(e);
    }
    assertEquals(threw, 'hidden');
    try {
      lf.open(dir, '.git./config');
    } catch (e) {
      threw = (e as { code?: string }).code ?? String(e);
    }
    assertEquals(threw, 'bad_path');
    const inData = await project({ 'f.txt': 'x' });
    const dataLf = new LiveFiles({ stateDir: inData, liveCall: () => Promise.resolve([200, {}]), conversations: () => [], connectionOf: () => null });
    assertEquals(dataLf.open(inData, 'f.txt'), { refused: 'worktree' }, 'a folder inside AIB\'s data (where worktrees live) is read-only');
    const a = lf.open(dir, 'src/A.ts');
    assert('file' in a);
    if (WIN) {
      const b = lf.open(dir, 'SRC/a.TS');
      assert('file' in b);
      assertEquals(b.file.id, a.file.id, 'one live text per file on Windows');
    }
    let linked = false;
    try {
      Deno.symlinkSync(`${dir}${sep}real.txt`, `${dir}${sep}link.txt`, { type: 'file' });
      linked = true;
    } catch { /* no symlink right on this machine (Windows without developer mode) */ }
    if (linked) {
      const l = lf.open(dir, 'link.txt');
      assert('file' in l);
      assert((await lf.save(l.file.id, { text: 'changed\n' })).ok);
      assert(Deno.lstatSync(`${dir}${sep}link.txt`).isSymlink, 'the link is still a link');
      assertEquals(Deno.readTextFileSync(`${dir}${sep}real.txt`), 'changed\n', 'the target was written');
    }
  } finally {
    lf.close();
  }
});

Deno.test('the agent host\'s finished write calls: WriteTracker.finished names the paths once, after completion only', () => {
  const t = new WriteTracker('C:\\p');
  const call = (update: Json) => ({ update: { toolCallId: 't1', ...update } });
  t.observe(call({ sessionUpdate: 'tool_call', kind: 'edit', rawInput: { file_path: 'C:\\p\\a.ts' } }));
  assertEquals(t.finished(call({ sessionUpdate: 'tool_call', kind: 'edit' })), [], 'not on the call itself (before the write and any approval)');
  t.observe(call({ sessionUpdate: 'tool_call_update', status: 'in_progress' }));
  assertEquals(t.finished(call({ sessionUpdate: 'tool_call_update', status: 'in_progress' })), []);
  const done = call({ sessionUpdate: 'tool_call_update', status: 'completed' });
  t.observe(done);
  assertEquals(t.finished(done).length, 1);
  assertEquals(t.finished(done), [], 'once');
});

Deno.test('after a save the folder\'s busy chats and the chat that wrote the file are told which lines the user edited (one line per file)', async () => {
  const state = await temp('aib-fe-state-');
  const dir = await project({ 'n.ts': Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join('') });
  const host = new FakeHost();
  host.chats = [{ id: 'busy-1', idle: 'a turn is running' }, { id: 'idle-1', idle: '' }];
  const file = `${dir}${sep}n.ts`;
  const lf = new LiveFiles({
    stateDir: state,
    liveCall: (n, b) => host.liveCall(n, b),
    conversations: () => [{ id: 'claude:w1', cwd: dir, writes: [file] }],
    connectionOf: (id) => (id === 'claude:w1' ? 'writer-1' : null),
  }, { ...FAST, pollMs: 60_000 });
  lf.start();
  try {
    const got = lf.open(dir, 'n.ts');
    assert('file' in got);
    const text = got.file.text.toString().replace('line 12\n', 'twelve\n').replace('line 13\n', 'thirteen\n');
    assert((await lf.save(got.file.id, { text })).ok);
    await until(() => host.notes().length >= 2, 'the notes');
    const notes = host.notes();
    assertEquals(notes.map((n) => n.id).sort(), ['busy-1', 'writer-1'], 'the writer and the busy chat; not the idle one');
    assertEquals(notes[0].line, 'The user edited n.ts, lines 12-13 (saved); re-read it before changing it.');
    assertEquals(notes[0].replace, 'The user edited n.ts', 'one line per file: a newer note replaces the older one');
  } finally {
    lf.close();
  }
});

Deno.test('a formatter rewrite touching the user\'s lines is one "rewrote this file" state, not many blocks', async () => {
  const state = await temp('aib-fe-state-');
  const body = Array.from({ length: 40 }, (_, i) => `x${i}=1\n`).join('');
  const dir = await project({ 'f.py': body });
  const lf = new LiveFiles({ stateDir: state, liveCall: () => Promise.resolve([200, {}]), conversations: () => [], connectionOf: () => null }, { ...FAST, pollMs: 60_000 });
  lf.start();
  try {
    const got = lf.open(dir, 'f.py');
    assert('file' in got);
    const f = got.file;
    let mine = body;
    for (const i of [3, 10, 17, 24, 31]) mine = mine.replace(`x${i}=1\n`, `x${i}=2\n`);
    f.doc.transact(() => {
      f.text.delete(0, f.text.length);
      f.text.insert(0, mine);
    }, 'page'); // unsaved
    Deno.writeTextFileSync(`${dir}${sep}f.py`, body.replaceAll('=1', ' = 1'));
    await lf.check(f, true);
    assertEquals(f.meta.get('rewrite'), true, 'the page shows one row: "… rewrote this file · 5 overlaps · Compare"');
    assertEquals(f.overlaps.length, 5);
    assert(f.text.toString().includes('x3=2') && f.text.toString().includes('x4 = 1'), 'the user\'s lines stay, the rest is formatted');
  } finally {
    lf.close();
  }
});
