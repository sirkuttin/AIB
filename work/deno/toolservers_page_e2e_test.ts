/**
 * Per-project tool servers on the page, end to end (toolservers-ui.js, composer-chips.js, settings-ui.js): a real AIB with the scripted
 * agent and a headless Chrome/Edge on chat.html (no window), as in composer_focus_e2e_test.ts. The user's agent config is a temp
 * Claude config folder (one server that runs on this PC, `rea`, and one remote, `github`); every agent folder variable points into
 * temp folders, so nothing of the owner's is read.
 *
 *   - the chat's project is NEW, so it starts with servers on this PC off and remote ones on: the Tools chip under the message box
 *     says "2 of 3" (AIB's tools, github, rea off) and clicking it opens Settings > Tool servers on that project
 *   - the section: project picker on the chat's project, AIB's tools first and locked on, rea off with where it comes from, the agents
 *     that have it and what it costs (an estimate until a chat measured it), the summary line, the "Which agents follow this list" card
 *     (Maki honestly "can't follow it")
 *   - a switch saves at once; the apply line names the open chat that restarts when idle; the chip follows
 *   - the per-tool list: Find, All on / All off, one tool, "from this server's last start", the count on the button
 *   - New projects: its own list and the rule in words
 */
import { assert, assertEquals } from './_assert.ts';
import { agentTempDirSync } from './_agent_tmp.ts';
import { browserPath, Lab, settle } from './_scroll_lab.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const q = (s: string) => JSON.stringify(s);

Deno.test({
  name: 'tool servers on the page: chip, section, switches, apply line, per-tool list, New projects',
  ignore: !browserPath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const root = Deno.realPathSync(agentTempDirSync('aib-tspage-'));
    // AIB under test reads the agents' folders only inside the throwaway home a real agent gets (acp/launch_env.ts testHomeEnv), which
    // this test names: so nothing of the owner's is read. The user's Claude config: one server on this PC and one remote.
    const home = root + SEP + 'home';
    Deno.mkdirSync(home, { recursive: true });
    Deno.writeTextFileSync(
      home + SEP + '.claude.json',
      JSON.stringify({
        mcpServers: {
          rea: { type: 'stdio', command: 'node', args: ['rea.js'] },
          github: { type: 'http', url: 'https://example.invalid/mcp' },
        },
      }),
    );
    const env = { AGENT_STUDIO_TEST_HOME: home };
    const lab = await Lab.open(1600, 900, env);
    try {
      const page = lab.page;
      // AIB remembers the tool names a chat saw: seed what a chat of this server saw
      Deno.writeTextFileSync(
        lab.fx.state + SEP + 'tool-servers.json',
        JSON.stringify({
          v: 1,
          projects: {},
          seen: { rea: { tools: ['decompile_all', 'list_strings', 'open_binary'], at: Date.UTC(2026, 10, 27, 14, 2) } },
          memory: {},
        }),
      );
      const chat = await lab.chat('shop');
      await lab.select(chat);
      await settle(500);

      // the chip
      await page.waitFor(`document.querySelector('#chip-tools .chip-v')?.textContent === '2 of 3'`, 20000, 'the Tools chip says 2 of 3');
      assertEquals(await page.eval<string>(`document.querySelector('#chip-tools .chip-k').textContent`), 'Tools');
      await page.click('#chip-tools');
      await page.waitFor(`!!document.querySelector('[data-setting="tool-servers"] .ts-line')`, 20000, 'the Tool servers section');

      // the section
      const ids = () => page.eval<string[]>(`[...document.querySelectorAll('.ts-line[data-server]')].map((r) => r.dataset.server)`);
      assertEquals(await ids(), ['studio_artifact', 'github', 'rea']);
      const row = (id: string, what: string) =>
        page.eval<string>(
          `(() => { const r = document.querySelector('.ts-line[data-server=${q(id)}]'); return r ? String(${what}) : "none"; })()`,
        );
      assertEquals(
        await page.eval<string>(`document.getElementById('tsProject').selectedOptions[0].value.toLowerCase().includes('shop')`) as unknown,
        true,
        "the picker opens on the chat's project",
      );
      assertEquals(
        await row('studio_artifact', `r.querySelector('input').disabled + ',' + r.querySelector('input').checked`),
        'true,true',
        "AIB's tools are on and locked",
      );
      assert((await row('studio_artifact', `r.textContent`)).includes('always on'));
      assertEquals(await row('rea', `r.querySelector('input').checked`), 'false', 'rea (runs on this PC) is off in a new project');
      assertEquals(await row('github', `r.querySelector('input').checked`), 'true', 'github (remote) is on');
      assert((await row('rea', `r.querySelector('.ts-name span').textContent`)).includes('Your user settings'), 'where it comes from');
      assert((await row('rea', `r.querySelector('.ts-agents').textContent`)).includes('Claude Code'), 'the agents that have it');
      assertEquals(
        await row('rea', `r.querySelector('.ts-memory').textContent`),
        '1 process · ~60 MB a chat (estimate)',
        'memory, labelled as an estimate',
      );
      assertEquals(await row('github', `r.querySelector('.ts-memory').textContent`), 'Remote · no process here');
      assertEquals(
        await page.eval<string>(`document.getElementById('tsSummary').textContent`),
        'Each new chat here starts 0 local server processes (~0 MB, estimate); with everything on: 1 (~60 MB).',
      );
      const reach = await page.eval<string[]>(
        `[...document.querySelectorAll('[data-setting="tool-servers-agents"] li')].map((li) => li.dataset.agent + ':' + li.dataset.reach)`,
      );
      assertEquals(reach, [
        'claude:enforced',
        'codex:enforced',
        'gemini:enforced',
        'qwen:enforced',
        'copilot:enforced',
        'antigravity:partial',
        'maki:none',
      ]);
      assert((await page.eval<string>(`document.querySelector('[data-agent=maki]').textContent`)).includes("can't follow it"));

      // a switch saves at once; the apply line names the open chat; the summary and the chip follow
      await page.click('[data-server-toggle="rea"]');
      await page.waitFor(
        `document.getElementById('tsSummary').textContent.startsWith('Each new chat here starts 1 local server process (~60 MB, estimate).')`,
        15000,
        'summary after rea on',
      );
      await page.waitFor(`!!document.getElementById('tsApply')`, 15000, 'the apply line');
      const apply = await page.eval<string>(`document.getElementById('tsApply').textContent`);
      assert(
        apply.startsWith('New chats get this at once. 1 open chat (') && apply.endsWith('restarts to pick it up the next time it is idle.'),
        apply,
      );
      await page.click('.st-close');
      await page.waitFor(
        `document.querySelector('#chip-tools .chip-v')?.textContent === '3 of 3'`,
        20000,
        'the chip says 3 of 3 once rea is on',
      );

      // the per-tool list
      await page.click('#chip-tools');
      await page.waitFor(`!!document.querySelector('[data-expand="rea"]')`, 20000, 'the tools button');
      assertEquals(await page.eval<string>(`document.querySelector('[data-expand="rea"]').textContent`), '3 tools ▸');
      await page.click('[data-expand="rea"]');
      await page.waitFor(`!!document.getElementById('toolFilter')`, 10000, 'the tool list');
      assert(
        (await page.eval<string>(`document.querySelector('.ts-tbar .st-hint').textContent`)).startsWith(
          "Tool list from this server's last start, 27 Nov ",
        ),
      );
      await page.click('#toolFilter');
      await page.type('list');
      await page.waitFor(`document.querySelectorAll('.ts-tgrid input').length === 1`, 10000, 'Find narrows the list');
      assertEquals(await page.eval<string>(`document.querySelector('.ts-tgrid input').dataset.tool`), 'rea|list_strings');
      await page.click('[data-all="rea"]');
      await settle(300);
      await page.eval(`(() => { const f = document.getElementById('toolFilter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
      await page.click('[data-tool="rea|open_binary"]');
      await page.waitFor(`document.querySelector('[data-expand="rea"]').textContent === '2 of 3 tools ▾'`, 15000, 'one tool off');
      await page.click('[data-none="rea"]');
      await page.waitFor(`document.querySelector('[data-expand="rea"]').textContent === '0 of 3 tools ▾'`, 15000, 'All off');
      await page.click('[data-all="rea"]');
      await page.waitFor(`document.querySelector('[data-expand="rea"]').textContent === '3 tools ▾'`, 15000, 'All on');

      // New projects
      await page.eval(
        `(() => { const s = document.getElementById('tsProject'); s.value = '_new'; s.dispatchEvent(new Event('change')); })()`,
      );
      await page.waitFor(`!!document.querySelector('.ts-rule')`, 15000, 'the New projects rule');
      assert(
        (await page.eval<string>(`document.querySelector('.ts-rule').textContent`)).startsWith(
          'A new project starts with servers that run on this PC off and remote ones on',
        ),
      );
      assertEquals(await row('rea', `r.querySelector('input').checked`), 'false', 'New projects: rea is off by default');
      assertEquals(await page.eval<boolean>(`!document.getElementById('tsApply')`), true, 'no apply line for New projects');
      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
    } finally {
      await lab.close();
      for (let i = 0; i < 10; i++) {
        try {
          Deno.removeSync(root, { recursive: true });
          break;
        } catch {
          await settle(300);
        }
      }
    }
  },
});
