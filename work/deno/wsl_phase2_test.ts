/**
 * WSL phase 2, the small pieces (docs/wsl/design.md section 11; outputs/agent-studio/docs/WSL.md), without a distro:
 *   1. Files view previews (images, pages) of a WSL project: the helper's bytes become a read-only ticket the artifact origin serves.
 *   2. Files outside a WSL chat's folder: the helper method files.outside and the route's "the chat named it" guard (Linux rules).
 *   3. Project delete in a distro: the helper's refusals and trash (gio, the freedesktop trash by hand, never a permanent delete) and
 *      the route that sends the dialog's check and "Move folder to trash" to it.
 *   4. Codex usage limits of a WSL chat: the helper's codex.limits and the feed's per-distro key.
 * A FakeWslHost answers the route tests; the helper's methods run in-process on temp folders. The real distro is wsl_phase2_e2e_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { wslFiles } from '../../outputs/agent-studio/server/web/wsl_routes.ts';
import { _tickets, issueBytes, lookupBytes, MAX_WSL_BYTES, TICKET_TTL_MS } from '../../outputs/agent-studio/server/web/file_tickets.ts';
import { artifactAnswer } from '../../outputs/agent-studio/server/artifacts/origin.ts';
import { _mentioned, filesRoutes } from '../../outputs/agent-studio/server/web/files_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import { makeMethods } from '../../outputs/agent-studio/server/wsl/helper/methods.ts';
import { handleLine } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import { mentions } from '../../outputs/agent-studio/server/worktrees/outside_files.ts';
import {
  distroRefusal,
  distroTrash,
  encodeTrashPath,
  inspectInDistro,
  sameDisk,
  trashInDistro,
  trashInfo,
  trashRoot,
  xdgTrash,
} from '../../outputs/agent-studio/server/wsl/helper/trash.ts';
import { Refused, RemovedProjects } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { projectRemove } from '../../outputs/agent-studio/server/web/project_routes.ts';
import { LimitsFeed, type LimitsConnection } from '../../outputs/agent-studio/server/host/usage_limits_feed.ts';
import { UsageLimitsStore } from '../../outputs/agent-studio/server/state/usage_limits.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
Deno.env.set('AGENT_STUDIO_TEST', '1');
const TEST_ROOT = '/tmp/aib-wsl-test-phase2';
Deno.env.set('AIB_WSL_ROOT', TEST_ROOT);

const REF = 'wsl://ubuntu/home/u/app';
const b64 = (bytes: Uint8Array | string) => btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function withHost(host: FakeWslHost | null): void {
  setWslHostResolver((d) => (host && d === host.distro.toLowerCase() ? host : null));
}

const call = (methods: ReturnType<typeof makeMethods>, method: string, params: Json) =>
  handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), methods) as Promise<{
    result?: Json;
    error?: { message: string; data?: { code?: string } };
  }>;

function helperMethods(home: string) {
  return makeMethods({ env: () => Promise.resolve({ env: { HOME: home }, shell: '/bin/sh', home, arch: 'amd64' }) });
}

// ---- 1. previews ------------------------------------------------------------------------------------------------------------
Deno.test({
  name: 'wsl preview: an image and a page get a ticket link the artifact origin serves from the helper bytes; binary and too big do not',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    const files: Record<string, { bytes: Uint8Array; size?: number; truncated?: boolean }> = {
      'logo.png': { bytes: PNG },
      'page.html': { bytes: new TextEncoder().encode('<h1>hi</h1>') },
      'doc.md': { bytes: new TextEncoder().encode('# Title\n') },
      'blob.bin': { bytes: new Uint8Array([1, 0, 2]) },
      'huge.png': { bytes: PNG, size: 5 * 1024 * 1024, truncated: true },
      'icon.svg': { bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    };
    host.handlers['files.read'] = (p) => {
      const f = files[String(p.rel)];
      return { bytesB64: b64(f.bytes), size: f.size ?? f.bytes.length, truncated: !!f.truncated, mtimeMs: 0 };
    };
    withHost(host);
    try {
      const wsl = { distro: 'ubuntu', linuxPath: '/home/u/app' };
      const origin = 'http://127.0.0.1:9';
      const read = async (name: string, o = origin) => (await wslFiles('read', REF, wsl, { path: [name] }, o))[1] as Json;
      const png = await read('logo.png');
      assertEquals([png.image, png.text, png.tooBig], [true, null, false]);
      assert(String(png.viewUrl).startsWith(origin + '/f/') && String(png.viewUrl).endsWith('/logo.png'), String(png.viewUrl));
      // the origin serves it: the image bytes, an image type, read only, no file path on this PC involved
      const sent: { status: number; body: Uint8Array | string; mime?: string }[] = [];
      const send = (status: number, body: Uint8Array | string, mime?: string) => {
        sent.push({ status, body, mime });
        return new Response('');
      };
      artifactAnswer('unused-base', String(png.viewUrl).slice(origin.length), send, true);
      assertEquals([sent[0].status, sent[0].mime], [200, 'image/png']);
      assertEquals([...(sent[0].body as Uint8Array)], [...PNG]);
      // the same file keeps its ticket; a phone-style origin (tickets off) never serves it
      assertEquals((await read('logo.png')).viewUrl, png.viewUrl);
      sent.length = 0;
      artifactAnswer('unused-base', String(png.viewUrl).slice(origin.length), send, false);
      assertEquals(sent[0].status, 404);
      const page = await read('page.html');
      assert(String(page.viewUrl).endsWith('/page.html'));
      const md = await read('doc.md');
      assert(String(md.viewUrl).endsWith('/doc.md?view=1'), String(md.viewUrl));
      sent.length = 0;
      artifactAnswer('unused-base', String(md.viewUrl).slice(origin.length), send, true);
      assertEquals([sent[0].status, sent[0].mime], [200, 'text/html; charset=utf-8']);
      assert(String(new TextDecoder().decode(sent[0].body as Uint8Array)).includes('Title'));
      assert(String((await read('icon.svg')).viewUrl).endsWith('/icon.svg'));
      assertEquals((await read('blob.bin')).viewUrl, '');
      assertEquals((await read('huge.png')).viewUrl, '', 'over the 1 MB cap: no preview, as on Windows');
      assertEquals((await read('logo.png', '')).viewUrl, '', 'no origin: no link');
    } finally {
      setWslHostResolver(null);
    }
  },
});

Deno.test('wsl preview tickets: bytes expire with the ticket, the same ref replaces its bytes, the total stays under the cap', () => {
  _tickets.clear();
  const t0 = 1_000_000;
  const a = issueBytes('wsl://ubuntu/x/a.png', new Uint8Array([1]), t0);
  assertEquals(issueBytes('wsl://ubuntu/x/a.png', new Uint8Array([2, 2]), t0 + 1), a);
  assertEquals([...lookupBytes(a, t0 + 2)!], [2, 2]);
  assertEquals(lookupBytes(a, t0 + 1 + TICKET_TTL_MS + 1), null);
  assertEquals(lookupBytes('0'.repeat(32)), null);
  _tickets.clear();
  const big = new Uint8Array(1024 * 1024);
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(issueBytes(`wsl://ubuntu/x/${i}.png`, big, t0 + i));
  let held = 0;
  for (const t of _tickets.values()) held += t.bytes?.length ?? 0;
  assert(held <= MAX_WSL_BYTES, `held ${held}`);
  assertEquals(lookupBytes(ids[0], t0 + 100), null, 'the oldest went first');
  assert(lookupBytes(ids[59], t0 + 100) !== null);
  _tickets.clear();
});

// ---- 2. outside files -------------------------------------------------------------------------------------------------------
Deno.test('outside guard by Linux rules: case kept, a longer name is not a mention, the JSON-escaped form counts', () => {
  assert(mentions(['wrote /home/u/Other/pic.png.'], '/home/u/Other/pic.png', true));
  assert(!mentions(['wrote /home/u/other/pic.png'], '/home/u/Other/pic.png', true), 'case matters on Linux');
  assert(!mentions(['wrote /home/u/Other/pic.png.bak'], '/home/u/Other/pic.png', true));
  assert(mentions(['{"p":"\\/home\\/u\\/Other\\/pic.png"}'], '/home/u/Other/pic.png', true));
  assert(mentions(['/home/u/Other/pic.png'], '/home/u//Other/./pic.png', true), 'doubled and dot parts of the asked path are normalised');
});

Deno.test('helper files.outside: a picture comes with its bytes, peek leaves them out, a folder and a missing file are refused', async () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-outside-' }));
  try {
    Deno.writeFileSync(osp.join(dir, 'pic.png'), PNG);
    Deno.writeTextFileSync(osp.join(dir, 'a.txt'), 'hello\n');
    const methods = helperMethods(dir);
    const pic = await call(methods, 'files.outside', { path: osp.join(dir, 'pic.png') });
    assertEquals([pic.result?.bytesB64, (pic.result?.read as Json).image, (pic.result?.read as Json).name], [b64(PNG), true, 'pic.png']);
    assertEquals(((pic.result?.outside as Json).kind), 'folder');
    const peek = await call(methods, 'files.outside', { path: osp.join(dir, 'pic.png'), peek: true });
    assertEquals([peek.result?.bytesB64, (peek.result?.read as Json).text], [undefined, null]);
    const text = await call(methods, 'files.outside', { path: osp.join(dir, 'a.txt') });
    assertEquals([(text.result?.read as Json).text, text.result?.bytesB64], ['hello\n', undefined]);
    assertEquals((await call(methods, 'files.outside', { path: dir })).error?.data?.code, 'not_file');
    assertEquals((await call(methods, 'files.outside', { path: osp.join(dir, 'none.txt') })).error?.data?.code, 'not_found');
    assertEquals((await call(methods, 'files.outside', { path: 'relative/x.txt' })).error?.data?.code, 'bad_path');
    assertEquals((await call(methods, 'files.outside', { path: osp.join(dir, '..', 'x') })).error?.data?.code, 'bad_path');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: 'outside route for a WSL chat: only a path the chat named, Linux case rules, the helper does the read, the picture gets a link',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['files.outside'] = (p) => ({
      read: {
        path: p.path, abs: p.path, name: 'pic.png', size: PNG.length, mtime: 1, binary: true, tooBig: false, image: true, page: false, text: null, lines: 0,
      },
      outside: { kind: 'folder', folder: '/home/u/Other', top: '', branch: '', repo: '', text: '/home/u/Other' },
      ...(p.peek ? {} : { bytesB64: b64(PNG) }),
    });
    withHost(host);
    const events = [{ kind: 'tool', rawInput: { file_path: '/home/u/Other/pic.png' } }];
    const ctx = {
      token: 'tok',
      stateDir: null,
      host: {
        connections: new Map([['live1', { cwd: REF }], ['winchat', { cwd: 'C:\\work' }]]),
        liveState: (id: string) => Promise.resolve(id === 'live1' ? { cwd: REF, events } : null),
      },
      conversations: { entries: {} },
      transcripts: { stores: new Map() },
      artifacts: { store: { origin: 'http://127.0.0.1:9' }, conversations: () => [] },
    } as unknown as WebContext;
    const ask = async (query: Record<string, string>) => {
      _mentioned.clear();
      const handler = filesRoutes().get('GET /api/live/files/outside')!;
      const url = new URL('http://127.0.0.1/api/live/files/outside?' + new URLSearchParams(query));
      return await handler(ctx, url, null, new Request(url, { headers: { 'X-Studio-Token': 'tok' } })) as [number, Json];
    };
    try {
      const [s, read] = await ask({ id: 'live1', path: '/home/u/Other/pic.png' });
      assertEquals(s, 200);
      assertEquals([read.name, read.root, read.wsl, (read.outside as Json).kind], ['pic.png', '', true, 'folder']);
      assert(String(read.viewUrl).startsWith('http://127.0.0.1:9/f/') && String(read.viewUrl).endsWith('/pic.png'), String(read.viewUrl));
      assertEquals(host.calls.at(-1), ['files.outside', { path: '/home/u/Other/pic.png', peek: false }]);
      const [, peek] = await ask({ id: 'live1', path: '/home/u/Other/pic.png', peek: '1' });
      assertEquals([peek.viewUrl, host.calls.at(-1)![1].peek], ['', true]);
      const before = host.calls.length;
      const [s2, no] = await ask({ id: 'live1', path: '/home/u/other/pic.png' });
      assertEquals([s2, no.code, host.calls.length], [403, 'not_mentioned', before]); // never reached the distro
      assertEquals((await ask({ id: 'live1', path: 'relative.png' }))[1].code, 'bad_path');
      host.handlers['files.outside'] = () => {
        throw new WslHelperError('Not shown', 'hidden');
      };
      assertEquals((await ask({ id: 'live1', path: '/home/u/Other/pic.png' }))[0], 403);
      host.state = 'starting';
      assertEquals((await ask({ id: 'live1', path: '/home/u/Other/pic.png' }))[1].code, 'wsl_unavailable');
    } finally {
      setWslHostResolver(null);
    }
  },
});

// ---- 3. project delete in a distro -------------------------------------------------------------------------------------------
Deno.test('trash: the .trashinfo follows the freedesktop spec (percent-encoded Path, local DeletionDate)', () => {
  assertEquals(encodeTrashPath('/home/u/My App/ä(1)'), '/home/u/My%20App/%C3%A4%281%29');
  assertEquals(
    trashInfo('/home/u/my app', new Date(2026, 10, 14, 9, 5, 7)),
    '[Trash Info]\nPath=/home/u/my%20app\nDeletionDate=2026-11-14T09:05:07\n',
  );
  assertEquals(trashRoot('/home/u'), osp.join('/home/u', '.local', 'share', 'Trash'));
  assertEquals(trashRoot('/home/u', Deno.cwd()), osp.join(Deno.cwd(), 'Trash'));
});

function trashLab() {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-trash-' }));
  const p = (...parts: string[]) => osp.join(root, ...parts);
  Deno.mkdirSync(p('home'));
  Deno.mkdirSync(p('proj', 'app', 'src'), { recursive: true });
  Deno.writeTextFileSync(p('proj', 'app', 'src', 'a.txt'), 'keep me\n');
  Deno.mkdirSync(p('proj', 'other'), { recursive: true });
  const guard = { home: p('home'), own: [p('own')], projects: [p('proj', 'other')] };
  return { root, p, guard, dispose: () => Deno.removeSync(root, { recursive: true }) };
}

Deno.test('trash by hand: the folder moves into files/ with its .trashinfo, a second folder of the same name gets a new name', async () => {
  const lab = trashLab();
  try {
    const trash = trashRoot(lab.p('home'), lab.p('xdg'));
    assert(sameDisk(lab.p('proj', 'app'), trash));
    const layer = distroTrash({ home: lab.p('home'), dataHome: lab.p('xdg'), gio: null });
    assertEquals(await layer.kind(lab.p('proj', 'app')), 'xdg');
    const done = await trashInDistro(lab.p('proj', 'app'), lab.guard, layer);
    assertEquals(done, 'xdg');
    assertEquals(Deno.readTextFileSync(osp.join(trash, 'files', 'app', 'src', 'a.txt')), 'keep me\n');
    const info = Deno.readTextFileSync(osp.join(trash, 'info', 'app.trashinfo'));
    assert(info.startsWith('[Trash Info]\nPath=') && info.includes('DeletionDate='), info);
    assert(!osp.exists(lab.p('proj', 'app')), 'the folder left its place');
    Deno.mkdirSync(lab.p('proj', 'app'));
    assertEquals(await trashInDistro(lab.p('proj', 'app'), lab.guard, layer), 'xdg');
    assert(osp.isdir(osp.join(trash, 'files', 'app.1')) && osp.isfile(osp.join(trash, 'info', 'app.1.trashinfo')));
    assertEquals(await trashInDistro(lab.p('proj', 'gone'), lab.guard, layer), 'missing');
  } finally {
    lab.dispose();
  }
});

Deno.test('trash refusals: home, a parent of home, another project (holding or holding it), AIB data, a Windows drive, a top-level folder', async () => {
  const lab = trashLab();
  try {
    const layer = distroTrash({ home: lab.p('home'), dataHome: lab.p('xdg'), gio: null });
    const why = async (path: string, guard = lab.guard) => (await inspectInDistro(path, guard, layer)).refusal;
    assert((await why(lab.p('home'))).includes('home folder'));
    assert((await why(lab.root)).includes('home folder'), 'a folder that holds home');
    Deno.mkdirSync(lab.p('own'));
    assert((await why(lab.p('own'))).includes("AIB's own data"));
    assert((await why(lab.p('proj'))).includes('holds another AIB project'));
    Deno.mkdirSync(lab.p('proj', 'other', 'inner'));
    assert((await why(lab.p('proj', 'other', 'inner'))).includes('inside another AIB project'));
    assertEquals(await why(lab.p('proj', 'app')), '');
    assert(distroRefusal('/mnt/c/Users/u/app', lab.guard).includes('Windows drive'));
    assert(distroRefusal('/mnt/wsl/x', lab.guard) === distroRefusal('/mnt/wsl/x', lab.guard));
    assert(distroRefusal('/home', lab.guard).includes('top-level'));
    assert(distroRefusal('/', lab.guard).includes('top-level'));
    // the refusals also stop trashInDistro, with the reason; nothing moved
    let said = '';
    try {
      await trashInDistro(lab.p('home'), lab.guard, layer);
    } catch (error) {
      said = error instanceof Refused ? error.message : 'other';
    }
    assert(said.includes('home folder'), said);
    assert(osp.isdir(lab.p('home')));
  } finally {
    lab.dispose();
  }
});

Deno.test('a distro with no trash it can use is a refusal, never a permanent delete', async () => {
  const lab = trashLab();
  try {
    const layer = { kind: () => Promise.resolve('permanent' as const), trash: () => Promise.reject(new Error('must not be called')) };
    const seen = await inspectInDistro(lab.p('proj', 'app'), lab.guard, layer);
    assert(seen.exists && seen.refusal.includes('no trash'), seen.refusal);
    let said = '';
    try {
      await trashInDistro(lab.p('proj', 'app'), lab.guard, layer);
    } catch (error) {
      said = error instanceof Refused ? error.message : 'other';
    }
    assert(said.includes('no trash'), said);
    assert(osp.isdir(lab.p('proj', 'app')), 'untouched');
    // xdgTrash itself never removes anything for good: a failed rename leaves the folder and no .trashinfo
    const trash = lab.p('xdg', 'Trash');
    let failed = false;
    try {
      xdgTrash(lab.p('proj', 'nothing-here'), trash);
    } catch {
      failed = true;
    }
    assert(failed);
    assertEquals([...Deno.readDirSync(osp.join(trash, 'info'))].length, 0);
  } finally {
    lab.dispose();
  }
});

Deno.test('helper project.inspect / project.trash: the same answers over the wire, the refusal carries code "refused"', async () => {
  const lab = trashLab();
  try {
    const methods = helperMethods(lab.p('home'));
    const args = { projects: [lab.p('proj', 'other')], dataHome: lab.p('xdg') };
    const seen = await call(methods, 'project.inspect', { path: lab.p('proj', 'app'), ...args });
    assertEquals([seen.result?.exists, seen.result?.worktreeOf], [true, '']);
    const refused = await call(methods, 'project.trash', { path: lab.p('home'), ...args });
    assertEquals(refused.error?.data?.code, 'refused');
    assert(osp.isdir(lab.p('home')));
    assertEquals((await call(methods, 'project.trash', { path: 'relative', ...args })).error !== undefined, true);
    assertEquals((await call(methods, 'project.trash', { path: lab.p('proj', 'none'), ...args })).result?.disk, 'missing');
    // a real trash move: gio when the machine has it, else by hand; either way the folder is gone from its place
    const done = await call(methods, 'project.trash', { path: lab.p('proj', 'app'), ...args });
    if (done.error) assert(done.error.message.length > 0); // a Windows machine has neither gio nor the same disk rules
    else assert(['gio', 'xdg'].includes(String(done.result?.disk)) && !osp.exists(lab.p('proj', 'app')));
  } finally {
    lab.dispose();
  }
});

Deno.test({
  name: 'project remove of a WSL project: the check and the trash go to the distro helper with Linux paths; nothing else touches the folder',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['project.inspect'] = () => ({ exists: true, refusal: '', trash: 'gio', worktreeOf: '' });
    host.handlers['project.trash'] = () => ({ disk: 'gio' });
    withHost(host);
    const removed = new RemovedProjects(null);
    const ctx = {
      stateDir: Deno.makeTempDirSync({ prefix: 'aib-wsl-rm-' }),
      conversations: { public: () => ({ entries: {} }) },
      removedProjects: removed,
    } as unknown as Parameters<typeof projectRemove>[0];
    try {
      const others = ['wsl://ubuntu/home/u/other', 'wsl://debian/home/u/x', 'C:\\work\\win'];
      const [s1, check] = await projectRemove(ctx, { path: REF, check: true, projects: others });
      assertEquals([s1, check.ok, check.trash, check.refusal], [200, true, 'gio', '']);
      const asked = host.calls.at(-1)!;
      assertEquals(asked[0], 'project.inspect');
      assertEquals([asked[1].path, asked[1].projects], ['/home/u/app', ['/home/u/other']]);
      assertEquals(typeof asked[1].dataHome, 'string', 'under test the trash is inside AIB_WSL_ROOT');
      assert(String(asked[1].dataHome).startsWith(TEST_ROOT + '/home'));
      // only Remove from AIB: the distro is not asked at all
      const n = host.calls.length;
      const [s2, plain] = await projectRemove(ctx, { path: REF, disk: false });
      assertEquals([s2, plain.disk, host.calls.length], [200, 'kept', n]);
      assert(!removed.has(REF) === false, 'remembered as removed');
      removed.removed.clear();
      const [s3, moved] = await projectRemove(ctx, { path: REF, disk: true, expect: 'gio' });
      assertEquals([s3, moved.disk, host.calls.at(-1)![0]], [200, 'gio', 'project.trash']);
      assert(removed.has(REF));
      removed.removed.clear();
      host.handlers['project.trash'] = () => {
        throw new WslHelperError('This is your home folder (or holds it). AIB will not delete it.', 'refused');
      };
      const [s4, refused] = await projectRemove(ctx, { path: REF, disk: true });
      assertEquals([s4, refused.code], [409, 'refused']);
      assert(!removed.has(REF), 'a refused delete keeps the project');
      host.state = 'starting';
      const [s5, down] = await projectRemove(ctx, { path: REF, disk: true });
      assertEquals([s5, down.code], [409, 'refused']);
      const [, line] = await projectRemove(ctx, { path: REF, check: true });
      assertEquals(line.refusal, 'Starting Ubuntu…');
    } finally {
      setWslHostResolver(null);
      Deno.removeSync(String((ctx as unknown as { stateDir: string }).stateDir), { recursive: true });
    }
  },
});

// ---- 4. Codex limits --------------------------------------------------------------------------------------------------------
const RATE = {
  limit_id: 'codex',
  primary: { used_percent: 12.0, window_minutes: 300, resets_at: 1794388969 },
  secondary: { used_percent: 48.0, window_minutes: 10080, resets_at: 1794613768 },
  plan_type: 'plus',
};
function writeRollout(codexDir: string): void {
  const day = [codexDir, 'sessions', '2026', '11', '14'].join(SEP);
  Deno.mkdirSync(day, { recursive: true });
  const line = { timestamp: '2026-11-14T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: RATE } };
  Deno.writeTextFileSync(day + SEP + 'rollout-2026-11-14T10-00-00-a.jsonl', JSON.stringify(line) + '\n');
}

Deno.test('helper codex.limits: the newest rate limits in the distro Codex folder (codexDir, else CODEX_HOME, else ~/.codex)', async () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-codex-' }));
  try {
    const methods = makeMethods({ env: () => Promise.resolve({ env: { CODEX_HOME: osp.join(dir, 'from-env') }, shell: '/bin/sh', home: osp.join(dir, 'home'), arch: 'amd64' }) });
    assertEquals((await call(methods, 'codex.limits', { codexDir: osp.join(dir, 'none') })).result, { found: null });
    writeRollout(osp.join(dir, 'x'));
    const asked = (await call(methods, 'codex.limits', { codexDir: osp.join(dir, 'x') })).result!.found as Json;
    assertEquals([(asked.rateLimits as Json).plan_type, asked.at], ['plus', Date.parse('2026-11-14T10:00:00Z') / 1000]);
    writeRollout(osp.join(dir, 'from-env'));
    assert((await call(methods, 'codex.limits', {})).result!.found !== null, 'CODEX_HOME of the login environment');
    writeRollout(osp.join(dir, 'home', '.codex'));
    assertEquals((await call(methods, 'codex.limits', { codexDir: 'relative' })).error !== undefined, true);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: 'codex limits of a WSL chat: read through the distro helper (under test its folder inside AIB_WSL_ROOT), keyed per distro',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['codex.limits'] = () => ({ found: { rateLimits: RATE, at: 1794380000 } });
    withHost(host);
    try {
      const feed = new LimitsFeed(new UsageLimitsStore(null), { now: () => 1794380100 });
      const chat = (wsl: { distro: string } | null, extra: Partial<LimitsConnection> = {}): LimitsConnection => ({
        provider: 'codex', command: ['node', 'codex-acp.js'], env: {}, sessionId: 's', ready: true, closed: false, wsl,
        request: () => Promise.reject(new Error('no requests expected')), ...extra,
      });
      const ubuntu = chat({ distro: 'ubuntu' });
      await feed.refresh(ubuntu);
      assertEquals(feed.key(ubuntu), 'wsl:ubuntu|codex');
      const view = feed.view(ubuntu)!;
      assertEquals([view.agent, view.windows.length, view.windows[0].usedPercent], ['codex', 2, 12]);
      assertEquals(host.calls.at(-1), ['codex.limits', { codexDir: TEST_ROOT + '/home/.codex' }]);
      // Windows' own Codex account is another key and stays empty (no session folder under test)
      const windows = chat(null);
      await feed.refresh(windows);
      assertEquals(feed.view(windows), null);
      // a distro that is not running is not started for this; a distro with no numbers shows no chip
      host.state = 'stopped';
      const feed2 = new LimitsFeed(new UsageLimitsStore(null), { now: () => 1794380100 });
      await feed2.refresh(ubuntu);
      assertEquals(feed2.view(ubuntu), null);
      host.state = 'ready';
      host.handlers['codex.limits'] = () => ({ found: null });
      const feed3 = new LimitsFeed(new UsageLimitsStore(null), { now: () => 1794380100 });
      await feed3.refresh(ubuntu);
      assertEquals(feed3.view(ubuntu), null);
    } finally {
      setWslHostResolver(null);
    }
  },
});
