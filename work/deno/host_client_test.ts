/**
 * server/host/host_client.ts and server/platform/spawn_detached.ts: parity with host_client.py, a detached start with its log, and
 * the stage B seam itself: the Deno client starting, attaching to and stopping the real Python agent host.
 */
import { assert, assertEquals } from './_assert.ts';
import { APP, PY_REF_DIR, PyParity, python } from './_parity.ts';
import {
  binaryHash,
  CODE_ROOT,
  codeRootFor,
  codeWarning,
  findHost,
  findOrStart,
  HostClient,
  HostUnavailable,
  normcase,
  PROTOCOL_VERSION,
  readInfo,
  rotateLog,
  sourceHash,
  stopHost,
  writeInfo,
} from '../../outputs/agent-studio/server/host/host_client.ts';
import {
  ABOUT_LINE,
  APP_ROOT,
  APP_VERSION,
  isCompiled,
  launchDir,
  REPO_ROOT,
  selfCommand,
  TESTS_DIR,
  VERSION_LABEL,
} from '../../outputs/agent-studio/server/core/app.ts';
import { quoteWindowsArg, spawnDetached } from '../../outputs/agent-studio/server/platform/spawn_detached.ts';
import { join } from '../../outputs/agent-studio/server/platform/path.ts';

const win = Deno.build.os === 'windows';
const appDir = APP.pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test('app constants, code root and source hash match Python', async () => {
  await using py = new PyParity();
  assertEquals(APP_VERSION, await py.call('version', '__version__.__str__'));
  assertEquals(VERSION_LABEL, await py.call('version', 'VERSION_LABEL.__str__'));
  assertEquals(ABOUT_LINE, await py.call('version', 'ABOUT_LINE.__str__'));
  assertEquals(normcase(APP_ROOT), await py.call('host_client', '_code_root'));
  assertEquals(CODE_ROOT, await py.call('host_client', '_code_root'));
  assertEquals(normcase(REPO_ROOT), normcase(String(await py.call('app_paths', 'REPO_ROOT.__str__'))));
  assertEquals(normcase(TESTS_DIR), normcase(String(await py.call('app_paths', 'TESTS_DIR.__str__'))));
  assertEquals(await sourceHash(), await py.call('host_client', '_source_hash')); // the .py digest over the app folder, as a Python host reports it
  assertEquals(await codeWarning({ pid: 1, sourceHash: await sourceHash() }), '');
  assert((await codeWarning({ pid: 1, sourceHash: 'x' })).includes('older code'));
  assert((await codeWarning({ pid: 1 })).includes('older version'));
  assertEquals(await codeWarning({}), '');
});

Deno.test('quoteWindowsArg matches subprocess.list2cmdline', async () => {
  await using py = new PyParity();
  const args = [
    'plain',
    '',
    'two words',
    'C:\\Program Files\\x\\',
    'a"b',
    'a\\"b',
    'tab\there',
    'trailing\\\\',
    'ü😀',
    '\\\\server\\share',
  ];
  assertEquals(args.map(quoteWindowsArg).join(' '), await py.call('subprocess', 'list2cmdline', [args]));
});

Deno.test('spawnDetached: output goes to the log, exit code is seen, no console window, arguments arrive intact', async () => {
  const dir = await Deno.makeTempDir();
  const log = join(dir, 'logs', 'child.log');
  const code = [
    'import sys, os',
    'print("args", sys.argv[1:], flush=True)',
    'print("err line", file=sys.stderr, flush=True)',
    'if os.name == "nt":',
    '    import ctypes; print("console", bool(ctypes.windll.kernel32.GetConsoleWindow()), flush=True)',
    'sys.exit(3)',
  ].join('\n');
  const args = ['two words', 'q"uote', 'C:\\dir\\'];
  const child = await spawnDetached([python(), '-c', code, ...args], log, dir);
  assert(child.pid > 0);
  let exit: number | null = null;
  for (let i = 0; i < 100 && exit === null; i++) {
    exit = child.exitCode();
    if (exit === null) await sleep(100);
  }
  child.close();
  assertEquals(exit, win ? 3 : exit); // POSIX reports the sh wrapper's status asynchronously
  const text = await Deno.readTextFile(log);
  assert(text.includes(`args ['two words', 'q"uote', 'C:\\\\dir\\\\']`), text);
  assert(text.includes('err line'), text);
  if (win) assert(text.includes('console False'), text);
  await Deno.remove(dir, { recursive: true });
});

Deno.test('rotateLog keeps two older files', async () => {
  const dir = await Deno.makeTempDir();
  const log = join(dir, 'a.log');
  for (const n of [1, 2, 3]) {
    await Deno.writeTextFile(log, `gen${n}`.padEnd(20, '.'));
    assertEquals(await rotateLog(log, 10), true);
  }
  assertEquals(await Deno.readTextFile(log + '.1'), 'gen3'.padEnd(20, '.'));
  assertEquals(await Deno.readTextFile(log + '.2'), 'gen2'.padEnd(20, '.'));
  assertEquals(await rotateLog(log + '.missing', 10), false);
  await Deno.remove(dir, { recursive: true });
});

Deno.test('readInfo accepts only a well-formed host file; a stale file is not a host', async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await readInfo(dir), null);
  await writeInfo(dir, { format: 'agent-studio-host', port: 'x', token: 't' });
  assertEquals(await readInfo(dir), null);
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close(); // now nothing listens there
  await writeInfo(dir, { format: 'agent-studio-host', port, token: 't', pid: 999999, codeRoot: APP_ROOT });
  assertEquals((await readInfo(dir))?.port, port);
  assertEquals(await findHost(dir), null); // nothing listens there and the pid is dead
  try {
    await new HostClient({ port, token: 't' }).call('info', null, 2);
    throw new Error('expected HostUnavailable');
  } catch (error) {
    assert(error instanceof HostUnavailable && !error.delivered, String(error));
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test({
  name: 'stage B seam: the Deno client starts, attaches to and stops the real Python agent host',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: 'aib-host-' });
    const state = join(root, 'state');
    for (const d of ['state', 'omp', 'claude']) await Deno.mkdir(join(root, d));
    Deno.env.set('AGENT_STUDIO_TEST', '1');
    Deno.env.set('AGENT_STUDIO_STATE_DIR', state);
    const command = [
      python(),
      join(PY_REF_DIR, 'agent_host.py'),
      '--state-dir',
      state,
      '--omp-sessions',
      join(root, 'omp'),
      '--claude-projects',
      join(root, 'claude'),
      '--omp-command',
      'omp',
      '--node-command',
      'node',
      '--claude-launcher',
      '',
      '--codex-launcher',
      '',
      '--no-auto-reconnect',
      '--no-owner-announcements',
      '--host-port',
      '0',
      '--idle-exit-minutes',
      '2',
    ];
    const said: string[] = [];
    try {
      const [client, live] = await findOrStart(state, command, { say: (m) => said.push(m), cwd: appDir });
      assertEquals(live.protocol, PROTOCOL_VERSION);
      assert(said.some((m) => m.startsWith('Started agent host process')), said.join('\n'));
      const info = await client.call('info') as Record<string, unknown>;
      assertEquals(info.protocol, PROTOCOL_VERSION);
      assertEquals(await codeWarning(info), '', 'Python host and Deno client disagree about the code hash');
      assertEquals(await client.call('list'), await client.call('list'));
      const again = await findHost(state);
      assert(again && again[0].port === client.port, 'second attach found another host');
      const stopped = await stopHost(state);
      assertEquals(stopped.stopped, true, stopped.message);
      assertEquals(await readInfo(state), null);
    } finally {
      await stopHost(state, true).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

// ---- a built binary: APP_ROOT is a folder inside the binary, so the host starts in a real folder and is identified by the file --

Deno.test('built binary: isCompiled, launchDir and codeRoot use the binary, not the virtual app folder', () => {
  const exe = win ? String.raw`C:\Program Files\AIB\AIB.exe` : '/opt/aib/AIB';
  assert(!isCompiled(Deno.execPath()), 'tests run under deno');
  assert(isCompiled(exe));
  assert(!isCompiled(win ? String.raw`C:\tools\DENO.EXE` : '/usr/bin/deno'));
  assertEquals(launchDir(exe), win ? String.raw`C:\Program Files\AIB` : '/opt/aib');
  assertEquals(launchDir(Deno.execPath()), APP_ROOT); // deno run: unchanged
  assert(Deno.statSync(launchDir()).isDirectory, 'the default start folder exists');
  assertEquals(codeRootFor(exe), normcase(exe));
  assertEquals(codeRootFor(Deno.execPath()), normcase(APP_ROOT));
  assertEquals(CODE_ROOT, normcase(APP_ROOT));
  assertEquals(selfCommand().slice(1, 4), ['run', '-A', '--quiet']);
});

Deno.test('built binary: binaryHash is stable for one file and changes when the file is replaced', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-binhash-' });
  try {
    const exe = join(dir, win ? 'AIB.exe' : 'AIB');
    Deno.writeTextFileSync(exe, 'build one');
    const first = await binaryHash(exe);
    assertEquals(await binaryHash(exe), first);
    assert(/^[0-9a-f]{64}$/.test(first));
    Deno.writeTextFileSync(exe, 'build two, longer');
    assert((await binaryHash(exe)) !== first, 'a replaced binary is other code');
    const other = join(dir, 'other.exe');
    Deno.copyFileSync(exe, other);
    assert((await binaryHash(other)) !== (await binaryHash(exe)), 'another install is other code');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('findOrStart starts the host in launchDir() by default (a real folder)', async () => {
  const state = Deno.makeTempDirSync({ prefix: 'aib-cwd-' });
  try {
    // A "host" that only records its folder and exits: findOrStart then reports it exited before it was ready.
    const script = join(state, 'host.ts');
    Deno.writeTextFileSync(script, `Deno.writeTextFileSync(${JSON.stringify(join(state, 'cwd.txt'))}, Deno.cwd());`);
    let failure: unknown = null;
    try {
      await findOrStart(state, [Deno.execPath(), 'run', '-A', '--quiet', script], { waitSeconds: 8 });
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof HostUnavailable, String(failure));
    assertEquals(normcase(Deno.readTextFileSync(join(state, 'cwd.txt'))), normcase(launchDir()));
  } finally {
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(state, { recursive: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});
