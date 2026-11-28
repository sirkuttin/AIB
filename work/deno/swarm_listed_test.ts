/**
 * Left-list helpers (owner 2026-11-27), the server side:
 *   - start_helper `chat: true` (the user asked for a chat with it) is refused unless the main chat's current turn was started by the
 *     user; allowed, it lists the helper and adds " · in your chat list" to the start line;
 *   - the cap is 5 helpers the agent started per main chat; helpers the user asked for do not count; the 6th is refused in a clear line;
 *   - a listed helper is stopped only in a turn the user started (they said yes to "close it?");
 *   - Add to chat list / Move to Activity list (setListed): the registry, the one line, hiddenFromLists;
 *   - the connection: turnByUser, and session/fork (a copy when the agent advertises it, else a summary: forkHow);
 *   - a fork through a real AIB with fake agents and real git: the copy path and the summary path, named "<chat> (fork)", listed,
 *     waiting for the first message, one line in the main chat, no report back to the main agent.
 * WSL projects: wsl_helpers_test.ts runs listedAndFork (_wsl_helpers_scenarios.ts) over the fake distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, FAKE_UNIQUE, Lab as ConnLab, NODE, pause, until } from './_connection.ts';
import { makeRepo, runGit } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { hiddenFromLists } from '../../app/server/swarm/registry.ts';
import { Swarm } from '../../app/server/swarm/service.ts';
import { setSwarmEnabled } from '../../app/server/swarm/settings.ts';
import { chatDigest, summaryOpening, turnsOf } from '../../app/server/swarm/fork.ts';
import { consolidatedTools } from '../../app/server/artifacts/mcp_tools.ts';
import { WSL_TOOL_GROUPS } from '../../app/server/artifacts/mcp.ts';
import { pathOf } from '../../app/server/state/paths.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };

const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass every time.',
  owns: ['test/login/**'],
  done_when: 'the login tests pass',
  reply_with: 'cause in one line',
  test_cmd: 'none: not run here',
};
const SEED_BRIEF = { goal: '', owns: [] as string[], avoid: [], done_when: '', reply_with: '', test_cmd: '', read_only: false, context_files: [] };

// ---- a stub chat host: the service logic without agents -----------------------------------------------------------------------------

class Stub {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-swarm-listed-' }));
  readonly chats = new Map<string, Json>();
  readonly calls: [string, Json][] = [];
  readonly swarm: Swarm;
  #n = 0;
  readonly main: Json = {
    id: 'main-1', provider: 'claude', sessionId: 'sm', closed: false, cwd: this.dir, worktree: undefined,
    attention: { state: 'idle' }, queue: { items: [] }, busy: true, turnByUser: true, events: [],
  };

  constructor() {
    setSwarmEnabled(this.dir, true);
    this.chats.set('main-1', this.main);
    this.swarm = new Swarm({
      stateDir: this.dir,
      host: {
        liveList: () => Promise.resolve({ instanceId: 'x', connections: [...this.chats.values()] }),
        liveState: (id: unknown) => Promise.resolve(this.chats.get(String(id)) ?? null),
        liveCall: (name: string, body: unknown) => {
          this.calls.push([name, body as Json]);
          if (name === 'connect') {
            const id = `hchat-${++this.#n}`;
            this.chats.set(id, { id, provider: String((body as Json).provider), sessionId: `hs-${this.#n}`, closed: false, ready: false, setupDone: false });
            return Promise.resolve([200, { id }] as [number, unknown]);
          }
          return Promise.resolve([200, { ok: true, steered: true }] as [number, unknown]);
        },
      } as never,
      settings: { builtinEnabled: () => true, betaEnabled: () => true },
    });
  }

  userTurn(on: boolean): void {
    this.main.turnByUser = on;
  }

  start(extra: Json = {}): Promise<Json> {
    return this.swarm.tool('main-1', 'start_helper', { ...BRIEF, owns: [`n${++this.#n}/`], ...extra }).then(([, body]) => body as Json);
  }

  seed(id: string, fields: Json = {}) {
    return this.swarm.registry.update(id, () =>
      <never> {
        id, title: `seed ${id}`, project: this.dir, parent: { live: 'main-1', lasting: 'claude:sm' },
        chat: { live: '', lasting: '', provider: 'codex', model: '', mode: 'auto' }, brief: { ...SEED_BRIEF, owns: [`${id}/`] },
        worktree: { path: '', branch: '', base: '', start: '' }, state: 'working', reason: '', createdAt: 1, turnEndedAt: '',
        cursor: 0, reports: [], merge: null, notes: [], ...fields,
      });
  }

  lines(): string[] {
    return this.calls.filter(([n]) => n === 'swarm-note').map(([, b]) => String(b.message));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const c of this.chats.values()) if (c.id !== 'main-1') c.closed = true; // the opening loops end
    await pause(600);
    await this.swarm.stopWatching();
    try {
      Deno.removeSync(this.dir, { recursive: true });
    } catch { /* a late write */ }
  }
}

Deno.test({
  ...T,
  name: 'start_helper chat:true is refused unless the user started the turn; allowed it lists the helper and the start line says so',
  async fn() {
    await using stub = new Stub();
    stub.userTurn(false); // the agent's own work, a report it was woken with, a queued or steer turn it made
    const refused = await stub.start({ chat: true });
    assertEquals(refused.code, 'not_user_turn');
    assert(String(refused.error).includes('not started by the user'), String(refused.error));
    assertEquals(stub.swarm.registry.all().length, 0, 'nothing was started');
    stub.userTurn(true);
    const ok = await stub.start({ chat: true });
    assertEquals(ok.ok, true, JSON.stringify(ok));
    const h = stub.swarm.registry.get(String(ok.helper))!;
    assertEquals([h.listed, h.byUser], [true, true]);
    assertEquals(hiddenFromLists(h), false, 'a listed helper is not left out of the lists');
    assert(stub.lines().some((l) => l.startsWith('Started helper “Login tests”') && l.endsWith(' · in your chat list')), stub.lines().join(' | '));
    // without chat, the same turn: Activity only, the line says nothing of a list
    const plain = await stub.start();
    const p = stub.swarm.registry.get(String(plain.helper))!;
    assertEquals([!!p.listed, !!p.byUser, hiddenFromLists(p)], [false, false, true]);
    assert(!stub.lines().at(-1)!.includes('chat list'), stub.lines().at(-1));
  },
});

Deno.test({
  ...T,
  name: 'cap: 5 helpers the agent started per main chat; the 6th is refused in one clear line; helpers the user asked for do not count',
  async fn() {
    await using stub = new Stub();
    for (let n = 1; n <= 4; n++) await stub.seed(`h_seed000${n}`);
    const fifth = await stub.start();
    assertEquals(fifth.ok, true, 'the 5th is allowed: ' + JSON.stringify(fifth));
    const sixth = await stub.start();
    assertEquals(sixth.code, 'cap');
    assert(String(sixth.error).includes('already have 5 helpers') && String(sixth.error).includes('cap 5'), String(sixth.error));
    assert(String(sixth.error).includes('do not count'), 'the line says user-asked helpers are not counted: ' + sixth.error);
    // the user's own ask goes past the cap, any number of times
    stub.userTurn(true);
    const asked = await stub.start({ chat: true });
    assertEquals(asked.ok, true, JSON.stringify(asked));
    const askedToo = await stub.start({ chat: true });
    assertEquals(askedToo.ok, true, JSON.stringify(askedToo));
    const caps = ((await stub.swarm.tool('main-1', 'helper_providers', {}))[1] as { caps: Json }).caps;
    assertEquals([caps.running, caps.max], [5, 5], 'the asked-for ones are not counted');
    // another main chat is not held back by this one's helpers
    const other = { ...stub.main, id: 'main-2', sessionId: 'sm2' };
    stub.chats.set('main-2', other);
    const fromOther = await stub.swarm.tool('main-2', 'start_helper', { ...BRIEF, owns: ['elsewhere/'] });
    assertEquals((fromOther[1] as Json).ok, true, JSON.stringify(fromOther[1]));
    assert(consolidatedHelperText().includes('Caps: 5 at once'), 'the tool description says 5');
  },
});

function consolidatedHelperText(): string {
  const tools = consolidatedTools({ main: true, worktree: false, restricted: false } as never, WSL_TOOL_GROUPS) as { name: string; description: string; inputSchema: { properties: Json } }[];
  const helper = tools.find((t) => t.name === 'helper')!;
  assertEquals((helper.inputSchema.properties.chat as Json).type, 'boolean', 'start takes chat');
  return helper.description;
}

Deno.test({
  ...T,
  name: 'a listed helper is stopped only in a turn the user started; stop all leaves listed helpers alone otherwise',
  async fn() {
    await using stub = new Stub();
    await stub.seed('h_list0001', { listed: true, byUser: true });
    await stub.seed('h_plain001');
    stub.userTurn(false);
    const refused = (await stub.swarm.tool('main-1', 'stop_helper', { helper: 'h_list0001' }))[1] as Json;
    assertEquals(refused.code, 'listed');
    assert(String(refused.error).includes('Ask the user'), String(refused.error));
    const all = (await stub.swarm.tool('main-1', 'stop_helper', { helper: 'all' }))[1] as { stopped: string[] };
    assertEquals(all.stopped, ['h_plain001'], 'stop all skips the listed one');
    assertEquals(stub.swarm.registry.get('h_list0001')!.state, 'working');
    stub.userTurn(true); // the user said yes
    const done = (await stub.swarm.tool('main-1', 'stop_helper', { helper: 'h_list0001' }))[1] as { stopped: string[] };
    assertEquals(done.stopped, ['h_list0001']);
    assertEquals(stub.swarm.registry.get('h_list0001')!.listed, true, 'it stays listed after it stopped, until the user closes it');
  },
});

Deno.test({
  ...T,
  name: 'Add to chat list and Move to Activity list: the registry, hiddenFromLists, one line when listed',
  async fn() {
    await using stub = new Stub();
    await stub.seed('h_act00001');
    assertEquals(hiddenFromLists(stub.swarm.registry.get('h_act00001')), true);
    assertEquals((await stub.swarm.setListed('h_act00001', true))[0], 200);
    const h = stub.swarm.registry.get('h_act00001')!;
    assertEquals(h.listed, true);
    assertEquals(!!h.byUser, false, 'added from Activity: it still counts toward the cap (the agent started it)');
    assertEquals(hiddenFromLists(h), false);
    assertEquals(stub.lines().length, 1);
    assert(stub.lines()[0].endsWith('is in your chat list'), stub.lines()[0]);
    await stub.swarm.setListed('h_act00001', true);
    assertEquals(stub.lines().length, 1, 'listing it again says nothing more');
    assertEquals((await stub.swarm.setListed('h_act00001', false))[0], 200);
    assertEquals(hiddenFromLists(stub.swarm.registry.get('h_act00001')), true, 'back in Activity only');
    assertEquals((await stub.swarm.setListed('h_nope', true))[0], 404);
    assertEquals((await stub.swarm.setListed('h_act00001', 'yes'))[0], 400);
  },
});

// ---- the connection: turnByUser and session/fork ----------------------------------------------------------------------------------------

Deno.test({
  ...T,
  name: 'connection: turnByUser is true for a turn the user started, false for AIB swarm/merge lines and for no turn',
  async fn() {
    await using lab = new ConnLab();
    const c = await lab.open(['--models']);
    const state = () => ({ turnByUser: c.userTurn() }) as Json;
    assertEquals(!!state().turnByUser, false, 'no turn running');
    (c as unknown as { $startTurn(id: string | null, fp: string): number }).$startTurn('ui-123', 'fp');
    assertEquals(state().turnByUser, true, 'a message from the page');
    (c as unknown as { $startTurn(id: string | null, fp: string): number }).$startTurn('swarm-report-h_1-1', 'fp');
    assertEquals(!!state().turnByUser, false, 'a helper report that woke the agent');
    (c as unknown as { $startTurn(id: string | null, fp: string): number }).$startTurn('merge-ab12', 'fp');
    assertEquals(!!state().turnByUser, false, "AIB's own merge line");
    c.autonomous = true;
    assertEquals(!!state().turnByUser, false, 'a cycle the agent started on its own');
  },
});

async function forkWith(flags: string[]): Promise<{ how: string; sessionId: string | null; log: string }> {
  await using lab = new ConnLab();
  const log = lab.path('agent-log.txt');
  const c = lab.connection(fake(...flags), { env: { FAKE_ACP_LOG: log } }, lab.dir, 'codex');
  c.forkFrom = 'source-session';
  await c.setup(null);
  await until(() => c.ready, 'ready');
  return { how: c.forkHow, sessionId: c.sessionId, log: Deno.readTextFileSync(log) };
}

Deno.test({
  ...T,
  name: 'connection fork: a copy through session/fork when the agent advertises it; a summary when it does not, or when it refuses',
  async fn() {
    const copy = await forkWith(['--models', '--fork']);
    assertEquals(copy.how, 'copy');
    assert(copy.log.includes('"session/fork"') && copy.log.includes('source-session'), 'session/fork was sent for the source session');
    assert(!copy.log.includes('"session/new"'), 'no new session was started');
    const none = await forkWith(['--models']);
    assertEquals(none.how, 'summary');
    assert(none.log.includes('"session/new"') && !none.log.includes('"session/fork"'), 'an agent that does not advertise fork gets session/new');
    const refused = await forkWith(['--models', '--fork', '--fork-refuse']);
    assertEquals(refused.how, 'summary', 'a refused fork falls back to a summary');
    assert(refused.log.includes('"session/fork"') && refused.log.includes('"session/new"'));
    assert(refused.sessionId, 'the fork has a session');
  },
});

Deno.test('fork digest: the first ask, later requests in a line each, the last messages in full; the opening starts with "Summary of"', () => {
  const user = (text: string) => ({ kind: 'user', data: { text } });
  const agent = (text: string) => ({ kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { text } } } });
  const events = [
    user('Build the login page'), agent('Done, '), agent('it is in login.ts'),
    user('Now add a reset link'), agent('Added.'),
    user('Rename the button'), agent('Renamed.'),
    user('Add a test'), agent('Test added.'),
    user('Run it'), agent('Passing.'),
  ];
  assertEquals(turnsOf(events).length, 10);
  assertEquals(turnsOf(events)[1], { who: 'agent', text: 'Done, it is in login.ts' }, 'reply chunks join');
  const digest = chatDigest(events);
  assert(digest.includes('What the user first asked: Build the login page'), digest);
  assert(digest.includes('- Now add a reset link'), 'an earlier request is one line: ' + digest);
  assert(digest.includes('User: Run it') && digest.includes('You: Passing.'), 'the last messages are in full: ' + digest);
  const opening = summaryOpening('Login', digest);
  assert(opening.startsWith('Summary of “Login”'), opening.slice(0, 40));
  assertEquals(chatDigest([]), 'The chat had no messages yet.');
});

// ---- a fork through a real AIB: fake agents, real git ---------------------------------------------------------------------------------------

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-swarm-fork-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly aib: Aib;
  readonly swarm: Swarm;
  readonly calls: [string, Json][] = [];

  constructor(flags: string[]) {
    setSwarmEnabled(this.state, true);
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0 }, { keeper: null });
    aib.ownerProbe = () => null;
    aib.agentLaunch = () => Promise.resolve([['unused'], {}]);
    aib.connectionFactory = (_command, cwd, provider, options) => new Connection([NODE, FAKE_UNIQUE, ...flags], cwd, provider, options ?? {});
    const live = aib.liveCall.bind(aib);
    aib.liveCall = (name: string, body: unknown) => {
      this.calls.push([name, body as Json]);
      return live(name, body);
    };
    this.aib = aib;
    this.swarm = new Swarm({ stateDir: this.state, host: aib, settings: aib.settings });
    this.swarm.openMs = 30_000;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.swarm.stopWatching();
    await this.aib.close().catch(() => {});
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

async function answerApprovals(c: Connection): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (c.busy && Date.now() < deadline) {
    for (const key of [...c.permissions.keys()]) c.permission(key, 'yes');
    await pause(50);
  }
}
const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => e.data as Json);
const userTexts = (c: Connection) => c.events.filter((e) => e.kind === 'user').map((e) => String((e.data as Json).text));

async function forkedChat(box: Box) {
  const main = await box.aib.connect('codex', box.project);
  await main.prompt('Write the login page', 'ui-1');
  await answerApprovals(main);
  await until(() => !main.busy, 'the main turn ended', 15);
  const [status, made] = await box.swarm.fork({ id: main.id, title: 'Login chat' });
  assertEquals(status, 200, JSON.stringify(made));
  const id = String((made as Json).helper);
  await until(() => box.swarm.registry.get(id)?.state === 'working', 'the fork open', 40);
  await until(() => box.swarm.registry.get(id)?.fork?.how, 'how it forked', 40);
  const h = box.swarm.registry.get(id)!;
  return { main, h, chat: box.aib.connections.get(h.chat.live)! };
}

Deno.test({
  ...T,
  name: 'fork (copy): "<chat> (fork)", its own git copy, listed under the main chat, waiting for the first message; one line in the main chat; never a report back',
  async fn() {
    await using box = new Box(['--models', '--fork']);
    const { main, h, chat } = await forkedChat(box);
    assertEquals(h.title, 'Login chat (fork)');
    assertEquals([h.listed, h.byUser, h.fork!.how], [true, true, 'copy']);
    assertEquals(hiddenFromLists(h), false);
    assertEquals(h.parent.lasting, `codex:${main.sessionId}`, 'listed under the main chat');
    assert(h.worktree.path && h.worktree.branch.startsWith('studio/helper-'), 'its own worktree: ' + JSON.stringify(h.worktree));
    assertEquals(chat.forkHow, 'copy');
    assertEquals(userTexts(chat), [], 'waiting for the first message: nothing was sent to it');
    assert(notes(chat).some((n) => String(n.message).startsWith('Copy of “Login chat”')), JSON.stringify(notes(chat)));
    const mainLines = notes(main).filter((n) => n.kind === 'swarm-start').map((n) => String(n.message));
    assertEquals(mainLines, ['Forked “Login chat” into “Login chat (fork)” · in your chat list'], 'one line in the main chat');
    // the user talks to it: its turn end is not a report to the main agent
    await chat.prompt('hello fork', 'ui-2');
    await answerApprovals(chat);
    await until(() => !chat.busy, 'the fork turn ended', 15);
    await box.swarm.poll();
    await pause(300);
    await box.swarm.poll();
    const after = box.swarm.registry.get(h.id)!;
    assert(after.reports.every((r) => r.delivered), 'its reports are not for the main agent');
    assert(!notes(main).some((n) => n.kind === 'swarm-report'), 'no "Report from" line in the main chat');
    assertEquals(box.calls.filter(([n, b]) => (n === 'steer' || n === 'queue') && b.id === main.id).length, 0, 'the main agent was never woken');
    // it is not an agent-started helper: it does not use a place of the cap
    const caps = ((await box.swarm.tool(main.id, 'helper_providers', {}))[1] as { caps: Json }).caps;
    assertEquals(caps.running, 0);
  },
});

Deno.test({
  ...T,
  name: 'fork (summary): an agent that cannot copy its session starts from "Summary of <chat>" with the recent messages',
  async fn() {
    await using box = new Box(['--models']);
    const { h, chat } = await forkedChat(box);
    assertEquals(h.fork!.how, 'summary');
    assertEquals(h.title, 'Login chat (fork)');
    assertEquals(hiddenFromLists(h), false);
    await until(() => userTexts(chat).length > 0, 'the summary sent', 15);
    const first = userTexts(chat)[0];
    assert(first.startsWith('Summary of “Login chat”'), first.slice(0, 80));
    assert(first.includes('Write the login page'), 'it carries what the chat said: ' + first);
  },
});

Deno.test({
  ...T,
  name: 'fork of a chat whose agent refuses session/fork falls back to the summary; a fork of a listed helper belongs to its main chat',
  async fn() {
    await using box = new Box(['--models', '--fork', '--fork-refuse']);
    const { main, h, chat } = await forkedChat(box);
    assertEquals(h.fork!.how, 'summary');
    await until(() => userTexts(chat).length > 0, 'the summary sent', 15);
    assert(userTexts(chat)[0].startsWith('Summary of “Login chat”'));
    // forking the fork: no helper of a helper; the new fork hangs under the same main chat
    await answerApprovals(chat);
    await until(() => !chat.busy, 'the summary turn ended', 15);
    const [status, second] = await box.swarm.fork({ id: chat.id, title: 'Login chat (fork)' });
    assertEquals(status, 200, JSON.stringify(second));
    const again = box.swarm.registry.get(String((second as Json).helper))!;
    assertEquals(again.parent.lasting, h.parent.lasting);
    assertEquals(again.parent.live, main.id);
    assertEquals(again.title, 'Login chat (fork) (fork)');
  },
});
