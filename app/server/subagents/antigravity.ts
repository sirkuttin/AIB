/**
 * Subagent worktrees, Antigravity CLI part (`agy acp`). Owner rule: an agent's own subagent that edits files works in its own git
 * worktree. For Claude Code, Codex and Gemini AIB enforces that (hooks, a fence), and AIB lands the worktree. For Antigravity it can't:
 *
 *   - `agy acp` gives AIB no hook, no tool-call interception and no permission fence for its subagents. Its subagent tool runs the
 *     subagent in the chat's own folder unless the model asks for another workspace (workspace "share": its own working copy, or
 *     "branch": an isolated clone; beta_catalog.ts, checked against 1.5.11). AIB cannot require that over ACP, and nothing tells AIB
 *     where such a workspace is, so AIB cannot land it either.
 *
 * What AIB does (the same instruction channel the other agents' rule uses):
 *   - the rule below goes into the chat's ACP system prompt (acp/connection.ts artifactPrompt) when `agy` advertises the client
 *     system prompt capability, on session/new and session/load; when it does not, the rule goes in front of the chat's next prompt
 *     as a one-time <studio-context> line (host/aib.ts addPromptContext), once per opening of the chat;
 *   - the chat says so up front (a note): the rule is asked for, not enforced.
 *
 * Enforced: nothing. Asked for: subagents that change files use their own workspace, and the main agent brings their changes back.
 */

/** The rule the chat's agent is told (system prompt, or in front of its next prompt). */
export const ANTIGRAVITY_SUBAGENT_PROMPT =
  'Subagents that change files must not work in this folder directly. When you start a subagent that edits files, give it its own ' +
  'workspace: ask for workspace "branch" (an isolated clone) or "share" (its own working copy), never the default of this folder. ' +
  "AIB can't merge a subagent's workspace for you: when it is done, review its changes and bring them into this folder yourself, then " +
  'tell the user what you merged. Subagents that only read files can use the default.';

/** The chat line a new Antigravity chat gets: said up front, because AIB can ask for the rule but not enforce it. */
export const ANTIGRAVITY_SUBAGENT_NOTE =
  "Antigravity's subagents can't be forced into their own worktree: Antigravity gives AIB no way to hold them there, and AIB can't " +
  "merge their work. AIB tells the agent to give subagents that edit files their own workspace and to bring their changes back " +
  "itself; that is a request, not a guarantee. Check what a subagent changed in Changes.";

/** True for the Antigravity chats this rule applies to. */
export const isAntigravity = (provider: string): boolean => provider === 'antigravity';
