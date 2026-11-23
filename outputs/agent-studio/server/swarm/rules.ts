/**
 * Swarm phase 1: which provider does which job (built-in defaults; the editable rule list is phase 2), and each provider's
 * "edit inside the workspace" mode. A helper never runs in a mode that edits and runs anything without asking (review break 8):
 * start_helper takes no mode input, and a provider with no known workspace mode cannot be a helper (fail closed, break 7).
 *
 * Claude Code helpers are on by default (owner 2026-11-13) and follow swarm/settings.ts (CLAUDE_HELPERS_DEFAULT, swarm-settings.json):
 * off, every Claude row is skipped and a main agent naming Claude is refused.
 */
import { baseAgent } from '../agents/claude_family.ts';

export interface Rule {
  job: string;
  label: string;
  provider: string;
  /** A model hint for the agent's own list (phase 1: shown, not applied; the main agent may name a model itself). */
  model: string;
  fallback: string[];
}

export const DEFAULT_RULES: readonly Rule[] = [
  { job: 'search', label: 'Read-only search, find usages, summarise', provider: 'gemini', model: 'flash', fallback: ['codex', 'claude'] },
  { job: 'tests', label: 'Tests and bulk or mechanical edits', provider: 'codex', model: '', fallback: ['claude'] },
  { job: 'ui', label: 'UI, front-end and copy', provider: 'claude', model: 'sonnet', fallback: ['codex'] },
  { job: 'debug', label: 'Hard debugging and design', provider: 'claude', model: 'opus', fallback: ['codex'] },
  { job: 'other', label: 'Anything else', provider: 'codex', model: '', fallback: ['claude'] },
];

export const JOBS: readonly string[] = DEFAULT_RULES.map((r) => r.job);

/**
 * The mode id that lets each agent edit files in its own folder without asking while installs, network and writes outside still ask.
 * Checked against the agent's live mode list when the helper opens; a provider not listed here cannot be a helper.
 */
export const WORKSPACE_MODE: Readonly<Record<string, string>> = {
  claude: 'acceptEdits', // claude-agent-acp
  codex: 'auto', // codex-acp: read-only / auto (workspace-write) / full-access
  gemini: 'autoEdit', // gemini --experimental-acp: default / autoEdit / yolo
};

/** The edit-in-workspace mode of an agent or of a model-server entry (`claude@strata` works like `claude`); '' when AIB knows none. */
export const workspaceModeOf = (provider: string): string => WORKSPACE_MODE[baseAgent(provider)] ?? '';

export interface Pick {
  provider: string;
  model: string;
  rule: string;
  picked_by: 'rule' | 'main agent';
  /** Providers tried before this one and why each was skipped. */
  skipped: string[];
}

/**
 * The provider for a job: the rule's provider, else its fallbacks, skipping providers that are not usable (`usable` gives '' or the
 * reason) and Claude when Claude helpers are off. A named provider (the main agent's override) is used as is, or refused.
 */
export function pickProvider(
  job: string,
  usable: (provider: string) => string,
  claudeHelpers: boolean,
  named = '',
  model = '',
): Pick | { error: string } {
  const allowed = (p: string) => {
    if (p === 'claude' && !claudeHelpers) return 'Claude helpers are turned off in Settings';
    if (!WORKSPACE_MODE[baseAgent(p)]) return 'AIB knows no edit-in-workspace mode for it';
    return usable(p);
  };
  if (named) {
    const why = allowed(named);
    return why
      ? { error: `${named} can't be a helper: ${why}` }
      : { provider: named, model, rule: '', picked_by: 'main agent', skipped: [] };
  }
  const rule = DEFAULT_RULES.find((r) => r.job === job) ?? DEFAULT_RULES[DEFAULT_RULES.length - 1];
  const skipped: string[] = [];
  for (const p of [rule.provider, ...rule.fallback]) {
    const why = allowed(p);
    if (!why) return { provider: p, model, rule: rule.job, picked_by: 'rule', skipped };
    skipped.push(`${p}: ${why}`);
  }
  return { error: `No provider for "${rule.label}" can take a helper now (${skipped.join('; ')})` };
}
