/**
 * Subscription usage limits for the composer's Limits chip: the parsers (samples from outputs/usage-limits/usage-limits-research.md),
 * the per-account store and its persistence, the Codex session-file reader and its app-server fallback, the once-a-minute throttle,
 * and the Studio end to end with fake agents (Claude's rateLimit meta, Qwen's quota error, Vibe's _account/read; OMP gets none).
 * Never reads the owner's ~/.codex: every Codex home here is a temp folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, PYTHON, until } from './_connection.ts';
import { WORK } from './_parity.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { type LimitsConnection, LimitsFeed } from '../../outputs/agent-studio/server/host/usage_limits_feed.ts';
import {
  accountKey,
  claudeWindowType,
  FILE,
  type LimitsSnapshot,
  MAX_ACCOUNTS,
  parseClaudeRateLimit,
  parseCodexAppServer,
  parseCodexRollout,
  parseQwenQuota,
  parseVibeAccount,
  UsageLimitsStore,
} from '../../outputs/agent-studio/server/state/usage_limits.ts';
import { appServerCommand, appServerLimits, latestRolloutLimits } from '../../outputs/agent-studio/server/agents/codex_limits.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const nativePath = (url: URL) => {
  const path = decodeURIComponent(url.pathname);
  return Deno.build.os === 'windows' ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
};
const FAKE_APP_SERVER = nativePath(new URL('fake_codex_app_server.py', WORK));
const FAKE_UNIQUE = nativePath(new URL('fake_acp_unique.py', WORK)); // two chats open at once need different session ids
const lines = (path: string) => Deno.readTextFileSync(path).trim().split(/\r?\n/);

// ---- samples from the research report -----------------------------------------------------------------------------------
const CLAUDE_META = {
  status: 'allowed',
  resetsAt: 1794708000,
  rateLimitType: 'seven_day',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  isUsingOverage: false,
  unifiedWindows: { seven_day: { utilization: 0.23, resetsAt: 1794708000, status: 'allowed' } },
};
const CODEX_ROLLOUT = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 4.0, window_minutes: 300, resets_at: 1794388969 },
  secondary: { used_percent: 48.0, window_minutes: 10080, resets_at: 1794613768 },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  individual_limit: null,
  spend_control_reached: null,
  plan_type: 'plus',
  rate_limit_reached_type: null,
};
const VIBE_ACCOUNT = {
  status: 'ready',
  plan: { kind: 'mistral_code', name: 'pro', title: 'Pro' },
  budget: { usagePercentage: 37.5, resetAt: '2026-12-01T00:00:00Z', paygEnabled: false },
  rateLimitAction: null,
};

const brief = (s: LimitsSnapshot | null) => s && s.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt, w.status]);

Deno.test("Claude: the report's _claude/rateLimit payload gives a weekly window at 23% (fraction x 100), extra usage off", () => {
  const s = parseClaudeRateLimit(CLAUDE_META, 1000)!;
  assertEquals(brief(s), [['seven_day', 'wk', 23, 1794708000, 'allowed']]);
  assertEquals([s.agent, s.source, s.updatedAt, s.notes, s.blocked], ['claude', 'claude-acp', 1000, ['Extra usage: off'], null]);
  assertEquals(s.windows[0].name, 'Weekly');
  // Window types: lengths from the name, a model scope, and types that are not plan windows.
  assertEquals(claudeWindowType('five_hour'), { minutes: 300, scope: '' });
  assertEquals(claudeWindowType('seven_day_opus'), { minutes: 10080, scope: 'Opus' });
  assertEquals(claudeWindowType('overage'), null);
  assertEquals(claudeWindowType('seven_day_overage_included'), null);
  assertEquals(claudeWindowType('seven_day_oauth_apps'), null);
  // Only the top-level fields (no unifiedWindows): the window is still known; rejected wins.
  const top = parseClaudeRateLimit({ status: 'rejected', resetsAt: 1794708000, rateLimitType: 'five_hour', utilization: 1 }, 5)!;
  assertEquals(brief(top), [['five_hour', '5h', 100, 1794708000, 'rejected']]);
  assertEquals(parseClaudeRateLimit({ status: 'allowed' }, 5), null);
  assertEquals(parseClaudeRateLimit('nope', 5), null);
  const scoped = parseClaudeRateLimit({ unifiedWindows: { seven_day_fable: { utilization: 0.5, resetsAt: 1794708000 } } }, 5)!;
  assertEquals([scoped.windows[0].label, scoped.windows[0].name], ['wk Fable', 'Weekly · Fable']);
});

Deno.test("Codex: the report's rollout token_count and the app-server's camelCase give 5h and weekly windows and the plan", () => {
  const s = parseCodexRollout(CODEX_ROLLOUT, 2000)!;
  assertEquals(brief(s), [['primary', '5h', 4, 1794388969, 'allowed'], ['secondary', 'wk', 48, 1794613768, 'allowed']]);
  assertEquals([s.plan, s.source, s.notes], ['ChatGPT Plus', 'codex-rollout', []]);
  const reached = parseCodexRollout({ ...CODEX_ROLLOUT, rate_limit_reached_type: 'primary' }, 1)!;
  assertEquals(reached.windows.map((w) => w.status), ['rejected', 'rejected']);
  const app = parseCodexAppServer({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794388969 }, planType: 'pro' },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794388969 }, planType: 'pro' },
      gpt_x: { limitId: 'gpt_x', limitName: 'GPT-X', secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: null } },
    },
  }, 3000)!;
  assertEquals(brief(app), [['primary', '5h', 12, 1794388969, 'allowed'], ['gpt_x:secondary', 'wk GPT-X', 3, null, 'allowed']]);
  assertEquals([app.plan, app.source], ['ChatGPT Pro', 'codex-app-server']);
  assertEquals(parseCodexAppServer({}, 1), null);
  assertEquals(parseCodexRollout({ primary: null, secondary: null }, 1), null);
});

Deno.test("Vibe and Qwen: _account/read's monthly budget; Qwen's quota error is 'limit reached' with its reset", () => {
  const v = parseVibeAccount(VIBE_ACCOUNT, 10)!;
  assertEquals(brief(v), [['month', 'mo', 37.5, Date.parse('2026-12-01T00:00:00Z') / 1000, 'allowed']]);
  assertEquals([v.plan, v.windows[0].name, v.notes], ['Mistral Pro', 'Monthly Vibe budget', ['Pay-as-you-go: off']]);
  assertEquals(parseVibeAccount({ account: VIBE_ACCOUNT }, 10)!.windows.length, 1); // the app-server shape wraps it
  assertEquals(parseVibeAccount({ status: 'missing_key' }, 10), null);
  const over = parseVibeAccount({ ...VIBE_ACCOUNT, budget: { usagePercentage: 100, paygEnabled: false } }, 10)!;
  assertEquals(over.windows[0].status, 'rejected');
  const q = parseQwenQuota({ memberType: 'plus', resetAt: 1794708000 }, 20)!;
  assertEquals([q.windows, q.blocked, q.plan, q.notes], [[], { resetsAt: 1794708000 }, 'Qwen Plus', ['Weekly credits used up']]);
  assertEquals(parseQwenQuota({}, 20), null);
});

Deno.test('accounts: one key per agent and config folder; agents with no official source (OMP, Kimi) have none', () => {
  assertEquals(accountKey('claude', {}), Deno.env.get('CLAUDE_CONFIG_DIR') ? accountKey('claude', null) : 'claude');
  assertEquals(accountKey('claude', { CLAUDE_CONFIG_DIR: 'C:\\Users\\Me\\.claude-work\\' }), 'claude|w:c:/users/me/.claude-work');
  assertEquals(accountKey('codex', { CODEX_HOME: '/home/me/.codex-b' }), 'codex|p:/home/me/.codex-b');
  for (const agent of ['omp', 'kimi', 'gemini', 'copilot', 'goose']) assertEquals(accountKey(agent, {}), '');
});

Deno.test('the store: Claude windows merge per account, older readings never win, and it survives a restart', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-limits-store-' });
  try {
    const store = new UsageLimitsStore(dir);
    assert(
      store.record('claude', parseClaudeRateLimit({ unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1794700000 } } }, 100)),
    );
    assert(store.record('claude', parseClaudeRateLimit(CLAUDE_META, 200)));
    assertEquals(store.get('claude')!.windows.map((w) => [w.id, w.usedPercent]), [['five_hour', 42], ['seven_day', 23]]);
    // A replayed older event changes nothing; the same reading again is not a change.
    assert(!store.record('claude', parseClaudeRateLimit({ unifiedWindows: { seven_day: { utilization: 0.1 } } }, 150)));
    assert(!store.record('claude', parseClaudeRateLimit(CLAUDE_META, 200)));
    // Codex replaces the whole snapshot; another account is separate.
    store.record('codex', parseCodexRollout(CODEX_ROLLOUT, 300));
    store.record('codex|p:/other', parseCodexRollout({ ...CODEX_ROLLOUT, primary: null }, 300));
    const again = new UsageLimitsStore(dir);
    assertEquals(again.get('claude')!.windows.map((w) => w.usedPercent), [42, 23]);
    assertEquals(again.get('codex')!.windows.length, 2);
    assertEquals(again.get('codex|p:/other')!.windows.length, 1);
    assertEquals(again.get(''), null);
    const saved = JSON.parse(Deno.readTextFileSync(dir + SEP + FILE));
    assertEquals(saved.version, 1);
    for (let i = 0; i < MAX_ACCOUNTS + 5; i++) again.record(`codex|p:/n${i}`, parseCodexRollout(CODEX_ROLLOUT, 400 + i));
    assertEquals(Object.keys(again.accounts).length, MAX_ACCOUNTS);
    // No state folder: memory only.
    const mem = new UsageLimitsStore(null);
    assert(mem.record('claude', parseClaudeRateLimit(CLAUDE_META, 1)));
    assertEquals(mem.path, null);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ---- Codex: session files, then the app-server ------------------------------------------------------------------------
function codexHomeFixture(): string {
  return Deno.makeTempDirSync({ prefix: 'aib-codex-home-' });
}
function writeRollout(home: string, day: string, name: string, lines: unknown[], mtime: number): string {
  const folder = [home, 'sessions', ...day.split('/')].join(SEP);
  Deno.mkdirSync(folder, { recursive: true });
  const path = folder + SEP + name;
  Deno.writeTextFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  Deno.utimeSync(path, mtime, mtime);
  return path;
}
const tokenCount = (stamp: string, rateLimits: unknown) => ({
  timestamp: stamp,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5 } }, rate_limits: rateLimits },
});

Deno.test('Codex session files: the newest rollout (by modified time, even in an older day folder) and its last token_count', () => {
  const home = codexHomeFixture();
  try {
    assertEquals(latestRolloutLimits(home), null); // no sessions folder at all
    writeRollout(home, '2026/11/11', 'rollout-2026-11-11T08-00-00-b.jsonl', [
      tokenCount('2026-11-11T08:00:00Z', { ...CODEX_ROLLOUT, primary: { ...CODEX_ROLLOUT.primary, used_percent: 2 } }),
    ], 1794380000);
    // A session started yesterday and still written to today is the newest.
    writeRollout(home, '2026/11/10', 'rollout-2026-11-10T23-31-30-a.jsonl', [
      { timestamp: '2026-11-10T23:31:30Z', type: 'session_meta', payload: { id: 'a' } },
      tokenCount('2026-11-11T06:00:00Z', { ...CODEX_ROLLOUT, primary: { ...CODEX_ROLLOUT.primary, used_percent: 3 } }),
      tokenCount('2026-11-11T06:59:20.416Z', CODEX_ROLLOUT),
      tokenCount('2026-11-11T07:00:00Z', { ...CODEX_ROLLOUT, limit_id: 'other_model' }), // another bucket: skipped
      '{"timestamp":"2026-11-11T07:00:01Z","type":"event_msg","payload":{"type":"token_count","rate_lim', // being written
    ], 1794390000);
    const found = latestRolloutLimits(home)!;
    assertEquals([found.rateLimits.primary, found.at], [CODEX_ROLLOUT.primary, Date.parse('2026-11-11T06:59:20.416Z') / 1000]);
    // The newest file has no numbers yet (a new session before its first reply): the next newest is used.
    writeRollout(home, '2026/11/11', 'rollout-2026-11-11T09-00-00-c.jsonl', [{ type: 'session_meta', payload: {} }], 1794400000);
    assertEquals((latestRolloutLimits(home)!.rateLimits.primary as Json).used_percent, 4);
  } finally {
    Deno.removeSync(home, { recursive: true });
  }
});

Deno.test({
  name: 'Codex app-server fallback: initialize, initialized, one account/rateLimits/read; a failed read gives nothing',
  ...T,
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-codex-app-' });
    try {
      const log = dir + SEP + 'methods.log';
      const result = await appServerLimits([PYTHON, FAKE_APP_SERVER, 'app-server', '--log', log]);
      const s = parseCodexAppServer(result, 1)!;
      assertEquals(brief(s), [['primary', '5h', 12, 4000000000, 'allowed'], ['secondary', 'wk', 86, 4000500000, 'allowed']]);
      assertEquals(lines(log), ['initialize', 'initialized', 'account/rateLimits/read']);
      assertEquals(await appServerLimits([PYTHON, FAKE_APP_SERVER, '--fail']), null);
      // Under test only fixtures may start: the real codex is refused, not run.
      assertEquals(await appServerLimits(['codex', 'app-server']), null);
      // The command: CODEX_PATH, else @openai/codex next to codex-acp.
      assertEquals(appServerCommand(['node', 'x'], { CODEX_PATH: 'C:\\bin\\codex.exe' }), ['C:\\bin\\codex.exe', 'app-server']);
      const pkg = [dir, 'node_modules', '@openai', 'codex', 'bin'].join(SEP);
      Deno.mkdirSync(pkg, { recursive: true });
      Deno.writeTextFileSync(pkg + SEP + 'codex.js', '');
      const entry = [dir, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'].join(SEP);
      assertEquals(appServerCommand(['node', entry], {}), ['node', pkg + SEP + 'codex.js', 'app-server']);
      assertEquals(appServerCommand(['node', dir + SEP + 'index.js'], {}), null);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

function fakeConnection(provider: string, extra: Partial<LimitsConnection> = {}): LimitsConnection {
  return {
    provider,
    command: ['node', 'codex-acp.js'],
    env: {},
    sessionId: 's1',
    ready: true,
    closed: false,
    request: () => Promise.reject(new Error('no requests expected')),
    ...extra,
  };
}

Deno.test({
  name: 'the feed: Codex reads session files first, else the app-server; at most once a minute per account; OMP never',
  ...T,
  async fn() {
    const home = codexHomeFixture();
    const log = home + SEP + 'methods.log';
    let clock = 1_000_000;
    try {
      const feed = new LimitsFeed(new UsageLimitsStore(null), {
        now: () => clock,
        codexHome: () => home,
        appServer: () => [PYTHON, FAKE_APP_SERVER, 'app-server', '--log', log],
      });
      const codex = fakeConnection('codex');
      // No session file: the app-server answers.
      await feed.refresh(codex);
      assertEquals([feed.view(codex)!.source, feed.view(codex)!.windows[1].usedPercent], ['codex-app-server', 86]);
      assertEquals(lines(log).filter((l) => l === 'account/rateLimits/read').length, 1);
      // Within the minute nothing is read again, even with a session file now present.
      writeRollout(
        home,
        '2026/11/11',
        'rollout-x.jsonl',
        [tokenCount(new Date((clock + 30) * 1000).toISOString(), CODEX_ROLLOUT)],
        1794390000,
      );
      clock += 30;
      await feed.refresh(codex);
      assertEquals(feed.view(codex)!.source, 'codex-app-server');
      // After a minute: the session file (newer than the app-server reading) wins; the app-server is not asked.
      clock += 31;
      await feed.refresh(codex);
      assertEquals([feed.view(codex)!.source, feed.view(codex)!.windows[1].usedPercent], ['codex-rollout', 48]);
      assertEquals(lines(log).filter((l) => l === 'account/rateLimits/read').length, 1);
      // Two refreshes at once share one read.
      clock += 61;
      await Promise.all([feed.refresh(codex), feed.refresh(codex)]);
      // OMP: nothing is read and nothing is shown, whatever the agent sends.
      const omp = fakeConnection('omp');
      feed.fromAgent(omp, 'claude-rate-limit', CLAUDE_META, clock);
      await feed.refresh(omp);
      assertEquals(feed.view(omp), null);
      // Claude: pushed only, never read.
      const claude = fakeConnection('claude');
      await feed.refresh(claude);
      assertEquals(feed.view(claude), null);
      feed.fromAgent(claude, 'claude-rate-limit', CLAUDE_META, clock);
      assertEquals(feed.view(claude)!.windows[0].usedPercent, 23);
      // Vibe: _account/read with the chat's session; an agent that does not know it is not asked again.
      let asked = 0;
      const vibe = fakeConnection('vibe', {
        request: (m, p) => (asked++, Promise.resolve(m === '_account/read' && p.sessionId === 's1' ? VIBE_ACCOUNT : null)),
      });
      await feed.refresh(vibe);
      assertEquals([asked, feed.view(vibe)!.windows[0].usedPercent], [1, 37.5]);
      // Without a home (the default under test) Codex is not read at all.
      const blind = new LimitsFeed(new UsageLimitsStore(null), { appServer: () => null });
      await blind.refresh(codex);
      assertEquals(blind.view(codex), null);
    } finally {
      Deno.removeSync(home, { recursive: true });
    }
  },
});

// ---- the Studio end to end with fake agents -----------------------------------------------------------------------------
class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-limits-test-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'project';
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }
  manager(): Studio {
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, autoReconnect: false });
    studio.ownerProbe = () => null;
    studio.agentLaunch = () => Promise.resolve([['fixture'], {}]);
    studio.connectionFactory = (_command, cwd, provider) => new Connection([PYTHON, FAKE_UNIQUE, '--limits'], cwd, provider);
    this.studios.push(studio);
    return studio;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

const limitsOf = async (studio: Studio, c: Connection) => ((await studio.liveState(c.id, 0)) as Json).limits as LimitsSnapshot | null;

Deno.test({
  name: "Studio: Claude's rateLimit reaches every chat on the account and survives a restart; OMP chats get no limits",
  ...T,
  async fn() {
    await using lab = new Lab();
    const studio = lab.manager();
    const first = await studio.connect('claude', lab.work, null, {});
    assertEquals(await limitsOf(studio, first), null); // nothing known yet: no chip
    await first.prompt('ratelimit:' + JSON.stringify(CLAUDE_META));
    await until(async () => !first.busy && (await limitsOf(studio, first)) !== null, 'the limits to arrive');
    assertEquals(brief(await limitsOf(studio, first)), [['seven_day', 'wk', 23, 1794708000, 'allowed']]);
    // A second chat on the same account shows them before it ever got an event.
    const second = await studio.connect('claude', lab.work, null, {});
    assertEquals((await limitsOf(studio, second))!.windows[0].usedPercent, 23);
    const omp = await studio.connect('omp', lab.work, null, {});
    await omp.prompt('ratelimit:' + JSON.stringify(CLAUDE_META));
    await until(() => !omp.busy, 'the OMP turn to end');
    assertEquals(await limitsOf(studio, omp), null);
    await studio.close();
    // After a restart the account's last numbers are still there.
    const later = lab.manager();
    const third = await later.connect('claude', lab.work, null, {});
    assertEquals((await limitsOf(later, third))!.windows[0].usedPercent, 23);
  },
});

Deno.test({
  name: "Studio: Qwen's quota error marks the cap reached; Vibe's _account/read fills its chip when the chat opens",
  ...T,
  async fn() {
    await using lab = new Lab();
    const studio = lab.manager();
    const qwen = await studio.connect('qwen', lab.work, null, {});
    await qwen.prompt('quota:4000000000');
    await until(async () => !qwen.busy && (await limitsOf(studio, qwen)) !== null, 'the quota notice');
    const q = (await limitsOf(studio, qwen))!;
    assertEquals([q.blocked, q.plan], [{ resetsAt: 4000000000 }, 'Qwen Plus']);
    const vibe = await studio.connect('vibe', lab.work, null, {});
    await until(async () => (await limitsOf(studio, vibe)) !== null, 'the Vibe account read');
    assertEquals(brief(await limitsOf(studio, vibe)), [['month', 'mo', 37.5, Date.parse('2099-12-01T00:00:00Z') / 1000, 'allowed']]);
  },
});
