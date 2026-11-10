/**
 * The listeners inside a `deno desktop` binary (server/platform/http_serve.ts: node:http instead of Deno.serve, so the runtime never
 * opens a window), the redirect on the runtime's own serve port (server/desktop/serve_address.ts), and studio.log being written by
 * a headless `serve`. No window is ever opened: everything here is plain HTTP on 127.0.0.1.
 */
import { assert, assertEquals } from './_assert.ts';
import { implementation, serve } from '../../outputs/agent-studio/server/platform/http_serve.ts';
import { redirectTarget, servePort, startBlank, startRedirect } from '../../outputs/agent-studio/server/desktop/serve_address.ts';
import { DENO, Fixture, MAIN, TEST_OPTIONS, until } from './_host_fixture.ts';

function withImpl<T>(impl: 'node' | 'deno', fn: () => Promise<T>): Promise<T> {
  const before = Deno.env.get('AIB_HTTP_IMPL');
  Deno.env.set('AIB_HTTP_IMPL', impl);
  return fn().finally(() => (before === undefined ? Deno.env.delete('AIB_HTTP_IMPL') : Deno.env.set('AIB_HTTP_IMPL', before)));
}

Deno.test('http_serve: Deno.serve under deno run, node:http when forced (the desktop binary path)', async () => {
  assertEquals(implementation(), Deno.env.get('AIB_HTTP_IMPL') ?? 'deno');
  await withImpl('node', () => Promise.resolve(assertEquals(implementation(), 'node')));
});

for (const impl of ['node', 'deno'] as const) {
  Deno.test({
    name: `http_serve (${impl}): bodies, headers, cookies, HEAD, peer address, busy port throws at once, shutdown`,
    ...TEST_OPTIONS,
    fn: () =>
      withImpl(impl, async () => {
        const seen: string[] = [];
        const server = serve({ hostname: '127.0.0.1', port: 0 }, async (request, info) => {
          seen.push(info.remoteAddr.hostname);
          const url = new URL(request.url);
          if (url.pathname === '/boom') throw new Error('handler bug');
          if (url.pathname === '/stream') {
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode('a'));
                c.enqueue(new TextEncoder().encode('b'));
                c.close();
              },
            });
            return new Response(body, { headers: { 'content-type': 'text/plain' } });
          }
          const headers = new Headers({ 'x-method': request.method, 'x-host': request.headers.get('host') ?? '' });
          headers.append('set-cookie', 'a=1');
          headers.append('set-cookie', 'b=2');
          const text = request.method === 'POST' ? await request.text() : `${url.pathname}${url.search}`;
          return new Response(text, { status: 201, headers });
        });
        try {
          const port = server.addr.port;
          assert(port > 0, 'the port is known at once');
          let threw = false;
          try {
            serve({ hostname: '127.0.0.1', port }, () => new Response('')).shutdown();
          } catch {
            threw = true;
          }
          assert(threw, 'a busy port throws synchronously, like Deno.serve');
          const base = `http://127.0.0.1:${port}`;
          let r = await fetch(`${base}/p?q=1`);
          assertEquals([r.status, await r.text()], [201, '/p?q=1']);
          assertEquals(r.headers.get('x-method'), 'GET');
          assertEquals(r.headers.get('x-host'), `127.0.0.1:${port}`);
          assertEquals(r.headers.getSetCookie(), ['a=1', 'b=2']);
          r = await fetch(`${base}/`, { method: 'POST', body: 'x'.repeat(100_000) });
          assertEquals((await r.text()).length, 100_000);
          r = await fetch(`${base}/p`, { method: 'HEAD' });
          assertEquals([r.status, await r.text()], [201, '']);
          r = await fetch(`${base}/stream`);
          assertEquals(await r.text(), 'ab');
          r = await fetch(`${base}/boom`);
          assertEquals(r.status, 500);
          await r.body?.cancel();
          assertEquals(seen[0], '127.0.0.1');
        } finally {
          await server.shutdown();
        }
        let refused = false;
        try {
          await fetch(`http://127.0.0.1:${server.addr.port}/`);
        } catch {
          refused = true;
        }
        assert(refused, 'shut down');
      }),
  });
}

Deno.test('serve address: the port in DENO_SERVE_ADDRESS, and the redirect target keeps the path', () => {
  assertEquals(servePort('tcp:127.0.0.1:51234'), 51234);
  assertEquals(servePort('127.0.0.1:8000'), 8000);
  assertEquals(servePort('tcp:[::1]:9000'), 9000);
  assertEquals(servePort('unix:/tmp/x.sock'), null);
  assertEquals(servePort(''), null);
  assertEquals(servePort(undefined), null);
  assertEquals(servePort('tcp:127.0.0.1:99999'), null);
  assertEquals(redirectTarget('http://127.0.0.1:51234/chat.html?c=1', 'http://127.0.0.1:8777/'), 'http://127.0.0.1:8777/chat.html?c=1');
  assertEquals(redirectTarget('http://127.0.0.1:51234/', 'http://127.0.0.1:8777/'), 'http://127.0.0.1:8777/');
});

for (const impl of ['node', 'deno'] as const) {
  Deno.test({
    name: `redirect listener (${impl}): every request on the runtime's port is a 302 to the same path on our page`,
    ...TEST_OPTIONS,
    fn: () =>
      withImpl(impl, async () => {
        const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
        const port = (probe.addr as Deno.NetAddr).port;
        probe.close();
        const server = startRedirect(port, 'http://127.0.0.1:8777/')!;
        try {
          assert(server, 'bound');
          for (const path of ['/', '/chat.html?c=abc', '/api/x']) {
            const r = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
            assertEquals(r.status, 302);
            assertEquals(r.headers.get('location'), `http://127.0.0.1:8777${path}`);
            await r.body?.cancel();
          }
          const busy = startRedirect(port, 'http://127.0.0.1:8777/');
          assertEquals(busy, null, 'a port that cannot be bound is logged and skipped, never thrown');
        } finally {
          await server?.shutdown();
        }
      }),
  });
}

Deno.test({
  name: 'headless serve writes studio.log in the data folder, with the startup line',
  ...TEST_OPTIONS,
  fn: async () => {
    await using fx = new Fixture();
    const port = 8941;
    fx.spawn([DENO, 'run', '-A', '--quiet', MAIN, 'serve', '--in-process', '--port', String(port), '--state-dir', fx.state], 'serve');
    const path = `${fx.state}/studio.log`;
    const text = await until(
      () => {
        const t = Deno.readTextFileSync(path);
        return t.includes(`on http://127.0.0.1:${port}`) ? t : '';
      },
      'startup line in studio.log',
      60,
    );
    assert(
      /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} INFO studio: AIB \S+ on http:\/\/127\.0\.0\.1:8941 \(pid \d+, server, data /.test(text),
      text,
    );
  },
});

/** Is a process still running? (tasklist on Windows: Deno.kill cannot probe there.) */
function running(pid: number): boolean {
  if (Deno.build.os === 'windows') {
    const out = new Deno.Command('tasklist', { args: ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], stdout: 'piped', stderr: 'null' })
      .outputSync();
    return new TextDecoder().decode(out.stdout).includes(`"${pid}"`);
  }
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name: 'main.ts: the data-folder lock holds while a chat terminal runs; quitting (close()) ends the shell and frees the folder',
  ...TEST_OPTIONS,
  fn: async () => {
    await using fx = new Fixture();
    const port = 8812;
    const args = ['run', '-A', '--quiet', MAIN, 'serve', '--in-process', '--port', String(port), '--state-dir', fx.state];
    const [web] = fx.spawn([DENO, ...args], 'serve');
    const origin = `http://127.0.0.1:${port}`;
    const boot = await until(async () => {
      const r = await fetch(`${origin}/api/live/bootstrap`);
      return r.status === 200 ? await r.json() : (await r.body?.cancel(), null);
    }, 'bootstrap', 60);
    const token = String(boot.token);

    // The lock came first: a second serve on the same folder refuses with code 2 while this one runs.
    const [second] = fx.spawn([DENO, ...args.map((a) => (a === String(port) ? String(port + 2) : a))], 'second');
    assertEquals((await second.status).code, 2);

    // A chat's terminal (terminal/sessions.ts) inside that server.
    // @ts-ignore: Deno's WebSocket takes headers
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/terminal?key=claude%3Ajoin&cwd=${encodeURIComponent(fx.workspace)}`, {
      protocols: ['aib-terminal', 'aib-token.' + token],
      headers: { Origin: origin },
    });
    const messages: { type?: string }[] = [];
    ws.onmessage = (e: MessageEvent) => typeof e.data === 'string' && messages.push(JSON.parse(e.data));
    const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()));
    await until(() => messages.some((m) => m.type === 'ready'), 'terminal ready', 30);
    const list = await (await fetch(`${origin}/api/live/terminal/list`, { headers: { 'X-Studio-Token': token } })).json();
    const pids = list.terminals.map((t: { pid: number }) => t.pid);
    assertEquals(pids.length, 1);
    assert(running(pids[0]), 'the shell runs');

    // Quit through the normal close path (the same close() the tray's Quit and Ctrl+C run).
    const r = await fetch(`${origin}/api/live/shutdown`, {
      method: 'POST',
      headers: { 'X-Studio-Token': token, Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    await r.body?.cancel();
    assertEquals((await web.status).code, 0);
    await closed;
    await until(() => !running(pids[0]), 'the shell ended with the server', 10);
    const { claimFolder } = await import('../../outputs/agent-studio/server/desktop/single_instance.ts');
    const claim = await claimFolder(fx.state, { mode: 'server', port: 8813 });
    try {
      assert(claim.primary, 'the folder lock was released');
    } finally {
      if (claim.primary) claim.release();
    }
  },
});

for (const impl of ['node', 'deno'] as const) {
  Deno.test({
    name: `blank listener (${impl}): a process with no app window answers the runtime's port with an empty page (QA 4 #19)`,
    ...TEST_OPTIONS,
    fn: () =>
      withImpl(impl, async () => {
        const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
        const port = (probe.addr as Deno.NetAddr).port;
        probe.close();
        const server = startBlank(port)!;
        try {
          assert(server, 'bound');
          const r = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
          assertEquals(r.status, 200, 'the runtime finds a server at once: no "Server not ready after 15s"');
          assertEquals(await r.text(), '<!doctype html><title>AIB</title>');
          assertEquals(startBlank(port), null, 'a port that cannot be bound is skipped, never thrown');
        } finally {
          await server?.shutdown();
        }
      }),
  });
}
