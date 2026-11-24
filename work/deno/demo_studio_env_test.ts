/**
 * The demo Studio (work/demo-studio/start.py) never reads the owner's real agent folders: the server process it starts gets a home
 * folder and every agent folder (CODEX_HOME, CLAUDE_CONFIG_DIR, VIBE_HOME, XDG_*) inside its own temp folder, so the usage-limits
 * chip (server/agents/codex_limits.ts codexHome, usage_limits.ts accountKey) and the sign-in check read fixture folders only.
 * start() runs for real except that the server process is not started: subprocess.Popen is replaced to capture what it is given.
 */
import { assert, assertEquals } from "./_assert.ts";
import { HAVE_GIT } from "./_git_repo.ts";
import { PYTHON } from "./_connection.ts";
import { pickPort } from "./_ports.ts";
import { codexHome } from "../../app/server/agents/codex_limits.ts";

const SCRIPT = `
import json, pathlib, sys
sys.path.insert(0, 'work/demo-studio')
import start
seen = {}
class FakeProcess:
    pid = 424242
    def poll(self):
        return None
real_popen = start.subprocess.Popen
def fake_popen(command, *args, **kwargs):
    if command[0] != 'deno':
        return real_popen(command, *args, **kwargs)
    seen['command'] = command
    seen['env'] = kwargs.get('env')
    return FakeProcess()
start.subprocess.Popen = fake_popen
start.port_busy = lambda port: False
start.wait_ready = lambda port, process, timeout: True
start.publish_artifact = lambda port, session, demo: True
start.stop_studio = lambda port, folder: []
start.deno_executable = lambda: 'deno'
code = start.start(start.parse_args(['--port', sys.argv[2], '--dir', sys.argv[1]]))
print(json.dumps({'code': code, 'env': seen.get('env'), 'command': seen.get('command')}))
`;

Deno.test({
  name:
    "the demo Studio's server environment points every agent folder at fixture folders in the demo's temp folder",
  ignore: !HAVE_GIT,
  async fn() {
    const parent = Deno.realPathSync(
      Deno.makeTempDirSync({ prefix: "aib-demo-env-" }),
    );
    const port = pickPort(true); // never opened (Popen is replaced): only names the demo folder
    try {
      const out = await new Deno.Command(PYTHON, {
        args: ["-c", SCRIPT, parent, String(port)],
        cwd: "..",
        env: { PYTHONDONTWRITEBYTECODE: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(out.stdout);
      assert(out.success, new TextDecoder().decode(out.stderr) + text);
      const got = JSON.parse(text.trim().split("\n").at(-1)!);
      assertEquals(got.code, 0);
      const env = got.env as Record<string, string>;
      assert(env, "start() gives the server process its own environment");
      const sep = Deno.build.os === "windows" ? "\\" : "/";
      const home = `${parent}${sep}agent-studio-demo-${port}${sep}home`;
      const norm = (
        p: string,
      ) => (Deno.build.os === "windows"
        ? p.toLowerCase().replaceAll("/", "\\")
        : p);
      const inside = (p: string) =>
        norm(p) === norm(home) || norm(p).startsWith(norm(home) + sep);
      for (
        const name of [
          "HOME",
          "USERPROFILE",
          "CODEX_HOME",
          "CLAUDE_CONFIG_DIR",
          "VIBE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
          "XDG_CACHE_HOME",
        ]
      ) {
        assert(
          env[name] && inside(env[name]),
          `${name} = ${env[name]} is not in ${home}`,
        );
        assert(Deno.statSync(env[name]).isDirectory, `${name} folder exists`);
      }
      // what the usage-limits chip reads: <CODEX_HOME> (sessions, auth.json), never the owner's ~/.codex
      const ownerHome =
        Deno.env.get(Deno.build.os === "windows" ? "USERPROFILE" : "HOME") ??
          "";
      const codex = codexHome(env)!;
      assert(inside(codex), codex);
      if (ownerHome) {
        for (const real of [".codex", ".claude", ".vibe"]) {
          assert(
            !Object.values(env).some((v) =>
              norm(String(v)) === norm(`${ownerHome}${sep}${real}`)
            ),
            `no variable names the owner's ${real}`,
          );
        }
        assert(
          norm(env.HOME) !== norm(ownerHome) &&
            norm(env.USERPROFILE) !== norm(ownerHome),
          "the home folder is the demo one",
        );
      }
      // the fixture folders start empty: no sessions, no sign-in
      assertEquals([...Deno.readDirSync(codex)].length, 0);
      assertEquals([...Deno.readDirSync(env.CLAUDE_CONFIG_DIR)].length, 0);
      // git commits in the demo as Demo, from the demo's own ~/.gitconfig
      assert(
        Deno.readTextFileSync(`${home}${sep}.gitconfig`).includes(
          "demo@example.invalid",
        ),
      );
      // Deno keeps the owner's package cache (moving HOME must not make it download again)
      assert(
        env.DENO_DIR && !inside(env.DENO_DIR),
        "DENO_DIR = " + env.DENO_DIR,
      );
    } finally {
      Deno.removeSync(parent, { recursive: true });
    }
  },
});
