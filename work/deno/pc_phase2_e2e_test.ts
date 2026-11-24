/**
 * Remote control from other PCs, phase 2, end to end on the phone port with a paired fake computer and phone (no Tailscale: forged
 * Serve headers; a fake agent host; pushes and desktop notifications recorded, nothing is sent):
 *   - presence: POST /api/remote/pc/presence makes the slot from the device (a page's `w: 'm'` never touches the PC's main window),
 *     answers in the page's own terms, and a phone is refused
 *   - notifications: working on the laptop -> no desktop notification on the PC, a push to the laptop only (its page in the
 *     background), none while its page is in front; working at the PC -> the laptop's answer says quiet
 *   - two devices on one card: the first answer wins; the line names the device that answered ("on Laptop (Edge)"); the second
 *     device is told who was first; sends from two devices reach the agent host in arrival order through the normal queue
 *   - drafts stay per device (the page's localStorage, never a key synced to the PC)
 */
import { assert, assertEquals } from './_assert.ts';
import { readRemotePort } from '../../app/server/remote/port.ts';
import { DEVICE_HEADER, RateLimit } from '../../app/server/remote/pc_bridge.ts';
import { startAttention } from '../../app/server/attention/watcher.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { type FakeChat, fakeTailscale, pairPhone, pc, phoneHeaders, raw, type RemoteStudio, remoteStudio, serveStatus } from './_remote_fixture.ts';

Deno.env.set('AIB_TEST_SETTLE_MS', '0');
const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function remoteOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
  (s.ctx.phone.server!.bridge as unknown as { limit: RateLimit }).limit = new RateLimit(1e6, 1e6);
  return s;
}

const OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

function chat(id: string, cwd: string): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd,
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    breadth: { sessionInfo: { title: 'Fix the menu' } },
    events: [{ seq: 1, time: Date.now() / 1000, kind: 'user', data: { text: 'go' } }],
    permissions: [],
    elicitations: [],
  };
}

/** A waiting approval (the agent host's shape: the permission event, the open request, "needs you"). */
function ask(c: FakeChat, key: string) {
  const params = { options: OPTIONS, toolCall: { title: 'npm test -- nav', rawInput: { command: 'npm test -- nav' } } };
  c.permissions.push({ key, params });
  c.events.push({ seq: c.events.length + 1, time: Date.now() / 1000, kind: 'permission', data: { key, params } });
  c.attention = { state: 'needs_you', needs: c.permissions.length, turnEndedAt: null, busySince: null };
}

/** The agent host takes one answer per request: the first one goes, a later one is "no longer pending" (acp/connection.ts). */
function firstAnswerWins(s: RemoteStudio) {
  s.answerLive((name, body) => {
    if (name !== 'permission') return [200, { ok: true }];
    const c = s.chats.find((x) => x.id === body.id)!;
    const i = c.permissions.findIndex((p) => p.key === body.key);
    if (i < 0) return [400, { error: 'This approval is no longer pending' }];
    c.permissions.splice(i, 1);
    if (!c.permissions.length) c.attention = { state: 'idle', needs: 0, turnEndedAt: null, busySince: null };
    return [200, { ok: true }];
  });
}

function call(s: RemoteStudio, token: string, method: string, path: string, body?: Json) {
  return raw(
    s.phonePort(),
    method,
    path,
    { ...phoneHeaders({}, method), [DEVICE_HEADER]: token },
    body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
  );
}

async function until(check: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(30);
  }
  throw new Error(`timed out: ${what}`);
}

Deno.test({
  ...OPTS,
  name: 'phase 2 presence: the slot comes from the device, the answer is in the page terms, a phone is refused',
  async fn() {
    const s = await remoteOn();
    try {
      const laptop = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const phone = await pairPhone(s, 'Pixel 9');
      // the page sends its own tab id; even 'm' (the PC's main window id) only finds this tab's slot
      const r = await call(s, laptop.token, 'POST', '/api/remote/pc/presence', {
        w: 'm',
        kind: 'main',
        focused: true,
        visible: true,
        idleMs: 0,
        open: ['claude:sess-c1'],
      });
      assertEquals(r.status, 200, r.text);
      assertEquals((r.json.windows as Json[]).map((x) => x.w), ['m']);
      assertEquals([r.json.soundOwner, r.json.quiet, r.json.openAll], ['m', false, ['claude:sess-c1']]);
      assertEquals(s.ctx.presence.windows(), [], "the PC's own windows are untouched");
      assertEquals([s.ctx.presence.focused(), s.ctx.presence.openOnPc()], [false, []]);
      assertEquals(s.ctx.presence.where(), { who: 'computer', device: laptop.id });
      // a bad body, a phone, no device
      assertEquals((await call(s, laptop.token, 'POST', '/api/remote/pc/presence', { w: 'r-x-1' })).status, 400);
      const fromPhone = await call(s, phone.token, 'POST', '/api/remote/pc/presence', { w: 't-abcd01' });
      assertEquals([fromPhone.status, fromPhone.json.code], [403, 'not_computer']);
      const none = await raw(s.phonePort(), 'POST', '/api/remote/pc/presence', phoneHeaders({}, 'POST'), JSON.stringify({ w: 't-abcd01' }));
      assertEquals(none.status, 401);
      // the PC page's own answer says quiet while you are at the laptop
      const [, desk] = await pc(s, 'POST', '/api/live/presence', { w: 'm', focused: false, idleMs: 600_000 });
      assertEquals(desk.quiet, true);
      // Settings > Remote control: the laptop's row says "Active now" (devices-ui.js), the phone's does not
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      const rows = view.devices as Json[];
      assertEquals([rows.find((d) => d.id === laptop.id)!.active, rows.find((d) => d.id === phone.id)!.active], [true, undefined]);
      // Remove: its slots and its "where you are" go
      assertEquals((await pc(s, 'POST', '/api/live/devices/remove', { id: laptop.id }))[0], 200);
      assertEquals(s.ctx.presence.where(), null);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phase 2 notifications: on the laptop -> no PC desktop notification, a push to the laptop only; none while its page is in front',
  async fn() {
    const s = await remoteOn();
    const desktop: Json[] = [];
    const pushes: string[][] = [];
    let watcher: { stop(): Promise<void> } | null = null;
    try {
      const laptop = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const phone = await pairPhone(s, 'Pixel 9');
      for (const [d, tag] of [[laptop, 'lap'], [phone, 'ph']] as const) {
        const sub = { endpoint: `https://fcm.googleapis.com/fcm/send/p2-${tag}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
        assertEquals((await call(s, d.token, 'POST', '/api/remote/push/subscribe', { subscription: sub })).status, 200);
      }
      s.ctx.desktopNotify = { mechanism: 'test', show: (req: Json) => (desktop.push(req), Promise.resolve({ shown: true })) } as never;
      const push = s.ctx.phone.push as unknown as { send: (m: Json, to?: (t: { id: string; kind: 'phone' | 'computer' }) => boolean) => Promise<unknown> };
      push.send = (_m, to) => {
        pushes.push(s.ctx.phone.devices.pushTargets().filter((t) => !to || to(t)).map((t) => t.id));
        return Promise.resolve([]);
      };
      await pc(s, 'POST', '/api/live/view-prefs', { set: { 'studio-notifications-app': JSON.stringify({ notifyFor: 'both' }) } });
      const c = chat('c1', s.project);
      s.chats.push(c);
      watcher = startAttention(s.ctx, { pollMs: 100 });
      await sleep(300); // the first look: nothing is news yet
      // working on the laptop; its AIB tab in the background (another app on the laptop)
      assertEquals((await call(s, laptop.token, 'POST', '/api/remote/pc/presence', { w: 't-lap001', focused: false, idleMs: 0 })).status, 200);
      ask(c, 'perm-1');
      await until(() => pushes.length === 1, 'a push');
      assertEquals(pushes, [[laptop.id]], 'to the laptop only (not the phone)');
      assertEquals(desktop, [], 'the PC stays quiet');
      // its AIB tab in front: the page shows it itself, no push and still nothing on the PC
      assertEquals((await call(s, laptop.token, 'POST', '/api/remote/pc/presence', { w: 't-lap001', focused: true, idleMs: 0 })).status, 200);
      ask(c, 'perm-2');
      await sleep(600);
      assertEquals([pushes.length, desktop.length], [1, 0]);
      // back at the PC: the laptop's answer says quiet
      await pc(s, 'POST', '/api/live/presence', { w: 'm', focused: true, idleMs: 0 });
      const lap = await call(s, laptop.token, 'POST', '/api/remote/pc/presence', { w: 't-lap001', focused: true, idleMs: 30_000 });
      assertEquals(lap.json.quiet, true);
    } finally {
      await watcher?.stop();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phase 2 two devices on one card: the first answer wins, the line names the device, the second is told who was first',
  async fn() {
    const s = await remoteOn();
    try {
      firstAnswerWins(s);
      const laptop = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const phone = await pairPhone(s, 'Pixel 9');
      const c = chat('c1', s.project);
      s.chats.push(c);
      ask(c, 'perm-1');
      ask(c, 'perm-2');
      // the laptop allows perm-1 once
      const first = await call(s, laptop.token, 'POST', '/api/live/permission', { id: 'c1', key: 'perm-1', option: 'allow' });
      assertEquals(first.status, 200, first.text);
      const [, state] = await pc(s, 'GET', '/api/live/state?id=c1');
      const by = (state.answers as Json)['perm-1'] as Json;
      assertEquals([by.by, by.name, by.option], [laptop.id, 'Laptop (Edge)', 'allow']);
      // the phone and the PC are too late: told who was first
      const late = await call(s, phone.token, 'POST', '/api/remote/permission', { id: 'c1', key: 'perm-1', option: 'allow' });
      assertEquals([late.status, late.json.error], [409, 'Already answered on Laptop (Edge).']);
      const [deskStatus, desk] = await pc(s, 'POST', '/api/live/permission', { id: 'c1', key: 'perm-1', option: 'deny' });
      assertEquals([deskStatus, desk.error, desk.code], [409, 'Already answered on Laptop (Edge).', 'answered']);
      // the phone denies perm-2 first; the laptop is told
      const ph = await call(s, phone.token, 'POST', '/api/remote/permission', { id: 'c1', key: 'perm-2', option: 'deny' });
      assertEquals(ph.status, 200, ph.text);
      const lateLaptop = await call(s, laptop.token, 'POST', '/api/live/permission', { id: 'c1', key: 'perm-2', option: 'allow' });
      assertEquals([lateLaptop.status, lateLaptop.json.error], [409, 'Already answered on Pixel 9.']);
      // the laptop's own state read names both answers (its page names the device only when it is another one)
      const mine = await call(s, laptop.token, 'GET', '/api/live/state?id=c1');
      const answers = mine.json.answers as Record<string, Json>;
      assertEquals([answers['perm-1'].by, answers['perm-2'].by, answers['perm-2'].name], [laptop.id, phone.id, 'Pixel 9']);
      // a PC answer is named with the PC's name
      ask(c, 'perm-3');
      assertEquals((await pc(s, 'POST', '/api/live/permission', { id: 'c1', key: 'perm-3', option: 'allow' }))[0], 200);
      const [, after] = await pc(s, 'GET', '/api/live/state?id=c1');
      assertEquals(((after.answers as Json)['perm-3'] as Json).by, 'pc');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phase 2 in a browser: the PC page line reads "Allowed once on Laptop (Edge)" after the laptop answered',
  ignore: !browserPath,
  async fn() {
    const s = await remoteOn();
    const browser = await Browser.launch();
    try {
      firstAnswerWins(s);
      const laptop = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const c = chat('c1', s.project);
      s.chats.push(c);
      ask(c, 'perm-1');
      ask(c, 'perm-2');
      assertEquals((await call(s, laptop.token, 'POST', '/api/live/permission', { id: 'c1', key: 'perm-1', option: 'allow' })).status, 200);
      const page = await browser.open('about:blank', 1280, 860);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!document.querySelector("#connections [data-key]")', 20000, 'the chat list');
      await page.eval(`document.querySelector('#connections [data-key]').click()`);
      await page.waitFor(
        `[...document.querySelectorAll('.answered-text')].some((n) => n.textContent === 'Approval · npm test -- nav · Allowed once on Laptop (Edge)')`,
        15000,
        'the line names the laptop',
      );
      // the card the laptop has not answered is still up on the PC; the PC denies it: its own line has no device name
      await page.waitFor(`!!document.querySelector('#approvals .approval')`, 10000, 'the open card');
      await page.eval(`[...document.querySelectorAll('#approvals .approval button')].find((b) => b.textContent === 'Deny').click()`);
      await page.waitFor(
        `[...document.querySelectorAll('.answered-text')].some((n) => n.textContent === 'Approval · npm test -- nav · Deny')`,
        15000,
        "the PC's own answer",
      );
      await page.shot('p2-answered-on-laptop');
      assertEquals(page.errors, []);
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phase 2 sends from two devices go through the normal queue in arrival order; drafts stay per device',
  async fn() {
    const s = await remoteOn();
    try {
      const laptop = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer');
      const phone = await pairPhone(s, 'Pixel 9');
      const c = chat('c1', s.project);
      c.busy = true;
      s.chats.push(c);
      const a = await call(s, laptop.token, 'POST', '/api/live/queue', { id: 'c1', text: 'from the laptop', clientMessageId: 'm-lap-1' });
      assertEquals(a.status, 200, a.text);
      const b = await call(s, phone.token, 'POST', '/api/remote/queue', { id: 'c1', text: 'from the phone', clientMessageId: 'm-ph-1' });
      assertEquals(b.status, 200, b.text);
      const queued = s.liveCalls.filter(([n]) => n === 'queue').map(([, body]) => body.clientMessageId);
      assertEquals(queued, ['m-lap-1', 'm-ph-1']);
      // drafts: chat.js keeps them in the page's own localStorage ('studio-drafts-v1'), which view-prefs.js never syncs to the PC
      const root = new URL('../../app/page/', import.meta.url);
      const prefs = await Deno.readTextFile(new URL('view-prefs.js', root));
      const chatJs = await Deno.readTextFile(new URL('chat.js', root));
      assert(chatJs.includes("new DraftStore(localStorage, 'studio-drafts-v1'"), 'drafts live in localStorage');
      assert(!prefs.includes('studio-drafts'), 'drafts are not a synced view preference');
    } finally {
      await s.close();
    }
  },
});
