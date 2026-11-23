/**
 * Reopening chats with large histories (0.12.1 blocker, 2026-11-17: AIB exited while 16 chats reopened from their stores, among them
 * the lead chat's 237 MB / 38,577-event store and a WSL chat whose replay was 6000+ updates):
 *
 *   - the agent's session/load replay is kept as its NEWEST updates (bounded by count and bytes), so the turns made outside AIB are
 *     found at the end of a long transcript; before, the OLDEST 6000 were kept, and a common last message ("[Request interrupted by
 *     user]") matched an old turn: every later turn of the first 6000 updates was shown again as "outside AIB" (24 old turns came
 *     back in the WSL chat, recorded as new events)
 *   - several chats with large stores reopen at once under a memory ceiling
 *
 * The real keeper, the fake ACP agent (its --replay-file is the agent's transcript) and temp folders. AIB_BIG_REOPEN=1 runs the
 * owner-sized case (38,000 events, ~230 MB) and prints the memory figures.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection, outsideTurns, ReplayWindow } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { HistoryStore } from '../../outputs/agent-studio/server/history/store.ts';

type Json = Record<string, unknown>;
Deno.env.set('AIB_HISTORY_V2', '1');
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const BIG = Deno.env.get('AIB_BIG_REOPEN') === '1';
// ('say:' makes the fake agent answer at once; the text is the owner's WSL chat's last message)
const INTERRUPTED = 'say:[Request interrupted by user]';

class Lab {
  readonly dir = Deno.realPathSync(
    Deno.makeTempDirSync({ prefix: 'aib-reopen-large-' }),
  );
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }
  transcript(name: string): string {
    return this.dir + SEP + name + '.json';
  }
  studio(transcripts: Map<string, string>): Studio {
    const keeper = new KeeperLink({
      dataDir: this.state,
      orphan: null,
      extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'],
    });
    const studio = new Studio({
      claudeLauncher: import.meta.filename!, nodeCommand: 'node',
      stateDir: this.state,
      port: 0,
      ownersDir: null,
    }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const file = transcripts.get(cwd) ?? this.transcript('none');
      try {
        Deno.statSync(file);
      } catch {
        Deno.writeTextFileSync(file, '[]');
      }
      // each folder its own conversation (the fake agent's session id), so several chats can reopen at once
      const session = 'sess-' + cwd.split(SEP).at(-1);
      return new Connection(
        fake('--replay-file', file, '--new-session', session),
        cwd,
        provider,
        options ?? {},
      );
    };
    this.studios.push(studio);
    return studio;
  }
  get historyDir(): string {
    return this.state + SEP + 'history';
  }
  async killKeeper(): Promise<void> {
    const info = readKeeperInfo(this.state);
    if (!info || !pidAlive(info.pid)) return;
    try {
      const client = await KeeperClient.connect(info);
      await client.shutdown(true).catch(() => {});
      client.close();
    } catch { /* gone */ }
    await until(() => !pidAlive(info.pid), 'keeper exit', 10).catch(() => Deno.kill(info.pid, 'SIGKILL'));
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    await this.killKeeper();
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

/** The peak of this process's V8 heap and RSS (MB) while `work` runs, sampled every 10 ms. */
async function peakDuring<T>(
  work: () => Promise<T>,
): Promise<{ result: T; heapMb: number; rssMb: number; baseHeapMb: number }> {
  const mb = (n: number) => Math.round(n / 1048576);
  const base = Deno.memoryUsage();
  let heap = base.heapUsed, rss = base.rss;
  const timer = setInterval(() => {
    const m = Deno.memoryUsage();
    heap = Math.max(heap, m.heapUsed);
    rss = Math.max(rss, m.rss);
  }, 10);
  try {
    const result = await work();
    return {
      result,
      heapMb: mb(heap),
      rssMb: mb(rss),
      baseHeapMb: mb(base.heapUsed),
    };
  } finally {
    clearInterval(timer);
  }
}

async function send(
  studio: Studio,
  c: Connection,
  text: string,
  id: string,
): Promise<void> {
  const ends = c.events.filter((e) => e.kind === 'turn_end').length;
  assertEquals(
    (await studio.liveCall('prompt', { id: c.id, text, clientMessageId: id }))[
      0
    ],
    200,
  );
  await until(
    () => !c.busy && c.events.filter((e) => e.kind === 'turn_end').length > ends,
    `the end of ${id}`,
    10,
  );
}

/** The agent's transcript: `turns` turns; the user said INTERRUPTED early on (turn 10) and last; the agent's replies are `size` bytes. */
function writeTranscript(file: string, turns: number, size: number): void {
  const items: { role: string; text: string }[] = [];
  for (let i = 0; i < turns; i++) {
    items.push({
      role: 'user',
      text: i === 10 || i === turns - 1 ? INTERRUPTED : `question ${i}`,
    });
    items.push({ role: 'agent', text: `answer ${i} ` + 'y'.repeat(size) });
  }
  Deno.writeTextFileSync(file, JSON.stringify(items));
}

/** Fills a closed chat's store up to `events` events of about `size` bytes (helpers' tool output and the chat's own updates). */
function growStore(
  dir: string,
  chat: string,
  session: string,
  events: number,
  size: number,
): void {
  const { store } = HistoryStore.open(dir, chat);
  try {
    store.claim(99);
    let seq = store.checkpoint().writtenSeq;
    const now = Date.now() / 1000 - 3600;
    const filler = 'z'.repeat(size);
    for (let done = 0; done < events;) {
      const batch: Json[] = [];
      for (let i = 0; i < 500 && done < events; i++, done++) {
        seq += 1;
        const helper = done % 3 !== 0;
        batch.push({
          seq,
          kind: 'update',
          time: now + done / 100,
          data: {
            sessionId: helper ? 'helper-' + (done % 7) : session,
            update: helper
              ? {
                sessionUpdate: 'tool_call_update',
                toolCallId: `t${done}`,
                content: [{
                  type: 'content',
                  content: { type: 'text', text: filler },
                }],
              }
              : {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `old ${done} ${filler.slice(0, size / 4)}`,
                },
              },
          },
        });
      }
      store.append(batch as never);
    }
    // the chat's last user message: the generic one (as in the owner's WSL chat)
    seq += 1;
    store.append(
      [{
        seq,
        kind: 'user',
        time: now + events,
        data: { text: INTERRUPTED, sessionId: session },
      }] as never,
    );
  } finally {
    store.close();
  }
}

function outsideShown(
  c: Connection,
  from: number,
): { turns: number; updates: number; note: string } {
  const after = c.events.filter((e) => (e.seq as number) > from);
  const updates = after.filter((e) =>
    e.kind === 'update' &&
    ((e.data as Json)?.update as Json)?.sessionUpdate === 'user_message_chunk'
  );
  const note = after.find((e) =>
    e.kind === 'studio_note' &&
    String((e.data as Json)?.message).includes('from outside AIB')
  );
  return {
    turns: updates.length,
    updates: after.filter((e) => e.kind === 'update').length,
    note: note ? String((note.data as Json).message) : '',
  };
}

Deno.test('outsideTurns: a generic last message is matched at the END of the replay, never an old turn of the same text', () => {
  const u = (role: string, text: string) => ({
    sessionId: 's',
    update: {
      sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });
  const replay = [
    u('user', INTERRUPTED),
    u('agent', 'a'),
    u('user', 'q'),
    u('agent', 'b'),
    u('user', INTERRUPTED),
    u('agent', 'c'),
  ];
  assertEquals(outsideTurns(replay, INTERRUPTED).turns, 0);
  // the replay window keeps the newest updates: the oldest are dropped first, by count and by bytes
  const w = new ReplayWindow(3, 1_000_000);
  for (const p of replay) w.push(p);
  assertEquals(w.updates, replay.slice(-3));
  assertEquals(w.dropped, 3);
  const small = new ReplayWindow(100, 200);
  for (const p of replay) small.push(p);
  assert(
    small.updates.length < replay.length &&
      small.updates.at(-1) === replay.at(-1),
    'bytes bound: the newest kept',
  );
});

Deno.test({
  name: 'reopen: a long transcript whose last message is generic shows no old turns as "outside AIB" (the WSL chat of 2026-11-17)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const transcripts = new Map<string, string>();
    const a = lab.studio(transcripts);
    const c = await a.connect('claude', lab.work);
    await send(a, c, 'say:question 0', 'm1');
    await send(a, c, INTERRUPTED, 'm2');
    const session = c.sessionId!;
    await a.close();
    const sequence = c.sequence;
    // the agent's transcript: 4000 turns (8000 updates, more than the 6000 the replay window holds), the same generic message early on
    const file = lab.transcript('long');
    writeTranscript(file, BIG ? 8000 : 4000, BIG ? 4000 : 400);
    transcripts.set(lab.work, file);
    const b = lab.studio(transcripts);
    const { result: r, heapMb, rssMb, baseHeapMb } = await peakDuring(() => b.connect('claude', lab.work, session));
    console.log(
      `reopen of a ${BIG ? 8000 : 4000}-turn transcript: heap ${baseHeapMb} -> peak ${heapMb} MB, rss peak ${rssMb} MB`,
    );
    assertEquals(r.id, c.id);
    assertEquals(r.continuedFrom, sequence);
    const shown = outsideShown(r, sequence);
    assertEquals(
      shown.turns,
      0,
      `no old turn comes back as "outside AIB" (${shown.updates} updates, note: ${shown.note})`,
    );
    assertEquals(shown.note, '');
  },
});

Deno.test({
  name: 'reopen: three chats with large stores reopen at once under a memory ceiling, each going on in its own store',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const transcripts = new Map<string, string>();
    const a = lab.studio(transcripts);
    const chats: { id: string; session: string; cwd: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const cwd = lab.work + SEP + `p${i}`;
      Deno.mkdirSync(cwd, { recursive: true });
      const c = await a.connect('claude', cwd);
      await send(a, c, `say:hello ${i}`, `m${i}`);
      chats.push({ id: c.id, session: c.sessionId!, cwd });
    }
    await a.close();
    // the lead chat's size (38,000 events, ~230 MB) with AIB_BIG_REOPEN=1; 6,000 events of ~6 KB (~36 MB each) otherwise
    const events = BIG ? 38_000 : 6_000;
    const size = 6_000;
    const t0 = Date.now();
    for (const ch of chats) {
      growStore(lab.historyDir, ch.id, ch.session, events, size);
    }
    const storeMb = Math.round(
      Deno.statSync(lab.historyDir + SEP + chats[0].id + '.sqlite').size /
        1048576,
    );
    console.log(
      `3 stores of ${events} events (${storeMb} MB each) written in ${Date.now() - t0} ms`,
    );
    for (const ch of chats) {
      const file = lab.transcript(ch.id);
      writeTranscript(file, 3200, 1000); // 6,400 updates replayed per chat (the WSL chat's 6000+)
      transcripts.set(ch.cwd, file);
    }
    const b = lab.studio(transcripts);
    const { result, heapMb, rssMb, baseHeapMb } = await peakDuring(() =>
      Promise.all(chats.map((ch) => b.connect('claude', ch.cwd, ch.session)))
    );
    console.log(
      `3 reopens at once: heap ${baseHeapMb} -> peak ${heapMb} MB, rss peak ${rssMb} MB`,
    );
    for (const [i, r] of result.entries()) {
      assertEquals(r.id, chats[i].id, 'the same chat');
      assert((r.continuedFrom ?? 0) > events, 'going on in its store');
      assertEquals(outsideShown(r, r.continuedFrom!).turns, 0);
    }
    // The ceiling: what the reopen adds to this process's V8 heap. Each chat holds at most its newest MAX_EVENTS events (bounded by
    // MAX_EVENT_IMAGE_BYTES) and a bounded replay window while it loads.
    assert(
      heapMb - baseHeapMb < 600,
      `the reopen of three large stores stays under 600 MB of heap (${heapMb - baseHeapMb} MB)`,
    );
  },
});
