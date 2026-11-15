/**
 * Track C's WSL pieces that need no keeper (docs/wsl/design.md sections 4-6, 8, 11): refs and names, the Linux side of an agent spawn
 * (test home, test guard, the interop forwarder path), the URL gate (sign-in window, always allow, rate limit, http(s) only), the internal
 * keeper labels, the POSIX cwd check of client terminals, the Files read of helper bytes, and the restricted MCP tools.
 * A FakeWslHost answers helper calls; nothing touches a distro or opens a browser.
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import {
  distroName,
  guardRealWslAgent,
  hostWhenReady,
  notReady,
  setDistroSource,
  setWslHostResolver,
  shellTitle,
  windowsPathInWsl,
  wslHost,
  wslLoc,
  wslTestHomeEnv,
} from '../../outputs/agent-studio/server/wsl/access.ts';
import { cleanUrl, RATE_PER_MINUTE, SIGNIN_WINDOW_MS, urlGate } from '../../outputs/agent-studio/server/wsl/open_urls.ts';
import { heldDistro, isAibInternalLabel } from '../../outputs/agent-studio/server/keeper/link.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { insideLinux } from '../../outputs/agent-studio/server/acp/wsl_caps.ts';
import { fileReadOf, wslFiles, wslStatus } from '../../outputs/agent-studio/server/web/wsl_routes.ts';
import { handle } from '../../outputs/agent-studio/server/artifacts/mcp.ts';
import { DOC_TOOL_NAMES } from '../../outputs/agent-studio/server/docs/tool_defs.ts';
import { DRAWING_TOOL_NAMES } from '../../outputs/agent-studio/server/docs/drawing/tool_defs.ts';
import { branchOf, changesFolder, changesResponse, repoBranch } from '../../outputs/agent-studio/server/worktrees/chat_folders.ts';
import { distroSessions, wslSessionKey } from '../../outputs/agent-studio/server/wsl/transcripts.ts';
import { wslSigninCommand } from '../../outputs/agent-studio/server/web/terminal_routes.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };

function withHost(host: FakeWslHost | null): void {
  setWslHostResolver((d) => (host && d === host.distro.toLowerCase() ? host : null));
}

Deno.test('wsl refs: parsed without URL rules, distro folded, Windows paths are not WSL', () => {
  assertEquals(wslLoc('wsl://Ubuntu/home/u/My App'), { distro: 'ubuntu', linuxPath: '/home/u/My App' });
  assertEquals(wslLoc('wsl://ubuntu/home/u/a/../b'), null, 'a ref with a .. part is not a ref (location.ts validLinuxPath)');
  assertEquals(wslLoc('C:\\work\\app'), null);
  assertEquals(wslLoc('\\\\wsl.localhost\\Ubuntu\\home'), null);
  assertEquals(wslLoc('wsl://bad distro/x'), null);
});

Deno.test('wsl: names, state lines and the terminal title', () => {
  const host = new FakeWslHost('unused', 'Ubuntu');
  withHost(host);
  try {
    assertEquals(distroName('ubuntu'), 'Ubuntu');
    assertEquals(shellTitle('/bin/bash', 'ubuntu'), 'bash (Ubuntu)');
    assertEquals(shellTitle('/usr/bin/zsh', 'ubuntu'), 'zsh (Ubuntu)');
    assertEquals(notReady(host, 'ubuntu'), '');
    host.state = 'starting';
    assertEquals(notReady(host, 'ubuntu'), 'Starting Ubuntu…');
    host.state = 'installing';
    assertEquals(notReady(host, 'ubuntu'), 'Setting up AIB in Ubuntu (first time, ~100 MB)');
    host.state = 'stopped';
    assertEquals(notReady(host, 'ubuntu'), 'Ubuntu stopped. Reconnect');
    host.note = 'Ubuntu stopped (Windows restart or `wsl --shutdown`), so this agent stopped.';
    assertEquals(notReady(host, 'ubuntu'), host.note);
    assertEquals(notReady(null, 'debian'), 'debian is not available to AIB.');
  } finally {
    setWslHostResolver(null);
  }
});

Deno.test('wsl: the interop path of a Windows program, and never a UNC path', () => {
  assertEquals(windowsPathInWsl('C:\\Users\\u\\AppData\\Local\\AgentStudio\\AIB-keeper.exe'), '/mnt/c/Users/u/AppData/Local/AgentStudio/AIB-keeper.exe');
  assertEquals(windowsPathInWsl('D:/x y/z.exe'), '/mnt/d/x y/z.exe');
  assertEquals(windowsPathInWsl('\\\\server\\share\\x.exe'), null);
  assertEquals(windowsPathInWsl('/usr/bin/x'), null);
});

Deno.test('wsl: under test an agent gets a home inside AIB_WSL_ROOT, and only a fixture may start', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(wslTestHomeEnv(env({})), {});
  assertThrows(() => wslTestHomeEnv(env({ AGENT_STUDIO_TEST: '1' })));
  const home = wslTestHomeEnv(env({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-ab12/' }));
  assertEquals(home.HOME, '/tmp/aib-wsl-test-ab12/home');
  assertEquals(home.CLAUDE_CONFIG_DIR, '/tmp/aib-wsl-test-ab12/home/.claude');
  assertEquals(home.CODEX_HOME, '/tmp/aib-wsl-test-ab12/home/.codex');
  const test = env({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-ab12' });
  guardRealWslAgent(['python3', '/tmp/aib-wsl-test-ab12/fake_acp.py'], false, test); // a fixture copied into the root
  guardRealWslAgent(['C:\\py.exe', 'whatever'], true, test); // a Windows fixture the FakeWslHost runs
  assertThrows(() => guardRealWslAgent(['node', '/usr/lib/node_modules/claude-agent-acp/dist/index.js'], false, test));
  guardRealWslAgent(['node', 'x'], false, env({})); // not under test: no guard
});

Deno.test('wsl url gate: asks first, opens within 5 minutes of a sign-in, always-allow is kept per distro, 3 a minute', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-gate-' });
  let now = 1_000_000;
  const opened: string[] = [];
  urlGate.setForTests((url) => opened.push(url), () => now);
  try {
    urlGate.configure(dir);
    assertEquals(cleanUrl('file:///etc/passwd'), '');
    assertEquals(cleanUrl('javascript:alert(1)'), '');
    assertEquals(cleanUrl('https://' + 'a'.repeat(2100)), '');
    assertEquals(urlGate.offer('ubuntu', 'file:///etc/passwd'), 'refused');
    assertEquals(urlGate.offer('ubuntu', 'https://example.com/a'), 'asked');
    assertEquals(opened, []);
    const [waiting] = urlGate.waiting();
    assertEquals([waiting.distro, waiting.url], ['ubuntu', 'https://example.com/a']);
    assert(urlGate.answer(waiting.id, 'open'));
    assertEquals(opened, ['https://example.com/a']);
    now += 61_000;
    urlGate.signInStarted('Ubuntu');
    assertEquals(urlGate.offer('ubuntu', 'https://claude.ai/oauth'), 'opened');
    now += SIGNIN_WINDOW_MS + 1;
    assertEquals(urlGate.offer('ubuntu', 'https://claude.ai/oauth2'), 'asked');
    const id = urlGate.waiting().find((w) => w.url.endsWith('oauth2'))!.id;
    assert(urlGate.answer(id, 'always'));
    assert(urlGate.alwaysAllowed('ubuntu'));
    assert(!urlGate.alwaysAllowed('debian'));
    assertEquals(JSON.parse(Deno.readTextFileSync(dir + '/wsl-open-urls.json')), { alwaysAllow: ['ubuntu'] });
    now += 61_000;
    for (let i = 0; i < RATE_PER_MINUTE; i++) assertEquals(urlGate.offer('ubuntu', `https://e.com/${i}`), 'opened');
    assertEquals(urlGate.offer('ubuntu', 'https://e.com/again'), 'refused'); // the 4th in a minute
    assert(!urlGate.answer('nope', 'open'));
  } finally {
    urlGate.setForTests(null);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('wsl url gate: a host is watched once it is used, and its shim URLs go through the gate', () => {
  const host = new FakeWslHost('unused', 'Ubuntu');
  withHost(host);
  const opened: string[] = [];
  urlGate.setForTests((url) => opened.push(url));
  try {
    assert(wslHost('ubuntu') === host);
    host.openUrl('https://example.com/x');
    assertEquals(opened, []);
    assertEquals(urlGate.waiting().map((w) => w.url), ['https://example.com/x']);
  } finally {
    urlGate.setForTests(null);
    setWslHostResolver(null);
  }
});

Deno.test('keeper labels: the WSL hold and helper channels are AIB-internal, chats and terminals are not', () => {
  assert(isAibInternalLabel(JSON.stringify({ aib: 'wsl-hold', distro: 'ubuntu' })));
  assert(isAibInternalLabel(JSON.stringify({ aib: 'wsl-helper', v: '1.0' })));
  assert(!isAibInternalLabel(JSON.stringify({ t: 'terminal', v: 1, key: 'k' })));
  assert(!isAibInternalLabel(JSON.stringify({ t: 'clientTerminal', chat: 'x' })));
  assert(!isAibInternalLabel('not json'));
  assert(!isAibInternalLabel(undefined));
});

Deno.test('wsl client terminals: the cwd stays inside the Linux folder by POSIX rules (case kept)', () => {
  assertEquals(insideLinux('src', '/home/u/app'), '/home/u/app/src');
  assertEquals(insideLinux('/home/u/app/Src/./x', '/home/u/app'), '/home/u/app/Src/x');
  assertEquals(insideLinux('../other', '/home/u/app'), null);
  assertEquals(insideLinux('/home/u/application', '/home/u/app'), null);
  assertEquals(insideLinux('/etc', '/home/u/app'), null);
});

Deno.test('wsl files read: text from the helper bytes; images and binary files carry no text', () => {
  const b64 = (text: string) => btoa(text);
  const text = fileReadOf('/home/u/app', 'src/a.ts', { bytesB64: b64('one\ntwo\n'), size: 8, truncated: false, mtimeMs: 5000 });
  assertEquals([text.text, text.lines, text.abs, text.binary], ['one\ntwo\n', 2, '/home/u/app/src/a.ts', false]);
  const image = fileReadOf('/home/u/app', 'logo.png', { bytesB64: b64('\x89PNG\x00'), size: 5, truncated: false, mtimeMs: 0 });
  assertEquals([image.image, image.text], [true, null]);
  const binary = fileReadOf('/home/u/app', 'a.bin', { bytesB64: b64('ab\x00cd'), size: 5, truncated: false, mtimeMs: 0 });
  assertEquals([binary.binary, binary.text], [true, null]);
  const big = fileReadOf('/home/u/app', 'big.log', { bytesB64: b64('x'), size: 5 * 1024 * 1024, truncated: true, mtimeMs: 0 });
  assertEquals([big.tooBig, big.text], [true, null]);
});

Deno.test({
  name: 'wsl files routes: list / search / read go to the distro helper with the Linux root; no preview link without an origin; not ready -> 409',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['files.list'] = (p) => ({ dir: p.rel, entries: [{ name: 'Foo', kind: 'file' }, { name: 'foo', kind: 'file' }], sig: 's1' });
    host.handlers['files.search'] = (p) => ({ query: p.query, files: ['src/a.ts'] });
    host.handlers['files.read'] = () => ({ bytesB64: btoa('hello'), size: 5, truncated: false, mtimeMs: 0 });
    withHost(host);
    try {
      const ref = 'wsl://ubuntu/home/u/app';
      const wsl = wslLoc(ref)!;
      const [s1, list] = await wslFiles('list', ref, wsl, { dir: ['src'] });
      assertEquals(s1, 200);
      assertEquals((list as Json).root, ref);
      assertEquals(((list as Json).entries as Json[]).map((e) => e.name), ['Foo', 'foo']); // case-distinct names both kept
      assertEquals(((list as Json).localOnly as Json).defaultState, 'no-git');
      assertEquals(host.calls.at(-1), ['files.list', { root: '/home/u/app', rel: 'src' }]);
      const [, found] = await wslFiles('search', ref, wsl, { q: ['a.ts'] });
      assertEquals((found as Json).files, ['src/a.ts']);
      const [, read] = await wslFiles('read', ref, wsl, { path: ['README.md'] });
      assertEquals([(read as Json).text, (read as Json).viewUrl, (read as Json).abs], ['hello', '', '/home/u/app/README.md']);
      host.state = 'starting';
      const [s4, refused] = await wslFiles('list', ref, wsl, {});
      assertEquals([s4, (refused as Json).code, (refused as Json).error], [409, 'wsl_unavailable', 'Starting Ubuntu…']);
    } finally {
      setWslHostResolver(null);
    }
  },
});

Deno.test({
  name: 'wsl changes: a WSL chat folder is its ref; Changes come from changes.get / changes.diff; branch scope refused; branch via helper',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['changes.get'] = (p) => ({ git: true, root: p.folder, files: [{ path: 'a.sh', status: 'M' }] });
    host.handlers['changes.diff'] = (p) => ({ path: p.path, diff: '+x' });
    host.handlers['chat.repoBranch'] = () => ({ repo: '/home/u/app', branch: 'main' });
    withHost(host);
    try {
      const ref = 'wsl://ubuntu/home/u/app';
      const studio = { liveState: () => ({ cwd: ref }), token: 't', stateDir: null };
      assertEquals(await changesFolder(studio, 'chat1'), ref); // never statted on Windows
      const [s, body] = await changesResponse(studio, '/api/live/changes', { id: ['chat1'] }, { 'X-Studio-Token': 't' });
      assertEquals([s, (body as Json).root], [200, '/home/u/app']);
      const [, diff] = await changesResponse(studio, '/api/live/changes/file', { id: ['chat1'], path: ['a.sh'] }, { 'X-Studio-Token': 't' });
      assertEquals(diff, { path: 'a.sh', diff: '+x' });
      const [s3] = await changesResponse(studio, '/api/live/changes', { id: ['chat1'], scope: ['branch'] }, { 'X-Studio-Token': 't' });
      assertEquals(s3, 400);
      assertEquals(repoBranch(ref), '');
      assertEquals(await branchOf(ref), 'main');
    } finally {
      setWslHostResolver(null);
    }
  },
});

Deno.test({
  name: 'wsl status: WSL2 distros only, state line, home and helper version, waiting URLs',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    withHost(host);
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, state: 1 }, { name: 'Legacy', version: 1, state: 1 }]));
    urlGate.setForTests(() => {});
    try {
      const status = await wslStatus({ stateDir: null });
      assertEquals(status.available, true);
      const [one] = status.distros as Json[];
      assertEquals((status.distros as Json[]).length, 1); // WSL1 is not offered
      assertEquals([one.name, one.key, one.state, one.line, one.home, one.helper], ['Ubuntu', 'ubuntu', 'ready', '', '/home/u', '0.0.0-fake']);
      urlGate.offer('ubuntu', 'https://example.com/');
      const again = await wslStatus({ stateDir: null });
      assertEquals((again.openRequests as Json[]).map((r) => [r.name, r.url]), [['Ubuntu', 'https://example.com/']]);
      setDistroSource(() => Promise.resolve([]));
      assertEquals((await wslStatus({ stateDir: null })).available, false);
    } finally {
      setDistroSource(null);
      setWslHostResolver(null);
      urlGate.setForTests(null);
    }
  },
});

Deno.test('wsl saved sessions: a helper with transcripts.sessions lists them with refs; one without lists none', async () => {
  const host = new FakeWslHost('unused', 'Ubuntu');
  assertEquals(await distroSessions(host, 'ubuntu'), []); // the method is not in the helper (yet)
  (host.handlers as Record<string, (p: Json) => unknown>)['transcripts.sessions'] = (p) =>
    p.provider === 'claude' ? { sessions: [{ key: 'p/abc', sessionId: 'abc', cwd: '/home/u/app', title: 'Fix it' }, { key: 'p/x', cwd: '/srv/other' }] } : { sessions: [] };
  const items = await distroSessions(host, 'ubuntu', new Set(['wsl://ubuntu/home/u/app']));
  assertEquals(items.length, 1);
  assertEquals([items[0].key, items[0].cwd, items[0].provider], [wslSessionKey('ubuntu', 'claude', 'p/abc'), 'wsl://ubuntu/home/u/app', 'claude']);
});

Deno.test('mcp restricted (a WSL chat): the artifact tools (publish by content only) and the doc and drawing tools', async () => {
  const ctx = { key: 'k', conversation: 'c', worktree: false, restricted: true, cwd: null, roots: () => [] };
  const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx) as Json;
  assertEquals(((listed.result as Json).tools as Json[]).map((t) => t.name), ['publish', 'update', 'list', 'archive', ...DOC_TOOL_NAMES, ...DRAWING_TOOL_NAMES]);
  const doc = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'doc_create', arguments: {} } }, ctx) as Json;
  assert(doc.result && !doc.error, 'the doc tool is there (it fails here only because no AIB answers)');
  const byPath = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'publish', arguments: { title: 'x', path: 'outputs/a.html' } } }, ctx) as Json;
  const result = byPath.result as Json;
  assert(result.isError === true && String(((result.content as Json[])[0]).text).includes('publish by `content`'));
  const full = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { ...ctx, restricted: false }) as Json;
  assert(((full.result as Json).tools as Json[]).some((t) => t.name === 'doc_create'), 'a Windows chat keeps every tool');
});

Deno.test('mcp restricted: a WSL chat in its own worktree also gets the merge tools (the merge runs in the distro)', async () => {
  const ctx = { key: 'k', conversation: 'c', worktree: true, restricted: true, main: true, cwd: null, roots: () => [] };
  const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx) as Json;
  assertEquals(((listed.result as Json).tools as Json[]).map((t) => t.name), [
    'publish',
    'update',
    'list',
    'archive',
    'merge_into_project',
    'resolve_edit_clash',
    ...DOC_TOOL_NAMES,
    ...DRAWING_TOOL_NAMES,
  ]);
  const call = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'merge_into_project', arguments: {} } }, ctx) as Json;
  assert(call.result && !call.error, 'the tool is there (it fails here only because no AIB answers)');
  for (const name of ['start_helper']) {
    const refused = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } }, ctx) as Json;
    assertEquals((refused.error as Json).code, -32602, name);
  }
});

Deno.test('mcp restricted: a WSL chat never gets the swarm helper tools, even marked main; a Windows main chat does', async () => {
  const ctx = { key: 'k', conversation: 'c', worktree: false, restricted: true, main: true, cwd: null, roots: () => [] };
  const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx) as Json;
  assertEquals(((listed.result as Json).tools as Json[]).map((t) => t.name), ['publish', 'update', 'list', 'archive', ...DOC_TOOL_NAMES, ...DRAWING_TOOL_NAMES]);
  const call = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_helper', arguments: {} } }, ctx) as Json;
  assertEquals((call.error as Json).code, -32602);
  const main = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { ...ctx, restricted: false, worktree: true }) as Json;
  assert(((main.result as Json).tools as Json[]).some((t) => t.name === 'start_helper'), 'a Windows main chat keeps the swarm tools');
});

Deno.test("wsl sign-in: Claude's login runs in the distro with the sign-in card's advertised args, else the Claude.ai login", async () => {
  const host = new FakeWslHost('unused', 'Ubuntu');
  withHost(host);
  try {
    const adapter = ['/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'];
    assertEquals(await wslSigninCommand('claude', 'ubuntu'), { file: '/usr/bin/node', args: [...adapter, '--cli', 'auth', 'login', '--claudeai'] });
    assertEquals(
      await wslSigninCommand('claude', 'ubuntu', ['--cli', 'auth', 'login', '--console']),
      { file: '/usr/bin/node', args: [...adapter, '--cli', 'auth', 'login', '--console'] },
    );
    // words the page may not send (a shell character) are never run: the default login instead
    assertEquals(
      await wslSigninCommand('claude', 'ubuntu', ['--cli', 'x;rm']),
      { file: '/usr/bin/node', args: [...adapter, '--cli', 'auth', 'login', '--claudeai'] },
    );
    assertEquals(await wslSigninCommand('codex', 'ubuntu', ['--x']), { file: '/usr/bin/codex', args: ['login'] });
    // AIB's own Codex install in the distro: the CLI next to the adapter (agents.detect `signin`), run with its node
    const cli = ['/home/u/.aib-server/agents/codex/2.6.0/node_modules/@openai/codex/bin/codex.js'];
    host.handlers['agents.detect'] = () => ({ agents: [{ id: 'codex', found: true, source: 'studio', signin: ['/usr/bin/node', ...cli] }] });
    assertEquals(await wslSigninCommand('codex', 'ubuntu'), { file: '/usr/bin/node', args: [...cli, 'login'] });
  } finally {
    setWslHostResolver(null);
  }
});

Deno.test('hostWhenReady: a start that failed because the helper was being replaced is tried again; any other failure answers at once', async () => {
  // wsl8 in the owner's log: "ubuntu is not ready, so its chats were not taken over: the running helper was too old to take over".
  // The failed start had already stopped that helper, so a second start (a fresh helper) works.
  const host = new FakeWslHost('unused', 'Ubuntu');
  host.state = 'unavailable';
  let starts = 0;
  let failWith = 'helper_restart';
  host.start = () => {
    starts++;
    if (starts === 1) {
      host.note = 'the running helper was too old to take over';
      return Promise.reject(new WslHelperError(host.note, failWith));
    }
    host.state = 'ready';
    host.note = '';
    return Promise.resolve();
  };
  setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
  try {
    assert((await hostWhenReady('ubuntu', 10_000)) === host);
    assertEquals(starts, 2);
    // a distro that stopped (or is not set up) is not started again and again: the line the user sees, at once
    starts = 0;
    failWith = 'stopped';
    host.state = 'stopped';
    host.note = '';
    const began = Date.now();
    let message = '';
    await hostWhenReady('ubuntu', 10_000).catch((e) => (message = e.message));
    assertEquals([starts, message], [1, 'the running helper was too old to take over']);
    assert(Date.now() - began < 2000);
  } finally {
    setWslHostResolver(null);
  }
});

Deno.test('heldDistro: the distro of a WSL keep-alive label, else empty', () => {
  assertEquals(heldDistro(JSON.stringify({ aib: 'wsl-hold', distro: 'Ubuntu' })), 'ubuntu');
  assertEquals(heldDistro(JSON.stringify({ aib: 'wsl-helper', v: '1' })), '');
  assertEquals(heldDistro(JSON.stringify({ aib: 'wsl-hold', distro: '../x y' })), '');
  assertEquals(heldDistro('not json'), '');
  assertEquals(heldDistro(null), '');
});
