/**
 * No console window, ever (Windows): a windowless process started the way the web server starts the agent host (spawnDetached:
 * DETACHED_PROCESS | CREATE_NO_WINDOW, so it has no console at all) gets a console with no visible window from ensureHiddenConsole,
 * and the console programs it starts share that console instead of opening their own window. Then the real agent host, started the
 * same way: its console exists and has no visible window. Nothing here can show a window: the probes forbid the AllocConsole
 * fallback, and checks only read window state (GetConsoleWindow / IsWindowVisible / GetConsoleProcessList) through FFI.
 */
import { assert, assertEquals } from './_assert.ts';
import { DENO, Fixture, MAIN, TEST_OPTIONS, until } from './_host_fixture.ts';
import { spawnDetached } from '../../outputs/agent-studio/server/platform/spawn_detached.ts';
import { pidAlive, readInfo, stopHost } from '../../outputs/agent-studio/server/host/host_client.ts';

const WIN = Deno.build.os === 'windows';
const CONSOLE_TS = new URL('../../outputs/agent-studio/server/platform/console.ts', import.meta.url).href;

/** Code that reports this process's console: {cp, window, visible, pids}. Run with `deno eval`. */
const REPORT = `
const k = Deno.dlopen('kernel32.dll', {
  GetConsoleWindow: { parameters: [], result: 'pointer' },
  GetConsoleCP: { parameters: [], result: 'u32' },
  GetConsoleProcessList: { parameters: ['buffer', 'u32'], result: 'u32' },
  FreeConsole: { parameters: [], result: 'i32' },
  AttachConsole: { parameters: ['u32'], result: 'i32' },
}).symbols;
const u = Deno.dlopen('user32.dll', { IsWindowVisible: { parameters: ['pointer'], result: 'i32' } }).symbols;
function report() {
  const w = k.GetConsoleWindow();
  const list = new Uint32Array(64);
  const n = k.GetConsoleProcessList(list, 64);
  return { cp: k.GetConsoleCP(), window: w !== null, visible: w !== null && u.IsWindowVisible(w) !== 0, pids: [...list.slice(0, Math.min(n, 64))] };
}
`;

function probeScript(dir: string): string {
  const path = `${dir}\\probe.ts`;
  Deno.writeTextFileSync(
    path,
    `import { ensureHiddenConsole } from ${JSON.stringify(CONSOLE_TS)};
${REPORT}
const [out, mode] = Deno.args;
const before = k.GetConsoleCP();
const result = ensureHiddenConsole({ skipNoWindowMode: mode === 'attach', visibleFallback: false });
const self = report();
// Only with a hidden console: without one, the child would open a window of its own (the very thing this test guards against).
const safe = self.cp !== 0 && !self.visible;
const child = safe
  ? JSON.parse(new TextDecoder().decode((await new Deno.Command(Deno.execPath(), {
    args: ['eval', ${JSON.stringify(REPORT)} + 'console.log(JSON.stringify(report()))'],
    stdin: 'null', stdout: 'piped', stderr: 'null',
  }).output()).stdout))
  : { visible: null, pids: [] };
Deno.writeTextFileSync(out, JSON.stringify({ pid: Deno.pid, before, result, self, child }));
`,
  );
  return path;
}

for (const mode of ['default', 'attach']) {
  Deno.test({
    name: `a windowless process gets a console with no visible window, and its console children share it (${mode})`,
    ignore: !WIN,
    ...TEST_OPTIONS,
    fn: async () => {
      const dir = Deno.makeTempDirSync({ prefix: 'aib-console-' });
      try {
        const out = `${dir}\\out.json`;
        const child = await spawnDetached([DENO, 'run', '-A', '--quiet', probeScript(dir), out, mode], `${dir}\\probe.log`, dir);
        try {
          await until(() => {
            try {
              return JSON.parse(Deno.readTextFileSync(out));
            } catch {
              return null;
            }
          }, 'probe report', 60);
        } finally {
          // The probe writes its report, then still has to exit; its folder is its working directory and its log is open until
          // it has. Removing the folder before that fails with "being used by another process" (seen under load).
          try {
            await until(() => child.exitCode() !== null, 'probe exit', 30);
          } catch {
            try {
              Deno.kill(child.pid, 'SIGKILL');
            } catch { /* gone */ }
            await until(() => child.exitCode() !== null, 'probe killed', 10).catch(() => {});
          }
          child.close();
        }
        const r = JSON.parse(Deno.readTextFileSync(out));
        const log = (() => {
          try {
            return Deno.readTextFileSync(`${dir}\\probe.log`);
          } catch {
            return '';
          }
        })();
        assertEquals(r.before, 0, 'started with no console at all, like the agent host');
        // default: NO_WINDOW on Windows 11 24H2+, the windowless helper console before that; never the visible fallback
        assert(mode === 'attach' ? r.result === 'attached' : ['no-window', 'attached'].includes(r.result), `${r.result}\n${log}`);
        assert(r.self.cp !== 0, 'it has a console now');
        assertEquals(r.self.visible, false, 'and that console has no visible window');
        assertEquals(r.child.visible, false, 'the child shows no window');
        assert(r.child.pids.includes(r.pid), `the child shares the parent's hidden console: ${JSON.stringify(r.child)}`);
      } finally {
        Deno.removeSync(dir, { recursive: true });
      }
    },
  });
}

Deno.test({
  name: 'the agent host, started detached as the web server starts it, has a console with no visible window',
  ignore: !WIN,
  ...TEST_OPTIONS,
  fn: async () => {
    await using fx = new Fixture();
    const env = { ...Deno.env.toObject(), ...fx.env, USERPROFILE: fx.root, HOME: fx.root };
    const host = await spawnDetached([DENO, 'run', '-A', '--quiet', MAIN, 'host', ...fx.agentFlags(), '--idle-exit-minutes', '2'], `${fx.root}\\host.log`, fx.root, env);
    fx.hostPids.add(host.pid);
    host.close();
    const info = await until(async () => (await readInfo(fx.state))?.pid === host.pid ? await readInfo(fx.state) : null, 'host file', 60);
    // A helper leaves its own console and joins the host's: the host has one, and it has no visible window.
    const out = await new Deno.Command(DENO, {
      args: [
        'eval',
        REPORT + `k.FreeConsole(); const ok = k.AttachConsole(${info.pid}); console.log(JSON.stringify({ ok, ...report() }));`,
      ],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const r = JSON.parse(new TextDecoder().decode(out.stdout));
    assert(r.ok !== 0, 'the host has a console (so its agents and git share it)');
    assertEquals(r.visible, false, 'the host console has no visible window');
    assert(r.pids.includes(info.pid), JSON.stringify(r));
    const stopped = await stopHost(fx.state, true);
    assert(stopped.stopped, stopped.message);
    await until(() => !pidAlive(info.pid), 'host exit');
  },
});
