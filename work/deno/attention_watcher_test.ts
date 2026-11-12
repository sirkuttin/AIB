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
import { AttentionWatcher, type Fire, Notifier } from '../../outputs/agent-studio/server/attention/watcher.ts';
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
          attention: { state: c.state, needs: c.needs ?? 0, turnEndedAt: c.turnEndedAt ?? null, busySince: null },
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
  assertEquals(desktop, [{ title: 'Chat a', body: 'Needs you', target: { type: 'chat', key: 'claude:a' }, test: false }]);
  assertEquals(pushes, [{ title: 'A chat needs you', body: 'Chat a', tag: 'aib-attention', chat: 'c-a', sheet: true }]);
  // the app's default is Needs you only: a finished turn is no desktop notification, but it is a push (same group)
  now += 10_000;
  await n.fire([turn('b')]);
  assertEquals(desktop.length, 1);
  assertEquals(pushes.at(-1), {
    title: '2 chats are waiting for you',
    body: 'Chat a\nChat b',
    tag: 'aib-attention',
    chat: 'c-a',
    sheet: true,
  });
  // Needs you + Your turn: both kinds, grouped into one replacing notification
  view['studio-notifications-app'] = JSON.stringify({ notifyFor: 'both' });
  now += 10_000;
  await n.fire([turn('c')]);
  assertEquals(desktop.at(-1)!.title, '2 agents are waiting for you');
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
