/**
 * Real binary (slow: one `deno desktop` build; AIB_SLOW_TESTS=1, Windows only): multi-window Phase 2A (design T10), on an
 * invisible desktop (_hidden_desktop.ts): no window ever shows on the person's screen.
 *
 *   1. AIB starts with one project (Alpha). The page asks for "Alpha in a new window" (POST /api/live/desktop/windows, K3):
 *      two AIB windows, the second titled "AIB · Alpha" (the app owns window titles, B13). Asking again focuses it: still two.
 *      desktop-windows.json (K1) lists both.
 *   1b. Phase 3: a chat popped out of the project window (K3 op 'popout' from w2): a third, small window titled "<chat> · AIB" on
 *      its own URL (kind=chat, the chat's lasting key); desktop-windows.json keeps it with from: 'w2'. Opening that chat from the
 *      main window (K3 op 'route', the same pop-out-first chooser a notification click uses, B6) goes to the pop-out.
 *   2. AIB is killed (as an update restart or a crash would end it): the next start brings all three windows back (D3a), each at
 *      its saved size, the second on its own URL (?w=w2&kind=project), the pop-out on its chat. The project window takes the
 *      restored pop-out back as its own (its from), and WM_CLOSE on the pop-out clears that (the tab would come back there).
 *   3. WM_CLOSE on the main window while the project window is open: AIB keeps running and the project window stays (B5); the
 *      saved list drops the main window.
 *   4. WM_CLOSE on the last window with nothing working: AIB exits; the list still has that window (G8).
 * Only processes this test started are killed. Gives up after 15 minutes.
 */
import { assert, assertEquals } from "./_assert.ts";
import { Fixture, until } from "./_host_fixture.ts";
import { type DeskWindow, HiddenDesktop } from "./_hidden_desktop.ts";
import { builtDist } from "./_build_cache.ts";
import { devToolsPortNow, ownerPort, pickPort, refusedPort } from "./_ports.ts";
import { APP_VERSION } from "../../app/server/core/app.ts";
import { projectKey } from "../../app/server/desktop/project_delete.ts";

const SLOW = Deno.build.os === "windows" &&
  Deno.env.get("AIB_SLOW_TESTS") === "1";
let PORT = 0;
let cdpRoot = "";
const WM_CLOSE = 0x0010;
const DEC = new TextDecoder();
type Json = Record<string, unknown>;

const u32 = Deno.build.os === "windows"
  ? Deno.dlopen("user32.dll", {
    GetWindowRect: { parameters: ["pointer", "buffer"], result: "i32" },
  })
  : null;
function rectOf(w: DeskWindow): [number, number] {
  const r = new Int32Array(4);
  u32!.symbols.GetWindowRect(w.handle, r);
  return [r[2] - r[0], r[3] - r[1]];
}

async function unzip(zip: string, into: string): Promise<void> {
  Deno.mkdirSync(into, { recursive: true });
  const r = await new Deno.Command("C:\\Windows\\System32\\tar.exe", {
    args: ["-xf", zip, "-C", into],
  }).output();
  assert(r.success, `unzip ${zip}`);
}

/** Runs `expression` in the page of the window whose URL has `w=<w>` (each window is its own CDP page target). */
async function cdpEval(w: string, expression: string): Promise<unknown> {
  const cdp = devToolsPortNow(cdpRoot);
  if (!cdp) throw new Error("no DevToolsActivePort yet");
  const targets = await (await fetch(`http://127.0.0.1:${cdp}/json/list`))
    .json() as Json[];
  const page = targets.find((t) => {
    if (
      t.type !== "page" || !String(t.url).startsWith(`http://127.0.0.1:${PORT}`)
    ) return false;
    try {
      return new URL(String(t.url)).searchParams.get("w") === w;
    } catch {
      return false;
    }
  });
  if (!page) throw new Error(`no page target for ${w} yet`);
  const ws = new WebSocket(String(page.webSocketDebuggerUrl));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const answer = new Promise<Json>((
      resolve,
    ) => (ws.onmessage = (e) => resolve(JSON.parse(e.data))));
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
    const reply = await answer;
    return ((reply.result as Json)?.result as Json)?.value;
  } finally {
    ws.close();
  }
}

async function exited(pid: number): Promise<boolean> {
  const r = await new Deno.Command("tasklist", {
    args: ["/FI", `PID eq ${pid}`, "/NH"],
    stdout: "piped",
  }).output();
  return !DEC.decode(r.stdout).includes(String(pid));
}

async function killUnder(folder: string): Promise<void> {
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${
      folder.replaceAll("'", "''")
    }', 'OrdinalIgnoreCase') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await new Deno.Command("powershell", {
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
  }).output();
}

Deno.test({
  name:
    "real binary: a project opens in its own window, both come back after a restart, closing one leaves the other",
  ignore: !SLOW,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(
        () => reject(new Error("gave up after 15 minutes")),
        15 * 60_000,
      );
    });
    await using fx = new Fixture();
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    try {
      await Promise.race([deadline, run(fx, desk, saved)]);
    } finally {
      clearTimeout(giveUp);
      await killUnder(`${fx.root}\\install`);
      desk.close();
      for (const k of Object.keys(Deno.env.toObject())) {
        if (!(k in saved)) Deno.env.delete(k);
      }
      for (const [k, v] of Object.entries(saved)) Deno.env.set(k, v);
    }
  },
});

async function run(
  fx: Fixture,
  desk: HiddenDesktop,
  saved: Record<string, string>,
): Promise<void> {
  const dist = await builtDist();
  const app = `${fx.root}\\install\\A`;
  await unzip(`${dist}\\AIB-${APP_VERSION}-windows-x64.zip`, app);
  const alpha = `${fx.root}\\projects\\Alpha`;
  Deno.mkdirSync(alpha, { recursive: true });
  const added = { [projectKey(alpha)]: { path: alpha, at: 1 } };
  // one saved chat in Alpha (a Claude transcript): the chat the pop-out shows (its lasting key claude:s-alpha)
  const stamp = new Date(Date.now() - 60_000).toISOString();
  Deno.mkdirSync(`${fx.root}\\claude\\enc`, { recursive: true });
  Deno.writeTextFileSync(
    `${fx.root}\\claude\\enc\\s-alpha.jsonl`,
    [
      { type: "user", sessionId: "s-alpha", cwd: alpha, timestamp: stamp, message: { role: "user", content: "Work on the CSV import" } },
      {
        type: "assistant",
        sessionId: "s-alpha",
        cwd: alpha,
        timestamp: stamp,
        message: { role: "assistant", model: "fixture", content: [{ type: "text", text: "Done." }] },
      },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  Deno.writeTextFileSync(
    `${fx.state}\\studio-added-projects.json`,
    JSON.stringify({ version: 1, savedAt: 1, start: "fresh", added }),
  );
  const env: Record<string, string> = {
    AGENT_STUDIO_STATE_DIR: fx.state,
    APPDATA: `${fx.root}\\appdata`,
    LOCALAPPDATA: `${fx.root}\\localappdata`,
    AIB_UPDATE_API_BASE: `http://127.0.0.1:${refusedPort()}`,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0",
  };
  for (const d of [env.APPDATA, env.LOCALAPPDATA]) {
    Deno.mkdirSync(d, { recursive: true });
  }
  PORT = pickPort(true);
  Deno.writeTextFileSync(
    `${fx.state}\\desktop-port.json`,
    JSON.stringify({ port: PORT }),
  );
  const flags = [
    "--state-dir",
    fx.state,
    "--omp-sessions",
    `${fx.root}\\omp`,
    "--claude-projects",
    `${fx.root}\\claude`,
    "--owners-dir",
    fx.owners,
  ];
  const spawn = () => {
    try {
      for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
      cdpRoot = app;
      return desk.spawn([`${app}\\AIB\\AIB.exe`, ...flags], `${app}\\AIB`);
    } finally {
      for (const k of Object.keys(env)) {
        saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
      }
    }
  };
  const aibWindows = (pid: number) =>
    desk.windows().filter((w) =>
      w.pid === pid && w.visible && w.cls.includes("Laufey") &&
      w.title.includes("AIB")
    );
  const list = () =>
    JSON.parse(Deno.readTextFileSync(`${fx.state}\\desktop-windows.json`));
  const ready = (w: string) =>
    cdpEval(
      w,
      `!!(window.StudioChat && window.AgentWorkspaceUI && AgentWorkspaceUI.paletteProjects().length >= 1)`,
    );

  // ---- 1. two windows; the same project twice is still two
  let pid = spawn();
  PORT = await ownerPort(fx.state, 90);
  await until(() => ready("m"), "the main page", 120);
  const key = String(
    await cdpEval(
      "m",
      `AgentWorkspaceUI.paletteProjects().find((p) => p.name === 'Alpha').key`,
    ),
  );
  const open =
    `StudioChat.post('desktop/windows', { op: 'open', from: 'm', project: { key: ${
      JSON.stringify(key)
    }, name: 'Alpha', path: ${JSON.stringify(alpha)} } })`;
  const first = await cdpEval("m", open) as Json;
  assertEquals([first.w, first.existed], ["w2", false]);
  await until(
    () => aibWindows(pid).length === 2 ? true : null,
    "two AIB windows",
    30,
  );
  await until(
    () => aibWindows(pid).some((w) => w.title === "AIB · Alpha") ? true : null,
    'the project window titled "AIB · Alpha"',
    30,
  );
  await until(() => ready("w2"), "the project page on its own URL", 60);
  const again = await cdpEval("m", open) as Json;
  assertEquals(
    [again.w, again.existed],
    ["w2", true],
    "one project, one window (D1a)",
  );
  await new Promise((r) => setTimeout(r, 1500));
  assertEquals(aibWindows(pid).length, 2, "still two windows");
  await until(
    () => {
      try {
        return list().windows.map((w: Json) => w.id).join() === "m,w2"
          ? true
          : null;
      } catch {
        return null;
      }
    },
    "desktop-windows.json lists both",
    20,
  );
  // ---- 1b. a chat popped out of the project window
  const CHAT_KEY = "claude:s-alpha";
  await until(
    () => cdpEval("w2", `AgentWorkspaceUI._items().some((c) => c.key === ${JSON.stringify(CHAT_KEY)})`),
    "the saved chat listed in the project window",
    30,
  );
  const pop = await cdpEval(
    "w2",
    `StudioChat.post('desktop/windows', { op: 'popout', from: 'w2', chat: { key: ${
      JSON.stringify(CHAT_KEY)
    }, project: ${JSON.stringify(key)}, title: 'CSV import' } })`,
  ) as Json;
  assertEquals([pop.w, pop.existed], ["w3", false]);
  await until(
    () =>
      aibWindows(pid).some((w) => w.title === "CSV import · AIB") ? true : null,
    'the pop-out titled "CSV import · AIB"',
    30,
  );
  const popKey = () =>
    cdpEval("w3", `window.AgentWorkspaceUI ? AgentWorkspaceUI.popoutKey() : ''`);
  await until(
    async () => (await popKey()) === CHAT_KEY ? true : null,
    "the pop-out page on its chat",
    60,
  );
  await until(
    () => {
      try {
        const w3 = list().windows.find((w: Json) => w.id === "w3");
        return w3 && w3.kind === "chat" && w3.from === "w2" &&
            (w3.chat as Json).key === CHAT_KEY
          ? true
          : null;
      } catch {
        return null;
      }
    },
    "desktop-windows.json keeps the pop-out with from: w2",
    20,
  );
  const routed = await cdpEval(
    "m",
    `StudioChat.post('desktop/windows', { op: 'route', from: 'm', target: { chat: ${
      JSON.stringify(CHAT_KEY)
    }, project: ${JSON.stringify(key)} } })`,
  ) as Json;
  assertEquals(routed.to, "w3", "opening a popped-out chat goes to its pop-out");
  await new Promise((r) => setTimeout(r, 1000));
  assertEquals(await popKey(), CHAT_KEY, "the pop-out still shows its chat");
  assertEquals(aibWindows(pid).length, 3, "three windows");

  // measured the same way before and after (this test process's GetWindowRect may be DPI-scaled: compare like with like)
  const before = aibWindows(pid);
  const rectBefore = {
    m: rectOf(before.find((w) => w.title === "AIB")!),
    w2: rectOf(before.find((w) => w.title === "AIB · Alpha")!),
    w3: rectOf(before.find((w) => w.title === "CSV import · AIB")!),
  };

  // ---- 2. killed (an update restart, a crash): all three come back
  Deno.kill(pid, "SIGKILL");
  await until(() => exited(pid), "AIB gone", 30);
  await new Promise((r) => setTimeout(r, 1500));
  pid = spawn();
  PORT = await ownerPort(fx.state, 90);
  await until(
    () => aibWindows(pid).length === 3 ? true : null,
    "all three windows back",
    120,
  );
  await until(() => ready("w2"), "the project window back on its own URL", 60);
  await until(() => ready("m"), "the main window back", 60);
  const back = aibWindows(pid);
  const main = back.find((w) => w.title === "AIB")!,
    proj = back.find((w) => w.title === "AIB · Alpha")!,
    popWin = back.find((w) => w.title === "CSV import · AIB")!;
  assert(main && proj && popWin, `titles: ${back.map((w) => w.title)}`);
  await until(
    async () => (await popKey()) === CHAT_KEY ? true : null,
    "the pop-out back on its chat",
    60,
  );
  for (const [w, id] of [[main, "m"], [proj, "w2"], [popWin, "w3"]] as const) {
    const [width, height] = rectOf(w);
    const [bw, bh] = rectBefore[id];
    assert(
      Math.abs(width - bw) <= 4 && Math.abs(height - bh) <= 4,
      `${id}: ${width}x${height} after, ${bw}x${bh} before`,
    );
  }

  // the project window takes the restored pop-out back as its own (its sessionStorage record died with the old process)
  const pops = () =>
    cdpEval(
      "w2",
      `JSON.stringify(AgentWorkspaceUI._pops().map((p) => [p.key, p.w, p.seen]))`,
    );
  await until(
    async () =>
      (await pops()) === JSON.stringify([[CHAT_KEY, "w3", true]]) ? true : null,
    "the project window takes the restored pop-out back",
    30,
  );
  // closing the pop-out: the tab comes back in the project window
  assert(desk.post(popWin, WM_CLOSE), "WM_CLOSE to the pop-out");
  await until(
    () => aibWindows(pid).length === 2 ? true : null,
    "the pop-out closed",
    30,
  );
  await until(
    async () => (await pops()) === "[]" ? true : null,
    "the project window let go of it",
    30,
  );
  await until(
    () =>
      cdpEval(
        "w2",
        `Object.values(AgentWorkspaceUI._state().tabs || {}).some((t) => (t || []).includes(${JSON.stringify(CHAT_KEY)}))`,
      ),
    "the tab back in the project window",
    20,
  );
  await until(
    () => list().windows.map((w: Json) => w.id).join() === "m,w2" ? true : null,
    "the pop-out left the saved list",
    20,
  );

  // ---- 3. closing the main window while the project window is open: AIB stays
  assert(desk.post(main, WM_CLOSE), "WM_CLOSE to the main window");
  await until(
    () => aibWindows(pid).length === 1 ? true : null,
    "one window left",
    30,
  );
  await new Promise((r) => setTimeout(r, 2000));
  assert(!(await exited(pid)), "AIB keeps running");
  assertEquals(aibWindows(pid).map((w) => w.title), ["AIB · Alpha"]);
  await until(
    () => list().windows.map((w: Json) => w.id).join() === "w2" ? true : null,
    "the main window left the saved list",
    20,
  );

  // ---- 4. the last window, nothing working: AIB exits, the window stays saved
  assert(desk.post(proj, WM_CLOSE), "WM_CLOSE to the last window");
  await until(() => exited(pid), "AIB exited", 60);
  assertEquals(
    list().windows.map((w: Json) => w.id),
    ["w2"],
    "the last window stays in the list (G8)",
  );
}
