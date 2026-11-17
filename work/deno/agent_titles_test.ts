/** server/host/agent_titles.ts: a name given in AIB goes to the agent when the chat is idle, waits while a turn runs, newest wins. */
import { assertEquals } from './_assert.ts';
import { AgentTitles, type TitleChat } from '../../outputs/agent-studio/server/host/agent_titles.ts';

function setup() {
  const chat: TitleChat & {
    busy: boolean;
    autonomous: boolean;
    closed: boolean;
  } = { busy: false, autonomous: false, closed: false, cwd: 'C:\\p' };
  const calls: string[] = [];
  let live: TitleChat | null = chat;
  let fail: (() => Error) | null = null;
  const titles = new AgentTitles({
    live: () => live,
    rename: (provider, sessionId, title, cwd) => {
      calls.push(`${provider}:${sessionId}=${title}@${cwd}`);
      if (fail) {
        const f = fail;
        fail = null;
        return Promise.reject(f());
      }
      return Promise.resolve(true);
    },
  });
  return {
    chat,
    calls,
    titles,
    gone: () => (live = null),
    failOnce: (f: () => Error) => (fail = f),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test('an idle chat is named at once, in its own folder', async () => {
  const t = setup();
  assertEquals(
    t.titles.request(
      'claude',
      's1',
      '  Ashborne   orchestrator part3 ',
      'D:\\other',
    ),
    true,
  );
  await tick();
  assertEquals(t.calls, ['claude:s1=Ashborne orchestrator part3@C:\\p']);
  assertEquals(t.titles.waiting(), []);
  t.titles.stop();
});

Deno.test('a running turn: the name waits for the turn end, and only the newest goes', async () => {
  const t = setup();
  t.chat.busy = true;
  t.titles.request('claude', 's1', 'first');
  t.titles.request('claude', 's1', 'second');
  await tick();
  assertEquals(t.calls, [], 'never while a turn runs');
  assertEquals(t.titles.waiting(), ['claude:s1']);
  t.chat.busy = false;
  t.chat.autonomous = true; // Claude Code's own cycle counts as a turn too
  t.titles.turnEnded('claude', 's1');
  await tick();
  assertEquals(t.calls, []);
  t.chat.autonomous = false;
  t.titles.turnEnded('claude', 's1');
  await tick();
  assertEquals(t.calls, ['claude:s1=second@C:\\p']);
  assertEquals(t.titles.waiting(), []);
  t.titles.stop();
});

Deno.test('a chat AIB does not run uses the folder it was given; cleared names, drafts and other agents change nothing', async () => {
  const t = setup();
  t.gone();
  assertEquals(
    t.titles.request('claude', 's2', 'name', 'wsl:Ubuntu:/home/me/p'),
    true,
  );
  assertEquals(t.titles.request('claude', 's3', '   '), false);
  assertEquals(t.titles.request('gemini', 's4', 'name'), false);
  assertEquals(t.titles.request('claude', '', 'name'), false);
  await tick();
  assertEquals(t.calls, ['claude:s2=name@wsl:Ubuntu:/home/me/p']);
  t.titles.stop();
});

Deno.test('no transcript yet (-32002): the name goes at a later turn end', async () => {
  const t = setup();
  t.failOnce(() => Object.assign(new Error('Session not found'), { code: -32002 }));
  t.titles.request('codex', 's5', 'later');
  await tick();
  await tick();
  assertEquals(t.titles.waiting(), ['codex:s5']);
  t.titles.turnEnded('codex', 's5');
  await tick();
  assertEquals(t.calls, ['codex:s5=later@C:\\p', 'codex:s5=later@C:\\p']);
  assertEquals(t.titles.waiting(), []);
  assertEquals(t.titles.done.at(-1), {
    key: 'codex:s5',
    title: 'later',
    ok: true,
    reason: '',
  });
  t.titles.stop();
});

Deno.test('another failure is dropped, not retried', async () => {
  const t = setup();
  t.failOnce(() => new Error('broken'));
  t.titles.request('claude', 's6', 'x');
  await tick();
  await tick();
  assertEquals(t.titles.waiting(), []);
  assertEquals(t.titles.done.at(-1), {
    key: 'claude:s6',
    title: 'x',
    ok: false,
    reason: 'broken',
  });
  t.titles.stop();
});
