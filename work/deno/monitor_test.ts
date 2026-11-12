/**
 * server/transcripts/monitor.ts: the cases of the Python tests that exercise monitor.py (test_history_paging, test_history_cache,
 * test_subagent_history, test_subagent_roster, test_transcript_images, test_tool_images, test_plan_context, test_monitor_processes,
 * test_titles, test_project_cwd, test_portability, test_pending_settings, test_worktree_sync), plus parity of the pure functions
 * with Python over a corpus. The HTTP-level golden comparison is monitor_golden_test.ts.
 */
import { assert, assertEquals, assertRejects } from "./_assert.ts";
import { PyParity } from "./_parity.ts";
import * as m from "../../outputs/agent-studio/server/transcripts/monitor.ts";
import {
  join,
  WINDOWS,
} from "../../outputs/agent-studio/server/transcripts/purepath.ts";
import {
  b64decodeStrict,
  isoTimestamp,
  parseQs,
  pyInt,
  pyTitle,
  splitlines,
} from "../../outputs/agent-studio/server/transcripts/pycompat.ts";
import { parseNotice } from "../../outputs/agent-studio/server/transcripts/xml_notice.ts";
import { ValueError } from "../../outputs/agent-studio/server/core/py.ts";
import * as fx from "./_monitor_fixtures.ts";

const py = new PyParity();
const enc = new TextEncoder();
const made: string[] = [];
const tmp = (prefix: string) => {
  const dir = Deno.makeTempDirSync({ prefix: `aib-monitor-${prefix}-` });
  made.push(dir);
  return dir;
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const users = (events: m.Event[]) =>
  events.filter((e) => e.kind === "user" && String(e.text).startsWith("MSG-"))
    .map((e) => e.text);
const expectUsers = Array.from(
  { length: 420 },
  (_, i) => `MSG-${String(i + 1).padStart(3, "0")} user`,
);

// ---- test_history_paging ----

Deno.test("paging: every row of a big file becomes an event; a last record without a newline is kept", async () => {
  const root = tmp("paging");
  const path = join(root, "enc", "sess.jsonl");
  const rows = fx.pagingRows();
  fx.write(path, fx.lines(rows));
  const store = await m.Store.open(root);
  assertEquals(users((await store.load(path)).events), expectUsers);
  fx.write(path, fx.lines(rows, false));
  const store2 = await m.Store.open(root);
  let events = (await store2.load(path)).events;
  assertEquals(
    events.length,
    rows.length,
    "total must match the number of rows",
  );
  assertEquals(events[events.length - 1].text, "MSG-420 reply");
  const more = fx.pagingRows(422).slice(rows.length);
  fx.write(path, fx.lines(rows, false) + "\n" + fx.lines(more));
  events = (await store2.load(path)).events;
  assertEquals(events.length, rows.length + more.length);
});

Deno.test("paging: a file growing in odd pieces matches a whole read; a larger replacement is read from its start", async () => {
  const root = tmp("grow");
  const path = join(root, "enc", "sess.jsonl");
  const store = await m.Store.open(root);
  const blob = enc.encode(fx.lines(fx.pagingRows(), false));
  let transcript: m.Transcript | null = null;
  for (let pos = 0; pos < blob.length;) {
    pos = Math.min(blob.length, pos + 997 * 7);
    fx.write(path, blob.subarray(0, pos));
    transcript = await store.load(path);
  }
  const whole = await new m.Transcript(path).refresh();
  assertEquals(
    transcript!.events.map((e) => e.id),
    whole.events.map((e) => e.id),
  );
  assertEquals(users(transcript!.events), expectUsers);
  fx.write(path, fx.lines(fx.pagingRows(120, "old")));
  assertEquals((await store.load(path)).events.length, 480);
  fx.write(
    path,
    fx.pagingRows().map((r) => JSON.stringify(r).replace('"role"', '"role" '))
      .join("\n") + "\n",
  );
  const events = (await store.load(path)).events;
  assertEquals(events.length, 1680);
  assertEquals(users(events), expectUsers);
});

Deno.test("paging: paging back through the handler shows every message once", async () => {
  const root = tmp("pageback");
  fx.writeRows(join(root, "enc", "sess.jsonl"), fx.pagingRows());
  const catalog = await m.Catalog.open(null, root);
  const get = async (query: string) =>
    (await m.handleGet(
      catalog,
      "/api/transcript",
      "key=claude/enc/sess.jsonl&limit=120&thinking=0" + query,
    )).body as Record<
      string,
      unknown
    >;
  let page = await get("");
  assertEquals(page.total, 1680);
  let seen = page.events as m.Event[];
  let start = page.before as number;
  const befores: number[] = [];
  while (start > 0) {
    befores.push(start);
    page = await get(`&before=${start}`);
    assertEquals(
      page.end,
      start,
      "an older page ends exactly where the loaded window starts",
    );
    seen = [...(page.events as m.Event[]), ...seen];
    start = page.before as number;
  }
  assertEquals(befores.slice(0, 3), [1560, 1440, 1320]);
  assertEquals(
    new Set(seen.map((e) => e.id)).size,
    1680,
    "no duplicates at page boundaries",
  );
  assertEquals(users(seen), expectUsers);
});

// ---- test_history_cache ----

Deno.test("cache: a 131-transcript family fits the budget and polls do not re-parse", async () => {
  const root = tmp("family");
  fx.cacheFamily(root, 130);
  const store = await m.Store.open(root);
  await m.commandList(store, "proj/chat.jsonl");
  assertEquals(store.cache.size, 131);
  assert(store.cache.has("proj/chat.jsonl"));
  const before = m.Transcript.parses;
  store.commandMemo.clear();
  await m.commandList(store, "proj/chat.jsonl");
  assertEquals(m.Transcript.parses, before);
});

Deno.test("cache: least recently used goes first, never the one in use; hold pins a family", async () => {
  const root = tmp("lru");
  for (let n = 0; n < 5; n++) {
    fx.writeRows(join(root, "p", `c${n}.jsonl`), fx.cacheRows(`c${n}`, 3));
  }
  const store = await m.Store.open(root);
  for (let n = 0; n < 5; n++) {
    await store.load(await store.resolve(`p/c${n}.jsonl`));
  }
  const one = store.sizes.get("p/c0.jsonl")!;
  await store.load(await store.resolve("p/c0.jsonl"));
  store.budget = one * 3 + 10;
  await store.load(await store.resolve("p/c4.jsonl"));
  assertEquals(store.cache.size, 3);
  assertEquals([...store.cache.keys()].slice(-2), ["p/c0.jsonl", "p/c4.jsonl"]);
  store.budget = 1;
  const t = await store.load(await store.resolve("p/c2.jsonl"));
  assertEquals([...store.cache.keys()], ["p/c2.jsonl"]);
  assert(t.events.length);
  const held = await m.Store.open(root);
  held.budget = 1;
  await held.hold(["p/c0.jsonl", "p/c1.jsonl", "p/c2.jsonl"], async () => {
    for (let n = 0; n < 3; n++) {
      await held.load(await held.resolve(`p/c${n}.jsonl`));
    }
    assertEquals(held.cache.size, 3);
  });
  assert(held.cache.size <= 1);
});

Deno.test("cache: refresh stays incremental; an unchanged file is not re-read", async () => {
  const root = tmp("incr");
  const path = fx.cacheFamily(root, 0);
  const store = await m.Store.open(root);
  const t = await store.load(path);
  const count = t.events.length;
  const offset = t.offset;
  const marks = t.planMarks;
  const parses = m.Transcript.parses;
  await store.load(path);
  assertEquals(m.Transcript.parses, parses);
  assert(t.planMarks === marks, "polling does not rebuild the marks");
  Deno.writeTextFileSync(
    path,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "more" },
    }) + "\n",
    { append: true },
  );
  const t2 = await store.load(path);
  assert(t === t2);
  assertEquals(t2.events.length, count + 1);
  assert(t2.offset > offset);
});

Deno.test("cache: command list is memoised until a file changes; agents and commands share one pass", async () => {
  const root = tmp("memo");
  fx.cacheFamily(root, 60, 40);
  const store = await m.Store.open(root);
  const first = await m.commandList(store, "proj/chat.jsonl");
  const parses = m.Transcript.parses;
  const second = await m.commandList(store, "proj/chat.jsonl");
  assertEquals(m.Transcript.parses, parses);
  assertEquals(plain(first), plain(second));
  assertEquals(first.length, 61 * 40);
  Deno.writeTextFileSync(
    join(root, "proj", "chat", "subagents", "agent-a000.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "new",
          name: "Bash",
          input: { command: "x", run_in_background: true },
        }],
      },
    }) + "\n",
    { append: true },
  );
  assertEquals(
    (await m.commandList(store, "proj/chat.jsonl")).length,
    61 * 40 + 1,
  );
  const small = tmp("memo2");
  fx.cacheFamily(small, 5);
  const viewer = await m.openSource(small);
  await m.handleGet(viewer, "/api/agents", "session=proj/chat.jsonl");
  const p = m.Transcript.parses;
  const commands =
    (await m.handleGet(viewer, "/api/commands", "session=proj/chat.jsonl"))
      .body as Record<string, unknown>;
  assertEquals(m.Transcript.parses, p);
  assertEquals(commands.total, 18);
});

Deno.test("cache: a big parse does not block another chat, and one file is parsed once by concurrent loads", async () => {
  const root = tmp("block");
  fx.writeRows(join(root, "proj", "big.jsonl"), fx.pagingRows(3000));
  fx.cacheFamily(root, 0, 3, "small");
  const store = await m.Store.open(root);
  let bigDone = false;
  const big = store.load(join(root, "proj", "big.jsonl")).then(
    () => (bigDone = true),
  );
  const small = await m.handleGet(
    store,
    "/api/transcript",
    "key=proj/small.jsonl",
  );
  assert(((small.body as Record<string, unknown>).events as unknown[]).length);
  assert(
    !bigDone,
    "the small chat answered while the big parse was still running",
  );
  await big;
  const other = await m.Store.open(root);
  const before = m.Transcript.parses;
  await Promise.all(
    Array.from(
      { length: 6 },
      () => other.load(join(root, "proj", "big.jsonl")),
    ),
  );
  assertEquals(m.Transcript.parses - before, 1);
});

Deno.test("skipped rows: known row starts only, never one carrying a task-notification", () => {
  assert(
    m.skippableRow(enc.encode('{"type":"api-request-blob","message":{}}\n')),
  );
  assert(m.skippableRow(enc.encode('{"type": "file-history-snapshot"}\n')));
  assert(
    m.skippableRow(
      enc.encode('  { "type" : "file-history-snapshot", "x": 1}\n'),
    ),
  );
  assert(!m.skippableRow(enc.encode('{"type":"user","message":{}}\n')));
  assert(
    !m.skippableRow(
      enc.encode('{"type":"api-request-blob","m":"<task-notification>"}\n'),
    ),
  );
  assert(
    !m.skippableRow(enc.encode('{"message":1,"type":"api-request-blob"}\n')),
  );
  assert(
    !m.skippableRow(enc.encode(" ".repeat(80) + '{"type":"api-request-blob"}')),
    "the start must be within the first 96 bytes",
  );
});

Deno.test("skipped rows: a notice inside a snapshot still completes its command (parity with Python)", async () => {
  const root = tmp("skip");
  const path = join(root, "a.jsonl");
  const notice =
    "<task-notification><task-id>fx1j0</task-id><tool-use-id>fx1-c0</tool-use-id><status>completed</status><summary>Done</summary></task-notification>";
  fx.write(
    path,
    fx.lines(fx.cacheRows("fx1", 4, true, notice)) +
      '{ "type" : "file-history-snapshot", "x": 1}\n{"type":"api-request-blob"\n' +
      JSON.stringify({
        type: "user",
        message: { role: "user", content: 'quote "type":"api-request-blob"' },
        extra: { type: "api-request-blob" },
      }) + "\n",
  );
  const t = await new m.Transcript(path).refresh();
  assertEquals(
    [...t.commands.values()].filter((c) => c.status === "completed").length,
    1,
  );
  assert(t.events.some((e) => String(e.text).startsWith("quote")));
  const snap = await py.call("monitor_shim", "snapshot", [path]) as Record<
    string,
    unknown
  >;
  assertEquals(
    plain({
      events: t.events,
      commands: [...t.commands.values()],
      meta: t.meta,
      number: t.number,
      offset: t.offset,
    }),
    {
      events: snap.events,
      commands: snap.commands,
      meta: snap.meta,
      number: snap.number,
      offset: snap.offset,
    },
  );
});

// ---- test_subagent_history / test_subagent_roster ----

async function subagents() {
  const claude = join(tmp("subs"), "claude");
  fx.subagentFixtures(claude);
  return await m.Catalog.open(null, claude);
}

Deno.test("subagents: sidecar links, per-agent running commands, transcripts for subagent keys", async () => {
  const catalog = await subagents();
  const session = "claude/enc/sess.jsonl";
  const byId = Object.fromEntries(
    (await catalog.agents(session)).filter((a) => !a.main).map((
      a,
    ) => [a.agentId, a]),
  );
  assertEquals([byId.bbb.parentAgentId, byId.bbb.toolUseId], [
    "aaa",
    "toolu_9",
  ]);
  assertEquals(byId.aaa.parentAgentId, "");
  assertEquals(await m.runningByAgent(catalog, session), {
    [byId.aaa.key as string]: 1,
  });
  const task = (await m.commandList(catalog, session))[0];
  assertEquals([task.agentKey, task.agent], [byId.aaa.key, "Parent"]);
  const agents =
    ((await m.handleGet(catalog, "/api/agents", "session=" + session)).body as {
      agents: m.Dict[];
    }).agents;
  const http = Object.fromEntries(
    agents.filter((a) => !a.main).map((a) => [a.agentId, a]),
  );
  assertEquals([http.aaa.runningCommands, http.bbb.runningCommands], [1, 0]);
  const data = (await m.handleGet(
    catalog,
    "/api/transcript",
    `key=${encodeURIComponent(http.bbb.key as string)}&thinking=0`,
  ))
    .body as m.Dict;
  assert(JSON.stringify(data.events).includes("Child says hello"));
  assertEquals(data.total, (data.events as unknown[]).length);
});

Deno.test("subagents: names, first-prompt fallback, failure and completion markers", async () => {
  const catalog = await subagents();
  const by = Object.fromEntries(
    (await catalog.agents("claude/ros/sess.jsonl")).filter((a) => !a.main).map((
      a,
    ) => [a.agentId, a]),
  );
  assertEquals([
    by.aaa.name,
    splitlines(by.aaa.firstPrompt as string)[0],
    by.aaa.completedMarker,
    by.aaa.failed,
  ], [
    "Audit the importer",
    "Audit the importer",
    true,
    false,
  ]);
  assert(by.bbb.failed);
  assertEquals(by.ccc.name, "Still going");
  assertEquals(by.ccc.completedMarker, false);
  assertEquals([by.ddd.name, by.ddd.agentType, by.ddd.agentId, by.ddd.failed], [
    "W3c HUD 16:9",
    "general-purpose",
    "ddd",
    true,
  ]);
  assertEquals([by.zzz.name, by.zzz.firstPrompt, by.zzz.depth], ["zzz", "", 3]);
  assertEquals(
    by.eee.name,
    "With a BOM sidecar",
    "a sidecar with a BOM is not JSON to Python either",
  );
});

// ---- test_transcript_images / test_tool_images ----

const PNG = fx.PNG;
const image = (media = "image/png", data = PNG) => ({
  type: "image",
  source: { type: "base64", media_type: media, data },
});
const claudeUser = (...blocks: unknown[]) => ({
  type: "user",
  timestamp: "2026-11-08T15:00:00Z",
  message: { role: "user", content: blocks },
});
const toolResult = (content: unknown) => ({
  type: "user",
  timestamp: "2026-11-08T15:00:00Z",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content }],
  },
});

Deno.test("images: a picture hangs on its message text, alone it is its own row, unsupported types get a note", () => {
  let events = m.normalize(
    claudeUser(image(), { type: "text", text: "look at this" }, {
      type: "text",
      text: "[Image: source: C:\\t\\16.png]",
    }),
    7,
  );
  assertEquals(events.length, 1);
  assertEquals([events[0].text, events[0].images], ["look at this", [{
    n: 7,
    i: 0,
    mediaType: "image/png",
  }]]);
  assert(!JSON.stringify(events).includes("data"));
  events = m.normalize(claudeUser(image(), image("image/jpeg")), 3);
  assertEquals(events.map((e) => (e.images as m.Dict[])[0].i), [0, 1]);
  assert(events.every((e) => e.text === ""));
  assertEquals(
    (m.normalize({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "image", mimeType: "image/webp", data: PNG }],
      },
    }, 1)[0]
      .images as m.Dict[])[0].mediaType,
    "image/webp",
  );
  events = m.normalize(claudeUser(image("image/svg+xml")), 1);
  assert(
    !("images" in events[0]) &&
      String(events[0].text).includes("could not be shown"),
  );
  assert(m.IMAGE_REF.test("[Image #1] [Image #2]"));
  assert(!m.IMAGE_REF.test("see [Image #1]"));
  assertEquals(
    m.normalize(claudeUser({ type: "text", text: "see [Image #1] here" }), 1)[0]
      .text,
    "see [Image #1] here",
  );
});

Deno.test("images: a message sent mid-turn is a user message with its picture; other attachments are not", () => {
  const row = {
    type: "attachment",
    timestamp: "2026-11-08T22:21:34Z",
    attachment: {
      type: "queued_command",
      commandMode: "prompt",
      prompt: [image(), { type: "text", text: "we missed a message?" }],
    },
  };
  const events = m.normalize(row, 5);
  assertEquals(events.map((e) => [e.kind, e.text]), [[
    "user",
    "we missed a message?",
  ]]);
  assertEquals((events[0].images as m.Dict[])[0].n, 5);
  assertEquals(
    m.normalize({
      type: "attachment",
      attachment: { type: "queued_command", prompt: "one more thing" },
    }, 1)[0].text,
    "one more thing",
  );
  assertEquals(
    m.normalize({
      type: "attachment",
      attachment: { type: "queued_command", commandMode: "bash", prompt: "ls" },
    }, 1),
    [],
  );
  assertEquals(
    m.normalize({
      type: "attachment",
      attachment: { type: "file", prompt: "x" },
    }, 1),
    [],
  );
});

Deno.test("images: tool results carry addresses, not data, and are served on demand with j", async () => {
  const events = m.normalize(
    toolResult([{ type: "text", text: "Took a screenshot" }, image(), {
      type: "image",
      mimeType: "image/jpeg",
      data: PNG,
    }]),
    4,
  );
  assertEquals(events[0].images, [
    { n: 4, i: 0, j: 1, mediaType: "image/png" },
    { n: 4, i: 0, j: 2, mediaType: "image/jpeg" },
  ]);
  assert(!JSON.stringify(events).includes(PNG));
  assert(
    !("images" in m.normalize(toolResult([image("image/svg+xml")]), 1)[0]),
  );
  assert(!("images" in m.normalize(toolResult("plain"), 1)[0]));
  const root = tmp("toolimg");
  const path = fx.writeRows(join(root, "s.jsonl"), [
    toolResult([{ type: "text", text: "x" }, image()]),
  ]);
  const t = await (await m.Store.open(root)).load(path);
  assertEquals((t.events[0].images as m.Dict[])[0].j, 1);
  const [media, raw] = await t.image(1, 0, 1);
  assertEquals([media, raw.slice(0, 4)], [
    "image/png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  ]);
  for (const [n, i, j] of [[1, 0, 0], [1, 0, 5], [1, 0, null]] as const) {
    await assertRejects(() => t.image(n, i, j), ValueError);
  }
});

Deno.test("images: bytes are served, unknown addresses refused, offsets survive appends", async () => {
  const root = tmp("img");
  const path = fx.writeRows(join(root, "p", "s.jsonl"), [
    claudeUser({ type: "text", text: "hi" }),
    claudeUser(image(), { type: "text", text: "shot" }),
    {
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: [image("image/webp"), { type: "text", text: "later" }],
      },
    },
  ]);
  const store = await m.Store.open(root);
  let t = await store.load(path);
  const ref = (t.events.find((e) => e.images)!.images as m.Dict[])[0] as {
    n: number;
    i: number;
  };
  const late =
    (t.events.find((e) => e.text === "later")!.images as m.Dict[])[0] as {
      n: number;
      i: number;
    };
  assertEquals((await t.image(late.n, late.i))[0], "image/webp");
  assertEquals((await t.image(ref.n, ref.i))[0], "image/png");
  await assertRejects(() => t.image(1, 0), ValueError);
  await assertRejects(() => t.image(ref.n, 1), ValueError);
  Deno.writeTextFileSync(
    path,
    JSON.stringify(claudeUser(image("image/gif"))) + "\n",
    { append: true },
  );
  t = await store.load(path);
  const refs = t.events.flatMap((e) =>
    (e.images ?? []) as { n: number; i: number }[]
  );
  assertEquals(
    await Promise.all(refs.map(async (r) => (await t.image(r.n, r.i))[0])),
    ["image/png", "image/webp", "image/gif"],
  );
});

// ---- test_plan_context ----

async function planned() {
  const folder = tmp("plan");
  const paths = fx.planFixtures(folder);
  const out: Record<string, m.Transcript> = {};
  for (const [name, path] of Object.entries(paths)) {
    out[name] = await new m.Transcript(path).refresh();
  }
  return { out, paths };
}

Deno.test("plan context: the older plan comes back marked ctx; stops where the page begins; latest plan only", async () => {
  const { out } = await planned();
  let t = out.older;
  let ctx = t.planContext(t.events.length - 120);
  assertEquals(ctx.filter((e) => e.kind === "tool").map((e) => e.label), [
    "mcp__ccd_turn__update_plan",
  ]);
  assert(ctx.every((e) => e.ctx));
  assertEquals(ctx[0].kind, "user");
  assert(!JSON.stringify(ctx).includes("step"));
  t = out.stops;
  assertEquals(t.planContext(1).map((e) => e.kind), []);
  assertEquals(t.planContext(2).map((e) => e.kind), ["user", "tool"]);
  assertEquals(t.planContext(0), []);
  t = out.latest;
  ctx = t.planContext(t.events.length);
  assertEquals(ctx.filter((e) => e.kind === "tool").length, 3);
  assert(!JSON.stringify(ctx).includes('"A"'));
  assertEquals(ctx.filter((e) => e.kind === "user").map((e) => e.text), [""]);
});

Deno.test("plan context: background launches and finishes, earlier turns, thinking positions, no plan", async () => {
  const { out } = await planned();
  let ctx = out.background.planContext(out.background.events.length);
  assertEquals(ctx.map((e) => e.kind), [
    "user",
    "tool",
    "tool",
    "result",
    "tool",
    "result",
    "task-done",
  ]);
  assertEquals(ctx[2].text, '{"run_in_background": true}');
  assertEquals(ctx[ctx.length - 1].text, "bx1");
  assert(
    JSON.stringify(out.earlier.planContext(out.earlier.events.length)).includes(
      "bx1",
    ),
  );
  assert(
    !JSON.stringify(out.late.planContext(out.late.events.length)).includes(
      "Command running",
    ),
  );
  assertEquals(out.noplan.planContext(20), []);
  const t = out.thinking;
  const visible = t.events.filter((e) => e.kind !== "thinking");
  const at = visible.findIndex((e) => e.kind === "tool") + 1;
  assertEquals(t.planContext(at, true).map((e) => e.kind), ["user", "tool"]);
  assertEquals(t.planContext(at - 1, true).map((e) => e.kind), []);
  assertEquals(t.planContext(at + 2, false).map((e) => e.kind), [
    "user",
    "tool",
  ]);
  ctx = out.todo.planContext(out.todo.events.length - 100);
  assert(ctx.length > 0);
});

Deno.test("plan context: parity with Python at every page start", async () => {
  const { out, paths } = await planned();
  for (const [name, t] of Object.entries(out)) {
    for (const hidden of [false, true]) {
      for (
        let start = 0;
        start <= t.events.length;
        start += Math.max(1, Math.floor(t.events.length / 25))
      ) {
        assertEquals(
          plain(t.planContext(start, hidden)),
          await py.call("monitor_shim", "plan_context", [
            paths[name],
            start,
            hidden,
          ]),
          `${name} ${start} ${hidden}`,
        );
      }
    }
  }
});

Deno.test("plan context: marks follow appended lines and a rewritten file", async () => {
  const path = join(tmp("marks"), "chat.jsonl");
  const user = (text: string, n: number) => ({
    type: "user",
    timestamp: `2026-11-08T15:0${n}:00Z`,
    message: { role: "user", content: text },
  });
  fx.write(path, fx.lines([user("go", 0), fx.PLAN]));
  const t = await new m.Transcript(path).refresh();
  assertEquals(t.planMarks.length, 2);
  Deno.writeTextFileSync(path, JSON.stringify(user("again", 5)) + "\n", {
    append: true,
  });
  await t.refresh();
  assertEquals(t.planMarks.map(([, mark]) => mark), ["user", "set", "user"]);
  fx.write(path, fx.lines([user("fresh", 0)]), -3);
  await t.refresh();
  assertEquals(t.planMarks.map(([, mark]) => mark), ["user"]);
});

// ---- test_monitor_processes ----

Deno.test("processes: monitors and background commands are listed and leave when they end", async () => {
  const claude = join(tmp("proc"), "claude");
  fx.processFixtures(claude);
  const catalog = await m.Catalog.open(join(claude, "..", "omp"), claude);
  const list = async (name: string) => {
    const session = `claude/${name}/sess.jsonl`;
    return [
      await m.commandList(catalog, session),
      await m.runningByAgent(catalog, session),
    ] as const;
  };
  const sum = (counts: Record<string, number>) =>
    Object.values(counts).reduce((a, b) => a + b, 0);
  let [tasks, counts] = await list("monitorRunning");
  assertEquals(tasks.map((t) => [t.title, t.status, t.jobId]), [[
    "full Python suite finish",
    "running",
    "bo91",
  ]]);
  assertEquals(sum(counts), 1);
  [tasks, counts] = await list("monitorDone");
  assertEquals([tasks.map((t) => t.status), counts], [["completed"], {}]);
  [tasks, counts] = await list("bashRunning");
  assertEquals(
    tasks.map((
      t,
    ) => [t.status, String(t.agentKey).endsWith("agent-a1.jsonl"), t.title]),
    [[
      "running",
      true,
      "cd C:\\x && python -m unittest",
    ]],
  );
  [tasks, counts] = await list("bashDone");
  assertEquals([tasks.map((t) => t.status), counts], [["completed"], {}]);
  [tasks, counts] = await list("stopped");
  assertEquals([tasks.map((t) => t.status), counts], [["killed"], {}]);
  [tasks] = await list("stoppedNotice");
  assertEquals(tasks.map((t) => t.status), ["killed"]);
  [tasks, counts] = await list("counts");
  assertEquals(
    tasks.filter((t) => t.status === "running").map((t) => t.title).sort(),
    ["one", "python deploy.py", "z"],
  );
  assertEquals(sum(counts), 3);
  [tasks, counts] = await list("expired");
  assertEquals(Object.fromEntries(tasks.map((t) => [t.title, t.status])), {
    old: "completed",
    fresh: "running",
  });
  assertEquals(sum(counts), 1);
  [tasks] = await list("expiryFallback");
  assertEquals(Object.fromEntries(tasks.map((t) => [t.title, t.status])), {
    "by timeout": "completed",
    compound: "completed",
  });
  [tasks] = await list("persistent");
  assertEquals(Object.fromEntries(tasks.map((t) => [t.title, t.status])), {
    young: "running",
    aged: "completed",
  });
  [tasks] = await list("finishedSidecar");
  assertEquals(tasks.map((t) => t.status).sort(), ["completed", "completed"]);
  [tasks, counts] = await list("killedByMain");
  assertEquals([tasks.map((t) => t.status), counts], [[
    "completed",
    "completed",
  ], {}]);
  [tasks] = await list("quiet");
  assertEquals(tasks.map((t) => t.status), ["completed"]);
  [tasks, counts] = await list("mainMonitor");
  assertEquals([tasks.map((t) => t.status), counts], [["completed"], {}]);
});

// ---- test_titles ----

const REMINDER = fx.REMINDER;
const CONTINUED = fx.CONTINUED;
const PROMPTS: [string, string][] = [
  [
    "have we actually finished this work? anything left to do?",
    "have we actually finished this work? anything left to do?",
  ],
  [REMINDER + "\nhey i am starting you up", "hey i am starting you up"],
  [REMINDER, ""],
  [
    "<system-reminder>\nCodebase and user instructions are shown below. Be sure to adh",
    "",
  ],
  [
    "<command-message>debug</command-message>\n<command-name>/debug</command-name>\n<command-args>demo MCP server fails to start</command-args>",
    "/debug demo MCP server fails to start",
  ],
  [
    "<command-name>/compact</command-name>\n  <command-message>compact</command-message>\n  <command-args></command-args>",
    "/compact",
  ],
  [
    "<local-command-caveat>The command below was run directly in Claude Code, not sent to you.</local-command-caveat>",
    "",
  ],
  ["<local-command-stdout>Compacted</local-command-stdout>", ""],
  // harness text with a plain-text lead-in is never a title (synthetic shapes of Claude Code's injected turns)
  [
    "<artifact-content-authored-by-others/>\nThe summarized conversation included Artifact content written by people other than you.\n" +
    "This session is being continued from a previous conversation that ran out of context.\n\n<system-reminder>x</system-reminder>\nSummary",
    "",
  ],
  [
    'Another Claude session sent a message:\n<cross-session-message from="local_1" from-name="Lead">Freeze now</cross-session-message>\n\n' +
    "This came from another Claude session.",
    "",
  ],
  ["[SYSTEM NOTIFICATION - NOT USER INPUT]\nAutomated.\n<task-notification><status>completed</status></task-notification>", ""],
  ["[handback-send-enforce] Your report has not been delivered.", ""],
  ["The coordinator sent a message while you were working:\nRun lint.\n\nAddress this before completing your current task.", ""],
  ["<fork-boilerplate>You are a worker fork.</fork-boilerplate>\nCheck slice 2", "Check slice 2"],
  ['Explain "This session is being continued from a previous conversation"', 'Explain "This session is being continued from a previous conversation"'],
  [
    "<task-notification>\n<task-id>bf0og2uoa</task-id>\n<status>completed</status>\n</task-notification>",
    "",
  ],
  [
    "Caveat: The messages below were generated by the user while running local commands.",
    "",
  ],
  [CONTINUED, ""],
  ["[Request interrupted by user for tool use]", ""],
  [
    "<user-prompt-submit-hook>blocked: nope</user-prompt-submit-hook>\nAdd a dark mode toggle",
    "Add a dark mode toggle",
  ],
  [
    "## **Fix** the `parser` bug in [the docs](http://x.test/a)",
    "Fix the parser bug in the docs",
  ],
  ["<img src=x onerror=alert(1)> hostile title", "hostile title"],
  ["- review <b>pull</b> request 41", "review pull request 41"],
  ["  Paste   this\t\tinto   Explorer  ", "Paste this into Explorer"],
  [
    "Fix this:\n\nthe login form crashes on submit",
    "Fix this: the login form crashes on submit",
  ],
  [
    "Explain why the scheduler starves\n\n```\ntraceback...\n```",
    "Explain why the scheduler starves",
  ],
  [
    '<artifact-view-context artifact="https://claude.ai/artifact/x">{"a": 1}\n<artifact-content-authored-by-others/></artifact-view-context>\n\nchat message style. i want option A',
    "chat message style. i want option A",
  ],
  ["plain message", "plain message"],
  [
    "<studio-context>The user changed these files since your last turn: f.txt</studio-context>fix the bug",
    "fix the bug",
  ],
];

Deno.test("titles: clean_prompt cases", () => {
  for (const [raw, title] of PROMPTS) {
    assertEquals(m.cleanPrompt(raw), title, raw.slice(0, 40));
  }
  const long = m.cleanPrompt("word ".repeat(100));
  assert(
    [...long].length <= m.TITLE_LIMIT + 1 && long.endsWith("\u2026") &&
      !long.includes("wor\u2026"),
  );
  for (const value of [null, 5, [], "", "   \n"]) {
    assertEquals(m.cleanPrompt(value), "");
  }
});

Deno.test("titles: card titles from summaries, AI and custom titles, late titles, noise rows", async () => {
  const folder = join(tmp("titles"), "proj");
  fx.titleFixtures(folder);
  const store = await m.Store.open(join(folder, ".."));
  const title = async (i: number) =>
    (await store.summary(join(folder, `t${String(i).padStart(2, "0")}.jsonl`)))
      .title;
  assertEquals(
    await Promise.all(Array.from({ length: 12 }, (_, i) => title(i))),
    [
      "/compact",
      "Refactor the parser",
      "run demo on the exe",
      "Work completion status",
      "Strata setup on PC",
      "Fixing the flaky login test",
      "Login test fix",
      "Triage open bugs",
      "hostile",
      "Late title",
      "Explain the scheduler",
      "",
    ],
  );
});

// ---- test_project_cwd / test_portability ----

Deno.test("project folder: the encoded folder name wins over the last cd, parents match, a middle-of-file folder is found", async () => {
  const root = tmp("cwd");
  fx.projectFixtures(root);
  const store = await m.Store.open(root);
  const cwd = async (p: string) => (await store.summary(join(root, p))).cwd;
  assertEquals(await cwd("C--repo-app/a.jsonl"), "C:\\repo\\app");
  assertEquals(
    (await store.load(join(root, "C--repo-app", "a.jsonl"))).meta.cwd,
    "C:\\repo\\app",
  );
  assert(
    !("_cwds" in await store.summary(join(root, "C--repo-app", "a.jsonl"))),
  );
  assertEquals(await cwd("C--repo-app/b.jsonl"), "C:\\repo\\app");
  assertEquals(await cwd("C--repo-app/c.jsonl"), "C:\\repo\\app");
  Deno.writeTextFileSync(
    join(root, "C--repo-app", "c.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "s",
      message: { role: "user", content: "y".repeat(400000) },
    }) + "\n",
    { append: true },
  );
  assertEquals(await cwd("C--repo-app/c.jsonl"), "C:\\repo\\app");
  if (WINDOWS) assertEquals(await cwd("C--repo-app/d.jsonl"), "C:\\repo\\app");
  assertEquals(await cwd("plain/f.jsonl"), "C:\\elsewhere");
});

Deno.test("project folder: POSIX colons, drive paths, Git Bash paths", () => {
  const cwd = "/home/u/a:b/proj";
  assertEquals(
    m.projectMatch(
      [cwd],
      "/home/u/.claude/projects/" + m.encoded(cwd) + "/s.jsonl",
    ),
    cwd,
  );
  assertEquals(
    m.projectMatch(
      [cwd + "/src:x"],
      "/home/u/.claude/projects/" + m.encoded(cwd) + "/s.jsonl",
    ),
    cwd,
  );
  const win = "C:\\Users\\x\\proj";
  assertEquals(
    m.projectMatch(
      [win],
      "C:/Users/x/.claude/projects/" + m.encoded(win) + "/s.jsonl",
    ),
    win,
  );
  assertEquals(
    m.projectMatch(["C:/Users/x/proj"], "x/" + m.encoded(win) + "/s.jsonl"),
    win,
  );
  if (WINDOWS) {
    assertEquals(
      m.projectMatch(["/c/Users/x/proj"], "x/C--Users-x-proj/s.jsonl"),
      win,
    );
  } else {assertEquals(
      m.projectMatch(["/c/proj"], "x/-c-proj/s.jsonl"),
      "/c/proj",
    );}
});

Deno.test("project folder: mid-turn task notifications become task-done markers; a saved chat has a folder", async () => {
  const root = tmp("notes");
  const note = (id: string, status: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>`;
  const p = fx.write(
    join(root, "C--repo-app", "s.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: "C:\\repo\\app",
      sessionId: "s",
      timestamp: "2026-11-08T10:00:00Z",
      message: { role: "user", content: "hi" },
    }) + "\n" + fx.lines([
      {
        type: "attachment",
        timestamp: "t",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: note("b1", "completed") + note("b2", "running"),
        },
      },
      {
        type: "attachment",
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          prompt: "hi",
        },
      },
    ]),
  );
  const events = (await (await m.Store.open(root)).load(p)).events;
  assertEquals(
    events.filter((e) => e.kind === "task-done").map((e) => [e.kind, e.text]),
    [["task-done", "b1"]],
  );
  assertEquals(events[events.length - 1].kind, "user");
  const base = tmp("saved");
  const project = join(base, "repo-app");
  Deno.mkdirSync(project);
  const folder = project.replaceAll(":", "-").replaceAll("\\", "-").replaceAll(
    "/",
    "-",
  );
  const sid = "11111111-2222-4333-8444-555555555555";
  fx.write(
    join(base, "claude", folder, sid + ".jsonl"),
    JSON.stringify({
      type: "user",
      cwd: project,
      sessionId: "s",
      timestamp: "2026-11-08T10:00:00Z",
      message: { role: "user", content: "hi" },
    }) + "\n",
  );
  const catalog = await m.Catalog.open(join(base, "omp"), join(base, "claude"));
  assertEquals(await catalog.sessionCwd("claude", sid), project);
  assertEquals(await catalog.sessionCwd("claude", "../etc"), "");
  assertEquals(await catalog.sessionCwd("nope", sid), "");
});

// ---- test_pending_settings (model in use) ----

const assistantLine = (model: string, extra: m.Dict = {}, text = "hi") =>
  JSON.stringify({
    type: "assistant",
    message: { model, role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });

Deno.test("model in use: newest real assistant record, half-written tail, OMP provider, wide windows, cache", async () => {
  const dir = tmp("model");
  const w = (name: string, rows: string[], tail = "") =>
    fx.write(join(dir, name), rows.join("\n") + "\n" + tail);
  let path = w("a.jsonl", [
    assistantLine("claude-sonnet-5-5"),
    JSON.stringify({ type: "user", message: { role: "user", content: "q" } }),
    assistantLine("claude-opus-5-5"),
    assistantLine("<synthetic>"),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: { model: "claude-haiku-4-5", role: "assistant" },
    }),
    JSON.stringify({ type: "system", model: "claude-fable-1" }),
  ]);
  assertEquals(await m.latestAssistantModel(path), {
    model: "claude-opus-5-5",
  });
  path = w(
    "b.jsonl",
    [assistantLine("claude-opus-5-5")],
    '{"type":"assistant","message":{"model":"claude-sonnet-5',
  );
  assertEquals((await m.latestAssistantModel(path))!.model, "claude-opus-5-5");
  assertEquals(
    await m.latestAssistantModel(
      w("c.jsonl", [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "q" },
        }),
      ]),
    ),
    null,
  );
  assertEquals(
    await m.latestAssistantModel(fx.write(join(dir, "empty.jsonl"), "")),
    null,
  );
  path = w("d.jsonl", [
    JSON.stringify({ type: "model_change", model: "strata/strata" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        provider: "strata",
        model: "strata",
        content: [],
      },
    }),
  ]);
  assertEquals(await m.latestAssistantModel(path), {
    model: "strata",
    provider: "strata",
  });
  path = w("big.jsonl", [
    assistantLine("claude-sonnet-5-5"),
    assistantLine("claude-opus-5-5", {}, "y".repeat(600_000)),
  ]);
  assertEquals((await m.latestAssistantModel(path))!.model, "claude-opus-5-5");
  path = w("giant.jsonl", [
    assistantLine("claude-sonnet-5-5"),
    assistantLine("claude-opus-5-5", {}, "z".repeat(5_000_000)),
  ]);
  assertEquals(await m.latestAssistantModel(path), null);
  path = w("grow.jsonl", [assistantLine("claude-opus-5-5")]);
  assertEquals((await m.latestAssistantModel(path))!.model, "claude-opus-5-5");
  Deno.writeTextFileSync(path, assistantLine("claude-haiku-4-5") + "\n", {
    append: true,
  });
  assertEquals(
    (await m.latestAssistantModel(path))!.model,
    "claude-haiku-4-5",
    "growth invalidates the cache",
  );
  for (const name of ["a", "b", "c", "d", "big", "giant"]) {
    assertEquals(
      await m.latestAssistantModel(join(dir, name + ".jsonl")),
      await py.call("monitor_shim", "latest_model", [
        join(dir, name + ".jsonl"),
      ]),
      name,
    );
  }
});

Deno.test("model in use: session files by provider and id; hostile ids refused", async () => {
  const dir = tmp("find");
  const claude = fx.write(
    join(dir, "proj", "abc-123.jsonl"),
    assistantLine("claude-opus-5-5") + "\n",
  );
  const omp = fx.write(
    join(dir, "proj", "2026-11-04T07-15-49-840Z_01a1a569-ffd0.jsonl"),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", provider: "p", model: "m" },
    }) + "\n",
  );
  const real = await Deno.realPath(dir);
  assertEquals(
    await m.findSessionFile("claude", dir, "abc-123"),
    join(real, "proj", "abc-123.jsonl"),
  );
  assertEquals(
    await m.findSessionFile("omp", dir, "01a1a569-ffd0"),
    join(real, "proj", "2026-11-04T07-15-49-840Z_01a1a569-ffd0.jsonl"),
  );
  assertEquals(await m.modelInUse("omp", "01a1a569-ffd0", null, dir), {
    model: "m",
    provider: "p",
    source: "transcript",
  });
  assertEquals(
    (await m.modelInUse("claude", "abc-123", dir, null))!.model,
    "claude-opus-5-5",
  );
  for (
    const hostile of [
      "../abc-123",
      "proj/abc-123",
      "..",
      "a*",
      "",
      null,
      "x".repeat(300),
      "a\\b",
      "abc-123\n",
    ]
  ) {
    assertEquals(
      await m.findSessionFile("claude", dir, hostile),
      null,
      String(hostile),
    );
  }
  assertEquals(await m.modelInUse("claude", "missing", dir, null), null);
  assertEquals(await m.modelInUse("devin", "abc-123", dir, dir), null);
  for (
    const [provider, id] of [["claude", "abc-123"], ["omp", "01a1a569-ffd0"], [
      "claude",
      "nope",
    ]]
  ) {
    assertEquals(
      await m.findSessionFile(provider, dir, id),
      await py.call("monitor_shim", "find_file", [provider, dir, id]),
    );
  }
  void claude;
  void omp;
});

// ---- test_worktree_sync: Studio's note never shows ----

Deno.test("studio context is hidden in history and titles", () => {
  const note =
    "<studio-context>The user changed these files since your last turn: f.txt</studio-context>";
  for (
    const content of [
      [{ type: "text", text: note }, { type: "text", text: "hello" }],
      note + "hello",
      [{
        type: "text",
        text: note + "\nhello",
      }],
    ]
  ) {
    assertEquals(
      m.normalize({ type: "message", message: { role: "user", content } }, 1)
        .map((e) => e.text),
      ["hello"],
    );
  }
  assertEquals(
    m.normalize({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: note }] },
    }, 2),
    [],
  );
  assertEquals(m.cleanPrompt(note + "fix the bug"), "fix the bug");
});

// ---- routes ----

Deno.test("ROUTES: the transcript routes and scopes (the monitor page, /api/bootstrap and /api/activity are gone)", async () => {
  const entries = [...m.ROUTES.scopes].sort();
  const expected = [
    ["GET /api/transcript/image", "image"],
    ...["/api/sessions", "/api/agents", "/api/commands", "/api/command", "/api/transcript"].map((p) => [`GET ${p}`, "read"]),
  ].sort();
  assertEquals(entries, expected);
  assertEquals(m.ROUTES.scopeFor("GET", "/api/unknown"), null);
  for (const path of ["/app.js", "/index.html", "/api/activity", "/api/bootstrap"]) {
    const page = await m.handleGet(await m.Store.open(tmp("static")), path, "");
    assertEquals(page.status, 404, path);
  }
});

// ---- parity of the pure functions over a corpus ----

const TEXTS = [
  ...PROMPTS.map(([raw]) => raw),
  "",
  " ",
  "\u2028x\u2029y\x1cz\x85w",
  "Short:\nsecond line here\nthird line\nfourth",
  "```js\ncode\n```\nafter fence",
  "---\n===\nreal title",
  "_emph_ and *star* and snake_case_name and 2*3*4",
  "> quoted\n# heading",
  "1) first item that is long enough",
  "  - item",
  "ab\u00e9cd *x* \u00e9_y_",
  "[Image #1]",
  "[image #12]  ",
  "[Image: source: C:\\a b\\c.png]",
  "x".repeat(200),
  "w ".repeat(60) + "end",
  "emoji 😀".repeat(20),
  "é".repeat(91),
  "ǅ title ß",
  "<SYSTEM-REMINDER>x</System-Reminder>after",
  "<system-reminderx>kept</system-reminderx>",
  "<system-reminderé>x</system-reminderé>t",
  "Continue from where you left off.",
  "The user opened the file x",
  "<command-name>  /x  </command-name><command-args> a b </command-args>",
  "İstanbul ſ K",
  "\ufeffBOM start",
  "<local-command-stdout>x</local-command-stdout>\n\nreal",
  "tab\there",
  "a\r\nb\rc\nd",
];

Deno.test("parity: clean_prompt, tidy_title, splitlines, title() over a corpus", async () => {
  await py.same(
    "monitor",
    "clean_prompt",
    TEXTS.map((t) => [t]),
    m.cleanPrompt,
  );
  await py.same(
    "monitor",
    "tidy_title",
    TEXTS.map((t) => [t]),
    (t: string) => m.tidyTitle(t),
  );
  await py.same(
    "monitor",
    "tidy_title",
    TEXTS.map((t) => [t, 20]),
    (t: string, n: number) => m.tidyTitle(t, n),
  );
  for (const t of TEXTS) {
    assertEquals(
      splitlines(t),
      await py.call("builtins", "str.splitlines", [t]),
      JSON.stringify(t),
    );
  }
  for (
    const t of [
      "user",
      "assistant",
      "bashExecution",
      "tool_result",
      "ß",
      "ǆx",
      "1a",
      "hello world",
      "ÉCOLE",
      "x-y_z",
    ]
  ) {
    assertEquals(pyTitle(t), await py.call("builtins", "str.title", [t]), t);
  }
});

Deno.test("parity: normalize and update_metadata over every fixture record", async () => {
  const rows: unknown[] = [
    ...fx.imageRows(),
    ...fx.cacheRows("p", 2, true, "x"),
    ...fx.pagingRows(3),
    ...fx.edgeRows().split("\n").map((l) => {
      try {
        return JSON.parse(l.replace(/^\ufeff/, ""));
      } catch {
        return null;
      }
    }).filter((r) => r && typeof r === "object" && !Array.isArray(r)),
  ];
  for (const [i, row] of rows.entries()) {
    const expected = await py.raw("monitor", "normalize", [row, i]);
    if ("error" in expected) {
      let name = "";
      try {
        m.normalize(row as m.Dict, i);
      } catch (error) {
        name = (error as Error).name;
      }
      assertEquals(name, expected.error, JSON.stringify(row).slice(0, 80));
    } else {assertEquals(
        plain(m.normalize(row as m.Dict, i)),
        expected.ok,
        JSON.stringify(row).slice(0, 80),
      );}
  }
});

Deno.test("parity: task-notification XML as ElementTree reads it", async () => {
  const docs = [
    "<task-notification><task-id>a</task-id><status>completed</status></task-notification>",
    "<task-notification>\n<task-id>a</task-id>\n<task-id>b</task-id>\n<status>stopped</status>\n<summary>x &amp; y &lt;z&gt; &#65;&#x42;</summary>\n</task-notification>",
    "<task-notification><summary>a && b</summary></task-notification>",
    "<task-notification><summary>a &nbsp; b</summary></task-notification>",
    "<task-notification><summary>a < b</summary></task-notification>",
    "<task-notification><summary>]]></summary></task-notification>",
    "<task-notification><summary><![CDATA[a < b & c]]></summary></task-notification>",
    "<task-notification><status>completed<b/>tail</status></task-notification>",
    "<task-notification><status/><task-id></task-id></task-notification>",
    "<task-notification><x:y/></task-notification>",
    '<task-notification xmlns:x="u"><x:status>completed</x:status></task-notification>',
    '<task-notification xmlns="u"><status>completed</status></task-notification>',
    '<task-notification><status a="1" a="2">x</status></task-notification>',
    "<task-notification><status a=1>x</status></task-notification>",
    "<task-notification><status>a\r\nb\rc</status></task-notification>",
    "<task-notification><!-- note --><status>x<!-- c -->y</status><?pi data?></task-notification>",
    "<task-notification><status>x</stat></task-notification>",
    "<task-notification><status>x</status ></task-notification>",
    "<task-notification><status>\u0001</status></task-notification>",
    "<task-notification><status>&#0;</status></task-notification>",
    "<task-notification><status>😀 é</status></task-notification>",
    "<task-notification><!DOCTYPE x></task-notification>",
    '<task-notification><?xml version="1.0"?></task-notification>',
    "<task-notification><task-id>a</task-id><task-notification>",
    "<task-notification><a><b>deep</b></a><status>ok</status></task-notification>",
    "<task-notification><status>a</status>trailing &amp; text</task-notification>",
    "<task-notification><1bad/></task-notification>",
    "<task-notification><status>--></status></task-notification>",
    "<task-notification><!-- a -- b --></task-notification>",
  ];
  for (const doc of docs) {
    const got = parseNotice(doc);
    assertEquals(
      got &&
        { tag: got.tag, children: got.children.map((c) => [c.tag, c.text]) },
      await py.call("monitor_shim", "notice", [doc]),
      doc,
    );
  }
});

Deno.test("parity: fromisoformat timestamps, base64 strict decode, int() and parse_qs", async () => {
  const stamps = [
    "2026-01-01T00:00:01+00:00",
    "2026-01-01",
    "20260101",
    "2026-01-01 10:00",
    "2026-01-01T10",
    "2026-01-01T1000",
    "2026-01-01T10:00:00.1234567+01:00",
    "2026-01-01T10:00:00,5+0100",
    "2026-W01-1",
    "2026W011",
    "2026-W53",
    "2020-W53-7",
    "2026-01-01T10:00:00+01",
    "2026-01-01x10:00",
    "2026-1-1",
    "None",
    "2026-01-01T24:00:00",
    "2026-02-30",
    "0000-01-01",
    "2026-11-08T15:00:00.000+00:00",
    "2026-11-08T15:00:00.5",
    "2026-01-01T10:00:00-05:30",
    "2026-01-01T10:00:00+24:00",
    "2026-01-01T",
    "2026-01-01T10:00:00Z",
    "2026-01-01T10:00:00+00:00x",
    "2026-01-01T10:00:00.",
    "17",
    "",
    "2026-01-01T10:00:00 +01:00",
    "2026-01-01T10:00:00+01:00:30.5",
  ];
  for (const s of stamps) {
    let got: unknown;
    try {
      got = isoTimestamp(s);
    } catch (error) {
      got = { error: (error as Error).message };
    }
    const want = await py.call("monitor_shim", "iso", [s]) as unknown;
    if (typeof want === "object" && typeof got === "object") {
      assert((got as { error: string }).error !== undefined, s);
    } else assertEquals(got, want, s);
  }
  for (
    const s of [
      "=",
      "QQ",
      "QQ=",
      "QQ==",
      "QUJD=",
      "QUJDQ",
      "QUJ=",
      "Q===",
      "QU=J",
      "Q Q==",
      "é",
      "QQ==QQ",
      "QQ===",
      "",
      fx.PNG,
      "QUJD==",
    ]
  ) {
    let got: unknown;
    try {
      got = [...b64decodeStrict(s)];
    } catch (error) {
      got = { error: (error as Error).message };
    }
    assertEquals(got, await py.call("monitor_shim", "b64", [s]), s);
  }
  for (
    const s of [
      "12",
      " 1_0 ",
      "٣",
      "-4",
      "+2",
      "abc",
      "1__0",
      "",
      "0x1",
      "1.5",
      "\u20071",
    ]
  ) {
    let got: unknown;
    try {
      got = pyInt(s);
    } catch (error) {
      got = "ValueError: " + (error as Error).message;
    }
    const want = await py.raw("builtins", "int", [s]);
    assertEquals(
      got,
      "error" in want ? "ValueError: " + want.message : want.ok,
      s,
    );
  }
  for (
    const q of [
      "a=1&b=&c&a=2",
      "k=a+b%20c",
      "k=%zz%41",
      "k=%C3%A9%FF",
      "&&x=1",
      "x==1",
      "e%3D=v",
    ]
  ) {
    const want = await py.call("urllib.parse", "parse_qs", [q]);
    assertEquals(Object.fromEntries(parseQs(q)), want, q);
  }
});

Deno.test("parity: project_match and project folders of summaries", async () => {
  const cases: [unknown[], string][] = [
    [["/home/u/a:b/proj"], "/home/u/.claude/projects/-home-u-a-b-proj/s.jsonl"],
    [
      ["/home/u/a:b/proj/src:x"],
      "/home/u/.claude/projects/-home-u-a-b-proj/s.jsonl",
    ],
    [
      ["C:\\Users\\x\\proj"],
      "C:/Users/x/.claude/projects/C--Users-x-proj/s.jsonl",
    ],
    [["C:/Users/x/proj"], "x/C--Users-x-proj/s.jsonl"],
    [["/c/Users/x/proj"], "x/C--Users-x-proj/s.jsonl"],
    [["/c/proj"], "x/-c-proj/s.jsonl"],
    [["/c"], "x/C--/s.jsonl"],
    [[5, "", null, "rel/dir"], "x/rel-dir/s.jsonl"],
    [["\\\\server\\share\\dir"], "x/--server-share-dir/s.jsonl"],
    [["C:"], "x/C-/s.jsonl"],
    [["/"], "a/b/c/d/e.jsonl"],
    [["C:\\deep\\a\\b\\c"], "C--deep/x/y/z/s.jsonl"],
    [["C:\\deep\\a\\b\\c"], "r/C--deep/x/y/s.jsonl"],
  ];
  for (const [cwds, transcript] of cases) {
    assertEquals(
      m.projectMatch(cwds, transcript),
      await py.call("monitor", "project_match", [cwds, transcript]),
      JSON.stringify(cwds),
    );
  }
  const root = tmp("cwdparity");
  fx.projectFixtures(root);
  for (
    const p of [
      "C--repo-app/a.jsonl",
      "C--repo-app/b.jsonl",
      "C--repo-app/c.jsonl",
      "C--repo-app/d.jsonl",
      "-home-u-proj/e.jsonl",
      "plain/f.jsonl",
    ]
  ) {
    const ts = await (await m.Store.open(root)).summary(join(root, p));
    const want = await py.call("monitor_shim", "summary", [
      root,
      join(root, p),
    ]) as m.Dict;
    assertEquals([ts.cwd, ts.projectRoot, ts.title, ts.key, ts.hasMessages], [
      want.cwd,
      want.projectRoot,
      want.title,
      want.key,
      want.hasMessages,
    ], p);
  }
});

Deno.test("parity: close the Python bridge and remove the temp folders", async () => {
  await py.close();
  for (const dir of made) {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* Windows may hold a file briefly */ }
  }
});
