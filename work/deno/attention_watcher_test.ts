/**
 * The AttentionWatcher's decisions against a fake agent host (attention/watcher.ts), and where the news goes (Notifier):
 *   - one announcement per question / approval (chat + request key), however often it is looked at;
 *   - a new watcher on the same state folder (an AIB restart, a keeper take-over) announces nothing already announced, while a
 *     request that came while it was not running is announced once;
 *   - "finished" once per turn end; not while the queue sends its next message, not while helpers or a background shell run (then
 *     once they are done); a turn that ended before this watcher's file existed is not news;
 *   - nothing for archived, deleted, hidden, muted, scratch or worktree chats, and unmuting does not replay;
 *   - desktop: only while no AIB window has focus, per the app's choices, grouped for 60 s; pushes: never while the owner is
 *     active at the PC.
 * The same decisions through the real agent hosts (in-process, keeper, split) are in attention_modes_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { AttentionWatcher, type Fire, Notifier, requestText, SETTLE_MS } from '../../outputs/agent-studio/server/attention/watcher.ts';
import { Presence } from '../../outputs/agent-studio/server/attention/presence.ts';
import { RULES } from '../../outputs/agent-studio/server/attention/rules.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

interface Chat {
  id: string;
  sessionId: string;
  cwd: string;
  state: string;
  needs?: number;
  turnEndedAt?: string | null;
  permissions?: string[];
  elicitations?: string[];
  queue?: { items: unknown[]; paused: boolean };
  busy?: 'helpers' | 'background';
  /** More attention facts (the inbox's: helpers, shells, followUntil, failedAt, asksAt ...). */
  facts?: Json;
}

function lab(options: { marks?: Json; prefs?: Json; view?: Record<string, string> } = {}) {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-attention-' }));
  const chats: Chat[] = [];
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const host = {
    liveList: () =>
      Promise.resolve({
        instanceId: 'test',
        connections: chats.map((c) => ({
          id: c.id,
          provider: 'claude',
          sessionId: c.sessionId,
          cwd: c.cwd,
          projectRoot: c.cwd,
          closed: false,
          cursor: 3,
          attention: { state: c.state, needs: c.needs ?? 0, turnEndedAt: c.turnEndedAt ?? null, busySince: null, ...c.facts },
          elicitations: (c.elicitations ?? []).map((key) => ({ key, params: { message: 'Q' } })),
          queue: c.queue ?? { items: [], paused: false },
          breadth: { sessionInfo: { title: 'Chat ' + c.id } },
        })),
      }),
    liveState: (id: string) => {
      const c = chats.find((x) => x.id === id);
      // the events that announced the requests (the watcher names a request by its event: number and time)
      const events = (c?.permissions ?? []).map((key, i) => ({ seq: 10 + i, time: 1700000000 + i, kind: 'permission', data: { key } }));
      return Promise.resolve(c ? { id, permissions: (c.permissions ?? []).map((key) => ({ key, params: {} })), events } : null);
    },
    busyConnections: () => Promise.resolve(chats.filter((c) => c.busy).map((c) => ({ id: c.id, state: c.busy }))),
  };
  const fired: Fire[][] = [];
  const sources = {
    host: host as never,
    conversations: { public: () => ({ entries: options.marks ?? {} }) } as never,
    projectPrefs: { public: () => options.prefs ?? { projects: {} } } as never,
    viewPrefs: { public: () => ({ prefs: options.view ?? {} }) } as never,
  };
  const make = () =>
    new AttentionWatcher(sources, {
      stateDir: dir,
      clock: () => clock,
      settleMs: 1000, // "finished" once a chat stayed done this long (2 looks here)
      kinds: (path) => ({ worktree: /[\\/]\.git[\\/]worktrees[\\/]/.test(path), scratch: /scratch-/.test(path) }),
      onFire: (f) => void fired.push(f),
    });
  return {
    dir,
    chats,
    fired,
    make,
    tick(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
    iso(offsetMs = 0) {
      return new Date(Math.floor((clock + offsetMs) / 1000) * 1000).toISOString().slice(0, 19) + 'Z';
    },
    flat: () => fired.flat().map((f) => `${f.kind} ${f.key}`),
    close: () => Deno.removeSync(dir, { recursive: true }),
  };
}

Deno.test('watcher: one "needs you" per request; a restart announces nothing again; a request that came while down, once', async () => {
  const t = lab();
  try {
    const w = t.make();
    t.chats.push({ id: 'c1', sessionId: 's1', cwd: 'C:\\code\\shop', state: 'working' });
    await w.poll();
    assertEquals(t.flat(), []);
    Object.assign(t.chats[0], { state: 'needs_you', needs: 1, permissions: ['p1'] });
    await w.poll();
    await w.poll();
    await w.poll();
    assertEquals(t.flat(), ['needs claude:s1']);
    assertEquals(t.fired[0][0].title, 'Chat c1');
    assertEquals(t.fired[0][0].chat, 'c1');
    // a second request while the first still waits: news again (the chat + its key)
    Object.assign(t.chats[0], { needs: 2, permissions: ['p1'], elicitations: ['q1'] });
    await w.poll();
    assertEquals(t.flat(), ['needs claude:s1', 'needs claude:s1']);
    // AIB restarts (a new watcher, the same state folder): the waiting requests were already announced
    await w.stop();
    const w2 = t.make();
    await w2.poll();
    await w2.poll();
    assertEquals(t.fired.length, 2, 'nothing again after a restart');
    // AIB is down while a third request comes: the next watcher announces it once
    await w2.stop();
    Object.assign(t.chats[0], { needs: 3, permissions: ['p1', 'p2'], elicitations: ['q1'] });
    const w3 = t.make();
    await w3.poll();
    await w3.poll();
    assertEquals(t.flat(), ['needs claude:s1', 'needs claude:s1', 'needs claude:s1']);
    await w3.stop();
  } finally {
    t.close();
  }
});

Deno.test('watcher (inbox): a failed turn is news once, like a request; Mark handled before it does not hide it, after it does', async () => {
  const t = lab({ marks: { 'claude:s2': { handledAt: Date.parse('2026-11-12T10:00:30Z') / 1000 } } });
  try {
    const w = t.make();
    t.chats.push({ id: 'c1', sessionId: 's1', cwd: 'C:\\code\\shop', state: 'working' });
    t.chats.push({ id: 'c2', sessionId: 's2', cwd: 'C:\\code\\shop', state: 'working' });
    await w.poll();
    t.tick(5000);
    const failedAt = new Date(t.now).toISOString();
    Object.assign(t.chats[0], { state: 'idle', facts: { failedAt, error: 'You have hit your session limit', failKind: 'limit' } });
    // c2 failed before its Mark handled (30 s in): already handled, no news
    Object.assign(t.chats[1], { state: 'idle', facts: { failedAt } });
    await w.poll();
    await w.poll();
    assertEquals(t.flat(), ['needs claude:s1'], 'at once (no settle), once');
    assertEquals(t.fired[0][0].reason, 'failed');
    // a restart: not again
    await w.stop();
    const w2 = t.make();
    await w2.poll();
    assertEquals(t.fired.length, 1);
    await w2.stop();
  } finally {
    t.close();
  }
});

Deno.test('watcher (inbox): a reply that asks you something is "needs you" once it stayed open; its turn is never "finished"', async () => {
  const t = lab();
  try {
    const w = t.make();
    t.chats.push({ id: 'c1', sessionId: 's1', cwd: 'C:\\code\\shop', state: 'working' });
    await w.poll();
    t.tick(3000);
    const asksAt = new Date(t.now).toISOString();
    Object.assign(t.chats[0], { state: 'idle', turnEndedAt: t.iso(), facts: { asksAt, question: 'Should I start?' } });
    await w.poll();
    assertEquals(t.flat(), [], 'not before it stayed open (settle)');
    t.tick(1000);
    await w.poll();
    assertEquals(t.flat(), ['needs claude:s1']);
    assertEquals(t.fired[0][0].reason, 'asks');
    // Mark handled clears the question: the chat is your turn now, but its turn's news already went out as the question
    w.sources.conversations.public = () => ({
      revision: '',
      warning: '',
      entries: { 'claude:s1': { handledAt: t.now / 1000 + 1 } as never },
    });
    t.tick(2000);
    await w.poll();
    t.tick(2000);
    await w.poll();
    assertEquals(t.flat(), ['needs claude:s1'], 'no "finished" for the same turn');
    await w.stop();
  } finally {
    t.close();
  }
});

Deno.test('watcher (inbox): helpers, shells and the follow-up window keep a chat working; "finished" only after them', async () => {
  const t = lab();
  try {
    const w = t.make();
    assertEquals(SETTLE_MS, 20_000, "the settle covers the agent's own follow-up (usage study: 100% within 20 s in AIB)");
    t.chats.push({ id: 'c1', sessionId: 's1', cwd: 'C:\\code\\shop', state: 'working' });
    await w.poll();
    Object.assign(t.chats[0], { state: 'idle', turnEndedAt: t.iso(), facts: { helpers: 2, shells: false, followUntil: null } });
    for (let i = 0; i < 3; i++) {
      t.tick(2000);
      await w.poll();
    }
    assertEquals(t.flat(), [], 'two helpers running');
    Object.assign(t.chats[0], { facts: { helpers: 0, shells: true, followUntil: null } });
    t.tick(2000);
    await w.poll();
    t.tick(2000);
    await w.poll();
    assertEquals(t.flat(), [], 'a background shell running');
    Object.assign(t.chats[0], { facts: { helpers: 0, shells: false, followUntil: new Date(t.now + 10_000).toISOString() } });
    t.tick(2000);
    await w.poll();
    t.tick(2000);
    await w.poll();
    assertEquals(t.flat(), [], 'the follow-up window is open');
    t.tick(10_000);
    await w.poll();
    t.tick(2000);
    await w.poll();
    assertEquals(t.flat(), ['turn claude:s1']);
    assertEquals(t.fired[0][0].reason, 'finished');
    await w.stop();
  } finally {
    t.close();
  }
});

Deno.test('watcher: "finished" once per turn; not while the queue goes on, helpers or a background shell run; old turns are not news', async () => {
  const t = lab();
  try {
    t.chats.push({ id: 'old', sessionId: 'old', cwd: '/code/a', state: 'idle', turnEndedAt: t.iso(-3600_000) });
    const w = t.make();
    await w.poll();
    assertEquals(t.flat(), [], 'a turn that ended before the watcher existed');
    t.tick(5000);
    t.chats.push({ id: 'c1', sessionId: 's1', cwd: '/code/a', state: 'working' });
    await w.poll();
    // the turn ends but the queue sends the next message: not the end of the work
    Object.assign(t.chats[1], { state: 'idle', turnEndedAt: t.iso(), queue: { items: [{ id: 'q' }], paused: false } });
    await w.poll();
    Object.assign(t.chats[1], { state: 'working', queue: { items: [], paused: false } });
    await w.poll();
    assertEquals(t.flat(), []);
    t.tick(3000);
    Object.assign(t.chats[1], { state: 'idle', turnEndedAt: t.iso() });
    await w.poll();
    assertEquals(t.flat(), [], 'done for a moment only: not yet');
    t.tick(1000);
    await w.poll();
    await w.poll();
    assertEquals(t.flat(), ['turn claude:s1'], 'once, for the last turn');
    // a paused queue (Stop): the turn is the end; it is announced
    t.tick(3000);
    Object.assign(t.chats[1], { state: 'idle', turnEndedAt: t.iso(), queue: { items: [{ id: 'q' }], paused: true } });
    await w.poll();
    t.tick(1000);
    await w.poll();
    assertEquals(t.flat().length, 2);
    // helpers still run: not finished until they are done; then once
    t.tick(3000);
    Object.assign(t.chats[1], { turnEndedAt: t.iso(), queue: { items: [], paused: false }, busy: 'helpers' });
    await w.poll();
    await w.poll();
    assertEquals(t.flat().length, 2, 'helpers still run');
    t.chats[1].busy = 'background';
    await w.poll();
    assertEquals(t.flat().length, 2, 'a background shell still runs');
    // the helper ended: Claude Code's own short follow-up comes right after (idle for a moment in between): one announcement
    delete t.chats[1].busy;
    await w.poll();
    Object.assign(t.chats[1], { state: 'working' });
    t.tick(500);
    await w.poll();
    t.tick(1500);
    Object.assign(t.chats[1], { state: 'idle', turnEndedAt: t.iso() });
    await w.poll();
    t.tick(1000);
    await w.poll();
    await w.poll();
    assertEquals(t.flat().length, 3, 'done now: once');
    await w.stop();
    // a restart: the finished turns are not announced again
    const w2 = t.make();
    await w2.poll();
    assertEquals(t.flat().length, 3);
    await w2.stop();
  } finally {
    t.close();
  }
});

Deno.test('watcher: nothing for archived, deleted, hidden, muted, scratch or worktree chats; held chats get no "finished"; unmuting does not replay', async () => {
  const key = (p: string) => RULES.pathKey(p);
  const prefs = {
    projects: { [key('/code/quiet')]: { hidden: false, muted: true }, [key('/code/hidden')]: { hidden: true } } as Json,
  };
  const t = lab({
    marks: { 'claude:arch': { archivedAt: 1 }, 'claude:del': { deletedAt: 1 }, 'claude:held': { holdAt: 1 } },
    prefs,
  });
  try {
    const w = t.make();
    await w.poll();
    t.tick(2000);
    const needs = { state: 'needs_you', needs: 1, permissions: ['p'] };
    t.chats.push(
      { id: 'a', sessionId: 'arch', cwd: '/code/a', ...needs },
      { id: 'd', sessionId: 'del', cwd: '/code/a', ...needs },
      { id: 'm', sessionId: 'muted', cwd: '/code/quiet', ...needs },
      { id: 'h', sessionId: 'hidden', cwd: '/code/hidden', ...needs },
      { id: 's', sessionId: 'scratch', cwd: '/tmp/scratch-77', ...needs },
      { id: 'w', sessionId: 'wt', cwd: '/code/a/.git/worktrees/x', ...needs },
      { id: 'H', sessionId: 'held', cwd: '/code/a', state: 'idle', turnEndedAt: t.iso() },
    );
    await w.poll();
    assertEquals(t.flat(), []);
    // unmuting the project later does not announce the old request
    (prefs.projects[key('/code/quiet')] as Json).muted = false;
    await w.poll();
    assertEquals(t.flat(), []);
    // a held chat's question still notifies (as on the page)
    Object.assign(t.chats[6], { state: 'needs_you', needs: 1, permissions: ['hp'] });
    await w.poll();
    assertEquals(t.flat(), ['needs claude:held']);
    await w.stop();
  } finally {
    t.close();
  }
});

Deno.test('notifier: desktop only while no AIB window has focus and per the app choices, grouped for 60 s; no push while active at the PC', async () => {
  let now = 1_000_000;
  const presence = new Presence(() => now);
  const view: Record<string, string> = {};
  const desktop: Json[] = [];
  const pushes: Json[] = [];
  let pushOn = true;
  let desktopOn = true;
  const n = new Notifier({
    desktop: () => (desktopOn ? (req) => (desktop.push(req), Promise.resolve({ shown: true })) : null),
    push: () => (pushOn ? (text) => (pushes.push(text), Promise.resolve()) : null),
    presence,
    viewPrefs: { public: () => ({ prefs: view }) } as never,
    clock: () => now,
  });
  const needs = (k: string): Fire => ({ key: 'claude:' + k, chat: 'c-' + k, kind: 'needs', title: 'Chat ' + k });
  const turn = (k: string): Fire => ({ key: 'claude:' + k, chat: 'c-' + k, kind: 'turn', title: 'Chat ' + k });

  await n.fire([needs('a')]);
  assertEquals(desktop, [{
    title: 'Chat a',
    body: 'Needs your approval',
    target: { type: 'inbox', key: 'claude:a' },
    test: false,
    silent: false,
  }]);
  assertEquals(pushes, [{ title: 'A chat needs you', body: 'Chat a', tag: 'aib-attention', chat: 'c-a', sheet: true, silent: false, key: 'claude:a' }]); // one chat: its row key (the phone's buttons)
  // a saved "Needs you only": a finished turn is no desktop notification, but it is a push (same group)
  view['studio-notifications-app'] = JSON.stringify({ desktop: true, sound: 'needs', notifyFor: 'needs' });
  now += 10_000;
  await n.fire([turn('b')]);
  assertEquals(desktop.length, 1);
  assertEquals(pushes.at(-1), {
    title: '2 chats are waiting for you',
    body: 'Chat a\nChat b',
    tag: 'aib-attention',
    chat: 'c-a',
    sheet: true,
    silent: false,
  });
  // Needs you + Finished: both kinds, grouped into one replacing notification
  view['studio-notifications-app'] = JSON.stringify({ notifyFor: 'both' });
  now += 10_000;
  await n.fire([turn('c')]);
  assertEquals(desktop.at(-1)!.title, '1 needs you \u00b7 1 to review', 'the kinds are named, never one waiting count');
  // an AIB window has focus: no desktop notification; still a push (not typing for 2 minutes)
  now += 70_000;
  presence.report(true, 300_000);
  await n.fire([needs('d')]);
  assertEquals(desktop.length, 2);
  assertEquals(pushes.at(-1)!.title, 'A chat needs you', 'a new group after 60 s');
  // active at the PC (focus and input in the last 2 minutes): no push either
  presence.report(true, 1_000);
  await n.fire([needs('e')]);
  assertEquals([desktop.length, pushes.length], [2, 4]);
  // the page stopped reporting (window closed): neither focused nor active after 45 s
  now += 46_000;
  assert(!presence.focused() && !presence.active());
  await n.fire([needs('f')]);
  assertEquals([desktop.length, pushes.length], [3, 5]);
  // desktop notifications off in the app; no phone to push to
  view['studio-notifications-app'] = JSON.stringify({ desktop: false });
  pushOn = false;
  now += 70_000;
  await n.fire([needs('g')]);
  assertEquals([desktop.length, pushes.length], [3, 5]);
  desktopOn = false; // a server run: no desktop notifications at all
  await n.fire([needs('h')]);
  assertEquals(desktop.length, 3);
});

Deno.test('presence: a report of focus counts for 45 s; active means input in the last 2 minutes', () => {
  let now = 0;
  const p = new Presence(() => now);
  assertEquals([p.focused(), p.active()], [false, false]);
  p.report(true, 0);
  assertEquals([p.focused(), p.active()], [true, true]);
  now = 121_000 - 1;
  p.report(true, 121_000 - 1); // no input since the start
  assertEquals([p.focused(), p.active()], [true, false]);
  p.report(false, 0);
  assertEquals([p.focused(), p.active()], [false, false]);
  p.report(true, 'x');
  now += 45_000;
  assertEquals(p.focused(), false, 'stale');
});

Deno.test('fired store: kept in the state folder, written 0600 where the OS has modes', async () => {
  const t = lab();
  try {
    const w = t.make();
    t.chats.push({ id: 'c', sessionId: 's', cwd: '/x', state: 'needs_you', needs: 1, permissions: ['k'] });
    await w.poll();
    const file = JSON.parse(Deno.readTextFileSync(`${t.dir}${SEP}attention-fired.json`));
    assertEquals(Object.keys(file.fired), ['needs|claude:s|p:10@1700000000']);
    if (Deno.build.os !== 'windows') assertEquals(Deno.statSync(`${t.dir}${SEP}attention-fired.json`).mode! & 0o777, 0o600);
    await w.stop();
  } finally {
    t.close();
  }
});

Deno.test('notifier + presence: a chat on a phone screen gets no desktop notification or push and is marked read; a phone in hand gets banners, not pushes', async () => {
  let now = 5_000_000;
  const presence = new Presence(() => now);
  const desktop: Json[] = [];
  const pushes: Json[] = [];
  const read: string[] = [];
  const n = new Notifier({
    desktop: () => (req) => (desktop.push(req), Promise.resolve({ shown: true })),
    push: () => (text) => (pushes.push(text), Promise.resolve()),
    presence,
    viewPrefs: { public: () => ({ prefs: { 'studio-notifications-app': JSON.stringify({ notifyFor: 'both' }) } }) } as never,
    markRead: (key) => void read.push(key),
    clock: () => now,
  });
  const fire = (kind: 'needs' | 'turn', k: string): Fire => ({ key: 'claude:' + k, chat: 'c-' + k, kind, title: 'Chat ' + k });
  // the phone shows chat x: x finishes -> nothing anywhere, x read on the PC
  presence.seePhone('ph1', 'c-x');
  await n.fire([fire('turn', 'x')]);
  assertEquals([desktop.length, pushes.length, read], [0, 0, ['claude:x']]);
  // x needs you while on screen: no push, no desktop, not "read"
  await n.fire([fire('needs', 'x')]);
  assertEquals([desktop.length, pushes.length, read.length], [0, 0, 1]);
  // another chat y needs you: a banner on the phone, no push; the PC (not focused) still gets its desktop notification
  await n.fire([fire('needs', 'y')]);
  assertEquals([desktop.length, pushes.length], [1, 0]);
  assertEquals(desktop[0].title, 'Chat y');
  const notices = presence.takeNotices('ph1');
  assertEquals(notices.map((a) => `${a.kind} ${a.chat}`), ['turn c-x', 'needs c-x', 'needs c-y']);
  assertEquals(presence.takeNotices('ph1'), [], 'delivered once');
  // the record of what was held back while the phone was in hand
  const record = presence.suppressed('ph1').map((h) => [h.chat, h.onScreen, h.delivered]);
  assertEquals(record, [['c-x', true, true], ['c-x', true, true], ['c-y', false, true]]);
  // phone on home: a finished chat -> banner, no push
  now += 5_000;
  presence.seePhone('ph1', null);
  await n.fire([fire('turn', 'z')]);
  assertEquals([desktop.length, pushes.length], [2, 0]);
  // the phone is put away before its next poll: the banner it never got goes out as a push when its time on screen ends
  const ended: Json[] = [];
  presence.onPhoneEnded((e) => void ended.push(e as unknown as Json));
  now += 15_000; // no poll for PHONE_TTL_MS
  presence.sweep();
  await n.settled();
  assertEquals(ended.length, 1);
  assertEquals(ended[0].why, 'expired');
  assertEquals((ended[0].held as Json[]).map((h) => h.chat), ['c-x', 'c-x', 'c-y', 'c-z']);
  assertEquals(pushes, [{ title: 'Chat finished', body: 'Chat z', tag: 'aib-attention', chat: 'c-z', sheet: false, silent: true, key: 'claude:z' }]);
  assertEquals(desktop.length, 2, 'the desktop already showed z');
  // nobody looking now: as before
  now += 70_000;
  await n.fire([fire('needs', 'w')]);
  assertEquals([desktop.length, pushes.length], [3, 2]);
  // a phone whose page was hidden says so (left): a chat it showed is no longer "on screen"
  presence.seePhone('ph1', 'c-v');
  presence.leavePhone('ph1');
  now += 70_000;
  await n.fire([fire('turn', 'v')]);
  assertEquals([desktop.length, pushes.length], [4, 3]);
  // a desktop notification held back because the phone showed the chat, never delivered: shown when the phone's time ends
  now += 70_000;
  presence.seePhone('ph1', 'c-u');
  await n.fire([fire('needs', 'u')]);
  assertEquals([desktop.length, pushes.length], [4, 3]);
  presence.leavePhone('ph1');
  await n.settled();
  assertEquals([desktop.length, pushes.length], [5, 4]);
  assertEquals(desktop.at(-1)!.title, 'Chat u');
  n.close();
});

Deno.test('presence: a phone counts while it polls (15 s), ends on "left" or silence, once', () => {
  let now = 0;
  const p = new Presence(() => now);
  const ended: string[] = [];
  const off = p.onPhoneEnded((e) => void ended.push(`${e.device} ${e.why}`));
  p.seePhone('a', 'c1');
  p.seePhone('b', null);
  assertEquals(p.phones().map((x) => [x.device, x.chat]), [['a', 'c1'], ['b', null]]);
  assert(p.phoneShows('c1') && !p.phoneShows('c2'));
  now = 10_000;
  p.seePhone('a', 'c2'); // polled again, another chat
  now = 15_000;
  assertEquals(p.phones().map((x) => [x.device, x.chat]), [['a', 'c2']], 'b stopped polling 15 s ago');
  p.leavePhone('a');
  p.leavePhone('a');
  assertEquals(p.phones(), []);
  assertEquals(ended, ['b expired', 'a left']);
  off();
  p.seePhone('a', null);
  p.leavePhone('a');
  assertEquals(ended.length, 2, 'unsubscribed');
});

Deno.test('watcher: blocked() lists the chats blocked on you with title and reason, for the tray menu (inbox 1b)', async () => {
  const t = lab({ marks: { 'claude:s4': { archivedAt: 5 } } });
  try {
    const w = t.make();
    assertEquals(w.blocked(), [], 'nothing before the first look');
    t.chats.push({ id: 'c1', sessionId: 's1', cwd: 'C:\code\shop', state: 'needs_you', needs: 1, permissions: ['p1'] });
    t.chats.push({ id: 'c2', sessionId: 's2', cwd: 'C:\code\shop', state: 'needs_you', needs: 1, elicitations: ['q1'] });
    t.chats.push({ id: 'c3', sessionId: 's3', cwd: 'C:\code\shop', state: 'idle', facts: { failedAt: t.iso() } });
    t.chats.push({ id: 'c4', sessionId: 's4', cwd: 'C:\code\shop', state: 'needs_you', needs: 1, permissions: ['p4'] }); // archived
    t.chats.push({ id: 'c5', sessionId: 's5', cwd: 'C:\code\shop', state: 'working' });
    await w.poll();
    assertEquals(w.blocked(), [
      { key: 'claude:s1', chat: 'c1', title: 'Chat c1', reason: 'approval' },
      { key: 'claude:s2', chat: 'c2', title: 'Chat c2', reason: 'question' },
      { key: 'claude:s3', chat: 'c3', title: 'Chat c3', reason: 'failed' },
    ]);
    Object.assign(t.chats[0], { state: 'idle', needs: 0, permissions: [] });
    await w.poll();
    assertEquals(w.blocked().map((b) => b.key), ['claude:s2', 'claude:s3'], 'answered: off the list at the next look');
    await w.stop();
  } finally {
    t.close();
  }
});

Deno.test('notifier + presence: the chat open in the AIB window gets no desktop notification, even unfocused; the phone push still goes', async () => {
  let now = 5_000_000;
  const presence = new Presence(() => now);
  const desktop: Json[] = [];
  const pushes: Json[] = [];
  const n = new Notifier({
    desktop: () => (req) => (desktop.push(req), Promise.resolve({ shown: true })),
    push: () => (text) => (pushes.push(text), Promise.resolve()),
    presence,
    viewPrefs: { public: () => ({ prefs: {} }) } as never,
    clock: () => now,
  });
  const asks = (k: string): Fire => ({ key: 'claude:' + k, chat: 'c-' + k, kind: 'needs', title: 'Chat ' + k, reason: 'asks' });
  // the window shows chat a but has no focus; the owner last typed 10 minutes ago (away from the PC)
  presence.report(false, 600_000, ['claude:a']);
  assertEquals(presence.openOnPc(), ['claude:a']);
  assert(!presence.focused() && !presence.active());
  await n.fire([asks('a')]);
  assertEquals(desktop, [], 'no desktop notification: chat a is open in the window');
  assertEquals(pushes.length, 1, 'the phone still gets its push (the owner is not at the PC)');
  assertEquals(pushes[0].body, 'Chat a');
  // another chat: the desktop notification goes as usual
  now += 70_000;
  presence.report(false, 670_000, ['claude:a']);
  await n.fire([asks('b')]);
  assertEquals(desktop.map((d) => d.target), [{ type: 'inbox', key: 'claude:b' }]);
  // switched to chat b: chat a is desktop news again
  now += 70_000;
  presence.report(false, 740_000, ['claude:b']);
  await n.fire([asks('a')]);
  assertEquals(desktop.map((d) => d.target), [{ type: 'inbox', key: 'claude:b' }, { type: 'inbox', key: 'claude:a' }]);
  // the window was minimized or closed (the page reports nothing open), or stopped reporting: nothing is open
  presence.report(false, 0, []);
  assertEquals(presence.openOnPc(), []);
  presence.report(false, 0, ['claude:a', 7, '', 'x'.repeat(500)]);
  assertEquals(presence.openOnPc(), ['claude:a'], 'only page keys');
  now += 45_000;
  assertEquals(presence.openOnPc(), [], 'stale after 45 s');
});

Deno.test('watcher: the desktop notification names the request and the project, never on a push (inbox v3)', async () => {
  assertEquals(requestText({ params: { toolCall: { title: 'Bash', rawInput: { command: 'npm  install\nstripe' } } } }, null), 'Run npm install stripe');
  assertEquals(requestText({ params: { toolCall: { title: 'Edit src/cart.ts' } } }, null), 'Edit src/cart.ts');
  assertEquals(requestText(null, { params: { message: 'Which plan?' } }), 'Which plan?');
  assertEquals(requestText(null, null), '');
  const presence = new Presence();
  const desktop: Json[] = [];
  const pushes: Json[] = [];
  const n = new Notifier({
    desktop: () => (req) => (desktop.push(req), Promise.resolve({ shown: true })),
    push: () => (text) => (pushes.push(text), Promise.resolve()),
    presence,
    viewPrefs: { public: () => ({ prefs: {} }) } as never,
    clock: () => 1000,
  });
  await n.fire([{ key: 'claude:a', chat: 'c-a', kind: 'needs', title: 'Checkout', reason: 'approval', project: 'shopfront', what: 'Run npm install stripe@18.0.0' }]);
  assertEquals(desktop[0].body, 'shopfront · Run npm install stripe@18.0.0');
  assertEquals(desktop[0].target, { type: 'inbox', key: 'claude:a' });
  assertEquals(pushes[0].body, 'Checkout', 'a push says the title only');
  assert(!JSON.stringify(pushes).includes('stripe'));
  n.close();
});
