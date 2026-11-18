/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): "AIB in <distro>" and Remove AIB from this distro, end to end through the
 * routes, the real helper and keeper, and the last step (docs/wsl/linking-design.md section 13). EVERYTHING is under /tmp: the AIB
 * root is the test's AIB_WSL_ROOT=/tmp/aib-wsl-test-<random> (asserted before anything runs; the helper and the last step refuse
 * anything else under test), and OUT=<root>-out, outside the root, holds the canary folder, a temp HOME with ~/.claude and ~/.codex
 * sentinels (the helper runs with HOME there), and the git project. Processes the test starts are held by their own wsl.exe and
 * ended by the pid they wrote. Never the owner's ~/.aib-server, ~/.claude or ~/.codex, never a process the test did not start.
 *   1. Usage: parts, this data folder and a SECOND fake one (data-000000000000) whose stand-in keeper listens on keeper.sock
 *      (keeperAlive), versions (a fake old one), agents (a fake claude 9.9.9), one chat copy with an untracked file (dirty 1).
 *   2. check refuses the dirty copy; apply without confirm is 400; apply with confirm refuses too and deletes nothing.
 *   3. Clean copy + a stand-in program running from agents/ + links inside the root to the canary and the temp HOME: apply
 *      removes this AIB's data folder only (the other AIB's folder, agents/, every <ver> and the root are kept because its keeper
 *      runs), prunes the project's worktree registration, keeps the chat branch, and the canary and sentinels survive. Status says
 *      removed + off; nothing gives a host; a second apply is 409.
 *   4. Set up again (start=1) reinstalls; with the other folder gone but the program still running from agents/, agents/ is kept
 *      and the old and the current <ver> go (the current one by the last step).
 *   5. With nothing running: everything goes, the root too; the canary and sentinels survive; set up again + remove again is fine.
 *   6. The last step's own guards, run directly on temp folders only: the home folder, a root holding the home, the test guard
 *      (nested, and a stand-in ~/.aib-server), a root that is a link or reached through one, a relative or `..` root, a bad data
 *      name, a data folder that is a link (its target survives), links inside the data folder (only the links go), a gone root.
 */
import { assert, assertEquals } from './_assert.ts';
import { DISTRO, inDistro, KEY, newAib, readyHost, ROOT, STATE, T } from './_wsl_e2e.ts';
import { helperEnv, WslHostImpl, wslHostsInUse } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { wslRoutes } from '../../outputs/agent-studio/server/web/wsl_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import { wslHost } from '../../outputs/agent-studio/server/wsl/access.ts';
import { FINAL_CLEANUP_SCRIPT } from '../../outputs/agent-studio/server/wsl/remove.ts';
import { clearDistroRemoved } from '../../outputs/agent-studio/server/wsl/removed.ts';
import { wslIsRemoved } from '../../outputs/agent-studio/server/wsl/worktrees.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';

type Json = Record<string, unknown>;
const OUT = `${ROOT}-out`;
const HOME = `${OUT}/home`;
const REPO = `${OUT}/repo`;
const CANARY = `${OUT}/canary`;
const OTHER = `${ROOT}/data-000000000000`;
// an old <ver> name the helper's own 30 s clean-up (helper_main.ts cleanOldVersions: no `_`) leaves alone
const OLD = '0.0.1_e2e-deadbeef';
const AGENT = `${ROOT}/agents/claude/9.9.9`;
const SAFE = /^\/tmp\/aib-wsl-test-[0-9a-f]{12}$/;

async function sh(script: string, args: string[] = []): Promise<string> {
  const done = await inDistro(script, args);
  if (done.code !== 0) throw new Error(`in ${DISTRO}: ${script}\n${done.err}`);
  return done.out.trim();
}

const exists = async (path: string) => (await sh('if [ -e "$1" ] || [ -L "$1" ]; then echo yes; else echo no; fi', [path])) === 'yes';

function ctx(): WebContext {
  return {
    token: 't',
    stateDir: STATE,
    terminals: { list: () => [] },
    host: { busyConnections: () => Promise.resolve([]) },
  } as unknown as WebContext;
}

async function route(method: 'GET' | 'POST', path: string, query = '', body: Json | null = null): Promise<[number, Json]> {
  const handler = wslRoutes().get(`${method} ${path}`)!;
  const url = new URL(`http://127.0.0.1${path}${query ? '?' + query : ''}`);
  const [status, out] = await handler(ctx(), url, body, new Request(url, { headers: { 'X-Studio-Token': 't' } }));
  return [status, out as Json];
}

/** A process of the test's own, held by its own wsl.exe; its pid is the one it wrote. */
async function startHeld(script: string, args: string[], pidFile: string): Promise<{ pid: string; stop(): Promise<void> }> {
  const systemRoot = Deno.env.get('SystemRoot') ?? 'C:\\Windows';
  const holder = new Deno.Command(`${systemRoot}\\System32\\wsl.exe`, {
    args: ['--distribution', DISTRO, '--exec', 'sh', '-c', script, 'sh', ...args],
    env: { SystemRoot: systemRoot, WSL_UTF8: '1', WSLENV: '' },
    clearEnv: true,
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  let pid = '';
  for (let i = 0; i < 50 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 200));
    pid = await sh('cat "$1" 2>/dev/null; exit 0', [pidFile]);
  }
  assert(/^\d+$/.test(pid), `the stand-in process started (${pidFile})`);
  return {
    pid,
    async stop() {
      await sh('kill "$1" 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.3; done; exit 0', [pid]);
      try {
        holder.kill();
      } catch { /* gone */ }
      await holder.status;
    },
  };
}

const FAKE_KEEPER = 'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\ns.listen(8)\nwhile True:\n  c,_=s.accept()\n  c.close()\n'; // port-guard: not bound (listen(8) is the backlog of a Unix socket)

async function survivors(): Promise<void> {
  for (const path of [`${CANARY}/keep.txt`, `${HOME}/.claude/sentinel`, `${HOME}/.codex/sentinel`, `${REPO}/a.txt`]) {
    assert(await exists(path), `${path} must survive`);
  }
}

Deno.test({
  name: 'wsl e2e: AIB in <distro>: usage, Remove refusals, removal keeping what another AIB uses, set up again, full removal, guards',
  ...T,
  async fn() {
    // the hard stop before anything: this test only ever touches /tmp/aib-wsl-test-<12 hex> and its -out sibling
    assert(SAFE.test(ROOT) && Deno.env.get('AIB_WSL_ROOT') === ROOT && Deno.env.get('AGENT_STUDIO_TEST') === '1', `unsafe test root ${ROOT}`);
    const held: { pid: string; stop(): Promise<void> }[] = [];
    try {
      await sh(
        'mkdir -p "$1/canary" "$1/home/.claude" "$1/home/.codex" "$1/repo" && echo keep > "$1/canary/keep.txt" && echo s > "$1/home/.claude/sentinel" && echo s > "$1/home/.codex/sentinel" && ' +
          'cd "$1/repo" && git init -q && git config user.email t@e && git config user.name t && echo one > a.txt && git add a.txt && git commit -qm one',
        [OUT],
      );
      newAib({ helperEnv: (install) => ({ ...helperEnv(install), HOME }) });
      const host = await readyHost() as WslHostImpl;
      const install = host.install!;
      assertEquals(install.root, ROOT);
      const data = install.data, ver = install.version;

      // the fakes: an old <ver>, an agent install with its npm cache, a second AIB's data folder with a live stand-in keeper
      await sh('mkdir -p "$1/$2" "$3/bin" "$1/agents/.npm-cache" "$4/keeper" && echo k > "$1/$2/AIB-keeper" && echo b > "$1/agents/.npm-cache/blob" && cp /bin/sleep "$3/bin/fake-agent"', [ROOT, OLD, AGENT, OTHER]);
      held.push(await startHeld('echo $$ > "$2"; exec python3 -c "$3" "$1"', [`${OTHER}/keeper/keeper.sock`, `${OUT}/keeper.pid`, FAKE_KEEPER], `${OUT}/keeper.pid`));
      // one chat copy of the project, with an untracked file
      const plan = (await host.call('worktree.plan', { project: REPO })).plan!;
      await host.call('worktree.create', { plan }, { timeoutMs: 120_000 });
      const copy = plan.path;
      assert(copy.startsWith(`${data}/worktrees/`), copy);
      await sh('echo new > "$1/new.txt"', [copy]);

      // ---- 1. usage
      const [, card] = await route('GET', '/api/live/wsl/aib', `distro=${KEY}&peek=1`);
      assertEquals(card.state, 'ready');
      const usage = card.usage as Json;
      assertEquals([usage.root, usage.current], [ROOT, ver]);
      const folders = Object.fromEntries((usage.dataFolders as Json[]).map((f) => [f.name, [f.mine, f.keeperAlive]]));
      assertEquals(folders[data.split('/').pop()!], [true, true]);
      assertEquals(folders['data-000000000000'], [false, true]);
      assert((usage.versions as string[]).includes(ver) && (usage.versions as string[]).includes(OLD));
      assertEquals((usage.agents as Json[]).map((a) => [a.id, a.versions]), [['claude', ['9.9.9']]]);
      assertEquals(usage.worktrees, { count: 1, dirty: 1 });
      assert((usage.totalBytes as number) > 100_000_000, 'the keeper and helper programs are counted');

      // ---- 2. refusals
      const [, check1] = await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'check' });
      assertEquals(check1.ok, false);
      assert((check1.blocked as string[]).some((b) => b.includes(copy) && /not committed/.test(b)), JSON.stringify(check1.blocked));
      assertEquals((await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'apply' }))[1].code, 'confirm_needed');
      const [, refused] = await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'apply', confirm: true });
      assertEquals([refused.ok, refused.removed], [false, []]);
      assert(await exists(`${copy}/new.txt`) && await exists(data) && wslHost(KEY) !== null, 'nothing changed');

      // ---- 3. remove with another AIB's keeper alive: only this AIB's data folder goes
      await sh('rm -f -- "$1/new.txt"', [copy]);
      // links inside the root to folders outside it, committed in the copy so it stays clean; that commit is work main lacks, so
      // the clean-up before the removal (worktrees/cleanup.ts) keeps the chat branch (a link counts as itself, never its folder)
      await sh('ln -s "$2" "$1/link-out" && git -C "$1" add link-out && git -C "$1" commit -qm link', [copy, CANARY]);
      await sh('ln -s "$2" "$1/escape-canary" && ln -s "$3" "$4/escape-home"', [data, CANARY, HOME, `${ROOT}/agents`]);
      held.push(await startHeld('echo $$ > "$2"; exec "$1" 600', [`${AGENT}/bin/fake-agent`, `${OUT}/agent.pid`], `${OUT}/agent.pid`));
      const [, check2] = await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'check' });
      assertEquals(check2.ok, true, JSON.stringify(check2));
      assertEquals((check2.wouldRemove as Json[]).map((w) => w.path), [`${data}/worktrees`, data]);
      const kept = Object.fromEntries((check2.kept as Json[]).map((k) => [k.path, k.why]));
      for (const p of [OTHER, `${ROOT}/agents`, `${ROOT}/${ver}`, `${ROOT}/${OLD}`, ROOT, `${HOME}/.claude`, `${HOME}/.codex`, REPO]) assert(kept[p], `kept: ${p}`);
      const [code3, out3] = await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'apply', confirm: true });
      assertEquals(code3, 200);
      assertEquals(out3.ok, true, JSON.stringify(out3));
      assert((out3.removed as string[]).includes(data), JSON.stringify(out3.removed));
      assertEquals(await exists(data), false);
      for (const p of [`${OTHER}/keeper/keeper.sock`, `${AGENT}/bin/fake-agent`, `${ROOT}/${ver}/AIB-keeper`, `${ROOT}/${OLD}/AIB-keeper`, `${ROOT}/agents/escape-home`]) {
        assert(await exists(p), `kept: ${p}`);
      }
      await survivors();
      assertEquals(await sh('git -C "$1" worktree list --porcelain | grep -c "^worktree "', [REPO]), '1', 'the copy is pruned from the project');
      assert((await sh('git -C "$1" branch --list "studio/*"', [REPO])).includes(plan.branch.replace(/^studio\//, '')), 'the chat branch stays');
      const procsOf = 'n=0; for p in /proc/[0-9]*; do [ "${p#/proc/}" != "$$" ] || continue; c=$(tr "\\000" " " < "$p/cmdline" 2>/dev/null); ' +
        'case " $c " in *" $1 "*|*"$1/"*) n=$((n + 1));; esac; done; echo $n';
      assertEquals(await sh(procsOf, [data]), '0', 'no process of this AIB is left');
      const [, status] = await route('GET', '/api/live/wsl/status');
      const d = (status.distros as Json[]).find((x) => x.key === KEY)!;
      assertEquals([d.state, d.removed], ['off', true]);
      assertEquals(wslHost(KEY), null);
      assertEquals(await wslIsRemoved(refOf({ kind: 'wsl', distro: KEY, linuxPath: copy })), true);
      assertEquals((await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'apply', confirm: true }))[0], 409);

      // ---- 4. set up again; the other AIB is gone, the program from agents/ still runs
      await held.shift()!.stop(); // the stand-in keeper
      await sh('rm -rf -- "$1"', [OTHER]);
      const [, again] = await route('GET', '/api/live/wsl/aib', `distro=${KEY}&peek=1&start=1`);
      assertEquals(again.state, 'ready', JSON.stringify(again));
      assertEquals((again.usage as Json).worktrees, { count: 0, dirty: 0 });
      const [, out4] = await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'apply', confirm: true });
      assertEquals(out4.ok, true, JSON.stringify(out4));
      assert((out4.kept as Json[]).some((k) => k.path === `${ROOT}/agents` && String(k.why).includes(held[0].pid)), JSON.stringify(out4.kept));
      assertEquals([await exists(`${ROOT}/${OLD}`), await exists(`${ROOT}/${ver}`), await exists(data)], [false, false, false]);
      assert(await exists(`${AGENT}/bin/fake-agent`) && await exists(ROOT));
      await survivors();

      // ---- 5. nothing else runs: everything goes, the root too
      await held.shift()!.stop(); // the stand-in agent
      await route('GET', '/api/live/wsl/aib', `distro=${KEY}&peek=1&start=1`);
      const [, out5] = await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'apply', confirm: true });
      assertEquals(out5.ok, true, JSON.stringify(out5));
      assert((out5.removed as string[]).includes(ROOT), JSON.stringify(out5.removed));
      assertEquals(await exists(ROOT), false);
      await survivors(); // agents/escape-home -> HOME went as a link only
      // idempotent: set up again (the root is made again) and remove again
      await route('GET', '/api/live/wsl/aib', `distro=${KEY}&peek=1&start=1`);
      const [, out6] = await route('POST', '/api/live/wsl/aib/remove', '', { distro: KEY, mode: 'apply', confirm: true });
      assertEquals([out6.ok, await exists(ROOT)], [true, false], JSON.stringify(out6));
      await survivors();

      // ---- 6. the last step's own guards, on temp folders only (HOME is a stand-in under OUT)
      const last = async (home: string, ...args: string[]) => {
        const done = await inDistro(`HOME="$1"; export HOME; shift; ${FINAL_CLEANUP_SCRIPT}`, [home, ...args]);
        return done.out.trim();
      };
      await sh(
        'mkdir -p "$1/aib-wsl-test-home/data-000000000001" "$1/aib-wsl-test-outer/u" "$1/aib-wsl-test-outer/data-000000000001" "$1/hy/.aib-server/data-000000000001" "$1/aib-wsl-test-real/data-000000000001" "$1/aib-wsl-test-r2" "$1/aib-wsl-test-r3/data-000000000003" && ' +
          'for d in aib-wsl-test-home aib-wsl-test-outer hy/.aib-server aib-wsl-test-real; do echo x > "$1/$d/data-000000000001/x"; done && ' +
          'ln -s "$1/canary" "$1/aib-wsl-test-link" && ln -s "$1" "$1/via" && ln -s "$1/canary" "$1/aib-wsl-test-r2/data-000000000002" && ' +
          'ln -s "$1/canary" "$1/aib-wsl-test-r3/data-000000000003/out" && ln -s "$1/home" "$1/aib-wsl-test-r3/data-000000000003/home"',
        [OUT],
      );
      const n = 'data-000000000001';
      assert(/error=the AIB folder is the home folder/.test(await last(`${OUT}/aib-wsl-test-home`, `${OUT}/aib-wsl-test-home`, n, '-', '1', '0')));
      assert(/error=the home folder is inside/.test(await last(`${OUT}/aib-wsl-test-outer/u`, `${OUT}/aib-wsl-test-outer`, n, '-', '1', '0')));
      assert(/error=test guard/.test(await last(HOME, `${OUT}/aib-wsl-test-outer`, n, '-', '1', '1')), 'nested under a test root');
      assert(/error=test guard/.test(await last(`${OUT}/hy`, `${OUT}/hy/.aib-server`, n, '-', '1', '1')), 'a stand-in ~/.aib-server');
      assert(/error=the AIB folder is not a plain folder/.test(await last(HOME, `${OUT}/aib-wsl-test-link`, n, '-', '1', '0')));
      assert(/error=the path to the AIB folder goes through a link/.test(await last(HOME, `${OUT}/via/aib-wsl-test-real`, n, '-', '1', '0')));
      assert(/error=/.test(await last(HOME, 'aib-wsl-test-x', n, '-', '1', '0')), 'relative');
      assert(/error=/.test(await last(HOME, `${OUT}/x/../aib-wsl-test-real`, n, '-', '1', '0')), '..');
      assert(/error=not a data folder name/.test(await last(HOME, `${OUT}/aib-wsl-test-real`, '../canary', '-', '1', '0')));
      assert(/error=not a version name/.test(await last(HOME, `${OUT}/aib-wsl-test-real`, n, '../../canary', '1', '0')));
      for (const d of ['aib-wsl-test-home', 'aib-wsl-test-outer', 'hy/.aib-server', 'aib-wsl-test-real']) assert(await exists(`${OUT}/${d}/${n}/x`), `${d} untouched`);
      assert(/left=.*data-000000000002: it is not a plain folder/.test(await last(HOME, `${OUT}/aib-wsl-test-r2`, 'data-000000000002', '-', '1', '0')));
      assertEquals(await last(HOME, `${OUT}/aib-wsl-test-r3`, 'data-000000000003', '-', '1', '0'), `removed=${OUT}/aib-wsl-test-r3/data-000000000003\nremoved=${OUT}/aib-wsl-test-r3`);
      assertEquals(await last(HOME, `${OUT}/aib-wsl-test-gone`, n, '-', '1', '0'), `gone=${OUT}/aib-wsl-test-gone`);
      await survivors();
    } finally {
      for (const h of held) await h.stop().catch(() => {});
      clearDistroRemoved(KEY);
      for (const host of wslHostsInUse()?.all() ?? []) {
        try {
          const client = await host.link.client(false);
          await client?.shutdown(true);
        } catch { /* not running */ }
      }
      newAib();
      // only the test's own folders (both checked by pattern)
      if (SAFE.test(ROOT)) {
        for (let i = 0; i < 20; i++) {
          const busy = await inDistro('ls "$1"/data-*/keeper/keeper.sock >/dev/null 2>&1 && echo busy || echo free', [ROOT]).catch(() => null);
          if (!busy || busy.out.trim() !== 'busy') break;
          await new Promise((r) => setTimeout(r, 500));
        }
        await inDistro('rm -rf -- "$1" "$1-out"', [ROOT]).catch(() => {});
      }
    }
  },
});
