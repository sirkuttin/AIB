# WSL projects

A project can live inside a WSL2 distro (`/home/u/app` in Ubuntu) instead of on a Windows drive. Its agents, terminals, Files view and
Changes run natively in the distro, with Linux paths and the distro's own git, node and agent installs; AIB's window stays the same.
Design and decisions: `docs/wsl/design.md` (section 11 overrides the rest). Code: `server/wsl/`, `server/platform/location.ts`,
`keeper/bridge.go`.

## What the user sees

- **New project / Add project** offer a Location ("Windows" or "WSL: Ubuntu") when the PC has WSL2 distros. A WSL project takes a
  Linux path (typed, or picked in a folder browser of the distro); a Windows folder dialog pick under `\\wsl.localhost\Ubuntu\…` is
  turned into the same thing. New project runs `git init` in the distro.
- The project row has a distro badge; the header path reads `Ubuntu · ~/app`. While the distro starts, a line says so ("Starting
  Ubuntu…", "Setting up AIB in Ubuntu (first time, ~100 MB)"; after a `wsl --shutdown`: "Ubuntu stopped. Reconnect").
- Chats start the agent as the distro has it (`claude-agent-acp`, `codex-acp` installed with npm in the distro). A missing one shows
  its install command and "Open Ubuntu terminal"; sign-in runs in a distro terminal and its browser page opens on Windows.
  A chat's "needs you to sign in again" card (mid-session login expiry) runs the advertised login in the chat's distro too.
- AIB tools in a WSL chat are the artifact tools (publish by content, list, update, archive) and, for a chat in its own copy, the
  merge tools (merge_into_project, resolve_edit_clash), reached through AIB's own tunnel inside the distro (see AIB tools below; WSL
  interop is only the fallback); docs and the swarm helper tools are not available yet, and the chat says so.
- A new chat in a git project works in its own copy (a git worktree on branch `studio/chat-…`), made inside the distro, as for a
  Windows project; a folder that is not git, has no commits yet, or cannot get a copy keeps the chat in the project folder, with the
  same start note. The Files tab shows the chat's copy or the main folder; Changes shows the chat's branch, Discard removes the
  copy and its branch, and Merge lands the chat's own commits on main as for a Windows project (see Merge below). There is no live
  sync for WSL copies yet. The Docs tab is off. The Files tab previews
  pictures and pages (up to 1 MB, as for a Windows project); a binary file says it cannot be shown as text, with no "Open in editor"
  (no editor on this PC opens a path inside the distro). A file outside the project folder that the chat named opens read-only,
  as in Windows projects. Delete project offers "Move folder to trash in Ubuntu" next to the default "Remove from AIB". VS Code and
  Cursor open the project with `--remote wsl+Ubuntu`.
- Ended WSL chats are listed with the project's other saved chats (Claude Code transcripts in the distro's `~/.claude/projects`),
  their history opens, and Continue resumes them in the distro.
- Quitting AIB with a WSL agent working leaves it running, as for Windows chats; the next AIB takes it over.

Side effects: the distro stays running while a WSL project is open or WSL chats run (VmmemWSL memory); `wsl.exe` processes appear
under AIB and AIB-keeper in Task Manager; `~/.aib-server` appears in the Linux home; the first use after a Windows start takes a
few seconds. Saved sessions started outside AIB are listed only once AIB has used the distro since it started; background-task
output is missing for WSL chats. Codex usage limits are read from the distro's `~/.codex` (a chat's chip is keyed per distro; a
distro that is not running is not started for it).

## How it works

A project ref is `wsl://<distro><linuxPath>` (`wsl://ubuntu/home/u/app`), stored in `path` and `projectKey`. The distro is
case-folded when the ref is made; the path is case-sensitive. A ref is never URL-parsed and never reaches a Windows file function:
`isForeignPath` makes the Windows predicates answer false and the spawn sites throw (`platform/location.ts`).

Per distro in use AIB keeps one **host** (`wsl/hosts.ts`, made on first use, so a PC without WSL pays nothing):

| Piece | Where | What |
| --- | --- | --- |
| Linux keeper | in the distro, `~/.aib-server/data-<12 hex of the Windows data folder>/` | the same Go keeper, built for Linux; holds the WSL agents, terminals and the helper |
| Transport | `wsl.exe --distribution D --cd ~ --exec .aib-server/<ver>/AIB-keeper bridge --data …`, AIB's child | keeper frames over its stdin/stdout (`keeper/PROTOCOL.md` section 10); ends with AIB; reconnected with backoff if it dies |
| Helper | a channel in the Linux keeper, label `{"aib":"wsl-helper","v":ver}` | `AIB-wsl-helper` (a `deno compile` of `server/wsl/helper_main.ts`): JSON-RPC lines for Files, Changes, folder checks, agent detection, `which`, the login environment, saved sessions, files outside the project, project delete and Codex limits (`wsl/contract.ts` HelperMethods) |
| Keep-alive | a channel in the **Windows** keeper, label `{"aib":"wsl-hold","distro":d}` | `wsl.exe … bridge --hold`: keeps the distro and its agents alive while AIB is away; exits by itself once the distro has no work |

`<ver>` is the app version plus the first 8 hex of the SHA-256 of both Linux programs. `wsl/install.ts` copies them over `wsl.exe`
stdin with fixed scripts, checks the SHA-256, keeps the folders 0700, and removes older `<ver>` folders nothing runs from. musl
distros and WSL1 are refused. Every `wsl.exe` is hidden and gets only `SystemRoot`, `WSL_UTF8=1` and an empty `WSLENV`.

Agents get the distro's login environment (captured by the helper from `$SHELL -lic`, `/mnt/*` dropped from PATH, `BROWSER` set
to the `aib-open` shim), never the Windows one. A URL the shim hands over reaches `wsl/open_urls.ts`: http/https only, at most
2 KiB and 3 a minute; it opens directly within 5 minutes of a sign-in in that distro (or with "Always allow" for the distro), and
otherwise the page asks first.

**Quit and restart** (`Studio.#quitWsl`, `WslHosts.quit`): per distro the keep-alive is stopped unless WSL agents or shells still
run; then the transports end. With some left running, the Windows keeper is sent `hold`, so it neither starts AIB again in the tray
nor stops them as orphaned. AIB's own channels never count as work in either keeper (`keeper/link.ts liveUserChannels`; the Go
keeper's lifetime rules, PROTOCOL.md section 6). The next AIB starts the distros of the chats on its recovery list, rebuilds those
chats from the Linux keeper (`Studio.adoptWslKeeper`) and claims the keep-alive. A crashed AIB leaves its WSL agents running under
the keep-alive the same way.

**Transport loss:** when the transport `wsl.exe` dies, the link suspends its channels, reconnects (0.5 to 8 s steps, 30 s in all),
re-attaches each from its last record and only reports a chat as stopped when the Linux keeper's `list` says it ended. After
`wsl --shutdown` the chats end with "Ubuntu stopped (Windows restart or `wsl --shutdown`), so this agent stopped."

## Worktrees

The worktree manager (`worktrees/worktrees.ts`) runs whole in the helper (`wsl/helper/worktrees.ts`, the `worktree.*` methods),
natively, with Linux path rules. Its root is `<data>/worktrees/<repo hash>/<slug>` and its registry `<data>/studio-worktrees.json`,
where `<data>` is the Linux keeper's data folder of this Windows AIB (`~/.aib-server/data-<hash>`, passed to the helper as `--data`):
the records sit next to the keeper that holds the chats, so they survive AIB restarts and helper restarts. AIB keeps no record of a
WSL worktree on Windows; `wsl/worktrees.ts` turns the helper's Linux paths into refs.

- A chat's `cwd` is the worktree's ref (`wsl://ubuntu/home/u/.aib-server/data-…/worktrees/…/chat-…`), its agent's cwd the Linux
  folder, its `projectRoot` the project's ref; the chat note's `loc.linuxPath` is the worktree, so a restarted AIB re-adopts the chat
  on it. A Continue finds the worktree by the session on its record (made again from its branch if the folder was deleted).
- Safety: the helper rebuilds the plan AIB sends back and refuses it unless the folder is exactly `<root>/<repo hash>/<slug>` on
  branch `studio/<slug>`; removal keeps Manager's checks (real path inside the root, compared case-sensitively). A project or data
  folder under `/mnt/<drive>` never gets a worktree. At its start the helper removes half-made worktrees and retries pending
  removals, as a Windows AIB does at its start.
- Saved chats of a worktree are filed under their project (the helper's transcript store resolves the worktree). Changes shows
  Discard and Merge, as on Windows. A helper without the methods (older, or no `--data`) leaves chats in the project folder.

## AIB tools (MCP tunnel)

An agent in the distro cannot reach AIB's tool endpoint on Windows `127.0.0.1` (WSL2 NAT), and AIB never opens a port for it. So a
WSL chat's `studio_artifact` MCP entry is the distro's own keeper program:

```
<root>/<ver>/AIB-keeper mcp-forward --helper-socket <data>/helper/mcp.sock      env MCP_FORWARD_HEADERS={key, conversation id}
```

| Hop | What |
| --- | --- |
| forwarder (`keeper/mcpforward.go`) | the agent's MCP server: one connection per message to the socket, `{"headers","body"}` in, `{"status","body"\|"error"}` out; retries only a failed dial, for 15 s |
| relay (`keeper/mcprelay.go`) | `AIB-keeper mcp-relay --socket <data>/helper/mcp.sock`, the helper's child: the socket (0600, folder 0700) is listened on in Go, because a compiled Deno program can only use a unix socket path fixed at build time; lines pass through its stdio |
| helper (`wsl/helper/mcp_tunnel.ts`) | sends each message to AIB as the notification `mcp.request {rid, headers, body}` on the helper channel; `mcp.accept`, `mcp.reply`, `mcp.closed` (contract.ts) |
| AIB (`wsl/mcp_tunnel.ts`, `Studio.wslToolCall`) | takes it with `mcp.accept`, checks that the conversation is a live chat in that distro, then the HTTP endpoint's own key check and reply (`artifacts/mcp_http.ts tunneled`), and answers with `mcp.reply` |

- **Security.** The per-conversation key is checked exactly as for the HTTP endpoint (`artifacts/keys.ts`); a chat of another distro
  or a closed chat is refused the same way. The key is in the forwarder's environment and passes the helper channel (the Linux
  keeper's journal, 0700); the page token and Windows `127.0.0.1` never enter Linux. The helper.ready line names the socket only
  when the relay listens.
- **Nothing runs twice.** AIB must accept a message within 15 s, else the forwarder hears "AIB is not running" and a late accept is
  refused, so a message read later from the journal (a reconnect) never runs. A message read from an adopted helper's replay (a new
  AIB) is never handed on. A forwarder that leaves before AIB accepted is dropped; an accepted call without a reply within 10
  minutes is answered with an error. When AIB is quit with WSL agents running, the helper is told (`mcp.closed`) and answers "AIB is
  closed; try again later" at once; any call from the next AIB clears it.
- **Limits.** A message is at most 8 MB (the relay refuses lines over 16 MB) and an answer at most 3 MB.
- **Which tools.** One switchboard, `artifacts/mcp.ts WSL_TOOL_GROUPS`: `artifacts` and `merge` on; `docs` (the docs store does not
  run in WSL yet) and `swarm` (no helper chats in WSL projects yet) off. Switching a group on there changes the tool list, Studio's
  main-chat role (swarm) and the chat's note (`wsl/access.ts wslToolsNotice`). Publish takes `content` only: AIB on Windows cannot
  read the distro's files.
- **Fallback.** A helper without the tunnel (an older one, or a keeper program without `mcp-relay`) gets the phase 1 interop entry
  (the Windows keeper's forwarder as `/mnt/c/.../AIB-keeper.exe mcp-forward <Windows address file>`, `WSLENV=MCP_FORWARD_HEADERS`);
  with neither, no entry and the chat's notice. Both entries reach the same tool list.
- **Tests.** `wsl_mcp_tunnel_test` (no distro: the helper's end with a fake and with the real relay and forwarder, AIB's gate,
  `tunneled`, the switchboard), `wsl_hosts_test` (the ready line, no replayed call handed on), `wsl_studio_test` (the entry, a call
  answered, a wrong key and another distro refused), Go `mcprelay_test.go`; real WSL: `wsl_tunnel_e2e`.

## Merge

The merge engine (`worktrees/merge.ts`) runs whole in the helper too (`wsl/helper/merge.ts`, the `merge.*` methods), unchanged, over
the same `<data>` folder as the worktree registry: the repository lock, the chat's worktree lock, the "sync paused" lock and the clash
records (`<data>/worktree-clashes.json`) are all in the distro, so they hold across AIB and helper restarts, and every git step
(commit the copy's leftovers, bring main in, replay the chat's commits, stash and re-apply the user's edits in the main checkout,
fast-forward main, reset the copy) is Linux git on Linux paths. The routes (`GET /api/live/worktree`, `POST /api/live/worktree/merge`,
`merge-request`, `clash`, and the agent's `POST /api/live/worktree/tool`) ask `wsl/merge.ts wslMergeChat` first; a live chat whose
cwd is a WSL ref goes to the helper, every other chat to merge.ts as before.

- AIB sends the chat's public state with each call (its cwd as the worktree's Linux path; queued messages as empty items, so no
  message text crosses). What merge.ts posts to the chat (the conflict prompt, the "Merged into main (n commits)" note, the clash note
  with its two buttons and the clash prompt, the Merge button's queued message) comes back as ordered `actions` and AIB posts them,
  each to that chat only; a conflict prompt the chat does not take is refused with merge.ts's line. A refusal comes back as merge.ts's
  Refused (same message, code and status).
- Every Windows rule holds: only the chat's own branch lands, on the project's main branch; a busy chat, a running terminal or
  subagent in the copy, a lock file or a merge/rebase in the main checkout refuse; the user's uncommitted edits in the main checkout
  are stashed by SHA and re-applied, never overwritten (a clash keeps them in the named stash; the amber line and "Keep my version"
  read and act in the distro); nothing is ever forced.
- Live sync does not run for WSL chats, so nothing moves the user base between merges; merge.ts's tree landing still applies after a
  merge that took in the user's unsaved edits, exactly as on Windows. Resume on the amber line is a no-op for a WSL project.
- The button's state never starts a distro (a distro that is not ready says why); the clash line is read only from a distro AIB
  already uses. Quit AIB waits for a running WSL merge, as for a Windows one (`wslMergesRunning`).

## Previews, outside files, delete, Codex limits

- **Previews.** The Files read asks the helper for the file's bytes (`files.read`, base64, capped at 1 MB); for a picture or page the
  bytes go into a read-only ticket held in memory (`web/file_tickets.ts issueBytes`, at most 48 MB of WSL bytes in all, 15 minutes)
  and the artifact origin serves `/f/<ticket>/<name>` from them: no Windows path is read, and the phone's artifact port serves no
  tickets. Markdown opens rendered, as for Windows files. Over 1 MB there is no preview, as on Windows.
- **Outside files** (`GET /api/live/files/outside` for a live WSL chat). AIB first checks that the chat's own events name the path,
  by Linux rules (case kept; `worktrees/outside_files.ts mentions(…, posix)`); the helper's `files.outside` then runs `checkShape`,
  `resolveOutside`, `readOutside` and `folderLabel` natively and refuses AIB's own folders in the distro (the root, the data
  folder, the helper's folder). Saved (not live) WSL chats are not covered: their transcripts are in the distro.
- **Delete project.** `project.inspect` (what the dialog shows) and `project.trash` (`wsl/helper/trash.ts`). The Windows delete's
  refusals run natively (home folder and its parents, Documents/Desktop/Downloads, a folder holding or inside another project, AIB's
  own folders), plus a Windows drive (`/mnt/<x>`) and a top-level folder (`/home`, `/tmp`). Then `gio trash`; without `gio`, the
  freedesktop trash by hand (`$XDG_DATA_HOME/Trash`: `info/<name>.trashinfo` created first, then one rename into `files/`, a number
  appended on a name clash) when the folder is on the same disk; otherwise a refusal. There is no recursive remove in that path: a
  folder that cannot go to a trash is not deleted, and the dialog says why. "Remove from AIB" never needs the distro.
- **Codex limits.** `codex.limits` reads the newest `rate_limits` of the distro's `~/.codex/sessions` (`CODEX_HOME` of the login
  environment wins) with the Windows reader (`agents/codex_limits.ts`). A WSL chat has its own account key (`wsl:<distro>|codex`);
  there is no app-server fallback in the distro. Under test the folder is `<AIB_WSL_ROOT>/home/.codex`.

## Building and testing

```
deno run -A tools/build.ts --wsl-only        # dist/wsl/linux-x64/AIB-keeper-linux and AIB-wsl-helper-linux (cached by source hash)
```

A Windows package carries both in `AIB/wsl/`. A source run finds them through `AIB_WSL_KEEPER_BIN` and `AIB_WSL_HELPER_BIN`.

The real-WSL tests run only with `AIB_WSL_E2E=<distro>` (a WSL2 distro of the PC), otherwise they are ignored:

```
cd outputs/agent-studio
AIB_WSL_E2E=Ubuntu deno test -A ../../work/deno/wsl_*_e2e_test.ts
```

| Test | Checks |
| --- | --- |
| `wsl_install_e2e` | copy, checksums, modes, a second run copies nothing, old versions cleaned |
| `wsl_bridge_e2e` | magic line and preamble, two bridges share one keeper, no TCP listener, every helper method, the shim, `--hold` |
| `wsl_reconnect_e2e` | killing the transport `wsl.exe`: re-attached, no record lost or doubled, the agent never started twice |
| `wsl_agent_e2e` | a fake agent in the distro; a crashed AIB's chat taken over; Quit AIB with the agent working keeps it (keep-alive + hold, no tray restart) and the next AIB takes it and the keep-alive over once |
| `wsl_files_changes_e2e` | Files and Changes from the distro (`Foo` and `foo`, exec bit, untracked, diff) |
| `wsl_terminal_e2e` | the login shell in the Linux folder, resize |
| `wsl_browser_shim_e2e` | asked first, opened in a sign-in window, `file:` refused |
| `wsl_sessions_e2e` | an ended chat listed after a restart, its history read in the distro, continued there |
| `wsl_worktrees_e2e` | a chat's worktree and branch in the distro, its Changes branch view, restart re-adoption, Discard, a refused out-of-root plan, a non-git folder in place |
| `wsl_tunnel_e2e` | the tunnel entry run inside the distro: a tools/list reaches AIB and the WSL tool list comes back, also with interop off for the forwarder (`unshare -rm`, `/run/WSL` hidden); a wrong key refused; a helper without the tunnel falls back to the interop entry, which cannot start with interop off |
| `wsl_merge_e2e` | through AIB's merge routes: a clean merge with its note, a conflict sent back and then resolved, a merge in progress in the main checkout refused, a merge after an AIB restart, a clash kept in the stash with the clash line and Keep my version, uncommitted main edits put back, the Merge button |
| `wsl_phase2_e2e` | a picture served from the distro's bytes, outside files (and AIB's own folder refused), project trash (refusals, `gio`, the freedesktop trash by hand, under the test's own `XDG_DATA_HOME`), Codex limits |

Isolation: everything goes to `AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>` instead of `~/.aib-server`, the agents' `HOME`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are inside it (`wslTestHomeEnv`), the agent is `work/fake_acp.py` run with the distro's
python3, and the Linux keeper a test started is shut down at its end. The tests never run `wsl --shutdown` or `--terminate` and
never read the owner's `~/.claude` or `~/.codex`. Unit tests without a distro: `wsl_unit_test`, `wsl_studio_test` (a FakeWslHost
over a real keeper), `wsl_hosts_test`, `wsl_helper_test`, `wsl_phase2_test`, `wsl_worktrees_test`, `wsl_merge_test`, `wsl_gates_test`, `wsl_location_test`, `keeper_stream_test`; Go:
`TestAibOwnChannelsAreNotWork`, `bridge_test.go` (Linux).

## Not done yet (phase 2)

Live sync inside the distro; the docs store; background-task output and ownership
checks for WSL chats; AIB-managed agent installs in the distro.
