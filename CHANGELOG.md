# Changelog

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
