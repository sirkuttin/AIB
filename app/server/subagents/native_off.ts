/**
 * Subagents off, Maki and GitHub Copilot CLI (aib-shared/research/provider-builder-probe-2026-11-25.md, and the probes under
 * "Maki and Copilot" there; every fact below was run on Maki 0.7.2 and Copilot CLI 1.0.109 over ACP against a local stub model with a
 * temp home). Owner rule: an agent's own subagent that edits files works in its own git worktree, and AIB lands it. Neither CLI can
 * be held to that, so the strongest level they reach is the second one: their subagents are turned off, the chat says so, and the
 * agent is told to do that work itself.
 *
 * Why AIB-enforced isolation is not reachable:
 *   - Maki's `task` tool takes a prompt, a type (research = read-only, general = can edit), a model tier and a thinking level: no
 *     folder. A Lua slot (`tool.task.input`) can rewrite its input and block it, and slots run in ACP, but a subagent's own calls
 *     arrive under the PARENT's session id (parent and subagent `ctx.session_id` were the same string), so a hook cannot tell a
 *     subagent's write from the main agent's, and the slots live in the owner's own config folder (init.lua in %APPDATA%\maki or
 *     ~/.config/maki) or in the project's .maki/, which AIB does not write.
 *   - Copilot's `task` tool has no folder parameter either. `preToolUse` hooks DO fire in ACP, for the subagent's own calls too (they
 *     carry agentId / parentAgentId), but the subagent's tools always run in the session folder, so the only way to move one into a
 *     worktree is to rewrite every shell and edit call it makes. Its hooks also load only from the owner's ~/.copilot or the project.
 *
 * What does work, with nothing written to the owner's folders (a launch flag each, so no settings file and no sign-in move):
 *   Maki     `maki --disallowed-tools=task acp`: `task` is gone from the model's tool list (the flag is a root option: after `acp`
 *            Maki does not start). Its read-only `research` subagents go with it. `task_stop` and `task_message` stay (they need an id).
 *   Copilot  `copilot --acp --excluded-tools=task,run_dynamic_workflow,dynamic_workflows_manage`: those three are gone from the tool
 *            list, in agent, plan and autopilot mode (the dynamic workflow tools start agents too). The `=` form takes the
 *            comma list in one argument, so nothing after it can be swallowed (the space form is variadic).
 *
 * Limits (said in the report, not in the chat): a skill with a forked context and a shell command that starts another agent CLI are not
 * seen (the same class as every other agent's); a CLI that renames its tool makes the flag a no-op until the pin moves (both CLIs are
 * pinned in agents/beta_catalog.ts). When the launch command is not one AIB knows how to add the flag to, nothing is turned off: the chat
 * says so and the agent is asked, which is a request and not a guarantee.
 */
import { baseAgent } from '../agents/claude_family.ts';

export type NativeOffAgent = 'maki' | 'copilot';

/** The tools Copilot starts agents with (1.0.109): the task tool and the two dynamic workflow tools. */
export const COPILOT_AGENT_TOOLS = ['task', 'run_dynamic_workflow', 'dynamic_workflows_manage'] as const;
export const MAKI_FLAG = '--disallowed-tools=task';
export const COPILOT_FLAG = `--excluded-tools=${COPILOT_AGENT_TOOLS.join(',')}`;

/** `maki` and `copilot` (and an entry built on them, like `maki@server`); null for every other agent. */
export function nativeOffAgent(provider: string): NativeOffAgent | null {
  const base = baseAgent(provider);
  return base === 'maki' || base === 'copilot' ? base : null;
}

/**
 * The launch command with the flag that turns the agent's subagents off, or null when the command is not one the flag can be placed
 * in (Maki without its `acp` word, Copilot without `--acp`). Already there: unchanged. Never changes the input.
 */
export function nativeOffCommand(agent: NativeOffAgent, command: readonly string[]): string[] | null {
  if (agent === 'maki') {
    if (command.includes(MAKI_FLAG)) return [...command];
    const at = command.indexOf('acp', 1); // the program is first; the subcommand follows
    if (at < 1) return null;
    return [...command.slice(0, at), MAKI_FLAG, ...command.slice(at)]; // a root option: before the subcommand
  }
  if (command.includes(COPILOT_FLAG)) return [...command];
  if (command.some((a) => a.startsWith('--excluded-tools'))) return null; // someone else's list: not merged blindly
  const at = command.indexOf('--acp', 1);
  if (at < 1) return null;
  return [...command.slice(0, at + 1), COPILOT_FLAG, ...command.slice(at + 1)];
}

const NAMES: Record<NativeOffAgent, string> = { maki: 'Maki', copilot: 'Copilot' };
const TOOLS: Record<NativeOffAgent, string> = { maki: 'task', copilot: 'task' };

/** The reason Activity shows ("Not isolated: <reason>"). */
export const NATIVE_OFF_REASON = 'subagents are off in this chat';

/** The system prompt line (or the line in front of the next prompt) of a chat whose subagents are off. */
export const nativeOffPrompt = (agent: NativeOffAgent): string =>
  `In this chat, subagents are turned off (the ${TOOLS[agent]} tool is not available), because AIB can't give a ${
    NAMES[agent]
  } subagent its ` +
  'own git worktree. Do the work yourself, in this chat.' +
  (agent === 'copilot' ? ' ' + COPILOT_TOOLS_PROMPT : '');

/**
 * Copilot (agents/copilot_mcp.ts): AIB's tools reach it through its own MCP config file, and Copilot names each `<server>-<tool>`.
 * Its subagents stay off; parallel work goes to AIB helpers (Claude, Codex or Gemini), which AIB gives their own worktree.
 */
export const COPILOT_TOOLS_PROMPT = "AIB's own tools are available in this chat, named studio_artifact-<tool> (studio_artifact-publish, " +
  'studio_artifact-doc, studio_artifact-drawing, studio_artifact-artifacts, studio_artifact-helper, studio_artifact-merge_into_project); ' +
  'where this chat says the doc tool is mcp__studio_artifact__doc, use studio_artifact-doc. For work in parallel, start an AIB helper ' +
  'with the studio_artifact-helper tool if you have it (helpers are Claude, Codex or Gemini agents with their own worktree).';

/** The line in front of the next prompt of a chat AIB could not turn subagents off in: asked for, not enforced. */
export const nativeAskedPrompt = (agent: NativeOffAgent): string =>
  `Do not start ${NAMES[agent]} subagents that edit files: AIB can't give them their own git worktree in this chat, so they would change ` +
  'this folder directly. Do that work yourself, in this chat.';

/** The chat line of a new chat whose subagents are off. */
export const nativeOffNote = (agent: NativeOffAgent): string =>
  `${NAMES[agent]}'s subagents are off in this chat: ${NAMES[agent]} can't give a subagent its own git worktree, so AIB removed its ` +
  `${agent === 'copilot' ? 'task and workflow tools' : 'task tool'} and the agent does that work itself.` +
  (agent === 'copilot' ? " AIB's own tools are available, and the main agent can start AIB helpers (Claude, Codex or Gemini) for parallel work." : '');

/** The chat line when the flag could not be added: why, and what AIB does instead. */
export const nativeAskedNote = (agent: NativeOffAgent, why: string): string =>
  `${NAMES[agent]}'s subagents can't be turned off in this chat: ${why}. AIB asks the agent not to start subagents that edit files and ` +
  'to do that work itself; that is a request, not a guarantee. Check what a subagent changed in Changes.';

/** What the host records for a chat of this kind: the command to start the agent with, the hooks record and the chat line. */
export function nativeOffRecord(agent: NativeOffAgent, command: readonly string[]): {
  command: string[];
  off: string;
  detail: string;
  prompt: string;
  note: string;
  enforced: boolean;
} {
  const next = nativeOffCommand(agent, command);
  if (next) {
    return {
      command: next,
      off: NATIVE_OFF_REASON,
      detail: NATIVE_OFF_REASON,
      prompt: nativeOffPrompt(agent),
      note: nativeOffNote(agent),
      enforced: true,
    };
  }
  const why = 'AIB does not know how this copy of it was started';
  return {
    command: [...command],
    off: why,
    detail: why,
    prompt: nativeAskedPrompt(agent),
    note: nativeAskedNote(agent, why),
    enforced: false,
  };
}
