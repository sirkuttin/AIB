/**
 * Keep this PC awake while AIB runs (server/platform/keep_awake.ts, Settings > server > keepAwake). Everything but the Windows test
 * uses a fake backend: no real power request is taken. The Windows test takes one and clears it at once.
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  backendFor,
  helperBackend,
  KeepAwake,
  linuxBackend,
  macBackend,
  realBackend,
  recordingBackend,
  windowsBackend,
} from "../../outputs/agent-studio/server/platform/keep_awake.ts";
import {
  makeContext,
  WebServer,
} from "../../outputs/agent-studio/server/web/server.ts";
import type { LiveBackend } from "../../outputs/agent-studio/server/host/backend.ts";
import type { UpdateService } from "../../outputs/agent-studio/server/desktop/updater.ts";
import type { Source } from "../../outputs/agent-studio/server/transcripts/monitor.ts";

Deno.test("backend selection per OS", () => {
  assertEquals(backendFor("windows")?.name, "windows-power-request");
  assertEquals(backendFor("darwin")?.name, "caffeinate");
  assertEquals(backendFor("linux")?.name, "systemd-inhibit");
  assertEquals(backendFor("freebsd"), null);
});

Deno.test("mac and linux helpers are the documented commands, tied to the AIB pid, killed on off or exit", () => {
  const real = Deno.Command;
  const calls: { command: string; args: string[] }[] = [];
  const kills: number[] = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    constructor(command: string, options: { args: string[] }) {
      calls.push({ command, args: options.args });
    }
    spawn() {
      return { status: new Promise(() => {}), kill: () => kills.push(1) };
    }
  };
  try {
    const mac = new KeepAwake(macBackend(4242));
    mac.apply(true);
    mac.apply(false);
    const lin = new KeepAwake(linuxBackend(4242));
    lin.apply(true);
    lin.release();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = real;
  }
  assertEquals(calls[0], { command: "caffeinate", args: ["-i", "-w", "4242"] });
  assertEquals(calls[1].command, "systemd-inhibit");
  assert(
    calls[1].args.includes("--what=idle:sleep") &&
      calls[1].args.includes("--mode=block"),
  );
  assert(
    calls[1].args.at(-1)!.includes("kill -0 4242"),
    "the inhibitor ends when AIB is gone",
  );
  assertEquals(kills.length, 2, "each helper killed on off / release");
});

Deno.test("on takes the request, off releases it, exit releases it, twice is harmless", () => {
  const log: string[] = [];
  const k = new KeepAwake(recordingBackend((l) => log.push(l)));
  assertEquals(k.status(), {
    on: false,
    active: false,
    error: "",
    backend: "recording",
  });
  assertEquals(k.apply(false).active, false);
  assertEquals(log, [], "off at start takes nothing");
  assertEquals(k.apply(true), {
    on: true,
    active: true,
    error: "",
    backend: "recording",
  });
  k.apply(true);
  assertEquals(log, ["acquire"], "on twice takes one request");
  assertEquals(k.apply(false).active, false);
  assertEquals(log, ["acquire", "release"]);
  k.apply(true);
  k.release(); // AIB closing
  k.release();
  assertEquals(log, ["acquire", "release", "acquire", "release"]);
  assertEquals(k.status().active, false);
});

Deno.test("a refused request shows an error line and holds nothing; turning off clears it", () => {
  const k = new KeepAwake(
    recordingBackend(() => {}, "Windows refused the request (error 5)"),
  );
  const s = k.apply(true);
  assertEquals([s.on, s.active, s.error], [
    true,
    false,
    "Windows refused the request (error 5)",
  ]);
  assertEquals(k.apply(false).error, "");
});

Deno.test("a missing helper program is reported, not thrown", () => {
  const k = new KeepAwake(
    helperBackend("x", "aib-no-such-program-for-test", [], "a test"),
  );
  const s = k.apply(true);
  assertEquals(s.active, false);
  assert(s.error.includes("is not available"), s.error);
});

Deno.test("no backend (a test run): on is remembered, nothing is held", () => {
  const k = new KeepAwake(null);
  assertEquals(k.apply(true), {
    on: true,
    active: false,
    error: "",
    backend: "none",
  });
});

Deno.test("a test run takes no real request unless a recording log is named", () => {
  assertEquals(
    realBackend(
      (k) => (k === "AGENT_STUDIO_TEST" ? "1" : undefined),
      "windows",
    ),
    null,
  );
  const file = Deno.makeTempFileSync();
  try {
    const env: Record<string, string> = {
      AGENT_STUDIO_TEST: "1",
      AIB_TEST_KEEP_AWAKE_LOG: file,
    };
    const b = realBackend((k) => env[k], "windows")!;
    assertEquals(b.name, "recording");
    b.acquire(() => {}).release();
    assertEquals(Deno.readTextFileSync(file), "acquire\nrelease\n");
  } finally {
    Deno.removeSync(file);
  }
  assertEquals(
    realBackend(() => undefined, "darwin")?.name,
    "caffeinate",
    "outside tests the real backend",
  );
});

Deno.test({
  name: "Windows: a power request is really created, set and cleared",
  ignore: Deno.build.os !== "windows",
  fn() {
    const k = new KeepAwake(windowsBackend("AIB test: released at once"));
    const s = k.apply(true);
    assertEquals(s.error, "");
    assertEquals(
      s.active,
      true,
      "PowerCreateRequest and PowerSetRequest accepted",
    );
    assertEquals(k.apply(false).active, false);
    assertEquals(k.apply(true).active, true);
    k.release();
    assertEquals(k.status().active, false);
  },
});

Deno.test("settings route: the switch persists and toggles the backend; the saved value applies at start", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "aib-keepawake-" });
  const log: string[] = [];
  const make = () =>
    makeContext({
      stateDir,
      host: {
        liveList: () => Promise.resolve({ connections: [] }),
      } as unknown as LiveBackend,
      updates: {} as UpdateService,
      webInstanceId: "test",
      cliPort: 0,
      transcripts: {} as Source,
      claudeProjects: stateDir,
      ompSessions: stateDir,
      shutdown: () => {},
      keepAwakeBackend: recordingBackend((l) => log.push(l)),
    });
  const ctx = make();
  const server = new WebServer(ctx);
  const port = await server.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const headers = {
    "X-Studio-Token": ctx.token,
    Origin: origin,
    "Content-Type": "application/json",
  };
  const get = async () =>
    (await fetch(`${origin}/api/live/settings`, { headers })).json();
  const send = (body: unknown) =>
    fetch(`${origin}/api/live/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const post = async (body: unknown) => (await send(body)).json();
  try {
    let d = await get();
    assertEquals(d.settings.server.keepAwake, false, "off by default");
    assertEquals(d.keepAwake.active, false);
    d = await post({ server: { keepAwake: true } });
    assertEquals([
      d.settings.server.keepAwake,
      d.keepAwake.active,
      d.keepAwake.error,
    ], [true, true, ""]);
    assertEquals(log, ["acquire"]);
    assertEquals((await get()).keepAwake.active, true);
    const bad = await send({ server: { keepAwake: "yes" } });
    await bad.body?.cancel();
    assert(bad.status >= 400, "only true or false");
    d = await post({ server: { keepAwake: false } });
    assertEquals([d.settings.server.keepAwake, d.keepAwake.active], [
      false,
      false,
    ]);
    assertEquals(log, ["acquire", "release"]);
    await post({ server: { keepAwake: true } });
  } finally {
    ctx.keepAwake.release();
    await server.close();
  }
  // a new AIB start reads the saved value
  const next = make();
  assertEquals(next.settings.keepAwake(), true);
  assertEquals(next.keepAwake.apply(next.settings.keepAwake()).active, true);
  next.keepAwake.release();
  assertEquals(
    log.filter((l) => l === "acquire").length,
    log.filter((l) => l === "release").length,
    "nothing left held",
  );
  await Deno.remove(stateDir, { recursive: true }).catch(() => {});
});
