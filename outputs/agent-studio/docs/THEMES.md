# AIB colour themes

Every colour the chat page paints is a token in `outputs/agent-studio/theme.css`; the other stylesheets only say
`var(--token)`. A theme is a set of token values selected with `data-theme` on `<html>`. This file lists every token
and what it is for. It is generated from theme.css (the comments there are the source); keep both in step.

## How it fits together

- **Core tokens** (46): the values a theme must set. Neutrals (page, panels, lines, text), the accent, the status
  families, syntax colours, the terminal and the shadow ink.
- **Derived tokens** (267): formulas over the core tokens (`var()` or `color-mix(in srgb, ...)`), in the first
  block of theme.css, which applies to `:root` and to any element with `data-theme`. A theme that sets only the core
  tokens still paints everything. A theme may pin any derived token to an exact value in its own block.
- **Themes**: one block `[data-theme='<id>'] { color-scheme: dark|light; core tokens; pins }`. AIB teal (dark) is the
  default and also applies when `<html>` has no `data-theme` (`:root:not([data-theme])`).
- **Picking**: `themes.js` (the first, blocking script in chat.html) holds the list the Settings picker shows and sets
  `data-theme` before first paint. The choice is saved in localStorage key `aib-theme`, which `view-prefs.js` copies into
  the data folder (`studio-view.json`) like the text size; the server writes it back onto `<html data-theme-pref>`.
  "Match system" follows the OS light/dark setting between AIB teal (dark) and AIB teal (light).
- **Terminal**: `terminal-ui.js` reads the `--term-*` tokens and re-reads them when `data-theme` changes.
- **Checks**: `work/test_themes.js` (every theme sets every core token, every token resolves, no colour outside theme.css,
  WCAG contrast of every pair in `work/theme_pairs.js` in every theme), `work/test_theme_classic.js` (Classic purple =
  the colours before the teal styling), `work/test_card_layout.js` (no theme moves a card or tab).

## Adding a theme

1. Add a block to theme.css: `[data-theme='my-theme'] { color-scheme: dark; ... }` with every core token below (copy
   the AIB teal (dark) block and change the values). Pin derived tokens only where a formula does not suit the theme.
2. Add one entry to `THEMES` in `themes.js`: `{ id: 'my-theme', label: 'My theme', group: '...', scheme: 'dark' }`
   (add `contrast: 'high'` for a high-contrast theme: the test then asks 7:1 for text and 4.5:1 for UI).
3. Run `node --test work/test_themes.js`: it lists every pair below its target, with both colours.

## Core tokens

| Token | Used for | AIB teal (dark) | AIB teal (light) | Classic purple (dark) |
|---|---|---|---|---|
| `--bg` | Page background: the chat column and the deepest wells | `#121318` | `#f7f4ee` | `#101114` |
| `--panel` | Sidebar, switcher and dialog panels | `#1b1c23` | `#ffffff` | `#17181e` |
| `--panel-2` | Raised blocks: your prompts, approval and question cards, dialogs, attachment cards | `#23242c` | `#ffffff` | `#20212a` |
| `--bg-field` | Inputs, slash popup, open tool rows | `#1f2028` | `#ffffff` | `#1c1e27` |
| `--hover` | Hover fill for sidebar rows, tabs, buttons | `#272830` | `#ece8df` | `#23252f` |
| `--line` | Default hairline border | `#2c2d36` | `#e2ded4` | `#2d2e39` |
| `--line-strong` | Panel, form and card borders | `#40414b` | `#c9c2b3` | `#414051` |
| `--text` | Default text on the page | `#edeae2` | `#16151b` | `#e5e7ec` |
| `--text-bright` | Strongest text: hovered and selected controls, the ring round a focused primary button | `#ffffff` | `#000000` | `#ffffff` |
| `--muted` | Muted text: meta lines, agent names, secondary labels | `#a9a497` | `#5c5547` | `#929aaa` |
| `--text-faint` | Faintest readable text: placeholders, composer notes, context state | `#918d80` | `#6b6455` | `#7f899c` |
| `--code-bg` | Code blocks, diffs, resource links | `#16171d` | `#f1ede5` | `#14151b` |
| `--accent` | The one accent: primary button fill, focus rings, selection bars, accent borders | `#2bb3a3` | `#0f766e` | `#bba1ff` |
| `--on-accent` | Text on an --accent fill | `#0b1f1d` | `#ffffff` | `#17111f` |
| `--link` | Links and accent-coloured text | `#33bcab` | `#0f766e` | `#bba1ff` |
| `--accent-wash` | Active chat, selected rows, accent hover and active fill | `#17332f` | `#e3f2ef` | `#2a2438` |
| `--accent-line` | Selected-card and dialog accent borders (meaningful: 3:1) | `#2a7c72` | `#3d968b` | `#705a9b` |
| `--danger` | Failure dot and new-line marker | `#f08a8a` | `#a82424` | `#f08a8a` |
| `--danger-bright` | Error text and failed tool status | `#ffbac6` | `#a8201a` | `#ffbac6` |
| `--ok` | Additions, change counts, ok marks | `#7ad19c` | `#16643a` | `#7ad19c` |
| `--warn` | Stars, file warnings, held chats | `#f0b23e` | `#8a5a00` | `#f0b23e` |
| `--info` | Neutral information blue (agent badges, renamed files) | `#5aa9ff` | `#1f5fbf` | `#5aa9ff` |
| `--status-working` | Working: text, dot and spinner head | `#ffc247` | `#8f5a00` | `#bba1ff` |
| `--status-working-bg` | Working chip fill | `#3a2e14` | `#fff1d6` | `#2c2a4a` |
| `--status-needs` | Needs you: text, dot and badges | `#ff7a59` | `#b8381c` | `#e6c27a` |
| `--status-needs-bg` | Needs-you chip, turn-line and toast fill; text on a needs-you badge | `#3d1f18` | `#ffe4dc` | `#302a1c` |
| `--status-done` | Done / Your turn / unread: text and dot | `#2bb3a3` | `#08706a` | `#8fd7b2` |
| `--status-done-bg` | Done chip fill | `#12302c` | `#ddf1ec` | `#16392a` |
| `--status-idle` | Idle and unknown: grey text and dot ring | `#c9c5bb` | `#4a4740` | `#cfd3dd` |
| `--status-idle-bg` | Idle chip fill | `#26272f` | `#ece9e2` | `#2a2b36` |
| `--syn-keyword` | Code: keywords | `#c79bff` | `#7b3fc4` | `#c79bff` |
| `--syn-string` | Code: strings | `#9bd88f` | `#2f7a22` | `#9bd88f` |
| `--syn-number` | Code: numbers and literals | `#f0a96b` | `#a5520a` | `#f0a96b` |
| `--syn-comment` | Code: comments | `#8a8679` | `#6b6455` | `#7d8597` |
| `--syn-key` | Code: object keys and headings | `#7cc4ff` | `#0b5fa8` | `#7cc4ff` |
| `--term-bg` | Terminal panel and xterm background | `#0e0f13` | `#fbfaf7` | `#0c0d10` |
| `--term-fg` | xterm text and cursor | `#edeae2` | `#16151b` | `#e5e7ec` |
| `--term-sel` | xterm selection | `#1f4a44` | `#cfe8e3` | `#3d3456` |
| `--term-red` | xterm red | `#f19999` | `#b42318` | `#f19999` |
| `--term-green` | xterm green | `#7ad19c` | `#1d7a46` | `#7ad19c` |
| `--term-yellow` | xterm yellow | `#e6c27a` | `#8a5a00` | `#e6c27a` |
| `--term-blue` | xterm blue | `#7cb7ff` | `#1f5fbf` | `#7cb7ff` |
| `--term-magenta` | xterm magenta | `#c79bff` | `#8a3fb8` | `#bba1ff` |
| `--term-cyan` | xterm cyan | `#7fd3d8` | `#0b7380` | `#7fd3d8` |
| `--term-dim` | xterm bright black (prompts, dim text) | `#8a8679` | `#6b6455` | `#8a91a3` |
| `--shadow-ink` | Colour of drop shadows and backdrops (used with transparency) | `#000000` | `#2a2418` | `#000000` |

## Derived tokens

The formula is the default every theme gets; the columns show what it works out to (a pinned value where the theme pins it).

| Token | Formula | Used for | AIB teal (dark) | AIB teal (light) | Classic purple (dark) |
|---|---|---|---|---|---|
| `--text-2` | `color-mix(in srgb, var(--text) 87%, var(--text-faint))` | Chip, tab and vendor-label text | `#e1ded5` | `#211f23` | `#d6d9e2` |
| `--text-3` | `color-mix(in srgb, var(--text) 65%, var(--muted))` | Secondary labels: sidebar summaries, inbox button | `#d5d2c8` | `#2f2b2a` | `#c9cbd6` |
| `--text-4` | `color-mix(in srgb, var(--text) 85%, var(--muted))` | Pane headings on hover, file-group scope | `#e3e0d7` | `#211f22` | `#d8dbe4` |
| `--text-5` | `color-mix(in srgb, var(--text) 65%, var(--muted))` | Link-like body text in the activity and changes panes | `#d5d2c8` | `#2f2b2a` | `#c8cbd6` |
| `--text-6` | `var(--text)` | Artifact list titles and picker text | `#edeae2` | `#16151b` | `#e6e7ee` |
| `--text-7` | `color-mix(in srgb, var(--text) 67%, var(--muted))` | Artifact version and next-step recap text | `#d7d3c9` | `#2d2a2a` | `#c9ccd8` |
| `--text-dim` | `color-mix(in srgb, var(--text) 41%, var(--text-faint))` | Activity strip and sub-agent card text | `#b7b3a8` | `#48443d` | `#a3a8b6` |
| `--text-muted` | `color-mix(in srgb, var(--muted) 72%, var(--text-faint))` | Qualifiers, timestamps, toggles | `#a29e91` | `#60594b` | `#8a91a3` |
| `--text-muted-2` | `var(--muted)` | Plan step qualifiers (former idle status colour) | `#a9a497` | `#5c5547` | `#9195a6` |
| `--text-faint-2` | `var(--text-faint)` | Message times, turn dividers | `#918d80` | `#6b6455` | `#7e899f` |
| `--text-faint-3` | `var(--text-faint)` | Artifact shortcuts and counts | `#918d80` | `#6b6455` | `#84889b` |
| `--bg-inset` | `color-mix(in srgb, var(--bg) 68%, var(--bg-field))` | Small inset fields: project filter, rename input, kbd chips | `#16171d` | `#faf8f3` | `#14151a` |
| `--code-bg-inline` | `color-mix(in srgb, var(--panel-2) 59%, var(--code-bg))` | Inline code, table heads, diff summaries | `#1e1f26` | `#f9f8f4` | `#1b1c24` |
| `--bg-popover` | `var(--bg-field)` | Toasts and popovers | `#1f2028` | `#ffffff` | `#1d1e28` |
| `--bg-composer` | `color-mix(in srgb, var(--bg-field) 73%, var(--code-bg))` | Prompt form and small popups | `#1d1e25` | `#fbfaf8` | `#1a1b24` |
| `--bg-control` | `var(--bg-field)` | Copy controls and menus | `#1f2028` | `#ffffff` | `#20222b` |
| `--bg-row` | `color-mix(in srgb, var(--panel) 67%, var(--code-bg))` | Turn lines, message notes, queue rows on hover | `#191a21` | `#faf9f6` | `#16171d` |
| `--bg-card-hover` | `color-mix(in srgb, var(--panel) 33%, var(--panel-2))` | Activity cards and strip on hover | `#202129` | `#ffffff` | `#1d1e26` |
| `--hover-2` | `color-mix(in srgb, var(--line-strong) 35%, var(--code-bg))` | Hover fill for sub-agent cards and activity buttons | `#25262d` | `#e3ded4` | `#25222e` |
| `--hover-overlay` | `color-mix(in srgb, var(--text) 8%, transparent)` | Translucent white hover wash on header icon buttons | `#ffffff14` | `#16151b14` | `#ffffff14` |
| `--line-control` | `color-mix(in srgb, var(--line) 82%, var(--text-faint))` | Button and badge borders | `#3e3e43` | `#cdc8bd` | `#3a3c49` |
| `--line-card` | `color-mix(in srgb, var(--line) 8%, var(--line-strong))` | Thumbnail and queue-row borders | `#3e3f49` | `#cbc4b6` | `#3d4050` |
| `--line-field` | `color-mix(in srgb, var(--hover) 36%, var(--line-strong))` | Input and popup borders | `#373841` | `#d6d0c3` | `#343746` |
| `--on-accent-disabled` | `color-mix(in srgb, var(--accent) 55%, var(--text))` | Text on a disabled primary button (on --accent-wash-2) | `#8fd9cf` | `#124a49` | `#191624` |
| `--link-underline` | `color-mix(in srgb, var(--link) 50%, transparent)` | Link underline at rest | `#33bcab80` | `#0f766e80` | `#a99cff80` |
| `--accent-halo` | `color-mix(in srgb, var(--accent) 20%, transparent)` | Soft accent glow (drop target) | `#2bb3a333` | `#0f766e33` | `#7c6cf033` |
| `--accent-wash-2` | `color-mix(in srgb, var(--accent-wash) 93%, var(--text))` | Stronger teal hover fill | `#1f423d` | `#dcefea` | `#383043` |
| `--accent-wash-3` | `color-mix(in srgb, var(--accent-line) 35%, var(--code-bg))` | Artifacts pane teal fill | `#173a36` | `#d9eee9` | `#2b2752` |
| `--accent-wash-4` | `color-mix(in srgb, var(--accent-line) 31%, var(--bg))` | Sub-agent command chips, pane badges, agent letters | `#16302d` | `#dcefea` | `#2b2740` |
| `--accent-wash-5` | `color-mix(in srgb, var(--accent-line) 30%, var(--bg))` | Selected sub-agent and command card fill | `#1a3834` | `#d9eee9` | `#2d243d` |
| `--danger-text` | `color-mix(in srgb, var(--danger) 84%, var(--text))` | Ownership and error-note text | `#f09998` | `#912223` | `#f19999` |
| `--danger-fill` | `color-mix(in srgb, var(--danger) 87%, var(--code-bg))` | Destructive primary button fill and border | `#d96b82` | `#b13e3d` | `#d96b82` |
| `--ok-text` | `color-mix(in srgb, var(--ok) 77%, var(--text))` | Idle status text and notify-on button | `#94d7ac` | `#165233` | `#8fd7b2` |
| `--ok-bright` | `var(--ok)` | Copied tick, added tokens, ok marks | `#8be28b` | `#16643a` | `#8be28b` |
| `--ok-text-2` | `var(--ok)` | Completed tool status and added diff lines | `#8be3ad` | `#16643a` | `#8be3ad` |
| `--warn-text` | `color-mix(in srgb, var(--warn) 66%, var(--text))` | Hold note and held-chat text | `#efc576` | `#634309` | `#e6c27a` |
| `--warn-text-2` | `color-mix(in srgb, var(--warn) 69%, var(--text))` | Recovered and possibly-active badges | `#efc371` | `#664508` | `#f0c674` |
| `--warn-bg` | `color-mix(in srgb, var(--warn) 15%, var(--bg))` | Former approval and needs-you fill; kept for code on other branches | `#332b1e` | `#e7ddca` | `#302a1c` |
| `--warn-line` | `color-mix(in srgb, var(--warn) 63%, var(--line-strong))` | Held and edited queue rows, mismatched setting chips | `#af8843` | `#a18042` | `#ad8d47` |
| `--status-working-track` | `color-mix(in srgb, var(--status-working) 25%, transparent)` | Working spinner track (the spinner's head is --status-working) | `#ffc24740` | `#8f5a0040` | `#4b4560` |
| `--status-working-line` | `var(--status-working)` | Working borders: turn line, elsewhere chip | `#ffc247` | `#8f5a00` | `#463d6e` |
| `--status-needs-line` | `var(--status-needs)` | Needs-you borders and row outline | `#ff7a59` | `#b8381c` | `#ad8d47` |
| `--status-needs-halo` | `color-mix(in srgb, var(--status-needs) 30%, transparent)` | Halo around the needs-you dot | `#ff7a594d` | `#b8381c4d` | `#f2b24a4d` |
| `--status-done-line` | `var(--status-done)` | Your-turn turn-line border, unread row outline | `#2bb3a3` | `#08706a` | `#46678e` |
| `--plan-dot` | `var(--text)` | Plan step dots | `#edeae2` | `#16151b` | `#d7d9e3` |
| `--shadow-strong` | `color-mix(in srgb, var(--shadow-ink) 67%, transparent)` | Toast, switcher and popover drop shadow | `#000000ab` | `#2a2418ab` | `#000000aa` |
| `--shadow-med` | `color-mix(in srgb, var(--shadow-ink) 60%, transparent)` | Menu shadow and switcher backdrop | `#00000099` | `#2a241899` | `#00000099` |
| `--shadow-soft` | `color-mix(in srgb, var(--shadow-ink) 53%, transparent)` | Chip popover shadow | `#00000087` | `#2a241887` | `#00000088` |
| `--accent-ink` | `var(--on-accent)` | Text on a solid accent button (Start new session, Try again) | `#0b1f1d` | `#ffffff` | `#17111f` |
| `--bad-fill` | `color-mix(in srgb, var(--danger) 15%, var(--bg))` | "Didn't start" shell chip fill | `#3a1820` | `#ebd5d0` | `#3a1820` |
| `--bad-line` | `color-mix(in srgb, var(--danger) 44%, var(--bg))` | "Didn't start" shell chip border | `#7a3a48` | `#d49895` | `#7a3a48` |
| `--hd-work` | `var(--status-working)` |  | `#ffc247` | `#8f5a00` | `#5aa9ff` |
| `--hd-turn` | `var(--status-done)` |  | `#2bb3a3` | `#08706a` | `#7ad19c` |
| `--hd-need` | `var(--status-needs)` |  | `#ff7a59` | `#b8381c` | `#f0b23e` |
| `--hd-idle` | `var(--status-idle)` |  | `#c9c5bb` | `#4a4740` | `#9195a6` |
| `--hd-fail` | `var(--danger)` |  | `#f08a8a` | `#a82424` | `#f08a8a` |
| `--need` | `var(--status-needs)` |  | `#ff7a59` | `#b8381c` | `#f2b24a` |
| `--ws-bg` | `var(--bg)` |  | `#121318` | `#f7f4ee` | `#121317` |
| `--sel` | `var(--accent-wash)` |  | `#17332f` | `#e3f2ef` | `#2b2340` |
| `--button-bg` | `var(--bg-field)` | button {background}; .ws-qa {background}; .st-close:hover {background} | `#1f2028` | `#ffffff` | `#24262f` |
| `--label-text` | `color-mix(in srgb, var(--text) 48%, var(--muted))` | label {color} | `#cac6bb` | `#3a3632` | `#b8bece` |
| `--error-bg` | `color-mix(in srgb, var(--danger) 18%, var(--code-bg))` | #error {background} | `#40242e` | `#e4c9c2` | `#40242e` |
| `--bubble-bg` | `color-mix(in srgb, var(--bg) 32%, var(--bg-field))` | .bubble {background}; .pane:not(.foc) .ws-tab.on {background} | `#1b1c23` | `#fcfbfa` | `#181a21` |
| `--bubble-head-line` | `color-mix(in srgb, var(--panel-2) 89%, var(--text-faint))` | .bubble-head {border-bottom}; .msg-note-body {border-top} | `#2f3035` | `#efeeec` | `#292b35` |
| `--bubble-head-text` | `color-mix(in srgb, var(--text) 33%, var(--muted))` | .bubble-head {color}; .tool-toggle {color}; .msg-note-toggle {color} | `#bfbbb0` | `#454038` | `#aab3c5` |
| `--card-line` | `color-mix(in srgb, var(--bg) 43%, var(--line-strong))` | .connection {border} | `#2c2d35` | `#ddd8cc` | `#2c2c37` |
| `--card-bg` | `color-mix(in srgb, var(--line-strong) 15%, var(--code-bg))` | .connection {background}; .command-card {background}; .switcher-open kbd,.switcher-foot kbd {background} | `#1c1d24` | `#ebe7de` | `#1b1b23` |
| `--owned-status-text` | `color-mix(in srgb, var(--ok) 86%, var(--text))` | .connection .owned-status {color}; .badge-live {color} | `#8ad5a6` | `#165936` | `#87d3aa` |
| `--menu-bg` | `color-mix(in srgb, var(--line-strong) 43%, var(--code-bg))` | #connectionMenu[open] button {background}; #connectionMenu[open] .menu-panel {background}; .organize-menu {background} | `#282931` | `#e0dbd0` | `#292632` |
| `--rename-chat-text` | `color-mix(in srgb, var(--text) 17%, var(--muted))` | .rename-chat {color} | `#b5b0a4` | `#504a40` | `#a5a1b6` |
| `--subagents-pane-bg` | `color-mix(in srgb, var(--panel) 33%, var(--code-bg))` | #subagentsPane,#subchatPane {background}; #subagentsPane {background}; .cg-file {background} | `#18191f` | `#f6f3ee` | `#15161c` |
| `--subagent-card-meta-text` | `color-mix(in srgb, var(--accent-line) 64%, var(--text))` | .subagent-card small {color} | `#9a92ae` | `#2f6863` | `#9a92ae` |
| `--subagent-card-desc-text` | `color-mix(in srgb, var(--muted) 36%, var(--text-faint))` | .subagent-card p {color} | `#9a9588` | `#665f50` | `#7f879a` |
| `--backdrop` | `color-mix(in srgb, var(--bg) 70%, transparent)` | #renameDialog::backdrop {background} | `#121318b3` | `#f7f4eeb3` | `#07080bb3` |
| `--command-card-line` | `var(--line)` | .command-card {border} | `#2c2d36` | `#e2ded4` | `#30313c` |
| `--command-error-text` | `var(--danger)` | .command-error {color} | `#ff9ba9` | `#a82424` | `#ff9ba9` |
| `--command-details-text` | `color-mix(in srgb, var(--text) 64%, var(--muted))` | #commandDetails {color}; .attachment-card span {color}; .image-viewer-caption {color} | `#d5d1c7` | `#2f2c2b` | `#c4cada` |
| `--attachment-remove-bg` | `color-mix(in srgb, var(--bg) 38%, var(--line-strong))` | .attachment-card .attachment-remove {background} | `#3b2934` | `#dad5c9` | `#3b2934` |
| `--attachment-remove-text` | `color-mix(in srgb, var(--danger-bright) 86%, var(--text))` | .attachment-card .attachment-remove {color} | `#fcc1ca` | `#941e1a` | `#ffc1cd` |
| `--message-image-bg` | `color-mix(in srgb, var(--bg) 46%, var(--code-bg))` | .bubble .message-image {background}; .tool-thumbs .tool-thumb {background} | `#14151b` | `#f4f0e9` | `#121318` |
| `--tool-failed-bg` | `color-mix(in srgb, var(--danger) 21%, var(--bg))` | .tool-status.status-failed {background} | `#4a1d27` | `#e6c8c4` | `#4a1d27` |
| `--diff-removed-text` | `var(--danger)` | .diff-removed {color}; .diff-del .diff-sign {color} | `#ff9aa9` | `#a82424` | `#ff9aa9` |
| `--diff-add-bg` | `color-mix(in srgb, var(--ok) 18%, transparent)` | .diff-add {background} | `#34a8642e` | `#16643a2e` | `#34a8642e` |
| `--diff-del-bg` | `color-mix(in srgb, var(--danger) 18%, transparent)` | .diff-del {background} | `#dc465a2e` | `#a824242e` | `#dc465a2e` |
| `--strip-notice-severity-warning-text` | `color-mix(in srgb, var(--warn) 46%, var(--text))` | .strip-notice.severity-warning {color} | `#ffd79a` | `#4b350f` | `#ffd79a` |
| `--danger-line` | `color-mix(in srgb, var(--danger) 51%, var(--bg))` | .danger {border-color}; .cg-discard {border-color} | `#8f3b4d` | `#cf8a87` | `#8f3b4d` |
| `--primary-danger-text` | `color-mix(in srgb, var(--bg) 73%, var(--code-bg))` | .primary.danger {color} | `#1d0d12` | `#f5f2ec` | `#1d0d12` |
| `--badge-live-bg` | `color-mix(in srgb, var(--ok) 16%, var(--bg))` | .badge-live {background} | `#16342a` | `#d3ddd1` | `#16342a` |
| `--badge-live-line` | `color-mix(in srgb, var(--ok) 43%, var(--bg))` | .badge-live {border-color} | `#2c6b52` | `#96b6a1` | `#2c6b52` |
| `--badge-saved-bg` | `color-mix(in srgb, var(--bg) 29%, var(--line))` | .badge-saved {background} | `#24252d` | `#e8e4dc` | `#25262e` |
| `--badge-saved-text` | `color-mix(in srgb, var(--text) 30%, var(--muted))` | .badge-saved {color} | `#bdb9ae` | `#47423a` | `#aab0bf` |
| `--badge-recovered-bg` | `color-mix(in srgb, var(--warn) 15%, var(--bg))` | .badge-recovered {background}; .badge-ownership-possibly_active {background} | `#332b1e` | `#e7ddca` | `#33291a` |
| `--badge-recovered-line` | `color-mix(in srgb, var(--warn) 45%, var(--bg-field))` | .badge-recovered {border-color}; .badge-ownership-possibly_active {border-color}; .ownership-prompt {border} | `#7d6232` | `#cab58c` | `#7a6431` |
| `--badge-agent-bg` | `color-mix(in srgb, var(--info) 9%, var(--bg-field))` | .badge-agent {background} | `#242c3b` | `#ebf1f9` | `#222b3a` |
| `--badge-agent-text` | `color-mix(in srgb, var(--info) 63%, var(--text))` | .badge-agent {color}; aside .connection .row-status.tone-info .row-phrase {color} | `#90c1f4` | `#1c4482` | `#8fb8ef` |
| `--badge-agent-line` | `color-mix(in srgb, var(--info) 40%, var(--panel-2))` | .badge-agent {border-color} | `#395980` | `#a5bfe5` | `#3d5680` |
| `--stop-subagent-line` | `color-mix(in srgb, var(--danger) 52%, var(--code-bg))` | #stopSubagent {border-color} | `#8a4a56` | `#cb8481` | `#8a4a56` |
| `--file-badge-ext-text` | `color-mix(in srgb, var(--accent) 20%, var(--text))` | .file-badge-ext {color} | `#c6dfd5` | `#15282c` | `#d8dcf0` |
| `--file-badge-size-text` | `var(--muted)` | .file-badge-size {color}; .attachment-card > span {color}; .file-card-meta {color} | `#a9a497` | `#5c5547` | `#8f98ad` |
| `--icon-btn-line` | `color-mix(in srgb, var(--line-strong) 59%, var(--text-faint))` | .attachment-card .attachment-remove {border}; .image-viewer button {border} | `#616061` | `#a29b8c` | `#555a6b` |
| `--icon-btn-bg` | `color-mix(in srgb, var(--bg-field) 18%, var(--line))` | .attachment-card .attachment-remove {background}; .image-viewer button {background} | `#2a2b33` | `#e7e4dc` | `#2a2b36` |
| `--image-viewer-bg` | `color-mix(in srgb, var(--bg) 90%, transparent)` | .image-viewer {background} | `#121318e6` | `#f7f4eee6` | `#06070ae6` |
| `--ownership-hint-text` | `color-mix(in srgb, var(--text) 10%, var(--muted))` | .ownership-hint {color} | `#b0ab9f` | `#554f43` | `#9aa1b2` |
| `--badge-ownership-ownedelsewhere-bg` | `color-mix(in srgb, var(--danger) 16%, var(--bg))` | .badge-ownership-owned_elsewhere {background} | `#3a1f22` | `#ead3ce` | `#3a1f22` |
| `--badge-ownership-ownedelsewhere-line` | `color-mix(in srgb, var(--danger) 43%, var(--bg))` | .badge-ownership-owned_elsewhere {border-color}; .ownership-prompt-blocked {border-color} | `#7a3a41` | `#d59b97` | `#7a3a41` |
| `--ownership-prompt-bg` | `color-mix(in srgb, var(--warn) 12%, var(--bg))` | .ownership-prompt {background} | `#2d261d` | `#eae2d1` | `#2a2417` |
| `--ownership-prompt-blocked-bg` | `color-mix(in srgb, var(--danger) 10%, var(--bg))` | .ownership-prompt-blocked {background} | `#281f23` | `#efdfda` | `#2a1a1c` |
| `--ownership-note-text` | `color-mix(in srgb, var(--text) 49%, var(--muted))` | .ownership-note,.ownership-advice {color} | `#cac6bc` | `#3a3631` | `#b9bfcc` |
| `--organize-menu-shadow` | `color-mix(in srgb, var(--bg) 40%, transparent)` | .organize-menu {box-shadow}; .ws-scrim:not([hidden]) {background}; .ar-pop {box-shadow} | `#12131866` | `#f7f4ee66` | `#00000066` |
| `--menu-danger-text` | `color-mix(in srgb, var(--danger) 70%, var(--text))` | .organize-menu button.danger {color} | `#ff9fb0` | `#7c2021` | `#ff9fb0` |
| `--copy-btn-text` | `color-mix(in srgb, var(--text) 64%, var(--muted))` | .copy-ctl button {color}; .run-term {color} | `#d5d1c7` | `#2f2c2b` | `#c3cadb` |
| `--copy-btn-hover-bg` | `color-mix(in srgb, var(--hover) 87%, var(--text-faint))` | .copy-ctl button:hover,.copy-ctl button:focus-visible {background} | `#35353a` | `#dbd7cd` | `#2d303c` |
| `--copy-menu-line` | `color-mix(in srgb, var(--line) 24%, var(--line-strong))` | .copy-menu {border}; .copy-manual {border} | `#3b3c46` | `#cfc9bb` | `#3a3d4c` |
| `--copy-menu-item-bg` | `color-mix(in srgb, var(--bg-field) 27%, var(--line-strong))` | .copy-menu-item:hover,.copy-menu-item:focus-visible {background} | `#373842` | `#d8d2c8` | `#33364a` |
| `--copy-manual-note-text` | `color-mix(in srgb, var(--warn) 64%, var(--text))` | .copy-manual-note {color} | `#ffd479` | `#60410a` | `#ffd479` |
| `--tool-error-text` | `var(--danger)` | .tool-result-error > summary {color} | `#f08a8a` | `#a82424` | `#ff8f8f` |
| `--syn-add-bg` | `color-mix(in srgb, var(--ok) 12%, var(--bg))` | .tok-add {background} | `#1a2e1f` | `#dce3d8` | `#1a2e1f` |
| `--syn-del-text` | `var(--danger)` | .tok-del {color}; .tool-line.failed .tool-line-text {color} | `#ff9b9b` | `#a82424` | `#ff9b9b` |
| `--syn-del-bg` | `color-mix(in srgb, var(--danger) 13%, var(--bg))` | .tok-del {background} | `#33191d` | `#edd9d4` | `#33191d` |
| `--mark-failed-text` | `var(--danger)` | .mark-failed {color} | `#ff6b6b` | `#a82424` | `#ff6b6b` |
| `--turn-lost-text` | `color-mix(in srgb, var(--danger) 77%, var(--text))` | .turn-line[data-kind='lost'] {color}; .q-note {color} | `#efa09e` | `#862122` | `#e6a0a0` |
| `--turn-lost-line` | `color-mix(in srgb, var(--danger) 38%, var(--bg))` | .turn-line[data-kind='lost'] {border-color} | `#664043` | `#d9a5a1` | `#6b3a3a` |
| `--kbd-text` | `color-mix(in srgb, var(--text) 75%, var(--muted))` | .switcher-open kbd,.switcher-foot kbd {color} | `#dcd9cf` | `#282526` | `#cfd3dd` |
| `--project-head-bg` | `color-mix(in srgb, var(--panel-2) 71%, var(--bg-field))` | .project-head:hover {background} | `#22232b` | `#ffffff` | `#1f2029` |
| `--st-opening-line` | `color-mix(in srgb, var(--line-strong) 11%, var(--muted))` | .st-opening {border} | `#9d998f` | `#686153` | `#8a8fa0` |
| `--chip-v-text` | `color-mix(in srgb, var(--warn) 69%, var(--text))` | .chip-pending .chip-v {color}; .chip-warn {color}; .config-queued {color} | `#efc371` | `#664508` | `#e8c872` |
| `--studio-notice-line` | `color-mix(in srgb, var(--warn) 34%, var(--bg))` | .studio-notice {border} | `#5d4925` | `#d2c09d` | `#5a4a20` |
| `--studio-notice-bg` | `color-mix(in srgb, var(--warn) 11%, var(--bg))` | .studio-notice {background} | `#2a241c` | `#ebe3d4` | `#2a2312` |
| `--studio-notice-text` | `color-mix(in srgb, var(--warn) 42%, var(--text))` | .studio-notice {color} | `#f0d9a0` | `#473210` | `#f0d9a0` |
| `--update-btn-line` | `color-mix(in srgb, var(--warn) 54%, var(--bg-field))` | .update-banner .update-btn {border} | `#906f34` | `#c0a675` | `#8a7433` |
| `--update-btn-text` | `color-mix(in srgb, var(--warn) 28%, var(--text))` | .update-banner .update-btn {color} | `#f7e6b8` | `#362813` | `#f7e6b8` |
| `--update-btn-bg` | `color-mix(in srgb, var(--warn) 19%, var(--bg))` | .update-banner .update-btn:hover {background} | `#3c311f` | `#e2d7c1` | `#3a3018` |
| `--activity-dot-bg` | `color-mix(in srgb, var(--line) 58%, var(--text-faint))` | .sa-dot {background}; .ac-dot {background} | `#565555` | `#b0ab9f` | `#4b4f5d` |
| `--activity-dot-failed-bg` | `color-mix(in srgb, var(--danger) 84%, var(--bg))` | .sa-failed .sa-dot,.proc-failed .sa-dot {background} | `#d9666e` | `#b54544` | `#d9666e` |
| `--activity-failed-text` | `color-mix(in srgb, var(--danger-bright) 94%, var(--bg))` | .sa-failed .sa-title {color}; .proc-failed .proc-title {color} | `#f1b0bc` | `#ad2d27` | `#f3b3b8` |
| `--proc-title-text` | `color-mix(in srgb, var(--text) 42%, var(--muted))` | .proc-title {color} | `#c6c1b7` | `#3f3a35` | `#b4b9c8` |
| `--activity-chip-sep-text` | `color-mix(in srgb, var(--line-strong) 50%, var(--text-faint))` | .ac-chip + .ac-chip::before {color} | `#696766` | `#9a9384` | `#5a5f70` |
| `--ws-tab-bg` | `color-mix(in srgb, var(--panel) 82%, var(--line))` | .ws-tab {background}; .find-chat {background} | `#1e1f26` | `#faf9f7` | `#1b1c23` |
| `--header-status-line` | `color-mix(in srgb, var(--ok) 30%, var(--bg))` | .header-actions #status,header #status {border} | `#314c40` | `#b3c9b8` | `#2f4a3c` |
| `--select-option-bg` | `color-mix(in srgb, var(--panel) 67%, var(--panel-2))` | .chip-agent-select option {background}; .st-agent {background} | `#1e1f26` | `#ffffff` | `#1a1b22` |
| `--ws-newproj-line` | `color-mix(in srgb, var(--line) 61%, var(--text-faint))` | .ws-newproj {border} | `#535253` | `#b4aea2` | `#4a4c5b` |
| `--ws-menu-item-text` | `color-mix(in srgb, var(--line-strong) 47%, var(--muted))` | .ws-menu-item:disabled {color}; .status-dot.d-off {border} | `#787573` | `#8f887a` | `#6b7080` |
| `--kbd-text-2` | `color-mix(in srgb, var(--text) 75%, var(--muted))` | .find-chat kbd {color}; .side-settings kbd {color}; .st-kbd kbd {color} | `#dcd9cf` | `#282526` | `#cfd3df` |
| `--row-chip-bg` | `color-mix(in srgb, var(--hover) 75%, var(--line-strong))` | aside .connection .row-chip {background} | `#2d2e37` | `#e3dfd4` | `#2a2c38` |
| `--row-ok-text` | `color-mix(in srgb, var(--ok) 92%, var(--text))` | aside .connection .row-status.tone-ok .row-phrase {color}; .np-hint.ok {color} | `#83d3a2` | `#165e38` | `#79d6ae` |
| `--row-project-text` | `color-mix(in srgb, var(--text) 35%, var(--muted))` | aside .connection .row-line3 .row-project {color} | `#c1bdb1` | `#443f38` | `#aeb4c4` |
| `--np-dialog-shadow` | `color-mix(in srgb, var(--bg) 80%, transparent)` | .np-dialog {box-shadow} | `#121318cc` | `#f7f4eecc` | `#000000cc` |
| `--field-invalid-line` | `color-mix(in srgb, var(--danger) 74%, var(--bg))` | .np-form input[aria-invalid='true'] {border-color} | `#c25f5f` | `#bd5a59` | `#c25f5f` |
| `--note-warn-text` | `color-mix(in srgb, var(--warn) 70%, var(--muted))` | .ws-notify-body .note.warn {color} | `#dbae59` | `#7c5915` | `#e0b36a` |
| `--count-turn-text` | `var(--bg)` | .status-count.count-turn {color} | `#0e1f17` | `#f7f4ee` | `#0e1f17` |
| `--unknown-send-line-text` | `color-mix(in srgb, var(--warn) 73%, var(--muted))` | .unknown-send-line {color}; .unknown-send-btn {color}; .unknown-send-btn:hover {border-color} | `#ddae56` | `#7e5913` | `#d9b45f` |
| `--unknown-send-btn-line` | `color-mix(in srgb, var(--warn) 38%, var(--bg-field))` | .unknown-send-btn {border-color} | `#6e5730` | `#d3c09e` | `#6b5a2e` |
| `--title-hover-bg` | `color-mix(in srgb, var(--text) 5%, transparent)` | header .hd-line h1:hover {background} | `#ffffff0d` | `#16151b0d` | `#ffffff0d` |
| `--ownership-bar-bg` | `var(--bg)` | .ownership-bar {background} | `#121318` | `#f7f4ee` | `#1b1a17` |
| `--cancel-line` | `color-mix(in srgb, var(--danger) 48%, var(--bg))` | #cancel {border-color} | `#7d4c4f` | `#d1908d` | `#7a4c4c` |
| `--cancel-text` | `color-mix(in srgb, var(--danger) 52%, var(--text))` | #cancel {color} | `#efb8b4` | `#621d20` | `#f2b8b8` |
| `--composer-attach-line` | `color-mix(in srgb, var(--line) 75%, var(--text-faint))` | #promptForm .composer-actions .composer-attach {border} | `#454549` | `#c4c0b4` | `#3f4150` |
| `--composer-attach-bg` | `color-mix(in srgb, var(--bg-field) 69%, var(--line-strong))` | #promptForm .composer-actions .composer-attach:hover,#promptForm .composer-actions .composer-attach:focus-visible {background} | `#292a33` | `#eeece7` | `#262836` |
| `--ws-qa-choice-ok-bg` | `color-mix(in srgb, var(--ok) 43%, var(--bg))` | .ws-qa-choice.ok {background} | `#2f6f4c` | `#96b6a1` | `#2f6f4c` |
| `--ws-qa-choice-no-text` | `color-mix(in srgb, var(--danger) 77%, var(--text))` | .ws-qa-choice.no {color}; .switcher-sub.warn {color} | `#efa09e` | `#862122` | `#f0a0a0` |
| `--ws-reply-box-bg` | `color-mix(in srgb, var(--bg-field) 34%, var(--code-bg))` | .ws-reply-box {background}; .art-card {background}; .plan-dock {background} | `#191a21` | `#f6f3ee` | `#17181f` |
| `--kbd-text-3` | `color-mix(in srgb, var(--text) 66%, var(--muted))` | .switcher-key kbd,.sheet-rows kbd {color}; .q-row {color} | `#d6d2c9` | `#2e2b2a` | `#c9ccd6` |
| `--danger-active-bg` | `color-mix(in srgb, var(--danger) 17%, var(--bg))` | .switcher-item.danger.active {background} | `#38272b` | `#ead1cc` | `#3a2226` |
| `--queue-paused-text` | `color-mix(in srgb, var(--warn) 55%, var(--text))` | .q-head.q-paused {color} | `#efcb88` | `#563b0c` | `#f0d28a` |
| `--q-row-line` | `color-mix(in srgb, var(--line-strong) 48%, var(--text-faint))` | .q-row:hover,.q-row:focus-within {border-color} | `#6a6967` | `#989182` | `#5a5e75` |
| `--q-btn-bg` | `color-mix(in srgb, var(--hover) 91%, var(--text-faint))` | .q-btn:hover,.q-btn:focus-visible {background}; .q-text-btn:hover,.q-text-btn:focus-visible {background} | `#313137` | `#e0dcd3` | `#2b2d38` |
| `--side-settings-bg` | `color-mix(in srgb, var(--hover) 75%, var(--code-bg))` | .side-settings:hover,.side-settings:focus-visible {background}; .st-section:hover {background} | `#23242b` | `#ede9e1` | `#1f212a` |
| `--st-note-bad-text` | `color-mix(in srgb, var(--danger) 74%, var(--text))` | .st-note.bad,.st-error,.st-hint.warn {color}; .st-status.bad {color}; .st-danger {color} | `#efa3a1` | `#822022` | `#f0a3a3` |
| `--st-hint-warn-text` | `color-mix(in srgb, var(--warn) 66%, var(--text))` | .st-hint.warn {color}; .st-notify .note.warn {color} | `#efc576` | `#634309` | `#e6c07a` |
| `--st-agent-line` | `color-mix(in srgb, var(--hover) 89%, var(--line-strong))` | .st-agent {border}; #startPage .sp-stuck {border} | `#2a2b33` | `#e8e4da` | `#262833` |
| `--st-status-bad-line` | `color-mix(in srgb, var(--danger) 36%, var(--bg))` | .st-status.bad {border-color} | `#6b3434` | `#dba9a5` | `#6b3434` |
| `--st-command-text` | `color-mix(in srgb, var(--text) 47%, var(--muted))` | .st-command {color} | `#c9c5ba` | `#3b3732` | `#b9bdca` |
| `--st-line` | `color-mix(in srgb, var(--bg-field) 94%, var(--muted))` | .st-line {border-top}; .st-keys li {border-bottom} | `#27282f` | `#f5f5f4` | `#23252e` |
| `--pane-tab-bg` | `color-mix(in srgb, var(--text) 3%, transparent)` | .pane-tab:hover {background} | `#ffffff08` | `#16151b08` | `#ffffff08` |
| `--cg-file-open-line` | `color-mix(in srgb, var(--bg-field) 81%, var(--line-strong))` | .cg-file.open {border-bottom-color}; .cg-hunk {border-top}; .cg-hunk {border-bottom} | `#25262f` | `#f5f3f1` | `#23242f` |
| `--git-modified-text` | `color-mix(in srgb, var(--warn) 83%, var(--text))` | .st-M {color} | `#efbc5a` | `#764e05` | `#e3b95c` |
| `--git-renamed-text` | `color-mix(in srgb, var(--info) 65%, var(--text))` | .st-R {color} | `#8fb8ff` | `#1c4586` | `#8fb8ff` |
| `--git-conflict-text` | `var(--danger)` | .st-C {color}; .cg-conflict {color} | `#ff9f6e` | `#a82424` | `#ff9f6e` |
| `--git-conflict-bg` | `color-mix(in srgb, var(--danger) 13%, transparent)` | .cg-conflict {background} | `#ff9f6e22` | `#a8242421` | `#ff9f6e22` |
| `--cg-hunk-bg` | `color-mix(in srgb, var(--bg-field) 87%, var(--code-bg))` | .cg-hunk {background} | `#1e1f27` | `#fdfdfc` | `#1b1c26` |
| `--cg-no-text` | `var(--text-faint)` | .cg-no {color} | `#918d80` | `#6b6455` | `#7a7f91` |
| `--cg-sign-text` | `var(--text-faint)` | .cg-sign {color} | `#918d80` | `#6b6455` | `#7b8194` |
| `--cg-text` | `color-mix(in srgb, var(--text) 74%, var(--muted))` | .cg-text {color}; .ar-pre {color} | `#dbd8cf` | `#282626` | `#cfd2dc` |
| `--cg-add-bg` | `color-mix(in srgb, var(--ok) 12%, var(--bg))` | .cg-row.cg-add {background} | `#17301f` | `#dce3d8` | `#17301f` |
| `--cg-add-no-bg` | `color-mix(in srgb, var(--ok) 17%, var(--bg))` | .cg-row.cg-add .cg-no {background} | `#24332e` | `#d1dccf` | `#1a3a25` |
| `--cg-add-no-text` | `color-mix(in srgb, var(--ok) 70%, var(--text))` | .cg-row.cg-add .cg-no {color} | `#9dd9b1` | `#164c31` | `#6fae86` |
| `--cg-del-bg` | `color-mix(in srgb, var(--danger) 13%, var(--bg))` | .cg-row.cg-del {background} | `#35191d` | `#edd9d4` | `#35191d` |
| `--cg-del-no-bg` | `color-mix(in srgb, var(--danger) 20%, var(--bg))` | .cg-row.cg-del .cg-no {background} | `#3e2b2f` | `#e7cac6` | `#44202a` |
| `--cg-del-no-text` | `color-mix(in srgb, var(--danger) 70%, var(--text))` | .cg-row.cg-del .cg-no {color} | `#efa7a4` | `#7c2021` | `#c47f8b` |
| `--cg-discard-text` | `color-mix(in srgb, var(--danger-bright) 90%, var(--bg))` | .cg-discard {color}; .cg-foot-note.err {color} | `#f0a0b0` | `#b0352f` | `#f0a0b0` |
| `--cg-discard-bg` | `color-mix(in srgb, var(--danger) 11%, var(--bg))` | .cg-discard:hover:not(:disabled) {background} | `#2a2025` | `#eeddd8` | `#2a1a20` |
| `--ar-pick-bg` | `color-mix(in srgb, var(--panel-2) 41%, var(--bg-field))` | .ar-pick,.ar-ver,.ar-ico {background}; .ar-pop {background}; .split-ghost {background} | `#21222a` | `#ffffff` | `#1e1f28` |
| `--ar-ver-old-text` | `color-mix(in srgb, var(--warn) 74%, var(--text))` | .ar-ver.old {color}; .ar-avail {color} | `#efc169` | `#6c4807` | `#f0c36a` |
| `--ar-ver-old-line` | `color-mix(in srgb, var(--warn) 40%, var(--panel))` | .ar-ver.old {border-color} | `#70582e` | `#d0bd99` | `#6b5a2c` |
| `--ar-avail-bg` | `color-mix(in srgb, var(--warn) 18%, var(--bg))` | .ar-avail {background} | `#3a301f` | `#e3d8c3` | `#3a2d12` |
| `--ar-avail-line` | `color-mix(in srgb, var(--warn) 33%, var(--bg))` | .ar-avail {border-bottom} | `#5b4725` | `#d3c19f` | `#5a4620` |
| `--ar-switch-text` | `color-mix(in srgb, var(--warn) 54%, var(--text))` | .ar-switch {color} | `#ffd98a` | `#553a0c` | `#ffd98a` |
| `--ar-sep-bg` | `color-mix(in srgb, var(--hover) 68%, var(--line-strong))` | .ar-sep {background} | `#2f3039` | `#e1dcd1` | `#2c2e3a` |
| `--plan-text-underline` | `color-mix(in srgb, var(--line) 34%, var(--text-faint))` | .plan-completed .plan-text {text-decoration-color} | `#6f6c67` | `#938d80` | `#5d6272` |
| `--plan-spin-line` | `color-mix(in srgb, color-mix(in srgb, var(--text) 83%, var(--muted)) 25%, transparent)` | .plan-spin::before {border} | `#e1ded540` | `#22202240` | `#d7d9e340` |
| `--nextstep-btn-primary-line` | `color-mix(in srgb, var(--line-strong) 61%, var(--text-faint))` | .nextstep-btn.primary {border-color} | `#605f60` | `#a49d8e` | `#55586a` |
| `--split-hint-bg` | `color-mix(in srgb, var(--accent) 22%, transparent)` | .split-hint {background} | `#2bb3a338` | `#0f766e38` | `#bba1ff38` |
| `--split-ghost-shadow` | `color-mix(in srgb, var(--bg) 45%, transparent)` | .split-ghost {box-shadow} | `#12131873` | `#f7f4ee73` | `#00000073` |
| `--pv-body-bg` | `var(--bg)` | .pv-body {background} | `#121318` | `#f7f4ee` | `#000000` |
| `--heading-tint-text` | `var(--text-6)` | .brand {color}; .elicitation-heading {color} | `#edeae2` | `#16151b` | `#e5d8ff` |
| `--tab-selected-text` | `var(--text-6)` | .provider-tabs button[aria-selected='true'] {color}; .textsize-badge {color}; .split-hint .lbl {color} | `#edeae2` | `#16151b` | `#f0e5ff` |
| `--title-active-text` | `var(--text-6)` | .sa-working .sa-title {color}; .pane-tab.active {color} | `#edeae2` | `#16151b` | `#f1ecff` |
| `--clamp-toggle-text` | `var(--text-6)` | .clamp-toggle:hover,.clamp-toggle:focus-visible {color} | `#edeae2` | `#16151b` | `#d8ccff` |
| `--plan-active-text` | `var(--text-6)` | .plan-in_progress .plan-text {color} | `#edeae2` | `#16151b` | `#f0eaff` |
| `--option-selected-bg` | `var(--accent-wash)` | .connection.selected {background}; .slash-option.selected {background} | `#17332f` | `#e3f2ef` | `#2b223b` |
| `--clamp-toggle-bg` | `var(--accent-wash)` | .clamp-toggle:hover,.clamp-toggle:focus-visible {background} | `#17332f` | `#e3f2ef` | `#2a2540` |
| `--st-section-active-bg` | `var(--accent-wash)` | .st-section.active {background}; .st-flash {background} | `#17332f` | `#e3f2ef` | `#272433` |
| `--bubble-user-bg` | `var(--panel-2)` | .bubble.user {background} | `#23242c` | `#ffffff` | `#272031` |
| `--approval-bg` | `var(--panel-2)` | .approval {background} | `#23242c` | `#ffffff` | `#302a1c` |
| `--elicitation-card-bg` | `var(--panel-2)` | .elicitation-card {background} | `#23242c` | `#ffffff` | `#242032` |
| `--bubble-user-line` | `var(--line-card)` | .bubble.user {border-color} | `#3e3f49` | `#cbc4b6` | `#4d3c65` |
| `--tab-selected-bg` | `var(--accent-wash-2)` | .provider-tabs button[aria-selected='true'] {background} | `#1f423d` | `#dcefea` | `#342744` |
| `--elicitation-url-host-bg` | `var(--accent-wash-2)` | .elicitation-url-host {background} | `#1f423d` | `#dcefea` | `#4b3a7a` |
| `--menu-hover-bg` | `var(--accent-wash-2)` | .organize-menu button:hover,.organize-menu button:focus {background} | `#1f423d` | `#dcefea` | `#3a3248` |
| `--subagent-card-selected-line` | `var(--accent-line)` | .subagent-card.selected {border-color}; .command-card.selected {border-color}; .ws-qa-reply {border-color} | `#2a7c72` | `#3d968b` | `#6a528f` |
| `--rename-dialog-line` | `var(--accent-line)` | #renameDialog {border} | `#2a7c72` | `#3d968b` | `#5b4a78` |
| `--divider-active-bg` | `var(--accent-line)` | .dv:hover,.dv.on {background} | `#2a7c72` | `#3d968b` | `#4a4660` |
| `--message-image-line` | `var(--accent)` | .bubble .message-image:hover {border-color}; .tool-thumbs .tool-thumb:hover,.tool-thumbs .tool-thumb:focus-visible {border-color} | `#2bb3a3` | `#0f766e` | `#a99cff` |
| `--np-primary-bg` | `var(--accent)` | .np-primary {background} | `#2bb3a3` | `#0f766e` | `#6a4fc2` |
| `--np-primary-line` | `var(--accent)` | .np-primary {border-color} | `#2bb3a3` | `#0f766e` | `#8a6fe0` |
| `--ws-qa-send-primary-bg` | `var(--accent)` | .ws-qa-send.primary {background} | `#2bb3a3` | `#0f766e` | `#8f7cf0` |
| `--elicitation-url-bg` | `var(--code-bg)` | .elicitation-url {background} | `#16171d` | `#f1ede5` | `#17141f` |
| `--elicitation-url-line` | `var(--line-field)` | .elicitation-url {border}; .auth-method {border} | `#373841` | `#d6d0c3` | `#4a3d6b` |
| `--activity-when-text` | `var(--text-dim)` | .sa-working .sa-when,.proc-running .sa-when {color} | `#b7b3a8` | `#48443d` | `#a79fbd` |
| `--row-agent-text` | `var(--text-dim)` | aside .connection .row-agent {color} | `#b7b3a8` | `#48443d` | `#929aaa` |
| `--chip-icon-bg` | `var(--accent-wash-4)` | .chip-agent .chip-icon {background} | `#16302d` | `#dcefea` | `#33324a` |
| `--st-letter-bg` | `var(--accent-wash-4)` | .st-letter {background} | `#16302d` | `#dcefea` | `#2d2745` |
| `--clamp-toggle-line` | `var(--line-control)` | .clamp-toggle {border} | `#3e3e43` | `#cdc8bd` | `#3a3550` |
| `--else-status-text` | `var(--hd-idle)` | #status[data-tone='else'],#turnStatus[data-tone='else'] {color}; #status[data-tone='else']::before,#turnStatus[data-tone='else']::before {border}; .mirror-status[data-tone='else'] {color} (+1 more) | `#c9c5bb` | `#4a4740` | `#f0b23e` |
| `--question-line` | `var(--status-needs-line)` | .elicitation-card {border}; .connection.attn-needs_you {border-color} | `#ff7a59` | `#b8381c` | `#705a9b` |
| `--card-needs-line` | `var(--status-needs-line)` | aside .connection.selected.attn-needs_you {box-shadow}; aside .connection.attn-needs_you:not(.selected) {box-shadow} | `#ff7a59` | `#b8381c` | `#f2b24a8c` |
| `--tool-done-text` | `var(--status-done)` | .tool-status.status-completed {color} | `#2bb3a3` | `#08706a` | `#8be3ad` |
| `--mark-ok-text` | `var(--status-done)` | .mark-ok {color} | `#2bb3a3` | `#08706a` | `#8be28b` |
| `--st-unread-bg` | `var(--status-done)` | .st-unread {background} | `#2bb3a3` | `#08706a` | `#6fb4ff` |
| `--st-status-ok-text` | `var(--status-done)` | .st-status.ok {color} | `#2bb3a3` | `#08706a` | `#9ad8a6` |
| `--tool-working-text` | `var(--status-working)` | .tool-status.status-in_progress {color} | `#ffc247` | `#8f5a00` | `#c9bcff` |
| `--turn-working-text` | `var(--status-working)` | .turn-line[data-kind='working'] {color} | `#ffc247` | `#8f5a00` | `#c9b8ff` |
| `--ws-working-bg` | `var(--status-working)` | .ws-working {background} | `#ffc247` | `#8f5a00` | `#6fb4ff` |
| `--turn-idle-line` | `var(--status-done-line)` | .turn-line[data-kind='idle'] {border-color} | `#2bb3a3` | `#08706a` | `#2a4a3a` |
| `--turn-needs-text` | `var(--status-needs)` | .turn-line[data-kind='needs'] {color} | `#ff7a59` | `#b8381c` | `#f0d28a` |
| `--st-needs-bg` | `var(--status-needs)` | .st-needs_you {background}; .status-count {background} | `#ff7a59` | `#b8381c` | `#bba1ff` |
| `--st-status-warn-text` | `var(--status-needs)` | .st-status.warn {color} | `#ff7a59` | `#b8381c` | `#e6c07a` |
| `--st-needs-halo` | `var(--status-needs-halo)` | .st-needs_you {box-shadow} | `#ff7a594d` | `#b8381c4d` | `#bba1ff33` |
| `--hd-need-halo` | `var(--status-needs-halo)` | #status[data-tone='need']::before,#turnStatus[data-tone='need']::before {box-shadow} | `#ff7a594d` | `#b8381c4d` | `#f0b23e49` |
| `--st-idle-line` | `var(--status-idle)` | .st-idle {border} | `#c9c5bb` | `#4a4740` | `#4fae85` |
| `--st-count-text` | `var(--status-needs-bg)` | .status-count {color} | `#3d1f18` | `#ffe4dc` | `#1d1530` |
| `--count-needs-text` | `var(--status-needs-bg)` | .status-count {color} | `#3d1f18` | `#ffe4dc` | `#24180a` |
| `--ws-badge-text` | `var(--status-needs-bg)` | .ws-badge {color} | `#3d1f18` | `#ffe4dc` | `#1b1300` |
| `--st-status-warn-line` | `var(--status-needs-bg)` | .st-status.warn {border-color} | `#3d1f18` | `#ffe4dc` | `#6b5628` |
| `--chip-icon-text` | `var(--link)` | .chip-agent .chip-icon {color}; .st-letter {color} | `#33bcab` | `#0f766e` | `#d9ccff` |
| `--clamp-toggle-text-rest` | `var(--link)` | .clamp-toggle {color} | `#33bcab` | `#0f766e` | `#b9a7ff` |
| `--np-primary-text` | `var(--on-accent)` | .np-primary {color} | `#0b1f1d` | `#ffffff` | `#ffffff` |
| `--jump-new-text` | `var(--on-accent)` | .jump-new {color} | `#0b1f1d` | `#ffffff` | `#15111d` |
| `--ws-qa-send-primary-text` | `var(--on-accent)` | .ws-qa-send.primary {color} | `#0b1f1d` | `#ffffff` | `#16131f` |
| `--st-primary-text` | `var(--on-accent)` | .st-agent-head .st-primary {color} | `#0b1f1d` | `#ffffff` | `#101114` |
| `--st-status-ok-line` | `var(--status-done-bg)` | .st-status.ok {border-color} | `#12302c` | `#ddf1ec` | `#2f5a3a` |
| `--else-phrase-text` | `var(--muted)` | .tone-else .row-phrase {color} | `#a9a497` | `#5c5547` | `#f0b23e` |
| `--sel-bar` | `var(--accent)` | aside .connection.selected::before {background} | `#2bb3a3` | `#0f766e` | `#a98be2` |
| `--else-dot-line` | `var(--status-idle)` | .status-dot.d-else {border} | `#c9c5bb` | `#4a4740` | `#8a9be0` |
| `--primary-disabled-bg` | `var(--accent-wash-2)` | .primary:disabled {background} | `#1f423d` | `#dcefea` | `#6b5e92` |
| `--primary-disabled-line` | `var(--accent-line)` | .primary:disabled {border-color} | `#2a7c72` | `#3d968b` | `#6b5e92` |
| `--artifact-frame-bg` | `#ffffff` | Behind an artifact page or image: always white, as a web page expects (theme-independent) | `#ffffff` | `#ffffff` | `#ffffff` |

## Colours that stay out of the tokens

- `clamp.css` and the tab strip fade use `#000` in `mask-image`: a mask only uses its alpha, so the colour is never seen.
- The old monitor pages (`style.css`, `sidebar.css`, index.html and conversation.html) are a separate tool with their own
  palette and are not themed.
- `--artifact-frame-bg` is white in every theme on purpose: an artifact page or image expects a white page behind it.
