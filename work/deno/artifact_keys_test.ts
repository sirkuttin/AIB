/**
 * server/artifacts/keys.ts: the artifact_keys cases of work/test_state_migration.py, test_auth_gate.py and test_log_setup.py, and
 * interop with Python both ways (the two servers share the state folder, so a key issued by either must check in the other).
 */
import { assert, assertEquals } from './_assert.ts';
import { check, configure, issue, SECRET_FILE, secretOfFile } from '../../app/server/artifacts/keys.ts';
import { join } from '../../app/server/platform/path.ts';
import { sealingOn } from '../../app/server/state/sealed.ts';

/** The Python interop cases share the plain file format; the retired Python server cannot open a DPAPI-sealed secret. */
function plainSecrets(): { [Symbol.dispose](): void } {
  const before = Deno.env.get('AIB_SEAL');
  Deno.env.set('AIB_SEAL', 'off');
  return {
    [Symbol.dispose]() {
      if (before === undefined) Deno.env.delete('AIB_SEAL');
      else Deno.env.set('AIB_SEAL', before);
    },
  };
}

const CONVERSATIONS = ['conv-1', 'omp:s1', 'claude:7f3c-é😀', 'x'.repeat(500), '0'];

function temp(): { dir: string; [Symbol.dispose](): void } {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-keys-' });
  return {
    dir,
    [Symbol.dispose]() {
      configure(null);
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

async function hmacHex(secret: Uint8Array<ArrayBuffer>, conversation: string): Promise<string> {
  const keyObject = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new TextEncoder().encode('studio-artifact-key/v1\0' + conversation);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', keyObject, message))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test('no state folder: no key, and nothing checks', () => {
  configure(null);
  assertEquals(configure(null), false);
  assertEquals(issue('conv-1'), null);
  assertEquals(check('a'.repeat(64), 'conv-1'), false);
});

Deno.test('a key is HMAC-SHA256 of the conversation with the secret file, and only checks for that conversation', async () => {
  using tmp = temp();
  const state = join(tmp.dir, 'state', 'nested');
  assertEquals(configure(state), true, 'the folder is created');
  const raw = Deno.readFileSync(join(state, SECRET_FILE));
  const secret = secretOfFile(raw) as Uint8Array<ArrayBuffer>;
  assertEquals(secret.length, 32);
  // security item 7: on Windows the file holds the secret sealed with DPAPI, never the 32 bytes themselves
  if (sealingOn()) assert(new TextDecoder().decode(raw).startsWith('dpapi:v1:') && raw.length > 32, 'sealed on Windows');
  if (Deno.build.os !== 'windows') assertEquals(Deno.statSync(join(state, SECRET_FILE)).mode! & 0o777, 0o600);
  const key = issue('conv-1')!;
  assert(/^[0-9a-f]{64}$/.test(key), key);
  assertEquals(key, await hmacHex(secret, 'conv-1'));
  assertEquals(issue('conv-1'), key, 'stable');
  assertEquals(issue(''), null);
  assertEquals(check(key, 'conv-1'), true);
  for (
    const [k, c] of [[key, 'conv-2'], [key + 'x', 'conv-1'], [key.toUpperCase(), 'conv-1'], ['', 'conv-1'], [key, ''], [null, 'conv-1'], [
      42,
      'conv-1',
    ]]
  ) {
    assertEquals(check(k, c), false, `${k} ${c}`);
  }
  assertEquals(configure(state), true, 'configuring again is fine');
  assertEquals(issue('conv-1'), key);
  configure(null);
  assertEquals(check(key, 'conv-1'), false);
});

Deno.test('a key issued before a move still checks after the secret file was copied', () => {
  using tmp = temp();
  const old = join(tmp.dir, 'old');
  const target = join(tmp.dir, 'target');
  configure(old);
  const key = issue('conv-1');
  Deno.mkdirSync(target);
  Deno.copyFileSync(join(old, SECRET_FILE), join(target, SECRET_FILE));
  configure(target);
  assertEquals(check(key, 'conv-1'), true);
  assertEquals(check(key, 'conv-2'), false);
  configure(join(tmp.dir, 'other'));
  assertEquals(check(key, 'conv-1'), false, 'another folder means another secret');
});

Deno.test('a secret file that never reaches 32 bytes means no keys', () => {
  using _plain = plainSecrets();
  using tmp = temp();
  Deno.writeFileSync(join(tmp.dir, SECRET_FILE), new Uint8Array(5));
  assertEquals(configure(tmp.dir), false);
  assertEquals(issue('conv-1'), null);
  configure(null);
});

Deno.test('the plain secret file is 32 random bytes and keys are the HMAC every other program computes from it', async () => {
  // The formula is the contract with any other reader of the file (the retired Python server computed the same): HMAC-SHA256 of the
  // conversation id, hex, with the 32 raw bytes of artifact-key-secret.
  using _plain = plainSecrets();
  using tmp = temp();
  assertEquals(configure(tmp.dir), true);
  const secret = Deno.readFileSync(join(tmp.dir, SECRET_FILE)) as Uint8Array<ArrayBuffer>;
  assertEquals(secret.length, 32);
  for (const conversation of CONVERSATIONS) {
    const mine = issue(conversation);
    assertEquals(mine, await hmacHex(secret, conversation), conversation);
    assertEquals(check(mine, conversation), true);
    assertEquals(check(mine, conversation + '!'), false);
  }
  const theirs = await hmacHex(secret, 'omp:s1'); // a key another program made from the same file
  assertEquals(check(theirs, 'omp:s1'), true);
  assertEquals(check(theirs, 'omp:s2'), false);
  assertEquals(Deno.readFileSync(join(tmp.dir, SECRET_FILE)), secret, 'issuing and checking never rewrite the secret');
  configure(null);
});

Deno.test('migration: a plain secret from an older AIB is sealed in place on Windows, and its keys keep checking', async () => {
  using tmp = temp();
  const plain = crypto.getRandomValues(new Uint8Array(32));
  Deno.writeFileSync(join(tmp.dir, SECRET_FILE), plain);
  assertEquals(configure(tmp.dir), true);
  const key = issue('conv-1')!;
  assertEquals(key, await hmacHex(plain, 'conv-1'), 'the same secret: keys issued before the update still check');
  const after = Deno.readFileSync(join(tmp.dir, SECRET_FILE));
  if (sealingOn()) {
    assert(new TextDecoder().decode(after).startsWith('dpapi:v1:'), 'sealed in place');
    assert(!after.some((_, i) => plain.every((b, j) => after[i + j] === b)), 'the plain bytes are gone from the file');
  } else assertEquals(after, plain, 'no DPAPI here: unchanged');
  assertEquals(secretOfFile(after), plain);
  configure(null);
  assertEquals(configure(tmp.dir), true, 'the sealed file opens on the next start');
  assertEquals(issue('conv-1'), key);
});

Deno.test('a sealed secret that cannot be opened (another Windows account) gives no keys and is never replaced', () => {
  if (!sealingOn()) return;
  using tmp = temp();
  const damaged = 'dpapi:v1:' + btoa('not a DPAPI blob at all, long enough');
  Deno.writeTextFileSync(join(tmp.dir, SECRET_FILE), damaged);
  assertEquals(configure(tmp.dir), false);
  assertEquals(issue('conv-1'), null);
  assertEquals(Deno.readTextFileSync(join(tmp.dir, SECRET_FILE)), damaged);
});
