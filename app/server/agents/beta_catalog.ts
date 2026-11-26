/**
 * The Beta agents: ACP agents AIB can start but the owner has not tested. A static list, shipped with AIB: AIB never fetches the ACP
 * registry at run time. Every agent here is OFF until the person turns it on in Settings > AIB Linking > Beta agents.
 *
 * Source of the commands, packages, versions and licences: the ACP registry
 * (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json, read 2026-11-11) plus the research notes of the beta-agents
 * brief. Anything marked UNCONFIRMED below was not in the registry and was not checked against a real install (the owner's rule: no
 * installs); fix it here when someone tries the agent for real.
 *
 * No imports: adapters.ts, agent_registry.ts and the installer read this file, and it must not pull any of them in.
 *
 *   id         the provider id chats are stored under (never changes; not a custom-* id, so it never collides with an added agent)
 *   npm        an npm package AIB can install into its own folder (<state>/agents/<id>/<version>/, the Claude Code / Codex mechanism)
 *              and run with node; `version` is the exact version the registry lists. `bin` is the package.json bin name to run.
 *   commands   program names looked up on PATH (Windows: .exe first, then the .cmd/.bat npm shims, which are started through cmd.exe)
 *   known      install folders that are not always on PATH (Windows), relative to an environment variable
 *   args       the ACP arguments
 *   install    the official install command shown (copyable) when the agent is not found
 *   release    a native program AIB downloads from the vendor's GitHub release and checks against a SHA-256 pinned here (Maki);
 *              the only binary AIB downloads itself (vendor install scripts only ever run in a terminal panel the person watches)
 *   signin     terminal: the agent's own login command runs in an AIB terminal panel (ACP auth type "terminal");
 *              agent: ACP `authenticate` on a short-lived agent process (the agent opens the browser itself);
 *              key: an API key the person types in Settings, passed to the agent as an environment variable
 *   signinDirs where it keeps its sign-in under the home folder (signinEnv: the variables that move it); blocked for paired computers
 */

export type SigninKind = 'terminal' | 'agent' | 'key';

export interface BetaNpm {
  readonly package: string;
  readonly version: string;
  /** The package.json `bin` name to run (the first bin is used when this one is missing). */
  readonly bin: string;
  /** The entry file used only when package.json has no usable `bin` (UNCONFIRMED for every package: a guess). */
  readonly entry: string;
  /** The lowest Node.js the package runs on, when it asks for more than AIB's MIN_NODE_MAJOR (its package.json `engines.node`). */
  readonly minNode?: string;
  /**
   * A package whose bin is a placeholder its postinstall replaces (AIB installs with --ignore-scripts): the program to run is the
   * native binary in its platform package, which npm installs as an optional dependency. Keyed `<Deno.build.os>-<Deno.build.arch>`;
   * the value is the path under the install folder's node_modules. Started directly, not with node.
   */
  readonly native?: Readonly<Record<string, readonly string[]>>;
}

export type OsName = 'windows' | 'darwin' | 'linux';

/** One command AIB runs in an AIB terminal panel on the card (the person sees it first and watches its output). */
export interface BetaSetupStep {
  /** powershell: Windows PowerShell -Command; bash / sh: -c. */
  readonly shell: 'powershell' | 'bash' | 'sh';
  readonly command: string;
  /** Prerequisites (beta_setup.ts PREREQS ids) that must be on this computer first. */
  readonly needs?: readonly string[];
}

/** The vendor's own installer, per OS, for an agent with no npm package AIB can install (from the vendor's docs only). */
export interface BetaVendorInstall {
  readonly windows?: BetaSetupStep;
  readonly darwin?: BetaSetupStep;
  readonly linux?: BetaSetupStep;
  /** The official page the commands come from. */
  readonly source: string;
  /** The vendor's uninstall instructions, when it documents them (AIB never deletes what it did not install). */
  readonly uninstallDocs?: string;
}

/**
 * One download of a release: its file name and the checksum AIB checks before anything in it is used (SHA-256, SHA-512 or both; at
 * least one). A GitHub release asset is fetched from github.com; one with `url` (Antigravity) from that exact address, which must be on
 * a host release_install.ts allows.
 */
export interface BetaReleaseAsset {
  readonly file: string;
  /** Lower-case hex SHA-256 of the archive, copied from the release (GitHub's asset digest and the release's own sha256sums.txt). */
  readonly sha256?: string;
  /** Lower-case hex SHA-512 of the download, copied from the vendor's own release manifest (Antigravity). */
  readonly sha512?: string;
  /** The full https address of the download, when it is not a GitHub release asset. */
  readonly url?: string;
  /** The archive's size in bytes (progress, and a download that grows past it is stopped). */
  readonly bytes: number;
}

/**
 * A native program AIB installs itself from the vendor's GitHub release (no npm package, no install script): Install downloads the
 * archive for this computer from https://github.com/<repo>/releases/download/<tag>/<file>, checks its SHA-256 against the value
 * pinned here, and unpacks only `program` into <state>/agents/<id>/<version>/ (installer.ts, release_install.ts).
 */
export interface BetaRelease {
  /** owner/name on github.com ('' when every asset has its own `url`). */
  readonly repo: string;
  readonly tag: string;
  /** Who publishes the download, for the card's error lines ('GitHub' when not set). */
  readonly host?: string;
  /**
   * The program's name inside an archive when it differs from `program` (Antigravity's .tar.gz holds `antigravity`; AIB installs it
   * as `agy`). A download that is the program itself (a .exe) is used as it is.
   */
  readonly inner?: string;
  /** The version folder name. */
  readonly version: string;
  /** The program's file name inside the archive and in the install folder (Windows adds .exe). */
  readonly program: string;
  /** Keyed `<Deno.build.os>-<Deno.build.arch>`; a computer with no entry gets the install command and docs link only. */
  readonly assets: Readonly<Record<string, BetaReleaseAsset>>;
}

export interface BetaKnownPath {
  /** Environment variable the path starts from (USERPROFILE, LOCALAPPDATA, APPDATA). */
  readonly base: string;
  readonly parts: readonly string[];
}

export interface BetaSignin {
  readonly kind: SigninKind;
  /**
   * Arguments of the agent's own login command (terminal), right after the agent's program (a login subcommand: `copilot login`).
   * Only used when the agent advertises no terminal auth method; an advertised method's args go after the full ACP launch command.
   */
  readonly terminalArgs?: readonly string[];
  /** The environment variable an API key goes into. */
  readonly keyEnv?: string;
  /** The provider's official page where that key is made (the card's "Get an API key" link). Every agent with keyEnv has one. */
  readonly keyUrl?: string;
  /** The environment variable an optional API address goes into (the card's "API address" field), with the address to suggest. */
  readonly baseUrlEnv?: string;
  readonly baseUrlHint?: string;
  /** The ACP auth method that takes that key in `_meta['api-key']` (Gemini's shape). */
  readonly keyMethod?: string;
  /** The agent-type ACP auth method the Sign in button runs. */
  readonly method?: string;
}

export interface BetaAgent {
  readonly id: string;
  readonly name: string;
  readonly letter: string;
  readonly license: string;
  /** The small line on the agent's card. */
  readonly cost: string;
  /** One more plain line on the card, when the agent needs one. */
  readonly note?: string;
  readonly npm?: BetaNpm;
  /** A native program AIB installs from the vendor's GitHub release, checked by SHA-256 (Maki). */
  readonly release?: BetaRelease;
  readonly commands: readonly string[];
  readonly known?: readonly BetaKnownPath[];
  readonly args: readonly string[];
  readonly install: string;
  readonly docs: string;
  /** No npm package: Install runs the vendor's installer for this OS in an AIB terminal panel (beta_setup.ts). */
  readonly vendorInstall?: BetaVendorInstall;
  readonly signin: BetaSignin;
  /** session/new reports a model it does not use until the client sets one (github/copilot-cli#5363): set it right after. */
  readonly setModelAfterNew?: boolean;
  /**
   * It exits before answering `initialize` when it has no sign-in at all (Maki: "no provider available"), so the sign-in check reads an
   * agent that stops before it answers as Needs sign-in instead of Not checked.
   */
  readonly exitsWhenSignedOut?: boolean;
  /**
   * With an API key saved, AIB starts the agent with `<flag> <folder>`: a data folder of its own inside AIB's
   * (<state>/agents/<id>/<folder>), holding `files` (relative path -> JSON) that AIB writes, so a setting the key needs never goes into
   * the person's own config (Antigravity: --gemini-dir with antigravity-cli/settings.json {"modelProvider": "gemini"}). Without a key
   * the agent uses its usual folder and sign-in.
   */
  readonly keyHome?: {
    readonly flag: string;
    readonly folder: string;
    readonly files: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  };
  /** Its mode ids are full URLs (nothing to do: AIB passes mode ids through as opaque text). */
  readonly modeIdsAreUrls?: boolean;
  /** Its `copilot` name on PATH may be VS Code's install-prompt shim: such a file does not count as installed. */
  readonly vscodeShim?: boolean;
  /** A PATH program by this name counts only when its folder path contains this text (the name is too generic). */
  readonly pathMustContain?: Readonly<Record<string, string>>;
  /**
   * Where the agent keeps its sign-in, relative to the home folder ('/'-separated): a paired computer never reaches these
   * (remote/path_guard.ts). From the vendors' docs; blocking a config folder too is harmless, missing a token folder is not.
   */
  readonly signinDirs?: readonly string[];
  /** Environment variables that move that folder: each one that is set is blocked as a whole. */
  readonly signinEnv?: readonly string[];
}

export const BETA_AGENTS: readonly BetaAgent[] = [
  {
    id: 'copilot',
    signinDirs: ['.copilot'], // its sign-in and config (COPILOT_HOME moves it)
    signinEnv: ['COPILOT_HOME'],
    name: 'GitHub Copilot CLI',
    letter: 'G',
    license: 'Proprietary',
    // UNCONFIRMED: "the Free plan works". GitHub's install page (docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/
    // install-copilot-cli, read 2026-11-11) only says "An active GitHub Copilot subscription" and does not name the plans.
    cost: 'Needs a GitHub Copilot plan (the Free plan works)',
    note: "AIB's own tools (artifacts, docs, drawings, helper agents) are available in Copilot chats. Copilot's own subagents stay off; the main agent can start AIB helpers (Claude, Codex or Gemini) for parallel work.",
    // registry: npx @github/copilot@1.0.109 --acp. Node 22+ (research). Also `winget install GitHub.Copilot` (a native copilot.exe).
    npm: { package: '@github/copilot', version: '1.0.109', bin: 'copilot', entry: 'index.js' },
    commands: ['copilot'],
    // UNCONFIRMED: where winget puts copilot.exe when PATH has not been refreshed yet.
    known: [{ base: 'LOCALAPPDATA', parts: ['Microsoft', 'WinGet', 'Links', 'copilot.exe'] }],
    args: ['--acp'],
    install: 'npm install -g @github/copilot',
    docs: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
    // research: authMethods are terminal-type (`copilot login`); a token in COPILOT_GITHUB_TOKEN / GH_TOKEN also works.
    // keyUrl: GitHub's "Authenticating GitHub Copilot CLI" (docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/
    // authenticate-copilot-cli, read 2026-11-11): a fine-grained token owned by your personal account with the Copilot Requests
    // permission, made at github.com/settings/personal-access-tokens/new; classic ghp_ tokens are not supported.
    signin: {
      kind: 'terminal',
      terminalArgs: ['login'],
      keyEnv: 'COPILOT_GITHUB_TOKEN',
      keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    },
    setModelAfterNew: true,
    modeIdsAreUrls: true,
    vscodeShim: true,
  },
  {
    id: 'opencode',
    signinDirs: ['.local/share/opencode', '.config/opencode'], // auth.json lives in its data folder
    name: 'OpenCode',
    letter: 'O',
    license: 'MIT',
    cost: 'Free CLI · needs an API key',
    // registry: native binary `opencode acp`, version 2.2.7. OpenCode 2 is the npm package @opencode/cli (opencode.ai/docs, read
    // 2026-11-11: "npm install -g @opencode/cli"; "Windows package managers are not supported"). Its bin (bin/opencode.exe) is a
    // placeholder its postinstall replaces with the binary of the platform package (@opencode/cli-<os>-<arch>, an optional
    // dependency, 230-265 MB). AIB installs with --ignore-scripts, so it runs that platform binary itself (`native`). npm also fetches
    // the -baseline (and on Linux -musl) variants of the same os/cpu, so the install is about twice that size. UNCONFIRMED: the
    // non-baseline binary needs AVX2 (postinstall picks -baseline without it); a CPU without AVX2 cannot run AIB's install.
    npm: {
      package: '@opencode/cli',
      version: '2.2.7',
      bin: 'opencode',
      entry: 'bin/opencode.exe',
      native: {
        'windows-x86_64': ['@opencode', 'cli-windows-x64', 'bin', 'opencode.exe'],
        'windows-aarch64': ['@opencode', 'cli-windows-arm64', 'bin', 'opencode.exe'],
        'darwin-x86_64': ['@opencode', 'cli-darwin-x64', 'bin', 'opencode'],
        'darwin-aarch64': ['@opencode', 'cli-darwin-arm64', 'bin', 'opencode'],
        'linux-x86_64': ['@opencode', 'cli-linux-x64', 'bin', 'opencode'],
        'linux-aarch64': ['@opencode', 'cli-linux-arm64', 'bin', 'opencode'],
      },
    },
    commands: ['opencode'],
    known: [{ base: 'USERPROFILE', parts: ['.opencode', 'bin', 'opencode.exe'] }], // UNCONFIRMED: the install script's folder
    args: ['acp'],
    install: 'npm install -g @opencode/cli',
    docs: 'https://opencode.ai/docs/',
    signin: { kind: 'terminal', terminalArgs: ['auth', 'login'] },
  },
  {
    id: 'gemini',
    signinDirs: ['.gemini'],
    name: 'Gemini CLI',
    letter: 'G',
    license: 'Apache-2.0',
    // Google Developers Blog, "An important update: Transitioning Gemini CLI to Antigravity CLI" (developers.googleblog.com/en/
    // an-important-update-transitioning-gemini-cli-to-antigravity-cli/, May 19 2026, read 2026-11-11): from June 18 2026 Gemini CLI
    // stops serving Google AI Pro and Ultra and free Gemini Code Assist for individuals; Code Assist Standard and Enterprise keep it;
    // it "will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys". UNCONFIRMED: whether a free-tier
    // Gemini API key still works with Gemini CLI (the post says paid keys only), so the card says a paid key.
    cost: 'Free CLI · needs a paid Gemini API key or a Code Assist Standard or Enterprise licence',
    note:
      'Personal Google accounts (free, AI Pro or Ultra): use the Antigravity CLI card instead. Google moved personal accounts to Antigravity CLI on 18 June 2026.',
    // registry: npx @google/gemini-cli@0.68.0 --acp. Node 20+.
    npm: { package: '@google/gemini-cli', version: '0.68.0', bin: 'gemini', entry: 'dist/index.js' },
    commands: ['gemini'],
    args: ['--acp'],
    install: 'npm install -g @google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli#-installation',
    // research: every authMethod is agent-type (Google login, API key with _meta['api-key'], Vertex, gateway).
    // UNCONFIRMED: the method ids 'gemini-api-key' and 'oauth-personal' (Google login); when the agent lists other ids, the Sign in
    // button runs the first one it advertises, and a key still reaches the agent as GEMINI_API_KEY.
    // keyUrl: Google AI Studio's API keys page, from "Using Gemini API keys" (ai.google.dev/gemini-api/docs/api-key, now
    // aistudio.google.com/docs/api-key, read 2026-11-11).
    signin: {
      kind: 'agent',
      keyEnv: 'GEMINI_API_KEY',
      keyMethod: 'gemini-api-key',
      method: 'oauth-personal',
      keyUrl: 'https://aistudio.google.com/apikey',
    },
  },
  {
    id: 'qwen',
    signinDirs: ['.qwen'],
    name: 'Qwen Code',
    letter: 'Q',
    license: 'Apache-2.0',
    // The free Qwen OAuth tier: QwenLM/qwen-code issue #3203 (github.com/QwenLM/qwen-code/issues/3203, by the Qwen Code team,
    // closed as completed): "Completely close the Qwen OAuth free entry point on 2026-04-15". The auth docs
    // (qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/, read 2026-11-11) now offer Qwen sign-in only with a Plus or Pro
    // subscription, or an API key: OPENAI_API_KEY (+ OPENAI_BASE_URL, OPENAI_MODEL) for any OpenAI-compatible provider, Alibaba Cloud
    // Model Studio among them. The CLI is Apache-2.0 and free; the model use is billed by the key's provider (Alibaba: "Anyone with your
    // API key can make service requests on your behalf, which may incur charges").
    cost: "Free CLI · model use is billed by your API key's provider",
    note: 'The free Qwen sign-in ended on April 15, 2026: use an OpenAI-compatible API key, for example from Alibaba Cloud Model Studio.',
    // registry: npx @qwen-code/qwen-code@0.27.2 --acp --experimental-skills. Node 22+.
    npm: { package: '@qwen-code/qwen-code', version: '0.27.2', bin: 'qwen', entry: 'cli.js' },
    commands: ['qwen'],
    // --approval-mode default is a must: new sessions otherwise start in Auto, and an open bug (#11887) runs tools without asking.
    args: ['--acp', '--experimental-skills', '--approval-mode', 'default'],
    install: 'npm install -g @qwen-code/qwen-code',
    docs: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
    // keyUrl: Alibaba Cloud Model Studio, "Get an API key" (alibabacloud.com/help/en/model-studio/get-api-key, read 2026-11-11), the
    // international (Singapore) console. Keys are per region. UNCONFIRMED: Qwen Code's default OPENAI_BASE_URL is OpenAI's
    // (api.openai.com/v1, read from the installed 0.27.2 package); a Model Studio key also needs OPENAI_BASE_URL
    // https://dashscope-intl.aliyuncs.com/compatible-mode/v1, which AIB does not set.
    // baseUrlHint: Alibaba Cloud Model Studio, "OpenAI compatibility" (alibabacloud.com/help/en/model-studio/
    // compatibility-of-openai-with-dashscope, read 2026-11-11): Singapore base_url https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/
    // compatible-mode/v1 ("Migrate from https://dashscope-intl.aliyuncs.com"); the workspace ID is on the workspace details page in the
    // Model Studio console. Keys are bound to their region, so the key link is the same Singapore console. Empty: Qwen's default
    // (OpenAI, api.openai.com/v1).
    signin: {
      kind: 'key',
      keyEnv: 'OPENAI_API_KEY',
      keyUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
      baseUrlEnv: 'OPENAI_BASE_URL',
      baseUrlHint: 'https://<workspace ID>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    },
  },
  {
    id: 'cursor',
    signinDirs: ['.cursor', '.config/cursor'],
    name: 'Cursor CLI',
    letter: 'C',
    license: 'Proprietary',
    cost: 'Paid plan',
    // registry: Windows build is dist-package\cursor-agent.cmd acp (the research said `agent acp`: the same program, also named agent).
    commands: ['cursor-agent', 'agent'],
    pathMustContain: { agent: 'cursor' }, // `agent` is too generic a name: only one that sits in a Cursor folder counts
    // The Windows installer (cursor.com/install?win32=true, read 2026-11-11) puts cursor-agent.cmd in %LOCALAPPDATA%\cursor-agent and adds
    // that folder to PATH. It also prints that Git for Windows is needed "to run a private worker" (a Cursor feature, not the install).
    known: [{ base: 'LOCALAPPDATA', parts: ['cursor-agent', 'cursor-agent.cmd'] }],
    args: ['acp'],
    install: "irm 'https://cursor.com/install?win32=true' | iex",
    docs: 'https://cursor.com/docs/cli/acp',
    // Cursor CLI docs, Installation (cursor.com/docs/cli/installation, read 2026-11-11). No uninstall instructions there.
    vendorInstall: {
      windows: { shell: 'powershell', command: "irm 'https://cursor.com/install?win32=true' | iex" },
      darwin: { shell: 'bash', command: 'curl https://cursor.com/install -fsS | bash' },
      linux: { shell: 'bash', command: 'curl https://cursor.com/install -fsS | bash' },
      source: 'https://cursor.com/docs/cli/installation',
    },
    // keyUrl: Cursor CLI docs, Authentication (cursor.com/docs/cli/reference/authentication, read 2026-11-11): "Cursor Dashboard →
    // API Keys" at cursor.com/dashboard/api. UNCONFIRMED: cost 'Paid plan' (the CLI docs name no plan).
    signin: { kind: 'agent', method: 'cursor_login', keyEnv: 'CURSOR_API_KEY', keyUrl: 'https://cursor.com/dashboard/api' },
  },
  {
    id: 'goose',
    signinDirs: ['.config/goose', 'AppData/Roaming/Block/goose'],
    name: 'Goose',
    letter: 'G',
    license: 'Apache-2.0',
    cost: 'Free CLI · needs an API key',
    // registry: native binary goose-package\goose.exe acp.
    commands: ['goose'],
    // download_cli.ps1 (read 2026-11-11): installs to $env:GOOSE_BIN_DIR, default $env:USERPROFILE\.local\bin.
    known: [{ base: 'USERPROFILE', parts: ['.local', 'bin', 'goose.exe'] }],
    args: ['acp'],
    install: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
    docs: 'https://block.github.io/goose/docs/getting-started/installation',
    // goose docs, Install goose (github.com/block/goose documentation/docs/getting-started/installation.md, read 2026-11-11; the
    // project moved to github.com/aaif-goose). Windows lists Git Bash, MSYS2 and PowerShell; AIB uses the PowerShell one, which needs
    // nothing else: the docs download download_cli.ps1 to the current folder and run it; AIB saves it in %TEMP% instead. The scripts end
    // with `goose configure` (interactive, in the panel). No uninstall steps for the CLI in the docs.
    vendorInstall: {
      windows: {
        shell: 'powershell',
        command: "$f = Join-Path $env:TEMP 'download_cli.ps1'; " +
          'Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1" -OutFile $f; & $f',
      },
      darwin: {
        shell: 'bash',
        command: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
      },
      linux: {
        shell: 'bash',
        command: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
      },
      source: 'https://block.github.io/goose/docs/getting-started/installation',
    },
    // research: agent-type (provider and key). UNCONFIRMED: the method ids; the first advertised one runs.
    signin: { kind: 'agent' },
  },
  {
    id: 'vibe',
    signinDirs: ['.vibe'],
    signinEnv: ['VIBE_HOME'],
    name: 'Mistral Vibe',
    letter: 'M',
    license: 'Apache-2.0',
    cost: 'Free CLI · needs an API key',
    // registry: native binary vibe-acp.exe, no arguments.
    commands: ['vibe-acp'],
    known: [{ base: 'USERPROFILE', parts: ['.local', 'bin', 'vibe-acp.exe'] }], // UNCONFIRMED: uv's tool folder
    args: [],
    install: 'uv tool install mistral-vibe',
    docs: 'https://github.com/mistralai/mistral-vibe',
    // Mistral Vibe README (github.com/mistralai/mistral-vibe, read 2026-11-11) and docs.mistral.ai/mistral-vibe/terminal: macOS/Linux
    // `curl -LsSf https://mistral.ai/vibe/install.sh | bash` (the script installs uv itself when missing, then `uv tool install
    // mistral-vibe`); Windows: install uv first, then `uv tool install mistral-vibe`. uv fetches a Python (3.12+) when needed, so Python
    // is not a prerequisite. No uninstall instructions in either.
    vendorInstall: {
      windows: { shell: 'powershell', command: 'uv tool install mistral-vibe', needs: ['uv'] },
      darwin: { shell: 'bash', command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash' },
      linux: { shell: 'bash', command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash' },
      source: 'https://github.com/mistralai/mistral-vibe#installation',
    },
    // keyUrl: Mistral docs, Vibe "API keys and profiles" (docs.mistral.ai/vibe/code/cli/api-keys-profiles, read 2026-11-11): make the
    // key under Code › Vibe CLI at chat.mistral.ai/code/extensions; "The same key works in Free mode, with a paid plan, or with
    // pay-as-you-go enabled" (use beyond the plan's monthly amount stops unless pay-as-you-go is on).
    signin: { kind: 'key', keyEnv: 'MISTRAL_API_KEY', keyUrl: 'https://chat.mistral.ai/code/extensions' },
  },
  {
    id: 'cline',
    signinDirs: ['.cline'],
    name: 'Cline CLI',
    letter: 'C',
    license: 'Apache-2.0',
    cost: 'Free CLI · needs an API key',
    // registry: npx cline@3.0.74 --acp.
    npm: { package: 'cline', version: '3.0.74', bin: 'cline', entry: 'dist/cli.js' },
    commands: ['cline'],
    args: ['--acp'],
    install: 'npm install -g cline',
    docs: 'https://cline.bot/cli',
    // research: agent-type auth, but sign in first with `cline auth`: that is what the Sign in button runs.
    signin: { kind: 'terminal', terminalArgs: ['auth'] },
  },
  {
    id: 'kimi',
    signinDirs: ['.kimi'],
    name: 'Kimi Code',
    letter: 'K',
    license: 'MIT',
    cost: 'Free CLI · needs an API key',
    // registry: npx @moonshot-ai/kimi-code@2.5.3 acp. AIB installs the package instead of running npx (npx would download at launch).
    // From the package itself (2.5.3): package.json bin {"kimi": "dist/main.mjs"}; dist/main.mjs has a `login` command and an `acp`
    // command whose `--login` option is what its advertised terminal auth method runs (`kimi acp --login`).
    npm: { package: '@moonshot-ai/kimi-code', version: '2.5.3', bin: 'kimi', entry: 'dist/main.mjs', minNode: '22.19.0' },
    commands: ['kimi'],
    args: ['acp'],
    install: 'npm install -g @moonshot-ai/kimi-code',
    docs: 'https://moonshotai.github.io/kimi-code/',
    signin: { kind: 'terminal', terminalArgs: ['login'] }, // the fallback when Kimi advertises no terminal method: `kimi login`
  },
  {
    id: 'kilo',
    signinDirs: ['.local/share/kilo', '.config/kilo', '.kilocode'],
    name: 'Kilo Code CLI',
    letter: 'K',
    license: 'MIT',
    cost: 'Free CLI · needs an API key',
    // registry: native kilo.exe acp, or npx @kilocode/cli@7.8.27 acp.
    npm: { package: '@kilocode/cli', version: '7.8.27', bin: 'kilo', entry: 'bin/kilo' },
    commands: ['kilo'],
    args: ['acp'],
    install: 'npm install -g @kilocode/cli',
    docs: 'https://kilo.ai/docs/cli',
    signin: { kind: 'terminal', terminalArgs: ['auth', 'login'] }, // UNCONFIRMED: the login subcommand
  },
  {
    id: 'maki',
    // Maki (maki.sh, github.com/tontinton/maki, MIT): a native Rust agent, `maki acp` over stdio. Read from the v0.7.2 source
    // (2026-11-17) and checked against the real binary with work/stub_model_api.js (work/deno/maki_e2e_test.ts):
    //   initialize: loadSession true, session list, image + embedded context prompts, MCP over http and stdio, authMethods [] (no
    //     ACP auth: it signs in with keys in its environment or `maki auth login`). Without any provider it exits before initialize
    //     ("no provider available - set an API key ... run `maki auth login`").
    //   session/new + session/load: modes build / plan, and one config option "model" (category model) that grows as it finds models.
    //   session/set_mode, session/set_config_option (model only), session/cancel, session/request_permission (allow_once,
    //     allow_always, reject_once, reject_always), elicitation/create (its question tool, when the client offers form
    //     elicitation). It makes no fs or terminal calls to the client.
    //   Not offered: session/resume, session/close, session/set_model, slash commands (available_commands_update).
    // Its data (config, sessions, saved sign-ins under auth/) is in etcetera's base folders: Windows %APPDATA%\maki (cache in
    // %LOCALAPPDATA%\maki); macOS and Linux $XDG_DATA_HOME / $XDG_CONFIG_HOME / $XDG_STATE_HOME / $XDG_CACHE_HOME (default ~/.local/share,
    // ~/.config, ~/.local/state, ~/.cache), each with a maki folder.
    signinDirs: [
      'AppData/Roaming/maki',
      'AppData/Local/maki',
      '.local/share/maki',
      '.local/state/maki',
      '.config/maki',
      '.cache/maki',
    ],
    name: 'Maki',
    letter: 'M',
    license: 'MIT',
    cost: 'Free CLI · needs an API key or a provider sign-in',
    note:
      'Works with Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Ollama and more. Sign in picks one; the key box below is for an Anthropic (or Anthropic-compatible) key.',
    // GitHub release v0.7.2 (github.com/tontinton/maki/releases/tag/v0.7.2, 2026-11-14): one archive per target with the program at
    // its root, and sha256sums.txt. No signatures or build attestations are published (`gh attestation verify`: none), so AIB pins
    // the SHA-256 of each archive here and checks it before unpacking. Windows has only an x86_64 build; Windows on Arm runs it under
    // emulation (the project's own install.sh says so). Linux builds are static (musl).
    release: {
      repo: 'tontinton/maki',
      tag: 'v0.7.2',
      version: '0.7.2',
      program: 'maki',
      assets: {
        'windows-x86_64': {
          file: 'maki-v0.7.2-x86_64-pc-windows-msvc.zip',
          sha256: 'abd87a0668cc69d75351a435c3f05a2c10d840cd8a0b412facbd0a42c6180160',
          bytes: 32666584,
        },
        'windows-aarch64': {
          file: 'maki-v0.7.2-x86_64-pc-windows-msvc.zip',
          sha256: 'abd87a0668cc69d75351a435c3f05a2c10d840cd8a0b412facbd0a42c6180160',
          bytes: 32666584,
        },
        'darwin-x86_64': {
          file: 'maki-v0.7.2-x86_64-apple-darwin.tar.gz',
          sha256: '805fdd641b00798c94db7c4a6bf1f1bfaa60802d533da5683d391585eddb4759',
          bytes: 35067012,
        },
        'darwin-aarch64': {
          file: 'maki-v0.7.2-aarch64-apple-darwin.tar.gz',
          sha256: 'de286c993de103ce85d0be08681e7baad57731fe094874273c3972749c7820d4',
          bytes: 32697887,
        },
        'linux-x86_64': {
          file: 'maki-v0.7.2-x86_64-unknown-linux-musl.tar.gz',
          sha256: '8b45124b74d1697a95948c51cd86eea20a7e8ab3989b478eedd1a4844b08a93c',
          bytes: 37097676,
        },
        'linux-aarch64': {
          file: 'maki-v0.7.2-aarch64-unknown-linux-musl.tar.gz',
          sha256: 'f59aa1a0c90c67ff045de96be5f197c915704b4bb77b48b04259f1f80f7f6429',
          bytes: 36035491,
        },
      },
    },
    commands: ['maki'],
    // install.ps1's default folder (MAKI_INSTALL_DIR moves it); install.sh uses ~/.local/bin, which is normally on PATH.
    known: [{ base: 'LOCALAPPDATA', parts: ['maki', 'maki.exe'] }],
    args: ['acp'],
    // The project's own install commands (README), shown for doing it by hand; AIB's Install never runs them.
    install: Deno.build.os === 'windows' ? 'irm https://maki.sh/install.ps1 | iex' : 'curl -fsSL https://maki.sh/install.sh | sh',
    docs: 'https://maki.sh/docs/',
    // `maki auth login` is interactive (a provider list, then a key prompt or a browser sign-in), so it runs in the card's terminal
    // panel. Keys it saves stay in Maki's own folder. The key box sets ANTHROPIC_API_KEY (Anthropic comes first in Maki's provider
    // order) and the address box ANTHROPIC_BASE_URL (Maki reads <PROVIDER>_BASE_URL), e.g. DeepSeek's Anthropic-compatible API.
    signin: {
      kind: 'terminal',
      terminalArgs: ['auth', 'login'],
      keyEnv: 'ANTHROPIC_API_KEY',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      baseUrlEnv: 'ANTHROPIC_BASE_URL',
      baseUrlHint: 'https://api.anthropic.com',
    },
    exitsWhenSignedOut: true,
  },
  {
    id: 'antigravity',
    // Google Antigravity CLI (`agy`, closed-source Go): since June 18 2026 the CLI for personal Google accounts (free, AI Pro, Ultra);
    // Gemini CLI keeps paid keys and Code Assist Standard/Enterprise. `agy acp` speaks ACP v1 over stdio (antigravity.google/docs/cli/acp,
    // /docs/ide/extensions/acp, read 2026-11-18). Checked against the real 1.5.11 Windows build, headless, with a throwaway home and a
    // dummy key (work/deno/antigravity_test.ts):
    //   initialize: loadSession, session resume / close / load / list, additionalDirectories, image + embedded context prompts,
    //     auth.logout; authMethods oauth-personal, oauth-business, gemini-api-key, agent-platform, and (only to a client that says
    //     auth.terminal) terminal-login, type terminal, args ["--login"]: AIB's Sign in runs `agy acp --disable-telemetry --login`.
    //   No sign-in: session/new fails -32000 "Authentication required" (= Needs sign-in).
    //   GEMINI_API_KEY alone is not enough: it also needs settings.json {"modelProvider": "gemini"}, or an ACP authenticate with
    //     gemini-api-key. Its data folder (~/.gemini, settings in antigravity-cli/settings.json) moves with `--gemini-dir <absolute
    //     path>` (a flag `agy acp --help` lists; no environment variable does it), so with a key AIB runs it with its own folder
    //     (keyHome) and never writes the person's ~/.gemini.
    //   session/new: models (21, e.g. gemini-3.1-pro-low), modes default / accept-edits / plan, config options model, thought_level
    //     and mode, slash commands (available_commands_update), usage_update.
    // Subagents: yes (invoke_subagent, define_subagent, swarm, run_workflow). No setting turns them off; a PreToolUse hook (hooks.json in
    // the --gemini-dir folder) can force Workspace "branch" (a real git worktree and branch) or deny: AIB does (subagents/antigravity.ts,
    // aib-shared/research/provider-builder-probe-2026-11-25.md). With a Google sign-in there is no folder of AIB's own: it only asks.
    // It updates itself in the background (install.sh: "automatically self-updates"); no switch to turn that off is documented.
    signinDirs: ['.gemini'],
    name: 'Antigravity CLI',
    letter: 'A',
    license: 'Proprietary',
    cost: 'Free CLI · sign in with a Google account, or use a Gemini API key',
    note:
      "Google's CLI for personal Google accounts (free, AI Pro and Ultra) since June 18, 2026. Sign in runs Google's paste-a-code sign-in here. With an API key saved, AIB gives it its own settings folder, so your ~/.gemini stays as it is.",
    // Google publishes the CLI only through its install scripts (antigravity.google/download): they read a manifest per platform
    // (antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json: version, url, sha512), download the
    // build from storage.googleapis.com/antigravity-public/ and check its SHA-512. AIB pins the 1.5.11 manifest values here (read
    // 2026-11-18; sizes from the files' Content-Length) and checks the SHA-512 itself; it never runs the scripts. The Windows build is
    // the program itself (agy.exe; Authenticode-signed by Google LLC, checked by hand 2026-11-18); macOS and Linux are a .tar.gz with
    // the program `antigravity` at its root. Linux: the glibc builds (Google also has _musl ones, which AIB does not pick).
    release: {
      repo: '',
      tag: '1.5.11-6132547114106880',
      version: '1.5.11',
      program: 'agy',
      host: 'Google',
      inner: 'antigravity',
      assets: {
        'windows-x86_64': {
          file: 'cli_windows_x64.exe',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/windows-x64/cli_windows_x64.exe',
          sha512:
            '7de2a90b3a351c5c1d089b50a773d4fc455062870fa62fc4d50ee2779d7b9f1b630a7025c31163671f6c82ae0426aeda838f98f67270a50fdd2c7de2f2d7eb3f',
          bytes: 234827416,
        },
        'windows-aarch64': {
          file: 'cli_windows_arm64.exe',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/windows-arm/cli_windows_arm64.exe',
          sha512:
            'a1c89cca8d3c7af9c3bdc77318975a9e0eb0fb93c421b198b14b18a4b65933c7adea2c9cb35651f7658e810b6241e8cf03a652b3b8bc221bbc2fcdb61edc01b6',
          bytes: 222972056,
        },
        'darwin-x86_64': {
          file: 'cli_mac_x64.tar.gz',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/darwin-x64/cli_mac_x64.tar.gz',
          sha512:
            'ff1f625c2efcff03d2131e3e9dc67bb5d1974b67810706f80ad34317c83769486388226352f1a34ede54fad43f5941220ea9beddefc8b27419023c6e9aa4682c',
          bytes: 90664657,
        },
        'darwin-aarch64': {
          file: 'cli_mac_arm64.tar.gz',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/darwin-arm/cli_mac_arm64.tar.gz',
          sha512:
            '1b2c8e1f832e1be9b257c24e4ac75c9029771fef5af9b529ea295fff1aa5b9d3e1e5447200a76ac8a775889aa8399210716f188f84242b3c34a2e9a8a3c2cc7d',
          bytes: 85142629,
        },
        'linux-x86_64': {
          file: 'cli_linux_x64.tar.gz',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/linux-x64/cli_linux_x64.tar.gz',
          sha512:
            'dad3c015e8964fcdc1639b13b7152f4cb84cb1bde385707e2bcdf095d6f1831f4f6521199aec499cc052f9e99906b7fdbc52c273df064d5cb7c84b068ba3ce50',
          bytes: 100130747,
        },
        'linux-aarch64': {
          file: 'cli_linux_arm64.tar.gz',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/linux-arm/cli_linux_arm64.tar.gz',
          sha512:
            '5f703c88e01851061c87c07b1a4ca54c1f5a6826ffada9fb005974a099e9a552ddb1f9ba2fe1194e2829803482c86084babf8cf91530a528bc7f659613600585',
          bytes: 91203180,
        },
      },
    },
    commands: ['agy'],
    // install.ps1's folder (--dir moves it); install.sh uses ~/.local/bin, which is normally on PATH.
    known: [{ base: 'LOCALAPPDATA', parts: ['agy', 'bin', 'agy.exe'] }],
    // --disable-telemetry: AIB's chats run with Google's telemetry off for this server (a documented `agy acp` flag).
    args: ['acp', '--disable-telemetry'],
    // Google's own install commands (antigravity.google/download), shown for doing it by hand; AIB's Install never runs them.
    install: Deno.build.os === 'windows'
      ? 'irm https://antigravity.google/cli/install.ps1 | iex'
      : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    docs: 'https://antigravity.google/docs/cli/acp',
    // Sign in: the advertised terminal-login method (`agy acp --login`, paste a code); the fallback is the same command. The key box
    // sets GEMINI_API_KEY and, through keyHome, modelProvider "gemini". keyMethod: a chat that still asks for sign-in sends the key with
    // ACP authenticate gemini-api-key (which also works without the setting). keyUrl: Google AI Studio's API keys page.
    signin: {
      kind: 'terminal',
      terminalArgs: ['acp', '--login'],
      keyEnv: 'GEMINI_API_KEY',
      keyMethod: 'gemini-api-key',
      keyUrl: 'https://aistudio.google.com/apikey',
    },
    keyHome: {
      flag: '--gemini-dir',
      folder: 'gemini-home',
      files: { 'antigravity-cli/settings.json': { modelProvider: 'gemini' } },
    },
  },
];

export const BETA_IDS: readonly string[] = BETA_AGENTS.map((a) => a.id);
export const BETA_NAMES: Readonly<Record<string, string>> = Object.fromEntries(BETA_AGENTS.map((a) => [a.id, a.name]));

export function betaAgent(id: unknown): BetaAgent | null {
  return typeof id === 'string' ? BETA_AGENTS.find((a) => a.id === id) ?? null : null;
}

export function isBeta(id: unknown): boolean {
  return betaAgent(id) !== null;
}
