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
- AIB tools in a WSL chat are the artifact tools (publish by content, list, update, archive: the publish and update descriptions a
  WSL chat gets have no `path` and say up front that only `content` works there, and that a PNG or other binary file must be
  embedded in an HTML page as an inline base64 `<img>` or opened by the user; the refusal of a `path` repeats it), the doc and drawing tools and, for a
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
  (no editor on this PC opens a path inside the distro). A full Linux path in a reply or on an Edit/Write row that is inside the
  project (or inside the chat's own copy) opens as a normal project file in the Files tab; Linux names are matched exactly
  (`readme.md` never links to `README.md`). A file outside the project folder that the chat named opens read-only, as in Windows
  projects, also for a saved chat that is not running (its distro must be running). Delete project offers "Move folder to trash in Ubuntu" next to the default "Remove from AIB". VS Code and
  Cursor open the project with `--remote wsl+Ubuntu`.
- Ended WSL chats are listed with the project's other saved chats (Claude Code transcripts in the distro's `~/.claude/projects`),
  their history opens, and Continue resumes them in the distro.
- "Find more chats via agent" never asks a WSL chat's Linux agent for the Windows list. Asked for a WSL project (`cwd` = its ref),
  it asks only a running agent of that distro (with the Linux folder; the sessions' folders come back as refs) and otherwise answers
  an empty list with a one-line `note`; it never starts an agent in a distro for it.
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

**AIB away with no keep-alive** (an older AIB build stopped it as an unknown channel, the Windows keeper died, the keeper is off):
the Linux keeper keeps every WSL agent for its **orphan grace, 2 hours** with no client of any kind (keeper 1.6.0 `--orphan-grace`,
which the bridge gives the keeper it starts; `keeper/PROTOCOL.md` section 6). Any AIB transport or keep-alive that connects in that
time finds every agent running and takes the chats over as above; the next stretch alone starts the 2 hours from zero. Only after 2
hours alone does it stop them (reason `orphaned`). Before 1.6.0 that took about 35 s. Its `keeper.log` tells the story:
`no client: keeping N live channels; they stop after 2h0m0s without a client`, `a client is back after …`, or
`no client for 2h0m0s: stopping N channels and exiting`. This holds while the distro runs: a distro that WSL itself stops
(`wsl --shutdown`, a Windows restart, WSL stopping a distro nothing keeps open) ends its agents. Tests pass a short grace with
`AIB_WSL_ORPHAN_GRACE` (`wsl/hosts.ts bridgeServeArgs`).

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

## Local-only folders

Local-only paths are AIB's block of the repository's `.git/info/exclude` (`worktrees/local_only.ts`), the same as for a Windows
project: they live only in the project's main folder, and git never copies them into a chat's copy. The helper runs the Windows
modules natively (`wsl/helper/local_only.ts`, the `localOnly.*` methods), with Linux paths and Linux git:

- **Default `/private`.** Before a chat's copy is made (and when a WSL project is added), the helper adds `/private` to AIB's block
  (`localOnly.ensure`, `ensureDefault`): only when the block does not exist yet, the project does not commit `private/` and no
  `.gitignore` negates it. The user's own exclude lines (for example their own `/private/`) are kept byte for byte. A test or demo
  AIB (state folder under the Windows temp folder) only does this for projects under the distro's `/tmp`
  (`wsl/local_only.ts wslDefaultsAllowed`), never in a real repository.
- **A chat in its own copy** (`localOnly.chat`, `chatLocalOnly`): its agent gets the main folder's existing local-only folders as
  ACP `additionalDirectories` (writable, Linux paths, for example `/home/u/app/private`), when the agent advertises it, on
  `session/new` and on `session/load`. The start note (the system prompt line, Windows wording) says where they are and that they
  must not be made in the copy. The main folder's `private/` is made (empty) so it can be granted from the first message. The copy
  itself never holds them. A chat working in the project folder gets the `private/` line only. No Windows scratch folder is added.
- **Everything else git ignores** (owner, WSL only; `worktrees/ignored_overlay.ts`). A chat in its own copy is also granted every
  other top-level folder git ignores in the main folder (`git status --ignored`: git collapses nested ones to the highest ignored
  folder, so `game/review/`, `importer/node_modules/`, a user-excluded `scratch/`), and the start note names those folders and the
  top-level ignored files (`.env`, `.claude/settings.local.json`: additionalDirectories takes folders only) by their Linux paths, saying
  they are shared with the main folder: an edit there is live at once and is not part of the copy or its branch. Left out, always:
  `.git`; any ignored folder holding or inside another worktree of the repository (`git worktree list`, for example
  `.claude/worktrees/`); AIB's own folders in the distro (the data folder with its chat copies, and the AIB root unless the project
  is inside it, as tests are). At most 60 folders and 60 files. Windows chats are unchanged (a few lines in `files_routes.ts` and
  `studio.ts`: one call for the list, a read fallback, one for the grant, would turn the same on for them).
- **Permissions.** ACP `additionalDirectories` is what the Claude Code and Codex adapters take to widen where the agent may read
  and write (assumed from the adapters' documented session capability, which the Windows flow already uses; not re-verified against
  each adapter's sandbox here). An absolute path outside both the copy and the granted folders (an ignored file) goes through the
  agent's normal permission prompt. AIB adds no guard of its own: WSL chats have no write tracker, the backup only reads, and Merge
  and sync never touch ignored files.
- **Files.** List, search and read of a chat's copy lay the main folder's local-only paths over it (`localOnly.list`, `.search`,
  `.read`; `files.listLocal`, `excludeHints`, `findStrays`, `localFiles`); a local-only file is read from the main folder.
  `localOnly.main` in the replies is the main folder's Linux path, so rows' tooltips show the path the agent uses. "Git exclude"
  and its Undo (`localOnly.exclude`: `addEntry`, which moves the copy's file into the main folder first, and `undoEntry`) and the
  stray row's Move (`localOnly.moveStrays`) work as on Windows. The helper only writes the exclude file of the main folder's own
  repository, refuses paths out of the folder (`..`), `.git`, `node_modules`, `aib-docs` and tracked files, and refuses a root that
  is neither the main folder nor one of its own chat copies (under `<data>/worktrees`). It never writes a `.gitignore`.
  Beyond Windows: in a chat's copy every ignored entry of the main folder the copy lacks is listed too (`from: 'main'`), a folder
  the copy lacks is listed from the main folder when the main folder ignores it, and a file the copy lacks is read there, so
  `game/review/` and `.env` are visible, traversable and openable from a copy. Rows excluded through `.git/info/exclude` (AIB's
  block or the user's own lines) read in normal colour (`excluded`); `.gitignore` ones stay dimmed. Search still leaves ignored
  files out, as on Windows.
- **Live sync and merge** run `worktrees/sync.ts` and `merge.ts` in the helper, which read the same local-only list natively: sync
  never copies the main folder's local-only files into a copy, and Merge never lands a local-only file from a copy.
- **Backup.** Once an hour AIB asks each running distro's helper (`localOnly.backup`; a distro that is not running is never
  started for it) to zip its WSL projects' local-only files into `<data>/local-only-backups/<repo hash>.zip`, once a day when they
  changed, as `local_backup.ts` does on Windows (the projects AIB names, plus the projects it keeps chat copies of). Only AIB's
  local-only folders are backed up, as on Windows; other ignored folders are not. There is no restore button (Windows has none
  either): the zip is unpacked by hand.
- An older helper without `localOnly.*` leaves WSL projects as before: no local-only part, and Git exclude says the helper is too old.

## Moving existing chats into their own copies (one-off)

Chats a WSL project had before worktree copies existed work in its main checkout. `tools/wsl-import.ts` (a one-off tool, not a
product feature) moves them into their own copies, so they behave like new chats: own branch, Changes, Merge, live sync. It runs
the helper's `import` subcommand (`server/wsl/helper/import.ts`) inside the distro:

```
deno run -A tools/wsl-import.ts --distro Ubuntu --project /home/<you>/<repo>                       # dry run: changes nothing
deno run -A tools/wsl-import.ts --distro Ubuntu --project /home/<you>/<repo> --apply --confirm-project /home/<you>/<repo>
deno run -A tools/wsl-import.ts --distro Ubuntu --project /home/<you>/<repo> --undo <stamp> --confirm-project /home/<you>/<repo>
  --sessions id,id     only these chats (full ids or 8+ character prefixes), for a first try with one chat
  --json               the raw report     --state-dir / --data / --root / --helper-bin   override what the tool finds
```

Run it from PowerShell or cmd. From Git Bash, set `MSYS_NO_PATHCONV=1` first, or Git Bash turns `/home/...` into a Windows path.

**What it finds.** AIB's folder in the distro (`AIB_WSL_ROOT`, else `$HOME/.aib-server`), and the Linux data folder of the AIB in use:
`data-<hash>` of its Windows data folder (`--state-dir`, else `AGENT_STUDIO_STATE_DIR`, else `%LOCALAPPDATA%\AgentStudio`). The
helper is the first of these: `--helper-bin` (a Linux build on Windows, run through `/mnt/c`); an installed `<root>/<ver>/AIB-wsl-helper`
that contains the `import` marker (a read-only `grep`; newest first); this checkout's `dist/wsl/linux-x64/AIB-wsl-helper-linux`
(`deno run -A tools/build.ts --wsl-only`). An AIB build without this code has a helper without `import`, so the tool then runs the
checkout's build from `/mnt/c`. Every wsl.exe is hidden, with `WSL_UTF8=1` and a minimal environment.

**Dry run (the default).** It reads and never writes: no file, no registry, no git index refresh (git runs with
`GIT_OPTIONAL_LOCKS=0`, and `status` with `--no-optional-locks`). It lists every saved session of the project:
- Claude Code: `~/.claude/projects/<folder>/<id>.jsonl` (`CLAUDE_CONFIG_DIR` is respected). The folder is named after the cwd the
  chat started in (`/` and `.` become `-`). Folders of the project and its subfolders are read, plus any other folder whose first
  chat ran in a worktree of this repository or in AIB's copies of it. A chat's start folder is the recorded `cwd` whose encoding
  names its folder. A chat that later `cd`s into subfolders or `.claude/worktrees/*` still counts as started in the project.
- Codex: `~/.codex/sessions/**/rollout-*-<id>.jsonl`, the start folder from its first line (`session_meta`).

Each chat is **eligible**, or **skipped** with its reason:
- already imported, or already has its own AIB copy (a registry record with its `provider:id`);
- its AIB copy was discarded (AIB keeps it read-only);
- it works in another worktree, not an AIB copy. Examples: Claude Code's own `.claude/worktrees/agent-*`, or another tool's worktree
  of the repository elsewhere (such as `~/orca/workspaces/...`). These are left alone;
- running now: a process's command line names its id, a process has its history open, or its history was written in the last 2
  minutes;
- no working folder recorded.

For each eligible chat the report shows: the branch `studio/chat-<first 8 of the session id>`, the copy
`<data>/worktrees/<repo hash>/<slug>`, the history that would move and where to, and its size.

Project-level checks (any blocker refuses `--apply`):
- the main checkout is clean: no tracked edits, no untracked non-ignored files. The offending entries are listed. Commit or merge
  them yourself; the tool never commits, stashes or touches the main checkout;
- the folder can get copies at all (the same reasons a new chat works in place: not a repo root, a merge or rebase in progress,
  detached HEAD, no commits, submodules);
- the HEAD branch and the base (main, else master), and the repository's `.git` is writable;
- disk space for the backups plus one checkout per copy;
- AIB's data folder exists and its registry can be read;
- no agent process (claude, codex or their ACP adapters) works in the project folder. AIB cannot tell which chat such a process
  holds, so they must all be stopped first;
- stale entries that `git worktree prune` would drop are only reported, never pruned.

Git-ignored and excluded folders (`.gitignore`, `.git/info/exclude`, e.g. `private/`) are never copied or touched: they stay in the
main folder, as for any new chat's copy. A chat in its copy reaches them through AIB's local-only folders, a separate feature.

**Apply.** It runs the plan again and refuses on any blocker. In a normal run it needs `--confirm-project <the same path>`. Under test
(`AGENT_STUDIO_TEST=1` or `AIB_WSL_TEST=1`; the wrapper passes `AIB_WSL_TEST=1` into the distro) everything is refused unless the project,
data, root and the Claude and Codex folders are under `/tmp/aib-wsl-test-*`, the dry run included. Then, per chat, independently (one
failure is reported and the rest go on):
1. It checks again that the chat is still where it was, not running, and has no record.
2. It writes a backup copy of each file it will move to `<root>/import-backup/<stamp>/claude/<folder>/` (never under `~/.claude`) and
   checks its size.
3. It makes the copy, branch and record with the helper's own `Manager`. That means the same naming, the same snapshot of main, the
   same registry lock (`studio-worktrees.json.lock`) and atomic write as AIB's running helper, so it is safe while AIB runs. It then
   sets the record's `session: "<provider>:<id>"` (what `Studio.connect`'s `wslRecord` finds) and `imported: {at, from, backup}`.
4. For Claude Code it **moves** `<id>.jsonl` and its `<id>/` folder (subagents, tool results) into
   `~/.claude/projects/<encoded copy path>/`. If the move fails, the copy is removed again.

`<root>/import-backup/<stamp>/manifest.json` records every step. AIB picks the result up without a restart: the helper reads the
registry on every lookup, and the saved-chat list reads the folders on every poll.

Why move and not copy: Claude Code resumes a session from the folder named after the agent's cwd. The ACP adapter's own
`session/status` notes that a resume with another cwd can fail with -32002, although its history replay searches every folder. Once
resumed, the chat's cwd is the copy. A copy would also show the chat twice in the saved list. The saved row keeps showing under the
project (its records still name the project folder), and opening it resumes in the copy.

Codex history is not moved: AIB resumes Codex with the session id and the copy as cwd, and Codex looks a rollout up by its id under
`~/.codex/sessions`, wherever it ran. This was checked with the fake agent only; see below.

A chat that started in a subfolder (e.g. `<repo>/rea`) opens at the copy's root. The record has no subfolder field, and `connect()`
starts the agent in the record's folder. Local files that are not in git, such as `.claude/settings.local.json`, stay in the main
folder; only `.env*` files are copied, as for any new copy.

**Undo** (`--undo <stamp>`, the same confirmation; `--sessions` works). Per chat of that run, it is refused while the chat runs (a
process names it or works in its copy, or its history was written in the last 2 minutes) or has work of its own in its copy (commits
beyond its start, or changed or new files): merge or discard that one in AIB. Otherwise:
- `git worktree remove` (never `--force`), prune;
- the branch is deleted only when it still points at its start, and the user-base ref is unpinned;
- the record is removed without a "removed" note, so the chat goes on in the project folder;
- the history moves back: the moved file, so nothing said since is lost; the backup copy if that file is gone. It refuses if a file
  is back at the original place.

Backups are kept until you delete `<root>/import-backup/<stamp>/`.

**Not verified with the real adapters.** The tests use the fake agent. The real Claude adapter's resume of a moved session from the
copy's folder, and the real Codex adapter's resume by id in another cwd, follow from their code and docs but were not run.

**Follow-up idea (not built):** do this automatically when a project is added from an existing folder that already has chats.

Tests: `wsl_import_test` (Windows temp folders: classification, the dry run leaves every file and the index as they were, blockers,
apply, one row per chat in the store, a re-run, undo refusing a chat with a commit, the test guard) and `wsl_import_e2e` (below).

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
  main-chat role (swarm), the swarm service's own role check (`swarm/service.ts mainChat` refuses a WSL chat with code `wsl`,
  "Helpers are not available in WSL projects yet") and the chat's note (`wsl/access.ts wslToolsNotice`). Publish takes `content` only: AIB on Windows cannot
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
  folder, the helper's folder). A **saved** WSL chat that is not running (`id` = `claude:<sessionId>` or its
  `wsl.<distro>.claude/<key>`, naming a Linux path): the distro comes from the saved-session listing (`wsl/transcripts.ts
  wslSessionCwd`, ready distros only), the helper's `transcripts.mentions` checks the session's own transcript and its subagents'
  files for the path (same Linux rules), then `files.outside` as above. A distro that is not running is never started for it: 409
  `wsl_not_running`, "Ubuntu is not running". Any other chat id keeps the Windows answer.
- **Path links on the page** (`files-ui.js`). A WSL chat's agent names files by Linux path, so the reply links and the Edit/Write
  rows compare paths against the Linux folder of the chat's ref (`AIBWsl.parse`; a chat in its own copy: the copy's Linux folder),
  never against the ref. Names compare case-sensitively for WSL listings (case is folded for Windows folders only). Ctrl+click on
  an outside Linux path sends the editor route its ref, which answers as for an outside Windows file ("not inside a project
  folder AIB knows").
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
    someone other than AIB, a process that has it open, or a Claude Code process running in the chat's folder while the transcript was
    written by someone other than AIB in the last 30 minutes (or cannot be found);
  - folder only, continued without asking: a Claude Code process in the chat's folder that names no session (a VS Code panel, a
    terminal session) is the only sign and the transcript has been quiet for 30 minutes or more (`probe.ts` QUIET_TRANSCRIPT_SECONDS,
    folderOnlyEvidence; the helper's assessment carries `transcriptQuiet`). The chat gets one note: "Claude Code is also running in
    this folder (PID 1234). AIB found nothing that says it holds this conversation." (at most three PIDs, then "and N more"). The same
    rule applies to Windows chats. An older helper without `transcriptQuiet` asks as before;
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
  `agents.installProgress`, which answers a status read while the helper restarts. A status read never starts a distro (only
  `start=1` does): a distro that is not ready answers `{ok, state: 'idle', distro, name, distroState, line}` (while AIB is bringing
  it back, starting or reconnecting, the last progress, `stale`). Cancel kills npm's whole process group and
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
- Uninstall: `POST /api/live/wsl/agents/uninstall` (Settings > AIB Linking (WSL), phase 2, below). Older versions are kept after an
  update (a running chat may still use one); the Beta agents are not offered in the distro.
- Tests: `wsl_agent_install_test` (fake npm, fake host), `test_wsl_ui.js` (the panel), `wsl_agent_install_e2e` (real distro).

**Verified 2026-11-15 (one real install of each pinned agent in a temp root, `agents.install` of the helper, Ubuntu 24.04 x86_64,
Node 24.22.1 through asdf; nothing signed in, only `--help` run with a throwaway HOME; the temp root was removed afterwards):**

- Claude Code (`@agentclientprotocol/claude-agent-acp` 0.102.0, `npm ci --ignore-scripts`, 31 s): **the `claude` program is
  bundled.** `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` is a 342 MB glibc ELF binary (Claude Code 2.1.321;
  package 327 MB, install 404 MB in all). npm installed the linux-x64 optional package although install scripts were off; no musl
  copy and no other platform's package was fetched. Its sign-in: `claude auth login` (`--claudeai` default, `--console`, `--sso`,
  `--email`), with `claude auth status` and `claude auth logout`; AIB runs it through the adapter as
  `node dist/index.js --cli auth login --claudeai` (`signin.ts DEFAULT_TERMINAL`; the `--cli` route itself was not re-run here).
- Codex (`@agentclientprotocol/codex-acp` 2.6.0, 25 s): **the `codex` CLI is bundled.** `@openai/codex` 0.166.0 (`bin/codex.js`,
  28 KB) with `@openai/codex-linux-x64` (436 MB: a static musl `codex` binary, its own `bwrap` and `rg`; that package only ships a
  musl build, which runs on glibc distros); install 457 MB. Sign-in: `codex login` (`--device-auth` is listed, also
  `--with-api-key`, `--with-access-token`), status `codex login status`.
- npm's cache in `agents/.npm-cache` grew to 330 MB for the two installs.

## Linking (WSL) phase 2: helper methods

The helper side of the Settings checklist, Uninstall and sign-in status (`docs/wsl/linking-design.md` section 12; shapes frozen in
`wsl/contract.ts`). All three are read-only except the uninstall's deletion, and none starts an agent.

- **`env.prereqs {force?}` -> `EnvPrereqs`** (`wsl/helper/prereqs.ts`). Node.js through the login PATH (no `/mnt` folder), at least
  22.19: `ok`, `missing`, `old`, `broken` (found but `node --version` fails), `shim_unset` (an asdf / mise shim with "No version is
  set"); `manager` asdf / mise (shim path), nvm (`NVM_DIR` or `~/.nvm`), aib (inside the AIB folder), else system. npm is found
  next to the node found or next to `node -p process.execPath` (an asdf shim has no npm beside it), version from npm's
  package.json. git (`git --version`), curl (on PATH), `diskFreeMB` of the home filesystem (`df -Pk`), `arch`, `loginShell`,
  `envMode` (`-lic` = login-interactive, `-lc` = login, else plain), `nvm.present` (`$NVM_DIR/nvm.sh` or `~/.nvm/nvm.sh`).
  `canInstallNode` is false, with `nodeInstallBlocked` saying why and what to do, when node is managed by asdf / mise, the login
  shell is not bash or zsh, its start-up file (`~/.bashrc`, `$ZDOTDIR/.zshrc` or `~/.zshrc`, the `PROFILE` nvm gets) does not exist,
  or curl is missing. `force: true` reads the login environment again first (PATH and `NVM_DIR`), so a Node.js installed in a
  terminal since the helper started is seen. Never installs anything. Added after the freeze (optional): `node.managerVersion`
  (`asdf --version` / `mise --version`, run only when one manages node: asdf 0.16+ sets a version with `asdf set -u`, older asdf
  with `asdf global`) and `pkgManager` (`apt` / `dnf` / `yum` / `zypper` / `pacman` / `apk` / `unknown`, from `/etc/os-release`
  `ID` and `ID_LIKE`, the family whose program is found first, else the first package manager program found on PATH or in the
  system folders); the curl reason in `nodeInstallBlocked` uses that family's command.
- **`agents.uninstall {id}` -> `{ok, removed, message?, blocked?}`** (`wsl/helper/agent_install.ts`). Only `claude` and `codex`;
  removes every `<root>/agents/<id>/<version>` with installer.ts `uninstall` (marker first, then the job files). Nothing installed:
  `{ok: true, removed: []}`. Refusals are answers with `ok: false` and one plain line: `blocked: 'installing'` (this helper's job
  or another live process holds `install.lock`), `'running'` (a process of the distro, of any user and any AIB data folder, has its
  program or command line inside that folder, read from `/proc/*/exe` and `/proc/*/cmdline` by sh; the pids are in the message),
  `'unchecked'` (the process list could not be read), `'unsafe'` (`agents` or `agents/<id>` is a link or not a folder, or is not
  inside the root), `'failed'` (a folder could not be removed). Only real folders inside `<root>/agents/<id>/` are deleted; the
  user's own installs, `~/.claude`, `~/.codex` and other agents are never touched.
- **`agents.signinStatus {ids?}` -> `{agents: [{id, state, account?, note?}]}`** (`wsl/helper/signin_status.ts`; default ids claude,
  codex, omp). Files' presence, size and JSON shape only, at most 1 MB, `CLAUDE_CONFIG_DIR` / `CODEX_HOME` of the login environment
  first. Claude Code: `.credentials.json` with a `claudeAiOauth` object = `signed_in` (`account` = `oauthAccount.emailAddress` of
  `.claude.json`, the only text taken from a file), an API key / Bedrock / Vertex variable in the login environment = `signed_in`
  (its name in `note`, never its value), no file = `signed_out`, anything else `unknown`. Codex: `auth.json` with a `tokens` object
  or a non-empty `OPENAI_API_KEY` = `signed_in`, both empty or no file = `signed_out`, credentials kept in the keyring
  (`cli_auth_credentials_store` in config.toml) = `unknown`. OMP and other ids: `unknown`. No token value, and no JSON parse error
  (it can quote the file), ever reaches the answer.
- Tests: `wsl_linking_helper_test` (no distro: fake runners and files for every Node.js case, a temp root with fake agent folders
  and a fake process list, fake credential files with a fake token that must never appear), `wsl_linking_helper_e2e` (real distro).

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

## Settings > AIB Linking (WSL): phase 2 routes

Design: `docs/wsl/linking-design.md` section 12 (it overrides the rest). Helper methods `env.prereqs`, `agents.uninstall`,
`agents.signinStatus` (contract.ts, frozen) are the Linux side; these are the Windows routes over them.

- **Each distro's own On/Off switch per agent.** Settings key `agentsByDistro: {"<distro key>": {"<agent id>": boolean}}` in
  `studio-settings.json` (the folded distro name; present only when not empty; an agent with no value in a distro is on; exposed as is
  by `GET /api/live/settings`). `POST /api/live/wsl/agents/enabled {distro, id, enabled}` -> `{ok, enabled}` (id: a built-in, Beta or
  existing custom agent; the page token as every WSL route). A WSL chat reads only this switch, never the Windows one, and a Windows
  chat never reads it (`host/studio.ts wslLaunch`): an agent turned off for the distro is refused for a new chat, the agent options
  probe and the person's Continue with "Claude Code is turned off for Ubuntu in Settings > AIB Linking (WSL)", before the distro is
  asked anything; the automatic reconnect at start is never refused (a running chat is not cut off by the switch).
- `GET /api/live/wsl/agents` rows (with or without `peek`) add `enabled` (that switch), `signin: {state: 'signed_in' | 'signed_out' |
  'unknown', account?, note?}` (helper `agents.signinStatus`; an older helper: 'unknown' with "The AIB helper in Ubuntu cannot check
  sign-ins yet. Restart AIB."), `canUninstall` (AIB's own install: `source` 'studio') and, on the Codex row only, `limits`: the Limits
  chip's snapshot (`usage_limits_feed.ts wslCodexLimits`: helper `codex.limits` over that distro's `~/.codex`, never merged with
  Windows') or null.
- `POST /api/live/wsl/agents/uninstall {distro, id}` -> the helper's `{ok, removed, message?, blocked?}`. Never starts a distro (409
  `wsl_unavailable` when it is not ready). Refused with `ok: false`, `removed: []` and `blocked` (the reason, verbatim) while the
  agent's install job runs in that distro (the job state the install routes read), while its sign-in terminal
  (`signin:<agent>@<distro>`) runs, or when the helper refuses (answered, or thrown with a `*refused*` / `*blocked*` code). Claude
  Code and Codex only (400 otherwise); a helper without the method: 409 "too old".
- `GET /api/live/wsl/prereqs?distro=<d>&peek=1[&start=1][&force=1]`: not ready -> `{distro, name, state, line, prereqs: null}` (never
  started); ready -> `{distro, name, state: 'ready', line: '', prereqs: EnvPrereqs}` (helper `env.prereqs`, `force` reads the login
  PATH again). `start=1` is the click; without `peek` the distro is started and waited for (as `/wsl/agents`).
- **Install Node.js in Ubuntu**: the terminal `/api/live/terminal?setup=wsl-node&distro=<d>[&start=1]` (key
  `setup:wsl-node@<distro>`, in the Linux home, through `terminals.attachWsl`; the server reads `distro` from the query). It asks the
  helper's `env.prereqs` (force) first and refuses unless `canInstallNode` (the line is `nodeInstallBlocked`). The steps
  (`wsl/node_setup.ts`), each printed as `$ <command>` before it runs, the first failure stopping the rest, run by `/bin/bash
  --noprofile --norc -c` with the distro's login environment: `mktemp`; `curl -fsSLo` nvm's install.sh at the pinned tag; `sha256sum
  -c` against the pinned SHA-256; `touch` and `PROFILE=<.zshrc for zsh (ZDOTDIR), .bashrc for bash, else .profile> bash <file>`;
  remove the temp file; load nvm; `nvm install --lts`; `node --version` at least 22.19. Never sudo, never apt. After exit 0 the page
  asks `prereqs?force=1`.
- **One nvm pin** (`agents/nvm.ts`): `NVM_VERSION` v0.41.0 and `NVM_INSTALL_SHA256` (of that tag's install.sh, computed 2026-11-15
  from raw.githubusercontent.com and checked against github.com/.../raw). The Beta card's Node.js step (`beta_setup.ts`, Linux and
  macOS: `shasum -a 256` where `sha256sum` is missing), the copy line of the distro rows (`wsl/agent_install.ts NODE_INSTALL`, now
  `--lts` with the checksum) and the button all use it; an empty checksum makes every one refuse ("nvm checksum not pinned yet").
- Tests: `wsl_linking_routes_test` (FakeWslHost with stand-in helper methods: the switch matrix, the rows, uninstall refusals, prereqs
  peek, the Node.js terminal's refusals and steps, the single pin), `wsl_linking_routes_e2e` (real distro: no host made by peek,
  the rows with the real helper, the button's script run in the distro against a stand-in install.sh served by `file://`, never the
  real installer).

## Settings > AIB Linking (WSL)

A Settings section of its own, listed right under AIB Linking, only when AIB runs on Windows (bootstrap's state folder is a Windows
path; before bootstrap answers, the browser's platform). Design: `docs/wsl/linking-design.md` (section 11 overrides it). Phase 1,
drawn by `wsl-settings-ui.js` (settings-ui.js has the section, one INDEX entry `wsl-linking` and its RENDER hook):

- **WSL on this PC**: every distro of the status (`WSL 2`, `WSL default` for the status's `isDefault`, the chip Ready / Starting /
  Not running / Stopped / Problem), then the `skipped` ones (WSL 1, musl) as Not supported with the server's reason; a WSL 1 one
  gets the copyable `wsl --set-version <name> 2`. No distro at all: `wsl --install` (or `wsl --install -d Ubuntu` when the status
  says `wsl.exe` is there), Microsoft's page and Check again.
- Per usable distro, a group: its status card (State, AIB helper, Home; Not running gets **Start Ubuntu and check**, which says it
  copies AIB's helper there the first time, about 100 MB, and starts it; Stopped or Problem gets Reconnect), and, once the distro is
  ready, **Agents in Ubuntu**.
- The agent cards are Settings' own `agentRow` with an env of the distro (`makeEnv`): the job store is wsl-ui.js's (the only one;
  Settings never keeps a second), card keys are `wsl:<distro>:<agent>`, so a Windows and an Ubuntu install of Claude Code at once
  never share a job, a terminal or a card. Install / Update in Ubuntu, progress with Cancel, Install failed with Retry, and the
  Node.js line with its command to copy, all through the existing install routes. Tags: Installed by AIB (`managed`) or Your own
  install. The chip: phase 2 below.
- The On/Off switch: phase 2 below (each distro has its own). A Beta card in a distro (later phase) says it uses the Windows API
  key instead of a key box.
- Claude Code and Codex cards: when the row's `bundledCli` is true, "The standalone claude command is not needed"; otherwise the
  vendor's command to copy and its docs (owner decision 3a: AIB never installs it).
- **Opening Settings never starts a distro**: the section reads the status poll (never starts one) and asks
  `GET /api/live/wsl/agents?distro&peek=1` only for a distro that is ready (again after a minute, or on Check again with
  `force=1`). Only the Start and check click adds `start=1`. A not-ready peek answer never fills the new-chat panel's cache.
- Links: the new-chat panel's "not installed in Ubuntu" state has **Set up Ubuntu in Settings** (opens the section with that
  card in view); Settings > About has "WSL distros: details and agent installs in AIB Linking (WSL)".
- Later phases (not drawn): Repair AIB helper and Beta agents. The "AIB in Ubuntu" card with Remove: phase 3 below.
- Tests: `work/test_wsl_settings.js` (fake routes of the contract: every phase 1 state, no start on open, the namespaces).

### Phase 2 (page; design section 12)

- **The distro drop-down** at the top of the section (a Settings field, label "Distro"): the usable distros (WSL's default reads
  "Ubuntu (WSL default)"), then the unusable ones, disabled, with their reason ("docker-desktop (not supported: …)"). It picks the
  one distro whose group the page shows; one distro still gets the drop-down (one entry).
- Which distro: the open project's distro when that changed since the last look (a WSL project or chat open in Debian: Debian),
  else the one shown already, else the remembered choice, else WSL's default, else the first usable one. The choice is a view
  preference (`aib-wsl-distro` in `view-prefs.js`: kept in the data folder). "Set up Ubuntu in Settings" picks that distro.
- **WSL on this PC** stays, as the compact card under the drop-down (every distro with its chip, the skipped ones with the reason
  and the WSL 1 command, the keep-alive line; the no-WSL card when there is no distro).
- **What Ubuntu needs** (above the agents; `GET /api/live/wsl/prereqs?distro&peek=1`, `force=1` on Check again; never `start`):
  Remote control's check list (`.dv-checks`). Rows: Node.js 22.19 or newer (found with version, manager and path / missing / too
  old / `shim_unset`: "asdf has no Node.js version set" with asdf's or mise's own command to copy and never nvm: `asdf install
  nodejs latest && asdf set -u nodejs latest` for asdf 0.16+, `... && asdf global nodejs latest` for older asdf, both labelled
  when the helper did not report asdf's version; `mise use -g node@lts` / broken), npm,
  git, curl, free space in the home folder, and "Checked with: zsh login shell (interactive)" (non-interactive; plain shell, which
  says a version manager in the profile is not seen). `prereqs: null` (not ready): the answer's line.
- **Install Node.js in Ubuntu** only when `canInstallNode` (and never for `shim_unset`): the card's terminal panel (the Windows
  setup panel's look) with `/api/live/terminal?setup=wsl-node&step=node&distro=<d>` (`terminal-ui.js signinUrl` keeps `distro`
  for a setup step now). Exit 0: prerequisites with `force=1`, then the agents with `force=1`; the panel closes once Node.js is
  seen. `canInstallNode` false: `nodeInstallBlocked` verbatim, **Open Ubuntu terminal** (the new-chat panel's `wsl-shell:<d>`
  terminal in the distro's home, in the card) and Check again.
- Close on the Node.js panel and on an agent's sign-in panel also ends that program on the server (`POST /api/live/terminal/end`
  with `setup:wsl-node@<d>` / `signin:<agent>@<d>`, `wsl-ui.js endTerminal`), as the Windows card's Close does; before, Close only
  dropped the socket and the program kept running in the distro (and blocked Remove). The "Open Ubuntu terminal" panel's Close
  does not end its shell (`wsl-shell:<d>` is shared with the new-chat panel).
- git or curl missing: the install line of the distro's package manager (`pkgManager`; absent = apt): `sudo apt install git`,
  `sudo dnf install git`, `sudo yum install git`, `sudo zypper install git`, `sudo pacman -S git`, `sudo apk add git`, to copy only
  (AIB never runs them); `unknown`: "Install git with your distro's package manager" and nothing to copy. Open Ubuntu terminal,
  Check again.
- **Each distro has its own On/Off switch per agent** ("Use in Ubuntu", `rows[].enabled`, absent = on):
  `POST /api/live/wsl/agents/enabled {distro, id, enabled}`; drawn at once, put back with "The switch could not be saved…" when
  the request fails or answers `ok: false`. The Windows switch is unchanged (agentRow's env takes `toggleLabel` and `onToggle`;
  an env without `onToggle` never reaches Windows' save).
  The phone's New chat follows it too: `GET /api/remote/new/options` gives a WSL project its own `agents` list (each agent on or
  off by that distro's switch, "Turned off for Ubuntu in Settings on your PC (AIB Linking (WSL))."), the phone offers that list
  for the project, and a phone's Start in a WSL project is checked against it (`remote/newchat.ts agentsFor`); Windows projects
  and the top-level list keep the Windows switch.
- The chip: Install failed / Not installed / Update available / Signed in / Not signed in / Installed (AIB's copy) / Found.
- Sign-in (`rows[].signin`): "Signed in to Claude Code in Ubuntu as <account>", "Not signed in … yet" with **Sign in**, or
  "Sign-in in Ubuntu: unknown (<note>)". Sign in (signed out; or unknown for Claude Code and Codex) runs the WSL sign-in terminal
  `signin=<agent>&distro=<d>` in a panel on the card; `start=1` only when the distro is not running at that click. Exit 0 reads
  the agents again (`force=1`).
- **Uninstall** only when `canUninstall`: a confirm question ("This deletes only the copy AIB installed there
  (~/.aib-server/agents/claude). Your own installs of Claude Code and your sign-in in ~/.claude in Ubuntu stay."), then
  `POST /api/live/wsl/agents/uninstall {distro, id}`; `blocked` (or `message`) shown verbatim on the card.
- Codex: `rows[].limits` in the composer Limits chip's words (`composer-chips.js describeLimits`): "Usage limits of Ubuntu's
  Codex sign-in: 5h 32% · wk 10% (updated 4 min ago). Same ChatGPT account as on Windows means the same limits."
- An agent's Install says "Needs Node.js first" (off) while the prerequisites say Node.js is not ok; the row's own nvm line only
  shows while the prerequisites are not known (an older server).
- Tests: `work/test_wsl_settings.js` (the drop-down rules, the switch with rollback, the five Node.js states, git/curl, the Node.js
  terminal's address, sign-in and `start=1`, uninstall, limits, no `start` on open); `work/test_wsl_ui.js` (signinUrl keeps
  `distro` for a distro setup step).

## Remove AIB from a distro (Linking (WSL) phase 3: server and helper)

Design: `docs/wsl/linking-design.md` section 13 (the contract and the REMOVE RULES). Helper: `server/wsl/helper/aib_remove.ts`;
Windows: `server/wsl/remove.ts` (the order and the last step), `server/wsl/removed.ts` (the flag), `server/web/wsl_routes.ts`.

**Routes** (the page token, as every WSL route):

- `GET /api/live/wsl/aib?distro=<d>&peek=1[&start=1]`: not ready -> `{distro, name, state, line, usage: null}` (never started);
  ready -> `{distro, name, state: 'ready', line: '', usage: AibUsage}`. `AibUsage` (contract.ts) = `{root, totalBytes, current,
  parts: [{key, label, bytes, path}], versions, agents: [{id, versions, bytes}], dataFolders: [{name, mine, keeperAlive, bytes}],
  worktrees: {count, dirty}, chatsWorking, partial?}`. Part keys in order: `versions` (every `<ver>/`), `agents` (agents/ without
  the cache), `npmCache` (`agents/.npm-cache`), `data` (this AIB's `data-<hash>/` without its worktrees and keeper), `worktrees`
  (`<data>/worktrees`), `logs` (`<data>/keeper`: the keeper's chat journals and log), `other` (other data folders, an old
  root-level `helper/`, anything else). `chatsWorking` is Studio's busy chats in that distro (`LiveBackend.busyConnections`).
  `partial: true` when the walk ran out of time (10 s) or entries (1,000,000): the sizes are then at least these. An older helper:
  `usage: null` with "The AIB helper in Ubuntu is too old to show this. Restart AIB."
- `POST /api/live/wsl/aib/remove {distro, mode: 'check'|'apply', confirm?: boolean}` -> 200 `{ok, mode, blocked: string[],
  wouldRemove: [{path, what, bytes}], kept: [{path, why}], removed: string[], left: string[], message?}`. 400 `bad_mode`; 'apply'
  without `confirm: true`: 400 `confirm_needed`. Never starts a distro: 409 `wsl_unavailable` when it is not ready (and while it is
  removed). `blocked` lines are for the page verbatim. 'check' changes nothing.
- `GET /api/live/wsl/status` distros gain `removed: boolean`; such a distro reads `state: 'off'`.
- "Set up again" is the existing start: any `start=1` (agents, prereqs, aib) or `POST /api/live/wsl/reconnect` on a removed distro
  clears the flag and forgets the stopped host, so the next start installs AIB again (copies the programs, a new data folder).

**Helper methods** (offered only with `--data`): `aib.usage {}` -> `AibUsage` (chatsWorking 0; AIB fills it in);
`aib.remove {mode}` -> the result above plus, for 'apply', the helper-only `final: {data, version, root, copies}` (what the last
step may delete; the chat copies deleted), which never reaches the page.

**What goes, what stays.** Only this AIB's `data-<hash>/` (its chat copies, worktree registry, sync and merge files, keeper
journals and log, helper sockets). The shared parts, `agents/` (with `agents/.npm-cache`), every `<ver>/` and an old root-level
`helper/`, go only when there is no other `data-*` folder at all (a stopped one counts too: that AIB build needs them again; a live
one is found by connecting to its `keeper/keeper.sock`) and no program other than this AIB's own runs from, works in or names them
(`/proc` read by sh: exe, cwd and arguments; this AIB's own are the ones started with `--data <its data folder>` and the MCP relay
on `<data>/helper/mcp.sock`). Otherwise they are kept and listed with why. The root itself goes only with `rmdir` (when empty), and
only when nothing in it was kept; anything in the root AIB did not make is kept. `~/.claude`, `~/.codex`, nvm, asdf and the projects
are never inside the root, so never named; `kept` lists `~/.claude`, `~/.codex` and each project for the confirm dialog. Chat
branches stay (`git worktree prune` only).

**Refused** (`blocked`, nothing deleted): a chat of this AIB in the distro is working; the distro's Linux keeper has a live chat or
terminal (AIB's own channels left out); a sign-in or Node.js set-up terminal for it is open; an agent install runs (Windows'
progress, or a live pid in `agents/<id>/install.lock`); a chat copy has uncommitted changes (`git status --porcelain
--untracked-files=all`: untracked files count, ignored files do not) or cannot be checked (its project is gone); a program works
in this data folder (a shell in a chat copy); the process list cannot be read; a guard below fails.

**Guards** (helper, `aib_remove.ts`; every one unit-tested in `wsl_linking_remove_helper_test`): the root is a plain absolute
path (no `.`, `..`, `//` or trailing `/`), at least two folders deep, named `.aib-server` or `aib-wsl-test-*`, not on `/mnt/<drive>`,
not the home folder nor above it, a real folder (not a link) whose real path is itself; the data folder is exactly
`<root>/data-<12 hex>`, a real folder. Deletion walks the tree with Deno's `lstat` / `realPath` / `readDir` / `remove` (one name
at a time, never recursive): a link is unlinked as a name inside the root and its target never touched, a folder's real path must be
itself before its entries are read and again before each entry goes (a folder swapped for a link mid-walk stops the walk), the
parent's real path must be itself, nothing outside the root is ever named, and another file system (a mount point) is never entered.

**Test guard** (three layers): under `AGENT_STUDIO_TEST=1` AIB passes `AIB_WSL_TEST=1` to the helper (hosts.ts helperEnv), whose
root must then be `/tmp/aib-wsl-test-*` and never `$HOME/.aib-server`; the Windows side refuses a real host whose root is not the
test's own `AIB_WSL_ROOT` (`remove.ts testGuard`, before the helper is asked anything); the last step gets the flag too and
refuses anything but `/tmp/aib-wsl-test-<name>` (no deeper folder). So no test can touch the owner's real root.

**The apply order** (`remove.ts removeAib`, its order asserted step by step in `wsl_linking_remove_test`):

1. AIB's refusals + helper `aib.remove {mode:'check'}`; any refusal: `ok: false`, nothing changes.
2. The `removed` flag (`<state folder>/wsl-removed.json`, survives a restart): from here `wslHost()` and `peekWslHost()` give no
   host for the distro, so nothing (a chat, the take-over at start, Files, a sign-in terminal) can start it or install AIB again;
   they say "AIB was removed from Ubuntu. To use it there again, open Settings > AIB Linking (WSL) and click Set up again."
   AIB's own refusals run once more right after it (a chat that went live just before the flag): any, and the flag is undone.
3. The keep-alive in the Windows keeper is stopped (`releaseHold`).
4. Helper `aib.remove {mode:'apply'}`: the refusals run again (any: the flag is cleared and the keep-alive comes back; nothing was
   deleted); then the chat copies are deleted, `git worktree prune` runs in each of their projects (while the helper still runs;
   prune is a no-op until the copies are gone, so it comes right after them), then the rest of the data folder but `keeper/` and
   `helper/`, then the shared parts that may go, except the current `<ver>/`.
5. The helper's channel is ended and the Linux keeper shut down WITHOUT force (`hosts.ts shutdownKeeper`): a chat that went live
   meanwhile refuses it, and the folder is then left and reported. From this step the host never reconnects.
6. The host stops for good (state 'off' with the flag; never half-started) and is forgotten (`WslHosts.drop`).
7. **The last step (the self-deletion problem).** The keeper's socket, lock and journals (`<data>/keeper/`), the helper's sockets
   (`<data>/helper/`) and the current `<ver>/` (the programs both run from) cannot go while they run, and the helper is gone by now.
   So one hidden `wsl.exe -d <distro> --cd ~ --exec /bin/sh -c FINAL_CLEANUP_SCRIPT sh <root> <data-name> <ver or -> <root may go>
   <test>` (fixed script text; the five values only as `"$1".."$5"`, every one non-empty, checked on Windows (`finalArgs`) and again
   in the script with the same root guards) waits up to 15 s for every process that runs from, works in or names the data folder
   (keeper, bridges, relay) to end, then deletes it with `rm -rf --one-file-system --` (GNU rm never follows a link and does not
   cross into a mount), then the `<ver>/` (only when the helper said so, after up to 10 s more for programs running from it), then
   `rmdir` on the root (only when the helper said it may go; rmdir fails on a folder that is not empty). It prints
   `removed=`, `left=<path>: <why>`, `gone=` or `error=` lines.
8. The chat copies deleted are remembered (`wsl-removed.json` `worktrees`), so their chats read as "workspace removed"
   (`wsl/worktrees.ts wslIsRemoved` answers before asking the distro; kept after Set up again, the copies stay gone).
9. The report: `removed`, `left` and `message`; `ok` only when nothing was left and every step ran. A helper that fails in the middle
   of step 4: everything is stopped (flag kept) and the last step never runs blind ("Some of AIB may be left: click Set up again,
   then Remove again").

Idempotent: Remove on a distro with nothing left is fine (a root that is not there: "nothing to remove"); after Set up again it
removes the new install the same way.

**Tests:** `wsl_linking_remove_helper_test` (an in-memory Linux file system with links, a mount and a mid-walk swap: every guard,
links to a canary outside the root unlinked with the canary intact, every refusal deleting nothing in check and apply, what stays
with another data folder, a program in `agents/`, nothing else; usage), `wsl_linking_remove_test` (FakeWslHost: route shapes, peek,
409 without a start, the exact apply order, the flag and Set up again, refusals and failures, the test guard, the last step's
arguments), `wsl_linking_remove_e2e` (real distro, below).

### Phase 3 (page; design section 13): "AIB in Ubuntu" and Remove

- **AIB in Ubuntu**: the last card of a ready distro's group (a distro that is not ready shows only its status card, with Start
  Ubuntu and check). It reads `GET /api/live/wsl/aib?distro&peek=1` (again after a minute, `force=1` on its **Refresh**; never
  `start`).
- The card: "Everything AIB keeps in Ubuntu, in <root> on this PC", the disk use by part (`usage.parts`: label and size, the
  part's folder on hover; the agents of `usage.agents` with their versions under the agents part; "In all" = `totalBytes`).
- Then the lines "AIB versions installed: <current> (current), <older>", "Chat copies: 3, 1 with uncommitted changes" (none / none with
  uncommitted changes), "Chats working now: N".
- **Other AIB folders in Ubuntu** (`dataFolders` where not `mine`): name, size, an "in use" chip when `keeperAlive`; read-only,
  with "These belong to another AIB build or data folder. Remove here never touches them."
- `usage: null` (not ready): the answer's line, no buttons. A read error: the reason, Remove and Refresh.
- **Remove AIB from Ubuntu** opens an in-page dialog in delete-project-ui.js's look (`.dp-dialog`, role alertdialog, Cancel
  focused, Escape and the backdrop cancel, focus kept inside) and posts `wsl/aib/remove {distro, mode: 'check'}` (deletes
  nothing).
- The dialog lists `wouldRemove` grouped by `what` (size per group and in all, each path under it), `kept` with each `why`, and
  always "Your projects, ~/.claude, ~/.codex, nvm and asdf are not touched." and "Chat branches stay in your repos."
- `blocked`: "AIB cannot be removed from Ubuntu now:" and each reason verbatim on its own line; the Remove button is off, the
  others are Close and **Check again** (a new check).
- Confirm: a second click on "Remove AIB from Ubuntu" (the first shows "Choose Remove AIB from Ubuntu again to delete these. This
  cannot be undone."); when the card's `usage.chatsWorking` is above 0 the tick "I understand chats running in Ubuntu will stop"
  replaces the second click. No other gate.
- Apply: `{distro, mode: 'apply', confirm: true}`; the button reads "Removing…", every dialog button is off, the card's Remove and
  Refresh are off with "Removing AIB from Ubuntu…". Nothing changes on the page before the answer.
- `ok: true`: the dialog closes; the group shows "AIB is not set up in Ubuntu." with **Set up again** (the Start and check request,
  `agents?peek=1&start=1`, which clears the server's removed flag); no other cards; the overview chip reads "Not set up".
- `ok: false` with `blocked` (refused when it ran again): the reasons as above, nothing removed. `ok: false` without (partial):
  "AIB could not remove everything from Ubuntu.", `message`, "Left in Ubuntu:" (`left` verbatim) and "Removed:"; only Close; the
  not-set-up card keeps the message and the left list until Set up again. A failed request: its message, Remove can be tried again.
- `status.distros[].removed` (with state `off`) draws the same not-set-up state after a reload; the distro stays in the drop-down.
- Tests: `work/test_wsl_settings.js` (phase 3: the card's parts, versions, copies, other folders; peek only on open; the dialog
  from check, grouping, kept, blocked; the second click and the tick; success, partial and refused applies; the removed flag after
  a reload; buttons off while it runs; each distro's own card through the drop-down).

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
| `wsl_keeper_grace_e2e` | with a 45 s grace: the transport and the keep-alive dropped the way an older build did, the agent still runs past the old 35 s and a new AIB takes the same chat over; then, alone for the whole grace, the agent stops (`orphaned`) and the Linux keeper exits with its log line |
| `wsl_agent_e2e` | a fake agent in the distro; a crashed AIB's chat taken over; Quit AIB with the agent working keeps it (keep-alive + hold, no tray restart) and the next AIB takes it and the keep-alive over once |
| `wsl_files_changes_e2e` | Files and Changes from the distro (`Foo` and `foo`, exec bit, untracked, diff) |
| `wsl_terminal_e2e` | the login shell in the Linux folder, resize |
| `wsl_browser_shim_e2e` | asked first, opened in a sign-in window, `file:` refused |
| `wsl_sessions_e2e` | an ended chat listed after a restart, its history read in the distro, continued there |
| `wsl_worktrees_e2e` | a chat's worktree and branch in the distro, its Changes branch view, restart re-adoption, Discard, a refused out-of-root plan, a non-git folder in place |
| `wsl_local_only_e2e` | a repo with the user's own `/private/` exclude: a chat's copy gets `/private` in AIB's block first, no `private/` in the copy, `session/new` with `additionalDirectories` = the main folder's `private/` (Linux path) and the note; the agent writes there; Files' local-only part and a read of `private/review/x.png` from the main folder; Git exclude from the copy writes the repo's exclude file and moves the folder, Undo, `..` and a root outside the copies refused; sync and Merge leave `private/` out |

| `wsl_import_e2e` | the one-off import over a temp repo: chats started in the project, in a subfolder, running (a process naming the id), in another tool's worktree, already imported, and a Codex one; a dirty main refuses apply and writes nothing; the dry run leaves every file as it was; the test guard; apply of one, then all, then a no-op re-run; one row per chat; Continue resumes in the copy (the agent's edit lands there), Changes shows the branch, Merge lands, Codex resumes in its copy; the same dry run through `--helper-bin` from `/mnt/c`; undo refuses the merged chat and restores the others (history back, no copy, no branch) |
| `wsl_sync_e2e` | live sync with the helper's poll stretched to 5 minutes, so only inotify wakes a scan: events counted, a user edit and a new file in the copy within seconds, the prompt's note naming them, the helper killed and a new one catching up, Merge after sync landing only the chat's change, an edit both made merged at the next turn, a clash kept with its markers and the clash line until the chat resolves it |
| `wsl_tunnel_e2e` | the tunnel entry run inside the distro: a tools/list reaches AIB and the WSL tool list comes back, also with interop off for the forwarder (`unshare -rm`, `/run/WSL` hidden); a wrong key refused; a helper without the tunnel falls back to the interop entry, which cannot start with interop off |
| `wsl_merge_e2e` | through AIB's merge routes: a clean merge with its note, a conflict sent back and then resolved, a merge in progress in the main checkout refused, a merge after an AIB restart, a clash kept in the stash with the clash line and Keep my version, uncommitted main edits put back, the Merge button |
| `wsl_phase2_e2e` | a picture served from the distro's bytes, outside files (and AIB's own folder refused), project trash (refusals, `gio`, the freedesktop trash by hand, under the test's own `XDG_DATA_HOME`), Codex limits |
| `wsl_fixes_e2e` | the set-up probe with `-` for no `AIB_WSL_ROOT` answers `$HOME/.aib-server` (read-only); the New project dialog's check and create in the distro (new, existing, missing parent, with and without a name and git init) |
| `wsl_docs_e2e` | an agent in the distro makes, reads and edits a doc through its real tunnel entry (Linux paths in the answers); doc.aibdoc valid JSON in the distro; the user's route edits and typing with an agent's stale rewrite refused; a sed in the distro taken in; history; Changes' doc row; a big doc in chunks; a symlink out refused; a restart from the cache and a rebuild from a changed file; Move doc to trash into the test's trash |
| `wsl_agent_install_e2e` | the distro's own Node.js found (or the missing line with its command, nothing created); with a stand-in login shell, stub node and stub npm: Check again finds a new node, `npm ci` into the test root's `agents/` with AIB's lockfile and cache, detect and a chat's launch use it, Cancel kills npm and removes the folder |
| `wsl_bgtasks_e2e` | a program named claude started with `--resume <id>` in the distro: Continue refused with its Linux pid, then continued once it ended; AIB's own agent (also named claude with `--resume <id>`) never counts, and is found when not excluded; a saved session's background command listed running with its output; a chat with a background shell in the distro stays in the busy list until the shell ends |
| `wsl_linking_routes_e2e` | phase 2 routes: peek, Uninstall and the Node.js terminal make no host before AIB used the distro; with the real helper and a stand-in login shell, `prereqs?start=1`, the rows' `enabled` / `signin` / `canUninstall` / `limits`, Uninstall and the Node.js terminal (the "too old" answers while the helper lacks the phase 2 methods); the Node.js script run with bash in the distro against a stand-in install.sh (`file://`): checksum gate, PROFILE per login shell, the 22.19 minimum, every command printed |
| `wsl_linking_helper_e2e` | `env.prereqs` on the distro as it is (asdf shim: ok, npm found next to the real node, no nvm offer); with a stand-in login shell: Node.js missing, too old, an asdf shim with no version, each after `force`; `agents.uninstall` refused while a test process runs from the fake agent folder, then removing only it, a linked `agents/<id>` left alone; `agents.signinStatus` over fake credential files, the fake token never in the answer |
| `wsl_linking_remove_e2e` | "AIB in <distro>" and Remove, all under `/tmp` (the root asserted first; a canary folder, a temp HOME with `.claude` / `.codex` sentinels and the project outside the root): usage with a second fake data folder whose stand-in keeper listens; a dirty chat copy refused (nothing deleted); with that keeper alive only this AIB's data folder goes (agents, every `<ver>`, the root kept), the copy pruned, the branch kept, no process of it left, status removed + off, a second apply 409; Set up again with a stand-in program in `agents/`: agents kept, both `<ver>` gone; then everything incl. the root; again after Set up again; the last step's guards on temp folders; links inside the root to the canary and the temp HOME unlinked only |
| `wsl_linking_e2e` | Settings' peek before AIB used the distro makes no host; with a stand-in login shell and asdf's layout (shims for node, npm, codex-acp; a fake `@agentclientprotocol/codex-acp` with its `@openai/codex`): detect resolves the shim to `[real node, entry]`, `signin` and `bundledCli` name the bundled CLI, the peek row says so, the Codex sign-in runs it |

Isolation: everything goes to `AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>` instead of `~/.aib-server`, the agents' `HOME`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are inside it (`wslTestHomeEnv`), the agent is `work/fake_acp.py` run with the distro's
python3, and the Linux keeper a test started is shut down at its end. The tests never run `wsl --shutdown` or `--terminate` and
never read the owner's `~/.claude` or `~/.codex`. Unit tests without a distro: `wsl_unit_test`, `wsl_studio_test` (a FakeWslHost
over a real keeper), `wsl_hosts_test`, `wsl_helper_test`, `wsl_phase2_test`, `wsl_docs_test`, `wsl_worktrees_test`, `wsl_local_only_test`, `wsl_merge_test`, `wsl_sync_test`, `wsl_bgtasks_test`, `wsl_linking_test`, `wsl_linking_routes_test`, `wsl_linking_helper_test`, `wsl_linking_remove_test`, `wsl_linking_remove_helper_test`, `wsl_gates_test`, `wsl_location_test`, `wsl_fixes_test`, `keeper_stream_test`; Go:
`TestAibOwnChannelsAreNotWork`, `bridge_test.go` (Linux).

## Not done yet (phase 2)

- Stopping a WSL chat's background command from AIB (no Stop on its row; the agent can stop it).
- Background commands of Codex sessions in WSL (Codex keeps no saved-session list AIB reads, as on Windows) and ownership hints of
  OMP sessions in a distro (AIB reads only the distro's Claude Code folder).
