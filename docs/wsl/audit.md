# WSL projects: audit of project-path sites in the server

Scope: `outputs/agent-studio/server` (Deno/TS) plus the Go keeper where it matters. The server uses no root-level scripts for project work (none found).
Categories: **A** = must run in the WSL helper for WSL projects; **B** = fine on Windows (AIB state, app assets); **C** = path translation / path model only; **D** = Windows-only feature to turn off for WSL projects.
A row may name a main category plus a second one in the note. Line ranges are approximate function bounds.

Key facts that shape the table:
- Today every WSL path is **refused on purpose**: `web/security.ts:247 isNetworkPath` matches `\\wsl$\…` / `\\wsl.localhost\…`, and 20+ gates call it (see "Gates" below). Nothing reads WSL files yet.
- The path libraries choose Windows vs POSIX behaviour from `Deno.build.os` for the whole process (`ospath.ts:8`, `pypath.ts:6`, `purepath.ts:6`, `path.ts:19`). They have no way to handle one Linux path inside a Windows process.
- git runs through **three separate spawn paths**: `worktrees.ts:121 runProcess` (used by wt.git, merge.ts, sync.ts), `changes.ts:65 runGit` (also files.ts), and `files.ts:119` (its own `check-ignore`). There is also `desktop/folders.ts:328 runCommand` (git init).
- The Go keeper already builds for Linux (`proc_unix.go`, `pty_linux.go`, unix socket or TCP loopback `main.go:183-200`), so it can serve as the base for agent spawn, pipes and PTY inside WSL.
- Most A sites are **synchronous** (`Deno.*Sync`, `osp.isdir`). Moving them behind an RPC means turning their callers async, and that work costs more than writing the RPC.

## platform/ and path helpers

| file:line | what it does | cat | note |
|---|---|---|---|
| platform/ospath.ts:8-128 | ntpath-style splitdrive/normcase/normpath/split/join, chosen once per process | C | `/home/u/p` turns into `\home\u\p`; normcase lowercases case-sensitive Linux names |
| platform/ospath.ts:131-165 | abspath/realpath (joins with Deno.cwd, Deno.realPathSync) | C | a Linux path has no drive, so it is treated as relative to the AIB folder; UNC realpath gives `\\?\UNC\…` |
| platform/ospath.ts:167-194 | exists/isdir/isfile/islink/getsize (stat) | A | used by almost every project site; over 9P it is slow and cannot follow absolute Linux symlinks |
| platform/ospath.ts:197-209 | commonpath (inside checks) | C | compares case-insensitively |
| platform/ospath.ts:212-214 | home() = USERPROFILE | C | the WSL home is `/home/<user>` (agent dirs, `~`) |
| platform/pypath.ts:14-39 | splitRoot/pathStr/isAbsolute | C | `/home/x` is "not absolute" on Windows; pathStr rewrites separators |
| platform/pypath.ts:56-69 | expandUser | C | `~` expands to the Windows profile |
| platform/pypath.ts:75-114 | pyStat/isFile/executable/resolvePath | A | `executable()` is always true on Windows, so exec bits cannot be checked |
| platform/pypath.ts:123-148 | which (PATH + PATHEXT) | A | finds Windows binaries; WSL needs a Linux PATH lookup |
| platform/path.ts:4-21 | dirname/basename/join | C | joins with `\` on Windows |
| state/paths.ts:100-188 | pathOf/abspath/realpath/samePath/normcase | C | same lowercase-key problem |
| state/agent_options.ts:54 | path key `w:`/`p:` by flavour | C | already flavour-aware: a good model to copy |
| transcripts/purepath.ts:6-7,101-165 | nativePath/join/samePath/relativeParts | C | already has `purePath(text, windows)`: reuse it for a per-path flavour |
| transcripts/purepath.ts:180-277 | resolve/isFile/isDir/globTail/rglobTail/statSig | A | transcript folder scans |
| web/security.ts:247-256 | isNetworkPath/refuseNetworkPath | C | the master gate that refuses WSL paths; needs a "known WSL project" exception, not a blanket allow |
| platform/pty.ts:56-96 | findOnPath/defaultShell/spawnPty | A | WSL shell = bash in the distro (keeper PTY in WSL; `wsl.exe --cd` is a stopgap) |
| platform/pty_windows.ts, pty_posix.ts | ConPTY / openpty FFI | B | the posix version can be reused unchanged in a Deno helper |
| platform/process_tree.ts, descendants.ts, process_info.ts | kill agent tree, busy-children detection | A | from Windows only `wsl.exe` is visible, not the Linux agent tree |
| platform/console.ts, console_spawn.ts | hidden console for spawned programs | D | Windows-only; does nothing in WSL |
| platform/spawn_detached.ts, lock.ts, disk.ts, acl.ts | AIB host/keeper start, state locks, disk space, ACLs | B | AIB state |

## worktrees/worktrees.ts (worktree manager)

| file:line | what it does | cat | note |
|---|---|---|---|
| 102-112 | gitEnv (inherit env, drop GIT_*) | A | Windows env (Path, USERPROFILE) must not leak into Linux git |
| 114-118 | encodeInput: `\n` becomes `\r\n` on Windows | C | would corrupt stdin for Linux git (update-index, hash-object) |
| 121-186 | runProcess/realGit/git/rawGit (Deno.Command git, cwd=project) | A | git choke point #1: route by project location |
| 190-204 | norm/same (normcase(realpath)) | C | lowercasing |
| 211-227 | lexists/exists | A | |
| 230-243 | relpath (drive compare, Deno.cwd) | C | |
| 246-280 | rmtree/removeQuietly | A | deletes worktree folders |
| 292-447 | Registry (studio-worktrees.json in stateDir) | B | stores Linux paths as strings; fine |
| 460-470 | pin/unpinUserBase (git update-ref) | A | |
| 479-523 | readers.read, mainCheckoutOf (.git file, gitdir, commondir, HEAD) | A | gitdir contents are Linux paths (also C) |
| 525-621 | worktreeRoot/cachedLookup/projectOfWorktree (walk parents, stat .git) | A | also C: relpath across "drives", regex for both separators |
| 627-666 | ProjectResolver (registry stat B; same/realpath on cwd) | C | |
| 695-740 | mainBranch/whyInPlace (rev-parse, symbolic-ref) | A | |
| 755-786 | snapshotSize (lstat each file), hasUncommitted, snapshotCommit, gitDirOf | A | temp index file inside the repo's .git |
| 801-859 | advanceUserBase (makeTempDir in .git, readLink, stat mode, hash-object) | A | on Windows the mode is forced to 100644, which would drop Linux exec bits |
| 870-893 | pauseLock/worktreeLock/syncPaused | B | lock files in stateDir |
| 901-934 | fileMatchesBlob/touchedPaths | A | |
| 936-972 | copyEnvFiles (readDir, copyFile, utime) | A | |
| 974-1004 | hasLfsPointers (git grep, check-attr --stdin, open files) | A | |
| 1016-1049 | plan/planWithReason (worktree path = stateDir/worktrees/<hash>) | A | a WSL repo's worktree must live inside the distro: needs a per-environment root |
| 1055-1120 | create (mkdir, makeTempDir under root, `git worktree add`) | A | |
| 1123-1150 | #discard (realpath "inside root" check, worktree remove, rmtree) | A | the delete safety check is tied to the Windows root |
| 1150-1335 | hasChanges/#attemptRemoval/remove/retryPending/ensure/cleanupIncomplete | A | |

## worktrees/sync.ts (live sync: project folder to worktree)

| file:line | what it does | cat | note |
|---|---|---|---|
| 78-80 | projectKey normcase(realpath) | C | |
| 107-188 | sync flag file, pause/resume (stateDir) | B | |
| 190-200 | statusPaths (git status) | A | |
| 204-258 | sigOf (lstat), envFiles (readDir walk) | A | |
| 260-318 | readTextReplace/fileTextHasMarkers/locked/sameBytesOf/sha | A | `locked()` tests a Windows sharing lock, which means nothing on Linux (D-ish) |
| 324-405 | replaceWithRetry/mkstemp/copyMode/writeAtomicBytes/copyAtomic/removeFile | A | |
| 409-425 | tellIndex (ls-files, add -N, update-index) | A | |
| 427-505 | readBytes/blobBytes/hashOf/threeWay (scratch files + git merge-file) | A | |
| 563-590 | settleConflicts | A | |
| 668-720 | DirWatcher: Deno.watchFs recursive | A | ReadDirectoryChangesW over `\\wsl.localhost` does not deliver events; needs inotify in WSL |
| 723-915 | ProjectSync run/listing/scan | A | |
| 938-944 | folderOffBranch | A | |
| 946-1600 | LiveSync: chatOpened, finishTurn (1168-1300), blocked (1399-1420), syncChat (1423-1518), syncEnv (1520-1547), diffAgainstUser (1549-1576), catchUp | A | about 60 sync fs calls plus git per turn; move the whole engine into the helper |

## worktrees/merge.ts

| file:line | what it does | cat | note |
|---|---|---|---|
| 95-103 | repoLock (in-process mutex keyed by normcase) | C | must stay in one process per project |
| 105-160 | git/gitc/configured/rev/isAncestor/gitDir/mergeInProgress/folderState (stat MERGE_HEAD, index.lock) | A | |
| 161-226 | porcelainPaths/rawDiff/landingFiles/baseCheckout (`worktree list`) | A | baseCheckout parses Linux paths (C) |
| 256-262 | insideFolder (realpath + normcase) | C | |
| 318-400 | Chat (isdir record.path) | A | |
| 406-465 | unmerged/readText/isFile/checkResolution/commitPending/updateFromBase | A | |
| 500-638 | squash (temp index in .git, rawGit), prepareLanding (rebase/cherry-pick), fastForward, rebuildUserBase, resetTo | A | |
| 643-912 | merge/mergeRounds/stashUserWork/dropStash/unstash/treeLanding/land | A | |
| 949-987 | clash file read/write (stateDir) | B | |
| 989-1001 | hasMarkers (reads project file) | A | |
| 1003-1145 | unresolved/clashStatus/stashRefOf/resolveClash/keepMine/checkCombined | A | |
| 1157-1266 | status/requestMerge/mergeFromTool (orchestration) | A | moves with the above |

## worktrees/changes.ts, files.ts, outside_files.ts, chat_folders.ts

| file:line | what it does | cat | note |
|---|---|---|---|
| changes.ts:47-131 | gitPath/runGit (its own Deno.Command, byte caps, timeout) | A | git choke point #2 |
| changes.ts:145-164 | locate (rev-parse toplevel/prefix/HEAD) | A | |
| changes.ts:219-265 | realInside/readUpTo/readUntracked | A | |
| changes.ts:291-315 | commitExists/branchEntries | A | |
| changes.ts:384-432 | getChanges/getBranchChanges | A | |
| changes.ts:467-524 | getFileDiff/fileDiff | A | |
| files.ts:36-91 | safeParts/within/realRoot/resolveInside (isNetworkPath, realPathSync) | A | also C: the gates at 39/60/67/83 |
| files.ts:94-155 | gitInfo/ignoredOf (git spawn #3, check-ignore --stdin)/statusOf | A | |
| files.ts:177-240 | listDir (stat, readDir, realPath of links) | A | |
| files.ts:247-303 | buildIndex/indexOf (ls-files + readDir walk) | A | |
| files.ts:364-410 | readFile (stat, open, read cap) | A | |
| files.ts:412-428 | mainFolderOf (.git marker) | A | |
| outside_files.ts:23-82 | checkShape/inDataFolder/resolveOutside (realPath, stat) | A | paths a WSL agent mentions are Linux paths (also C) |
| outside_files.ts:109-172 | chatTexts (reads transcript files) | A | |
| outside_files.ts:184-218 | folderLabel (.git marker) | A | |
| outside_files.ts:220-256 | readOutside | A | |
| chat_folders.ts:10-49 | repoBranch (realpath, .git, HEAD) | A | gate at :11 |
| chat_folders.ts:75-104 | changesFolder/artifactFolder (isdir cwd) | A | |
| chat_folders.ts:118-150 | changesResponse | A | |

## web/ routes

| file:line | what it does | cat | note |
|---|---|---|---|
| files_routes.ts:40-60 | pick the Files root (isNetworkPath, isdir project, mainFolderOf) | A | gates at 46/52 |
| files_routes.ts:90-110 | list/search/read dispatch | A | search itself is in-memory |
| file_tickets.ts:16-42 + artifacts/origin.ts:472-497 | ticket for a project file, then serveTicket readFileSync | A | serves raw project bytes on the artifact origin |
| terminal_routes.ts:60-80 | project terminal attach (cwd from query) | A | |
| terminal_routes.ts:105-134 | sign-in / setup terminals in USERPROFILE | D | v1: Windows-only; a WSL agent sign-in needs a distro shell (later A) |
| docs_routes.ts:140-155 | new doc name check (docs.exists, folderTaken) | A | |
| docs_routes.ts:340-372 | trash a doc folder (layer.trash) | A | the Recycle Bin path does not apply (D) |
| docs_routes.ts:374-490 | revealExport / writeNew to Downloads | B | |
| docs_routes.ts:585-595 | stat docDir | A | |
| project_routes.ts:50-105 | delete project: inspect/deleteFolder | A | see project_delete.ts |
| studio_routes.ts:145-190 | folders check/kinds/gone/start/create routes | A | also C |
| server.ts:60-90, 420-435 | APP_ROOT assets | B | |

## desktop/

| file:line | what it does | cat | note |
|---|---|---|---|
| folders.ts:59-90 | isScratch/isWorktree (reads .git) | A | gate at 68 |
| folders.ts:92-120 | folderKinds/worktreeParent | A | refuses `\wsl$` on purpose (95/112/115) |
| folders.ts:156-320 | validatePath/checkPath/normalizeFolder/validateName/checkProject | C | plus stat of the path (A); gates at 203/277 |
| folders.ts:328-420 | runCommand/createFolder/createProject (mkdir, git init) | A | git spawn #4 |
| folders.ts:426-470 | FolderMemory (state file) | B | isdir of the remembered folder at 451 is C |
| folders.ts:474-500 | startFolder/startDir | C | |
| folders.ts:552-688 | pickerPlan/pickFolder (PowerShell folder dialog) | C | the dialog can browse `\\wsl.localhost`; its result must be recognised as WSL |
| folder_presence.ts:20-62 | "folder gone" check (stat; network paths count as present) | A | v1 can treat WSL like a network path (C) |
| added_projects.ts:113 | refuse network paths | C | |
| project_delete.ts:21-38 | projectKey | C | |
| project_delete.ts:155-200 | hasRecycleBin/recycle (shell32 FFI) | D | |
| project_delete.ts:203-240 | POSIX trash (gio/trash) | A | runs in the helper |
| project_delete.ts:262-310 | remoteDrive/defaultGuard/refusal/worktreeOf | C | the delete safety guard, plus reading .git (A) |
| project_delete.ts:335-384 | realDir/inspect/deleteFolder (remove recursive) | A | |
| editors.ts:183-322 | detect installed editors | B | |
| editors.ts:338-450 | inside/cleanPathText/worktreeMain/readHead/real/resolveInside | A | also C; gate at 352 |
| editors.ts:503-578 | workspaceFolders/findWorkspaces (read .code-workspace in project + parents) | A | |
| editors.ts:579-630 | buildCommand | C | VS Code/Cursor: `--remote wsl+<distro> <linux path>`; other editors D |
| editors.ts:645-680 | realPopen (cwd = folder) | C | |
| editors.ts:679-785 | Launcher.open (isdir/exists) | A | |
| editors.ts:797-815 | knownRoots | B | |
| native.ts, notify.ts, tray*, window*, updater.ts, update_helper.ts, single_instance.ts, shortcut.ts | app shell | B | |

## host/studio.ts, acp/

| file:line | what it does | cat | note |
|---|---|---|---|
| studio.ts:645-690 | artifactMcpServers/#artifactStdioEntry (Windows forwarder exe, 127.0.0.1 URL, stateDir URL file) | A | a Linux agent cannot reach these: needs a Linux forwarder in the helper plus a tunnel |
| studio.ts:690-722 | listAgentSessions (cwd filter) | C | |
| studio.ts:724-780 | agent-options #probe (isdir/realpath cwd, spawns the agent there) | A | |
| studio.ts:786-870 | connect (realpath/expandUser/isdir workspace, worktree plan/ensure) | A | also C |
| studio.ts:994-1060 | rebuild chats from keeper notes (cwd) | C | must also know which keeper (Windows or WSL) |
| studio.ts:1336-1346 | ownershipQuery (isNetworkPath gate) | A | |
| studio.ts:1354-1400 | worktree record / connections by same(cwd) / worktree routes | C | |
| connection.ts:433-458 | resolvePath/resolveProgram (realPath, PATH+PATHEXT stat) | A | resolves the Windows agent binary |
| connection.ts:785-823 | constructor (projectOfWorktree, WriteTracker, caps) / retarget | A | |
| connection.ts:825-850 | startProcess: Deno.Command(agent, cwd) | A | |
| connection.ts:852-862 | #startInKeeper: keeper.spawn {cwd, env: whole Windows env} | A | must go to the WSL keeper with a Linux env |
| connection.ts:1165-1185 | client-terminal notes to the keeper | A | |
| connection.ts:1295-1310 | fs/write_text_file replay check (readFileSync params.path) | A | |
| connection.ts:2340-2365, 2484 | session/new and session/load with cwd | C | ACP cwd must be the Linux path |
| connection.ts:500-535 | testHomeEnv | B | tests |
| client_caps.ts:95-145 | isabs311/norm/inside/resolveInside (UNC refused 123-126) | C | |
| client_caps.ts:321-330 | whichIn | A | |
| client_caps.ts:495-530 | fs/read_text_file (stat, open) | A | |
| client_caps.ts:590-610 | fs/write_text_file (mkdir, write) | A | |
| client_caps.ts:650-725 | terminal/create (cwd check, program lookup, Deno.Command) | A | |
| keeper_terminal.ts:51-130 | client terminals as keeper channels | A | |
| breadth.ts:343-370 | session list cwd filter | C | |
| breadth.ts:489-516 | loadMcpConfig (user's --mcp-config file) | B | the entries it gives are Windows commands; a WSL agent needs Linux ones (note) |
| attachments.ts (whole) | prompt attachments, in memory | B | |
| msgqueue.ts:252-270 | QueueStore (stateDir) | B | |

## artifacts/

| file:line | what it does | cat | note |
|---|---|---|---|
| artifacts.ts:396-760 | ArtifactStore (stateDir) | B | |
| artifacts.ts:303-320 | pathKey/inside | C | |
| artifacts.ts:977-990 | readCapped (stat + read) | A | |
| artifacts.ts:1066-1120 | Service.resolvePath (publish from a project file: inside, realpath, isFile) | A | |
| artifacts.ts:1186-1290 | #publish/update from sourcePath | A | |
| artifacts.ts:1294-1376 | WriteTracker (paths agents wrote, from tool calls) | C | |
| artifacts.ts:1381-1515 | Watcher: polls stat of outputs/ and every sourcePath each second | A | polling over 9P is costly; needs a helper-side poll or watch |
| origin.ts:85-100 | registryType (reg.exe) | B | |
| origin.ts:369-470 | strictReal/makeHandler (artifact store) | B | |
| mcp.ts:188-195, 249-260 | envContext cwd + resolvePath(relative to the session folder) | C | the tool process runs where the agent runs |
| mcp.ts:236-246 | urlFromFile (STUDIO_ARTIFACT_URL_FILE in the Windows stateDir) | C | `/mnt/c/...` or handed over by the helper |
| mcp.ts:315-330 | rawRequest to 127.0.0.1 | A | WSL2 NAT: Windows loopback is not reachable from Linux unless networking is mirrored |
| mcp_http.ts:72-84 | forwardEntry (keeper exe + address file) | A | |
| mcp_http.ts:130-190 | address file publish | B | |
| keys.ts, libs.ts | keys/lib assets | B | |

## docs/

| file:line | what it does | cat | note |
|---|---|---|---|
| store.ts:197-206 | docId (project + name key) | C | |
| store.ts:267-340 | readText/exists/aibWritten/ownedPaths/isFile | A | |
| store.ts:363-375 | #cacheDir (stateDir) vs #docsDir/#oldDir (project) | A | cacheDir is B |
| store.ts:382-448 | #moveOld/#writeReadme (rename/mkdir/write in project) | A | |
| store.ts:450-510 | others/docDir/mirrorPath (readDir aib-docs) | A | |
| store.ts:512-668 | exists/open/list (readDir aib-docs + docs, stat; stateDir meta reads) | A | the meta reads are B |
| store.ts:670-680 | #readCache | B | |
| store.ts:680-853 | #load/#adoptCopies (read doc.aibdoc + md copies, remove legacy) | A | |
| store.ts:922-969 | #write (mkdir, atomic doc.aibdoc + page .md, remove stale) | A | |
| store.ts:970-997 | #saveState | B | |
| store.ts:1002-1143 | #sync (poll the .md copies against what was last written) | A | poll |
| store.ts:1569-1580 | discard (doc.dir + cache) | A | the cache part is B |
| charts.ts:270-296 | chart SVG assets in aib-docs/<doc>/assets | A | |
| drawing/assets.ts:60-80 | drawing asset read / atomic write | A | |
| drawing/files.ts:216-224 | importFile/exportFiles (agent-given path) | A | also C |
| rows.ts:25-40 | read doc.aibdoc titles | A | |
| history.ts:90-95 | versions from the artifact store | B | |
| drawing/demo_server.ts | dev demo | B | |

## transcripts/, ownership/, agents/ (agent session files under ~/.claude, ~/.codex)

| file:line | what it does | cat | note |
|---|---|---|---|
| core/options.ts:134 | claudeProjects = %USERPROFILE%\.claude\projects | A | WSL agents write `/home/u/.claude/projects`; needs one root per environment |
| transcripts/store.ts:77-118 | readRange/scanCwds | A | |
| transcripts/store.ts:120-360 | Store: readDir root, sidecar stat/read (gate at 153) | A | |
| transcripts/store.ts:474-576 | Catalog (all sessions) | A | |
| transcripts/store.ts:596-700 | latestAssistantModel/findSessionFile/modelInUse | A | |
| transcripts/transcript.ts:129-545 | Transcript tail (open/seek/read) | A | a single file could also be read over UNC (C) |
| transcripts/monitor.ts:165-228 | tempDir/commandOutput (%TEMP%\claude\…\tasks\*.output) | A | Linux keeps these under /tmp |
| transcripts/monitor.ts:337-340 | openSource | A | |
| transcripts/normalize.ts:339-372 | encoded/projectMatch/projectCwd (folder-name encoding, msys rewrite) | C | the encoding must use the Linux path |
| ownership/probe.ts:92-95 | defaultOwnersDir (LOCALAPPDATA) | A | |
| ownership/probe.ts:140-230 | processStartTime/processAlive/lockHolders | A | v1: D (skip the ownership check for WSL) |
| ownership/probe.ts:278-366 | fetchProcesses (CIM on Windows; /proc on Linux) | A | the /proc version already exists |
| ownership/probe.ts:413-430, 1251 | listdir of claude projects; claudeRoot | A | |
| ownership/ownership.ts:254-290 | probeExternalOwner (powershell.exe) | A | |
| agents/adapters.ts:128-300 | runCapture/loginShellPath/findNode/npmRoot/findPackageFile | A | the agent install is per environment |
| agents/adapters.ts:301-420 | agentsRoot/completeVersions/findStudioInstall (stateDir installs) | A | Windows-installed adapters cannot run in WSL |
| agents/adapters.ts:505-515 | codex detection (~/.codex) | A | |
| agents/installer.ts (whole) | install agent packages into stateDir | D | v1: the user installs agents inside WSL; later A |
| agents/signin.ts:200-240 | auth file paths, sign-in commands | D | as above |
| agents/beta_setup.ts, beta_agents.ts, beta_signin.ts | Beta agent setup | D | |
| agents/codex_limits.ts:24-125 | codexHome/newestRollouts/rolloutLimits | A | |
| agents/codex_limits.ts:127-200 | app-server spawn | A | |

## terminal/, keeper/

| file:line | what it does | cat | note |
|---|---|---|---|
| terminal/sessions.ts:72-76 | windowsPowerShell fallback | D | |
| terminal/sessions.ts:79-91 | checkCwd (drive regex, isNetworkPath, stat) | C | the stat is A |
| terminal/sessions.ts:117-140 | PromptWatch (PowerShell/cmd prompts) | D | |
| terminal/sessions.ts:320-380 | attach: defaultShell + spawnPty / KeeperPty | A | |
| terminal/keeper_pty.ts:113-175 | keeper PTY spawn with cwd | A | |
| keeper/link.ts:288-320 | KeeperLink.spawn(spec with cwd) | A | needs a second link to the WSL keeper |
| keeper/client.ts (whole) | start/find the keeper, keeper.json in stateDir | B | the Windows keeper; a WSL keeper needs a second instance launched via wsl.exe |
| keeper (Go) proc_unix.go:103,204; pty_linux.go; main.go:183-200 | Linux spawn/PTY, unix socket or TCP | B | ready to reuse as the helper core |

## Gates that refuse WSL paths today (all C, listed so none is missed)

security.ts:247; added_projects.ts:113; editors.ts:352; folders.ts:68,95,112,115,203,277; folder_presence.ts:40; project_delete.ts:286,346; studio.ts:1345; terminal/sessions.ts:82; transcripts/store.ts:153; files_routes.ts:46,52; chat_folders.ts:11; files.ts:39,60,67,83; outside_files.ts:26,53,70; client_caps.ts:123-126.

## (1) Proposed minimal ProjectFs / ProjectExec interface

Recommended shape: one object per project location, `loc = { kind: 'win' } | { kind: 'wsl', distro, linuxRoot, uncRoot }`, resolved from the project path. Every A site gets `loc` instead of calling `Deno.*` directly.

```ts
interface ProjectPaths {            // pure and local (C sites): one flavour per location, no I/O
  flavour: 'win' | 'posix';
  join, dirname, basename, normpath, isAbs, relpath, commonpath, key /* case-folds only on win */;
  toUnc(linux): string; fromUnc(unc): string;  // for UI, editors, the picker
}
interface ProjectFs {               // async only
  stat(p, {follow}): {kind, size, mtimeMs, mode, isSymlink} | null;
  realPath(p, {strict}): string;
  readDir(p): {name, kind, isSymlink}[];
  walk(root, {skip, maxEntries}): string[];          // index, envFiles, rglob (one call, not N)
  readFile(p, {offset?, length?, maxBytes?}): Uint8Array;  // also tail reads for transcripts
  readLink(p): string;
  writeFile(p, data, {atomic, createNew, modeFrom?, mkdirs}): void;
  mkdir(p, {recursive}); remove(p, {recursive}); rename(a, b); copyFile(a, b, {keepTimes, keepMode});
  makeTempDir(parent, prefix): string;
  watch(root, {recursive, debounceMs}): AsyncIterable<{kind, paths[]}>;   // inotify in WSL
  trash(p): 'trashed' | 'permanent';
}
interface ProjectExec {
  git(args, cwd, {env?, stdin?: Uint8Array, timeoutMs, maxOut?, binary}): {code, stdout: Uint8Array, stderr, truncated};
  run(argv, cwd, {env?, stdin?, timeoutMs}): same;   // git init, gio trash, which-style probes
  which(cmd, pathVar?): string | null;
  env(): {home, tmp, path, uid, claudeRoot, codexHome};
  spawnAgent(spec: {command, args, cwd, env}) -> keeper channel (pipe);   // existing keeper protocol
  spawnPty(spec: {file, args, cwd, env, cols, rows}) -> keeper channel (pty);
  processes(): {pid, ppid, name, cmdline, cwd, start}[]; alive(pid, start); killTree(pid);
  forwardMcp(addressFileOrUrl) -> local endpoint for agents in that environment;
}
```

That is about 25 operations. A coarser variant reaches the same coverage with less risk: run the existing `worktrees/` (sync.ts, merge.ts, changes.ts, files.ts), the docs file layer and the transcript store **inside** the helper (a Linux Deno build of the same modules) and call them at module level (`getChanges`, `getFileDiff`, `listDir`, `readFile`, `search`, `merge`, `liveSync.*`, `docs.read/write/list/sync`, `transcripts.*`), with the Linux keeper underneath for spawn/PTY. That avoids turning roughly 200 sync fs calls into async RPCs.

## (2) Count per category (table rows; gate list not counted)

| category | rows |
|---|---|
| A (must run in the WSL helper) | 135 |
| B (fine on Windows) | 27 |
| C (path translation only) | 39 |
| D (Windows-only, turn off for WSL) | 8 |
| **total** | **209** |

Raw volume behind the rows: the server has about 485 direct `Deno.*` fs/Command calls (tests excluded), and roughly 60% of them are on project or agent-session paths. On top of that come the `ospath`/`pypath` helper calls (isdir/isfile/realpath) and the 26 isNetworkPath gates listed above. Many rows also carry a second category in their note, so read A as "at least A".

## (3) The five riskiest sites

1. **worktrees/sync.ts:668-720 DirWatcher + LiveSync 946-1600.** `Deno.watchFs` over `\\wsl.localhost` gets no events (ReadDirectoryChangesW over 9P), and the engine makes about 60 sync fs calls plus git per turn. Run it file-by-file over RPC and it is slow and racy. Run it from Windows over UNC and edits are silently missed. It has to move into the helper as a whole.
2. **The three git spawn paths: worktrees.ts:121-186, changes.ts:65-131, files.ts:119 (plus folders.ts:328).** Windows git on a WSL repo hits "dubious ownership", is slow, and `encodeInput` (worktrees.ts:114-118) rewrites `\n` to `\r\n` on stdin. Missing one path means a mixed setup that can corrupt the index (update-index/hash-object input) or show wrong diffs.
3. **Worktree location and removal: worktrees.ts:1016-1150, merge.ts:610-620 resetTo.** The worktree root is `stateDir/worktrees` on Windows, and the "only delete inside AIB's root" guard (realpath + normcase) depends on it. A WSL repo needs a root inside the distro, and the guard must compare Linux paths case-sensitively. A mistake here deletes the wrong folder or creates a cross-filesystem `git worktree`.
4. **Agent spawn + AIB tools wiring: connection.ts:446-458, 852-862; studio.ts:645-690; mcp.ts:315-330.** Today the agent gets the whole Windows env, a Windows binary path, a Windows forwarder exe and a 127.0.0.1 URL. Under WSL2 NAT the Linux agent cannot reach Windows loopback, so it would start without AIB's doc/artifact/merge tools and without any error.
5. **Path identity and safety gates: ospath.ts:37 normcase, the isNetworkPath gates, project_delete.ts:262-310 refusal.** Lowercased keys merge `Foo` and `foo` (projectKey in sync/merge, artifacts pathKey, repoLock). Loosening isNetworkPath too broadly re-opens the UNC credential leak it guards against. The delete guard was written for drive letters. All need a "registered WSL project" exception, not a general relaxation.

## (4) Revised effort estimate

| work item | days |
|---|---|
| Path model (`loc`, posix flavour in ospath/pypath/purepath/path, keys, gate exceptions, UNC to/from Linux) | 3-4 |
| WSL helper bootstrap: Linux keeper (+ Deno helper) installed/launched via `wsl.exe`, version match, token, TCP loopback, reconnect | 3-4 |
| Fs/exec RPC (about 25 ops) on Windows + helper sides | 3-4 |
| git: one router for all four spawn paths; worktree manager with a per-environment root | 3-4 |
| Live sync + merge in the helper (inotify watcher, scratch indexes, clash flow) | 5-7 |
| Files view, changes/diff, outside files, file tickets | 2-3 |
| Docs file layer, charts/drawings, artifact publish + watcher | 3-4 |
| Agents: spawn in the WSL keeper, Linux PATH/agent discovery, env, Linux MCP forwarder + tunnel to AIB | 3-5 |
| Terminals (project shell, client terminals) | 1-2 |
| Transcripts/monitor/ownership/codex limits per environment | 3-4 |
| Add project/picker/presence/delete (trash in WSL), editors `--remote wsl+` | 2-3 |
| Tests: fake-helper fixture, real-WSL e2e (Ubuntu), update the refusal tests | 4-6 |
| **Total, module-level helper (recommended)** | **35-50 days** |

- Fine-grained RPC at every A site instead (async conversion of about 200 sync calls): add 10-15 days, for **45-65 days**.
- A smaller v1 (agents, terminals, Files view and Changes only; live sync, merge, worktrees and docs turned off for WSL projects so they work in place; D items off; ownership skipped): **14-18 days**.

## Existing tests in work/deno covering these sites

- Worktrees, sync and merge: worktrees_test (25), worktree_sync_test (31), worktree_sync_interop_test (6), worktree_merge_test (15), worktree_merge_clash_test (16), worktree_merge_request_test, worktree_from_main_test, docs_worktree_test; fixture `_git_repo.ts`.
- Files and changes: changes_test, files_view_test (9), files_outside_test (5), chat_folders_test.
- Desktop: folders_test (19), new_project_test, start_project_e2e_test, folder_presence_test, added_projects_test, added_projects_app_e2e_test, project_delete_test (10), editors_test (29; already has a `vscode-remote://wsl+ubuntu` workspace entry at :591).
- Agent connection: client_caps_test, connection_test and the connection_* tests, studio_test.
- Terminals and keeper: terminal_test (15), keeper_terminal_test, keeper_terminal_e2e_test, keeper_client_terminal_test, keeper_* e2e.
- Artifacts: artifacts_test (44), artifact_mcp_test, artifact_origin_test.
- Docs: docs_store_test, docs_charts_test, drawing_test.
- Sessions: monitor_test (36), monitor_golden_test, ownership_probe_test, ownership_test, usage_limits_test, adapters_test.
- Paths: platform_test, security_test, state_paths_test.
- Tests that assert WSL/UNC paths are **refused**, and will change on purpose: added_projects_test:327-334 (`\\wsl$\Ubuntu` never read), security_test, folders_test, client_caps_test, chat_folders_test, editors_test, project_delete_test, monitor_test/monitor_golden_test, host_client_test.
- No test runs anything inside WSL today.
