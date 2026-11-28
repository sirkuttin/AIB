/**
 * Per-provider hooks of Aib.connect (host/aib_connect.ts): the one small interface every agent's connect-time rules sit behind, and the
 * table that picks the hook of an agent by its base agent. connect() runs the same short sequence for every agent and calls the hook of
 * the agent being opened at each step; a new per-agent rule is edited in that agent's own aib_setup_<agent>.ts, not in connect().
 *
 * The steps, in connect()'s order (every hook member is optional):
 *   1. prepare       before the connection exists: the agent's subagent setup (hooks, settings, env, launch flags). Null: nothing to add.
 *   2. startsLate    the agent starts only after the chat's MCP servers are known (a new chat in the project folder)
 *   3. attach        right after the connection is made: fields only this agent sets on it
 *   4. tools         after the chat's MCP servers are set, before a late start: the agent's own tool list; returns a chat line or ''
 *   5. beforeSetup   in the chat's setup, before the session opens
 *   6. offNote       in the chat's setup, after the session opened: the line saying subagents are off (first of the chat lines)
 *   7. afterSetup    after the session opened and the off-note: the agent's prompt rule and its own chat lines
 * A hook's members run with `this` = the Aib, so they may use its `$` members (the dollar guard allows `this.$x` only).
 */
import type { Connection } from '../acp/connection.ts';
import { baseAgent } from '../agents/claude_family.ts';
import type { Plan } from '../worktrees/worktrees.ts';
import type { GeminiSetup } from '../subagents/gemini.ts';
import type { Aib } from './aib.ts';
import { claudeConnectHook } from './aib_setup_claude.ts';
import { codexConnectHook } from './aib_setup_codex.ts';
import { geminiConnectHook } from './aib_setup_gemini.ts';
import { qwenConnectHook } from './aib_setup_qwen.ts';
import { agyConnectHook } from './aib_setup_agy.ts';
import { copilotConnectHook, makiConnectHook } from './aib_setup_copilot.ts';

/** What connect() knows when it calls a hook. `prepared` and `launchCommand` are filled as connect() goes. */
export interface ConnectCtx {
  provider: string;
  resume: string | null;
  /** The launch command before any hook changed it. */
  command: string[];
  /** The agent's environment so far (a hook may add to it). */
  env: Record<string, string>;
  /** Where the agent works: the chat's new worktree or the folder. */
  cwd: string;
  /** The project folder (a WSL chat: its ref). */
  workspace: string;
  /** The chat gets its own new worktree. */
  worktree: boolean;
  /** A WSL chat's spawn environment (null: a Windows chat). */
  spawnEnv: Record<string, string> | null;
  chatId: string | null;
  /** The WSL distro (null: a Windows chat). */
  distro: string | null;
  wsl: boolean;
  /** What prepare returned for this chat. */
  prepared: ConnectPrepared | null;
  /** The command the connection was made with (set before tools). */
  launchCommand: string[];
}

/** What a hook's prepare gives connect() to put in the connection's options (any part may be missing). */
export interface ConnectPrepared {
  id?: string;
  env?: Record<string, string>;
  /** Added to the end of the launch command. */
  args?: string[];
  /** Instead of the launch command (the flag that turns the agent's subagents off, in its place). */
  command?: string[];
  /** The chat's subagent hooks state (c.subagentHooks); the chat gets none when the factory gave it another id. */
  hooks?: NonNullable<Connection['subagentHooks']>;
  /** A chat line: its subagents are off. */
  note?: string;
  /** Gemini's fence setup (attach puts it on the connection). */
  gemini?: GeminiSetup;
}

export interface ConnectHook {
  /** The hook applies only to this exact provider id (not to an entry built on the same base agent, like `antigravity@server`). */
  exact?: string;
  prepare?(this: Aib, x: ConnectCtx): Promise<ConnectPrepared | null> | ConnectPrepared | null;
  startsLate?: boolean;
  attach?(this: Aib, x: ConnectCtx, c: Connection): void;
  tools?(this: Aib, x: ConnectCtx, c: Connection): Promise<string>;
  beforeSetup?(this: Aib, x: ConnectCtx, c: Connection): Promise<void>;
  /** The line for "subagents are off" this agent owns (null: none; connect() then tries the generic ones). */
  offNote?(this: Aib, x: ConnectCtx, c: Connection): string | null;
  /** True: prepare's `note` is said only in a new chat, not when a saved one is continued (Maki, Copilot). */
  noteInNewChatOnly?: boolean;
  afterSetup?(this: Aib, x: ConnectCtx, c: Connection): void;
}

/** Keyed by base agent (`claude@server` is `claude`). A new agent with connect-time rules adds one entry here and one hook in its own file. */
const CONNECT_HOOKS: Record<string, ConnectHook> = {
  claude: claudeConnectHook,
  codex: codexConnectHook,
  qwen: qwenConnectHook,
  antigravity: agyConnectHook,
  copilot: copilotConnectHook,
  maki: makiConnectHook,
  gemini: geminiConnectHook,
};

/** The connect hook of this provider id, or an empty one (an agent without connect-time rules). */
export function connectHookOf(provider: string): ConnectHook {
  const hook = Object.hasOwn(CONNECT_HOOKS, baseAgent(provider)) ? CONNECT_HOOKS[baseAgent(provider)] : null;
  return hook && (!hook.exact || hook.exact === provider) ? hook : NO_HOOK;
}
const NO_HOOK: ConnectHook = {};

export type { Plan };
