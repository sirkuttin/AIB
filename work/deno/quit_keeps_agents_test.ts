/**
 * Quitting AIB never stops a chat (owner's decision 2026-11-10; the keeper exists so that nothing breaks when AIB goes away).
 * End to end with the real pieces main.ts wires together: the real keeper (built from keeper/ with Go), a real Studio whose agents
 * run in it, fake ACP agents (work/fake_acp.py), and the desktop window/tray logic (DesktopApp) on a fake Shell, so no window, tray
 * icon or dialog is ever shown. Temp state folders only.
 *
 *   - Quit AIB / closing the window with a chat working: nothing is stopped, the window goes, AIB stays in the tray ("1 chat
 *     needs you"); the agent and the keeper live on, a question that arrives meanwhile is there when AIB is opened again, the queue
 *     drains, and once nothing works AIB quits by itself and the keeper exits by its idle rule.
 *   - A chat whose only work is a background helper (Claude Code's held turn) keeps AIB in the tray the same way; the agent's
 *     child process (its helper) lives until the helper is done.
 *   - Quitting with nothing working quits at once and the keeper goes as before.
 *   - Stop all chats and quit (two clicks in the menu, no box) stops the agent and its children.
 *   - AIB killed (a signal: main.ts releases working chats to the keeper) or crashing: a new AIB takes the chat over with the
 *     question that arrived meanwhile, and the queue goes on there.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import {
  DesktopApp,
  type Shell,
  STOP_INDEX,
  type WindowHandle,
} from '../../outputs/agent-studio/server/desktop/window.ts';
import { trayIconPng } from '../../outputs/agent-studio/server/desktop/tray_icon.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const IDLE_MS = 5000;

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
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-quit-keeps-' }));
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

  studio(flags: string[]): Studio {
    // The keeper as the app starts it, but quicker to go once it is empty (the real one waits longer); no orphan restart here.
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '60s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake(...flags), cwd, provider, { ...options, env: { FAKE_ACP_LOG: this.agentLog } });
    this.studios.push(studio);
    return studio;
  }

  /**
   * The desktop app over a Studio, wired as main.ts does it: the status line and the quit rule from Studio.workingList, quitting
   * through the normal close path (Studio.close: what WebServer close -> host.close() does). A fake Shell: nothing on screen.
   */
  app(studio: Studio) {
    const windows: Win[] = [];
    const updates: [string, number, string][] = [];
    const quits: boolean[] = [];
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
        return Promise.resolve({ working: working.length, needsYou: working.filter((w) => w.state === 'needs_you').length });
      },
      quit: (stop) => {
        quits.push(stop);
        closed = studio.close();
        return closed;
      },
      saveDelayMs: 0,
      watchdogMs: 0,
      trayPollMs: 0,
      trayIdleQuitMs: IDLE_MS,
    });
    return { app, windows, updates, quits, closed: () => closed };
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
const turnEnds = (c: Connection) => c.events.filter((e) => e.kind === 'turn_end').length;

/** Advance the tray's clock past the idle time with real ticks in between (the status line and the idle rule). */
async function idleOut(app: DesktopApp): Promise<void> {
  const t0 = Date.now();
  await app.trayTick(t0);
  await app.trayTick(t0 + IDLE_MS + 100);
}

Deno.test({
  name: 'quit keeps agents: Quit AIB with a chat working stops nothing; a question that came meanwhile shows on reopen; the queue drains; then AIB and the keeper go',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const childFile = lab.path('child-1');
    const studio = lab.studio(['--cancel-aware', '--child-pid-file', childFile]);
    const { app, windows, updates, quits, closed } = lab.app(studio);
    await app.start();
    const c = await studio.connect('omp', lab.work);
    assert(c.channel !== null, 'the agent runs in the keeper');
    const agentPid = c.process!.pid;
    await until(() => Deno.statSync(childFile).size > 0, 'the agent child (its helper process)', 10);
    const childPid = Number(Deno.readTextFileSync(childFile));
    assertEquals((await studio.liveCall('prompt', { id: c.id, text: 'stream:6:250', clientMessageId: 'm1' }))[0], 200);
    const [qs, queued] = await studio.liveCall('queue', { id: c.id, text: 'after the quit', clientMessageId: 'm2' });
    assertEquals([qs, (queued as Json).queued], [200, true], 'the second message waits in the queue');

    // Quit AIB from the tray while it works.
    const seenAtQuit = c.events.length;
    await app.onTrayMenu('quit');
    assertEquals(quits, [], 'nothing is stopped');
    assert(app.background, 'AIB stays in the tray and will quit by itself');
    assertEquals(windows[0].visible, false, 'the window is gone');
    await app.trayTick(Date.now() + 60_000);
    assertEquals(quits, [], 'still working: no idle quit');
    assert(pidAlive(agentPid) && pidAlive(childPid) && pidAlive(lab.keeperPid()), 'agent, its child and the keeper live on');

    // While AIB is "closed": the question arrives; the tray says so.
    await until(() => c.permissions.size === 1, 'the question', 15);
    await app.trayTick();
    assertEquals(updates.filter((u) => u[1] === 1).at(-1), ['AIB · 1 chat needs you', 1, '1 chat needs you']);

    // Reopen: same chat, live; everything since the quit is there, the question included.
    await app.onTrayMenu('open');
    assert(!app.background);
    assertEquals(windows[0].visible, true);
    const state = (await studio.liveState(c.id, seenAtQuit))!;
    const kinds = (state.events as Json[]).map((e) => e.kind);
    assert(kinds.includes('permission'), `events since the quit: ${kinds}`);
    assert(kinds.filter((k) => k === 'update').length > 0, 'the streaming that went on while AIB was closed');
    const key = [...c.permissions.keys()][0];
    assertEquals((await studio.liveCall('permission', { id: c.id, key, option: 'yes' }))[0], 200);

    // Quit again: the turn finishes and the queue drains with AIB in the tray, no window.
    await app.onTrayMenu('quit');
    assert(app.background);
    // The queued message goes out by itself (the fake agent asks again on every turn: answered here, as the person would).
    await until(() => prompts(lab.received()).length === 2 && c.queue.items.length === 0, 'the queue drained', 20);
    await until(() => c.permissions.size === 1, 'the second question', 15);
    c.permission([...c.permissions.keys()][0], 'yes');
    await until(() => !c.busy, 'the second turn ended', 15);
    assertEquals(turnEnds(c), 2);
    assertEquals(quits, []);

    // Nothing works any more: AIB quits by itself, the keeper exits by its idle rule.
    const keeperPid = lab.keeperPid();
    await idleOut(app);
    assertEquals(quits, [false], 'quit by itself, nothing stopped by force');
    await closed();
    await until(() => !pidAlive(keeperPid), 'the empty keeper exits', 15);
    await until(() => !pidAlive(agentPid) && !pidAlive(childPid), 'the idle agent ends with it', 10);
  },
});

Deno.test({
  name: 'quit keeps agents: a chat whose only work is a background helper keeps AIB in the tray; agent and helper live until it is done',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const childFile = lab.path('child-2');
    const studio = lab.studio(['--held-turn', '--child-pid-file', childFile]);
    const { app, windows, quits, closed } = lab.app(studio);
    await app.start();
    const c = await studio.connect('omp', lab.work);
    await until(() => Deno.statSync(childFile).size > 0, 'the agent child', 10);
    const childPid = Number(Deno.readTextFileSync(childFile));
    const agentPid = c.process!.pid;
    const gate = lab.gate();
    await studio.liveCall('prompt', { id: c.id, text: `helper:${gate}`, clientMessageId: 'm1' });
    await until(() => !c.busy && turnEnds(c) === 1, 'the reply ended, the helper goes on', 15);
    assertEquals(studio.workingList().map((w) => w.state), ['helpers']);

    windows[0].emit('close'); // the window's close button
    await pause(50);
    assertEquals(quits, []);
    assert(app.background);
    await app.trayTick(Date.now() + 60_000);
    assertEquals(quits, [], 'the helper still works');
    assert(pidAlive(agentPid) && pidAlive(childPid), 'agent and helper live on');

    // Reopen and close again while it still runs: same rule.
    await app.onTrayMenu('open');
    assertEquals(windows.length, 2, 'a new window on the same chats');
    assertEquals(studio.connections.get(c.id), c);
    windows[1].emit('close');
    await pause(50);
    assert(app.background);

    lab.open(gate);
    lab.open(gate + '.end');
    await until(() => studio.workingList().length === 0, 'the helper finished', 20);
    await idleOut(app);
    assertEquals(quits, [false]);
    await closed();
  },
});

Deno.test({
  name: 'quit keeps agents: quitting with nothing working quits at once and the keeper goes, as before',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const studio = lab.studio(['--cancel-aware']);
    const { app, quits, closed } = lab.app(studio);
    await app.start();
    const c = await studio.connect('omp', lab.work);
    const agentPid = c.process!.pid;
    const keeperPid = lab.keeperPid();
    assert(pidAlive(keeperPid));
    await app.onTrayMenu('quit');
    assertEquals(quits, [false]);
    await closed();
    await until(() => !pidAlive(agentPid), 'the idle agent is closed', 10);
    await until(() => !pidAlive(keeperPid), 'the empty keeper exits', 15);
  },
});

Deno.test({
  name: 'quit keeps agents: Stop all chats and quit (two clicks, no box) stops the working chat, its children and the keeper',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const childFile = lab.path('child-3');
    const studio = lab.studio(['--cancel-aware', '--child-pid-file', childFile]);
    const { app, updates, quits, closed } = lab.app(studio);
    await app.start();
    const c = await studio.connect('omp', lab.work);
    await until(() => Deno.statSync(childFile).size > 0, 'the agent child', 10);
    const childPid = Number(Deno.readTextFileSync(childFile));
    const agentPid = c.process!.pid;
    const keeperPid = lab.keeperPid();
    await studio.liveCall('prompt', { id: c.id, text: 'stream:6:250', clientMessageId: 'm1' });
    await until(() => c.busy, 'working', 10);
    await app.onTrayMenu('stop');
    assertEquals(quits, [], 'the first click only asks, in the menu');
    assertEquals(updates.at(-1)?.slice(1), [STOP_INDEX, 'Click again to stop 1 chat and quit']);
    await app.onTrayMenu('stop');
    assertEquals(quits, [true]);
    await closed();
    await until(() => !pidAlive(agentPid) && !pidAlive(childPid), 'agent and child stopped', 10);
    await until(() => !pidAlive(keeperPid), 'the keeper exits', 15);
  },
});

Deno.test({
  name: 'quit keeps agents: AIB killed mid-turn (release to the keeper) — the next AIB has the question that came meanwhile, and the queue goes on',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio(['--cancel-aware']);
    const c = await a.connect('omp', lab.work);
    const agentPid = c.process!.pid;
    await a.liveCall('prompt', { id: c.id, text: 'stream:6:250', clientMessageId: 'm1' });
    await a.liveCall('queue', { id: c.id, text: 'queued before the kill', clientMessageId: 'm2' });
    await until(() => c.events.length > 2, 'streaming', 10);
    assertEquals(await a.release(), 1, 'what main.ts does on a signal with a chat working');
    lab.studios.splice(lab.studios.indexOf(a), 1);
    await pause(1500); // the agent goes on into the keeper: the question arrives while no AIB runs
    assert(pidAlive(agentPid));

    const b = lab.studio(['--cancel-aware']);
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals(r.process!.pid, agentPid, 'the same agent process');
    await until(() => r.permissions.size === 1, 'the question that came meanwhile', 15);
    assertEquals(r.attention().state, 'needs_you');
    r.permission([...r.permissions.keys()][0], 'yes');
    await until(() => r.queue.items.length === 0 && prompts(lab.received()).length === 2, 'the queue goes on', 20);
    await until(() => r.permissions.size === 1, 'the queued question', 15);
    r.permission([...r.permissions.keys()][0], 'yes');
    await until(() => !r.busy, 'the queued turn ended', 15);
    const texts = prompts(lab.received()).map((m) => JSON.stringify((m.params as Json).prompt));
    assert(texts[1].includes('queued before the kill'), texts[1]);
  },
});
