/**
 * Linux notifications with buttons end to end, headless, with the Ubuntu WSL distro as the Linux machine (skips cleanly without WSL,
 * the distro, dbus-run-session or Go). The real `AIB-keeper toast` (cross-built for Linux) talks over a real D-Bus session bus to a
 * fake org.freedesktop.Notifications server (keeper/internal/fakenotify), each on a private bus made by dbus-run-session, so nothing
 * reaches a desktop. AIB's side runs here on Windows: the Linux route (toast_linux.ts) and toast_act.ts with a fake AIB.
 *  - the keeper's own bus tests (keeper/toast_linux_test.go) pass on the private bus;
 *  - KDE-like server (inline-reply): a body click opens the chat's row; Allow and Deny answer the agent with the right option;
 *    the inline reply's text is sent to the chat; Continue and Retry act; a request answered elsewhere gets CloseNotification;
 *  - AIB quit: the helper stays, writes the click to toast-inbox.jsonl, starts AIB's program with the activation token and exits;
 *    AIB, started again, applies the click with the code it issued before quitting;
 *  - GNOME-like server (no inline-reply, body-markup): the reply box is an Open button that opens the chat; the body is escaped.
 */
import { assert, assertEquals } from './_assert.ts';
import type { InboxRow } from '../../outputs/agent-studio/server/attention/inbox_rules.ts';
import { INBOX } from '../../outputs/agent-studio/server/attention/inbox_rules.ts';
import type { NotifyTarget, OsNotify } from '../../outputs/agent-studio/server/desktop/notify.ts';
import {
  keeperToastSpawner,
  type SpawnToastHelper,
  ToastCodes,
  type WindowsToasts,
} from '../../outputs/agent-studio/server/desktop/toast.ts';
import { takePending, type ToastActDeps } from '../../outputs/agent-studio/server/desktop/toast_act.ts';
import { applyLinuxClick, DESKTOP_ENTRY, linuxRoute } from '../../outputs/agent-studio/server/desktop/toast_linux.ts';

const DISTRO = 'Ubuntu';
const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const KEEPER_DIR = new URL('../../keeper/', import.meta.url);
const native = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');

function listedDistros(): string[] {
  if (Deno.build.os !== 'windows') return [];
  try {
    const out = new Deno.Command('wsl.exe', { args: ['-l', '-q'], stdout: 'piped', stderr: 'null', stdin: 'null' }).outputSync();
    return new TextDecoder('utf-16le').decode(out.stdout).split(/\r?\n/).map((l) => l.replaceAll('\0', '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function wslSync(args: string[]): { code: number; stdout: string } {
  const out = new Deno.Command('wsl.exe', {
    args: ['-d', DISTRO, '--cd', '/tmp', ...args],
    stdout: 'piped',
    stderr: 'piped',
    stdin: 'null',
  })
    .outputSync();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
}

function hasGo(): boolean {
  try {
    return new Deno.Command('go', { args: ['version'], stdout: 'null', stderr: 'null', stdin: 'null' }).outputSync().success;
  } catch {
    return false;
  }
}

const READY = listedDistros().some((d) => d.toLowerCase() === DISTRO.toLowerCase()) && hasGo() &&
  wslSync(['--exec', 'test', '-x', '/usr/bin/dbus-run-session']).code === 0;

const toWsl = (p: string) => wslSync(['--exec', 'wslpath', '-u', p.replace(/\\/g, '/')]).stdout.trim();

async function goBuild(dir: string): Promise<void> {
  const env = { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' };
  for (
    const args of [
      ['build', '-trimpath', '-o', `${dir}/AIB-keeper`, '.'],
      ['build', '-o', `${dir}/fakenotify`, './internal/fakenotify/cmd/fakenotify'],
      ['test', '-c', '-o', `${dir}/keeper.test`, '.'],
    ]
  ) {
    const out = await new Deno.Command('go', { args, cwd: native(KEEPER_DIR), env, stdout: 'piped', stderr: 'piped', stdin: 'null' })
      .output();
    assert(out.success, `go ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

let built: Promise<{ win: string; wsl: string }> | null = null;
function binaries() {
  built ??= (async () => {
    const win = await Deno.makeTempDir({ prefix: 'aib-fdo-bin-' });
    await goBuild(win);
    return { win, wsl: toWsl(win) };
  })();
  return built;
}

async function until(what: string, ok: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface FakeCall {
  id: number;
  summary: string;
  body: string;
  actions: string[];
  hints: Json;
}

/** The fake notification server on its own private bus (dbus-run-session), driven over stdio. */
async function fakeServer(bin: string, caps: string) {
  const child = new Deno.Command('wsl.exe', {
    args: ['-d', DISTRO, '--cd', '/tmp', '--exec', 'dbus-run-session', '--', `${bin}/fakenotify`, '-caps', caps],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'null',
  }).spawn();
  const events: Json[] = [];
  const writer = child.stdin.getWriter();
  (async () => {
    let buf = '';
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) events.push(JSON.parse(line));
      }
    }
  })().catch(() => {});
  await until('the fake server is up', () => events.some((e) => e.ev === 'ready' || e.ev === 'error'), 20_000);
  const ready = events.find((e) => e.ev === 'ready');
  assert(ready, `fake server: ${JSON.stringify(events)}`);
  const calls = () => events.filter((e) => e.ev === 'notify').map((e) => e.call as FakeCall);
  return {
    address: String(ready.address),
    events,
    calls,
    closes: () => events.filter((e) => e.ev === 'close').map((e) => Number(e.id)),
    async tell(m: Json) {
      const n = events.filter((e) => e.ev === 'done').length;
      await writer.write(new TextEncoder().encode(JSON.stringify(m) + '\n'));
      await until(`fake server did ${m.op}`, () => events.filter((e) => e.ev === 'done').length > n);
    },
    async stop() {
      await writer.close().catch(() => {});
      await child.status;
    },
  };
}

/** The real helper through wsl.exe on that bus; register's Windows paths become the distro's (data, icon). */
function wslHelper(bin: string, address: string, launch: string, exited: string[]): SpawnToastHelper {
  const real = keeperToastSpawner(
    'wsl.exe',
    ['-d', DISTRO, '--cd', '/tmp', '--exec', 'env', `DBUS_SESSION_BUS_ADDRESS=${address}`, `${bin}/AIB-keeper`, 'toast'],
    false,
  );
  return (onMessage, onExit) => {
    const p = real(onMessage, (why) => {
      exited.push(why);
      onExit(why);
    });
    return {
      send(m) {
        if (m.op === 'register') m = { ...m, data: toWsl(String(m.data)), icon: toWsl(String(m.icon)), launch };
        p.send(m);
      },
      close: () => p.close(),
    };
  };
}

const ONCE = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

function row(n: number, kind: InboxRow['kind'], command = 'npm install stripe@18.0.0'): InboxRow {
  return {
    key: `claude:s${n}`,
    id: `c${n}`,
    section: kind === 'finished' ? 'review' : 'needs',
    kind,
    what: `Run ${command}`,
    whatCode: command,
    title: `Chat ${n}`,
    project: { key: 'p', name: 'shopfront' },
    provider: 'claude',
    agent: 'Claude',
    since: 1000 + n,
    at: 1000 + n,
    needs: 1,
    more: 0,
    helpers: 0,
    request: kind === 'approval'
      ? {
        kind: 'permission',
        key: `p${n}`,
        params: { toolCall: { toolCallId: `tc${n}`, title: 'Bash', rawInput: { command } }, options: ONCE },
      }
      : null,
    ask: '',
    actions: [],
  };
}

function fakeAib(rows: InboxRow[], codes: ToastCodes) {
  const opened: (NotifyTarget | null)[] = [];
  const calls: [string, Json][] = [];
  const deps: ToastActDeps = {
    look: () => Promise.resolve({ rows }),
    liveCall: (name, body) => (calls.push([name, body]), Promise.resolve([200, {}])),
    liveState: () => Promise.resolve({ events: [{ kind: 'user', data: { text: 'Fix the totals' } }] }),
    continueChat: (key) => (calls.push(['continue', { key }]), Promise.resolve([200, {}])),
    sendText: (key, text, tag) => (calls.push(['send', { key, text, tag }]), Promise.resolve([200, {}])),
    note: () => {},
    codes,
    open: (t) => opened.push(t),
    removeToast: () => {},
  };
  return { deps, opened, calls };
}

const notifySend: OsNotify = { mechanism: 'notify-send', show: () => Promise.resolve({ shown: false, reason: 'not in this test' }) };

function route(spawn: SpawnToastHelper, dir: string, rows: InboxRow[], codes: ToastCodes, aib: ReturnType<typeof fakeAib>): WindowsToasts {
  let r: WindowsToasts | null = null;
  r = linuxRoute({
    spawn,
    register: { name: 'AIB', icon: `${dir}/toast-icon.png`, data: dir, launch: 'set by wslHelper', desktop: DESKTOP_ENTRY },
    balloon: notifySend,
    codes,
    rowOf: (k) => rows.find((x) => x.key === k) ?? null,
    onActivated: (c) => void applyLinuxClick({ ...aib.deps, removeToast: (chat) => r?.remove(chat) }, c),
    timeoutMs: 8000,
  });
  return r;
}

const show = async (r: WindowsToasts, x: InboxRow, body = 'shopfront · Run it') => {
  const res = await r.show(x.title, body, false, { title: x.title, body, target: { type: 'inbox', key: x.key }, test: false });
  assert(res.shown, `${x.key}: ${res.reason}`);
};

Deno.test({
  ...OPTS,
  name: "linux notifications (WSL): the keeper's bus tests pass on a private session bus",
  ignore: !READY,
  async fn() {
    const bin = await binaries();
    const r = wslSync([
      '--exec',
      'env',
      'AIB_FDO_BUS_TEST=1',
      `AIB_KEEPER_TEST_BINS=${bin.wsl}`,
      'dbus-run-session',
      '--',
      `${bin.wsl}/keeper.test`,
      '-test.run=Fdo',
      '-test.v',
    ]);
    assertEquals(r.code, 0, r.stdout);
    assert(r.stdout.includes('--- PASS: TestFdoHelperOnRealBus') && r.stdout.includes('--- PASS: TestDbusFdoNotifyHintsSignals'), r.stdout);
  },
});

Deno.test({
  ...OPTS,
  name: 'linux notifications (WSL, KDE-like server): body click, Allow, Deny, inline reply, Continue, Retry, closed elsewhere, AIB quit',
  ignore: !READY,
  async fn() {
    const bin = await binaries();
    const dir = await Deno.makeTempDir({ prefix: 'aib-fdo-e2e-' });
    const wdir = toWsl(dir);
    const server = await fakeServer(bin.wsl, 'actions,body,inline-reply');
    let r: WindowsToasts | null = null;
    try {
      await Deno.writeTextFile(`${dir}/toast-icon.png`, 'png');
      await Deno.writeTextFile(`${dir}/aib`, `#!/bin/sh\necho "$XDG_ACTIVATION_TOKEN" > '${wdir}/started'\n`);
      const rows = [
        row(1, 'approval'),
        row(2, 'approval'),
        row(3, 'asks'),
        row(4, 'stalled'),
        row(5, 'failed'),
        row(6, 'approval', 'git push origin main'),
        row(7, 'approval'),
        row(8, 'approval'),
      ];
      const codes = new ToastCodes({ file: `${dir}/toast-codes.json` });
      const aib = fakeAib(rows, codes);
      const exited: string[] = [];
      r = route(wslHelper(bin.wsl, server.address, `${wdir}/aib`, exited), dir, rows, codes, aib);
      assert(await r.start(), 'the helper registered');
      const callOf = (n: number) => server.calls().filter((c) => c.summary === `Chat ${n}`).at(-1)!;
      for (const x of rows.slice(0, 7)) await show(r, x);
      assertEquals(server.calls().length, 7);

      // what the server got: the body click, the buttons, the hints
      const c1 = callOf(1);
      assertEquals(c1.actions, ['default', 'Open', 'b0', 'Allow', 'b1', 'Deny']);
      assertEquals([c1.hints['desktop-entry'], c1.hints['image-path'], c1.hints.urgency], [DESKTOP_ENTRY, `${wdir}/toast-icon.png`, 1]);
      assertEquals(callOf(3).actions, ['default', 'Open', 'inline-reply', 'Reply']);
      assertEquals(callOf(3).hints['x-kde-reply-placeholder-text'], 'Reply');
      assertEquals(callOf(4).actions.filter((_, i) => i % 2), ['Open', 'Continue', 'Open']);
      assertEquals(callOf(5).actions.filter((_, i) => i % 2), ['Open', 'Retry', 'Open']);
      assertEquals(callOf(6).actions, ['default', 'Open', 'b0', 'Open'], 'a risky command: Open only');

      // a body click opens the chat's row in the inbox (as on Windows)
      await server.tell({ op: 'invoke', id: callOf(6).id, key: 'default', token: 'tok-body' });
      await until('the body click opened the chat', () => aib.opened.length === 1);
      assertEquals(aib.opened, [{ type: 'inbox', key: 'claude:s6' }]);
      // each button: the right action
      await server.tell({ op: 'invoke', id: c1.id, key: 'b0' });
      await server.tell({ op: 'invoke', id: callOf(2).id, key: 'b1' });
      await server.tell({ op: 'reply', id: callOf(3).id, text: 'Just make it readable.' });
      await server.tell({ op: 'invoke', id: callOf(4).id, key: 'b0' });
      await server.tell({ op: 'invoke', id: callOf(5).id, key: 'b0' });
      await until('all five acted', () => aib.calls.length === 5);
      const sorted = [...aib.calls].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assertEquals(sorted, [
        ['continue', { key: 'claude:s4' }],
        ['permission', { id: 'c1', key: 'p1', option: 'yes' }],
        ['permission', { id: 'c2', key: 'p2', option: 'no' }],
        ['send', { key: 'claude:s3', text: 'Just make it readable.', tag: 'toast-reply' }],
        ['send', { key: 'claude:s5', text: 'Fix the totals', tag: 'toast-retry' }],
      ]);
      assertEquals(aib.opened.length, 1, 'no button brought a window up');
      // the same Allow again (a replay): refused, only opens
      await server.tell({ op: 'invoke', id: c1.id, key: 'b0' });
      await new Promise((res) => setTimeout(res, 300));
      assertEquals(aib.calls.length, 5, 'a click on a closed notification does nothing');

      // answered elsewhere: CloseNotification for that notification
      const c7 = callOf(7);
      r.seeInbox({ rows: rows.filter((x) => x.key !== 'claude:s7').map((x) => ({ ...x, sig: INBOX.sigOf(x) })) });
      await until('CloseNotification', () => server.closes().includes(c7.id));

      // AIB quits with a notification still up: the helper stays, writes the click, starts AIB with the token, exits
      await show(r, rows[7]);
      const c8 = callOf(8);
      r.close();
      await new Promise((res) => setTimeout(res, 800));
      assertEquals(exited, [], 'the helper stays while a notification waits');
      await server.tell({ op: 'invoke', id: c8.id, key: 'b0', token: 'tok-quit' });
      await until('the helper exited after the click', () => exited.length === 1, 15_000);
      const started = (await Deno.readTextFile(`${dir}/started`)).trim();
      assertEquals(started, 'tok-quit', 'AIB started with the activation token');
      assert(!(await Deno.stat(`${dir}/toast-helper.pid`).then(() => true, () => false)), 'its pid file is gone');
      // AIB, started again: the click is applied with the code issued before it quit
      const pending = takePending(dir);
      assertEquals(pending.length, 1);
      const again = fakeAib(rows, new ToastCodes({ file: `${dir}/toast-codes.json` }));
      const out = await applyLinuxClick(again.deps, pending[0]);
      assertEquals([out.act, out.done], ['allow', true]);
      assertEquals(again.calls, [['permission', { id: 'c8', key: 'p8', option: 'yes' }]]);
    } finally {
      r?.close();
      await server.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'linux notifications (WSL, GNOME-like server): the reply box is Open, which opens the chat; the body is escaped',
  ignore: !READY,
  async fn() {
    const bin = await binaries();
    const dir = await Deno.makeTempDir({ prefix: 'aib-fdo-gnome-' });
    const server = await fakeServer(bin.wsl, 'actions,body,body-markup,persistence');
    let r: WindowsToasts | null = null;
    try {
      const rows = [row(3, 'asks')];
      const codes = new ToastCodes();
      const aib = fakeAib(rows, codes);
      r = route(wslHelper(bin.wsl, server.address, '', []), dir, rows, codes, aib);
      assert(await r.start());
      await show(r, rows[0], 'Use <b>bold</b> & more');
      const c = server.calls()[0];
      assertEquals(c.actions, ['default', 'Open', 'b0', 'Open']);
      assertEquals(c.body, 'Use &lt;b&gt;bold&lt;/b&gt; &amp; more');
      assert(!('x-kde-reply-placeholder-text' in c.hints));
      await server.tell({ op: 'invoke', id: c.id, key: 'b0' });
      await until('the chat opened', () => aib.opened.length === 1);
      assertEquals(aib.opened, [{ type: 'chat', key: 'claude:s3' }]);
      assertEquals(aib.calls, []);
    } finally {
      r?.close();
      await server.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'linux notifications (WSL): cleanup of the cross-built binaries',
  ignore: !READY,
  async fn() {
    if (built) await Deno.remove((await built).win, { recursive: true }).catch(() => {});
  },
});
