/**
 * wsl/hosts.ts against a real WSL distro (docs/wsl/design.md sections 3, 7 and 11): the transport is a real hidden
 * `wsl.exe --distribution D --cd ~ --exec <root>/<ver>/AIB-keeper bridge --data <root>/data-<hash>`, the Linux keeper is the real
 * keeper built for Linux from keeper/ (Go, GOOS=linux), and killing the transport's wsl.exe is survived: the link re-attaches from
 * the last record, the agent in the distro keeps running, no record is lost or doubled, and onLost never fires.
 *
 * Requires Track A's artifacts in part: `AIB-keeper bridge` (keeper/bridge.go) is not merged yet, so the "keeper" installed is
 * work/wsl_standin_bridge.py, which does the bridge's job and runs the real Linux keeper for everything else; the helper is
 * work/wsl_fake_helper.py. Swap both for the real programs (AIB_WSL_KEEPER_BIN / AIB_WSL_HELPER_BIN) once Track A lands.
 *
 * Runs only with AIB_WSL_E2E=<distro> (needs python3 in the distro and Go on Windows); ignored otherwise. Everything lives in
 * /tmp/aib-wsl-test-<random> (never ~/.aib-server) and is removed; the Linux keeper started here is shut down. Never
 * `wsl --shutdown`/`--terminate`; only the wsl.exe processes this test started are killed.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { findDistro } from '../../outputs/agent-studio/server/wsl/detect.ts';
import { COPY_SCRIPT, installWsl, runWsl, type WslInstall } from '../../outputs/agent-studio/server/wsl/install.ts';
import { spawnWslTransport, type TransportProcess, WslHostImpl } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { type KeeperRecord, keeperSourceDir } from '../../outputs/agent-studio/server/keeper/client.ts';
import { liveUserChannels } from '../../outputs/agent-studio/server/keeper/link.ts';

const WANTED = Deno.env.get('AIB_WSL_E2E') ?? '';
const DISTRO = WANTED ? findDistro(WANTED)?.name ?? '' : '';
const GO = Deno.env.get('GO') || (Deno.build.os === 'windows' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
const T = {
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: !DISTRO || !keeperSourceDir(),
};
const ENC = new TextEncoder();
const DEC = new TextDecoder();

function lf(url: URL): Uint8Array {
  return ENC.encode(Deno.readTextFileSync(url).replaceAll('\r\n', '\n'));
}

async function sh(script: string, ...args: string[]): Promise<string> {
  const out = await runWsl(DISTRO, ['/bin/sh', '-c', script, 'sh', ...args]);
  if (out.code !== 0) throw new Error(`sh failed (${out.code}): ${out.stderr}`);
  return DEC.decode(out.stdout).trim();
}

/** The real keeper, built for Linux (amd64) from keeper/ into `dir`. */
async function linuxKeeper(dir: string): Promise<Uint8Array> {
  const out = `${dir}/AIB-keeper-linux`;
  const built = await new Deno.Command(GO, {
    args: ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'],
    cwd: keeperSourceDir()!,
    env: {
      CGO_ENABLED: '0',
      GOOS: 'linux',
      GOARCH: Deno.build.arch === 'aarch64' ? 'arm64' : 'amd64',
    },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!built.success) throw new Error(`go build failed: ${DEC.decode(built.stderr).slice(-1500)}`);
  return Deno.readFileSync(out);
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
      const helper = ENC.encode('#!/usr/bin/env python3\n' + DEC.decode(lf(new URL('../wsl_fake_helper.py', import.meta.url))));
      const install: WslInstall = await installWsl(DISTRO, {
        stateDir,
        root,
        programs: {
          keeper: lf(new URL('../wsl_standin_bridge.py', import.meta.url)),
          helper,
          from: 'stand-ins',
        },
      });
      const real = await linuxKeeper(stateDir);
      const placed = await runWsl(DISTRO, ['/bin/sh', '-c', COPY_SCRIPT, 'sh', `${install.root}/${install.version}/AIB-keeper-real`], {
        stdin: real,
        timeoutMs: 180_000,
      });
      assertEquals(placed.code, 0, placed.stderr);

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
