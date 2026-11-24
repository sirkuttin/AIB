/**
 * Subagent worktrees, Gemini CLI part (the port of work/test_gemini_subagent_e2e.py): e2e with the REAL Gemini CLI over ACP (as AIB
 * launches it) against the local Gemini API stub (work/gemini_stub_api.js, model pinned with GEMINI_MODEL so the router never calls),
 * temp config only. Design: aib-shared designs/subagent-worktrees/gemini-proof.md; code: server/subagents/gemini.ts.
 *
 *   GeminiRedirectTest   a real AIB (deno-split web server + agent host) starts a Gemini chat (API-key sign-in) in a temp git project.
 *                        The parent writes parent-made.txt, then invokes the generalist subagent, which writes sub-made.txt (a path
 *                        relative to the folder) and finishes.
 *                          - the subagent's write was moved into its worktree (Gemini told the subagent its input was changed by a
 *                            hook; the folder never had the file while it ran: it arrives only as AIB's landing commit)
 *                          - at the parent's turn end it lands in the folder as one AIB commit; the record and worktree go
 *                          - the parent is unaffected: its own write is in the folder, uncommitted
 *                          - the chat home is AIB's (its settings have AIB's hook); the "user's" Gemini settings file is unchanged
 *   GeminiFenceTest      the same play with hooks off in the user's Gemini settings: the fence alone. The subagent's write is denied
 *                        by AIB's policy (Gemini's "denied by policy" text with AIB's reason reaches the subagent), nothing is written
 *                        anywhere, the parent's own write works, and the chat says up front that subagent edits are off.
 *   Both: the owner's ~/.gemini (listing, mtimes), ~/.claude settings and projects, ~/.codex config, hooks and sessions are untouched
 *   (not ~/.claude.json: the owner's own running Claude Code sessions rewrite it). The chat runs in yolo in a folder the user trusted:
 *   Gemini 0.68 itself refuses invoke_agent in its default ACP mode, with or without AIB.
 *   The redirect test also checks the Activity card (from the invoke_agent call: running, then completed) and its worktree line.
 *
 * Needs node, Go (the keeper program is built from keeper/ into a temp folder; AIB_TEST_KEEPER_BIN names a built one) and the Gemini
 * CLI 0.68 package folder (AIB_GEMINI_CLI = the folder holding node_modules/@google/gemini-cli; default: .gem-scratch/gemini-cli in
 * this worktree). Run with TEMP/TMP pointed at a scratch folder.
 */
import { assert, assertEquals, Chat, git, isDir, isFile, Json, sleep, waitFor } from './_e2e.ts';
import {
  agentTempRoot,
  approveAll,
  HAVE_KEEPER_BIN,
  join,
  keeperProgram,
  makeProject,
  NODE_EXE,
  REPO_DIR,
  SERVER_SPLIT,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';
import { E2EFixture } from './_e2e.ts';

const WORK = join(REPO_DIR, 'work');
const STUB = join(WORK, 'gemini_stub_api.js');
const GEMINI_CLI = Deno.env.get('AIB_GEMINI_CLI') ?? join(REPO_DIR, '.gem-scratch', 'gemini-cli');
const GEMINI_PKG = join(GEMINI_CLI, 'node_modules', '@google', 'gemini-cli');
const FENCE_TEXT = "AIB: this subagent can't change files in the project folder.";
const OFF_LINE = 'Subagents that edit files are off in this Gemini chat: hooks are off in your Gemini settings.';
const WIN = Deno.build.os === 'windows';
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const ok = !!(NODE_EXE && isDir(GEMINI_PKG) && HAVE_KEEPER_BIN && SERVER_SPLIT);

/** What a run must not change: the owner's ~/.gemini (listing and mtimes), ~/.claude settings and projects, ~/.codex config and sessions. */
function ownerState(): Record<string, unknown> {
  const home = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '';
  const out: Record<string, unknown> = {};
  const gem = join(home, '.gemini');
  try {
    out.gemini = [...Deno.readDirSync(gem)].map((e) => [e.name, Deno.statSync(join(gem, e.name)).mtime?.getTime() ?? 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  } catch {
    out.gemini = null;
  }
  // not ~/.claude.json: the owner's own running Claude Code sessions rewrite it all the time
  for (const f of [join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json'), join(home, '.codex', 'config.toml'), join(home, '.codex', 'hooks.json')]) {
    try {
      out[f] = Deno.statSync(f).mtime?.getTime() ?? null;
    } catch {
      out[f] = null;
    }
  }
  try {
    out.claude_projects = [...Deno.readDirSync(join(home, '.claude', 'projects'))].map((e) => e.name).sort();
  } catch {
    out.claude_projects = [];
  }
  let count = 0;
  const walk = (dir: string) => {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (e.isDirectory) walk(join(dir, e.name));
        else if (e.name.endsWith('.jsonl')) count++;
      }
    } catch { /* none */ }
  };
  walk(join(home, '.codex', 'sessions'));
  out.codex_sessions = count;
  return out;
}

/** The play: the parent writes, then invokes the generalist; the subagent writes a relative path and finishes. */
function script(run: string) {
  return {
    rules: [
      { when: `GX-PARENT-${run}`, tools: ['invoke_agent'], reply: { call: { name: 'write_file', args: { file_path: 'parent-made.txt', content: `PARENT ${run}\n` } } } },
      { when: 'functionResponse', tools: ['invoke_agent'], reply: { call: { name: 'invoke_agent', args: { agent_name: 'generalist', prompt: `GX-SUB-${run} write the file` } } } },
      { when: `GX-SUB-${run}`, in: 'any', tools: ['complete_task'], reply: { call: { name: 'write_file', args: { file_path: 'sub-made.txt', content: `SUB ${run}\n` } } } },
      { when: 'functionResponse', in: 'last', tools: ['complete_task'], reply: { call: { name: 'complete_task', args: { result: `SUB-DONE ${run}` } } } },
      { when: 'functionResponse', tools: ['invoke_agent'], reply: { text: `PARENT-DONE ${run}` } },
    ],
  };
}

class GeminiStub {
  port = 0;
  log: string;
  #child!: Deno.ChildProcess;
  #stdin!: WritableStreamDefaultWriter<Uint8Array>;
  constructor(folder: string) {
    this.log = join(folder, 'stub.log');
  }
  static async start(folder: string, run: string): Promise<GeminiStub> {
    const stub = new GeminiStub(folder);
    const sc = join(folder, 'script.json');
    Deno.writeTextFileSync(sc, JSON.stringify(script(run)));
    stub.#child = new Deno.Command(NODE_EXE!, { args: [STUB, '--script', sc, '--log', stub.log, '--stdin'], stdin: 'piped', stdout: 'piped', stderr: 'null' }).spawn();
    stub.#stdin = stub.#child.stdin.getWriter();
    const reader = stub.#child.stdout.getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stub did not start: ${text}`);
      text += dec(value);
      const m = /STUB_PORT=(\d+)/.exec(text);
      if (m) {
        stub.port = Number(m[1]);
        break;
      }
    }
    reader.releaseLock();
    stub.#child.stdout.pipeTo(new WritableStream()).catch(() => {});
    return stub;
  }
  async stop() {
    try {
      await this.#stdin.close();
    } catch { /* closed */ }
    const r = await Promise.race([this.#child.status, sleep(10000).then(() => null)]);
    if (r === null) {
      try {
        this.#child.kill('SIGKILL');
      } catch { /* gone */ }
    }
  }
  text(): string {
    try {
      return Deno.readTextFileSync(this.log);
    } catch {
      return '';
    }
  }
}

/** AIB's own install layout (<state>/agents/gemini/<version>, with .complete) as a junction to the test's Gemini CLI folder. */
function installGemini(state: string): string {
  const base = join(state, 'agents', 'gemini');
  Deno.mkdirSync(base, { recursive: true });
  const link = join(base, '0.68.0');
  Deno.writeTextFileSync(join(GEMINI_CLI, '.complete'), '');
  try {
    Deno.lstatSync(link);
  } catch {
    if (WIN) {
      const r = new Deno.Command('cmd', { args: ['/c', 'mklink', '/J', link, GEMINI_CLI], stdout: 'piped', stderr: 'piped' }).outputSync();
      if (r.code !== 0) throw new Error('mklink failed');
    } else Deno.symlinkSync(GEMINI_CLI, link, { type: 'dir' });
  }
  return link;
}

function unlinkJunction(link: string) {
  try {
    if (WIN) Deno.removeSync(link); // the link only, never its target
    else Deno.removeSync(link);
  } catch { /* gone */ }
}

class GeminiFixture extends E2EFixture {
  constructor(parent: string, extraEnv: Record<string, string>) {
    super('worktree-e2e-agent.py', parent, extraEnv);
    this.scrub = ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI'];
  }
  override agentFlags(): string[] {
    const flags = super.agentFlags();
    flags[flags.indexOf('--node-command') + 1] = NODE_EXE!; // AIB runs its own Gemini install with node
    return flags;
  }
}

/** The play with the user's Gemini settings as `hooksOff` says; returns what the tests look at. */
async function play(hooksOff: boolean) {
  const temp = new Temp('aib-srg-');
  const run = uuid().slice(0, 8);
  const project = makeProject(temp.path, `srg${run}`);
  const before = ownerState();
  const userHome = temp.join('user-gemini-home'); // "the user's" Gemini home (GEMINI_CLI_HOME): never the owner's
  Deno.mkdirSync(join(userHome, '.gemini', 'tmp'), { recursive: true });
  const userSettings: Json = { general: { checkpointing: { enabled: false } } };
  if (hooksOff) userSettings.hooksConfig = { enabled: false };
  // the user trusted this folder (Gemini allows yolo only in a trusted folder): their trustedFolders.json
  Deno.writeTextFileSync(join(userHome, '.gemini', 'trustedFolders.json'), JSON.stringify({ [project]: 'TRUST_FOLDER' }));
  const settingsFile = join(userHome, '.gemini', 'settings.json');
  Deno.writeTextFileSync(settingsFile, JSON.stringify(userSettings));
  const settingsBefore = Deno.readFileSync(settingsFile);
  const stub = await GeminiStub.start(temp.path, run);
  const keeper = keeperProgram();
  temp.mkdir('tmp');
  const tmp = temp.join('tmp');
  const fx = new GeminiFixture(agentTempRoot(), {
    AGENT_STUDIO_ALLOW_REAL_AGENT: '1',
    AIB_KEEPER_BIN: keeper,
    GEMINI_CLI_HOME: userHome,
    GEMINI_API_KEY: 'fake-key',
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${stub.port}`,
    GEMINI_CLI_AUTH_OVERRIDE: 'gemini-api-key',
    GEMINI_MODEL: 'gemini-2.5-flash',
    NO_BROWSER: '1',
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
  });
  const installed = installGemini(fx.state);
  const cleanup = async () => {
    unlinkJunction(installed); // before the state folder is removed: never delete through the junction
    await fx.cleanup();
    await stub.stop();
    try {
      const after = ownerState();
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
      assertEquals(changed, [], "the owner's ~/.gemini, ~/.claude or ~/.codex changed");
    } finally {
      temp[Symbol.dispose]();
    }
  };
  try {
    const web = await fx.startWeb();
    const [status, connection] = await web.post('connect', { provider: 'gemini', cwd: project, background: true });
    assertEquals(status, 200, JSON.stringify(connection));
    const chat = new Chat(null, connection.id as string, web);
    await waitFor(async () => {
      const s = await chat.state();
      if (s.error) throw new Error(String(s.error));
      return s.ready;
    }, 'chat ready', 120);
    // Gemini 0.68 itself refuses invoke_agent in its default ACP mode, with or without AIB ("Tool execution for "Generalist
    // Agent" denied by policy": checked with no --admin-policy); in yolo it runs subagents. The fence must hold there too.
    const [code, changed] = await web.post('mode', { id: chat.id, modeId: 'yolo' });
    assertEquals(code, 200, JSON.stringify(changed));
    const [c2] = await web.post('prompt', { id: chat.id, text: `GX-PARENT-${run} go`, clientMessageId: uuid() });
    assertEquals(c2, 200);
    await waitFor(async () => {
      await approveAll(chat);
      const state = await chat.state();
      return !state.busy && state.events.some((e) => e.kind === 'turn_end');
    }, 'the parent turn to end', 240);
    assert(stub.text().includes(`PARENT-DONE ${run}`));
    assertEquals(Array.from(Deno.readFileSync(settingsFile)), Array.from(settingsBefore), "the user's Gemini settings were written");
    return { fx, chat, project, stub, run, userHome, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

const fileText = (p: string) => Deno.readTextFileSync(p);

Deno.test({
  name: 'GeminiRedirectTest test_subagent_write_lands_in_its_worktree_then_at_turn_end',
  ignore: !ok,
  ...T,
  async fn() {
    const { fx, chat, project, stub, run, userHome, cleanup } = await play(false);
    try {
      const log = stub.text();
      // the subagent's write ran, with its file_path moved by AIB's hook (Gemini says so in the subagent's tool result)
      assert(log.includes('were modified by a hook'));
      assert(!log.includes('denied by policy'));
      // parent unaffected: its own write is in the folder, uncommitted
      assertEquals(fileText(join(project, 'parent-made.txt')), `PARENT ${run}\n`);
      // at turn end the subagent's work lands as AIB's commit (the swarm landing), and nothing else of the parent's is committed
      await waitFor(() => isFile(join(project, 'sub-made.txt')) && git(project, 'show', '--name-only', '--format=%s', 'HEAD').includes('sub-made.txt'), 'the subagent work to land', 120);
      assertEquals(fileText(join(project, 'sub-made.txt')), `SUB ${run}\n`);
      const subject = git(project, 'log', '-1', '--format=%s');
      assert(subject.toLowerCase().includes('subagent'), subject);
      assertEquals(git(project, 'show', '--name-only', '--format=', 'HEAD').split(/\s+/).filter(Boolean), ['sub-made.txt'], 'only the subagent file landed');
      assert(git(project, 'status', '--porcelain').includes('?? parent-made.txt'));
      // the record goes and its worktree with it, once landed
      const recordsFile = join(fx.state, 'subagent-worktrees.json');
      const readRecords = () => Object.values(JSON.parse(fileText(recordsFile)).subagents as Record<string, Json>);
      await waitFor(() => !readRecords().filter((r) => r.state !== 'spare').length, 'the landed record to be released', 60);
      const spares = readRecords();
      assert(spares.length <= 1, 'at most the chat spare stays while the chat is open');
      const helpers = Object.values(JSON.parse(fileText(join(fx.state, 'swarm-helpers.json'))).helpers as Record<string, Json>);
      const landedPaths = helpers.filter((h) => h.kind === 'subagent' && h.state === 'merged').map((h) => String((h.worktree as Json).path));
      assertEquals(landedPaths.length, 1, JSON.stringify(helpers));
      assert(/[\\/]\.gem-[0-9a-f]{32}[\\/]sub-/.test(landedPaths[0]), landedPaths[0]);
      await waitFor(() => !isDir(landedPaths[0]), 'the landed worktree folder to go', 60);
      const porcelain = git(project, 'worktree', 'list', '--porcelain');
      // (this repo's own scratch folder is named .gem-scratch: match AIB's .gem-<chat id> folders only)
      const live = porcelain.split('\n\n').filter((b) => /[\\/]\.gem-[0-9a-f]{32}[\\/]/.test(b) && !b.includes('prunable'));
      assertEquals(live.length, spares.length, porcelain);
      // Activity: a card for the subagent, from its invoke_agent call (running, then completed), with P3's worktree line
      const state = await chat.state();
      assertEquals((state.subagentIsolation as Json | undefined)?.on, true, JSON.stringify(state.subagentIsolation));
      const cards = state.events.filter((e) => e.kind === 'update' && ((e.data.update as Json | undefined) ?? {}).sessionUpdate === 'subagent_update').map((e) => e.data.update as Json);
      assertEquals(cards.map((c) => c.state), ['running', 'completed'], JSON.stringify(cards));
      assertEquals(cards[0].agentType, 'generalist');
      const info = ((state.subagentWorktrees as Record<string, Json> | undefined) ?? {})[cards[0].sessionId as string];
      assert(info && info.where, JSON.stringify(state.subagentWorktrees));
      // the chat's home is AIB's own: its settings carry AIB's hook; the user's folder has no AIB file
      const homes: string[] = [];
      try {
        for (const e of Deno.readDirSync(join(fx.state, 'gemini'))) {
          const f = join(fx.state, 'gemini', e.name, 'home', '.gemini', 'settings.json');
          if (isFile(f)) homes.push(f);
        }
      } catch { /* none */ }
      assertEquals(homes.length, 1, JSON.stringify(homes));
      assert(fileText(homes[0]).includes('gemini-before-tool'));
      assert(!isDir(join(userHome, '.gemini', 'policies')));
      assert(!log.includes('AIB_HOOK_KEY'), 'no key reached the model');
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: 'GeminiFenceTest test_fence_denies_subagent_edits_when_the_redirect_is_off',
  ignore: !ok,
  ...T,
  async fn() {
    const { fx, chat, project, stub, run, cleanup } = await play(true);
    try {
      const log = stub.text();
      assert(log.includes('denied by policy'));
      assert(log.includes(FENCE_TEXT));
      assert(!isFile(join(project, 'sub-made.txt')), 'the subagent wrote into the project folder');
      assertEquals(fileText(join(project, 'parent-made.txt')), `PARENT ${run}\n`, 'the parent is unaffected');
      const notes = (await chat.state()).events.filter((e) => e.kind === 'studio_note');
      assert(notes.some((e) => JSON.stringify(e).includes(OFF_LINE)), JSON.stringify(notes));
      let homes = 0;
      try {
        for (const e of Deno.readDirSync(join(fx.state, 'gemini'))) if (isDir(join(fx.state, 'gemini', e.name, 'home'))) homes++;
      } catch { /* none */ }
      assertEquals(homes, 0, 'no chat home without the redirect');
      await sleep(2000); // nothing lands later either
      assert(!isFile(join(project, 'sub-made.txt')));
    } finally {
      await cleanup();
    }
  },
});
