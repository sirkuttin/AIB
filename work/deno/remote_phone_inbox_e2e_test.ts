/**
 * The phone's inbox (inbox prototype v3, phone frame) in a headless Chrome (no window) at 375 px, where this test plays Tailscale
 * Serve, against an in-process AIB with a fake agent host:
 *  - no "Waiting on you · N" banner anywhere on home;
 *  - the envelope at the top right of home, next to the project picker, with the count of chats that need you (every project);
 *  - a tap shows the inbox: the server-built rows (Inbox v3.1), one "Needs you" list whatever project is picked (the old
 *    "Needs you in <project>" split is gone: no project filters);
 *  - a card: line 1 the actual request, line 2 chat · project, the wait time, ONE row: Allow once / Deny / Reply, a risky command
 *    Review first / Deny; nothing "always", no agent name;
 *  - Allow once answers the request from home (the once-only option reaches the agent host); a tap on a card opens the chat;
 *  - the envelope again shows the chat list.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const ONCE = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];
const ask = (title: string, command: string) => ({ toolCall: { title, rawInput: { command } }, options: ONCE });
const needs = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };

Deno.test({
  ...OPTS,
  name: 'phone inbox: envelope with the count next to the picker; the server rows in one list, no project split; one action row; Allow once',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    // a second folder inside the fixture's own temp folder (removed with it): another project
    const other = s.project.replace(/[\\/]shop$/, (m) => m.slice(0, 1) + 'blog');
    await Deno.mkdir(other, { recursive: true });
    const answered: Json[] = [];
    s.answerLive((name, body) => {
      if (body && body.key) answered.push({ name, ...body });
      return [200, { ok: true, accepted: true }];
    });
    const browser = await Browser.launch();
    try {
      const here = liveChat('c-here', s.project, {
        breadth: { sessionInfo: { title: 'Checkout fix' } },
        attention: needs,
        permissions: [{ key: 'p-here', params: ask('Bash', 'npm install stripe@18.0.0') }],
      });
      const away = liveChat('c-away', other, {
        breadth: { sessionInfo: { title: 'Blog release' } },
        attention: needs,
        permissions: [{ key: 'p-away', params: ask('Bash', 'git push origin main') }],
      });
      s.chats.push(here, away, liveChat('c-idle', s.project));
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);

      // no banner; the envelope sits in the picker's band, right of it, with the count (every project)
      const text = await page.eval<string>('document.getElementById("app").innerText');
      assert(!/Waiting on you/i.test(text), 'no "Waiting on you" banner on home');
      await page.waitFor('document.querySelector("#phInbox .ph-env-badge")?.textContent === "2"', 15000, 'the count badge');
      const place = await page.eval<Json>(`(() => {
        const env = document.getElementById('phInbox').getBoundingClientRect();
        const fb = document.getElementById('phFilter').getBoundingClientRect();
        return { inBand: !!document.querySelector('.ph-filter #phInbox'), right: Math.round(window.innerWidth - env.right), envX: env.x, fbR: fb.right, w: env.width, h: env.height };
      })()`);
      assert(place.inBand && Number(place.envX) > Number(place.fbR), `envelope right of the picker ${JSON.stringify(place)}`);
      assert(Number(place.right) <= 20 && Number(place.w) >= 44 && Number(place.h) >= 44, `envelope at the right, 44 px ${JSON.stringify(place)}`);
      assertEquals(await page.eval('document.getElementById("phInbox").getAttribute("aria-pressed")'), 'false');

      // All projects: one Needs you list, oldest first
      await tap(page, '#phInbox');
      await page.waitFor('!!document.getElementById("phInboxList")', 5000, 'the inbox');
      assertEquals(await page.eval('document.getElementById("phInbox").getAttribute("aria-pressed")'), 'true');
      const all = await page.eval<string[][]>(`[...document.querySelectorAll('.ph-isec')].map((s) => [s.dataset.group, s.querySelector('.ph-ih').textContent, ...[...s.querySelectorAll('.ph-icard')].map((c) => c.dataset.chat)])`);
      assertEquals(all.length, 1, JSON.stringify(all));
      assertEquals(all[0].slice(0, 2), ['needs', 'Needs you']);
      assertEquals(new Set(all[0].slice(2)), new Set(['c-here', 'c-away']));
      assert(!(await page.eval<boolean>('!!document.querySelector(".ph-card")')), 'the chat list is not shown under the inbox');

      // a picked project changes nothing in the inbox: still the server's one Needs you list (no "Needs you in <project>")
      await tap(page, '#phFilter');
      await tap(page, `.ph-flist [data-project="${s.projectId}"]`);
      await page.waitFor('!!document.getElementById("phInboxList")', 5000, 'the inbox');
      const picked = await page.eval<string[][]>(`[...document.querySelectorAll('.ph-isec')].map((s) => [s.dataset.group, s.querySelector('.ph-ih').textContent, ...[...s.querySelectorAll('.ph-icard')].map((c) => c.dataset.chat)])`);
      assertEquals(picked.length, 1, JSON.stringify(picked));
      assertEquals(picked[0].slice(0, 2), ['needs', 'Needs you']);
      assertEquals(new Set(picked[0].slice(2)), new Set(['c-here', 'c-away']));
      assert(!/Needs you in /.test(await page.eval<string>('document.getElementById("phInboxList").innerText')), 'no per-project heading');

      // the card: request, chat · project, the wait time, one row; risky = Review first; nothing "always", no agent name
      const card = (id: string) =>
        page.eval<Json>(`(() => {
          const c = document.querySelector('.ph-icard[data-chat="${id}"]');
          return { what: c.querySelector('.ph-iwhat').textContent, where: c.querySelector('.ph-il2').textContent, age: c.querySelector('.ph-iage')?.textContent || '',
            rows: c.querySelectorAll('.ph-iacts').length, buttons: [...c.querySelectorAll('.ph-iacts button')].map((b) => b.textContent), text: c.innerText };
        })()`);
      const h = await card('c-here');
      assertEquals(h.what, 'Run npm install stripe@18.0.0');
      assertEquals(h.where, 'Checkout fix · shop');
      assertEquals(h.rows, 1);
      assertEquals(h.buttons, ['Allow once', 'Deny', 'Reply']);
      assert(/^(now|\d+[mhd])$/.test(String(h.age)), `wait time ${h.age}`);
      assert(!/always|waited|Claude Code|Codex/i.test(String(h.text)), `no always / waited / agent name: ${h.text}`);
      const a = await card('c-away');
      assertEquals(a.buttons, ['Review first', 'Deny']);

      // Allow once answers it from home with the once-only option
      await tap(page, '.ph-icard[data-chat="c-here"] button[data-act="allow"]');
      await page.waitFor('document.body.innerText.includes("Allowed once")', 8000, 'the toast');
      const sent = answered.find((x) => x.key === 'p-here');
      assert(sent && sent.option === 'yes', `the once-only option reached the agent host: ${JSON.stringify(answered)}`);
      here.permissions = [];
      here.attention = { state: 'idle', needs: 0, turnEndedAt: new Date().toISOString(), busySince: null };
      await page.waitFor('document.querySelector("#phInbox .ph-env-badge")?.textContent === "1"', 15000, 'the count after answering');

      // the envelope again: the chat list
      await tap(page, '#phInbox');
      await page.waitFor('!!document.querySelector(".ph-card") && !document.getElementById("phInboxList")', 5000, 'the chat list');

      // a tap on a card opens the chat
      await tap(page, '#phInbox');
      await page.waitFor('!!document.querySelector(".ph-icard[data-chat=\\"c-away\\"]")', 5000, 'the away card');
      await page.eval(`document.querySelector('.ph-icard[data-chat="c-away"] .ph-il2').click()`);
      await page.waitFor('document.getElementById("app").dataset.screen === "chat"', 8000, 'the chat opens');
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
