/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): background tasks and the ownership check of WSL chats (docs/WSL.md "Background
 * tasks and ownership"), with the built Linux helper.
 *   - another client's process in the distro whose command line names a saved session: Continue is refused with the Windows words and
 *     its Linux pid; once it is gone the chat continues; AIB's own agent naming the session in its command line never counts;
 *   - a saved session's background command listed with its output (a temp transcript and task output inside AIB_WSL_ROOT);
 *   - a chat whose background shell runs in the distro is not idle until that shell ends;
 *   - Stop on a chat's background row ends that command in the distro, never the agent, its other children, a reused pid or an
 *     unrelated process.
 * Everything is inside the test's /tmp/aib-wsl-test-<random>; the only processes signalled are the ones this test started there.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { cleanRoot, DISTRO, inDistro, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { OwnershipConflict } from '../../outputs/agent-studio/server/ownership/ownership.ts';
import { wslTranscriptGet } from '../../outputs/agent-studio/server/wsl/transcripts.ts';
import { wslOwnerCheck, wslOwnPids } from '../../outputs/agent-studio/server/wsl/ownership.ts';
import { FRESH_MS } from '../../outputs/agent-studio/server/wsl/procs.ts';
import { parseQs } from '../../outputs/agent-studio/server/transcripts/pycompat.ts';

type Json = Record<string, unknown>;
const SYSTEM_ROOT = Deno.env.get('SystemRoot') ?? 'C:\\Windows';
const until = async (fn: () => unknown, what: string, seconds = 30) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A Claude Code transcript of `id` in the test's Claude folder (rows as JSON), its mtime `age` seconds back. */
async function transcript(id: string, rows: Json[], age = 0): Promise<string> {
  const folder = `${ROOT}/repo`.replaceAll('/', '-');
  const made = await inDistro(
    'mkdir -p "$1/home/.claude/projects/$2" && cat > "$1/home/.claude/projects/$2/$3.jsonl" && touch -d "@$4" "$1/home/.claude/projects/$2/$3.jsonl"',
    [ROOT, folder, id, String(Math.floor(Date.now() / 1000) - age)],
    new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
  );
  assertEquals(made.code, 0, made.err);
  return folder;
}

function studioWith(state: string, command: (ref: string) => string[], program: string): Studio {
  const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
  studio.ownerProbe = () => {
    throw new Error('a WSL chat never asks Windows for its owner');
  };
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(command(cwd), cwd, provider, { ...options, wsl: options?.wsl ? { ...options.wsl, program } : options?.wsl });
  return studio;
}

Deno.test({
  name: 'wsl e2e: a session another process in the distro holds is refused (its Linux pid); never for AIB\'s own agent',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-own-e2e-' });
    await prepareRoot();
    let other: Deno.ChildProcess | null = null;
    let studio: Studio | null = null;
    try {
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      const id = crypto.randomUUID();
      // an hour-old transcript: no "written moments ago" sign, so only the process decides
      await transcript(id, [{ type: 'user', sessionId: id, cwd: repo, timestamp: '2026-11-14T10:00:00Z', message: { role: 'user', content: 'hi' } }], 3600);
      // "another client": a program named claude (a shell script, so its comm is `claude`) started with --resume <id>, and AIB's own
      // agent stand-in, also named claude with --resume <id> in its command line, which runs the fake agent
      const otherScript = '#!/bin/sh\necho $$ > "$AIB_TEST_PID"\ntrap \'kill $!; exit 0\' TERM\nsleep 600 &\nwait\n';
      const agentScript = `#!/bin/sh\n/usr/bin/python3 "${ROOT}/fake_acp.py"\n`; // the distro's python3, not a version manager's shim
      for (const [path, text] of [[`${ROOT}/other/claude`, otherScript], [`${ROOT}/agent/claude`, agentScript]]) {
        const made = await inDistro('mkdir -p "$(dirname "$1")" && cat > "$1" && chmod +x "$1"', [path], new TextEncoder().encode(text));
        assertEquals(made.code, 0, made.err);
      }
      other = new Deno.Command(`${SYSTEM_ROOT}\\System32\\wsl.exe`, {
        args: ['--distribution', DISTRO, '--cd', '~', '--exec', 'sh', '-c', 'AIB_TEST_PID="$1/other.pid" exec "$1/other/claude" --resume "$2"', 'sh', ROOT, id],
        env: { SystemRoot: SYSTEM_ROOT, WSL_UTF8: '1', WSLENV: '' },
        clearEnv: true,
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
      let otherPid = 0;
      await until(async () => (otherPid = Number((await inDistro('cat "$1/other.pid" 2>/dev/null', [ROOT])).out.trim())) > 0, 'the other client');

      const host = await readyHost();
      studio = studioWith(state, () => [`${ROOT}/agent/claude`, '--resume', id], `${ROOT}/agent/claude`);
      const refused = await assertRejects(() => studio!.connect('claude', ref, id), OwnershipConflict);
      assertEquals(
        refused.message,
        `This claude conversation is already open in another agent process (PID ${otherPid}). Stop it in its current client before continuing here.`,
      );

      // the other client stops: the chat continues, with AIB's own agent (named claude, --resume <id>) in the distro
      assertEquals((await inDistro('kill "$(cat "$1/other.pid")"', [ROOT])).code, 0);
      await other.status;
      other = null;
      const c = await studio.connect('claude', ref, id);
      assert(c.ready && !c.closed, 'continued');
      const agentPid = c.process!.pid;
      const own = await wslOwnerCheck(host, 'claude', id, { exclude: await wslOwnPids(host), cwd: repo });
      assertEquals(own?.owner, null, "AIB's own agent never owns a session elsewhere");
      const unexcluded = await wslOwnerCheck(host, 'claude', id, { exclude: [], cwd: repo });
      assertEquals(unexcluded?.owner, agentPid, 'without the exclusion the same process would be found: the check really looks');
    } finally {
      try {
        other?.kill();
      } catch { /* ended */ }
      await studio?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

Deno.test({
  name: 'wsl e2e: a saved WSL session lists its background command with its output, and the main agent counts it running',
  ...T,
  async fn() {
    await prepareRoot();
    try {
      const repo = `${ROOT}/repo`;
      const id = crypto.randomUUID();
      const now = (back: number) => new Date(Date.now() - back * 1000).toISOString();
      const folder = await transcript(id, [
        { type: 'user', sessionId: id, cwd: repo, timestamp: now(30), message: { role: 'user', content: 'run the tests' } },
        {
          type: 'assistant',
          sessionId: id,
          timestamp: now(20),
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test', description: 'Tests', run_in_background: true } }] },
        },
        {
          type: 'user',
          sessionId: id,
          timestamp: now(19),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Command running in background with ID: job1.' }] },
          toolUseResult: { backgroundTaskId: 'job1' },
        },
      ]);
      const out = await inDistro('mkdir -p "$1/tmp/claude/$2/$3/tasks" && printf "PASS 12 tests\\n" > "$1/tmp/claude/$2/$3/tasks/job1.output"', [ROOT, folder, id]);
      assertEquals(out.code, 0, out.err);
      await readyHost();
      const key = `wsl.${KEY}.claude/${folder}/${id}.jsonl`;
      const list = await wslTranscriptGet('/api/commands', parseQs(`session=${encodeURIComponent(key)}`));
      assertEquals(list?.status, 200, JSON.stringify(list?.body));
      const body = list!.body as { commands: Json[]; running: number };
      assertEquals(body.running, 1);
      assertEquals([body.commands[0].id, body.commands[0].status, body.commands[0].title], [`${key}#c1`, 'running', 'Tests']);
      const one = await wslTranscriptGet('/api/command', parseQs(`session=${encodeURIComponent(key)}&id=${encodeURIComponent(`${key}#c1`)}`));
      assertEquals(one?.status, 200, JSON.stringify(one?.body));
      assert(String((one!.body as Json).output).includes('PASS 12 tests'), String((one!.body as Json).output));
      const agents = await wslTranscriptGet('/api/agents', parseQs(`session=${encodeURIComponent(key)}`));
      assertEquals(((agents!.body as Json).agents as Json[]).map((a) => [a.key, a.main, a.runningCommands]), [[key, true, 1]]);
    } finally {
      await cleanRoot();
    }
  },
});

Deno.test({
  name: 'wsl e2e: a chat is not idle while its background shell runs in the distro, and is once it ended',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-bgshell-e2e-' });
    await prepareRoot();
    let studio: Studio | null = null;
    try {
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      await readyHost();
      studio = studioWith(state, () => ['python3', `${ROOT}/fake_acp.py`, '--held-turn'], '/usr/bin/python3');
      const c = await studio.connect('claude', ref);
      const gate = `${ROOT}/gate`;
      assertEquals((await studio.liveCall('prompt', { id: c.id, text: `bgshell:${gate}`, clientMessageId: 'm1' }))[0], 200);
      await until(() => !c.busy && c.events.some((e) => e.kind === 'turn_end'), 'the reply ended');
      await until(() => c.backgroundShells().length === 1, 'the shell counts');
      assertEquals(studio.busyList().map((b) => b.state), ['background']);
      await new Promise((r) => setTimeout(r, FRESH_MS * 2)); // several snapshots of the distro later: still running
      assertEquals(studio.busyList().map((b) => b.state), ['background']);
      assertEquals(Object.values(c.toolBackground()).map((t) => [t.state, t.stoppable]), [['running', true]], 'Stop offered');
      assertEquals((await inDistro('touch "$1"', [gate])).code, 0); // the command ends
      await until(() => studio!.busyList().length === 0, 'the chat dropped out of the busy list');
      assertEquals(c.backgroundShells(), []);
    } finally {
      await studio?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

Deno.test({
  name: "wsl e2e: Stop on a WSL chat's background row ends its command in the distro; the agent, its own child and other processes run on",
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-bgstop-e2e-' });
    await prepareRoot();
    let studio: Studio | null = null;
    let unrelated = 0;
    let sleeper: Deno.ChildProcess | null = null;
    const alive = async (pid: number) => (await inDistro('kill -0 "$1" 2>/dev/null', [String(pid)])).code === 0;
    const pidOf = async (file: string) => Number((await inDistro('cat "$1" 2>/dev/null', [file])).out.trim());
    try {
      const repo = `${ROOT}/repo`;
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      // an unrelated process of the same user in the distro (not below any agent), kept by its own wsl.exe as the first test's is
      sleeper = new Deno.Command(`${SYSTEM_ROOT}\\System32\\wsl.exe`, {
        args: ['--distribution', DISTRO, '--cd', '~', '--exec', 'sh', '-c', 'echo $$ > "$1/sleeper.pid"; exec sleep 600', 'sh', ROOT],
        env: { SystemRoot: SYSTEM_ROOT, WSL_UTF8: '1', WSLENV: '' },
        clearEnv: true,
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
      await until(async () => (unrelated = await pidOf(`${ROOT}/sleeper.pid`)) > 0, 'the unrelated process');
      assert(await alive(unrelated));
      const host = await readyHost();
      studio = studioWith(state, () => ['python3', `${ROOT}/fake_acp.py`, '--held-turn', '--child-pid-file', `${ROOT}/child`], '/usr/bin/python3');
      const c = await studio.connect('claude', ref);
      assertEquals((await studio.liveCall('prompt', { id: c.id, text: `bgshell:${ROOT}/gate`, clientMessageId: 'm1' }))[0], 200);
      await until(() => Object.values(c.toolBackground())[0]?.stoppable, 'Stop offered (the distro named its processes)');
      const [shell, child] = [await pidOf(`${ROOT}/child.shell`), await pidOf(`${ROOT}/child`)];
      assert(shell > 0 && child > 0 && await alive(shell));

      // straight to the helper: a pid that is not below the agent, and the shell's pid with another start time (a reused pid)
      const agent = c.process!.pid;
      const refused = await host.call('proc.stop', { root: agent, targets: [[unrelated, 0], [shell, 3600]] });
      assertEquals([refused.listed, refused.killed, refused.skipped], [true, [], [unrelated, shell]]);
      assert(await alive(shell) && await alive(unrelated));

      const toolId = Object.keys(c.toolBackground())[0];
      const [status, body] = await studio.liveCall('tool-stop', { id: c.id, toolCallId: toolId }) as [number, Json];
      assertEquals([status, body.state, body.killed], [200, 'stopped', 1], JSON.stringify(body));
      await until(async () => !(await alive(shell)), 'the stopped command is gone from the distro', 15);
      assert(await alive(child), "the agent's own child (started before the turn) runs on");
      assert(await alive(unrelated), 'an unrelated process runs on');
      assert(!c.closed && (await inDistro('kill -0 "$1"', [String(agent)])).code === 0, 'the agent runs on');
      assertEquals(Object.values(c.toolBackground())[0], { state: 'stopped', stoppable: false });
      assertEquals((await studio.liveCall('tool-stop', { id: c.id, toolCallId: toolId }))[0], 409, 'no second stop');
      await until(() => studio!.busyList().length === 0, 'the chat is idle');
    } finally {
      await studio?.close().catch(() => {});
      if (unrelated > 0) await inDistro('kill "$1" 2>/dev/null; true', [String(unrelated)]); // only the one this test started
      else {
        try {
          sleeper?.kill();
        } catch { /* ended */ }
      }
      await sleeper?.status;
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
