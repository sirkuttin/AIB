# Agent Studio page code

The page (`chat.html`) is plain JavaScript and CSS served as they are. There is **no build step and none may be added**: no bundler, no transpiler, no TypeScript. Every `.js` file next to `chat.html` is a classic script; `chat.html` loads them with `defer`, which runs them in the order they appear in the file. That order is the dependency order, and it is the table below.

## How the scripts fit together

- Each script is one function wrapper (`(function (root) { ... })(window)`, or an arrow IIFE) so nothing leaks. It hands the rest of the page **one global on `window`** (some also an alias).
- A script never reaches for another script's internals. It either reads the other script's global (`window.AgentChoice`, `window.StreamUI`, ...) or is given what it needs through an `init(host)` call from `chat.js`. A script that reads a global written by a later script has a bug: check the order below.
- Pure logic (no DOM, no storage, no clock) is kept apart from drawing, and ends with `if (typeof module === 'object' && module.exports) module.exports = api;` so Node tests can `require` it.
- **`chat.js` is last.** It is the page itself: conversation list, the open chat, polling, sending, history windows, the New chat form, split-view side panes. It wires every other script together and exports only `window.AgentStudioGet` (an authenticated GET other scripts use), `window.AgentChatView` (`setThinking`, `getThinking`, `startHandoff`, `renameChat`, `notices`) and `window.StudioChat`, a **test hook** the page never reads (see "Tests").
- `elicitation-ui.js` is not in `chat.html`: `chat.js` loads it on demand when the server says it supports questions (`window.AgentElicitationUI`).
- The monitor dashboard (`index.html`, `conversation.html`, `app.js`, `sidebar.js`, `style.css`, `sidebar.css`) is a separate page with its own scripts. It shares no code with `chat.html`.

## Load order and globals

| # | Script | Global | What it does |
|---|---|---|---|
| 1 | `markdown.js` | `AgentMarkdown` | A deliberately small Markdown subset for agent messages. Raw HTML stays text; images never fetch remote resources. |
| 1b | `run-terminal-ui.js` | `RunInTerminalUI` | "Run in terminal" on shell commands (shell-language fences, a lone command line, tool calls that ran a command): pastes into the chat's terminal (`window.AibTerminal.paste`), never presses Enter. Icon button left of Copy and at the end of a collapsed command row; it reads "Pasted" (or "Not pasted") for 2 s, no toast. No button without `window.AibTerminal`. `commandText` (which code counts, prompts stripped, output skipped) is pure. `copy-ui.js` calls `decorate`, `tool-views.js` `decorateLine`; `chat.js` gives it the open chat's key (`init`). |
| 2 | `tool-views.js` | `ToolViews` | Views for tool calls, diffs and non-text content; pairs saved tool calls with their results. Everything goes in with `textContent`. |
| 3 | `editors-ui.js` | `AgentEditors` | "Open in editor": which editors the PC has, the default one, and the menu items that open a folder or a file at a line. |
| 4 | `copy-ui.js` | `CopyUI` | Copy buttons for each message and code block (Markdown, rich HTML, plain text). |
| 5 | `stream-ui.js` | `StreamUI` | Message-stream helpers: turn-end divider, collapsed cards for injected text, row windowing for the main list and split side panes, the cheap **change signature** (`rowsSignature`) and the logic for **screen-reader announcements** (`newTurns`). |
| 6 | `unknown-send.js` | `UnknownSend` | The quiet warning under a message whose delivery is unknown after a Studio restart. |
| 7 | `image-viewer.js` | `ImageViewer` | Lightbox for pictures already on the page. |
| 8 | `attachments-ui.js` | `AttachmentsUI` | Composer attachments: limits, capability checks, drag and drop, retry fingerprints, file cards. |
| 9 | `commands-ui.js` | `AgentSlashCommands` | Slash-command completion in the message box. |
| 10 | `config-ui.js` | `AgentConfigUI` | Settings-panel controls for every ACP config option type. |
| 11 | `session-ops.js` | `AgentBreadth` | Header status strip, session operations in the ••• menu, slash-command wiring. |
| 12 | `terminals-ui.js` | `AgentClientCapsUI` | Client terminals and file writes the agent was allowed to use. |
| 13 | `ownership-ui.js` | `AgentOwnershipUI` | Ownership evidence: sidebar hints, header hint, the "Continue anyway" confirmation. |
| 14 | `organize-ui.js` | `AgentOrganizeUI` | Pin, archive and delete for the conversation list. |
| 15 | `status-words.js` | `AgentStatusWords` | The one status vocabulary (Working, Your turn, Needs you, ...). Pure. |
| 16 | `attention-ui.js` | `AgentAttentionUI` | "Whose turn is it": the header badge and the line above the message box. |
| 17 | `agent-choice.js` | `AgentChoice` | Pure logic for the Agent chip: which agents exist, which one a new chat starts with, which folder, hand-off text. `chat.js` also reads it by its bare name. |
| 18 | `composer-chips.js` | `AgentComposerChips` | The setting chips under the message box. |
| 19 | `notify-ui.js` | `AgentNotifyUI` | Desktop notifications and toasts when a chat needs you or hands the turn back. Fed by the conversation-list poll, which keeps running in a hidden tab for this reason. |
| 20 | `sidebar-ui.js` | `AgentSidebarUI` | Projects and per-conversation status in the sidebar. |
| 21 | `commands-registry.js` | `AgentCommands` | Command bar brain: fuzzy matching, action registry, shortcut sheet. Pure. |
| 22 | `switcher-ui.js` | `AgentSwitcherUI` | Ctrl+K quick switcher and sidebar shortcuts. |
| 23 | `textsize-ui.js` | `AgentTextSize` (alias `TextSizeUI`) | Chat text size, code font and line spacing, remembered per window width. |
| 24 | `resize-ui.js` | `AgentResizeUI` (alias `ResizeUI`) | Resizable panels: list, Activity column, message box. |
| 25 | `workspace-state.js` | `AgentWorkspaceState` | Pure workspace state: projects, open tabs, inbox. |
| 26 | `new-project-ui.js` | `AgentNewProjectUI` | The "New project" dialog. |
| 27 | `inbox-reply.js` | `AgentInboxReply` | Quick reply from the inbox: the pure parts. |
| 28 | `workspace-ui.js` | `AgentWorkspaceUI` | Project rail, inbox, open-chat tabs, list header. |
| 29 | `split-tree.js` | `AgentSplitTree` | Split view, pure logic: what a layout is and how it changes. |
| 30 | `split-ui.js` | `AgentSplitUI` | Split view, the page side: draws the panes, moves the real chat view into the focused one, takes drags and keys. |
| 31 | `subagents-ui.js` | `SubagentsUI` | The Activity pane's subagent list. |
| 32 | `activity-ui.js` | `ActivityUI` | Activity column chrome: hide/show, the narrow strip, chips. |
| 33 | `changes-ui.js` | `AgentChangesUI` (alias `ChangesUI`) | The Changes tab: what git sees as uncommitted, with diffs. |
| 34 | `artifacts-ui.js` | `AgentArtifactsUI` (alias `ArtifactsUI`) | The Artifacts tab, stream cards and Preview buttons. Pages run in a sandboxed iframe. |
| 35 | `clamp-ui.js` | `ClampUI` | Long blocks in the history are clamped with a "Show all N lines" toggle. |
| 36 | `header-ui.js` | `AgentHeaderUI` | The one-line chat header with inline rename. |
| 37 | `queue-ui.js` | `AgentQueueUI` | Queued messages above the message box. |
| 38 | `settings-ui.js` | `AgentSettingsUI` | The Settings page. |
| 39 | `plan-ui.js` | `PlanUI` | Folds plan updates into one card per turn. |
| 40 | `views.js` | `ChatViews` | Condensed chat views, the pure part: which rows Outcomes and Chat show, and the per-chat choice. |
| 41 | `views-ui.js` | `ChatViewsUI` | The view switch in the chat header, the drawn groups, the scroll anchor on a switch. |
| 42 | `chat.js` | `AgentStudioGet`, `AgentChatView`, `StudioChat` (test hook) | The page. Last, because it uses all of the above. |

Stylesheets load before the scripts; their order is the `<link>` order in `chat.html`.

## Colour tokens

`theme.css` loads first in `chat.html` and defines every named colour once in `:root` (60 tokens). The other page stylesheets paint with `var(--token)` and hold no copy of those values. Step 1 of the themes work changed no colour: `work/test_theme_tokens.py` resolves every `var()` in every stylesheet and compares each rule with the stylesheets as they were at the commit before the change (pinned in the test). A theme is a different set of values for this one block.

Rules for the tokens:

- A token is shared only where the hex was already identical. Near-identical shades (`#d6d9e2` and `#d7d9e3`, say) have separate tokens or stay literal; nothing was merged. Numbered names (`--text-2`, `--accent-wash-3`) are separate roles within a family that look alike; their purpose column says where each appears.
- `--line`, `--muted` and `--accent` kept their old names and values; they moved here from `chat.css`.
- `header.css` keeps its own `--hd-work`, `--hd-turn`, `--hd-need`, `--hd-idle` and `--hd-fail`; they now point at `--info`, `--ok`, `--warn`, `--text-muted-2` and `--danger`.
- Colours left literal on purpose (about 200 shades used once or twice, `rgba()` forms, the `#000` mask, the custom properties `--need`, `--ws-bg` and `--sel` in `workspace.css`, and the monitor pages `style.css` and `sidebar.css`, which are a separate page that does not load `theme.css`) are not tokens yet. A new colour in a stylesheet should use an existing token when its role matches, or add one to `theme.css`.
- `copy-ui.js` keeps literal light colours (`#f3f4f6`, `#d9dce1`, `#c5c9d0`, `#555555`). They style HTML put on the clipboard for other applications, not the page, so they must not follow the page theme.

| Token | Value | Used for |
| --- | --- | --- |
| `--text` | `#e5e7ec` | Default text on the page |
| `--text-bright` | `#fff` | Brightest text: on solid buttons and viewer controls |
| `--text-2` | `#d6d9e2` | Chip, tab and vendor-label text |
| `--text-3` | `#c9cbd6` | Secondary labels: sidebar summaries, inbox button |
| `--text-4` | `#d8dbe4` | Pane headings on hover, file-group scope |
| `--text-5` | `#c8cbd6` | Link-like body text in the activity and changes panes |
| `--text-6` | `#e6e7ee` | Artifact list titles and picker text |
| `--text-7` | `#c9ccd8` | Artifact version and next-step recap text |
| `--text-dim` | `#a3a8b6` | Activity strip and sub-agent card text |
| `--muted` | `#929aaa` | Muted text (original token) |
| `--text-muted` | `#8a91a3` | Qualifiers, timestamps, toggles |
| `--text-muted-2` | `#9195a6` | Idle status text and dot (also --hd-idle) |
| `--text-faint` | `#747d90` | Placeholders, composer notes, context state |
| `--text-faint-2` | `#737e94` | Message times, turn dividers |
| `--text-faint-3` | `#6d7184` | Artifact shortcuts and counts |
| `--bg` | `#101114` | Page background; deepest wells (provider tabs, attachment image wells) |
| `--panel` | `#17181e` | Sidebar, switcher and dialog panels |
| `--panel-2` | `#20212a` | Raised blocks: rename dialog, attachment cards, file badges |
| `--bg-inset` | `#14151a` | Small inset fields: project filter, rename input, kbd chips |
| `--code-bg` | `#14151b` | Code blocks, diffs, resource links |
| `--code-bg-inline` | `#1b1c24` | Inline code, table heads, diff summaries |
| `--bg-field` | `#1c1e27` | Inputs, slash popup, open tool rows |
| `--bg-popover` | `#1d1e28` | Toasts and popovers |
| `--bg-composer` | `#1a1b24` | Prompt form and small popups |
| `--bg-control` | `#20222b` | Copy controls and menus |
| `--bg-row` | `#16171d` | Turn lines, message notes, queue rows on hover |
| `--bg-card-hover` | `#1d1e26` | Activity cards and strip on hover |
| `--hover` | `#23252f` | Hover fill for sidebar rows, tabs, buttons |
| `--hover-2` | `#25222e` | Hover fill for sub-agent cards and activity buttons |
| `--hover-overlay` | `#ffffff14` | Translucent white hover wash on header icon buttons |
| `--line` | `#2d2e39` | Default hairline border (original token) |
| `--line-strong` | `#414051` | Panel, form and card borders |
| `--line-control` | `#3a3c49` | Button and badge borders |
| `--line-card` | `#3d4050` | Thumbnail and queue-row borders |
| `--line-field` | `#343746` | Input and popup borders |
| `--accent` | `#bba1ff` | Accent (original token): primary buttons, focus, links |
| `--accent-wash` | `#2a2438` | Purple-tinted hover and active fill |
| `--accent-wash-2` | `#383043` | Stronger purple hover fill |
| `--accent-wash-3` | `#2b2752` | Artifacts pane purple fill |
| `--accent-wash-4` | `#2b2740` | Sub-agent command chips and pane badges |
| `--accent-wash-5` | `#2d243d` | Selected sub-agent and command card fill |
| `--accent-line` | `#705a9b` | Selected and needs-you purple borders |
| `--danger` | `#f08a8a` | Failure dot and new-line marker (also --hd-fail) |
| `--danger-text` | `#f19999` | Ownership and error-note text |
| `--danger-bright` | `#ffbac6` | Error text and failed tool status |
| `--danger-fill` | `#d96b82` | Destructive primary button fill and border |
| `--ok` | `#7ad19c` | Turn-running dot and additions (also --hd-turn) |
| `--ok-text` | `#8fd7b2` | Idle status text and notify-on button |
| `--ok-bright` | `#8be28b` | Copied tick, added tokens, ok marks |
| `--ok-text-2` | `#8be3ad` | Completed tool status and added diff lines |
| `--warn` | `#f0b23e` | Needs-you dot and stars (also --hd-need) |
| `--warn-text` | `#e6c27a` | Hold note, needs-you hover and flash |
| `--warn-text-2` | `#f0c674` | Recovered and possibly-active badges |
| `--warn-bg` | `#302a1c` | Approval, needs-you line and toast fill |
| `--warn-line` | `#ad8d47` | Approval and needs-you borders |
| `--info` | `#5aa9ff` | Working dot (also --hd-work) |
| `--plan-dot` | `#d7d9e3` | Plan step dots |
| `--shadow-strong` | `#000a` | Toast, switcher and popover drop shadow |
| `--shadow-med` | `#0009` | Menu shadow and switcher backdrop |
| `--shadow-soft` | `#0008` | Chip popover shadow |

## Page behaviour worth knowing

- **Change signature.** `showRows` repaints a list only when its signature changed. The signature (`StreamUI.rowsSignature`) sums up every row by its small fields plus `rev`, a counter `liveRows` bumps each time an event is folded into a row. A change to any row, not just the last, repaints. It never stringifies whole rows.
- **Hidden tab.** While the tab is hidden the 1.5 s chat poll (`refresh`) does nothing; the 5 s conversation-list poll keeps running because `notify-ui.js` raises desktop notifications from it. Showing the tab refreshes the chat at once (`visibilitychange`). Split-pane mirrors (`tickMirrors`) were left alone and still poll while hidden.
- **Screen readers.** `#messages` is not a live region. Finished agent messages are announced once through `#liveAnnounce`, a visually hidden polite live region that is a direct child of `<body>` (outside `<main>`, so split panes share it). Opening or switching to a chat only sets a baseline; a message that is still streaming is announced when something follows it. A split side pane announces its own new messages with the chat's title in front.

## Tests

- `npm test` runs `node --test work/test_*.js` (from the repo root). Every test locates the page files through `__dirname`, so the working directory does not matter.
- `chat.js` is one IIFE. Tests load it into a fake page (`work/chat_harness.js`: `loadChat`, `makePage`) and reach it only through `window.StudioChat`: the functions it lists, and `state`, getters and setters for the few variables a test sets up. Add to that list only what a test needs.
- Tests do not look for text in source files. They run the code, or read `chat.html`'s tags (`pageAssets()`), not its spelling.
- The Python suite (`python -m unittest discover -s ../../work -p "test_*.py"`, from `outputs/agent-studio`) covers the server and `work/test_page_structure.py` (page structure and accessibility).

## Lint

`npm run lint` (ESLint, `eslint.config.js` at the repo root; `npm install` once to get it). It applies ESLint's recommended rules to every script here, plus an error for any assignment to `innerHTML` or `outerHTML` (the page builds its DOM from nodes and `textContent`; reading is allowed). Globals are declared in the config: the browser names, `module` for the "also usable from Node" line, `require` for the two scripts that pull in a sibling module under Node, and `AgentChoice` for `chat.js`. No script uses another script's global without going through `window`, except that one.

### Relaxed rules (later cleanup)

These were relaxed so today's code passes with no behaviour change. Each is a cleanup for a later wave; turn the rule back on in `eslint.config.js` when it is done.

| Rule | State | Where it fires today |
|---|---|---|
| `no-unused-vars` | warning, ignoring unused function arguments and caught errors | 14 variables in `changes-ui.js`, `chat.js`, `composer-chips.js`, `new-project-ui.js`, `sidebar.js`, `workspace-ui.js` and others |
| `no-empty` | error, except an empty `catch` (allowed on purpose: storage may be blocked) | none left; 43 empty `catch {}` blocks are allowed |
| `no-useless-escape` | off | 10: `artifacts-ui.js`, `attachments-ui.js`, `commands-registry.js`, `plan-ui.js` |
| `no-useless-assignment` | off | 8: `commands-registry.js`, `settings-ui.js`, `split-ui.js`, `textsize-ui.js`, `tool-views.js`, `workspace-state.js` |
| `preserve-caught-error` | off | 3: `chat.js` `request()` rethrows a friendlier error without `cause` |
| `no-control-regex` | off | 3: `elicitation-ui.js`, `markdown.js`, `workspace-state.js` (they strip control characters on purpose) |

Not done, and not part of this change: Prettier (a one-time reformat, its own commit), optional `// @ts-check` with JSDoc on the pure modules.
