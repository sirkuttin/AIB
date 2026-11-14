/**
 * The desktop app writes studio.log in its data folder. Real binary (slow: AIB_SLOW_TESTS=1, Windows), started the way the owner
 * starts it (AIB.exe, no arguments, window mode) on an invisible desktop, with a temp LOCALAPPDATA/APPDATA so its data folder is a
 * temp folder; kills only what it started.
 *
 * Why it exists: studio.log of the owner's data folder looked frozen at 2026-11-09. It was not: sessions of the Claude desktop app are
 * MSIX-virtualized, so from inside one, a file under %LOCALAPPDATA% that was once written there (the Python-era studio.log) is
 * shadowed by that old copy in Packages\Claude_*\LocalCache\Local. AIB writes the real file; read it from outside the package.
 */
import { assert } from './_assert.ts';
import { until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { builtDist } from './_build_cache.ts';
import { ownerPort, pickPort, refusedPort } from './_ports.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_VERSION } from '../../outputs/agent-studio/server/core/app.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: 'real binary, window mode (no arguments): the desktop app writes studio.log in its data folder at INFO',
  ignore: !SLOW,
  async fn() {
    const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-desklog-' }));
    const dist = await builtDist();
    const install = `${root}/install`;
    Deno.mkdirSync(install, { recursive: true });
    const r = await new Deno.Command('C:/Windows/System32/tar.exe', {
      args: ['-xf', `${dist}/AIB-${APP_VERSION}-windows-x64.zip`, '-C', install],
    }).output();
    assert(r.success, 'unzip');
    const app = `${install}/AIB`;
    const local = `${root}/localappdata`;
    const data = `${local}/AgentStudio`;
    const env: Record<string, string> = {
      APPDATA: `${root}/appdata`,
      LOCALAPPDATA: local,
      AIB_UPDATE_API_BASE: `http://127.0.0.1:${refusedPort()}`,
    };
    Deno.mkdirSync(env.APPDATA, { recursive: true });
    Deno.mkdirSync(data, { recursive: true });
    Deno.writeTextFileSync(`${data}/desktop-port.json`, JSON.stringify({ port: pickPort(true) }));
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    let pid = 0;
    try {
      try {
        for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
        for (const k of ['AGENT_STUDIO_STATE_DIR', 'AGENT_STUDIO_LOG_LEVEL', 'AGENT_STUDIO_TEST']) Deno.env.delete(k);
        pid = desk.spawn([`${app}/AIB.exe`], app);
      } finally {
        for (const k of new Set([...Object.keys(env), 'AGENT_STUDIO_STATE_DIR', 'AGENT_STUDIO_LOG_LEVEL', 'AGENT_STUDIO_TEST'])) {
          saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
        }
      }
      await ownerPort(data, 90, pid);
      const log = `${data}/studio.log`;
      const text = await until(() => {
        try {
          const t = Deno.readTextFileSync(log);
          return t.includes(' INFO ') ? t : null;
        } catch {
          return null;
        }
      }, 'studio.log with INFO lines', 30).catch((e) => {
        throw new Error(`${e.message}/nfiles: ${[...Deno.readDirSync(data)].map((x) => x.name).join(', ')}`);
      });
      assert(/INFO studio: AIB \S+ on http/.test(text), text.slice(0, 2000));
      assert(text.includes('desktop app'), text.slice(0, 2000));
    } finally {
      if (pid && pidAlive(pid)) {
        try {
          Deno.kill(pid, 'SIGKILL');
        } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 1500));
      desk.close();
    }
  },
});
