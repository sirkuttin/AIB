/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the one-off import of a project's existing chats into their own copies
 * (tools/wsl-import.ts -> AIB-wsl-helper import; docs/WSL.md "Moving existing chats into their own copies (one-off)").
 *   - a temp repo with saved sessions: Claude started in the project, Claude started in a subfolder, Claude running now (a process
 *     whose command line names its id), Claude in another tool's worktree of the repo, Codex in the project;
 *   - blockers: a dirty main checkout refuses --apply and writes nothing; the dry run leaves every file as it was;
 *   - apply of one chat (--sessions), then of all: copies, records, moved history; a re-run changes nothing; the saved-chat list
 *     has one row per chat; Studio.connect resumes the imported chats in their copies (agent cwd = the copy), the Changes view shows
 *     the branch, Merge lands; the run through --helper-bin (/mnt) works; the test guard refuses a project outside the test root;
 *   - undo: a chat with work of its own is refused, the others go back exactly (history, no copy, no branch, no record).
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, STATE, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { wslSavedSessions } from '../../outputs/agent-studio/server/wsl/transcripts.ts';
import { wslHostsInUse } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { changesResponse } from '../../outputs/agent-studio/server/worktrees/chat_folders.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { encoded } from '../../outputs/agent-studio/server/transcripts/normalize.ts';
import type { Report } from '../../outputs/agent-studio/server/wsl/helper/import.ts';

type Json = Record<string, unknown>;
const TOOL = new URL('../../tools/wsl-import.ts', import.meta.url);
const BUILT = new URL(`../../dist/wsl/linux-${Deno.build.arch === 'aarch64' ? 'arm64' : 'x64'}/AIB-wsl-helper-linux`, import.meta.url);
const NL = '\\n';

const sh = async (script: string, ...args: string[]) => (await inDistro(script, args)).out.trim();

/** tools/wsl-import.ts as the owner runs it (with --json), under the test guard. */
async function tool(...args: string[]): Promise<{ code: number; report: Report | null; err: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', decodeURIComponent(TOOL.pathname).replace(/^\/([A-Za-z]:)/, '$1'), '--distro', KEY, '--state-dir', STATE, '--json', ...args],
    env: { AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: ROOT },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  let report: Report | null = null;
  try {
    report = JSON.parse(text.slice(text.indexOf('{'))) as Report;
  } catch { /* none */ }
  return { code: out.code, report, err: new TextDecoder().decode(out.stderr) + text.slice(0, 2000) };
}

function studioIn(state: string): Studio {
  const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
  studio.ownerProbe = () => null;
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return studio;
}

async function turn(studio: Studio, c: Connection, text: string): Promise<void> {
  await studio.liveCall('prompt', { id: c.id, text, clientMessageId: crypto.randomUUID() });
  await until(() => !c.busy, `the turn "${text}"`, 60);
}

const ID = {
  plain: 'a1111111-aaaa-4aaa-8aaa-000000000001',
  sub: 'b2222222-aaaa-4aaa-8aaa-000000000002',
  running: 'c3333333-aaaa-4aaa-8aaa-000000000003',
  other: 'd4444444-aaaa-4aaa-8aaa-000000000004',
  first: 'e5555555-aaaa-4aaa-8aaa-000000000005',
  codex: 'f6666666-aaaa-4aaa-8aaa-000000000006',
};

/** Writes a Claude Code transcript (filed under the folder named after `cwd`) ten minutes old. */
const CLAUDE_SCRIPT = `set -e
dir="$1/home/.claude/projects/$2"
mkdir -p "$dir"
printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"2026-11-14T10:00:00Z","message":{"role":"user","content":"hello %s"}}\\n' "$3" "$4" "$3" > "$dir/$3.jsonl"
printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"2026-11-14T10:00:05Z","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"hi"}]}}\\n' "$3" "$4" >> "$dir/$3.jsonl"
mkdir -p "$dir/$3/subagents" && printf '{}\\n' > "$dir/$3/subagents/agent-1.jsonl"
touch -d "@$5" "$dir/$3.jsonl" "$dir/$3/subagents/agent-1.jsonl"
`;

Deno.test({
  name: "wsl e2e: the one-off import moves a project's existing chats into their own copies; dry run, apply, resume, merge, undo",
  ...T,
  async fn() {
    const state = STATE;
    await prepareRoot();
    const studios: Studio[] = [];
    try {
      await readyHost();
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      const old = String(Math.floor(Date.now() / 1000) - 600);
      await sh('cd "$1" && git branch -M main && mkdir -p sub && echo two > sub/b.txt && git add -A && git commit -qm two', repo);
      await sh('git -C "$1/repo" worktree add -q -b orca "$1/elsewhere/orca"', ROOT); // another tool's worktree of the repo
      for (const [id, cwd] of [[ID.plain, repo], [ID.sub, `${repo}/sub`], [ID.running, repo], [ID.other, `${ROOT}/elsewhere/orca`], [ID.first, repo]]) {
        const made = await inDistro(CLAUDE_SCRIPT, [ROOT, encoded(cwd), id, cwd, old]);
        assertEquals(made.code, 0, made.err);
      }
      await sh(
        'd="$1/home/.codex/sessions/2026/11/14"; mkdir -p "$d"; f="$d/rollout-2026-11-14T18-04-00-$2.jsonl"; ' +
          'printf \'{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\\n\' "$2" "$3" > "$f"; touch -d "@$4" "$f"',
        ROOT,
        ID.codex,
        repo,
        old,
      );
      // a program that names the running chat's id (as `claude --resume <id>` does), working outside the project
      await sh('cd "$1" && setsid -f python3 -c "import time,sys; time.sleep(900)" "$2" </dev/null >/dev/null 2>&1', ROOT, ID.running);

      const files = () =>
        sh('find "$1/home" "$1/repo" "$1/elsewhere" "$1"/data-*/worktrees "$1"/data-*/studio-worktrees.json "$1/import-backup" -printf "%p %s %T@\\n" 2>/dev/null | sort', ROOT);

      // ---- blockers: a dirty main checkout; nothing is written
      await sh('echo wip > "$1/notes.txt"', repo);
      const dirty = await tool('--project', repo);
      assertEquals(dirty.code, 2, dirty.err);
      assert(dirty.report!.blockers.some((b) => b.startsWith('The main checkout has uncommitted work')), JSON.stringify(dirty.report!.blockers));
      const before = await files();
      const refused = await tool('--project', repo, '--apply');
      assertEquals([refused.code, refused.report?.refused], [2, 'Nothing was changed: fix the blockers above first']);
      assertEquals(await files(), before, 'a refused apply wrote nothing');
      await sh('rm -f -- "$1/notes.txt"', repo);

      // ---- the test guard: never a folder outside /tmp/aib-wsl-test-*
      const guarded = await tool('--project', '/tmp/not-an-aib-test/repo', '--apply');
      assert(guarded.report?.refused?.startsWith('Test guard') || guarded.report?.blockers.length, guarded.err);

      // ---- apply one chat, then the dry run of the rest writes nothing and classifies each
      const one = await tool('--project', repo, '--apply', '--sessions', ID.first.slice(0, 8));
      assertEquals([one.code, one.report!.applied.map((a) => [a.id, a.ok])], [0, [[ID.first, true]]], one.err);
      const snap = await files();
      const plan = await tool('--project', repo);
      assertEquals(plan.code, 0, plan.err);
      assertEquals(await files(), snap, 'the dry run changed nothing');
      const st = Object.fromEntries(plan.report!.chats.map((c) => [c.id, [c.status, c.code ?? '', c.rel]]));
      assertEquals(st, {
        [ID.plain]: ['eligible', '', ''],
        [ID.sub]: ['eligible', '', 'sub'],
        [ID.running]: ['skip', 'running', ''],
        [ID.other]: ['skip', 'other-worktree', ''],
        [ID.first]: ['skip', 'imported', ''],
        [ID.codex]: ['eligible', '', ''],
      });
      // the same dry run through a helper on the Windows disk (/mnt): the route the owner has before AIB installs this helper
      const viaMnt = await tool('--project', repo, '--helper-bin', decodeURIComponent(BUILT.pathname).replace(/^\/([A-Za-z]:)/, '$1'));
      assertEquals([viaMnt.code, viaMnt.report!.chats.length], [0, 6], viaMnt.err);

      // ---- apply all; a re-run changes nothing
      const applied = await tool('--project', repo, '--apply');
      assertEquals(applied.code, 0, applied.err);
      assertEquals(applied.report!.applied.map((a) => [a.id, a.ok]).sort(), [[ID.plain, true], [ID.sub, true], [ID.codex, true]].sort());
      const stamp = applied.report!.stamp!;
      const plainWt = applied.report!.applied.find((a) => a.id === ID.plain)!.worktree!;
      assert(new RegExp(`^${ROOT}/data-[0-9a-f]{12}/worktrees/[0-9a-f]{10}/chat-a1111111$`).test(plainWt), plainWt);
      assertEquals(await sh('test -f "$1/home/.claude/projects/$2/$3.jsonl" && test -f "$1/home/.claude/projects/$2/$3/subagents/agent-1.jsonl" && echo moved', ROOT, encoded(plainWt), ID.plain), 'moved');
      assertEquals(await sh('test -e "$1/home/.claude/projects/$2/$3.jsonl" && echo there || echo gone', ROOT, encoded(repo), ID.plain), 'gone');
      assertEquals(await sh('test -f "$1/import-backup/$2/claude/$3/$4.jsonl" && echo kept', ROOT, stamp, encoded(repo), ID.plain), 'kept');
      assertEquals(await sh('git -C "$1" status --porcelain', repo), '', 'the main checkout untouched');
      const rerun = await tool('--project', repo, '--apply');
      assertEquals([rerun.code, rerun.report!.applied], [0, []]);

      // ---- the saved-chat list: one row per chat
      const listed = await wslSavedSessions();
      for (const id of [ID.plain, ID.sub, ID.first]) assertEquals(listed.filter((s) => s.id === id).length, 1, `one row for ${id}`);
      assertEquals(listed.find((s) => s.id === ID.plain)!.projectRoot, ref);

      // ---- Continue: AIB finds the copy by the session on its record and the agent works there
      const a = studioIn(state);
      studios.push(a);
      const c = await a.connect('claude', ref, ID.plain);
      assert(c.ready && !c.closed, 'continued');
      assertEquals([c.sessionId, c.agentCwd, c.cwd, c.projectRoot, c.worktree?.branch], [
        ID.plain,
        plainWt,
        refOf({ kind: 'wsl', distro: KEY, linuxPath: plainWt }),
        ref,
        'studio/chat-a1111111',
      ]);
      await turn(a, c, `edit:new.txt|chat${NL}`);
      assertEquals(await sh('cat "$1/new.txt"', plainWt), 'chat', 'session/load got the copy as its cwd');
      const view = { token: 't', liveState: (id: string) => (id === c.id ? { cwd: c.cwd } : {}) };
      const [status, changes] = await changesResponse(view, '/api/live/changes', { id: [c.id] }, { 'X-Studio-Token': 't' }) as [number, Json];
      assertEquals([status, changes.scope, changes.worktree, (changes.files as Json[]).map((f) => f.path)], [200, 'branch', { branch: 'studio/chat-a1111111' }, ['new.txt']]);
      await turn(a, c, 'commit:chat work');
      const ctx = { stateDir: a.stateDir, host: a, conversations: { public: () => ({ entries: {} }) } } as never;
      const merge = studioRoutes().get('POST /api/live/worktree/merge')!;
      const [s1, merged] = await merge(ctx, new URL('http://127.0.0.1/api/live/worktree/merge'), { id: c.id, title: 'T' }, new Request('http://127.0.0.1/')) as [number, Json];
      assertEquals([s1, merged.state], [200, 'merged'], JSON.stringify(merged));
      assertEquals(await sh('git -C "$1" show main:new.txt', repo), 'chat');
      const x = await a.connect('codex', ref, ID.codex);
      assert(x.ready && x.agentCwd.endsWith('/chat-f6666666'), x.agentCwd);

      // ---- undo: stop the agents (the test's Linux keeper), then put back what has no work of its own
      for (const host of wslHostsInUse()?.all() ?? []) {
        try {
          await (await host.link.client(false))?.shutdown(true);
        } catch { /* not running */ }
      }
      for (const s of studios) await s.close().catch(() => {});
      studios.length = 0;
      await new Promise((r) => setTimeout(r, 2000));
      const undo = await tool('--project', repo, '--undo', stamp);
      const by = Object.fromEntries(undo.report!.applied.map((r) => [r.id, r]));
      assertEquals([by[ID.sub].ok, by[ID.codex].ok, by[ID.plain].ok], [true, true, false], JSON.stringify(undo.report!.applied));
      assert(by[ID.plain].error!.includes('of its own'), by[ID.plain].error);
      assertEquals(await sh('test -f "$1/home/.claude/projects/$2/$3.jsonl" && test -f "$1/home/.claude/projects/$2/$3/subagents/agent-1.jsonl" && echo back', ROOT, encoded(`${repo}/sub`), ID.sub), 'back');
      assertEquals(await sh('git -C "$1" branch --list "studio/chat-b2222222" "studio/chat-f6666666"', repo), '', 'branches gone');
      assertEquals(await sh('ls "$1"/data-*/worktrees/*/ | sort | tr "\\n" " "', ROOT), 'chat-a1111111 chat-e5555555', 'only the kept copies remain');
      const first = await tool('--project', repo, '--undo', one.report!.stamp!);
      assertEquals([first.code, first.report!.applied.map((r) => [r.id, r.ok])], [0, [[ID.first, true]]], first.err);
      assertEquals(await sh('test -f "$1/home/.claude/projects/$2/$3.jsonl" && echo back', ROOT, encoded(repo), ID.first), 'back');
      assertEquals(await sh('git -C "$1" status --porcelain', repo), '', 'the main checkout still clean');
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await sh('pkill -f -- "$1" || true', ID.running); // only the test's own sleeper names this id
      await cleanRoot();
    }
  },
});
