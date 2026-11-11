# AIB colour themes

Every colour the chat page paints is a token in `outputs/agent-studio/theme.css`; the other stylesheets only say
`var(--token)`. A theme is a set of token values selected with `data-theme` on `<html>`. This file lists every token and
what it is for. It is generated from theme.css (the comments there are the source); keep both in step.

## How it fits together

- **Core tokens** (46): the values a theme must set. Neutrals (page, panels, lines, text), the accent, the status
  families, syntax colours, the terminal and the shadow ink.
- **Derived tokens** (286): formulas over the core tokens (`var()` or `color-mix(in srgb, ...)`), in the first
  block of theme.css, which applies to `:root` and to any element with `data-theme` (so the Settings swatches can show a
  theme). A theme that sets only the core tokens still paints everything; a theme may pin any derived token in its block.
- **Themes**: one block `[data-theme='<id>'] { color-scheme: dark|light; core tokens; pins }`. AIB teal (dark) is the
  default and also applies when `<html>` has no `data-theme` (`:root:not([data-theme])`).
- **Picking**: `themes.js` (the first, blocking script in chat.html) holds the list the Settings picker shows (grouped AIB,
  Accessibility, Editor-style) and sets `data-theme` before first paint. The choice is saved in localStorage key
  `aib-theme`, which `view-prefs.js` copies into the data folder (`studio-view.json`) like the text size; the server
  writes it back onto `<html data-theme-pref>`. "Match system" follows the OS light/dark setting between the two AIB
  themes. Saved ids of replaced themes are mapped (`classic`, `purple` -> `dracula`).
- **Terminal**: `terminal-ui.js` reads the `--term-*` tokens and re-reads them when `data-theme` changes.
- **Checks**: `work/test_themes.js` (every theme sets every core token, every token resolves, no colour outside theme.css,
  WCAG contrast of every pair in `work/theme_pairs.js` in every theme: 4.5:1 text and 3:1 UI, 7:1 and 4.5:1 for
  high-contrast themes) and `work/test_card_layout.js` (no theme, and no status symbol, moves a card or tab).

## Adding a theme

1. Add a block to theme.css: `[data-theme='my-theme'] { color-scheme: dark; ... }` with every core token below (copy the
   AIB teal (dark) block and change the values). Pin derived tokens only where a formula does not suit the theme.
2. Add one entry to `THEMES` in `themes.js`: `{ id: 'my-theme', label: 'My theme', group: 'Editor-style', scheme: 'dark' }`
   (`contrast: 'high'` raises the test's targets to 7:1 / 4.5:1; `symbols: true` always shows the status symbols).
3. Run `node --test work/test_themes.js`: it lists every pair below its target, with both colours.

## Themes

| id | Name | Group | Scheme | Notes |
|---|---|---|---|---|
| `teal-dark` | AIB teal (dark) | AIB | dark | default |
| `teal-light` | AIB teal (light) | AIB | light |  |
| `hc-dark` | High contrast dark | Accessibility | dark | contrast target 7:1 text, 4.5:1 UI |
| `hc-light` | High contrast light | Accessibility | light | contrast target 7:1 text, 4.5:1 UI |
| `cb-safe` | Colour-blind safe dark | Accessibility | dark | always shows status symbols |
| `dracula` | Dracula-style dark | Editor-style | dark | status chips option E (Working and Needs you filled, Done, Error, Idle outlined); saved ids classic and purple open it |
| `monokai` | Monokai-style dark | Editor-style | dark |  |
| `nord` | Nord-style cool dark | Editor-style | dark |  |
| `ember` | Ember (warm, low blue light) | Editor-style | dark |  |
| `github-light` | GitHub-style light | Editor-style | light |  |
| `solarized-light` | Solarized-style light | Editor-style | light |  |
| `system` | Match system | AIB | follows the OS | AIB teal (dark) or (light) |

## Core tokens

| Token | Used for | AIB teal (dark) | AIB teal (light) | High contrast dark | High contrast light | Colour-blind safe dark | Dracula-style dark | Monokai-style dark | Nord-style cool dark | Ember (warm, low blue light) | GitHub-style light | Solarized-style light |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `--bg` | Page background: the chat column and the deepest wells | `#121318` | `#f7f4ee` | `#000000` | `#ffffff` | `#101114` | `#282a36` | `#1e1f1c` | `#2e3440` | `#1a1512` | `#ffffff` | `#fdf6e3` |
| `--panel` | Sidebar, switcher and dialog panels | `#1b1c23` | `#ffffff` | `#0a0a0a` | `#f5f5f5` | `#17181e` | `#21222c` | `#272822` | `#292e39` | `#211b17` | `#f6f8fa` | `#eee8d5` |
| `--panel-2` | Raised blocks: your prompts, approval and question cards, dialogs, attachment cards | `#23242c` | `#ffffff` | `#161616` | `#ebebeb` | `#20212a` | `#343746` | `#2f302a` | `#3b4252` | `#2a221d` | `#eef1f4` | `#e6dfc8` |
| `--bg-field` | Inputs, slash popup, open tool rows | `#1f2028` | `#ffffff` | `#0d0d0d` | `#ffffff` | `#1c1e27` | `#21222c` | `#2d2e28` | `#3b4252` | `#2a221d` | `#ffffff` | `#fffbf0` |
| `--hover` | Hover fill for sidebar rows, tabs, buttons | `#272830` | `#ece8df` | `#262626` | `#e0e0e0` | `#23252f` | `#44475a` | `#3a3b34` | `#434c5e` | `#362c25` | `#eaeef2` | `#e4dcc4` |
| `--line` | Default hairline border | `#2c2d36` | `#e2ded4` | `#8c8c8c` | `#6b6b6b` | `#2d2e39` | `#343746` | `#3e3f38` | `#434c5e` | `#3a3029` | `#d0d7de` | `#ddd6c1` |
| `--line-strong` | Panel, form and card borders | `#40414b` | `#c9c2b3` | `#d0d0d0` | `#1a1a1a` | `#4a4a5c` | `#44475a` | `#5a5b52` | `#5d6880` | `#57493d` | `#8c959f` | `#9c9886` |
| `--text` | Default text on the page | `#edeae2` | `#16151b` | `#ffffff` | `#000000` | `#e5e7ec` | `#f8f8f2` | `#f8f8f2` | `#eceff4` | `#f0e2cf` | `#1f2328` | `#073642` |
| `--text-bright` | Strongest text: hovered and selected controls, the ring round a focused primary button | `#ffffff` | `#000000` | `#ffffff` | `#000000` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` | `#fff4e6` | `#1f2328` | `#073642` |
| `--muted` | Muted text: meta lines, agent names, secondary labels | `#a9a497` | `#5c5547` | `#d4d4d4` | `#2e2e2e` | `#9ea5b5` | `#afb7cd` | `#b3b09f` | `#bdc3d1` | `#c2ad94` | `#59636e` | `#4e646b` |
| `--text-faint` | Faintest readable text: placeholders, composer notes, context state | `#918d80` | `#6b6455` | `#b8b8b8` | `#474747` | `#8b92a3` | `#9ca0c1` | `#a29e8a` | `#a6afc0` | `#a8937c` | `#646e79` | `#51666d` |
| `--code-bg` | Code blocks, diffs, resource links | `#16171d` | `#f1ede5` | `#0d0d0d` | `#f5f5f5` | `#14151b` | `#21222c` | `#272822` | `#272c36` | `#17130f` | `#f6f8fa` | `#f6efdc` |
| `--accent` | The one accent: primary button fill, focus rings, selection bars, accent borders | `#2bb3a3` | `#0f766e` | `#2ee6d4` | `#00574f` | `#2bb3a3` | `#c49aff` | `#a6e22e` | `#94ccdc` | `#e0a15a` | `#0969da` | `#146aa3` |
| `--on-accent` | Text on an --accent fill | `#0b1f1d` | `#ffffff` | `#000000` | `#ffffff` | `#0b1f1d` | `#282a36` | `#1e1f1c` | `#2e3440` | `#1a1512` | `#ffffff` | `#ffffff` |
| `--link` | Links and accent-coloured text | `#33bcab` | `#0f766e` | `#5ff5e6` | `#004a44` | `#33bcab` | `#8be9fd` | `#a6e22e` | `#afdded` | `#e8ad6a` | `#005dcc` | `#006098` |
| `--accent-wash` | Active chat, selected rows, accent hover and active fill | `#17332f` | `#e3f2ef` | `#003a35` | `#d7f0ec` | `#17332f` | `#433d59` | `#2f3a1c` | `#3b5363` | `#3a2a1b` | `#ddf4ff` | `#dfe7df` |
| `--accent-line` | Selected-card and dialog accent borders (meaningful: 3:1) | `#2a7c72` | `#3d968b` | `#2ee6d4` | `#005a52` | `#2a7c72` | `#9073be` | `#6f9a1f` | `#6f9fb0` | `#9c6b35` | `#0969da` | `#268bd2` |
| `--danger` | Failure dot and new-line marker | `#f08a8a` | `#a82424` | `#fc8888` | `#8b1852` | `#ff4529` | `#ff7979` | `#fb6060` | `#fb74b8` | `#e363a3` | `#b3125e` | `#b0185a` |
| `--danger-bright` | Error text and failed tool status | `#ffbac6` | `#a8201a` | `#fdacac` | `#611139` | `#f77664` | `#ff9494` | `#fa8e8c` | `#f699ca` | `#e789b0` | `#87174e` | `#7d2153` |
| `--ok` | Additions, change counts, ok marks | `#7ad19c` | `#16643a` | `#6dff9e` | `#00561d` | `#7cc4ff` | `#50fa7b` | `#a6e22e` | `#a3be8c` | `#a9c77a` | `#116329` | `#5a6800` |
| `--warn` | Stars, file warnings, held chats | `#f0b23e` | `#8a5a00` | `#ffd23f` | `#663a00` | `#3e94ea` | `#f1fa8c` | `#e6db74` | `#ebcb8b` | `#e8c766` | `#946300` | `#7b5e00` |
| `--info` | Neutral information blue (agent badges, renamed files) | `#5aa9ff` | `#1f5fbf` | `#8fd8ff` | `#003da0` | `#56b4e9` | `#50fa7b` | `#a6e22e` | `#88c0d0` | `#f0b46c` | `#8250df` | `#2672a0` |
| `--status-working` | Working: text, dot and spinner head | `#ffc247` | `#8f5a00` | `#ffd23f` | `#663a00` | `#4699f0` | `#73b5ff` | `#e6db74` | `#ebcb8b` | `#e8c766` | `#946300` | `#7b5e00` |
| `--status-working-bg` | Working chip fill | `#3a2e14` | `#fff1d6` | `#2a2100` | `#fff0cc` | `#172636` | `#36435a` | `#3a3720` | `#46423a` | `#3a3119` | `#fff8c5` | `#f5e9c4` |
| `--status-needs` | Needs you: text, dot and badges | `#ff7a59` | `#b8381c` | `#ffb160` | `#8a1e00` | `#ffe252` | `#dba74b` | `#ff9933` | `#ffb457` | `#ff8466` | `#a34400` | `#9a3a00` |
| `--status-needs-bg` | Needs-you chip, turn-line and toast fill; text on a needs-you badge | `#3d1f18` | `#ffe4dc` | `#330f05` | `#ffe1d6` | `#36321e` | `#48403a` | `#3d2a12` | `#4a3a38` | `#401f19` | `#fff1e5` | `#f9e0cf` |
| `--status-done` | Done / Your turn / unread: text and dot | `#2bb3a3` | `#08706a` | `#2ee6d4` | `#00524b` | `#b1f1f1` | `#13f795` | `#66d9ef` | `#b0cb99` | `#a9c77a` | `#177d35` | `#18716b` |
| `--status-done-bg` | Done chip fill | `#12302c` | `#ddf1ec` | `#00302b` | `#d6f2ed` | `#2a3537` | `#00000000` | `#1c3439` | `#3d4a3f` | `#2c3320` | `#dafbe1` | `#dbefe6` |
| `--status-idle` | Idle and unknown: grey text and dot ring | `#c9c5bb` | `#4a4740` | `#bec2cb` | `#2e2e2e` | `#b2b2b2` | `#a8acbe` | `#9fa3ad` | `#c4cad6` | `#cdbfac` | `#59636e` | `#4a4a4a` |
| `--status-idle-bg` | Idle chip fill | `#26272f` | `#ece9e2` | `#1f1f1f` | `#e6e6e6` | `#2a2b2d` | `#00000000` | `#33342e` | `#3b4252` | `#2d2621` | `#eaeef2` | `#e8e2cf` |
| `--syn-keyword` | Code: keywords | `#c79bff` | `#7b3fc4` | `#dcb0ff` | `#6200aa` | `#c79bff` | `#ff79c6` | `#ff5fa3` | `#92b2d2` | `#e89a7a` | `#cf222e` | `#626a00` |
| `--syn-string` | Code: strings | `#9bd88f` | `#2f7a22` | `#a6ff8f` | `#0a5600` | `#e6c86e` | `#f1fa8c` | `#e6db74` | `#a3be8c` | `#b8c67a` | `#0a3069` | `#107169` |
| `--syn-number` | Code: numbers and literals | `#f0a96b` | `#a5520a` | `#ffc66b` | `#803600` | `#ffb26b` | `#bd93f9` | `#ae81ff` | `#c9a3c2` | `#e8c766` | `#0550ae` | `#bd216f` |
| `--syn-comment` | Code: comments | `#8a8679` | `#6b6455` | `#c0c0c0` | `#474747` | `#8f97a8` | `#989fcc` | `#9e9a87` | `#a5aec9` | `#a08c76` | `#59636e` | `#5a6868` |
| `--syn-key` | Code: object keys and headings | `#7cc4ff` | `#0b5fa8` | `#8fd8ff` | `#003da0` | `#56b4e9` | `#50fa7b` | `#a6e22e` | `#88c0d0` | `#f0b46c` | `#814fde` | `#1a6b99` |
| `--term-bg` | Terminal panel and xterm background | `#0e0f13` | `#fbfaf7` | `#000000` | `#ffffff` | `#14151b` | `#21222c` | `#272822` | `#272c36` | `#17130f` | `#f6f8fa` | `#f6efdc` |
| `--term-fg` | xterm text and cursor | `#edeae2` | `#16151b` | `#ffffff` | `#000000` | `#e5e7ec` | `#f8f8f2` | `#f8f8f2` | `#e5e9f0` | `#f0e2cf` | `#1f2328` | `#073642` |
| `--term-sel` | xterm selection | `#1f4a44` | `#cfe8e3` | `#2ee6d44d` | `#005a524d` | `#2bb3a34d` | `#bd93f94d` | `#a6e22e4d` | `#88c0d04d` | `#e0a15a4d` | `#0969da4d` | `#1f6fa84d` |
| `--term-red` | xterm red | `#f19999` | `#b42318` | `#ff6b6b` | `#a80000` | `#ff8c5a` | `#ff5555` | `#f94a91` | `#cd7d86` | `#f07f6e` | `#cf222e` | `#d12623` |
| `--term-green` | xterm green | `#7ad19c` | `#1d7a46` | `#5cff7a` | `#006400` | `#4fd1a5` | `#50fa7b` | `#a6e22e` | `#a3be8c` | `#a9c77a` | `#116329` | `#6b7200` |
| `--term-yellow` | xterm yellow | `#e6c27a` | `#8a5a00` | `#ffe14d` | `#704a00` | `#f5e050` | `#f1fa8c` | `#f4bf75` | `#ebcb8b` | `#e8c766` | `#4d2d00` | `#856900` |
| `--term-blue` | xterm blue | `#7cb7ff` | `#1f5fbf` | `#7fb0ff` | `#0033b3` | `#56b4e9` | `#bd93f9` | `#66d9ef` | `#81a1c1` | `#a3a6d4` | `#0969da` | `#2672a0` |
| `--term-magenta` | xterm magenta | `#c79bff` | `#8a3fb8` | `#ff7aff` | `#880088` | `#d38cff` | `#ff79c6` | `#ae81ff` | `#b48ead` | `#d79ac0` | `#8250df` | `#c62c77` |
| `--term-cyan` | xterm cyan | `#7fd3d8` | `#0b7380` | `#4df0ff` | `#005f63` | `#4fd1e0` | `#8be9fd` | `#a1efe4` | `#88c0d0` | `#9cc4b0` | `#1b7c83` | `#1d7970` |
| `--term-dim` | xterm bright black (prompts, dim text) | `#8a8679` | `#6b6455` | `#b0b0b0` | `#474747` | `#8b92a3` | `#8087b3` | `#938f7c` | `#8993a7` | `#8f7d6a` | `#57606a` | `#002b36` |
| `--shadow-ink` | Colour of drop shadows and backdrops (used with transparency) | `#000000` | `#2a2418` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` |

## Derived tokens

The formula is the default every theme gets; the columns show what it works out to in the two AIB themes (a pinned value
where the theme pins it). The designer's themes pin many of these; theme.css has their values.

| Token | Formula | Used for | AIB teal (dark) | AIB teal (light) |
|---|---|---|---|---|
| `--text-2` | `color-mix(in srgb, var(--text) 87%, var(--text-faint))` | Chip, tab and vendor-label text | `#e1ded5` | `#211f23` |
| `--text-3` | `color-mix(in srgb, var(--text) 65%, var(--muted))` | Secondary labels: sidebar summaries, inbox button | `#d5d2c8` | `#2f2b2a` |
| `--text-4` | `color-mix(in srgb, var(--text) 85%, var(--muted))` | Pane headings on hover, file-group scope | `#e3e0d7` | `#211f22` |
| `--text-5` | `color-mix(in srgb, var(--text) 65%, var(--muted))` | Link-like body text in the activity and changes panes | `#d5d2c8` | `#2f2b2a` |
| `--text-6` | `var(--text)` | Artifact list titles and picker text | `#edeae2` | `#16151b` |
| `--text-7` | `color-mix(in srgb, var(--text) 67%, var(--muted))` | Artifact version and next-step recap text | `#d7d3c9` | `#2d2a2a` |
| `--text-dim` | `color-mix(in srgb, var(--text) 41%, var(--text-faint))` | Activity strip and sub-agent card text | `#b7b3a8` | `#48443d` |
| `--text-muted` | `color-mix(in srgb, var(--muted) 72%, var(--text-faint))` | Qualifiers, timestamps, toggles | `#a29e91` | `#60594b` |
| `--text-muted-2` | `var(--muted)` | Plan step qualifiers (former idle status colour) | `#a9a497` | `#5c5547` |
| `--text-faint-2` | `var(--text-faint)` | Message times, turn dividers | `#918d80` | `#6b6455` |
| `--text-faint-3` | `var(--text-faint)` | Artifact shortcuts and counts | `#918d80` | `#6b6455` |
| `--bg-inset` | `color-mix(in srgb, var(--bg) 68%, var(--bg-field))` | Small inset fields: project filter, rename input, kbd chips | `#16171d` | `#faf8f3` |
| `--code-bg-inline` | `color-mix(in srgb, var(--panel-2) 59%, var(--code-bg))` | Inline code, table heads, diff summaries | `#1e1f26` | `#f9f8f4` |
| `--bg-popover` | `var(--bg-field)` | Toasts and popovers | `#1f2028` | `#ffffff` |
| `--bg-composer` | `color-mix(in srgb, var(--bg-field) 73%, var(--code-bg))` | Prompt form and small popups | `#1d1e25` | `#fbfaf8` |
| `--bg-control` | `var(--bg-field)` | Copy controls and menus | `#1f2028` | `#ffffff` |
| `--bg-row` | `color-mix(in srgb, var(--panel) 67%, var(--code-bg))` | Turn lines, message notes, queue rows on hover | `#191a21` | `#faf9f6` |
| `--bg-card-hover` | `color-mix(in srgb, var(--panel) 33%, var(--panel-2))` | Activity cards and strip on hover | `#202129` | `#ffffff` |
| `--hover-2` | `color-mix(in srgb, var(--line-strong) 35%, var(--code-bg))` | Hover fill for sub-agent cards and activity buttons | `#25262d` | `#e3ded4` |
| `--hover-overlay` | `color-mix(in srgb, var(--text) 8%, transparent)` | Translucent white hover wash on header icon buttons | `#ffffff14` | `#16151b14` |
| `--line-control` | `color-mix(in srgb, var(--line) 82%, var(--text-faint))` | Button and badge borders | `#3e3e43` | `#cdc8bd` |
| `--line-card` | `color-mix(in srgb, var(--line) 8%, var(--line-strong))` | Thumbnail and queue-row borders | `#3e3f49` | `#cbc4b6` |
| `--line-field` | `color-mix(in srgb, var(--hover) 36%, var(--line-strong))` | Input and popup borders | `#373841` | `#d6d0c3` |
| `--on-accent-disabled` | `color-mix(in srgb, var(--accent) 55%, var(--text))` | Text on a disabled primary button (on --accent-wash-2) | `#8fd9cf` | `#124a49` |
| `--link-underline` | `color-mix(in srgb, var(--link) 50%, transparent)` | Link underline at rest | `#33bcab80` | `#0f766e80` |
| `--accent-halo` | `color-mix(in srgb, var(--accent) 20%, transparent)` | Soft accent glow (drop target) | `#2bb3a333` | `#0f766e33` |
| `--accent-wash-2` | `color-mix(in srgb, var(--accent-wash) 93%, var(--text))` | Stronger teal hover fill | `#1f423d` | `#dcefea` |
| `--accent-wash-3` | `color-mix(in srgb, var(--accent-line) 35%, var(--code-bg))` | Artifacts pane teal fill | `#173a36` | `#d9eee9` |
| `--accent-wash-4` | `color-mix(in srgb, var(--accent-line) 31%, var(--bg))` | Sub-agent command chips, pane badges, agent letters | `#16302d` | `#dcefea` |
| `--accent-wash-5` | `color-mix(in srgb, var(--accent-line) 30%, var(--bg))` | Selected sub-agent and command card fill | `#1a3834` | `#d9eee9` |
| `--danger-text` | `color-mix(in srgb, var(--danger) 84%, var(--text))` | Ownership and error-note text | `#f09998` | `#912223` |
| `--danger-fill` | `color-mix(in srgb, var(--danger) 87%, var(--code-bg))` | Destructive primary button fill and border | `#d96b82` | `#b13e3d` |
| `--ok-text` | `color-mix(in srgb, var(--ok) 77%, var(--text))` | Idle status text and notify-on button | `#94d7ac` | `#165233` |
| `--ok-bright` | `var(--ok)` | Copied tick, added tokens, ok marks | `#8be28b` | `#16643a` |
| `--ok-text-2` | `var(--ok)` | Completed tool status and added diff lines | `#8be3ad` | `#16643a` |
| `--warn-text` | `color-mix(in srgb, var(--warn) 66%, var(--text))` | Hold note and held-chat text | `#efc576` | `#634309` |
| `--warn-text-2` | `color-mix(in srgb, var(--warn) 69%, var(--text))` | Recovered and possibly-active badges | `#efc371` | `#664508` |
| `--warn-bg` | `color-mix(in srgb, var(--warn) 15%, var(--bg))` | Former approval and needs-you fill; kept for code on other branches | `#332b1e` | `#e7ddca` |
| `--warn-line` | `color-mix(in srgb, var(--warn) 63%, var(--line-strong))` | Held and edited queue rows, mismatched setting chips | `#af8843` | `#a18042` |
| `--status-working-track` | `color-mix(in srgb, var(--status-working) 25%, transparent)` | Working spinner track (the spinner's head is --status-working) | `#ffc24740` | `#8f5a0040` |
| `--status-working-line` | `var(--status-working)` | Working borders: turn line, elsewhere chip | `#ffc247` | `#8f5a00` |
| `--status-needs-line` | `var(--status-needs)` | Needs-you borders and row outline | `#ff7a59` | `#b8381c` |
| `--status-needs-halo` | `color-mix(in srgb, var(--status-needs) 30%, transparent)` | Halo around the needs-you dot | `#ff7a594d` | `#b8381c4d` |
| `--status-done-line` | `var(--status-done)` | Your-turn turn-line border, unread row outline | `#2bb3a3` | `#08706a` |
| `--plan-dot` | `var(--text)` | Plan step dots | `#edeae2` | `#16151b` |
| `--shadow-strong` | `color-mix(in srgb, var(--shadow-ink) 67%, transparent)` | Toast, switcher and popover drop shadow | `#000000ab` | `#2a2418ab` |
| `--shadow-med` | `color-mix(in srgb, var(--shadow-ink) 60%, transparent)` | Menu shadow and switcher backdrop | `#00000099` | `#2a241899` |
| `--shadow-soft` | `color-mix(in srgb, var(--shadow-ink) 53%, transparent)` | Chip popover shadow | `#00000087` | `#2a241887` |
| `--accent-ink` | `var(--on-accent)` | Text on a solid accent button (Start new session, Try again) | `#0b1f1d` | `#ffffff` |
| `--bad-fill` | `color-mix(in srgb, var(--danger) 15%, var(--bg))` | "Didn't start" shell chip fill | `#3a1820` | `#ebd5d0` |
| `--bad-line` | `color-mix(in srgb, var(--danger) 44%, var(--bg))` | "Didn't start" shell chip border | `#7a3a48` | `#d49895` |
| `--hd-work` | `var(--status-working)` |  | `#ffc247` | `#8f5a00` |
| `--hd-turn` | `var(--status-done)` |  | `#2bb3a3` | `#08706a` |
| `--hd-need` | `var(--status-needs)` |  | `#ff7a59` | `#b8381c` |
| `--hd-idle` | `var(--status-idle)` |  | `#c9c5bb` | `#4a4740` |
| `--hd-fail` | `var(--danger)` |  | `#f08a8a` | `#a82424` |
| `--need` | `var(--status-needs)` |  | `#ff7a59` | `#b8381c` |
| `--ws-bg` | `var(--bg)` |  | `#121318` | `#f7f4ee` |
| `--sel` | `var(--accent-wash)` |  | `#17332f` | `#e3f2ef` |
| `--button-bg` | `var(--bg-field)` | button {background}; .ws-qa {background}; .st-close:hover {background} | `#1f2028` | `#ffffff` |
| `--label-text` | `color-mix(in srgb, var(--text) 48%, var(--muted))` | label {color} | `#cac6bb` | `#3a3632` |
| `--error-bg` | `color-mix(in srgb, var(--danger) 18%, var(--code-bg))` | #error {background} | `#40242e` | `#e4c9c2` |
| `--bubble-bg` | `color-mix(in srgb, var(--bg) 32%, var(--bg-field))` | .bubble {background}; .pane:not(.foc) .ws-tab.on {background} | `#1b1c23` | `#fcfbfa` |
| `--bubble-head-line` | `color-mix(in srgb, var(--panel-2) 89%, var(--text-faint))` | .bubble-head {border-bottom}; .msg-note-body {border-top} | `#2f3035` | `#efeeec` |
| `--bubble-head-text` | `color-mix(in srgb, var(--text) 33%, var(--muted))` | .bubble-head {color}; .tool-toggle {color}; .msg-note-toggle {color} | `#bfbbb0` | `#454038` |
| `--card-line` | `color-mix(in srgb, var(--bg) 43%, var(--line-strong))` | .connection {border} | `#2c2d35` | `#ddd8cc` |
| `--card-bg` | `color-mix(in srgb, var(--line-strong) 15%, var(--code-bg))` | .connection {background}; .command-card {background}; .switcher-open kbd,.switcher-foot kbd {background} | `#1c1d24` | `#ebe7de` |
| `--owned-status-text` | `color-mix(in srgb, var(--ok) 86%, var(--text))` | .connection .owned-status {color}; .badge-live {color} | `#8ad5a6` | `#165936` |
| `--menu-bg` | `color-mix(in srgb, var(--line-strong) 43%, var(--code-bg))` | #connectionMenu[open] button {background}; #connectionMenu[open] .menu-panel {background}; .organize-menu {background} | `#282931` | `#e0dbd0` |
| `--rename-chat-text` | `color-mix(in srgb, var(--text) 17%, var(--muted))` | .rename-chat {color} | `#b5b0a4` | `#504a40` |
| `--subagents-pane-bg` | `color-mix(in srgb, var(--panel) 33%, var(--code-bg))` | #subagentsPane,#subchatPane {background}; #subagentsPane {background}; .cg-file {background} | `#18191f` | `#f6f3ee` |
| `--subagent-card-meta-text` | `color-mix(in srgb, var(--accent-line) 64%, var(--text))` | .subagent-card small {color} | `#9a92ae` | `#2f6863` |
| `--subagent-card-desc-text` | `color-mix(in srgb, var(--muted) 36%, var(--text-faint))` | .subagent-card p {color} | `#9a9588` | `#665f50` |
| `--backdrop` | `color-mix(in srgb, var(--bg) 70%, transparent)` | #renameDialog::backdrop {background} | `#121318b3` | `#f7f4eeb3` |
| `--command-card-line` | `var(--line)` | .command-card {border} | `#2c2d36` | `#e2ded4` |
| `--command-error-text` | `var(--danger)` | .command-error {color} | `#ff9ba9` | `#a82424` |
| `--command-details-text` | `color-mix(in srgb, var(--text) 64%, var(--muted))` | #commandDetails {color}; .attachment-card span {color}; .image-viewer-caption {color} | `#d5d1c7` | `#2f2c2b` |
| `--attachment-remove-bg` | `color-mix(in srgb, var(--bg) 38%, var(--line-strong))` | .attachment-card .attachment-remove {background} | `#3b2934` | `#dad5c9` |
| `--attachment-remove-text` | `color-mix(in srgb, var(--danger-bright) 86%, var(--text))` | .attachment-card .attachment-remove {color} | `#fcc1ca` | `#941e1a` |
| `--message-image-bg` | `color-mix(in srgb, var(--bg) 46%, var(--code-bg))` | .bubble .message-image {background}; .tool-thumbs .tool-thumb {background} | `#14151b` | `#f4f0e9` |
| `--tool-failed-bg` | `color-mix(in srgb, var(--danger) 21%, var(--bg))` | .tool-status.status-failed {background} | `#4a1d27` | `#e6c8c4` |
| `--diff-removed-text` | `var(--danger)` | .diff-removed {color}; .diff-del .diff-sign {color} | `#ff9aa9` | `#a82424` |
| `--diff-add-bg` | `color-mix(in srgb, var(--ok) 18%, transparent)` | .diff-add {background} | `#34a8642e` | `#16643a2e` |
| `--diff-del-bg` | `color-mix(in srgb, var(--danger) 18%, transparent)` | .diff-del {background} | `#dc465a2e` | `#a824242e` |
| `--strip-notice-severity-warning-text` | `color-mix(in srgb, var(--warn) 46%, var(--text))` | .strip-notice.severity-warning {color} | `#ffd79a` | `#4b350f` |
| `--danger-line` | `color-mix(in srgb, var(--danger) 51%, var(--bg))` | .danger {border-color}; .cg-discard {border-color} | `#8f3b4d` | `#cf8a87` |
| `--primary-danger-text` | `color-mix(in srgb, var(--bg) 73%, var(--code-bg))` | .primary.danger {color} | `#1d0d12` | `#f5f2ec` |
| `--badge-live-bg` | `color-mix(in srgb, var(--ok) 16%, var(--bg))` | .badge-live {background} | `#16342a` | `#d3ddd1` |
| `--badge-live-line` | `color-mix(in srgb, var(--ok) 43%, var(--bg))` | .badge-live {border-color} | `#2c6b52` | `#96b6a1` |
| `--badge-saved-bg` | `color-mix(in srgb, var(--bg) 29%, var(--line))` | .badge-saved {background} | `#24252d` | `#e8e4dc` |
| `--badge-saved-text` | `color-mix(in srgb, var(--text) 30%, var(--muted))` | .badge-saved {color} | `#bdb9ae` | `#47423a` |
| `--badge-recovered-bg` | `color-mix(in srgb, var(--warn) 15%, var(--bg))` | .badge-recovered {background}; .badge-ownership-possibly_active {background} | `#332b1e` | `#e7ddca` |
| `--badge-recovered-line` | `color-mix(in srgb, var(--warn) 45%, var(--bg-field))` | .badge-recovered {border-color}; .badge-ownership-possibly_active {border-color}; .ownership-prompt {border} | `#7d6232` | `#cab58c` |
| `--badge-agent-bg` | `color-mix(in srgb, var(--info) 9%, var(--bg-field))` | .badge-agent {background} | `#242c3b` | `#ebf1f9` |
| `--badge-agent-text` | `color-mix(in srgb, var(--info) 63%, var(--text))` | .badge-agent {color}; aside .connection .row-status.tone-info .row-phrase {color} | `#90c1f4` | `#1c4482` |
| `--badge-agent-line` | `color-mix(in srgb, var(--info) 40%, var(--panel-2))` | .badge-agent {border-color} | `#395980` | `#a5bfe5` |
| `--stop-subagent-line` | `color-mix(in srgb, var(--danger) 52%, var(--code-bg))` | #stopSubagent {border-color} | `#8a4a56` | `#cb8481` |
| `--file-badge-ext-text` | `color-mix(in srgb, var(--accent) 20%, var(--text))` | .file-badge-ext {color} | `#c6dfd5` | `#15282c` |
| `--file-badge-size-text` | `var(--muted)` | .file-badge-size {color}; .attachment-card > span {color}; .file-card-meta {color} | `#a9a497` | `#5c5547` |
| `--icon-btn-line` | `color-mix(in srgb, var(--line-strong) 59%, var(--text-faint))` | .attachment-card .attachment-remove {border}; .image-viewer button {border} | `#616061` | `#a29b8c` |
| `--icon-btn-bg` | `color-mix(in srgb, var(--bg-field) 18%, var(--line))` | .attachment-card .attachment-remove {background}; .image-viewer button {background} | `#2a2b33` | `#e7e4dc` |
| `--image-viewer-bg` | `color-mix(in srgb, var(--bg) 90%, transparent)` | .image-viewer {background} | `#121318e6` | `#f7f4eee6` |
| `--ownership-hint-text` | `color-mix(in srgb, var(--text) 10%, var(--muted))` | .ownership-hint {color} | `#b0ab9f` | `#554f43` |
| `--badge-ownership-ownedelsewhere-bg` | `color-mix(in srgb, var(--danger) 16%, var(--bg))` | .badge-ownership-owned_elsewhere {background} | `#3a1f22` | `#ead3ce` |
| `--badge-ownership-ownedelsewhere-line` | `color-mix(in srgb, var(--danger) 43%, var(--bg))` | .badge-ownership-owned_elsewhere {border-color}; .ownership-prompt-blocked {border-color} | `#7a3a41` | `#d59b97` |
| `--ownership-prompt-bg` | `color-mix(in srgb, var(--warn) 12%, var(--bg))` | .ownership-prompt {background} | `#2d261d` | `#eae2d1` |
| `--ownership-prompt-blocked-bg` | `color-mix(in srgb, var(--danger) 10%, var(--bg))` | .ownership-prompt-blocked {background} | `#281f23` | `#efdfda` |
| `--ownership-note-text` | `color-mix(in srgb, var(--text) 49%, var(--muted))` | .ownership-note,.ownership-advice {color} | `#cac6bc` | `#3a3631` |
| `--organize-menu-shadow` | `color-mix(in srgb, var(--bg) 40%, transparent)` | .organize-menu {box-shadow}; .ws-scrim:not([hidden]) {background}; .ar-pop {box-shadow} | `#12131866` | `#f7f4ee66` |
| `--menu-danger-text` | `color-mix(in srgb, var(--danger) 70%, var(--text))` | .organize-menu button.danger {color} | `#ff9fb0` | `#7c2021` |
| `--copy-btn-text` | `color-mix(in srgb, var(--text) 64%, var(--muted))` | .copy-ctl button {color}; .run-term {color} | `#d5d1c7` | `#2f2c2b` |
| `--copy-btn-hover-bg` | `color-mix(in srgb, var(--hover) 87%, var(--text-faint))` | .copy-ctl button:hover,.copy-ctl button:focus-visible {background} | `#35353a` | `#dbd7cd` |
| `--copy-menu-line` | `color-mix(in srgb, var(--line) 24%, var(--line-strong))` | .copy-menu {border}; .copy-manual {border} | `#3b3c46` | `#cfc9bb` |
| `--copy-menu-item-bg` | `color-mix(in srgb, var(--bg-field) 27%, var(--line-strong))` | .copy-menu-item:hover,.copy-menu-item:focus-visible {background} | `#373842` | `#d8d2c8` |
| `--copy-manual-note-text` | `color-mix(in srgb, var(--warn) 64%, var(--text))` | .copy-manual-note {color} | `#ffd479` | `#60410a` |
| `--tool-error-text` | `var(--danger)` | .tool-result-error > summary {color} | `#f08a8a` | `#a82424` |
| `--syn-add-bg` | `color-mix(in srgb, var(--ok) 12%, var(--bg))` | .tok-add {background} | `#1a2e1f` | `#dce3d8` |
| `--syn-del-text` | `var(--danger)` | .tok-del {color}; .tool-line.failed .tool-line-text {color} | `#ff9b9b` | `#a82424` |
| `--syn-del-bg` | `color-mix(in srgb, var(--danger) 13%, var(--bg))` | .tok-del {background} | `#33191d` | `#edd9d4` |
| `--mark-failed-text` | `var(--danger)` | .mark-failed {color} | `#ff6b6b` | `#a82424` |
| `--turn-lost-text` | `color-mix(in srgb, var(--danger) 77%, var(--text))` | .turn-line[data-kind='lost'] {color}; .q-note {color} | `#efa09e` | `#862122` |
| `--turn-lost-line` | `color-mix(in srgb, var(--danger) 38%, var(--bg))` | .turn-line[data-kind='lost'] {border-color} | `#664043` | `#d9a5a1` |
| `--kbd-text` | `color-mix(in srgb, var(--text) 75%, var(--muted))` | .switcher-open kbd,.switcher-foot kbd {color} | `#dcd9cf` | `#282526` |
| `--project-head-bg` | `color-mix(in srgb, var(--panel-2) 71%, var(--bg-field))` | .project-head:hover {background} | `#22232b` | `#ffffff` |
| `--st-opening-line` | `color-mix(in srgb, var(--line-strong) 11%, var(--muted))` | .st-opening {border} | `#9d998f` | `#686153` |
| `--chip-v-text` | `color-mix(in srgb, var(--warn) 69%, var(--text))` | .chip-pending .chip-v {color}; .chip-warn {color}; .config-queued {color} | `#efc371` | `#664508` |
| `--studio-notice-line` | `color-mix(in srgb, var(--warn) 34%, var(--bg))` | .studio-notice {border} | `#5d4925` | `#d2c09d` |
| `--studio-notice-bg` | `color-mix(in srgb, var(--warn) 11%, var(--bg))` | .studio-notice {background} | `#2a241c` | `#ebe3d4` |
| `--studio-notice-text` | `color-mix(in srgb, var(--warn) 42%, var(--text))` | .studio-notice {color} | `#f0d9a0` | `#473210` |
| `--update-btn-line` | `color-mix(in srgb, var(--warn) 54%, var(--bg-field))` | .update-banner .update-btn {border} | `#906f34` | `#c0a675` |
| `--update-btn-text` | `color-mix(in srgb, var(--warn) 28%, var(--text))` | .update-banner .update-btn {color} | `#f7e6b8` | `#362813` |
| `--update-btn-bg` | `color-mix(in srgb, var(--warn) 19%, var(--bg))` | .update-banner .update-btn:hover {background} | `#3c311f` | `#e2d7c1` |
| `--activity-dot-bg` | `color-mix(in srgb, var(--line) 58%, var(--text-faint))` | .sa-dot {background}; .ac-dot {background} | `#565555` | `#b0ab9f` |
| `--activity-dot-failed-bg` | `color-mix(in srgb, var(--danger) 84%, var(--bg))` | .sa-failed .sa-dot,.proc-failed .sa-dot {background} | `#d9666e` | `#b54544` |
| `--activity-failed-text` | `color-mix(in srgb, var(--danger-bright) 94%, var(--bg))` | .sa-failed .sa-title {color}; .proc-failed .proc-title {color} | `#f1b0bc` | `#ad2d27` |
| `--proc-title-text` | `color-mix(in srgb, var(--text) 42%, var(--muted))` | .proc-title {color} | `#c6c1b7` | `#3f3a35` |
| `--activity-chip-sep-text` | `color-mix(in srgb, var(--line-strong) 50%, var(--text-faint))` | .ac-chip + .ac-chip::before {color} | `#696766` | `#9a9384` |
| `--ws-tab-bg` | `color-mix(in srgb, var(--panel) 82%, var(--line))` | .ws-tab {background}; .find-chat {background} | `#1e1f26` | `#faf9f7` |
| `--header-status-line` | `color-mix(in srgb, var(--ok) 30%, var(--bg))` | .header-actions #status,header #status {border} | `#314c40` | `#b3c9b8` |
| `--select-option-bg` | `color-mix(in srgb, var(--panel) 67%, var(--panel-2))` | .chip-agent-select option {background}; .st-agent {background} | `#1e1f26` | `#ffffff` |
| `--ws-newproj-line` | `color-mix(in srgb, var(--line) 61%, var(--text-faint))` | .ws-newproj {border} | `#535253` | `#b4aea2` |
| `--ws-menu-item-text` | `color-mix(in srgb, var(--line-strong) 47%, var(--muted))` | .ws-menu-item:disabled {color}; .status-dot.d-off {border} | `#787573` | `#8f887a` |
| `--kbd-text-2` | `color-mix(in srgb, var(--text) 75%, var(--muted))` | .find-chat kbd {color}; .side-settings kbd {color}; .st-kbd kbd {color} | `#dcd9cf` | `#282526` |
| `--row-chip-bg` | `color-mix(in srgb, var(--hover) 75%, var(--line-strong))` | aside .connection .row-chip {background} | `#2d2e37` | `#e3dfd4` |
| `--row-ok-text` | `color-mix(in srgb, var(--ok) 92%, var(--text))` | aside .connection .row-status.tone-ok .row-phrase {color}; .np-hint.ok {color} | `#83d3a2` | `#165e38` |
| `--row-project-text` | `color-mix(in srgb, var(--text) 35%, var(--muted))` | aside .connection .row-line3 .row-project {color} | `#c1bdb1` | `#443f38` |
| `--np-dialog-shadow` | `color-mix(in srgb, var(--bg) 80%, transparent)` | .np-dialog {box-shadow} | `#121318cc` | `#f7f4eecc` |
| `--field-invalid-line` | `color-mix(in srgb, var(--danger) 74%, var(--bg))` | .np-form input[aria-invalid='true'] {border-color} | `#c25f5f` | `#bd5a59` |
| `--note-warn-text` | `color-mix(in srgb, var(--warn) 70%, var(--muted))` | .ws-notify-body .note.warn {color} | `#dbae59` | `#7c5915` |
| `--count-turn-text` | `var(--bg)` | .status-count.count-turn {color} | `#0e1f17` | `#f7f4ee` |
| `--unknown-send-line-text` | `color-mix(in srgb, var(--warn) 73%, var(--muted))` | .unknown-send-line {color}; .unknown-send-btn {color}; .unknown-send-btn:hover {border-color} | `#ddae56` | `#7e5913` |
| `--unknown-send-btn-line` | `color-mix(in srgb, var(--warn) 38%, var(--bg-field))` | .unknown-send-btn {border-color} | `#6e5730` | `#d3c09e` |
| `--title-hover-bg` | `color-mix(in srgb, var(--text) 5%, transparent)` | header .hd-line h1:hover {background} | `#ffffff0d` | `#16151b0d` |
| `--ownership-bar-bg` | `var(--bg)` | .ownership-bar {background} | `#121318` | `#f7f4ee` |
| `--cancel-line` | `color-mix(in srgb, var(--danger) 48%, var(--bg))` | #cancel {border-color} | `#7d4c4f` | `#d1908d` |
| `--cancel-text` | `color-mix(in srgb, var(--danger) 52%, var(--text))` | #cancel {color} | `#efb8b4` | `#621d20` |
| `--composer-attach-line` | `color-mix(in srgb, var(--line) 75%, var(--text-faint))` | #promptForm .composer-actions .composer-attach {border} | `#454549` | `#c4c0b4` |
| `--composer-attach-bg` | `color-mix(in srgb, var(--bg-field) 69%, var(--line-strong))` | #promptForm .composer-actions .composer-attach:hover,#promptForm .composer-actions .composer-attach:focus-visible {background} | `#292a33` | `#eeece7` |
| `--ws-qa-choice-ok-bg` | `color-mix(in srgb, var(--ok) 43%, var(--bg))` | .ws-qa-choice.ok {background} | `#2f6f4c` | `#96b6a1` |
| `--ws-qa-choice-no-text` | `color-mix(in srgb, var(--danger) 77%, var(--text))` | .ws-qa-choice.no {color}; .switcher-sub.warn {color} | `#efa09e` | `#862122` |
| `--ws-reply-box-bg` | `color-mix(in srgb, var(--bg-field) 34%, var(--code-bg))` | .ws-reply-box {background}; .art-card {background}; .plan-dock {background} | `#191a21` | `#f6f3ee` |
| `--kbd-text-3` | `color-mix(in srgb, var(--text) 66%, var(--muted))` | .switcher-key kbd,.sheet-rows kbd {color}; .q-row {color} | `#d6d2c9` | `#2e2b2a` |
| `--danger-active-bg` | `color-mix(in srgb, var(--danger) 17%, var(--bg))` | .switcher-item.danger.active {background} | `#38272b` | `#ead1cc` |
| `--queue-paused-text` | `color-mix(in srgb, var(--warn) 55%, var(--text))` | .q-head.q-paused {color} | `#efcb88` | `#563b0c` |
| `--q-row-line` | `color-mix(in srgb, var(--line-strong) 48%, var(--text-faint))` | .q-row:hover,.q-row:focus-within {border-color} | `#6a6967` | `#989182` |
| `--q-btn-bg` | `color-mix(in srgb, var(--hover) 91%, var(--text-faint))` | .q-btn:hover,.q-btn:focus-visible {background}; .q-text-btn:hover,.q-text-btn:focus-visible {background} | `#313137` | `#e0dcd3` |
| `--side-settings-bg` | `color-mix(in srgb, var(--hover) 75%, var(--code-bg))` | .side-settings:hover,.side-settings:focus-visible {background}; .st-section:hover {background} | `#23242b` | `#ede9e1` |
| `--st-note-bad-text` | `color-mix(in srgb, var(--danger) 74%, var(--text))` | .st-note.bad,.st-error,.st-hint.warn {color}; .st-status.bad {color}; .st-danger {color} | `#efa3a1` | `#822022` |
| `--st-hint-warn-text` | `color-mix(in srgb, var(--warn) 66%, var(--text))` | .st-hint.warn {color}; .st-notify .note.warn {color} | `#efc576` | `#634309` |
| `--st-agent-line` | `color-mix(in srgb, var(--hover) 89%, var(--line-strong))` | .st-agent {border}; #startPage .sp-stuck {border} | `#2a2b33` | `#e8e4da` |
| `--st-status-bad-line` | `color-mix(in srgb, var(--danger) 36%, var(--bg))` | .st-status.bad {border-color} | `#6b3434` | `#dba9a5` |
| `--st-command-text` | `color-mix(in srgb, var(--text) 47%, var(--muted))` | .st-command {color} | `#c9c5ba` | `#3b3732` |
| `--st-line` | `color-mix(in srgb, var(--bg-field) 94%, var(--muted))` | .st-line {border-top}; .st-keys li {border-bottom} | `#27282f` | `#f5f5f4` |
| `--pane-tab-bg` | `color-mix(in srgb, var(--text) 3%, transparent)` | .pane-tab:hover {background} | `#ffffff08` | `#16151b08` |
| `--cg-file-open-line` | `color-mix(in srgb, var(--bg-field) 81%, var(--line-strong))` | .cg-file.open {border-bottom-color}; .cg-hunk {border-top}; .cg-hunk {border-bottom} | `#25262f` | `#f5f3f1` |
| `--git-modified-text` | `color-mix(in srgb, var(--warn) 83%, var(--text))` | .st-M {color} | `#efbc5a` | `#764e05` |
| `--git-renamed-text` | `color-mix(in srgb, var(--info) 65%, var(--text))` | .st-R {color} | `#8fb8ff` | `#1c4586` |
| `--git-conflict-text` | `var(--danger)` | .st-C {color}; .cg-conflict {color} | `#ff9f6e` | `#a82424` |
| `--git-conflict-bg` | `color-mix(in srgb, var(--danger) 13%, transparent)` | .cg-conflict {background} | `#ff9f6e22` | `#a8242421` |
| `--cg-hunk-bg` | `color-mix(in srgb, var(--bg-field) 87%, var(--code-bg))` | .cg-hunk {background} | `#1e1f27` | `#fdfdfc` |
| `--cg-no-text` | `var(--text-faint)` | .cg-no {color} | `#918d80` | `#6b6455` |
| `--cg-sign-text` | `var(--text-faint)` | .cg-sign {color} | `#918d80` | `#6b6455` |
| `--cg-text` | `color-mix(in srgb, var(--text) 74%, var(--muted))` | .cg-text {color}; .ar-pre {color} | `#dbd8cf` | `#282626` |
| `--cg-add-bg` | `color-mix(in srgb, var(--ok) 12%, var(--bg))` | .cg-row.cg-add {background} | `#17301f` | `#dce3d8` |
| `--cg-add-no-bg` | `color-mix(in srgb, var(--ok) 17%, var(--bg))` | .cg-row.cg-add .cg-no {background} | `#24332e` | `#d1dccf` |
| `--cg-add-no-text` | `color-mix(in srgb, var(--ok) 70%, var(--text))` | .cg-row.cg-add .cg-no {color} | `#9dd9b1` | `#164c31` |
| `--cg-del-bg` | `color-mix(in srgb, var(--danger) 13%, var(--bg))` | .cg-row.cg-del {background} | `#35191d` | `#edd9d4` |
| `--cg-del-no-bg` | `color-mix(in srgb, var(--danger) 20%, var(--bg))` | .cg-row.cg-del .cg-no {background} | `#3e2b2f` | `#e7cac6` |
| `--cg-del-no-text` | `color-mix(in srgb, var(--danger) 70%, var(--text))` | .cg-row.cg-del .cg-no {color} | `#efa7a4` | `#7c2021` |
| `--cg-discard-text` | `color-mix(in srgb, var(--danger-bright) 90%, var(--bg))` | .cg-discard {color}; .cg-foot-note.err {color} | `#f0a0b0` | `#b0352f` |
| `--cg-discard-bg` | `color-mix(in srgb, var(--danger) 11%, var(--bg))` | .cg-discard:hover:not(:disabled) {background} | `#2a2025` | `#eeddd8` |
| `--ar-pick-bg` | `color-mix(in srgb, var(--panel-2) 41%, var(--bg-field))` | .ar-pick,.ar-ver,.ar-ico {background}; .ar-pop {background}; .split-ghost {background} | `#21222a` | `#ffffff` |
| `--ar-ver-old-text` | `color-mix(in srgb, var(--warn) 74%, var(--text))` | .ar-ver.old {color}; .ar-avail {color} | `#efc169` | `#6c4807` |
| `--ar-ver-old-line` | `color-mix(in srgb, var(--warn) 40%, var(--panel))` | .ar-ver.old {border-color} | `#70582e` | `#d0bd99` |
| `--ar-avail-bg` | `color-mix(in srgb, var(--warn) 18%, var(--bg))` | .ar-avail {background} | `#3a301f` | `#e3d8c3` |
| `--ar-avail-line` | `color-mix(in srgb, var(--warn) 33%, var(--bg))` | .ar-avail {border-bottom} | `#5b4725` | `#d3c19f` |
| `--ar-switch-text` | `color-mix(in srgb, var(--warn) 54%, var(--text))` | .ar-switch {color} | `#ffd98a` | `#553a0c` |
| `--ar-sep-bg` | `color-mix(in srgb, var(--hover) 68%, var(--line-strong))` | .ar-sep {background} | `#2f3039` | `#e1dcd1` |
| `--plan-text-underline` | `color-mix(in srgb, var(--line) 34%, var(--text-faint))` | .plan-completed .plan-text {text-decoration-color} | `#6f6c67` | `#938d80` |
| `--plan-spin-line` | `color-mix(in srgb, color-mix(in srgb, var(--text) 83%, var(--muted)) 25%, transparent)` | .plan-spin::before {border} | `#e1ded540` | `#22202240` |
| `--nextstep-btn-primary-line` | `color-mix(in srgb, var(--line-strong) 61%, var(--text-faint))` | .nextstep-btn.primary {border-color} | `#605f60` | `#a49d8e` |
| `--split-hint-bg` | `color-mix(in srgb, var(--accent) 22%, transparent)` | .split-hint {background} | `#2bb3a338` | `#0f766e38` |
| `--split-ghost-shadow` | `color-mix(in srgb, var(--bg) 45%, transparent)` | .split-ghost {box-shadow} | `#12131873` | `#f7f4ee73` |
| `--pv-body-bg` | `var(--bg)` | .pv-body {background} | `#121318` | `#f7f4ee` |
| `--heading-tint-text` | `var(--text-6)` | .brand {color}; .elicitation-heading {color} | `#edeae2` | `#16151b` |
| `--tab-selected-text` | `var(--text-6)` | .provider-tabs button[aria-selected='true'] {color}; .textsize-badge {color}; .split-hint .lbl {color} | `#edeae2` | `#16151b` |
| `--title-active-text` | `var(--text-6)` | .sa-working .sa-title {color}; .pane-tab.active {color} | `#edeae2` | `#16151b` |
| `--clamp-toggle-text` | `var(--text-6)` | .clamp-toggle:hover,.clamp-toggle:focus-visible {color} | `#edeae2` | `#16151b` |
| `--plan-active-text` | `var(--text-6)` | .plan-in_progress .plan-text {color} | `#edeae2` | `#16151b` |
| `--option-selected-bg` | `var(--accent-wash)` | .connection.selected {background}; .slash-option.selected {background} | `#17332f` | `#e3f2ef` |
| `--clamp-toggle-bg` | `var(--accent-wash)` | .clamp-toggle:hover,.clamp-toggle:focus-visible {background} | `#17332f` | `#e3f2ef` |
| `--st-section-active-bg` | `var(--accent-wash)` | .st-section.active {background}; .st-flash {background} | `#17332f` | `#e3f2ef` |
| `--bubble-user-bg` | `var(--panel-2)` | .bubble.user {background} | `#23242c` | `#ffffff` |
| `--approval-bg` | `var(--panel-2)` | .approval {background} | `#23242c` | `#ffffff` |
| `--elicitation-card-bg` | `var(--panel-2)` | .elicitation-card {background} | `#23242c` | `#ffffff` |
| `--bubble-user-line` | `var(--line-card)` | .bubble.user {border-color} | `#3e3f49` | `#cbc4b6` |
| `--tab-selected-bg` | `var(--accent-wash-2)` | .provider-tabs button[aria-selected='true'] {background} | `#1f423d` | `#dcefea` |
| `--elicitation-url-host-bg` | `var(--accent-wash-2)` | .elicitation-url-host {background} | `#1f423d` | `#dcefea` |
| `--menu-hover-bg` | `var(--accent-wash-2)` | .organize-menu button:hover,.organize-menu button:focus {background} | `#1f423d` | `#dcefea` |
| `--subagent-card-selected-line` | `var(--accent-line)` | .subagent-card.selected {border-color}; .command-card.selected {border-color}; .ws-qa-reply {border-color} | `#2a7c72` | `#3d968b` |
| `--rename-dialog-line` | `var(--accent-line)` | #renameDialog {border} | `#2a7c72` | `#3d968b` |
| `--divider-active-bg` | `var(--accent-line)` | .dv:hover,.dv.on {background} | `#2a7c72` | `#3d968b` |
| `--message-image-line` | `var(--accent)` | .bubble .message-image:hover {border-color}; .tool-thumbs .tool-thumb:hover,.tool-thumbs .tool-thumb:focus-visible {border-color} | `#2bb3a3` | `#0f766e` |
| `--np-primary-bg` | `var(--accent)` | .np-primary {background} | `#2bb3a3` | `#0f766e` |
| `--np-primary-line` | `var(--accent)` | .np-primary {border-color} | `#2bb3a3` | `#0f766e` |
| `--ws-qa-send-primary-bg` | `var(--accent)` | .ws-qa-send.primary {background} | `#2bb3a3` | `#0f766e` |
| `--elicitation-url-bg` | `var(--code-bg)` | .elicitation-url {background} | `#16171d` | `#f1ede5` |
| `--elicitation-url-line` | `var(--line-field)` | .elicitation-url {border}; .auth-method {border} | `#373841` | `#d6d0c3` |
| `--activity-when-text` | `var(--text-dim)` | .sa-working .sa-when,.proc-running .sa-when {color} | `#b7b3a8` | `#48443d` |
| `--row-agent-text` | `var(--text-dim)` | aside .connection .row-agent {color} | `#b7b3a8` | `#48443d` |
| `--chip-icon-bg` | `var(--accent-wash-4)` | .chip-agent .chip-icon {background} | `#16302d` | `#dcefea` |
| `--st-letter-bg` | `var(--accent-wash-4)` | .st-letter {background} | `#16302d` | `#dcefea` |
| `--clamp-toggle-line` | `var(--line-control)` | .clamp-toggle {border} | `#3e3e43` | `#cdc8bd` |
| `--else-status-text` | `var(--hd-idle)` | #status[data-tone='else'],#turnStatus[data-tone='else'] {color}; #status[data-tone='else']::before,#turnStatus[data-tone='else']::before {border}; .mirror-status[data-tone='else'] {color} (+1 more) | `#c9c5bb` | `#4a4740` |
| `--question-line` | `var(--status-needs-line)` | .elicitation-card {border}; .connection.attn-needs_you {border-color} | `#ff7a59` | `#b8381c` |
| `--card-needs-line` | `var(--status-needs-line)` | aside .connection.selected.attn-needs_you {box-shadow}; aside .connection.attn-needs_you:not(.selected) {box-shadow} | `#ff7a59` | `#b8381c` |
| `--tool-done-text` | `var(--status-done)` | .tool-status.status-completed {color} | `#2bb3a3` | `#08706a` |
| `--mark-ok-text` | `var(--status-done)` | .mark-ok {color} | `#2bb3a3` | `#08706a` |
| `--st-unread-bg` | `var(--status-done)` | .st-unread {background} | `#2bb3a3` | `#08706a` |
| `--st-status-ok-text` | `var(--status-done)` | .st-status.ok {color} | `#2bb3a3` | `#08706a` |
| `--tool-working-text` | `var(--status-working)` | .tool-status.status-in_progress {color} | `#ffc247` | `#8f5a00` |
| `--turn-working-text` | `var(--status-working)` | .turn-line[data-kind='working'] {color} | `#ffc247` | `#8f5a00` |
| `--ws-working-bg` | `var(--status-working)` | .ws-working {background} | `#ffc247` | `#8f5a00` |
| `--turn-idle-line` | `var(--status-done-line)` | .turn-line[data-kind='idle'] {border-color} | `#2bb3a3` | `#08706a` |
| `--turn-needs-text` | `var(--status-needs)` | .turn-line[data-kind='needs'] {color} | `#ff7a59` | `#b8381c` |
| `--st-needs-bg` | `var(--status-needs)` | .st-needs_you {background}; .status-count {background} | `#ff7a59` | `#b8381c` |
| `--st-status-warn-text` | `var(--status-needs)` | .st-status.warn {color} | `#ff7a59` | `#b8381c` |
| `--st-needs-halo` | `var(--status-needs-halo)` | .st-needs_you {box-shadow} | `#ff7a594d` | `#b8381c4d` |
| `--hd-need-halo` | `var(--status-needs-halo)` | #status[data-tone='need']::before,#turnStatus[data-tone='need']::before {box-shadow} | `#ff7a594d` | `#b8381c4d` |
| `--st-idle-line` | `var(--status-idle)` | .st-idle {border} | `#c9c5bb` | `#4a4740` |
| `--st-count-text` | `var(--status-needs-bg)` | .status-count {color} | `#3d1f18` | `#ffe4dc` |
| `--count-needs-text` | `var(--status-needs-bg)` | .status-count {color} | `#3d1f18` | `#ffe4dc` |
| `--ws-badge-text` | `var(--status-needs-bg)` | .ws-badge {color} | `#3d1f18` | `#ffe4dc` |
| `--st-status-warn-line` | `var(--status-needs-bg)` | .st-status.warn {border-color} | `#3d1f18` | `#ffe4dc` |
| `--chip-icon-text` | `var(--link)` | .chip-agent .chip-icon {color}; .st-letter {color} | `#33bcab` | `#0f766e` |
| `--clamp-toggle-text-rest` | `var(--link)` | .clamp-toggle {color} | `#33bcab` | `#0f766e` |
| `--np-primary-text` | `var(--on-accent)` | .np-primary {color} | `#0b1f1d` | `#ffffff` |
| `--jump-new-text` | `var(--on-accent)` | .jump-new {color} | `#0b1f1d` | `#ffffff` |
| `--ws-qa-send-primary-text` | `var(--on-accent)` | .ws-qa-send.primary {color} | `#0b1f1d` | `#ffffff` |
| `--st-primary-text` | `var(--on-accent)` | .st-agent-head .st-primary {color} | `#0b1f1d` | `#ffffff` |
| `--st-status-ok-line` | `var(--status-done-bg)` | .st-status.ok {border-color} | `#12302c` | `#ddf1ec` |
| `--else-phrase-text` | `var(--muted)` | .tone-else .row-phrase {color} | `#a9a497` | `#5c5547` |
| `--sel-bar` | `var(--accent)` | aside .connection.selected::before {background} | `#2bb3a3` | `#0f766e` |
| `--else-dot-line` | `var(--status-idle)` | .status-dot.d-else {border} | `#c9c5bb` | `#4a4740` |
| `--primary-disabled-bg` | `var(--accent-wash-2)` | .primary:disabled {background} | `#1f423d` | `#dcefea` |
| `--primary-disabled-line` | `var(--accent-line)` | .primary:disabled {border-color} | `#2a7c72` | `#3d968b` |
| `--artifact-frame-bg` | `#ffffff` | Behind an artifact page or image: always white, as a web page expects (theme-independent) | `#ffffff` | `#ffffff` |
| `--focus-ring` | `var(--accent)` | Keyboard focus ring (outline) round buttons, fields, cards and tabs | `#2bb3a3` | `#0f766e` |
| `--chip-working-bg` | `var(--status-working-bg)` | Working chip fill (header, split pane, settings) | `#3a2e14` | `#fff1d6` |
| `--chip-working-line` | `var(--status-working-bg)` | Working chip border | `#3a2e14` | `#fff1d6` |
| `--chip-needs-bg` | `var(--status-needs-bg)` | Needs-you chip fill | `#3d1f18` | `#ffe4dc` |
| `--chip-needs-line` | `var(--status-needs-bg)` | Needs-you chip border | `#3d1f18` | `#ffe4dc` |
| `--chip-done-bg` | `var(--status-done-bg)` | Done / Your-turn chip fill | `#12302c` | `#ddf1ec` |
| `--chip-done-line` | `var(--status-done-bg)` | Done chip border | `#12302c` | `#ddf1ec` |
| `--chip-idle-bg` | `var(--status-idle-bg)` | Idle chip fill | `#26272f` | `#ece9e2` |
| `--chip-idle-line` | `var(--status-idle-bg)` | Idle chip border | `#26272f` | `#ece9e2` |
| `--term-cursor` | `var(--term-fg)` | xterm cursor | `#edeae2` | `#16151b` |
| `--term-black` | `color-mix(in srgb, var(--term-dim) 45%, var(--term-bg))` | xterm black | `#464541` | `#bab7ae` |
| `--term-white` | `color-mix(in srgb, var(--term-fg) 85%, var(--term-dim))` | xterm white | `#dedbd2` | `#232124` |
| `--term-bright-red` | `var(--term-red)` | xterm bright red | `#f19999` | `#b42318` |
| `--term-bright-green` | `var(--term-green)` | xterm bright green | `#7ad19c` | `#1d7a46` |
| `--term-bright-yellow` | `var(--term-yellow)` | xterm bright yellow | `#e6c27a` | `#8a5a00` |
| `--term-bright-blue` | `var(--term-blue)` | xterm bright blue | `#7cb7ff` | `#1f5fbf` |
| `--term-bright-magenta` | `var(--term-magenta)` | xterm bright magenta | `#c79bff` | `#8a3fb8` |
| `--term-bright-cyan` | `var(--term-cyan)` | xterm bright cyan | `#7fd3d8` | `#0b7380` |
| `--term-bright-white` | `var(--term-fg)` | xterm bright white | `#edeae2` | `#16151b` |

## Tokens that are not colours

- `--status-working-glyph`, `--status-needs-glyph`, `--status-done-glyph`, `--status-error-glyph`, `--status-idle-glyph`:
  the status symbols (◔ ▲ ✓ ✕ ○). Drawn in place of the status dot when `<html data-status-glyphs="on">` (Settings >
  Appearance > Show status symbols, saved as `aib-status-glyphs`, off by default) and always in the colour-blind safe
  theme. The symbol sits in the dot's own box, so no card or chip text moves.
- `--scrollbar-colors`: optional `<thumb> <track>` for `scrollbar-color`; unset means the browser's own scrollbars.

## Colours that stay out of the tokens

- `clamp.css` and the tab strip fade use `#000` in `mask-image`: a mask only uses its alpha, so the colour is never seen.
- The old monitor pages (`style.css`, `sidebar.css`, index.html and conversation.html) are a separate tool with their own
  palette and are not themed.
- `--artifact-frame-bg` is white in every theme on purpose: an artifact page or image expects a white page behind it.
