/**
 * OMP is no longer an AIB agent (owner decision 2026-11-23). Its saved chats (ids `omp:...`) stay as read-only history:
 *   - OMP is in no agent list (Settings rows, New chat on the PC and the phone) and a default agent of omp falls back cleanly;
 *   - the server never starts an OMP adapter: connect, launch, Continue and the phone's Continue all refuse with one plain line;
 *   - Rename, Archive and Delete (the conversation marks) keep working on an omp chat.
 * Temp folders only; never the real OMP install or ~/.omp.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { SettingsStore } from '../../app/server/state/settings.ts';
import { ConversationState } from '../../app/server/state/conversations.ts';
import * as agentRegistry from '../../app/server/agents/agent_registry.ts';
import { BUILTIN_AGENTS, eligibleAgents } from '../../app/server/agents/eligibility.ts';
import { describeAgents } from '../../app/server/web/shared.ts';
import { continueSaved, publicSaved } from '../../app/server/remote/saved.ts';
import { defaultAgent } from '../../app/server/remote/newchat.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const NOTE = 'OMP is no longer supported in AIB. This chat is read-only.';
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

function tempDir(): { dir: string; [Symbol.dispose](): void } {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-omp-retired-' }));
  return {
    dir,
    [Symbol.dispose]() {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* a handle still open: the OS temp cleanup takes it */ }
    },
  };
}

Deno.test('the registry: OMP is not built in, but a saved omp chat is still a known provider', () => {
  assertEquals([...agentRegistry.BUILTIN_IDS], ['claude', 'codex']);
  assert(!agentRegistry.isBuiltin('omp'));
  assert(agentRegistry.isRetired('omp') && !agentRegistry.isRetired('claude'));
  assert(agentRegistry.isProvider('omp'), 'history operations still accept it');
  assert(!agentRegistry.isChoosable('omp') && agentRegistry.isChoosable('claude'));
  assertEquals(agentRegistry.agentName('omp'), 'OMP');
  assertEquals(agentRegistry.RETIRED_NOTE, NOTE);
});

Deno.test('New chat on the phone: OMP is not offered, and a row for it in an old list is ignored', () => {
  assertEquals(BUILTIN_AGENTS.map((a) => a.id), ['claude', 'codex']);
  const agents = eligibleAgents([{ id: 'omp', enabled: true, found: true }, { id: 'claude', enabled: true, found: true }]);
  assert(!agents.some((a) => a.id === 'omp'), JSON.stringify(agents));
  assertEquals(agents.map((a) => a.id).slice(0, 2), ['claude', 'codex']);
});

Deno.test('Settings: the agent rows have no OMP card and no OMP install entry', async () => {
  using t = tempDir();
  const rows = await describeAgents({ stateDir: t.dir, nodeCommand: 'node', claudeLauncher: '', codexLauncher: '' }, new SettingsStore(t.dir));
  assert(!rows.some((r) => r.id === 'omp'), 'no OMP card');
  assertEquals(rows.slice(0, 2).map((r) => r.id), ['claude', 'codex']);
});

Deno.test('a saved default agent of omp falls back to Claude Code, with no error and no OMP left in the settings', async () => {
  using t = tempDir();
  const file = t.dir + SEP + 'studio-settings.json';
  const project = 'w:c:/work/shop';
  Deno.writeTextFileSync(
    file,
    JSON.stringify({
      version: 1,
      agents: { builtin: { omp: false, claude: true, codex: true }, custom: [] },
      defaults: {
        agent: 'omp',
        byAgent: { omp: { model: 'x', mode: 'y' }, claude: { model: 'opus', mode: '' } },
        projects: { [project]: { agent: 'omp', model: 'm', mode: '' } },
        migrated: true,
      },
      agentsByDistro: { ubuntu: { omp: false, codex: false } },
    }),
  );
  const store = new SettingsStore(t.dir);
  const settings = store.public().settings as Json;
  const defaults = settings.defaults as Json;
  assertEquals(defaults.agent, '', 'no default agent: New chat starts with the first agent, Claude Code');
  assertEquals(Object.keys(defaults.byAgent as Json), ['claude']);
  assertEquals(((defaults.projects as Json)[project] as Json | undefined)?.agent ?? '', '');
  assert(!JSON.stringify(settings).includes('"omp"'), 'no omp key anywhere in the loaded settings');
  assert(!('omp' in ((settings.agents as Json).builtin as Json)));
  assertEquals(store.builtinEnabled('claude'), true);
  // the phone's New chat picks Claude Code (the first agent that can start a chat)
  const ctx = { settings: store, viewPrefs: { public: () => ({ prefs: { 'studio-new-chat-agent': 'omp' } }) } } as never;
  const agents = eligibleAgents([{ id: 'claude', enabled: true, found: true }, { id: 'codex', enabled: true, found: true }]);
  assertEquals(defaultAgent(ctx, 'C:\\work\\shop', agents), 'claude');
  // writing OMP as a default is refused, other changes still work
  await assertRejects(() => store.update({ defaults: { agent: 'omp' } }));
  await store.update({ defaults: { agent: 'codex' } });
  assertEquals(((store.public().settings as Json).defaults as Json).agent, 'codex');
});

Deno.test({
  name: 'the server refuses to start OMP: connect, a new chat, a reopen and the launch line, with one plain note',
  ...T,
  async fn() {
    using t = tempDir();
    const studio = new Aib({ stateDir: t.dir + SEP + 'state', port: 0, claudeLauncher: import.meta.filename!, nodeCommand: 'node' });
    studio.ownerProbe = () => null;
    let started = 0;
    studio.connectionFactory = () => {
      started++;
      throw new Error('an adapter must never start for OMP');
    };
    try {
      for (const resume of [null, 'old-session']) {
        const error = await assertRejects(() => studio.connect('omp', t.dir, resume, { background: true }));
        assertEquals((error as Error).message, NOTE);
      }
      assertEquals(((await assertRejects(() => studio.agentLaunch('omp', false))) as Error).message, NOTE);
      assertEquals(((await assertRejects(() => studio.agentLaunch('omp', true))) as Error).message, NOTE);
      // the route: a refusal the page shows, never a start
      const [status, body] = await studio.liveCall('connect', { provider: 'omp', cwd: t.dir, resume: 'old-session', background: true });
      assert(status >= 400 && status < 500, String(status));
      assertEquals((body as Json).error, NOTE);
      // no model lists are asked of it either
      await assertRejects(() => studio.agentOptionsFor({ agent: 'omp', cwd: t.dir, probe: true }));
      assertEquals(started, 0, 'no adapter was started');
      assertEquals([...studio.connections.values()].length, 0);
    } finally {
      await studio.close().catch(() => {});
    }
  },
});

Deno.test('the phone: an omp chat in the saved list is read-only and Continue is refused (the PC would refuse too)', async () => {
  const entry = {
    key: 'omp:s1',
    provider: 'omp',
    sessionId: 's1',
    cwd: 'C:\\work\\shop',
    transcript: '',
    title: 'Old chat',
    agent: 'OMP',
    folder: 'shop',
    lastActive: '',
    readOnly: true,
  };
  const shown = publicSaved(entry) as unknown as Json;
  assertEquals([shown.readOnly, shown.note], [true, NOTE]);
  const calls: string[] = [];
  const ctx = { host: { liveCall: (name: string) => (calls.push(name), Promise.resolve([200, { id: 'x' }])) } } as never;
  const result = await continueSaved(ctx, entry as never);
  assertEquals([result.status, result.code, result.error], [409, 'read_only', NOTE]);
  assertEquals(calls, [], 'nothing was sent to the host');
  // a Claude Code chat is not marked
  const claude = publicSaved({ ...entry, provider: 'claude', readOnly: undefined } as never) as unknown as Json;
  assert(!('readOnly' in claude));
});

Deno.test('Rename, Archive and Delete keep working on an omp chat (the conversation marks)', async () => {
  using t = tempDir();
  const marks = new ConversationState(t.dir);
  await marks.apply('pin', 'omp', 's1', 'My old OMP chat');
  await marks.apply('archive', 'omp', 's1');
  let entry = marks.public().entries['omp:s1'] as unknown as Json;
  assert(entry.archivedAt, 'archived');
  await marks.apply('unarchive', 'omp', 's1');
  await marks.apply('delete', 'omp', 's1');
  entry = marks.public().entries['omp:s1'] as unknown as Json;
  assert(entry.deletedAt, 'deleted (a mark: the chat itself is never erased)');
  await marks.apply('restore', 'omp', 's1');
  assert(!(marks.public().entries['omp:s1'] as unknown as Json | undefined)?.deletedAt, 'restored');
});
