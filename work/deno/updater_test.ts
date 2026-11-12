/**
 * server/desktop/updater.ts and update_helper.ts: the cases of work/test_updater.py that still apply to the Deno packages, parity
 * with updater.py where the behaviour is still meant to be equal (versions, platform keys, SHA256SUMS lines, allowed hosts, reading
 * state.json), and the in-place swap on real temp folders. A local Deno.serve fake stands in for GitHub; nothing here touches the
 * real network or a real app (the "new app" the helper starts is a fake).
 *
 * Parity dropped at stage D (updater.py keeps the Tauri packages: -setup.exe, .dmg, NSIS): installer_kinds, pick_asset, pick_release,
 * instructions, Python installing what Deno downloaded, and Deno reading a download Python picked. The helper is no longer an NSIS
 * runner, so test_updater HelperTests' installer cases are replaced by swap and rollback tests.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "./_assert.ts";
import { PyParity } from "./_parity.ts";
import {
  BASE_ENV,
  checksumFor,
  checkUrl,
  compare,
  getUpdate,
  installerKinds,
  parentOf,
  parseVersion,
  pickAsset,
  pickRelease,
  platformKey,
  RETRY_INTERVAL,
  postUpdateCheck,
  postUpdateInstall,
  defaultRepo,
  PLACEHOLDER_REPO,
  REPO_ENV,
  UPDATE_REPO,
  UpdateError,
  UpdateService,
  type KeeperState,
  type UpdateServiceOptions,
} from "../../outputs/agent-studio/server/desktop/updater.ts";
import {
  cleanEnv,
  defaultStart,
  type HelperArgs,
  installTarget,
  main as helperMain,
  removeUpdateLeftovers,
  removeUpdateLeftoversSoon,
  updateLeftoversLeft,
  JOURNAL_NAME,
  recoverInterruptedUpdate,
  rollback,
  run as runHelper,
  type StartResult,
  swapFolder,
} from "../../outputs/agent-studio/server/desktop/update_helper.ts";
import { writeZip } from "../../tools/build.ts";
import { kernel32, wide } from "../../outputs/agent-studio/server/platform/win32.ts";
import { ValueError } from "../../outputs/agent-studio/server/core/py.ts";
import { PROTOCOL_VERSION } from "../../outputs/agent-studio/server/host/host_client.ts";
import { claimFolder } from "../../outputs/agent-studio/server/desktop/single_instance.ts";

const INSTALLER = "AIB-0.1.0-beta.2-windows-x64.zip";
const PAYLOAD = new TextEncoder().encode("MZ fake installer bytes".repeat(50));
const WINDOWS = Deno.build.os === "windows";

async function sha(data: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
    ),
  ].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function release(
  tag: string,
  assets: unknown[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-"),
    html_url: "https://example.invalid/" + tag,
    assets,
    ...extra,
  };
}

interface FakeOptions {
  tag?: string;
  payload?: Uint8Array;
  sumsHash?: string;
  sumsName?: string;
  withSums?: boolean;
  /** A release.json asset with this text (listed in SHA256SUMS). */
  info?: string;
}

/** Serves /repos/acme/aib/releases and the asset downloads; counts every request. */
class FakeGitHub {
  requests: string[] = [];
  server: Deno.HttpServer<Deno.NetAddr>;
  base: string;
  constructor(sums: string, o: FakeOptions) {
    const tag = o.tag ?? "v0.1.0-beta.2";
    const payload = o.payload ?? PAYLOAD;
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (req) => {
        const url = new URL(req.url);
        const path = url.pathname + url.search;
        this.requests.push(path);
        if (path.startsWith("/repos/acme/aib/releases")) {
          const assets: unknown[] = [{
            name: INSTALLER,
            state: "uploaded",
            size: payload.length,
            url: this.base + "/assets/1",
          }];
          if (o.info !== undefined) {
            assets.push({ name: "release.json", state: "uploaded", size: o.info.length, url: this.base + "/assets/3" });
          }
          if (o.withSums !== false) {
            assets.push({
              name: "SHA256SUMS",
              state: "uploaded",
              size: 10,
              url: this.base + "/assets/2",
            });
          }
          return Response.json([release(tag, assets)]);
        }
        if (path === "/assets/1") {
          return new Response(payload as Uint8Array<ArrayBuffer>, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        if (path === "/assets/3" && o.info !== undefined) return new Response(o.info);
        if (path === "/assets/2") {
          return new Response(sums, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        return new Response("no", { status: 404 });
      },
    );
    this.base = `http://127.0.0.1:${this.server.addr.port}`;
  }
  static async start(o: FakeOptions = {}): Promise<FakeGitHub> {
    const want = o.sumsHash ?? await sha(o.payload ?? PAYLOAD);
    return new FakeGitHub(
      `${want}  ${o.sumsName ?? INSTALLER}\n${
        "0".repeat(64)
      }  something-else.dmg\n${o.info !== undefined ? `${await sha(new TextEncoder().encode(o.info))}  release.json\n` : ""}`,
      o,
    );
  }
  async [Symbol.asyncDispose]() {
    await this.server.shutdown();
  }
}

class Clock {
  t = 1_000_000;
  now = () => this.t;
}

/** A temp state folder, the env override pointing at a fake (or nowhere), restored afterwards. */
class Env {
  dir = Deno.makeTempDirSync({ prefix: "aib-updater-test-" });
  clock = new Clock();
  #saved = Deno.env.get(BASE_ENV);
  base(value: string) {
    Deno.env.set(BASE_ENV, value);
  }
  service(o: UpdateServiceOptions = {}) {
    return new UpdateService(this.dir, {
      key: ["windows", "x64"],
      current: "0.1.0-beta.1",
      env: {},
      repo: "acme/aib",
      now: this.clock.now,
      ...o,
    });
  }
  [Symbol.dispose]() {
    if (this.#saved === undefined) Deno.env.delete(BASE_ENV);
    else Deno.env.set(BASE_ENV, this.#saved);
    Deno.removeSync(this.dir, { recursive: true });
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const DEAD = "http://127.0.0.1:9"; // nothing listens there
/** The desktop app on Windows (installed in C:\\AIB). */
const APP = { desktop: true, pid: 4242, exe: "C:\\AIB\\AIB.exe" };

// ---- versions, platforms, release choice (with Python parity) ---------------------------------------------------------
Deno.test("parseVersion and compare match test_updater and Python", async () => {
  assertEquals(parseVersion("v0.1.0-beta.2"), [0, 1, 0, ["beta", "2"]]);
  assertEquals(parseVersion("1.2.3"), [1, 2, 3, []]);
  for (
    const bad of ["", "latest", "1.2", "v1.2.3.4", "1.2.x", null, "v1.2.3-"]
  ) assertEquals(parseVersion(bad), null, String(bad));
  const c = compare;
  assertEquals(c("0.1.0", "0.1.0"), 0);
  assertEquals(c("0.1.1", "0.1.0"), 1);
  assertEquals(c("0.10.0", "0.9.9"), 1);
  assertEquals(c("0.1.0-beta.1", "0.1.0"), -1);
  assertEquals(c("0.1.0", "0.1.0-rc.1"), 1);
  assertEquals(c("0.1.0-beta.2", "0.1.0-beta.1"), 1);
  assertEquals(c("0.1.0-beta.10", "0.1.0-beta.2"), 1);
  assertEquals(c("0.1.0-alpha", "0.1.0-beta"), -1);
  assertEquals(c("0.1.0-beta", "0.1.0-beta.1"), -1);
  assertEquals(c("0.1.0-1", "0.1.0-beta"), -1);
  assertEquals(c("v0.2.0-beta.1", "0.1.9"), 1);
  assertThrows(() => c("nope", "0.1.0"), ValueError);

  await using py = new PyParity();
  const texts = [
    "v0.1.0-beta.2",
    "1.2.3",
    " v1.2.3 ",
    "1.2.3+build.5",
    "1.2.3-rc.1+b",
    "01.2.3",
    "V1.2.3",
    "1.2.3-a..b",
    5,
    null,
    "",
  ];
  await py.same(
    "updater",
    "parse_version",
    texts.map((t) => [t]),
    parseVersion,
  );
  const versions = [
    "0.1.0",
    "0.1.0-beta",
    "0.1.0-beta.1",
    "0.1.0-beta.2",
    "0.1.0-beta.10",
    "0.1.0-1",
    "0.1.0-alpha",
    "0.1.0-rc.1",
    "1.0.0",
    "v0.9.9",
  ];
  const pairs = versions.flatMap((a) => versions.map((b) => [a, b]));
  await py.same("updater", "compare", pairs, compare);
  assertEquals(
    (await py.raw("updater", "compare", ["x", "1.0.0"])) as unknown,
    { error: "ValueError", message: "not a version" },
  );
});

Deno.test("platformKey matches Python for Python names, and reads Deno names", async () => {
  assertEquals(platformKey("win32", "AMD64"), ["windows", "x64"]);
  assertEquals(platformKey("win32", "ARM64"), ["windows", "arm64"]);
  assertEquals(platformKey("darwin", "arm64"), ["macos", "arm64"]);
  assertEquals(platformKey("linux", "x86_64"), ["linux", "x64"]);
  assertEquals(platformKey("freebsd", "x86_64"), null);
  assertEquals(platformKey("linux", "riscv64"), null);
  assertEquals(platformKey("windows", "x86_64"), ["windows", "x64"]);
  assertEquals(platformKey("darwin", "aarch64"), ["macos", "arm64"]);
  assert(platformKey() !== null, "this machine is supported");
  await using py = new PyParity();
  const inputs = [
    ["win32", "AMD64"],
    ["cygwin", "x86_64"],
    ["darwin", "arm64"],
    ["macos", "x64"],
    ["linux2", "aarch64"],
    ["freebsd", "x64"],
    ["linux", "i686"],
    ["Windows", "X64"],
  ];
  await py.same("updater", "platform_key", inputs, platformKey);
});

Deno.test("installer kinds: zips on Windows and macOS, AppImage or .deb on Linux", () => {
  assertEquals([...installerKinds("windows", {})], [".zip"]);
  assertEquals([...installerKinds("macos", {})], [".zip"]);
  assertEquals([...installerKinds("linux", { APPIMAGE: "/x" }, () => true)], [".appimage", ".deb"]);
  assertEquals([...installerKinds("linux", {}, () => true)], [".deb", ".appimage"]);
  assertEquals([...installerKinds("linux", { APPIMAGE: "" }, () => false)], [".appimage", ".deb"]);
});

function assets(names: string[], sums = true) {
  const out: Record<string, unknown>[] = names.map((n) => ({
    name: n,
    state: "uploaded",
    url: "u/" + n,
    size: 1,
  }));
  if (sums) out.push({ name: "SHA256SUMS", state: "uploaded", url: "u/sums" });
  return out;
}

Deno.test("the asset for this platform and arch, betas, newest wins (test_updater ReleaseChoiceTests, new names)", () => {
  const names = [
    "AIB-0.2.0-windows-x64.zip",
    "AIB-0.2.0-windows-arm64.zip",
    "AIB-0.2.0-macos-x64.zip",
    "AIB-0.2.0-macos-arm64.zip",
    "AIB-0.2.0-linux-x64.AppImage",
    "AIB-0.2.0-linux-arm64.AppImage",
    "AIB-0.2.0-linux-x64.deb",
    "AIB-0.2.0-linux-arm64.deb",
    "AIB_0.2.0_x64-setup.exe",
    "AIB_0.2.0_aarch64.dmg",
  ];
  const rel = [release("v0.2.0", assets(names))];
  const pick = (key: [string, string], env = {}, dpkg = true) =>
    pickRelease(rel, "0.1.0", key, env, () => dpkg)?.installer.name ?? null;
  assertEquals(pick(["windows", "x64"]), "AIB-0.2.0-windows-x64.zip");
  assertEquals(pick(["windows", "arm64"]), "AIB-0.2.0-windows-arm64.zip");
  assertEquals(pick(["macos", "x64"]), "AIB-0.2.0-macos-x64.zip");
  assertEquals(pick(["macos", "arm64"]), "AIB-0.2.0-macos-arm64.zip");
  assertEquals(pick(["linux", "x64"], { APPIMAGE: "/x" }), "AIB-0.2.0-linux-x64.AppImage");
  assertEquals(pick(["linux", "arm64"], { APPIMAGE: "/x" }), "AIB-0.2.0-linux-arm64.AppImage");
  assertEquals(pick(["linux", "x64"]), "AIB-0.2.0-linux-x64.deb");
  assertEquals(pick(["linux", "arm64"]), "AIB-0.2.0-linux-arm64.deb");
  assertEquals(pick(["linux", "x64"], {}, false), "AIB-0.2.0-linux-x64.AppImage", "no dpkg: the AppImage");
  // A macOS zip is never taken for Windows (and the other way round); the Tauri names are not offered at all.
  const onlyMac = [release("v0.2.0", assets(["AIB-0.2.0-macos-x64.zip"]))];
  assertEquals(pickRelease(onlyMac, "0.1.0", ["windows", "x64"]), null);
  const tauri = [release("v0.2.0", assets(["AIB_0.2.0_x64-setup.exe", "AIB_0.2.0_aarch64.dmg"]))];
  assertEquals(pickRelease(tauri, "0.1.0", ["windows", "x64"]), null);
  assertEquals(pickRelease(tauri, "0.1.0", ["macos", "arm64"]), null);
  assertEquals(pickAsset(assets(names), null, {}), null);

  const beta = [release("v0.2.0-beta.1", assets(["AIB-0.2.0-beta.1-windows-x64.zip"]))];
  assertEquals(pickRelease(beta, "0.1.0", ["windows", "x64"]), null, "stable never moves to a beta");
  const got = pickRelease(beta, "0.1.0-beta.1", ["windows", "x64"])!;
  assertEquals([got.version, got.prerelease], ["0.2.0-beta.1", true]);
  assertEquals(pickRelease(beta, "0.2.0-beta.1", ["windows", "x64"]), null);
  assertEquals(pickRelease(beta, "0.2.0", ["windows", "x64"]), null);

  const good = assets(["AIB-x-windows-x64.zip"]);
  const rels = [
    release("v0.1.0-beta.3", good),
    release("v0.1.0-beta.12", good),
    release("v0.1.0-beta.5", good, { draft: true }),
    release("v0.1.0-beta.9", assets(["AIB-x-windows-x64.zip"], false)),
    release("nightly", good),
    release("v0.1.0-beta.8", assets(["AIB-x-windows-arm64.zip"])),
  ];
  assertEquals(pickRelease(rels, "0.1.0-beta.1", ["windows", "x64"])!.version, "0.1.0-beta.12");
  assertEquals(pickRelease("nope", "0.1.0", ["windows", "x64"]), null);
  const odd = [
    { name: "AIB-1-windows-x64.zip", state: "new", url: "u" },
    { name: "-AIB-1-windows-x64.zip", url: "u" },
    { name: "AIB 1-windows-x64.zip", url: "u" },
    { name: 7, url: "u" },
    { name: "AIB-1-WINDOWS-X64.ZIP", url: "u", size: "12" },
  ];
  assertEquals(pickAsset(odd, ["windows", "x64"], {})?.name, "AIB-1-WINDOWS-X64.ZIP");
});

Deno.test("checksum lines (test_updater + Python parity)", async () => {
  const h = "a".repeat(64);
  assertEquals(checksumFor(`${h}  file.exe\n`, "file.exe"), h);
  assertEquals(checksumFor(`${h.toUpperCase()} *file.exe\r\n`, "file.exe"), h);
  for (
    const text of [
      "",
      `${h}  other.exe\n`,
      `${h}  file.exe\n${h}  file.exe\n`,
      `${h}  file.exe.sig\n`,
      "zz  file.exe",
    ]
  ) {
    const error = assertThrows(
      () => checksumFor(text, "file.exe"),
      UpdateError,
    ) as UpdateError;
    assertEquals(error.code, "no_checksum");
  }
  await using py = new PyParity();
  const texts = [
    `${h}  file.exe\n`,
    `${h}  file.exe   \t\n`,
    `\r${h}  file.exe\r\r\n`,
    `${h} file.exe`,
    `${h}file.exe`,
    `${h}  *file.exe`,
    `${h}   file.exe`,
    ` ${h}  file.exe`,
    `${h}  file.exe\u00a0`,
    `${h}  file.exe\u001f`,
    `${h}  file.exe\ufeff`,
    `${h}  file.exe\n${"b".repeat(64)}  x\n`,
  ];
  for (const text of texts) {
    let mine: unknown;
    try {
      mine = checksumFor(text, "file.exe");
    } catch (error) {
      mine = {
        error: (error as Error).message,
        code: (error as UpdateError).code,
      };
    }
    assertEquals(
      mine,
      await py.call("updater_shim", "checksum_for", [text, "file.exe"]),
      JSON.stringify(text),
    );
  }
});

Deno.test("only GitHub hosts are followed (and the test hook host)", async () => {
  for (
    const ok of [
      "https://api.github.com/x",
      "https://objects.githubusercontent.com/y",
      "https://github.com/z",
    ]
  ) {
    checkUrl(ok, ["https://api.github.com", false]);
  }
  const bads = [
    "http://api.github.com/x",
    "https://evil.example/x",
    "https://api.github.com.evil.example/x",
    "https://user@api.github.com/x",
    "https://api.github.com:8443/x",
    "https://githubusercontent.com.evil.test/",
  ];
  for (const bad of bads) {
    assertThrows(
      () => checkUrl(bad, ["https://api.github.com", false]),
      UpdateError,
    );
  }
  await using py = new PyParity();
  const urls = [
    ...bads,
    "https://api.github.com/x",
    "https://API.GitHub.com/x",
    "https://api.github.com:443/x",
    "https://x.githubusercontent.com/y",
    "http://127.0.0.1:5000/a",
    "http://127.0.0.1:5001/a",
    "https://127.0.0.1:5000/a",
    "http://localhost:5000/a",
    "http://u:p@127.0.0.1:5000/",
  ];
  for (const base of ["", "http://127.0.0.1:5000"]) {
    for (const url of urls) {
      let mine: unknown = null;
      try {
        checkUrl(url, base ? [base, true] : ["https://api.github.com", false]);
      } catch (error) {
        mine = {
          error: (error as Error).message,
          code: (error as UpdateError).code,
        };
      }
      assertEquals(
        mine,
        await py.call("updater_shim", "check_url", [url, base]),
        `${base} ${url}`,
      );
    }
  }
});

Deno.test("instructions for each package kind, and parentOf", () => {
  using env = new Env();
  const svc = env.service({ key: ["linux", "x64"] });
  assert(svc.instructions("/home/u/AIB-0.2.0-linux-x64.deb").includes("sudo apt install"));
  assert(svc.instructions("/home/u/AIB-0.2.0-linux-x64.AppImage").includes("chmod +x"));
  assert(svc.instructions("/Users/u/AIB-0.2.0-macos-arm64.zip").includes("AIB.app to Applications"));
  assert(svc.instructions("C:\\u\\AIB-0.2.0-windows-x64.zip").includes("AIB folder"));
  assertEquals(parentOf(WINDOWS ? "C:\\a\\b.exe" : "/a/b.exe"), WINDOWS ? "C:\\a" : "/a");
});

/** Env with async disposal, for tests that also hold a PyParity. */
class AsyncEnv {
  e = new Env();
  [Symbol.asyncDispose]() {
    this.e[Symbol.dispose]();
    return Promise.resolve();
  }
}

// ---- checking and verifying (test_updater CheckAndVerifyTests) ---------------------------------------------------------
Deno.test("found, downloaded, verified", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const st = await env.service().check();
  assertEquals(st.state, "ready");
  const available = st.available as Record<string, string>;
  assertEquals(available.version, "0.1.0-beta.2");
  assertEquals(Deno.readFileSync(available.path), PAYLOAD);
  assertEquals(available.sha256, await sha(PAYLOAD));
  assert(
    available.path.startsWith(env.dir + (WINDOWS ? "\\" : "/") + "updates"),
    available.path,
  );
  assert(!walk(env.dir).some((p) => p.endsWith(".part")));
  assert(fake.requests.includes("/repos/acme/aib/releases?per_page=30"));
});

Deno.test("a hash mismatch is refused and deleted; a missing line is refused; no SHA256SUMS asset is not offered", async () => {
  {
    using env = new Env();
    await using fake = await FakeGitHub.start({ sumsHash: "f".repeat(64) });
    env.base(fake.base);
    const svc = env.service();
    const st = await svc.check();
    assertEquals([st.state, st.errorCode, st.available], [
      "refused",
      "checksum_mismatch",
      undefined,
    ]);
    assertEquals(walk(env.dir).filter((p) => p.includes(".exe")), []);
    const error = await assertRejects(
      () => svc.install(),
      UpdateError,
    ) as UpdateError;
    assertEquals(error.code, "not_ready");
  }
  {
    using env = new Env();
    await using fake = await FakeGitHub.start({
      sumsName: "some-other-file.exe",
    });
    env.base(fake.base);
    const st = await env.service().check();
    assertEquals([st.state, st.errorCode], ["refused", "no_checksum"]);
    assertEquals(walk(env.dir).filter((p) => p.includes(".exe")), []);
  }
  {
    using env = new Env();
    await using fake = await FakeGitHub.start({ withSums: false });
    env.base(fake.base);
    assertEquals((await env.service().check()).state, "none");
  }
});

Deno.test("a file tampered with on disk is not run", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const launched: HelperArgs[] = [];
  const svc = env.service({
    launcher: (a) => void launched.push(a),
    app: { ...APP },
  });
  const st = await svc.check();
  Deno.writeTextFileSync(
    (st.available as Record<string, string>).path,
    "changed",
  );
  await assertRejects(() => svc.install(), UpdateError);
  assertEquals(launched, []);
});

Deno.test("no newer release; failures are reported; the placeholder repository makes no call", async () => {
  {
    using env = new Env();
    await using fake = await FakeGitHub.start({ tag: "v0.1.0-beta.1" });
    env.base(fake.base);
    assertEquals((await env.service().check()).state, "none");
    env.base(DEAD);
    const st = await env.service().check(true);
    assertEquals([st.state, st.errorCode], ["error", "offline"]);
  }
  {
    using env = new Env();
    env.base("");
    let calls = 0;
    const svc = new UpdateService(env.dir, {
      now: env.clock.now,
      key: ["windows", "x64"],
      env: {},
      fetch: () => (calls++, Promise.reject(new Error("no"))),
    });
    assertEquals((await svc.check(true)).state, "unconfigured");
    assertEquals(calls, 0);
  }
});

Deno.test("redirects are followed by hand to checked hosts only; errors carry Python codes", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const seen: string[] = [];
  const redirecting =
    (target: string) => (input: string, init: RequestInit) => {
      seen.push(input);
      if (input.endsWith("per_page=30") || input.endsWith("?again")) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { Location: target } }),
        );
      }
      return fetch(input, init);
    };
  // A redirect to the same (test) host is followed.
  const st = await env.service({
    fetch: redirecting(fake.base + "/repos/acme/aib/releases/real"),
  }).check(true);
  assertEquals(st.state, "ready");
  // One anywhere else is refused before any request goes there.
  const bad = await env.service({
    fetch: redirecting("https://evil.example/x"),
  }).check(true);
  assertEquals(
    [bad.state, bad.errorCode],
    ["ready", "bad_host"],
    "the earlier verified download is still offered (as Python)",
  );
  assert(!seen.some((u) => u.includes("evil")));
  const loop = await env.service({
    fetch: redirecting("/repos/acme/aib/releases?again"),
  }).check(true);
  assertEquals(loop.errorCode, "http_error");
  const status500 = await env.service({
    fetch: () => Promise.resolve(new Response("x", { status: 500 })),
  }).check(true);
  assertEquals([status500.errorCode, status500.error], [
    "http_error",
    "GitHub did not answer the update request (500). Try again later.",
  ]);
  const junk = await env.service({
    fetch: () => Promise.resolve(new Response("{nope")),
  }).check(true);
  assertEquals(junk.errorCode, "bad_response");
  const page = await env.service({
    fetch: (input, init) =>
      input.endsWith("/assets/1")
        ? Promise.resolve(
          new Response("<html>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
        )
        : fetch(input, init),
  });
  Deno.removeSync(env.dir + "/updates", { recursive: true });
  const pageStatus = await page.check(true);
  assertEquals(pageStatus.errorCode, "bad_download");
});

// ---- throttle and toggle (test_updater ThrottleAndToggleTests) ---------------------------------------------------------
Deno.test("automatic checks run at most once a day, across restarts; failures are not retried in a loop; manual ignores it", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start({ tag: "v0.1.0-beta.1" });
  env.base(fake.base);
  const svc = env.service();
  await svc.check();
  assertEquals(fake.requests.length, 1);
  env.clock.t += 3600 * 23;
  await svc.check();
  await svc.check();
  assertEquals(fake.requests.length, 1, "no network inside a day");
  await env.service().check(); // a new service over the same state folder
  assertEquals(fake.requests.length, 1, "the throttle survives a restart");
  env.clock.t += 3600 * 2;
  await svc.check();
  assertEquals(fake.requests.length, 2, "a day later it asks again");
  await svc.check(true);
  assertEquals(fake.requests.length, 3, "manual ignores the throttle");

  using env2 = new Env();
  env2.base(DEAD);
  const failing = env2.service();
  await failing.check();
  assertEquals(failing.due(), false);
});

Deno.test("toggle off means no network call; the button still works", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const svc = env.service({ autoCheck: () => false });
  for (let i = 0; i < 3; i++) {
    assertEquals((await svc.check()).state, "none");
    await svc.tick();
    env.clock.t += 3 * 86400;
  }
  assertEquals(fake.requests, []);
  assertEquals((await svc.check(true)).state, "ready");
});

Deno.test("a second check while one runs returns at once (checking: true)", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const svc = env.service();
  const first = svc.check(true);
  const second = await svc.check(true);
  assertEquals(second.checking, true);
  assertEquals((await first).state, "ready");
  assertEquals(svc.status().checking, false);
  assertEquals(fake.requests.filter((r) => r.startsWith("/repos")).length, 1);
});

// ---- installing (test_updater InstallTests) ----------------------------------------------------------------------------

async function ready(env: Env, busy: number, o: UpdateServiceOptions = {}) {
  const launched: HelperArgs[] = [];
  const quit: number[] = [];
  const state = { busy } as { busy: number | (() => never) };
  const svc = env.service({
    launcher: (a) => void launched.push(a),
    quit: () => void quit.push(1),
    busyChats:
      () => (typeof state.busy === "function" ? state.busy() : state.busy),
    app: { ...APP },
    ...o,
  });
  assertEquals((await svc.check()).state, "ready");
  return { svc, state, launched, quit };
}

Deno.test("install now runs the helper and quits", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const { svc, launched, quit } = await ready(env, 0);
  assertEquals((await svc.install()).state, "installing");
  assertEquals(launched.length, 1);
  const a = launched[0];
  assertEquals([a.pid, a.exe, a.sha256, a.version, a.kind, a.target], [
    4242,
    "C:\\AIB\\AIB.exe",
    await sha(PAYLOAD),
    "0.1.0-beta.2",
    "windows-zip",
    "C:\\AIB",
  ]);
  assertEquals(
    a.log,
    `${env.dir}${WINDOWS ? "\\" : "/"}updates${
      WINDOWS ? "\\" : "/"
    }install.log`,
  );
  assertEquals(quit, [1]);
});

Deno.test("install is deferred while chats work; when-idle waits, then installs on a tick; cancel works; unknown counts as busy", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  {
    const { svc, launched, quit } = await ready(env, 2);
    const error = await assertRejects(
      () => svc.install(),
      UpdateError,
    ) as UpdateError;
    assertEquals([error.code, error.extra.chats], ["chats_working", 2]);
    assertEquals([launched, quit], [[], []]);
  }
  {
    const { svc, state, launched, quit } = await ready(env, 1);
    assertEquals(await svc.install(true), { state: "waiting", chats: 1 });
    assertEquals(svc.status().installWhenIdle, true);
    await svc.tick();
    assertEquals(launched, [], "still working");
    state.busy = 0;
    await svc.tick();
    assertEquals([launched.length, quit], [1, [1]]);
    assertEquals(svc.status().installWhenIdle, false);
  }
  {
    const { svc, state, launched } = await ready(env, 1);
    await svc.install(true);
    svc.cancelWait();
    state.busy = 0;
    await svc.tick();
    assertEquals(launched, []);
  }
  {
    const { svc, state, launched } = await ready(env, 0);
    state.busy = () => {
      throw new Error("host not answering");
    };
    await assertRejects(() => svc.install(), UpdateError);
    svc.busyChats = () => Promise.reject(new Error("host not answering"));
    await assertRejects(() => svc.install(), UpdateError);
    assertEquals(launched, []);
  }
});

Deno.test("Install when chats finish is held while AIB only stays in the tray after a quit; it installs at the next launch or when the window is back", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  {
    const view = { background: false };
    const { svc, state, launched, quit } = await ready(env, 1, { holdInstall: () => view.background });
    assertEquals(await svc.install(true), { state: "waiting", chats: 1 });
    view.background = true; // the person quit AIB while the chat worked: AIB stays in the tray
    state.busy = 0;
    await svc.tick();
    assertEquals([launched, quit], [[], []], "no update (and no new window) after a quit");
    assertEquals(svc.status().installWhenIdle, true, "still pending");
    // The next launch: a new app on the same data folder, its window open, picks the pending install up on its first tick.
    const next = await ready(env, 0, { holdInstall: () => false });
    assertEquals(next.svc.status().installWhenIdle, true, "kept in state.json");
    await next.svc.tick();
    assertEquals([next.launched.length, next.quit], [1, [1]]);
  }
  {
    const view = { background: true };
    const { svc, launched } = await ready(env, 0, { holdInstall: () => view.background });
    svc.state.installWhenIdle = true;
    await svc.tick();
    assertEquals(launched, []);
    view.background = false; // the person opened the window again
    await svc.tick();
    assertEquals(launched.length, 1);
  }
  {
    const { svc, launched } = await ready(env, 0, { holdInstall: () => { throw new Error("no window state"); } });
    svc.state.installWhenIdle = true;
    await svc.tick();
    assertEquals(launched.length, 1, "an unknown window state never holds an install");
  }
});

Deno.test("with the agent host (chatsKeepRunning) Install now goes ahead while chats work; the new app starts with the same arguments", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start({ info: JSON.stringify({ version: "0.1.0-beta.2", protocol: PROTOCOL_VERSION }) });
  env.base(fake.base);
  const { svc, launched, quit } = await ready(env, 2, { chatsKeepRunning: true, appArgs: ["serve", "--port", "8901"] }); // port-guard: not bound (a fake launcher records it)
  assertEquals(await svc.install(), { state: "installing", chats: 2 });
  assertEquals([launched.length, quit], [1, [1]]);
  assertEquals(launched[0].args, ["serve", "--port", "8901"]); // port-guard: not bound (a fake launcher records it)
  {
    // "Install when chats finish" still waits when asked for.
    const { svc: s2, launched: l2 } = await ready(env, 1, { chatsKeepRunning: true });
    assertEquals(await s2.install(true), { state: "waiting", chats: 1 });
    assertEquals(l2, []);
  }
  {
    // An unknown count is fine too: the chats are in the host, whatever their number.
    const { svc: s3, state, launched: l3 } = await ready(env, 0, { chatsKeepRunning: true });
    state.busy = () => {
      throw new Error("host not answering");
    };
    assertEquals((await s3.install()).state, "installing");
    assertEquals(l3.length, 1);
  }
});

Deno.test("Install now while chats work needs a release that speaks this agent-host protocol (release.json); otherwise it waits", async () => {
  const cases: [string | undefined, string][] = [
    [JSON.stringify({ protocol: PROTOCOL_VERSION + 1 }), "This update changes how AIB runs agents, so it waits until no chat is working (2 now)."],
    [undefined, "AIB cannot tell whether this update can take over running chats, so it waits until no chat is working (2 now)."],
    ['{"protocol": 1', "AIB cannot tell whether"],
  ];
  for (const [info, text] of cases) {
    using env = new Env();
    await using fake = await FakeGitHub.start({ info });
    env.base(fake.base);
    const { svc, launched } = await ready(env, 2, { chatsKeepRunning: true });
    const error = await assertRejects(() => svc.install(), UpdateError) as UpdateError;
    assertEquals(error.code, "chats_working");
    assert(error.message.startsWith(text), error.message);
    assertEquals(launched, []);
    assertEquals((await svc.install(true)).state, "waiting", "Install when chats finish stays available");
  }
});

Deno.test("with the keeper Install now leaves the chats to the new version (release.json keeper); a release or keeper that cannot take them over waits", async () => {
  const keeperInfo = (needs = ["notes", "once", "channel-ids"], protocols = [1]) =>
    JSON.stringify({ version: "0.1.0-beta.2", protocol: PROTOCOL_VERSION, keeper: { protocols, needs } });
  const state = (over: Partial<KeeperState> = {}): KeeperState => ({
    reason: "",
    protocol: 1,
    features: ["pty", "notes", "truncate", "orphan", "signal", "once", "channel-ids"],
    version: "1.0.0",
    dataDir: "C:/data",
    ...over,
  });
  {
    // The new version can take them over: the helper gets the data folder (it keeps the keeper company) and the app releases them.
    using env = new Env();
    await using fake = await FakeGitHub.start({ info: keeperInfo() });
    env.base(fake.base);
    const quits: (boolean | undefined)[] = [];
    const { svc, launched } = await ready(env, 2, { keeper: () => Promise.resolve(state()), quit: (release) => void quits.push(release) });
    assertEquals(svc.state.downloaded?.keeper, { protocols: [1], needs: ["notes", "once", "channel-ids"] });
    assertEquals(await svc.keeperHandover(), true);
    assertEquals(await svc.install(), { state: "installing", chats: 2 });
    assertEquals([launched.length, launched[0].keeper, quits], [1, "C:/data", [true]]);
  }
  {
    // Idle chats in the keeper go over too (no reconnect needed), and nothing is said about chats.
    using env = new Env();
    await using fake = await FakeGitHub.start({ info: keeperInfo() });
    env.base(fake.base);
    const quits: (boolean | undefined)[] = [];
    const { svc, launched } = await ready(env, 0, { keeper: () => Promise.resolve(state()), quit: (release) => void quits.push(release) });
    assertEquals(await svc.install(), { state: "installing" });
    assertEquals([launched[0].keeper, quits], ["C:/data", [true]]);
  }
  const waits: [string | undefined, KeeperState | null | "throws", string, string][] = [
    [JSON.stringify({ version: "0.1.0-beta.2", protocol: PROTOCOL_VERSION }), state(), "release", "This update cannot take running chats over from the keeper, so it waits"],
    [keeperInfo(["notes", "once", "channel-ids", "snapshots"]), state(), "features", "The running keeper is too old for this update to take its chats over, so it waits"],
    [keeperInfo(undefined, [2]), state(), "protocol", "The running keeper is too old"],
    [keeperInfo(), state({ reason: "1 working chat(s) run outside the keeper" }), "outside", "Some working chats do not run in the keeper, so it waits"],
    [keeperInfo(), "throws", "unknown", "AIB cannot tell whether the keeper can hand its chats to this update"],
  ];
  for (const [info, keeper, why, text] of waits) {
    using env = new Env();
    await using fake = await FakeGitHub.start({ info });
    env.base(fake.base);
    const quits: (boolean | undefined)[] = [];
    const { svc, launched } = await ready(env, 2, {
      keeper: () => (keeper === "throws" ? Promise.reject(new Error("no answer")) : Promise.resolve(keeper)),
      quit: (release) => void quits.push(release),
    });
    assertEquals(await svc.keeperHandover(), why);
    const error = await assertRejects(() => svc.install(), UpdateError) as UpdateError;
    assertEquals(error.code, "chats_working");
    assert(error.message.startsWith(text), error.message);
    assertEquals([launched, quits], [[], []]);
    // With nothing working it installs the normal way: the app stops whatever is left (no release, no keeper for the helper).
    const { svc: idle, launched: l2 } = await ready(env, 0, {
      keeper: () => (keeper === "throws" ? Promise.reject(new Error("no answer")) : Promise.resolve(keeper)),
      quit: (release) => void quits.push(release),
    });
    assertEquals((await idle.install()).state, "installing");
    assertEquals([l2[0].keeper, quits], [undefined, [false]]);
  }
  {
    // No keeper running (null): the agent-host rules apply as before.
    using env = new Env();
    await using fake = await FakeGitHub.start({ info: keeperInfo() });
    env.base(fake.base);
    const { svc } = await ready(env, 1, { keeper: () => Promise.resolve(null) });
    assertEquals(await svc.keeperHandover(), "off");
    assertEquals((await assertRejects(() => svc.install(), UpdateError) as UpdateError).message, "1 chat(s) are working. Install when they finish, or wait.");
  }
});

Deno.test("automatic checks never install", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const { svc, launched, quit } = await ready(env, 0);
  for (let i = 0; i < 3; i++) {
    env.clock.t += 2 * 86400;
    await svc.tick();
  }
  assertEquals([launched, quit], [[], []]);
});

Deno.test("canInstallInPlace: the desktop app on Windows, macOS and a Linux AppImage; never .deb or deno run", () => {
  using env = new Env();
  const mac = { desktop: true, pid: 1, exe: "/Applications/AIB.app/Contents/MacOS/laufey_webview" };
  const linux = { desktop: true, pid: 1, exe: "/tmp/.mount_AIBx/usr/bin/aib" };
  const cases: [[string, string], typeof APP, Record<string, string>, boolean][] = [
    [["windows", "x64"], APP, {}, true],
    [["windows", "arm64"], APP, {}, true],
    [["windows", "x64"], { ...APP, desktop: false }, {}, false],
    [["macos", "arm64"], mac, {}, true],
    [["macos", "x64"], mac, {}, true],
    [["macos", "arm64"], { ...mac, exe: "/usr/local/bin/deno" }, {}, false],
    [["macos", "arm64"], { ...mac, desktop: false }, {}, false],
    [["linux", "x64"], linux, { APPIMAGE: "/home/u/AIB.AppImage" }, true],
    [["linux", "arm64"], linux, { APPIMAGE: "/home/u/AIB.AppImage" }, true],
    [["linux", "x64"], linux, {}, false],
    [["linux", "x64"], { ...linux, desktop: false }, { APPIMAGE: "/x" }, false],
  ];
  for (const [key, app, e, want] of cases) {
    assertEquals(env.service({ key, app, env: e }).canInstallInPlace(), want, JSON.stringify([key, app, e]));
  }
  // A Linux AppImage run that could only download a .deb installs by hand.
  const svc = env.service({ key: ["linux", "x64"], app: linux, env: { APPIMAGE: "/x" } });
  svc.state.downloaded = { version: "9.0.0", name: "AIB-9.0.0-linux-x64.deb", path: "/x.deb", sha256: "0" };
  assertEquals(svc.canInstallInPlace(), false);
  svc.state.downloaded = { version: "9.0.0", name: "AIB-9.0.0-linux-x64.AppImage", path: "/x", sha256: "0" };
  assertEquals(svc.canInstallInPlace(), true);
  assertEquals(svc.target(), { kind: "appimage", target: "/x" });
  assertEquals(env.service({ key: ["macos", "arm64"], app: mac }).target(), { kind: "macos-zip", target: "/Applications/AIB.app" });
});

Deno.test("a dev run (deno run) never installs; it gets instructions", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const dev = env.service({
    launcher: () => {
      throw new Error("must not run");
    },
    quit: () => {
      throw new Error("must not quit");
    },
  });
  const st = await dev.check();
  assertEquals([st.state, st.inPlace], ["ready", false]);
  const path = (st.available as Record<string, string>).path;
  assert(st.instructions!.includes(path));
  const error = await assertRejects(
    () => dev.install(),
    UpdateError,
  ) as UpdateError;
  assertEquals([error.code, error.extra.path], ["manual", path]);
});

// ---- routes (web_handler.get_update / post_update_check / post_update_install) -----------------------------------------
Deno.test("route functions: status codes and payloads as web_handler", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const { svc } = await ready(env, 2);
  const [code, body] = getUpdate(svc);
  assertEquals([code, body.state], [200, "ready"]);
  assertEquals(await postUpdateInstall(svc, {}), [409, {
    error: "2 chat(s) are working. Install when they finish, or wait.",
    code: "chats_working",
    chats: 2,
  }]);
  await assertRejects(
    () => postUpdateInstall(svc, { whenIdle: "yes" }),
    ValueError,
  );
  await assertRejects(
    () => postUpdateInstall(svc, { whenIdle: null }),
    ValueError,
  );
  assertEquals(await postUpdateInstall(svc, { whenIdle: true }), [200, {
    state: "waiting",
    chats: 2,
    ok: true,
  }]);
  const [c2, cancelled] = await postUpdateInstall(svc, { cancelWait: true });
  assertEquals([c2, cancelled.installWhenIdle], [200, false]);
  const dev = env.service();
  const [c3, manual] = await postUpdateInstall(dev, {});
  assertEquals([c3, manual.code], [400, "manual"]);
  const [c4, started] = postUpdateCheck(dev);
  assertEquals([c4, started.checking], [200, true]);
  while (dev.status().checking) await new Promise((r) => setTimeout(r, 10));
  using empty = new Env();
  const [c5, none] = await postUpdateInstall(empty.service(), {});
  assertEquals([c5, none.code], [409, "not_ready"]);
});

// ---- state file interop with Python ------------------------------------------------------------------------------------
type PyService = {
  result: unknown;
  state: Record<string, unknown>;
  status: Record<string, unknown>;
  launched: unknown[];
};

/** status() without the Deno-only fields (retryAt, desktop), for comparing with the Python reference. */
function pyView(status: object): Record<string, unknown> {
  const { retryAt: _r, desktop: _d, ...rest } = status as Record<string, unknown>;
  return rest;
}

Deno.test("state.json: refusals and odd files read the same in Deno and Python", async () => {
  await using py = new PyParity();
  await using fake = await FakeGitHub.start();
  {
    // Refusals and odd files read the same way.
    await using a = new AsyncEnv();
    const bad = await FakeGitHub.start({ sumsHash: "f".repeat(64) });
    try {
      a.e.base(bad.base);
      await a.e.service().check();
      assertEquals(
        ((await py.call("updater_shim", "service", [a.e.dir, null], {
          base: bad.base,
        })) as PyService).status,
        pyView(a.e.service().status()),
      );
    } finally {
      await bad.server.shutdown();
    }
    const odd = [
      '{"lastCheck": "12.5", "found": [], "downloaded": 3, "error": 0, "code": null, "installWhenIdle": "yes"}',
      '{"lastCheck": 7, "error": "x", "code": "offline"}',
      "[]",
      '\ufeff{"lastCheck": 9}',
      "not json",
      '{"found": {"version": "0.1.0", "tag": "v0.1.0", "page": ""}}',
      '{"found": {"version": "9.0.0", "tag": "v9.0.0", "page": "p", "prerelease": null}}',
    ];
    for (const text of odd) {
      Deno.mkdirSync(a.e.dir + "/updates", { recursive: true });
      Deno.writeTextFileSync(a.e.dir + "/updates/state.json", text);
      const theirs = await py.call("updater_shim", "service", [a.e.dir, null], {
        base: fake.base,
      }) as PyService;
      const mine = a.e.service();
      assertEquals(mine.state, theirs.state, text);
      assertEquals(pyView(mine.status()), theirs.status, text);
    }
  }
});

// ---- the helper: swap in place and roll back, on real temp folders -----------------------------------------------------
const STAMP = "20260101-120000";
const enc = (t: string) => new TextEncoder().encode(t);
const read = (p: string) => Deno.readTextFileSync(p);
const names = (dir: string) => [...Deno.readDirSync(dir)].map((e) => e.name).sort();

/** A fake Windows install: the launcher, the runtime, a marker, a WebView2 profile, and a file the new version no longer has. */
function fakeWindowsInstall(root: string): string {
  const app = `${root}/AIB`;
  Deno.mkdirSync(`${app}/AIB.exe.WebView2/EBWebView/Default/Local Storage`, { recursive: true });
  Deno.writeTextFileSync(`${app}/AIB.exe.WebView2/EBWebView/Default/Local Storage/leveldb.log`, "the page's localStorage");
  Deno.writeTextFileSync(`${app}/AIB.exe`, "old exe");
  Deno.writeTextFileSync(`${app}/AIB.dll`, "old dll");
  Deno.writeTextFileSync(`${app}/.deno-desktop-app`, "");
  Deno.writeTextFileSync(`${app}/old-only.txt`, "gone in the new version");
  Deno.mkdirSync(`${app}/sub`);
  Deno.writeTextFileSync(`${app}/sub/a.txt`, "old a");
  return app;
}

/** The new version's zip, written by tools/build.ts's own zip writer (AIB/ at the top, as the release assets). */
async function fakeWindowsZip(path: string, exe = "new exe"): Promise<Uint8Array> {
  await writeZip(path, [
    { name: "AIB/", mode: 0o755 },
    { name: "AIB/.deno-desktop-app", data: enc(""), mode: 0o644 },
    { name: "AIB/AIB.dll", data: enc("new dll ".repeat(100)), mode: 0o755 },
    { name: "AIB/AIB.exe", data: enc(exe), mode: 0o755 },
    { name: "AIB/sub/", mode: 0o755 },
    { name: "AIB/sub/a.txt", data: enc("new a"), mode: 0o644 },
  ]);
  return Deno.readFileSync(path);
}

/** Unpacks like tar.exe would, for hosts without it: the same files, from the same zip listing (stored or deflated). */
async function jsUnpack(archive: string, dest: string): Promise<void> {
  const zip = Deno.readFileSync(archive);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let p = 0;
  while (v.getUint32(p, true) === 0x04034b50) {
    const method = v.getUint16(p + 8, true);
    const csize = v.getUint32(p + 18, true);
    const nameLen = v.getUint16(p + 26, true);
    const extra = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(zip.subarray(p + 30, p + 30 + nameLen));
    const body = zip.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + csize);
    if (name.endsWith("/")) Deno.mkdirSync(`${dest}/${name}`, { recursive: true });
    else {
      const data = method === 8
        ? new Uint8Array(
          await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer(),
        )
        : body;
      Deno.writeFileSync(`${dest}/${name}`, data);
    }
    p += 30 + nameLen + extra + csize;
  }
}

interface Case {
  dir: string;
  app: string;
  args: HelperArgs;
  started: string[][];
}

async function windowsCase(o: { tamper?: boolean } = {}): Promise<Case> {
  const dir = Deno.makeTempDirSync({ prefix: "aib-helper-test-" });
  const app = fakeWindowsInstall(dir);
  const zip = `${dir}/AIB-0.2.0-windows-x64.zip`;
  const bytes = await fakeWindowsZip(zip);
  if (o.tamper) Deno.writeFileSync(zip, enc("tampered"));
  const sep = WINDOWS ? "\\" : "/";
  return {
    dir,
    app,
    started: [],
    args: {
      installer: zip,
      sha256: await sha(bytes),
      pid: 77,
      exe: `${app}${sep}AIB.exe`.replaceAll("/", sep),
      log: `${dir}/install.log`,
      version: "0.2.0",
      kind: "windows-zip",
      target: app.replaceAll("/", sep),
    },
  };
}

function deps(c: Case, results: (StartResult | Error)[] = [{ code: null }], o: { aliveFor?: number; realTar?: boolean } = {}) {
  let left = o.aliveFor ?? 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      alive: () => --left >= 0,
      sleep: (s: number) => void sleeps.push(s),
      stamp: STAMP,
      ...(o.realTar ? {} : { unpack: (archive: string, dest: string) => jsUnpack(archive, dest) }),
      start: (command: string[]) => {
        c.started.push(command);
        const r = results.shift() ?? { code: null };
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    },
  };
}

Deno.test("helper: the new app starts with the old app's arguments (serve --port, --state-dir)", async () => {
  const c = await windowsCase();
  try {
    const { deps: d } = deps(c);
    assertEquals(await runHelper({ ...c.args, args: ["serve", "--port", "8901", 7 as unknown as string] }, d), 0); // port-guard: not bound (the helper runs a fake exe)
    assertEquals(c.started, [[c.args.exe, "serve", "--port", "8901"]], "only string arguments are passed on"); // port-guard: not bound (the helper runs a fake exe)
  } finally {
    Deno.removeSync(c.dir, { recursive: true });
  }
});

function assertOldInstall(app: string) {
  assertEquals(names(app), [".deno-desktop-app", "AIB.dll", "AIB.exe", "AIB.exe.WebView2", "old-only.txt", "sub"]);
  assertEquals([read(`${app}/AIB.exe`), read(`${app}/AIB.dll`), read(`${app}/sub/a.txt`)], ["old exe", "old dll", "old a"]);
  assertEquals(read(`${app}/AIB.exe.WebView2/EBWebView/Default/Local Storage/leveldb.log`), "the page's localStorage");
}

for (const realTar of WINDOWS ? [true, false] : [false]) {
  Deno.test(`helper: waits for the app, verifies, unpacks (${realTar ? "tar.exe" : "js"}), swaps in place, starts the new app`, async () => {
    const c = await windowsCase();
    Deno.env.set("AIB_SHOULD_NOT_LEAK", "1");
    try {
      const { deps: d, sleeps } = deps(c, [{ code: null }], { aliveFor: 3, realTar });
      assertEquals(await runHelper(c.args, d), 0);
      assertEquals(sleeps.length, 3);
      const app = c.app;
      assertEquals(read(`${app}/AIB.exe`), "new exe");
      assertEquals(read(`${app}/AIB.dll`), "new dll ".repeat(100));
      assertEquals(read(`${app}/sub/a.txt`), "new a");
      assertEquals(read(`${app}/AIB.exe.old-${STAMP}`), "old exe");
      assertEquals(read(`${app}/AIB.dll.old-${STAMP}`), "old dll");
      assertEquals(read(`${app}/sub.old-${STAMP}/a.txt`), "old a");
      assertEquals(read(`${app}/old-only.txt`), "gone in the new version", "names the new version lacks are left alone");
      // The WebView2 profile is untouched: same file, no .old copy.
      assertEquals(read(`${app}/AIB.exe.WebView2/EBWebView/Default/Local Storage/leveldb.log`), "the page's localStorage");
      assert(!names(app).some((n) => n.startsWith("AIB.exe.WebView2.")));
      assert(!names(app).some((n) => n.startsWith(".aib-update-")), "the unpack folder is removed");
      assertEquals(c.started, [[c.args.exe]]);
      const logText = read(c.args.log);
      assert(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d update to 0\.2\.0: waiting for the app \(pid 77\) to quit$/m.test(logText), logText);
      assert(logText.includes("the new version is running"), logText);
    } finally {
      Deno.env.delete("AIB_SHOULD_NOT_LEAK");
      Deno.removeSync(c.dir, { recursive: true });
    }
  });
}

Deno.test("helper: the old app holds the data folder lock until it exits; the new app then takes it (one AIB per folder)", async () => {
  const c = await windowsCase();
  const data = Deno.makeTempDirSync({ prefix: "aib-helper-data-" });
  // The old app: a real process holding <data>/desktop.lock that quits 1.5 s after it took it.
  const module = new URL("../../outputs/agent-studio/server/desktop/single_instance.ts", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(module)});
    const h = await m.claimFolder(${JSON.stringify(data)}, { mode: "desktop" });
    console.log(h.primary ? "locked" : "refused");
    setTimeout(() => Deno.exit(0), 1500);`;
  const old = new Deno.Command(Deno.execPath(), { args: ["eval", script], stdout: "piped", stderr: "null", stdin: "null" }).spawn();
  try {
    const reader = old.stdout.getReader();
    assertEquals(new TextDecoder().decode((await reader.read()).value!).trim(), "locked");
    reader.releaseLock();
    old.stdout.cancel().catch(() => {});
    assertEquals((await claimFolder(data, { exitWaitMs: 0 })).primary, false, "while the old app runs the folder is taken");
    const claims: boolean[] = [];
    const code = await runHelper({ ...c.args, pid: old.pid }, {
      stamp: STAMP,
      unpack: (archive: string, dest: string) => jsUnpack(archive, dest),
      start: async (command: string[]) => { // the new app's first step: the data folder lock
        c.started.push(command);
        const held = await claimFolder(data, { mode: "desktop", exitWaitMs: 0 });
        claims.push(held.primary);
        if (held.primary) held.release();
        return { code: held.primary ? null : 2 };
      },
    });
    assertEquals(code, 0);
    assertEquals(claims, [true], "the helper waited for the old app; its lock was gone");
    assertEquals((await old.status).code, 0);
  } finally {
    try {
      old.kill("SIGKILL");
    } catch { /* exited */ }
    Deno.removeSync(c.dir, { recursive: true });
    Deno.removeSync(data, { recursive: true });
  }
});

Deno.test("helper: the new app exits with an error or cannot start: every rename is undone and the old app starts again", async () => {
  for (const failure of [{ code: 1 } as StartResult, new Error("cannot start")]) {
    const c = await windowsCase();
    try {
      const { deps: d } = deps(c, [failure, { code: null }]);
      assertEquals(await runHelper(c.args, d), 7);
      assertOldInstall(c.app);
      assertEquals(c.started, [[c.args.exe], [c.args.exe]], "new, then the old one again");
      assert(read(c.args.log).includes("the old version was put back"));
    } finally {
      Deno.removeSync(c.dir, { recursive: true });
    }
  }
  // A quick clean exit (0) counts as started.
  const c = await windowsCase();
  try {
    assertEquals(await runHelper(c.args, deps(c, [{ code: 0 }]).deps), 0);
  } finally {
    Deno.removeSync(c.dir, { recursive: true });
  }
});

Deno.test("helper: with chats left in the keeper it stays connected to the keeper from before the old app quits until a version has started", async () => {
  for (const outcome of ["started", "rolled back"]) {
    const c = await windowsCase();
    try {
      const events: string[] = [];
      const { deps: d } = deps(c, outcome === "started" ? [{ code: null }] : [{ code: 1 }, { code: null }], { aliveFor: 2 });
      const code = await runHelper({ ...c.args, keeper: "C:/data" }, {
        ...d,
        alive: () => {
          events.push("alive?");
          return d.alive();
        },
        start: (command: string[]) => {
          events.push("start");
          return d.start(command);
        },
        keepKeeper: (dataDir: string) => {
          events.push(`connect ${dataDir}`);
          return Promise.resolve({ what: "keeper 1.0.0 (pid 9, 1 running agent(s))", release: () => void events.push("disconnect") });
        },
      });
      assertEquals(code, outcome === "started" ? 0 : 7);
      assertEquals(events[0], "connect C:/data", "connected before waiting for the old app to quit");
      assertEquals(events.at(-1), "disconnect", "disconnected only after the (new or old) app was started: " + events.join(", "));
      assertEquals(events.filter((e) => e === "start").length, outcome === "started" ? 1 : 2);
      const logText = read(c.args.log);
      assert(logText.includes("staying connected to the keeper 1.0.0 (pid 9, 1 running agent(s)) until AIB has started again"), logText);
      assert(logText.includes("disconnected from the keeper"), logText);
    } finally {
      Deno.removeSync(c.dir, { recursive: true });
    }
  }
  // No keeper argument: nothing is connected; a keeper that is not running is logged and the update goes on.
  let asked = 0;
  const keepKeeper = () => (asked++, Promise.resolve(null));
  for (const keeper of [undefined, "C:/data"]) {
    const c = await windowsCase();
    try {
      assertEquals(await runHelper({ ...c.args, ...(keeper ? { keeper } : {}) }, { ...deps(c).deps, keepKeeper }), 0);
      assertEquals(asked, keeper ? 1 : 0);
      if (keeper) assert(read(c.args.log).includes("no keeper runs; nothing to hold"));
    } finally {
      Deno.removeSync(c.dir, { recursive: true });
    }
  }
});

Deno.test("helper: the new app keeps the keeper switch (AIB_KEEPER) and nothing else of AIB_*", () => {
  assertEquals(cleanEnv({ AIB_KEEPER: "1", AIB_KEEPER_BIN: "x", AIB_UPDATE_API_BASE: "y", AIB_TEST_TRAY_STATE: "z", PATH: "p" }), {
    AIB_KEEPER: "1",
    AIB_TEST_TRAY_STATE: "z",
    PATH: "p",
  });
});

Deno.test("helper: a rename that fails half-way rolls back what was already swapped", async () => {
  const c = await windowsCase();
  try {
    // 'sub' is swapped last (names are sorted); its aside name is taken by a non-empty folder, so that rename fails.
    Deno.mkdirSync(`${c.app}/sub.old-${STAMP}`);
    Deno.writeTextFileSync(`${c.app}/sub.old-${STAMP}/blocker`, "x");
    assertEquals(await runHelper(c.args, deps(c).deps), 6);
    Deno.removeSync(`${c.app}/sub.old-${STAMP}`, { recursive: true });
    assertOldInstall(c.app);
    assertEquals(c.started, [], "nothing was started");
  } finally {
    Deno.removeSync(c.dir, { recursive: true });
  }
});

Deno.test("helper: a changed package, an app that will not quit, a package with no app, bad arguments", async () => {
  {
    const c = await windowsCase({ tamper: true });
    let unpacked = false;
    const d = { ...deps(c).deps, unpack: () => (unpacked = true, Promise.resolve()) };
    assertEquals(await runHelper(c.args, d), 4);
    assertEquals([unpacked, c.started], [false, []]);
    assertOldInstall(c.app);
    Deno.removeSync(c.dir, { recursive: true });
  }
  {
    const c = await windowsCase();
    const { deps: d, sleeps } = deps(c, [], { aliveFor: 10 ** 6 });
    assertEquals(await runHelper(c.args, d), 2);
    assertEquals([sleeps.length, c.started], [180, []]);
    assertOldInstall(c.app);
    Deno.removeSync(c.dir, { recursive: true });
  }
  {
    const c = await windowsCase();
    const d = { ...deps(c).deps, unpack: (_a: string, dest: string) => Promise.resolve(Deno.mkdirSync(`${dest}/AIB`)) };
    assertEquals(await runHelper(c.args, d), 5, "no AIB.exe in the package");
    assertOldInstall(c.app);
    Deno.removeSync(c.dir, { recursive: true });
  }
  assertEquals(await runHelper({ installer: "x", sha256: "x", pid: 0 }, { alive: () => false }), 1);
  assertEquals(await runHelper({ installer: "/nope", sha256: "x", pid: 0, kind: "windows-zip", target: "/t", exe: "/t/AIB.exe" }), 3);
});

Deno.test("helper: macOS swaps the whole AIB.app bundle (on real folders; ditto itself only runs on a Mac)", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-helper-mac-" });
  try {
    const bundle = `${dir}/Applications/AIB.app`;
    Deno.mkdirSync(`${bundle}/Contents/MacOS`, { recursive: true });
    Deno.writeTextFileSync(`${bundle}/Contents/MacOS/laufey_webview`, "old");
    const zip = `${dir}/AIB-0.2.0-macos-arm64.zip`;
    Deno.writeTextFileSync(zip, "stands in for the zip");
    const args: HelperArgs = {
      installer: zip,
      sha256: await sha(enc("stands in for the zip")),
      pid: 0,
      exe: `${bundle}/Contents/MacOS/laufey_webview`,
      log: `${dir}/install.log`,
      version: "0.2.0",
      kind: "macos-zip",
      target: bundle,
    };
    const started: string[][] = [];
    const unpack = (_archive: string, dest: string) => {
      Deno.mkdirSync(`${dest}/AIB.app/Contents/MacOS`, { recursive: true });
      Deno.writeTextFileSync(`${dest}/AIB.app/Contents/MacOS/laufey_webview`, "new");
      return Promise.resolve();
    };
    const start = (cmd: string[]) => (started.push(cmd), Promise.resolve({ code: null }));
    assertEquals(await runHelper(args, { unpack, start, stamp: STAMP }), 0);
    assertEquals(read(`${bundle}/Contents/MacOS/laufey_webview`), "new");
    assertEquals(read(`${bundle}.old-${STAMP}/Contents/MacOS/laufey_webview`), "old");
    assertEquals(names(`${dir}/Applications`), ["AIB.app", `AIB.app.old-${STAMP}`]);
    assertEquals(started, [[args.exe]]);
    // And back when the new one fails.
    Deno.removeSync(bundle, { recursive: true });
    Deno.renameSync(`${bundle}.old-${STAMP}`, bundle);
    assertEquals(await runHelper(args, { unpack, start: () => Promise.resolve({ code: 9 }), stamp: STAMP }), 7);
    assertEquals(read(`${bundle}/Contents/MacOS/laufey_webview`), "old");
    assertEquals(names(`${dir}/Applications`), ["AIB.app"]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("helper: Linux replaces the AppImage file", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-helper-linux-" });
  try {
    const target = `${dir}/Apps/AIB.AppImage`;
    Deno.mkdirSync(`${dir}/Apps`);
    Deno.writeTextFileSync(target, "old appimage");
    const installer = `${dir}/AIB-0.2.0-linux-x64.AppImage`;
    Deno.writeTextFileSync(installer, "new appimage");
    const started: string[][] = [];
    const args: HelperArgs = {
      installer,
      sha256: await sha(enc("new appimage")),
      pid: 0,
      exe: "/tmp/.mount_AIB/usr/bin/aib",
      log: "",
      version: "0.2.0",
      kind: "appimage",
      target,
    };
    assertEquals(await runHelper(args, { start: (cmd) => (started.push(cmd), Promise.resolve({ code: null })), stamp: STAMP }), 0);
    assertEquals([read(target), read(`${target}.old-${STAMP}`)], ["new appimage", "old appimage"]);
    if (!WINDOWS) assertEquals(Deno.statSync(target).mode! & 0o777, 0o755);
    assertEquals(started, [[target]], "the AppImage file is started, not the old mount's binary");
    assertEquals(names(`${dir}/Apps`), ["AIB.AppImage", `AIB.AppImage.old-${STAMP}`]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("rollback undoes a swap journal newest first", () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-rollback-" });
  try {
    Deno.mkdirSync(`${dir}/app`);
    Deno.mkdirSync(`${dir}/new`);
    for (const n of ["a", "b"]) {
      Deno.writeTextFileSync(`${dir}/app/${n}`, "old " + n);
      Deno.writeTextFileSync(`${dir}/new/${n}`, "new " + n);
    }
    Deno.writeTextFileSync(`${dir}/new/c`, "new c");
    const journal = swapFolder(`${dir}/app`, `${dir}/new`, STAMP);
    assertEquals(journal.map((s) => [s.aside !== null, s.placed]), [[true, true], [true, true], [false, true]]);
    assertEquals(rollback(journal, STAMP), []);
    assertEquals(names(`${dir}/app`), ["a", "b"]);
    assertEquals(names(`${dir}/new`), ["a", "b", "c"]);
    assertEquals(read(`${dir}/app/a`), "old a");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("installTarget: the folder of AIB.exe, the .app bundle, $APPIMAGE", () => {
  assertEquals(installTarget("windows", "C:\\Users\\u\\AIB\\AIB.exe", {}), { kind: "windows-zip", target: "C:\\Users\\u\\AIB" });
  assertEquals(installTarget("darwin", "/Applications/AIB.app/Contents/MacOS/laufey_webview", {}), {
    kind: "macos-zip",
    target: "/Applications/AIB.app",
  });
  assertEquals(installTarget("darwin", "/usr/local/bin/deno", {}), null);
  assertEquals(installTarget("linux", "/tmp/.mount_x/aib", { APPIMAGE: "/home/u/AIB.AppImage" }), {
    kind: "appimage",
    target: "/home/u/AIB.AppImage",
  });
  assertEquals(installTarget("linux", "/usr/bin/aib", {}), null, "a .deb install updates by hand");
  assertEquals(installTarget("freebsd", "/x", {}), null);
});

Deno.test("removeUpdateLeftovers: old files and unpack folders go, the app and its WebView2 profile stay", () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-leftovers-" });
  try {
    const app = fakeWindowsInstall(dir);
    for (const n of ["AIB.exe", "AIB.dll", ".deno-desktop-app"]) Deno.writeTextFileSync(`${app}/${n}.old-${STAMP}`, "old");
    Deno.mkdirSync(`${app}/sub.old-${STAMP}`);
    Deno.mkdirSync(`${app}/.aib-update-${STAMP}/AIB`, { recursive: true });
    Deno.writeTextFileSync(`${app}/notes.old-text`, "not ours (no stamp)");
    const removed = removeUpdateLeftovers({ target: { kind: "windows-zip", target: app } });
    assertEquals(removed.length, 5);
    assertEquals(names(app), [".deno-desktop-app", "AIB.dll", "AIB.exe", "AIB.exe.WebView2", "notes.old-text", "old-only.txt", "sub"]);
    assertEquals(removeUpdateLeftovers({ desktop: false }), [], "outside the desktop app: nothing");

    // macOS / Linux: siblings of the bundle or AppImage.
    Deno.mkdirSync(`${dir}/Apps/AIB.app.old-${STAMP}/Contents`, { recursive: true });
    Deno.mkdirSync(`${dir}/Apps/AIB.app/Contents`, { recursive: true });
    Deno.mkdirSync(`${dir}/Apps/Other.app.old-${STAMP}`);
    assertEquals(removeUpdateLeftovers({ target: { kind: "macos-zip", target: `${dir}/Apps/AIB.app` } }).length, 1);
    assertEquals(names(`${dir}/Apps`), ["AIB.app", `Other.app.old-${STAMP}`]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("removeUpdateLeftoversSoon: tries again while leftovers stay (the helper runs from the old exe until the new app confirmed)", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-leftovers-soon-" });
  try {
    const app = fakeWindowsInstall(dir);
    const target = { kind: "windows-zip" as const, target: app };
    Deno.writeTextFileSync(`${app}/AIB.exe.old-${STAMP}`, "old");
    let held = true; // the first passes cannot delete it: something still runs from it
    let passes = 0;
    const stop = removeUpdateLeftoversSoon({
      target,
      everyMs: 20,
      tries: 50,
      left: () => {
        passes++;
        if (held && passes >= 3) held = false;
        if (held) Deno.writeTextFileSync(`${app}/AIB.exe.old-${STAMP}`, "old"); // stands in for a file in use: back again
        return updateLeftoversLeft({ target });
      },
    });
    await new Promise((r) => setTimeout(r, 400));
    stop();
    assertEquals(updateLeftoversLeft({ target }), false, "gone once nothing holds it");
    assert(passes >= 3 && passes < 10, `stopped trying once nothing was left (${passes} passes)`);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("removeUpdateLeftovers (macOS): an old bundle a process still runs from (the old agent host) is kept; unknown keeps all", () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-leftovers-mac-" });
  try {
    const old = `${dir}/AIB.app.old-${STAMP}`;
    Deno.mkdirSync(`${old}/Contents/MacOS`, { recursive: true });
    Deno.mkdirSync(`${dir}/AIB.app/Contents`, { recursive: true });
    const target = { kind: "macos-zip" as const, target: `${dir}/AIB.app` };
    const running = [`${old}/Contents/MacOS/AIB`, "/usr/bin/zsh"];
    assertEquals(removeUpdateLeftovers({ target, os: "darwin", processes: () => running }), [], "the old host runs from it");
    assertEquals(removeUpdateLeftovers({ target, os: "darwin", processes: () => null }), [], "process list unknown: keep");
    assertEquals(removeUpdateLeftovers({ target, os: "darwin", processes: () => ["/usr/bin/zsh"] }).length, 1, "nothing runs from it");
    assertEquals(names(dir), ["AIB.app"], "deleted");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: "removeUpdateLeftovers (Windows): a version whose old exe cannot be deleted (still running) is kept whole",
  ignore: !WINDOWS,
  fn: () => {
    const dir = Deno.makeTempDirSync({ prefix: "aib-leftovers-locked-" });
    try {
      const old = `${dir}\\AIB.exe.old-${STAMP}`;
      Deno.writeTextFileSync(old, "old");
      Deno.writeTextFileSync(`${dir}\\AIB.dll.old-${STAMP}`, "old");
      // Opened with no sharing stands in for "running": Windows refuses to delete it.
      const GENERIC_READ = 0x80000000, OPEN_EXISTING = 3;
      const handle = kernel32().CreateFileW(wide(old), GENERIC_READ, 0, null, OPEN_EXISTING, 0, null);
      assert(handle !== null && Deno.UnsafePointer.value(handle) !== -1n && Deno.UnsafePointer.value(handle) !== 0n);
      try {
        assertEquals(removeUpdateLeftovers({ target: { kind: "windows-zip", target: dir } }), []);
        assertEquals(names(dir), [`AIB.dll.old-${STAMP}`, `AIB.exe.old-${STAMP}`], "the dll stays with its exe");
      } finally {
        kernel32().CloseHandle(handle);
      }
      assertEquals(removeUpdateLeftovers({ target: { kind: "windows-zip", target: dir } }).length, 2);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test("defaultStart: a fake app that fails at once reports its code; one that keeps running counts as started", async () => {
  const deno = Deno.execPath();
  const env = cleanEnv();
  const failed = await defaultStart([deno, "eval", "Deno.exit(3)"], env);
  assertEquals(failed.code, 3);
  const running = await defaultStart([deno, "eval", "await new Promise((r) => setTimeout(r, 4000))"], env, () =>
    new Promise((r) => setTimeout(r, 25)));
  assertEquals(running.code, null);
  await new Promise((r) => setTimeout(r, 4500)); // the fake app ends by itself; nothing is left running
});

Deno.test("helper main: bad JSON and missing fields are refused (exit 1)", async () => {
  assertEquals(await helperMain(["not json"]), 1);
  assertEquals(await helperMain(["[]"]), 1);
  assertEquals(await helperMain(['{"installer": "x"}']), 1);
});

Deno.test("cleanEnv drops the old app's launch variables", () => {
  assertEquals(
    cleanEnv({ PATH: "p", AIB_X: "1", APPIMAGE: "/a", APPDIR: "/d", DENO_SERVE_ADDRESS: "x", PYTHONHOME: "h", HOME: "~" }),
    { PATH: "p", HOME: "~" },
  );
});

Deno.test("the repository: sirkuttin/AIB for the desktop app, none for deno run, AIB_UPDATE_REPO overrides", () => {
  const saved = Deno.env.get(REPO_ENV);
  try {
    Deno.env.delete(REPO_ENV);
    assertEquals(UPDATE_REPO, "sirkuttin/AIB");
    assertEquals(defaultRepo(true), "sirkuttin/AIB");
    assertEquals(defaultRepo(false), PLACEHOLDER_REPO);
    using env = new Env();
    env.base("");
    const dev = new UpdateService(env.dir, { key: ["windows", "x64"], env: {}, now: env.clock.now });
    assertEquals([dev.repo, dev.configured(), dev.status().state], [PLACEHOLDER_REPO, false, "unconfigured"]);
    const app = new UpdateService(env.dir, { key: ["windows", "x64"], env: {}, now: env.clock.now, app: { ...APP } });
    assertEquals([app.repo, app.configured()], ["sirkuttin/AIB", true]);
    Deno.env.set(REPO_ENV, "acme/other");
    assertEquals(defaultRepo(true), "acme/other");
  } finally {
    if (saved === undefined) Deno.env.delete(REPO_ENV);
    else Deno.env.set(REPO_ENV, saved);
  }
});

// ---- beta.2 helper rules: start confirmation, crash-safe journal, a tray presence ----------------------------------------

Deno.test("helper: success needs the new app's start confirmation (marker); none in time puts the old version back", async () => {
  for (const confirmed of [true, false]) {
    const c = await windowsCase();
    try {
      const marker = `${c.dir}/started-0.2.0.ok`;
      Deno.writeTextFileSync(marker, "stale from an earlier try");
      const seen: (string | undefined)[] = [];
      const trays: string[] = [];
      const code = await runHelper({ ...c.args, marker }, {
        alive: () => false,
        sleep: () => {},
        stamp: STAMP,
        unpack: (archive: string, dest: string) => jsUnpack(archive, dest),
        tray: (tip) => (trays.push(`show ${tip}`), () => void trays.push("hide")),
        start: (command: string[], _env: Record<string, string>, m?: string) => {
          c.started.push(command);
          seen.push(m);
          assert(!exists(m!), "a stale marker never counts");
          return Promise.resolve(confirmed ? { code: null, confirmed: true } : { code: null, confirmed: false });
        },
      });
      assertEquals(seen[0], marker);
      assertEquals(trays, ["show Updating AIB to 0.2.0...", "hide"], "a tray icon for the helper's whole life");
      if (confirmed) {
        assertEquals(code, 0);
        assertEquals(read(`${c.app}/AIB.exe`), "new exe");
        assert(read(`${c.dir}/install.log`).includes("the new version is running (it confirmed its start)"));
      } else {
        assertEquals(code, 7);
        assertOldInstall(c.app);
        assert(read(`${c.dir}/install.log`).includes("no start confirmation within 60 s"), read(`${c.dir}/install.log`));
      }
      assert(!exists(`${c.dir}/${JOURNAL_NAME}`), "the journal is gone once the outcome is settled");
    } finally {
      Deno.removeSync(c.dir, { recursive: true });
    }
  }
});

Deno.test("helper: the swap journal is on disk before each rename; a cut-off update is undone at the next start", async () => {
  const c = await windowsCase();
  try {
    let snapshots = 0;
    // Crash the helper (an exception out of start stands in for "killed") right after the swap: the journal must hold every step.
    const crash = new Error("helper killed");
    const code = await runHelper(c.args, {
      alive: () => false,
      sleep: () => {},
      stamp: STAMP,
      unpack: (archive: string, dest: string) => jsUnpack(archive, dest),
      tray: () => () => {},
      start: () => {
        const j = JSON.parse(read(`${c.dir}/${JOURNAL_NAME}`));
        snapshots = j.steps.length;
        assertEquals(j.helperPid, Deno.pid);
        // Simulate the crash: copy the journal aside, it is what a killed helper leaves behind.
        Deno.copyFileSync(`${c.dir}/${JOURNAL_NAME}`, `${c.dir}/journal.crash`);
        return Promise.reject(crash);
      },
    });
    assertEquals(code, 7, "(this run rolled back by itself)");
    assert(snapshots >= 4, `every top-level entry was journaled (${snapshots})`);
    // Now replay what a crash would have left: redo the swap from the copy, put the journal back, and recover as AIB's start does.
    const j = JSON.parse(read(`${c.dir}/journal.crash`));
    const steps = j.steps as { path: string; aside: string | null; from: string }[];
    const stage = `${c.app}/.aib-update-${STAMP}/AIB`;
    Deno.mkdirSync(stage, { recursive: true });
    for (const s of steps) Deno.writeTextFileSync(s.from, `new ${s.path.split(/[\/]/).pop()}`);
    for (const s of steps.slice(0, 2)) { // the helper finished two steps ...
      if (s.aside && exists(s.path)) Deno.renameSync(s.path, s.aside);
      Deno.renameSync(s.from, s.path);
    }
    // ... and died right after journaling the third (both of its renames recorded, neither done).
    Deno.writeTextFileSync(`${c.dir}/${JOURNAL_NAME}`, JSON.stringify({ ...j, steps: steps.slice(0, 3), helperPid: 999999 }));
    assertEquals(recoverInterruptedUpdate(c.dir, () => false), true);
    assertOldInstall(c.app);
    assert(!exists(`${c.dir}/${JOURNAL_NAME}`));
    assert(read(`${c.dir}/install.log`).includes("an interrupted update to 0.2.0 was found at start; the previous version was put back"));
    assertEquals(recoverInterruptedUpdate(c.dir), false, "nothing to undo now");
    Deno.writeTextFileSync(`${c.dir}/${JOURNAL_NAME}`, JSON.stringify({ ...j, helperPid: 1 }));
    assertEquals(recoverInterruptedUpdate(c.dir, () => true), false, "a helper still at work is left alone");
  } finally {
    Deno.removeSync(c.dir, { recursive: true });
  }
});

function exists(p: string): boolean {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---- QA 4: retry sooner, clean up after an install, say when it failed ----------------------------------------------------
Deno.test("a failed automatic check for a passing reason (offline) is tried again after an hour, not a day", async () => {
  using env = new Env();
  env.base(DEAD);
  const svc = env.service();
  const st = await svc.check();
  assertEquals([st.state, st.errorCode], ["error", "offline"]);
  assertEquals(st.lastCheck, env.clock.now(), "when it failed, for the card");
  assertEquals(st.retryAt, env.clock.now() + RETRY_INTERVAL);
  assertEquals(svc.due(), false);
  env.clock.t += RETRY_INTERVAL - 1;
  assertEquals(svc.due(), false);
  env.clock.t += 1;
  assertEquals(svc.due(), true, "an hour later it is due again");
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const ok = await svc.check();
  assertEquals([ok.state, ok.retryAt], ["ready", null]);
  assertEquals(svc.due(), false, "after a good check: a day again");
  env.clock.t += RETRY_INTERVAL;
  assertEquals(svc.due(), false);
});

Deno.test("a checksum refusal still waits a day, and leaves no empty version folder", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start({ sumsHash: "f".repeat(64) });
  env.base(fake.base);
  const svc = env.service();
  const st = await svc.check();
  assertEquals([st.state, st.retryAt], ["refused", null]);
  env.clock.t += RETRY_INTERVAL;
  assertEquals(svc.due(), false);
  assertEquals(
    [...Deno.readDirSync(env.dir + "/updates")].filter((e) => e.isDirectory).map((e) => e.name),
    [],
    "the refused download's folder is gone",
  );
});

Deno.test("after the update is installed, the next start deletes the downloaded file and forgets it", async () => {
  using env = new Env();
  await using fake = await FakeGitHub.start();
  env.base(fake.base);
  const before = env.service();
  const st = await before.check();
  assertEquals(st.state, "ready");
  const path = String(st.available!.path);
  assert(isFileSync(path));
  Deno.mkdirSync(env.dir + "/updates/0.0.9"); // an older leftover
  Deno.writeTextFileSync(env.dir + "/updates/0.0.9/old.zip", "x");
  Deno.mkdirSync(env.dir + "/updates/9.9.9"); // a newer one (not this version): kept
  Deno.writeTextFileSync(env.dir + "/updates/9.9.9/keep.zip", "x");
  // Same version, not yet installed: nothing is removed.
  assertEquals(before.cleanup().sort(), ["0.0.9"]);
  assert(isFileSync(path), "the ready download stays until it is installed");
  // The new version runs now (current = the downloaded one).
  const after = env.service({ current: "0.1.0-beta.2" });
  assertEquals(after.cleanup(), ["0.1.0-beta.2"]);
  assert(!isFileSync(path), "the installed zip is deleted");
  assertEquals(after.state.downloaded, null);
  assertEquals(after.state.found, null);
  const saved = JSON.parse(Deno.readTextFileSync(env.dir + "/updates/state.json"));
  assertEquals([saved.downloaded, saved.found], [null, null], "state.json forgets it too");
  assert(isFileSync(env.dir + "/updates/9.9.9/keep.zip"));
  assert(isFileSync(env.dir + "/updates/state.json"));
  assertEquals(after.status().state, "none");
});

Deno.test("status says whether this is the desktop app (a source run never updates itself)", () => {
  using env = new Env();
  assertEquals(env.service({ app: { desktop: false, pid: 1, exe: "deno" } }).status().desktop, false);
  assertEquals(env.service({ app: APP }).status().desktop, true);
});

function isFileSync(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}
