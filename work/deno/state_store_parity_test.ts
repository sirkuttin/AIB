/**
 * server/state against state_store.py: parity (the same update sequences give the same public() output and the same error
 * messages) and interop (a Deno store reads what Python wrote and the other way round, a running store picks up the other
 * process's writes, and concurrent Python and Deno writers under the shared file lock lose nothing).
 * Python runs through work/parity/state_store_shim.py; only temp folders are used.
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  ConversationState,
  ProjectPrefs,
  ReadState,
  SettingsStore,
  StateStore,
  timing,
} from '../../outputs/agent-studio/server/state/store.ts';

Deno.env.set('AGENT_STUDIO_TEST', '1'); // inherited by the Python children
timing.readBackoffMs = 0;
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
const created: string[] = [];
globalThis.addEventListener('unload', () => {
  for (const dir of created) {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* still open */ }
  }
});

function tempDir(): string {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-state-parity-' });
  created.push(dir);
  return dir;
}

type Kind = 'conversations' | 'projects' | 'read' | 'settings' | 'recovery';
type Step = { call?: string; args?: unknown[]; kwargs?: Record<string, unknown>; reopen?: boolean };
type Store = ConversationState | ProjectPrefs | ReadState | SettingsStore | StateStore;

const STAMPS = new Set(['pinnedAt', 'archivedAt', 'deletedAt', 'holdAt', 'yourTurnAt', 'at', 'openedAt', 'lastSeen']);

/** Times differ between runs: a stamp becomes 'T' (set) or 0; a revision keeps only its counter (the nonce is random). */
function norm(value: unknown, key = ''): unknown {
  if (STAMPS.has(key) && typeof value === 'number') return value > 0 ? 'T' : 0;
  if (typeof value === 'string' && /^[0-9a-f]{6}\.[0-9]+$/.test(value)) return value.split('.')[1]; // a revision
  if (value instanceof Map) return norm(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map((v) => norm(v));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'savedAt') out[k] = norm(v, k);
    return out;
  }
  return value === undefined ? null : value;
}

/** As norm, without the revision: a fresh reader's counter differs from the writer's. */
function content(value: unknown): unknown {
  const out = norm(value) as Record<string, unknown>;
  delete out.revision;
  return out;
}

function open(kind: Kind, dir: string | null, name = 'recovery'): Store {
  switch (kind) {
    case 'conversations':
      return new ConversationState(dir);
    case 'projects':
      return new ProjectPrefs(dir);
    case 'read':
      return new ReadState(dir);
    case 'settings':
      return new SettingsStore(dir);
    default:
      return new StateStore(dir!, name);
  }
}

function recoveryDump(store: StateStore): unknown {
  return {
    conversations: [...store.conversations.values()],
    receipts: Object.fromEntries([...store.receipts].map(([k, v]) => [k, Object.fromEntries(v)])),
    warning: store.warning,
    loadedFromPrevious: store.loadedFromPrevious,
  };
}

function final(store: Store): unknown {
  return store instanceof StateStore ? recoveryDump(store) : store.public();
}

/** Python method name + kwargs -> the port's call. */
function call(store: Store, step: Step): unknown {
  const args = step.args ?? [];
  const kw = step.kwargs ?? {};
  const s = store as unknown as Record<string, (...a: unknown[]) => unknown>;
  switch (step.call) {
    case 'apply': {
      const [action, provider, sessionId, title = kw.title ?? '', cwd = kw.cwd ?? '', agentDeleted = kw.agent_deleted ?? false] = args;
      return s.apply(action, provider, sessionId, title, cwd, agentDeleted, kw.note ?? args[6] ?? '', kw.project_root ?? args[7] ?? '');
    }
    case 'remember_conversation':
      return s.rememberConversation(args[0], args[1], args[2], kw.title ?? args[3] ?? '', kw.project_root ?? args[4] ?? null);
    default: {
      const name = step.call!.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return s[name](...args);
    }
  }
}

async function runDeno(kind: Kind, dir: string | null, steps: Step[], name = 'recovery') {
  let store = open(kind, dir, name);
  const results: unknown[] = [];
  for (const step of steps) {
    if (step.reopen) {
      store = open(kind, dir, name);
      results.push({ ok: null });
      continue;
    }
    try {
      results.push({ ok: await call(store, step) });
    } catch (error) {
      results.push({ error: (error as Error).name, message: (error as Error).message });
    }
  }
  return { results, public: final(store) };
}

async function same(py: PyParity, kind: Kind, steps: Step[], label: string) {
  const expected = await py.call('state_store_shim', 'run', [kind, tempDir(), steps]);
  const actual = await runDeno(kind, tempDir(), steps);
  assertEquals(norm(actual), norm(expected), label);
  const memoryExpected = kind === 'recovery' ? null : await py.call('state_store_shim', 'run', [kind, null, steps]);
  if (memoryExpected) assertEquals(norm(await runDeno(kind, null, steps)), norm(memoryExpected), `${label} (in memory)`);
}

const c = (call: string, ...args: unknown[]): Step => ({ call, args });
const ck = (call: string, args: unknown[], kwargs: Record<string, unknown>): Step => ({ call, args, kwargs });
const REOPEN: Step = { reopen: true };

// ---- parity ------------------------------------------------------------------------------------------

Deno.test('parity: ConversationState sequences, errors and reloads', async () => {
  await using py = new PyParity();
  await same(py, 'conversations', [
    c('apply', 'pin', 'claude', 's1'),
    c('apply', 'pin', 'claude', 's1'),
    c('apply', 'archive', 'claude', 's1'),
    c('apply', 'pin', 'claude', 's1'),
    c('apply', 'hold', 'claude', 's1'),
    ck('apply', ['delete', 'claude', 's1'], { title: 'T'.repeat(300) + '😀', cwd: 'C:\\x', agent_deleted: 1 }),
    c('apply', 'hold', 'claude', 's1'),
    c('apply', 'restore', 'claude', 's1'),
    c('apply', 'unarchive', 'claude', 's1'),
    ck('apply', ['hold', 'omp', 's2'], { note: '  ' + 'n'.repeat(130) + '  ' }),
    c('apply', 'your_turn', 'omp', 's2'),
    c('apply', 'resume', 'omp', 's2'),
    c('apply', 'your_turn', 'omp', 's3'),
    c('apply', 'pin', 'omp', 's3'),
    c('apply', 'handled', 'omp', 's3'),
    ck('apply', ['delete', 'custom-x', 's4'], { cwd: 'C:\\wt', project_root: 'C:\\main' }),
    c('apply', 'bogus', 'claude', 's'),
    c('apply', null, 'claude', 's'),
    c('apply', 'pin', 'devin', 's'),
    c('apply', 'pin', 'claude', ''),
    c('apply', 'pin', 'claude', 5),
    c('apply', 'pin', 'claude', 'x'.repeat(513)),
    c('apply', 'pin', 'claude', 'a\tb'),
    c('apply', 'pin', 'claude', '😀'.repeat(512)),
    REOPEN,
    c('revision'),
    c('apply', 'unpin', 'omp', 's3'),
    c('revision'),
  ], 'conversations');
});

Deno.test('parity: ProjectPrefs sequences and errors', async () => {
  await using py = new PyParity();
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, { name: 'x' }]));
  await same(py, 'projects', [
    c('update', { set: { 'w:c/a': { name: '  My \x01  app ', color: 'blue' } } }),
    c('update', { set: { 'w:c/a': { hidden: true, muted: true, useWorkspace: true } } }),
    c('update', { order: ['b', 'a', 'b', '', 5, 'c', 'x\ny'] }),
    c('update', { set: { '10': { name: 'ten' }, '2': { color: 'teal' }, z: { name: '😀'.repeat(70) } } }),
    c('update', { set: { k: { color: 'chartreuse' } } }),
    c('update', { set: { k: { hidden: 'yes' } } }),
    c('update', { set: { k: { name: 5 } } }),
    c('update', { set: { k: { muted: 1 } } }),
    c('update', { set: { k: { useWorkspace: null } } }),
    c('update', { set: { k: 'x' } }),
    c('update', { set: { '': { name: 'x' } } }),
    c('update', { set: many }),
    c('update', { set: [] }),
    c('update', { order: 'x' }),
    c('update', []),
    c('update', { set: { b: { name: 'B' }, c: { color: 'nope' } } }),
    c('update', { set: { 'w:c/a': { name: '', color: '', hidden: false, muted: false } } }),
    REOPEN,
    c('update', {}),
    c('revision'),
  ], 'projects');
});

Deno.test('parity: ReadState sequences and errors', async () => {
  await using py = new PyParity();
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`a:${i}`, { seenAt: 1 }]));
  await same(py, 'read', [
    c('update', { set: { 'claude:abc': { seenAt: 1000, seenIndex: 4 } } }),
    c('update', { set: { 'claude:abc': { seenAt: 900, seenIndex: 9 } } }),
    c('update', { set: { 'claude:abc': { seenAt: 2000.7 } } }),
    c('update', { set: { 'claude:abc': { seenAt: 2000, seenIndex: 2 } } }),
    c('update', { set: { 'omp:x': { seenAt: 5, seenIndex: 3.9 }, 'custom-a:b': { seenAt: 0 } } }),
    c('update', { set: { 'omp:x': { seenAt: 5, seenIndex: 3 } } }),
    c('update', []),
    c('update', { set: [] }),
    c('update', { set: { nocolon: { seenAt: 1 } } }),
    c('update', { set: { 'Bad:x': { seenAt: 1 } } }),
    c('update', { set: { 'a:b': { seenAt: -1 } } }),
    c('update', { set: { 'a:b': { seenAt: true } } }),
    c('update', { set: { 'a:b': { seenAt: 1e18 } } }),
    c('update', { set: { 'a:b': { seenAt: 1, seenIndex: -1 } } }),
    c('update', { set: { 'a:b': 5 } }),
    c('update', { set: many }),
    REOPEN,
    c('revision'),
  ], 'read');
});

Deno.test('parity: SettingsStore sequences and errors', async () => {
  await using py = new PyParity();
  const python = WIN ? 'python' : 'python3'; // a bare name: both look it up on PATH and keep what was typed
  const agent = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    command: python,
    args: 'a\n\n --b \r\nc d',
    env: 'A=1\n# c\nB_2=x=y',
    ...extra,
  });
  await same(py, 'settings', [
    c('snapshot'),
    c('update', { agents: { upsert: agent('  My\tAgent  ') } }),
    c('update', { agents: { upsert: { id: 'custom-my-agent', name: 'Renamed', command: python, env: [{ name: 'A', value: null }] } } }),
    c('update', { agents: { upsert: agent('Second', { enabled: false }) } }),
    c('update', { agents: { enabled: { 'custom-second': true, codex: false } } }),
    c('update', { agents: { builtin: { claude: false } } }),
    c('update', { defaults: { agent: 'custom-my-agent', byAgent: { 'custom-my-agent': { model: ' m1\x00 ' } }, migrated: true } }),
    c('update', { defaults: { projects: { 'w:c/x': { agent: 'custom-my-agent', mode: 'plan' }, 'w:c/y': { model: 'opus' } } } }),
    c('update', { agents: { remove: 'custom-my-agent' } }),
    c('update', { editors: { default: 'windsurf' }, appearance: { defaultView: 'chat' }, server: { worktreePerChat: true } }),
    c('update', { server: { autoReconnect: false, autoUpdateCheck: false } }),
    c('update', { server: { autoReconnect: false } }),
    c('update', []),
    c('update', {}),
    c('update', { zeta: 1, alpha: 2, ['x'.repeat(40)]: 3 }),
    c('update', { agents: 'x' }),
    c('update', { agents: { other: 1 } }),
    c('update', { agents: { enabled: { 'custom-nope': true } } }),
    c('update', { agents: { enabled: { omp: 'yes' } } }),
    c('update', { agents: { builtin: { gemini: true } } }),
    c('update', { agents: { remove: 'omp' } }),
    c('update', { agents: { remove: 'custom-nope' } }),
    c('update', { agents: { upsert: 'x' } }),
    c('update', { agents: { upsert: agent('OMP') } }),
    c('update', { agents: { upsert: agent('second') } }),
    c('update', { agents: { upsert: agent('Three', { command: 'no-such-program-xyz' }) } }),
    c('update', { agents: { upsert: agent('Three', { command: 'rel/dir/prog' }) } }),
    c('update', { agents: { upsert: agent('Three', { env: [{ name: '1bad', value: '' }] }) } }),
    c('update', { agents: { upsert: agent('Three', { env: 'A=1\nA=2' }) } }),
    c('update', { agents: { upsert: agent('Three', { args: [1] }) } }),
    c('update', { agents: { upsert: agent('', {}) } }),
    c('update', { agents: { upsert: agent('Three', { enabled: 'yes' }) } }),
    c('update', { agents: { upsert: { ...agent('X'), id: 'custom-missing' } } }),
    c('update', { defaults: { agent: 'nonesuch' } }), // not 'gemini': that is a Beta agent in the Deno port (beta_catalog.ts)
    c('update', { defaults: { migrated: 'yes' } }),
    c('update', { defaults: { byAgent: { zzz: { model: 'm' } } } }),
    c('update', { defaults: { byAgent: { omp: { model: 5 } } } }),
    c('update', { defaults: { projects: { k: { agent: 'nope' } } } }),
    c('update', { defaults: { projects: { '': {} } } }),
    c('update', { defaults: { unknown: 1 } }),
    c('update', { editors: { default: 'notepad' } }),
    c('update', { editors: { other: 1 } }),
    c('update', { appearance: { defaultView: 'prompts' } }),
    c('update', { launchers: { omp: 'x' } }),
    c('update', { launchers: { claude: 'relative.js' } }),
    c('update', { server: { autoReconnect: 'yes' } }),
    c('update', { server: { worktreePerChat: 1 } }),
    c('update', { server: { x: 1 } }),
    REOPEN,
    c('custom_agents'),
    c('builtin_enabled', 'claude'),
    c('launcher', 'codex'),
    c('worktree_per_chat'),
    c('auto_update_check'),
    c('revision'),
  ], 'settings');
});

Deno.test('parity: worktree per chat is on by default (fresh store, hidden from the page)', async () => {
  await using py = new PyParity();
  await same(py, 'settings', [c('worktree_per_chat'), c('snapshot'), c('public'), REOPEN, c('worktree_per_chat')], 'settings default');
  const store = new SettingsStore(tempDir());
  assertEquals(store.worktreePerChat(), true);
});

Deno.test('parity: StateStore recovery sequences', async () => {
  await using py = new PyParity();
  const receipts = Array.from({ length: 205 }, (_, i) => c('set_receipt', 'claude', 's', `${i}`, 'f', 'finished'));
  const conversations = Array.from({ length: 53 }, (_, i) => c('remember_conversation', 'omp', `session-${i}`, 'C:/x'));
  await same(py, 'recovery', [
    ck('remember_conversation', ['omp', 'a', 'C:\\proj\\wt'], { title: 'T'.repeat(250), project_root: 'C:\\proj' }),
    c('remember_conversation', 'evil', 'a', 'C:/x'),
    c('remember_conversation', 'omp', '', 'C:/x'),
    c('set_receipt', 'omp', 'a', 'm1', 'f1', 'working'),
    c('set_receipt', 'omp', 'a', 'm2', 'f2', 'finished'),
    c('set_receipt', 'omp', 'a', 'm3', 'f3', 'bogus'),
    c('dismiss_receipt', 'omp', 'a', 'm2'),
    REOPEN,
    c('unknown_receipts', 'omp', 'a'),
    c('dismiss_receipt', 'omp', 'a', 'm1'),
    c('unknown_count', 'omp', 'a'),
    c('receipt', 'omp', 'a', 'm1'),
    c('set_receipt', 'omp', 'a', 'm4', 'f4', 'working'),
    c('mark_working_unknown'),
    c('forget_conversation', 'omp', 'a'),
    c('forget_conversation', 'omp', 'a'),
    ...receipts,
    ...conversations,
    REOPEN,
    c('receipt', 'claude', 's', '4'),
    c('receipt', 'claude', 's', '5'),
  ], 'recovery');
});

Deno.test('parity: hand-edited and odd files load the same', async () => {
  await using py = new PyParity();
  const files: [Kind, string, string][] = [
    [
      'conversations',
      ConversationState.FILE,
      JSON.stringify({
        version: 1,
        entries: {
          'claude:good': { pinnedAt: '5', title: 'ok' },
          'claude:bool': { archivedAt: true },
          'claude:neg': { pinnedAt: -3 },
          'claude:nan': { pinnedAt: 'abc' },
          'claude:big': { deletedAt: 9, agentDeleted: 'yes', title: 'y'.repeat(999), projectRoot: '' },
          'claude:hold': { holdAt: 1e300, holdNote: ' x ' },
          'claude:inf': { holdAt: 'inf' },
          'claude:': { pinnedAt: 1 },
        },
      }),
    ],
    ['conversations', ConversationState.FILE, '{"version":1,"entries":{"omp:a":{"pinnedAt":NaN,"archivedAt":Infinity,"deletedAt":2}}}'],
    ['conversations', ConversationState.FILE, '[]'],
    ['conversations', ConversationState.FILE, '\ufeff{}'],
    [
      'projects',
      ProjectPrefs.FILE,
      JSON.stringify({
        version: 1,
        order: ['a', 'a', 3, '10', '2'],
        projects: { a: { name: 'ok', color: 'zzz', hidden: 'true' }, '10': { muted: true }, '2': { useWorkspace: true }, b: 'nope' },
      }),
    ],
    [
      'read',
      ReadState.FILE,
      JSON.stringify({
        version: 1,
        chats: {
          'omp:a': { seenAt: 5.9, seenIndex: 2, at: 3 },
          'omp:b': { seenAt: 'x' },
          'Bad:c': { seenAt: 1 },
          'omp:d': { seenAt: 1, at: true },
        },
      }),
    ],
    ['read', ReadState.FILE, '{"version":2,"chats":{}}'],
    [
      'settings',
      SettingsStore.FILE,
      JSON.stringify({
        version: 1,
        agents: {
          builtin: { omp: 'no', claude: false },
          custom: [{ id: 'custom-ok', name: 'Ok', command: 'prog  x', args: ['a'], env: [{ name: 'A', value: '1' }] }, {
            id: 'custom-ok',
            name: 'Dup',
            command: 'x',
          }, { id: 'custom-nocmd', name: 'N' }],
        },
        defaults: {
          agent: 'custom-ok',
          byAgent: { omp: { model: 'm' }, bad: { model: 'm' } },
          projects: { k: { agent: 'custom-ok', model: 5 }, j: {} },
        },
        server: { autoReconnect: 'x', worktreePerChat: true },
        editors: { default: 'code' },
        appearance: { defaultView: 'prompts' },
        launchers: { claude: '  C:\\x\\launch.js  ', codex: 5 },
      }),
    ],
    [
      'recovery',
      'studio-recovery.json',
      JSON.stringify({
        version: 1,
        conversations: [{ provider: 'omp', sessionId: 's', cwd: 'c', openedAt: '12.5', lastSeen: null }, 5],
        receipts: {
          'omp:s': {
            '2': { fingerprint: 'f', state: 'finished', at: 1 },
            '1': { fingerprint: 'g', state: 'unknown', dismissed: true },
            x: 5,
          },
        },
      }),
    ],
  ];
  for (const [kind, name, text] of files) {
    const dir = tempDir();
    Deno.writeTextFileSync(`${dir}${SEP}${name}`, text);
    const actual = norm(final(open(kind, dir)));
    const pyDir = tempDir();
    Deno.writeTextFileSync(`${pyDir}${SEP}${name}`, text);
    assertEquals(actual, norm(await py.call('state_store_shim', 'public', [kind, pyDir])), `${kind}: ${text.slice(0, 60)}`);
  }
});

// ---- interop -----------------------------------------------------------------------------------------

const WRITES: Record<Exclude<Kind, 'recovery'>, Step[]> = {
  conversations: [
    c('apply', 'pin', 'claude', 's1'),
    ck('apply', ['hold', 'omp', 's2'], { note: 'é 😀' }),
    ck('apply', ['delete', 'omp', 's3'], { title: 'T', cwd: 'C:\\x' }),
  ],
  projects: [
    c('update', { set: { 'w:c/a': { name: 'App é', color: 'teal', muted: true }, '7': { hidden: true } }, order: ['7', 'w:c/a'] }),
  ],
  read: [c('update', { set: { 'claude:a': { seenAt: 1000, seenIndex: 4 }, 'omp:b': { seenAt: 5 } } })],
  settings: [c('update', {
    defaults: { agent: 'claude', projects: { 'w:c/a': { model: 'opus' } } },
    server: { autoReconnect: false },
    editors: { default: 'cursor' },
  })],
};

Deno.test('interop: Deno writes, Python reads; Python writes, Deno reads (every store)', async () => {
  await using py = new PyParity();
  for (const [kind, steps] of Object.entries(WRITES) as [Kind, Step[]][]) {
    const dir = tempDir();
    const written = await runDeno(kind, dir, steps);
    assertEquals(content(await py.call('state_store_shim', 'public', [kind, dir])), content(written.public), `${kind}: Deno -> Python`);
    const other = tempDir();
    const pyWritten = (await py.call('state_store_shim', 'run', [kind, other, steps])) as { public: unknown };
    assertEquals(content(final(open(kind, other))), content(pyWritten.public), `${kind}: Python -> Deno`);
  }
  const dir = tempDir();
  const steps = [
    c('remember_conversation', 'omp', 'a', 'C:/w', 'T'),
    c('set_receipt', 'omp', 'a', '3', 'f', 'working'),
    c('set_receipt', 'omp', 'a', '1', 'g', 'finished'),
  ];
  await runDeno('recovery', dir, steps);
  const pyRead = await py.call('state_store_shim', 'public', ['recovery', dir]);
  assertEquals(content(pyRead), content(final(open('recovery', dir))), 'recovery: Deno -> Python (working became unknown on both)');
  const other = tempDir();
  await py.call('state_store_shim', 'run', ['recovery', other, steps]);
  const store = open('recovery', other) as StateStore;
  assertEquals([...store.receipts.get('omp:a')!.keys()], ['3', '1'], 'receipt order kept across processes');
  assertEquals(
    content(final(store)),
    content(await py.call('state_store_shim', 'public', ['recovery', other])),
    'recovery: Python -> Deno',
  );
});

Deno.test("interop: a running store picks up the other process's writes (reload on change)", async () => {
  await using py = new PyParity();
  const dir = tempDir();
  const deno = new ConversationState(dir);
  const before = deno.revision();
  await py.call('state_store_shim', 'run', ['conversations', dir, [c('apply', 'pin', 'omp', 'from-python')]]);
  assert('omp:from-python' in deno.public().entries);
  assert(deno.revision() !== before);
  await deno.apply('archive', 'claude', 'from-deno');
  const seen = (await py.call('state_store_shim', 'run', ['conversations', dir, [c('apply', 'unpin', 'omp', 'from-python')]])) as {
    public: { entries: Record<string, unknown> };
  };
  assertEquals(Object.keys(seen.public.entries), ['claude:from-deno'], 'Python kept the Deno mark while changing its own');
  const settings = new SettingsStore(dir);
  await py.call('state_store_shim', 'run', ['settings', dir, [c('update', { agents: { builtin: { omp: false } } })]]);
  assertEquals(settings.builtinEnabled('omp'), false);
});

Deno.test('interop: one Python and one Deno writer, 50 entries each, lose nothing (every locked store)', async () => {
  await using py = new PyParity();
  for (const kind of ['conversations', 'projects', 'read', 'settings'] as const) {
    const dir = tempDir();
    const pythonDone = py.call('state_store_shim', 'add_many', [kind, dir, 'py', 50, 0.004]);
    const names = {
      conversations: ConversationState.FILE,
      projects: ProjectPrefs.FILE,
      read: ReadState.FILE,
      settings: SettingsStore.FILE,
    };
    for (let wait = 0; wait < 500; wait++) { // start once Python is writing
      try {
        Deno.statSync(`${dir}${SEP}${names[kind]}`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const store = open(kind, dir);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 4));
      if (store instanceof ConversationState) await store.apply('pin', 'omp', `deno-${i}`);
      else if (store instanceof ProjectPrefs) await store.update({ set: { [`deno-${i}`]: { name: 'n' } } });
      else if (store instanceof ReadState) await store.update({ set: { [`omp:deno-${i}`]: { seenAt: i + 1 } } });
      else if (store instanceof SettingsStore) await store.update({ defaults: { projects: { [`deno-${i}`]: { model: 'm' } } } });
    }
    assertEquals(await pythonDone, 50);
    const pub = (await py.call('state_store_shim', 'public', [kind, dir])) as Record<string, Record<string, unknown>>;
    const keys = kind === 'conversations'
      ? Object.keys(pub.entries)
      : kind === 'projects'
      ? Object.keys(pub.projects)
      : kind === 'read'
      ? Object.keys(pub.chats)
      : Object.keys((pub.settings as Record<string, Record<string, object>>).defaults.projects);
    assertEquals(keys.length, 100, `${kind}: ${keys.length} entries`);
    assertEquals(keys.filter((k) => k.includes('py-')).length, 50, kind);
    const switches = keys.slice(1).filter((k, i) => k.includes('py-') !== keys[i].includes('py-')).length;
    assert(switches > 1, `${kind}: the two writers really ran at the same time (${switches} switches)`);
    assertEquals(content(final(open(kind, dir))), content(pub), `${kind}: both readers agree`);
  }
});
