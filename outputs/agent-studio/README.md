# Agent Studio — standalone ACP client

Run `deno run -A server/main.ts --open` from this folder (Deno 2.x). The default address is **http://127.0.0.1:8767**. Node.js and the agent adapters you want to use are required (see Installing the agents below). No editor or other agent app needs to be running. The desktop app (a native window, tray icon and updater around the same server) is described in [docs/DESKTOP.md](docs/DESKTOP.md).

The home page is the unified chat interface. Its sidebar lists saved OMP and Claude Code conversations alongside Studio-owned connections, with a Ctrl+K quick switcher for search. Select a saved conversation to view its history, agents, and background commands in place. Resume in Studio loads an idle saved chat when the agent supports it. New conversation starts a fresh chat. Existing sign-ins and agent configuration are used.

Connected in Studio and Working in Studio are confirmed connection states. Saved sessions show their latest saved activity; that does not prove whether another client is still running them. Stop a chat in its other client before using Resume in Studio. Browsing saved history never connects to or interrupts that agent.

## Included

- Independent ACP stdio connections, new conversations, streaming text and thinking, tool details, plans, and approval choices supplied by the agent.
- Mode/config selectors when the agent advertises them. A change made while the agent is working is queued by the agent host and applied when the turn ends; the Model chip shows the model the replies really come from (read from the agent's own transcript) and warns when the agent advertises another. See [docs/models-and-settings.md](docs/models-and-settings.md).
- Live main/subagent streams when the adapter sends them, plus the persisted transcript and background commands.
- Interrupt the active turn, disconnect an owned connection, or keep several connections running and switch between them.
- Browser refresh reconnects to the same locally running connection. Closing a browser tab does not stop the server or its agents.
- Optional session loading by ID when the agent advertises support. Resume only idle saved sessions; this is not an attachment to a connection already owned by another app.

## Launch options

Unknown flags fail with usage. Run from `outputs/agent-studio`:

```text
deno run -A server/main.ts --port 8767 --open                      the web server (it starts the agent host)
deno run -A server/main.ts --omp-command C:\path\to\omp.exe --node-command C:\path\to\node.exe --claude-launcher C:\path\to\claude-agent-acp\dist\index.js
deno run -A server/main.ts --in-process                            web server and agents in one process (tests, debugging)
deno run -A server/main.ts --stop-host [--force]                   ask the agent host to stop
deno run -A server/main.ts deploy [--host] [--wait]                restart a running server without cutting off a turn
deno task build                                                    the desktop packages (tools/build.ts; see docs/DESKTOP.md)
```

Flags: `--port`, `--state-dir`, `--omp-sessions`, `--claude-projects`, `--owners-dir`, `--omp-command`, `--node-command`, `--claude-launcher`, `--codex-launcher`, `--mcp-config`, `--enable-client-terminal`, `--enable-client-fs[=read]`, `--no-artifact-tool`, `--no-auto-reconnect`, `--no-owner-announcements`, `--host-idle-minutes`, `--log-level`, `--migrate-from`, `--open`, `--in-process`, `--stop-host`, `--force`.

### Installing the agents

Studio talks to each agent through a small adapter program and looks for it on this computer. Nothing is bundled and no personal path is assumed.

- **Claude Code:** run `npm i -g @agentclientprotocol/claude-agent-acp`. Studio finds the installed package in npm's global folder and runs its `dist/index.js` with Node. Sign in once with Claude Code's own tools.
- **Codex:** run `npm i -g @zed-industries/codex-acp`. A `codex-acp` program on PATH also works. Until it is installed, Codex shows "Not installed" in Settings and in the agent list instead of failing.
- **OMP:** install OMP so `omp` is on PATH. On Windows Studio also checks `%LOCALAPPDATA%\omp\omp.exe`.

For Claude Code and Codex the launcher is chosen in this order: the `--claude-launcher` / `--codex-launcher` flag, then a launcher saved in Settings (`launchers` in the settings file), then the installed adapter. A launcher is a JavaScript file that Node runs. Settings, under Agents, shows which launcher each agent uses.

On macOS and Linux, Studio asks your login shell for its PATH once at startup (`$SHELL -l -c`, 3 second limit, falling back to the PATH it was started with), so programs are found even when Studio is started from a desktop app. This does nothing on Windows.

Environment values you give an added agent are kept in the state folder and are never shown again in Settings or sent to the page; to change one, type a new value (leave it blank to keep the old one).

## Lifecycle and limits

**Two processes.** `deno run -A server/main.ts` serves the page and APIs (the *web server*) and finds or starts a separate, long-lived *agent host* for the same `--state-dir`; the host owns the adapter processes, event history, approvals, leases and owner announcements. Restarting the web server (to deploy a code change) therefore does not affect a running turn: reload the page and the same conversations are still there, streaming. Restart the host only when the agent-side code changes: `main.ts deploy --host` waits until nothing is working, stops the host and restarts the web server, while plain `main.ts deploy` restarts just the web server and does not wait. `main.ts --stop-host` stops the host (it refuses while turns are running unless `--force`); a host with no conversations and no web server attached exits by itself after 30 minutes (`--host-idle-minutes`). `--in-process` runs everything in one process (tests, debugging). A Python agent host left by an older AIB version is taken over once no chat works in it; this server never starts one. Design, security and failure modes: [docs/agent-host.md](docs/agent-host.md).

Ctrl+C on the web server leaves the agents running in the host; stopping the host (or Ctrl+C in `--in-process` mode) shuts down owned ACP connections. Disconnect/Interrupt do not guarantee that background commands or background subagents are stopped; ACP adapters can leave background work running. Saved conversations remain in the agent's own storage. After a host restart, conversations that were open in Studio reconnect automatically in the background (status "Reconnecting…"; chats another app may be using are skipped; `--no-auto-reconnect` disables it); a message whose delivery could not be confirmed is never resent automatically. Recovery is kept per host (per `--state-dir`; per `--port` with `--in-process`).

Supported: text, picture and file prompts (attach, paste or drag; text files are embedded or inlined, PDFs and other binaries only where the agent accepts embedded content; click any picture to view it full size); Markdown replies; tool-call views with diffs; resource links; questions (forms and web-page links), including during connection setup; sign-in method discovery (in-app where the agent supports it, otherwise instructions only); `/` command suggestions; mode and config controls; usage/title/notice status strip; advertised session list/close/delete; agent-side session discovery; subagent Stop where the adapter advertises it; your own MCP servers via `--mcp-config`. Every message from the agent is checked against ACP v1; malformed ones are logged and ignored. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the full matrix.

Not supported: custom extension widgets, voice, and ACP v2 (see [docs/acp-v2-evaluation.md](docs/acp-v2-evaluation.md)). No parity with every IDE client feature is claimed.

**Off by default.** By default agents use their own tools, and Studio refuses terminal and file requests. `--enable-client-terminal` and `--enable-client-fs[=read]` let agents run commands and read/write files through Studio, confined to the conversation's workspace folder. Commands still run with your normal permissions and writes are not approved one by one; read [docs/client-capabilities.md](docs/client-capabilities.md) before turning them on.

These features were tested against a fake agent. Sign-in, web-page questions, the stricter message checks and session operations have not yet been tried against the real adapters.

The web server binds only to loopback; so does the agent host, which also requires its own random token (kept in a user-only file under `--state-dir`) on every call. Write actions require a random per-process token and same-origin checks. No remote scripts, fonts, telemetry, or public hosting are used. Agent actions run with your account's normal permissions. Do not expose the server through a public tunnel.

## Conversation workspace

The conversation list stays on the far left. Selecting a conversation opens its main chat in the center. Its subagent list appears on the right and excludes the main agent; selecting a subagent opens a separate read-only transcript farther right. On narrower windows, the subagent transcript is a dismissible side panel. The main chat stays in place. The Activity column includes Running commands and Subagents. Subagents are split into Working and Finished (collapsed by default when there are more than three; the choice is remembered per conversation). Saved-only subagents that were written to in the last 90 seconds and show no completion marker are labelled "Probably running", not confirmed. Failed ones sort first in Finished. Click a command for its command line, owner, timing, and latest saved output in the far-right inspector, without replacing the main chat. Show history includes finished or unresolved jobs; the default running list excludes them.

Text in every message can be selected and copied with Ctrl+C. Each message, tool row and code block also has a Copy button with a format menu: Markdown (the source), Teams / Outlook (rich HTML plus plain text, generated from escaped content only) or plain text; the last choice is remembered in this browser, and tool calls open as readable commands, file paths, diffs and key/value lists instead of raw JSON (Raw JSON stays under each one).

**Projects, status and switching.** The sidebar opens on **All chats** (there is no vendor filter: the vendor shows in the chat header) and groups conversations by project, meaning the workspace folder: case, slashes and trailing separators are normalised, the folder's last segment is the name (a parent segment is added when two folders share a name) and the full path is the tooltip. Groups collapse (remembered per browser), show a count and the most urgent state of their conversations, and are ordered by recent activity. Sections run Pinned, Chats N, On hold N (collapsed by default) and Archived N; pinned chats keep their place in the project list too (marked with a star), on-hold chats appear only under On hold. Inside one project the list is flat. A single full-width **Find chat... Ctrl+K** button under the list title opens the switcher. Each row has a status dot with an accessible label: working (animated unless reduced motion is requested), needs you (with the number of pending questions, approvals and sign-ins), finished and not viewed yet (a turn ended after you last opened that conversation; last-viewed times live in this browser), live and idle, or no dot for saved. It reads `attention` from `/api/live/list` and falls back to the connection's own `busy` and `state` fields. The tab title shows `(n)` while anything needs you. **Ctrl+K** opens a quick switcher with fuzzy search over titles, aliases, project names and vendors, archived chats last; arrows and Enter open one. **Alt+Up / Alt+Down** go to the previous or next conversation in the visible sidebar order and **Ctrl+Shift+N** (also Alt+N, because browsers reserve the former) starts a conversation in the current project; these two do nothing while you type in a text field. Titles are cleaned on the server: system reminders, slash-command wrappers and continuation boilerplate are skipped, markup is stripped, and a title the agent or Claude wrote (custom title, AI title, summary) is preferred over the first message. A Rename alias always wins.

**Project workspace (Concept A).** A narrow rail on the far left lists your projects (the workspace folders above) (unique two-letter initials, one colour each, dimmed unless active) with an amber badge for chats that need you or a pulsing blue dot while something is working. The first rail button is the **needs-you inbox** (an envelope with the amber count); below its divider an icon button shows **all chats** (the mockup has no All, but the grouped all-chats list is the only view of every project at once, so it stays as a quiet icon), and a dashed **+** at the bottom opens the new-chat view with the folder box ready for a new project folder. After a reload Studio reopens the active project's last chat (or the most recent one); with the rail on all chats the strip follows the open chat's project. Selecting a project filters the slim list to its chats (pinned and on-hold ones still appear in their own project) and restores that project's tabs. A tab strip above the chat holds the chats you have opened in the active project (remembered in this browser; closing a tab never deletes a chat): click to switch, x or middle-click to close, an overflow chip when they do not fit, **+** for a new chat: it keeps every tab, adds a temporary italic "New chat" tab at the end (x discards it and returns to the tab you came from) and starts in the folder of the project you were on; sending the first message turns it into the real chat tab. Shortcuts: **Ctrl+Tab / Ctrl+Shift+Tab** cycle, **Ctrl+W** closes the tab, **Ctrl+1..8** jump to that tab and **Ctrl+9** to the last; browsers keep these for themselves in a normal tab, so **Alt+PageDown / Alt+PageUp / Alt+W / Alt+1..9** do the same and always work. The envelope popover ("Needs you across projects") lists every chat waiting on you, grouped by project, one row each with the pending question text (or Permission / Sign-in) under the title, and a footer "Finished, not viewed: N"; a click opens the chat. Browser notification settings are an item inside that popover. At 1100 px and below the rail shrinks and the list becomes a slide-over opened from the hamburger button in the strip. The sidebar density follows `docs/design/density.md` (32 px one-line rows, 11 px type floor). The state lives in `workspace-state.js` (pure, no DOM, tested by `work/test_workspace_state.js`) and is drawn by `workspace-ui.js` and `workspace.css`, so another layout can reuse it.

Saved chats show their history immediately. Continue this conversation, located in the composer, loads an idle conversation into Studio so you can send messages. Do not continue a conversation still being used by another client. The End Studio session control is secondary, under the header menu.

Use the sidebar's three-dot button or Rename in the chat header for a custom display name. Aliases are stored in this browser's localStorage, keyed by provider and session ID; no agent transcript or agent title is modified. Reset name removes an alias. Browser storage clearing removes these aliases. Main-chat drafts are stored separately by provider/session in browser localStorage and restored after refresh. Saved conversations allow drafting before connection. With a draft, Continue becomes Continue & send. A failed connection or rejected send retains the draft; accepted prompts clear it. Clearing browser storage also removes drafts.

**Pin, on hold, archive and delete.** The "⋯" button on a row (and **Organize** in the chat header) offers Pin/Unpin, Put on hold…/Resume (with Edit hold note…), Archive/Unarchive and Delete from Studio. **On hold** means "come back to this later": the dialog takes an optional short note typed inline, and held conversations form a collapsed "On hold N" section below Chats (a separate section, so the notes stay scannable and "keep close" stays distinct from "set aside"). Each on-hold row is two lines: "note . held 3h". A held chat appears only there, except that a chat that is both pinned and on hold stays in Pinned (and its project list). Archiving clears on hold. Pinned conversations form a "Pinned" section at the top of the list most recently pinned first. Archived conversations leave the main list and live in an **Archived N** disclosure fixed at the bottom of the list area; it is collapsed by default and its open state is remembered per browser. Archived chats open read-only like any saved chat and can still be continued. Archiving unpins. Archiving a conversation that is live in Studio asks whether to end the Studio session or keep it running. **Delete from Studio** hides the conversation behind a confirmation; it is a tombstone, the agent's own transcript is never touched. Studio-deleted conversations are listed under **Archived → Recently deleted**, each with Restore. Only for a conversation that is live in Studio whose agent advertises `session/delete`, the delete dialog also offers "Also delete the agent's saved session", with a second, irreversible confirmation; it uses the same server-validated session operation as the header menu's Delete session and leaves a tombstone that cannot be restored (Remove from list only). Saved, not-live conversations never offer agent-side deletion. These marks are stored on the server in `<state-dir>/studio-conversations.json` (atomic writes, at most 2,000 entries, unreadable files are set aside as `.corrupt`), keyed by provider and session ID, so they survive restarts and are the same in every browser and every Studio sharing the `--state-dir`. Display-name aliases remain browser-local.

## Attention: whose turn is it, chips, notifications

- **Turn line.** One line above the composer (and the matching header badge) always says whose turn it is: "Agent is working… (2m 14s)", "Waiting for you: 1 approval, 1 question" (click it to jump to the first waiting card; with several agents asking, it also lists them by agent, e.g. "Reviewer: 2 approvals · Main agent: 1 question"), "Your turn", "Opening conversation…", "Connection lost · reconnecting", "Saved conversation — Continue to talk to it". It replaces the old header and composer status texts.
- **Setting chips** under the message box show the current mode / permission level, model, project folder (full path on hover) and agent (an account slot is reserved). Click Mode or Model to change it; during a turn the pick is queued ("Opus 5.5 → after this turn", × cancels) and applied when the turn ends. The Model chip shows the in-use model, with a ⚠ when the agent advertises a different one. The full settings panel is now collapsed behind "⚙ All settings", because the chips cover the common choices and the panel still holds every other advertised option.
- **Notifications** for any Studio-owned conversation, not only the open one, from the "Browser notifications" item in the needs-you inbox popover (there is no bell): "Turn on desktop notifications" (permission is requested only when you click it; the choice is remembered per browser) and an optional sound (off by default). A conversation needing you or finishing raises a browser notification when this tab is hidden or another conversation is open (clicking it focuses Studio and opens that conversation), and an in-app toast in the bottom corner (sticky for "needs you", auto-dismissed for "finished") when another conversation is open. Nothing is announced for the conversation you are looking at, nothing on first load or after a server restart, and a change is announced once. Browsers throttle timers in long-hidden tabs, so a background tab can notice up to a minute late. Every connection in `/api/live/list` carries `attention: {state: working|needs_you|idle|opening|closed, needs, turnEndedAt}`.

## Settings page

Open it with the gear at the bottom of the chat list, **Ctrl+,** or *Settings* in the Ctrl+K command bar; **Esc** or the × closes it. Search on the left filters across sections. Every change applies at once (no Save button) and is stored on the server in `studio-settings.json` in `--state-dir` (validated, written atomically; `GET`/`POST /api/live/settings` with the same token and same-origin checks as the other routes, and a revision so other windows refresh).

* **Agents.** Built-in Claude Code and OMP can be turned off but not removed. *Add an ACP agent* takes a name, a command (an existing executable file, or a bare name found on PATH), arguments (one per line) and environment variables (`NAME=value` lines). The command is started directly with that argument list, never through a shell. Studio gives each added agent a provider id `custom-<slug>`. Environment values are stored as plain text in the state folder and hidden on the page until you choose *Show values*. Saved-session discovery and transcript lookup exist for Claude Code and OMP only; a chat with an added agent is listed while it is open here and after a restart through Studio's own recovery list.
* **Defaults.** Default agent, model and mode for new chats, global and per project. Starting a chat in a project records that project's agent here (the old browser-only memory is carried over once).
* **Notifications.** The block that used to live in the inbox popover; the popover keeps a *Notification settings…* link. In a browser these stay per browser (desktop permission is per browser); in the desktop app they are AIB's own, saved in the data folder, and the app shows the notifications itself (on by default, for Needs you).
* **Keyboard.** The same list as the `?` sheet, read-only. **Editors** and **Appearance > Text size** are placeholders until those features exist.
* **Studio server.** Reconnect-after-restart on or off (applies when the agent host next starts; `--no-auto-reconnect` still wins), the state folder, versions and process ids. Restarting is done with `main.ts deploy`, not from the page.

## Working plan

In the main composer, **Enter sends** and **Shift+Enter inserts a new line**. For a saved conversation, Enter with a nonempty draft uses Continue & send. Empty drafts, composition input, and disabled/busy Send controls do not submit.


## Reliability and ownership

Studio now uses OS-backed leases per provider/session. Studio instances must share `--state-dir` (default: the workspace's `work/agent-studio-state`) to coordinate. Ready owned sessions are reused, duplicate opening requests are rejected, and leases release on owned-process exit. Lock files may remain on disk; their existence is not proof of an active lock.

On Windows, Studio also checks explicit `--resume` / `--session-id` arguments of native Claude/OMP processes before resuming. An identified external owner blocks continuation. This is best-effort: generic ACP servers often do not expose a session ID in their command line. A missing match does **not** prove that no other client owns the conversation. Do not resume a conversation that is still active in another app.

Prompt retries carry stable client message IDs. Within a running connection, the agent host retains up to 1,000 receipts and will not send the same ID/text to the agent twice. This holds across web-server restarts; it does not survive an agent-host restart. Browser requests have timeouts; a stale local token is refreshed without automatically replaying the failed write. Drafts remain available after a failure. Check the conversation before retrying an ambiguous send after a server restart.

## Structured questions

The updated backend supports ACP form elicitation after connection: text, numbers, booleans, single-choice and multiple-choice fields, including Claude's AskUserQuestion shape. Questions identify the requesting agent; answers remain editable across polling. Submit sends an explicit answer; Decline and Cancel return their corresponding protocol actions. The backend validates answers before forwarding them. Unsupported schemas and URL mode are rejected rather than advertised as supported.

This remains partial protocol coverage. Questions during connection setup, URL elicitation, authentication flows, and full turn-expiry handling remain in the tracker. Existing processes need a restart to gain backend capabilities: the web server for web-side changes (agents are unaffected), the agent host (`main.ts deploy --host`, only when idle) for agent-side ones; refreshing the page alone updates the keyboard shortcuts and other frontend assets. Never stop the agent host with open agent connections just to deploy these changes.

## Tests

The Deno server is the app. The Python server in `work/python-reference/` is kept only as the reference the tests compare it with
(same HTTP API, host protocol and files); it is never shipped or started by the app. From `outputs/agent-studio`:

```text
deno task test        the Deno unit and parity tests (work/deno/)
deno task check       type-check server/, the tests and tools/build.ts
deno task lint        lint the same
```

From the repository root:

```text
npm test                                               the page tests (node --test work/test_*.js)
npm run lint                                           ESLint over the page code
python -m unittest discover -s work/contract           the HTTP contract suite (AIB_SERVER=deno-split by default; deno, python)
python -m unittest test_worktree_e2e                   worktree-per-chat end to end, run from work/ (same AIB_SERVER choices)
```

`AIB_DENO` names the deno executable when it is not on PATH. Every test runs on temp state folders and free ports, never on the
real data folder.
