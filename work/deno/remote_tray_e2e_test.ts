/**
 * Phone access keeps AIB in the tray (owner's decision 2026-11-12, "Yes, keep in tray"): while "Let paired phones reach AIB" is on,
 * closing the AIB window keeps AIB running in the tray, so the phone port keeps answering; only Quit AIB stops it. The rules
 * themselves are in desktop_window_test.ts (fake Shell); these runs use real processes, a temp data folder, OS-picked ports, the
 * fake Tailscale CLI (_fake_tailscale.ts) and forged Serve headers (_remote_fixture.ts), and kill only what they started.
 *
 *   1. A tray-only start (`--start-in-tray`, how the keeper starts AIB again after a crash) with phone access on brings the phone
 *      port up as any start does. (A source run of `serve`: the flag must not keep the phone listener down.)
 *   2. Real binaries (slow: one `deno desktop` build; AIB_SLOW_TESTS=1, Windows only), on an invisible desktop: AIB.exe with phone
 *      access on and nothing working; the person closes the window (WM_CLOSE). AIB.exe stays, the window is gone, the tray says
 *      "AIB · Phone access on", and the phone port still answers after longer than the tray's idle quit (10 s). Then Quit AIB from
 *      the tray menu (TRAY_COMMAND, what a menu click does): AIB.exe exits and the phone port no longer answers.
 */
import { assert, assertEquals } from './_assert.ts';
import { DENO, Fixture, nativePath, SEP, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { builtDist } from './_build_cache.ts';
import { ownerPort, pickPort, refusedPort } from './_ports.ts';
import { WORK } from './_parity.ts';
import { phoneHeaders, raw, serveStatus, tailscaleStatus } from './_remote_fixture.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_VERSION } from '../../outputs/agent-studio/server/core/app.ts';
import { menuCommand, TRAY_COMMAND } from '../../outputs/agent-studio/server/desktop/tray_win.ts';
import { TRAY_ITEMS } from '../../outputs/agent-studio/server/desktop/window.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
const FAKE_TAILSCALE = nativePath(new URL('deno/_fake_tailscale.ts', WORK));
const WM_CLOSE = 0x0010;
type Json = Record<string, unknown>;

/** A data folder with phone access on, its phone ports saved (OS-picked), and the fake Tailscale CLI's answers. */
class PhoneOnFixture extends Fixture {
  readonly answers = this.root + SEP + 'tailscale.json';
  readonly phonePort = pickPort();
  readonly artifactPort = pickPort();
  constructor() {
    super();
    Deno.writeTextFileSync(
      this.state + SEP + 'remote-port.json',
      JSON.stringify({ version: 1, port: this.phonePort, artifactPort: this.artifactPort }),
    );
    Deno.writeTextFileSync(this.state + SEP + 'phone-access.json', JSON.stringify({ version: 1, on: true, via: 'tailscale' }));
    Deno.writeTextFileSync(this.answers, JSON.stringify({ status: tailscaleStatus(), serve: serveStatus(this.phonePort, false) }));
  }
  get phoneEnv(): Record<string, string> {
    return {
      AGENT_STUDIO_TEST: '1',
      AIB_TAILSCALE_CLI: JSON.stringify([DENO, 'run', '-A', '--quiet', FAKE_TAILSCALE, this.answers]),
      AIB_TEST_REMOTE_BIND_MS: '1500',
    };
  }
  override get env(): Record<string, string> {
    return { ...super.env, ...this.phoneEnv };
  }
}

/** The phone page's bootstrap through "Tailscale Serve" (forged headers): the status, or 0 when nothing answers. */
async function phoneBoot(port: number): Promise<number> {
  try {
    return (await raw(port, 'GET', '/api/remote/bootstrap', phoneHeaders())).status;
  } catch {
    return 0;
  }
}

Deno.test({
  ...OPTS,
  name: 'phone access on: a tray-only start (--start-in-tray, the keeper restart after a crash) brings the phone port up',
  async fn() {
    await using fx = new PhoneOnFixture();
    await fx.startWeb(['--start-in-tray']);
    const status = await until(async () => (await phoneBoot(fx.phonePort)) === 200 || null, 'the phone port answers', 30);
    assert(status);
    const r = await raw(fx.phonePort, 'GET', '/api/remote/bootstrap', phoneHeaders());
    assertEquals([r.json.paired, r.json.layout], [false, 'phone']);
  },
});

/** Every process whose program is under `folder` (Win32_Process): AIB.exe and anything it started from its install (the keeper). */
async function processesUnder(folder: string): Promise<number[]> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${
    folder.replaceAll("'", "''")
  }', 'OrdinalIgnoreCase') } | ForEach-Object { $_.ProcessId }`;
  const r = await new Deno.Command('powershell', { args: ['-NoProfile', '-NonInteractive', '-Command', script], stdout: 'piped' })
    .output();
  return new TextDecoder().decode(r.stdout).split(/\r?\n/).filter(Boolean).map(Number);
}

async function unzip(zip: string, into: string): Promise<void> {
  Deno.mkdirSync(into, { recursive: true });
  const r = await new Deno.Command('C:\\Windows\\System32\\tar.exe', { args: ['-xf', zip, '-C', into] }).output();
  assert(r.success, `unzip ${zip}`);
}

/** The app icon's state AIB_TEST_TRAY_STATE writes (desktop/window.ts trayState) for this pid, or null. */
function appTray(folder: string, pid: number): Json | null {
  try {
    return JSON.parse(Deno.readTextFileSync(`${folder}\\app-${pid}.json`));
  } catch {
    return null;
  }
}

Deno.test({
  ...OPTS,
  name: 'real binaries: with phone access on, closing the window keeps AIB in the tray and the phone port answering; Quit AIB stops it',
  ignore: !SLOW,
  async fn() {
    await using fx = new PhoneOnFixture();
    const dist = await builtDist();
    const install = `${fx.root}\\install`;
    await unzip(`${dist}\\AIB-${APP_VERSION}-windows-x64.zip`, install);
    const app = `${install}\\AIB`;
    const trays = `${fx.root}\\trays`;
    Deno.mkdirSync(trays);
    const env: Record<string, string> = {
      ...fx.phoneEnv,
      AGENT_STUDIO_STATE_DIR: fx.state,
      APPDATA: `${fx.root}\\appdata`,
      LOCALAPPDATA: `${fx.root}\\localappdata`,
      AIB_UPDATE_API_BASE: `http://127.0.0.1:${refusedPort()}`, // no update check reaches anything
      AIB_TEST_TRAY_STATE: trays,
      // The desktop app logs at INFO only when no level is given; a test run started from an AIB chat inherits AGENT_STUDIO_LOG_LEVEL=WARNING
      // (main.ts passes it on to what it starts), which hides the close line this test reads from studio.log. Say INFO outright.
      AGENT_STUDIO_LOG_LEVEL: 'INFO',
    };
    for (const d of [env.APPDATA, env.LOCALAPPDATA]) Deno.mkdirSync(d, { recursive: true });
    Deno.writeTextFileSync(`${fx.state}\\desktop-port.json`, JSON.stringify({ port: pickPort(true) }));
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    const flags = fx.agentFlags().filter((_, i, a) => a[i] !== '--state-dir' && a[i - 1] !== '--state-dir');
    let pid = 0;
    try {
      try {
        for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
        pid = desk.spawn([`${app}\\AIB.exe`, ...flags], app);
      } finally {
        for (const k of Object.keys(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
      }
      await ownerPort(fx.state, 90, pid);
      await until(async () => (await phoneBoot(fx.phonePort)) === 200 || null, 'the phone port answers', 60);
      const win = await until(
        () => desk.windows().find((w) => w.pid === pid && w.visible && w.title === 'AIB') ?? null,
        'the AIB window',
        60,
      );
      // the status line and tooltip come with the first tray tick that can count the work (every 2 s)
      await until(
        () => String(appTray(trays, pid)?.tooltip ?? '').startsWith('AIB · Phone access on · ') || null,
        'the tooltip "AIB · Phone access on · ..." with the window open',
        30,
      ).catch((error) => {
        throw new Error(`${error.message}\ntray: ${JSON.stringify(appTray(trays, pid))}\nfiles: ${
          [...Deno.readDirSync(trays)].map((e) => e.name).join(', ')
        }\nlog: ${fx.read(`${fx.state}\\studio.log`).slice(-4000)}`);
      });

      // ---- the person closes the window with nothing working
      assert(desk.post(win, WM_CLOSE), 'WM_CLOSE posted');
      await until(() => appTray(trays, pid)?.background === true || null, 'AIB in the tray (background)', 30);
      await new Promise((r) => setTimeout(r, 13_000)); // longer than the tray's idle quit (10 s)
      assert(pidAlive(pid), 'AIB.exe is still running in the tray');
      assertEquals(
        desk.windows().filter((w) => w.pid === pid && w.visible && w.title === 'AIB').length,
        0,
        'no AIB window is shown',
      );
      const tray = appTray(trays, pid)!;
      assertEquals([tray.shown, tray.background, tray.phoneOn], [true, true, true]);
      assert(String(tray.tooltip).startsWith('AIB · Phone access on · '), String(tray.tooltip));
      assertEquals(await phoneBoot(fx.phonePort), 200, 'the phone port still answers with the window closed');
      const log = Deno.readTextFileSync(`${fx.state}\\studio.log`);
      assert(log.includes('phone access is on; AIB stays in the tray'), log.slice(-3000));

      // ---- Quit AIB from the tray menu
      const trayWindow = await until(
        () => desk.windows().find((w) => w.pid === pid && w.title === 'AIB tray') ?? null,
        "the tray icon's window",
        10,
      );
      const quit = TRAY_ITEMS.findIndex((i) => i.id === 'quit');
      assert(desk.post(trayWindow, TRAY_COMMAND, BigInt(menuCommand(quit))), 'Quit AIB chosen');
      await until(() => !pidAlive(pid) || null, 'AIB.exe exited after Quit AIB', 60);
      assertEquals(await phoneBoot(fx.phonePort), 0, 'the phone port is closed');
    } finally {
      const mine = new Set([pid, ...(await processesUnder(install).catch(() => [] as number[]))]);
      for (const p of mine) {
        if (p && pidAlive(p)) {
          try {
            Deno.kill(p, 'SIGKILL');
          } catch { /* gone */ }
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
      desk.close();
    }
  },
});
