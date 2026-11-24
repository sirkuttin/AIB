/**
 * The phone's New chat in a WSL project (docs/wsl/linking-design.md section 12): the agents offered for a WSL project follow that
 * distro's own On/Off switch (settings agentsByDistro), never the Windows one; a Windows project and the top-level list stay as they
 * were. In-process with a fake context (a real SettingsStore in a temp folder), no Studio and no distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { agentsFor, newChatOptions, setAgentRows } from '../../app/server/remote/newchat.ts';
import { SettingsStore } from '../../app/server/state/settings.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import type { WebContext } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;
const WIN = 'C:\\projects\\shop';
const WSL = 'wsl://ubuntu/home/u/app';

function fakeCtx(settings: SettingsStore): WebContext {
  return {
    settings,
    addedProjects: {
      public: () => ({ added: { a: { path: WIN }, b: { path: WSL } } }),
      projectFolder: (f: string) => f,
    },
    folderPresence: { isGone: () => false },
    projectPrefs: { public: () => ({ projects: {} }) },
    viewPrefs: { public: () => ({ prefs: {} }) },
  } as unknown as WebContext;
}

Deno.test('phone New chat: a WSL project offers agents by its distro switch; Windows projects and the top-level list keep the Windows switch', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-phone-wsl-' });
  const host = new FakeWslHost('unused', 'Ubuntu');
  setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
  // Windows: Codex turned off; Claude Code on
  setAgentRows(() => Promise.resolve([{ id: 'claude', enabled: true }, { id: 'codex', enabled: false }]));
  try {
    const settings = new SettingsStore(dir);
    // Ubuntu: Claude Code off, Codex on (it has no Windows dependence)
    await settings.update({ agentsByDistro: { ubuntu: { claude: false, codex: true } } });
    const ctx = fakeCtx(settings);
    const out = await newChatOptions(ctx, []);
    const ok = (list: Json[]) => list.map((a) => [a.id, a.ok]);
    assertEquals(ok(out.agents as unknown as Json[]), [['claude', true], ['codex', false]], 'the top-level list: Windows switches');
    const win = out.projects.find((p) => p.name === 'shop')!;
    const wsl = out.projects.find((p) => p.name === 'app')!;
    assertEquals('agents' in win, false, 'a Windows project uses the top-level list');
    assertEquals(ok(wsl.agents as unknown as Json[]), [['claude', false], ['codex', true]]);
    const claude = wsl.agents!.find((a) => a.id === 'claude')!;
    assertEquals(claude.why, 'Turned off for Ubuntu in Settings on your PC (AIB Linking (WSL)).');
    assertEquals(wsl.agents!.find((a) => a.id === 'codex')!.why, '');
    assert(wsl.agent !== 'claude', `the default agent is one the distro allows (${wsl.agent})`);
    // what a Start is checked against (#start): the same lists
    assertEquals(agentsFor(ctx, WSL, out.agents).find((a) => a.id === 'claude')!.ok, false);
    assertEquals(agentsFor(ctx, WSL, out.agents).find((a) => a.id === 'codex')!.ok, true);
    assertEquals(agentsFor(ctx, WIN, out.agents).find((a) => a.id === 'codex')!.why, 'Turned off in Settings on your PC.');
    // no saved switch for a distro: every agent on (as the PC's default)
    assertEquals(agentsFor(ctx, 'wsl://debian/srv/x', out.agents).every((a) => a.ok), true);
  } finally {
    setAgentRows(null);
    setWslHostResolver(null);
    Deno.removeSync(dir, { recursive: true });
  }
});
