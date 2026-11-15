/**
 * GET /api/live/worktree must stay fast (the owner's log: 150-171 s for one chat whose worktree was 644 files from its base, because
 * touchedPaths started 2-3 git processes per file). Checks: touchedPaths runs a fixed number of git processes however many files
 * differ, and gives each a time-out; a hung git is killed at its time-out; concurrent status requests of one chat share one run, and a
 * run past the wait is answered "still checking" at once. Temp repos only, under work/slowreq-fixture/state/ (git-ignored).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { forgetWorktreeStatus, worktreeStatus } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { runGit } from './_worktree_fixtures.ts';

const ROOT = new URL('../slowreq-fixture/state/', import.meta.url);
const rootPath = () => decodeURIComponent(ROOT.pathname).replace(/^\/([A-Za-z]:)/, '$1');

async function tempDir(): Promise<string> {
  await Deno.mkdir(rootPath(), { recursive: true });
  return await Deno.makeTempDir({ dir: rootPath(), prefix: 'wt-' });
}

Deno.test('touchedPaths: a fixed number of git runs for 400 differing files, each with a time-out', async () => {
  const dir = await tempDir();
  try {
    runGit(dir, 'init', '-q', '-b', 'main');
    runGit(dir, 'config', 'core.autocrlf', 'true');
    const N = 400;
    for (let i = 0; i < N; i++) await Deno.writeTextFile(`${dir}/f${i}.txt`, `line ${i}\n`);
    await Deno.writeTextFile(`${dir}/gone.txt`, 'x\n');
    await Deno.writeTextFile(`${dir}/crlf.txt`, 'a\nb\n');
    runGit(dir, 'add', '-A');
    runGit(dir, 'commit', '-q', '-m', 'base');
    const base = runGit(dir, 'rev-parse', 'HEAD').trim();
    for (let i = 0; i < N; i++) await Deno.writeTextFile(`${dir}/f${i}.txt`, `changed ${i}\n`);
    await Deno.remove(`${dir}/gone.txt`);
    await Deno.writeTextFile(`${dir}/crlf.txt`, 'a\r\nb\r\n'); // line-ending noise only: not a change
    await Deno.writeTextFile(`${dir}/new file.txt`, 'new\n');

    let runs = 0;
    const timeouts: (number | undefined)[] = [];
    wt.testing.git = (args, cwd, options) => {
      runs++;
      timeouts.push(options?.timeout);
      return wt.realGit(args, cwd, options);
    };
    const t0 = performance.now();
    let touched: string[];
    try {
      touched = await wt.touchedPaths(dir, base);
    } finally {
      wt.testing.git = null;
    }
    const ms = performance.now() - t0;
    const want = [...Array.from({ length: N }, (_, i) => `f${i}.txt`), 'gone.txt', 'new file.txt'].sort();
    assertEquals([...touched].sort(), want);
    assert(runs <= 5, `git ran ${runs} times for ${N} files (was ~${2 * N + 2} before)`);
    assert(timeouts.every((t) => t === wt.TOUCHED_GIT_TIMEOUT), `every run has the time-out: ${timeouts}`);
    assert(ms < 15_000, `touchedPaths took ${Math.round(ms)} ms`);
    console.log(`touchedPaths: ${N + 2} touched files, ${runs} git runs, ${Math.round(ms)} ms`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('touchedPaths: unchanged worktree and only line-ending noise give nothing', async () => {
  const dir = await tempDir();
  try {
    runGit(dir, 'init', '-q', '-b', 'main');
    runGit(dir, 'config', 'core.autocrlf', 'true');
    await Deno.writeTextFile(`${dir}/a.txt`, 'a\nb\n');
    runGit(dir, 'add', '-A');
    runGit(dir, 'commit', '-q', '-m', 'base');
    assertEquals(await wt.touchedPaths(dir, 'HEAD'), []);
    await Deno.writeTextFile(`${dir}/a.txt`, 'a\r\nb\r\n');
    assertEquals(await wt.touchedPaths(dir, 'HEAD'), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a hung git is killed at its time-out', async () => {
  const dir = await tempDir();
  try {
    const script = `${dir}/hang.ts`;
    await Deno.writeTextFile(script, 'await new Promise((r) => setTimeout(r, 120_000));\n');
    wt.testing.gitCommand = [Deno.execPath(), 'run', '--no-config', '--quiet', script];
    const t0 = performance.now();
    try {
      const error = await assertRejects(() => wt.realGit(['status'], dir, { timeout: 2 }), wt.GitError);
      assert(error.message.includes('timed out'), error.message);
    } finally {
      wt.testing.gitCommand = null;
    }
    const ms = performance.now() - t0;
    assert(ms < 10_000, `the hung git was stopped after ${Math.round(ms)} ms`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('worktree status: concurrent requests share one run; a slow run is answered "still checking"', async () => {
  let runs = 0;
  let release!: (v: Record<string, unknown>) => void;
  const slow = () => {
    runs++;
    return new Promise<Record<string, unknown>>((resolve) => (release = resolve));
  };
  const t0 = performance.now();
  const answers = await Promise.all(Array.from({ length: 8 }, () => worktreeStatus('chat-a', slow, 100)));
  assert(performance.now() - t0 < 2_000, 'answered at the wait, not when the run ends');
  assertEquals(runs, 1, 'eight requests, one run');
  for (const a of answers) assertEquals(a.state, 'checking');
  // the next poll joins the same run, which now ends: its result comes back
  const next = worktreeStatus('chat-a', slow, 5_000);
  release({ worktree: true, state: 'ready', enabled: true });
  assertEquals((await next).state, 'ready');
  assertEquals(runs, 1);
  // another chat runs on its own
  assertEquals((await worktreeStatus('chat-b', () => Promise.resolve({ worktree: false }), 100)).worktree, false);
});

Deno.test('worktree status: a finished answer is not reused; a merge action drops a run that predates it', async () => {
  // The Merge button asks only when something changed (a turn ended, a commit landed): it must get the state after that change.
  // (A WSL chat's merge e2e saw 'nochanges' right after the chat committed: the answer from just before was reused for 1.5 s.)
  let state = 'nochanges', runs = 0;
  const now = () => (runs++, Promise.resolve({ worktree: true, state }));
  assertEquals((await worktreeStatus('chat-c', now, 1_000)).state, 'nochanges');
  state = 'ready'; // the chat committed its work
  assertEquals((await worktreeStatus('chat-c', now, 1_000)).state, 'ready');
  assertEquals(runs, 2);
  // a run still going when a merge lands is not joined afterwards: the next request runs again
  let release!: (v: Record<string, unknown>) => void;
  const old = worktreeStatus('chat-c', () => new Promise((resolve) => (release = resolve)), 50);
  assertEquals((await old).state, 'checking');
  forgetWorktreeStatus('chat-c');
  state = 'nochanges'; // merged
  assertEquals((await worktreeStatus('chat-c', now, 1_000)).state, 'nochanges');
  release({ worktree: true, state: 'ready' }); // the old run ends late: it does not take the new run's place
  assertEquals((await worktreeStatus('chat-c', now, 1_000)).state, 'nochanges');
});

Deno.test('changes route: identical concurrent requests share one run', async () => {
  const { shared } = await import('../../outputs/agent-studio/server/web/studio_routes.ts');
  const runs = new Map<string, Promise<number>>();
  let started = 0;
  const run = () => (started++, new Promise<number>((r) => setTimeout(() => r(started), 50)));
  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => shared(runs, 'k', run)));
  assertEquals(started, 1);
  assert(answers.every((a) => a === 1));
  assertEquals(runs.size, 0, 'forgotten once answered');
  await shared(runs, 'k', run);
  assertEquals(started, 2, 'a later request runs again');
});
