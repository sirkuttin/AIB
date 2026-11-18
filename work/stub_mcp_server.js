#!/usr/bin/env node
/**
 * A tiny stdio MCP server for tests: it names itself "studio_artifact" and offers three tools (publish, doc_create, doc_read) that
 * answer "ok". A test hands it to a real agent as a session/new mcpServers entry to see whether the agent offers its tools to the model.
 */
'use strict';
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: m.id,
      result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'studio_artifact', version: '1' } },
    });
  } else if (m.method === 'tools/list') {
    const tools = ['publish', 'doc_create', 'doc_read'].map((name) => ({ name, description: `stub ${name}`, inputSchema: { type: 'object', properties: {} } }));
    send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  } else if (m.id !== undefined && m.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
