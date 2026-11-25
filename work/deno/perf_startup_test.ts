/**
 * Request budgets after a restart (owner 2026-11-24: /api/agents 28 s, project changes 12 s, others 1.5 s, with ~90 builder branches
 * and worktrees). A scratch repository with 90 left-over builders (squashed landings, hand cherry-picks, a file main renamed since,
 * unlanded work): the project's Changes never waits for git beyond its small budget, verdicts are kept (on disk too), one listing is
 * ONE ref read, and the liveness check shares one process snapshot. Margins are generous: the targets are 1 s, the asserts 3 s.
 */
import { assert, assertEquals } from './_assert.ts';
import { flushLeftCache, landedChecked, projectChanges, settleChecks, useLeftCache } from '../../app/server/worktrees/project_changes.ts';
import { flushLandedMemo, landedReads, useLandedMemo } from '../../app/server/worktrees/landed.ts';
import { realProcesses, snapshotReads, taggedSince } from '../../app/server/platform/proc_env.ts';
import type { SubagentRecord } from '../../app/server/subagents/service.ts';

const N = 90;

function git(cwd: string, ...args: string[]): string {
  const o = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  if (!o.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(o.stderr)}`);
  return new TextDecoder().decode(o.stdout).trim();
}

Deno.test('startup budgets: project changes with 90 left-over builders, cold, warm and after a restart', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-perf-' }));
  const repo = `${root}/repo`;
  const stateDir = `${root}/state`;
  Deno.mkdirSync(repo);
  Deno.mkdirSync(stateDir);
  try {
    git(repo, 'init', '-q', '-b', 'main');
    Deno.mkdirSync(`${repo}/old`);
    for (let i = 0; i < 20; i++) Deno.writeTextFileSync(`${repo}/old/f${i}.txt`, `file ${i}\nline two\nline three\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    const subs: Record<string, SubagentRecord> = {};
    let unlanded = 0;
    const landLater: number[] = [];
    for (let i = 0; i < N; i++) {
      const id = `sub-${i}`;
      const path = `${root}/wt-${id}`;
      git(repo, 'worktree', 'add', '-q', '-b', `studio/${id}`, path, 'main');
      const kind = i % 3;
      // builders 0.. touch their own file; every 5th edits one of the shared files main renames later
      const file = i % 5 === 0 ? `old/f${i % 20}.txt` : `own/${id}.txt`;
      Deno.mkdirSync(`${path}/own`, { recursive: true });
      Deno.writeTextFileSync(`${path}/${file}`, i % 5 === 0 ? `file ${i % 20}\nline two\nline three\nadded by ${id}\n` : `work of ${id}\nmore\n`);
      git(path, 'add', '-A');
      git(path, 'commit', '-q', '-m', `work of ${id}`);
      if (kind === 0) landLater.push(i);
      else if (kind === 1 || i % 5 === 0) unlanded++; // (a hand cherry-pick of a shared file would conflict: those stay unlanded)
      subs[id] = {
        id, kind: 'subagent', chat: 'c1', lasting: 'claude:one', project: repo, folder: repo, slug: id, branch: `studio/${id}`, path, snapshot: baseSha, tree: '',
        state: 'stopped', toolUseId: '', agentId: '', agentType: 'general-purpose', description: `Job ${id} end`, createdAt: i + 1,
      } as unknown as SubagentRecord;
    }
    // main: kind 0 landed squashed, kind 2 cherry-picked by hand; main moves a folder since (a rename)
    for (const i of landLater) {
      const file = i % 5 === 0 ? `old/f${i % 20}.txt` : `own/sub-${i}.txt`;
      git(repo, 'checkout', '-q', `studio/sub-${i}`, '--', file);
      git(repo, 'commit', '-q', '-m', `AIB: subagent Job sub-${i} end`);
    }
    for (let i = 2; i < N; i += 3) {
      if (i % 5 === 0) continue;
      git(repo, 'cherry-pick', `studio/sub-${i}`);
    }
    git(repo, 'mv', 'old', 'app');
    git(repo, 'commit', '-q', '-m', 'move old to app');

    const args = { folder: repo, stateDir, subs, helpers: [], fold: new Set<string>(), unfold: new Set<string>() };
    useLeftCache(`${stateDir}/left-cache.json`);
    useLandedMemo(`${stateDir}/landed-memo.json`);

    // cold: nothing is known; the request answers within its small budget and the checks go on behind it
    let t = performance.now();
    await projectChanges(args);
    const cold = performance.now() - t;
    assert(cold < 3000, `cold listing took ${Math.round(cold)} ms`);

    // the background finishes; the list is the same as a full check would give
    await settleChecks();
    t = performance.now();
    const warm = await projectChanges(args) as { left: unknown[] };
    const warmMs = performance.now() - t;
    assertEquals(warm.left.length, unlanded, 'only the unlanded builders are listed');
    assert(warmMs < 3000, `warm listing took ${Math.round(warmMs)} ms`);

    // a restart: the caches come from disk; no builder is decided again
    flushLeftCache();
    flushLandedMemo();
    useLeftCache(`${stateDir}/left-cache.json`);
    useLandedMemo(`${stateDir}/landed-memo.json`);
    const checks = landedChecked.n, computed = landedReads.computed;
    t = performance.now();
    const after = await projectChanges(args) as { left: unknown[] };
    const restartMs = performance.now() - t;
    assertEquals(after.left.length, unlanded, 'the same list after a restart');
    assert(restartMs < 3000, `listing after a restart took ${Math.round(restartMs)} ms`);
    assertEquals(landedChecked.n, checks, 'no builder is checked again after a restart');
    assertEquals(landedReads.computed, computed, 'no verdict is computed again after a restart');
    console.log(`perf: cold ${Math.round(cold)} ms, warm ${Math.round(warmMs)} ms, after restart ${Math.round(restartMs)} ms`);
  } finally {
    useLeftCache(null);
    useLandedMemo(null);
    try {
      Deno.removeSync(root, { recursive: true });
    } catch { /* a temp folder */ }
  }
});

Deno.test('startup budgets: eleven chats\' liveness checks in one tick read the process list once', () => {
  const before = snapshotReads.lists;
  const t = performance.now();
  for (let chat = 0; chat < 11; chat++) taggedSince(0, realProcesses);
  const ms = performance.now() - t;
  assert(snapshotReads.lists - before <= 1, `${snapshotReads.lists - before} process lists for 11 chats`);
  const again = snapshotReads.cookieReads;
  taggedSince(0, realProcesses, true); // a fresh list reads no environment it has already read
  assert(snapshotReads.cookieReads - again < 30, 'environments are read once per process');
  console.log(`perf: 11 liveness checks ${Math.round(ms)} ms`);
});
