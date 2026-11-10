/**
 * server/desktop/folders.ts: the cases of work/test_new_project.py that exercise folders.py, plus parity with Python. No real dialog
 * is opened: pickFolder always gets an injected runner (the Python picker tests' fake subprocess.run), and the platform plans are
 * checked as data. Skipped: RouteTests and KindsRouteTests (HTTP routes, not ported here).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  checkPath,
  createFolder,
  FolderError,
  folderKinds,
  FolderMemory,
  hooks,
  isScratch,
  isWorktree,
  MAX_KINDS,
  OSASCRIPT,
  pickerPlan,
  pickFolder,
  type PickRunner,
  POWERSHELL_SCRIPT,
  START_ENV,
  startDir,
  startFolder,
  TimeoutExpired,
  validatePath,
} from '../../outputs/agent-studio/server/desktop/folders.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';
import { pyJsonDumps } from '../../outputs/agent-studio/server/core/py.ts';

const WIN = Deno.build.os === 'windows';

function reason(text: string, windows = true): string {
  try {
    validatePath(text, windows);
  } catch (error) {
    if (error instanceof FolderError) return error.code;
    throw error;
  }
  return 'ok';
}

const WINDOWS_CASES: Record<string, string> = {
  '': 'empty',
  '   ': 'empty',
  'C:\\': 'partial',
  'C:\\Users\\me\\': 'partial',
  work: 'relative',
  '\\\\srv\\share\\x': 'relative',
  'C:\\a\\b<c': 'invalid_name',
  'C:\\a\\b:c': 'invalid_name',
  'C:\\a\\"x"': 'invalid_name',
  'C:\\a\\x|y': 'invalid_name',
  'C:\\a\\x?': 'invalid_name',
  'C:\\a\\x*': 'invalid_name',
  'C:\\a\\x.': 'invalid_name',
  'C:\\a \\b': 'invalid_name',
  'C:\\a\\\\b': 'invalid_name',
  'C:\\a\\CON': 'invalid_name',
  'C:\\a\\nul.txt': 'invalid_name',
  'C:\\a\\Com3': 'invalid_name',
  'C:\\a\\LPT9': 'invalid_name',
  'C:\\a\\..\\b': 'escape',
  'C:\\a\\.\\b': 'escape',
  'C:\\a\\x\ty': 'invalid_name',
  'C:\\a\\good name': 'ok',
  'C:/a/b': 'ok',
  'c:\\a\\COM10': 'ok',
  'C:\\a\\console': 'ok',
};

Deno.test('Windows path rules', () => {
  for (const [text, expected] of Object.entries(WINDOWS_CASES)) assertEquals(reason(text), expected, JSON.stringify(text));
});

Deno.test('POSIX path rules', () => {
  assertEquals(reason('rel/x', false), 'relative');
  assertEquals(reason('/', false), 'partial');
  assertEquals(reason('/a/', false), 'partial');
  assertEquals(reason('/a/../b', false), 'escape');
  assertEquals(reason('/a/b:c', false), 'ok');
  assertEquals(reason('/a//b', false), 'invalid_name');
});

Deno.test('normalised parts', () => {
  assertEquals(validatePath(' c:/Repos/app ', true).slice(0, 3), ['c:\\Repos\\app', 'c:\\Repos', 'app']);
  assertEquals(validatePath('C:\\app', true).slice(0, 3), ['C:\\app', 'C:\\', 'app']);
});

Deno.test('validatePath matches Python, messages included', async () => {
  await using py = new PyParity();
  const extra = [
    'C:\\a\\<b>?',
    'C:\\' + 'x'.repeat(256),
    'x'.repeat(401),
    '/a/b/c',
    'C:\\a\\ AUX .txt',
    'Z:\\ü\\😀',
    5,
    null,
    'C:\\a\\b\n',
  ];
  for (const windows of [true, false]) {
    for (const text of [...Object.keys(WINDOWS_CASES), ...extra, 'rel/x', '/', '/a/', '/a/../b', '/a//b']) {
      let mine: unknown;
      try {
        mine = validatePath(text, windows);
      } catch (error) {
        mine = { error: (error as FolderError).message, code: (error as FolderError).code };
      }
      assertEquals(mine, await py.call('desktop_shim', 'folders_validate', [text, windows]), `${windows} ${JSON.stringify(text)}`);
    }
  }
});

function tempDir(): string {
  return Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'studio-folders-' }));
}

Deno.test({ name: 'check states (Windows)', ignore: !WIN }, async () => {
  const dir = tempDir();
  try {
    const fresh = checkPath(dir + '\\fresh');
    assertEquals([fresh.valid, fresh.reason, fresh.exists, fresh.parentExists, fresh.name], [true, 'new', false, true, 'fresh']);
    const old = checkPath(dir);
    assertEquals([old.valid, old.reason, old.exists, old.isDir], [true, 'existing', true, true]);
    const gone = checkPath(dir + '\\nope\\child');
    assertEquals([gone.valid, gone.reason, gone.parentExists], [false, 'parent_missing', false]);
    assert(gone.message.includes("doesn't exist"));
    assertEquals(checkPath(dir + '\\').reason, 'partial');
    assertEquals(typeof fresh.gitAvailable, 'boolean');
    Deno.writeTextFileSync(dir + '\\f.txt', 'x');
    assertEquals(checkPath(dir + '\\f.txt').reason, 'not_a_folder');
    await using py = new PyParity();
    for (const raw of [dir + '\\fresh', dir, dir + '\\nope\\child', dir + '\\', dir + '\\f.txt', '\\\\srv\\x', '//srv/x', 'rel', 7]) {
      assertEquals(checkPath(raw), await py.call('folders', 'check_path', [raw]), String(raw));
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({ name: 'create makes a single level only (Windows)', ignore: !WIN }, async () => {
  const dir = tempDir();
  try {
    const made = await createFolder(dir + '\\one', false);
    assert(osp.isdir(made.path));
    assertEquals(made.git, false);
    for (const bad of [dir + '\\a\\b', dir + '\\one', dir + '\\x<y', dir + '\\..\\esc', dir + '\\', 'rel']) {
      await assertRejects(() => createFolder(bad, false), FolderError);
    }
    assert(!osp.exists(dir + '\\a'));
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name).sort(), ['one']);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({ name: 'an existing folder is left untouched (Windows)', ignore: !WIN }, async () => {
  const dir = tempDir();
  try {
    const keep = dir + '\\keep';
    Deno.mkdirSync(keep);
    Deno.writeTextFileSync(keep + '\\f.txt', 'data');
    const error = await assertRejects(() => createFolder(keep, true), FolderError) as FolderError;
    assertEquals(error.code, 'exists');
    assertEquals(Deno.readTextFileSync(keep + '\\f.txt'), 'data');
    assert(!osp.exists(keep + '\\.git'));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({ name: 'git init (Windows, needs git)', ignore: !WIN || !hooks.gitPath() }, async () => {
  const dir = tempDir();
  try {
    const made = await createFolder(dir + '\\repo', true);
    assert(made.git);
    assert(osp.isdir(made.path + '\\.git'));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({ name: 'git missing or failing is reported, not fatal (Windows)', ignore: !WIN }, async () => {
  const dir = tempDir();
  const real = hooks.gitPath;
  try {
    hooks.gitPath = () => null;
    let made = await createFolder(dir + '\\nogit', true);
    assertEquals([made.git, made.gitError], [false, 'git not found']);
    assert(osp.isdir(made.path));
    hooks.gitPath = () => 'git';
    const calls: [string[], { cwd: string; timeout: number }][] = [];
    made = await createFolder(dir + '\\bad', true, (command, options) => {
      calls.push([command, options]);
      return Promise.resolve({ code: 1, stdout: '', stderr: 'boom\n' });
    });
    assertEquals([made.git, made.gitError], [false, 'boom']);
    assertEquals(calls[0][0], ['git', 'init']);
    assertEquals([calls[0][1].cwd, calls[0][1].timeout], [made.path, 20]);
    made = await createFolder(dir + '\\thrown', true, () => Promise.reject(new Error('cannot start')));
    assertEquals([made.git, made.gitError], [false, 'cannot start']);
  } finally {
    hooks.gitPath = real;
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({ name: 'start folder: home until a project is opened, then its parent (Windows)', ignore: !WIN }, async () => {
  const dir = tempDir();
  try {
    const memory = new FolderMemory(dir);
    const first = startFolder(memory, 'C:\\Users\\me');
    assertEquals([first.start, first.source], ['C:\\Users\\me', 'home']);
    const child = dir + '\\sub\\proj';
    Deno.mkdirSync(child, { recursive: true });
    assertEquals(memory.rememberProject(child), dir + '\\sub');
    const again = startFolder(new FolderMemory(dir), 'C:\\Users\\me'); // survives a restart
    assertEquals([again.start, again.source], [dir + '\\sub', 'last']);
    // the same bytes Python's json.dump writes
    assertEquals(
      Deno.readTextFileSync(osp.join(dir, 'studio-folders.json')),
      pyJsonDumps({ version: 1, lastParent: osp.join(dir, 'sub') }),
    );
    await using py = new PyParity();
    assertEquals(startFolder(null, 'H'), await py.call('folders', 'start_folder', [null, 'H']));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({ name: 'a vanished last parent falls back to home; remember refuses a missing folder (Windows)', ignore: !WIN }, () => {
  const dir = tempDir();
  try {
    const memory = new FolderMemory(null);
    const child = dir + '\\p';
    Deno.mkdirSync(child);
    memory.rememberProject(child);
    Deno.removeSync(child);
    memory._last = dir + '\\x';
    assertEquals(startFolder(memory, 'H').source, 'home');
    let error: unknown = null;
    try {
      new FolderMemory(null).rememberProject(dir + '\\missing');
    } catch (e) {
      error = e;
    }
    assert(error instanceof FolderError && error.code === 'parent_missing');
    assertEquals(new FolderMemory(dir + '\\nowhere').get(), '');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ---- picker --------------------------------------------------------------------------------------

/** A plan that "runs" nothing: the runner answers instead. */
const fakePlan = (seen: string[]) => (start: string) => {
  seen.push(start);
  return pickerPlan(start, 'windows', (n) => (n === 'powershell.exe' ? 'C:\\ps.exe' : null));
};

function runWith(stdout = '', code = 0, error: Error | null = null, start: unknown = 'C:\\') {
  const seen: string[] = [];
  const calls: { command: string[]; options: { timeout: number; env?: Record<string, string> } }[] = [];
  const runner: PickRunner = (command, options) => {
    calls.push({ command, options });
    if (error) return Promise.reject(error);
    return Promise.resolve({ code, stdout });
  };
  return { reply: pickFolder(start, { runner, plan: fakePlan(seen) }), calls, seen };
}

Deno.test('a picked path and a cancel', async () => {
  assertEquals(await runWith('{"path": "C:/Users/me/x"}\n').reply, [200, { path: 'C:/Users/me/x' }]);
  const run = runWith('{"path": null}');
  assertEquals(await run.reply, [200, { path: null }]);
  assertEquals(run.calls[0].command[0], 'C:\\ps.exe');
  assert(run.calls[0].command.includes('-EncodedCommand'));
  assertEquals(run.calls[0].options.timeout, 600);
});

Deno.test('a missing picker or a crash is a clean error', async () => {
  for (const [stdout, code] of [['{"error": "unavailable"}', 0], ['', 1], ['garbage', 0]] as const) {
    const [status, payload] = await runWith(stdout, code).reply;
    assertEquals([status, (payload as { code: string }).code], [503, 'picker_unavailable']);
    assert((payload as { error: string }).error.includes('Folder picker unavailable'));
  }
  assertEquals((await runWith('', 0, new Error('no powershell')).reply)[0], 503);
  assertEquals((await runWith('', 0, new TimeoutExpired()).reply)[0], 504);
  assertEquals(await pickFolder('', { plan: () => null, runner: () => Promise.reject(new Error('must not run')) }), [503, {
    error: 'Folder picker unavailable, type the path',
    code: 'picker_unavailable',
  }]);
});

Deno.test('only one picker at a time', async () => {
  const inner: unknown[] = [];
  const runner: PickRunner = async () => {
    inner.push(await pickFolder('', { plan: fakePlan([]), runner: () => Promise.reject(new Error('second picker must not start')) }));
    return { code: 0, stdout: '{"path": null}' };
  };
  assertEquals((await pickFolder('', { runner, plan: fakePlan([]) }))[0], 200);
  assertEquals((inner[0] as unknown[])[0], 409);
  assertEquals((await runWith('{"path": null}').reply)[0], 200, 'the lock is released afterwards');
});

Deno.test('the start folder is data, for an existing folder only', async () => {
  const run = runWith('{"path": null}', 0, null, WIN ? 'C:\\' : '/');
  await run.reply;
  assertEquals(run.seen[0], WIN ? 'C:\\' : '/');
  assertEquals(run.calls[0].options.env, { [START_ENV]: WIN ? 'C:\\' : '/' });
  assert(!run.calls[0].command.some((part) => part.includes('C:\\') && part !== 'C:\\ps.exe'), 'the start folder is never in the command');
  const odd = runWith('{"path": null}', 0, null, '; rm -rf / \x00');
  await odd.reply;
  assertEquals(odd.seen[0], '');
  const dir = tempDir();
  try {
    assertEquals(startDir(osp.join(dir, 'not', 'yet')), dir);
    assertEquals(startDir('   '), '');
    assertEquals(startDir('x'.repeat(401)), '');
    await using py = new PyParity();
    for (const raw of [osp.join(dir, 'not', 'yet'), dir, '', 5, 'C:\\', '; rm -rf / \x00', osp.join(dir, 'a\tb')]) {
      assertEquals(startDir(raw), await py.call('folders', '_start_dir', [raw]), String(raw));
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('each platform has its dialog, and none means 503', () => {
  const has = (...names: string[]) => (n: string) => (names.includes(n) ? '/bin/' + n : null);
  const win = pickerPlan('C:\\x', 'windows', has('powershell.exe'))!;
  assertEquals(win.name, 'powershell');
  assertEquals(win.env, { [START_ENV]: 'C:\\x' });
  assert(win.command.slice(0, 6).join(' ') === '/bin/powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass');
  const decoded = new TextDecoder('utf-16le').decode(Uint8Array.from(atob(win.command[7]), (c) => c.charCodeAt(0)));
  assertEquals(decoded, POWERSHELL_SCRIPT);
  assert(decoded.includes('FolderBrowserDialog') && decoded.includes(`$env:${START_ENV}`));
  assertEquals(win.parse(0, 'noise\n{"path":"C:\\\\a b"}\r\n'), { path: 'C:\\a b' });
  assertEquals(win.parse(0, '{"path": null}'), { path: null });
  assertEquals(win.parse(0, '{"error": "unavailable"}'), null);
  assertEquals(win.parse(1, '{"path": "C:\\\\x"}'), null);
  assertEquals(pickerPlan('', 'windows', has()), null);

  const mac = pickerPlan('/Users/me', 'darwin', has('osascript'))!;
  assertEquals(mac.command, ['/bin/osascript', '-e', OSASCRIPT, '/Users/me']);
  assertEquals(mac.parse(0, '/Users/me/proj/\n'), { path: '/Users/me/proj' });
  assertEquals(mac.parse(0, '\n'), { path: null });
  assertEquals(mac.parse(1, ''), null);
  assertEquals(pickerPlan('-rf', 'darwin', has('osascript'))!.command[3], './-rf');

  const zen = pickerPlan('/home/me', 'linux', has('zenity', 'kdialog'))!;
  assertEquals(zen.command, ['/bin/zenity', '--file-selection', '--directory', '--title=Choose a project folder', '--filename=/home/me/']);
  assertEquals([zen.parse(0, '/home/me/p\n'), zen.parse(1, ''), zen.parse(5, '')], [{ path: '/home/me/p' }, { path: null }, null]);
  assertEquals(pickerPlan('', 'linux', has('zenity'))!.command.length, 4);
  const kde = pickerPlan('/home/me', 'linux', has('kdialog'))!;
  assertEquals(kde.command, ['/bin/kdialog', '--title', 'Choose a project folder', '--getexistingdirectory', '/home/me']);
  assertEquals([kde.parse(0, '/x\n'), kde.parse(1, ''), kde.parse(2, '')], [{ path: '/x' }, { path: null }, null]);
  assertEquals(pickerPlan('/home/me', 'linux', has()), null);
});

// ---- folder kinds --------------------------------------------------------------------------------

Deno.test('scratch folders', () => {
  for (
    const path of [
      'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\b',
      'C:\\x\\scratch-2026-10-17-aab61c',
      '/home/me/scratch-2026-11-07-e1b5a5/sub',
    ]
  ) {
    assert(isScratch(path), path);
  }
  for (const path of ['C:\\REPOS\\demo-project-real\\mod', '/home/me/scratchpad', '']) assert(!isScratch(path), path);
});

Deno.test('worktree by path, by .git file, but not a submodule or a main checkout', () => {
  assert(isWorktree('C:\\repo\\.claude\\worktrees\\agent-1'));
  assert(isWorktree('/repo/.git/worktrees/x'));
  assert(!isWorktree('C:\\repo\\worktrees-notes'));
  const root = tempDir();
  try {
    const [linked, module, main] = ['nifty-feistel', 'sub', 'main'].map((n) => osp.join(root, n));
    for (const folder of [linked, module, main]) Deno.mkdirSync(folder);
    Deno.writeTextFileSync(osp.join(linked, '.git'), 'gitdir: C:/repos/agent-studio/.git/worktrees/nifty-feistel');
    Deno.writeTextFileSync(osp.join(module, '.git'), 'gitdir: ../.git/modules/sub');
    Deno.mkdirSync(osp.join(main, '.git'));
    assert(isWorktree(linked));
    assert(!isWorktree(module));
    assert(!isWorktree(main));
    assert(!isWorktree(osp.join(root, 'missing')));
    assert(!isWorktree('\\\\server\\share\\.claude\\worktrees\\x'), 'network paths are never looked at');
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test('kinds are bounded and ignore junk; match Python', async () => {
  const kinds = folderKinds(['C:\\a\\scratch-1', 5, null, '', 'x'.repeat(1000)]);
  assertEquals(Object.keys(kinds), ['C:\\a\\scratch-1']);
  assertEquals(kinds['C:\\a\\scratch-1'], { worktree: false, scratch: true });
  assertEquals(Object.keys(folderKinds(Array.from({ length: 1000 }, (_, i) => `/p${i}`))).length, MAX_KINDS);
  await using py = new PyParity();
  const paths = [
    'C:\\a\\scratch-9',
    'C:\\a\\.claude\\worktrees\\w',
    'C:\\a\\plain',
    '\\\\srv\\x',
    '/home/SCRATCH-x/y',
    'C:\\a\\.git\\worktrees',
  ];
  assertEquals(folderKinds(paths), await py.call('folders', 'folder_kinds', [paths]));
});
