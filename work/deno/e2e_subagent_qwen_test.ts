/**
 * Subagent worktrees, Qwen Code (server/subagents/qwen.ts; keeper/hookforward_qwen.go): e2e with the REAL Qwen Code 0.27.2 over ACP
 * (as AIB launches it: AIB's own managed install, used read only through a junction) against the stub model API
 * (work/stub_model_api.js, Anthropic /v1/messages, script mode), a real AIB (deno-split web server + agent host) and the real keeper
 * program (built from keeper/ with Go: the hook forwarder). Temp config only (QWEN_HOME, HOME and USERPROFILE are temp folders), no
 * real account, no network. Owner rule: an agent's own subagent that edits files works in its own git worktree, and AIB lands it;
 * hooks off turns the chat's subagents off. Facts: aib-shared/research/provider-builder-probe-2026-11-25.md.
 *
 *   QwenWorktreeTest   the parent starts a general-purpose subagent (tool_search select:agent, then tool_call agent). The subagent
 *                      writes inside its worktree (allowed), writes <project>\escape.txt by absolute path (denied, names the worktree),
 *                      redirects shell output into the main folder (denied), and runs `cd > shell-made.txt` (it starts in its worktree).
 *                      The parent also starts an Explore subagent (its shell is denied, its read passes, no worktree is made) and a
 *                      fork (denied). At the subagent's end its two files land as one AIB commit; nothing else is in the folder; the
 *                      worktree, branch and record go. AIB's settings file is the chat's system settings (the hook commands do not
 *                      start with a double quote); the "user's" Qwen settings are unchanged; the owner's ~/.qwen, ~/.claude and
 *                      ~/.codex are untouched.
 *   QwenHooksOffTest   disableAllHooks in the user's Qwen settings: AIB's file denies `agent`; the model is told "Not found: agent"
 *                      (tool_search); the chat says its subagents are off; nothing runs in or lands in the folder.
 *
 * Needs node (22+), Go (the keeper program is built from keeper/ into a temp folder; AIB_TEST_KEEPER_BIN names a built one) and AIB's
 * managed Qwen install (AIB_QWEN_DIR = the folder holding node_modules/@qwen-code/qwen-code; default: %LOCALAPPDATA%\AIB\agents\qwen\0.27.2,
 * Linux: ~/.local/share/AIB/agents/qwen/0.27.2). Run with TEMP/TMP pointed at a scratch folder.
 * WSL: Qwen Code is not installed in the Ubuntu distro here, so the WSL route is tested with fakes (work/deno/wsl_subagent_hooks_test.ts).
 */
import { assert, assertEquals, Chat, E2EFixture, git, isDir, isFile, Json, sleep, waitFor } from './_e2e.ts';
import {
  agentTempRoot,
  approveAll,
  HAVE_KEEPER_BIN,
  join,
  keeperProgram,
  makeProject,
  NODE_EXE,
  SERVER_SPLIT,
  Stub,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';

const WIN = Deno.build.os === 'windows';
const HOME = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '';
const QWEN_DIR = Deno.env.get('AIB_QWEN_DIR') ??
  (WIN
    ? join(Deno.env.get('LOCALAPPDATA') ?? '', 'AIB', 'agents', 'qwen', '0.27.2')
    : join(HOME, '.local', 'share', 'AIB', 'agents', 'qwen', '0.27.2'));
const QWEN_PKG = join(QWEN_DIR, 'node_modules', '@qwen-code', 'qwen-code');
const ok = !!(NODE_EXE && isFile(join(QWEN_PKG, 'cli.js')) && isFile(join(QWEN_DIR, '.complete')) && HAVE_KEEPER_BIN && SERVER_SPLIT);

/** What a run must not change: the owner's ~/.qwen (listing, mtimes), ~/.claude settings and projects, ~/.codex config and sessions. */
function ownerState(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (dir: string, into: [string, number][], depth = 0) => {
    try {
      for (const e of Deno.readDirSync(dir)) {
        const p = join(dir, e.name);
        if (e.isDirectory && depth < 3) walk(p, into, depth + 1);
        else if (e.isFile) into.push([p, Deno.statSync(p).mtime?.getTime() ?? 0]);
      }
    } catch { /* none */ }
  };
  const qwen: [string, number][] = [];
  walk(join(HOME, '.qwen'), qwen);
  out.qwen = qwen.sort((a, b) => a[0].localeCompare(b[0]));
  for (
    const f of [
      join(HOME, '.claude', 'settings.json'),
      join(HOME, '.claude', 'settings.local.json'),
      join(HOME, '.codex', 'config.toml'),
      join(HOME, '.codex', 'hooks.json'),
    ]
  ) {
    try {
      out[f] = Deno.statSync(f).mtime?.getTime() ?? null;
    } catch {
      out[f] = null;
    }
  }
  try {
    out.claude_projects = [...Deno.readDirSync(join(HOME, '.claude', 'projects'))].map((e) => e.name).sort();
  } catch {
    out.claude_projects = [];
  }
  return out;
}

/**
 * AIB's own install layout: <state>/agents/qwen/<version> is a junction to the managed install folder (read only; it holds .complete
 * and node_modules, and AIB only runs entries that stay inside the version folder).
 */
function installQwen(state: string): string {
  const base = join(state, 'agents', 'qwen');
  Deno.mkdirSync(base, { recursive: true });
  const link = join(base, '0.27.2');
  if (WIN) {
    const r = new Deno.Command('cmd', { args: ['/c', 'mklink', '/J', link, QWEN_DIR], stdout: 'piped', stderr: 'piped' }).outputSync();
    if (r.code !== 0) throw new Error('mklink failed');
  } else Deno.symlinkSync(QWEN_DIR, link, { type: 'dir' });
  return link;
}

const unlink = (link: string) => {
  try {
    Deno.removeSync(link); // the link only, never its target
  } catch { /* gone */ }
};

class QwenFixture extends E2EFixture {
  constructor(parent: string, extraEnv: Record<string, string>) {
    super('worktree-e2e-agent.mjs', parent, extraEnv);
    this.scrub = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'DASHSCOPE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  }
  override agentFlags(): string[] {
    const flags = super.agentFlags();
    flags[flags.indexOf('--node-command') + 1] = NODE_EXE!; // AIB runs its own Qwen install with node
    return flags;
  }
}

const tool = (id: string, name: string, input: Json) => ({ id, name, input });
/** Qwen's agent tool is deferred: the model finds its schema with tool_search, then calls it through tool_call. */
const agentCall = (id: string, input: Json) => tool(id, 'tool_call', { name: 'agent', arguments: input });
const search = (id: string) => tool(id, 'tool_search', { query: 'select:agent' });
// Qwen tells a subagent that has a working_dir where it works ("Your working directory is <folder>, a git worktree ...")
const WT_CAPTURE = String.raw`Your working directory is ([^ ,]+), a git worktree`;

function builderRules(project: string): unknown[] {
  const slash = (p: string) => p.replaceAll('\\', '/');
  const shellEscape = WIN ? `echo escaped> "${join(project, 'escape2.txt')}"` : `echo escaped > '${join(project, 'escape2.txt')}'`;
  const shellHere = WIN ? 'cd > shell-made.txt' : 'pwd > shell-made.txt';
  return [
    { when: 'QW-GO', reply: { text: 'finding the agent tool', tools: [search('toolu_ts1')] } },
    {
      when: 'toolu_ts1',
      reply: {
        text: 'starting',
        tools: [
          agentCall('toolu_ag1', {
            description: 'QW-SUB-A write the file',
            prompt: 'SUBPROMPT-A write the files',
            subagent_type: 'general-purpose',
          }),
        ],
      },
    },
    {
      when: 'toolu_ag1',
      reply: {
        text: 'exploring',
        tools: [
          agentCall('toolu_ag2', { description: 'QW-EXPLORE look around', prompt: 'SUBPROMPT-E look around', subagent_type: 'Explore' }),
        ],
      },
    },
    {
      when: 'toolu_ag2',
      reply: {
        text: 'forking',
        tools: [agentCall('toolu_ag3', { description: 'QW-FORK try', prompt: 'SUBPROMPT-F fork', subagent_type: 'fork' })],
      },
    },
    { when: 'toolu_ag3', reply: { text: 'PARENT-DONE' } },
    // the builder: its worktree is named in what Qwen tells a subagent that has a working_dir
    {
      when: 'SUBPROMPT-A',
      capture: WT_CAPTURE,
      reply: {
        text: 'writing in my worktree',
        tools: [tool('toolu_sw1', 'write_file', { file_path: '@CAP@/sub-made.txt', content: 'from-sub\n' })],
      },
    },
    {
      when: 'toolu_sw1',
      reply: {
        text: 'trying the main folder',
        tools: [tool('toolu_sw2', 'write_file', { file_path: slash(join(project, 'escape.txt')), content: 'escaped\n' })],
      },
    },
    {
      when: 'toolu_sw2',
      reply: {
        text: 'trying a shell redirect',
        tools: [tool('toolu_sw3', 'run_shell_command', { command: shellEscape, description: 'escape' })],
      },
    },
    {
      when: 'toolu_sw3',
      reply: { text: 'a command here', tools: [tool('toolu_sw4', 'run_shell_command', { command: shellHere, description: 'where am I' })] },
    },
    { when: 'toolu_sw4', reply: { text: 'SUB-A-DONE' } },
    // Explore: no worktree; its shell is denied, its read passes
    {
      when: 'SUBPROMPT-E',
      reply: {
        text: 'a command',
        tools: [
          tool('toolu_se1', 'run_shell_command', {
            command: WIN ? 'echo explore> explore-made.txt' : 'echo explore > explore-made.txt',
            description: 'explore shell',
          }),
        ],
      },
    },
    { when: 'toolu_se1', reply: { text: 'reading', tools: [tool('toolu_se2', 'read_file', { file_path: join(project, 'tracked.txt') })] } },
    { when: 'toolu_se2', reply: { text: 'EXPLORE-DONE' } },
  ];
}

/** A real AIB with one Qwen chat in a temp git project; `userSettings` is the "user's" ~/.qwen/settings.json. */
async function play(
  rules: (project: string) => unknown[],
  userSettings: Json,
  prompt: string,
  waitFor_: (ctx: { stub: Stub; project: string }) => Promise<void>,
) {
  const temp = new Temp('aib-srq-');
  if (temp.path.includes(' ')) {
    throw new Error('the temp folder has a space: Qwen hooks cannot name the keeper there (TEMP=a scratch folder)');
  }
  const run = uuid().slice(0, 8);
  const project = makeProject(temp.path, `srq${run}`);
  const before = ownerState();
  const qwenHome = temp.join('user-qwen-home'); // "the user's" Qwen home (QWEN_HOME): never the owner's
  Deno.mkdirSync(qwenHome, { recursive: true });
  const settingsFile = join(qwenHome, 'settings.json');
  Deno.writeTextFileSync(settingsFile, JSON.stringify(userSettings));
  const settingsBefore = JSON.stringify(userSettings);
  const stub = await Stub.start(temp.path, rules(project));
  const keeper = keeperProgram();
  temp.mkdir('tmp');
  const tmp = temp.join('tmp');
  const fx = new QwenFixture(agentTempRoot(), {
    AGENT_STUDIO_ALLOW_REAL_AGENT: '1',
    AIB_KEEPER_BIN: keeper,
    QWEN_HOME: qwenHome,
    ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_API_KEY: 'stub-key',
    ANTHROPIC_MODEL: 'stub-model',
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
  });
  const link = installQwen(fx.state);
  const cleanup = async () => {
    unlink(link); // before the state folder is removed: never delete through the junction
    await fx.cleanup();
    await stub.stop();
    try {
      const after = ownerState();
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) =>
        JSON.stringify(before[k]) !== JSON.stringify(after[k])
      ).sort();
      assertEquals(changed, [], "the owner's ~/.qwen, ~/.claude or ~/.codex changed");
    } finally {
      temp[Symbol.dispose]();
    }
  };
  try {
    const web = await fx.startWeb();
    const [status, connection] = await web.post('connect', { provider: 'qwen', cwd: project, background: true });
    assertEquals(status, 200, JSON.stringify(connection));
    const chat = new Chat(null, connection.id as string, web);
    await waitFor(
      async () => {
        const s = await chat.state();
        if (s.error) throw new Error(String(s.error));
        return s.ready;
      },
      'chat ready',
      180,
    );
    const [code, changed] = await web.post('mode', { id: chat.id, modeId: 'yolo' });
    assertEquals(code, 200, JSON.stringify(changed));
    const [c2] = await web.post('prompt', { id: chat.id, text: `${prompt} ${run}`, clientMessageId: uuid() });
    assertEquals(c2, 200);
    await waitFor(
      async () => {
        await approveAll(chat);
        const state = await chat.state();
        return !state.busy && state.events.some((e) => e.kind === 'turn_end');
      },
      'the parent turn to end',
      300,
    );
    await waitFor_({ stub, project });
    // Qwen itself migrates its own settings file (adds "$version", reformats): AIB adds nothing, so only the user's keys are there
    const after = JSON.parse(fileText(settingsFile)) as Json;
    delete after.$version;
    assertEquals(JSON.stringify(after), settingsBefore, "the user's Qwen settings were written");
    return { fx, chat, project, stub, run, qwenHome, cleanup };
  } catch (error) {
    console.error(JSON.stringify(stub.calls().map((c) => [c.rule, String(c.last ?? '').slice(-200)]), null, 1).slice(-6000));
    for (const f of stub.dumpFiles()) { // what the model was sent, around the subagent's own prompt
      const raw = fileText(f);
      const at = raw.indexOf('SUBPROMPT-A');
      if (at >= 0) console.error(`${f}: …${raw.slice(Math.max(0, at - 1200), at + 150)}`);
    }
    const logs: string[] = [];
    const walk = (dir: string) => {
      try {
        for (const e of Deno.readDirSync(dir)) {
          const p = join(dir, e.name);
          if (e.isDirectory) walk(p);
          else if (e.name.endsWith('.log')) logs.push(...fileText(p).split('\n').filter((x) => /ubagent|hook|qwen/i.test(x)).slice(-20));
        }
      } catch { /* gone */ }
    };
    walk(fx.root);
    console.error(logs.join('\n').slice(-4000));
    await cleanup().catch(() => {});
    throw error;
  }
}

const fileText = (p: string) => Deno.readTextFileSync(p);
const notes = (events: { kind: string; data: Json }[]) => events.filter((e) => e.kind === 'studio_note').map((e) => JSON.stringify(e.data));

Deno.test({
  name: 'QwenWorktreeTest test_subagent_edits_land_from_its_worktree_and_escapes_are_denied',
  ignore: !ok,
  ...T,
  async fn() {
    const { fx, chat, project, stub, qwenHome, cleanup } = await play(
      builderRules,
      { general: { checkpointing: { enabled: false } } },
      'QW-GO',
      async ({ stub, project }) => {
        // the subagent's files arrive as AIB's landing commit
        await waitFor(() => stub.text().includes('SUB-A-DONE') || stub.dumped().includes('SUB-A-DONE'), 'the builder to finish', 120);
        await waitFor(
          () => git(project, 'log', '--format=%s', '-n', '10').includes('AIB: subagent QW-SUB-A write the file'),
          'the subagent work to land',
          240,
        );
      },
    );
    try {
      const sent = stub.dumped();
      // the denials reached the subagent with AIB's reasons
      assert(sent.includes('works in its own git worktree'), 'the subagent was told where it works');
      assert(
        sent.includes('has no worktree for this subagent') || sent.includes('AIB has no worktree for this subagent'),
        "Explore's shell was denied",
      );
      assert(sent.includes("a fork subagent can't work in its own worktree") || sent.includes('fork subagent'), 'the fork was refused');
      assert(
        sent.includes('Subagents you start with the agent tool that edit files work in their own git worktree'),
        'the rule reached the model',
      );
      // landed: exactly the two files the subagent made inside its worktree
      assertEquals(git(project, 'show', '--name-only', '--format=', 'HEAD').split(/\s+/).filter(Boolean).sort(), [
        'shell-made.txt',
        'sub-made.txt',
      ]);
      assertEquals(fileText(join(project, 'sub-made.txt')).replace(/\r/g, ''), 'from-sub\n');
      // nothing escaped, nothing of Explore's
      for (const name of ['escape.txt', 'escape2.txt', 'explore-made.txt']) {
        assert(!isFile(join(project, name)), `${name} is in the main folder`);
      }
      assertEquals(git(project, 'status', '--porcelain'), '', 'the main folder is clean after the landing');
      // one record: the builder's (Explore and the fork prepared none); it goes once landed, and its worktree with it
      const recordsFile = join(fx.state, 'subagent-worktrees.json');
      const readRecords = () => Object.values(JSON.parse(fileText(recordsFile)).subagents as Record<string, Json>);
      await waitFor(() => !readRecords().filter((r) => r.state !== 'spare').length, 'the landed record to be released', 90);
      const helpers = Object.values(JSON.parse(fileText(join(fx.state, 'swarm-helpers.json'))).helpers as Record<string, Json>);
      const landed = helpers.filter((h) => h.kind === 'subagent' && h.state === 'merged');
      assertEquals(landed.length, 1, JSON.stringify(helpers));
      const wtPath = String((landed[0].worktree as Json).path);
      assert(/[\\/]worktrees[\\/][0-9a-f]+[\\/]sub-/.test(wtPath), wtPath);
      await waitFor(() => !isDir(wtPath), 'the landed worktree folder to go', 60);
      // the chat said how its subagents work, and Activity shows isolation on
      const state = await chat.state();
      assertEquals((state.subagentIsolation as Json | undefined)?.on, true, JSON.stringify(state.subagentIsolation));
      assert(
        notes(state.events).some((n) => n.includes('Qwen subagents that edit files work in their own git worktree')),
        JSON.stringify(notes(state.events)),
      );
      // AIB's own system settings file carries the hooks; no hook command starts with a double quote; the key is not in it
      const files: string[] = [];
      for (const e of Deno.readDirSync(join(fx.state, 'qwen'))) {
        const f = join(fx.state, 'qwen', e.name, 'settings.json');
        if (isFile(f)) files.push(f);
      }
      assertEquals(files.length, 1, JSON.stringify(files));
      const settings = JSON.parse(fileText(files[0])) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
        permissions: { deny: string[] };
      };
      assertEquals(Object.keys(settings.hooks), ['PreToolUse', 'SubagentStart', 'SubagentStop']);
      for (const groups of Object.values(settings.hooks)) {
        for (const g of groups) {
          for (const h of g.hooks) {
            assert(!h.command.startsWith('"') && h.command.includes(' hook qwen-') && h.command.endsWith('|| exit 2'), h.command);
          }
        }
      }
      assert(settings.permissions.deny.includes('Agent(claude-code)'));
      assert(!fileText(files[0]).includes('AIB_HOOK_KEY'));
      assert(!stub.text().includes('AIB_HOOK_KEY'), 'no key reached the model');
      assert(!isFile(join(qwenHome, 'AIB.json')) && !isDir(join(qwenHome, 'aib')), "AIB wrote nothing into the user's Qwen folder");
      await sleep(1500); // nothing lands later either
      assertEquals(git(project, 'log', '--format=%s', '-n', '10').split('\n').filter((l) => l.startsWith('AIB: subagent')).length, 1);
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: 'QwenHooksOffTest test_hooks_off_turns_subagents_off',
  ignore: !ok,
  ...T,
  async fn() {
    const rules = (_project: string) => [
      { when: 'QW-OFF', reply: { text: 'finding the agent tool', tools: [search('toolu_ts9')] } },
      { when: 'toolu_ts9', reply: { text: 'OFF-DONE' } },
    ];
    const { fx, chat, project, stub, cleanup } = await play(rules, { disableAllHooks: true }, 'QW-OFF', async ({ stub }) => {
      await waitFor(() => stub.dumped().includes('toolu_ts9'), 'tool_search to answer', 120);
    });
    try {
      // the model was told the agent tool does not exist: tool_search found nothing
      assert(stub.dumped().includes('Not found: agent'), 'tool_search select:agent said "Not found: agent"');
      const state = await chat.state();
      assertEquals((state.subagentIsolation as Json | undefined)?.on, false, JSON.stringify(state.subagentIsolation));
      assert(
        notes(state.events).some((n) => n.includes('Subagents are off in this Qwen chat') && n.includes('disableAllHooks')),
        JSON.stringify(notes(state.events)),
      );
      assert(stub.dumped().includes('turned off, because AIB could not give them their own git worktree'), 'the agent was told');
      const files: string[] = [];
      for (const e of Deno.readDirSync(join(fx.state, 'qwen'))) {
        const f = join(fx.state, 'qwen', e.name, 'settings.json');
        if (isFile(f)) files.push(f);
      }
      assertEquals(files.length, 1);
      const settings = JSON.parse(fileText(files[0])) as { hooks?: unknown; permissions: { deny: string[] } };
      assert(settings.permissions.deny.includes('agent'));
      assertEquals(settings.hooks, undefined, 'no AIB hook when hooks are off');
      assertEquals(git(project, 'status', '--porcelain'), '');
      assertEquals(git(project, 'log', '--format=%s', '-n', '3').split('\n').filter((l) => l.startsWith('AIB: subagent')).length, 0);
    } finally {
      await cleanup();
    }
  },
});
