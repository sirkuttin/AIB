/**
 * Quitting AIB never stops a chat, and AIB exits (owner's decisions 2026-11-10 and 2026-11-11: "the whole point of this keeper is
 * to not have anything break when we quit"; quitting with chats working does exactly what Install now does). End to end with the
 * real pieces main.ts wires together: the real keeper (built from keeper/ with Go), a real Studio whose agents run in it, fake ACP
 * agents (work/fake_acp.py), and the desktop window/tray logic (DesktopApp) on a fake Shell, so no window, tray icon or dialog is
 * ever shown. Temp state folders only. The keeper runs with an orphan command that only leaves a marker and short orphan timers, so
 * a restart of AIB by the keeper (rule V1) would show at once, and so would the keeper giving up on the chats.
 *
 *   - Quit AIB mid-turn with a streaming chat and a queued message: nothing is stopped, AIB (the Studio) is gone, the keeper holds
 *     the chat (held) and never runs its orphan command; the agent goes on and the question arrives with no AIB. The next AIB takes
 *     the chat over: every chunk once and in order, the question once, the answer and the queued message reach the agent once.
 *   - A chat whose only work is a background helper: the same; the agent's helper process lives on until it is done.
 *   - A chat whose only work is a background shell (Bash run_in_background, the reply ended): the same; the shell lives on.
 *   - Quitting with nothing working quits at once and the keeper goes, as before.
 *   - Stop all chats and quit (two clicks in the menu, no box) stops the agent and its children.
 *   - AIB killed (a signal: main.ts releases working chats to the keeper, no hold) or crashing: a new AIB takes the chat over with
 *     the question that arrived meanwhile, and the queue goes on there.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { holdKeeper, Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink, keeperTakeoverProblem, noteKeeperTakeoverProblem } from '../../outputs/agent-studio/server/keeper/link.ts';
import { ArtifactMcpHttp, FORWARD_FILE } from '../../outputs/agent-studio/server/artifacts/mcp_http.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { DesktopApp, type Shell, STOP_INDEX, type WindowHandle } from '../../outputs/agent-studio/server/desktop/window.ts';
import { trayIconPng } from '../../outputs/agent-studio/server/desktop/tray_icon.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const IDLE_MS = 5000;
/** The keeper's orphan timers here: a V1 restart (and the give-up after 2 tries) would come within about a second. */
const QUICK_ORPHAN = [
  '--orphan-after',
  '300ms',
  '--orphan-retry',
  '300ms',
  '--orphan-tries',
  '2',
];

class Win implements WindowHandle {
  closed = false;
  visible = true;
  handlers = new Map<string, (() => void)[]>();
  navigate() {}
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {}
  setTitle() {}
  isClosed() {
    return this.closed;
  }
  isVisible() {
    return this.visible;
  }
  getSize(): [number, number] {
    return [800, 600];
  }
  getPosition(): [number, number] {
    return [0, 0];
  }
  setSize() {}
  setPosition() {}
  bind() {}
  on(event: string, fn: () => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  emit(event: string) {
    if (event === 'close') this.closed = true;
    for (const fn of this.handlers.get(event) ?? []) fn();
  }
  evaluate() {
    return Promise.resolve(undefined);
  }
}

class Lab {
  readonly dir = Deno.realPathSync(
    Deno.makeTempDirSync({ prefix: 'aib-quit-keeps-' }),
  );
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly agentLog = this.dir + SEP + 'agent-received.log';
  readonly studios: Studio[] = [];
  #gates = 0;

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }

  path(name: string): string {
    return this.dir + SEP + name;
  }

  gate(): string {
    return this.path(`gate-${this.#gates++}`);
  }

  open(gate: string): void {
    Deno.writeTextFileSync(gate, '');
  }

  /** Where the keeper's orphan command (rule V1: "start AIB again") leaves its mark when it runs. */
  readonly orphanMarker = this.dir + SEP + 'orphan-ran.txt';

  /**
   * A Studio over the real keeper. quickOrphan: the keeper is started with an orphan command that only writes orphanMarker and
   * QUICK_ORPHAN timers (a restart of AIB, or the keeper giving up on the chats, shows within a second); else no orphan restart.
   */
  studio(flags: string[], quickOrphan = false): Studio {
    // The keeper as the app starts it, but quicker to go once it is empty (the real one waits longer).
    const orphan = quickOrphan
      ? {
        command: Deno.execPath(),
        args: [
          'eval',
          `Deno.writeTextFileSync(${JSON.stringify(this.orphanMarker)}, 'ran;', { append: true })`,
        ],
      }
      : null;
    const keeper = new KeeperLink({
      dataDir: this.state,
      orphan,
      extraArgs: [
        '--exit-after',
        '2s',
        ...(quickOrphan ? QUICK_ORPHAN : ['--orphan-after', '60s']),
      ],
    });
    const studio = new Studio({
      ompCommand: 'unused',
      stateDir: this.state,
      port: 0,
      ownersDir: null,
    }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake(...flags), cwd, provider, {
        ...options,
        env: { FAKE_ACP_LOG: this.agentLog },
      });
    this.studios.push(studio);
    return studio;
  }

  /**
   * The desktop app over a Studio, wired as main.ts does it: the status line and the quit rule from Studio.workingList, canLeave
   * from Studio.quitHandover, quitting through the normal close path (main.ts close: Studio.close, or with work running hold +
   * Studio.release({ hold })). A fake Shell: nothing on screen.
   */
  app(studio: Studio) {
    const windows: Win[] = [];
    const updates: [string, number, string][] = [];
    const quits: boolean[] = [];
    const leaves: boolean[] = [];
    let closed: Promise<void> | null = null;
    const shell: Shell = {
      createWindow: () => {
        const w = new Win();
        windows.push(w);
        return w;
      },
      createKeeper: () => new Win(),
      createTray: () => {},
      updateTray: (tooltip, index, label) => void updates.push([tooltip, index, label]),
      removeTray: () => {},
      ask: () => Promise.reject(new Error('no native box may be shown')),
      openExternal: () => {},
      notifier: null,
    };
    const app = new DesktopApp(shell, {
      url: 'http://127.0.0.1:8890/',
      stateDir: this.state,
      trayIcon: trayIconPng(),
      busyCount: () => Promise.resolve(studio.busyList().length),
      trayCounts: () => {
        const working = studio.workingList();
        return Promise.resolve({
          working: working.length,
          needsYou: working.filter((w) => w.state === 'needs_you').length,
        });
      },
      quit: (stop, leave) => {
        quits.push(stop);
        leaves.push(!!leave);
        closed = leave
          ? holdKeeper(studio.keeper).then(() => studio.release({ hold: true }))
            .then(() => {})
          : studio.close();
        return closed;
      },
      canLeave: () => studio.quitHandover(),
      saveDelayMs: 0,
      watchdogMs: 0,
      trayPollMs: 0,
      trayIdleQuitMs: IDLE_MS,
    });
    return { app, windows, updates, quits, leaves, closed: () => closed };
  }

  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  keeperPid(): number {
    return readKeeperInfo(this.state)?.pid ?? 0;
  }

  /** keeper.json says the keeper holds its chats for the next AIB. */
  held(): boolean {
    try {
      return JSON.parse(
        Deno.readTextFileSync(`${this.state}${SEP}keeper${SEP}keeper.json`),
      ).held === true;
    } catch {
      return false;
    }
  }

  orphanRan(): boolean {
    try {
      return Deno.readTextFileSync(this.orphanMarker).length > 0;
    } catch {
      return false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    const info = readKeeperInfo(this.state);
    if (info && pidAlive(info.pid)) {
      try {
        const client = await KeeperClient.connect(info);
        await client.shutdown(true).catch(() => {});
        client.close();
      } catch { /* gone */ }
      await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
    }
    for (const file of Deno.readDirSync(this.dir)) {
      if (!file.name.startsWith('child-')) continue;
      const pid = Number(Deno.readTextFileSync(this.path(file.name)));
      if (pid && pidAlive(pid)) Deno.kill(pid, 'SIGKILL');
    }
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

const prompts = (lines: Json[]) => lines.filter((m) => m.method === 'session/prompt');
const answers = (lines: Json[]) => lines.filter((m) => m.id === 'stream-ask' && !m.method);
const turnEnds = (c: Connection) => c.events.filter((e) => e.kind === 'turn_end').length;
const kinds = (state: Json) => ((state.events ?? []) as Json[]).map((e) => e.kind);

/** The agent's reply text in a chat's events, in order (every chunk once means each appears once, in this string). */
function said(state: Json): string {
  return ((state.events ?? []) as Json[]).filter((e) => e.kind === 'update')
    .map((e) => {
      const update = (e.data as Json).update as Json;
      return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text ?? '') : '';
    }).join('');
}

/** No AIB runs: for longer than the keeper's orphan restart would take (and its give-up), nothing restarts AIB or stops a chat. */
async function noRestart(lab: Lab, pids: number[]): Promise<void> {
  await pause(2500); // QUICK_ORPHAN: the first restart at 0.3 s, the give-up (channels stopped) at about 0.9 s
  assert(
    !lab.orphanRan(),
    'the keeper did not start AIB again (no orphan command ran)',
  );
  assert(lab.held(), 'the keeper says it holds the chats');
  for (const pid of pids) assert(pidAlive(pid), `pid ${pid} lives on`);
}

Deno.test({
  name:
    'quit with work: AIB exits, the keeper holds a streaming chat and never restarts AIB; the next AIB takes it over, nothing lost or repeated',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const childFile = lab.path('child-1');
    const a = lab.studio(
      ['--cancel-aware', '--child-pid-file', childFile],
      true,
    );
    const { app, windows, quits, leaves, closed } = lab.app(a);
    await app.start();
    const c = await a.connect('omp', lab.work);
    assert(c.channel !== null, 'the agent runs in the keeper');
    const agentPid = c.process!.pid;
    await until(
      () => Deno.statSync(childFile).size > 0,
      'the agent child (its helper process)',
      10,
    );
    const childPid = Number(Deno.readTextFileSync(childFile));
    assertEquals(
      (await a.liveCall('prompt', {
        id: c.id,
        text: 'stream:8:300',
        clientMessageId: 'm1',
      }))[0],
      200,
    );
    const [qs, queued] = await a.liveCall('queue', {
      id: c.id,
      text: 'after the quit',
      clientMessageId: 'm2',
    });
    assertEquals(
      [qs, (queued as Json).queued],
      [200, true],
      'the second message waits in the queue',
    );
    await until(
      () => said({ events: c.events }).includes('chunk0 '),
      'streaming',
      10,
    );
    assertEquals(
      c.permissions.size,
      0,
      'the question comes later, with no AIB',
    );

    // Quit AIB from the tray mid-turn: nothing is stopped, AIB exits (the Studio is released), the keeper holds the chat.
    const keeperPid = lab.keeperPid();
    await app.onTrayMenu('quit');
    assertEquals(
      [quits, leaves],
      [[false], [true]],
      'quit, leaving the chats to the keeper',
    );
    await closed();
    assert(!app.background, 'AIB does not stay in the tray');
    assertEquals(windows[0].visible, false);
    lab.studios.splice(lab.studios.indexOf(a), 1);
    await noRestart(lab, [agentPid, childPid, keeperPid]);
    assertEquals(
      prompts(lab.received()).length,
      1,
      'the queued message waits for an AIB',
    );

    // The next AIB (same data folder) takes the chat over from the keeper's record.
    const b = lab.studio(['--cancel-aware'], true);
    assertEquals(await b.adoptKeeper(), 1);
    assert(!lab.held(), 'an AIB is back: the hold ended');
    const r = b.connections.get(c.id)!;
    assertEquals(
      [r.process!.pid, lab.keeperPid()],
      [agentPid, keeperPid],
      'the same agent and keeper processes',
    );
    await until(
      () => r.permissions.size === 1,
      'the question that came with no AIB',
      15,
    );
    const asked = (await b.liveState(c.id, 0))!;
    assertEquals(
      kinds(asked).filter((k) => k === 'permission').length,
      1,
      'the question shows once',
    );
    assertEquals(
      kinds(asked).filter((k) => k === 'user').length,
      1,
      'the prompt shows once',
    );
    assertEquals(
      (await b.liveCall('permission', {
        id: c.id,
        key: [...r.permissions.keys()][0],
        option: 'yes',
      }))[0],
      200,
    );
    await until(() => turnEnds(r) >= 1, 'the streaming turn ends', 20);
    const expected = Array.from(
      { length: 8 },
      (_, i) => (i === 4 ? 'answer=yes ' : '') + `chunk${i} `,
    ).join('');
    const first = said((await b.liveState(c.id, 0))!);
    assert(
      first.startsWith(expected),
      `every chunk once, in order, across the quit: ${first}`,
    );
    // The queued message's turn (the fake agent may ask on it too: answered as the person would).
    await until(
      () => prompts(lab.received()).length === 2,
      'the queued message reached the agent',
      20,
    );
    await until(
      () => r.permissions.size === 1 || (!r.busy && turnEnds(r) >= 2),
      'the queued turn asks or ends',
      15,
    );
    if (r.permissions.size) r.permission([...r.permissions.keys()][0], 'yes');
    await until(
      () => !r.busy && r.queue.items.length === 0 && turnEnds(r) >= 2,
      'the queued turn ended',
      15,
    );
    const received = lab.received();
    assertEquals(
      prompts(received).length,
      2,
      'each message reached the agent once',
    );
    assert(
      JSON.stringify((prompts(received)[1].params as Json).prompt).includes(
        'after the quit',
      ),
    );
    assertEquals(
      answers(received).length,
      1,
      'the answer reached the agent once',
    );
    assert(!lab.orphanRan());
  },
});

Deno.test({
  name: 'quit with work: a chat whose only work is a background helper is held too; agent and helper live on and the next AIB has it',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const childFile = lab.path('child-2');
    const a = lab.studio(['--held-turn', '--child-pid-file', childFile], true);
    const { app, windows, quits, leaves, closed } = lab.app(a);
    await app.start();
    const c = await a.connect('omp', lab.work);
    await until(() => Deno.statSync(childFile).size > 0, 'the agent child', 10);
    const childPid = Number(Deno.readTextFileSync(childFile));
    const agentPid = c.process!.pid;
    const gate = lab.gate();
    await a.liveCall('prompt', {
      id: c.id,
      text: `helper:${gate}`,
      clientMessageId: 'm1',
    });
    await until(
      () => !c.busy && turnEnds(c) === 1,
      'the reply ended, the helper goes on',
      15,
    );
    assertEquals(a.workingList().map((w) => w.state), ['helpers']);

    windows[0].emit('close'); // the window's close button
    await until(() => quits.length === 1, 'quit', 5);
    assertEquals(leaves, [true]);
    await closed();
    lab.studios.splice(lab.studios.indexOf(a), 1);
    await noRestart(lab, [agentPid, childPid]);

    const b = lab.studio(['--held-turn'], true);
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals(r.process!.pid, agentPid);
    await until(
      () => b.workingList().some((w) => w.state === 'helpers'),
      'the helper still works, on the next AIB',
      10,
    );
    lab.open(gate);
    lab.open(gate + '.end');
    await until(() => b.workingList().length === 0, 'the helper finished', 20);
    assert(!lab.orphanRan());
  },
});

Deno.test({
  name: 'quit with work: a chat whose only work is a background shell (Bash run_in_background) is held; the shell lives on and the next AIB has it',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const childFile = lab.path('child-3');
    const a = lab.studio(['--held-turn', '--child-pid-file', childFile], true);
    const { app, quits, leaves, closed } = lab.app(a);
    await app.start();
    const c = await a.connect('omp', lab.work);
    await until(() => Deno.statSync(childFile).size > 0, 'the agent child', 10);
    const agentPid = c.process!.pid;
    const gate = lab.gate();
    await a.liveCall('prompt', { id: c.id, text: `bgshell:${gate}`, clientMessageId: 'm1' });
    await until(() => !c.busy && turnEnds(c) === 1, 'the reply ended, the shell goes on', 15);
    const shellPid = Number(Deno.readTextFileSync(childFile + '.shell'));
    assert(pidAlive(shellPid));
    assertEquals(c.attention().state, 'idle', 'not working in the chat');
    assertEquals(a.workingList().map((w) => w.state), ['background']);

    await app.onTrayMenu('quit'); // Quit AIB
    await until(() => quits.length === 1, 'quit', 5);
    assertEquals(leaves, [true], 'left to the keeper, not quit as idle');
    await closed();
    lab.studios.splice(lab.studios.indexOf(a), 1);
    await noRestart(lab, [agentPid, shellPid]);

    const b = lab.studio(['--held-turn'], true);
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals(r.process!.pid, agentPid);
    await until(
      () => b.workingList().some((w) => w.state === 'background'),
      'the shell still runs, on the next AIB',
      10,
    );
    lab.open(gate);
    await until(() => !pidAlive(shellPid), 'the shell ended', 20);
    await until(() => b.workingList().length === 0, 'the chat dropped out of the list', 20);
    assert(!lab.orphanRan());
  },
});

Deno.test({
  name: 'quit with work the keeper cannot hold (a working chat outside it): AIB stays in the tray and quits by itself once nothing works',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const studio = lab.studio(['--cancel-aware']);
    const { app, quits, closed } = lab.app(studio);
    await app.start();
    const c = await studio.connect('omp', lab.work);
    await studio.liveCall('prompt', {
      id: c.id,
      text: 'stream:4:200',
      clientMessageId: 'm1',
    });
    await until(() => c.busy, 'working', 10);
    const channel = c.channel!;
    channel.lost = true; // as if it ran outside the keeper (only quitHandover reads it before it is put back)
    assert((await studio.quitHandover()).includes('outside the keeper'));
    await app.onTrayMenu('quit');
    assertEquals(quits, [], 'nothing stopped, AIB does not exit');
    assert(app.background);
    channel.lost = false;
    await until(() => c.permissions.size === 1, 'the question', 15);
    c.permission([...c.permissions.keys()][0], 'yes');
    await until(() => !c.busy, 'the turn ended', 15);
    const t0 = Date.now();
    await app.trayTick(t0);
    await app.trayTick(t0 + IDLE_MS + 100);
    assertEquals(quits, [false], 'quit by itself once nothing works');
    await closed();
  },
});

Deno.test({
  name: 'quit keeps agents: quitting with nothing working quits at once and the keeper goes, as before',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const studio = lab.studio(['--cancel-aware'], true);
    const { app, quits, leaves, closed } = lab.app(studio);
    await app.start();
    const c = await studio.connect('omp', lab.work);
    const agentPid = c.process!.pid;
    const keeperPid = lab.keeperPid();
    assert(pidAlive(keeperPid));
    await app.onTrayMenu('quit');
    assertEquals([quits, leaves], [[false], [false]]);
    await closed();
    await until(() => !pidAlive(agentPid), 'the idle agent is closed', 10);
    await until(() => !pidAlive(keeperPid), 'the empty keeper exits', 15);
    assert(!lab.orphanRan());
  },
});

Deno.test({
  name: 'quit keeps agents: Stop all chats and quit (two clicks, no box) stops the working chat, its children and the keeper',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const childFile = lab.path('child-3');
    const studio = lab.studio([
      '--cancel-aware',
      '--child-pid-file',
      childFile,
    ]);
    const { app, updates, quits, closed } = lab.app(studio);
    await app.start();
    const c = await studio.connect('omp', lab.work);
    await until(() => Deno.statSync(childFile).size > 0, 'the agent child', 10);
    const childPid = Number(Deno.readTextFileSync(childFile));
    const agentPid = c.process!.pid;
    const keeperPid = lab.keeperPid();
    await studio.liveCall('prompt', {
      id: c.id,
      text: 'stream:6:250',
      clientMessageId: 'm1',
    });
    await until(() => c.busy, 'working', 10);
    await app.onTrayMenu('stop');
    assertEquals(quits, [], 'the first click only asks, in the menu');
    assertEquals(updates.at(-1)?.slice(1), [
      STOP_INDEX,
      'Click again to stop 1 chat and quit',
    ]);
    await app.onTrayMenu('stop');
    assertEquals(quits, [true]);
    await closed();
    await until(
      () => !pidAlive(agentPid) && !pidAlive(childPid),
      'agent and child stopped',
      10,
    );
    await until(() => !pidAlive(keeperPid), 'the keeper exits', 15);
  },
});

Deno.test({
  name:
    'quit keeps agents: AIB killed mid-turn (release to the keeper, no hold): the next AIB has the question that came meanwhile, and the queue goes on',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio(['--cancel-aware']);
    const c = await a.connect('omp', lab.work);
    const agentPid = c.process!.pid;
    await a.liveCall('prompt', {
      id: c.id,
      text: 'stream:6:250',
      clientMessageId: 'm1',
    });
    await a.liveCall('queue', {
      id: c.id,
      text: 'queued before the kill',
      clientMessageId: 'm2',
    });
    await until(() => c.events.length > 2, 'streaming', 10);
    assertEquals(
      await a.release(),
      1,
      'what main.ts does on a signal with a chat working',
    );
    assert(
      !lab.held(),
      'a kill is not a quit: no hold (the keeper restarts AIB in the tray, rule V1)',
    );
    lab.studios.splice(lab.studios.indexOf(a), 1);
    await pause(1500); // the agent goes on into the keeper: the question arrives while no AIB runs
    assert(pidAlive(agentPid));

    const b = lab.studio(['--cancel-aware']);
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals(r.process!.pid, agentPid, 'the same agent process');
    await until(
      () => r.permissions.size === 1,
      'the question that came meanwhile',
      15,
    );
    assertEquals(r.attention().state, 'needs_you');
    r.permission([...r.permissions.keys()][0], 'yes');
    await until(
      () => r.queue.items.length === 0 && prompts(lab.received()).length === 2,
      'the queue goes on',
      20,
    );
    await until(() => r.permissions.size === 1, 'the queued question', 15);
    r.permission([...r.permissions.keys()][0], 'yes');
    await until(() => !r.busy, 'the queued turn ended', 15);
    const texts = prompts(lab.received()).map((m) => JSON.stringify((m.params as Json).prompt));
    assert(texts[1].includes('queued before the kill'), texts[1]);
  },
});

Deno.test({
  name: 'quit with work: the artifact tool forwarder answers at once with a clear, retryable "AIB is closed" while no AIB runs',
  ...T,
  async fn() {
    const forwarder = await keeperBinary();
    await using lab = new Lab();
    Deno.mkdirSync(lab.state, { recursive: true });
    const file = `${lab.state}${SEP}${FORWARD_FILE}`;
    const server = new ArtifactMcpHttp({
      conversation: () => null,
      baseUrl: () => '',
      urlFile: '',
      addressFile: file,
    });
    server.start();
    assert(
      JSON.parse(Deno.readTextFileSync(file)).url.startsWith(
        'http://127.0.0.1:',
      ),
      'AIB publishes its address',
    );
    await server.close(true); // what Studio.release({ hold: true }) does: AIB quit with its chats left in the keeper
    assertEquals(JSON.parse(Deno.readTextFileSync(file)), {
      closed: true,
      pid: Deno.pid,
    });

    const call = {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'publish', arguments: {} },
    };
    const started = Date.now();
    const child = new Deno.Command(forwarder, {
      args: ['mcp-forward', file],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(call) + '\n'));
    await writer.close();
    const out = await child.output();
    const took = Date.now() - started;
    const reply = JSON.parse(new TextDecoder().decode(out.stdout).trim());
    assert(
      took < 5000,
      `answered at once, not after the 15 s retry (${took} ms)`,
    );
    assertEquals(
      [reply.id, reply.result.isError],
      [5, true],
      JSON.stringify(reply),
    );
    const text = String(reply.result.content[0].text);
    assert(
      text.includes('AIB is closed') && text.includes('try again later'),
      text,
    );

    // A plain close (an update, a restart: the next AIB comes in seconds) removes the file, so the forwarder waits for it instead.
    const again = new ArtifactMcpHttp({
      conversation: () => null,
      baseUrl: () => '',
      urlFile: '',
      addressFile: file,
    });
    again.start();
    await again.close();
    assert(
      !(() => {
        try {
          return Deno.statSync(file).isFile;
        } catch {
          return false;
        }
      })(),
      'removed',
    );
  },
});

Deno.test({
  name: 'next AIB and a keeper it cannot use: no takeover, nothing stopped, and the page says so',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio(['--cancel-aware']);
    const c = await a.connect('omp', lab.work);
    const agentPid = c.process!.pid;
    assertEquals(await a.release({ hold: true }), 1);
    lab.studios.splice(lab.studios.indexOf(a), 1);
    const b = lab.studio(['--cancel-aware']);
    const real = await b.keeper!.client(false);
    // The running keeper as an older one would answer: without what this AIB needs (release.json keeper.needs).
    Object.defineProperty(real!, 'features', {
      value: ['pty'],
      configurable: true,
    });
    assertEquals(await b.adoptKeeper(), 0, 'not taken over');
    assert(
      keeperTakeoverProblem().includes('lacks notes, once, channel-ids'),
      keeperTakeoverProblem(),
    );
    assert(
      keeperTakeoverProblem().includes('Nothing was stopped'),
      keeperTakeoverProblem(),
    );
    assert(pidAlive(agentPid), 'the agent still runs in the keeper');
    assert(
      lab.held(),
      'an AIB that only looked leaves the hold: the chats still wait for one that can take them',
    );
    noteKeeperTakeoverProblem('');
  },
});
