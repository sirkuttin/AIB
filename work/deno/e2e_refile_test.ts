/**
 * e2e 19 (real-CLI form) of the "chats work in the project folder" plan (build-plan-1b 4.5, 8) (the port of work/test_refile_e2e.py):
 * the one-off folder-chats migration (work/migrate: its re-file core and its Codex opener) makes an old copy chat's transcript show in
 * the agent's OWN listing for the project folder, and the resumed chat still has its history. Real agent adapters, the local stub
 * model API (work/stub_model_api.js), temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME, no key, no network.
 *
 *   Claude Code  a chat made in a copy folder W (the codeword told to the stub), then refileClaude (work/refile_cli.ts) moves it to
 *                P with every cwd rewritten: the listing for P has it with cwd P, W's listing no longer does, a backup exists, and a
 *                load in P with a question gets "STUB codeword=TEAL-42" (the history reached the model). Empty copy-named folders go.
 *   Codex        what the migration does after the backup: open the chat once in P (session/load cwd=P, no prompt); the listing for
 *                P then has it and W's does not, and a load in P still has the history. Nothing writes Codex's files but Codex.
 *                Done twice: with the test's ACP probe, and with the migration script's own ACP client (refile_cli.ts codex-script).
 *
 * Guard: no entry for the temp folders may appear in the owner's ~/.claude/projects or ~/.codex/sessions, and none of the test's
 * Codex session ids may appear there (file names, or the thread index state_5.sqlite, opened read-only and immutable).
 * Adapters: AIB_CLAUDE_ACP / AIB_CODEX_ACP (dist/index.js of the adapter), else the global npm install.
 */
import { assert, assertEquals, DENO, isFile, Json, makeRepo, normcase } from './_e2e.ts';
import {
  adapterEnv,
  agentTempRoot,
  CLAUDE_ACP,
  CODEX_ACP,
  claudeEncoded,
  join,
  NODE_EXE,
  OwnerGuard,
  probe,
  REPO_DIR,
  Stub,
  T,
  Temp,
  uuid,
} from './_e2e_real.ts';

const CLI = join(REPO_DIR, 'work', 'refile_cli.ts');
const APP_DIR = join(REPO_DIR, 'app');
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function refileCli(args: string[], env?: Record<string, string>): Promise<Json> {
  // refile_cli.ts refuses folders outside the system temp folder: the test folders live in agentTempRoot(), so that is its TEMP
  const out = await new Deno.Command(DENO, {
    args: ['run', '-A', '--quiet', CLI, ...args],
    cwd: APP_DIR,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    env: { ...(env ?? Deno.env.toObject()), TEMP: agentTempRoot(), TMP: agentTempRoot() },
    clearEnv: true,
  }).output();
  const line = dec(out.stdout).split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (!line) throw new Error(`refile_cli printed nothing: ${JSON.stringify(dec(out.stdout))} ${JSON.stringify(dec(out.stderr).slice(-2000))}`);
  return JSON.parse(line);
}

/** The owner's ~/.codex has no trace of this test's session id: no rollout file names it, the thread index has no such id. */
async function assertNotInOwnerCodex(session: string): Promise<void> {
  const home = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '';
  const codex = join(home, '.codex');
  const hits: string[] = [];
  const walk = (dir: string) => {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (e.isDirectory) walk(join(dir, e.name));
        else if (e.name.includes(session)) hits.push(join(dir, e.name));
      }
    } catch { /* none */ }
  };
  walk(join(codex, 'sessions'));
  assertEquals(hits, [], "the test's Codex session reached the owner's ~/.codex/sessions");
  const index = join(codex, 'state_5.sqlite');
  if (!isFile(index)) return;
  try { // read-only and immutable: SQLite writes nothing next to the owner's file
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`file:${index.replaceAll('\\', '/')}?mode=ro&immutable=1`, { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM threads WHERE id = ?').get(session) as { n: number };
      assertEquals(row.n, 0, "the test's Codex session reached the owner's thread index");
    } finally {
      db.close();
    }
  } catch (error) {
    if ((error as Error).name === 'AssertionError') throw error; // another schema or locked: the file-name check above stands
  }
}

class Setup {
  temp = new Temp('aib-e19-');
  state = this.temp.join('state');
  copy = '';
  project = '';
  stub!: Stub;
  env!: Record<string, string>;
  guard!: OwnerGuard;

  static async make(): Promise<Setup> {
    const s = new Setup();
    s.stub = await Stub.start(s.temp.path);
    Deno.mkdirSync(s.state);
    // W stands for a copy under this install's worktrees root; P is the project folder
    s.copy = makeRepo(join(s.state, 'worktrees', 'abc123', `chat-${uuid().slice(0, 8)}`));
    s.project = makeRepo(s.temp.join(`proj-${uuid().slice(0, 6)}`));
    s.guard = new OwnerGuard([s.copy, s.project]);
    s.env = adapterEnv(s.temp, s.stub);
    return s;
  }
  async listed(entry: string, folder: string): Promise<Record<string, Json>> {
    const out = await probe(entry, this.env, 'list', folder);
    return Object.fromEntries((out.sessions as Json[]).map((s) => [s.sessionId as string, s]));
  }
  async dispose() {
    await this.stub.stop();
    try {
      this.guard.check();
    } finally {
      this.temp[Symbol.dispose]();
    }
  }
  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
}

Deno.test({
  name: 'RefileE2ETest test_claude_refiled_chat_is_listed_for_project_and_keeps_history',
  ignore: !(NODE_EXE && CLAUDE_ACP),
  ...T,
  async fn() {
    await using s = await Setup.make();
    const made = await probe(CLAUDE_ACP!, s.env, 'new', s.copy, 'the codeword is TEAL-42');
    assert(String(made.reply).includes('STUB codeword=TEAL-42'));
    const session = made.sessionId as string;
    const projects = s.temp.join('claude', 'projects');
    const oldFolder = join(projects, claudeEncoded(s.copy));
    assert(isFile(join(oldFolder, `${session}.jsonl`)));
    assert(session in await s.listed(CLAUDE_ACP!, s.copy));
    assert(!(session in await s.listed(CLAUDE_ACP!, s.project)), 'the problem: not listed for the project before');

    const done = await refileCli(['claude', s.state, projects, session, s.copy, s.project]);
    assertEquals(done.outcome, 'moved', JSON.stringify(done));
    assert(isFile(done.backup as string), 'the backup is kept');
    assert(normcase(done.backup as string).startsWith(normcase(join(s.state, 'refiled', 'claude'))));
    const filed = join(projects, claudeEncoded(s.project), `${session}.jsonl`);
    assert(isFile(filed));
    const cwds = new Set(
      Deno.readTextFileSync(filed).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).cwd).filter((c: unknown) => c !== undefined && c !== null),
    );
    assertEquals([...cwds].map((c) => normcase(String(c))), [normcase(s.project)], 'every cwd is the project');

    const mine = await s.listed(CLAUDE_ACP!, s.project);
    assert(session in mine, 'listed for the project by the agent itself');
    assertEquals(normcase(mine[session].cwd as string), normcase(s.project));
    assert(!(session in await s.listed(CLAUDE_ACP!, s.copy)));
    const loaded = await probe(CLAUDE_ACP!, s.env, 'load', s.project, session, 'what is the codeword?');
    assert(String(loaded.reply ?? '').includes('STUB codeword=TEAL-42'), 'the history reached the model after the move');

    const cleaned = await refileCli(['clean', projects, join(s.state, 'worktrees')]);
    let exists = true;
    try {
      Deno.statSync(oldFolder);
    } catch {
      exists = false;
    }
    const norm = (list: unknown) => (list as string[]).map((p) => normcase(p));
    if (exists) { // Claude Code may keep memory/ or other files there: then the folder must stay
      assert(norm(cleaned.kept).includes(normcase(oldFolder)), JSON.stringify(cleaned));
    } else {
      assert(norm(cleaned.removed).includes(normcase(oldFolder)), JSON.stringify(cleaned));
    }
    assert(isFile(filed), 'the cleanup never deletes a transcript');
  },
});

Deno.test({
  name: 'RefileE2ETest test_codex_opened_once_in_project_is_listed_for_project',
  ignore: !(NODE_EXE && CODEX_ACP),
  ...T,
  async fn() {
    await using s = await Setup.make();
    const made = await probe(CODEX_ACP!, s.env, 'new', s.copy, 'the codeword is TEAL-42');
    const session = made.sessionId as string;
    assert(session in await s.listed(CODEX_ACP!, s.copy));
    const rollouts: string[] = [];
    const walk = (dir: string) => {
      for (const e of Deno.readDirSync(dir)) {
        if (e.isDirectory) walk(join(dir, e.name));
        else if (e.name.endsWith(`-${session}.jsonl`)) rollouts.push(join(dir, e.name));
      }
    };
    walk(s.temp.join('codex', 'sessions'));
    assertEquals(rollouts.length, 1, 'refileCodex backs this file up first');
    await probe(CODEX_ACP!, s.env, 'load', s.project, session); // what refileCodex's load does: no prompt
    assert(session in await s.listed(CODEX_ACP!, s.project));
    assert(!(session in await s.listed(CODEX_ACP!, s.copy)));
    await assertNotInOwnerCodex(session);
  },
});

Deno.test({
  name: 'RefileE2ETest test_codex_opened_by_the_migration_script',
  ignore: !(NODE_EXE && CODEX_ACP),
  ...T,
  async fn() {
    await using s = await Setup.make();
    const made = await probe(CODEX_ACP!, s.env, 'new', s.copy, 'the codeword is TEAL-42');
    const session = made.sessionId as string;
    assert(session in await s.listed(CODEX_ACP!, s.copy));
    const done = await refileCli(['codex-script', s.temp.join('codex'), NODE_EXE!, CODEX_ACP!, session, s.project], s.env);
    assertEquals(done, { ok: true });
    // Codex re-indexed it itself: its own listing for P has it, W's does not; the history is still there
    assert(session in await s.listed(CODEX_ACP!, s.project));
    assert(!(session in await s.listed(CODEX_ACP!, s.copy)));
    const loaded = await probe(CODEX_ACP!, s.env, 'load', s.project, session, 'what is the codeword?');
    assert(String(loaded.reply ?? '').includes('STUB codeword=TEAL-42'), 'the history reached the model after the move');
    await assertNotInOwnerCodex(session);
  },
});
