/**
 * The one-off repair script (work/migrate/repair_lead_chat_history.ts), on a lab copy of the owner's situation: a chat's agent was
 * stopped by a take-over (its store left behind), the conversation came back as a new chat whose history is only the transcript
 * replay, and that chat keeps running in the keeper while AIB is quit. After the repair, the next take-over shows the whole earlier
 * history (turn ends, notes) before the new chat's own events, without the replayed copy, and the chat works on with numbers that
 * follow on.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

type Json = Record<string, unknown>;
Deno.env.set('AIB_HISTORY_V2', '1');
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const SCRIPT = new URL('../migrate/repair_lead_chat_history.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CONFIG = new URL('../../outputs/agent-studio/deno.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-repair-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly transcript = this.dir + SEP + 'transcript.json';
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    Deno.writeTextFileSync(this.transcript, '[]');
  }
  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake('--replay-file', this.transcript), cwd, provider, options ?? {});
    this.studios.push(studio);
    return studio;
  }
  async leave(studio: Studio): Promise<void> {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    await studio.historyClient()?.shutdown().catch(() => {});
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

async function say(studio: Studio, c: Connection, text: string): Promise<void> {
  const ends = c.events.filter((e) => e.kind === 'turn_end').length;
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: `say:${text}`, clientMessageId: crypto.randomUUID() }))[0], 200);
  await until(() => !c.busy && c.events.filter((e) => e.kind === 'turn_end').length > ends, `the end of ${text}`, 10);
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const out = await new Deno.Command(Deno.execPath(), { args: ['run', '-A', '--config', CONFIG, SCRIPT, ...args], stdout: 'piped', stderr: 'piped' })
    .output();
  return { code: out.code, out: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
}

function story(events: Json[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const data = e.data as Json;
    if (e.kind === 'user') out.push(`you: ${data.text}`);
    else if (e.kind === 'update') {
      const u = (data?.update ?? {}) as Json;
      if (u.sessionUpdate === 'user_message_chunk') out.push(`replayed: ${(u.content as Json).text}`);
    } else if (e.kind === 'turn_end') out.push('turn finished');
    else if (e.kind === 'studio_note') out.push(`AIB: ${data.message}`);
  }
  return out;
}

Deno.test({
  name: 'repair script: the earlier chat\'s history goes before the running chat\'s own events; the take-over and the next turn follow on',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    // The old chat: two turns and an AIB note; then a take-over stops its agent (the bug), leaving its store behind.
    const a = lab.studio();
    const old = await a.connect('omp', lab.work);
    await say(a, old, 'one');
    old.recordedEvent('studio_note', { message: 'Merged subagent “Docs” into main', kind: 'swarm-merge' });
    await say(a, old, 'two');
    await until(() => old.historyCkpt !== null && !old.busy, 'its checkpoint', 10);
    const session = old.sessionId!;
    await lab.leave(a);
    {
      const client = await KeeperClient.connect(readKeeperInfo(lab.state)!);
      const link = new KeeperLink({ dataDir: lab.state, orphan: null });
      await link.stopUnknown(client, `chat-${old.id}`);
      client.close();
    }
    // The conversation comes back as a new chat from the transcript, without its lines (as before this fix: no kept lines).
    Deno.removeSync(lab.state + SEP + 'conversation-lines', { recursive: true });
    Deno.writeTextFileSync(lab.transcript, JSON.stringify([
      { role: 'user', text: 'say:one' },
      { role: 'agent', text: 'one' },
      { role: 'user', text: 'say:two' },
      { role: 'agent', text: 'two' },
    ]));
    const b = lab.studio();
    const now = await b.connect('omp', lab.work, session);
    await say(b, now, 'three');
    await until(() => now.historyCkpt !== null && !now.busy && now.historyCkpt.sequence >= now.sequence - 1, 'its checkpoint', 10);
    assertEquals(story(now.events).filter((s) => s === 'turn finished').length, 1, 'only the new turn ends (the bug)');
    const pid = now.channel!.pid!;
    await lab.leave(b);

    // AIB quit; the repair runs.
    const chain = `${old.id},${now.id}`;
    const dry = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'omp']);
    assertEquals(dry.code, 0, dry.out);
    assert(dry.out.includes('Dry run: nothing was changed.'), dry.out);
    const applied = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'omp', '--apply']);
    assertEquals(applied.code, 0, applied.out);
    assert([...Deno.readDirSync(lab.state + SEP + 'repair-backups')].length === 1, 'a backup folder');
    const again = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'omp', '--apply']);
    assert(again.out.includes('Already repaired'), again.out);

    // AIB starts: the running chat is taken over with the whole history.
    const c = lab.studio();
    assertEquals(await c.adoptKeeper(), 1);
    const r = c.connections.get(now.id)!;
    await until(() => r.historyState === 'claimed' || r.historyState === 'dead', 'the store claimed', 10);
    assertEquals(r.rebuildError, '');
    assert(pidAlive(pid), 'the same agent');
    const page = await c.liveEvents(r.id, { before: r.sequence + 1, bytes: 50_000_000 }) as Json;
    const all = page.events as Json[];
    assertEquals(all[0].seq, 1, 'from the first event');
    assertEquals(story(all), [
      'you: say:one',
      'turn finished',
      'AIB: Merged subagent “Docs” into main',
      'you: say:two',
      'turn finished',
      'you: say:three',
      'turn finished',
    ]);
    const seqs = all.map((e) => e.seq as number);
    assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'in order');
    await say(c, r, 'four');
    assert(r.events.at(-1)!.seq as number > seqs.at(-1)!, 'the next turn follows on');
    const kept = Deno.readTextFileSync(lab.state + SEP + 'conversation-lines' + SEP + `omp_${session}.jsonl`).trim().split('\n');
    assertEquals(kept.length, 5, 'the three earlier turn ends and the note, then the new turn end');
  },
});
