/**
 * Sync code review fixes, the parts that need no two-PC fixture: the longer secret-name list (S7), the branch in a project.switch item,
 * what git is doing in a folder (S2: merge, rebase, cherry-pick, stash lock, branch, detached HEAD, a linked worktree), and the
 * autostash setting (only on a repo that tracks aib-docs, never over a value the owner set).
 */
import { assert, assertEquals } from './_assert.ts';
import { isSecretPath } from '../../app/server/pcsync/rules.ts';
import { parseFrame } from '../../app/server/pcsync/frames.ts';
import { branchOf, ensureAutoStash, gitBusy } from '../../app/server/pcsync/gitstate.ts';
import { tempDir } from './_remote_fixture.ts';
import { DocStore } from '../../app/server/docs/store.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', { args, cwd, stdout: 'piped', stderr: 'piped' }).output();
  if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test('secret names: the design list is never synced, in any folder, with the file or the folder named so', () => {
  for (
    const p of [
      '.ssh/id_rsa',
      'keys/.ssh/config',
      '.aws/credentials',
      'a/.aws/config',
      '.gnupg/pubring.kbx',
      '.npmrc',
      'web/.npmrc',
      '.git-credentials',
      'vault.kdbx',
      'a/b/Vault.KDBX',
      'release.keystore',
      'app/debug.keystore',
      'owner.aibkey',
      'x/owner.AIBKEY',
      // the earlier list still stands
      '.env',
      '.env.local',
      'cert.pem',
      'a/b/server.key',
      'id_ed25519',
      'credentials.json',
      '.netrc',
    ]
  ) assert(isSecretPath(p), `${p} is a secret`);
  for (
    const p of ['notes.md', 'ssh-notes.md', 'sshd/readme.md', 'aws.md', 'keystore.md', 'npmrc.txt', 'envfile.txt', 'kdbx.md']
  ) assert(!isSecretPath(p), `${p} is not`);
});

Deno.test('project.switch carries the branch when it is a plain short name, and drops anything else', () => {
  const frame = (item: Record<string, unknown>) =>
    parseFrame(JSON.stringify({ t: 'batch', id: 'b1', project: 'a'.repeat(32), items: [{ op: 'project.switch', shared: true, docs: true, ...item }] }));
  const items = (r: ReturnType<typeof parseFrame>) => (r.ok && r.value.t === 'batch' ? r.value.items : null);
  assertEquals(items(frame({ branch: 'feature/x' }))?.[0].branch, 'feature/x');
  assertEquals(items(frame({}))?.[0].branch, undefined);
  assertEquals(items(frame({ branch: 'x'.repeat(201) }))?.[0].branch, undefined);
  assertEquals(items(frame({ branch: 'a\u0000b' }))?.[0].branch, undefined);
  assertEquals(items(frame({ branch: 42 }))?.[0].branch, undefined);
});

Deno.test('git state: a merge, rebase, cherry-pick, revert, bisect or a running git command is "busy"; the branch is read from HEAD', async () => {
  const dir = await tempDir('aib-gitstate-');
  await git(dir, 'init', '-q');
  const dot = `${dir}${sep}.git`;
  assertEquals(gitBusy(dir, dot), null, 'a fresh repo is idle');
  for (
    const [name, what, isDir] of [
      ['MERGE_HEAD', 'merge', false],
      ['CHERRY_PICK_HEAD', 'cherry-pick', false],
      ['REVERT_HEAD', 'revert', false],
      ['rebase-merge', 'rebase', true],
      ['rebase-apply', 'rebase', true],
      ['BISECT_LOG', 'bisect', false],
      ['index.lock', 'command', false],
    ] as [string, string, boolean][]
  ) {
    const p = `${dot}${sep}${name}`;
    if (isDir) Deno.mkdirSync(p);
    else Deno.writeTextFileSync(p, 'x\n');
    assert(gitBusy(dir, dot)?.includes(what), `${name} -> ${gitBusy(dir, dot)}`);
    Deno.removeSync(p, { recursive: true });
    assertEquals(gitBusy(dir, dot), null, `${name} gone`);
  }
  Deno.writeTextFileSync(`${dot}${sep}HEAD`, 'ref: refs/heads/feature/x\n');
  assertEquals(branchOf(dir, dot), 'feature/x');
  assertEquals(branchOf(dir), 'feature/x', 'also without the common dir given');
  Deno.writeTextFileSync(`${dot}${sep}HEAD`, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n');
  assertEquals(branchOf(dir, dot), 'detached a1b2c3d');
  assertEquals(branchOf(`${dir}${sep}nowhere`, `${dir}${sep}nowhere${sep}.git`), null);
});

Deno.test('git state: a linked worktree has its own HEAD and its own merge state, and the main one has the common dir', async () => {
  const dir = await tempDir('aib-gitstate-wt-');
  const main = `${dir}${sep}main`;
  Deno.mkdirSync(main);
  await git(main, 'init', '-q', '-b', 'trunk');
  await git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  const wt = `${dir}${sep}wt`;
  await git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  const common = `${main}${sep}.git`;
  assertEquals(branchOf(main, common), 'trunk');
  assertEquals(branchOf(wt, common), 'side');
  const wtGit = (await git(wt, 'rev-parse', '--git-dir')).replace(/\//g, sep);
  Deno.writeTextFileSync(`${wtGit}${sep}MERGE_HEAD`, 'a'.repeat(40) + '\n');
  assert(gitBusy(wt, common)?.includes('merge'), 'the worktree is merging');
  assertEquals(gitBusy(main, common), null, 'the main checkout is not');
});

Deno.test('autostash: turned on only when git tracks aib-docs, repo-locally, and never over a value the owner set', async () => {
  const dir = await tempDir('aib-autostash-');
  const none = `${dir}${sep}none`, tracked = `${dir}${sep}tracked`, owner = `${dir}${sep}owner`;
  for (const r of [none, tracked, owner]) {
    Deno.mkdirSync(r);
    await git(r, 'init', '-q');
  }
  assertEquals(await ensureAutoStash(none), [], 'no aib-docs tracked: nothing is touched');
  for (const r of [tracked, owner]) {
    Deno.mkdirSync(`${r}${sep}aib-docs${sep}plan`, { recursive: true });
    Deno.writeTextFileSync(`${r}${sep}aib-docs${sep}plan${sep}doc.aibdoc`, '{}');
    await git(r, 'add', 'aib-docs');
  }
  assertEquals(await ensureAutoStash(tracked), ['merge.autoStash', 'rebase.autoStash']);
  assertEquals(await git(tracked, 'config', '--local', '--get', 'merge.autoStash'), 'true');
  assertEquals(await git(tracked, 'config', '--local', '--get', 'rebase.autoStash'), 'true');
  assertEquals(await ensureAutoStash(tracked), [], 'a second time changes nothing');
  await git(owner, 'config', '--local', 'merge.autoStash', 'false');
  assertEquals(await ensureAutoStash(owner), ['rebase.autoStash'], 'the owner’s false stays');
  assertEquals(await git(owner, 'config', '--local', '--get', 'merge.autoStash'), 'false');
});

Deno.test('landSynced does not keep a closed doc open, but a doc someone opens during the landing stays open', async () => {
  const root = await tempDir('aib-land-');
  const project = `${root}${sep}project`;
  Deno.mkdirSync(`${project}${sep}docs`, { recursive: true });
  Deno.mkdirSync(`${root}${sep}s1`);
  Deno.mkdirSync(`${root}${sep}s2`);
  const maker = new DocStore(`${root}${sep}s1`, { idleMs: 60_000 });
  let text = '';
  try {
    const doc = await maker.open(project, 'plan', 'One\n\nTwo\n', 'user');
    await maker.flush(doc);
    text = await Deno.readTextFile(doc.file);
  } finally {
    await maker.close();
  }
  Deno.removeSync(`${project}${sep}aib-docs`, { recursive: true });
  const store = new DocStore(`${root}${sep}s2`, { idleMs: 60_000 });
  try {
    await store.landSynced(project, 'plan', text, 'ubuntu-pc');
    assert(await store.exists(project, 'plan'), 'the doc is on disk');
    assertEquals(store.docs.size, 0, 'a landed doc nobody opened is closed again');
    assert((await Deno.readTextFile(`${project}${sep}aib-docs${sep}plan${sep}01-page-1.md`)).includes('Two'), 'its page copy was rendered');
    // somebody opens it while it lands (an agent tool, the Docs tab): it stays open for them
    const landing = store.landSynced(project, 'plan', text, 'ubuntu-pc');
    const theirs = store.open(project, 'plan');
    await Promise.all([landing, theirs]);
    assertEquals(store.docs.size, 1, 'the doc someone opened is not closed under them');
    assert(store.docs.get((await theirs).id) === await theirs);
  } finally {
    await store.close();
  }
});
