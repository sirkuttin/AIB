/**
 * The Claude family: the built-in agent `claude` and every model-server agent entry `claude@<server id>`. A model server (its own
 * record, with its own id such as `strata`) is offered as agents built from it; the Claude entry runs the SAME Claude adapter against
 * the server's Anthropic-compatible address. Every place that keys Claude-specific behaviour on the agent id asks isClaudeFamily(id),
 * never `id === 'claude'`.
 * No imports: safe to use from any module (the page has its own copy of the id regular expressions in agent-choice.js).
 */
export const MODEL_SERVER_PREFIX = 'claude@';
/** claude@<server id>; the server id is lower case letters, digits and single dashes (at most 30 characters). */
export const MODEL_SERVER_ID_RE = /^claude@[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True for a model-server Claude agent id (`claude@strata`). */
export function isModelServerId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 48 && MODEL_SERVER_ID_RE.test(value);
}

/** True for `claude` and for every `claude@<server id>` entry. */
export function isClaudeFamily(value: unknown): boolean {
  return value === 'claude' || isModelServerId(value);
}

/** What AIB's per-agent tables (limits, titles, steer copy, transcripts) know a family member as: `claude`. */
export function claudeBase(value: string): string {
  return isModelServerId(value) ? 'claude' : value;
}

/** A model server's own id: the slug (`strata`). Agent entries are built from it: `claude@strata` (later `codex@strata`). */
export const SERVER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isServerId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 30 && SERVER_ID_RE.test(value);
}

/** The agents a model server is offered as: `<agent>@<server id>`. Only Claude Code for now. */
export const MODEL_SERVER_AGENTS: readonly string[] = ['claude'];

export function modelServerAgentId(agent: string, serverId: string): string {
  return `${agent}@${serverId}`;
}

/** The server id inside a `claude@<server id>` agent id, else null. */
export function serverIdOf(agentId: unknown): string | null {
  return isModelServerId(agentId) ? agentId.slice(agentId.indexOf('@') + 1) : null;
}
