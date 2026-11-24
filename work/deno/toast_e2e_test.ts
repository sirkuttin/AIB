/**
 * Inbox v3.1 phase 4 end to end, in-process: an AIB with a fake agent host, its server-built inbox, the desktop notifications with
 * the Windows toast route (startWindowsToasts) and a fake `AIB-keeper toast` helper in place of the real one, so no toast shows
 * and no registry key is written.
 *  - an ordinary approval's toast has Allow / Deny; a simulated click on Allow answers the agent with its allow_once option, no
 *    window comes up, and the toast is removed;
 *  - a risky command's toast (git push) has Open only; a forged Allow for it (another toast's code, or none) answers nothing and
 *    only opens its row in the inbox;
 *  - a request answered on the page removes its toast from the notification centre at the next inbox build.
 */
import { assert, assertEquals } from './_assert.ts';
import { pc } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { DesktopNotifications, type NotifyTarget, type OsNotify } from '../../app/server/desktop/notify.ts';
import { type SpawnToastHelper, toastTag } from '../../app/server/desktop/toast.ts';
import { startWindowsToasts } from '../../app/server/desktop/toast_act.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const ONCE = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];
const needs = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
const perm = (
  key: string,
  command: string,
) => [{ key, params: { toolCall: { toolCallId: `tc-${key}`, title: 'Bash', rawInput: { command } }, options: ONCE } }];
const buttons = (xml: string) =>
  [...xml.matchAll(/<action content="([^"]*)" arguments="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]);

async function until(what: string, ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test({
  ...OPTS,
  name: 'inbox v3.1 phase 4: Allow on a toast approves an ordinary request; a risky one is refused; answered toasts go',
  async fn() {
    const s = await v2Studio();
    const dir = await Deno.makeTempDir({ prefix: 'aib-toast-e2e-' });
    let stop = () => {};
    try {
      const ok = liveChat('c-ok', s.project, {
        breadth: { sessionInfo: { title: 'Payments' } },
        attention: { ...needs },
        permissions: perm('p1', 'npm install stripe@18.0.0'),
      });
      const bad = liveChat('c-risky', s.project, {
        breadth: { sessionInfo: { title: 'Release' } },
        attention: { ...needs },
        permissions: perm('p2', 'git push origin main'),
      });
      const other = liveChat('c-other', s.project, {
        breadth: { sessionInfo: { title: 'Docs' } },
        attention: { ...needs },
        permissions: perm('p3', 'npm run docs'),
      });
      s.chats.push(ok, bad, other);
      const calls: [string, Json][] = [];
      s.answerLive((name, body) => {
        calls.push([name, body]);
        if (name === 'permission') {
          const c = s.chats.find((x) => x.id === body.id);
          if (c) {
            c.permissions = [];
            c.attention = { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() };
            c.busy = true;
          }
        }
        return [200, { ok: true }];
      });

      // the fake helper: answers register and show, records what it was sent, clicks when told
      const sent: Json[] = [];
      let deliver: (m: Json) => void = () => {};
      const spawn: SpawnToastHelper = (onMessage) => {
        deliver = onMessage;
        return {
          send(m) {
            sent.push(m);
            if (m.op === 'register') queueMicrotask(() => onMessage({ op: 'ready' }));
            if (m.op === 'show') queueMicrotask(() => onMessage({ op: 'shown', id: m.id }));
          },
          close() {},
        };
      };
      const balloons: string[] = [];
      const balloon: OsNotify = {
        mechanism: 'windows-balloon',
        show: (t, b) => (balloons.push(`${t}|${b}`), Promise.resolve({ shown: true, code: 1 })),
      };
      const opened: (NotifyTarget | null)[] = [];
      const notifications = new DesktopNotifications(balloon, (t) => opened.push(t), () => true);
      const started = startWindowsToasts(s.ctx, notifications, {
        stateDir: dir,
        program: 'unused: the fake helper runs instead',
        launch: '',
        icon: new Uint8Array([137, 80, 78, 71]),
        quietState: () => 5,
        spawn,
        firstWaitMs: 50,
        settleMs: 10,
      });
      assert(started, 'the toast route is on');
      stop = started.stop;
      assertEquals(notifications.mechanism, 'windows-toast');
      await until('registered', () => started.toasts.state === 'ready');
      const reg = sent[0];
      assertEquals([reg.op, reg.appId, reg.name, reg.clsid], ['register', 'AIB.Studio', 'AIB', '{6B1F3A52-8C4D-4E7A-9F21-3D5B7C9E0A14}']);
      assertEquals(reg.data, dir.replace(/\//g, '\\'));

      const inbox = await s.ctx.inbox.look();
      const keyOf = (id: string) => `claude:sess-${id}`;
      assertEquals(inbox.rows.map((r) => [r.key, r.kind]).sort(), [[keyOf('c-ok'), 'approval'], [keyOf('c-other'), 'approval'], [
        keyOf('c-risky'),
        'approval',
      ]]);
      const show = async (id: string) => {
        const r = await notifications.show({ title: id, body: 'shopfront', target: { type: 'inbox', key: keyOf(id) }, test: false });
        assert(r.shown, id);
        const m = sent.filter((x) => x.op === 'show').at(-1)!;
        assertEquals(m.tag, toastTag(keyOf(id)));
        return buttons(String(m.xml));
      };
      const okButtons = await show('c-ok');
      assertEquals(okButtons.map((b) => b[0]), ['Allow', 'Deny']);
      const riskyButtons = await show('c-risky');
      assertEquals(riskyButtons, [['Open', `act=open&chat=${encodeURIComponent(keyOf('c-risky'))}`]], 'a risky command: Open only');
      assertEquals(balloons, [], 'toasts, not balloons');

      // forged Allow on the risky request: the ordinary toast's code, then no code at all
      const okCode = new URLSearchParams(okButtons[0][1]).get('n')!;
      deliver({ op: 'activated', args: `act=allow&chat=${encodeURIComponent(keyOf('c-risky'))}&n=${okCode}`, inputs: {} });
      deliver({ op: 'activated', args: `act=allow&chat=${encodeURIComponent(keyOf('c-risky'))}`, inputs: {} });
      await until('both refused clicks opened the row', () => opened.length >= 2);
      assertEquals(opened, [{ type: 'inbox', key: keyOf('c-risky') }, { type: 'inbox', key: keyOf('c-risky') }]);
      assertEquals(calls.filter((c) => c[0] === 'permission'), [], 'nothing was approved');

      // Allow on the ordinary toast: answered with allow_once, no window, the toast removed
      deliver({ op: 'activated', args: okButtons[0][1], inputs: {} });
      await until('the approval went to the agent', () => calls.some((c) => c[0] === 'permission'));
      assertEquals(calls.filter((c) => c[0] === 'permission'), [['permission', { id: 'c-ok', key: 'p1', option: 'yes' }]]);
      await until('its toast removed', () => sent.some((m) => m.op === 'remove' && m.tag === toastTag(keyOf('c-ok'))));
      assertEquals(opened.length, 2, 'Allow brings no window up');
      // the same click again (a double click, a replay): refused
      deliver({ op: 'activated', args: okButtons[0][1], inputs: {} });
      await until('the replay opened the chat', () => opened.length === 3);
      assertEquals(calls.filter((c) => c[0] === 'permission').length, 1, 'answered once');

      // answered on the page: its toast leaves the notification centre at the next inbox build
      const otherButtons = await show('c-other');
      assertEquals(otherButtons.map((b) => b[0]), ['Allow', 'Deny']);
      const [status] = await pc(s, 'POST', '/api/live/permission', { id: 'c-other', key: 'p3', option: 'yes' });
      assertEquals(status, 200);
      await s.ctx.inbox.look();
      await until('the answered toast removed', () => sent.some((m) => m.op === 'remove' && m.tag === toastTag(keyOf('c-other'))));
      // and its Allow, clicked late from the notification centre, answers nothing
      const before = calls.filter((c) => c[0] === 'permission').length;
      deliver({ op: 'activated', args: otherButtons[0][1], inputs: {} });
      await until('the late click opened the chat', () => opened.length === 4);
      assertEquals(opened.at(-1), { type: 'chat', key: keyOf('c-other') });
      assertEquals(calls.filter((c) => c[0] === 'permission').length, before);
      assertEquals(balloons, []);
    } finally {
      stop();
      await s.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
