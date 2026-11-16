# Changelog

## Unreleased

- Phone saved copies: read your recent chats with no connection. On a train or in a dead zone the phone used to show only
  "Can't reach your PC" and nothing to read. Now it keeps copies of up to 5 chats you opened recently (about 2 MB each, the
  oldest whole turns go first). A chat opens from its copy at once, then fills in from the PC. While the PC can't be reached,
  those chats still open from the chat list, or from the list under "Can't reach <PC>" when the page opens offline, read only,
  with "Showing saved copy from 14:05"; **Load earlier messages** pages back through the copy. The copies sit in the browser
  storage of the AIB page on the phone, not encrypted, like the key that pairs the phone. They go with **⋯ → Saved copies →
  Forget cached chats**, and when you remove the phone or untick **Keep saved copies of recent chats** for it in
  **Settings → Remote control** (on by default), once the phone reaches the PC again.
- Phone chat history: long replies show whole, and older messages load on the phone. A chat used to open with its last 300
  events, so a long reply (sent in hundreds of small pieces) lost its beginning, and a reply still being written could lose its
  start as new text came in. Above that the phone only said "Earlier messages are on your PC." Now a chat opens with its newest
  messages by size, never starting inside a reply or a run of steps. Tap **Load earlier messages** at the top, or just scroll up:
  older messages come in above without moving what you are reading. Chats that are not running page back the same way.
- Phone chats: updates no longer redraw the screen. Every 3 seconds a working chat used to rebuild every message and set the
  scroll position back by hand, so a scroll in progress could stop, selected text was unselected and spinners started over. Now an
  update changes only what is new: the reply being written grows where it is, a new message is added at the end, and everything
  else stays untouched. Your scroll position, selected text, open steps and Show output stay as they are; at the end of the chat
  you keep following new messages. The chat list updates only the cards that changed.
- Phone steps: Show output. Open a run of steps and tap **Show output** under a finished step to read its whole output, also
  when the chat clipped it.
- Phone saved chats: long messages keep their text. A chat that is not running used to cut every message at 8,000 characters
  without saying so. Now a message keeps up to 32,000 characters; a longer one says "Message shortened here. The whole message is
  on your PC."
- WSL path links: full Linux paths open as project files. Clicking /home/u/app/src/main.ts in a WSL chat's reply, or the open-file
  icon on an Edit/Write row, used to open it as "Outside this project", read-only. Now it opens in the Files tab like any project
  file, with its Changes badge and Show in Files, also in a chat's own copy.
- WSL path links: Linux names match exactly. In a WSL chat, readme.md no longer links to README.md (a click asked for a file that
  is not there); Windows projects still ignore case.
- WSL outside files: Ctrl+click on a Linux path outside the project now gets the same answer as an outside Windows file, instead of
  "That path is not a folder of this PC".
- WSL saved chats: outside-file links work when the chat is not running. A file outside the project that the saved chat's own
  transcript names opens read-only, as for Windows chats; if Ubuntu is not running, AIB says so and does not start it.
- Find more chats via agent: lists your Windows chats even with a WSL chat open. It used to ask the WSL chat's Linux agent and list
  nothing.
- Helpers stay off in WSL projects: AIB itself now refuses to start a helper for a WSL chat, not only the tool list.


- Always allow works in WSL chats: in a WSL chat every edit and every command used to ask, every time. "Always allow" was greyed
  out ("path could not be resolved", "the command runs outside the chat folder"), the agent's own Always button was hidden too, and
  even `git status` or `ls` asked. Now AIB checks a WSL chat's files with Linux rules inside the distro: "Always allow" on an edit
  makes a rule, and the next edits in that folder go through without a card; Safe reads such as `git status`, `ls` and `grep`
  answer by themselves; command rules work as in Windows projects. A link inside the project that points outside it is treated as
  outside and still asks. Project rules made in a WSL chat now stay with the project after AIB starts from another folder, and
  `/home/u/App` and `/home/u/app` are two projects. Your Claude settings in the distro (ask rules) are respected, not the Windows
  ones. When AIB cannot check something in the distro, the card says so and keeps the agent's own Always button.
- Continue asks only on real evidence: a Claude Code or OMP process that merely runs in the chat's folder (for example VS Code's
  Claude Code panel) no longer brings up "Another app may be using this conversation" when the transcript has been quiet for 30
  minutes; the chat continues and gets one note naming the process. A process naming the session, holding its transcript open, a
  recent transcript write by another app or another app's announcement still asks or refuses as before. Windows and WSL chats.

- Local-only folders in WSL projects: a chat in its own copy reaches the main folder's private/ again. Folders git never commits
  (private/ by default) live only in the project's main folder, so a WSL chat in its own copy could not see them. Now its agent
  can read and write them by their Linux path (for example /home/u/app/private), and is told where they are. Files shows them in
  every chat's copy, Git exclude and Undo work in WSL projects, and AIB backs them up once a day inside the distro. Live sync and
  Merge leave them out, as on Windows.
- WSL chats in their own copy see everything git ignores in the main folder: folders and files listed in .gitignore or
  .git/info/exclude (game/review/, .env, node_modules) used to be missing from a chat's copy. Now the Files tab lists them in the
  copy, opens their folders at any depth and shows their files and pictures. Excluded folders such as private/ are shown in normal
  colour; .gitignore ones stay dimmed. The chat's agent can read and edit them in the main folder by their full Linux path. AIB never
  writes a .gitignore.


- WSL: a one-off tool, `deno run -A tools/wsl-import.ts`, moves the chats a WSL project had before worktree copies into their own
  copies (own branch, Changes, Merge). It starts with a dry run, keeps a backup of each moved history file, and can undo.
- Path links in WSL chats: a file the agent published as an artifact opens that artifact. Clicking `out/chart.png` or `report.html` in a reply
  now opens the published page in the Artifacts tab, as in a Windows chat, instead of the plain file.
- WSL screens: spacing, contrast and wording fixes.
- WSL chats survive AIB being away: the Linux keeper keeps a distro's agents running for 2 hours without AIB, not 35 seconds. An
  AIB restart, crash, update or test-build swap, or an older AIB build that stopped the keep-alive, no longer stops claude or codex
  chats working in WSL; the next AIB within those 2 hours takes every one of them over. Each time an AIB (or the keep-alive)
  connects, the 2 hours start again. After 2 hours with nothing connected, the agents stop and the keeper's log says so.


- Artifacts: a failed publish or update card now shows the tool's own reason on a line under "The publish did not finish" (for
  example "File not found in Ubuntu: /home/u/app/chart.png ..."), in every chat, as plain text.
- WSL chats: the agent can publish a file from the distro by its path, a PNG, PDF or HTML page included (up to 25 MB), as in a
  Windows project. Paths are relative to the chat's folder, or absolute inside the chat's or the project's folder; AIB reads the
  file through its helper in the distro and keeps a copy as it was then (after changing the file, the agent publishes it again
  with update). A refusal names the Linux path and the reason (not found, a folder, too large, outside the project, unreadable,
  changed while reading). Windows chats' tools are unchanged.
- AIB Linking (WSL): when asdf has no Node.js version set, the command to copy now matches the distro's asdf: `asdf set -u nodejs
  latest` for asdf 0.16 or newer, `asdf global nodejs latest` for older asdf (both, labelled, when AIB could not read asdf's version).
- AIB Linking (WSL): the git and curl install lines follow the distro's package manager (apt, dnf, yum, zypper, pacman or apk);
  for a distro AIB does not recognise it says to install them with the distro's package manager. Still text to copy only.
- AIB Linking (WSL): Close on the Node.js install panel or an agent's sign-in panel now also stops that program in the distro, as
  on Windows; before, it kept running unseen (and Remove AIB from Ubuntu refused because of it).
- Phone: New chat in a WSL project offers the agents by that distro's own On/Off switch (Settings > AIB Linking (WSL)), not the
  Windows one, and says "Turned off for Ubuntu" for the ones switched off there. Windows projects are unchanged.
- WSL: checking an agent install's progress no longer starts a distro that is not running; it answers "no install running" with
  the distro's state instead.
- AIB Linking (WSL): "AIB in Ubuntu" shows how much disk AIB takes in a distro, by part (helper and keeper versions, installed
  agents, npm cache, this AIB's data, chat copies, chat records and logs), the other AIB data folders found there and whether
  another AIB build still uses them. Reading it never starts the distro.
- AIB Linking (WSL): Remove AIB from Ubuntu deletes this AIB's own folder in the distro and lists everything first, with sizes. It
  refuses while a chat there is working, a chat or terminal still runs, a sign-in, Node.js set-up or agent install runs, or a chat
  copy has changes that are not committed (new files count). Installed agents, the npm cache and the helper versions go only when no
  other AIB on this PC uses them. Your ~/.claude, ~/.codex, your projects and their branches are never touched, nothing outside
  AIB's folder is ever deleted, and links are never followed.
- AIB Linking (WSL): after Remove, nothing starts that distro or puts AIB back into it (not a chat, not a restart of AIB) until you
  click Set up again, which installs AIB there afresh. Chats that worked in a removed chat copy say "workspace removed".

- AIB in Ubuntu: see what AIB takes up in each WSL distro, and remove it cleanly. Settings > AIB Linking (WSL) has a new card per
  distro with the disk space AIB uses there, part by part (its programs, the agents it installed, the npm cache, this AIB's data
  folder and chat copies, logs, in all), the AIB versions installed, how many chat copies have unsaved changes and how many chats
  are working now. Other AIB builds' data folders in the same distro are listed too, marked "in use" when that AIB runs, and are
  never touched. Reading the card never starts the distro.
- Remove AIB from Ubuntu: before anything is deleted, a dialog lists exactly what goes (with sizes), what is kept and why (parts
  another AIB build still uses), and says your projects, `~/.claude`, `~/.codex`, nvm and asdf are not touched and chat branches stay
  in your repos. It will not run while a chat works there, an install or sign-in runs, or a chat copy has uncommitted changes, and
  says which. Confirming takes a second click. Afterwards the distro reads "AIB is not set up in Ubuntu" with Set up again; if
  something could not be deleted, AIB lists it.
- AIB Linking (WSL): each distro has its own On/Off switch per agent. Turning Claude Code off in Ubuntu no longer depends on, or
  touches, its Windows switch: a new chat (or Continue) in a WSL project with an agent turned off for that distro says so ("Claude Code
  is turned off for Ubuntu in Settings > AIB Linking (WSL)"), and Windows chats never read the distro switch.
- AIB Linking (WSL): the agent rows of a distro now carry its sign-in state, whether AIB installed it (so it can be uninstalled), and
  for Codex the usage limits of the distro's own sign-in (never mixed with Windows').
- AIB Linking (WSL): Uninstall removes the copy of Claude Code or Codex that AIB installed in a distro; it refuses while that agent's
  install or sign-in runs or a chat uses it, and never touches your own installs or your sign-in.
- AIB Linking (WSL): a prerequisites check per distro (Node.js, npm, git, curl, free space), read without ever starting the distro.
- AIB Linking (WSL): "Install Node.js in Ubuntu" runs nvm's installer in a terminal panel inside the distro, showing every command
  first; the installer script is checked against a pinned checksum before it runs, then nvm installs the Node.js LTS. No sudo.
- Node.js via nvm: one pinned nvm version everywhere AIB offers it (Beta agents on Linux and macOS, the distro copy line, the WSL
  button), and the installer script is now checked against its SHA-256 before it runs.
- WSL projects: work on code that lives in Linux without leaving AIB. New project and Add project offer "WSL: Ubuntu" (any WSL2
  distro) next to Windows. Claude Code, Codex, OMP and your custom agents, installed in the distro, run there, in the Linux folder,
  with the distro's own git, node and login environment, so nothing crosses the slow `\\wsl$` share and no Windows tool touches a
  Linux repo. Chats, the terminal (your login shell, titled "bash (Ubuntu)"), Files and Changes all work, and every agent in every
  distro sits in the same inbox and sidebar as your Windows chats. It all stays on your PC: AIB copies two programs (about 110 MB, once
  per version) into `~/.aib-server` in the distro and talks to them through `wsl.exe`, with no network port opened. An agent's
  sign-in page opens in your Windows browser; any other link from the distro asks first. Quitting AIB keeps WSL agents working, as it does for Windows chats, and the
  next AIB picks them up; ended WSL chats stay listed and can be continued. In a WSL project the Files tab previews
  pictures and pages like any project, and opens files a chat wrote outside the project folder. Delete project can move the folder to
  the trash in Ubuntu (the "Move folder to trash in Ubuntu" tick box; never a permanent delete, and it refuses your home folder,
  other projects and folders on a Windows drive). A WSL chat's Codex usage limits show up in the chip, read from the distro's
  `~/.codex`. A new chat in a WSL git project works in its own copy (a git worktree made inside the distro, next to AIB's other files in `~/.aib-server`), as on Windows: Files shows the copy or the main folder, Changes shows the chat's branch, Discard removes the copy and its branch, and the chat keeps its copy across AIB restarts. Merge works there too: the Merge button (or asking the chat) lands the chat's own commits on main, runs entirely inside the distro with Linux git, brings main into the copy first when it moved (conflicts go back to the chat), and sets your uncommitted edits in the project folder aside and puts them back, never overwriting them (if they clash, they stay in a named stash and "Keep my version" restores them). Live sync works there too: a file you save in the WSL project folder reaches the chat's copy within a second or two (AIB watches it from inside the distro, where Windows would miss the change), the chat's next message tells it which files you changed, a file you both edited is combined in the chat's copy at its next turn, and an edit on the same line is never overwritten: the chat's copy gets conflict markers, your file stays as you saved it, and the clash line shows until the chat resolves it. Not in WSL projects yet: Docs; AIB tools there are limited to artifacts and merge. While a WSL project is open or a WSL chat runs, the distro
  keeps running (VmmemWSL memory in Task Manager).
- WSL projects: Install in Ubuntu. When Claude Code or Codex is missing in the distro, the new-chat panel has an "Install in Ubuntu"
  button instead of only a command to copy. AIB installs the same reviewed versions it uses on Windows into its own folder there
  (`~/.aib-server/agents`; never a global npm install, nothing else in the distro changes), with a progress bar and Cancel, and the
  install keeps going if AIB restarts. When AIB moves to a newer reviewed version, the panel offers "Update in Ubuntu". The distro needs
  Node.js 22 or newer: if it has none, the panel says so, shows the command that installs it (no sudo needed) with Copy, and
  "Check again" picks it up without restarting anything. Codex's sign-in in the distro now also works with AIB's install.
- WSL projects: background commands. The Activity pane of a WSL chat now lists the commands Claude Code runs in the background in
  the distro (a long test run, a dev server) and its subagents, with how many are still running and each command's latest output, as
  for a Windows chat. While such a command runs, the chat counts as still working in the background, so quitting or updating AIB
  warns you instead of cutting it off. If Ubuntu is not running, the pane says "Command updates unavailable: Ubuntu stopped.
  Reconnect" instead of "No commands running".
- WSL projects: Stop a background command from AIB. A command a WSL chat left running in the background (a dev server, a long
  test run) now has the same Stop button on its "Still running in the background" row as in a Windows chat, so you no longer have
  to ask the agent to end it. Stop ends that command and whatever it started inside the distro, and the row then reads "Stopped by
  you". It only ever touches processes AIB saw that command start: another chat's commands, the agent itself and anything else in
  Ubuntu keep running. The button appears a moment after the row does, once AIB has checked the command's processes in the distro.
- WSL projects: no second agent on one conversation. Before continuing a saved WSL chat, AIB now checks inside the distro whether
  another program already has that conversation open (for example `claude --resume` in a VS Code terminal in Ubuntu) and refuses with
  "This claude conversation is already open in another agent process (PID …)", exactly as for Windows chats. A chat written to
  moments ago by another app asks before continuing. AIB's own agents in the distro never count, and the chat list's "Elsewhere"
  hints now cover WSL chats too.

- WSL projects: Codex found behind asdf and mise. Codex installed in a distro under its current npm name
  (`@agentclientprotocol/codex-acp`, the one AIB's install hint gives) is now found, also when Node.js comes from a version manager
  such as asdf or mise, and its sign-in uses the Codex program that ships with it, so no separate `codex` command is needed.

- WSL projects: checking a distro's agents no longer starts it. The routes behind the coming Settings > AIB Linking (WSL) page read
  WSL's distro list from the registry only (with WSL's default distro and the distros AIB cannot use, and why) and answer
  "not running" for a distro AIB has not used yet, instead of starting it; only your click starts one.

- AIB Linking (WSL): every agent in every distro on one Settings page. A new Settings section, right under AIB Linking (Windows
  only), lists the WSL distros on this PC: which one is WSL's default, which ones AIB cannot use and why (a WSL 1 distro gets the
  command that converts it), and how to get WSL when the PC has none. Each usable distro has its own cards: its state (Ready, Not
  running with "Start Ubuntu and check", Stopped with Reconnect) and "Agents in Ubuntu" with the same agent cards as on Windows:
  Install in Ubuntu, Update in Ubuntu, progress with Cancel, Retry after a failure, and the Node.js line when the distro has none.
  Each card says whether AIB installed it or it is your own install. Opening Settings never starts a distro: only the Start button
  does, and it says it copies AIB's helper there (about 100 MB).
  The new-chat panel's "not installed in Ubuntu" line gets a "Set up Ubuntu in Settings" link, and Settings > About links here.

- AIB Linking (WSL): pick a distro, see what it needs, and manage its agents in one place. A drop-down at the top of the page lists
  every distro on this PC (WSL's default marked, the ones AIB cannot use greyed out with the reason) and shows that distro's cards;
  AIB remembers your pick, and opens on the distro of the WSL project you have open. A new "What Ubuntu needs" card checks Node.js
  (22.19 or newer, with where it comes from), npm, git, curl and free space the way your Ubuntu terminal sees them. When Node.js is
  missing or too old, "Install Node.js in Ubuntu" runs nvm's official installer in a terminal right on the card, and the agents can
  be installed as soon as it finishes. If your Node.js comes from asdf or mise with no version set, the card gives you that tool's
  own command instead, and git or curl get the `sudo apt install` line to copy (AIB never runs sudo). Each agent now has its own
  "Use in Ubuntu" switch, separate from Windows, so Claude Code can be on in Ubuntu and off on Windows. Agent cards show whether
  you are signed in there (and as whom), with a Sign in button that runs the agent's own sign-in in a terminal on the card;
  Uninstall removes only AIB's own copy in the distro, never your installs or sign-in files; and Codex shows the usage limits of
  its Ubuntu sign-in.

- Ready and Couldn't reopen: clear words for a chat with no agent. A saved chat that has no agent running now says Ready instead of
  Not running (it opens read-only with its saved messages, and an agent starts when you send a message), in the sidebar, the chat
  header and on the phone. A chat AIB tried to reopen after a restart and could not now says Couldn't reopen, with the
  reason when you hover; sending a message tries again.

- Live sync no longer holds back a file you save right after a commit or a Merge. A save made in the moment after the project's
  branch moved (your own commit, or Merge landing a chat) could wait for the chat's next message before reaching its copy; it now
  arrives within a second or two like any other save, on Windows and in WSL projects.

- One agent per chat after a restart. When AIB restarts while a chat's agent is still running (on Windows or in a WSL distro) and
  could not take it over right away, for example because Ubuntu was slow to start, reopening the chat now picks up that running
  agent instead of starting a second one for the same conversation. The chat keeps its history and its running turn, and it is
  listed once.
- WSL chats no longer get stuck showing Ready (no agent) after a restart or update. If their agent is still running in the distro, AIB now
  picks it up even when its list of open chats lost the chat, and continuing such a chat picks up that same agent instead of starting
  a second one for the same conversation (Codex refused that second one with "session is in use by another Codex client"). A distro
  whose AIB helper was being replaced is started again instead of counting as not ready. A chat AIB could not reopen after a restart
  now says "Couldn't reopen", with the reason when you hover, and sending a message tries again.

- AIB tools in WSL projects no longer depend on WSL interop. A chat's artifact tools (publish, list, update and now archive) and its
  merge tools reach AIB through AIB's own tunnel inside the distro: the agent's tool talks to AIB's helper over a private socket in
  `~/.aib-server`, and the helper passes it to AIB over the connection AIB already keeps. No network port is opened, nothing on
  Windows is exposed to Linux, and each chat's own key is checked as before. It keeps working where interop is switched off, and a
  tool call made while AIB is closed says so at once instead of hanging. Helper chats are still not available in WSL projects; the
  chat's note says which tools it has.
- WSL projects: Docs. Docs and drawings work in WSL projects as they do on Windows. The aib-docs row in Files lists the project's
  docs with "+ New doc"; a doc opens in its tab with live editing, pages, comments, charts, drawings, history and Restore; and the
  chat's agent in the distro gets the doc tools (doc_create, doc_read, doc_edit and the rest), so you and the agent can write the
  same doc at the same time without losing each other's words. The doc lives in the project, inside the distro:
  `aib-docs/<doc>/doc.aibdoc` and its readable `.md` page copies sit next to your code, ready to commit, and an edit an agent's file
  tools make to them there is taken in. Every save is atomic (a temp file, then one rename, in the distro). If the distro stops while
  a doc is open, AIB keeps your edits and writes them once it is back. Move doc to trash uses the distro's trash.

## 0.1.0-beta.9 (beta)

- Removed the ⋯ menu at the bottom of the sidebar.

## 0.1.0-beta.8 (beta)

- Removed the separate agents & command monitor page; the sidebar, Activity and terminal cover it.
- Projects are only the ones you add. A new AIB starts with no projects, even if you used Claude Code or OMP before: add one
  with New project (+ above the chat list), or start a chat in a folder. Saved chats of folders you did not add stay out of
  the project list, the chat list, Ctrl+K and the inbox, and so does "Find more chats via agent"; nothing on disk changes.
  A project you add stays listed until you remove it with Delete project, even when it has no chats yet, and its old chats
  do not bring it back; while its folder is gone it is not listed. Chats in a git worktree belong to the project of the main
  folder.
- Scrolling in a chat has one owner now, and only you move the list. While you read, new replies, steps finishing, pictures
  loading, long blocks folding, text size, window and pane size changes and view switches no longer move the row you are on,
  not even for a frame. At the bottom it follows every update. Any scroll of yours counts, including the scrollbar, the
  keyboard, Tab and dragging a text selection. Every chat, subagent and split pane remembers where you were reading. When you
  go back, it opens there with the "New" line and the count for anything that came in, and the place survives restarting AIB.
  Clicking into the other split pane keeps both panes' places. Clicking "Show earlier" while a reply is coming in stops
  following, because you are reading older messages now; "↓ Latest" takes you back. For this release the old scrolling can
  be switched back on (the view preference `aib-scroll-v2` set to `0`), in case the new one misbehaves.
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
- The chat no longer shows raw "Delegation" blocks for messages an agent sends its helpers; the tool row and the helper's own view already show them.
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
