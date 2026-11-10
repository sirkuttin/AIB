# AIB desktop app

A `deno desktop` build of the same Deno server: one program, `AIB`, that is the web server, the agent host and a native window with
a tray icon. Name AIB, identifier `dev.aib.app` (`deno.json` `desktop.app`), version `APP_VERSION` in `server/core/app.ts`
(`0.1.0-beta.1`). Builds are unsigned and marked beta. Code: `server/desktop/` and `server/main.ts`; the icons are in `icons/`.

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
- **One app per data folder:** the running app holds an OS file lock on `<data>/desktop.lock` for its whole life (the OS releases it
  if the app crashes). A second launch that cannot take the lock writes `<data>/desktop-show.signal` and exits; the running app sees
  the file and shows its window (`single_instance.ts`).
- **Window and tray:** closing the window quits when no chat is working. When chats are working it asks: OK stops them and quits,
  Cancel keeps them running and AIB stays in the tray. The tray icon (`tray_icon.ts`, the embedded 32x32 icon) has "Open AIB" and
  "Quit AIB"; Quit asks the same question. A window's close cannot be cancelled in `deno desktop`, so a hidden keeper window keeps
  the program alive while it lives in the tray, and a new window is made when the person comes back (`window.ts`, tested with a fake
  shell in `work/deno/desktop_window_test.ts`; the real shell is `native.ts`).
- **Links:** `window.open` and `target=_blank` links open in the system browser; `desktop-bridge.js` turns plain clicks on links to
  another origin into `window.open`, and the window's load check is the safety net for anything else.
- **Folder picker:** `deno desktop` has no native folder dialog, so "Browse..." uses the server's picker in the app too
  (`folders.ts`: a hidden PowerShell `FolderBrowserDialog` on Windows, `osascript` on macOS, zenity or kdialog on Linux).
- **Notifications:** the app binds `aibNotify`, `aibNotifyReady` and `aibRequestNotifications` into its window; `notify-ui.js` uses
  them through `desktop-bridge.js` (`window.AibDesktop`) and the web Notification API in a browser. Every frame of the window can call
  the bindings (artifact iframes too), so they only show notifications, rate-limited.
- **Agent host:** a separate long-lived process by design (`AIB host`). Closing the window does not cut off a turn when the person
  chose to keep chats running; an idle host exits on its own after its idle time.
- **No console windows:** on Windows the app and every child it starts share one hidden console (`platform/console.ts`).
- **Start menu (Windows):** on first run the app adds `AIB.lnk` to the per-user Start menu, pointing at the running `AIB.exe`
  (`shortcut.ts`). Not on macOS or Linux.
- **One data folder for both ways of running:** the app uses the normal default, `%LOCALAPPDATA%\AgentStudio` (macOS
  `~/Library/Application Support/AgentStudio`, Linux `$XDG_STATE_HOME/agent-studio` or `~/.local/state/agent-studio`), the same as
  `deno run -A server/main.ts`, so there is one set of chats. `AGENT_STUDIO_STATE_DIR` (a test run) wins for both.

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

- **Check:** Settings, Studio server, Updates: "Check for updates" and "Automatically check for updates" (on by default, setting
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
  now" needs no chat to be working (otherwise "Install when chats finish"). AIB starts `AIB update-helper` detached and quits; the
  helper waits for the app to exit, re-checks the hash, swaps the files (the old ones are renamed, not deleted, so a host still
  running from them keeps running), starts the new AIB, and rolls everything back if the new app cannot start. Its log is
  `<data>/updates/install.log`. The new app deletes the leftovers at startup.
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

Releases are built locally and uploaded by hand; there is no CI workflow.

## Not done yet

- Signed packages (SmartScreen and Gatekeeper warn on first run).
- A native folder dialog in the app (today: the server's picker).
- macOS and Linux builds have not been run on real machines yet.
