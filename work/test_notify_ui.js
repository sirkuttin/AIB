const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const dir = path.join(APP_DIR);
const N = require(path.join(dir, 'notify-ui.js'));
const W = require(path.join(dir, 'workspace-state.js'));

const chat = (key, o = {}) => ({
  key,
  title: 'Chat ' + key,
  state: 'idle',
  needs: 0,
  yourTurn: false,
  yourTurnAt: 0,
  eligible: true,
  muted: false,
  selected: false,
  ...o,
});
const kinds = (r) => r.events.map((e) => [e.key, e.kind]);

test('first observation only sets the baseline', () => {
  const list = [chat('a', { state: 'needs_you', needs: 1 }), chat('b', { yourTurn: true, yourTurnAt: 5 })];
  const first = N.detect(null, list);
  assert.deepEqual(first.events, []);
  assert.deepEqual(N.detect(first.next, list).events, []);
});

test('needs-you transitions: entering, a new request, never repeated', () => {
  let { next } = N.detect(null, [chat('a', { state: 'working' })]);
  let r = N.detect(next, [chat('a', { state: 'needs_you', needs: 1 })]);
  assert.deepEqual(kinds(r), [['a', 'needs']]);
  r = N.detect(r.next, [chat('a', { state: 'needs_you', needs: 1 })]);
  assert.deepEqual(r.events, [], 'same transition');
  r = N.detect(r.next, [chat('a', { state: 'needs_you', needs: 2 })]);
  assert.deepEqual(kinds(r), [['a', 'needs']], 'another request while one is pending');
  r = N.detect(r.next, [chat('a', { state: 'working' })]);
  assert.deepEqual(r.events, [], 'answered');
  r = N.detect(r.next, [chat('a', { state: 'needs_you', needs: 1 })]);
  assert.deepEqual(kinds(r), [['a', 'needs']], 'entering again is a new transition');
});

test('your-turn transitions: entering, a newer turn, not repeated, cleared and re-entered', () => {
  let { next } = N.detect(null, [chat('a'), chat('b', { yourTurn: true, yourTurnAt: 5 })]);
  let r = N.detect(next, [chat('a', { yourTurn: true, yourTurnAt: 10 }), chat('b', { yourTurn: true, yourTurnAt: 5 })]);
  assert.deepEqual(kinds(r), [['a', 'turn']]);
  r = N.detect(r.next, [chat('a', { yourTurn: true, yourTurnAt: 10 }), chat('b', { yourTurn: true, yourTurnAt: 5 })]);
  assert.deepEqual(r.events, []);
  r = N.detect(r.next, [chat('a', { yourTurn: true, yourTurnAt: 20 }), chat('b')]);
  assert.deepEqual(kinds(r), [['a', 'turn']], 'a newer turn end');
  r = N.detect(r.next, [chat('a'), chat('b')]);
  assert.deepEqual(r.events, [], 'acting clears it silently');
  r = N.detect(r.next, [chat('a', { yourTurn: true, yourTurnAt: 30 }), chat('b')]);
  assert.deepEqual(kinds(r), [['a', 'turn']]);
});

test('needs-you wins over your-turn, and answering does not replay an old your-turn', () => {
  let { next } = N.detect(null, [chat('a', { yourTurn: true, yourTurnAt: 5 })]);
  let r = N.detect(next, [chat('a', { state: 'needs_you', needs: 1, yourTurn: true, yourTurnAt: 5 })]);
  assert.deepEqual(kinds(r), [['a', 'needs']]);
  r = N.detect(r.next, [chat('a', { yourTurn: true, yourTurnAt: 5 })]);
  assert.deepEqual(r.events, []);
});

test('a chat that appears later: needs you is announced, an old your-turn is not', () => {
  let { next } = N.detect(null, [chat('a')]);
  const r = N.detect(next, [
    chat('a'),
    chat('n', { state: 'needs_you', needs: 1 }),
    chat('t', { yourTurn: true, yourTurnAt: 9 }),
  ]);
  assert.deepEqual(kinds(r), [['n', 'needs']]);
});

test('hidden / worktree / scratch (ineligible), muted and closed chats never notify, and later changes do not replay', () => {
  let { next } = N.detect(null, [chat('h', { eligible: false }), chat('m', { muted: true }), chat('c')]);
  let r = N.detect(next, [
    chat('h', { eligible: false, state: 'needs_you', needs: 1 }),
    chat('m', { muted: true, yourTurn: true, yourTurnAt: 3 }),
    chat('c', { state: 'closed' }),
  ]);
  assert.deepEqual(r.events, []);
  r = N.detect(r.next, [
    chat('h', { state: 'needs_you', needs: 1 }),
    chat('m', { yourTurn: true, yourTurnAt: 3 }),
    chat('c'),
  ]);
  assert.deepEqual(r.events, [], 'unmuting or un-hiding does not announce what was already there');
});

test('decide: in front means no desktop and no sound; toast only for other chats', () => {
  const base = {
    kind: 'needs',
    away: false,
    selected: false,
    eligible: true,
    muted: false,
    notifyFor: 'both',
    soundPref: 'both',
    desktopReady: true,
  };
  assert.deepEqual(N.decide(base), { toast: true, desktop: false, sound: null });
  assert.deepEqual(N.decide({ ...base, selected: true }), { toast: false, desktop: false, sound: null });
});

test('decide: away fires the desktop notification and the sound, also for the selected chat', () => {
  const base = {
    kind: 'needs',
    away: true,
    selected: true,
    eligible: true,
    muted: false,
    notifyFor: 'both',
    soundPref: 'needs',
    desktopReady: true,
  };
  assert.deepEqual(N.decide(base), { toast: false, desktop: true, sound: 'needs' });
  assert.deepEqual(N.decide({ ...base, desktopReady: false }), { toast: false, desktop: false, sound: 'needs' });
  assert.equal(N.decide({ ...base, kind: 'turn' }).sound, null, 'Needs you only: no sound for Your turn');
  assert.equal(N.decide({ ...base, kind: 'turn', soundPref: 'both' }).sound, 'turn');
});

test('decide: mute, ineligible and "Needs you only" silence what they should', () => {
  const base = {
    kind: 'needs',
    away: true,
    selected: false,
    eligible: true,
    muted: false,
    notifyFor: 'both',
    soundPref: 'both',
    desktopReady: true,
  };
  const none = { toast: false, desktop: false, sound: null };
  assert.deepEqual(N.decide({ ...base, muted: true }), none);
  assert.deepEqual(N.decide({ ...base, eligible: false }), none);
  assert.deepEqual(N.decide({ ...base, kind: 'turn', notifyFor: 'needs' }), none);
  assert.equal(N.decide({ ...base, kind: 'needs', notifyFor: 'needs' }).desktop, true);
  assert.equal(N.decide({ ...base, muted: true, away: false }).toast, false);
});

test('sound choice per setting', () => {
  assert.equal(N.soundFor('needs', 'needs'), 'needs');
  assert.equal(N.soundFor('turn', 'needs'), null);
  assert.equal(N.soundFor('turn', 'both'), 'turn');
  assert.equal(N.soundFor('needs', 'both'), 'needs');
  assert.equal(N.soundFor('needs', 'off'), null);
  assert.equal(N.soundFor('turn', 'off'), null);
});

test('prefs: defaults, the old boolean sound setting, junk', () => {
  assert.deepEqual(N.cleanPrefs(null), { desktop: false, sound: 'needs', notifyFor: 'both' });
  assert.equal(N.cleanPrefs({ sound: true }).sound, 'needs');
  assert.equal(N.cleanPrefs({ sound: false }).sound, 'off');
  assert.equal(N.cleanPrefs({ sound: 'both', notifyFor: 'needs', desktop: true }).notifyFor, 'needs');
  assert.equal(N.cleanPrefs({ sound: 'loud', notifyFor: 7 }).sound, 'needs');
});

test('grouping: transitions inside the window coalesce, outside start a new group', () => {
  let r = N.addToGroup(null, [{ key: 'a', kind: 'turn', title: 'A', sound: null }], 1000);
  assert.deepEqual(N.describe(r.group), {
    tag: 'studio-attention',
    title: 'A',
    body: 'Your turn',
    target: { type: 'chat', key: 'a' },
  });
  r = N.addToGroup(r.group, [{ key: 'b', kind: 'needs', title: 'B', sound: 'needs' }], 20000);
  let d = N.describe(r.group);
  assert.equal(d.title, '2 agents are waiting for you');
  assert.equal(d.body, 'A\nB');
  assert.deepEqual(d.target, { type: 'inbox' });
  assert.equal(d.tag, 'studio-attention', 'a stable tag replaces the older notification');
  r = N.addToGroup(
    r.group,
    [
      { key: 'c', kind: 'turn', title: 'C' },
      { key: 'd', kind: 'turn', title: 'D' },
    ],
    59000,
  );
  d = N.describe(r.group);
  assert.equal(d.title, '4 agents are waiting for you');
  assert.equal(d.body, 'A\nB\nC\nand 1 more');
  const later = N.addToGroup(r.group, [{ key: 'e', kind: 'needs', title: 'E' }], 1000 + N.GROUP_MS + 1);
  assert.deepEqual(
    later.group.entries.map((x) => x.key),
    ['e'],
  );
  assert.equal(N.describe(later.group).title, 'E');
});

test('grouping: the same chat is listed once and needs-you wins; a sound plays once per level', () => {
  let r = N.addToGroup(null, [{ key: 'a', kind: 'turn', title: 'A', sound: 'turn' }], 0);
  assert.equal(r.sound, 'turn');
  r = N.addToGroup(r.group, [{ key: 'a', kind: 'needs', title: 'A2', sound: 'needs' }], 5000);
  assert.equal(r.sound, 'needs', 'a louder kind chimes');
  assert.deepEqual(r.group.entries, [{ key: 'a', title: 'A2', kind: 'needs' }]);
  r = N.addToGroup(
    r.group,
    [
      { key: 'b', kind: 'turn', title: 'B', sound: 'turn' },
      { key: 'c', kind: 'needs', title: 'C', sound: 'needs' },
    ],
    6000,
  );
  assert.equal(r.sound, null, 'already chimed at this level in this group');
});

test('project prefs carry muted only when set', () => {
  let p = W.setPref(W.emptyPrefs(), 'k', { muted: true });
  assert.deepEqual(p.projects.k, { name: '', color: '', hidden: false, muted: true });
  assert.equal(W.prefOf(p, 'k').muted, true);
  assert.equal(W.sanitizePrefs(JSON.parse(JSON.stringify(p))).projects.k.muted, true);
  assert.equal(W.sanitizePrefs({ projects: { k: { muted: 'yes' } } }).projects.k, undefined);
  p = W.setPref(p, 'k', { name: 'Mine' });
  assert.equal(p.projects.k.muted, true, 'other changes keep it');
  p = W.setPref(W.setPref(p, 'k', { muted: false }), 'k', { name: '' });
  assert.equal(p.projects.k, undefined);
  p = W.setPref(W.emptyPrefs(), 'k', { color: 'blue' });
  assert.deepEqual(p.projects.k, { name: '', color: 'blue', hidden: false }, 'unmuted projects look exactly as before');
  const out = W.applyPrefs([{ key: 'k', name: 'K' }], W.setPref(W.emptyPrefs(), 'k', { muted: true }));
  assert.equal(out[0].muted, true);
});

test('observeItems wires transitions, away state, mute and grouping (stubbed browser)', () => {
  const shown = [];
  const S = N._state;
  const realDoc = globalThis.document,
    realNotif = globalThis.Notification;
  let focused = false;
  globalThis.document = {
    hidden: false,
    visibilityState: 'visible',
    hasFocus: () => focused,
    createElement: () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} }),
    body: { append() {} },
  };
  globalThis.Notification = class {
    constructor(title, o) {
      this.title = title;
      this.o = o;
      shown.push(this);
    }
    close() {}
  };
  globalThis.Notification.permission = 'granted';
  try {
    S.prefs = N.cleanPrefs({ desktop: true, sound: 'off', notifyFor: 'both' });
    S.prev = null;
    S.group = null;
    S.host = { openChat() {}, openInbox() {} };
    N.observeItems([chat('a'), chat('b'), chat('c', { muted: true })], 0);
    focused = true; // in front, looking at a: nothing
    N.observeItems(
      [chat('a', { selected: true, state: 'needs_you', needs: 1 }), chat('b'), chat('c', { muted: true })],
      1000,
    );
    assert.equal(shown.length, 0, 'focused: no desktop notification');
    focused = false; // away: one turn (plus a muted one that stays silent)
    N.observeItems(
      [
        chat('a', { selected: true, state: 'needs_you', needs: 1 }),
        chat('b', { yourTurn: true, yourTurnAt: 7 }),
        chat('c', { muted: true, yourTurn: true, yourTurnAt: 8 }),
      ],
      2000,
    );
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, 'Chat b');
    assert.equal(shown[0].o.tag, 'studio-attention');
    N.observeItems(
      [
        chat('a', { selected: true, yourTurn: true, yourTurnAt: 9 }),
        chat('b', { yourTurn: true, yourTurnAt: 7 }),
        chat('c', { muted: true }),
      ],
      9000,
    );
    assert.equal(shown.length, 2);
    assert.equal(shown[1].title, '2 agents are waiting for you');
    assert.equal(shown[1].o.body, 'Chat b\nChat a');
    assert.equal(shown[1].o.tag, shown[0].o.tag);
  } finally {
    if (realDoc === undefined) delete globalThis.document;
    else globalThis.document = realDoc;
    if (realNotif === undefined) delete globalThis.Notification;
    else globalThis.Notification = realNotif;
  }
});
