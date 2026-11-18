/**
 * Buttons on phone notifications (0.13) end to end: an AIB with a fake agent host and its server-built inbox, a paired phone whose
 * push subscription points at a fake push service (nothing ever goes to a real push service or phone), and each push decrypted as
 * the phone's browser would (RFC 8291).
 *  1. Server: a push about one chat carries its row key, its two buttons and a one-time code for that phone. POST
 *     /api/remote/notify-act approves an ordinary request with its allow_once option; refuses a forged Allow for a risky command,
 *     a phone without the button's switch, an expired code, a used one, another phone's; each one audited. A request answered on
 *     the PC sends that phone a "close" push.
 *  2. Headless Chrome with the real service worker (pwa/sw.js) on a loopback origin that plays Tailscale Serve: each decrypted push
 *     is dispatched as a push event, so the worker shows the notification with its buttons; notificationclick is dispatched with
 *     each action and the server's answer checked (approved; Retry sent; risky: no button, nothing approved; switch off and an
 *     expired code: refused, the phone page opens on the chat with a note; Reply opens the composer); a "close" push takes the
 *     answered notification away.
 */
import { assert, assertEquals } from "./_assert.ts";
import { DEVICE_HEADER } from "../../outputs/agent-studio/server/remote/server.ts";
import { readRemotePort } from "../../outputs/agent-studio/server/remote/port.ts";
import {
  fakeTailscale,
  LOGIN,
  NAME,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
} from "./_remote_fixture.ts";
import { liveChat } from "./_remote_v2b.ts";
import { Browser, browserPath, Page } from "./_doc_browser.ts";

Deno.env.set("AIB_TEST_PUSH_LOOPBACK", "1");

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const enc = new TextEncoder();
const ALL = [
  "phone.read",
  "phone.answer",
  "phone.prompt",
  "phone.approve",
  "phone.push",
];
const ONCE = [
  { optionId: "yes", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];
const needs = {
  state: "needs_you",
  needs: 1,
  turnEndedAt: null,
  busySince: null,
};
const perm = (key: string, command: string) => [{
  key,
  params: {
    toolCall: { toolCallId: `tc-${key}`, title: "Bash", rawInput: { command } },
    options: ONCE,
  },
}];
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const keyOf = (id: string) => `claude:sess-${id}`;

// ---- the phone's side of Web Push (as remote_push_test.ts: RFC 8291 written from the RFC) ---------------------------------------
const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
async function hmac(
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function phoneKeys(endpoint: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const pub = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    pub,
    auth,
    subscription: {
      endpoint,
      expirationTime: null,
      keys: { p256dh: b64url(pub), auth: b64url(auth) },
    },
  };
}
type Keys = Awaited<ReturnType<typeof phoneKeys>>;
async function decrypt(
  body: Uint8Array<ArrayBuffer>,
  phone: Keys,
): Promise<Json> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const record = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey },
      phone.pair.privateKey,
      256,
    ),
  );
  const prkKey = await hmac(phone.auth, shared);
  const ikm = await hmac(
    prkKey,
    cat(
      enc.encode("WebPush: info\0"),
      phone.pub,
      asPublic,
      new Uint8Array([1]),
    ),
  );
  const prk = await hmac(salt, ikm.slice(0, 32));
  const cek = (await hmac(
    prk,
    cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])),
  )).slice(0, 16);
  const nonce = (await hmac(
    prk,
    cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])),
  )).slice(0, 12);
  const key = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      key,
      record,
    ),
  );
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
}

/** A fake push service on a free port: records what the PC sends (never a real push service). */
function pushService() {
  const got: { path: string; body: Uint8Array<ArrayBuffer> }[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    got.push({
      path: new URL(request.url).pathname,
      body: new Uint8Array(await request.arrayBuffer()),
    });
    return new Response(null, { status: 201 });
  });
  const port = server.addr.port;
  const fetcher: typeof fetch = (input, init) =>
    fetch(String(input).replace(/^https:/, "http:"), init);
  return {
    got,
    fetcher,
    endpoint: (p: string) => `https://127.0.0.1:${port}${p}`,
    close: () => server.shutdown(),
  };
}

async function until(
  what: string,
  ok: () => boolean | Promise<boolean>,
  ms = 8000,
) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** An AIB with phone access on, pushes to the fake push service, the codes' clock `skew` ms ahead when the test says so. */
async function setup() {
  const svc = pushService();
  const clock = { skew: 0 };
  const fake = fakeTailscale();
  const s = await remoteStudio(
    {
      runner: fake.runner,
      pushFetch: svc.fetcher,
      pushCodes: { clock: () => Date.now() + clock.skew },
    },
    undefined,
    {
      saved: true,
    },
  );
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals(
    (await pc(s, "POST", "/api/live/devices/access", { on: true }))[0],
    200,
  );
  const calls: [string, Json][] = [];
  s.answerLive((name, body) => {
    calls.push([name, body]);
    const c = s.chats.find((x) => x.id === body.id);
    if (c && (name === "permission" || name === "prompt")) {
      c.permissions = [];
      c.busy = true;
      c.attention = {
        state: "working",
        needs: 0,
        turnEndedAt: null,
        busySince: new Date().toISOString(),
      };
    }
    return [200, { ok: true, accepted: true }];
  });
  const chat = (id: string, title: string, over: Json) => {
    const c = liveChat(id, s.project, {
      breadth: { sessionInfo: { title } },
      ...over,
    });
    s.chats.push(c);
    return c;
  };
  return { s, svc, clock, calls, chat };
}

async function phoneWithPush(
  s: RemoteStudio,
  svc: ReturnType<typeof pushService>,
  name: string,
  path: string,
) {
  const phone = await pairPhone(s, name, ALL);
  const keys = await phoneKeys(svc.endpoint(path));
  const r = await raw(
    s.phonePort(),
    "POST",
    "/api/remote/push/subscribe",
    phoneHeaders({ [DEVICE_HEADER]: phone.token }, "POST"),
    JSON.stringify({ subscription: keys.subscription }),
  );
  assertEquals(r.status, 200, r.text);
  return { ...phone, keys, path };
}

/** Sends the push the watcher would for one chat, and returns what that phone got (decrypted). */
async function pushFor(
  s: RemoteStudio,
  svc: ReturnType<typeof pushService>,
  phone: { keys: Keys; path: string },
  id: string,
  title: string,
  sheet = true,
): Promise<Json> {
  await s.ctx.inbox.look();
  const from = svc.got.length;
  await s.ctx.phone.push.send({
    title: sheet ? "A chat needs you" : "Chat finished",
    body: title,
    tag: "aib-attention",
    chat: id,
    sheet,
    key: keyOf(id),
  });
  // (the inbox build above may also send a "close" push for a request answered since: not this one)
  const mine = [];
  for (const g of svc.got.slice(from).filter((g) => g.path === phone.path)) {
    const m = await decrypt(g.body, phone.keys);
    if (m.type !== "close") mine.push(m);
  }
  assertEquals(mine.length, 1, "one push to the phone");
  return mine[0];
}

const act = (s: RemoteStudio, token: string, body: Json) =>
  raw(
    s.phonePort(),
    "POST",
    "/api/remote/notify-act",
    phoneHeaders({ [DEVICE_HEADER]: token }, "POST"),
    JSON.stringify(body),
  );

Deno.test({
  ...OPTS,
  name:
    "phone notification buttons (server): payload with buttons and a code; approve, refusals (risky, switch, expired, used, phone), close push",
  async fn() {
    const { s, svc, clock, calls, chat } = await setup();
    try {
      chat("c-ok", "Payments", {
        attention: { ...needs },
        permissions: perm("p1", "npm install stripe@18.0.0"),
      });
      chat("c-risky", "Release", {
        attention: { ...needs },
        permissions: perm("p2", "git push origin main"),
      });
      chat("c-other", "Docs", {
        attention: { ...needs },
        permissions: perm("p3", "npm run docs"),
      });
      chat("c-fail", "Coupon field", {
        attention: {
          state: "idle",
          needs: 0,
          turnEndedAt: ago(3),
          busySince: null,
          failedAt: ago(2),
          error: "Rate limit reached",
        },
        events: [
          {
            seq: 1,
            kind: "user",
            time: Date.now() / 1000 - 600,
            data: { text: "Fix the checkout", sessionId: "sess-c-fail" },
          },
          {
            seq: 2,
            kind: "user",
            time: Date.now() / 1000 - 300,
            data: { text: "Add the coupon field", sessionId: "sess-c-fail" },
          },
        ],
      });
      const a = await phoneWithPush(s, svc, "Pixel 9", "/fcm/a");
      const b = await phoneWithPush(s, svc, "Pixel 8", "/fcm/b");

      // the payload: the words as before, plus the row key, two buttons and this phone's code
      const ok = await pushFor(s, svc, a, "c-ok", "Payments");
      assertEquals(ok.title, "A chat needs you");
      assertEquals(ok.body, "Payments");
      assertEquals(ok.key, keyOf("c-ok"));
      assertEquals(ok.actions, [{ action: "allow", title: "Allow" }, {
        action: "deny",
        title: "Deny",
      }]);
      assert(
        typeof ok.code === "string" && (ok.code as string).length >= 20,
        "a one-time code",
      );
      assert(!JSON.stringify(ok).includes("npm install"), "never the command");
      const risky = await pushFor(s, svc, a, "c-risky", "Release");
      assertEquals(
        risky.actions,
        [{ action: "open", title: "Open" }],
        "a risky command: Open only",
      );
      assertEquals(risky.code, undefined, "and no code");
      const fail = await pushFor(s, svc, a, "c-fail", "Coupon field");
      assertEquals(fail.actions, [{ action: "retry", title: "Retry" }, {
        action: "open",
        title: "Open",
      }]);

      // a forged Allow on the risky request, with the ordinary request's code: refused, nothing approved
      let r = await act(s, a.token, {
        key: keyOf("c-risky"),
        act: "allow",
        code: ok.code,
      });
      assertEquals([r.status, r.json.code], [409, "wrong_chat"]);
      // another phone's code
      r = await act(s, b.token, {
        key: keyOf("c-ok"),
        act: "allow",
        code: ok.code,
      });
      assertEquals([r.status, r.json.code], [409, "wrong_device"]);
      // Approve once off for this phone: refused before the code is even looked at (it stays good)
      await pc(s, "POST", "/api/live/devices/scopes", {
        id: a.id,
        scopes: ["phone.read", "phone.prompt", "phone.push"],
      });
      r = await act(s, a.token, {
        key: keyOf("c-ok"),
        act: "allow",
        code: ok.code,
      });
      assertEquals([r.status, r.json.code], [403, "scope"]);
      assertEquals(
        calls.filter((c) => c[0] === "permission"),
        [],
        "nothing approved yet",
      );
      await pc(s, "POST", "/api/live/devices/scopes", {
        id: a.id,
        scopes: ALL,
      });
      // Allow: answered with the allow_once option
      r = await act(s, a.token, {
        key: keyOf("c-ok"),
        act: "allow",
        code: ok.code,
      });
      assertEquals(r.status, 200, r.text);
      assertEquals(calls.filter((c) => c[0] === "permission"), [["permission", {
        id: "c-ok",
        key: "p1",
        option: "yes",
      }]]);
      // the same tap again: used
      r = await act(s, a.token, {
        key: keyOf("c-ok"),
        act: "deny",
        code: ok.code,
      });
      assertEquals([r.status, r.json.code], [409, "used"]);

      // an expired code: refused
      const other = await pushFor(s, svc, a, "c-other", "Docs");
      clock.skew = 13 * 3600_000;
      r = await act(s, a.token, {
        key: keyOf("c-other"),
        act: "allow",
        code: other.code,
      });
      assertEquals([r.status, r.json.code], [409, "expired"]);
      clock.skew = 0;

      // Retry on the failed chat: your last message again
      const fail2 = await pushFor(s, svc, b, "c-fail", "Coupon field");
      r = await act(s, b.token, {
        key: keyOf("c-fail"),
        act: "retry",
        code: fail2.code,
      });
      assertEquals(r.status, 200, r.text);
      const prompt = calls.find((c) => c[0] === "prompt")!;
      assertEquals([prompt[1].id, prompt[1].text], [
        "c-fail",
        "Add the coupon field",
      ]);

      // answered on the PC: the phone shown that request gets a close push with its key
      const shown = await pushFor(s, svc, a, "c-other", "Docs");
      const from = svc.got.length;
      assertEquals(
        (await pc(s, "POST", "/api/live/permission", {
          id: "c-other",
          key: "p3",
          option: "yes",
        }))[0],
        200,
      );
      await s.ctx.inbox.look();
      await until(
        "a close push",
        () => svc.got.slice(from).some((g) => g.path === a.path),
      );
      const close = await decrypt(
        svc.got.slice(from).find((g) => g.path === a.path)!.body,
        a.keys,
      );
      assertEquals(close, {
        type: "close",
        key: keyOf("c-other"),
        tag: "aib-attention",
      });
      // and its button, tapped late, answers nothing
      r = await act(s, a.token, {
        key: keyOf("c-other"),
        act: "allow",
        code: shown.code,
      });
      assertEquals(r.status, 409);

      const log = s.ctx.phone.audit.tail(50).map((e) =>
        `${e.name} ${e.action}: ${e.result}`
      );
      for (
        const line of [
          "Pixel 9 notification: allow: refused: wrong_chat",
          "Pixel 8 notification: allow: refused: wrong_device",
          "Pixel 9 notification: allow: refused: scope",
          "Pixel 9 notification: allow: done",
          "Pixel 9 notification: deny: refused: used",
          "Pixel 9 notification: allow: refused: expired",
          "Pixel 8 notification: retry: done",
        ]
      ) assert(log.includes(line), `${line} in ${log.join(" | ")}`);
    } finally {
      await s.close();
      await svc.close();
    }
  },
});

/** This test plays Tailscale Serve on a loopback origin (a secure context, so the real service worker runs there). */
function serveProxy(s: RemoteStudio) {
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    const headers: Record<string, string> = {
      Host: NAME,
      "Tailscale-User-Login": LOGIN,
      "X-Forwarded-For": "100.64.0.7",
    };
    request.headers.forEach((v, k) => {
      if (
        /^(content-type|x-aib-device|accept|sec-fetch-site|sec-fetch-mode|sec-fetch-dest)$/i
          .test(k)
      ) headers[k] = v;
    });
    if (request.headers.get("origin") !== null) {
      headers.Origin = `https://${NAME}`;
    }
    const body = request.method === "POST" ? await request.text() : undefined;
    let a;
    try {
      a = await raw(
        s.phonePort(),
        request.method,
        url.pathname + url.search,
        headers,
        body,
      );
    } catch {
      return new Response("", { status: 502 });
    }
    const out = new Headers();
    a.headers.forEach((v, k) => {
      if (
        !/^(transfer-encoding|connection|content-length|keep-alive|set-cookie)$/i
          .test(k)
      ) out.set(k, v);
    });
    const empty = a.status === 204 || a.status === 304 ||
      request.method === "HEAD";
    return new Response(empty ? null : a.bytes as Uint8Array<ArrayBuffer>, {
      status: a.status,
      headers: out,
    });
  });
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    close: () => server.shutdown(),
  };
}

Deno.test({
  ...OPTS,
  name:
    "phone notification buttons (headless Chrome, real service worker): each action, risky, switch off, expired, Reply, close",
  ignore: !browserPath,
  async fn() {
    const { s, svc, clock, calls, chat } = await setup();
    const proxy = serveProxy(s);
    // Chrome's own (in-browser) notifications, never the OS's: a headless test must not put anything in Windows' action centre
    const browser = await Browser.launch([
      "--disable-features=NativeNotifications,SystemNotifications",
    ]);
    let sw: Page | null = null;
    try {
      chat("c-ok", "Payments", {
        attention: { ...needs },
        permissions: perm("p1", "npm install stripe@18.0.0"),
      });
      chat("c-deny", "Search", {
        attention: { ...needs },
        permissions: perm("p4", "npm install left-pad"),
      });
      chat("c-risky", "Release", {
        attention: { ...needs },
        permissions: perm("p2", "git push origin main"),
      });
      chat("c-other", "Docs", {
        attention: { ...needs },
        permissions: perm("p3", "npm run docs"),
      });
      chat("c-fail", "Coupon field", {
        attention: {
          state: "idle",
          needs: 0,
          turnEndedAt: ago(3),
          busySince: null,
          failedAt: ago(2),
          error: "Rate limit reached",
        },
        events: [
          {
            seq: 1,
            kind: "user",
            time: Date.now() / 1000 - 600,
            data: { text: "Fix the checkout", sessionId: "sess-c-fail" },
          },
          {
            seq: 2,
            kind: "user",
            time: Date.now() / 1000 - 300,
            data: { text: "Add the coupon field", sessionId: "sess-c-fail" },
          },
        ],
      });
      chat("c-done", "Invoices", {
        attention: {
          state: "idle",
          needs: 0,
          turnEndedAt: ago(3),
          busySince: null,
        },
        events: [
          {
            seq: 1,
            kind: "user",
            time: Date.now() / 1000 - 300,
            data: { text: "Total the invoices" },
          },
          {
            seq: 2,
            kind: "update",
            time: Date.now() / 1000 - 200,
            data: {
              sessionId: "sess-c-done",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Done." },
              },
            },
          },
        ],
      });
      await s.ctx.conversations.apply("your_turn", "claude", "sess-c-done");
      const phone = await phoneWithPush(s, svc, "Pixel 9", "/fcm/a");
      const inbox = await s.ctx.inbox.look();
      assert(
        inbox.rows.some((r) =>
          r.key === keyOf("c-done") && r.kind === "finished"
        ),
        JSON.stringify(inbox.rows.map((r) => [r.key, r.kind])),
      );

      // the phone page on the loopback origin, paired (its key in IndexedDB), its service worker running
      const page = await browser.open("about:blank", 375, 812);
      await page.send("Browser.grantPermissions", {
        origin: proxy.origin,
        permissions: ["notifications"],
      });
      await page.goto(`${proxy.origin}/phone.html`);
      await page.waitFor(
        '!!document.getElementById("app").dataset.screen',
        15000,
        "the phone page",
      );
      await page.eval(`new Promise((resolve, reject) => {
        const req = indexedDB.open('aib-phone', 2);
        req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
          if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'key' }); };
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ token: ${
        JSON.stringify(phone.token)
      }, device: { id: ${JSON.stringify(phone.id)} } }, 'device');
          tx.oncomplete = () => { req.result.close(); resolve(true); };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      })`);
      await page.goto(`${proxy.origin}/phone.html`);
      await page.waitFor(
        'document.getElementById("app").dataset.screen === "home"',
        15000,
        "home",
      );
      await page.eval(`navigator.serviceWorker.ready.then(() => true)`);
      let target: Json | undefined;
      await until("the service worker target", async () => {
        const list =
          await (await fetch(`http://127.0.0.1:${browser.port}/json/list`))
            .json() as Json[];
        target = list.find((t) =>
          t.type === "service_worker" && String(t.url).startsWith(proxy.origin)
        );
        return !!target;
      }, 15000);
      sw = new Page(
        String(target!.webSocketDebuggerUrl),
        String(target!.id),
        browser.port,
      );
      await sw.ready;
      await sw.send("Runtime.enable");

      /** The worker gets this push (a push event with the decrypted payload) and shows what it shows. */
      const deliver = (payload: Json) =>
        sw!.eval<Json>(`(async () => {
          self.dispatchEvent(new PushEvent('push', { data: ${
          JSON.stringify(JSON.stringify(payload))
        } }));
          await self.__aibLast;
          const list = await self.registration.getNotifications({ tag: 'aib-attention' });
          return { count: list.length, shown: list.map((n) => ({ title: n.title, body: n.body, key: (n.data || {}).key || '',
            actions: (n.actions || []).map((a) => a.action + ':' + a.title) })) };
        })()`);
      /** A tap on one of its buttons (action '' : the notification itself); the worker's result. */
      const tap = (key: string, action: string) =>
        sw!.eval<Json>(`(async () => {
          const list = await self.registration.getNotifications({ tag: 'aib-attention' });
          const n = list.find((x) => (x.data || {}).key === ${
          JSON.stringify(key)
        });
          if (!n) return { missing: true };
          self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n, action: ${
          JSON.stringify(action)
        } }));
          return await self.__aibLast;
        })()`);
      const approvals = () => calls.filter((c) => c[0] === "permission");

      // Allow: approved from the notification, nothing opens
      let shown = await deliver(
        await pushFor(s, svc, phone, "c-ok", "Payments"),
      );
      assertEquals(shown.shown, [{
        title: "A chat needs you",
        body: "Payments",
        key: keyOf("c-ok"),
        actions: ["allow:Allow", "deny:Deny"],
      }]);
      let done = await tap(keyOf("c-ok"), "allow");
      assertEquals(done, { done: true, act: "allow" });
      assertEquals(approvals(), [["permission", {
        id: "c-ok",
        key: "p1",
        option: "yes",
      }]]);
      assertEquals(
        (await deliver({ type: "close", key: "none" })).count,
        0,
        "the tapped notification closed",
      );

      // Deny: the reject_once option
      await deliver(await pushFor(s, svc, phone, "c-deny", "Search"));
      done = await tap(keyOf("c-deny"), "deny");
      assertEquals(done, { done: true, act: "deny" });
      assertEquals(approvals().at(-1), ["permission", {
        id: "c-deny",
        key: "p4",
        option: "no",
      }]);

      // a risky command: Open only; a forged Allow tap has no code, so it only opens the chat (nothing approved)
      shown = await deliver(await pushFor(s, svc, phone, "c-risky", "Release"));
      assertEquals((shown.shown as Json[])[0].actions, ["open:Open"]);
      done = await tap(keyOf("c-risky"), "allow");
      assertEquals(done.done, false);
      assertEquals(done.opened, "/phone.html#chat=c-risky&sheet=1");
      assertEquals(approvals().length, 2, "nothing more approved");
      await page.waitFor(
        `document.getElementById("app").dataset.screen === "chat"`,
        10000,
        "the risky chat opened",
      );

      // Approve once switched off after the push: refused; the phone page opens on the chat with a note
      const other = await pushFor(s, svc, phone, "c-other", "Docs");
      await deliver(other);
      await pc(s, "POST", "/api/live/devices/scopes", {
        id: phone.id,
        scopes: ["phone.read", "phone.prompt", "phone.push"],
      });
      done = await tap(keyOf("c-other"), "allow");
      assertEquals([done.done, done.code], [false, "scope"]);
      await page.waitFor(
        `(document.getElementById('phToast') || {}).textContent === 'This phone may not do that. Turn it on in AIB on your PC: Settings → Remote control.'`,
        10000,
        "the switch note",
      );
      assertEquals(approvals().length, 2);
      await pc(s, "POST", "/api/live/devices/scopes", {
        id: phone.id,
        scopes: ALL,
      });

      // an expired code: refused, with its note
      await deliver(await pushFor(s, svc, phone, "c-other", "Docs"));
      clock.skew = 13 * 3600_000;
      done = await tap(keyOf("c-other"), "allow");
      clock.skew = 0;
      assertEquals([done.done, done.code], [false, "expired"]);
      await page.waitFor(
        `(document.getElementById('phToast') || {}).textContent === 'That notification is too old. Answer it here.'`,
        10000,
        "the expired note",
      );
      assertEquals(approvals().length, 2);

      // Retry on a failed chat: sent from the notification
      shown = await deliver(
        await pushFor(s, svc, phone, "c-fail", "Coupon field"),
      );
      assertEquals((shown.shown as Json[])[0].actions, [
        "retry:Retry",
        "open:Open",
      ]);
      done = await tap(keyOf("c-fail"), "retry");
      assertEquals(done, { done: true, act: "retry" });
      const prompt = calls.find((c) => c[0] === "prompt")!;
      assertEquals([prompt[1].id, prompt[1].text], [
        "c-fail",
        "Add the coupon field",
      ]);

      // Reply on a finished chat: the phone page on its composer, focused
      shown = await deliver(
        await pushFor(s, svc, phone, "c-done", "Invoices", false),
      );
      assertEquals((shown.shown as Json[])[0].actions, [
        "reply:Reply",
        "open:Open",
      ]);
      done = await tap(keyOf("c-done"), "reply");
      assertEquals(done.opened, "/phone.html#chat=c-done&reply=1");
      await page.waitFor(
        `document.activeElement && document.activeElement.id === 'phPrompt'`,
        10000,
        "the composer focused",
      );

      // answered on the PC: the close push takes the notification away
      await deliver(await pushFor(s, svc, phone, "c-other", "Docs"));
      const from = svc.got.length;
      assertEquals(
        (await pc(s, "POST", "/api/live/permission", {
          id: "c-other",
          key: "p3",
          option: "yes",
        }))[0],
        200,
      );
      await s.ctx.inbox.look();
      await until(
        "a close push",
        () => svc.got.slice(from).some((g) => g.path === phone.path),
      );
      const close = await decrypt(
        svc.got.slice(from).find((g) => g.path === phone.path)!.body,
        phone.keys,
      );
      shown = await deliver(close);
      assertEquals(shown.count, 0, "the answered notification is gone");
      assertEquals(page.errors, [], "phone console errors");
    } finally {
      await sw?.close().catch(() => {});
      await browser.close();
      await proxy.close();
      await s.close();
      await svc.close();
    }
  },
});
