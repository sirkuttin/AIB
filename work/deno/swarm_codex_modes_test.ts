/**
 * Codex's edit-in-workspace mode follows what the adapter offers (server/swarm/rules.ts WORKSPACE_MODE preference list,
 * server/agents/mode_ids.ts). codex-acp 2.6.0 renamed `auto` to `workspace-write`: a helper starts in whichever of the two the agent
 * offers, never in a broader mode, and is refused with the offered modes named when neither is there. A saved New chat default of
 * `auto` maps to `workspace-write`. The 2.6.0 list is the one recorded from the installed adapter (codex_acp_2_6_0_modes.json).
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, PYTHON, until } from './_connection.ts';
import { makeRepo, runGit } from './_worktree_fixtures.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { offeredModeIds, resolveMode } from '../../outputs/agent-studio/server/agents/mode_ids.ts';
import { workspaceModeOf, workspaceModesOf } from '../../outputs/agent-studio/server/swarm/rules.ts';
import { Swarm } from '../../outputs/agent-studio/server/swarm/service.ts';
import { setSwarmEnabled } from '../../outputs/agent-studio/server/swarm/settings.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE.replace(/fake_acp.py$/, 'fake_acp_unique.py');
const REAL = JSON.parse(Deno.readTextFileSync(new URL('./codex_acp_2_6_0_modes.json', import.meta.url))) as { availableModes: Json[] };
const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass every time.',
  owns: ['test/login/**'],
  done_when: 'the login tests pass',
  reply_with: 'cause in one line',
  test_cmd: "python -c \"open('AIB_RAN_TEST_CMD','w')\"",
};

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-codexmodes-test-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly studio: Studio;
  readonly swarm: Swarm;
  readonly connections: Connection[] = [];

  constructor(codexModes: 'v2.6' | 'old' | 'neither') {
    setSwarmEnabled(this.state, true);
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    const studio = new Studio({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0 }, { keeper: null });
    studio.ownerProbe = () => null;
    studio.agentLaunch = () => Promise.resolve([['unused'], {}]);
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection([PYTHON, UNIQUE, ...(provider === 'codex' ? ['--codex-modes', codexModes] : ['--models'])], cwd, provider, options ?? {});
    this.studio = studio;
    this.swarm = new Swarm({ stateDir: this.state, host: studio, settings: studio.settings });
    this.swarm.openMs = 30_000;
  }

  async helper(): Promise<{ id: string; record: ReturnType<Swarm['registry']['get']>; chat: Connection | undefined }> {
    const main = await this.studio.connect('claude', this.project, null, { ownCopy: true });
    const [code, out] = await this.swarm.tool(main.id, 'start_helper', BRIEF);
    assertEquals(code, 200, JSON.stringify(out));
    const id = String((out as Json).helper);
    await until(() => this.swarm.registry.get(id)?.state !== 'starting', 'the helper opened or failed', 30);
    const record = this.swarm.registry.get(id);
    return { id, record, chat: record ? this.studio.connections.get(record.chat.live) : undefined };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.swarm.stopWatching();
    await this.studio.close().catch(() => {});
    try {
      Deno.removeSync(this.dir, { recursive: true });
    } catch { /* a process may still hold it */ }
  }
}

const modeOf = (c: Connection) => (c.settings.modes as Json).currentModeId;

Deno.test('mode resolution: first offered of the list; a renamed id only by alias; never a broader mode', () => {
  const ids = offeredModeIds(REAL);
  assertEquals(ids, ['read-only', 'workspace-write', 'agent', 'agent-full-access']);
  assertEquals(resolveMode(ids, ['workspace-write', 'auto']), 'workspace-write');
  assertEquals(resolveMode(['read-only', 'auto', 'full-access'], ['workspace-write', 'auto']), 'auto');
  assertEquals(resolveMode(['read-only', 'agent', 'agent-full-access'], ['workspace-write', 'auto']), '', 'never agent-full-access');
  assertEquals(resolveMode(ids, 'auto', true), 'workspace-write', 'a saved old default maps to the new id');
  assertEquals(resolveMode(['read-only', 'auto'], 'workspace-write', true), 'auto', 'and a new default to the old id');
  assertEquals(resolveMode(ids, 'auto'), '', 'no alias unless asked');
  assertEquals(resolveMode(ids, 'agent', true), 'agent', '"Auto review" is its own mode, never mapped');
  assertEquals(resolveMode(['read-only'], 'full-access', true), '');
});

Deno.test('helper modes: Codex and model-server Codex prefer workspace-write then auto; Claude and Gemini unchanged', () => {
  assertEquals([...workspaceModesOf('codex')], ['workspace-write', 'auto']);
  assertEquals([...workspaceModesOf('codex@strata')], ['workspace-write', 'auto']);
  assertEquals([...workspaceModesOf('claude')], ['acceptEdits']);
  assertEquals([...workspaceModesOf('gemini')], ['autoEdit']);
  assertEquals([workspaceModeOf('codex'), workspaceModeOf('unknown')], ['workspace-write', '']);
});

Deno.test({
  ...T,
  name: 'helper start: a codex-acp 2.6.0 agent (the recorded real list) starts the helper in workspace-write',
  async fn() {
    await using box = new Box('v2.6');
    const { record, chat } = await box.helper();
    assertEquals(record?.state, 'working', record?.reason);
    assertEquals(modeOf(chat!), 'workspace-write');
    assertEquals(record?.chat.mode, 'workspace-write');
    assertEquals(chat!.pickResults.filter((r) => r.kind === 'mode').map((r) => [r.ok, r.value]), [[true, 'workspace-write']]);
  },
});

Deno.test({
  ...T,
  name: 'helper start: an older codex-acp (read-only / auto / full-access) starts the helper in auto',
  async fn() {
    await using box = new Box('old');
    const { record, chat } = await box.helper();
    assertEquals(record?.state, 'working', record?.reason);
    assertEquals(modeOf(chat!), 'auto');
    assertEquals(record?.chat.mode, 'auto');
  },
});

Deno.test({
  ...T,
  name: 'helper start: an agent offering neither is refused with a plain reason naming its modes, and never runs in a broader mode',
  async fn() {
    await using box = new Box('neither');
    const { record, chat } = await box.helper();
    assertEquals(record?.state, 'failed');
    const reason = String(record?.reason);
    assert(reason.includes('edit-in-workspace mode'), reason);
    assert(reason.includes('workspace-write or auto'), reason);
    assert(reason.includes('read-only, agent, agent-full-access'), reason);
    assert(!chat || modeOf(chat) !== 'agent-full-access', 'never a broader mode');
  },
});

Deno.test({
  ...T,
  name: 'new chat: a saved default of auto maps to workspace-write on a 2.6.0 agent; a saved workspace-write maps to auto on an old one',
  async fn() {
    await using box = new Box('v2.6');
    const c = await box.studio.connect('codex', box.project, null, { picks: { mode: 'auto' } });
    assertEquals(modeOf(c), 'workspace-write');
    assertEquals(c.pickResults.map((r) => [r.kind, r.ok, r.value]), [['mode', true, 'workspace-write']]);
    await c.close();
    await using old = new Box('old');
    const o = await old.studio.connect('codex', old.project, null, { picks: { mode: 'workspace-write' } });
    assertEquals(modeOf(o), 'auto');
    await o.close();
    // a pick the agent does not offer and has no twin for is still refused (never silently another mode)
    await using other = new Box('neither');
    const n = await other.studio.connect('codex', other.project, null, { picks: { mode: 'auto' } });
    assertEquals(n.pickResults.map((r) => r.ok), [false]);
    assert(String(n.pickResults[0].message).includes('read-only, agent, agent-full-access'), String(n.pickResults[0].message));
    await n.close();
  },
});
