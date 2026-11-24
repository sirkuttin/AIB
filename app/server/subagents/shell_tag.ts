/**
 * Tagging a subagent's shell calls (no-stuck-processes, Slice 0, build steps 3 and 4; keeper/hookshell.go; architect review S0-M1 to S0-M3).
 *
 * A subagent of a Claude Code or Codex chat runs its shell commands under the PARENT's agent process, so nothing but the command itself says
 * which subagent started what. AIB's hook puts one exact prefix in front of the command of a call made inside a subagent:
 *
 *   AIB_PROC=<chat>.<owner>.<call id>    chat: the chat's id; owner: the subagent's agent_id; call id: the call's tool_use_id
 *
 * (the shell form of the KNOWN shell: allow/aib_prefix.ts). Every process the command starts inherits it. AIB sets it fresh on every call, so a
 * value a process inherited from elsewhere is overwritten, never trusted.
 *
 * What is NOT here yet (steps 5 and 6): reading the cookie out of a process (the PEB on Windows, /proc elsewhere), scanning, and killing what
 * a finished subagent left running. That code asks `parseCookie` for the owner and call of a process's AIB_PROC and compares chat and owner
 * for equality against the record that finished. SubagentWorktrees.agentEnded / acpEnded (service.ts) are the finish events it will hang on.
 *
 * Rules, all in one place so the two agents answer alike:
 *   - only calls made inside a subagent are tagged (Claude: the hook payload's agent_id; Codex: the subagent thread's agent_id); the
 *     main agent's own calls stay untagged for now (the forwarder doesn't even ask AIB for them);
 *   - only a chat whose forwarder is `hook 2` (hooks.shellTag, set where the chat's hooks are made): an older forwarder refuses the answer;
 *   - only for the KNOWN shell: Claude's Bash tool is bash and its PowerShell tool is PowerShell; Codex on Windows is PowerShell, elsewhere
 *     bash. A command the shell would read differently with a prefix (a PowerShell script starting with using / #requires / param( ...)
 *     stays untagged, and so does a Codex command that is itself a shell wrapper (powershell / pwsh / cmd / bash -c ...);
 *   - never blocks, never denies: any doubt is `{}` (untagged).
 */
import { isDict } from '../core/py.ts';
import { COOKIE_SHAPE, cookieOf, tagged, type TagShell } from '../allow/aib_prefix.ts';
import type { HookAnswer, SubagentChat } from './service.ts';

const answer = (payload: unknown): HookAnswer => ({ status: 200, body: JSON.stringify(payload), type: 'application/json' });
const untagged = (): HookAnswer => answer({});

/** The call's id for the cookie: Claude's and Codex's tool_use_id, else a fresh one (a call id is only a nonce). */
function callIdOf(body: Record<string, unknown>): string {
  const id = typeof body.tool_use_id === 'string' ? body.tool_use_id : '';
  return /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : `n${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * When AIB tagged each call (epoch seconds, by chat and call id), newest 5000. A process that started BEFORE the call that supposedly
 * tagged it is not that call's (subagents/reap.ts). Kept in memory: after a restart a call is unknown and the reap falls back to the
 * subagent record's own start (a looser bound; the exact cookie, pid and start time checks still stand).
 */
const callTimes = new Map<string, number>();

export function noteCall(chat: string, call: string, at: number = Date.now() / 1000): void {
  callTimes.set(`${chat}.${call}`, at);
  while (callTimes.size > 5000) callTimes.delete(callTimes.keys().next().value!);
}

/** When AIB tagged this call, or undefined when it doesn't know. */
export function callTimeOf(chat: string, call: string): number | undefined {
  return callTimes.get(`${chat}.${call}`);
}

/** The shell a Claude Code tool runs its command in (never guessed: another tool gets none). */
export function claudeShellOf(tool: string): TagShell | null {
  return tool === 'Bash' ? 'bash' : tool === 'PowerShell' ? 'pwsh' : null;
}

/**
 * Claude Code: the answer to `pre-shell` (a PreToolUse of Bash or PowerShell). The call's own tool_input with ONLY the command changed;
 * `{}` (the call runs as it is) for a main-agent call, a chat without hook 2, another tool or a command that must stay untagged.
 */
export function preShell(chat: SubagentChat, body: Record<string, unknown>): HookAnswer {
  if (!chat.hooks?.shellTag) return untagged();
  const agentId = typeof body.agent_id === 'string' ? body.agent_id : '';
  if (!agentId) return untagged(); // the main agent's own call: untagged for now
  const shell = claudeShellOf(String(body.tool_name ?? ''));
  const input = isDict(body.tool_input) ? body.tool_input as Record<string, unknown> : null;
  if (!shell || !input || typeof input.command !== 'string') return untagged();
  const call = callIdOf(body);
  const cookie = cookieOf(chat.id, agentId, call);
  if (cookie) noteCall(chat.id, call);
  const command = cookie ? tagged(shell, cookie, input.command) : null;
  if (command === null) return untagged();
  return answer({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command } } });
}

/** True when a Codex command is itself a shell wrapper or a shell in a shell: the shell that runs it is not known, so it stays untagged. */
const CODEX_WRAPPER = /^\s*(?:"(?:[^"]*[\\/])?|(?:[^\s"]*[\\/])?)(powershell|pwsh|cmd|bash|sh|zsh)(\.exe)?"?(\s|$)/i;

/**
 * Codex: the cookie prefix for a subagent's Bash call, to stand in front of AIB's `cd '<worktree>'; ` (subagents/codex.ts). '' when the call
 * stays untagged. `os`: where Codex runs the command (Windows: PowerShell; elsewhere bash).
 */
export function codexTagPrefix(
  chat: SubagentChat,
  agentId: string,
  body: Record<string, unknown>,
  command: string,
  os: string = Deno.build.os,
): string {
  if (!chat.hooks?.shellTag || chat.wsl || !agentId || CODEX_WRAPPER.test(command)) return '';
  const call = callIdOf(body);
  const cookie = cookieOf(chat.id, agentId, call);
  if (cookie) noteCall(chat.id, call);
  const shell: TagShell = os === 'windows' ? 'pwsh' : 'bash';
  const full = cookie ? tagged(shell, cookie, command, os) : null;
  return full === null ? '' : full.slice(0, full.length - command.length);
}

export interface ShellCookie {
  chat: string;
  owner: string;
  call: string;
}

/**
 * The seam for steps 5 and 6: the fields of an AIB_PROC value read from a process's environment, or null when it is not exactly AIB's
 * shape. Compare `chat` and `owner` for EQUALITY (never a string prefix) before a process is considered the subagent's.
 */
export function parseCookie(value: string): ShellCookie | null {
  if (!COOKIE_SHAPE.test(value)) return null;
  const [chat, owner, call] = value.split('.');
  return { chat, owner, call };
}
