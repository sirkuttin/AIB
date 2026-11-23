/**
 * Model servers on the phone's New chat (owner decisions 2026-11-23, Q1a and Q3a; headless Chrome at 375 px, an in-process AIB with
 * a fake agent host, no real agent and no real model server):
 *   - "Claude Code · strata" sits under a "Model servers" label, after the tested agents, and starts a chat with the server's entry
 *   - a server that does not answer is greyed with "<name> is not answering at <address>. Start it on your PC." and cannot be picked
 *   - the Start of a greyed entry is refused by the server with the same words (a phone that held an old list)
 * The PC's own menu is work/test_model_servers_ui.js; the checks behind both are work/deno/model_servers_ui_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, phoneHeaders } from './_remote_fixture.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { setAgentRows } from '../../outputs/agent-studio/server/remote/newchat.ts';
import { AGENT_ROWS, liveChat, phoneCall, v2Studio } from './_remote_v2b.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const entry = (id: string, name: string, down = '') => ({
  id: `claude@${id}`,
  name: `Claude Code · ${name}`,
  modelServer: true,
  serverId: id,
  enabled: true,
  found: true,
  signin: null,
  ...(down ? { down } : {}),
});
const DOWN = 'dead is not answering at 127.0.0.1:1';
const ROWS = [...AGENT_ROWS.slice(0, 3), entry('strata', 'strata'), entry('dead', 'dead', DOWN), AGENT_ROWS[3]];

Deno.test({
  ...OPTS,
  name: 'the options list the entries of a server under Model servers; a server that does not answer is not ok, with the reason in the phone’s words',
  async fn() {
    const s = await v2Studio();
    try {
      setAgentRows(() => Promise.resolve(ROWS));
      const phone = await pairPhone(s);
      const r = await phoneCall(s, phone.token, 'GET', '/api/remote/new/options');
      assertEquals(r.status, 200);
      const agents = r.json.agents as { id: string; ok: boolean; group?: string; why: string; reason: string }[];
      assertEquals(agents.map((a) => a.id), ['omp', 'claude', 'codex', 'claude@strata', 'claude@dead', 'kimi']);
      const strata = agents.find((a) => a.id === 'claude@strata')!;
      const dead = agents.find((a) => a.id === 'claude@dead')!;
      assertEquals([strata.ok, strata.group, strata.why], [true, 'Model servers', '']);
      assertEquals([dead.ok, dead.group, dead.reason, dead.why], [false, 'Model servers', 'Not answering', DOWN + '. Start it on your PC.']);
      // a phone that still holds an old list cannot start the greyed entry: refused with the same words
      const start = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude@dead',
        text: 'hello',
        clientMessageId: 'm-dead',
      });
      assert(start.status >= 400, String(start.status));
      assert(JSON.stringify(start.json).includes('is not answering at 127.0.0.1:1'), JSON.stringify(start.json));
      assert(!s.liveCalls.some(([n]) => n === 'connect'), 'no chat was started');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone page at 375 px: New chat shows a Model servers label, the working entry is pickable and starts a chat, the dead one is greyed with the reason',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      setAgentRows(() => Promise.resolve(ROWS));
      const phone = await pairPhone(s);
      s.chats.push(liveChat('c1', s.project));
      const page = await phonePage(browser, s, phone);
      await tap(page, '#phNewChat');
      await page.waitFor('document.getElementById("app").dataset.screen === "new" && !!document.querySelector(".ph-pick[data-project]")', 15000, 'projects');
      await tap(page, `.ph-pick[data-project="${s.projectId}"]`);
      await page.waitFor('!!document.querySelector(\'.ph-pick[data-agent="claude@dead"]\')', 15000, 'agents');
      assertEquals(await page.eval('[...document.querySelectorAll(".ph-group")].map((n) => n.textContent)'), ['Model servers']);
      // the label sits between the tested agents and the Beta ones
      const order = await page.eval<string[]>(
        '[...document.querySelectorAll(".ph-pick[data-agent], .ph-group")].map((n) => n.dataset.agent || n.textContent)',
      );
      assertEquals(order, ['omp', 'claude', 'codex', 'Model servers', 'claude@strata', 'claude@dead', 'kimi']);
      assert(await page.eval('document.querySelector(\'.ph-pick[data-agent="claude@dead"]\').disabled'), 'greyed');
      assert(
        String(await page.eval('document.querySelector(\'.ph-pick[data-agent="claude@dead"]\').textContent')).includes(DOWN + '. Start it on your PC.'),
      );
      assert(!(await page.eval('document.querySelector(\'.ph-pick[data-agent="claude@strata"]\').disabled')), 'the working one is pickable');
      assert(String(await page.eval('document.querySelector(\'.ph-pick[data-agent="claude@strata"]\').textContent')).includes('Claude Code · strata'));
      await page.click('.ph-pick[data-agent="claude@strata"]');
      await page.waitFor('!!document.querySelector(".ph-pill[data-mode]")', 15000, 'lists');
      await page.eval(
        '(() => { const t = document.getElementById("phNewPrompt"); t.value = "Use the local model"; t.dispatchEvent(new Event("input")); })()',
      );
      await page.click('#phNewStart');
      const deadline = Date.now() + 10000;
      while (!s.liveCalls.some(([n]) => n === 'connect') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assertEquals(s.liveCalls.find(([n]) => n === 'connect')![1].provider, 'claude@strata');
    } finally {
      setAgentRows(null);
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

void phoneHeaders;
