/**
 * Open elsewhere for Codex, below the e2e test (work/deno/e2e_codex_open_elsewhere_test.ts runs the real Codex): the detector in
 * ownership/codex_threads.ts. The writer-lock check reads without locking: a file another handle holds with an exclusive OS lock (what
 * Codex's writer_lock.rs takes) reads as held, an unlocked leftover as free, and the check never takes the lock itself.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  activeWriterError,
  cliHolder,
  type CodexProcess,
  isCodexCli,
  procLocksHolder,
  writerLockPath,
  writerLockState,
} from '../../app/server/ownership/codex_threads.ts';
import { withUnloadNow } from '../../app/server/subagents/codex.ts';
import { OwnershipProbe } from '../../app/server/ownership/probe.ts';

const TID = '01a1ecea-c79b-7323-90b9-9bdf77fa9bf4';
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

function home(): string {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-cx-oe-' });
  Deno.mkdirSync(`${dir}${SEP}thread-writer-locks`);
  return dir;
}

Deno.test('writer lock: no file is free; an unlocked leftover (a crashed writer) is free; a locked one is held', async () => {
  const dir = home();
  const path = writerLockPath(dir, TID);
  try {
    assertEquals(path, `${dir}${SEP}thread-writer-locks${SEP}${TID}.lock`);
    assertEquals(writerLockState(path), { state: 'free' });
    Deno.writeFileSync(path, new Uint8Array()); // Codex's lock files are empty
    assertEquals(writerLockState(path), { state: 'free' });
    if (Deno.build.os !== 'windows' && Deno.build.os !== 'linux') return;
    // a writer: an exclusive lock on the file, as Rust's File::try_lock (LockFileEx on Windows, flock on Linux)
    const writer = await Deno.open(path, { read: true, write: true });
    try {
      await writer.lock(true);
      const held = writerLockState(path);
      assertEquals(held.state, 'held');
      if (Deno.build.os === 'linux') assertEquals((held as { pid: number }).pid, Deno.pid);
      // the check took no lock: the writer can let go and take it again at once, and the state follows
      await writer.unlock();
      assertEquals(writerLockState(path), { state: 'free' });
      await writer.lock(true);
      assertEquals(writerLockState(path).state, 'held');
    } finally {
      writer.close();
    }
    assertEquals(writerLockState(path), { state: 'free' });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('writer lock: /proc/locks lines name the flock holder of the inode; other inodes, POSIX locks and waiters do not', () => {
  const text = [
    '1: POSIX  ADVISORY  WRITE 900 00:2a:777 0 EOF',
    '2: FLOCK  ADVISORY  WRITE 4242 08:01:123456 0 EOF',
    '2: -> FLOCK  ADVISORY  WRITE 5151 08:01:123456 0 EOF',
    '3: FLOCK  ADVISORY  READ 77 08:01:999 0 EOF',
  ].join('\n');
  assertEquals(procLocksHolder(text, 123456), 4242);
  assertEquals(procLocksHolder(text, 777), 0);
  assertEquals(procLocksHolder(text, 999), 0);
  assertEquals(procLocksHolder('', 1), 0);
});

Deno.test('CLI holder: a Codex CLI process whose command line names the thread, never one of AIB own', () => {
  const procs: CodexProcess[] = [
    { pid: 10, ppid: 1, name: 'codex.exe', cmdline: `"C:\\x\\codex.exe" app-server -c hooks={}` }, // AIB's app-server: no thread
    { pid: 11, ppid: 1, name: 'codex.exe', cmdline: `codex.exe resume ${TID}` },
    {
      pid: 12,
      ppid: 1,
      name: 'node.exe',
      cmdline: `"C:\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume ${TID.toUpperCase()}`,
    },
    { pid: 13, ppid: 1, name: 'node.exe', cmdline: `node C:\\tools\\other.js ${TID}` }, // not Codex
    { pid: 14, ppid: 1, name: 'pwsh.exe', cmdline: `pwsh -c "codex resume ${TID}"` }, // the shell that started it: not the holder
  ];
  assertEquals(cliHolder(procs, TID, new Set()), { pid: 11, entrypoint: 'codex-cli', status: '', app: 'a terminal' });
  assertEquals(cliHolder(procs, TID, new Set([11]))?.pid, 12, 'the npm launcher counts too');
  assertEquals(cliHolder(procs, TID, new Set([11, 12])), null);
  assertEquals(cliHolder(procs, '01a1ecea-0000-7323-90b9-9bdf77fa9bf4', new Set()), null, 'another thread');
  assertEquals(cliHolder(procs, 'not-a-thread', new Set()), null);
  assert(isCodexCli({ name: '/usr/lib/node_modules/@openai/codex/bin/codex', cmdline: '' }));
  assert(isCodexCli({ name: 'node', cmdline: '/usr/bin/node /usr/lib/node_modules/@openai/codex/bin/codex.js exec resume x -' }));
  assert(!isCodexCli({ name: 'node', cmdline: 'node /x/codex-acp/dist/index.js' }), "codex-acp (AIB's adapter) is no CLI");
});

Deno.test('active writer: the refusal Codex answers a second opener with, through codex-acp or straight from the app-server', () => {
  assert(activeWriterError(new Error(`thread ${TID} already has an active writer`)));
  assert(activeWriterError({ code: -32600, message: `thread ${TID} already has an active writer` }));
  assert(!activeWriterError(new Error('thread not found')));
  assert(!activeWriterError(null));
});

Deno.test('CODEX_CONFIG: AIB chats unload a thread as soon as AIB lets go (the user config kept; a broken one left alone)', () => {
  assertEquals(JSON.parse(withUnloadNow(undefined)!), { thread_unload_delay_secs: 0 });
  assertEquals(JSON.parse(withUnloadNow('  ')!), { thread_unload_delay_secs: 0 });
  assertEquals(JSON.parse(withUnloadNow('{"model":"m","thread_unload_delay_secs":600}')!), { model: 'm', thread_unload_delay_secs: 0 });
  assertEquals(withUnloadNow('{not json'), null);
  assertEquals(withUnloadNow('[1]'), null);
});

Deno.test('probe: a saved Codex thread another app holds is a strong codex-writer reason (refused: no open-it-here-anyway)', () => {
  const probe = new OwnershipProbe({
    inspectProcesses: false,
    lockProbe: () => [],
    liveHolder: (_p, sid) => (sid === TID ? { pid: 0, app: 'another app' } : null),
  });
  const a = probe.assess('codex', TID, { deep: false });
  assertEquals(a.verdict, 'owned_elsewhere');
  assertEquals(a.reasons[0].signal, 'codex-writer');
  assertEquals(a.reasons[0].text, 'This conversation is open in another app (Codex lets only one app write to a chat at a time).');
  assertEquals(a.reasons[0].pid, undefined);
  assertEquals(probe.assess('codex', '01a1ecea-0000-7323-90b9-9bdf77fa9bf4', { deep: false }).verdict, 'no_evidence');
});

Deno.test('a model-server Codex entry (codex@strata) is checked in its own CODEX_HOME, never the default Codex home', async () => {
  if (Deno.build.os !== 'windows' && Deno.build.os !== 'linux') return;
  const { Handoff } = await import('../../app/server/ownership/handoff.ts');
  const entryHome = home();
  const path = writerLockPath(entryHome, TID);
  Deno.writeFileSync(path, new Uint8Array());
  const handoff = new Handoff({
    connections: () => [],
    codexHomeOf: (p) => (p === 'codex@strata' ? entryHome : null),
  });
  const before = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS');
  Deno.env.set('STUDIO_REAL_ADAPTER_TESTS', '1'); // fixtures are skipped under test otherwise; plain codex reads a throwaway home
  const writer = await Deno.open(path, { read: true, write: true });
  try {
    assertEquals(handoff.savedHolder('codex@strata', TID), null, 'unlocked leftover is free');
    await writer.lock(true);
    assertEquals(handoff.savedHolder('codex@strata', TID)?.entrypoint, 'codex-writer-lock');
    assertEquals(handoff.savedHolder('codex', TID), null, 'plain Codex looks in its own home, not the entry one');
  } finally {
    writer.close();
    if (before === undefined) Deno.env.delete('STUDIO_REAL_ADAPTER_TESTS');
    else Deno.env.set('STUDIO_REAL_ADAPTER_TESTS', before);
    Deno.removeSync(entryHome, { recursive: true });
  }
});
