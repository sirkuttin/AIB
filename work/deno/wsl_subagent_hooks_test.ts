/**
 * Subagent worktrees for WSL chats, end to end without a distro (owner 2026-11-23, "oq3 a"): a real Studio with a FakeWslHost (the
 * fake agent stands in for the distro's) whose `subagent.*` answers come from the REAL helper methods (wsl/helper/subagents.ts: the same
 * SubagentWorktrees and landing steps, real git on temp repos, Linux paths mapped to the temp folders at the last step), a real swarm,
 * and the hook path of AIB-keeper hook --helper-socket: a hook arrives through the tunnel (Studio.wslToolCall with the forwarder's
 * headers) and is answered, signed, inside an envelope. The Go side of the same envelope is keeper/hooksocket_test.go.
 *   - a WSL Claude chat gets command hooks that run the distro's keeper program on the helper's socket (never an address file), its
 *     hook key in its environment, and the distro's own read-only agent list;
 *   - its subagent gets a worktree IN THE DISTRO (a ref under the helper's data folder), its edits stay there (the project folder
 *     stays as it was), and it lands in the project folder's branch as one commit when the parent is idle; the worktree, branch and the
 *     mirror record go afterwards;
 *   - a conflict wakes the parent, keeps the worktree and offers a clean branch, exactly as on Windows;
 *   - a distro that can't answer (stopped, a helper error, no hook support) never leaves a subagent in the folder: the call is
 *     refused with a plain reason, or the chat's subagents are turned off up front;
 *   - a wrong hook key, another distro's call and a chat that is not open are refused; every answer after the key check is signed.
 *   - Codex: its hooks and its own subagent folder are made through the same path.
 * The real distro is wsl_subagents_e2e_test.ts (skips without AIB_WSL_E2E).
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { commit, exists, makeRepo, read, runGit, write } from './_worktree_fixtures.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary } from '../../outputs/agent-studio/server/keeper/client.ts';
import { CONVERSATION_HEADER, HOOK_EVENT_HEADER, HOOK_KEY_HEADER, HOOK_NONCE_HEADER } from '../../outputs/agent-studio/server/artifacts/mcp_http.ts';
import { hookProof } from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { WslHelperError } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { subagentMethods } from '../../outputs/agent-studio/server/wsl/helper/subagents.ts';
import { Swarm } from '../../outputs/agent-studio/server/swarm/service.ts';
import { readSubagents } from '../../outputs/agent-studio/server/subagents/service.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';
const KEEPER = '/tmp/aib-wsl-test-fake/1.8.0-abcdef12/AIB-keeper';
const SOCKET = '/tmp/aib-wsl-test-fake/data-x/helper/mcp.sock';

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');
Deno.env.set('AGENT_STUDIO_ALLOW_REAL_AGENT', '1'); // the chat's hooks are set up for a non-fixture agent command (the factory runs the fake agent)

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-subhooks-' }));
  readonly state = this.dir + SEP + 'state';
  readonly data = this.dir + SEP + 'distro-data'; // the distro helper's data folder
  readonly work = makeRepo(this.dir + SEP + 'app');
  readonly host: FakeWslHost;
  readonly helper = subagentMethods(this.data);
  readonly studios: Studio[] = [];
  readonly swarms: Swarm[] = [];

  constructor(tunnel = true) {
    runGit(this.work, 'config', 'core.autocrlf', 'false');
    Deno.mkdirSync(this.data, { recursive: true });
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu');
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u/aibdata', this.data);
    this.host.folders.set('/home/u', this.dir);
    if (tunnel) {
      this.host.mcpTunnel = { forwarder: KEEPER, socket: SOCKET };
      this.host.hookTunnel = { forwarder: KEEPER, socket: SOCKET };
    }
    for (const method of Object.keys(this.helper)) {
      if (!method.startsWith('subagent.')) continue;
      this.host.handlers[method as keyof typeof this.host.handlers] = async (p) => this.out(await this.helper[method](this.into(p) as Json));
    }
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  /** Linux paths the helper is given become the temp folders they stand for. */
  into(value: unknown): unknown {
    if (typeof value === 'string') return value.startsWith('/home/u/') ? this.host.windowsFor(value) : value;
    if (Array.isArray(value)) return value.map((v) => this.into(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.into(v)]));
    return value;
  }

  /** The helper's own (temp) paths in an answer are the Linux paths of the distro. */
  out(value: unknown): unknown {
    if (typeof value === 'string') {
      for (const [linux, win] of [['/home/u/app', this.work], ['/home/u/aibdata', this.data]]) {
        if (value === win || value.startsWith(win + SEP) || value.startsWith(win + '/')) return linux + value.slice(win.length).replaceAll('\\', '/');
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.out(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.out(v)]));
    return value;
  }

  /** The temp folder a Linux path of the distro stands for. */
  win(linux: string): string {
    return this.host.windowsFor(linux);
  }

  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ claudeLauncher: import.meta.filename!, codexLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware'), cwd, provider, { ...options, wsl });
    };
    this.studios.push(studio);
    this.swarms.push(new Swarm({ stateDir: this.state, host: studio, settings: studio.settings }));
    return studio;
  }

  get swarm(): Swarm {
    return this.swarms.at(-1)!;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.swarms) await s.stopWatching().catch(() => {});
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    await this.host.stopKeeper();
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

const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));

async function idle(c: Connection): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (c.busy && Date.now() < deadline) await pause(50);
  assert(!c.busy, 'the chat is idle');
}

/** A chat in the lab's WSL project, with a way to call its hooks as the distro's forwarder does (through the tunnel). */
async function openChat(lab: Lab, provider = 'claude') {
  const studio = lab.studio();
  const c = await studio.connect(provider, REF);
  await idle(c);
  const spec = lab.host.link.spawned.find((s) => String(s.channel).startsWith('chat-'))!;
  const env = spec.env as Record<string, string>;
  const key = env.AIB_HOOK_KEY ?? '';
  /** One hook call: the envelope AIB answers with, its proof checked here with the chat's key (as the forwarder does). */
  const hook = async (event: string, input: unknown, headers: Record<string, string> = {}) => {
    const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const answer = await studio.wslToolCall({
      distro: 'Ubuntu',
      key: '',
      conversation: c.id,
      body: JSON.stringify(input),
      headers: { [HOOK_KEY_HEADER]: key, [CONVERSATION_HEADER]: c.id, [HOOK_NONCE_HEADER]: nonce, [HOOK_EVENT_HEADER]: event, ...headers },
    });
    if (answer.status !== 200) return { tunnel: answer.status, status: 0, body: String(answer.error ?? ''), proofOk: false };
    const envelope = JSON.parse(answer.body) as { status: number; body: string; proof: string };
    const proofOk = envelope.proof === hookProof(key, nonce, envelope.status, new TextEncoder().encode(envelope.body));
    return { tunnel: 200, status: envelope.status, body: envelope.body, proofOk, proof: envelope.proof };
  };
  return { studio, c, env, key, hook };
}

const agentCall = (id: string, description = 'Make the docs') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_use_id: id,
  tool_input: { subagent_type: 'general-purpose', description, prompt: 'do it' },
});

const mirrors = (lab: Lab) => Object.values(readSubagents(lab.state));
const log = (project: string) => runGit(project, 'log', '--format=%s', '-n', '20');

Deno.test({
  name: 'wsl subagent hooks: a WSL Claude chat gets hooks on the helper socket and its key; its subagent works in a worktree in the distro and lands as one commit',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const { studio, c, env, key, hook } = await openChat(lab);
    // the hooks: the distro's keeper program on the helper's socket (never an address file), with the chat's own key in its environment
    const hooks = c.subagentHooks!;
    assertEquals(hooks.off, '');
    assert(c.subagentIsolationOn());
    const commands = Object.values((hooks.settings as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.command)));
    assertEquals(commands.length, 4);
    for (const command of commands) assert(command.startsWith(`"${KEEPER}" hook `) && command.includes(`--helper-socket "${SOCKET}"`), command);
    assert(commands.some((x) => x.includes('hook pre-tool') && x.endsWith('|| exit 2')) && commands.some((x) => x.includes('hook worktree-create')));
    assertEquals(env.AIB_HOOK_CHAT, c.id);
    assert(/^[0-9a-f]{20,}$/.test(key) || key.length > 16, `a hook key: ${key}`);
    assert(env.AIB_HOOK_READONLY.split(',').includes('Explore'));
    assertEquals(env.AIB_HOOK_KEY, key);
    // the same settings go to the agent in session/new
    assertEquals(c.claudeMeta(), { _meta: { claudeCode: { options: { settings: hooks.settings } } } });

    // an Agent call: AIB (through the distro's helper) makes the worktree and answers, signed, that it runs isolated
    const pre = await hook('pre-tool', agentCall('toolu_1'));
    assertEquals([pre.tunnel, pre.status, pre.proofOk], [200, 200, true]);
    assertEquals(JSON.parse(pre.body).hookSpecificOutput.updatedInput.isolation, 'worktree');
    const prepared = mirrors(lab);
    assertEquals(prepared.map((r) => r.state), ['prepared']);
    const rec = prepared[0];
    assertEquals(rec.wsl?.distro, 'ubuntu');
    assert(rec.path.startsWith('wsl://ubuntu/home/u/aibdata/worktrees/'), `a ref in the distro's data folder: ${rec.path}`);
    assertEquals(rec.folder, REF);
    assert(rec.wsl!.linux.path.startsWith('/home/u/aibdata/worktrees/'), rec.wsl!.linux.path);
    const worktree = lab.win(rec.wsl!.linux.path);
    assert(exists(worktree), 'the worktree is in the distro (helper data folder)');
    assertEquals(runGit(lab.work, 'status', '--porcelain').trim(), '', 'the project folder is untouched');

    // WorktreeCreate binds it to the starting subagent and answers its bare path
    const created = await hook('worktree-create', { name: 'agent-a1' });
    assertEquals([created.status, created.proofOk], [200, true]);
    assert(created.body.startsWith('/home/u/aibdata/worktrees/'), created.body);
    assertEquals(mirrors(lab)[0].state, 'running');

    // its edits stay in its worktree
    commit(worktree, 'sub.txt', 'from the subagent\n', 'subagent edit');
    write(worktree, 'extra.txt', 'uncommitted in the worktree\n');
    assertEquals(runGit(lab.work, 'status', '--porcelain').trim(), '', 'the project folder still has none of it');
    assert(!exists(lab.work + SEP + 'sub.txt'));

    // PostToolUse and SubagentStop are hints; the stop makes the record done
    assertEquals((await hook('post-agent', { tool_use_id: 'toolu_1', tool_response: { agentId: 'a1', status: 'completed' } })).status, 200);
    assertEquals((await hook('subagent-stop', { agent_id: 'a1', agent_type: 'general-purpose' })).status, 200);
    assertEquals(mirrors(lab)[0].state, 'done');

    // the parent is idle: the swarm lands it in the distro's project folder, one commit, its own work only
    write(lab.work, 'mine.txt', 'my own unsaved work\n');
    await lab.swarm.poll();
    await until(() => log(lab.work).includes('AIB: subagent Make the docs'), 'landed', 20);
    assertEquals(runGit(lab.work, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['extra.txt', 'sub.txt']);
    assertEquals(read(lab.work, 'mine.txt'), 'my own unsaved work\n', "the folder's own file is not part of it");
    assertEquals(runGit(lab.work, 'ls-tree', '--name-only', 'HEAD').split('\n').includes('mine.txt'), false);
    assert(notes(c).some((n) => n.startsWith('Merged subagent “Make the docs” into main · 2 files')), notes(c).join('\n'));
    await until(() => mirrors(lab).filter((r) => r.id === rec.id).length === 0, 'its mirror record released', 20);
    assert(!exists(worktree), 'its worktree is gone');
    assertEquals(runGit(lab.work, 'branch', '--list', 'studio/sub-*').trim().split('\n').filter((l) => l.includes(String(rec.branch))), []);
    assertEquals(runGit(lab.work, 'stash', 'list').trim(), '', 'nothing was stashed');
    void studio;
  },
});

Deno.test({
  name: 'wsl subagent hooks: a conflict wakes the parent, keeps the worktree and offers a clean branch; a read-only type needs no worktree',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const { studio, c, hook } = await openChat(lab);
    const woke: { op: string; text: string }[] = [];
    const own = studio.liveCall.bind(studio);
    studio.liveCall = (name, body) => {
      if (name === 'steer' || name === 'queue') woke.push({ op: name, text: String((body as Json).text) });
      return own(name, body);
    };
    // a read-only type passes without a worktree (the forwarder passes it itself; AIB agrees)
    const explore = await hook('pre-tool', { ...agentCall('toolu_0'), tool_input: { subagent_type: 'Explore', description: 'look', prompt: 'x' } });
    assertEquals([explore.status, explore.proofOk, explore.body], [200, true, '{}']);
    assertEquals(mirrors(lab).length, 0);
    // EnterWorktree and Workflow are refused with a reason
    for (const tool of ['EnterWorktree', 'Workflow']) {
      const refused = await hook('pre-tool', { tool_name: tool, tool_input: {} });
      assertEquals([refused.status, refused.proofOk], [200, true]);
      assertEquals(JSON.parse(refused.body).hookSpecificOutput.permissionDecision, 'deny');
    }
    const pre = await hook('pre-tool', agentCall('toolu_1', 'Edit shared'));
    assertEquals(pre.status, 200);
    await hook('worktree-create', { name: 'agent-b1' });
    const rec = mirrors(lab)[0];
    const worktree = lab.win(rec.wsl!.linux.path);
    commit(worktree, 'tracked.txt', 'subagent line\n', 'subagent edit');
    await hook('subagent-stop', { agent_id: 'b1', agent_type: 'general-purpose' });
    commit(lab.work, 'tracked.txt', 'main line\n', 'main edit'); // the folder moved on, on the same line
    await lab.swarm.poll();
    await until(() => notes(c).some((n) => n.includes("couldn't land")), 'the conflict told', 20);
    assert(exists(worktree), 'the conflicting worktree is kept');
    assertEquals(woke.length, 1, JSON.stringify(woke));
    assert(woke[0].op === 'steer' && woke[0].text.includes('did not land') && woke[0].text.includes('tracked.txt'), woke[0].text);
    assert(woke[0].text.includes(`${rec.branch}-landable`), woke[0].text);
    assertEquals(runGit(lab.work, 'show', '--name-only', '--format=', `${rec.branch}-landable`).trim(), 'tracked.txt');
    assertEquals(runGit(lab.work, 'show', 'main:tracked.txt'), 'main line\n', 'nothing landed over the folder\'s own commit');
    assertEquals(runGit(lab.work, 'stash', 'list').trim(), '');
  },
});

Deno.test({
  name: 'wsl subagent hooks: a distro that cannot answer refuses cleanly (no worktree, nothing in the folder); wrong keys and other chats are refused',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const { studio, c, key, hook } = await openChat(lab);
    // the helper fails: the Agent call is denied with a plain reason, and nothing was made
    lab.host.handlers['subagent.hook'] = () => {
      throw new WslHelperError('the helper crashed', 'internal');
    };
    const failed = await hook('pre-tool', agentCall('toolu_1'));
    assertEquals([failed.status, failed.proofOk], [200, true]);
    const reason = JSON.parse(failed.body).hookSpecificOutput;
    assertEquals(reason.permissionDecision, 'deny');
    assert(String(reason.permissionDecisionReason).includes("couldn't make a worktree for this subagent in the distro: the helper crashed"), reason.permissionDecisionReason);
    delete lab.host.handlers['subagent.hook'];
    // the distro is stopped: the same, never waiting for it to start
    lab.host.state = 'stopped';
    const stopped = await hook('pre-tool', agentCall('toolu_2'));
    assertEquals(JSON.parse(stopped.body).hookSpecificOutput.permissionDecision, 'deny');
    assert(String(JSON.parse(stopped.body).hookSpecificOutput.permissionDecisionReason).includes('is not running'), stopped.body);
    const create = await hook('worktree-create', { name: 'agent-x' });
    assertEquals([create.status, create.proofOk], [500, true]); // the forwarder fails closed on anything but 200 or a text refusal
    lab.host.state = 'ready';
    assertEquals(mirrors(lab).length, 0);
    assertEquals(runGit(lab.work, 'status', '--porcelain').trim(), '', 'the project folder was never touched');
    assertEquals(runGit(lab.work, 'branch', '--list', 'studio/sub-*').trim(), '');
    // a helper that is too old for subagent.*: a refusal that says so
    lab.host.handlers['subagent.hook'] = () => {
      throw new WslHelperError('no such method', 'no_method');
    };
    const old = await hook('pre-tool', agentCall('toolu_3'));
    assert(String(JSON.parse(old.body).hookSpecificOutput.permissionDecisionReason).includes('too old'), old.body);
    delete lab.host.handlers['subagent.hook'];
    // a wrong hook key: refused, and the answer carries no proof (the forwarder blocks it)
    const wrong = await hook('pre-tool', agentCall('toolu_4'), { [HOOK_KEY_HEADER]: 'wrong-key' });
    assertEquals([wrong.status, wrong.body, wrong.proofOk], [401, 'AIB refused the hook key for this conversation', false]);
    assertEquals((wrong as { proof?: string }).proof, '');
    // the artifact key is not a hook key
    assertEquals((await hook('pre-tool', agentCall('toolu_5'), { [HOOK_KEY_HEADER]: key + 'x' })).status, 401);
    // not a hook event
    assertEquals((await hook('rm -rf', {})).status, 404);
    // not JSON
    const nonce = 'ab'.repeat(16);
    const bad = await studio.wslToolCall({ distro: 'Ubuntu', key: '', conversation: c.id, body: 'not json', headers: { [HOOK_KEY_HEADER]: key, [CONVERSATION_HEADER]: c.id, [HOOK_NONCE_HEADER]: nonce, [HOOK_EVENT_HEADER]: 'pre-tool' } });
    assertEquals(JSON.parse(bad.body).status, 400);
    // another distro's call, and a chat that is not open here
    const other = await studio.wslToolCall({ distro: 'Debian', key: '', conversation: c.id, body: '{}', headers: { [HOOK_KEY_HEADER]: key, [CONVERSATION_HEADER]: c.id, [HOOK_NONCE_HEADER]: nonce, [HOOK_EVENT_HEADER]: 'pre-tool' } });
    assertEquals(other.status, 401);
    const unknown = await studio.wslToolCall({ distro: 'Ubuntu', key: '', conversation: 'f'.repeat(32), body: '{}', headers: { [HOOK_KEY_HEADER]: key, [CONVERSATION_HEADER]: 'f'.repeat(32), [HOOK_NONCE_HEADER]: nonce, [HOOK_EVENT_HEADER]: 'pre-tool' } });
    assertEquals(unknown.status, 401);
    // a closed AIB answers at once
    await studio.close();
    lab.studios.splice(lab.studios.indexOf(studio), 1);
    const closed = await studio.wslToolCall({ distro: 'Ubuntu', key: '', conversation: c.id, body: '{}', headers: { [HOOK_KEY_HEADER]: key, [HOOK_EVENT_HEADER]: 'pre-tool' } });
    assertEquals(closed.status, 503);
  },
});

Deno.test({
  name: 'wsl subagent hooks: no hook support in the distro (old helper or setup fails) turns the chat\'s subagents off up front instead of leaving them unisolated',
  ...T,
  async fn() {
    await keeperBinary();
    // 1. a helper without the hook tunnel (only the MCP one)
    {
      await using lab = new Lab(true);
      lab.host.hookTunnel = null;
      const studio = lab.studio();
      const c = await studio.connect('claude', REF);
      await idle(c);
      const hooks = c.subagentHooks!;
      assertEquals(hooks.off, 'WSL hooks unavailable');
      assertEquals(hooks.settings, null);
      assert(hooks.detail!.includes("helper can't give subagents their own worktree"), hooks.detail);
      const deny = (hooks.deny as { permissions: { deny: string[] } }).permissions.deny;
      assert(['Agent', 'Task', 'Workflow', 'EnterWorktree'].every((t) => deny.includes(t)), deny.join());
      assertEquals(c.claudeMeta(), { _meta: { claudeCode: { options: { settings: hooks.deny } } } });
      assert(!c.subagentIsolationOn());
      assert(notes(c).some((n) => n.startsWith('Subagents are off in this chat: AIB could not set up their own worktree in this WSL distro')), notes(c).join('\n'));
    }
    // 2. the setup call fails: the same
    {
      await using lab = new Lab();
      lab.host.handlers['subagent.setup'] = () => {
        throw new WslHelperError('the distro stopped', 'stopped');
      };
      const studio = lab.studio();
      const c = await studio.connect('claude', REF);
      await idle(c);
      assertEquals(c.subagentHooks!.off, 'WSL hooks unavailable');
      assert(c.subagentHooks!.detail!.includes('the distro stopped'));
      assert(c.subagentHooks!.deny);
    }
    // 3. hooks turned off in the user's own settings (read in the distro): its editing subagents are denied by rules, as on Windows
    {
      await using lab = new Lab();
      const claude = lab.dir + SEP + 'claude-config';
      write(claude, 'settings.json', JSON.stringify({ disableAllHooks: true }));
      lab.host.loginEnv.CLAUDE_CONFIG_DIR = '/home/u/claude-config';
      const base = lab.helper['subagent.setup'];
      lab.host.handlers['subagent.setup'] = async (p) => lab.out(await base({ ...(lab.into(p) as Json), env: { CLAUDE_CONFIG_DIR: claude } }));
      const studio = lab.studio();
      const c = await studio.connect('claude', REF);
      await idle(c);
      assertEquals(c.subagentHooks!.off, 'hooks are off');
      assert(c.subagentHooks!.detail!.includes('disableAllHooks'), c.subagentHooks!.detail);
      const deny = (c.subagentHooks!.deny as { permissions: { deny: string[] } }).permissions.deny;
      assert(deny.includes('Agent(general-purpose)'), deny.join());
    }
  },
});

Deno.test({
  name: 'wsl subagent hooks: a WSL Codex chat gets its hooks on the helper socket and its own subagent folder in the distro',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    lab.host.handlers['agents.detect'] = () => ({ agents: [{ id: 'codex', found: true, command: ['node', '/usr/lib/node_modules/@zed-industries/codex-acp/bin/codex-acp.js'], version: '1.0.0' }] });
    const { c, env, hook } = await openChat(lab, 'codex');
    assertEquals(c.subagentHooks!.off, '');
    assert(c.subagentHooks!.adopted === true);
    const sub = c.subagentHooks!.subFolder!;
    assert(/^\/home\/u\/aibdata\/worktrees\/[0-9a-f]+\/\.cx-[0-9a-f]{32}$/.test(sub), sub);
    assert(exists(lab.win(sub)), "the chat's own folder for its subagents exists in the distro");
    const config = JSON.parse(env.CODEX_CONFIG) as { hooks: Record<string, { hooks: { command: string }[] }[]>; thread_unload_delay_secs: number };
    const pre = config.hooks.PreToolUse.at(-1)!.hooks[0].command;
    assertEquals(pre, `'${KEEPER}' hook codex-pre-tool --helper-socket '${SOCKET}' || exit 2`);
    assertEquals(env.AIB_HOOK_CHAT, c.id);
    // spawn_agent: the worktree is made in the distro; SubagentStart binds it and tells the subagent its folder
    const spawn = await hook('codex-pre-tool', { tool_name: 'spawn_agent', tool_use_id: 'call_1', tool_input: { message: 'write the docs' } });
    assertEquals([spawn.status, spawn.proofOk, spawn.body], [200, true, '{}']);
    const rec = mirrors(lab)[0];
    assertEquals(rec.state, 'prepared');
    assert(rec.wsl!.linux.path.includes('/.cx-'), `in the chat's own folder: ${rec.wsl!.linux.path}`);
    const start = await hook('codex-subagent-start', { agent_id: 'cx1', agent_type: 'default' });
    assertEquals([start.status, start.proofOk], [200, true]);
    assert(JSON.parse(start.body).hookSpecificOutput.additionalContext.includes(lab.win(rec.wsl!.linux.path)), start.body); // (the helper's own path: a Windows temp folder here)
    // its shell commands run in the worktree (a cd prefix), and one naming the main folder is denied
    const bash = await hook('codex-pre-tool', { tool_name: 'Bash', agent_id: 'cx1', tool_input: { command: 'echo hi > a.txt' } });
    const fwd = (p: string) => p.replaceAll(SEP, '/');
    assertEquals(JSON.parse(bash.body).hookSpecificOutput.updatedInput.command, `cd '${fwd(lab.win(rec.wsl!.linux.path))}'; echo hi > a.txt`);
    const outside = await hook('codex-pre-tool', { tool_name: 'Bash', agent_id: 'cx1', tool_input: { command: `echo hi > ${fwd(lab.work)}/a.txt` } });
    assertEquals(JSON.parse(outside.body).hookSpecificOutput.permissionDecision, 'deny');
    assertEquals((await hook('codex-subagent-stop', { agent_id: 'cx1' })).status, 200);
    assertEquals(mirrors(lab)[0].state, 'done');
    assertEquals(runGit(lab.work, 'status', '--porcelain').trim(), '');
  },
});

Deno.test({
  name: 'wsl subagent hooks: the envelope proof is the HTTP form\'s proof (the vector keeper/hooksocket_test.go and hookforward_test.go also check)',
  ...T,
  fn() {
    assertEquals(hookProof('k-123', 'abcdef0123456789', 200, new TextEncoder().encode('{}')), '8499c10f781827e1c0c1f5c0f017ff99d1d934efaab9c083690ce1cc5bafe6f3');
  },
});

Deno.test({
  name: 'wsl subagent hooks: a helper that reports reaps gets hook 2 (pre-shell) and tags only a subagent\'s shell call; an older helper gets neither',
  ...T,
  async fn() {
    await keeperBinary();
    const commandsOf = (c: Connection) =>
      Object.values((c.subagentHooks!.settings as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.command)));
    { // older helper (no subagent.reaps): no pre-shell entry in the chat's hooks, its shell calls are never tagged
      await using lab = new Lab();
      const { c } = await openChat(lab);
      assert(!commandsOf(c).some((x) => x.includes('hook pre-shell')), 'no pre-shell hook for an older helper');
      assertEquals(c.subagentHooks!.shellTag, undefined);
    }
    await using lab = new Lab();
    lab.host.hookShellTag = true;
    const { studio, c, hook } = await openChat(lab);
    assertEquals(c.subagentHooks!.shellTag, true);
    const shell = commandsOf(c).find((x) => x.includes('hook pre-shell'))!;
    assert(shell && shell.includes(`--helper-socket "${SOCKET}"`) && !shell.includes('|| exit 2'), String(shell));
    const call = (agent: string | null, command: string) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_s1',
      ...(agent ? { agent_id: agent } : {}),
      tool_input: { command },
    });
    // a subagent's call: the helper (Linux rules) answers with the cookie in front of the command; the proof is AIB's
    const tagged = await hook('pre-shell', call('a1', 'npm run dev'));
    assertEquals([tagged.tunnel, tagged.status, tagged.proofOk], [200, 200, true]);
    // (this lab's helper runs on Windows, which adds its PATH marker; in a real distro the prefix is the export alone: subagent_reap_test.ts)
    const command = JSON.parse(tagged.body).hookSpecificOutput.updatedInput.command as string;
    assert(command.startsWith(`export AIB_PROC='${c.id}.a1.toolu_s1'; `) && command.endsWith('; npm run dev'), command);
    // the main agent's own call is not tagged
    assertEquals(JSON.parse((await hook('pre-shell', call(null, 'npm run dev'))).body), {});
    // the shell hook is on every call's latency path: it never reads the records back
    assertEquals(studio.subagents!.ofChat(c.id).length, 0);
  },
});
