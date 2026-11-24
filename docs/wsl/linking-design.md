# AIB Linking (WSL): design

Status: design only, 2026-11-14 (branch `wsl/linking`). Mockup: `outputs/wsl-linking-mockup.html`. Builds on `docs/wsl/design.md`
(sections 11-12 override it) and `app/docs/WSL.md` ("Agent installs in the distro").

## 1. Decisions

1. **A new Settings section, "AIB Linking (WSL)"**, right under "AIB Linking" in the section list. It shows on Windows only, even
   when the PC has no WSL (it then explains how to get it). It is not folded into "AIB Linking": that page describes Windows
   programs, and putting several distros into the same cards would mix two PATHs, two accounts and two sets of installs in one row.
   A separate section keeps "AIB Linking" as it is and lets the WSL page use **the same agent cards** ("like normal").
2. **One group per usable distro** (a `.st-group` heading, as search results use) with five cards (section 4). A first card,
   "WSL on this PC", lists every distro, including the ones AIB cannot use (WSL1, musl such as `docker-desktop`) with the reason.
   Designed for one or two distros; more just stack.
3. **The agent rows are `settings-ui.js agentRow`**, fed from the distro instead of Windows: the same status chip (Ready, Needs
   sign-in, Not installed, Install failed), Install / Update / Cancel / Retry, progress bar, Sign in, Check again, Uninstall, the
   "Needs first:" list, the Copy line for doing it yourself. Only the wording names the distro ("Install in Ubuntu").
4. **The vendor CLIs are not prerequisites** for Claude Code or Codex (evidence in section 2): the ACP packages AIB installs carry
   the vendor's own program, and AIB's sign-in runs that copy. The checklist says so in a row of its own, so nobody installs a second
   copy thinking they must. A standalone `claude` / `codex` command for the terminal is an optional row with the vendor's command.
5. **Node.js 22+ with npm is the one hard prerequisite** for every AIB install in a distro. Its Install button runs the official
   nvm command in an AIB terminal panel on the card, in the distro, after showing it: the Linux form of the Windows card's
   `winget` button (`beta_setup.ts PREREQS.node`). One command for both places: `beta_setup.ts`'s Linux step (today
   `agent_install.ts NODE_INSTALL` uses nvm v0.40.3 and `nvm install 22`, Beta uses v0.41.0 and `--lts`: unify on one).
6. **Never sudo, never apt, never without a click.** git and curl (system packages) get the copyable `sudo apt install …` line,
   "Open Ubuntu terminal" and "Check again". Anything that writes outside `~/.aib-server` (nvm, a vendor installer) runs only from
   a button, with the command shown above the terminal panel before it starts.
7. **Opening Settings never starts a distro.** A distro AIB has not used since it started says "Not running. AIB starts it when a
   WSL project needs it." with **Start Ubuntu and check**; only that click starts it.
8. **Default distro for new WSL projects:** no new setting. WSL's own default distro (`*` in `wsl -l -v`) is listed first in the
   New project Location choice and is marked "WSL default" in the first card.
9. **Codex limits** for a distro are shown on that distro's Codex row (read from its `~/.codex`, the existing `codex.limits`),
   never merged with Windows'.
10. **Prior art:** UI on Windows, tools and sign-in per environment. VS Code puts a server in the distro and offers "Install in
    WSL: Ubuntu" per extension ([Developing in WSL](https://code.visualstudio.com/docs/remote/wsl),
    [Remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)); Claude Code's extension bundles its
    CLI yet tells WSL users to install in the distro ([Claude Code in VS Code](https://code.claude.com/docs/en/vs-code)); Codex has
    one switch, `chatgpt.runCodexInWindowsSubsystemForLinux` ([Codex IDE settings](https://developers.openai.com/codex/ide/settings));
    Zed runs a server per remote and leaves auth to each agent ([Zed remote](https://zed.dev/docs/remote-development),
    [external agents](https://zed.dev/docs/ai/external-agents)); JetBrains installs plugins on the WSL backend
    ([JetBrains remote](https://www.jetbrains.com/help/idea/remote-development-overview.html)). AIB takes VS Code's per-environment
    Install and adds one page with every agent of every environment side by side.

## 2. What each agent needs inside a distro (evidence)

Checked read-only on this PC's Ubuntu 24.04 (x86_64, glibc, WSL2, zsh login shell, Node 24.22.1 through asdf) and in the repo's
lockfiles.

| Agent | AIB installs | Vendor program | Hard prerequisites | Sign-in (in the distro) | Credentials |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp` 0.102.0 into `~/.aib-server/agents/claude/<ver>`, `npm ci` from `agents/locks/claude.package-lock.json` | **Bundled.** The lock pins `@anthropic-ai/claude-agent-sdk` and its 8 platform packages; on this distro `claude-agent-sdk-linux-x64/claude` is a 362 MB binary (package 425 MB in all) | Node >= 22 (`engines`), npm, glibc x64/arm64, ~1 GB free (`minFreeBytes`) | `node dist/index.js --cli auth login --claudeai` (`signin.ts DEFAULT_TERMINAL`) in a distro terminal; the page opens on Windows through the `aib-open` BROWSER shim | `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) in the distro: a separate login from Windows |
| Codex | `@agentclientprotocol/codex-acp` 2.6.0, lock `agents/locks/codex.package-lock.json` | **Bundled.** Depends on `@openai/codex` ^0.166 (0.166.0 here) with `codex-linux-x64`: a static musl `codex` binary plus its own `bwrap` sandbox (436 MB) | Node >= 22, npm, ~600 MB free | `codex login` from the bundled `@openai/codex/bin/codex.js`; status = `codex login status` exit code. The binary also has `--device-auth` (found in it), the fallback when the browser cannot reach the distro's callback | `~/.codex/auth.json` (or `CODEX_HOME`); limits from `~/.codex/sessions` |
| OMP | nothing (user's own) | `omp` on PATH | `omp` | its own | its own |
| Beta, npm: Copilot CLI, Gemini CLI, Qwen Code, Cline, Kimi Code (Node 22.19+), Kilo Code, OpenCode (native `@opencode/cli-linux-x64`, AVX2 UNCONFIRMED) | the package at the version in `agents/versions.json betaAgents`, no lockfile (Beta rule) | the package is the CLI | Node >= 22 (Kimi 22.19), npm | terminal (`copilot login`, `opencode auth login`, `cline auth`, `kimi login`, `kilo auth login`), agent (Gemini), key (Qwen) | each vendor's folder in the distro home |
| Beta, vendor installer: Cursor CLI, Goose, Mistral Vibe | nothing in `~/.aib-server`: the vendor's Linux command from `beta_catalog.ts vendorInstall` runs in a distro terminal panel | the vendor's | curl, bash (Vibe's script fetches uv and Python itself) | agent / key | vendor's; installs to `~/.local/bin` |

**"Special connectors" in practice:** the ACP adapter is the connector. For Claude Code and Codex it ships with the vendor CLI inside
it, so neither CLI is a prerequisite. Claude Code's own sandbox on Linux may want `bubblewrap`/`socat` (UNCONFIRMED for ACP use): an
optional row, never a block. git is not needed by any agent to start, but AIB needs it for a chat's own copy, Changes and Merge.

## 3. Prerequisites checklist (per distro)

States: **found** (with version), **missing**, **too old** (version shown), **blocked** (cannot be fixed from AIB), **optional**.
The helper answers all rows in one call (`env.prereqs`, below), re-reading the login PATH on Check again.

| Row | Needed for | Found when | Help when not |
| --- | --- | --- | --- |
| WSL 2 | everything | `wsl -l -v` says 2 | blocked on WSL1: "Ubuntu runs on WSL 1. AIB needs WSL 2." + copyable `wsl --set-version Ubuntu 2` (Windows PowerShell; takes minutes; back up first) |
| Linux type | everything | glibc, x86_64 or arm64 | blocked: "AIB cannot run in Alpine or other musl-based distros." |
| AIB helper | everything | helper ready, version matches | AIB installs it itself (first use); **Repair AIB helper** re-checks the SHA-256 of both programs and copies them again |
| Node.js 22+ and npm | installs of Claude Code, Codex, npm Beta agents | `node --version` >= 22 through the login PATH (asdf/mise shims followed), npm next to it | **Install Node.js 24 (LTS) in Ubuntu**: the nvm command in a terminal panel; Copy; Check again. Ubuntu's apt `nodejs` (18.x on 24.04) reads "too old" |
| npm | as above | `npm-cli.js` next to node | "npm was not found next to Node.js in Ubuntu." + the same button |
| curl | the nvm command, vendor installers | on PATH | `sudo apt install curl` (Copy) + Open Ubuntu terminal |
| git | a chat's own copy, Changes, Merge | on PATH | `sudo apt install git` (Copy); until then chats work in the project folder |
| Free space | installs | `df` of `~` | "Claude Code needs about 1 GB free in Ubuntu; 380 MB is free." |
| `claude` command | optional: Claude Code in your own terminal | on PATH (with version) | "Not needed for AIB chats: AIB's Claude Code includes it." + the vendor's command (Copy) and docs link |
| `codex` command | optional | on PATH | same, for Codex |

Checksums: AIB's installs stay `npm ci` with the reviewed lockfile. nvm is pinned to a tag and checks Node's tarball against
`SHASUMS256.txt`; AIB also ships the SHA-256 of the pinned `install.sh` and runs `curl -fsSLo "$t" <url> && echo "<sha256>  $t" |
sha256sum -c && bash "$t"`, so a changed script never runs. Vendor installers run as their docs give them, behind the Beta label.

## 4. Settings layout

Section list: `AIB Linking`, **`AIB Linking (WSL)`**, `Defaults`, ... Search keywords: wsl, ubuntu, linux, distro, node, nvm,
prerequisites, install, uninstall, remove, helper, codex limits.

1. **WSL on this PC** — lead line (copy list C1); one row per distro: letter, name, "WSL 2 · Ubuntu 24.04", chip (Ready /
   Starting / Not running / Stopped / Not supported), the reason when not usable, "WSL default" tag. Keep-alive line (C2).
2. Per usable distro, heading `UBUNTU`:
   - **Ubuntu**: facts list (State, Linux, AIB helper, AIB folder with size), buttons Reconnect (stopped), Start Ubuntu and check
     (not running), Repair AIB helper, Open Ubuntu terminal.
   - **What Ubuntu needs**: the checklist above, Remote control's check-list look (`.dv-checks`: a mark, the row, its help indented).
   - **Agents in Ubuntu**: Claude Code, Codex, OMP as agent cards. Tag "Installed by AIB" or "Your own install". Launcher line.
     Pinned version on Update ("AIB now uses Claude Code 0.102.0; Ubuntu has 0.98.1"). Uninstall only on AIB's own copy, with
     the Windows refusals (a chat open, a sign-in or install running). Codex: the limits line. Footer: "Your Windows agents are in
     AIB Linking." (link).
   - **Beta agents in Ubuntu**: the Beta note and the same Beta cards (cost line, Needs first, key box, sign-in terminal).
   - **AIB in Ubuntu**: what `~/.aib-server` holds and its size (programs, agents, npm cache, this AIB's chat copies), "Remove AIB
     from Ubuntu".
3. **No WSL on this PC**: one card (C3), copyable `wsl --install`, Microsoft's link, Check again.

**Remove AIB from Ubuntu** stops this AIB's keeper and helper in the distro and deletes its `data-<hash>` folder, `agents/` and
the npm cache; the shared program folders `<ver>/` only when no other AIB's `data-*` keeper runs (test builds and dev copies each
have one). Refused while a WSL chat works, while an install runs, or while a chat copy has uncommitted changes (they are listed by
project and chat; the chats' branches stay in each project's repo either way). Never touches `~/.claude`, `~/.codex`, the user's
own installs, nvm or any project folder. The next WSL project sets AIB up again.

**New-chat panel:** under "Claude Code is not installed in Ubuntu." the panel adds "Set up Ubuntu in Settings" (opens the section
with that distro's agent card in view, like `openAgent`). The Install button there stays.

**Settings > About** keeps its one line per distro, with "Details in AIB Linking (WSL)".

## 5. States

| State | Chip and line |
| --- | --- |
| Distro off (unused since AIB started) | "Not running" · "AIB starts it when a WSL project needs it." · Start Ubuntu and check |
| starting / installing / reconnecting | "Starting" · the host's line ("Setting up AIB in Ubuntu (first time, ~100 MB)") |
| ready | "Ready" · helper version |
| stopped | "Stopped" · "Ubuntu stopped (Windows restart or `wsl --shutdown`)." · Reconnect |
| unavailable | "Problem" · the host's note (checksum, wsl.exe) · Repair AIB helper |
| not supported (WSL1, musl) | "Not supported" · the reason · no group |
| Agent missing / blocked by Node | "Not installed" · Install in Ubuntu, off under "Needs first:" while Node.js is missing |
| installing, failed, update due | progress + Cancel · "Install failed" + npm's line + Retry · Ready + Update in Ubuntu + pinned line |
| own install / sign-in states | "Your own install", no Uninstall · Needs sign-in / Ready / Not checked as on Windows |

## 6. Copy list

- C1 lead: "Run Claude Code, Codex and the other ACP agents inside your WSL distros, next to your Windows agents, all on this PC.
  AIB installs them into its own folder in each distro (`~/.aib-server`), with the versions it reviewed."
- C2 keep-alive: "A distro keeps running while a WSL project is open or a WSL chat works, also after you quit AIB. When nothing
  works, AIB lets go and WSL stops it by its own rules."
- C3 no WSL: "WSL is not installed on this PC. With it, AIB runs agents in Linux on this PC, in projects inside a distro. Install it
  in an administrator PowerShell, then restart Windows:" `wsl --install`
- Vendor CLI row: "Not needed for AIB chats: AIB's Claude Code includes it. Install the `claude` command only to use Claude Code in
  your own terminal."
- Node button note: "This runs nvm's installer in Ubuntu. It adds nvm to your home folder and shell start-up file."
- Codex limits: "Usage limits of Ubuntu's Codex sign-in: 5 h 32% used · week 10% used (4 min ago). Same ChatGPT account as on
  Windows means the same limits."
- Codex sign-in fallback: "The sign-in page could not reach Ubuntu. Sign in with a code instead." (runs `codex login --device-auth`)
- Uninstall question: "Uninstall Claude Code from Ubuntu? This deletes the copy AIB installed there (420 MB). Your sign-in in
  Ubuntu's ~/.claude stays. Saved chats stay in the list."
- Remove question: "Remove AIB from Ubuntu? This stops AIB's helper there and deletes ~/.aib-server (1.4 GB): AIB's agents, its
  chat copies and its programs. Your projects, ~/.claude, ~/.codex and anything you installed yourself stay."
- Remove refusal: "2 chat copies in Ubuntu have changes that are not committed: app · Fix login, api · Add tests. Merge or discard
  them first."
- musl: "docker-desktop is Docker's own distro; AIB cannot run there."

## 7. Build plan

Routes (never start a distro unless the body says `start: true`): `GET /api/live/wsl/setup?distro[&force=1]` (all rows of one
distro), `POST /api/live/wsl/agents/uninstall`, `.../agents/signin/check`, `/wsl/repair`, `/wsl/remove` (each with `check`).
Helper methods: `env.prereqs`, `agents.uninstall` (installer.ts `uninstall`), `agents.signinStatus` (signin.ts rules, natively),
`aib.usage`, `aib.remove`, Beta rows in `agents.detect` / `agents.install`.

| Phase | What | Files (owner) | Days |
| --- | --- | --- | --- |
| 1, thin slice (ships first) | The section, "WSL on this PC", per-distro status card, "Agents in Ubuntu" from today's `/wsl/agents` (Install / Update / Cancel / Node line), the new-chat link, About link | page: new `wsl-settings-ui.js`, `settings-ui.js` (SECTIONS, INDEX, RENDER hook, export `agentRow`), `settings.css`, `chat.js` link | 3-4 |
| 2 | Checklist (`env.prereqs`), Node button in a distro terminal panel, unified nvm command with SHA-256, Uninstall, sign-in status, Codex limits line, Repair helper | A: `wsl/helper/methods.ts`, `helper/agent_install.ts`, `contract.ts`; B: `web/wsl_routes.ts`, `wsl/agent_install.ts`, new `wsl/setup.ts`, `agents/beta_setup.ts`; C: page | 5-6 |
| 3 | AIB in Ubuntu: usage, Remove (with refusals), old-version clean-up when no chat uses one | A: new `helper/aib_remove.ts`; B: `wsl/hosts.ts` (stop host, keep-alive), routes; C: page | 3-4 |
| 4 | Beta agents in distros: detect, npm installs, vendor installers in a distro panel, the three sign-in kinds | A: `helper/methods.ts` detect, `agent_install.ts` Beta path; B: `wsl/setup.ts`, `agents/beta_agents.ts` (WSL launch); C: page | 4-6 |

Total 15-20 days of work; with three builders (A Linux helper, B Windows routes, C page) about 7-9 calendar days. Contracts
(helper method shapes, route JSON) frozen on day 1; C builds on a FakeWslHost.

Tests: page `work/test_wsl_settings.js` (every mockup state, search, no Uninstall on an own install, no start call unless
clicked); Deno `wsl_setup_test` (FakeWslHost: rows, refusals, remove keeps other `data-*`); real WSL `wsl_linking_e2e`
(`AIB_WSL_E2E=Ubuntu`, `AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>`): stub node/npm on a stand-in login PATH (missing, old, found),
install then uninstall, sign-in status through a stub agent, remove with a second fake `data-*` kept and a dirty worktree refused,
nothing outside the temp root changed. Never the owner's `~/.aib-server`, `~/.claude`, `~/.codex`; never `wsl --shutdown`.

## 8. Open questions for the owner

1. **Should AIB keep its own copy of Node.js in each distro?** Every AIB install in a distro needs Node.js 22 or newer, and many
   distros have none or an old one (Ubuntu 24.04's own is 18). (a) AIB runs nvm's installer in a terminal panel on the card, like
   the Windows card runs winget: the person sees the command, nvm adds itself to their home and shell start-up file, and that
   Node.js is theirs to use too. (b) AIB downloads a pinned Node.js into `~/.aib-server/node` (about 100 MB, checked against a
   SHA-256 AIB ships) and uses it only for its own agents: one click, nothing in the shell files changes, and it works with any
   shell or version manager, but AIB then downloads and updates a runtime itself, which it has never done. Recommendation: (a) now,
   because it matches how Windows does it and adds nothing new to trust; (b) only if people report nvm trouble.
2. **Do Beta agents in a distro install without a reviewed lockfile, as on Windows?** AIB's distro installs today refuse anything
   without one. (a) Same rule as Windows Beta: pinned version, npm checks each package's own checksum, dependencies resolve within
   their ranges; all seven npm Beta agents work in a distro in phase 4. (b) A reviewed lockfile per Beta agent first: safer, but
   seven lockfiles to make and re-review on every version bump, and the Beta agents wait for it. Recommendation: (a), since the
   Beta heading already says "not tested by us".
3. **Should AIB also install the `claude` and `codex` commands for the terminal?** Chats never need them (the adapters carry their
   own copy), but someone who wants Claude Code or Codex in their own Ubuntu terminal has to install them separately. (a) Show
   them as optional rows with the vendor's command to copy and its docs link. (b) An Install button that runs the vendor's
   installer in a terminal panel: one click, but a second copy that updates itself, outside AIB's folder, and that AIB would have
   to explain next to its own. Recommendation: (a).

## 9. Owner words audit

1. "we don't have any place in the setting specific to WSL ACP connections ... how we organize that": a Settings section of its
   own, one group per distro, five cards each (decisions 1-2, section 4).
2. "on windows we add an AIB Linking (WSL) tab. and handle the installs and all that like normal": that exact name, Windows only,
   under AIB Linking; the agent rows are the Windows `agentRow` with the same Install / Update / Uninstall / Sign in / Check again
   and the same "Needs first:" help (decision 3); Node's button mirrors the Windows winget button (decision 5).
3. "what if the user doesn't even have claude cli or codex cli? ... prereqs for some of these ACPs that need special connectors":
   checked on a real install, the adapters carry both CLIs, so they are not prerequisites; the checklist says so in its own rows
   and offers the commands as optional; the real prerequisite (Node.js 22+ and npm) gets one-click help (sections 2-3).

Added beyond the owner's words (flagged): the "WSL on this PC" overview with unsupported distros; the no-WSL card with
`wsl --install`; the WSL1 convert command; git, curl and free-space rows; the optional standalone CLI rows; Repair AIB helper;
"Start Ubuntu and check" (Settings never starts a distro by itself); the "AIB in Ubuntu" card with disk use and Remove AIB from
Ubuntu; old-version clean-up; the Codex limits line per distro; sign-in status checks in the distro and the Codex `--device-auth`
fallback; the SHA-256 pin of nvm's installer; the new-chat "Set up Ubuntu in Settings" link and the About link; WSL's default distro
listed first in New project (no new setting).

## 11. Architect review addendum and owner decisions (these override earlier sections)

**Owner decisions:** (1a) Node.js comes from nvm's official installer run in a terminal panel on the card (like Windows' winget), no AIB-downloaded runtime; (2a) Beta agents install in a distro under the same rule as Windows Beta (pinned version, npm's own checksums); (3a) the standalone `claude`/`codex` commands are optional rows with the vendor's command to copy + docs link; AIB never installs them.
**Lead defaults for the review's three open points (owner may overrule):** Kilo, Cline and Kimi (install scripts / per-platform native binaries) stay "not in distros yet" until verified; one on/off switch per agent for Windows and every distro (as the code does today); Remove only deletes this AIB's own `data-<hash>` part, never other AIB data folders (no 'remove everything' option).

**Required before/while building (from the architect review, evidence file:line in the review):**
1. `GET /api/live/wsl/agents` and the WSL sign-in terminal must not start a distro (web/wsl_routes.ts:157 `hostWhenReady`, wsl/access.ts:68, terminal_routes.ts:192): add `peek=1` (built on `peekWslHost`): not ready -> `{state, line, agents: []}`; start only with an explicit `start:true`. Page test: opening Settings makes no start call.
2. `/api/live/wsl/status` gains `skipped:[{name,why}]`, per-distro `isDefault`, and `wsl:{exe:boolean, problem}` (detect.ts already reads them from the registry; never run wsl.exe for the page).
3. `agentRow` (settings-ui.js) takes an env adapter (job store, sign-in store, install/cancel/uninstall/check, key namespace), toggle shown per the one-switch default; distro job state lives only in wsl-ui.js; the Beta key box says "uses your Windows key".
4. Codex detection in a distro: add `@agentclientprotocol/codex-acp` to the global lookup (adapters.ts:30,:536) and resolve an asdf/mise shim to `[realNode, entry]` (installer.ts nodeExecPath) so `findCodexCli` (signin.ts:196) finds the bundled CLI; the 'standalone CLI not needed' row shows only when the bundled CLI was actually found. Fix the install hint package name (access.ts:216).
5. Remove spec: only this AIB's `data-<hash>`; `agents/`, `agents/.npm-cache`, `<ver>/` are shared by all AIB data folders: delete `agents/` only when no other `data-*` keeper is alive (keeper.lock/keeper.sock) and no process runs from it (/proc/*/cmdline). Order: dry-run refusals -> host.stop() + 'removed' flag so wslHost() cannot restart/reinstall -> stop keep-alive -> stop Linux keeper. Refuse on uncommitted worktree changes (incl. untracked) and working chats; `git worktree prune` in each project repo; mark this AIB's WSL chat records removed; never touch ~/.claude, ~/.codex, nvm, asdf; report partial failure honestly.
6. One Node command: nvm pinned with the install.sh SHA-256, `PROFILE=` set explicitly, `--lts`, minimum Node 22.19 (Kimi). If the found node is a version-manager shim (asdf/mise) never offer nvm: show 'asdf has no Node.js version set' + the asdf command. New terminal route branch `setup=wsl-node&distro=` through `ctx.terminals.attachWsl` (sessions.ts:618); terminal-ui.js:1288 must keep `distro` when `step` is set; after exit 0 call `agents.installCheck {force:true}` (refreshPath).
7. Freeze before phase 2 (contract.ts, co-owned A+B): `env.prereqs`, `agents.uninstall`, `agents.signinStatus`, `aib.usage`, `aib.remove`.
8. Beta in distros: the helper already accepts `lock:null`; what refuses is the agent-id lists (`WSL_MANAGED`, helper/agent_install.ts:25 and wsl/agent_install.ts:17, `installParams` ignores `betaAgents`). Claude Code and Codex installs must REQUIRE a lockfile in the helper (hardening). Kilo/Cline need `native` maps (beta_catalog.ts:348,:379); Kimi has an unknown postinstall; Gemini's node-pty has no linux-arm64 prebuild; Copilot/Gemini/Qwen have no scripts.
9. Corrections to this doc: the measured 0.102.0/425 MB figures are the owner's own 0.107.1 global install, not an AIB install (AIB has installed nothing there yet); the 'bundled claude binary' for AIB's own pinned install must be verified in a temp root before the design claims it; NODE_LTS_MAJOR is 26 (beta_setup.ts:31); WSL version/default come from the registry; Linux arch must match the Windows build's arch; old-version cleanup already exists (CLEANUP_SCRIPT, cleanOldVersions); 'Start Ubuntu and check' copies ~100 MB and starts keeper/helper/keep-alive: say so; config-ui.js is unrelated to Settings sections; Codex package is ~457 MB.

**Phases (3 builders):** P1 (5-6 d): peek mode, status fields, Codex detection fix, row refactor, the section + distro cards + Install/Update/Cancel + new-chat and About links. P2 (6-7 d): prereqs checklist, Node panel, uninstall, signin status, Codex limits. P3 (4-5 d): AIB-in-distro card + Remove. P4 (6-8 d): Beta in distros. Realistic total 21-26 days (~9-11 calendar days with 3 builders).

## 12. Phase 2 decisions and contract (owner decisions 2026-11-15; these override earlier sections)

**Owner decisions:** (a) **A separate On/Off switch for each distro** per agent (Claude on in Ubuntu and off on Windows is allowed); the Windows switch is unchanged. (b) **A drop-down of all the user's distros at the top of the AIB Linking (WSL) page**: it picks which distro the page shows (one distro's cards at a time); the 'WSL on this PC' overview stays as a compact card or a section under the drop-down; the choice is remembered. Default selection: the distro of the open project's chat if any, else WSL's default distro, else the first usable.

**Routes (server builder implements; page builder uses fakes of exactly these shapes):**
- `GET /api/live/wsl/agents?distro=&peek=1[&start=1][&force=1]` rows gain: `enabled: boolean` (the per-distro switch), `signin: {state: 'signed_in'|'signed_out'|'unknown', account?: string, note?: string}` (ready distros only; from `agents.signinStatus`), `canUninstall: boolean`, `limits?: <same shape the Windows Codex limits chip uses>|null` (Codex row only, read from that distro's ~/.codex, never merged with Windows).
- `POST /api/live/wsl/agents/enabled {distro, id, enabled}` -> `{ok, enabled}`; stored per distro in AIB settings store (e.g. `agentsByDistro: {"<distro key>": {"<agent id>": boolean}}`); default for an agent in a distro with no saved value = ON (as today). AIB's WSL chat start/agent picker for a WSL project MUST read the per-distro value, not the Windows one (host/aib.ts ~867-870).
- `POST /api/live/wsl/agents/uninstall {distro, id}` -> `{ok, removed, message?, blocked?}` (helper `agents.uninstall`; refused while a chat of ANY AIB data folder runs from that agent's folder: /proc/*/cmdline check; never touches the user's own installs).
- `GET /api/live/wsl/prereqs?distro=&peek=1[&start=1][&force=1]` -> not ready: `{distro, name, state, line, prereqs: null}`; ready: `{distro, name, state: 'ready', line: '', prereqs: EnvPrereqs}` (helper `env.prereqs`).
- Node install button: terminal route `/api/live/terminal?setup=wsl-node&distro=<d>` through `ctx.terminals.attachWsl`: runs nvm's official installer pinned by the install.sh SHA-256 with `PROFILE=` set explicitly to the file for the distro user's login shell, then `nvm install --lts` (minimum Node 22.19); never when `canInstallNode` is false; after exit 0 the page calls `prereqs?force=1` (helper refreshPath).
- Sign-in terminal: unchanged (`signin=<agent>&distro=<d>[&start=1]`).
- contract.ts (helper methods `env.prereqs`, `agents.uninstall`, `agents.signinStatus`, type `EnvPrereqs`) is FROZEN as committed; additions only.

**First task for the helper builder (item 8 of the architect review): VERIFY, do not assume, whether AIB's own pinned Claude Code install (agents/versions.json + agents/locks/claude.package-lock.json: claude-agent-acp 0.102.0 + SDK) carries its own `claude` program inside its node_modules when installed with `npm ci --ignore-scripts` on Linux; and whether it can be signed in with it (`claude auth login`-style command exists in that bundled program: check `--help`, do not log in). Do it ONCE in a temp root under /tmp/aib-wsl-test-* in the distro (needs ~1-2 GB free: check with df first; network allowed for this single install; delete afterwards). Record the result in WSL.md and the design doc (what is bundled, sizes, the exact sign-in command). If the bundled program is missing, say so: the 'standalone command is not needed' copy must then change.**

**Verified 2026-11-15 (helper builder; one real `agents.install` of each pinned entry in `/tmp/aib-wsl-test-<random>` on this PC's
Ubuntu 24.04 x86_64, Node 24.22.1 via asdf; only `--help` run, with a throwaway HOME; nothing signed in; the temp root removed and
checked gone). Both vendor programs ARE bundled in AIB's own installs, so "The standalone claude command is not needed" holds:**
- Claude Code 0.102.0 (`npm ci --ignore-scripts`, 31 s, 404 MB): `@anthropic-ai/claude-agent-sdk-linux-x64/claude`, a 342 MB glibc
  ELF (Claude Code 2.1.321; package 327 MB). The linux-x64 optionalDependency was installed with scripts off; no musl and no other
  platform package was fetched. Sign-in: `claude auth login` (`--claudeai` default, `--console`, `--sso`, `--email <email>`), status
  `claude auth status`, `claude auth logout`; AIB's route stays `node dist/index.js --cli auth login --claudeai` (not re-run here).
- Codex 2.6.0 (25 s, 457 MB): `@openai/codex` 0.166.0 `bin/codex.js` with `@openai/codex-linux-x64` (436 MB: a static musl `codex`
  plus its own `bwrap` and `rg`; the package ships only that musl build, which runs on glibc). Sign-in: `codex login`, with
  `--device-auth` listed (also `--with-api-key`, `--with-access-token`); status `codex login status`.
- Corrects section 2: the sizes above are AIB's pinned installs (not the owner's global 0.107.1); npm's cache took 330 MB more.

## 13. Phase 3 contract: the "AIB in <distro>" card and Remove (owner: phase 3 only; phase 4 (Beta agents) is SKIPPED)

**Card (page):** at the bottom of each distro's group: 'AIB in Ubuntu': disk use by part (helper/keeper versions, installed agents, npm cache, this AIB's data folder, chat worktrees, logs; total), a note listing OTHER AIB data folders found in the distro (read-only: name, size, whether their keeper is alive: 'used by another AIB build'), and **Remove AIB from Ubuntu** (confirm dialog listing exactly what will be deleted, with sizes, and what is kept). After a successful removal the distro group shows 'AIB is not set up in Ubuntu' with a **Set up again** button (= Start Ubuntu and check, which reinstalls the helper); the distro stays selectable. Copy: clear and concrete, no puns.

**Routes (server builder implements; page builder uses fakes of exactly these shapes):**
- `GET /api/live/wsl/aib?distro=&peek=1[&start=1][&force=1]`: not ready: `{distro, name, state, line, usage: null}`; ready: `{distro, name, state: 'ready', line: '', usage: AibUsage}` where
  `AibUsage = {root: string, totalBytes: number, current: string /* this AIB's <ver> */, parts: [{key: 'versions'|'agents'|'npmCache'|'data'|'worktrees'|'logs'|'other', label: string, bytes: number, path: string}], versions: string[], agents: [{id: string, versions: string[], bytes: number}], dataFolders: [{name: string, mine: boolean, keeperAlive: boolean, bytes: number}], worktrees: {count: number, dirty: number /* chat copies with uncommitted changes incl. untracked */}, chatsWorking: number /* WSL chats of this AIB working now */}`. Never starts a distro on peek.
- `POST /api/live/wsl/aib/remove {distro, mode: 'check'|'apply', confirm?: boolean}` -> 200 `{ok: boolean, mode, blocked: string[], wouldRemove: [{path: string, what: string, bytes: number}], kept: [{path: string, why: string}], removed: string[], left: string[], message?: string}`. 'check' never deletes. 'apply' requires `confirm: true`, re-runs every refusal, and returns `ok:false` + `blocked` (reasons verbatim, one per line) instead of deleting when any applies; on partial failure `ok:false`, `removed` = what went, `left` = what could not be removed and why in `message`. Never starts a distro (409 `wsl_unavailable` if not ready).
- `GET /api/live/wsl/status` distros gain `removed: boolean`: this AIB removed itself from that distro (cleared by the next start); state then reads 'off'.

**Remove rules (architect review, all required):** only this AIB's own `data-<hash>` folder (+ its worktrees, keeper journals, helper run dir) is removed; the SHARED parts (`agents/`, `agents/.npm-cache`, `<ver>/` folders, the root itself) are deleted only when (a) no OTHER `data-*` keeper is alive (try keeper.lock / connect keeper.sock) and (b) no process runs from them (read /proc via the permitted way, see helper/bgtasks.ts: ps/readlink/find) and (c) nothing of another AIB data folder lists them as in use; otherwise they are KEPT and listed in `kept` with the reason. REFUSE (blocked) while: a WSL chat of this AIB is working, an install job or sign-in/Node terminal runs, a chat worktree has uncommitted changes (incl. untracked), the keeper holds a live chat. NEVER touch ~/.claude, ~/.codex, project folders, nvm/asdf, other AIB data folders, or anything outside the root (realpath-checked, no symlink escape, never rm outside the root; the root itself only when empty and nothing else uses it). Order of apply: dry-run refusals -> Windows: set the 'removed' flag so wslHost() cannot restart/reinstall, stop the keep-alive -> `git worktree prune` in each project repo that had chat worktrees (so chat branches are not left 'checked out'; the branches themselves are never deleted) -> delete -> stop the Linux keeper and the helper (the helper cannot delete its own running keeper's socket: design the last step explicitly; deleting a running binary on Linux is fine) -> mark this AIB's WSL chat records removed (wslIsRemoved exists) -> report. Partial failure: say what was left, never leave the host half-started (state 'off' + removed flag), idempotent re-run. Everything deleted is listed first in 'check'.
