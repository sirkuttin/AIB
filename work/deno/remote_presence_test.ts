/**
 * Where the owner is looking (attention/presence.ts): a phone page that is on screen tells the PC through its polls, through the
 * phone port with forged Tailscale Serve headers, as a real phone would; the AttentionWatcher (startAttention, in-process Studio,
 * fake agent host) then decides:
 *   - the phone shows chat X and X finishes: no push, no desktop notification, X is marked read on the PC (the owner's report:
 *     "I had the chat open on my phone yet the desktop app sent a notification");
 *   - the phone stopped polling (hidden, no "left") for longer than PHONE_TTL_MS: pushed as before; "left" ends it at once;
 *   - the phone on home, or on chat Y, and X needs you: a banner in the phone's next poll answer, no push; the PC's desktop
 *     notification follows the PC's own rules;
 *   - working at the PC on X: no desktop notification, no push.
 * Desktop notifications and pushes are recorded (no real notification is shown, nothing is sent).
 */
import { assert, assertEquals } from "./_assert.ts";
import { DEVICE_HEADER } from "../../outputs/agent-studio/server/remote/server.ts";
import { readRemotePort } from "../../outputs/agent-studio/server/remote/port.ts";
import { PHONE_TTL_MS } from "../../outputs/agent-studio/server/attention/presence.ts";
import { startAttention } from "../../outputs/agent-studio/server/attention/watcher.ts";
import {
  type FakeChat,
  fakeTailscale,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  remoteStudio,
  serveStatus,
} from "./_remote_fixture.ts";

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chat(id: string, title: string): FakeChat {
  return {
    id,
    provider: "claude",
    sessionId: "s-" + id,
    cwd: "C:\\code\\" + id,
    busy: true,
    closed: false,
    attention: {
      state: "working",
      needs: 0,
      turnEndedAt: null,
      busySince: new Date().toISOString(),
    },
    subagents: {},
    breadth: { sessionInfo: { title } },
    events: [{
      seq: 1,
      time: Date.now() / 1000,
      kind: "user",
      data: { text: "go" },
    }],
    permissions: [],
    elicitations: [],
  };
}

const finish = (c: FakeChat) => {
  c.busy = false;
  c.events.push({
    seq: c.events.length + 1,
    time: Date.now() / 1000,
    kind: "agent_message",
    data: { text: "Done." },
  });
  c.attention = {
    state: "idle",
    needs: 0,
    turnEndedAt: new Date().toISOString().slice(0, 19) + "Z",
    busySince: null,
  };
};
const needYou = (c: FakeChat, key: string) => {
  c.busy = false;
  c.permissions.push({ key, params: {} });
  c.events.push({
    seq: c.events.length + 1,
    time: Date.now() / 1000,
    kind: "permission",
    data: { key },
  });
  c.attention = {
    state: "needs_you",
    needs: c.permissions.length,
    turnEndedAt: null,
    busySince: null,
  };
};

/** A Studio with phone access on, one paired phone, the watcher running, desktop notifications and pushes recorded. */
async function lab() {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals(
    (await pc(s, "POST", "/api/live/devices/access", { on: true }))[0],
    200,
  );
  const phone = await pairPhone(s);
  const desktop: Json[] = [];
  const pushes: Json[] = [];
  s.ctx.desktopNotify = {
    mechanism: "test",
    show: (req: Json) => (desktop.push(req), Promise.resolve({ shown: true })),
  } as never;
  const push = s.ctx.phone.push as unknown as {
    any: () => boolean;
    send: (m: Json) => Promise<unknown>;
  };
  push.any = () => true;
  push.send = (m) => (pushes.push(m), Promise.resolve([]));
  // Needs you and Your turn on the desktop (the app's choice), so a turn's desktop notification would show
  await pc(s, "POST", "/api/live/view-prefs", {
    set: { "studio-notifications-app": JSON.stringify({ notifyFor: "both" }) },
  });
  const watcher = startAttention(s.ctx, { pollMs: 100 });
  const notices: Json[] = [];
  let polling = "";
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const get = async (path: string) => {
    const r = await raw(
      s.phonePort(),
      "GET",
      path,
      phoneHeaders({ [DEVICE_HEADER]: phone.token }),
    );
    for (const n of (r.json.notices as Json[] | undefined) ?? []) {
      notices.push(n);
    }
    return r;
  };
  /** The phone page on screen: polls this path every second (phone.js polls every 3-4 s), until stop(). */
  const show = async (path: string) => {
    polling = path;
    if (!timer) {
      const loop = async () => {
        if (polling) await get(polling).catch(() => {});
        if (polling) timer = setTimeout(loop, 1000);
        else timer = 0;
      };
      await get(path);
      timer = setTimeout(loop, 1000);
    }
  };
  return {
    s,
    phone,
    desktop,
    pushes,
    notices,
    get,
    show,
    /** The page was hidden: no more polls (no "left" beacon). */
    hide() {
      polling = "";
      clearTimeout(timer);
      timer = 0;
    },
    left: () =>
      raw(
        s.phonePort(),
        "POST",
        "/api/remote/left",
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, "POST"),
      ),
    async until(what: () => boolean, ms = 10_000) {
      const deadline = Date.now() + ms;
      while (!what() && Date.now() < deadline) await sleep(50);
      return what();
    },
    async close() {
      polling = "";
      clearTimeout(timer);
      await watcher.stop();
      await s.close();
    },
  };
}

Deno.test({
  ...OPTS,
  name:
    "presence: the phone shows chat X and X finishes -> no push, no desktop notification, X marked read on the PC",
  async fn() {
    const t = await lab();
    try {
      const x = chat("c1", "Blog site");
      t.s.chats.push(x);
      await t.show("/api/remote/chat?id=c1&tail=50");
      await sleep(300);
      finish(x);
      const ended = Date.parse(x.attention.turnEndedAt as string);
      // the watcher waits SETTLE_MS (3 s) before "finished": then it decides
      assert(
        await t.until(() =>
          (t.s.ctx.readState.public().chats["claude:s-c1"]?.seenAt ?? 0) >=
            ended
        ),
        "X is marked read on the PC",
      );
      await sleep(1500);
      assertEquals(t.pushes, [], "no push");
      assertEquals(t.desktop, [], "no desktop notification");
      // the PC page reads the same position (its unread dot: turn end <= seenAt)
      const [, read] = await pc(t.s, "GET", "/api/live/read-state");
      assert(
        ((read.chats as Json)["claude:s-c1"] as Json).seenAt as number >= ended,
      );
      // what was held back is on the record for this time on screen (presence.ts suppressed)
      assertEquals(
        t.s.ctx.presence.suppressed(t.phone.id).map((
          h,
        ) => [h.kind, h.chat, h.onScreen]),
        [["turn", "c1", true]],
      );
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'presence: a phone that stopped polling for longer than the TTL is not looking -> pushed as before; "left" ends it at once',
  async fn() {
    const t = await lab();
    try {
      const x = chat("c1", "Blog site");
      const y = chat("c2", "Shop");
      t.s.chats.push(x, y);
      await t.show("/api/remote/chat?id=c1&tail=50");
      await sleep(200);
      t.hide(); // screen off: no more polls, no beacon
      await sleep(PHONE_TTL_MS + 500);
      assertEquals(t.s.ctx.presence.phones(), [], "expired");
      finish(x);
      assert(await t.until(() => t.pushes.length === 1), "pushed");
      assertEquals(t.pushes[0], {
        title: "Chat finished",
        body: "Blog site",
        tag: "aib-attention",
        chat: "c1",
        sheet: false,
      });
      assertEquals(
        t.desktop.length,
        1,
        "and the desktop notification, as before",
      );
      // on screen again, then the page is hidden and says so: the next news is pushed at once
      await t.show("/api/remote/chat?id=c2&tail=50");
      t.hide();
      assertEquals((await t.left()).status, 200);
      assertEquals(t.s.ctx.presence.phones(), []);
      needYou(y, "k1");
      assert(await t.until(() => t.pushes.length === 2), 'pushed after "left"');
      // within 60 s of the first: one push replacing it (the usual grouping), naming both chats
      assertEquals([t.pushes[1].title, t.pushes[1].body], [
        "2 chats are waiting for you",
        "Blog site\nShop",
      ]);
      assertEquals(t.notices, []);
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "presence: phone on home, chat X needs you -> a banner in the next poll, no push; the PC desktop follows the PC rules",
  async fn() {
    const t = await lab();
    try {
      const x = chat("c1", "Blog site");
      t.s.chats.push(x);
      await t.show("/api/remote/home");
      await sleep(300);
      needYou(x, "k1");
      assert(
        await t.until(() => t.notices.length === 1),
        "banner news in a home poll",
      );
      assertEquals(t.notices[0], {
        chat: "c1",
        kind: "needs",
        title: "Blog site",
      });
      await sleep(1500);
      assertEquals(t.pushes, [], "no push while the phone is in hand");
      assertEquals(
        t.desktop.map((d) => d.title),
        ["Blog site"],
        "the PC has no focus: its desktop notification",
      );
      assertEquals(t.notices.length, 1, "once");
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "presence: phone on chat Y, chat X needs you -> a banner in the chat poll, no push; with the PC focused, no desktop notification either",
  async fn() {
    const t = await lab();
    try {
      const x = chat("c1", "Blog site");
      const y = chat("c2", "Shop");
      t.s.chats.push(x, y);
      await t.show("/api/remote/chat?id=c2&tail=50");
      await sleep(300);
      needYou(x, "k1");
      assert(await t.until(() => t.notices.length === 1));
      assertEquals(t.notices[0], {
        chat: "c1",
        kind: "needs",
        title: "Blog site",
      });
      await sleep(1000);
      assertEquals(t.pushes, []);
      assertEquals(
        t.s.ctx.readState.public().chats["claude:s-c1"],
        undefined,
        "another chat is not marked read",
      );
      // the PC focused (idle): no desktop notification either; still no push (the phone is in hand)
      t.s.ctx.presence.report(true, 600_000);
      needYou(x, "k2");
      assert(await t.until(() => t.notices.length === 2));
      await sleep(800);
      assertEquals([t.pushes.length, t.desktop.length], [0, 1]);
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "presence: working at the PC on chat X -> no desktop notification and no push for X",
  async fn() {
    const t = await lab();
    try {
      const x = chat("c1", "Blog site");
      t.s.chats.push(x);
      // the PC page: window focused, input just now (POST /api/live/presence, as notify-ui.js sends it)
      assertEquals(
        (await pc(t.s, "POST", "/api/live/presence", {
          focused: true,
          idleMs: 0,
        }))[0],
        200,
      );
      finish(x);
      await sleep(4500);
      needYou(x, "k1");
      await sleep(1500);
      assertEquals([t.pushes.length, t.desktop.length], [0, 0]);
      // the watcher did announce both (so "nothing sent" is the presence rule, not silence)
      const fired = Object.keys(
        JSON.parse(Deno.readTextFileSync(`${t.s.state}/attention-fired.json`))
          .fired,
      );
      assert(
        fired.some((k) => k.startsWith("turn|claude:s-c1|")) &&
          fired.some((k) => k.startsWith("needs|claude:s-c1|")),
        fired.join(),
      );
    } finally {
      await t.close();
    }
  },
});
