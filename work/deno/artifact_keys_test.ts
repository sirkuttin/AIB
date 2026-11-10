/**
 * server/artifacts/keys.ts: the artifact_keys cases of work/test_state_migration.py, test_auth_gate.py and test_log_setup.py, and
 * interop with Python both ways (the two servers share the state folder, so a key issued by either must check in the other).
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { check, configure, issue, SECRET_FILE } from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { join } from '../../outputs/agent-studio/server/platform/path.ts';

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
  const secret = Deno.readFileSync(join(state, SECRET_FILE));
  assertEquals(secret.length, 32);
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

Deno.test('a secret file that never reaches 32 bytes means no keys, as in Python', async () => {
  await using py = new PyParity();
  using tmp = temp();
  Deno.writeFileSync(join(tmp.dir, SECRET_FILE), new Uint8Array(5));
  assertEquals(configure(tmp.dir), false);
  assertEquals(issue('conv-1'), null);
  assertEquals(await py.call('artifact_keys', 'configure', [tmp.dir]), false);
  await py.call('artifact_keys', 'configure', [null]);
});

Deno.test('interop: a secret made by Python, keys issued by either side check in the other', async () => {
  await using py = new PyParity();
  using tmp = temp();
  assertEquals(await py.call('artifact_keys', 'configure', [tmp.dir]), true);
  assertEquals(configure(tmp.dir), true);
  for (const conversation of CONVERSATIONS) {
    const mine = issue(conversation);
    assertEquals(mine, await py.call('artifact_keys', 'issue', [conversation]), conversation);
    assertEquals(await py.call('artifact_keys', 'check', [mine, conversation]), true);
    assertEquals(await py.call('artifact_keys', 'check', [mine, conversation + '!']), false);
  }
  const theirs = await py.call('artifact_keys', 'issue', ['omp:s1']);
  assertEquals(check(theirs, 'omp:s1'), true);
  assertEquals(check(theirs, 'omp:s2'), false);
  await py.call('artifact_keys', 'configure', [null]);
});

Deno.test('interop: a secret made by Deno is read by Python', async () => {
  await using py = new PyParity();
  using tmp = temp();
  assertEquals(configure(tmp.dir), true);
  const secret = Deno.readFileSync(join(tmp.dir, SECRET_FILE));
  assertEquals(await py.call('artifact_keys', 'configure', [tmp.dir]), true);
  for (const conversation of CONVERSATIONS) {
    assertEquals(await py.call('artifact_keys', 'issue', [conversation]), issue(conversation), conversation);
  }
  assertEquals(await py.call('artifact_keys', 'check', [issue('conv-1'), 'conv-1']), true);
  assertEquals(Deno.readFileSync(join(tmp.dir, SECRET_FILE)), secret, 'Python did not rewrite the secret');
  await py.call('artifact_keys', 'configure', [null]);
});
