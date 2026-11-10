/**
 * Host takeover (test_host_takeover.py) and the cross-language rule: a web server that finds a live agent host from another code
 * folder, or a host of the other language (a Python host met by a Deno web server), takes it over when no chat is working there,
 * waits (banner) while one is, and never stops a busy host. Fake hosts in temp folders (_fake_host.ts), plus one real Python host.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { DENO, FAKE_HOST, Fixture, PY, TEST_OPTIONS, until } from './_host_fixture.ts';
import {
  APP_ID,
  APP_VERSION,
  CODE_ROOT,
  findOrStart,
  HostBusy,
  HostForeignRoot,
  pidAlive,
  PROTOCOL_VERSION,
  readInfo,
} from '../../outputs/agent-studio/server/host/host_client.ts';
import { attachHost } from '../../outputs/agent-studio/server/host/host_proxy.ts';
import { DENO_SOURCE_HASH } from '../../outputs/agent-studio/server/host/host_client.ts';
import { PY_REF_DIR } from './_parity.ts';

const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ...TEST_OPTIONS, fn });

function setActive(fx: Fixture, n: number) {
  Deno.writeTextFileSync(`${fx.state}/fake-active`, String(n));
}

function calls(fx: Fixture): string[] {
  try {
    return Deno.readTextFileSync(`${fx.state}/fake-calls.log`).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The command that starts "our own" new host: a fake with this code root, app, version and the Deno runtime. */
function ownHost(fx: Fixture): string[] {
  return [DENO, 'run', '-A', '--quiet', FAKE_HOST, fx.state, CODE_ROOT, APP_ID, APP_VERSION, 'deno', String(PROTOCOL_VERSION)];
}

/** Start an "old" fake host and wait for its file. */
async function oldHost(fx: Fixture, active: number, codeRoot = 'C:/other/checkout', appId = 'studio-dev', runtime = 'deno') {
  setActive(fx, active);
  const [child] = fx.spawn(
    [DENO, 'run', '-A', '--quiet', FAKE_HOST, fx.state, codeRoot, appId, '0.0.9', runtime, String(PROTOCOL_VERSION)],
    'old-host',
  );
  await until(async () => (await readInfo(fx.state))?.pid === child.pid, 'old host file', 30);
  return child;
}

async function track(fx: Fixture) {
  await fx.hostInfo(); // the new fake host's pid, so cleanup stops it
}

t('takes over an idle host from another code folder', async () => {
  await using fx = new Fixture();
  const old = await oldHost(fx, 0, 'C:/other/checkout', 'dev.aib.app');
  const said: string[] = [];
  const [client] = await findOrStart(fx.state, ownHost(fx), { waitSeconds: 20, say: (m) => said.push(m), runtime: 'deno' });
  await track(fx);
  assert(calls(fx).includes('stop'));
  assert(client.pid !== old.pid);
  assert(said.some((m) => m.includes('Took over') && m.includes('dev.aib.app')), said.join('\n'));
  assert(said.some((m) => m.startsWith('Started agent host process')), 'its own host was started');
});

t('a busy host is waited for and never stopped; the takeover happens once its chats finish', async () => {
  await using fx = new Fixture();
  const old = await oldHost(fx, 2);
  const error = await assertRejects(() => findOrStart(fx.state, ownHost(fx), { waitSeconds: 3, runtime: 'deno' }), HostBusy) as HostBusy;
  assertEquals([error.chats, error.code], [2, 'host_waiting']);
  assert(error.message.includes('Another AIB version') && error.message.includes('2 chat(s)'), error.message);
  assert(pidAlive(old.pid));
  assertEquals((await readInfo(fx.state))!.pid, old.pid, 'no second host while the old one works');
  setActive(fx, 0);
  const [client] = await findOrStart(fx.state, ownHost(fx), { waitSeconds: 20, runtime: 'deno' });
  await track(fx);
  assert(client.pid !== old.pid);
  await until(() => !pidAlive(old.pid), 'old host exit');
});

t('a web server that lost its host does not take it back', async () => {
  await using fx = new Fixture();
  await oldHost(fx, 0);
  await assertRejects(() => findOrStart(fx.state, ownHost(fx), { takeover: false }), HostForeignRoot);
  assert(!calls(fx).includes('stop'));
});

t('cross-language: a Python host from this same folder is foreign to a Deno web server, never to a client without a runtime', async () => {
  await using fx = new Fixture();
  const old = await oldHost(fx, 1, CODE_ROOT, APP_ID, 'none'); // no runtime field: a Python host (agent_host.py)
  // Without a runtime (the stage-B behaviour, and what the Python web server does) it is simply attached to.
  const [client, live] = await findOrStart(fx.state, ownHost(fx), { waitSeconds: 3 });
  assertEquals([client.pid, live.protocol], [old.pid, PROTOCOL_VERSION]);
  // A Deno web server waits while it works, then takes it over.
  const error = await assertRejects(() => findOrStart(fx.state, ownHost(fx), { waitSeconds: 3, runtime: 'deno' }), HostBusy) as HostBusy;
  assertEquals(error.chats, 1);
  assertEquals(calls(fx).filter((c) => c === 'stop').length, 1, 'asked once, refused');
  assert(pidAlive(old.pid));
  setActive(fx, 0);
  const said: string[] = [];
  const [mine] = await findOrStart(fx.state, ownHost(fx), { waitSeconds: 20, runtime: 'deno', say: (m) => said.push(m) });
  await track(fx);
  assert(mine.pid !== old.pid);
  assertEquals((await readInfo(fx.state))!.runtime, 'deno');
  assert(said.some((m) => m.includes('Took over')), said.join('\n'));
});

t('the web server waits with a banner, then switches over', async () => {
  await using fx = new Fixture();
  await oldHost(fx, 3);
  const proxy = await attachHost({
    stateDir: fx.state,
    command: ownHost(fx),
    port: 0,
    webInstanceId: 'w',
    heartbeatSeconds: 3600,
    runtime: 'deno',
    say: () => {},
  });
  try {
    assertEquals(proxy.waitingChats, 3);
    setActive(fx, 0);
    proxy.lastAttempt = 0;
    await proxy.liveInfo();
    await track(fx);
    assertEquals(proxy.waitingChats, 0);
    assertEquals((await readInfo(fx.state))!.codeRoot, CODE_ROOT);
  } finally {
    await proxy.close();
  }
});

t('cross-language for real: a Deno web server takes over an idle Python agent host, and a Python client drives the Deno host', async () => {
  await using fx = new Fixture();
  const [py] = fx.spawn([PY, `${PY_REF_DIR}/agent_host.py`, ...fx.agentFlags(), '--idle-exit-minutes', '2'], 'python-host');
  fx.hostPids.add(py.pid);
  const pyInfo = await until(async () => await readInfo(fx.state), 'python host file', 30);
  assertEquals(pyInfo.runtime, undefined);
  const web = await fx.startWeb();
  await until(() => !pidAlive(pyInfo.pid), 'python host stopped');
  const info = (await readInfo(fx.state))!;
  assertEquals(info.runtime, 'deno');
  assertEquals(web.boot.hostPid, info.pid);
  assertEquals(web.boot.hostCodeWarning, '', 'a Deno web server and a Deno host agree about the code hash');
  // The Python client (host_client.py) attaches to the Deno host: same protocol, same file.
  const out = await new Deno.Command(PY, {
    args: [
      '-c',
      [
        'import sys, json; sys.path.insert(0, sys.argv[1]); import host_client',
        'c = host_client.HostClient(host_client.read_info(sys.argv[2]))',
        "i = c.call('info'); print(json.dumps([i['protocol'], i['runtime'], c.call('list')['connections']]))",
      ].join('\n'),
      PY_REF_DIR,
      fx.state,
    ],
    env: fx.env,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), [PROTOCOL_VERSION, 'deno', []], new TextDecoder().decode(out.stderr));
});

t('a server whose host was taken over yields and never takes it back', async () => {
  // test_a_server_whose_host_was_taken_over_yields_and_never_takes_it_back: two versions sharing one folder must not fight.
  await using fx = new Fixture();
  setActive(fx, 0);
  const proxy = await attachHost({
    stateDir: fx.state,
    command: ownHost(fx),
    port: 0,
    webInstanceId: 'w',
    heartbeatSeconds: 3600,
    runtime: 'deno',
    say: () => {},
  });
  try {
    const mine = (await fx.hostInfo())!;
    assert(proxy.client !== null, 'started its own (fake) host');
    await proxy.client!.call('stop', null, 5); // the other version took it over: our host stopped ...
    await until(() => !pidAlive(mine.pid), 'our host exit');
    const theirs = await oldHost(fx, 0, 'C:/other/checkout', 'dev.aib.app'); // ... and theirs now owns the folder, idle
    const before = calls(fx).filter((c) => c === 'stop').length;
    proxy.lastAttempt = 0;
    const error = await assertRejects(() => proxy.call('info', null, 5), HostForeignRoot);
    assert(error.message.includes('took over the agent host'), error.message);
    assertEquals(calls(fx).filter((c) => c === 'stop').length, before, 'never stops the other host');
    assert(proxy.yielded);
    assert(pidAlive(theirs.pid));
    proxy.lastAttempt = 0;
    await assertRejects(() => proxy.call('info', null, 5), HostForeignRoot);
    assertEquals(calls(fx).filter((c) => c === 'stop').length, before);
    assertEquals((await readInfo(fx.state))!.pid, theirs.pid, 'no second host of ours');
  } finally {
    await proxy.close();
  }
});

t('after an update: the new app attaches to the old version host (same path) and retires it once no chat works there', async () => {
  await using fx = new Fixture();
  const old = await oldHost(fx, 1, CODE_ROOT, APP_ID); // same file path, older code (sourceHash "x"), a chat working
  const own = [...ownHost(fx), await DENO_SOURCE_HASH()];
  let retired = 0;
  const said: string[] = [];
  const proxy = await attachHost({
    stateDir: fx.state,
    command: own,
    port: null,
    webInstanceId: 'web-new',
    runtime: 'deno',
    retireOlderHost: true,
    heartbeatSeconds: 0.3,
    onRetired: () => void retired++,
    say: (m) => said.push(m),
    launch: ['AIB.exe', 'serve'],
  });
  try {
    assertEquals(proxy.client?.pid, old.pid, 'attached to the running host: its chat keeps streaming');
    await new Promise((r) => setTimeout(r, 1500));
    assert(pidAlive(old.pid), 'never stopped while its chat works');
    assert(!calls(fx).includes('stop'), 'not even asked');
    assert(calls(fx).includes('attach'));
    setActive(fx, 0);
    await until(() => retired === 1, 'retired', 30);
    await until(() => !pidAlive(old.pid), 'old host gone', 30);
    const info = await readInfo(fx.state);
    assert(info && info.pid !== old.pid && info.sourceHash === await DENO_SOURCE_HASH(), 'a host of this version runs now');
    assertEquals(proxy.client?.pid, info!.pid);
    assert(said.some((m) => m.startsWith('Replacing the agent host of AIB 0.0.9')), said.join(' | '));
    await new Promise((r) => setTimeout(r, 1000));
    assertEquals(retired, 1, 'a host of this version is never retired');
    await track(fx);
  } finally {
    await proxy.close();
  }
});
