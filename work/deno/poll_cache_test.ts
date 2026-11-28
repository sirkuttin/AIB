/**
 * The server side of the 2026-11-27 slowness fix: kept answers for polled routes (core/memo.ts), ETag / 304 for the page's polls, and a
 * client hang-up that is not logged as "request handler failed". Run (from app): deno test -A ../work/deno/poll_cache_test.ts
 */
import { assert, assertEquals } from './_assert.ts';
import { clearMemos, Memo } from '../../app/server/core/memo.ts';
import { isHangUp, serve } from '../../app/server/platform/http_serve.ts';
import { ContractServer } from './_contract_server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test('memo: one run for many askers, kept for the ttl, never keeps a failure, dropped by clearMemos', async () => {
  const memo = new Memo<number>(60);
  let runs = 0;
  const run = async () => {
    runs++;
    await sleep(20);
    return runs;
  };
  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => memo.get('k', run)));
  assertEquals(answers, [1, 1, 1, 1, 1], 'five askers at once share one run');
  assertEquals(await memo.get('k', run), 1, 'asked again inside the ttl: the kept answer');
  await sleep(80);
  assertEquals(await memo.get('k', run), 2, 'after the ttl: a new run');
  clearMemos();
  assertEquals(await memo.get('k', run), 3, 'a write (clearMemos) drops the kept answer');
  let failures = 0;
  const bad = () => {
    failures++;
    return Promise.reject(new Error('nope'));
  };
  await memo.get('bad', bad).catch(() => {});
  await memo.get('bad', bad).catch(() => {});
  assertEquals(failures, 2, 'a failure is not kept');
  const small = new Memo<number>(1000, 3);
  for (let i = 0; i < 6; i++) await small.get(`k${i}`, () => Promise.resolve(i));
  let again = 0;
  await small.get('k0', () => Promise.resolve(++again));
  assertEquals(again, 1, 'past max the oldest keys go');
});

Deno.test('http_serve: a client that hangs up mid-request is not a handler failure', async () => {
  const before = Deno.env.get('AIB_HTTP_IMPL');
  Deno.env.set('AIB_HTTP_IMPL', 'node');
  let failed = 0, reading = false;
  const server = serve({ hostname: '127.0.0.1', port: 0, onError: () => (failed++, new Response('x', { status: 500 })) }, async (request) => {
    reading = true;
    await request.text(); // waits for a body that never completes
    return new Response('ok');
  });
  try {
    const port = server.addr.port;
    for (let i = 0; i < 100; i++) {
      try {
        (await Deno.connect({ hostname: '127.0.0.1', port })).close();
        break;
      } catch {
        await sleep(20);
      }
    }
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    await conn.write(new TextEncoder().encode(`POST /x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n\r\n{"half":`));
    for (let i = 0; i < 100 && !reading; i++) await sleep(20);
    assert(reading, 'the handler started reading the body');
    conn.close();
    await sleep(300);
    assertEquals(failed, 0, 'onError (the "request handler failed" log) is not called for a hang-up');
    assert(isHangUp(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })));
    assert(!isHangUp(new Error('handler bug')));
  } finally {
    await server.shutdown();
    if (before === undefined) Deno.env.delete('AIB_HTTP_IMPL');
    else Deno.env.set('AIB_HTTP_IMPL', before);
  }
});

Deno.test('the page polls carry an ETag; asking again with it is a 304 with no body, a change is a 200', async () => {
  await using s = await ContractServer.start();
  const first = await s.get('/api/sessions');
  assertEquals(first.status, 200);
  const etag = first.headers['etag'];
  assert(etag && /^"[0-9a-f]+"$/.test(etag), `an ETag: ${etag}`);
  const same = await s.get('/api/sessions', { 'If-None-Match': etag });
  assertEquals(same.status, 304);
  assertEquals(same.body.length, 0, 'a 304 has no body');
  assertEquals(same.headers['etag'], etag);
  const stale = await s.get('/api/sessions', { 'If-None-Match': '"0000"' });
  assertEquals(stale.status, 200);
  assert(stale.body.length > 0);
  // a list that is not one of the page's polls carries none
  const boot = await s.bootstrap();
  assertEquals(boot.headers['etag'], undefined);
});
