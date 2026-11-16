#!/usr/bin/env node
/**
 * A Gemini CLI BeforeTool command hook for work/cx_gemini_subagent_probe.py. Gemini runs it with the hook input JSON on stdin.
 *
 *   node work/gemini_hook_probe.js <log.jsonl> <worktree>
 *
 * Logs {event, tool_name, tool_input, cwd} and rewrites write_file's relative file_path into <worktree> by answering
 * hookSpecificOutput.tool_input (the whole argument object: Gemini replaces the arguments with it).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [log, worktree] = process.argv.slice(2);
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { input = { unparsed: raw.slice(0, 500) }; }
  fs.appendFileSync(log, JSON.stringify({ at: Date.now(), event: input.hook_event_name, tool_name: input.tool_name,
    tool_input: input.tool_input, cwd: input.cwd, session_id: input.session_id }) + '\n');
  const ti = input.tool_input || {};
  if (input.tool_name !== 'write_file' || !ti.file_path || path.isAbsolute(ti.file_path)) return;
  const answer = { hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: { ...ti, file_path: path.join(worktree, ti.file_path) } } };
  fs.appendFileSync(log, JSON.stringify({ at: Date.now(), answered: answer }) + '\n');
  process.stdout.write(JSON.stringify(answer));
});
