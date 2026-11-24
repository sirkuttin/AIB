/**
 * The Changes tab's "left over" list may never claim landed work is unlanded (owner 2026-11-24: ~50 landed builders were listed as
 * "Waiting for a main chat to pick it up"). worktrees/project_changes.ts leftVerdict: only a positive "not in main" is 'unlanded';
 * unknown, errored, timed-out and missing-branch cases are 'unknown' (not listed). Real git repositories in a temp folder.
 */
import { assertEquals } from './_assert.ts';
import { leftVerdict, projectChanges, type Target } from '../../app/server/worktrees/project_changes.ts';

function git(cwd: string, ...args: string[]): string {
  const o = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], cwd, stdout: 'piped', stderr: 'piped' })
    .outputSync();
  if (!o.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(o.stderr)}`);
  return new TextDecoder().decode(o.stdout).trim();
}

/** A repository on main, and builders with their own worktrees. */
function fixture() {
  const root = Deno.makeTempDirSync({ prefix: 'aib-verdict-' });
  const repo = `${root}/repo`;
  Deno.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  Deno.writeTextFileSync(`${repo}/a.txt`, 'one\ntwo\nthree\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  /** A builder: branch + worktree, one commit of its own (`file` gets `text`). */
  const builder = (name: string, file: string, text: string, why: Target['why'] = 'refused', title = 'Job ' + name): Target => {
    const path = `${root}/${name}`;
    git(repo, 'worktree', 'add', '-q', '-b', `studio/${name}`, path, 'main');
    Deno.writeTextFileSync(`${path}/${file}`, text);
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'work of ' + name);
    return { id: name, kind: 'subagent', name: title, parent: { live: '', lasting: '' }, provider: '', branch: `studio/${name}`, path, base: '', state: 'left', why, working: false };
  };
  return { root, repo, builder, done: () => Deno.removeSync(root, { recursive: true }) };
}

Deno.test('leftVerdict: a squashed "AIB: subagent <title>" landing is landed, even when the files were edited since', async () => {
  const f = fixture();
  try {
    const t = f.builder('sub-1', 'feature.txt', 'first draft\n', 'refused', 'Build the feature');
    // AIB's landing commit: one squashed commit with the title; main's file then differs from the branch's
    Deno.writeTextFileSync(`${f.repo}/feature.txt`, 'rewritten by the landing\n');
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', 'AIB: subagent Build the feature');
    Deno.writeTextFileSync(`${f.repo}/feature.txt`, 'edited much later\nentirely\n');
    git(f.repo, 'commit', '-q', '-am', 'later edit');
    assertEquals(await leftVerdict(t, f.repo), 'landed');
  } finally {
    f.done();
  }
});

Deno.test('leftVerdict: work that is not in main is unlanded (listed); a dirty folder of landed commits is unlanded too', async () => {
  const f = fixture();
  try {
    const t = f.builder('sub-2', 'only-here.txt', 'never landed\n');
    assertEquals(await leftVerdict(t, f.repo), 'unlanded');
    const u = f.builder('sub-3', 'a.txt', 'one\ntwo\nthree\nfour\n', 'stopped');
    git(f.repo, 'cherry-pick', u.branch); // landed by hand
    assertEquals(await leftVerdict(u, f.repo), 'landed');
    Deno.writeTextFileSync(`${u.path}/more.txt`, 'edits of its own\n');
    // the verdict is cached by the folder's signature: a new file moves it
    Deno.writeTextFileSync(`${u.path}/.git-touch`, 'x');
    assertEquals(await leftVerdict({ ...u, path: u.path }, f.repo), 'unlanded');
  } finally {
    f.done();
  }
});

Deno.test('leftVerdict: unknown is not unlanded: a missing branch, a gone folder, an expired budget and an errored check are all unknown', async () => {
  const f = fixture();
  try {
    const t = f.builder('sub-4', 'x.txt', 'never landed\n');
    assertEquals(await leftVerdict({ ...t, branch: 'studio/does-not-exist' }, f.repo), 'unknown', 'a record whose branch is gone');
    assertEquals(await leftVerdict(t, f.root + '/nowhere'), 'unknown', 'a repository that cannot be read');
    assertEquals(await leftVerdict(t, f.repo, Date.now() - 1), 'unknown', 'the listing ran out of time before this check');
    assertEquals(await leftVerdict({ ...t, branch: '' }, f.repo), 'unknown', 'no branch on the record');
    assertEquals(await leftVerdict(t, f.repo), 'unlanded', 'with time, the same one is a positive verdict');
  } finally {
    f.done();
  }
});

Deno.test('leftVerdict: real-data shape: landed work whose worktree kept only test logs (why kept) is landed', async () => {
  const f = fixture();
  try {
    const t = f.builder('sub-5', 'a.txt', 'one\ntwo\nthree\nfive\n', 'kept', 'Fix the flaky tests');
    git(f.repo, 'cherry-pick', t.branch);
    Deno.mkdirSync(`${t.path}/.test-logs`);
    Deno.writeTextFileSync(`${t.path}/.test-logs/20261117-103855-deno-all.log`, 'log\n'); // the kept scratch file
    assertEquals(await leftVerdict(t, f.repo), 'landed');
  } finally {
    f.done();
  }
});

Deno.test('projectChanges: a left-over list holds only positively unlanded work', async () => {
  const f = fixture();
  try {
    const gone = f.builder('sub-6', 'g.txt', 'gone\n');
    const real = f.builder('sub-7', 'real.txt', 'really not landed\n');
    Deno.writeTextFileSync(`${f.root}/state.json`, '{}');
    const rec = (t: Target, over: Record<string, unknown> = {}) => ({
      id: t.id, kind: 'subagent', chat: 'c', lasting: 'claude:x', project: f.repo, folder: f.repo, slug: t.id, branch: t.branch, path: t.path, snapshot: git(t.path, 'rev-parse', 'HEAD~1'),
      tree: '', state: 'stopped', toolUseId: '', agentId: '', agentType: 'general-purpose', description: t.name, createdAt: 1, ...over,
    });
    const missing = { ...rec(gone), id: 'sub-8', branch: 'studio/deleted', description: 'Branch deleted' };
    const subs = Object.fromEntries([rec(gone), rec(real), missing].map((r) => [r.id, r])) as never;
    git(f.repo, 'cherry-pick', gone.branch); // sub-6 landed
    const out = await projectChanges({ folder: f.repo, stateDir: null, subs, helpers: [], fold: new Set(), unfold: new Set() });
    assertEquals((out.left as { id: string }[]).map((x) => x.id), ['sub-7']);
  } finally {
    f.done();
  }
});
