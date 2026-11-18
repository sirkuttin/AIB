/**
 * The "old AIB" of deb_update_e2e_test.ts, run inside the WSL distro (Deno for Linux) as the test's throwaway user. It is AIB's real
 * update path on a .deb install with nothing faked but the source and the pkexec on PATH: the update comes from a local feed folder
 * (copied and checked against its SHA256SUMS like a download), the install target is found the real way (/usr/lib/aib/aib listed in
 * /var/lib/dpkg/info/aib.list), Install now runs `pkexec /usr/lib/aib/aib-install-deb <file>` from PATH (the test's stand-in, which
 * goes through sudo to the real root script and apt), and the helper is the real update_helper.ts started detached, as a source run
 * starts it. The quit is recorded and this process exits, so the helper sees the app gone and starts the newly installed version.
 *
 * One argument, JSON: {current, feed, state, helper, tmp}. Prints one JSON line: {status, result, launched, quit}.
 */
import { DEB_EXE, UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import { cleanEnv } from '../../outputs/agent-studio/server/desktop/update_helper.ts';
import { spawnDetached } from '../../outputs/agent-studio/server/platform/spawn_detached.ts';

const o = JSON.parse(Deno.args[0]) as { current: string; feed: string; state: string; helper: string; tmp: string };
let launched = 0;
let quit: boolean | null = null;
const svc = new UpdateService(o.state, {
  key: ['linux', Deno.build.arch === 'aarch64' ? 'arm64' : 'x64'],
  current: o.current,
  repo: 'OWNER/aib', // no GitHub: the local feed only
  feedDir: o.feed,
  getTestBuilds: () => true,
  app: { desktop: true, pid: Deno.pid, exe: DEB_EXE },
  appArgs: ['--state-dir', o.state],
  // updater.ts #launchHelper for a source run: `deno run update_helper.ts <json>`, detached, clean environment, from the temp folder
  launcher: async (args) => {
    launched += 1;
    const child = await spawnDetached(
      [Deno.execPath(), 'run', '-A', '--no-config', '--no-lock', o.helper, JSON.stringify(args)],
      `${o.state}/updates/helper-output.log`,
      o.tmp,
      cleanEnv(Deno.env.toObject()),
    );
    child.close();
  },
  quit: (release) => void (quit = release ?? false),
});
const status = await svc.checkFeed();
let result: Record<string, unknown>;
try {
  result = { ok: await svc.install() };
} catch (error) {
  const e = error as { message?: string; code?: string; extra?: unknown };
  result = { error: e.message ?? String(error), code: e.code ?? '', extra: e.extra ?? null };
}
console.log(JSON.stringify({ status, result, launched, quit }));
Deno.exit(0);
