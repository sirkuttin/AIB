/**
 * A device's Phone / Computer on Settings > Remote control changes only the device the owner meant, and only on a deliberate click
 * (owner 2026-11-16: his Android phone became a computer, with every pc.* switch, while he was setting up linux-pc; the log said
 * "Android phone is now a computer" 3 s after "pairing code shown on the PC").
 *
 * Reproduced here before the fix, in a headless Chrome on a throwaway in-process AIB with two paired devices:
 *   - Add a phone drew its 303 px code box ABOVE the rows: the first device's row slid under the pointer still on "Add a phone",
 *     so the next click landed on that row; the row's Phone / Computer radio saved on that one click;
 *   - a focused row radio flipped with an arrow key (a radio group's own keys) and saved at once: ArrowRight made a phone a computer.
 * Now: the code and approve boxes open under the Add button (nothing above it moves), and the row's control only asks; the change is
 * saved by "Make it a computer" / "Make it a phone" in that device's own row. The approve box's kind goes to the new device only.
 * The activity line says who changed the kind ("by": the PC page, Settings > Remote control, and the browser).
 *
 * Run (from app): deno test -A ../../work/deno/device_kind_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { until } from './_host_fixture.ts';
import { readRemotePort } from '../../app/server/remote/port.ts';
import { fakeTailscale, nonce, pairPhone, pc, phoneHeaders, raw, remoteStudio, serveStatus } from './_remote_fixture.ts';

type Json = Record<string, unknown>;
const OPTS = { sanitizeResources: false, sanitizeOps: false };
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clickAt(page: Page, x: number, y: number) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const row = (id: string) => `.dv-device[data-device="${id}"]`;
const option = (scope: string, kind: string) => `${scope} .dv-kind-option:has(input[data-kind="${kind}"])`;

Deno.test({
  ...OPTS,
  name: 'device kind: only a deliberate "Make it a ..." in that row changes a device; Add a phone and arrow keys change nothing; logged with who',
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      const android = await pairPhone(s, 'Android phone');
      const linux = await pairPhone(s, 'linux-pc');
      const devices = async () => {
        const [, v] = await pc(s, 'GET', '/api/live/devices');
        return Object.fromEntries((v.devices as Json[]).map((d) => [d.name as string, d]));
      };
      const kinds = async () => Object.fromEntries(Object.entries(await devices()).map(([n, d]) => [n, d.kind]));

      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!document.getElementById("openSettings")', 15000, 'chat page');
      await page.click('#openSettings');
      await page.waitFor(`document.body.classList.contains('settings-open')`, 8000, 'settings open');
      await page.eval(`[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'Remote control').click()`);
      await page.waitFor(`document.querySelectorAll('.dv-device').length === 2 && !!document.getElementById('dvAdd')`, 8000, 'two rows');

      // Settings is still loading (agent sign-in checks, bootstrap) and redraws the whole page once more when they finish; a redraw
      // while the page is scrolled can drop the scroll. Measure only after the page has been quiet, as the owner does.
      let quiet = 0;
      for (let i = 0, last = ''; i < 60 && quiet < 6; i++) {
        const sig = await page.eval<string>(`(() => { const c = document.querySelector('.st-content'); return c.scrollHeight + ':' + c.innerHTML.length; })()`);
        quiet = sig === last ? quiet + 1 : 0;
        last = sig;
        await settle(250);
      }
      assert(quiet >= 6, 'Settings never went quiet');

      // 1. Add a phone at its spot, then a second click there: the rows do not move, nothing of a row is under the pointer
      const tops = `JSON.stringify([...document.querySelectorAll('.dv-device')].map((r) => Math.round(r.getBoundingClientRect().top)))`;
      const at = await page.eval<[number, number]>(`(() => { const e = document.getElementById('dvAdd'); e.scrollIntoView({block: 'center'});
        const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
      await settle(300);
      const before = await page.eval<string>(tops);
      await clickAt(page, at[0], at[1]);
      await page.waitFor(`!!document.querySelector('.dv-pair .dv-qr')`, 8000, 'the code box');
      await settle(400);
      assertEquals(await page.eval<string>(tops), before, 'the rows stay where they were when the code box opens');
      assertEquals(
        await page.eval(`(() => { const e = document.elementFromPoint(${at[0]}, ${at[1]}); return e && e.closest('.dv-device') ? e.closest('.dv-device').dataset.device : ''; })()`),
        '',
        'no row under the pointer that clicked Add a phone',
      );
      await clickAt(page, at[0], at[1]);
      await settle(1200);
      assertEquals(await kinds(), { 'Android phone': 'phone', 'linux-pc': 'phone' }, 'a second click where Add was changes no device');

      // 2. a focused row radio and an arrow key: it only asks, in that row; nothing is saved; Cancel takes the question away
      await page.eval(`document.querySelector('${row(android.id)} input[data-kind="phone"]').focus()`);
      await page.key('ArrowRight');
      await page.waitFor(`!!document.querySelector('${row(android.id)} .dv-kind-ask')`, 8000, 'the question in the phone row');
      assert(
        (await page.eval<string>(`document.querySelector('${row(android.id)} .dv-kind-ask').textContent`)).includes('Make "Android phone" a computer?'),
        'the question names the device',
      );
      assertEquals(await page.eval(`document.querySelectorAll('.dv-kind-ask').length`), 1, 'one question, in one row');
      await settle(1200);
      assertEquals(await kinds(), { 'Android phone': 'phone', 'linux-pc': 'phone' }, 'an arrow key saves nothing');
      await page.eval(`[...document.querySelectorAll('${row(android.id)} .dv-kind-ask button')].find((b) => b.textContent === 'Cancel').click()`);
      await page.waitFor(`!document.querySelector('.dv-kind-ask')`, 8000, 'the question gone');

      // 3. linux-pc's row: Computer asks in linux-pc's row; "Make it a computer" changes linux-pc only
      await page.click(option(row(linux.id), 'computer'));
      await page.waitFor(`!!document.querySelector('${row(linux.id)} .dv-kind-ask')`, 8000, 'the question in linux-pc row');
      assert(!(await page.eval<boolean>(`!!document.querySelector('${row(android.id)} .dv-kind-ask')`)), 'nothing asked in the phone row');
      await page.eval(`[...document.querySelectorAll('${row(linux.id)} .dv-kind-ask button')].find((b) => b.textContent === 'Make it a computer').click()`);
      await until(async () => (await kinds())['linux-pc'] === 'computer', 'linux-pc saved as a computer', 10);
      const after = await devices();
      assertEquals(after['Android phone'].kind, 'phone', 'the phone stays a phone');
      assert(!(after['Android phone'].scopes as string[]).some((x) => x.startsWith('pc.')), 'the phone has no pc.* switch');
      await page.waitFor(`document.querySelector('${row(linux.id)} .dv-kind-tag').textContent === 'Computer'`, 8000, 'linux-pc drawn a computer');

      // 4. the approve box open while the rows are there: its Computer goes to the new device only
      const [, code] = await pc(s, 'POST', '/api/live/devices/pair', {});
      const claim = await raw(
        s.phonePort(),
        'POST',
        '/api/remote/pair/claim',
        phoneHeaders({}, 'POST'),
        JSON.stringify({ code: (code.words as string[]).join(' '), name: 'Linux PC (Chrome)', nonce: nonce() }),
      );
      assertEquals(claim.status, 200, claim.text);
      await page.waitFor(`!!document.querySelector('.dv-approve')`, 10000, 'the approve box');
      assert(
        await page.eval<boolean>(`(() => { const a = document.querySelector('.dv-approve'), rows = document.querySelectorAll('.dv-device');
          return !!(rows[rows.length - 1].compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); })()`),
        'the approve box is drawn under the rows',
      );
      await page.click(option('.dv-approve', 'computer'));
      await page.waitFor(`document.querySelector('.dv-approve input[data-kind="computer"]').checked`, 8000, 'Computer picked on the approve box');
      assertEquals(await page.eval(`document.querySelectorAll('.dv-kind-ask').length`), 0, 'the approve box asks nothing of a row');
      await settle(800);
      assertEquals(await kinds(), { 'Android phone': 'phone', 'linux-pc': 'computer' }, 'picking on the approve box changes no paired device');
      await page.eval(`[...document.querySelectorAll('.dv-approve button')].find((b) => b.textContent === 'Approve').click()`);
      await until(async () => (await kinds())['Linux PC (Chrome)'] === 'computer', 'the new device paired as a computer', 10);
      assertEquals(await kinds(), { 'Android phone': 'phone', 'linux-pc': 'computer', 'Linux PC (Chrome)': 'computer' });

      // 5. the log: one kind line, for linux-pc, saying who made it
      const [, act] = await pc(s, 'GET', '/api/live/devices/activity');
      const lines = (act.entries as Json[]).filter((e) => e.action === 'kind');
      assertEquals(lines.map((e) => [e.device, e.result]), [[linux.id, 'linux-pc is now a computer']]);
      assert(String(lines[0].by).startsWith('the PC page, Settings > Remote control'), `by: ${lines[0].by}`);
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
