/**
 * The fail-closed rule for WSL refs (docs/wsl/design.md section 11 item 3): every gate that only makes sense for a Windows folder
 * refuses a `wsl://` ref (and on Windows a drive-less path like /home/u) before anything touches the disk; the predicates of
 * ospath / pypath answer false; spawn, write and delete sites throw. Plus the WSL-aware desktop code: added projects (a ref stored
 * with its `wsl` part, no disk read), folder presence (a ref counts as present), project delete (refused), folders (reason `wsl`,
 * the picker's share path made into a ref), editors (VS Code / Cursor `--remote wsl+<distro>`, Reveal through wsl.exe), and
 * wsl/detect.ts on a scripted registry. Temp folders only; no program is started (editors use a recording popen).
 */
import { assert, assertEquals } from './_assert.ts';
import * as osp from '../../app/server/platform/ospath.ts';
import { executable, isFile, pyStat, resolvePath, which } from '../../app/server/platform/pypath.ts';
import { assertWindowsLocal } from '../../app/server/platform/location.ts';
import { isNetworkPath, refuseNetworkPath } from '../../app/server/web/security.ts';
import { FolderPresence } from '../../app/server/desktop/folder_presence.ts';
import {
  deleteFolder,
  inspect,
  projectKey,
  refusal,
  Refused,
  type TrashLayer,
  WSL_REFUSAL,
} from '../../app/server/desktop/project_delete.ts';
import { AddedProjects } from '../../app/server/desktop/added_projects.ts';
import {
  checkPath,
  checkProject,
  folderKinds,
  isWorktree,
  pickedPath,
  pickFolder,
  runCommand,
  startDir,
  worktreeParent,
} from '../../app/server/desktop/folders.ts';
import {
  buildWslCommand,
  cleanPathText,
  type Entry,
  knownRoots,
  Launcher,
  type PopenOptions,
} from '../../app/server/desktop/editors.ts';
import { type DetectHooks, detectNow, wslExePath } from '../../app/server/wsl/detect.ts';
import { realRoot, resolveInside, safeParts } from '../../app/server/worktrees/files.ts';
import { checkShape } from '../../app/server/worktrees/outside_files.ts';
import { repoBranch } from '../../app/server/worktrees/chat_folders.ts';
import { checkCwd } from '../../app/server/terminal/sessions.ts';
import { runGit } from '../../app/server/worktrees/changes.ts';

const WIN = Deno.build.os === 'windows';
const REF = 'wsl://ubuntu/home/u/app';

function throwsName(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).name + ':' + ((error as { code?: string }).code ?? '');
  }
  return '';
}

async function rejectsName(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as Error).name;
  }
  return '';
}

Deno.test('ospath and pypath never look a ref up on this PC: predicates false, getsize / pyStat / resolvePath NotFound', () => {
  for (const p of [REF, 'wsl://ubuntu/']) {
    assertEquals([
      osp.exists(p),
      osp.isdir(p),
      osp.isfile(p),
      osp.islink(p),
      isFile(p),
      executable(p),
    ], [false, false, false, false, false, false]);
    assertEquals(osp.abspath(p), p, 'never joined onto the current folder');
    assertEquals(osp.realpath(p), p);
    assertEquals(throwsName(() => osp.getsize(p)), 'NotFound:');
    assertEquals(throwsName(() => pyStat(p)), 'NotFound:');
    assertEquals(throwsName(() => resolvePath(p)), 'NotFound:');
    assertEquals(which(p), null);
  }
});

Deno.test({
  name: 'on Windows a drive-less path is foreign too: /Windows is not C:\\Windows',
  ignore: !WIN,
  fn() {
    assert(osp.isdir('C:\\Windows'));
    assertEquals([osp.isdir('/Windows'), osp.exists('/Windows'), isFile('/Windows/explorer.exe')], [false, false, false]);
    assertEquals(osp.abspath('/home/u'), '/home/u');
    assertEquals(osp.realpath('/home/u'), '/home/u');
  },
});

Deno.test('spawn sites throw: folders.runCommand, changes.runGit and assertWindowsLocal', async () => {
  assertEquals(throwsName(() => assertWindowsLocal(REF)), 'RangeError:');
  assertEquals(throwsName(() => assertWindowsLocal(WIN ? 'C:\\x' : '/x')), '');
  assertEquals(await rejectsName(() => runCommand(['git', '--version'], { cwd: REF, timeout: 5 })), 'RangeError');
  assertEquals(await rejectsName(() => runGit(['status'], REF)), 'RangeError');
});

Deno.test('isNetworkPath is unchanged: UNC (also \\\\wsl$) refused there; a ref is not a network path but every gate refuses it', () => {
  assert(isNetworkPath('\\\\wsl$\\Ubuntu\\home') && isNetworkPath('\\\\wsl.localhost\\Ubuntu') && !isNetworkPath(REF));
  assertEquals(refuseNetworkPath(REF), REF);
  assertEquals(throwsName(() => safeParts('wsl://x')), 'FilesError:bad_path');
  assertEquals(throwsName(() => realRoot(REF)), 'FilesError:bad_root');
  assertEquals(throwsName(() => resolveInside(REF, 'a')), 'FilesError:bad_root');
  assertEquals(throwsName(() => checkShape(REF)), 'FilesError:bad_path');
  assertEquals(throwsName(() => checkCwd(REF)), 'TerminalError:bad_folder');
  assertEquals(repoBranch(REF), '');
  assertEquals(throwsName(() => cleanPathText(REF)), 'EditorError:path_refused');
  if (WIN) {
    assertEquals(throwsName(() => checkCwd('/home/u')), 'TerminalError:bad_folder');
    assertEquals(throwsName(() => checkShape('/home/u')), 'FilesError:bad_path');
  }
});

Deno.test('folder presence: a ref is never stat-ed and counts as present (a stopped distro does not hide its projects)', () => {
  let stats = 0;
  const presence = new FolderPresence({
    stat: () => (stats++, false),
    now: () => 0,
  });
  assertEquals(presence.gone([REF, 'wsl://debian/srv']), []);
  assertEquals(stats, 0);
  if (WIN) assertEquals(presence.isGone('/home/u'), false);
});

Deno.test("project keys: a ref keys case-sensitively with the distro folded, the same as the page's generic rule", () => {
  assertEquals(projectKey('wsl://ubuntu/home/u/App'), 'p:wsl:/ubuntu/home/u/App');
  assertEquals(projectKey('wsl://Ubuntu/home/u/App'), 'p:wsl:/ubuntu/home/u/App', 'distro folded');
  assert(
    projectKey('wsl://ubuntu/home/u/App') !==
      projectKey('wsl://ubuntu/home/u/app'),
    'Foo and foo are two projects',
  );
  assertEquals(projectKey('wsl://ubuntu/'), 'p:wsl:/ubuntu');
  // the generic rule (what sidebar-ui.js pathKey does) gives the same key for a canonical ref
  const generic = (p: string) => 'p:' + p.replace(/\/{2,}/g, '/').split('/').filter(Boolean).join('/');
  assertEquals(generic('wsl://ubuntu/home/u/App'), projectKey('wsl://ubuntu/home/u/App'));
});

Deno.test('project delete: a WSL project is never deleted from disk (phase 1); the trash layer is never asked', async () => {
  let asked = 0;
  const layer: TrashLayer = {
    kind: () => (asked++, Promise.resolve('recycle')),
    trash: () => (asked++, Promise.resolve()),
  };
  const guard = {
    home: WIN ? 'C:\\Users\\u' : '/home/u',
    own: [],
    projects: [],
    remoteDrive: () => false,
  };
  assertEquals(refusal(REF, guard), WSL_REFUSAL);
  assertEquals(await inspect(REF, guard, layer), {
    exists: false,
    refusal: WSL_REFUSAL,
    trash: 'permanent',
    worktreeOf: '',
  });
  let refused = '';
  try {
    await deleteFolder(REF, guard, 'recycle', layer);
  } catch (error) {
    refused = error instanceof Refused ? error.message : 'other';
  }
  assertEquals([refused, asked], [WSL_REFUSAL, 0]);
});

Deno.test('added projects: a ref is stored canonical with its wsl part, read back, never read from disk; Foo and foo stay two', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'aib-wsl-added-' });
  try {
    const asked: string[] = [];
    const store = new AddedProjects(dir, {
      parentOf: (p) => (asked.push(p), null),
    });
    assert(await store.add('wsl://Ubuntu/home/u/App'));
    assert(await store.add('wsl://ubuntu/home/u/app'));
    assertEquals(store.added.get('p:wsl:/ubuntu/home/u/App')?.path, 'wsl://ubuntu/home/u/App');
    assertEquals(store.added.get('p:wsl:/ubuntu/home/u/App')?.wsl, {
      distro: 'ubuntu',
      linuxPath: '/home/u/App',
    });
    assertEquals(store.added.size, 2);
    assert(store.shows('wsl://ubuntu/home/u/App') && !store.shows('wsl://ubuntu/home/u/APP'));
    assertEquals(asked, [], 'no worktree lookup (disk read) for a ref');
    assertEquals(await store.add('wsl://ubuntu/a/../b'), false, 'an invalid ref is never added');
    if (WIN) assertEquals(await store.add('/home/u/app'), false, 'nor a drive-less path on Windows');
    const again = new AddedProjects(dir);
    assertEquals(again.added.get('p:wsl:/ubuntu/home/u/app')?.wsl, {
      distro: 'ubuntu',
      linuxPath: '/home/u/app',
    });
    const saved = JSON.parse(Deno.readTextFileSync(`${dir}/${AddedProjects.FILE}`));
    assertEquals(saved.version, 1, 'STORE_VERSION unchanged');
    assert(await again.remove('wsl://ubuntu/home/u/app'));
    assertEquals(again.added.size, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('folders: checks answer reason "wsl" for a ref; worktree lookups and kinds never read one', () => {
  assertEquals([checkPath(REF).valid, checkPath(REF).reason], [false, 'wsl']);
  assertEquals(checkProject(REF, 'new-thing').reason, 'wsl');
  assertEquals(checkProject(REF, '').reason, 'wsl');
  assertEquals(isWorktree(REF), false);
  assertEquals(isWorktree('wsl://ubuntu/r/.claude/worktrees/x'), false);
  assertEquals(worktreeParent('wsl://ubuntu/r/.claude/worktrees/x'), null);
  assertEquals(folderKinds([REF, 'wsl://bad name/x']), {
    [REF]: { worktree: false, scratch: false },
  });
  assertEquals(startDir(REF), '');
  assertEquals(startDir('\\\\server\\share\\x'), '', 'the picker never stats a share');
  if (WIN) {
    assertEquals(checkPath('/home/u').reason, 'relative');
    // a drive-less path is judged by its text alone (the page's filter, as the Python server did); nothing is read
    assertEquals(folderKinds(['/home/u', '/r/.git/worktrees/x']), {
      '/home/u': { worktree: false, scratch: false },
      '/r/.git/worktrees/x': { worktree: true, scratch: false },
    });
  }
});

Deno.test('folders: a pick in the WSL share of a known distro becomes its ref (or C:\\ for /mnt/c); others stay as picked', async () => {
  const known = (name: string) => name === 'ubuntu';
  assertEquals(pickedPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\app', known), 'wsl://ubuntu/home/u/app');
  assertEquals(pickedPath('\\\\wsl$\\Ubuntu\\mnt\\c\\work', known), 'C:\\work');
  assertEquals(pickedPath('\\\\wsl.localhost\\Fedora\\home', known), '\\\\wsl.localhost\\Fedora\\home');
  assertEquals(pickedPath('C:\\w', known), 'C:\\w');
  const [status, payload] = await pickFolder('', {
    plan: () => ({
      name: 'powershell',
      command: ['x'],
      parse: () => ({ path: '\\\\wsl.localhost\\Ubuntu\\srv\\p' }),
    }),
    runner: () => Promise.resolve({ code: 0, stdout: '' }),
    knownDistro: known,
  });
  assertEquals([status, payload], [200, { path: 'wsl://ubuntu/srv/p' }]);
});

function entries(): Entry[] {
  const caps = { folder: true, file: true, fileAtLine: true, workspace: true };
  return [
    {
      id: 'code',
      name: 'VS Code',
      kind: 'editor',
      exe: 'C:\\VSCode\\Code.exe',
      viaCmd: false,
      capabilities: caps,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      kind: 'editor',
      exe: 'C:\\Cursor\\bin\\cursor.cmd',
      viaCmd: true,
      capabilities: caps,
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      kind: 'editor',
      exe: 'C:\\Windsurf\\Windsurf.exe',
      viaCmd: false,
      capabilities: caps,
    },
    {
      id: 'explorer',
      name: 'File Explorer',
      kind: 'explorer',
      exe: 'C:\\Windows\\explorer.exe',
      viaCmd: false,
      capabilities: caps,
    },
    {
      id: 'terminal',
      name: 'PowerShell',
      kind: 'terminal',
      exe: 'powershell.exe',
      viaCmd: false,
      terminal: 'powershell',
      capabilities: caps,
    },
  ];
}

function launcher(roots: string[]) {
  const calls: { command: string[]; options: PopenOptions }[] = [];
  const l = new Launcher(() => roots, {
    popen: (command, options) => void calls.push({ command, options: { ...options } }),
    detectFn: entries,
    windows: true,
  });
  return { l, calls };
}

Deno.test('editors: VS Code and Cursor open a WSL project through Remote-WSL; other editors and workspace files are refused', () => {
  const { l, calls } = launcher([REF, 'C:\\other']);
  l.open({ editor: 'code', kind: 'folder', path: REF });
  const [exe, remote, authority, path] = calls[0].command;
  assertEquals([exe, remote, path], ['C:\\VSCode\\Code.exe', '--remote', '/home/u/app']);
  assert(/^wsl\+ubuntu$/i.test(authority), authority);
  assertEquals(calls[0].options.creationflags, 0x208);
  l.open({
    editor: 'cursor',
    kind: 'file',
    cwd: REF,
    path: 'src/main.ts',
    line: 7,
  });
  assertEquals(calls[1].command.slice(3), ['-r', '--goto', '/home/u/app/src/main.ts:7']);
  l.open({ editor: 'code', kind: 'file', path: `${REF}/README.md` });
  assertEquals(calls[2].command.slice(3), ['-r', '/home/u/app/README.md']);
  assertEquals(throwsName(() => l.open({ editor: 'windsurf', kind: 'folder', path: REF })), 'EditorError:unsupported');
  assertEquals(throwsName(() => l.open({ editor: 'terminal', kind: 'folder', path: REF })), 'EditorError:unsupported');
  assertEquals(
    throwsName(() =>
      l.open({
        editor: 'code',
        kind: 'workspace',
        path: `${REF}/x.code-workspace`,
      })
    ),
    'EditorError:unsupported',
  );
  assertEquals(
    throwsName(() =>
      l.open({
        editor: 'code',
        kind: 'folder',
        path: 'wsl://ubuntu/home/u/App',
      })
    ),
    'EditorError:path_refused',
  );
  assertEquals(
    throwsName(() =>
      l.open({
        editor: 'code',
        kind: 'folder',
        path: 'wsl://debian/home/u/app',
      })
    ),
    'EditorError:path_refused',
  );
  assertEquals(throwsName(() => l.open({ editor: 'code', kind: 'file', cwd: REF, path: '../secret' })), 'EditorError:path_refused');
  assertEquals(throwsName(() => l.open({ editor: 'cursor', kind: 'file', cwd: REF, path: 'a&b.ts' })), 'EditorError:unsafe_path');
  assertEquals(calls.length, 3);
});

Deno.test({
  name: 'editors: Reveal of a WSL project runs wsl.exe ... --exec explorer.exe . in the folder (argv, WSL_UTF8=1)',
  ignore: !WIN || !wslExePath(),
  fn() {
    const { l, calls } = launcher([REF]);
    l.open({ editor: 'explorer', kind: 'folder', path: REF });
    l.open({ editor: 'explorer', kind: 'file', path: `${REF}/src/x.ts` });
    const [one, two] = calls;
    assertEquals(one.command[0], wslExePath());
    assertEquals(one.command.slice(3), ['--cd', '/home/u/app', '--exec', 'explorer.exe', '.']);
    assertEquals(two.command.slice(3, 5), ['--cd', '/home/u/app/src']);
    assertEquals([one.options.creationflags, one.options.env], [0, {
      WSL_UTF8: '1',
    }]);
    const entry = entries()[3];
    assertEquals(
      buildWslCommand(entry, 'folder', { kind: 'wsl', distro: 'ubuntu', linuxPath: '/' }, null, 'W:\\wsl.exe').slice(3, 5),
      ['--cd', '/'],
    );
  },
});

Deno.test('editors: the listing of a WSL project offers only VS Code, Cursor and File Explorer, with no workspaces', () => {
  const { l } = launcher([REF]);
  const listing = l.listing(REF);
  assertEquals(listing.editors.map((e) => e.id), ['code', 'cursor', 'explorer']);
  assertEquals([listing.default, listing.workspaces, listing.project], ['code', [], REF]);
  assertEquals(listing.editors[0].capabilities.workspace, false);
  const roots = knownRoots({
    liveList: () => ({
      connections: [{ cwd: REF }, { cwd: 'wsl://bad name/x' }],
    }),
    projectPrefs: { projects: { 'p:wsl:/debian/srv/x': {} } },
  });
  assertEquals(roots, [REF, 'wsl://debian/srv/x']);
});

function hooks(subkeys: { key: string; values: Record<string, string | number> }[], extra: Partial<DetectHooks> = {}): DetectHooks {
  return {
    os: 'windows',
    systemRoot: () => 'C:\\Windows',
    exists: () => true,
    subkeys: () => subkeys,
    value: () => '{b}',
    now: () => 0,
    ...extra,
  };
}

Deno.test("detect: WSL2 distros only (WSL1, half-installed and Docker's own left out with why), the default first", () => {
  const found = detectNow(hooks([
    {
      key: '{a}',
      values: { DistributionName: 'Ubuntu', Version: 2, State: 1 },
    },
    {
      key: '{b}',
      values: { DistributionName: 'Debian', Version: 2, State: 1 },
    },
    {
      key: '{c}',
      values: { DistributionName: 'Legacy', Version: 1, State: 1 },
    },
    {
      key: '{d}',
      values: { DistributionName: 'docker-desktop', Version: 2, State: 1 },
    },
    { key: '{e}', values: { DistributionName: 'Half', Version: 2, State: 3 } },
    { key: '{f}', values: { DistributionName: 'bad name', Version: 2 } },
    { key: '{g}', values: {} },
  ]));
  assertEquals(found.wslExe, 'C:\\Windows\\System32\\wsl.exe');
  assertEquals(found.distros.map((d) => [d.name, d.isDefault]), [['Debian', true], ['Ubuntu', false]]);
  assertEquals(found.skipped.map((s) => s.name), ['Legacy', 'docker-desktop', 'Half', 'bad name']);
  assert(/WSL1/.test(found.skipped[0].why));
  assertEquals(found.problem, '');
  assertEquals(detectNow(hooks([], { exists: () => false })).problem, 'WSL is not installed (no wsl.exe)');
  assertEquals(detectNow(hooks([], { os: 'linux' })).distros, []);
  assertEquals(
    detectNow(hooks([], {
      subkeys: () => {
        throw new Error('denied');
      },
    })).problem.includes('denied'),
    true,
  );
});

Deno.test({
  name: 'detect: the real registry read (advapi32) works without starting wsl.exe',
  ignore: !WIN,
  fn() {
    const found = detectNow();
    assert(Array.isArray(found.distros) && Array.isArray(found.skipped));
    for (const d of found.distros) assertEquals(d.version, 2);
  },
});
