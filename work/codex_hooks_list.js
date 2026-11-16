#!/usr/bin/env node
/**
 * Asks a REAL `codex app-server` which hooks it loaded and whether it trusts them (JSON-RPC `hooks/list`).
 *
 *   node work/codex_hooks_list.js <codex.exe> <cwd> [<extra app-server arg>...]   (e.g. -c 'hooks={...}')
 *
 * Prints one JSON line: the hooks/list result (each hook's key, source, currentHash, trustStatus) or {"error"}.
 * The caller sets CODEX_HOME / HOME etc. to temp folders. Headless; stops the app-server when done.
 */
'use strict';
const { spawn } = require('node:child_process');

const [exe, cwd, ...extra] = process.argv.slice(2);
const child = spawn(exe, ['app-server', ...extra], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '';
let stderr = '';
const waiting = new Map();
let nextId = 1;
const send = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
child.stderr.on('data', (d) => { stderr += d; });
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
const timer = setTimeout(() => finish({ error: 'timeout', stderr: stderr.slice(-1500) }), 30000);
function finish(obj) {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(obj) + '\n');
  child.kill();
  process.exit(obj.error ? 1 : 0);
}
(async () => {
  const init = await send('initialize', { clientInfo: { name: 'cx-probe', title: null, version: '0' } });
  if (init.error) return finish({ error: init.error, stderr: stderr.slice(-1500) });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const list = await send('hooks/list', { cwds: [cwd] });
  finish(list.error ? { error: list.error, stderr: stderr.slice(-1500) } : list.result);
})();
