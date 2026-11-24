/**
 * Stop and Send now never stop a chat's background subagents (owner, 2026-11-16, beta12) (the port of
 * work/test_subagent_cancel_e2e.py): Send now on a queued message interrupted the lead, and AIB then said its background subagent
 * "was stopped before it finished" and did not merge it.
 *
 * e2e with the REAL Claude Code adapter against the stub model API (work/stub_model_api.js script mode), temp config and temp dirs
 * only (the Aib harness of e2e_subagent_landing_test.ts, here in _e2e_real.ts):
 *
 *   test_stop_keeps_background_subagent      the lead launches a background editing subagent (run_in_background, its own AIB worktree),
 *                                            then runs a long foreground command; the user presses Stop. The lead's turn ends
 *                                            cancelled; the subagent goes on, finishes and lands as one "AIB: subagent ..." commit.
 *   test_send_now_steers_and_backgrounds     same start; the user queues a message and presses Send now on it. No cancel: Claude Code
 *                                            moves the running command to the background (it finishes and writes its file), the lead
 *                                            reads the message in the same turn, and the subagent lands.
 *
 * Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names
 * a built one). Heavy: run it alone, with TEMP/TMP pointed at a scratch folder.
 */
import { assert, assertEquals, isFile, Json, sleep, waitFor } from './_e2e.ts';
import {
  agentCall,
  Aib,
  approveAll,
  bash,
  CLAUDE_ACP,
  dumped,
  gitLog,
  HAVE_KEEPER_BIN,
  join,
  NODE_EXE,
  notes,
  SERVER_SPLIT,
  stubText,
  subagentRecords,
  T,
  uuid,
} from './_e2e_real.ts';
import type { Chat } from './_e2e.ts';

const ok = !!(NODE_EXE && CLAUDE_ACP && HAVE_KEEPER_BIN && SERVER_SPLIT);

async function updates(chat: Chat): Promise<string> {
  return JSON.stringify((await chat.state()).events.filter((e) => e.kind === 'update'));
}
async function turnEnds(chat: Chat): Promise<unknown[]> {
  return (await chat.state()).events.filter((e) => e.kind === 'turn_end').map((e) => e.data.stopReason);
}
function subState(aib: Aib, description: string): unknown {
  const found = Object.values(subagentRecords(aib.fx.state)).filter((r) => r.description === description);
  return found.length ? found[0].state : null;
}

/** Send `text`; wait until the background subagent runs and the lead's foreground command is running. */
async function start(aib: Aib, text: string, parentTool: string): Promise<void> {
  const chat = aib.chat;
  const [code] = await aib.web.post('prompt', { id: chat.id, text, clientMessageId: uuid() });
  assertEquals(code, 200);
  const running = async () => {
    await approveAll(chat);
    const state = await chat.state();
    const seen = await updates(chat);
    // its Bash call started and has not ended (a refused command ends at once)
    const ended = state.events.some((e) => {
      if (e.kind !== 'update') return false;
      const update = ((e.data as Json).update ?? {}) as Json;
      return update.toolCallId === parentTool && ['completed', 'failed'].includes(String(update.status));
    });
    return state.busy && !(state.permissions as unknown[]).length && seen.includes(parentTool) && !ended;
  };
  try {
    await waitFor(running, "the lead's long command to run", 120);
  } catch (error) {
    const state = await chat.state();
    console.error('STATE busy', state.busy, 'permissions', JSON.stringify(state.permissions).slice(0, 2000));
    console.error('STUB LOG', stubText(aib.stub).slice(-6000));
    console.error('EVENTS', JSON.stringify(state.events).slice(-8000));
    throw error;
  }
  await sleep(1500); // the command is really running (its approval was just answered)
  await approveAll(chat);
}

async function landed(aib: Aib, description: string): Promise<void> {
  await aib.wait(`the background subagent ${JSON.stringify(description)} to land`, () => gitLog(aib.project).includes(`AIB: subagent ${description}`), 180);
  assertEquals((await notes(aib.chat)).filter((n) => n.includes('was stopped before it finished')), [], JSON.stringify(await notes(aib.chat)));
}

Deno.test({
  name: 'SubagentSurvivesStopTest test_stop_keeps_background_subagent',
  ignore: !ok,
  ...T,
  async fn() {
    const rules = [
      { when: 'SC-STOP', reply: { tools: [agentCall('toolu_pS1', 'sc background', 'SUBTASK-S: do the work', true)] } },
      { when: 'SUBTASK-S', reply: { tools: [bash('toolu_sS1', 'for i in $(seq 1 10); do sleep 1; done; echo from-bg > sub-s.txt')] } },
      { when: 'toolu_sS1', reply: { text: 'SUB-S-DONE' } },
      { when: 'toolu_pS1', reply: { tools: [bash('toolu_pS2', 'for i in $(seq 1 40); do echo tick $i; sleep 1; done; echo parent-slept')] } },
    ];
    await using aib = await Aib.start(rules);
    const chat = aib.chat;
    await start(aib, 'SC-STOP go', 'toolu_pS2');
    assertEquals(subState(aib, 'sc background'), 'running', 'the subagent must still run when the user stops the turn');
    const [code] = await aib.web.post('cancel', { id: chat.id });
    assertEquals(code, 200);
    try {
      await aib.wait('the turn to end cancelled', async () => (await turnEnds(chat)).includes('cancelled'));
    } catch (error) {
      const state = await chat.state();
      console.error('BUSY', state.busy, 'TURN_ENDS', await turnEnds(chat), 'RECORDS', JSON.stringify(subagentRecords(aib.fx.state)).slice(0, 3000));
      console.error('STUB LOG', stubText(aib.stub).slice(-5000));
      console.error('EVENTS', JSON.stringify(state.events.filter((e) => e.kind !== 'update')).slice(-5000));
      throw error;
    }
    await sleep(1000);
    assertEquals(subState(aib, 'sc background'), 'running', 'Stop must not stop a background subagent');
    await landed(aib, 'sc background');
    assertEquals(Deno.readTextFileSync(join(aib.project, 'sub-s.txt')).trim(), 'from-bg');
    assert(dumped(aib.stub).includes('SUB-S-DONE'), 'the subagent finished its work');
  },
});

Deno.test({
  name: 'SubagentSurvivesStopTest test_send_now_steers_and_backgrounds',
  ignore: !ok,
  ...T,
  async fn() {
    const rules = [
      { when: 'SN-NOW read this', in: 'any', reply: { text: 'LEAD-READ-IT' } },
      { when: 'SN-GO', reply: { tools: [agentCall('toolu_pN1', 'sn background', 'SUBTASK-N: do the work', true)] } },
      { when: 'SUBTASK-N', reply: { tools: [bash('toolu_sN1', 'for i in $(seq 1 10); do sleep 1; done; echo from-bg > sub-n.txt')] } },
      { when: 'toolu_sN1', reply: { text: 'SUB-N-DONE' } },
      { when: 'toolu_pN1', reply: { tools: [bash('toolu_pN2', 'for i in $(seq 1 12); do echo tick $i; sleep 1; done; echo fg-finished > fg.txt')] } },
    ];
    await using aib = await Aib.start(rules);
    const chat = aib.chat;
    const p = aib.project;
    await start(aib, 'SN-GO go', 'toolu_pN2');
    const msg = uuid();
    let [code, queued] = await aib.web.post('queue', { id: chat.id, text: 'SN-NOW read this', clientMessageId: msg });
    assertEquals(code, 200, JSON.stringify(queued));
    let sent: Json;
    [code, sent] = await aib.web.post('queue-send-now', { id: chat.id, messageId: msg });
    assertEquals(code, 200, JSON.stringify(sent));
    assert(sent.steered, JSON.stringify(sent));
    await aib.wait('the lead to read the message mid-turn', async () => (await updates(chat)).includes('LEAD-READ-IT'), 120);
    assert(!(await turnEnds(chat)).includes('cancelled'), 'Send now must not stop the turn');
    const sentToModel = dumped(aib.stub);
    assert(sentToModel.includes('moved to the background'), 'Claude Code moves the running command to the background');
    assert(sentToModel.includes('it was not interrupted'));
    await aib.wait('the backgrounded command to finish', () => isFile(join(p, 'fg.txt')), 60);
    assertEquals(Deno.readTextFileSync(join(p, 'fg.txt')).trim(), 'fg-finished');
    await landed(aib, 'sn background');
    assertEquals(Deno.readTextFileSync(join(p, 'sub-n.txt')).trim(), 'from-bg');
    assert(!(await turnEnds(chat)).includes('cancelled'));
  },
});
