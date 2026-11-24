/**
 * Linux notifications with buttons (server/desktop/toast_linux.ts), in-process with a fake `AIB-keeper toast`: no D-Bus, nothing on
 * screen. The real helper on a real (private) bus: linux_notify_wsl_e2e_test.ts.
 *  - what the helper is sent: register without app id or COM class, plain fields per row kind (Allow / Deny, the reply box with
 *    GNOME's Open fallback, Continue, Retry, Open only for a risky request, the grouped notification), silent;
 *  - no notification server with buttons: notify-send, as before; no quiet-state check;
 *  - a click: GNOME's Open-for-reply opens the chat itself; everything else goes through toast_act.ts unchanged;
 *  - the whole route on a fake AIB (startLinuxToasts): Allow answers the agent and is logged as "desktop notification"; a click made
 *    while AIB was quit (toast-inbox.jsonl) is applied after start-up.
 */
import { assert, assertEquals } from './_assert.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import type { InboxRow } from '../../app/server/attention/inbox_rules.ts';
import { answersOf } from '../../app/server/attention/answers.ts';
import { DesktopNotifications, type NotifyTarget, type OsNotify } from '../../app/server/desktop/notify.ts';
import {
  type SpawnToastHelper,
  type ToastClick,
  ToastCodes,
  toastSpec,
  toastTag,
} from '../../app/server/desktop/toast.ts';
import { type ToastActDeps } from '../../app/server/desktop/toast_act.ts';
import {
  applyLinuxClick,
  DESKTOP_ENTRY,
  fdoRender,
  LINUX_ANSWER_NAME,
  linuxRoute,
  startLinuxToasts,
} from '../../app/server/desktop/toast_linux.ts';

type Json = Record<string, unknown>;
const OPTS = { sanitizeResources: false, sanitizeOps: false };
const ONCE = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

function row(kind: InboxRow['kind'], over: Partial<InboxRow> = {}): InboxRow {
  return {
    key: 'claude:s1',
    id: 'c1',
    section: kind === 'finished' ? 'review' : 'needs',
    kind,
    what: 'Run npm install stripe@18.0.0',
    whatCode: 'npm install stripe@18.0.0',
    title: 'Payments',
    project: { key: 'p', name: 'shopfront' },
    provider: 'claude',
    agent: 'Claude',
    since: 1000,
    at: 1000,
    needs: 1,
    more: 0,
    helpers: 0,
    request: kind === 'approval'
      ? {
        kind: 'permission',
        key: 'p1',
        params: { toolCall: { toolCallId: 'tc1', title: 'Bash', rawInput: { command: 'npm install stripe@18.0.0' } }, options: ONCE },
      }
      : null,
    ask: '',
    actions: [],
    ...over,
  };
}

const render = (r: InboxRow | null, key: string | null, silent = false) =>
  fdoRender(
    toastSpec(
      { title: 'Payments', body: 'shopfront\nRun it\nthird line', target: key ? { type: 'inbox', key } : { type: 'inbox' }, silent },
      r,
      'CODE',
    ),
    key ?? '',
  );

Deno.test('linux notifications: the helper gets plain fields with the same buttons and codes as the Windows toast', () => {
  const open = 'act=open&chat=claude%3As1';
  assertEquals(render(row('approval'), 'claude:s1'), {
    title: 'Payments',
    body: 'shopfront\nRun it',
    default: open,
    buttons: [{ label: 'Allow', args: 'act=allow&chat=claude%3As1&n=CODE' }, { label: 'Deny', args: 'act=deny&chat=claude%3As1&n=CODE' }],
  });
  assertEquals(render(row('asks'), 'claude:s1'), {
    title: 'Payments',
    body: 'shopfront\nRun it',
    default: open,
    buttons: [{ label: 'Send', args: 'act=reply&chat=claude%3As1&n=CODE', input: 'reply' }],
    reply: 'Reply',
    replyOpen: 'act=open&chat=claude%3As1&to=chat',
  });
  assertEquals(render(row('finished'), 'claude:s1', true).silent, true);
  assertEquals((render(row('stalled'), 'claude:s1').buttons as Json[]).map((b) => b.label), ['Continue', 'Open']);
  assertEquals((render(row('failed'), 'claude:s1').buttons as Json[]).map((b) => b.label), ['Retry', 'Open']);
  const pushRow = row('approval', {
    what: 'Run git push origin main',
    whatCode: 'git push origin main',
    request: {
      kind: 'permission',
      key: 'p2',
      params: { toolCall: { toolCallId: 'tc2', title: 'Bash', rawInput: { command: 'git push origin main' } }, options: ONCE },
    },
  });
  assertEquals(render(pushRow, 'claude:s1').buttons, [{ label: 'Open', args: open }], 'a risky command: Open only');
  // the grouped notification ("3 agents are waiting for you"): a body click opens the inbox, no buttons
  assertEquals(render(null, null), { title: 'Payments', body: 'shopfront\nRun it', default: 'act=inbox', buttons: [] });
});

function fakeHelper(answer: 'ready' | 'error' = 'ready') {
  const sent: Json[] = [];
  let deliver: (m: Json) => void = () => {};
  const spawn: SpawnToastHelper = (onMessage) => {
    deliver = onMessage;
    return {
      send(m) {
        sent.push(m);
        if (m.op === 'register') {
          queueMicrotask(() =>
            onMessage(answer === 'ready' ? { op: 'ready', caps: ['actions'] } : { op: 'error', error: 'no notification server: x' })
          );
        }
        if (m.op === 'show') queueMicrotask(() => onMessage({ op: 'shown', id: m.id }));
      },
      close() {},
    };
  };
  return { spawn, sent, click: (m: Json) => deliver({ op: 'activated', ...m }) };
}

function fakeNotifySend() {
  const shown: string[] = [];
  const route: OsNotify = {
    mechanism: 'notify-send',
    show: (t, b) => (shown.push(`${t}|${b}`), Promise.resolve({ shown: true, code: 0 })),
  };
  return { route, shown };
}

Deno.test('linux route: register and show messages; no server with buttons: notify-send; no quiet check', async () => {
  const h = fakeHelper();
  const ns = fakeNotifySend();
  const rows = [row('approval')];
  const clicks: ToastClick[] = [];
  const route = linuxRoute({
    spawn: h.spawn,
    register: { name: 'AIB', icon: '/d/toast-icon.png', data: '/d', launch: '/usr/bin/aib', desktop: DESKTOP_ENTRY },
    balloon: ns.route,
    codes: new ToastCodes(),
    rowOf: (k) => rows.find((r) => r.key === k) ?? null,
    onActivated: (c) => clicks.push(c),
    timeoutMs: 50,
  });
  assertEquals(route.mechanism, 'linux-notify');
  const r = await route.show('Payments', 'shopfront', false, {
    title: 'Payments',
    body: 'shopfront',
    target: { type: 'inbox', key: 'claude:s1' },
    test: false,
  });
  assertEquals(r.shown, true);
  assertEquals(h.sent[0], {
    op: 'register',
    name: 'AIB',
    icon: '/d/toast-icon.png',
    data: '/d',
    launch: '/usr/bin/aib',
    desktop: 'dev.aib.app',
  });
  const show = h.sent[1];
  assertEquals([show.op, show.tag, show.group, 'xml' in show], ['show', toastTag('claude:s1'), 'aib', false]);
  assertEquals((show.buttons as Json[]).map((b) => b.label), ['Allow', 'Deny']);
  assertEquals(ns.shown, []);
  // a click carries the activation token through
  h.click({ args: 'act=open&chat=claude%3As1', inputs: {}, token: 'tok-1' });
  assertEquals(clicks, [{ args: 'act=open&chat=claude%3As1', inputs: {}, token: 'tok-1' }]);
  // answered elsewhere: the helper is told to close it
  route.seeInbox({ rows: [] });
  assertEquals(h.sent.at(-1), { op: 'remove', tag: toastTag('claude:s1'), group: 'aib' });

  // no notification server (or one without buttons): notify-send, as before
  const bad = fakeHelper('error');
  const ns2 = fakeNotifySend();
  const route2 = linuxRoute({
    spawn: bad.spawn,
    register: { name: 'AIB', icon: '', data: '/d', launch: '', desktop: DESKTOP_ENTRY },
    balloon: ns2.route,
    codes: new ToastCodes(),
    rowOf: () => null,
    onActivated: () => {},
    timeoutMs: 50,
  });
  const r2 = await route2.show('Your turn', 'Docs', false, { title: 'Your turn', body: 'Docs', target: null, test: false });
  assertEquals([r2.shown, ns2.shown], [true, ['Your turn|Docs']]);
});

function fakeDeps(rows: InboxRow[], codes: ToastCodes) {
  const opened: (NotifyTarget | null)[] = [];
  const calls: [string, Json][] = [];
  const deps: ToastActDeps = {
    look: () => Promise.resolve({ rows }),
    liveCall: (name, body) => (calls.push([name, body]), Promise.resolve([200, {}])),
    liveState: () => Promise.resolve({ events: [] }),
    continueChat: (key) => (calls.push(['continue', { key }]), Promise.resolve([200, {}])),
    sendText: (key, text) => (calls.push(['send', { key, text }]), Promise.resolve([200, {}])),
    note: () => {},
    codes,
    open: (t) => opened.push(t),
    removeToast: () => {},
  };
  return { deps, opened, calls };
}

Deno.test("linux click: GNOME's Open-for-reply opens the chat; the rest is toast_act.ts's (forged clicks only open)", async () => {
  const asks = row('asks');
  const codes = new ToastCodes();
  const f = fakeDeps([asks], codes);
  assertEquals(await applyLinuxClick(f.deps, { args: 'act=open&chat=claude%3As1&to=chat', inputs: {} }), {
    done: false,
    act: 'open',
    reason: 'opened',
  });
  assertEquals(f.opened, [{ type: 'chat', key: 'claude:s1' }]);
  // a body click: the inbox on the chat's row, as on Windows
  await applyLinuxClick(f.deps, { args: 'act=open&chat=claude%3As1', inputs: {} });
  assertEquals(f.opened.at(-1), { type: 'inbox', key: 'claude:s1' });
  // to=chat never turns into an action: a forged reply with it only opens
  const forged = await applyLinuxClick(f.deps, { args: 'act=reply&chat=claude%3As1&to=chat', inputs: { reply: 'hi' } });
  assertEquals([forged.done, f.calls], [false, []]);
  // the inline reply (KDE): the typed text goes to the chat
  const code = codes.issue('claude:s1', `asks|${Math.round(asks.since)}`, ['reply']);
  const sent = await applyLinuxClick(f.deps, { args: `act=reply&chat=claude%3As1&n=${code}`, inputs: { reply: 'ship it' } });
  assertEquals([sent.done, f.calls], [true, [['send', { key: 'claude:s1', text: 'ship it' }]]]);
});

async function until(what: string, ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const needs = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
const perm = (key: string, command: string) => [{
  key,
  params: { toolCall: { toolCallId: `tc-${key}`, title: 'Bash', rawInput: { command } }, options: ONCE },
}];

Deno.test({
  ...OPTS,
  name: 'linux route on a fake AIB: Allow answers once as "desktop notification"; a click from while AIB was quit is applied',
  async fn() {
    const s = await v2Studio();
    const dir = await Deno.makeTempDir({ prefix: 'aib-linux-notify-' });
    const stops: (() => void)[] = [];
    try {
      s.chats.push(
        liveChat('c-ok', s.project, {
          breadth: { sessionInfo: { title: 'Payments' } },
          attention: { ...needs },
          permissions: perm('p1', 'npm i'),
        }),
        liveChat('c-late', s.project, {
          breadth: { sessionInfo: { title: 'Docs' } },
          attention: { ...needs },
          permissions: perm('p2', 'npm run docs'),
        }),
      );
      const calls: [string, Json][] = [];
      s.answerLive((name, body) => {
        calls.push([name, body]);
        const c = s.chats.find((x) => x.id === body.id);
        if (name === 'permission' && c) {
          c.permissions = [];
          c.attention = { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() };
          c.busy = true;
        }
        return [200, { ok: true }];
      });
      const h = fakeHelper();
      const ns = fakeNotifySend();
      const opened: (NotifyTarget | null)[] = [];
      const notifications = new DesktopNotifications(ns.route, (t) => opened.push(t), () => true);
      const started = startLinuxToasts(s.ctx, notifications, {
        stateDir: dir,
        program: 'unused',
        launch: '/usr/bin/aib',
        icon: new Uint8Array([137, 80, 78, 71]),
        spawn: h.spawn,
        firstWaitMs: 50,
        settleMs: 10,
      });
      assert(started);
      stops.push(started.stop);
      assertEquals(notifications.mechanism, 'linux-notify');
      await until('registered', () => started.toasts.state === 'ready');
      assertEquals(h.sent[0], {
        op: 'register',
        name: 'AIB',
        icon: `${dir}/toast-icon.png`,
        data: dir,
        launch: '/usr/bin/aib',
        desktop: 'dev.aib.app',
      });
      await s.ctx.inbox.look();
      const key = (id: string) => `claude:sess-${id}`;
      const show = async (id: string) => {
        assert((await notifications.show({ title: id, body: 'shopfront', target: { type: 'inbox', key: key(id) }, test: false })).shown);
        return (h.sent.filter((m) => m.op === 'show').at(-1)!.buttons as { label: string; args: string }[]);
      };
      const ok = await show('c-ok');
      assertEquals(ok.map((b) => b.label), ['Allow', 'Deny']);
      h.click({ args: ok[0].args, inputs: {} });
      await until('approved', () => calls.some((c) => c[0] === 'permission'));
      assertEquals(calls, [['permission', { id: 'c-ok', key: 'p1', option: 'yes' }]]);
      await until('logged', () => answersOf(s.ctx).who('c-ok', 'p1') !== null);
      assertEquals(answersOf(s.ctx).who('c-ok', 'p1')?.name, LINUX_ANSWER_NAME);
      assertEquals(opened, [], 'Allow brings no window up');

      // a notification shown, then AIB quits; the helper writes the click to the inbox file; AIB starts and applies it once
      const late = await show('c-late');
      started.stop();
      await Deno.writeTextFile(`${dir}/toast-inbox.jsonl`, JSON.stringify({ args: late[0].args, at: Date.now() }) + '\n');
      const again = startLinuxToasts(s.ctx, new DesktopNotifications(ns.route, (t) => opened.push(t), () => true), {
        stateDir: dir,
        program: 'unused',
        launch: '',
        icon: new Uint8Array([1]),
        spawn: fakeHelper().spawn,
        firstWaitMs: 50,
        settleMs: 10,
      });
      assert(again);
      stops.push(again.stop);
      const applied = await again.applied;
      assertEquals(applied.map((a) => [a.act, a.done]), [['allow', true]]);
      assertEquals(calls.at(-1), ['permission', { id: 'c-late', key: 'p2', option: 'yes' }]);
      assertEquals(answersOf(s.ctx).who('c-late', 'p2')?.name, LINUX_ANSWER_NAME);
    } finally {
      for (const stop of stops) stop();
      await s.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
