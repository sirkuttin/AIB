/**
 * Inbox v3.1 phase 4, Windows toasts with buttons (server/desktop/toast.ts, toast_act.ts), all with fakes: no helper process, no
 * registry, no toast on screen.
 *  - the toast XML per row kind (Allow / Deny, Reply + Send, Continue, Retry, Open only for a risky or PC-only request; the grouped
 *    toast has no buttons), escaped;
 *  - the one-time codes: good once, refused when expired, already used, for another chat, for a button it wasn't issued with, or
 *    when the request was answered (the row is gone or about a newer request);
 *  - the toast route: registers once, shows through the helper, falls back to the balloon when the helper doesn't start, refuses a
 *    toast, or dies; nothing at all in quiet time; removes a toast once its request was answered elsewhere;
 *  - a click: Allow answers with the agent's allow_once option and is logged; a forged or risky click only opens the chat; Reply,
 *    Continue and Retry send; clicks made while AIB was closed are read from toast-inbox.jsonl once.
 */
import { assert, assertEquals } from './_assert.ts';
import type { InboxRow } from '../../outputs/agent-studio/server/attention/inbox_rules.ts';
import type { NotifyRequest, NotifyTarget, OsNotify } from '../../outputs/agent-studio/server/desktop/notify.ts';
import {
  parseToastArgs,
  type SpawnToastHelper,
  toastActs,
  ToastCodes,
  toastSpec,
  toastTag,
  toastXml,
  WindowsToasts,
} from '../../outputs/agent-studio/server/desktop/toast.ts';
import { applyToastClick, pendingFile, takePending, type ToastActDeps } from '../../outputs/agent-studio/server/desktop/toast_act.ts';

type Json = Record<string, unknown>;
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

const risky = (command: string) =>
  row('approval', {
    what: `Run ${command}`,
    whatCode: command,
    request: {
      kind: 'permission',
      key: 'p2',
      params: { toolCall: { toolCallId: 'tc2', title: 'Bash', rawInput: { command } }, options: ONCE },
    },
  });

const req = (key: string | null, over: Partial<NotifyRequest> = {}): NotifyRequest => ({
  title: 'Payments',
  body: 'shopfront · Run npm install stripe@18.0.0',
  target: key ? { type: 'inbox', key } : { type: 'inbox' },
  test: false,
  ...over,
});

const buttons = (xml: string) =>
  [...xml.matchAll(/<action content="([^"]*)" arguments="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]);

Deno.test('toast XML: the buttons per row kind', () => {
  const xmlOf = (r: InboxRow | null, key: string | null = 'claude:s1', over: Partial<NotifyRequest> = {}) =>
    toastXml(toastSpec(req(key, over), r, 'CODE'));

  const appr = xmlOf(row('approval'));
  assertEquals(buttons(appr), [['Allow', 'act=allow&chat=claude%3As1&n=CODE'], ['Deny', 'act=deny&chat=claude%3As1&n=CODE']]);
  assert(appr.startsWith('<toast launch="act=open&amp;chat=claude%3As1">'), appr);
  assert(appr.includes('<text>Payments</text><text>shopfront · Run npm install stripe@18.0.0</text>'), appr);
  assert(!appr.includes('<input'), 'no text box on an approval');
  assert(!appr.includes('<audio'), 'an approval plays the default sound');
  assert(!/scenario=/.test(appr), 'default scenario only');

  for (const cmd of ['git push origin main', 'git push --force', 'rm -rf build', 'Remove-Item -Recurse dist']) {
    assertEquals(buttons(xmlOf(risky(cmd))), [['Open', 'act=open&chat=claude%3As1']], cmd);
  }
  assertEquals(toastActs(row('approval', { request: { ...row('approval').request!, pcOnly: true } })), ['open'], 'PC-only: Open');
  assertEquals(
    toastActs(
      row('approval', {
        request: { kind: 'permission', key: 'p', params: { options: [{ optionId: 'a', name: 'Always', kind: 'allow_always' }] } },
      }),
    ),
    ['open'],
    'no once-option: Open',
  );
  assertEquals(
    toastActs(
      row('approval', {
        request: { kind: 'permission', key: 'p', params: { toolCall: { kind: 'delete', title: 'Delete old.txt' }, options: ONCE } },
      }),
    ),
    ['open'],
    'a delete tool',
  );

  const asks = xmlOf(row('asks', { what: 'Rewrite the parser, or just make it readable?' }));
  assert(asks.includes('<input id="reply" type="text" placeHolderContent="Reply"/>'), asks);
  assert(
    asks.includes(
      '<action content="Send" arguments="act=reply&amp;chat=claude%3As1&amp;n=CODE" activationType="foreground" hint-inputId="reply"/>',
    ),
    asks,
  );

  const done = xmlOf(row('finished'), 'claude:s1', { silent: true });
  assertEquals(buttons(done), [['Send', 'act=reply&chat=claude%3As1&n=CODE']]);
  assert(done.endsWith('<audio silent="true"/></toast>'), 'Finished stays silent');

  assertEquals(buttons(xmlOf(row('stalled'))), [['Continue', 'act=continue&chat=claude%3As1&n=CODE'], [
    'Open',
    'act=open&chat=claude%3As1',
  ]]);
  assertEquals(buttons(xmlOf(row('failed'))), [['Retry', 'act=retry&chat=claude%3As1&n=CODE'], ['Open', 'act=open&chat=claude%3As1']]);
  assertEquals(buttons(xmlOf(row('question'))), [['Open', 'act=open&chat=claude%3As1']]);
  assertEquals(buttons(xmlOf(row('signin'))), [['Open', 'act=open&chat=claude%3As1']]);

  const group = xmlOf(row('approval'), null, { title: '3 agents are waiting for you', body: 'A\nB\nC' });
  assert(!group.includes('<actions>'), 'the grouped toast has no buttons');
  assert(group.startsWith('<toast launch="act=inbox">'), group);
  const front = toastXml(toastSpec({ title: 'AIB update ready', body: 'Click Update', target: null }, null, ''));
  assert(front.startsWith('<toast launch="act=front">') && !front.includes('<actions>'), front);

  const nasty = toastXml(toastSpec(req('claude:s1', { title: 'a & b <c> "d"', body: "it's" }), row('question'), 'X'));
  assert(nasty.includes('<text>a &amp; b &lt;c&gt; &quot;d&quot;</text><text>it&apos;s</text>'), nasty);
  assertEquals(parseToastArgs('act=allow&chat=claude%3As1&n=Z'), { act: 'allow', chat: 'claude:s1', code: 'Z' });
  assert(toastTag('claude:' + 'x'.repeat(300)).length <= 64, 'Windows caps tags at 64');
});

Deno.test('one-time codes: good once, for that chat, that button and that request, until they expire', () => {
  let now = 1_000_000;
  const codes = new ToastCodes({ clock: () => now, ttlMs: 60_000 });
  const c = codes.issue('claude:s1', 'approval|tc1', ['allow', 'deny']);
  assertEquals(codes.check('nope', 'claude:s1', 'allow', 'approval|tc1'), { ok: false, reason: 'unknown' });
  assertEquals(codes.check(c, 'claude:other', 'allow', 'approval|tc1'), { ok: false, reason: 'wrong_chat' });
  assertEquals(codes.check(c, 'claude:s1', 'reply', 'approval|tc1'), { ok: false, reason: 'not_allowed' });
  assertEquals(codes.check(c, 'claude:s1', 'allow', null), { ok: false, reason: 'answered' }, 'the row is gone');
  assertEquals(codes.check(c, 'claude:s1', 'allow', 'approval|tc9'), { ok: false, reason: 'answered' }, 'a newer request');
  assertEquals(codes.check(c, 'claude:s1', 'allow', 'approval|tc1'), { ok: true });
  assertEquals(codes.check(c, 'claude:s1', 'allow', 'approval|tc1'), { ok: false, reason: 'used' });

  const old = codes.issue('claude:s1', 'approval|tc2', ['allow']);
  const fresh = codes.issue('claude:s1', 'approval|tc3', ['allow']);
  assertEquals(codes.check(old, 'claude:s1', 'allow', 'approval|tc2'), { ok: false, reason: 'unknown' }, 'one toast per chat');
  now += 61_000;
  assertEquals(codes.check(fresh, 'claude:s1', 'allow', 'approval|tc3').ok, false);

  // kept as hashes in the data folder, so a click made while AIB was closed is checked after a restart
  const dir = Deno.makeTempDirSync({ prefix: 'aib-toast-codes-' });
  try {
    const file = `${dir}/toast-codes.json`;
    const a = new ToastCodes({ file });
    const code = a.issue('claude:s2', 'asks|5', ['reply']);
    assert(!Deno.readTextFileSync(file).includes(code), 'only hashes on disk');
    const b = new ToastCodes({ file });
    assertEquals(b.check(code, 'claude:s2', 'reply', 'asks|5'), { ok: true });
    assertEquals(new ToastCodes({ file }).check(code, 'claude:s2', 'reply', 'asks|5'), { ok: false, reason: 'used' });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

/** A fake `AIB-keeper toast`: answers register and show as told, records everything, can click and die. */
function fakeHelper(o: { register?: 'ready' | 'error' | 'silent'; show?: 'shown' | 'failed' | 'silent' } = {}) {
  const sent: Json[] = [];
  let spawns = 0;
  let deliver: ((m: Json) => void) | null = null;
  let exit: ((why: string) => void) | null = null;
  const spawn: SpawnToastHelper = (onMessage, onExit) => {
    spawns++;
    deliver = onMessage;
    exit = onExit;
    return {
      send(m) {
        sent.push(m);
        const reply = (x: Json) => queueMicrotask(() => onMessage(x));
        if (m.op === 'register' && (o.register ?? 'ready') !== 'silent') {
          reply(o.register === 'error' ? { op: 'error', error: 'registry: denied' } : { op: 'ready' });
        }
        if (m.op === 'show' && (o.show ?? 'shown') !== 'silent') {
          reply(o.show === 'failed' ? { op: 'failed', id: m.id, error: 'HRESULT 0x803E0115' } : { op: 'shown', id: m.id });
        }
      },
      close() {},
    };
  };
  return {
    spawn,
    sent,
    spawns: () => spawns,
    click: (args: string, inputs: Json = {}) => deliver?.({ op: 'activated', args, inputs }),
    die: () => exit?.('the helper ended (exit 1)'),
  };
}

function fakeBalloon() {
  const shown: string[] = [];
  const route: OsNotify = {
    mechanism: 'windows-balloon',
    show: (title, body) => {
      shown.push(`${title}|${body}`);
      return Promise.resolve({ shown: true, code: 1 });
    },
  };
  return { route, shown };
}

function toastsWith(helper: ReturnType<typeof fakeHelper>, rows: InboxRow[], over: { quiet?: number | null } = {}) {
  const balloon = fakeBalloon();
  const clicks: { args: string; inputs: Record<string, string> }[] = [];
  const codes = new ToastCodes();
  const toasts = new WindowsToasts({
    spawn: helper.spawn,
    register: {
      appId: 'AIB.Test.unit',
      name: 'AIB',
      icon: 'C:\\d\\toast-icon.png',
      clsid: '{6B1F3A52-8C4D-4E7A-9F21-3D5B7C9E0A14}',
      data: 'C:\\d',
      launch: '',
    },
    balloon: balloon.route,
    quietState: () => over.quiet ?? 5,
    codes,
    rowOf: (key) => rows.find((r) => r.key === key) ?? null,
    onActivated: (c) => clicks.push(c),
    timeoutMs: 50,
  });
  return { toasts, balloon, clicks, codes };
}

Deno.test('toast route: shows through the helper, removes answered toasts, hands clicks over', async () => {
  const helper = fakeHelper();
  const rows = [row('approval')];
  const { toasts, balloon, clicks } = toastsWith(helper, rows);
  const r = await toasts.show('Payments', 'shopfront · Run npm install stripe@18.0.0', false, req('claude:s1'));
  assertEquals(r.shown, true);
  assertEquals(helper.sent[0], {
    op: 'register',
    appId: 'AIB.Test.unit',
    name: 'AIB',
    icon: 'C:\\d\\toast-icon.png',
    clsid: '{6B1F3A52-8C4D-4E7A-9F21-3D5B7C9E0A14}',
    data: 'C:\\d',
    launch: '',
  });
  const show = helper.sent[1];
  assertEquals([show.op, show.tag, show.group], ['show', toastTag('claude:s1'), 'aib']);
  assert(String(show.xml).includes('<action content="Allow"'), String(show.xml));
  assertEquals(balloon.shown, [], 'no balloon when the toast was shown');
  await toasts.show('Payments', 'again', false, req('claude:s1'));
  assertEquals(helper.spawns(), 1, 'one helper for all toasts');

  helper.click('act=allow&chat=claude%3As1&n=x', { reply: 'hi' });
  assertEquals(clicks, [{ args: 'act=allow&chat=claude%3As1&n=x', inputs: { reply: 'hi' } }]);

  // still waiting: kept; answered elsewhere (the row is gone): removed from the notification centre
  toasts.seeInbox({ rows });
  assertEquals(helper.sent.filter((m) => m.op === 'remove').length, 0);
  toasts.seeInbox({ rows: [] });
  assertEquals(helper.sent.filter((m) => m.op === 'remove'), [{ op: 'remove', tag: toastTag('claude:s1'), group: 'aib' }]);
  assertEquals(toasts.shown(), []);
  toasts.seeInbox({ rows: [] });
  assertEquals(helper.sent.filter((m) => m.op === 'remove').length, 1, 'removed once');

  // a newer request in the same chat replaces the toast's request: the old toast goes
  await toasts.show('Payments', 'x', false, req('claude:s1'));
  toasts.seeInbox({
    rows: [row('approval', { request: { kind: 'permission', key: 'p9', params: { toolCall: { toolCallId: 'tc9' }, options: ONCE } } })],
  });
  assertEquals(helper.sent.filter((m) => m.op === 'remove').length, 2);
});

Deno.test('toast route: the balloon when the helper fails, nothing in quiet time', async () => {
  for (
    const [name, helper] of [
      ['register refused', fakeHelper({ register: 'error' })],
      ['no answer to register', fakeHelper({ register: 'silent' })],
      ['toast refused', fakeHelper({ show: 'failed' })],
      ['no answer to show', fakeHelper({ show: 'silent' })],
    ] as const
  ) {
    const { toasts, balloon, codes } = toastsWith(helper, [row('approval')]);
    const r = await toasts.show('Payments', 'shopfront · Run npm install', false, req('claude:s1'));
    assertEquals([r.shown, balloon.shown], [true, ['Payments|shopfront · Run npm install']], name);
    assertEquals(codes.size, 0, `${name}: no code outlives a toast that never showed`);
  }
  // a helper that dies after it was ready: that notification and later ones still go out (balloon, then a fresh helper)
  const helper = fakeHelper();
  const { toasts, balloon } = toastsWith(helper, [row('approval')]);
  await toasts.show('A', 'a', false, req('claude:s1'));
  helper.die();
  await toasts.show('B', 'b', false, req('claude:s1'));
  assertEquals(helper.spawns(), 2, 'started again after a crash');
  assertEquals(balloon.shown, []);
  // a helper that can't start at all: balloons
  const broken = toastsWith({
    ...fakeHelper(),
    spawn: () => {
      throw new Error('not found');
    },
  } as ReturnType<typeof fakeHelper>, []);
  assertEquals((await broken.toasts.show('C', 'c', false, req(null))).shown, true);
  assertEquals(broken.balloon.shown, ['C|c']);

  const quiet = toastsWith(fakeHelper(), [row('approval')], { quiet: 4 });
  const r = await quiet.toasts.show('D', 'd', false, req('claude:s1'));
  assertEquals(r, { shown: false, reason: 'Windows is in presentation mode' });
  assertEquals(quiet.balloon.shown, []);
});

function fakeDeps(rows: InboxRow[], codes: ToastCodes) {
  const calls: [string, Json][] = [];
  const opened: (NotifyTarget | null)[] = [];
  const removed: string[] = [];
  const notes: Json[] = [];
  const deps: ToastActDeps = {
    look: () => Promise.resolve({ rows }),
    liveCall: (name, body) => {
      calls.push([name, body]);
      return Promise.resolve([200, { ok: true }]);
    },
    liveState: () => Promise.resolve({ events: [{ kind: 'user', data: { text: 'Fix the totals' } }, { kind: 'update', data: {} }] }),
    continueChat: (key) => {
      calls.push(['continue', { key }]);
      return Promise.resolve([200, {}]);
    },
    sendText: (key, text, tag) => {
      calls.push(['send', { key, text, tag }]);
      return Promise.resolve([200, {}]);
    },
    note: (chatId, requestKey, answer) => notes.push({ chatId, requestKey, ...answer }),
    codes,
    open: (t) => opened.push(t),
    removeToast: (chat) => removed.push(chat),
  };
  return { deps, calls, opened, removed, notes };
}

const sigOf = (r: InboxRow) => `${r.kind}|${(r.request?.params?.toolCall as Json | undefined)?.toolCallId ?? Math.round(r.since)}`;

Deno.test('a click: Allow answers once; forged, risky, answered and expired clicks only open the chat', async () => {
  const ok = row('approval');
  const bad = risky('git push origin main');
  bad.key = 'claude:s2';
  bad.id = 'c2';
  const codes = new ToastCodes();
  const f = fakeDeps([ok, bad], codes);
  const code = codes.issue(ok.key, sigOf(ok), toastActs(ok));
  const click = (args: string, inputs: Record<string, string> = {}) => applyToastClick(f.deps, { args, inputs });

  // forged: another chat's code on the risky request, no code, a made-up code
  assertEquals((await click(`act=allow&chat=claude%3As2&n=${code}`)).done, false);
  assertEquals((await click('act=allow&chat=claude%3As2')).done, false);
  assertEquals((await click('act=allow&chat=claude%3As1&n=made-up')).done, false);
  // even a code issued for the risky chat (as if an older AIB had offered Allow) is refused: the row doesn't get Allow
  const riskyCode = codes.issue(bad.key, sigOf(bad), ['allow']);
  assertEquals(await click(`act=allow&chat=claude%3As2&n=${riskyCode}`), { done: false, act: 'allow', reason: 'not_allowed' });
  assertEquals(f.calls, [], 'nothing was answered');
  assertEquals(f.opened.at(-1), { type: 'inbox', key: 'claude:s2' }, 'its row in the inbox (Review first)');

  assertEquals(await click(`act=allow&chat=claude%3As1&n=${code}`), { done: true, act: 'allow' });
  assertEquals(f.calls, [['permission', { id: 'c1', key: 'p1', option: 'yes' }]], 'allow_once, never Always');
  assertEquals(f.notes, [{ chatId: 'c1', requestKey: 'p1', by: 'pc', name: 'Windows notification', option: 'yes' }]);
  assertEquals(f.removed, ['claude:s1']);
  const before = f.opened.length;
  assertEquals(await click(`act=deny&chat=claude%3As1&n=${code}`), { done: false, act: 'deny', reason: 'used' }, 'once only');
  assertEquals(f.opened.length, before + 1);

  // answered elsewhere: the row is gone, the code is refused and the chat itself opens
  const gone = new ToastCodes();
  const g = fakeDeps([], gone);
  const c2 = gone.issue('claude:s1', sigOf(ok), ['allow', 'deny']);
  assertEquals(await applyToastClick(g.deps, { args: `act=deny&chat=claude%3As1&n=${c2}`, inputs: {} }), {
    done: false,
    act: 'deny',
    reason: 'answered',
  });
  assertEquals(g.opened, [{ type: 'chat', key: 'claude:s1' }]);
  assertEquals(g.calls, []);

  // expired
  let now = 0;
  const old = new ToastCodes({ clock: () => now, ttlMs: 1000 });
  const o = fakeDeps([ok], old);
  const c3 = old.issue(ok.key, sigOf(ok), ['allow']);
  now = 5000;
  assertEquals((await applyToastClick(o.deps, { args: `act=allow&chat=claude%3As1&n=${c3}`, inputs: {} })).reason, 'expired');
  assertEquals(o.calls, []);

  // a body click and Open just open
  assertEquals((await click('act=open&chat=claude%3As1')).reason, 'opened');
  assertEquals((await click('act=inbox')).reason, 'opened');
  assertEquals((await click('act=front')).reason, 'opened');
  assertEquals(f.opened.at(-1), null, 'no target: AIB to the front');
  assertEquals(f.opened.slice(-3, -1), [{ type: 'inbox', key: 'claude:s1' }, { type: 'inbox' }]);
});

Deno.test('a click: Reply, Continue and Retry send; an empty reply opens the chat', async () => {
  const asks = row('asks', { key: 'claude:a', id: 'ca' });
  const stalled = row('stalled', { key: 'claude:b', id: 'cb' });
  const failed = row('failed', { key: 'claude:c', id: 'cc' });
  const codes = new ToastCodes();
  const f = fakeDeps([asks, stalled, failed], codes);
  const issue = (r: InboxRow) => codes.issue(r.key, sigOf(r), toastActs(r));
  let c = issue(asks);
  assertEquals(
    (await applyToastClick(f.deps, { args: `act=reply&chat=claude%3Aa&n=${c}`, inputs: { reply: '  ' } })).reason,
    'empty reply',
  );
  c = issue(asks);
  assertEquals(
    (await applyToastClick(f.deps, { args: `act=reply&chat=claude%3Aa&n=${c}`, inputs: { reply: 'Just make it readable.' } })).done,
    true,
  );
  c = issue(stalled);
  assertEquals((await applyToastClick(f.deps, { args: `act=continue&chat=claude%3Ab&n=${c}`, inputs: {} })).done, true);
  c = issue(failed);
  assertEquals((await applyToastClick(f.deps, { args: `act=retry&chat=claude%3Ac&n=${c}`, inputs: {} })).done, true);
  assertEquals(f.calls, [
    ['send', { key: 'claude:a', text: 'Just make it readable.', tag: 'toast-reply' }],
    ['continue', { key: 'claude:b' }],
    ['send', { key: 'claude:c', text: 'Fix the totals', tag: 'toast-retry' }],
  ]);
  assertEquals(f.removed, ['claude:a', 'claude:b', 'claude:c']);
});

Deno.test('clicks made while AIB was closed: read once from toast-inbox.jsonl', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-toast-inbox-' });
  try {
    assertEquals(takePending(dir), []);
    Deno.writeTextFileSync(
      pendingFile(dir),
      '{"args":"act=allow&chat=claude%3As1&n=x","at":1}\n{torn\n{"args":"act=reply&chat=claude%3As2&n=y","inputs":{"reply":"ok"},"at":2}\n',
    );
    assertEquals(takePending(dir), [
      { args: 'act=allow&chat=claude%3As1&n=x', inputs: {} },
      { args: 'act=reply&chat=claude%3As2&n=y', inputs: { reply: 'ok' } },
    ]);
    assertEquals(takePending(dir), [], 'emptied');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
