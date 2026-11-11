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

## The keeper (behind a switch, off by default)

The switch is **Settings > AIB server > "Keep chats running through updates and restarts (keeper)"** (`server.keeper` in
`studio-settings.json`, off by default for now; it applies at the next start). `AIB_KEEPER=1` / `AIB_KEEPER=0` in the environment
overrides it (`keeper/link.ts` `keeperSetting`; bootstrap `server.keeperOverride` says so, and the Settings card shows it). With it on,
agents run in the keeper (`AIB-keeper`, Go, `keeper/`, protocol in `keeper/PROTOCOL.md`) instead of as children of AIB, and AIB is
**one process** (no agent host, see below). With it off nothing below runs and agents are the host's children as described above,
with one exception: **a keeper that still holds chats** (the switch was on before) is taken over by the Studio (in the agent host),
and those chats stay in the keeper until they end (`Studio.keeperForNew` false: new chats are children as usual). When the last of
them has ended the Studio lets go of the keeper, which exits by itself.

* **One process with the keeper** (owner decision D3, keeper step 2). The agent host existed so the web server could restart without
  stopping agents; the keeper now does that, so with the keeper the web server runs the `Studio` itself (`main.ts`, like
  `--in-process`; bootstrap `hostMode` is `keeper`, Settings > About says "One process; running agents are held by the keeper"). It
  keeps the host's recovery and queue files (`studio-recovery-host.json`, `studio-queues-host.json`). An agent host that still runs for
  the folder (chats from before the switch, or the previous version) is attached to as before and drained the usual way; the next
  start is one process (but see "A split host from an older version" below). Measured on the dev restart (`work/deno/keeper_restart_timing.ts`: kill, start again, until the working chat
  streams again; 5 runs each): web server restart without the keeper 546-561 ms (median 554), one process with the keeper 522-529 ms
  (median 525); keeper step 1's host restart took about 6.4 s. `AIB deploy` restarts it at once (no waiting, never `taskkill /T`,
  which would end the keeper it started).
* **Start.** The Studio starts the keeper for its data folder on the first chat (`<data>/keeper/`; program: `$AIB_KEEPER_BIN`; in a
  built app `AIB-keeper` from next to the app's program, **copied to `<data>/keeper-bin/<hash>/` and run from there**, so a keeper that
  outlives the app never runs from files an update renames or replaces (Windows `.old-*` files, the macOS bundle, the Linux AppImage
  mount); in a source run a binary built from `keeper/` with Go into the temp folder). Its orphan command is AIB's own command line, so
  with no AIB attached for 5 s the keeper starts one (in the desktop app that opens the window). Code: `server/keeper/client.ts` (the
  protocol), `server/keeper/link.ts` (one connection per Studio, one channel per chat, id `chat-<connection id>`).
* **The record.** The keeper journals everything the agent says and everything AIB writes. AIB adds notes before acting: `chat` (right
  after the spawn: provider, folder, worktree, command, MCP list), `receipt` (before each `session/prompt`: the page's message id,
  fingerprint, text), `fsWrite` and `clientTerminal` (before those client capability calls). Every write carries a once-key
  (`req:<id>`, `resp:<agent id>:<n>`, `prompt:<message id>`, `cancel:<session>:<turn>`), so the keeper refuses a second copy.
* **Restart or crash.** The agent keeps running. The next AIB (`adoptKeeper`, before the automatic reconnect) attaches to each live
  channel, replays its record through the same `Connection` code with side effects off (nothing written, no client capability run, no
  hooks, the saved queue untouched), claims the channel and goes on live under the same connection id: the turn, a question waiting
  for the person, receipts and the queue (unpaused) come back; answers the old AIB never sent are sent once. The instance id open pages
  compare stays the same while the keeper does (`studio-instance-keeper.json`: the id and the keeper's pid and start time), so a page
  keeps the open chat instead of saying "Studio was restarted". A chat the code cannot rebuild stays listed read-only (`readOnly`,
  `error` says why) and nothing is sent to it; one that was still opening is stopped.
* **Install now with the keeper** (`updater.ts` `keeperHandover`). It goes ahead while chats work when every working chat runs in the
  keeper this AIB is connected to and the new version's `release.json` says it can drive this keeper (`keeper: {protocols, needs}`:
  the keeper protocols it speaks and the hello features it needs, `client.ts` `KEEPER_NEEDS`). Then:
  1. The app starts the update helper with `keeper: <data folder>`; the helper connects to the keeper **first** and stays connected
     until a version has started (the new one, or the old one after a rollback), so the keeper always has a client and never runs its
     orphan command from a half-swapped folder.
  2. The app quits with `Studio.release()` instead of `close()`: chats in the keeper are left running (leases released, receipts not
     marked unknown, the recovery list kept); anything outside the keeper is closed. Logged: "closing (installing an update); leaving
     the chats in the keeper", "released N chat(s) to the keeper".
  3. The helper swaps the files and starts the new version with the same arguments and `AIB_KEEPER` (the only `AIB_*` variable it
     passes on besides the test tray file). The new version takes every chat over from the keeper's record as after a restart, then
     writes its start confirmation; the helper disconnects. Idle chats in the keeper go over the same way.

  The keeper process itself keeps running throughout. If the new version cannot drive the keeper (an older build without
  `release.json` `keeper`, a keeper protocol or feature it lacks), a working chat runs outside the keeper, or the keeper cannot be
  asked, Install now falls back to the rules above: with a separate host the protocol gate and drain; otherwise it waits until no chat
  is working, and says why ("This update cannot take running chats over from the keeper, ...", "The running keeper is too old for
  this update to take its chats over, ...", "Some working chats do not run in the keeper, ...").
* **Keeper versions.** The keeper is never replaced while it holds chats (they would die with it). `KeeperLink.check()` runs before each
  new chat. A keeper that lacks a feature this AIB needs is replaced by the shipped one when it holds no live channel; while it holds
  running agents they stay on it, new chats run as children of AIB (logged "this chat runs without the keeper"), and such a chat makes
  Install now wait. A newer keeper shipped with AIB (its `AIB-keeper version`) replaces the running one at the first chat start when
  the running one holds no live channel ("replacing the running keeper 1.0.0 (pid N) with 1.0.1: it holds no chats"); until then new
  chats go to the running one ("the newer keeper 1.0.1 is used once the running one (1.0.0) holds no chats"). Test builds stamp a
  version with `go build -ldflags "-X main.keeperVersion=1.0.1"`.
* **Keeper death.** Its Job Objects end every agent. Each chat closes with "Interrupted: the keeper ... stopped ..." (receipt `error`,
  never resent) and is reconnected by `session/load` when automatic reconnect is on.
* **Tray, not a window, after a crash** (rule V1). The orphan command is AIB's own command line plus `--start-in-tray` (desktop app
  only; `serve` has no window). Such a start opens **no window** (the runtime's startup window is tamed too): only the tray icon, with
  Open AIB, a greyed status line ("2 chats running", "1 chat needs you") and Stop chats and quit (asks first while something works;
  OK stops the chats and quits). Open AIB, a left click or a second launch makes the window as usual. While no window was ever opened,
  AIB quits by itself once nothing has worked for 10 s (idle chats go to the recovery list, as with the idle agent host). If the data
  folder is already taken (another AIB came back first) it exits quietly: no "show your window" signal, no message box. An update
  started from such an AIB drops the flag (`updater.ts` appArgs), so the new version opens its window. Code: `window.ts`
  (`startInTray`, `TRAY_ONLY_ITEMS`, `trayTick`), `native.ts` (`updateTray`), `studio.ts` `orphanCommand`, `single_instance.ts` `quiet`.
* **The artifact tool through the keeper's forwarder** (design 3.7). A chat started in the keeper gets one `studio_artifact` stdio
  entry: `<keeper program> mcp-forward <data>/artifact-mcp.json`, with the conversation's key and id in `MCP_FORWARD_HEADERS`. The
  keeper program is the copy in `<data>/keeper-bin/<hash>/` (built app) that no update touches, so no agent child runs from the old
  version's folder and its `.old-*` files are removed at the next start while chats run. The forwarder (`keeper/mcpforward.go`, generic:
  it knows nothing of artifacts) posts each line to the loopback URL in that file, which the Studio's HTTP artifact server
  (`ArtifactMcpHttp`, `addressFile`) writes when it starts and removes when it closes; while no AIB answers (a restart, an update) it
  retries a refused connection for 15 s, never a message that may have been delivered. A Studio that takes keeper chats over starts its
  HTTP server so their forwarders find it. The forwarder needs keeper 1.1.0 (`mcp-forward --check`; older programs: the usual entries).
* **A split host from an older version** (or this one started with the switch off) while the switch is on: if nothing works there (an
  unforced stop is not refused), it is stopped at once and this AIB runs as one process with the keeper; its idle chats come back by the
  automatic reconnect (`host_client.ts` `leaveSplitHost`). If chats work there they are its child processes and cannot move into the
  keeper mid-turn, so it is attached to and drained as before, and the reason is logged and shown in the page's banner ("Agents are
  running in the separate agent host of AIB X (N chats working). They are its child processes, so they cannot move into the keeper
  while they work: they finish there, and switch over by themselves when none is working."). After the drain the new agent host runs
  its agents in the keeper; the next start of AIB is one process.
* **Snapshots and truncation.** At each turn end, once the chat is quiet (no request, question, sign-in or held answer in flight, no
  half-read line), the Connection writes a `snapshot` note (`sv` 1: its whole rebuildable state, the event list and numbering
  included, the chat note's fields, and `upTo`, the last record it had handled) through the record queue, then asks the keeper to
  `truncate` before `upTo + 1` (the keeper deletes whole old segments only). A rebuild buffers the record until the live end, starts at
  the newest snapshot it understands (skipping AIB's own writes and notes before the snapshot note, which it already covers) and
  replays only the records after it; a truncated record without a covering snapshot leaves the chat read-only. `firstNote` also finds a
  snapshot's copy of the chat note when the original was truncated away. A snapshot over 12 MiB is not written (the previous one, or
  the start, is used). Mid-turn there is no snapshot: a long turn is replayed from the last turn end.
* **Stable event ids.** Studio's own events (artifact, Studio note) go into the record as `event` notes (`Connection.recordedEvent`),
  so a rebuild numbers every event exactly as before. Each state carries `eventsId`, the id of the chat's numbering, kept across a
  rebuild when the record gives the same numbering (a snapshot, or a chat note with `ev: 1`); while a chat is being rebuilt its state
  has no events and keeps the page's cursor (`rebuilding: true`); a cursor past the end gets every event again with `reset`. The
  page (`chat.js`) starts its event list again only when `eventsId` changes. While the Studio takes chats over from the keeper at start
  (now begun before the web server listens), `/api/live/state` for a chat it does not know yet waits for that (at most 20 s) instead
  of answering "connection not found", so an open page keeps its chat without reloading the list.
* **Not yet:** terminals in the keeper (step 3); real runs on macOS and Linux (the keeper, the forwarder, the tray-only start);
  snapshots during a long turn; client terminals' events in the record.
* Tests: `work/deno/keeper_client_test.ts`, `keeper_studio_test.ts` (rebuild at four points of a turn, keeper death, release for an
  update, newer and older keepers), `keeper_gaps_test.ts` (the saved switch and its override, chats kept after switching it off, the
  forwarder across a switch, the split host stopped or drained, snapshots, truncation and stable event ids), `desktop_window_test.ts`
  (the tray-only start), `keeper/mcpforward_test.go`, `keeper_crash_e2e_test.ts` (real web server and keeper, switched on by the saved
  setting; AIB killed, then keeper killed), `keeper_update_e2e_test.ts` also checks the forwarder, the `.old-*` cleanup while the chat
  runs, and the tray-only restart after B is killed,
  `keeper_update_e2e_test.ts` (`AIB_SLOW_TESTS=1`: two real builds, a fake GitHub releases API, Install now mid-turn),
  `updater_test.ts` (the release.json keeper gate, the helper staying connected), `keeper_restart_timing.ts` (the timing above; run by
  hand).

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
