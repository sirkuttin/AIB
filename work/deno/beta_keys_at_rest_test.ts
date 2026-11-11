/**
 * Beta agents' API keys at rest (server/state/secrets.ts, settings.ts): never plain text in studio-settings.json, sealed with
 * DPAPI on Windows (or kept in an owner-only beta-keys.json where there is no keyring), plain keys from an older AIB sealed on
 * load, and never in what the page gets. The macOS Keychain and the Linux Secret Service are not exercised here (the suite
 * never touches a real keyring); their fallback file is.
 */
import { assert, assertEquals } from './_assert.ts';
import { join, tempDir, withEnv } from './_agents.ts';
import { SettingsStore } from '../../outputs/agent-studio/server/state/settings.ts';
import {
  DPAPI_PREFIX,
  dpapiProtect,
  dpapiUnprotect,
  FILE_MARK,
  isSealed,
  KEY_FILE,
  keyStoreFor,
} from '../../outputs/agent-studio/server/state/secrets.ts';
import { describeBeta } from '../../outputs/agent-studio/server/web/shared.ts';

const KEY = 'test-key-not-real-5f2a9c'; // a made-up value: never a real key
const settingsText = (root: string) => Deno.readTextFileSync(join(root, 'studio-settings.json'));
const storedKey = (root: string) => JSON.parse(settingsText(root)).agents?.betaKeys?.gemini as string | undefined;
const WINDOWS = Deno.build.os === 'windows';

Deno.test({
  name: 'Windows: DPAPI round-trips bytes for this user and refuses a damaged blob',
  ignore: !WINDOWS,
  fn() {
    const sealed = dpapiProtect(new TextEncoder().encode(KEY));
    assert(!new TextDecoder().decode(sealed).includes(KEY));
    assertEquals(new TextDecoder().decode(dpapiUnprotect(sealed)!), KEY);
    sealed[sealed.length - 5] ^= 0xff;
    assertEquals(dpapiUnprotect(sealed), null);
  },
});

Deno.test('a saved key is sealed in the settings file, reads back, and never reaches the page', async () => {
  using dir = tempDir();
  const store = new SettingsStore(dir.root);
  await store.update({ agents: { enabled: { gemini: true }, betaKey: { gemini: KEY } } });
  assertEquals(store.betaKey('gemini'), KEY);
  const text = settingsText(dir.root);
  assert(!text.includes(KEY), 'the settings file holds the plain key');
  const stored = storedKey(dir.root)!;
  assert(isSealed(stored), stored);
  if (WINDOWS) assert(stored.startsWith(DPAPI_PREFIX), stored);
  const again = new SettingsStore(dir.root);
  assertEquals(again.betaKey('gemini'), KEY);
  assert(!JSON.stringify(again.public()).includes(KEY));
  const rows = await describeBeta({ stateDir: dir.root }, again.snapshot());
  const info = rows.find((r) => r.id === 'gemini')!.betaInfo as Record<string, unknown>;
  assertEquals(info.keySet, true);
  assertEquals(info.keyStorage, keyStoreFor(dir.root).note);
  assert(!JSON.stringify(rows).includes(KEY));
  // Saving another setting keeps the same sealed form (no rewrite of the key on every save).
  await again.update({ server: { autoReconnect: false } });
  assertEquals(storedKey(dir.root), stored);
  await again.update({ agents: { betaKey: { gemini: null } } });
  assertEquals([again.betaKey('gemini'), storedKey(dir.root)], ['', undefined]);
});

Deno.test('a plain key left by an older AIB is sealed as soon as the settings are read', async () => {
  using dir = tempDir();
  Deno.writeTextFileSync(
    join(dir.root, 'studio-settings.json'),
    JSON.stringify({ version: 1, agents: { beta: { gemini: true }, betaKeys: { gemini: KEY } } }),
  );
  const store = new SettingsStore(dir.root);
  assertEquals(store.betaKey('gemini'), KEY); // usable at once
  await store.keysSealed();
  assert(!settingsText(dir.root).includes(KEY), 'still plain after the load');
  assert(isSealed(storedKey(dir.root)!));
  assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY);
});

Deno.test('a sealed key this account cannot open is dropped, not passed on', () => {
  using dir = tempDir();
  const bad = WINDOWS ? DPAPI_PREFIX + btoa('not a dpapi blob') : FILE_MARK; // file:v1 with no beta-keys.json
  Deno.writeTextFileSync(
    join(dir.root, 'studio-settings.json'),
    JSON.stringify({ version: 1, agents: { betaKeys: { gemini: bad } } }),
  );
  assertEquals(new SettingsStore(dir.root).betaKey('gemini'), '');
});

Deno.test('no keyring: the key goes to an owner-only beta-keys.json, and Settings says so', async () => {
  using dir = tempDir();
  const restore = withEnv({ AIB_KEY_STORE: 'file' });
  try {
    const store = new SettingsStore(dir.root);
    assertEquals(store.keyStorage().kind, 'file');
    assert(/beta-keys\.json/.test(store.keyStorage().note) && /not encrypted/.test(store.keyStorage().note));
    await store.update({ agents: { betaKey: { gemini: KEY } } });
    assertEquals(storedKey(dir.root), FILE_MARK);
    assert(!settingsText(dir.root).includes(KEY));
    const file = join(dir.root, KEY_FILE);
    assertEquals(JSON.parse(Deno.readTextFileSync(file)).keys.gemini, KEY);
    if (!WINDOWS) assertEquals(Deno.statSync(file).mode! & 0o777, 0o600);
    assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY);
    await store.update({ agents: { betaKey: { gemini: null } } });
    let gone = false;
    try {
      Deno.statSync(file);
    } catch {
      gone = true;
    }
    assert(gone, 'beta-keys.json stays after the last key was removed');
  } finally {
    restore();
  }
});
