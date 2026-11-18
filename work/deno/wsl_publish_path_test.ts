/**
 * Publish by `path` from a WSL chat (wsl/artifact_read.ts, helper files.readBytes, artifacts.ts WSL_FILE_RESOLVED, the publish route's
 * attachWslFile). No distro: a FakeWslHost whose files.readBytes is the real helper method run on a temp folder that stands in for the
 * Linux one (the root mapped at the last step, as _wsl_fake.ts maps spawns). The real-distro run is wsl_publish_path_e2e_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { makeMethods } from '../../outputs/agent-studio/server/wsl/helper/methods.ts';
import { handleLine } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import {
  absoluteLinux,
  publishRoots,
  READ_CHUNK,
  readWslSnapshot,
  type WslReadTarget,
  WslReadError,
  wslPublishFile,
} from '../../outputs/agent-studio/server/wsl/artifact_read.ts';
import { ArtifactStore, kindFor, MAX_FILE_BYTES, Service, WSL_FILE_RESOLVED } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import { attachWslFile } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const APP = '/home/u/app'; // the project's main folder
const COPY = '/home/u/.aib/worktrees/app-1'; // a chat's own copy

const helper = makeMethods({ env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home: '/', arch: 'amd64' }) });

/** A PNG-looking file of `size` bytes (the signature, then a pattern that is not valid UTF-8). */
function png(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].slice(0, size));
  for (let i = 8; i < size; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** Linux folders -> temp Windows folders; the fake's files.readBytes is the real helper method on the mapped folder. */
class Distro {
  readonly dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-publish-' });
  readonly host = new FakeWslHost(this.dir, 'Ubuntu');
  pieces = 0;
  /** Called before each piece after the first (a test changes the file between pieces). */
  between: ((offset: number) => void) | null = null;
  constructor() {
    for (const linux of [APP, COPY]) {
      const win = this.dir + SEP + linux.split('/').filter(Boolean).join('_');
      Deno.mkdirSync(win, { recursive: true });
      this.host.folders.set(linux, win);
    }
    const win2linux = (abs: string) => {
      for (const [linux, win] of this.host.folders) {
        const real = Deno.realPathSync(win);
        if (abs === real || abs.startsWith(real + SEP)) return linux + abs.slice(real.length).replaceAll('\\', '/');
      }
      return abs;
    };
    this.host.handlers['files.readBytes'] = async (p: Json) => {
      this.pieces++;
      if (Number(p.offset) > 0) this.between?.(Number(p.offset));
      const reply = await handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'files.readBytes', params: { ...p, root: this.host.windowsFor(String(p.root)) } }),
        helper,
      ) as { result?: Json; error?: { code: number; message: string; data?: Json } };
      if (reply.error) throw new WslHelperError(reply.error.message, String(reply.error.data?.code ?? reply.error.code));
      return { ...reply.result, abs: win2linux(String(reply.result!.abs)) };
    };
  }
  write(linux: string, data: Uint8Array | string): void {
    const win = this.host.windowsFor(linux);
    Deno.mkdirSync(win.slice(0, win.lastIndexOf(SEP)), { recursive: true });
    if (typeof data === 'string') Deno.writeTextFileSync(win, data);
    else Deno.writeFileSync(win, data);
  }
  [Symbol.dispose](): void {
    Deno.removeSync(this.dir, { recursive: true });
  }
}

const target = (chatFolder = APP, projectFolder: string | null = null, maxBytes = MAX_FILE_BYTES): WslReadTarget => ({
  distroName: 'Ubuntu',
  chatFolder,
  projectFolder,
  maxBytes,
  kindOf: kindFor,
});

async function refused(work: Promise<unknown>): Promise<WslReadError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WslReadError) return error;
    throw error;
  }
  throw new Error('not refused');
}

// ---- the helper method ------------------------------------------------------------------------------------------------------

Deno.test('helper files.readBytes: pieces of at most 1 MB with size and mtime; the size cap; folders, missing files and .git refused', async () => {
  using d = new Distro();
  const data = png(READ_CHUNK + 5000);
  d.write(`${APP}/pics/a.png`, data);
  const root = d.host.windowsFor(APP);
  const call = async (params: Json) =>
    await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'files.readBytes', params: { root, ...params } }), helper) as {
      result?: Json;
      error?: { message: string; data?: Json };
    };
  const first = (await call({ rel: 'pics/a.png' })).result!;
  assertEquals([first.size, first.offset, first.path, atob(String(first.bytesB64)).length], [data.length, 0, 'pics/a.png', READ_CHUNK]);
  assert(Number(first.mtimeMs) > 0);
  const rest = (await call({ rel: 'pics/a.png', offset: READ_CHUNK, length: 10 * READ_CHUNK })).result!;
  assertEquals(atob(String(rest.bytesB64)).length, 5000, 'the rest, capped by the file');
  const asked = (await call({ rel: 'pics/a.png', length: 2 * READ_CHUNK })).result!;
  assertEquals(atob(String(asked.bytesB64)).length, READ_CHUNK, 'never more than 1 MB per answer');
  const big = (await call({ rel: 'pics/a.png', maxBytes: 100 })).error!;
  assertEquals([big.data?.code, big.message], ['too_large', `Too large: ${data.length} bytes`]);
  assertEquals((await call({ rel: 'pics' })).error?.data?.code, 'not_file');
  assertEquals((await call({ rel: 'pics/none.png' })).error?.data?.code, 'not_found');
  assertEquals((await call({ rel: '' })).error?.data?.code, 'not_file');
  assertEquals((await call({ rel: '../x.png' })).error?.data?.code, 'bad_path');
  assertEquals((await call({ rel: '.git/x.png' })).error?.data?.code, 'hidden');
});

// ---- reading through the helper ---------------------------------------------------------------------------------------------

Deno.test('readWslSnapshot: a 3 MB PNG read whole in 1 MB pieces, byte-identical; relative and absolute paths', async () => {
  using d = new Distro();
  const data = png(3 * 1024 * 1024 + 123);
  d.write(`${APP}/private/review/map.png`, data);
  const snap = await readWslSnapshot(d.host, target(), 'private/review/map.png');
  assertEquals(snap.data, data);
  assertEquals([snap.name, snap.linuxPath], ['map.png', `${APP}/private/review/map.png`]);
  assertEquals(d.pieces, 4);
  const abs = await readWslSnapshot(d.host, target(), `${APP}/private/./review/../review/map.png`);
  assertEquals(abs.data.length, data.length);
  for (const [method, params] of d.host.calls) {
    assertEquals(method, 'files.readBytes');
    assert(Number(params.length) <= READ_CHUNK);
  }
});

Deno.test('readWslSnapshot: a worktree chat reads its own copy, else the project folder (local-only files); absolute paths in either', async () => {
  using d = new Distro();
  d.write(`${APP}/private/notes.md`, '# main');
  d.write(`${COPY}/outputs/r.html`, '<p>copy</p>');
  d.write(`${APP}/outputs/r.html`, '<p>main</p>');
  const t = target(COPY, APP);
  assertEquals(new TextDecoder().decode((await readWslSnapshot(d.host, t, 'outputs/r.html')).data), '<p>copy</p>', 'its own copy first');
  const local = await readWslSnapshot(d.host, t, 'private/notes.md');
  assertEquals([new TextDecoder().decode(local.data), local.linuxPath], ['# main', `${APP}/private/notes.md`]);
  assertEquals((await readWslSnapshot(d.host, t, `${APP}/outputs/r.html`)).linuxPath, `${APP}/outputs/r.html`);
  assertEquals(publishRoots(COPY, APP), [COPY, APP]);
  assertEquals(publishRoots(APP, APP), [APP]);
  assertEquals(publishRoots(APP, null), [APP]);
});

Deno.test('readWslSnapshot: every refusal is one line naming the Linux path', async () => {
  using d = new Distro();
  d.write(`${APP}/a.png`, png(2000));
  d.write(`${APP}/tool.py`, 'print(1)');
  d.write(`${APP}/dir/x.txt`, 'x');
  const t = target(COPY, APP);
  const one = async (raw: unknown, tt = t) => await refused(readWslSnapshot(d.host, tt, raw));

  let e = await one('missing.png');
  assertEquals([e.status, e.code], [404, 'not_found']);
  assert(e.message.startsWith(`File not found in Ubuntu: ${COPY}/missing.png.`), e.message);
  e = await one(`${APP}/dir`);
  assertEquals([e.status, e.code, e.message], [400, 'not_file', `${APP}/dir is a folder, not a file: publish one file inside it.`]);
  e = await one('/etc/passwd');
  assertEquals([e.status, e.code], [403, 'outside_project']);
  assert(e.message.startsWith('Refused: /etc/passwd is outside the chat\'s folder ' + COPY), e.message);
  e = await one('../../../../etc/passwd');
  assertEquals(e.code, 'outside_project');
  assert(e.message.includes('/etc/passwd'), e.message);
  e = await one('../app-2/x.png');
  assertEquals(e.code, 'outside_project', 'a sibling copy is outside');
  e = await one(`${APP}/tool.py`);
  assertEquals([e.code, e.message.split(' cannot')[0]], ['unsupported_kind', `${APP}/tool.py`]);
  e = await one(`${APP}/a.png`, target(COPY, APP, 1000));
  assertEquals([e.status, e.code, e.message], [413, 'too_large', `${APP}/a.png is too large to publish (0.0 MB): the limit is 0.0 MB.`]);
  e = await one('~/a.png');
  assertEquals(e.code, 'bad_path');
  e = await one('C:\\Users\\x\\a.png');
  assert(e.code === 'bad_path' && e.message.includes('Windows path'), e.message);
  for (const bad of ['', '  ', 3, null, 'a\0b', 'x'.repeat(5000)]) assertEquals((await one(bad)).code, 'bad_path');
  e = await one('a.png', target(''));
  assertEquals(e.code, 'unknown_folder');

  // answers only the helper can give (a link out, permission, an old helper, a lost distro)
  const answer = (code: string, message = 'x') => {
    d.host.handlers['files.readBytes'] = () => {
      throw new WslHelperError(message, code);
    };
  };
  answer('outside', 'Not found');
  e = await one(`${APP}/link.png`);
  assertEquals([e.status, e.code], [403, 'outside_project']);
  assert(e.message.startsWith(`Refused: ${APP}/link.png leads outside`) && e.message.includes('through a link'), e.message);
  answer('unreadable', 'Permission denied');
  e = await one(`${APP}/a.png`);
  assertEquals([e.status, e.code], [403, 'unreadable']);
  assert(e.message.startsWith(`AIB cannot read ${APP}/a.png in Ubuntu: permission denied.`), e.message);
  answer('unknown_method');
  e = await one(`${APP}/a.png`);
  assert(e.code === 'helper_old' && e.message.includes('older than this AIB'), e.message);
  answer('helper_gone', 'The AIB helper in Ubuntu is not running');
  e = await one(`${APP}/a.png`);
  assertEquals([e.status, e.code], [503, 'wsl_unavailable']);
  assert(e.message.includes(`while reading ${APP}/a.png`), e.message);
  for (const m of [e.message]) assert(!m.includes('\n'), 'one line');
});

Deno.test('readWslSnapshot: a file that changes between pieces is refused ("changed while AIB read it")', async () => {
  using d = new Distro();
  const path = `${APP}/big.png`;
  d.write(path, png(2 * READ_CHUNK + 10));
  d.between = () => {
    d.write(path, png(2 * READ_CHUNK + 99, 3)); // grows: the size differs on the next piece
    d.between = null;
  };
  const e = await refused(readWslSnapshot(d.host, target(), 'big.png'));
  assertEquals([e.status, e.code, e.message], [409, 'changed', `${path} changed while AIB read it; publish again once it is written.`]);
});

Deno.test('absoluteLinux: relative against the base, `.` and `..` worked out, null past /', () => {
  assertEquals(absoluteLinux('a/./b/../c.png', '/home/u/app'), '/home/u/app/a/c.png');
  assertEquals(absoluteLinux('/x//y/', '/home'), '/x/y');
  assertEquals(absoluteLinux('../../../..', '/home/u'), null);
});

// ---- publishing the bytes ---------------------------------------------------------------------------------------------------

function service(dir: string) {
  const store = new ArtifactStore(dir + SEP + 'artifacts');
  // a WSL chat has no Windows folder (artifact_wiring: artifactFolder is null for a wsl:// ref)
  const svc = new Service(store, () => 't', () => null, { rootFor: () => 'wsl://ubuntu/home/u/app' });
  const h = { headers: new Headers({ 'X-Studio-Token': 't' }) };
  const post = (body: Json) => svc.handlePost(h, '/api/live/artifacts/publish', body) as [number, Json];
  const bytes = (id: string, n?: number) => {
    const m = store.get(id);
    return Deno.readFileSync(store.versionFile(m, n ?? m.versions[m.versions.length - 1].n));
  };
  return { store, svc, post, bytes };
}

Deno.test('publish by path (WSL): the PNG arrives byte-identical as an image; identical republish makes no version; a change does; update re-reads', async () => {
  using d = new Distro();
  const { store, post, bytes } = service(d.dir);
  const data = png(1500 * 1024);
  d.write(`${APP}/out/dw26-family.png`, data);
  const file = await wslPublishFile(`wsl://ubuntu${APP}`, null, 'out/dw26-family.png', d.host);
  assertEquals(file.ref, `wsl://ubuntu${APP}/out/dw26-family.png`);
  const [status, a] = post({ conversationId: 'c1', title: 'Family', path: 'out/dw26-family.png', [WSL_FILE_RESOLVED]: file });
  assertEquals(status, 200, JSON.stringify(a));
  assertEquals([a.kind, a.version, a.title, a.sourcePath], ['image', 1, 'Family', null]);
  assertEquals(a.wslSource, file.ref, 'the list entry carries the wsl:// ref, which the path links match (files-ui artifactForLink)');
  assertEquals(bytes(String(a.id)), data);
  const m = store.get(a.id);
  assertEquals([m.entry, m.wslSource, m.project], ['dw26-family.png', file.ref, 'wsl://ubuntu/home/u/app']);

  // the same file again: the same artifact, no new version (identical content)
  const again = post({ conversationId: 'c1', title: 'Family', path: 'out/dw26-family.png', [WSL_FILE_RESOLVED]: await wslPublishFile(`wsl://ubuntu${APP}`, null, `${APP}/out/dw26-family.png`, d.host) })[1];
  assertEquals([again.id, again.version], [a.id, 1]);
  // changed in the distro: a publish of the same path is version 2 of the same artifact
  const changed = png(1500 * 1024, 9);
  d.write(`${APP}/out/dw26-family.png`, changed);
  const v2 = post({ conversationId: 'c1', title: 'Family', path: 'out/dw26-family.png', [WSL_FILE_RESOLVED]: await wslPublishFile(`wsl://ubuntu${APP}`, null, 'out/dw26-family.png', d.host) })[1];
  assertEquals([v2.id, v2.version], [a.id, 2]);
  assertEquals(bytes(String(a.id)), changed);
  assertEquals(bytes(String(a.id), 1), data, 'v1 is the snapshot it was');
  // update by id re-reads the file; identical: no version
  const same = post({ conversationId: 'c1', id: a.id, path: 'x', [WSL_FILE_RESOLVED]: await wslPublishFile(`wsl://ubuntu${APP}`, null, 'out/dw26-family.png', d.host) })[1];
  assertEquals(same.version, 2);
  d.write(`${APP}/out/dw26-family.png`, data);
  const up = post({ conversationId: 'c1', id: a.id, note: 'back', path: 'x', [WSL_FILE_RESOLVED]: await wslPublishFile(`wsl://ubuntu${APP}`, null, 'out/dw26-family.png', d.host) })[1];
  assertEquals(up.version, 3);
  // another chat publishing the same file gets its own artifact; content still works
  const other = post({ conversationId: 'c2', title: 'Family', path: 'p', [WSL_FILE_RESOLVED]: await wslPublishFile(`wsl://ubuntu${APP}`, null, 'out/dw26-family.png', d.host) })[1];
  assert(other.id !== a.id);
  const page = post({ conversationId: 'c1', title: 'Page', content: '<p>hi</p>', filename: 'p.html' })[1];
  assertEquals(page.kind, 'html');
  // an svg and a pdf get their kinds by file name, as on Windows
  d.write(`${APP}/d.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  d.write(`${APP}/r.pdf`, '%PDF-1.4\n');
  for (const [name, kind] of [['d.svg', 'svg'], ['r.pdf', 'pdf']]) {
    assertEquals(post({ conversationId: 'c1', title: name, path: name, [WSL_FILE_RESOLVED]: await wslPublishFile(`wsl://ubuntu${APP}`, null, name, d.host) })[1].kind, kind);
  }
});

Deno.test('publish by path (WSL): without the route\'s read the path is refused (no Windows folder), and a forged snapshot is ignored', () => {
  using d = new Distro();
  const { post } = service(d.dir);
  const [status, reply] = post({ conversationId: 'c1', title: 'x', path: '/home/u/app/a.png' });
  assertEquals([status, reply.code], [404, 'unknown_folder']);
  // JSON cannot carry bytes: a caller's own value under the key is not a snapshot
  const forged = post({ conversationId: 'c1', title: 'x', path: 'a.png', [WSL_FILE_RESOLVED]: { data: 'aGk=', name: 'a.png', ref: 'wsl://x/a' } });
  assertEquals(forged[1].code, 'unknown_folder');
});

Deno.test('Open in Artifacts (preview) of a WSL file: a snapshot with its wsl:// ref; the same file again is the same artifact; a blocked guard refuses', async () => {
  using d = new Distro();
  const { svc, store } = service(d.dir);
  const h = { headers: new Headers({ 'X-Studio-Token': 't' }) };
  const preview = (body: Json, who: Json = h) => svc.handlePost(who as never, '/api/live/artifacts/preview', body) as [number, Json];
  d.write(`${APP}/site/index.html`, '<p>one</p>');
  const file = await wslPublishFile(`wsl://ubuntu${APP}`, null, `${APP}/site/index.html`, d.host);
  const [status, a] = preview({ conversationId: 'c1', path: `${APP}/site/index.html`, [WSL_FILE_RESOLVED]: file });
  assertEquals(status, 200, JSON.stringify(a));
  const id = String((a.artifact as Json | undefined)?.id ?? a.id);
  const m = store.get(id);
  assertEquals([m.kind, m.wslSource, m.sourcePath ?? null], ['html', file.ref, null]);
  const again = preview({ conversationId: 'c1', path: `${APP}/site/index.html`, [WSL_FILE_RESOLVED]: file })[1];
  assertEquals(String((again.artifact as Json | undefined)?.id ?? again.id), id, 'one artifact per file and chat');
  // a remote computer's guard sees the file's ref
  const seen: string[] = [];
  const guarded = preview({ conversationId: 'c1', path: 'x', [WSL_FILE_RESOLVED]: file }, { ...h, pathGuard: (p: string) => seen.push(p) });
  assertEquals(guarded[0], 200);
  assertEquals(seen, [file.ref]);
});

// ---- the route step ---------------------------------------------------------------------------------------------------------

function routeCtx(cwd: string | null, projectRoot: string | null = null, windowsFolder: string | null = null): WebContext {
  return {
    artifacts: {
      service: { chat: (id: string) => id, cwdFor: () => windowsFolder },
      chatStudio: () => ({ liveState: () => Promise.resolve(cwd ? { cwd } : null), conversations: { entries: {} }, store: { conversations: {} } }),
      connectionOf: (id: string) => id,
      projectRootOf: () => projectRoot,
    },
  } as unknown as WebContext;
}

Deno.test('route: a WSL chat\'s path is read through its distro\'s helper (worktree chat: its project folder too); refusals are the reply', async () => {
  using d = new Distro();
  setWslHostResolver((key) => (key === 'ubuntu' ? d.host : null));
  try {
    d.write(`${APP}/private/x.png`, png(4000));
    const body: Json = { conversationId: 'c1', title: 'X', path: 'private/x.png' };
    // a chat in its own copy: the connection's projectRoot is the project folder (the fake helper has no worktree registry)
    assertEquals(await attachWslFile(routeCtx(`wsl://ubuntu${COPY}`, `wsl://ubuntu${APP}`), body), null);
    const file = body[WSL_FILE_RESOLVED] as { data: Uint8Array; ref: string };
    assertEquals([file.data, file.ref], [png(4000), `wsl://ubuntu${APP}/private/x.png`]);

    const outside: Json = { conversationId: 'c1', title: 'X', path: '/etc/hosts' };
    const reply = await attachWslFile(routeCtx(`wsl://ubuntu${COPY}`, `wsl://ubuntu${APP}`), outside);
    assertEquals(reply?.[0], 403);
    assert(String((reply?.[1] as Json).error).startsWith('Refused: /etc/hosts is outside'), JSON.stringify(reply));
    assert(!(WSL_FILE_RESOLVED in outside));

    // a Windows chat (or no chat): nothing done here, artifacts.ts resolves the path as before
    const win: Json = { conversationId: 'c1', title: 'X', path: 'a.png' };
    assertEquals(await attachWslFile(routeCtx(null), win), null);
    assertEquals(await attachWslFile(routeCtx(`wsl://ubuntu${APP}`, null, 'C:/p'), win), null, 'a known Windows folder wins');
    assert(!(WSL_FILE_RESOLVED in win));

    // the distro is not there: one line, 503
    setWslHostResolver(() => null);
    const gone = await attachWslFile(routeCtx(`wsl://ubuntu${APP}`), { conversationId: 'c1', path: 'private/x.png' });
    assertEquals(gone?.[0], 503);
    assert(String((gone?.[1] as Json).error).startsWith('AIB cannot read files in'), JSON.stringify(gone));
  } finally {
    setWslHostResolver(null);
  }
});
