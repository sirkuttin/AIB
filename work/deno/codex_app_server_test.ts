/**
 * Open elsewhere for Codex, the app-server half (ownership/codex_apps.ts, handoff.ts, the WSL helper's `codex.scan`): who started a
 * `codex app-server` (VS Code, Codex Desktop, AIB's own, anything else), when AIB lets go because of one, and the distro's shell
 * scripts against a real WSL distro (skipped without one). The real Codex runs in work/test_codex_open_elsewhere_e2e.py.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  appServerLine,
  appServers,
  classifyAppServer,
  isAppServer,
  ownClosure,
  parsePsTable,
} from '../../app/server/ownership/codex_apps.ts';
import { type CodexProcess, procLocksHolder } from '../../app/server/ownership/codex_threads.ts';
import { Handoff, type WslCodexScan } from '../../app/server/ownership/handoff.ts';
import { bgtaskMethods, LOCK_SCRIPT, parseLockOutput, PS_SCRIPT } from '../../app/server/wsl/helper/bgtasks.ts';
import type { Holder } from '../../app/server/ownership/claude_sessions.ts';

const TID = '01a1ecea-c79b-7323-90b9-9bdf77fa9bf4';
const TID2 = '01a1ecea-c79b-7323-90b9-9bdf77fa9bf5';

const row = (pid: number, ppid: number, name: string, cmdline = '', start?: string): CodexProcess => ({
  pid,
  ppid,
  name,
  cmdline,
  ...(start ? { start } : {}),
});
const kindOf = (rows: CodexProcess[], pid: number, own: number[] = []) => {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return classifyAppServer(byPid.get(pid)!, byPid, new Set(own));
};

Deno.test('app-server: VS Code (an editor above it, the extension folder, Remote-WSL), Codex Desktop, AIB own, anything else', () => {
  const ext = 'C:\\Users\\u\\.vscode\\extensions\\openai.chatgpt-0.4.1-win32-x64\\bin\\windows-x86_64\\codex.exe';
  // VS Code: the extension host (Code.exe) starts it directly
  assertEquals(
    kindOf([
      row(1, 0, 'explorer.exe'),
      row(2, 1, 'Code.exe', '"C:\\Code.exe" --type=extensionHost'),
      row(3, 2, 'codex.exe', `"${ext}" app-server`),
    ], 3),
    { kind: 'vscode', app: 'VS Code' },
  );
  // through the npm launcher (node codex.js), and a differently named editor build
  assertEquals(
    kindOf([
      row(2, 1, 'Code - Insiders.exe'),
      row(3, 2, 'node.exe', 'node C:\\n\\codex\\bin\\codex.js app-server'),
      row(4, 3, 'codex.exe', 'codex.exe app-server'),
    ], 4),
    { kind: 'vscode', app: 'VS Code' },
  );
  // the extension's own folder in the command line is enough (its parent is something unknown)
  assertEquals(kindOf([row(2, 1, 'worker.exe'), row(3, 2, 'codex.exe', `"${ext}" app-server`)], 3), { kind: 'vscode', app: 'VS Code' });
  // Remote-WSL / SSH: a node extension host of the editor server, a Linux extension folder
  assertEquals(
    kindOf([
      row(10, 1, '/home/u/.vscode-server/bin/abc/node', '/home/u/.vscode-server/bin/abc/node --type=extensionHost'),
      row(
        11,
        10,
        '/home/u/.vscode-server/extensions/openai.chatgpt-1.0-linux-x64/bin/linux-x86_64/codex',
        '/home/u/.vscode-server/extensions/openai.chatgpt-1.0-linux-x64/bin/linux-x86_64/codex app-server',
      ),
    ], 11),
    { kind: 'vscode', app: 'VS Code' },
  );
  // Codex Desktop: its Electron main program is called Codex.exe too (an install folder or --type= tells it from the CLI)
  assertEquals(
    kindOf([
      row(20, 1, 'Codex.exe', '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc\\app\\Codex.exe"'),
      row(21, 20, 'codex.exe', 'codex.exe app-server'),
    ], 21),
    { kind: 'desktop', app: 'Codex Desktop' },
  );
  assertEquals(kindOf([row(20, 1, 'ChatGPT.exe'), row(21, 20, 'codex.exe', 'codex.exe app-server')], 21), {
    kind: 'desktop',
    app: 'Codex Desktop',
  });
  assertEquals(
    kindOf([row(20, 1, 'Codex.exe', 'Codex.exe --type=utility'), row(21, 20, 'codex.exe', 'codex.exe app-server')], 21).kind,
    'desktop',
  );
  // AIB's own: itself or anything below its agents, even when VS Code is further up (AIB was started from its terminal)
  const own = [row(1, 0, 'Code.exe'), row(30, 1, 'node.exe', 'node adapter'), row(31, 30, 'codex.exe', 'codex.exe app-server')];
  assertEquals(kindOf(own, 31, [30, 31]), { kind: 'own', app: '' });
  assertEquals(kindOf(own, 31, []), { kind: 'vscode', app: 'VS Code' }, 'not AIB own: Code.exe is above it');
  assertEquals(kindOf([row(30, 1, 'node.exe'), row(31, 30, 'codex.exe', 'codex.exe app-server')], 31, [30]).kind, 'own');
  // unrelated: a script, a terminal (also inside VS Code's terminal), no parent at all, a plain CLI named Codex above it
  assertEquals(kindOf([row(40, 1, 'python.exe'), row(41, 40, 'codex.exe', 'codex.exe app-server')], 41).kind, 'unrelated');
  assertEquals(
    kindOf([row(1, 0, 'Code.exe'), row(2, 1, 'pwsh.exe'), row(3, 2, 'python.exe'), row(4, 3, 'codex.exe', 'codex.exe app-server')], 4).kind,
    'unrelated',
    'a terminal below the editor: not the extension',
  );
  assertEquals(
    kindOf([row(1, 0, 'Code.exe'), row(2, 1, 'pwsh.exe'), row(4, 2, 'codex.exe', 'codex.exe app-server')], 4).kind,
    'unrelated',
    'a shell between them ends the search',
  );
  assertEquals(kindOf([row(41, 999, 'codex.exe', 'codex.exe app-server')], 41).kind, 'unrelated');
  assertEquals(
    kindOf([row(50, 1, 'codex.exe', 'codex.exe resume x'), row(51, 50, 'codex.exe', 'codex.exe app-server')], 51).kind,
    'unrelated',
  );
  assertEquals(
    kindOf([
      row(1, 0, 'a'),
      row(2, 1, 'b'),
      row(3, 2, 'c'),
      row(4, 3, 'd'),
      row(5, 4, 'Code.exe'),
      row(6, 5, 'codex.exe', 'codex.exe app-server'),
    ], 6).kind,
    'vscode',
  );
  assertEquals(
    kindOf([
      row(0, 0, 'Code.exe'),
      row(2, 1, 'b'),
      row(3, 2, 'c'),
      row(4, 3, 'd'),
      row(5, 4, 'e'),
      row(6, 5, 'codex.exe', 'codex.exe app-server'),
    ], 6).kind,
    'unrelated',
    'too far up',
  );
});

Deno.test('app-server: only `codex app-server` counts; an npm launcher and its codex.exe are one; each has its start token', () => {
  assert(isAppServer(row(1, 0, 'codex.exe', 'codex.exe app-server --listen stdio://')));
  assert(!isAppServer(row(1, 0, 'codex.exe', 'codex.exe resume x')));
  assert(!isAppServer(row(1, 0, 'node.exe', 'node server.js app-server')), 'node running something else');
  const rows = [
    row(2, 1, 'Code.exe'),
    row(3, 2, 'node.exe', 'node C:\\n\\codex\\bin\\codex.js app-server', '111'),
    row(4, 3, 'codex.exe', 'codex.exe app-server', '112'),
    row(5, 2, 'codex.exe', 'codex.exe app-server', '113'),
  ];
  assertEquals(appServers(rows, new Set()).map((s) => [s.pid, s.start, s.kind]), [[3, '111', 'vscode'], [5, '113', 'vscode']]);
  assertEquals(ownClosure(rows, [2]), new Set([2, 3, 4, 5]));
  assertEquals(
    appServerLine('VS Code'),
    "VS Code's Codex started: AIB let go so you can open this chat there. Open it here to take it back.",
  );
  assertEquals(
    appServerLine('Codex Desktop'),
    'Codex Desktop started: AIB let go so you can open this chat there. Open it here to take it back.',
  );
});

Deno.test('ps table: pid, parent, start time and the whole command line of each process', () => {
  const text = [
    '    1     0 Mon Nov 17 21:53:50 2026 /sbin/init',
    ' 4242  1000 Tue Nov  3 08:00:01 2026 /home/u/.vscode-server/bin/abc/node --type=extensionHost',
    ' 4300  4242 Tue Nov  3 08:00:09 2026 /home/u/.vscode-server/extensions/openai.chatgpt-1.0/bin/linux-x86_64/codex app-server --x',
    'garbage line',
  ].join('\n');
  const rows = parsePsTable(text);
  assertEquals(rows.map((r) => [r.pid, r.ppid]), [[1, 0], [4242, 1000], [4300, 4242]]);
  assertEquals(rows[2].start, 'Tue Nov 3 08:00:09 2026');
  assertEquals(rows[0].start, undefined);
  assertEquals(rows[1].cmdline, '/home/u/.vscode-server/bin/abc/node --type=extensionHost');
  assertEquals(appServers(rows, new Set()).map((s) => s.kind), ['vscode']);
});

Deno.test('helper codex.scan: CLI naming a thread, writer lock held by someone else, app-servers by who started them; AIB own never counts', async () => {
  const ps = [
    ' 100     1 Mon Nov 17 10:00:00 2026 node /opt/aib/adapter.js', // AIB's agent (excluded)
    ' 101   100 Mon Nov 17 10:00:01 2026 /usr/bin/codex app-server', // below it: own
    ` 200     1 Mon Nov 17 10:05:00 2026 /usr/bin/codex resume ${TID}`, // a terminal
    ' 300     1 Mon Nov 17 10:06:00 2026 /home/u/.vscode-server/bin/h/node --type=extensionHost',
    ' 301   300 Mon Nov 17 10:06:05 2026 /usr/bin/codex app-server',
    ' 400     1 Mon Nov 17 10:07:00 2026 python3 run.py',
    ' 401   400 Mon Nov 17 10:07:05 2026 /usr/bin/codex app-server',
  ].join('\n');
  const home = '/home/u/.codex';
  const locks = [
    '1: FLOCK  ADVISORY  WRITE 101 08:01:5001 0 EOF', // AIB's own agent holds TID2 (still attached)
    '2: FLOCK  ADVISORY  WRITE 301 08:01:5002 0 EOF', // VS Code's server holds TID
  ].join('\n');
  const m = bgtaskMethods({
    env: () => Promise.resolve({ env: {}, home: '/home/u' }),
    store: () => Promise.resolve(null),
    psText: () => ps,
    lockText: (h, ids) => {
      assert(h.startsWith(home.slice(0, 7)) && h.endsWith('.codex'), h);
      return { inodes: new Map(ids.map((id) => [id, id === TID ? 5002 : 5001])), text: locks };
    },
  });
  const got = await m['codex.scan']({ sessionIds: [TID, TID2, 'not-a-thread'], exclude: [100] }) as {
    cli: Record<string, { pid: number }>;
    locked: Record<string, { pid: number }>;
    appServers: { pid: number; start: string; kind: string; app: string }[];
  };
  assertEquals(got.cli, { [TID]: { pid: 200 } });
  assertEquals(got.locked, { [TID]: { pid: 301 } }, "AIB's own lock (TID2) is not another app's");
  assertEquals(got.appServers.map((s) => [s.pid, s.kind, s.app]), [[101, 'own', ''], [301, 'vscode', 'VS Code'], [401, 'unrelated', '']]);
  assertEquals(got.appServers[1].start, 'Mon Nov 17 10:06:05 2026');
  // no ps, no evidence
  const none = bgtaskMethods({
    env: () => Promise.resolve({ env: {}, home: '/home/u' }),
    store: () => Promise.resolve(null),
    psText: () => null,
  });
  assertEquals(await none['codex.scan']({ sessionIds: [TID], exclude: [] }), { cli: {}, locked: {}, appServers: [] });
  assertEquals(
    parseLockOutput(`5001\t/x/a.lock\n\t/x/b.lock\n@@@@\n${locks}\n`, ['/x/a.lock', '/x/b.lock'], [TID, TID2]).inodes,
    new Map([[TID, 5001]]),
  );
});

type FakeChat = {
  id: string;
  provider: string;
  sessionId: string;
  closed: boolean;
  ready: boolean;
  replaying: boolean;
  rebuildError: null;
  command: string[];
  wsl: { distro: string };
  process: { pid: number };
  elsewhere: unknown;
  letGoIdle(holder: Holder, line: string): Promise<'released' | 'busy' | 'no'>;
  handOff(holder: Holder): void;
  tryRelease(): Promise<boolean>;
};

Deno.test('handoff: a new VS Code / Codex Desktop app-server lets go of idle Codex chats once; working chats are left; own and unrelated do nothing', async () => {
  const calls: string[] = [];
  const handed: string[] = [];
  const chat = (id: string, sid: string, result: 'released' | 'busy'): FakeChat => ({
    id,
    provider: 'codex',
    sessionId: sid,
    closed: false,
    ready: true,
    replaying: false,
    rebuildError: null,
    command: ['codex-acp'],
    wsl: { distro: 'Ubuntu' },
    process: { pid: 7 },
    elsewhere: null,
    letGoIdle(holder, line) {
      calls.push(`${id}|${holder.app}|${holder.pid}|${line}`);
      return Promise.resolve(result);
    },
    handOff(holder) {
      handed.push(`${id}|${holder.entrypoint}`);
    },
    tryRelease: () => Promise.resolve(false),
  });
  const idle = chat('idle', TID, 'released'), working = chat('working', TID2, 'busy');
  let scan: WslCodexScan = { cli: {}, locked: {}, appServers: [] };
  const handoff = new Handoff({
    connections: () => [idle, working] as never,
    wslCodex: () => Promise.resolve(scan),
  });
  const beat = async () => {
    handoff.poke(true);
    await new Promise((r) => setTimeout(r, 60));
  };
  const server = (pid: number, start: string, kind: 'own' | 'vscode' | 'desktop' | 'unrelated', app = '') => ({ pid, start, kind, app });
  try {
    await beat(); // no app-server
    assertEquals(calls, []);
    scan = { cli: {}, locked: {}, appServers: [server(9, 's0', 'own'), server(10, 's0', 'unrelated')] };
    await beat();
    assertEquals(calls, [], 'AIB own and an unrelated app-server (a terminal, a script) never let go');
    scan = { cli: {}, locked: {}, appServers: [server(50, 's1', 'vscode', 'VS Code')] };
    await beat();
    assertEquals(calls, [
      "idle|VS Code's Codex|50|VS Code's Codex started: AIB let go so you can open this chat there. Open it here to take it back.",
      "working|VS Code's Codex|50|VS Code's Codex started: AIB let go so you can open this chat there. Open it here to take it back.",
    ], 'every Codex chat is offered; the working one answers busy and is kept (Connection.letGoIdle checks)');
    calls.length = 0;
    await beat();
    await beat();
    assertEquals(calls, [], 'the same process (pid and start) acts once');
    scan = { cli: {}, locked: {}, appServers: [server(50, 's2', 'vscode', 'VS Code')] }; // the pid came back as another process
    await beat();
    assertEquals(calls.length, 2);
    calls.length = 0;
    scan = { cli: {}, locked: {}, appServers: [] };
    await beat(); // it quit
    scan = { cli: {}, locked: {}, appServers: [server(60, 'd1', 'desktop', 'Codex Desktop')] };
    await beat();
    assertEquals(calls.map((c) => c.split('|')[0] + '|' + c.split('|')[3]), [
      'idle|Codex Desktop started: AIB let go so you can open this chat there. Open it here to take it back.',
      'working|Codex Desktop started: AIB let go so you can open this chat there. Open it here to take it back.',
    ]);
    // a Codex CLI naming the chat's thread is the older path: hand-off (it waits for the turn), not the app-server one
    calls.length = 0;
    scan = {
      cli: { [TID]: { pid: 77, entrypoint: 'codex-cli', status: '', app: 'a terminal' } },
      locked: {},
      appServers: [server(61, 'd2', 'vscode', 'VS Code')],
    };
    await beat();
    assertEquals(handed, ['idle|codex-cli']);
    assertEquals(calls.map((c) => c.split('|')[0]), ['working'], 'the chat a CLI holds is not offered again');
    // the helper cannot tell: nothing happens
    calls.length = 0;
    handoff.close();
  } finally {
    handoff.close();
  }
});

Deno.test('handoff: an app-server already running when AIB first looks (Codex Desktop open all day) is noted, not acted on', async () => {
  const calls: string[] = [];
  const chat = {
    id: 'c',
    provider: 'codex',
    sessionId: TID,
    closed: false,
    ready: true,
    replaying: false,
    rebuildError: null,
    command: ['codex-acp'],
    wsl: { distro: 'Ubuntu' },
    process: { pid: 7 },
    elsewhere: null,
    letGoIdle: (h: Holder) => {
      calls.push(h.app);
      return Promise.resolve('released' as const);
    },
    handOff() {},
    tryRelease: () => Promise.resolve(false),
  };
  let scan: WslCodexScan = { cli: {}, locked: {}, appServers: [{ pid: 5, start: 'a', kind: 'desktop', app: 'Codex Desktop' }] };
  const handoff = new Handoff({ connections: () => [chat] as never, wslCodex: () => Promise.resolve(scan) });
  const beat = async () => {
    handoff.poke(true);
    await new Promise((r) => setTimeout(r, 60));
  };
  try {
    await beat();
    await beat();
    assertEquals(calls, [], 'it was there before AIB looked');
    scan = {
      cli: {},
      locked: {},
      appServers: [{ pid: 5, start: 'a', kind: 'desktop', app: 'Codex Desktop' }, { pid: 6, start: 'b', kind: 'vscode', app: 'VS Code' }],
    };
    await beat();
    assertEquals(calls, ["VS Code's Codex"], 'a new one acts');
  } finally {
    handoff.close();
  }
});

// ---- a real distro: the shell scripts the helper runs (ps, stat, /proc/locks) --------------------------------------------------

function wslDistro(): string | null {
  if (Deno.build.os !== 'windows') return null;
  try {
    const out = new Deno.Command('wsl.exe', { args: ['-l', '-q'], stdin: 'null', stdout: 'piped', stderr: 'null' }).outputSync();
    const names = new TextDecoder('utf-16le').decode(out.stdout).split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean);
    return names.find((n) => !/docker-desktop/i.test(n)) ?? null;
  } catch {
    return null;
  }
}
const DISTRO = wslDistro();

Deno.test({
  name: 'WSL distro: ps lists the processes with start times, and the lock script finds the pid that holds a Codex writer lock',
  ignore: DISTRO === null,
  async fn() {
    const script = [
      'd=$(mktemp -d)',
      `f="$d/${TID}.lock"`,
      ': > "$f"',
      'flock -x "$f" sleep 30 &',
      'holder=$!',
      'sleep 1',
      'echo "HOLDER=$holder"',
      'echo @@PS',
      PS_SCRIPT,
      'echo @@LOCK',
      `sh -c '${LOCK_SCRIPT}' sh "$f"`,
      'echo "@@FILE=$f"',
      'kill $holder 2>/dev/null',
      'wait $holder 2>/dev/null',
      'rm -f "$f"',
      'rmdir "$d"',
    ].join('\n');
    const child = new Deno.Command('wsl.exe', {
      args: ['-d', DISTRO!, '--exec', '/bin/sh', '-s'],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script + '\n'));
    await writer.close();
    const done = await child.output();
    const out = new TextDecoder().decode(done.stdout);
    assert(done.success, new TextDecoder().decode(done.stderr));
    const holder = Number(/HOLDER=(\d+)/.exec(out)![1]);
    const ps = out.slice(out.indexOf('@@PS\n') + 5, out.indexOf('@@LOCK\n'));
    const rows = parsePsTable(ps);
    assert(rows.some((r) => r.pid === 1), 'init is listed');
    const mine = rows.find((r) => r.pid === holder);
    assert(mine && /flock/.test(mine.cmdline), `the lock holder's command line is listed (${mine?.cmdline})`);
    assertEquals(mine!.ppid > 0, true);
    const file = /@@FILE=(.*)/.exec(out)![1];
    const lock = out.slice(out.indexOf('@@LOCK\n') + 7, out.indexOf('@@FILE='));
    const parsed = parseLockOutput(lock, [file], [TID]);
    assert(parsed.inodes.get(TID)! > 0, 'the lock file has an inode');
    assertEquals(procLocksHolder(parsed.text, parsed.inodes.get(TID)!), holder, '/proc/locks names the holder of the flock');
  },
});
