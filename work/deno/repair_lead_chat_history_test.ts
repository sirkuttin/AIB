/**
 * The one-off repair script (work/migrate/repair_lead_chat_history.ts), on a lab copy of the owner's situation: a chat's agent was
 * stopped by a take-over (its store left behind), the conversation came back as a new chat whose history is only the transcript
 * replay, and that chat keeps running in the keeper while AIB is quit. After the repair, the next take-over shows the whole earlier
 * history (turn ends, notes) before the new chat's own events, without the replayed copy, and the chat works on with numbers that
 * follow on.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';

type Json = Record<string, unknown>;
Deno.env.set('AIB_HISTORY_V2', '1');
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const SCRIPT = new URL('../migrate/repair_lead_chat_history.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CONFIG = new URL('../../app/deno.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-repair-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly transcript = this.dir + SEP + 'transcript.json';
  readonly studios: Aib[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    Deno.writeTextFileSync(this.transcript, '[]');
  }
  studio(): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake('--replay-file', this.transcript), cwd, provider, options ?? {});
    this.studios.push(studio);
    return studio;
  }
  async leave(studio: Aib): Promise<void> {
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

async function say(studio: Aib, c: Connection, text: string): Promise<void> {
  const ends = c.events.filter((e) => e.kind === 'turn_end').length;
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: `say:${text}`, clientMessageId: crypto.randomUUID() }))[0], 200);
  await until(() => !c.busy && c.events.filter((e) => e.kind === 'turn_end').length > ends, `the end of ${text}`, 10);
}

/** Hide a chat's store (as if an older build had not found or had deleted it); the function puts it back. */
function hide(lab: Lab, id: string): () => void {
  const path = lab.state + SEP + 'history' + SEP + `${id}.sqlite`;
  Deno.renameSync(path, path + '.hidden');
  return () => Deno.renameSync(path + '.hidden', path);
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
    const old = await a.connect('claude', lab.work);
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
    // (an older build: the earlier store was not found, so it came back under a new id; hidden here, put back after)
    const hidden = hide(lab, old.id);
    const b = lab.studio();
    const now = await b.connect('claude', lab.work, session);
    hidden();
    assert(now.id !== old.id, 'a new chat id (the bug)');
    await say(b, now, 'three');
    await until(() => now.historyCkpt !== null && !now.busy && now.historyCkpt.sequence >= now.sequence - 1, 'its checkpoint', 10);
    assertEquals(story(now.events).filter((s) => s === 'turn finished').length, 1, 'only the new turn ends (the bug)');
    const pid = now.channel!.pid!;
    await lab.leave(b);

    // AIB quit; the repair runs.
    const chain = `${old.id},${now.id}`;
    const dry = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'claude']);
    assertEquals(dry.code, 0, dry.out);
    assert(dry.out.includes('Dry run: nothing was changed.'), dry.out);
    const applied = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'claude', '--apply']);
    assertEquals(applied.code, 0, applied.out);
    assert([...Deno.readDirSync(lab.state + SEP + 'repair-backups')].length === 1, 'a backup folder');
    const again = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'claude', '--apply']);
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
    const kept = Deno.readTextFileSync(lab.state + SEP + 'conversation-lines' + SEP + `claude_${session}.jsonl`).trim().split('\n');
    assertEquals(kept.length, 5, 'the three earlier turn ends and the note, then the new turn end');
  },
});

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name: 'repair script: the 2026-11-17 chain (a gone store between the sources and the target, AIB quit idle): merged, reopened as the target',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const turns: string[] = [];
    const transcript = () =>
      Deno.writeTextFileSync(lab.transcript, JSON.stringify(turns.flatMap((t) => [{ role: 'user', text: `say:${t}` }, { role: 'agent', text: t }])));
    // A: the first chat, with an AIB note; AIB quits (idle)
    const a = lab.studio();
    const first = await a.connect('claude', lab.work);
    await say(a, first, 'one');
    first.recordedEvent('studio_note', { message: 'Merged subagent “Docs” into main', kind: 'swarm-merge', sessionId: first.sessionId });
    turns.push('one');
    const session = first.sessionId!;
    await a.close();
    // B: an older build brought it back under a new id (A's store not found); one turn; quit
    const backFirst = hide(lab, first.id);
    transcript();
    const b = lab.studio();
    const middle = await b.connect('claude', lab.work, session);
    assert(middle.id !== first.id);
    await say(b, middle, 'two');
    turns.push('two');
    await b.close();
    // C: a new id again; one turn; then an idle quit of that older build deleted its store (the bug): its turn is only in the transcript
    const backMiddle = hide(lab, middle.id);
    transcript();
    const c = lab.studio();
    const gone = await c.connect('claude', lab.work, session);
    await say(c, gone, 'three');
    turns.push('three');
    await c.close();
    Deno.removeSync(lab.state + SEP + 'history' + SEP + `${gone.id}.sqlite`);
    // T: the chat in use now (a new id once more): its replay holds C's turn; one turn of its own; AIB quits idle (the fix: kept)
    transcript();
    const d = lab.studio();
    const target = await d.connect('claude', lab.work, session);
    assert(target.id !== gone.id && target.id !== middle.id && target.id !== first.id);
    await say(d, target, 'four');
    turns.push('four');
    await d.close();
    backFirst();
    backMiddle();
    Deno.removeSync(lab.state + SEP + 'conversation-lines', { recursive: true });

    // the repair refuses, changing nothing, when the target store is missing
    const chain = `${first.id},${middle.id},${target.id}`;
    const targetFile = lab.state + SEP + 'history' + SEP + `${target.id}.sqlite`;
    Deno.renameSync(targetFile, targetFile + '.away');
    const refused = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'claude', '--apply']);
    assertEquals(refused.code, 5, refused.out);
    assert(refused.out.includes('Refused: the target store') && refused.out.includes('Nothing was changed'), refused.out);
    assert(!exists(lab.state + SEP + 'repair-backups'), 'nothing was written');
    Deno.renameSync(targetFile + '.away', targetFile);

    const dry = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'claude']);
    assertEquals(dry.code, 0, dry.out);
    assert(dry.out.includes('1 turn(s) no earlier store has'), dry.out);
    const applied = await run(['--data', lab.state, '--chain', chain, '--session', session, '--provider', 'claude', '--apply']);
    assertEquals(applied.code, 0, applied.out);

    // AIB starts: the conversation reopens as the target chat (the newest store of it), with the whole history, once
    const e = lab.studio();
    const r = await e.connect('claude', lab.work, session);
    assertEquals(r.id, target.id, 'the chat in use, same id');
    const page = await e.liveEvents(r.id, { before: r.sequence + 1, bytes: 50_000_000 }) as Json;
    const all = page.events as Json[];
    assertEquals(all[0].seq, 1, 'from the first event');
    assertEquals(story(all), [
      'you: say:one',
      'turn finished',
      'AIB: Merged subagent “Docs” into main',
      'you: say:two',
      'turn finished',
      'replayed: say:three', // the gone store's turn, from the target's replay...
      'turn finished', // ...with its turn end, put back there from the conversation's kept lines (5648b75)
      'you: say:four',
      'turn finished',
    ]);
    const seqs = all.map((x) => x.seq as number);
    assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'in order');
    await say(e, r, 'five');
    assert(r.events.at(-1)!.seq as number > seqs.at(-1)!, 'the next turn follows on');
  },
});
