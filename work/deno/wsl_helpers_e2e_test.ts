/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): helpers (swarm builders) of a WSL project, through the real Swarm and the
 * distro's own helper program (wsl/helper/helpers.ts, merge.ts, worktrees.ts) with Linux git on Linux paths. The flows are the ones
 * wsl_helpers_test.ts runs on fakes (_wsl_helpers_scenarios.ts); here the repos are throwaway folders under AIB_WSL_ROOT
 * (/tmp/aib-wsl-test-<random>) and every worktree, branch, landing, keep and removal happens in the distro. The chat side is the same
 * stub as in the fake run (no real agent starts, so nothing here reads or writes ~/.claude, ~/.codex or ~/.gemini in the distro).
 * Skips cleanly (ignored) without WSL 2 and the AIB_WSL_E2E variable. A distro whose AIB helper predates helper.* is said, not failed.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, ROOT, T } from './_wsl_e2e.ts';
import { wslHelpersAvailable } from '../../app/server/wsl/helpers.ts';
import { conflicts, type Env, startAndLand, stopAndUnlandedWork, SwarmLab, twoHelpersOneFolder } from './_wsl_helpers_scenarios.ts';

/** The distro as a scenario sees it: repos under ROOT, files and git by `wsl --exec`, nothing else. */
class RealDistro implements Env {
  readonly distro = KEY;
  #n = 0;

  async #run(script: string, args: string[], stdin?: Uint8Array): Promise<string> {
    const done = await inDistro(script, args, stdin);
    if (done.code !== 0) throw new Error(`in ${KEY}: ${script} ${args.join(' ')} failed: ${done.err}`);
    return done.out.trim();
  }

  async newRepo(): Promise<string> {
    const dir = `${ROOT}/helpers-repo-${++this.#n}`;
    await this.#run(
      'mkdir -p "$1" && cd "$1" && git init -q -b main && git config user.email t@e && git config user.name t && git config core.autocrlf false' +
        ' && printf "one\\n" > tracked.txt && printf "ignored.log\\nbuild/\\nnode_modules/\\n" > .gitignore && git add -A && git commit -qm first',
      [dir],
    );
    return dir;
  }

  git(dir: string, ...args: string[]): Promise<string> {
    return this.#run('d="$1"; shift; exec git -C "$d" -c user.name=t -c user.email=t@e -c core.autocrlf=false "$@"', [dir, ...args]);
  }

  async write(dir: string, name: string, text: string): Promise<void> {
    await this.#run('mkdir -p "$(dirname "$1/$2")" && cat > "$1/$2"', [dir, name], new TextEncoder().encode(text));
  }

  async read(dir: string, name: string): Promise<string> {
    return (await inDistro('cat "$1/$2"', [dir, name])).out;
  }

  async exists(linuxPath: string): Promise<boolean> {
    return (await inDistro('test -e "$1" && echo yes || echo no', [linuxPath])).out.trim() === 'yes';
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** Runs one flow in the distro; says (and returns) when the distro's AIB helper is older than helper.*. */
async function inRealDistro(flow: (env: Env) => Promise<void>): Promise<void> {
  // only the test root: these flows start no agent, so nothing here needs node or the fake agent in the distro (prepareRoot would)
  const made = await inDistro('mkdir -p "$1" && chmod 700 "$1"', [ROOT]);
  if (made.code !== 0) throw new Error(`could not make ${ROOT} in ${KEY}: ${made.err}`);
  try {
    const why = await wslHelpersAvailable(KEY);
    if (why.includes('too old')) {
      console.log(`(the distro's AIB helper predates helper.*: ${why})`);
      return;
    }
    assertEquals(why, '', 'the distro answers helper.*');
    await flow(new RealDistro());
  } finally {
    await cleanRoot();
    newAib();
  }
}

Deno.test({
  name: 'wsl e2e helpers: start, status, report, land on end, and the copy removed once its chat closed (real distro)',
  ...T,
  fn: () => inRealDistro(startAndLand),
});
Deno.test({
  name: 'wsl e2e helpers: conflicts, the helper resolves while open; a closed helper leaves a landable branch (real distro)',
  ...T,
  fn: () => inRealDistro(conflicts),
});
Deno.test({
  name: 'wsl e2e helpers: stop keeps the work; work_list, work_diff, work_land and work_discard (real distro)',
  ...T,
  fn: () => inRealDistro(stopAndUnlandedWork),
});
Deno.test({
  name: 'wsl e2e helpers: two helpers of one folder land one after the other; Undo and Merge again (real distro)',
  ...T,
  fn: () => inRealDistro(twoHelpersOneFolder),
});

Deno.test({
  name:
    'wsl e2e helpers: the worktree of a helper is under the distro data folder (never /mnt) on a studio/helper- branch, and lands on the folder branch',
  ...T,
  async fn() {
    await inRealDistro(async (env) => {
      const repo = await env.newRepo();
      const lab = new SwarmLab(env, repo);
      try {
        const a = await lab.start();
        assert(new RegExp(`^${ROOT}/data-[0-9a-f]{12}/worktrees/[0-9a-f]{10}/helper-[0-9a-f]{8}$`).test(a.linux), a.linux);
        assertEquals(
          await env.git(repo, 'branch', '--list', 'studio/helper-*', '--format=%(refname:short)'),
          lab.swarm.registry.get(a.id)!.worktree.branch,
        );
        assertEquals(lab.swarm.registry.get(a.id)!.worktree.landOn, 'main');
      } finally {
        await lab.dispose();
      }
    });
  },
});
