/**
 * wsl/hosts.ts against a real WSL distro (docs/wsl/design.md sections 3, 7 and 11): the transport is a real hidden
 * `wsl.exe --distribution D --cd ~ --exec <root>/<ver>/AIB-keeper bridge --data <root>/data-<hash>`, the Linux keeper and the helper
 * are the real Linux programs (tools/build.ts buildWslBinaries, cached by source hash), and killing the transport's wsl.exe is
 * survived: the link re-attaches from the last record, the agent in the distro keeps running, no record is lost or doubled, and
 * onLost never fires.
 *
 * Runs only with AIB_WSL_E2E=<distro> (needs Go and Deno on Windows to build the programs); ignored otherwise. Everything lives in
 * /tmp/aib-wsl-test-<random> (never ~/.aib-server) and is removed; the Linux keeper started here is shut down. Never
 * `wsl --shutdown`/`--terminate`; only the wsl.exe processes this test started are killed.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { findDistro } from '../../app/server/wsl/detect.ts';
import { installWsl, runWsl, type WslInstall } from '../../app/server/wsl/install.ts';
import { spawnWslTransport, type TransportProcess, WslHostImpl } from '../../app/server/wsl/hosts.ts';
import { type KeeperRecord, keeperSourceDir } from '../../app/server/keeper/client.ts';
import { liveUserChannels } from '../../app/server/keeper/link.ts';
import { buildWslBinaries, REPO, TARGETS, WSL_HELPER, WSL_KEEPER, wslTarget } from '../../tools/build.ts';

const WANTED = Deno.env.get('AIB_WSL_E2E') ?? '';
const DISTRO = WANTED ? findDistro(WANTED)?.name ?? '' : '';
const T = {
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: !DISTRO || !keeperSourceDir(),
};
const ENC = new TextEncoder();
const DEC = new TextDecoder();

async function sh(script: string, ...args: string[]): Promise<string> {
  const out = await runWsl(DISTRO, ['/bin/sh', '-c', script, 'sh', ...args]);
  if (out.code !== 0) throw new Error(`sh failed (${out.code}): ${out.stderr}`);
  return DEC.decode(out.stdout).trim();
}

/** The real Linux keeper and helper of this checkout (built once per source change). */
async function linuxPrograms(): Promise<{ keeper: Uint8Array; helper: Uint8Array; from: string }> {
  const arch = Deno.build.arch === 'aarch64' ? 'arm64' : 'x64';
  const dir = `${REPO}/dist/wsl/e2e-linux-${arch}`;
  await buildWslBinaries(wslTarget(TARGETS.find((x) => x.id === `windows-${arch}`)!), dir);
  return { keeper: await Deno.readFile(`${dir}/${WSL_KEEPER}`), helper: await Deno.readFile(`${dir}/${WSL_HELPER}`), from: dir };
}

Deno.test({
  name: `reconnect in ${DISTRO || 'a WSL distro (AIB_WSL_E2E unset)'}: killing the transport wsl.exe loses no record and no agent`,
  ...T,
  async fn() {
    const root = `/tmp/aib-wsl-test-${crypto.randomUUID().slice(0, 12)}`;
    const stateDir = await Deno.makeTempDir({ prefix: 'aib-wsl-reconnect-' });
    const transports: TransportProcess[] = [];
    let host: WslHostImpl | null = null;
    try {
      const install: WslInstall = await installWsl(DISTRO, { stateDir, root, programs: await linuxPrograms() });

      host = new WslHostImpl({
        distro: DISTRO,
        stateDir,
        install: () => Promise.resolve(install),
        reconnect: { delaysMs: [250, 500, 1000], totalMs: 20_000 },
        spawnTransport: (d, argv) => {
          const t = spawnWslTransport(d, argv);
          transports.push(t);
          return t;
        },
        wslExe: null, // no keep-alive here: this test is about the transport
      });
      await host.start();
      assertEquals(host.state, 'ready');
      assertEquals(host.preamble?.home, install.home);
      assertEquals(await host.call('which', { name: 'git' }), {
        path: '/usr/bin/git',
      });

      const records: KeeperRecord[] = [];
      const lost: unknown[] = [];
      let onLost = 0;
      host.link.onLost = () => onLost++;
      const agent = host.link.spawn(
        {
          channel: 'e2e-agent',
          command: '/bin/sh',
          args: ['-c', 'while read l; do echo "got:$l"; done'],
          cwd: '/tmp',
          env: { PATH: '/usr/bin:/bin', HOME: root },
        },
        { record: (r) => records.push(r), lost: (e) => lost.push(e) },
      );
      const out = () =>
        records.filter((r) => r.kind === 'out').map((r) => DEC.decode(r.body))
          .join('');
      await agent.write(ENC.encode('one\n'), 'e2e-1');
      await until(() => out().includes('got:one'), 'first echo', 20);

      const states: string[] = [];
      const before = host.link.onTransport!;
      host.link.onTransport = (state, error) => {
        states.push(state);
        before(state, error);
      };
      transports[0].kill(); // the transport's wsl.exe is killed (Task Manager, a crash)
      await until(() => states.includes('lost'), 'transport lost', 20);
      const during = agent.write(ENC.encode('two\n'), 'e2e-2');
      await until(() => states.includes('restored'), 'transport restored', 30);
      assert(await during, 'the write made while the transport was down went out after it');
      await until(() => out().includes('got:two'), 'echo after reconnect', 20);
      assertEquals(out(), 'got:one\ngot:two\n');
      const seqs = records.map((r) => r.seq);
      assertEquals(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'each record once, in order');
      assertEquals([onLost, lost.length, transports.length], [0, 0, 2]);
      assertEquals(await host.call('which', { name: 'ls' }), {
        path: '/usr/bin/ls',
      });
      const client = (await host.link.client(false))!;
      assertEquals(liveUserChannels(await client.list()).map((c) => c.channel), ['e2e-agent'], 'one agent, never started twice');
      await agent.kill();
      await client.shutdown(true).catch(() => {});
    } finally {
      host?.stop();
      for (const t of transports) t.kill();
      // the keeper shut down above; wait for it to leave before removing its folder (it never outlives ~20 s on its own)
      for (let i = 0; i < 20; i++) {
        const busy = await sh('ls "$1"/data-*/keeper/keeper.sock >/dev/null 2>&1 && echo busy || echo free', root).catch(() => 'free');
        if (busy === 'free') break;
        await pause(500);
      }
      await sh('case "$1" in /tmp/aib-wsl-test-*) rm -rf -- "$1";; esac', root)
        .catch(() => {});
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
    }
  },
});
