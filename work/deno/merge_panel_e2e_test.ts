/**
 * The Changes tab's merge line after a merge, end to end: a real Studio (Deno web server + in-process agent host, temp state folder,
 * free port; never the live ports), the scripted agent in its own git worktree of a temp repo (a copy chat as AIB made them
 * before 2026-11-16), and a headless Chrome/Edge on
 * chat.html (no window).
 *
 * The owner clicks "Merge into main" (the real merge-request route: the line says "Merge requested. The chat is merging"), then the
 * agent's merge_into_project tool merges through the real tool route (/api/live/worktree/tool, with the chat's own artifact key).
 * The chat shows "Merged into main (1 commit)", and the Changes tab no longer says the chat is merging.
 *
 * Run (from outputs/agent-studio): deno task test merge_panel_e2e
 */
import { assert, assertEquals } from './_assert.ts';
import { git, HAVE_GIT } from './_git_repo.ts';
import { browserPath, Lab, settle, shown } from './_scroll_lab.ts';
import * as keys from '../../outputs/agent-studio/server/artifacts/keys.ts';

Deno.test({
  name: 'after a merge through merge_into_project, the Changes tab stops saying "The chat is merging"',
  ignore: !browserPath || !HAVE_GIT || Deno.build.os !== 'windows',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Owner decision 2026-11-16: new chats work in the project folder; a chat in its own copy (with Merge) is one made before that.
    // The test server takes the test-only ownCopy to make one.
    const lab = await Lab.open(1400, 900, { AIB_TEST_COPY_CHATS: '1' });
    try {
      const page = lab.page;
      const proj = lab.fx.workspace; // the project the sidebar shows
      git(proj, 'init', '-q', '-b', 'main');
      git(proj, 'config', 'user.name', 't');
      git(proj, 'config', 'user.email', 't@t');
      git(proj, 'config', 'core.autocrlf', 'false');
      Deno.writeTextFileSync(`${proj}\\README.md`, '# proj\n');
      git(proj, 'add', '-A');
      git(proj, 'commit', '-q', '-m', 'base');

      const chat = await lab.chat('', { ownCopy: true });
      const [ws, info] = await lab.web.get(`/api/live/worktree?id=${encodeURIComponent(chat.id)}`);
      assertEquals(ws, 200);
      assert(info.worktree === true, 'the chat works in its own worktree: ' + JSON.stringify(info));
      const st = await lab.web.state(chat.id);
      const cwd = String(st.cwd || st.workspace || '');
      assert(cwd && cwd.toLowerCase() !== proj.toLowerCase(), 'the chat folder is a worktree: ' + cwd);
      Deno.writeTextFileSync(`${cwd}\\feature.txt`, 'the chat made this\n');

      await chat.start();
      chat.say('Made feature.txt. WORKDONE');
      chat.end();
      await lab.select(chat);
      await shown(page, 'WORKDONE');

      await page.eval(`document.getElementById('paneTab-changes').click()`);
      await page.waitFor(
        `(() => { const b = document.querySelector('.cg-merge-btn'); return !!b && !b.hidden && !b.disabled; })()`,
        20000,
        'the Merge button',
      );
      await page.eval(`document.querySelector('.cg-merge-btn').click()`);
      await page.waitFor(`/Merge requested/.test(document.querySelector('.cg-merge-line').textContent)`, 20000, 'the requested line');
      const before = await page.eval<string>(`document.querySelector('.cg-merge-line').textContent`);

      // the agent's merge_into_project: the real tool route with the chat's own key
      keys.configure(lab.fx.state);
      const r = await fetch(`http://127.0.0.1:${lab.web.port}/api/live/worktree/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Artifact-Key': keys.issue(chat.id) ?? '' },
        body: JSON.stringify({ conversationId: chat.id, action: 'merge' }),
      });
      const merged = await r.json();
      assertEquals([r.status, merged.state], [200, 'merged'], JSON.stringify(merged));
      await shown(page, 'Merged into main', 'messages', 20000);

      // the side panel: the requested line goes once the merge is done
      await page.waitFor(
        `!/chat is merging/i.test((document.querySelector('.cg-merge-line') || {}).textContent || '')`,
        15000,
        'the line cleared',
      )
        .catch(() => 0);
      await settle(1500);
      const after = await page.eval<{ line: string; hidden: boolean; seen: string }>(
        `(() => { const l = document.querySelector('.cg-merge-line');
          return { line: l ? l.textContent : '', hidden: !l || l.hidden, seen: document.body.innerText }; })()`,
      );
      assert(!/chat is merging/i.test(after.seen), `the page still says the chat is merging: "${after.line}" (before: "${before}")`);
      assert(!/chat is merging|Merge requested/i.test(after.hidden ? '' : after.line), `still says "${after.line}" (before: "${before}")`);
      await settle(200);
      assertEquals(page.errors, [], 'no console errors');
    } finally {
      await lab.close();
    }
  },
});
