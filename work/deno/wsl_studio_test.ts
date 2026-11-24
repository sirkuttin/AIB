/**
 * WSL chats and terminals end to end against a FakeWslHost (work/deno/_wsl_fake.ts: a real keeper standing in for the distro's Linux
 * keeper, the fake ACP agent, temp folders). Checks design sections 2, 5, 8 and 11 on the Track C side:
 *   - a WSL chat starts in the distro's keeper (never the Windows one) with the distro's env (never AIB's), the helper's agent and
 *     `which`, the Linux folder as the agent's cwd and in session/new, the ref as AIB's key, `loc` in its chat note;
 *   - its AIB tools: the Windows forwarder through interop (/mnt/... path, WSLENV), and the notice in the chat; with the helper's
 *     tunnel, the Linux keeper's forwarder on the helper socket, and a tool call through the tunnel answered (a wrong key refused);
 *   - a crashed AIB's next process rebuilds the chat from the distro's keeper (the recovery list names the distro);
 *   - the Windows keeper's wsl-hold channel is never stopped as an orphan;
 *   - a distro that is not ready, an agent the distro lacks: a clear refusal;
 *   - a project terminal in a WSL project: a PTY in the distro's keeper, cwd = the Linux folder, the distro's env, "bash (Ubuntu)".
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, NODE, until, pause } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import { setWslHostResolver, WSL_TOOLS_NOTICE } from '../../app/server/wsl/access.ts';
import { mcpTunnelGate } from '../../app/server/wsl/mcp_tunnel.ts';
import { TerminalSessions } from '../../app/server/terminal/sessions.ts';
import type { WsLink } from '../../app/server/platform/websocket.ts';
import { terminalRoutes } from '../../app/server/web/terminal_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';
import { INBOX } from '../../app/server/attention/inbox_rules.ts';

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
  readonly aibs: Aib[] = [];
  readonly made: { command: string[]; cwd: string; options: Json }[] = [];

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    // the agent's log path reaches it only through the distro's env: proof the agent got the host's env
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu', { FAKE_ACP_LOG: this.agentLog });
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  aib(flags: string[] = []): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ claudeLauncher: import.meta.filename!, codexLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (command, cwd, provider, options) => {
      this.made.push({ command, cwd, options: { ...(options ?? {}) } as Json });
      // The distro's agent is a Linux program; under test the fake agent stands in (the guard allows a work/ fixture).
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware', '--breadth', ...flags), cwd, provider, { ...options, wsl });
    };
    this.aibs.push(aib);
    return aib;
  }

  crash(aib: Aib): void {
    aib.keeper!.disconnect();
    this.host.link.disconnect();
    for (const c of aib.connections.values()) c.sessionLease?.release();
    aib.reconnectStop.set();
    this.aibs.splice(this.aibs.indexOf(aib), 1);
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
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
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
async function turn(aib: Aib, c: Connection): Promise<void> {
  assertEquals((await aib.liveCall('prompt', { id: c.id, text: 'stream:4:20', clientMessageId: 'm1' }))[0], 200);
  await until(() => c.permissions.size === 1, 'the question', 15);
  await aib.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' });
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
    const aib = lab.aib();
    const c = await aib.connect('claude', 'wsl://Ubuntu/home/u/app');
    assertEquals([c.cwd, c.agentCwd, c.projectRoot], [REF, '/home/u/app', REF]);
    assert(c.keeper === lab.host.link, 'the distro keeper, not the Windows one');
    assert(c.channel !== null);
    // what AIB resolved through the WSL host
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
    // no Windows scratch folder for an agent in a distro (Claude refused it: "additionalDirectories entries must be absolute paths")
    assert(aib.allow !== null, 'the allow gate is on (it gives Windows chats their scratch folder)');
    assertEquals(c.scratchDir, null);
    assert(!JSON.stringify(sessionNew.params).includes(JSON.stringify(aib.allow!.scratchFor(c.id)).slice(1, -1)),'the scratch folder is not sent');
    const servers = (sessionNew.params as Json).mcpServers as Json[];
    if (servers.length) {
      const entry = servers[0];
      assert(String(entry.command).startsWith('/mnt/') && /AIB-keeper(\.exe)?$/i.test(String(entry.command)), String(entry.command));
      assertEquals((entry.args as string[])[0], 'mcp-forward');
      assert((entry.env as Json[]).some((e) => e.name === 'WSLENV' && e.value === 'MCP_FORWARD_HEADERS'));
      assert(!notes(c).some((n) => n.startsWith('In WSL projects, AIB tools')), 'no tools note when the tools work: ' + notes(c).join(' | '));
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
    await turn(aib, c);
    // the Windows keeper holds nothing of it
    const windows = await aib.keeper!.client(false);
    if (windows) assertEquals((await windows.list()).filter((ch) => ch.channel === `chat-${c.id}`), []);
  },
});

Deno.test({
  name: 'wsl chat: with the helper\'s tunnel the entry is the Linux forwarder on its socket; a tool call through it is answered',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    lab.host.mcpTunnel = { forwarder: '/tmp/aib-wsl-test-fake/1.0.0-abcdef12/AIB-keeper', socket: '/tmp/aib-wsl-test-fake/data-x/helper/mcp.sock' };
    const aib = lab.aib();
    const c = await aib.connect('claude', REF);
    const sessionNew = lab.received().find((m) => m.method === 'session/new')!;
    const servers = (sessionNew.params as Json).mcpServers as Json[];
    assertEquals(servers.length, 1);
    const entry = servers[0];
    assertEquals(entry.command, lab.host.mcpTunnel.forwarder);
    assertEquals(entry.args, ['mcp-forward', '--helper-socket', lab.host.mcpTunnel.socket]);
    const env = entry.env as { name: string; value: string }[];
    assert(!env.some((e) => e.name === 'WSLENV'), 'nothing crosses WSL interop');
    const headers = JSON.parse(env.find((e) => e.name === 'MCP_FORWARD_HEADERS')!.value) as Record<string, string>;
    assertEquals(headers['X-Studio-Conversation-Id'], c.id);
    assert(!notes(c).some((n) => n.startsWith('In WSL projects, AIB tools')), 'no tools note when the tools work: ' + notes(c).join(' | '));
    assert(c.ownArtifactTool({ toolCall: { name: 'mcp__studio_artifact__publish' } }), "the tunnel entry is AIB's own tool (its calls need no permission)");

    // The helper hands a tool call over (mcp.request): AIB accepts it, answers it through its endpoint's checks, and replies.
    const replies: Json[] = [];
    lab.host.handlers['mcp.accept'] = () => ({ ok: true });
    lab.host.handlers['mcp.reply'] = (p) => (replies.push(p), { ok: true });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    lab.host.mcpRequest({ rid: 'r1', headers, body });
    await until(() => replies.length === 1, 'the reply', 10);
    assertEquals([replies[0].rid, replies[0].status], ['r1', 200]);
    const names = ((JSON.parse(String(replies[0].body)).result as Json).tools as Json[]).map((t) => t.name);
    assert(names.includes('publish') && names.includes('artifacts') && names.includes('doc') && !names.includes('start_helper') && !names.includes('doc_create'), names.join());

    // A wrong key, or the key of a chat in another distro, is refused (401), and no tool runs.
    lab.host.mcpRequest({ rid: 'r2', headers: { ...headers, 'X-Studio-Artifact-Key': 'wrong' }, body });
    await until(() => replies.length === 2, 'the refusal', 10);
    assertEquals([replies[1].rid, replies[1].status], ['r2', 401]);
    assert(String(replies[1].body).includes('refused the artifact key'));
    const other = await aib.wslToolCall({ distro: 'Debian', key: headers['X-Studio-Artifact-Key'], conversation: c.id, body });
    assertEquals(other.status, 401);

    // A request the helper already gave up on (accept says no) never runs.
    lab.host.handlers['mcp.accept'] = () => ({ ok: false });
    lab.host.mcpRequest({ rid: 'r3', headers, body });
    await pause(300);
    assertEquals(replies.length, 2);

    // A closed AIB answers 503 with a message (the forwarder says "AIB is closed" at once).
    lab.host.handlers['mcp.accept'] = () => ({ ok: true });
    await aib.close();
    lab.aibs.splice(lab.aibs.indexOf(aib), 1);
    const closed = await aib.wslToolCall({ distro: 'Ubuntu', key: headers['X-Studio-Artifact-Key'], conversation: c.id, body });
    assertEquals(closed.status, 503);
    assert(String(closed.error).includes('AIB is closed'));
    void mcpTunnelGate;
  },
});

Deno.test({
  name: 'wsl chat: a crashed AIB is replaced and the next one rebuilds the chat from the distro keeper',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const c = await a.connect('claude', REF);
    await turn(a, c);
    const pid = c.process!.pid;
    lab.crash(a);
    const b = lab.aib();
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
    const a = lab.aib();
    const hold = a.keeper!.spawn(
      {
        channel: 'wsl-hold-ubuntu',
        command: NODE,
        args: ['-e', 'setTimeout(()=>{},60000)'],
        label: JSON.stringify({ aib: 'wsl-hold', distro: 'ubuntu' }),
      },
      { record() {} },
    );
    await hold.ready;
    lab.crash(a);
    const b = lab.aib();
    assertEquals(await b.adoptKeeper(), 0);
    const client = (await b.keeper!.client(false))!;
    const listed = (await client.list()).find((ch) => ch.channel === 'wsl-hold-ubuntu');
    assert(listed?.live, 'the hold still runs');
    await b.keeper!.stopUnknown(client, 'wsl-hold-ubuntu');
  },
});

/** A keep-alive in the Windows keeper as wsl/hosts.ts makes it (a sleeping stand-in for `wsl.exe ... bridge --hold`). */
async function holdFor(aib: Aib): Promise<void> {
  const hold = aib.keeper!.spawn(
    {
      channel: 'wsl-hold-ubuntu',
      command: NODE,
      args: ['-e', 'setTimeout(()=>{},60000)'],
      label: JSON.stringify({ aib: 'wsl-hold', distro: 'ubuntu' }),
    },
    { record() {} },
  );
  await hold.ready;
}

async function stopHold(aib: Aib): Promise<void> {
  const client = await aib.keeper!.client(false);
  if (client) await aib.keeper!.stopUnknown(client, 'wsl-hold-ubuntu').catch(() => {});
}

const chatChannels = (lab: WslLab) => lab.host.link.spawned.filter((s) => String(s.channel).startsWith('chat-')).length;

Deno.test({
  name: 'wsl chat: the recovery list lost it (an AIB without WSL forgot it), the keep-alive still runs: the next AIB takes it over',
  ...T,
  async fn() {
    // The owner's case: a build without WSL support gave up on the WSL chats (three tries, dropped from the recovery list), so the
    // next AIB never asked the distro's keeper and the chats stayed Ready while their agents ran on.
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const c = await a.connect('claude', REF);
    await holdFor(a);
    const pid = c.process!.pid;
    lab.crash(a);
    const b = lab.aib();
    assert(b.store!.forgetConversation('claude', c.sessionId!), 'it was on the list');
    try {
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      assert(r && !r.closed && r.ready, 'rebuilt under the same id');
      assertEquals(r.process!.pid, pid);
      assert(r.keeper === lab.host.link);
    } finally {
      await stopHold(b);
    }
  },
});

Deno.test({
  name: 'wsl chat: a Continue of a chat whose agent still runs in the distro keeper takes that agent over (never a second agent)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const c = await a.connect('claude', REF);
    const pid = c.process!.pid;
    lab.crash(a);
    const spawned = chatChannels(lab);
    // the next AIB does not know the chat (not on its recovery list, no keep-alive): its take-over at start never asks the distro
    const b = lab.aib();
    b.store!.forgetConversation('claude', c.sessionId!);
    assertEquals(await b.adoptKeeper(), 0);
    const opened = await b.connect('claude', REF, c.sessionId);
    assertEquals(opened.id, c.id, 'the running chat, taken over');
    assertEquals(opened.process!.pid, pid);
    assertEquals(chatChannels(lab), spawned, 'no second agent was started');
    assertEquals([...b.connections.values()].filter((x) => !x.closed && x.sessionId === c.sessionId).length, 1);
  },
});

Deno.test({
  name: 'wsl chat: the take-over at start found the distro not ready; the auto-reconnect then takes the running agent over',
  ...T,
  async fn() {
    // The wsl8 case: "ubuntu is not ready, so its chats were not taken over: the running helper was too old to take over", then the
    // auto-reconnect started a second agent for every chat (claude: duplicates; codex: "session is in use by another Codex client").
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const c = await a.connect('claude', REF);
    const pid = c.process!.pid;
    lab.crash(a);
    const spawned = chatChannels(lab);
    const b = lab.aib();
    lab.host.state = 'unavailable';
    lab.host.note = 'the running helper was too old to take over';
    assertEquals(await b.adoptKeeper(), 0);
    lab.host.state = 'ready';
    lab.host.note = '';
    assertEquals(b.startAutoReconnect(1, 0, 1, 0), 1);
    await until(() => b.reconnectPending.size === 0, 'the reconnect', 20);
    const r = b.connections.get(c.id);
    assert(r && !r.closed && r.ready, 'the running chat, taken over');
    assertEquals(r.process!.pid, pid);
    assertEquals(chatChannels(lab), spawned, 'no second agent was started');
    assertEquals(b.reconnectFailed(), []);
  },
});

Deno.test({
  name: 'wsl chat: a distro that is not ready and an agent the distro lacks are refused with the line the user sees',
  ...T,
  async fn() {
    await using lab = new WslLab();
    const aib = lab.aib();
    lab.host.state = 'starting';
    let message = '';
    await aib.connect('claude', REF).catch((e) => (message = e.message));
    assertEquals(message, 'Starting Ubuntu…');
    lab.host.state = 'ready';
    await aib.connect('codex', REF).catch((e) => (message = e.message));
    assertEquals(message, 'Codex is not installed in Ubuntu');
    await aib.connect('claude', 'wsl://ubuntu/home/u/nowhere').catch((e) => (message = e.message));
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
    const script = 'console.log("CWD=" + process.cwd());console.log("LINUX=" + (process.env.AIB_FAKE_LINUX_ENV ?? ""));\n' +
      'console.log("WIN=" + (process.env.AIB_WINDOWS_ONLY_SENTINEL ?? "-"));setTimeout(() => {}, 30000);\n';
    lab.host.link.programs.set('/bin/bash', { command: NODE, args: ['-e', script] });
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

Deno.test({
  name: 'wsl terminal end: POST /api/live/terminal/end takes the Node.js and sign-in keys and ends their PTY in the distro keeper',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    lab.host.link.programs.set('/bin/sh', { command: NODE, args: ['-e', 'console.log("RUNNING");setTimeout(() => {}, 60000);\n'] });
    const sessions = new TerminalSessions({ keeper: null, spawn: () => { throw new Error('never a child of AIB'); } });
    const end = terminalRoutes().get('POST /api/live/terminal/end')!;
    const ctx = { terminals: sessions } as unknown as WebContext;
    const livePtys = async () => {
      const client = await KeeperClient.connect(readKeeperInfo(lab.host.dataDir)!);
      try {
        return (await client.list()).filter((ch) => ch.live && ch.channel.startsWith('pty-')).length;
      } finally {
        client.close();
      }
    };
    for (const key of ['setup:wsl-node@ubuntu', 'signin:claude@ubuntu']) {
      const link = new FakeLink();
      await sessions.attachWsl(link, key, 'wsl://ubuntu/home/u', 80, 24, { file: '/bin/sh', args: ['-c', 'the steps'] });
      await until(() => link.output.includes('RUNNING'), `${key} runs`, 15);
      assertEquals(await livePtys(), 1, key);
      const [status, body] = await end(ctx, new URL('http://x/api/live/terminal/end'), { key });
      assertEquals([status, body], [200, { ok: true, ended: true }], key);
      await until(async () => (await livePtys()) === 0, `${key}: the program in the distro ended`, 10);
      assertEquals(sessions.list().length, 0);
      const [, again] = await end(ctx, new URL('http://x/api/live/terminal/end'), { key });
      assertEquals(again, { ok: true, ended: false }, 'a second end finds nothing');
    }
    await sessions.endAll();
  },
});

// ---- one agent per session (keeper take-over, auto-reconnect), and no Windows folder for a distro's agent ---------------------

/** The live chat channels of the distro's (fake) Linux keeper, by channel name. */
async function liveChats(lab: WslLab): Promise<string[]> {
  const client = await KeeperClient.connect(readKeeperInfo(lab.host.dataDir)!);
  try {
    return (await client.list()).filter((ch) => ch.live && ch.channel.startsWith('chat-')).map((ch) => ch.channel).sort();
  } finally {
    client.close();
  }
}

const openFor = (aib: Aib, sessionId: string) => [...aib.connections.values()].filter((c) => !c.closed && c.sessionId === sessionId);

Deno.test({
  name: 'wsl keeper take-over: a session that runs twice in the distro keeper becomes one chat; the busy agent is kept, the idle one stopped',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const first = await a.connect('claude', REF);
    const session = first.sessionId!;
    // An OLDER AIB build that could not see the running agent started a second one for the same session. This build's connect()
    // refuses to (it takes the running agent over), so the second channel is made the way that build did: a Connection started
    // straight in the distro keeper with the first one's launch options, loading the same session.
    const made = lab.made[0];
    const second = a.connectionFactory(made.command, made.cwd, 'claude', made.options as never);
    await second.setup(session);
    assertEquals(second.sessionId, session);
    assert(second.id !== first.id, 'a second agent');
    assertEquals((await liveChats(lab)).length, 2);
    // the second one is working (a question waits) when that AIB goes away too
    assertEquals((await second.prompt('stream:4:20', 'm1', [])).duplicate, false);
    await until(() => second.permissions.size === 1, 'the question', 15);
    lab.crash(a);
    const c = lab.aib();
    await c.adoptKeeper();
    const open = openFor(c, session);
    assertEquals(open.map((o) => o.id), [second.id]); // listed once: the working one
    assert(open[0].busy && open[0].permissions.size === 1, 'its turn and question go on');
    await until(async () => (await liveChats(lab)).length === 1, 'the idle duplicate stopped', 10);
    assertEquals(await liveChats(lab), [`chat-${second.id}`]);
  },
});

Deno.test({
  name: 'wsl auto-reconnect: when the take-over at start failed (the distro was not ready), the reconnect takes the running agent over',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const c = await a.connect('claude', REF);
    await turn(a, c);
    const [session, pid] = [c.sessionId!, c.process!.pid];
    lab.crash(a);
    // The next AIB starts while the distro is slow: its take-over gives up and the chat stays on the recovery list.
    const b = lab.aib();
    lab.host.state = 'starting';
    assertEquals(await b.adoptKeeper(), 0);
    assertEquals(openFor(b, session), []);
    // The distro answers, and the auto-reconnect reopens the chat: the agent that still runs there is taken over, none is started.
    lab.host.state = 'ready';
    const spawnsBefore = lab.host.link.spawned.filter((s) => String(s.channel).startsWith('chat-')).length;
    assertEquals(b.startAutoReconnect(1, 0, 1, 0), 1);
    await Promise.all(b.reconnectWorkers);
    const open = openFor(b, session);
    assertEquals(open.length, 1);
    assertEquals([open[0].id, open[0].process!.pid], [c.id, pid]); // the same chat and the same agent
    assertEquals(lab.host.link.spawned.filter((s) => String(s.channel).startsWith('chat-')).length, spawnsBefore);
    assertEquals(await liveChats(lab), [`chat-${c.id}`]);
    // and it goes on live
    assertEquals((await b.liveCall('prompt', { id: c.id, text: 'stream:2:20', clientMessageId: 'm2' }))[0], 200);
    await until(() => open[0].permissions.size === 1, 'the question', 15);
    await b.liveCall('permission', { id: c.id, key: [...open[0].permissions.keys()][0], option: 'yes' });
    await until(() => !open[0].busy, 'turn end', 15);
  },
});

Deno.test({
  name: 'wsl: the link to the distro keeper is given up while its agent keeps running: the chat comes back on that agent, not a second one',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const aib = lab.aib();
    const c = await aib.connect('claude', REF);
    const [session, pid] = [c.sessionId!, c.process!.pid];
    // the keeper connection ends (the bridge broke and was not restored in time), the Linux keeper and the agent go on
    (await lab.host.link.client(false))!.close();
    await until(() => c.closed, 'the chat interrupted', 10);
    await until(() => openFor(aib, session).some((o) => o.ready), 'the chat back', 30);
    const open = openFor(aib, session);
    assertEquals([open.length, open[0].id, open[0].process!.pid], [1, c.id, pid]);
    assertEquals(await liveChats(lab), [`chat-${c.id}`]);
    assertEquals(lab.received().filter((m) => m.method === 'session/load').length, 0);
  },
});

Deno.test({
  name: 'wsl chat with allow rules: no Windows scratch folder, so session/new has no Windows additionalDirectories and the brief no Windows path',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const aib = lab.aib(['--extra-dirs']); // the agent takes additionalDirectories and a system prompt (as Claude's adapter does)
    assert(aib.allow, 'allow rules are on');
    const c = await aib.connect('claude', REF);
    assertEquals(c.scratchDir, null);
    assertEquals(c.extraFolders(), {});
    const sessionNew = lab.received().find((m) => m.method === 'session/new')!;
    const params = sessionNew.params as Json;
    assertEquals(params.additionalDirectories, undefined);
    const { mcpServers: _tools, ...rest } = params; // (the tools entry may name AIB's Windows forwarder: that is interop's business)
    const text = JSON.stringify(rest);
    assert(!text.includes(JSON.stringify(lab.state).slice(1, -1)) && !text.includes('scratch'), text.slice(0, 400));
    // a Windows chat of the same AIB still gets its scratch folder
    const win = await aib.connect('codex', lab.work);
    assert(win.scratchDir && win.scratchDir.startsWith(lab.state), String(win.scratchDir));
  },
});

Deno.test({
  name: 'start: Windows chats are taken over without waiting for a slow distro; its chat says Reconnecting… and requests answer at once',
  ...T,
  async fn() {
    // The owner's start (test build 24): the distro's take-over waited ~9 s for the Linux programs' install, and the Windows chats and
    // the window waited with it. Now the distro's part runs after the Windows keeper's, in the background (main.ts opens the window).
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const w = await a.connect('codex', lab.work);
    const c = await a.connect('claude', REF);
    assert(w.channel && c.channel && w.keeper !== lab.host.link, 'one chat in each keeper');
    lab.crash(a);
    // The distro is slow to start (a boot, an install of the Linux programs): its helper is ready only when the test says so.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    lab.host.state = 'starting';
    lab.host.start = async () => {
      await gate;
      lab.host.state = 'ready';
    };
    const b = lab.aib();
    let allDone = false;
    const all = b.adoptKeeper().then((n) => {
      allDone = true;
      return n;
    });
    assertEquals(await b.adoptKeeperWindows(), 1, 'the Windows chat');
    assert(b.connections.get(w.id)?.ready, 'the Windows chat is live');
    await pause(300);
    assert(!allDone, 'the distro is still on its way');
    // Meanwhile: the Windows chat answers at once, the WSL chat is Reconnecting… (never Not running), the list answers.
    let t0 = performance.now();
    const state = await b.liveState(w.id) as Json | null;
    assert(state && performance.now() - t0 < 1000, `liveState took ${Math.round(performance.now() - t0)} ms`);
    t0 = performance.now();
    await b.liveList();
    assert(performance.now() - t0 < 1000, 'liveList answers');
    const waiting = b.recovered().find((r) => (r as Json).sessionId === c.sessionId) as Json | undefined;
    assertEquals(waiting?.reconnecting, true, JSON.stringify(waiting));
    assert(b.takingOver(), 'the state route answers taking_over (quiet on the page), never connection_not_found');
    release();
    assertEquals(await all, 2, 'the WSL chat once its distro is ready');
    assert(!b.takingOver());
    assert(b.connections.get(c.id)?.ready, 'the WSL chat is live');
    assertEquals(b.recovered().find((r) => (r as Json).sessionId === c.sessionId), undefined);
  },
});

/** A reply that ends asking the user something (inbox-rules.js asksOf: a blocking question after a real answer). */
const ASKS = 'say:I went through the branch, ran the targeted tests and read the logs. The build passes, the two flaky tests are ' +
  'fixed, and the notes are updated in the docs folder.\n\nShould I fix the first one?';

Deno.test({
  name: 'wsl chat: Mark handled clears a reply that asks something, live and after the chat is rebuilt from the distro keeper',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.aib();
    const c = await a.connect('claude', REF);
    const phase = (s: Aib, conn: Connection) =>
      INBOX.phaseOf(conn.attention(), s.conversations.public().entries[`claude:${conn.sessionId}`] ?? null, Date.now() / 1000);
    assertEquals((await a.liveCall('prompt', { id: c.id, text: ASKS, clientMessageId: 'm1' }))[0], 200);
    await until(() => !c.busy && c.turnEndedAt !== null, 'the turn end', 15);
    assertEquals(phase(a, c), 'asks', JSON.stringify(c.attention()));
    await a.conversations.apply('handled', 'claude', c.sessionId); // what POST /api/live/conversation-state does
    assertEquals(phase(a, c), 'idle', 'handled live');
    // the chat rebuilt from the distro keeper's record (its times are the keeper's) stays handled
    lab.crash(a);
    const b = lab.aib();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assert(INBOX.secondsOf(r.attention().asksAt) > 0, 'the question is rebuilt too');
    assertEquals(phase(b, r), 'idle', `still handled after the rebuild: ${JSON.stringify(r.attention())}`);
  },
});
