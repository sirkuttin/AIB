# Changelog

## Unreleased

- Keeper (off by default): Settings > AIB server > "Keep chats running through updates and restarts (keeper)". It takes effect
  the next time AIB starts; `AIB_KEEPER=1` or `AIB_KEEPER=0` where AIB is started overrides it, and Settings says so.
- With the keeper on, running chats are held by a small separate program, AIB-keeper.exe (AIB-keeper on Linux and macOS), so
  they keep running when AIB restarts or updates: the next AIB picks each chat up where it was.
- Install now works while chats are running: the new version takes them over. If it cannot (an older keeper, or a chat
  running outside it), Install now waits for the chats as before and says why.
- AIB runs as one process plus AIB-keeper.exe, instead of the app and a separate agent host.
- If AIB crashes, the keeper starts it again in the tray (no window); open it from the tray icon.
- Turning the keeper off never stops a chat: chats it holds keep running until they end, new chats run as before.

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
