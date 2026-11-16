/**
 * Remote control from other PCs, phase 2 (design v2 section 8; review MF12 and should-fix "new presence rule"):
 *   - a paired computer's presence slots: the server builds the id from the device (r-<device>-<n>), never from the page; at most
 *     DEVICE_SLOTS per device; when the slots are full a computer's slot goes before any of the PC's own windows; a computer's slots
 *     never count for the PC's focused() / active() / openOnPc() / soundOwner()
 *   - "where you are": the device with the latest input in the last 2 minutes
 *   - the Notifier's four rows (the design's table): working at the PC, working on the laptop, laptop idle with the phone in hand,
 *     nobody anywhere; and who a push goes to
 */
import { assert, assertEquals } from './_assert.ts';
import { ACTIVE_MS, DEVICE_SLOTS, MAX_SLOTS, Presence } from '../../outputs/agent-studio/server/attention/presence.ts';
import { type Fire, Notifier, type PushPick } from '../../outputs/agent-studio/server/attention/watcher.ts';

type Json = Record<string, unknown>;

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).name === 'ValueError';
  }
  return false;
};

Deno.test('presence: a computer gets server-made slot ids, at most 4, and never pushes the PC windows out', () => {
  let now = 1_000_000;
  const p = new Presence(() => now);
  // the PC: its main window and seven more (8 slots)
  for (const w of ['m', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']) p.reportWindow({ w, focused: w === 'w8', idleMs: 1000 });
  now += 10;
  // a laptop with six tabs: four slots, its oldest tab gives its slot up
  const tabs = ['t-aaaa01', 't-aaaa02', 't-aaaa03', 't-aaaa04', 't-aaaa05', 't-aaaa06'];
  for (const w of tabs) {
    now += 10;
    p.reportDevice('lap01', { w, focused: false, visible: true, open: ['claude:' + w], idleMs: 999_999 });
  }
  const mine = p.deviceAnswer('lap01');
  assertEquals(mine.windows.map((x) => x.w), tabs.slice(2), 'its 4 newest tabs, by their own ids');
  assertEquals(mine.openAll, tabs.slice(2).map((w) => 'claude:' + w));
  // two more laptops, four tabs each: 8 + 4 + 4 + 4 = 20 > 16, so computers' slots go, never the PC's
  for (const d of ['lap02', 'lap03']) for (let i = 0; i < DEVICE_SLOTS; i++) p.reportDevice(d, { w: `t-${d}x${i}`, idleMs: 999_999 });
  assertEquals(p.windows().map((x) => x.w), ['m', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'], 'the PC keeps every window');
  const total = p.windows().length + ['lap01', 'lap02', 'lap03'].reduce((n, d) => n + p.deviceAnswer(d).windows.length, 0);
  assertEquals(total, MAX_SLOTS);
  // the PC reports again with a ninth window: still a computer's slot goes
  p.reportWindow({ w: 't-desk01', idleMs: 1000 });
  assertEquals(p.windows().length, 9);
  // a computer's slots are not the PC's: focus, the open chats and the sound owner stay the PC's
  p.reportDevice('lap02', { w: 't-lap02x3', focused: true, open: ['claude:only-on-laptop'], idleMs: 0 });
  assertEquals(p.soundOwner(), 'w8');
  assert(!p.openOnPc().includes('claude:only-on-laptop'));
  assert(p.deviceFocused('lap02') && !p.deviceFocused('lap03'));
  // the page never names a slot: no id from a body gets in, bad ids are refused
  assert(refused(() => p.reportDevice('lap01', { w: 'r-lap02-1' })), 'a slot id is not a tab id');
  assert(refused(() => p.reportDevice('lap01', { w: '_' })));
  assert(refused(() => p.reportDevice('lap01', {})));
  assert(refused(() => p.reportDevice('bad id!', { w: 't-abcd01' })));
  assert(refused(() => p.reportDevice('lap01', { w: 't-abcd09', kind: 'popup' })));
  // a page cannot leave the PC's window: leave() of an r- id is ignored, and the device's own "left" drops only its tab
  p.leave('r-lap02-1');
  p.reportDevice('lap02', { w: 't-lap02x3', left: true });
  assert(!p.deviceAnswer('lap02').windows.some((x) => x.w === 't-lap02x3'));
  // Remove: all its slots and its "where you are" go
  p.leavePhone('lap01', 'removed');
  assertEquals(p.deviceAnswer('lap01').windows, []);
});

Deno.test('presence: where you are is the device with the latest input in the last 2 minutes', () => {
  let now = 5_000_000;
  const p = new Presence(() => now);
  assertEquals(p.where(), null, 'nobody anywhere');
  // working at the PC
  p.reportWindow({ w: 'm', focused: true, idleMs: 0 });
  assertEquals(p.where(), { who: 'pc' });
  // typing on the laptop now: the laptop (the PC window keeps focus, its last input is older)
  now += 5_000;
  p.reportWindow({ w: 'm', focused: true, idleMs: 5_000 });
  p.reportDevice('lap01', { w: 't-aaaa01', focused: true, idleMs: 0 });
  assertEquals(p.where(), { who: 'computer', device: 'lap01' });
  assertEquals(p.answer().quiet, true, 'the PC pages keep quiet');
  assertEquals(p.deviceAnswer('lap01').quiet, false, 'the laptop is where you are');
  // the laptop tab loses focus (another app on the laptop): still the laptop, for 2 minutes after its last input
  now += 60_000;
  p.reportDevice('lap01', { w: 't-aaaa01', focused: false, idleMs: 60_000 });
  assertEquals(p.where(), { who: 'computer', device: 'lap01' });
  // back at the PC: the PC
  p.reportWindow({ w: 'm', focused: true, idleMs: 0 });
  assertEquals(p.where(), { who: 'pc' });
  assertEquals(p.deviceAnswer('lap01').quiet, true, 'the laptop keeps quiet');
  // nobody: the PC unfocused and the laptop idle for 2 minutes
  p.reportWindow({ w: 'm', focused: false, idleMs: 0 });
  now += ACTIVE_MS;
  assertEquals(p.where(), null);
  // a phone in hand after that: the phone; the laptop used after the phone came on screen: the laptop
  p.seePhone('ph1', null);
  assertEquals(p.where(), { who: 'phone', device: 'ph1' });
  now += 1_000;
  p.reportDevice('lap01', { w: 't-aaaa01', focused: true, idleMs: 0 });
  assertEquals(p.where(), { who: 'computer', device: 'lap01' });
  // the phone acts (an answer, a send): the phone again
  now += 1_000;
  p.seePhone('ph1', null);
  p.phoneInput('ph1');
  assertEquals(p.where(), { who: 'phone', device: 'ph1' });
});

/** A Notifier with a real Presence, three push targets (a phone and two laptops) and everything recorded. */
function lab() {
  let now = 9_000_000;
  const presence = new Presence(() => now);
  const desktop: Json[] = [];
  const pushes: string[][] = [];
  const targets = [{ id: 'ph1', kind: 'phone' as const }, { id: 'lap01', kind: 'computer' as const }, {
    id: 'lap02',
    kind: 'computer' as const,
  }];
  const n = new Notifier({
    desktop: () => (req) => (desktop.push(req), Promise.resolve({ shown: true })),
    push: () => (_text, to?: PushPick) => (pushes.push(targets.filter((t) => !to || to(t)).map((t) => t.id)), Promise.resolve()),
    presence,
    viewPrefs: { public: () => ({ prefs: { 'studio-notifications-app': JSON.stringify({ notifyFor: 'both' }) } }) } as never,
    clock: () => now,
  });
  let i = 0;
  const fire = (kind: 'needs' | 'turn' = 'needs'): Fire => {
    i++;
    return { key: 'claude:k' + i, chat: 'c-' + i, kind, title: 'Chat ' + i };
  };
  return {
    presence,
    desktop,
    pushes,
    n,
    fire,
    tick(ms: number) {
      now += ms;
    },
  };
}

Deno.test('notifications row 1: working at the PC -> as today on the PC, nothing on the laptop or the phone', async () => {
  const t = lab();
  t.presence.reportDevice('lap01', { w: 't-aaaa01', focused: true, idleMs: 0 });
  t.tick(1000);
  t.presence.reportWindow({ w: 'm', focused: true, idleMs: 0 });
  await t.n.fire([t.fire()]);
  assertEquals([t.desktop.length, t.pushes.length], [0, 0], 'the PC window is in front: its page shows it');
  assertEquals(t.presence.deviceAnswer('lap01').quiet, true, 'the laptop page does not chime');
});

Deno.test('notifications row 2: working on the laptop -> nothing on the PC or the phone; the laptop shows it (push only when its page is not in front)', async () => {
  const t = lab();
  t.presence.reportWindow({ w: 'm', focused: false, idleMs: 30_000 });
  t.presence.seePhone('ph1', null); // a phone on screen, picked up before the laptop was used
  t.tick(1000);
  t.presence.reportDevice('lap01', { w: 't-aaaa01', focused: true, idleMs: 0 });
  await t.n.fire([t.fire()]);
  assertEquals([t.desktop.length, t.pushes.length], [0, 0], 'the laptop page is in front: it toasts and chimes itself');
  assertEquals(t.presence.takeNotices('ph1'), [], 'no banner on the phone');
  assertEquals(t.presence.answer().quiet, true, 'the PC pages keep quiet');
  // the laptop's AIB tab goes to the background (another app on the laptop, used 10 s ago): a push to the laptop only
  t.tick(10_000);
  t.presence.reportDevice('lap01', { w: 't-aaaa01', focused: false, idleMs: 10_000 });
  await t.n.fire([t.fire('turn')]);
  assertEquals(t.desktop.length, 0, 'no desktop notification on the PC');
  assertEquals(t.pushes, [['lap01']], 'pushed to the laptop only, not the phone or the other laptop');
});

Deno.test('notifications row 3: laptop idle more than 2 minutes, phone in hand -> the phone as today, nothing on the laptop', async () => {
  const t = lab();
  t.presence.reportDevice('lap01', { w: 't-aaaa01', focused: false, idleMs: 0 });
  t.tick(ACTIVE_MS + 1000);
  t.presence.seePhone('ph1', null);
  await t.n.fire([t.fire()]);
  assertEquals(t.pushes, [], 'no push: the phone page shows a banner');
  assertEquals(t.presence.takeNotices('ph1').length, 1, 'the banner');
  // the PC's own desktop notification follows today's rule for a phone in hand (unchanged by phase 2)
  assertEquals(t.desktop.length, 1);
});

Deno.test('notifications row 4: nobody anywhere -> the PC as today, a push to the phone and the laptops (not a laptop whose page is in front)', async () => {
  const t = lab();
  t.presence.reportDevice('lap02', { w: 't-bbbb01', focused: true, idleMs: 0 });
  t.tick(ACTIVE_MS + 1000);
  t.presence.reportDevice('lap02', { w: 't-bbbb01', focused: true, idleMs: ACTIVE_MS + 1000 }); // in front, idle
  await t.n.fire([t.fire()]);
  assertEquals(t.desktop.length, 1, 'the PC desktop notification');
  assertEquals(t.pushes, [['ph1', 'lap01']], 'the phone and the laptop in the background; not lap02, whose page shows it');
});
