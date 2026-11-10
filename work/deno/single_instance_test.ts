/**
 * One AIB per data folder (server/desktop/single_instance.ts): the OS lock on <data>/desktop.lock, the owner file next to it, and
 * what a second start does in each mode. No window or message box: the desktop app's notice is a recording fake. The crash cases use
 * a real child process that holds the lock.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  alreadyRunning,
  claim,
  claimFolder,
  guardDataFolder,
  LOCK_FILE,
  OWNER_FILE,
  readOwner,
  SIGNAL_FILE,
  takeSignal,
} from '../../outputs/agent-studio/server/desktop/single_instance.ts';

const MODULE = new URL('../../outputs/agent-studio/server/desktop/single_instance.ts', import.meta.url).href;
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'aib-one-copy-' });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
const exit = (code: number): never => {
  throw new Exited(code);
};

/** A separate process that takes the folder's lock as a server on `port`, prints "locked", then waits (or exits after holdMs). */
function holder(dir: string, port: number, holdMs = 600_000): Promise<Deno.ChildProcess> {
  const code = `const m = await import(${JSON.stringify(MODULE)});
    const c = await m.claimFolder(${JSON.stringify(dir)}, { mode: 'server', port: ${port} });
    console.log(c.primary ? 'locked' : 'refused');
    setTimeout(() => Deno.exit(0), ${holdMs});`;
  const child = new Deno.Command(Deno.execPath(), { args: ['eval', code], stdout: 'piped', stderr: 'null', stdin: 'null' }).spawn();
  return (async () => {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    child.stdout.cancel().catch(() => {});
    assertEquals(new TextDecoder().decode(value).trim(), 'locked');
    return child;
  })();
}

Deno.test('the lock: the holder names itself in the owner file; a second claim reports it; release frees the folder', async () => {
  await withDir(async (dir) => {
    const first = await claimFolder(dir, { mode: 'server', port: 8901 });
    assert(first.primary);
    assertEquals(await readOwner(dir), { pid: Deno.pid, mode: 'server', port: 8901 });
    await first.setPort(8903);
    assertEquals((await readOwner(dir))!.port, 8903);
    const second = await claimFolder(dir, { mode: 'server' });
    assertEquals(second, { primary: false, owner: { pid: Deno.pid, mode: 'server', port: 8903 } });
    first.release();
    assert(!exists(`${dir}/${OWNER_FILE}`), 'a clean quit removes the owner file');
    assert(exists(`${dir}/${LOCK_FILE}`), 'the lock file itself stays (the lock is on the open handle)');
    const third = await claimFolder(dir, { mode: 'desktop' });
    assert(third.primary, 'released: free again');
    assertEquals((await readOwner(dir))!.mode, 'desktop');
    third.release();
  });
});

Deno.test('a stale owner file without a live lock is ignored and replaced', async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/${OWNER_FILE}`, JSON.stringify({ pid: 999999, mode: 'server', port: 8767 }));
    const c = await claimFolder(dir, { mode: 'server', port: 8905 });
    assert(c.primary, 'the file alone never blocks');
    assertEquals(await readOwner(dir), { pid: Deno.pid, mode: 'server', port: 8905 });
    c.release();
  });
});

Deno.test('a holder that crashes frees the folder (the OS drops the lock); while it runs it is named', async () => {
  await withDir(async (dir) => {
    const child = await holder(dir, 8907);
    try {
      const refused = await claimFolder(dir, { mode: 'server', exitWaitMs: 0 });
      assertEquals(refused, { primary: false, owner: { pid: child.pid, mode: 'server', port: 8907 } });
    } finally {
      child.kill('SIGKILL'); // no clean shutdown: the owner file stays behind
      await child.status;
    }
    assert(exists(`${dir}/${OWNER_FILE}`));
    const c = await claimFolder(dir, { mode: 'server' });
    assert(c.primary, 'a crashed holder never leaves the folder locked');
    c.release();
  });
});

Deno.test('a holder on its way out: the claim waits for the lock while the named pid is gone', async () => {
  await withDir(async (dir) => {
    const first = await claimFolder(dir, { mode: 'server', port: 8909 });
    assert(first.primary);
    const gone = JSON.stringify({ pid: 999999, mode: 'server', port: 8909 }); // a holder in another process that just ended
    await Deno.writeTextFile(`${dir}/${OWNER_FILE}`, gone);
    setTimeout(() => first.release(), 300); // the OS lets go a moment after the process ended
    const c = await claimFolder(dir, { mode: 'server', isAlive: () => false, exitWaitMs: 5000 });
    assert(c.primary);
    c.release();
    // ... but never past the deadline, and never while the holder is alive.
    const held = await claimFolder(dir, { mode: 'server' });
    assert(held.primary);
    await Deno.writeTextFile(`${dir}/${OWNER_FILE}`, gone);
    const t0 = performance.now();
    assertEquals((await claimFolder(dir, { mode: 'server', isAlive: () => false, exitWaitMs: 300 })).primary, false);
    assert(performance.now() - t0 >= 250);
    assertEquals((await claimFolder(dir, { mode: 'server', isAlive: () => true })).primary, false);
    held.release();
  });
});

Deno.test('the refusal line names the folder, the pid and what runs there', () => {
  const tail = 'Quit it first, or use --state-dir for a separate copy.';
  assertEquals(
    alreadyRunning('C:\\d', { pid: 12, mode: 'server', port: 8790 }),
    `AIB is already running for this data folder (C:\\d, pid 12, server on port 8790). ${tail}`,
  );
  assertEquals(
    alreadyRunning('C:\\d', { pid: 12, mode: 'desktop', port: 8777 }),
    `AIB is already running for this data folder (C:\\d, pid 12, desktop app). ${tail}`,
  );
  assertEquals(alreadyRunning('/d', null), `AIB is already running for this data folder (/d, another AIB). ${tail}`);
});

async function guard(dir: string, mode: 'desktop' | 'server') {
  const said: string[] = [];
  const notices: string[] = [];
  let code: number | null = null;
  try {
    const held = await guardDataFolder(dir, { mode, say: (l) => said.push(l), notice: (m) => (notices.push(m), Promise.resolve()), exit });
    held.release();
  } catch (error) {
    if (!(error instanceof Exited)) throw error;
    code = error.code;
  }
  return { said, notices, code };
}

Deno.test('a second start: serve exits 2 with one line; desktop shows the running app, or refuses with a box when a server owns it', async () => {
  await withDir(async (dir) => {
    const server = await claimFolder(dir, { mode: 'server', port: 8911 });
    assert(server.primary);
    const message = alreadyRunning(dir, { pid: Deno.pid, mode: 'server', port: 8911 });
    assertEquals(await guard(dir, 'server'), { said: [message], notices: [], code: 2 });
    assertEquals(await guard(dir, 'desktop'), { said: [message], notices: [message], code: 2 }, 'a desktop launch never starts a 2nd');
    assertEquals(await takeSignal(dir), false, 'a server has no window to show');
    server.release();

    const app = await claimFolder(dir, { mode: 'desktop' });
    assert(app.primary);
    assertEquals(await guard(dir, 'desktop'), {
      said: ['AIB is already running: its window was asked to show.'],
      notices: [],
      code: 0,
    });
    assert(await takeSignal(dir), 'the running app was asked to show its window');
    const desktopLine = alreadyRunning(dir, { pid: Deno.pid, mode: 'desktop', port: null });
    assertEquals(await guard(dir, 'server'), { said: [desktopLine], notices: [], code: 2 });
    app.release();

    const free = await guard(dir, 'server');
    assertEquals(free.code, null, 'nothing running: the start goes ahead');
  });
});

Deno.test('another --state-dir is another lock', async () => {
  await withDir(async (a) => {
    await withDir(async (b) => {
      const one = await claimFolder(a, { mode: 'server' });
      const two = await claimFolder(b, { mode: 'server' });
      assert(one.primary && two.primary);
      one.release();
      two.release();
    });
  });
});

Deno.test('desktop claim(): an owner that wrote no file (the 0.1.0-beta.1 app) is asked to show its window', async () => {
  await withDir(async (dir) => {
    const first = await claim(dir);
    assert(first.primary);
    await Deno.remove(`${dir}/${OWNER_FILE}`);
    const second = await claim(dir);
    assertEquals(second, { primary: false, owner: null });
    assert(exists(`${dir}/${SIGNAL_FILE}`));
    first.release();
  });
});
