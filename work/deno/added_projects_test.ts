/**
 * A project is in AIB only when the user adds it (server/desktop/added_projects.ts, server/web/project_routes.ts). Saved chats the
 * agents keep on disk (Claude Code's projects folder, OMP's sessions, the agent's own session list) show only for added projects.
 * Temp folders only: a temp state folder, a temp Claude projects folder and a temp OMP sessions folder; never the real ones.
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  AddedProjects,
  HISTORY_FILES,
} from "../../outputs/agent-studio/server/desktop/added_projects.ts";
import { projectKey } from "../../outputs/agent-studio/server/desktop/project_delete.ts";
import {
  makeContext,
  WebServer,
} from "../../outputs/agent-studio/server/web/server.ts";
import { openSource } from "../../outputs/agent-studio/server/transcripts/monitor.ts";
import type { LiveBackend } from "../../outputs/agent-studio/server/host/backend.ts";
import type { UpdateService } from "../../outputs/agent-studio/server/desktop/updater.ts";
import { git, HAVE_GIT } from "./_git_repo.ts";

type Json = Record<string, unknown>;
const SEP = Deno.build.os === "windows" ? "\\" : "/";
const j = (...parts: string[]) => parts.join(SEP);

async function tempRoot(): Promise<string> {
  return (await Deno.realPath(
    await Deno.makeTempDir({ prefix: "aib-added-projects-" }),
  )).replace(/^\\\\\?\\/, "");
}

/** One saved Claude Code chat in `cwd` (the encoded folder name is made up; AIB reads the cwd from the rows). */
function claudeChat(claude: string, id: string, cwd: string): void {
  const folder = j(claude, "enc-" + id);
  Deno.mkdirSync(folder, { recursive: true });
  const stamp = "2026-11-10T10:00:00Z";
  const rows = [
    {
      type: "user",
      sessionId: id,
      cwd,
      timestamp: stamp,
      message: { role: "user", content: `Work in ${id}` },
    },
    {
      type: "assistant",
      sessionId: id,
      cwd,
      timestamp: stamp,
      message: {
        role: "assistant",
        model: "m",
        content: [{ type: "text", text: "Done." }],
      },
    },
  ];
  Deno.writeTextFileSync(
    j(folder, id + ".jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

/** One saved OMP chat in `cwd`. */
function ompChat(omp: string, id: string, cwd: string): void {
  const folder = j(omp, "enc-" + id);
  Deno.mkdirSync(folder, { recursive: true });
  const rows = [
    { type: "session", id, cwd, timestamp: "2026-11-10T10:00:00Z" },
    { type: "message", message: { role: "user", content: `Work in ${id}` } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    },
  ];
  Deno.writeTextFileSync(
    j(folder, `2026-11-10T10-00-00-000Z_${id}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

/**
 * A Studio web server on a temp state folder with fake agent history in three folders (Alpha: Claude, Beta: Claude, Gamma: OMP)
 * and a stub agent host: connect answers like a real one, discover lists one session per folder.
 */
async function studio(
  options: { root?: string; seed?: (state: string) => void } = {},
) {
  const root = options.root ?? await tempRoot();
  const state = j(root, "state"),
    claude = j(root, "claude"),
    omp = j(root, "omp");
  const alpha = j(root, "work", "Alpha"),
    beta = j(root, "work", "Beta"),
    gamma = j(root, "work", "Gamma");
  for (const d of [state, claude, omp, alpha, beta, gamma]) {
    Deno.mkdirSync(d, { recursive: true });
  }
  if (!options.root) {
    claudeChat(claude, "chat-alpha", alpha);
    claudeChat(claude, "chat-beta", beta);
    ompChat(omp, "chat-gamma", gamma);
  }
  options.seed?.(state);
  const connections: Json[] = [];
  const host = {
    hostMode: "test",
    liveInfo: () => Promise.resolve({ connections, instanceId: "test" }),
    liveList: () => Promise.resolve({ connections, recovered: [] }),
    liveState: () => Promise.resolve({}),
    liveCall: (op: string, body: Json) => {
      if (op === "connect") {
        const c = {
          id: "live-" + connections.length,
          provider: body.provider,
          cwd: body.cwd,
          projectRoot: body.cwd,
          sessionId: "s",
        };
        connections.push(c);
        return Promise.resolve([200, c]);
      }
      if (op === "discover") {
        return Promise.resolve([200, {
          supported: true,
          sessions: [alpha, beta, gamma].map((cwd, i) => ({
            sessionId: `listed-${i}`,
            cwd,
            title: "t",
          })),
          nextCursor: null,
        }]);
      }
      return Promise.resolve([200, { ok: true }]);
    },
    emitArtifact: () => Promise.resolve(true),
  } as unknown as LiveBackend;
  const ctx = makeContext({
    stateDir: state,
    host,
    updates: {} as UpdateService,
    webInstanceId: "test",
    cliPort: 0,
    transcripts: await openSource(omp, claude),
    claudeProjects: claude,
    ompSessions: omp,
    shutdown: () => {},
  });
  const web = new WebServer(ctx);
  const port = await web.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const get = async (path: string): Promise<Json> => {
    const r = await fetch(origin + path, {
      headers: { "X-Studio-Token": ctx.token },
    });
    const body = await r.json();
    assertEquals(r.status, 200, `${path}: ${JSON.stringify(body)}`);
    return body;
  };
  const post = async (name: string, body: Json): Promise<Json> => {
    const r = await fetch(`${origin}/api/live/${name}`, {
      method: "POST",
      headers: {
        "X-Studio-Token": ctx.token,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify(body),
    });
    const out = await r.json();
    assertEquals(r.status, 200, `${name}: ${JSON.stringify(out)}`);
    return out;
  };
  /** The folders of the saved chats AIB lists (what the page builds its projects and chats from). */
  const listed = async () =>
    ((await get("/api/sessions")).sessions as Json[]).map((s) =>
      s.cwd as string
    ).sort();
  const added = async () =>
    Object.values(
      (await get("/api/live/project-prefs")).added as Record<
        string,
        { path: string }
      >,
    ).map((a) => a.path).sort();
  return {
    root,
    state,
    claude,
    omp,
    alpha,
    beta,
    gamma,
    ctx,
    get,
    post,
    listed,
    added,
    connections,
    close: async (keep = false) => {
      await web.close();
      if (!keep) await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("a fresh data folder with agent history in three folders: no projects and no chats are shown", async () => {
  const s = await studio();
  try {
    assertEquals(await s.listed(), []);
    assertEquals(await s.added(), []);
    assertEquals((await s.get("/api/live/project-prefs")).addedStart, "fresh");
    // the agent's own session list ("Find more chats via agent") lists nothing either, and adds nothing
    assertEquals(
      ((await s.post("discover", { provider: "claude" })).sessions as Json[])
        .length,
      0,
    );
    assertEquals(await s.added(), []);
    // nothing on disk was changed: the three transcripts are all still there
    assertEquals(
      [...Deno.readDirSync(s.claude)].length +
        [...Deno.readDirSync(s.omp)].length,
      3,
    );
  } finally {
    await s.close();
  }
});

Deno.test("adding one project shows it and its saved chats; the other two folders stay out", async () => {
  const s = await studio();
  try {
    const reply = await s.post("project-add", { path: s.alpha });
    assertEquals(Object.keys(reply.added as Json), [projectKey(s.alpha)]);
    assertEquals(await s.listed(), [s.alpha]);
    assertEquals(
      ((await s.post("discover", { provider: "claude" })).sessions as Json[])
        .map((x) => x.cwd),
      [s.alpha],
    );
    // an OMP chat's folder works the same way
    await s.post("project-add", { paths: [s.gamma] });
    assertEquals(await s.listed(), [s.alpha, s.gamma].sort());
    assertEquals(await s.added(), [s.alpha, s.gamma].sort());
  } finally {
    await s.close();
  }
});

Deno.test("starting a chat in a new folder adds it as a project", async () => {
  const s = await studio();
  try {
    assertEquals(await s.listed(), []);
    await s.post("connect", { provider: "claude", cwd: s.beta });
    assertEquals(await s.added(), [s.beta]);
    assertEquals(await s.listed(), [s.beta]); // its older saved chat shows too
  } finally {
    await s.close();
  }
});

Deno.test("removing a project takes it off the list, and its saved chats do not bring it back", async () => {
  const s = await studio();
  try {
    await s.post("project-add", { paths: [s.alpha, s.beta] });
    assertEquals(await s.listed(), [s.alpha, s.beta].sort());
    await s.post("project-remove", {
      path: s.beta,
      disk: false,
      projects: [s.alpha],
    });
    assertEquals(await s.added(), [s.alpha]);
    assertEquals(await s.listed(), [s.alpha]);
    // a restart: the same data folder, nothing comes back
    await s.close(true);
    const again = await studio({ root: s.root });
    try {
      assertEquals(await again.listed(), [s.alpha]);
      assertEquals(await again.added(), [s.alpha]);
      assert(
        Deno.statSync(s.beta).isDirectory,
        "the folder itself is kept (Delete project without the disk box)",
      );
    } finally {
      await again.close(true);
    }
  } finally {
    await Deno.remove(s.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("existing user: every project visible before is kept, once; later history does not become a project", async () => {
  // An AIB that was used before this version: it has studio-conversations.json (a pinned chat) and a removed project.
  let alphaPath = "";
  const s = await studio({
    seed: (state) => {
      Deno.writeTextFileSync(
        j(state, "studio-conversations.json"),
        JSON.stringify({ version: 1, entries: {} }),
      );
      alphaPath = j(state, "..", "work", "Alpha");
    },
  });
  try {
    await s.ctx.removedProjects.remove(s.gamma); // "Delete project…" before this version: it stays gone
    assert(alphaPath);
    assertEquals(await s.listed(), [s.alpha, s.beta].sort());
    assertEquals(await s.added(), [s.alpha, s.beta].sort());
    assertEquals(
      (await s.get("/api/live/project-prefs")).addedStart,
      "existing",
    );
    const file = JSON.parse(
      Deno.readTextFileSync(j(s.state, AddedProjects.FILE)),
    );
    assertEquals(file.start, "existing");
    // new agent history in another folder after the migration: not a project, not listed (it ran once)
    const delta = j(s.root, "work", "Delta");
    Deno.mkdirSync(delta, { recursive: true });
    claudeChat(s.claude, "chat-delta", delta);
    await s.close(true);
    const again = await studio({ root: s.root });
    try {
      assertEquals(await again.listed(), [s.alpha, s.beta].sort());
      assertEquals(await again.added(), [s.alpha, s.beta].sort());
    } finally {
      await again.close(true);
    }
  } finally {
    await Deno.remove(s.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("existing-user detection: any AIB history file; none means a fresh start; decided once", async () => {
  for (const name of HISTORY_FILES) {
    const root = await tempRoot();
    try {
      Deno.writeTextFileSync(j(root, name), "{}");
      const store = new AddedProjects(root);
      assert(store.needsMigration, name);
      store.collect = () => Promise.resolve([j(root, "p")]);
      await store.ready();
      assertEquals(store.public().start, "existing");
      assertEquals(Object.values(store.public().added).map((a) => a.path), [
        j(root, "p"),
      ]);
      // a second start never migrates again
      const next = new AddedProjects(root);
      let asked = 0;
      next.collect = () => (asked++, Promise.resolve([j(root, "q")]));
      await next.ready();
      assertEquals([
        asked,
        next.needsMigration,
        Object.keys(next.public().added).length,
      ], [0, false, 1]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }
  const root = await tempRoot();
  try {
    Deno.writeTextFileSync(j(root, "studio-view.json"), "{}"); // written at every start: not history
    const store = new AddedProjects(root);
    assert(!store.needsMigration);
    store.collect = () =>
      Promise.reject(new Error("a fresh start does not collect"));
    await store.ready();
    assertEquals([
      store.public().start,
      Object.keys(store.public().added).length,
    ], ["fresh", 0]);
    assert(!store.shows(j(root, "anything")));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("a failed migration writes nothing and filters nothing; the next call tries again", async () => {
  const root = await tempRoot();
  try {
    Deno.writeTextFileSync(j(root, "studio-projects.json"), "{}");
    const store = new AddedProjects(root);
    store.collect = () => Promise.reject(new Error("transcripts unreadable"));
    let failed = false;
    await store.ready().catch(() => (failed = true));
    assert(failed);
    assert(
      store.shows(j(root, "x")),
      "nothing is hidden while the list could not be made",
    );
    let written = true;
    try {
      Deno.statSync(j(root, AddedProjects.FILE));
    } catch {
      written = false;
    }
    assert(!written, "no list file after a failed migration");
    store.collect = () => Promise.resolve([j(root, "x")]);
    await store.ready();
    assert(store.shows(j(root, "x")) && !store.shows(j(root, "y")));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name:
    "worktree chats under an added project show; adding a worktree folder adds its main checkout",
  ignore: !HAVE_GIT,
  async fn() {
    const s = await studio();
    try {
      git(s.alpha, "init", "-q");
      Deno.writeTextFileSync(j(s.alpha, "a.txt"), "a\n");
      git(s.alpha, "add", "-A");
      git(s.alpha, "commit", "-q", "-m", "base");
      const wt = j(s.root, "elsewhere", "alpha-wt");
      git(s.alpha, "worktree", "add", "-q", "-b", "side", wt);
      claudeChat(s.claude, "chat-alpha-wt", wt);
      assertEquals(await s.listed(), []);
      await s.post("project-add", { path: s.alpha });
      assertEquals(await s.listed(), [s.alpha, wt].sort());
      // a chat started in the worktree folder adds the main checkout, not the worktree
      await s.post("project-remove", {
        path: s.alpha,
        disk: false,
        projects: [],
      });
      assertEquals(await s.listed(), []);
      await s.post("connect", { provider: "claude", cwd: wt });
      assertEquals((await s.added()).map((p) => projectKey(p)), [
        projectKey(s.alpha),
      ]);
      assertEquals(await s.listed(), [s.alpha, wt].sort());
    } finally {
      await s.close();
    }
  },
});

Deno.test("a Claude Code worktree folder belongs to its repository even after the folder is gone", () => {
  const store = new AddedProjects(null);
  const repo = j("C:", "gone", "repo");
  assertEquals(
    store.projectFolder(j(repo, ".claude", "worktrees", "feature-x")),
    repo,
  );
  assertEquals(
    store.projectFolder(j(repo, ".claude", "worktrees", "feature-x", "src")),
    repo,
  );
  assertEquals(store.projectFolder(j(repo, "plain")), j(repo, "plain"));
});
