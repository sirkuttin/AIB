/**
 * 2026-11-27: a Claude subagent that finished never landed and was not in work_list (its slug sub-<chat>-30 had been used earlier that
 * day by another subagent). A slug is never used twice, and a landed verdict never follows a branch name to a new branch.
 */
import { assert, assertEquals } from './_assert.ts';
import { makeRepo, runGit } from './_worktree_fixtures.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { readSlugLedger, readSubagents, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { branchLanded, clearLandedMemo } from '../../app/server/worktrees/landed.ts';

const assertNotEquals = (a: unknown, b: unknown, m = ''): void => assert(a !== b, m || 'both are ' + String(a));

Deno.test({
  name: 'slug reuse: a number whose subagent was released is never handed out again (ledger, refs and records fence it)',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-slug-' }));
    try {
      const project = makeRepo(pathOf(dir, 'proj'));
      runGit(project, 'config', 'user.name', 't');
      runGit(project, 'config', 'user.email', 't@t');
      const CHAT = 'c0ffee00aa11bb22cc33dd44ee55ff66';
      const chat = { id: CHAT, provider: 'claude', lasting: 'claude:s1', folder: project, project, hooks: { readOnly: new Set<string>(), userWorktreeHook: false } };
      const state = pathOf(dir, 'state');
      const svc = new SubagentWorktrees(state, pathOf(state, 'worktrees'), (id) => (id === CHAT ? chat : null));
      const meta = (n: number) => ({ callId: `call_${n}`, agentType: 'general-purpose', description: `run ${n}` });
      const a = await svc.startExternal(CHAT, meta(1));
      assert(typeof a !== 'string', String(a));
      if (typeof a === 'string') return;
      assertEquals(a.slug, `sub-${CHAT.slice(0, 8)}-1`);
      // the designer run ends with no commits and is released: record, branch and worktree are gone
      await svc.endExternal(CHAT, 'call_1', true);
      assertEquals(await svc.release(a.id), 'removed');
      assertEquals(readSubagents(state)[a.id], undefined);
      assertEquals(runGit(project, 'branch', '--list', a.branch).trim(), '', 'its branch went with it');
      assert((readSlugLedger(state)[`sub-${CHAT.slice(0, 8)}`] ?? 0) >= 1, 'the ledger remembers the number');
      const b = await svc.startExternal(CHAT, meta(2));
      assert(typeof b !== 'string', String(b));
      if (typeof b === 'string') return;
      assertNotEquals(b.slug, a.slug, 'before the fix the next one was -1 again (the old record and branch were gone)');
      // even with the ledger lost, a discarded-work branch under the old number fences it
      Deno.removeSync(pathOf(state, 'subagent-slugs.json'));
      runGit(project, 'branch', `studio/discarded/${b.slug}`, 'HEAD');
      await svc.endExternal(CHAT, 'call_2', true);
      await svc.release(b.id);
      const c = await svc.startExternal(CHAT, meta(3));
      assert(typeof c !== 'string', String(c));
      if (typeof c === 'string') return;
      assertNotEquals(c.slug, a.slug);
      assertNotEquals(c.slug, b.slug, 'the discarded branch of the earlier subagent fences its slug');
    } finally {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* in use */ }
    }
  },
});

Deno.test("landed verdict memo: a branch made again under an old name never inherits the old branch's landed verdict", async () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-memo-' }));
  try {
    const project = makeRepo(pathOf(dir, 'proj'));
    runGit(project, 'config', 'user.name', 't');
    runGit(project, 'config', 'user.email', 't@t');
    clearLandedMemo();
    const main = runGit(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    // the first holder of the name: no work of its own (a designer run), judged landed
    runGit(project, 'branch', 'studio/sub-x-30');
    const first = await branchLanded(project, 'studio/sub-x-30', main, { title: 'Design' });
    assertEquals(first.landed, true);
    // it goes; the name is used again by a builder with its own commit that main does not have
    runGit(project, 'branch', '-D', 'studio/sub-x-30');
    runGit(project, 'checkout', '-q', '-b', 'studio/sub-x-30');
    Deno.writeTextFileSync(pathOf(project, 'feature.txt'), 'the builder work\nsecond line of work\n');
    runGit(project, 'add', '-A');
    runGit(project, 'commit', '-q', '-m', 'builder work');
    runGit(project, 'checkout', '-q', main);
    const second = await branchLanded(project, 'studio/sub-x-30', main, { title: 'Design' });
    assertEquals(second.landed, false, JSON.stringify(second));
    assertEquals(second.own, 1);
  } finally {
    clearLandedMemo();
    Deno.removeSync(dir, { recursive: true });
  }
});
