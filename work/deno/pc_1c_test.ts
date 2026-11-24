/**
 * Remote control from other PCs, phase 1c: terminal, files, pairing, removal (design v2 sections 6, 7 and 9).
 *   - the socket registry by device (remote/pc_sockets.ts): a message from a removed device or after the switch went off closes the
 *     socket instead of reaching the session; Remove closes a device's sockets within 1 s; the 1 s tick; the 25 s ping
 *   - e2e on the phone port with a paired fake computer: a chat terminal opens (a fake terminal session: no shell is started), its
 *     Device activity lines, Terminal switched off closes it, Remove closes it within 1 s and cuts the token, the push subscription and
 *     the artifact links in the same step
 *   - Files download for a computer: the file, its log line by path (never the content), blocked folders, the 20 MiB cap, the switch
 *   - pairing: the device's hint only pre-sets the approve box; the approver's kind and unticked switches are what the device gets
 *   - push endpoints limited to the known push services
 */
import { assert, assertEquals } from "./_assert.ts";
import { setWslHostResolver } from "../../app/server/wsl/access.ts";
import {
  WslHelperError,
  type WslHost,
} from "../../app/server/wsl/contract.ts";
import {
  readRemoteArtifactPort,
  readRemotePort,
} from "../../app/server/remote/port.ts";
import {
  DEVICE_HEADER,
  DEVICE_PROTOCOL_PREFIX,
  RateLimit,
} from "../../app/server/remote/pc_bridge.ts";
import {
  CLOSE_REMOVED,
  DeviceSockets,
} from "../../app/server/remote/pc_sockets.ts";
import {
  CACHE_FLAG,
  cleanPushSub,
  COMPUTER_SCOPES,
  type Device,
  pushEndpointAllowed,
  scopesForPhone,
} from "../../app/server/remote/devices.ts";
import type { WsLink } from "../../app/server/platform/websocket.ts";
import {
  type FakeChat,
  fakeTailscale,
  LOGIN,
  NAME,
  nonce,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteAib,
  remoteAib,
  serveStatus,
} from "./_remote_fixture.ts";
import { Browser, browserPath } from "./_doc_browser.ts";

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sep = Deno.build.os === "windows" ? "\\" : "/";
const q = encodeURIComponent;

// ---- the registry (unit) ---------------------------------------------------------------------------------------------------------

/** A link that records what happens to it. */
function fakeLink() {
  const log = { sent: [] as string[], closed: null as number | null, pings: 0 };
  const link: WsLink & {
    log: typeof log;
    fire(data: string): void;
    end(): void;
  } = {
    onmessage: null,
    onclose: null,
    get isOpen() {
      return log.closed === null;
    },
    send: (d) => log.sent.push(String(d)),
    ping: () => log.pings++,
    close(code = 1000) {
      if (log.closed !== null) return;
      log.closed = code;
      queueMicrotask(() => link.onclose?.());
    },
    log,
    fire: (data) => link.onmessage?.(data),
    end: () => link.onclose?.(),
  };
  return link;
}

Deno.test("socket registry: messages checked per device, Remove closes only that device, the tick and the ping", async () => {
  const ok = new Map([["a", true], ["b", true]]);
  const reg = new DeviceSockets({
    allowed: (d) => ok.get(d) === true,
    tickMs: 30,
    pingMs: 60,
  });
  const a1 = fakeLink(), a2 = fakeLink(), b1 = fakeLink();
  const closedLines: string[] = [];
  const got: string[] = [];
  const w1 = reg.wrap("a", "terminal", a1, () => closedLines.push("a1"));
  w1.onmessage = (d) => got.push(`a1:${d}`);
  let sessionSawClose = 0;
  w1.onclose = () => sessionSawClose++;
  reg.wrap("a", "docs", a2).onmessage = (d) => got.push(`a2:${d}`);
  reg.wrap("b", "terminal", b1).onmessage = (d) => got.push(`b1:${d}`);
  assertEquals([reg.count("a"), reg.count("b"), reg.count()], [2, 1, 3]);
  a1.fire("ls");
  assertEquals(got, ["a1:ls"]);
  // removed: its next message closes the socket and never reaches the session
  ok.set("a", false);
  a1.fire("whoami");
  assertEquals(got, ["a1:ls"], "a message after removal reached the shell");
  assertEquals(a1.log.closed, CLOSE_REMOVED);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(sessionSawClose, 1, "the session hears the close");
  assertEquals(closedLines, ["a1"], "the closed line once");
  // the tick closes the other socket of the removed device within one tick
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(a2.log.closed, CLOSE_REMOVED);
  assertEquals(b1.log.closed, null, "another device is untouched");
  // the ping (every pingMs while sockets are open)
  await new Promise((r) => setTimeout(r, 150));
  assert(b1.log.pings >= 1, `pings: ${b1.log.pings}`);
  // closeDevice: at once, only that device
  const b2 = fakeLink();
  reg.wrap("b", "docs", b2);
  assertEquals(reg.closeDevice("b"), 2);
  assertEquals([b1.log.closed, b2.log.closed], [CLOSE_REMOVED, CLOSE_REMOVED]);
  assertEquals(reg.count(), 0);
  // a session closing its own socket leaves the registry
  ok.set("a", true);
  const a3 = fakeLink();
  const w3 = reg.wrap("a", "terminal", a3);
  w3.close(1000, "shell ended");
  assertEquals(reg.count(), 0);
  assertEquals(a3.log.closed, 1000);
});

// ---- push endpoints (unit) -------------------------------------------------------------------------------------------------------

Deno.test("saved copies of chats are phone-only: a computer never gets the cache flag (memory only, SF6)", () => {
  const base = { id: "d", name: "n", tokenHash: "", cookieHash: "", scopes: ["phone.read"], login: "", created: 0, lastSeen: 0 } as Device;
  assertEquals(scopesForPhone(base), ["phone.read", CACHE_FLAG]);
  assertEquals(scopesForPhone({ ...base, offlineCache: false }), ["phone.read"]);
  assertEquals(scopesForPhone({ ...base, kind: "computer" }), ["phone.read"]);
});

Deno.test("push endpoints: only the known push services, https on the default port", () => {
  const yes = [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/QGx",
  ];
  const no = [
    "https://192.168.1.10/push",
    "https://100.64.0.7/push",
    "https://studio-pc.tail-a1b2.ts.net/push",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com/x",
    "https://notify.windows.com/x",
    "https://x.notify.windows.com.evil.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
  ];
  for (const u of yes) assert(pushEndpointAllowed(new URL(u)), u);
  for (const u of no) assert(!pushEndpointAllowed(new URL(u)), u);
  const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
  assert(cleanPushSub({ endpoint: yes[0], keys }, 1));
  assertEquals(cleanPushSub({ endpoint: no[0], keys }, 1), null);
});

// ---- e2e on the phone port ---------------------------------------------------------------------------------------------------------

/** A terminal session stand-in: no shell runs. It says ready, keeps what it is sent and the links it got. */
function fakeTerminals() {
  const t = {
    got: [] as string[],
    attached: [] as { key: string; cwd: string }[],
    attach(link: WsLink, key: string, cwd: string) {
      t.attached.push({ key, cwd });
      link.onmessage = (d) => t.got.push(String(d));
      link.onclose = () => {};
      link.send(JSON.stringify({ type: "ready" }));
    },
    list: () => [],
    max: 4,
    end: () => Promise.resolve(false),
    endAll: () => Promise.resolve(),
    releaseAll: () => Promise.resolve(),
    terminateAllNow: () => {},
  };
  return t;
}

async function remoteOn(
  withArtifacts = false,
): Promise<RemoteAib & { term: ReturnType<typeof fakeTerminals> }> {
  const fake = fakeTailscale();
  const s = await remoteAib({ runner: fake.runner }, undefined, {
    saved: true,
  });
  if (withArtifacts) s.ctx.artifacts.start(s.port);
  fake.state.serve = serveStatus(
    readRemotePort(s.state)!,
    false,
    withArtifacts ? readRemoteArtifactPort(s.state)! : 0,
  );
  const [status] = await pc(s, "POST", "/api/live/devices/access", {
    on: true,
  });
  assertEquals(status, 200);
  (s.ctx.phone.server!.bridge as unknown as { limit: RateLimit }).limit =
    new RateLimit(1e6, 1e6);
  const term = fakeTerminals();
  (s.ctx as unknown as { terminals: unknown }).terminals = term;
  return Object.assign(s, { term });
}

function chat(id: string, cwd: string): FakeChat {
  return {
    id,
    provider: "claude",
    sessionId: "sess-" + id,
    cwd,
    busy: false,
    closed: false,
    attention: { state: "idle", needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [],
    permissions: [],
    elicitations: [],
  };
}

function call(
  s: RemoteAib,
  token: string,
  method: string,
  path: string,
  body?: Json,
) {
  return raw(
    s.phonePort(),
    method,
    path,
    { ...phoneHeaders({}, method), [DEVICE_HEADER]: token },
    body === undefined
      ? (method === "POST" ? "{}" : undefined)
      : JSON.stringify(body),
  );
}

/** A client frame (masked, as a browser sends it). */
function clientFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const mask = new Uint8Array([7, 1, 9, 4]);
  const n = payload.length;
  const head = n < 126 ? 2 : 4;
  const out = new Uint8Array(head + 4 + n);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = 0x80 | n;
  else {
    out[1] = 0x80 | 126;
    out[2] = n >> 8;
    out[3] = n & 0xff;
  }
  out.set(mask, head);
  for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

/** A WebSocket from a computer to the phone port over raw TCP (exact Host and the Tailscale login, as Serve sends them). */
async function openSocket(s: RemoteAib, path: string, token: string) {
  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: s.phonePort(),
  });
  const headers = phoneHeaders({
    Origin: `https://${NAME}`,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Protocol": `aib-terminal, ${DEVICE_PROTOCOL_PREFIX}${token}`,
    "Sec-Fetch-Mode": "websocket",
  });
  let head = `GET ${path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  await conn.write(new TextEncoder().encode(head + "\r\n"));
  const state = {
    status: 0,
    texts: [] as string[],
    closeCode: null as number | null,
    closedAt: 0,
    ended: false,
  };
  let buf = new Uint8Array(0);
  const append = (chunk: Uint8Array) => {
    const out = new Uint8Array(buf.length + chunk.length);
    out.set(buf);
    out.set(chunk, buf.length);
    buf = out;
  };
  const chunk = new Uint8Array(65536);
  let opened: () => void;
  const ready = new Promise<void>((r) => (opened = r));
  const pump = (async () => {
    try {
      for (;;) {
        const n = await conn.read(chunk);
        if (n === null) break;
        append(chunk.slice(0, n));
        if (!state.status) {
          const text = new TextDecoder().decode(buf);
          const end = text.indexOf("\r\n\r\n");
          if (end < 0) continue;
          state.status = Number(text.split(" ")[1]);
          buf = buf.slice(
            new TextEncoder().encode(text.slice(0, end + 4)).length,
          );
          opened!();
        }
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = (buf[2] << 8) | buf[3];
            off = 4;
          }
          if (buf.length < off + len) break;
          const payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (op === 0x1) state.texts.push(new TextDecoder().decode(payload));
          if (op === 0x8) {
            state.closeCode = payload.length >= 2
              ? (payload[0] << 8) | payload[1]
              : 1005;
            state.closedAt = performance.now();
          }
        }
      }
    } catch { /* closed */ }
    state.ended = true;
    if (!state.closedAt) state.closedAt = performance.now();
    opened!();
  })();
  await ready;
  return {
    state,
    send: (text: string) =>
      conn.write(clientFrame(0x1, new TextEncoder().encode(text))).catch(() =>
        0
      ),
    /** Wait until the server closed the socket (close frame or end), at most `ms`. */
    async closed(ms = 3000) {
      const until = performance.now() + ms;
      while (
        state.closeCode === null && !state.ended && performance.now() < until
      ) await new Promise((r) => setTimeout(r, 10));
      return state.closeCode !== null || state.ended;
    },
    async text(match: (t: string) => boolean, ms = 3000) {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        const t = state.texts.find(match);
        if (t) return t;
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    },
    close: async () => {
      try {
        conn.close();
      } catch { /* closed */ }
      await pump;
    },
  };
}

async function activity(s: RemoteAib): Promise<Json[]> {
  const [, r] = await pc(s, "GET", "/api/live/devices/activity");
  return (r.entries ?? []) as Json[];
}

async function until(
  check: () => Promise<boolean> | boolean,
  what: string,
  ms = 3000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out: ${what}`);
}

Deno.test({
  ...OPTS,
  name:
    "terminal: a chat shell opens for a computer, Terminal switched off closes it, Remove closes it within 1 s and cuts everything",
  async fn() {
    const s = await remoteOn(true);
    try {
      s.chats.push(chat("t1", s.project));
      const laptop = await pairPhone(s, "Laptop (Edge)", undefined, "computer");
      const other = await pairPhone(s, "Laptop 2", undefined, "computer");
      const key = "claude:sess-t1";
      const path = `/api/live/terminal?key=${q(key)}&cols=80&rows=24`;

      // opens: the session gets it, in the chat's folder
      let ws = await openSocket(s, path, laptop.token);
      assertEquals(ws.state.status, 101);
      assert(await ws.text((t) => t.includes('"ready"')), "ready");
      await ws.send("echo hi\r");
      await until(
        () => s.term.got.includes("echo hi\r"),
        "the session got the typing",
      );
      assertEquals(s.term.attached.at(-1), { key, cwd: s.project });
      assertEquals(s.ctx.phone.sockets.count(laptop.id, "terminal"), 1);
      const opened = (await activity(s)).find((e) =>
        e.action === "terminal" && e.result === "opened"
      );
      assert(
        opened && opened.device === laptop.id && opened.chat === key,
        JSON.stringify(opened),
      );
      assert(
        !JSON.stringify(await activity(s)).includes("echo hi"),
        "terminal input is never logged",
      );

      // the Terminal switch turned off on the PC: the open socket closes now
      const noTerm = COMPUTER_SCOPES.filter((x) => x !== "pc.terminal");
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/scopes", {
          id: laptop.id,
          scopes: noTerm,
        }))[0],
        200,
      );
      assert(await ws.closed(1500), "closed when Terminal went off");
      assertEquals(ws.state.closeCode, CLOSE_REMOVED);
      await ws.close();
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/scopes", {
          id: laptop.id,
          scopes: [...COMPUTER_SCOPES],
        }))[0],
        200,
      );

      // what Remove has to cut: an open terminal, a push subscription, an artifact link
      ws = await openSocket(s, path, laptop.token);
      assert(await ws.text((t) => t.includes('"ready"')), "ready again");
      const keep = await openSocket(s, path, other.token);
      assert(
        await keep.text((t) => t.includes('"ready"')),
        "the other laptop is in too",
      );
      const sub = {
        endpoint: "https://fcm.googleapis.com/fcm/send/aib-1c-test",
        keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      };
      const subscribed = await raw(
        s.phonePort(),
        "POST",
        "/api/remote/push/subscribe",
        { ...phoneHeaders({}, "POST"), [DEVICE_HEADER]: laptop.token },
        JSON.stringify({ subscription: sub }),
      );
      assertEquals(subscribed.status, 200, subscribed.text);
      assert(
        s.ctx.phone.devices.pushTargets().some((t) => t.id === laptop.id),
        "subscribed",
      );
      const art = s.ctx.artifacts.store.create(
        "claude:sess-t1",
        "Report",
        "html",
        "r.html",
        new TextEncoder().encode("<p>hi</p>"),
      );
      const ticket = s.ctx.phone.tickets.mint(laptop.id, art.id);
      const artPath = `/r/${ticket}/a/${art.id}/v1/r.html`;
      const frame = {
        Host: `${NAME}:8443`,
        "Tailscale-User-Login": LOGIN,
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
      };
      const before = await raw(s.artifactPort(), "GET", artPath, frame);
      assertEquals(
        before.status,
        200,
        `the link works before Remove: ${before.text}`,
      );

      // its own layout (phase 1b's per-device view prefs) goes with it
      const layout = `${s.state}${sep}studio-view.device-${laptop.id}.json`;
      await Deno.writeTextFile(layout, "{}");

      const t0 = performance.now();
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/remove", { id: laptop.id }))[0],
        200,
      );
      assert(await ws.closed(1000), "the socket closed within 1 s of Remove");
      const took = ws.state.closedAt - t0;
      assert(took < 1000, `closed after ${Math.round(took)} ms`);
      assertEquals(ws.state.closeCode, CLOSE_REMOVED);
      await ws.send("whoami\r");
      await new Promise((r) => setTimeout(r, 100));
      assert(
        !s.term.got.includes("whoami\r"),
        "nothing typed after Remove reaches the shell",
      );
      // the token: the next call is 401 not_paired
      const next = await call(s, laptop.token, "GET", "/api/live/list");
      assertEquals([next.status, next.json.code], [401, "not_paired"]);
      // a new socket: refused before any upgrade
      const again = await openSocket(s, path, laptop.token);
      assertEquals(again.state.status, 401);
      await again.close();
      let layoutKept = true;
      try {
        await Deno.stat(layout);
      } catch {
        layoutKept = false;
      }
      assert(!layoutKept, "the device's layout file is removed");
      // the push subscription and the artifact link went with it
      assert(
        !s.ctx.phone.devices.pushTargets().some((t) => t.id === laptop.id),
        "push subscription gone",
      );
      const after = await raw(s.artifactPort(), "GET", artPath, frame);
      assertEquals(after.status, 403, "the artifact link stops");
      // the other computer is untouched
      assertEquals(
        keep.state.closeCode,
        null,
        "another computer keeps its terminal",
      );
      assertEquals(s.ctx.phone.sockets.count(other.id), 1);
      // the log: closed, and removed with the socket count
      const lines = await activity(s);
      assert(
        lines.some((e) =>
          e.device === laptop.id && e.action === "terminal" &&
          e.result === "closed"
        ),
        "terminal closed line",
      );
      const removed = lines.find((e) =>
        e.device === laptop.id && e.action === "remove"
      );
      assert(
        removed && String(removed.result).includes("1 open socket closed"),
        JSON.stringify(removed),
      );
      // Remove all: every computer's socket closes too
      await pc(s, "POST", "/api/live/devices/remove-all", {});
      assert(await keep.closed(1000), "Remove all closes the other laptop");
      await keep.close();
      await ws.close();
      assertEquals(s.ctx.phone.sockets.count(), 0);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "terminal: a message after the device left the store (not through Remove) closes the socket and never reaches the shell",
  async fn() {
    const s = await remoteOn();
    try {
      s.chats.push(chat("t2", s.project));
      const laptop = await pairPhone(s, "Laptop", undefined, "computer");
      const ws = await openSocket(
        s,
        `/api/live/terminal?key=${q("claude:sess-t2")}&cols=80&rows=24`,
        laptop.token,
      );
      assert(await ws.text((t) => t.includes('"ready"')), "ready");
      s.ctx.phone.devices.devices.delete(laptop.id); // as if another AIB process removed it: no closeDevice call here
      await ws.send("dir\r");
      assert(
        await ws.closed(1000),
        "closed on the next message (or the 1 s tick)",
      );
      await new Promise((r) => setTimeout(r, 50));
      assert(
        !s.term.got.includes("dir\r"),
        "the message did not reach the shell",
      );
      await ws.close();
    } finally {
      await s.close();
    }
  },
});

// ---- Files download ----------------------------------------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name:
    "files download: a WSL project's file through the distro's helper (0.13.0); missing, too big, blocked and away answered",
  async fn() {
    const s = await remoteOn();
    const REF = "wsl://ubuntu/home/u/app";
    const files: Record<string, string> = { "src/app.ts": "linux file content" };
    let state: WslHost["state"] = "ready";
    const host = {
      distro: "Ubuntu",
      get state() {
        return state;
      },
      note: "",
      link: null,
      helperVersion: "test",
      call(method: string, p: Record<string, unknown>) {
        if (state !== "ready") return Promise.reject(new WslHelperError("Ubuntu stopped", "stopped"));
        if (method !== "files.readBytes") return Promise.reject(new WslHelperError("No method", "no_method"));
        const rel = String(p.rel);
        if (rel === "big.bin") return Promise.reject(new WslHelperError("Too large", "too_large"));
        const text = files[rel];
        if (text === undefined) return Promise.reject(new WslHelperError("Not found", "not_found"));
        return Promise.resolve({ bytesB64: btoa(text), size: text.length, mtimeMs: 1, offset: 0, path: rel, abs: `${String(p.root)}/${rel}` });
      },
      env: () => Promise.resolve({}),
      onOpenUrl: () => () => {},
      start: () => Promise.resolve(),
      reconnect: () => Promise.resolve(),
    } as unknown as WslHost;
    setWslHostResolver((key) => (key === "ubuntu" ? host : null));
    try {
      await s.ctx.addedProjects!.add(REF);
      const laptop = await pairPhone(s, "Laptop", undefined, "computer");
      const url = (path: string) => `/api/pc/files/download?root=project&project=${q(REF)}&path=${q(path)}`;
      const got = await call(s, laptop.token, "GET", url("src/app.ts"));
      assertEquals(got.status, 200, got.text);
      assertEquals(got.text, "linux file content");
      assert((got.headers.get("content-disposition") ?? "").startsWith('attachment; filename="app.ts"'));
      const line = (await activity(s)).find((e) => e.action === "file downloaded");
      assertEquals(line?.path, `${REF}/src/app.ts`);
      const missing = await call(s, laptop.token, "GET", url("nope.txt"));
      assertEquals([missing.status, missing.json.code], [404, "not_found"]);
      const big = await call(s, laptop.token, "GET", url("big.bin"));
      assertEquals([big.status, big.json.code], [413, "too_big"]);
      // a sign-in folder by Linux rules (a home folder added as a project)
      await s.ctx.addedProjects!.add("wsl://ubuntu/home/u");
      files[".ssh/id_ed25519"] = "key";
      const ssh = await call(s, laptop.token, "GET", `/api/pc/files/download?root=project&project=${q("wsl://ubuntu/home/u")}&path=${q(".ssh/id_ed25519")}`);
      assertEquals(ssh.status, 403, ssh.text);
      assert(!ssh.text.includes("key\""), "never the content");
      state = "stopped";
      const away = await call(s, laptop.token, "GET", url("src/app.ts"));
      assertEquals(away.status, 409, away.text);
    } finally {
      setWslHostResolver(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "files download: a project file for a computer, logged by path only; blocked folders, the switch, the cap and phones refused",
  async fn() {
    const s = await remoteOn();
    try {
      const secret = "the-file-content-must-not-be-logged";
      await Deno.mkdir(s.project + sep + "src", { recursive: true });
      await Deno.writeTextFile(
        s.project + sep + "src" + sep + "app.ts",
        secret,
      );
      const laptop = await pairPhone(s, "Laptop", undefined, "computer");
      const noFiles = await pairPhone(
        s,
        "Laptop 2",
        COMPUTER_SCOPES.filter((x) => x !== "pc.files"),
        "computer",
      );
      const phone = await pairPhone(s, "Pixel");
      const url = (project: string, path: string) =>
        `/api/pc/files/download?root=project&project=${q(project)}&path=${
          q(path)
        }`;

      const got = await call(
        s,
        laptop.token,
        "GET",
        url(s.project, "src/app.ts"),
      );
      assertEquals(got.status, 200, got.text);
      assertEquals(got.text, secret);
      assertEquals(got.headers.get("content-type"), "application/octet-stream");
      assert(
        (got.headers.get("content-disposition") ?? "").startsWith(
          'attachment; filename="app.ts"',
        ),
        got.headers.get("content-disposition")!,
      );
      assertEquals(got.headers.get("x-content-type-options"), "nosniff");
      const lines = await activity(s);
      const line = lines.find((e) => e.action === "file downloaded");
      assert(
        line && line.device === laptop.id &&
          String(line.path).endsWith(`src${sep}app.ts`),
        JSON.stringify(line),
      );
      assert(
        !JSON.stringify(lines).includes(secret),
        "the content is never logged",
      );

      // the switch, a phone, no token
      assertEquals(
        (await call(s, noFiles.token, "GET", url(s.project, "src/app.ts"))).json
          .code,
        "scope",
      );
      assertEquals(
        (await call(s, phone.token, "GET", url(s.project, "src/app.ts"))).json
          .code,
        "not_computer",
      );
      assertEquals(
        (await call(s, "nope", "GET", url(s.project, "src/app.ts"))).status,
        401,
      );
      // outside the folder, '..', a folder that is not a project
      assertEquals(
        (await call(
          s,
          laptop.token,
          "GET",
          url(s.project, "../../state/devices.json"),
        )).status,
        400,
      );
      assertEquals(
        (await call(s, laptop.token, "GET", url(s.root, "state/devices.json")))
          .status,
        404,
        "not an added project",
      );
      // a chat working in a folder that holds AIB's state folder: the file inside it is refused
      s.chats.push(chat("t9", s.root));
      const inChat = await call(
        s,
        laptop.token,
        "GET",
        `/api/pc/files/download?id=t9&root=chat&path=${
          q("state/devices.json")
        }`,
      );
      assertEquals(
        [inChat.status, inChat.json.code],
        [403, "blocked_folder"],
        inChat.text,
      );
      assert(!inChat.text.includes("tokenHash"));
      const okInChat = await call(
        s,
        laptop.token,
        "GET",
        `/api/pc/files/download?id=t9&root=chat&path=${
          q("projects/shop/src/app.ts")
        }`,
      );
      assertEquals(okInChat.status, 200, okInChat.text);
      // the 20 MiB cap (a sparse file: nothing is written)
      const big = await Deno.open(s.project + sep + "big.bin", {
        create: true,
        write: true,
      });
      await big.truncate(21 * 1024 * 1024);
      big.close();
      const tooBig = await call(
        s,
        laptop.token,
        "GET",
        url(s.project, "big.bin"),
      );
      assertEquals([tooBig.status, tooBig.json.code], [413, "too_big"]);
      // HEAD is a GET here: never another way in
      assertEquals(
        (await call(s, laptop.token, "POST", url(s.project, "src/app.ts")))
          .status,
        404,
      );
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Device activity: a project added from a computer is one line with its path",
  async fn() {
    const s = await remoteOn();
    try {
      const laptop = await pairPhone(s, "Laptop", undefined, "computer");
      const folder = s.root + sep + "projects" + sep + "web";
      await Deno.mkdir(folder, { recursive: true });
      const r = await call(s, laptop.token, "POST", "/api/live/project-add", {
        path: folder,
      });
      assertEquals(r.status, 200, r.text);
      const line = (await activity(s)).find((e) =>
        e.action === "project added"
      );
      assert(
        line && line.device === laptop.id && line.path === folder,
        JSON.stringify(line),
      );
    } finally {
      await s.close();
    }
  },
});

// ---- pairing: the approver sets the kind --------------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name:
    "pairing: the device hint only pre-sets the box; the approver sets the kind and may untick a switch before Approve",
  async fn() {
    const s = await remoteOn();
    try {
      const claimOne = async (name: string, kind?: string) => {
        const [, code] = await pc(s, "POST", "/api/live/devices/pair", {});
        const words = (code.words as string[]).join(" ");
        const r = await raw(
          s.phonePort(),
          "POST",
          "/api/remote/pair/claim",
          phoneHeaders({}, "POST"),
          JSON.stringify({
            code: words,
            name,
            nonce: nonce(),
            ...(kind ? { kind } : {}),
          }),
        );
        assertEquals(r.status, 200, r.text);
        const [, view] = await pc(s, "GET", "/api/live/devices");
        return ((view.pairing as Json).pending as Json[]).find((p) =>
          p.id === r.json.claim
        )!;
      };
      // a computer suggests itself: the box starts on Computer, but approving without a kind makes a phone (the PC decides)
      const a = await claimOne("Laptop (Edge)", "computer");
      assertEquals(a.hint, "computer");
      await pc(s, "POST", "/api/live/devices/approve", { claim: a.id });
      let [, view] = await pc(s, "GET", "/api/live/devices");
      let row = (view.devices as Json[]).find((d) =>
        d.name === "Laptop (Edge)"
      )!;
      assertEquals(row.kind, "phone");
      // the approver picks Computer and unticks Terminal: every other switch on (lead call 2a), Terminal off
      const b = await claimOne("Laptop 2", "computer");
      const scopes = COMPUTER_SCOPES.filter((x) => x !== "pc.terminal");
      await pc(s, "POST", "/api/live/devices/approve", {
        claim: b.id,
        kind: "computer",
        scopes,
      });
      [, view] = await pc(s, "GET", "/api/live/devices");
      row = (view.devices as Json[]).find((d) => d.name === "Laptop 2")!;
      assertEquals(row.kind, "computer");
      assertEquals((row.scopes as string[]).sort(), [...scopes].sort());
      // a phone that says it is a computer and one that says nothing: hint phone for anything else
      assertEquals((await claimOne("Pixel", "tablet")).hint, "phone");
      const lines = await activity(s);
      assert(
        lines.some((e) =>
          e.action === "pair" && e.result === "approved on the PC as a computer"
        ),
        "pair line",
      );
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "device kind: the row's Phone / Computer sets the kind and switches, logs a line, closes what a phone may not hold; a device cannot call it",
  async fn() {
    const s = await remoteOn();
    try {
      const dev = await pairPhone(s, "Laptop", undefined, "phone");
      const row = async () => {
        const [, view] = await pc(s, "GET", "/api/live/devices");
        return (view.devices as Json[]).find((d) => d.id === dev.id)!;
      };
      assertEquals((await row()).kind, "phone");
      // a bad kind or an unknown device changes nothing
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/kind", { id: dev.id, kind: "tablet" }))[0],
        400,
      );
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/kind", { id: "nope", kind: "computer" }))[0],
        404,
      );
      // to Computer: all four pc.* switches on, with every phone switch
      const [st, up] = await pc(s, "POST", "/api/live/devices/kind", { id: dev.id, kind: "computer" });
      assertEquals(st, 200);
      assertEquals((up.device as Json).kind, "computer");
      let r = await row();
      assertEquals(r.kind, "computer");
      assertEquals([...(r.scopes as string[])].sort(), [...COMPUTER_SCOPES].sort());
      // the device itself (a computer, even with every switch) never reaches it: the bridge says "on the PC only"
      const viaBridge = await call(s, dev.token, "POST", "/api/live/devices/kind", { id: dev.id, kind: "phone" });
      assert(viaBridge.status >= 400, "bridge refuses: " + viaBridge.status);
      assertEquals((await row()).kind, "computer");
      // back to Phone: every pc.* switch is gone, the phone ones stay
      await pc(s, "POST", "/api/live/devices/kind", { id: dev.id, kind: "phone" });
      r = await row();
      assertEquals(r.kind, "phone");
      assert(!(r.scopes as string[]).some((x) => x.startsWith("pc.")), "no pc.* left");
      assert((r.scopes as string[]).includes("phone.answer"));
      const lines = await activity(s);
      assert(
        lines.some((e) => e.action === "kind" && e.result === "Laptop is now a computer"),
        "computer line",
      );
      assert(
        lines.some((e) => e.action === "kind" && e.result === "Laptop is now a phone"),
        "phone line",
      );
    } finally {
      await s.close();
    }
  },
});

// ---- the approve box on the PC (headless browser) -------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name:
    "PC Settings: the approve box has Phone / Computer (pre-set from the device), computer switches all on, one unticked before Approve",
  ignore: !browserPath,
  async fn() {
    const s = await remoteOn();
    const browser = await Browser.launch();
    try {
      const [, code] = await pc(s, "POST", "/api/live/devices/pair", {});
      const claim = await raw(
        s.phonePort(),
        "POST",
        "/api/remote/pair/claim",
        phoneHeaders({}, "POST"),
        JSON.stringify({
          code: (code.words as string[]).join(" "),
          name: "Laptop (Edge)",
          nonce: nonce(),
          kind: "computer",
        }),
      );
      assertEquals(claim.status, 200, claim.text);
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
        `[...document.querySelectorAll('.st-section')].find((b) => b.textContent === 'Remote control').click()`,
      );
      const box = ".dv-approve";
      await page.waitFor(
        `!!document.querySelector('${box} input[data-kind="computer"]')`,
        8000,
        "the kind control",
      );
      assertEquals(
        await page.eval(
          `[...document.querySelectorAll('${box} input[data-kind]')].map((i) => [i.dataset.kind, i.checked])`,
        ),
        [["phone", false], ["computer", true]],
        "pre-set from what the device suggested",
      );
      const switches = () =>
        page.eval<[string, boolean][]>(
          `[...document.querySelectorAll('${box} input[data-scope]')].map((i) => [i.dataset.scope, i.checked])`,
        );
      const asComputer = await switches();
      assertEquals(asComputer.map(([x]) => x), [
        "phone.read",
        "phone.answer",
        "phone.prompt",
        "phone.start",
        "phone.approve",
        "pc.always",
        "pc.files",
        "pc.terminal",
        "pc.projects",
        "phone.push",
      ]);
      assert(
        asComputer.every(([, on]) => on),
        "lead call 2a: every switch on for a computer",
      );
      // Phone: the computer switches go away; back to Computer: they are there again, still on
      await page.click(`${box} input[data-kind="phone"]`);
      await page.waitFor(
        `!document.querySelector('${box} input[data-scope="pc.terminal"]')`,
        5000,
        "phone: no computer switches",
      );
      await page.click(`${box} input[data-kind="computer"]`);
      await page.waitFor(
        `!!document.querySelector('${box} input[data-scope="pc.terminal"]')`,
        5000,
        "computer switches back",
      );
      await page.click(`${box} input[data-scope="pc.terminal"]`);
      await page.eval(`document.querySelector('${box}').scrollIntoView()`);
      await page.shot("pc-approve-box");
      await page.eval(
        `[...document.querySelectorAll('${box} button')].find((b) => b.textContent === 'Approve').click()`,
      );
      await until(
        async () => {
          const [, v] = await pc(s, "GET", "/api/live/devices");
          return ((v.devices ?? []) as Json[]).some((d) =>
            d.name === "Laptop (Edge)"
          );
        },
        "approved",
        8000,
      );
      const [, v] = await pc(s, "GET", "/api/live/devices");
      const row = (v.devices as Json[]).find((d) =>
        d.name === "Laptop (Edge)"
      )!;
      assertEquals(row.kind, "computer");
      assertEquals(
        (row.scopes as string[]).sort(),
        COMPUTER_SCOPES.filter((x) => x !== "pc.terminal").sort(),
      );
      // its row: Computer tag, its switches, and the lost-computer help line
      const devRow = `.dv-device[data-device="${row.id}"]`;
      await page.waitFor(
        `!!document.querySelector('${devRow} input[data-scope="pc.terminal"]')`,
        8000,
        "the row has computer switches",
      );
      assertEquals(
        await page.eval(
          `document.querySelector('${devRow} .dv-kind-tag').textContent`,
        ),
        "Computer",
      );
      assertEquals(
        await page.eval(
          `document.querySelector('${devRow} input[data-scope="pc.terminal"]').checked`,
        ),
        false,
      );
      await page.eval(`document.querySelector('${devRow}').scrollIntoView()`);
      const help = await page.eval<string>(
        `document.getElementById('dvLostComputer').textContent`,
      );
      assert(
        help.startsWith(
          "Lost a computer? Remove it, then sign the agents out and in again.",
        ),
        help,
      );
      await page.shot("pc-approve-kind");
      assertEquals(page.errors, [], "console errors");
      await page.close();
    } finally {
      await browser.close();
      await s.close();
    }
  },
});
