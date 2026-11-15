/**
 * Where restart and request time goes (server/core/timing.ts): the per-chat take-over timing line Studio logs for each chat it
 * takes over from the keeper (phases and total), and the slow-request line for any HTTP request of 1 s or more (path only).
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { addHandler, type Handler, removeHandler } from '../../outputs/agent-studio/server/core/log.ts';
import {
  noteRequestTime,
  PhaseTimer,
  rebuildPhases,
  SLOW_REQUEST_MS,
  slowRequestLine,
} from '../../outputs/agent-studio/server/core/timing.ts';
import { timedHandler } from '../../outputs/agent-studio/server/platform/http_serve.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';

function capture(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const handler: Handler = { emit: (line) => void lines.push(line), close: () => {} };
  addHandler(handler);
  return { lines, stop: () => removeHandler(handler) };
}

Deno.test('PhaseTimer: one line per chat, each phase and the total, in ms', () => {
  let t = 1000;
  const timer = new PhaseTimer(() => t);
  t += 12;
  timer.mark('note');
  t += 3;
  timer.mark('setup');
  t += 50; // the wait for c.rebuilt: 30 attach/read + 15 replay + 4 rebuild, 1 left over
  rebuildPhases(timer, { adopt: 100, live: 130, replayed: 145, settled: 149 });
  t += 2;
  timer.mark('lease');
  assertEquals(
    timer.line('claude s1 chat-1'),
    'take-over timing claude s1 chat-1: note 12 ms, setup 3 ms, attach/read 30 ms, replay 15 ms, rebuild 4 ms, waiting 1 ms, lease 2 ms, total 67 ms',
  );
  const none = new PhaseTimer(() => t);
  t += 5;
  rebuildPhases(none, { adopt: 0, live: 0, replayed: 0, settled: 0 }); // never reached the live end
  assertEquals(none.phases, [['waiting', 5]]);
});

Deno.test('slow requests: 1 s or more is logged with its path only (never the query), faster ones are not', async () => {
  assertEquals(
    slowRequestLine('GET', 'http://127.0.0.1:1/api/live/state?id=x&token=secret', 1234.4, 200),
    'slow request: GET /api/live/state took 1234 ms (200)',
  );
  assertEquals(slowRequestLine('POST', '/api/x?y', 2000, null), 'slow request: POST /api/x took 2000 ms (failed)');
  const log = capture();
  try {
    noteRequestTime('GET', 'http://h/fast', SLOW_REQUEST_MS - 1, 200);
    noteRequestTime('GET', 'http://h/slow?token=abc', SLOW_REQUEST_MS, 200);
    assertEquals(log.lines.length, 1);
    assert(log.lines[0].includes(' INFO http: slow request: GET /slow took 1000 ms (200)'), log.lines[0]);
    // Through the serve() wrapper: a handler that takes over a second, one that is quick, one that throws.
    const info = { remoteAddr: { hostname: '127.0.0.1', port: 1, transport: 'tcp' as const } };
    const slow = timedHandler(async () => {
      await pause(SLOW_REQUEST_MS + 50);
      return new Response('ok', { status: 201 });
    });
    const quick = timedHandler(() => new Response('ok'));
    const broken = timedHandler(async () => {
      await pause(SLOW_REQUEST_MS + 50);
      throw new Error('boom');
    });
    assertEquals((await slow(new Request('http://127.0.0.1:1/api/slow?q=1'), info)).status, 201);
    await quick(new Request('http://127.0.0.1:1/api/quick'), info);
    let threw = false;
    try {
      await broken(new Request('http://127.0.0.1:1/api/broken', { method: 'POST' }), info);
    } catch {
      threw = true;
    }
    assert(threw, 'the error still reaches serve()');
    const lines = log.lines.slice(1);
    assertEquals(lines.length, 2, lines.join('\n'));
    assert(/slow request: GET \/api\/slow took \d+ ms \(201\)$/.test(lines[0]), lines[0]);
    assert(/slow request: POST \/api\/broken took \d+ ms \(failed\)$/.test(lines[1]), lines[1]);
  } finally {
    log.stop();
  }
});

Deno.test({
  name: 'take-over timing: Studio logs one line per chat it takes over from the keeper, every phase and the total',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await keeperBinary();
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-takeover-timing-' }));
    const state = dir + SEP + 'state';
    const work = dir + SEP + 'work';
    Deno.mkdirSync(work, { recursive: true });
    const studios: Studio[] = [];
    const studio = () => {
      const keeper = new KeeperLink({ dataDir: state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
      const s = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null }, { keeper });
      s.ownerProbe = () => null;
      s.connectionFactory = (_command, cwd, provider, options) =>
        new Connection(fake('--cancel-aware'), cwd, provider, { ...options, env: { FAKE_ACP_LOG: dir + SEP + 'agent.log' } });
      studios.push(s);
      return s;
    };
    const log = capture();
    try {
      const a = studio();
      const c = await a.connect('omp', work);
      // A crash: the keeper connection goes, the agent and its record stay.
      a.keeper!.disconnect();
      for (const conn of a.connections.values()) conn.sessionLease?.release();
      a.reconnectStop.set();
      studios.splice(studios.indexOf(a), 1);
      await pause(200);

      const b = studio();
      assertEquals(await b.adoptKeeper(), 1);
      const lines = log.lines.filter((l) => l.includes('keeper: take-over timing'));
      assertEquals(lines.length, 1, log.lines.join('\n'));
      const line = lines[0];
      assert(line.includes(' INFO studio: keeper: take-over timing omp fake-session ' + c.id + ': '), line);
      for (
        const phase of ['note', 'setup', 'attach/read', 'replay', 'rebuild', 'lease', 'queue and announce', 'live sync', 'duplicate check']
      ) {
        assert(new RegExp(`[:,] ${phase.replace('/', '\\/')} \\d+ ms`).test(line), `${phase} in: ${line}`);
      }
      assert(/, total \d+ ms$/.test(line), line);
    } finally {
      log.stop();
      for (const s of studios.reverse()) await s.close().catch(() => {});
      const info = readKeeperInfo(state);
      if (info && pidAlive(info.pid)) {
        try {
          const client = await KeeperClient.connect(info);
          await client.shutdown(true).catch(() => {});
          client.close();
        } catch { /* gone */ }
        await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
      }
      for (let i = 0; i < 20; i++) {
        try {
          Deno.removeSync(dir, { recursive: true });
          break;
        } catch {
          await pause(200);
        }
      }
    }
  },
});
