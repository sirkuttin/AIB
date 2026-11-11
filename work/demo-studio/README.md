# Demo Studio

A throwaway Agent Studio with fake chats, for testing by hand or with a QA agent. No model calls, no real agents,
and nothing from your real Studio state (`work/agent-studio-state`) or real `~/.claude` transcripts.

## Start and stop

```
python work/demo-studio/start.py --port 8810            # fresh data, starts Studio in the background
python work/demo-studio/start.py --port 8810 --keep     # reuse the data from the last run if it is still there
python work/demo-studio/start.py --stop --port 8810     # stop it and delete the temp folder
python work/demo-studio/start.py --stop --port 8810 --keep   # stop it, keep the data
```

It prints the URL (`http://127.0.0.1:8810/chat.html`) and the PID. Works the same in Git Bash and PowerShell.
Everything lives in `<temp>/agent-studio-demo-<port>` (use `--dir` to choose another parent folder; the PID file and
`studio.log` are in it). Ports 8766-8768 and 8776-8778 are refused: 8767/8768 are the live Studio, 8777/8778 the AIB
desktop app, and Studio uses port+1 for its artifact server. The demo needs `<port>` and `<port>+1` free.

The server is the Deno app: `deno run -A outputs/agent-studio/server/main.ts serve`, started in the background with no
console window. `start.py` finds Deno as `AIB_DENO`, else `deno` on PATH, and stops with a message when there is none.
Studio runs in-process (`--in-process --no-auto-reconnect --no-owner-announcements`). The fixture agent
(`work/demo-studio/agent.py`) is both the Claude launcher (`--node-command` is the current Python) and the OMP command
(a tiny `omp.cmd` / `omp` launcher in the demo folder), so either agent in "New chat" works.

Set `AIB_DEMO_MODELS=1` before starting to give the fixture agent a long model list (16 models), three modes with
descriptions and an effort setting, for checking the composer chip menus.

Keep the demo folder out of paths containing `.claude/worktrees` or `scratch-*`: Studio hides those folders from
"All chats", which makes the sidebar look empty (this was the "No saved conversations yet" problem). `start.py` refuses
such a location and tells you to pass `--dir`.

## What is in it

| Project | Chat | What it shows |
| --- | --- | --- |
| alpha (git repo, uncommitted changes) | Add rate limiting to the API | **Pinned.** Long: tool calls with descriptions, TodoWrite task list, `mcp__ccd_turn__update_plan`, a background command, "Async agent launched", a `mcp__ccd_turn__wrap_up` next step, a failing test round. Has one artifact ("Rate limits"). |
| alpha | Live chat: try the fixture agent | Short. The one to send messages in; shares the folder with the chat above. |
| alpha/docs (a sub-folder, so Studio lists it as its own project row) | Document the config options | A pasted picture, and a tool screenshot. |
| beta (git repo, clean) | Draft the 2.0 release notes | Task list advancing, then a next step. |
| beta | Old spike: try the legacy parser | **Archived.** |

Project alpha has `app.py` modified and `limits.py` new, so the Changes tab has two files (+14 -0). Any saved chat can
be opened and continued: sending a message resumes it with the fixture agent.

## Trigger words

Send one of these alone as the whole message to a chat the fixture agent runs:

| Word | What happens |
| --- | --- |
| `stream` | Five messages, 0.7 s apart, then the turn ends |
| `html` | Writes `outputs/demo-page.html` in the chat's folder (version number goes up each time); it appears as an artifact card and in the Artifacts tab |
| `plan` | Sends a task list (Activity / plan view) |
| `help` | Lists these words |
| `approve` | Asks you to allow a tool; the turn ends after you answer |
| `form` | Asks a question with a form |
| `url` / `url-complete` | A sign-in link request |
| `wait` | Never answers until you press Stop |
| `sleep:5` | Works for 5 seconds, then ends |
| `delegate` | Announces a background agent (subagent panel) |
| `child-ask` | A background agent asks for approval |
| `leave-open` / `agent-cancel` | A request left pending / withdrawn by the agent |
| `mcp` | Shows the MCP servers Studio gave the chat |
| `/compact` | A compaction |
| anything else | A rich reply: markdown, table, code, tool calls with diffs, links |
| attach a picture | The agent says which image types it received |

`stream`, `html`, `plan` and `help` only exist with `--demo` (set by `work/demo-studio/agent.py`); the other words
are the existing fixture behaviours in `work/fake_acp.py`.

## Notes for a QA agent

- State is under `<demo>/state`; the owner's real state is never read or written.
- The artifact is published through Studio's own API at start-up (`/api/live/artifacts/publish`).
- `--keep` keeps the artifact and any chats you resumed; without it every start is fresh.

## README screenshots

`readme_shots.py` builds a second, realistic demo (projects storefront and billing-api, chats from Claude Code, Codex and
the Beta agent OpenCode) for the README pictures, using `showcase_agent.py` as every agent. See the top of
`readme_shots.py` for the chats, `--release rounding|csv` to let a held turn finish, and `--stop`. Data goes in
`<temp>/aib-readme-<port>`.
