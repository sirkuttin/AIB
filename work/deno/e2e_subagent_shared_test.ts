/**
 * Claude builders and the project's aib-shared/ (owner rule 2026-11-25, link design since 0.13): e2e with the REAL Claude Code adapter
 * against the stub model API (test auth guard: loopback base URL, dummy key, temp config). A worktree-isolated editing subagent has the
 * same aib-shared link as every provider (never a copy): it reads through it normally, and a SHELL write into it lands in the main
 * folder's real aib-shared/ at once. Claude Code's own fence refuses the Write and Edit tools there (before any hook runs), and every
 * write to the main folder outside aib-shared/ stays refused.
 */
import { assert, assertEquals, Chat, git, Json, waitFor } from "./_e2e.ts";
import {
  agentTempRoot,
  approveAll,
  CLAUDE_ACP,
  dumped,
  HAVE_KEEPER_BIN,
  join,
  keeperProgram,
  makeProject,
  NODE_EXE,
  OwnerUntouched,
  RealClaudeFixture,
  SERVER_SPLIT,
  Stub,
  stubText,
  T,
  Temp,
  uuid,
} from "./_e2e_real.ts";

const ok = !!(NODE_EXE && CLAUDE_ACP && HAVE_KEEPER_BIN);
const read = (p: string) => {
  try {
    return Deno.readTextFileSync(p);
  } catch {
    return null;
  }
};
// the subagent's own working folder, as Claude Code writes it into the request (JSON-escaped: the rule's capture fills it in as is)
const WT = 'Primary working directory: ((?:[^\\\\"]|\\\\\\\\)+?)\\\\n';

function rules(main: string) {
  const tool = (id: string, name: string, input: Json) => ({
    tools: [{ id, name, input }],
  });
  return [
    {
      when: "SR-PARENT",
      reply: tool("toolu_pAgent01", "Agent", {
        description: "sr shared",
        prompt: "SUBTASK-A: write the report",
        subagent_type: "general-purpose",
        run_in_background: false,
      }),
    },
    {
      when: "SUBTASK-A",
      reply: tool("toolu_s01", "Bash", {
        command: "pwd",
        description: "where am I",
      }),
    },
    {
      // the Write tool through the link: refused by Claude Code's fence
      when: "toolu_s01",
      capture: WT,
      reply: tool("toolu_s02", "Write", {
        file_path: "@CAP@\\aib-shared\\via-tool.txt",
        content: "via the Write tool\n",
      }),
    },
    {
      // a Read through the link is normal
      when: "toolu_s02",
      capture: WT,
      reply: tool("toolu_s03", "Read", {
        file_path: "@CAP@\\aib-shared\\seed.txt",
      }),
    },
    {
      // a shell write into the link path lands in the main folder's real aib-shared/ at once
      when: "toolu_s03",
      capture: WT,
      reply: tool("toolu_s05", "Bash", {
        command: 'echo from-bash > "@CAP@\\aib-shared\\bash.txt"; echo more >> "@CAP@\\aib-shared\\seed.txt"',
        description: "shell write",
      }),
    },
    {
      when: "toolu_s05",
      reply: tool("toolu_s06", "Write", {
        file_path: join(main, "aib-shared", "via-main.txt"),
        content: "via main path\n",
      }),
    },
    {
      when: "toolu_s06",
      reply: tool("toolu_s07", "Write", {
        file_path: join(main, "escape-write.txt"),
        content: "escaped\n",
      }),
    },
    {
      when: "toolu_s07",
      reply: tool("toolu_s08", "Write", {
        file_path: join(main, "aib-shared-old", "sneak.txt"),
        content: "sneak\n",
      }),
    },
    { when: "toolu_s08", reply: { text: "SUB-DONE" } },
    { when: "toolu_pAgent01", reply: { text: "PARENT-DONE" } },
  ];
}

Deno.test({
  name:
    "ClaudeSharedFolderTest test_builder_shell_writes_aib_shared_through_the_link_and_nothing_else_of_the_main_folder",
  ignore: !(ok && SERVER_SPLIT),
  ...T,
  async fn() {
    const mark = `srsh${uuid().slice(0, 6)}`;
    using temp = new Temp("aib-sh-");
    const project = makeProject(temp.path, mark);
    Deno.mkdirSync(join(project, "aib-shared"), { recursive: true });
    Deno.writeTextFileSync(join(project, "aib-shared", "seed.txt"), "seed\n"); // a file the project's shared folder already has
    using _own = new OwnerUntouched([mark]);
    await using stub = await Stub.start(temp.path, rules(project));
    temp.mkdir("tmp");
    await using fx = new RealClaudeFixture(stub, agentTempRoot(), {
      keeper: keeperProgram(),
      tmp: temp.join("tmp"),
    });
    const web = await fx.startWeb();
    const [status, connection] = await web.post("connect", {
      provider: "claude",
      cwd: project,
      background: true,
    });
    assertEquals(status, 200, JSON.stringify(connection));
    const chat = new Chat(null, connection.id as string, web);
    await waitFor(async () => {
      const s = await chat.state();
      if (s.error) throw new Error(String(s.error));
      return s.ready;
    }, "chat ready");
    const [code] = await web.post("prompt", {
      id: chat.id,
      text: "SR-PARENT go",
      clientMessageId: uuid(),
    });
    assertEquals(code, 200);
    await waitFor(
      async () => {
        await approveAll(chat);
        const state = await chat.state();
        return !state.busy && state.events.some((e) => e.kind === "turn_end");
      },
      "the parent turn to end",
      240,
    );
    const sent = dumped(stub);
    Deno.writeTextFileSync(
      Deno.env.get("SH_DEBUG_OUT") ?? join(temp.path, "dump.txt"),
      sent,
    );
    assert((stubText(stub) + sent).includes("PARENT-DONE"));
    const shared = join(project, "aib-shared");
    // a link, no copy: the shell write is in the main folder's real aib-shared/ at once (the worktree is the builder's, its link is not a copy)
    assertEquals(read(join(shared, "bash.txt"))?.trim(), "from-bash", "a shell write through the link");
    assertEquals(read(join(shared, "seed.txt")), "seed\nmore\n", "an existing shared file changed by a shell write");
    assertEquals(read(join(shared, "via-tool.txt")), null, "the Write tool is refused through the link (Claude Code's own fence)");
    assertEquals(read(join(shared, ".aib-seed.json")), null, "no seed note, no copy");
    // every other write to the main folder stays refused, whatever the path form
    assertEquals(read(join(shared, "via-main.txt")), null, "a Write by the main-folder path");
    assertEquals(read(join(project, "escape-write.txt")), null);
    assertEquals(read(join(project, "aib-shared-old", "sneak.txt")), null);
    assert(sent.includes("worktree"), "the refusals reached the model");
    // nothing of it is committed or shows in git
    assertEquals(git(project, "status", "--porcelain"), "");
    assert(!git(project, "ls-files").includes("aib-shared"));
  },
});
