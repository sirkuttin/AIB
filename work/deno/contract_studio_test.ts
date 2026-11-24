/**
 * Contract (ported from work/contract/test_contract_studio.py): the Studio routes beyond the live and transcript ones (settings,
 * conversation marks, editors, folders, prompts, Changes, branch, worktree Merge and clash, update, the worktree tool route) answer
 * the documented status and payload, for good and bad input. The Python version compared every answer with the reference; here the
 * values are asserted. Nothing opens a real dialog or program: folders/pick and open only get requests refused before a picker or a
 * program would start. Temp folders and a temp git repository stand in for projects.
 *
 * The worktree tool route's key checks are also in page_access_test.ts ("the merge tool route: a chat's key reaches the merge for its
 * own chat only"); resume-sync's lock is shared with the host's live sync (worktrees/sync.ts), checked here through the route.
 */
import { assert, assertEquals } from './_assert.ts';
import { ContractServer, generateFixture } from './_contract_server.ts';
import { pauseInfo, setPaused, syncFlagLock } from '../../outputs/agent-studio/server/worktrees/sync.ts';
import * as keys from '../../outputs/agent-studio/server/artifacts/keys.ts';

const WIN = Deno.build.os === 'windows';
const q = encodeURIComponent;
const err = (reply: { status: number; json: { error?: string; code?: string } }) => [reply.status, reply.json.code ?? reply.json.error];

function git(repo: string, ...args: string[]) {
  const out = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    cwd: repo,
    stdout: 'null',
    stderr: 'piped',
  }).outputSync();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

function makeRepo(root: string): string {
  const repo = `${root}/repo`;
  Deno.mkdirSync(`${repo}/sub`, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  Deno.writeTextFileSync(`${repo}/mod.txt`, 'a\nb\nc\nd\n');
  Deno.writeTextFileSync(`${repo}/gone.txt`, '1\n2\n');
  Deno.writeTextFileSync(`${repo}/sub/in.txt`, 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  Deno.writeTextFileSync(`${repo}/mod.txt`, 'a\nB\nc\nd\ne\n');
  Deno.removeSync(`${repo}/gone.txt`);
  Deno.writeTextFileSync(`${repo}/new.txt`, 'fresh\n');
  return repo;
}

Deno.test('contract: Studio routes', async (t) => {
  const fixture = await generateFixture('subagents-fixture');
  Deno.mkdirSync(`${fixture}/empty-omp`, { recursive: true });
  await using s = await ContractServer.start({ claudeDir: `${fixture}/claude`, ompDir: `${fixture}/empty-omp`, env: { AIB_SEAL: 'off' } });
  using _cleanup = { [Symbol.dispose]: () => Deno.removeSync(fixture, { recursive: true }) };
  const repo = makeRepo(s.temp);
  const base = `${s.temp}/base`;
  Deno.mkdirSync(base);
  const native = (p: string) => (WIN ? p.replaceAll('/', '\\') : p);

  await t.step('settings', async () => {
    const got = await s.get('/api/live/settings');
    assertEquals(got.status, 200);
    assertEquals(Object.keys(got.json.settings).sort(), ['agents', 'appearance', 'defaults', 'editors', 'launchers', 'server']);
    assertEquals(got.json.settings.appearance, { defaultView: 'full' });
    assertEquals(got.json.agents.map((a: { id: string }) => a.id).slice(0, 2), ['claude', 'codex']);
    assertEquals((await s.get('/api/live/settings?recheck=0')).status, 200);
    for (
      const [body, message] of [
        [{}, 'Invalid request'],
        [{ editors: { default: 'nope' } }, 'Choose VS Code, Cursor, Windsurf or Devin'],
        [{ appearance: { defaultView: 'transcript' } }, 'Choose Full or Chat as the default chat view'],
        [{ appearance: 5 }, 'Invalid appearance settings'],
        [{ agents: { custom: 'x' } }, 'Unknown agents setting'],
        [{ launchers: { claude: 7 } }, 'The launcher must be the full path of an existing script file'],
      ] as [Record<string, unknown>, string][]
    ) {
      const reply = await s.post('/api/live/settings', body);
      assertEquals([reply.status, reply.json.error], [400, message], JSON.stringify(body));
    }
    const off = await s.post('/api/live/settings', { agents: { builtin: { codex: false } } });
    assertEquals([off.status, off.json.settings.agents.builtin], [200, { claude: true, codex: false }]);
    assertEquals((await s.get('/api/live/settings')).json.settings.agents.builtin.codex, false);
    const on = await s.post('/api/live/settings', { agents: { builtin: { codex: true } } });
    assertEquals(on.json.settings.agents.builtin.codex, true);
  });

  await t.step('conversation marks', async () => {
    const mark = (body: Record<string, unknown>) => s.post('/api/live/conversation-state', body);
    const pin = await mark({ action: 'pin', provider: 'claude', sessionId: 'mark-1', title: 'T', cwd: s.temp });
    assertEquals(pin.status, 200);
    assert(pin.json.entry.pinnedAt > 0);
    const archived = await mark({ action: 'archive', provider: 'claude', sessionId: 'mark-1' });
    assert(archived.json.entry.archivedAt > 0 && archived.json.entry.pinnedAt === 0);
    assertEquals((await mark({ action: 'restore', provider: 'claude', sessionId: 'mark-1' })).status, 200);
    const gone = await mark({ action: 'delete', provider: 'claude', sessionId: 'mark-2', title: 'gone' });
    assert(gone.json.entry.deletedAt > 0);
    assertEquals(gone.json.entry.title, 'gone');
    assertEquals((await mark({ action: 'nope', provider: 'claude', sessionId: 'x' })).json.error, 'Unknown conversation action');
    assertEquals((await mark({ action: 'pin', provider: 5, sessionId: 'x' })).json.error, 'Choose a provider');
    assertEquals((await mark({ action: 'pin', provider: 'claude' })).json.error, 'Choose a saved conversation');
    const all = (await s.get('/api/live/conversation-state')).json;
    assertEquals(Object.keys(all.entries).sort(), ['claude:mark-1', 'claude:mark-2']);
    assert(all.entries['claude:mark-2'].deletedAt > 0);
  });

  await t.step('editors (never started: unknown editor, or a path outside every known project)', async () => {
    const listed = (await s.get('/api/live/editors')).json;
    assert(listed.editors.length > 0 && 'default' in listed);
    const refused = 'That location is not inside a project folder AIB knows, so AIB will not open it';
    assertEquals(err(await s.get('/api/live/editors?project=' + q(s.temp))), [403, 'path_refused']);
    const network = await s.get('/api/live/editors?project=%5C%5Cserver%5Cshare');
    assertEquals([network.status, network.json.error], [403, 'Network and device paths cannot be opened from AIB']);
    const outside = Deno.makeTempDirSync({ prefix: 'aib-contract-outside-' });
    try {
      const open = (body: Record<string, unknown>) => s.post('/api/live/open', body);
      const known = listed.editors[0].id;
      for (const body of [{}, { editor: 5 }, { editor: known, kind: 'bogus', path: outside }]) {
        assertEquals(err(await open(body)), [400, 'invalid'], JSON.stringify(body));
      }
      assertEquals(err(await open({ editor: 'nope', path: outside })), [404, 'not_found']);
      for (const line of [0, 'x']) assertEquals(err(await open({ editor: known, path: outside, line })), [400, 'invalid']);
      assertEquals(err(await open({ editor: known, path: '' })), [400, 'invalid']);
      const outsideReply = await open({ editor: known, path: outside });
      assertEquals([outsideReply.status, outsideReply.json.error], [403, refused]);
      assertEquals((await open({ editor: known, path: 'relative/path' })).json.error, 'The path must be a full path');
      assertEquals((await open({ editor: known, path: '\\\\server\\share' })).json.error, 'Network and device paths cannot be opened from AIB');
    } finally {
      Deno.removeSync(outside, { recursive: true });
    }
  });

  await t.step('folders (temp folders; the picker is never opened)', async () => {
    const start = (await s.get('/api/live/folders/start')).json;
    assertEquals(Object.keys(start).sort(), ['home', 'source', 'start']);
    assertEquals(start.source, 'home');
    const check = async (path: string) => (await s.get('/api/live/folders/check?path=' + q(path))).json;
    const existing = await check(native(base));
    assertEquals([existing.valid, existing.reason, existing.isDir, existing.name], [true, 'existing', true, 'base']);
    const fresh = await check(native(base) + (WIN ? '\\' : '/') + 'new-one');
    assertEquals([fresh.valid, fresh.reason, fresh.exists, fresh.parentExists], [true, 'new', false, true]);
    assertEquals((await check('')).reason, 'empty');
    assertEquals((await check('relative')).reason, 'relative');
    const bad = await check(`${native(base)}${WIN ? '\\' : '/'}a|b`);
    assertEquals([bad.valid, bad.reason], [false, 'invalid_name']);
    if (WIN) {
      assertEquals((await check(native(base) + '\\con')).message, '"con" is a reserved Windows name');
      assertEquals((await check('\\\\server\\share')).message, 'Network paths are not supported here, use a drive letter');
    }
    const create = (body: Record<string, unknown>) => s.post('/api/live/folders/create', body);
    const made = await create({ path: native(`${base}/made`) });
    assertEquals([made.status, made.json.git], [200, false]);
    assert(Deno.statSync(`${base}/made`).isDirectory);
    assertEquals(err(await create({ path: native(`${base}/made`) })), [400, 'exists']);
    const withGit = await create({ path: native(`${base}/with-git`), gitInit: true });
    assertEquals([withGit.status, withGit.json.git], [200, true]);
    assert(Deno.statSync(`${base}/with-git/.git`).isDirectory);
    assertEquals((await create({ path: 5 })).json.error, 'Invalid request');
    assertEquals((await create({ path: native(`${base}/x`), gitInit: 'yes' })).json.error, 'Invalid request');
    assertEquals(err(await create({ path: 'relative' })), [400, 'relative']);
    assertEquals(err(await create({ path: native(`${base}/bad|name`) })), [400, 'invalid_name']);
    const remember = (body: Record<string, unknown>) => s.post('/api/live/folders/remember', body);
    assertEquals((await remember({ path: native(`${base}/made`) })).json.ok, true);
    assertEquals(err(await remember({ path: native(`${base}/missing`) })), [400, 'parent_missing']);
    assertEquals(err(await remember({ path: 5 })), [400, 'empty']);
    assertEquals(err(await remember({})), [400, 'empty']);
    const after = (await s.get('/api/live/folders/start')).json;
    assertEquals([after.source, after.start], ['last', native(base)]);
    const kinds = (await s.get('/api/live/folders/kinds?paths=' + q(JSON.stringify([native(`${base}/made`), 5, null])))).json;
    assertEquals(Object.values(kinds.kinds), [{ worktree: false, scratch: false }]);
    assertEquals((await s.get('/api/live/folders/kinds?paths=not-json')).json, { kinds: {} });
    assertEquals((await s.get('/api/live/folders/kinds')).json, { kinds: {} });
    for (const body of [{ start: 5 }, { start: null }, { start: ['x'] }]) { // refused before any picker starts
      const reply = await s.post('/api/live/folders/pick', body);
      assertEquals([reply.status, reply.json.error], [400, 'Invalid request']);
    }
  });

  await t.step('prompts', async () => {
    const sessions = (await s.get('/api/sessions')).json.sessions;
    assertEquals(sessions.length, 1);
    const key = sessions[0].key;
    const one = { prompts: [{ index: 0, time: '2026-11-24T00:13:36Z', text: 'Fan out the W3 work', files: 0 }], total: 1, matched: 1 };
    const prompts = async (query: string) => (await s.get(`/api/live/prompts?key=${q(key)}${query}`)).json;
    assertEquals((await prompts('')).prompts[0].text, 'Fan out the W3 work');
    for (const query of ['&q=the', '&q=THE', '&thinking=1', '&limit=1', '&limit=0', '&limit=5000']) {
      assertEquals((await prompts(query)).matched, 1, query);
    }
    assertEquals(await prompts('&q=NOTHING'), { prompts: [], total: 1, matched: 0 });
    assertEquals((await prompts('')).total, one.total);
    assertEquals((await s.get(`/api/live/prompts?key=${q(key)}&limit=abc`)).status, 400);
    for (const [query, message] of [['', 'Name the chat to search'], ['key=', 'Name the chat to search'], ['key=nope', 'Unknown transcript source'], ['key=claude%2F..%2F..%2Fx', 'Unknown transcript']]) {
      const reply = await s.get('/api/live/prompts?' + query);
      assertEquals([reply.status, reply.json.error], [400, message], query);
    }
  });

  await t.step('Changes and branch', async () => {
    await s.post('/api/live/conversation-state', { action: 'delete', provider: 'claude', sessionId: 'chg', cwd: repo });
    const changes = await s.get('/api/live/changes?id=claude:chg'); // the chat's folder is known from its mark
    assertEquals(changes.status, 200);
    assertEquals(changes.json.files.map((f: { path: string; status: string; added: number; removed: number }) => [f.path, f.status, f.added, f.removed]), [
      ['gone.txt', 'D', 0, 2],
      ['mod.txt', 'M', 2, 1],
      ['new.txt', 'U', 1, 0],
    ]);
    assertEquals(changes.json.totals, { files: 3, added: 3, removed: 3 });
    assertEquals([changes.json.git, changes.json.scope, changes.json.truncated], [true, 'uncommitted', false]);
    assertEquals(err(await s.get('/api/live/changes?id=claude:chg&scope=branch')), [400, 'bad_scope']);
    assertEquals(err(await s.get('/api/live/changes?id=claude:chg&scope=nope')), [400, 'bad_scope']);
    assertEquals((await s.get('/api/live/changes?id=')).json.error, 'Choose a chat');
    assertEquals(err(await s.get('/api/live/changes?id=claude:unknown')), [404, 'unknown_folder']);
    assertEquals(err(await s.get('/api/live/changes?id=' + 'x'.repeat(700))).at(0), 400);
    const file = async (name: string) => await s.get('/api/live/changes/file?id=claude:chg&path=' + q(name));
    assertEquals((await file('mod.txt')).json.hunks, [{ header: '@@ -1,4 +1,5 @@', lines: [' a', '-b', '+B', ' c', ' d', '+e'] }]);
    assertEquals((await file('new.txt')).json.hunks, [{ header: '@@ -0,0 +1,1 @@', lines: ['+fresh'] }]);
    assertEquals((await file('gone.txt')).json.hunks, [{ header: '@@ -1,2 +0,0 @@', lines: ['-1', '-2'] }]);
    for (const name of ['sub/in.txt', 'missing.txt']) assertEquals(err(await file(name)), [400, 'not_changed'], name);
    for (const name of ['../outside.txt', '']) assertEquals(err(await file(name)), [400, 'bad_path'], name);
    assertEquals((await s.get('/api/live/changes?id=claude:chg', {}, false)).status, 403);
    const branch = async (cwd: string) => (await s.get('/api/live/branch?cwd=' + q(cwd))).json;
    assertEquals(await branch(native(repo)), { branch: 'main' });
    assertEquals(await branch(native(repo) + (WIN ? '\\' : '/') + 'sub'), { branch: 'main' });
    for (const cwd of ['', '\\\\server\\share', s.temp]) assertEquals(await branch(cwd), { branch: '' }, cwd);
  });

  await t.step('worktree routes', async () => {
    await s.post('/api/live/conversation-state', { action: 'delete', provider: 'claude', sessionId: 'wt', cwd: repo });
    assertEquals((await s.get('/api/live/worktree?id=claude:wt')).json, { worktree: false });
    assertEquals((await s.get('/api/live/worktree?id=nope')).json, { worktree: false });
    const noId = (await s.get('/api/live/worktree?id=')).json;
    assertEquals([noId.worktree, noId.enabled, noId.state, noId.message], [true, false, 'unavailable', 'Choose a chat']);
    for (const project of [repo, '', s.temp]) {
      assertEquals((await s.get('/api/live/worktree/clash?project=' + q(project))).json, { unresolved: false }, project);
    }
    for (const body of [{ id: 'nope' }, { id: 'claude:wt', title: 'x' }]) assertEquals(err(await s.post('/api/live/worktree/merge', body)), [404, 'unknown_chat']);
    for (const body of [{}, { id: 5, title: 7 }]) assertEquals(err(await s.post('/api/live/worktree/merge', body)), [400, 'bad_request']);
    for (const body of [{ id: 'nope', action: 'bogus' }, { id: 'nope' }]) {
      const reply = await s.post('/api/live/worktree/clash', body);
      assertEquals([reply.status, reply.json.error], [400, 'The action must be keep_mine, leave or check']);
    }
    for (const action of ['keep-mine', 'leave']) assertEquals(err(await s.post('/api/live/worktree/clash', { id: 'nope', action })), [404, 'unknown_chat']);
    for (const body of [{ action: 'resume-sync', project: repo }, { action: 'resume-sync', project: 5 }, { action: 'resume-sync' }]) {
      assertEquals((await s.post('/api/live/worktree/clash', body)).json, { ok: true, resumed: false });
    }
  });

  await t.step("resume-sync clears the host's pause flag, in the same file, under the same cross-process lock", async () => {
    await setPaused(s.stateDir, repo, 1234);
    const clash = (await s.get('/api/live/worktree/clash?project=' + q(repo))).json;
    assertEquals(clash.syncPaused, true);
    const lock = syncFlagLock(s.stateDir);
    await lock.acquire();
    setTimeout(() => lock.release(), 1000);
    const started = Date.now();
    const reply = await s.post('/api/live/worktree/clash', { action: 'resume-sync', project: repo });
    const waited = Date.now() - started;
    assertEquals([reply.status, reply.json], [200, { ok: true, resumed: true }]);
    assert(waited > 700, `the request did not wait for the lock (${waited} ms)`);
    assertEquals(pauseInfo(s.stateDir, repo), null);
    assertEquals((await s.post('/api/live/worktree/clash', { action: 'resume-sync', project: repo })).json, { ok: true, resumed: false });
  });

  await t.step('update routes', async () => {
    const view = (await s.get('/api/live/update')).json;
    assertEquals([view.desktop, view.configured, view.state], [false, false, 'unconfigured']); // a source run is not the desktop app
    assertEquals((await s.post('/api/live/update/install', { whenIdle: 'yes' })).json.error, 'whenIdle must be true or false');
    assertEquals((await s.post('/api/live/update/install', { cancelWait: true })).status, 200);
    for (const whenIdle of [false, true]) assertEquals(err(await s.post('/api/live/update/install', { whenIdle })), [409, 'not_ready']);
    assertEquals((await s.post('/api/live/update/check', {})).status, 200);
  });

  await t.step('the worktree tool route: a bad key is refused, a chat key works for its own chat only', async () => {
    const keyFor = (conversation: string) => {
      keys.configure(s.stateDir);
      try {
        return keys.issue(conversation) ?? '';
      } finally {
        keys.configure(null);
      }
    };
    const post = (key: string, body: Record<string, unknown>) =>
      s.request('POST', '/api/live/worktree/tool', { 'Host': `127.0.0.1:${s.port}`, 'X-Studio-Artifact-Key': key }, body);
    const refused = { error: 'Invalid artifact key' };
    const unknownChat = { error: 'Open the chat to merge its work', code: 'unknown_chat' };
    const badAction = { error: 'The action must be keep_mine, leave or check', code: 'bad_request' };
    for (
      const [body, expected] of [
        [{ conversationId: 'claude:nope' }, unknownChat],
        [{ conversationId: 'claude:nope', action: 'keep_mine' }, unknownChat],
        [{ conversationId: 'claude:nope', action: 'bogus' }, badAction],
      ] as [Record<string, unknown>, Record<string, unknown>][]
    ) {
      const own = await post(keyFor('claude:nope'), body);
      assertEquals([own.status, own.json], [expected === badAction ? 400 : 404, expected], 'a valid key reaches the merge, which answers');
      assertEquals((await post('not-a-key', body)).json, refused);
      assertEquals((await post(keyFor('claude:nope'), { ...body, conversationId: 'claude:other' })).json, refused, 'the key of another chat');
      assertEquals((await s.post('/api/live/worktree/tool', body)).json, expected, 'the page token reaches the same merge');
    }
    assertEquals((await s.request('POST', '/api/live/worktree/tool', { Host: `127.0.0.1:${s.port}` }, new Uint8Array())).status, 400);
  });
});
