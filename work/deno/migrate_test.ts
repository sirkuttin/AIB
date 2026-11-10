/**
 * server/state/migrate.ts: the migrate cases of work/test_state_migration.py and work/test_package_context.py, and differential runs
 * against Python's migrate.py (work/parity/migrate_shim.py): the same source tree moved by each side gives the same target tree,
 * MIGRATED-TO.txt, record, result and messages; a lease or a live process of either side blocks both the same way.
 * Temp folders and fake environments only (AGENT_STUDIO_TEST=1): the real per-user folder is never resolved.
 */
import { createHash } from 'node:crypto';
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
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
import { windowsDacl } from '../../outputs/agent-studio/server/platform/acl.ts';

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

/** test_state_migration.py's build_old, made by Python's own stores. */
async function buildOld(py: PyParity, old: string): Promise<{ key: string; artifact: string; before: Record<string, string> }> {
  const made = await py.call(SHIM, 'build_old', [old]) as { key: string; artifact: string };
  return { ...made, before: snapshot(old) };
}

// ---- the cases of work/test_state_migration.py (MigrationTests) ---------------------------------
Deno.test('migration copies everything and changes nothing but the note', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { before } = await buildOld(py, f.old);
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

Deno.test('an artifact key issued before still checks after; queue, reconnect list and artifacts survive (read by both sides)', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { key, artifact } = await buildOld(py, f.old);
  assertEquals((await migrate(f.old, f.target, { say: quiet })).state, 'done');
  assertEquals(Deno.readFileSync(pathOf(f.target, 'artifact-key-secret')), Deno.readFileSync(pathOf(f.old, 'artifact-key-secret')));
  try {
    keys.configure(f.target);
    assertEquals([keys.check(key, 'conv-1'), keys.check(key, 'conv-2')], [true, false]);
  } finally {
    keys.configure(null);
  }
  assertEquals(await py.call(SHIM, 'read_moved', [f.target, key, artifact]), {
    keys: [true, false],
    queued: ['q1'],
    recovery: true,
    title: 'Page',
    sourcePath: pathOf(f.target, 'inside.html'), // an absolute path into the old folder is rewritten
  });
  assert(Deno.readTextFileSync(pathOf(f.target, 'studio-conversations.json')).includes('pinned'));
});

Deno.test('paths outside the old folder are left alone', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { artifact } = await buildOld(py, f.old);
  const manifestPath = pathOf(f.old, 'artifacts', artifact, 'manifest.json');
  const data = JSON.parse(Deno.readTextFileSync(manifestPath));
  data.sourcePath = pathOf(tmp.root, 'workspace', 'page.html');
  Deno.writeTextFileSync(manifestPath, JSON.stringify(data));
  await migrate(f.old, f.target, { say: quiet });
  assertEquals(Deno.readFileSync(pathOf(f.target, 'artifacts', artifact, 'manifest.json')), Deno.readFileSync(manifestPath));
});

Deno.test('a held lease aborts and copies nothing; the next start goes through', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(py, f.old);
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
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(py, f.old);
  Deno.writeTextFileSync(pathOf(f.old, 'agent-host.json'), JSON.stringify({ format: HOST_FORMAT, pid: Deno.pid, port: 1, token: 'x' }));
  const before = snapshot(f.old);
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'waiting', JSON.stringify(result));
  assert(result.reason.includes('agent host'), result.reason);
  assert(!exists(f.target));
  assertEquals(snapshot(f.old), before);
});

Deno.test('killed mid-copy leaves no marker and a restart redoes it (a dead leftover is cleaned too)', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const { before } = await buildOld(py, f.old);
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
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(py, f.old);
  const stranger = pathOf(tmp.root, `AgentStudio.tmp-${Deno.pid}`);
  Deno.mkdirSync(stranger);
  Deno.writeTextFileSync(pathOf(stranger, 'mine.txt'), 'keep');
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'failed');
  assert(exists(pathOf(stranger, 'mine.txt')));
  assert(!exists(f.target));
});

Deno.test('a target with data but no marker is not overwritten', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(py, f.old);
  Deno.mkdirSync(f.target);
  Deno.writeTextFileSync(pathOf(f.target, 'studio-settings.json'), '{"mine": true}');
  const result = await migrate(f.old, f.target, { say: quiet });
  assertEquals(result.state, 'blocked');
  assertEquals(Deno.readTextFileSync(pathOf(f.target, 'studio-settings.json')), '{"mine": true}');
});

Deno.test('a source changing during the copy aborts', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  await buildOld(py, f.old);
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
  await using py = new PyParity();
  using tmp = tempRoot();
  const [code, old] = checkout(tmp.root, 'main', false);
  const { before } = await buildOld(py, old);
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
  await using py = new PyParity();
  using tmp = tempRoot();
  const [code, old] = checkout(tmp.root, 'main', false);
  await buildOld(py, old);
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
    messages.some((m) => m.startsWith(`Agent Studio data will move to ${userStateDir(env)} at a later start. This run uses ${old}: `)),
  );
  assert(!exists(pathOf(tmp.root, 'local')), 'nothing was created in the per-user location');
  const retry = await prepare({ env, codeRoot: code, say: quiet, packageContext: () => null });
  assertEquals(retry.migration.state, 'done');
});

Deno.test('prepare: explicit state dir with migrate-from is a requested migration', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const [code] = checkout(tmp.root, 'wt', true);
  const f = new Fixture(tmp.root);
  const { before } = await buildOld(py, f.old);
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

// ---- differential: the same tree moved by Python and by Deno ------------------------------------
type PyRun = { result?: Migration; killed?: boolean; messages: string[]; seen: string[] };

function pyRun(py: PyParity, source: string, target: string, kwargs: Record<string, unknown> = {}): Promise<PyRun> {
  return py.call(SHIM, 'run', [source, target], kwargs) as Promise<PyRun>;
}

async function denoRun(source: string, target: string, onFile?: (relative: string) => void): Promise<PyRun> {
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

function mtimes(folder: string, snap: Record<string, string>): Record<string, number> {
  return Object.fromEntries(Object.keys(snap).map((k) => [k, Deno.statSync(pathOf(folder, ...k.split('/'))).mtime!.getTime()]));
}

/** Run Python then Deno on the same source and target paths (Python's result moved aside, the note removed in between). */
async function bothSides(py: PyParity, source: string, target: string, aside: string) {
  const sourceBefore = snapshot(source);
  const theirs = await pyRun(py, source, target);
  assertEquals(theirs.result?.state, 'done', JSON.stringify(theirs));
  const theirOut = normalizedOutputs(target, source);
  Deno.renameSync(target, aside);
  Deno.removeSync(pathOf(source, NOTE_NAME));
  assertEquals(snapshot(source), sourceBefore, 'Python changed nothing but the note');
  const mine = await denoRun(source, target);
  const myOut = normalizedOutputs(target, source);
  assertEquals(without(snapshot(source), NOTE_NAME), sourceBefore, 'Deno changed nothing but the note');
  return { theirs, mine, theirOut, myOut };
}

Deno.test('differential: a main-checkout tree moved by Python and by Deno gives the same target, record, note, result and messages', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root, 'old-Ünï state');
  buildRich(f.old);
  const aside = pathOf(tmp.root, 'python-result');
  const { theirs, mine, theirOut, myOut } = await bothSides(py, f.old, f.target, aside);
  assertEquals(mine, theirs);
  assertEquals(myOut.record, theirOut.record);
  assertEquals(myOut.note, theirOut.note);
  const mySnap = snapshot(f.target);
  const theirSnap = snapshot(aside);
  assertEquals(without(mySnap, MIGRATED_MARKER), without(theirSnap, MIGRATED_MARKER));
  assertEquals(mtimes(f.target, without(mySnap, MIGRATED_MARKER)), mtimes(aside, without(theirSnap, MIGRATED_MARKER)), 'times kept');
  assertEquals((mine.result?.rewrittenPaths as string[]).length > 5, true, JSON.stringify(mine.result));
  if (WIN) assertEquals(windowsDacl(f.target), windowsDacl(aside), 'the same owner-only access list');
  assertEquals(tmpLeftovers(tmp.root), []);
});

Deno.test('differential: the sandbox move (worktrees left behind) gives the same result on both sides', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const sandbox = makeSandbox(local);
  Deno.mkdirSync(pathOf(sandbox, 'worktrees', 'chat1'), { recursive: true });
  Deno.writeTextFileSync(pathOf(sandbox, 'worktrees', 'chat1', '.git'), 'gitdir: x');
  Deno.writeTextFileSync(pathOf(sandbox, 'studio-projects.json'), JSON.stringify({ root: pathOf(sandbox, 'artifacts') }));
  const real = pathOf(local, 'AgentStudio');
  const { theirs, mine, theirOut, myOut } = await bothSides(py, sandbox, real, pathOf(tmp.root, 'python-result'));
  assertEquals(mine, theirs);
  assertEquals(myOut.record, theirOut.record);
  assertEquals(myOut.note, theirOut.note);
  assertEquals(without(snapshot(real), MIGRATED_MARKER), without(snapshot(pathOf(tmp.root, 'python-result')), MIGRATED_MARKER));
  assertEquals(JSON.parse(Deno.readTextFileSync(pathOf(real, MIGRATED_MARKER))).notCopied, ['worktrees/']);
});

Deno.test('differential: planFiles and the path rewrite match Python', async () => {
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

Deno.test('differential: a lease or a live process of either side blocks both the same way', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  buildRich(f.old);
  const pyPid = await py.call(SHIM, 'pid') as number;
  // a lease held by the Python process
  const held = await py.call('ownership_shim', 'hold_lease', [f.old, 'omp', 'busy']) as { held: string };
  assert(held.held, JSON.stringify(held));
  const before = snapshot(f.old);
  try {
    const mine = await denoRun(f.old, f.target);
    const theirs = await pyRun(py, f.old, f.target);
    assertEquals(mine, theirs);
    assertEquals(mine.result?.state, 'waiting');
  } finally {
    await py.call('ownership_shim', 'release_leases');
  }
  // a lease held by this (Deno) process
  const lease = await new SessionLease(f.old, 'omp', 'busy').acquire();
  try {
    const theirs = await pyRun(py, f.old, f.target);
    assertEquals(theirs.result, {
      state: 'waiting',
      reason: 'a conversation lease in the old folder is still held by another process (an agent is running there)',
      source: f.old,
    });
  } finally {
    lease.release();
  }
  // a live agent host (this process) blocks both
  const hostFile = pathOf(f.old, 'agent-host.json');
  const hostText = Deno.readTextFileSync(hostFile);
  Deno.writeTextFileSync(hostFile, JSON.stringify({ pid: Deno.pid }));
  assertEquals(await denoRun(f.old, f.target), await pyRun(py, f.old, f.target));
  assertEquals(
    (await denoRun(f.old, f.target)).result?.reason,
    `the old agent host (process ${Deno.pid}) is still running; stop it with --stop-host first`,
  );
  Deno.writeTextFileSync(hostFile, hostText);
  // the other side's web server blocks; one's own pid does not count as an old web server
  const webFile = pathOf(f.old, 'artifact-web.json');
  const webText = Deno.readTextFileSync(webFile);
  Deno.writeTextFileSync(webFile, JSON.stringify({ pid: pyPid }));
  const mine = await denoRun(f.old, f.target);
  Deno.writeTextFileSync(webFile, JSON.stringify({ pid: Deno.pid }));
  const theirs = await pyRun(py, f.old, f.target);
  assertEquals(mine.result, { state: 'waiting', reason: `the old web server (process ${pyPid}) is still running`, source: f.old });
  assertEquals(theirs.result, { state: 'waiting', reason: `the old web server (process ${Deno.pid}) is still running`, source: f.old });
  Deno.writeTextFileSync(webFile, webText);
  assertEquals(snapshot(f.old), before, 'nothing changed in the old folder');
  assert(!exists(f.target));
  assertEquals(tmpLeftovers(tmp.root), []);
});

Deno.test('differential: none, blocked, already migrated, a stranger tmp folder, a changing source and a BOM file match Python', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const f = new Fixture(tmp.root);
  const missing = pathOf(tmp.root, 'missing');
  assertEquals(await denoRun(missing, f.target), await pyRun(py, missing, f.target));
  buildRich(f.old);
  // blocked: data at the target without a marker
  Deno.mkdirSync(f.target);
  Deno.writeTextFileSync(pathOf(f.target, 'studio-settings.json'), '{}');
  assertEquals(await denoRun(f.old, f.target), await pyRun(py, f.old, f.target));
  // already migrated
  Deno.writeTextFileSync(pathOf(f.target, MIGRATED_MARKER), '{}');
  const done = await denoRun(f.old, f.target);
  assertEquals(done, await pyRun(py, f.old, f.target));
  assertEquals(done.result, { state: 'done', reason: 'already migrated', source: f.old });
  Deno.removeSync(f.target, { recursive: true });
  // a folder with each side's tmp name that is not ours
  const pyPid = await py.call(SHIM, 'pid') as number;
  for (const pid of [pyPid, Deno.pid]) {
    Deno.mkdirSync(pathOf(tmp.root, `AgentStudio.tmp-${pid}`));
    Deno.writeTextFileSync(pathOf(tmp.root, `AgentStudio.tmp-${pid}`, 'mine.txt'), 'keep');
  }
  const mine = await denoRun(f.old, f.target);
  const theirs = await pyRun(py, f.old, f.target);
  assertEquals(
    mine.result?.reason,
    `${pathOf(tmp.root, `AgentStudio.tmp-${Deno.pid}`)} exists and is not a leftover of a migration; not touching it`,
  );
  assertEquals(
    theirs.result?.reason,
    `${pathOf(tmp.root, `AgentStudio.tmp-${pyPid}`)} exists and is not a leftover of a migration; not touching it`,
  );
  assertEquals([mine.result?.state, mine.messages, mine.seen], [theirs.result?.state, theirs.messages, theirs.seen]);
  for (const pid of [pyPid, Deno.pid]) Deno.removeSync(pathOf(tmp.root, `AgentStudio.tmp-${pid}`), { recursive: true });
  // the source changes during the copy
  const settings = pathOf(f.old, 'studio-settings.json');
  const original = Deno.readFileSync(settings);
  const changing = await denoRun(f.old, f.target, (relative) => {
    if (relative === 'studio-settings.json') Deno.writeTextFileSync(settings, '{"changed": 1}');
  });
  Deno.writeFileSync(settings, original);
  const theirsChanging = await pyRun(py, f.old, f.target, { touch: 'studio-settings.json', touch_text: '{"changed": 1}' });
  Deno.writeFileSync(settings, original);
  assertEquals(changing, theirsChanging);
  assertEquals(
    changing.result?.reason,
    'studio-settings.json changed in the old folder while it was being copied (something is still using it)',
  );
  const both = [`AgentStudio.tmp-${pyPid}`, `AgentStudio.tmp-${Deno.pid}`].sort();
  assertEquals(tmpLeftovers(tmp.root), both, 'an aborted copy is left for the next attempt to clean');
  // a kill: both leave exactly their own marked leftover, which the next run of either side cleans
  const killed = await pyRun(py, f.old, f.target, { kill_after: 3 });
  assertEquals(killed.killed, true);
  assertEquals(tmpLeftovers(tmp.root), both, "Python redid its own leftover and left Deno's (a live process) alone");
  const mark = JSON.parse(Deno.readTextFileSync(pathOf(tmp.root, `AgentStudio.tmp-${pyPid}`, TMP_MARK)));
  assertEquals(mark, { pid: pyPid, source: f.old });
  let mineKilled = false;
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
    mineKilled = error instanceof MigrationKilled;
  }
  assert(mineKilled, 'the kill passes through');
  const myMark = Deno.readTextFileSync(pathOf(tmp.root, `Other.tmp-${Deno.pid}`, TMP_MARK));
  assertEquals(
    myMark,
    Deno.readTextFileSync(pathOf(tmp.root, `AgentStudio.tmp-${pyPid}`, TMP_MARK)).replace(String(pyPid), String(Deno.pid)),
  );
  Deno.removeSync(pathOf(tmp.root, `Other.tmp-${Deno.pid}`), { recursive: true });
  Deno.removeSync(pathOf(tmp.root, `AgentStudio.tmp-${pyPid}`), { recursive: true });
  // a BOM in a JSON file that needs a rewrite: Python's json.loads refuses it, so does the port
  Deno.writeFileSync(
    pathOf(f.old, 'studio-bom.json'),
    new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(JSON.stringify({ p: pathOf(f.old, 'x') }))]),
  );
  const bomMine = await denoRun(f.old, f.target);
  const bomTheirs = await pyRun(py, f.old, f.target);
  assertEquals([bomMine.result?.state, bomMine.messages, bomMine.seen], [bomTheirs.result?.state, bomTheirs.messages, bomTheirs.seen]);
  assertEquals(bomMine.result, bomTheirs.result);
  assertEquals(bomMine.result?.reason, 'JSONDecodeError: Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)');
  assert(!exists(f.target));
  assertEquals(tmpLeftovers(tmp.root), both, 'each side redid its own leftover only');
});
