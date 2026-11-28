/**
 * Reading tool calls: which studio_artifact tool a request is for, MCP call shapes, background-command phrases,
 * helper and shell tracking records. Moved out of connection.ts (no change).
 */
import { ALL_OWN_NAMES, canonicalTool, type ToolAction } from '../allow/own_tools.ts';
import { splitCopilotToolName } from '../agents/copilot_mcp.ts';
import { type ProcId } from '../platform/kill_verified.ts';
import { artifactToolCommand } from '../artifacts/mcp.ts';
import { isOwnForwardEntry, isOwnMcpUrl } from '../artifacts/mcp_http.ts';
import { isDict, isStr, pyStr, pyTruthy, pyTypeName } from '../core/py.ts';
import { type Json, get } from './conn_util.ts';

/** Match with `$` that also matches before one trailing newline. */
export const OWN_ARTIFACT_TOOL = /^(?:mcp__)?studio[-_]artifact__(?:publish|update|list|merge_into_project|resolve_edit_clash)\n?$/;
/** Swarm: AIB's helper tools (artifacts/mcp.ts SWARM_TOOLS); auto-approved like the artifact tools. */
export const SWARM_TOOL_NAMES = ['helper_providers', 'start_helper', 'helper_status', 'stop_helper', 'merge_helper', 'unlanded_work'];
/** Every studio_artifact tool name a request can carry, old and new (allow/own_tools.ts). Which of them need no card: isAutoApproved. */
export const OWN_TOOL_NAMES = ALL_OWN_NAMES;

/**
 * The studio_artifact tool a permission request is for, by the adapter's own shape, or ''. Claude Code names it in
 * _meta.claudeCode.toolName (mcp__studio_artifact__<tool>); other adapters put the MCP server and tool in rawInput ({server, tool}, as
 * codex-acp's McpInvocation) or a title "Tool: studio_artifact/<tool>" (codex-acp) / "<tool> (studio_artifact MCP Server)" (Gemini CLI).
 * An agent-written title alone counts only for an MCP-shaped call: a command (kind execute) titled like the tool is not AIB's tool
 * (review break 4).
 */
export function ownToolName(call: Json, mcp?: ToolSeen['mcp']): string {
  const meta = isDict(call._meta) ? call._meta : {};
  const claude = isDict(meta.claudeCode) ? meta.claudeCode : {};
  const fromClaude = isStr(claude.toolName) ? claude.toolName : isStr(call.name) ? call.name : '';
  const prefixed = (n: string) => {
    const m = /^(?:mcp__)?studio[-_]artifact__([a-z_]+)\n?$/.exec(n); // Maki names it studio-artifact__<tool> (hyphen)
    return m && OWN_TOOL_NAMES.has(m[1]) ? m[1] : '';
  };
  if (fromClaude) return prefixed(fromClaude);
  const raw = isDict(call.rawInput) ? call.rawInput : {};
  const invocation = isDict(raw.invocation) ? raw.invocation : raw;
  if ((invocation.server === 'studio_artifact' || invocation.server === 'studio-artifact') && isStr(invocation.tool) && OWN_TOOL_NAMES.has(invocation.tool)) return invocation.tool;
  // codex-acp 2.6.0, recorded from a real Codex run (work/test_tool_details.js CODEX_MCP_DOC_CREATE): kind 'execute', title
  // "mcp.studio_artifact.<tool>", `_meta.is_mcp_tool_call`. Only with that mark: a shell command titled alike never has it.
  if (meta.is_mcp_tool_call === true && isStr(call.title)) {
    const recorded = /^mcp\.studio[-_]artifact\.([a-z_]+)$/.exec(call.title.trim());
    if (recorded && OWN_TOOL_NAMES.has(recorded[1])) return recorded[1];
  }
  // codex-acp 2.6.0 permission request (recorded: work/deno/codex_acp_mcp_permission_shape.json): only {toolCallId, kind 'execute'} and
  // _meta.is_mcp_tool_approval (on the request, not the toolCall). The tool is the one on the tool_call with the same toolCallId (`mcp`).
  if (mcp && (mcp.server === 'studio_artifact' || mcp.server === 'studio-artifact')) {
    return OWN_TOOL_NAMES.has(mcp.tool) ? mcp.tool : '';
  }
  if (call.kind === 'execute' || call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') return '';
  const title = isStr(call.title) ? call.title.trim() : '';
  const codex = /^Tool: studio[-_]artifact\/([a-z_]+)$/.exec(title);
  if (codex && OWN_TOOL_NAMES.has(codex[1])) return codex[1];
  const gemini = /^([a-z_]+) \(studio[-_]artifact MCP Server\)$/.exec(title);
  if (gemini && OWN_TOOL_NAMES.has(gemini[1])) return gemini[1];
  // Maki 0.7.2 (recorded from the real adapter): kind 'other', title "studio-artifact.<tool>: <the arguments as JSON>", no name, no _meta
  const maki = /^studio[-_]artifact\.([a-z_]+)(?::|$)/.exec(title);
  if (maki && OWN_TOOL_NAMES.has(maki[1])) return maki[1];
  return prefixed(title);
}

/**
 * The tool + action of an AIB tool request (allow/own_tools.ts), or null. The action is the `action` field of the call's input, which AIB
 * reads from Claude's rawInput, from Codex's tool_call (`mcp`), and from Maki's rawInput. Gemini and unknown agents show none: action ''.
 */
export function ownToolAction(call: Json, mcp?: ToolSeen['mcp']): ToolAction | null {
  const name = ownToolName(call, mcp);
  if (!name) return null;
  const raw = isDict(call.rawInput) ? call.rawInput : {};
  const args = isDict(raw.arguments) ? raw.arguments : raw;
  const action = isStr(args.action) ? args.action : mcp?.action;
  return canonicalTool(name, action);
}

/** {server, tool, action} of a Codex MCP tool_call's rawInput ({server, tool, arguments}), or null. */
export function mcpOf(raw: unknown): ToolSeen['mcp'] {
  if (!isDict(raw) || !isStr(raw.server) || !isStr(raw.tool)) return null;
  const args = isDict(raw.arguments) ? raw.arguments : {};
  return { server: raw.server, tool: raw.tool, action: isStr(args.action) ? args.action.trim() : '' };
}

/**
 * The MCP server and tool a tool call names (not AIB's own server), from what each agent says: Claude Code's `mcp__<server>__<tool>`,
 * Codex's rawInput {server, tool}, Copilot's `<server>-<tool>` title, Gemini's "<tool> (<server> MCP Server)" title. The tool list of
 * Settings > Tool servers is built from these ("tool names a chat saw"). Null: not an MCP call.
 */
export function mcpToolOf(toolName: string, mcp: ToolSeen['mcp'], title: string): { server: string; tool: string } | null {
  const own = (server: string) => server === 'studio_artifact' || server === 'studio-artifact';
  const claude = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (claude) return own(claude[1]) ? null : { server: claude[1], tool: claude[2] };
  if (mcp && mcp.server && mcp.tool) return own(mcp.server) ? null : { server: mcp.server, tool: mcp.tool };
  const gemini = /^(\S+) \((.+) MCP Server\)$/.exec(title.trim());
  if (gemini) return own(gemini[2]) ? null : { server: gemini[2], tool: gemini[1] };
  return null;
}

/**
 * GitHub Copilot CLI (1.0.109, run against a stub model): its tool_call for an MCP tool is titled `<server>-<tool>`, kind other, and
 * rawInput is the arguments themselves; its permission request carries only the tool's own name as title. So AIB's tool is known from
 * the tool_call, the way Codex's is (ToolSeen.mcp). Only AIB's own server (agents/copilot_mcp.ts); any other tool: null.
 */
export function copilotMcpOf(update: Json): ToolSeen['mcp'] {
  const title = get(update, 'title');
  const named = isStr(title) ? splitCopilotToolName(title.trim()) : null;
  if (!named) return null;
  const raw = get(update, 'rawInput');
  const args = isDict(raw) ? raw : {};
  return { server: named.server, tool: named.tool, action: isStr(args.action) ? args.action.trim() : '' };
}

/**
 * Background-command phrases in a tool result (B6). Claude Code: its run_in_background, and the moves of a running command (a steer,
 * its timeout, Ctrl+B). The id is the task id. They are read from the result's start only (a command that printed this would have
 * to print it first).
 */
export const CLAUDE_BACKGROUND_TEXT = [
  /^Command running in background with ID: (\S+?)\.(?:\s|$)/,
  /^Command was moved to the background \(ID: ([^)\s]+)\)/,
  /^[^\n]*?timeout and was moved to the background \(ID: ([^)\s]+)\)/,
  /^[^\n]*?manually backgrounded by user with ID: ([^\s.]+)/,
];

/**
 * A tool result's background task id, from the agent's own signal: Claude Code's meta (toolResponse.backgroundTaskId, with
 * backgroundedToDeliverMessage for a steer) or its result text. Any other agent: none. (A Codex command that outlives its turn is
 * found at the turn's end instead.)
 */
/** The main agent's tools whose calls say a subagent started, continued or was stopped (subagent worktrees P2). */
export const CLAUDE_SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'SendMessage', 'TaskStop', 'KillShell']);

export function backgroundTask(update: Json, claude: boolean): string | null {
  if (!claude) return null;
  const meta = get(update, '_meta');
  const code = isDict(meta) ? get(meta, 'claudeCode') : null;
  const response = isDict(code) ? get(code, 'toolResponse') : null;
  const task = isDict(response) ? get(response, 'backgroundTaskId') : null;
  if (isStr(task) && task) return task;
  const raw = get(update, 'rawOutput');
  const text = (isStr(raw) ? raw : '').replace(/^\s+/, '');
  for (const pattern of CLAUDE_BACKGROUND_TEXT) {
    const m = pattern.exec(text);
    if (m) return m[1];
  }
  return null;
}

/** A tool update that says the tool is over (completed / failed) and does not say it keeps running in the background. */
export function toolEnded(update: Json, claude: boolean): boolean {
  const status = get(update, 'status');
  if (status !== 'completed' && status !== 'failed') return false;
  return backgroundTask(update, claude) === null;
}

/** A tool AIB has seen in this chat: whether it is a shell command, its last status, when it began, which prompt turn it was in. */
export interface ToolSeen {
  shell: boolean;
  /** An edit-style call (ACP kind edit / delete / move): Claude Write and Edit, Codex apply_patch, Gemini write_file and replace. */
  edit?: boolean;
  /** Claude Code's tool name (Bash, PowerShell, Edit, mcp__x__y), or null: allow rules pick the shell parser by it. */
  toolName?: string | null;
  status: string;
  since: number;
  main: boolean;
  turn: number;
  /** The call's title (a shell command's text), for the row of a message waiting for it. */
  title?: string;
  /** Claude Code: the Agent call this one runs under (_meta.claudeCode.parentToolUseId), or null for the main agent's own. */
  parent?: string | null;
  /** An MCP call (Codex: the tool_call's rawInput {server, tool, arguments}); its permission request names none of it. */
  mcp?: { server: string; tool: string; action: string } | null;
  /**
   * A subagent's call: the tool_call lives in the subagent's own session, but AIB's background notes go to the main session (the page
   * draws them as rows of their own there). This is what the call was, so such a row is titled by its command and not by `toolu_...`.
   */
  echo?: Json | null;
}

/** What a tool call was (title, kind, input, tool name), to repeat on a row that would otherwise carry only its id. */
export function toolEcho(update: Json): Json | null {
  const out: Json = {};
  for (const key of ['title', 'kind', 'rawInput', 'name']) {
    const value = get(update, key);
    if (value !== undefined && value !== null) out[key] = value;
  }
  const meta = get(update, '_meta');
  const code = isDict(meta) ? get(meta, 'claudeCode') : null;
  if (isDict(code)) {
    const keep: Json = {};
    for (const key of ['toolName', 'parentToolUseId']) if (get(code, key) !== undefined) keep[key] = get(code, key);
    out._meta = { claudeCode: keep };
  }
  return Object.keys(out).length ? out : null;
}

/** A tool call that moved to the background (any of the three signals): what the page shows and what Stop may kill. */
export interface BackgroundTool {
  /** The #bgShells key (Claude's task id, OMP's job id, or `open:<toolCallId>` for a Codex command that outlived its turn). */
  task: string;
  state: 'running' | 'done' | 'stopped';
  /** The processes that started with the command, by (pid, start time); null when they cannot be told apart from others. */
  procs: ProcId[] | null;
  stoppable: boolean;
  since: number;
  at: number;
  endedAt: number | null;
  /**
   * A Claude Code helper (its child session id) rather than a command: marked from the adapter's own "Async agent launched" reply,
   * done when its subagent_update leaves running. Never stoppable: it runs inside the agent's own process, so there is no process
   * of its own (pid and start time) AIB could verify and kill.
   */
  helper?: string;
}

/** The adapter's reply when a helper went on in the background (claude-agent-acp 0.97, recording C2: `<toolUseId>:reply`). */
export const HELPER_BACKGROUND_TEXT = /^\s*Async agent launched successfully/;

/** Stop on a background row was refused (HTTP 409): not stoppable, not running, or the processes cannot be verified. */
export class NotStoppable extends Error {
  override name = 'NotStoppable';
}

/** str(a) for each item of `e.get('args') or []` (a string iterates its characters). */
export function argStrings(args: unknown): string[] {
  if (!pyTruthy(args)) return [];
  if (Array.isArray(args)) return args.map((a) => pyStr(a));
  if (isStr(args)) return [...args];
  if (isDict(args)) return Object.keys(args);
  throw new TypeError(`'${pyTypeName(args)}' object is not iterable`);
}

/**
 * True for the `studio_artifact` entry AIB itself gave the chat: the Deno tool (artifacts/mcp.ts: this program with the
 * mcp-artifact subcommand) or the HTTP one this process serves (artifacts/mcp_http.ts). The Deno host builds every chat's entries
 * itself, so no other tool entry needs recognising.
 */
export function isOwnArtifactEntry(entry: unknown): boolean {
  if (!isDict(entry) || entry.name !== 'studio_artifact') return false;
  if (entry.type === 'http') return isOwnMcpUrl(entry.url);
  const args = argStrings(get(entry, 'args'));
  if (isOwnForwardEntry(entry.command, args)) return true; // the keeper's forwarder to this AIB's HTTP tool
  const own = artifactToolCommand();
  return entry.command === own.command && args.length === own.args.length && args.every((a, i) => a === own.args[i]);
}

/**
 * How a child the adapter announced has ended (subagent worktrees P3), from its tracked subagent_update state: null while it runs (or
 * was never said); else 'end_turn' (finished), 'cancelled', 'error', '' (idle with no reason: unexplained or a worker restart) or
 * 'unknown' (the adapter lost sight of it).
 */
export function subagentEnd(entry: Json | undefined): string | null {
  const state = entry && isStr(entry.state) ? entry.state.toLowerCase() : '';
  if (state === 'idle') return isStr(entry!.stopReason) ? entry!.stopReason : '';
  if (state === 'completed' || state === 'complete') return 'end_turn';
  if (state === 'failed' || state === 'error') return 'error';
  if (state === 'cancelled' || state === 'canceled') return 'cancelled';
  if (state === 'unknown') return 'unknown';
  return null;
}
