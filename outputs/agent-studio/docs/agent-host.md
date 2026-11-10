# Agent host and web server

Agent Studio runs as two processes so that deploying a code change does not cut off a running turn.

| Process | Module | Changes | Owns |
| --- | --- | --- | --- |
| **Agent host** | `server/host/agent_host.ts` (+ `Connection`, `Studio` in `server/host/studio.ts`), run as `AIB host` | rarely | every ACP adapter subprocess and its stdio pipes; event buffers and cursors; prompt receipts; settings changes queued during a turn (see models-and-settings.md); pending approvals, questions and sign-ins; client capabilities (terminal / fs); session leases; owner announcements and their heartbeat; the recovery list ("Was open in Studio before restart"); the ownership probe |
| **Web server** | `server/web/server.ts`, `server/transcripts/monitor.ts`, page files | often | the UI and the transcript/monitor APIs; the page token and same-origin checks; pin / archive / delete marks (`studio-conversations.json`); a thin `RemoteStudio` that forwards live-connection calls to the host |

The web server (`AIB` / `AIB serve` in a built app, `deno run -A server/main.ts [serve]` from the source folder) finds or starts the host for its `--state-dir` and serves the HTTP API on `--port`. `--in-process` keeps the single-process behaviour (agents are children of the web server; restarting it ends them). Tests and debugging use that mode; `Connection` and `Studio` (`server/host/studio.ts`) are the same classes in both modes, the host simply runs a `Studio`.

## Why the ownership probe lives in the host

`Studio.connect` has to run the ownership check (lease, command-line probe, announcements) before it opens an adapter, and the probe needs the host's own connection list and PIDs to avoid flagging Studio's own agents. Keeping `assess` next to `connect` means the host never makes a callback into the web server. The web server's `/api/live/ownership` just forwards. Pin/archive marks stay in the web server: they are a small file keyed by provider and session that every Studio sharing the state dir already reads, and the only host knowledge they need (is this conversation live?) is one list call.

## The RPC

* Transport: HTTP/1.0 JSON over `127.0.0.1` on a random port (`--host-port` to fix it). One endpoint, `POST /rpc`, body `{"op": ..., "args": {...}}`, reply `{"result": ...}` or `{"error", "errorType"}`.
* Discovery: the host writes `<state-dir>/agent-host.json` (`format`, `protocol`, `pid`, `port`, `token`, `hostId`, `startedAt`) atomically after it is listening, and deletes it on a clean stop. The file is restricted to the current user (`chmod 600`; `icacls` with inheritance removed on Windows; best effort, with a check that we did not lock ourselves out).
* Auth: every call must carry the token in `X-Agent-Host-Token` (constant-time compare). The host also rejects non-loopback peers, a `Host` header that is not `127.0.0.1:<port>` / `localhost:<port>`, and any request with an `Origin` or `Sec-Fetch-Site` header (browsers always send one on cross-site requests; our client never does). GET is not served. The port is never given to the browser; only the web server reads the token file.
* Operations (they mirror the existing `/api/live/*` surface): `info` (protocol, host id, open and busy conversations, start settings), `attach` / `detach` (web-server heartbeat), `list`, `state {id, after}`, `live {name, body}` (connect, discover, forget, prompt, cancel incl. subagent, permission, authenticate, elicitation, config, mode, session-op, disconnect; returns the HTTP status and payload exactly as the old handler produced them), `ownership`, `install {action, agent}` (the agent installer job: start, cancel, status; protocol 3), `stop {force}`.
* Version handshake: the host reports `protocol` (currently **1**, `host_client.PROTOCOL_VERSION`). The `info` operation keeps its shape across versions. Bump the number whenever an operation or its payload changes incompatibly.

## Behaviour

**Web server restart.** The host is untouched. The new web server reads `agent-host.json`, checks the protocol, and attaches. `/api/live/bootstrap` and `/api/live/list` report `instanceId` = the *host's* id, which does not change, so the open page does not treat connection IDs as void and keeps showing the running conversation; `webInstanceId` is the web server's own new id. The page token is per web process, so a write made with the old token gets 403 and the page refreshes its token (the existing "Studio session refreshed, retry" path). Cursors, event history, prompt receipts and pending approvals are the host's and remain valid. Starting a web server while the host is idle changes nothing else.

**Host restart** (deploy of agent-side code, `--stop-host`, crash, reboot). Adapters end, as before. The next host loads the recovery list and reconnects those conversations by itself in the background (status "Reconnecting…", two at a time, never sending anything, skipping any another app may be using; a chat that fails three times is dropped and stays "Not running"; `--no-auto-reconnect` turns this off); receipts for turns that were running become "unknown" and are never resent automatically. `instanceId` changes, so open pages say Studio was restarted. Recovery is kept per host in `studio-recovery-host.json` in the state dir.

**Stopping.** `AIB --stop-host [--state-dir D]` (from source: `deno run -A server/main.ts --stop-host`) asks the host to stop. It refuses (exit code 2, listing each conversation) while any conversation is working, opening or waiting for you, unless `--force`. A clean stop removes the host file first, so a running web server can tell "stopped" from "crashed": it then shows an empty live list with a warning and live calls answer 503 `host_stopped`; it does not start another host. `AIB deploy --host` (`deno run -A server/main.ts deploy --host`, Windows) does wait-until-idle, stop, restart the web server (which starts a new host).

**Idle exit.** A source run's host exits after `--idle-exit-minutes` (web server flag `--host-idle-minutes`, default 30, 0 = never) with zero open conversations and no web server attached. The built app's host follows the lifecycle below instead.

## Lifecycle of the built app's host (beta.2)

The built app starts its host with `--tray --exit-unattached-seconds 10` (`main.ts hostCommand`; a source run passes neither).

* **Working** (`Studio.workingList`): a turn running, an agent opening, a chat waiting for the person (approval, question, sign-in), queued prompts, or an agent install or sign-in job. A chat that is open but idle is **not** working.
* **Attached**: an app that heartbeats (every 10 s) and has not detached; one that stops heartbeating counts as gone after **25 s** (was 45).
* **Exit**: no app attached and nothing working for **10 s** → the host exits (idle chats go to the recovery list and are reconnected by the next app). Root cause of the host left behind before: the idle rule counted any *open* chat, so a host whose app went away (update, Ctrl+C, crash, or a quit whose stop request failed) lived on, window-less and tray-less, as long as one chat was open.
* **Tray**: while no app is attached and something works, the host shows its own icon (`desktop/host_tray.ts`): tooltip "AIB · 2 chats running" (with "(data: <folder>)" for a non-default data folder), the attention image (amber dot) and "1 chat needs you" while a chat waits for the person; menu Open AIB (starts the app the way it was last started, `attach.launch`), a greyed status line, Stop chats and quit (asks first on Windows). It goes away within a second of an app attaching. Windows: the worker-thread tray of `tray_win.ts`, no window of the host's own. macOS/Linux: `Deno.Tray`, **not yet run inside the window-less `AIB host` on a real Mac or Linux desktop**; if it is missing or fails the host logs it and relies on the 10 s exit (a chat that needs the person then keeps an icon-less host: check on a real machine).
* **Stops are bounded**: a stop that hangs in an agent ends the process after 20 s. Agents run in a `KILL_ON_JOB_CLOSE` Job Object, so they end with a crashed host (measured: Deno 2.9.8 already ends its children with it; the flag makes that independent of the runtime).
* **Same product attaches, then drains.** A host with the same `appId` (`dev.aib.app` / `studio-dev`) and runtime is attached at any version and from any folder or exe path (never degraded, never `HostBusy`). When it runs other code (an update, a code change), the page shows "Agents are running on AIB X (N chats working). They switch to AIB Y by themselves when none is working." and every heartbeat checks: once nothing works there, the app asks it to stop (unforced, `by` names the app) and starts a host of its own version. Logged on both sides.
* **Logs**: `agent-host.log` (the host's stderr) gets the start line (version, program, pid, data folder), attach/detach (app pid, version), tray shown/updated/hidden with the reason, idle countdown start/cancel, every stop request with who asked, refusals, and the stop reason. `studio.log` gets the start line, the close reason, the quit's stop result and the drain/handover lines. These lines are written at any log level.
* Tests: `work/deno/host_lifecycle_test.ts`, `host_takeover_test.ts`, `platform_test.ts` (kill-on-close), and the real-binary `app_update_e2e_test.ts` (`AIB_SLOW_TESTS=1`).

**Starting.** If no host runs, the web server spawns one detached (Windows: `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`, first with `CREATE_BREAKAWAY_FROM_JOB`, falling back without it; elsewhere a new session). Its log is `<state-dir>/agent-host.log`. One host per state dir is enforced by an OS file lock that disappears if the host dies, so two web servers racing to start one end up with one. The host is configured by the flags of the web server that started it (agents, MCP, client terminal/fs, owner folder); a web server that attaches to an already running host with different settings prints a note and the host keeps its own. Use `--stop-host` to apply new settings.

## Failure modes

* **Host crash.** The host file stays but its PID is gone and the port refuses. The web server's next call (or heartbeat, within 10 s) starts a new host, at most once per 5 s. Adapters died with the host, so the page sees a new `instanceId` and the recovery list. A request that did get sent to a host that then dies is *not* retried; the browser's own draft/retry rules apply.
* **Web server crash.** Nothing happens to turns. Start it again (or let `AIB deploy` do it).
* **Version mismatch.** A newer web server finding an older host reports "host protocol X, needs Y" in the console, in `/api/live/bootstrap` (`hostProblem`) and as the warning on the conversation list, and runs degraded: pages and saved transcripts work, live calls answer 503 `host_incompatible`. The host is never stopped when it has any open conversation; if it has none, it is replaced automatically. To apply the new version: finish or interrupt the work, `AIB --stop-host` (or `AIB deploy --host`), restart the web server.
* **One AIB per data folder.** Every Deno web server (the desktop app, `serve`, `--in-process`) holds an OS file lock on `<state-dir>/desktop.lock` from right after the data folder is resolved until it exits (the OS drops it if the process dies), and names itself in `<state-dir>/aib-owner.json` (pid, mode, port; removed on quit, ignored without the lock). A second web server on the same folder exits with code 2: "AIB is already running for this data folder (...). Quit it first, or use --state-dir for a separate copy." (several web servers on one folder each took the host over and restarted it every few seconds). A second desktop launch shows the running app's window instead; a desktop launch while a `serve` owns the folder shows that message in a message box. Another `--state-dir` is another lock, so test and demo copies run side by side. The host itself (`AIB host`) keeps its own one-host-per-folder lock; `--stop-host`, `deploy`, `mcp-artifact` and `update-helper` talk to the running AIB and take no lock (`deploy` and the updater start the new copy after the old one has exited).
* **Host unreachable but alive** (hung or starting). The web server returns 503 `host_unreachable` and does not start a second host.
* **State dir without a host and without the web server's permission to spawn** (for example a locked-down job object): the spawn error is shown and live features are unavailable. `--in-process` still works.

## Deno rewrite: a Python host and a Deno host (stage C)

The Deno web server (`server/main.ts`) starts the Deno agent host (`server/main.ts host`, or `<binary> host` for a compiled build) with the same flags, RPC, host file, token, lock and protocol number as `agent_host.py`. It never starts `agent_host.py` (the Python reference in `work/python-reference/`), but takes over a running one. `--in-process` works in the Deno server too.

* The Deno host writes `runtime: "deno"` into `agent-host.json` and its `info`; `agent_host.py` writes no runtime, which means Python. Its `sourceHash` covers the `.ts` files under `server/` (names relative to the app folder), so a Deno web server and a Deno host from the same folder agree; the "older code" warning compares a host's hash with the hash of the code of that host's runtime.
* **Deno web server, Python host from the same folder:** treated like a host from another code folder (`HostForeignRoot`). With no chat working, it is asked to stop and a Deno host is started ("Took over from ..."); with chats working, it is left running and the page shows the waiting banner (`hostTakeoverWaiting`) until they finish. So one runtime owns the host file at a time; the one-host OS lock (the same lease file in both languages) makes two hosts for one state folder impossible anyway.
* **Python web server, Deno host:** the Python client has no runtime rule; it sees the same folder and protocol and simply attaches (all operations and reply shapes are the same). Its banner then says the host runs older code, because it compares the `.py` hash with the Deno host's `.ts` hash; harmless.
* The artifact tool agents start is the same program's `mcp-artifact` subcommand (`server/artifacts/mcp.ts`); no Python is needed.

## Security notes

The host trusts only its token file. Anyone who can read your state dir can drive your agents, as before (they could already read the transcripts and leases). Do not put `--state-dir` on a shared or synced folder. The host exposes no file, command or terminal API of its own beyond what the web server could already ask `Connection` to do. The browser only ever talks to the web server, which keeps the per-process token and same-origin checks.

## Studio started from inside a packaged app (Windows)

The Claude desktop app is a packaged (MSIX) app. Windows redirects the `%LOCALAPPDATA%` writes of everything it starts, so a Studio launched by `AIB deploy` from a Claude session kept its whole state folder (chats, settings, read state, artifacts, worktrees, the installed Codex adapter) in `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Local\AgentStudio`. Windows deletes that folder when the Claude app is reset or uninstalled. The desktop AIB app is not packaged and uses the real `%LOCALAPPDATA%\AgentStudio`.

**Detection** (`packageContext()` in `server/state/paths.ts`, returns the package family name such as `Claude_pzs8sxrjxfjjc`, or null). Measured on this machine: `GetCurrentPackageFullName` answers `APPMODEL_ERROR_NO_PACKAGE` (15700) in the Claude app's *child* processes (a shell, Python, `claude.exe`), although their writes are still redirected. So the function asks the API first (right for the packaged process itself) and then proves redirection directly: it writes an empty marker file into `%LOCALAPPDATA%`, looks for it under `Packages\*\LocalCache\Local`, and deletes it.

**Broker.** When `packageContext()` is set, `AIB deploy` starts the new Studio through `explorer.exe` opening a small one-shot `.cmd` (`work/agent-studio-launch.cmd`, which starts `agent-studio-run.cmd` hidden; the run script appends to the usual two logs). Otherwise it starts it directly as before. Measured from inside the Claude package, what the child reports for `packageContext()`:

| Launch method | Child reports |
|---|---|
| `subprocess.Popen` (what deploy used) | `Claude_pzs8sxrjxfjjc` (inherits) |
| `cmd /c start` | `Claude_pzs8sxrjxfjjc` (inherits) |
| `explorer.exe launcher.cmd` | None (parent is the user's shell) |
| `schtasks /create` + `/run` (one-shot) | None (parent is the Task Scheduler service) |

Explorer is used because it registers nothing on the machine. Everything else in deploy is unchanged (idle wait, `--host`, the restart message, reconnection). The new Studio reports its own `packageContext` through `/api/live/settings`; deploy prints a warning when it is still inside a package.

**Banner.** A Studio that is itself inside a package shows the amber `studioNotice` line "Studio is running inside Claude's sandbox, so its data is stored in that app's private folder (...). Restart Studio from outside that app to use your normal data folder." (`notices()` in `server/web/shared.ts`, field `packageNotice`, next to `hostCodeWarning`).

**One-time move** (`adoptSandboxCopy()` in `server/state/paths.ts`, called by `prepare()` when Studio runs outside any package with the default per-user folder). Only the `Claude_*` package is searched, or any other package when exactly one holds a copy; with several Claude copies the newest is taken and the console says so. A copy that already has `MIGRATED-TO.txt` is ignored.

* Real folder has no user data and a copy exists: `migrate.migrate()` copies it, verifies byte for byte, writes `.migrated` in the new folder and `MIGRATED-TO.txt` in the sandbox copy. The sandbox copy is never deleted. As with every migration, only the `studio-*` files, `artifacts/` and the artifact key move; worktrees and the adapter folder stay in the old copy and are recreated or reinstalled.
* An agent host from the sandbox copy is still running, or a chat there holds its lease: nothing is moved. This run keeps using the sandbox folder, which holds the same files the packaged server used and so reaches the same running host. Banner: "Waiting to move your data from the Claude app's private folder (...)". The move is retried at the next start (after `AIB deploy --host`, once nothing is working).
* Both folders hold user data: nothing is merged or overwritten, Studio uses the real folder, and a banner names both folders; the owner decides which to keep and moves the other aside.
* Nothing in a sandbox: nothing changes.

Tests: `work/deno/state_paths_test.ts` (stubbed Windows calls and temp folders only).
