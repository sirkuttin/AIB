#!/usr/bin/env node
/**
 * A Gemini CLI BeforeTool/AfterTool command hook for work/cx_gemini_subagent_probe.py. Gemini runs it with the hook input JSON
 * on stdin.
 *
 *   node work/gemini_hook_probe.js <log.jsonl> <worktree> <mode: log | redirect | deny> <state file>
 *
 * Logs every event in full (minus long tool responses). Tells a subagent's call from the parent's in two ways, both logged:
 *   - in flight: BeforeTool(invoke_agent) writes <state file>, AfterTool(invoke_agent) removes it; a call while it exists is a
 *     subagent's (the parent waits on invoke_agent);
 *   - its own fields (session_id, transcript_path), compared in the report.
 * redirect: a subagent's write_file / replace with a relative or main-folder path is rewritten into <worktree>
 *           (hookSpecificOutput.tool_input: Gemini merges it into the arguments, then re-validates them).
 * deny:     a subagent's write_file / replace / run_shell_command is blocked ({"decision": "deny", "reason": ...}).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [log, worktree, mode, state] = process.argv.slice(2);
const EDITS = new Set(['write_file', 'replace']);
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { input = { unparsed: raw.slice(0, 500) }; }
  const event = input.hook_event_name;
  const tool = input.tool_name;
  if (tool === 'invoke_agent' && event === 'BeforeTool') fs.writeFileSync(state, JSON.stringify(input.tool_input || {}));
  if (tool === 'invoke_agent' && event === 'AfterTool') { try { fs.unlinkSync(state); } catch { /* none */ } }
  const inSub = tool !== 'invoke_agent' && fs.existsSync(state);
  const entry = { at: Date.now(), event, tool_name: tool, tool_input: input.tool_input, in_subagent: inSub,
    session_id: input.session_id, transcript_path: input.transcript_path, cwd: input.cwd,
    keys: Object.keys(input).sort() };
  fs.appendFileSync(log, JSON.stringify(entry) + '\n');
  if (event !== 'BeforeTool' || !inSub) return;
  const ti = input.tool_input || {};
  let answer = null;
  if (mode === 'deny' && (EDITS.has(tool) || tool === 'run_shell_command')) {
    answer = { decision: 'deny', reason: `AIB: subagents edit in their own worktree (${worktree}), not the main folder` };
  } else if (mode === 'redirect' && EDITS.has(tool) && ti.file_path) {
    const main = input.cwd || process.cwd();
    const abs = path.resolve(main, ti.file_path);
    const rel = path.relative(main, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      // The whole argument object: a partial one fails Gemini's re-validation ("params must have required property 'content'").
      answer = { hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: { ...ti, file_path: path.join(worktree, rel) } } };
    }
  }
  if (answer) {
    fs.appendFileSync(log, JSON.stringify({ at: Date.now(), answered: answer }) + '\n');
    process.stdout.write(JSON.stringify(answer));
  }
});
