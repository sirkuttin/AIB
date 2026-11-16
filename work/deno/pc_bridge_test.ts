/**
 * Remote control from other PCs, phase 1a: the computer bridge on the phone port (remote/pc_bridge.ts) and the per-action table
 * (remote/pc_routes.ts). The four contract tests of the design (v2 section 7 and the re-review's fix 6):
 *   1. every ROUTE_LIST entry has a remote entry (and the table has nothing else)
 *   2. the (route, deciding field) pairs: a value off the allowlist is refused, one on it gets through
 *   3. every never route is refused for a computer with every switch on; the page-token family is refused on the bridge
 *   4. the sockets and the own-gate / agent-key POSTs, outside the normal dispatch, are covered
 * plus the blocked folders on every route that takes a path, the phone token refused, the rate limit, and the device kind.
 */
import { assert, assertEquals } from './_assert.ts';
import { ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { entryFor, PC_ROUTES, SAFE_MODES } from '../../outputs/agent-studio/server/remote/pc_routes.ts';
import { DEVICE_HEADER, DEVICE_PROTOCOL_PREFIX, RateLimit, REFUSED_HEADERS } from '../../outputs/agent-studio/server/remote/pc_bridge.ts';
import {
  guardNewProject,
  insideProjects,
  isBlocked,
  isHomeOrRoot,
  linuxBlocked,
  normal,
} from '../../outputs/agent-studio/server/remote/path_guard.ts';
import { cleanScopes, COMPUTER_SCOPES, DeviceStore, PHONE_SCOPES } from '../../outputs/agent-studio/server/remote/devices.ts';
import {
  type FakeChat,
  fakeTailscale,
  NAME,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
  tempDir,
} from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const HOME = (WIN ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME')) ?? '';
const sep = WIN ? '\\' : '/';
const inHome = (...parts: string[]) => [HOME, ...parts].join(sep);

async function remoteOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', { on: true });
  assertEquals(status, 200);
  // these tests send many requests at once; the rate limit has its own tests below
  (s.ctx.phone.server!.bridge as unknown as { limit: RateLimit }).limit = new RateLimit(1e6, 1e6);
  return s;
}

function chat(id: string, cwd: string, over: Partial<FakeChat> = {}): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd,
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [],
    permissions: [],
    elicitations: [],
    ...over,
  };
}

/** A bridged API call from a computer (its token in X-AIB-Device). */
function call(s: RemoteStudio, token: string, method: string, path: string, body?: Json, extra: Record<string, string> = {}) {
  return raw(
    s.phonePort(),
    method,
    path,
    { ...phoneHeaders({}, method), [DEVICE_HEADER]: token, ...extra },
    body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
  );
}

/** A WebSocket handshake to the phone port (only refusals are awaited: they answer before any upgrade). */
function socket(s: RemoteStudio, path: string, protocols: string, extra: Record<string, string | null> = {}) {
  const headers = phoneHeaders({
    Origin: `https://${NAME}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Protocol': protocols,
    'Sec-Fetch-Mode': 'websocket',
    ...extra,
  });
  return raw(s.phonePort(), 'GET', path, headers);
}

/** Refused by the bridge's classification (not by the handler after it). */
const BRIDGE_CODES = new Set([
  'pc_only',
  'scope',
  'blocked_folder',
  'outside_projects',
  'not_a_project',
  'page_credential',
  'not_computer',
]);
function refusedBy(r: { status: number; json: Json }, code: string, what: string) {
  assertEquals(r.json.code, code, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  assert(r.status === 403 || r.status === 409 || r.status === 401, `${what}: status ${r.status}`);
}
function passed(r: { status: number; json: Json }, what: string) {
  assert(!BRIDGE_CODES.has(String(r.json.code ?? '')), `${what} was refused by the bridge: ${r.status} ${JSON.stringify(r.json)}`);
}

// ---- 1. every route marked ------------------------------------------------------------------------------------------------------

Deno.test('contract 1: every ROUTE_LIST entry has exactly one remote entry, and the table names no other route', () => {
  const routes = new Set(ROUTE_LIST.map(([m, p]) => `${m} ${p}`));
  assertEquals(routes.size, 173, 'the route table changed: classify the new route in remote/pc_routes.ts');
  for (const key of routes) assert(Object.hasOwn(PC_ROUTES, key), `${key} has no remote entry`);
  for (const key of Object.keys(PC_ROUTES)) assert(routes.has(key), `${key} is not a page route`);
  // the review's never list (MF7 and v2 fix 5), by name
  const mustNever = [
    'POST /api/live/settings',
    'POST /api/live/worktree/merge',
    'POST /api/live/worktree/clash',
    'POST /api/live/cleanup/all',
    'POST /api/live/desktop/notify',
    'POST /api/live/desktop/windows',
    'POST /api/live/docs/export',
    'POST /api/live/docs/reveal',
    'POST /api/live/wsl/open-url',
    'POST /api/live/wsl/agents/install',
    'POST /api/live/wsl/agents/install/cancel',
    'POST /api/live/wsl/agents/uninstall',
    'POST /api/live/wsl/agents/enabled',
    'POST /api/live/agents/install',
    'POST /api/live/agents/install/cancel',
    'POST /api/live/agents/install/uninstall',
    'POST /api/live/agents/signin',
    'POST /api/live/agents/signin/cancel',
    'POST /api/live/agents/signin/check',
    'POST /api/live/authenticate',
    'POST /api/live/folders/pick',
    'POST /api/live/open',
    'POST /api/live/page-session',
    'POST /api/live/update/check',
    'POST /api/live/update/install',
    'POST /api/live/shutdown',
    'POST /api/live/worktree/tool',
    'POST /api/live/swarm/tool',
    'POST /api/live/docs/tool',
    'POST /api/live/artifacts/publish',
    'GET /api/live/bootstrap',
    'GET /api/live/idle',
    'GET /',
    'POST /api/live/files/exclude',
    'POST /api/live/files/strays/move',
  ];
  for (const key of mustNever) assertEquals(PC_ROUTES[key]?.kind, 'never', key);
  for (const key of routes) if (key.includes('/api/live/devices')) assertEquals(PC_ROUTES[key].kind, 'never', key);
  for (const op of ['answer', 'rules', 'remove', 'restore', 'review', 'enable', 'builtin']) {
    const e = PC_ROUTES[`POST /api/live/allow/${op}`];
    assert(e.kind === 'scope' && e.need.includes('pc.always'), `allow/${op} needs pc.always`);
  }
  // the multi-job routes are rules, never a plain scope
  for (const key of ['permission', 'connect', 'mode', 'config', 'session-op', 'conversation-state', 'project-remove', 'project-add']) {
    assertEquals(PC_ROUTES[`POST /api/live/${key}`].kind, 'rule', key);
  }
  assertEquals(entryFor('HEAD', '/api/live/list')?.kind, 'scope');
  // phase 1b: the Artifacts tab's list is the page's own (no agent key ever passes the bridge), under See chats
  const list = PC_ROUTES['GET /api/live/artifacts'];
  assert(list.kind === 'scope' && list.need.join() === 'phone.read', 'GET /api/live/artifacts: See chats');
  assertEquals(entryFor('GET', '/api/remote/home'), null);
});

// ---- the guard and the device kind (units) ---------------------------------------------------------------------------------------

Deno.test('path guard: blocked folders by any spelling, WSL homes, home and drive roots, the project-root rule', () => {
  const state = WIN ? 'C:\\Users\\x\\AppData\\Local\\AgentStudio\\state-test' : '/home/x/.local/state/aib';
  for (
    const p of [inHome('.ssh'), inHome('.ssh', 'id_ed25519'), inHome('.claude', '.credentials.json'), inHome('.codex'), inHome('.gemini')]
  ) {
    assert(isBlocked(p, state), p);
  }
  for (
    const p of [inHome('.aws', 'credentials'), inHome('.azure'), inHome('.config', 'gh', 'hosts.yml'), inHome('.docker'), inHome('.kube')]
  ) {
    assert(isBlocked(p, state), p);
  }
  assert(isBlocked(inHome('.npmrc'), state) && isBlocked(inHome('.git-credentials'), state));
  assert(!isBlocked(inHome('.npmrc-notes'), state) && !isBlocked(inHome('.sshx'), state) && !isBlocked(inHome('code', 'app'), state));
  assert(isBlocked(state + sep + 'devices.json', state), 'the state folder');
  assert(isBlocked(state + sep + 'worktrees', state) && isBlocked(state + sep + 'studio-worktrees.json', state), 'the worktree registry');
  assert(!isBlocked([state, 'worktrees', 'abc', 'chat-1', 'src'].join(sep), state), "a chat's worktree copy is a project folder");
  assert(isBlocked([state, 'worktrees', 'abc', '..', '..', 'devices.json'].join(sep), state), "'..' out of a worktree");
  assert(isBlocked(inHome('code', '..', '.ssh'), state), "'..' is resolved");
  if (WIN) {
    assert(isBlocked(inHome('.SSH').toUpperCase(), state), 'case-folded on Windows');
    assert(isBlocked(inHome('.ssh').replace(/\\/g, '/'), state), "'/' and '\\' alike");
    assert(isBlocked('\\\\server\\share\\x', state), 'UNC refused');
  }
  assert(linuxBlocked('/home/sam/.ssh/id_rsa') && linuxBlocked('/root/.codex') && linuxBlocked('/home/sam/.config/gh'));
  assert(!linuxBlocked('/home/sam/code/.ssh-notes') && !linuxBlocked('/srv/.ssh'));
  assert(isBlocked('wsl://ubuntu/home/sam/.claude/x', state) && !isBlocked('wsl://ubuntu/home/sam/code', state));
  assert(isHomeOrRoot(HOME) && isHomeOrRoot(WIN ? 'C:\\' : '/') && isHomeOrRoot('wsl://ubuntu/home/sam') && !isHomeOrRoot(inHome('code')));
  let threw = '';
  try {
    guardNewProject(HOME, state);
  } catch (e) {
    threw = (e as { code: string }).code;
  }
  assertEquals(threw, 'not_a_project');
  const projects = [inHome('code', 'shop'), 'wsl://ubuntu/home/sam/app'];
  assert(insideProjects(inHome('code', 'shop', 'src'), projects) && !insideProjects(inHome('code', 'shopping'), projects));
  assert(insideProjects('wsl://ubuntu/home/sam/app/x', projects) && !insideProjects('wsl://debian/home/sam/app', projects));
  assertEquals(normal('C:\\A\\b\\..\\c\\', true), 'c:/a/c');
});

Deno.test('device kind: set by the approver, phones never hold pc.* switches, a computer starts with every switch', async () => {
  assertEquals(cleanScopes(['phone.read', 'pc.terminal', 'pc.always'], 'phone'), ['phone.read']);
  assertEquals(cleanScopes([...COMPUTER_SCOPES], 'computer').length, COMPUTER_SCOPES.length);
  const dir = await tempDir('aib-pc-kind-');
  try {
    const store = new DeviceStore(dir);
    const phone = await store.add({ name: 'P', login: 'a', scopes: [...COMPUTER_SCOPES] });
    assertEquals(phone.device.kind, 'phone');
    assertEquals(phone.device.scopes.filter((s) => s.startsWith('pc.')), []);
    const computer = await store.add({ name: 'L', login: 'a', scopes: [...COMPUTER_SCOPES], kind: 'computer' });
    assertEquals(computer.device.kind, 'computer');
    const again = new DeviceStore(dir); // read back from devices.json
    assertEquals(again.byToken(computer.token)?.kind, 'computer');
    assertEquals(again.byToken(phone.token)?.kind, undefined, 'a phone record carries no kind (missing = phone)');
    assertEquals(PHONE_SCOPES.length, 6);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test('rate limit per device: bursts of 20, then 10 per second', () => {
  let now = 0;
  const limit = new RateLimit(20, 10, () => now);
  let ok = 0;
  for (let i = 0; i < 30; i++) if (limit.take('a')) ok++;
  assertEquals(ok, 20);
  assert(limit.take('b'), 'another device has its own bucket');
  now += 500;
  ok = 0;
  for (let i = 0; i < 30; i++) if (limit.take('a')) ok++;
  assertEquals(ok, 5);
});

// ---- 3. never routes, the page-token family, phone tokens (e2e on the phone port) ------------------------------------------------

Deno.test({
  ...OPTS,
  name: 'contract 3: every never route is refused for a computer with every switch on; the page credentials and phone tokens too',
  async fn() {
    const s = await remoteOn();
    try {
      const computer = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const phone = await pairPhone(s, 'Pixel 9');
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      const row = ((view.devices ?? []) as Json[]).find((d) => d.id === computer.id)!;
      assertEquals(row.kind, 'computer');
      assertEquals((row.scopes as string[]).sort(), [...COMPUTER_SCOPES].sort(), 'lead call 2a: every switch on');
      for (const [key, entry] of Object.entries(PC_ROUTES)) {
        if (entry.kind !== 'never') continue;
        const [method, path] = key.split(' ');
        const r = await call(s, computer.token, method, path);
        // GET / is not an API path: the phone port never bridges it; it answers its own loader (phase 1b), never the PC page shell.
        // Every API one is refused by the table
        if (path === '/') assert(r.text.includes('/remote-loader.js') && !r.text.includes('/page-auth.js'), key);
        else refusedBy(r, 'pc_only', key);
        assert(!r.text.includes(s.token), `${key} leaks the page token`);
      }
      // a plain read works for the computer
      const list = await call(s, computer.token, 'GET', '/api/live/list');
      assertEquals(list.status, 200, list.text);
      // the page-token family: each header refused, even with a good device token (the bridge never sets or takes the page token)
      for (const name of REFUSED_HEADERS) {
        const value = name === 'X-Studio-Token' ? s.token : 'x'.repeat(43);
        const r = await call(s, computer.token, 'GET', '/api/live/list', undefined, { [name]: value });
        refusedBy(r, 'page_credential', name);
      }
      const r = await call(s, computer.token, 'POST', '/api/live/read-state', {}, { 'X-AIB-Page-Session': 'abc' });
      refusedBy(r, 'page_credential', 'POST with a page session');
      // a phone token: refused by the bridge
      refusedBy(await call(s, phone.token, 'GET', '/api/live/list'), 'not_computer', 'phone token');
      // no token, a wrong one
      assertEquals((await call(s, 'nope', 'GET', '/api/live/list')).status, 401);
      // the loopback MCP / hook listener's paths are nothing here
      for (const path of ['/mcp', '/hooks/claude', '/hooks/gemini', '/rpc']) {
        assertEquals((await call(s, computer.token, 'POST', path, {})).status, 404, path);
      }
    } finally {
      await s.close();
    }
  },
});

// ---- 2. (route, deciding field) pairs --------------------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name: 'contract 2: the (route, field) pairs of the multi-job routes: off the allowlist refused, on it let through',
  async fn() {
    const s = await remoteOn();
    try {
      s.chats.push(chat('c1', s.project, {
        permissions: [{
          key: 'perm-1',
          params: {
            toolCall: { title: 'Bash', rawInput: { command: 'npm test' } },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
            ],
          },
        }],
      }));
      const all = await pairPhone(s, 'Laptop', undefined, 'computer');
      const some = COMPUTER_SCOPES.filter((x) => x !== 'pc.always' && x !== 'pc.projects' && x !== 'pc.terminal');
      const limited = await pairPhone(s, 'Laptop 2', [...some], 'computer');
      const L = limited.token, A = all.token;
      const outside = await tempDir('aib-pc-new-');
      try {
        type Case = [string, string, string, Json, string | null]; // who, method+path, label, body, refusal code (null: let through)
        const cases: Case[] = [
          // settings: never in v1, whatever the field
          [A, 'POST /api/live/settings', 'appearance only', { theme: 'dark' }, 'pc_only'],
          // permission: the option decides (v2 fix 1)
          [L, 'POST /api/live/permission', 'once', { id: 'c1', key: 'perm-1', option: 'allow' }, null],
          [L, 'POST /api/live/permission', 'always without pc.always', { id: 'c1', key: 'perm-1', option: 'allow_always' }, 'scope'],
          [A, 'POST /api/live/permission', 'always with pc.always', { id: 'c1', key: 'perm-1', option: 'allow_always' }, null],
          [A, 'POST /api/live/permission', 'an extra field', { id: 'c1', key: 'perm-1', option: 'allow', remember: true }, 'pc_only'],
          // mode and config: modes that skip approvals need pc.always (v2 fix 2)
          [L, 'POST /api/live/mode', 'plan', { id: 'c1', modeId: 'plan' }, null],
          [L, 'POST /api/live/mode', 'bypassPermissions', { id: 'c1', modeId: 'bypassPermissions' }, 'scope'],
          [L, 'POST /api/live/mode', 'an unknown mode', { id: 'c1', modeId: 'turbo' }, 'scope'],
          [A, 'POST /api/live/mode', 'bypassPermissions with pc.always', { id: 'c1', modeId: 'bypassPermissions' }, null],
          [L, 'POST /api/live/config', 'a mode config', { id: 'c1', configId: 'mode', value: 'acceptEdits' }, 'scope'],
          [L, 'POST /api/live/config', 'a model config', { id: 'c1', configId: 'model', value: 'opus' }, null],
          [L, 'POST /api/live/config', 'a permission_mode config', { id: 'c1', configId: 'permission_mode', value: 'auto' }, 'scope'],
          // connect: cwd, picks.mode, helperOf, ownCopy (v2 fix 2)
          [
            A,
            'POST /api/live/connect',
            'helperOf',
            { provider: 'claude', cwd: s.project, helperOf: { helperId: 'h', parent: 'p' } },
            'pc_only',
          ],
          [A, 'POST /api/live/connect', 'ownCopy', { provider: 'claude', cwd: s.project, ownCopy: true }, 'pc_only'],
          [L, 'POST /api/live/connect', 'an added project', { provider: 'claude', cwd: s.project }, null],
          [L, 'POST /api/live/connect', 'a new folder without pc.projects', { provider: 'claude', cwd: outside }, 'scope'],
          [L, 'POST /api/live/connect', 'picks.mode yolo', { provider: 'claude', cwd: s.project, picks: { mode: 'yolo' } }, 'scope'],
          [A, 'POST /api/live/connect', 'the home folder as a project', { provider: 'claude', cwd: HOME }, 'not_a_project'],
          [A, 'POST /api/live/connect', 'an unknown field', { provider: 'claude', cwd: s.project, shell: 'cmd' }, 'pc_only'],
          // session-op: the phone's set only
          [A, 'POST /api/live/session-op', 'list', { id: 'c1', op: 'list', cwd: HOME }, 'pc_only'],
          [A, 'POST /api/live/session-op', 'close', { id: 'c1', op: 'close', confirm: 'close:sess-c1' }, null],
          // conversation-state: the marks; restore needs pc.projects (v2 fix 5)
          [L, 'POST /api/live/conversation-state', 'pin', { action: 'pin', provider: 'claude', sessionId: 'sess-x' }, null],
          [
            L,
            'POST /api/live/conversation-state',
            'restore without pc.projects',
            { action: 'restore', provider: 'claude', sessionId: 'x' },
            'scope',
          ],
          [A, 'POST /api/live/conversation-state', 'hold', { action: 'hold', provider: 'claude', sessionId: 'x' }, 'pc_only'],
          // project-remove: never the folder, never AIB's copies in it
          [A, 'POST /api/live/project-remove', 'disk', { path: s.project, disk: true }, 'pc_only'],
          [A, 'POST /api/live/project-remove', 'cleanup', { path: s.project, cleanup: { remove: ['x'] } }, 'pc_only'],
          [L, 'POST /api/live/project-remove', 'without pc.projects', { path: s.project }, 'scope'],
          [A, 'POST /api/live/project-remove', 'check', { path: s.project, check: true }, null],
          // terminal/end: chat keys only (v2 fix 4)
          [A, 'POST /api/live/terminal/end', 'a sign-in terminal', { key: 'signin:claude' }, 'pc_only'],
          [A, 'POST /api/live/terminal/end', 'a setup terminal', { key: 'setup:remote' }, 'pc_only'],
          [A, 'POST /api/live/terminal/end', 'not a chat key', { key: 'claude:nobody' }, 'pc_only'],
          [A, 'POST /api/live/terminal/end', 'a chat key', { key: 'claude:sess-c1' }, null],
          // the other allow rules (v2 fix 1)
          [L, 'POST /api/live/allow/answer', 'without pc.always', { id: 'c1' }, 'scope'],
          [L, 'POST /api/live/allow/rules', 'without pc.always', {}, 'scope'],
          // files writes: never in v1
          [A, 'POST /api/live/files/exclude', 'Git exclude', { id: 'c1', action: 'add', path: 'x' }, 'pc_only'],
          // project-add: pc.projects
          [L, 'POST /api/live/project-add', 'without pc.projects', { path: outside }, 'scope'],
          [A, 'POST /api/live/project-add', 'a new folder', { path: outside }, null],
          // artifacts: purge never; the page's pin with Send
          [A, 'POST /api/live/artifacts/purge', 'purge', { id: 'a1' }, 'pc_only'],
          [A, 'POST /api/live/artifacts/pin', 'pin', { id: 'a1', pinned: true }, null],
        ];
        for (const [who, route, label, body, code] of cases) {
          const [method, path] = route.split(' ');
          const r = await call(s, who, method, path, body);
          if (code) refusedBy(r, code, `${route} (${label})`);
          else passed(r, `${route} (${label})`);
        }
        // terminal/list: only chat keys of added projects
        const tl = await call(s, A, 'GET', '/api/live/terminal/list');
        assertEquals(tl.status, 200, tl.text);
        assertEquals(tl.json.terminals, []);
        refusedBy(await call(s, L, 'GET', '/api/live/terminal/list'), 'scope', 'terminal/list without pc.terminal');
        // what the agent host got: the once answer and the plan mode, never the lasting one from the limited computer
        const perms = s.liveCalls.filter(([n]) => n === 'permission').map(([, b]) => b.option);
        assertEquals(perms, ['allow', 'allow_always']);
      } finally {
        await Deno.remove(outside, { recursive: true }).catch(() => {});
      }
    } finally {
      await s.close();
    }
  },
});

// ---- blocked folders on every route that takes a path ----------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name: 'blocked folders: every route that takes a path refuses ~/.ssh, ~/.claude, ~/.codex and AIB state, even for a full computer',
  async fn() {
    const s = await remoteOn();
    try {
      s.chats.push(chat('t1', s.project));
      const A = (await pairPhone(s, 'Laptop', undefined, 'computer')).token;
      const q = encodeURIComponent;
      // the state folder as an added project (only the PC can do that): Files inside it is still refused
      assertEquals((await pc(s, 'POST', '/api/live/project-add', { path: s.state }))[0], 200);
      const cases: [string, string, Json | undefined][] = [
        ['GET', `/api/live/files/outside?id=t1&path=${q(inHome('.ssh', 'id_ed25519'))}`, undefined],
        ['GET', `/api/live/files/outside?id=t1&path=${q(s.state + sep + 'devices.json')}`, undefined],
        ['GET', `/api/live/files/list?root=project&project=${q(s.state)}`, undefined],
        ['GET', `/api/live/files/read?root=project&project=${q(s.state)}&path=devices.json`, undefined],
        ['GET', `/api/live/files/search?root=project&project=${q(s.state)}&q=x`, undefined],
        ['POST', '/api/live/artifacts/preview', { conversationId: 't1', path: inHome('.ssh', 'id_rsa') }],
        // relative paths resolve against the chat's folder: never checked as sent (security review MF1; pc_sec_test.ts has the rest)
        ['POST', '/api/live/artifacts/preview', { conversationId: 't1', path: 'state/devices.json' }],
        ['POST', '/api/live/artifacts/preview', { conversationId: 't1', path: './state/devices.json' }],
        ['POST', '/api/live/artifacts/preview', { conversationId: 't1', path: 'sub/../state/devices.json' }],
        ['GET', `/api/live/files/outside?id=t1&path=${q('state/devices.json')}`, undefined],
        ['POST', '/api/live/project-remove', { path: inHome('.ssh'), check: true }],
        ['GET', `/api/live/folders/check?path=${q(inHome('.codex'))}`, undefined],
        ['GET', `/api/live/folders/kinds?paths=${q(JSON.stringify([inHome('.claude')]))}`, undefined],
        ['GET', `/api/live/folders/kinds?path=${q(inHome('.aws'))}`, undefined],
        ['GET', `/api/live/folders/gone?paths=${q(JSON.stringify([inHome('.gemini')]))}`, undefined],
        ['POST', '/api/live/folders/create', { path: inHome('.aws'), name: 'x' }],
        ['POST', '/api/live/folders/remember', { path: inHome('.kube') }],
        ['GET', `/api/live/branch?cwd=${q(inHome('.ssh'))}`, undefined],
        ['GET', `/api/live/ownership?provider=claude&id=x&cwd=${q(inHome('.claude'))}`, undefined],
        ['GET', `/api/live/wsl/dirs?distro=ubuntu&path=${q('wsl://ubuntu/home/sam/.ssh')}`, undefined],
        ['POST', '/api/live/connect', { provider: 'claude', cwd: inHome('.codex') }],
        ['POST', '/api/live/project-add', { path: inHome('.ssh') }],
        ['POST', '/api/live/project-add', { paths: [s.project, inHome('.docker')] }],
        ['POST', '/api/live/docs/open', { id: `project:${s.state}`, name: 'x' }],
        ['POST', '/api/live/conversation-state', { action: 'restore', provider: 'claude', sessionId: 'x', cwd: inHome('.claude') }],
        ['POST', '/api/live/agent-options', { agent: 'claude', cwd: inHome('.codex'), probe: true }],
        ['POST', '/api/live/agent-options', { agent: 'claude', cwd: HOME, probe: true }],
        ['POST', '/api/live/discover', { provider: 'claude', cwd: inHome('.claude') }],
        ['POST', '/api/live/worktree-archive', { provider: 'claude', sessionId: 'x', cwd: s.state }],
      ];
      for (const [method, path, body] of cases) {
        const r = await call(s, A, method, path, body);
        assert(
          r.status === 403 && ['blocked_folder', 'outside_projects', 'not_a_project'].includes(String(r.json.code)),
          `${method} ${path}: ${r.status} ${r.text}`,
        );
      }
      // the project-root rule: branch and ownership only for added projects
      const other = await call(s, A, 'GET', `/api/live/branch?cwd=${q(inHome('aib-not-a-project'))}`);
      refusedBy(other, 'outside_projects', 'branch outside the projects');
      passed(await call(s, A, 'GET', `/api/live/branch?cwd=${q(s.project)}`), 'branch of an added project');
      // a project that holds a blocked folder (here: the state folder in the test's root): its row is left out, opening it is refused
      assertEquals((await pc(s, 'POST', '/api/live/project-add', { path: s.root }))[0], 200);
      const listed = await call(s, A, 'GET', `/api/live/files/list?root=project&project=${q(s.root)}`);
      assertEquals(listed.status, 200, listed.text);
      const names = (listed.json.entries as Json[]).map((e) => e.name);
      assert(names.includes('projects') && !names.includes('state'), `rows: ${names.join(', ')}`);
      refusedBy(await call(s, A, 'GET', `/api/live/files/list?root=project&project=${q(s.root)}&dir=state`), 'blocked_folder', 'dir=state');
      const found = await call(s, A, 'GET', `/api/live/files/search?root=project&project=${q(s.root)}&q=devices`);
      assertEquals(found.status, 200, found.text);
      assert(!(found.json.matches as Json[]).some((m) => String(m.path).startsWith('state')), 'no match inside the state folder');
      // a chat's worktree copy (<state>/worktrees/...) counts as its project's folder; the rest of the state folder does not
      const wt = [s.state, 'worktrees', 'abc', 'chat-1'].join(sep);
      await Deno.mkdir(wt, { recursive: true });
      await Deno.writeTextFile(
        s.state + sep + 'studio-worktrees.json',
        JSON.stringify({ version: 1, worktrees: { k1: { path: wt, project: s.project, status: 'ready', branch: 'studio/chat-1' } } }),
      );
      passed(await call(s, A, 'GET', `/api/live/branch?cwd=${q(wt)}`), "a chat's worktree copy");
      refusedBy(await call(s, A, 'GET', `/api/live/branch?cwd=${q(s.state)}`), 'blocked_folder', 'the state folder itself');
      // the terminal's cwd: a chat key of an added project, starting in a blocked folder, is refused
      const term = await socket(
        s,
        `/api/live/terminal?key=${q('claude:sess-t1')}&cwd=${q(inHome('.ssh'))}&cols=80&rows=24`,
        `aib-terminal, ${DEVICE_PROTOCOL_PREFIX}${A}`,
      );
      refusedBy(term, 'blocked_folder', 'terminal cwd ~/.ssh');
    } finally {
      await s.close();
    }
  },
});

// ---- 4. sockets and the routes outside the normal dispatch -----------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name: 'contract 4: the sockets and the own-gate / agent-key POSTs are covered by the bridge',
  async fn() {
    const s = await remoteOn();
    try {
      s.chats.push(chat('t1', s.project));
      const all = await pairPhone(s, 'Laptop', undefined, 'computer');
      const noTerm = await pairPhone(s, 'Laptop 2', COMPUTER_SCOPES.filter((x) => x !== 'pc.terminal'), 'computer');
      const phone = await pairPhone(s, 'Pixel');
      const T = '/api/live/terminal', key = encodeURIComponent('claude:sess-t1');
      const dev = (token: string) => `aib-terminal, ${DEVICE_PROTOCOL_PREFIX}${token}`;
      refusedBy(await socket(s, `${T}?key=${key}`, dev(phone.token)), 'not_computer', 'phone token on the terminal socket');
      refusedBy(await socket(s, `${T}?key=${key}`, dev(noTerm.token)), 'scope', 'no Terminal switch');
      for (
        const query of ['signin=claude', 'setup=remote', 'setup=wsl-node&distro=ubuntu', `key=${key}&shell=cmd`, `key=${key}&distro=x`]
      ) {
        refusedBy(await socket(s, `${T}?${query}`, dev(all.token)), 'pc_only', query);
      }
      for (const k of ['signin:claude', 'setup:claude', 'claude:nobody']) {
        refusedBy(await socket(s, `${T}?key=${encodeURIComponent(k)}&resume=1`, dev(all.token)), 'pc_only', `key ${k}`);
      }
      // the page token as a subprotocol, no Origin, another Origin
      const page = await socket(s, `${T}?key=${key}`, `aib-terminal, aib-token.${s.token}, ${DEVICE_PROTOCOL_PREFIX}${all.token}`);
      refusedBy(page, 'page_credential', 'aib-token subprotocol');
      assertEquals((await socket(s, `${T}?key=${key}`, dev(all.token), { Origin: null })).status, 403);
      assertEquals((await socket(s, `${T}?key=${key}`, dev(all.token), { Origin: 'https://evil.example' })).status, 403);
      // the docs socket: phone token refused, page token refused
      refusedBy(
        await socket(s, '/api/live/docs/socket?doc=x', `aib-docs, ${DEVICE_PROTOCOL_PREFIX}${phone.token}`),
        'not_computer',
        'docs, phone',
      );
      // any other socket path: refused as before
      assertEquals((await socket(s, '/api/remote/home', dev(all.token))).status, 403);
      // no own-gate / agent-key route reaches its handler through the bridge
      for (const path of ['/api/live/worktree/tool', '/api/live/swarm/tool', '/api/live/docs/tool', '/api/live/artifacts/publish']) {
        refusedBy(await call(s, all.token, 'POST', path, { conversationId: 't1' }), 'pc_only', path);
      }
      // phase 1b: the Artifacts tab's list is the page's (See chats); with an agent key it is refused like every agent credential
      passed(await call(s, all.token, 'GET', '/api/live/artifacts?conversationId=t1'), 'GET artifacts (the page list)');
      refusedBy(
        await call(s, all.token, 'GET', '/api/live/artifacts?conversationId=t1', undefined, { 'X-Studio-Artifact-Key': 'k' }),
        'page_credential',
        'GET artifacts (agent key)',
      );
      const keyed = await call(s, all.token, 'POST', '/api/live/artifacts/archive', { ids: ['a'] }, { 'X-Studio-Artifact-Key': 'k' });
      refusedBy(keyed, 'page_credential', 'archive with an agent key');
      passed(await call(s, all.token, 'POST', '/api/live/artifacts/archive', { ids: ['a'] }), 'the page-side archive');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'rate limit on the bridge: a runaway computer gets 429, another device is not held up',
  async fn() {
    const s = await remoteOn();
    try {
      const a = await pairPhone(s, 'Laptop', undefined, 'computer');
      const b = await pairPhone(s, 'Laptop 2', undefined, 'computer');
      const server = s.ctx.phone.server!;
      (server.bridge as unknown as { limit: RateLimit }).limit = new RateLimit(3, 0.001);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await call(s, a.token, 'GET', '/api/live/list')).status);
      assertEquals(codes, [200, 200, 200, 429, 429]);
      assertEquals((await call(s, b.token, 'GET', '/api/live/list')).status, 200);
    } finally {
      await s.close();
    }
  },
});

Deno.test('safe modes are the approval-keeping ones only', () => {
  for (const m of ['bypassPermissions', 'acceptEdits', 'dontAsk', 'yolo', 'full-access', 'auto']) {
    assert(!SAFE_MODES.has(m.toLowerCase()), m);
  }
});
