# Changelog

## 0.1.0-beta.8 (beta)

- Local docs: the project's docs live in the `aib-docs/` folder, shown in Files. Open the folder: each doc is one row with
  its page count, and "+ New doc" is the last row. A doc is a folder in `aib-docs/` holding `doc.aibdoc` (the full doc) and
  a Markdown copy of each page, so the docs travel with the project and its git history; Files shows the doc, not those
  files. `/doc` and Ctrl+K open or make one from a chat.
- Docs co-editing: you and the agents type in the same doc at once. An agent's edit never overwrites text you wrote or are
  typing; a note that would collide is refused and the agent is told. Live presence shows who is in the doc and where, and
  each agent's edit is claimed to its chat so Undo only removes that chat's own changes.
- Docs pages: a doc has pages, picked in the header and listed beside the text; add, rename, reorder and delete them.
- Docs comments: select words and comment; threads stay anchored to those words, agents can read and reply, and a thread can
  be sent to the chat.
- Docs History: every version from the last 30 days plus the first is kept (it no longer shares the artifact's 30-version
  cap). Compare any two versions, and Restore the whole doc or one page exactly as it was. History names who created each
  version, or just "Created".
- Docs rich blocks: callouts, columns, toggles, text colour and highlight, alignment, merged table cells, Underline (U
  button, Ctrl+U) and Excalidraw drawings, which agents can also draw. Charts are blocks that own their numbers; "Make chart"
  turns a table into one. Underline and the rich blocks are kept in `doc.aibdoc`; the Markdown copy marks what it cannot
  hold.
- Docs export: the doc's ⋯ menu exports one page or all pages as Markdown to Downloads (colours drop out, columns stack,
  charts become a table). Duplicate doc and Move doc to trash are in the same menu.
- Artifacts and docs: a chat shows a doc as a solid-edged doc card (Open doc) and an artifact as a dashed card with a window
  icon (View). The artifact picker lists this chat's artifacts, then "Docs this chat wrote" (rows end in an arrow and open
  beside the chat).
- Built from: a page built from a doc shows "Built from <doc>" with Open doc; when the doc has changed since, it says so and
  offers "Rebuild from the doc", which sends the chat a normal message. The doc header shows "Shown in N artifacts".
- Markdown artifacts have an Edit button (it replaces "Make it a doc"). Request a change puts the artifact into the message
  box as a link and focuses the box, so you type what to change and the chat does it.
- File view: "Source | Page" is now "Source | Preview".
- Docs in worktree chats: a chat working in a git worktree reads and writes docs in the main project's `aib-docs/`, never in
  its own worktree folder, so every chat sees the same docs.
- Docs show their title, not the folder name, in Files, pickers and chat cards.

## 0.1.0-beta.7 (beta)

- Installing or signing in to a Beta agent turns it On, and a Ready Beta agent shows in New chat unless you turned it off.
  Agents that aren't ready show greyed out, with the reason and "Set up in Settings ›".
- Buttons on Settings agent cards keep the card in place (no scroll jump).
- The first message of a new chat is always sent, even if you switch chats while the agent starts, and links in agent
  errors are clickable.
- Merge from the chat: when a chat's work is done the agent asks "Merge into main?" and merges when you say yes; no button
  needed. Each merge posts a "Merged into main" line in the chat. The work lands on the project's main branch (main, else
  master), also for a chat started from another branch. If main has moved, the agent first takes main into its worktree and
  resolves any conflicts there; main only ever gets a clean merge, and your uncommitted edits in the main checkout are set
  aside and put back. Helpers working in their own worktrees no longer hold a merge. The Changes tab's Merge button still
  works: it sends the chat the merge request (a collapsed "Merge requested" chip). It is off, with the reason, for closed,
  archived, read-only and Elsewhere chats.
- New chats start from main: a chat's own copy branches from the project's main branch (main, else master) at its latest
  commit, whatever branch the project folder has checked out, so merging it into main carries exactly the chat's work. Your
  uncommitted edits in the project folder come along only when the folder is on main; on another branch they stay there,
  the chat's first note says so, and edits you save are copied into the chat again once the folder is back on main. Chats
  started before keep working from their branch.
- Beta agents: every card can install its agent. OpenCode installs with npm (@opencode/cli). Cursor CLI, Goose and Mistral
  Vibe run the vendor's documented installer in the card's terminal panel, with the command shown first. Cards check what
  the agent needs first (Node.js 22 or the package's minimum, uv for Mistral Vibe on Windows) and offer "Install Node.js 26
  (LTS)" or "Install uv" (winget on Windows, official scripts elsewhere); the agent's Install stays off until then. Check
  again re-reads PATH on Windows.
- Beta agents: Kimi sign-in runs `kimi acp --login` (it ran `kimi --login`). Cards with an API key box have a "Get an API
  key" link. The Qwen card has an optional API address (passed as OPENAI_BASE_URL) for Alibaba Model Studio keys. Gemini
  and Qwen notes and cost lines were checked against the vendors' pages and corrected.
- Beta agent API keys are encrypted at rest: Windows DPAPI, the macOS login Keychain, the Linux Secret Service (else an
  owner-only beta-keys.json). Keys from older versions are sealed on load. Settings says where the key is kept.
- Claude Code and Codex cards show "Needs first: Node.js" with an Install Node.js button and Install off when Node.js is
  missing or too old, like the Beta cards.
- Artifacts: Mermaid, Chart.js and Vega / Vega-Lite load from AIB itself, so charts and diagrams work offline. Pages that
  load them from jsDelivr, unpkg or cdnjs get the local copy; Markdown mermaid blocks are drawn too.
- Files view: Open in Artifacts works from a file tab (it did nothing) and is off, with the reason, when no chat can hold the
  file. Errors and notices stay visible while a file tab shows.
- Approval cards show the command, path or URL itself in a code box, with the agent's description under it.
- A new chat no longer keeps the previous chat's Changes chip, Merge / Discard and Files.
- The model menu no longer shows "Default (Default (...))".
- Tool rows name paths relative to the project, never the chat's worktree folder.
- Terminal colours follow theme switches, sign-in terminals included.
- A chat that follows the newest message keeps following when a question card or the terminal takes space (the plan card was
  hidden under them).
- Sidebar: a long chat title gets the whole first line; its age moves to the end of the second line.
- Chat and Prompts views fold a turn's steps once, not twice.

## 0.1.0-beta.6 (beta)

- Write and edit rows have an open-file button, and the path in the row is clickable: both open the file in the file view
  (Ctrl+click opens the editor). The row's "open ↗" button is now "editor ↗". Files outside the project open read-only,
  labelled "Outside this project" with the branch and repository when known, and only when the chat mentioned them.
- Chat terminals keep running when AIB restarts, updates or crashes. The keeper now holds them, like the chats. When AIB comes
  back, the terminal shows the same shell with its recent output, and a command that was running is still running. While AIB
  restarts, the terminal panel says "reconnecting" and comes back by itself. "Session ended" appears only when the shell really
  ends. Quitting AIB still ends the terminals.
- Commands an agent runs in a terminal of its own (when that option is on) also keep running through a restart or an update. AIB
  answers the agent from the same command afterwards, instead of saying the terminal was lost.
- Ctrl+C now stops a command in a terminal held by the keeper.
- A tray-only AIB (after a crash) no longer quits by itself while a command runs in a terminal.
- The keeper is version 1.2.0. While an older keeper still runs (it holds chats from before an update), new terminals run
  inside AIB as before, and the log says so. Once that keeper has been replaced, the next AIB start puts terminals in the keeper.
- Sign-in terminals of Beta agents stay inside AIB (they are short-lived and end with the sign-in), so they still end when AIB
  restarts.

## 0.1.0-beta.5 (beta)

- Project files in the left sidebar: the sidebar shows one project at a time (All chats is gone; the project dropdown
  counts chats that need you in every project and has Open inbox). A Chats | Files switch (Ctrl+Shift+E) shows the
  project's files: a tree that follows the open chat's own copy (a scope button pins another copy or the main folder),
  .gitignore and node_modules hidden, a filter (Ctrl+Shift+F), a Changed toggle, change badges that open the diff, and a
  marker on files any chat made into an artifact.
- Files open as tabs (a single click opens an italic preview tab) in a read-only file view with Source / Page, Open in
  Artifacts (for any HTML, SVG or Markdown file), Open in VS Code and Show in Explorer. A file path in a reply opens the
  file beside the chat on wide windows, or as a tab; clicking a path no longer adds an artifact. Find and Ctrl+K find files.
- Chats from worktree folders made outside AIB are listed under their parent project, marked with their branch.
- Beta agents in Settings > AIB Linking, off by default and not tested by us yet: GitHub Copilot CLI, OpenCode, Gemini CLI,
  Qwen Code, Cursor CLI, Goose, Mistral Vibe, Cline, Kimi Code and Kilo Code. Install commands, API key boxes, and sign-in
  that needs a terminal runs in an AIB terminal panel (also from a chat that needs sign-in). Turned-on Beta agents show
  under a "Beta" label in the agent pickers.
- Quitting and quickly reopening AIB no longer shows a just-used Claude chat as "Elsewhere · Working" for two minutes or
  refuses to reconnect it.
- The notifications setting is called Desktop notifications on every system.

## 0.1.0-beta.4 (beta)

- New look: Bay teal is the default. Settings > Appearance > Theme offers eleven themes (AIB teal dark and light; high
  contrast dark and light, colour-blind safe; Dracula-style, which replaces the old purple look, Monokai-, Nord-,
  GitHub- and Solarized-style, Ember) plus Match system. Every theme passes a measured contrast check; a "Show status
  symbols" switch adds shapes to the status dots.
- Native desktop notifications: the app shows Windows notifications itself (no browser permission); clicking one brings
  AIB to the front and opens that chat. Settings has Send a test notification.
- Sidebar: a + next to each project's chat count, folder icons on the project switcher, and Delete project (removes it
  from AIB; optionally sends the folder to the Recycle Bin).
- Chat cards and tabs keep the same size and text position in every state; branch lines are no longer clipped.
- Copy on your own prompts shows on hover or focus; the chat header no longer shows the agent's name; a bigger terminal
  button; the inbox count is never covered by the first tab.
- The agents page in Settings is AIB Linking; every server message, banner and log line says AIB instead of Studio.
- New project: a Project name now makes a folder with that name inside Folder (`C:\REPOS\` + `spaghetti` makes
  `C:\REPOS\spaghetti`), or uses it if it is already there; an empty name still uses Folder itself. A live line under the name
  says exactly what Create will do. A trailing `\`, a lower-case drive letter and `/` in Folder no longer keep Create disabled.
- Composer chips (Agent on the New chat page, Model, Mode, Effort) open a menu that lists the choices directly: one click
  picks, the current one is checked, descriptions show under their option, arrow keys / Enter / Escape / type-ahead work.
- A new chat offers the agent's models, modes and effort before its first message: AIB remembers the lists each agent
  reported (agent-options.json in the data folder) and, when it has none, asks the agent once with a quiet session/new.
  The picks are applied as soon as the session exists, before the first message is sent; a pick the agent no longer
  offers or refuses is named and the chat starts with the agent's own setting.
- Keeper, always on: running chats are held by a small separate program, AIB-keeper.exe (AIB-keeper on Linux and macOS),
  so they keep running when AIB restarts, updates or crashes: the next AIB picks each chat up where it was. There is no
  setting; an old saved keeper setting is ignored. In Task Manager you see AIB plus AIB-keeper.exe, not a separate agent host.
- Install now works while chats are running: the new version takes them over. If it cannot (an older keeper, or a chat
  running outside it), Install now waits for the chats as before and says why.
- If AIB crashes, the keeper starts it again in the tray (no window); open it from the tray icon.
- Coming from beta.3 (separate agent host): Install now with no chat working hands over at once and AIB runs as one process.
  With a chat working, that chat finishes in the old agent host (AIB says why); the next start runs as one process.
- If the keeper cannot run (its program missing or refusing to start), AIB still works without it, as before (chats stop
  on a restart), logs why, and Settings > About AIB shows one line saying so.
- Every package ships the keeper next to the app (Windows and macOS zips, Linux AppImage and .deb), executable on Linux
  and macOS; the build checks the zips for it.

## 0.1.0-beta.3 (beta)

- The tray icon is the colour AIB icon on light and dark taskbars (the app's and the agent host's), not a one-colour glyph.
- Windows: the app window shows the AIB icon in its title bar, in Alt+Tab and on its taskbar button.
- Desktop app: Ctrl+wheel and Ctrl+plus/minus no longer zoom the page; layout and view settings are kept in the data folder
  (studio-view.json) instead of only in the browser.
- Conversation: long first lines wrap around time and Copy, auto-follow and unread fixed, code-block Copy defaults to plain
  code, Run in terminal waits for the prompt, compact answered approvals, clearer form errors and approval wording.
- Sidebar: better Ctrl+K ranking, status words Idle / Not running, thin amber needs-you outline, keyboard and drawer focus,
  scrolling tab strip, archived chats open in a marked tab, pin star no longer clipped.
- Right column: a subagent history stays in Activity; Changes pages through large change sets with true counts; in-page
  confirms for Discard and Merge; a discarded chat stays readable; artifact Compare handles a missing final newline.
- Settings and setup: Settings fits at large interface sizes; turned-off agents show Turn on; uninstall refusals come first;
  one name, AIB, everywhere; appId dev.aib.app for the built app.
- Messages relayed from other agents, system notes and session summaries are collapsed notes, not your prompts (Prompts
  view, search, unread counts and chat titles).
- Updates: a failed check is retried after an hour and says when it failed; the full version is shown; the installed
  version's download is cleaned up.

## 0.1.0-beta.2 (beta)

- A terminal for each chat, docked under the message box (ConPTY on Windows, a pty elsewhere), and "Run in terminal" on shell
  code blocks in agent replies: it pastes the command and never presses Enter.
- One AIB per data folder: a second copy on the same folder shows the running app or refuses.
- New app icon; the Windows tray glyph follows the taskbar theme, and its right-click menu (Open AIB, Quit AIB) now works.
- The agent host keeps its own tray icon while chats run without the app, exits 10 s after it goes idle, and its agents end with it.
- Updates: Install now waits for a compatible host, confirms the new copy started, keeps the port and survives a crash mid-swap.
- Message times and Copy always visible; header and card status agree; the narrow drawer stays on top; saved tool rows get a mark.
- Host messages name the app instead of Python.

## 0.1.0-beta.1 (beta)

First release of AIB, the Agent Integration Bay. Beta: not code-signed, expect rough edges.

- A desktop app for Windows, macOS and Linux (x64 and arm64), built with Deno.
- One chat app for ACP coding agents: Claude Code, Codex and OMP.
- Several chats at once with streaming, tool calls, plans, approvals and questions.
- Saved conversations from Claude Code and OMP in one searchable list.
- A git worktree per chat, a Changes view, and a merge flow.
- Artifacts: pages and files agents make, shown beside the chat.
- Agent setup start page that finds or installs the agent adapters and runs their own sign-in.
- Separate long-lived agent host, so closing, restarting or updating the app never interrupts a running turn.
- Daily update check against GitHub releases, with downloads verified against `SHA256SUMS`.
- Loopback only, page token, same-origin checks; agents keep their own sign-in.
