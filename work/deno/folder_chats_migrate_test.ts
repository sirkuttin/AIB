/**
 * The owner's one-off folder-chats migration (work/migrate/folder_chats_migrate.ts), run as the owner runs it (a deno subprocess),
 * against TEMP folders only: a fake AIB data folder, temp HOME / USERPROFILE / LOCALAPPDATA, a temp Claude config folder and
 * CODEX_HOME, real git in a temp repo, and the fake ACP agent (work/fake_acp.py) standing in for the Codex adapter.
 *
 * Dry run changes nothing and prints the plan; --apply re-files the old copy chats without unmerged work (Claude moved + cwd
 * rewritten, Codex opened once in the project folder, backups kept), removes their copies, branches and refs, leaves helpers' copies
 * and lists the chat with unmerged work without touching it; a rerun changes nothing; with AIB (or its keeper) running it refuses.
 * --discard "<chat title or id>" throws that chat's unmerged work away (its copy, branch and refs) and re-files the chat like the
 * others; the dry run only says so; a rerun changes nothing; a name that matches nothing is said and changes nothing.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, PYTHON } from './_connection.ts';
import { exists, makeRepo, runGit, write } from './_worktree_fixtures.ts';
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { tryLockNow } from '../../outputs/agent-studio/server/platform/lock.ts';
import { readMoved } from '../../outputs/agent-studio/server/state/moved_chats.ts';
import { claudeEncode } from '../migrate/refile_core.ts';

const SCRIPT = new URL('../migrate/folder_chats_migrate.ts', import.meta.url);
const CONFIG = new URL('../../outputs/agent-studio/deno.json', import.meta.url);
const native = (u: URL) => {
  const p = decodeURIComponent(u.pathname);
  return Deno.build.os === 'windows' ? p.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : p;
};
const OLD = new Date(Date.now() - 3600_000); // older than the script's "open somewhere" window

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-fc-migrate-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly home = pathOf(this.dir, 'home');
  readonly claudeDir = pathOf(this.dir, 'claude');
  readonly claude = pathOf(this.dir, 'claude', 'projects');
  readonly codex = pathOf(this.dir, 'codex');
  readonly agentLog = pathOf(this.dir, 'agent.log');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));

  constructor() {
    for (const d of [this.state, this.home, this.claude, this.codex]) Deno.mkdirSync(d, { recursive: true });
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
  }

  async copy(provider: string, sessionId: string, kind: 'chat' | 'helper' = 'chat') {
    const manager = new wt.Manager(this.state);
    const { plan } = await manager.planWithReason(this.project, crypto.randomUUID().replaceAll('-', ''), kind);
    assert(plan, 'a plan');
    await manager.create(plan);
    await manager.setSession(plan.key, provider, sessionId);
    return { key: plan.key, path: plan.path, branch: plan.branch };
  }

  /** Claude Code's transcript of a chat that worked in `cwd`, with a side folder; written an hour ago. */
  transcript(sessionId: string, cwd: string): string {
    const folder = pathOf(this.claude, claudeEncode(cwd));
    Deno.mkdirSync(pathOf(folder, sessionId, 'subagents'), { recursive: true });
    Deno.writeTextFileSync(pathOf(folder, sessionId, 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n');
    const line = (n: number) => JSON.stringify({ type: 'user', cwd, sessionId, message: { role: 'user', content: `hello ${n}` } });
    const file = pathOf(folder, `${sessionId}.jsonl`);
    Deno.writeTextFileSync(file, [line(1), JSON.stringify({ type: 'summary', summary: 'x' }), line(2)].join('\n') + '\n');
    Deno.utimeSync(file, OLD, OLD);
    return file;
  }

  rollout(sessionId: string, cwd: string): string {
    const day = pathOf(this.codex, 'sessions', '2026', '11', '01');
    Deno.mkdirSync(day, { recursive: true });
    const file = pathOf(day, `rollout-2026-11-01T00-00-00-${sessionId}.jsonl`);
    Deno.writeTextFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }) + '\n');
    Deno.utimeSync(file, OLD, OLD);
    return file;
  }

  async run(...extra: string[]): Promise<{ code: number; out: string }> {
    const env: Record<string, string> = { FAKE_ACP_LOG: this.agentLog, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
    for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) env[name] = this.home;
    const done = await new Deno.Command(Deno.execPath(), {
      args: [
        'run', '-A', '--quiet', '--config', native(CONFIG), native(SCRIPT),
        '--data', this.state, '--claude-dir', this.claudeDir, '--codex-home', this.codex,
        '--codex-adapter', JSON.stringify([PYTHON, FAKE]),
        ...extra,
      ],
      env,
      stdout: 'piped',
      stderr: 'piped',
      stdin: 'null',
    }).output();
    const dec = new TextDecoder();
    return { code: done.code, out: dec.decode(done.stdout) + dec.decode(done.stderr) };
  }

  loads(): Record<string, unknown>[] {
    if (!exists(this.agentLog)) return [];
    return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.includes('"session/load"')).map((l) => JSON.parse(l));
  }

  /** Every file under a folder with its bytes: "nothing changed" means the same map. */
  snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const e of Deno.readDirSync(dir)) {
        const p = pathOf(dir, e.name);
        if (e.name === '.git' || e.name === 'desktop.lock' || p === this.agentLog) continue;
        if (e.isDirectory) {
          out.set(p + '/', '');
          walk(p);
        } else out.set(p, Deno.readTextFileSync(p));
      }
    };
    walk(this.dir);
    out.set('branches', runGit(this.project, 'for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/studio/'));
    out.set('worktrees', runGit(this.project, 'worktree', 'list', '--porcelain'));
    return out;
  }

  [Symbol.dispose](): void {
    try {
      Deno.removeSync(this.dir, { recursive: true });
    } catch { /* the OS temp cleanup gets it */ }
  }
}

const filedUnder = (box: Box, folder: string, sessionId: string) => pathOf(box.claude, claudeEncode(folder), `${sessionId}.jsonl`);
const branchList = (box: Box) => runGit(box.project, 'branch', '--list', 'studio/*', '--format=%(refname:short)').split(/\s+/).filter(Boolean);

async function scene(box: Box) {
  const a = await box.copy('claude', 'sess-a'); // an old copy chat, merged / nothing new: moves
  const aFile = box.transcript('sess-a', a.path);
  const b = await box.copy('claude', 'sess-b'); // unmerged work: listed only
  write(b.path, 'work.txt', 'not merged yet\n');
  const bFile = box.transcript('sess-b', b.path);
  const c = await box.copy('codex', 'cdx-1'); // a Codex chat: opened once in the project folder
  const cFile = box.rollout('cdx-1', c.path);
  const d = await box.copy('claude', 'sess-d'); // discarded earlier: its copy is gone, its removed-note stays
  const dFile = box.transcript('sess-d', d.path);
  assertEquals(await new wt.Manager(box.state).remove(d.key, true), 'removed');
  const h = await box.copy('claude', 'sess-h', 'helper'); // a helper: the app's own rules, never touched here
  const hFile = box.transcript('sess-h', h.path);
  const root = new wt.Registry(box.state).root;
  const emptyFolder = pathOf(box.claude, claudeEncode(pathOf(root, 'x', 'chat-gone')));
  const memoryFolder = pathOf(box.claude, claudeEncode(pathOf(root, 'x', 'chat-memory')));
  Deno.mkdirSync(emptyFolder, { recursive: true });
  Deno.mkdirSync(pathOf(memoryFolder, 'memory'), { recursive: true });
  return { a, aFile, b, bFile, c, cFile, d, dFile, h, hFile, emptyFolder, memoryFolder };
}

Deno.test('folder-chats migration: the dry run prints the plan per project and changes nothing', async () => {
  using box = new Box();
  const s = await scene(box);
  const before = box.snapshot();
  const { code, out } = await box.run();
  assertEquals(code, 0, out);
  assert(out.includes('dry run'), out);
  assert(out.includes(`== ${box.project}`), out);
  assert(out.includes('plan: claude chat sess-a') && out.includes('would move'), out);
  assert(out.includes('plan: codex chat cdx-1') && out.includes('open it once in the project folder'), out);
  assert(out.includes('plan: claude chat sess-d'), out);
  assert(out.includes('NOT TOUCHED: chat') && out.includes('claude:sess-b'), out);
  assert(out.includes('to discard that work, run this again with: --discard "') && out.includes("or ask the chat's agent to merge it"), out);
  assert(!/Merge or Discard/.test(out), 'no Merge / Discard buttons to point at any more');
  assert(out.includes(`plan: remove empty folder ${s.emptyFolder}`), out);
  assert(!out.includes('sess-h'), 'helpers are not part of it');
  assertEquals(box.snapshot(), before, 'nothing changed');
  assertEquals(box.loads(), [], 'no agent started');
});

Deno.test('folder-chats migration: --apply re-files and removes; unmerged work and helpers untouched; a rerun changes nothing', async () => {
  using box = new Box();
  const s = await scene(box);
  const bBefore = Deno.readTextFileSync(s.bFile);
  const { code, out } = await box.run('--apply');
  assertEquals(code, 0, out);

  // Claude chat with its copy: moved under the project, every cwd rewritten, side folder moved, backup kept; copy + branch gone
  const aFiled = filedUnder(box, box.project, 'sess-a');
  assert(exists(aFiled) && !exists(s.aFile), out);
  for (const line of Deno.readTextFileSync(aFiled).trim().split('\n')) {
    const row = JSON.parse(line);
    if (row.cwd) assertEquals(row.cwd, box.project);
  }
  assert(exists(pathOf(box.claude, claudeEncode(box.project), 'sess-a', 'subagents', 'agent-1.jsonl')), 'side folder moved');
  assert(exists(pathOf(box.state, 'refiled', 'claude', 'sess-a.jsonl')), 'backup kept');
  assert(!exists(s.a.path), 'its copy is gone');
  assert(!branchList(box).includes(s.a.branch), 'its branch is gone');
  assertEquals(runGit(box.project, 'for-each-ref', `refs/studio/${s.a.branch.slice(7)}/`).trim(), '', 'its refs are gone');
  assert(!runGit(box.project, 'worktree', 'list', '--porcelain').toLowerCase().includes(s.a.path.toLowerCase().replaceAll('\\', '/')));

  // the discarded chat (copy already gone): moved too
  assert(exists(filedUnder(box, box.project, 'sess-d')) && !exists(s.dFile));

  // Codex: backed up, then opened once in the project folder through the adapter (no prompt); the rollout itself untouched here
  const loads = box.loads();
  assertEquals(loads.length, 1, JSON.stringify(loads));
  const params = (loads[0].params ?? {}) as Record<string, unknown>;
  assertEquals([params.sessionId, String(params.cwd).toLowerCase()], ['cdx-1', box.project.toLowerCase()]);
  assert(exists(pathOf(box.state, 'refiled', 'codex', 'cdx-1.jsonl')));
  assert(exists(s.cFile), 'never deleted');
  assert(!exists(s.c.path), "the Codex chat's copy is gone");

  // AIB is told (read only in the app)
  const moved = readMoved(box.state);
  assertEquals(Object.keys(moved).sort(), ['claude:sess-a', 'claude:sess-d', 'codex:cdx-1']);
  for (const m of Object.values(moved)) assertEquals(m.project.toLowerCase(), box.project.toLowerCase());

  // unmerged work: listed, not touched
  assert(out.includes('NOT TOUCHED: chat') && out.includes('claude:sess-b'), out);
  assert(exists(s.b.path) && Deno.readTextFileSync(pathOf(s.b.path, 'work.txt')) === 'not merged yet\n');
  assert(branchList(box).includes(s.b.branch));
  assertEquals(Deno.readTextFileSync(s.bFile), bBefore, 'its transcript is not moved');
  // helpers: untouched
  assert(exists(s.h.path) && exists(s.hFile) && branchList(box).includes(s.h.branch));
  // empty copy-named folders: only empty ones go (plain rmdir)
  assert(!exists(s.emptyFolder), out);
  assert(exists(pathOf(s.memoryFolder, 'memory')), 'a folder with memory/ stays');
  assert(exists(pathOf(box.claude, claudeEncode(s.b.path), 'sess-b.jsonl')), 'no transcript is ever deleted');

  // rerun: nothing more to do, nothing changes, no second backup, no second Codex load
  const before = box.snapshot();
  const again = await box.run('--apply');
  assertEquals(again.code, 0, again.out);
  assert(again.out.includes('chats moved to their project folder: 0'), again.out);
  assert(again.out.includes('NOT TOUCHED: chat'), 'still listed until merged or discarded');
  assertEquals(box.snapshot(), before, 'the rerun changed nothing');
  assertEquals(box.loads().length, 1);
  const dry = await box.run();
  assert(dry.out.includes('to be moved to their project folder: 0'), dry.out);
});

Deno.test('folder-chats migration: refuses while AIB or its keeper runs, and changes nothing', async () => {
  using box = new Box();
  await scene(box);
  const before = box.snapshot();
  // the keeper of this data folder is running (its keeper.json names a live pid: this test's own)
  Deno.mkdirSync(pathOf(box.state, 'keeper'), { recursive: true });
  const info = pathOf(box.state, 'keeper', 'keeper.json');
  Deno.writeTextFileSync(info, JSON.stringify({ token: 't', address: '127.0.0.1:1', pid: Deno.pid }));
  const keeper = await box.run('--apply');
  assertEquals(keeper.code, 3, keeper.out);
  assert(keeper.out.includes("keeper is running") && keeper.out.includes('Nothing was changed'), keeper.out);
  Deno.removeSync(info);
  Deno.removeSync(pathOf(box.state, 'keeper'));
  // AIB itself: it holds <data>/desktop.lock while it runs
  const lock = await tryLockNow(pathOf(box.state, 'desktop.lock'), true);
  try {
    const app = await box.run('--apply');
    assertEquals(app.code, 3, app.out);
    assert(app.out.includes('AIB is running'), app.out);
  } finally {
    lock.close();
  }
  assertEquals(box.snapshot(), before, 'nothing changed');
  assertEquals(box.loads(), []);
});

Deno.test("folder-chats migration: --discard throws one chat's unmerged work away and re-files it; dry run first; a rerun changes nothing", async () => {
  using box = new Box();
  const s = await scene(box);
  const e = await box.copy('claude', 'sess-e'); // a second chat with unmerged work: not named, so kept
  write(e.path, 'keep.txt', 'mine\n');
  box.transcript('sess-e', e.path);

  // the dry run with --discard: the plan says what goes, nothing changes
  const before = box.snapshot();
  const dry = await box.run('--discard', 'claude:sess-b', '--discard', 'no such chat');
  assertEquals(dry.code, 0, dry.out);
  assert(dry.out.includes('plan: discard chat') && dry.out.includes('claude:sess-b') && dry.out.includes('then delete its copy with its unmerged work (1 file)'), dry.out);
  assert(dry.out.includes('--discard "no such chat": no old copy chat with unmerged work has that title or id'), dry.out);
  assert(dry.out.includes('NOT TOUCHED: chat') && dry.out.includes('claude:sess-e'), 'the chat not named stays listed');
  assertEquals(box.snapshot(), before, 'the dry run changed nothing');

  // --apply by the bare session id: copy, branch and refs go; the chat is re-filed under the project (backup kept)
  const { code, out } = await box.run('--apply', '--discard', 'sess-b');
  assertEquals(code, 0, out);
  assert(!exists(s.b.path), out);
  assert(!branchList(box).includes(s.b.branch), 'its branch is gone');
  assertEquals(runGit(box.project, 'for-each-ref', `refs/studio/${s.b.branch.slice(7)}/`).trim(), '', 'its refs are gone');
  assert(exists(filedUnder(box, box.project, 'sess-b')) && !exists(s.bFile), 'the chat carries on in the project folder');
  assert(exists(pathOf(box.state, 'refiled', 'claude', 'sess-b.jsonl')), 'its transcript backup is kept');
  assert(Object.keys(readMoved(box.state)).includes('claude:sess-b'));
  assert(out.includes('discarded (--discard): 1'), out);
  // the chat not named: untouched
  assert(exists(e.path) && Deno.readTextFileSync(pathOf(e.path, 'keep.txt')) === 'mine\n' &&branchList(box).includes(e.branch));

  // rerun with the same option: nothing left to discard, nothing changes
  const after = box.snapshot();
  const again = await box.run('--apply', '--discard', 'sess-b');
  assertEquals(again.code, 0, again.out);
  assert(again.out.includes('nothing to discard'), again.out);
  assertEquals(box.snapshot(), after, 'the rerun changed nothing');
});
