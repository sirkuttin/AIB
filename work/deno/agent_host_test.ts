/**
 * The Deno agent host and web server split (test_agent_host.py, test_host_migration.py, the host half of test_auto_reconnect.py):
 * restarting the web server must not touch running turns; stop, crash, idle exit, the one-host lock, the RPC guards, a protocol
 * mismatch, the recovery carry-over. Real processes in temp folders, the fake ACP agent only.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, httpJson, MAIN, openConversation, sleep, TEST_OPTIONS, until } from './_host_fixture.ts';
import {
  findOrStart,
  HOST_FORMAT,
  HostClient,
  HostIncompatible,
  HostUnavailable,
  pidAlive,
  PROTOCOL_VERSION,
  readInfo,
  removeInfo,
  TOKEN_HEADER,
  writeInfo,
} from '../../outputs/agent-studio/server/host/host_client.ts';
import { migrateInProcessRecovery } from '../../outputs/agent-studio/server/host/agent_host.ts';
import { StateStore } from '../../outputs/agent-studio/server/state/recovery.ts';

type Json = Record<string, unknown>;
const t = (name: string, fn: () => Promise<void> | void) => Deno.test({ name, ...TEST_OPTIONS, fn });

t('split: a web restart mid-turn keeps the turn, its history and its receipts', async () => {
  await using fx = new Fixture();
  const web1 = await fx.startWeb();
  const hostPid = (await readInfo(fx.state))!.pid!;
  assertEquals(web1.boot.hostMode, 'split');
  assertEquals(web1.boot.hostPid, hostPid);
  assert(hostPid !== web1.process.pid);
  assertEquals((await readInfo(fx.state))!.runtime, 'deno', 'the web server started the Deno host');
  const cid = await openConversation(web1, fx);
  const [status, sent] = await web1.post('prompt', { id: cid, text: 'wait', clientMessageId: 'turn-1' });
  assertEquals([status, sent.duplicate], [200, false]);
  await until(async () => (await web1.state(cid)).busy, 'busy turn');
  const before = await web1.state(cid);
  const cursor = before.cursor as number;
  assert((before.events as Json[]).some((e) => e.kind === 'user'));

  await web1.kill(); // the web server dies mid-turn
  assert(pidAlive(hostPid), 'the agent host must survive the web server');

  const web2 = await fx.startWeb();
  assertEquals(web2.instance, web1.instance, "connection IDs stay valid, so the browser-visible instance is the host's");
  assert(web2.webInstance !== web1.webInstance);
  assert(web2.token !== web1.token);
  assertEquals(web2.boot.hostPid, hostPid);
  assertEquals(web2.boot.connections, [cid]);
  const listed = await web2.listing();
  const entry = (listed.connections as Json[]).find((c) => c.id === cid)!;
  assert(entry.busy);
  assertEquals((entry.attention as Json).state, 'working');
  assertEquals(listed.instanceId, web1.instance);
  const state = await web2.state(cid, cursor);
  assert(state.busy);
  assertEquals(state.cursor, cursor);
  assertEquals(state.reset, false);
  const [, again] = await web2.post('prompt', { id: cid, text: 'wait', clientMessageId: 'turn-1' });
  assertEquals(again.duplicate, true, 'a retried send with the same message ID is recognised by the host');
  assertEquals((await web2.post('cancel', { id: cid }))[0], 200);
  const done = await until(async () => {
    const s = await web2.state(cid, cursor);
    return s.busy ? null : s;
  }, 'cancelled turn');
  assert((done.events as Json[]).every((e) => (e.seq as number) > cursor));
  assert((done.events as Json[]).some((e) => e.kind === 'turn_end' && (e.data as Json).stopReason === 'cancelled'));
  assertEquals((((await web2.listing()).connections as Json[])[0].attention as Json).state, 'idle');
  assertEquals((await web2.post('prompt', { id: cid, text: 'approve', clientMessageId: 'turn-2' }))[0], 200);
  const asked = await until(async () => {
    const p = (await web2.state(cid)).permissions as Json[];
    return p.length ? p : null;
  }, 'approval request');
  assertEquals((await web2.post('permission', { id: cid, key: asked[0].key, option: 'yes' }))[0], 200);
  await until(async () => !(await web2.state(cid)).busy, 'finished turn');
});

t('split: two web servers share one host and its guards', async () => {
  await using fx = new Fixture();
  const first = await fx.startWeb();
  const second = await fx.startWeb();
  assertEquals(first.boot.hostPid, second.boot.hostPid);
  assertEquals(first.instance, second.instance);
  const cid = await openConversation(first, fx);
  await until(async () => ((await second.listing()).connections as Json[]).some((c) => c.id === cid), 'visible through the second');
  await until(async () => ((await (await fx.host())!.call('info')) as Json).webAttached === 2, 'both web servers attached');
  assertEquals((await first.post('prompt', { id: cid, text: 'wait', clientMessageId: 'a' }))[0], 200);
  const [status, payload] = await second.post('prompt', { id: cid, text: 'wait', clientMessageId: 'b' });
  assertEquals(status, 400);
  assert(String(payload.error).includes('Wait for the current turn'), String(payload.error));
  await second.post('cancel', { id: cid });
});

t('split: --stop-host refuses while busy, then stops; a new host offers the chat again', async () => {
  await using fx = new Fixture();
  const web = await fx.startWeb();
  const hostPid = web.boot.hostPid as number;
  const cid = await openConversation(web, fx);
  await web.post('prompt', { id: cid, text: 'wait', clientMessageId: 'busy-1' });
  await until(async () => (await web.state(cid)).busy, 'busy turn');
  const refused = await fx.runCli('--stop-host');
  assertEquals(refused.code, 2, refused.stdout + refused.stderr);
  assert(refused.stdout.includes('Refusing') && refused.stdout.includes('claude'), refused.stdout);
  assert(pidAlive(hostPid));
  assert(((await web.listing()).connections as Json[])[0].busy);
  await web.post('cancel', { id: cid });
  await until(async () => !(await web.state(cid)).busy, 'idle');
  const sessionId = (await web.state(cid)).sessionId as string;

  const stopped = await fx.runCli('--stop-host');
  assertEquals(stopped.code, 0, stopped.stdout + stopped.stderr);
  assert(!pidAlive(hostPid));
  assertEquals(await readInfo(fx.state), null, 'a clean stop removes the host file');
  const listed = await web.listing();
  assertEquals(listed.connections, []);
  assert(String(listed.recoveryWarning).includes('not running'), String(listed.recoveryWarning));
  assertEquals((await web.get(`/api/live/state?id=${cid}`))[0], 503);
  assertEquals(await readInfo(fx.state), null, 'the web server does not silently start another host');

  await web.kill();
  const web2 = await fx.startWeb(['--no-auto-reconnect']);
  assert(web2.boot.hostPid !== hostPid, JSON.stringify([web2.boot.hostPid, hostPid, web2.boot.hostProblem]));
  assert(web2.instance !== web.instance, 'a new host is a new instance');
  const recovered = (await web2.listing()).recovered as Json[];
  assertEquals(recovered.map((r) => [r.provider, r.sessionId]), [['claude', sessionId]]);
  assertEquals((await web2.listing()).connections, []);
  const [status, resumed] = await web2.post('connect', {
    provider: 'claude',
    cwd: fx.workspace,
    resume: sessionId,
    background: true,
    continueAnyway: true,
  });
  assertEquals(status, 200, JSON.stringify(resumed));
});

t('split: --stop-host --force cuts a busy turn', async () => {
  await using fx = new Fixture();
  const web = await fx.startWeb();
  const hostPid = web.boot.hostPid as number;
  const cid = await openConversation(web, fx);
  await web.post('prompt', { id: cid, text: 'wait', clientMessageId: 'busy-1' });
  await until(async () => (await web.state(cid)).busy, 'busy turn');
  const result = await fx.runCli('--stop-host', '--force');
  assertEquals(result.code, 0, result.stdout + result.stderr);
  await until(() => !pidAlive(hostPid), 'host exit');
});

t('split: a crashed host with an open chat is restarted and offers the chat again', async () => {
  await using fx = new Fixture();
  const web = await fx.startWeb(['--no-auto-reconnect']);
  const oldPid = web.boot.hostPid as number;
  const cid = await openConversation(web, fx);
  const sessionId = (await web.state(cid)).sessionId as string;
  Deno.kill(oldPid, 'SIGKILL'); // a crash: no clean shutdown runs
  await until(() => !pidAlive(oldPid), 'host death');
  const listed = await until(
    async () => {
      const [status, body] = await web.get('/api/live/list');
      return status === 200 ? body : null;
    },
    'web server to restart the host',
    60,
  );
  const newPid = (await fx.hostInfo())!.pid!;
  assert(newPid !== oldPid && pidAlive(newPid));
  assert(listed.instanceId !== web.instance, 'a new host is a new instance');
  assertEquals(listed.connections, []);
  assertEquals((listed.recovered as Json[]).map((r) => [r.provider, r.sessionId]), [['claude', sessionId]]);
  assert([404, 503].includes((await web.get(`/api/live/state?id=${cid}`))[0]));
  const [status, resumed] = await web.post('connect', {
    provider: 'claude',
    cwd: fx.workspace,
    resume: sessionId,
    background: true,
    continueAnyway: true,
  });
  assertEquals(status, 200, JSON.stringify(resumed));
  await until(async () => (await web.state(resumed.id as string)).ready, 'resumed conversation ready');
});

t('split: a host start reconnects the recovered chat by itself; --no-auto-reconnect turns it off', async () => {
  await using fx = new Fixture();
  const first = await fx.startWeb(['--no-auto-reconnect']);
  const cid = await openConversation(first, fx);
  const sessionId = (await first.state(cid)).sessionId as string;
  assertEquals((await fx.runCli('--stop-host', '--force')).code, 0);
  await first.kill();
  const off = await fx.startWeb(['--no-auto-reconnect']);
  await sleep(1500);
  let listing = await off.listing();
  assertEquals(listing.connections, []);
  assertEquals((listing.recovered as Json[]).map((r) => r.sessionId), [sessionId]);
  assertEquals(listing.autoReconnect, false);
  await off.kill();
  assertEquals((await fx.runCli('--stop-host', '--force')).code, 0);
  const on = await fx.startWeb();
  await until(
    async () => ((await on.listing()).connections as Json[]).some((c) => c.sessionId === sessionId && c.ready),
    'automatic reconnect',
  );
  listing = await on.listing();
  assertEquals(listing.autoReconnect, true);
  assertEquals(listing.recovered, []);
  const connection = (listing.connections as Json[]).find((c) => c.sessionId === sessionId)!;
  const state = await on.state(connection.id as string);
  assertEquals((state.events as Json[]).filter((e) => e.kind === 'user'), [], 'nothing was sent');
  assertEquals(state.busy, false);
});

t('--in-process: agents run inside the web server, no host is started', async () => {
  await using fx = new Fixture();
  const web = await fx.startWeb(['--in-process']);
  assertEquals(web.boot.hostMode, 'in-process');
  assertEquals(web.boot.hostPid, web.process.pid);
  assertEquals(web.boot.instanceId, web.boot.webInstanceId);
  assertEquals(await readInfo(fx.state), null, 'no host is started in --in-process mode');
  const cid = await openConversation(web, fx);
  await web.post('prompt', { id: cid, text: 'wait', clientMessageId: 'x' });
  await until(async () => (await web.state(cid)).busy, 'busy turn');
  await web.post('cancel', { id: cid });
  await until(async () => !(await web.state(cid)).busy, 'idle');
  assertEquals((await web.post('disconnect', { id: cid }))[0], 200);
});

t('host: idle exit waits for an attached web server; 0 turns it off', async () => {
  await using fx = new Fixture();
  const host = await fx.startHost(['--idle-exit-minutes', '0.03']);
  let exited = false;
  host.status.then(() => (exited = true));
  const client = (await fx.host())!;
  await client.call('attach', { pid: 1, webInstanceId: 'test-web' });
  await sleep(4500); // past two idle checks (every 2 s) and the 1.8 s idle period
  assert(!exited, 'an attached web server keeps the host alive');
  await client.call('detach', { webInstanceId: 'test-web' });
  await until(() => exited, 'idle exit', 30);
  assertEquals(await readInfo(fx.state), null);

  await using fx2 = new Fixture();
  const forever = await fx2.startHost(['--idle-exit-minutes', '0']);
  let gone = false;
  forever.status.then(() => (gone = true));
  await sleep(2500);
  assert(!gone);
});

t('host: a second host for the same state folder exits quietly', async () => {
  await using fx = new Fixture();
  const first = await fx.startHost();
  const out = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', '--quiet', MAIN, 'host', ...fx.agentFlags()],
    env: fx.env,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  assert(new TextDecoder().decode(out.stdout).includes('already runs'));
  assertEquals((await readInfo(fx.state))!.pid, first.pid);
});

t('host: the RPC needs the token, a loopback Host and no browser headers; GET is not served', async () => {
  await using fx = new Fixture();
  await fx.startHost();
  const info = (await readInfo(fx.state))!;
  const body = JSON.stringify({ op: 'info', args: {} });
  const post = async (headers: Record<string, string>) => {
    // Raw HTTP so the Host, Origin and Sec-Fetch-Site headers are exactly what the test says.
    const conn = await Deno.connect({ hostname: '127.0.0.1', port: info.port });
    const all = { Host: `127.0.0.1:${info.port}`, 'Content-Length': String(body.length), ...headers };
    const head = `POST /rpc HTTP/1.0\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    await conn.write(new TextEncoder().encode(head + body));
    const text = new TextDecoder().decode(await new Response(conn.readable).arrayBuffer());
    return Number(text.match(/^HTTP\/\d\.\d (\d{3})/)![1]);
  };
  const good = { [TOKEN_HEADER]: info.token };
  assertEquals(await post(good), 200);
  assertEquals(await post({}), 403);
  assertEquals(await post({ [TOKEN_HEADER]: 'x'.repeat(info.token.length) }), 403);
  assertEquals(await post({ ...good, Host: 'evil.example' }), 403);
  assertEquals(await post({ ...good, Origin: 'http://evil.example' }), 403);
  assertEquals(await post({ ...good, 'Sec-Fetch-Site': 'cross-site' }), 403);
  const get = await fetch(`http://127.0.0.1:${info.port}/rpc`);
  await get.body?.cancel();
  assert([403, 405].includes(get.status));
  const live = await new HostClient(info).call('info') as Json;
  assertEquals(live.protocol, PROTOCOL_VERSION);
  assertEquals(live.runtime, 'deno');
  assertEquals(live.format, HOST_FORMAT);
  for (const key of ['hostId', 'startedAt', 'stateDir', 'codeRoot', 'sourceHash', 'appId', 'version', 'open', 'active', 'webAttached']) {
    assert(key in live, `info has ${key}`);
  }
  try {
    await new HostClient({ ...info, token: 'wrong' }).call('info');
    throw new Error('expected a refusal');
  } catch (error) {
    assert(error instanceof HostUnavailable && error.code === 'host_auth', String(error));
  }
  // Request errors carry Python's error type; unknown ops are 404.
  const client = new HostClient(info);
  for (const [op, args, text] of [['state', {}, "'id'"], ['live', { name: 'prompt', body: { id: 'nope' } }, null]] as const) {
    try {
      const result = await client.call(op, args);
      assert(text === null, `${op} should fail`);
      assertEquals(result, [400, { error: "'nope'" }]);
    } catch (error) {
      assertEquals((error as Error).message, text);
      assertEquals((error as Error).constructor.name, 'HostValueError');
    }
  }
  const [status] = await httpJson('POST', info.port, '/rpc', null, {});
  assertEquals(status, 403);
});

t('a host speaking another protocol is reported, left running, and the web server runs degraded', async () => {
  await using fx = new Fixture();
  const stub = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
    const op = (await request.json()).op;
    calls.push(op);
    return Response.json({
      result: { protocol: 99, open: 2, active: [{ provider: 'claude', cwd: 'C:\\x', state: 'working' }], pid: Deno.pid },
    });
  });
  const calls: string[] = [];
  try {
    await writeInfo(fx.state, {
      format: HOST_FORMAT,
      protocol: 99,
      pid: Deno.pid,
      port: stub.addr.port,
      token: 't'.repeat(20),
      hostId: 'stub',
      startedAt: Date.now() / 1000,
      runtime: 'deno', // a Deno host of another protocol (a host without runtime is a Python host: the takeover path, tested apart)
    });
    try {
      await findOrStart(fx.state, ['nothing'], { waitSeconds: 3 });
      throw new Error('expected HostIncompatible');
    } catch (error) {
      assert(error instanceof HostIncompatible, String(error));
      assert(error.message.includes('protocol 99') && error.message.includes('working or waiting'), error.message);
    }
    const web = await fx.startWeb();
    assert(String(web.boot.hostProblem).includes('protocol 99'));
    const listed = await web.listing();
    assertEquals(listed.connections, []);
    assert(String(listed.recoveryWarning).includes('protocol 99'));
    const [status, payload] = await web.post('connect', { provider: 'claude', cwd: fx.workspace });
    assertEquals([status, payload.code], [503, 'host_incompatible']);
    const page = await fetch(`http://127.0.0.1:${web.port}/chat.html`);
    await page.body?.cancel();
    assertEquals(page.status, 200);
    assert(!calls.includes('stop'), 'a host with live work is never stopped automatically');
    assert((await readInfo(fx.state)) !== null);
  } finally {
    await removeInfo(fx.state); // the stub is not a real host: keep cleanup from calling it
    await stub.shutdown();
  }
});

t('switching from the single-process server to the host carries the recovery list over once', () => {
  const d = Deno.makeTempDirSync({ prefix: 'aib-host-migrate-' });
  try {
    const old = new StateStore(d, 'recovery-8767');
    old.rememberConversation('claude', 's1', 'C:\\REPOS\\demo-project\\mod', 'mod chat');
    old.setReceipt('claude', 's1', 'm1', 'fp', 'working');
    const host = new StateStore(d, 'recovery-host');
    host.rememberConversation('omp', 's2', 'C:/work', 'already in host');
    migrateInProcessRecovery(host);
    const keys = new Set(host.conversations.keys());
    assertEquals([...keys].sort(), [StateStore.sessionKey('claude', 's1'), StateStore.sessionKey('omp', 's2')].sort());
    assertEquals(host.receipt('claude', 's1', 'm1')!.state, 'unknown');
    const names = [...Deno.readDirSync(d)].map((e) => e.name);
    assert(!names.includes('studio-recovery-8767.json') && names.includes('studio-recovery-8767.json.migrated'), names.join());
    const reloaded = new StateStore(d, 'recovery-host');
    assertEquals([...reloaded.conversations.keys()].sort(), [...keys].sort());
    migrateInProcessRecovery(reloaded); // second run: nothing left to merge
    assertEquals([...reloaded.conversations.keys()].sort(), [...keys].sort());
    migrateInProcessRecovery(null);
  } finally {
    Deno.removeSync(d, { recursive: true });
  }
});
