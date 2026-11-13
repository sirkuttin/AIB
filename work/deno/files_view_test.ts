/** The Files view's server side: path safety, .gitignore handling, listing, search, read, the three routes, view tickets and the worktree parent. */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { git, HAVE_GIT, write } from './_git_repo.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';
import * as files from '../../outputs/agent-studio/server/worktrees/files.ts';
import { filesRoutes } from '../../outputs/agent-studio/server/web/files_routes.ts';
import { issue, lookup, TICKET_TTL_MS } from '../../outputs/agent-studio/server/web/file_tickets.ts';
import { makeHandler } from '../../outputs/agent-studio/server/artifacts/origin.ts';
import { folderKinds } from '../../outputs/agent-studio/server/desktop/folders.ts';
import { mainCheckoutOf } from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';

const WIN = Deno.build.os === 'windows';

/** repo/ with a .gitignore, node_modules, an ignored build/ folder, a committed file, a changed one and a new one. */
function makeRepo(): { root: string; repo: string; dispose: () => void } {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-files-' }));
  const repo = osp.join(root, 'repo');
  Deno.mkdirSync(repo);
  const p = (...parts: string[]) => osp.join(repo, ...parts);
  if (HAVE_GIT) git(repo, 'init', '-q');
  write(p('.gitignore'), 'build/\n*.log\n');
  write(p('README.md'), '# hi\n');
  Deno.mkdirSync(p('scripts'));
  write(p('scripts', 'load.py'), 'a = 1\n');
  Deno.mkdirSync(p('node_modules', 'lib'), { recursive: true });
  write(p('node_modules', 'lib', 'index.js'), 'x');
  Deno.mkdirSync(p('build'));
  write(p('build', 'out.js'), 'x');
  write(p('debug.log'), 'x');
  if (HAVE_GIT) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
  }
  write(p('scripts', 'load.py'), 'a = 2\nb = 3\n');
  Deno.mkdirSync(p('outputs'));
  write(p('outputs', 'chart.html'), '<h1>c</h1>\n');
  write(p('outputs', 'pic.bin'), '\0\0\0');
  return {
    root,
    repo,
    dispose: () => {
      try {
        Deno.removeSync(root, { recursive: true });
      } catch { /* a git process may still hold a file */ }
    },
  };
}

Deno.test('safeParts refuses traversal, absolute, drive, UNC, streams and .git', () => {
  assertEquals(files.safeParts(''), []);
  assertEquals(files.safeParts('a/b\\c'), ['a', 'b', 'c']);
  for (
    const bad of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      'C:\\Windows',
      'c:/x',
      '\\\\srv\\share\\x',
      '//srv/x',
      'a/b:stream',
      '.git/config',
      'a\0b',
    ]
  ) {
    assertThrows(() => files.safeParts(bad), files.FilesError);
  }
});

Deno.test('resolveInside keeps every path inside the root, links included', () => {
  const r = makeRepo();
  try {
    const [abs, rel] = files.resolveInside(r.repo, 'scripts/load.py');
    assertEquals(rel, 'scripts/load.py');
    assert(abs.toLowerCase().endsWith(osp.join('scripts', 'load.py').toLowerCase()));
    assertThrows(() => files.resolveInside(r.repo, '../repo/README.md'), files.FilesError);
    assertThrows(() => files.resolveInside(r.repo, 'nope.txt'), files.FilesError);
    assertThrows(() => files.realRoot('\\\\srv\\share'), files.FilesError);
    // A link that points out of the root is refused (needs symlink rights on Windows; skipped without them).
    write(osp.join(r.root, 'secret.txt'), 's');
    let linked = false;
    try {
      Deno.symlinkSync(osp.join(r.root, 'secret.txt'), osp.join(r.repo, 'leak.txt'), { type: 'file' });
      linked = true;
    } catch { /* no symlink permission */ }
    if (linked) {
      assertThrows(() => files.readFile(r.repo, 'leak.txt'), files.FilesError);
      return files.listDir(r.repo, '').then((l) => assert(!l.entries.some((e) => e.name === 'leak.txt'), 'outside link listed'));
    }
  } finally {
    r.dispose();
  }
});

Deno.test({
  name: 'listDir: one level, .git never, node_modules and gitignored entries marked ignored, change letters and counts',
  ignore: !HAVE_GIT,
  fn: async () => {
    const r = makeRepo();
    try {
      const top = await files.listDir(r.repo, '');
      const by = new Map(top.entries.map((e) => [e.name, e]));
      assert(top.git);
      assert(!by.has('.git'));
      assertEquals(by.get('node_modules')!.ignored, true);
      assertEquals(by.get('build')!.ignored, true);
      assertEquals(by.get('debug.log')!.ignored, true);
      assertEquals(by.get('scripts')!.ignored, false);
      assertEquals(by.get('scripts')!.changed, 1);
      assertEquals(by.get('outputs')!.changed, 2);
      assertEquals(top.entries.slice(0, 1)[0].dir, true, 'folders first');
      const scripts = await files.listDir(r.repo, 'scripts');
      assertEquals(scripts.entries.map((e) => [e.path, e.status]), [['scripts/load.py', 'M']]);
      const outputs = await files.listDir(r.repo, 'outputs');
      assertEquals(outputs.entries.find((e) => e.name === 'chart.html')!.status, 'U');
    } finally {
      r.dispose();
    }
  },
});

Deno.test('listDir without git: plain listing, node_modules still ignored', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-files-plain-' }));
  try {
    Deno.mkdirSync(osp.join(root, 'node_modules'));
    write(osp.join(root, 'a.txt'), 'a');
    const l = await files.listDir(root, '');
    assertEquals(l.git, false);
    assertEquals(l.entries.map((e) => [e.name, e.ignored]), [['node_modules', true], ['a.txt', false]]);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test({
  name: 'search: names from the index, ignored files and node_modules never searched, index rebuilt on new writes',
  ignore: !HAVE_GIT,
  fn: async () => {
    const r = makeRepo();
    try {
      const s = await files.search(r.repo, 'chart', 'w1');
      assertEquals(s.matches.map((m) => [m.path, m.dir]), [['outputs/chart.html', 'outputs']]);
      assertEquals((await files.search(r.repo, 'index', 'w1')).matches, []);
      assertEquals((await files.search(r.repo, 'out.js', 'w1')).matches, []);
      write(osp.join(r.repo, 'outputs', 'chart2.svg'), '<svg/>');
      assertEquals((await files.search(r.repo, 'chart2', 'w1')).matches.length, 0, 'cached until the writes change');
      assertEquals((await files.search(r.repo, 'chart2', 'w2')).matches.length, 1);
      assert(files.score('a/chart.py', 'chart') > files.score('chart/a.py', 'chart'), 'name hits rank first');
    } finally {
      r.dispose();
    }
  },
});

Deno.test('readFile: text, binary, too big, image and page flags', () => {
  const r = makeRepo();
  try {
    const t = files.readFile(r.repo, 'scripts/load.py');
    assertEquals([t.text, t.lines, t.binary, t.page], ['a = 2\nb = 3\n', 2, false, false]);
    const b = files.readFile(r.repo, 'outputs/pic.bin');
    assertEquals([b.binary, b.text], [true, null]);
    assertEquals(files.readFile(r.repo, 'outputs/chart.html').page, true);
    write(osp.join(r.repo, 'big.txt'), 'x'.repeat(files.LIMITS.readBytes + 10));
    const big = files.readFile(r.repo, 'big.txt');
    assertEquals([big.tooBig, big.text], [true, null]);
    assertThrows(() => files.readFile(r.repo, 'scripts'), files.FilesError);
  } finally {
    r.dispose();
  }
});

function fakeCtx(cwd: string, origin = 'http://127.0.0.1:9'): WebContext {
  return {
    token: 'tok',
    stateDir: null,
    host: { liveState: (id: string) => Promise.resolve(id === 'live1' ? { cwd } : null) },
    conversations: { entries: {} },
    transcripts: {},
    artifacts: { store: { origin }, conversations: () => [] },
  } as unknown as WebContext;
}
const call = async (ctx: WebContext, path: string, query: string, token = 'tok') => {
  const handler = filesRoutes().get('GET ' + path)!;
  const url = new URL('http://127.0.0.1' + path + '?' + query);
  return await handler(ctx, url, null, new Request(url, { headers: { 'X-Studio-Token': token } }));
};

Deno.test('the three routes: token, chat folder, list / search / read, refusals', async () => {
  const r = makeRepo();
  try {
    const ctx = fakeCtx(r.repo);
    assertEquals((await call(ctx, '/api/live/files/list', 'id=live1', 'bad'))[0], 403);
    assertEquals((await call(ctx, '/api/live/files/list', 'id=nope'))[0], 404);
    const [s1, list] = await call(ctx, '/api/live/files/list', 'id=live1&dir=scripts') as [number, { entries: { path: string }[] }];
    assertEquals([s1, list.entries.map((e) => e.path)], [200, ['scripts/load.py']]);
    assertEquals((await call(ctx, '/api/live/files/list', 'id=live1&dir=..'))[0], 400);
    assertEquals((await call(ctx, '/api/live/files/read', 'id=live1&path=' + encodeURIComponent('C:\\Windows\\win.ini')))[0], 400);
    assertEquals((await call(ctx, '/api/live/files/read', 'id=live1&path=.git/config'))[0], 400);
    const [s2, read] = await call(ctx, '/api/live/files/read', 'id=live1&path=outputs/chart.html') as [
      number,
      { viewUrl: string; text: string },
    ];
    assertEquals(s2, 200);
    assert(/^http:\/\/127\.0\.0\.1:9\/f\/[0-9a-f]{32}\/chart\.html$/.test(read.viewUrl), read.viewUrl);
    const [, plain] = await call(ctx, '/api/live/files/read', 'id=live1&path=scripts/load.py') as [number, { viewUrl: string }];
    assertEquals(plain.viewUrl, '');
    if (HAVE_GIT) {
      const [s3, found] = await call(ctx, '/api/live/files/search', 'id=live1&q=load') as [number, { matches: { path: string }[] }];
      assertEquals([s3, found.matches.map((m) => m.path)], [200, ['scripts/load.py']]);
    }
    assertEquals((await call(ctx, '/api/live/files/list', 'id=live1&root=elsewhere'))[0], 400);
  } finally {
    r.dispose();
  }
});

Deno.test('view tickets: the artifact origin serves the one ticketed file, read only, with the sandbox CSP', async () => {
  const r = makeRepo();
  try {
    const abs = osp.join(r.repo, 'outputs', 'chart.html');
    const id = issue(abs);
    assertEquals(issue(abs), id, 'one live ticket per file');
    assertEquals(lookup(id), abs);
    assertEquals(lookup(id, Date.now() + TICKET_TTL_MS + 1), null);
    const handler = makeHandler(r.root, 8767, () => 8768);
    const get = (path: string) => handler(new Request('http://127.0.0.1:8768' + path, { headers: { Host: '127.0.0.1:8768' } }));
    const id2 = issue(abs);
    const ok = get('/f/' + id2 + '/chart.html');
    assertEquals(ok.status, 200);
    assert((ok.headers.get('Content-Security-Policy') ?? '').includes('sandbox'));
    assertEquals(await ok.text(), '<h1>c</h1>\n');
    assertEquals(get('/f/' + 'f'.repeat(32) + '/chart.html').status, 404);
    const py = issue(osp.join(r.repo, 'scripts', 'load.py'));
    assertEquals(get('/f/' + py + '/load.py').headers.get('Content-Type'), 'text/plain; charset=utf-8', 'other files never run');
  } finally {
    r.dispose();
  }
});

Deno.test({
  name: 'worktree folders name their parent repo (folders/kinds with parents=1)',
  ignore: !HAVE_GIT,
  fn: () => {
    const r = makeRepo();
    try {
      const wt = osp.join(r.repo, '.claude', 'worktrees', 'feat');
      git(r.repo, 'worktree', 'add', '-q', '-b', 'claude/feat', wt);
      const k = folderKinds([wt], true)[wt];
      assertEquals(k.worktree, true);
      assertEquals(osp.normcase(k.worktreeOf!), osp.normcase(r.repo));
      assertEquals(k.branch, 'claude/feat');
      assertEquals(folderKinds([wt])[wt], { worktree: true, scratch: false }, 'unchanged without parents (Python parity)');
      // the 'main' root of a worktree chat is its main checkout
      assertEquals(osp.normcase(files.mainFolderOf(wt, mainCheckoutOf)), osp.normcase(r.repo));
    } finally {
      r.dispose();
    }
  },
});

void WIN;

// ---- local-only folders: the main folder's private/ in every scope (owner decisions 1a, 3, 4a) -----------------------------------
/** main repo/ with private/ (TASKS.md, designs/x.html, node_modules/) local only, build/ gitignored, and a chat copy chat-1a2b. */
function makeLocalRepo() {
  const r = makeRepo();
  const p = (...parts: string[]) => osp.join(r.repo, ...parts);
  // the chat copy is made from a commit, so it has no private/ (an excluded folder never reaches a copy)
  const exclude = p('.git', 'info', 'exclude');
  Deno.mkdirSync(osp.dirname(exclude), { recursive: true });
  write(exclude, '# user line\n# AIB: local only (shown in every chat; never committed)\n/private\n# AIB: end\n');
  Deno.mkdirSync(p('private', 'designs'), { recursive: true });
  write(p('private', 'TASKS.md'), 'main tasks\n');
  write(p('private', 'designs', 'x.html'), '<p>x</p>\n');
  Deno.mkdirSync(p('private', 'node_modules'));
  const wt = osp.join(r.root, 'chat-1a2b');
  git(r.repo, 'worktree', 'add', '-q', '-b', 'studio/chat-1a2b', wt);
  const state = osp.join(r.root, 'state');
  Deno.mkdirSync(state);
  write(
    osp.join(state, 'studio-worktrees.json'),
    JSON.stringify({ version: 1, worktrees: { k1: { path: wt, project: r.repo, status: 'ready', branch: 'studio/chat-1a2b' } } }),
  );
  const ctx = fakeCtx(wt);
  (ctx as unknown as { stateDir: string }).stateDir = state;
  (ctx as unknown as { host: unknown }).host = {
    liveState: (id: string) => Promise.resolve(id === 'live1' ? { cwd: wt } : id === 'main1' ? { cwd: r.repo } : null),
  };
  return { ...r, p, wt, state, ctx, exclude };
}
type ListReply = {
  entries: { path: string; local?: boolean; from?: string; ignored: boolean; noExclude?: string; strays?: number }[];
  localOnly: { main: string; entries: string[]; defaultState: string };
};
const post = async (ctx: WebContext, path: string, body: unknown, token = 'tok') => {
  const handler = filesRoutes().get('POST ' + path)!;
  const url = new URL('http://127.0.0.1' + path);
  return await handler(ctx, url, body, new Request(url, { method: 'POST', headers: { 'X-Studio-Token': token } }));
};

Deno.test({
  name: 'local only: a chat copy lists, opens and searches the main folder private/ (local, not ignored, any depth)',
  ignore: !HAVE_GIT,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const r = makeLocalRepo();
    try {
      assert(!osp.exists(osp.join(r.wt, 'private')), 'nothing is put in the copy');
      const [s, top] = await call(r.ctx, '/api/live/files/list', 'id=live1&root=chat') as [number, ListReply];
      assertEquals(s, 200);
      const priv = top.entries.find((e) => e.path === 'private')!;
      assertEquals([priv.local, priv.from, priv.ignored, priv.noExclude], [true, 'main', false, 'already']);
      assertEquals(osp.normcase(top.localOnly.main), osp.normcase(r.repo));
      assertEquals([top.localOnly.entries, top.localOnly.defaultState], [['private'], 'on']);
      assertEquals(top.entries.find((e) => e.path === 'README.md')!.noExclude, 'tracked');
      const [, inside] = await call(r.ctx, '/api/live/files/list', 'id=live1&root=chat&dir=private') as [number, ListReply];
      const byPath = Object.fromEntries(inside.entries.map((e) => [e.path, e]));
      assertEquals([byPath['private/designs'].local, byPath['private/designs'].ignored], [true, false], 'a sub-folder opens too');
      assertEquals([byPath['private/TASKS.md'].local, byPath['private/TASKS.md'].from], [true, 'main']);
      assertEquals(byPath['private/node_modules'].ignored, true, 'node_modules inside stays dim');
      const [, deep] = await call(r.ctx, '/api/live/files/list', 'id=live1&root=chat&dir=private/designs') as [number, ListReply];
      assertEquals(deep.entries.map((e) => e.path), ['private/designs/x.html']);
      const [s2, read] = await call(r.ctx, '/api/live/files/read', 'id=live1&root=chat&path=private/TASKS.md') as [
        number,
        { text: string; abs: string; local: boolean },
      ];
      assertEquals([s2, read.text, read.local], [200, 'main tasks\n', true]);
      assertEquals(osp.normcase(read.abs), osp.normcase(r.p('private', 'TASKS.md')), 'Copy path / Open in editor name the real file');
      assertEquals((await call(r.ctx, '/api/live/files/read', 'id=live1&root=chat&path=private/../README.md'))[0], 400);
      assertEquals((await call(r.ctx, '/api/live/files/read', 'id=live1&root=chat&path=private/nope.md'))[0], 404);
      const [, found] = await call(r.ctx, '/api/live/files/search', 'id=live1&root=chat&q=TASKS') as [
        number,
        { matches: { path: string }[]; localOnly: { entries: string[] } },
      ];
      assertEquals(found.matches.map((m) => m.path), ['private/TASKS.md']);
      assertEquals(found.localOnly.entries, ['private']);
      // the main folder's own scope: the same row, local, no `from`
      const [, mainTop] = await call(r.ctx, '/api/live/files/list', 'id=main1&root=chat') as [number, ListReply];
      const mp = mainTop.entries.find((e) => e.path === 'private')!;
      assertEquals([mp.local, mp.from, mp.ignored], [true, undefined, false]);
      assertEquals(mainTop.entries.find((e) => e.path === 'node_modules')!.ignored, true, 'node_modules stays ignored');
      assertEquals(mainTop.entries.find((e) => e.path === 'build')!.ignored, true, 'a .gitignored folder stays ignored');
      assertEquals(mainTop.entries.find((e) => e.path === 'build')!.noExclude, undefined, 'an ignored folder may be made local only');
      const [, mainFound] = await call(r.ctx, '/api/live/files/search', 'id=main1&root=chat&q=x.html') as [number, { matches: { path: string }[] }];
      assertEquals(mainFound.matches.map((m) => m.path), ['private/designs/x.html'], 'excluded files are found in the main folder too');
    } finally {
      git(r.repo, 'worktree', 'remove', '--force', r.wt);
      r.dispose();
    }
  },
});

Deno.test({
  name: 'local only: POST exclude adds and undoes the AIB line, refuses tracked paths, needs the token; a copy-only file moves (Q3)',
  ignore: !HAVE_GIT,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const r = makeLocalRepo();
    try {
      const body = (extra: Record<string, unknown>) => ({ id: 'main1', root: 'chat', action: 'add', ...extra });
      assertEquals((await post(r.ctx, '/api/live/files/exclude', body({ path: 'outputs' }), 'bad'))[0], 403);
      const [s1, add] = await post(r.ctx, '/api/live/files/exclude', body({ path: 'outputs' })) as [
        number,
        { ok: boolean; undo: string; localOnly: { entries: string[] } },
      ];
      assertEquals([s1, add.ok, add.localOnly.entries], [200, true, ['private', 'outputs']]);
      assert(Deno.readTextFileSync(r.exclude).startsWith('# user line\n'), 'the user line is kept');
      const [, list] = await call(r.ctx, '/api/live/files/list', 'id=main1&root=chat') as [number, ListReply];
      assertEquals(list.entries.find((e) => e.path === 'outputs')!.local, true, 'the row turns local');
      const [s2, undo] = await post(r.ctx, '/api/live/files/exclude', body({ action: 'undo', undo: add.undo })) as [
        number,
        { ok: boolean; localOnly: { entries: string[] } },
      ];
      assertEquals([s2, undo.ok, undo.localOnly.entries], [200, true, ['private']]);
      const [s3, refused] = await post(r.ctx, '/api/live/files/exclude', body({ path: 'README.md' })) as [
        number,
        { ok: boolean; code: string; error: string },
      ];
      assertEquals([s3, refused.code, refused.error], [409, 'tracked', "Git tracks this, so it can't be excluded"]);
      assertEquals((await post(r.ctx, '/api/live/files/exclude', body({ path: '../x' })))[0], 400);
      // a file only the chat's copy has: moved into the main folder at once, then excluded
      write(osp.join(r.wt, 'notes.md'), 'from the chat\n');
      const [s4, moved] = await post(r.ctx, '/api/live/files/exclude', body({ id: 'live1', path: 'notes.md' })) as [
        number,
        { ok: boolean; moved: [string, string][] },
      ];
      assertEquals([s4, moved.ok, moved.moved], [200, true, [['notes.md', 'notes.md']]]);
      assertEquals(Deno.readTextFileSync(r.p('notes.md')), 'from the chat\n');
      assert(!osp.exists(osp.join(r.wt, 'notes.md')));
      const [, chatTop] = await call(r.ctx, '/api/live/files/list', 'id=live1&root=chat') as [number, ListReply];
      assertEquals(chatTop.entries.find((e) => e.path === 'notes.md')!.from, 'main');
      assertEquals((await post(r.ctx, '/api/live/files/strays/move', { id: 'live1', root: 'chat' }))[0], 200);
    } finally {
      git(r.repo, 'worktree', 'remove', '--force', r.wt);
      r.dispose();
    }
  },
});
