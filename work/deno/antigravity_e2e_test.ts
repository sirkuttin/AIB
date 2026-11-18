/**
 * Antigravity CLI end to end with the real program, and without any Google account: AIB installs `agy` from Google's download (the
 * real file from storage.googleapis.com/antigravity-public/, SHA-512 checked) into a temp state folder, then:
 *
 *   sign-in check   no sign-in and no key: agy answers session/new with -32000 "Authentication required" = Needs sign-in
 *   API key         a dummy GEMINI_API_KEY saved in Settings: AIB starts agy with --gemini-dir <its own folder> holding
 *                   settings.json {"modelProvider": "gemini"}, and the check reads Ready (agy checks the key only when a prompt is sent)
 *   chat            session/new through Studio: its models (the model config option), its modes (default, accept-edits, plan);
 *                   no prompt is ever sent (that would reach Google with the dummy key)
 *
 * Isolation: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_* and TEMP point into the temp folder for this whole test process, so agy's
 * ~/.gemini is a temp one; the owner's real ~/.gemini is checked to be untouched. GEMINI_API_KEY and GOOGLE_* are cleared. The test
 * skips (passes with a note) when Google's download cannot be reached. Downloads about 235 MB (Windows), so it is in the SLOW list.
 */
import { assert, assertEquals } from "./_assert.ts";
import { Studio } from "../../outputs/agent-studio/server/host/studio.ts";
import { pathOf } from "../../outputs/agent-studio/server/state/paths.ts";
import { releaseAsset } from "../../outputs/agent-studio/server/agents/release_install.ts";
import { betaAgent } from "../../outputs/agent-studio/server/agents/beta_catalog.ts";
import {
  keyHomeDir,
  resolveBeta,
} from "../../outputs/agent-studio/server/agents/beta_agents.ts";

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const WIN = Deno.build.os === "windows";
const HOME_VARS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];
const CLEARED = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/** The owner's real ~/.gemini, read before the test changes the environment. */
function ownerGemini(): string {
  const home = Deno.env.get(WIN ? "USERPROFILE" : "HOME") ?? "";
  return home ? pathOf(home, ".gemini") : "";
}

/**
 * True when the OS keyring already holds an Antigravity sign-in for this user. agy keeps its Google sign-in there (Windows
 * Credential Manager target "gemini:antigravity"), which is per user, not per HOME, so a temp HOME does not hide it and the
 * check answers "ready" instead of -32000. Only target names are listed, never a secret. Windows only; elsewhere assumed absent.
 */
function osSignIn(): boolean {
  if (!WIN) return false;
  try {
    const out = new Deno.Command("cmdkey", { args: ["/list"], stdout: "piped", stderr: "null" }).outputSync();
    return /Target:.*antigravity/i.test(new TextDecoder().decode(out.stdout));
  } catch {
    return false;
  }
}

/** Newest modification time under a folder (0 when it does not exist), to see that nothing in it changed. */
function newest(path: string, depth = 2): number {
  let out = 0;
  try {
    const st = Deno.statSync(path);
    out = st.mtime?.getTime() ?? 0;
    if (st.isDirectory && depth > 0) {
      for (const e of Deno.readDirSync(path)) {
        out = Math.max(out, newest(pathOf(path, e.name), depth - 1));
      }
    }
  } catch { /* missing */ }
  return out;
}

Deno.test({
  name:
    "Antigravity e2e: AIB installs the real agy, -32000 = Needs sign-in, a key = Ready with its own folder, session/new",
  ...T,
  async fn() {
    if (!releaseAsset(betaAgent("antigravity"))) {
      console.log(
        `skipped: Google publishes no Antigravity CLI build for ${Deno.build.os}-${Deno.build.arch}`,
      );
      return;
    }
    const owner = ownerGemini();
    const signedInOnThisPc = osSignIn();
    const ownerBefore = [exists(owner), newest(owner)];
    const saved = Object.fromEntries(
      [
        ...HOME_VARS,
        ...CLEARED,
        "TEMP",
        "TMP",
        "TMPDIR",
        "AGENT_STUDIO_TEST",
        "AGENT_STUDIO_ALLOW_REAL_AGENT",
      ].map((k) => [k, Deno.env.get(k)]),
    );
    const root = Deno.realPathSync(
      Deno.makeTempDirSync({ prefix: "aib-agy-e2e-" }),
    );
    const home = pathOf(root, "home");
    for (const name of HOME_VARS) {
      const folder = name === "APPDATA"
        ? pathOf(home, "AppData", "Roaming")
        : name === "LOCALAPPDATA"
        ? pathOf(home, "AppData", "Local")
        : name.startsWith("XDG_")
        ? pathOf(home, "xdg", name.slice(4).toLowerCase())
        : home;
      Deno.mkdirSync(folder, { recursive: true });
      Deno.env.set(name, folder);
    }
    for (const name of CLEARED) Deno.env.delete(name);
    const tmp = pathOf(root, "tmp");
    Deno.mkdirSync(tmp);
    for (const name of ["TEMP", "TMP", "TMPDIR"]) Deno.env.set(name, tmp);
    Deno.env.set("AGENT_STUDIO_TEST", "1");
    Deno.env.set("AGENT_STUDIO_ALLOW_REAL_AGENT", "1"); // the real agy may start: everything it sees is in the temp folder

    const state = pathOf(root, "state");
    const project = pathOf(root, "proj");
    Deno.mkdirSync(project);
    Deno.writeTextFileSync(pathOf(project, "README.md"), "a test project\n");
    const studio = new Studio({
      ompCommand: "unused",
      stateDir: state,
      port: 0,
      ownersDir: null,
    });
    studio.ownerProbe = () => null;
    try {
      // ---- 1. Install: Google's real build, checked against the pinned SHA-512 ----
      const [status, started] = await studio.installCall(
        "start",
        "antigravity",
      );
      assertEquals(status, 200, JSON.stringify(started));
      await studio.installer!.jobs.get("antigravity")?.done;
      const view =
        (await studio.installCall("status", "antigravity"))[1] as Json;
      if (
        view.state === "failed" &&
        /reach storage|answered \d+|part way/.test(String(view.message))
      ) {
        console.log(
          `skipped: the Antigravity CLI build could not be downloaded (${view.message})`,
        );
        return;
      }
      assertEquals(
        [view.state, view.message],
        ["done", ""],
        JSON.stringify(view),
      );
      const program = pathOf(
        state,
        "agents",
        "antigravity",
        "1.5.11",
        WIN ? "agy.exe" : "agy",
      );
      assert(exists(program), program);
      const row = await resolveBeta("antigravity", { stateDir: state });
      assertEquals([row.found, row.source, row.argv], [true, "studio", [
        program,
        "acp",
        "--disable-telemetry",
      ]]);

      // ---- 2. Sign-in check with no sign-in and no key: -32000 = Needs sign-in ----
      let check =
        (await studio.signinCall("check", "antigravity", true))[1] as Json;
      // With an OS-level sign-in (see osSignIn) agy is ready even in a temp HOME; only without one is it -32000 = Needs sign-in.
      assertEquals(
        check.state,
        signedInOnThisPc ? "ready" : "signin",
        JSON.stringify(check),
      );
      assert(exists(pathOf(home, ".gemini")), "agy used the temp home");

      // ---- 3. A dummy Gemini key: AIB's own folder with modelProvider "gemini", Ready ----
      await studio.settings.update({
        agents: {
          betaKey: { antigravity: "AIza-dummy-not-a-real-key-000000000000" },
        },
      });
      assertEquals(studio.betaEnv("antigravity"), {
        GEMINI_API_KEY: "AIza-dummy-not-a-real-key-000000000000",
      });
      check =
        (await studio.signinCall("check", "antigravity", true))[1] as Json;
      assertEquals(check.state, "ready", JSON.stringify(check));
      const keyHome = keyHomeDir("antigravity", state);
      assertEquals(
        JSON.parse(
          Deno.readTextFileSync(
            pathOf(keyHome, "antigravity-cli", "settings.json"),
          ),
        ).modelProvider,
        "gemini",
      );
      assert(
        exists(pathOf(keyHome, "antigravity-cli", "conversations")) ||
          exists(pathOf(keyHome, "antigravity-cli", "brain")),
        "agy kept its data there",
      );

      // ---- 4. A chat opens (session/new): models and modes; no prompt is sent ----
      const c = await studio.connect("antigravity", project);
      assert(c.sessionId, "session/new answered");
      const pub = JSON.stringify(c.public());
      assert(
        pub.includes('"model"') && pub.includes("gemini-"),
        "its models arrive: " + pub.slice(0, 300),
      );
      for (const mode of ["default", "accept-edits", "plan"]) {
        assert(pub.includes(`"${mode}"`), `mode ${mode}`);
      }
      await c.close();
    } finally {
      await studio.close().catch(() => {});
      for (const [k, v] of Object.entries(saved)) {
        v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      }
      try {
        Deno.removeSync(root, { recursive: true });
      } catch {
        /* a process may still hold a file; the OS temp cleanup gets it */
      }
    }
    assertEquals(
      [exists(owner), newest(owner)],
      ownerBefore,
      "the owner's ~/.gemini is untouched",
    );
  },
});
