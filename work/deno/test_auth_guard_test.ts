/**
 * Test auth guard (incident 2026-11-25: agy ignored the test's dummy key, fell back to the owner's Google sign-in in the OS keyring,
 * and a real prompt got a real reply). Under test a real agent only starts on explicit test auth (a loopback stub endpoint and a key,
 * never sign-in): app/server/acp/test_auth_guard.ts, enforced in Connection (direct, keeper and WSL launches) and the Codex limits probe.
 * Nothing here starts a real agent: the refusal happens before any process exists.
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { agentTempDirSync } from './_agent_tmp.ts';
import { Connection, guardRealAgentAuth, testHomeEnv } from '../../app/server/acp/connection.ts';
import { testAuthProblem } from '../../app/server/acp/test_auth_guard.ts';
import { wslTestHomeEnv } from '../../app/server/wsl/access.ts';
import { appServerLimits } from '../../app/server/agents/codex_limits.ts';

const STUB = 'http://127.0.0.1:45999';
const KEY = 'AIza-dummy-not-a-real-key-000000000000';
const AGY_KEY_MODE = ['agy', '--gemini-dir', 'C:/aib-test-tmp/state/agents/antigravity/gemini-home'];

/** Each provider: an explicit test setup passes, and the incident shape (key or stub ignored -> sign-in mode) is refused. */
const CASES: { provider: string; command: string[]; good: Record<string, string>; signIn: Record<string, string>[] }[] = [
  {
    provider: 'claude',
    command: ['claude-agent-acp'],
    good: { ANTHROPIC_BASE_URL: STUB, ANTHROPIC_API_KEY: 'stub-key' },
    signIn: [{ ANTHROPIC_BASE_URL: STUB }, { ANTHROPIC_API_KEY: 'stub-key' }, { ANTHROPIC_BASE_URL: STUB, ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }],
  },
  {
    provider: 'codex',
    command: ['codex-acp'],
    good: { CODEX_CONFIG: JSON.stringify({ model_providers: { stub: { base_url: `${STUB}/v1`, requires_openai_auth: false } } }) },
    signIn: [{}, { CODEX_CONFIG: JSON.stringify({ model: 'x' }) }, { CODEX_CONFIG: JSON.stringify({ model_providers: { o: { base_url: 'https://api.openai.com/v1' } } }) }],
  },
  {
    provider: 'gemini',
    command: ['gemini', '--acp'],
    good: { GOOGLE_GEMINI_BASE_URL: STUB, GEMINI_API_KEY: 'fake-key' },
    signIn: [{ GOOGLE_GEMINI_BASE_URL: STUB }, { GEMINI_API_KEY: 'fake-key' }, { GOOGLE_GEMINI_BASE_URL: STUB, GEMINI_API_KEY: 'k', GOOGLE_GENAI_USE_GCA: 'true' }],
  },
  { provider: 'antigravity', command: AGY_KEY_MODE, good: { GOOGLE_GEMINI_BASE_URL: STUB }, signIn: [] /* sign-in = no --gemini-dir: its own test below */ },
  {
    provider: 'qwen',
    command: ['node', 'cli.js', '--acp'],
    good: { ANTHROPIC_BASE_URL: STUB, ANTHROPIC_API_KEY: 'stub-key' },
    signIn: [{ ANTHROPIC_BASE_URL: STUB }, { ANTHROPIC_API_KEY: 'stub-key' }, { OPENAI_BASE_URL: 'https://example.com/v1', OPENAI_API_KEY: 'k' }],
  },
  {
    provider: 'maki',
    command: ['maki', 'acp'],
    good: { ANTHROPIC_BASE_URL: STUB, ANTHROPIC_API_KEY: 'stub-key-not-real' },
    signIn: [{ ANTHROPIC_BASE_URL: STUB }, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }],
  },
  {
    provider: 'copilot',
    command: ['copilot', '--acp'],
    good: { COPILOT_PROVIDER_BASE_URL: STUB, COPILOT_PROVIDER_API_KEY: 'k' },
    signIn: [{ COPILOT_PROVIDER_API_KEY: 'k' }, { GH_TOKEN: 'ghp_x', COPILOT_PROVIDER_BASE_URL: STUB }, {}],
  },
];

Deno.test('test_auth_explicit_test_setup_passes_and_sign_in_is_refused_for_every_provider', () => {
  for (const c of CASES) {
    assertEquals(testAuthProblem(c.provider, c.command, c.good), null, `${c.provider} good`);
    for (const env of c.signIn) {
      const problem = testAuthProblem(c.provider, c.command, env);
      assert(problem !== null && problem.startsWith(c.provider), `${c.provider} should be refused with ${JSON.stringify(env)}: ${problem}`);
    }
  }
});

Deno.test('test_auth_agy_without_key_dir_is_the_incident_and_is_refused', () => {
  // the stub address is set, but AIB found no key (the dummy key's file was ignored): no --gemini-dir = sign-in mode (OS keyring)
  const problem = testAuthProblem('antigravity', ['agy'], { GOOGLE_GEMINI_BASE_URL: STUB });
  assert(problem !== null && problem.includes('--gemini-dir') && problem.includes('keyring'), String(problem));
  assertEquals(testAuthProblem('antigravity', ['agy', '--gemini-dir', ''], { GOOGLE_GEMINI_BASE_URL: STUB }) !== null, true);
  assertEquals(testAuthProblem('antigravity', AGY_KEY_MODE, { GOOGLE_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com' }) !== null, true);
});

Deno.test('test_auth_unknown_provider_and_codex_home_config', () => {
  assert(testAuthProblem('some-new-agent', ['x'], { ANTHROPIC_BASE_URL: STUB, ANTHROPIC_API_KEY: 'k' })?.includes('no test auth rule'));
  const home = agentTempDirSync('aib-authguard-');
  try {
    assert(testAuthProblem('codex', ['codex-acp'], { CODEX_HOME: home }) !== null); // empty home: sign-in
    Deno.writeTextFileSync(`${home}/config.toml`, `[model_providers.stub]\nbase_url = "${STUB}/v1"\nrequires_openai_auth = false\n`);
    assertEquals(testAuthProblem('codex', ['codex-acp'], { CODEX_HOME: home }), null);
    Deno.writeTextFileSync(`${home}/config.toml`, `[model_providers.stub]\nbase_url = "${STUB}/v1"\nrequires_openai_auth = true\n`);
    assert(testAuthProblem('codex', ['codex-acp'], { CODEX_HOME: home }) !== null);
  } finally {
    Deno.removeSync(home, { recursive: true });
  }
});

/** Runs fn with these process variables, restored after. */
async function withEnv<T>(vars: Record<string, string | null>, fn: () => T | Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = Deno.env.get(k);
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test('test_auth_connection_refuses_real_agent_in_sign_in_mode_before_any_process_starts', async () => {
  const folder = agentTempDirSync('aib-authguard-');
  const clean = { GOOGLE_GEMINI_BASE_URL: STUB, GEMINI_API_KEY: null, GOOGLE_API_KEY: null, ANTHROPIC_API_KEY: null, ANTHROPIC_BASE_URL: null, CODEX_CONFIG: null };
  try {
    await withEnv({ AGENT_STUDIO_TEST: '1', AGENT_STUDIO_ALLOW_REAL_AGENT: '1', ...clean }, () => {
      // the incident: agy launched with no --gemini-dir (the dummy key was ignored). A program that does not exist: were the guard
      // missing, the error would be a spawn error, never the guard's.
      const agy = new Connection(['aib-no-such-agy'], folder, 'antigravity', { start: false });
      const error = assertThrows(() => agy.startProcess()) as Error;
      assert(error.message.includes('Test auth guard') && error.message.includes('antigravity'), error.message);
      assert(agy.process === null || agy.process === undefined, 'no process was started');
      for (const provider of ['claude', 'codex', 'gemini', 'qwen', 'maki', 'copilot']) {
        const c = new Connection([`aib-no-such-${provider}`], folder, provider, { start: false });
        const e = assertThrows(() => c.startProcess()) as Error;
        assert(e.message.includes('Test auth guard'), `${provider}: ${e.message}`);
      }
      // and the same through the keeper / WSL paths' shared check
      assertThrows(() => guardRealAgentAuth('antigravity', ['agy'], { GOOGLE_GEMINI_BASE_URL: STUB }, {}));
      guardRealAgentAuth('antigravity', AGY_KEY_MODE, { GOOGLE_GEMINI_BASE_URL: STUB }, {});
    });
    // not under test: no guard
    await withEnv({ AGENT_STUDIO_TEST: null }, () => guardRealAgentAuth('antigravity', ['agy'], {}, {}));
  } finally {
    Deno.removeSync(folder, { recursive: true });
  }
});

Deno.test('test_auth_codex_limits_probe_does_not_start_codex_without_stub_config', async () => {
  await withEnv({ AGENT_STUDIO_TEST: '1', AGENT_STUDIO_ALLOW_REAL_AGENT: '1', CODEX_CONFIG: null, CODEX_HOME: null }, async () => {
    assertEquals(await appServerLimits(['aib-no-such-codex', 'app-server'], {}, 2000), null);
  });
});

Deno.test('test_auth_credential_fallbacks_are_closed_by_env_in_windows_and_wsl_test_homes', async () => {
  await withEnv({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-ab12' }, () => {
    const win = testHomeEnv(['claude-agent-acp']);
    for (const name of ['GH_CONFIG_DIR', 'CLOUDSDK_CONFIG']) assert(win[name]?.startsWith(win.HOME), `${name} is inside the test home: ${win[name]}`);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS']) assertEquals(win[name], '');
    const wsl = wslTestHomeEnv();
    assertEquals(wsl.GH_CONFIG_DIR, '/tmp/aib-wsl-test-ab12/home/.config/gh');
    assertEquals(wsl.CLOUDSDK_CONFIG, '/tmp/aib-wsl-test-ab12/home/.config/gcloud');
    assertEquals(wsl.DBUS_SESSION_BUS_ADDRESS, '');
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS']) assertEquals(wsl[name], '');
  });
});
