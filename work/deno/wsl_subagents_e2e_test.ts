/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a subagent of a WSL project gets its own worktree in the distro and lands, by the
 * distro's helper (wsl/helper/subagents.ts) through AIB's own client (wsl/subagents.ts). Skips cleanly (ignored) without WSL 2 and the
 * AIB_WSL_E2E variable; the same steps without a distro are wsl_subagents_test.ts.
 *   - the worktree is under the Linux data folder (never /mnt), on a studio/sub-... branch, made from a snapshot of the repo that holds
 *     the repo's uncommitted file, which does not land;
 *   - the subagent's commit lands on main (one "AIB: subagent" commit), and the worktree, branch and record go on release.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, ROOT, T } from './_wsl_e2e.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import * as ws from '../../outputs/agent-studio/server/wsl/subagents.ts';

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
