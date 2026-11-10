/**
 * server/ownership/ownership.ts: the cases of work/test_ownership.py, parity with ownership.py (find_external_owner, shlex, lease
 * file names), and interop: a lease held by Python blocks Deno and one held by Deno blocks Python (same file, same lock).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { findExternalOwner, OwnershipConflict, SessionLease, shlexSplit } from '../../outputs/agent-studio/server/ownership/ownership.ts';
import { join } from '../../outputs/agent-studio/server/platform/ospath.ts';

const WINDOWS = Deno.build.os === 'windows';

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = Deno.makeTempDirSync({ prefix: 'lease-test-' });
  try {
    await fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test('acquire, conflict, release and reacquire', () =>
  withDir(async (dir) => {
    const first = await new SessionLease(dir, 'claude', 's-1').acquire();
    try {
      const error = await assertRejects(() => new SessionLease(dir, 'claude', 's-1').acquire(), OwnershipConflict);
      assertEquals(error.message, "Session 's-1' is already owned for provider 'claude'");
    } finally {
      first.release();
      first.release();
    }
    (await new SessionLease(dir, 'claude', 's-1').acquire()).release();
    if (WINDOWS) assertEquals(Deno.statSync(first.path).size, 1, 'an empty lease file gets one NUL byte, like Python');
  }));

Deno.test('providers are separate', () =>
  withDir(async (dir) => {
    const claude = await new SessionLease(dir, 'claude', 'same').acquire();
    const omp = await new SessionLease(dir, 'omp', 'same').acquire();
    omp.release();
    claude.release();
  }));

Deno.test('atPath with create=false never creates the file and reports a missing one as a conflict', () =>
  withDir(async (dir) => {
    const missing = SessionLease.atPath(join(dir, 'session-leases', 'x.lock'));
    await assertRejects(() => missing.acquire(false), OwnershipConflict);
    assertEquals([...Deno.readDirSync(dir)], []);
    const held = await new SessionLease(dir, 'omp', 'z').acquire();
    await assertRejects(() => SessionLease.atPath(held.path).acquire(false), OwnershipConflict);
    held.release();
    (await SessionLease.atPath(held.path).acquire(false)).release();
  }));

Deno.test('lease file names match Python for every kind of id', async () => {
  await using py = new PyParity();
  const dir = Deno.makeTempDirSync({ prefix: 'lease-names-' });
  try {
    for (
      const [provider, session] of [
        ['claude', 's-1'],
        ['omp', 'ü😀'],
        ['x', 'quote " back \\ slash'],
        ['', ''],
        ['omp', 'ctl\n\t\x01\x7f'],
        ['p', '\u2028'],
      ]
    ) {
      assertEquals(
        new SessionLease(dir, provider, session).path,
        await py.call('ownership_shim', 'lease_path', [dir, provider, session]),
        session,
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('a Python lease blocks Deno and a Deno lease blocks Python', async () => {
  await using py = new PyParity();
  await withDir(async (dir) => {
    assertEquals(Object.keys(await py.call('ownership_shim', 'hold_lease', [dir, 'claude', 'shared']) as object), ['held']);
    try {
      const error = await assertRejects(() => new SessionLease(dir, 'claude', 'shared').acquire(), OwnershipConflict);
      assert(error.message.includes("'shared'"));
      await assertRejects(() => SessionLease.atPath(new SessionLease(dir, 'claude', 'shared').path).acquire(false), OwnershipConflict);
    } finally {
      await py.call('ownership_shim', 'release_leases');
    }
    const lease = await new SessionLease(dir, 'claude', 'shared').acquire();
    try {
      assertEquals(await py.call('ownership_shim', 'try_lease', [dir, 'claude', 'shared']), {
        conflict: "Session 'shared' is already owned for provider 'claude'",
      });
      assertEquals(await py.call('ownership_shim', 'try_lease_at', [lease.path]), 'conflict');
      assertEquals(await py.call('ownership_shim', 'try_lease', [dir, 'omp', 'shared']), { ok: true });
    } finally {
      lease.release();
    }
    assertEquals(await py.call('ownership_shim', 'try_lease', [dir, 'claude', 'shared']), { ok: true });
  });
});

const processes = [
  { pid: 10, name: 'claude.exe', CommandLine: 'claude --resume abc123' },
  { pid: 11, name: 'omp.exe', CommandLine: 'omp --session-id=abc123' },
  { pid: 12, name: 'omp.exe', CommandLine: 'omp acp --verbose' },
];

Deno.test('exact session matching, provider, exclusions (test_ownership.py)', () => {
  assertEquals(findExternalOwner(processes, 'claude', 'abc123'), 10);
  assertEquals(findExternalOwner(processes, 'omp', 'abc123'), 11);
  assertEquals(findExternalOwner(processes, 'claude', 'abc'), null);
  assertEquals(findExternalOwner(processes, 'claude', '11'), null);
  assertEquals(findExternalOwner(processes, 'claude', 'abc123', [10]), null);
  assertEquals(findExternalOwner(processes, 'omp', 'abc123', [11]), null);
  assertEquals(findExternalOwner(processes, 'omp', 'anything'), null);
  const program = WINDOWS ? '"C:\\Program Files\\Claude\\claude.exe"' : '"/opt/Claude App/claude"';
  const quoted = [{ pid: 30, name: WINDOWS ? 'claude.exe' : 'claude', CommandLine: program + ' --resume "full-session-id"' }];
  assertEquals(findExternalOwner(quoted, 'claude', 'full-session-id'), 30);
  assertEquals(findExternalOwner(quoted, 'claude', 'full-session'), null);
});

Deno.test('findExternalOwner and shlex.split match Python', async () => {
  await using py = new PyParity();
  const lists: unknown[][] = [
    processes,
    [{ pid: '40', Name: 'OMP.EXE', commandline: 'omp --resume=x1' }],
    [{ ProcessId: 41, executable: '/usr/bin/claude', cmdline: ['claude', '--session-id', 'x1'] }],
    [{ pid: 42, argv: ['C:\\bin\\claude.exe', '--resume', '"x1"'] }],
    [{ pid: 43, name: '', commandline: 'claude --resume x1' }],
    [{ pid: 44, commandline: 'claude --resume x1' }],
    [{ pid: 45, name: 'claude', commandline: 'claude --resume "x1' }],
    [{ pid: 'bad', name: 'claude', commandline: 'claude --resume x1' }, { pid: null, name: 'claude' }, 'x', null],
    [{ pid: 46, name: 'node.exe', commandline: 'claude --resume x1' }],
    [{ pid: 47, name: 'claude', commandline: "claude --resume 'x1'" }],
    [{ pid: 48, name: 'claude', commandline: 'claude --resume x\\"1' }],
  ];
  for (const list of lists) {
    for (
      const [provider, session] of [['claude', 'x1'], ['omp', 'x1'], ['CLAUDE', 'x1'], ['devin', 'x1'], ['omp', 'abc123'], [
        'claude',
        'abc123',
      ]]
    ) {
      assertEquals(
        findExternalOwner(list, provider, session),
        await py.call('ownership', 'find_external_owner', [list, provider, session]),
        JSON.stringify([list, provider]),
      );
    }
  }
  const lines = [
    'a b  c',
    ' "quoted arg" tail',
    "it's",
    'x"y z"w',
    '"a"b c',
    'C:\\Program Files\\x.exe --flag',
    'esc\\ aped "in \\" q" \'s \\ q\'',
    '""',
    "''",
    'a ""',
    '"unclosed',
    'trail\\',
    '\t\nmixed\r\nlines ',
    '',
    'a="b c" d',
    '"" ""',
  ];
  for (const line of lines) {
    for (const posix of [true, false]) {
      const expected = await py.raw('shlex', 'split', [line], { posix });
      let actual: unknown;
      try {
        actual = { ok: shlexSplit(line, posix) };
      } catch (error) {
        actual = { error: 'ValueError', message: (error as Error).message };
      }
      assertEquals(actual, expected, JSON.stringify([line, posix]));
    }
  }
});
