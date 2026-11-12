/**
 * The desktop app's own notifications (server/desktop/notify.ts, the notify route, the click path): the OS layer is always a fake,
 * so nothing is shown on this screen and no program is started.
 */
import { assert, assertEquals, assertThrows } from "./_assert.ts";
import {
  cleanNotifyRequest,
  DesktopNotifications,
  type NotifyTarget,
  type OsNotify,
  posixCommand,
  posixNotify,
  quietReason,
  QUNS,
  windowsNotify,
} from "../../outputs/agent-studio/server/desktop/notify.ts";
import {
  balloonData,
  NIF_INFO,
  NIIF_NOSOUND,
  NIIF_RESPECT_QUIET_TIME,
  NOTIFYICON_VERSION_4,
  NOTIFYICON_VERSION_LEGACY,
  NOTIFYICONDATAW_SIZE,
  TRAY_CALLBACK,
  TRAY_UID,
  trayEvent,
  trayMessageText,
} from "../../outputs/agent-studio/server/desktop/tray_win.ts";
import { pickMainWindow } from "../../outputs/agent-studio/server/desktop/foreground_win.ts";
import {
  DesktopApp,
  openTargetScript,
  type Shell,
  type WindowHandle,
} from "../../outputs/agent-studio/server/desktop/window.ts";
import {
  makeContext,
  WebServer,
} from "../../outputs/agent-studio/server/web/server.ts";
import { ValueError } from "../../outputs/agent-studio/server/core/py.ts";
import type { LiveBackend } from "../../outputs/agent-studio/server/host/backend.ts";
import type { UpdateService } from "../../outputs/agent-studio/server/desktop/updater.ts";
import type { Source } from "../../outputs/agent-studio/server/transcripts/monitor.ts";

Deno.test("notify request: cut, cleaned, target checked", () => {
  const r = cleanNotifyRequest({
    title: "T".repeat(300),
    body: "a\u0007b\nc",
    target: { type: "chat", key: "claude:1" },
    test: true,
  });
  assertEquals(r.title.length, 200);
  assertEquals(r.body, "ab\nc", "control characters go, new lines stay");
  assertEquals(r.target, { type: "chat", key: "claude:1" });
  assertEquals(r.test, true);
  assertEquals(
    cleanNotifyRequest({ title: "x", target: { type: "inbox" } }).target,
    { type: "inbox" },
  );
  assertEquals(
    cleanNotifyRequest({ title: "x", target: { type: "chat", key: "" } })
      .target,
    null,
  );
  assertEquals(
    cleanNotifyRequest({
      title: "x",
      target: { type: "url", key: "https://x" },
    }).target,
    null,
  );
  assertEquals(cleanNotifyRequest({ body: "only text" }).title, "AIB");
  assertEquals(cleanNotifyRequest({ title: "x", test: "yes" }).test, false);
  assertThrows(() => cleanNotifyRequest({ title: "  ", body: "" }), ValueError);
  assertThrows(() => cleanNotifyRequest([]), ValueError);
});

Deno.test("Windows: quiet states are respected, not forced through", () => {
  assertEquals(quietReason(QUNS.ACCEPTS_NOTIFICATIONS), null);
  assertEquals(
    quietReason(QUNS.NOT_PRESENT),
    null,
    "locked: Windows keeps it for later",
  );
  assertEquals(
    quietReason(null),
    null,
    "unknown: Windows itself still applies Do not disturb",
  );
  assertEquals(
    quietReason(QUNS.PRESENTATION_MODE),
    "Windows is in presentation mode",
  );
  assertEquals(quietReason(QUNS.QUIET_TIME), "Windows is in quiet time");
  for (const s of [QUNS.BUSY, QUNS.RUNNING_D3D_FULL_SCREEN, QUNS.APP]) {
    assertEquals(quietReason(s), "an app is running full screen");
  }
});

Deno.test("Windows: the tray balloon, its result code, the quiet check first, and the click", async () => {
  const calls: [string, string][] = [];
  let state: number | null = QUNS.ACCEPTS_NOTIFICATIONS;
  let code: number | null = 1;
  const w = windowsNotify({
    balloon: (t, b) => (calls.push([t, b]), code),
    quietState: () => state,
  });
  assertEquals(w.mechanism, "windows-balloon");
  assertEquals(await w.show("Chat a", "Needs you"), { shown: true, code: 1 });
  assertEquals(calls, [["Chat a", "Needs you"]]);
  state = QUNS.PRESENTATION_MODE;
  assertEquals(await w.show("x", "y"), {
    shown: false,
    reason: "Windows is in presentation mode",
  });
  assertEquals(
    calls.length,
    1,
    "no balloon at all while Windows asks for quiet",
  );
  state = QUNS.ACCEPTS_NOTIFICATIONS;
  code = 0;
  assertEquals(await w.show("x", "y"), {
    shown: false,
    reason: "Windows refused it",
    code: 0,
  });
  code = null;
  assertEquals(await w.show("x", "y"), {
    shown: false,
    reason: "AIB's tray icon isn't running",
  });
  let clicks = 0;
  w.onClick!(() => clicks++);
  w.clicked();
  assertEquals(clicks, 1);
});

Deno.test("Windows: the balloon NOTIFYICONDATAW (NIM_MODIFY + NIF_INFO, 64-bit layout)", () => {
  const b = balloonData({
    hwnd: 0x1234n,
    title: "T".repeat(80),
    body: "Needs you",
  });
  const v = new DataView(b.buffer);
  const str = (at: number, max: number) => {
    let s = "";
    for (let i = 0; i < max; i++) {
      const c = v.getUint16(at + i * 2, true);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  assertEquals(b.length, NOTIFYICONDATAW_SIZE);
  assertEquals(v.getUint32(0, true), NOTIFYICONDATAW_SIZE);
  assertEquals(v.getBigUint64(8, true), 0x1234n);
  assertEquals(v.getUint32(16, true), TRAY_UID);
  assertEquals(
    v.getUint32(20, true),
    NIF_INFO,
    "only the balloon changes: icon, tip and callback stay",
  );
  assertEquals(str(304, 256), "Needs you"); // szInfo
  assertEquals(
    str(820, 64),
    "T".repeat(63),
    "szInfoTitle holds 63 characters and its terminator",
  );
  assertEquals(
    v.getUint32(948, true),
    NIIF_NOSOUND | NIIF_RESPECT_QUIET_TIME,
    "silent (the page chimes) and quiet time respected",
  );
  assertEquals(str(304, 256), "Needs you");
  const empty = new DataView(
    balloonData({ hwnd: 1n, title: "x", body: "" }).buffer,
  );
  assertEquals(
    empty.getUint16(304, true),
    32,
    "never an empty text (that would take the balloon away)",
  );
});

Deno.test("macOS and Linux: osascript / notify-send with the text as separate arguments; none on Windows", () => {
  assertEquals(posixCommand("darwin", 'Chat "a"', "it's \\ yours"), {
    cmd: "osascript",
    args: [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      'Chat "a"',
      "it's \\ yours",
    ],
  });
  assertEquals(
    posixCommand("darwin", "-x", "b")!.args.at(-2),
    "–x",
    "a leading dash is never an option",
  );
  assertEquals(posixCommand("linux", "-t", "b"), {
    cmd: "notify-send",
    args: ["--app-name=AIB", "--", "-t", "b"],
  });
  assertEquals(posixCommand("windows", "a", "b"), null);
  assertEquals(posixNotify("windows"), null);
});

Deno.test("macOS and Linux: shown on exit 0; a missing program degrades quietly and is not tried again", async () => {
  const runs: [string, string[]][] = [];
  let answer: number | "missing" = 0;
  const n = posixNotify(
    "linux",
    (cmd, args) => (runs.push([cmd, args]), Promise.resolve(answer)),
  )!;
  assertEquals(n.mechanism, "notify-send");
  assertEquals(await n.show("Chat a", "Needs you"), { shown: true, code: 0 });
  assertEquals(runs[0], ["notify-send", [
    "--app-name=AIB",
    "--",
    "Chat a",
    "Needs you",
  ]]);
  answer = 1;
  assertEquals(await n.show("a", "b"), {
    shown: false,
    reason: "notify-send failed",
    code: 1,
  });
  answer = "missing";
  assertEquals(await n.show("a", "b"), {
    shown: false,
    reason: "notify-send isn't installed",
  });
  assertEquals(await n.show("a", "b"), {
    shown: false,
    reason: "notify-send isn't installed",
  });
  assertEquals(runs.length, 3, "not started again once missing");
  const mac = posixNotify(
    "darwin",
    () => Promise.reject(new Error("spawn failed")),
  )!;
  assertEquals(mac.mechanism, "osascript");
  assertEquals(await mac.show("a", "b"), {
    shown: false,
    reason: "osascript could not start",
  });
});

function fakeOs(result = { shown: true }) {
  const shown: [string, string][] = [];
  let click: (() => void) | null = null;
  const os: OsNotify = {
    mechanism: "fake",
    show: (t, b) => (shown.push([t, b]), Promise.resolve(result)),
    onClick: (fn) => void (click = fn),
  };
  return { os, shown, click: () => click?.() };
}

Deno.test("a click opens what the last shown notification was about", async () => {
  const f = fakeOs();
  const opened: (NotifyTarget | null)[] = [];
  const n = new DesktopNotifications(f.os, (t) => opened.push(t), () => true);
  await n.show({
    title: "a",
    body: "Needs you",
    target: { type: "chat", key: "k1" },
    test: false,
  });
  await n.show({
    title: "2 agents are waiting for you",
    body: "a\nb",
    target: { type: "inbox" },
    test: false,
  });
  f.click();
  assertEquals(opened, [{ type: "inbox" }], "the newer one replaced the older");
  await n.show({ title: "AIB", body: "test", target: null, test: true });
  f.click();
  assertEquals(opened.at(-1), null, "the test only brings AIB forward");
  const none = new DesktopNotifications(null, () => {});
  assertEquals(none.mechanism, "none");
  assertEquals(
    (await none.show({ title: "a", body: "", target: null, test: true })).shown,
    false,
  );
  const thrower: OsNotify = {
    mechanism: "x",
    show: () => Promise.reject(new Error("boom")),
  };
  assertEquals(
    await new DesktopNotifications(thrower, () => {}).show({
      title: "a",
      body: "",
      target: null,
      test: false,
    }),
    {
      shown: false,
      reason: "the system refused it",
    },
  );
});

Deno.test("notify route: shows through the app, page token required, 409 outside the app", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "aib-notify-" });
  const ctx = makeContext({
    stateDir,
    host: {} as LiveBackend,
    updates: {} as UpdateService,
    webInstanceId: "test",
    cliPort: 0,
    transcripts: {} as Source,
    claudeProjects: stateDir,
    ompSessions: stateDir,
    shutdown: () => {},
  });
  const server = new WebServer(ctx);
  const port = await server.listen(0); // the OS picks a free port
  const origin = `http://127.0.0.1:${port}`;
  const post = (
    body: unknown,
    headers: Record<string, string> = {
      "X-Studio-Token": ctx.token,
      Origin: origin,
    },
  ) =>
    fetch(`${origin}/api/live/desktop/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    let r = await post({ title: "Chat a", body: "Needs you" });
    assertEquals(
      r.status,
      409,
      "a server run (a browser) has no app notifications",
    );
    assertEquals(
      (await r.json()).error,
      "Only the AIB desktop app shows notifications itself",
    );
    const f = fakeOs();
    const opened: (NotifyTarget | null)[] = [];
    ctx.desktopNotify = new DesktopNotifications(
      f.os,
      (t) => opened.push(t),
      () => true,
    );
    r = await post({
      title: "Chat a",
      body: "Needs you",
      target: { type: "chat", key: "claude:s1" },
    });
    assertEquals(r.status, 200);
    assertEquals(await r.json(), {
      ok: true,
      shown: true,
      reason: "",
      mechanism: "fake",
    });
    assertEquals(f.shown, [["Chat a", "Needs you"]]);
    f.click();
    assertEquals(opened, [{ type: "chat", key: "claude:s1" }]);
    r = await post({ title: "x" }, { Origin: origin });
    assertEquals(r.status, 403, "the page token is required");
    await r.body?.cancel();
    r = await post({ title: "x" }, {
      "X-Studio-Token": ctx.token,
      Origin: "http://evil.example",
    });
    assertEquals(r.status, 403, "another origin is refused");
    await r.body?.cancel();
    r = await post({ title: "", body: "" });
    assertEquals(r.status, 400);
    await r.body?.cancel();
    assertEquals(f.shown.length, 1);
    const quiet = fakeOs(
      { shown: false, reason: "Windows is in presentation mode" } as never,
    );
    ctx.desktopNotify = new DesktopNotifications(
      quiet.os,
      () => {},
      () => true,
    );
    r = await post({ title: "AIB", body: "test", test: true });
    assertEquals(await r.json(), {
      ok: true,
      shown: false,
      reason: "Windows is in presentation mode",
      mechanism: "fake",
    });
  } finally {
    await server.close();
    await Deno.remove(stateDir, { recursive: true }).catch(() => {});
  }
});

class Win implements WindowHandle {
  closed = false;
  visible = false;
  focused = 0;
  scripts: string[] = [];
  answers: unknown[] = [];
  navigate() {}
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {
    this.focused++;
  }
  setTitle() {}
  isClosed() {
    return this.closed;
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
  on() {}
  evaluate(code: string) {
    if (!code.includes("openFromDesktop")) return Promise.resolve(undefined);
    this.scripts.push(code);
    return Promise.resolve(this.answers.length ? this.answers.shift() : true);
  }
}

Deno.test("clicking brings the window forward and asks the page to open the chat (again while it loads)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aib-notify-app-" });
  const wins: Win[] = [];
  const f = fakeOs();
  const shell: Shell = {
    createWindow: () => {
      const w = new Win();
      wins.push(w);
      return w;
    },
    createKeeper: () => new Win(),
    createTray: () => {},
    ask: () => Promise.resolve(false),
    openExternal: () => {},
    notifier: f.os,
  };
  const app = new DesktopApp(shell, {
    url: "http://127.0.0.1:8890/",
    stateDir: dir,
    trayIcon: new Uint8Array(),
    busyCount: () => Promise.resolve(0),
    quit: () => Promise.resolve(),
    watchdogMs: 0,
  });
  try {
    await app.start();
    const w = wins[0];
    w.hide();
    w.answers = [false, false, true]; // the page is still loading twice
    assertEquals(
      await app.openFromNotification({ type: "chat", key: "claude:1" }, 5, 0),
      true,
    );
    assert(w.visible && w.focused > 0, "shown and focused");
    assertEquals(w.scripts.length, 3);
    assert(w.scripts[0].includes('{"type":"chat","key":"claude:1"}'));
    // Through the click path: the last shown notification's target.
    await app.notifications.show({
      title: "a",
      body: "b",
      target: { type: "chat", key: "k<2>" },
      test: false,
    });
    f.click();
    await new Promise((r) => setTimeout(r, 0));
    assert(
      w.scripts.at(-1)!.includes("k\\u003c2>"),
      'no "<" reaches the script',
    );
    assertEquals(
      openTargetScript(null).includes("openFromDesktop(null)"),
      true,
    );
    w.closed = true;
    assertEquals(
      await app.openFromNotification({ type: "inbox" }, 2, 0),
      true,
      "a closed window is made again",
    );
    assertEquals(wins.length, 2);
  } finally {
    app.stop();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("the toast click message decodes for each NOTIFYICON version", () => {
  const NIN_BALLOONUSERCLICK = 0x405,
    WM_LBUTTONUP = 0x202,
    WM_RBUTTONUP = 0x205,
    WM_CONTEXTMENU = 0x7b,
    NIN_SELECT = 0x400;
  const v4 = (event: number) => BigInt((TRAY_UID << 16) | event); // LOWORD = event, HIWORD = icon id
  // Legacy (AIB's icon sets no version): lParam is the event itself.
  assertEquals(trayEvent(NIN_BALLOONUSERCLICK), "balloon-click");
  assertEquals(
    trayEvent(NIN_BALLOONUSERCLICK, NOTIFYICON_VERSION_LEGACY),
    "balloon-click",
  );
  assertEquals(trayEvent(WM_LBUTTONUP, NOTIFYICON_VERSION_LEGACY), "click");
  assertEquals(trayEvent(WM_RBUTTONUP, NOTIFYICON_VERSION_LEGACY), "menu");
  assertEquals(
    trayEvent(0x404, NOTIFYICON_VERSION_LEGACY),
    null,
    "NIN_BALLOONTIMEOUT",
  );
  // Version 4: the icon id rides in the high word.
  assertEquals(
    trayEvent(v4(NIN_BALLOONUSERCLICK), NOTIFYICON_VERSION_4),
    "balloon-click",
  );
  assertEquals(trayEvent(v4(WM_LBUTTONUP), NOTIFYICON_VERSION_4), "click");
  assertEquals(trayEvent(v4(WM_CONTEXTMENU), NOTIFYICON_VERSION_4), "menu");
  assertEquals(
    trayEvent(v4(WM_RBUTTONUP), NOTIFYICON_VERSION_4),
    null,
    "one menu: WM_CONTEXTMENU only",
  );
  assertEquals(trayEvent(v4(NIN_SELECT), NOTIFYICON_VERSION_4), null);
  assertEquals(
    trayEvent(0xffffffff00000405n),
    "balloon-click",
    "a sign-extended 64-bit lParam still decodes",
  );
});

Deno.test("every tray message gets a studio.log line", () => {
  assertEquals(
    trayMessageText(TRAY_CALLBACK, 1, 0x405),
    "tray message: callback msg=0x8001 wParam=0x1 lParam=0x405 (balloon-click)",
  );
  assertEquals(
    trayMessageText(TRAY_CALLBACK, 1, 0x200),
    "tray message: callback msg=0x8001 wParam=0x1 lParam=0x200 (ignored)",
  );
  assertEquals(
    trayMessageText(0xc123, 0, 0),
    "tray message: 0xc123 msg=0xc123 wParam=0x0 lParam=0x0",
  );
});

Deno.test("to front: the biggest of the app windows, never the 1x1 keeper or startup window", () => {
  assertEquals(pickMainWindow([]), null);
  assertEquals(pickMainWindow([{ hwnd: 1n, width: 1, height: 1 }]), null);
  assertEquals(
    pickMainWindow([{ hwnd: 1n, width: 1, height: 1 }, {
      hwnd: 2n,
      width: 1280,
      height: 860,
    }, { hwnd: 3n, width: 1, height: 1 }]),
    2n,
  );
  assertEquals(
    pickMainWindow([{ hwnd: 4n, width: 160, height: 28 }, {
      hwnd: 5n,
      width: 900,
      height: 700,
    }]),
    5n,
    "a minimised one is small",
  );
});

Deno.test("a click with no chat (the test) still brings the window to the front, also a minimised or closed one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aib-notify-front-" });
  const wins: Win[] = [];
  let fronts = 0;
  const f = fakeOs();
  const shell: Shell = {
    createWindow: () => {
      const w = new Win();
      wins.push(w);
      return w;
    },
    createKeeper: () => new Win(),
    createTray: () => {},
    ask: () => Promise.resolve(false),
    openExternal: () => {},
    notifier: f.os,
    bringToFront:
      () => (fronts++, { found: true, restored: true, foreground: true }),
  };
  const app = new DesktopApp(shell, {
    url: "http://127.0.0.1:8890/",
    stateDir: dir,
    trayIcon: new Uint8Array(),
    busyCount: () => Promise.resolve(0),
    quit: () => Promise.resolve(),
    watchdogMs: 0,
  });
  try {
    await app.start();
    await app.notifications.show({
      title: "AIB",
      body: "This is a test notification.",
      target: null,
      test: true,
    });
    f.click();
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(fronts, 2, "now and once more after the runtime has shown it");
    assertEquals(wins[0].scripts.length, 0, "no chat to open");
    wins[0].closed = true;
    f.click();
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(wins.length, 2, "a closed window is made again");
    assertEquals(fronts, 4);
  } finally {
    app.stop();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
