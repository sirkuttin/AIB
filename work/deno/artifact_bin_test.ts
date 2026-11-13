/**
 * Archive and delete artifacts, server side (server/artifacts/artifacts.ts): archive / unarchive, Delete into Recently deleted with the
 * source file moved into the artifact's bin, Restore (the file back, "(restored)" beside a newer one), "Delete now", the 30-day sweep,
 * the link states, and every case where the file must stay (owner folder unknown, outside, link, aib-docs, .git, shared, locked).
 * Everything runs in throwaway temp folders; nothing here points at a real project or AIB's state folder.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  ArtifactStore,
  BIN_FOLDER,
  isDeleted,
  limits,
  type Manifest,
  type QueryArgs,
  type RequestLike,
  Service,
  sourceFileGoesWithDelete,
  Watcher,
} from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { configure as configureKeys, issue } from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { authorize, Gate, Refusal } from '../../outputs/agent-studio/server/web/security.ts';
import { ROUTES } from '../../outputs/agent-studio/server/web/routes.ts';

type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
const join = (...parts: string[]) => parts.join(SEP);
const enc = (text: string) => new TextEncoder().encode(text);
const DAY = 24 * 3600;

class Clock {
  constructor(public t = 1_000_000.0) {}
  now = () => this.t;
}

const page = (): RequestLike => ({ headers: new Headers({ 'X-Studio-Token': 't' }) });
const keyed = (key: string): RequestLike => ({ headers: new Headers({ 'X-Studio-Artifact-Key': key }) });

function fixture() {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-artifact-bin-' })).replace(/^\\\\\?\\/, '');
  const project = join(dir, 'proj');
  const other = join(dir, 'other');
  Deno.mkdirSync(join(project, 'outputs'), { recursive: true });
  Deno.mkdirSync(join(other, 'outputs'), { recursive: true });
  const clock = new Clock();
  const store = new ArtifactStore(join(dir, 'state', 'artifacts'), clock.now);
  store.origin = 'http://127.0.0.1:1';
  const folders: Record<string, string | null> = { c1: project, c2: project, c3: other };
  const events: [string, Json][] = [];
  const service = new Service(store, () => 't', (id) => folders[id] ?? null, { emit: (cid, event) => events.push([cid, event]) });
  const post = (path: string, body: unknown, h = page()) => service.handlePost(h, '/api/live/artifacts/' + path, body) as [number, Json];
  const get = (path: string, args: QueryArgs, h = page()) => service.handleGet(h, path, args) as [number, Json];
  const write = (rel: string, text: string, root = project) => {
    const path = join(root, ...rel.split('/'));
    Deno.mkdirSync(path.slice(0, path.lastIndexOf(SEP)), { recursive: true });
    Deno.writeTextFileSync(path, text);
    return path;
  };
  /** The agent publishes a file (by 'tool'). */
  const publish = (rel: string, text: string, chat = 'c1') => {
    const path = write(rel, text, folders[chat]!);
    const [status, body] = post('publish', { conversationId: chat, title: rel, path });
    assertEquals(status, 200, JSON.stringify(body));
    return { id: body.id as string, path };
  };
  /** The user's "Open in Artifacts" (by 'preview'). */
  const preview = (rel: string, text: string, chat = 'c1') => {
    const path = write(rel, text, folders[chat]!);
    const [status, body] = post('preview', { conversationId: chat, path });
    assertEquals(status, 200, JSON.stringify(body));
    return { id: body.id as string, path };
  };
  const del = (id: string) => post('delete', { id });
  const undel = (id: string) => post('undelete', { id });
  const manifestBytes = (id: string) => Deno.readTextFileSync(join(store.root, id, 'manifest.json'));
  const binFiles = (id: string) => {
    try {
      return [...Deno.readDirSync(join(store.root, id, BIN_FOLDER))].map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  const exists = (path: string) => {
    try {
      Deno.lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  return {
    dir,
    project,
    other,
    clock,
    store,
    folders,
    events,
    service,
    post,
    get,
    write,
    publish,
    preview,
    del,
    undel,
    manifestBytes,
    binFiles,
    exists,
    [Symbol.dispose]() {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* a Windows reader may still hold it */ }
    },
  };
}

// ---- Delete and Restore ------------------------------------------------------------------------------------------------------

Deno.test('delete: an agent file goes into the bin, the artifact into Recently deleted; Restore brings back the same bytes', () => {
  using f = fixture();
  const { id, path } = f.publish('outputs/report.html', '<p>report</p>');
  const [status, body] = f.del(id);
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.file, { path: 'outputs/report.html', action: 'moved' });
  assert(!f.exists(path), 'the source file left the project');
  assertEquals(f.binFiles(id), ['report.html']);
  const s = body.artifact as Json;
  assertEquals(s.deletedAt, f.clock.t);
  assertEquals(s.purgeAt, f.clock.t + 30 * DAY);
  assertEquals(s.deletedFile, { path: 'outputs/report.html' });
  assertEquals(f.events.at(-1)![1].artifact, s, 'the page hears it');
  // default list (the agent, the Files marks) leaves it out; the panel asks for deleted=1
  assertEquals((f.get('/api/live/artifacts', { conversationId: ['c1'] })[1].artifacts as Json[]).length, 0);
  assertEquals((f.get('/api/live/artifacts', { conversationId: ['c1'], deleted: ['1'] })[1].artifacts as Json[]).map((a) => a.id), [id]);
  const item = f.get('/api/live/artifacts/item', { id: [id] })[1];
  assertEquals([item.purgeAt, (item.deletedFile as Json).path], [f.clock.t + 30 * DAY, 'outputs/report.html']);
  // a second Delete answers the same and changes nothing
  const before = f.manifestBytes(id);
  assertEquals(f.del(id)[1].file, { path: 'outputs/report.html', action: 'moved' });
  assertEquals(f.manifestBytes(id), before);
  // Restore
  const [rs, rb] = f.undel(id);
  assertEquals(rs, 200, JSON.stringify(rb));
  assertEquals(rb.file, { path: 'outputs/report.html', action: 'restored' });
  assertEquals(Deno.readTextFileSync(path), '<p>report</p>');
  const back = rb.artifact as Json;
  assert(!('deletedAt' in back) && !('purgeAt' in back) && !('deletedFile' in back), JSON.stringify(back));
  assert(!f.exists(join(f.store.root, id, BIN_FOLDER)), 'the empty bin folder goes');
  assertEquals((f.get('/api/live/artifacts', { conversationId: ['c1'] })[1].artifacts as Json[]).map((a) => a.id), [id]);
});

Deno.test('delete: a file changed after the latest version is saved as "File at delete time" and comes back changed', () => {
  using f = fixture();
  const { id, path } = f.publish('outputs/plan.md', '# one\n');
  f.clock.t += 60;
  Deno.writeTextFileSync(path, '# two, edited on disk\n');
  f.del(id);
  const m = f.store.get(id);
  assertEquals(m.versions.length, 2);
  assertEquals([m.versions[1].note, m.versions[1].by], ['File at delete time', 'watch']);
  assertEquals(f.store.source(id).text, '# two, edited on disk\n');
  f.undel(id);
  assertEquals(Deno.readTextFileSync(path), '# two, edited on disk\n');
});

Deno.test('delete: a file the user opened with "Open in Artifacts" goes too (owner answer A = c) and Restore brings it back', () => {
  using f = fixture();
  assertEquals(sourceFileGoesWithDelete('user'), { goes: true });
  const { id, path } = f.preview('README.md', '# Project\n');
  assertEquals(f.store.get(id).versions[0].by, 'preview');
  const [, body] = f.del(id);
  assertEquals(body.file, { path: 'README.md', action: 'moved' });
  assert(!f.exists(path));
  f.undel(id);
  assertEquals(Deno.readTextFileSync(path), '# Project\n');
});

Deno.test('delete: an artifact with no file (published from content) only leaves the list; Restore brings it back', () => {
  using f = fixture();
  const [, made] = f.post('publish', { conversationId: 'c1', title: 'Note', content: 'hi', filename: 'n.txt' });
  const [, body] = f.del(made.id as string);
  assertEquals(body.file, null);
  assert(!('deletedFile' in (body.artifact as Json)));
  assertEquals(f.undel(made.id as string)[1].file, null);
});

// ---- the watcher and writes never revive a deleted artifact (breaks 2 and 3) --------------------------------------------------

Deno.test('delete: the watcher sends nothing for a deleted artifact; a rewrite of its path is a NEW artifact, the old one untouched', () => {
  using f = fixture();
  const writes: string[] = [];
  const state = { now: 100.0 };
  const watcher = new Watcher(f.service, () => [{ id: 'c1', cwd: f.project, writes: [...writes] }], { clock: () => state.now, listEvery: 0 });
  const tick = () => {
    state.now += 1;
    watcher.tick();
  };
  const path = f.write('outputs/page.html', '<title>Page</title>one');
  writes.push(path);
  tick();
  tick();
  const [first] = f.store.all();
  assert(first, 'the watcher made the artifact');
  f.del(first.id);
  const bytes = f.manifestBytes(first.id);
  const seen = f.events.length;
  tick();
  tick();
  assertEquals(f.events.length, seen, 'no missing-file event for a deleted artifact');
  assertEquals(f.manifestBytes(first.id), bytes, 'and no manifest change');
  Deno.writeTextFileSync(path, '<title>Page</title>two');
  tick();
  tick();
  const live = f.store.all().filter((m) => !isDeleted(m));
  assertEquals(live.length, 1);
  assert(live[0].id !== first.id, 'a new artifact');
  assertEquals(f.manifestBytes(first.id), bytes, 'the deleted one is byte for byte as it was');
});

Deno.test('delete: update, pin and version restore refuse a deleted artifact (409 deleted); a new publish of the file makes a new one', () => {
  using f = fixture();
  const { id, path } = f.publish('outputs/a.html', '<p>a</p>');
  f.del(id);
  const [status, body] = f.post('publish', { conversationId: 'c1', id, content: '<p>b</p>' });
  assertEquals([status, body.code], [409, 'deleted']);
  assert(String(body.error).includes('The user deleted this artifact'), String(body.error));
  assert(!f.exists(join(f.store.root, id, 'v2')), 'no version was written');
  assertEquals(f.post('pin', { id, pinned: true })[1].code, 'deleted');
  assertEquals(f.post('restore', { id, version: 1 })[1].code, 'deleted');
  f.write('outputs/a.html', '<p>again</p>');
  const [, again] = f.post('publish', { conversationId: 'c1', title: 'A', path });
  assert(again.id !== id, 'publish by path after a delete is a new artifact');
});

// ---- who may do what (breaks 10 and 19) ---------------------------------------------------------------------------------------

Deno.test('gate: delete, undelete and purge are page only (an agent key gets bad_key); archive takes the agent key', () => {
  const gate = new Gate(8999, () => 't');
  const headers = new Headers({ 'X-Studio-Artifact-Key': 'k', Host: '127.0.0.1:8999' });
  for (const path of ['delete', 'undelete', 'purge'].map((p) => '/api/live/artifacts/' + p)) {
    const refused = authorize({ method: 'POST', path, headers }, gate, ROUTES.scopeFor('POST', path), 'c1', () => true);
    assert(refused instanceof Refusal && refused.status === 403, path);
    assertEquals((refused as Refusal).message(path), 'Invalid artifact key');
  }
  const path = '/api/live/artifacts/archive';
  const allowed = authorize({ method: 'POST', path, headers }, gate, ROUTES.scopeFor('POST', path), 'c1', () => true);
  assert(!(allowed instanceof Refusal), 'archive accepts a valid agent key');
  assertEquals(ROUTES.scopeFor('GET', '/api/live/artifacts/states'), 'artifacts.read');
});

Deno.test('archive: the agent archives its own chat\'s artifacts only; the page any; pinned ones are unpinned and stay unpinned', () => {
  using f = fixture();
  using keys = { dir: Deno.makeTempDirSync({ prefix: 'aib-keys-' }), [Symbol.dispose]() { Deno.removeSync(this.dir, { recursive: true }); } };
  configureKeys(keys.dir);
  try {
    const mine = f.publish('outputs/mine.html', '<p>m</p>', 'c1');
    const theirs = f.publish('outputs/theirs.html', '<p>t</p>', 'c3');
    f.post('pin', { id: mine.id, pinned: true });
    const key = issue('c1')!;
    // the service refuses an agent key on delete too
    assertEquals(f.post('delete', { id: mine.id }, keyed(key))[0], 403);
    const [status, body] = f.post('archive', { conversationId: 'c1', ids: [mine.id, theirs.id] }, keyed(key));
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals((body.artifacts as Json[]).map((a) => a.id), [mine.id]);
    assertEquals(body.refused, [{ id: theirs.id, code: 'wrong_conversation', error: 'That artifact belongs to another chat' }]);
    assertEquals(body.unpinned, [mine.id]);
    const archived = f.store.get(mine.id);
    assertEquals([archived.archivedAt, archived.pinned], [f.clock.t, false]);
    // another chat's only: 403
    const [refusedStatus, refused] = f.post('archive', { conversationId: 'c1', ids: [theirs.id] }, keyed(key));
    assertEquals([refusedStatus, refused.code], [403, 'wrong_conversation']);
    assertEquals(f.store.get(theirs.id).archivedAt, undefined);
    // a key for another chat is refused outright
    assertEquals(f.post('archive', { conversationId: 'c3', ids: [theirs.id] }, keyed(key))[0], 403);
    // the page may archive any artifact (one opened from another chat's link)
    assertEquals(f.post('archive', { ids: [theirs.id], archived: true })[0], 200);
    // unarchive does not pin again
    const [, back] = f.post('archive', { conversationId: 'c1', ids: [mine.id], archived: false }, keyed(key));
    assertEquals([(back.artifacts as Json[])[0].archivedAt, (back.artifacts as Json[])[0].pinned], [undefined, false]);
    // a deleted artifact cannot be archived
    f.del(mine.id);
    assertEquals(f.post('archive', { ids: [mine.id] })[1].code, 'deleted');
    // archived ones stay in the default list (the agent's list and the Files marks), flagged
    const listed = f.get('/api/live/artifacts', { conversationId: ['c3'] })[1].artifacts as Json[];
    assertEquals(listed.map((a) => [a.id, typeof a.archivedAt]), [[theirs.id, 'number']]);
  } finally {
    configureKeys(null);
  }
});

Deno.test('archive: a pinned artifact loses its keep-every-version protection (30 kept, v1 and the latest)', () => {
  using f = fixture();
  const m = f.store.create('c1', 'P', 'text', 'p.txt', enc('v1'), { project: f.project });
  f.store.setPinned(m.id, true);
  for (let n = 2; n <= 35; n++) {
    f.clock.t += 10;
    f.store.addVersion(m.id, enc('v' + n));
  }
  assertEquals(f.store.get(m.id).versions.length, 35);
  f.store.setArchived(m.id, true);
  f.clock.t += 10;
  f.store.addVersion(m.id, enc('v36'));
  const versions = f.store.get(m.id).versions;
  assertEquals(versions.length, limits.maxVersions);
  assertEquals([versions[0].n, versions.at(-1)!.n], [1, 36]);
});

// ---- files that must stay (breaks 11, 12, 13) ---------------------------------------------------------------------------------

Deno.test('delete keeps the file: owner folder unknown, shared by another artifact, outside the folder, aib-docs, .git', () => {
  using f = fixture();
  // the owner chat's folder cannot be resolved
  const unknown = f.publish('outputs/u.html', '<p>u</p>');
  f.store.save({ ...f.store.get(unknown.id), conversationId: 'gone-chat' });
  let [, body] = f.del(unknown.id);
  assertEquals([(body.file as Json).action, (body.file as Json).code], ['kept', 'folder_unknown']);
  assert(f.exists(unknown.path));
  assertEquals((body.artifact as Json).deletedFile, { path: unknown.path, kept: "AIB can't find this chat's folder", code: 'folder_unknown' });
  // two chats in one folder show the same file
  const shared = f.publish('outputs/shared.html', '<p>s</p>', 'c1');
  const twin = f.post('publish', { conversationId: 'c2', title: 'S', path: shared.path })[1];
  assert(twin.id !== shared.id);
  [, body] = f.del(shared.id);
  assertEquals([(body.file as Json).code, (body.file as Json).reason], ['shared', 'another artifact shows it']);
  assert(f.exists(shared.path));
  // the twin is the last one showing it now: its Delete takes the file
  assertEquals((f.del(twin.id as string)[1].file as Json).action, 'moved');
  // a source outside the owner chat's folder (made by hand: the routes never allow one)
  const outside = f.write('outputs/far.html', '<p>far</p>', f.other);
  const far = f.store.create('c1', 'Far', 'html', 'far.html', enc('<p>far</p>'), { sourcePath: outside, by: 'tool' });
  assertEquals((f.del(far.id)[1].file as Json).code, 'outside');
  assert(f.exists(outside));
  // aib-docs and .git
  for (const [rel, code] of [['aib-docs/plan/1 Intro.md', 'docs'], ['.git/info/notes.txt', 'git']]) {
    const path = f.write(rel, 'x');
    const m = f.store.create('c1', rel, 'text', 'x.txt', enc('x'), { sourcePath: path, by: 'tool' });
    assertEquals((f.del(m.id)[1].file as Json).code, code, rel);
    assert(f.exists(path), rel);
  }
  // the file was already gone
  const gone = f.publish('outputs/gone.html', '<p>g</p>');
  Deno.removeSync(gone.path);
  assertEquals((f.del(gone.id)[1].file as Json).code, 'gone');
});

Deno.test('delete keeps a symlink (and a file reached through a linked folder)', () => {
  using f = fixture();
  const target = f.write('outputs/real.html', '<p>r</p>');
  const link = join(f.project, 'outputs', 'link.html');
  try {
    Deno.symlinkSync(target, link, { type: 'file' });
  } catch {
    console.log('  (symlinks need Developer Mode or admin on Windows here: skipped)');
    return;
  }
  const m = f.store.create('c1', 'L', 'html', 'link.html', enc('<p>r</p>'), { sourcePath: link, by: 'tool' });
  assertEquals((f.del(m.id)[1].file as Json).code, 'link');
  assert(f.exists(link) && f.exists(target));
});

Deno.test('delete: a locked file (another program holds it) refuses the whole Delete and changes nothing', () => {
  using f = fixture();
  const { id, path } = f.publish('outputs/report.pdf', '%PDF-1.4 x');
  const before = f.manifestBytes(id);
  // forced through the move hook (every OS): the rename fails with a sharing violation
  f.service.fileOps = {
    rename: () => {
      throw Object.assign(new Error('The process cannot access the file because it is being used by another process. (os error 32)'), {
        code: 'EBUSY',
      });
    },
  };
  const [status, body] = f.del(id);
  assertEquals([status, body.code], [409, 'locked']);
  assertEquals(body.error, 'Close report.pdf in the other program, then try again.');
  assertEquals(f.manifestBytes(id), before);
  assert(f.exists(path));
  assertEquals(f.binFiles(id), []);
});

Deno.test({
  name: 'delete: a file really locked by an open handle without sharing (Windows) is refused and kept',
  ignore: !WIN,
  fn() {
    using f = fixture();
    const { id, path } = f.publish('outputs/data.csv', 'a,b\n1,2\n');
    Deno.writeTextFileSync(path, 'a,b\n1,2\n3,4\n'); // changed since: a version would be added if the delete went ahead
    const before = f.manifestBytes(id);
    // CreateFileW with share mode 0 (in this process: no child process, no window): Deno's own opens always share delete
    const k32 = Deno.dlopen('kernel32.dll', {
      CreateFileW: { parameters: ['buffer', 'u32', 'u32', 'pointer', 'u32', 'u32', 'pointer'], result: 'pointer' },
      CloseHandle: { parameters: ['pointer'], result: 'i32' },
    });
    const wide = new Uint16Array(path.length + 1);
    for (let i = 0; i < path.length; i++) wide[i] = path.charCodeAt(i);
    const handle = k32.symbols.CreateFileW(new Uint8Array(wide.buffer), 0xC0000000, 0, null, 3, 0x80, null);
    try {
      const [status, body] = f.del(id);
      assertEquals([status, body.code], [409, 'locked'], JSON.stringify(body));
      assertEquals(f.manifestBytes(id), before, 'nothing changed: no version, no deletedAt');
    } finally {
      k32.symbols.CloseHandle(handle);
      k32.close();
    }
    assertEquals(Deno.readTextFileSync(path), 'a,b\n1,2\n3,4\n');
    assertEquals(f.binFiles(id), []);
  },
});

Deno.test('delete and restore across drives: copy, check the hash, then remove the original', () => {
  using f = fixture();
  const { id, path } = f.publish('outputs/x.html', '<p>cross</p>');
  const calls: string[] = [];
  f.service.fileOps = {
    rename: (from) => {
      calls.push(from);
      throw new Error('The system cannot move the file to a different disk drive. (os error 17)');
    },
  };
  assertEquals((f.del(id)[1].file as Json).action, 'moved');
  assert(!f.exists(path));
  assertEquals(Deno.readTextFileSync(join(f.store.root, id, BIN_FOLDER, 'x.html')), '<p>cross</p>');
  assertEquals((f.undel(id)[1].file as Json).action, 'restored');
  assertEquals(Deno.readTextFileSync(path), '<p>cross</p>');
  assertEquals(calls.length, 2, 'both moves went the copy way');
  assertEquals(f.binFiles(id), []);
});

// ---- Restore conflicts (break 14, owner answer C) ------------------------------------------------------------------------------

Deno.test('restore: a different file at the old path now: the old one comes back as "<name> (restored).<ext>"; both artifacts stay', () => {
  using f = fixture();
  const old = f.publish('outputs/report.html', '<p>old</p>');
  f.del(old.id);
  const fresh = f.publish('outputs/report.html', '<p>new</p>');
  assert(fresh.id !== old.id);
  const [, body] = f.undel(old.id);
  assertEquals(body.file, { path: 'outputs/report.html', action: 'restored_as', as: 'outputs/report (restored).html' });
  assertEquals(Deno.readTextFileSync(join(f.project, 'outputs', 'report.html')), '<p>new</p>');
  assertEquals(Deno.readTextFileSync(join(f.project, 'outputs', 'report (restored).html')), '<p>old</p>');
  assertEquals(f.store.get(old.id).sourcePath, join(f.project, 'outputs', 'report (restored).html'));
  assertEquals(f.store.get(fresh.id).sourcePath, fresh.path);
  // a second one takes "(restored 2)"
  f.del(old.id);
  const other = f.publish('outputs/report (restored).html', '<p>third</p>');
  assert(other.id);
  assertEquals((f.undel(old.id)[1].file as Json).as, 'outputs/report (restored 2).html');
});

Deno.test('restore: the same bytes already back at the path: the bin copy is dropped and the artifact follows the file', () => {
  using f = fixture();
  const { id, path } = f.publish('outputs/same.html', '<p>same</p>');
  f.del(id);
  Deno.writeTextFileSync(path, '<p>same</p>'); // put back by hand (git checkout, say)
  assertEquals((f.undel(id)[1].file as Json).action, 'restored');
  assertEquals(f.binFiles(id), []);
  assertEquals(f.store.get(id).sourcePath, path);
});

Deno.test('restore: a removed parent folder is made again (inside the owner folder only)', () => {
  using f = fixture();
  const { id, path } = f.publish('outputs/deep/er/page.html', '<p>deep</p>');
  f.del(id);
  Deno.removeSync(join(f.project, 'outputs', 'deep'), { recursive: true });
  assertEquals((f.undel(id)[1].file as Json).action, 'restored');
  assertEquals(Deno.readTextFileSync(path), '<p>deep</p>');
});

Deno.test('restore after the owner folder is gone: the artifact comes back with "source missing"; the copy is kept only if no version has it', () => {
  using f = fixture();
  const a = f.publish('outputs/a.html', '<p>a</p>');
  const b = f.publish('outputs/b.html', '<p>b</p>');
  f.del(a.id);
  f.del(b.id);
  // b's bin copy matches no version (stands in for a file over 25 MB, which gets no "File at delete time" version)
  Deno.writeTextFileSync(join(f.store.root, b.id, BIN_FOLDER, 'b.html'), '<p>b edited</p>');
  const mb = f.store.get(b.id);
  f.store.save({ ...mb, deletedSource: { ...(mb.deletedSource as Json), hash: 'not-a-version' } });
  f.folders.c1 = join(f.dir, 'removed-worktree'); // the worktree was removed after a merge
  let [, body] = f.undel(a.id);
  assertEquals([(body.file as Json).action, (body.file as Json).code], ['kept', 'folder_gone']);
  assert(!('as' in (body.file as Json)), 'a version has the same bytes: the copy is dropped');
  assertEquals((body.artifact as Json).sourceMissing, true);
  assertEquals(f.binFiles(a.id), []);
  [, body] = f.undel(b.id);
  const copy = join(f.store.root, b.id, BIN_FOLDER, 'b.html');
  assertEquals((body.file as Json).as, copy);
  assertEquals((body.artifact as Json).sourceCopy, copy, 'the viewer can offer "Copy path"');
  assertEquals(Deno.readTextFileSync(copy), '<p>b edited</p>');
});

// ---- the 30-day purge and "Delete now" (break 16, owner answer B) ---------------------------------------------------------------

Deno.test('purge: restorable at 29 days, gone at 31 with its bin copy; the link state is then "gone"', () => {
  using f = fixture();
  const keep = f.publish('outputs/keep.html', '<p>k</p>');
  const lose = f.publish('outputs/lose.html', '<p>l</p>');
  f.del(keep.id);
  f.del(lose.id);
  const doc = f.store.create(null, 'doc', 'md', 'doc.aibdoc.json', enc('{}'), { by: 'user', note: 'rev 1' }); // a doc's history
  f.store.save({ ...f.store.get(doc.id), deletedAt: f.clock.t }); // never purged even if marked
  f.clock.t += 29 * DAY;
  assertEquals(f.service.sweep(), []);
  assertEquals(f.undel(keep.id)[0], 200, 'Restore still works at 29 days');
  f.clock.t += 2 * DAY;
  const seen = f.events.length;
  assertEquals(f.service.sweep(), [lose.id]);
  assert(!f.exists(join(f.store.root, lose.id)), 'the folder, its versions and the bin copy are gone');
  assert(!f.exists(lose.path), 'and the file is gone for good');
  assert(f.exists(join(f.store.root, doc.id)), "a doc's history is never purged");
  assertEquals(f.events.slice(seen).map(([, e]) => e.artifact), [{ id: lose.id, conversationId: 'c1', purged: true }]);
  assertEquals(f.get('/api/live/artifacts/states', { ids: [`${lose.id},${keep.id}`] })[1].states, { [lose.id]: 'gone', [keep.id]: 'live' });
});

Deno.test('purge now ("Delete now"): only for an artifact in Recently deleted, page only', () => {
  using f = fixture();
  const { id } = f.publish('outputs/now.html', '<p>n</p>');
  assertEquals(f.post('purge', { id })[1].code, 'not_deleted');
  f.del(id);
  assertEquals(f.post('purge', { id }, keyed('k'))[0], 403);
  assertEquals(f.post('purge', { id }), [200, { purged: id }]);
  assert(!f.exists(join(f.store.root, id)));
  assertEquals(f.post('purge', { id })[1].code, 'not_found');
});

// ---- link states (break 9, server side) ----------------------------------------------------------------------------------------

Deno.test('states: live, archived, deleted and gone in one lookup; at most 200 ids; page token only', () => {
  using f = fixture();
  const live = f.publish('outputs/l.html', '1').id;
  const archived = f.publish('outputs/a.html', '2').id;
  const deleted = f.publish('outputs/d.html', '3').id;
  f.post('archive', { ids: [archived] });
  f.del(deleted);
  const ids = [live, archived, deleted, '0123456789abcdef', 'not-an-id'].join(',');
  assertEquals(f.get('/api/live/artifacts/states', { ids: [ids] }), [200, {
    states: { [live]: 'live', [archived]: 'archived', [deleted]: 'deleted', '0123456789abcdef': 'gone', 'not-an-id': 'gone' },
  }]);
  assertEquals(f.get('/api/live/artifacts/states', { ids: [Array(201).fill(live).join(',')] })[0], 400);
  assertEquals(f.get('/api/live/artifacts/states', { ids: [live] }, keyed('k'))[0], 403);
  // the doc "Shown in" list (store.list(null)) leaves deleted artifacts out
  assertEquals((f.store.list(null) as Json[]).map((a) => a.id).sort(), [live, archived].sort());
  assertEquals((f.store.list(null, [], { deleted: true }) as Json[]).length, 3);
});

Deno.test('the manifest of a deleted artifact keeps where the file went (hash, size) and the summary fields stay out when unset', () => {
  using f = fixture();
  const { id } = f.publish('outputs/m.html', '<p>m</p>');
  const plain = f.store.summary(f.store.get(id));
  for (const key of ['archivedAt', 'deletedAt', 'purgeAt', 'deletedFile', 'sourceCopy']) assert(!(key in plain), key);
  f.del(id);
  const m: Manifest = f.store.get(id);
  const ds = m.deletedSource as Json;
  assertEquals([ds.rel, ds.bin, ds.size], ['outputs/m.html', BIN_FOLDER + '/m.html', 8]);
  assertEquals(typeof ds.hash, 'string');
  assert(/"deletedAt": \d+\.0/.test(f.manifestBytes(id)), 'written as a Python float');
});
