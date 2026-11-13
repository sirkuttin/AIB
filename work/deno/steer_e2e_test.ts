/**
 * Steer-on-send, end to end (beta.9): a real Studio (web server + separate agent host, so every route goes through the host proxy and
 * its allow list), the fake agents of work/fake_acp.py --steer <claude|codex|omp> that replay the real recordings of
 * work/steer-recordings (C1-C4, X1-X4, O1-O2), and for the page tests a headless Chrome/Edge (no window). The commands the fake
 * "runs" are real child processes (a parent with a child), so a Stop can be checked to kill exactly those and nothing else.
 * The contract names are in _steer_lab.ts (ROUTES) and in the snapshot fields used below: steerable, steerAgent, steerLane,
 * tool.background {state, stoppable}, user events with steered: true.
 *
 * Which side a test needs (the tests fail until it has landed; they were written against the contract, build-brief-beta9.md):
 *   [A] server (feat/steer-server): routes, snapshot, queues, Stop.      [B] page (feat/steer-page): composer, menu, rows.
 * Owner decisions: 1 keep "Send after this turn" (S2, P2, P7); 2 Stop on a backgrounded command kills its processes (S6-S8, P5);
 * 3 OMP is steered too (S1, S8); 4 an agent that cannot steer: "Send" + hint (S2, P3); 5 held while a card is open, no
 * "Deny and send" (S9-S11, P4). Architect tests: T15 S5, T16/T17 S4, T18 P6, T19/T20 S6/S7/S5, T22 S12, T23 S10, T24 S11/S3, T26 S3,
 * T27 S13/P8, T25 S14 (with the unit tests of merge.ts / docs_routes.ts). Not end to end here: T21 (steer_background_test.ts,
 * steer_transcript_test.ts), T28 (the <studio-context> note: needs a worktree sync; steer_lane_test.ts).
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/steer_e2e_test.ts   (--filter "S6" for one)
 */
import {
  answerCard,
  assert,
  assertEquals,
  backgroundOf,
  clickByText,
  composerText,
  hasBrowser,
  type Json,
  openPage,
  pidAlive,
  type SteerChat,
  SteerLab,
  TEST_OPTIONS,
  typeAndSend,
  until,
  visibleByText,
  type Who,
} from './_steer_lab.ts';

const LONG = 45; // a deadline, not a delay
const WHO: Who[] = ['claude', 'codex', 'omp'];

async function started(options?: ConstructorParameters<typeof SteerLab>[0]): Promise<SteerLab> {
  const lab = new SteerLab(options);
  await lab.start();
  return lab;
}

const working = (chat: SteerChat) => until(async () => (await chat.state()).busy, 'the turn is running', LONG);
const idle = (chat: SteerChat) => until(async () => !(await chat.state()).busy, 'the turn ended', LONG);
const turnEnds = async (chat: SteerChat) => (await chat.events('turn_end')).length;
const userEvents = async (chat: SteerChat, text: string) => (await chat.events('user')).filter((e) => (e.data as Json).text === text);
const lane = (st: Json) => (st.steerLane as Json[] | undefined) ?? [];
const waitText = (chat: SteerChat, text: string, seconds = LONG) =>
  until(async () => (await chat.agentText()).includes(text), `the agent text "${text}"`, seconds);
const none = async (ms: number, what: string, check: () => boolean | Promise<boolean>) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert(!(await check()), what);
    await new Promise((r) => setTimeout(r, 100));
  }
};

// ---- S1: steer while working, for all three agents -----------------------------------------------------------------------------------

for (const who of WHO) {
  Deno.test({
    name: `S1 [A] ${who}: a message typed while it works is injected, shown once as "sent while working", answered; one turn`,
    ...TEST_OPTIONS,
    async fn() {
      await using lab = await started();
      const chat = await lab.chat(who);
      const gate = lab.gate();
      await chat.prompt(`steer-wait:${gate}`, 'first');
      await working(chat);
      const before = await chat.state();
      assertEquals(before.steerable, true, 'steerable = busy and not autonomous and the agent can steer');
      assertEquals(before.steerAgent, who);
      const [status, body] = await chat.steer('what is 2+2?', 'steer-1');
      assertEquals(status, 200, JSON.stringify(body));
      assert(['injected', 'sending', 'held'].includes(String(body.state)), `receipt state ${JSON.stringify(body)}`);
      await waitText(chat, 'Steered reply: what is 2+2?');
      const sent = lab.steersReceived(chat);
      assertEquals(sent.map((s) => s.text), ['what is 2+2?']);
      assertEquals(((sent[0].meta?.steering ?? {}) as Json).idleBehavior, 'promptRequired', 'idleBehavior is mandatory for Claude and harmless for the rest');
      assertEquals(lab.promptsReceived(chat), [`steer-wait:${gate}`], 'the steer went through _session/steering, not as a prompt');
      const bubbles = await userEvents(chat, 'what is 2+2?');
      assertEquals(bubbles.length, 1, 'AIB shows the bubble itself (no adapter echoes it), once');
      assertEquals((bubbles[0].data as Json).steered, true);
      await until(async () => lane(await chat.state()).every((l) => l.state === 'injected') , 'the steer lane settled', LONG);
      assertEquals(await turnEnds(chat), 0, 'still one running turn');
      chat.open(gate);
      await idle(chat);
      assertEquals(await turnEnds(chat), 1);
      assertEquals(((await chat.state()).steerable), false, 'idle: not steerable');
    },
  });
}

// ---- S2: agents that cannot steer; "Send after this turn" -----------------------------------------------------------------------------

Deno.test({
  name: 'S2 [A] an agent that cannot steer: not steerable, nothing reaches it mid-turn, the message waits for the turn to end',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started({ plain: ['claude'] });
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    await chat.prompt(`gate:${gate}`, 'first');
    await working(chat);
    assertEquals((await chat.state()).steerable, false);
    await chat.steer('later please', 'plain-1'); // whatever the route answers, the message must wait
    await none(1500, 'a request that is not allowed reached the agent mid-turn', () => lab.steersReceived(chat).length > 0 || lab.promptsReceived(chat).length > 1);
    chat.open(gate);
    await until(() => lab.promptsReceived(chat).includes('later please'), 'the message sent after the turn', LONG);
    assertEquals(lab.promptsReceived(chat).filter((t) => t === 'later please').length, 1, 'once');
    assertEquals((await userEvents(chat, 'later please')).length, 1);
  },
});

Deno.test({
  name: 'S2b [A] "Send after this turn" (the queue) is unchanged on a steerable agent: nothing is injected, it is sent when the turn ends',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    await chat.prompt(`steer-wait:${gate}`, 'first');
    await working(chat);
    const [status] = await chat.queue('after the turn', 'q-1');
    assertEquals(status, 200);
    assert(JSON.stringify((await chat.state()).queue).includes('after the turn'), 'it sits in the after-turn queue');
    await none(1200, 'queued text was injected', () => lab.steersReceived(chat).length > 0 || lab.promptsReceived(chat).length > 1);
    chat.open(gate);
    await until(() => lab.promptsReceived(chat).includes('after the turn'), 'the queued prompt', LONG);
    assertEquals(lab.steersReceived(chat).length, 0);
    assertEquals((await userEvents(chat, 'after the turn')).filter((e) => (e.data as Json).steered).length, 0, 'not tagged as steered');
  },
});

// ---- S3: idle sends at once (T24 idle release, T26 routes reach the host) --------------------------------------------------------------

for (const who of WHO) {
  Deno.test({
    name: `S3 [A] ${who}: with the agent idle the steer route sends the message as a normal prompt at once (T26: through the host proxy)`,
    ...TEST_OPTIONS,
    async fn() {
      await using lab = await started();
      const chat = await lab.chat(who);
      const [status, body] = await chat.steer('hello there', 'idle-1');
      assertEquals(status, 200, JSON.stringify(body));
      await waitText(chat, 'Fixture reply: hello there');
      assertEquals(lab.promptsReceived(chat), ['hello there']);
      const bubbles = await userEvents(chat, 'hello there');
      assertEquals(bubbles.length, 1);
      assert(!(bubbles[0].data as Json).steered, 'an idle send is an ordinary message');
      const [unknown] = await lab.web.post('no-such-op', { id: chat.id });
      assertEquals(unknown, 404, 'an unknown route stays 404 (the allow list is not open)');
    },
  });
}

// ---- S4: T16 + T17, the race at the end of a turn ----------------------------------------------------------------------------------

Deno.test({
  name: 'S4 [A] T16/T17: a steer answered promptRequired a few ms before the turn ends is sent as a prompt after it: no error, once, not dropped as a duplicate',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('codex');
    const gate = lab.gate();
    await chat.prompt(`steer-late:${gate}`, 'first');
    await working(chat);
    const [status, body] = await chat.steer('one more thing', 'late-1');
    assertEquals(status, 200, JSON.stringify(body));
    await until(() => lab.promptsReceived(chat).includes('one more thing'), 'the fallback prompt reached the agent', LONG);
    await waitText(chat, 'Fixture reply: one more thing');
    assertEquals(lab.promptsReceived(chat).filter((t) => t === 'one more thing').length, 1);
    const st = await chat.state();
    assertEquals(st.error || null, null, 'no "Wait for the current turn" error');
    assertEquals((await userEvents(chat, 'one more thing')).length, 1, 'one bubble');
    await idle(chat);
    assertEquals(lane(await chat.state()), [], 'nothing left in the steer lane');
  },
});

// ---- S5: T15 steer during a foreground helper ----------------------------------------------------------------------------------------

Deno.test({
  name: 'S5 [A] T15/T19: steering a Claude chat while a helper runs does not end the turn early; the queue waits; the helper row has no Stop',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    await chat.prompt(`steer-helper:${gate}`, 'first');
    const [parent, leaf] = await chat.pids(gate);
    await working(chat);
    await chat.steer('what is 3+3?', 'h-1');
    await waitText(chat, 'Steered reply: what is 3+3?');
    await chat.queue('after everything', 'h-q');
    // the steered reply has ended (its human usage_update) but session/prompt is held until the helper finishes
    await none(2000, 'the turn ended early (its reply ended while the helper still runs)', async () => !(await chat.state()).busy || (await turnEnds(chat)) > 0);
    assertEquals(lab.promptsReceived(chat), [`steer-helper:${gate}`], 'the queue did not pump');
    const [status] = await chat.stopTool('toolu_steer_agent'); // a helper (Agent) row is not a shell call
    assertEquals(status, 409, 'only shell calls can be stopped');
    assert(pidAlive(parent) && pidAlive(leaf), 'the helper work was left alone');
    chat.open(gate);
    await until(() => lab.promptsReceived(chat).includes('after everything'), 'the queued message after the helper ended', LONG);
    assertEquals(await turnEnds(chat) >= 1, true);
    await until(async () => (await turnEnds(chat)) === 2 || !(await chat.state()).busy, 'settled', LONG);
  },
});

// ---- S6: Claude, a command in the background, Stop kills exactly its processes (T19, T20) -------------------------------------------------

Deno.test({
  name: 'S6 [A] Claude C1: steering during a command backgrounds it; Stop kills that command and its child and nothing else; Claude answers after Stop',
  ...TEST_OPTIONS,
  async fn() {
    const bystander = `${Deno.makeTempDirSync({ prefix: 'aib-steer-by-' })}${Deno.build.os === 'windows' ? '\\' : '/'}child.pid`;
    await using lab = await started({ extra: { claude: ['--child-pid-file', bystander] } });
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    await chat.prompt(`steer-bash:${gate}`, 'first');
    const [parent, leaf] = await chat.pids(gate);
    const other = Number(Deno.readTextFileSync(bystander));
    await working(chat);
    assertEquals(await backgroundOf(chat, 'toolu_steer_bash'), null, 'a foreground command is not a background one');
    await chat.steer('what is 2+2?', 'b-1');
    await waitText(chat, 'Steered reply: what is 2+2?');
    await until(async () => (await backgroundOf(chat, 'toolu_steer_bash'))?.state === 'running', 'the command is marked as running in the background', LONG);
    assertEquals((await backgroundOf(chat, 'toolu_steer_bash'))?.stoppable, true);
    await idle(chat); // the turn ended; the command did not
    assert(pidAlive(parent) && pidAlive(leaf));
    const [status, body] = await chat.stopTool('toolu_steer_bash');
    assertEquals(status, 200, JSON.stringify(body));
    await until(() => !pidAlive(parent) && !pidAlive(leaf), 'the command and its child are gone', LONG);
    assert(pidAlive(other), "the agent's other child process was not touched");
    await until(async () => (await backgroundOf(chat, 'toolu_steer_bash'))?.state === 'stopped', 'the row says stopped', LONG);
    const [again] = await chat.stopTool('toolu_steer_bash');
    assertEquals(again, 409, 'nothing left to stop');
    const [unknown] = await chat.stopTool('toolu_does_not_exist');
    assert(unknown === 409 || unknown === 404, `unknown tool: ${unknown}`);
    // Claude Code posts its own short reply when the command ends (accepted, announced in the release notes): the chat is busy for it, then idle
    await waitText(chat, 'The command finished.');
    await idle(chat);
    assert(pidAlive(other), 'still alive at the end');
  },
});

Deno.test({
  name: 'S6b [A] Claude C1: a backgrounded command that ends by itself is marked done (no Stop left), the autonomous cycle follows',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    await chat.prompt(`steer-bash:${gate}`, 'first');
    await working(chat);
    await chat.steer('what is 2+2?', 'b-2');
    await until(async () => (await backgroundOf(chat, 'toolu_steer_bash'))?.state === 'running', 'running in the background', LONG);
    chat.open(gate); // the command ends on its own: Claude Code sends no update for the card, only its own cycle (task-notification)
    await waitText(chat, 'The command finished.');
    await idle(chat);
    assertEquals((await backgroundOf(chat, 'toolu_steer_bash'))?.state, 'done');
    assertEquals((await backgroundOf(chat, 'toolu_steer_bash'))?.stoppable, false);
  },
});

// ---- S7: Codex ---------------------------------------------------------------------------------------------------------------------

Deno.test({
  name: 'S7 [A] Codex X1: the turn ends while the command runs on; its update arrives after end_turn; it is marked background; Stop kills it',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('codex');
    const gate = lab.gate();
    await chat.prompt(`steer-bash:${gate}`, 'first');
    const [parent, leaf] = await chat.pids(gate);
    await working(chat);
    await chat.steer('what is 2+2?', 'x-1');
    await waitText(chat, 'Steered reply: what is 2+2?');
    await idle(chat); // end_turn while the command still runs
    await until(async () => (await backgroundOf(chat, 'exec-steer-bash'))?.state === 'running', 'marked background: tool updates keep arriving after end_turn', LONG);
    assertEquals((await backgroundOf(chat, 'exec-steer-bash'))?.stoppable, true);
    assertEquals(await turnEnds(chat), 1, 'no follow-up turn');
    const [status, body] = await chat.stopTool('exec-steer-bash');
    assertEquals(status, 200, JSON.stringify(body));
    await until(() => !pidAlive(parent) && !pidAlive(leaf), 'the command and its child are gone', LONG);
    await until(async () => (await backgroundOf(chat, 'exec-steer-bash'))?.state === 'stopped', 'stopped, not done', LONG);
    assertEquals(await turnEnds(chat), 1, 'its late tool update started no turn');
  },
});

Deno.test({
  name: 'S7b [A] Codex X1: a command that ends by itself after the turn is marked done by its late completed update',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('codex');
    const gate = lab.gate();
    await chat.prompt(`steer-bash:${gate}`, 'first');
    await working(chat);
    await chat.steer('what is 2+2?', 'x-2');
    await idle(chat);
    await until(async () => (await backgroundOf(chat, 'exec-steer-bash'))?.state === 'running', 'running in the background', LONG);
    chat.open(gate);
    await until(async () => (await backgroundOf(chat, 'exec-steer-bash'))?.state === 'done', 'done', LONG);
    assertEquals((await backgroundOf(chat, 'exec-steer-bash'))?.stoppable, false);
  },
});

Deno.test({
  name: 'S7c [A] Codex v1 drop: a steer the adapter said "injected" but never read comes back paused with a "may not have read this" note; Resume sends it once',
  ...TEST_OPTIONS,
  async fn() {
    // As built (connection.ts #steerUnread): the message leaves the steer lane (it was injected) and goes back to the after-turn
    // queue, paused, with CODEX_UNREAD_NOTE and a new id, so the page shows the queue row with the note and Resume really sends it.
    await using lab = await started();
    const chat = await lab.chat('codex');
    const gate = lab.gate();
    await chat.prompt(`steer-drop:${gate}`, 'first');
    await working(chat);
    await chat.steer('did you read this?', 'd-1');
    await until(() => lab.steersReceived(chat).length === 1, 'the steer reached Codex', LONG);
    chat.open(gate); // the turn ends with no output after the injection
    await idle(chat);
    const queue = await until(async () => {
      const q = (await chat.state()).queue as Json;
      return (q.items as Json[]).some((i) => i.text === 'did you read this?') ? q : null;
    }, 'the steer is back in the queue', LONG);
    const item = (queue.items as Json[]).find((i) => i.text === 'did you read this?')!;
    assert(/may not have read this/.test(String(item.note)), `the note: ${JSON.stringify(item)}`);
    assertEquals(queue.paused, true, 'paused: never resent by itself');
    assertEquals(lane(await chat.state()), []);
    assert(!(await chat.agentText()).includes('Steered reply'), 'the agent never answered it');
    await none(800, 'it was sent again by itself', () => lab.promptsReceived(chat).includes('did you read this?'));
    const [status] = await lab.web.post('queue-resume', { id: chat.id });
    assertEquals(status, 200);
    await waitText(chat, 'Fixture reply: did you read this?');
    assertEquals(lab.promptsReceived(chat).filter((t) => t === 'did you read this?').length, 1, 'sent once more, as a prompt');
  },
});

// ---- S8: OMP -----------------------------------------------------------------------------------------------------------------------

Deno.test({
  name: 'S8 [A] OMP O1: the command is backgrounded (details.async), stopReason end_turn is not read as an interrupt, Stop kills it',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('omp');
    const gate = lab.gate();
    await chat.prompt(`steer-bash:${gate}`, 'first');
    const [parent, leaf] = await chat.pids(gate);
    await working(chat);
    await chat.steer('what is 2+2?', 'o-1');
    await waitText(chat, 'Steered reply: what is 2+2?');
    await idle(chat);
    await until(async () => (await backgroundOf(chat, 'toolu_steer_bash'))?.state === 'running', 'running in the background (card completed, then in_progress with details.async)', LONG);
    const ends = await chat.events('turn_end');
    assertEquals(ends.length, 1);
    assertEquals((ends[0].data as Json).stopReason, 'end_turn');
    assert(!/interrupt/i.test(JSON.stringify((await chat.state()).attention)), 'not read as a user interrupt');
    const [status, body] = await chat.stopTool('toolu_steer_bash');
    assertEquals(status, 200, JSON.stringify(body));
    await until(() => !pidAlive(parent) && !pidAlive(leaf), 'the command and its child are gone', LONG);
    await until(async () => (await backgroundOf(chat, 'toolu_steer_bash'))?.state === 'stopped', 'stopped', LONG);
  },
});

// ---- S9-S11: held while an approval card is open (owner decision 5) ----------------------------------------------------------------

for (const who of ['claude', 'omp'] as const) {
  Deno.test({
    name: `S9 [A] ${who}: a message typed while an approval card is open is held (nothing reaches the agent, the card is not cancelled) and sent when the card is answered`,
    ...TEST_OPTIONS,
    async fn() {
      await using lab = await started();
      const chat = await lab.chat(who);
      await chat.prompt('steer-perm', 'first');
      await until(async () => ((await chat.state()).permissions as Json[]).length === 1, 'the approval card', LONG);
      const [status, body] = await chat.steer('also 5+5?', 'p-1');
      assertEquals(status, 200, JSON.stringify(body));
      assertEquals(body.state, 'held');
      const held = lane(await chat.state());
      assertEquals(held.length, 1);
      assertEquals(held[0].state, 'held');
      assertEquals(held[0].heldReason, 'approval');
      assertEquals(held[0].text, 'also 5+5?');
      await none(1500, 'the held message reached the agent', () => lab.steersReceived(chat).length > 0 || lab.promptsReceived(chat).length > 1);
      assertEquals(((await chat.state()).permissions as Json[]).length, 1, 'the card is still open (OMP would have cancelled it on a steer)');
      assert(!chat.received().some((m) => m.method === '$/cancel_request'), 'nothing was withdrawn');
      await answerCard(lab, chat);
      await until(async () => (await chat.agentText()).includes('also 5+5?'), 'the held message was answered', LONG);
      assertEquals(lane(await chat.state()).filter((l) => l.state === 'held').length, 0, 'released');
      assert(!(await chat.agentText()).includes('superseded'), 'the tool was not cancelled by the steer');
      await idle(chat);
    },
  });
}

Deno.test({
  name: 'S10 [A] T23: Interrupt while a message is held moves it to the after-turn queue, paused; nothing is sent',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('claude');
    await chat.prompt('steer-perm', 'first');
    await until(async () => ((await chat.state()).permissions as Json[]).length === 1, 'the approval card', LONG);
    await chat.steer('hold this', 'p-2');
    assertEquals(lane(await chat.state()).length, 1);
    const [status] = await chat.cancel();
    assertEquals(status, 200);
    await idle(chat);
    const st = await chat.state();
    assertEquals(lane(st).length, 0, 'no longer in the steer lane');
    const queue = st.queue as Json;
    assert(JSON.stringify(queue.items).includes('hold this'), 'it is in the after-turn queue');
    assertEquals(queue.paused, true, 'paused: an interrupt never sends by itself');
    await none(1000, 'the held message was sent after Interrupt', () => lab.steersReceived(chat).length > 0 || lab.promptsReceived(chat).includes('hold this'));
  },
});

Deno.test({
  name: 'S11 [A] T24: several held messages leave in the order they were typed, one after the other',
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('claude');
    await chat.prompt('steer-perm', 'first');
    await until(async () => ((await chat.state()).permissions as Json[]).length === 1, 'the approval card', LONG);
    await chat.steer('first held', 'p-3');
    await chat.steer('second held', 'p-4');
    assertEquals(lane(await chat.state()).map((l) => l.text), ['first held', 'second held']);
    await answerCard(lab, chat);
    await until(async () => {
      const text = await chat.agentText();
      return text.includes('first held') && text.includes('second held');
    }, 'both answered', LONG);
    const order = [...lab.steersReceived(chat).map((s) => s.text), ...lab.promptsReceived(chat).slice(1)];
    assertEquals(order.filter((t) => t.endsWith('held')), ['first held', 'second held']);
    await idle(chat);
    assertEquals(lane(await chat.state()), []);
  },
});

// ---- S12: T22 Interrupt leaves a helper's card alone ----------------------------------------------------------------------------------

Deno.test({
  name: "S12 [A] T22: Interrupt withdraws the main agent's cards only; a background helper's approval card stays",
  ...TEST_OPTIONS,
  async fn() {
    // A background helper is one that runs on after the turn that started it (the --held-turn replay of claude-agent-acp: the reply
    // ends, the helper goes on, then asks). A child session asking inside the running turn is part of that turn and goes with it.
    await using lab = await started({ extra: { claude: ['--held-turn'] } });
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    await chat.prompt(`helper-ask:${gate}`, 'first');
    await waitText(chat, 'Started a helper.');
    await idle(chat); // the reply ended; the helper runs on in the background
    chat.open(gate); // the helper asks
    await until(async () => ((await chat.state()).permissions as Json[]).length === 1, "the background helper's approval card", LONG);
    await chat.prompt('steer-perm', 'second'); // a new turn, which asks too
    await until(async () => ((await chat.state()).permissions as Json[]).length === 2, "the main agent's approval card", LONG);
    await chat.cancel();
    await idle(chat);
    await new Promise((r) => setTimeout(r, 1000));
    const left = (await chat.state()).permissions as Json[];
    assertEquals(left.length, 1, "only the main agent's card was withdrawn");
    assertEquals((left[0].params as Json).sessionId, 'helper-1', "the helper's card survived Interrupt");
  },
});

// ---- S13: T27 autonomous cycles are not steerable ----------------------------------------------------------------------------------------

Deno.test({
  name: "S13 [A] T27: during Claude's own follow-up cycle (a command ended) the chat is working but not steerable",
  ...TEST_OPTIONS,
  async fn() {
    await using lab = await started();
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    Deno.writeTextFileSync(gate + '.cycle-hold', 'hold'); // the cycle waits for <gate>.cycle-end so the test can look at it
    await chat.prompt(`steer-bash:${gate}`, 'first');
    await working(chat);
    assertEquals((await chat.state()).steerable, true);
    await chat.steer('what is 2+2?', 's13');
    await idle(chat);
    assertEquals((await chat.state()).steerable, false);
    chat.open(gate); // the command ends: Claude Code starts its own cycle
    await until(async () => (await chat.state()).busy === true, 'the autonomous cycle is working', LONG);
    assertEquals((await chat.state()).steerable, false, 'busy but autonomous: the composer must not offer Send now');
    Deno.writeTextFileSync(gate + '.cycle-end', 'go');
    await idle(chat);
  },
});

// ---- page tests -----------------------------------------------------------------------------------------------------------------------

const pageTest = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !hasBrowser, ...TEST_OPTIONS, fn });

const SEND_NOW = 'Send now';
const AFTER = 'Send after this turn';
const INTERRUPT = 'Interrupt and send';

const HINTS: Record<Who, RegExp> = {
  claude: /Claude Code answers right away\. A command or helper it is running keeps going in the background\./,
  codex: /Codex answers right away\. A command it is running keeps going in the background, and Codex isn't told when it ends\./,
  omp: /OMP answers right away\. A command it is running moves to the background, and OMP stops it after 2 minutes in total\./,
};

for (const who of WHO) {
  pageTest(`P1 [B] ${who}: the composer shows "Send ▾" only while it works; the menu has the three sends and this agent's hint; keyboard works`, async () => {
    await using lab = await started();
    const chat = await lab.chat(who);
    const page = await openPage(lab, chat);
    try {
            assert(await page.eval<boolean>(`![...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`), 'idle composer: no ▾');
      const gate = lab.gate();
      await chat.prompt(`steer-wait:${gate}`, 'first');
      await working(chat);
      await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`, 8000, 'the ▾ while working');
      await page.eval(`document.querySelector('#promptForm .send-more').focus()`); // B wires ↓ on the menu button (Send is disabled while the box is empty) and in the menu, not in the message box
      await page.key('ArrowDown'); // ↓ opens the menu from the keyboard
      await page.waitFor(`document.querySelector('#promptForm [aria-haspopup]')?.getAttribute('aria-expanded') === 'true'`, 4000, 'menu opened by ↓');
      for (const item of [SEND_NOW, AFTER, INTERRUPT]) assert(await visibleByText(page, item), `menu item "${item}"`);
      assert(HINTS[who].test(await page.eval<string>('document.body.innerText')), `the hint of ${who}`);
      await page.key('Escape');
      await page.waitFor(`document.querySelector('#promptForm [aria-haspopup]')?.getAttribute('aria-expanded') !== 'true'`, 4000, 'menu closed by Esc');
      chat.open(gate);
      await idle(chat);
      await page.waitFor(`!([...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }))`, 8000, 'the ▾ is gone when the turn ended');
    } finally {
      await page.close();
    }
  });
}

pageTest('P2 [B] Enter steers (bubble tagged "Sent while working"), Alt+Enter queues after the turn, Shift+Enter is a new line', async () => {
  await using lab = await started();
  const chat = await lab.chat('claude');
  const page = await openPage(lab, chat);
  try {
    const gate = lab.gate();
    await chat.prompt(`steer-wait:${gate}`, 'first');
    await working(chat);
    await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`, 8000, '▾');
    await typeAndSend(page, 'line one', 8); // Shift+Enter: a new line, nothing sent
    // (a synthetic Shift+Enter inserts no newline, so only "does not send" is checked)
    assertEquals(await page.eval<string>(`document.getElementById('prompt').value`), 'line one', 'Shift+Enter left the text in the box');
    assertEquals(lab.steersReceived(chat).length, 0);
    assertEquals(lab.promptsReceived(chat), [`steer-wait:${gate}`]);
    await page.eval(`(() => { const p = document.getElementById('prompt'); p.value = ''; p.dispatchEvent(new Event('input', {bubbles: true})); })()`);
    await typeAndSend(page, 'steer me');
    await waitText(chat, 'Steered reply: steer me');
    await page.waitFor(`/Sent while working/.test(document.getElementById('messages').innerText)`, 8000, 'the "Sent while working" tag');
    await typeAndSend(page, 'later', 1); // Alt+Enter
    await page.waitFor(`/later/.test(document.getElementById('queueBox').innerText)`, 8000, 'the after-turn queue row');
    assertEquals(lab.steersReceived(chat).map((s) => s.text), ['steer me'], '"later" was not injected');
    chat.open(gate);
    await until(() => lab.promptsReceived(chat).includes('later'), 'the queued message after the turn', LONG);
  } finally {
    await page.close();
  }
});

pageTest('P3 [B] an agent that cannot steer: the button still says "Send", "Send now" is greyed out, the hint says why', async () => {
  await using lab = await started({ plain: ['claude'] });
  const chat = await lab.chat('claude');
  const page = await openPage(lab, chat);
  try {
    const gate = lab.gate();
    await chat.prompt(`gate:${gate}`, 'first');
    await working(chat);
    await page.waitFor(`/can.t read messages mid-turn/i.test(document.getElementById('send').title)`, 8000, 'the Send tooltip');
    assertEquals((await page.eval<string>(`document.getElementById('send').innerText.trim()`)).replace(/[▾\s]/g, ''), 'Send');
    if (await page.eval<boolean>(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`)) {
      await page.click('#promptForm [aria-haspopup]');
      assert(
        await page.eval<boolean>(
          `[...document.querySelectorAll('button, [role=menuitem]')].some((e) => /Send now/i.test(e.textContent) && (e.disabled || e.getAttribute('aria-disabled') === 'true'))`,
        ),
        '"Send now" is disabled',
      );
    }
    assert(/Enter sends when it ends/i.test(await page.eval<string>(`document.getElementById('send').title`)), 'the shortcuts in the Send tooltip');
    assert(!(await page.eval<boolean>(`!!document.getElementById('sendKeyHint')`)), 'no key hint row (owner, 2026-11-12)');
    chat.open(gate);
  } finally {
    await page.close();
  }
});

pageTest('P4 [B] owner decision 5: a message typed while a card is open shows a held row, there is no "Deny and send", answering the card sends it', async () => {
  await using lab = await started();
  const chat = await lab.chat('omp');
  const page = await openPage(lab, chat);
  try {
    await chat.prompt('steer-perm', 'first');
    await page.waitFor(`/Allow once/.test(document.body.innerText)`, 15000, 'the approval card');
    await typeAndSend(page, 'hold on');
    await page.waitFor(`/until you answer/i.test(document.body.innerText)`, 8000, 'the held row explains itself');
    assert(!(await page.eval<boolean>(`/Deny and send/i.test(document.body.innerText)`)), 'no "Deny and send" (owner decision 5)');
    assertEquals(lab.steersReceived(chat).length, 0, 'nothing reached OMP, so it did not cancel the card');
    await clickByText(page, 'Allow once');
    await waitText(chat, 'hold on');
    await page.waitFor(`!/until you answer/i.test(document.body.innerText)`, 8000, 'the held row is gone');
  } finally {
    await page.close();
  }
});

// QA beta.9: the page chose its route from its last poll (up to 1.5 s old). Typed right after a turn began (here: the approval card's
// turn, started without the page), it saw the chat idle, posted a prompt and the server refused it ("Wait for the current turn...",
// the draft kept, no held row): 6 of 8 tries before the fix. Each try types 0-300 ms after the card opened, before the page polls.
for (const [who, tries] of [['claude', 20], ['omp', 10]] as const) {
  pageTest(`P4b [B] ${who}: typed right after an approval card opened (the page has not polled since), the message is held every time (${tries} tries)`, async () => {
    await using lab = await started();
    const chat = await lab.chat(who);
    const page = await openPage(lab, chat);
    try {
      for (let i = 0; i < tries; i++) {
        await chat.prompt('steer-perm', `card-${i}`);
        await until(async () => ((await chat.state()).permissions as Json[]).length === 1, 'the approval card', LONG);
        await new Promise((r) => setTimeout(r, (i % 4) * 100));
        await typeAndSend(page, `held ${i}`);
        await until(async () => lane(await chat.state()).some((l) => l.text === `held ${i}` && l.state === 'held'), `try ${i}: "held ${i}" is held`, 15);
        await page.waitFor(`/until you answer/i.test(document.body.innerText)`, 8000, `try ${i}: the held row`);
        assert(!(await page.eval<boolean>(`!document.getElementById('error').hidden && /Wait for the current turn/.test(document.getElementById('error').textContent)`)), `try ${i}: no refusal`);
        await page.waitFor(`document.getElementById('prompt').value === ''`, 8000, `try ${i}: the box is cleared`);
        await answerCard(lab, chat);
        await waitText(chat, `held ${i}`);
        await idle(chat);
      }
      assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
    } finally {
      await page.close();
    }
  });
}

for (const who of WHO) {
  pageTest(`P5 [B] ${who}: after a steer the command row says "Still running in the background" with a Stop button; Stop kills it`, async () => {
    await using lab = await started();
    const chat = await lab.chat(who);
    const page = await openPage(lab, chat);
    try {
      const gate = lab.gate();
      await chat.prompt(`steer-bash:${gate}`, 'first');
      const [parent, leaf] = await chat.pids(gate);
      await working(chat);
      await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`, 8000, '▾');
      await typeAndSend(page, 'what is 2+2?');
      await page.waitFor(`/Still running in the background/i.test(document.getElementById('messages').innerText)`, 15000, 'the background pill');
      assert(!(await page.eval<boolean>(`/Stopped by your message/i.test(document.body.innerText)`)), 'the same wording for all three agents');
      await clickByText(page, '^Stop$', `document.getElementById('messages')`);
      await until(() => !pidAlive(parent) && !pidAlive(leaf), 'the command is gone', LONG);
      await page.waitFor(`!/Still running in the background/i.test(document.getElementById('messages').innerText)`, 15000, 'the pill changed');
    } finally {
      await page.close();
    }
  });
}

pageTest('P6 [B] T18: the steered bubble and its "Sent while working" tag are still there after the page is reloaded', async () => {
  await using lab = await started();
  const chat = await lab.chat('claude');
  const page = await openPage(lab, chat);
  try {
    const gate = lab.gate();
    await chat.prompt(`steer-wait:${gate}`, 'first');
    await working(chat);
    await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`, 8000, '▾');
    await typeAndSend(page, 'remember me');
    await waitText(chat, 'Steered reply: remember me');
    chat.open(gate);
    await idle(chat);
    await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
    await page.click(`button.connection[data-key="claude:${chat.sessionId}"]`);
    await page.waitFor(`document.getElementById('messages').innerText.includes('remember me')`, 15000, 'the bubble after a reload');
    // (the agent's "Steered reply: remember me" names it too: count the user's own bubbles)
    const mine = await page.eval<string[]>(
      `[...document.querySelectorAll('#messages .bubble.user')].map((b) => b.innerText).filter((t) => t.includes('remember me'))`,
    );
    assertEquals(mine.length, 1, `once: ${JSON.stringify(mine)}`);
    assert(/Sent while working/.test(mine[0]), 'the tag survives');
  } finally {
    await page.close();
  }
});

pageTest('P7 [B] a queued message\'s ↑ button says "Interrupt and send"', async () => {
  await using lab = await started();
  const chat = await lab.chat('claude');
  const page = await openPage(lab, chat);
  try {
    const gate = lab.gate();
    await chat.prompt(`steer-wait:${gate}`, 'first');
    await working(chat);
    await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`, 8000, '▾');
    await typeAndSend(page, 'queued one', 1); // Alt+Enter
    await page.waitFor(`/queued one/.test(document.getElementById('queueBox').innerText)`, 8000, 'the queue row');
    assert(
      await page.eval<boolean>(
        `[...document.querySelectorAll('#queueBox button')].some((b) => /Interrupt and send/i.test(b.title + ' ' + (b.getAttribute('aria-label') || '')))`,
      ),
      'tooltip "Interrupt and send"',
    );
    chat.open(gate);
  } finally {
    await page.close();
  }
});

pageTest("P8 [A+B] T27: in Claude's own follow-up cycle the composer is the plain Send (no ▾)", async () => {
  await using lab = await started();
  const chat = await lab.chat('claude');
  const page = await openPage(lab, chat);
  try {
    const gate = lab.gate();
    Deno.writeTextFileSync(gate + '.cycle-hold', 'hold');
    await chat.prompt(`steer-bash:${gate}`, 'first');
    await working(chat);
    await chat.steer('what is 2+2?', 'p8');
    await idle(chat);
    chat.open(gate);
    await until(async () => (await chat.state()).busy === true, 'the autonomous cycle', LONG);
    await page.waitFor(`!([...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }))`, 8000, 'no ▾ while the cycle runs');
    Deno.writeTextFileSync(gate + '.cycle-end', 'go');
    await idle(chat);
  } finally {
    await page.close();
  }
});

// Owner decision: the inbox and phone quick replies the user types steer a working chat, like the composer's Enter (AIB's own merge and
// doc sends do not: S14). The inbox row's send is driven through its own code path (workspace-ui.js sendQuick → chat.js quickPrompt →
// inbox-reply.js sendRoute) by the test hook AgentWorkspaceUI._sendQuick: a working chat has no "your turn" row to type into.
pageTest('P9 [B] owner decision: a quick reply typed in the inbox steers a working chat (shown once, "Sent while working"); idle, it is a prompt', async () => {
  await using lab = await started();
  const open = await lab.chat('codex'); // another chat is open on the page (the fake's sessions share one id: another provider)
  const target = await lab.chat('claude');
  const page = await openPage(lab, open);
  try {
    const gate = lab.gate();
    await target.prompt(`steer-wait:${gate}`, 'first');
    await working(target);
    const key = `claude:${target.sessionId}`;
    await page.waitFor(`!!window.AgentWorkspaceUI?._sendQuick`, 8000, 'the inbox');
    const sent = await page.eval<Json>(`window.AgentWorkspaceUI._sendQuick(${JSON.stringify(key)}, 'from the inbox')`);
    assertEquals(sent.error, '', JSON.stringify(sent));
    assertEquals(sent.queued, false, 'not put in the after-turn queue');
    await waitText(target, 'Steered reply: from the inbox');
    assertEquals(lab.steersReceived(target).map((m) => m.text), ['from the inbox'], 'it went in during the turn');
    assertEquals(lab.promptsReceived(target), [`steer-wait:${gate}`]);
    const bubbles = await userEvents(target, 'from the inbox');
    assertEquals(bubbles.length, 1);
    assertEquals((bubbles[0].data as Json).steered, true);
    target.open(gate);
    await idle(target);
    await page.eval(`window.AgentWorkspaceUI._sendQuick(${JSON.stringify(key)}, 'and now idle')`);
    await waitText(target, 'Fixture reply: and now idle');
    assertEquals(lab.steersReceived(target).length, 1, 'idle: an ordinary prompt');
  } finally {
    await page.close();
  }
});

// ---- S14: T25, AIB's own sends wait for the turn end ----------------------------------------------------------------------------------

Deno.test({
  name: "S14 [A] T25: AIB's own sends (the Merge button's message, a doc comment sent to the chat) wait for the turn to end on a chat that can steer",
  ...TEST_OPTIONS,
  async fn() {
    // merge.ts requestMerge and docs_routes.ts sendComment call the live op `queue` (their unit tests, worktree_merge_request_test.ts
    // and docs_comments_test.ts, pin that op); here: that op, with their message ids, never steers a working, steerable chat.
    await using lab = await started();
    const chat = await lab.chat('claude');
    const gate = lab.gate();
    await chat.prompt(`steer-wait:${gate}`, 'first');
    await working(chat);
    assertEquals((await chat.state()).steerable, true);
    for (const [text, clientMessageId] of [['please merge', 'merge-request-t25'], ['a doc comment', 'doc-comment-d1-t1-0']]) {
      const [status, body] = await chat.queue(text, clientMessageId);
      assertEquals(status, 200, JSON.stringify(body));
    }
    await none(1500, 'an AIB send went in during the turn', () => lab.steersReceived(chat).length > 0 || lab.promptsReceived(chat).length > 1);
    assertEquals(lane(await chat.state()), []);
    chat.open(gate);
    await until(() => ['please merge', 'a doc comment'].every((t) => lab.promptsReceived(chat).includes(t)), 'both sent after the turn', LONG);
    assertEquals(lab.steersReceived(chat).length, 0);
    for (const text of ['please merge', 'a doc comment']) {
      assertEquals((await userEvents(chat, text)).filter((e) => (e.data as Json).steered).length, 0, `${text}: not tagged as steered`);
    }
  },
});
