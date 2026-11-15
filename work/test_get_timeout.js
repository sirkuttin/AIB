'use strict';
/* A page GET waits longer than the server may hold it: /api/live/state for a chat being taken over from the keeper waits up to
   ADOPT_WAIT_MS (server/host/studio.ts) before it answers, so the page's GET timeout (chat.js GET_TIMEOUT_MS) must be longer, with
   room for a long chat's body. Before, the page gave up at 15 s and showed "Request timed out" for an answer that was coming. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'outputs', 'agent-studio');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the page GET timeout outlasts the server wait for a chat being taken over', () => {
  const page = /const GET_TIMEOUT_MS = (\d+);/.exec(read('chat.js'));
  const server = /export const ADOPT_WAIT_MS = ([\d_]+);/.exec(read('server/host/studio.ts'));
  assert.ok(page && server, 'both constants are declared');
  const pageMs = Number(page[1]),
    serverMs = Number(server[1].replace(/_/g, ''));
  assert.ok(pageMs >= serverMs + 5000, `page ${pageMs} ms vs server ${serverMs} ms`);
  assert.match(read('chat.js'), /open \? 15000 : GET_TIMEOUT_MS/, 'every GET but bootstrap uses it');
  assert.match(read('server/host/studio.ts'), /setTimeout\(resolve, ADOPT_WAIT_MS\)/, 'the take-over wait uses the constant');
});
