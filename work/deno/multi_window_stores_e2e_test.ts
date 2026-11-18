/**
 * Multi-window Phase 1B (store-merge.js): two AIB windows share one localStorage (Phase 0 spike: one WebView2 profile). Two headless
 * pages of one browser stand in for two windows: A is the main window (/chat.html), B a project window (/chat.html?w=w2&kind=project&
 * project=<its project>), C another project window. A real Studio (the scroll lab: temp state folder, free port, never the live
 * ports), headless Chrome/Edge, no window on screen.
 *
 *   1. Drafts typed in A (chat X) and B (chat Y) both survive, also after both pages reload; the workspace keeps both windows' tabs.
 *   2. Split layouts, file tabs, reading places, seen turns and collapsed groups: each window's entry survives the other's write,
 *      and a project window cannot write another project's entry.
 *   3. Per-window keys: B starts from A's values, then B's sidebar switch and column widths are its own (A's stay exactly as
 *      they were, pixel check on --side-w); a theme or text size change in A shows in B without a reload.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/multi_window_stores_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  browserPath,
  type Chat,
  Lab,
  type Page,
  settle,
} from "./_scroll_lab.ts";

function mwTest(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1280, 900);
      try {
        // the main window as the desktop app opens it (window id m, as ?w=m says): with its id in presence, a window that reloads
        // while another is open is seeded "missing-only" (N1), as in the app; a plain tab id (t-...) would not count as a window
        await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html?w=m`);
        await lab.page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
        await fn(lab);
        assert(
          lab.page.errors.length === 0,
          `console errors in A: ${lab.page.errors.join(" | ")}`,
        );
      } finally {
        await lab.close();
      }
    },
  });
}

const ls = (page: Page, key: string) =>
  page.eval<string | null>(`localStorage.getItem(${JSON.stringify(key)})`);
const lsJson = async (page: Page, key: string) =>
  JSON.parse((await ls(page, key)) || "null");
/**
 * The key as `page` reads it once `ready` holds (at most 5 s), for a read right after ANOTHER window wrote: each Chromium renderer keeps
 * its own copy of localStorage and the browser process brings the other window's write over a moment later, so an immediate read
 * could miss it (the file tabs once read only ["zz-a"] in a loaded pool). Returns the last value read either way: the exact
 * assertions after it decide.
 */
// deno-lint-ignore no-explicit-any
async function lsJsonWhen(page: Page, key: string, ready: (value: any) => boolean): Promise<any> {
  const end = Date.now() + 5000;
  while (true) {
    const value = await lsJson(page, key);
    try {
      if (ready(value)) return value;
    } catch { /* not there yet */ }
    if (Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function finished(lab: Lab, folder: string, text: string): Promise<Chat> {
  const c = await lab.chat(folder);
  await c.start();
  c.say(text);
  c.end();
  return c;
}

async function openWindow(lab: Lab, query: string): Promise<Page> {
  const page = await lab.browser.open("about:blank", 1280, 900);
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html${query}`);
  await page.waitFor(
    '!!document.getElementById("messages") && !!window.AibStore',
    15000,
    "second window",
  );
  return page;
}

/** The view preferences a page just changed have reached the server (it seeds chat.html from them at the next load). */
async function prefsSent(page: Page): Promise<void> {
  await page.waitFor(
    `!window.AibViewPrefs || !AibViewPrefs.init() || Object.keys(AibViewPrefs.init().pending()).length === 0`,
    5000,
    "prefs sent",
  );
  await settle(600);
}

async function reload(page: Page): Promise<void> {
  await prefsSent(page);
  await page.send("Page.reload", {});
  await settle(300);
  await page.waitFor(
    'document.readyState === "complete" && !!window.AibStore && !!document.getElementById("messages")',
    15000,
    "reload",
  );
}

/** Select a chat in this page's sidebar (switching the list to its project first) and wait for it to show. */
async function selectIn(page: Page, key: string, pk: string): Promise<void> {
  await page.waitFor(
    `AgentWorkspaceUI._items().some((i) => i.key === ${JSON.stringify(key)})`,
    20000,
    `${key} listed`,
  );
  await page.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
  const sel = `button.connection[data-key="${key}"]`;
  await page.waitFor(
    `!!document.querySelector(${JSON.stringify(sel)})`,
    20000,
    `sidebar row ${key}`,
  );
  await page.click(sel);
  await page.waitFor(
    `document.querySelector(${
      JSON.stringify(sel)
    })?.classList.contains('selected')`,
    20000,
    `${key} open`,
  );
}

async function typeDraft(page: Page, text: string): Promise<void> {
  await page.eval(
    `(() => { const p = document.getElementById('prompt'); p.focus(); p.value = ''; })()`,
  );
  await page.type(text);
  await settle(200);
}

mwTest(
  "two windows: drafts and workspace tabs of both survive each other and reloads",
  async (lab) => {
    const A = lab.page;
    const x = await finished(lab, "recipe-site", "Recipe done");
    const y = await finished(lab, "budget-app", "Budget done");
    await A.waitFor(
      `AgentWorkspaceUI._items().filter((i) => i.key === ${
        JSON.stringify(x.key)
      } || i.key === ${JSON.stringify(y.key)}).length === 2`,
      30000,
      "both chats listed",
    );
    const pk = await A.eval<Record<string, string>>(
      `Object.fromEntries(AgentWorkspaceUI._items().map((i) => [i.key, i.projectKey]))`,
    );
    const pkX = pk[x.key], pkY = pk[y.key];
    assert(pkX && pkY && pkX !== pkY, `two projects: ${pkX} ${pkY}`);
    const B = await openWindow(
      lab,
      `?w=w2&kind=project&project=${encodeURIComponent(pkY)}`,
    );
    try {
      await selectIn(A, x.key, pkX);
      await selectIn(B, y.key, pkY);
      await typeDraft(A, "draft X typed in A");
      await typeDraft(B, "draft Y typed in B");
      await typeDraft(A, "draft X typed in A, more");
      const saved = await lsJson(A, "studio-drafts-v1");
      assertEquals(saved.version, 1, "the saved format is unchanged");
      assertEquals(saved.drafts[x.key], "draft X typed in A, more");
      assertEquals(
        saved.drafts[y.key],
        "draft Y typed in B",
        "A's later save kept B's draft",
      );
      const ws = await lsJson(A, "studio-workspace-v1");
      assert(
        (ws.tabs[pkX] || []).includes(x.key),
        `A's tab saved: ${JSON.stringify(ws)}`,
      );
      assert(
        (ws.tabs[pkY] || []).includes(y.key),
        `B's tab saved: ${JSON.stringify(ws)}`,
      );
      assertEquals(ws.v, 1);

      await reload(A);
      await reload(B);
      await selectIn(A, x.key, pkX);
      await selectIn(B, y.key, pkY);
      assertEquals(
        await A.eval(`document.getElementById('prompt').value`),
        "draft X typed in A, more",
      );
      assertEquals(
        await B.eval(`document.getElementById('prompt').value`),
        "draft Y typed in B",
      );
      const ws2 = await lsJson(A, "studio-workspace-v1");
      assert(
        (ws2.tabs[pkX] || []).includes(x.key) &&
          (ws2.tabs[pkY] || []).includes(y.key),
        `both tabs after reloads: ${JSON.stringify(ws2)}`,
      );
      // B (a project window) never writes the active project: that stays the main window's
      assertEquals(
        ws2.active,
        await A.eval(`AgentWorkspaceUI._state().active`),
      );
      assert(
        B.errors.length === 0,
        `console errors in B: ${B.errors.join(" | ")}`,
      );
    } finally {
      await B.close();
    }
  },
);

const layout = (a: string, b: string) => ({
  tree: {
    k: "s",
    id: "s1",
    dir: "row",
    ch: [{ k: "g", id: "g1", tabs: [a], active: a }, {
      k: "g",
      id: "g2",
      tabs: [b],
      active: b,
    }],
  },
  focus: "g1",
});

mwTest(
  "two windows: split panes, file tabs, reading places, seen turns and collapsed groups merge per entry",
  async (lab) => {
    const A = lab.page;
    const C = await openWindow(lab, `?w=w3&kind=project&project=zz-c`);
    try {
      const store = (page: Page, key: string, op: string) =>
        page.eval(
          `(() => { const s = AibStore._stores.get(${
            JSON.stringify(key)
          }); if (!s) throw new Error('no store ${key}'); ${op}; return true; })()`,
        );
      // split panes (split-ui.js): A writes its layout for zz-a, C for its own project zz-c; C may not write zz-a
      await store(
        A,
        "studio-split-v1",
        `s.set('zz-a', ${JSON.stringify(layout("claude:a1", "claude:a2"))})`,
      );
      await store(
        C,
        "studio-split-v1",
        `s.set('zz-c', ${
          JSON.stringify(layout("claude:c1", "claude:c2"))
        }); s.set('zz-a', ${JSON.stringify(layout("claude:x", "claude:y"))})`,
      );
      let split = await lsJsonWhen(A, "studio-split-v1", (v) => "zz-c" in v.layouts);
      assertEquals(Object.keys(split.layouts).sort(), ["zz-a", "zz-c"]);
      assertEquals(
        split.layouts["zz-a"].tree.ch[0].tabs,
        ["claude:a1"],
        "C could not write A's project",
      );
      assertEquals(split.v, 1);
      // the module in A took C's layout into memory (storage event): its next save keeps it
      await A.waitFor(
        `AgentSplitUI.restoreKey('zz-c') === 'claude:c1'`,
        5000,
        "A's split module sees C's layout",
      );

      // file tabs (files-ui.js)
      const tab = (p: string) => ({
        tabs: [{ path: p, scope: { id: "main", root: "main" }, name: p }],
        active: "",
      });
      await store(
        A,
        "aib-file-tabs-v1",
        `s.set('zz-a', ${JSON.stringify(tab("a.md"))})`,
      );
      await store(
        C,
        "aib-file-tabs-v1",
        `s.set('zz-c', ${JSON.stringify(tab("c.md"))})`,
      );
      const files = await lsJsonWhen(A, "aib-file-tabs-v1", (v) => "zz-c" in v);
      assertEquals(Object.keys(files).sort(), ["zz-a", "zz-c"]);

      // reading places (scroll-controller.js): each page remembers its chat, both kept
      await A.eval(
        `ScrollController.remember('main:claude:a1', { mode: 'anchor', rid: 'm:3', off: 12, h: 40, w: 600 }); ScrollController.saveNow()`,
      );
      await C.eval(
        `ScrollController.remember('main:claude:c1', { mode: 'anchor', rid: 'm:7', off: 4, h: 30, w: 600 }); ScrollController.saveNow()`,
      );
      const scroll = await lsJsonWhen(A, "studio-scroll-v1", (v) => !!v["main:claude:c1"]);
      assert(
        scroll["main:claude:a1"] && scroll["main:claude:c1"],
        `both places: ${JSON.stringify(scroll)}`,
      );

      // seen turns (workspace-ui.js) and collapsed groups (sidebar-ui.js)
      await store(A, "studio-seen-turns", `s.set('claude:a1', 111)`);
      await store(C, "studio-seen-turns", `s.set('claude:c1', 222)`);
      assertEquals(await lsJsonWhen(A, "studio-seen-turns", (v) => "claude:c1" in v), {
        "claude:a1": 111,
        "claude:c1": 222,
      });
      await A.eval(`AgentSidebarUI.setCollapsed('zz-a', true)`);
      await C.eval(`AgentSidebarUI.setCollapsed('zz-c', true)`);
      assertEquals((await lsJsonWhen(A, "studio-sidebar-collapsed", (v) => v.includes("zz-c"))).sort(), [
        "zz-a",
        "zz-c",
      ]);

      // both reload: every entry is still there, and each module loads the other window's entries too
      await reload(A);
      await reload(C);
      split = await lsJson(A, "studio-split-v1");
      assertEquals(Object.keys(split.layouts).sort(), ["zz-a", "zz-c"]);
      assertEquals(
        await C.eval(`AgentSplitUI.restoreKey('zz-a')`),
        "claude:a1",
      );
      const scroll2 = await lsJson(A, "studio-scroll-v1");
      assert(
        scroll2["main:claude:a1"] && scroll2["main:claude:c1"],
        "both places after reloads",
      );
      assertEquals(await A.eval(`AgentSidebarUI.isCollapsed('zz-c')`), true);
      assert(
        C.errors.length === 0,
        `console errors in C: ${C.errors.join(" | ")}`,
      );
    } finally {
      await C.close();
    }
  },
);

mwTest(
  "per-window keys: a new window starts from the main window, then keeps its own; theme and text size show live",
  async (lab) => {
    const A = lab.page;
    // the main window's layout: a wider chat list
    await A.eval(
      `localStorage.setItem('studio-layout-v1:<1400', JSON.stringify({ side: 300 })); localStorage.setItem('aib-sidebar-mode', 'chats')`,
    );
    await reload(A);
    const sideW = (p: Page) =>
      p.eval<string>(
        `getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim()`,
      );
    const aSide = await sideW(A);
    assertEquals(aSide, "300px");
    const B = await openWindow(lab, `?w=w2&kind=project&project=zz-b`);
    try {
      assertEquals(
        await sideW(B),
        "300px",
        "first run: B starts from the main window",
      );
      assertEquals(
        await ls(B, "studio-layout-v1:<1400:w2"),
        JSON.stringify({ side: 300 }),
      );
      // B's own widths and switches (as its drag and its Chats | Files switch save them)
      await B.eval(
        `localStorage.setItem('studio-layout-v1:<1400:w2', JSON.stringify({ side: 220, viewer: 500 }))`,
      );
      await B.eval(`AgentFilesUI.setMode('files')`);
      await reload(B);
      assertEquals(await sideW(B), "220px");
      assertEquals(await ls(B, "aib-sidebar-mode:w2"), "files");
      assertEquals(
        await ls(A, "aib-sidebar-mode"),
        "chats",
        "B's switch is not A's",
      );
      await reload(A);
      assertEquals(
        await sideW(A),
        aSide,
        "A's chat list width is exactly as it was",
      );
      assertEquals(await A.eval(`AgentFilesUI.mode()`), "chats");
      assertEquals(
        await ls(A, "studio-layout-v1:<1400"),
        JSON.stringify({ side: 300 }),
      );

      // a theme picked in A shows in B at once (no reload)
      const next = await A.eval<string>(
        `AibThemes.THEMES.map((t) => t.id).find((id) => id !== document.documentElement.getAttribute('data-theme'))`,
      );
      await A.eval(`AibThemes.choose(${JSON.stringify(next)})`);
      await B.waitFor(
        `document.documentElement.getAttribute('data-theme') === ${
          JSON.stringify(next)
        }`,
        5000,
        "theme in B",
      );
      // the text size is one setting (per width bucket) for every window: a change in A shows in B
      const before = await B.eval<number>(`AgentTextSize.getChat()`);
      await A.eval(`AgentTextSize.bigger('chat')`);
      await B.waitFor(
        `AgentTextSize.getChat() !== ${before}`,
        5000,
        "text size in B",
      );
      assertEquals(
        await B.eval(`AgentTextSize.getChat()`),
        await A.eval(`AgentTextSize.getChat()`),
      );
      assert(
        B.errors.length === 0,
        `console errors in B: ${B.errors.join(" | ")}`,
      );
    } finally {
      await B.close();
    }
  },
);
