/**
 * work/migrate/rename_private_to_aib_shared.ts (owner 2026-11-17): on temp copies of projects and a fake added-projects list in a
 * temp data folder (never the owner's). Windows: the dry run changes nothing and prints the plan; --apply renames private/, rewrites
 * AIB's exclude line in place (backup first), replaces the worktrees' private junction / folder with the aib-shared link, refuses a
 * project with both folders, leaves a committed private/ alone, is idempotent, and refuses while the data folder is locked.
 * WSL (AIB_WSL_E2E=<distro>): the same steps in the distro through wsl.exe, on a repo under /tmp.
 */
import { assert, assertEquals } from './_assert.ts';
import { commit, runGit, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import * as mig from '../../work/migrate/rename_private_to_aib_shared.ts';
import { linksTo } from '../../app/server/worktrees/shared_link.ts';
import { tryLockNow } from '../../app/server/platform/lock.ts';
import { join } from '../../app/server/platform/ospath.ts';

const WIN = Deno.build.os === 'windows';
const BLOCK = (line: string) => `# AIB: local only (shown in every chat; never committed)\r\n${line}\r\n# AIB: end\r\n`;
const read = (p: string) => Deno.readTextFileSync(p);
const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function repo(dir: string): string {
  Deno.mkdirSync(dir, { recursive: true });
  runGit(dir, 'init', '-q', '-b', 'main');
  runGit(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, 'a.txt', 'a\n');
  return dir;
}

function fixture() {
  const base = Deno.makeTempDirSync({ prefix: 'aib-mig-test-' });
  const data = join(base, 'data');
  Deno.mkdirSync(data);
  // A: set up by an older AIB: /private in AIB's block (CRLF, the user's own line first), private/ with notes, two worktrees
  const a = repo(join(base, 'alpha'));
  const exclude = join(a, '.git', 'info', 'exclude');
  Deno.writeTextFileSync(exclude, '# my own\r\n/scratch/\r\n' + BLOCK('/private'));
  write(a, 'private/notes.md', 'main notes\n');
  write(a, 'private/clash.md', 'main clash\n');
  const wtJ = join(base, 'wt', 'chat-1'), wtF = join(base, 'wt', 'helper-2');
  runGit(a, 'worktree', 'add', '-q', '-b', 'studio/chat-1', wtJ);
  runGit(a, 'worktree', 'add', '-q', '-b', 'studio/helper-2', wtF);
  Deno.symlinkSync(join(a, 'private'), join(wtJ, 'private'), WIN ? { type: 'junction' } : undefined); // an old junction
  write(wtF, 'private/draft.md', 'a stray draft\n'); // an old real folder with files
  write(wtF, 'private/clash.md', 'helper clash\n');
  // B: both folders: refused
  const b = repo(join(base, 'beta'));
  Deno.writeTextFileSync(join(b, '.git', 'info', 'exclude'), BLOCK('/private'));
  write(b, 'private/x.md', 'x');
  write(b, 'aib-shared/y.md', 'y');
  // C: commits private/ (the project's own): left alone
  const c = repo(join(base, 'gamma'));
  commit(c, 'private/own.md', 'own\n');
  Deno.writeTextFileSync(join(c, '.git', 'info', 'exclude'), BLOCK('/private'));
  const added = Object.fromEntries([a, b, c].map((p, i) => [`k${i}`, { path: p, at: 1 }]));
  Deno.writeTextFileSync(join(data, 'studio-added-projects.json'), JSON.stringify({ version: 1, added }));
  const opts = (apply: boolean): mig.Options => ({ apply, data, defaultData: false, extra: [], wsl: false });
  return { base, data, a, b, c, exclude, wtJ, wtF, opts, [Symbol.dispose]: () => Deno.removeSync(base, { recursive: true }) };
}

Deno.test({ name: 'migration: the dry run prints the plan and changes nothing; the AIB repo is never in a test run', ignore: !HAVE_GIT, async fn() {
  using f = fixture();
  const before = read(f.exclude);
  const r = await mig.run(f.opts(false));
  const text = r.lines.join('\n');
  console.log(text);
  assert(text.startsWith('Dry run'), text);
  assert(text.includes(`would rename ${join(f.a, 'private')} -> ${join(f.a, 'aib-shared')}`), text);
  assert(text.includes(`would rewrite AIB's line /private -> /aib-shared in ${f.exclude}`), text);
  assert(text.includes(`would remove the old link ${join(f.wtJ, 'private')} (the link only) [studio/chat-1]`), text);
  assert(text.includes(`would move the files of ${join(f.wtF, 'private')} into ${join(f.a, 'aib-shared')}`), text);
  assert(text.includes(`would link ${join(f.wtJ, 'aib-shared')} -> ${join(f.a, 'aib-shared')}`), text);
  assert(text.includes(`REFUSED: both ${join(f.b, 'private')} and ${join(f.b, 'aib-shared')} exist`), text);
  assert(text.includes("skip: the project commits private/, so it is the project's own"), text);
  assert(!text.includes(mig.AIB_REPO), 'a run with its own data folder never lists the AIB repo');
  assertEquals(r.refused, 1);
  assertEquals(read(f.exclude), before);
  assert(exists(join(f.a, 'private', 'notes.md')) && !exists(join(f.a, 'aib-shared')));
  assert(Deno.lstatSync(join(f.wtJ, 'private')).isSymlink);
  assertEquals([...Deno.readDirSync(f.base)].some((e) => e.name.includes('before-aib-shared')), false);
} });

Deno.test({ name: 'migration: --apply renames, rewrites the line in place with a backup, links the worktrees; idempotent', ignore: !HAVE_GIT, async fn() {
  using f = fixture();
  const before = read(f.exclude);
  const r = await mig.run(f.opts(true));
  const text = r.lines.join('\n');
  console.log(text);
  assertEquals(r.refused, 1, 'beta only');
  // the folder and the line
  assertEquals(read(join(f.a, 'aib-shared', 'notes.md')), 'main notes\n');
  assert(!exists(join(f.a, 'private')));
  assertEquals(read(f.exclude), '# my own\r\n/scratch/\r\n' + BLOCK('/aib-shared'), 'only AIB\'s line changed, CRLF kept');
  const backups = [...Deno.readDirSync(join(f.a, '.git', 'info'))].filter((e) => e.name.startsWith('exclude.before-aib-shared-'));
  assertEquals(backups.length, 1);
  assertEquals(read(join(f.a, '.git', 'info', backups[0].name)), before);
  // the worktrees: the old junction gone (link only), the old folder's files moved without overwriting, the new link in both
  for (const wt of [f.wtJ, f.wtF]) {
    assert(!exists(join(wt, 'private')), `${wt}: no private any more`);
    assert(linksTo(join(wt, 'aib-shared'), join(f.a, 'aib-shared')), `${wt}: linked`);
    assertEquals(runGit(wt, 'status', '--porcelain', '--untracked-files=all'), '', `${wt}: git shows nothing`);
  }
  assertEquals(read(join(f.a, 'aib-shared', 'draft.md')), 'a stray draft\n');
  assertEquals(read(join(f.a, 'aib-shared', 'clash.md')), 'main clash\n', 'never overwritten');
  assertEquals(read(join(f.a, 'aib-shared', 'clash (from helper-2).md')), 'helper clash\n');
  assertEquals(read(join(f.wtJ, 'aib-shared', 'notes.md')), 'main notes\n', 'through the link');
  assertEquals(runGit(f.a, 'status', '--porcelain'), '');
  // beta and gamma untouched
  assert(exists(join(f.b, 'private', 'x.md')) && exists(join(f.b, 'aib-shared', 'y.md')));
  assertEquals(read(join(f.b, '.git', 'info', 'exclude')), BLOCK('/private'));
  assert(exists(join(f.c, 'private', 'own.md')) && !exists(join(f.c, 'aib-shared')));
  // again: nothing to do
  const again = await mig.run(f.opts(true));
  const t2 = again.lines.join('\n');
  assert(t2.includes(`ok: ${join(f.a, 'aib-shared')} is there`) && t2.includes("ok: AIB's line is /aib-shared"), t2);
  assert(t2.includes(`ok: ${join(f.wtJ, 'aib-shared')} links to`), t2);
  assert(!/(renamed|rewrote|linked|moved) /.test(t2.split('\n').filter((l) => !l.includes('beta')).join('\n')), t2);
  assertEquals([...Deno.readDirSync(join(f.a, '.git', 'info'))].filter((e) => e.name.startsWith('exclude.before-')).length, 1);
} });

Deno.test({ name: 'migration: refused while AIB runs (its data folder lock is held)', ignore: !HAVE_GIT, async fn() {
  using f = fixture();
  const lock = await tryLockNow(join(f.data, 'desktop.lock'), true);
  try {
    const r = await mig.run(f.opts(true));
    assertEquals(r.refused, 1);
    assert(r.lines[0].startsWith('Refused: AIB is running'), r.lines[0]);
    assert(exists(join(f.a, 'private', 'notes.md')), 'nothing happened');
  } finally {
    lock.close();
  }
} });

Deno.test('migration: renamedLine changes AIB\'s line only, inside its block, keeping line endings', () => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const src = '/private\n# AIB: local only (shown in every chat; never committed)\r\n/private\r\n/notes\r\n# AIB: end\r\n';
  assertEquals(dec.decode(mig.renamedLine(enc.encode(src), '/private', '/aib-shared')!), src.replace('/private\r', '/aib-shared\r'));
  assertEquals(mig.renamedLine(enc.encode('/private\n'), '/private', '/aib-shared'), null, 'the user\'s own line is never touched');
});

// ---- WSL: the same, natively in the distro through wsl.exe ---------------------------------------------------------------------
const DISTRO = Deno.env.get('AIB_WSL_E2E') ?? '';
async function sh(script: string, ...args: string[]): Promise<string> {
  const p = await new Deno.Command('wsl.exe', { args: ['-d', DISTRO, '--exec', 'bash', '-c', script, 'bash', ...args], stdin: 'null', stdout: 'piped', stderr: 'piped' }).output();
  const out = new TextDecoder().decode(p.stdout).trim();
  if (p.code !== 0) throw new Error(`wsl: ${out} ${new TextDecoder().decode(p.stderr)}`);
  return out;
}

Deno.test({ name: 'migration (WSL): renames, rewrites the line, replaces a worktree private symlink with the aib-shared symlink', ignore: !DISTRO || !WIN, async fn() {
  const root = `/tmp/aib-mig-test-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await sh(
      'set -e; r="$1/app"; mkdir -p "$r" && cd "$r" && git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m i' +
        ' && printf "# AIB: local only (shown in every chat; never committed)\\n/private\\n# AIB: end\\n" >> .git/info/exclude' +
        ' && mkdir -p private && echo main > private/notes.md && git worktree add -q -b studio/chat-1 "$1/wt1" && ln -s "$r/private" "$1/wt1/private"' +
        ' && git worktree add -q -b studio/helper-2 "$1/wt2" && mkdir -p "$1/wt2/private" && echo draft > "$1/wt2/private/draft.md"',
      root,
    );
    const ref = `wsl://${DISTRO.toLowerCase()}${root}/app`;
    const data = Deno.makeTempDirSync({ prefix: 'aib-mig-wsl-' });
    Deno.writeTextFileSync(join(data, 'studio-added-projects.json'), JSON.stringify({ version: 1, added: { k: { path: ref, at: 1 } } }));
    const opts = (apply: boolean): mig.Options => ({ apply, data, defaultData: false, extra: [], wsl: true });
    const dry = await mig.run(opts(false));
    console.log(dry.lines.join('\n'));
    assertEquals(dry.refused, 0, dry.lines.join('\n'));
    assert(dry.lines.join('\n').includes(`would rename ${root}/app/private -> ${root}/app/aib-shared`), dry.lines.join('\n'));
    assertEquals(await sh('test -d "$1/app/private" && echo yes', root), 'yes', 'the dry run changed nothing');
    const done = await mig.run(opts(true));
    console.log(done.lines.join('\n'));
    assertEquals(done.refused, 0, done.lines.join('\n'));
    assertEquals(await sh('cat "$1/app/aib-shared/notes.md"; test -e "$1/app/private" && echo still || echo gone', root), 'main\ngone');
    assertEquals(await sh('grep -c "^/aib-shared$" "$1/app/.git/info/exclude"; grep -c "^/private$" "$1/app/.git/info/exclude" || true', root), '1\n0');
    assertEquals(await sh('ls "$1/app/.git/info" | grep -c before-aib-shared', root), '1');
    assertEquals(await sh('readlink "$1/wt1/aib-shared"; readlink "$1/wt2/aib-shared"', root), `${root}/app/aib-shared\n${root}/app/aib-shared`);
    assertEquals(await sh('test -e "$1/wt1/private" || test -e "$1/wt2/private" && echo left || echo none', root), 'none');
    assertEquals(await sh('cat "$1/app/aib-shared/draft.md"; git -C "$1/wt1" status --porcelain', root), 'draft');
    const again = await mig.run(opts(true));
    assert(again.lines.join('\n').includes("ok: AIB's line is /aib-shared"), again.lines.join('\n'));
    Deno.removeSync(data, { recursive: true });
  } finally {
    await sh('rm -rf -- "$1"', root).catch(() => {});
  }
} });
