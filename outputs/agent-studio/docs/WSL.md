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
- Chats start the agent as the distro has it: AIB's own install (see "Agent installs in the distro") first, else `claude-agent-acp` /
  `codex-acp` installed with npm in the distro. A missing Claude Code or Codex gets an "Install in Ubuntu" button (the npm command
  stays, for doing it yourself) and "Open Ubuntu terminal"; sign-in runs in a distro terminal and its browser page opens on Windows.
  A chat's "needs you to sign in again" card (mid-session login expiry) runs the advertised login in the chat's distro too.
- AIB tools in a WSL chat are the artifact tools (publish by content, list, update, archive), the doc and drawing tools and, for a
  chat in its own copy, the merge tools (merge_into_project, resolve_edit_clash), reached through AIB's own tunnel inside the distro
  (see AIB tools below; WSL interop is only the fallback); the swarm helper tools are not available yet, and the chat says so.
- A new chat in a git project works in its own copy (a git worktree on branch `studio/chat-…`), made inside the distro, as for a
  Windows project; a folder that is not git, has no commits yet, or cannot get a copy keeps the chat in the project folder, with the
  same start note. The Files tab shows the chat's copy or the main folder; Changes shows the chat's branch, Discard removes the
  copy and its branch, and Merge lands the chat's own commits on main as for a Windows project (see Merge below). Live sync works
  as for a Windows project: a file the user saves in the main folder reaches the chat's copy within a second or two, the chat's
  next prompt names it, an edit both made is merged into the copy, a clash shows its line under the header and in Changes, and a
  storm of changes pauses with "Resume" (see Live sync below). Docs work as in a Windows project (see Docs below). The Files tab previews
  pictures and pages (up to 1 MB, as for a Windows project); a binary file says it cannot be shown as text, with no "Open in editor"
  (no editor on this PC opens a path inside the distro). A file outside the project folder that the chat named opens read-only,
  as in Windows projects. Delete project offers "Move folder to trash in Ubuntu" next to the default "Remove from AIB". VS Code and
  Cursor open the project with `--remote wsl+Ubuntu`.
- Ended WSL chats are listed with the project's other saved chats (Claude Code transcripts in the distro's `~/.claude/projects`),
  their history opens, and Continue resumes them in the distro.
- Quitting AIB with a WSL agent working leaves it running, as for Windows chats; the next AIB takes it over.

Side effects: the distro stays running while a WSL project is open or WSL chats run (VmmemWSL memory); `wsl.exe` processes appear
under AIB and AIB-keeper in Task Manager; `~/.aib-server` appears in the Linux home; the first use after a Windows start takes a
few seconds. Saved sessions started outside AIB are listed only once AIB has used the distro since it started. A WSL chat's
background commands are listed with their output, but AIB cannot stop one (there is no Stop on its row; ask the agent). Codex usage limits are read from the distro's `~/.codex` (a chat's chip is keyed per distro; a
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
| Helper | a channel in the Linux keeper, label `{"aib":"wsl-helper","v":ver}` | `AIB-wsl-helper` (a `deno compile` of `server/wsl/helper_main.ts`): JSON-RPC lines for Files, Changes, folder checks, agent detection, `which`, the login environment, saved sessions, background commands, the ownership check, files outside the project, project delete and Codex limits (`wsl/contract.ts` HelperMethods) |
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

**One agent per chat:** before AIB starts an agent for a saved chat (the auto-reconnect, Continue), it asks the keeper that agent
would run in (a WSL chat: its distro's Linux keeper) for a live channel of that session and takes it over instead
(`Studio.#runningInKeeper`). So a take-over at start that gave up (the distro answered after `adoptWslKeeper`'s 120 s) or a link that
was given up while its agents kept running never leads to a second agent for the same session. A distro whose keeper cannot be
asked refuses the start (the reconnect tries again). If a keeper still holds two agents for one session (from an older AIB), the
take-over keeps the working one and stops the idle one.

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
- **Which tools.** One switchboard, `artifacts/mcp.ts WSL_TOOL_GROUPS`: `artifacts`, `docs` and `merge` on; `swarm` (no helper chats
  in WSL projects yet) off. Switching a group on there changes the tool list, Studio's
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
- Live sync (below) moves the user base between merges, as on Windows, so a merge lands only what the chat changed since the user's
  last synced edit; merge.ts holds the "sync paused" lock while it stashes, in the distro, so live sync never copies meanwhile.
- The button's state never starts a distro (a distro that is not ready says why); the clash line is read only from a distro AIB
  already uses. Quit AIB waits for a running WSL merge, as for a Windows one (`wslMergesRunning`).

## Live sync

The live sync engine (`worktrees/sync.ts`) runs whole in the helper too (`wsl/helper/sync.ts`, the `sync.*` methods) over the same
`<data>` folder: a Windows watcher on a `\\wsl.localhost` path gets no change events, so the watching, the scans, the copies,
the 3-way merges and the lost-update guard all run in the distro, with Linux git on Linux paths. The helper's LiveSync is made with
`watchHere`, so `Deno.watchFs` (inotify) wakes a project's scan; the 2 s poll runs next to it as on Windows (`watchHere` stays off
everywhere else, so Windows is unchanged). There are no per-file calls between AIB and the distro.

- AIB (`wsl/sync.ts`, wired in `Studio`) sends each distro's helper the whole set of open WSL chats in their own copy (`sync.chats`,
  one call at a time per distro) when a chat opens, is taken over from the keeper or closes, and every 10 s while there are any. The
  turn hooks go to the helper with the chat's public state (no message text): `sync.turnStarted`, `sync.contextFor` (the
  `<studio-context>` note for the prompt or a steer), `sync.contextSent`, `sync.turnEnded`. A Windows chat never goes there.
- What live sync shows comes back the Windows way: the note in the chat's next prompt; the clash line ("Waiting for the chat to resolve
  a clash with your edits in …") from the records, through `merge.status`; the storm line ("Lots of files changed in …; live sync
  paused. Resume?") through `merge.clashStatus`, and its Resume (`POST /api/live/worktree/clash`, `resume-sync`) is `sync.resume`.
- Every Windows rule holds: only files the chat has not touched are copied (through a temp file and a rename, under the chat's
  worktree lock); a file both changed waits and is merged with `git merge-file` at a turn boundary, never over the chat's or the
  user's edit; a clash leaves conflict markers in the chat's copy only, and the user's file in the main folder is never written;
  `.env*` files are copied only into a chat that has not changed them; nothing is copied while Merge stashes or while the main folder
  is on another branch.
- The open chats are kept in `<data>/wsl-sync-chats.json`. A helper that restarts (it crashed, was killed, or a new AIB version
  replaced it) watches them again at its start and catches the chats up on what changed meanwhile; if it died with nothing calling it,
  AIB's next periodic set starts a new one. The helper keeps syncing while AIB is away and the chats keep running in the keeper; when
  AIB closes and stops the chats, it sends each helper the empty set. Live sync never starts a distro: a distro that is not ready is
  skipped, and a helper without `sync.*` means no live sync, as before.
- Big projects: inotify needs one watch per folder (`node_modules` included). When the distro's `fs.inotify.max_user_watches` runs
  out, the watcher fails, the helper logs it and the 2 s poll carries on.

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

## Background tasks and ownership

A WSL chat's transcripts, its agents' task output and its processes are all inside the distro, so the Windows code runs there, in the
helper (`wsl/helper/bgtasks.ts`), unchanged, and AIB asks it through four methods (contract.ts): `transcripts.query`, `ownership.check`,
`ownership.hints` and `proc.tree`.

- **Background commands.** The page's `/api/agents`, `/api/commands` and `/api/command` for a WSL session (`wsl.<distro>.claude/…`)
  go to `transcripts.query`, which runs `transcripts/monitor.ts` (handleGet, commandList, commandOutput) on the distro's transcripts.
  So the Activity pane lists the chat's background commands and subagents, their running counts and a command's latest output, as for a
  Windows chat. Output is read only from Claude Code's own task folder: on Linux `$TMPDIR/claude-<uid>/<project folder>/<session>/
  tasks/<id>.output` (then `$TMPDIR/claude/…`). The helper's store keys come back as WSL keys, so a subagent's history and a command's
  output are read through the same route again. These reads are polled, so they never start a distro: a distro that is not ready,
  or a helper without the method, answers "Command updates unavailable: Ubuntu stopped. Reconnect" (no subagents for `/api/agents`)
  instead of "No commands running".
- **Busy children.** Whether a chat is really idle (quit, update, idle exit: `Studio.busyList` 'background'; the inbox's working state)
  depends on whether the processes a background shell started still run. A WSL agent's pid is a Linux pid, so `Connection` asks
  `wsl/procs.ts`, which keeps a per-distro snapshot of the processes below the WSL agents (`proc.tree`: `platform/descendants.ts`, i.e.
  `ps`, in the distro) at most 3 s old and fetches a new one in the background. Until an answer is in, or while the helper is away, the
  answer is "cannot be listed", which already means "still running": a WSL chat is never taken for idle while its command may run.
  A command's processes are noted from the first snapshot after it went to the background. **Stop is not offered** for a WSL chat's
  background command (its pids are the distro's; AIB's Stop kills Windows processes), and the route refuses it with "AIB can't stop a
  command in a WSL chat yet. Ask the agent to stop it."
- **Ownership.** Before a saved WSL chat is continued (Continue, the auto-reconnect), AIB asks the distro whether another agent process
  holds it (`ownership.check`: `ownership/probe.ts` OwnershipProbe and `ownership.ts` findExternalOwner run natively). Inside a distro
  that means:
  - strong, refused with the Windows words ("This claude conversation is already open in another agent process (PID 1234). Stop it in
    its current client before continuing here.", the PID is the Linux one): a `claude` or `omp` process in the distro whose command line
    names the session (`--resume <id>`, `--session-id <id>`), or a live owner announcement in AIB's Windows registry;
  - weak, asked first ("Another app may be using this conversation: …"): the transcript in the distro written in the last two minutes by
    someone other than AIB, a process that has it open, or a Claude Code process running in the chat's folder;
  - never: AIB's own agents in that distro (every live pipe channel of this AIB's Linux keeper and the agents' client terminals, with
    all they started; AIB passes their pids as `exclude`) and the helper itself. Another AIB's agents (another Windows data folder) do
    count. A transcript write before AIB released the chat is AIB's own (`releasedAgo`).
  - A process is named the way it was started (its comm or argv[0]), because Claude Code's `/proc/<pid>/exe` is `node` or a version
    file. The compiled helper may not read `/proc` itself (Deno wants `--allow-all` for it, and the helper is built without), so it lists
    processes with `ps`, their folders with `readlink /proc/<pid>/cwd`, and open transcripts with one `find /proc/*/fd -lname`: all
    read-only, nothing is ever signalled.
  - A helper that cannot answer (an older one, a timeout) leaves only the Windows registry check, as a Windows check whose process
    list cannot be read does. The conversation list's hints ("Elsewhere · Working") come from `ownership.hints` of each ready distro,
    every 5 s at most, without the chats this AIB runs or released in the last two minutes. `GET /api/live/ownership` with a WSL
    folder is answered from the distro.
- Tests: `wsl_bgtasks_test` (no distro: the helper's methods on temp folders with a stand-in process list, the viewer's keys and the
  distro away, the snapshots, Continue refused, asked and excluded, a background shell over a FakeWslHost), `wsl_bgtasks_e2e`.

## Docs

**Decision: the open doc stays in AIB on Windows; only its files are in the distro.** A doc is a live Y.Doc that the page's editor
socket, the agents' doc tools, comments, history and Restore all work on, in AIB's process. Running it in the helper would mean
relaying every doc route and the editor socket (y-protocols sync and awareness) through the helper channel, and a second copy of
the doc's state to keep right across helper restarts. So for a WSL project nothing about the open doc changes: the same `DocStore`,
routes, socket and tools, the same cache (`<stateDir>/docs/cache`) and history (AIB's artifact store), all on Windows. What is in the
distro is what is in the project on Windows: `aib-docs/<doc>/doc.aibdoc`, the pages' `NN-<title>.md` copies, `assets/` (drawings,
charts' pictures) and `aib-docs/README.md`. Every read and write of those goes through one file layer, `docs/doc_fs.ts`: a Windows
path is Deno's file calls exactly as before; a `wsl://` path goes to `wsl/docs.ts`, which sends it to the distro's helper as one
`docs.fs` call (`wsl/helper/docs.ts`, contract.ts), done natively there.

- **Concurrent edits** (the user typing, agents' tool calls, file edits) meet in the one Y.Doc in AIB, with the same guards as on
  Windows: an agent's stale rewrite of a block the user changed is refused `guard_mismatch` and the user's words stay.
- **Edits made in the distro** (an agent's file tools on a `.md` copy, a hand edit of doc.aibdoc, a `git pull`): the store's 1 s poll
  reads the files through the helper and takes them in block by block, never over the user's newer words; the drawings' `.excalidraw`
  files too. On open, AIB's cache is used only when doc.aibdoc is what it was saved with; otherwise the doc is rebuilt from the file.
- **Atomic writes**: a temp file next to the target, then one rename, in the distro. A file over 512 K characters goes in pieces
  (`chunk` ops into one temp file, then the rename), because a helper request line is at most 4 MiB.
- **Nothing lost**: a distro that is starting is waited for (up to 60 s); one that stopped is never started by a docs call. The call
  is refused `wsl_unavailable` with the line the user sees ("Ubuntu stopped. Reconnect"), so a doc is never taken as missing and a
  new doc is never made over an old one. The edits stay in the open doc and in AIB's cache (saved with the files' last written
  state); the poll writes them as soon as the distro answers again, and an AIB that quit meanwhile writes them when it next opens the
  doc.
- **Confined**: `docs.fs` reaches only `<some folder>/aib-docs/…` (no `.` or `..` parts, and the real path of the nearest existing
  folder must stay inside that project's real path, so a symlink cannot lead out); a recursive remove or a trash takes only a doc
  folder or something in one, never `aib-docs/` itself.
- **What agents read**: a doc tool's `file` (doc_create, doc_read, doc_list...) and the "Send to agent" comment message name the
  Linux path (`/home/u/app/aib-docs/plan/doc.aibdoc`), never AIB's ref. A worktree chat's docs are the project's (its main folder),
  as on Windows.
- **Move doc to trash**: the helper's trash (gio, else the freedesktop trash by hand: `wsl/helper/trash.ts`); with no trash it is
  refused and nothing is removed. Under test it is the test's own trash inside AIB_WSL_ROOT, never gio.
- **Changes** of a WSL chat show a doc's files as one doc row, as on Windows (the helper's `changes.get` adds `docs`).
- **Not for WSL projects**: the layouts from before aib-docs/ (docs/<name>.md and docs/<doc>/) are not looked for (they predate WSL
  projects). Export to Markdown writes to the Windows Downloads folder, as for any doc.
- Tests: `wsl_docs_test` (no distro: the helper's docs.fs on a temp folder, the whole store through a FakeWslHost, the distro away and
  back, the trash route), `test_doc_links.js` (the Files docs rows of a WSL project), `wsl_docs_e2e` (real distro).

## Agent installs in the distro

The new-chat agent panel of a WSL project offers **Install in Ubuntu** for a missing Claude Code or Codex, and **Update in Ubuntu**
when AIB's own copy there is older than the version AIB pins now (the old copy keeps working until the new one is complete). It is
the Windows installer (`agents/installer.ts`) run natively by the helper (`wsl/helper/agent_install.ts`):

- Into `~/.aib-server/agents/<id>/<version>/` only: `npm ci --prefix <that folder> --ignore-scripts --omit=dev` with AIB's reviewed
  lockfile (`agent_locks/<id>.package-lock.json`, every package pinned with its integrity hash) and the version of
  `agent_versions.json`; npm's cache is `~/.aib-server/agents/.npm-cache`. Never `npm i -g`, nothing outside `~/.aib-server`. AIB
  sends the entry and the lockfile text with each call; the helper still takes only a known agent, one of its own package names, an
  exact version, and a lockfile that pins that package and has an integrity hash for every download. `.complete` is written last.
- `agents.detect` looks in `~/.aib-server/agents` first (`adapters.ts findStudioInstall`), so chats and the Claude sign-in start AIB's
  copy; Codex's sign-in uses the `@openai/codex` CLI that comes with it (`signin` in the detect row).
- The job's state is on disk (`install.json`, `install.lock` with the helper's pid, `install.log`), so it goes on while AIB restarts
  and the page picks it up again; a job whose helper died reads as interrupted. The page polls
  `GET /api/live/wsl/agents/install` once a second; each saved state also comes over the helper channel as the notification
  `agents.installProgress`, which answers a status read while the helper restarts. Cancel kills npm's whole process group and
  removes the half-made folder.
- Node.js 22+ and npm must be in the distro; AIB never installs system packages. Without them the panel says so ("Node.js 22 or newer
  is needed in Ubuntu to install Claude Code, and Ubuntu has no Node.js."), shows the command that installs it without root (nvm, as
  nodejs.org offers it) with Copy, and **Check again**. The helper reads the login shell's PATH again on Check again (and by itself
  at most every 15 s while Node.js is missing), so a Node.js installed in the terminal is seen without restarting anything. A
  version manager's shim (asdf, mise) is followed to the node it really runs to find npm; Debian's `/usr/share/nodejs/npm` is found
  through the `npm` on PATH.
- Routes: `GET /api/live/wsl/agents` (adds `installable`, `pinned`, `managed`, `update`, `job`, `installBlock`, `nodeInstall`; `force=1`
  looks for Node.js again), `GET|POST /api/live/wsl/agents/install`, `POST /api/live/wsl/agents/install/cancel`. Helper methods:
  `agents.installCheck`, `agents.install`, `agents.installStatus`, `agents.installCancel` (a helper without them keeps the copyable
  command only).
- Not done: uninstall from the distro (remove `~/.aib-server/agents/<id>` by hand); older versions are kept after an update (a running
  chat may still use one); the Beta agents are not offered in the distro.
- Tests: `wsl_agent_install_test` (fake npm, fake host), `test_wsl_ui.js` (the panel), `wsl_agent_install_e2e` (real distro).

## Settings > AIB Linking (WSL): what the routes give it

Design: `docs/wsl/linking-design.md` (section 11 overrides the rest). Opening Settings never starts a distro:

- `GET /api/live/wsl/status` (the registry only, never `wsl.exe`, never a start) adds, next to every earlier field:
  `wsl: {exe, problem}` (wsl.exe is there; why nothing is offered, '' when something is), `skipped: [{name, why}]` (WSL1,
  another app's distro such as `docker-desktop`, not fully installed, a name AIB does not accept: `wsl/detect.ts`) and per distro
  `isDefault` (WSL's `DefaultDistribution`). A distro AIB has not started since it started reads `state: 'off'`, `line: ''`.
- `GET /api/live/wsl/agents?distro=<d>&peek=1`: a distro that is not ready answers `200 {distro, name, state, line, agents: []}`
  (`state` 'off', 'starting', 'stopped', ...; `line` the host's line, '' when off) and is not started; a ready one answers the
  rows plus `state: 'ready'`, `line: ''`. `peek=1&start=1` is the "Start Ubuntu and check" click: it starts the distro (copies
  ~100 MB the first time, starts the keeper, helper and keep-alive) and waits, as the route without `peek` always did (the
  agent picker of a WSL project keeps that).
- The WSL sign-in terminal (`/api/live/terminal?signin=<agent>&distro=<d>`) refuses a distro AIB is not using ("Ubuntu is not
  running. Start it in Settings > AIB Linking (WSL), then sign in.") unless `start=1` is given (the user's click).
- Every Claude Code and Codex row of `agents.detect` and `/wsl/agents` has `bundledCli`: true only when the vendor program the
  adapter ships was found in the adapter's own node_modules (Codex: `@openai/codex/bin/codex.js`; Claude Code: the SDK's `cli.js` or
  its platform `claude` binary). The page says "the standalone command is not needed" only then.
- Codex in a distro is found under both npm names (`@zed-industries/codex-acp`, the current `@agentclientprotocol/codex-acp`, the
  one the install hint names). A `codex-acp` on PATH that is an asdf / mise shim (or an npm bin link) is run as
  `[real node, entry]` (the node `node -p process.execPath` names), so the Codex CLI the adapter ships is found and its sign-in
  runs `codex login` from it; `codex` on the distro's PATH only when the adapter has none. Windows is unchanged.
- Tests: `wsl_linking_test` (no distro: zero start calls on a counting FakeWslHost, the status fields, shim and bundled-CLI
  detection in temp folders), `wsl_linking_e2e` (real distro).

## Building and testing

```
deno run -A tools/build.ts --wsl-only        # dist/wsl/linux-x64/AIB-keeper-linux and AIB-wsl-helper-linux (cached by source hash)
```

A Windows package carries both in `AIB/wsl/`. A source run finds them through `AIB_WSL_KEEPER_BIN` and `AIB_WSL_HELPER_BIN`.

The real-WSL tests run only with `AIB_WSL_E2E=<distro>` (a WSL2 distro of the PC), otherwise they are ignored:

```
cd outputs/agent-studio
for f in ../../work/deno/wsl_*_e2e_test.ts; do AIB_WSL_E2E=Ubuntu deno test -A "$f"; done   # one process per file
```

Several files can share one process (each test removes its root and drops its hosts; see `work/deno/_wsl_e2e.ts`); a run per file
keeps one failure from hiding the others' results.

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
| `wsl_sync_e2e` | live sync with the helper's poll stretched to 5 minutes, so only inotify wakes a scan: events counted, a user edit and a new file in the copy within seconds, the prompt's note naming them, the helper killed and a new one catching up, Merge after sync landing only the chat's change, an edit both made merged at the next turn, a clash kept with its markers and the clash line until the chat resolves it |
| `wsl_tunnel_e2e` | the tunnel entry run inside the distro: a tools/list reaches AIB and the WSL tool list comes back, also with interop off for the forwarder (`unshare -rm`, `/run/WSL` hidden); a wrong key refused; a helper without the tunnel falls back to the interop entry, which cannot start with interop off |
| `wsl_merge_e2e` | through AIB's merge routes: a clean merge with its note, a conflict sent back and then resolved, a merge in progress in the main checkout refused, a merge after an AIB restart, a clash kept in the stash with the clash line and Keep my version, uncommitted main edits put back, the Merge button |
| `wsl_phase2_e2e` | a picture served from the distro's bytes, outside files (and AIB's own folder refused), project trash (refusals, `gio`, the freedesktop trash by hand, under the test's own `XDG_DATA_HOME`), Codex limits |
| `wsl_fixes_e2e` | the set-up probe with `-` for no `AIB_WSL_ROOT` answers `$HOME/.aib-server` (read-only); the New project dialog's check and create in the distro (new, existing, missing parent, with and without a name and git init) |
| `wsl_docs_e2e` | an agent in the distro makes, reads and edits a doc through its real tunnel entry (Linux paths in the answers); doc.aibdoc valid JSON in the distro; the user's route edits and typing with an agent's stale rewrite refused; a sed in the distro taken in; history; Changes' doc row; a big doc in chunks; a symlink out refused; a restart from the cache and a rebuild from a changed file; Move doc to trash into the test's trash |
| `wsl_agent_install_e2e` | the distro's own Node.js found (or the missing line with its command, nothing created); with a stand-in login shell, stub node and stub npm: Check again finds a new node, `npm ci` into the test root's `agents/` with AIB's lockfile and cache, detect and a chat's launch use it, Cancel kills npm and removes the folder |
| `wsl_bgtasks_e2e` | a program named claude started with `--resume <id>` in the distro: Continue refused with its Linux pid, then continued once it ended; AIB's own agent (also named claude with `--resume <id>`) never counts, and is found when not excluded; a saved session's background command listed running with its output; a chat with a background shell in the distro stays in the busy list until the shell ends |
| `wsl_linking_e2e` | Settings' peek before AIB used the distro makes no host; with a stand-in login shell and asdf's layout (shims for node, npm, codex-acp; a fake `@agentclientprotocol/codex-acp` with its `@openai/codex`): detect resolves the shim to `[real node, entry]`, `signin` and `bundledCli` name the bundled CLI, the peek row says so, the Codex sign-in runs it |

Isolation: everything goes to `AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>` instead of `~/.aib-server`, the agents' `HOME`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are inside it (`wslTestHomeEnv`), the agent is `work/fake_acp.py` run with the distro's
python3, and the Linux keeper a test started is shut down at its end. The tests never run `wsl --shutdown` or `--terminate` and
never read the owner's `~/.claude` or `~/.codex`. Unit tests without a distro: `wsl_unit_test`, `wsl_studio_test` (a FakeWslHost
over a real keeper), `wsl_hosts_test`, `wsl_helper_test`, `wsl_phase2_test`, `wsl_docs_test`, `wsl_worktrees_test`, `wsl_merge_test`, `wsl_sync_test`, `wsl_bgtasks_test`, `wsl_linking_test`, `wsl_gates_test`, `wsl_location_test`, `wsl_fixes_test`, `keeper_stream_test`; Go:
`TestAibOwnChannelsAreNotWork`, `bridge_test.go` (Linux).

## Not done yet (phase 2)

- Stopping a WSL chat's background command from AIB (no Stop on its row; the agent can stop it).
- Background commands of Codex sessions in WSL (Codex keeps no saved-session list AIB reads, as on Windows) and ownership hints of
  OMP sessions in a distro (AIB reads only the distro's Claude Code folder).
