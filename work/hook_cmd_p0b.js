#!/usr/bin/env node
/**
 * P0b probe for "subagents work in their own worktree": a Claude Code `command` hook shaped like AIB's planned forwarder.
 * Reads the hook input JSON on stdin, appends one JSON line {via: "command", label, body, reply, exit, startedAt, at} to LOG.
 *
 *   node work/hook_cmd_p0b.js <LOG> <label> [options]
 *     --force-isolation     PreToolUse(Agent/Task): print hookSpecificOutput.updatedInput = {...tool_input, isolation: "worktree"}
 *     --worktree DIR        WorktreeCreate: `git worktree add -b aib-sub-<basename> DIR HEAD` (once), print DIR on stdout
 *     --deny TOOL=TEXT      PreToolUse for TOOL: print permissionDecision "deny" with TEXT as the reason (repeatable)
 *     --exit2 TEXT          exit 2 with TEXT on stderr (the forwarder's fail-closed answer); for PreToolUse only when the tool
 *                           is Agent/Task unless --exit2-any
 *     --exit2-any           with --exit2: block every event/tool this hook is attached to
 *     --sleep MS            wait MS before answering (P0b: what a command-hook timeout does)
 *
 * `startedAt` is this process's start (performance.timeOrigin), so the driver can measure the spawn cost per hook call.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const startedAt = Math.round(performance.timeOrigin);
const [LOG, label, ...rest] = process.argv.slice(2);
const opts = { force: false, worktree: null, deny: {}, exit2: null, exit2Any: false, sleep: 0 };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--force-isolation') opts.force = true;
  else if (a === '--worktree') opts.worktree = rest[++i];
  else if (a === '--deny') {
    const [tool, ...text] = rest[++i].split('=');
    opts.deny[tool] = text.join('=');
  } else if (a === '--exit2') opts.exit2 = rest[++i];
  else if (a === '--exit2-any') opts.exit2Any = true;
  else if (a === '--sleep') opts.sleep = Number(rest[++i]);
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => setTimeout(answer, opts.sleep));

function answer() {
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch { body = { unparsed: raw }; }
  const event = body.hook_event_name;
  const tool = body.tool_name;
  let out = '';
  let code = 0;
  let err = '';
  try {
    if (opts.exit2 && (opts.exit2Any || event !== 'PreToolUse' || tool === 'Agent' || tool === 'Task')) {
      code = 2;
      err = opts.exit2;
    } else if (event === 'PreToolUse' && opts.deny[tool] !== undefined) {
      out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: opts.deny[tool] } });
    } else if (event === 'PreToolUse' && opts.force && (tool === 'Agent' || tool === 'Task')) {
      out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...body.tool_input, isolation: 'worktree' } } });
    } else if (event === 'WorktreeCreate' && opts.worktree) {
      if (!fs.existsSync(opts.worktree)) {
        execFileSync('git', ['worktree', 'add', '-b', `aib-sub-${path.basename(opts.worktree)}`, opts.worktree, 'HEAD'],
          { cwd: body.cwd, stdio: 'ignore', windowsHide: true });
      }
      out = opts.worktree;
    }
  } catch (e) {
    code = 1;
    err = String(e && e.message || e);
  }
  fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), startedAt, via: 'command', label, body, reply: out, exit: code, stderr: err }) + '\n');
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exitCode = code;
}
