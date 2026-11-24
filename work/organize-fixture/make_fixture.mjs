// Fake saved Claude transcripts for checking pin / archive / delete by hand. No model, no real transcripts.
//
//   node work/organize-fixture/make_fixture.mjs
//   deno run -A app/server/main.ts --port 8800 --state-dir work/organize-fixture/state \
//     --omp-sessions work/organize-fixture/omp --claude-projects work/organize-fixture/claude \
//     --no-owner-announcements --node-command node --claude-launcher work/combined-fixture/agent.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyDumps } from '../fakes/_py.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
for (const name of ['state', 'omp', 'claude', 'workspace']) {
  fs.rmSync(path.join(base, name), { recursive: true, force: true });
  fs.mkdirSync(path.join(base, name), { recursive: true });
}
const root = path.join(base, 'claude', 'encoded-project');
fs.mkdirSync(root);
const TITLES = ['Refactor the parser', 'Fix flaky login test', 'Plan the release notes', 'Investigate slow build', 'Draft migration guide',
  'Review pull request 41', 'Tune the cache', 'Explain the scheduler', 'Add dark mode', 'Triage open bugs',
  'Prototype search box', 'Audit dependencies', '<img src=x onerror=alert(1)> hostile title', 'Write onboarding doc',
  'Benchmark startup', 'Clean up the CSS'];
const now = Date.now() / 1000;
TITLES.forEach((title, index) => {
  const session = `organize-${String(index).padStart(2, '0')}`;
  const common = { sessionId: session, cwd: path.join(base, 'workspace'), timestamp: '2026-11-07T01:00:00Z' };
  const rows = [
    { ...common, type: 'user', message: { role: 'user', content: `Hello: ${title}` } },
    { ...common, type: 'assistant', message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: `Reply for ${title}` }] } },
    { ...common, type: 'ai-title', title },
  ];
  const file = path.join(root, `${session}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => pyDumps(r) + '\n').join(''), 'utf8');
  const stamp = now - 3600 * (index + 2);
  fs.utimesSync(file, stamp, stamp);
});
console.log('fixture ready under', base);
