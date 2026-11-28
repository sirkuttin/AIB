#!/usr/bin/env node
/**
 * A minimal stdio MCP server for the tool-servers tests (work/deno/toolservers_*_test.ts): `node fake_mcp_server.js <name>`.
 * It writes <MARK_DIR>/<name>.<pid> when it starts (so a test can tell that the server was spawned at all) and offers two tools,
 * `<name>_one` and `<name>_two`. Stops when stdin closes.
 */
'use strict';
const fs = require('node:fs');
const name = process.argv[2] || 'x';
const dir = process.env.MARK_DIR;
if (dir) fs.writeFileSync(`${dir}/${name}.${process.pid}`, 'started');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'initialize') {
      result = { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '1' } };
    } else if (m.method === 'tools/list') {
      result = { tools: ['one', 'two'].map((t) => ({ name: `${name}_${t}`, description: `fake ${t}`, inputSchema: { type: 'object', properties: {} } })) };
    } else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'ok' }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
