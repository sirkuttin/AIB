/**
 * Antigravity subagents (subagents/antigravity.ts). Owner rule: an agent's own subagent that edits files works in its own worktree.
 * `agy acp` gives AIB no hook or fence for its subagents, so AIB cannot enforce it: the rule is ASKED for in the chat's instructions
 * (the ACP system prompt when `agy` advertises one, else a one-time <studio-context> line in front of the next prompt) and the chat
 * says so up front. Fake ACP agent only (work/fake_acp.py, with and without the system prompt capability); temp repos and temp state.
 *
 *   - enforced: nothing (no worktree is made for an Antigravity subagent);
 *   - asked for: the rule text reaches the agent, on session/new and session/load, once per opening in the fallback;
 *   - other agents are untouched (no rule, no note).
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, until } from './_connection.ts';
import { withEnv } from './_agents.ts';
import { Sandbox } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { ANTIGRAVITY_SUBAGENT_NOTE, ANTIGRAVITY_SUBAGENT_PROMPT } from '../../app/server/subagents/antigravity.ts';
import { join } from '../../app/server/platform/ospath.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };

class Host {
  readonly box = new Sandbox();
  readonly log = join(this.box.base, 'agent.log');
  readonly aibs: Aib[] = [];
  readonly #restore = withEnv({ FAKE_ACP_LOG: this.log });

  aib(flags: string[]): Aib {
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.box.state, port: 0 });
    aib.ownerProbe = () => null;
    aib.settings.worktreePerChat = () => false; // in the project folder: what an Antigravity chat does
    aib.agentLaunch = () => Promise.resolve([['fixture'], {}]);
    aib.connectionFactory = (_command, cwd, provider, options) => new Connection(fake(...flags), cwd, provider, options);
    this.aibs.push(aib);
    return aib;
  }

  /** The params of every `method` call the agent received, in order. */
  received(method: string): Json[] {
    let text = '';
    try {
      text = Deno.readTextFileSync(this.log);
    } catch { /* nothing yet */ }
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === method).map((m) => m.params);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
    this.#restore();
    this.box[Symbol.dispose]();
  }
}

const systemTexts = (params: Json) => (((params.systemPrompt as Json | undefined)?.content ?? []) as Json[]).map((x) => String(x.text));
const promptTexts = (params: Json) => ((params.prompt ?? []) as Json[]).map((x) => String(x.text ?? ''));
const notes = (c: Connection) =>
  c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));

Deno.test({
  name: 'Antigravity subagents: an agent with a system prompt is told the rule on session/new and session/load; the chat says it is a request',
  ...T,
  async fn() {
    await using host = new Host();
    const p = host.box.project;
    const aib = host.aib(['--extra-dirs', '--rich']);
    const c = await aib.connect('antigravity', p, null, {});
    await until(() => c.ready, 'the chat is ready', 30);
    assertEquals(c.worktree, null, 'no worktree is made: AIB cannot hold its subagents in one');
    const made = host.received('session/new');
    assertEquals(made.length, 1);
    assert(systemTexts(made[0]).includes(ANTIGRAVITY_SUBAGENT_PROMPT), JSON.stringify(systemTexts(made[0])));
    assertEquals(notes(c), [ANTIGRAVITY_SUBAGENT_NOTE], 'said up front, once');
    assert(/request, not a guarantee/.test(ANTIGRAVITY_SUBAGENT_NOTE), 'what is not enforced is said');
    // the rule is in the instructions, so the prompt carries no extra block
    await c.prompt('hello there');
    await until(() => !c.busy && host.received('session/prompt').length === 1, 'the prompt');
    assertEquals(promptTexts(host.received('session/prompt')[0]), ['hello there']);
    const sessionId = c.sessionId!;
    await aib.close();

    const again = host.aib(['--extra-dirs', '--rich']);
    const reopened = await again.connect('antigravity', p, sessionId);
    await until(() => reopened.ready, 'the chat is reopened', 30);
    const loaded = host.received('session/load');
    assertEquals(loaded.length, 1);
    assert(systemTexts(loaded[0]).includes(ANTIGRAVITY_SUBAGENT_PROMPT), 'session/load carries it too');
    assert(!notes(reopened).includes(ANTIGRAVITY_SUBAGENT_NOTE), 'a reopened chat does not repeat the note');
  },
});

Deno.test({
  name: 'Antigravity subagents: an agent without a system prompt gets the rule once, in front of its next prompt, not in the user message',
  ...T,
  async fn() {
    await using host = new Host();
    const p = host.box.project;
    const aib = host.aib(['--rich']);
    const c = await aib.connect('antigravity', p, null, {});
    await until(() => c.ready, 'the chat is ready', 30);
    assert(!('systemPrompt' in host.received('session/new')[0]), 'nothing to carry a system prompt');
    await c.prompt('first question');
    await until(() => !c.busy && host.received('session/prompt').length === 1, 'the first prompt');
    const first = promptTexts(host.received('session/prompt')[0]);
    assertEquals(first.length, 2);
    assertEquals(first[0], `<studio-context>${ANTIGRAVITY_SUBAGENT_PROMPT}</studio-context>`);
    assertEquals(first[1], 'first question', "the user's own text is untouched");
    await c.prompt('second question');
    await until(() => !c.busy && host.received('session/prompt').length === 2, 'the second prompt');
    assertEquals(promptTexts(host.received('session/prompt')[1]), ['second question'], 'said once');
    assertEquals(notes(c), [ANTIGRAVITY_SUBAGENT_NOTE]);
    // the user's message in the chat is what was typed (the rule is kept out of the event)
    const user = c.events.filter((e) => e.kind === 'user').map((e) => String((e.data as Json).text));
    assertEquals(user, ['first question', 'second question']);
  },
});

Deno.test({
  name: 'Antigravity subagents: other agents get no rule and no note',
  ...T,
  async fn() {
    await using host = new Host();
    const aib = host.aib(['--extra-dirs', '--rich']);
    const c = await aib.connect('claude', host.box.project, null, {});
    await until(() => c.ready, 'the chat is ready', 30);
    assert(!systemTexts(host.received('session/new')[0]).includes(ANTIGRAVITY_SUBAGENT_PROMPT));
    assert(!notes(c).includes(ANTIGRAVITY_SUBAGENT_NOTE));
    assertEquals(c.subagentRule, '');
  },
});
