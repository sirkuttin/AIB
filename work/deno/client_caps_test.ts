/**
 * server/acp/client_caps.ts: the unit cases of work/test_client_caps.py (FilesystemTests, TerminalTests), plus parity with
 * client_caps.py for path checks and fs requests. The EndToEnd cases there go through studio.Connection and belong to the
 * connection port. Child processes are the test's own Python one-liners; every terminal is released or shut down.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity, python } from './_parity.ts';
import {
  CapError,
  ClientCaps,
  type ClientCapsOptions,
  FS_READ_METHODS,
  FS_WRITE_METHODS,
  MAX_OUTPUT_LIMIT,
  MAX_READ_BYTES,
  MAX_TERMINALS,
  MAX_WRITE_BYTES,
  resolveInside,
  TERMINAL_METHODS,
  trimToLimit,
} from '../../outputs/agent-studio/server/acp/client_caps.ts';
import { basename, exists, join, normcase, realpath } from '../../outputs/agent-studio/server/platform/ospath.ts';
import { processAlive } from '../../outputs/agent-studio/server/platform/process_info.ts';

const WINDOWS = Deno.build.os === 'windows';
const PY = (() => {
  const out = new Deno.Command(python(), { args: ['-c', 'import sys; print(sys.executable)'], stdout: 'piped' }).outputSync();
  return new TextDecoder().decode(out.stdout).trim();
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(20);
  }
  throw new Error('condition not reached');
}

interface Ctx {
  ws: string;
  out: string;
  caps(options?: ClientCapsOptions): ClientCaps;
  err(c: ClientCaps, method: string, params?: Record<string, unknown>): Promise<CapError>;
}

function capsTest(name: string, fn: (t: Ctx) => Promise<void>) {
  Deno.test(name, async () => {
    const ws = realpath(Deno.makeTempDirSync({ prefix: 'caps-ws-' }));
    const out = realpath(Deno.makeTempDirSync({ prefix: 'caps-out-' }));
    const made: ClientCaps[] = [];
    const t: Ctx = {
      ws,
      out,
      caps(options = {}) {
        const c = new ClientCaps(ws, options);
        made.push(c);
        return c;
      },
      async err(c, method, params = {}) {
        return await assertRejects(() => c.call(method, { sessionId: 's', ...params }), CapError) as CapError;
      },
    };
    try {
      await fn(t);
    } finally {
      for (const c of made) await c.shutdown();
      for (const dir of [ws, out]) await removeWithRetry(dir);
    }
  });
}

async function removeWithRetry(dir: string) {
  for (let i = 0;; i++) {
    try {
      Deno.removeSync(dir, { recursive: true });
      return;
    } catch (error) {
      if (i > 50) throw error; // a killed process may keep its files for a moment
      await sleep(100);
    }
  }
}

// --- filesystem -------------------------------------------------------------------------------------------------------------------

capsTest('read a slice and write round trip', async (t) => {
  const c = t.caps({ fs: 'readwrite' });
  const target = join(t.ws, 'a.txt');
  assertEquals(await c.call('fs/write_text_file', { sessionId: 's', path: target, content: 'one\ntwo\r\nthree\nfour\n' }), null);
  assertEquals(await c.call('fs/read_text_file', { path: target }), { content: 'one\ntwo\r\nthree\nfour\n' });
  assertEquals(await c.call('fs/read_text_file', { path: target, line: 2, limit: 2 }), { content: 'two\r\nthree\n' });
  assertEquals(await c.call('fs/read_text_file', { path: target, line: 4 }), { content: 'four\n' });
  assertEquals(Deno.readTextFileSync(target), 'one\ntwo\r\nthree\nfour\n'); // no newline translation
  assertEquals([...Deno.readDirSync(t.ws)].filter((e) => e.name.startsWith('.studio-write-')), []);
  assertEquals(c.writes[c.writes.length - 1].bytes, 20);
  assertEquals(c.writes[c.writes.length - 1].created, true);
});

capsTest('write creates parents inside the workspace only', async (t) => {
  const c = t.caps({ fs: 'readwrite' });
  const deep = join(t.ws, 'x', 'y', 'f.txt');
  await c.call('fs/write_text_file', { path: deep, content: 'hi', sessionId: 's' });
  assertEquals(Deno.readTextFileSync(deep), 'hi');
  await t.err(c, 'fs/write_text_file', { path: join(t.ws, '..', basename(t.out), 'created-by-agent', 'f.txt'), content: 'x' });
  assertEquals([...Deno.readDirSync(t.out)], []);
});

capsTest('invalid paths are rejected', async (t) => {
  const c = t.caps({ fs: 'readwrite' });
  const secret = join(t.out, 'secret.txt');
  Deno.writeTextFileSync(secret, 'top secret');
  const bad: unknown[] = [
    'relative.txt',
    '',
    '..\\x',
    join(t.ws, '..', basename(t.out), 'secret.txt'),
    secret,
    '\\\\server\\share\\x.txt',
    '//server/share/x.txt',
    '\\\\?\\' + secret,
    '\\\\.\\' + secret,
    join(t.ws, 'f.txt:stream'),
    join(t.ws, 'a\0b'),
    123,
    null,
  ];
  if (WINDOWS) bad.push(join(t.ws, 'nul'), join(t.ws, 'COM1.txt'), join(t.ws, 'trail.'), (exists('Z:\\') ? 'Y:\\' : 'Z:\\') + 'file.txt');
  for (const path of bad) {
    await t.err(c, 'fs/read_text_file', { path });
    await t.err(c, 'fs/write_text_file', { path, content: 'x' });
  }
  assertEquals(Deno.readTextFileSync(secret), 'top secret');
});

capsTest('symlink and junction escapes are rejected', async (t) => {
  const c = t.caps({ fs: 'readwrite' });
  const secret = join(t.out, 'secret.txt');
  Deno.writeTextFileSync(secret, 'top secret');
  let made = 0;
  if (WINDOWS) {
    const junction = join(t.ws, 'junction');
    if (
      (await new Deno.Command('cmd', { args: ['/c', 'mklink', '/J', junction, t.out], stdout: 'null', stderr: 'null' }).output()).success
    ) {
      made++;
      await t.err(c, 'fs/read_text_file', { path: join(junction, 'secret.txt') });
      await t.err(c, 'fs/write_text_file', { path: join(junction, 'new.txt'), content: 'x' });
      assertEquals([...Deno.readDirSync(t.out)].map((e) => e.name), ['secret.txt']);
      Deno.removeSync(junction); // removes only the junction, never the target
    }
  }
  try {
    Deno.symlinkSync(t.out, join(t.ws, 'linkdir'), { type: 'dir' });
    Deno.symlinkSync(secret, join(t.ws, 'linkfile'), { type: 'file' });
    made++;
    await t.err(c, 'fs/read_text_file', { path: join(t.ws, 'linkdir', 'secret.txt') });
    await t.err(c, 'fs/read_text_file', { path: join(t.ws, 'linkfile') });
    await t.err(c, 'fs/write_text_file', { path: join(t.ws, 'linkfile'), content: 'overwritten' });
    await t.err(c, 'fs/write_text_file', { path: join(t.ws, 'linkdir', 'new.txt'), content: 'x' });
  } catch (error) {
    if (!(error instanceof Deno.errors.PermissionDenied) && !String(error).includes('privilege')) throw error; // no symlink rights
  }
  assertEquals(Deno.readTextFileSync(secret), 'top secret');
  assert(made > 0 || !WINDOWS, 'could make neither a junction nor a symlink');
});

capsTest('size caps, binary files and folders', async (t) => {
  const c = t.caps({ fs: 'readwrite' });
  const big = join(t.ws, 'big.txt');
  Deno.writeTextFileSync(big, ('x'.repeat(99) + '\n').repeat(Math.floor(MAX_READ_BYTES / 100) + 10));
  assert((await t.err(c, 'fs/read_text_file', { path: big })).message.includes('larger'));
  assertEquals(((await c.call('fs/read_text_file', { path: big, limit: 3 })) as { content: string }).content.length, 300);
  await t.err(c, 'fs/write_text_file', { path: join(t.ws, 'w.txt'), content: 'x'.repeat(MAX_WRITE_BYTES + 1) });
  const binary = join(t.ws, 'b.bin');
  Deno.writeFileSync(binary, new Uint8Array([0, 1, 2]));
  await t.err(c, 'fs/read_text_file', { path: binary });
  await t.err(c, 'fs/read_text_file', { path: t.ws });
  await t.err(c, 'fs/write_text_file', { path: t.ws, content: 'x' });
  for (const bad of [0, -1, true, 1.5, '2']) {
    await t.err(c, 'fs/read_text_file', { path: big, limit: bad });
    await t.err(c, 'fs/read_text_file', { path: big, line: bad });
  }
});

capsTest('the .git folder is write-protected', async (t) => {
  const c = t.caps({ fs: 'readwrite' });
  await t.err(c, 'fs/write_text_file', { path: join(t.ws, '.git', 'hooks', 'pre-commit'), content: 'x' });
  await t.err(c, 'fs/write_text_file', { path: join(t.ws, '.GIT', 'config'), content: 'x' });
});

capsTest('read-only mode refuses writes', async (t) => {
  const c = t.caps({ fs: 'read' });
  assertEquals(c.capabilities().fs, { readTextFile: true, writeTextFile: false });
  assertEquals([c.handles('fs/write_text_file'), c.handles('fs/read_text_file')], [false, true]);
  assertEquals((await t.err(c, 'fs/write_text_file', { path: join(t.ws, 'x.txt'), content: 'x' })).code, -32601);
  assertEquals([...Deno.readDirSync(t.ws)], []);
});

capsTest('nothing is handled by default', async (t) => {
  const c = t.caps();
  assertEquals(c.capabilities(), { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  for (const method of [...TERMINAL_METHODS, ...FS_READ_METHODS, ...FS_WRITE_METHODS]) assertEquals(c.handles(method), false);
  assertEquals((await t.err(c, 'terminal/create', { command: PY })).code, -32601);
  let threw = false;
  try {
    new ClientCaps(t.ws, { fs: 'write' as never });
  } catch (error) {
    threw = (error as Error).message === "fs must be None, 'read' or 'readwrite'";
  }
  assert(threw);
});

capsTest('dispatch answers in JSON-RPC and checks the session', async (t) => {
  const replies: Record<string, unknown>[] = [];
  const events: [string, Record<string, unknown>][] = [];
  const c = t.caps({
    fs: 'readwrite',
    knownSession: (s) => s === 'mine',
    writeResponse: (r) => replies.push(r),
    record: (k, d) => events.push([k, d]),
  });
  const target = join(t.ws, 'n.txt');
  await c.dispatch({ id: 1, method: 'fs/write_text_file', params: { sessionId: 'mine', path: target, content: 'from agent' } });
  await c.dispatch({ id: 2, method: 'fs/read_text_file', params: { sessionId: 'mine', path: target } });
  await c.dispatch({ id: 3, method: 'fs/read_text_file', params: { sessionId: 'not-mine', path: target } });
  await c.dispatch({ id: 4, method: 'fs/read_text_file', params: 'x' });
  await c.dispatch({ id: 5, method: 'terminal/create', params: { sessionId: 'mine', command: PY } });
  assertEquals(replies, [
    { jsonrpc: '2.0', id: 1, result: null },
    { jsonrpc: '2.0', id: 2, result: { content: 'from agent' } },
    { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Unknown sessionId' } },
    { jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'params must be an object' } },
    { jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Client capability not advertised: terminal/create' } },
  ]);
  assertEquals(events.map(([k, d]) => [k, d.op, d.bytes, d.path]), [['client_fs', 'write', 10, target]]);
  assertEquals((c.public().writes as Record<string, unknown>[])[0].path, target);
});

capsTest('path checks and fs requests match Python', async (t) => {
  await using py = new PyParity();
  const secret = join(t.out, 'secret.txt');
  Deno.writeTextFileSync(secret, 'top secret');
  Deno.mkdirSync(join(t.ws, 'sub'));
  Deno.writeTextFileSync(join(t.ws, 'sub', 'f.txt'), 'a\nb\r\nc\n\u00e9\u20ac\ud83d\ude00\nlast');
  Deno.writeFileSync(join(t.ws, 'bad.txt'), new Uint8Array([0x61, 0xff, 0xfe, 0x0a, 0x62, 0xc3]));
  const paths: unknown[] = [
    join(t.ws, 'sub', 'f.txt'),
    join(t.ws, 'sub', '..', 'sub', 'f.txt'),
    t.ws,
    join(t.ws, 'missing', 'x'),
    'relative.txt',
    '',
    '..\\x',
    secret,
    join(t.ws, '..', basename(t.out), 'secret.txt'),
    '\\\\server\\share\\x.txt',
    '//server/share/x.txt',
    '\\\\?\\' + secret,
    '\\\\.\\' + secret,
    join(t.ws, 'f.txt:stream'),
    join(t.ws, 'a\0b'),
    123,
    null,
    'x'.repeat(5000),
    '/x',
    '\\x',
    join(t.ws, 'nul'),
    join(t.ws, 'Con.txt'),
    join(t.ws, 'dot.'),
    join(t.ws, 'space '),
    join(t.ws, '.', 'sub'),
    join(t.ws, 'LPT1'),
    join(t.ws, 'COM10'),
    t.ws.toUpperCase(),
  ];
  for (const path of paths) {
    for (const what of ['path', 'cwd']) {
      const expected = await py.raw('client_caps', 'resolve_inside', [path, t.ws, what]);
      let actual: unknown;
      try {
        actual = { ok: resolveInside(path, t.ws, what) };
      } catch (error) {
        actual = { error: 'CapError', message: (error as Error).message };
      }
      if ('ok' in expected && 'ok' in (actual as object)) {
        assertEquals(normcase((actual as { ok: string }).ok), normcase(expected.ok as string), String(path)); // realpath's case may differ
      } else assertEquals(actual, expected, JSON.stringify(path));
    }
  }
  const reads: Record<string, unknown>[] = [
    { path: join(t.ws, 'sub', 'f.txt') },
    { path: join(t.ws, 'sub', 'f.txt'), line: 2 },
    { path: join(t.ws, 'sub', 'f.txt'), line: 2, limit: 2 },
    { path: join(t.ws, 'sub', 'f.txt'), line: 99 },
    { path: join(t.ws, 'sub', 'f.txt'), limit: 1 },
    { path: join(t.ws, 'bad.txt') },
    { path: join(t.ws, 'sub', 'f.txt'), line: 0 },
    { path: join(t.ws, 'sub', 'f.txt'), limit: '1' },
    { path: join(t.ws, 'sub') },
    { path: join(t.ws, 'missing.txt') },
  ];
  for (const params of reads) {
    const expected = await pyCall(py, [t.ws, false, 'read'], 'fs/read_text_file', params);
    assertEquals(await portCall(t.caps({ fs: 'read' }), 'fs/read_text_file', params), expected, JSON.stringify(params));
  }
  const writes: Record<string, unknown>[] = [
    { path: join(t.ws, '.git', 'x'), content: 'x' },
    { path: join(t.ws, 'sub'), content: 'x' },
    { path: join(t.ws, 'w.txt'), content: 5 },
    { path: secret, content: 'x' },
    { path: 'rel', content: 'x' },
  ];
  for (const params of writes) {
    const expected = await pyCall(py, [t.ws, false, 'readwrite'], 'fs/write_text_file', params);
    assertEquals(await portCall(t.caps({ fs: 'readwrite' }), 'fs/write_text_file', params), expected, JSON.stringify(params));
  }
  const creates: Record<string, unknown>[] = [
    { command: '' },
    { command: '   ' },
    { command: 5 },
    { command: PY, args: '-c pass' },
    { command: PY, args: [1] },
    { command: PY, args: ['a\0b'] },
    { command: PY, cwd: t.out },
    { command: PY, cwd: join(t.ws, 'missing') },
    { command: PY, cwd: 'relative' },
    { command: PY, outputByteLimit: -1 },
    { command: PY, outputByteLimit: 'x' },
    { command: PY, outputByteLimit: 1.5 },
    { command: PY, env: 'A=B' },
    { command: PY, env: [{ name: 'bad name', value: 'x' }] },
    { command: PY, env: [{ name: 'A', value: 1 }] },
    { command: PY, env: [{ name: 'A', value: 'x\0' }] },
    { command: PY, env: Array.from({ length: 65 }, () => ({ name: 'A', value: 'x' })) },
    { command: 'definitely-not-a-real-command-xyz' },
    { command: join(t.ws, 'missing.exe') },
  ];
  if (WINDOWS) {
    Deno.writeTextFileSync(join(t.ws, 'run.bat'), '@echo hi');
    creates.push({ command: join(t.ws, 'run.bat') });
  }
  for (const params of creates) {
    const expected = await pyCall(py, [t.ws, true, null], 'terminal/create', params);
    assertEquals(await portCall(t.caps({ terminal: true }), 'terminal/create', params), expected, JSON.stringify(params).slice(0, 100));
  }
});

function pyCall(py: PyParity, init: unknown[], method: string, params: Record<string, unknown>) {
  return py.call('client_caps_shim', 'call', [...init, method, { sessionId: 's', ...params }]);
}

async function portCall(caps: ClientCaps, method: string, params: Record<string, unknown>) {
  try {
    return { ok: JSON.parse(JSON.stringify(await caps.call(method, { sessionId: 's', ...params }) ?? null)) };
  } catch (error) {
    if (!(error instanceof CapError)) throw error;
    return { error: 'CapError', code: error.code, message: error.message };
  }
}

// --- terminals --------------------------------------------------------------------------------------------------------------------

async function create(c: ClientCaps, args: string[], extra: Record<string, unknown> = {}): Promise<string> {
  return ((await c.call('terminal/create', { sessionId: 's', command: PY, args, ...extra })) as { terminalId: string }).terminalId;
}
const wait = (c: ClientCaps, terminalId: string) => c.call('terminal/wait_for_exit', { sessionId: 's', terminalId });
const output = async (c: ClientCaps, terminalId: string) =>
  (await c.call('terminal/output', { sessionId: 's', terminalId })) as {
    output: string;
    truncated: boolean;
    exitStatus?: Record<string, unknown>;
  };

capsTest('run, collect output and exit code', async (t) => {
  const c = t.caps({ terminal: true });
  const id = await create(c, ['-c', 'import sys;print("hello");sys.exit(3)']);
  assertEquals(await wait(c, id), { exitCode: 3, signal: null });
  const out = await output(c, id);
  assertEquals([out.output.trim(), out.truncated, out.exitStatus?.exitCode], ['hello', false, 3]);
  const row = (c.public().terminals as Record<string, unknown>[])[0];
  assertEquals([row.status, row.exitCode, row.cwd], ['exited', 3, t.ws]);
});

capsTest('argv is not shell-interpolated', async (t) => {
  const c = t.caps({ terminal: true });
  const nasty = 'a; echo PWNED & echo $HOME %PATH% `x` "q"';
  const id = await create(c, ['-c', 'import sys;print(sys.argv[1])', nasty]);
  await wait(c, id);
  assertEquals((await output(c, id)).output.trim(), nasty);
});

capsTest('cwd must stay in the workspace', async (t) => {
  const c = t.caps({ terminal: true });
  const sub = join(t.ws, 'sub');
  Deno.mkdirSync(sub);
  const id = await create(c, ['-c', 'import os;print(os.getcwd())'], { cwd: sub });
  await wait(c, id);
  assertEquals(normcase(realpath((await output(c, id)).output.trim())), normcase(sub));
  for (const bad of [t.out, join(t.ws, '..'), 'relative', '\\\\server\\share', join(t.ws, 'missing')]) {
    await t.err(c, 'terminal/create', { command: PY, args: ['-c', 'pass'], cwd: bad });
  }
  assertEquals(c.terminals.size, 1);
  if (WINDOWS) {
    const junction = join(t.ws, 'junction');
    if (
      (await new Deno.Command('cmd', { args: ['/c', 'mklink', '/J', junction, t.out], stdout: 'null', stderr: 'null' }).output()).success
    ) {
      await t.err(c, 'terminal/create', { command: PY, args: ['-c', 'pass'], cwd: junction });
      Deno.removeSync(junction);
    }
  }
});

capsTest('the output limit keeps the end and flags truncation', async (t) => {
  const c = t.caps({ terminal: true });
  const id = await create(c, ['-c', 'print("A"*5000);print("END")'], { outputByteLimit: 100 });
  await wait(c, id);
  const out = await output(c, id);
  assert(out.truncated);
  assert(new TextEncoder().encode(out.output).length <= 100);
  assert(out.output.trim().endsWith('END'));
  const id2 = await create(c, ['-c', 'print(1)'], { outputByteLimit: 10 ** 12 });
  assertEquals(c.terminals.get(id2)!.limit, MAX_OUTPUT_LIMIT);
  for (const bad of [-1, 'x', true, 1.5]) await t.err(c, 'terminal/create', { command: PY, args: ['-c', 'pass'], outputByteLimit: bad });
});

Deno.test('trimming keeps whole UTF-8 characters', () => {
  const [kept, trimmed] = trimToLimit(new TextEncoder().encode('é'.repeat(10)), 5);
  assertEquals([trimmed, new TextDecoder('utf-8', { fatal: true }).decode(kept)], [true, 'éé']);
  assertEquals(trimToLimit(new Uint8Array(3), 5)[1], false);
});

capsTest('the environment holds only what was asked for', async (t) => {
  const c = t.caps({ terminal: true });
  Deno.env.set('STUDIO_CAPS_SECRET', 'leak');
  try {
    const id = await create(c, ['-c', 'import os;print(os.environ.get("STUDIO_CAPS_SECRET"), os.environ.get("ASKED"))'], {
      env: [{ name: 'ASKED', value: 'yes' }],
    });
    await wait(c, id);
    assertEquals((await output(c, id)).output.trim(), 'None yes');
  } finally {
    Deno.env.delete('STUDIO_CAPS_SECRET');
  }
  for (
    const bad of [[{ name: 'bad name', value: 'x' }], [{ name: 'A=B', value: 'x' }], [{ name: 'A', value: 1 }], 'A=B', [{
      name: 'A',
      value: 'x\0',
    }]]
  ) {
    await t.err(c, 'terminal/create', { command: PY, args: ['-c', 'pass'], env: bad });
  }
});

capsTest('batch files, missing commands and bad args are refused', async (t) => {
  const c = t.caps({ terminal: true });
  const bat = join(t.ws, 'run.bat');
  Deno.writeTextFileSync(bat, '@echo hi');
  if (WINDOWS) await t.err(c, 'terminal/create', { command: bat });
  await t.err(c, 'terminal/create', { command: 'definitely-not-a-real-command-xyz' });
  await t.err(c, 'terminal/create', { command: '' });
  await t.err(c, 'terminal/create', { command: PY, args: '-c pass' });
  await t.err(c, 'terminal/create', { command: PY, args: [1] });
  await t.err(c, 'terminal/create', { command: PY, args: ['a\0b'] });
  assertEquals(c.terminals.size, 0);
});

capsTest('kill, then release, cleans up', async (t) => {
  const c = t.caps({ terminal: true });
  const id = await create(c, ['-c', 'import time;print("up", flush=True);time.sleep(120)']);
  const pid = c.terminals.get(id)!.process.pid;
  for (let i = 0; i < 500 && !(await output(c, id)).output.includes('up'); i++) await sleep(20);
  assertEquals((c.public().terminals as Record<string, unknown>[])[0].status, 'running');
  assertEquals(await c.call('terminal/kill', { sessionId: 's', terminalId: id }), null);
  assertEquals((c.public().terminals as Record<string, unknown>[])[0].status, 'killed');
  if (WINDOWS) assertEquals(processAlive(pid), false);
  assert('exitStatus' in (await output(c, id))); // still readable until released
  assertEquals(await c.call('terminal/release', { sessionId: 's', terminalId: id }), null);
  assertEquals(c.public().terminals, []);
  await t.err(c, 'terminal/output', { terminalId: id });
});

capsTest('release kills a running process and unblocks wait_for_exit', async (t) => {
  const c = t.caps({ terminal: true });
  const id = await create(c, ['-c', 'import time;time.sleep(120)']);
  const replies: Record<string, unknown>[] = [];
  c.writeResponse = (r) => replies.push(r);
  const waiting = c.dispatch({ id: 9, method: 'terminal/wait_for_exit', params: { sessionId: 's', terminalId: id } });
  await sleep(300);
  assertEquals(replies, []);
  await c.call('terminal/release', { sessionId: 's', terminalId: id });
  await waiting;
  assertEquals(replies.length, 1);
  assert('result' in replies[0]);
});

capsTest('shutdown and closeSession kill everything', async (t) => {
  const c = t.caps({ terminal: true });
  const a = await create(c, ['-c', 'import time;time.sleep(120)']);
  const b = await create(c, ['-c', 'import time;time.sleep(120)']);
  const [ta, tb] = [c.terminals.get(a)!, c.terminals.get(b)!];
  await c.closeSession('s');
  assert(ta.isExited && tb.isExited);
  assertEquals(c.public().terminals, []);
  const d = await create(c, ['-c', 'import time;time.sleep(120)']);
  const td = c.terminals.get(d)!;
  await c.shutdown();
  assert(td.isExited);
  const error = await t.err(c, 'terminal/create', { command: PY, args: ['-c', 'pass'] });
  assertEquals([error.code, error.message], [-32603, 'Connection is closing']);
});

capsTest('child processes are killed too', async (t) => {
  const c = t.caps({ terminal: true });
  const marker = join(t.ws, 'child.pid');
  const script = 'import subprocess,sys,time;p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(120)"]);' +
    `open(${JSON.stringify(marker)},"w").write(str(p.pid));time.sleep(120)`;
  const id = await create(c, ['-c', script]);
  const read = () => {
    try {
      return Deno.readTextFileSync(marker).trim();
    } catch {
      return '';
    }
  };
  await until(() => !!read());
  const child = Number(read());
  await c.call('terminal/release', { sessionId: 's', terminalId: id });
  const alive = () => {
    if (WINDOWS) return processAlive(child) === true;
    try {
      return Deno.statSync(`/proc/${child}`).isDirectory;
    } catch {
      return false;
    }
  };
  await until(() => !alive());
});

capsTest('the terminal limit, and terminal ids of another session', async (t) => {
  const c = t.caps({ terminal: true });
  const ids: string[] = [];
  for (let i = 0; i < MAX_TERMINALS; i++) ids.push(await create(c, ['-c', 'import time;time.sleep(60)']));
  assert((await t.err(c, 'terminal/create', { command: PY, args: ['-c', 'pass'] })).message.includes('At most 8'));
  await assertRejects(() => c.call('terminal/output', { sessionId: 'other-session', terminalId: ids[0] }), CapError);
  await t.err(c, 'terminal/output', { terminalId: 'term_nope' });
  await t.err(c, 'terminal/output', { terminalId: 5 });
});
