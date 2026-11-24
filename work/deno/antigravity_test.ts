/**
 * Antigravity CLI (beta_catalog.ts `antigravity`): its catalog entry, AIB's own install from Google's download (pinned SHA-512, only
 * storage.googleapis.com/antigravity-public/), how AIB finds `agy` (Windows and in a WSL distro), the sign-in mapping (terminal
 * sign-in `agy acp --login`, -32000 = Needs sign-in) and the API key's own settings folder (--gemini-dir). Nothing here downloads:
 * a fake fetch serves the bytes, every folder is a temp folder. The real binary is driven by antigravity_e2e_test.ts.
 */
import { assert, assertEquals, assertRejects } from "./_assert.ts";
import { join, NODE, tempDir, touch } from "./_agents.ts";
import {
  BETA_AGENTS,
  type BetaAgent,
  betaAgent,
} from "../../app/server/agents/beta_catalog.ts";
import {
  keyHomeDir,
  prepareKeyHome,
  resolveBeta,
  signinArgv,
  withKeyHome,
} from "../../app/server/agents/beta_agents.ts";
import {
  allowedDownload,
  checksumMatches,
  downloadAsset,
  extractProgram,
  innerFile,
  programFile,
  releaseAsset,
  ReleaseError,
  releaseUrl,
  sha512Hex,
} from "../../app/server/agents/release_install.ts";
import { Installer } from "../../app/server/agents/installer.ts";
import { installPlan } from "../../app/server/agents/beta_setup.ts";
import { BetaSigner } from "../../app/server/agents/beta_signin.ts";
import { BETA_IDS as ELIGIBLE_BETA } from "../../app/server/agents/eligibility.ts";
import { resolveAntigravity } from "../../app/server/wsl/helper/methods.ts";

const WIN = Deno.build.os === "windows";
const sanitize = { sanitizeOps: false, sanitizeResources: false };
const agy = betaAgent("antigravity")!;
const BASE =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/";
const envWith = (...dirs: string[]) => ({
  PATH: dirs.join(WIN ? ";" : ":"),
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
});

// ---- the catalog entry ----------------------------------------------------------------------------------------------------

Deno.test("Antigravity: `agy acp --disable-telemetry`, last in the Beta list (PC and phone), Google sign-in or a Gemini key", () => {
  assertEquals(BETA_AGENTS[BETA_AGENTS.length - 1].id, "antigravity");
  assert(ELIGIBLE_BETA.includes("antigravity"), "the phone list knows it");
  assertEquals([agy.name, agy.letter, agy.license, agy.commands, agy.args], [
    "Antigravity CLI",
    "A",
    "Proprietary",
    ["agy"],
    ["acp", "--disable-telemetry"],
  ]);
  assertEquals(agy.signin, {
    kind: "terminal",
    terminalArgs: ["acp", "--login"],
    keyEnv: "GEMINI_API_KEY",
    keyMethod: "gemini-api-key",
    keyUrl: "https://aistudio.google.com/apikey",
  });
  assertEquals(agy.keyHome, {
    flag: "--gemini-dir",
    folder: "gemini-home",
    files: { "antigravity-cli/settings.json": { modelProvider: "gemini" } },
  });
  assertEquals(
    agy.signinDirs,
    [".gemini"],
    "a paired computer never reaches its sign-in folder",
  );
  assertEquals(agy.known, [{
    base: "LOCALAPPDATA",
    parts: ["agy", "bin", "agy.exe"],
  }], "install.ps1's folder");
  assert(agy.docs.startsWith("https://antigravity.google/"));
  assert(
    /antigravity\.google\/cli\/install\.(ps1|sh)/.test(agy.install),
    "the hand-run command is Google's own",
  );
  assert(!agy.vendorInstall, "AIB never runs the install script itself");
});

Deno.test("the Gemini card sends personal Google accounts to Antigravity CLI", () => {
  const note = betaAgent("gemini")!.note ?? "";
  assert(note.includes("Antigravity CLI"), note);
  assert(
    note.includes(
      "Google moved personal accounts to Antigravity CLI on 18 June 2026",
    ),
    note,
  );
});

Deno.test("every Antigravity build: Google's bucket only, a pinned SHA-512, its exact size; Windows is the program itself", () => {
  const rel = agy.release!;
  assertEquals([rel.version, rel.program, rel.inner, rel.host], [
    "1.5.11",
    "agy",
    "antigravity",
    "Google",
  ]);
  assertEquals(Object.keys(rel.assets).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
  ]);
  for (const [platform, asset] of Object.entries(rel.assets)) {
    assert(
      asset.url?.startsWith(BASE) && asset.url.endsWith("/" + asset.file),
      platform,
    );
    assert(allowedDownload(asset.url!), platform);
    assertEquals(releaseUrl(rel, asset), asset.url, platform);
    assert(
      /^[0-9a-f]{128}$/.test(asset.sha512 ?? ""),
      `${platform}: a SHA-512`,
    );
    assert(asset.bytes > 50_000_000 && asset.bytes < 300_000_000, platform);
    assertEquals(
      /\.exe$/.test(asset.file),
      platform.startsWith("windows"),
      platform,
    );
  }
  assertEquals(
    releaseAsset(agy, "windows-x86_64")!.sha512!.slice(0, 16),
    "7de2a90b3a351c5c",
    "the 1.5.11 manifest value",
  );
  assertEquals(releaseAsset(agy, "freebsd-x86_64"), null);
  assertEquals([programFile(rel, "windows"), programFile(rel, "linux")], [
    "agy.exe",
    "agy",
  ]);
  assertEquals([innerFile(rel, "windows"), innerFile(rel, "linux")], [
    "antigravity.exe",
    "antigravity",
  ]);
  for (const os of ["windows", "darwin", "linux"] as const) {
    assertEquals([installPlan(agy, os).kind, installPlan(agy, os).needs], [
      "download",
      [],
    ], os);
  }
});

// ---- download rules -----------------------------------------------------------------------------------------------------------

Deno.test("downloads: only https on storage.googleapis.com under /antigravity-public/ (besides GitHub releases)", () => {
  assert(allowedDownload(BASE + "windows-x64/cli_windows_x64.exe"));
  for (
    const bad of [
      "http://storage.googleapis.com/antigravity-public/x.exe",
      "https://storage.googleapis.com/some-other-bucket/agy.exe",
      "https://storage.googleapis.com/antigravity-publicity/agy.exe",
      "https://storage.googleapis.com:8443/antigravity-public/x.exe",
      "https://user@storage.googleapis.com/antigravity-public/x.exe",
      "https://storage.googleapis.com.evil.example/antigravity-public/x.exe",
      "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json",
      "https://antigravity.google/cli/install.ps1",
    ]
  ) assert(!allowedDownload(bad), bad);
  const rel = agy.release!;
  let threw = false;
  try {
    releaseUrl(rel, {
      file: "x.exe",
      url: "https://example.com/x.exe",
      sha512: "0".repeat(128),
      bytes: 1,
    });
  } catch {
    threw = true;
  }
  assert(threw, "a catalog address off the allowed hosts is never built");
});

Deno.test("SHA-512 check: the pinned value must match; a download with no pinned checksum never counts", async () => {
  const bytes = new TextEncoder().encode("fake agy");
  const sha512 = await sha512Hex(bytes);
  assertEquals(sha512.length, 128);
  assert(
    await checksumMatches(bytes, {
      file: "a.exe",
      sha512,
      bytes: bytes.length,
    }),
  );
  assert(
    await checksumMatches(bytes, {
      file: "a.exe",
      sha512: sha512.toUpperCase(),
      bytes: bytes.length,
    }),
  );
  assert(
    !await checksumMatches(bytes, {
      file: "a.exe",
      sha512: "0".repeat(128),
      bytes: bytes.length,
    }),
  );
  assert(!await checksumMatches(bytes, { file: "a.exe", bytes: bytes.length }));
  // both pinned: both must match
  assert(
    !await checksumMatches(bytes, {
      file: "a.exe",
      sha512,
      sha256: "0".repeat(64),
      bytes: bytes.length,
    }),
  );
});

Deno.test("a .exe download is the program itself; a .tar.gz gives up `antigravity` from its root", async () => {
  const program = new TextEncoder().encode("MZ fake");
  assertEquals(
    await extractProgram(program, "cli_windows_x64.exe", "antigravity.exe"),
    program,
  );
  const tgz = await makeTarGz([["antigravity", program]]);
  assertEquals(
    await extractProgram(tgz, "cli_linux_x64.tar.gz", "antigravity"),
    program,
  );
  await assertRejects(
    () => extractProgram(tgz, "cli_linux_x64.tar.gz", "agy"),
    ReleaseError,
  );
});

Deno.test(
  "download errors name Google, and a redirect off the bucket is stopped",
  sanitize,
  async () => {
    const asset = {
      file: "x.exe",
      url: BASE + "x.exe",
      sha512: "0".repeat(128),
      bytes: 3,
    };
    const moved = ((_: string) => {
      const res = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      Object.defineProperty(res, "url", { value: "https://example.com/x.exe" });
      return Promise.resolve(res);
    }) as unknown as typeof fetch;
    const gone = (() =>
      Promise.resolve(
        new Response("no", { status: 404 }),
      )) as unknown as typeof fetch;
    const offline =
      (() =>
        Promise.reject(new TypeError("offline"))) as unknown as typeof fetch;
    const cases: [typeof fetch, string][] = [
      [
        moved,
        "The download was sent somewhere other than Google, so AIB stopped it.",
      ],
      [gone, "Google answered 404 for the download. Try again later."],
      [
        offline,
        "Could not reach storage.googleapis.com. Check the internet connection and try again.",
      ],
    ];
    for (const [fetcher, line] of cases) {
      const error = await downloadAsset(asset.url, asset, { fetch: fetcher })
        .then(() => null, (e) => e);
      assert(error instanceof ReleaseError, line);
      assertEquals(error.message, line);
    }
  },
);

// ---- AIB's own install --------------------------------------------------------------------------------------------------------

const PLATFORM = WIN ? "windows-x86_64" : `${Deno.build.os}-x86_64`;
const FILE = WIN ? "cli_windows_x64.exe" : "cli_linux_x64.tar.gz";
const PROGRAM = new TextEncoder().encode(
  "#!/bin/sh\necho fake agy\n".repeat(40),
);
const downloadFor =
  () => (WIN
    ? Promise.resolve(PROGRAM)
    : makeTarGz([["antigravity", PROGRAM]]));

async function fakeAgy(body: Uint8Array, sha512?: string): Promise<BetaAgent> {
  const asset = {
    file: FILE,
    url: BASE + "test/" + FILE,
    sha512: sha512 ?? await sha512Hex(body),
    bytes: body.length,
  };
  return {
    ...agy,
    release: { ...agy.release!, assets: { [PLATFORM]: asset } },
  };
}

function withCatalog(agent: BetaAgent): { [Symbol.dispose](): void } {
  const list = BETA_AGENTS as BetaAgent[];
  const at = list.findIndex((a) => a.id === "antigravity");
  const real = list[at];
  list[at] = agent;
  return { [Symbol.dispose]: () => void (list[at] = real) };
}

function fakeFetch(body: Uint8Array, log: string[]): typeof fetch {
  return ((input: string | URL | Request) => {
    log.push(String(input));
    return Promise.resolve(
      new Response(body as Uint8Array<ArrayBuffer>, { status: 200 }),
    );
  }) as typeof fetch;
}

Deno.test(
  "Install: downloads Google's build, checks its SHA-512, writes agy; AIB then starts that copy first",
  sanitize,
  async () => {
    using dir = tempDir();
    const body = await downloadFor();
    using _ = withCatalog(await fakeAgy(body));
    const log: string[] = [];
    const installer = new Installer(dir.root, {
      fetch: fakeFetch(body, log),
      platform: PLATFORM,
      diskFree: () => 1e12,
    });
    assertEquals((await installer.start("antigravity")).state, "running");
    await installer.jobs.get("antigravity")?.done;
    const done = await installer.status("antigravity");
    assertEquals([done.state, done.message], ["done", ""]);
    assertEquals(
      log,
      [BASE + "test/" + FILE],
      "one download, from the pinned address; no manifest, no script",
    );
    const folder = join(dir.root, "agents", "antigravity", "1.5.11");
    const program = join(folder, WIN ? "agy.exe" : "agy");
    assertEquals(Deno.readFileSync(program), PROGRAM);
    const marker = JSON.parse(Deno.readTextFileSync(join(folder, ".complete")));
    assertEquals([marker.version, marker.file, marker.sha512, marker.package], [
      "1.5.11",
      FILE,
      await sha512Hex(body),
      BASE + "test/" + FILE,
    ]);
    const onPath = join(dir.root, "bin");
    touch(join(onPath, WIN ? "agy.exe" : "agy"), "");
    const row = await resolveBeta("antigravity", {
      stateDir: dir.root,
      env: envWith(onPath),
    });
    assertEquals([row.source, row.argv], ["studio", [
      program,
      "acp",
      "--disable-telemetry",
    ]]);
  },
);

Deno.test(
  "Install: a download that does not match the pinned SHA-512 is not used",
  sanitize,
  async () => {
    using dir = tempDir();
    const body = await downloadFor();
    using _ = withCatalog(await fakeAgy(body, "f".repeat(128)));
    const installer = new Installer(dir.root, {
      fetch: fakeFetch(body, []),
      platform: PLATFORM,
      diskFree: () => 1e12,
    });
    await installer.start("antigravity");
    await installer.jobs.get("antigravity")?.done;
    const view = await installer.status("antigravity");
    assertEquals(view.state, "failed");
    assert(/did not match the checksum/.test(view.message), view.message);
    assertEquals(
      (await resolveBeta("antigravity", { stateDir: dir.root, env: envWith() }))
        .found,
      false,
    );
  },
);

// ---- finding agy ------------------------------------------------------------------------------------------------------------

Deno.test("agy is found on PATH, else in install.ps1's folder (Windows); missing shows Google's install command", async () => {
  using dir = tempDir();
  const bin = join(dir.root, "bin");
  const program = touch(join(bin, WIN ? "agy.exe" : "agy"), "");
  let row = await resolveBeta("antigravity", {
    env: envWith(bin),
    windows: WIN,
  });
  assertEquals([row.found, row.source, row.argv], [true, "path", [
    program,
    "acp",
    "--disable-telemetry",
  ]]);
  if (WIN) {
    const local = join(dir.root, "local");
    const known = touch(join(local, "agy", "bin", "agy.exe"), "");
    row = await resolveBeta("antigravity", {
      env: { ...envWith(), LOCALAPPDATA: local },
      windows: true,
    });
    assertEquals([row.found, row.argv], [true, [
      known,
      "acp",
      "--disable-telemetry",
    ]]);
  }
  row = await resolveBeta("antigravity", {
    env: envWith(join(dir.root, "empty")),
    windows: WIN,
  });
  assertEquals([row.found, row.problem], [
    false,
    `Not installed. Install it with: ${agy.install}`,
  ]);
});

Deno.test("WSL: agy in the distro from the login PATH, else ~/.local/bin/agy (install.sh); not found otherwise", async () => {
  using dir = tempDir();
  const home = join(dir.root, "home");
  let row = await resolveAntigravity(null, {
    env: { PATH: join(dir.root, "none") },
    home,
  });
  assertEquals(row.found, false);
  const local = touch(join(home, ".local", "bin", "agy"), "");
  row = await resolveAntigravity(null, {
    env: { PATH: join(dir.root, "none") },
    home,
  });
  assertEquals([row.found, row.argv], [true, [
    local,
    "acp",
    "--disable-telemetry",
  ]]);
});

// ---- sign-in ----------------------------------------------------------------------------------------------------------------

Deno.test("Sign in: agy's advertised terminal-login runs `agy acp --disable-telemetry --login`; the fallback is `agy acp --login`", async () => {
  using dir = tempDir();
  const bin = join(dir.root, "bin");
  const program = touch(join(bin, WIN ? "agy.exe" : "agy"), "");
  const row = await resolveBeta("antigravity", {
    env: envWith(bin),
    windows: WIN,
  });
  // what agy 1.5.11 advertises to a client with auth.terminal (seen from the real binary)
  assertEquals(
    signinArgv(row, "antigravity", { args: ["--login"], advertised: true }),
    [
      program,
      "acp",
      "--disable-telemetry",
      "--login",
    ],
  );
  assertEquals(signinArgv(row, "antigravity"), [program, "acp", "--login"]);
});

/** A tiny ACP agent: answers initialize, then session/new with this error (or a session). */
function fakeAgent(error: { code: number; message: string } | null): string[] {
  const reply = error
    ? `{jsonrpc:"2.0",id:m.id,error:${JSON.stringify(error)}}`
    : `{jsonrpc:"2.0",id:m.id,result:{sessionId:"s1"}}`;
  const script = [
    'let buf = "";',
    'process.stdin.on("data", (d) => {',
    '  buf += d;',
    '  let i;',
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const m = JSON.parse(buf.slice(0, i));',
    '    buf = buf.slice(i + 1);',
    '    if (!("id" in m)) continue;',
    '    let out;',
    '    if (m.method === "initialize") out = {jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,authMethods:[]}};',
    `    else if (m.method === "session/new") out = ${reply};`,
    '    else out = {jsonrpc:"2.0",id:m.id,result:{}};',
    '    process.stdout.write(JSON.stringify(out) + "\\n");',
    '  }',
    '});',
  ].join("\n");
  return [NODE, "-e", script];
}

Deno.test(
  'sign-in check: agy\'s -32000 "Authentication required" reads as Needs sign-in; a session as Ready',
  sanitize,
  async () => {
    using dir = tempDir();
    const signer = new BetaSigner(
      dir.root,
      () => {
        throw new Error("not used");
      },
      () => ({}),
      { checkTimeout: 20 },
    );
    assertEquals(
      await signer.probe(
        "antigravity",
        fakeAgent({ code: -32000, message: "Authentication required" }),
      ),
      "signin",
    );
    assertEquals(await signer.probe("antigravity", fakeAgent(null)), "ready");
    assertEquals(
      await signer.probe("antigravity", [NODE, "-e", "0"]),
      "unknown",
      "a crash is not a sign-in answer",
    );
  },
);

// ---- the API key's own settings folder ---------------------------------------------------------------------------------

Deno.test('API key: AIB starts agy with --gemini-dir <its own folder>, whose settings.json says modelProvider "gemini"', async () => {
  using dir = tempDir();
  const state = join(dir.root, "state");
  const bin = join(dir.root, "bin");
  const program = touch(join(bin, WIN ? "agy.exe" : "agy"), "");
  const row = await resolveBeta("antigravity", {
    env: envWith(bin),
    windows: WIN,
  });
  assertEquals(
    withKeyHome(row, "antigravity", state, false),
    row,
    "no key: agy's own folder and sign-in",
  );
  const keyed = withKeyHome(row, "antigravity", state, true);
  const home = keyHomeDir("antigravity", state);
  assertEquals(home, join(state, "agents", "antigravity", "gemini-home"));
  assertEquals(keyed.argv, [
    program,
    "acp",
    "--disable-telemetry",
    "--gemini-dir",
    home,
  ]);
  assertEquals(keyed.base, [program]);
  const settings = join(home, "antigravity-cli", "settings.json");
  assertEquals(JSON.parse(Deno.readTextFileSync(settings)), {
    modelProvider: "gemini",
  });
  // agy's own saved settings in that folder are kept; the key's setting is put back when changed
  Deno.writeTextFileSync(
    settings,
    JSON.stringify({
      modelProvider: "",
      model: "gemini-3.1-pro",
      trustedWorkspaces: ["/p"],
    }),
  );
  prepareKeyHome("antigravity", state);
  assertEquals(JSON.parse(Deno.readTextFileSync(settings)), {
    modelProvider: "gemini",
    model: "gemini-3.1-pro",
    trustedWorkspaces: ["/p"],
  });
  // other agents have no keyHome; no state folder means nothing is written
  assertEquals(withKeyHome(row, "gemini", state, true), row);
  assertEquals(withKeyHome(row, "antigravity", null, true), row);
  assertEquals(prepareKeyHome("qwen", state), "");
});

// ---- helpers ------------------------------------------------------------------------------------------------------------------

async function makeTarGz(entries: [string, Uint8Array][]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, data] of entries) {
    const h = new Uint8Array(512);
    h.set(enc.encode(name), 0);
    h.set(enc.encode("0000755\0"), 100);
    h.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    h[156] = 48; // '0'
    h.set(enc.encode("ustar\0"), 257);
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const tar = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    tar.set(p, at);
    at += p.length;
  }
  const out = await new Response(
    new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return new Uint8Array(out);
}
