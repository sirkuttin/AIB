/**
 * K9 with real processes (slow: AIB_SLOW_TESTS=1, Windows): a chat terminal through an AIB crash. AIB (`serve`, one process with the
 * keeper, on a port the OS picked) runs a PowerShell terminal in the keeper with a loop printing a numbered line every 100 ms. AIB is killed
 * hard (TerminateProcess); the keeper keeps the shell and its loop, and with no client for 5 s starts AIB again (rule V1). The new AIB
 * takes the shell over: the terminal list shows the same shell pid, the page reconnects with resume=1 and gets the recorded output
 * replayed, and every line number is there once the loop goes on: no gap. Ctrl+C stops the loop and typing still works ($PID is the
 * same shell). Ending the terminal removes it from the keeper, and at the end nothing this test started is left running.
 * Temp state, APPDATA and LOCALAPPDATA; only PIDs this test started (and the AIB its keeper started) are killed.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, httpJson, sleep, TEST_OPTIONS, until } from './_host_fixture.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
const KEY = 'claude:k9-e2e';
const SEP = '\\';
// deno-lint-ignore no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

class TerminalFixture extends Fixture {
  keeperBin = '';
  readonly appData = this.root + SEP + 'appdata';
  readonly localAppData = this.root + SEP + 'localappdata';

  constructor() {
    super();
    Deno.mkdirSync(this.appData);
    Deno.mkdirSync(this.localAppData);
  }

  override get env(): Record<string, string> {
    const realLocal = Deno.env.get('LOCALAPPDATA') ?? '';
    const env: Record<string, string> = {
      ...super.env,
      AIB_KEEPER_BIN: this.keeperBin,
      APPDATA: this.appData,
      LOCALAPPDATA: this.localAppData,
      DENO_DIR: Deno.env.get('DENO_DIR') || `${realLocal}${SEP}deno`, // the module cache only: no recompiling everything
    };
    delete env.AIB_KEEPER; // the keeper on, as shipped
    return env;
  }

  override async cleanup(): Promise<void> {
    const keeper = readKeeperInfo(this.state);
    if (keeper && pidAlive(keeper.pid)) Deno.kill(keeper.pid, 'SIGKILL'); // the keeper this test's AIB started (its Job Objects end the shells)
    try {
      const owner = JSON.parse(Deno.readTextFileSync(this.state + SEP + 'aib-owner.json'));
      if (typeof owner.pid === 'number' && owner.pid !== Deno.pid) this.hostPids.add(owner.pid);
    } catch { /* none */ }
    await super.cleanup().catch(() => {});
  }
}

/** A page-like terminal socket (Deno's WebSocket with the page's Origin and subprotocols). */
function terminal(port: number, token: string, cwd: string, resume = false) {
  const q = new URLSearchParams({ key: KEY, cwd, cols: '120', rows: '30' });
  if (resume) q.set('resume', '1');
  // @ts-ignore: Deno's WebSocket takes headers
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/terminal?${q}`, {
    protocols: ['aib-terminal', 'aib-token.' + token],
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  ws.binaryType = 'arraybuffer';
  const messages: Record<string, unknown>[] = [];
  let raw = '';
  const decoder = new TextDecoder();
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') messages.push(JSON.parse(e.data));
    else raw += decoder.decode(e.data, { stream: true });
  };
  const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()));
  return {
    ws,
    messages,
    closed,
    get text() {
      return strip(raw);
    },
    ticks(): Set<number> {
      return new Set([...strip(raw).matchAll(/tick (\d+)\b/g)].map((m) => Number(m[1])));
    },
    type(data: string) {
      ws.send(JSON.stringify({ type: 'input', data }));
    },
  };
}

const maxOf = (s: Set<number>) => Math.max(-1, ...s);

Deno.test({
  name: 'keeper e2e (K9): a terminal printing every 100 ms through an AIB crash: same shell pid, no gap, typing works, nothing left',
  ignore: !SLOW,
  ...TEST_OPTIONS,
  async fn() {
    const fixture = new TerminalFixture();
    let shellPid = 0;
    let keeperPid = 0;
    const aibPids: number[] = [];
    try {
      fixture.keeperBin = await keeperBinary();
      const web = await fixture.startWeb([], { pinPort: true }); // the keeper restarts AIB on the port its command line names
      const PORT = web.port;
      aibPids.push(web.process.pid);
      const cwd = fixture.workspace;
      const page1 = terminal(PORT, web.token, cwd);
      await until(() => page1.messages.some((m) => m.type === 'ready'), 'terminal ready', 30);
      shellPid = Number(page1.messages.find((m) => m.type === 'ready')!.pid);
      keeperPid = readKeeperInfo(fixture.state)!.pid;
      const listed = await withKeeper(fixture.state, (k) => k.list());
      const channel = listed.find((c) => c.kind === 'pty')!;
      assertEquals([channel.live, channel.pid], [true, shellPid], 'the shell runs in the keeper');
      await until(() => /PS .*>/.test(page1.text), 'the prompt', 30);
      page1.type('$i = 0; while ($true) { "tick $i"; $i++; Start-Sleep -Milliseconds 100 }\r');
      await until(() => maxOf(page1.ticks()) >= 10, 'ticking', 30);

      const seenBefore = maxOf(page1.ticks());
      const oldToken = web.token;
      await web.kill(); // TerminateProcess: AIB closes nothing
      await page1.closed;
      const killed = Date.now();
      await sleep(1500);
      assert(pidAlive(shellPid), 'the shell outlives AIB');

      // The keeper starts AIB again (no client for 5 s); it takes the shell over before it serves the page.
      await until(
        async () => {
          try {
            const [status, boot] = await web.get('/api/live/bootstrap');
            if (status !== 200 || boot.token === oldToken) return false;
            web.token = String(boot.token);
            return true;
          } catch {
            return false;
          }
        },
        'AIB started again by the keeper',
        60,
      ).catch((error) => {
        throw new Error(`${error.message}\n${fixture.read(fixture.state + SEP + 'keeper' + SEP + 'keeper.log')}\n${
          fixture.read(fixture.state + SEP + 'studio.log').slice(-2500)
        }`);
      });
      const owner = JSON.parse(Deno.readTextFileSync(fixture.state + SEP + 'aib-owner.json'));
      fixture.hostPids.add(owner.pid);
      aibPids.push(owner.pid);
      console.log(`AIB back after ${((Date.now() - killed) / 1000).toFixed(1)} s`);
      const [, list] = await httpJson('GET', PORT, '/api/live/terminal/list', web.token);
      const terminals = list.terminals as Record<string, unknown>[];
      assertEquals(terminals.map((t) => [t.key, t.pid]), [[KEY, shellPid]], 'the same shell, taken over');

      const page2 = terminal(PORT, web.token, cwd, true);
      await until(() => page2.messages.some((m) => m.type === 'ready'), 'reattached', 30);
      const ready = page2.messages.find((m) => m.type === 'ready')!;
      assertEquals([ready.resumed, ready.pid], [true, shellPid]);
      await until(() => maxOf(page2.ticks()) >= seenBefore + 80, 'still ticking, live', 40);
      const ticks = page2.ticks();
      const top = maxOf(ticks);
      const missing = Array.from({ length: top + 1 }, (_, i) => i).filter((i) => !ticks.has(i));
      assertEquals(missing, [], `no gap: every line 0..${top} is in the replayed and live output`);

      // Typing still works: Ctrl+C stops the loop, then the shell answers with its own pid.
      page2.type('\x03');
      await sleep(800);
      page2.type('"pid=$PID"\r');
      await until(() => page2.text.includes(`pid=${shellPid}`), 'typing after the takeover', 20);
      assertEquals(page2.messages.filter((m) => m.type === 'exit'), [], 'no "Session ended": the shell never stopped');

      // Ending it ends the shell and removes it from the keeper.
      const [, ended] = await httpJson('POST', PORT, '/api/live/terminal/end', web.token, { key: KEY });
      assertEquals(ended.ended, true);
      await until(() => !pidAlive(shellPid), 'shell ended', 15);
      await until(async () => !(await withKeeper(fixture.state, (k) => k.list())).some((c) => c.kind === 'pty'), 'pty channel removed', 15);
      page2.ws.close();
    } finally {
      await fixture.cleanup();
      // Nothing this test started is left running: the shell, the keeper, every AIB.
      for (const pid of [shellPid, keeperPid, ...aibPids].filter(Boolean)) {
        await until(() => !pidAlive(pid), `pid ${pid} gone`, 15);
      }
    }
  },
});

async function withKeeper<R>(state: string, work: (client: KeeperClient) => Promise<R>): Promise<R> {
  const client = await KeeperClient.connect(readKeeperInfo(state)!, 'k9 e2e test'); // short-lived: it must not count as AIB
  try {
    return await work(client);
  } finally {
    client.close();
  }
}
