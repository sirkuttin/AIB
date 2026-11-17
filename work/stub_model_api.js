#!/usr/bin/env node
/**
 * A local stub model API for tests that run the REAL Claude Code and Codex CLIs with no key and no network.
 *
 *   Claude Code  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>  (plus ANTHROPIC_API_KEY=stub)    POST /v1/messages (SSE or JSON)
 *   Codex        a model provider in <CODEX_HOME>/config.toml, base_url = "http://127.0.0.1:<port>/v1", wire_api = "responses"
 *                                                                                           POST /v1/responses (SSE)
 *
 * Plain mode (the default): every reply is one text message. It echoes the history it was sent so a resume can be checked: when
 * any message in the request says "the codeword is X", the reply is "STUB codeword=X"; otherwise "STUB no codeword".
 * In any mode, "STUB_WAIT=<seconds>" in the newest message holds the reply that long (at most 60 s), for a turn that is still running.
 *
 * Script mode (--script FILE.json): the model can call tools. The file is
 *   {"rules": [{"when": "<substring>", "in": "last" | "any" | "system", "once": true,
 *               "reply": {"text": "...", "tools": [{"id": "toolu_x1", "name": "Agent", "input": {...}}]}}, ...]}
 * For each model request the first unused rule that matches wins; no match falls back to the plain reply.
 *   when   a substring that must appear in the request part named by `in` (no `when` = always matches)
 *   in     "last" (default): the newest message / input item that is not a system/developer one, JSON-encoded, so a
 *          tool_result's text (and its tool_use_id: give each scripted call an `id` and chain on it) counts; "any": the
 *          whole request body; "system": the system prompt / instructions only
 *   once   (default true) the rule is used up after it matches once
 *   capture  (optional) a regex run on the whole raw request; its first group replaces every "@CAP@" in the reply (e.g. an
 *          agentId from an earlier tool result, so a scripted SendMessage can address a subagent whose id is only known at run time)
 *   reply  text, tool calls, or both. A rule that calls tools only matches a request that OFFERS every one of those tools, so
 *          side requests the CLI makes without tools (titles, summaries) never use up a rule.
 * Tool calls go out as Anthropic `tool_use` blocks (stop_reason "tool_use") on /v1/messages and as Responses API
 * `function_call` items on /v1/responses (Codex). A Responses namespace tool's inner tool is named "<namespace>.<tool>" in a rule
 * (e.g. "multi_agent_v1.spawn_agent") and goes out with a `namespace` field. The parent agent and a subagent are told apart by their own markers: a
 * subagent's first request has its prompt as the newest message; the parent's next request has the subagent's result there.
 *
 * Start:  node work/stub_model_api.js [--port N] [--log FILE] [--stdin] [--script FILE] [--dump DIR]
 * The first stdout line is `STUB_PORT=<port>` (port 0 = any free port). Stops on SIGTERM / SIGINT, and with --stdin also when stdin closes
 * (so a test that dies never leaves it running).
 * Every request is appended to --log as one JSON line ({method, path, codeword, tools, rule, last}) so a test can see which API was
 * hit, which tools the CLI offered the model, and which script rule (its index) answered (null = the plain reply), and the end of the newest message.
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
const SCRIPT = opt('--script', null);
const DUMP = opt('--dump', null); // a folder: every request body is also written there as <n>.json
const rules = SCRIPT ? (JSON.parse(fs.readFileSync(SCRIPT, 'utf8')).rules || []) : [];
const used = new Set();

/** The newest "the codeword is X" anywhere in the request (system, history, tool results). */
function codewordIn(text) {
  const all = [...text.matchAll(/the codeword is ([A-Za-z0-9_-]+)/gi)];
  return all.length ? all[all.length - 1][1] : null;
}

function replyText(raw) {
  const word = codewordIn(raw);
  return word ? `STUB codeword=${word}` : 'STUB no codeword';
}

/** The names of the tools a request offers the model (Anthropic `tools[].name`; Responses `tools[].name` or `.function.name`). */
function toolNames(body) {
  const names = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (!t) continue;
    const name = t.name || (t.function && t.function.name) || t.type;
    if (name) names.push(name);
    // a Responses `namespace` tool (Codex's multi_agent_v1) offers its inner tools as "<namespace>.<tool>"
    if (t.type === 'namespace' && Array.isArray(t.tools)) for (const inner of t.tools) if (inner && inner.name) names.push(`${t.name}.${inner.name}`);
  }
  return names;
}

function part(body, raw, where) {
  if (where === 'any') return raw;
  if (where === 'system') {
    const sys = body.system !== undefined ? body.system : body.instructions;
    return typeof sys === 'string' ? sys : JSON.stringify(sys || '');
  }
  const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
  if (!list) return typeof body.input === 'string' ? body.input : '';
  // The newest turn item. Claude Code appends a trailing role "system" message (environment) after the user's turn: skip those.
  const turns = list.filter((m) => !m || (m.role !== 'system' && m.role !== 'developer'));
  return JSON.stringify(turns.length ? turns[turns.length - 1] : '');
}

/** The script rule that answers this request: {index, reply} or null (plain reply). */
function pick(body, raw) {
  const offered = new Set(toolNames(body));
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (used.has(i)) continue;
    const calls = (r.reply && r.reply.tools) || [];
    if (calls.some((c) => !offered.has(c.name))) continue;
    if (r.when !== undefined && !part(body, raw, r.in || 'last').includes(r.when)) continue;
    let reply = r.reply || {};
    if (r.capture) {
      const m = raw.match(new RegExp(r.capture));
      if (!m) continue; // the value to fill in is not there yet
      reply = JSON.parse(JSON.stringify(reply).split('@CAP@').join(m[1]));
    }
    if (r.once !== false) used.add(i);
    return { index: i, reply };
  }
  return null;
}

/** What to send: {rule, text, tools} from the matched rule, else the plain codeword reply. */
function answer(body, raw) {
  const hit = pick(body, raw);
  if (!hit) return { rule: null, text: replyText(raw), tools: [] };
  return { rule: hit.index, text: hit.reply.text || '', tools: hit.reply.tools || [] };
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
function anthropic(res, body, said) {
  const model = body.model || 'stub-model';
  const id = newId('msg');
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const blocks = [];
  if (said.text || !said.tools.length) blocks.push({ type: 'text', text: said.text });
  for (const call of said.tools) blocks.push({ type: 'tool_use', id: call.id || newId('toolu'), name: call.name, input: call.input || {} });
  const stop = said.tools.length ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
    return;
  }
  const events = [['message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  }]];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }]);
    } else {
      events.push(['content_block_start', {
        type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      }]);
      events.push(['content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  sse(res, events);
}

// ---- OpenAI Responses API (Codex) -----------------------------------------------------------------------------------------------
const responsesUsage = () => ({
  input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15,
});

function responses(res, body, said) {
  if (said.tools.length) return responsesCalls(res, body, said);
  const text = said.text;
  const id = newId('resp');
  const itemId = newId('msg');
  const model = body.model || 'stub-model';
  const usage = responsesUsage();
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

/** A Responses API turn that calls tools: an optional message item, then one `function_call` item per call. */
function responsesCalls(res, body, said) {
  const id = newId('resp');
  const model = body.model || 'stub-model';
  const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model };
  const events = [
    ['response.created', { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } }],
    ['response.in_progress', { type: 'response.in_progress', response: { ...base, status: 'in_progress', output: [] } }],
  ];
  const output = [];
  if (said.text) {
    const item = {
      type: 'message', id: newId('msg'), role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: said.text, annotations: [] }],
    };
    events.push(['response.output_item.added', {
      type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] },
    }]);
    events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }]);
    output.push(item);
  }
  for (const call of said.tools) {
    const argText = typeof call.input === 'string' ? call.input : JSON.stringify(call.input || {});
    const item = {
      type: 'function_call', id: newId('fc'), call_id: call.id || newId('call'), name: call.name, arguments: argText, status: 'completed',
    };
    // "<namespace>.<tool>" (a namespaced tool, see toolNames) goes out as {namespace, name}
    const dot = call.name.indexOf('.');
    if (dot > 0) Object.assign(item, { namespace: call.name.slice(0, dot), name: call.name.slice(dot + 1) });
    const index = output.length;
    events.push(['response.output_item.added', {
      type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' },
    }]);
    events.push(['response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: argText,
    }]);
    events.push(['response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: argText,
    }]);
    events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: index, item }]);
    output.push(item);
  }
  events.push(['response.completed', { type: 'response.completed', response: { ...base, status: 'completed', output, usage: responsesUsage() } }]);
  sse(res, events);
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
    if (DUMP) try { fs.writeFileSync(require('node:path').join(DUMP, `${String(seq++).padStart(3, '0')}.json`), raw); } catch { /* best effort */ }
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch { /* not JSON: treat as empty */ }
    const path = (req.url || '/').split('?')[0];
    const modelCall = req.method === 'POST' && (/\/messages$/.test(path) || /\/responses$/.test(path));
    const said = modelCall ? answer(body, raw) : null;
    const last = part(body, raw, 'last');
    log({ at: Date.now(), method: req.method, path, codeword: codewordIn(raw), tools: toolNames(body), rule: said ? said.rule : null, last: last.slice(-400) });
    // "STUB_WAIT=<seconds>" in the newest message holds a model reply that long (at most 60 s): a turn that is still running
    const wait = modelCall ? Math.min(60, Number((/STUB_WAIT=(\d+)/.exec(last) || [])[1] || 0)) : 0;
    setTimeout(() => reply(req, res, path, body, raw, said), wait * 1000);
  });
});

function reply(req, res, path, body, raw, said) {
  {
    if (req.method === 'POST' && /\/messages\/count_tokens$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
    } else if (req.method === 'POST' && /\/messages$/.test(path)) {
      anthropic(res, body, said);
    } else if (req.method === 'POST' && /\/responses$/.test(path)) {
      responses(res, body, said);
    } else if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
      chat(res, body, raw);
    } else if (req.method === 'GET' && /\/models$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }], models: [] }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: `stub has no ${req.method} ${path}` } }));
    }
  }
}

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
