/**
 * The inbox panel (approved prototype v3, 2026-11-13) in a real headless Chrome: chat.html against a Studio in this process with
 * fake chats. Two section headers alike ("Needs you", and "To review" when something finished), no title line of its own, no
 * key-hint row; each row is the request itself on line 1 and "chat title · project" on line 2; at most ONE row of neutral
 * actions (the default outlined in teal, nothing filled green or red); a risky command (force push) shows Review first, then the
 * full command and Allow / Deny, never Always allow; a failed turn offers Retry / Reply / Mark handled; the Working line and the
 * settings link share one foot line.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { remoteStudio } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;

Deno.test({
  ...OPTS,
  name: 'inbox panel v3: headers, one action row per card, neutral buttons, risky commands reviewed first, one foot line',
  ignore: !browserPath,
  async fn() {
    const s = await remoteStudio();
    s.ctx.transcripts = {
      root: s.state,
      sessions: () => Promise.resolve([]),
      agents: () => Promise.resolve([]),
      sessionCwd: () => Promise.resolve(null),
    } as unknown as typeof s.ctx.transcripts;
    const options = [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ];
    const chat = (n: number, title: string, command: string | null, attention: Json) => ({
      id: 'c' + n,
      provider: 'claude',
      sessionId: 'sess-' + n,
      cwd: s.root,
      busy: false,
      closed: false,
      attention,
      subagents: {},
      breadth: { sessionInfo: { title } },
      events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'work on ' + title } }],
      permissions: command
        ? [{ key: 'k' + n, params: { toolCall: { title: 'Bash', kind: 'execute', rawInput: { command } }, options } }]
        : ([] as Json[]),
      elicitations: [],
    });
    const needs = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
    s.chats.push(
      chat(1, 'Fix VAT', 'git push --force origin fix/vat', needs),
      chat(2, 'Checkout page', 'npm install stripe@18.0.0', needs),
      chat(3, 'PDF totals', null, {
        state: 'idle',
        needs: 0,
        turnEndedAt: null,
        busySince: null,
        failedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        error: 'Usage limit reached. It resets at 3:40 PM.',
      }),
    );
    const browser = await Browser.launch();
    try {
      const page = await browser.open('about:blank', 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor('!!window.AgentWorkspaceUI && !!document.querySelector(".ws-inbox-btn .ws-badge")', 20000, 'the badge');
      assertEquals(await page.eval<string>('document.querySelector(".ws-inbox-btn .ws-badge").textContent'), '3');
      await page.click('.ws-inbox-btn');
      await page.waitFor('!document.getElementById("wsInbox").hidden', 8000, 'inbox open');
      // the approvals' bodies are fetched once the rows show
      await page.waitFor(
        '!!document.querySelector(\'.ws-inbox-item[data-key="claude:sess-2"] .ws-qa-choice\')',
        10000,
        'the approval buttons',
      );
      await page.shot('inbox-panel-v3');
      const shape = await page.eval<Json>(`(() => {
        const pop = document.getElementById('wsInbox');
        const row = (k) => pop.querySelector('.ws-inbox-item[data-key="claude:' + k + '"]');
        // the words of the row's buttons (the snooze alarm clock, Inbox v3.1, is an icon: counted on its own below)
        const labels = (r) => Array.from(r.querySelectorAll('.ws-qa:not(.ws-qa-snooze)')).map((b) => b.textContent);
        const oneLine = (r) => { const a = r.querySelector('.ws-inbox-acts'); return a ? Math.round(a.getBoundingClientRect().height) : 0; };
        const foot = pop.querySelector('.ws-inbox-foot');
        const allow = row('sess-2').querySelector('.ws-qa.def');
        const cs = getComputedStyle(allow);
        return {
          heads: Array.from(pop.querySelectorAll('.ws-inbox-section')).map((h) => h.textContent),
          head: !!pop.querySelector('.ws-pop-head'),
          keys: !!pop.querySelector('.ws-inbox-keys'),
          order: Array.from(pop.querySelectorAll('.ws-inbox-item')).map((n) => n.dataset.key),
          what2: row('sess-2').querySelector('.ws-inbox-what').textContent,
          where2: row('sess-2').querySelector('.ws-inbox-where').textContent,
          age3: row('sess-3').querySelector('.ws-inbox-age').textContent,
          long3: row('sess-3').querySelector('.ws-inbox-age').classList.contains('long'),
          snoozes: ['sess-1', 'sess-2', 'sess-3'].map((k) => row(k).querySelectorAll('.ws-qa-snooze').length),
          risky: labels(row('sess-1')),
          plain: labels(row('sess-2')),
          failed: labels(row('sess-3')),
          rowHeights: ['sess-1', 'sess-2', 'sess-3'].map((k) => oneLine(row(k))),
          allowBg: cs.backgroundColor,
          allowBorder: cs.borderTopColor,
          accentLine: getComputedStyle(document.documentElement).getPropertyValue('--accent-line').trim(),
          footH: Math.round(foot.getBoundingClientRect().height),
          footText: foot.textContent,
          text: pop.textContent,
        };
      })()`);
      assertEquals(shape.heads, ['Needs you'], 'only the Needs you header: nothing finished');
      assertEquals(shape.head, false, 'no title line of its own');
      assertEquals(shape.keys, false, 'no key-hint row');
      assertEquals(shape.order, ['claude:sess-3', 'claude:sess-1', 'claude:sess-2'], 'the longest wait first');
      assertEquals(shape.what2, 'Run npm install stripe@18.0.0', 'line 1 is the command');
      assert(String(shape.where2).startsWith('Checkout page · '), `line 2 is title · project: ${shape.where2}`);
      assertEquals(shape.age3, '20m', 'the wait alone');
      assertEquals(shape.long3, true, 'orange after 15 minutes');
      assertEquals(shape.risky, ['Review', 'Deny'], 'a force push is reviewed first');
      assertEquals(shape.plain, ['Allow', 'Always allow', 'Deny']);
      assertEquals(shape.failed, ['Retry', 'Reply', 'Mark handled']);
      assertEquals(shape.snoozes, [1, 1, 1], 'a visible snooze icon on every Needs-you row');
      for (const h of shape.rowHeights as number[]) assert(h > 0 && h <= 26, `one action row per card: ${JSON.stringify(shape.rowHeights)}`);
      assertEquals(shape.allowBg, 'rgba(0, 0, 0, 0)', 'Allow is not filled');
      assert(String(shape.allowBorder).length > 0, 'Allow has its teal outline');
      assert((shape.footH as number) <= 34, `the Working line and the settings link share one line: ${shape.footH}px`);
      assert(!/waited|subagent|Finished|Open chat|Another agent|Four score/.test(String(shape.text)), String(shape.text));
      // Review shows the full command and what it does, then Allow / Deny (no Always allow)
      await page.eval('document.querySelector(\'.ws-inbox-item[data-key="claude:sess-1"] .ws-qa-review\').click()');
      const reviewed = await page.eval<Json>(`(() => {
        const r = document.querySelector('.ws-inbox-item[data-key="claude:sess-1"]');
        return { detail: r.querySelector('.ws-inbox-detail').textContent, labels: Array.from(r.querySelectorAll('.ws-qa:not(.ws-qa-snooze)')).map((b) => b.textContent) };
      })()`);
      assert(String(reviewed.detail).startsWith('$ git push --force origin fix/vat\nForce push'), String(reviewed.detail));
      assertEquals(reviewed.labels, ['Allow', 'Deny']);
      await page.shot('inbox-panel-v3-reviewed');
      assertEquals(page.errors, [], 'console errors');
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
