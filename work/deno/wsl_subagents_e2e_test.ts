/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a subagent of a WSL project gets its own worktree in the distro and lands, by the
 * distro's helper (wsl/helper/subagents.ts) through AIB's own client (wsl/subagents.ts). Skips cleanly (ignored) without WSL 2 and the
 * AIB_WSL_E2E variable; the same steps without a distro are wsl_subagents_test.ts.
 *   - the worktree is under the Linux data folder (never /mnt), on a studio/sub-... branch, made from a snapshot of the repo that holds
 *     the repo's uncommitted file, which does not land;
 *   - the subagent's commit lands on main (one "AIB: subagent" commit), and the worktree, branch and record go on release.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>.
 * The second test is the full flow through the agent's own hooks: the hook commands AIB gave the chat run in the distro (the Linux keeper's
 * `hook <event> --helper-socket`), reach AIB through the helper's relay and channel, and the subagent works in a worktree there and lands.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { Swarm } from '../../app/server/swarm/service.ts';
import { refOf } from '../../app/server/platform/location.ts';
import * as ws from '../../app/server/wsl/subagents.ts';

const sh = async (script: string, ...args: string[]) => (await inDistro(script, args)).out.trim();

Deno.test({
  name: 'wsl e2e: a subagent of a WSL project gets its own worktree in the distro and lands with its own work only',
  ...T,
  async fn() {
    await prepareRoot();
    try {
      const repo = `${ROOT}/repo`;
      await sh('git -C "$1" branch -M main', repo);
      await sh('cd "$1" && git config core.autocrlf false && echo "my own unsaved work" > mine.txt', repo);
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      const chat = { id: 'abcdef0123456789abcdef0123456789', provider: 'claude', lasting: 'claude:s1', folder: ref, project: ref };
      const rec = await ws.wslSubagentPrepare(chat, { toolUseId: 'toolu_1', agentType: 'general-purpose', description: 'Make the docs' });
      if ('deny' in rec && /too old/.test(String(rec.deny))) {
        console.log(`(the distro's AIB helper predates subagent.*: ${rec.deny})`);
        return;
      }
      assert(!('deny' in rec), JSON.stringify(rec));
      const linux = (rec.linux as { path: string }).path;
      assert(new RegExp(`^${ROOT}/data-[0-9a-f]{12}/worktrees/[0-9a-f]{10}/sub-abcdef01-1$`).test(linux), linux);
      assertEquals(await sh('git -C "$1" show-ref --verify --quiet refs/heads/studio/sub-abcdef01-1 && echo yes', repo), 'yes');
      assertEquals(await sh('cat "$1/mine.txt"', linux), 'my own unsaved work', 'the snapshot holds the repo\'s uncommitted file');
      await ws.wslSubagentBind(chat, 'agent-1');
      await sh('cd "$1" && echo "from the subagent" > sub.txt && git add sub.txt && git -c user.name=t -c user.email=t@e commit -qm "subagent work"', linux);
      await ws.wslSubagentEnd(chat, 'agent-1');
      const state = { state: 'ready', busy: false, cwd: `${repo}`, provider: 'claude' };
      const landed = await ws.wslSubagentLand(KEY, {
        id: String(rec.id),
        parent: chat.id,
        target: 'main',
        title: 'Make the docs',
        held: [chat.id],
        states: { [chat.id]: state },
      });
      assertEquals(landed.outcome.state, 'merged', JSON.stringify(landed.outcome));
      assertEquals(await sh('git -C "$1" show main:sub.txt', repo), 'from the subagent');
      assertEquals(await sh('git -C "$1" ls-tree --name-only main | grep -c "^mine.txt$" || true', repo), '0', 'the repo\'s uncommitted file did not land');
      assertEquals(await sh('cat "$1/mine.txt"', repo), 'my own unsaved work');
      assertEquals(await ws.wslSubagentRelease(KEY, String(rec.id)), 'removed');
      await ws.wslSubagentChatClosed(KEY, chat.id);
      assertEquals(await sh('git -C "$1" branch --list "studio/sub-*"', repo), '');
      assertEquals((await ws.wslSubagentRecords(KEY)).length, 0);
    } finally {
      await cleanRoot();
      newAib();
    }
  },
});

// ---- the full flow, through the agent's own hooks (the Linux keeper's `hook <event> --helper-socket`) ---------------------------------

type Hook = { type: string; command: string };
// the first command of each event (PreToolUse also has hook 2's pre-shell entry after the pre-tool one)
const commandsOf = (settings: unknown) =>
  Object.fromEntries(
    Object.entries((settings as { hooks: Record<string, { hooks: Hook[] }[]> }).hooks).map(([event, groups]) => [event, groups[0].hooks[0].command] as const),
  );

Deno.test({
  name: 'wsl e2e: the agent\'s hooks in the distro reach AIB through the helper (Linux keeper, relay, helper channel); the subagent works in a worktree there and lands',
  ...T,
  async fn() {
    await prepareRoot();
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-subagent-hooks-e2e-' });
    Deno.env.set('AGENT_STUDIO_ALLOW_REAL_AGENT', '1'); // hooks are set up for a non-fixture agent (the factory below runs the fake agent)
    const aib = new Aib({ stateDir: state, port: 0, ownersDir: null }, { keeper: null });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(['node', `${ROOT}/fake_acp.mjs`, '--cancel-aware'], cwd, provider, {
        ...options,
        wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/node' } : options?.wsl,
      });
    const swarm = new Swarm({ stateDir: state, host: aib, settings: aib.settings });
    try {
      const repo = `${ROOT}/repo`;
      await sh('git -C "$1" branch -M main', repo);
      await sh('cd "$1" && git config core.autocrlf false && echo "my own unsaved work" > mine.txt', repo);
      const host = await readyHost();
      if (!host.hookTunnel) {
        console.log("(the distro's AIB helper has no subagent hook support: nothing to check)");
        return;
      }
      const c = await aib.connect('claude', refOf({ kind: 'wsl', distro: KEY, linuxPath: repo }));
      for (let i = 0; i < 100 && c.busy; i++) await new Promise((r) => setTimeout(r, 100));
      // hooks on, running the distro's own keeper program on the helper's socket
      assertEquals(c.subagentHooks!.off, '', JSON.stringify(c.subagentHooks));
      const commands = commandsOf(c.subagentHooks!.settings);
      assert(commands.PreToolUse.startsWith(`"${host.hookTunnel.forwarder}" hook pre-tool --helper-socket "${host.hookTunnel.socket}"`), commands.PreToolUse);
      const env = (c as unknown as { env: Record<string, string> }).env;
      assertEquals(env.AIB_HOOK_CHAT, c.id);
      /** Run one hook command the way Claude Code does: a shell, the hook's JSON on stdin, the chat's environment. */
      const run = (command: string, input: unknown, key = env.AIB_HOOK_KEY) =>
        inDistro(
          'export AIB_HOOK_KEY="$1" AIB_HOOK_CHAT="$2" AIB_HOOK_READONLY="$3"; exec sh -c "$4"',
          [key, c.id, env.AIB_HOOK_READONLY ?? '', command],
          new TextEncoder().encode(JSON.stringify(input)),
        );

      // PreToolUse(Agent): AIB makes the worktree in the distro and the forwarder (which checked AIB's proof) prints the isolated call
      const pre = await run(commands.PreToolUse, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'general-purpose', description: 'Make the docs', prompt: 'x' } });
      assertEquals(pre.code, 0, pre.err);
      assertEquals(JSON.parse(pre.out).hookSpecificOutput.updatedInput.isolation, 'worktree');
      // WorktreeCreate: the bare path of a worktree the forwarder checked (under the distro's data folder, a real folder, no link)
      const created = await run(commands.WorktreeCreate, { hook_event_name: 'WorktreeCreate', name: 'agent-a1' });
      assertEquals(created.code, 0, created.err);
      const worktree = created.out.trim();
      assert(new RegExp(`^${ROOT}/data-[0-9a-f]{12}/worktrees/[0-9a-f]{10}/sub-${c.id.slice(0, 8)}-1$`).test(worktree), worktree);
      assertEquals(await sh('git -C "$1" show-ref --verify --quiet "refs/heads/studio/sub-$2-1" && echo yes', repo, c.id.slice(0, 8)), 'yes');
      assertEquals(await sh('cat "$1/mine.txt"', worktree), 'my own unsaved work', "the snapshot holds the repo's uncommitted file");
      // its edits stay in the worktree
      await sh('cd "$1" && echo "from the subagent" > sub.txt && git add sub.txt && git -c user.name=t -c user.email=t@e commit -qm "subagent work"', worktree);
      assertEquals(await sh('git -C "$1" status --porcelain | grep -c sub.txt || true', repo), '0', 'the repo has none of it yet');
      // SubagentStop
      const stop = await run(commands.SubagentStop, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose' });
      assertEquals(stop.code, 0, stop.err);
      // 2026-11-25: a SubagentStop alone is not the end (another hook may block it and keep the subagent working): nothing lands
      assert((await ws.wslSubagentRecords(KEY, c.id)).some((r) => r.state === 'running'), JSON.stringify(await ws.wslSubagentRecords(KEY, c.id)));
      await swarm.poll();
      assert(!(await sh('git -C "$1" log --format=%s -n 5 main', repo)).includes('AIB: subagent'), 'a builder still working landed');
      // the foreground Agent call returning is its real end (the stream's end for a background one): the distro marks it done, AIB lands it
      // at once, whatever the parent's turn is doing (no edit or shell call is open here)
      const post = await run(commands.PostToolUse, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_response: { agentId: 'a1', status: 'completed' } });
      assertEquals(post.code, 0, post.err);
      // a wrong hook key: AIB's answer is unsigned for it, so the call is blocked (exit 2), and nothing is made
      const wrong = await run(commands.PreToolUse, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_2', tool_input: { subagent_type: 'general-purpose', description: 'x', prompt: 'x' } }, 'wrong-key');
      assertEquals(wrong.code, 2, wrong.out + wrong.err);
      // the swarm lands it into the repo's branch in the distro
      await swarm.poll();
      let landed = '';
      for (let i = 0; i < 100 && !landed.includes('AIB: subagent Make the docs'); i++) {
        landed = await sh('git -C "$1" log --format=%s -n 5 main', repo);
        if (!landed.includes('AIB: subagent')) await new Promise((r) => setTimeout(r, 300));
      }
      assert(landed.includes('AIB: subagent Make the docs'), landed);
      assertEquals(await sh('git -C "$1" show main:sub.txt', repo), 'from the subagent');
      assertEquals(await sh('git -C "$1" ls-tree --name-only main | grep -c "^mine.txt$" || true', repo), '0', "the repo's uncommitted file did not land");
      assertEquals(await sh('cat "$1/mine.txt"', repo), 'my own unsaved work');
      // released: the worktree and its branch go
      for (let i = 0; i < 100 && (await sh('test -e "$1" && echo there || echo gone', worktree)) === 'there'; i++) await new Promise((r) => setTimeout(r, 300));
      assertEquals(await sh('test -e "$1" && echo there || echo gone', worktree), 'gone');
      // (the chat's next spare worktree, studio/sub-<id>-2, is made in the background and goes when the chat closes: only the landed one is checked)
      assertEquals(await sh('git -C "$1" branch --list "studio/sub-*-1"', repo), '');
    } finally {
      await swarm.stopWatching().catch(() => {});
      await aib.close().catch(() => {});
      await cleanRoot();
      newAib();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
