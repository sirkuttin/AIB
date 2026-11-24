/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): unlanded work of a WSL project's subagent is handed to the main agent by the same
 * steps as on Windows, run by the distro's helper (`subagent.work`, worktrees/subagent_work.ts): its files, a patch file in the
 * distro that applies by hand, and a discard that keeps the work on a studio/discarded/ branch. Skips cleanly (ignored) without WSL 2
 * and the AIB_WSL_E2E variable. The wake line and the tool itself are unlanded_handoff_test.ts (the swarm side is the same code for a
 * WSL record).
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, ROOT, T } from './_wsl_e2e.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import * as ws from '../../outputs/agent-studio/server/wsl/subagents.ts';

const sh = async (script: string, ...args: string[]) => (await inDistro(script, args)).out.trim();

Deno.test({
  name: 'wsl e2e: a WSL subagent\'s unlanded work: files, a patch that applies by hand, a discard that keeps the branch',
  ...T,
  async fn() {
    await prepareRoot();
    try {
      const repo = `${ROOT}/repo`;
      await sh('git -C "$1" branch -M main', repo);
      await sh('git -C "$1" config core.autocrlf false', repo);
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      const chat = { id: 'abcdef0123456789abcdef0123456789', provider: 'claude', lasting: 'claude:s1', folder: ref, project: ref };
      const rec = await ws.wslSubagentPrepare(chat, { toolUseId: 'toolu_1', agentType: 'general-purpose', description: 'Half done' });
      if ('deny' in rec && /too old/.test(String(rec.deny))) {
        console.log(`(the distro's AIB helper predates subagent.*: ${rec.deny})`);
        return;
      }
      assert(!('deny' in rec), JSON.stringify(rec));
      const id = String(rec.id);
      const linux = (rec.linux as { path: string }).path;
      await ws.wslSubagentBind(chat, 'agent-1');
      await sh('cd "$1" && echo "half of it" > half.txt', linux); // uncommitted, as a stopped subagent leaves it
      await ws.wslSubagentEnd(chat, 'agent-1');
      const status = await ws.wslSubagentWork(KEY, id, 'status');
      if (!status) {
        console.log("(the distro's AIB helper has no subagent.work: nothing to check)");
        return;
      }
      assertEquals(status.files, ['half.txt']);
      assertEquals(status.landed, false);
      const diff = await ws.wslSubagentWork(KEY, id, 'diff');
      assert(diff && diff.patch!.includes('+half of it'), JSON.stringify(diff));
      assertEquals(await sh('git -C "$1" apply --check "$2" && echo ok', repo, String(diff.patchFile)), 'ok', 'the patch applies in the repo');
      const kept = await ws.wslSubagentWork(KEY, id, 'keep', 'half');
      assertEquals(kept?.branch, 'studio/discarded/half');
      assertEquals(await sh('git -C "$1" show studio/discarded/half:half.txt', repo), 'half of it');
      assertEquals(await ws.wslSubagentRelease(KEY, id), 'removed');
      assertEquals(await sh('git -C "$1" branch --list "studio/sub-*"', repo), '', 'the working branch went with the copy');
      assertEquals(await sh('git -C "$1" branch --list "studio/discarded/*" | wc -l', repo), '1', 'the kept branch stays');
      await ws.wslSubagentChatClosed(KEY, chat.id);
    } finally {
      await cleanRoot();
      newAib();
    }
  },
});
