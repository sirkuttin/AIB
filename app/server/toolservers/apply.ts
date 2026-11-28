/**
 * How a project's tool server choice reaches each agent, per launch and never by writing the user's config files. Every route was
 * probed with the real CLI (aib-shared/designs/tool-servers/probe.md); each function is pure (the choice in, a launch fragment out).
 *
 *   Claude Code   settings object of the session (_meta.claudeCode.options.settings): deniedMcpServers + permissions.deny for tools
 *   Codex         `mcp_servers.<id>` partial entries in CODEX_CONFIG: {enabled: false} / {disabled_tools: [...]}   (partial entries merge)
 *   Gemini CLI    `--allowed-mcp-server-names <kept>` and an admin policy rule per tool that is off (mcp_<server>_<tool>: deny)
 *   Qwen Code     system settings: mcp.excluded + a full copy of the entry with excludeTools for a server with tools off
 *   Copilot CLI   `--disable-mcp-server <id>` and `--excluded-tools <server>-<tool>`, repeated
 *   Antigravity   nothing to apply: with an API key AIB starts it with its own --gemini-dir, which holds none of the user's servers
 *                 (it reads <gemini-dir>/config/mcp_config.json, probed format); Google sign-in uses ~/.gemini: not possible
 *   Maki          not possible: no switch for its own servers
 */
import type { Effective } from './store.ts';
import type { AgentId, FoundServer } from './discover.ts';

type Json = Record<string, unknown>;

/** Claude Code, Gemini CLI and Qwen Code name a server in a tool name with every other character replaced by `_`. */
export const sanitized = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

/** Does this agent follow the project's list, and how well (the "Which agents follow this list" card). */
export type Reach = 'enforced' | 'partial' | 'none';
export interface AgentReach {
  agent: string;
  name: string;
  reach: Reach;
  /** What it follows: servers, single tools. */
  text: string;
}
export const REACH: AgentReach[] = [
  { agent: 'claude', name: 'Claude Code', reach: 'enforced', text: 'servers and single tools' },
  { agent: 'codex', name: 'Codex', reach: 'enforced', text: 'servers and single tools' },
  { agent: 'gemini', name: 'Gemini CLI', reach: 'enforced', text: 'servers and single tools' },
  { agent: 'qwen', name: 'Qwen Code', reach: 'enforced', text: 'servers and single tools' },
  { agent: 'copilot', name: 'GitHub Copilot CLI', reach: 'enforced', text: 'servers and single tools' },
  {
    agent: 'antigravity',
    name: 'Antigravity',
    reach: 'partial',
    text:
      "with an API key AIB starts it in its own settings folder, so your servers are not loaded at all. Signed in with Google it uses your own settings and its servers still start: AIB can't change that",
  },
  {
    agent: 'maki',
    name: 'Maki',
    reach: 'none',
    text: "can't follow it: it starts every server in its own settings. AIB's tools are the only ones AIB controls",
  },
];

/** The same card for a project in WSL: the files Gemini's policy and Qwen's settings need are written by AIB, which can't write them in the distro yet. */
export const REACH_WSL: AgentReach[] = REACH.map((r) =>
  r.agent === 'gemini'
    ? { ...r, reach: 'partial' as Reach, text: "servers; single tools can't be turned off in a WSL project yet" }
    : r.agent === 'qwen'
    ? {
      ...r,
      reach: 'none' as Reach,
      text: "can't follow it in a WSL project yet: its settings file would have to be written in the distro",
    }
    : r
);

// ---- Claude Code ------------------------------------------------------------------------------------------------------------
export interface ClaudePatch {
  deniedMcpServers?: { serverName: string }[];
  permissions?: { deny: string[] };
}
export function claudePatch(e: Effective): ClaudePatch | null {
  const patch: ClaudePatch = {};
  if (e.off.length) patch.deniedMcpServers = e.off.map((serverName) => ({ serverName }));
  const deny = Object.entries(e.tools).flatMap(([server, tools]) => tools.map((t) => `mcp__${sanitized(server)}__${sanitized(t)}`));
  if (deny.length) patch.permissions = { deny };
  return patch.deniedMcpServers || patch.permissions ? patch : null;
}

/** The settings object a chat already has (AIB's subagent hooks) plus the tool server patch; arrays are joined, nothing is dropped. */
export function mergeClaudeSettings(base: Json | null | undefined, patch: ClaudePatch | null): Json | null {
  if (!patch) return base ? base : null;
  const out: Json = structuredClone(base ?? {});
  if (patch.deniedMcpServers) {
    const have = Array.isArray(out.deniedMcpServers) ? out.deniedMcpServers as unknown[] : [];
    out.deniedMcpServers = [...have, ...patch.deniedMcpServers];
  }
  if (patch.permissions) {
    const perms = out.permissions && typeof out.permissions === 'object' && !Array.isArray(out.permissions) ? out.permissions as Json : {};
    const deny = Array.isArray(perms.deny) ? perms.deny as unknown[] : [];
    out.permissions = { ...perms, deny: [...deny, ...patch.permissions.deny] };
  }
  return out;
}

// ---- Codex ------------------------------------------------------------------------------------------------------------------
export function codexEntries(e: Effective): Record<string, Json> | null {
  const out: Record<string, Json> = {};
  for (const id of e.off) out[id] = { enabled: false };
  for (const [id, tools] of Object.entries(e.tools)) out[id] = { disabled_tools: [...tools] };
  return Object.keys(out).length ? out : null;
}

/** CODEX_CONFIG text with the partial entries merged into its `mcp_servers` (an entry AIB itself put there stays as it is). */
export function withCodexToolServers(current: string, entries: Record<string, Json> | null | undefined): string {
  if (!entries) return current;
  let config: Json;
  try {
    const parsed = JSON.parse(current);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return current;
    config = parsed as Json;
  } catch {
    return current;
  }
  const existing = config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers)
    ? config.mcp_servers as Json
    : {};
  const merged: Json = { ...existing };
  for (const [id, entry] of Object.entries(entries)) {
    const had = merged[id] && typeof merged[id] === 'object' && !Array.isArray(merged[id]) ? merged[id] as Json : null;
    if (had && (had.command || had.url) && Object.hasOwn(had, 'omit_tools_from')) continue; // AIB's own entry: never switched off
    merged[id] = { ...(had ?? {}), ...entry };
  }
  return JSON.stringify({ ...config, mcp_servers: merged });
}

/** Codex `-c key=value` flags with the same entries (a CLI run outside AIB; the tests). */
export function codexFlags(entries: Record<string, Json> | null): string[] {
  if (!entries) return [];
  const flags: string[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    for (const [k, v] of Object.entries(entry)) flags.push('-c', `mcp_servers.${id}.${k}=${JSON.stringify(v)}`);
  }
  return flags;
}

// ---- Copilot ----------------------------------------------------------------------------------------------------------------
export function copilotArgs(e: Effective): string[] {
  const args: string[] = [];
  for (const id of e.off) args.push('--disable-mcp-server', id);
  for (const [server, tools] of Object.entries(e.tools)) for (const t of tools) args.push('--excluded-tools', `${server}-${t}`);
  return args;
}

// ---- Gemini CLI -------------------------------------------------------------------------------------------------------------
/**
 * `--allowed-mcp-server-names` is an allow list: every server that is not named does not start. So it is given only when something is
 * off, and it names every server found for the project that stays on, plus `keep` (AIB's own server).
 */
export function geminiArgs(e: Effective, found: FoundServer[], keep: string[]): string[] {
  if (!e.off.length) return [];
  const names = [...new Set([...found.filter((s) => !e.off.includes(s.id)).map((s) => s.id), ...keep])];
  return ['--allowed-mcp-server-names', ...names];
}
const tomlString = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
/** The admin policy rules that hide the single tools that are off (mcp_<server>_<tool>: deny). '' when none. */
export function geminiPolicyToml(e: Effective): string {
  const lines: string[] = [];
  for (const [server, tools] of Object.entries(e.tools)) {
    for (const t of tools) {
      lines.push(
        '[[rule]]',
        `toolName = ${tomlString(`mcp_${sanitized(server)}_${sanitized(t)}`)}`,
        'decision = "deny"',
        'priority = 998',
        'denyMessage = "This tool is off for this project in AIB (Settings, Tool servers)."',
        '',
      );
    }
  }
  return lines.length ? ['# AIB: tools switched off for this project. Written by AIB; not yours.', '', ...lines].join('\n') : '';
}

// ---- Qwen Code --------------------------------------------------------------------------------------------------------------
export function qwenFragment(e: Effective, found: FoundServer[]): Json | null {
  const out: Json = {};
  if (e.off.length) out.mcp = { excluded: [...e.off] };
  const entries: Json = {};
  for (const [server, tools] of Object.entries(e.tools)) {
    const own = found.find((s) => s.id === server)?.entries.qwen;
    // a partial entry replaces the user's (probed: the server then fails to start), so a server with tools off needs a full copy
    if (own) entries[server] = { ...own, excludeTools: [...tools] };
  }
  if (Object.keys(entries).length) out.mcpServers = entries;
  return Object.keys(out).length ? out : null;
}

/** AIB's Qwen system settings with the fragment merged in (excluded lists are joined; AIB's own keys stay). */
export function mergeQwenSettings(base: Json, fragment: Json | null): Json {
  if (!fragment) return base;
  const out: Json = { ...base };
  const mcp = fragment.mcp as Json | undefined;
  if (mcp) {
    const had = out.mcp && typeof out.mcp === 'object' && !Array.isArray(out.mcp) ? out.mcp as Json : {};
    const excluded = [...(Array.isArray(had.excluded) ? had.excluded as unknown[] : []), ...(mcp.excluded as unknown[])];
    out.mcp = { ...had, excluded: [...new Set(excluded)] };
  }
  if (fragment.mcpServers) out.mcpServers = { ...(out.mcpServers as Json | undefined ?? {}), ...(fragment.mcpServers as Json) };
  return out;
}

/** Which agent a provider id belongs to for this feature ('' = none). */
export function agentOf(base: string): AgentId | 'maki' | '' {
  if (
    base === 'claude' || base === 'codex' || base === 'gemini' || base === 'qwen' || base === 'copilot' || base === 'antigravity' ||
    base === 'maki'
  ) return base;
  return '';
}
