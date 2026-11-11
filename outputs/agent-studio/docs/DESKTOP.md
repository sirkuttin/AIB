# AIB desktop app

A `deno desktop` build of the same Deno server: one program, `AIB`, that is the web server, the agent host and a native window with
a tray icon. Name AIB, identifier `dev.aib.app` (`deno.json` `desktop.app`), version `APP_VERSION` in `server/core/app.ts`
(`0.1.0-beta.4`). Builds are unsigned and marked beta. Code: `server/desktop/` and `server/main.ts`; the icons are in `icons/`.

## Run it from the source tree (dev)

There is no separate dev shell: run the server and open the page in a browser.

```
cd outputs/agent-studio
deno run -A server/main.ts --open
```

The window, tray and single-instance lock only exist in a built app (`isDesktopApp()`); everything else (folder picker,
notifications through the web API, updates as "open the installer" instructions) works the same in a browser.

## What the app does

- **Start:** `AIB` with no subcommand is the desktop app; `AIB serve` and every other subcommand (`host`, `deploy`, `mcp-artifact`,
  `--stop-host`) open no window. With no `--port` it takes the first pair of free ports in a row from 8777 (the page on P, agent-made
  artifact pages on P + 1; `window.ts` `choosePortPair`), starts the web server, which starts the agent host (`AIB host`, the same
  binary), and opens the window on `http://127.0.0.1:<port>/`.
- **One AIB per data folder:** every AIB web server (this app, `AIB serve`, `--in-process`) holds an OS file lock on
  `<data>/desktop.lock` for its whole life (the OS releases it if the process crashes) and names itself in `<data>/aib-owner.json`
  (pid, mode, port; removed on quit, ignored when nobody holds the lock). A second app launch writes `<data>/desktop-show.signal` and
  exits; the running app sees the file and shows its window. If a `serve` owns the folder instead, the launch shows a message box
  ("AIB is already running for this data folder ... Quit it first, or use --state-dir for a separate copy.") and exits with code 2;
  a second `serve` prints that line and exits with code 2. Another `--state-dir` is another lock (`single_instance.ts`).
- **Window and tray:** closing the window quits when no chat is working. When chats are working it asks: OK stops them and quits,
  Cancel keeps them running and AIB stays in the tray. The tray icon (`tray_icon.ts`, embedded PNGs; see Icons below) has "Open AIB" and
  "Quit AIB"; Quit asks the same question. A window's close cannot be cancelled in `deno desktop`, so a hidden keeper window keeps
  the program alive while it lives in the tray, and a new window is made when the person comes back (`window.ts`, tested with a fake
  shell in `work/deno/desktop_window_test.ts`; the real shell is `native.ts`). On Windows the tray icon is AIB's own
  (`tray_win.ts`, `tray_win_worker.ts`): Deno 2.9.8's `Deno.Tray` puts the icon's message window on the JavaScript thread, which
  never reads Windows messages, so its menu and clicks never arrive. AIB's icon lives on a worker thread with a real message loop
  (left click opens the window, right click shows the menu, the web server keeps answering while the menu is open) and is removed
  when AIB quits. Other systems use `Deno.Tray`.
- **Links:** `window.open` and `target=_blank` links open in the system browser; `desktop-bridge.js` turns plain clicks on links to
  another origin into `window.open`, and the window's load check is the safety net for anything else.
- **Folder picker:** `deno desktop` has no native folder dialog, so "Browse..." uses the server's picker in the app too
  (`folders.ts`: a hidden PowerShell `FolderBrowserDialog` on Windows, `osascript` on macOS, zenity or kdialog on Linux).
- **Notifications:** the app process shows them itself (`server/desktop/notify.ts`); WebView2 has no browser permission, so the web
  Notification API is only used in a browser. `notify-ui.js` decides when (never while AIB is in front) and `desktop-bridge.js` sends
  `POST /api/live/desktop/notify` (page token required, rate-limited). Windows: a balloon on AIB's own tray icon (Shell_NotifyIconW
  NIF_INFO), which Windows 10/11 show as a toast; presentation mode, quiet time and full-screen apps are respected
  (SHQueryUserNotificationState) and Do not disturb is applied by Windows. A click (NIN_BALLOONUSERCLICK on the tray thread) brings the
  window forward and opens that chat. macOS: `osascript`; Linux: `notify-send` when installed. The window's only binding is
  `aibDesktop`, which tells the page it runs in the app. The choices are saved in the data folder (`studio-notifications-app`).
- **Agent host:** a separate long-lived process by design (`AIB host`). Closing the window does not cut off a turn when the person
  chose to keep chats running. With no app attached the host shows its own tray icon while something works and exits 10 s after
  nothing does (docs/agent-host.md, "Lifecycle of the built app's host"). The close question stays for now (`askOnClose`; false
  gives design 4.4's "no question, the chats go on under the host's icon").
- **No console windows:** on Windows the app and every child it starts share one hidden console (`platform/console.ts`).
- **Start menu (Windows):** on first run the app adds `AIB.lnk` to the per-user Start menu, pointing at the running `AIB.exe`
  (`shortcut.ts`). Not on macOS or Linux.
- **One data folder for both ways of running:** the app uses the normal default, `%LOCALAPPDATA%\AgentStudio` (macOS
  `~/Library/Application Support/AgentStudio`, Linux `$XDG_STATE_HOME/agent-studio` or `~/.local/state/agent-studio`), the same as
  `deno run -A server/main.ts`, so there is one set of chats. `AGENT_STUDIO_STATE_DIR` (a test run) wins for both.

## Chat terminals

Each chat can open a terminal (the button at the right of the chat header, Ctrl+` or Ctrl+J): a real shell in the chat's folder (its
worktree when it has one), shown in a panel under the message box. Code: `server/platform/pty.ts` (Windows ConPTY in
`pty_windows.ts`; macOS/Linux openpty + posix_spawn in `pty_posix.ts`, not yet run on a real Mac or Linux machine),
`server/terminal/sessions.ts` (one shell per chat, at most 8, the wire protocol), `server/web/terminal_routes.ts` (a WebSocket on the
page's origin behind the same gate as every route; the page token rides as a subprotocol), `server/platform/websocket.ts` (also the
handshake and framing for the desktop binary's node:http listeners), `terminal-ui.js` and `terminal.css` (the page). Tests:
`work/deno/terminal_test.ts`, `work/test_terminal_ui.js`.

- **Shell:** Windows: PowerShell 7 (`pwsh.exe` on PATH), else Windows PowerShell; macOS/Linux: `$SHELL -l`, else `/bin/bash -l`. The
  "Use Windows PowerShell" button asks for Windows PowerShell explicitly.
- **No windows:** the console host behind ConPTY runs headless; nothing appears on screen.
- **Lifetime:** with the keeper (keeper 1.2.0, shipped with AIB) shells live in the keeper, like the chats: they keep running when
  AIB restarts, updates or crashes, and the next AIB shows the same shell with its recent output (the newest 2 MiB are kept). While
  AIB restarts, the panel says "reconnecting" and reconnects by itself; only if the shell is gone does it say "Disconnected. Press any
  key to reconnect." Closing the window to the tray keeps them; quitting AIB ends them all (`WebServer.close`). Each shell and
  everything it starts is in a Job Object in the keeper, so they end if the keeper dies. Without the keeper (off, or a running keeper
  too old for terminals) shells live in the web server process and end with AIB, as before. See agent-host.md, "Chat terminals in the
  keeper".
- **Paste:** text pasted into a terminal (Ctrl+V, or "Run in terminal") never runs by itself: no trailing Enter, and several lines are
  entered without running (PowerShell: Shift+Enter between lines; bash/zsh: bracketed paste). When a command is still running, the
  page asks "Paste anyway / Cancel" first. "Running" (`Pty.busy`): on Windows the shell's Job Object holds more than the shell; on
  macOS/Linux the terminal's foreground process group is not the shell's. Built-in commands that run inside the shell are not seen.
- Nothing typed in or printed by a terminal goes to an agent.

## Host takeover

The dev server and the desktop app (and any two code folders) share one agent host per data folder, recorded in
`<data>/agent-host.json` with `appId` (`dev.aib.app` for the app, `studio-dev` otherwise), `version`, `codeRoot` and `runtime`. When a
web server finds a live host started from a different code folder, or a Python agent host left by the old Python app (no `runtime`
field in its file):

- no chat working there: it asks that host to stop, waits for it to exit, and starts its own;
- a chat working: it never stops it. It waits, retries, and the page shows an amber banner "Another AIB version is running N chat(s);
  it will switch over when they finish.".

A web server that already lost its host to another version does not take it back (two versions would fight); it reports it and must
be restarted. The Deno server never starts a Python host. Code: `server/host/host_client.ts` (`findOrStart`, `HostBusy`); tests:
`work/deno/host_takeover_test.ts` (including a real Python host from `work/python-reference/`).

## Automatic updates

Code: `server/desktop/updater.ts` (check, download, verify, install), `server/desktop/update_helper.ts` (runs after AIB quits),
`updates-ui.js` (the amber line and the Settings card). Tests: `work/deno/updater_test.ts` (fake local HTTP server, no GitHub calls),
`work/test_desktop_bridge.js`.

- **Check:** Settings, AIB server, Updates: "Check for updates" and "Automatically check for updates" (on by default, setting
  `server.autoUpdateCheck`). Automatic checks run at most once a day (time kept in `<data>/updates/state.json`); the button always
  checks. With the toggle off there is no network call at all.
- **Source:** the GitHub Releases API for the update repository. Only `api.github.com` and GitHub's asset hosts over https are
  contacted, redirects are followed by hand and every hop is checked, no credential is ever sent. Tests point `AIB_UPDATE_API_BASE`
  at a local fake server.
- **Betas:** semantic-version order (`0.1.0-beta.2` is newer than `beta.1` and older than `beta.10`; a beta is older than its
  release). Someone on a beta is offered newer betas and releases; someone on a stable release is never moved onto a beta.
- **Download and verify:** the package for this platform and architecture goes to `<data>/updates/<version>/`. Its SHA-256 must
  equal the one line for exactly that file name in the release's `SHA256SUMS` asset; otherwise the file is deleted and refused.
- **Notify:** an amber line, "AIB 0.1.x is ready to install. Install now / Later". Nothing installs without that click.
- **Install in place:** Windows (the per-user zip), macOS (the zipped `AIB.app`) and Linux when running from an AppImage. "Install
  now" works while chats work when the release's `release.json` (written by `tools/build.ts`, checked against `SHA256SUMS`) names
  this agent-host protocol: the app quits, the chats keep running in the host, the new version attaches to it and hands it over once
  nothing works. Otherwise (or for an older release without `release.json`) it says why and offers "Install when chats finish". The
  helper journals each rename to `updates/install-journal.json` before doing it (the next start undoes a cut-off swap), shows a tray
  icon "Updating AIB to X...", and counts the update as good only when the new app writes `updates/started-<ver>.ok` (page loaded,
  or `serve` listening) within 60 s. It starts the new app with the old app's arguments. The app reuses its last port
  (`desktop-port.json`) so the page origin, and its localStorage drafts, survive. AIB starts `AIB update-helper` detached and quits; the
  helper waits for the app to exit, re-checks the hash, swaps the files (the old ones are renamed, not deleted, so a host still
  running from them keeps running), starts the new AIB, and rolls everything back if the new app cannot start. Its log is
  `<data>/updates/install.log`. The new app deletes the leftovers at startup.
- **The keeper (always on; no setting):** AIB is one process and the chats run in the keeper (`AIB-keeper.exe` next to `AIB.exe`,
  `AIB-keeper` on macOS and Linux: Task Manager shows AIB plus AIB-keeper.exe). The paragraph above is the fallback for a keeper
  that cannot run (missing or refusing to start: AIB logs why and Settings > About AIB shows one line) and for an older version's
  agent host, such as beta.3's: with nothing working it is stopped at once and AIB runs as one process; with a chat working it
  drains as above, the banner says why, and the next start is one process. If AIB crashes, the keeper starts it again **in the tray only**
  (`--start-in-tray`: no window; menu Open AIB / status / Stop chats and quit; it quits by itself once nothing works and no window was
  opened). Agents' artifact tool runs from the keeper's folder (its MCP forwarder), so an update's `.old-*` files go at the next start
  even while chats run. Install now goes ahead
  while chats work when the release's `release.json` says the new version can drive the running keeper (`keeper: {protocols, needs}`):
  the app leaves the chats in the keeper, the helper stays connected to the keeper while it swaps the files, and the new version takes
  every chat over from the keeper's record (same chat, same agent process, nothing sent twice). Otherwise it waits and says why. See
  agent-host.md, "The keeper".
- **A .deb install and `deno run`:** downloaded and verified the same way; the amber line and Settings show instructions with the
  file's path. They do not install in place.

## Packages and building

All six targets are built from one machine with `deno desktop` (no Rust, no runners):

```
cd outputs/agent-studio
deno task build                                  # every target, into dist/ at the repo root
deno run -A ../../tools/build.ts --targets windows-x64,macos-arm64 --out dist/
```

`tools/build.ts` stages a clean copy of the app (`server/`, `agent_locks/`, the page files and `agent_versions.json`) with its own
`deno.json`, builds each target and writes:

| Asset | What it is |
| --- | --- |
| `AIB-<version>-windows-x64.zip`, `-windows-arm64.zip` | an `AIB/` folder (`AIB.exe` and `AIB.dll`); per-user, extract anywhere, no installer |
| `AIB-<version>-macos-x64.zip`, `-macos-arm64.zip` | `AIB.app` (first run: right-click, Open) |
| `AIB-<version>-linux-x64.AppImage`, `-linux-arm64.AppImage` | one file, updates in place |
| `AIB-<version>-linux-x64.deb`, `-linux-arm64.deb` | `sudo apt install ./file.deb` |
| `SHA256SUMS` | `sha256sum` format over all of them; the updater checks every download against it |

For the target the machine runs, the build starts the app headless (`AIB serve --in-process`, temp state folder, a free port from
8920, no window) and checks that it serves the page; `--no-smoke` skips that. Every asset over the size limit fails the build.
Icons come from `icons/` (`icon.ico` for Windows, an `.icns` made from the PNGs for macOS, `icon.png` for Linux). Tests:
`work/deno/build_test.ts`.

The icon art is the SVG masters in `icons/src/` (`icon.svg` from 40 px up, `icon-small.svg` for 16-32 px). `deno task icons`
(`tools/make_icons.ts`, resvg as WebAssembly, nothing to install) renders them into `icon.ico`, the PNGs,
`server/desktop/tray_icon_data.ts` and the pages' favicon; commit what it writes. Every tray (the app's, the agent host's, the update
helper's) shows the colour icon from `icon-small.svg` on light and dark taskbars alike; on Windows 16 or 32 px by SM_CXSMICON (the
tray worker makes the icon at the system's small icon size), elsewhere 32 px. The host's "a chat needs you" image is that icon with
an amber dot (`png_badge.ts`).

Windows window icon: the desktop runtime registers its window class (`LaufeyWebView2`) without an icon, so on its own every AIB
window shows Windows' generic one. `server/desktop/window_icon_win.ts` loads AIB.exe's icon at the system's big and small sizes
and sets it on the class and on each of the app's windows (`WM_SETICON`) right after a window is made: title bar, Alt+Tab and the
taskbar button. No AppUserModelID is set: the taskbar groups the window with AIB.exe and its Start menu shortcut by the exe path.

Releases are built locally and uploaded by hand; there is no CI workflow.

## Not done yet

- Signed packages (SmartScreen and Gatekeeper warn on first run).
- A native folder dialog in the app (today: the server's picker).
- macOS and Linux builds have not been run on real machines yet.
