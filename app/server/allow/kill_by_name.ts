/**
 * Kill by name is refused in every AIB chat, for every agent (owner 2026-11-24, "2a"). `taskkill /IM node.exe`, `Stop-Process -Name`,
 * `Get-Process x | Stop-Process`, `pkill`, `killall` and `wmic process where name=...` stop every process of that name: AIB itself, its
 * keeper and other chats' work with it. Killing by PID stays allowed.
 *
 * One rule, four places (the same text everywhere):
 *   - Claude: the keeper forwarder's `pre-shell` hook (keeper/hookkill.go) answers a PreToolUse deny, for the main agent and subagents;
 *   - Codex: `codex-pre-tool` (the same Go file), Gemini: `gemini-before-tool` for run_shell_command (hook 3);
 *   - the allow layer (acp/connection.ts, via this file): an agent without a hook (or a chat whose hooks are off) that asks permission to run
 *     such a command gets "reject" instead of a card.
 * keeper/hookkill.go carries the same patterns; work/deno/kill_by_name_test.ts runs both over one table of commands.
 *
 * Text inside quotes or a heredoc is data (a commit message that mentions taskkill): it is stripped before the patterns run. A shell
 * wrapper's own script (`bash -c "..."`, `powershell -Command "..."`) is the command, so it is read first.
 */

export const KILL_BY_NAME_REASON =
  "never kill by image name: it kills every session's copy, AIB's own processes included. Kill only PIDs you started: taskkill /PID <pid> /T /F (or Stop-Process -Id / kill <pid>).";

const RULES: RegExp[] = [
  /\btaskkill(\.exe)?\b[^|;&\n]*\s\/{1,2}im\b/i,
  /\b(stop-process|spps)\b[^|;\n]*\s-(name|processname)\b/i,
  /\b(get-process|gps)\b(?![^|]*\s-id\b)[^|]*\|\s*(stop-process|spps|kill)\b/i,
  /(^|[\s;&|(])(pkill|killall)\s/i,
  /\bwmic\b[^\n]*\bprocess\b[^\n]*\bname\s*=/i,
];

/** taskkill /FI "IMAGENAME eq node.exe" names the image inside quotes: read on the raw text, once taskkill itself is an unquoted word. */
const FILTER = /\btaskkill(\.exe)?(?:\s[^|;&\n]*)?\s\/{1,2}fi\s+["']?imagename\b/i;

/** A shell wrapper's script: `bash -c '...'`, `sh -lc "..."`, `powershell -Command "..."`, `pwsh -c '...'`. */
const WRAPPED =
  /\b(?:(?:ba|z|da)?sh\s+-[a-z]*c|(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-z]+\s+\S+\s+)*-(?:command|c))\s+(?:'((?:[^']|'')*)'|"((?:\\.|[^"\\])*)")/gi;

const stripped = (cmd: string) => cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, '').replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");

/** True when the command kills processes by name (rule text: KILL_BY_NAME_REASON). Never throws. */
export function killsByName(command: string, depth = 0): boolean {
  if (typeof command !== 'string' || !command || command.length > 20000) return false;
  const code = stripped(command);
  if (RULES.some((re) => re.test(code)) || (/\btaskkill\b/i.test(code) && FILTER.test(command))) return true;
  if (depth < 2) {
    for (const m of command.matchAll(WRAPPED)) {
      const inner = m[1] !== undefined ? m[1].replaceAll("''", "'") : (m[2] ?? '').replace(/\\(.)/g, '$1');
      if (killsByName(inner, depth + 1)) return true;
    }
  }
  return false;
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The shell commands a session/request_permission asks to run (any agent's shape: Claude rawInput.command, Codex command string or
 * argv, Antigravity CommandLine, Gemini's title), for the allow layer's refusal. [] for a request that is not a shell command.
 */
export function permissionCommands(params: unknown): string[] {
  const call = dict(params) && dict(params.toolCall) ? params.toolCall : null;
  if (!call) return [];
  const raw = dict(call.rawInput) ? call.rawInput : {};
  const meta = dict(call._meta) && dict(call._meta.claudeCode) ? call._meta.claudeCode : {};
  const tool = typeof meta.toolName === 'string' ? meta.toolName : '';
  if (call.kind !== 'execute' && tool !== 'Bash' && tool !== 'PowerShell') return [];
  const out: string[] = [];
  for (const v of [raw.command, raw.cmd, raw.CommandLine]) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out.push(v.join(' '));
  }
  if (call.kind === 'execute' && typeof call.title === 'string') out.push(call.title);
  return out;
}

/** True when a permission request asks to run a command that kills by name. */
export function permissionKillsByName(params: unknown): boolean {
  try {
    return permissionCommands(params).some((c) => killsByName(c));
  } catch {
    return false;
  }
}
