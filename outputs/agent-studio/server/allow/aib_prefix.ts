/**
 * AIB's shell cookie prefix (no-stuck-processes, Slice 0; keeper/hookshell.go; architect review S0-M2, S0-M3).
 *
 * For a command a subagent runs, AIB's hook may put ONE prefix in front of it that sets AIB_PROC=<chat>.<owner>.<call id>, so a later step
 * can tell which subagent started a process:
 *
 *   bash        export AIB_PROC='<cookie>'; <command>
 *   pwsh        $env:AIB_PROC='<cookie>'; <command>
 *
 * That prefix is AIB's, not the agent's and not the owner's. Everything that matches or shows a command takes it off first, so a tagged
 * command is judged, saved ("Always allow"), shown and listed as the command the agent meant:
 *   - allow/matcher.ts readRequest and the strict readers (parseBash, parsePwsh) in allow/shell.ts;
 *   - the approval card, Activity rows, history and notifications: acp/connection.ts strips the message once, where it comes in;
 *   - the transcript view (transcripts/transcript.ts, normalize.ts).
 *
 * Only the exact prefix goes: one of the two forms above at the very start, the cookie of shape <chat>.<owner>.<call id>. Nothing else
 * is touched, and a command that merely contains the text later is left alone.
 */

/** <chat>.<owner>.<call id>: each part [A-Za-z0-9_-] (keeper/hookshell.go aibCookieShape). */
export const COOKIE_SHAPE = /^[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{1,200}$/;
const COOKIE = '[A-Za-z0-9_-]{1,100}\\.[A-Za-z0-9_-]{1,100}\\.[A-Za-z0-9_-]{1,200}';
const AT_START = new RegExp(`^(?:export AIB_PROC='(${COOKIE})'; |\\$env:AIB_PROC='(${COOKIE})'; )`);
const ANYWHERE = new RegExp(`(?:export AIB_PROC='(${COOKIE})'; |\\$env:AIB_PROC='(${COOKIE})'; )`, 'g');

export type TagShell = 'bash' | 'pwsh';

/** A PowerShell script that must begin with these (a prefix would be a parse error): keeper/hookshell.go pwshFirst. */
const PWSH_FIRST = /^(?:using[ \t]|#requires\b|param[ \t]*\(|\[cmdletbinding)/i;

/**
 * The cookie of one call: `<chat>.<owner>.<call id>`, or null when a part is not of the allowed shape (never put into a command).
 * `owner` is the subagent's id (Claude: agent_id; Codex: the thread's agent_id).
 */
export function cookieOf(chat: string, owner: string, callId: string): string | null {
  const cookie = `${chat}.${owner}.${callId}`;
  return [chat, owner, callId].every((p) => /^[A-Za-z0-9_-]+$/.test(p)) && COOKIE_SHAPE.test(cookie) ? cookie : null;
}

/** The exact prefix for a shell and cookie ('' for a cookie of the wrong shape). */
export function tagPrefix(shell: TagShell, cookie: string): string {
  if (!COOKIE_SHAPE.test(cookie)) return '';
  return shell === 'bash' ? `export AIB_PROC='${cookie}'; ` : `$env:AIB_PROC='${cookie}'; `;
}

/**
 * True when the prefix can stand in front of `command` for this shell without changing what it means. Same rule as the forwarder's
 * (keeper/hookshell.go checkTaggable), which refuses the rest again on its own.
 */
export function taggable(shell: TagShell, command: string): boolean {
  if (!command.trim()) return false;
  if (shell === 'bash') return true;
  let text = command;
  for (;;) { // comment-based help and # lines may precede param( and using
    text = text.replace(/^[ \t\r\n﻿]+/, '');
    if (text.startsWith('<#')) {
      const end = text.indexOf('#>');
      if (end < 0) return false;
      text = text.slice(end + 2);
    } else if (text.startsWith('#') && !/^#requires/i.test(text)) {
      const nl = text.indexOf('\n');
      if (nl < 0) return false;
      text = text.slice(nl + 1);
    } else break;
  }
  return !PWSH_FIRST.test(text);
}

/** The prefixed command, or null when the shell can't be proven to read it (never guessed: the call stays untagged). */
export function tagged(shell: TagShell, cookie: string, command: string): string | null {
  return taggable(shell, command) && COOKIE_SHAPE.test(cookie) ? tagPrefix(shell, cookie) + command : null;
}

/** `command` without AIB's exact prefix at its start (unchanged when it has none). `chat`: only that chat's cookie counts. */
export function stripAibPrefix(command: string, chat?: string): string {
  const m = AT_START.exec(command);
  if (!m) return command;
  const cookie = m[1] ?? m[2];
  return chat && !cookie.startsWith(`${chat}.`) ? command : command.slice(m[0].length);
}

/**
 * `text` with every exact prefix of this chat's cookies taken out, wherever it stands (a Codex PowerShell wrapper holds it inside its
 * quotes). For display only, never for matching: the matcher uses stripAibPrefix at the start of the command.
 */
export function stripAibPrefixes(text: string, chat?: string): string {
  if (!text.includes('AIB_PROC=')) return text;
  return text.replace(ANYWHERE, (all, bash: string | undefined, pwsh: string | undefined) => {
    const cookie = bash ?? pwsh ?? '';
    return chat && !cookie.startsWith(`${chat}.`) ? all : '';
  });
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strip every string in `value` in place (objects and arrays, a few levels deep). Returns whether anything changed. */
function stripDeep(holder: Json | unknown[], chat: string | undefined, depth: number): boolean {
  let changed = false;
  for (const key of Object.keys(holder)) {
    const value = (holder as Json)[key];
    if (typeof value === 'string') {
      const next = stripAibPrefixes(value, chat);
      if (next !== value) {
        (holder as Json)[key] = next;
        changed = true;
      }
    } else if (depth < 6 && (isObj(value) || Array.isArray(value))) changed = stripDeep(value, chat, depth + 1) || changed;
  }
  return changed;
}

/**
 * An agent message (one stdout line of the ACP stream, parsed) with AIB's prefix taken out of the tool call it carries: the
 * `session/update` tool_call and tool_call_update, and the `session/request_permission` card. Changes the message in place; the card's
 * options and ids are untouched, so the answer to it is the same. Returns whether anything changed.
 */
export function stripAibMessage(message: Json, chat: string | undefined): boolean {
  const params = message.params;
  if (!isObj(params)) return false;
  if (message.method === 'session/request_permission') return isObj(params.toolCall) ? stripDeep(params.toolCall, chat, 0) : false;
  if (message.method !== 'session/update') return false;
  const update = params.update;
  if (!isObj(update)) return false;
  const kind = update.sessionUpdate;
  return kind === 'tool_call' || kind === 'tool_call_update' ? stripDeep(update, chat, 0) : false;
}

/** A tool call's input (a transcript block's `input` or `arguments`) with its command shown without the prefix; a copy, never in place. */
export function stripAibInput(args: unknown): unknown {
  if (!isObj(args)) return args;
  let out: Json | null = null;
  for (const key of ['command', 'cmd']) {
    const v = args[key];
    if (typeof v === 'string') {
      const next = stripAibPrefix(v);
      if (next !== v) out = { ...(out ?? args), [key]: next };
    }
  }
  return out ?? args;
}
