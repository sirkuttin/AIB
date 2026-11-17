# Architect review: file editor design v2 (2026-11-16)

Reviewed: `private/designs/file-editor/file-editor-design-v2.md`, against `architect-review-2026-11-15.md`.
Code read (read only): this worktree at `5de77d0` (main), plus the spike commit `1ceb277`. The spike is on branch `studio/sub-c533d888-1` and is **not on main yet**: `tools/code-vendor/editor.entry.js`, the `files-ui.js` loader and `work/deno/code_editor_spike_e2e_test.ts`.

## Verdict

**Approve the model, fix before the build.** The model is a server-held Y.Text per open file, disk changes merged in as their own origin, a hash-checked save, and server-side hot exit. It is the right shape for the owner's promise, and it is simpler than v1's page journal plus window claims. The spike results look real: the CSP finding, 115 ms for a 1 MB file, and per-author undo.

Problems:
- The design is sound on paper, but it says nothing about **when** the disk is read, which **process** holds the text, and **which keys** the page steals from a shadow root.
- Six of the must-fixes below can lose or corrupt text. Two of them (the `?` key and emoji) would show up on day one.
- The 14-16 day estimate leaves out the must-fix work. With it, the design as written comes to about **17-19 days**. The cut at the end comes to about **12 days**.

## Must-fix before build

1. **The page swallows keys typed into the editor (shadow-root retargeting).** A document-level listener sees `e.target` as the shadow host `div.sf-code-host`, not the editable content. So every "is the user typing?" check says no:
   - `switcher-ui.js:559`: `?` calls `preventDefault()` and opens the shortcut sheet. **You cannot type `?` in code**, and a sheet pops up.
   - `switcher-ui.js:564`: Alt+↑/↓ moves the line (CodeMirror handles it first) **and** switches the chat, because the check ignores `defaultPrevented`. The design noticed this one.
   - `switcher-ui.js:569`: Alt+N and Ctrl+Shift+N start a new chat from inside the editor.
   - `chat.js:6536`: **End** in the editor beside a chat (`#fileBeside`, chat visible) moves the caret and also jumps the chat to the latest message.
   - `focus-return.js:19/41`: the host does not match `TEXT`, so the editor is never `home`. After Ctrl+K, the close-dirty popover or a menu closes, focus goes to the chat's message box (`#prompt`), not back into the editor.

   The spike tested only Ctrl+F, Ctrl+D, Ctrl+/ and Ctrl+Z in the main view, which is why it saw no clash.

   **Fix:**
   - Add one shared helper, `AgentTyping.target(e) = e.composedPath()[0]`, and an `isTyping(e)` that is also true inside any `.sf-code-host`.
   - Use it in `switcher-ui.typing`, `chat.js` (End, Escape), `scroll-controller.js` and `focus-return.js` (where `TEXT` includes `.sf-code-host`).
   - Every document handler skips `e.defaultPrevented`.
   - Attach with `attachShadow({mode:'open', delegatesFocus:true})`, so `host.focus()` lands in the editor.
   - E2E: in the **beside** pane, real key presses of all printable ASCII, End, Home, Alt+↑/↓, Alt+N and `?`. Assert the editor's text and that AIB's state (chat, scroll, dialogs) did not change.
   - Budget 1 d, not 0.5 d.

2. **Emoji and other non-BMP text get corrupted by the merge.** The spike's `applyDisk` uses `@codemirror/merge diff`, which works on UTF-16 code units. Take an agent change from 😀 to 😃: both start with `\uD83D`, so the hunk splits the surrogate pair. Yjs `ContentString.splice` replaces a split pair with U+FFFD (yjs#248), and the next save writes the broken bytes to disk.
   **Fix:**
   - Diff by line first, then by character inside the changed lines, and snap every boundary to a code point.
   - Add a test that changes one emoji into another and checks the bytes after save.

3. **The merge must not block the server, and it must merge by line.** Character-level Myers on a 5 MB file after a formatter rewrite can take seconds. It would run on the web server's single event loop, which also streams every chat. The spike's 4.2 ms was two one-line edits.
   **Fix:**
   - Run the 3-way merge by line, like `git merge-file`. `sync.ts` already uses it, so the result is well-tested and its conflict regions are minimal.
   - Then turn `merged` vs `mine` into Y.Text edits with the line-then-character diff from must-fix 2.
   - Either run it in a Worker or give it a time budget. Past that budget, or past 2 MB, it degrades to "everything overlaps" and leaves the text alone.
   - **Overlap granularity:** when a disk hunk overlaps one user line, apply the other lines of that hunk. Otherwise a Save while the overlap is open quietly **reverts the agent's neighbouring lines** too. "Keep mine" must mean the user's lines only.

4. **Read the disk only when it has settled, and never while AIB is moving the folder.**
   - **Partial writes:** Claude's Write, `>` and git checkout all write in place. A 2 s poll can read half a file and merge a truncation into the live text.
   - **Tool-event trigger:** it fires on `tool_call`, which arrives before the write and before the approval (`WriteTracker.observe` records on both `tool_call` and `tool_call_update`).
   - **Stash windows:** `swarm/undo.ts:~140` (Undo of a landing) and `merge.ts:1220` (`stashUserWork`) run `git stash push -u` on the project folder while holding `pauseLock`. During that window the user's saved edits and untracked files vanish from disk. A poll there would merge a revert into clean tabs, raise a false "Restore mine" (guarantee 3), and show "deleted on disk" for untracked files. v1's review had this rule ("skip while the pause lock is held"); v2 dropped it.

   **Fix:**
   - Take in a disk version only when two reads about 300 ms apart give the same size and mtime (and hash). Trigger on `tool_call_update` with status `completed`.
   - Skip, and check again later, while `wt.syncPaused()` is true.
   - Run all of a LiveFile's work (poll merge, save, landing touch, restore) in **one serial queue per LiveFile**. A save updates `base` (sha and mtime) inside the same step, so the next poll does not see AIB's own write as a foreign change.

5. **Save must include the last keystrokes, and Don't save must not throw away another window's text.**
   - The design has "the page sends no text; the server saves its own LiveFile". Ctrl+S right after typing can save the server's text **without the last characters**, which are still in flight on the socket. The tab then shows Saved, and if the dirty flag is a boolean, the text is lost.
     **Fix:**
     - The save request carries the page's Y state vector (or the pending update itself). The server applies or waits for it before building the bytes.
     - "Dirty" is computed (`text !== base.text`), never a flag that Save clears.
   - "Don't save" or closing the last tab in one window, while another window or the beside pane still has the file open, must only close that view. Discard and clear the store only when no view is left.
   - **Web-server restart** (deploy restarts only the web server, `host/deploy.ts`): docs answer `reopen`, and the page **drops its copy** (`docs_routes.ts:676`). For files that would drop edits that were not sent yet.
     **Fix:** persist the Y update, and keep its lineage and epoch across restarts, so a reconnecting page's sync step merges its pending edits. If the lineage really changed, the page diffs its text against the server's and re-applies it as its own origin. It never drops text.

6. **Give file sync its own socket route, not a `kind=file` channel on the docs socket.** `GET /api/live/docs/socket` is open to remote computers (`remote/pc_routes.ts:467`, `docsSocket` takes a `REMOTE_PC` principal). A file channel on it would let a remote computer edit project files' live text, and that text is then saved by the next local Save or restore. The design keeps the write route off the remote gate but not the socket.
   **Fix:**
   - Add `GET /api/live/files/socket` with its own subprotocol (`aib-file`), page scope only, and no entry in `pc_routes.ts`.
   - Add a test that a remote principal is refused.

7. **Name the process that holds the text, and how the agent host reaches it.**
   - Docs, and so LiveFile, live in the **web server** (`web/server.ts:797`).
   - Landings, subagents, `WriteTracker` and `addPromptContext` live in `Studio`, which can be the separate agent host or keeper process (`host/agent_host.ts`).
   - So `liveFiles.touched(paths, who)` "after `fastForward`" (design 4.2) is a call across processes.

   **Fix:**
   - The landing (and `swarm/undo.ts`) emits a `files_changed {project, paths, who}` event on the existing host event stream. The web server subscribes to it.
   - Notes to agents go back through `liveCall('prompt-context')`, as the design says.
   - If the web server is down (AIB quit), nothing is lost: restore merges against `base`.

8. **Define what happens when "theirs" can't be edited.** An agent can rewrite an open file as non-UTF-8, binary, UTF-16, over 5 MB, or with lone CR characters.
   **Fix:**
   - Never merge such a version. Keep the user's text, switch the tab to "Changed on disk to a form AIB can't edit · Compare is read-only", and make Save ask for a second press (Save overwrites).
   - **Lone `\r`:** today the spike turns `\r` into `\n` (`replace(/\r\n?/g,'\n')`), and CodeMirror splits on a lone CR too. A file with a stray CR inside a line would be changed on save. Treat lone CR as `mixed`, read-only in v1.
   - **EOL and BOM:** they follow the disk version **last taken in**, not the first read. Claude's Write on Windows often turns CRLF into LF. The normalized text is then the same, and the next save would quietly put CRLF back.

## Should-fix

- **Formatters: one row, not N inline blocks.** An agent's `prettier --write` or `ruff format` touches exactly the lines the user just typed (unformatted code), so every user hunk becomes an overlap. Above 3 overlaps, or a disk change touching more than 30% of lines, show one tools-row state: "Claude rewrote this file · 14 overlaps · Compare". Don't show inline blocks.
- **Inline overlap blocks are a layout jump.** A block inserted below the user's lines pushes the code down while they type, which goes against "nothing jarring". Show a gutter marker plus the tools-row count, and open the block only when the user clicks the marker. Better still, let **Compare** be the only place to resolve: `MergeView` with `revertControls` gives per-chunk "take theirs" for free. That also removes the custom "Take theirs" widget. If Take theirs stays, it must run **on the page**, inside the editor's undo origin. A server-side change is not in the user's undo stack, which contradicts "undoable".
- **Track the user's dirty ranges on the server.** "Lines 12-18" in the agent notes, the overlap test and guarantee 3 all need the user's changed ranges as relative positions. Update them in `afterTransaction` when the origin is a page socket (`readSyncMessage` passes the link as the origin, `live_doc.ts:1518`). Don't rebuild them from `diff(base, mine)`: once `base` moves to theirs, that diff mixes the user's edits with the agent hunks that were not applied.
- **Guarantee 3 needs a strict test, or it will cry wolf.** Agents edit lines the user saved on purpose. Offer "Restore mine" only when the new disk text for those lines equals the text before the user's save (a real revert), until that chat's next turn ends. Any other change there gets only the note to the agent.
- **Branch switches.** Detect a HEAD change (read `.git/HEAD` in the poll batch). Clean tabs follow it, with the footer "Branch switched to X". For dirty tabs, don't auto-merge another branch's hunks into unsaved text, because that makes a hybrid of both branches. Keep the text and show "Branch changed · Compare".
- **Renames.** A delete plus a new file with the same `base.sha` in the same poll window should offer "Moved to src/new.ts · Follow". Otherwise "Save again" quietly recreates the old file next to the renamed one.
- **`aib-docs/**` should be read-only entirely, with "Open in Docs".** The design keeps the `.md` copies editable, but AIB's own README (`store.ts` `DOCS_README`) and `MD_NOTE` tell users "Edits to the .md copies are overwritten". Two live models on one file also loop: the docs store skips a guarded block and rewrites the `.md`, LiveFile reads that as a revert of the saved edit and offers Restore mine, the user restores and saves, and the block is skipped again.
- **Registry key.** Key it on the normalized real path, case-folded on Windows. Otherwise `src/A.ts` and `src/a.ts` become two live texts racing each other's saves.
- **Symlinks.** A temp file plus rename onto a symlink inside the root replaces the link with a plain file. Write to the resolved target, which must be inside the root.
- **Persist atomically.** Use one file per LiveFile (or the `.json` carrying the hash of the `.bin`), written atomically. A crash between the two files gives a `base` that doesn't match the text.
- **No silent prune.** "30-day prune" deletes unsaved text, which breaks the promise. Show stored unsaved files with the dirty dot in the tree and in Ctrl+K, and prune only after they have been shown and are older than 30 days. Also poll **dirty** LiveFiles in every project, not only visible ones, so overlaps get noticed and agents get told.
- **The stat poll can miss writes.** On FAT, exFAT and some network shares (mtime in 1-2 s steps), a same-size write in the same second is never seen. Hash small files (under 1 MB) when the mtime is less than 3 s old.
- **"The agent is told" means at its next prompt.** `addPromptContext` lines go out with the chat's **next prompt** (`host/studio.ts:431`). A chat that is busy now keeps writing until its turn ends. Say that in guarantee 4, and don't promise "at once".
- **WSL chats have no write tracking** (`acp/connection.ts:474/1327`, `NoWrites`). Attribution and "chats whose conversation touched the path" fall back to "Changed on disk" and to the busy chats in that folder.
- **Reuse only the transport from `live_doc.ts`, not `LiveDoc`.** Its socket part is about 80 lines (`attach`, `detach`, `#receive`, `#broadcast` and awareness, `live_doc.ts:1472-1533`). The other 2,400 lines are blocks, guards, pages and charts on an XmlFragment, which a file doesn't need.
  - Move the transport into `server/live/ysocket.ts`, used by both.
  - Write a small `server/files/live_file.ts` (about 500 lines: Y.Text, base, dirty ranges, merge, overlaps, queue) and `live_files.ts` (registry, poll, store).
  - Copy the docs store's patterns (save on idle, flush in `server.ts:719 close`), not its code.
  - This is safer for docs and smaller to test.
- **Quit.** Quitting AIB must never ask "Save changes?". Hot exit only, which matches the no-popups rule and "quit keeps agents". While AIB is quit, agents run on in the keeper. The restore merge is the only reconciliation and the agents are told nothing, so the restore footer should say "Changed on disk while AIB was closed" when that happened.

## What the design gets right

- One editable place (the folder). Worktree files are read-only with "Edit in project folder".
- Saves are hash-checked on raw bytes, under `pauseLock` with `423 landing_busy`.
- `touched_dirty` is kept. Unsaved text does not block landings.
- The shadow-root CSP answer, verified: the `<style>` tag is blocked, the constructed sheet passes.
- Lazy load and the theme from CSS variables.
- Undo per author. Ctrl+K already opens files, and Ctrl+P is not taken.
- `WriteTracker` now does keep a timestamp per path (`artifacts.ts:1910`), so attribution on the server is possible. The old review's "paths only" no longer holds.

## Recommended first version (keeps "your unsaved text never gets lost; agents' changes merge in")

**In:**
- **Server (≈3 d):** read metadata (sha, encoding, eol, bom; lone CR, UTF-16 and non-UTF-8 read-only), the write route (hash check, `pauseLock`/423, `atomic.ts`, failure codes, path guard), save with the state vector.
- **LiveFile (≈3.5 d):**
  - `ysocket.ts` extraction, plus the own page-scope socket.
  - `live_file.ts`: a line-level 3-way merge (code-point-safe, time-boxed), server dirty ranges, a serial queue, settled reads, skipping while paused.
  - Atomic persist and restore, keeping the lineage.
  - The `files_changed` event from landings and undo.
  - Agent notes (overlap and save) through `prompt-context`.
- **Page (≈3.5 d):**
  - One persistent editor per tab, the Y binding, Save / Save all / dirty dot / close popover (view-only when other views remain).
  - Overlap = a gutter marker plus "1 overlap · Compare". Compare = `MergeView` with revert controls, in the same pane at the same width.
  - The save-failed row, the footer, the read-only reasons, "Edit in project folder", and the shadow-root key/focus fixes.
- **Tests (≈2 d):** the design's e2e list, minus WSL and new file. Plus:
  - typing `?`, End and Alt+↑/↓ in the beside pane;
  - an emoji round-trip;
  - Ctrl+S right after typing;
  - a partial write;
  - a stash window (swarm Undo) with a dirty tab;
  - web-server restart with unsent edits;
  - two windows with Don't save in one;
  - the remote socket refused;
  - a formatter rewrite giving one row.

**Out (next round, in order):**
1. WSL editing (WSL files stay read-only with the reason), 1.5 d.
2. New file, 0.5 d.
3. Agent tint and "Updated by …" attribution beyond the footer, 0.5 d.
4. Guarantee 3 with the strict revert test, 0.5-1 d.
5. Awareness cursors across windows.
6. Inline overlap blocks.
7. Rename following and branch-switch detection.

**Size: about 12 builder days** (11-13). For comparison, the design's full P1 plus the must-fixes is about 17-19.

The promise holds in this cut: unsaved text is persisted on the server, never overwritten by a merge, and survives restarts and quit. Disk changes that don't overlap merge in. Overlaps are kept as the user's text and are visible, with Compare to take theirs. The agent is told at its next prompt.

## Owner-rule check

- **Nothing jarring:**
  - The inline overlap blocks push code while the user types (should-fix above).
  - `?`, End and Alt+N from the editor open a sheet, jump the chat or start a new chat (must-fix 1). Today these break the rule outright.
  - Formatter rewrites would stack many inline blocks (should-fix).
- **Right panel width only by the owner's drag:** the design doesn't say where Compare opens for a file in the beside pane. State it: in the same pane, at the same width. Never widen `#fileBeside` or the right column, and fall back to a unified diff if the pane is too narrow.
- **Ctrl+P = Switch project:** respected. Ctrl+K already opens files.
- **No git buttons / chat-first:** respected. Save, Compare, Take theirs and Restore mine are editor actions, not git. Merges stay with agents and AIB's landings.
- **Flagged additions:** "Ask a chat about this" (P2) is a designer addition and is labelled as one. Awareness cursors ("other window's cursor faintly") and the agent tint are not in the owner's words and aren't flagged; I'd move both out of v1.
