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
 *
 * Phase B: from the phone (forged Serve headers, a real AIB and the fake agent) a form question is answered and a request approved
 * once, and the agent goes on; plain text sends, "/" is refused, a queued message is removed, Stop ends a turn, a closed chat is
 * refused; each action is one line in the phone activity log. In the headless page at 375 px: a "Needs you" card opens the
 * question sheet, the approval sheet shows Deny / Allow once with the long command wrapped, the composer (16 px, Stop) keeps the
 * text through polls, queued messages have Edit / Remove / Send now, and the switches turned off on the PC hide those controls.
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
  pairPhone,
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
  name:
    'end to end: from the phone, answer a form question and approve once; the agent continues; plain text sends, "/" refused, queue, Stop',
  async fn() {
    await using fx = new PhoneFixture();
    const web = await fx.startWeb();
    const port = fx.phonePort;
    await until(async () => (await phoneGet(port, '/api/remote/bootstrap')).status === 200, 'the phone port', 30);
    const phone = await pairOverHttp(web, port);
    const id = await openConversation(web, fx);
    const act = (op: string, body: Json) =>
      raw(port, 'POST', `/api/remote/${op}`, phoneHeaders({ [DEVICE_HEADER]: phone.token }, 'POST'), JSON.stringify(body));
    const chat = () => phoneGet(port, `/api/remote/chat?id=${id}&tail=100`, phone.token);
    const waiting = async (kind: string) =>
      await until(async () => ((await chat()).json.waiting as Json[] ?? []).find((w) => w.kind === kind) ?? null, kind, 30);
    const said = async (text: string) =>
      await until(
        async () => {
          const c = await chat();
          return !c.json.busy && JSON.stringify(c.json.events).includes(text) ? c : null;
        },
        text,
        30,
      );

    // the phone sends plain text: a form question comes back
    const sent = await act('prompt', { id, text: 'form', clientMessageId: 'phone-1' });
    assertEquals(sent.status, 200, sent.text);
    const q = await waiting('question');
    assertEquals(q.pcOnly, false);
    const answered = await act('elicitation', { id, key: q.key, action: 'accept', content: { name: 'Ada', plan: 'pro' } });
    assertEquals(answered.status, 200, answered.text);
    await said('Fixture form response');
    assert(JSON.stringify((await chat()).json.events).includes('\\"plan\\": \\"pro\\"'), 'the agent got the answer');

    // a permission: Allow once from the phone, the agent continues
    assertEquals((await act('prompt', { id, text: 'approve', clientMessageId: 'phone-2' })).status, 200);
    const p = await waiting('permission');
    assertEquals((p.options as Json[]).map((o) => o.kind), ['allow_once', 'reject_once']);
    assertEquals((await act('permission', { id, key: p.key, option: 'not-an-option' })).status, 403);
    const ok = await act('permission', { id, key: p.key, option: (p.options as Json[])[0].optionId });
    assertEquals(ok.status, 200, ok.text);
    await said('Fixture response');

    // refused: an agent or AIB command (a link question is refused in remote_actions_test.ts: this agent runs --rich)
    assertEquals((await act('prompt', { id, text: '/compact', clientMessageId: 'phone-3' })).json.code, 'text_only');

    // Stop: a turn that waits until stopped
    assertEquals((await act('prompt', { id, text: 'wait', clientMessageId: 'phone-5' })).status, 200);
    await until(async () => (await chat()).json.busy, 'working', 30);
    const queued = await act('queue', { id, text: 'after the stop', clientMessageId: 'phone-6' });
    assertEquals(queued.status, 200, queued.text);
    const item = await until(async () => (((await chat()).json.queue as Json).items as Json[])[0], 'queued', 30);
    assertEquals(item.text, 'after the stop');
    assertEquals((await act('queue-remove', { id, messageId: item.id })).status, 200);
    assertEquals((await act('cancel', { id })).status, 200);
    await until(async () => !(await chat()).json.busy, 'stopped', 30);

    // not running any more: "Open it in AIB on your PC"
    await web.post('disconnect', { id });
    const closed = await act('prompt', { id, text: 'hi', clientMessageId: 'phone-7' });
    assertEquals([closed.status, closed.json.code], [409, 'not_live']);

    const log = fx.read(fx.state + SEP + 'remote-audit.jsonl');
    for (const secret of ['Ada', 'after the stop', '/compact', 'Fixture approval', 'Fixture form']) {
      assert(!log.includes(secret), `the log holds ${secret}`);
    }
    const lines = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.chat === id);
    assertEquals(lines.map((l) => [l.action, l.result]), [
      ['send', 'done'],
      ['answer', 'done'],
      ['send', 'done'],
      ['approve', 'refused: pc_only'],
      ['approve', 'done'],
      ['send', 'refused: text_only'],
      ['send', 'done'],
      ['queue', 'done'],
      ['queue: remove', 'done'],
      ['stop', 'done'],
      ['send', 'refused: not_live'],
    ]);
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
      // Phase C: Finish setup comes first (notifications); not an iPhone, so no Home Screen step
      await page.waitFor('document.getElementById("app").dataset.screen === "setup"', 15000, 'finish setup');
      assertEquals(await page.eval('[...document.querySelectorAll(".ph-step")].map((x) => x.dataset.step)'), ['notify']);
      assert(await page.eval(NO_SIDEWAYS), `finish setup: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.click('#setupDone');
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
      // offline: the phone port stops (AIB closed): Serve answers 502. "Reconnecting…" first (the keeper restarts a crashed AIB in
      // 5 s; 20 s in the app, shortened here), then AIB is closed on the PC, never that the chats still run (owner decision 7).
      await page.eval('window.__aibPhone.reconnectMs = 2500');
      up.on = false;
      await page.waitFor('document.querySelector(".ph-offline")?.dataset.offline === "reconnecting"', 15000, 'reconnecting');
      assert(await page.eval('document.body.textContent.includes("Reconnecting…")'));
      await page.waitFor('document.querySelector(".ph-offline")?.dataset.offline === "closed"', 15000, 'the closed screen');
      assert(await page.eval('document.body.textContent.includes("AIB is closed on STUDIO-PC")'));
      assert(await page.eval('!/still running|keep running/i.test(document.body.textContent)'), 'never says the chats still run');
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

/** Put a paired phone's token where phone.js keeps it (IndexedDB on the phone origin), then load the page again. */
async function signInPage(page: Page, token: string, id: string): Promise<void> {
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor('!!document.getElementById("app").dataset.screen', 15000, 'the phone page');
  await page.eval(`new Promise((resolve, reject) => {
    const req = indexedDB.open('aib-phone', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ token: ${JSON.stringify(token)}, device: { id: ${JSON.stringify(id)} } }, 'device');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  })`);
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, 'home');
}

Deno.test({
  ...OPTS,
  name:
    'phone page at 375 px: "Needs you" opens the question sheet; approval sheet Deny / Allow once; composer, Stop, queue; switches off hide them',
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      const main = longChat();
      const long = 'npm run e2e -- --update-snapshots --reporter=verbose ' +
        'C:\\Users\\someone\\code\\a-very-long-project-folder-name\\src\\components\\checkout\\PaymentStepWithAVeryLongName.test.tsx ' +
        'x'.repeat(120);
      main.attention = { ...main.attention, state: 'needs_you', needs: 1 };
      main.permissions = [{
        key: 'perm1',
        params: {
          toolCall: { title: 'Run the end-to-end tests', rawInput: { command: long } },
          options: [
            { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        },
      }];
      main.queue = { items: [{ id: 'q1', text: 'then update the docs', attachments: [], sending: false, editing: false }], paused: false };
      const blog: FakeChat = {
        id: 'blog',
        provider: 'codex',
        sessionId: 'sess-blog',
        cwd: 'C:\\code\\blog',
        busy: false,
        closed: false,
        attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null },
        subagents: {},
        breadth: { sessionInfo: { title: 'Blog site' } },
        events: [{ seq: 1, kind: 'user', data: { text: 'Convert the posts' } }],
        permissions: [],
        elicitations: [{
          key: 'q1',
          params: {
            mode: 'form',
            message: 'Which date format for posts?',
            requestedSchema: {
              type: 'object',
              properties: {
                format: {
                  type: 'string',
                  title: 'Date format',
                  oneOf: [{ const: 'long', title: '12 November 2026' }, { const: 'iso', title: '2026-11-12' }],
                },
                note: { type: 'string', title: 'Anything else' },
              },
              required: ['format'],
            },
          },
        }],
      };
      s.chats.push(main, blog);
      // the fake agent host: an answered request goes away, a queued message joins the queue
      s.answerLive((name, body) => {
        const c = s.chats.find((x) => x.id === body.id)!;
        if (name === 'elicitation') c.elicitations = [];
        if (name === 'permission') c.permissions = [];
        if (name === 'elicitation' || name === 'permission') c.attention = { ...c.attention, state: 'idle', needs: 0 };
        if (name === 'queue-remove') (c.queue as Json).items = ((c.queue as Json).items as Json[]).filter((i) => i.id !== body.messageId);
        if (name === 'queue') {
          ((c.queue as Json).items as Json[]).push({ id: 'q2', text: body.text, attachments: [], sending: false, editing: false });
        }
        return [200, { ok: true }];
      });
      const phone = await pairPhone(s);
      const page = await browser.open('about:blank', 375, 812);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
      const up = { on: true };
      await serveFor(page, s, up);
      await signInPage(page, phone.token, phone.id);
      assert(await page.eval(NO_SIDEWAYS), `home: sideways scroll ${await page.eval(WIDTHS)}`);

      // "Needs you" -> the chat with the question sheet already up
      await page.click('.ph-card[data-chat="blog"]');
      await page.waitFor('document.getElementById("app").dataset.sheet === "question"', 15000, 'the question sheet');
      assert(await page.eval(NO_SIDEWAYS), `question sheet: sideways scroll ${await page.eval(WIDTHS)}`);
      const opts = await page.eval<number[]>(
        '[...document.querySelectorAll("#phSheet .ph-opt")].map((b) => b.getBoundingClientRect().height)',
      );
      assert(opts.length === 2 && opts.every((h) => h >= 44), `choices are big targets: ${opts}`);
      await page.shot('phone-question-sheet');
      await page.click('#phAnswer'); // nothing picked: it says what is missing, nothing is sent
      await page.waitFor('document.querySelector("#phSheet .ph-error")?.textContent === "Fill in: Date format."', 5000, 'missing');
      const before = s.liveCalls.length;
      await page.click('#phSheet [data-field="format"] button:last-of-type');
      await page.click('#phField-note');
      await page.type('Use the long one on the home page');
      assertEquals(await page.eval('getComputedStyle(document.getElementById("phField-note")).fontSize'), '16px');
      assertEquals(s.liveCalls.length, before);
      await page.click('#phAnswer');
      await page.waitFor('document.getElementById("app").dataset.sheet === ""', 15000, 'the sheet closes');
      assertEquals(s.liveCalls.at(-1), ['elicitation', {
        id: 'blog',
        key: 'q1',
        action: 'accept',
        content: { format: 'iso', note: 'Use the long one on the home page' },
      }]);

      // the main chat: an approval waits; its sheet has two big buttons and the long command wraps
      await page.click('.ph-back');
      await page.waitFor('document.getElementById("app").dataset.screen === "home"', 15000, 'home');
      await page.click('.ph-card[data-chat="main"]');
      await page.waitFor('document.getElementById("app").dataset.sheet === "permission"', 15000, 'the approval sheet');
      const sheet = await page.eval<Json>(`(() => {
        const s = document.getElementById('phSheet').getBoundingClientRect();
        const cmd = document.querySelector('#phSheet .ph-cmd');
        const buttons = [...document.querySelectorAll('#phSheet .ph-answer .ph-btn')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]);
        return { top: s.top, bottom: Math.round(s.bottom), height: innerHeight, cmdWraps: cmd.scrollWidth <= cmd.clientWidth, buttons,
          notes: [...document.querySelectorAll('#phSheet .ph-note')].map((n) => n.textContent) };
      })()`);
      assertEquals(sheet.buttons, [['Deny', 48], ['Allow once', 48]]);
      assert(sheet.cmdWraps, 'the command wraps');
      assert(
        (sheet.top as number) >= 0 && (sheet.bottom as number) <= (sheet.height as number),
        `the sheet fits: ${JSON.stringify(sheet)}`,
      );
      assert((sheet.notes as string[]).includes('Other choices are on your PC.'));
      assert(await page.eval(NO_SIDEWAYS), `approval sheet: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.shot('phone-approval-sheet');
      await page.click('#phSheet [data-option="yes"]');
      await page.waitFor('document.getElementById("app").dataset.sheet === ""', 15000, 'the sheet closes');
      assertEquals(s.liveCalls.at(-1), ['permission', { id: 'main', key: 'perm1', option: 'yes' }]);

      // the composer at the bottom: 16 px text, Stop while working; typing survives the 3 s polls
      const bar = await page.eval<Json>(`(() => {
        const f = document.getElementById('phComposer').getBoundingClientRect();
        return { bottom: Math.round(f.bottom), height: innerHeight, font: getComputedStyle(document.getElementById('phPrompt')).fontSize,
          stop: !document.getElementById('phStop').hidden };
      })()`);
      assertEquals([bar.bottom, bar.font, bar.stop], [bar.height, '16px', true]);
      await page.click('#phPrompt');
      await page.type('Also check the mobile layout');
      await sleep(3500);
      assertEquals(
        await page.eval('[document.activeElement.id, document.getElementById("phPrompt").value]'),
        ['phPrompt', 'Also check the mobile layout'],
        'the text and the caret stay through a poll',
      );
      assert(await page.eval(NO_SIDEWAYS), `chat with composer: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.click('#phSend');
      await page.waitFor('document.getElementById("phPrompt").value === ""', 15000, 'sent');
      assertEquals(s.liveCalls.at(-1)?.[0], 'queue', 'a working chat queues the message');
      assertEquals((s.liveCalls.at(-1)?.[1] as Json).text, 'Also check the mobile layout');
      await page.waitFor('document.querySelectorAll(".ph-queued").length === 2', 15000, 'the queued message shows');
      await page.shot('phone-chat-composer-queue');
      assertEquals(
        await page.eval('[...document.querySelectorAll(".ph-queued[data-queued=q1] .ph-btn")].map((b) => b.textContent)'),
        ['Edit', 'Remove', 'Send now'],
      );
      await page.click('.ph-queued[data-queued="q1"] [data-act="remove"]');
      await page.waitFor('document.querySelectorAll(".ph-queued").length === 1', 15000, 'removed');
      assertEquals(s.liveCalls.at(-1), ['queue-remove', { id: 'main', messageId: 'q1' }]);
      await page.click('#phStop');
      await until(() => s.liveCalls.at(-1)?.[0] === 'cancel', 'Stop', 10);
      assertEquals(s.liveCalls.at(-1), ['cancel', { id: 'main' }]);

      // switches off on the PC: the composer, Stop and the queue buttons go away at the next poll
      main.permissions = [{
        key: 'perm2',
        params: { toolCall: { title: 'Run lint' }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }] },
      }];
      main.attention = { ...main.attention, state: 'needs_you', needs: 1 };
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read'] });
      await page.waitFor(
        '!document.getElementById("phComposer") && !!document.querySelector(".ph-wait[data-wait=perm2]")',
        15000,
        'controls hidden',
      );
      assertEquals(await page.eval('document.querySelectorAll(".ph-wait .ph-btn, .ph-queued .ph-btn").length'), 0);
      assert(await page.eval('document.body.textContent.includes("Sending from this phone is off.")'));
      assert(await page.eval('document.querySelector(".ph-wait[data-wait=perm2]").textContent.includes("Finish this on your PC.")'));
      assert(await page.eval(NO_SIDEWAYS), `switches off: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.shot('phone-switches-off');

      // on again, then the PC can't be reached: nothing to send or answer while offline
      await pc(s, 'POST', '/api/live/devices/scopes', {
        id: phone.id,
        scopes: ['phone.read', 'phone.prompt', 'phone.approve', 'phone.answer'],
      });
      await page.waitFor('!!document.getElementById("phComposer") && !!document.querySelector(".ph-wait .ph-btn")', 15000, 'controls back');
      up.on = false;
      await page.waitFor('!!document.querySelector(".ph-offline")', 15000, 'offline');
      assertEquals(
        await page.eval(
          '[!!document.getElementById("phComposer"), document.querySelectorAll(".ph-wait .ph-btn, .ph-queued .ph-btn").length]',
        ),
        [false, 0],
      );
      assert(await page.eval(NO_SIDEWAYS), `offline: sideways scroll ${await page.eval(WIDTHS)}`);
      assertEquals(page.errors, [], 'console errors');
      assertEquals(page.csp, [], 'CSP violations');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "PC: Settings > Devices shows each phone's switches (a change is saved at once) and Phone activity with the chat's title",
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      s.chats.push({
        id: 'c1',
        provider: 'claude',
        sessionId: 'sess-c1',
        cwd: 'C:\\code\\shop',
        busy: false,
        closed: false,
        attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
        subagents: {},
        breadth: { sessionInfo: { title: 'Checkout redesign' } },
        events: [],
        permissions: [],
        elicitations: [],
      });
      const phone = await pairPhone(s, 'Pixel 9', ['phone.read', 'phone.answer']);
      const sent = await raw(
        s.phonePort(),
        'POST',
        '/api/remote/prompt',
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, 'POST'),
        JSON.stringify({ id: 'c1', text: 'hello', clientMessageId: 'm1' }),
      );
      assertEquals(sent.status, 403, 'Send is off for this phone');
      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!document.getElementById("openSettings")', 15000, 'chat page');
      await page.click('#openSettings');
      await page.waitFor(`document.body.classList.contains('settings-open')`, 8000, 'settings open');
      await page.eval(`[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'Devices').click()`);
      const row = `.dv-device[data-device="${phone.id}"]`;
      await page.waitFor(`!!document.querySelector('${row} input[data-scope="phone.prompt"]')`, 8000, "the phone's switches");
      assertEquals(
        await page.eval(`[...document.querySelectorAll('${row} input[data-scope]')].map((i) => [i.dataset.scope, i.checked, i.disabled])`),
        [
          ['phone.read', true, true],
          ['phone.answer', true, false],
          ['phone.prompt', false, false],
          ['phone.approve', false, false],
          ['phone.push', false, false],
        ],
      );
      await page.click(`${row} input[data-scope="phone.prompt"]`);
      await until(
        async () => {
          const [, v] = await pc(s, 'GET', '/api/live/devices');
          return ((v.devices as Json[])[0].scopes as string[]).includes('phone.prompt');
        },
        'the switch is saved',
        10,
      );
      await page.waitFor(`document.querySelector('${row} input[data-scope="phone.prompt"]').checked`, 8000, 'drawn on');
      const again = await raw(
        s.phonePort(),
        'POST',
        '/api/remote/prompt',
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, 'POST'),
        JSON.stringify({ id: 'c1', text: 'hello', clientMessageId: 'm2' }),
      );
      assertEquals(again.status, 200, 'Send is on now');
      await page.eval(`[...document.querySelectorAll('.dv-slot button')].find((b) => b.textContent === 'Phone activity').click()`);
      const lines = await page.waitFor(
        `(() => { const l = [...document.querySelectorAll('.dv-activity p')].map((p) => p.textContent); return l.length > 3 ? l : null; })()`,
        8000,
        'Phone activity',
      ) as string[];
      assert(lines.some((l) => l.endsWith('· Pixel 9 · send · "Checkout redesign": done')), lines.join('\n'));
      assert(lines.some((l) => l.endsWith('· Pixel 9 · send · "Checkout redesign": refused: switched off')), lines.join('\n'));
      assert(!lines.join('\n').includes('hello'), 'no message text');
      await page.shot('pc-devices-switches');
      assertEquals(page.errors, [], 'console errors');
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

// ---- phase C: Finish setup, notifications, the iPhone step ---------------------------------------------------------------------

/** A browser's notification and push parts, faked in the page (a headless browser has no push service): permission asked only by a
 * tap, the subscription made with the PC's key. The permission is kept in sessionStorage, as a browser keeps it across loads. */
function pushStubs(p256dh: string, auth: string): string {
  const sub = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/aib-test', expirationTime: null, keys: { p256dh, auth } });
  return `(() => {
    const key = 'aib-test-permission';
    window.__asked = 0;
    window.__subscribed = 0;
    let sub = null;
    const reg = { pushManager: {
      getSubscription: () => Promise.resolve(sub),
      subscribe: (o) => {
        window.__subscribed++;
        sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/aib-test', options: { applicationServerKey: o.applicationServerKey.buffer },
          toJSON: () => (${sub}), unsubscribe: () => Promise.resolve(true) };
        return Promise.resolve(sub);
      } } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true,
      value: { register: () => Promise.resolve(reg), ready: Promise.resolve(reg), addEventListener() {} } });
    window.PushManager = function PushManager() {};
    window.Notification = function Notification() {};
    Object.defineProperty(window.Notification, 'permission', { get: () => sessionStorage.getItem(key) || 'default' });
    window.Notification.requestPermission = () => {
      window.__asked++;
      sessionStorage.setItem(key, 'granted');
      return Promise.resolve('granted');
    };
  })()`;
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const STEPS = '[...document.querySelectorAll(".ph-step")].map((x) => [x.dataset.step, x.dataset.state])';

Deno.test({
  ...OPTS,
  name: 'phone page at 375 px: Finish setup turns notifications on from a tap; subscribes again on every open; iPhone step on iPhone only',
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      s.chats.push(longChat());
      const phone = await pairPhone(s);
      const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
      const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));

      // Android (not an iPhone): one step and its button; no permission prompt until it is tapped
      const page = await browser.open('about:blank', 375, 812);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: pushStubs(p256dh, auth) });
      await serveFor(page, s, { on: true });
      await signInPage(page, phone.token, phone.id);
      assert(await page.eval('!!document.getElementById("setupOpen")'), 'home offers notifications while they are off');
      assertEquals(await page.eval('window.__asked'), 0, 'never asked without a tap');
      await page.click('#setupOpen');
      await page.waitFor('document.getElementById("app").dataset.screen === "setup"', 15000, 'finish setup');
      assertEquals(await page.eval(STEPS), [['notify', 'todo']]);
      assert(await page.eval(NO_SIDEWAYS), `setup: sideways scroll ${await page.eval(WIDTHS)}`);
      await page.click('#pushOn');
      await page.waitFor('document.querySelector(".ph-step")?.dataset.state === "done"', 15000, 'notifications on');
      assertEquals(await page.eval('window.__asked'), 1);
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals((view.devices as Json[]).map((d) => d.pushOn), [true], 'the PC has the subscription');
      const stored = s.ctx.devices.pushTargets()[0].push;
      assertEquals([stored.endpoint, stored.p256dh, stored.auth], ['https://fcm.googleapis.com/fcm/send/aib-test', p256dh, auth]);
      await page.click('#setupDone');
      await page.waitFor('document.getElementById("app").dataset.screen === "home"', 15000, 'home');
      assert(await page.eval('!document.getElementById("setupOpen")'), 'no setup offer once notifications are on');
      // every page open subscribes again (here the PC lost the subscription; new keys after Remove all work the same way)
      await s.ctx.devices.setPush(phone.id, null);
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "home"', 15000, 'home again');
      await until(() => s.ctx.devices.pushTargets().length === 1, 'subscribed again on open', 15);
      assertEquals(await page.eval('window.__asked'), 0, 'no prompt on open (already allowed)');
      // a push's link opens the chat with its sheet
      await page.goto(`https://${NAME}/phone.html#chat=main&sheet=1`);
      await page.waitFor('document.getElementById("app").dataset.screen === "chat"', 15000, 'the chat from a push');
      assertEquals(await page.eval('location.hash'), '');
      assertEquals(page.errors, [], 'console errors');
      assertEquals(page.csp, [], 'CSP violations');
      await page.close();

      // iPhone: the Home Screen step first; no notification button until AIB is opened from the Home Screen
      const ios = await browser.open('about:blank', 375, 812);
      await ios.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 3, mobile: true });
      await ios.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
      await ios.send('Page.addScriptToEvaluateOnNewDocument', { source: pushStubs(p256dh, auth) });
      await serveFor(ios, s, { on: true });
      await signInPage(ios, phone.token, phone.id);
      await ios.click('#setupOpen');
      await ios.waitFor('document.getElementById("app").dataset.screen === "setup"', 15000, 'finish setup on iPhone');
      assertEquals(await ios.eval(STEPS), [['home', 'todo'], ['notify', 'todo']]);
      assert(await ios.eval('document.body.textContent.includes("Add to Home Screen")'));
      assert(await ios.eval('!document.getElementById("pushOn")'), 'iPhone: notifications only from the Home Screen app');
      assert(await ios.eval(NO_SIDEWAYS), `iPhone setup: sideways scroll ${await ios.eval(WIDTHS)}`);
      assertEquals(ios.errors, [], 'console errors');
      await ios.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
