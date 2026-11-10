/**
 * The chat terminal: the real PTY (ConPTY on Windows, headless: no window), the session manager, the WebSocket framing, and the
 * routes behind the page gate (both listener kinds: Deno.serve and the desktop binary's node:http path).
 */
import { assert, assertEquals } from './_assert.ts';
import { clampSize, defaultShell, type Pty, type PtyOptions, spawnPty } from '../../outputs/agent-studio/server/platform/pty.ts';
import { checkCwd, pasteInput, TerminalError, TerminalSessions } from '../../outputs/agent-studio/server/terminal/sessions.ts';
import { acceptKey, encodeFrame, FrameReader, type WsLink } from '../../outputs/agent-studio/server/platform/websocket.ts';
import { makeContext, WebServer } from '../../outputs/agent-studio/server/web/server.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

const win = Deno.build.os === 'windows';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// deno-lint-ignore no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/** Collects a PTY's output as text. */
function collect(pty: Pty) {
  let text = '';
  pty.onData = (b) => (text += new TextDecoder().decode(b));
  return {
    get text() {
      return strip(text);
    },
    async waitFor(needle: string | RegExp, ms = 15000): Promise<void> {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const t = strip(text);
        if (typeof needle === 'string' ? t.includes(needle) : needle.test(t)) return;
        await sleep(50);
      }
      throw new Error(`timed out waiting for ${needle}; output:\n${strip(text).slice(-800)}`);
    },
  };
}

/** True while any visible top-level window belongs to `pid` (Windows; MainWindowHandle is 0 for windowless processes). */
async function hasVisibleWindow(pid: number): Promise<boolean> {
  const out = await new Deno.Command('powershell.exe', {
    args: ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`],
    stdout: 'piped',
    stderr: 'null',
  }).output();
  const handle = new TextDecoder().decode(out.stdout).trim();
  return handle !== '' && handle !== '0';
}

function alive(pid: number): boolean {
  if (win) {
    const out = new Deno.Command('tasklist', { args: ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], stdout: 'piped', stderr: 'null' })
      .outputSync();
    return new TextDecoder().decode(out.stdout).includes(`"${pid}"`);
  }
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

// ---- the PTY ------------------------------------------------------------------------------------------------------------------

Deno.test('defaultShell: pwsh when on PATH, else Windows PowerShell; $SHELL -l or /bin/bash elsewhere', () => {
  const env = (vars: Record<string, string>) => ({ get: (n: string) => vars[n] });
  if (win) {
    const shell = defaultShell(env({ PATH: '', SystemRoot: 'C:\\Windows' }));
    assertEquals(shell, { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] });
    const pwsh = defaultShell(Deno.env);
    assert(/pwsh\.exe$|powershell\.exe$/i.test(pwsh.file), pwsh.file);
  } else {
    assertEquals(defaultShell(env({ SHELL: '/bin/zsh' })), { file: '/bin/zsh', args: ['-l'] });
    assertEquals(defaultShell(env({})), { file: '/bin/bash', args: ['-l'] });
  }
  assertEquals(clampSize('x', 0), { cols: 80, rows: 24 });
  assertEquals(clampSize(5000, 30.7), { cols: 1000, rows: 30 });
});

Deno.test('PTY: a headless shell in the given folder echoes, resizes and is killed with what it started', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: 'aib-pty-' }));
  const pty = spawnPty({ ...defaultShell(), cwd: dir, cols: 100, rows: 30 });
  const out = collect(pty);
  let childPid = 0;
  try {
    pty.write(win ? 'echo "hi-$(6*7)"; (Get-Location).Path\r' : 'echo "hi-$((6*7))"; pwd\r');
    await out.waitFor('hi-42');
    await out.waitFor(dir.split(/[\\/]/).pop()!);
    if (win) assert(!(await hasVisibleWindow(pty.pid)), 'the shell has a visible window');
    pty.resize(57, 21);
    pty.write(win ? '"w=" + $Host.UI.RawUI.WindowSize.Width\r' : 'echo "w=$(tput cols)"\r');
    await out.waitFor('w=57');
    // a child of the shell must end with it
    pty.write(
      win
        ? '$p = Start-Process -PassThru -NoNewWindow ping -ArgumentList "-n","60","127.0.0.1"; "child=" + $p.Id\r'
        : 'sleep 60 & echo "child=$!"\r',
    );
    await out.waitFor(/child=\d+/);
    childPid = Number(out.text.match(/child=(\d+)/)![1]);
    assert(alive(childPid), 'the child did not start');
  } finally {
    const t0 = Date.now();
    await pty.kill();
    assert(Date.now() - t0 < 10000, 'kill took too long');
  }
  assertEquals(typeof (await pty.exited), 'number');
  assert(!alive(pty.pid), 'the shell is still running');
  await sleep(300);
  assert(!alive(childPid), 'a program the shell started is still running');
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test('PTY: the shell ending by itself resolves exited with its code', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'aib-pty-' });
  const pty = spawnPty({ ...defaultShell(), cwd: dir, cols: 80, rows: 24 });
  collect(pty);
  pty.write('exit 7\r');
  assertEquals(await pty.exited, 7);
  await pty.kill(); // harmless afterwards
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test('PTY: a folder that does not exist is refused at start', () => {
  let failed = false;
  try {
    spawnPty({ ...defaultShell(), cwd: win ? 'C:\\no\\such\\folder\\aib' : '/no/such/folder/aib', cols: 80, rows: 24 });
  } catch {
    failed = true;
  }
  assert(failed);
});

// ---- the session manager (fake PTYs) ------------------------------------------------------------------------------------------

class FakePty implements Pty {
  static started: FakePty[] = [];
  readonly pid = 4242;
  onData: ((bytes: Uint8Array) => void) | null = null;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = false;
  #resolve!: (code: number) => void;
  readonly exited = new Promise<number>((r) => (this.#resolve = r));
  constructor(readonly options: PtyOptions) {
    FakePty.started.push(this);
  }
  write(data: string | Uint8Array) {
    this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  terminate() {
    this.killed = true;
    this.#resolve(1);
  }
  kill() {
    this.terminate();
    return this.exited.then(() => {});
  }
  finish(code: number) {
    this.#resolve(code);
  }
  isBusy = false;
  busy() {
    return this.isBusy;
  }
  emit(text: string) {
    this.onData?.(new TextEncoder().encode(text));
  }
}

class FakeLink implements WsLink {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  get isOpen() {
    return !this.closed;
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  get messages() {
    return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s as string));
  }
  get output() {
    return this.sent.filter((s) => typeof s !== 'string').map((b) => new TextDecoder().decode(b as Uint8Array)).join('');
  }
}

Deno.test('sessions: one shell per chat in its folder, reused on reattach with its recent output; limit; end; endAll', async () => {
  const dir = await Deno.makeTempDir();
  FakePty.started = [];
  const sessions = new TerminalSessions({ max: 2, spawn: (o) => new FakePty(o), shell: () => ({ file: 'sh', args: [] }) });
  const a = new FakeLink();
  const s1 = sessions.attach(a, 'claude:1', dir, 90, 20)!;
  assertEquals(FakePty.started.length, 1);
  assertEquals(FakePty.started[0].options.cwd, dir);
  assertEquals([FakePty.started[0].options.cols, FakePty.started[0].options.rows], [90, 20]);
  assertEquals(a.messages[0].type, 'ready');
  assertEquals(a.messages[0].resumed, false);
  FakePty.started[0].emit('hello');
  assertEquals(a.output, 'hello');
  a.onmessage!(JSON.stringify({ type: 'input', data: 'ls\r' }));
  a.onmessage!(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  a.onmessage!('not json');
  assertEquals(FakePty.started[0].written, ['ls\r']);
  assertEquals(FakePty.started[0].sizes, [[120, 40]]);
  assertEquals(a.messages[0].shellName, 'sh');
  FakePty.started[0].isBusy = true;
  a.onmessage!(JSON.stringify({ type: 'busy?', id: 7 }));
  assertEquals(a.messages.at(-1), { type: 'busy', id: 7, busy: true });

  // a second page on the same chat gets the same shell, and what it printed so far
  const b = new FakeLink();
  const again = sessions.attach(b, 'claude:1', 'ignored', 80, 24)!;
  assert(again === s1);
  assertEquals(FakePty.started.length, 1);
  assertEquals(b.messages[0].resumed, true);
  assertEquals(b.output, 'hello');

  sessions.attach(new FakeLink(), 'claude:2', dir, 80, 24);
  const refused = new FakeLink();
  assertEquals(sessions.attach(refused, 'claude:3', dir, 80, 24), null);
  assertEquals(refused.messages[0].code, 'too_many');
  assertEquals(refused.messages[0].max, 2);
  assertEquals(refused.messages[0].terminals.map((t: { key: string }) => t.key).sort(), ['claude:1', 'claude:2']);
  assert(refused.closed);

  const bad = new FakeLink();
  assertEquals(sessions.attach(bad, 'claude:4', dir + '-missing', 80, 24), null);
  assertEquals([bad.messages[0].code, bad.messages[0].cwd], ['folder_missing', dir + '-missing']);
  assertEquals(sessions.list().map((t) => t.key).sort(), ['claude:1', 'claude:2']);

  assertEquals(await sessions.end('claude:1'), true);
  assert(FakePty.started[0].killed);
  assertEquals(await sessions.end('claude:1'), false);
  await sleep(0);
  assert(a.closed && b.closed, 'pages are told the shell ended');
  assertEquals(a.messages.at(-1), { type: 'exit', code: 1 });

  const c = new FakeLink();
  sessions.attach(c, 'claude:5', dir + '-missing', 80, 24);
  assertEquals(c.messages[0].code, 'folder_missing');
  // the page's explicit fallback: Windows PowerShell instead of the default shell
  const d = new FakeLink();
  sessions.attach(d, 'claude:7', dir, 80, 24, 'windows-powershell');
  if (win) assert(/WindowsPowerShell\\v1\.0\\powershell\.exe$/.test(FakePty.started.at(-1)!.options.file));
  assertEquals(d.messages[0].shellName, win ? 'Windows PowerShell' : 'sh');

  await sessions.endAll();
  assert(FakePty.started.every((p) => p.killed));
  assertEquals(sessions.list(), []);
  const late = new FakeLink();
  sessions.attach(late, 'claude:6', dir, 80, 24);
  assertEquals(late.messages[0].code, 'closing');
  await Deno.remove(dir, { recursive: true });
});

Deno.test('sessions: a shell that exits by itself is dropped, and the next attach starts a new one', async () => {
  const dir = await Deno.makeTempDir();
  FakePty.started = [];
  const sessions = new TerminalSessions({ spawn: (o) => new FakePty(o), shell: () => ({ file: 'sh', args: [] }) });
  const a = new FakeLink();
  sessions.attach(a, 'k', dir, 80, 24);
  FakePty.started[0].finish(3);
  await sleep(0);
  assertEquals(a.messages.at(-1), { type: 'exit', code: 3 });
  assertEquals(sessions.list(), []);
  sessions.attach(new FakeLink(), 'k', dir, 80, 24);
  assertEquals(FakePty.started.length, 2);
  await sessions.endAll();
  await Deno.remove(dir, { recursive: true });
});

Deno.test('pasteInput: no trailing Enter, no control characters, lines that do not run', () => {
  const ESC = '\x1b';
  assertEquals(pasteInput('npm test\n\n', 'windows'), 'npm test');
  assertEquals(pasteInput('a\tb\x07\x1b[201~c', 'linux'), 'a    b[201~c');
  const shiftEnter = `${ESC}[13;28;13;1;16;1_${ESC}[13;28;13;0;16;1_`;
  assertEquals(pasteInput('cd x\r\nnpm test\n', 'windows'), `cd x${shiftEnter}npm test`);
  assertEquals(pasteInput('cd x\nnpm test\n', 'linux'), `${ESC}[200~cd x\rnpm test${ESC}[201~`);
  assertEquals(pasteInput('', 'darwin'), '');
});

Deno.test({
  name: 'PTY + paste: several lines reach the PowerShell prompt and none runs until Enter',
  ignore: !win,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'aib-pty-' });
    const pty = spawnPty({ ...defaultShell(), cwd: dir, cols: 100, rows: 30 });
    const out = collect(pty);
    try {
      pty.write('"go-" + 1\r');
      await out.waitFor('go-1');
      pty.write(pasteInput('"pa-" + 10\n"pb-" + 20\n'));
      await sleep(1500);
      assert(!out.text.includes('pa-10'), 'a pasted line ran');
      pty.write('\r');
      await out.waitFor('pb-20');
      assert(out.text.includes('pa-10'));
    } finally {
      await pty.kill();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: 'PTY busy: true while a command runs in the shell, false back at the prompt',
  ignore: !win,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'aib-pty-' });
    const pty = spawnPty({ ...defaultShell(), cwd: dir, cols: 100, rows: 30 });
    const out = collect(pty);
    try {
      pty.write('"go-" + 1\r');
      await out.waitFor('go-1');
      assertEquals(pty.busy(), false);
      pty.write('ping -n 4 127.0.0.1; "done-" + 2\r');
      await out.waitFor(/Reply from|Pinging/);
      assertEquals(pty.busy(), true);
      await out.waitFor('done-2');
      await sleep(300);
      assertEquals(pty.busy(), false);
    } finally {
      await pty.kill();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test('checkCwd refuses empty, relative, network and missing folders', async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(checkCwd(dir), dir);
  for (const bad of ['', 'relative/x', '\\\\server\\share', '//server/share', dir + '-missing', 42]) {
    let error: unknown = null;
    try {
      checkCwd(bad);
    } catch (e) {
      error = e;
    }
    assert(error instanceof TerminalError, String(bad));
  }
  await Deno.remove(dir);
});

// ---- WebSocket framing --------------------------------------------------------------------------------------------------------

function clientFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const mask = new Uint8Array([1, 2, 3, 4]);
  const n = payload.length;
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const out = new Uint8Array(head + 4 + n);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (n < 126) out[1] = 0x80 | n;
  else if (n < 65536) (out[1] = 0x80 | 126, out[2] = n >> 8, out[3] = n & 0xff);
  else (out[1] = 0x80 | 127, new DataView(out.buffer).setBigUint64(2, BigInt(n)));
  out.set(mask, head);
  for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

Deno.test('websocket framing: accept key, masked client frames in pieces, sizes, unmasked refused', () => {
  assertEquals(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='); // RFC 6455 example
  const reader = new FrameReader();
  const big = new Uint8Array(70000).fill(65);
  const bytes = new Uint8Array([
    ...clientFrame(1, new TextEncoder().encode('hi')),
    ...clientFrame(2, big),
    ...clientFrame(1, new Uint8Array(300)),
  ]);
  const frames = [...reader.push(bytes.subarray(0, 5)), ...reader.push(bytes.subarray(5, 1000)), ...reader.push(bytes.subarray(1000))];
  assertEquals(frames.map((f) => [f.opcode, f.payload.length]), [[1, 2], [2, 70000], [1, 300]]);
  assertEquals(new TextDecoder().decode(frames[0].payload), 'hi');
  assertEquals(encodeFrame(1, new Uint8Array(3)).slice(0, 2), new Uint8Array([0x81, 3]));
  assertEquals([...encodeFrame(2, new Uint8Array(200)).slice(0, 4)], [0x82, 126, 0, 200]);
  let threw = false;
  try {
    new FrameReader().push(new Uint8Array([0x81, 0x02, 0x68, 0x69]));
  } catch {
    threw = true;
  }
  assert(threw, 'unmasked frame accepted');
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------

async function startServer(impl: 'deno' | 'node', terminals?: TerminalSessions) {
  const previous = Deno.env.get('AIB_HTTP_IMPL');
  Deno.env.set('AIB_HTTP_IMPL', impl);
  const stateDir = await Deno.makeTempDir({ prefix: 'aib-term-state-' });
  const ctx = makeContext({
    stateDir,
    host: {} as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
  });
  if (terminals) ctx.terminals = terminals;
  const server = new WebServer(ctx);
  const port = await server.listen(0);
  if (previous === undefined) Deno.env.delete('AIB_HTTP_IMPL');
  else Deno.env.set('AIB_HTTP_IMPL', previous);
  return {
    ctx,
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await server.close();
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
    },
  };
}

/** A raw handshake: the status line the server answers with (refusals never become sockets). */
async function handshake(port: number, path: string, headers: Record<string, string>): Promise<number> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  await conn.write(new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n'));
  const buffer = new Uint8Array(4096);
  const n = await conn.read(buffer);
  conn.close();
  const status = new TextDecoder().decode(buffer.subarray(0, n ?? 0)).split('\r\n')[0];
  return Number(status.split(' ')[1]);
}

/** A page-like client: Deno's WebSocket with the page's Origin and subprotocols. */
function open(server: { port: number; origin: string; ctx: { token: string } }, key: string, cwd: string) {
  const url = `ws://127.0.0.1:${server.port}/api/live/terminal?key=${encodeURIComponent(key)}&cwd=${
    encodeURIComponent(cwd)
  }&cols=100&rows=30`;
  // @ts-ignore: Deno's WebSocket takes headers
  const ws = new WebSocket(url, { protocols: ['aib-terminal', 'aib-token.' + server.ctx.token], headers: { Origin: server.origin } });
  ws.binaryType = 'arraybuffer';
  const messages: Record<string, unknown>[] = [];
  let output = '';
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') messages.push(JSON.parse(e.data));
    else output += new TextDecoder().decode(e.data);
  };
  const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()));
  return {
    ws,
    messages,
    closed,
    get output() {
      return strip(output);
    },
    async waitFor(test: () => boolean, what: string, ms = 15000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (test()) return;
        await sleep(50);
      }
      throw new Error(`timed out: ${what}; output:\n${strip(output).slice(-600)}; messages ${JSON.stringify(messages)}`);
    },
  };
}

for (const impl of ['deno', 'node'] as const) {
  Deno.test(`terminal routes (${impl} listener): the gate refuses strangers before any socket exists`, async () => {
    const dir = await Deno.makeTempDir();
    FakePty.started = [];
    const terminals = new TerminalSessions({ spawn: (o) => new FakePty(o), shell: () => ({ file: 'sh', args: [] }) });
    const server = await startServer(impl, terminals);
    const path = `/api/live/terminal?key=k&cwd=${encodeURIComponent(dir)}`;
    const proto = (token: string) => ({ 'Sec-WebSocket-Protocol': `aib-terminal, aib-token.${token}` });
    try {
      assertEquals(await handshake(server.port, path, { Origin: server.origin }), 403, 'no token');
      assertEquals(await handshake(server.port, path, { Origin: server.origin, ...proto('wrong') }), 403, 'wrong token');
      assertEquals(await handshake(server.port, path, { ...proto(server.ctx.token) }), 403, 'no Origin');
      const artifactOrigin = `http://127.0.0.1:${server.port + 1}`;
      assertEquals(await handshake(server.port, path, { Origin: artifactOrigin, ...proto(server.ctx.token) }), 403, 'artifact origin');
      assertEquals(
        await handshake(server.port, path, { Origin: 'http://evil.example', ...proto(server.ctx.token) }),
        403,
        'foreign origin',
      );
      assertEquals(
        await handshake(server.port, path, { Origin: server.origin, 'Sec-Fetch-Site': 'same-site', ...proto(server.ctx.token) }),
        403,
        'same-site fetch',
      );
      assertEquals(
        await handshake(server.port, path, { Origin: server.origin, 'X-Studio-Artifact-Key': 'x', ...proto(server.ctx.token) }),
        403,
        'artifact key',
      );
      assertEquals(FakePty.started.length, 0, 'a refused request started a shell');
      assertEquals(await handshake(server.port, path, { Origin: server.origin, ...proto(server.ctx.token) }), 101, 'the page');
      await sleep(100);
      assertEquals(FakePty.started.length, 1);
      // list and end need the page token like every route
      const list = await fetch(`${server.origin}/api/live/terminal/list`, { headers: { 'X-Studio-Token': server.ctx.token } });
      assertEquals((await list.json()).terminals.map((t: { key: string }) => t.key), ['k']);
      const noToken = await fetch(`${server.origin}/api/live/terminal/list`);
      assertEquals(noToken.status, 403);
      await noToken.body?.cancel();
      const endForeign = await fetch(`${server.origin}/api/live/terminal/end`, {
        method: 'POST',
        headers: { 'X-Studio-Token': server.ctx.token, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'k' }),
      });
      assertEquals(endForeign.status, 403);
      await endForeign.body?.cancel();
      const end = await fetch(`${server.origin}/api/live/terminal/end`, {
        method: 'POST',
        headers: { 'X-Studio-Token': server.ctx.token, Origin: server.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'k' }),
      });
      assertEquals(await end.json(), { ok: true, ended: true });
      assert(FakePty.started[0].killed);
    } finally {
      await server.close();
      await Deno.remove(dir, { recursive: true });
    }
  });

  Deno.test(`terminal routes (${impl} listener): a real shell in the chat folder, input, output, end, and close() ends all`, async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: 'aib-term-cwd-' }));
    const server = await startServer(impl);
    let pids: number[] = [];
    try {
      const page = open(server, 'claude:abc', dir);
      await page.waitFor(() => page.messages.some((m) => m.type === 'ready'), 'ready');
      const ready = page.messages.find((m) => m.type === 'ready')!;
      assertEquals([ready.cwd, ready.resumed, ready.key], [dir, false, 'claude:abc']);
      page.ws.send(JSON.stringify({ type: 'input', data: win ? 'echo "hi-$(6*7)"; (Get-Location).Path\r' : 'echo "hi-$((6*7))"; pwd\r' }));
      await page.waitFor(() => page.output.includes('hi-42'), 'echo');
      await page.waitFor(() => page.output.includes(dir.split(/[\\/]/).pop()!), 'cwd');
      page.ws.send(JSON.stringify({ type: 'resize', cols: 61, rows: 20 }));
      await sleep(200);
      page.ws.send(JSON.stringify({ type: 'input', data: win ? '"w=" + $Host.UI.RawUI.WindowSize.Width\r' : 'echo "w=$(tput cols)"\r' }));
      await page.waitFor(() => page.output.includes('w=61'), 'resize');

      // a second chat, then the server closes (AIB quits): every shell ends
      const other = open(server, 'claude:def', dir);
      await other.waitFor(() => other.messages.some((m) => m.type === 'ready'), 'second ready');
      pids = server.ctx.terminals.list().map((t) => t.pid);
      assertEquals(pids.length, 2);
      await server.close();
      await Promise.all([page.closed, other.closed]);
      for (const pid of pids) assert(!alive(pid), `shell ${pid} survived the server closing`);
      assert(page.messages.some((m) => m.type === 'exit'), 'the page was told the shell ended');
    } finally {
      await server.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}
