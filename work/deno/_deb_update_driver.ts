/**
 * The "old AIB" of deb_update_e2e_test.ts, run inside the WSL distro (Deno for Linux) as the test's throwaway user. It is AIB's real
 * update path on a .deb install with nothing faked but the source and where pkexec is: the update comes from a local feed folder
 * (copied and checked against its SHA256SUMS like a download), the install target is found the real way (/usr/lib/aib/aib listed in
 * /var/lib/dpkg/info/aib.list), Install now runs runPkexec (pkexec by an absolute path; here the test's stand-in, which goes through
 * sudo to the real root script and apt, and the root script checks the file against the release's SHA256SUMS itself), and the
 * helper is the real update_helper.ts started detached, as a source run starts it. The quit is recorded and this process exits, so
 * the helper sees the app gone and starts the newly installed version.
 *
 * One argument, JSON: {current, feed, state, helper, tmp, pkexec, mode}. mode 'click' (default): Install now on the PC, then wait for
 * the password step. mode 'scheduled': Install when chats finish, the phone's Install and a few ticks (none may run pkexec).
 * Prints one JSON line: {status, result, after, launched, quit}.
 */
import { DEB_EXE, runPkexec, UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import { remoteInstall } from '../../outputs/agent-studio/server/remote/update.ts';
import { cleanEnv } from '../../outputs/agent-studio/server/desktop/update_helper.ts';
import { spawnDetached } from '../../outputs/agent-studio/server/platform/spawn_detached.ts';

const o = JSON.parse(Deno.args[0]) as {
  current: string;
  feed: string;
  state: string;
  helper: string;
  tmp: string;
  pkexec: string;
  mode?: 'click' | 'scheduled';
};
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
  // the real runPkexec, with the stand-in's absolute path instead of /usr/bin/pkexec (WSL has no polkit agent)
  privileged: (argv) => runPkexec(argv, [o.pkexec]),
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
const caught = (error: unknown) => {
  const e = error as { message?: string; code?: string; extra?: unknown };
  return { error: e.message ?? String(error), code: e.code ?? '', extra: e.extra ?? null };
};
let result: Record<string, unknown>;
if (o.mode === 'scheduled') {
  const steps: Record<string, unknown>[] = [];
  try {
    steps.push({ ok: await svc.install(true) });
  } catch (error) {
    steps.push(caught(error));
  }
  const [code, reply] = await remoteInstall(svc, {});
  steps.push({ status: code, code: reply.code, error: reply.error });
  for (let i = 0; i < 3; i++) await svc.tick();
  result = { steps };
} else {
  try {
    result = { ok: await svc.install() };
    await svc.debSettled();
  } catch (error) {
    result = caught(error);
  }
}
console.log(JSON.stringify({ status, result, after: svc.status(), launched, quit }));
Deno.exit(0);
