/**
 * wsl/hosts.ts against a fake bridge: the "transport" is an in-process stand-in for `wsl.exe … AIB-keeper bridge` that prints a
 * wsl.exe notice, BRIDGE_MAGIC and the preamble, then splices its pipes to a REAL keeper (built from keeper/ with Go) on this PC,
 * started the way the real bridge starts the Linux keeper when none runs. The helper is work/wsl_fake_helper.py. So the keeper
 * protocol, the preamble parsing, the helper protocol, the transport-loss rules of KeeperLink (keeper/link.ts), helper adoption and
 * version replacement, and the keep-alive in a second ("Windows") keeper are all exercised without WSL. The real-WSL tests are
 * wsl_install_e2e_test.ts and wsl_reconnect_e2e_test.ts. Temp folders only; every keeper started here is shut down.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, PYTHON, until } from './_connection.ts';
import {
  ensureKeeper,
  KeeperClient,
  KeeperError,
  type KeeperRecord,
  readKeeperInfo,
} from '../../app/server/keeper/client.ts';
import { aibInternalKind, isAibInternalLabel, KeeperLink, liveUserChannels } from '../../app/server/keeper/link.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import {
  acceptableUrl,
  bridgeServeArgs,
  type TransportProcess,
  type TransportSpawner,
  WslHostImpl,
  type WslHostOptions,
  WslHosts,
} from '../../app/server/wsl/hosts.ts';
import type { WslInstall } from '../../app/server/wsl/install.ts';
import { BRIDGE_MAGIC, WslHelperError } from '../../app/server/wsl/contract.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const FAST = ['--exit-after', '3s', '--orphan-after', '60s'];
const HELPER = new URL('../wsl_fake_helper.py', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const ECHO = 'import sys\nfor line in sys.stdin:\n    sys.stdout.write("got:" + line)\n    sys.stdout.flush()\n';

async function stopKeeper(dir: string): Promise<void> {
  const info = readKeeperInfo(dir);
  if (!info || !pidAlive(info.pid)) return;
  try {
    const c = await KeeperClient.connect(info);
    await c.shutdown(true).catch(() => {});
    c.close();
  } catch { /* gone */ }
  await until(() => !pidAlive(info.pid), 'keeper exit', 8).catch(() => Deno.kill(info.pid, 'SIGKILL'));
}

async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 25; i++) {
    try {
      Deno.removeSync(dir, { recursive: true });
      return;
    } catch {
      await pause(200);
    }
  }
}

/** The fake bridge: every spawn is one transport; `last` is the newest; kill() ends it the way a killed wsl.exe would. */
class FakeBridge {
  spawned: string[][] = [];
  last: TransportProcess | null = null;
  notice = 'wsl: Failed to translate the current folder\n';

  constructor(readonly keeperDir: string) {}

  readonly spawn: TransportSpawner = (_distro, argv) => {
    this.spawned.push(argv);
    const out = new TransformStream<Uint8Array, Uint8Array>();
    const input = new TransformStream<Uint8Array, Uint8Array>();
    let conn: Deno.TcpConn | null = null;
    let killed = false;
    let done: (s: { code: number }) => void = () => {};
    const status = new Promise<{ code: number }>((resolve) => (done = resolve));
    const dir = this.keeperDir;
    const notice = this.notice;
    (async () => {
      let info = readKeeperInfo(dir);
      if (!info || !pidAlive(info.pid)) { // like the real bridge: no keeper answers, so start one (detached) and use it
        (await ensureKeeper(dir, { extraArgs: FAST })).close();
        info = readKeeperInfo(dir)!;
      }
      const writer = out.writable.getWriter();
      const preamble = {
        ev: 'bridge',
        bridge: 1,
        keeper: '1.4.0',
        pid: info.pid,
        token: info.token,
        home: '/home/t',
        uid: 1000,
        arch: 'x86_64',
      };
      await writer.write(ENC.encode(`${notice}${BRIDGE_MAGIC}\n${JSON.stringify(preamble)}\n`));
      writer.releaseLock();
      const at = info.address.lastIndexOf(':');
      conn = await Deno.connect({
        hostname: info.address.slice(0, at),
        port: Number(info.address.slice(at + 1)),
      });
      if (killed) conn.close();
      await Promise.all([conn.readable.pipeTo(out.writable).catch(() => {}), input.readable.pipeTo(conn.writable).catch(() => {})]);
    })().catch(() => out.writable.abort().catch(() => {})).finally(() => done({ code: killed ? 1 : 0 }));
    const proc: TransportProcess = {
      pid: 0,
      stdin: input.writable,
      stdout: out.readable,
      stderr: null,
      status,
      kill() {
        if (killed) return;
        killed = true;
        try {
          conn?.close();
        } catch { /* closed */ }
      },
    };
    this.last = proc;
    return proc;
  };
}

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-hosts-' }));
  readonly linuxKeeper = `${this.dir}\\linux-keeper`;
  readonly windowsKeeper = `${this.dir}\\windows-keeper`;
  readonly home = `${this.dir}\\home`;
  readonly bridge = new FakeBridge(this.linuxKeeper);
  readonly hosts: WslHostImpl[] = [];
  readonly links: KeeperLink[] = [];

  constructor() {
    Deno.mkdirSync(this.home);
  }

  install(version = 't-1'): WslInstall {
    return {
      distro: 'Fake',
      version,
      home: this.home,
      uid: 1000,
      user: 't',
      shell: '/bin/bash',
      arch: 'x86_64',
      root: '/tmp/aib-wsl-test',
      keeper: `/tmp/aib-wsl-test/${version}/AIB-keeper`,
      helper: `/tmp/aib-wsl-test/${version}/AIB-wsl-helper`,
      data: '/tmp/aib-wsl-test/data-000000000000',
      copied: [],
      reused: [],
      removed: [],
    };
  }

  options(extra: Partial<WslHostOptions> = {}, version = 't-1'): WslHostOptions {
    return {
      distro: 'Fake',
      stateDir: this.dir,
      install: () => Promise.resolve(this.install(version)),
      spawnTransport: this.bridge.spawn,
      reconnect: { delaysMs: [100, 200, 400], totalMs: 8000 },
      connectTimeoutMs: 20_000,
      helperCommand: (install) => ({
        command: PYTHON,
        args: ['-u', HELPER, install.version],
      }),
      helperEnv: () => Deno.env.toObject(),
      wslExe: null,
      ...extra,
    };
  }

  host(extra: Partial<WslHostOptions> = {}, version = 't-1'): WslHostImpl {
    const host = new WslHostImpl(this.options(extra, version));
    this.hosts.push(host);
    return host;
  }

  windowsLink(): KeeperLink {
    const link = new KeeperLink({
      dataDir: this.windowsKeeper,
      extraArgs: FAST,
    });
    this.links.push(link);
    return link;
  }

  async linuxClient(): Promise<KeeperClient> {
    return await KeeperClient.connect(readKeeperInfo(this.linuxKeeper)!);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const host of this.hosts) host.stop();
    for (const link of this.links) link.disconnect();
    await stopKeeper(this.linuxKeeper);
    await stopKeeper(this.windowsKeeper);
    await removeDir(this.dir);
  }
}

function agent(host: WslHostImpl, id: string) {
  const records: KeeperRecord[] = [];
  const lost: (Error | null)[] = [];
  const channel = host.link.spawn(
    {
      channel: id,
      command: PYTHON,
      args: ['-u', '-c', ECHO],
      env: Deno.env.toObject(),
    },
    { record: (r) => records.push(r), lost: (e) => lost.push(e) },
  );
  const out = () => records.filter((r) => r.kind === 'out').map((r) => DEC.decode(r.body)).join('').replaceAll('\r', '');
  return { channel, records, lost, out };
}

Deno.test("internal labels: the WSL keep-alive and helper are AIB's own channels and never count as live work", () => {
  assert(isAibInternalLabel('{"aib":"wsl-hold","distro":"ubuntu"}'));
  assert(isAibInternalLabel('{"aib":"wsl-helper","v":"x"}'));
  assertEquals(aibInternalKind('{"aib":"wsl-helper"}'), 'wsl-helper');
  for (
    const no of ['', undefined, '{"aib":"terminal"}', '{"t":"chat"}', 'not json', '[1]', '{"aib":1}']
  ) assert(!isAibInternalLabel(no), String(no));
  const base = {
    kind: 'pipe',
    pid: 1,
    command: 'x',
    created: 0,
    exitCode: null,
    epoch: 1,
    first: 1,
    last: 1,
    owner: false,
  };
  const listed = [
    { ...base, channel: 'a', live: true },
    {
      ...base,
      channel: 'h',
      live: true,
      label: '{"aib":"wsl-hold","distro":"ubuntu"}',
    },
    {
      ...base,
      channel: 'w',
      live: true,
      label: '{"aib":"wsl-helper","v":"1"}',
    },
    { ...base, channel: 't', live: true, label: '{"aib":"terminal"}' },
    { ...base, channel: 'e', live: false },
  ];
  assertEquals(liveUserChannels(listed).map((c) => c.channel), ['a', 't']);
});

Deno.test('bridgeServeArgs: AIB_WSL_ORPHAN_GRACE (a plain Go duration) reaches the Linux keeper the bridge starts; nothing else does', () => {
  assertEquals(bridgeServeArgs(''), [], 'unset: the bridge gives its own 2 h');
  assertEquals(bridgeServeArgs('20s'), ['--', '--orphan-grace', '20s']);
  assertEquals(bridgeServeArgs('2h'), ['--', '--orphan-grace', '2h']);
  for (const no of ['0s', '-5s', '20', '1h30m', '20s --x', '', 's']) assertEquals(bridgeServeArgs(no), [], no);
});

Deno.test('acceptableUrl: http and https only, at most 2 KiB, no spaces or control characters', () => {
  assert(acceptableUrl('https://claude.ai/oauth?code=1') && acceptableUrl('http://localhost:5555/cb'));
  for (const no of ['file:///etc/passwd', 'javascript:alert(1)', 'https://a b', 'https://a\nb', 'https://' + 'a'.repeat(2100), '', 3]) {
    assert(!acceptableUrl(no), String(no).slice(0, 40));
  }
});

Deno.test({
  name: 'a host starts over the bridge: preamble, keeper link, the helper (label, ready, methods), calls, errors and env',
  ...T,
  async fn() {
    await using lab = new Lab();
    const host = lab.host();
    await host.start();
    assertEquals([host.state, host.note], ['ready', '']);
    assertEquals(lab.bridge.spawned[0], ['/tmp/aib-wsl-test/t-1/AIB-keeper', 'bridge', '--data', '/tmp/aib-wsl-test/data-000000000000']);
    assertEquals(host.preamble?.home, '/home/t');
    assertEquals(await host.call('which', { name: 'git' }), {
      path: '/usr/bin/git',
    });
    assertEquals(host.methods, ['env.get', 'which', 'fs.stat']);
    const failure = (work: Promise<unknown>) =>
      work.then(() => 'resolved', (e) => (e instanceof WslHelperError ? `${e.code}: ${e.message}` : `other: ${e}`));
    assert((await failure(host.call('agents.detect', {}))).startsWith('unknown_method:'));
    assertEquals(await failure(host.call('fs.stat', { path: '/nope' })), 'not_found: No such file');
    assert(
      (await failure(host.call('which', { name: 'slow' }, { timeoutMs: 300 })))
        .startsWith('timeout:'),
    );
    assertEquals((await host.env()).PATH, '/usr/bin:/bin');
    const client = await lab.linuxClient();
    try {
      const helpers = (await client.list()).filter((c) => c.live && isAibInternalLabel(c.label));
      assertEquals(helpers.map((c) => JSON.parse(c.label!)), [{
        aib: 'wsl-helper',
        v: 't-1',
      }]);
    } finally {
      client.close();
    }
  },
});

Deno.test({
  name: 'browser.open from the distro reaches onOpenUrl: http/https only, three a minute',
  ...T,
  async fn() {
    await using lab = new Lab();
    const host = lab.host();
    const opened: string[] = [];
    const off = host.onOpenUrl((url) => opened.push(url));
    await host.call('which', { name: 'open-url', url: 'https://example.com/a' } as never);
    await host.call('which', { name: 'open-url', url: 'file:///etc/passwd' } as never);
    for (const n of ['b', 'c', 'd']) await host.call('which', { name: 'open-url', url: `https://example.com/${n}` } as never);
    assertEquals(opened, ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    off();
  },
});

Deno.test({
  name: 'transport loss: the link suspends, reconnects and re-attaches from the last record; no agent is lost or started twice',
  ...T,
  async fn() {
    await using lab = new Lab();
    const host = lab.host();
    await host.start();
    let lostCalls = 0;
    host.link.onLost = () => lostCalls++;
    const a = agent(host, 'agent-1');
    await a.channel.write(ENC.encode('one\n'), 'w1');
    await until(() => a.out().includes('got:one'), 'first echo');
    const states: string[] = [];
    const before = host.link.onTransport!;
    host.link.onTransport = (state, error) => {
      states.push(state);
      before(state, error);
    };
    lab.bridge.last!.kill(); // the wsl.exe of the transport is killed
    await until(() => states.includes('lost'), 'transport lost');
    const during = a.channel.write(ENC.encode('two\n'), 'w2'); // written while the transport is down: waits, then goes out
    await until(() => states.includes('restored'), 'transport restored', 15);
    assert(await during, 'the write made during the outage went out');
    await until(() => a.out().includes('got:two'), 'echo after the reconnect');
    assertEquals(host.state, 'ready');
    assertEquals([lostCalls, a.lost.length, lab.bridge.spawned.length], [0, 0, 2]);
    const seqs = a.records.map((r) => r.seq);
    assertEquals(seqs, [...seqs].sort((x, y) => x - y).filter((s, i, all) => all.indexOf(s) === i), 'each record once, in order');
    assertEquals(a.out(), 'got:one\ngot:two\n');
    assertEquals(await host.call('which', { name: 'ls' }), {
      path: '/usr/bin/ls',
    }, 'the helper channel came back too');
    const client = await lab.linuxClient();
    try {
      assertEquals(liveUserChannels(await client.list()).map((c) => c.channel), ['agent-1'], 'still one agent');
    } finally {
      client.close();
    }
  },
});

Deno.test({
  name: 'the keeper itself gone: channels it no longer runs are lost (keeper_lost, the distro message) and the host recovers',
  ...T,
  async fn() {
    await using lab = new Lab();
    const host = lab.host();
    await host.start();
    const lost: string[] = [];
    host.link.onLost = (channels) => lost.push(...channels.map((c) => c.id));
    const a = agent(host, 'agent-2');
    await a.channel.write(ENC.encode('x\n'));
    await until(() => a.out().includes('got:x'), 'echo');
    await stopKeeper(lab.linuxKeeper); // `wsl --shutdown` as AIB sees it: the keeper and its agents are gone
    await until(() => lost.includes('agent-2'), 'onLost for the agent', 15);
    const error = a.lost[0];
    assert(error instanceof KeeperError && error.code === 'keeper_lost', String(error));
    assert(error.message.includes('Fake stopped'), error.message);
    await until(() => host.state === 'ready', 'host ready on the new keeper', 15);
    assertEquals(await host.call('which', { name: 'sh' }), {
      path: '/usr/bin/sh',
    }, 'a new helper in the new keeper');
  },
});

Deno.test({
  name: "MCP tunnel: the ready line names the socket; tool calls reach onMcpRequest once, never again from an adopted helper's replay",
  ...T,
  async fn() {
    await using lab = new Lab();
    const withMcp = { helperCommand: (install: { version: string }) => ({ command: PYTHON, args: ['-u', HELPER, install.version, 'mcp'] }) };
    const first = lab.host(withMcp);
    await first.start();
    assertEquals(first.mcpTunnel, {
      forwarder: '/tmp/aib-wsl-test/t-1/AIB-keeper',
      socket: '/tmp/aib-wsl-test/data-000000000000/helper/mcp.sock',
    });
    const seen: string[] = [];
    first.onMcpRequest((r) => seen.push(r.rid));
    await first.call('which', { name: 'mcp-request', rid: 'r1' } as never);
    await until(() => seen.length === 1, 'the first tool call');
    await first.mcpClosed(); // quit: the helper is told (and it does not throw)
    first.stop(); // AIB quits; the helper keeps running in the keeper, with r1 in its record
    const second = lab.host(withMcp);
    const seen2: string[] = [];
    second.onMcpRequest((r) => seen2.push(r.rid));
    await second.start();
    await second.call('which', { name: 'mcp-request', rid: 'r2' } as never);
    await until(() => seen2.length >= 1, 'the second tool call');
    await pause(200);
    assertEquals(seen2, ['r2'], 'the replayed r1 is not run again');
    assertEquals(seen, ['r1']);
    // a helper without the tunnel: no entry for it (Studio falls back to the interop entry)
    second.stop();
    const plain = lab.host({}, 't-3');
    await plain.start();
    assertEquals(plain.mcpTunnel, null);
  },
});

Deno.test({
  name: "a second AIB adopts the running helper of its version; another version's helper is replaced",
  ...T,
  async fn() {
    await using lab = new Lab();
    const first = lab.host();
    await first.call('which', { name: 'a' });
    first.stop(); // AIB quits (the helper keeps running in the keeper)
    const second = lab.host();
    assertEquals(await second.call('which', { name: 'b' }), {
      path: '/usr/bin/b',
    });
    let client = await lab.linuxClient();
    const helpers = async () => (await client.list()).filter((c) => c.live && isAibInternalLabel(c.label));
    try {
      assertEquals((await helpers()).length, 1, 'adopted, not started again');
      second.stop();
      const newer = lab.host({}, 't-2');
      await newer.call('which', { name: 'c' });
      await until(async () => (await helpers()).length === 1, 'the old helper stopped');
      assertEquals(JSON.parse((await helpers())[0].label!).v, 't-2');
    } finally {
      client.close();
    }
    client = await lab.linuxClient();
    client.close();
  },
});

Deno.test({
  name: "a second AIB whose running helper's ready line left its record (much traffic since) starts a new helper and works",
  ...T,
  async fn() {
    await using lab = new Lab();
    const first = lab.host();
    await first.call('which', { name: 'flood' }); // over 1 MiB of output after the ready line (docs' file reads do this)
    first.stop();
    const second = lab.host();
    await second.start();
    assertEquals(second.state, 'ready', second.note);
    assertEquals(await second.call('which', { name: 'b' }), { path: '/usr/bin/b' }, 'a new helper answers');
    const client = await lab.linuxClient();
    try {
      const helpers = async () => (await client.list()).filter((c) => c.live && isAibInternalLabel(c.label));
      await until(async () => (await helpers()).length === 1, 'the old helper stopped, one left');
    } finally {
      client.close();
    }
  },
});

Deno.test({
  name: 'the keep-alive: one wsl-hold channel in the Windows keeper (adopted, never doubled); quit keeps it only for live agents',
  ...T,
  async fn() {
    await using lab = new Lab();
    const windows = lab.windowsLink();
    const holdArgs: string[][] = [];
    const hosts = new WslHosts({
      ...lab.options({
        windowsLink: () => windows,
        wslExe: 'C:\\Windows\\System32\\wsl.exe',
        holdCommand: (wslExe, distro, install) => {
          holdArgs.push([wslExe, distro, install.keeper]);
          return {
            command: PYTHON,
            args: ['-c', 'import time; time.sleep(600)'],
          };
        },
      }),
      lookup: (name) => (name.toLowerCase() === 'fake' ? 'Fake' : null),
    });
    const host = hosts.get('FAKE');
    assert(hosts.get('fake') === host, 'one host per distro, case-insensitive');
    let unknown = '';
    try {
      hosts.get('Other');
    } catch (error) {
      unknown = (error as WslHelperError).code;
    }
    assertEquals(unknown, 'unknown_distro');
    await host.start();
    await until(() => host.holding, 'keep-alive running');
    const winClient = (await windows.client(false))!;
    const holds = async () => (await winClient.list()).filter((c) => c.live && c.label === '{"aib":"wsl-hold","distro":"fake"}');
    await until(async () => (await holds()).length === 1, 'the keeper lists the keep-alive');
    assertEquals(holdArgs, [['C:\\Windows\\System32\\wsl.exe', 'Fake', '/tmp/aib-wsl-test/t-1/AIB-keeper']]);
    // A second AIB process (a new WslHosts) finds the running keep-alive instead of starting another
    const again = new WslHosts({ ...hosts.options });
    const host2 = again.get('fake');
    lab.hosts.push(host2);
    await host2.start();
    await until(() => host2.holding, 'keep-alive adopted');
    assertEquals((await holds()).length, 1, 'never two keep-alives');
    host2.stop();
    // quit with a WSL agent running: the keep-alive stays
    const a = agent(host, 'agent-3');
    await a.channel.ready;
    assertEquals(await hosts.liveCount(), 1);
    const kept = await hosts.quit();
    assertEquals(kept, { live: 1, held: ['Fake'] });
    assertEquals((await holds()).length, 1);
    // the next AIB quits with nothing running: the keep-alive goes
    const later = new WslHosts({ ...hosts.options });
    const host3 = later.get('fake');
    lab.hosts.push(host3);
    await host3.start();
    await until(() => host3.holding, 'keep-alive adopted again');
    const client = await lab.linuxClient();
    try {
      await host3.link.stopUnknown(client, 'agent-3');
    } finally {
      client.close();
    }
    await until(async () => (await host3.liveCount()) === 0, 'agent stopped');
    assertEquals(await later.quit(), { live: 0, held: [] });
    await until(async () => (await holds()).length === 0, 'keep-alive stopped');
  },
});
