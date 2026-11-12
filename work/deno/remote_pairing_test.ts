/**
 * Phone access, the parts without a server: the pairing words (and the phone page's copy of the list), the pairing rules (expiry,
 * one claim, three wrong tries, the global limit, check words), the paired-phone store (hashes only, last seen throttled), the
 * activity log's rotation, the fixed phone port, and reading the Tailscale CLI.
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { checkWords, hex, parseCode, WORDS } from '../../outputs/agent-studio/server/remote/words.ts';
import { MAX_WRONG, Pairing, PairingError } from '../../outputs/agent-studio/server/remote/pairing.ts';
import { DeviceStore } from '../../outputs/agent-studio/server/remote/devices.ts';
import { Audit } from '../../outputs/agent-studio/server/remote/audit.ts';
import { bindWithRetry, PortBusy, readRemotePort, remotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { cleanName, readServe, readTailscale } from '../../outputs/agent-studio/server/remote/tailscale.ts';
import { APP_ROOT } from '../../outputs/agent-studio/server/core/app.ts';
import { fakeTailscale, LOGIN, NAME, nonce, serveStatus, tailscaleStatus, tempDir } from './_remote_fixture.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';

Deno.test("the word list has 256 different words and equals the phone page's copy", () => {
  assertEquals(WORDS.length, 256);
  assertEquals(new Set(WORDS).size, 256);
  assert(WORDS.every((w) => /^[a-z]{3,8}$/.test(w)));
  const js = Deno.readTextFileSync(`${APP_ROOT}${sep}phone-words.js`);
  const list = js.slice(js.indexOf('const WORDS = ['), js.indexOf('];'));
  assertEquals([...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...WORDS]);
});

Deno.test('a code is the 12 hex characters from the QR or the six words, any case and spacing', () => {
  const secret = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const words = [...secret].map((b) => WORDS[b]);
  assertEquals(parseCode(hex(secret)), secret);
  assertEquals(parseCode('  ' + words.join('  ').toUpperCase() + ' '), secret);
  assertEquals(parseCode(words.join(', ')), secret);
  assertEquals(parseCode(words.slice(0, 5).join(' ')), null);
  assertEquals(parseCode(words.join(' ') + ' amber'), null);
  assertEquals(parseCode('notaword ' + words.slice(1).join(' ')), null);
  assertEquals(parseCode(42), null);
});

function clock(start = 1000) {
  const c = { t: start, now: () => c.t };
  return c;
}

function claimWith(p: Pairing, code: string, name = 'Pixel 9') {
  return p.claim({ code, name, login: LOGIN, phoneNonce: nonce() });
}

function refused(fn: () => unknown): PairingError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PairingError) return error;
    throw error;
  }
  throw new Error('not refused');
}

Deno.test('pairing: a code expires after 5 minutes', () => {
  const c = clock();
  const p = new Pairing(c.now);
  const code = p.start();
  c.t += 5 * 60 + 1;
  const e = refused(() => claimWith(p, code.words.join(' ')));
  assertEquals([e.status, e.code], [410, 'expired']);
});

Deno.test('pairing: the first right claim uses the code; a second is refused and the PC is told', () => {
  const p = new Pairing(clock().now);
  const code = p.start();
  const { claim, claimSecret } = claimWith(p, hex(code.secret));
  assertEquals(claim.state, 'pending');
  const e = refused(() => claimWith(p, code.words.join(' '), 'Other'));
  assertEquals([e.status, e.code], [409, 'already_used']);
  assert(p.code!.anotherTried, 'the PC shows "Another device tried this code"');
  assertEquals(p.pending().map((x) => x.name), ['Pixel 9'], 'the second device made no claim');
  assertEquals(p.status(claim.id, 'wrong secret'), null, 'only the claimant can read its claim');
  assertEquals(p.status(claim.id, claimSecret)!.state, 'pending');
});

Deno.test(`pairing: the code dies after ${MAX_WRONG} wrong tries (the 4th try, even right, is refused)`, () => {
  const p = new Pairing(clock().now);
  const code = p.start();
  const wrong = WORDS.slice(0, 6).join(' ') === code.words.join(' ') ? WORDS.slice(6, 12).join(' ') : WORDS.slice(0, 6).join(' ');
  for (let i = 0; i < MAX_WRONG; i++) assertEquals(refused(() => claimWith(p, wrong)).code, 'wrong_code');
  const e = refused(() => claimWith(p, code.words.join(' ')));
  assertEquals([e.status, e.code], [410, 'expired']);
  assertEquals(p.open(), null);
});

Deno.test('pairing: a global limit on claims (all Serve traffic is 127.0.0.1)', () => {
  const c = clock();
  const p = new Pairing(c.now);
  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) {
    p.start();
    try {
      claimWith(p, 'amber amber amber amber amber amber');
    } catch (error) {
      if ((error as PairingError).code === 'too_many') limited = true;
    }
  }
  assert(limited, 'limited within a minute');
  c.t += 61;
  const code = p.start();
  assertEquals(claimWith(p, code.words.join(' ')).claim.state, 'pending', 'allowed again a minute later');
});

Deno.test('pairing: check words come from the secret and both nonces; reject and approve', () => {
  const p = new Pairing(clock().now);
  const code = p.start();
  const phoneNonce = nonce();
  const { claim, claimSecret } = p.claim({ code: hex(code.secret), name: 'Pixel', login: LOGIN, phoneNonce });
  assertEquals(claim.checkWords, checkWords(code.secret, phoneNonce, claim.pcNonce));
  assert(claim.checkWords.every((w) => WORDS.includes(w)));
  assertEquals(p.reject(claim.id)!.state, 'rejected');
  assertEquals(p.status(claim.id, claimSecret)!.state, 'rejected');
  assertEquals(p.get(claim.id), null, 'a rejected claim is gone once the phone has read it');
  const code2 = p.start();
  const second = claimWith(p, hex(code2.secret));
  p.approve(second.claim.id, { token: 't', cookie: 'c', device: { id: 'd', name: 'Pixel 9', scopes: ['phone.read'] } });
  assertEquals(p.status(second.claim.id, second.claimSecret)!.handover!.token, 't');
  assertEquals(p.status(second.claim.id, second.claimSecret), null, 'the token is handed over once');
  assertThrows(() => p.approve(second.claim.id, { token: 't', cookie: 'c', device: { id: 'd', name: '', scopes: [] } }));
});

Deno.test('devices.json keeps hashes only; tokens and cookies find their phone; last seen is written at most every 5 minutes', async () => {
  const dir = await tempDir('aib-devices-');
  try {
    const c = clock(10_000);
    const store = new DeviceStore(dir, c.now);
    const a = await store.add({ name: '  Pixel\u0007 9  ', login: LOGIN, scopes: ['phone.read', 'phone.answer', 'bogus' as never] });
    assertEquals(a.device.name, 'Pixel 9');
    assertEquals(a.device.scopes, ['phone.read', 'phone.answer']);
    const file = Deno.readTextFileSync(`${dir}${sep}devices.json`);
    assert(!file.includes(a.token) && !file.includes(a.cookie), 'no raw token or cookie on disk');
    assertEquals(store.byToken(a.token)?.id, a.device.id);
    assertEquals(store.byCookie(a.cookie)?.id, a.device.id);
    assertEquals(store.byToken(a.cookie), null, 'the cookie is not a token');
    assertEquals(store.byCookie(a.token), null, 'the token is not a cookie');
    c.t += 60;
    store.touch(a.device.id);
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(new DeviceStore(dir).list()[0].lastSeen, 10_000, 'not written a minute later');
    assertEquals(store.list()[0].lastSeen, 10_060, 'in memory at once');
    c.t += 300;
    store.touch(a.device.id);
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(new DeviceStore(dir).list()[0].lastSeen, 10_360, 'written after 5 minutes');
    assert(await store.remove(a.device.id));
    assertEquals(store.byToken(a.token), null);
    await store.add({ name: 'x', login: LOGIN, scopes: [] });
    await store.add({ name: 'y', login: LOGIN, scopes: [] });
    assertEquals(await store.removeAll(), 2);
    assertEquals(new DeviceStore(dir).list(), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('the phone activity log has no message text and rotates at its cap', async () => {
  const dir = await tempDir('aib-audit-');
  try {
    const audit = new Audit(dir, 400);
    for (let i = 0; i < 20; i++) audit.write({ device: 'd' + i, name: 'Pixel', action: 'pair', result: 'ok' });
    const files = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(files, ['remote-audit.1.jsonl', 'remote-audit.jsonl']);
    assert(Deno.statSync(`${dir}${sep}remote-audit.jsonl`).size <= 400 + 200);
    const tail = audit.tail(5);
    assertEquals(tail.length, 5);
    assertEquals(tail[0].device, 'd19', 'newest first');
    assertEquals(Object.keys(tail[0]).sort(), ['action', 'chat', 'device', 'name', 'result', 'time']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the phone port is chosen once from 8779 (skipping AIB's own ports) and then never changes", async () => {
  const dir = await tempDir('aib-rport-');
  try {
    const free = (p: number) => p !== 8779 && p !== 8781; // port-guard: not bound (a pure function decides "free")
    assertEquals(remotePort(dir, free, [8780]), 8782); // port-guard: not bound
    assertEquals(readRemotePort(dir), 8782); // port-guard: not bound
    assertEquals(remotePort(dir, () => false), 8782, 'saved: kept even when busy'); // port-guard: not bound
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a busy phone port is retried, then reported, never swapped for another', async () => {
  const held = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (held.addr as Deno.NetAddr).port;
  try {
    let tries = 0;
    const t0 = Date.now();
    const error = await bindWithRetry(port, (p) => {
      tries++;
      return Deno.listen({ hostname: '127.0.0.1', port: p });
    }, 1200).catch((e) => e);
    assert(error instanceof PortBusy, String(error));
    assertEquals((error as PortBusy).port, port);
    assert(tries >= 2 && Date.now() - t0 >= 1000, `retried (${tries} tries)`);
  } finally {
    held.close();
  }
});

Deno.test('Tailscale: name without the trailing dot, login, HTTPS, serve target and Funnel', async () => {
  assertEquals(cleanName('Studio-PC.tail-a1b2.ts.net.'), 'studio-pc.tail-a1b2.ts.net');
  const fake = fakeTailscale({ serve: serveStatus(4567) });
  const ts = await readTailscale(4567, fake.runner);
  assertEquals([ts.name, ts.machine, ts.tailnet, ts.login, ts.https, ts.serving, ts.funnel], [
    NAME,
    'studio-pc',
    'tail-a1b2.ts.net',
    LOGIN,
    true,
    true,
    false,
  ]);
  assertEquals(fake.calls, [['status', '--json'], ['serve', 'status', '--json']], 'reads only, never changes');
  assertEquals(readServe(serveStatus(4567, true), NAME, 4567).funnel, true);
  assertEquals(readServe(serveStatus(9999), NAME, 4567), { serving: false, servingOther: 'http://127.0.0.1:9999', funnel: false });
  assertEquals((await readTailscale(1, fakeTailscale({ status: null }).runner)).problem, 'not_installed');
  const out = await readTailscale(1, fakeTailscale({ status: tailscaleStatus({ BackendState: 'NeedsLogin', Self: {} }) }).runner);
  assertEquals([out.signedIn, out.problem], [false, 'signed_out']);
  const noCert = await readTailscale(1, fakeTailscale({ status: tailscaleStatus({ CertDomains: [] }) }).runner);
  assertEquals(noCert.https, false);
});

Deno.test('Tailscale: a warning line before the JSON (client and daemon versions differ) is skipped', async () => {
  const runner = (args: string[]) =>
    Promise.resolve({
      code: 0,
      stdout: 'Warning: client version "1.80.0" != tailscaled server version "1.78.1"\n' +
        JSON.stringify(args[0] === 'status' ? tailscaleStatus() : serveStatus(4567)),
    });
  const ts = await readTailscale(4567, runner);
  assertEquals([ts.signedIn, ts.name, ts.serving], [true, NAME, true]);
});
