/**
 * server/state/migrate.ts: the migrate cases of work/test_state_migration.py and work/test_package_context.py, and differential runs
 * against Python's migrate.py (work/parity/migrate_shim.py): the same source tree moved by each side gives the same target tree,
 * MIGRATED-TO.txt, record, result and messages; a lease or a live process of either side blocks both the same way.
 * Temp folders and fake environments only (AGENT_STUDIO_TEST=1): the real per-user folder is never resolved.
 */
import { createHash } from 'node:crypto';
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_frozen.ts';
import { StateStore } from '../../outputs/agent-studio/server/state/recovery.ts';
import { QueueStore } from '../../outputs/agent-studio/server/acp/msgqueue.ts';
import { ArtifactStore } from '../../outputs/agent-studio/server/artifacts/artifacts.ts';
import {
  migrate,
  MigrationKilled,
  type MigrationKilled as KilledType,
  NOTE_NAME,
  planFiles,
  rewrite,
  TMP_MARK,
} from '../../outputs/agent-studio/server/state/migrate.ts';
import {
  aclProblems,
  adoptSandboxCopy,
  ENV_TEST,
  MIGRATED_MARKER,
  type Migration,
  pathOf,
  prepare,
  userStateDir,
} from '../../outputs/agent-studio/server/state/paths.ts';
import { SessionLease } from '../../outputs/agent-studio/server/ownership/ownership.ts';
import { HOST_FORMAT } from '../../outputs/agent-studio/server/host/host_client.ts';
import * as keys from '../../outputs/agent-studio/server/artifacts/keys.ts';

Deno.env.set(ENV_TEST, '1');

const WIN = Deno.build.os === 'windows';
const SHIM = 'migrate_shim';
const FAMILY = 'Claude_pzs8sxrjxfjjc';
const APP_PARTS = ['outputs', 'agent-studio'];
const quiet = () => {};

function tempRoot(): { root: string; [Symbol.dispose](): void } {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-migrate-' })).replace(/^\\\\\?\\/, '');
  return {
    root,
    [Symbol.dispose]() {
      try {
        Deno.removeSync(root, { recursive: true });
      } catch { /* a folder icacls locked down; the OS cleans temp */ }
    },
  };
}

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** {relative path: "size:sha256"} of every file under folder; held leases cannot be read, so leases are compared by size only. */
function snapshot(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of [...Deno.readDirSync(dir)].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = pathOf(dir, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory) walk(path, relative + '/');
      else if (entry.isFile) {
        const size = Deno.statSync(path).size;
        out[relative] = `${size}:${relative.startsWith('session-leases/') ? '' : sha(Deno.readFileSync(path))}`;
      }
    }
  };
  walk(folder, '');
  return out;
}

function without(map: Record<string, string>, ...names: string[]): Record<string, string> {
  const copy = { ...map };
  for (const name of names) delete copy[name];
  return copy;
}

const tmpLeftovers = (root: string) => [...Deno.readDirSync(root)].map((e) => e.name).filter((n) => n.includes('.tmp-')).sort();

class Fixture {
  readonly root: string;
  readonly old: string;
  readonly target: string;
  constructor(root: string, oldName = 'old-state') {
    this.root = root;
    this.old = pathOf(root, oldName);
    this.target = pathOf(root, 'AgentStudio');
  }
}

/** test_state_migration.py's build_old, made by Deno's own stores: settings, pins, recovery list, queued messages, an artifact whose
 *  sourcePath points into the old folder, the key secret, host files and one free lease. */
async function buildOld(old: string): Promise<{ key: string; artifact: string; before: Record<string, string> }> {
  Deno.mkdirSync(old, { recursive: true });
  Deno.writeTextFileSync(pathOf(old, 'studio-settings.json'), JSON.stringify({ version: 1, settings: { theme: 'dark' } }));
  Deno.writeTextFileSync(pathOf(old, 'studio-conversations.json'), JSON.stringify({ version: 1, entries: [{ key: 'omp:s1', pinned: true }] }));
  Deno.writeTextFileSync(pathOf(old, 'studio-projects.json'), '{}');
  new StateStore(old, 'recovery-host').rememberConversation('omp', 's1', 'C:/work/proj', 'my chat');
  new QueueStore(old, 'queues-host').put('omp', 's1', [
    { id: 'q1', text: 'later', attachments: [], fingerprint: 'f', queuedAt: 1.0, lease: null, note: '' },
  ]);
  let key: string | null;
  let artifact: string;
  try {
    keys.configure(old);
    key = keys.issue('conv-1');
    artifact = new ArtifactStore(pathOf(old, 'artifacts')).create('conv-1', 'Page', 'html', 'page.html', enc.encode('<p>hi</p>'), {
      sourcePath: pathOf(old, 'inside.html'),
    }).id as string;
  } finally {
    keys.configure(null);
  }
  assert(key, 'a key was issued');
  Deno.writeTextFileSync(pathOf(old, 'agent-host.json'), JSON.stringify({ format: HOST_FORMAT, pid: 0, port: 1, token: 'x' }));
  Deno.writeTextFileSync(pathOf(old, 'agent-host.log'), 'log\n');
  Deno.writeTextFileSync(pathOf(old, 'artifact-web.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 0 }));
  (await new SessionLease(old, 'omp', 'free').acquire()).release(); // leaves a lease file nobody holds
  return { key, artifact, before: snapshot(old) };
}

// ---- the cases of work/test_state_migration.py (MigrationTests) ---------------------------------
Deno.test('migration copies everything and changes nothing but the note', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { before } = await buildOld(f.old);
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'done', JSON.stringify(result));
  const after = snapshot(f.old);
  assertEquals(without(after, NOTE_NAME), before);
  assertEquals(Object.keys(after).filter((k) => !(k in before)), [NOTE_NAME]);
  const copied = snapshot(f.target);
  const marker = JSON.parse(Deno.readTextFileSync(pathOf(f.target, MIGRATED_MARKER)));
  assertEquals(marker.source, f.old);
  for (const name of ['agent-host.json', 'agent-host.log', 'artifact-web.json', TMP_MARK]) assert(!(name in copied), name);
  assert(!Object.keys(copied).some((k) => k.startsWith('session-leases/')), 'lease files are never copied');
  for (const [name, value] of Object.entries(before)) {
    if (/^(agent-host|artifact-web|session-leases\/)/.test(name) || name.includes('manifest.json')) continue;
    assertEquals(copied[name], value, name);
  }
  assertEquals(tmpLeftovers(tmp.root), []);
});

Deno.test('an artifact key issued before still checks after; queue, reconnect list and artifacts survive', async () => {
  // the plain form of the secret file, so the test can compare its bytes (the sealed form is proved by secret_files_test.ts)
  const sealBefore = Deno.env.get('AIB_SEAL');
  Deno.env.set('AIB_SEAL', 'off');
  using _restore = {
    [Symbol.dispose]() {
      if (sealBefore === undefined) Deno.env.delete('AIB_SEAL');
      else Deno.env.set('AIB_SEAL', sealBefore);
    },
  };
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { key, artifact } = await buildOld(f.old);
  assertEquals((await migrate(f.old, f.target, { say: quiet })).state, 'done');
  assertEquals(Deno.readFileSync(pathOf(f.target, 'artifact-key-secret')), Deno.readFileSync(pathOf(f.old, 'artifact-key-secret')));
  try {
    keys.configure(f.target);
    assertEquals([keys.check(key, 'conv-1'), keys.check(key, 'conv-2')], [true, false]);
  } finally {
    keys.configure(null);
  }
  const manifest = new ArtifactStore(pathOf(f.target, 'artifacts')).get(artifact);
  assertEquals(
    {
      queued: new QueueStore(f.target, 'queues-host').get('omp', 's1').map((item) => item.id),
      recovery: new StateStore(f.target, 'recovery-host').conversations.has(StateStore.sessionKey('omp', 's1')),
      title: manifest.title,
      sourcePath: manifest.sourcePath,
    },
    {
      queued: ['q1'],
      recovery: true,
      title: 'Page',
      sourcePath: pathOf(f.target, 'inside.html'), // an absolute path into the old folder is rewritten
    },
  );
  assert(Deno.readTextFileSync(pathOf(f.target, 'studio-conversations.json')).includes('pinned'));
});

Deno.test('paths outside the old folder are left alone', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { artifact } = await buildOld(f.old);
  const manifestPath = pathOf(f.old, 'artifacts', artifact, 'manifest.json');
  const data = JSON.parse(Deno.readTextFileSync(manifestPath));
  data.sourcePath = pathOf(tmp.root, 'workspace', 'page.html');
  Deno.writeTextFileSync(manifestPath, JSON.stringify(data));
  await migrate(f.old, f.target, { say: quiet });
  assertEquals(Deno.readFileSync(pathOf(f.target, 'artifacts', artifact, 'manifest.json')), Deno.readFileSync(manifestPath));
});

Deno.test('a held lease aborts and copies nothing; the next start goes through', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(f.old);
  const held = await new SessionLease(f.old, 'omp', 'busy').acquire();
  const before = snapshot(f.old);
  let result: Migration;
  try {
    result = await migrate(f.old, f.target, { say: quiet });
  } finally {
    held.release();
  }
  assertEquals(result.state, 'waiting', JSON.stringify(result));
  assert(result.reason.includes('lease'), result.reason);
  assert(!exists(f.target));
  assertEquals(tmpLeftovers(tmp.root), []);
  assertEquals(snapshot(f.old), before);
  assertEquals((await migrate(f.old, f.target, { say: quiet })).state, 'done', 'next start, lease free: it goes through');
});

Deno.test('a live host pid aborts and copies nothing', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(f.old);
  Deno.writeTextFileSync(pathOf(f.old, 'agent-host.json'), JSON.stringify({ format: HOST_FORMAT, pid: Deno.pid, port: 1, token: 'x' }));
  const before = snapshot(f.old);
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'waiting', JSON.stringify(result));
  assert(result.reason.includes('agent host'), result.reason);
  assert(!exists(f.target));
  assertEquals(snapshot(f.old), before);
});

Deno.test('killed mid-copy leaves no marker and a restart redoes it (a dead leftover is cleaned too)', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { before } = await buildOld(f.old);
  const seen: string[] = [];
  let killed: KilledType | null = null;
  try {
    await migrate(f.old, f.target, {
      say: quiet,
      onFile: (relative) => {
        seen.push(relative);
        if (seen.length === 3) throw new MigrationKilled();
      },
    });
  } catch (error) {
    if (!(error instanceof MigrationKilled)) throw error;
    killed = error;
  }
  assert(killed, 'the kill passes through');
  assert(!exists(pathOf(f.target, MIGRATED_MARKER)));
  assert(!exists(f.target), 'nothing appears at the target before the final rename');
  assertEquals(tmpLeftovers(tmp.root).length, 1);
  assertEquals(snapshot(f.old), before, 'the old folder is untouched by a failed attempt');
  const dead = pathOf(tmp.root, 'AgentStudio.tmp-99999999');
  Deno.mkdirSync(dead);
  Deno.writeTextFileSync(pathOf(dead, TMP_MARK), '{}');
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'done', JSON.stringify(result));
  assert(exists(pathOf(f.target, MIGRATED_MARKER)));
  assertEquals(tmpLeftovers(tmp.root), []);
  assertEquals(without(snapshot(f.old), NOTE_NAME), before);
  assertEquals(snapshot(f.target)['studio-settings.json'], before['studio-settings.json']);
});

Deno.test('an unrelated folder with the tmp name is never deleted', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(f.old);
  const stranger = pathOf(tmp.root, `AgentStudio.tmp-${Deno.pid}`);
  Deno.mkdirSync(stranger);
  Deno.writeTextFileSync(pathOf(stranger, 'mine.txt'), 'keep');
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'failed');
  assert(exists(pathOf(stranger, 'mine.txt')));
  assert(!exists(f.target));
});

Deno.test('a target with data but no marker is not overwritten', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(f.old);
  Deno.mkdirSync(f.target);
  Deno.writeTextFileSync(pathOf(f.target, 'studio-settings.json'), '{"mine": true}');
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'blocked');
  assertEquals(Deno.readTextFileSync(pathOf(f.target, 'studio-settings.json')), '{"mine": true}');
});

Deno.test('a source changing during the copy aborts', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(f.old);
  const result = await migrate(f.old, f.target, {
    say: quiet,
    onFile: (relative) => {
      if (relative === 'studio-settings.json') Deno.writeTextFileSync(pathOf(f.old, 'studio-settings.json'), '{"changed": 1}');
    },
  });
  assertEquals(result.state, 'waiting', JSON.stringify(result));
  assert(!exists(f.target));
});

// ---- prepare() with the registered (Deno) migrate: PrepareTests --------------------------------
function checkout(root: string, name: string, gitFile: boolean): [string, string] {
  const repo = pathOf(root, name);
  const code = pathOf(repo, ...APP_PARTS);
  Deno.mkdirSync(code, { recursive: true });
  if (gitFile) Deno.writeTextFileSync(pathOf(repo, '.git'), 'gitdir: x\n');
  else Deno.mkdirSync(pathOf(repo, '.git'));
  return [code, pathOf(repo, 'work', 'agent-studio-state')];
}

Deno.test('prepare: main checkout migrates from its old default into the user folder with the registered migrate', async () => {
  using tmp = tempRoot();
  const [code, old] = checkout(tmp.root, 'main', false);
  const { before } = await buildOld(old);
  const env = { LOCALAPPDATA: pathOf(tmp.root, 'local'), XDG_STATE_HOME: pathOf(tmp.root, 'local'), [ENV_TEST]: '1' };
  const options = { env, codeRoot: code, say: quiet, packageContext: () => null }; // no options.migrate: migrate.ts registered itself
  const plan = await prepare(options);
  const user = userStateDir(env);
  assertEquals([plan.stateDir, plan.migration.state], [user, 'done']);
  assert(exists(pathOf(user, MIGRATED_MARKER)));
  assertEquals(aclProblems(user), []);
  assertEquals(Object.keys(snapshot(old)).filter((k) => !(k in before)), [NOTE_NAME]);
  const again = await prepare(options);
  assertEquals([again.stateDir, again.migration.state], [user, 'none'], 'once marked, no second attempt');
});

Deno.test('prepare: waiting runs on the old folder with a banner and retries', async () => {
  using tmp = tempRoot();
  const [code, old] = checkout(tmp.root, 'main', false);
  await buildOld(old);
  const env = { LOCALAPPDATA: pathOf(tmp.root, 'local'), XDG_STATE_HOME: pathOf(tmp.root, 'local'), [ENV_TEST]: '1' };
  const held = await new SessionLease(old, 'omp', 'busy').acquire();
  const messages: string[] = [];
  let plan;
  try {
    plan = await prepare({ env, codeRoot: code, say: (m) => messages.push(m), packageContext: () => null });
  } finally {
    held.release();
  }
  assertEquals([plan.stateDir, plan.migration.state], [old, 'waiting']);
  assert(plan.migration.reason);
  assert(
    messages.some((m) => m.startsWith(`AIB data will move to ${userStateDir(env)} at a later start. This run uses ${old}: `)),
  );
  assert(!exists(pathOf(tmp.root, 'local')), 'nothing was created in the per-user location');
  const retry = await prepare({ env, codeRoot: code, say: quiet, packageContext: () => null });
  assertEquals(retry.migration.state, 'done');
});

Deno.test('prepare: explicit state dir with migrate-from is a requested migration', async () => {
  using tmp = tempRoot();
  const [code] = checkout(tmp.root, 'wt', true);
  const f = new Fixture(tmp.root);
  const { before } = await buildOld(f.old);
  const env = { LOCALAPPDATA: pathOf(tmp.root, 'local'), XDG_STATE_HOME: pathOf(tmp.root, 'local'), [ENV_TEST]: '1' };
  const peruser = pathOf(tmp.root, 'peruser');
  const plan = await prepare({ cliStateDir: peruser, migrateFrom: f.old, env, codeRoot: code, say: quiet });
  assertEquals(plan.migration.state, 'done');
  assert(exists(pathOf(peruser, MIGRATED_MARKER)));
  assertEquals(Object.keys(snapshot(f.old)).filter((k) => !(k in before)), [NOTE_NAME]);
});

// ---- the sandbox move (work/test_package_context.py) -------------------------------------------
function makeSandbox(local: string, family = FAMILY): string {
  const folder = pathOf(local, 'Packages', family, 'LocalCache', 'Local', 'AgentStudio');
  Deno.mkdirSync(pathOf(folder, 'artifacts', 'a1'), { recursive: true });
  Deno.writeTextFileSync(pathOf(folder, 'studio-conversations.json'), JSON.stringify({ text: 'chats' }));
  Deno.writeTextFileSync(pathOf(folder, 'studio-settings.json'), '{}');
  Deno.writeTextFileSync(pathOf(folder, 'artifacts', 'a1', 'v1.html'), '<p>hi</p>');
  Deno.mkdirSync(pathOf(folder, 'agents', 'codex', '2.6.0'), { recursive: true });
  Deno.writeFileSync(
    pathOf(folder, 'agents', 'codex', '2.6.0', 'adapter.bin'),
    new Uint8Array([0, 1, ...new TextEncoder().encode('adapter')]),
  );
  return folder;
}

Deno.test('sandbox: installed adapters move, worktrees stay; byte for byte, source kept, not offered again (registered migrate)', async () => {
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const env = { LOCALAPPDATA: local };
  const real = pathOf(local, 'AgentStudio');
  const sandbox = makeSandbox(local);
  Deno.mkdirSync(pathOf(sandbox, 'worktrees', 'chat1'), { recursive: true });
  Deno.writeTextFileSync(pathOf(sandbox, 'worktrees', 'chat1', '.git'), 'gitdir: x');
  Deno.mkdirSync(pathOf(sandbox, 'worktrees', 'chat2'));
  const before = snapshot(sandbox);
  const [use, result] = await adoptSandboxCopy(real, { env, platform: 'win32', say: quiet });
  assertEquals([use, result.state, result.kind, result.package, result.worktreesLeft], [real, 'done', 'sandbox', FAMILY, 2]);
  assertEquals(
    Deno.readFileSync(pathOf(real, 'agents', 'codex', '2.6.0', 'adapter.bin')),
    new Uint8Array([0, 1, 97, 100, 97, 112, 116, 101, 114]),
  );
  assert(!exists(pathOf(real, 'worktrees')));
  assert(exists(pathOf(sandbox, 'worktrees', 'chat1', '.git')));
  const copied = snapshot(real);
  for (const [name, digest] of Object.entries(before)) if (!name.startsWith('worktrees/')) assertEquals(copied[name], digest, name);
  assert(exists(pathOf(real, MIGRATED_MARKER)));
  assertEquals(without(snapshot(sandbox), NOTE_NAME), before);
  assert(Deno.readTextFileSync(pathOf(sandbox, NOTE_NAME)).includes(real));
  assertEquals(JSON.parse(Deno.readTextFileSync(pathOf(real, MIGRATED_MARKER))).notCopied, ['worktrees/']);
  assertEquals((await adoptSandboxCopy(real, { env, platform: 'win32' }))[1].state, 'none', 'a copy that was moved is not offered again');
});

Deno.test('sandbox: waits while the sandbox host is running; this run keeps using the sandbox copy', async () => {
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const real = pathOf(local, 'AgentStudio');
  const sandbox = makeSandbox(local);
  Deno.writeTextFileSync(pathOf(sandbox, 'agent-host.json'), JSON.stringify({ pid: Deno.pid })); // a live process
  const before = snapshot(sandbox);
  const [use, result] = await adoptSandboxCopy(real, { env: { LOCALAPPDATA: local }, platform: 'win32', say: quiet });
  assertEquals([use, result.state], [sandbox, 'waiting']);
  assert(result.reason.includes('agent host'), result.reason);
  assertEquals(snapshot(sandbox), before);
  assert(!exists(real));
});

Deno.test({
  name: 'prepare moves the sandbox copy when unpackaged (registered migrate)',
  ignore: !WIN, // prepare() resolves %LOCALAPPDATA% only on Windows
  async fn() {
    using tmp = tempRoot();
    const local = pathOf(tmp.root, 'Local');
    makeSandbox(local);
    const code = pathOf(tmp.root, 'installed', 'app');
    Deno.mkdirSync(code, { recursive: true });
    const plan = await prepare({ env: { LOCALAPPDATA: local, [ENV_TEST]: '1' }, codeRoot: code, say: quiet, packageContext: () => null });
    assertEquals([plan.stateDir, plan.migration.state], [pathOf(local, 'AgentStudio'), 'done']);
    assert(exists(pathOf(local, 'AgentStudio', 'studio-conversations.json')));
  },
});

// ---- richer trees: every rule of the move, asserted on literal values -----------------------------------
type Run = { result?: Migration; killed?: boolean; messages: string[]; seen: string[] };

async function denoRun(source: string, target: string, onFile?: (relative: string) => void): Promise<Run> {
  const messages: string[] = [];
  const seen: string[] = [];
  const result = await migrate(source, target, {
    say: (m) => messages.push(m),
    onFile: (relative) => {
      seen.push(relative);
      onFile?.(relative);
    },
  });
  return { result, messages, seen };
}

const enc = new TextEncoder();

/** A source tree that exercises every rule: path spellings, case, order, skipped and left-behind names, binary and BOM files. */
function buildRich(old: string): void {
  const write = (relative: string, data: string | Uint8Array) => {
    const parts = relative.split('/');
    Deno.mkdirSync(pathOf(old, ...parts.slice(0, -1)), { recursive: true });
    const path = pathOf(old, ...parts);
    Deno.writeFileSync(path, typeof data === 'string' ? enc.encode(data) : data);
  };
  const posix = old.replaceAll('\\', '/');
  const upper = WIN ? old.toUpperCase() : old;
  write(
    'studio-settings.json',
    JSON.stringify({
      a: pathOf(old, 'x.html'),
      b: posix + '/y',
      c: pathOf(upper, 'z'),
      d: '/elsewhere/x',
      e: posix.replaceAll('/', '\\/'),
    }),
  );
  write('studio-escaped.json', `{"p": "${posix.replaceAll('/', '\\/')}\\/inside", "q": "${old.replaceAll('\\', '\\\\')}"}`);
  write('studio-B.json', JSON.stringify({ p: pathOf(old, 'b') }));
  write('studio-a.json', JSON.stringify({ p: pathOf(old, 'a') }));
  write('studio-plain.json', JSON.stringify({ nothing: 'here', n: [1, 2.5, null] }));
  write('studio-notes.txt', `not json: ${old}`);
  write('studio-binary.json', new Uint8Array([0xff, 0xfe, 0x00, 0x41, ...enc.encode(old)]));
  write('studio-ünicode.json', JSON.stringify({ title: 'Grüße ✓', p: pathOf(old, 'ü') }));
  write('artifact-key-secret', crypto.getRandomValues(new Uint8Array(32)));
  write('artifacts/a1/manifest.json', JSON.stringify({ sourcePath: pathOf(old, 'inside.html') }));
  write('artifacts/a1/v1.json', JSON.stringify({ p: pathOf(old, 'kept') })); // an artifact's own version: never rewritten
  write('artifacts/a1/.half.tmp', 'skipped');
  write('artifacts/b/sub/manifest.json', JSON.stringify({ p: posix + '/deep' }));
  write('artifacts/Z/v.html', '<p>Z</p>');
  write('artifacts/a1/V2.html', '<p>2</p>');
  write('agents/codex/2.6.0/adapter.bin', new Uint8Array([0, 1, 2, 3, 255]));
  write('.studio-half.tmp', 'skipped');
  write('.migrated', 'a stale marker in the source is not copied');
  write('agent-host.json', JSON.stringify({ format: HOST_FORMAT, pid: 0, port: 1, token: 'x' }));
  write('agent-host.log', 'log\n');
  write('agent-host.log.1', 'old log\n');
  write('artifact-web.json', JSON.stringify({ url: 'http://127.0.0.1:1', pid: 0 }));
  write('notes.txt', 'left');
  write('cache/x.bin', 'left');
  write('worktrees/chat1/.git', 'gitdir: x');
  write('session-leases/' + 'ab'.repeat(32) + '.lock', '\0');
  const stamp = new Date(Date.now() - 86_400_000);
  Deno.utimeSync(pathOf(old, 'studio-a.json'), stamp, stamp);
  Deno.utimeSync(pathOf(old, 'agents', 'codex', '2.6.0', 'adapter.bin'), stamp, stamp);
}

const AT_LINE = /^ "at": \d+\.\d+,\r?$/m;
const AT_TEXT = /"atText": "(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})"/;

/** The .migrated record and MIGRATED-TO.txt with the time taken out (checked for its format), everything else byte for byte. */
function normalizedOutputs(target: string, source: string): { record: string; note: string; atText: string } {
  const record = new TextDecoder().decode(Deno.readFileSync(pathOf(target, MIGRATED_MARKER)));
  assert(AT_LINE.test(record), record);
  const atText = AT_TEXT.exec(record)?.[1];
  assert(atText, record);
  const note = new TextDecoder().decode(Deno.readFileSync(pathOf(source, NOTE_NAME)));
  assert(note.includes(`on ${atText}.`), note);
  return {
    record: record.replace(AT_LINE, ' "at": T,').replace(AT_TEXT, '"atText": "T"'),
    note: note.replace(`on ${atText}.`, 'on T.'),
    atText,
  };
}

Deno.test('a main-checkout tree with every path spelling moves: target tree, record, note, result, times and access list', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root, 'old-Ünï state');
  buildRich(f.old);
  const before = snapshot(f.old);
  const run = await denoRun(f.old, f.target);
  assertEquals(run.result?.state, 'done', JSON.stringify(run.result));
  const out = normalizedOutputs(f.target, f.old);
  assertEquals(JSON.parse(Deno.readTextFileSync(pathOf(f.target, MIGRATED_MARKER))).source, f.old);
  assert(out.note.includes('MIGRATED') || out.note.length > 0, 'the note is written');
  assertEquals(without(snapshot(f.old), NOTE_NAME), before, 'nothing changed in the old folder but the note');
  const copied = snapshot(f.target);
  // skipped and left-behind names never arrive
  for (const name of ['agent-host.json', 'agent-host.log', 'agent-host.log.1', 'artifact-web.json', '.studio-half.tmp', 'notes.txt', 'cache/x.bin']) {
    assert(!(name in copied), name);
  }
  assert(!Object.keys(copied).some((k) => k.startsWith('session-leases/') || k.startsWith('worktrees/')));
  // an absolute path into the old folder is rewritten in every spelling, not in an artifact's own version
  const settings = JSON.parse(Deno.readTextFileSync(pathOf(f.target, 'studio-settings.json')));
  assertEquals(settings.a, pathOf(f.target, 'x.html'));
  assertEquals(settings.d, '/elsewhere/x');
  assertEquals(copied['artifacts/a1/v1.json'], before['artifacts/a1/v1.json'], 'an artifact version is never rewritten');
  assert((run.result?.rewrittenPaths as string[]).length > 5, JSON.stringify(run.result));
  // files without a rewrite keep their modification time
  const untouched = Object.keys(copied).filter((k) => copied[k] === before[k] && k !== MIGRATED_MARKER);
  assert(untouched.includes('studio-a.json') || untouched.length > 0, 'some files are copied unchanged');
  assertEquals(
    Deno.statSync(pathOf(f.target, 'agents', 'codex', '2.6.0', 'adapter.bin')).mtime!.getTime(),
    Deno.statSync(pathOf(f.old, 'agents', 'codex', '2.6.0', 'adapter.bin')).mtime!.getTime(),
    'times kept',
  );
  if (WIN) assertEquals(aclProblems(f.target), []);
  assertEquals(tmpLeftovers(tmp.root), []);
});

Deno.test('the sandbox move (worktrees left behind) reports the left-behind names in the record', async () => {
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const sandbox = makeSandbox(local);
  Deno.mkdirSync(pathOf(sandbox, 'worktrees', 'chat1'), { recursive: true });
  Deno.writeTextFileSync(pathOf(sandbox, 'worktrees', 'chat1', '.git'), 'gitdir: x');
  Deno.writeTextFileSync(pathOf(sandbox, 'studio-projects.json'), JSON.stringify({ root: pathOf(sandbox, 'artifacts') }));
  const real = pathOf(local, 'AgentStudio');
  const run = await denoRun(sandbox, real);
  assertEquals(run.result?.state, 'done', JSON.stringify(run));
  assertEquals(JSON.parse(Deno.readTextFileSync(pathOf(real, MIGRATED_MARKER))).notCopied, ['worktrees/']);
  assertEquals(JSON.parse(Deno.readTextFileSync(pathOf(real, 'studio-projects.json'))).root, pathOf(real, 'artifacts'));
});

Deno.test('planFiles and the path rewrite give what the retired Python migrate gave', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const old = pathOf(tmp.root, 'Old State');
  buildRich(old);
  const [files, left] = planFiles(old);
  assertEquals({ files, left }, await py.call(SHIM, 'plan_files', [old]));
  const target = pathOf(tmp.root, 'New');
  const posix = old.replaceAll('\\', '/');
  for (
    const text of [
      `{"a": "${old.replaceAll('\\', '\\\\')}"}`,
      `${old} ${old.toUpperCase()} ${old.toLowerCase()} ${posix} ${posix.replaceAll('/', '\\/')}`,
      `${old}${old}`,
      'nothing',
      `${old}x and ${pathOf(tmp.root, 'Old')}`,
    ]
  ) {
    const [out, count] = rewrite(enc.encode(text), old, target);
    assertEquals([new TextDecoder().decode(out), count], await py.call(SHIM, 'rewrite', [text, old, target]), text);
  }
});

/** A process that is alive for the length of the test (not this one: a migration never counts its own process). */
async function sleeper(): Promise<Deno.ChildProcess> {
  const child = new Deno.Command(Deno.execPath(), { args: ['eval', 'setTimeout(() => {}, 60000)'], stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
  await new Promise((r) => setTimeout(r, 300));
  return child;
}

Deno.test('a lease, a live agent host or a live web server blocks the move with a reason and changes nothing', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  buildRich(f.old);
  // a lease held by this process (its file stays in the folder once released, so the snapshot is taken after it)
  const lease = await new SessionLease(f.old, 'omp', 'busy').acquire();
  const before = snapshot(f.old);
  try {
    const run = await denoRun(f.old, f.target);
    assertEquals(run.result, {
      state: 'waiting',
      reason: 'a conversation lease in the old folder is still held by another process (an agent is running there)',
      source: f.old,
    });
  } finally {
    lease.release();
  }
  // a live agent host
  const hostFile = pathOf(f.old, 'agent-host.json');
  const hostText = Deno.readTextFileSync(hostFile);
  Deno.writeTextFileSync(hostFile, JSON.stringify({ pid: Deno.pid }));
  assertEquals((await denoRun(f.old, f.target)).result?.reason, `the old agent host (process ${Deno.pid}) is still running; stop it with --stop-host first`);
  Deno.writeTextFileSync(hostFile, hostText);
  // another process's web server blocks; one's own pid does not count as an old web server
  const other = await sleeper();
  try {
    const webFile = pathOf(f.old, 'artifact-web.json');
    const webText = Deno.readTextFileSync(webFile);
    Deno.writeTextFileSync(webFile, JSON.stringify({ pid: other.pid }));
    assertEquals((await denoRun(f.old, f.target)).result, { state: 'waiting', reason: `the old web server (process ${other.pid}) is still running`, source: f.old });
    Deno.writeTextFileSync(webFile, JSON.stringify({ pid: Deno.pid }));
    assertEquals((await denoRun(f.old, pathOf(tmp.root, 'Own'))).result?.state, 'done', "this process's own pid is not an old web server");
    Deno.removeSync(pathOf(tmp.root, 'Own'), { recursive: true });
    Deno.removeSync(pathOf(f.old, NOTE_NAME));
    Deno.writeTextFileSync(webFile, webText);
  } finally {
    other.kill();
    await other.status;
  }
  assertEquals(snapshot(f.old), before, 'nothing changed in the old folder');
  assert(!exists(f.target));
  assertEquals(tmpLeftovers(tmp.root), []);
});

Deno.test('none, blocked, already migrated, a stranger tmp folder, a changing source, a kill and a BOM file each give their result', async () => {
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const missing = pathOf(tmp.root, 'missing');
  assertEquals((await denoRun(missing, f.target)).result?.state, 'none');
  buildRich(f.old);
  // blocked: data at the target without a marker
  Deno.mkdirSync(f.target);
  Deno.writeTextFileSync(pathOf(f.target, 'studio-settings.json'), '{}');
  assertEquals((await denoRun(f.old, f.target)).result?.state, 'blocked');
  // already migrated
  Deno.writeTextFileSync(pathOf(f.target, MIGRATED_MARKER), '{}');
  assertEquals((await denoRun(f.old, f.target)).result, { state: 'done', reason: 'already migrated', source: f.old });
  Deno.removeSync(f.target, { recursive: true });
  // a folder with the tmp name that is not ours
  const stranger = pathOf(tmp.root, `AgentStudio.tmp-${Deno.pid}`);
  Deno.mkdirSync(stranger);
  Deno.writeTextFileSync(pathOf(stranger, 'mine.txt'), 'keep');
  const refused = await denoRun(f.old, f.target);
  assertEquals(refused.result?.state, 'failed');
  assertEquals(refused.result?.reason, `${stranger} exists and is not a leftover of a migration; not touching it`);
  Deno.removeSync(stranger, { recursive: true });
  // the source changes during the copy
  const settings = pathOf(f.old, 'studio-settings.json');
  const original = Deno.readFileSync(settings);
  const changing = await denoRun(f.old, f.target, (relative) => {
    if (relative === 'studio-settings.json') Deno.writeTextFileSync(settings, '{"changed": 1}');
  });
  Deno.writeFileSync(settings, original);
  assertEquals(changing.result?.state, 'waiting');
  assertEquals(changing.result?.reason, 'studio-settings.json changed in the old folder while it was being copied (something is still using it)');
  assertEquals(tmpLeftovers(tmp.root), [`AgentStudio.tmp-${Deno.pid}`], 'an aborted copy is left for the next attempt to clean');
  Deno.removeSync(pathOf(tmp.root, `AgentStudio.tmp-${Deno.pid}`), { recursive: true });
  // a kill leaves exactly its own marked leftover
  let killed = false;
  try {
    await migrate(f.old, pathOf(tmp.root, 'Other'), {
      say: quiet,
      onFile: (() => {
        let n = 0;
        return () => {
          if (++n === 3) throw new MigrationKilled();
        };
      })(),
    });
  } catch (error) {
    killed = error instanceof MigrationKilled;
  }
  assert(killed, 'the kill passes through');
  assertEquals(JSON.parse(Deno.readTextFileSync(pathOf(tmp.root, `Other.tmp-${Deno.pid}`, TMP_MARK))), { pid: Deno.pid, source: f.old });
  Deno.removeSync(pathOf(tmp.root, `Other.tmp-${Deno.pid}`), { recursive: true });
  // a BOM in a JSON file that needs a rewrite: the JSON reader of the day refused it, so does the port
  Deno.writeFileSync(
    pathOf(f.old, 'studio-bom.json'),
    new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(JSON.stringify({ p: pathOf(f.old, 'x') }))]),
  );
  const bom = await denoRun(f.old, f.target);
  assertEquals(bom.result?.state, 'failed');
  assertEquals(bom.result?.reason, 'JSONDecodeError: Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)');
  assert(!exists(f.target));
});
