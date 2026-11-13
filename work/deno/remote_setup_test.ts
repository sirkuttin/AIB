/**
 * Settings > Remote control's setup buttons (server/remote/setup.ts, install.ts, setup_cli.ts) through the real PC routes of an
 * in-process AIB, with a stateful fake Tailscale (_tailscale_sim.ts) that plays every program and download. Nothing real runs:
 * no Tailscale, winget, msiexec, PowerShell, pkgutil, spctl, open or browser.
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  NAME,
  pc,
  type RemoteStudio,
  remoteStudio,
  tempDir,
} from "./_remote_fixture.ts";
import {
  assertSafe,
  type Call,
  HTTPS_URL,
  LOGIN_URL,
  type Script,
  tailscaleSim,
  until,
} from "./_tailscale_sim.ts";
import {
  readRemoteArtifactPort,
  readRemotePort,
} from "../../outputs/agent-studio/server/remote/port.ts";
import {
  hex,
  LINUX_INSTALL,
  LINUX_OPERATOR,
  msiOutcome,
  pickMsi,
  pickPkg,
  pkgutilOk,
  publishedSha,
  remoteSetupCommand,
  SIGNATURE_SCRIPT,
  signatureOk,
  spctlOk,
  windowsArch,
  WINGET_ARGS,
  wingetOutcome,
} from "../../outputs/agent-studio/server/remote/install.ts";
import {
  readServe,
  readTailscale,
} from "../../outputs/agent-studio/server/remote/tailscale.ts";
import {
  defaultOpenUrl,
  safeLink,
  scrub,
} from "../../outputs/agent-studio/server/remote/setup.ts";
import {
  RefusedInTest,
  resolveTool,
  type Tool,
} from "../../outputs/agent-studio/server/remote/setup_cli.ts";
import { defaultRunner } from "../../outputs/agent-studio/server/remote/tailscale.ts";

type Json = Record<string, unknown>;
const OPTS = { sanitizeResources: false, sanitizeOps: false };
const PKGS = Deno.readTextFileSync(
  new URL("./_tailscale_pkgs.json", import.meta.url),
);
const MSI = "tailscale-setup-1.104.7-amd64.msi";
const PKG = "Tailscale-1.104.7-macos.pkg";
const GOOD_SIG =
  '{"status":"Valid","subject":"CN=Tailscale Inc., O=Tailscale Inc., L=Toronto, S=Ontario, C=CA"}';
const PKGUTIL_OK = [
  'Package "Tailscale-1.104.7-macos.pkg":',
  "   Status: signed by a developer certificate issued by Apple for distribution",
  "   Certificate Chain:",
  "    1. Developer ID Installer: Tailscale Inc. (W5364U7YZB)",
];
const SPCTL_OK = [
  "Tailscale-1.104.7-macos.pkg: accepted",
  "source=Notarized Developer ID",
  "origin=Developer ID Installer: Tailscale Inc. (W5364U7YZB)",
];

async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((
    b,
  ) => b.toString(16).padStart(2, "0")).join("");
}

/** An AIB with phone access on and the sim; `files` gets the pkgs.tailscale.com answers. */
async function setupStudio(
  sim: ReturnType<typeof tailscaleSim>,
  over: Parameters<ReturnType<typeof tailscaleSim>["env"]>[0] = {},
  on = true,
) {
  const s = await remoteStudio({
    runner: sim.runner,
    setupEnv: sim.env(over),
    bindRetryMs: 300,
  });
  if (on) await pc(s, "POST", "/api/live/devices/access", { on: true });
  return s;
}
async function view(s: RemoteStudio): Promise<Json> {
  return (await pc(s, "GET", "/api/live/devices"))[1];
}
async function run(
  s: RemoteStudio,
  action: string,
  flags: Json = {},
): Promise<[number, Json]> {
  return await pc(s, "POST", "/api/live/devices/tailscale/run", {
    action,
    ...flags,
  });
}
async function jobEnds(s: RemoteStudio, what = "the job ends"): Promise<Json> {
  let job: Json = {};
  await until(async () => {
    job = (await pc(s, "GET", "/api/live/devices/tailscale/job"))[1]
      .job as Json;
    return !!job && !["running", "waiting"].includes(job.state as string);
  }, what);
  return job;
}
const ts = (v: Json) => v.tailscale as Json;
const setup = (v: Json) => v.setup as Json;
const lines = (calls: Call[], tool: Tool = "tailscale") =>
  calls.filter((c) => c.tool === tool).map((c) => c.args.join(" "));

// ---- pure parts ------------------------------------------------------------------------------------------------------------

Deno.test("code tables: winget and msiexec exit codes", () => {
  assertEquals(wingetOutcome(0, "Successfully installed"), "ok");
  assertEquals(wingetOutcome(0x8A15002B, "No available upgrade found."), "ok");
  assertEquals(wingetOutcome(-1978335189, ""), "ok", "the same code signed");
  assertEquals(
    wingetOutcome(0x8A150006, "Installer failed with exit code: 1602"),
    "declined",
  );
  assertEquals(
    wingetOutcome(1, "The operation was canceled by the user."),
    "declined",
  );
  assertEquals(
    wingetOutcome(0x8A15000F, "Failed when searching source"),
    "failed",
  );
  assertEquals(
    wingetOutcome(0x8A150006, "Installer failed with exit code: 1618"),
    "busy",
  );
  assertEquals(
    [0, 3010, 1641, 1602, 1625, 1223, 1618, 1638, 1603].map(msiOutcome),
    [
      "ok",
      "reboot",
      "reboot",
      "declined",
      "declined",
      "declined",
      "busy",
      "newer",
      "failed",
    ],
  );
  assertEquals(hex(0x8A15000F), "0x8A15000F");
  assertEquals(hex(1603), "1603");
});

Deno.test("the installer file: picked for this CPU from the live pkgs JSON, the published sha256, signature checks", () => {
  const index = JSON.parse(PKGS);
  assertEquals(
    windowsArch((n) =>
      ({ PROCESSOR_ARCHITECTURE: "AMD64" } as Record<string, string>)[n]
    ),
    "amd64",
  );
  assertEquals(
    windowsArch((n) =>
      ({
        PROCESSOR_ARCHITECTURE: "x86",
        PROCESSOR_ARCHITEW6432: "ARM64",
      } as Record<string, string>)[n]
    ),
    "arm64",
  );
  assertEquals(
    windowsArch((n) =>
      ({ PROCESSOR_ARCHITECTURE: "x86" } as Record<string, string>)[n]
    ),
    "x86",
  );
  assertEquals(pickMsi(index, "amd64"), MSI);
  assertEquals(pickMsi(index, "arm64"), "tailscale-setup-1.104.7-arm64.msi");
  assertEquals(
    pickMsi({ MSIs: { amd64: "../evil.msi" } }, "amd64"),
    "",
    "a name that is not Tailscale's is refused",
  );
  assertEquals(pickPkg(index), PKG);
  assertEquals(
    publishedSha(
      "676b5b32fdd1aeaee90d8e8f38e222635b216fbdfbf877bf01cb1d7cda330ec5\n",
    ),
    "676b5b32fdd1aeaee90d8e8f38e222635b216fbdfbf877bf01cb1d7cda330ec5",
  );
  assertEquals(publishedSha("<html>not found</html>"), "");
  assert(signatureOk(GOOD_SIG));
  assert(
    !signatureOk(
      '{"status":"Valid","subject":"CN=Evil, O=Not Tailscale Inc."}',
    ),
  );
  assert(
    !signatureOk('{"status":"HashMismatch","subject":"O=Tailscale Inc."}'),
  );
  assert(
    !SIGNATURE_SCRIPT.includes(":\\"),
    "the path never goes into the PowerShell text",
  );
  assert(pkgutilOk(PKGUTIL_OK.join("\n")));
  assert(!pkgutilOk(PKGUTIL_OK.join("\n").replace("W5364U7YZB", "ABCDE12345")));
  assert(spctlOk(SPCTL_OK.join("\n")));
  assert(!spctlOk("x.pkg: rejected"));
});

Deno.test("sign-in links: only login.tailscale.com, scrubbed from every line AIB keeps", () => {
  assertEquals(safeLink(`\t${LOGIN_URL}`, "login"), LOGIN_URL);
  assertEquals(
    safeLink("https://login.tailscale.com.evil.example/a/abc", "login"),
    "",
  );
  assertEquals(safeLink("http://login.tailscale.com/a/abc", "login"), "");
  assertEquals(safeLink(`visit ${HTTPS_URL}`, "https"), HTTPS_URL);
  assertEquals(safeLink("https://login.tailscale.com/admin/dns", "https"), "");
  assertEquals(scrub(`go to ${LOGIN_URL} now`), "go to <sign-in link> now");
});

Deno.test("serve status: raw TCP forwards and Foreground shares count as something else; old names are listed; Funnel ports named", () => {
  const tcp = readServe(
    { TCP: { "443": { TCPForward: "127.0.0.1:22" } } },
    NAME,
    8779,
    8780,
  );
  assertEquals([tcp.serving, tcp.servingOther], [false, "tcp://127.0.0.1:22"]);
  const fg = readServe(
    {
      Foreground: {
        s: {
          Web: {
            [`${NAME}:8443`]: {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
            },
          },
        },
      },
    },
    NAME,
    8779,
    8780,
  );
  assertEquals([fg.artifactServing, fg.artifactServingOther], [
    false,
    "http://127.0.0.1:3000",
  ]);
  const old = readServe(
    {
      Web: {
        "old-pc.tail-a1b2.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8779" } },
        },
      },
    },
    NAME,
    8779,
  );
  assertEquals([old.serving, old.servingOther, old.otherNames], [false, "", [
    "old-pc.tail-a1b2.ts.net",
  ]]);
  const funnel = readServe(
    {
      Web: {
        [`${NAME}:443`]: {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
      AllowFunnel: { [`${NAME}:443`]: true },
    },
    NAME,
    8779,
  );
  assertEquals(funnel.funnelPorts, [{
    port: 443,
    to: "http://127.0.0.1:3000",
  }]);
});

Deno.test("BackendState: every state is mapped (signed out, machine auth, stopped, starting, not running, not installed)", async () => {
  const sim = tailscaleSim();
  for (
    const [backend, problem] of [
      ["NeedsLogin", "signed_out"],
      ["NeedsMachineAuth", "needs_machine_auth"],
      ["Stopped", "stopped"],
      ["Starting", "starting"],
      ["NoState", "not_running"],
      ["Running", ""],
    ]
  ) {
    sim.sim.backend = backend;
    const t = await readTailscale(8779, sim.runner);
    assertEquals([t.backend, t.problem, t.signedIn], [
      backend,
      problem,
      backend === "Running",
    ], backend);
  }
  sim.sim.installed = false;
  assertEquals(
    (await readTailscale(8779, sim.runner)).problem,
    "not_installed",
  );
  assertEquals(sim.reads[0], ["status", "--json", "--peers=false"]);
});

Deno.test("AGENT_STUDIO_TEST=1 without a fake: every changing program is refused, the real Tailscale is never read, no browser opens", async () => {
  const saved: Record<string, string | undefined> = {};
  const hooks = [
    "AIB_TAILSCALE_CLI",
    "AIB_WINGET_CLI",
    "AIB_MSIEXEC_CLI",
    "AIB_POWERSHELL_CLI",
    "AIB_PKGUTIL_CLI",
    "AIB_SPCTL_CLI",
    "AIB_OPEN_CLI",
    "AIB_REMOTE_SETUP_SHELL",
  ];
  for (const h of hooks) {
    saved[h] = Deno.env.get(h);
    Deno.env.delete(h);
  }
  try {
    assertEquals(Deno.env.get("AGENT_STUDIO_TEST"), "1");
    for (
      const tool of [
        "tailscale",
        "winget",
        "msiexec",
        "powershell",
        "pkgutil",
        "spctl",
        "open",
        "ipn",
      ] as Tool[]
    ) {
      let refused = false;
      try {
        resolveTool(tool);
      } catch (e) {
        refused = e instanceof RefusedInTest;
      }
      assert(refused, `${tool} refused`);
    }
    assertEquals(
      await defaultRunner(["status", "--json"]),
      null,
      "reads as not installed",
    );
    assertEquals(
      typeof remoteSetupCommand("tailscale-install"),
      "string",
      "the Linux terminal step refuses too",
    );
    defaultOpenUrl(LOGIN_URL); // must not open anything (nothing to assert beyond not throwing; no hook means no spawn)
    // and through the real route: an AIB with no fakes at all refuses Install
    const s = await remoteStudio({
      setupEnv: { os: () => "windows", hasWinget: () => true },
    });
    try {
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      const [status] = await run(s, "install");
      assertEquals(status, 202);
      const job = await jobEnds(s);
      assertEquals([job.state, job.code], ["failed", "refused"]);
    } finally {
      await s.close();
    }
  } finally {
    for (const h of hooks) {
      if (saved[h] !== undefined) Deno.env.set(h, saved[h]!);
    }
  }
});

Deno.test("the Linux setup terminal: exactly the install line, the operator line or start, handed to the fake shell", () => {
  Deno.env.set("AIB_REMOTE_SETUP_SHELL", JSON.stringify(["fake-sh", "-c"]));
  try {
    assertEquals(remoteSetupCommand("tailscale-install"), {
      file: "fake-sh",
      args: ["-c", LINUX_INSTALL],
    });
    assertEquals(remoteSetupCommand("tailscale-operator"), {
      file: "fake-sh",
      args: ["-c", LINUX_OPERATOR],
    });
    assertEquals(
      LINUX_INSTALL,
      'curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale set --operator="$(id -un)"',
    );
    assertEquals(
      typeof remoteSetupCommand("rm -rf /"),
      "string",
      "only the fixed steps",
    );
  } finally {
    Deno.env.delete("AIB_REMOTE_SETUP_SHELL");
  }
});

// ---- Install -----------------------------------------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name:
    "Install with winget: exactly the winget line; the step turns green with no click and no restart; one change listed",
  async fn() {
    const sim = tailscaleSim(
      { installed: false },
      (c, sim) => (c.tool === "winget"
        ? {
          code: 0,
          lines: ["Downloading", "Successfully installed"],
          effect: () => (sim.installed = true, sim.backend = "NeedsLogin"),
        }
        : undefined),
    );
    const s = await setupStudio(sim);
    try {
      let v = await view(s);
      assertEquals([ts(v).installed, setup(v).installMode], [false, "winget"]);
      assertEquals((await run(s, "install"))[0], 202);
      const job = await jobEnds(s);
      assertEquals(job.state, "done", JSON.stringify(job));
      assertEquals(
        sim.calls.filter((c) => c.tool === "winget").map((c) => c.args),
        [WINGET_ARGS],
      );
      assertEquals(
        WINGET_ARGS.join(" "),
        "install --id Tailscale.Tailscale --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --source winget",
      );
      await pc(s, "POST", "/api/live/devices/tailscale/refresh", {});
      v = await view(s);
      assertEquals([ts(v).installed, ts(v).problem], [true, "signed_out"]);
      const changes = setup(v).changes as Json[];
      assertEquals(changes.map((c) => [c.label, c.ok]), [[
        "Installed Tailscale",
        true,
      ]]);
      assert(
        String(changes[0].command).startsWith(
          "winget install --id Tailscale.Tailscale",
        ),
      );
      const audit = Deno.readTextFileSync(`${s.state}/remote-audit.jsonl`);
      assert(
        audit.includes("Installed Tailscale: done"),
        "one Phone activity line",
      );
      assertSafe(sim.calls);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'Install with winget, Windows prompt declined: "You chose No", nothing installed, Install works again',
  async fn() {
    const sim = tailscaleSim(
      { installed: false },
      (
        c,
      ) => (c.tool === "winget"
        ? { code: 0x8A150006, lines: ["Installer failed with exit code: 1602"] }
        : undefined),
    );
    const s = await setupStudio(sim);
    try {
      await run(s, "install");
      const job = await jobEnds(s);
      assertEquals([job.state, job.code], ["failed", "declined"]);
      assertEquals(
        job.message,
        "You chose No on the Windows prompt. Nothing was installed.",
      );
      assertEquals(
        (await run(s, "install"))[0],
        202,
        "Install Tailscale works again",
      );
      await jobEnds(s);
    } finally {
      await s.close();
    }
  },
});

/** pkgs.tailscale.com in the sim: the live JSON, the file and its .sha256 (or `badSha` / no sha). */
async function servePkgs(
  sim: ReturnType<typeof tailscaleSim>,
  name: string,
  opts: { badSha?: boolean; noSha?: boolean } = {},
) {
  const bytes = new TextEncoder().encode("fake installer bytes " + name);
  sim.files.set("/?mode=json", PKGS);
  sim.files.set("/" + name, bytes);
  if (!opts.noSha) {
    sim.files.set(
      "/" + name + ".sha256",
      (opts.badSha ? "f".repeat(64) : await sha(bytes)) + "\n",
    );
  }
}

Deno.test({
  ...OPTS,
  name:
    "Install without winget: the MSI for this CPU, checksum, signature by path in AIB_MSI (a ' and a space in the path), msiexec, file deleted",
  async fn() {
    const parent = await tempDir("aib-o'brien dir-");
    const dirs: string[] = [];
    const sim = tailscaleSim({ installed: false }, (c, sim) => {
      if (c.tool === "powershell") return { code: 0, lines: [GOOD_SIG] };
      if (c.tool === "msiexec") {
        return {
          code: 0,
          effect: () => (sim.installed = true, sim.backend = "NeedsLogin"),
        };
      }
    });
    await servePkgs(sim, "tailscale-setup-1.104.7-arm64.msi");
    const s = await setupStudio(sim, {
      hasWinget: () => false,
      env: (n) =>
        ({ PROCESSOR_ARCHITECTURE: "ARM64" } as Record<string, string>)[n],
      tempDir: async () => {
        const d = `${parent}/dl ${dirs.length}`;
        await Deno.mkdir(d);
        dirs.push(d);
        return d;
      },
    });
    try {
      assertEquals(setup(await view(s)).installMode, "msi");
      await run(s, "install");
      const job = await jobEnds(s);
      assertEquals(job.state, "done", JSON.stringify(job));
      const ps = sim.calls.find((c) => c.tool === "powershell")!;
      const file = `${dirs[0]}${
        Deno.build.os === "windows" ? "\\" : "/"
      }tailscale-setup-1.104.7-arm64.msi`;
      assertEquals(ps.env, { AIB_MSI: file });
      assertEquals(ps.args, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        SIGNATURE_SCRIPT,
      ]);
      const msi = sim.calls.find((c) => c.tool === "msiexec")!;
      assertEquals(msi.args.slice(0, 4), [
        "/i",
        file,
        "/passive",
        "/norestart",
      ]);
      assertEquals(msi.args[4], "/l*v");
      let gone = false;
      try {
        Deno.statSync(dirs[0]);
      } catch {
        gone = true;
      }
      assert(gone, "the download folder is deleted");
      assertSafe(sim.calls);
    } finally {
      await s.close();
      await Deno.remove(parent, { recursive: true }).catch(() => {});
    }
  },
});

for (
  const [label, opts, code, ran] of [
    ["checksum mismatch", { badSha: true }, "checksum", false],
    ["no published sha256", { noSha: true }, "no_checksum", false],
  ] as const
) {
  Deno.test({
    ...OPTS,
    name:
      `Install without winget, ${label}: stopped, nothing run, file deleted`,
    async fn() {
      const dirs: string[] = [];
      const sim = tailscaleSim({ installed: false });
      await servePkgs(sim, MSI, opts);
      const s = await setupStudio(sim, {
        hasWinget: () => false,
        tempDir: async () => {
          const d = await tempDir("aib-ts-dl-");
          dirs.push(d);
          return d;
        },
      });
      try {
        await run(s, "install");
        const job = await jobEnds(s);
        assertEquals([job.state, job.code], ["failed", code]);
        if (code === "checksum") {
          assert(
            String(job.message).startsWith("The download didn't match"),
            String(job.message),
          );
        }
        assertEquals(
          sim.calls.some((c) =>
            c.tool === "msiexec" || c.tool === "powershell"
          ),
          ran,
        );
        for (const d of dirs) {
          let gone = false;
          try {
            Deno.statSync(d);
          } catch {
            gone = true;
          }
          assert(gone, "deleted");
        }
      } finally {
        await s.close();
      }
    },
  });
}

Deno.test({
  ...OPTS,
  name:
    "Install without winget: a bad signature stops before msiexec; msiexec 1602 / 1618 / 3010 say what happened",
  async fn() {
    let sig = '{"status":"NotSigned","subject":""}';
    let msiCode = 1602;
    const sim = tailscaleSim({ installed: false }, (c) => {
      if (c.tool === "powershell") return { code: 0, lines: [sig] };
      if (c.tool === "msiexec") return { code: msiCode };
    });
    await servePkgs(sim, MSI);
    const s = await setupStudio(sim, { hasWinget: () => false });
    try {
      await run(s, "install");
      let job = await jobEnds(s);
      assertEquals([job.code, sim.calls.some((c) => c.tool === "msiexec")], [
        "signature",
        false,
      ]);
      sig = GOOD_SIG;
      for (const [c, want] of [[1602, "declined"], [1618, "busy"]] as const) {
        msiCode = c;
        await run(s, "install");
        job = await jobEnds(s);
        assertEquals(job.code, want, String(c));
      }
      msiCode = 3010;
      await run(s, "install");
      job = await jobEnds(s);
      assertEquals([job.state, job.reboot], ["done", true]);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "macOS: the .pkg opens only after pkgutil and spctl say Tailscale Inc.; it is kept until Tailscale is found",
  async fn() {
    const sim = tailscaleSim({ installed: false }, (c) => {
      if (c.tool === "pkgutil") return { code: 0, lines: PKGUTIL_OK };
      if (c.tool === "spctl") return { code: 0, lines: SPCTL_OK };
      if (c.tool === "open") return { code: 0 };
    });
    await servePkgs(sim, PKG);
    const s = await setupStudio(sim, { os: () => "darwin" });
    try {
      const v = await view(s);
      assertEquals(setup(v).installMode, "pkg");
      await run(s, "install");
      await until(
        () =>
          !!s.ctx.phone.setup.pkgKept &&
          s.ctx.phone.setup.job?.state === "waiting",
        "the installer is open",
      );
      const order = sim.calls.filter((c) =>
        ["pkgutil", "spctl", "open"].includes(c.tool)
      ).map((c) => c.tool);
      assertEquals(order, ["pkgutil", "spctl", "open"]);
      const kept = s.ctx.phone.setup.pkgKept;
      assert(
        Deno.statSync(`${kept}/${PKG}`).isFile,
        "not deleted while the Installer may still read it",
      );
      sim.sim.installed = true;
      sim.sim.backend = "NeedsLogin";
      const job = await jobEnds(s);
      assertEquals(job.state, "done");
      let gone = false;
      try {
        Deno.statSync(kept);
      } catch {
        gone = true;
      }
      assert(gone, "deleted once Tailscale is found");
    } finally {
      await s.close();
    }
  },
});

// ---- Sign in -----------------------------------------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name:
    "Sign in: the link Tailscale prints is opened exactly; green on Running (the login process is stopped); the link never leaks",
  async fn() {
    const sim = tailscaleSim({ backend: "NeedsLogin" });
    const s = await setupStudio(sim);
    try {
      assertEquals((await run(s, "login"))[0], 202);
      await until(() => sim.opened.length === 1, "the browser opens");
      assertEquals(sim.opened, [LOGIN_URL]);
      const job = (await pc(s, "GET", "/api/live/devices/tailscale/job"))[1]
        .job as Json;
      assertEquals([job.state, job.link, job.phase], [
        "running",
        LOGIN_URL,
        "browser",
      ], "the PC page keeps a fallback link");
      assert(
        !(job.details as string[]).join("\n").includes(LOGIN_URL),
        "Show details has no link",
      );
      sim.sim.backend = "Running";
      const done = await jobEnds(s);
      assertEquals(done.state, "done");
      assertEquals(done.link, "", "forgotten once signed in");
      assert(
        sim.procs.find((p) => p.args[0] === "login")!.killed,
        "tailscale login was stopped",
      );
      // nowhere on disk: state files, the changes list, the activity log
      for (const entry of Deno.readDirSync(s.state)) {
        if (!entry.isFile) continue;
        const text = Deno.readTextFileSync(`${s.state}/${entry.name}`);
        assert(
          !text.includes("1a2b3c4d5e6f"),
          `${entry.name} has the sign-in link`,
        );
      }
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'Sign in: Cancel stops it; no link in time says to open Tailscale; "non-default flags" and the Linux operator error are named',
  async fn() {
    let answer: "hang" | "flags" | "operator" = "hang";
    const sim = tailscaleSim({ backend: "NeedsLogin" }, (c) => {
      if (c.tool !== "tailscale" || c.args[0] !== "login") return;
      if (answer === "hang") return { hang: true };
      if (answer === "flags") {
        return {
          code: 1,
          lines: [
            "Error: changing settings via 'tailscale up' requires mentioning all non-default flags.",
          ],
        };
      }
      return {
        code: 1,
        lines: [
          "Access denied: prefs write access denied",
          "Use 'sudo tailscale login' or set an operator with --operator=$USER",
        ],
      };
    });
    const s = await setupStudio(sim);
    try {
      await run(s, "login");
      await until(
        async () =>
          ((await pc(s, "GET", "/api/live/devices/tailscale/job"))[1]
            .job as Json).phase === "no_link",
        "no link in time",
      );
      const [, cancelled] = await pc(
        s,
        "POST",
        "/api/live/devices/tailscale/cancel",
        {},
      );
      assertEquals(cancelled.cancelled, true);
      const job = await jobEnds(s);
      assertEquals(job.state, "cancelled");
      assert(sim.procs.at(-1)!.killed);
      answer = "flags";
      await run(s, "login");
      assertEquals((await jobEnds(s)).code, "flags");
      answer = "operator";
      await run(s, "login");
      const op = await jobEnds(s);
      assertEquals([op.code, op.fallback], ["operator", LINUX_OPERATOR]);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Tailscale switched off later: the state says Stopped, Turn Tailscale on runs tailscale up",
  async fn() {
    const sim = tailscaleSim({ backend: "Stopped" });
    const s = await setupStudio(sim);
    try {
      assertEquals(ts(await view(s)).problem, "stopped");
      await run(s, "up");
      await until(() => lines(sim.calls).includes("up"), "tailscale up");
      sim.sim.backend = "Running";
      assertEquals((await jobEnds(s)).state, "done");
    } finally {
      await s.close();
    }
  },
});

// ---- HTTPS and Share ---------------------------------------------------------------------------------------------------------

Deno.test({
  ...OPTS,
  name:
    "Turn on HTTPS: the /f/serve link the serve command prints is opened (the command is stopped); green once CertDomains has the PC",
  async fn() {
    const sim = tailscaleSim({ https: false });
    const s = await setupStudio(sim);
    try {
      const [status] = await run(s, "https");
      assertEquals(status, 202);
      await jobEnds(s);
      assertEquals(sim.opened, [HTTPS_URL]);
      assert(
        sim.procs.find((p) => p.args[0] === "serve")!.killed,
        "the waiting serve command was stopped",
      );
      let v = await view(s);
      assertEquals([setup(v).httpsWaiting, setup(v).httpsLink], [
        true,
        HTTPS_URL,
      ]);
      await run(s, "open-https");
      assertEquals(sim.opened, [HTTPS_URL, HTTPS_URL], "Open the page again");
      sim.sim.https = true;
      await pc(s, "POST", "/api/live/devices/tailscale/refresh", {});
      await new Promise((r) => setTimeout(r, 2600)); // past the read cache
      await pc(s, "POST", "/api/live/devices/tailscale/refresh", {});
      v = await view(s);
      assertEquals([ts(v).https, setup(v).httpsWaiting], [true, false]);
      assertEquals(sim.sim.serve, {}, "nothing was shared");
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Share AIB: 8443 then 443 with the saved ports; HTTPS off waits and shares by itself once it is on; Stop sharing only ours",
  async fn() {
    const sim = tailscaleSim({ https: false });
    const s = await setupStudio(sim);
    try {
      const port = readRemotePort(s.state)!;
      const aport = readRemoteArtifactPort(s.state)!;
      assertEquals((await run(s, "share"))[0], 202);
      await until(
        () => s.ctx.phone.setup.job?.phase === "https",
        "waits for HTTPS",
      );
      sim.sim.https = true;
      const job = await jobEnds(s, "shared by itself");
      assertEquals(job.state, "done", JSON.stringify(job));
      const serves = lines(sim.calls).filter((l) => l.startsWith("serve --bg"));
      assertEquals(serves, [
        `serve --bg --https=8443 http://127.0.0.1:${aport}`, // printed the HTTPS link and was stopped
        `serve --bg --https=8443 http://127.0.0.1:${aport}`,
        `serve --bg --https=443 http://127.0.0.1:${port}`,
      ]);
      assertEquals(sim.sim.serve, {
        "8443": `http://127.0.0.1:${aport}`,
        "443": `http://127.0.0.1:${port}`,
      });
      let v = await view(s);
      assertEquals([ts(v).serving, ts(v).artifactServing, setup(v).shared], [
        true,
        true,
        true,
      ]);
      // Stop sharing: 8443 was taken over by another program meanwhile: only 443 goes
      sim.sim.serve["8443"] = "http://127.0.0.1:3000";
      await run(s, "unshare");
      await jobEnds(s);
      assertEquals(lines(sim.calls).filter((l) => l.endsWith(" off")), [
        "serve --https=443 off",
      ]);
      assertEquals(sim.sim.serve, { "8443": "http://127.0.0.1:3000" });
      v = await view(s);
      assertEquals(setup(v).shared, false);
      assertEquals((setup(v).changes as Json[]).map((c) => c.label), [
        "Stopped sharing AIB",
        "Shared AIB",
        "Shared artifacts",
      ]);
      assertSafe(sim.calls);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Share AIB: something else on 443 and 8443 asks first (one confirm naming both); --yes only after Replace and share",
  async fn() {
    const sim = tailscaleSim({
      serve: { "443": "http://127.0.0.1:3000", "8443": "tcp://127.0.0.1:22" },
    });
    const s = await setupStudio(sim);
    try {
      const [status, body] = await run(s, "share");
      assertEquals([status, body.code], [409, "replace_needed"]);
      assertEquals(body.others, [{ port: 443, to: "http://127.0.0.1:3000" }, {
        port: 8443,
        to: "tcp://127.0.0.1:22",
      }]);
      assertEquals(
        lines(sim.calls).filter((l) => l.startsWith("serve --bg")),
        [],
        "nothing ran before the confirm",
      );
      assertEquals((await run(s, "share", { replace: true }))[0], 202);
      await jobEnds(s);
      const serves = lines(sim.calls).filter((l) => l.startsWith("serve --bg"));
      assert(
        serves.length === 2 && serves.every((l) => l.includes("--yes")),
        serves.join("\n"),
      );
      assertEquals(
        lines(sim.calls).filter((l) => l.includes("--yes")).length,
        2,
      );
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Share AIB: Funnel on or the phone port busy runs no serve command; Turn off Funnel needs the confirm, then the port opens",
  async fn() {
    const sim = tailscaleSim({
      funnel: [443],
      serve: { "443": "http://127.0.0.1:3000" },
    });
    const s = await setupStudio(sim);
    try {
      let v = await view(s);
      assertEquals([(v.problem as Json).code, v.listening], ["funnel", false]);
      assert(
        String((v.problem as Json).message).includes(
          `https://${NAME}:443 → http://127.0.0.1:3000 is on the public internet`,
        ),
      );
      assert(
        !/tailscale funnel/.test(String((v.problem as Json).message)),
        "no command to type",
      );
      assertEquals((await run(s, "share"))[1].code, "funnel");
      assertEquals((await run(s, "funnel-off"))[0], 400, "needs the confirm");
      assertEquals(lines(sim.calls), []);
      await run(s, "funnel-off", { confirm: true });
      await jobEnds(s);
      assertEquals(lines(sim.calls), ["funnel --https=443 off"]);
      v = await view(s);
      assertEquals([v.problem, v.listening], [null, true]);
      // port busy
      await pc(s, "POST", "/api/live/devices/access", { on: false });
      const held = Deno.listen({
        hostname: "127.0.0.1",
        port: readRemotePort(s.state)!,
      });
      try {
        await pc(s, "POST", "/api/live/devices/access", { on: true });
        const before = lines(sim.calls).length;
        const [st, body] = await run(s, "share", { replace: true });
        assertEquals([st, body.code], [409, "port_busy"]);
        assertEquals(lines(sim.calls).length, before, "no serve command");
      } finally {
        held.close();
      }
      assertSafe(sim.calls);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Share AIB: the artifact share fails, the phone share stays and the page says why (no rollback)",
  async fn() {
    const sim = tailscaleSim(
      {},
      (
        c,
      ) => (c.tool === "tailscale" && c.args.includes("--https=8443") &&
          c.args.includes("--bg")
        ? { code: 1, lines: ["error: listener already exists for port 8443"] }
        : undefined),
    );
    const s = await setupStudio(sim);
    try {
      await run(s, "share");
      const job = await jobEnds(s);
      assertEquals(job.state, "done");
      const v = await view(s);
      assertEquals([ts(v).serving, ts(v).artifactServing], [true, false]);
      assertEquals(
        setup(v).artifactNote,
        "Tailscale didn't share port 8443: error: listener already exists for port 8443",
      );
      assertEquals(
        lines(sim.calls).filter((l) => l.endsWith(" off")),
        [],
        "nothing undone",
      );
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Switching off stops sharing; switched off while Tailscale is stopped: remembered and done once it runs; switching on shares again",
  async fn() {
    const sim = tailscaleSim();
    const s = await setupStudio(sim);
    try {
      await run(s, "share");
      await jobEnds(s);
      assertEquals(Object.keys(sim.sim.serve).sort(), ["443", "8443"]);
      await pc(s, "POST", "/api/live/devices/access", { on: false });
      await jobEnds(s, "unshared after off");
      assertEquals(sim.sim.serve, {});
      // on again: shares with no extra click
      await pc(s, "POST", "/api/live/devices/access", { on: true });
      await jobEnds(s, "shared again");
      assertEquals(Object.keys(sim.sim.serve).sort(), ["443", "8443"]);
      // off while Tailscale is stopped
      sim.sim.backend = "Stopped";
      await pc(s, "POST", "/api/live/devices/access", { on: false });
      await jobEnds(s);
      let v = await view(s);
      assertEquals(setup(v).pendingUnshare, true);
      assertEquals(
        JSON.parse(Deno.readTextFileSync(`${s.state}/phone-access.json`))
          .pendingUnshare,
        true,
      );
      sim.sim.backend = "Running";
      await new Promise((r) => setTimeout(r, 2600));
      await pc(s, "POST", "/api/live/devices/tailscale/refresh", {});
      await until(
        () => Object.keys(sim.sim.serve).length === 0,
        "removed once Tailscale runs",
      );
      await jobEnds(s);
      v = await view(s);
      assertEquals(setup(v).pendingUnshare, false);
      assertSafe(sim.calls);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "AIB starts with the switch on and its share missing: no serve command runs, the notice shows until Share again or dismiss",
  async fn() {
    const sim = tailscaleSim();
    const root = await tempDir("aib-remote-");
    Deno.mkdirSync(`${root}/state`, { recursive: true });
    Deno.writeTextFileSync(
      `${root}/state/phone-access.json`,
      JSON.stringify({ version: 1, on: true, via: "tailscale", shared: true }),
    );
    const s = await remoteStudio({
      runner: sim.runner,
      setupEnv: sim.env(),
      bindRetryMs: 300,
    }, root);
    try {
      await s.ctx.phone.start();
      let v = await view(s);
      assertEquals(
        [v.listening, setup(v).missingAtStart, setup(v).shareAgain],
        [true, true, true],
      );
      assertEquals(lines(sim.calls), [], "nothing re-added silently");
      await run(s, "dismiss-missing");
      assertEquals(setup(await view(s)).missingAtStart, false);
      s.ctx.phone.setup.missingAtStart = true;
      await run(s, "share"); // the notice's Share again
      await jobEnds(s);
      v = await view(s);
      assertEquals([ts(v).serving, setup(v).missingAtStart], [true, false]);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "the page re-check: one Tailscale read serves calls within 2.5 s; nothing is read while phone access is off and nobody asks",
  async fn() {
    const sim = tailscaleSim();
    const s = await setupStudio(sim);
    try {
      await new Promise((r) => setTimeout(r, 2600));
      const before = sim.reads.filter((r) => r[0] === "status").length;
      await Promise.all(
        [1, 2, 3].map(() =>
          pc(s, "POST", "/api/live/devices/tailscale/refresh", {})
        ),
      );
      await pc(s, "POST", "/api/live/devices/tailscale/refresh", {});
      assertEquals(
        sim.reads.filter((r) => r[0] === "status").length - before,
        1,
      );
      await pc(s, "POST", "/api/live/devices/access", { on: false });
      const off = sim.reads.length;
      for (let i = 0; i < 3; i++) await pc(s, "GET", "/api/live/devices");
      assertEquals(sim.reads.length, off, "reading the view runs no command");
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "Silent reminders: per phone, on when missing, saved at once, one activity line; an unknown phone is 404",
  async fn() {
    const sim = tailscaleSim();
    const s = await setupStudio(sim);
    try {
      const added = await s.ctx.phone.devices.add({
        name: "Pixel 9",
        login: "owner@example.com",
        scopes: ["phone.read"],
      });
      assertEquals(added.device.remind, true);
      const [st, body] = await pc(s, "POST", "/api/live/devices/prefs", {
        id: added.device.id,
        remind: false,
      });
      assertEquals([st, (body.device as Json).remind], [200, false]);
      assertEquals(((await view(s)).devices as Json[])[0].remind, false);
      const saved = JSON.parse(
        Deno.readTextFileSync(`${s.state}/devices.json`),
      );
      assertEquals(saved.devices[0].remind, false);
      await pc(s, "POST", "/api/live/devices/prefs", {
        id: added.device.id,
        remind: true,
      });
      assertEquals(
        "remind" in
          JSON.parse(Deno.readTextFileSync(`${s.state}/devices.json`))
            .devices[0],
        false,
        "on = the field is gone",
      );
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/prefs", {
          id: "nope",
          remind: true,
        }))[0],
        404,
      );
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/prefs", {
          id: added.device.id,
          remind: "yes",
        }))[0],
        400,
      );
      assert(
        Deno.readTextFileSync(`${s.state}/remote-audit.jsonl`).includes(
          '"silent reminders"',
        ),
      );
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "the setup routes need the page token and take only fixed action names",
  async fn() {
    const sim = tailscaleSim();
    const s = await setupStudio(sim);
    try {
      for (
        const [m, p] of [["POST", "/api/live/devices/tailscale/run"], [
          "GET",
          "/api/live/devices/tailscale/job",
        ], ["POST", "/api/live/devices/tailscale/refresh"]]
      ) {
        const r = await fetch(`http://127.0.0.1:${s.port}${p}`, {
          method: m,
          ...(m === "POST"
            ? { body: "{}", headers: { "content-type": "application/json" } }
            : {}),
        });
        assertEquals(r.status, 403, p);
        await r.body?.cancel();
      }
      assertEquals((await run(s, "serve reset"))[0], 400);
      assertEquals(
        (await pc(s, "POST", "/api/live/devices/tailscale/run", {
          action: "share",
          command: "tailscale serve reset",
        }))[0],
        202,
      );
      await jobEnds(s);
      assertSafe(sim.calls);
      // the phone port never answers them
      const phone = s.phonePort();
      const r = await fetch(
        `http://127.0.0.1:${phone}/api/live/devices/tailscale/job`,
      );
      assert(r.status === 403 || r.status === 404, String(r.status));
      await r.body?.cancel();
    } finally {
      await s.close();
    }
  },
});

export type { Script };
