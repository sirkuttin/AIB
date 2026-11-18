/**
 * Real binary (slow: one `deno desktop` build; AIB_SLOW_TESTS=1, Windows only), on an invisible desktop (_hidden_desktop.ts), with a
 * temp data folder, temp APPDATA/LOCALAPPDATA (so WebView2's profile, EBWebView, is a temp folder too) and no AIB_PAGE_KEY: the
 * real one-time key path (server/web/page_access.ts, page-auth.js, server/desktop/window.ts).
 *
 *   1. AIB starts with one project. The main window connects: its page holds a page session (in memory) and bootstrap gives it the
 *      token; a caller without one (an agent's curl) gets an empty token.
 *   2. Reload (Ctrl+R, a crashed page): the new page connects with a new session. The keys the window handed it (recorded in the
 *      page as they arrive) are refused when used again: a used launch key. None was ever in the address.
 *   3. A project window (pop-out) connects too.
 *   4. AIB is killed and started again: both windows come back and connect.
 *   5. While AIB runs, every file under the temp folders (WebView2's profile: Local Storage, Session Storage, IndexedDB, History,
 *      Sessions/Current Session, caches; AIB's data folder) is scanned: none may hold a page session the page had, and no launch key
 *      found in any of them (`aib-key=...`, ASCII or UTF-16) may still be good. After a clean quit (the last window closed, so
 *      WebView2 writes its session files) the files are scanned again for the sessions (their hashes stay valid for the next AIB).
 *
 * AIB_E2E_DIST=<a build.ts output folder> runs another build (an older AIB fails at step 2, before the scan). The scan's findings
 * are printed before its asserts. Only processes this test started are killed. Gives up after 15 minutes.
 */
import { assert, assertEquals } from "./_assert.ts";
import { Fixture, until } from "./_host_fixture.ts";
import { type DeskWindow, HiddenDesktop } from "./_hidden_desktop.ts";
import { builtDist } from "./_build_cache.ts";
import { devToolsPortNow, ownerPort, pickPort, refusedPort } from "./_ports.ts";
import { projectKey } from "../../outputs/agent-studio/server/desktop/project_delete.ts";

const SLOW = Deno.build.os === "windows" &&
  Deno.env.get("AIB_SLOW_TESTS") === "1";
const WM_CLOSE = 0x0010;
const DEC = new TextDecoder();
type Json = Record<string, unknown>;
let PORT = 0;
let cdpRoots: string[] = [];

async function unzip(zip: string, into: string): Promise<void> {
  Deno.mkdirSync(into, { recursive: true });
  const r = await new Deno.Command("C:\\Windows\\System32\\tar.exe", {
    args: ["-xf", zip, "-C", into],
  }).output();
  assert(r.success, `unzip ${zip}`);
}

/** Runs `expression` (a promise is awaited) in the page of the window whose URL has `w=<w>`. */
async function cdpEval(w: string, expression: string): Promise<unknown> {
  const cdp = cdpRoots.map((r) => devToolsPortNow(r)).find((p) => p > 0);
  if (!cdp) throw new Error("no DevToolsActivePort yet");
  const targets = await (await fetch(`http://127.0.0.1:${cdp}/json/list`))
    .json() as Json[];
  const page = targets.find((t) => {
    if (
      t.type !== "page" || !String(t.url).startsWith(`http://127.0.0.1:${PORT}`)
    ) return false;
    try {
      return (new URL(String(t.url)).searchParams.get("w") ?? "m") === w;
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

/**
 * Reloads the page of window `w` (Ctrl+R, a crashed page) and returns the launch keys the new page traded (POST
 * /api/live/page-session bodies, seen through DevTools' network events: the keys the window handed it through its private channel).
 */
async function reloadAndCaptureKeys(w: string): Promise<string[]> {
  const cdp = cdpRoots.map((r) => devToolsPortNow(r)).find((p) => p > 0);
  const targets = await (await fetch(`http://127.0.0.1:${cdp}/json/list`))
    .json() as Json[];
  const page = targets.find((t) =>
    t.type === "page" && String(t.url).startsWith(`http://127.0.0.1:${PORT}`) &&
    (new URL(String(t.url)).searchParams.get("w") ?? "m") === w
  );
  if (!page) throw new Error(`no page target for ${w}`);
  const ws = new WebSocket(String(page.webSocketDebuggerUrl));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const keys: string[] = [];
  const answers = new Map<number, () => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && answers.has(m.id)) answers.get(m.id)!();
    const req = m.method === "Network.requestWillBeSent"
      ? m.params?.request
      : null;
    if (
      req && String(req.url).endsWith("/api/live/page-session") && req.postData
    ) {
      try {
        keys.push(String(JSON.parse(req.postData).key));
        console.log(
          `page-session POST from ${m.params.documentURL} at ${m.params.timestamp} (${m.params.initiator?.type})`,
        );
      } catch { /* not ours */ }
    }
  };
  const call = (id: number, method: string, params: Json = {}) =>
    new Promise<void>((resolve) => {
      answers.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await call(1, "Network.enable");
    await call(2, "Page.reload");
    await new Promise((r) => setTimeout(r, 8000));
  } finally {
    ws.close();
  }
  return keys;
}

/** The page's session (this build's memory, or an older build's localStorage), '' while it has none. */
const SESSION =
  `(window.AIBPageAuth && typeof AIBPageAuth.state === 'function' ? AIBPageAuth.state().session : '') ||
  (localStorage.getItem('aib-page-session') || '')`;
/** The page's session once bootstrap gives it the token with it; '' before. */
const CONNECTED = `(async () => { const s = ${SESSION}; if (!s) return '';
  const b = await (await fetch('/api/live/bootstrap', window.AIBPageAuth.init({ cache: 'no-store' }))).json();
  return b.token ? s : ''; })()`;

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

/** Every file under `root` (no links followed), with its path relative to root. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}\\${e.name}`;
      if (e.isDirectory) walk(p);
      else if (e.isFile) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Reads a file even while WebView2 holds it open (Deno.readFileSync asks for a share mode it may refuse). */
function readShared(path: string): Uint8Array | null {
  try {
    return Deno.readFileSync(path);
  } catch {
    const r = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$s=[IO.File]::Open('${
          path.replaceAll("'", "''")
        }','Open','Read','ReadWrite,Delete'); $m=New-Object IO.MemoryStream; $s.CopyTo($m); $s.Close(); [Convert]::ToBase64String($m.ToArray())`,
      ],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!r.success) return null;
    try {
      const b = atob(DEC.decode(r.stdout).trim());
      return Uint8Array.from(b, (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }
}

const utf16 = (s: string) => {
  const a = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) a[i * 2] = s.charCodeAt(i);
  return a;
};
function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
const KEYCHAR = /[A-Za-z0-9_-]/;

interface Scan {
  files: number;
  unreadable: string[];
  /** [file, what] for every page session found. */
  sessions: [string, string][];
  /** Every launch key candidate after `aib-key=` (ASCII or UTF-16), with the files it is in. */
  keys: Map<string, Set<string>>;
  /** Files that mention aib-page-session / aib-page-key (older versions' storage names). */
  names: [string, string][];
}

function scan(roots: string[], sessions: string[]): Scan {
  const result: Scan = {
    files: 0,
    unreadable: [],
    sessions: [],
    keys: new Map(),
    names: [],
  };
  const needles = sessions.filter(Boolean).flatMap((s) =>
    [[s, new TextEncoder().encode(s)], [s, utf16(s)]] as const
  );
  const marks = ["aib-key=", "aib-key%3D"].flatMap((
    m,
  ) => [new TextEncoder().encode(m), utf16(m)]);
  const nameMarks = ["aib-page-session", "aib-page-key"].flatMap((m) =>
    [[m, new TextEncoder().encode(m)], [m, utf16(m)]] as const
  );
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      if (
        /\.(exe|dll|pak|dat|bin)$/i.test(file) &&
        !/\\(EBWebView|[^\\]+\.WebView2)\\/i.test(file)
      ) continue; // the app's own files
      const data = readShared(file);
      if (!data) {
        result.unreadable.push(file);
        continue;
      }
      result.files++;
      for (const [s, n] of needles) {
        if (indexOf(data, n) >= 0) {
          result.sessions.push([file, s.slice(0, 6) + "…"]);
        }
      }
      for (const [m, n] of nameMarks) {
        if (indexOf(data, n) >= 0) result.names.push([file, m]);
      }
      for (const mark of marks) {
        const wide = mark.length > 0 && mark[1] === 0;
        for (
          let at = indexOf(data, mark);
          at >= 0;
          at = indexOf(data, mark, at + 1)
        ) {
          let key = "";
          for (
            let i = at + mark.length;
            i < data.length && key.length < 128;
            i += wide ? 2 : 1
          ) {
            const c = String.fromCharCode(data[i]);
            if (!KEYCHAR.test(c) || (wide && data[i + 1] !== 0)) break;
            key += c;
          }
          if (key.length >= 32) {
            if (!result.keys.has(key)) result.keys.set(key, new Set());
            result.keys.get(key)!.add(file);
          }
        }
      }
    }
  }
  return result;
}

/** Is this launch key still good? Asks AIB the way a page does (which uses a good one up: the scan runs at the end). */
async function keyStillGood(key: string): Promise<boolean> {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/live/page-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${PORT}`,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
    },
    body: JSON.stringify({ key }),
  });
  await r.body?.cancel();
  return r.status === 200;
}

function report(label: string, s: Scan, root: string): void {
  const rel = (f: string) => f.slice(root.length + 1);
  console.log(
    `--- ${label}: ${s.files} files read, ${s.unreadable.length} unreadable`,
  );
  for (const [f, w] of s.sessions) {
    console.log(`  page session ${w} in ${rel(f)}`);
  }
  for (const [k, fs] of s.keys) {
    console.log(
      `  aib-key=${k.slice(0, 6)}… in ${[...fs].map(rel).join(", ")}`,
    );
  }
  for (const [f, m] of s.names) console.log(`  "${m}" in ${rel(f)}`);
  for (const f of s.unreadable.slice(0, 10)) {
    console.log(`  unreadable: ${rel(f)}`);
  }
}

Deno.test({
  name:
    "real binary: no page session or still-good launch key in WebView2 storage; reload, pop-out and restart still connect",
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
  const dist = Deno.env.get("AIB_E2E_DIST") || await builtDist();
  const zip =
    [...Deno.readDirSync(dist)].find((e) =>
      /^AIB-.*-windows-x64\.zip$/.test(e.name)
    )!.name;
  const app = `${fx.root}\\install\\A`;
  await unzip(`${dist}\\${zip}`, app);
  const alpha = `${fx.root}\\projects\\Alpha`;
  Deno.mkdirSync(alpha, { recursive: true });
  Deno.writeTextFileSync(
    `${fx.state}\\studio-added-projects.json`,
    JSON.stringify({
      version: 1,
      savedAt: 1,
      start: "fresh",
      added: { [projectKey(alpha)]: { path: alpha, at: 1 } },
    }),
  );
  const local = `${fx.root}\\localappdata`;
  const env: Record<string, string> = {
    AGENT_STUDIO_STATE_DIR: fx.state,
    APPDATA: `${fx.root}\\appdata`,
    LOCALAPPDATA: local,
    AIB_UPDATE_API_BASE: `http://127.0.0.1:${refusedPort()}`,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0",
    AGENT_STUDIO_LOG_LEVEL: "INFO", // the window's key handovers in studio.log
  };
  for (const d of [env.APPDATA, env.LOCALAPPDATA]) {
    Deno.mkdirSync(d, { recursive: true });
  }
  cdpRoots = [local, app];
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
      Deno.env.delete("AIB_PAGE_KEY"); // the real path: no fixed key, every key one-time
      return desk.spawn([`${app}\\AIB\\AIB.exe`, ...flags], `${app}\\AIB`);
    } finally {
      for (const k of [...Object.keys(env), "AIB_PAGE_KEY"]) {
        saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
      }
    }
  };
  const aibWindows = (pid: number) =>
    desk.windows().filter((w: DeskWindow) =>
      w.pid === pid && w.visible && w.cls.includes("Laufey") &&
      w.title.includes("AIB")
    );
  const sessions = new Set<string>();
  const connected = async (w: string, what: string, not: string[] = []) => {
    const s = String(
      await until(
        async () => {
          const v = String(await cdpEval(w, CONNECTED).catch(() => "") ?? "");
          return /^[A-Za-z0-9_-]{32,128}$/.test(v) && !not.includes(v)
            ? v
            : null;
        },
        what,
        120,
      ),
    );
    sessions.add(s);
    return s;
  };

  // ---- 1. the main window connects; an outside caller gets no token
  let pid = spawn();
  PORT = await ownerPort(fx.state, 90);
  const s1 = await connected("m", "the main window connected");
  const outside =
    await (await fetch(`http://127.0.0.1:${PORT}/api/live/bootstrap`)).json();
  assertEquals(
    outside.token,
    "",
    "no token for a caller without a page session",
  );
  assertEquals(
    await cdpEval("m", `location.hash`),
    "",
    "nothing in the address",
  );

  // ---- 2 and 3. reload (Ctrl+R, a crashed page), watching which keys the new page trades; then use them again
  const keys = await reloadAndCaptureKeys("m");
  const s2 = await connected(
    "m",
    "the main window connected again after a reload",
    [s1],
  );
  assert(s2 !== s1, "a new session after the reload");
  try {
    const lines = Deno.readTextFileSync(`${fx.state}\\studio.log`).split("\n")
      .filter((l) => /launch key/.test(l));
    console.log(`the window's key handovers so far:\n${lines.join("\n")}`);
  } catch { /* no log */ }
  console.log(`keys handed to the reloaded page: ${keys.length}`);
  // one key per page load (the runtime may land a reloaded window on / first; AIB sends it back to its own URL: a load each)
  assert(
    keys.length >= 1 && new Set(keys).size === keys.length,
    "a fresh key for every page load",
  );
  assert(keys.every((k) => /^[A-Za-z0-9_-]{43}$/.test(k)), "one-time keys");
  for (const k of keys) {
    assert(!(await keyStillGood(k)), "a used launch key is refused");
  }
  assertEquals(
    await cdpEval("m", `location.href.includes('aib-key')`),
    false,
    "never in the address",
  );
  const key = String(
    await until(
      () =>
        cdpEval(
          "m",
          `window.AgentWorkspaceUI && (AgentWorkspaceUI.paletteProjects().find((p) => p.name === 'Alpha') || {}).key`,
        ),
      "the project listed",
      60,
    ),
  );
  const opened = await cdpEval(
    "m",
    `StudioChat.post('desktop/windows', { op: 'open', from: 'm', project: { key: ${
      JSON.stringify(key)
    }, name: 'Alpha', path: ${JSON.stringify(alpha)} } })`,
  ) as Json;
  assertEquals(opened?.w, "w2", JSON.stringify(opened));
  await until(
    () => aibWindows(pid).length === 2 ? true : null,
    "two AIB windows",
    30,
  );
  await connected("w2", "the project window connected");

  // ---- 4. killed and started again: both windows come back and connect
  Deno.kill(pid, "SIGKILL");
  await until(() => exited(pid), "AIB gone", 30);
  await new Promise((r) => setTimeout(r, 1500));
  pid = spawn();
  PORT = await ownerPort(fx.state, 90);
  await until(
    () => aibWindows(pid).length === 2 ? true : null,
    "both windows back",
    120,
  );
  await connected("m", "the main window connected after the restart", [
    ...sessions,
  ]);
  await connected("w2", "the project window connected after the restart", [
    ...sessions,
  ]);

  // ---- 5. the disk, while AIB runs: no page session; no launch key that still works
  const roots = [local, `${fx.root}\\appdata`, fx.state, app];
  await new Promise((r) => setTimeout(r, 3000)); // let WebView2 write what it writes
  const live = scan(roots, [...sessions]);
  report("while AIB runs", live, fx.root);
  const good: string[] = [];
  for (const k of live.keys.keys()) if (await keyStillGood(k)) good.push(k);
  console.log(
    `launch keys found: ${live.keys.size}, still good: ${good.length}`,
  );

  // a clean quit (the last window closed, nothing working): WebView2 writes its session-restore files
  const wins = aibWindows(pid);
  for (const w of wins) desk.post(w, WM_CLOSE);
  await until(() => exited(pid), "AIB exited", 60);
  await new Promise((r) => setTimeout(r, 3000));
  await killUnder(`${fx.root}\\install`); // WebView2's own processes, if any are left
  const after = scan(roots, [...sessions]);
  report("after a clean quit", after, fx.root);

  assertEquals(live.sessions, [], "no page session on disk while AIB runs");
  assertEquals(good, [], "no launch key on disk that still works");
  assertEquals(after.sessions, [], "no page session on disk after AIB quit");
  assert(
    live.files > 20 && after.files > 20,
    `the profile was scanned (${live.files}, ${after.files} files)`,
  );
}
