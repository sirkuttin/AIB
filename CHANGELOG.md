# Changelog

## 0.1.0-beta.8 (beta)

- New app icon: a solid black top hat with a thin teal rim and the two agent squares on it, with no teal tile behind it. The
  hat is about a third bigger, so it is easier to spot on the taskbar, in the tray and in Alt+Tab. The black shows on light
  taskbars and the teal rim on dark ones. The 16 to 32 px versions are drawn pixel by pixel, so they are sharp instead of
  blurry. The tray, the window, the installer and the browser tab all use it.
- Quitting AIB no longer kills a command Claude started in the background (Bash with run_in_background, such as a long test
  run) after its reply ended. The chat counts as working for Quit AIB, updates and the tray until the command ends, so the
  keeper holds it and the next AIB takes it over. It does not show as Working in the chat or hold your queued messages.
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
  icon (View). The artifact picker lists this chat's artifacts, then "Docs this chat wrote".
- Where docs open: a doc from a chat (its card's Open doc, a doc link or "open ↗" in a reply, `/doc`, the picker's "Docs this
  chat wrote", Open doc on "Built from" and after Edit) opens in the right column's Artifacts tab, where artifacts open, in the
  full doc editor; the chat keeps its full width. A doc opened from Files or Ctrl+K opens as a tab in the tab strip, like a
  file (a preview tab on a single click, kept on a double-click). Docs never open beside the chat any more.
- A doc an agent makes while you work never takes the focus: the Artifacts tab's count goes up (it now counts this chat's
  docs too), and the doc's row there is marked with a dot and a "New: <doc> · Open" line.
- Files: `aib-docs` is always the first row of the tree, above every other folder (dot-folders too), even before the first
  doc exists. It has the accent doc icon instead of the folder outline, and on the right says how many docs it holds: "3
  docs", or "3 docs · 1 changed" when it has changes.
- A file beside the chat starts at 45% of the room between the chat list and the right column, not a narrow strip. Drag the
  divider on its left edge to resize it (the chat keeps 420 px, the file 360 px); the width is remembered as a share of that
  room, so it fits any window size. Double-click or Enter on the divider resets it; the arrow keys move it (Shift for bigger
  steps).
- Built from: a page built from a doc shows "Built from <doc>" with Open doc; when the doc has changed since, it says so and
  offers "Rebuild from the doc", which sends the chat a normal message. The doc header shows "Shown in N artifacts".
- Markdown artifacts have an Edit button (it replaces "Make it a doc"). Request a change puts the artifact into the message
  box as a link and focuses the box, so you type what to change and the chat does it.
- File view: "Source | Page" is now "Source | Preview".
- Docs in worktree chats: a chat working in a git worktree reads and writes docs in the main project's `aib-docs/`, never in
  its own worktree folder, so every chat sees the same docs.
- Docs show their title, not the folder name, in Files, pickers and chat cards.
- Quitting AIB never stops a chat, and AIB really quits. Closing the window or Quit AIB while a chat works (a turn, a queued
  message, a background helper, a question waiting for you) or a terminal command runs: no question box; AIB exits the way
  Install now does, and the keeper holds the chats: the agents go on and everything they say is recorded. The next AIB you
  start (this one, or a newer build unzipped into another folder) takes them over as they are, questions that came meanwhile
  included, and sends queued messages then. A merge under way is let finish first. While AIB is closed, an agent's AIB tools
  (artifacts, docs) answer at once "AIB is closed; try again later". With nothing working, Quit quits at once, as before.
  If the running keeper is too old to hold chats (or a chat runs outside it), AIB stays in the tray until nothing works, as
  before. If a newer AIB cannot take the keeper's chats over, a notice says so and nothing is stopped.
- The tray menu is Open AIB, a status line, Quit AIB and Stop all chats and quit, the one way to stop everything. Its first
  click turns the item into "Click again to stop 2 chats and quit" for 10 s; a second click stops them and quits. No box.
- AIB ended by a signal (macOS/Linux `kill`, a session ending) with a chat working leaves the chat in the keeper, which brings
  AIB back in the tray, as after a crash; it no longer stops the chats.
- Merge from the chat: the agent merges its chat's work into main on its own when the work is done and tested (for example
  before a release), or when you ask; no button needed. Each merge posts a "Merged into main" line in the chat. The work lands on the project's main branch (main, else
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
- Claude chats leave Working when the reply ends, even while background helpers still run, and your queued messages go at
  once. A chat whose helpers still run counts as working for quitting, updates and the keeper.
- Subagents: a working helper is a card with its model and type, tokens used and what it is doing now ("Running: …",
  "Editing chat.js"); a finished one is a single line with its outcome when it failed or stopped, its model and how long it
  ran. The subagent header shows the model and tokens too. Stop sits on the subagent's title row with an in-place
  Stop · Cancel instead of a pop-up.
  A helper shows the model it really runs (a Sonnet helper of an Opus chat says Sonnet 5.5) and its run time from start
  to finish. Interrupt stops only the reply: background helpers keep working and no longer show as Interrupted, and a
  helper's own settings no longer replace the chat's model and mode chips.
- Scrolling: scrolling up, even one wheel notch, stops following at once, and following comes back only at the very bottom or
  with "↓ Latest". A following chat stays at the bottom when content grows after a redraw, when an approval card or the
  terminal appears, and when the message box grows. Opening a step or "Show all" near the bottom keeps it where it is.
  Opening a chat with unread messages lands on the "New" line, and switching Full / Chat / Prompts keeps the row you were
  reading. Long blocks no longer flash open for a frame on every update.
- Claude Code chats on the newest models (5.x) keep a to-do checklist again: AIB turns on Claude Code's task tools
  (CLAUDE_CODE_ENABLE_TODO_TOOLS=1 unless you set it yourself), and the checklist shows as a plan card that ticks off its
  steps.
- A chat has one plan card: each update replaces it, and while steps are open it stays the chat's last item, also after you
  send another message, instead of leaving a snapshot in the earlier turn.
- Plan steps in progress spin while anything works for the chat, its own reply or its helpers after the reply ended; three
  dots only when nothing works.
- Subagent cards show the helper's own model (e.g. Sonnet 5.5) and its real run time. A helper is no longer marked
  "Interrupted" when you interrupt the main reply (Claude Code keeps background helpers running); one the agent really
  stopped says "Stopped", one that failed says "Failed". A helper's settings no longer change the chat's model and mode chips.
- The right column widens to 920 px (where a doc shows its page list), never narrower than it already was, while a doc or artifact shows in the Artifacts tab, and goes back to your width when it
  closes or you switch tabs; a drag while viewing is remembered as the viewer width.
- Limits chip after Ctx: subscription usage per agent account, percent used ("5h 42% · wk 18%", "wk 26%"), with reset times
  and freshness on hover, the warning colour from 85% and red when blocked. Claude Code from the limits it already sends,
  Codex from its session files (else its app-server), Mistral Vibe from its account request, Qwen as "limit reached".
  Official sources only; no chip for OMP and agents without one. Chip tooltips open toward the side with room.
- Asking any agent for "a doc" makes an AIB doc (`doc_create`); AIB's tool server and start note say so, and Codex now gets
  AIB's start note. Tool rows for AIB's own tools read "Create doc: <title>", "Publish: …" and so on.
- A chat's start note says to merge finished helpers into its copy and to merge into main itself once the work is done and
  tested.
- Memory and speed: the page no longer keeps every redrawn screen in memory (a leak since beta.1), long blocks are measured
  in one pass, typing no longer re-lays out the history, and only changed rows are redrawn.
- The plan card lists steps in progress first, then steps to do, then one folded "✓ N done ▸" line that opens on click.
- The Activity tab shows how many subagents are working right now, like the counts on Changes and Artifacts.
- The chat keeps your place when its width changes: opening a doc or artifact, a file beside the chat, or a narrower
  window. At the bottom it stays at the newest message; while reading, the same row stays where it was.
- Full view: steps still in progress stay listed one by one; they fold into "N steps" once they are done and something
  arrives after them.
- Files remembers which folders are open, per project and per tree. Rows show a hover highlight in light themes too.
- Inbox: the chat you have open never counts as "your turn", even while AIB is in the background, and the badge and its list
  always agree.
- AIB opens on the project you had open when you quit it, also when you start a new copy unzipped into another folder. A
  change is saved to AIB's data folder at once instead of half a second later, so quitting right after picking a project
  no longer loses it, and reopening the chat that was in the middle no longer moves the sidebar to that chat's project.
  Files tabs and open folders, the Chats | Files switch and the inbox's seen chats are kept in the data folder too.
  This also holds when the last chat runs in a worktree made from a Claude Code worktree (.claude/worktrees): AIB used to
  open on the first project in the list and that project's chat. A chat listed under two projects keeps its tab in its own
  project only.

## 0.1.0-beta.7 (beta)

- Installing or signing in to a Beta agent turns it On, and a Ready Beta agent shows in New chat unless you turned it off.
  Agents that aren't ready show greyed out, with the reason and "Set up in Settings ›".
- Buttons on Settings agent cards keep the card in place (no scroll jump).
- The first message of a new chat is always sent, even if you switch chats while the agent starts, and links in agent
  errors are clickable.
- Merge into main asks the agent: the Changes tab's Merge button sends the chat a fixed merge request (shown as a collapsed
  "Merge requested" chip) and gives that chat a one-time permission to merge, tied to its work at the click. Without the
  click, the agent's merge tool merges nothing and points you to the button. A merge that lands uses the permission up;
  conflicts keep it for the next round; your next own message ends it. No confirmation dialog. The button is off, with the
  reason, for closed, archived, read-only and Elsewhere chats.
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
