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
 */
'use strict';
const { spawn } = require('node:child_process');

const [entry, op, ...rest] = process.argv.slice(2);
if (!entry || !op) {
  process.stdout.write(JSON.stringify({ error: 'usage: acp_probe.js <entry.js> new|list|load ...' }) + '\n');
  process.exit(2);
}

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    if (u && (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'user_message_chunk') && u.content && u.content.type === 'text') {
      text += u.content.text;
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // An agent-to-client request: refuse permissions, answer anything else with an error.
    if (msg.method === 'session/request_permission') send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
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
  await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: words }] }, 120);
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
    const s = await request('session/new', { cwd, mcpServers: [] });
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
    await request('session/load', { sessionId, cwd, mcpServers: [] }, 120);
    const history = text;
    const reply = words ? await prompt(sessionId, words) : null;
    finish({ loaded: true, history, reply });
  } else {
    finish({ error: `unknown op ${op}` }, 2);
  }
}

main().catch((err) => finish({ error: String(err && err.message || err), stderr }, 1));
