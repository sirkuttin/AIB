/**
 * "Open in new window" for a WSL project (owner bug report, 0.13.0): headless chat.html pages against a Studio in this process with
 * the fake K4 (_fake_desktop_windows.ts), as multi_window_entry_e2e_test.ts does for a Windows project. Nothing is shown; no distro
 * is needed (the chats carry a wsl:// folder).
 *   - the project menu, Ctrl+K and Ctrl+click on a WSL project send K3 {op:'open'} with its key and its wsl:// path; one window
 *   - the project's window (?w=w2&kind=project&project=<key>) shows that WSL project and its chat
 *   - a WSL chat's and a WSL doc's pop-out bodies carry the WSL project's key
 */
import { assert, assertEquals } from "./_assert.ts";
import { Browser, browserPath, type Page } from "./_doc_browser.ts";
import { remoteStudio } from "./_remote_fixture.ts";
import { FakeDesktopWindows } from "./_fake_desktop_windows.ts";

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REF = "wsl://ubuntu/home/u/app";

const SPY = [
  "window.__winCalls = [];",
  "const __f = window.fetch.bind(window);",
  "window.fetch = async (u, o) => {",
  "  const r = await __f(u, o);",
  "  if (String(u).includes('/api/live/desktop/windows')) window.__winCalls.push({ body: JSON.parse(o.body), status: r.status });",
  "  return r;",
  "};",
].join("\n");
const APP = "window.bindings = { aibDesktop() {} };\n" + SPY;

async function lab() {
  const s = await remoteStudio();
  s.ctx.transcripts = {
    root: s.state,
    sessions: () => Promise.resolve([]),
    agents: () => Promise.resolve([]),
    sessionCwd: () => Promise.resolve(null),
  } as unknown as typeof s.ctx.transcripts;
  const chat = (n: number, cwd: string, title: string) => ({
    id: "c" + n,
    provider: "claude",
    sessionId: "sess-" + n,
    cwd,
    busy: false,
    closed: false,
    attention: {
      state: "idle",
      needs: 0,
      turnEndedAt: null,
      busySince: null,
    } as Json,
    subagents: {},
    breadth: { sessionInfo: { title } },
    events: [{
      seq: 1,
      kind: "user",
      time: 1,
      data: { text: "work on " + title },
    }] as Json[],
    permissions: [] as Json[],
    elicitations: [],
  });
  s.chats.push(chat(1, s.root, "Windows chat"), chat(2, REF, "Linux chat"));
  const browser = await Browser.launch();
  const open = async (query: string, items = 2) => {
    const page = await browser.open("about:blank", 1280, 900);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: APP });
    await page.goto(`http://127.0.0.1:${s.port}/${query}`);
    await page.waitFor(
      "!!window.AibWindow && !!window.AgentWorkspaceUI && !!window.AgentNotifyUI",
      15000,
      "the page",
    );
    await page.waitFor(
      `window.AgentWorkspaceUI._items().length >= ${items}`,
      20000,
      "the chats",
    );
    return page;
  };
  return {
    s,
    open,
    async close() {
      await browser.close();
      await s.close();
    },
  };
}

const wslKey = (p: Page) =>
  p.eval<string>(
    'window.AgentWorkspaceUI._items().find((i) => i.key === "claude:sess-2").projectKey',
  );
async function waitCalls(p: Page, n: number) {
  await p.waitFor(
    `window.__winCalls.length >= ${n}`,
    8000,
    `${n} window call(s)`,
  );
  await sleep(150);
  return p.eval<{ body: Json; status: number }[]>("window.__winCalls");
}

Deno.test({
  ...OPTS,
  name:
    "WSL project: Open in new window (menu, Ctrl+K, Ctrl+click) and the project window shows it",
  ignore: !browserPath,
  async fn() {
    const t = await lab();
    const dw = new FakeDesktopWindows();
    t.s.ctx.desktopWindows = dw;
    try {
      const a = await t.open("?w=m");
      const pk = await wslKey(a);
      assert(pk && pk !== "none", "the WSL chat has a project key: " + pk);
      const proj = await a.eval<Json | null>(
        `(window.AgentWorkspaceUI.paletteProjects().find((p) => p.key === ${
          JSON.stringify(pk)
        }) || null)`,
      );
      assert(proj, "the WSL project is in the project list");
      // the menu
      const items = await a.eval<string[]>(`(() => {
        window.AgentWorkspaceUI.openProjectCtx(${JSON.stringify(pk)}, 200, 200);
        const m = document.querySelector('.ws-menu[role=menu]');
        const out = m ? Array.from(m.querySelectorAll('.ws-menu-item')).map((b) => b.textContent) : [];
        const b = m && Array.from(m.querySelectorAll('.ws-menu-item')).find((x) => x.textContent === 'Open in new window');
        if (b) b.click();
        return out;
      })()`);
      assert(
        items.includes("Open in new window"),
        "the menu offers it: " + JSON.stringify(items),
      );
      let c = await waitCalls(a, 1);
      assertEquals(c[0].status, 200, JSON.stringify(c[0]));
      assertEquals((c[0].body.project as Json).key, pk);
      assertEquals(
        (c[0].body.project as Json).path,
        REF,
        "the wsl:// path is sent",
      );
      assertEquals(dw.windows.map((w) => [w.w, w.kind, w.project]), [[
        "m",
        "main",
        null,
      ], ["w2", "project", pk]]);
      // Ctrl+K
      await a.eval("window.__winCalls.length = 0, true");
      const ran = await a.eval<string>(`(() => {
        const act = window.AgentCommands.buildActions(window.AgentSwitcherUI.makeCtx()).find((x) => x.id === 'new-window:' + ${
        JSON.stringify(pk)
      });
        if (!act) return '';
        act.run();
        return act.title;
      })()`);
      assert(ran, "Ctrl+K offers it");
      c = await waitCalls(a, 1);
      assertEquals((c[0].body.project as Json).key, pk);
      // Ctrl+click on the dropdown row
      await a.eval("window.__winCalls.length = 0, true");
      const clicked = await a.eval<boolean>(`(() => {
        window.AgentWorkspaceUI.openProjectMenu();
        const row = document.querySelector('.ws-prow[data-project=' + JSON.stringify(${
        JSON.stringify(pk)
      }) + '] .ws-prow-main');
        if (!row) return false;
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, clientX: 120, clientY: 120 }));
        return true;
      })()`);
      assert(clicked, "the dropdown has the WSL project row");
      c = await waitCalls(a, 1);
      assertEquals((c[0].body.project as Json).key, pk);
      assertEquals(dw.made, 1, "one window for the project");

      // the project's window: it shows the WSL project and its chat
      const b = await t.open(
        `?w=w2&kind=project&project=${encodeURIComponent(pk)}`,
        1,
      );
      await b.waitFor(
        `window.AgentWorkspaceUI.currentProject && window.AgentWorkspaceUI.currentProject() === ${
          JSON.stringify(pk)
        }`,
        10000,
        "the window shows the WSL project",
      );
      const shown = await b.eval<string[]>(
        "window.AgentWorkspaceUI._items().filter((i) => i.projectKey === window.AgentWorkspaceUI.currentProject()).map((i) => i.key)",
      );
      assertEquals(shown, ["claude:sess-2"]);

      // a WSL chat's pop-out asks with the WSL project's key
      await a.eval("window.__winCalls.length = 0, true");
      assert(
        await a.eval<boolean>(
          `window.AgentWorkspaceUI.popOutChat('claude:sess-2')`,
        ),
        "popped out",
      );
      c = await waitCalls(a, 1);
      assertEquals(c[0].body.op, "popout");
      assertEquals((c[0].body.chat as Json).project, pk);
      assertEquals(c[0].status, 200);

      // an added WSL project with no chat yet: offered, opened, and its window shows it
      const ADDED = "wsl://ubuntu/home/u/other";
      await t.s.ctx.addedProjects!.add(ADDED);
      await a.eval(
        "window.AgentWorkspaceUI.refreshAdded ? window.AgentWorkspaceUI.refreshAdded() : null, true",
      );
      const addedKey = "p:wsl:/ubuntu/home/u/other";
      await a.waitFor(
        `!!window.AgentWorkspaceUI.paletteProjects().find((p) => p.key === ${
          JSON.stringify(addedKey)
        })`,
        15000,
        "the added WSL project listed",
      );
      await a.eval("window.__winCalls.length = 0, true");
      const items2 = await a.eval<string[]>(`(() => {
        window.AgentWorkspaceUI.openProjectCtx(${
        JSON.stringify(addedKey)
      }, 200, 200);
        const m = document.querySelector('.ws-menu[role=menu]');
        const out = m ? Array.from(m.querySelectorAll('.ws-menu-item')).map((b) => b.textContent) : [];
        const b = m && Array.from(m.querySelectorAll('.ws-menu-item')).find((x) => x.textContent === 'Open in new window');
        if (b) b.click();
        return out;
      })()`);
      assert(
        items2.includes("Open in new window"),
        "offered for an added WSL project: " + JSON.stringify(items2),
      );
      c = await waitCalls(a, 1);
      assertEquals(c[0].status, 200, JSON.stringify(c[0]));
      assertEquals((c[0].body.project as Json).path, ADDED);
      const w3 = dw.windows.find((w) => w.project === addedKey);
      assert(w3, "a window for the added WSL project");
      const d = await t.open(
        `?w=${w3.w}&kind=project&project=${encodeURIComponent(addedKey)}`,
        0,
      );
      await d.waitFor(
        `window.AgentWorkspaceUI.currentProject && window.AgentWorkspaceUI.currentProject() === ${
          JSON.stringify(addedKey)
        }`,
        10000,
        "the window shows the added WSL project",
      );
      assertEquals(a.errors, [], "console errors (main)");
      assertEquals(b.errors, [], "console errors (project window)");
      assertEquals(d.errors, [], "console errors (added project window)");
    } finally {
      await t.close();
    }
  },
});
