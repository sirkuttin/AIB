/**
 * Chat terminals in the keeper (keeper phase 3): a shell started through the keeper outlives the AIB that started it. A "crashed" AIB
 * (its keeper connection dropped, nothing closed) is replaced by a new TerminalSessions that takes the shell over: same process, its
 * recent output replayed to the page, PromptWatch busy again for the command that still runs, typing goes on; ending it removes the
 * keeper's channel. With a keeper too old for terminals (the released keeper 1.1.0 of beta.4, built from git) the shell runs inside
 * AIB as before and the reason is kept. Real keeper and cmd.exe on ConPTY (Windows; headless, no window), temp folders.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { TerminalSessions } from '../../outputs/agent-studio/server/terminal/sessions.ts';
import { KeeperPty, TERMINAL_PREFIX } from '../../outputs/agent-studio/server/terminal/keeper_pty.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, keeperSourceDir, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import type { WsLink } from '../../outputs/agent-studio/server/platform/websocket.ts';

const WIN = Deno.build.os === 'windows';
const T = { sanitizeResources: false, sanitizeOps: false, ignore: !WIN };
const SEP = WIN ? '\\' : '/';
const CMD = { file: `${Deno.env.get('SystemRoot') || 'C:\\Windows'}\\System32\\cmd.exe`, args: [] as string[] };
const EXTRA = ['--exit-after', '2s', '--orphan-after', '60s'];
// deno-lint-ignore no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

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
  get messages(): Record<string, unknown>[] {
    return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s as string));
  }
  get output(): string {
    return strip(this.sent.filter((s) => typeof s !== 'string').map((b) => new TextDecoder().decode(b as Uint8Array)).join(''));
  }
  type(data: string) {
    this.onmessage!(JSON.stringify({ type: 'input', data }));
  }
  busy(): boolean {
    this.onmessage!(JSON.stringify({ type: 'busy?', id: 1 }));
    return !!this.messages.filter((m) => m.type === 'busy').at(-1)!.busy;
  }
}

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-keeper-term-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly all: TerminalSessions[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }
  sessions(binary?: string): TerminalSessions {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: EXTRA, ...(binary ? { binary } : {}) });
    const s = new TerminalSessions({ keeper, shell: () => CMD });
    this.all.push(s);
    return s;
  }
  /** What a crashed AIB leaves: its keeper connection gone, the shell untouched. */
  crash(s: TerminalSessions): void {
    s.keeper!.disconnect();
    this.all.splice(this.all.indexOf(s), 1);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.all) await s.endAll().catch(() => {});
    const info = readKeeperInfo(this.state);
    if (info && pidAlive(info.pid)) {
      try {
        const client = await KeeperClient.connect(info);
        await client.shutdown(true).catch(() => {});
        client.close();
      } catch { /* gone */ }
      await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
    }
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

async function keeperChannels(state: string) {
  const client = await KeeperClient.connect(readKeeperInfo(state)!, 'test');
  try {
    return (await client.list()).filter((c) => c.channel.startsWith(TERMINAL_PREFIX));
  } finally {
    client.close();
  }
}

Deno.test({
  name:
    'keeper terminal: a shell outlives a crashed AIB; the next one takes it over (same pid, output replayed, PromptWatch busy), typing goes on',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.sessions();
    const page1 = new FakeLink();
    a.attach(page1, 'claude:k9', lab.work, 100, 30);
    await until(() => page1.messages.some((m) => m.type === 'ready'), 'ready', 20);
    const ready1 = page1.messages.find((m) => m.type === 'ready')!;
    const session = a.get('claude:k9')!;
    assert(session.pty instanceof KeeperPty && session.pty.inKeeper, 'the shell runs in the keeper');
    const [channel] = await keeperChannels(lab.state);
    assertEquals([channel.kind, channel.live, channel.pid], ['pty', true, ready1.pid]);
    await until(() => page1.output.includes('>'), 'the prompt', 20);
    page1.type('echo before-1\r');
    await until(() => page1.output.includes('before-1\r\n') || /before-1\s*\n/.test(page1.output), 'echo', 20);
    await until(() => !page1.busy(), 'back at the prompt', 10);
    page1.type('ping -n 60 127.0.0.1 >nul\r');
    await pause(800);
    assert(page1.busy(), 'a command runs (PromptWatch)');

    lab.crash(a); // AIB dies; the keeper keeps the shell, and the ping in it
    await pause(500);
    assert(pidAlive(Number(ready1.pid)), 'the shell still runs');

    const b = lab.sessions();
    assertEquals(await b.adoptKeeper(), 1);
    assertEquals(b.list().map((t) => [t.key, t.pid, t.cwd]), [['claude:k9', ready1.pid, lab.work]]);
    const page2 = new FakeLink();
    b.attach(page2, 'claude:k9', 'ignored', 100, 30, '', true);
    await until(() => page2.messages.some((m) => m.type === 'ready'), 'ready after the restart', 20);
    const ready2 = page2.messages.find((m) => m.type === 'ready')!;
    assertEquals([ready2.resumed, ready2.pid, ready2.id, ready2.startedAt], [true, ready1.pid, ready1.id, ready1.startedAt]);
    assert(page2.output.includes('before-1'), 'the earlier output is replayed');
    assert(page2.output.includes('ping -n 60'), 'with the command still on screen');
    assert(page2.busy(), 'PromptWatch knows the ping still runs');
    assertEquals(b.busyCount(), 1);

    page2.type('\x03'); // Ctrl+C ends the ping; the prompt comes back
    await until(() => !page2.busy(), 'prompt after Ctrl+C', 15);
    page2.type('echo after-2\r');
    await until(() => page2.output.includes('after-2'), 'typing works after the takeover', 15);
    assertEquals(page2.messages.filter((m) => m.type === 'exit'), [], '"Session ended" only when the shell ends');

    // A resume request for a chat without a shell starts nothing.
    const page3 = new FakeLink();
    b.attach(page3, 'claude:none', lab.work, 80, 24, '', true);
    assertEquals(page3.messages.map((m) => m.code), ['gone']);
    assertEquals(b.get('claude:none'), undefined);

    // Ending it ends the shell and removes its channel from the keeper.
    assert(await b.end('claude:k9'));
    await until(() => !pidAlive(Number(ready1.pid)), 'shell gone', 10);
    await until(async () => (await keeperChannels(lab.state)).length === 0, 'channel removed', 10);
  },
});

Deno.test({
  name: 'keeper terminal: the shell exiting by itself shows the exit to the page; an update (releaseAll) leaves the shell in the keeper',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.sessions();
    const page = new FakeLink();
    a.attach(page, 'claude:exit', lab.work, 80, 24);
    await until(() => page.output.includes('>'), 'the prompt', 20);
    page.type('exit 5\r');
    await until(() => page.messages.some((m) => m.type === 'exit'), 'exit', 15);
    assertEquals(page.messages.find((m) => m.type === 'exit')!.code, 5);
    assertEquals(a.get('claude:exit'), undefined);

    const kept = new FakeLink();
    a.attach(kept, 'claude:kept', lab.work, 80, 24);
    await until(() => kept.messages.some((m) => m.type === 'ready'), 'ready', 20);
    const pid = Number(kept.messages.find((m) => m.type === 'ready')!.pid);
    assertEquals(await a.releaseAll(), 1);
    assert(kept.closed, 'the page is told AIB is restarting (it reconnects)');
    assertEquals(kept.messages.filter((m) => m.type === 'exit'), []);
    lab.all.splice(lab.all.indexOf(a), 1);
    const b = lab.sessions();
    assertEquals(await b.adoptKeeper(), 1);
    assertEquals(b.list()[0].pid, pid);
    assert(pidAlive(pid));
  },
});

/** The keeper of beta.4 (1.1.0, no `scrollback`/`labels`), built from git (commit 40b738e). */
async function releasedKeeper(dir: string): Promise<string> {
  const root = keeperSourceDir()! + SEP + '..';
  const src = dir + SEP + 'old-src';
  const git = async (...args: string[]) => {
    const out = await new Deno.Command('git', { args, cwd: root, stdout: 'piped', stderr: 'piped' }).output();
    if (!out.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
    return out.stdout;
  };
  const files = new TextDecoder().decode(await git('ls-tree', '-r', '--name-only', '40b738e', 'keeper')).split(/\r?\n/).filter(Boolean);
  for (const file of files) {
    const target = src + SEP + file.replaceAll('/', SEP);
    Deno.mkdirSync(target.slice(0, target.lastIndexOf(SEP)), { recursive: true });
    Deno.writeFileSync(target, await git('show', `40b738e:${file}`));
  }
  const go = Deno.env.get('GO') || (WIN ? 'C:/Program Files/Go/bin/go.exe' : 'go');
  const exe = `${dir}${SEP}AIB-keeper-1.1.0${WIN ? '.exe' : ''}`;
  const out = await new Deno.Command(go, {
    args: ['build', '-trimpath', '-ldflags', `-s -w${WIN ? ' -H windowsgui' : ''}`, '-o', exe, '.'],
    cwd: src + SEP + 'keeper',
    env: { CGO_ENABLED: '0' },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return exe;
}

Deno.test({
  name: 'keeper terminal: with an older keeper (1.1.0, no scrollback/labels) the shell runs inside AIB as before, and the reason is kept',
  ...T,
  async fn() {
    await using lab = new Lab();
    const old = await releasedKeeper(lab.dir);
    // The old keeper holds a chat, so it is not replaced: terminals must fall back.
    const chats = new KeeperLink({ dataDir: lab.state, orphan: null, binary: old, extraArgs: EXTRA });
    const held = chats.spawn(
      { channel: 'chat-x', command: Deno.execPath(), args: ['eval', 'setTimeout(() => {}, 60000)'], cwd: lab.work },
      {},
    );
    await held.ready;
    const s = lab.sessions(old);
    assertEquals(await s.adoptKeeper(), 0);
    const page = new FakeLink();
    s.attach(page, 'claude:old', lab.work, 80, 24);
    await until(() => page.messages.some((m) => m.type === 'ready'), 'ready', 20);
    const pty = s.get('claude:old')!.pty as KeeperPty;
    assert(!pty.inKeeper, 'the shell runs inside AIB');
    assert(s.keeperProblem.includes('lacks scrollback, labels'), s.keeperProblem);
    page.type('echo inside-aib\r');
    await until(() => page.output.includes('inside-aib'), 'it works', 15);
    const client = await KeeperClient.connect(readKeeperInfo(lab.state)!, 'test');
    assertEquals((await client.list()).map((c) => c.channel), ['chat-x'], 'nothing of the terminal in the keeper');
    await client.kill('chat-x', await client.claim('chat-x'));
    client.close();
    chats.disconnect();
    // The next shell goes straight inside AIB (no second try at the keeper).
    const second = new FakeLink();
    s.attach(second, 'claude:old2', lab.work, 80, 24);
    assert(!(s.get('claude:old2')!.pty instanceof KeeperPty), 'decided once');
    await until(() => second.messages.some((m) => m.type === 'ready'), 'ready', 20);
  },
});
