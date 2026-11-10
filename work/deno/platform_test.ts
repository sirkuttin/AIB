/** server/platform: locks (also against the Python server's locks), process trees, process facts, console, paths. */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PY_REF_DIR, python } from './_parity.ts';
import { FileLock, LockHeld, LockTimeout, tryLockNow } from '../../outputs/agent-studio/server/platform/lock.ts';
import { ProcessTree, treeSpawnOptions } from '../../outputs/agent-studio/server/platform/process_tree.ts';
import {
  processAlive,
  processList,
  processStartTime,
  processStrings,
  restartManagerHolders,
} from '../../outputs/agent-studio/server/platform/process_info.ts';
import { ensureHiddenConsole } from '../../outputs/agent-studio/server/platform/console.ts';
import { consoleSetup } from './_no_console.ts';
import { basename, dirname, join } from '../../outputs/agent-studio/server/platform/path.ts';

const win = Deno.build.os === 'windows';
const appDir = PY_REF_DIR; // the Python reference (state_store.FileLock)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Python holds a state_store.FileLock on `path` until its stdin closes; resolves once it holds it. */
async function pythonHolds(path: string) {
  const code = [
    'import sys; sys.path.insert(0, sys.argv[1])',
    'import state_store',
    'lock = state_store.FileLock(sys.argv[2], timeout=5); lock.acquire()',
    'print("locked", flush=True); sys.stdin.read(); lock.release()',
  ].join('\n');
  const child = new Deno.Command(python(), {
    args: ['-c', code, appDir, path],
    stdin: 'piped',
    stdout: 'piped',
    env: { AGENT_STUDIO_TEST: '1' },
  })
    .spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  assert(value?.includes('locked'), `python did not lock: ${value}`);
  return {
    async release() {
      await child.stdin.close();
      reader.releaseLock();
      await child.stdout.cancel().catch(() => {});
      await child.status;
    },
  };
}

/** Python tries the lock with a short timeout; returns true if it got it. */
async function pythonCanLock(path: string): Promise<boolean> {
  const code = [
    'import sys; sys.path.insert(0, sys.argv[1])',
    'import state_store',
    'lock = state_store.FileLock(sys.argv[2], timeout=0.3)',
    'try:\n    lock.acquire(); lock.release(); print("yes")\nexcept OSError:\n    print("no")',
  ].join('\n');
  const out = await new Deno.Command(python(), { args: ['-c', code, appDir, path], env: { AGENT_STUDIO_TEST: '1' } }).output();
  return new TextDecoder().decode(out.stdout).trim() === 'yes';
}

Deno.test('FileLock and a Python FileLock exclude each other, both ways', async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, 'state.json.lock');
  const lock = await new FileLock(path, 2000).acquire();
  assertEquals(await pythonCanLock(path), false, 'python got a lock deno holds');
  lock.release();
  assertEquals(await pythonCanLock(path), true, 'python could not lock after deno released');

  const held = await pythonHolds(path);
  await assertRejects(() => tryLockNow(path), LockHeld);
  await assertRejects(() => new FileLock(path, 150).acquire(), LockTimeout);
  await held.release();
  const again = await new FileLock(path, 2000).acquire();
  again.release();
  await Deno.remove(dir, { recursive: true });
});

Deno.test('FileLock: two Deno holders wait for each other; run() releases on error', async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, 'nested', 'x.lock');
  const first = await new FileLock(path).acquire();
  if (win) assertEquals((await Deno.stat(path)).size, 1, 'Windows lock file gets one NUL byte, like Python');
  const waiting = new FileLock(path, 3000).acquire();
  await sleep(150);
  first.release();
  (await waiting).release();
  await assertRejects(() => new FileLock(path).run(() => Promise.reject(new Error('boom'))));
  (await tryLockNow(path)).close();
  await Deno.remove(dir, { recursive: true });
});

/** A Deno child that starts a grandchild and prints its pid, then sleeps. */
function spawnFamily(marker: string) {
  const grandchild = `setTimeout(() => {}, 60000) // ${marker}-grandchild`;
  const parent = `const g = new Deno.Command(Deno.execPath(), { args: ['eval', ${
    JSON.stringify(grandchild)
  }], stdout: 'null', stderr: 'null' }).spawn();
console.log(g.pid); setTimeout(() => {}, 60000); // ${marker}`;
  return new Deno.Command(Deno.execPath(), {
    args: ['eval', parent],
    stdout: 'piped',
    stderr: 'null',
    stdin: 'null',
    ...treeSpawnOptions(),
  }).spawn();
}

async function firstLine(child: Deno.ChildProcess): Promise<string> {
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return (value ?? '').trim();
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (win ? processAlive(pid) === false : !posixAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

function posixAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

Deno.test('ProcessTree.kill ends the agent and what it started', async () => {
  const child = spawnFamily('tree-test');
  const grandchild = Number(await firstLine(child));
  assert(grandchild > 0, 'no grandchild pid');
  const tree = new ProcessTree(child);
  if (win) assert(tree.hasJob, 'no job object');
  tree.kill();
  tree.kill(); // safe twice
  await child.status;
  await child.stdout.cancel().catch(() => {});
  assert(await gone(child.pid), 'agent survived');
  assert(await gone(grandchild), 'grandchild survived');
});

Deno.test({
  name: 'process facts: list, PEB command line and folder, start time, alive, Restart Manager holders',
  ignore: !win,
  async fn() {
    const dir = await Deno.makeTempDir();
    const file = join(dir, 'chat.jsonl');
    await Deno.writeTextFile(file, '{}\n');
    const code = `const f = Deno.openSync(${
      JSON.stringify(file)
    }, { read: true }); console.log('ready'); setTimeout(() => {}, 60000); // peb-marker-7f3`;
    const child = new Deno.Command(Deno.execPath(), { args: ['eval', code], cwd: dir, stdout: 'piped', stderr: 'null' }).spawn();
    assertEquals(await firstLine(child), 'ready');
    try {
      assert(processList().some((p) => p.pid === child.pid && p.parentPid === Deno.pid), 'child not in list');
      const strings = processStrings(child.pid);
      assert(strings?.commandLine?.includes('peb-marker-7f3'), `command line: ${strings?.commandLine}`);
      assertEquals(strings?.cwd?.replace(/\\$/, '').toLowerCase(), dir.toLowerCase());
      const started = processStartTime(child.pid);
      assert(started !== null && Math.abs(started - Date.now() / 1000) < 60, `start time ${started}`);
      assertEquals(processAlive(child.pid), true);
      assertEquals(processAlive(child.pid, started! - 3600), false, 'pid reuse not detected');
      const holders = restartManagerHolders(file);
      assert(holders?.some(([pid]) => pid === child.pid), `holders: ${JSON.stringify(holders)}`);
    } finally {
      child.kill('SIGKILL');
      await child.status;
      await child.stdout.cancel().catch(() => {});
    }
    assertEquals(processAlive(child.pid), false);
    assertEquals(processAlive(-1), false);
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test('ensureHiddenConsole: children started afterwards have no visible console window', async () => {
  // _no_console.ts (imported by every test file) already ran it once at load: what that first call did is what counts here.
  const first = consoleSetup;
  if (!win) return assertEquals(first, 'not-windows');
  assert(['has-console', 'no-window', 'hidden'].includes(first), first);
  assert(['has-console', 'no-window', 'hidden'].includes(ensureHiddenConsole()), 'second call failed');
  const probe = `const k = Deno.dlopen('kernel32.dll', { GetConsoleWindow: { parameters: [], result: 'pointer' } });
const u = Deno.dlopen('user32.dll', { IsWindowVisible: { parameters: ['pointer'], result: 'i32' } });
const w = k.symbols.GetConsoleWindow(); console.log(w !== null && u.symbols.IsWindowVisible(w) ? 'visible' : 'hidden');`;
  const out = await new Deno.Command(Deno.execPath(), { args: ['eval', probe], stdout: 'piped', stderr: 'null' }).output();
  // 'has-console' means the test runs in a real terminal, whose window the child shares (and is meant to see).
  if (first !== 'has-console') assertEquals(new TextDecoder().decode(out.stdout).trim(), 'hidden');
});

Deno.test('path helpers', () => {
  assertEquals(dirname('C:\\a\\b\\c.txt'), 'C:\\a\\b');
  assertEquals(dirname('C:\\a'), 'C:\\');
  assertEquals(dirname('/a/b/'), '/a');
  assertEquals(dirname('/a'), '/');
  assertEquals(dirname('x'), '.');
  assertEquals(basename('C:\\a\\b\\c.txt'), 'c.txt');
  assertEquals(basename('/a/b/'), 'b');
  assertEquals(join('a', 'b', 'c').split(/[\\/]/), ['a', 'b', 'c']);
});
