/**
 * A fake agent host for the takeover tests (test_host_takeover.py's FakeHost, as its own process): it speaks just enough of the
 * host RPC (info, stop, attach), publishes agent-host.json with the code root, app, version and runtime it is given, and counts as
 * having N working chats, N read from <state>/fake-active on every call. Working chats make stop refuse, as the real host does.
 * Every op it receives is appended to <state>/fake-calls.log. On a stop it removes its file and exits.
 *
 *   deno run -A _fake_host.ts STATE CODE_ROOT APP_ID VERSION RUNTIME(or "none") PROTOCOL [SOURCE_HASH]
 */
import { HOST_FORMAT, removeInfo, writeInfo } from '../../outputs/agent-studio/server/host/host_client.ts';

const [state, codeRoot, appId, version, runtime, protocol, hash = 'x'] = Deno.args;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

function active(): number {
  try {
    return parseInt(Deno.readTextFileSync(state + sep + 'fake-active'), 10) || 0;
  } catch {
    return 0;
  }
}

const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
  const body = JSON.parse(await request.text());
  Deno.writeTextFileSync(state + sep + 'fake-calls.log', body.op + '\n', { append: true });
  const busy = Array.from({ length: active() }, () => ({ provider: 'claude', cwd: 'C:\\x', state: 'working' }));
  let result: Record<string, unknown> = {};
  let exit = false;
  if (body.op === 'info') {
    result = { protocol: Number(protocol), open: busy.length, active: busy, pid: Deno.pid, hostId: 'fake', connections: [], sourceHash: hash, version };
    if (runtime !== 'none') result.runtime = runtime;
  } else if (body.op === 'stop' && busy.length) result = { stopping: false, active: busy, message: 'busy' };
  else if (body.op === 'stop') {
    result = { stopping: true, active: [] };
    exit = true;
  }
  if (exit) {
    setTimeout(async () => {
      await removeInfo(state, Deno.pid);
      Deno.exit(0);
    }, 200);
  }
  return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } });
});

const info: Record<string, unknown> = {
  format: HOST_FORMAT,
  protocol: Number(protocol),
  pid: Deno.pid,
  port: server.addr.port,
  token: 't'.repeat(20),
  hostId: 'fake',
  startedAt: Date.now() / 1000,
  codeRoot,
  sourceHash: hash,
  appId,
  version,
};
if (runtime !== 'none') info.runtime = runtime;
await writeInfo(state, info);
setTimeout(() => Deno.exit(0), 120_000); // never outlive a test run
