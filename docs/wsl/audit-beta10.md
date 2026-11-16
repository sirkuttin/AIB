# WSL audit against the beta10 merges

Branch `wsl/audit` (cut from `studio/chat-51bfbaae` at `41dc4d4`). Scope: every feature merged since `fc41043` (111 merges, `git log
--merges fc41043..HEAD`), checked for what happens when a chat's folder is a `wsl://<distro>/<linux path>` ref (`Connection.cwd`,
`projectRoot`) and its agent works in a Linux path (`agentCwd`). Also the features that are in `integration/beta11` but not yet in
this branch (multi-window `feat/mw-*`, `fix/doc-comment-sync`): `git merge-tree HEAD integration/beta11` is clean, and their probes
ran on a temporary merge of the two.

Status words: **BROKEN** = reproduced by a test (exception, wrong result, silent failure). **SUSPECT** = code reading says it fails,
not reproduced (how to reproduce is given). **OK** = exercised, or read through end to end where the existing WSL tests already cover
it. **N/A** = the feature never touches a folder or path.

Probe files (all pass in a normal run; the `KNOWN-BROKEN:` tests are skipped unless `AUDIT_WSL=1`, and fail with it):

| File | Run |
|---|---|
| `work/deno/audit_wsl_allow_test.ts` | `deno test -A ../../work/deno/audit_wsl_allow_test.ts` (from `outputs/agent-studio`) |
| `work/deno/audit_wsl_history_test.ts` | same pattern |
| `work/deno/audit_wsl_swarm_test.ts` | same pattern |
| `work/deno/audit_wsl_remote_test.ts` | same pattern |
| `work/deno/audit_wsl_inbox_test.ts` | same pattern |
| `work/deno/audit_wsl_files_test.ts` | same pattern |
| `work/deno/audit_wsl_beta11_windows_test.ts` | skips on this branch; runs on a merge with `integration/beta11` |
| `work/audit_wsl_page_links.js` | `node --test work/audit_wsl_page_links.js` (`AUDIT_WSL=1` for the broken cases) |

Normal run: 13 passed, 9 ignored (Deno) and 2 passed, 4 skipped (node). With `AUDIT_WSL=1` every KNOWN-BROKEN test fails.

## Start and Continue of a WSL chat

Nothing found that breaks START, CONTINUE, rebuild after a crash, or the automatic reconnect. The checks:

| Path | Status | Evidence |
|---|---|---|
| Allow rules' scratch folder (the earlier `additionalDirectories` failure) | OK (fixed before this audit) | `studio.ts:1287` gives no scratch folder to a WSL chat; `audit wsl allow: what a WSL chat's allow context is` (scratch `null`); `wsl_studio_test.ts` checks `session/new` has no Windows path |
| House-rules text (literal scratch path in the system prompt) | OK | `connection.ts:5162`: no scratch folder, no brief |
| Local-only `additionalDirectories` and prompt text | OK | `studio.ts:1222` (`local = wsl ? null : ...`): a WSL chat gets no Windows local-only folders |
| MCP servers handed to the Linux agent | OK | `studio.ts:1206`: a WSL chat gets the tunnel/interop servers only, never `options.mcpServers` |
| History store, rebuild after crash, older pages | OK | `audit wsl history: a WSL chat writes its store by chat id; ...` |
| Recovery list and auto-reconnect (agent gone) | OK | `audit wsl recovery: ...` (`session/load` with cwd `/home/u/app`, no Windows `additionalDirectories`) |
| Window-first startup take-over | OK | `audit wsl startup: window-first order ...` (same pid, no second agent) |
| Real distro: start, adopt after restart, Continue with the agent running, Quit keeps it, ended chat listed and continued | OK (4/4 passed, 57 s) | `wsl_agent_e2e_test.ts`, `wsl_sessions_e2e_test.ts` with `AIB_WSL_E2E=Ubuntu` (temp root `/tmp/aib-wsl-test-*`, fake agent) |

## All features

| # | Feature (merge) | Status | Evidence |
|---|---|---|---|
| 1 | Allow rules: edit requests in a WSL chat (`feat/allow-rules-1`) | **BROKEN** | F1; `KNOWN-BROKEN: audit wsl allow: an edit inside the WSL project offers Always allow ...` |
| 2 | Allow rules: commands and built-in Safe reads in a WSL chat | **BROKEN** | F1; `KNOWN-BROKEN: audit wsl allow: the built-in Safe reads answer \`git status\` ...` |
| 3 | Allow rules: project-scoped MCP / fetch rules from a WSL chat | **BROKEN** | F3; `KNOWN-BROKEN: ... keyed by the ref ...`, `... still applies after AIB starts from another working folder` |
| 4 | Allow rules: project match and the "also answer waiting cards" sweep fold case | **BROKEN** (minor) | F6; `KNOWN-BROKEN: ... /home/u/App do not apply in /home/u/app`; `studio.ts:2209` |
| 5 | Allow rules: Claude settings facts (ask rules, risky env) for a WSL chat | SUSPECT (low) | F9 |
| 6 | Allow rules: scratch folder, house rules | OK | see Start and Continue |
| 7 | History store 1a/1b/2a/2b (per-chat sqlite, checkpoint, take-over, scroll-loading) | OK | `audit wsl history: ...` (store is `<state>/history/<id>.sqlite`, never named after the ref) |
| 8 | Recovery list, auto-reconnect | OK | `audit wsl recovery: ...` |
| 9 | Startup fast-open / window-first / keeper fast start (`fix/window-first`, `fix/startup-and-timeouts`) | OK | `audit wsl startup: ...` |
| 10 | Saved chats list and transcript (`/api/sessions`, `/api/transcript`) | OK | `monitor.ts:316-321`, `wsl/transcripts.ts:205` send WSL keys to the helper; `wsl_sessions_e2e_test.ts` |
| 11 | "Find more chats via agent" (session/list discovery) | **BROKEN** | F4; `KNOWN-BROKEN: audit wsl discover: ...` |
| 12 | Swarm: helper tools and main role in a WSL chat (`feat/swarm-phase1`, `fix/swarm-off-default`) | OK | `studio.ts:1202`, `:1642`: no main role; `wsl_studio_test.ts`: no `start_helper` in the tool list |
| 13 | Swarm: the service's own role check | **BROKEN** (latent: not reachable from the app today) | F7; `KNOWN-BROKEN: audit wsl swarm: ...` |
| 14 | Usage limits | OK (read) | `usage_limits_feed.ts:97`, `:150`: per-distro account key, the distro's `~/.codex` read through the helper |
| 15 | Ownership probe (another builder is changing it) | OK / N/A | `studio.ts:1168-1179`: WSL resumes go to `#wslCheckOwnership` |
| 16 | Worktree status batching, Merge button state (`fix/slow-requests`) | OK (read) | `studio_routes.ts:307-313`: WSL chats go to `wslMerge`; the batched git runs only for Windows chats |
| 17 | Agent options memory (per folder) | OK | `agent_options.ts:50` turns the ref into `p:wsl:/...` |
| 18 | Version in tag (`feat/version-in-tag`) | N/A | no folder |
| 19 | Phone home cards, chat view, project list and colours (`feat/phone-ui-v2*`) | OK | `phone + WSL project: home files WSL chats ...` |
| 20 | Phone New chat for a WSL project (`fix/phone-newchat-projects`) | OK | same test (connects with the ref; default saved under `folderKey(REF)`); `remote_newchat_wsl_test.ts` for per-distro switches |
| 21 | Phone saved chats, history, Continue (`feat/phone-reopen`) | OK | `phone + WSL saved chats: ...` |
| 22 | Phone approval sheet detail (Linux path) | OK | `phone approval sheet: a Linux file path is shown as is` |
| 23 | Phone attachments (`feat/phone-attachments`) | N/A | inline content blocks (`acp/attachments.ts:348-367`), no file path reaches the agent |
| 24 | Phone steer, queue, cancel, rename, archive (`feat/phone-steer`) | N/A | keyed by chat id |
| 25 | Remote file access gates (`remote/access.ts`, `gate.ts`) | N/A | the phone port has no route that reads project files (`remote/server.ts:116-160`) |
| 26 | Phone artifacts and artifact port | N/A | artifact store keyed by chat, never a project path |
| 27 | Inbox v3 panel/toasts/phone, attention watcher (`feat/inbox-*`) | OK | `inbox: WSL chats are filed under the WSL project ...`, `inbox: a muted WSL project announces nothing ...`, `inbox: server and page project keys agree ...` |
| 28 | Desktop notifications, click to open | N/A | the target is a chat id |
| 29 | WSL worktree chat without `projectRoot` is filed as its own project | SUSPECT (low) | F8 |
| 30 | Path links: absolute Linux path in a WSL reply (`feat/outside-path-links`, `fix/picture-findings`) | **BROKEN** | F2; `KNOWN-BROKEN: an absolute Linux path inside the WSL project links as an in-project file ...` |
| 31 | Path links: Write/Edit row open-file button | **BROKEN** | F2; `KNOWN-BROKEN: a Write/Edit row naming an absolute Linux path ...` |
| 32 | Path links: relative path in a WSL reply | OK | `OK: a relative path in a WSL chat reply links inside the project ...` |
| 33 | Path links: Ctrl+click on an outside Linux path | **BROKEN** (minor) | F5; `KNOWN-BROKEN: Ctrl+click on a Linux path outside ...`; `editors: Ctrl+click on a bare Linux path ...` |
| 34 | Path links: names that differ only in case | **BROKEN** (minor) | F5; `KNOWN-BROKEN: Linux names are case-sensitive ...` |
| 35 | Outside-file links for a WSL chat not live in this process | SUSPECT (minor) | F10; `files/outside for a WSL chat that is not live ...` pins today's refusal |
| 36 | Path link opens a published artifact (`fix/path-links-open-artifacts`) | SUSPECT (depends on PNG publishing builder) | F11 |
| 37 | Files tab: list/read/search, git-ignored folders open, file tabs per project (`fix/file-tab-layout`, `fix/open-ignored`, `fix/empty-project-view`) | OK (read) | `rootFor`/`scopeFor` handle refs; tabs keyed by project key; `wsl_files_changes_e2e_test.ts` |
| 38 | Docs routes / doc store for WSL projects | OK (read) | refs go to `wsl/docs.ts`; `wsl_docs_test.ts`, `wsl_docs_e2e_test.ts` |
| 39 | Artifacts: watcher, archive/delete bin (`feat/artifact-bin-*`), zoom | OK / N/A | `NoWrites` for WSL chats; bin is keyed by chat |
| 40 | Desktop project lists, delete, folder presence, folder kinds | OK (read) | `projectKey` handles refs; `project_routes.ts` uses `wslCheck`/`wslTrash`; `isForeignPath` guards |
| 41 | Open in editor / Show in Explorer for in-project WSL files | OK | `#openWsl`; `resolveWslInside` in `audit_wsl_files_test.ts` |
| 42 | Local-only folders (`feat/local-only-*`; another builder is on it) | refuses cleanly | `files_routes.ts:170` answers 409 "Local-only files are not available for WSL projects yet."; strays route returns an empty move |
| 43 | Local-only backups skip WSL projects without saying so | SUSPECT (low; local-only builder) | F12 |
| 44 | Agent sign-in card and terminal (`feat/agent-signin`) | OK (read) | `terminal_routes.ts` `wslSigninCommand`/`attachWslSignin`; existing WSL sign-in tests |
| 45 | Steer on send, Send menu, chat width, split focus, chat jumps, update button, keep awake, tray, site, flaky-test fixes | N/A | no folder |
| 46 | beta11 multi-window: Open in new window, per-window URL, one window per project, doc pop-out, saved-window restore | OK (on a trial merge) | `audit_wsl_beta11_windows_test.ts` 2/2 on `HEAD + integration/beta11` |
| 47 | beta11 doc pop-out by project key | OK (read) | `addedFolderOf` → `rootFor('project:'+ref)` takes the WSL branch; page and server key `p:wsl:/ubuntu/home/u/app` |
| 48 | beta11 `fix/doc-comment-sync` | N/A | in-memory duplicate-load guard only |
| 49 | beta11 safer `.git` path checks in `files.ts` | OK (read) | the trailing-dot and 8.3 checks run on Windows paths only |

Counts (49 rows): BROKEN 10 (3 minor, 1 latent; findings F1-F7), SUSPECT 5 (F8-F12), OK 26 (rows 15, 39 and 42 count as OK), N/A 8.

## Findings, most visible first

### F1 BROKEN: in a WSL chat the user can never say "Always" to an edit or a command

- **Entry point:** a WSL Claude chat asks to edit `/home/u/app/src/main.ts` (or to run `git status`). The approval card appears.
- **What happens:** AIB's "Always allow" choice is unavailable with "Not available: AIB never auto-allows path could not be resolved."
  (commands: "Not available: the command runs outside the chat folder."), and the card also hides the agent's own "Always allow"
  button because the draft says `hideAgentAlways: true` (`chat.js:3263`). So every edit and every command asks, every time, unless the
  user switches the agent's mode. The built-in Safe reads (`git status`, `ls`, `grep`) never answer in a WSL chat either:
  `decide` returns `{ allow: false, reason: 'runs outside the chat folder' }`.
- **Cause:** `connection.ts:5219-5220` passes the ref as `cwd`/`project`; the matcher (`allow/paths.ts:45-70` `pathFormProblem` and
  `realish`, `matcher.ts:261-264`, `:273`) checks paths with Windows rules: the ref has a colon, so it is a "provider path"; an
  absolute Linux path becomes `C:\home\u\app\...` and is resolved with `Deno.realPathSync` on the Windows disk. It fails closed (no
  wrong allow was found), but it takes away both Always choices.
- **Fix (S, now):** for a WSL chat return drafts with `hideAgentAlways: false` (keep the agent's own Always) and say "Allow rules do not
  cover WSL chats yet". **Fix (M-L, proper):** match a WSL chat against its Linux folder with POSIX path rules (`node:path/posix`,
  `insideLinux`), with links resolved by the helper or with link-free checks; never `Deno.realPathSync`. Note for the proper fix:
  a relative path through a Linux symlink is not followed by `realish` today (the path does not exist on Windows), so a plain port
  would allow edits through a link out of the project.
- **Tests:** `KNOWN-BROKEN: audit wsl allow: an edit inside the WSL project offers Always allow ...`, `KNOWN-BROKEN: audit wsl allow:
  the built-in Safe reads answer \`git status\` ...`; today's behaviour pinned by `audit wsl allow (pins today): ...`.

### F2 BROKEN: files inside a WSL project open as outside files, read-only

- **Entry point:** click `/home/u/app/src/main.ts` in a WSL chat reply, or the open-file icon on an Edit/Write row. Claude's tools always
  use absolute paths, so every Claude WSL chat hits it.
- **What happens:** the page asks `/api/live/files/outside` (observed: `[ '/home/u/app/src/main.ts', '/home/u/app/README.md' ]` sent to
  the outside route); the tab says "Outside this project · Opens read-only", with no Changes badge and no Show in Files.
- **Cause:** `files-ui.js:2315` (`linkPaths`) and `files-ui.js:2544` (`toolFileInfo`) use `folder = c.cwd || c.projectPath`, which is the
  ref; `files-state.js:24` `relTo('/home/u/app/src/main.ts', 'wsl://ubuntu/home/u/app')` returns null.
- **Fix:** for a chat with `c.wsl`, compare against `c.wsl.linuxPath` (or map the Linux path to the ref) before `relTo`/`dedupe`/
  `outsideCands`. Effort S.
- **Tests:** `KNOWN-BROKEN: an absolute Linux path inside the WSL project links as an in-project file ...`, `KNOWN-BROKEN: a Write/Edit
  row naming an absolute Linux path ...` (`work/audit_wsl_page_links.js`).

### F3 BROKEN: a project rule made in a WSL chat is saved under AIB's working folder

- **Entry point:** in a WSL chat, tick "Always allow (this project)" on an MCP tool or web-fetch card.
- **What happens:** the rule's `project` is `resolve(ref)` = `<AIB's working folder>\wsl:\ubuntu\home\u\app` (in the probe:
  `C:\Users\...\outputs\agent-studio\wsl:\ubuntu\home\u\app`). It works while AIB runs from that folder; after AIB starts from another
  folder (installed AIB.exe vs a dev run, a different shortcut "Start in") `rulesHere` no longer finds it, and the Settings list shows
  that odd path. Command rules' project pins (`matcher.ts:339`, `:611`) use the same `resolve(ctx.project)`.
- **Cause:** `matcher.ts:472`, `:492` (`resolve(ctx.project)`), `:194-196` (`sameFolder` with `resolve`).
- **Fix:** key WSL projects with `locKey(ref)` (no `resolve` for a ref) in `ruleFor`, `sameFolder` and the pins. Effort S.
- **Tests:** `KNOWN-BROKEN: audit wsl allow: a project MCP rule from a WSL chat is keyed by the ref ...`, `KNOWN-BROKEN: audit wsl allow:
  a WSL project rule still applies after AIB starts from another working folder`.

### F4 BROKEN: "Find more chats via agent" asks a WSL chat's Linux agent for the Windows list

- **Entry point:** with any WSL Claude chat open, click "Find more chats via agent" in a Windows project (POST `/api/live/discover`).
- **What happens:** the reply is `{"supported":true,"sessions":[...],"via":"studio-connection"}` from the agent in the distro (its log
  shows 1 `session/list`, expected 0). Real distro sessions have Linux cwds, which `filterSessions` (`project_routes.ts:194`) drops: the
  user sees "0 listed" and never gets the Windows sessions.
- **Cause:** `studio.ts:991` picks any live, ready chat of that provider.
- **Fix:** skip chats with `c.wsl` there (or use the temporary Windows probe). Effort S.
- **Test:** `KNOWN-BROKEN: audit wsl discover: "Find more chats via agent" is never answered by a WSL chat's Linux agent`.

### F5 BROKEN (minor): outside-path Ctrl+click and case-only name matches in WSL chats

- **Ctrl+click** on an outside Linux path: `files-ui.js:2461` sends `openFile('/home/u/other/run.log', line, '/home/u/other')`;
  `editors.ts:362` refuses with "That path is not a folder of this PC". Fix: hide "open in editor" for outside links in WSL chats, or
  say plainly it cannot open. Effort S. Tests: `KNOWN-BROKEN: Ctrl+click on a Linux path outside ...`, `editors: Ctrl+click on a bare
  Linux path ...`.
- **Case:** `files-ui.js:2286` (`dirNames`) and the `seen` sets at `:2329-2335` fold names to lower case, so `readme.md` in a reply links
  to `README.md`, and the click asks the helper for a file that is not there. Fix: fold case only for Windows roots. Effort S. Test:
  `KNOWN-BROKEN: Linux names are case-sensitive ...`.

### F6 BROKEN (minor): allow-rule project matching folds case for WSL projects

- `matcher.ts:194-196` (`sameFolder`) lowercases on Windows, and the sweep after "Always allow" (`studio.ts:2209`) compares
  `projectRoot.toLowerCase()`. For WSL, `/home/u/App` and `/home/u/app` are different projects but share project rules, and saving a
  rule in one auto-answers waiting cards in the other. Fix: compare with `locKey()`. Effort S. Test: `KNOWN-BROKEN: audit wsl allow:
  project rules of /home/u/App do not apply in /home/u/app ...`.

### F7 BROKEN (latent): the swarm service does not refuse a WSL chat itself

- Not reachable from the app today: the MCP layer gives WSL chats no helper tools. It would take a direct POST `/api/live/swarm/tool`
  `start_helper` with a WSL worktree chat's key.
- `swarm/service.ts:80-92` (`Swarm.mainChat`) checks only for a worktree and `projectRoot`; it then calls `liveCall('connect',
  {"provider":"codex","cwd":"wsl://ubuntu/home/u/app","background":true,...,"helperOf":{...}})`, which starts a helper in the distro
  that later fails at `wt.recordForPath` (Windows-only registry).
- Fix: refuse in `mainChat` when `state.wsl` is set or `locOf(projectRoot)` is WSL, unless `WSL_TOOL_GROUPS.swarm`. Effort S.
- Test: `KNOWN-BROKEN: audit wsl swarm: the swarm service refuses start_helper for a WSL worktree chat ...`.

### F8 SUSPECT (low): a WSL worktree chat that arrives without `projectRoot` becomes its own project

- `desktop/added_projects.ts:126` (`parentOf`) and `desktop/folders.ts:76`, `:105` still say a WSL ref is never a worktree (phase 1);
  phase 2 added worktrees in the distro. Today live, rebuilt and saved WSL worktree chats all carry `projectRoot` = the project ref
  (`studio.ts:1196`, `:1635`, `wsl/transcripts.ts:66`), so nothing breaks.
- Would break: a chat note or session item without `projectRoot` (an older note). It is then filed as its own project in the inbox,
  phone and sidebar, its notifications are not held back, and `addOpened` (`studio.ts:1218`) adds the worktree as a project.
- Reproduce: rebuild a WSL worktree chat from a chat note with no `projectRoot`. Fix: teach `parentOf`/`folderKinds` the WSL worktree
  layout or ask the helper. Effort S-M.

### F9 SUSPECT (low): Claude settings facts for a WSL chat come from Windows

- `allow/gate.ts:67` calls `claudeFacts(ctx.cwd)` with the ref: `agent_config.ts:61-63` reads the **Windows** `~/.claude/settings.json`
  and `join(ref, '.claude', ...)` (a non-path, silently unreadable). The Linux agent's own `~/.claude/settings.json` and the project's
  `.claude/settings*.json` in the distro are never read, so its ask rules and risky-env facts are missed, and the Windows ones apply.
  Only matters once F1's proper fix lets rules answer in WSL chats. Reproduce: a Windows `~/.claude/settings.json` with `ask: ["Edit"]`
  changes a WSL chat's draft. Fix: read the facts through the helper, or skip facts and keep rules off for WSL. Effort M.

### F10 SUSPECT (minor): outside-file links do not work for a WSL chat that is not live

- `files_routes.ts:282` (`wslChatLoc`) looks only at live connections; another chat id goes to `checkShape`, which answers "Network and
  device paths are not supported", so the link stays plain text. Reproduce: open a saved, not running WSL chat and hover an outside Linux
  path. Fix: find the saved chat's folder (recovery/transcripts) to get the distro. Effort M. Pinned by `files/outside for a WSL chat that
  is not live ...`.

### F11 SUSPECT (PNG publishing builder): path links to published artifacts from WSL chats

- `files-ui.js:2442` (`artifactForLink`) matches `sourcePath` against ref-form paths; a WSL artifact stored with a bare Linux path never
  matches. Fix: store WSL `sourcePath` as the ref (or compare both). Effort S.

### F12 SUSPECT (low; local-only builder): local-only backups skip WSL projects silently

- `worktrees/local_backup.ts:280`: `osp.isdir(ref)` is false for a ref, so WSL projects' local-only files are never zipped and nothing
  says so. Fix: back up through the helper, or show "not backed up" for WSL projects. Effort M.

## Not exercised

- The probes run on FakeWslHost (a real keeper standing in for the Linux keeper, the fake ACP agent) and headless page code; only the
  existing start/continue e2e files ran against the real Ubuntu distro (temp root, fake agent).
- The real phone page and push delivery; real windows of the beta11 multi-window work (its page flows were read; server and store parts
  ran on a trial merge).
- A real WSL worktree chat in the swarm probe (the fake helper cannot make worktrees; a stub host gives the live state such a chat has).
