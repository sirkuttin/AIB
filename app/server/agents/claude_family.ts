/**
 * Model-server agent entries: `<agent>@<server id>` for Claude Code, Codex, Maki and Qwen Code. A model server (its own record, with
 * its own id such as `strata`) is offered as one separate entry per agent turned on for it ("Use with"); the entry runs the SAME
 * adapter as its base agent, only the environment (and for Codex its own CODEX_HOME) differs. Every place that keys agent-specific
 * behaviour on the agent id asks baseAgent(id) / isClaudeFamily(id), never `id === 'claude'` or `id === 'codex'`.
 * No imports: safe to use from any module (the page has its own copy of the id regular expressions in agent-choice.js).
 */
/** The agents a model server is offered as: `<agent>@<server id>`. */
export const MODEL_SERVER_AGENTS: readonly string[] = ['claude', 'codex', 'maki', 'qwen'];
export const MODEL_SERVER_PREFIX = 'claude@';
/** <agent>@<server id>; the server id is lower case letters, digits and single dashes (at most 30 characters). */
export const MODEL_SERVER_ID_RE = /^(claude|codex|maki|qwen)@[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True for a model-server agent entry id (`claude@strata`, `codex@strata`, `maki@strata`, `qwen@strata`). */
export function isModelServerId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 48 && MODEL_SERVER_ID_RE.test(value);
}

/** The same as isModelServerId: the id of a separate New chat entry built from a model server. */
export const isServerEntry = isModelServerId;

/** The agent an id acts like: `claude@strata` is `claude`, `codex@strata` is `codex`; any other id is itself. */
export function baseAgent(value: string): string {
  return isModelServerId(value) ? value.slice(0, value.indexOf('@')) : value;
}

/** True for `claude` and for every `claude@<server id>` entry. */
export function isClaudeFamily(value: unknown): boolean {
  return value === 'claude' || (isModelServerId(value) && baseAgent(value) === 'claude');
}

/** True for `codex` and for every `codex@<server id>` entry. */
export function isCodexFamily(value: unknown): boolean {
  return value === 'codex' || (isModelServerId(value) && baseAgent(value) === 'codex');
}

/** True for `qwen` and for every `qwen@<server id>` entry. */
export function isQwenFamily(value: unknown): boolean {
  return value === 'qwen' || (isModelServerId(value) && baseAgent(value) === 'qwen');
}

/** What AIB's per-agent tables (limits, titles, steer copy, transcripts) know an entry as: its base agent (`claude`, `codex`, ...). */
export function claudeBase(value: string): string {
  return baseAgent(value);
}

/** A model server's own id: the slug (`strata`). Agent entries are built from it: `claude@strata`, `codex@strata`, ... */
export const SERVER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isServerId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 30 && SERVER_ID_RE.test(value);
}

export function modelServerAgentId(agent: string, serverId: string): string {
  return `${agent}@${serverId}`;
}

/** The server id inside an `<agent>@<server id>` agent id, else null. */
export function serverIdOf(agentId: unknown): string | null {
  return isModelServerId(agentId) ? agentId.slice(agentId.indexOf('@') + 1) : null;
}

/** The same agent for session listing: Claude Code and its model-server entries share one saved-chat folder, so any of them can list it. */
export function sameAgent(a: unknown, b: unknown): boolean {
  return a === b || (isClaudeFamily(a) && isClaudeFamily(b));
}
