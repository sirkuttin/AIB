/**
 * The page token goes only to the page (server/web/page_access.ts), and a chat's own key cannot act as the page.
 *
 *   - Bootstrap without the launch key or a page session (any program on the PC, an agent's `curl`) gets every field and an empty
 *     token; with the key, or a page session made with it, the token.
 *   - POST /api/live/page-session trades the key for a session; only its SHA-256 is on disk; another AIB of the same data folder
 *     knows it; a wrong key, a request with no Origin (not a page) and a made-up session get nothing.
 *   - With what an outside caller can get (no token, or a chat's artifact key) the page-only routes are refused: approving a
 *     permission, answering a question, settings, the page's Merge, phone pairing approval, shutdown.
 *   - The merge tool route: a chat's key works for its own chat only (another chat's id is refused before any merge runs).
 *   - GET /api/live/idle (what `aib deploy` waits on) answers without the token, with no names or messages.
 *   - The page in a headless browser: opened with #aib-key it is connected, the key leaves the address bar, and a later visit
 *     without the link (a new tab, an AIB restart) stays connected; a browser that never had the link is told how to connect.
 *   - AIB_PAGE_KEY is taken out of the environment, so nothing AIB starts inherits it (outside a test run).
 */
import { assert, assertEquals } from './_assert.ts';
import { PAGE_KEY } from './_page_key.ts';
import { Browser, browserPath, studio } from './_doc_browser.ts';
import {
  PAGE_KEY_ENV,
  PAGE_KEY_HEADER,
  PAGE_SESSION_HEADER,
  PageAccess,
  SESSIONS_FILE,
  takeLaunchKeyFromEnv,
} from '../../outputs/agent-studio/server/web/page_access.ts';
import { configure as configureKeys, issue as issueKey } from '../../outputs/agent-studio/server/artifacts/keys.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

async function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<[number, Json]> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : {}];
}

/** What the page sends from fetch(): its Origin and same-origin fetch metadata (a browser adds them; a shell command need not). */
const pageLike = (port: number, extra: Record<string, string> = {}) => ({
  Origin: `http://127.0.0.1:${port}`,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  ...extra,
});

Deno.test('PageAccess: the launch key or a known page session, nothing else; only hashes on disk', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'aib-page-access-' });
  try {
    const key = 'k'.repeat(40);
    const a = new PageAccess(dir, key);
    assertEquals(a.launchKey, key);
    assert(a.allows(new Headers({ [PAGE_KEY_HEADER]: key })));
    const none: Record<string, string>[] = [
      {},
      { [PAGE_KEY_HEADER]: 'k'.repeat(39) },
      { [PAGE_SESSION_HEADER]: key },
      { [PAGE_SESSION_HEADER]: '' },
    ];
    for (const h of none) {
      assert(!a.allows(new Headers(h)), JSON.stringify(h));
    }
    assertEquals(a.pair('wrong'), null);
    assertEquals(a.pair(undefined), null);
    const session = a.pair(key)!;
    assert(/^[A-Za-z0-9_-]{43}$/.test(session), session);
    assert(a.allows(new Headers({ [PAGE_SESSION_HEADER]: session })));
    assertEquals(
      a.pair(key, session),
      session,
      'a page that still has a known session keeps it',
    );
    assert(
      a.pair(key, 'x'.repeat(43)) !== 'x'.repeat(43),
      'an unknown one is replaced',
    );
    const disk = Deno.readTextFileSync(`${dir}${sep}${SESSIONS_FILE}`);
    assert(
      !disk.includes(session) && !disk.includes(key),
      'neither the session nor the key is written down',
    );
    assert(/[0-9a-f]{64}/.test(disk), 'a hash is');
    // Another AIB on the same data folder (a restart): a new launch key, the same sessions.
    const b = new PageAccess(dir, null);
    assert(b.launchKey !== key);
    assert(
      !b.allows(new Headers({ [PAGE_KEY_HEADER]: key })),
      "the old process's key is gone with it",
    );
    assert(b.allows(new Headers({ [PAGE_SESSION_HEADER]: session })));
    // A session made by b after a was made is known to a too (the file is read again on a miss).
    const later = b.pair(b.launchKey)!;
    assert(a.knows(later));
    // At most MAX_SESSIONS are kept: the oldest goes.
    for (let i = 0; i < 25; i++) b.pair(b.launchKey);
    assert(!b.knows(session), 'the oldest session was dropped');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('AIB_PAGE_KEY is taken out of the environment outside a test run, so agents and terminals never inherit it', () => {
  const before = {
    test: Deno.env.get('AGENT_STUDIO_TEST'),
    key: Deno.env.get(PAGE_KEY_ENV),
  };
  try {
    Deno.env.delete('AGENT_STUDIO_TEST');
    Deno.env.set(PAGE_KEY_ENV, 'e'.repeat(40));
    assertEquals(takeLaunchKeyFromEnv(), 'e'.repeat(40));
    assertEquals(Deno.env.get(PAGE_KEY_ENV), undefined);
    Deno.env.set(PAGE_KEY_ENV, 'short');
    assertEquals(takeLaunchKeyFromEnv(), null, 'a malformed key is not used');
    assertEquals(Deno.env.get(PAGE_KEY_ENV), undefined, 'and is removed too');
    Deno.env.set('AGENT_STUDIO_TEST', '1');
    Deno.env.set(PAGE_KEY_ENV, 'f'.repeat(40));
    assertEquals(takeLaunchKeyFromEnv(), 'f'.repeat(40));
    assertEquals(
      Deno.env.get(PAGE_KEY_ENV),
      'f'.repeat(40),
      'a test run keeps it for the AIB it starts again',
    );
  } finally {
    for (
      const [name, value] of [['AGENT_STUDIO_TEST', before.test], [
        PAGE_KEY_ENV,
        before.key,
      ]] as const
    ) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test('bootstrap: no token for an outside caller; the token for the launch key or a page session', async () => {
  const s = await studio();
  try {
    const port = s.port;
    // an agent's shell command: loopback Host, no Origin, no fetch metadata
    const [status, outside] = await call(port, 'GET', '/api/live/bootstrap');
    assertEquals(status, 200);
    assertEquals(outside.token, '', 'no token');
    for (
      const field of [
        'instanceId',
        'webInstanceId',
        'pid',
        'server',
        'features',
        'connections',
        'artifactOrigin',
      ]
    ) {
      assert(field in outside, field);
    }
    // the same with the headers a page sends, a wrong key, a made-up session
    const wrong: Record<string, string>[] = [pageLike(port), {
      [PAGE_KEY_HEADER]: 'w'.repeat(43),
    }, { [PAGE_SESSION_HEADER]: 'w'.repeat(43) }];
    for (const h of wrong) {
      assertEquals(
        (await call(port, 'GET', '/api/live/bootstrap', h))[1].token,
        '',
        JSON.stringify(h),
      );
    }
    const [, withKey] = await call(port, 'GET', '/api/live/bootstrap', {
      [PAGE_KEY_HEADER]: PAGE_KEY,
    });
    assertEquals(withKey.token, s.ctx.token);
    // page-session: the key for a session (a page POST names its Origin; a shell command without one is refused by the gate)
    assertEquals(
      (await call(port, 'POST', '/api/live/page-session', {}, {
        key: PAGE_KEY,
      }))[0],
      403,
      'no Origin: not a page',
    );
    const [bad, refused] = await call(
      port,
      'POST',
      '/api/live/page-session',
      pageLike(port),
      { key: 'w'.repeat(43) },
    );
    assertEquals([bad, refused.code], [403, 'bad_page_key']);
    const [ok, paired] = await call(
      port,
      'POST',
      '/api/live/page-session',
      pageLike(port),
      { key: PAGE_KEY },
    );
    assertEquals(ok, 200);
    const session = String(paired.session);
    const [, withSession] = await call(port, 'GET', '/api/live/bootstrap', {
      [PAGE_SESSION_HEADER]: session,
    });
    assertEquals(withSession.token, s.ctx.token);
    const onDisk = Deno.readTextFileSync(`${s.state}${sep}${SESSIONS_FILE}`);
    assert(!onDisk.includes(session), 'the session itself is not on disk');
  } finally {
    await s.done();
  }
});

Deno.test('what an outside caller can get (no token, a chat key) cannot approve, answer, merge, pair a phone or stop AIB', async () => {
  const s = await studio();
  try {
    const port = s.port;
    assert(configureKeys(s.state), 'artifact keys');
    const chat = 'claude:chat-a';
    const key = issueKey(chat)!;
    const [, outside] = await call(port, 'GET', '/api/live/bootstrap');
    const pageOnly: [string, Json][] = [
      ['/api/live/permission', {
        id: chat,
        key: 'req-1',
        option: 'allow_always',
      }],
      ['/api/live/elicitation', {
        id: chat,
        key: 'req-1',
        action: 'accept',
        content: {},
      }],
      ['/api/live/prompt', { id: chat, text: 'hello' }],
      ['/api/live/mode', { id: chat, modeId: 'bypassPermissions' }],
      ['/api/live/settings', { autoUpdateCheck: false }],
      ['/api/live/worktree/merge', { id: chat }],
      ['/api/live/worktree/merge-request', { id: chat }],
      ['/api/live/devices/approve', { id: 'phone' }],
      ['/api/live/devices/access', { on: true }],
      ['/api/live/shutdown', {}],
    ];
    for (const [path, body] of pageOnly) {
      const tries: [string, Record<string, string>][] = [
        [
          'the token bootstrap gave it',
          pageLike(port, { 'X-Studio-Token': String(outside.token) }),
        ],
        ['no token', pageLike(port)],
        ['its chat key', { 'X-Studio-Artifact-Key': key }],
        [
          'its chat key as the token',
          pageLike(port, { 'X-Studio-Token': key }),
        ],
      ];
      for (const [what, headers] of tries) {
        const [status, reply] = await call(
          port,
          'POST',
          `${path}?conversationId=${encodeURIComponent(chat)}`,
          headers,
          body,
        );
        assertEquals(
          status,
          403,
          `${path} with ${what}: ${JSON.stringify(reply)}`,
        );
      }
    }
    assertEquals(s.queued, [], 'nothing reached the agent host');
    // the reads a page makes are refused the same way
    for (
      const path of [
        '/api/live/list',
        '/api/live/settings',
        '/api/live/devices',
      ]
    ) {
      assertEquals(
        (await call(port, 'GET', path, { 'X-Studio-Artifact-Key': key }))[0],
        403,
        path,
      );
      assertEquals(
        (await call(port, 'GET', path, pageLike(port)))[0],
        403,
        path,
      );
    }
  } finally {
    await s.done();
  }
});

Deno.test("the merge tool route: a chat's key reaches the merge for its own chat only", async () => {
  const s = await studio();
  try {
    const port = s.port;
    assert(configureKeys(s.state), 'artifact keys');
    const mine = 'claude:chat-a', other = 'claude:chat-b';
    const key = issueKey(mine)!;
    const post = (conversationId: string, headers: Record<string, string>) =>
      call(port, 'POST', '/api/live/worktree/tool', headers, {
        conversationId,
        action: 'merge',
      });
    // another chat's id with my key: refused at the gate, before any merge code runs
    assertEquals(await post(other, { 'X-Studio-Artifact-Key': key }), [403, {
      error: 'Invalid artifact key',
    }]);
    // no credential, a made-up key, or what bootstrap gives an outside caller: refused
    const refused: Record<string, string>[] = [
      {},
      { 'X-Studio-Artifact-Key': 'f'.repeat(64) },
      pageLike(port, { 'X-Studio-Token': '' }),
    ];
    for (const headers of refused) {
      assertEquals(
        (await post(mine, headers))[0],
        403,
        JSON.stringify(headers),
      );
    }
    // the page (the owner) may: past the gate to the merge
    assertEquals(
      (await post(mine, pageLike(port, { 'X-Studio-Token': s.ctx.token })))[1]
        .code,
      'no_worktree',
    );
    // my own chat: past the gate, to the merge itself (this fake chat works in no worktree, so the merge says so)
    const [status, reply] = await post(mine, { 'X-Studio-Artifact-Key': key });
    assertEquals(
      [status, reply.code],
      [404, 'no_worktree'],
      JSON.stringify(reply),
    );
  } finally {
    await s.done();
  }
});

Deno.test('GET /api/live/idle answers without the token: per chat its agent, folder and state only', async () => {
  const s = await studio();
  try {
    s.connections.push({
      id: 'claude:x',
      provider: 'claude',
      cwd: 'C:\\p',
      busy: true,
      closed: false,
      title: 'secret plan',
      attention: { state: 'working', text: 'secret' },
    });
    const [status, reply] = await call(s.port, 'GET', '/api/live/idle');
    assertEquals(status, 200);
    assertEquals(reply, {
      connections: [{
        provider: 'claude',
        cwd: 'C:\\p',
        closed: false,
        busy: true,
        ready: true,
        attention: { state: 'working' },
      }],
      recovered: [],
      autoReconnect: false,
    });
    assertEquals(
      (await call(s.port, 'GET', '/api/live/idle', {
        Origin: 'http://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      }))[0],
      403,
    );
  } finally {
    await s.done();
  }
});

Deno.test({
  name: 'the page: connected through its link, the key leaves the address bar, later visits stay connected; without it, told how',
  ignore: !browserPath,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const s = await studio();
    const browser = await Browser.launch();
    try {
      const page = await browser.open(s.url('/chat.html')); // Page.goto adds #aib-key=<the run's key>, as the app's window has it
      await page.waitFor(
        `!!localStorage.getItem('aib-page-session')`,
        10000,
        'a page session',
      );
      assertEquals(
        await page.eval<string>('location.hash'),
        '',
        'the key is out of the address bar',
      );
      assertEquals(await page.eval<string>('location.pathname'), '/chat.html');
      const token = await page.eval<string>(
        `fetch('/api/live/bootstrap', window.AIBPageAuth.init()).then((r) => r.json()).then((b) => b.token)`,
      );
      assertEquals(token, s.ctx.token);
      await page.waitFor(
        `document.getElementById('error').hidden !== false`,
        5000,
        'no error',
      );
      // A new tab on the same address without the link (a bookmark; after a restart the launch key is a new one): the session.
      const again = await browser.open('about:blank');
      await again.send('Page.navigate', { url: s.url('/chat.html') }); // no key in this link
      await again.waitFor(
        'document.readyState === "complete" && !!window.AIBPageAuth',
        10000,
        'loaded',
      );
      assertEquals(
        await again.eval<string>(`JSON.stringify(window.AIBPageAuth.headers())`)
          .then((h) => Object.keys(JSON.parse(h))),
        [
          'X-AIB-Page-Session',
        ],
      );
      const token2 = await again.eval<string>(
        `fetch('/api/live/bootstrap', window.AIBPageAuth.init()).then((r) => r.json()).then((b) => b.token)`,
      );
      assertEquals(token2, s.ctx.token);
    } finally {
      await browser.close();
    }
    // A browser that never had the link: the page says how to connect, and gets no token.
    const fresh = await Browser.launch();
    try {
      const page = await fresh.open('about:blank');
      await page.send('Page.navigate', { url: s.url('/chat.html') });
      await page.waitFor(
        `document.getElementById('error') && document.getElementById('error').hidden === false`,
        10000,
        'the notice',
      );
      const text = await page.eval<string>(
        `document.getElementById('error').textContent`,
      );
      assert(/not connected to AIB/.test(text), text);
    } finally {
      await fresh.close();
      await s.done();
    }
  },
});
