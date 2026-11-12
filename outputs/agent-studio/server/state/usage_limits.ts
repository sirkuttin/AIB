/**
 * Subscription usage limits per agent account (the composer's Limits chip). Official channels only (owner decision):
 *
 *   Claude Code   usage_update._meta["_claude/rateLimit"], pushed by claude-agent-acp during a turn when the numbers change
 *   Codex         token_count.rate_limits in the newest ~/.codex/sessions rollout, else app-server account/rateLimits/read
 *                 (server/agents/codex_limits.ts reads both)
 *   Mistral Vibe  the ACP extension request _account/read (budget.usagePercentage, a monthly allowance)
 *   Qwen Code     only the session/prompt error that carries data.subscriptionQuota {memberType, resetAt} once the cap is hit
 *
 * Every other agent (OMP included, owner decision) has no limits and no chip. Nothing here sends a prompt or uses quota.
 *
 * Limits belong to the account, not the chat: kept per account key (agent id, plus its config folder when one is set) so every chat
 * on that account shows the latest numbers, and remembered in the state folder so a new chat is not empty after a restart.
 *
 *   usage-limits.json: {"version": 1, "accounts": {key: Snapshot}}
 *
 * Agent-supplied values are untrusted: numbers are range checked, strings length limited, nothing is interpreted.
 */
import { writeJsonAtomic } from '../core/fs.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('usage-limits');

type Json = Record<string, unknown>;

export const FILE = 'usage-limits.json';
export const MAX_ACCOUNTS = 50;
const MAX_WINDOWS = 12;

/** The agents with an official source of limit data. Every other agent shows no chip. */
export const LIMIT_AGENTS = ['claude', 'codex', 'vibe', 'qwen'] as const;

export interface LimitWindow {
  /** Stable id within the account: Claude's window type (five_hour, seven_day_opus) or Codex's primary / secondary. */
  id: string;
  /** Short chip label from the window length: 5h, wk, mo, 3d; a model-scoped window adds its model (wk Opus). */
  label: string;
  /** Hover name: 5-hour, Weekly, Monthly; a model-scoped window adds its model (Weekly · Opus). */
  name: string;
  minutes: number | null;
  /** 0-100 (may pass 100 while overage runs); null when the agent named the window without a number. */
  usedPercent: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
  /** allowed | allowed_warning | rejected. */
  status: string;
  /** Model the window is limited to ('' = all models). */
  scope: string;
}

export interface LimitsSnapshot {
  agent: string;
  /** claude-acp | codex-rollout | codex-app-server | vibe-acp | qwen-error */
  source: string;
  /** Unix seconds the numbers are from. */
  updatedAt: number;
  plan: string;
  windows: LimitWindow[];
  notes: string[];
  /** Set when the agent said the cap is reached and gave no per-window numbers (Qwen). */
  blocked: { resetsAt: number | null } | null;
}

const isDict = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, n = 80): string => (typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : '');
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Unix seconds from seconds, milliseconds or an ISO date; null when it is none of these or out of range. */
export function toSeconds(v: unknown): number | null {
  let n = finite(v);
  if (n === null && typeof v === 'string' && v.trim()) {
    const parsed = Date.parse(v);
    n = Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  if (n === null || n <= 0) return null;
  if (n > 1e11) n = n / 1000; // milliseconds
  return n < 4102444800 ? Math.round(n) : null; // before 2100
}

const percent = (v: number | null): number | null => (v === null ? null : Math.max(0, Math.min(1000, Math.round(v * 10) / 10)));

/** Label and hover name for a window of this many minutes (5h / 5-hour, wk / Weekly, mo / Monthly). */
export function windowWords(minutes: number | null): { label: string; name: string } {
  if (minutes === null || minutes <= 0) return { label: 'limit', name: 'Limit' };
  if (minutes < 60) return { label: `${minutes}m`, name: `${minutes}-minute` };
  if (minutes < 1440) {
    const h = Math.round(minutes / 60);
    return { label: `${h}h`, name: `${h}-hour` };
  }
  if (minutes >= 6.5 * 1440 && minutes <= 7.5 * 1440) return { label: 'wk', name: 'Weekly' };
  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) return { label: 'mo', name: 'Monthly' };
  const d = Math.round(minutes / 1440);
  return { label: `${d}d`, name: `${d}-day` };
}

function makeWindow(
  id: string,
  minutes: number | null,
  scope: string,
  usedPercent: number | null,
  resetsAt: number | null,
  status: string,
) {
  const words = windowWords(minutes);
  return {
    id: text(id, 60),
    label: scope ? `${words.label} ${scope}` : words.label,
    name: scope ? `${words.name} · ${scope}` : words.name,
    minutes,
    usedPercent: percent(usedPercent),
    resetsAt,
    status: ['allowed', 'allowed_warning', 'rejected'].includes(status) ? status : 'allowed',
    scope,
  } satisfies LimitWindow;
}

// ---- Claude Code ---------------------------------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  thirty: 30,
};
const UNIT_MINUTES: Record<string, number> = { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 };

/** five_hour -> 300 min, seven_day_opus -> 10080 min scoped to Opus; null for types that are not a window (overage). */
export function claudeWindowType(type: string): { minutes: number; scope: string } | null {
  const m = /^([a-z]+|\d+)_(minute|hour|day|week|month)s?(?:_([a-z0-9_]+))?$/.exec(type);
  if (!m) return null;
  const count = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  if (!count) return null;
  const rest = m[3] || '';
  if (/overage|oauth/.test(rest)) return null; // overage pools and the OAuth-apps bucket are not plan windows
  const scope = rest.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { minutes: count * UNIT_MINUTES[m[2]], scope: text(scope, 30) };
}

/**
 * claude-agent-acp's `_claude/rateLimit` (the SDK's rate_limit_info): {status, resetsAt, rateLimitType, utilization?, overageStatus,
 * isUsingOverage, unifiedWindows?: {type: {utilization (fraction), resetsAt, status}}}. Each event may carry only some windows;
 * mergeSnapshot keeps the ones it does not mention. null when nothing usable is in it.
 */
export function parseClaudeRateLimit(raw: unknown, at: number): LimitsSnapshot | null {
  if (!isDict(raw)) return null;
  const windows = new Map<string, LimitWindow>();
  const unified = isDict(raw.unifiedWindows) ? raw.unifiedWindows : {};
  for (const [type, value] of Object.entries(unified).slice(0, MAX_WINDOWS)) {
    const kind = claudeWindowType(type);
    if (!kind || !isDict(value)) continue;
    const used = finite(value.utilization);
    windows.set(
      type,
      makeWindow(type, kind.minutes, kind.scope, used === null ? null : used * 100, toSeconds(value.resetsAt), text(value.status, 30)),
    );
  }
  const type = text(raw.rateLimitType, 60);
  const kind = type ? claudeWindowType(type) : null;
  if (kind) {
    const known = windows.get(type);
    const used = finite(raw.utilization);
    const status = text(raw.status, 30);
    windows.set(
      type,
      makeWindow(
        type,
        kind.minutes,
        kind.scope,
        known?.usedPercent ?? (used === null ? null : used * 100),
        known?.resetsAt ?? toSeconds(raw.resetsAt),
        known && status !== 'rejected' ? known.status : status,
      ),
    );
  }
  if (!windows.size) return null;
  const notes: string[] = [];
  if (raw.isUsingOverage === true) notes.push('Extra usage: in use');
  else if (raw.overageStatus === 'allowed' || raw.overageStatus === 'allowed_warning') notes.push('Extra usage: on');
  else if (typeof raw.overageStatus === 'string') notes.push('Extra usage: off');
  return { agent: 'claude', source: 'claude-acp', updatedAt: at, plan: '', windows: [...windows.values()], notes, blocked: null };
}

// ---- Codex ---------------------------------------------------------------------------------------------------------------

const CODEX_PLANS: Record<string, string> = {
  free: 'ChatGPT Free',
  go: 'ChatGPT Go',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  team: 'ChatGPT Team',
  business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise',
  edu: 'ChatGPT Edu',
};

const pick = (o: Json, snake: string, camel: string): unknown => (Object.hasOwn(o, camel) ? o[camel] : o[snake]);

function codexWindow(id: string, value: unknown, scope: string, reached: boolean): LimitWindow | null {
  if (!isDict(value)) return null;
  const used = finite(pick(value, 'used_percent', 'usedPercent'));
  const minutes = finite(pick(value, 'window_minutes', 'windowDurationMins'));
  if (used === null) return null;
  return makeWindow(
    id,
    minutes === null ? null : Math.round(minutes),
    scope,
    used,
    toSeconds(pick(value, 'resets_at', 'resetsAt')),
    reached || used >= 100 ? 'rejected' : 'allowed',
  );
}

/** One Codex rate-limit bucket's windows, plan and credits; works for the rollout's snake_case and the app-server's camelCase. */
function codexBucket(bucket: Json, scope: string, prefix: string) {
  const reached = !!pick(bucket, 'rate_limit_reached_type', 'rateLimitReachedType');
  const windows = [
    codexWindow(prefix + 'primary', bucket.primary, scope, reached),
    codexWindow(prefix + 'secondary', bucket.secondary, scope, reached),
  ].filter((w): w is LimitWindow => !!w);
  const planId = text(pick(bucket, 'plan_type', 'planType'), 40).toLowerCase();
  const plan = planId && planId !== 'unknown' ? CODEX_PLANS[planId] ?? `ChatGPT ${planId.charAt(0).toUpperCase()}${planId.slice(1)}` : '';
  const notes: string[] = [];
  const credits = bucket.credits;
  if (!scope && isDict(credits)) {
    if (credits.unlimited === true) notes.push('Credits: unlimited');
    else if (credits.has_credits === true || credits.hasCredits === true) {
      const balance = text(credits.balance, 20);
      if (balance && balance !== '0') notes.push(`Credits: ${balance}`);
    }
  }
  return { windows, plan, notes };
}

/** A rollout `token_count` event's rate_limits (snake_case). */
export function parseCodexRollout(rateLimits: unknown, at: number): LimitsSnapshot | null {
  if (!isDict(rateLimits)) return null;
  const { windows, plan, notes } = codexBucket(rateLimits, '', '');
  if (!windows.length) return null;
  return { agent: 'codex', source: 'codex-rollout', updatedAt: at, plan, windows, notes, blocked: null };
}

/**
 * app-server account/rateLimits/read: {rateLimits, rateLimitsByLimitId?: {id: bucket}}; each bucket {limitId, limitName, primary,
 * secondary: {usedPercent, windowDurationMins, resetsAt}, credits, planType, rateLimitReachedType}. The "codex" bucket (or
 * rateLimits) is the plan's; other buckets are shown as windows scoped to their limitName.
 */
export function parseCodexAppServer(result: unknown, at: number): LimitsSnapshot | null {
  if (!isDict(result)) return null;
  const byId = isDict(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : {};
  const main = isDict(byId.codex) ? byId.codex : isDict(result.rateLimits) ? result.rateLimits : null;
  if (!main) return null;
  const first = codexBucket(main, '', '');
  const windows = [...first.windows];
  for (const [id, bucket] of Object.entries(byId).slice(0, 6)) {
    if (id === 'codex' || !isDict(bucket) || bucket === main) continue;
    const scope = text(bucket.limitName, 30) || text(id, 30);
    windows.push(...codexBucket(bucket, scope, `${text(id, 30)}:`).windows);
  }
  if (!windows.length) return null;
  return { agent: 'codex', source: 'codex-app-server', updatedAt: at, plan: first.plan, windows, notes: first.notes, blocked: null };
}

// ---- Mistral Vibe --------------------------------------------------------------------------------------------------------

/** _account/read: {status, plan: {kind, name, title}, budget: {usagePercentage, resetAt, paygEnabled}}. null without a budget. */
export function parseVibeAccount(result: unknown, at: number): LimitsSnapshot | null {
  const account = isDict(result) && isDict(result.account) ? result.account : result; // the app-server shape wraps it
  if (!isDict(account) || !isDict(account.budget)) return null;
  const used = finite(account.budget.usagePercentage);
  if (used === null) return null;
  const payg = account.budget.paygEnabled === true;
  const plan = isDict(account.plan) ? text(account.plan.title, 40) || text(account.plan.name, 40) : '';
  const window = makeWindow('month', 43200, '', used, toSeconds(account.budget.resetAt), used >= 100 && !payg ? 'rejected' : 'allowed');
  window.name = 'Monthly Vibe budget';
  return {
    agent: 'vibe',
    source: 'vibe-acp',
    updatedAt: at,
    plan: plan ? `Mistral ${plan}` : '',
    windows: [window],
    notes: [payg ? 'Pay-as-you-go: on (use past 100% is billed)' : 'Pay-as-you-go: off'],
    blocked: null,
  };
}

// ---- Qwen Code -----------------------------------------------------------------------------------------------------------

/** The prompt error's data.subscriptionQuota {memberType, resetAt (seconds)}: the cap is reached. No percentages exist. */
export function parseQwenQuota(quota: unknown, at: number): LimitsSnapshot | null {
  if (!isDict(quota)) return null;
  const member = text(quota.memberType, 30);
  const resetsAt = toSeconds(quota.resetAt);
  if (!member && resetsAt === null) return null;
  const weekly = ['lite', 'plus', 'pro'].includes(member);
  return {
    agent: 'qwen',
    source: 'qwen-error',
    updatedAt: at,
    plan: member ? `Qwen ${member.charAt(0).toUpperCase()}${member.slice(1)}` : '',
    windows: [],
    notes: weekly ? ['Weekly credits used up'] : [],
    blocked: { resetsAt },
  };
}

// ---- accounts ------------------------------------------------------------------------------------------------------------

/** The config folder variable that selects another account of this agent. */
const HOME_VARS: Record<string, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', vibe: 'VIBE_HOME' };

/** 'claude', or 'claude|w:c:/users/me/.claude-work' when the agent runs with its own config folder. '' for agents with no limits. */
export function accountKey(agent: string, env: Record<string, string | undefined> | null = null): string {
  if (!(LIMIT_AGENTS as readonly string[]).includes(agent)) return '';
  const name = HOME_VARS[agent];
  const home = name ? (env?.[name] ?? Deno.env.get(name) ?? '').trim() : '';
  if (!home) return agent;
  const p = home.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${agent}|${/^[a-zA-Z]:/.test(p) || home.includes('\\') ? 'w:' + p.toLowerCase() : 'p:' + p}`;
}

/**
 * The newer snapshot for an account. Claude sends one window at a time, so its windows are merged into what was known; the
 * others replace the whole snapshot. An older reading (a replayed record, a rollout older than the app-server answer) is ignored.
 */
export function mergeSnapshot(before: LimitsSnapshot | null, next: LimitsSnapshot): LimitsSnapshot {
  if (before && next.updatedAt < before.updatedAt) return before;
  if (!before || before.agent !== next.agent || next.source !== 'claude-acp' || before.source !== 'claude-acp') return next;
  const windows = new Map(before.windows.map((w) => [w.id, w]));
  for (const w of next.windows) windows.set(w.id, w);
  return { ...next, plan: next.plan || before.plan, windows: [...windows.values()].slice(-MAX_WINDOWS) };
}

function validSnapshot(v: unknown): v is LimitsSnapshot {
  return isDict(v) && typeof v.agent === 'string' && typeof v.updatedAt === 'number' && Array.isArray(v.windows) &&
    Array.isArray(v.notes);
}

export class UsageLimitsStore {
  readonly path: string | null;
  accounts: Record<string, LimitsSnapshot> = {};

  constructor(stateDir: string | null) {
    this.path = stateDir ? `${stateDir}${stateDir.includes('\\') ? '\\' : '/'}${FILE}` : null;
    this.#load();
  }

  #load(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(Deno.readTextFileSync(this.path));
      if (isDict(raw) && isDict(raw.accounts)) {
        for (const [key, value] of Object.entries(raw.accounts)) if (validSnapshot(value)) this.accounts[key] = value;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) log.warning(`Remembered usage limits could not be read: ${error}`);
    }
  }

  #save(): void {
    if (!this.path) return;
    try {
      writeJsonAtomic(this.path, { version: 1, accounts: this.accounts });
    } catch (error) {
      log.warning(`Remembered usage limits could not be saved: ${error}`);
    }
  }

  get(key: string): LimitsSnapshot | null {
    return key && isDict(this.accounts[key]) ? this.accounts[key] : null;
  }

  /** Keep this reading for the account (merged, newest wins). true when what is kept changed. */
  record(key: string, snapshot: LimitsSnapshot | null): boolean {
    if (!key || !snapshot) return false;
    const before = this.get(key);
    const next = mergeSnapshot(before, snapshot);
    if (before && JSON.stringify(before) === JSON.stringify(next)) return false;
    delete this.accounts[key]; // newest last, so the oldest go first below
    this.accounts[key] = next;
    const keys = Object.keys(this.accounts);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ACCOUNTS))) delete this.accounts[k];
    this.#save();
    return true;
  }
}
