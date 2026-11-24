// Fixtures for checking the ownership UI by hand. No model, no real transcripts, no real agents.
//
//   node work/ownership-fixture/fixture.mjs setup            # (re)create transcripts under work/ownership-fixture/data
//   node work/ownership-fixture/fixture.mjs append SESSION   # pretend another app is writing SESSION's transcript, until killed
//   node work/ownership-fixture/fixture.mjs announce SESSION # pretend another client announced SESSION, until killed
//
// Start Studio against it with (agent.mjs is the fake launcher for the Claude provider):
//   deno run -A app/server/main.ts --port 8799 --state-dir work/ownership-fixture/data/state \
//     --omp-sessions work/ownership-fixture/data/omp --claude-projects work/ownership-fixture/data/claude \
//     --owners-dir work/ownership-fixture/data/owners --node-command node --claude-launcher work/ownership-fixture/agent.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyDumps, sleep } from '../fakes/_py.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const WORKSPACE = path.join(DATA, 'workspace');
const PROJECT = path.join(DATA, 'claude', 'ownership-fixture-workspace');
const SESSIONS = {
  'idle-session': ['Idle conversation (written an hour ago)', 3600],
  'active-session': ['Another app is writing this one', 3600],
  'announced-session': ['Announced by another client', 3600],
  'quiet-session': ['No evidence either way', 900],
};

function rows(session, title) {
  const stamp = '2026-11-07T10:00:00.000Z';
  return [
    { type: 'user', sessionId: session, cwd: WORKSPACE, timestamp: stamp, message: { role: 'user', content: `Hello from ${title}` } },
    { type: 'assistant', sessionId: session, cwd: WORKSPACE, timestamp: stamp, message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: `Fixture reply for ${title}` }] } },
    { type: 'ai-title', sessionId: session, title },
  ];
}

function setup() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'omp'));
  for (const [session, [title, age]] of Object.entries(SESSIONS)) {
    const file = path.join(PROJECT, `${session}.jsonl`);
    fs.writeFileSync(file, rows(session, title).map((r) => pyDumps(r) + '\n').join(''), 'utf8');
    const t = Date.now() / 1000 - age;
    fs.utimesSync(file, t, t);
  }
  console.log('fixture ready under', DATA);
}

async function append(session) {
  const file = path.join(PROJECT, `${session}.jsonl`);
  console.log('appending to', file, 'as PID', process.pid);
  for (let n = 1; ; n++) {
    fs.appendFileSync(file, pyDumps({ type: 'assistant', sessionId: session, cwd: WORKSPACE, timestamp: '2026-11-07T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `working ${n}` }] } }) + '\n', 'utf8');
    await sleep(1000);
  }
}

/** Write the announcement file the way an owner registry does (agent-session-owner v1), refreshed every 5 seconds. */
async function announce(session) {
  const owners = path.join(DATA, 'owners');
  fs.mkdirSync(owners, { recursive: true });
  const prefix = crypto.createHash('sha256').update('claude\0' + session, 'utf8').digest('hex').slice(0, 32);
  const file = path.join(owners, `${prefix}--fixtureother.json`);
  const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const first = stamp();
  console.log('announcing', session, 'as PID', process.pid, 'host', os.hostname());
  for (;;) {
    const body = { format: 'agent-session-owner', version: 1, provider: 'claude', sessionId: session,
      client: { name: 'fixture-other-client', version: '0', instanceId: 'fixture-other' },
      pid: process.pid, pidStart: null, hostname: os.hostname(), cwd: WORKSPACE, state: 'working',
      announcedAt: first, heartbeatAt: stamp(), ttlSeconds: 30 };
    const temporary = file.replace(/\.json$/, `.${process.pid}.tmp`);
    fs.writeFileSync(temporary, pyDumps(body), 'utf8');
    fs.renameSync(temporary, file);
    await sleep(5000);
  }
}

const [command = '', arg] = process.argv.slice(2);
if (command === 'setup') setup();
else if (command === 'append' && arg && process.argv.length === 4) await append(arg);
else if (command === 'announce' && arg && process.argv.length === 4) await announce(arg);
else {
  process.stderr.write('usage: fixture.mjs setup | append SESSION | announce SESSION\n');
  process.exit(1);
}
