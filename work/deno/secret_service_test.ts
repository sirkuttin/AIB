/**
 * Linux Secret Service for secrets at rest (server/state/secret_service.ts), with an in-memory `secret-tool` so it runs on any OS
 * and never touches a real keyring. The real thing (gnome-keyring over D-Bus) is exercised by tools/secret-service-e2e.sh (WSL Ubuntu).
 */
import { assert, assertEquals } from './_assert.ts';
import { join, tempDir, withEnv } from './_agents.ts';
import { SettingsStore } from '../../app/server/state/settings.ts';
import { FILE_MARK, KEY_FILE, keyStoreFor } from '../../app/server/state/secrets.ts';
import {
  isMarker,
  secretServiceAvailable,
  setToolRunner,
  type ToolResult,
  useSecretService,
} from '../../app/server/state/secret_service.ts';
import { openText, sealText } from '../../app/server/state/sealed.ts';
import { PeerStore } from '../../app/server/pcsync/peers.ts';

const KEY = 'test-key-not-real-5f2a9c';
const TOKEN = 'peer-token-not-real-0123456789abcdef';

/** An in-memory secret-tool: store / lookup / clear on the service + account attributes. */
function fakeKeyring(options: { refuseStore?: boolean; down?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: string[][] = [];
  const attr = (args: string[]) => {
    const i = args.indexOf('service');
    return `${args[i + 1]}\u0000${args[args.indexOf('account') + 1]}`;
  };
  const run = (args: string[], input?: string): ToolResult => {
    calls.push(args);
    if (options.down) return { ok: false, stdout: '', stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' };
    const quiet = (ok: boolean, stdout = ''): ToolResult => ({ ok, stdout, stderr: '' });
    switch (args[0]) {
      case 'store':
        if (options.refuseStore) return { ok: false, stdout: '', stderr: 'denied' };
        items.set(attr(args), input ?? '');
        return quiet(true);
      case 'lookup': {
        const v = items.get(attr(args));
        return v === undefined ? quiet(false) : quiet(true, v);
      }
      case 'clear':
        items.delete(attr(args));
        return quiet(true);
    }
    return quiet(false);
  };
  return { items, calls, run };
}

const text = (path: string) => Deno.readTextFileSync(path);
const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};
const secretsIn = (values: Iterable<string>) => [...values];

Deno.test('probe: a quiet failed lookup means a service answers; a noisy one means none', () => {
  const up = fakeKeyring();
  setToolRunner(up.run);
  assert(secretServiceAvailable());
  const down = fakeKeyring({ down: true });
  setToolRunner(down.run);
  assert(!secretServiceAvailable());
  setToolRunner(null);
});

Deno.test('useSecretService follows AIB_KEY_STORE and the probe', () => {
  const restore = withEnv({ AIB_KEY_STORE: 'file' });
  try {
    setToolRunner(fakeKeyring().run);
    assert(!useSecretService(), 'file forced');
    Deno.env.delete('AIB_KEY_STORE');
    assert(useSecretService(), 'a service answers');
    setToolRunner(fakeKeyring({ down: true }).run);
    assert(!useSecretService(), 'no service: the file');
  } finally {
    restore();
    setToolRunner(null);
  }
});

Deno.test('an API key goes to the Secret Service, the settings and the disk hold only a marker, and the key reads back', async () => {
  using dir = tempDir();
  const ring = fakeKeyring();
  setToolRunner(ring.run);
  const restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
  try {
    const store = new SettingsStore(dir.root);
    assertEquals(store.keyStorage().kind, 'secret-service');
    await store.update({ agents: { enabled: { gemini: true }, betaKey: { gemini: KEY } } });
    assert(secretsIn(ring.items.values()).includes(KEY));
    const settings = text(join(dir.root, 'studio-settings.json'));
    assert(!settings.includes(KEY), 'the key is in the settings file');
    assertEquals(JSON.parse(settings).agents.betaKeys.gemini, 'secret-service:v1');
    assert(!exists(join(dir.root, KEY_FILE)), 'no 0600 file when the service holds the key');
    assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY);
    await store.update({ agents: { betaKey: { gemini: null } } });
    assertEquals(ring.items.size, 0, 'the key leaves the service when it is removed');
  } finally {
    restore();
    setToolRunner(null);
  }
});

Deno.test('a key left in beta-keys.json moves into the service on first read, and the file is deleted', async () => {
  using dir = tempDir();
  // An older run with no keyring: the key is in the 0600 file.
  let restore = withEnv({ AIB_KEY_STORE: 'file' });
  try {
    await new SettingsStore(dir.root).update({ agents: { enabled: { gemini: true }, betaKey: { gemini: KEY } } });
  } finally {
    restore();
  }
  assert(exists(join(dir.root, KEY_FILE)));
  // Now a keyring answers.
  const ring = fakeKeyring();
  setToolRunner(ring.run);
  restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
  try {
    const store = new SettingsStore(dir.root);
    assertEquals(store.betaKey('gemini'), KEY, 'usable at once');
    await store.keysSealed();
    assert(secretsIn(ring.items.values()).includes(KEY), 'in the service now');
    assert(!exists(join(dir.root, KEY_FILE)), 'beta-keys.json deleted after the move');
    assertEquals(JSON.parse(text(join(dir.root, 'studio-settings.json'))).agents.betaKeys.gemini, 'secret-service:v1');
    assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY);
  } finally {
    restore();
    setToolRunner(null);
  }
});

Deno.test('a service that refuses the key loses nothing: the key stays in the 0600 file', async () => {
  using dir = tempDir();
  let restore = withEnv({ AIB_KEY_STORE: 'file' });
  try {
    await new SettingsStore(dir.root).update({ agents: { enabled: { gemini: true }, betaKey: { gemini: KEY } } });
  } finally {
    restore();
  }
  const ring = fakeKeyring({ refuseStore: true });
  setToolRunner(ring.run);
  restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
  try {
    const store = new SettingsStore(dir.root);
    await store.keysSealed();
    assertEquals(store.betaKey('gemini'), KEY);
    assertEquals(JSON.parse(text(join(dir.root, KEY_FILE))).keys.gemini, KEY, 'the file still has it');
    assertEquals(JSON.parse(text(join(dir.root, 'studio-settings.json'))).agents.betaKeys.gemini, FILE_MARK);
    assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY);
    // A key typed now while the service refuses also lands in the file.
    await store.update({ agents: { betaKey: { gemini: KEY + '2' } } });
    assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY + '2');
  } finally {
    restore();
    setToolRunner(null);
  }
});

Deno.test('no secret value ever appears in a secret-tool argument list', async () => {
  using dir = tempDir();
  const ring = fakeKeyring();
  setToolRunner(ring.run);
  const restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
  try {
    await new SettingsStore(dir.root).update({ agents: { enabled: { gemini: true }, betaKey: { gemini: KEY } } });
    sealText('pcsync-peer-token', TOKEN);
    for (const args of ring.calls) assert(!args.join(' ').includes(KEY) && !args.join(' ').includes(TOKEN), args[0]);
  } finally {
    restore();
    setToolRunner(null);
  }
});

Deno.test('sync peer tokens: sealed into the service, read back, migrated from plain, forgotten on removal', () => {
  using dir = tempDir();
  const ring = fakeKeyring();
  setToolRunner(ring.run);
  const restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
  try {
    const marker = sealText('pcsync-peer-token', TOKEN);
    assert(isMarker(marker), marker);
    assertEquals(openText('pcsync-peer-token', marker), TOKEN);

    const peers = new PeerStore(dir.root);
    const peer = peers.add({ name: 'laptop', host: 'laptop.ts.net', login: 'me', inToken: 'in-' + TOKEN, outToken: TOKEN });
    assert(isMarker(peer.out));
    assert(!text(peers.path).includes(TOKEN), 'the token is in peers.json');
    const again = new PeerStore(dir.root);
    assertEquals(again.outToken([...again.peers.values()][0]), TOKEN);
    const before = ring.items.size;
    again.remove(peer.id);
    assertEquals(ring.items.size, before - 1, 'the entry leaves the service with the peer');

    // A plain token from an older AIB moves in on load.
    const plain = JSON.parse(text(peers.path));
    plain.peers = [{ ...peer, id: 'old1', out: TOKEN }];
    Deno.writeTextFileSync(peers.path, JSON.stringify(plain));
    const moved = new PeerStore(dir.root);
    assert(isMarker([...moved.peers.values()][0].out));
    assert(!text(peers.path).includes(TOKEN), 'still plain on disk after the load');
    assertEquals(moved.outToken([...moved.peers.values()][0]), TOKEN);
  } finally {
    restore();
    setToolRunner(null);
  }
});

Deno.test('a refusing service leaves a peer token plain, as before', () => {
  setToolRunner(fakeKeyring({ refuseStore: true }).run);
  const restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
  try {
    assertEquals(sealText('pcsync-peer-token', TOKEN), TOKEN);
  } finally {
    restore();
    setToolRunner(null);
  }
});

Deno.test('keyStoreFor under the test suite never picks the service unasked', () => {
  const restore = withEnv({ AIB_KEY_STORE: '' });
  Deno.env.delete('AIB_KEY_STORE');
  try {
    Deno.env.set('AGENT_STUDIO_TEST', '1');
    const kind = keyStoreFor('x').kind;
    assert(kind === 'file' || kind === 'dpapi', kind);
  } finally {
    restore();
  }
});
