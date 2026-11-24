// Build a fake saved Claude transcript with several subagents under work/subagents-fixture/claude (no real data).
// The tests copy this file alone into a temp folder and run it there: no imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(HERE, 'claude', 'C--fixture', 'sess-fixture.jsonl');
const subs = path.join(main.replace(/\.jsonl$/, ''), 'subagents');
fs.mkdirSync(subs, { recursive: true });
const now = Date.now() / 1000;

const iso = (ago) => new Date((now - ago) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function write(file, rows, mtimeAgo) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.utimesSync(file, now - mtimeAgo, now - mtimeAgo);
}

function row(kind, text, ago, extra = {}) {
  const { msg = {}, ...rest } = extra;
  const message = { role: kind, content: kind === 'user' ? text : [{ type: 'text', text }], ...msg };
  return { type: kind, sessionId: 'sess-fixture', cwd: 'C:/fixture', timestamp: iso(ago), isSidechain: true, message, ...rest };
}

write(main, [{ type: 'user', sessionId: 'sess-fixture', cwd: 'C:/fixture', timestamp: iso(4000), message: { role: 'user', content: 'Fan out the W3 work' } }], 20);
const bash = { type: 'assistant', sessionId: 'sess-fixture', cwd: 'C:/fixture', timestamp: iso(200), isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'npm run dev', description: 'Dev server', run_in_background: true } }] } };
const bashResult = { type: 'user', sessionId: 'sess-fixture', cwd: 'C:/fixture', timestamp: iso(199), isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Command running in background with ID: job1' }] } };
write(path.join(subs, 'agent-a1.jsonl'), [row('user', 'Build the item engine', 300), bash, bashResult, row('assistant', 'Working on slot logic', 20, { msg: { model: 'claude-sonnet-5-5', usage: { input_tokens: 12, cache_creation_input_tokens: 2000, cache_read_input_tokens: 40000, output_tokens: 350 } } })], 20);
write(path.join(subs, 'agent-a7.jsonl'), [row('user', 'Check slot edge cases', 100), row('assistant', 'Reading the tests', 10)], 10);
fs.writeFileSync(path.join(subs, 'agent-a7.meta.json'), JSON.stringify({ description: 'Slot edge cases', agentType: 'Explore', parentAgentId: 'a1' }), 'utf8');
fs.writeFileSync(path.join(subs, 'agent-a1.meta.json'), JSON.stringify({ description: 'W3a item engine', agentType: 'general-purpose' }), 'utf8');
write(path.join(subs, 'agent-a2.jsonl'), [row('user', 'Write the 16:9 HUD', 900), row('assistant', 'HUD done and verified.', 400, { msg: { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 198000, output_tokens: 1200 } } })], 400);
fs.writeFileSync(path.join(subs, 'agent-a2.meta.json'), JSON.stringify({ description: 'W3c HUD 16:9', agentType: 'general-purpose', finished: true }), 'utf8');
write(path.join(subs, 'agent-a3.jsonl'), [row('user', 'Run the full build and report', 1500), row('assistant', 'API Error: 500 overloaded', 1200, { isApiErrorMessage: true })], 1200);
write(path.join(subs, 'agent-a4.jsonl'), [row('user', 'Audit the importer for dead code\nand list findings', 3000), row('assistant', 'Found three unused helpers.', 2800, { msg: { stop_reason: 'end_turn' } })], 2800);
write(path.join(subs, 'agent-a5.jsonl'), [row('assistant', 'no prompt recorded', 7000, { msg: { stop_reason: 'end_turn' } })], 7000);
write(path.join(subs, 'agent-a6.jsonl'), [row('user', 'Check the rotation tables', 9000), row('assistant', 'Tables match the spec.', 8800, { msg: { stop_reason: 'end_turn' } })], 8800);
console.log(main);
