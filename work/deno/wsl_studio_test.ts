/**
 * WSL chats and terminals end to end against a FakeWslHost (work/deno/_wsl_fake.ts: a real keeper standing in for the distro's Linux
 * keeper, the fake ACP agent, temp folders). Checks design sections 2, 5, 8 and 11 on the Track C side:
 *   - a WSL chat starts in the distro's keeper (never the Windows one) with the distro's env (never AIB's), the helper's agent and
 *     `which`, the Linux folder as the agent's cwd and in session/new, the ref as AIB's key, `loc` in its chat note;
 *   - its AIB tools: the Windows forwarder through interop (/mnt/... path, WSLENV), and the notice in the chat;
 *   - a crashed AIB's next process rebuilds the chat from the distro's keeper (the recovery list names the distro);
 *   - the Windows keeper's wsl-hold channel is never stopped as an orphan;
 *   - a distro that is not ready, an agent the distro lacks: a clear refusal;
 *   - a project terminal in a WSL project: a PTY in the distro's keeper, cwd = the Linux folder, the distro's env, "bash (Ubuntu)".
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, PYTHON, until, pause } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { setWslHostResolver, WSL_TOOLS_LIMITED, WSL_TOOLS_NOTICE } from '../../outputs/agent-studio/server/wsl/access.ts';
import { TerminalSessions } from '../../outputs/agent-studio/server/terminal/sessions.ts';
import type { WsLink } from '../../outputs/agent-studio/server/platform/websocket.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';
const WSL_ROOT = '/tmp/aib-wsl-test-fake';

Deno.env.set('AIB_WSL_ROOT', WSL_ROOT); // the agents' test home is a Linux path inside it (wsl/access.ts wslTestHomeEnv)
Deno.env.set('AIB_WINDOWS_ONLY_SENTINEL', 'never-in-wsl'); // AIB's own env: must never reach a WSL agent or shell

class WslLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-studio-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'app';
  readonly agentLog = this.dir + SEP + 'agent-received.log';
  readonly host: FakeWslHost;
  readonly studios: Studio[] = [];
  readonly made: { command: string[]; cwd: string; options: Json }[] = [];

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    // the agent's log path reaches it only through the distro's env: proof the agent got the host's env
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu', { FAKE_ACP_LOG: this.agentLog });
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (command, cwd, provider, options) => {
      this.made.push({ command, cwd, options: { ...(options ?? {}) } as Json });
      // The distro's agent is a Linux program; under test the fake agent stands in (the guard allows a work/ fixture).
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware', '--breadth'), cwd, provider, { ...options, wsl });
    };
    this.studios.push(studio);
    return studio;
  }

  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    this.host.link.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1);
    this.host.renewLink();
  }

  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    await this.host.stopKeeper();
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

function said(c: Connection): string {
  return c.events.filter((e) => e.kind === 'update').map((e) => {
    const update = (e.data as Json).update as Json;
    return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
  }).join('');
}

/** One turn of the fake agent: it streams, asks a question halfway, and ends after the answer. */
async function turn(studio: Studio, c: Connection): Promise<void> {
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: 'stream:4:20', clientMessageId: 'm1' }))[0], 200);
  await until(() => c.permissions.size === 1, 'the question', 15);
  await studio.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' });
  await until(() => !c.busy, 'turn end', 15);
  assertEquals(said(c), 'chunk0 chunk1 answer=yes chunk2 chunk3 ');
}

const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));

Deno.test({
  name: 'wsl chat: starts in the distro keeper with its env, agent and Linux folder; tools via interop; loc in the chat note',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const studio = lab.studio();
    const c = await studio.connect('claude', 'wsl://Ubuntu/home/u/app');
    assertEquals([c.cwd, c.agentCwd, c.projectRoot], [REF, '/home/u/app', REF]);
    assert(c.keeper === lab.host.link, 'the distro keeper, not the Windows one');
    assert(c.channel !== null);
    // what Studio resolved through the WSL host
    const made = lab.made.at(-1)!;
    assertEquals(made.command, ['node', '/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js']);
    assertEquals((made.options.wsl as Json).program, '/usr/bin/node'); // the helper's which
    assertEquals((made.options.env as Json).CLAUDE_CODE_ENABLE_TODO_TOOLS, '1');
    // what the distro keeper was asked to start
    const spec = lab.host.link.spawned.find((s) => String(s.channel).startsWith('chat-'))!;
    assertEquals(spec.cwd, '/home/u/app');
    const env = spec.env as Record<string, string>;
    assertEquals(env.AIB_FAKE_LINUX_ENV, '1');
    assertEquals(env.HOME, WSL_ROOT + '/home'); // the test home, inside AIB_WSL_ROOT
    assertEquals(env.CLAUDE_CONFIG_DIR, WSL_ROOT + '/home/.claude');
    assertEquals(env.AIB_WINDOWS_ONLY_SENTINEL, undefined); // never Deno.env.toObject()
    assertEquals(env.DENO_SERVE_ADDRESS, undefined);
    // ACP: the Linux folder, and the AIB tools through WSL interop
    const sessionNew = lab.received().find((m) => m.method === 'session/new')!;
    assertEquals((sessionNew.params as Json).cwd, '/home/u/app');
    const servers = (sessionNew.params as Json).mcpServers as Json[];
    if (servers.length) {
      const entry = servers[0];
      assert(String(entry.command).startsWith('/mnt/') && /AIB-keeper(\.exe)?$/i.test(String(entry.command)), String(entry.command));
      assertEquals((entry.args as string[])[0], 'mcp-forward');
      assert((entry.env as Json[]).some((e) => e.name === 'WSLENV' && e.value === 'MCP_FORWARD_HEADERS'));
      assert(notes(c).includes(WSL_TOOLS_LIMITED), notes(c).join(' | '));
    } else {
      assert(notes(c).includes(WSL_TOOLS_NOTICE), 'no entry: the chat says the tools are missing');
    }
    // the chat note says which keeper holds it
    // (read on a connection of its own: attaching and detaching on the chat's would stop the chat's own subscription)
    const reader = await KeeperClient.connect(readKeeperInfo(lab.host.dataDir)!);
    try {
      const note = await lab.host.link.firstNote(reader, `chat-${c.id}`);
      assertEquals(note?.loc, { kind: 'wsl', distro: 'ubuntu', linuxPath: '/home/u/app' });
      assertEquals(note?.cwd, REF);
    } finally {
      reader.close();
    }
    // the page sees the distro
    assertEquals(c.public().wsl, { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/app' });
    // a turn goes through
    await turn(studio, c);
    // the Windows keeper holds nothing of it
    const windows = await studio.keeper!.client(false);
    if (windows) assertEquals((await windows.list()).filter((ch) => ch.channel === `chat-${c.id}`), []);
  },
});

Deno.test({
  name: 'wsl chat: a crashed AIB is replaced and the next one rebuilds the chat from the distro keeper',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    const c = await a.connect('claude', REF);
    await turn(a, c);
    const pid = c.process!.pid;
    lab.crash(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assert(r && !r.closed && r.ready, 'rebuilt under the same id');
    assertEquals(r.rebuildError, '');
    assertEquals(r.process!.pid, pid);
    assertEquals([r.cwd, r.agentCwd], [REF, '/home/u/app']);
    assert(r.keeper === lab.host.link);
    assertEquals(r.wsl?.distro, 'ubuntu');
  },
});

Deno.test({
  name: 'wsl: the Windows keeper\'s wsl-hold channel is never stopped as a chat without a record',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    const hold = a.keeper!.spawn(
      {
        channel: 'wsl-hold-ubuntu',
        command: PYTHON,
        args: ['-c', 'import time; time.sleep(60)'],
        label: JSON.stringify({ aib: 'wsl-hold', distro: 'ubuntu' }),
      },
      { record() {} },
    );
    await hold.ready;
    lab.crash(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 0);
    const client = (await b.keeper!.client(false))!;
    const listed = (await client.list()).find((ch) => ch.channel === 'wsl-hold-ubuntu');
    assert(listed?.live, 'the hold still runs');
    await b.keeper!.stopUnknown(client, 'wsl-hold-ubuntu');
  },
});

Deno.test({
  name: 'wsl chat: a distro that is not ready and an agent the distro lacks are refused with the line the user sees',
  ...T,
  async fn() {
    await using lab = new WslLab();
    const studio = lab.studio();
    lab.host.state = 'starting';
    let message = '';
    await studio.connect('claude', REF).catch((e) => (message = e.message));
    assertEquals(message, 'Starting Ubuntu…');
    lab.host.state = 'ready';
    await studio.connect('codex', REF).catch((e) => (message = e.message));
    assertEquals(message, 'Codex is not installed in Ubuntu');
    await studio.connect('claude', 'wsl://ubuntu/home/u/nowhere').catch((e) => (message = e.message));
    assertEquals(message, 'Choose an existing workspace folder');
    assertEquals(lab.host.link.spawned, []);
  },
});

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
  get messages(): Json[] {
    return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s as string));
  }
  get output(): string {
    return this.sent.filter((s) => typeof s !== 'string').map((b) => new TextDecoder().decode(b as Uint8Array)).join('');
  }
}

Deno.test({
  name: 'wsl terminal: the login shell runs in the distro keeper in the Linux folder with the distro env, titled "bash (Ubuntu)"',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const script = 'import os,sys,time\nprint("CWD=" + os.getcwd())\nprint("LINUX=" + os.environ.get("AIB_FAKE_LINUX_ENV", ""))\n' +
      'print("WIN=" + os.environ.get("AIB_WINDOWS_ONLY_SENTINEL", "-"))\nsys.stdout.flush()\ntime.sleep(30)\n';
    lab.host.link.programs.set('/bin/bash', { command: PYTHON, args: ['-u', '-c', script] });
    const sessions = new TerminalSessions({ keeper: null, spawn: () => { throw new Error('never a child of AIB'); } });
    const link = new FakeLink();
    assertEquals(sessions.attach(link, 'claude:wsl1', REF, 90, 20), null); // answered once the distro has
    await until(() => link.messages.some((m) => m.type === 'ready'), 'ready', 15);
    const ready = link.messages.find((m) => m.type === 'ready')!;
    assertEquals([ready.shellName, ready.cwd], ['bash (Ubuntu)', REF]);
    const spec = lab.host.link.spawned.find((s) => String(s.channel).startsWith('pty-'))!;
    assertEquals([spec.command, spec.args, spec.cwd], ['/bin/bash', ['-l'], '/home/u/app']);
    assertEquals(spec.windowsCommandLine, undefined);
    await until(() => link.output.includes('WIN='), 'the shell output', 15);
    assert(link.output.includes('CWD=' + lab.work), link.output);
    assert(link.output.includes('LINUX=1'));
    assert(link.output.includes('WIN=-'), 'AIB\'s own env never reaches a distro shell');
    assertEquals(sessions.list().map((t) => t.shellName), ['bash (Ubuntu)']);
    // not ready: refused with the state line
    lab.host.state = 'stopped';
    const refused = new FakeLink();
    sessions.attach(refused, 'claude:wsl2', REF, 80, 24);
    await until(() => refused.closed, 'refused', 5);
    assertEquals([refused.messages[0].code, refused.messages[0].message], ['wsl_unavailable', 'Ubuntu stopped. Reconnect']);
    lab.host.state = 'ready';
    await sessions.endAll();
  },
});
