/**
 * ACP client terminals in the keeper (keeper phase 3): with the chat's agent in the keeper, `terminal/create` writes its
 * `clientTerminal` note in the chat's record first, then the keeper starts the command. A "crashed" AIB is replaced by a new Studio
 * that rebuilds the chat; the agent's pending `terminal/wait_for_exit` is answered from the surviving terminal when it exits, and
 * `terminal/output` and `terminal/release` after it are answered from the same process and its recorded output: nothing is started
 * twice, nothing is "lost". Real keeper (built from keeper/ with Go), fake ACP agent (work/fake_acp.py --client-caps), temp folders.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink, parseNote } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, type KeeperRecord, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { CLIENT_TERMINAL_PREFIX, KeeperClientTerminal } from '../../outputs/agent-studio/server/acp/keeper_terminal.ts';
import { ClientCaps } from '../../outputs/agent-studio/server/acp/client_caps.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-keeper-ct-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly pids = this.dir + SEP + 'terminal-pids.txt';
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }
  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '60s'] });
    const studio = new Studio(
      { ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null, enableClientTerminal: true } as never,
      { keeper },
    );
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => new Connection(fake('--client-caps'), cwd, provider, options);
    this.studios.push(studio);
    return studio;
  }
  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
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

async function withClient<R>(state: string, work: (client: KeeperClient) => Promise<R>): Promise<R> {
  const client = await KeeperClient.connect(readKeeperInfo(state)!, 'test');
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

async function journal(state: string, channel: string): Promise<KeeperRecord[]> {
  return await withClient(state, async (client) => {
    const records: KeeperRecord[] = [];
    let live = false;
    await client.attach(channel, 0, { record: (r) => records.push(r), live: () => (live = true) });
    await until(() => live, 'journal read', 10);
    return records;
  });
}

function capsResults(c: Connection): Json[] | null {
  for (const e of c.events) {
    const update = e.kind === 'update' ? (e.data as Json).update as Json : null;
    const text = update?.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
    if (text.startsWith('CAPS-RESULTS ')) return JSON.parse(text.slice('CAPS-RESULTS '.length));
  }
  return null;
}

Deno.test({
  name: 'keeper client terminal: note first, then the keeper runs it; after a crash the new AIB answers wait_for_exit, output and release from it',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    assert(c.channel, 'the agent runs in the keeper');
    // 40 lines, 100 ms apart, then exit 3; its pid goes into a file (it must be started exactly once).
    const script = `Deno.writeTextFileSync(${JSON.stringify(lab.pids)}, Deno.pid + '\\n', { append: true }); let i = 0; ` +
      `const t = setInterval(() => { console.log('line ' + i++); if (i >= 40) { clearInterval(t); Deno.exit(3); } }, 100);`;
    const steps = [
      { method: 'terminal/create', params: { command: Deno.execPath(), args: ['eval', script] } },
      { method: 'terminal/wait_for_exit', params: { terminalId: '$term' } },
      { method: 'terminal/output', params: { terminalId: '$term' } },
      { method: 'terminal/release', params: { terminalId: '$term' } },
      { method: 'terminal/output', params: { terminalId: '$term' } },
    ];
    await a.liveCall('prompt', { id: c.id, text: 'caps:' + JSON.stringify(steps), clientMessageId: 'ct1' });
    const caps = c.caps as ClientCaps;
    await until(() => caps.terminals.size === 1, 'the terminal started', 15);
    const terminal = [...caps.terminals.values()][0];
    assert(terminal instanceof KeeperClientTerminal, 'it runs in the keeper');
    await until(() => terminal.snapshot()[0].includes('line 3'), 'output', 15);

    // Note first: the chat's record has the clientTerminal note naming the keeper channel, and the channel exists.
    const chatRecord = await journal(lab.state, `chat-${c.id}`);
    const notes = chatRecord.filter((r) => r.kind === 'note').map((r) => parseNote(r.body)!).filter((n) => n.t === 'clientTerminal');
    assertEquals(notes.length, 1);
    assertEquals([notes[0].terminalId, notes[0].channel], [terminal.id, `${CLIENT_TERMINAL_PREFIX}${terminal.id.slice(5)}`]);
    const before = (await withClient(lab.state, (k) => k.list())).find((ch) => ch.channel === notes[0].channel)!;
    assert(before.live && pidAlive(before.pid));

    lab.crash(a); // wait_for_exit is pending; the terminal keeps printing into the keeper
    await pause(700);

    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const back = b.connections.get(c.id)!;
    assertEquals(back.rebuildError, '');
    await until(() => capsResults(back), 'the agent got every answer', 30);
    const results = capsResults(back)!;
    assertEquals(results.length, 5);
    assertEquals(results[0].result, { terminalId: terminal.id });
    assertEquals(results[1].result, { exitCode: 3, signal: null }, 'wait_for_exit answered from the surviving terminal');
    const output = (results[2].result as Json).output as string;
    const lines = output.split(/\r?\n/).filter(Boolean);
    assertEquals(lines, Array.from({ length: 40 }, (_, i) => `line ${i}`), 'every line once, in order, across the restart');
    assertEquals((results[2].result as Json).exitStatus, { exitCode: 3, signal: null });
    assertEquals(results[3].result, null);
    assertEquals((results[4].error as Json).message, 'Unknown terminalId', 'released');
    assertEquals(Deno.readTextFileSync(lab.pids).trim().split('\n').length, 1, 'started once');
    await until(async () => !(await withClient(lab.state, (k) => k.list())).some((ch) => ch.channel.startsWith(CLIENT_TERMINAL_PREFIX)), 'channel removed', 10);
    const after = await journal(lab.state, `chat-${c.id}`);
    assert(after.some((r) => r.kind === 'note' && parseNote(r.body)?.t === 'clientTerminalReleased'), 'release noted');
  },
});

Deno.test({
  name: 'keeper client terminal: a terminal/create noted but never started (the old AIB stopped in between) is started once under the noted id',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    const caps = c.caps as ClientCaps;
    // The old AIB dies right after its note: its backend writes the note, then "crashes" before the keeper spawn.
    const realBackend = caps.terminalBackend!;
    let noted: (() => void) | null = null;
    const notedOnce = new Promise<void>((resolve) => (noted = resolve));
    caps.terminalBackend = {
      create: async (plan) => {
        await c.channel!.sendNote({
          t: 'clientTerminal',
          rpc: plan.rpc,
          terminalId: plan.terminalId,
          channel: `${CLIENT_TERMINAL_PREFIX}${plan.terminalId.slice(5)}`,
          sessionId: plan.sessionId,
          argv: plan.argv,
          cwd: plan.cwd,
          limit: plan.limit,
        });
        noted!();
        return await new Promise(() => {}); // never answers: the process "died" here
      },
      release: realBackend.release,
    };
    const script = `Deno.writeTextFileSync(${JSON.stringify(lab.pids)}, Deno.pid + '\\n', { append: true }); console.log('ran');`;
    const steps = [
      { method: 'terminal/create', params: { command: Deno.execPath(), args: ['eval', script] } },
      { method: 'terminal/wait_for_exit', params: { terminalId: '$term' } },
      { method: 'terminal/output', params: { terminalId: '$term' } },
    ];
    await a.liveCall('prompt', { id: c.id, text: 'caps:' + JSON.stringify(steps), clientMessageId: 'ct2' });
    await notedOnce;
    const note = (await journal(lab.state, `chat-${c.id}`)).map((r) => (r.kind === 'note' ? parseNote(r.body) : null)).find((n) => n?.t === 'clientTerminal')!;
    lab.crash(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const back = b.connections.get(c.id)!;
    await until(() => capsResults(back), 'answers', 30);
    const results = capsResults(back)!;
    assertEquals(results[0].result, { terminalId: note.terminalId }, 'the noted id');
    assertEquals(results[1].result, { exitCode: 0, signal: null });
    assert(String((results[2].result as Json).output).includes('ran'));
    assertEquals(Deno.readTextFileSync(lab.pids).trim().split('\n').length, 1, 'started once');
  },
});
