#!/usr/bin/env node
/**
 * P0 probe: a Claude Code `command` hook. Reads the hook input JSON on stdin and appends {via: "command", label, body} to LOG.
 * For WorktreeCreate with a ROOT it makes `git worktree add -b user-sub-<name> ROOT/<name> HEAD` and prints the path on stdout
 * (the documented command-hook answer), so it can stand in for a user's own WorktreeCreate hook.
 *
 *   node work/hook_command.js <LOG> <label> [<ROOT>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [LOG, label, ROOT] = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch { body = { unparsed: raw }; }
  let out = '';
  if (body.hook_event_name === 'WorktreeCreate' && ROOT) {
    const name = String(body.name || 'sub').replace(/[^A-Za-z0-9._-]/g, '-');
    out = path.join(ROOT, name);
    execFileSync('git', ['worktree', 'add', '-b', `user-sub-${name}`, out, 'HEAD'], { cwd: body.cwd, stdio: 'ignore', windowsHide: true });
  }
  fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), via: 'command', label, body, reply: out }) + '\n');
  if (out) process.stdout.write(out);
});
