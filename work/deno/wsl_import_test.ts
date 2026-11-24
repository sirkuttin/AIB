/**
 * The one-off chat import (server/wsl/helper/import.ts, tools/wsl-import.ts) without a distro: the pure parts, and plan / apply /
 * undo for real over a temp git repository, a temp Claude Code folder and a temp Codex folder on Windows (the module uses the
 * platform's path rules; the real use is in the distro, covered by wsl_import_e2e_test.ts). Process lists are injected.
 */
import { assert, assertEquals } from './_assert.ts';
import { git, HAVE_GIT } from './_git_repo.ts';
import * as osp from '../../app/server/platform/ospath.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';
import { encoded } from '../../app/server/transcripts/normalize.ts';
import { Store } from '../../app/server/transcripts/store.ts';
import {
  ACTIVE_MS,
  applyImport,
  cwdsIn,
  formatReport,
  type ImportOptions,
  launchCwd,
  pickSessions,
  planImport,
  type Proc,
  rolloutMeta,
  stampOf,
  testGuard,
  undoImport,
} from '../../app/server/wsl/helper/import.ts';
import { mntPath, parseArgs, stateDirOf } from '../../tools/wsl-import.ts';

const env = (extra: Record<string, string>) => (n: string) => extra[n] ?? Deno.env.get(n);

Deno.test('import: test guard, confirmation-free pure helpers, argument parsing', () => {
  const test = env({ AIB_WSL_TEST: '1' });
  assertEquals(testGuard(['/tmp/aib-wsl-test-abc/repo', '/tmp/aib-wsl-test-abc/data'], test), '');
  assert(testGuard(['/home/kirk/REPOS/D2Roguerected'], test).startsWith('Test guard'), 'a real project is refused under test');
  assert(testGuard(['/tmp/aib-wsl-test-abc/../../home/kirk'], test).startsWith('Test guard'), 'no way out with ..');
  assert(testGuard(['/tmp/other/repo'], env({ AGENT_STUDIO_TEST: '1' })).startsWith('Test guard'));
  assertEquals(testGuard(['/home/kirk/x'], (n) => (n === 'AGENT_STUDIO_TEST' || n === 'AIB_WSL_TEST' ? undefined : Deno.env.get(n))), '');

  assertEquals(cwdsIn('{"cwd":"/a/b"}\n{"x":1,"cwd":"/a/b/c"}\n{"cwd":"/a/b"}'), ['/a/b', '/a/b/c']);
  assertEquals(cwdsIn('{"cwd":"/a/\\"q\\"/b"}'), ['/a/"q"/b']);
  assertEquals(launchCwd(['/r/x', '/r'], '-r'), '/r', 'the cwd whose encoding names the folder');
  assertEquals(launchCwd(['/r/x', '/r'], '-other'), '/r/x', 'else the first');
  assertEquals(launchCwd([], '-r'), '');
  const id = '01a1dcbb-883a-7a71-a25d-0ac36b4c0211';
  assertEquals(rolloutMeta(`{"type":"session_meta","payload":{"id":"${id}","cwd":"/p"}}\n{}`, `rollout-2026-11-14T18-04-00-${id}.jsonl`), {
    id,
    cwd: '/p',
  });
  assertEquals(
    rolloutMeta('{"type":"session_meta","payload":{"cwd":"/p", "instru', `rollout-x-${id}.jsonl`),
    { id, cwd: '/p' },
    'a cut-off first line',
  );
  assertEquals(pickSessions(['01a1dcbb'], [id, 'ffffffff-0000-0000-0000-000000000000']).picked, new Set([id]));
  assert(pickSessions(['01a1'], [id]).error, 'prefixes need 8 characters');
  assert(pickSessions(['aaaaaaaa'], ['aaaaaaaa-1', 'aaaaaaaa-2']).error.includes('more than one'));
  assertEquals(stampOf(Date.UTC(2026, 10, 15, 14, 22, 33)), '20261115-142233');

  assertEquals(mntPath('C:\\Users\\me\\dist\\x'), '/mnt/c/Users/me/dist/x');
  const ok = parseArgs(['--distro', 'Ubuntu', '--project', '/home/u/app', '--apply', '--confirm-project', '/home/u/app']);
  assert(typeof ok !== 'string' && ok.apply && ok.confirm === '/home/u/app', JSON.stringify(ok));
  assert(typeof parseArgs(['--distro', 'Ubuntu', '--project', 'C:\\x']) === 'string', 'a Windows project path is refused');
  assert(typeof parseArgs(['--distro', 'Ubuntu', '--project', '/x', '--apply', '--undo', '1']) === 'string');
  assert(typeof parseArgs(['--distro', 'Ubuntu', '--project', '/x', '--force']) === 'string', 'unknown options are refused');
  const plain = parseArgs(['--distro', 'Ubuntu', '--project', '/x']) as Exclude<ReturnType<typeof parseArgs>, string>;
  assertEquals(
    stateDirOf(plain, (n) => ({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as Record<string, string>)[n]),
    'C:\\Users\\me\\AppData\\Local\\AgentStudio',
  );
  let threw = false;
  try {
    stateDirOf(plain, (n) => (n === 'AGENT_STUDIO_TEST' ? '1' : n === 'LOCALAPPDATA' ? 'C:\\x' : undefined));
  } catch {
    threw = true;
  }
  assert(threw, "under test the owner's data folder is never the default");
});

// ---- a fixture: repo, Claude Code and Codex folders, all inside one temp aib-wsl-test-* folder ---------------------------------
const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60_000);

class Fixture {
  readonly root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-test-' }));
  readonly repo = osp.join(this.root, 'repo');
  readonly data = osp.join(this.root, 'data-test');
  readonly claude = osp.join(this.root, 'home', '.claude');
  readonly codex = osp.join(this.root, 'home', '.codex');
  procs: Proc[] = [];

  constructor() {
    Deno.mkdirSync(osp.join(this.repo, 'sub'), { recursive: true });
    Deno.mkdirSync(this.data);
    git(this.repo, 'init', '-q', '-b', 'main');
    Deno.writeTextFileSync(osp.join(this.repo, 'a.txt'), 'one\n');
    Deno.writeTextFileSync(osp.join(this.repo, 'sub', 'b.txt'), 'two\n');
    Deno.writeTextFileSync(osp.join(this.repo, '.gitignore'), '.claude/\n');
    git(this.repo, 'add', '-A');
    git(this.repo, 'commit', '-q', '-m', 'one');
  }

  options(extra: Partial<ImportOptions> = {}): ImportOptions {
    return {
      data: this.data,
      project: this.repo,
      root: this.root,
      claudeDir: this.claude,
      codexDir: this.codex,
      processes: () => this.procs,
      holders: () => [],
      diskFree: () => ({ bytes: 100 * 1024 ** 3, fs: 'fs' }),
      env: env({ AIB_WSL_TEST: '1' }),
      ...extra,
    };
  }

  /** A Claude Code transcript started in `cwd` (filed under the folder named after it), optionally with a subagent folder. */
  claudeChat(id: string, cwd: string, options: { folder?: string; sub?: boolean; when?: Date; noCwd?: boolean } = {}): string {
    const folder = osp.join(this.claude, 'projects', options.folder ?? encoded(cwd));
    Deno.mkdirSync(folder, { recursive: true });
    const rows = [
      {
        type: 'user',
        sessionId: id,
        ...(options.noCwd ? {} : { cwd }),
        timestamp: '2026-11-14T10:00:00Z',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        sessionId: id,
        ...(options.noCwd ? {} : { cwd }),
        timestamp: '2026-11-14T10:00:05Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ];
    const file = osp.join(folder, `${id}.jsonl`);
    Deno.writeTextFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (options.sub) {
      Deno.mkdirSync(osp.join(folder, id, 'subagents'), { recursive: true });
      Deno.writeTextFileSync(osp.join(folder, id, 'subagents', 'agent-1.jsonl'), '{"cwd":"x"}\n');
    }
    const when = options.when ?? TEN_MIN_AGO();
    Deno.utimeSync(file, when, when);
    return file;
  }

  codexChat(id: string, cwd: string): string {
    const dir = osp.join(this.codex, 'sessions', '2026', '11', '14');
    Deno.mkdirSync(dir, { recursive: true });
    const file = osp.join(dir, `rollout-2026-11-14T18-04-00-${id}.jsonl`);
    Deno.writeTextFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n');
    Deno.utimeSync(file, TEN_MIN_AGO(), TEN_MIN_AGO());
    return file;
  }

  /** Every file and folder under the temp root (and .git) with size and mtime: a dry run must leave it identical. */
  snapshot(): string {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of [...Deno.readDirSync(dir)].sort((a, b) => a.name.localeCompare(b.name))) {
        const full = osp.join(dir, e.name);
        const info = Deno.lstatSync(full);
        out.push(`${full} ${info.size} ${info.mtime?.getTime()}`);
        if (info.isDirectory) walk(full);
      }
    };
    walk(this.root);
    return out.join('\n');
  }

  [Symbol.dispose](): void {
    try {
      Deno.removeSync(this.root, { recursive: true });
    } catch { /* a git process may still hold a file for a moment */ }
  }
}

const ID = {
  plain: '11111111-aaaa-4aaa-8aaa-000000000001',
  sub: '22222222-aaaa-4aaa-8aaa-000000000002',
  running: '33333333-aaaa-4aaa-8aaa-000000000003',
  other: '44444444-aaaa-4aaa-8aaa-000000000004',
  noCwd: '55555555-aaaa-4aaa-8aaa-000000000005',
  fresh: '66666666-aaaa-4aaa-8aaa-000000000006',
  codex: '77777777-aaaa-4aaa-8aaa-000000000007',
  elsewhere: '88888888-aaaa-4aaa-8aaa-000000000008',
};

function byId(report: Awaited<ReturnType<typeof planImport>>) {
  return Object.fromEntries(report.chats.map((c) => [c.id, c]));
}

Deno.test({
  name: 'import: the dry run classifies each saved session, reports project checks, and writes nothing',
  ignore: !HAVE_GIT,
  async fn() {
    using f = new Fixture();
    const outside = osp.join(f.root, 'elsewhere');
    Deno.mkdirSync(outside);
    const agentWt = osp.join(f.repo, '.claude', 'worktrees', 'agent-x');
    git(f.repo, 'worktree', 'add', '-q', '-b', 'agent-x', agentWt);
    f.claudeChat(ID.plain, f.repo, { sub: true });
    f.claudeChat(ID.sub, osp.join(f.repo, 'sub'));
    f.claudeChat(ID.running, f.repo);
    f.claudeChat(ID.other, agentWt);
    f.claudeChat(ID.noCwd, f.repo, { noCwd: true, folder: encoded(f.repo) });
    f.claudeChat(ID.fresh, f.repo, { when: new Date(Date.now() - ACTIVE_MS / 4) });
    f.claudeChat(ID.elsewhere, outside);
    f.codexChat(ID.codex, f.repo);
    f.procs = [{ pid: 4242, ppid: 1, cwd: outside, cmdline: `python3 holder.py --resume ${ID.running}` }];

    const before = f.snapshot();
    const indexBefore = Deno.statSync(osp.join(f.repo, '.git', 'index')).mtime?.getTime();
    const report = await planImport(f.options());
    assertEquals(f.snapshot(), before, 'the dry run changed nothing on disk');
    assertEquals(Deno.statSync(osp.join(f.repo, '.git', 'index')).mtime?.getTime(), indexBefore, 'not even the index was refreshed');
    assertEquals(report.blockers, []);
    assertEquals([report.checks!.clean, report.checks!.headBranch, report.checks!.base, report.checks!.gitDirWritable], [
      true,
      'main',
      'main',
      true,
    ]);

    const c = byId(report);
    assertEquals(
      Object.keys(c).sort(),
      [ID.plain, ID.sub, ID.running, ID.other, ID.noCwd, ID.fresh, ID.codex].sort(),
      'a chat of another folder is not listed',
    );
    assertEquals([c[ID.plain].status, c[ID.plain].branch, c[ID.plain].rel], ['eligible', 'studio/chat-11111111', '']);
    const wtPath = c[ID.plain].worktree!;
    assertEquals(wtPath, osp.join(f.data, 'worktrees', wt.repoHash(f.repo), 'chat-11111111'));
    const target = osp.join(f.claude, 'projects', encoded(wtPath));
    assertEquals(c[ID.plain].moves, [
      [osp.join(f.claude, 'projects', encoded(f.repo), `${ID.plain}.jsonl`), osp.join(target, `${ID.plain}.jsonl`)],
      [osp.join(f.claude, 'projects', encoded(f.repo), ID.plain), osp.join(target, ID.plain)],
    ], 'the transcript and its folder move next to the worktree name');
    assertEquals([c[ID.sub].status, c[ID.sub].rel], ['eligible', 'sub']);
    assertEquals([c[ID.running].status, c[ID.running].code], ['skip', 'running']);
    assert(c[ID.running].reason!.includes('4242'), c[ID.running].reason);
    assertEquals([c[ID.fresh].status, c[ID.fresh].code], ['skip', 'running'], 'written moments ago');
    assertEquals([c[ID.other].status, c[ID.other].code], ['skip', 'other-worktree']);
    assertEquals([c[ID.noCwd].status, c[ID.noCwd].code], ['skip', 'no-cwd']);
    assertEquals([c[ID.codex].status, c[ID.codex].branch, c[ID.codex].moves], ['eligible', 'studio/chat-77777777', undefined]);
    const text = formatReport(report);
    assert(text.includes('DRY RUN: nothing was changed') && text.includes('MOVE claude') && text.includes('SKIP claude'), text);

    // --sessions narrows the list; an unknown id is a blocker
    assertEquals((await planImport(f.options({ sessions: ['11111111'] }))).chats.map((x) => x.id), [ID.plain]);
    assert((await planImport(f.options({ sessions: ['deadbeef'] }))).blockers.some((b) => b.includes('deadbeef')));

    // blockers: a dirty main checkout, an agent working in the project folder
    Deno.writeTextFileSync(osp.join(f.repo, 'notes.txt'), 'wip\n');
    f.procs.push({
      pid: 5151,
      ppid: 1,
      cwd: osp.join(f.repo, 'sub'),
      cmdline: 'node /usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    });
    const dirty = await planImport(f.options());
    assertEquals([dirty.checks!.clean, dirty.checks!.dirty], [false, ['?? notes.txt']]);
    assert(dirty.blockers.some((b) => b.startsWith('The main checkout has uncommitted work')), dirty.blockers.join('|'));
    assert(dirty.blockers.some((b) => b.includes('5151')), dirty.blockers.join('|'));
    const refused = await applyImport(f.options(), null);
    assertEquals([refused.refused, refused.applied], ['Nothing was changed: fix the blockers above first', []]);
    assertEquals(Object.keys(new wt.Registry(f.data).all()), [], 'no record');
    assert(!exists(osp.join(f.root, 'import-backup')), 'no backup folder');
  },
});

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name: 'import: apply makes a copy per chat, moves Claude history, lists each chat once; re-run skips; undo puts it back',
  ignore: !HAVE_GIT,
  async fn() {
    using f = new Fixture();
    const plainFile = f.claudeChat(ID.plain, f.repo, { sub: true });
    const subFile = f.claudeChat(ID.sub, osp.join(f.repo, 'sub'));
    const codexFile = f.codexChat(ID.codex, f.repo);

    // outside a test the owner must type the project again; under test the folders must be aib-wsl-test-* ones
    const unconfirmed = await applyImport(
      f.options({ env: (n) => (n === 'AIB_WSL_TEST' || n === 'AGENT_STUDIO_TEST' ? undefined : Deno.env.get(n)) }),
      null,
    );
    assert(unconfirmed.refused?.includes('--confirm-project'), unconfirmed.refused);
    const notTest = await applyImport(f.options({ claudeDir: 'C:\\Users\\someone\\.claude' }), null);
    assert(notTest.refused?.startsWith('Test guard'), notTest.refused);
    assertEquals(Object.keys(new wt.Registry(f.data).all()), []);

    const report = await applyImport(f.options(), null);
    assertEquals(report.refused, undefined);
    assertEquals(
      report.applied.map((a) => [a.id, a.ok, a.error ?? '']).sort(),
      [[ID.plain, true, ''], [ID.sub, true, ''], [ID.codex, true, '']].sort(),
    );
    const registry = new wt.Registry(f.data);
    for (const [provider, id] of [['claude', ID.plain], ['claude', ID.sub], ['codex', ID.codex]]) {
      const record = registry.find(null, `${provider}:${id}`); // what Studio.connect's wslRecord asks the helper
      assert(record, `${provider}:${id} has a record`);
      assertEquals([record.status, record.project, record.branch], ['ready', f.repo, `studio/chat-${id.slice(0, 8)}`]);
      assert(osp.isdir(String(record.path)), 'its worktree exists');
      assertEquals(git(String(record.path), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), record.branch);
      assertEquals((record.imported as Record<string, unknown>).backup, report.stamp);
    }
    const plainWt = String(registry.find(null, `claude:${ID.plain}`)!.path);
    const moved = osp.join(f.claude, 'projects', encoded(plainWt), `${ID.plain}.jsonl`);
    assert(exists(moved) && exists(osp.join(osp.dirname(moved), ID.plain, 'subagents', 'agent-1.jsonl')), 'history and its folder moved');
    assert(!exists(plainFile) && !exists(subFile), 'nothing left behind');
    assert(exists(codexFile), 'Codex history stays');
    const backup = osp.join(f.root, 'import-backup', report.stamp!);
    assert(exists(osp.join(backup, 'claude', encoded(f.repo), `${ID.plain}.jsonl`)), 'backup copy');
    assert(exists(osp.join(backup, 'claude', encoded(f.repo), ID.plain, 'subagents', 'agent-1.jsonl')), 'backup of its folder');
    assert(exists(osp.join(backup, 'manifest.json')));
    assertEquals(git(f.repo, 'status', '--porcelain'), '', 'the main checkout is untouched');

    // the saved-chat list (the helper's store with its worktree resolver) shows each chat once
    const store = await Store.open(osp.join(f.claude, 'projects'));
    const resolver = new wt.ProjectResolver(f.data);
    store.projectResolver = (cwd: string) => resolver.resolve(cwd);
    const items = await store.sessions();
    for (const id of [ID.plain, ID.sub]) assertEquals(items.filter((s) => s.id === id).length, 1, `one row for ${id}`);
    assertEquals(items.find((s) => s.id === ID.plain)!.projectRoot, f.repo, 'filed under its project');

    // a second run: everything is imported already
    const again = await planImport(f.options());
    assertEquals(
      again.chats.map((c) => [c.id, c.status, c.code]).sort(),
      [[ID.plain, 'skip', 'imported'], [ID.sub, 'skip', 'imported'], [ID.codex, 'skip', 'imported']].sort(),
    );
    assertEquals((await applyImport(f.options(), null)).applied, []);

    // undo: a chat with a commit of its own in its copy is refused; the others go back
    const subWt = String(registry.find(null, `claude:${ID.sub}`)!.path);
    Deno.writeTextFileSync(osp.join(subWt, 'c.txt'), 'chat\n');
    git(subWt, 'add', 'c.txt');
    git(subWt, 'commit', '-q', '-m', 'chat work');
    const undo = await undoImport(f.options(), report.stamp!, null);
    assertEquals(undo.refused, undefined);
    const results = Object.fromEntries(undo.applied.map((a) => [a.id, a]));
    assertEquals([results[ID.plain].ok, results[ID.codex].ok, results[ID.sub].ok], [true, true, false], JSON.stringify(undo.applied));
    assert(results[ID.sub].error!.includes('1 commit(s) of its own'), results[ID.sub].error);
    assert(exists(plainFile) && exists(osp.join(osp.dirname(plainFile), ID.plain, 'subagents', 'agent-1.jsonl')), 'history back');
    assert(!exists(moved) && !exists(osp.dirname(moved)), 'and the moved copy gone');
    assert(!exists(plainWt), 'worktree removed');
    assertEquals(registry.find(null, `claude:${ID.plain}`), null);
    assertEquals(registry.find(null, `codex:${ID.codex}`), null);
    assertEquals(git(f.repo, 'branch', '--list', 'studio/chat-11111111').trim(), '', 'branch deleted');
    assertEquals(
      new wt.Manager(f.data).isRemoved(f.repo, `claude:${ID.plain}`),
      false,
      'no "removed" note: the chat continues in the project folder',
    );
    assert(registry.find(null, `claude:${ID.sub}`), 'the chat with work of its own keeps its copy');
    // a second undo of the same run: done ones say so, nothing breaks
    const twice = await undoImport(f.options(), report.stamp!, null);
    assert(twice.applied.find((a) => a.id === ID.plain)!.error!.includes('already undone'));
    assert((await undoImport(f.options(), 'nope', null)).refused?.includes('not an import stamp'));
  },
});
