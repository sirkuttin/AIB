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
 *   install    the official install command shown (copyable) when the agent is not found; AIB never downloads a binary itself
 *   signin     terminal: the agent's own login command runs in an AIB terminal panel (ACP auth type "terminal");
 *              agent: ACP `authenticate` on a short-lived agent process (the agent opens the browser itself);
 *              key: an API key the person types in Settings, passed to the agent as an environment variable
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
  /** Its mode ids are full URLs (nothing to do: AIB passes mode ids through as opaque text). */
  readonly modeIdsAreUrls?: boolean;
  /** Its `copilot` name on PATH may be VS Code's install-prompt shim: such a file does not count as installed. */
  readonly vscodeShim?: boolean;
  /** A PATH program by this name counts only when its folder path contains this text (the name is too generic). */
  readonly pathMustContain?: Readonly<Record<string, string>>;
}

export const BETA_AGENTS: readonly BetaAgent[] = [
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    letter: 'G',
    license: 'Proprietary',
    // UNCONFIRMED: "the Free plan works". GitHub's install page (docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/
    // install-copilot-cli, read 2026-11-11) only says "An active GitHub Copilot subscription" and does not name the plans.
    cost: 'Needs a GitHub Copilot plan (the Free plan works)',
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
      'Since June 18, 2026 a personal Google sign-in (free, AI Pro or Ultra) no longer works here: Google moved those to Antigravity CLI.',
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
    signin: {
      kind: 'key',
      keyEnv: 'OPENAI_API_KEY',
      keyUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
    },
  },
  {
    id: 'cursor',
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
];

export const BETA_IDS: readonly string[] = BETA_AGENTS.map((a) => a.id);
export const BETA_NAMES: Readonly<Record<string, string>> = Object.fromEntries(BETA_AGENTS.map((a) => [a.id, a.name]));

export function betaAgent(id: unknown): BetaAgent | null {
  return typeof id === 'string' ? BETA_AGENTS.find((a) => a.id === id) ?? null : null;
}

export function isBeta(id: unknown): boolean {
  return betaAgent(id) !== null;
}
