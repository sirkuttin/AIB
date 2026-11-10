/**
 * The page's view and appearance preferences in the state folder (state/view_prefs.ts): the store, the data block in chat.html and
 * POST /api/live/view-prefs behind the page gate. The page half (view-prefs.js) is tested in work/test_view_prefs.js.
 */
import { assert, assertEquals, assertRejects } from "./_assert.ts";
import { ViewPrefs } from "../../outputs/agent-studio/server/state/view_prefs.ts";
import {
  makeContext,
  WebServer,
  withViewPrefs,
} from "../../outputs/agent-studio/server/web/server.ts";
import { ValueError } from "../../outputs/agent-studio/server/core/py.ts";
import type { LiveBackend } from "../../outputs/agent-studio/server/host/backend.ts";
import type { UpdateService } from "../../outputs/agent-studio/server/desktop/updater.ts";
import type { Source } from "../../outputs/agent-studio/server/transcripts/monitor.ts";

const sep = Deno.build.os === "windows" ? "\\" : "/";

Deno.test("view prefs: saved in studio-view.json, read back by a new store, null removes, invalid patches change nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aib-view-" });
  try {
    const store = new ViewPrefs(dir);
    assertEquals(store.public().prefs, {});
    assertEquals(
      await store.update({
        set: {
          "studio-workspace-v1": '{"active":"all"}',
          "studio-textsize-v1:<1800": '{"chat":120}',
        },
      }),
      true,
    );
    assertEquals(
      await store.update({
        set: { "studio-workspace-v1": '{"active":"all"}' },
      }),
      false,
      "no change, no save",
    );
    const again = new ViewPrefs(dir);
    assertEquals(again.public().prefs, {
      "studio-workspace-v1": '{"active":"all"}',
      "studio-textsize-v1:<1800": '{"chat":120}',
    });
    await again.update({ set: { "studio-textsize-v1:<1800": null } });
    assertEquals(store.public().prefs, {
      "studio-workspace-v1": '{"active":"all"}',
    }, "another instance sees the file change");
    const file = JSON.parse(
      Deno.readTextFileSync(`${dir}${sep}studio-view.json`),
    );
    assertEquals([file.version, file.prefs], [1, {
      "studio-workspace-v1": '{"active":"all"}',
    }]);
    for (
      const bad of [
        null,
        {},
        { set: "x" },
        { set: { "not-ours": "1" } },
        { set: { "studio-x": 5 } },
        { set: { "studio-x": "ok", "../evil": "x" } },
        { set: { "studio-x": "x".repeat(ViewPrefs.MAX_VALUE + 1) } },
      ]
    ) await assertRejects(() => store.update(bad), ValueError);
    assertEquals(store.public().prefs, {
      "studio-workspace-v1": '{"active":"all"}',
    });
    // the total size is capped too
    const big = "x".repeat(ViewPrefs.MAX_VALUE);
    const many: Record<string, string> = {};
    for (let i = 0; i < 5; i++) many[`studio-big-${i}`] = big;
    await assertRejects(() => store.update({ set: many }), ValueError);
    // a corrupt file is set aside, not fatal
    Deno.writeTextFileSync(`${dir}${sep}studio-view.json`, "{nope");
    assertEquals(new ViewPrefs(dir).public().prefs, {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("view prefs: no state folder keeps them in memory only", async () => {
  const store = new ViewPrefs(null);
  await store.update({ set: { "studio-side-hidden": "1" } });
  assertEquals(store.public().prefs, { "studio-side-hidden": "1" });
});

Deno.test("chat.html carries the saved values in a JSON data block that no value can break out of", () => {
  const html = "<html><head><title>x</title></head><body></body></html>";
  const out = withViewPrefs(html, {
    "studio-conversation-names": '{"a":"</script><script>alert(1)</script>"}',
  });
  const m = out.match(
    /<script type="application\/json" id="aibViewPrefs">([\s\S]*?)<\/script><\/head>/,
  );
  assert(m, out);
  assert(!m[1].includes("<"), "every < is escaped");
  assertEquals(
    JSON.parse(m[1]).prefs["studio-conversation-names"],
    '{"a":"</script><script>alert(1)</script>"}',
  );
  assertEquals(withViewPrefs("<p>no head</p>", { a: "1" }), "<p>no head</p>");
});

Deno.test("the web server: chat.html has the saved values, POST /api/live/view-prefs saves behind the page gate", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "aib-view-web-" });
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
  let port = 0;
  for (let p = 8871; p <= 8889 && !port; p++) {
    try {
      port = await server.listen(p);
    } catch {
      /* in use: try the next one */
    }
  }
  assert(port, "no free port in 8871-8889");
  const origin = `http://127.0.0.1:${port}`;
  const post = (
    body: unknown,
    headers: Record<string, string> = {
      "X-Studio-Token": ctx.token,
      Origin: origin,
    },
  ) =>
    fetch(`${origin}/api/live/view-prefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    let r = await post({
      set: { "studio-workspace-v1": '{"v":1,"active":"all"}' },
    });
    assertEquals(r.status, 200);
    assertEquals((await r.json()).ok, true);
    r = await post({ set: { "studio-side-hidden": "1" } }, { Origin: origin });
    assertEquals(r.status, 403, "the page token is required");
    await r.body?.cancel();
    r = await post({ set: { "studio-side-hidden": "1" } }, {
      "X-Studio-Token": ctx.token,
      Origin: "http://evil.example",
    });
    assertEquals(r.status, 403, "another origin is refused");
    await r.body?.cancel();
    r = await post({ set: { nope: "1" } });
    assertEquals(r.status, 400);
    await r.body?.cancel();
    const page = await (await fetch(`${origin}/`)).text();
    const m = page.match(
      /<script type="application\/json" id="aibViewPrefs">([\s\S]*?)<\/script>/,
    );
    assert(m, "the data block is in the page");
    assertEquals(JSON.parse(m[1]).prefs, {
      "studio-workspace-v1": '{"v":1,"active":"all"}',
    });
    assert(page.indexOf('id="aibViewPrefs"') < page.indexOf("</head>"));
    assert(
      Deno.statSync(`${stateDir}${sep}studio-view.json`).isFile,
      "kept in the state folder",
    );
  } finally {
    await server.close();
    await Deno.remove(stateDir, { recursive: true }).catch(() => {});
  }
});
