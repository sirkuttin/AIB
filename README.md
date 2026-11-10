# AIB — Agent Integration Bay

*(say "Abe")*

**All your agents. One place. Nothing hidden.**

AIB, the **Agent Integration Bay**, is one desktop app for all your coding agents (Claude Code, Codex, OMP) across all
your projects. It talks to each agent through ACP (the Agent Client Protocol), so questions, approvals, plans, subagents
and background commands show up as real things you can see and act on, not terminal noise. It runs on your computer: no
account, no telemetry, and your data stays with you.

> **Beta: 0.1.0-beta.2.** Builds are not code-signed. Expect rough edges.
> Independent project; not affiliated with Anthropic or OpenAI.

## What it does

- **Many chats at once.** Several agents and conversations side by side, with streaming text, tool calls and diffs, plans,
  approvals and questions.
- **One list for everything.** Chats you start in AIB and your saved Claude Code and OMP conversations, with search (Ctrl+K).
- **One copy per chat.** *"A chat divided against itself cannot stand."* In a git project, each chat works in its own
  worktree on its own branch, so two agents never overwrite each other. The **Changes** view brings a chat's work back into
  your project when you're ready. Always on in a git project; there is no switch for it.
- **Agents keep running.** Agents live in a separate background process (the *agent host*), so closing, restarting or
  updating the app doesn't cut off a turn.
- **Agent setup built in.** AIB installs its own copy of the Claude Code and Codex adapters and runs each agent's own
  sign-in. It never asks for a password or API key.
- **Artifacts.** Pages and files agents make are shown next to the chat, on their own origin, apart from the app.
- **A real desktop app** for Windows, macOS and Linux (x64 and arm64), with automatic, checksum-verified updates.

## Get it

Download the file for your system from the [releases page](https://github.com/sirkuttin/AIB/releases):

- **Windows:** unzip anywhere (no admin needed) and run `AIB\AIB.exe`. SmartScreen warns because the app isn't signed:
  choose **More info**, then **Run anyway**. The first run adds AIB to the Start menu.
- **macOS:** unzip, move `AIB.app` to Applications, then right-click it and choose **Open** the first time.
- **Linux:** the AppImage (`chmod +x`, then run it) or the `.deb` (`sudo apt install ./AIB-…deb`).

You also need **Node.js 22 or newer** (the agent adapters are small Node programs). The first page sets up your agents: install or
link Claude Code and Codex, sign in, pick a project folder, and start a chat.

## Security model

- **Local only.** The server and the agent host listen on `127.0.0.1` only. No telemetry, no remote scripts or fonts.
- **Page token.** Every change needs a random per-process token that only the page AIB served receives, plus same-origin
  checks, so other websites can't drive it. The agent host has its own token in a user-only file.
- **Agents own their sign-in.** AIB never reads, stores or sends their credentials.
- **Agents use their own tools.** They run with your account's normal permissions; AIB refuses agents' terminal and file
  requests unless you turn them on.

## Run from source

AIB is TypeScript on [Deno](https://deno.com) (pinned to 2.9.8), with a plain-JavaScript page.

```text
cd outputs/agent-studio
deno run -A server/main.ts --open
```

It opens at `http://127.0.0.1:8767` and starts (or attaches to) the agent host. Other commands:

```text
deno run -A server/main.ts --in-process      # agents inside the web server (tests, debugging)
deno run -A server/main.ts --stop-host       # stop the agent host (refuses while chats work, unless --force)
deno run -A server/main.ts deploy [--host]   # restart without cutting off a turn
```

The desktop app and a source run share one data folder (`%LOCALAPPDATA%\AgentStudio` on Windows). Run one at a time, or
give the source run its own `--state-dir`.

## Build the desktop app

All six targets (Windows, macOS, Linux × x64, arm64) build from one Windows machine with `deno desktop`:

```text
deno run -A tools/build.ts --targets all --out dist
```

It writes the zips, AppImages and `.deb`s plus `SHA256SUMS`, checks sizes, and starts the app once headless to make sure it
serves the page. Releases are built this way and uploaded by hand; no CI.

## Repository layout

| Path | What's there |
| --- | --- |
| `outputs/agent-studio/server/` | The app. `main.ts` is the entry point; `web/` routes and security, `host/` the agent host, `acp/` the ACP connection, `state/` the data files, `transcripts/` saved chats, `worktrees/` one copy per chat, `artifacts/`, `agents/`, `ownership/`, `desktop/` (window, tray, updater), `platform/` all OS-specific code. |
| `outputs/agent-studio/*.js, *.css, *.html` | The page. |
| `outputs/agent-studio/icons/` | The app icon in every size the packages need, rendered from the SVG masters in `icons/src/` by `tools/make_icons.ts`. |
| `tools/` | `build.ts` (the six-target build) and `linux_package.ts`. |
| `work/deno/` | Deno unit tests, and parity tests that compare against the Python reference. |
| `work/contract/` | HTTP-only contract tests. |
| `work/python-reference/` | The original Python server, kept only as the reference the parity and contract tests compare against. |
| `work/` | Node page tests, the worktree end-to-end suite, and the fake ACP agents the tests use. |

## Develop

```text
cd outputs/agent-studio
deno task test        # unit and parity tests (parity needs Python)
deno task check       # type check
deno task lint
```

From the repository root: `npm test` and `npm run lint` for the page, and
`python -m unittest discover -s work/contract` for the contract tests. The worktree end-to-end suite runs from `work/`:
`python -m unittest test_worktree_e2e`. `AIB_SERVER` picks the server for both (`deno-split` by default, `deno` for
in-process, `python` for the reference). Tests use temporary data folders and never touch your real one or your
`~/.claude`.

## License

[GNU AGPL-3.0](LICENSE).
