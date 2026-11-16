#!/usr/bin/env node
/**
 * A Codex command hook for probes (work/cx_codex_subagent_probe.py). Codex runs it with the hook input JSON on stdin.
 *
 *   node work/codex_hook_probe.js <log.jsonl> [--worktree DIR] [--deny-subagent]
 *
 * Every call appends {event, tool_name, agent_id, agent_type, cwd, tool_cwd, tool_input} to <log.jsonl>.
 *   --worktree DIR    SubagentStart: answers additionalContext "work only in DIR".
 *                     PreToolUse from a subagent (input has agent_id): rewrites the call into DIR with updatedInput:
 *                     Bash (exec_command): the command gets a "Set-Location -LiteralPath DIR;" (PowerShell) or "cd DIR &&" prefix;
 *                     apply_patch: every relative "*** Add/Update/Delete File: <path>" becomes DIR/<path>.
 *   --deny-subagent   PreToolUse from a subagent: deny every Bash / apply_patch call (exit 0, permissionDecision "deny").
 * The parent agent's calls (no agent_id) are only logged.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const log = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const worktree = opt('--worktree');
const deny = args.includes('--deny-subagent');

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { input = { unparsed: raw.slice(0, 500) }; }
  const event = input.hook_event_name;
  fs.appendFileSync(log, JSON.stringify({
    at: Date.now(), event, tool_name: input.tool_name, agent_id: input.agent_id, agent_type: input.agent_type,
    session_id: input.session_id, cwd: input.cwd, tool_cwd: input.tool_cwd, tool_input: input.tool_input,
  }) + '\n');
  const sub = Boolean(input.agent_id);
  if (event === 'SubagentStart' && worktree) {
    out({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `AIB: work only in ${worktree}. Use it as your working directory.` } });
    return;
  }
  if (event !== 'PreToolUse' || !sub) return;
  const tool = input.tool_name;
  if (tool !== 'Bash' && tool !== 'apply_patch') return;
  if (deny) {
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'AIB: subagents may not edit here' } });
    return;
  }
  if (!worktree) return;
  const command = String((input.tool_input || {}).command || '');
  let rewritten = command;
  if (tool === 'Bash') {
    rewritten = process.platform === 'win32' ? `Set-Location -LiteralPath '${worktree}'; ${command}` : `cd '${worktree}' && ${command}`;
  } else {
    rewritten = command.replace(/^(\*\*\* (?:Add|Update|Delete) File: )(.+)$/gm,
      (m, head, p) => (path.isAbsolute(p.trim()) ? m : head + path.join(worktree, p.trim())));
  }
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: rewritten } } });
});

function out(obj) {
  fs.appendFileSync(log, JSON.stringify({ at: Date.now(), answered: obj }) + '\n');
  process.stdout.write(JSON.stringify(obj));
}
