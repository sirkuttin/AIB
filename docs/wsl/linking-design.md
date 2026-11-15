# AIB Linking (WSL): design

Status: design only, 2026-11-14 (branch `wsl/linking`). Mockup: `outputs/wsl-linking-mockup.html`. Builds on `docs/wsl/design.md`
(sections 11-12 override it) and `outputs/agent-studio/docs/WSL.md` ("Agent installs in the distro").

## 1. Decisions

1. **A new Settings section, "AIB Linking (WSL)"**, right under "AIB Linking" in the section list. It shows on Windows only, even
   when the PC has no WSL (it then explains how to get it). It is not folded into "AIB Linking": that page describes Windows
   programs, and putting several distros into the same cards would mix two PATHs, two accounts and two sets of installs in one row.
   A separate section keeps "AIB Linking" as it is and lets the WSL page use **the same agent cards** ("like normal").
2. **One group per usable distro** (a `.st-group` heading, as the search results use), each with five cards: the distro's status,
   "What Ubuntu needs", "Agents in Ubuntu", "Beta agents in Ubuntu", "AIB in Ubuntu" (disk use and removal). A first card, "WSL on
   this PC", lists every distro in one line each, including the ones AIB cannot use (WSL1, musl distros such as `docker-desktop`)
   with the reason. The section is designed for one or two distros; three or more just stack.
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
10. **Prior art** agrees on the split: the UI stays on Windows, the tools install per environment, sign-in is per environment.
    VS Code installs a server in the distro and marks Windows-only extensions with an "Install in WSL: Ubuntu" button
    ([VS Code: Developing in WSL](https://code.visualstudio.com/docs/remote/wsl),
    [Remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)). Claude Code's VS Code extension
    bundles its CLI but tells WSL users to install inside the distro
    ([Claude Code in VS Code](https://code.claude.com/docs/en/vs-code)). The Codex extension has one Windows switch,
    `chatgpt.runCodexInWindowsSubsystemForLinux` ([Codex IDE settings](https://developers.openai.com/codex/ide/settings)). Zed runs
    a headless server per remote and leaves agent auth to each agent, "locally, remotely, or through their own sign-in flow"
    ([Zed remote development](https://zed.dev/docs/remote-development), [Zed external agents](https://zed.dev/docs/ai/external-agents)).
    JetBrains runs the IDE backend in WSL and installs functional plugins on that backend
    ([JetBrains remote development](https://www.jetbrains.com/help/idea/remote-development-overview.html)). AIB copies VS Code's
    visible "Install in Ubuntu" per environment and goes past all of them on one point: one page shows every agent of every
    environment side by side.

## 2. What each agent needs inside a distro (evidence)

Checked read-only on this PC's Ubuntu 24.04 (x86_64, glibc, WSL2, zsh login shell, Node 24.22.1 through asdf) and in the repo's
lockfiles.

| Agent | AIB installs | Vendor program | Hard prerequisites | Sign-in (in the distro) | Credentials |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp` 0.102.0 into `~/.aib-server/agents/claude/<ver>`, `npm ci` from `agent_locks/claude.package-lock.json` | **Bundled.** The lock pins `@anthropic-ai/claude-agent-sdk` and its 8 platform packages; on this distro `claude-agent-sdk-linux-x64/claude` is a 362 MB binary (package 425 MB in all) | Node >= 22 (`engines`), npm, glibc x64/arm64, ~1 GB free (`minFreeBytes`) | `node dist/index.js --cli auth login --claudeai` (`signin.ts DEFAULT_TERMINAL`) in a distro terminal; the page opens on Windows through the `aib-open` BROWSER shim | `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) in the distro: a separate login from Windows |
| Codex | `@agentclientprotocol/codex-acp` 2.6.0, lock `agent_locks/codex.package-lock.json` | **Bundled.** Depends on `@openai/codex` ^0.166 (0.166.0 here) with `codex-linux-x64`: a static musl `codex` binary plus its own `bwrap` sandbox (436 MB) | Node >= 22, npm, ~600 MB free | `codex login` from the bundled `@openai/codex/bin/codex.js`; status = `codex login status` exit code. The binary also has `--device-auth` (found in it), the fallback when the browser cannot reach the distro's callback | `~/.codex/auth.json` (or `CODEX_HOME`); limits from `~/.codex/sessions` |
| OMP | nothing (user's own) | `omp` on PATH | `omp` | its own | its own |
| Beta, npm: Copilot CLI, Gemini CLI, Qwen Code, Cline, Kimi Code (Node 22.19+), Kilo Code, OpenCode (native `@opencode/cli-linux-x64`, AVX2 UNCONFIRMED) | the package at the version in `agent_versions.json betaAgents`, no lockfile (Beta rule) | the package is the CLI | Node >= 22 (Kimi 22.19), npm | terminal (`copilot login`, `opencode auth login`, `cline auth`, `kimi login`, `kilo auth login`), agent (Gemini), key (Qwen) | each vendor's folder in the distro home |
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

Checksums policy: AIB's own installs keep `npm ci` with the reviewed lockfile (every download has an integrity hash). The nvm
command pins a tag; nvm itself checks the Node tarball against nodejs.org's `SHASUMS256.txt`. Build step: AIB ships the SHA-256 of
the pinned `install.sh` and the command becomes `curl -fsSLo "$t" <url> && echo "<sha256>  $t" | sha256sum -c && bash "$t"`, so a
changed script never runs. Vendor installers (Cursor, Goose, Vibe) run as their docs give them, behind the Beta label.

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

| Where | State | What shows |
| --- | --- | --- |
| Distro | off (not used since AIB started) | chip "Not running"; "AIB starts it when a WSL project needs it."; Start Ubuntu and check |
| | starting / installing | chip "Starting"; "Starting Ubuntu…" / "Setting up AIB in Ubuntu (first time, ~100 MB)" |
| | ready | chip "Ready"; helper version |
| | reconnecting | chip "Starting"; "Reconnecting to Ubuntu…" |
| | stopped | chip "Stopped"; "Ubuntu stopped (Windows restart or `wsl --shutdown`)."; Reconnect |
| | unavailable | chip "Problem"; the host's note (helper failed its checksum, wsl.exe missing); Repair AIB helper |
| | not supported | chip "Not supported"; WSL1 or musl reason; no group |
| Agent | missing, installable | "Not installed" + Install in Ubuntu |
| | blocked by Node | Install off, "Needs first:" Node.js row with its button |
| | installing / updating | progress bar, stage line, Cancel |
| | failed | "Install failed" + npm's line + Retry |
| | update due | Ready + Update in Ubuntu + pinned line |
| | found, own install | "Your own install"; no Uninstall |
| | needs sign-in / ready / not checked | as on Windows; Sign in runs in a distro terminal |
| Page | distro gone from `wsl -l` | its group is dropped; open chats show their existing line |

## 6. Copy list

- C1 lead: "Run Claude Code, Codex and the other ACP agents inside your WSL distros, next to your Windows agents, all on this PC.
  AIB installs them into its own folder in each distro (`~/.aib-server`), with the versions it reviewed."
- C2 keep-alive: "A distro keeps running while a WSL project is open or a WSL chat works, also after you quit AIB. When nothing
  works, AIB lets go and WSL stops it by its own rules."
- C3 no WSL: "WSL is not installed on this PC. With it, AIB runs agents in Linux on this PC, in projects inside a distro. Install it
  in an administrator PowerShell, then restart Windows:" `wsl --install`
- Vendor CLI row: "Not needed for AIB chats: AIB's Claude Code includes it. Install the `claude` command only to use Claude Code in
  your own terminal."
- Install title: "AIB installs Claude Code 0.102.0 into its own folder in Ubuntu (~/.aib-server/agents). Nothing else in Ubuntu
  changes."
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
- WSL1: "Ubuntu runs on WSL 1. AIB needs WSL 2. Convert it in PowerShell (takes a few minutes): `wsl --set-version Ubuntu 2`"
- musl: "docker-desktop is Docker's own distro; AIB cannot run there."

## 7. Build plan

New routes (Studio token, never start a distro unless the body says `start: true`): `GET /api/live/wsl/setup?distro[&force=1]`
(prereqs, built-in and Beta agent rows with install, sign-in and limits facts, folder usage), `POST /api/live/wsl/agents/uninstall
{distro, agent, check?}`, `POST /api/live/wsl/agents/signin/check`, `POST /api/live/wsl/repair`, `POST /api/live/wsl/remove
{distro, check?}`. Helper methods (`contract.ts`): `env.prereqs`, `agents.uninstall` (installer.ts `uninstall`, open-chat count
from AIB), `agents.signinStatus` (signin.ts status rules run natively), `aib.usage`, `aib.remove`; Beta: `agents.detect` with the
catalog's Linux commands, `agents.install` for Beta npm packages.

| Phase | What | Files (owner) | Days |
| --- | --- | --- | --- |
| 1, thin slice (ships first) | The section, "WSL on this PC", per-distro status card, "Agents in Ubuntu" from today's `/wsl/agents` (Install / Update / Cancel / Node line), the new-chat link, About link | page: new `wsl-settings-ui.js`, `settings-ui.js` (SECTIONS, INDEX, RENDER hook, export `agentRow`), `settings.css`, `chat.js` link | 3-4 |
| 2 | Checklist (`env.prereqs`), Node button in a distro terminal panel, unified nvm command with SHA-256, Uninstall, sign-in status, Codex limits line, Repair helper | A: `wsl/helper/methods.ts`, `helper/agent_install.ts`, `contract.ts`; B: `web/wsl_routes.ts`, `wsl/agent_install.ts`, new `wsl/setup.ts`, `agents/beta_setup.ts`; C: page | 5-6 |
| 3 | AIB in Ubuntu: usage, Remove (with refusals), old-version clean-up when no chat uses one | A: new `helper/aib_remove.ts`; B: `wsl/hosts.ts` (stop host, keep-alive), routes; C: page | 3-4 |
| 4 | Beta agents in distros: detect, npm installs, vendor installers in a distro panel, the three sign-in kinds | A: `helper/methods.ts` detect, `agent_install.ts` Beta path; B: `wsl/setup.ts`, `agents/beta_agents.ts` (WSL launch); C: page | 4-6 |

Total 15-20 days of work; with three builders (A Linux helper, B Windows routes, C page) about 7-9 calendar days. Contracts
(helper method shapes, route JSON) frozen on day 1; C builds on a FakeWslHost.

Tests: page `node --test work/test_wsl_settings.js` (every state of the mockup, the search index, no Uninstall on an own install,
Settings never calls a start route by itself); Deno unit `wsl_setup_test` (FakeWslHost: prereq rows, refusals, remove keeps other
`data-*`); real WSL `wsl_linking_e2e` with `AIB_WSL_E2E=Ubuntu` and `AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>`: stub node/npm on a
stand-in login PATH (missing, too old, found), install then uninstall into the temp root, sign-in status through a stub agent,
`aib.remove` in the temp root with a second fake `data-*` left alone and a dirty worktree refused, and a check that nothing outside
the temp root changed. Never the owner's `~/.aib-server`, `~/.claude` or `~/.codex`; never `wsl --shutdown`.

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
