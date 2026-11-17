# AIB file editor: design v2 (2026-11-16)

Updates `private/designs/file-editor/aib-file-editor-design.html` and `architect-review-2026-11-15.md` for today's AIB. Read those for the prior art, the editor choice (CodeMirror 6) and the full shortcut table; this file says what changed, what ships first, and how.

## 1. What changed since the review

- **Chats now work directly in the project folder.** There are no per-chat copies, and no Merge or Discard (the buttons are gone, `changes-ui.js:149`). Only helper chats and agents' own subagents get a worktree. AIB lands those at turn end: `swarm/service.ts #runLanding` → `merge.ts land/landHeld` → `git merge --ff-only`, under the parent chat's landing lock, the folder chats' landing locks and the `pauseLock`.
- **Live sync no longer runs for folder chats.** `sync.ts` and its `finishTurn` lost-update guard now cover helper chats only (`host/studio.ts:552`). This means an agent working in the folder can overwrite a user's saved edit with a whole-file write, and nothing re-merges it.
- **The `.git` look-alike leak on reads is already fixed** (commit eaf9c2d, `work/deno/files_git_guard_test.ts`). The write route reuses that check.
- **Owner direction (2026-11-16, via the lead): an open file works like an AIB doc.** It is a live Y.Text. Changes on disk merge into it as their own origin, the user's edits win, agent text is marked, and undo is per author. This is the model in `server/docs/live_doc.ts` and `store.ts`.

### Dropped (no longer a problem)

- **"Which copy does a click edit?"** (old owner decision 1). There is one editable place: the project folder. Gone with it:
  - `423 merge_busy` for Merge, `410 copy_gone`, and the per-copy `worktreeLock` for saves.
  - "Saves to Fix login's copy", and "Save into the project folder / Copy text" for a removed copy.
  - "Live sync gives it to N chats", the chip menu "open in another copy", and the "agent is working in this copy" note.
- **The multi-window claim** ("Being edited in another AIB window", read-only in the second window). The live text sits in the server, as with docs, so every window is a client of the same text and all of them can edit (section 4.6).
- **The separate Keep mine / Take theirs bar for the common case.** Non-overlapping disk changes merge in by themselves. Save is "keep mine" for overlaps. Only overlaps get an inline choice (section 4.4).
- **The page-side unsaved-text journal and its 64 KB keepalive limit.** The server holds the live text and persists it (section 4.5).

### Lead defaults (the owner asked not to be asked)

- Files open editable at once (Source mode). You edit the project folder.
- Files in a helper's or subagent's worktree open **read-only**, with an **"Edit in project folder"** button. It opens the same path in the folder scope; if the file is not there yet, the button says so.
- Conflict handling is the lean version: Compare, Take theirs, and an automatic merge for non-overlapping changes. No per-block picker.
- Ctrl+P stays Switch project. Ctrl+K already opens files.
- Nothing jarring: no popups, no layout moves on focus. The right panel's width changes only when the owner drags it.

## 2. The model: an open file is a live text (like docs)

| | AIB docs today | File editor |
|---|---|---|
| Live state | Server Y.Doc per doc (`live_doc.ts`), pages sync over `/api/live/docs/socket` (y-protocols) | Server Y.Doc per open file (`LiveFile`), one Y.Text, synced over the same socket protocol |
| Source of truth on disk | `doc.aibdoc` + `.md` copies AIB writes | The file itself |
| Agents edit through | AIB's doc tools (`doc_edit` with ifHash/ifRev guards) | **Their own tools**: Write, Edit, apply_patch, `sed`, `>`, Gemini `write_file`, git, and helper/subagent landings |
| Who wins | Guards **refuse** an agent's block edit when the user changed it after the agent read it | Can't refuse: the write already happened on disk. AIB **merges afterwards**: the user's unsaved text stays, overlaps are shown, the agent is told |
| Origins | page socket = user, agent origin, `file` origin, undo managers | page socket = user, `file` origin (named with the writer when known) |
| Marks | `agentEdit` mark, tinted | Agent ranges tinted (a decoration from relative positions; not saved into the file) |
| Undo | Per author | Per author: Ctrl+Z undoes only the user's edits (`Y.UndoManager` tracks the editor origin only; proven in the spike) |

**The key difference to say out loud:** for docs AIB is the gate, so it can say no before a write lands. For code files the disk is the meeting point. Agents write directly, and AIB learns about it only afterwards (from a tool event, the landing, or the stat poll). So the guarantees are:

1. The user's **unsaved** text is never overwritten. Disk changes merge around it, and an overlap is shown but never applied over it.
2. A **save** never silently overwrites a newer disk version (raw-byte hash check).
3. A **saved** edit that an agent later overwrites on disk is detected and offered back ("Claude's write replaced your edit on lines 12-18 · Restore mine"). This replaces the lost-update guard folder chats lost with live sync.
4. AIB tells the agent which lines the user edited, so it stops fighting them.

## 3. Minimum to ship (v1)

Kept from the review's must-fixes, updated:

1. **Read reply carries what the save needs:** `sha` (SHA-256 of the raw bytes), `encoding` (`utf-8`, `utf-8-bom`, `utf-16le/be` or `unknown`, from a fatal decoder), `eol` (`lf` / `crlf` / `mixed` / `none`) and `finalNewline`.
   - Bad bytes are no longer turned into U+FFFD silently: a file that is not UTF-8 opens read-only.
   - UTF-16 is detected by its BOM before the NUL-byte binary probe, shown as text, read-only ("UTF-16: editing comes later").
   - Mixed line endings: editable; saving uses the more common ending, and the footer says so.
   - Editable size limit 5 MB, which is above today's 1 MB view limit (that limit stays for the read-only fallback).
2. **Save = the live text with a raw-byte hash check.**
   - `POST /api/live/files/write {id, root:'main'|'project', path, baseSha, eol, bom}`. The text comes from the server's own LiveFile (the page sends no text; a fallback field exists for tests).
   - The server builds the bytes (EOL and BOM as read), hashes the disk file and writes only if the hash equals `baseSha`.
   - It returns `{sha, mtime}`. On `409 changed` it first merges the new disk version in (section 4.4); if that merge had no overlap it saves again by itself. If there was an overlap, the inline overlap shows and Save stays enabled. Saving then means "keep mine" for those lines, and the agent is told.
3. **Path guard (write and new file).**
   - Writes go only to `root=main|project`. Never to `outside`, and never to a helper/subagent worktree, which is read-only by rule.
   - The resolved-path `.git` check from eaf9c2d applies to every write, plus links/junctions that leave the root.
   - Refused inside the project too: AIB's own data folders (state dir, `aib-docs/*/doc.aibdoc`, which gets "Open in Docs"), the folders the outside route already refuses, and the save temp names.
   - New files: resolve the parent folder. Refuse leaf names that end in a dot or space, contain `:`, or are reserved device names (CON, NUL, COM1…).
   - The route is page-scope only: not an agent tool scope, not on the phone/remote gate.
4. **Atomic writes and failure states.**
   - Move `sync.ts writeAtomicBytes / replaceWithRetry / copyMode` into a shared `worktrees/atomic.ts`.
   - Temp file `.aib-save-<rand>.tmp` in the same folder (added to the stat poll's and sync's temp filters), flushed, then renamed with retries. Mode bits are copied on WSL/POSIX. Leftover temp files are swept on open.
   - The save-failed row (red tint, the 44 px tools row, never wraps) has these states, each with Retry:
     - "Locked by another program"
     - "Read-only file"
     - "Access denied"
     - "Disk full"
     - "Folder gone"
     - "Landing <helper> · saving when it ends" (retries by itself, no button)
5. **Locks with landings.**
   - A save takes `wt.pauseLock(stateDir, project, 3 s)`, the lock landings hold around `fastForward`. A save and a landing's checkout therefore never interleave.
   - While a landing holds the lock, the reply is `423 landing_busy`. The page retries by itself, and the footer says "Landing Fix-login's helper · saving when it ends".
   - Landing's existing `touched_dirty` rule stays: saved-but-uncommitted files block a landing that touches them, and the parent gets told. Unsaved text is not on disk, so it does not block a landing. Instead the landing's change merges into the live text (section 4.4).
6. **One editor per tab that survives redraws.**
   - `files-ui.js renderView` still rebuilds the box (`box.replaceChildren`, ~line 2199). Keep a map from tab id to `{view, binding}`, re-attach the same `.cm-editor` node on each draw, and redraw only the head, tools and foot. Undo, cursor, scroll and IME survive.
   - The main tab and the beside pane bind to the same LiveFile. Two views of one Y.Text is fine with Yjs, so neither has to be read-only.
7. **Live text store.** This replaces the unsaved-text journal and the multi-window ownership (section 4.5).
8. **Landing a helper/subagent while the user has unsaved edits in that file.**
   - It must never overwrite the user's text. The landing's paths come in as a `file` origin change named after the helper or subagent, and merge as in section 4.4.
   - For overlaps, the parent chat (the one whose subagent landed, or the helper's opener) gets a prompt-context line through `addPromptContext` / `liveCall('prompt-context')`:
     > The user has unsaved edits in src/auth/session.ts, lines 12-18, which overlap what <subagent> changed. Their text stays in the editor. Don't rewrite those lines; re-read the file after they save.
9. **Tell the agents what the user edited.** On every save, each open chat working in that folder whose conversation touched the path (the per-conversation `writes` list), plus any chat busy right now, gets one line: "The user edited src/x.ts, lines 12-18 (saved); re-read it before changing it." It is deduplicated per path, and only the newest ranges are kept.

Editing features in v1 (from the original Minimum list; all CodeMirror built-ins or one-line bindings):
- syntax highlighting (~20 languages)
- find/replace (regex, case, word), F3
- go to line (Ctrl+G, rebound)
- multi-cursor (Ctrl+D, Ctrl+Shift+L, Alt+click, Alt+Shift+drag box select)
- bracket matching and auto-close
- auto-indent and indent detection
- toggle comment (Ctrl+/)
- move/duplicate/delete line
- word wrap (Alt+Z)
- the change gutter mapped through edits

Also in v1: Save, Save all, the dirty dot in the × box, the close-dirty popover (Save / Don't save / Cancel), New file, and the footer showing the EOL, encoding, indent, "Unsaved" / "Saved 14:02" and the read-only reason.

## 4. How it works

### 4.1 Read-only cases (the footer keeps "Read-only" plus the reason)

- Helper/subagent worktree files ("Edit in project folder").
- Files outside the project.
- The release notes.
- `doc.aibdoc` ("Open in Docs"). The `.md` copies stay editable, because the docs store merges hand edits block by block.
- Binary files, non-UTF-8 files, UTF-16 files, and files over 5 MB.
- Preview mode.
- WSL files when the distro helper lacks `files.write` ("Update the WSL helper").

### 4.2 LiveFile (server)

- **Registry:** a registry keyed by `(projectKey, path)` keeps one LiveFile per open file. A LiveFile holds:
  - a Y.Doc with a Y.Text;
  - `base`: the disk text it last took in, plus that text's raw `sha`, `eol`, `bom` and `mtime`;
  - the overlap records;
  - the agent-range marks (Y relative positions + writer);
  - the user's last saved ranges (for guarantee 3).
- **Lifetime:** created on the first editable open and closed when the last tab closes and the text is clean. It reuses the docs socket transport (y-protocols sync + awareness) on a `kind=file` channel.
- **Noticing disk changes:**
  - a batched stat poll every 2 s of the open LiveFiles in visible projects, with a hash only when size or mtime moved, and one helper call for WSL;
  - an immediate check when a tool event names the path, or when a landing reports its paths (`merge.ts landHeld` returns the paths; the swarm calls `liveFiles.touched(paths, who)` after `fastForward`).
- **Attribution:**
  - a landing names its helper or subagent;
  - a tool event for that exact path from a chat in the last few seconds names that chat;
  - otherwise the text is "Changed on disk". Shell edits are never attributed.

### 4.3 Clean text, file changed on disk

The disk change merges in as the `file` origin: a minimal diff (`@codemirror/merge diff`, as in `applyDisk` in the spike), so the cursor and scroll stay put. The agent's ranges get a soft tint that fades on the next edit there or on save. The footer reads "Updated by Claude · Fix login · 14:02". No bar, no popup, and nothing moves.

### 4.4 Unsaved text, file changed on disk (the merge)

This is a 3-way merge on the server, with `base` (the disk text the live text last took in), `theirs` (the new disk text) and `mine` (the live text):

1. Hunks of base→theirs that touch no line of a base→mine hunk are applied to the Y.Text at once as the `file` origin, tinted. Nothing pops up.
2. Hunks that overlap a line the user changed are **not applied**. The user's text stays. Each one becomes an overlap record anchored by relative positions, and shows **inline** below the user's lines: their version in a read-only block, with **Take theirs** (replaces the user's lines with theirs, as the user's own undoable edit) and **Compare** (whole-file 2-way `MergeView` in the middle, disk left and yours right). The 44 px tools row shows "Claude changed lines you edited · 1 overlap". It never wraps; in a narrow pane it shows "1 overlap".
3. `base` moves to `theirs`, and the save's `baseSha` becomes theirs' sha. Saving keeps the user's lines for open overlaps (the old "Keep mine"). The overlap blocks then close, and the agent is told (3.8 / 3.9).
4. The agent is told at once which lines the user edited (the 3.8 wording, sent to the writing chat when known, otherwise to the folder's busy chats).
5. A deleted file gives "This file was deleted on disk" with Save again / Close tab. A delete is an overlap with everything.

Ctrl+Z undoes only the user's edits. Agent merges are not in the user's undo stack (spike step 5). Undoing an agent change is "Take back" on its tint, which comes later.

**Guarantee 3 (a saved edit overwritten later):** when a disk change reverts lines inside the user's last saved ranges (within the open session), AIB treats it as an overlap. The user's saved version shows as the inline block, labelled "Your saved edit", with **Restore mine**.

### 4.5 Live text store (hot exit, multi-window)

- **Where:** `<stateDir>/editor-live/<projectKey>/<sha1(path)>.bin` (the Y update) plus `.json` (base text, sha, eol, bom, encoding, overlaps, savedAt). It is written by the server about 1 s after the last change and on LiveFile close. Not localStorage, and no page keepalive.
- **Restore:** reopening the file (or AIB after a quit or crash) rebuilds the LiveFile from the store and checks the disk against `base`. Changes on disk merge in as in section 4.4. The footer says "Restored unsaved edits from 14:02".
- **Multi-window:** every window and pop-out is a socket client of the same LiveFile, as with docs, so nothing goes read-only. Awareness shows the other window's cursor faintly.
- **Cleanup:** on a clean save, Don't save, project delete (`project_delete.ts`), and a 30-day prune.
- **Sensitive text:** `.env` edits sit there. That is acceptable: it is AIB's data folder, which the file routes refuse to serve.

### 4.6 Page

- Load: `vendor/code/editor.js` loads on the first editable file tab (proven in the spike), with an idle warm-up after the first Files-mode open. It is never in `chat.html`'s head.
- **Each editor mounts in a shadow root** (spike finding). CodeMirror's style-mod adds a `<style>` tag in a document, and the page's CSP blocks that (`style-src-elem inline`; the editor shows unstyled). In a shadow root, style-mod uses a constructed stylesheet, which CSP doesn't govern. So no CSP change, no nonce, and no Excalidraw-style own page are needed. AIB's CSS variables inherit into the shadow root.
  - P1 cost: AIB's document-level key and focus checks see the shadow host, not the editor. `switcher-ui.js` skips Alt+↑/↓ in contenteditable targets, and the "typing in a field" checks in workspace-ui/files-ui must use `e.composedPath()[0]` (or treat `.sf-code-host` as a text field). Allow about 0.5 d inside P1c.
- The theme comes from AIB's CSS variables only, so all themes work with no per-theme code (proven, including a switch to high contrast light).
- Keys: AIB's capture-phase keys (tabs, project, split, Files) beat the editor, as today. The editor owns Ctrl+F/H/G/D, Ctrl+/, Ctrl+S, Alt+Z and Alt+↑/↓ while focused. No clash was measured for Ctrl+F, Ctrl+D, Ctrl+/ or Ctrl+Z.

## 5. Phases and sizes

| Phase | What | Size |
|---|---|---|
| **P0 spike** | Done (this branch): bundle, lazy load, CSP proof, theme, keys, Y.Text binding with `file`-origin merge and per-author undo. | done |
| **P1a server basics** | Read metadata (sha/encoding/eol/bom/UTF-16 read-only), write route with hash check + `pauseLock` / `423 landing_busy`, `atomic.ts`, failure codes, write path guard, new-file route. | 2.5-3 d |
| **P1b LiveFile** | Registry on the docs socket transport, stat poll + tool-event + landing triggers, 3-way merge-in with overlap records, agent marks, guarantee 3, store + restore, prompt-context notes (3.8 / 3.9), landing hook. | 4-5 d |
| **P1c page** | Persistent editor per tab in `files-ui.js` (replacing `codeView`), Y binding, Save / Save all / dirty dot / close popover, inline overlap block (Take theirs / Compare), tint, save-failed row, footer, read-only reasons + "Edit in project folder", shortcut sheet entries. | 4-5 d |
| **P1d WSL** | Helper `files.write` (hash check, temp + rename, mode bits) + stat batch; old helper → read-only. The first item to move later if time is short. | 1.5 d |
| **P1 tests** | E2E for every approved behaviour (below). | 2 d |
| **P1 total** | | **~14-16 builder days** (up from 10-12: the live-text model adds the LiveFile server and inline overlaps, and drops the copy/Merge work) |
| **P2 niceties** | Language chunks split out of the bundle, "Take back" an agent change, folding/indent guides/whitespace, word completion, full HEAD diff gutter, "Ask a chat about this" (designer addition, flagged). | 4-5 d |
| **P3 later** | Rename/Delete, UTF-16 + other encodings editable, footer EOL/encoding changes, project-wide find/replace, vim keymap, per-block picker if overlaps prove common. | 8-10 d |

**P1 e2e list:**
- an agent write to a clean tab updates it with a tint;
- an agent write while dirty, without overlap, merges in;
- with overlap: the user's text stays, the inline block shows, and the agent is told;
- a landing while dirty never overwrites;
- a save after a hidden disk change gets 409, merges, and saves;
- a save during a landing waits;
- a saved edit overwritten by an agent offers Restore mine;
- quit with unsaved text, then restore;
- two windows edit the same file;
- CRLF and BOM bytes are unchanged;
- non-UTF-8 and UTF-16 open read-only;
- `.git.` and data-folder writes are refused;
- a worktree file is read-only with "Edit in project folder";
- WSL save;
- Ctrl+Z skips agent changes.

## 6. Spike results (P0, 2026-11-16)

From `work/deno/code_editor_spike_e2e_test.ts`: the real built AIB (WebView2) on an invisible desktop, its own data folders, CDP for evaluation and real key presses.

| Check | Result |
|---|---|
| Bundle `vendor/code/editor.js` (CodeMirror 6, 20 languages incl. 4 legacy modes, `@codemirror/merge`, Yjs + y-codemirror.next) | **1,205,629 B minified, 418 KB gzip.** Without Yjs it is 1,103,005 B / 386 KB. The biggest parts: view 181 KB, then the cpp/php/rust/js grammars at 78-103 KB each, and Yjs at 74 KB. Splitting languages into chunks would bring the first load to about 0.55 MB (P2). |
| Loaded with the page? | No. It is not fetched until the first file tab asks for it. |
| Under the page CSP (`style-src 'self'`) | **Works in a shadow root:** 0 CSP violations across load, mount, theme switch and typing, with 1 constructed stylesheet. Mounted straight in the document, it gets a `style-src-elem inline` violation and the styles are lost. This is why the design uses a shadow root. |
| First open of a 1 MB file (1,000,025 B, 29,335 lines) | **115 ms**: 46 ms to fetch and run the bundle (fetch alone 5.6 ms on localhost), then 69 ms to mount until two frames have painted. A second mount (bundle warm) takes **12 ms**. For comparison, today's read-only view of the same file takes 627 ms (read included). |
| DOM size | 36 line nodes for 29,335 lines (viewport rendering). |
| Theme from AIB variables | The editor background, keyword and comment colours equal `--code-bg`, `--syn-keyword` and `--syn-comment`, and follow a switch to `hc-light` with no editor code. |
| Keys (real key presses) | Ctrl+F opens the search panel with focus in it, and Esc closes it. Ctrl+D twice gives 2 selections on "value". Ctrl+/ comments the line. Ctrl+Z undoes. Every one has default prevented. AIB's state (mode, project, menus, dialogs, focus) is unchanged for all of them. |
| Live text (docs model) | Y.Text + y-codemirror.next mounts under the CSP. A disk change merged as the `file` origin, as a 3-way merge in **4.2 ms on the 1 MB file**: the change to line 3 merged in, the change to line 1 (which the user had edited) became an overlap and was not applied, the user's line stayed, and Ctrl+Z took back only the user's edit, not the disk change. |

**Not checked in the spike** (P1): whether tool events reach the page for chats that are not on screen. This matters less now, because attribution moves to the server (section 4.2).
