#!/usr/bin/env node
/**
 * P0 probe for "subagents work in their own worktree": a tiny HTTP server that Claude Code's HTTP hooks POST to.
 * It records every hook call and can answer the two that matter:
 *
 *   POST /hooks/<label>   body = the hook input JSON; logged as one JSON line {label, at, body} to --log.
 *   Answers, by the hook input's hook_event_name:
 *     PreToolUse   with --force-isolation: hookSpecificOutput.updatedInput = {...tool_input, isolation: "worktree"} (Agent only)
 *     WorktreeCreate  with --worktree-root DIR: runs `git worktree add -b aib-sub-<name> DIR/<name> HEAD` in the hook's cwd and
 *                  answers hookSpecificOutput.worktreePath (the documented HTTP-hook shape). Without it: an empty 200.
 *     anything else: an empty 200 (no decision).
 *
 * A command-hook twin lives in hook_command.js (same log), so the two hook types can be compared.
 *
 *   --delay-worktree MS  wait MS before answering WorktreeCreate (to tell "last answer wins" from "tier wins")
 *   --fail-worktree      answer WorktreeCreate with HTTP 500 (what the parent sees when AIB cannot make the copy)
 *   --fail-pre           answer PreToolUse with HTTP 500 (P0b: does a 5xx block the tool or fail open?)
 *   --delay-pre MS       answer PreToolUse only after MS (P0b: what a hook timeout does)
 *   --plain-worktree     answer WorktreeCreate with the bare path as text (what a command hook must print; for the forwarder probe)
 *   --fixed-name NAME    WorktreeCreate makes DIR/NAME (a path known in advance, so a script can name files inside it)
 *
 * Start:  node work/hook_recorder.js --log FILE [--port N] [--force-isolation] [--worktree-root DIR] [--stdin]
 * The first stdout line is `HOOKS_PORT=<port>`. Stops on SIGTERM / SIGINT, and with --stdin when stdin closes.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const LOG = opt('--log', null);
const PORT = Number(opt('--port', '0'));
const FORCE = args.includes('--force-isolation');
const ROOT = opt('--worktree-root', null);
const DELAY = Number(opt('--delay-worktree', '0'));
const FAIL = args.includes('--fail-worktree');
const FAIL_PRE = args.includes('--fail-pre');
const DELAY_PRE = Number(opt('--delay-pre', '0'));
const FIXED = opt('--fixed-name', null);
const PLAIN_WT = args.includes('--plain-worktree');

function log(entry) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
}

function answer(input) {
  const event = input.hook_event_name;
  if (event === 'PreToolUse' && FORCE && input.tool_name === 'Agent') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, isolation: 'worktree' } } };
  }
  if (event === 'WorktreeCreate' && ROOT) {
    const name = FIXED || String(input.name || 'sub').replace(/[^A-Za-z0-9._-]/g, '-');
    const where = path.join(ROOT, name);
    execFileSync('git', ['worktree', 'add', '-b', `aib-sub-${name}`, where, 'HEAD'], { cwd: input.cwd, stdio: 'ignore', windowsHide: true });
    return { hookSpecificOutput: { hookEventName: 'WorktreeCreate', worktreePath: where } };
  }
  return {};
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch { body = { unparsed: raw }; }
    const label = (req.url || '/').split('?')[0].replace(/^\/hooks\//, '');
    if (body.hook_event_name === 'WorktreeCreate' && FAIL) {
      log({ via: 'http', label, body, reply: 'HTTP 500 (--fail-worktree)' });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'AIB could not make a copy of the project (test)' }));
      return;
    }
    if (body.hook_event_name === 'PreToolUse' && FAIL_PRE) {
      log({ via: 'http', label, body, reply: 'HTTP 500 (--fail-pre)' });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'AIB failed (test)' }));
      return;
    }
    if (body.hook_event_name === 'PreToolUse' && DELAY_PRE) {
      log({ via: 'http', label, body, reply: `delayed ${DELAY_PRE} ms (--delay-pre)` });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer(body)));
      }, DELAY_PRE);
      return;
    }
    if (body.hook_event_name === 'WorktreeCreate' && DELAY) {
      const until = Date.now() + DELAY;
      while (Date.now() < until) { /* a probe: block on purpose */ }
    }
    let reply = {};
    try {
      reply = answer(body);
    } catch (err) {
      log({ via: 'http', label, body, error: String(err && err.message || err) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }
    log({ via: 'http', label, body, reply });
    if (PLAIN_WT && body.hook_event_name === 'WorktreeCreate' && reply.hookSpecificOutput) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(reply.hookSpecificOutput.worktreePath);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});

server.listen(PORT, '127.0.0.1', () => process.stdout.write(`HOOKS_PORT=${server.address().port}\n`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (args.includes('--stdin')) {
  process.stdin.on('end', stop);
  process.stdin.resume();
}
