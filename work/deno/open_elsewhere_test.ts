/**
 * Open elsewhere, the parts below the e2e test (work/test_open_elsewhere_e2e.py runs the real CLI): Claude Code's session registry
 * reader (ownership/claude_sessions.ts), which of a session/load's history is outside (acp/connection.ts outsideTurns), the WSL
 * helper's `sessions.held` and the probe's strong reason.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  appName,
  filetimeSeconds,
  holderOf,
  liveOnWindows,
  parseRecord,
  readRecords,
} from '../../app/server/ownership/claude_sessions.ts';
import { outsideTurns } from '../../app/server/acp/connection.ts';
import { bgtaskMethods } from '../../app/server/wsl/helper/bgtasks.ts';
import { Store } from '../../app/server/transcripts/store.ts';
import { OwnershipProbe, type ProcInfo } from '../../app/server/ownership/probe.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const join = (...parts: string[]) => parts.join(SEP);
type Json = Record<string, unknown>;

function registry(records: Record<string, unknown>): string {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-oe-reg-' });
  Deno.mkdirSync(join(dir, 'sessions'));
  for (const [name, body] of Object.entries(records)) {
    Deno.writeTextFileSync(join(dir, 'sessions', name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

Deno.test('registry: digits-only <pid>.json files are read leniently; anything else is no evidence', () => {
  const dir = registry({
    '101.json': { pid: 101, sessionId: 's-1', entrypoint: 'claude-vscode', status: 'idle', procStart: '134393593631346064', extra: [1] },
    '102.json': { sessionId: 's-2', entrypoint: 'cli' }, // no pid field: the file name's
    '103.json': '{not json',
    '104.json': { pid: 104 }, // no session
    '105.12ab.key': 'token',
    'x.json': { pid: 9, sessionId: 's-9' },
  });
  try {
    const got = readRecords(dir).sort((a, b) => a.pid - b.pid);
    assertEquals(got.map((r) => [r.pid, r.sessionId, r.entrypoint]), [[101, 's-1', 'claude-vscode'], [102, 's-2', 'cli']]);
    assertEquals(readRecords(join(dir, 'missing')), []);
    assertEquals(parseRecord('[]'), null);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('registry: the app named from the entrypoint; AIB own pids never hold', () => {
  assertEquals(['claude-vscode', 'cli', 'sdk-cli', 'claude-desktop', 'sdk-ts', ''].map(appName), [
    'VS Code',
    'a terminal',
    'a terminal',
    'Claude Desktop',
    'another app',
    'another app',
  ]);
  const recs = [
    { pid: 1, sessionId: 's', entrypoint: 'sdk-ts', status: 'idle', procStart: '', pidDomain: '', cwd: '', startedAt: 0 },
    { pid: 2, sessionId: 's', entrypoint: 'claude-vscode', status: 'idle', procStart: '', pidDomain: '', cwd: '', startedAt: 0 },
  ];
  assertEquals(holderOf(recs, 's', new Set([1]))?.app, 'VS Code');
  assertEquals(holderOf(recs, 's', new Set([1, 2])), null);
  assertEquals(holderOf(recs, 'other', new Set()), null);
});

Deno.test({
  name: 'registry (Windows): a live process with its creation time holds; a dead pid, another start time or another computer do not',
  ignore: Deno.build.os !== 'windows',
  fn() {
    const created = Math.round(filetimeSeconds('134393593631346064') ?? 0);
    assert(created > 1_700_000_000, String(created));
    const me = { pid: Deno.pid, sessionId: 's', entrypoint: 'cli', status: 'idle', procStart: '', pidDomain: '', cwd: '', startedAt: 0 };
    assert(liveOnWindows(me), 'no procStart: alive is enough');
    assert(!liveOnWindows({ ...me, procStart: '116444736000000000' }), 'a start time of 1970 is another process');
    assert(!liveOnWindows({ ...me, pidDomain: 'win32:some-other-pc' }));
    assert(!liveOnWindows({ ...me, pidDomain: 'linux:abc:4026531836' }));
    assert(!liveOnWindows({ ...me, pid: 4_000_000_000 }), 'a pid that does not run');
  },
});

const u = (kind: string, text = '', sessionId = 'S'): Json => ({
  sessionId,
  update: { sessionUpdate: kind, content: { type: 'text', text } },
});

Deno.test('outsideTurns: only the turns after the last user message the chat showed come back', () => {
  const history = [
    u('user_message_chunk', '<context>'),
    u('user_message_chunk', 'the codeword is ALPHA'),
    u('agent_message_chunk', 'STUB codeword=ALPHA'),
    u('user_message_chunk', 'Typed elsewhere: BETA'),
    u('agent_thought_chunk', 'hmm'),
    u('agent_message_chunk', 'STUB codeword=BETA'),
    u('user_message_chunk', 'and GAMMA'),
    u('agent_message_chunk', 'ok'),
  ];
  const out = outsideTurns(history, 'the codeword is ALPHA');
  assertEquals(out.turns, 2);
  assertEquals(out.updates.length, 5);
  assertEquals(outsideTurns(history, 'and GAMMA'), { updates: [], turns: 0 }, 'nothing happened elsewhere');
  assertEquals(outsideTurns(history, 'never said'), { updates: [], turns: 0 }, 'not found: nothing is shown twice');
  assertEquals(outsideTurns(history, '').turns, 3, 'a chat that showed no user message: everything is outside');
  assertEquals(outsideTurns([], 'x'), { updates: [], turns: 0 });
  // the same text twice: the LAST one is the chat's own
  const twice = [
    u('user_message_chunk', 'go'),
    u('agent_message_chunk', '1'),
    u('user_message_chunk', 'go'),
    u('agent_message_chunk', '2'),
  ];
  assertEquals(outsideTurns(twice, 'go'), { updates: [], turns: 0 });
});

Deno.test('helper sessions.held: a live Claude Code process of the distro holds; AIB-excluded trees, dead pids and other sessions do not', async () => {
  const dir = registry({
    '50.json': { pid: 50, sessionId: 'sess-1', entrypoint: 'claude-vscode', status: 'idle', pidDomain: 'linux:m:1' },
    '61.json': { pid: 61, sessionId: 'sess-2', entrypoint: 'sdk-ts', status: 'busy' }, // AIB's own (below 60)
    '70.json': { pid: 70, sessionId: 'sess-3', entrypoint: 'cli', status: 'idle' }, // its process is gone
    '80.json': { pid: 80, sessionId: 'sess-4', entrypoint: 'cli', status: 'idle', pidDomain: 'win32:pc' },
  });
  Deno.mkdirSync(join(dir, 'projects'));
  try {
    const procs: ProcInfo[] = [
      { pid: 50, ppid: 1, name: 'claude', cmdline: 'claude', cwd: '/x' },
      { pid: 60, ppid: 1, name: 'node', cmdline: 'node adapter', cwd: '/x' },
      { pid: 61, ppid: 60, name: 'claude', cmdline: 'claude', cwd: '/x' },
      { pid: 80, ppid: 1, name: 'claude', cmdline: 'claude', cwd: '/x' },
    ];
    const m = bgtaskMethods({
      env: () => Promise.resolve({ env: {}, home: '/home/u' }),
      store: async () => await Store.open(join(dir, 'projects')),
      processes: () => procs,
      holders: () => [],
    });
    const held = await m['sessions.held']({
      sessionIds: ['sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-5'],
      exclude: [60],
      claudeDir: dir,
    }) as {
      held: Record<string, Json>;
    };
    assertEquals(held.held, { 'sess-1': { pid: 50, entrypoint: 'claude-vscode', status: 'idle' } });
    assertEquals((await m['sessions.held']({ sessionIds: [], claudeDir: dir }) as Json).held, {});
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('probe: a live holder in the session registry is strong evidence (owned_elsewhere)', () => {
  const probe = new OwnershipProbe({
    inspectProcesses: false,
    lockProbe: () => [],
    liveHolder: (_p, sid) => (sid === 'held' ? { pid: 4242, app: 'VS Code' } : null),
  });
  const a = probe.assess('claude', 'held', { deep: false });
  assertEquals(a.verdict, 'owned_elsewhere');
  assertEquals(a.reasons[0].signal, 'session-registry');
  assertEquals(a.reasons[0].text, 'This conversation is open in VS Code (a running Claude Code process, PID 4242).');
  assertEquals(probe.assess('claude', 'free', { deep: false }).verdict, 'no_evidence');
});
