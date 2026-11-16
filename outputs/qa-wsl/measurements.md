# AIB WSL screens: measuring QA (looks)

Run 2026-11-16T01:49:53.486Z. Real page code (outputs/agent-studio/*.js + *.css) against fake routes of the contract shapes, headless Chrome, 1280 x 860 (the desktop window's default size, server/desktop/window.ts:29), device scale 1. Themes: teal-dark (AIB's default, THEMES.md) and teal-light. Reference: outputs/wsl-linking-mockup.html (embeds its own copy of theme.css/settings.css). Numbers are computed styles of the first visible matching element; colours as #rrggbb.

## Findings (ranked)

### broken (0)


### wrong vs reference (7)

1. **New-chat WSL box is not aligned with the centred form above it** (chat.js:3651 (box.className = 'nc-wsl'); no .nc-wsl rule in chat.css / header.css) The box starts at x=256 and is 728 px wide. The Agent/Model/Mode grid (.nc-grid) and the folder line (#ncFolder) start at x=430 and are 380 px wide. So the 'not installed' line, Install button, copy line and links hang 174 px left of the form. In the Node.js-missing state, 'Check again' sits 4 px from the Install button (x=376 vs 380). The Install button is 38 px tall, while the selects above it are 30 px.
2. **New project shows the raw ref: 'Uses wsl://ubuntu/home/u/ (already there)'** (workspace-state.js:794 (also :785 'Opens …', :806 'Creates …'); server/web/wsl_routes.ts:99-101 returns path as a wsl:// ref) The preview line under Project name prints check.path verbatim. For a WSL folder the server answers with the ref, so the user sees 'wsl://ubuntu/home/u/'. Elsewhere the app's rule is 'Ubuntu: /home/u/app', never a raw ref (files-ui.js:822, AIBWsl.displayPath / tooltip).
3. **Three different chat states read the same word 'Ready' in the chat list** (status-words.js:111 (idle: 'Ready'), :137 (not-running: 'Ready'); chat.js:4752-4790 rowStatus; workspace.css:114 hides .connection-state in the sidebar) Side by side in the sidebar, three rows all show the phrase 'Ready' (600 weight, #a9a497 in teal-dark): a live idle chat, a saved chat that is not running, and a chat recovered after a restart. Only the dot tells them apart: d-idle is a solid ring, d-off is dotted. The '● Ready · Live in AIB' badge (badge-live) is built for live chats but is display:none in the aside, so it never shows there. The header chip also reads 'Ready'. Couldn't reopen reads "Couldn't reopen" with the same dotted d-off dot as a saved chat.
4. **Ubuntu card: the mockup's Linux, AIB folder and actions are missing** (wsl-settings-ui.js:432 (facts: State, AIB helper, Home)) The mockup has 5 facts: State; Linux 'Ubuntu 24.04.4 LTS · x86_64'; AIB helper '… · checked'; AIB folder '~/.aib-server · 1.4 GB'; Home. It also has the buttons 'Open Ubuntu terminal' and 'Repair AIB helper' (design section 4). The page shows 3 facts and no buttons. The test asserts this on purpose (no buttons that would do nothing). The overview tag also drops the Linux version: the mockup reads 'WSL 2 · Ubuntu 24.04.4 · WSL default', the page reads 'WSL 2 · WSL default'. docker-desktop has no 'WSL 2' tag in the page (the mockup has one).
5. **Node.js missing: the mockup's copyable nvm command and 'Open Ubuntu terminal' are not shown before Install** (wsl-settings-ui.js:649 (Install Node.js button) and the node row around it) The mockup row shows a copy row with the pinned command (curl -fsSLo "$t" … sha256sum -c && bash "$t" … nvm install --lts) and three buttons: 'Install Node.js 24 (LTS) in Ubuntu', 'Open Ubuntu terminal', 'Check again'. The page shows two buttons, 'Install Node.js in Ubuntu' and 'Check again'. The command appears only in the terminal panel title once Install runs. Design decision 6 says the command is shown before it starts. Agent rows: the mockup has a 'Needs first:' list (st-beta-needs) with an 'Install Node.js 24 (LTS)' link; the page has the plain line 'Needs Node.js first: see What Ubuntu needs above.'
6. **Usage list sizes are left-aligned and the list spacing differs from the mockup** (wsl-settings-ui.js:1194 (dl 'st-facts wl-usage'); settings.css:1130-1138 has no .wl-usage / .wl-usage dd rule) Mockup .wl-usage dd {text-align: right}; the page computes text-align: start, so '12 MB' and '96 MB' start under '190 MB' instead of lining up on the right. Mockup .wl-usage margin-top 4px and gap 4px 18px; the page has 0px and 6px 18px (inherited from .st-facts, settings.css:430-436).
7. **Teal-light: links and muted lines inside .st-note.dim are below 4.5:1** (settings.css:210-212 (.st-note.dim {opacity: 0.8}); wsl-settings-ui.js .wl-checked / .wl-path; chat.js:3725 dim copy line) Teal-light values: 'Check again' link in 'Checked with' is #3e9089 on #faf9f6 = 3.59:1. New-chat 'Copy' link is #3e8f88 on #f7f4ee = 3.48:1. New-chat 'Or install it yourself in Ubuntu' line is #7c7569 on #f7f4ee = 4.15:1. 'Checked with: …' line and node path are #7c766a on #faf9f6 = 4.28:1. All need 4.5. The 0.8 opacity causes it: without it the same tokens pass. In teal-dark the same elements are 4.71-5.12:1 (pass).

### polish (12)

1. **Partial-failure dialog keeps the question title and shows paths in the text font** (wsl-settings-ui.js:1263 (title never changes), :1369-1372 (Left in / Removed lists), :1133-1134 (card's left list)) After a partial failure the title still reads 'Remove AIB from Ubuntu?' above 'AIB could not remove everything from Ubuntu.'. The 'Left in Ubuntu:' and 'Removed:' paths are 13px Segoe UI in --text. In the check view the same kind of paths are .wl-rm-path: 12px Consolas, --muted (settings.css:1174-1180). After Close, the card repeats the left list in the text font too.
2. **Blocked Remove: the reasons run straight into the list below, and the off button is faint** (settings.css:1189-1191 (.wl-reason margin 0 0 4px), :1186 (.wl-rm-head)) The last reason line ends 4 px above 'Remove would delete (203 MB in all):', with no separation between the refusal and the inventory. The disabled 'Remove AIB from Ubuntu' (opacity 0.5) measures 3.03:1 in teal-dark (#87606c on #1f2028) and 2.34:1 in teal-light. WCAG exempts disabled controls, but it is the dialog's main button. The 'This stops AIB's helper … Nothing is deleted before you confirm.' line stays while removal is blocked.
3. **Failed publish card carries no failure colour; the reason line is brighter than its subtitle and cut to one line** (artifacts.css:533-539 (.art-card-err color var(--text-6), nowrap + ellipsis); artifacts-ui.js:2648-2651; reason text server/artifacts/mcp.ts:763) The card keeps the teal dashed border (#2a7c72) and the teal html badge of a good card. 'The publish did not finish' is 11px #a9a497, and the reason under it is 11px #edeae2 (brighter than the line above). The reason is cut at 560.8 px with '…'; the full text is only on hover. The visible part reads 'In a WSL project, publish by `content`: AIB cannot open files inside the distro. In this WSL project only `content` w…'. That is agent-facing wording, backticks included.
4. **The switch label carries the global label margin (18 px above and below)** (chat.css:156-163 (label {margin: 18px 0; color: var(--label-text)}) applied to .st-toggle (settings.css:303)) Mockup .st-toggle: margin 0, colour #edeae2. Page: margin 18px 0, colour #cac6bb. Each agent row's actions line grows by 36 px (visible gap above 'Use in Ubuntu'). The Windows AIB Linking cards measure the same (identical computed styles), so this is shared with the reference app page, not new in WSL.
5. **'Other AIB data folders' title is larger than everything around it; 'in use' uses the warning colour** (wsl-settings-ui.js:1227 ('st-label wl-others-title'), :1232 ('in use' as st-status warn); settings.css:1148) The title computes to 14px, while the card's notes and lines are 12-13px. The 'in use' chip is the warn tone: #b8381c on #ffe4dc in teal-light, the red of 'Not installed'. It is informational (another build's keeper runs), not a problem. The chip sits at the far right, 900+ px from its folder name.
6. **Distro drop-down options repeat the name, and long names are cut** (wsl-settings-ui.js:346; settings.css:1085-1088 (.wl-pick max-width 360px)) The option reads "docker-desktop (not supported: docker-desktop is Docker's own distro; AIB cannot run there)", naming the distro twice. As a list box it overflows the 360 px select by 189 px. A long distro name ('Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name') is cut in the closed select at every width (700, 900, 1280, 1400). The greyed option is #6d6d6d on #ffffff = 5.17:1 (passes).
7. **WSL 1 row says 'AIB needs WSL 2' twice** (wsl-settings-ui.js:398 plus the skipped reason from the status route) 'Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2.' is followed by 'AIB needs WSL 2. Convert it in PowerShell (takes a few minutes; back it up first):'. The row is 110.9 px tall against the mockup's 92 px.
8. **After Remove: 'State: AIB not set up' repeats the next line** (wsl-settings-ui.js:1120) The facts list shows State 'AIB not set up' (12px Consolas), and the next line is 'AIB is not set up in Ubuntu.'. No line says what was removed or how much space came back; the dialog just closes.
9. **a11y: switches are plain checkboxes, chips are silent, the drop-down's name differs from its label, and the dialog has no description** (settings-ui.js agentRow toggle (shared with Windows); wsl-settings-ui.js:338 (aria-label), :1260-1265 (no aria-describedby)) 'Use in Ubuntu' is <input type=checkbox> with no role=switch, the same as the Windows 'On' switch. Status chips (.st-status) have no role or aria-live, so 'Installing… / Install failed' changes are not announced; the progress bar is correct (role=progressbar, 0/46/100, aria-label). The drop-down's visible label is 'Distro' but its aria-label is 'The distro this page shows', so it fails label-in-name (WCAG 2.5.3). The Remove alertdialog has aria-labelledby but no aria-describedby. Cancel gets focus on open, but programmatic focus draws no ring (no :focus-visible); the delete-project dialog behaves the same.
10. **Uninstall asks with the native window.confirm** (wsl-settings-ui.js:808 (same as Windows settings-ui.js:715)) It cannot be styled or measured: an OS dialog over the app, unlike the in-page Remove and delete-project dialogs. Text: 'Uninstall Claude Code from Ubuntu? This deletes only the copy AIB installed there (~/.aib-server/agents/claude). Your own installs of Claude Code and your sign-in in ~/.claude in Ubuntu stay. To use Claude Code in Ubuntu again, install it again here.'
11. **An agent the page does not know is shown by its raw id** (wsl-settings-ui.js:35 (NAMES), :742 (NAMES[row.id] || [row.id, …]), :1096) With 30 rows from the distro route, all 30 are drawn, and none clip or overflow at 700-1400 px. The 27 unknown ones show 'agent1', 'agent2', …: the row's own name ('Agent number 1') is ignored, and 'Install in Ubuntu' plus the 'One click: AIB installs agent3 1.2.0 …' pitch are offered for them. Today the route sends only claude/codex/omp, so this matters when Beta agents in distros (phase 4) arrive.
12. **Page heading weight differs from the mockup** (chat.css h2 rules (the mockup does not load chat.css)) 'AIB Linking (WSL)' h2: mockup font-weight 700, page 550. The Windows 'AIB Linking' heading is the same 550, so this comes from the mockup frame, not the WSL code.

## A. Settings > AIB Linking (WSL) vs the mockup

### good vs mockup "good" (teal-dark)

Matched exactly (35): card, card title, lead (C1), distro row, distro letter, distro name, distro tag, chip ok (Ready), chip warn, chip dim, group heading, facts dt, facts dd, note (plain), note dim, checks list, check row, check head, check mark ok, check state, agent row, agent head, agent letter, agent name, agent tag, button danger, switch input, command code, copy row, limits line, limits value, usage dt, footer, hint, actions row.

Only in the mockup: button primary ("Install"); button plain ("Open Ubuntu terminal").

| element | property | mockup | page |
| --- | --- | --- | --- |
| button link | lineHeight | normal | 18px |
| button link | display | block | inline-block |
| button link | h | 16 | 18 |
| switch label | color | #edeae2 | #cac6bb |
| switch label | marginTop | 0px | 18px |
| switch label | marginBottom | 0px | 18px |
| switch label | borderTopColor | #edeae2 | #cac6bb |
| switch label | w | 41.2 | 105.9 |
| usage list | marginTop | 4px | 0px |
| usage list | gap | 4px 18px | 6px 18px |
| usage dd | textAlign | right | start |
| page: page heading h2 | fontWeight | 700 | 550 |

### node-missing vs mockup "node" (teal-dark)

Matched exactly (32): card, card title, lead (C1), distro row, distro letter, distro name, distro tag, chip ok (Ready), chip warn, group heading, facts dt, facts dd, note (plain), note dim, checks list, check row, check head, check mark ok, check mark bad, check state, agent row, agent head, agent letter, agent name, button primary (off), button danger, button link, button primary (card), switch input, usage dt, footer, actions row.

Only in the mockup: button primary ("Install"); button plain ("Open Ubuntu terminal"); command code ("curl -fsSLo "$t" https://raw.githubuserc"); copy row ("curl -fsSLo "$t" https://raw.githubuserc"); hint ("Needs first:"); needs first ("Needs first: Node.js 22 or newer: missin").

| element | property | mockup | page |
| --- | --- | --- | --- |
| switch label | color | #edeae2 | #cac6bb |
| switch label | marginTop | 0px | 18px |
| switch label | marginBottom | 0px | 18px |
| switch label | borderTopColor | #edeae2 | #cac6bb |
| switch label | w | 41.2 | 105.9 |
| usage list | marginTop | 4px | 0px |
| usage list | gap | 4px 18px | 6px 18px |
| usage dd | textAlign | right | start |
| page: page heading h2 | fontWeight | 700 | 550 |

### installing vs mockup "installing" (teal-dark)

Matched exactly (33): card, card title, lead (C1), distro row, distro letter, distro name, distro tag, chip ok (Ready), chip warn, group heading, facts dt, facts dd, note (plain), note dim, checks list, check row, check head, check mark ok, check state, agent row, agent head, agent letter, agent name, agent tag, button danger, button cancel, switch input, progress, progress fill, usage dt, footer, hint, actions row.

Only in the mockup: button primary ("Install"); button plain ("Open Ubuntu terminal"); limits line ("Usage limits of Ubuntu's Codex sign-in: "); limits value ("5 h 32% used").

| element | property | mockup | page |
| --- | --- | --- | --- |
| button link | color | #edeae2 | #33bcab |
| button link | backgroundColor | #1f2028 | transparent |
| button link | paddingTop | 6px | 0px |
| button link | paddingRight | 12px | 0px |
| button link | paddingBottom | 6px | 0px |
| button link | paddingLeft | 12px | 0px |
| button link | borderTopWidth | 1px | 0px |
| button link | borderTopStyle | solid | none |
| button link | borderTopColor | #3e3e43 | #33bcab |
| button link | textDecorationLine | none | underline |
| button link | h | 30 | 16 |
| button link | w | 53.3 | 27.3 |
| switch label | color | #edeae2 | #cac6bb |
| switch label | marginTop | 0px | 18px |
| switch label | marginBottom | 0px | 18px |
| switch label | borderTopColor | #edeae2 | #cac6bb |
| switch label | w | 41.2 | 105.9 |
| command code | marginTop | 2px | 6px |
| copy row | fontSize | 14px | 12px |
| copy row | h | 30 | 16 |
| copy row | w | 708 | 704 |
| usage list | marginTop | 4px | 0px |
| usage list | gap | 4px 18px | 6px 18px |
| usage dd | textAlign | right | start |
| page: page heading h2 | fontWeight | 700 | 550 |

### update vs mockup "update" (teal-dark)

Matched exactly (33): card, card title, lead (C1), distro row, distro letter, distro name, distro tag, chip ok (Ready), chip warn, group heading, facts dt, facts dd, note (plain), note dim, checks list, check row, check head, check mark ok, check state, agent row, agent head, agent letter, agent name, agent tag, button primary, button danger, switch input, command code, copy row, usage dt, footer, hint, actions row.

Only in the mockup: button plain ("Open Ubuntu terminal").

| element | property | mockup | page |
| --- | --- | --- | --- |
| button link | lineHeight | normal | 18px |
| button link | display | block | inline-block |
| button link | h | 16 | 18 |
| switch label | color | #edeae2 | #cac6bb |
| switch label | marginTop | 0px | 18px |
| switch label | marginBottom | 0px | 18px |
| switch label | borderTopColor | #edeae2 | #cac6bb |
| switch label | w | 41.2 | 105.9 |
| usage list | marginTop | 4px | 0px |
| usage list | gap | 4px 18px | 6px 18px |
| usage dd | textAlign | right | start |
| page: page heading h2 | fontWeight | 700 | 550 |

### error vs mockup "error" (teal-dark)

Matched exactly (37): card, card title, lead (C1), distro row, distro letter, distro name, distro tag, chip ok (Ready), chip warn, group heading, facts dt, facts dd, note (plain), note dim, note bad, checks list, check row, check head, check mark ok, check mark bad, check state, agent row, agent head, agent letter, agent name, agent tag, button primary, button danger, button link, button plain, switch input, command code, copy row, usage dt, footer, hint, actions row.

Only in the page: chip bad ("Install failed").

| element | property | mockup | page |
| --- | --- | --- | --- |
| switch label | color | #edeae2 | #cac6bb |
| switch label | marginTop | 0px | 18px |
| switch label | marginBottom | 0px | 18px |
| switch label | borderTopColor | #edeae2 | #cac6bb |
| switch label | w | 41.2 | 105.9 |
| usage list | marginTop | 4px | 0px |
| usage list | gap | 4px 18px | 6px 18px |
| usage dd | textAlign | right | start |
| page: page heading h2 | fontWeight | 700 | 550 |

### stopped vs mockup "stopped" (teal-dark)

Matched exactly (15): card, card title, lead (C1), distro row, distro letter, distro name, distro tag, chip bad, group heading, facts dt, facts dd, note (plain), note bad, button primary (card), actions row.

| element | property | mockup | page |
| --- | --- | --- | --- |
| page: page heading h2 | fontWeight | 700 | 550 |

### nowsl vs mockup "nowsl" (teal-dark)

Matched exactly (7): card, card title, note (plain), button link, command code, copy row, actions row.

| element | property | mockup | page |
| --- | --- | --- | --- |
| page: page heading h2 | fontWeight | 700 | 550 |

### two vs mockup "two" (teal-dark)

Matched exactly (31): card, card title, lead (C1), distro letter, distro name, distro tag, chip ok (Ready), chip warn, chip dim, group heading, facts dt, facts dd, note (plain), note dim, checks list, check row, check head, check mark ok, check state, agent row, agent head, agent letter, agent name, agent tag, button danger, switch input, copy row, usage dt, footer, hint, actions row.

Only in the mockup: button primary ("Install"); button plain ("Open Ubuntu terminal"); button primary (card) ("Start Debian and check"); limits line ("Usage limits of Ubuntu's Codex sign-in: "); limits value ("5 h 32% used").

| element | property | mockup | page |
| --- | --- | --- | --- |
| distro row | h | 92 | 110.9 |
| button link | lineHeight | normal | 18px |
| button link | display | block | inline-block |
| button link | h | 16 | 18 |
| switch label | color | #edeae2 | #cac6bb |
| switch label | marginTop | 0px | 18px |
| switch label | marginBottom | 0px | 18px |
| switch label | borderTopColor | #edeae2 | #cac6bb |
| switch label | w | 41.2 | 105.9 |
| command code | marginTop | 6px | 2px |
| usage list | marginTop | 4px | 0px |
| usage list | gap | 4px 18px | 6px 18px |
| usage dd | textAlign | right | start |
| page: page heading h2 | fontWeight | 700 | 550 |

The mockup embeds only the teal-dark theme (its copy of theme.css has no teal-light block), so teal-light is compared with the app's own Windows AIB Linking cards below.

### Agents card vs Windows AIB Linking (teal-dark)

Identical: card, card title, agent row, agent head, agent letter, agent name, agent tag, chip ok (Ready), chip warn, switch input, command code, hint, actions row.

| element | property | Windows | WSL page |
| --- | --- | --- | --- |
| switch label | w | 41.2 (On) | 105.9 (Use in Ubuntu) |

### Agents card vs Windows AIB Linking (teal-light)

Identical: card, card title, agent row, agent head, agent letter, agent name, agent tag, chip ok (Ready), chip warn, switch input, command code, hint, actions row.

| element | property | Windows | WSL page |
| --- | --- | --- | --- |
| switch label | w | 41.2 (On) | 105.9 (Use in Ubuntu) |

### Remove dialog vs the delete-project dialog (teal-dark)

Identical: dialog, dialog title, dialog main, dialog cancel, dialog tick, dialog warn.

| element | property | delete-project | Remove AIB |
| --- | --- | --- | --- |
| dialog yes | opacity | 1 | 0.5 |

### Remove dialog vs the delete-project dialog (teal-light)

Identical: dialog, dialog title, dialog main, dialog cancel, dialog tick, dialog warn.

| element | property | delete-project | Remove AIB |
| --- | --- | --- | --- |
| dialog yes | opacity | 1 | 0.5 |

### States the mockup does not cover: key measurements (teal-dark)

| state | element | font | colour | bg | padding | radius | h x w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rm-check | dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 16px 18px 16px 18px | 10px | 446.1 x 460 |
| rm-check | dialog title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 20 x 422 |
| rm-check | dialog main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-check | dialog list head | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-check | dialog item line | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 17 x 422 |
| rm-check | dialog size | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 33.9 |
| rm-check | dialog path | 12px 400 Consolas lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 14 x 422 |
| rm-check | dialog why | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 422 |
| rm-check | dialog yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 5px 10px 5px 10px | 6px | 28 x 157.2 |
| rm-check | dialog cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 57.1 |
| rm-check | scrim | 14px 400 "Segoe UI" lh normal | #edeae2 | #000000 @67% | 0px 0px 0px 0px | 0px | 860 x 1280 |
| rm-blocked | dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 16px 18px 16px 18px | 10px | 558.3 x 460 |
| rm-blocked | dialog title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 20 x 422 |
| rm-blocked | dialog main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-blocked | dialog list head | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-blocked | dialog item line | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 17 x 422 |
| rm-blocked | dialog size | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 33.9 |
| rm-blocked | dialog path | 12px 400 Consolas lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 14 x 422 |
| rm-blocked | dialog why | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 422 |
| rm-blocked | dialog reason | 13px 400 "Segoe UI" lh 18.85px | #f09998 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-blocked | dialog warn | 13px 400 "Segoe UI" lh 18.85px | #f09998 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-blocked | dialog yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 5px 10px 5px 10px | 6px | 28 x 157.2 |
| rm-blocked | dialog cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 50.7 |
| rm-blocked | dialog check again | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 86.3 |
| rm-blocked | scrim | 14px 400 "Segoe UI" lh normal | #edeae2 | #000000 @67% | 0px 0px 0px 0px | 0px | 860 x 1280 |
| rm-second | dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 16px 18px 16px 18px | 10px | 493.8 x 460 |
| rm-second | dialog title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 20 x 422 |
| rm-second | dialog main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-second | dialog list head | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-second | dialog item line | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 17 x 422 |
| rm-second | dialog size | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 33.9 |
| rm-second | dialog path | 12px 400 Consolas lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 14 x 422 |
| rm-second | dialog why | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 422 |
| rm-second | dialog warn | 13px 400 "Segoe UI" lh 18.85px | #f09998 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-second | dialog yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 5px 10px 5px 10px | 6px | 28 x 157.2 |
| rm-second | dialog cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 57.1 |
| rm-second | scrim | 14px 400 "Segoe UI" lh normal | #edeae2 | #000000 @67% | 0px 0px 0px 0px | 0px | 860 x 1280 |
| rm-tick | dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 16px 18px 16px 18px | 10px | 473.1 x 460 |
| rm-tick | dialog title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 20 x 422 |
| rm-tick | dialog main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-tick | dialog list head | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-tick | dialog item line | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 17 x 422 |
| rm-tick | dialog size | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 33.9 |
| rm-tick | dialog path | 12px 400 Consolas lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 14 x 422 |
| rm-tick | dialog why | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 422 |
| rm-tick | dialog tick | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 17 x 422 |
| rm-tick | dialog yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 5px 10px 5px 10px | 6px | 28 x 157.2 |
| rm-tick | dialog cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 57.1 |
| rm-tick | scrim | 14px 400 "Segoe UI" lh normal | #edeae2 | #000000 @67% | 0px 0px 0px 0px | 0px | 860 x 1280 |
| rm-removing | dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 16px 18px 16px 18px | 10px | 446.1 x 460 |
| rm-removing | dialog title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 20 x 422 |
| rm-removing | dialog main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-removing | dialog list head | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-removing | dialog item line | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 17 x 422 |
| rm-removing | dialog size | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 33.9 |
| rm-removing | dialog path | 12px 400 Consolas lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 14 x 422 |
| rm-removing | dialog why | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 422 |
| rm-removing | dialog yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 5px 10px 5px 10px | 6px | 28 x 83.8 |
| rm-removing | dialog cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 57.1 |
| rm-removing | scrim | 14px 400 "Segoe UI" lh normal | #edeae2 | #000000 @67% | 0px 0px 0px 0px | 0px | 860 x 1280 |
| rm-partial | dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 16px 18px 16px 18px | 10px | 340.9 x 460 |
| rm-partial | dialog title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 20 x 422 |
| rm-partial | dialog main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-partial | dialog list head | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-partial | dialog cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 50.7 |
| rm-partial | scrim | 14px 400 "Segoe UI" lh normal | #edeae2 | #000000 @67% | 0px 0px 0px 0px | 0px | 860 x 1280 |
| rm-long | dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 16px 18px 16px 18px | 10px | 602 x 460 |
| rm-long | dialog title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 20 x 422 |
| rm-long | dialog main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| rm-long | dialog list head | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-long | dialog item line | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px 0px 0px 0px | 0px | 17 x 422 |
| rm-long | dialog size | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 33.9 |
| rm-long | dialog path | 12px 400 Consolas lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 14 x 422 |
| rm-long | dialog why | 12px 400 "Segoe UI" lh normal | #a9a497 | transparent | 0px 0px 0px 0px | 0px | 16 x 422 |
| rm-long | dialog reason | 13px 400 "Segoe UI" lh 18.85px | #f09998 | transparent | 0px 0px 0px 0px | 0px | 56.5 x 422 |
| rm-long | dialog warn | 13px 400 "Segoe UI" lh 18.85px | #f09998 | transparent | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| rm-long | dialog yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 5px 10px 5px 10px | 6px | 28 x 157.2 |
| rm-long | dialog cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 50.7 |
| rm-long | dialog check again | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 5px 10px 5px 10px | 6px | 28 x 86.3 |
| rm-long | scrim | 14px 400 "Segoe UI" lh normal | #edeae2 | #000000 @67% | 0px 0px 0px 0px | 0px | 860 x 1280 |

## B. Other screens: key measurements (teal-dark)

| screen | element | font | colour | bg | border | padding | radius | h x w |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| state-starting | state line | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | #2a241c | 1px solid #5d4925 | 8px 12px 8px 12px | 8px | 36.8 x 746 |
| state-starting | state line text | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | transparent | 0px none #f0d9a0 | 0px 0px 0px 0px | 0px | 18.8 x 720 |
| state-setup | state line | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | #2a241c | 1px solid #5d4925 | 8px 12px 8px 12px | 8px | 36.8 x 746 |
| state-setup | state line text | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | transparent | 0px none #f0d9a0 | 0px 0px 0px 0px | 0px | 18.8 x 720 |
| state-stopped | state line | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | #2a241c | 1px solid #5d4925 | 8px 12px 8px 12px | 8px | 36.8 x 746 |
| state-stopped | state line text | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | transparent | 0px none #f0d9a0 | 0px 0px 0px 0px | 0px | 18.8 x 642.3 |
| state-stopped | state line button | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | transparent | 0px none #f0d9a0 | 0px 4px 0px 4px | 6px | 18.8 x 67.8 |
| open-url | open bar | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | #2a241c | 1px solid #5d4925 | 8px 12px 8px 12px | 8px | 93.4 x 746 |
| open-url | open bar text | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | transparent | 0px none #f0d9a0 | 0px 0px 0px 0px | 0px | 75.4 x 430.7 |
| open-url | open bar button | 13px 400 "Segoe UI" lh 18.85px | #f0d9a0 | transparent | 0px none #f0d9a0 | 0px 4px 0px 4px | 6px | 18.8 x 39.6 |
| np-wsl | np dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #40414b | 18px 20px 18px 20px | 10px | 501 x 480 |
| np-wsl | np location | 13px 400 "Segoe UI" lh normal | #edeae2 | #16171d | 1px solid #2c2d36 | 0px 8px 0px 8px | 6px | 32 x 438 |
| np-wsl | np folder input | 13px 400 "Segoe UI" lh normal | #edeae2 | #16171d | 1px solid #2c2d36 | 0px 8px 0px 8px | 6px | 32 x 233.1 |
| np-wsl | np browse wsl | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #3e3e43 | 0px 12px 0px 12px | 6px | 32 x 116 |
| np-browse | np dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #40414b | 18px 20px 18px 20px | 10px | 672 x 480 |
| np-browse | np location | 13px 400 "Segoe UI" lh normal | #edeae2 | #16171d | 1px solid #2c2d36 | 0px 8px 0px 8px | 6px | 32 x 438 |
| np-browse | np folder input | 13px 400 "Segoe UI" lh normal | #edeae2 | #16171d | 1px solid #2c2d36 | 0px 8px 0px 8px | 6px | 32 x 233.1 |
| np-browse | np browse wsl | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #3e3e43 | 0px 12px 0px 12px | 6px | 32 x 116 |
| np-browse | np dirs | 14px 400 "Segoe UI" lh normal | #edeae2 | #16171d | 1px solid #2c2d36 | 6px 6px 6px 6px | 6px | 165 x 438 |
| np-browse | np dir row | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 3px 6px 3px 6px | 4px | 23 x 424 |
| np-browse | np dirs here | 12px 400 "Segoe UI" lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 18 x 313.8 |
| del-wsl | dp dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #40414b | 16px 18px 16px 18px | 10px | 193.5 x 460 |
| del-wsl | dp title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 20 x 422 |
| del-wsl | dp main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| del-wsl | dp cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #3e3e43 | 5px 10px 5px 10px | 6px | 28 x 57.1 |
| del-wsl | dp running | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| del-wsl | dp tick row | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 17 x 422 |
| del-wsl | dp tick input | 13px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 13 x 13 |
| del-wsl | dp yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 1px solid #8f3b4d | 5px 10px 5px 10px | 6px | 28 x 114.2 |
| del-wsl-ticked | dp dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #40414b | 16px 18px 16px 18px | 10px | 222.4 x 460 |
| del-wsl-ticked | dp title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 20 x 422 |
| del-wsl-ticked | dp main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| del-wsl-ticked | dp cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #3e3e43 | 5px 10px 5px 10px | 6px | 28 x 57.1 |
| del-wsl-ticked | dp running | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| del-wsl-ticked | dp tick row | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 17 x 422 |
| del-wsl-ticked | dp tick input | 13px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 13 x 13 |
| del-wsl-ticked | dp warn | 13px 400 "Segoe UI" lh 18.85px | #f09998 | transparent | 0px none #f09998 | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| del-wsl-ticked | dp yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 1px solid #8f3b4d | 5px 10px 5px 10px | 6px | 28 x 198.8 |
| del-wsl-refused | dp dialog | 14px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #40414b | 16px 18px 16px 18px | 10px | 241.2 x 460 |
| del-wsl-refused | dp title | 15px 600 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 20 x 422 |
| del-wsl-refused | dp main | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| del-wsl-refused | dp cancel | 12px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 1px solid #3e3e43 | 5px 10px 5px 10px | 6px | 28 x 57.1 |
| del-wsl-refused | dp running | 13px 400 "Segoe UI" lh 18.85px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 18.8 x 422 |
| del-wsl-refused | dp tick row | 13px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 17 x 422 |
| del-wsl-refused | dp tick input | 13px 400 "Segoe UI" lh normal | #edeae2 | #1f2028 | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 13 x 13 |
| del-wsl-refused | dp note | 13px 400 "Segoe UI" lh 18.85px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 37.7 x 422 |
| del-wsl-refused | dp yes | 12px 400 "Segoe UI" lh normal | #f0a0b0 | transparent | 1px solid #8f3b4d | 5px 10px 5px 10px | 6px | 28 x 114.2 |
| nc-missing | nc box | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 123 x 728 |
| nc-missing | nc line bad | 12px 400 "Segoe UI" lh 18px | #efa3a1 | transparent | 0px none #efa3a1 | 0px 0px 0px 0px | 0px | 18 x 728 |
| nc-missing | nc line | 12px 400 "Segoe UI" lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 19 x 728 |
| nc-missing | nc link | 12px 400 "Segoe UI" lh 18px | #33bcab | transparent | 0px none #33bcab | 0px 0px 0px 0px | 6px | 18 x 27.3 |
| nc-missing | nc cmd | 12px 400 monospace lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 14 x 303.5 |
| nc-missing | nc grid (form) | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 172 x 380 |
| nc-missing | nc folder | 11px 400 "Segoe UI" lh 15.4px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 15.4 x 380 |
| nc-missing | nc agent select | 12px 400 "Segoe UI" lh normal | #edeae2 | #23242c | 1px solid #3e3e43 | 0px 8px 0px 8px | 6px | 30 x 310 |
| nc-node | nc box | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 191 x 728 |
| nc-node | nc line bad | 12px 400 "Segoe UI" lh 18px | #efa3a1 | transparent | 0px none #efa3a1 | 0px 0px 0px 0px | 0px | 18 x 728 |
| nc-node | nc line | 12px 400 "Segoe UI" lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 19 x 728 |
| nc-node | nc link | 12px 400 "Segoe UI" lh 18px | #33bcab | transparent | 0px none #33bcab | 0px 0px 0px 0px | 6px | 18 x 27.3 |
| nc-node | nc cmd | 12px 400 monospace lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 33 x 716.8 |
| nc-node | nc grid (form) | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 172 x 380 |
| nc-node | nc folder | 11px 400 "Segoe UI" lh 15.4px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 15.4 x 380 |
| nc-node | nc agent select | 12px 400 "Segoe UI" lh normal | #edeae2 | #23242c | 1px solid #3e3e43 | 0px 8px 0px 8px | 6px | 30 x 310 |
| nc-installing | nc box | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 143 x 728 |
| nc-installing | nc line bad | 12px 400 "Segoe UI" lh 18px | #efa3a1 | transparent | 0px none #efa3a1 | 0px 0px 0px 0px | 0px | 18 x 728 |
| nc-installing | nc line | 12px 400 "Segoe UI" lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 19 x 728 |
| nc-installing | nc link | 12px 400 "Segoe UI" lh 18px | #33bcab | transparent | 0px none #33bcab | 0px 0px 0px 0px | 6px | 18 x 35.1 |
| nc-installing | nc cmd | 12px 400 monospace lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 14 x 257.3 |
| nc-installing | nc progress | 14px 400 "Segoe UI" lh normal | #edeae2 | #272830 | 0px none #edeae2 | 0px 0px 0px 0px | 3px | 6 x 728 |
| nc-installing | nc grid (form) | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 172 x 380 |
| nc-installing | nc folder | 11px 400 "Segoe UI" lh 15.4px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 15.4 x 380 |
| nc-installing | nc agent select | 12px 400 "Segoe UI" lh normal | #edeae2 | #23242c | 1px solid #3e3e43 | 0px 8px 0px 8px | 6px | 30 x 310 |
| nc-found | nc box | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 54 x 728 |
| nc-found | nc line | 12px 400 "Segoe UI" lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 18 x 728 |
| nc-found | nc link | 12px 400 "Segoe UI" lh 18px | #33bcab | transparent | 0px none #33bcab | 0px 0px 0px 0px | 6px | 18 x 36.1 |
| nc-found | nc grid (form) | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 172 x 380 |
| nc-found | nc folder | 11px 400 "Segoe UI" lh 15.4px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 15.4 x 380 |
| nc-found | nc agent select | 12px 400 "Segoe UI" lh normal | #edeae2 | #23242c | 1px solid #3e3e43 | 0px 8px 0px 8px | 6px | 30 x 310 |
| nc-update | nc box | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 122 x 728 |
| nc-update | nc line | 12px 400 "Segoe UI" lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 18 x 728 |
| nc-update | nc link | 12px 400 "Segoe UI" lh 18px | #33bcab | transparent | 0px none #33bcab | 0px 0px 0px 0px | 6px | 18 x 36.1 |
| nc-update | nc grid (form) | 14px 400 "Segoe UI" lh normal | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 172 x 380 |
| nc-update | nc folder | 11px 400 "Segoe UI" lh 15.4px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 15.4 x 380 |
| nc-update | nc agent select | 12px 400 "Segoe UI" lh normal | #edeae2 | #23242c | 1px solid #3e3e43 | 0px 8px 0px 8px | 6px | 30 x 310 |
| status-words | row phrase | 12px 600 "Segoe UI" lh 18px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 18 x 33.1 |
| project-menu | distro chip | 11px 600 "Segoe UI" lh 16px | #a9a497 | #23242c | 1px solid #2c2d36 | 0px 7px 0px 7px | 12px | 18 x 51.4 |
| publish-failed | art card | 12px 400 "Segoe UI" lh 17.4px | #edeae2 | #191a21 | 1px dashed #2a7c72 | 8px 10px 8px 10px | 12px | 67.3 x 680 |
| publish-failed | art card title | 12px 600 "Segoe UI" lh 17.4px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 17.4 x 560.8 |
| publish-failed | art card sub | 11px 400 "Segoe UI" lh 15.95px | #a9a497 | transparent | 0px none #a9a497 | 0px 0px 0px 0px | 0px | 15.9 x 560.8 |
| publish-failed | art card err | 11px 400 "Segoe UI" lh 15.95px | #edeae2 | transparent | 0px none #edeae2 | 0px 0px 0px 0px | 0px | 15.9 x 560.8 |

## C. Contrast (WCAG 2 ratio; target 4.5 text, 3 large text)

| theme | state | element | text | fg | bg | ratio | target | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| teal-light | rm-blocked | dialog destructive button, off | Remove AIB from Ubuntu | #d79a97 | #ffffff | 2.34 | 4.5 | **NO** |
| teal-dark | rm-blocked | dialog destructive button, off | Remove AIB from Ubuntu | #87606c | #1f2028 | 3.03 | 4.5 | **NO** |
| teal-light | nc-missing | new chat: link | Copy | #3e8f88 | #f7f4ee | 3.48 | 4.5 | **NO** |
| teal-light | good | button link (Check again, Copy) | Check again | #3e9089 | #faf9f6 | 3.59 | 4.5 | **NO** |
| teal-light | nc-missing | new chat: dim copy line | Or install it yourself in Ubuntu: npm i -g @agentc | #7c7569 | #f7f4ee | 4.15 | 4.5 | **NO** |
| teal-light | good | node path (.wl-path) | /home/u/.nvm/versions/node/v24.11.1/bin/node | #7c766a | #faf9f6 | 4.28 | 4.5 | **NO** |
| teal-light | good | Checked with line | Checked with: zsh login shell (interactive). Check | #7c766a | #faf9f6 | 4.28 | 4.5 | **NO** |
| teal-light | node-missing | muted note (.st-note.dim) | Checked with: zsh login shell (interactive). Check | #7c766a | #faf9f6 | 4.28 | 4.5 | **NO** |
| teal-light | good | muted note (.st-note.dim) | docker-desktop is Docker's own distro; AIB cannot  | #7d776c | #ffffff | 4.44 | 4.5 | **NO** |
| teal-light | good | agent letter | U | #0f766e | #dcefea | 4.58 | 4.5 | yes |
| teal-dark | good | muted note (.st-note.dim) | docker-desktop is Docker's own distro; AIB cannot  | #8d8980 | #1e1f26 | 4.71 | 4.5 | yes |
| teal-light | good | chip Not signed in / Not installed (warn) | in use | #b8381c | #ffe4dc | 4.8 | 4.5 | yes |
| teal-light | good | in use chip | in use | #b8381c | #ffe4dc | 4.8 | 4.5 | yes |
| teal-dark | good | node path (.wl-path) | /home/u/.nvm/versions/node/v24.11.1/bin/node | #8c887f | #191a21 | 4.91 | 4.5 | yes |
| teal-dark | good | Checked with line | Checked with: zsh login shell (interactive). Check | #8c887f | #191a21 | 4.91 | 4.5 | yes |
| teal-dark | node-missing | muted note (.st-note.dim) | Checked with: zsh login shell (interactive). Check | #8c887f | #191a21 | 4.91 | 4.5 | yes |
| teal-light | good | chip Ready / Signed in (ok) | Ready | #08706a | #ddf1ec | 5.05 | 4.5 | yes |
| teal-dark | nc-missing | new chat: dim copy line | Or install it yourself in Ubuntu: npm i -g @agentc | #8a867d | #121318 | 5.11 | 4.5 | yes |
| teal-dark | good | button link (Check again, Copy) | Check again | #2e9b8f | #191a21 | 5.12 | 4.5 | yes |
| teal-light | two | drop-down disabled option (list box) | docker-desktop (not supported: docker-desktop is D | #6d6d6d | #ffffff | 5.17 | 4.5 | yes |
| teal-dark | nc-missing | new chat: link | Copy | #2c998d | #121318 | 5.34 | 4.5 | yes |
| teal-dark | good | chip Ready / Signed in (ok) | Ready | #2bb3a3 | #12302c | 5.44 | 4.5 | yes |
| teal-light | error | button primary | Retry | #ffffff | #0f766e | 5.47 | 4.5 | yes |
| teal-light | two | button link (Check again, Copy) | Copy | #0f766e | #ffffff | 5.47 | 4.5 | yes |
| teal-light | good | check state found (ok) | found 24.11.1 (nvm) | #08706a | #faf9f6 | 5.64 | 4.5 | yes |
| teal-dark | good | chip Not signed in / Not installed (warn) | in use | #ff7a59 | #3d1f18 | 5.81 | 4.5 | yes |
| teal-dark | good | in use chip | in use | #ff7a59 | #3d1f18 | 5.81 | 4.5 | yes |
| teal-dark | good | agent letter | U | #33bcab | #16302d | 5.97 | 4.5 | yes |
| teal-light | rm-check | dialog destructive button (dp-ok) | Remove AIB from Ubuntu | #b0352f | #ffffff | 6.18 | 4.5 | yes |
| teal-light | del-wsl-ticked | delete: destructive button | Remove and move folder to trash | #b0352f | #ffffff | 6.18 | 4.5 | yes |
| teal-dark | project-menu | distro chip | Debian | #a9a497 | #23242c | 6.21 | 4.5 | yes |
| teal-dark | rm-check | dialog path (.wl-rm-path) | /home/u/.aib-server/data-1a2b3c4d | #a9a497 | #1f2028 | 6.52 | 4.5 | yes |
| teal-dark | rm-check | dialog why (.wl-rm-why) | Another AIB data folder (data-9f8e7d6c) is in use: | #a9a497 | #1f2028 | 6.52 | 4.5 | yes |
| teal-dark | del-wsl-refused | delete: tick label | Move folder to trash in Ubuntu | #a9a497 | #1f2028 | 6.52 | 4.5 | yes |
| teal-dark | del-wsl-refused | delete: tick label, off | Move folder to trash in Ubuntu | #a9a497 | #1f2028 | 6.52 | 4.5 | yes |
| teal-dark | del-wsl-refused | delete: note | Deleting the folder is not possible: This distro h | #a9a497 | #1f2028 | 6.52 | 4.5 | yes |
| teal-dark | error | button primary | Retry | #0b1f1d | #2bb3a3 | 6.58 | 4.5 | yes |
| teal-dark | good | tag (Installed by AIB, WSL 2 · WSL default) | WSL 2 · WSL default | #a9a497 | #1e1f26 | 6.6 | 4.5 | yes |
| teal-dark | good | limits line | Usage limits of Ubuntu's Codex sign-in: 5h 32% · w | #a9a497 | #1e1f26 | 6.6 | 4.5 | yes |
| teal-dark | good | hint | Version | #a9a497 | #1e1f26 | 6.6 | 4.5 | yes |
| teal-dark | good | check state found (ok) | found 24.11.1 (nvm) | #2bb3a3 | #191a21 | 6.67 | 4.5 | yes |
| teal-light | publish-failed | publish card sub | The publish did not finish | #5c5547 | #f6f3ee | 6.67 | 4.5 | yes |
| teal-light | good | group heading | UBUNTU | #5c5547 | #f7f4ee | 6.72 | 4.5 | yes |
| teal-dark | node-missing | button primary, off | Install in Ubuntu | #8fd9cf | #1f423d | 6.82 | 4.5 | yes |
| teal-dark | status-words | row phrase | Ready | #a9a497 | #1b1c23 | 6.83 | 4.5 | yes |
| teal-light | np-browse | folder list here | Ubuntu: /home/u | #5c5547 | #faf8f3 | 6.95 | 4.5 | yes |
| teal-dark | good | note | Run Claude Code, Codex and the other ACP agents in | #a9a497 | #191a21 | 6.97 | 4.5 | yes |
| teal-dark | good | usage dt | AIB programs (keeper, helper) | #a9a497 | #191a21 | 6.97 | 4.5 | yes |
| teal-dark | good | size (.wl-size) | 40 MB | #a9a497 | #191a21 | 6.97 | 4.5 | yes |
| teal-dark | good | facts dt | State | #a9a497 | #191a21 | 6.97 | 4.5 | yes |
| teal-dark | two | button link (Check again, Copy) | Copy | #33bcab | #1e1f26 | 6.97 | 4.5 | yes |
| teal-dark | publish-failed | publish card sub | The publish did not finish | #a9a497 | #191a21 | 6.97 | 4.5 | yes |
| teal-dark | two | drop-down disabled option (list box) | docker-desktop (not supported: docker-desktop is D | #aaaaaa | #1f2028 | 6.98 | 4.5 | yes |
| teal-light | good | note | Run Claude Code, Codex and the other ACP agents in | #5c5547 | #faf9f6 | 7.01 | 4.5 | yes |
| teal-light | good | usage dt | AIB programs (keeper, helper) | #5c5547 | #faf9f6 | 7.01 | 4.5 | yes |
| teal-light | good | size (.wl-size) | 40 MB | #5c5547 | #faf9f6 | 7.01 | 4.5 | yes |
| teal-light | good | facts dt | State | #5c5547 | #faf9f6 | 7.01 | 4.5 | yes |
| teal-dark | np-browse | folder list here | Ubuntu: /home/u | #a9a497 | #16171d | 7.19 | 4.5 | yes |
| teal-light | good | tag (Installed by AIB, WSL 2 · WSL default) | WSL 2 · WSL default | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | good | limits line | Usage limits of Ubuntu's Codex sign-in: 5h 32% · w | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | good | hint | Version | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | rm-check | dialog path (.wl-rm-path) | /home/u/.aib-server/data-1a2b3c4d | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | rm-check | dialog why (.wl-rm-why) | Another AIB data folder (data-9f8e7d6c) is in use: | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | del-wsl-refused | delete: tick label | Move folder to trash in Ubuntu | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | del-wsl-refused | delete: tick label, off | Move folder to trash in Ubuntu | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | del-wsl-refused | delete: note | Deleting the folder is not possible: This distro h | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | status-words | row phrase | Ready | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-light | project-menu | distro chip | Debian | #5c5547 | #ffffff | 7.38 | 4.5 | yes |
| teal-dark | good | group heading | UBUNTU | #a9a497 | #121318 | 7.46 | 4.5 | yes |
| teal-dark | rm-blocked | dialog warn | AIB cannot be removed from Ubuntu now: | #f09998 | #1f2028 | 7.5 | 4.5 | yes |
| teal-dark | rm-blocked | dialog reason | A WSL chat is working in Ubuntu (app · Fix login). | #f09998 | #1f2028 | 7.5 | 4.5 | yes |
| teal-dark | del-wsl-ticked | delete: warn | This moves the folder Ubuntu: /home/u/app and ever | #f09998 | #1f2028 | 7.5 | 4.5 | yes |
| teal-light | good | chip Not running / Not supported (dim) | Not supported | #4a4740 | #ece9e2 | 7.64 | 4.5 | yes |
| teal-dark | rm-check | dialog destructive button (dp-ok) | Remove AIB from Ubuntu | #f0a0b0 | #1f2028 | 8 | 4.5 | yes |
| teal-dark | del-wsl-ticked | delete: destructive button | Remove and move folder to trash | #f0a0b0 | #1f2028 | 8 | 4.5 | yes |
| teal-dark | good | button danger (Uninstall / Remove AIB) | Uninstall | #efa3a1 | #1f2028 | 8.05 | 4.5 | yes |
| teal-dark | error | chip Stopped / Install failed (bad) | Install failed | #efa3a1 | #1e1f26 | 8.15 | 4.5 | yes |
| teal-dark | error | bad note (.st-note.bad) | The install failed: npm could not reach registry.n | #efa3a1 | #1e1f26 | 8.15 | 4.5 | yes |
| teal-light | node-missing | button primary, off | Install in Ubuntu | #124a49 | #dcefea | 8.36 | 4.5 | yes |
| teal-light | rm-blocked | dialog warn | AIB cannot be removed from Ubuntu now: | #912223 | #ffffff | 8.55 | 4.5 | yes |
| teal-light | rm-blocked | dialog reason | A WSL chat is working in Ubuntu (app · Fix login). | #912223 | #ffffff | 8.55 | 4.5 | yes |
| teal-light | del-wsl-ticked | delete: warn | This moves the folder Ubuntu: /home/u/app and ever | #912223 | #ffffff | 8.55 | 4.5 | yes |
| teal-dark | node-missing | check state missing (bad) | missing | #efa3a1 | #191a21 | 8.61 | 4.5 | yes |
| teal-dark | node-missing | check mark bad | ! | #efa3a1 | #191a21 | 8.61 | 4.5 | yes |
| teal-dark | stopped | bad note (.st-note.bad) | Ubuntu stopped (Windows restart or wsl --shutdown) | #efa3a1 | #191a21 | 8.61 | 4.5 | yes |
| teal-dark | good | chip Not running / Not supported (dim) | Not supported | #c9c5bb | #26272f | 8.62 | 4.5 | yes |
| teal-light | nc-missing | new chat: not installed line | Claude Code is not installed in Ubuntu. | #822022 | #f7f4ee | 8.78 | 4.5 | yes |
| teal-light | node-missing | check state missing (bad) | missing | #822022 | #faf9f6 | 9.15 | 4.5 | yes |
| teal-light | node-missing | check mark bad | ! | #822022 | #faf9f6 | 9.15 | 4.5 | yes |
| teal-light | stopped | bad note (.st-note.bad) | Ubuntu stopped (Windows restart or wsl --shutdown) | #822022 | #faf9f6 | 9.15 | 4.5 | yes |
| teal-dark | nc-missing | new chat: not installed line | Claude Code is not installed in Ubuntu. | #efa3a1 | #121318 | 9.21 | 4.5 | yes |
| teal-light | state-stopped | state/open line text | Ubuntu stopped. | #473210 | #ebe3d4 | 9.51 | 4.5 | yes |
| teal-light | state-stopped | state/open line button | Reconnect | #473210 | #ebe3d4 | 9.51 | 4.5 | yes |
| teal-dark | good | switch label | Use in Ubuntu | #cac6bb | #1e1f26 | 9.62 | 4.5 | yes |
| teal-light | good | button danger (Uninstall / Remove AIB) | Uninstall | #822022 | #ffffff | 9.64 | 4.5 | yes |
| teal-light | error | chip Stopped / Install failed (bad) | Install failed | #822022 | #ffffff | 9.64 | 4.5 | yes |
| teal-light | error | bad note (.st-note.bad) | The install failed: npm could not reach registry.n | #822022 | #ffffff | 9.64 | 4.5 | yes |
| teal-dark | state-stopped | state/open line text | Ubuntu stopped. | #f0d9a0 | #2a241c | 11.07 | 4.5 | yes |
| teal-dark | state-stopped | state/open line button | Reconnect | #f0d9a0 | #2a241c | 11.07 | 4.5 | yes |
| teal-light | good | switch label | Use in Ubuntu | #3a3632 | #ffffff | 11.98 | 4.5 | yes |
| teal-dark | good | drop-down | Ubuntu (WSL default) docker-desktop (not supported | #edeae2 | #1f2028 | 13.48 | 4.5 | yes |
| teal-dark | node-missing | button link (Check again, Copy) | Check again | #edeae2 | #1f2028 | 13.48 | 4.5 | yes |
| teal-dark | del-wsl-ticked | delete: tick label | Move folder to trash in Ubuntu | #edeae2 | #1f2028 | 13.48 | 4.5 | yes |
| teal-dark | good | limits value | 5h 32% · wk 10% | #edeae2 | #1e1f26 | 13.66 | 4.5 | yes |
| teal-dark | publish-failed | publish card reason | In a WSL project, publish by `content`: AIB cannot | #edeae2 | #191a21 | 14.42 | 4.5 | yes |
| teal-dark | np-browse | folder list row | .. | #edeae2 | #16171d | 14.87 | 4.5 | yes |
| teal-light | publish-failed | publish card reason | In a WSL project, publish by `content`: AIB cannot | #16151b | #f6f3ee | 16.4 | 4.5 | yes |
| teal-light | np-browse | folder list row | .. | #16151b | #faf8f3 | 17.1 | 4.5 | yes |
| teal-light | good | limits value | 5h 32% · wk 10% | #16151b | #ffffff | 18.15 | 4.5 | yes |
| teal-light | good | drop-down | Ubuntu (WSL default) docker-desktop (not supported | #16151b | #ffffff | 18.15 | 4.5 | yes |
| teal-light | node-missing | button link (Check again, Copy) | Check again | #16151b | #ffffff | 18.15 | 4.5 | yes |
| teal-light | del-wsl-ticked | delete: tick label | Move folder to trash in Ubuntu | #16151b | #ffffff | 18.15 | 4.5 | yes |

## D. Widths: overflow, clipping, sideways scroll

### good at 700 px

Content box 700 px wide; nav 700 x 134; drop-down 360 px.

No overflow found.

### long at 700 px

Content box 700 px wide; nav 700 x 134; drop-down 360 px.

No overflow found.

### rm-long at 700 px

Content box 700 px wide; nav 700 x 134; drop-down 360 px; dialog 460 x 602.

No overflow found.

### many-agents at 700 px

Content box 700 px wide; nav 700 x 134; drop-down 360 px.

No overflow found.

### two at 700 px

Content box 700 px wide; nav 700 x 134; drop-down 360 px.

| kind | element | text | by px |
| --- | --- | --- | --- |
| clipped | select | Debian Ubuntu (WSL default) docker-desktop (not supported: d | 189 |

### error at 700 px

Content box 700 px wide; nav 700 x 134; drop-down 360 px.

No overflow found.

### good at 900 px

Content box 860 px wide; nav 900 x 99; drop-down 360 px.

No overflow found.

### long at 900 px

Content box 860 px wide; nav 900 x 99; drop-down 360 px.

No overflow found.

### rm-long at 900 px

Content box 860 px wide; nav 900 x 99; drop-down 360 px; dialog 460 x 602.

No overflow found.

### many-agents at 900 px

Content box 860 px wide; nav 900 x 99; drop-down 360 px.

No overflow found.

### two at 900 px

Content box 860 px wide; nav 900 x 99; drop-down 360 px.

| kind | element | text | by px |
| --- | --- | --- | --- |
| clipped | select | Debian Ubuntu (WSL default) docker-desktop (not supported: d | 189 |

### error at 900 px

Content box 860 px wide; nav 900 x 99; drop-down 360 px.

No overflow found.

### long at 1280 px

Content box 820 px wide; nav 220 x 860; drop-down 360 px.

No overflow found.

### rm-long at 1280 px

Content box 820 px wide; nav 220 x 860; drop-down 360 px; dialog 460 x 602.

No overflow found.

### many-agents at 1280 px

Content box 820 px wide; nav 220 x 860; drop-down 360 px.

No overflow found.

### good at 1400 px

Content box 860 px wide; nav 220 x 860; drop-down 360 px.

No overflow found.

### long at 1400 px

Content box 860 px wide; nav 220 x 860; drop-down 360 px.

No overflow found.

### rm-long at 1400 px

Content box 860 px wide; nav 220 x 860; drop-down 360 px; dialog 460 x 602.

No overflow found.

### many-agents at 1400 px

Content box 860 px wide; nav 220 x 860; drop-down 360 px.

No overflow found.

### two at 1400 px

Content box 860 px wide; nav 220 x 860; drop-down 360 px.

| kind | element | text | by px |
| --- | --- | --- | --- |
| clipped | select | Debian Ubuntu (WSL default) docker-desktop (not supported: d | 189 |

### error at 1400 px

Content box 860 px wide; nav 220 x 860; drop-down 360 px.

No overflow found.

## E. Keyboard and a11y

### Tab walk, good

| # | element | text | role / type | focus mark |
| --- | --- | --- | --- | --- |
| 0 | SELECT | Ubuntu (WSL default) docker-desktop (not |  select-one | **none** |
| 1 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 2 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 3 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 4 | BUTTON.st-danger | Uninstall |  button | solid 2px rgb(43, 179, 163) |
| 5 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 6 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 7 | A.st-link st-beta-docs | Codex docs |   | auto 1px rgb(238, 238, 238) |
| 8 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 9 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 10 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 11 | BUTTON.st-link | AIB Linking |  button | solid 2px rgb(43, 179, 163) |
| 12 | BUTTON.st-danger | Remove AIB from Ubuntu |  button | solid 2px rgb(43, 179, 163) |
| 13 | BUTTON.st-link | Refresh |  button | solid 2px rgb(43, 179, 163) |
| 14 | BUTTON.activity-hide | × |  button | solid 2px rgb(43, 179, 163) |
| 15 | BUTTON | Show command history |  button | solid 2px rgb(43, 179, 163) |
| 16 | BODY |  |   | **none** |
| 17 | BUTTON.ws-proj-btn | All chats ▾ |  button | solid 2px rgb(43, 179, 163) |
| 18 | BUTTON.ws-newproj | + |  button | solid 2px rgb(43, 179, 163) |
| 19 | BUTTON.find-chat | Find chat or file… Ctrl+K |  button | solid 2px rgb(43, 179, 163) |
| 20 | SUMMARY | ARCHIVED (0) |   | solid 2px rgb(43, 179, 163) |
| 21 | BUTTON.side-settings | ⚙ Settings Ctrl+, |  button | solid 2px rgb(43, 179, 163) |
| 22 | H1 | Your conversations |   | solid 1px rgb(43, 179, 163) |
| 23 | INPUT.st-search | Search settings |  search checked=false | solid 2px rgb(43, 179, 163) |
| 24 | BUTTON.st-section | AIB Linking |  button | solid 2px rgb(43, 179, 163) |
| 25 | BUTTON.st-section active | AIB Linking (WSL) |  button | solid 2px rgb(43, 179, 163) / rgb(43, 179, 163) 3px 0px 0px 0px inset |
| 26 | BUTTON.st-section | Defaults |  button | solid 2px rgb(43, 179, 163) |
| 27 | BUTTON.st-section | Notifications |  button | solid 2px rgb(43, 179, 163) |
| 28 | BUTTON.st-section | Remote control |  button | solid 2px rgb(43, 179, 163) |
| 29 | BUTTON.st-section | Allow rules |  button | solid 2px rgb(43, 179, 163) |
| 30 | BUTTON.st-section | Editors |  button | solid 2px rgb(43, 179, 163) |
| 31 | BUTTON.st-section | Keyboard |  button | solid 2px rgb(43, 179, 163) |
| 32 | BUTTON.st-section | Appearance |  button | solid 2px rgb(43, 179, 163) |
| 33 | BUTTON.st-section | AIB server |  button | solid 2px rgb(43, 179, 163) |
| 34 | BUTTON.st-close | × |  button | solid 2px rgb(43, 179, 163) |
| 35 | SELECT | Ubuntu (WSL default) docker-desktop (not |  select-one | solid 2px rgb(43, 179, 163) |
| 36 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 37 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 38 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 39 | BUTTON.st-danger | Uninstall |  button | solid 2px rgb(43, 179, 163) |
| 40 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 41 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 42 | A.st-link st-beta-docs | Codex docs |   | auto 1px rgb(238, 238, 238) |
| 43 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 44 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 45 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |

```json
{
 "select": {
  "role": "(implicit combobox)",
  "ariaLabel": "The distro this page shows",
  "label": "DistroUbuntu (WSL default)docker-desktop (not supported: docker-desktop is Docker's own distro; AIB cannot run there)",
  "options": [
   {
    "text": "Ubuntu (WSL default)",
    "disabled": false,
    "selected": true
   },
   {
    "text": "docker-desktop (not supported: docker-desktop is Docker's own distro; AIB cannot run there)",
    "disabled": true,
    "selected": false
   }
  ]
 },
 "switches": [
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  },
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  },
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  }
 ],
 "progress": [],
 "chips": [
  {
   "text": "Ready",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Not supported",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Signed in",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Signed in",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Found",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "in use",
   "role": "",
   "live": "",
   "title": ""
  }
 ],
 "statusRegions": [
  {
   "cls": "note",
   "role": "status",
   "live": null
  },
  {
   "cls": "ownership-hint",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice wsl-line",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice wsl-line",
   "role": "status",
   "live": null
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "ownership-prompt",
   "role": "alertdialog",
   "live": "assertive"
  },
  {
   "cls": "plan-dock",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "turn-line",
   "role": "status",
   "live": "polite"
  },
  {
   "cls": "attachment-list",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "command-status-note",
   "role": "status",
   "live": "polite"
  },
  {
   "cls": "sr-only",
   "role": "status",
   "live": "polite"
  }
 ]
}
```

### Tab walk, installing

| # | element | text | role / type | focus mark |
| --- | --- | --- | --- | --- |
| 0 | SELECT | Ubuntu (WSL default) |  select-one | **none** |
| 1 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 2 | BUTTON.st-cancel | Cancel |  button | solid 2px rgb(43, 179, 163) |
| 3 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 4 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 5 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 6 | A.st-link st-beta-docs | Codex docs |   | auto 1px rgb(238, 238, 238) |
| 7 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 8 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 9 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 10 | BUTTON.st-link | AIB Linking |  button | solid 2px rgb(43, 179, 163) |
| 11 | BUTTON.st-danger | Remove AIB from Ubuntu |  button | solid 2px rgb(43, 179, 163) |
| 12 | BUTTON.st-link | Refresh |  button | solid 2px rgb(43, 179, 163) |
| 13 | BUTTON.activity-hide | × |  button | solid 2px rgb(43, 179, 163) |
| 14 | BUTTON | Show command history |  button | solid 2px rgb(43, 179, 163) |
| 15 | BUTTON.ws-proj-btn | All chats ▾ |  button | solid 2px rgb(43, 179, 163) |
| 16 | BUTTON.ws-newproj | + |  button | solid 2px rgb(43, 179, 163) |
| 17 | BUTTON.find-chat | Find chat or file… Ctrl+K |  button | solid 2px rgb(43, 179, 163) |
| 18 | SUMMARY | ARCHIVED (0) |   | solid 2px rgb(43, 179, 163) |
| 19 | BUTTON.side-settings | ⚙ Settings Ctrl+, |  button | solid 2px rgb(43, 179, 163) |
| 20 | H1 | Your conversations |   | solid 1px rgb(43, 179, 163) |
| 21 | INPUT.st-search | Search settings |  search checked=false | solid 2px rgb(43, 179, 163) |
| 22 | BUTTON.st-section | AIB Linking |  button | solid 2px rgb(43, 179, 163) |
| 23 | BUTTON.st-section active | AIB Linking (WSL) |  button | solid 2px rgb(43, 179, 163) / rgb(43, 179, 163) 3px 0px 0px 0px inset |
| 24 | BUTTON.st-section | Defaults |  button | solid 2px rgb(43, 179, 163) |
| 25 | BUTTON.st-section | Notifications |  button | solid 2px rgb(43, 179, 163) |
| 26 | BUTTON.st-section | Remote control |  button | solid 2px rgb(43, 179, 163) |
| 27 | BUTTON.st-section | Allow rules |  button | solid 2px rgb(43, 179, 163) |
| 28 | BUTTON.st-section | Editors |  button | solid 2px rgb(43, 179, 163) |
| 29 | BUTTON.st-section | Keyboard |  button | solid 2px rgb(43, 179, 163) |
| 30 | BUTTON.st-section | Appearance |  button | solid 2px rgb(43, 179, 163) |
| 31 | BUTTON.st-section | AIB server |  button | solid 2px rgb(43, 179, 163) |
| 32 | BUTTON.st-close | × |  button | solid 2px rgb(43, 179, 163) |
| 33 | SELECT | Ubuntu (WSL default) |  select-one | solid 2px rgb(43, 179, 163) |
| 34 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 35 | BUTTON.st-cancel | Cancel |  button | solid 2px rgb(43, 179, 163) |
| 36 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 37 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 38 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 39 | A.st-link st-beta-docs | Codex docs |   | auto 1px rgb(238, 238, 238) |
| 40 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 41 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 42 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 43 | BUTTON.st-link | AIB Linking |  button | solid 2px rgb(43, 179, 163) |
| 44 | BUTTON.st-danger | Remove AIB from Ubuntu |  button | solid 2px rgb(43, 179, 163) |
| 45 | BUTTON.st-link | Refresh |  button | solid 2px rgb(43, 179, 163) |

```json
{
 "select": {
  "role": "(implicit combobox)",
  "ariaLabel": "The distro this page shows",
  "label": "DistroUbuntu (WSL default)",
  "options": [
   {
    "text": "Ubuntu (WSL default)",
    "disabled": false,
    "selected": true
   }
  ]
 },
 "switches": [
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  },
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  },
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  }
 ],
 "progress": [
  {
   "role": "progressbar",
   "now": "46",
   "min": "0",
   "max": "100",
   "label": "Installing Claude Code in Ubuntu"
  }
 ],
 "chips": [
  {
   "text": "Ready",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Found",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Not installed",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "in use",
   "role": "",
   "live": "",
   "title": ""
  }
 ],
 "statusRegions": [
  {
   "cls": "note",
   "role": "status",
   "live": null
  },
  {
   "cls": "ownership-hint",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice wsl-line",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice wsl-line",
   "role": "status",
   "live": null
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "ownership-prompt",
   "role": "alertdialog",
   "live": "assertive"
  },
  {
   "cls": "plan-dock",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "turn-line",
   "role": "status",
   "live": "polite"
  },
  {
   "cls": "attachment-list",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "command-status-note",
   "role": "status",
   "live": "polite"
  },
  {
   "cls": "sr-only",
   "role": "status",
   "live": "polite"
  }
 ]
}
```

### Tab walk, two

| # | element | text | role / type | focus mark |
| --- | --- | --- | --- | --- |
| 0 | SELECT | Debian Ubuntu (WSL default) docker-deskt |  select-one | solid 2px rgb(43, 179, 163) |
| 1 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 2 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 3 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 4 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 5 | BUTTON.st-danger | Uninstall |  button | solid 2px rgb(43, 179, 163) |
| 6 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 7 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 8 | A.st-link st-beta-docs | Codex docs |   | auto 1px rgb(238, 238, 238) |
| 9 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 10 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 11 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 12 | BUTTON.st-link | AIB Linking |  button | solid 2px rgb(43, 179, 163) |
| 13 | BUTTON.st-danger | Remove AIB from Ubuntu |  button | solid 2px rgb(43, 179, 163) |
| 14 | BUTTON.st-link | Refresh |  button | solid 2px rgb(43, 179, 163) |
| 15 | BUTTON.activity-hide | × |  button | solid 2px rgb(43, 179, 163) |
| 16 | BUTTON | Show command history |  button | solid 2px rgb(43, 179, 163) |
| 17 | BODY |  |   | **none** |
| 18 | BUTTON.ws-proj-btn | All chats ▾ |  button | solid 2px rgb(43, 179, 163) |
| 19 | BUTTON.ws-newproj | + |  button | solid 2px rgb(43, 179, 163) |
| 20 | BUTTON.find-chat | Find chat or file… Ctrl+K |  button | solid 2px rgb(43, 179, 163) |
| 21 | SUMMARY | ARCHIVED (0) |   | solid 2px rgb(43, 179, 163) |
| 22 | BUTTON.side-settings | ⚙ Settings Ctrl+, |  button | solid 2px rgb(43, 179, 163) |
| 23 | H1 | Your conversations |   | solid 1px rgb(43, 179, 163) |
| 24 | INPUT.st-search | Search settings |  search checked=false | solid 2px rgb(43, 179, 163) |
| 25 | BUTTON.st-section | AIB Linking |  button | solid 2px rgb(43, 179, 163) |
| 26 | BUTTON.st-section active | AIB Linking (WSL) |  button | solid 2px rgb(43, 179, 163) / rgb(43, 179, 163) 3px 0px 0px 0px inset |
| 27 | BUTTON.st-section | Defaults |  button | solid 2px rgb(43, 179, 163) |
| 28 | BUTTON.st-section | Notifications |  button | solid 2px rgb(43, 179, 163) |
| 29 | BUTTON.st-section | Remote control |  button | solid 2px rgb(43, 179, 163) |
| 30 | BUTTON.st-section | Allow rules |  button | solid 2px rgb(43, 179, 163) |
| 31 | BUTTON.st-section | Editors |  button | solid 2px rgb(43, 179, 163) |
| 32 | BUTTON.st-section | Keyboard |  button | solid 2px rgb(43, 179, 163) |
| 33 | BUTTON.st-section | Appearance |  button | solid 2px rgb(43, 179, 163) |
| 34 | BUTTON.st-section | AIB server |  button | solid 2px rgb(43, 179, 163) |
| 35 | BUTTON.st-close | × |  button | solid 2px rgb(43, 179, 163) |
| 36 | SELECT | Debian Ubuntu (WSL default) docker-deskt |  select-one | solid 2px rgb(43, 179, 163) |
| 37 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 38 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 39 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 40 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |
| 41 | BUTTON.st-danger | Uninstall |  button | solid 2px rgb(43, 179, 163) |
| 42 | BUTTON.st-link | Check again |  button | solid 2px rgb(43, 179, 163) |
| 43 | BUTTON.st-link | Copy |  button | solid 2px rgb(43, 179, 163) |
| 44 | A.st-link st-beta-docs | Codex docs |   | auto 1px rgb(238, 238, 238) |
| 45 | INPUT | on |  checkbox checked=true | solid 2px rgb(43, 179, 163) |

```json
{
 "select": {
  "role": "(implicit combobox)",
  "ariaLabel": "The distro this page shows",
  "label": "DistroDebianUbuntu (WSL default)docker-desktop (not supported: docker-desktop is Docker's own distro; AIB cannot run there)Ubuntu-20.04 (not supported: Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2)",
  "options": [
   {
    "text": "Debian",
    "disabled": false,
    "selected": false
   },
   {
    "text": "Ubuntu (WSL default)",
    "disabled": false,
    "selected": true
   },
   {
    "text": "docker-desktop (not supported: docker-desktop is Docker's own distro; AIB cannot run there)",
    "disabled": true,
    "selected": false
   },
   {
    "text": "Ubuntu-20.04 (not supported: Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2)",
    "disabled": true,
    "selected": false
   }
  ]
 },
 "switches": [
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  },
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  },
  {
   "type": "checkbox",
   "role": "",
   "checked": true,
   "ariaChecked": null,
   "label": "Use in Ubuntu",
   "ariaLabel": ""
  }
 ],
 "progress": [],
 "chips": [
  {
   "text": "Not running",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Ready",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Not supported",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Not supported",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Signed in",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Found",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "Not installed",
   "role": "",
   "live": "",
   "title": ""
  },
  {
   "text": "in use",
   "role": "",
   "live": "",
   "title": ""
  }
 ],
 "statusRegions": [
  {
   "cls": "note",
   "role": "status",
   "live": null
  },
  {
   "cls": "ownership-hint",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice wsl-line",
   "role": "status",
   "live": null
  },
  {
   "cls": "studio-notice wsl-line",
   "role": "status",
   "live": null
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "ownership-prompt",
   "role": "alertdialog",
   "live": "assertive"
  },
  {
   "cls": "plan-dock",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "turn-line",
   "role": "status",
   "live": "polite"
  },
  {
   "cls": "attachment-list",
   "role": null,
   "live": "polite"
  },
  {
   "cls": "command-status-note",
   "role": "status",
   "live": "polite"
  },
  {
   "cls": "sr-only",
   "role": "status",
   "live": "polite"
  }
 ]
}
```

### Remove dialog

```json
{
 "first": {
  "tag": "BUTTON",
  "cls": "cg-confirm-no dp-cancel",
  "text": "Cancel",
  "type": "button",
  "role": "",
  "ariaLabel": "",
  "checked": null,
  "focusVisible": false,
  "outline": "none 3px rgb(237, 234, 226)",
  "boxShadow": "none",
  "ring": false,
  "inDialog": true,
  "inContent": false
 },
 "tabs": [
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove AIB from Ubuntu",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-no dp-cancel",
   "text": "Cancel",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove AIB from Ubuntu",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-no dp-cancel",
   "text": "Cancel",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove AIB from Ubuntu",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-no dp-cancel",
   "text": "Cancel",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove AIB from Ubuntu",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-no dp-cancel",
   "text": "Cancel",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  }
 ],
 "back": [
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove AIB from Ubuntu",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-no dp-cancel",
   "text": "Cancel",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove AIB from Ubuntu",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-no dp-cancel",
   "text": "Cancel",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  }
 ],
 "attrs": {
  "role": "alertdialog",
  "modal": "true",
  "labelledby": "wlRemoveTitle",
  "title": "Remove AIB from Ubuntu?",
  "describedby": null
 },
 "afterEscape": {
  "open": false,
  "settingsOpen": true
 },
 "focusAfter": {
  "tag": "BUTTON",
  "cls": "st-danger",
  "text": "Remove AIB from Ubuntu",
  "type": "button",
  "role": "",
  "ariaLabel": "",
  "checked": null,
  "focusVisible": true,
  "outline": "solid 2px rgb(43, 179, 163)",
  "boxShadow": "none",
  "ring": true,
  "inDialog": false,
  "inContent": true
 }
}
```

### Delete-project dialog (reference)

```json
{
 "first": {
  "tag": "BUTTON",
  "cls": "cg-confirm-no dp-cancel",
  "text": "Cancel",
  "type": "button",
  "role": "",
  "ariaLabel": "",
  "checked": null,
  "focusVisible": false,
  "outline": "none 3px rgb(237, 234, 226)",
  "boxShadow": "none",
  "ring": false,
  "inDialog": true,
  "inContent": false
 },
 "tabs": [
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove from AIB",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "INPUT",
   "cls": "",
   "text": "on",
   "type": "checkbox",
   "role": "",
   "ariaLabel": "",
   "checked": false,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-no dp-cancel",
   "text": "Cancel",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "BUTTON",
   "cls": "cg-confirm-yes cg-discard dp-ok",
   "text": "Remove from AIB",
   "type": "button",
   "role": "",
   "ariaLabel": "",
   "checked": null,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  },
  {
   "tag": "INPUT",
   "cls": "",
   "text": "on",
   "type": "checkbox",
   "role": "",
   "ariaLabel": "",
   "checked": false,
   "focusVisible": true,
   "outline": "solid 2px rgb(43, 179, 163)",
   "boxShadow": "none",
   "ring": true,
   "inDialog": true,
   "inContent": false
  }
 ]
}
```

## F. Copy: every user-visible string seen in the rendered states

Source = first file:line holding the string's longest fixed part (dynamic parts such as distro names, sizes and paths removed). Flags from the copy review are in the findings above.

| string | kind | source | seen in |
| --- | --- | --- | --- |
| Distro | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +30 |
| WSL on this PC | text | wsl-settings-ui.js:5 | A good, A node-missing, A node-old, A asdf +32 |
| Run Claude Code, Codex and the other ACP agents inside your WSL distros, next to your Windows agents, all on this PC. AIB installs them into its own folder in each distro (~/.aib-server), with the versions it reviewed. | text | wsl-settings-ui.js:25 | A good, A node-missing, A node-old, A asdf +30 |
| Ubuntu | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +30 |
| WSL 2 · WSL default | text | wsl-settings-ui.js:381 | A good, A node-missing, A node-old, A asdf +30 |
| Ready | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +24 |
| docker-desktop | text | (dynamic / fixture) | A good, A two, A rm-check, A rm-blocked +7 |
| Not supported | text | wsl-settings-ui.js:392 | A good, A two, A rm-check, A rm-blocked +8 |
| docker-desktop is Docker's own distro; AIB cannot run there. | text | (dynamic / fixture) | A good, A two, A rm-check, A rm-blocked +7 |
| A distro keeps running while a WSL project is open or a WSL chat works, also after you quit AIB. When nothing works, AIB lets go and WSL stops it by its own rules. | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +30 |
| UBUNTU | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +28 |
| State | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +30 |
| AIB helper | text | wsl-settings-ui.js:432 | A good, A node-missing, A node-old, A asdf +23 |
| 0.1.0-ab12cd34 | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| Home | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| /home/u | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| What Ubuntu needs | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| AIB looks in Ubuntu's login shell, the way your terminal there sees it. It installs nothing by itself. | text | wsl-settings-ui.js:692 | A good, A node-missing, A node-old, A asdf +21 |
| Node.js 22.19 or newer | text | wsl-settings-ui.js:64 | A good, A node-missing, A node-old, A asdf +23 |
| found 24.11.1 (nvm) | text | (dynamic / fixture) | A good, A pkg-missing, A installing, A update +19 |
| /home/u/.nvm/versions/node/v24.11.1/bin/node | text | (dynamic / fixture) | A good, A pkg-missing, A installing, A update +18 |
| npm | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| found 11.6.2 | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| git | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| found 2.43.0 | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| curl | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| found | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +22 |
| Free space in your home folder | text | wsl-settings-ui.js:711 | A good, A node-missing, A node-old, A asdf +23 |
| 802.7 GB free | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +22 |
| Checked with: zsh login shell (interactive). Check again | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +22 |
| Check again | text | wsl-settings-ui.js:419 | A good, A node-missing, A node-old, A asdf +26 |
| Agents in Ubuntu | text | wsl-settings-ui.js:7 | A good, A node-missing, A node-old, A asdf +21 |
| Claude Code | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| Installed by AIB | text | wsl-settings-ui.js:882 | A good, A pkg-missing, A update, A error +18 |
| Signed in | text | wsl-settings-ui.js:869 | A good, A pkg-missing, A error, A signin +16 |
| Version | text | wsl-settings-ui.js:54 | A good, A node-old, A asdf, A pkg-missing +22 |
| 0.102.0 | text | (dynamic / fixture) | A good, A pkg-missing, A error, A signin +17 |
| Signed in to Claude Code in Ubuntu as me@example.com. | text | wsl-settings-ui.js:944 | A good, A signin, A rm-check, A rm-blocked +6 |
| The standalone claude command is not needed: AIB chats use the copy that comes with Claude Code in Ubuntu. | text | (dynamic / fixture) | A good, A pkg-missing, A update, A error +16 |
| Use in Ubuntu | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Uninstall | text | wsl-settings-ui.js:9 | A good, A pkg-missing, A update, A error +18 |
| Codex | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| Your own install | text | wsl-settings-ui.js:800 | A good, A node-old, A asdf, A pkg-missing +20 |
| 2.6.0 | text | (dynamic / fixture) | A good, A node-old, A asdf, A pkg-missing +21 |
| Signed in to Codex in Ubuntu. | text | wsl-settings-ui.js:944 | A good, A rm-check, A rm-blocked, A rm-second +5 |
| Usage limits of Ubuntu's Codex sign-in: 5h 32% · wk 10% (updated 4 min ago). Same ChatGPT account as on Windows means the same limits. | text | wsl-settings-ui.js:931 | A good, A rm-check, A rm-blocked, A rm-second +5 |
| 5h 32% · wk 10% | text | (dynamic / fixture) | A good, A rm-check, A rm-blocked, A rm-second +6 |
| Optional: to use Codex in your own Ubuntu terminal, install the codex command yourself: | text | wsl-settings-ui.js:1040 | A good, A node-old, A asdf, A pkg-missing +19 |
| npm install -g @openai/codex | text | wsl-settings-ui.js:40 | A good, A node-old, A asdf, A pkg-missing +21 |
| Codex docs | text | (dynamic / fixture) | A good, A node-old, A asdf, A pkg-missing +21 |
| OMP | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +23 |
| Found | text | (dynamic / fixture) | A good, A node-old, A asdf, A pkg-missing +19 |
| 1.2.0 | text | (dynamic / fixture) | A good, A signin, A rm-check, A rm-blocked +7 |
| Sign-in is checked in Ubuntu each time this page reads its agents. "Use in Ubuntu" is Ubuntu's own switch; the Windows one stays as it is. Your Windows agents are in AIB Linking. | text | wsl-settings-ui.js:1078 | A good, A node-missing, A node-old, A asdf +21 |
| AIB Linking | text | wsl-settings-ui.js:3 | A good, A node-missing, A node-old, A asdf +23 |
| AIB in Ubuntu | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Everything AIB keeps in Ubuntu, in /home/u/.aib-server on this PC. Your projects, ~/.claude, ~/.codex and anything you installed yourself are not in it. | text | wsl-settings-ui.js:1191 | A good, A node-missing, A node-old, A asdf +19 |
| AIB programs (keeper, helper) | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 190 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Agents installed by AIB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 861 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Claude Code 0.102.0 | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 404 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Codex 2.6.0 | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 457 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| npm download cache | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 330 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| This AIB's data folder | text | chat.js:321 | A good, A node-missing, A node-old, A asdf +21 |
| 12 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Chat copies of this AIB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 96 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Logs | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 512 KB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| In all | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| 1.5 GB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| AIB versions installed: 0.1.0-ab12cd34 (current), 0.0.9-ffee0011 | text | wsl-settings-ui.js:1213 | A good, A node-missing, A node-old, A asdf +20 |
| Chat copies: 3, 1 with unsaved changes | text | wsl-settings-ui.js:1219 | A good, A node-missing, A node-old, A asdf +20 |
| Chats working now: 0 | text | wsl-settings-ui.js:1223 | A good, A node-missing, A node-old, A asdf +19 |
| Other AIB data folders in Ubuntu | text | wsl-settings-ui.js:1227 | A good, A node-missing, A node-old, A asdf +18 |
| data-9f8e7d6c | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +20 |
| 40 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +20 |
| in use | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +20 |
| data-55aa66bb | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +20 |
| 3 MB | text | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +20 |
| These belong to another AIB build or data folder. Remove here never touches them. | text | wsl-settings-ui.js:1235 | A good, A node-missing, A node-old, A asdf +20 |
| Remove AIB from Ubuntu | text | wsl-settings-ui.js:1172 | A good, A node-missing, A node-old, A asdf +20 |
| Refresh | text | wsl-settings-ui.js:250 | A good, A node-missing, A node-old, A asdf +22 |
| The distro this page shows | aria | wsl-settings-ui.js:338 | A good, A node-missing, A node-old, A asdf +30 |
| Ubuntu (WSL default) | option | wsl-settings-ui.js:340 | A good, A node-missing, A node-old, A asdf +29 |
| docker-desktop (not supported: docker-desktop is Docker's own distro; AIB cannot run there) | option | (dynamic / fixture) | A good, A two, A rm-check, A rm-blocked +7 |
| 5-hour: 32% used · resets 19:47 (in 59m) Weekly: 10% used · resets Mon 18:47 (in 23h 59m) Updated 4 min ago | title | (dynamic / fixture) | A good, A rm-check, A rm-blocked, A rm-second +6 |
| Copy the command that installs the codex command | aria | (dynamic / fixture) | A good, A node-old, A asdf, A pkg-missing +21 |
| /home/u/.aib-server/0.1.0-ab12cd34 | title | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| /home/u/.aib-server/agents | title | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| /home/u/.aib-server/agents/.npm-cache | title | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| /home/u/.aib-server/data-1a2b3c4d | title | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +22 |
| /home/u/.aib-server/data-1a2b3c4d/worktrees | title | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| /home/u/.aib-server/data-1a2b3c4d/logs | title | (dynamic / fixture) | A good, A node-missing, A node-old, A asdf +21 |
| Shows exactly what would be deleted from Ubuntu and what is kept, before anything is deleted | title | wsl-settings-ui.js:1173 | A good, A node-missing, A node-old, A asdf +20 |
| Measure what AIB keeps in Ubuntu again | title | wsl-settings-ui.js:1170 | A good, A node-missing, A node-old, A asdf +20 |
| missing | text | wsl-settings-ui.js:279 | A node-missing, A pkg-missing, A error, A node-term |
| Needed to install Claude Code, Codex and the other npm agents in Ubuntu. | text | wsl-settings-ui.js:637 | A node-missing, A node-term |
| Install runs nvm's official installer in a terminal here, in Ubuntu, then installs the current LTS Node.js. It adds nvm to your home folder and shell start-up file; it needs no password. | text | wsl-settings-ui.js:644 | A node-missing, A node-term |
| Install Node.js in Ubuntu | text | wsl-settings-ui.js:542 | A node-missing, A node-old, A node-term |
| Not installed | text | wsl-settings-ui.js:866 | A node-missing, A node-old, A asdf, A pkg-missing +12 |
| Install in Ubuntu | text | wsl-settings-ui.js:900 | A node-missing, A node-old, A asdf, A node-term +3 |
| Needs Node.js first: see What Ubuntu needs above. | text | wsl-settings-ui.js:981 | A node-missing, A node-old, A asdf, A node-term |
| AIB does not install OMP. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A node-missing, A node-old, A asdf, A pkg-missing +11 |
| Needs Node.js first | title | wsl-settings-ui.js:901 | A node-missing, A node-old, A asdf, A node-term |
| too old (18.19.1) | text | (dynamic / fixture) | A node-old |
| AIB needs Node.js 22.19 or newer in Ubuntu to install Claude Code, Codex and the other npm agents. | text | wsl-settings-ui.js:634 | A node-old |
| Install runs nvm's official installer in a terminal here, in Ubuntu, then installs the current LTS Node.js. It adds nvm to your home folder and shell start-up file; it needs no password. nvm is already in Ubuntu; it is used. | text | wsl-settings-ui.js:644 | A node-old |
| asdf has no Node.js version set | text | (dynamic / fixture) | A asdf |
| Node.js in Ubuntu comes from asdf, and asdf has no Node.js version set, so node does not run. Set one in Ubuntu (no password needed), then choose Check again: | text | wsl-settings-ui.js:617 | A asdf |
| asdf 0.16 or newer: | text | wsl-settings-ui.js:64 | A asdf |
| asdf install nodejs latest && asdf set -u nodejs latest | text | wsl-settings-ui.js:55 | A asdf |
| asdf 0.15 or older: | text | wsl-settings-ui.js:65 | A asdf |
| asdf install nodejs latest && asdf global nodejs latest | text | wsl-settings-ui.js:56 | A asdf |
| Node.js comes from asdf in Ubuntu, so AIB does not install another one. | text | (dynamic / fixture) | A asdf |
| Open Ubuntu terminal | text | wsl-settings-ui.js:7 | A asdf, A pkg-missing, A error, B nc-missing +2 |
| Copy the command that sets a Node.js version in asdf | aria | (dynamic / fixture) | A asdf |
| Needed for a chat's own copy, Changes and Merge; until then chats work in the project folder. It needs your password, so AIB does not run it. Run it yourself in Ubuntu: | text | wsl-settings-ui.js:707 | A pkg-missing, A error |
| sudo dnf install git | text | (dynamic / fixture) | A pkg-missing |
| Needed by nvm's installer and the vendors' install scripts. It needs your password, so AIB does not run it. Run it yourself in Ubuntu: | text | wsl-settings-ui.js:708 | A pkg-missing |
| sudo dnf install curl | text | (dynamic / fixture) | A pkg-missing |
| 380 MB free | text | (dynamic / fixture) | A pkg-missing |
| Installs need room in Ubuntu: Claude Code about 1 GB, Codex about 600 MB. | text | wsl-settings-ui.js:716 | A pkg-missing |
| Checked with: plain shell, without your login profile. A version manager set up only in your shell profile is not seen this way. Check again | text | (dynamic / fixture) | A pkg-missing |
| Signed in to Claude Code in Ubuntu. | text | wsl-settings-ui.js:944 | A pkg-missing, A update, A error, A two +5 |
| Copy the command that installs git | aria | (dynamic / fixture) | A pkg-missing, A error |
| Copy the command that installs curl | aria | (dynamic / fixture) | A pkg-missing |
| Cancel | text | (dynamic / fixture) | A installing, A rm-check, A rm-second, A rm-tick +7 |
| Installing Claude Code in Ubuntu… Downloading and unpacking… It goes on if you close Settings or restart AIB. | text | wsl-settings-ui.js:553 | A installing |
| Installing Claude Code in Ubuntu | aria | wsl-settings-ui.js:553 | A installing |
| Update available | text | wsl-settings-ui.js:867 | A update |
| Update in Ubuntu | text | wsl-settings-ui.js:900 | A update, B nc-update |
| 0.98.1 | text | (dynamic / fixture) | A update |
| AIB now uses Claude Code 0.102.0; Ubuntu has 0.98.1. The old copy keeps working until the new one is complete. | text | wsl-settings-ui.js:996 | A update |
| Not signed in | text | wsl-settings-ui.js:870 | A update, A signin, A signin-term, A long |
| Sign in | text | wsl-settings-ui.js:9 | A update, A signin, A long, B nc-found +1 |
| Not signed in to Codex in Ubuntu yet. Sign in runs Codex's own sign-in in a Ubuntu terminal here; its page opens in your Windows browser. Ubuntu signs in separately from Windows. AIB does not see your password or sign-in details. | text | wsl-settings-ui.js:948 | A update, A signin, A signin-term |
| AIB installs Claude Code 0.102.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A update, B nc-missing, B nc-update |
| sudo apt install git | text | (dynamic / fixture) | A error |
| Install failed | text | wsl-settings-ui.js:562 | A error |
| Retry | text | (dynamic / fixture) | A error |
| The install failed: npm could not reach registry.npmjs.org (ETIMEDOUT). | text | (dynamic / fixture) | A error |
| AIB installs Codex 2.6.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A error |
| Sign-in in Ubuntu: unknown (AIB has no sign-in check for OMP). | text | wsl-settings-ui.js:952 | A signin |
| Installed | text | wsl-settings-ui.js:565 | A switch-fail |
| The switch could not be saved: The settings file could not be written. Codex stays on in Ubuntu. | text | (dynamic / fixture) | A switch-fail |
| Stopped | text | wsl-settings-ui.js:364 | A stopped |
| Ubuntu stopped (Windows restart or wsl --shutdown). Chats in Ubuntu stopped with it; their history is kept. | text | wsl-settings-ui.js:456 | A stopped |
| Reconnect | text | wsl-settings-ui.js:462 | A stopped, A problem, B state-stopped |
| Start Ubuntu and connect AIB to it again | title | wsl-settings-ui.js:468 | A stopped, A problem, B state-stopped |
| Not running | text | wsl-settings-ui.js:360 | A off, A two |
| Ubuntu is not running. AIB starts it when a WSL project needs it. Its agents show here once it runs. | text | wsl-settings-ui.js:436 | A off |
| Starts Ubuntu, copies AIB's helper there the first time (about 100 MB, into ~/.aib-server) and starts it. Then AIB looks at the agents in Ubuntu. | text | wsl-settings-ui.js:439 | A off |
| Start Ubuntu and check | text | wsl-settings-ui.js:11 | A off |
| Starts Ubuntu, copies AIB's helper there the first time (about 100 MB, into ~/.aib-server) and starts it. | title | wsl-settings-ui.js:439 | A off |
| Starting | text | wsl-settings-ui.js:361 | A starting |
| Setting up AIB in Ubuntu (first time, ~100 MB) | text | wsl-settings-ui.js:1140 | A starting, B state-setup |
| Problem | text | wsl-settings-ui.js:365 | A problem |
| The AIB helper in Ubuntu failed its checksum. | text | (dynamic / fixture) | A problem |
| WSL is not installed on this PC. With it, AIB runs agents in Linux on this PC, in projects inside a distro, next to your Windows agents. Install it in an administrator PowerShell, then restart Windows: | text | (dynamic / fixture) | A nowsl |
| wsl --install | text | wsl-settings-ui.js:414 | A nowsl |
| How to install WSL (Microsoft) | text | wsl-settings-ui.js:418 | A nowsl, A nodistro |
| Copy the command that installs WSL | aria | wsl-settings-ui.js:414 | A nowsl, A nodistro |
| WSL is on this PC, but it has no Linux distro yet. Install Ubuntu in PowerShell, then open it once to make your Linux user: | text | wsl-settings-ui.js:33 | A nodistro |
| wsl --install -d Ubuntu | text | wsl-settings-ui.js:414 | A nodistro |
| Debian | text | (dynamic / fixture) | A two, A two-debian, B project-menu |
| Ubuntu-20.04 (not supported: Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2) | text | wsl-settings-ui.js:398 | A two |
| WSL 2 | text | (dynamic / fixture) | A two, A two-debian |
| Ubuntu-20.04 | text | (dynamic / fixture) | A two |
| WSL 1 | text | (dynamic / fixture) | A two, A long |
| Ubuntu-20.04 runs on WSL 1. AIB needs WSL 2. | text | wsl-settings-ui.js:398 | A two |
| AIB needs WSL 2. Convert it in PowerShell (takes a few minutes; back it up first): | text | wsl-settings-ui.js:398 | A two, A long |
| wsl --set-version Ubuntu-20.04 2 | text | wsl-settings-ui.js:399 | A two |
| Copy the command that converts Ubuntu-20.04 to WSL 2 | aria | wsl-settings-ui.js:399 | A two |
| DEBIAN | text | (dynamic / fixture) | A two-debian |
| /home/d | text | (dynamic / fixture) | A two-debian |
| What Debian needs | text | (dynamic / fixture) | A two-debian |
| AIB looks in Debian's login shell, the way your terminal there sees it. It installs nothing by itself. | text | wsl-settings-ui.js:692 | A two-debian |
| Agents in Debian | text | wsl-settings-ui.js:7 | A two-debian |
| Signed in to Claude Code in Debian. | text | wsl-settings-ui.js:944 | A two-debian |
| The standalone claude command is not needed: AIB chats use the copy that comes with Claude Code in Debian. | text | (dynamic / fixture) | A two-debian |
| Use in Debian | text | (dynamic / fixture) | A two-debian |
| Optional: to use Codex in your own Debian terminal, install the codex command yourself: | text | wsl-settings-ui.js:1040 | A two-debian |
| AIB does not install OMP. Install it in Debian as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A two-debian |
| Sign-in is checked in Debian each time this page reads its agents. "Use in Debian" is Debian's own switch; the Windows one stays as it is. Your Windows agents are in AIB Linking. | text | wsl-settings-ui.js:1078 | A two-debian |
| AIB in Debian | text | (dynamic / fixture) | A two-debian |
| Everything AIB keeps in Debian, in /home/u/.aib-server on this PC. Your projects, ~/.claude, ~/.codex and anything you installed yourself are not in it. | text | wsl-settings-ui.js:1191 | A two-debian |
| Other AIB data folders in Debian | text | wsl-settings-ui.js:1227 | A two-debian |
| Remove AIB from Debian | text | wsl-settings-ui.js:1172 | A two-debian |
| Shows exactly what would be deleted from Debian and what is kept, before anything is deleted | title | wsl-settings-ui.js:1173 | A two-debian |
| Measure what AIB keeps in Debian again | title | wsl-settings-ui.js:1170 | A two-debian |
| AIB versions installed: 0.1.0-ab12cd34 (current) | text | wsl-settings-ui.js:1213 | A aib-clean |
| Chat copies: 2, none with unsaved changes | text | wsl-settings-ui.js:1219 | A aib-clean |
| Chats working now: 2 | text | wsl-settings-ui.js:1223 | A aib-clean |
| Starting Ubuntu… | text | wsl-settings-ui.js:361 | A aib-notready, B state-starting |
| What AIB keeps in Ubuntu could not be read: Ubuntu did not answer. | text | wsl-settings-ui.js:686 | A aib-error |
| Remove AIB from Ubuntu? | text | wsl-settings-ui.js:1172 | A rm-check, A rm-blocked, A rm-second, A rm-tick +3 |
| This stops AIB's helper in Ubuntu and deletes what is listed here. Nothing is deleted before you confirm. | text | wsl-settings-ui.js:1265 | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| Deleted (203 MB in all): | text | wsl-settings-ui.js:1339 | A rm-check, A rm-second, A rm-tick, A rm-removing |
| Chat copies of this AIB (2) | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +1 |
| /home/u/.aib-server/data-1a2b3c4d/worktrees/app/chat-1 | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| /home/u/.aib-server/data-1a2b3c4d/worktrees/api/chat-2 | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| Old AIB programs | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| 95 MB | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| /home/u/.aib-server/0.0.9-ffee0011 | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| Kept: | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| Another AIB data folder (data-9f8e7d6c) is in use: its keeper is running. | text | (dynamic / fixture) | A rm-check, A rm-blocked, A rm-second, A rm-tick +2 |
| Your projects, ~/.claude, ~/.codex, nvm and asdf are not touched. | text | wsl-settings-ui.js:1271 | A rm-check, A rm-blocked, A rm-second, A rm-tick +3 |
| Chat branches stay in your repos. | text | wsl-settings-ui.js:1272 | A rm-check, A rm-blocked, A rm-second, A rm-tick +3 |
| AIB cannot be removed from Ubuntu now: | text | wsl-settings-ui.js:1330 | A rm-blocked, A rm-long |
| A WSL chat is working in Ubuntu (app · Fix login). Wait for it or stop it first. | text | (dynamic / fixture) | A rm-blocked |
| 1 chat copy has changes that are not committed: api · Add tests. Merge or discard them first. | text | (dynamic / fixture) | A rm-blocked |
| Remove would delete (203 MB in all): | text | wsl-settings-ui.js:1339 | A rm-blocked |
| Close | text | (dynamic / fixture) | A rm-blocked, A rm-partial, A rm-long, A node-term +1 |
| Choose Remove AIB from Ubuntu again to delete these. This cannot be undone. | text | wsl-settings-ui.js:1307 | A rm-second |
| Chats working now: 1 | text | wsl-settings-ui.js:1223 | A rm-tick |
| I understand chats running in Ubuntu will stop | text | wsl-settings-ui.js:1280 | A rm-tick |
| Removing AIB from Ubuntu… | text | wsl-settings-ui.js:1240 | A rm-removing |
| Removing… | text | wsl-settings-ui.js:1310 | A rm-removing |
| Not set up | text | wsl-settings-ui.js:377 | A rm-done, A rm-partial, A rm-partial-closed |
| AIB not set up | text | wsl-settings-ui.js:1120 | A rm-done, A rm-partial, A rm-partial-closed |
| AIB is not set up in Ubuntu. | text | wsl-settings-ui.js:1115 | A rm-done, A rm-partial, A rm-partial-closed |
| Your projects, sign-ins and your own installs in Ubuntu are as they were. Set up again copies AIB's helper to Ubuntu (about 100 MB, into ~/.aib-server) and starts it. Opening a WSL project in Ubuntu does the same. | text | wsl-settings-ui.js:1124 | A rm-done, A rm-partial, A rm-partial-closed |
| Set up again | text | wsl-settings-ui.js:97 | A rm-done, A rm-partial, A rm-partial-closed |
| Copies AIB's helper to Ubuntu (about 100 MB, into ~/.aib-server) and starts it | title | wsl-settings-ui.js:439 | A rm-done, A rm-partial, A rm-partial-closed |
| AIB could not delete 1 folder in Ubuntu. Delete it yourself, or try again after a restart of Ubuntu. | text | wsl-settings-ui.js:25 | A rm-partial, A rm-partial-closed |
| Left in Ubuntu: | text | wsl-settings-ui.js:1133 | A rm-partial, A rm-partial-closed |
| /home/u/.aib-server/data-1a2b3c4d/worktrees/app/chat-1: permission denied | text | (dynamic / fixture) | A rm-partial, A rm-partial-closed |
| AIB could not remove everything from Ubuntu. | text | wsl-settings-ui.js:1369 | A rm-partial |
| Removed: | text | wsl-settings-ui.js:1372 | A rm-partial |
| A WSL chat is working in Ubuntu (a-project-with-a-rather-long-folder-name · Refactor the whole authentication layer to use the new session tokens and keep the old ones working). Wait for it or stop it first. | text | (dynamic / fixture) | A rm-long |
| Remove would delete (210 MB in all): | text | wsl-settings-ui.js:1339 | A rm-long |
| Chat copies of this AIB (3) | text | (dynamic / fixture) | A rm-long |
| 103 MB | text | (dynamic / fixture) | A rm-long |
| /home/u/.aib-server/data-1a2b3c4d/worktrees/a-project-with-a-rather-long-folder-name/chat-claude-pensive-ritchie-26be75-and-some-more/node_modules/.cache | text | (dynamic / fixture) | A rm-long |
| /home/u/.aib-server/agents/claude/0.102.0/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 | text | (dynamic / fixture) | A rm-long |
| A process of another AIB data folder (data-9f8e7d6c) runs from it: /home/u/.aib-server/agents/claude/0.102.0/node_modules/.bin/claude-agent-acp --stdio. | text | (dynamic / fixture) | A rm-long |
| A chat runs from Claude Code in Ubuntu (app · Fix login). End it first. | text | (dynamic / fixture) | A uninstall-refused |
| Installing Node.js in Ubuntu: nvm's official installer, then nvm install --lts | text | wsl-settings-ui.js:553 | A node-term |
| Installing. Answer here if the installer asks something. | text | wsl-settings-ui.js:558 | A node-term |
| Signing in to Codex in Ubuntu | text | wsl-settings-ui.js:838 | A signin-term |
| Finish the sign-in in this terminal; its page opens in your Windows browser. AIB does not see what you type here. | text | wsl-settings-ui.js:843 | A signin-term |
| Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name | text | (dynamic / fixture) | A long |
| Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit | text | (dynamic / fixture) | A long |
| Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit runs on WSL 1. AIB needs WSL 2. | text | wsl-settings-ui.js:398 | A long |
| wsl --set-version Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit 2 | text | wsl-settings-ui.js:399 | A long |
| UBUNTU-24.04-DEVELOPER-WORKSTATION-WITH-A-VERY-LONG-DISTRO-NAME | text | (dynamic / fixture) | A long |
| /home/someone-with-a-long-user-name | text | (dynamic / fixture) | A long |
| What Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name needs | text | (dynamic / fixture) | A long |
| AIB looks in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name's login shell, the way your terminal there sees it. It installs nothing by itself. | text | wsl-settings-ui.js:692 | A long |
| /home/someone-with-a-long-user-name/.local/share/version-managers/nvm/versions/node/v24.11.1/bin/node | text | (dynamic / fixture) | A long |
| Agents in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name | text | wsl-settings-ui.js:7 | A long |
| Signed in to Claude Code in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name as a.very.long.email.address.for.testing@some-company-with-a-long-domain.example.com. | text | wsl-settings-ui.js:944 | A long |
| The standalone claude command is not needed: AIB chats use the copy that comes with Claude Code in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name. | text | (dynamic / fixture) | A long |
| Use in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name | text | (dynamic / fixture) | A long |
| Not signed in to Codex in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name yet. Sign in runs Codex's own sign-in in a Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name terminal here; its page opens in your Windows browser. Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name signs in separately from Windows. AIB does not see your password or sign-in details. | text | wsl-settings-ui.js:948 | A long |
| Usage limits of Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name's Codex sign-in: 5h 32% · wk 10% (updated 4 min ago). Same ChatGPT account as on Windows means the same limits. | text | wsl-settings-ui.js:931 | A long |
| Optional: to use Codex in your own Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name terminal, install the codex command yourself: | text | wsl-settings-ui.js:1040 | A long |
| Sign-in in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name: unknown (AIB has no sign-in check for OMP, and this note is long on purpose to see how a long reason wraps in a narrow window). | text | wsl-settings-ui.js:952 | A long |
| Sign-in is checked in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name each time this page reads its agents. "Use in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name" is Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name's own switch; the Windows one stays as it is. Your Windows agents are in AIB Linking. | text | wsl-settings-ui.js:1078 | A long |
| AIB in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name | text | (dynamic / fixture) | A long |
| Everything AIB keeps in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name, in /home/someone-with-a-long-user-name/.aib-server on this PC. Your projects, ~/.claude, ~/.codex and anything you installed yourself are not in it. | text | wsl-settings-ui.js:1191 | A long |
| Other AIB data folders in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name | text | wsl-settings-ui.js:1227 | A long |
| Remove AIB from Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name | text | wsl-settings-ui.js:1172 | A long |
| Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name (WSL default) | option | wsl-settings-ui.js:340 | A long |
| Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit (not supported: Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit runs on WSL 1. AIB needs WSL 2) | option | wsl-settings-ui.js:398 | A long |
| Copy the command that converts Some-Other-Distro-With-A-Very-Long-Name-That-Will-Not-Fit to WSL 2 | aria | wsl-settings-ui.js:399 | A long |
| Shows exactly what would be deleted from Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name and what is kept, before anything is deleted | title | wsl-settings-ui.js:1173 | A long |
| Measure what AIB keeps in Ubuntu-24.04-Developer-Workstation-With-A-Very-Long-Distro-Name again | title | wsl-settings-ui.js:1170 | A long |
| agent1 | text | (dynamic / fixture) | A many-agents |
| 1.0.0 | text | (dynamic / fixture) | A many-agents |
| agent2 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent2. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent3 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent3 1.2.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent4 | text | (dynamic / fixture) | A many-agents |
| 1.3.0 | text | (dynamic / fixture) | A many-agents |
| agent5 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent5 1.4.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent6 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent6. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent7 | text | (dynamic / fixture) | A many-agents |
| 1.6.0 | text | (dynamic / fixture) | A many-agents |
| agent8 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent8. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent9 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent9 1.8.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent10 | text | (dynamic / fixture) | A many-agents |
| 1.9.0 | text | (dynamic / fixture) | A many-agents |
| agent11 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent11 1.10.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent12 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent12. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent13 | text | (dynamic / fixture) | A many-agents |
| 1.12.0 | text | (dynamic / fixture) | A many-agents |
| agent14 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent14. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent15 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent15 1.14.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent16 | text | (dynamic / fixture) | A many-agents |
| 1.15.0 | text | (dynamic / fixture) | A many-agents |
| agent17 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent17 1.16.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent18 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent18. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent19 | text | (dynamic / fixture) | A many-agents |
| 1.18.0 | text | (dynamic / fixture) | A many-agents |
| agent20 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent20. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent21 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent21 1.20.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent22 | text | (dynamic / fixture) | A many-agents |
| 1.21.0 | text | (dynamic / fixture) | A many-agents |
| agent23 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent23 1.22.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| agent24 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent24. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent25 | text | (dynamic / fixture) | A many-agents |
| 1.24.0 | text | (dynamic / fixture) | A many-agents |
| agent26 | text | (dynamic / fixture) | A many-agents |
| AIB does not install agent26. Install it in Ubuntu as its docs say, then choose Check again. | text | wsl-settings-ui.js:1011 | A many-agents |
| agent27 | text | (dynamic / fixture) | A many-agents |
| One click: AIB installs agent27 1.26.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions it reviewed. Nothing else in Ubuntu changes. | text | wsl-settings-ui.js:1004 | A many-agents |
| AIB installs agent3 1.2.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent5 1.4.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent9 1.8.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent11 1.10.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent15 1.14.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent17 1.16.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent21 1.20.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent23 1.22.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| AIB installs agent27 1.26.0 into its own folder in Ubuntu (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in Ubuntu changes. | title | wsl-settings-ui.js:904 | A many-agents |
| Your conversations | text | (dynamic / fixture) | B state-starting, B state-setup, B state-stopped, B open-url +7 |
| Ready to browse | text | (dynamic / fixture) | B state-starting, B state-setup, B state-stopped, B open-url +7 |
| Rename conversation | title | chat.js:1194 | B state-starting, B state-setup, B state-stopped, B open-url +13 |
| Conversation details | aria | (dynamic / fixture) | B state-starting, B state-setup, B state-stopped, B open-url +13 |
| Ubuntu stopped. | text | wsl-ui.js:6 | B state-stopped |
| Ubuntu wants to open https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email | text | wsl-ui.js:6 | B open-url |
| Open | text | (dynamic / fixture) | B open-url |
| Always allow for Ubuntu | text | wsl-ui.js:7 | B open-url |
| Don't open | text | (dynamic / fixture) | B open-url |
| Open this page in your browser once | title | wsl-ui.js:525 | B open-url |
| Open pages Ubuntu asks for without asking again | title | wsl-ui.js:526 | B open-url |
| New project | text | new-project-ui.js:3 | B np-wsl, B np-browse |
| Location | text | new-project-ui.js:61 | B np-wsl, B np-browse |
| Folder | text | (dynamic / fixture) | B np-wsl, B np-browse |
| Browse… | text | new-project-ui.js:62 | B np-wsl, B np-browse |
| Browse Ubuntu… | text | (dynamic / fixture) | B np-wsl, B np-browse |
| Existing folder | text | (dynamic / fixture) | B np-wsl, B np-browse |
| Project name (optional) | text | new-project-ui.js:119 | B np-wsl, B np-browse |
| A folder with this name is made inside Folder, or used if it is already there. Leave empty to use Folder itself. | text | new-project-ui.js:129 | B np-wsl, B np-browse |
| Uses wsl://ubuntu/home/u/ (already there) | text | (dynamic / fixture) | B np-wsl, B np-browse |
| Open project | text | new-project-ui.js:189 | B np-wsl, B np-browse |
| Windows | option | wsl-settings-ui.js:3 | B np-wsl, B np-browse |
| WSL: Ubuntu | option | (dynamic / fixture) | B np-wsl, B np-browse |
| WSL: Debian | option | (dynamic / fixture) | B np-wsl, B np-browse |
| Choose a folder with the system folder picker | title | new-project-ui.js:97 | B np-wsl, B np-browse |
| Choose a folder in Ubuntu | title | new-project-ui.js:329 | B np-wsl, B np-browse |
| Ubuntu: /home/u | text | (dynamic / fixture) | B np-browse |
| Use this folder | text | new-project-ui.js:338 | B np-browse |
| app (git) | text | (dynamic / fixture) | B np-browse |
| notes | text | (dynamic / fixture) | B np-browse |
| a-project-folder-with-a-really-long-name-to-check-wrapping (git) | text | (dynamic / fixture) | B np-browse |
| scratch | text | settings-ui.js:200 | B np-browse |
| Delete project app? | text | (dynamic / fixture) | B del-wsl, B del-wsl-ticked, B del-wsl-refused |
| Removes app from AIB. Its 2 chats move to Recently deleted. The folder Ubuntu: /home/u/app stays in Ubuntu. | text | delete-project-ui.js:33 | B del-wsl, B del-wsl-refused |
| 1 chat is running and will be stopped. | text | delete-project-ui.js:40 | B del-wsl, B del-wsl-ticked, B del-wsl-refused |
| Move folder to trash in Ubuntu | text | delete-project-ui.js:99 | B del-wsl, B del-wsl-ticked, B del-wsl-refused |
| Remove from AIB | text | delete-project-ui.js:112 | B del-wsl, B del-wsl-refused |
| Removes app from AIB. Its 2 chats move to Recently deleted. | text | (dynamic / fixture) | B del-wsl-ticked |
| This moves the folder Ubuntu: /home/u/app and everything in it to the trash in Ubuntu, so you can still get it back from there. | text | delete-project-ui.js:44 | B del-wsl-ticked |
| Remove and move folder to trash | text | delete-project-ui.js:125 | B del-wsl-ticked |
| Deleting the folder is not possible: This distro has no trash AIB can use for this folder | text | (dynamic / fixture) | B del-wsl-refused |
| Claude Code is not installed in Ubuntu. | text | chat.js:3613 | B nc-missing, B nc-node |
| Or install it yourself in Ubuntu: npm i -g @agentclientprotocol/claude-agent-acp Copy | text | wsl-settings-ui.js:1019 | B nc-missing, B nc-node |
| npm i -g @agentclientprotocol/claude-agent-acp | text | (dynamic / fixture) | B nc-missing, B nc-node |
| Set up Ubuntu in Settings | text | wsl-settings-ui.js:101 | B nc-missing, B nc-node, B nc-installing |
| A terminal in Ubuntu to install Claude Code | title | wsl-settings-ui.js:523 | B nc-missing, B nc-node |
| Settings > AIB Linking (WSL): the agents in Ubuntu, their installs and updates | title | chat.js:3744 | B nc-missing, B nc-node, B nc-installing |
| New chat | text | settings-ui.js:1163 | B nc-missing, B nc-node, B nc-installing, B nc-found +1 |
| Node.js 22 or newer is needed in Ubuntu to install Claude Code, and Ubuntu has no Node.js. | text | wsl-settings-ui.js:418 | B nc-node |
| Install Node.js in Ubuntu: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh \| bash && nvm install --lts Copy | text | wsl-settings-ui.js:542 | B nc-node |
| curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh \| bash && nvm install --lts | text | wsl-settings-ui.js:39 | B nc-node |
| Needs Node.js in Ubuntu first | title | wsl-ui.js:434 | B nc-node |
| Look for Node.js in Ubuntu again | title | wsl-ui.js:445 | B nc-node |
| Codex is not installed in Ubuntu. | text | chat.js:3613 | B nc-installing |
| Installing Codex in Ubuntu… Downloading and unpacking… | text | wsl-settings-ui.js:553 | B nc-installing |
| Or install it yourself in Ubuntu: npm i -g @agentclientprotocol/codex-acp Copy | text | wsl-settings-ui.js:1019 | B nc-installing |
| npm i -g @agentclientprotocol/codex-acp | text | (dynamic / fixture) | B nc-installing |
| Installing Codex in Ubuntu | aria | wsl-settings-ui.js:553 | B nc-installing |
| Stop the install and remove what it downloaded so far | title | wsl-ui.js:399 | B nc-installing |
| A terminal in Ubuntu to install Codex | title | wsl-settings-ui.js:523 | B nc-installing |
| Codex in Ubuntu (2.6.0), installed by AIB. | text | (dynamic / fixture) | B nc-found |
| Run Codex's own sign-in in a Ubuntu terminal | title | wsl-settings-ui.js:947 | B nc-found |
| Claude Code in Ubuntu (0.101.0), installed by AIB. | text | (dynamic / fixture) | B nc-update |
| AIB now uses Claude Code 0.102.0; Ubuntu has 0.101.0. | text | wsl-settings-ui.js:995 | B nc-update |
| Run Claude Code's own sign-in in a Ubuntu terminal | title | wsl-settings-ui.js:947 | B nc-update |
| Live, idle: fix the login form | text | (dynamic / fixture) | B status-words |
| 1h | text | (dynamic / fixture) | B status-words |
| · Claude Code | text | (dynamic / fixture) | B status-words |
| Live, your turn: fix the login form | text | (dynamic / fixture) | B status-words |
| Your turn | text | status-words.js:4 | B status-words |
| Live, working: fix the login form | text | (dynamic / fixture) | B status-words |
| Working · 3m | text | status-words.js:4 | B status-words |
| Saved (not running): fix the login form | text | (dynamic / fixture) | B status-words |
| Recovered after restart: fix the login form | text | (dynamic / fixture) | B status-words |
| Couldn't reopen: fix the login form | text | (dynamic / fixture) | B status-words |
| Couldn't reopen | text | status-words.js:29 | B status-words |
| Fix the login form | text | (dynamic / fixture) | B status-words |
| Ubuntu · ~/app | text | (dynamic / fixture) | B status-words |
| api | text | (dynamic / fixture) | B project-menu |
| app | text | (dynamic / fixture) | B project-menu |
| site | text | (dynamic / fixture) | B project-menu |
| Nothing needs you in any project | text | workspace-ui.js:1960 | B project-menu |
| Open inbox | text | workspace-ui.js:1963 | B project-menu |
| Filter projects | aria | workspace-ui.js:2765 | B project-menu |
| api Debian: /home/d/api 1 chats, 0 need you, 0 working | title | workspace-ui.js:1866 | B project-menu |
| Project options: api | title | (dynamic / fixture) | B project-menu |
| app Ubuntu: /home/u/app 1 chats, 0 need you, 0 working | title | workspace-ui.js:1866 | B project-menu |
| Project options: app | title | (dynamic / fixture) | B project-menu |
| site C:\work\site 1 chats, 0 need you, 0 working | title | workspace-ui.js:1866 | B project-menu |
| Project options: site | title | (dynamic / fixture) | B project-menu |
| Open the inbox: every chat that needs you (Alt+I) | title | workspace-ui.js:1963 | B project-menu |
| html | text | (dynamic / fixture) | B publish-failed |
| Publish failed | text | artifacts-ui.js:625 | B publish-failed |
| The publish did not finish | text | artifacts-ui.js:627 | B publish-failed |
| In a WSL project, publish by `content`: AIB cannot open files inside the distro. In this WSL project only `content` works: pass the text itself (HTML, SVG, Markdown, CSV, JSON or plain text); `path` is not supported, because AIB runs on Windows and cannot open files inside the distro. | text | (dynamic / fixture) | B publish-failed |
| View | text | (dynamic / fixture) | B publish-failed |

## Could not render or measure

- The native drop-down list: Windows draws an open <select>, not the page, so headless Chrome cannot capture it. The 'two distros' state shows the same element as an open list box (size = number of options); its option colours and overflow are measured on that list box.
- The Uninstall question is a native window.confirm. Its text was captured; it has no layout or styles to measure.
- Terminal panels (Node.js install, sign-in): the frame and title are real; the terminal content is a stand-in. xterm loads from the server in the app, and file: pages cannot load it, so the terminal text area itself was not measured.
- The new-chat WSL box and the chat-list rows come from chat.js, which cannot run outside the full app. They were rebuilt here from chat.js's own markup (renderWslAgentNote 3664-3760, rowStatus 4752-4790), with the real AIBWsl.installBox and AgentStatusWords.statusOf inside. A later change to chat.js would not show here.
- The Files tab of a WSL project (scope pill, Docs row, image/binary notices) was not rendered. files-ui.js needs workspace-ui, files-state, doc-links and the server's tree routes. Its WSL changes are the scope tooltip text 'Ubuntu: /home/u/app' (files-ui.js:822-825) and the binary note 'This is a binary file: it cannot be shown as text.' without an editor button (files-ui.js:2021-2025); both are listed in the copy table, not measured.
- The mockup has no light theme: its embedded theme.css has only the teal-dark block. So the mockup comparison is teal-dark only, and teal-light is compared with the app's Windows AIB Linking cards and the delete-project dialog.
- The task brief calls the default theme light; AIB's default is teal-dark (THEMES.md). Both teal-dark and teal-light were captured.
- Full-page shots grow the window until the content box stops scrolling. A blank band under the content in some tall shots comes from the capture, not from the app.

## Errors seen while rendering

```json
{}
```

Native dialogs answered during the run:

```json
{}
```