/**
 * The phone's New chat from All projects (owner, Android: "loading the projects fails, only sometimes").
 *
 * Cause: GET /api/remote/new/options built Settings' whole agent list on every call (every agent's program looked for in every
 * PATH folder with every PATHEXT, prerequisites' versions read: 1.5-7 s on the owner's PC, with synchronous file checks), against
 * the phone's request timeout; a slow one showed "Can't reach <PC>." with no way out but Back. Now the list is kept (newchat.ts
 * AGENTS_MS, built once at a time, an older one served while a new one is built), and a load that fails shows why with Try again.
 *
 *  - server: a slow agent list is built once for many options calls (also at the same time); an older list is served at once while
 *    a new one is built; a Start waits for a list at most AGENTS_MS old; an agent turned on in Settings is never served from the
 *    kept list.
 *  - headless Chrome at 375 px: New chat opened from All projects 50 times with several projects (some folders gone) and a slow agent
 *    list: every open after the first shows the projects quickly; a load that fails (AIB busy) shows the message and a working Try
 *    again.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, type RemoteAib } from './_remote_fixture.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { AGENTS_MS, agentsNow, setAgentRows } from '../../app/server/remote/newchat.ts';
import { HostUnavailable } from '../../app/server/host/host_client.ts';
import { AGENT_ROWS, liveChat, phoneCall, v2Aib } from './_remote_v2b.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settings' agent list as slow as a busy PC builds it; counts the builds. */
function slowRows(ms: number): { builds: number } {
  const seen = { builds: 0 };
  setAgentRows(async () => {
    seen.builds++;
    await sleep(ms);
    return AGENT_ROWS;
  });
  return seen;
}

/** More added projects: every third folder is gone. */
async function moreProjects(s: RemoteAib, n: number): Promise<number> {
  let there = 0;
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = `${s.root}${sep}projects${sep}extra-${i}`;
    if (i % 3) {
      await Deno.mkdir(p, { recursive: true });
      there++;
    }
    paths.push(p);
  }
  await s.ctx.addedProjects.add(...paths);
  for (const p of paths) s.ctx.folderPresence.isGone(p); // looked at once, as the PC's list does
  return there;
}

Deno.test({
  ...OPTS,
  name: 'phone New chat options: a slow agent list is built once and kept; older served while rebuilt; Start fresh; settings key',
  async fn() {
    const s = await v2Aib();
    try {
      const seen = slowRows(400);
      const phone = await pairPhone(s);
      let r = await phoneCall(s, phone.token, 'GET', '/api/remote/new/options');
      assertEquals(r.status, 200);
      assertEquals(seen.builds, 1);
      // many opens, some at the same time: no new build, each answered at once
      for (let round = 0; round < 3; round++) {
        const t = performance.now();
        const all = await Promise.all([1, 2, 3, 4, 5].map(() => phoneCall(s, phone.token, 'GET', '/api/remote/new/options')));
        assert(all.every((x) => x.status === 200), 'all answered');
        assert(performance.now() - t < 350, `answered at once (${(performance.now() - t).toFixed(0)} ms)`);
      }
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new/options?project=${s.projectId}&agent=claude`);
      assertEquals(r.status, 200);
      assertEquals(seen.builds, 1, 'the lists call uses the kept list too');

      // older than AGENTS_MS: an options call gets the kept list at once and one new build starts behind it
      const later = () => Date.now() + AGENTS_MS + 1000;
      let t = performance.now();
      const stale = await Promise.all([1, 2, 3].map(() => agentsNow(s.ctx, { stale: true, clock: later })));
      assert(performance.now() - t < 200, 'served at once');
      assertEquals(stale[0].map((a) => a.id), ['claude', 'codex', 'kimi']);
      assertEquals(seen.builds, 2, 'one build behind them');
      // a Start (no stale) waits for a list at most AGENTS_MS old: the build already running, not another one
      t = performance.now();
      await agentsNow(s.ctx, { clock: later });
      assert(performance.now() - t >= 200, 'waited for the build');
      assertEquals(seen.builds, 2);

      // an agent turned on in Settings: never the kept list
      const before = (await agentsNow(s.ctx, { stale: true })).find((a) => a.id === 'codex')!;
      assertEquals(seen.builds, 2);
      setAgentRows(async () => {
        seen.builds++;
        await sleep(50);
        return AGENT_ROWS.map((row) => (row.id === 'codex' ? { ...row, enabled: true } : row));
      });
      await s.ctx.settings.update({ agents: { builtin: { codex: true } } });
      r = await phoneCall(s, phone.token, 'GET', '/api/remote/new/options');
      assertEquals(r.status, 200);
      assert(!before.ok, 'codex was off');
      assert((r.json.agents as { id: string; ok: boolean }[]).find((a) => a.id === 'codex')!.ok, 'codex on now');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone page at 375 px: New chat from All projects 50 times with a slow agent list and gone folders; a failed load has Try again',
  ignore: !browserPath,
  async fn() {
    const s = await v2Aib();
    const browser = await Browser.launch();
    try {
      const seen = slowRows(1500);
      const there = await moreProjects(s, 9);
      s.chats.push(liveChat('c1', s.project));
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone);
      const shown =
        `document.getElementById("app").dataset.screen === "new" && document.querySelectorAll(".ph-pick[data-project]").length === ${
          there + 1
        }`;
      const times: number[] = [];
      for (let i = 0; i < 50; i++) {
        await page.waitFor('document.getElementById("app").dataset.screen === "home"', 15000, 'home');
        assert(String(await page.eval('document.getElementById("app").innerText')).includes('All projects'), 'All projects');
        const t = performance.now();
        await tap(page, '#phNewChat');
        try {
          await page.waitFor(shown, 15000, `projects (open ${i + 1})`);
        } catch (error) {
          throw new Error(`${error}: the page shows ${await page.eval('document.getElementById("app").innerText.slice(0, 600)')}`);
        }
        times.push(performance.now() - t);
        assert(!(await page.eval('!!document.getElementById("phNcLoadError")')), 'no error');
        await page.eval('document.getElementById("phBack").click()');
      }
      const after = times.slice(1).sort((a, b) => a - b);
      // before: every open waited for the whole agent list (1.5 s here, 1.5-7 s on a real PC)
      assert(after.at(-1)! < 1200, `every open after the first is quick: slowest ${after.at(-1)!.toFixed(0)} ms`);
      assert(seen.builds <= 1 + Math.ceil((times.reduce((a, b) => a + b, 0) + 50 * 300) / AGENTS_MS), `builds: ${seen.builds}`);

      // AIB busy (its agent host restarting): the message and Try again, which loads the projects. The failure is on from the tap
      // until the message shows (the New chat screen does not poll; a home poll in between may fail too and that is fine).
      const real = s.ctx.host.liveList;
      let busy = false;
      s.ctx.host.liveList = (() => busy ? Promise.reject(new HostUnavailable('restarting')) : real()) as typeof real;
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "home" && !!document.getElementById("phNewChat")',
        15000,
        'home',
      );
      busy = true;
      await page.eval('document.getElementById("phNewChat").click()');
      await page.waitFor('!!document.getElementById("phNcLoadError")', 15000, 'the error');
      busy = false;
      const words = String(await page.eval('document.getElementById("phNcLoadError").textContent'));
      assert(words.includes('not answering'), words);
      assert(await page.eval('!!document.getElementById("phNcRetry")'), 'Try again');
      await page.eval('document.getElementById("phNcRetry").click()');
      await page.waitFor(shown, 15000, 'projects after Try again');
      assert(!(await page.eval('!!document.getElementById("phNcLoadError")')), 'error gone');
      s.ctx.host.liveList = real;
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
