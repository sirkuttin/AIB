// Fake saved transcripts for several projects and both vendors, with messy first messages. No model, no real transcripts.
//
//   node work/sidebar-fixture/make_fixture.mjs
//   deno run -A app/server/main.ts --port 8802 --state-dir work/sidebar-fixture/data/state \
//     --omp-sessions work/sidebar-fixture/data/omp --claude-projects work/sidebar-fixture/data/claude \
//     --owners-dir work/sidebar-fixture/data/owners --no-owner-announcements \
//     --node-command node --claude-launcher work/combined-fixture/agent.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyDumps } from '../fakes/_py.mjs';

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
fs.rmSync(base, { recursive: true, force: true });
for (const name of ['state', 'omp', 'claude', 'owners']) fs.mkdirSync(path.join(base, name), { recursive: true });

const REMINDER = '<system-reminder>\nThe user started this session without choosing a project folder.\n</system-reminder>';
const CONTINUED = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.';
// [provider, session, cwd as the vendor recorded it, first user message(s), explicit title rows, age in minutes]
const SESSIONS = [
  ['claude', 'c-alpha-1', 'C:\\Repos\\Alpha', [REMINDER + '\nRefactor the parser module'], [], 5],
  ['claude', 'c-alpha-2', 'c:/repos/alpha/', ['<command-message>debug</command-message>\n<command-name>/debug</command-name>\n<command-args>login test is flaky</command-args>'], [], 70],
  ['claude', 'c-alpha-3', 'C:\\Repos\\Alpha\\', [CONTINUED, 'Plan the release notes'], [{ type: 'ai-title', aiTitle: 'Release notes plan' }], 300],
  ['omp', 'o-alpha-1', 'C:\\Repos\\Alpha', ['## **Investigate** slow build'], [], 20],
  ['claude', 'c-beta-1', 'C:\\Repos\\Beta', ['<local-command-caveat>Caveat: ran locally</local-command-caveat>', 'Add dark mode toggle'], [], 15],
  ['omp', 'o-beta-1', 'C:\\Repos\\Beta', ['Draft migration guide'], [{ type: 'title', title: 'Migration guide draft' }], 600],
  ['claude', 'c-alpha-d', 'D:\\Work\\Alpha', ['Audit dependencies for the other alpha'], [], 40],
  ['omp', 'o-gamma-1', '/home/dev/gamma', ['<img src=x onerror=alert(1)> hostile title'], [], 2000],
  ['claude', 'c-gamma-1', '/home/dev/gamma', ['Tune the cache'], [{ type: 'summary', summary: 'Cache tuning notes', leafUuid: 'x' }], 3000],
  ['claude', 'c-delta-1', 'C:\\Repos\\Delta', ['Write onboarding doc'], [], 90],
];
const now = Date.now() / 1000;
for (const [provider, session, cwd, prompts, extras, age] of SESSIONS) {
  const stamp = new Date((now - age * 60) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const rows = [];
  let folder;
  if (provider === 'omp') {
    rows.push({ type: 'session', id: session, cwd, timestamp: stamp });
    for (const p of prompts) rows.push({ type: 'message', timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: p }] } });
    rows.push({ type: 'message', timestamp: stamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    folder = path.join(base, 'omp', 'proj');
  } else {
    for (const p of prompts) rows.push({ type: 'user', sessionId: session, cwd, timestamp: stamp, message: { role: 'user', content: p } });
    rows.push({ type: 'assistant', sessionId: session, cwd, timestamp: stamp, message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Done.' }] } });
    folder = path.join(base, 'claude', 'encoded-project');
  }
  rows.push(...extras);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${session}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => pyDumps(r) + '\n').join(''), 'utf8');
  fs.utimesSync(file, now - age * 60, now - age * 60);
}
console.log('fixture ready under', base);
