/**
 * The agent host's life without an app (docs/agent-host.md, "Lifecycle"): the host of the built app shows its own tray icon while
 * chats work with no app attached ("AIB · 2 chats running", Open AIB / Stop all chats), hides it when an app attaches, and exits a
 * few seconds after the last app left with nothing working. Also: both log files get their startup and stop lines, and a stop that
 * hangs in an agent still ends the process. Unit tests use a fake tray; the process tests run real Deno hosts (no tray: --tray is
 * only passed by the built app, and a tray icon must never show on this desktop) with the fake ACP agent.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, MAIN, openConversation, sleep, TEST_OPTIONS, until } from './_host_fixture.ts';
import { AgentHost } from '../../outputs/agent-studio/server/host/agent_host.ts';
import { HOST_TRAY_ITEMS, hostTrayView, stopQuestion } from '../../outputs/agent-studio/server/desktop/host_tray.ts';
import type { HostTray, HostTrayView } from '../../outputs/agent-studio/server/desktop/host_tray.ts';
import { decodeRgba, withAttentionDot } from '../../outputs/agent-studio/server/desktop/png_badge.ts';
import { trayIconBytes } from '../../outputs/agent-studio/server/desktop/tray_icon.ts';
import { HostClient, pidAlive, readInfo } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_HOST_EXIT_SECONDS, hostCommand } from '../../outputs/agent-studio/server/main.ts';
import { parseOptions } from '../../outputs/agent-studio/server/core/options.ts';
import * as log from '../../outputs/agent-studio/server/core/log.ts';

type Json = Record<string, unknown>;
const t = (name: string, fn: () => Promise<void> | void) => Deno.test({ name, ...TEST_OPTIONS, fn });

class FakeTray implements HostTray {
  shown: string | null = null;
  view: HostTrayView | null = null;
  events: string[] = [];
  closed = false;
  show(view: HostTrayView) {
    if (this.shown !== view.tooltip) this.events.push(`show ${view.tooltip}`);
    this.shown = view.tooltip;
    this.view = view;
  }
  hide() {
    this.events.push('hide');
    this.shown = null;
  }
  close() {
    this.closed = true;
    this.shown = null;
  }
}

function makeHost(o: { exit?: number; busy?: number } = {}) {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-lifecycle-' });
  const tray = new FakeTray();
  const menu: { open: () => void; stop: () => void } = { open: () => {}, stop: () => {} };
  const spawned: string[][] = [];
  let made = 0;
  const host = new AgentHost({ ompCommand: 'unused', stateDir: dir, port: 0 } as never, 30, 0, {
    tray: (onOpen, onStop) => {
      made++;
      menu.open = onOpen;
      menu.stop = onStop;
      return tray;
    },
    exitUnattachedSeconds: o.exit ?? 15,
    spawn: (command) => void spawned.push(command),
  });
  const state = { busy: o.busy ?? 0, needs: 0 };
  host.studio.workingList = () =>
    Array.from({ length: state.busy }, (_, i) => ({ id: `c${i}`, provider: 'claude', cwd: dir, state: i < state.needs ? 'needs_you' : 'working' }));
  host.studio.busyList = host.studio.workingList;
  host.dataNote = () => '';
  return {
    host,
    tray,
    menu,
    spawned,
    state,
    made: () => made,
    done: async () => {
      await host.studio.close();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

t('tooltip, status line and menu: "AIB · N chats running", needs you, the data folder; Open AIB / status / Stop chats and quit', async () => {
  assertEquals(hostTrayView(1, 0), { tooltip: 'AIB · 1 chat running', status: '1 chat running', attention: false });
  assertEquals(hostTrayView(2, 0).tooltip, 'AIB · 2 chats running');
  assertEquals(hostTrayView(3, 1), { tooltip: 'AIB · 1 chat needs you, 2 running', status: '1 chat needs you, 2 running', attention: true });
  assertEquals(hostTrayView(2, 2).tooltip, 'AIB · 2 chats need you');
  assertEquals(hostTrayView(1, 0, 'C:\\demo').tooltip, 'AIB · 1 chat running (data: C:\\demo)');
  assertEquals(HOST_TRAY_ITEMS.map((i) => [i.id, i.label, !!i.disabled]), [['open', 'Open AIB', false], ['status', '', true], [
    'stop',
    'Stop chats and quit',
    false,
  ]]);
  assertEquals(stopQuestion(hostTrayView(2, 0)), 'Stop chats and quit AIB?\n\n2 chats running. Their current turn is interrupted.');
  const png = trayIconBytes({ art: 'dark', size: 32 });
  const dotted = await withAttentionDot(png);
  const a = (await decodeRgba(png))!, b = (await decodeRgba(dotted))!;
  assertEquals([b.width, b.height], [a.width, a.height]);
  const corner = ((b.height - 6) * b.width + (b.width - 6)) * 4;
  assertEquals([...b.pixels.slice(corner, corner + 4)], [0xf5, 0x9e, 0x0b, 255], 'an amber dot in the lower right corner');
  assertEquals([...b.pixels.slice(0, 4)], [...a.pixels.slice(0, 4)], 'the rest unchanged');
});

t('a chat that needs you keeps the host and switches the icon to its attention image; it never idle-exits', async () => {
  const h = makeHost({ busy: 2, exit: 10 });
  try {
    h.state.needs = 1;
    assertEquals(h.host.lifecycleCheck(1000), false);
    assertEquals(h.tray.view, { tooltip: 'AIB · 1 chat needs you, 1 running', status: '1 chat needs you, 1 running', attention: true });
    h.state.busy = 1;
    assertEquals(h.host.lifecycleCheck(1000 + 86400), false, 'waiting a day for an answer is fine');
    assertEquals(h.tray.view?.tooltip, 'AIB · 1 chat needs you');
  } finally {
    await h.done();
  }
});

t('the tray shows only while chats work with no app attached; an app attaching hides it, detaching shows it again', async () => {
  const h = makeHost({ busy: 0 });
  try {
    h.host.opAttach({ pid: 1, webInstanceId: 'w1', port: 8901 });
    h.state.busy = 2;
    assertEquals(h.host.lifecycleCheck(), false);
    assertEquals(h.tray.shown, null, 'an app is attached: no host tray (the app has its own)');
    assertEquals(h.made(), 0, 'not even created');
    h.host.opDetach({ pid: 1, webInstanceId: 'w1' });
    assertEquals(h.tray.shown, 'AIB · 2 chats running', 'shown at once on detach');
    h.state.busy = 1;
    assertEquals(h.host.lifecycleCheck(), false, 'never exits while a chat works');
    assertEquals(h.tray.shown, 'AIB · 1 chat running', 'the count follows');
    h.host.opAttach({ pid: 2, webInstanceId: 'w2', port: 8901 });
    assertEquals(h.tray.shown, null, 'hidden at once when an app attaches');
    h.host.opDetach({ pid: 2, webInstanceId: 'w2' });
    assertEquals(h.tray.shown, 'AIB · 1 chat running');
    h.state.busy = 0;
    h.host.lifecycleCheck();
    assertEquals(h.tray.shown, null, 'the last chat finished: hidden');
    assertEquals(h.made(), 1, 'one tray for the host, shown and hidden');
  } finally {
    await h.done();
  }
});

t('an app crash (no detach) counts once its heartbeat is stale', async () => {
  const h = makeHost({ busy: 1 });
  try {
    h.host.opAttach({ pid: 1, webInstanceId: 'w1' });
    assertEquals(h.tray.shown, null);
    h.host.web.get('w1')!.seen -= AgentHost.ATTACH_FRESH_SECONDS + 1;
    h.host.lifecycleCheck();
    assertEquals(h.tray.shown, 'AIB · 1 chat running');
  } finally {
    await h.done();
  }
});

t('exit: no app and nothing working for the grace period; an open but idle chat does not keep the host', async () => {
  const h = makeHost({ exit: 15, busy: 0 });
  try {
    const t0 = 1000;
    assertEquals(h.host.lifecycleCheck(t0), false, 'starts the clock');
    assertEquals(h.host.lifecycleCheck(t0 + 14), false);
    assertEquals(h.host.lifecycleCheck(t0 + 15), true);
    h.host.unattachedSince = null;
    h.host.opAttach({ pid: 1, webInstanceId: 'w1' });
    assertEquals(h.host.lifecycleCheck(t0 + 100), false, 'an app attached resets it');
    h.host.opDetach({ pid: 1, webInstanceId: 'w1' });
    h.state.busy = 1;
    assertEquals(h.host.lifecycleCheck(t0 + 200), false);
    assertEquals(h.host.lifecycleCheck(t0 + 400), false, 'a working chat keeps it as long as it works');
    h.state.busy = 0;
    assertEquals(h.host.lifecycleCheck(t0 + 401), false, 'the clock starts when the last chat finishes');
    assertEquals(h.host.lifecycleCheck(t0 + 416), true);
  } finally {
    await h.done();
  }
});

t('working, exactly: queued prompts and agent install or sign-in jobs count; an open idle chat does not', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-lifecycle-' });
  const host = new AgentHost({ ompCommand: 'unused', stateDir: dir, port: 0 } as never, 30, 0, { exitUnattachedSeconds: 10 });
  const studio = host.studio;
  try {
    const idle = { id: 'a', provider: 'claude', cwd: dir, closed: false, queue: { items: [] }, attention: () => ({ state: 'idle' }) };
    const queued = { ...idle, id: 'b', queue: { items: [{ id: 'q' }] } };
    studio.connections.set('a', idle as never);
    assertEquals(studio.workingList(), [], 'open but idle');
    studio.connections.set('b', queued as never);
    assertEquals(studio.workingList().map((w) => w.state), ['queued']);
    studio.connections.delete('b');
    studio.installer = { jobs: new Map([['codex', { alive: true }], ['claude', { alive: false }]]) } as never;
    assertEquals(studio.workingList().map((w) => [w.state, w.provider]), [['installing', 'codex']]);
    studio.installer = null;
    studio.signer = { jobs: new Map([['claude', { alive: true }]]) } as never;
    assertEquals(studio.workingList().map((w) => w.state), ['needs_you'], 'a sign-in waits for the person');
    studio.signer = null;
    assertEquals(host.lifecycleCheck(5000), false);
    assertEquals(host.lifecycleCheck(5010), true, 'only the idle chat: exits after the grace');
  } finally {
    studio.connections.clear();
    await studio.close();
    Deno.removeSync(dir, { recursive: true });
  }
  const off = makeHost({ exit: 0 });
  try {
    assertEquals(off.host.lifecycleCheck(1), false);
    assertEquals(off.host.lifecycleCheck(100000), false, '0 = off (a source run keeps --idle-exit-minutes only)');
  } finally {
    await off.done();
  }
});

t('tray menu: Open AIB runs the last app launch command; Stop chats and quit (confirmed) stops the host', async () => {
  const h = makeHost({ busy: 2 });
  try {
    h.host.opAttach({ pid: 1, webInstanceId: 'w1', launch: ['C:\\AIB\\AIB.exe', 'serve', '--port', '8901'] });
    h.host.opAttach({ pid: 1, webInstanceId: 'w1', launch: ['bad', 7] }); // not a list of strings: ignored
    h.host.opDetach({ pid: 1, webInstanceId: 'w1' });
    h.menu.open();
    await sleep(0);
    assertEquals(h.spawned, [['C:\\AIB\\AIB.exe', 'serve', '--port', '8901']]);
    assertEquals(h.host.stopEvent.isSet(), false);
    h.menu.stop();
    assertEquals(h.host.stopEvent.isSet(), true);
    assertEquals(h.host.stopReason, 'Stop chats and quit (the tray menu)');
  } finally {
    await h.done();
  }
});

t('a stop that hangs in an agent still ends the process (hard exit after the deadline)', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-lifecycle-' });
  const exits: number[] = [];
  const saved = AgentHost.STOP_DEADLINE_SECONDS;
  AgentHost.STOP_DEADLINE_SECONDS = 0.6;
  const host = new AgentHost({ ompCommand: 'unused', stateDir: dir, port: 0 } as never, 30, 0, { hardExit: () => void exits.push(1) });
  const close = host.studio.close.bind(host.studio);
  try {
    host.studio.close = () => sleep(1500).then(close); // an agent that takes too long to close
    await host.shutdown();
    assertEquals(exits, [1]);
    exits.length = 0;
    host.studio.close = () => Promise.resolve();
    await host.shutdown();
    await sleep(800);
    assertEquals(exits, [], 'a prompt stop never hits the deadline');
  } finally {
    AgentHost.STOP_DEADLINE_SECONDS = saved;
    await close();
    Deno.removeSync(dir, { recursive: true });
  }
});

t('the built app starts its host with --tray and a 10 s unattached exit; a source run does not', () => {
  const o = parseOptions(['--state-dir', 'X']);
  const built = hostCommand(o, true);
  assert(built.includes('--tray'));
  assertEquals(built.slice(built.indexOf('--exit-unattached-seconds'), built.indexOf('--exit-unattached-seconds') + 2), [
    '--exit-unattached-seconds',
    String(APP_HOST_EXIT_SECONDS),
  ]);
  assertEquals(APP_HOST_EXIT_SECONDS, 10);
  assertEquals(AgentHost.ATTACH_FRESH_SECONDS, 25, 'an app that stopped heartbeating counts as gone after 25 s');
  const source = hostCommand(o, false);
  assert(!source.includes('--tray') && !source.includes('--exit-unattached-seconds'));
});

// ---- real processes --------------------------------------------------------------------------------------------------

function logOf(path: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return '';
  }
}

t('process: a host with no app and nothing working exits after its grace; both logs say why', async () => {
  await using fx = new Fixture();
  const [host, hostLog] = fx.spawn([Deno.execPath(), 'run', '-A', '--quiet', MAIN, 'host', ...fx.agentFlags(), '--exit-unattached-seconds', '2'], 'host');
  fx.hostPids.add(host.pid);
  await until(async () => (await readInfo(fx.state)) !== null, 'host file', 30);
  const started = Date.now();
  const status = await Promise.race([host.status, sleep(20000).then(() => null)]);
  assert(status !== null, 'the host exited by itself');
  assert(Date.now() - started >= 1500, 'not before the grace');
  assertEquals(status!.code, 0);
  assertEquals(await readInfo(fx.state), null, 'its host file is gone');
  const text = fx.read(hostLog);
  assert(/INFO agent_host: AIB \S+ agent host started \(pid \d+, program .+, data .+, tray off, exits 2 s after the last app leaves/.test(text), text);
  assert(text.includes('idle countdown started: no app attached and nothing working; exiting in 2 s'), text);
  assert(text.includes('stopping: no app attached and no chat working for 2 s; 0 were working'), text);
  assert(text.includes('agent host stopped'), text);
});

t('process: the web server quits with a chat working: the host keeps it, exits a grace after it finishes; studio.log and agent-host.log tell the story', async () => {
  await using fx = new Fixture();
  // The lifecycle flags the built app gives its host (hostCommand, compiled), minus --tray (no icon on this desktop).
  const [host, hostLog] = fx.spawn([Deno.execPath(), 'run', '-A', '--quiet', MAIN, 'host', ...fx.agentFlags(), '--exit-unattached-seconds', '2'], 'host');
  fx.hostPids.add(host.pid);
  await until(async () => (await readInfo(fx.state))?.pid === host.pid, 'host file', 30);
  const web = await fx.startWeb();
  assertEquals(web.boot.hostPid, host.pid, 'the web server attached to the running host');
  const cid = await openConversation(web, fx);
  assertEquals((await web.post('prompt', { id: cid, text: 'wait', clientMessageId: 't1' }))[0], 200);
  await until(async () => (await web.state(cid)).busy, 'working');
  // The app quits the way DesktopApp does: an unforced stop (refused: a chat works), then its normal close path (detach).
  const refused = await new HostClient((await readInfo(fx.state))!).call('stop', { force: false }, 10) as Json;
  assertEquals(refused.stopping, false);
  assertEquals((await web.post('shutdown', {}))[0], 200);
  await Promise.race([web.process.status, sleep(15000)]);
  await sleep(4000);
  assert(pidAlive(host.pid), 'the working chat keeps the host past its grace');
  const client = new HostClient((await readInfo(fx.state))!);
  assertEquals(((await client.call('busy', null, 10)) as Json).busy instanceof Array, true);
  await client.call('live', { name: 'cancel', body: { id: cid } }, 30); // the turn ends with no app attached
  const status = await Promise.race([host.status, sleep(30000).then(() => null)]);
  assert(status !== null, 'exited after the chat finished');
  const text = fx.read(hostLog);
  assert(text.includes('app attached'), text);
  assert(/app detached \(pid \d+\); 1 working/.test(text), text);
  assert(/stop asked by .+ refused: 1 working/.test(text), text);
  assert(text.includes('stopping: no app attached and no chat working for 2 s'), text);
  const studioLog = logOf(`${fx.state}/studio.log`);
  assert(/INFO studio: AIB \S+ on http:\/\/127\.0\.0\.1:\d+ \(pid \d+, server/.test(studioLog), studioLog);
  assert(studioLog.includes('closing (shutdown requested)'), studioLog);
});

t('log: announce lines reach the file at the default WARNING level', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-log-' });
  try {
    const path = log.setup('studio', { level: 'WARNING', stateDir: dir, filename: 'studio.log', stream: false })!;
    log.getLogger('x').info('hidden at WARNING');
    log.announce('studio', 'closing (%s)', 'test');
    log.setup('studio', { stream: false }); // closes the file handler
    const text = Deno.readTextFileSync(path);
    assert(text.includes('closing (test)'));
    assert(!text.includes('hidden at WARNING'));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
