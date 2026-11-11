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
}

export interface BetaKnownPath {
  /** Environment variable the path starts from (USERPROFILE, LOCALAPPDATA, APPDATA). */
  readonly base: string;
  readonly parts: readonly string[];
}

export interface BetaSignin {
  readonly kind: SigninKind;
  /** Arguments of the agent's own login command (terminal), after the agent's program. */
  readonly terminalArgs?: readonly string[];
  /** The environment variable an API key goes into. */
  readonly keyEnv?: string;
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
    signin: { kind: 'terminal', terminalArgs: ['login'], keyEnv: 'COPILOT_GITHUB_TOKEN' },
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
    // registry: native binary `opencode acp` (windows-x86_64 and aarch64 builds).
    commands: ['opencode'],
    known: [{ base: 'USERPROFILE', parts: ['.opencode', 'bin', 'opencode.exe'] }], // UNCONFIRMED: the install script's folder
    args: ['acp'],
    install: 'npm install -g opencode-ai',
    docs: 'https://opencode.ai/docs/',
    signin: { kind: 'terminal', terminalArgs: ['auth', 'login'] },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    letter: 'G',
    license: 'Apache-2.0',
    cost: 'Free CLI · needs an API key or a paid plan',
    note: 'Free personal Google sign-in moved to Antigravity in June 2026; use an API key or a paid plan.',
    // registry: npx @google/gemini-cli@0.68.0 --acp. Node 20+.
    npm: { package: '@google/gemini-cli', version: '0.68.0', bin: 'gemini', entry: 'dist/index.js' },
    commands: ['gemini'],
    args: ['--acp'],
    install: 'npm install -g @google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli#-installation',
    // research: every authMethod is agent-type (Google login, API key with _meta['api-key'], Vertex, gateway).
    // UNCONFIRMED: the method ids 'gemini-api-key' and 'oauth-personal' (Google login); when the agent lists other ids, the Sign in
    // button runs the first one it advertises, and a key still reaches the agent as GEMINI_API_KEY.
    signin: { kind: 'agent', keyEnv: 'GEMINI_API_KEY', keyMethod: 'gemini-api-key', method: 'oauth-personal' },
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    letter: 'Q',
    license: 'Apache-2.0',
    cost: 'Free CLI · needs an API key',
    note: 'The free Qwen sign-in ended in April 2026: use an OpenAI-compatible API key.',
    // registry: npx @qwen-code/qwen-code@0.27.2 --acp --experimental-skills. Node 22+.
    npm: { package: '@qwen-code/qwen-code', version: '0.27.2', bin: 'qwen', entry: 'cli.js' },
    commands: ['qwen'],
    // --approval-mode default is a must: new sessions otherwise start in Auto, and an open bug (#11887) runs tools without asking.
    args: ['--acp', '--experimental-skills', '--approval-mode', 'default'],
    install: 'npm install -g @qwen-code/qwen-code',
    docs: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
    signin: { kind: 'key', keyEnv: 'OPENAI_API_KEY' },
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
    known: [{ base: 'LOCALAPPDATA', parts: ['cursor-agent', 'cursor-agent.cmd'] }], // UNCONFIRMED: the installer's folder
    args: ['acp'],
    install: "irm 'https://cursor.com/install?win32=true' | iex",
    docs: 'https://cursor.com/docs/cli/acp',
    signin: { kind: 'agent', method: 'cursor_login', keyEnv: 'CURSOR_API_KEY' },
  },
  {
    id: 'goose',
    name: 'Goose',
    letter: 'G',
    license: 'Apache-2.0',
    cost: 'Free CLI · needs an API key',
    // registry: native binary goose-package\goose.exe acp.
    commands: ['goose'],
    known: [{ base: 'USERPROFILE', parts: ['.local', 'bin', 'goose.exe'] }], // UNCONFIRMED: the download script's folder
    args: ['acp'],
    // research: on Windows the documented install runs this script from Git Bash.
    install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
    docs: 'https://block.github.io/goose/docs/getting-started/installation',
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
    signin: { kind: 'key', keyEnv: 'MISTRAL_API_KEY' },
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
    npm: { package: '@moonshot-ai/kimi-code', version: '2.5.3', bin: 'kimi', entry: 'dist/index.js' },
    commands: ['kimi-code', 'kimi'], // UNCONFIRMED: the bin name of the package
    args: ['acp'],
    install: 'npm install -g @moonshot-ai/kimi-code',
    docs: 'https://moonshotai.github.io/kimi-code/',
    signin: { kind: 'terminal', terminalArgs: ['login'] }, // UNCONFIRMED: the login subcommand
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
