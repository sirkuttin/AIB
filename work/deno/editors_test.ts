/**
 * server/desktop/editors.ts: the cases of work/test_editors.py that exercise editors.py, plus parity with Python. Nothing is
 * launched: every Launcher gets a recording popen. Skipped: SettingsAndPrefsTests (state_store, covered by the settings port tests).
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  buildCommand,
  defaultEditor,
  detect,
  EDITOR_SPECS,
  EditorError,
  type Entry,
  findEditor,
  findWorkspaces,
  knownRoots,
  Launcher,
  publicEntry,
  resolveInside,
  stripJsonc,
} from '../../outputs/agent-studio/server/desktop/editors.ts';
import { EDITOR_IDS } from '../../outputs/agent-studio/server/state/settings.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';

const CAPS_ALL = { folder: true, file: true, fileAtLine: true, workspace: true };
const CAPS_FOLDER = { folder: true, file: false, fileAtLine: false, workspace: false };

function fakeEntries(...ids: string[]): Entry[] {
  const table: Record<string, Entry> = {
    code: {
      id: 'code',
      name: 'VS Code',
      kind: 'editor',
      exe: 'C:\\VS\\Code.exe',
      viaCmd: false,
      folderOnly: false,
      capabilities: CAPS_ALL,
    },
    devin: {
      id: 'devin',
      name: 'Devin',
      kind: 'editor',
      exe: 'C:\\Devin\\Devin.exe',
      viaCmd: false,
      folderOnly: true,
      capabilities: CAPS_FOLDER,
    },
    cmdcode: {
      id: 'code',
      name: 'VS Code',
      kind: 'editor',
      exe: 'C:\\VS\\bin\\code.cmd',
      viaCmd: true,
      folderOnly: false,
      capabilities: CAPS_ALL,
    },
    explorer: {
      id: 'explorer',
      name: 'File Explorer',
      kind: 'explorer',
      exe: 'C:\\Windows\\explorer.exe',
      viaCmd: false,
      capabilities: { folder: true, file: true, fileAtLine: false, workspace: false },
    },
    wt: {
      id: 'terminal',
      name: 'Windows Terminal',
      kind: 'terminal',
      exe: 'C:\\wt.exe',
      viaCmd: false,
      terminal: 'wt',
      capabilities: CAPS_FOLDER,
    },
    ps: {
      id: 'terminal',
      name: 'PowerShell',
      kind: 'terminal',
      exe: 'C:\\ps.exe',
      viaCmd: false,
      terminal: 'powershell',
      capabilities: CAPS_FOLDER,
    },
  };
  return ids.map((id) => structuredClone(table[id]));
}

const SITE = osp.join(Deno.env.get('TEMP') ?? Deno.env.get('TMPDIR') ?? '/tmp', 'studio-editors-site');
const at = (...parts: string[]) => osp.join(SITE, ...parts);
const LOCAL = at('Users', 'u', 'AppData', 'Local');
const ENV = { LOCALAPPDATA: LOCAL, ProgramFiles: at('Program Files'), SystemRoot: at('Windows') };

function runDetect(files: string[], pathMap: Record<string, string> = {}): Entry[] {
  const set = new Set(files.map(osp.normcase));
  return detect({ env: ENV, which: (name) => pathMap[name] ?? null, isfile: (p) => set.has(osp.normcase(p)), windows: true });
}

// ---- detection -----------------------------------------------------------------------------------

Deno.test('install folder exe is found without PATH', () => {
  const local = osp.join(LOCAL, 'Programs');
  const found = runDetect([osp.join(local, 'Microsoft VS Code', 'Code.exe'), osp.join(local, 'Devin', 'Devin.exe')]);
  assertEquals(found.filter((e) => e.kind === 'editor').map((e) => e.id), ['code', 'devin']);
  assert(found.every((e) => !e.viaCmd));
});

Deno.test('cmd launcher maps to the sibling exe, or is flagged when there is none', () => {
  const base = at('Somewhere', 'VS');
  const launcher = osp.join(base, 'bin', 'code.cmd');
  const which = (n: string) => (n === 'code.cmd' ? launcher : null);
  assertEquals(findEditor(EDITOR_SPECS[0], {}, which, (p) => osp.normcase(p) === osp.normcase(osp.join(base, 'Code.exe'))), [
    osp.join(base, 'Code.exe'),
    false,
  ]);
  const lone = at('x', 'bin', 'code.cmd');
  assertEquals(findEditor(EDITOR_SPECS[0], {}, (n) => (n === 'code.cmd' ? lone : null), () => false), [lone, true]);
});

Deno.test('nothing installed means no editor; Devin is folder only', () => {
  assertEquals(runDetect([]).filter((e) => e.kind === 'editor'), []);
  const devin = runDetect([osp.join(LOCAL, 'Programs', 'Devin', 'Devin.exe')]).find((e) => e.id === 'devin')!;
  assertEquals(devin.capabilities, CAPS_FOLDER);
});

Deno.test('terminal prefers wt, then PowerShell', () => {
  const wt = runDetect([], { 'wt.exe': at('wt.exe'), 'powershell.exe': at('ps.exe') });
  assertEquals(wt.find((e) => e.kind === 'terminal')!.terminal, 'wt');
  const ps = runDetect([], { 'powershell.exe': at('ps.exe') });
  assertEquals(ps.find((e) => e.kind === 'terminal')!.terminal, 'powershell');
  assert(ps.some((e) => e.kind === 'explorer'));
});

Deno.test('macOS finds an app without a launcher and offers Finder and Terminal', () => {
  const app = osp.join('/Applications', 'Visual Studio Code.app');
  const found = detect({ env: {}, which: () => null, isfile: () => false, windows: false, platform: 'darwin', isdir: (p) => p === app });
  const code = found.find((e) => e.id === 'code')!;
  assertEquals([code.exe, code.macApp], ['open', 'Visual Studio Code']);
  assertEquals(found.filter((e) => e.kind !== 'editor').map((e) => e.id).sort(), ['explorer', 'terminal']);
  assertEquals(found.find((e) => e.kind === 'terminal')!.terminal, 'mac');
});

Deno.test('Linux offers the file manager and the first terminal found', () => {
  const tools: Record<string, string> = {
    'xdg-open': '/usr/bin/xdg-open',
    konsole: '/usr/bin/konsole',
    'gnome-terminal': '/usr/bin/gnome-terminal',
  };
  const found = detect({ env: {}, which: (n) => tools[n] ?? null, isfile: () => false, windows: false, platform: 'linux' });
  assertEquals(found.find((e) => e.kind === 'explorer')!.opener, 'xdg');
  const terminals = found.filter((e) => e.kind === 'terminal');
  assertEquals(terminals.map((t) => t.exe), ['/usr/bin/gnome-terminal']);
  assertEquals(terminals[0].terminal, 'posix');
  assertEquals(found.filter((e) => e.kind === 'editor'), []);
});

Deno.test('default order and public entry; settings uses the same ids', () => {
  const entries = fakeEntries('devin', 'code', 'explorer');
  assertEquals(defaultEditor(entries), 'code');
  assertEquals(defaultEditor(fakeEntries('explorer')), '');
  assert(!('exe' in publicEntry(entries[0])));
  assertEquals([...EDITOR_IDS], ['code', 'cursor', 'windsurf', 'devin']);
});

Deno.test('detection matches Python', async () => {
  await using py = new PyParity();
  const local = osp.join(LOCAL, 'Programs');
  const cases: [string[], Record<string, string>, boolean, string, string[]][] = [
    [[osp.join(local, 'Microsoft VS Code', 'Code.exe'), osp.join(local, 'Devin', 'Devin.exe')], {}, true, 'win32', []],
    [[], { 'wt.exe': at('wt.exe') }, true, 'win32', []],
    [[], { 'powershell.exe': at('ps.exe'), 'cursor.cmd': at('cur', 'bin', 'cursor.cmd') }, true, 'win32', []],
    [[at('cur', 'Cursor.exe')], { 'cursor.cmd': at('cur', 'bin', 'cursor.cmd') }, true, 'win32', []],
    [[osp.join(SITE, 'Windows', 'explorer.exe')], { windsurf: '/opt/ws/windsurf' }, true, 'win32', []],
    [[], { 'xdg-open': '/usr/bin/xdg-open', 'xfce4-terminal': '/usr/bin/xfce4-terminal', code: '/usr/bin/code' }, false, 'linux', []],
    [[], {}, false, 'darwin', [osp.join('/Applications', 'Devin.app'), osp.join('/Applications', 'Cursor.app')]],
  ];
  for (const [files, pathMap, windows, platform, dirs] of cases) {
    const set = new Set(files.map(osp.normcase));
    const mine = detect({
      env: ENV,
      which: (n) => pathMap[n] ?? null,
      isfile: (p) => set.has(osp.normcase(p)),
      windows,
      platform,
      isdir: (p) => dirs.includes(p),
    });
    assertEquals(
      mine,
      await py.call('desktop_shim', 'editors_detect', [ENV, files, pathMap, windows, platform, dirs]),
      JSON.stringify(pathMap),
    );
  }
  for (const index of [0, 1, 2, 3]) {
    const pathMap = { 'code.cmd': at('a', 'bin', 'code.cmd'), 'windsurf': at('ws.exe') };
    const files = [at('a', 'Code.exe')];
    const set = new Set(files.map(osp.normcase));
    assertEquals(
      findEditor(EDITOR_SPECS[index], {}, (n) => (pathMap as Record<string, string>)[n] ?? null, (p) => set.has(osp.normcase(p))),
      await py.call('desktop_shim', 'editors_find', [index, {}, pathMap, files]),
    );
  }
});

// ---- path safety ---------------------------------------------------------------------------------

interface Popened {
  command: string[];
  options: Record<string, unknown>;
}

class Fixture {
  readonly base: string;
  readonly project: string;
  readonly outside: string;
  readonly calls: Popened[] = [];
  failWith: Error | null = null;

  constructor() {
    this.base = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'studio-editors-' }));
    this.project = osp.join(this.base, 'proj a');
    Deno.mkdirSync(osp.join(this.project, 'src'), { recursive: true });
    Deno.writeTextFileSync(osp.join(this.project, 'src', 'a.py'), 'x');
    this.outside = osp.join(this.base, 'other');
    Deno.mkdirSync(this.outside);
    Deno.writeTextFileSync(osp.join(this.outside, 'secret.txt'), 's');
  }

  p(...parts: string[]): string {
    return osp.join(this.base, ...parts);
  }

  launcher(entries: Entry[], roots: string[] | null = null, preferred?: () => string): Launcher {
    return new Launcher(() => roots ?? [this.project], {
      popen: (command, options) => {
        if (this.failWith) throw this.failWith;
        this.calls.push({ command, options: { ...options } });
      },
      detectFn: () => entries,
      windows: true,
      preferred,
    });
  }

  last(): Popened {
    return this.calls[this.calls.length - 1];
  }

  [Symbol.dispose](): void {
    Deno.removeSync(this.base, { recursive: true });
  }
}

const refused = (fn: () => unknown) => assertThrows(fn, EditorError) as EditorError;

Deno.test('inside a project is allowed; outside, traversal, UNC and relative are refused', () => {
  using f = new Fixture();
  const got = resolveInside(osp.join(f.project, 'src', 'a.py'), [f.project]);
  assertEquals(osp.normcase(got), osp.normcase(osp.join(f.project, 'src', 'a.py')));
  const bad: unknown[] = [
    f.outside,
    osp.join(f.project, '..', 'other'),
    f.project + '\\..\\other\\secret.txt',
    '\\\\server\\share\\x',
    '//server/share/x',
    '\\\\?\\C:\\Windows',
    'src/a.py',
    'a.py',
    '',
    '   ',
    'x'.repeat(2000),
    5,
    null,
    f.project + '\nx',
  ];
  for (const value of bad) refused(() => resolveInside(value, [f.project]));
});

Deno.test('a sibling with the same prefix is not inside; relative paths resolve against a known cwd', () => {
  using f = new Fixture();
  const sibling = f.p('proj a-evil');
  Deno.mkdirSync(sibling);
  refused(() => resolveInside(sibling, [f.project]));
  assert(resolveInside('src/a.py', [f.project], f.project).toLowerCase().endsWith('a.py'));
  refused(() => resolveInside('../other/secret.txt', [f.project], f.project));
});

Deno.test('a drive root is never a project root', () => {
  using f = new Fixture();
  const anchor = osp.splitdrive(f.project)[0] + osp.SEP;
  refused(() => resolveInside(f.outside, [anchor]));
});

Deno.test('a linked worktree of a project is allowed, a fake one is not', () => {
  using f = new Fixture();
  const wt = f.p('elsewhere-wt');
  Deno.mkdirSync(wt);
  const gitdir = osp.join(f.project, '.git', 'worktrees', 'wt1');
  Deno.mkdirSync(gitdir, { recursive: true });
  Deno.writeTextFileSync(osp.join(wt, '.git'), 'gitdir: ' + gitdir + '\n');
  Deno.writeTextFileSync(osp.join(wt, 'f.txt'), 'x');
  resolveInside(osp.join(wt, 'f.txt'), [f.project]);
  const other = f.p('fake-wt');
  Deno.mkdirSync(other);
  Deno.writeTextFileSync(osp.join(other, '.git'), 'gitdir: ' + osp.join(f.outside, '.git', 'worktrees', 'x') + '\n');
  refused(() => resolveInside(other, [f.project]));
});

Deno.test('resolveInside matches Python', async () => {
  using f = new Fixture();
  await using py = new PyParity();
  const roots = [f.project];
  const cases: [unknown, string[], string | null][] = [
    [osp.join(f.project, 'src', 'a.py'), roots, null],
    [osp.join(f.project, 'src', 'missing.py'), roots, null],
    [f.outside, roots, null],
    ['src/a.py', roots, f.project],
    ['../other', roots, f.project],
    ['\\\\server\\x', roots, null],
    ['rel', roots, null],
    ['x'.repeat(1025), roots, null],
    [f.project + '\x7f', roots, null],
    [f.project, [], null],
    [f.project, [f.base + osp.SEP], null],
  ];
  for (const [raw, r, base] of cases) {
    let mine: unknown;
    try {
      mine = resolveInside(raw, r, base);
    } catch (error) {
      const e = error as EditorError;
      mine = { error: e.message, code: e.code, status: e.status };
    }
    assertEquals(mine, await py.call('desktop_shim', 'editors_resolve', [raw, r, base]), String(raw).slice(0, 60));
  }
});

Deno.test('knownRoots collects every source and survives a host problem', () => {
  using f = new Fixture();
  const studio = {
    liveList: () => ({ connections: [{ cwd: f.project }], recovered: [{ cwd: f.outside }, { cwd: 'relative' }] }),
    conversations: { entries: { 'omp:1': { cwd: f.p('c') } } },
    projectPrefs: { projects: { 'w:c:/repos/app': {}, 'p:/x': {} } },
  };
  const got = knownRoots(studio);
  for (const want of [f.project, f.outside, f.p('c')]) assert(got.includes(want), want);
  assert(!got.includes('relative'));
  assert(
    knownRoots({
      ...studio,
      liveList: () =>
        (() => {
          throw new Error('host down');
        })(),
    }).includes(f.p('c')),
  );
});

// ---- commands ------------------------------------------------------------------------------------

Deno.test('folder, file and workspace commands are argument lists', () => {
  using f = new Fixture();
  const launcher = f.launcher(fakeEntries('code', 'explorer', 'wt'));
  const ws = osp.join(f.project, 'p.code-workspace');
  Deno.writeTextFileSync(ws, JSON.stringify({ folders: [{ path: '.' }] }));
  launcher.open({ editor: 'code', kind: 'folder', path: f.project });
  let { command, options } = f.last();
  assertEquals(command.slice(0, 2), ['C:\\VS\\Code.exe', '-r']);
  assertEquals(osp.normcase(command[2]), osp.normcase(f.project));
  assert(!('shell' in options));
  const file = osp.join(f.project, 'src', 'a.py');
  launcher.open({ editor: 'code', kind: 'file', path: file, line: 42 });
  ({ command } = f.last());
  assertEquals(command.slice(0, 3), ['C:\\VS\\Code.exe', '-r', '--goto']);
  assert(command[3].endsWith('a.py:42'));
  launcher.open({ editor: 'code', kind: 'file', path: file });
  assertEquals(f.last().command.length, 3);
  launcher.open({ editor: 'code', kind: 'workspace', path: ws });
  ({ command } = f.last());
  assertEquals(command.slice(0, 2), ['C:\\VS\\Code.exe', '-r']);
  assert(command[2].endsWith('p.code-workspace'));
  assertEquals(f.last().options.creationflags, 0x208);
});

Deno.test('a relative file uses the cwd', () => {
  using f = new Fixture();
  f.launcher(fakeEntries('code')).open({ editor: 'code', kind: 'file', path: 'src/a.py', line: 3, cwd: f.project });
  assert(f.last().command[3].endsWith('a.py:3'));
});

Deno.test('Explorer and the terminal', () => {
  using f = new Fixture();
  const launcher = f.launcher(fakeEntries('explorer', 'wt'));
  launcher.open({ editor: 'explorer', kind: 'folder', path: f.project });
  assertEquals(f.last().command.length, 2);
  assertEquals(f.last().options.creationflags, 0);
  launcher.open({ editor: 'explorer', kind: 'file', path: osp.join(f.project, 'src', 'a.py') });
  assertEquals(f.last().command.slice(0, 2), ['C:\\Windows\\explorer.exe', '/select,']);
  launcher.open({ editor: 'terminal', kind: 'folder', path: f.project });
  assertEquals(f.last().command.slice(0, 2), ['C:\\wt.exe', '-d']);
});

Deno.test('the PowerShell terminal puts no path in the command', () => {
  using f = new Fixture();
  f.launcher(fakeEntries('ps')).open({ editor: 'terminal', kind: 'folder', path: f.project });
  const { command, options } = f.last();
  assertEquals(command, ['C:\\ps.exe', '-NoExit']);
  assertEquals(osp.normcase(options.cwd as string), osp.normcase(f.project));
  assertEquals(options.creationflags, 0x10);
});

Deno.test('wt with a ; in the path falls back to the cwd', () => {
  using f = new Fixture();
  const odd = f.p('a;b');
  Deno.mkdirSync(odd);
  f.launcher(fakeEntries('wt'), [odd]).open({ editor: 'terminal', kind: 'folder', path: odd });
  assertEquals(f.last().command, ['C:\\wt.exe']);
  assert('cwd' in f.last().options);
});

Deno.test('Devin opens folders only', () => {
  using f = new Fixture();
  const launcher = f.launcher(fakeEntries('devin'));
  launcher.open({ editor: 'devin', kind: 'folder', path: f.project });
  assertEquals(f.last().command.length, 2);
  for (const [kind, path] of [['file', osp.join(f.project, 'src', 'a.py')], ['workspace', osp.join(f.project, 'x.code-workspace')]]) {
    refused(() => launcher.open({ editor: 'devin', kind, path }));
  }
});

Deno.test('a cmd launcher refuses cmd metacharacters', () => {
  using f = new Fixture();
  const odd = f.p('a&b');
  Deno.mkdirSync(odd);
  const error = refused(() => f.launcher(fakeEntries('cmdcode'), [odd]).open({ editor: 'code', kind: 'folder', path: odd }));
  assertEquals(error.code, 'unsafe_path');
  assertEquals(f.calls, []);
});

Deno.test('refusals never launch', () => {
  using f = new Fixture();
  const launcher = f.launcher(fakeEntries('code', 'explorer'));
  const aPy = osp.join(f.project, 'src', 'a.py');
  const cases: unknown[] = [
    { editor: 'code', kind: 'folder', path: f.outside },
    { editor: 'code', kind: 'file', path: osp.join(f.outside, 'secret.txt'), line: 1 },
    { editor: 'code', kind: 'folder', path: '\\\\server\\share' },
    { editor: 'code', kind: 'folder', path: osp.join(f.project, '..', 'other') },
    { editor: 'code', kind: 'workspace', path: osp.join(f.outside, 'x.code-workspace') },
    { editor: 'code', kind: 'workspace', path: aPy },
    { editor: 'nope', kind: 'folder', path: f.project },
    { editor: 'code', kind: 'bogus', path: f.project },
    { editor: 'code', kind: 'file', path: aPy, line: 0 },
    { editor: 'code', kind: 'file', path: aPy, line: '5' },
    { editor: 'code', kind: 'file', path: aPy, line: true },
    { editor: 'code', kind: 'file', path: osp.join(f.project, 'src', 'missing.py') },
    { editor: 'code', kind: 'folder', path: f.project, cwd: f.outside },
    { editor: 'explorer', kind: 'workspace', path: f.project },
    { editor: ['code'], kind: 'folder', path: f.project },
    'not a dict',
    { editor: 'code', kind: null, path: f.project },
  ];
  for (const body of cases) refused(() => launcher.open(body));
  assertEquals(f.calls, []);
  refused(() => f.launcher(fakeEntries('code'), []).open({ editor: 'code', kind: 'folder', path: f.project }));
  assertEquals(f.calls, []);
});

Deno.test('a workspace in the parent of a known project is allowed, an unrelated one is not', () => {
  using f = new Fixture();
  const ws = f.p('all.code-workspace');
  Deno.writeTextFileSync(ws, JSON.stringify({ folders: [{ path: 'proj a' }] }));
  const launcher = f.launcher(fakeEntries('code'));
  launcher.open({ editor: 'code', kind: 'workspace', path: ws });
  assertEquals(f.calls.length, 1);
  const unrelated = f.p('unrelated.code-workspace');
  Deno.writeTextFileSync(unrelated, JSON.stringify({ folders: [{ path: 'other' }] }));
  refused(() => launcher.open({ editor: 'code', kind: 'workspace', path: unrelated }));
});

Deno.test('a popen failure is an error', () => {
  using f = new Fixture();
  f.failWith = new Error('boom');
  const error = refused(() => f.launcher(fakeEntries('code')).open({ editor: 'code', kind: 'folder', path: f.project }));
  assertEquals([error.code, error.status, error.message], ['launch_failed', 500, 'Could not start VS Code: boom']);
});

Deno.test('the listing default prefers the saved setting', () => {
  using f = new Fixture();
  const entries = fakeEntries('code', 'devin', 'explorer');
  assertEquals(f.launcher(entries).listing().default, 'code');
  assertEquals(f.launcher(entries, null, () => 'devin').listing().default, 'devin');
  assertEquals(f.launcher(entries, null, () => 'cursor').listing().default, 'code');
  assertEquals(f.launcher(entries, null, () => 'explorer').listing().default, 'code');
  refused(() => f.launcher(entries).listing(f.outside));
  const listing = f.launcher(entries).listing(f.project);
  assertEquals([listing.project, listing.workspaces, listing.detectedDefault], [f.project, [], 'code']);
});

Deno.test('buildCommand matches Python for every program and kind', async () => {
  await using py = new PyParity();
  const entries: Entry[] = [
    ...fakeEntries('code', 'devin', 'cmdcode', 'explorer', 'wt', 'ps'),
    {
      id: 'code',
      name: 'VS Code',
      kind: 'editor',
      exe: 'open',
      viaCmd: false,
      macApp: 'Visual Studio Code',
      folderOnly: false,
      capabilities: { ...CAPS_ALL, fileAtLine: false },
    },
    {
      id: 'devin',
      name: 'Devin',
      kind: 'editor',
      exe: 'open',
      viaCmd: false,
      macApp: 'Devin',
      folderOnly: true,
      capabilities: CAPS_FOLDER,
    },
    {
      id: 'explorer',
      name: 'Finder',
      kind: 'explorer',
      exe: 'open',
      viaCmd: false,
      opener: 'open',
      capabilities: { folder: true, file: true, fileAtLine: false, workspace: false },
    },
    {
      id: 'explorer',
      name: 'File manager',
      kind: 'explorer',
      exe: '/usr/bin/xdg-open',
      viaCmd: false,
      opener: 'xdg',
      capabilities: { folder: true, file: true, fileAtLine: false, workspace: false },
    },
    { id: 'terminal', name: 'Terminal', kind: 'terminal', exe: 'open', viaCmd: false, terminal: 'mac', capabilities: CAPS_FOLDER },
    {
      id: 'terminal',
      name: 'Terminal',
      kind: 'terminal',
      exe: '/usr/bin/konsole',
      viaCmd: false,
      terminal: 'posix',
      capabilities: CAPS_FOLDER,
    },
  ];
  const paths = [osp.join(SITE, 'proj', 'a.py'), osp.join(SITE, 'a;b')];
  for (const entry of entries) {
    for (const kind of ['folder', 'file', 'workspace'] as const) {
      for (const path of paths) {
        for (const line of [null, 7]) {
          let mine: unknown;
          try {
            mine = buildCommand(entry, kind, path, line);
          } catch (error) {
            const e = error as EditorError;
            mine = { error: e.message, code: e.code, status: e.status };
          }
          assertEquals(mine, await py.call('desktop_shim', 'editors_build', [entry, kind, path, line]), `${entry.name} ${kind}`);
        }
      }
    }
  }
});

// ---- workspace files -----------------------------------------------------------------------------

Deno.test('comments and trailing commas are stripped, strings kept', async () => {
  const text =
    '{\n // c\n "folders": [ {"path": "proj a", /* x */ "name": "A",}, {"path": "http://x//y"},],\n "settings": {"a": "b // not a comment",}\n}';
  const data = JSON.parse(stripJsonc(text));
  assertEquals(data.settings.a, 'b // not a comment');
  assertEquals(data.folders.length, 2);
  await using py = new PyParity();
  for (const t of [text, '{"a": "\\"//x", // y\n "b": [1,2,],}', '/* open', '"unterminated', '[1, /* c */ ,]']) {
    assertEquals(stripJsonc(t), await py.call('editors', 'strip_jsonc', [t]));
  }
});

Deno.test('workspaces match in the project and its parents', async () => {
  using f = new Fixture();
  Deno.writeTextFileSync(osp.join(f.project, 'here.code-workspace'), '{"folders":[{"path":"."},{"path":"../other"}]}');
  Deno.writeTextFileSync(f.p('up.code-workspace'), '// c\n{"folders":[{"path":"proj a",},],}');
  Deno.writeTextFileSync(f.p('no.code-workspace'), '{"folders":[{"path":"other"}]}');
  Deno.writeTextFileSync(f.p('bad.code-workspace'), 'not json');
  Deno.writeTextFileSync(
    f.p('abs.code-workspace'),
    JSON.stringify({ folders: [{ path: f.project }, { uri: 'vscode-remote://wsl+ubuntu/home/x' }] }),
  );
  Deno.writeTextFileSync(f.p('bom.code-workspace'), '\ufeff{"folders":["proj a"]}');
  const found = findWorkspaces(f.project);
  assertEquals(found.map((m) => m.name).sort(), ['abs', 'bom', 'here', 'up']);
  const here = found.find((m) => m.name === 'here')!;
  assertEquals([here.folders, here.others], [2, 1]);
  await using py = new PyParity();
  assertEquals(findWorkspaces(f.project), await py.call('editors', 'find_workspaces', [f.project]));
});

Deno.test('only three parents are searched', () => {
  using f = new Fixture();
  const deep = osp.join(f.project, 'a', 'b', 'c', 'd');
  Deno.mkdirSync(deep, { recursive: true });
  Deno.writeTextFileSync(osp.join(f.project, 'x.code-workspace'), '{"folders":[{"path":"a/b/c/d"}]}');
  assertEquals(findWorkspaces(deep), [], 'four levels up is out of range');
  Deno.writeTextFileSync(osp.join(f.project, 'y.code-workspace'), '{"folders":[{"path":"a/b/c"}]}');
  assertEquals(findWorkspaces(osp.join(f.project, 'a', 'b', 'c')).map((m) => m.name), ['y']);
});
