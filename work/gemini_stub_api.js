#!/usr/bin/env node
/**
 * A local stub of the Gemini API (generativelanguage v1beta) for tests that run the REAL Gemini CLI with no key and no network.
 * Gemini CLI reads GOOGLE_GEMINI_BASE_URL (auth type "gateway"); point it at http://127.0.0.1:<port>.
 *
 *   node work/gemini_stub_api.js --script FILE.json [--port N] [--log FILE] [--stdin]
 *
 * Answers POST .../models/<model>:streamGenerateContent (SSE) and :generateContent (JSON); :countTokens gets a small count.
 * The first stdout line is `STUB_PORT=<port>`. Stops on SIGTERM/SIGINT, and with --stdin when stdin closes.
 *
 * Script: {"rules": [{"when": "<substring>", "in": "last" | "any", "tools": ["<offered tool>", ...], "reply": {...}}, ...]}
 *   For each request the first unused rule (each matches once) whose `when` is in the request part named by `in` ("last" = the
 *   newest entry of `contents`, JSON-encoded, so a functionResponse counts; "any" = the whole body) AND whose `tools` are all
 *   offered by the request wins. reply = {"text": "..."} or {"call": {"name": "...", "args": {...}}}. No match: text "STUB-END".
 * Because a rule names the tools that must be on offer, the parent agent (offered invoke_agent) and a subagent (offered
 * complete_task) are told apart by what Gemini offers them, and side calls with no tools never use up a rule.
 * Every request is logged as one JSON line {path, model, tools, rule, last}.
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
const DUMP_TOOLS = opt('--dump-tools', null); // write the first request's tool declarations (names and schemas) to this file
const rules = SCRIPT ? (JSON.parse(fs.readFileSync(SCRIPT, 'utf8')).rules || []) : [];
const used = new Set();

function offered(body) {
  const names = [];
  for (const t of body.tools || []) for (const f of t.functionDeclarations || []) names.push(f.name);
  return names;
}

function pick(body, raw) {
  const tools = offered(body);
  const contents = body.contents || [];
  const last = JSON.stringify(contents[contents.length - 1] || {});
  for (let i = 0; i < rules.length; i++) {
    if (used.has(i)) continue;
    const r = rules[i];
    const hay = r.in === 'any' ? raw : last;
    if (r.when && !hay.includes(r.when)) continue;
    if ((r.tools || []).some((t) => !tools.includes(t))) continue;
    used.add(i);
    return { index: i, reply: r.reply };
  }
  return { index: null, reply: { text: 'STUB-END' } };
}

function candidate(reply) {
  const parts = reply.call ? [{ functionCall: { name: reply.call.name, args: reply.call.args || {} } }] : [{ text: reply.text || '' }];
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    modelVersion: 'stub',
  };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const url = req.url || '';
    const m = /models\/([^:/?]+):(\w+)/.exec(url);
    const model = m ? m[1] : null;
    const verb = m ? m[2] : null;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    if (verb === 'countTokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ totalTokens: 10 }));
      return;
    }
    if (verb !== 'streamGenerateContent' && verb !== 'generateContent') {
      if (LOG) fs.appendFileSync(LOG, JSON.stringify({ path: url, method: req.method, unknown: true }) + '\n');
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: 'stub: unknown path', status: 'NOT_FOUND' } }));
      return;
    }
    if (DUMP_TOOLS && offered(body).length && !fs.existsSync(DUMP_TOOLS)) fs.writeFileSync(DUMP_TOOLS, JSON.stringify(body.tools, null, 1));
    const { index, reply } = pick(body, raw);
    const contents = body.contents || [];
    if (LOG) {
      fs.appendFileSync(LOG, JSON.stringify({ path: url.split('?')[0], model, verb, tools: offered(body), rule: index,
        reply, last: JSON.stringify(contents[contents.length - 1] || {}).slice(-400) }) + '\n');
    }
    const payload = candidate(reply);
    if (verb === 'generateContent') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(`data: ${JSON.stringify(payload)}\r\n\r\n`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`STUB_PORT=${server.address().port}\n`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (args.includes('--stdin')) {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}
