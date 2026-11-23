/**
 * Remote control from other PCs, phase 4: windows and offline on the computer page (remote-windows.js, remote-auth.js), against an
 * in-process AIB with a fake agent host and a paired COMPUTER, in a headless Chrome. No real Tailscale: this test plays Tailscale
 * Serve with DevTools Fetch interception on EVERY window of the browser (a browser-level session that attaches to each new window
 * before it loads, so the windows the page opens are served too), and it can make the PC "go away":
 *   'down'        Serve answers 502 text (nothing listens behind it: AIB closed),
 *   'unreachable' no answer at all (Tailscale off, the PC asleep).
 * Windows: "Open in new window" opens one browser window per project (asking again brings it forward, no second one); popping a
 * chat out moves it into a small window and closing that window puts the tab back; a chat of a project another window shows opens
 * in that window. Offline: the bar says so, the page keeps what it showed, nothing is sent while offline nor later by itself,
 * and when the PC answers again the page reads on from its cursor; nothing of the chat is in Cache Storage or IndexedDB.
 */
import { assert, assertEquals } from "./_assert.ts";
import { Browser, browserPath, sleep } from "./_doc_browser.ts";
import { readRemotePort } from "../../outputs/agent-studio/server/remote/port.ts";
import {
  fakeTailscale,
  LOGIN,
  NAME,
  pairPhone,
  pc,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
} from "./_remote_fixture.ts";

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;

async function remoteOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, {
    saved: true,
  });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, "POST", "/api/live/devices/access", {
    on: true,
  });
  assertEquals(status, 200);
  return s;
}

function chat(id: string, session: string, cwd: string, text: string): Json {
  return {
    id,
    provider: "claude",
    sessionId: session,
    cwd,
    busy: false,
    closed: false,
    attention: { state: "idle", needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [{
      seq: 1,
      kind: "user",
      time: Date.now() / 1000 - 60,
      data: { text },
    }],
    permissions: [],
    elicitations: [],
  };
}

/** One DevTools connection to the whole browser; every window is a flat session on it. */
class Cdp {
  #ws: WebSocket;
  #next = 1;
  #waiting = new Map<
    number,
    { resolve: (v: Json) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<void>;
  readonly on = new Map<string, (params: Json, session: string) => void>();
  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.ready = new Promise((r) => (this.#ws.onopen = () => r()));
    this.#ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.#waiting.has(msg.id)) {
        const w = this.#waiting.get(msg.id)!;
        this.#waiting.delete(msg.id);
        if (msg.error) {
          w.reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
        } else w.resolve(msg.result ?? {});
        return;
      }
      const fn = msg.method && this.on.get(msg.method);
      if (fn) fn(msg.params ?? {}, msg.sessionId ?? "");
    };
  }
  send(method: string, params: Json = {}, sessionId = ""): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = this.#next++;
      const timer = setTimeout(() => {
        if (!this.#waiting.delete(id)) return;
        reject(new Error(`no answer to ${method}`));
      }, 20000);
      this.#waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#ws.send(
        JSON.stringify(
          sessionId
            ? { id, method, params, sessionId }
            : { id, method, params },
        ),
      );
    });
  }
  close() {
    try {
      this.#ws.close();
    } catch { /* gone */ }
  }
}

type Win = { session: string; target: string; url: string; errors: string[] };

/** Tailscale Serve for every window of the browser, with the PC's state switchable. */
async function serveBrowser(browser: Browser, s: RemoteStudio) {
  const info =
    await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
  const cdp = new Cdp(info.webSocketDebuggerUrl);
  await cdp.ready;
  const net = {
    mode: "up" as "up" | "down" | "unreachable",
    posts: [] as string[],
    credential: [] as string[],
  };
  const wins: Win[] = [];
  cdp.on.set("Target.attachedToTarget", (p) => {
    const t = p.targetInfo as Json;
    const session = p.sessionId as string;
    if (t.type !== "page") {
      void cdp.send("Runtime.runIfWaitingForDebugger", {}, session).catch(
        () => {},
      );
      return;
    }
    const win: Win = {
      session,
      target: t.targetId as string,
      url: t.url as string,
      errors: [],
    };
    wins.push(win);
    void (async () => {
      await cdp.send("Fetch.enable", {
        patterns: [{
          urlPattern: `https://${NAME}/*`,
          requestStage: "Request",
        }],
      }, session);
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, session);
    })().catch(() => {});
  });
  cdp.on.set("Target.targetInfoChanged", (p) => {
    const t = p.targetInfo as Json;
    const w = wins.find((x) => x.target === t.targetId);
    if (w) w.url = t.url as string;
  });
  cdp.on.set("Runtime.exceptionThrown", (p, session) => {
    const w = wins.find((x) => x.session === session);
    const d = p.exceptionDetails as Json;
    if (w) {
      w.errors.push(
        `${d.text} ${(d.exception as Json | undefined)?.description ?? ""}`
          .slice(0, 400),
      );
    }
  });
  cdp.on.set("Fetch.requestPaused", (p, session) => {
    void (async () => {
      const request = p.request as Json;
      const url = new URL(request.url as string);
      const method = request.method as string;
      const kind = p.resourceType as string;
      if (net.mode === "unreachable") {
        await cdp.send("Fetch.failRequest", {
          requestId: p.requestId,
          errorReason: "InternetDisconnected",
        }, session);
        return;
      }
      if (net.mode === "down") {
        await cdp.send("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: 502,
          responseHeaders: [{
            name: "Content-Type",
            value: "text/plain; charset=utf-8",
          }],
          body: btoa("Bad Gateway"),
        }, session);
        return;
      }
      if (method === "POST" && url.pathname.startsWith("/api/")) {
        net.posts.push(url.pathname);
      }
      const headers: Record<string, string> = {
        Host: NAME,
        "Tailscale-User-Login": LOGIN,
        "X-Forwarded-For": "100.64.0.7",
      };
      for (
        const [k, v] of Object.entries(
          request.headers as Record<string, string>,
        )
      ) {
        if (/^(host|cookie|connection|content-length|sec-fetch-.*)$/i.test(k)) {
          continue;
        }
        headers[k] = v;
        if (
          /^(x-studio-token|x-aib-page-key|x-aib-page-session|x-studio-artifact-key)$/i
            .test(k)
        ) {
          net.credential.push(`${k} ${url.pathname}`);
        }
      }
      if (
        method === "POST" &&
        !Object.keys(headers).some((k) => k.toLowerCase() === "origin")
      ) headers.Origin = `https://${NAME}`;
      Object.assign(
        headers,
        kind === "Document"
          ? {
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
          }
          : kind === "Fetch" || kind === "XHR"
          ? {
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
          }
          : {
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "no-cors",
            "Sec-Fetch-Dest": kind.toLowerCase(),
          },
      );
      // the browser's own cookies go with the request, as through Tailscale Serve (the pairing cookie is HttpOnly)
      const jar = await cdp.send("Network.getCookies", { urls: [url.href] }, session);
      const cookies = ((jar.cookies ?? []) as Json[]).map((c) => `${c.name}=${c.value}`).join("; ");
      if (cookies) headers.Cookie = cookies;
      let answer = null;
      try {
        answer = await raw(
          s.phonePort(),
          method,
          url.pathname + url.search,
          headers,
          request.postData as string | undefined,
        );
      } catch { /* Serve answers 502 */ }
      if (!answer) {
        await cdp.send("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: 502,
          responseHeaders: [],
          body: "",
        }, session);
        return;
      }
      const responseHeaders: Json[] = [];
      answer.headers.forEach((value, name) => {
        if (
          !/^(transfer-encoding|connection|content-length|keep-alive)$/i.test(
            name,
          )
        ) responseHeaders.push({ name, value });
      });
      let bin = "";
      for (let i = 0; i < answer.bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...answer.bytes.subarray(i, i + 0x8000));
      }
      await cdp.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: answer.status,
        responseHeaders,
        body: btoa(bin),
      }, session);
    })().catch(() => {});
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  async function evalIn<T = unknown>(
    w: Win,
    expression: string,
    gesture = false,
  ): Promise<T> {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: gesture,
    }, w.session);
    if (r.exceptionDetails) {
      throw new Error(
        `eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`,
      );
    }
    return (r.result as Json).value as T;
  }
  async function waitIn(w: Win, expression: string, ms: number, what: string) {
    const end = Date.now() + ms;
    let last: unknown;
    while (Date.now() < end) {
      try {
        last = await evalIn(w, `!!(${expression})`);
        if (last === true) return;
      } catch (e) {
        last = e;
      }
      await sleep(100);
    }
    throw new Error(
      `timed out waiting for ${what} (${String(last).slice(0, 200)})`,
    );
  }
  async function newWindow(url: string): Promise<Win> {
    const before = wins.length;
    await cdp.send("Target.createTarget", { url: "about:blank" });
    for (let i = 0; i < 100 && wins.length === before; i++) await sleep(50);
    const w = wins[wins.length - 1];
    await sleep(200);
    await cdp.send("Page.navigate", { url }, w.session);
    return w;
  }
  async function waitWindow(
    match: (url: string) => boolean,
    ms: number,
    what: string,
  ): Promise<Win> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const w = wins.find((x) => match(x.url));
      if (w) return w;
      await sleep(100);
    }
    throw new Error(
      `no window: ${what} (${wins.map((x) => x.url).join(" | ")})`,
    );
  }
  /** A picture of a window when AIB_DOCPAGE_SHOTS names a folder (as _doc_browser.ts Page.shot). */
  async function shot(w: Win, name: string) {
    const dir = Deno.env.get("AIB_DOCPAGE_SHOTS");
    if (!dir) return;
    const png = await cdp.send(
      "Page.captureScreenshot",
      { format: "png" },
      w.session,
    );
    await Deno.mkdir(dir, { recursive: true });
    Deno.writeFileSync(
      `${dir}/${name}.png`,
      Uint8Array.from(atob(String(png.data ?? "")), (c) => c.charCodeAt(0)),
    );
  }
  async function closeWindow(w: Win) {
    await cdp.send("Target.closeTarget", { targetId: w.target });
    wins.splice(wins.indexOf(w), 1);
  }
  return {
    cdp,
    net,
    wins,
    evalIn,
    waitIn,
    newWindow,
    waitWindow,
    closeWindow,
    shot,
  };
}

async function pairedPage(
  t: Awaited<ReturnType<typeof serveBrowser>>,
  token: string,
  id: string,
) {
  const main = await t.newWindow(`https://${NAME}/remote.css`);
  await t.waitIn(
    main,
    `location.pathname === '/remote.css' && document.readyState === 'complete'`,
    10000,
    "remote.css",
  );
  await t.evalIn(
    main,
    `new Promise((resolve, reject) => {
    const req = indexedDB.open('aib-phone', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ token: ${
      JSON.stringify(token)
    }, device: { id: ${JSON.stringify(id)} } }, 'device');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  })`,
  );
  await t.cdp.send(
    "Page.navigate",
    { url: `https://${NAME}/pc.html` },
    main.session,
  );
  await t.waitIn(
    main,
    `!!document.querySelector('#connections [data-key]')`,
    20000,
    "the chat list",
  );
  return main;
}

Deno.test({
  ...OPTS,
  name:
    "computer page windows: one window per project, a popped-out chat moves out and comes back, routed opens",
  ignore: !browserPath,
  async fn() {
    const s = await remoteOn();
    const browser = await Browser.launch();
    let t: Awaited<ReturnType<typeof serveBrowser>> | null = null;
    try {
      s.chats.push(chat("c1", "s1", s.project, "Fix the menu") as never);
      s.chats.push(chat("c2", "s2", s.project, "Second chat here") as never);
      const computer = await pairPhone(
        s,
        "Laptop (Edge)",
        undefined,
        "computer",
      );
      t = await serveBrowser(browser, s);
      const main = await pairedPage(t, computer.token, computer.id);
      await t.waitIn(
        main,
        `window.AIBRemoteWindows && window.AibWindow && window.AibWindow.canRoute()`,
        5000,
        "routing on",
      );
      const project = await t.evalIn<string>(
        main,
        `AgentWorkspaceUI.currentProject() ||
        ((AgentWorkspaceUI.paletteProjects() || [])[0] || {}).key || ''`,
      );
      assert(project, "a project key");

      // Open in new window: a browser window for the project
      const opened = await t.evalIn<Json>(
        main,
        `AgentWorkspaceUI.openProjectWindow(${JSON.stringify(project)})`,
        true,
      );
      assert(
        opened && typeof opened.w === "string" && opened.existed === false,
        JSON.stringify(opened),
      );
      const projWin = await t.waitWindow(
        (u) => u.includes("kind=project"),
        8000,
        "the project window",
      );
      assert(
        projWin.url.startsWith(
          `https://${NAME}/pc.html?w=${opened.w}&kind=project&project=`,
        ),
        projWin.url,
      );
      await t.waitIn(
        projWin,
        `!!document.querySelector('#connections [data-key]')`,
        20000,
        "the project window draws",
      );
      await t.waitIn(
        main,
        `AibWindow.others().some((w) => w.kind === 'project' && w.project === ${
          JSON.stringify(project)
        })`,
        8000,
        "the main window knows the project window",
      );
      // asking again brings that window forward: no second window
      const count = t.wins.length;
      const again = await t.evalIn<Json>(
        main,
        `AgentWorkspaceUI.openProjectWindow(${JSON.stringify(project)})`,
        true,
      );
      assertEquals(again.w, opened.w);
      assertEquals(again.existed, true);
      await sleep(500);
      assertEquals(t.wins.length, count, "no second window for one project");

      // a chat of that project opens in the project window (routeOpen), never over the main window
      await t.evalIn(
        main,
        `AgentWorkspaceUI.routeOpen({ chat: 'claude:s1', project: ${
          JSON.stringify(project)
        } }, () => { window.__openedHere = true; })`,
        true,
      );
      await t.waitIn(
        projWin,
        `document.getElementById('messages').textContent.includes('Fix the menu')`,
        10000,
        "the routed chat opens in the project window",
      );
      assert(
        !(await t.evalIn<boolean>(main, `!!window.__openedHere`)),
        "not opened in the main window",
      );

      // the project window goes: the main window shows the project again
      await t.closeWindow(projWin);
      await t.waitIn(
        main,
        `!AibWindow.others().some((w) => w.kind === 'project')`,
        5000,
        "the project window left the roster",
      );

      // pop a chat out: a small window with that chat; its tab leaves the main window
      await t.evalIn(
        main,
        `document.querySelector('#connections [data-key="claude:s2"]') && document.querySelector('#connections [data-key="claude:s2"]').click()`,
        true,
      );
      await t.waitIn(
        main,
        `document.getElementById('messages').textContent.includes('Second chat here')`,
        10000,
        "chat 2 open",
      );
      const popped = await t.evalIn<boolean>(
        main,
        `AgentWorkspaceUI.popOutChat('claude:s2')`,
        true,
      );
      assert(popped, "popped out");
      const popWin = await t.waitWindow(
        (u) => u.includes("kind=chat"),
        8000,
        "the chat pop-out",
      );
      assert(
        popWin.url.includes("mode=chat") &&
          popWin.url.includes("chat=claude%3As2"),
        popWin.url,
      );
      await t.waitIn(
        popWin,
        `document.body.classList.contains('aib-mode-chat') &&
        document.getElementById('messages').textContent.includes('Second chat here')`,
        20000,
        "the pop-out shows its chat",
      );
      await t.waitIn(
        main,
        `AibWindow.others().some((w) => w.kind === 'chat' && w.chat === 'claude:s2')`,
        8000,
        "the pop-out in the roster",
      );
      // the moved chat opens in its pop-out from the main window too (routeOpen sends it there)
      await t.evalIn(
        main,
        `window.__here2 = false; AgentWorkspaceUI.routeOpen({ chat: 'claude:s2', project: ${
          JSON.stringify(project)
        } }, () => { window.__here2 = true; })`,
        true,
      );
      await sleep(600);
      assert(
        !(await t.evalIn<boolean>(main, `window.__here2`)),
        "a popped-out chat does not open in the main window",
      );
      // the pop-out closes: its tab comes back in the main window
      await t.closeWindow(popWin);
      await t.waitIn(
        main,
        `!AibWindow.others().some((w) => w.kind === 'chat')`,
        5000,
        "the pop-out left the roster",
      );
      await t.waitIn(
        main,
        `!JSON.parse(sessionStorage.getItem('aib-chat-popouts') || '[]').some((p) => p.key === 'claude:s2')`,
        5000,
        "the chat is back in the main window",
      );

      // a second plain tab of the page is its own window (its own id), and only the window focused last chimes
      const tab2 = await t.newWindow(`https://${NAME}/pc.html`);
      await t.waitIn(
        tab2,
        `!!document.querySelector('#connections [data-key]')`,
        20000,
        "a second tab draws",
      );
      const ids = [
        await t.evalIn<string>(main, `AibWindow.id()`),
        await t.evalIn<string>(tab2, `AibWindow.id()`),
      ];
      assert(
        ids[0] !== ids[1] && ids.every((x) => /^t-/.test(x)),
        ids.join(" "),
      );
      await t.waitIn(
        main,
        `AibWindow.others().some((w) => w.w === ${JSON.stringify(ids[1])})`,
        8000,
        "the tabs know each other",
      );

      // a doc pop-out: a small window with the doc page (the computer's doc page, its own id); asking again brings it forward
      const docAsk =
        `fetch('/api/live/desktop/windows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'popout', from: AibWindow.id(), doc: { project: ${
          JSON.stringify(project)
        }, name: 'notes' } }) })
        .then(async (r) => ({ status: r.status, body: await r.json() }))`;
      const docOpen = await t.evalIn<Json>(main, docAsk, true);
      assertEquals(docOpen.status, 200, JSON.stringify(docOpen));
      const docWin = await t.waitWindow(
        (u) => u.includes("/doc.html?") && u.includes("kind=doc"),
        8000,
        "the doc pop-out",
      );
      assert(docWin.url.includes("name=notes"), docWin.url);
      await t.waitIn(
        docWin,
        `document.documentElement.dataset.remote === 'pc' && !!window.AIBRemoteWindows`,
        15000,
        "the computer doc page",
      );
      await t.waitIn(
        main,
        `AibWindow.others().some((w) => w.kind === 'doc' && w.doc && w.doc.name === 'notes')`,
        8000,
        "the doc window in the roster",
      );
      const docAgain = await t.evalIn<Json>(main, docAsk, true);
      assertEquals(
        (docAgain.body as Json).existed,
        true,
        JSON.stringify(docAgain),
      );
      // a window closes only itself
      const other = await t.evalIn<Json>(
        main,
        `fetch('/api/live/desktop/windows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'close', from: AibWindow.id(), w: ${
          JSON.stringify(String((docOpen.body as Json).w))
        } }) }).then((r) => r.status)`,
      );
      assertEquals(other, 403);
      await t.closeWindow(docWin);
      await t.waitIn(
        main,
        `!AibWindow.others().some((w) => w.kind === 'doc')`,
        5000,
        "the doc window left",
      );

      assertEquals(t.net.credential, [], "no page credential from any window");
      const errors = t.wins.flatMap((w) => w.errors).filter((e) =>
        !/Failed to load resource|fetching the script/.test(e)
      );
      assertEquals(errors, [], "no page errors");
    } finally {
      t?.cdp.close();
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "computer page offline: the bar, the last view kept in memory, nothing sent or queued, the cursor resumes, no chat in storage",
  ignore: !browserPath,
  async fn() {
    const s = await remoteOn();
    const browser = await Browser.launch();
    let t: Awaited<ReturnType<typeof serveBrowser>> | null = null;
    try {
      const c1 = chat("c1", "s1", s.project, "Fix the menu") as {
        events: Json[];
      };
      s.chats.push(c1 as never);
      const computer = await pairPhone(
        s,
        "Laptop (Edge)",
        undefined,
        "computer",
      );
      t = await serveBrowser(browser, s);
      const page = await pairedPage(t, computer.token, computer.id);
      await t.evalIn(
        page,
        `document.querySelector('#connections [data-key]').click()`,
        true,
      );
      await t.waitIn(
        page,
        `document.getElementById('messages').textContent.includes('Fix the menu')`,
        10000,
        "the chat opens",
      );

      // the PC goes away (no answer at all): the bar says so, the chat stays on screen
      t.net.mode = "unreachable";
      await t.waitIn(
        page,
        `document.getElementById('remoteOffline') && document.getElementById('remoteOffline').textContent.includes("Can't reach ")`,
        12000,
        "the offline bar",
      );
      await t.shot(page, "pc-offline");
      const bar = await t.evalIn<string>(
        page,
        `document.getElementById('remoteOffline').textContent`,
      );
      assert(/^Can't reach .+\. Trying again…Try now$/.test(bar), bar);
      assert(
        await t.evalIn<boolean>(
          page,
          `document.getElementById('messages').textContent.includes('Fix the menu')`,
        ),
        "the last view stays",
      );
      assert(
        await t.evalIn<boolean>(
          page,
          `document.documentElement.hasAttribute('data-remote-offline')`,
        ),
        "offline mark",
      );
      // Send while offline: nothing goes to the PC (the page is told "Nothing was sent")
      t.net.posts.length = 0;
      const sendAnswer = await t.evalIn<Json>(
        page,
        `fetch('/api/live/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'c1', text: 'Offline hello', clientMessageId: 'm-off-1' }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
      );
      assertEquals(sendAnswer.status, 503);
      assert(
        String((sendAnswer.body as Json).error).endsWith("Nothing was sent."),
        JSON.stringify(sendAnswer),
      );
      await t.evalIn(
        page,
        `(() => { const p = document.getElementById('prompt'); p.value = 'Typed while offline';
        p.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('promptForm').requestSubmit(); })()`,
        true,
      );
      await sleep(500);

      // Serve answers 502 (AIB closed on the PC): "not answering" first
      t.net.mode = "down";
      await t.evalIn(
        page,
        `document.querySelector('#remoteOffline .remote-offline-try').click()`,
        true,
      );
      await t.waitIn(
        page,
        `document.getElementById('remoteOffline').textContent.includes(' is not answering. Trying again…')`,
        8000,
        "the closed wording",
      );
      // meanwhile the agent goes on on the PC
      c1.events.push({
        seq: 2,
        kind: "user",
        time: Date.now() / 1000,
        data: { text: "Written while you were away" },
      });
      assertEquals(
        t.net.posts.filter((p) => p === "/api/live/prompt"),
        [],
        "nothing sent while offline",
      );

      await t.shot(page, "pc-offline-closed");
      // the PC answers again: the bar goes, the page reads on from its cursor, nothing goes out by itself
      t.net.mode = "up";
      await t.waitIn(
        page,
        `!document.getElementById('remoteOffline')`,
        12000,
        "the bar goes by itself (5 s retry)",
      );
      await t.waitIn(
        page,
        `document.getElementById('messages').textContent.includes('Written while you were away')`,
        10000,
        "the event written meanwhile",
      );
      const text = await t.evalIn<string>(
        page,
        `document.getElementById('messages').textContent`,
      );
      assertEquals(text.split("Fix the menu").length - 1, 1, "each event once");
      assert(
        !(await t.evalIn<boolean>(
          page,
          `document.documentElement.hasAttribute('data-remote-offline')`,
        )),
        "online",
      );
      await sleep(2500);
      assertEquals(
        t.net.posts.filter((p) => p === "/api/live/prompt"),
        [],
        "nothing sent later by itself",
      );
      assertEquals(
        await t.evalIn<string>(page, `document.getElementById('prompt').value`),
        "Typed while offline",
        "the draft is kept",
      );

      // nothing of the chat in Cache Storage or IndexedDB (the service worker keeps the page's own files only)
      const stored = await t.evalIn<Json>(
        page,
        `(async () => {
        const out = { caches: [], cacheHits: [], dbs: [], kv: [] };
        if (window.caches) for (const name of await caches.keys()) {
          const c = await caches.open(name);
          for (const req of await c.keys()) {
            const path = new URL(req.url).pathname;
            out.caches.push(path);
            const body = await (await c.match(req)).text();
            if (/Fix the menu|Written while you were away/.test(body)) out.cacheHits.push(path);
          }
        }
        out.dbs = (await indexedDB.databases()).map((d) => d.name);
        out.kv = await new Promise((resolve) => {
          const r = indexedDB.open('aib-phone', 1);
          r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').getAllKeys(); g.onsuccess = () => resolve(g.result); };
          r.onerror = () => resolve(['?']);
        });
        return out;
      })()`,
      );
      assertEquals(stored.cacheHits, [], "no chat content in Cache Storage");
      assert(
        !(stored.caches as string[]).some((p) => p.startsWith("/api/")),
        JSON.stringify(stored.caches),
      );
      assertEquals(
        stored.dbs,
        ["aib-phone"],
        "IndexedDB: the device record only",
      );
      assertEquals(stored.kv, ["device"]);
      const local = await t.evalIn<string[]>(
        page,
        `Object.keys(localStorage).filter((k) => /Written while you were away/.test(localStorage.getItem(k)))`,
      );
      assertEquals(local, [], "no agent text in localStorage");
      // security review SF6: drafts, sends and chat names are memory only on a computer (the draft above is in the box, not on disk)
      const onDisk = await t.evalIn<string[]>(
        page,
        `(() => { const out = []; for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)); return out; })()
          .filter((k) => /^studio-(drafts-v1|pending-sends-v1|prompt-attempts-v1|conversation-names)$/.test(k))
          .concat(Object.values(localStorage).some((v) => /Typed while offline/.test(String(v))) ? ['draft text'] : [])`,
      );
      assertEquals(onDisk, [], "nothing typed or sent on this computer's disk");
      const errors = t.wins.flatMap((w) => w.errors).filter((e) =>
        !/Failed to load resource|fetching the script/.test(e)
      );
      assertEquals(errors, [], "no page errors");
    } finally {
      t?.cdp.close();
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
