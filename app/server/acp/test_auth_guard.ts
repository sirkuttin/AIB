/**
 * Test auth guard (incident 2026-11-25): under test (AGENT_STUDIO_TEST=1) AIB refuses to start a real agent unless its auth is
 * an explicit test setup: a loopback model endpoint (the test's stub) and an API key, never sign-in mode. A temp HOME or config
 * folder does not cover credentials the agent finds elsewhere: the Windows credential store (OS keyring), `gh` auth, Google
 * application-default credentials. Antigravity (agy) did exactly that: its dummy key was ignored, it fell back to the person's own
 * Google sign-in, and a prompt reached Google. So the check is on the launch itself, before the process exists.
 *
 * Fails closed: a provider with no rule here is refused, and so is one whose rule is not met. Pure (env and command in, reason out)
 * so tests can simulate "dummy key ignored -> sign-in mode" for each provider without starting anything.
 */

/** The provider of a launch: the chat's provider id, else a guess from the program name. */
function providerOf(provider: string, command: string[]): string {
  const known = ['claude', 'codex', 'gemini', 'antigravity', 'qwen', 'maki', 'copilot'];
  const p = provider.toLowerCase();
  if (known.includes(p)) return p;
  const text = command.map((c) => String(c).toLowerCase().replace(/\\/g, '/')).join(' ');
  if (/(^|[ /])agy(\.exe)?( |$)/.test(text) || text.includes('antigravity')) return 'antigravity';
  for (const name of ['claude', 'codex', 'gemini', 'qwen', 'maki', 'copilot']) if (text.includes(name)) return name;
  return p || 'unknown';
}

export function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

const set = (env: Record<string, string>, name: string) => (env[name] ?? '').trim() !== '';
const loopback = (env: Record<string, string>, ...names: string[]) => names.some((n) => isLoopbackUrl(env[n]));
const anyKey = (env: Record<string, string>, ...names: string[]) => names.some((n) => set(env, n));

function readText(path: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return '';
  }
}

/** Why this real-agent launch is not safe under test, or null when its auth is an explicit test setup (stub endpoint + key). */
export function testAuthProblem(provider: string, command: string[], env: Record<string, string>): string | null {
  const id = providerOf(provider, command);
  const need = (why: string) => `${id}: ${why}`;
  switch (id) {
    case 'claude':
      if (!loopback(env, 'ANTHROPIC_BASE_URL')) return need('ANTHROPIC_BASE_URL is not a loopback address (the test stub)');
      if (!set(env, 'ANTHROPIC_API_KEY')) return need('no ANTHROPIC_API_KEY: it would sign in with the account of whoever runs the test');
      if (set(env, 'CLAUDE_CODE_OAUTH_TOKEN') || set(env, 'ANTHROPIC_AUTH_TOKEN')) return need('an OAuth/auth token is set');
      return null;
    case 'codex': {
      let config = env.CODEX_CONFIG ?? '';
      const home = env.CODEX_HOME;
      if (home) config += '\n' + readText(`${home.replace(/[\\/]+$/, '')}/config.toml`);
      const urls = [...config.matchAll(/base_url["']?\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]);
      if (!urls.length || !urls.every(isLoopbackUrl)) return need('no model provider with a loopback base_url in CODEX_CONFIG or CODEX_HOME/config.toml (the stub)');
      if (/requires_openai_auth["']?\s*[:=]\s*true/.test(config)) return need('the model provider requires the account sign-in');
      return null;
    }
    case 'gemini':
      if (!loopback(env, 'GOOGLE_GEMINI_BASE_URL')) return need('GOOGLE_GEMINI_BASE_URL is not a loopback address (the test stub)');
      if (!set(env, 'GEMINI_API_KEY')) return need('no GEMINI_API_KEY: it would use the Google sign-in');
      if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || env.GOOGLE_GENAI_USE_GCA === 'true') return need('Vertex / Code Assist mode is on');
      return null;
    case 'antigravity': {
      // AIB runs agy with --gemini-dir <its own folder> only when an API key is saved; without it agy signs in (OS keyring)
      const at = command.lastIndexOf('--gemini-dir');
      if (at < 0 || !String(command[at + 1] ?? '').trim()) return need('no --gemini-dir (no API key saved): agy would use the Google sign-in in the OS keyring');
      if (!loopback(env, 'GOOGLE_GEMINI_BASE_URL')) return need('GOOGLE_GEMINI_BASE_URL is not a loopback address (the test stub)');
      return null;
    }
    case 'qwen': {
      if (!loopback(env, 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GOOGLE_GEMINI_BASE_URL')) return need('no loopback model endpoint (the test stub)');
      if (!anyKey(env, 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY')) return need('no API key: it would use the Qwen OAuth sign-in');
      const settings = readText(`${(env.QWEN_HOME ?? '').replace(/[\\/]+$/, '')}/settings.json`);
      if (env.QWEN_HOME && /qwen-oauth/.test(settings)) return need('QWEN_HOME/settings.json selects the qwen-oauth sign-in');
      return null;
    }
    case 'maki':
      if (!loopback(env, 'ANTHROPIC_BASE_URL')) return need('ANTHROPIC_BASE_URL is not a loopback address (the test stub)');
      if (!set(env, 'ANTHROPIC_API_KEY')) return need('no ANTHROPIC_API_KEY');
      return null;
    case 'copilot':
      // Copilot signs in with the GitHub account (keyring / gh); only its bring-your-own-model mode on a stub is a test setup
      if (!loopback(env, 'COPILOT_PROVIDER_BASE_URL')) return need('COPILOT_PROVIDER_BASE_URL is not a loopback address: Copilot would use the GitHub sign-in');
      if (!anyKey(env, 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN')) return need('no COPILOT_PROVIDER_API_KEY');
      return null;
    default:
      return need('no test auth rule for this agent: refusing to start it');
  }
}

/** Env that closes the credential fallbacks an env var can close: gh, gcloud / Google application-default, and tokens. */
export function testCredentialEnv(home: string): Record<string, string> {
  const sep = home.includes('\\') ? '\\' : '/';
  return {
    GH_CONFIG_DIR: `${home}${sep}gh`,
    CLOUDSDK_CONFIG: `${home}${sep}gcloud`,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
  };
}

/** Throws (before the process exists) when a real agent would start under test without an explicit test auth setup. */
export function assertTestAuth(provider: string, command: string[], env: Record<string, string>): void {
  const problem = testAuthProblem(provider, command, env);
  if (problem) {
    throw new Error(
      `Test auth guard: refusing to start a real agent under test (${problem}). A real agent in a test must run on a dummy key and the test's stub ` +
        'endpoint, never on a sign-in: the OS keyring, gh and Google credentials are not covered by a temp HOME.',
    );
  }
}
