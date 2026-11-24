// Create transcripts and empty folders for the recovery browser check (fixture data only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyDumps } from '../fakes/_py.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
for (const name of ['state', 'omp', 'workspace', 'claude/encoded-project']) fs.mkdirSync(path.join(base, name), { recursive: true });
const root = path.join(base, 'claude', 'encoded-project');
const common = { sessionId: 'fixture-big', cwd: path.join(base, 'workspace'), timestamp: '2026-11-07T01:00:00Z' };
const rows = [{ ...common, type: 'user', message: { role: 'user', content: 'start' } }];
for (let i = 0; i < 400; i++) {
  const role = i % 2 ? 'assistant' : 'user';
  rows.push({ ...common, type: role, message: { role, content: `message number ${i}` } });
}
rows.push({ ...common, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'sleep 600', run_in_background: true, description: 'Long build' } }] } });
rows.push({ ...common, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'started' }] }, toolUseResult: { backgroundTaskId: 'job-looks-live' } });
const lines = (list) => list.map((r) => pyDumps(r) + '\n').join('');
fs.writeFileSync(path.join(root, 'fixture-big.jsonl'), lines(rows), 'utf8');
const subs = path.join(root, 'fixture-big', 'subagents');
fs.mkdirSync(subs, { recursive: true });
const subRows = Array.from({ length: 300 }, (_, i) => ({ ...common, type: 'assistant', agentId: 'abc1', message: { role: 'assistant', content: [{ type: 'text', text: `sub line ${i}` }] } }));
fs.writeFileSync(path.join(subs, 'agent-abc1.jsonl'), lines(subRows), 'utf8');
fs.writeFileSync(path.join(subs, 'agent-abc1.meta.json'), pyDumps({ description: 'Verify slice 06 importer', agentType: 'fork', finished: true }), 'utf8');
