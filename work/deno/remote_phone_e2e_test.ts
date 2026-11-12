/**
 * Phone access end to end.
 *
 * With a real AIB (`AIB serve`, temp data folder, split agent host, the fake ACP agent; never the live ports) and a fake Tailscale
 * CLI (_fake_tailscale.ts): phone access on at start, a fake phone paired through the HTTP routes with forged Serve headers, a real
 * chat (an image prompt and a helper) read through home and chat, the image by cookie; no phone-port answer carries the page token,
 * the agent host's token or the artifact key secret; the same phone port and the same pairing after a restart; a busy phone port
 * at start is reported (never another port); Funnel on stops the phone port.
 *
 * With a headless Chrome (no window) on the phone page at 375 px, where this test plays Tailscale Serve (DevTools Fetch
 * interception: the page really is https://<tailnet name>, a secure context): pairing through the page (check words equal the
 * PC's), home, a chat, offline and "no longer paired", with no sideways scroll; and chat.html at 375 px laid out as before.
 */
import { assert, assertEquals } from './_assert.ts';
import { DENO, Fixture, httpJson, type Json, openConversation, SEP, sleep, until, type Web } from './_host_fixture.ts';
import { nativePath } from './_host_fixture.ts';
import { WORK } from './_parity.ts';
import { pickPort } from './_ports.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import {
  type FakeChat,
  fakeTailscale,
  LOGIN,
  NAME,
  nonce,
  pc,
  phoneHeaders,
  type Raw,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
  tailscaleStatus,
} from './_remote_fixture.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { COOKIE_NAME, DEVICE_HEADER } from '../../outputs/agent-studio/server/remote/server.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const FAKE_TAILSCALE = nativePath(new URL('deno/_fake_tailscale.ts', WORK));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A data folder with phone access on, its phone port saved, and the fake Tailscale CLI's answers. */
class PhoneFixture extends Fixture {
  readonly answers = this.root + SEP + 'tailscale.json';
  readonly phonePort = pickPort();
  constructor(options: { funnel?: boolean } = {}) {
    super();
    Deno.writeTextFileSync(this.state + SEP + 'remote-port.json', JSON.stringify({ version: 1, port: this.phonePort }));
    Deno.writeTextFileSync(this.state + SEP + 'phone-access.json', JSON.stringify({ version: 1, on: true, via: 'tailscale' }));
    Deno.writeTextFileSync(
      this.answers,
      JSON.stringify({ status: tailscaleStatus(), serve: serveStatus(this.phonePort, !!options.funnel) }),
    );
  }
  override get env(): Record<string, string> {
    return {
      ...super.env,
      AIB_TAILSCALE_CLI: JSON.stringify([DENO, 'run', '-A', '--quiet', FAKE_TAILSCALE, this.answers]),
      AIB_TEST_REMOTE_BIND_MS: '1500',
    };
  }
  calls(): string[][] {
    return this.read(this.answers + '.calls').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}

const phoneGet = (port: number, path: string, token?: string, extra: Record<string, string> = {}) =>
  raw(port, 'GET', path, phoneHeaders({ ...(token ? { [DEVICE_HEADER]: token } : {}), ...extra }));
const phonePost = (port: number, path: string, body: Json) => raw(port, 'POST', path, phoneHeaders({}, 'POST'), JSON.stringify(body));

async function pairOverHttp(web: Web, port: number, name = 'Pixel 9'): Promise<{ token: string; cookie: string; answers: Raw[] }> {
  const answers: Raw[] = [];
  const [s1, code] = await httpJson('POST', web.port, '/api/live/devices/pair', web.token, {});
  assertEquals(s1, 200, JSON.stringify(code));
  const claim = await phonePost(port, '/api/remote/pair/claim', { code: (code.words as string[]).join(' '), name, nonce: nonce() });
  answers.push(claim);
  assertEquals(claim.status, 200, claim.text);
  const [, view] = await httpJson('GET', web.port, '/api/live/devices', web.token);
  const pending = ((view.pairing as Json).pending as Json[])[0];
  assertEquals(pending.checkWords, claim.json.checkWords);
  const [s2] = await httpJson('POST', web.port, '/api/live/devices/approve', web.token, { claim: pending.id });
  assertEquals(s2, 200);
  const done = await phonePost(port, '/api/remote/pair/status', { claim: claim.json.claim, claimSecret: claim.json.claimSecret });
  answers.push(done);
  const cookie = (done.headers.get('set-cookie') ?? '').match(/__Host-aib-phone=([^;]+)/)?.[1] ?? '';
  return { token: done.json.token as string, cookie, answers };
}

function secretsOf(fx: Fixture, web: Web): string[] {
  const out = [web.token];
  try {
    out.push(String(JSON.parse(fx.read(fx.state + SEP + 'agent-host.json')).token ?? ''));
  } catch { /* in-process: no agent host */ }
  try {
    out.push(String(JSON.parse(fx.read(fx.state + SEP + 'keeper' + SEP + 'keeper.json')).token ?? ''));
  } catch { /* the keeper is off in this fixture */ }
  try {
    const secret = Deno.readFileSync(fx.state + SEP + 'artifact-key-secret');
    out.push([...secret].map((b) => b.toString(16).padStart(2, '0')).join(''), btoa(String.fromCharCode(...secret)));
  } catch { /* not made yet */ }
  return out.filter((s) => s.length >= 16);
}

Deno.test({
  ...OPTS,
  name:
    'end to end: a real AIB with phone access on, a phone paired over HTTP reads home and a chat; same port and pairing after a restart',
  async fn() {
    await using fx = new PhoneFixture();
    let web = await fx.startWeb();
    const port = fx.phonePort;
    const answers: Raw[] = [];
    const boot = await until(
      async () => {
        const r = await phoneGet(port, '/api/remote/bootstrap');
        return r.status === 200 ? r : null;
      },
      'the phone port',
      30,
    );
    answers.push(boot);
    assertEquals([boot.json.paired, boot.json.layout], [false, 'phone']);
    const phone = await pairOverHttp(web, port);
    answers.push(...phone.answers);
    // a real chat: an image prompt, then a turn that starts a helper
    const id = await openConversation(web, fx);
    const [ps] = await web.post('prompt', {
      id,
      text: 'look at this',
      clientMessageId: 'p1',
      attachments: [{ type: 'image', mimeType: 'image/png', data: PNG }],
    });
    assertEquals(ps, 200);
    await until(async () => !(await web.state(id)).busy, 'the image turn', 30);
    const [ds] = await web.post('prompt', { id, text: 'delegate', clientMessageId: 'p2' });
    assertEquals(ds, 200);
    const home = await until(
      async () => {
        const r = await phoneGet(port, '/api/remote/home', phone.token);
        const chat = ((r.json.chats ?? []) as Json[]).find((c) => c.id === id);
        return chat && (chat.helpers as Json[]).length ? r : null;
      },
      'home with the helper',
      30,
    );
    answers.push(home);
    const card = (home.json.chats as Json[]).find((c) => c.id === id)!;
    assertEquals([card.state, home.json.main], ['working', id]);
    assertEquals(card.helpers, [{ id: 'child-1', title: 'Review the fixture', state: 'running' }]);
    const chat = await phoneGet(port, `/api/remote/chat?id=${id}&tail=50`, phone.token);
    answers.push(chat);
    assertEquals(chat.status, 200);
    assert(!chat.text.includes(PNG), 'no inline image bytes');
    const user = (chat.json.events as Json[]).find((e) => e.kind === 'user' && (e.data as Json).text === 'look at this')!;
    const url = ((user.data as Json).attachments as Json[])[0].url as string;
    assert(url.startsWith('/api/remote/image?'), url);
    const img = await phoneGet(port, url, undefined, {
      Cookie: `${COOKIE_NAME}=${phone.cookie}`,
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
    });
    assertEquals([img.status, img.headers.get('content-type')], [200, 'image/png']);
    assert((chat.json.events as Json[]).some((e) => JSON.stringify(e).includes('Fixture images')), 'the agent reply is there');
    // the page port's bootstrap is not on the phone port, even with the device token
    answers.push(await phoneGet(port, '/api/live/bootstrap', phone.token));
    answers.push(await phoneGet(port, '/', phone.token));
    answers.push(await phoneGet(port, '/chat.html', phone.token));
    answers.push(await phoneGet(port, '/phone.html', undefined, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' }));
    const secrets = secretsOf(fx, web);
    assert(secrets.length >= 3, `the page token, the agent host's token and the artifact key secret (${secrets.length})`);
    for (const secret of secrets) {
      for (const a of answers) {
        assert(!a.text.includes(secret), `a phone-port answer carries a secret (${a.status} ${a.text.slice(0, 80)})`);
      }
    }
    assert(fx.calls().every((c) => c[0] === 'status' || (c[0] === 'serve' && c[1] === 'status')), 'AIB only reads Tailscale');
    // restart: the same phone port, and the phone stays paired
    await httpJson('POST', web.port, '/api/live/disconnect', web.token, { id }).catch(() => {});
    await web.kill();
    web = await fx.startWeb();
    assertEquals(readRemotePort(fx.state), port);
    const again = await until(
      async () => {
        const r = await phoneGet(port, '/api/remote/home', phone.token);
        return r.status === 200 ? r : null;
      },
      'the phone port after a restart',
      30,
    );
    assertEquals(again.status, 200);
  },
});

Deno.test({
  ...OPTS,
  name: 'a busy phone port at start: Devices reports it and the saved port is kept, never another one',
  async fn() {
    await using fx = new PhoneFixture();
    const held = Deno.listen({ hostname: '127.0.0.1', port: fx.phonePort }); // port-guard: not bound (an OS-chosen port held by this test)
    try {
      const web = await fx.startWeb();
      const view = await until(
        async () => {
          const [, v] = await httpJson('GET', web.port, '/api/live/devices', web.token);
          return (v.problem as Json | null)?.code === 'port_busy' ? v : null;
        },
        'port busy reported',
        30,
      );
      assertEquals([view.listening, view.port], [false, fx.phonePort]);
      assert(String((view.problem as Json).message).startsWith(`Port ${fx.phonePort} is busy`));
      assertEquals(readRemotePort(fx.state), fx.phonePort);
      held.close();
      const [, after] = await httpJson('POST', web.port, '/api/live/devices/check', web.token, {});
      assertEquals([after.listening, after.port], [true, fx.phonePort]);
    } finally {
      try {
        held.close();
      } catch { /* closed */ }
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'Funnel on at start: the phone port does not listen and Devices says why',
  async fn() {
    await using fx = new PhoneFixture({ funnel: true });
    const web = await fx.startWeb();
    const view = await until(
      async () => {
        const [, v] = await httpJson('GET', web.port, '/api/live/devices', web.token);
        return (v.problem as Json | null)?.code === 'funnel' ? v : null;
      },
      'Funnel reported',
      30,
    );
    assertEquals(view.listening, false);
    const refused = await Deno.connect({ hostname: '127.0.0.1', port: fx.phonePort }).then((c) => (c.close(), false), () => true);
    assert(refused, 'nothing listens on the phone port');
  },
});

// ---- the phone page in a headless browser ------------------------------------------------------------------------------------

/** This test plays Tailscale Serve: every request to https://<NAME>/ is answered from the phone port with Serve's headers. */
async function serveFor(page: Page, s: RemoteStudio, down: { on: boolean }): Promise<void> {
  await page.send('Network.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `https://${NAME}/*`, requestStage: 'Request' }] });
  page.listeners.set('Fetch.requestPaused', (p) => {
    void (async () => {
      const request = p.request as Json;
      const url = new URL(request.url as string);
      const method = request.method as string;
      const kind = p.resourceType as string;
      const sent = request.headers as Record<string, string>;
      const headers: Record<string, string> = { Host: NAME, 'Tailscale-User-Login': LOGIN, 'X-Forwarded-For': '100.64.0.7' };
      for (const [k, v] of Object.entries(sent)) if (/^(content-type|x-aib-device|accept|origin)$/i.test(k)) headers[k] = v;
      if (method === 'POST' && !Object.keys(headers).some((k) => k.toLowerCase() === 'origin')) headers.Origin = `https://${NAME}`;
      if (kind === 'Document') {
        Object.assign(headers, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
      } else if (kind === 'Fetch' || kind === 'XHR') {
        Object.assign(headers, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
      } else Object.assign(headers, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': kind.toLowerCase() });
      const jar = await page.send('Network.getCookies', { urls: [url.href] });
      const cookies = (jar.cookies as Json[]).map((c) => `${c.name}=${c.value}`).join('; ');
      if (cookies) headers.Cookie = cookies;
      let answer: Raw | null = null;
      if (down.on) {
        try {
          answer = await raw(s.phonePort(), method, url.pathname + url.search, headers, request.postData as string | undefined);
        } catch { /* nothing listens: Serve answers 502 */ }
      }
      if (!answer) {
        await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 502, responseHeaders: [], body: '' });
        return;
      }
      const responseHeaders: Json[] = [];
      answer.headers.forEach((value, name) => {
        if (!/^(transfer-encoding|connection|content-length|keep-alive)$/i.test(name)) responseHeaders.push({ name, value });
      });
      let bin = '';
      for (let i = 0; i < answer.bytes.length; i += 0x8000) bin += String.fromCharCode(...answer.bytes.subarray(i, i + 0x8000));
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: answer.status, responseHeaders, body: btoa(bin) });
    })().catch(() => {});
  });
}

const NO_SIDEWAYS =
  `(() => { const d = document.documentElement; return d.scrollWidth <= d.clientWidth + 0 && document.body.scrollWidth <= d.clientWidth; })()`;
const WIDTHS = `(() => { const d = document.documentElement; return [d.scrollWidth, d.clientWidth]; })()`;

function longChat(): FakeChat {
  const events: Json[] = [];
  let seq = 0;
  const ev = (kind: string, data: Json) => events.push({ seq: ++seq, kind, time: seq, data });
  ev('user', {
    text:
      'Please fix C:\\Users\\someone\\code\\a-very-long-project-folder-name\\src\\components\\checkout\\PaymentStepWithAVeryLongName.tsx',
    attachments: [{ name: 'shot.png', mimeType: 'image/png', data: PNG }],
  });
  ev('update', {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text:
          'Sure. Here is the plan:\n\n```\nnpm run test -- --reporter=verbose --filter=checkout/payment-step-with-a-very-long-name\n```\n\n',
      },
    },
  });
  for (let i = 0; i < 6; i++) {
    ev('update', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't' + i,
        title: 'Read src/components/checkout/file' + i + '.tsx',
        status: 'completed',
      },
    });
  }
  ev('update', {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'I started two helpers: one runs the tests, one updates the docs. ' + 'word '.repeat(80) },
    },
  });
  ev('update', { update: { sessionUpdate: 'tool_call', toolCallId: 'run', title: 'RUN npm run lint', status: 'in_progress' } });
  return {
    id: 'main',
    provider: 'claude',
    sessionId: 'sess-main',
    cwd: 'C:\\code\\shop',
    busy: true,
    closed: false,
    attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date(Date.now() - 240_000).toISOString() },
    subagents: {
      a: { title: 'Codex · tests', state: 'running' },
      b: { title: 'Gemini · docs', state: 'running' },
      c: { title: 'Claude · api', state: 'completed' },
    },
    breadth: { sessionInfo: { title: 'Main · checkout redesign' } },
    events,
    permissions: [],
    elicitations: [],
  };
}

Deno.test({
  ...OPTS,
  name: "phone page at 375 px: pair through the page (check words equal the PC's), home, chat, offline, removed; no sideways scroll",
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      s.chats.push(longChat(), {
        id: 'blog',
        provider: 'codex',
        sessionId: 'sess-blog',
        cwd: 'C:\\code\\blog',
        busy: false,
        closed: false,
        attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null },
        subagents: {},
        breadth: { sessionInfo: { title: 'Blog site' } },
        events: [],
        permissions: [],
        elicitations: [{ key: 'q', params: { message: 'Which date format?' } }],
      });
      const page = await browser.open('about:blank', 375, 812);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
      const up = { on: true };
      await serveFor(page, s, up);
      const [, code] = await pc(s, 'POST', '/api/live/devices/pair', {});
      await page.goto(code.url as string);
      await page.waitFor('!!document.getElementById("pairName")', 15000, 'the pairing screen');
      assertEquals(await page.eval('location.hash'), '', 'the secret left the address bar');
      assert(await page.eval(NO_SIDEWAYS), `pairing: sideways scroll ${await page.eval(WIDTHS)}`);
      const size = await page.eval<number[]>(
        `(() => { const b = document.getElementById('pairGo').getBoundingClientRect(); const i = document.getElementById('pairName'); return [b.height, parseFloat(getComputedStyle(i).fontSize)]; })()`,
      );
      assert(size[0] >= 44 && size[1] >= 16, `tap target ${size[0]} px, input text ${size[1]} px`);
      await page.click('#pairGo');
      const words = await page.waitFor('document.getElementById("checkWords")?.textContent', 15000, 'the check words') as string;
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      const pending = ((view.pairing as Json).pending as Json[])[0];
      assertEquals(words, (pending.checkWords as string[]).join(' '), 'the phone and the PC show the same two words');
      await pc(s, 'POST', '/api/live/devices/approve', { claim: pending.id });
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home');
      const cookies = (await page.send('Network.getCookies', { urls: [`https://${NAME}/`] })).cookies as Json[];
      const cookie = cookies.find((c) => c.name === COOKIE_NAME)!;
      assertEquals([cookie.httpOnly, cookie.secure, cookie.sameSite], [true, true, 'Strict']);
      assert(await page.eval('!document.cookie.includes("aib-phone")'), 'the page script cannot read the cookie');
      const sections = await page.eval<string[]>('[...document.querySelectorAll(".ph-section")].map((h) => h.textContent)');
      assertEquals(sections, ['Needs you · 1', 'Main chat']);
      const helpers = await page.eval<string[]>(
        '[...document.querySelectorAll(".ph-card.main .ph-helpers li")].map((li) => li.textContent)',
      );
      assertEquals(helpers, ['Codex · testsworking', 'Gemini · docsworking', 'Claude · apidone']);
      assert(await page.eval(NO_SIDEWAYS), `home: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.click('.ph-card.main');
      await page.waitFor('document.querySelectorAll(".ph-msg").length >= 3', 15000, 'the chat');
      assert(await page.eval(NO_SIDEWAYS), `chat: sideways scroll ${await page.eval(WIDTHS)}`);
      assertEquals(await page.eval('document.querySelector(".ph-fold").textContent'), 'Show steps (6)');
      assert(String(await page.eval('document.querySelector(".ph-live").textContent')).startsWith('Step 7 · RUN npm run lint · 4 min'));
      await page.waitFor(
        '(() => { const i = document.querySelector(".ph-img"); return i && i.complete && i.naturalWidth > 0; })()',
        15000,
        'the picture, by cookie',
      );
      await page.click('.ph-fold');
      assert(await page.eval(NO_SIDEWAYS), `chat with steps open: sideways scroll ${await page.eval(WIDTHS)}`);
      // offline: the phone port stops (AIB closed, PC asleep): Serve answers 502
      up.on = false;
      await page.waitFor('document.body.textContent.includes("Can\'t reach STUDIO-PC")', 15000, 'the offline screen');
      assert(await page.eval('document.body.textContent.includes("Tailscale is on, on this phone.")'));
      assert(await page.eval('document.querySelectorAll(".ph-msg").length >= 3'), 'the last view stays readable');
      assert(await page.eval(NO_SIDEWAYS), `offline: sideways scroll ${await page.eval(WIDTHS)}`);
      up.on = true;
      await page.click('.ph-offline .ph-btn');
      await page.waitFor('!document.querySelector(".ph-offline")', 15000, 'back online');
      await page.click('.ph-back');
      await page.waitFor('document.getElementById("app").dataset.screen === "home"', 15000, 'home again');
      // removed on the PC: the phone says so at its next poll
      const [, v2] = await pc(s, 'GET', '/api/live/devices');
      await pc(s, 'POST', '/api/live/devices/remove', { id: (v2.devices as Json[])[0].id });
      await page.waitFor('document.getElementById("app").dataset.screen === "removed"', 15000, 'the removed screen');
      assert(await page.eval('document.body.textContent.includes("no longer paired")'));
      assert(await page.eval(NO_SIDEWAYS), `removed: sideways scroll ${await page.eval(WIDTHS)}`);
      assertEquals(page.errors, [], 'console errors');
      assertEquals(page.csp, [], 'CSP violations');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

/**
 * chat.html at 375 px is laid out as before phone access (no phone layout by width, no phone files). These numbers were measured
 * at the base of this change (integration/beta8 c3f1b05); change them only when chat.html's narrow layout is meant to change.
 */
const CHAT_HTML_375 = { scrollWidth: 490, columns: '170px 320px' };

Deno.test({
  ...OPTS,
  name: 'chat.html at 375 px is unchanged: same layout, and no phone page file is loaded',
  ignore: !browserPath,
  async fn() {
    const s = await remoteStudio();
    const browser = await Browser.launch();
    try {
      const page = await browser.open('about:blank', 375, 812);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
      await sleep(1000);
      const got = await page.eval<{ scrollWidth: number; columns: string; files: string[] }>(`(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        columns: getComputedStyle(document.body).gridTemplateColumns,
        files: performance.getEntriesByType('resource').map((r) => new URL(r.name).pathname),
      }))()`);
      assertEquals(got.files.filter((f) => /phone/.test(f)), [], 'no phone page file');
      if (Deno.env.get('AIB_PRINT_LAYOUT')) console.log(JSON.stringify(got));
      assertEquals({ scrollWidth: got.scrollWidth, columns: got.columns }, CHAT_HTML_375);
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
