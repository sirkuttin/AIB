/**
 * Phone access end to end.
 *
 * With a real AIB (`AIB serve`, temp data folder, split agent host, the fake ACP agent; never the live ports) and a fake Tailscale
 * CLI (_fake_tailscale.ts): phone access on at start, a fake phone paired through the HTTP routes with forged Serve headers, a real
 * chat (an image prompt and a helper) read through home and chat, the image by cookie; no phone-port answer carries the page token,
 * the agent host's token or the artifact key secret; the same phone port and the same pairing after a restart; a busy phone port
 * at start is reported (never another port); Funnel on stops the phone port.
 *
 * With a headless Chrome (no window) on the phone page at 375 px, where this test plays Tailscale Serve (DevTools Fetch
 * interception: the page really is https://<tailnet name>, a secure context): pairing through the page (check words equal the
 * PC's), home, a chat, offline and "no longer paired", with no sideways scroll; and chat.html at 375 px laid out as before.
 *
 * Phase B: from the phone (forged Serve headers, a real AIB and the fake agent) a form question is answered and a request approved
 * once, and the agent goes on; plain text sends, "/" is refused, a queued message is removed, Stop ends a turn, a closed chat is
 * refused; each action is one line in the phone activity log. In the headless page at 375 px: a "Needs you" card opens the
 * question sheet, the approval sheet shows Deny / Allow once with the long command wrapped, the composer (16 px, Stop) keeps the
 * text through polls, queued messages have Edit / Remove / Send now, and the switches turned off on the PC hide those controls.
 *
 * Presence: the phone page on one chat while another needs you shows a banner (no push); a tap opens that chat with its sheet up;
 * the page hidden tells the PC at once (POST /api/remote/left).
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  DENO,
  Fixture,
  httpJson,
  type Json,
  openConversation,
  SEP,
  sleep,
  until,
  type Web,
} from "./_host_fixture.ts";
import { nativePath } from "./_host_fixture.ts";
import { WORK } from "./_parity.ts";
import { pickPort } from "./_ports.ts";
import { Browser, browserPath, type Page } from "./_doc_browser.ts";
import {
  type FakeChat,
  fakeTailscale,
  LOGIN,
  NAME,
  nonce,
  pairPhone,
  pc,
  phoneHeaders,
  type Raw,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
  tailscaleStatus,
  writeSavedChat,
} from "./_remote_fixture.ts";
import { OwnerRegistry } from "../../outputs/agent-studio/server/ownership/probe.ts";
import { startAttention } from "../../outputs/agent-studio/server/attention/watcher.ts";
import {
  readRemoteArtifactPort,
  readRemotePort,
} from "../../outputs/agent-studio/server/remote/port.ts";
import {
  COOKIE_NAME,
  DEVICE_HEADER,
} from "../../outputs/agent-studio/server/remote/server.ts";

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const FAKE_TAILSCALE = nativePath(new URL("deno/_fake_tailscale.ts", WORK));
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A data folder with phone access on, its phone port saved, and the fake Tailscale CLI's answers. */
class PhoneFixture extends Fixture {
  readonly answers = this.root + SEP + "tailscale.json";
  readonly phonePort = pickPort();
  readonly artifactPort = pickPort();
  constructor(options: { funnel?: boolean } = {}) {
    super();
    Deno.writeTextFileSync(
      this.state + SEP + "remote-port.json",
      JSON.stringify({
        version: 1,
        port: this.phonePort,
        artifactPort: this.artifactPort,
      }),
    );
    Deno.writeTextFileSync(
      this.state + SEP + "phone-access.json",
      JSON.stringify({ version: 1, on: true, via: "tailscale" }),
    );
    Deno.writeTextFileSync(
      this.answers,
      JSON.stringify({
        status: tailscaleStatus(),
        serve: serveStatus(this.phonePort, !!options.funnel),
      }),
    );
  }
  override get env(): Record<string, string> {
    return {
      ...super.env,
      AIB_TAILSCALE_CLI: JSON.stringify([
        DENO,
        "run",
        "-A",
        "--quiet",
        FAKE_TAILSCALE,
        this.answers,
      ]),
      AIB_TEST_REMOTE_BIND_MS: "1500",
    };
  }
  calls(): string[][] {
    return this.read(this.answers + ".calls").split("\n").filter(Boolean).map((
      l,
    ) => JSON.parse(l));
  }
}

const phoneGet = (
  port: number,
  path: string,
  token?: string,
  extra: Record<string, string> = {},
) =>
  raw(
    port,
    "GET",
    path,
    phoneHeaders({ ...(token ? { [DEVICE_HEADER]: token } : {}), ...extra }),
  );
const phonePost = (port: number, path: string, body: Json) =>
  raw(port, "POST", path, phoneHeaders({}, "POST"), JSON.stringify(body));

async function pairOverHttp(
  web: Web,
  port: number,
  name = "Pixel 9",
): Promise<{ token: string; cookie: string; answers: Raw[] }> {
  const answers: Raw[] = [];
  const [s1, code] = await httpJson(
    "POST",
    web.port,
    "/api/live/devices/pair",
    web.token,
    {},
  );
  assertEquals(s1, 200, JSON.stringify(code));
  const claim = await phonePost(port, "/api/remote/pair/claim", {
    code: (code.words as string[]).join(" "),
    name,
    nonce: nonce(),
  });
  answers.push(claim);
  assertEquals(claim.status, 200, claim.text);
  const [, view] = await httpJson(
    "GET",
    web.port,
    "/api/live/devices",
    web.token,
  );
  const pending = ((view.pairing as Json).pending as Json[])[0];
  assertEquals(pending.checkWords, claim.json.checkWords);
  const [s2] = await httpJson(
    "POST",
    web.port,
    "/api/live/devices/approve",
    web.token,
    { claim: pending.id },
  );
  assertEquals(s2, 200);
  const done = await phonePost(port, "/api/remote/pair/status", {
    claim: claim.json.claim,
    claimSecret: claim.json.claimSecret,
  });
  answers.push(done);
  const cookie =
    (done.headers.get("set-cookie") ?? "").match(/__Host-aib-phone=([^;]+)/)
      ?.[1] ?? "";
  return { token: done.json.token as string, cookie, answers };
}

function secretsOf(fx: Fixture, web: Web): string[] {
  const out = [web.token];
  try {
    out.push(
      String(
        JSON.parse(fx.read(fx.state + SEP + "agent-host.json")).token ?? "",
      ),
    );
  } catch { /* in-process: no agent host */ }
  try {
    out.push(
      String(
        JSON.parse(fx.read(fx.state + SEP + "keeper" + SEP + "keeper.json"))
          .token ?? "",
      ),
    );
  } catch { /* the keeper is off in this fixture */ }
  try {
    const secret = Deno.readFileSync(fx.state + SEP + "artifact-key-secret");
    out.push(
      [...secret].map((b) => b.toString(16).padStart(2, "0")).join(""),
      btoa(String.fromCharCode(...secret)),
    );
  } catch { /* not made yet */ }
  return out.filter((s) => s.length >= 16);
}

Deno.test({
  ...OPTS,
  name:
    "end to end: a real AIB with phone access on, a phone paired over HTTP reads home and a chat; same port and pairing after a restart",
  async fn() {
    await using fx = new PhoneFixture();
    let web = await fx.startWeb();
    const port = fx.phonePort;
    const answers: Raw[] = [];
    const boot = await until(
      async () => {
        const r = await phoneGet(port, "/api/remote/bootstrap");
        return r.status === 200 ? r : null;
      },
      "the phone port",
      30,
    );
    answers.push(boot);
    assertEquals([boot.json.paired, boot.json.layout], [false, "phone"]);
    const phone = await pairOverHttp(web, port);
    answers.push(...phone.answers);
    // a real chat: an image prompt, then a turn that starts a helper
    const id = await openConversation(web, fx);
    const [ps] = await web.post("prompt", {
      id,
      text: "look at this",
      clientMessageId: "p1",
      attachments: [{ type: "image", mimeType: "image/png", data: PNG }],
    });
    assertEquals(ps, 200);
    await until(async () => !(await web.state(id)).busy, "the image turn", 30);
    const [ds] = await web.post("prompt", {
      id,
      text: "delegate",
      clientMessageId: "p2",
    });
    assertEquals(ds, 200);
    const home = await until(
      async () => {
        const r = await phoneGet(port, "/api/remote/home", phone.token);
        const chat = ((r.json.chats ?? []) as Json[]).find((c) => c.id === id);
        return chat && chat.state === "working" ? r : null;
      },
      "home with the working chat",
      30,
    );
    answers.push(home);
    const card = (home.json.chats as Json[]).find((c) => c.id === id)!;
    assert(!("main" in home.json), "no main chat");
    assert(
      typeof (card.project as Json).name === "string" && /^[0-9a-f]{12}$/.test((card.project as Json).id as string),
      "the card names its project",
    );
    const chat = await until(
      async () => {
        const r = await phoneGet(port, `/api/remote/chat?id=${id}&tail=50`, phone.token);
        return ((r.json.helpers ?? []) as Json[]).length ? r : null;
      },
      "the chat with its subagent",
      30,
    );
    assertEquals(chat.json.helpers, [{
      id: "child-1",
      title: "Review the fixture",
      state: "running",
    }]);
    answers.push(chat);
    assertEquals(chat.status, 200);
    assert(!chat.text.includes(PNG), "no inline image bytes");
    const user = (chat.json.events as Json[]).find((e) =>
      e.kind === "user" && (e.data as Json).text === "look at this"
    )!;
    const url = ((user.data as Json).attachments as Json[])[0].url as string;
    assert(url.startsWith("/api/remote/image?"), url);
    const img = await phoneGet(port, url, undefined, {
      Cookie: `${COOKIE_NAME}=${phone.cookie}`,
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
    });
    assertEquals([img.status, img.headers.get("content-type")], [
      200,
      "image/png",
    ]);
    assert(
      (chat.json.events as Json[]).some((e) =>
        JSON.stringify(e).includes("Fixture images")
      ),
      "the agent reply is there",
    );
    // the page port's bootstrap is not on the phone port, even with the device token
    answers.push(await phoneGet(port, "/api/live/bootstrap", phone.token));
    answers.push(await phoneGet(port, "/", phone.token));
    answers.push(await phoneGet(port, "/chat.html", phone.token));
    answers.push(
      await phoneGet(port, "/phone.html", undefined, {
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
      }),
    );
    const secrets = secretsOf(fx, web);
    assert(
      secrets.length >= 3,
      `the page token, the agent host's token and the artifact key secret (${secrets.length})`,
    );
    for (const secret of secrets) {
      for (const a of answers) {
        assert(
          !a.text.includes(secret),
          `a phone-port answer carries a secret (${a.status} ${
            a.text.slice(0, 80)
          })`,
        );
      }
    }
    assert(
      fx.calls().every((c) =>
        c[0] === "status" || (c[0] === "serve" && c[1] === "status")
      ),
      "AIB only reads Tailscale",
    );
    // restart: the same phone port, and the phone stays paired
    await httpJson("POST", web.port, "/api/live/disconnect", web.token, { id })
      .catch(() => {});
    await web.kill();
    web = await fx.startWeb();
    assertEquals(readRemotePort(fx.state), port);
    const again = await until(
      async () => {
        const r = await phoneGet(port, "/api/remote/home", phone.token);
        return r.status === 200 ? r : null;
      },
      "the phone port after a restart",
      30,
    );
    assertEquals(again.status, 200);
    // Phase D: the artifact port (https 8443) is up on its saved port too, and the phone is told where artifacts open
    assertEquals(readRemoteArtifactPort(fx.state), fx.artifactPort);
    const boot2 = await phoneGet(port, "/api/remote/bootstrap", phone.token);
    assertEquals(boot2.json.artifacts, `https://${NAME}:8443`);
    const lib = await raw(fx.artifactPort, "GET", "/_lib/mermaid.min.js", {
      Host: `${NAME}:8443`,
      "Tailscale-User-Login": LOGIN,
      "Sec-Fetch-Site": "same-site",
    });
    assertEquals(lib.status, 200, "the artifact port answers after a restart");
  },
});

Deno.test({
  ...OPTS,
  name:
    'end to end: from the phone, answer a form question and approve once; the agent continues; plain text sends, "/" refused, queue, Stop',
  async fn() {
    await using fx = new PhoneFixture();
    const web = await fx.startWeb();
    const port = fx.phonePort;
    await until(
      async () =>
        (await phoneGet(port, "/api/remote/bootstrap")).status === 200,
      "the phone port",
      30,
    );
    const phone = await pairOverHttp(web, port);
    const id = await openConversation(web, fx);
    const act = (op: string, body: Json) =>
      raw(
        port,
        "POST",
        `/api/remote/${op}`,
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, "POST"),
        JSON.stringify(body),
      );
    const chat = () =>
      phoneGet(port, `/api/remote/chat?id=${id}&tail=100`, phone.token);
    const waiting = async (kind: string) =>
      await until(
        async () =>
          ((await chat()).json.waiting as Json[] ?? []).find((w) =>
            w.kind === kind
          ) ?? null,
        kind,
        30,
      );
    const said = async (text: string) =>
      await until(
        async () => {
          const c = await chat();
          return !c.json.busy && JSON.stringify(c.json.events).includes(text)
            ? c
            : null;
        },
        text,
        30,
      );

    // the phone sends plain text: a form question comes back
    const sent = await act("prompt", {
      id,
      text: "form",
      clientMessageId: "phone-1",
    });
    assertEquals(sent.status, 200, sent.text);
    const q = await waiting("question");
    assertEquals(q.pcOnly, false);
    const answered = await act("elicitation", {
      id,
      key: q.key,
      action: "accept",
      content: { name: "Ada", plan: "pro" },
    });
    assertEquals(answered.status, 200, answered.text);
    await said("Fixture form response");
    assert(
      JSON.stringify((await chat()).json.events).includes(
        '\\"plan\\": \\"pro\\"',
      ),
      "the agent got the answer",
    );

    // a permission: Allow once from the phone, the agent continues
    assertEquals(
      (await act("prompt", { id, text: "approve", clientMessageId: "phone-2" }))
        .status,
      200,
    );
    const p = await waiting("permission");
    assertEquals((p.options as Json[]).map((o) => o.kind), [
      "allow_once",
      "reject_once",
    ]);
    assertEquals(
      (await act("permission", { id, key: p.key, option: "not-an-option" }))
        .status,
      403,
    );
    const ok = await act("permission", {
      id,
      key: p.key,
      option: (p.options as Json[])[0].optionId,
    });
    assertEquals(ok.status, 200, ok.text);
    await said("Fixture response");

    // refused: an agent or AIB command (a link question is refused in remote_actions_test.ts: this agent runs --rich)
    assertEquals(
      (await act("prompt", {
        id,
        text: "/compact",
        clientMessageId: "phone-3",
      })).json.code,
      "text_only",
    );

    // Stop: a turn that waits until stopped
    assertEquals(
      (await act("prompt", { id, text: "wait", clientMessageId: "phone-5" }))
        .status,
      200,
    );
    await until(async () => (await chat()).json.busy, "working", 30);
    const queued = await act("queue", {
      id,
      text: "after the stop",
      clientMessageId: "phone-6",
    });
    assertEquals(queued.status, 200, queued.text);
    const item = await until(
      async () => (((await chat()).json.queue as Json).items as Json[])[0],
      "queued",
      30,
    );
    assertEquals(item.text, "after the stop");
    assertEquals(
      (await act("queue-remove", { id, messageId: item.id })).status,
      200,
    );
    assertEquals((await act("cancel", { id })).status, 200);
    await until(async () => !(await chat()).json.busy, "stopped", 30);

    // not running any more: "Tap Continue this chat"
    await web.post("disconnect", { id });
    const closed = await act("prompt", {
      id,
      text: "hi",
      clientMessageId: "phone-7",
    });
    assertEquals([closed.status, closed.json.code], [409, "not_live"]);

    const log = fx.read(fx.state + SEP + "remote-audit.jsonl");
    for (
      const secret of [
        "Ada",
        "after the stop",
        "/compact",
        "Fixture approval",
        "Fixture form",
      ]
    ) {
      assert(!log.includes(secret), `the log holds ${secret}`);
    }
    const lines = log.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.chat === id);
    assertEquals(lines.map((l) => [l.action, l.result]), [
      ["send", "done"],
      ["answer", "done"],
      ["send", "done"],
      ["approve", "refused: pc_only"],
      ["approve", "done"],
      ["send", "refused: text_only"],
      ["send", "done"],
      ["queue", "done"],
      ["queue: remove", "done"],
      ["stop", "done"],
      ["send", "refused: not_live"],
    ]);
  },
});

Deno.test({
  ...OPTS,
  name:
    "end to end: a saved chat that is not running is on home, reads read only, Continue makes it live with its saved agent; a message reaches the agent; reading clears the PC's unread; Send off and open elsewhere refused",
  async fn() {
    await using fx = new PhoneFixture();
    const claude = fx.root + SEP + "claude";
    writeSavedChat(claude, fx.workspace, {
      sessionId: "s-saved",
      prompt: "Tidy the README",
      reply: "Tidied.",
      ageSeconds: 3600,
    });
    writeSavedChat(claude, fx.workspace, {
      sessionId: "s-other",
      prompt: "Open in another copy",
      ageSeconds: 3600,
    });
    const web = await fx.startWeb();
    const port = fx.phonePort;
    await until(
      async () =>
        (await phoneGet(port, "/api/remote/bootstrap")).status === 200,
      "the phone port",
      30,
    );
    const phone = await pairOverHttp(web, port);
    const post = (path: string, body: Json) =>
      raw(
        port,
        "POST",
        path,
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, "POST"),
        JSON.stringify(body),
      );

    // home: both saved chats under "not running", nothing live
    const home = await phoneGet(port, "/api/remote/home", phone.token);
    assertEquals(home.status, 200, home.text);
    assertEquals(home.json.chats, []);
    const keys = (home.json.saved as Json[]).map((c) => c.key).sort();
    assertEquals(keys, ["claude:s-other", "claude:s-saved"]);
    const saved = await phoneGet(
      port,
      "/api/remote/saved?key=claude:s-saved&tail=100",
      phone.token,
    );
    assertEquals(saved.status, 200, saved.text);
    assertEquals(saved.json.title, "Tidy the README");
    assert(JSON.stringify(saved.json.events).includes("Tidied."));

    // Send off: Continue refused, nothing opened
    const [, view] = await httpJson("GET", web.port, "/api/live/devices", web.token);
    const deviceId = (view.devices as Json[])[0].id as string;
    await httpJson("POST", web.port, "/api/live/devices/scopes", web.token, {
      id: deviceId,
      scopes: ["phone.read"],
    });
    const off = await post("/api/remote/continue", { key: "claude:s-saved" });
    assertEquals([off.status, off.json.code], [403, "scope"]);
    await httpJson("POST", web.port, "/api/live/devices/scopes", web.token, {
      id: deviceId,
      scopes: ["phone.read", "phone.answer", "phone.prompt", "phone.approve"],
    });
    // the phone cannot pick the agent, model or folder
    const picked = await post("/api/remote/continue", {
      key: "claude:s-saved",
      provider: "codex",
      cwd: fx.root,
      model: "x",
    });
    assertEquals([picked.status, picked.json.code], [403, "pc_only"]);
    assertEquals(
      ((await web.listing()).connections as Json[]).filter((c) => !c.closed),
      [],
    );

    // open in another AIB copy (its announcement in the owners folder): refused with that reason, nothing taken over
    const other = new OwnerRegistry(fx.owners, { clientName: "AIB (other copy)" });
    assert(other.announce("claude", "s-other", fx.workspace, "ready"));
    const elsewhere = await post("/api/remote/continue", { key: "claude:s-other" });
    assertEquals([elsewhere.status, elsewhere.json.code], [409, "session_in_use"], elsewhere.text);
    assert(String(elsewhere.json.error).includes("AIB (other copy)"), elsewhere.text);
    assert(String(elsewhere.json.error).includes("Nothing was opened or sent."));

    // Continue: live with its saved agent, folder and session
    const started = await post("/api/remote/continue", { key: "claude:s-saved" });
    assertEquals(started.status, 200, started.text);
    const id = started.json.id as string;
    const chat = () => phoneGet(port, `/api/remote/chat?id=${id}&tail=100`, phone.token);
    await until(async () => (await chat()).json.ready, "the chat is live", 60);
    const entry = ((await web.listing()).connections as Json[]).find((c) => c.id === id)!;
    assertEquals([entry.provider, entry.sessionId], ["claude", "s-saved"]);
    assertEquals(
      String(entry.cwd).toLowerCase(),
      Deno.realPathSync(fx.workspace).toLowerCase(),
    );
    const after = await phoneGet(port, "/api/remote/home", phone.token);
    assertEquals((after.json.saved as Json[]).map((c) => c.key), ["claude:s-other"]);
    assertEquals((after.json.chats as Json[]).map((c) => c.id), [id]);

    // a plain message reaches the agent
    const sent = await post("/api/remote/prompt", { id, text: "hello", clientMessageId: "phone-r1" });
    assertEquals(sent.status, 200, sent.text);
    const done = await until(async () => {
      const c = await chat();
      const text = JSON.stringify(c.json.events);
      return !c.json.busy && text.includes('"text":"hello"') && text.includes("# Rich reply") ? c : null;
    }, "the agent's answer", 60);

    // the turn ended after the PC last looked: unread on the PC until the phone shows the end
    const ended = await until(async () => {
      const l = ((await web.listing()).connections as Json[]).find((c) => c.id === id);
      return Date.parse(String((l?.attention as Json)?.turnEndedAt ?? "")) || 0;
    }, "turn ended", 30);
    const seen = async () => {
      const [, rs] = await httpJson("GET", web.port, "/api/live/read-state", web.token);
      return ((rs.chats as Record<string, Json>)["claude:s-saved"]?.seenAt as number) ?? 0;
    };
    assert((await seen()) < ended, "unread on the PC");
    const read = await post("/api/remote/read", { id, seq: done.json.cursor });
    assertEquals([read.status, read.json.marked], [200, true], read.text);
    assert((await seen()) >= ended, "read on the PC");

    const lines = fx.read(fx.state + SEP + "remote-audit.jsonl").split("\n")
      .filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.action === "continue" || l.action === "read");
    assertEquals(lines.map((l) => [l.action, l.chat, l.result]), [
      ["continue", "claude:s-saved", "refused: switched off"],
      ["continue", "claude:s-saved", "refused: settings"],
      ["continue", "claude:s-other", "refused: session_in_use"],
      ["continue", id, "started on the PC"],
      ["read", id, "marked read on the PC"],
    ]);
    assert(!fx.read(fx.state + SEP + "remote-audit.jsonl").includes("Tidy"));
    other.withdraw("claude", "s-other");
  },
});

Deno.test({
  ...OPTS,
  name:
    "a busy phone port at start: Devices reports it and the saved port is kept, never another one",
  async fn() {
    await using fx = new PhoneFixture();
    const held = Deno.listen({ hostname: "127.0.0.1", port: fx.phonePort }); // port-guard: not bound (an OS-chosen port held by this test)
    try {
      const web = await fx.startWeb();
      const view = await until(
        async () => {
          const [, v] = await httpJson(
            "GET",
            web.port,
            "/api/live/devices",
            web.token,
          );
          return (v.problem as Json | null)?.code === "port_busy" ? v : null;
        },
        "port busy reported",
        30,
      );
      assertEquals([view.listening, view.port], [false, fx.phonePort]);
      assert(
        String((view.problem as Json).message).startsWith(
          `Port ${fx.phonePort} is busy`,
        ),
      );
      assertEquals(readRemotePort(fx.state), fx.phonePort);
      held.close();
      const [, after] = await httpJson(
        "POST",
        web.port,
        "/api/live/devices/check",
        web.token,
        {},
      );
      assertEquals([after.listening, after.port], [true, fx.phonePort]);
    } finally {
      try {
        held.close();
      } catch { /* closed */ }
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Funnel on at start: the phone port does not listen and Devices says why",
  async fn() {
    await using fx = new PhoneFixture({ funnel: true });
    const web = await fx.startWeb();
    const view = await until(
      async () => {
        const [, v] = await httpJson(
          "GET",
          web.port,
          "/api/live/devices",
          web.token,
        );
        return (v.problem as Json | null)?.code === "funnel" ? v : null;
      },
      "Funnel reported",
      30,
    );
    assertEquals(view.listening, false);
    const refused = await Deno.connect({
      hostname: "127.0.0.1",
      port: fx.phonePort,
    }).then((c) => (c.close(), false), () => true);
    assert(refused, "nothing listens on the phone port");
  },
});

// ---- the phone page in a headless browser ------------------------------------------------------------------------------------

/** This test plays Tailscale Serve: every request to https://<NAME>/ is answered from the phone port with Serve's headers. */
async function serveFor(
  page: Page,
  s: RemoteStudio,
  down: { on: boolean },
): Promise<void> {
  await page.send("Network.enable");
  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: `https://${NAME}/*`, requestStage: "Request" }],
  });
  page.listeners.set("Fetch.requestPaused", (p) => {
    void (async () => {
      const request = p.request as Json;
      const url = new URL(request.url as string);
      const method = request.method as string;
      const kind = p.resourceType as string;
      const sent = request.headers as Record<string, string>;
      const headers: Record<string, string> = {
        Host: NAME,
        "Tailscale-User-Login": LOGIN,
        "X-Forwarded-For": "100.64.0.7",
      };
      for (const [k, v] of Object.entries(sent)) {
        if (/^(content-type|x-aib-device|accept|origin)$/i.test(k)) {
          headers[k] = v;
        }
      }
      if (
        method === "POST" &&
        !Object.keys(headers).some((k) => k.toLowerCase() === "origin")
      ) headers.Origin = `https://${NAME}`;
      if (kind === "Document") {
        Object.assign(headers, {
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        });
      } else if (kind === "Fetch" || kind === "XHR") {
        Object.assign(headers, {
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        });
      } else {Object.assign(headers, {
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Dest": kind.toLowerCase(),
        });}
      const jar = await page.send("Network.getCookies", { urls: [url.href] });
      const cookies = (jar.cookies as Json[]).map((c) => `${c.name}=${c.value}`)
        .join("; ");
      if (cookies) headers.Cookie = cookies;
      let answer: Raw | null = null;
      if (down.on) {
        try {
          answer = await raw(
            s.phonePort(),
            method,
            url.pathname + url.search,
            headers,
            request.postData as string | undefined,
          );
        } catch { /* nothing listens: Serve answers 502 */ }
      }
      if (!answer) {
        await page.send("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: 502,
          responseHeaders: [],
          body: "",
        });
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
      await page.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: answer.status,
        responseHeaders,
        body: btoa(bin),
      });
    })().catch(() => {});
  });
}

const NO_SIDEWAYS =
  `(() => { const d = document.documentElement; return d.scrollWidth <= d.clientWidth + 0 && document.body.scrollWidth <= d.clientWidth; })()`;
const WIDTHS =
  `(() => { const d = document.documentElement; return [d.scrollWidth, d.clientWidth]; })()`;

function longChat(): FakeChat {
  const events: Json[] = [];
  let seq = 0;
  const ev = (kind: string, data: Json) =>
    events.push({ seq: ++seq, kind, time: seq, data });
  ev("user", {
    text:
      "Please fix C:\\Users\\someone\\code\\a-very-long-project-folder-name\\src\\components\\checkout\\PaymentStepWithAVeryLongName.tsx",
    attachments: [{ name: "shot.png", mimeType: "image/png", data: PNG }],
  });
  ev("update", {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text:
          "Sure. Here is the plan:\n\n```\nnpm run test -- --reporter=verbose --filter=checkout/payment-step-with-a-very-long-name\n```\n\n",
      },
    },
  });
  for (let i = 0; i < 6; i++) {
    ev("update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t" + i,
        title: "Read src/components/checkout/file" + i + ".tsx",
        status: "completed",
      },
    });
  }
  ev("update", {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text:
          "I started two helpers: one runs the tests, one updates the docs. " +
          "word ".repeat(80),
      },
    },
  });
  ev("update", {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "run",
      title: "RUN npm run lint",
      status: "in_progress",
    },
  });
  return {
    id: "main",
    provider: "claude",
    sessionId: "sess-main",
    cwd: "C:\\code\\shop",
    busy: true,
    closed: false,
    attention: {
      state: "working",
      needs: 0,
      turnEndedAt: null,
      busySince: new Date(Date.now() - 240_000).toISOString(),
    },
    subagents: {
      a: { title: "Codex · tests", state: "running" },
      b: { title: "Gemini · docs", state: "running" },
      c: { title: "Claude · api", state: "completed" },
    },
    breadth: { sessionInfo: { title: "Main · checkout redesign" } },
    events,
    permissions: [],
    elicitations: [],
  };
}

Deno.test({
  ...OPTS,
  name:
    "phone page at 375 px: pair through the page (check words equal the PC's), home, chat, offline, removed; no sideways scroll",
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      s.chats.push(longChat(), {
        id: "blog",
        provider: "codex",
        sessionId: "sess-blog",
        cwd: "C:\\code\\blog",
        busy: false,
        closed: false,
        attention: {
          state: "needs_you",
          needs: 1,
          turnEndedAt: null,
          busySince: null,
        },
        subagents: {},
        breadth: { sessionInfo: { title: "Blog site" } },
        events: [],
        permissions: [],
        elicitations: [{ key: "q", params: { message: "Which date format?" } }],
      });
      const page = await browser.open("about:blank", 375, 812);
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true,
      });
      const up = { on: true };
      await serveFor(page, s, up);
      const [, code] = await pc(s, "POST", "/api/live/devices/pair", {});
      await page.goto(code.url as string);
      await page.waitFor(
        '!!document.getElementById("pairName")',
        15000,
        "the pairing screen",
      );
      assertEquals(
        await page.eval("location.hash"),
        "",
        "the secret left the address bar",
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `pairing: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      const size = await page.eval<number[]>(
        `(() => { const b = document.getElementById('pairGo').getBoundingClientRect(); const i = document.getElementById('pairName'); return [b.height, parseFloat(getComputedStyle(i).fontSize)]; })()`,
      );
      assert(
        size[0] >= 44 && size[1] >= 16,
        `tap target ${size[0]} px, input text ${size[1]} px`,
      );
      await page.click("#pairGo");
      const words = await page.waitFor(
        'document.getElementById("checkWords")?.textContent',
        15000,
        "the check words",
      ) as string;
      const [, view] = await pc(s, "GET", "/api/live/devices");
      const pending = ((view.pairing as Json).pending as Json[])[0];
      assertEquals(
        words,
        (pending.checkWords as string[]).join(" "),
        "the phone and the PC show the same two words",
      );
      await pc(s, "POST", "/api/live/devices/approve", { claim: pending.id });
      // Phase C: Finish setup comes first (notifications); not an iPhone, so no Home Screen step
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "setup"',
        15000,
        "finish setup",
      );
      assertEquals(
        await page.eval(
          '[...document.querySelectorAll(".ph-step")].map((x) => x.dataset.step)',
        ),
        ["notify"],
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `finish setup: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      await page.click("#setupDone");
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")',
        15000,
        "home",
      );
      const cookies =
        (await page.send("Network.getCookies", { urls: [`https://${NAME}/`] }))
          .cookies as Json[];
      const cookie = cookies.find((c) => c.name === COOKIE_NAME)!;
      assertEquals([cookie.httpOnly, cookie.secure, cookie.sameSite], [
        true,
        true,
        "Strict",
      ]);
      assert(
        await page.eval('!document.cookie.includes("aib-phone")'),
        "the page script cannot read the cookie",
      );
      // one plain list (no sections, no main chat), newest change of state first: blog asks now, main started 4 min ago
      assertEquals(await page.eval('document.querySelectorAll(".ph-section").length'), 0, "no sections");
      assertEquals(
        await page.eval<string[]>('[...document.querySelectorAll(".ph-card")].map((c) => c.dataset.chat)'),
        ["blog", "main"],
      );
      const card = await page.eval<string[]>(
        `(() => { const c = document.querySelector('.ph-card[data-chat="main"]'); return [c.querySelector('.ph-title').textContent, c.querySelector('.ph-r2').textContent, c.querySelector('.ph-time').textContent, c.querySelector('.ph-state').textContent]; })()`,
      );
      assertEquals(card[0], "Main · checkout redesign");
      assertEquals(card[1], "shop · Claude Code · Working · 4m", "project, agent, state in the PC's words");
      assertEquals(card[2], "4m");
      assertEquals(
        await page.eval(`document.querySelector('.ph-card[data-chat="blog"] .ph-state').textContent`),
        "Needs you",
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `home: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      await page.click('.ph-card[data-chat="main"]');
      await page.waitFor(
        'document.querySelectorAll(".ph-msg").length >= 3',
        15000,
        "the chat",
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `chat: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      assertEquals(
        await page.eval('document.querySelector(".ph-steps-fold .ph-fold").textContent'),
        "✓6 steps›",
      );
      assert(
        String(
          await page.eval('document.querySelector(".ph-live").textContent'),
        ).startsWith("Step 7 · RUN npm run lint · 4 min"),
      );
      // one agent per chat: its subagents are a card in the stream (title and state only) and a shortcut under the title
      assertEquals(
        await page.eval('document.getElementById("phSubsGo").textContent'),
        "2 subagents working ›",
      );
      assert(
        await page.eval('![...document.querySelectorAll(".ph-head, #phSubs, .ph-bottom")].some((e) => /helper|main chat/i.test(e.textContent))'),
        "no helper or main-chat words around the conversation",
      );
      await page.click("#phSubsGo");
      await page.waitFor('document.querySelectorAll("#phSubs li").length === 3', 15000, "the Subagents card");
      assertEquals(
        await page.eval<string[]>('[...document.querySelectorAll("#phSubs li")].map((li) => li.textContent)'),
        ["Codex · testsworking", "Gemini · docsworking", "Claude · apidone"],
      );
      assertEquals(
        await page.eval('document.querySelector("#phSubs .ph-fold").textContent'),
        "⑂Subagents · 3 · 2 working›",
      );
      await page.waitFor(
        '(() => { const i = document.querySelector(".ph-img"); return i && i.complete && i.naturalWidth > 0; })()',
        15000,
        "the picture, by cookie",
      );
      await page.click(".ph-steps-fold .ph-fold");
      assert(
        await page.eval(NO_SIDEWAYS),
        `chat with steps open: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      // offline: the phone port stops (AIB closed): Serve answers 502. "Reconnecting…" first (the keeper restarts a crashed AIB in
      // 5 s; 20 s in the app, shortened here), then AIB is closed on the PC, never that the chats still run (owner decision 7).
      await page.eval("window.__aibPhone.reconnectMs = 2500");
      up.on = false;
      await page.waitFor(
        'document.querySelector(".ph-offline")?.dataset.offline === "reconnecting"',
        15000,
        "reconnecting",
      );
      assert(
        await page.eval('document.body.textContent.includes("Reconnecting…")'),
      );
      await page.waitFor(
        'document.querySelector(".ph-offline")?.dataset.offline === "closed"',
        15000,
        "the closed screen",
      );
      assert(
        await page.eval(
          'document.body.textContent.includes("AIB is closed on STUDIO-PC")',
        ),
      );
      assert(
        await page.eval(
          "!/still running|keep running/i.test(document.body.textContent)",
        ),
        "never says the chats still run",
      );
      assert(
        await page.eval('document.querySelectorAll(".ph-msg").length >= 3'),
        "the last view stays readable",
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `offline: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      up.on = true;
      await page.click(".ph-offline .ph-btn");
      await page.waitFor(
        '!document.querySelector(".ph-offline")',
        15000,
        "back online",
      );
      await page.click(".ph-back");
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "home"',
        15000,
        "home again",
      );
      // removed on the PC: the phone says so at its next poll
      const [, v2] = await pc(s, "GET", "/api/live/devices");
      await pc(s, "POST", "/api/live/devices/remove", {
        id: (v2.devices as Json[])[0].id,
      });
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "removed"',
        15000,
        "the removed screen",
      );
      assert(
        await page.eval(
          'document.body.textContent.includes("no longer paired")',
        ),
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `removed: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      assertEquals(page.errors, [], "console errors");
      assertEquals(page.csp, [], "CSP violations");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

/** Put a paired phone's token where phone.js keeps it (IndexedDB on the phone origin), then load the page again. */
async function signInPage(
  page: Page,
  token: string,
  id: string,
): Promise<void> {
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor(
    '!!document.getElementById("app").dataset.screen',
    15000,
    "the phone page",
  );
  await page.eval(`new Promise((resolve, reject) => {
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
  })`);
  await page.goto(`https://${NAME}/phone.html`);
  await page.waitFor(
    'document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")',
    15000,
    "home",
  );
}

Deno.test({
  ...OPTS,
  name:
    'phone page, steer-on-send: Send goes to the steer route while a steerable chat works, to the queue when it cannot steer, to a prompt when idle; "Sent while working" on a steered bubble',
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      const base = {
        provider: "claude",
        cwd: "C:\code\shop",
        closed: false,
        subagents: {},
        permissions: [],
        elicitations: [],
      };
      const working = { state: "working", needs: 0, turnEndedAt: null, busySince: new Date(Date.now() - 5000).toISOString() };
      const chats = [
        {
          ...base,
          id: "can",
          sessionId: "s-can",
          busy: true,
          steerable: true,
          attention: working,
          events: [
            { seq: 1, kind: "user", data: { text: "first prompt" } },
            { seq: 2, kind: "user", data: { text: "typed while it worked", steered: true } },
          ],
        },
        { ...base, id: "cannot", sessionId: "s-cannot", busy: true, steerable: false, attention: working, events: [{ seq: 1, kind: "user", data: { text: "first prompt" } }] },
        {
          ...base,
          id: "idle",
          sessionId: "s-idle",
          busy: false,
          steerable: false,
          attention: { state: "idle", needs: 0, turnEndedAt: new Date().toISOString(), busySince: null },
          events: [{ seq: 1, kind: "user", data: { text: "first prompt" } }],
        },
      ] as unknown as FakeChat[];
      s.chats.push(...chats);
      const phone = await pairPhone(s);
      const page = await browser.open("about:blank", 375, 812);
      await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
      await serveFor(page, s, { on: true });
      await signInPage(page, phone.token, phone.id);
      const sendFrom = async (id: string, text: string) => {
        await page.click(`.ph-card[data-chat="${id}"]`);
        await page.waitFor(
          `document.getElementById("app").dataset.screen === "chat" && window.__aibPhone.chatId === ${JSON.stringify(id)} && !!document.getElementById("phPrompt")`,
          15000,
          "the chat " + id,
        );
        await page.eval(
          `(() => { const ta = document.getElementById('phPrompt'); ta.focus(); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`,
        );
        const before = s.liveCalls.length;
        await page.click("#phSend");
        await until(() => s.liveCalls.length > before && s.liveCalls.some(([, b]) => b.text === text), "the send of " + id, 15);
      };
      await sendFrom("can", "steer me");
      assertEquals(s.liveCalls.at(-1)![0], "steer");
      assertEquals(
        await page.eval('[...document.querySelectorAll(".ph-msg.you")].map((m) => m.textContent)'),
        ["first prompt", "typed while it worked" + "Sent while working"],
        "the steered bubble carries the tag, the first one does not",
      );
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, "home");
      await sendFrom("cannot", "after the turn");
      assertEquals(s.liveCalls.at(-1)![0], "queue", "an agent that cannot steer: after the turn, as before");
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor('document.getElementById("app").dataset.screen === "home" && !!document.querySelector(".ph-card")', 15000, "home");
      await sendFrom("idle", "plain prompt");
      assertEquals(s.liveCalls.at(-1)![0], "prompt");
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'phone page at 375 px: "Not running" chats on home, one opens read only with Continue this chat (hidden when Send is off), continues into the live chat, which is then marked read on the PC; no sideways scroll',
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      const longTitle = "Refactor the checkout flow so PaymentStepWithAVeryLongNameAndNoSpacesAtAllInIt keeps the basket";
      s.saveChat({
        sessionId: "s-long",
        prompt: longTitle,
        reply: "Done. See C:\\Users\\someone\\code\\a-very-long-project-folder-name\\src\\components\\checkout\\PaymentStep.tsx " +
          "word ".repeat(60),
        ageSeconds: 7200,
      });
      s.saveChat({ sessionId: "s-two", prompt: "Write the release notes", ageSeconds: 600 });
      s.chats.push(longChat());
      s.answerLive((name, body) => {
        if (name !== "connect") return [200, { ok: true }];
        assertEquals(body, { provider: "claude", cwd: s.project, resume: "s-long", background: true });
        s.chats.push({
          id: "c-new",
          provider: "claude",
          sessionId: "s-long",
          cwd: s.project,
          busy: false,
          closed: false,
          attention: { state: "idle", needs: 0, turnEndedAt: new Date().toISOString(), busySince: null },
          subagents: {},
          events: [{ seq: 1, kind: "user", time: Date.now() / 1000, data: { text: longTitle } }],
          permissions: [],
          elicitations: [],
        });
        return [200, { id: "c-new", provider: "claude" }];
      });
      const phone = await pairPhone(s);
      const page = await browser.open("about:blank", 375, 812);
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await serveFor(page, s, { on: true });
      await signInPage(page, phone.token, phone.id);
      await page.waitFor(`!!document.querySelector('.ph-card.nr[data-saved="claude:s-long"]')`, 15000, "the not-running chats");
      // in the same list by time (the live chat started 4 min ago, s-two 10 min ago, s-long 2 h ago), lighter, "Not running"
      assertEquals(
        await page.eval<string[]>('[...document.querySelectorAll(".ph-card")].map((c) => c.dataset.chat || c.dataset.saved)'),
        ["main", "claude:s-two", "claude:s-long"],
      );
      assertEquals(
        await page.eval(`document.querySelector('.ph-card.nr[data-saved="claude:s-long"] .ph-r2').textContent`),
        "shop · Claude Code · Not running",
      );
      assertEquals(await page.eval(`document.querySelector('.ph-card[data-saved="claude:s-long"] .ph-time').textContent`), "2h");
      const looks = await page.eval<string[]>(
        `[...document.querySelectorAll('.ph-card[data-chat="main"], .ph-card[data-saved="claude:s-long"]')].map((c) => getComputedStyle(c).backgroundColor)`,
      );
      assert(looks[0] !== looks[1], `not running is drawn lighter: ${looks}`);
      assert(await page.eval(NO_SIDEWAYS), `home: sideways scroll ${await page.eval(WIDTHS)}`);

      // read only, with Continue this chat
      await page.click('.ph-card.nr[data-saved="claude:s-long"]');
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "saved" && !!document.getElementById("phContinueBtn")',
        15000,
        "the saved chat",
      );
      assertEquals(await page.eval('document.getElementById("phContinueBtn").textContent'), "Continue this chat");
      assert(String(await page.eval('document.querySelector(".ph-list").textContent')).includes("PaymentStep.tsx"));
      assertEquals(await page.eval('!!document.getElementById("phComposer")'), false, "no composer while it is not running");
      const button = await page.eval<number[]>(
        `(() => { const b = document.getElementById('phContinueBtn').getBoundingClientRect(); return [b.height, b.bottom, innerHeight]; })()`,
      );
      assert(button[0] >= 44 && button[1] <= button[2], `Continue: ${button}`);
      assert(await page.eval(NO_SIDEWAYS), `saved chat: sideways scroll ${await page.eval(WIDTHS)}`);

      // Send off on the PC: the button goes, the note says which switch
      await pc(s, "POST", "/api/live/devices/scopes", { id: phone.id, scopes: ["phone.read"] });
      await page.waitFor('!document.getElementById("phContinueBtn")', 15000, "Continue hidden");
      assert(String(await page.eval('document.getElementById("phContinue").textContent')).includes('"Send messages, stop turns and continue chats"'));
      assert(await page.eval(NO_SIDEWAYS), `Send off: sideways scroll ${await page.eval(WIDTHS)}`);
      await pc(s, "POST", "/api/live/devices/scopes", {
        id: phone.id,
        scopes: ["phone.read", "phone.answer", "phone.prompt", "phone.approve"],
      });
      await page.waitFor('!!document.getElementById("phContinueBtn")', 15000, "Continue back");

      // Continue: the live chat with its composer
      await page.click("#phContinueBtn");
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "chat" && window.__aibPhone.chatId === "c-new" && !!document.getElementById("phComposer")',
        15000,
        "the live chat",
      );
      assert(await page.eval(NO_SIDEWAYS), `continued: sideways scroll ${await page.eval(WIDTHS)}`);
      // its end is on screen: marked read on the PC
      await until(() => s.ctx.readState.public().chats["claude:s-long"]?.seenAt > 0, "read on the PC", 15);
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'phone page at 375 px: approvals and questions are cards in the chat (open when newest, closed after newer activity, open from a notification, Show bar), inline answer and Allow once reach the agent, then a one-line record; no bottom sheet; composer, Stop, queue; switches off hide them',
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      const main = longChat();
      const long = "npm run e2e -- --update-snapshots --reporter=verbose " +
        "C:\\Users\\someone\\code\\a-very-long-project-folder-name\\src\\components\\checkout\\PaymentStepWithAVeryLongName.test.tsx " +
        "x".repeat(120);
      main.attention = { ...main.attention, state: "needs_you", needs: 1 };
      main.permissions = [{
        key: "perm1",
        params: {
          toolCall: {
            title: "Run the end-to-end tests",
            rawInput: { command: long },
          },
          options: [
            { optionId: "yes", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Allow always", kind: "allow_always" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      }];
      main.events.push({ seq: main.events.length + 1, kind: "permission", time: main.events.length + 1, data: { key: "perm1", params: (main.permissions[0] as Json).params } });
      main.queue = {
        items: [{
          id: "q1",
          text: "then update the docs",
          attachments: [],
          sending: false,
          editing: false,
        }],
        paused: false,
      };
      const blog: FakeChat = {
        id: "blog",
        provider: "codex",
        sessionId: "sess-blog",
        cwd: "C:\\code\\blog",
        busy: false,
        closed: false,
        attention: {
          state: "needs_you",
          needs: 1,
          turnEndedAt: null,
          busySince: null,
        },
        subagents: {},
        breadth: { sessionInfo: { title: "Blog site" } },
        events: [{ seq: 1, kind: "user", data: { text: "Convert the posts" } }, { seq: 2, kind: "elicitation", data: { key: "q1", params: { message: "Which date format for posts?" } } }],
        permissions: [],
        elicitations: [{
          key: "q1",
          params: {
            mode: "form",
            message: "Which date format for posts?",
            requestedSchema: {
              type: "object",
              properties: {
                format: {
                  type: "string",
                  title: "Date format",
                  oneOf: [{ const: "long", title: "12 November 2026" }, {
                    const: "iso",
                    title: "2026-11-12",
                  }],
                },
                note: { type: "string", title: "Anything else" },
              },
              required: ["format"],
            },
          },
        }],
      };
      s.chats.push(main, blog);
      // the fake agent host: an answered request goes away, a queued message joins the queue
      s.answerLive((name, body) => {
        const c = s.chats.find((x) => x.id === body.id)!;
        if (name === "elicitation") c.elicitations = [];
        if (name === "permission") c.permissions = [];
        if (name === "elicitation" || name === "permission") {
          c.attention = { ...c.attention, state: "idle", needs: 0 };
        }
        if (name === "queue-remove") {
          (c.queue as Json).items = ((c.queue as Json).items as Json[]).filter((
            i,
          ) => i.id !== body.messageId);
        }
        if (name === "queue") {
          ((c.queue as Json).items as Json[]).push({
            id: "q2",
            text: body.text,
            attachments: [],
            sending: false,
            editing: false,
          });
        }
        return [200, { ok: true }];
      });
      const phone = await pairPhone(s);
      const page = await browser.open("about:blank", 375, 812);
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true,
      });
      const up = { on: true };
      await serveFor(page, s, up);
      await signInPage(page, phone.token, phone.id);
      assert(
        await page.eval(NO_SIDEWAYS),
        `home: sideways scroll ${await page.eval(WIDTHS)}`,
      );

      // a question is a card IN the chat (no sheet over it), open because it is the newest thing there
      await page.click('.ph-card[data-chat="blog"]');
      await page.waitFor(
        '!!document.querySelector(\'.ph-req.open[data-req="q1"]\')',
        15000,
        "the open question card",
      );
      assertEquals(
        await page.eval(
          '[document.querySelectorAll("#phSheet, .ph-sheet, .ph-dim, .ph-sheet-wrap, #app [role=dialog]").length, document.querySelector(\'.ph-req[data-req="q1"] .ph-rt b\').textContent]',
        ),
        [0, "Needs you · question"],
        "no bottom sheet",
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `question card: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      const opts = await page.eval<number[]>(
        '[...document.querySelectorAll(\'.ph-req[data-req="q1"] .ph-opt\')].map((b) => b.getBoundingClientRect().height)',
      );
      assert(
        opts.length === 2 && opts.every((h) => h >= 44),
        `choices are big targets: ${opts}`,
      );
      await page.shot("phone-question-card");
      await page.click('[data-answer="q1"]'); // nothing picked: it says what is missing, nothing is sent
      await page.waitFor(
        'document.querySelector(\'.ph-req[data-req="q1"] .ph-error\')?.textContent === "Fill in: Date format."',
        5000,
        "missing",
      );
      const before = s.liveCalls.length;
      await page.click('.ph-req[data-req="q1"] [data-field="format"] button:last-of-type');
      await page.click("#phField-q1-note");
      await page.type("Use the long one on the home page");
      assertEquals(
        await page.eval(
          'getComputedStyle(document.getElementById("phField-q1-note")).fontSize',
        ),
        "16px",
      );
      assertEquals(s.liveCalls.length, before);
      await page.click('[data-answer="q1"]');
      // after acting, the card shrinks to a one-line record
      await page.waitFor(
        '!!document.querySelector(\'.ph-req.done[data-req="q1"]\')',
        15000,
        "the record",
      );
      assertEquals(s.liveCalls.at(-1), ["elicitation", {
        id: "blog",
        key: "q1",
        action: "accept",
        content: { format: "iso", note: "Use the long one on the home page" },
      }]);
      assertEquals(
        await page.eval('document.querySelector(\'.ph-req.done[data-req="q1"]\').textContent'),
        "✓You answered from this phone: 2026-11-12, Use the long one on the home page",
      );
      await sleep(3500); // a poll: the request is gone on the PC, the record stays
      assert(await page.eval('!!document.querySelector(\'.ph-req.done[data-req="q1"]\')'), "the record stays");

      // the main chat: an approval card, open because it is the newest thing; two big buttons and the long command wraps
      await page.click(".ph-back");
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "home"',
        15000,
        "home",
      );
      await page.click('.ph-card[data-chat="main"]');
      await page.waitFor(
        '!!document.querySelector(\'.ph-req.open[data-req="perm1"]\')',
        15000,
        "the open approval card",
      );
      const card = await page.eval<Json>(`(() => {
        const box = document.querySelector('.ph-req[data-req="perm1"]');
        const cmd = box.querySelector('.ph-cmd');
        const buttons = [...box.querySelectorAll('.ph-answer .ph-btn')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]);
        return { head: box.querySelector('.ph-rt b').textContent, cmdWraps: cmd.scrollWidth <= cmd.clientWidth, buttons,
          notes: [...box.querySelectorAll('.ph-note')].map((n) => n.textContent) };
      })()`);
      assertEquals(card.head, "Needs you · approval");
      assertEquals(card.buttons, [["Deny", 48], ["Allow once", 48]]);
      assert(card.cmdWraps, "the command wraps");
      assert((card.notes as string[]).includes("Other choices are on your PC."));
      assert(
        await page.eval(NO_SIDEWAYS),
        `approval card: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      await page.shot("phone-approval-card");
      // newer activity follows it: closed until tapped
      main.events.push({
        seq: main.events.length + 1,
        kind: "update",
        time: main.events.length + 1,
        data: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Meanwhile I read the rest." } } },
      });
      await page.waitFor(
        '!!document.querySelector(\'.ph-req[data-req="perm1"]:not(.open)\')',
        15000,
        "closed after newer activity",
      );
      // scrolled away from it: "Needs you · Show ↑" above the message box; a tap brings it back, open
      await page.eval("window.scrollTo(0, 0)");
      await page.waitFor('document.getElementById("phAbove") && !document.getElementById("phAbove").hidden', 5000, "the Show bar");
      assertEquals(
        await page.eval('document.getElementById("phAbove").textContent'),
        "Needs you · approval aboveShow ↑",
      );
      await page.eval('document.getElementById("phAbove").click(), true'); // a tap where it sits (page.click would scroll first)
      await page.waitFor(
        '(() => { const c = document.querySelector(\'.ph-req.open[data-req="perm1"]\'); if (!c) return false; const r = c.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()',
        5000,
        "open and in view",
      );
      // a notification tap lands on it open, even with newer activity after it
      await page.goto(`https://${NAME}/phone.html#chat=main&sheet=1`);
      await page.waitFor(
        '!!document.querySelector(\'.ph-req.open[data-req="perm1"]\')',
        15000,
        "opened from a notification",
      );
      await page.click('.ph-req[data-req="perm1"] [data-option="yes"]');
      await page.waitFor(
        '!!document.querySelector(\'.ph-req.done[data-req="perm1"]\')',
        15000,
        "the record",
      );
      assertEquals(s.liveCalls.at(-1), ["permission", {
        id: "main",
        key: "perm1",
        option: "yes",
      }]);
      assert(
        String(await page.eval('document.querySelector(\'.ph-req.done[data-req="perm1"]\').textContent'))
          .startsWith("✓You allowed once from this phone: npm run e2e"),
      );
      assertEquals(await page.eval('document.getElementById("phToast")?.textContent'), "Allowed once");

      // the composer at the bottom: 16 px text, Stop while working; typing survives the 3 s polls
      const bar = await page.eval<Json>(`(() => {
        const f = document.getElementById('phComposer').getBoundingClientRect();
        return { bottom: Math.round(f.bottom), height: innerHeight, font: getComputedStyle(document.getElementById('phPrompt')).fontSize,
          stop: !document.getElementById('phStop').hidden };
      })()`);
      assertEquals([bar.bottom, bar.font, bar.stop], [
        bar.height,
        "16px",
        true,
      ]);
      await page.click("#phPrompt");
      await page.type("Also check the mobile layout");
      await sleep(3500);
      assertEquals(
        await page.eval(
          '[document.activeElement.id, document.getElementById("phPrompt").value]',
        ),
        ["phPrompt", "Also check the mobile layout"],
        "the text and the caret stay through a poll",
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `chat with composer: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      await page.click("#phSend");
      await page.waitFor(
        'document.getElementById("phPrompt").value === ""',
        15000,
        "sent",
      );
      assertEquals(
        s.liveCalls.at(-1)?.[0],
        "queue",
        "a working chat queues the message",
      );
      assertEquals(
        (s.liveCalls.at(-1)?.[1] as Json).text,
        "Also check the mobile layout",
      );
      await page.waitFor(
        'document.querySelectorAll(".ph-queued").length === 2',
        15000,
        "the queued message shows",
      );
      await page.shot("phone-chat-composer-queue");
      assertEquals(
        await page.eval(
          '[...document.querySelectorAll(".ph-queued[data-queued=q1] .ph-btn")].map((b) => b.textContent)',
        ),
        ["Edit", "Remove", "Send now"],
      );
      await page.click('.ph-queued[data-queued="q1"] [data-act="remove"]');
      await page.waitFor(
        'document.querySelectorAll(".ph-queued").length === 1',
        15000,
        "removed",
      );
      assertEquals(s.liveCalls.at(-1), ["queue-remove", {
        id: "main",
        messageId: "q1",
      }]);
      await page.click("#phStop");
      await until(() => s.liveCalls.at(-1)?.[0] === "cancel", "Stop", 10);
      assertEquals(s.liveCalls.at(-1), ["cancel", { id: "main" }]);

      // switches off on the PC: the composer, Stop and the queue buttons go away at the next poll
      main.permissions = [{
        key: "perm2",
        params: {
          toolCall: { title: "Run lint" },
          options: [{
            optionId: "yes",
            name: "Allow once",
            kind: "allow_once",
          }],
        },
      }];
      main.attention = { ...main.attention, state: "needs_you", needs: 1 };
      await pc(s, "POST", "/api/live/devices/scopes", {
        id: phone.id,
        scopes: ["phone.read"],
      });
      await page.waitFor(
        '!document.getElementById("phComposer") && !!document.querySelector(\'.ph-req.open[data-req="perm2"]\')',
        15000,
        "controls hidden",
      );
      assertEquals(
        await page.eval(
          'document.querySelectorAll(".ph-req .ph-btn, .ph-queued .ph-btn").length',
        ),
        0,
      );
      assert(
        await page.eval(
          'document.body.textContent.includes("Sending from this phone is off.")',
        ),
      );
      assert(
        await page.eval(
          'document.querySelector(\'.ph-req[data-req="perm2"]\').textContent.includes("Allowing from this phone is off.")',
        ),
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `switches off: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      await page.shot("phone-switches-off");

      // on again, then the PC can't be reached: nothing to send or answer while offline
      await pc(s, "POST", "/api/live/devices/scopes", {
        id: phone.id,
        scopes: ["phone.read", "phone.prompt", "phone.approve", "phone.answer"],
      });
      await page.waitFor(
        '!!document.getElementById("phComposer") && !!document.querySelector(".ph-req .ph-btn")',
        15000,
        "controls back",
      );
      up.on = false;
      await page.waitFor(
        '!!document.querySelector(".ph-offline")',
        15000,
        "offline",
      );
      assertEquals(
        await page.eval(
          '[!!document.getElementById("phComposer"), document.querySelectorAll(".ph-req .ph-btn, .ph-queued .ph-btn").length]',
        ),
        [false, 0],
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `offline: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      assertEquals(page.errors, [], "console errors");
      assertEquals(page.csp, [], "CSP violations");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "PC: Settings > Devices shows each phone's switches (a change is saved at once) and Phone activity with the chat's title",
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      s.chats.push({
        id: "c1",
        provider: "claude",
        sessionId: "sess-c1",
        cwd: "C:\\code\\shop",
        busy: false,
        closed: false,
        attention: {
          state: "idle",
          needs: 0,
          turnEndedAt: null,
          busySince: null,
        },
        subagents: {},
        breadth: { sessionInfo: { title: "Checkout redesign" } },
        events: [],
        permissions: [],
        elicitations: [],
      });
      const phone = await pairPhone(s, "Pixel 9", [
        "phone.read",
        "phone.answer",
      ]);
      const sent = await raw(
        s.phonePort(),
        "POST",
        "/api/remote/prompt",
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, "POST"),
        JSON.stringify({ id: "c1", text: "hello", clientMessageId: "m1" }),
      );
      assertEquals(sent.status, 403, "Send is off for this phone");
      const page = await browser.open("about:blank", 1280, 900);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor(
        '!!document.getElementById("openSettings")',
        15000,
        "chat page",
      );
      await page.click("#openSettings");
      await page.waitFor(
        `document.body.classList.contains('settings-open')`,
        8000,
        "settings open",
      );
      await page.eval(
        `[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'Devices').click()`,
      );
      const row = `.dv-device[data-device="${phone.id}"]`;
      await page.waitFor(
        `!!document.querySelector('${row} input[data-scope="phone.prompt"]')`,
        8000,
        "the phone's switches",
      );
      assertEquals(
        await page.eval(
          `[...document.querySelectorAll('${row} input[data-scope]')].map((i) => [i.dataset.scope, i.checked, i.disabled])`,
        ),
        [
          ["phone.read", true, true],
          ["phone.answer", true, false],
          ["phone.prompt", false, false],
          ["phone.approve", false, false],
          ["phone.push", false, false],
        ],
      );
      await page.click(`${row} input[data-scope="phone.prompt"]`);
      await until(
        async () => {
          const [, v] = await pc(s, "GET", "/api/live/devices");
          return ((v.devices as Json[])[0].scopes as string[]).includes(
            "phone.prompt",
          );
        },
        "the switch is saved",
        10,
      );
      await page.waitFor(
        `document.querySelector('${row} input[data-scope="phone.prompt"]').checked`,
        8000,
        "drawn on",
      );
      const again = await raw(
        s.phonePort(),
        "POST",
        "/api/remote/prompt",
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, "POST"),
        JSON.stringify({ id: "c1", text: "hello", clientMessageId: "m2" }),
      );
      assertEquals(again.status, 200, "Send is on now");
      await page.eval(
        `[...document.querySelectorAll('.dv-slot button')].find((b) => b.textContent === 'Phone activity').click()`,
      );
      const lines = await page.waitFor(
        `(() => { const l = [...document.querySelectorAll('.dv-activity p')].map((p) => p.textContent); return l.length > 3 ? l : null; })()`,
        8000,
        "Phone activity",
      ) as string[];
      assert(
        lines.some((l) =>
          l.endsWith('· Pixel 9 · send · "Checkout redesign": done')
        ),
        lines.join("\n"),
      );
      assert(
        lines.some((l) =>
          l.endsWith(
            '· Pixel 9 · send · "Checkout redesign": refused: switched off',
          )
        ),
        lines.join("\n"),
      );
      assert(!lines.join("\n").includes("hello"), "no message text");
      await page.shot("pc-devices-switches");
      assertEquals(page.errors, [], "console errors");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

/**
 * chat.html at 375 px is laid out as before phone access (no phone layout by width, no phone files). These numbers were measured
 * at the base of this change (integration/beta8 c3f1b05); change them only when chat.html's narrow layout is meant to change.
 */
const CHAT_HTML_375 = { scrollWidth: 490, columns: "170px 320px" };

Deno.test({
  ...OPTS,
  name:
    "chat.html at 375 px is unchanged: same layout, and no phone page file is loaded",
  ignore: !browserPath,
  async fn() {
    const s = await remoteStudio();
    const browser = await Browser.launch();
    try {
      const page = await browser.open("about:blank", 375, 812);
      await page.goto(`http://127.0.0.1:${s.port}/chat.html`);
      await page.waitFor(
        '!!document.getElementById("messages")',
        15000,
        "chat page",
      );
      await sleep(1000);
      const got = await page.eval<
        { scrollWidth: number; columns: string; files: string[] }
      >(`(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        columns: getComputedStyle(document.body).gridTemplateColumns,
        files: performance.getEntriesByType('resource').map((r) => new URL(r.name).pathname),
      }))()`);
      assertEquals(
        got.files.filter((f) => /phone/.test(f)),
        [],
        "no phone page file",
      );
      if (Deno.env.get("AIB_PRINT_LAYOUT")) console.log(JSON.stringify(got));
      assertEquals(
        { scrollWidth: got.scrollWidth, columns: got.columns },
        CHAT_HTML_375,
      );
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

// ---- phase C: Finish setup, notifications, the iPhone step ---------------------------------------------------------------------

/** A browser's notification and push parts, faked in the page (a headless browser has no push service): permission asked only by a
 * tap, the subscription made with the PC's key. The permission is kept in sessionStorage, as a browser keeps it across loads. */
function pushStubs(p256dh: string, auth: string): string {
  const sub = JSON.stringify({
    endpoint: "https://fcm.googleapis.com/fcm/send/aib-test",
    expirationTime: null,
    keys: { p256dh, auth },
  });
  return `(() => {
    const key = 'aib-test-permission';
    window.__asked = 0;
    window.__subscribed = 0;
    let sub = null;
    const reg = { pushManager: {
      getSubscription: () => Promise.resolve(sub),
      subscribe: (o) => {
        window.__subscribed++;
        sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/aib-test', options: { applicationServerKey: o.applicationServerKey.buffer },
          toJSON: () => (${sub}), unsubscribe: () => Promise.resolve(true) };
        return Promise.resolve(sub);
      } } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true,
      value: { register: () => Promise.resolve(reg), ready: Promise.resolve(reg), addEventListener() {} } });
    window.PushManager = function PushManager() {};
    window.Notification = function Notification() {};
    Object.defineProperty(window.Notification, 'permission', { get: () => sessionStorage.getItem(key) || 'default' });
    window.Notification.requestPermission = () => {
      window.__asked++;
      sessionStorage.setItem(key, 'granted');
      return Promise.resolve('granted');
    };
  })()`;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const STEPS =
  '[...document.querySelectorAll(".ph-step")].map((x) => [x.dataset.step, x.dataset.state])';

Deno.test({
  ...OPTS,
  name:
    "phone page at 375 px: Finish setup turns notifications on from a tap; subscribes again on every open; iPhone step on iPhone only",
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      s.chats.push(longChat());
      const phone = await pairPhone(s);
      const keys = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const b64u = (b: Uint8Array) =>
        btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_")
          .replace(/=+$/, "");
      const p256dh = b64u(
        new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
      );
      const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));

      // Android (not an iPhone): one step and its button; no permission prompt until it is tapped
      const page = await browser.open("about:blank", 375, 812);
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: pushStubs(p256dh, auth),
      });
      await serveFor(page, s, { on: true });
      await signInPage(page, phone.token, phone.id);
      assert(
        await page.eval('!!document.getElementById("setupOpen")'),
        "home offers notifications while they are off",
      );
      assertEquals(
        await page.eval("window.__asked"),
        0,
        "never asked without a tap",
      );
      await page.click("#setupOpen");
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "setup"',
        15000,
        "finish setup",
      );
      assertEquals(await page.eval(STEPS), [["notify", "todo"]]);
      assert(
        await page.eval(NO_SIDEWAYS),
        `setup: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      await page.click("#pushOn");
      await page.waitFor(
        'document.querySelector(".ph-step")?.dataset.state === "done"',
        15000,
        "notifications on",
      );
      assertEquals(await page.eval("window.__asked"), 1);
      const [, view] = await pc(s, "GET", "/api/live/devices");
      assertEquals(
        (view.devices as Json[]).map((d) => d.pushOn),
        [true],
        "the PC has the subscription",
      );
      const stored = s.ctx.devices.pushTargets()[0].push;
      assertEquals([stored.endpoint, stored.p256dh, stored.auth], [
        "https://fcm.googleapis.com/fcm/send/aib-test",
        p256dh,
        auth,
      ]);
      await page.click("#setupDone");
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "home"',
        15000,
        "home",
      );
      assert(
        await page.eval('!document.getElementById("setupOpen")'),
        "no setup offer once notifications are on",
      );
      // every page open subscribes again (here the PC lost the subscription; new keys after Remove all work the same way)
      await s.ctx.devices.setPush(phone.id, null);
      await page.goto(`https://${NAME}/phone.html`);
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "home"',
        15000,
        "home again",
      );
      await until(
        () => s.ctx.devices.pushTargets().length === 1,
        "subscribed again on open",
        15,
      );
      assertEquals(
        await page.eval("window.__asked"),
        0,
        "no prompt on open (already allowed)",
      );
      // a push's link opens the chat with its sheet
      await page.goto(`https://${NAME}/phone.html#chat=main&sheet=1`);
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "chat"',
        15000,
        "the chat from a push",
      );
      assertEquals(await page.eval("location.hash"), "");
      assertEquals(page.errors, [], "console errors");
      assertEquals(page.csp, [], "CSP violations");
      await page.close();

      // iPhone: the Home Screen step first; no notification button until AIB is opened from the Home Screen
      const ios = await browser.open("about:blank", 375, 812);
      await ios.send("Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 812,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await ios.send("Emulation.setUserAgentOverride", {
        userAgent: IPHONE_UA,
        platform: "iPhone",
      });
      await ios.send("Page.addScriptToEvaluateOnNewDocument", {
        source: pushStubs(p256dh, auth),
      });
      await serveFor(ios, s, { on: true });
      await signInPage(ios, phone.token, phone.id);
      await ios.click("#setupOpen");
      await ios.waitFor(
        'document.getElementById("app").dataset.screen === "setup"',
        15000,
        "finish setup on iPhone",
      );
      assertEquals(await ios.eval(STEPS), [["home", "todo"], [
        "notify",
        "todo",
      ]]);
      assert(
        await ios.eval(
          'document.body.textContent.includes("Add to Home Screen")',
        ),
      );
      assert(
        await ios.eval('!document.getElementById("pushOn")'),
        "iPhone: notifications only from the Home Screen app",
      );
      assert(
        await ios.eval(NO_SIDEWAYS),
        `iPhone setup: sideways scroll ${await ios.eval(WIDTHS)}`,
      );
      assertEquals(ios.errors, [], "console errors");
      await ios.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "phone page at 375 px: no banner on the chat list; inside a chat, another chat needing you or finishing -> a banner, no push; tap opens it at its card; finished goes after 10 s; hidden -> left",
  ignore: !browserPath,
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    const browser = await Browser.launch();
    const pushes: Json[] = [];
    const push = s.ctx.phone.push as unknown as {
      any: () => boolean;
      send: (m: Json) => Promise<unknown>;
    };
    push.any = () => true;
    push.send = (m) => (pushes.push(m), Promise.resolve([]));
    const watcher = startAttention(s.ctx, { pollMs: 100 });
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!);
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      const main = longChat();
      const blog: FakeChat = {
        id: "blog",
        provider: "codex",
        sessionId: "sess-blog",
        cwd: "C:\code\blog",
        busy: true,
        closed: false,
        attention: {
          state: "working",
          needs: 0,
          turnEndedAt: null,
          busySince: null,
        },
        subagents: {},
        breadth: { sessionInfo: { title: "Blog site" } },
        events: [{ seq: 1, kind: "user", data: { text: "Convert the posts" } }],
        permissions: [],
        elicitations: [],
      };
      s.chats.push(main, blog);
      const phone = await pairPhone(s);
      const page = await browser.open("about:blank", 375, 812);
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await serveFor(page, s, { on: true });
      await signInPage(page, phone.token, phone.id);
      // on the chat list: another chat finishing shows no banner (its card's state says it)
      blog.busy = false;
      blog.attention = { state: "idle", needs: 0, turnEndedAt: new Date().toISOString(), busySince: null };
      await page.waitFor(
        'document.querySelector(\'.ph-card[data-chat="blog"] .ph-state\')?.textContent === "Idle"',
        15000,
        "blog finished on its card",
      );
      await sleep(5000); // the finished turn settles (3 s) and the next polls come
      assertEquals(await page.eval('document.querySelectorAll(".ph-banner").length'), 0, "no banner on the chat list");
      assertEquals(pushes, [], "no push while the phone is in hand");
      // on the main chat (a link opens it, as a push would)
      await page.eval(`location.hash = "#chat=${main.id}"`);
      await page.waitFor(
        `window.__aibPhone.screen === "chat" && window.__aibPhone.chatId === "${main.id}"`,
        10000,
        "the main chat",
      );
      // the blog chat asks a question
      blog.elicitations = [{
        key: "q1",
        params: {
          mode: "form",
          message: "Which date format for posts?",
          requestedSchema: {
            type: "object",
            properties: { format: { type: "string", title: "Date format" } },
            required: ["format"],
          },
        },
      }];
      blog.attention = { ...blog.attention, state: "needs_you", needs: 1 };
      await page.waitFor(
        '!!document.querySelector(".ph-banner.need")',
        15000,
        "the banner",
      );
      assertEquals(
        await page.eval<string>(
          'document.querySelector(".ph-banner-open").textContent',
        ),
        "A chat needs youBlog site",
      );
      assert(
        await page.eval(NO_SIDEWAYS),
        `banner: sideways scroll ${await page.eval(WIDTHS)}`,
      );
      assertEquals(pushes, [], "no push while the phone is in hand");
      // the tap opens that chat at its question card, open; the banner goes
      await page.click(".ph-banner-open");
      await page.waitFor(
        'window.__aibPhone.chatId === "blog" && !!document.querySelector(\'.ph-req.open[data-req="q1"]\')',
        10000,
        "the blog chat with its question card open",
      );
      assertEquals(await page.eval('!document.querySelector(".ph-banner")'), true);
      // the main chat finishes: "Chat finished" names it, and goes by itself after 10 s
      main.busy = false;
      main.attention = { state: "idle", needs: 0, turnEndedAt: new Date().toISOString(), busySince: null };
      await page.waitFor(
        '!!document.querySelector(".ph-banner.turn")',
        15000,
        "the finished banner",
      );
      assertEquals(
        await page.eval<string>('document.querySelector(".ph-banner-open").textContent'),
        "Chat finishedMain · checkout redesign",
      );
      const shown = Date.now();
      await page.waitFor('!document.querySelector(".ph-banner")', 15000, "the finished banner goes by itself");
      assert(Date.now() - shown >= 7000, "after about 10 s");
      assertEquals(pushes, [], "no push while the phone is in hand");
      // the page is hidden: the PC knows at once (no waiting for the 15 s)
      assertEquals(s.ctx.presence.phones().map((p) => p.chat), ["blog"]);
      await page.eval(
        `Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); true`,
      );
      const deadline = Date.now() + 5000;
      while (s.ctx.presence.phones().length && Date.now() < deadline) await sleep(50);
      assertEquals(s.ctx.presence.phones(), [], "left");
    } finally {
      await watcher.stop();
      await browser.close();
      await s.close();
    }
  },
});
