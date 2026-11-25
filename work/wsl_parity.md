# WSL parity matrix

Owner rule: "we need to make sure we always stay feature parity with WSL projects." Every user-facing feature has a row here: whether
it works for a WSL project (folder `wsl://<distro>/<linux path>`), the code path, and the test that proves the WSL case. **A new
feature adds its WSL row (and its WSL test) in the same change.** Paths are under `app/server/` unless they say
otherwise; tests are in `work/deno/` (Deno) or `work/` (node page tests).

Last audit: 2026-11-17 (0.13.0 item 1).

| Feature | WSL | Code path | WSL test |
|---|---|---|---|
| File editor (open, save, merge, conflict, CRLF/BOM, mode/owner, symlink, guard, unsaved text, undo) | works (0.13.0) | `files/live_files.ts` `#openWsl`, `files/file_io.ts` WslIo, `wsl/helper/editor.ts` | `file_editor_wsl_test.ts`, `file_editor_wsl_e2e_test.ts` (real distro) |
| New window (menu, Ctrl+K, Ctrl+click), project window, chat pop-out | works (page and route layers) | `workspace-ui.js` openProjectWindow / popOutChat, `web/windows_route.ts`, `desktop/windows.ts` | `wsl_new_window_e2e_test.ts`, `audit_wsl_beta11_windows_test.ts` |
| Doc pop-out | works for added projects (same rule as Windows) | `web/docs_routes.ts` addedFolderOf | `wsl_new_window_e2e_test.ts` (body only); no `docs/open` by `p:wsl:` key test yet |
| Restore windows after a restart | works (WSL folders count as present) | `desktop/windows.ts` restorePlan, `desktop/folder_presence.ts` | `audit_wsl_beta11_windows_test.ts` |
| Split view | works (page only, keyed by chat) | `split-ui.js` | none with WSL |
| Files tree, search, read | works | `web/files_routes.ts`, `web/wsl_routes.ts` wslFiles | `wsl_files_changes_e2e_test.ts`, `audit_wsl_files_test.ts` |
| Changes | works | `worktrees/chat_folders.ts`, helper changes.* | `wsl_files_changes_e2e_test.ts`, `wsl_worktrees_e2e_test.ts` |
| Terminal | works | `terminal/sessions.ts` attachWsl | `wsl_terminal_e2e_test.ts` |
| Chat worktrees, merge/landing, live sync | works | `wsl/worktrees.ts`, `wsl/merge.ts`, `wsl/sync.ts` | `wsl_worktrees_e2e_test.ts`, `wsl_merge_e2e_test.ts`, `wsl_sync_e2e_test.ts` |
| Swarm helpers | works (2026-11-25): start, status, stop, land on end, conflicts, work_list/land/diff/discard, Undo and Merge again; the worktree, landing, registry facts and cleanup run in the distro | `wsl/helpers.ts`, `wsl/helper/helpers.ts` (`helper.*`), `merge.run` held/builder, `worktree.plan` onFolderBranch, `swarm/service.ts` (#wslOf), `artifacts/mcp.ts` WSL_TOOL_GROUPS.swarm = true | `wsl_helpers_test.ts` (fakes), `wsl_helpers_e2e_test.ts` (real distro; skips without AIB_WSL_E2E), `audit_wsl_swarm_test.ts` |
| Subagent worktrees and landing (Claude, Codex) | works (2026-11-23, keeper 1.8.0): the agent's hooks run `AIB-keeper hook <event> --helper-socket` in the distro, reach AIB through the helper's tunnel, the distro's helper makes the worktree and lands it (own commits only), the swarm lands the mirror record, a failed landing wakes the parent. Hooks that can't be set up (helper too old, setup fails) or hooks off in the user's settings turn the chat's editing subagents off by permission rules, never unisolated. Real distro not yet run | `keeper/hooksocket.go`, `wsl/helper/subagents.ts` `subagent.*`, `wsl/subagents.ts` (wslRemote, wslLandSubagent), `subagents/service.ts` (remote, refreshWsl), `host/aib.ts` (#wslClaudeHooks, #wslHookCall, Codex branch), `swarm/service.ts` | `keeper/hooksocket_test.go`, `wsl_subagent_hooks_test.ts` (Claude and Codex, fake helper over real git), `wsl_subagents_test.ts`, `wsl_subagents_e2e_test.ts` (real distro; skips without AIB_WSL_E2E) |
| Subagent worktrees, Gemini | **not** (fence only: its subagents' edits are denied; the redirect needs the distro's GEMINI_CLI_HOME and policy files) | `subagents/gemini.ts` (`wsl: 'WSL chats come later'`) | `subagent_gemini_test.ts` |
| Rename sync | works | `host/aib.ts` `_session/rename` in the distro | none for WSL |
| Open in... (editors) | partly: VS Code, Cursor, Explorer only; no workspace files | `desktop/editors.ts` | `audit_wsl_files_test.ts`, `wsl_gates_test.ts` |
| Inbox and stalled | works | `attention/watcher.ts`, `acp/connection.ts` | `audit_wsl_inbox_test.ts`, `inbox_wsl_handled_e2e_test.ts` |
| Snooze | works (keyed by chat) | `attention/watcher.ts` | none with WSL |
| Publish by path (agent tool) | works | `web/aib_routes.ts` attachWslFile, `wsl/artifact_read.ts` | `wsl_publish_path_test.ts`, `wsl_publish_path_e2e_test.ts` |
| Files view "Open in Artifacts" and the artifact mark | works (fixed 0.13.0) | `web/aib_routes.ts` (preview runs attachWslFile), `artifacts/artifacts.ts` #preview, `files-ui.js` artRel / artChatFor | `wsl_publish_path_test.ts` (preview), `work/audit_wsl_page_links.js` |
| Path links in chat replies | works | `files-ui.js` linkPaths, artifactForLink | `work/audit_wsl_page_links.js` |
| Docs | works | `wsl/docs.ts`, helper docs.fs | `wsl_docs_test.ts`, `wsl_docs_e2e_test.ts` |
| Remote computers: Files, file editor | works | `remote/pc_routes.ts`, `web/live_files_routes.ts` | `audit_wsl_remote_test.ts`, `file_editor_wsl_test.ts` |
| Remote computers: Download | works (fixed 0.13.0) | `remote/pc_bridge.ts` #download (helper files.readBytes) | `pc_1c_test.ts` (WSL case) |
| Phone (chats, new chat) | works | `remote/newchat.ts`, `phone.js` | `audit_wsl_remote_test.ts`, `remote_newchat_wsl_test.ts` |
| Allow rules | works | `allow/linux.ts` | `allow_wsl_test.ts`, `allow_wsl_chat_test.ts`, `wsl_allow_e2e_test.ts` |
| History / reopen (saved sessions, transcript, Continue) | works | `wsl/transcripts.ts`, helper transcripts.* | `wsl_sessions_e2e_test.ts`, `audit_wsl_history_test.ts` |
| Pictures in a saved WSL chat's history | **not** (says so: 404 `wsl_image`) | `wsl/transcripts.ts` wslTranscriptGet | `wsl_bgtasks_test.ts` (the plain refusal) |
| Background tasks of saved sessions | works for Claude Code; not Codex (as on Windows) / OMP hints | `wsl/transcripts.ts` wslTaskGet | `wsl_bgtasks_test.ts`, `wsl_bgtasks_e2e_test.ts` |
| Project removal cleanup (trash in the distro, unsaved editor text) | works | `web/project_routes.ts` wslCheck/wslTrash, `files/live_files.ts` forgetProject | `wsl_phase2_test.ts`, `wsl_phase2_e2e_test.ts`, `file_editor_wsl_test.ts` (forgetProject) |
| Agent sign-in in the terminal | partly: Claude Code and Codex only | `web/terminal_routes.ts` | `wsl_linking_routes_test.ts` |

## Known big gaps (not parity yet)

- Swarm helpers in WSL: big (the swarm's tools and registry in the distro).
- Subagent worktrees in WSL, what is left after the hook path (2026-11-23): Gemini (BeforeTool hook, the fence policy and GEMINI_CLI_HOME
  made in the distro), the real-distro run of `wsl_subagents_e2e_test.ts` (AIB_WSL_E2E), and a finished empty subagent of a closed WSL
  chat (the swarm's #dropEmptyOrphan skips WSL records: its worktree goes when the chat is opened again and it lands as empty).
- Open in... for other editors (JetBrains etc.) and workspace files in WSL: medium.
- Pictures of saved WSL chats: medium (a helper `transcripts.image` method plus the route branch).
- "Open in new window" for a WSL project in the real desktop app: the owner reports it fails; the page and route layers pass for WSL
  (`wsl_new_window_e2e_test.ts`), so what is left is the real-binary layer (see the 0.13.0 report).
