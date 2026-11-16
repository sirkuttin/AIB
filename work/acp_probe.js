#!/usr/bin/env node
/**
 * A minimal ACP client for tests that drive a REAL agent adapter (claude-agent-acp, codex-acp) headless, usually against
 * work/stub_model_api.js. One command per run; the result is one JSON line on stdout.
 *
 *   node work/acp_probe.js <entry.js> new  <cwd> <prompt>             -> {"sessionId", "reply"}
 *   node work/acp_probe.js <entry.js> list [<cwd>]                    -> {"supported", "sessions": [{sessionId, cwd, title}]}
 *   node work/acp_probe.js <entry.js> load <cwd> <sessionId> [<prompt>] -> {"loaded": true, "history": "...", "reply": "..." | null}
 *                                                                       (an empty or missing prompt only loads)
 *
 * <entry.js> is the adapter's script (run with this node). The environment is passed through unchanged: the caller sets the
 * temp CLAUDE_CONFIG_DIR / CODEX_HOME / HOME and the stub URL. Permission requests are refused. Exit 1 with {"error"} on failure.
 *
 * Options (before <entry.js>):
 *   --meta FILE     a JSON file sent as `_meta` on session/new and session/load (e.g. {"claudeCode": {"options": {"settings": ...}}})
 *   --allow         answer permission requests with the first allow option instead of refusing
 *   --events FILE   append every session/update and agent-to-client request as one JSON line, for tool_call / _meta checks
 *   --args JSON     a JSON array of extra arguments for the adapter process (e.g. ["-c", "features.multi_agent=false"])
 */
'use strict';
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const flags = { meta: null, allow: false, events: null, args: [] };
while (argv[0] && argv[0].startsWith('--')) {
  const name = argv.shift();
  if (name === '--allow') flags.allow = true;
  else if (name === '--meta') flags.meta = JSON.parse(require('node:fs').readFileSync(argv.shift(), 'utf8'));
  else if (name === '--events') flags.events = argv.shift();
  else if (name === '--args') flags.args = JSON.parse(argv.shift());
}
const [entry, op, ...rest] = argv;
const record = (line) => {
  if (flags.events) require('node:fs').appendFileSync(flags.events, JSON.stringify({ at: Date.now(), ...line }) + '\n');
};
if (!entry || !op) {
  process.stdout.write(JSON.stringify({ error: 'usage: acp_probe.js <entry.js> new|list|load ...' }) + '\n');
  process.exit(2);
}

const child = spawn(process.execPath, [entry, ...flags.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let stderr = '';
child.stderr.on('data', (c) => {
  stderr = (stderr + c.toString()).slice(-4000);
});

let nextId = 1;
const waiting = new Map();
let text = '';
let buf = '';

function send(msg) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

function request(method, params, seconds = 60) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out after ${seconds}s`)), seconds * 1000);
    waiting.set(id, { resolve, reject, timer, method });
  });
}

function onMessage(msg) {
  if (msg.id !== undefined && waiting.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    clearTimeout(w.timer);
    if (msg.error) w.reject(new Error(`${w.method}: ${JSON.stringify(msg.error)}`));
    else w.resolve(msg.result);
    return;
  }
  if (msg.method === 'session/update') {
    const u = msg.params && msg.params.update;
    record({ update: msg.params });
    if (u && (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'user_message_chunk') && u.content && u.content.type === 'text') {
      text += u.content.text;
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // An agent-to-client request: refuse permissions (or allow with --allow), answer anything else with an error.
    record({ request: msg.method, params: msg.params });
    const allowOpt = flags.allow && msg.params && (msg.params.options || []).find((o) => /^allow/.test(o.kind || ''));
    if (msg.method === 'session/request_permission' && allowOpt) {
      send({ id: msg.id, result: { outcome: { outcome: 'selected', optionId: allowOpt.optionId } } });
    } else if (msg.method === 'session/request_permission') send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
    else send({ id: msg.id, error: { code: -32601, message: `probe does not support ${msg.method}` } });
  }
}

child.stdout.on('data', (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch { /* not a JSON-RPC line */ }
  }
});

function finish(result, code = 0) {
  process.stdout.write(JSON.stringify(result) + '\n');
  try {
    child.kill();
  } catch { /* gone */ }
  process.exit(code);
}

async function prompt(sessionId, words) {
  text = '';
  const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: words }] }, 240);
  record({ promptResult: r });
  return text;
}

async function main() {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'aib-acp-probe', version: '1' },
  });
  const caps = (init && init.agentCapabilities) || {};
  if (op === 'new') {
    const [cwd, words] = rest;
    const s = await request('session/new', { cwd, mcpServers: [], ...(flags.meta ? { _meta: flags.meta } : {}) });
    const reply = await prompt(s.sessionId, words);
    finish({ sessionId: s.sessionId, reply });
  } else if (op === 'list') {
    const [cwd] = rest;
    if (!caps.sessionCapabilities || !caps.sessionCapabilities.list) finish({ supported: false, sessions: [] });
    const r = await request('session/list', cwd ? { cwd } : {});
    const sessions = (r.sessions || []).map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title || null }));
    finish({ supported: true, sessions });
  } else if (op === 'load') {
    const [cwd, sessionId, words] = rest;
    text = '';
    await request('session/load', { sessionId, cwd, mcpServers: [], ...(flags.meta ? { _meta: flags.meta } : {}) }, 120);
    const history = text;
    const reply = words ? await prompt(sessionId, words) : null;
    finish({ loaded: true, history, reply });
  } else {
    finish({ error: `unknown op ${op}` }, 2);
  }
}

main().catch((err) => finish({ error: String(err && err.message || err), stderr }, 1));
