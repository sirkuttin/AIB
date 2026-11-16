#!/usr/bin/env node
/**
 * A local stub model API for tests that run the REAL Claude Code and Codex CLIs with no key and no network.
 *
 *   Claude Code  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>  (plus ANTHROPIC_API_KEY=stub)    POST /v1/messages (SSE or JSON)
 *   Codex        a model provider in <CODEX_HOME>/config.toml, base_url = "http://127.0.0.1:<port>/v1", wire_api = "responses"
 *                                                                                           POST /v1/responses (SSE)
 *
 * Every reply is one text message. It echoes the history it was sent so a resume can be checked: when any message in the
 * request says "the codeword is X", the reply is "STUB codeword=X"; otherwise "STUB no codeword". Nothing calls a tool.
 *
 * Start:  node work/stub_model_api.js [--port N] [--log FILE] [--stdin]
 * The first stdout line is `STUB_PORT=<port>` (port 0 = any free port). Stops on SIGTERM / SIGINT, and with --stdin also when stdin closes
 * (so a test that dies never leaves it running).
 * Every request is appended to --log as one JSON line ({method, path, codeword}) so a test can see which API was hit.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const PORT = Number(opt('--port', '0'));
const LOG = opt('--log', null);

/** The newest "the codeword is X" anywhere in the request (system, history, tool results). */
function codewordIn(text) {
  const all = [...text.matchAll(/the codeword is ([A-Za-z0-9_-]+)/gi)];
  return all.length ? all[all.length - 1][1] : null;
}

function replyText(raw) {
  const word = codewordIn(raw);
  return word ? `STUB codeword=${word}` : 'STUB no codeword';
}

function log(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch { /* a log is best effort */ }
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

let seq = 0;
const newId = (prefix) => `${prefix}_stub${Date.now().toString(36)}${(seq++).toString(36)}`;

// ---- Anthropic Messages API --------------------------------------------------------------------------------------------------
function anthropic(res, body, raw) {
  const text = replyText(raw);
  const model = body.model || 'stub-model';
  const id = newId('msg');
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, usage,
    }));
    return;
  }
  sse(res, [
    ['message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

// ---- OpenAI Responses API (Codex) -----------------------------------------------------------------------------------------------
function responses(res, body, raw) {
  const text = replyText(raw);
  const id = newId('resp');
  const itemId = newId('msg');
  const model = body.model || 'stub-model';
  const usage = {
    input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15,
  };
  const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model };
  const done = { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  sse(res, [
    ['response.created', { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } }],
    ['response.in_progress', { type: 'response.in_progress', response: { ...base, status: 'in_progress', output: [] } }],
    ['response.output_item.added', {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] },
    }],
    ['response.content_part.added', {
      type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text }],
    ['response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text }],
    ['response.content_part.done', {
      type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: done }],
    ['response.completed', { type: 'response.completed', response: { ...base, status: 'completed', output: [done], usage } }],
  ]);
}

// ---- OpenAI Chat Completions (other OpenAI-compatible clients) ----------------------------------------------------------------
function chat(res, body, raw) {
  const text = replyText(raw);
  const id = newId('chatcmpl');
  const model = body.model || 'stub-model';
  const created = Math.floor(Date.now() / 1000);
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: text }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  res.end('data: [DONE]\n\n');
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch { /* not JSON: treat as empty */ }
    const path = (req.url || '/').split('?')[0];
    log({ method: req.method, path, codeword: codewordIn(raw) });
    if (req.method === 'POST' && /\/messages\/count_tokens$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
    } else if (req.method === 'POST' && /\/messages$/.test(path)) {
      anthropic(res, body, raw);
    } else if (req.method === 'POST' && /\/responses$/.test(path)) {
      responses(res, body, raw);
    } else if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
      chat(res, body, raw);
    } else if (req.method === 'GET' && /\/models$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }], models: [] }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: `stub has no ${req.method} ${path}` } }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`STUB_PORT=${server.address().port}\n`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (args.includes('--stdin')) {
  process.stdin.on('end', stop);
  process.stdin.resume();
}
