/**
 * `aib deploy` (test_deploy.py): idle detection, the restart plan and the worktree guard, compared with deploy.py where it is a pure
 * function; and real restarts of a Deno server on a random port with a temp state folder (web-only, then --host), with the
 * deploy logs in work/deploy-fixture (gitignored). Never port 8767/8768 and never the real data folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { DENO, Fixture, freePort, MAIN, SEP, until } from './_host_fixture.ts';
import { pidAlive, readInfo } from '../../outputs/agent-studio/server/host/host_client.ts';
import { TESTS_DIR } from '../../outputs/agent-studio/server/core/app.ts';
import * as deploy from '../../outputs/agent-studio/server/host/deploy.ts';
import { packageContext } from '../../outputs/agent-studio/server/state/paths.ts';

const WIN = Deno.build.os === 'windows';
const LOGS = `${TESTS_DIR}${SEP}deploy-fixture`;

function conn(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: 'claude', cwd: 'C:\\p', closed: false, busy: false, ready: true, ...extra };
}

// ---- BusyReasonsTests -------------------------------------------------------------------------------------------------------

Deno.test('busy reasons: idle and closed are safe', () => {
  const listing = { connections: [conn({ attention: { state: 'idle' } }), conn({ closed: true, attention: { state: 'working' } })] };
  assertEquals(deploy.busyReasons(listing), []);
});

Deno.test('busy reasons: working, opening and waiting block', () => {
  for (const [state, word] of [['working', 'is working'], ['opening', 'is still opening'], ['needs_you', 'waiting for your answer']]) {
    const reasons = deploy.busyReasons({ connections: [conn({ attention: { state } })] });
    assertEquals(reasons.length, 1);
    assert(reasons[0].includes(word), state);
  }
});

Deno.test('busy reasons: older servers without attention', () => {
  assertEquals(deploy.busyReasons({ connections: [conn({ busy: true })] }).length, 1);
  assertEquals(deploy.busyReasons({ connections: [conn({ ready: false })] }).length, 1);
  assertEquals(deploy.busyReasons({ connections: [conn()] }), []);
  assertEquals(deploy.busyReasons({}), []);
});

Deno.test('busy reasons and the restart plan match deploy.py', async () => {
  await using py = new PyParity();
  const listings = [
    {},
    { connections: [] },
    {
      connections: [conn({ attention: { state: 'working' } }), conn({ attention: { state: 'needs_you' }, provider: 'omp', cwd: 'D:\\x' })],
    },
    { connections: [conn({ provider: null, cwd: 5, attention: { state: 'opening' } })] },
    { connections: [{ attention: { state: 'working' } }, { busy: 1 }, { ready: 0 }, { ready: [] }, { attention: {}, busy: '' }] },
    { connections: [conn({ attention: { state: 'idle' }, busy: true }), conn({ attention: null, busy: true }), conn({ closed: 1 })] },
    { connections: [conn({ attention: { state: 'other' } }), conn({ attention: { state: null }, ready: false })] },
  ];
  for (const listing of listings) assertEquals(deploy.busyReasons(listing), await py.call('deploy', 'busy_reasons', [listing]));
  for (const mode of ['split', 'in-process', null, '']) {
    for (const host of [false, true]) {
      for (const wait of [false, true]) {
        assertEquals(
          deploy.restartPlan(mode, host, wait),
          await py.call('deploy', 'restart_plan', [mode, host, wait]),
          `${mode} ${host} ${wait}`,
        );
      }
    }
  }
  const args = ['deno run -A main.ts serve --port 8790', 'C:\\w\\out.log', 'C:\\w\\err.log', "C:\\it's\\run.cmd", 'C:\\app'];
  assertEquals(
    deploy.launcherTexts(...(args as [string, string, string, string, string])),
    await py.call('deploy', 'launcher_texts', args),
  );
});

// ---- RestartPlanTests -------------------------------------------------------------------------------------------------------

Deno.test('restart plan: a web-only restart with a host needs no waiting and keeps the host', () => {
  assertEquals(deploy.restartPlan('split'), { wait: false, stop_host: false, kill_tree: false });
  assertEquals(deploy.restartPlan('split', false, true), { wait: true, stop_host: false, kill_tree: false });
  assertEquals(deploy.restartPlan('split', true), { wait: true, stop_host: true, kill_tree: false });
  for (const mode of ['in-process', null]) {
    assertEquals(deploy.restartPlan(mode), { wait: true, stop_host: false, kill_tree: true });
    assertEquals(deploy.restartPlan(mode, true), { wait: true, stop_host: false, kill_tree: true });
  }
  // One process with the keeper: restarting never touches a chat (they are rebuilt from the keeper), and the keeper is never killed.
  assertEquals(deploy.restartPlan('keeper'), { wait: false, stop_host: false, kill_tree: false });
  assertEquals(deploy.restartPlan('keeper', true), { wait: false, stop_host: false, kill_tree: false });
  assertEquals(deploy.restartPlan('keeper', false, true), { wait: true, stop_host: false, kill_tree: false });
});

// ---- DeployGuardTests and the command line ------------------------------------------------------------------------------------

function fakeCheckouts(): { tmp: string; main: string; wt: string } {
  const tmp = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-deploy-guard-' }));
  const repo = `${tmp}${SEP}repo`;
  const main = `${repo}${SEP}outputs${SEP}agent-studio`;
  Deno.mkdirSync(main, { recursive: true });
  Deno.mkdirSync(`${repo}${SEP}.git`);
  const a1 = `${repo}${SEP}.claude${SEP}worktrees${SEP}a1`;
  const wt = `${a1}${SEP}outputs${SEP}agent-studio`;
  Deno.mkdirSync(wt, { recursive: true });
  Deno.writeTextFileSync(`${a1}${SEP}.git`, 'gitdir: x');
  return { tmp, main, wt };
}

function capture() {
  const out: string[] = [], err: string[] = [];
  return { out, err, hooks: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

Deno.test('deploy refuses in a worktree but not in the main checkout', async () => {
  const { tmp, main, wt } = fakeCheckouts();
  try {
    assertEquals(deploy.worktreeRefusal(main), null);
    assertEquals(deploy.worktreeRefusal(wt), 'aib deploy must run from the main checkout, not a worktree');
    const c = capture();
    assertEquals(await deploy.main(['--port', '1'], { ...c.hooks, root: wt }), 1);
    assert(c.err.join('\n').includes('not a worktree'));
    assertEquals(c.out, []);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test('deploy flags: argparse errors, help, prefixes', async () => {
  assertEquals(deploy.parseArgs([]), { port: 8767, settle: 15, timeout: 0, host: false, wait: false, dry_run: false });
  assertEquals(deploy.parseArgs(['--port=8790', '--settle', '3', '--dry', '--host', '--wa', '--timeout', '60']), {
    port: 8790,
    settle: 3,
    timeout: 60,
    host: true,
    wait: true,
    dry_run: true,
  });
  const { tmp, main } = fakeCheckouts();
  try {
    for (
      const [argv, text] of [
        [['--port', 'x'], "argument --port: invalid int value: 'x'"],
        [['--port'], 'argument --port: expected one argument'],
        [['--bogus'], 'unrecognized arguments: --bogus'],
        [['--h'], 'ambiguous option: --h could match --help, --host'],
        [['extra'], 'unrecognized arguments: extra'],
      ] as [string[], string][]
    ) {
      const c = capture();
      assertEquals(await deploy.main(argv, { ...c.hooks, root: main }), 2, argv.join(' '));
      assertEquals(c.err, [
        `usage: aib deploy [-h] [--port PORT] [--settle SETTLE] [--timeout TIMEOUT] [--host] [--wait] [--dry-run]\naib deploy: error: ${text}`,
      ]);
    }
    const c = capture();
    assertEquals(await deploy.main(['--help'], { ...c.hooks, root: main }), 0);
    assert(c.out[0].includes('--dry-run') && c.out[0].includes('Restart a running Agent Studio server'));
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test({
  name: 'deploy: nothing on the port, and a server without a pid in bootstrap that no process matches',
  ignore: !WIN,
  fn: async () => {
    const { tmp, main } = fakeCheckouts();
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => Response.json({ token: 't' }));
    try {
      let c = capture();
      assertEquals(await deploy.main(['--port', String(freePort()), '--dry-run'], { ...c.hooks, root: main }), 1);
      assert(/^Not restarted: <urlopen error \[WinError 10061\] /.test(c.err[0]), c.err[0]);
      c = capture();
      assertEquals(await deploy.main(['--port', String(server.addr.port), '--dry-run'], { ...c.hooks, root: main }), 1);
      assertEquals(c.err, [`Not restarted: Found 0 Studio processes that could be port ${server.addr.port}; refusing to guess`]);
    } finally {
      await server.shutdown();
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});

// ---- real restarts ----------------------------------------------------------------------------------------------------------

function taskkill(pid: number): void {
  new Deno.Command('taskkill', { args: ['/PID', String(pid), '/F'], stdout: 'null', stderr: 'null' }).outputSync();
}

Deno.test({
  name: 'deploy restarts a Deno server on a random port: web only (the host survives), then --host (a new host)',
  ignore: !WIN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { tmp, main } = fakeCheckouts();
    await using fixture = new Fixture();
    const started: number[] = []; // servers deploy started: stopped at the end by their exact PID
    try {
      const web = await fixture.startWeb();
      const port = web.port;
      assert(port !== 8767 && port !== 8768);
      const host = (await readInfo(fixture.state))!;
      assert(host && pidAlive(host.pid as number), 'the web server started an agent host');
      const hooks = { root: main, logs: LOGS, packageContext: () => null };

      // the command line deploy reads is the one the fixture started
      const line = deploy.commandLineOf(web.process.pid);
      assert(line.includes(MAIN) && line.includes(`--port ${port}`) && line.includes(fixture.state), line);
      assert(line.toLowerCase().includes(DENO.split(SEP).pop()!.toLowerCase()));

      // --dry-run changes nothing
      let c = capture();
      assertEquals(await deploy.main(['--port', String(port), '--dry-run'], { ...c.hooks, ...hooks }), 0, c.err.join('\n'));
      assertEquals(c.out, [`Studio on port ${port}: process ${web.process.pid} (split)\n  ${line}`, 'Would: restart the web server.']);
      c = capture();
      assertEquals(await deploy.main(['--port', String(port), '--dry-run', '--host'], { ...c.hooks, ...hooks }), 0);
      assertEquals(c.out.slice(1), ['Would: wait until idle, then stop the agent host, then restart the web server.', 'Idle now.']);

      // web-only restart: a new web server with the same command line, attached to the same host
      c = capture();
      assertEquals(await deploy.main(['--port', String(port)], { ...c.hooks, ...hooks }), 0, c.err.join('\n'));
      const boot = await (await fetch(`http://127.0.0.1:${port}/api/live/bootstrap`)).json();
      started.push(boot.pid);
      assert(boot.pid !== web.process.pid);
      const pkg = packageContext(); // this test starts the server directly, so inside a packaged app the new one is in its sandbox
      const warning = pkg
        ? [`WARNING: the new Studio still runs inside ${pkg}'s sandbox, so its data is in that app's private folder.`]
        : [];
      assertEquals(c.out.slice(1), [
        `Restarted: process ${boot.pid}, instance ${boot.instanceId}`,
        ...warning,
        'Still running: none',
        'Reconnecting automatically: none',
      ]);
      assertEquals(await web.process.status.then((s) => s.success), false); // the old server was killed
      assertEquals(deploy.commandLineOf(boot.pid), line);
      assertEquals(boot.hostMode, 'split');
      assertEquals((await readInfo(fixture.state))!.pid, host.pid); // the agent host was not touched
      assert(pidAlive(host.pid as number));

      // --host: waits for idle, stops the host, restarts the web server, which starts a new host
      c = capture();
      assertEquals(await deploy.main(['--port', String(port), '--host', '--settle', '0'], { ...c.hooks, ...hooks }), 0, c.err.join('\n'));
      const boot2 = await (await fetch(`http://127.0.0.1:${port}/api/live/bootstrap`)).json();
      started.push(boot2.pid);
      assert(boot2.pid !== boot.pid);
      assertEquals(c.out[1], 'Idle; restarting if it stays idle for 0s...');
      assert(/stop/i.test(c.out[2]), c.out[2]);
      assertEquals(c.out[3], `Restarted: process ${boot2.pid}, instance ${boot2.instanceId}`);
      await until(() => !pidAlive(host.pid as number), 'the old host to exit', 30);
      const newHost = await until(
        async () => {
          const info = await readInfo(fixture.state);
          return info && info.pid !== host.pid && pidAlive(info.pid as number) ? info : null;
        },
        'a new agent host',
        60,
      );
      fixture.hostPids.add(newHost.pid as number);
      assert(Deno.readTextFileSync(`${LOGS}${SEP}agent-studio.stdout.log`).includes(`Agent Studio: http://127.0.0.1:${port}`));
    } finally {
      for (const pid of started) if (pid && pidAlive(pid)) taskkill(pid);
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});
