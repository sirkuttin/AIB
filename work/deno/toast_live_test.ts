/**
 * Opt-in manual check (AIB_TOAST_LIVE=1, Windows only; never in automated runs): the real `AIB-keeper toast` shows ONE real toast
 * under a throwaway TEST app id ("AIB.Test.live-<random>", never AIB.Studio), an approval with Allow / Deny. Click one of them
 * within 60 s; the test checks the click came back through the COM activator, then removes the toast and every registry key it
 * made (HKCU\Software\Classes\AppUserModelId\<test id>, CLSID\<test clsid>, Windows' own Notifications\Settings\<test id>).
 *
 *   AIB_TOAST_LIVE=1 deno test -A ../../work/deno/toast_live_test.ts      (from outputs/agent-studio)
 */
import { assert } from './_assert.ts';
import { keeperBinary } from '../../outputs/agent-studio/server/keeper/client.ts';
import { keeperToastSpawner, toastSpec, toastXml } from '../../outputs/agent-studio/server/desktop/toast.ts';
import type { InboxRow } from '../../outputs/agent-studio/server/attention/inbox_rules.ts';

const LIVE = Deno.env.get('AIB_TOAST_LIVE') === '1' &&
  Deno.build.os === 'windows';

Deno.test({
  name: 'live: one real toast with Allow / Deny; a click comes back (manual, AIB_TOAST_LIVE=1)',
  ignore: !LIVE,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const rnd = crypto.randomUUID();
    const appId = `AIB.Test.live-${rnd.slice(0, 8)}`;
    const clsid = `{${crypto.randomUUID().toUpperCase()}}`;
    const data = await Deno.makeTempDir({ prefix: 'aib-toast-live-' });
    const program = await keeperBinary();
    const messages: Record<string, unknown>[] = [];
    const helper = keeperToastSpawner(program)(
      (m) => messages.push(m),
      () => {},
    );
    const wait = async (
      what: (m: Record<string, unknown>) => boolean,
      ms: number,
    ) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = messages.find(what);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    try {
      helper.send({
        op: 'register',
        appId,
        name: 'AIB (live check)',
        icon: '',
        clsid,
        data: data.replace(/\//g, '\\'),
        launch: '',
      });
      assert(
        (await wait((m) => m.op === 'ready' || m.op === 'error', 10_000))
          ?.op === 'ready',
        JSON.stringify(messages),
      );
      const row = {
        key: 'claude:live',
        kind: 'approval',
        what: 'Run npm install stripe@18.0.0',
        whatCode: 'npm install stripe@18.0.0',
        request: {
          kind: 'permission',
          key: 'p1',
          params: {
            options: [{
              optionId: 'yes',
              name: 'Allow once',
              kind: 'allow_once',
            }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
          },
        },
      } as unknown as InboxRow;
      const xml = toastXml(
        toastSpec(
          {
            title: 'AIB live check',
            body: 'Click Allow or Deny',
            target: { type: 'inbox', key: row.key },
          },
          row,
          'live',
        ),
      );
      helper.send({ op: 'show', id: '1', tag: 'live', group: 'aib', xml });
      assert(
        (await wait((m) => m.op === 'shown' || m.op === 'failed', 10_000))
          ?.op === 'shown',
        JSON.stringify(messages),
      );
      console.log('A toast is on screen: click Allow or Deny within 60 s.');
      const click = await wait((m) => m.op === 'activated', 60_000);
      console.log('click:', JSON.stringify(click));
      assert(
        click && /act=(allow|deny)/.test(String(click.args)),
        'no click came back',
      );
      helper.send({ op: 'remove', tag: 'live', group: 'aib' });
      await wait((m) => m.op === 'removed', 3000);
    } finally {
      helper.close();
      for (const key of [`AppUserModelId\\${appId}`, `CLSID\\${clsid}`]) {
        await new Deno.Command('reg', {
          args: ['delete', `HKCU\\Software\\Classes\\${key}`, '/f'],
          stdout: 'null',
          stderr: 'null',
        }).output();
      }
      await new Deno.Command('reg', {
        args: [
          'delete',
          `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId}`,
          '/f',
        ],
        stdout: 'null',
        stderr: 'null',
      }).output();
      await Deno.remove(data, { recursive: true }).catch(() => {});
    }
  },
});
