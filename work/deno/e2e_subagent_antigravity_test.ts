/**
 * Subagent worktrees, Antigravity CLI (server/subagents/antigravity.ts; keeper/hookforward_agy.go): e2e with the REAL `agy` 1.5.11 over
 * ACP (as AIB launches it: AIB's own managed install, used read only through a junction, started with --gemini-dir <AIB's folder> because
 * a dummy API key is saved) against the Gemini API stub (work/gemini_stub_api.js, GOOGLE_GEMINI_BASE_URL), a real AIB (deno-split web
 * server + agent host) and the real keeper program (built from keeper/ with Go: the hook forwarder). Temp config only (HOME, USERPROFILE
 * and the gemini folder are temp folders), no real account, no network. Owner rule: an agent's own subagent that edits files works in
 * its own git worktree, and AIB lands it. Facts: aib-shared/research/provider-builder-probe-2026-11-25.md.
 *
 *   AgyWorktreeTest   the parent defines a subagent type that may start subagents (AIB turns that off), starts one with Workspace
 *                     "inherit" (AIB makes it "branch": agy makes a real git worktree and branch), then tries run_workflow and a swarm
 *                     worker (denied). The subagent writes inside its worktree (allowed), writes <project>\escape.txt by absolute path
 *                     (denied, names the worktree), redirects shell output into the main folder (denied), and runs a command (it starts
 *                     in its worktree). At its end its two files land as one AIB commit; nothing else is in the folder; agy's worktree,
 *                     branch and AIB's record go; the parent is told. AIB's hooks.json entry sits in the gemini folder (no command
 *                     starts with a double quote, no key in it); the owner's ~/.gemini, ~/.claude, ~/.codex and ~/.qwen are untouched.
 *
 * Needs node (22+), Go (the keeper program is built from keeper/ into a temp folder; AIB_TEST_KEEPER_BIN names a built one) and AIB's
 * managed agy install (AIB_AGY_DIR = the folder holding agy and .complete; default: %LOCALAPPDATA%\AIB\agents\antigravity\1.5.11,
 * Linux: ~/.local/share/AIB/agents/antigravity/1.5.11). Run with TEMP/TMP (and AIB_TEST_AGENT_TMP) pointed at a scratch folder.
 * WSL: agy is not installed in the Ubuntu distro here, so the WSL route is tested with fakes (work/deno/wsl_subagent_hooks_test.ts).
 */
import { assert, assertEquals, Chat, E2EFixture, git, isDir, isFile, Json, sleep, waitFor, WORK_DIR } from './_e2e.ts';
import { agentTempRoot, approveAll, HAVE_KEEPER_BIN, join, keeperProgram, makeProject, NODE_EXE, SERVER_SPLIT, T, Temp, uuid } from './_e2e_real.ts';

const WIN = Deno.build.os === 'windows';
const HOME = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '';
const AGY_DIR = Deno.env.get('AIB_AGY_DIR') ??
  (WIN
    ? join(Deno.env.get('LOCALAPPDATA') ?? '', 'AIB', 'agents', 'antigravity', '1.5.11')
    : join(HOME, '.local', 'share', 'AIB', 'agents', 'antigravity', '1.5.11'));
const AGY_PROGRAM = join(AGY_DIR, WIN ? 'agy.exe' : 'agy');
const ok = !!(NODE_EXE && isFile(AGY_PROGRAM) && isFile(join(AGY_DIR, '.complete')) && HAVE_KEEPER_BIN && SERVER_SPLIT);
const STUB_JS = join(WORK_DIR, 'gemini_stub_api.js');

/** What a run must not change: the owner's ~/.gemini (listing, mtimes), ~/.claude settings and projects, ~/.codex config, ~/.qwen. */
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
  for (const name of ['.gemini', '.qwen']) {
    const files: [string, number][] = [];
    walk(join(HOME, name), files);
    out[name] = files.sort((a, b) => a[0].localeCompare(b[0]));
  }
  for (const f of [join(HOME, '.claude', 'settings.json'), join(HOME, '.claude', 'settings.local.json'), join(HOME, '.codex', 'config.toml'), join(HOME, '.codex', 'hooks.json')]) {
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

/** <state>/agents/antigravity/1.5.11 is a junction to the managed install (read only: it holds agy and .complete). */
function installAgy(state: string): string {
  const base = join(state, 'agents', 'antigravity');
  Deno.mkdirSync(base, { recursive: true });
  const link = join(base, '1.5.11');
  if (WIN) {
    const r = new Deno.Command('cmd', { args: ['/c', 'mklink', '/J', link, AGY_DIR], stdout: 'piped', stderr: 'piped' }).outputSync();
    if (r.code !== 0) throw new Error('mklink failed');
  } else Deno.symlinkSync(AGY_DIR, link, { type: 'dir' });
  return link;
}

const unlink = (link: string) => {
  try {
    Deno.removeSync(link); // the link only, never its target
  } catch { /* gone */ }
};

/** The Gemini API stub (work/gemini_stub_api.js) on a port the OS picks; it stops when its stdin closes. */
class GeminiStub {
  url = '';
  readonly log: string;
  readonly dump: string;
  #child!: Deno.ChildProcess;
  #stdin!: WritableStreamDefaultWriter<Uint8Array>;
  private constructor(readonly folder: string) {
    this.log = join(folder, 'stub.log');
    this.dump = join(folder, 'dump');
  }
  static async start(folder: string, rules: unknown[]): Promise<GeminiStub> {
    const stub = new GeminiStub(folder);
    const script = join(folder, 'script.json');
    Deno.writeTextFileSync(script, JSON.stringify({ rules }));
    Deno.mkdirSync(stub.dump, { recursive: true });
    stub.#child = new Deno.Command(NODE_EXE!, {
      args: [STUB_JS, '--port', '0', '--log', stub.log, '--script', script, '--dump', stub.dump, '--stdin'],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    stub.#stdin = stub.#child.stdin.getWriter();
    const reader = stub.#child.stdout.getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stub did not start: ${text}`);
      text += new TextDecoder().decode(value);
      const m = /STUB_PORT=(\d+)/.exec(text);
      if (m) {
        stub.url = `http://127.0.0.1:${m[1]}`;
        break;
      }
    }
    reader.releaseLock();
    stub.#child.stdout.pipeTo(new WritableStream()).catch(() => {});
    return stub;
  }
  async stop(): Promise<void> {
    try {
      await this.#stdin.close();
    } catch { /* closed */ }
    const done = await Promise.race([this.#child.status, sleep(5000).then(() => null)]);
    if (done === null) {
      try {
        this.#child.kill('SIGKILL'); // only the process this test started
      } catch { /* gone */ }
      await this.#child.status;
    }
  }
  text(): string {
    try {
      return Deno.readTextFileSync(this.log);
    } catch {
      return '';
    }
  }
  /** Everything the model was sent (the dump files, joined). */
  dumped(): string {
    try {
      return [...Deno.readDirSync(this.dump)].filter((e) => e.isFile).map((e) => Deno.readTextFileSync(join(this.dump, e.name))).join('\n');
    } catch {
      return '';
    }
  }
}

class AgyFixture extends E2EFixture {
  constructor(parent: string, extraEnv: Record<string, string>) {
    super('worktree-e2e-agent.mjs', parent, extraEnv);
    this.scrub = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']; // not GOOGLE_GEMINI_BASE_URL: the stub's address is set by this test (scrub applies to extraEnv too)
  }
}

const call = (name: string, args: Json) => ({ call: { name, args } });
const fileText = (p: string) => Deno.readTextFileSync(p);
const notes = (events: { kind: string; data: Json }[]) => events.filter((e) => e.kind === 'studio_note').map((e) => JSON.stringify(e.data));

function rulesFor(project: string): unknown[] {
  const shellEscape = WIN ? `echo escaped> "${join(project, 'escape2.txt')}"` : `echo escaped > '${join(project, 'escape2.txt')}'`;
  const slash = WIN ? '\\' : '/';
  return [
    // the parent: define a type that may start subagents, start one (asking for the folder itself), then the spawn tools AIB denies
    {
      when: 'AGY-GO',
      tools: ['define_subagent'],
      reply: call('define_subagent', { Name: 'builder', Description: 'builds files', SystemPrompt: 'You build files.', EnableWriteTools: true, EnableSubagentTools: true }),
    },
    {
      when: '"name":"define_subagent"',
      tools: ['invoke_subagent'],
      reply: call('invoke_subagent', { TypeName: 'builder', Role: 'Builder Agent', Prompt: 'SUBPROMPT-A write the files', Workspace: 'inherit' }),
    },
    { when: '"name":"invoke_subagent"', tools: ['run_workflow'], reply: call('run_workflow', { Script: 'print(1)', Description: 'AGY-WORKFLOW' }) },
    {
      when: '"name":"run_workflow"',
      tools: ['swarm'],
      reply: call('swarm', { action: 'add', name: 'worker', brief: 'AGY-SWARM', workspace: 'branch' }),
    },
    { when: '"name":"swarm"', reply: { text: 'PARENT-DONE' } },
    // the builder: its worktree is the "Command Working Directory" agy tells every agent
    {
      when: 'SUBPROMPT-A',
      tools: ['write_file'],
      capture: 'Command Working Directory: (.*?)\\\\nFiles relating',
      reply: call('write_file', { Path: `@CAP@${slash}sub-made.txt`, Content: 'from-sub\n', Overwrite: true }),
    },
    {
      when: '"name":"write_file"',
      tools: ['write_file'],
      reply: call('write_file', { Path: join(project, 'escape.txt'), Content: 'escaped\n', Overwrite: true }),
    },
    {
      when: '"name":"write_file"',
      tools: ['run_command'],
      reply: call('run_command', { CommandLine: shellEscape, toolSummary: 'escape', WaitMsBeforeAsync: 3000 }),
    },
    {
      when: '"name":"run_command"',
      tools: ['run_command'],
      reply: call('run_command', { CommandLine: 'echo hi > shell-made.txt', toolSummary: 'where am I', WaitMsBeforeAsync: 3000 }),
    },
    { when: '"name":"run_command"', tools: ['run_command'], reply: { text: 'SUB-A-DONE' } },
  ];
}

Deno.test({
  name: 'AgyWorktreeTest test_subagent_edits_land_from_its_worktree_and_escapes_are_denied',
  ignore: !ok,
  ...T,
  async fn() {
    const temp = new Temp('aib-sra-');
    if (temp.path.includes(' ')) throw new Error('the temp folder has a space: agy hooks cannot name the keeper there (TEMP=a scratch folder)');
    const run = uuid().slice(0, 8);
    const project = makeProject(temp.path, `sra${run}`);
    const before = ownerState();
    const stub = await GeminiStub.start(temp.path, rulesFor(project));
    const keeper = keeperProgram();
    temp.mkdir('tmp');
    const tmp = temp.join('tmp');
    const fx = new AgyFixture(agentTempRoot(), {
      AGENT_STUDIO_ALLOW_REAL_AGENT: '1',
      AIB_KEEPER_BIN: keeper,
      GOOGLE_GEMINI_BASE_URL: stub.url,
      TEMP: tmp,
      TMP: tmp,
      TMPDIR: tmp,
    });
    const link = installAgy(fx.state);
    // a dummy API key saved in the settings: agy then runs with AIB's own --gemini-dir (never ~/.gemini), and AIB can give it hooks
    Deno.writeTextFileSync(join(fx.state, 'studio-settings.json'), JSON.stringify({ version: 1, agents: { betaKeys: { antigravity: 'AIza-dummy-not-a-real-key-000000000000' } } }));
    const cleanup = async () => {
      unlink(link); // before the state folder is removed: never delete through the junction
      await fx.cleanup();
      await stub.stop();
      try {
        const after = ownerState();
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
        assertEquals(changed, [], "the owner's ~/.gemini, ~/.claude, ~/.codex or ~/.qwen changed");
      } finally {
        temp[Symbol.dispose]();
      }
    };
    let seen: Chat | null = null;
    try {
      const web = await fx.startWeb();
      const [status, connection] = await web.post('connect', { provider: 'antigravity', cwd: project, background: true });
      assertEquals(status, 200, JSON.stringify(connection));
      const chat = new Chat(null, connection.id as string, web);
      seen = chat;
      await waitFor(
        async () => {
          const s = await chat.state();
          if (s.error) throw new Error(String(s.error));
          return s.ready;
        },
        'chat ready',
        180,
      );
      // NEVER send a prompt unless the chat runs on the dummy key with AIB's own folder and the stub: without the key agy would use the
      // person's own Google sign-in (the OS keyring) and a prompt would reach Google with a real account
      const first = await chat.state();
      assertEquals((first.subagentIsolation as Json | undefined)?.on, true, `not a key chat: ${JSON.stringify(first.subagentIsolation)}`);
      assert(isFile(join(fx.state, 'agents', 'antigravity', 'gemini-home', 'config', 'hooks.json')), "AIB's own gemini folder has the hooks");
      await web.post('mode', { id: chat.id, modeId: 'accept-edits' });
      const [c2] = await web.post('prompt', { id: chat.id, text: `AGY-GO ${run}`, clientMessageId: uuid() });
      assertEquals(c2, 200);
      await waitFor(
        async () => {
          await approveAll(chat);
          return stub.dumped().includes('PARENT-DONE') || stub.text().includes('PARENT-DONE');
        },
        'the parent to finish its steps',
        90,
      );
      await waitFor(
        async () => {
          await approveAll(chat);
          return git(project, 'log', '--format=%s', '-n', '10').includes('AIB: subagent Builder Agent');
        },
        'the subagent work to land',
        240,
      );
      const sent = stub.dumped();
      // the denials reached the model with AIB's reasons
      assert(sent.includes('works in its own git worktree'), 'the subagent was told where it works');
      assert(sent.includes("Workflows aren't available in AIB chats"), 'run_workflow was refused');
      assert(sent.includes("Swarm workers aren't available in AIB chats"), 'the swarm worker was refused');
      assert(sent.includes('A pre-tool hook changed the arguments of this tool call before it ran'), 'agy told the parent its call was rewritten');
      assert(
        sent.includes('Subagents you start with invoke_subagent that edit files work in their own git worktree'),
        'the rule reached the model',
      );
      // landed: exactly the two files the subagent made inside its worktree
      assertEquals(git(project, 'show', '--name-only', '--format=', 'HEAD').split(/\s+/).filter(Boolean).sort(), ['shell-made.txt', 'sub-made.txt']);
      assertEquals(fileText(join(project, 'sub-made.txt')).replace(/\r/g, ''), 'from-sub\n');
      for (const name of ['escape.txt', 'escape2.txt']) assert(!isFile(join(project, name)), `${name} is in the main folder`);
      assertEquals(git(project, 'status', '--porcelain'), '', 'the main folder is clean after the landing');
      // one record, released after the landing; agy's worktree and branch are gone, the project's own branches stay
      const recordsFile = join(fx.state, 'subagent-worktrees.json');
      const readRecords = () => Object.values(JSON.parse(fileText(recordsFile)).subagents as Record<string, Json>);
      await waitFor(() => !readRecords().length, 'the landed record to be released', 120);
      const helpers = Object.values(JSON.parse(fileText(join(fx.state, 'swarm-helpers.json'))).helpers as Record<string, Json>);
      const landed = helpers.filter((h) => h.kind === 'subagent' && h.state === 'merged');
      assertEquals(landed.length, 1, JSON.stringify(helpers));
      const wtPath = String((landed[0].worktree as Json).path);
      assert(/antigravity-cli[\\/]worktrees[\\/][0-9a-f-]+[\\/]subagent-Builder-Agent-builder-/.test(wtPath), wtPath);
      await waitFor(() => !isDir(wtPath), "agy's worktree folder to go", 60);
      assertEquals(git(project, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter((b) => b.startsWith('subagent-')), [], "agy's branch");
      assert(!git(project, 'worktree', 'list').includes('subagent-'), git(project, 'worktree', 'list'));
      // the chat said how its subagents work; Activity shows isolation on
      const state = await chat.state();
      assertEquals((state.subagentIsolation as Json | undefined)?.on, true, JSON.stringify(state.subagentIsolation));
      assert(
        notes(state.events).some((n) => n.includes('Antigravity subagents that edit files work in their own git worktree')),
        JSON.stringify(notes(state.events)),
      );
      // the chat shows the merge, and the parent is told through the steer lane (its next model request carries the line)
      assert(
        notes(state.events).some((n) => n.includes('Merged subagent') && n.includes('Builder Agent') && n.includes('2 files')),
        JSON.stringify(notes(state.events)),
      );
      await waitFor(
        () => stub.dumped().includes('landed in this folder on') && stub.dumped().includes('There is nothing for you to merge'),
        'the parent to be told what landed',
        90,
      );
      // AIB's own gemini folder carries the hooks; no command starts with a double quote; the key is not in the file
      const gd = join(fx.state, 'agents', 'antigravity', 'gemini-home');
      const hooksFile = join(gd, 'config', 'hooks.json');
      assert(isFile(hooksFile), hooksFile);
      const hooks = JSON.parse(fileText(hooksFile)) as Record<string, Record<string, unknown>>;
      assertEquals(Object.keys(hooks), ['aib-subagents']);
      assertEquals(Object.keys(hooks['aib-subagents']), ['PreToolUse', 'SessionStart', 'Stop']);
      const commands: string[] = [];
      for (const group of hooks['aib-subagents'].PreToolUse as { hooks: { command: string }[] }[]) for (const h of group.hooks) commands.push(h.command);
      for (const h of [...(hooks['aib-subagents'].SessionStart as { command: string }[]), ...(hooks['aib-subagents'].Stop as { command: string }[])]) commands.push(h.command);
      assertEquals(commands.length, 3);
      for (const c of commands) assert(!c.startsWith('"') && c.includes(' hook agy-'), c);
      assert(!fileText(hooksFile).includes('AIB_HOOK_KEY'));
      assert(!stub.text().includes('AIB_HOOK_KEY'), 'no key reached the model');
      assert(!isFile(join(project, '.agents', 'hooks.json')) && !isDir(join(project, '.agents')), 'nothing was written into the project');
      await sleep(1500); // nothing lands later either
      assertEquals(git(project, 'log', '--format=%s', '-n', '10').split('\n').filter((l) => l.startsWith('AIB: subagent')).length, 1);
    } catch (error) {
      console.error(stub.text().split('\n').slice(-12).map((l) => l.slice(0, 400)).join('\n'));
      const keep = Deno.env.get('AIB_TEST_KEEP'); // a folder to copy the stub's log and what the model was sent to, for a failed run
      if (keep) {
        try {
          Deno.mkdirSync(keep, { recursive: true });
          Deno.writeTextFileSync(join(keep, 'stub.log'), stub.text());
          for (const e of Deno.readDirSync(stub.dump)) Deno.copyFileSync(join(stub.dump, e.name), join(keep, e.name));
          if (seen) Deno.writeTextFileSync(join(keep, 'state.json'), JSON.stringify(await seen.state().catch((e) => String(e))).slice(0, 80000));
          const copy = (dir: string) => {
            for (const e of Deno.readDirSync(dir)) {
              const p = join(dir, e.name);
              if (e.isDirectory && !/node_modules|worktrees|\.deno|^1\.5\.11$|^brain$|^conversations$/.test(e.name)) copy(p);
              else if (e.isFile && /\.(log|jsonl)$/.test(e.name) || e.name === 'hooks.json') Deno.copyFileSync(p, join(keep, `${e.name.replace(/[^\w.-]/g, '_')}`));
            }
          };
          copy(fx.root);
        } catch { /* best effort */ }
      }
      const logs: string[] = [];
      const walk = (dir: string) => {
        try {
          for (const e of Deno.readDirSync(dir)) {
            const p = join(dir, e.name);
            if (e.isDirectory) walk(p);
            else if (e.name.endsWith('.log')) logs.push(...fileText(p).split('\n').filter((x) => /ubagent|hook|antigravity|agy/i.test(x)).slice(-25));
          }
        } catch { /* gone */ }
      };
      walk(fx.root);
      console.error(logs.join('\n').slice(-5000));
      await cleanup().catch(() => {});
      throw error;
    }
    await cleanup();
  },
});
