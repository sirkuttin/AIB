/**
 * server/state (state_store.py): the cases of the Python tests that exercise the stores directly
 * (test_conversation_state, test_project_prefs, test_read_state, test_settings, test_state_files_safety, test_unknown_receipts,
 * test_runtime StateStoreTests, test_project_root, test_editors / test_prompts / test_updater / test_adapters store cases),
 * plus the JSON reader and the agent registry. Parity with Python and Python<->Deno interop are in state_store_parity_test.ts.
 */
import { assert, assertEquals, assertRejects, assertThrows } from './_assert.ts';
import {
  ConversationState,
  FileLock,
  LockTimeout,
  MAX_CONVERSATIONS,
  MAX_RECEIPTS_PER_SESSION,
  ProjectPrefs,
  ReadState,
  Recovery,
  SettingsStore,
  StateStore,
  timing,
  VERSION,
} from '../../outputs/agent-studio/server/state/store.ts';
import { dumpJson, entriesOf, keysOf, parseJson, readJsonFile } from '../../outputs/agent-studio/server/state/json.ts';
import * as registry from '../../outputs/agent-studio/server/agents/agent_registry.ts';
import { ValueError } from '../../outputs/agent-studio/server/core/py.ts';
import { QueueStore } from '../../outputs/agent-studio/server/acp/msgqueue.ts';

timing.readBackoffMs = 0; // as the Python tests patch READ_BACKOFF
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
const PY = (() => {
  const out = new Deno.Command(Deno.env.get('AIB_PYTHON') ?? (WIN ? 'python' : 'python3'), {
    args: ['-c', 'import sys; print(sys.executable)'],
    env: { AGENT_STUDIO_TEST: '1' },
  }).outputSync();
  return new TextDecoder().decode(out.stdout).trim();
})();
const FAKE = new URL('../fake_acp.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', SEP);

const created: string[] = [];
globalThis.addEventListener('unload', () => {
  for (const dir of created) {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* still open */ }
  }
});

function tempDir(): string {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-state-test-' });
  created.push(dir);
  return dir;
}

function file(dir: string, name: string): string {
  return `${dir}${SEP}${name}`;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(path));
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function names(dir: string): string[] {
  return [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => !n.endsWith('.lock')).sort();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replace Deno.<name> for the duration of fn (unittest.mock.patch.object). */
async function patched<K extends 'readFileSync' | 'renameSync', T>(
  name: K,
  replacement: typeof Deno[K],
  fn: () => Promise<T> | T,
): Promise<T> {
  const real = Deno[name];
  (Deno as unknown as Record<string, unknown>)[name] = replacement;
  try {
    return await fn();
  } finally {
    (Deno as unknown as Record<string, unknown>)[name] = real;
  }
}

function deniedReads(path: string): typeof Deno.readFileSync {
  const real = Deno.readFileSync;
  return ((p: string | URL) => {
    if (String(p) === path) throw new Deno.errors.PermissionDenied('Access is denied. (os error 5)');
    return real(p);
  }) as typeof Deno.readFileSync;
}

// ---- JSON reader / writer ------------------------------------------------------------------------

Deno.test('parseJson reads what json.loads reads and keeps file key order', () => {
  for (
    const text of ['{"a":1,"b":[1,2.5,-3e2,true,false,null],"c":"\\u00e9\\n\\ud83d\\ude00"}', ' [ ] ', '"x"', '0', '{"__proto__":{"x":1}}']
  ) {
    assertEquals(parseJson(text), JSON.parse(text), text);
  }
  const value = parseJson('{"b":1,"10":2,"a":3,"2":4}') as Record<string, unknown>;
  assertEquals(keysOf(value), ['b', '10', 'a', '2']);
  assertEquals(entriesOf(value).map(([k]) => k), ['b', '10', 'a', '2']);
  const nan = parseJson('[NaN, Infinity, -Infinity]') as number[];
  assert(Number.isNaN(nan[0]) && nan[1] === Infinity && nan[2] === -Infinity);
  for (const bad of ['{not json', '[1,]', '{"a":1,}', '01', '"a\tb"', '\ufeff{}', '{} x', '', 'nan', "{'a':1}"]) {
    assertThrows(() => parseJson(bad));
  }
  const proto = parseJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  assertEquals(Object.getPrototypeOf(proto), Object.prototype);
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

Deno.test('dumpJson is compact, keeps Map order and writes NaN / Infinity like Python', () => {
  assertEquals(dumpJson({ a: [1, 'é'], b: new Map([['2', 1], ['1', 2]]) }), '{"a":[1,"é"],"b":{"2":1,"1":2}}');
  assertEquals(dumpJson([NaN, Infinity, -Infinity, null]), '[NaN,Infinity,-Infinity,null]');
  assertEquals(dumpJson(parseJson('{"x":1,"3":2}')), '{"x":1,"3":2}');
});

Deno.test('readJsonFile: missing, ok, corrupt (parse or UTF-8 error) and busy', async () => {
  const dir = tempDir();
  const path = file(dir, 'x.json');
  assertEquals(readJsonFile(path), ['missing', null]);
  Deno.writeTextFileSync(path, '{"a":1}');
  assertEquals(readJsonFile(path), ['ok', { a: 1 }]);
  Deno.writeTextFileSync(path, '{oops');
  assertEquals(readJsonFile(path)[0], 'corrupt');
  Deno.writeFileSync(path, new Uint8Array([0xff, 0xfe, 0, 0x62]));
  assertEquals(readJsonFile(path)[0], 'corrupt');
  await patched('readFileSync', deniedReads(path), () => assertEquals(readJsonFile(path)[0], 'busy'));
});

// ---- ConversationState (test_conversation_state.py StorageTests, HoldTests, YourTurnStorageTests) ----------

Deno.test('conversations: pin / archive / delete / restore rules', async () => {
  const state = new ConversationState(tempDir());
  const first = (await state.apply('pin', 'claude', 's1'))!;
  assert(first.pinnedAt > 0);
  assertEquals((await state.apply('pin', 'claude', 's1'))!.pinnedAt, first.pinnedAt, 'pinning twice keeps the original time');
  const archived = (await state.apply('archive', 'claude', 's1'))!;
  assertEquals([archived.pinnedAt, archived.archivedAt > 0], [0, true], 'archiving unpins');
  await assertRejects(() => state.apply('pin', 'claude', 's1'), ValueError);
  const deleted = (await state.apply('delete', 'claude', 's1', 'T'.repeat(500), 'C:\\x'))!;
  assert(deleted.deletedAt > 0 && deleted.archivedAt > 0);
  assertEquals(deleted.title.length, 200);
  for (const blocked of ['pin', 'archive']) await assertRejects(() => state.apply(blocked, 'claude', 's1'), ValueError);
  const restored = (await state.apply('restore', 'claude', 's1'))!;
  assertEquals([restored.deletedAt, restored.agentDeleted], [0, false]);
  assert(restored.archivedAt > 0, 'restoring an archived-then-deleted chat puts it back in Archived');
  assertEquals(await state.apply('unarchive', 'claude', 's1'), null);
  assertEquals(state.public().entries, {}, 'an entry without marks is not kept');
});

Deno.test('conversations: validation', async () => {
  const dir = tempDir();
  const state = new ConversationState(dir);
  const cases: unknown[][] = [
    ['bogus', 'claude', 's'],
    ['pin', 'devin', 's'],
    ['pin', 'claude', ''],
    ['pin', 'claude', null],
    [
      'pin',
      'claude',
      'x'.repeat(513),
    ],
    ['pin', 'claude', 'a\nb'],
    [null, 'claude', 's'],
  ];
  for (const args of cases) await assertRejects(() => state.apply(args[0], args[1], args[2]), ValueError);
  assert(!exists(file(dir, ConversationState.FILE)));
});

Deno.test('conversations: persist, providers do not collide, no temp files left', async () => {
  const dir = tempDir();
  const a = new ConversationState(dir);
  await a.apply('pin', 'claude', 'same');
  await a.apply('archive', 'omp', 'same');
  const entries = new ConversationState(dir).public().entries;
  assertEquals(Object.keys(entries).sort(), ['claude:same', 'omp:same']);
  assert(entries['claude:same'].pinnedAt > 0 && entries['omp:same'].archivedAt > 0);
  assertEquals(names(dir), [ConversationState.FILE], 'no temp files left behind');
});

Deno.test('conversations: pinned order is by pin time', async () => {
  const state = new ConversationState(tempDir());
  for (const sid of ['a', 'b', 'c']) {
    await state.apply('pin', 'claude', sid);
    await sleep(10);
  }
  const entries = state.public().entries;
  assertEquals(Object.keys(entries).sort((x, y) => entries[y].pinnedAt - entries[x].pinnedAt), ['claude:c', 'claude:b', 'claude:a']);
});

Deno.test('conversations: revision changes only on change, other writers are seen', async () => {
  const dir = tempDir();
  const a = new ConversationState(dir);
  const b = new ConversationState(dir);
  const rev = a.revision();
  assertEquals(a.revision(), rev, 'polling does not change the revision');
  await a.apply('pin', 'claude', 's1');
  const changed = a.revision();
  assert(changed !== rev);
  await a.apply('pin', 'claude', 's1');
  assertEquals(a.revision(), changed, 'a no-op does not bump the revision');
  assert('claude:s1' in b.public().entries, 'a second Studio on the same state dir sees the change');
  await b.apply('archive', 'omp', 's2');
  assert('omp:s2' in a.public().entries);
  assert('claude:s1' in a.public().entries, "a stale writer does not lose the other writer's marks");
});

Deno.test('conversations: corrupt / unknown files are quarantined or ignored', async () => {
  const dir = tempDir();
  const path = file(dir, ConversationState.FILE);
  const junk = ['{not json', '\xff\xfe\x00', '[]', '{"version": 99, "entries": {}}', '{"version": 1, "entries": []}'];
  for (const text of junk) {
    Deno.writeFileSync(path, text === '\xff\xfe\x00' ? new Uint8Array([0xff, 0xfe, 0]) : new TextEncoder().encode(text));
    const state = new ConversationState(dir);
    assertEquals(state.public().entries, {}, text);
    assert(state.warning, text);
    await state.apply('pin', 'claude', 'fresh');
    assertEquals(state.warning, '');
    assertEquals(readJson(path).version, 1);
    Deno.removeSync(path);
  }
  assert(exists(file(dir, 'studio-conversations.corrupt')));
});

Deno.test('conversations: bad entries are dropped, good ones kept', () => {
  const dir = tempDir();
  Deno.writeTextFileSync(
    file(dir, ConversationState.FILE),
    JSON.stringify({
      version: 1,
      entries: {
        'claude:good': { pinnedAt: 5, title: 'ok' },
        'devin:x': { pinnedAt: 5 },
        'claude:': { pinnedAt: 5 },
        nocolon: { pinnedAt: 1 },
        'claude:neg': { pinnedAt: -3 },
        'claude:str': 'x',
        'claude:nan': { pinnedAt: 'abc', archivedAt: null },
        'claude:big': { deletedAt: 9, agentDeleted: true, title: 'y'.repeat(999) },
        'claude:flag': { archivedAt: 1, agentDeleted: true },
      },
    }),
  );
  const entries = new ConversationState(dir).public().entries;
  assertEquals(Object.keys(entries).sort(), ['claude:big', 'claude:flag', 'claude:good']);
  assertEquals(entries['claude:big'].title.length, 200);
  assertEquals(entries['claude:flag'].agentDeleted, false, 'agentDeleted only makes sense on a tombstone');
});

Deno.test('conversations: bounded (pins and archives outlive old tombstones)', async () => {
  class Small extends ConversationState {
    static override MAX_ENTRIES = 5;
  }
  const dir = tempDir();
  const state = new Small(dir);
  await state.apply('pin', 'claude', 'pinned');
  await state.apply('archive', 'claude', 'archived');
  await state.apply('delete', 'claude', 'agent-gone', '', '', true);
  for (let i = 0; i < 6; i++) await state.apply('delete', 'claude', `old${i}`);
  const keys = Object.keys(state.public().entries);
  assertEquals(keys.length, 5);
  assert(keys.includes('claude:pinned') && keys.includes('claude:archived'));
  assert(!keys.includes('claude:agent-gone'));
  assertEquals(Object.keys(readJson(file(dir, ConversationState.FILE)).entries as object).length, 5);
});

Deno.test('conversations: a failed save rolls back and removes the temporary file', async () => {
  const dir = tempDir();
  const state = new ConversationState(dir);
  await state.apply('pin', 'claude', 's1');
  await patched('renameSync', () => {
    throw new Deno.errors.PermissionDenied('disk full');
  }, () => assertRejects(() => state.apply('archive', 'claude', 's1'), ValueError));
  assertEquals(state.public().entries['claude:s1'].archivedAt, 0);
  assert(state.warning.includes('could not save'), state.warning);
  assertEquals(names(dir), [ConversationState.FILE], 'temporary file removed after a failed save');
});

Deno.test('conversations: in-memory mode touches no files', async () => {
  const dir = tempDir();
  const state = new ConversationState(null);
  await state.apply('pin', 'claude', 's1');
  assert('claude:s1' in state.public().entries);
  assertEquals(names(dir), []);
});

Deno.test('conversations: hold rules', async () => {
  const dir = tempDir();
  const state = new ConversationState(dir);
  const held = (await state.apply('hold', 'claude', 's1', '', '', false, '  waiting on CI  '))!;
  assert(held.holdAt > 0);
  assertEquals(held.holdNote, 'waiting on CI');
  const again = (await state.apply('hold', 'claude', 's1', '', '', false, 'x'.repeat(500)))!;
  assertEquals(again.holdAt, held.holdAt, 're-holding keeps the original time');
  assertEquals(again.holdNote.length, ConversationState.MAX_NOTE);
  const pinned = (await state.apply('pin', 'claude', 's1'))!;
  assertEquals([pinned.holdAt, pinned.holdNote], [0, ''], 'pinning a held chat takes it off hold');
  const rehold = (await state.apply('hold', 'claude', 's1', '', '', false, 'back later'))!;
  assertEquals(rehold.pinnedAt, 0, 'putting a pinned chat on hold unpins it');
  assertEquals(rehold.holdNote, 'back later');
  await state.apply('resume', 'claude', 's1');
  await state.apply('pin', 'claude', 's1');
  const archived = (await state.apply('archive', 'claude', 's1'))!;
  assertEquals([archived.holdAt, archived.holdNote, archived.pinnedAt], [0, '', 0]);
  await assertRejects(() => state.apply('hold', 'claude', 's1'), ValueError);
  await state.apply('unarchive', 'claude', 's1');
  assertEquals(state.public().entries, {});
  await state.apply('hold', 'omp', 's2');
  assertEquals((await state.apply('hold', 'omp', 's2', '', '', false, 'later'))!.holdNote, 'later');
  assertEquals(await state.apply('resume', 'omp', 's2'), null);
  await state.apply('hold', 'claude', 's3');
  await state.apply('delete', 'claude', 's3');
  await assertRejects(() => state.apply('hold', 'claude', 's3'), ValueError);
  assert(new ConversationState(dir).public().entries['claude:s3'].holdAt > 0, 'persisted');
});

Deno.test('conversations: loading cleans hold fields', () => {
  const dir = tempDir();
  Deno.writeTextFileSync(
    file(dir, ConversationState.FILE),
    JSON.stringify({
      version: 1,
      entries: {
        'claude:a': { holdAt: 5, holdNote: 'n'.repeat(999) },
        'claude:b': { pinnedAt: 2, holdNote: 'orphan note' },
        'claude:c': { holdAt: 'x', holdNote: 'only note' },
      },
    }),
  );
  const entries = new ConversationState(dir).public().entries;
  assertEquals(Object.keys(entries).sort(), ['claude:a', 'claude:b']);
  assertEquals(entries['claude:a'].holdNote.length, ConversationState.MAX_NOTE);
  assertEquals(entries['claude:b'].holdNote, '', 'a note without a hold is dropped');
});

Deno.test('conversations: your turn is set by the agent and cleared only by acting', async () => {
  const state = new ConversationState(tempDir());
  const entry = (await state.apply('your_turn', 'claude', 's1'))!;
  assert(entry.yourTurnAt > 0);
  assertEquals((await state.apply('pin', 'claude', 's1'))!.yourTurnAt, entry.yourTurnAt, 'pinning is not a reply');
  assertEquals(state.public().entries['claude:s1'].yourTurnAt, entry.yourTurnAt);
  assertEquals((await state.apply('handled', 'claude', 's1'))!.yourTurnAt, 0);
  await state.apply('your_turn', 'claude', 's1');
  await state.apply('unpin', 'claude', 's1');
  await state.apply('handled', 'claude', 's1');
  assertEquals(state.public().entries, {});
  for (const action of ['hold', 'archive', 'delete']) {
    await state.apply('your_turn', 'claude', 's1');
    assertEquals((await state.apply(action, 'claude', 's1'))!.yourTurnAt, 0, action);
    await state.apply('restore', 'claude', 's1');
    await state.apply('unarchive', 'claude', 's1');
    await state.apply('resume', 'claude', 's1');
  }
});

Deno.test('conversations: parked chats do not become your turn; shared through the folder', async () => {
  const dir = tempDir();
  const state = new ConversationState(dir);
  await state.apply('hold', 'claude', 's1');
  assertEquals(await state.apply('your_turn', 'claude', 's1'), null);
  assertEquals(state.public().entries['claude:s1'].yourTurnAt, 0);
  await state.apply('archive', 'claude', 's2');
  await state.apply('your_turn', 'claude', 's2');
  assertEquals(state.public().entries['claude:s2'].yourTurnAt, 0);
  const a = new ConversationState(dir);
  const b = new ConversationState(dir);
  await a.apply('your_turn', 'omp', 's9');
  assert(b.public().entries['omp:s9'].yourTurnAt > 0);
  await b.apply('handled', 'omp', 's9');
  assert(!('omp:s9' in a.public().entries));
});

Deno.test('conversations: old entries without projectRoot load as cwd (test_project_root)', async () => {
  const dir = tempDir();
  const state = new ConversationState(dir);
  await state.apply('delete', 'claude', 's1', 'T', 'C:\\x');
  assertEquals(state.entries.get('claude:s1')!.projectRoot, 'C:\\x');
  const raw = readJson(state.path!) as { entries: Record<string, Record<string, unknown>> };
  for (const entry of Object.values(raw.entries)) delete entry.projectRoot;
  Deno.writeTextFileSync(state.path!, JSON.stringify(raw));
  const old = new ConversationState(dir);
  assertEquals(old.entries.get('claude:s1')!.projectRoot, 'C:\\x');
  await old.apply('delete', 'claude', 's2', 'T', 'C:\\wt', false, '', 'C:\\main');
  const saved = (readJson(old.path!) as { entries: Record<string, Record<string, unknown>> }).entries;
  assertEquals([saved['claude:s1'].projectRoot, saved['claude:s2'].projectRoot], ['C:\\x', 'C:\\main']);
});

// ---- ProjectPrefs (test_project_prefs.py StorageTests, test_editors useWorkspace) ------------------

Deno.test('projects: set, merge and clear', async () => {
  const prefs = new ProjectPrefs(tempDir());
  await prefs.update({ set: { 'w:c/a': { name: '  My   app ', color: 'blue' } } });
  await prefs.update({ set: { 'w:c/a': { hidden: true } } });
  assertEquals(prefs.public().projects['w:c/a'], { name: 'My app', color: 'blue', hidden: true });
  await prefs.update({ set: { 'w:c/a': { name: '', color: '', hidden: false } } });
  assertEquals(prefs.public().projects, {}, 'a project without preferences is not kept');
});

Deno.test('projects: order dedupes and persists', async () => {
  const dir = tempDir();
  const prefs = new ProjectPrefs(dir);
  await prefs.update({ order: ['b', 'a', 'b', '', 5, 'c'] });
  assertEquals(prefs.public().order, ['b', 'a', 'c']);
  assertEquals(new ProjectPrefs(dir).public().order, ['b', 'a', 'c']);
  assertEquals(readJson(file(dir, ProjectPrefs.FILE)).version, 1);
});

Deno.test('projects: validation and limits', async () => {
  const dir = tempDir();
  const prefs = new ProjectPrefs(dir);
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 51; i++) many[`k${i}`] = { name: 'x' };
  const bad = [
    { set: [] },
    { order: 'x' },
    { set: { k: { color: 'chartreuse' } } },
    { set: { k: { hidden: 'yes' } } },
    {
      set: { k: { name: 5 } },
    },
    { set: { k: 'x' } },
    { set: { '': { name: 'x' } } },
    { set: { 'a\nb': { name: 'x' } } },
    { set: { ['k'.repeat(513)]: { name: 'x' } } },
    {
      set: many,
    },
    [],
  ];
  for (const body of bad) await assertRejects(() => prefs.update(body), ValueError);
  assert(!exists(file(dir, ProjectPrefs.FILE)));
  await prefs.update({ set: { k: { name: 'x'.repeat(500) } } });
  assertEquals(prefs.public().projects.k.name.length, ProjectPrefs.MAX_NAME);
});

Deno.test('projects: muted and useWorkspace flags', async () => {
  const dir = tempDir();
  const prefs = new ProjectPrefs(dir);
  await prefs.update({ set: { k: { muted: true } } });
  assertEquals(prefs.public().projects.k, { name: '', color: '', hidden: false, muted: true });
  await prefs.update({ set: { k: { name: 'Mine' } } });
  assertEquals(prefs.public().projects.k.muted, true, 'other fields keep muted');
  assertEquals(new ProjectPrefs(dir).public().projects.k.muted, true, 'persisted');
  await prefs.update({ set: { k: { muted: false, name: '' } } });
  assertEquals(prefs.public().projects, {});
  await prefs.update({ set: { k: { color: 'blue' } } });
  assert(!('muted' in prefs.public().projects.k));
  for (const bad of ['yes', 1, null]) await assertRejects(() => prefs.update({ set: { k: { muted: bad } } }), ValueError);
  Deno.writeTextFileSync(
    file(dir, ProjectPrefs.FILE),
    JSON.stringify({ version: 1, order: [], projects: { a: { muted: 'true' }, b: { muted: true } } }),
  );
  assertEquals(Object.keys(new ProjectPrefs(dir).public().projects), ['b']);
  const other = new ProjectPrefs(tempDir());
  await other.update({ set: { k: { useWorkspace: true } } });
  assertEquals(other.public().projects.k, { name: '', color: '', hidden: false, useWorkspace: true });
  for (const bad of ['yes', 1, null]) await assertRejects(() => other.update({ set: { k: { useWorkspace: bad } } }), ValueError);
  await other.update({ set: { k: { useWorkspace: false } } });
  assertEquals(other.public().projects, {});
});

Deno.test('projects: a failed batch changes nothing', async () => {
  const prefs = new ProjectPrefs(tempDir());
  await prefs.update({ set: { a: { name: 'A' } } });
  await assertRejects(() => prefs.update({ set: { b: { name: 'B' }, c: { color: 'nope' } } }), ValueError);
  assertEquals(Object.keys(prefs.public().projects), ['a']);
});

Deno.test('projects: corrupt, unknown and hand-edited files', () => {
  const dir = tempDir();
  const path = file(dir, ProjectPrefs.FILE);
  Deno.writeTextFileSync(path, '{not json');
  const prefs = new ProjectPrefs(dir);
  assertEquals(prefs.public().projects, {});
  assert(prefs.public().warning.includes('unreadable'));
  assert(exists(file(dir, 'studio-projects.corrupt')));
  Deno.writeTextFileSync(path, JSON.stringify({ version: 99, projects: {} }));
  assert(new ProjectPrefs(dir).public().warning.includes('unknown format'));
  Deno.writeTextFileSync(
    path,
    JSON.stringify({
      version: 1,
      order: ['a', 'a', 3],
      projects: { a: { name: 'ok', color: 'zzz', hidden: 'true' }, b: 'nope', c: { name: '', color: '', hidden: false } },
    }),
  );
  const pub = new ProjectPrefs(dir).public();
  assertEquals(pub.projects, { a: { name: 'ok', color: '', hidden: false } });
  assertEquals(pub.order, ['a']);
});

Deno.test('projects: other writers are picked up; in-memory without a folder', async () => {
  const dir = tempDir();
  const a = new ProjectPrefs(dir);
  const b = new ProjectPrefs(dir);
  const before = a.revision();
  await b.update({ set: { x: { name: 'From B' } } });
  assertEquals(a.public().projects.x.name, 'From B');
  assert(a.revision() !== before);
  const empty = tempDir();
  const memory = new ProjectPrefs(null);
  await memory.update({ order: ['a'] });
  assertEquals(memory.public().order, ['a']);
  assertEquals(names(empty), []);
});

Deno.test('projects: a "__proto__" project key is stored as data, never as a prototype', async () => {
  const dir = tempDir();
  const prefs = new ProjectPrefs(dir);
  await prefs.update(JSON.parse('{"set":{"__proto__":{"name":"p"}}}'));
  assertEquals(Object.keys(prefs.public().projects), ['__proto__']);
  assertEquals(Object.getPrototypeOf(prefs.public().projects), Object.prototype);
  assertEquals(new ProjectPrefs(dir).projects.get('__proto__')?.name, 'p');
});

// ---- ReadState (test_read_state.py StorageTests) ---------------------------------------------------

Deno.test('read state: roundtrip and restart', async () => {
  const dir = tempDir();
  await new ReadState(dir).update({ set: { 'claude:abc': { seenAt: 1000, seenIndex: 4 } } });
  assertEquals(new ReadState(dir).public().chats, { 'claude:abc': { seenAt: 1000, seenIndex: 4 } });
  assertEquals(readJson(file(dir, ReadState.FILE)).version, 1);
});

Deno.test('read state: only moves forward', async () => {
  const store = new ReadState(tempDir());
  await store.update({ set: { 'omp:s': { seenAt: 2000, seenIndex: 3 } } });
  await store.update({ set: { 'omp:s': { seenAt: 1000, seenIndex: 9 } } });
  assertEquals(store.public().chats['omp:s'], { seenAt: 2000, seenIndex: 3 });
  await store.update({ set: { 'omp:s': { seenAt: 3000 } } });
  assertEquals(store.public().chats['omp:s'], { seenAt: 3000, seenIndex: 3 });
  await store.update({ set: { 'omp:s': { seenAt: 3000, seenIndex: 5 } } });
  assertEquals(store.public().chats['omp:s'], { seenAt: 3000, seenIndex: 5 });
});

Deno.test('read state: validation', async () => {
  const dir = tempDir();
  const store = new ReadState(dir);
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 501; i++) many[`a:${i}`] = { seenAt: 1 };
  const bad = [
    [],
    {},
    { set: [] },
    { set: { nocolon: { seenAt: 1 } } },
    { set: { 'Bad:x': { seenAt: 1 } } },
    { set: { 'a:b': { seenAt: -1 } } },
    {
      set: { 'a:b': { seenAt: 'x' } },
    },
    { set: { 'a:b': { seenAt: true } } },
    { set: { 'a:b': { seenAt: 1e18 } } },
    { set: { 'a:b': 5 } },
    {
      set: { ['a:' + 'x'.repeat(400)]: { seenAt: 1 } },
    },
    { set: { 'a:b\nc': { seenAt: 1 } } },
    { set: many },
  ];
  for (const body of bad) await assertRejects(() => store.update(body), ValueError);
  assert(!exists(file(dir, ReadState.FILE)));
});

Deno.test('read state: the LRU cap drops the least recently written', async () => {
  class Small extends ReadState {
    static override MAX_CHATS = 5;
  }
  const dir = tempDir();
  const store = new Small(dir);
  for (let i = 0; i < 8; i++) await store.update({ set: { [`claude:s${i}`]: { seenAt: 1000 + i } } });
  await store.update({ set: { 'claude:s3': { seenAt: 5000 } } });
  const chats = new Small(dir).public().chats;
  assertEquals(Object.keys(chats).length, 5);
  assert('claude:s3' in chats && !('claude:s0' in chats) && !('claude:s2' in chats) && 'claude:s4' in chats);
  assertEquals(ReadState.MAX_CHATS, 2000);
});

Deno.test('read state: an unreadable file is set aside', () => {
  const dir = tempDir();
  Deno.writeTextFileSync(file(dir, ReadState.FILE), '{oops');
  const store = new ReadState(dir);
  assertEquals(store.public().chats, {});
  assert(store.public().warning);
});

// ---- agent registry (test_settings.py RegistryTests) ------------------------------------------------

Deno.test('registry: ids are slugs and unique', () => {
  assertEquals(registry.makeId('My Agent!', []), 'custom-my-agent');
  assertEquals(registry.makeId('My Agent', ['custom-my-agent']), 'custom-my-agent-2');
  assertEquals(registry.makeId('???', []), 'custom-agent');
  assert(registry.isProvider('omp') && registry.isProvider('custom-a-1'));
  for (const bad of ['custom-', 'custom-A', 'custom-a_b', 'custom--a', 'custom-a:b', 'nonesuch', '', null, 5, 'custom-' + 'a'.repeat(60)]) {
    assert(!registry.isProvider(bad), String(bad));
  }
  assert(registry.isProvider('custom-a\n'), "Python's re '$' matches before a final newline");
});

Deno.test('registry: the command must exist', () => {
  assertEquals(registry.checkCommand(PY).toLowerCase(), Deno.realPathSync(PY).toLowerCase());
  assert(registry.checkCommand(PY.split(SEP).pop()!));
  const parent = PY.slice(0, PY.lastIndexOf(SEP));
  for (const bad of ['', '   ', 'no-such-program-xyz', parent, `${parent}${SEP}nope.exe`, 'rel/dir/prog', 'a\nb', null, 5]) {
    assertThrows(() => registry.checkCommand(bad), ValueError);
  }
});

Deno.test('registry: args and env parsing', () => {
  assertEquals(registry.cleanArgs('a\n\n --b \r\nc d'), ['a', ' --b ', 'c d']);
  assertEquals(registry.cleanArgs(['x', 'y']), ['x', 'y']);
  for (const bad of [[1], 'a'.repeat(2001), ['a\nb'], ['a\x00'], Array(51).fill('x'), { a: 1 }]) {
    assertThrows(() => registry.cleanArgs(bad), ValueError);
  }
  assertEquals(registry.cleanEnv('A=1\n# c\n\nB_2=x=y'), [{ name: 'A', value: '1' }, { name: 'B_2', value: 'x=y' }]);
  for (const bad of ['1A=x', 'A-B=x', 'novalue', '=x', 'A=1\nA=2', 'a b=1', 'A=\x00']) {
    assertThrows(() => registry.cleanEnv(bad), ValueError);
  }
  assertThrows(() => registry.cleanEnv([{ name: 'OK', value: 5 }]), ValueError);
  assertThrows(() => registry.cleanEnv(Array.from({ length: 51 }, (_, i) => ({ name: `N${i}`, value: '' }))), ValueError);
});

function agent(name = 'Fake agent', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, command: PY, args: [FAKE], env: [{ name: 'FAKE_TOKEN', value: 'abc' }], enabled: true, ...extra };
}

Deno.test('registry: cleanAgent normalizes and keeps the id when editing', () => {
  const a = registry.cleanAgent(agent('  My\tfake   agent  '), ['custom-my-fake-agent']);
  assertEquals([a.id, a.name, a.enabled], ['custom-my-fake-agent-2', 'My fake agent', true]);
  assertEquals(registry.cleanAgent(agent('Renamed'), [], a as unknown as Record<string, unknown>).id, a.id);
  assertThrows(() => registry.cleanAgent(agent('')), ValueError);
  assertThrows(() => registry.cleanAgent(agent('x', { enabled: 'yes' })), ValueError);
});

// ---- SettingsStore (test_settings.py StoreTests and the store cases of other files) -----------------

Deno.test('settings: defaults when no file; the hidden flag never reaches the page', () => {
  const dir = tempDir();
  const store = new SettingsStore(dir);
  const data = store.snapshot();
  assertEquals(data.agents, { builtin: { omp: true, claude: true, codex: true }, custom: [] });
  assertEquals(data.server, { autoReconnect: true, worktreePerChat: true, autoUpdateCheck: true });
  assertEquals((store.public().settings as { server: unknown }).server, { autoReconnect: true, autoUpdateCheck: true });
  assert(!exists(file(dir, SettingsStore.FILE)));
});

Deno.test('settings: roundtrip, atomic and revision', async () => {
  const dir = tempDir();
  const store = new SettingsStore(dir);
  const first = store.revision();
  assertEquals(await store.update({ server: { autoReconnect: false }, defaults: { agent: 'claude' } }), true);
  assert(store.revision() !== first);
  assert(!names(dir).some((n) => n.endsWith('.tmp')));
  const saved = readJson(file(dir, SettingsStore.FILE)) as Record<string, Record<string, unknown>>;
  assertEquals([saved.version, saved.server.autoReconnect, saved.defaults.agent], [1, false, 'claude']);
  assertEquals(new SettingsStore(dir).autoReconnect(), false);
  const revision = store.revision();
  assertEquals(await store.update({ server: { autoReconnect: false } }), false, 'no change, no new revision');
  assertEquals(store.revision(), revision);
});

Deno.test('settings: other writers are picked up', async () => {
  const dir = tempDir();
  const a = new SettingsStore(dir);
  const b = new SettingsStore(dir);
  const before = a.revision();
  await b.update({ agents: { builtin: { omp: false } } });
  assertEquals(a.builtinEnabled('omp'), false);
  assert(a.revision() !== before);
});

Deno.test('settings: user agent add, edit, defaults and remove', async () => {
  const store = new SettingsStore(tempDir());
  await store.update({ agents: { upsert: agent() } });
  const [a] = store.customAgents();
  assertEquals([a.id, a.args, a.env], ['custom-fake-agent', [FAKE], [{ name: 'FAKE_TOKEN', value: 'abc' }]]);
  await store.update({ agents: { upsert: { ...agent('Fake agent'), id: a.id, enabled: false } } });
  assertEquals(store.customAgent(a.id)!.enabled, false);
  assertEquals(store.customAgents().length, 1);
  await store.update({
    defaults: { agent: a.id, byAgent: { [a.id]: { model: 'm1' } }, projects: { 'w:c/x': { agent: a.id, mode: 'plan' } } },
  });
  await store.update({ agents: { remove: a.id } });
  const data = store.snapshot();
  assertEquals(data.agents.custom, []);
  assertEquals([data.defaults.agent, data.defaults.byAgent, data.defaults.projects['w:c/x']], ['', {}, {
    model: '',
    mode: 'plan',
    agent: '',
  }]);
  assertEquals((store.public().settings as { agents: { custom: unknown[] } }).agents.custom, []);
});

Deno.test('settings: public() shows env names only', async () => {
  const store = new SettingsStore(tempDir());
  await store.update({ agents: { upsert: agent() } });
  const shown = (store.public().settings as { agents: { custom: { env: unknown }[] } }).agents.custom[0];
  assertEquals(shown.env, [{ name: 'FAKE_TOKEN', set: true }]);
  assertEquals(store.customAgents()[0].env, [{ name: 'FAKE_TOKEN', value: 'abc' }]);
});

Deno.test('settings: built-ins can be turned off but not removed or clobbered', async () => {
  const store = new SettingsStore(tempDir());
  await store.update({ agents: { builtin: { claude: false } } });
  assertEquals(store.builtinEnabled('claude'), false);
  for (
    const body of [{ agents: { remove: 'omp' } }, { agents: { builtin: { gemini: true } } }, { agents: { builtin: { omp: 'no' } } }, {
      agents: { upsert: agent('OMP') },
    }, { agents: { upsert: agent('claude code') } }]
  ) await assertRejects(() => store.update(body), ValueError);
  await store.update({ agents: { enabled: { codex: false } } });
  assertEquals(store.builtinEnabled('codex'), false);
});

Deno.test('settings: a refused patch changes nothing', async () => {
  const store = new SettingsStore(tempDir());
  await store.update({ agents: { upsert: agent() } });
  const before = store.snapshot();
  const bad = [
    [],
    {},
    { bogus: 1 },
    { server: { autoReconnect: 'yes' } },
    { server: { x: 1 } },
    {
      agents: { upsert: agent('Two', { command: 'no-such-program-xyz' }) },
    },
    { agents: { upsert: agent('Two', { env: [{ name: '1bad', value: '' }] }) } },
    { agents: { upsert: agent('Fake agent') } },
    {
      agents: { upsert: { ...agent('X'), id: 'custom-missing' } },
    },
    { agents: { remove: 'custom-missing' } },
    { agents: { upsert: 'x' } },
    { defaults: { agent: 'nonesuch' } }, // ('gemini' is a Beta agent now)
    {
      defaults: { projects: { '': { agent: 'omp' } } },
    },
    { defaults: { projects: { k: { agent: 'nope' } } } },
    { defaults: { byAgent: { zzz: { model: 'm' } } } },
    {
      defaults: { projects: { k: 'x' } },
    },
    { defaults: { unknown: 1 } },
    { server: { autoReconnect: false }, agents: { remove: 'custom-missing' } },
  ];
  for (const body of bad) await assertRejects(() => store.update(body), ValueError);
  assertEquals(store.snapshot(), before);
});

Deno.test('settings: agent limit', async () => {
  const store = new SettingsStore(tempDir());
  for (let i = 0; i < registry.MAX_AGENTS; i++) await store.update({ agents: { upsert: agent(`Agent ${i}`) } });
  const error = await assertRejects(() => store.update({ agents: { upsert: agent('One too many') } }), ValueError);
  assertEquals(error.message, 'At most 20 added agents');
});

Deno.test('settings: defaults merge and clear', async () => {
  const store = new SettingsStore(tempDir());
  await store.update({ defaults: { projects: { 'w:c/a': { agent: 'claude', model: 'opus' } } } });
  await store.update({ defaults: { projects: { 'w:c/a': { mode: 'plan' } } } });
  assertEquals(store.snapshot().defaults.projects['w:c/a'], { agent: 'claude', model: 'opus', mode: 'plan' });
  await store.update({ defaults: { projects: { 'w:c/a': { agent: '', model: '', mode: '' } } } });
  assertEquals(store.snapshot().defaults.projects, {});
  await store.update({ defaults: { byAgent: { omp: { model: 'm' } }, migrated: true } });
  await store.update({ defaults: { byAgent: { omp: null } } });
  assertEquals(store.snapshot().defaults.byAgent, {});
  assertEquals(store.snapshot().defaults.migrated, true);
});

Deno.test('settings: corrupt, unknown and hand-edited files', () => {
  const dir = tempDir();
  const path = file(dir, SettingsStore.FILE);
  Deno.writeTextFileSync(path, '{not json');
  const store = new SettingsStore(dir);
  assertEquals(store.snapshot().agents.custom, []);
  assert(store.public().warning.includes('unreadable'));
  assert(exists(file(dir, 'studio-settings.corrupt')));
  Deno.writeTextFileSync(path, JSON.stringify({ version: 9 }));
  assert(new SettingsStore(dir).public().warning.includes('unknown format'));
  Deno.writeTextFileSync(
    path,
    JSON.stringify({
      version: 1,
      agents: {
        builtin: { omp: 'no', evil: false, claude: false },
        custom: [
          { id: 'custom-ok', name: 'Ok', command: 'prog', args: ['a'], env: [{ name: 'A', value: '1' }] },
          { id: 'custom-ok', name: 'Dup', command: 'x' },
          { id: 'omp', name: 'Bad id', command: 'x' },
          { id: 'custom-env', name: 'Env', command: 'x', env: [{ name: '1x', value: '' }] },
          'junk',
          { id: 'custom-nocmd', name: 'N' },
        ],
      },
      defaults: { agent: 'nope', projects: { k: { agent: 'custom-ok', model: 5 }, j: {} } },
      server: { autoReconnect: 'x' },
    }),
  );
  const data = new SettingsStore(dir).snapshot();
  assertEquals(data.agents.builtin, { omp: true, claude: false, codex: true });
  assertEquals(data.agents.custom.map((a) => a.id), ['custom-ok']);
  assertEquals([data.defaults.agent, data.defaults.projects], ['', { k: { model: '', mode: '', agent: 'custom-ok' } }]);
  assertEquals(data.server.autoReconnect, true);
});

Deno.test('settings: in-memory, editor, default view and update-check settings', async () => {
  const memory = new SettingsStore(null);
  await memory.update({ server: { autoReconnect: false } });
  assertEquals(memory.autoReconnect(), false);
  const dir = tempDir();
  const store = new SettingsStore(dir);
  assertEquals(store.snapshot().editors, { default: '' });
  await store.update({ editors: { default: 'cursor' } });
  assertEquals(new SettingsStore(dir).snapshot().editors.default, 'cursor');
  for (const bad of [{ default: 'notepad' }, { default: 5 }, { other: 1 }, 'x']) {
    await assertRejects(() => store.update({ editors: bad }), ValueError);
  }
  const view = () => (store.public().settings as { appearance: { defaultView: string } }).appearance.defaultView;
  assertEquals(view(), 'full');
  for (const choice of ['chat', 'full', 'chat']) {
    await store.update({ appearance: { defaultView: choice } });
    assertEquals(view(), choice);
  }
  for (const bad of ['prompts', 'outcomes', '', 'Full', null, 3, ['chat']]) {
    await assertRejects(() => store.update({ appearance: { defaultView: bad } }), ValueError);
    assertEquals(view(), 'chat');
  }
  await assertRejects(() => store.update({ appearance: { colour: 'red' } }), ValueError);
  await assertRejects(() => store.update({ appearance: 'chat' }), ValueError);
  for (const stale of ['prompts', 'outcomes']) {
    Deno.writeTextFileSync(file(dir, SettingsStore.FILE), JSON.stringify({ version: VERSION, appearance: { defaultView: stale } }));
    assertEquals((new SettingsStore(dir).public().settings as { appearance: { defaultView: string } }).appearance.defaultView, 'full');
  }
  const updates = new SettingsStore(tempDir());
  assertEquals(updates.autoUpdateCheck(), true);
  await updates.update({ server: { autoUpdateCheck: false } });
  assertEquals(updates.autoUpdateCheck(), false);
  for (const bad of ['no', 0, null]) await assertRejects(() => updates.update({ server: { autoUpdateCheck: bad } }), ValueError);
});

Deno.test('settings: launchers must be existing files, stored as pathlib prints them', async () => {
  const dir = tempDir();
  const script = file(dir, 'launch.js');
  Deno.writeTextFileSync(script, '');
  const store = new SettingsStore(dir);
  await store.update({ launchers: { claude: script.replaceAll('\\', '/') } });
  assertEquals(store.launcher('claude'), script);
  for (const bad of ['relative.js', file(dir, 'missing.js'), dir, 5]) {
    const error = await assertRejects(() => store.update({ launchers: { claude: bad } }), ValueError);
    assertEquals(error.message, 'The launcher must be the full path of an existing script file');
  }
  await assertRejects(() => store.update({ launchers: { omp: script } }), ValueError);
  await store.update({ launchers: { claude: null } });
  assertEquals(store.launcher('claude'), '');
});

// ---- StateStore and Recovery (test_runtime, test_unknown_receipts, test_project_root, test_host_migration) ----

Deno.test('recovery: roundtrip; working receipts become unknown, durably', () => {
  const dir = tempDir();
  const store = new StateStore(dir, 'recovery-1');
  store.rememberConversation('omp', 'session-a', 'C:/work', 'Title');
  store.setReceipt('omp', 'session-a', 'm1', 'f'.repeat(64), 'working');
  store.setReceipt('omp', 'session-a', 'm2', 'a'.repeat(64), 'finished');
  const reloaded = new StateStore(dir, 'recovery-1');
  assertEquals(reloaded.loadedFromPrevious.map((c) => c.sessionId), ['session-a']);
  assertEquals(reloaded.receipt('omp', 'session-a', 'm1')!.state, 'unknown');
  assertEquals(reloaded.receipt('omp', 'session-a', 'm2')!.state, 'finished');
  assertEquals(reloaded.unknownCount('omp', 'session-a'), 1);
  assertEquals(new StateStore(dir, 'recovery-1').receipt('omp', 'session-a', 'm1')!.state, 'unknown');
  assert(!names(dir).some((n) => n.endsWith('.tmp')));
});

Deno.test('recovery: corrupt and malicious files are ignored', () => {
  const dir = tempDir();
  const path = file(dir, 'studio-recovery-2.json');
  Deno.writeTextFileSync(path, '{not json');
  let store = new StateStore(dir, 'recovery-2');
  assertEquals(store.conversations.size, 0);
  assert(store.warning.includes('unreadable'));
  Deno.writeTextFileSync(
    path,
    JSON.stringify({
      version: 1,
      conversations: [{ provider: 'evil', sessionId: 'x', cwd: 'c' }, { provider: 'omp', sessionId: '', cwd: 'c' }, 5],
      receipts: { 'omp:s': { m: { fingerprint: 3 }, ok: { fingerprint: 'f', state: 'bogus' } } },
    }),
  );
  store = new StateStore(dir, 'recovery-2');
  assertEquals(store.conversations.size, 0);
  assertEquals(store.receipt('omp', 's', 'ok')!.state, 'unknown');
  assertEquals(store.receipt('omp', 's', 'm'), null);
});

Deno.test('recovery: receipts and conversations are bounded, oldest first (integer-like ids too)', () => {
  const dir = tempDir();
  const store = new StateStore(dir, 'recovery-3');
  for (let i = 0; i < MAX_RECEIPTS_PER_SESSION + 25; i++) store.setReceipt('claude', 's', `${i}`, 'f', 'finished');
  assertEquals(store.receipts.get('claude:s')!.size, MAX_RECEIPTS_PER_SESSION);
  assertEquals(store.receipt('claude', 's', '0'), null);
  for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) store.rememberConversation('omp', `session-${i}`, 'C:/x');
  assertEquals(store.conversations.size, MAX_CONVERSATIONS);
  const again = new StateStore(dir, 'recovery-3');
  assertEquals([...again.receipts.get('claude:s')!.keys()].slice(0, 2), ['25', '26'], 'file order kept for integer-like ids');
});

Deno.test('recovery: dismissing an unknown receipt is durable and only for unknown', () => {
  const dir = tempDir();
  let store = new StateStore(dir, 'r');
  store.setReceipt('omp', 's', 'm1', 'f1', 'working');
  store.setReceipt('omp', 's', 'm2', 'f2', 'finished');
  assertEquals(store.dismissReceipt('omp', 's', 'm2'), false);
  store = new StateStore(dir, 'r');
  assertEquals(store.unknownReceipts('omp', 's').map((u) => u.clientMessageId), ['m1']);
  assertEquals(store.dismissReceipt('omp', 's', 'm1'), true);
  assertEquals(store.unknownReceipts('omp', 's'), []);
  assertEquals(store.unknownCount('omp', 's'), 0);
  const again = new StateStore(dir, 'r');
  assertEquals(again.unknownReceipts('omp', 's'), []);
  assertEquals(again.receipt('omp', 's', 'm1')!.state, 'unknown', 'still refuses a resend of the same id');
  assertEquals(again.dismissReceipt('omp', 's', 'nope'), false);
});

Deno.test('recovery: projectRoot (test_project_root)', () => {
  const dir = tempDir();
  const store = new StateStore(dir);
  store.rememberConversation('claude', 's1', 'C:\\proj');
  assertEquals(store.conversations.get('claude:s1')!.projectRoot, 'C:\\proj');
  store.rememberConversation('claude', 's2', 'C:\\proj\\wt', '', 'C:\\proj');
  const record = new StateStore(dir).conversations.get('claude:s2')!;
  assertEquals([record.cwd, record.projectRoot], ['C:\\proj\\wt', 'C:\\proj']);
  const raw = readJson(store.path) as { conversations: Record<string, unknown>[] };
  for (const item of raw.conversations) delete item.projectRoot;
  Deno.writeTextFileSync(store.path, JSON.stringify(raw));
  const old = new StateStore(dir);
  assertEquals(old.conversations.get('claude:s1')!.projectRoot, 'C:\\proj');
  old.rememberConversation('claude', 's1', 'C:\\proj', 'renamed');
  const saved = (readJson(old.path) as { conversations: Record<string, unknown>[] }).conversations.at(-1)!;
  assertEquals([saved.cwd, saved.projectRoot, saved.title], ['C:\\proj', 'C:\\proj', 'renamed']);
});

Deno.test('recovery: an unreadable file is never overwritten, and is taken as-is once readable', async () => {
  const dir = tempDir();
  const first = new StateStore(dir);
  first.rememberConversation('omp', 's1', 'C:/a');
  const path = first.path;
  const before = Deno.readTextFileSync(path);
  const store = await patched('readFileSync', deniedReads(path), () => {
    const busy = new StateStore(dir);
    assert(busy.warning.includes('could not be read just now'));
    busy.rememberConversation('omp', 's2', 'C:/b');
    assert(busy.warning.includes('could not save recovery state'), busy.warning);
    return busy;
  });
  assertEquals(Deno.readTextFileSync(path), before);
  store.rememberConversation('omp', 's3', 'C:/c'); // readable again: takes the file, drops its stale view
  assertEquals([...store.conversations.keys()], ['omp:s1']);
});

Deno.test('Recovery hooks: remember on ready, receipts, forget on close, queue restore', () => {
  const dir = tempDir();
  const recovery = new Recovery(new StateStore(dir, 'recovery-t'));
  recovery.queues = new QueueStore(dir, 'queues-t');
  const restored: unknown[] = [];
  const connection = {
    provider: 'omp',
    sessionId: 's1' as string | null,
    cwd: 'C:/w',
    projectRoot: 'C:/p',
    persisted: false,
    queue: { toSaved: () => [{ id: 'q1', text: 'hi' }] },
    queueRestore: (saved: unknown[]) => restored.push(...saved),
  };
  recovery.connectionReady(connection);
  assert(connection.persisted);
  assertEquals(recovery.store.conversations.get('omp:s1')!.projectRoot, 'C:/p');
  recovery.receiptChanged(connection, 'm1', { fingerprint: 'f', state: 'working' });
  assertEquals(recovery.receipt(connection, 'm1')!.state, 'working');
  recovery.queueChanged(connection);
  recovery.connectionReady(connection);
  assertEquals(restored, [{ id: 'q1', text: 'hi' }]);
  recovery.connectionClosed(connection);
  assertEquals(recovery.store.conversations.size, 0);
  assertEquals(recovery.queues.get('omp', 's1'), []);
  recovery.shuttingDown = true;
  recovery.connectionReady(connection);
  assertEquals(recovery.store.conversations.size, 0);
});

// ---- safety (test_state_files_safety.py) ----------------------------------------------------------

Deno.test('safety: a transient read error never renames or overwrites', async () => {
  const cases: [string, (dir: string) => ConversationState | ProjectPrefs | SettingsStore, (s: never) => Promise<unknown>, string][] = [
    ['conversations', (d) => new ConversationState(d), (s: ConversationState) => s.apply('pin', 'omp', 'a'), ConversationState.FILE],
    ['projects', (d) => new ProjectPrefs(d), (s: ProjectPrefs) => s.update({ set: { p: { name: 'x' } } }), ProjectPrefs.FILE],
    ['settings', (d) => new SettingsStore(d), (s: SettingsStore) => s.update({ server: { autoReconnect: false } }), SettingsStore.FILE],
  ];
  const second: Record<string, (s: never) => Promise<unknown>> = {
    conversations: (s: ConversationState) => s.apply('pin', 'omp', 'b'),
    projects: (s: ProjectPrefs) => s.update({ set: { q: { name: 'y' } } }),
    settings: (s: SettingsStore) => s.update({ server: { autoReconnect: false } }),
  };
  for (const [kind, open, change, name] of cases) {
    const dir = tempDir();
    await change(open(dir) as never);
    const path = file(dir, name);
    const before = Deno.readTextFileSync(path);
    await patched('readFileSync', deniedReads(path), async () => {
      const store = open(dir);
      assert(store.warning, kind);
      const error = await assertRejects(() => second[kind](store as never), ValueError);
      assert(error.message.includes('could not be read just now'), error.message);
    });
    assertEquals(Deno.readTextFileSync(path), before, kind);
    assert(!exists(path.replace(/\.json$/, '.corrupt')), kind);
  }
});

Deno.test('safety: recovers once the file is readable', async () => {
  const dir = tempDir();
  await new ConversationState(dir).apply('pin', 'omp', 'a');
  const path = file(dir, ConversationState.FILE);
  const store = await patched('readFileSync', deniedReads(path), () => new ConversationState(dir));
  await store.apply('pin', 'omp', 'b');
  assertEquals(Object.keys(readJson(path).entries as object).sort(), ['omp:a', 'omp:b']);
});

Deno.test('safety: the rename is retried on a permission error', async () => {
  const dir = tempDir();
  const store = new ProjectPrefs(dir);
  const real = Deno.renameSync;
  let calls = 0;
  await patched('renameSync', (from: string | URL, to: string | URL) => {
    calls++;
    if (calls < 3) throw WIN ? new Deno.errors.PermissionDenied('busy') : new Deno.errors.Busy('busy');
    real(from, to);
  }, () => store.update({ set: { p: { name: 'x' } } }));
  assert(calls >= 3, `${calls}`);
  assert('p' in (readJson(file(dir, ProjectPrefs.FILE)).projects as object));
});

Deno.test('safety: real parse errors quarantine, invalid UTF-8 too', () => {
  for (
    const [cls, name] of [[ConversationState, 'studio-conversations'], [ProjectPrefs, 'studio-projects'], [
      SettingsStore,
      'studio-settings',
    ]] as const
  ) {
    const dir = tempDir();
    const path = file(dir, `${name}.json`);
    Deno.writeTextFileSync(path, '{not json');
    const store = new cls(dir);
    assert(exists(file(dir, `${name}.corrupt`)));
    assert(!exists(path));
    assert(store.warning);
  }
  const dir = tempDir();
  Deno.writeFileSync(file(dir, ProjectPrefs.FILE), new Uint8Array([0xff, 0xfe, 0x00, 0x62, 0x61, 0x64]));
  new ProjectPrefs(dir);
  assert(exists(file(dir, 'studio-projects.corrupt')));
});

Deno.test('safety: the lock times out instead of blocking forever; a held lock turns into "could not save"', async () => {
  const dir = tempDir();
  const holder = await new FileLock(file(dir, 'x.lock')).acquire();
  try {
    await assertRejects(() => new FileLock(file(dir, 'x.lock'), 200).acquire(), LockTimeout);
  } finally {
    holder.release();
  }
  const state = new ConversationState(dir);
  const lock = await new FileLock(state.path + '.lock').acquire();
  const real = FileLock.prototype.acquire;
  FileLock.prototype.acquire = function (this: FileLock) {
    return real.call(new FileLock(this.path, 100)).then(() => this);
  };
  try {
    const error = await assertRejects(() => state.apply('pin', 'omp', 'x'), ValueError);
    assertEquals(error.message, 'AIB could not save: Timed out waiting for the state file lock (studio-conversations.json.lock)');
  } finally {
    FileLock.prototype.acquire = real;
    lock.release();
  }
});

Deno.test('safety: concurrent updates in one process are serialized and lose nothing', async () => {
  const dir = tempDir();
  const a = new ConversationState(dir);
  const b = new ConversationState(dir);
  await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).apply('pin', 'omp', `c-${i}`)));
  assertEquals(Object.keys(readJson(file(dir, ConversationState.FILE)).entries as object).length, 40);
});
