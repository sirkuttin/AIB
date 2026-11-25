/**
 * End to end against a real Secret Service (gnome-keyring over D-Bus) on Linux. Skipped everywhere else, and on a Linux box with no
 * running service. Run headless with, in WSL or a container:
 *
 *   dbus-run-session -- bash -c 'echo "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null; deno test -A <this file>'
 *
 * Every entry uses a throwaway service name (AIB_KEYRING_SERVICE_SUFFIX) and is cleared at the end: the owner's entries are never
 * touched. Data folders are temporary.
 */
import { assert, assertEquals } from './_assert.ts';
import { join, tempDir, withEnv } from './_agents.ts';
import { SettingsStore } from '../../app/server/state/settings.ts';
import { KEY_FILE } from '../../app/server/state/secrets.ts';
import { secretServiceAvailable, setToolRunner, useSecretService } from '../../app/server/state/secret_service.ts';
import { VapidKeys } from '../../app/server/remote/push.ts';
import { AllowStore } from '../../app/server/allow/store.ts';

const SUFFIX = 'aib-test-' + crypto.randomUUID().slice(0, 8);
const KEY = 'test-key-not-real-e2e-77c1';
const LINUX = Deno.build.os === 'linux';

setToolRunner(null);
Deno.env.set('AIB_KEYRING_SERVICE_SUFFIX', SUFFIX);
const live = LINUX && secretServiceAvailable();

const text = (p: string) => Deno.readTextFileSync(p);
const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};
/** Every entry of this run's throwaway services, cleared. */
function cleanUp() {
  for (const service of ['AIB beta agent keys', 'AIB device keys']) {
    new Deno.Command('secret-tool', { args: ['clear', 'service', `${service} ${SUFFIX}`], stdout: 'null', stderr: 'null' }).outputSync();
  }
}

Deno.test({
  name: 'real keyring: an API key is stored, read back by a new process state, and migrates from beta-keys.json',
  ignore: !live,
  async fn() {
    try {
      using dir = tempDir();
      let restore = withEnv({ AIB_KEY_STORE: 'file' });
      try {
        await new SettingsStore(dir.root).update({ agents: { enabled: { gemini: true }, betaKey: { gemini: KEY } } });
      } finally {
        restore();
      }
      assert(exists(join(dir.root, KEY_FILE)), 'the old 0600 file exists first');
      restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
      try {
        const store = new SettingsStore(dir.root);
        await store.keysSealed();
        assertEquals(store.betaKey('gemini'), KEY);
        assert(!exists(join(dir.root, KEY_FILE)), 'the file is gone after the move');
        const all = [KEY_FILE, 'studio-settings.json'].map((f) => join(dir.root, f)).filter(exists).map(text).join('\n');
        assert(!all.includes(KEY), 'the key is on disk');
        assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY, 'read back from the real keyring');
        const looked = new Deno.Command('secret-tool', {
          args: ['lookup', 'service', `AIB beta agent keys ${SUFFIX}`, 'account', `gemini@${await tag(dir.root)}`],
          stdout: 'piped',
        }).outputSync();
        assertEquals(new TextDecoder().decode(looked.stdout), KEY, 'the entry is really in the keyring');
      } finally {
        restore();
      }
    } finally {
      cleanUp();
    }
  },
});

async function tag(root: string): Promise<string> {
  const { folderTag } = await import('../../app/server/state/secrets.ts');
  return folderTag(root);
}

Deno.test({
  name: 'real keyring: the push private key and the allow-rules key live in the keyring; plain files migrate',
  ignore: !live,
  async fn() {
    const restore = withEnv({ AIB_KEY_STORE: 'secret-service' });
    try {
      using dir = tempDir();
      const keys = new VapidKeys(dir.root);
      const pub = await keys.publicKey();
      const file = JSON.parse(text(keys.path));
      assertEquals(file.store, 'secret-service');
      assert(String(file.privateKey).startsWith('secret-service:v1:'), 'the file holds a marker');
      assertEquals(await new VapidKeys(dir.root).publicKey(), pub, 'the same pair after a restart');

      // an older plain file moves in on read, and the pair stays the same
      using dirOld = tempDir();
      Deno.env.set('AIB_PUSH_KEY_STORE', 'file');
      const plainPair = new VapidKeys(dirOld.root);
      const plainPub = await plainPair.publicKey();
      Deno.env.delete('AIB_PUSH_KEY_STORE');
      assert(String(JSON.parse(text(plainPair.path)).privateKey).startsWith('file:v1:'), 'starts as a plain file');
      assertEquals(await new VapidKeys(dirOld.root).publicKey(), plainPub, 'usable at once');
      const moved = JSON.parse(text(plainPair.path));
      assertEquals(moved.store, 'secret-service');
      assert(String(moved.privateKey).startsWith('secret-service:v1:'), 'the private key left the file');
      assertEquals(await new VapidKeys(dirOld.root).publicKey(), plainPub, 'and opens from the keyring');

      const allow = new AllowStore(dir.root);
      allow.add({ kind: 'mcp', scope: 'global', server: 'x', tool: 'y', label: 'x · y', from: 'card' });
      const keyFile = text(join(dir.root, 'allow-rules.key')).trim();
      assert(keyFile.startsWith('secret-service:v1:'), keyFile);
      assert(!new AllowStore(dir.root).tampered, 'a restart opens the key from the keyring');
      // an older plain key file migrates and the rules stay valid
      using dir2 = tempDir();
      const a = new AllowStore(dir2.root);
      Deno.env.set('AIB_KEY_STORE', 'file');
      const b = new AllowStore(dir2.root);
      b.add({ kind: 'mcp', scope: 'global', server: 'x', tool: 'y', label: 'x · y', from: 'card' });
      assert(text(join(dir2.root, 'allow-rules.key')).startsWith('file:v1:'));
      Deno.env.set('AIB_KEY_STORE', 'secret-service');
      const c = new AllowStore(dir2.root);
      assert(!c.tampered && c.active()?.rules.length === 1);
      assert(text(join(dir2.root, 'allow-rules.key')).startsWith('secret-service:v1:'), 'the plain key file was replaced by a marker');
      assert(!new AllowStore(dir2.root).tampered);
      void a;
    } finally {
      restore();
      cleanUp();
    }
  },
});

Deno.test({
  name: 'no Secret Service running: keys stay in the 0600 file and nothing breaks',
  ignore: !LINUX,
  async fn() {
    const restore = withEnv({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/aib-test-bus' });
    Deno.env.delete('AIB_KEY_STORE');
    Deno.env.set('AGENT_STUDIO_TEST', '0'); // let the probe run: the suite's own test flag would skip it
    setToolRunner(null);
    try {
      assert(!secretServiceAvailable(), 'no bus, no service');
      assert(!useSecretService());
      using dir = tempDir();
      Deno.env.set('AGENT_STUDIO_TEST', '0');
      const store = new SettingsStore(dir.root);
      assertEquals(store.keyStorage().kind, 'file');
      await store.update({ agents: { enabled: { gemini: true }, betaKey: { gemini: KEY } } });
      assertEquals(JSON.parse(text(join(dir.root, KEY_FILE))).keys.gemini, KEY);
      assertEquals(Deno.statSync(join(dir.root, KEY_FILE)).mode! & 0o777, 0o600);
      assertEquals(new SettingsStore(dir.root).betaKey('gemini'), KEY);
    } finally {
      restore();
      setToolRunner(null);
    }
  },
});
