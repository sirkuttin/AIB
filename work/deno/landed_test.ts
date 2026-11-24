/**
 * Is a builder branch's work already in main (worktrees/landed.ts branchLanded)? Real git repositories in a temp folder.
 * Every builder branch starts with an "AIB snapshot" commit that never lands, so ancestry cannot say; content can.
 */
import { assertEquals } from './_assert.ts';
import { branchLanded } from '../../outputs/agent-studio/server/worktrees/landed.ts';

function git(cwd: string, ...args: string[]): string {
  const o = new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], cwd, stdout: 'piped', stderr: 'piped' })
    .outputSync();
  if (!o.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(o.stderr)}`);
  return new TextDecoder().decode(o.stdout).trim();
}
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

/** A repository on main with one base commit (a.txt, b.txt). */
function repo(): { dir: string; write: (name: string, text: string) => void; commit: (msg: string) => string; done: () => void } {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-landed-' });
  git(dir, 'init', '-q', '-b', 'main');
  const write = (name: string, text: string) => {
    Deno.mkdirSync(`${dir}/${name}`.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    Deno.writeTextFileSync(`${dir}/${name}`, text);
  };
  const commit = (msg: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', msg);
    return git(dir, 'rev-parse', 'HEAD');
  };
  write('a.txt', lines(20, 'a'));
  write('b.txt', lines(20, 'b'));
  commit('base');
  return { dir, write, commit, done: () => Deno.removeSync(dir, { recursive: true }) };
}

/** A builder branch: an "AIB snapshot" commit (untracked folder files copied in), then the builder's own commit(s) made by `work`. */
function builder(r: ReturnType<typeof repo>, name: string, work: () => void) {
  git(r.dir, 'checkout', '-q', '-b', name, 'main');
  r.write('aib-docs/notes.md', 'untracked in main, copied by the snapshot\n');
  r.commit('AIB snapshot');
  work();
  git(r.dir, 'checkout', '-q', 'main');
}

Deno.test('landed: a squashed "AIB: subagent" landing is landed (the branch never reached main by ancestry)', async () => {
  const r = repo();
  try {
    builder(r, 'studio/sub-1', () => {
      r.write('a.txt', lines(20, 'a') + 'feature\n');
      r.write('new/feature.ts', 'export const x = 1;\n');
      r.commit('feature, first part');
      r.write('new/feature.ts', 'export const x = 2;\n');
      r.commit('feature, second part');
    });
    // AIB lands it as ONE commit
    git(r.dir, 'merge', '--squash', 'studio/sub-1', '-q');
    git(r.dir, 'reset', '-q', '--', 'aib-docs');
    Deno.removeSync(`${r.dir}/aib-docs`, { recursive: true });
    git(r.dir, 'commit', '-q', '-m', 'AIB: subagent Build the feature');
    const v = await branchLanded(r.dir, 'studio/sub-1', 'main');
    assertEquals([v.landed, v.why, v.files], [true, 'content', []]);
  } finally {
    r.done();
  }
});

Deno.test('landed: a cherry-picked builder commit is landed, snapshot commit ignored', async () => {
  const r = repo();
  try {
    builder(r, 'studio/sub-2', () => {
      r.write('b.txt', lines(20, 'b') + 'by the builder\n');
      r.commit('builder fix');
    });
    git(r.dir, 'cherry-pick', git(r.dir, 'rev-parse', 'studio/sub-2'));
    // main moves on afterwards, so the file no longer matches the branch's
    r.write('b.txt', lines(20, 'b') + 'by the builder\nmore\n');
    r.commit('later');
    const v = await branchLanded(r.dir, 'studio/sub-2', 'main');
    assertEquals([v.landed, v.why, v.own], [true, 'cherry', 0]);
  } finally {
    r.done();
  }
});

Deno.test('landed: a branch with only an AIB snapshot commit has no work of its own', async () => {
  const r = repo();
  try {
    builder(r, 'studio/sub-3', () => {});
    const v = await branchLanded(r.dir, 'studio/sub-3', 'main');
    assertEquals([v.landed, v.why], [true, 'snapshot-only']);
  } finally {
    r.done();
  }
});

Deno.test('landed: work main has rewritten since is landed (the branch\'s version was in main once; or the squash commit names it)', async () => {
  const r = repo();
  try {
    builder(r, 'studio/sub-4', () => {
      r.write('a.txt', lines(20, 'a') + 'edit one\n');
      r.commit('edit a');
    });
    // landed together with another change, so its patch-id differs from the builder's commit
    r.write('a.txt', lines(20, 'a') + 'edit one\n');
    r.write('b.txt', lines(20, 'b') + 'unrelated\n');
    r.commit('AIB: subagent Edit a');
    r.write('a.txt', lines(20, 'a') + 'edit one, rewritten\n');
    r.commit('lead rewrites it');
    const v = await branchLanded(r.dir, 'studio/sub-4', 'main');
    assertEquals([v.landed, v.why], [true, 'content'], JSON.stringify(v));
    // a squashed landing whose text was edited by the lead at the same time: no file ever matches, the landing commit's subject does
    builder(r, 'studio/sub-5', () => {
      r.write('b.txt', lines(20, 'b') + 'original text\n');
      r.commit('tweak the b text');
    });
    r.write('b.txt', lines(20, 'b') + 'edited text\n');
    r.commit('AIB: subagent Edit b');
    const named = await branchLanded(r.dir, 'studio/sub-5', 'main', { title: 'Edit b' });
    assertEquals([named.landed, named.why], [true, 'rewritten']);
    const unnamed = await branchLanded(r.dir, 'studio/sub-5', 'main', { title: 'Something else' });
    assertEquals([unnamed.landed, unnamed.why, unnamed.files], [false, 'unlanded', ['b.txt']]);
  } finally {
    r.done();
  }
});

Deno.test('landed: a truly unlanded branch is not landed and names its files; partly landed work stays unlanded', async () => {
  const r = repo();
  try {
    builder(r, 'studio/sub-6', () => {
      r.write('a.txt', lines(20, 'a') + 'never landed\n');
      r.write('c.txt', 'also never\n');
      r.commit('unlanded work');
    });
    r.write('b.txt', lines(20, 'b') + 'someone else\n');
    r.commit('unrelated main commit');
    const v = await branchLanded(r.dir, 'studio/sub-6', 'main');
    assertEquals([v.landed, v.why, v.own, v.files.sort()], [false, 'unlanded', 1, ['a.txt', 'c.txt']]);
    // half of it lands (a.txt by hand, different commit): c.txt is still missing
    r.write('a.txt', lines(20, 'a') + 'never landed\n');
    r.commit('lead copies a.txt');
    const half = await branchLanded(r.dir, 'studio/sub-6', 'main');
    assertEquals([half.landed, half.files], [false, ['c.txt']]);
    // AIB's own landing record says so: nothing is read
    assertEquals((await branchLanded(r.dir, 'studio/sub-6', 'main', { landedByRecord: true })).landed, true);
    // a branch that does not exist is unknown, never landed
    assertEquals((await branchLanded(r.dir, 'studio/none', 'main')).landed, false);
  } finally {
    r.done();
  }
});

Deno.test('landed: a hand-resolved cherry-pick that main edited since is landed by its lines; dropped lines are not', async () => {
  const r = repo();
  try {
    builder(r, 'studio/sub-7', () => {
      r.write('a.txt', lines(20, 'a') + 'function alpha() {}\nfunction beta() {}\nfunction gamma() {}\n');
      r.commit('add three functions');
    });
    // the lead landed the three functions with a changed header and moved them, then main edited the file again
    r.write('a.txt', 'header added by the lead\n' + lines(20, 'a') + 'function gamma() {}\nfunction beta() {}\nfunction alpha() {}\n');
    r.commit('lead lands it by hand');
    r.write('a.txt', 'header rewritten later\n' + lines(20, 'a') + 'function gamma() {}\nfunction beta() {}\nfunction alpha() {}\n');
    r.commit('main edits the file again');
    const v = await branchLanded(r.dir, 'studio/sub-7', 'main');
    assertEquals([v.landed, v.why], [true, 'lines'], JSON.stringify(v));
    builder(r, 'studio/sub-8', () => {
      r.write('b.txt', lines(20, 'b') + 'function delta() {}\nfunction epsilon() {}\n');
      r.commit('add two functions never landed');
    });
    const w = await branchLanded(r.dir, 'studio/sub-8', 'main');
    assertEquals([w.landed, w.files], [false, ['b.txt']]);
  } finally {
    r.done();
  }
});
