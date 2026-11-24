/** Files path guard: every spelling or link that reaches .git (or leaves the root) is refused; normal and git-ignored files still open. */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { git, HAVE_GIT, write } from './_git_repo.ts';
import * as osp from '../../app/server/platform/ospath.ts';
import * as files from '../../app/server/worktrees/files.ts';

const WIN = Deno.build.os === 'windows';

/** root/repo with a .git folder (a real repo when git is there), a normal file, an ignored file, and root/outside/secret.txt. */
function makeRepo(): { root: string; repo: string; dispose: () => void } {
  const root = Deno.realPathSync(
    Deno.makeTempDirSync({ prefix: 'aib-gitguard-' }),
  );
  const repo = osp.join(root, 'repo');
  Deno.mkdirSync(repo);
  if (HAVE_GIT) git(repo, 'init', '-q');
  else Deno.mkdirSync(osp.join(repo, '.git'));
  write(osp.join(repo, '.git', 'config'), '[core]\n'); // HAVE_GIT: overwrites git's config with a known body
  write(osp.join(repo, '.gitignore'), 'secret.env\n');
  write(osp.join(repo, 'README.md'), '# hi\n');
  write(osp.join(repo, 'secret.env'), 'TOKEN=1\n');
  Deno.mkdirSync(osp.join(repo, 'src'));
  write(osp.join(repo, 'src', 'a.ts'), 'export {};\n');
  Deno.mkdirSync(osp.join(root, 'outside'));
  write(osp.join(root, 'outside', 'secret.txt'), 's');
  return {
    root,
    repo,
    dispose: () => Deno.removeSync(root, { recursive: true }),
  };
}

/** fn throws a FilesError; `label` names the case in the failure. */
function refuses(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof files.FilesError) return;
    throw new Error(`${label}: threw ${error}, not a FilesError`);
  }
  throw new Error(`${label}: was not refused`);
}

/** Refused by both readFile and listDir (the read and list routes and the WSL helper all go through resolveInside). */
function refused(repo: string, rel: string): void {
  refuses(() => files.readFile(repo, rel), `read ${JSON.stringify(rel)}`);
  refuses(
    () => files.resolveInside(repo, rel),
    `resolve ${JSON.stringify(rel)}`,
  );
}

/** True when the OS itself resolves `rel` (below repo) into the real .git: the bypass is live on this machine. */
function reachesGit(repo: string, rel: string): boolean {
  try {
    const real = Deno.realPathSync(osp.join(repo, ...rel.split('/')));
    return real.toLowerCase().includes(osp.SEP + '.git' + osp.SEP) ||
      real.toLowerCase().endsWith(osp.SEP + '.git');
  } catch {
    return false;
  }
}

Deno.test('git guard: .git spellings are refused up front', () => {
  const r = makeRepo();
  try {
    for (
      const rel of [
        '.git/config',
        '.GIT/config',
        '.Git',
        'src/../.git/config',
        '.git/',
        './.git/config',
      ]
    ) refused(r.repo, rel);
    if (WIN) {
      for (
        const rel of [
          '.git./config',
          '.git /config',
          '.git.',
          '.git ',
          'GIT~1/config',
          'git~1/config',
          '.git::$INDEX_ALLOCATION/config',
        ]
      ) {
        refused(r.repo, rel);
        refuses(() => files.safeParts(rel), `safeParts ${JSON.stringify(rel)}`);
      }
    }
  } finally {
    r.dispose();
  }
});

Deno.test('git guard: the resolved-path check alone catches Windows aliases of .git', () => {
  if (!WIN) return;
  const r = makeRepo();
  try {
    const base = files.realRoot(r.repo);
    // Which of these Windows folds into .git depends on the component's place (a trailing space is dropped only from the last one);
    // every alias that does reach .git must be caught, and the trailing-dot ones always do.
    const aliases = [
      '.git./config',
      '.git.',
      '.git ',
      '.git /config',
      'GIT~1/config',
      'git~1',
    ];
    let live = 0;
    for (const rel of aliases) {
      if (!reachesGit(r.repo, rel)) {
        if (rel.toLowerCase().startsWith('git~1')) {
          console.log(
            `  (8.3 short names are off on this volume; ${rel} skipped)`,
          );
        } else if (rel.startsWith('.git.')) {
          throw new Error(`expected Windows to resolve ${rel} into .git`);
        }
        continue;
      }
      live++;
      const real = Deno.realPathSync(osp.join(r.repo, ...rel.split('/')));
      assert(
        files.hiddenBelow(real, base),
        `hiddenBelow missed ${rel} -> ${real}`,
      );
    }
    assert(live >= 3, `only ${live} aliases reached .git`);
    assert(!files.hiddenBelow(osp.join(base, 'src', 'a.ts'), base));
    assert(!files.hiddenBelow(osp.join(base, '.github', 'x.yml'), base));
    assert(!files.hiddenBelow(osp.join(base, '.gitignore'), base));
  } finally {
    r.dispose();
  }
});

Deno.test('git guard: .. forms and absolute paths stay refused', () => {
  const r = makeRepo();
  try {
    for (
      const rel of [
        '..',
        '../outside/secret.txt',
        'src/../../outside/secret.txt',
        '../repo/README.md',
        '/etc/passwd',
      ]
    ) refused(r.repo, rel);
    if (WIN) {
      for (
        const rel of [
          '..\\outside\\secret.txt',
          '...',
          'src\\..\\..\\outside\\secret.txt',
          'C:/Windows/win.ini',
        ]
      ) refused(r.repo, rel);
    }
  } finally {
    r.dispose();
  }
});

/** Makes a link; false when this machine refuses (no symlink right, no junction support). */
function tryLink(
  target: string,
  at: string,
  type: 'file' | 'dir' | 'junction',
): boolean {
  try {
    Deno.symlinkSync(target, at, { type } as Deno.SymlinkOptions);
    return true;
  } catch {
    return false;
  }
}

Deno.test('git guard: symlinks and junctions cannot reach outside the root or into .git', async () => {
  const r = makeRepo();
  try {
    const cases: [string, string, 'file' | 'dir' | 'junction'][] = [
      [osp.join(r.root, 'outside', 'secret.txt'), 'out-file.txt', 'file'],
      [osp.join(r.root, 'outside'), 'out-dir', 'dir'],
      [osp.join(r.repo, '.git'), 'git-dir', 'dir'],
      [osp.join(r.repo, '.git', 'config'), 'git-config', 'file'],
    ];
    if (WIN) {
      cases.push([osp.join(r.root, 'outside'), 'out-junction', 'junction']);
      cases.push([osp.join(r.repo, '.git'), 'git-junction', 'junction']);
    }
    const made: string[] = [];
    for (const [target, name, type] of cases) {
      if (!tryLink(target, osp.join(r.repo, name), type)) {
        console.log(`  (${type} link not allowed here; ${name} skipped)`);
        continue;
      }
      made.push(name);
      const isDir = type !== 'file';
      refused(
        r.repo,
        isDir ? name + (name.startsWith('git') ? '/config' : '/secret.txt') : name,
      );
      if (isDir) {
        assertThrows(() => files.resolveInside(r.repo, name), files.FilesError);
      }
    }
    const listing = await files.listDir(r.repo, '');
    for (const name of made) {
      assert(!listing.entries.some((e) => e.name === name), `${name} listed`);
    }
    // On Windows the junctions are the case that needs no admin rights, so at least those must have run.
    if (WIN) {
      assert(
        made.includes('out-junction') && made.includes('git-junction'),
        'junctions could not be made',
      );
    }
  } finally {
    r.dispose();
  }
});

Deno.test('git guard: normal, ignored and .git-like names still open', async () => {
  const r = makeRepo();
  try {
    Deno.mkdirSync(osp.join(r.repo, '.github'));
    write(osp.join(r.repo, '.github', 'ci.yml'), 'x: 1\n');
    write(osp.join(r.repo, 'notes~draft.md'), 'n\n');
    for (
      const [rel, text] of [
        ['README.md', '# hi\n'],
        ['secret.env', 'TOKEN=1\n'],
        ['src/a.ts', 'export {};\n'],
        ['.gitignore', 'secret.env\n'],
        [
          '.github/ci.yml',
          'x: 1\n',
        ],
        ['notes~draft.md', 'n\n'],
      ]
    ) {
      const read = files.readFile(r.repo, rel);
      assertEquals(read.text, text, rel);
    }
    const listing = await files.listDir(r.repo, '');
    const names = listing.entries.map((e) => e.name);
    for (
      const n of ['README.md', 'secret.env', 'src', '.gitignore', '.github']
    ) assert(names.includes(n), `${n} not listed`);
    assert(!names.includes('.git'));
    if (HAVE_GIT) {
      assert(
        listing.entries.find((e) => e.name === 'secret.env')!.ignored,
        'secret.env should be marked ignored',
      );
    }
    // A link inside the root to a normal file still opens.
    if (
      tryLink(
        osp.join(r.repo, 'src'),
        osp.join(r.repo, 'src-link'),
        WIN ? 'junction' : 'dir',
      )
    ) {
      assertEquals(
        files.readFile(r.repo, 'src-link/a.ts').text,
        'export {};\n',
      );
    }
  } finally {
    r.dispose();
  }
});
