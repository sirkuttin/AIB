#!/usr/bin/env node
// Raw ACP recorder for AIB's "send while the agent works" (steer) build, step 0.
//
// Spawns a real ACP adapter over stdio (hidden, no window), initializes like AIB does, opens a session in a throwaway project
// folder and runs one scenario, logging every JSON-RPC line both ways (with timestamps) to <out>.jsonl. Nothing here is AIB code.
//
// ISOLATION: every run gets a fresh temp root with its own HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_* and CLAUDE_CONFIG_DIR /
// CODEX_HOME / PI_CODING_AGENT_DIR inside it. Only the credential file is copied in. The temp root is deleted at the end.
//
// usage: node record.mjs <scenario> <out.jsonl>
//   scenarios: C1 C2 C3 C4 (Claude), X1 X2 X3 X4 (Codex), O1 O2 (OMP)
//   summarize.py <file.jsonl> prints a compact timeline of a recording.
//   Recordings are scrubbed of the credential, e-mail and Windows user name; "*-earlier-run-*" files are first tries kept for
//   comparison (shorter listen windows).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [scenario, outFile] = process.argv.slice(2);
if (!scenario || !outFile) {
  console.error('usage: node record.mjs <scenario> <out.jsonl>');
  process.exit(2);
}

const REAL_HOME = os.homedir();
const CLAUDE_ADAPTER = process.env.STEER_CLAUDE_ADAPTER ??
  path.join(process.env.APPDATA ?? '', 'fnm', 'node-versions', 'v26.13.0', 'installation', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
const CODEX_ADAPTER = process.env.STEER_CODEX_ADAPTER ??
  path.join(process.env.LOCALAPPDATA ?? '', 'AgentStudio', 'agents', 'codex', '2.6.0', 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
const OMP = process.env.STEER_OMP ?? path.join(process.env.LOCALAPPDATA ?? '', 'omp', 'omp.exe');

// ---------- isolated environment ----------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-steer-rec-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
for (const d of [home, project, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, 'README.txt'), 'throwaway project for a steer recording\n');

const env = { ...process.env };
// Drop anything that could point the agent at the owner's real config or an AIB/Claude session.
for (const k of Object.keys(env)) {
  if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|CODEX|OPENAI|OMP|PI_|AGENT_STUDIO|AIB)/i.test(k) && k !== 'CLAUDE_CODE_GIT_BASH_PATH') delete env[k];
}
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  TEMP: path.join(root, 'tmp'),
  TMP: path.join(root, 'tmp'),
});
fs.mkdirSync(env.TEMP, { recursive: true });

const agent = scenario[0];
let command;
const secrets = [];
function copySecret(from, to, pick = null) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (pick) {
    const all = JSON.parse(fs.readFileSync(from, 'utf8'));
    fs.writeFileSync(to, JSON.stringify(Object.fromEntries(pick.filter((k) => k in all).map((k) => [k, all[k]]))));
  } else fs.copyFileSync(from, to);
  // Remember every string value of the credential so it can be scrubbed from the recording.
  const walk = (v) => {
    if (typeof v === 'string' && v.length >= 12) secrets.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(fs.readFileSync(from, 'utf8'))); } catch { /* not JSON */ }
}

if (agent === 'C') {
  const cfg = path.join(root, 'claude-config');
  env.CLAUDE_CONFIG_DIR = cfg;
  copySecret(path.join(REAL_HOME, '.claude', '.credentials.json'), path.join(cfg, '.credentials.json'), ['claudeAiOauth']);
  // Cheap model; no hooks, no plugins, nothing else from the owner's settings.
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: 'haiku' }, null, 2));
  command = [process.execPath, CLAUDE_ADAPTER];
} else if (agent === 'X') {
  const cfg = path.join(root, 'codex-home');
  env.CODEX_HOME = cfg;
  copySecret(path.join(REAL_HOME, '.codex', 'auth.json'), path.join(cfg, 'auth.json'));
  command = [process.execPath, CODEX_ADAPTER];
} else if (agent === 'O') {
  const cfg = path.join(home, '.omp', 'agent');
  fs.mkdirSync(cfg, { recursive: true });
  env.PI_CODING_AGENT_DIR = cfg;
  // OMP's own Anthropic sign-in lives in its agent.db next to history; instead hand it only an access token through the
  // documented ANTHROPIC_OAUTH_TOKEN variable (the Claude Code token, no refresh token, so nothing can rotate).
  const cred = JSON.parse(fs.readFileSync(path.join(REAL_HOME, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth;
  env.ANTHROPIC_OAUTH_TOKEN = cred.accessToken;
  secrets.push(cred.accessToken);
  const shell = 'C:/Program Files/Git/bin/bash.exe';
  fs.writeFileSync(path.join(cfg, 'config.yml'), `shellPath: ${shell}\nsetupVersion: 2\n` + (scenario === 'O1' ? 'tools:\n  approvalMode: yolo\n' : ''));
  command = [OMP, 'acp'];
} else {
  console.error('unknown scenario', scenario);
  process.exit(2);
}

// ---------- recording ----------
const t0 = Date.now();
const out = fs.createWriteStream(outFile);
function scrub(s) {
  for (const x of secrets) s = s.split(x).join('<redacted>');
  // No personal details in the committed recordings: the account e-mail and the Windows user name.
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>');
  const user = path.basename(REAL_HOME);
  s = s.split(root.replace(/\\/g, '\\\\')).join('<TMP>').split(root).join('<TMP>').split(root.replace(/\\/g, '/')).join('<TMP>');
  if (user.length >= 3) s = s.split(user).join('<user>');
  return s;
}
function record(dir, payload) {
  const line = JSON.stringify({ t: Date.now() - t0, at: new Date().toISOString(), dir, ...payload });
  out.write(scrub(line) + '\n');
}
function note(text, extra = {}) {
  record('note', { note: text, ...extra });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`);
}

const child = spawn(command[0], command.slice(1), { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
note(`spawned ${path.basename(command[0])} ${command.slice(1).map((a) => path.basename(a)).join(' ')} pid ${child.pid}`, { scenario });

let nextId = 1;
const pending = new Map();
const listeners = new Set();
const history = [];
let exited = false;
child.on('exit', (code, sig) => { exited = true; note(`agent exited code=${code} signal=${sig}`); });

readline.createInterface({ input: child.stderr }).on('line', (line) => record('stderr', { line }));
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { record('in-raw', { line }); return; }
  record('in', { msg });
  history.push({ t: Date.now() - t0, msg });
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  } else if (msg.method !== undefined && msg.id !== undefined) {
    onRequest(msg);
  }
  for (const l of [...listeners]) l(msg);
});

function send(msg) {
  record('out', { msg });
  child.stdin.write(JSON.stringify(msg) + '\n');
}
function request(method, params, timeoutMs = 120000) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); note(`TIMEOUT waiting for ${method} #${id}`); resolve({ timeout: true }); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
  });
}
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { listeners.delete(l); note(`wait timed out: ${label}`); resolve(null); }, timeoutMs);
    const l = (m) => { if (pred(m)) { clearTimeout(timer); listeners.delete(l); resolve(m); } };
    listeners.add(l);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const upd = (m) => (m.method === 'session/update' ? m.params?.update : null);

// Client-side requests. Permissions: 'allow' answers at once with the first allow option; 'hold' parks them for the scenario.
let permissionPolicy = 'allow';
const heldPermissions = [];
function allowOption(params) {
  const opts = params?.options ?? [];
  return (opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => String(o.kind).startsWith('allow')) ?? opts[0])?.optionId;
}
function onRequest(msg) {
  if (msg.method === 'session/request_permission') {
    if (permissionPolicy === 'hold') { heldPermissions.push(msg); note('permission request held open'); return; }
    respond(msg.id, { outcome: { outcome: 'selected', optionId: allowOption(msg.params) } });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
}

let sessionId;
let initResult;
async function setup() {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'agent-studio', title: 'AIB', version: 'steer-recorder' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, subagents: {}, elicitation: { form: {}, url: {} } },
  }, 60000);
  initResult = init.result;
  note(`initialize: protocolVersion=${init.result?.protocolVersion} steering=${JSON.stringify(init.result?._meta?.steering ?? init.result?.agentCapabilities?._meta?.steering)}`);
  const s = await request('session/new', { cwd: project, mcpServers: [] }, 120000);
  if (!s.result) { note('session/new failed', { error: s.error }); throw new Error('session/new failed'); }
  sessionId = s.result.sessionId;
  note(`session ${sessionId}; modes=${JSON.stringify(s.result.modes?.availableModes?.map((m) => m.id))}`);
  return s.result;
}
async function setMode(modeId) {
  const r = await request('session/set_mode', { sessionId, modeId }, 30000);
  note(`set_mode ${modeId}: ${r.error ? JSON.stringify(r.error) : 'ok'}`);
}
async function setConfig(configId, value) {
  const r = await request('session/set_config_option', { sessionId, configId, value }, 30000);
  note(`set_config_option ${configId}=${value}: ${r.error ? JSON.stringify(r.error) : 'ok'}`);
}
function prompt(text, timeoutMs = 240000) {
  return request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs).then((r) => {
    note(`session/prompt settled: ${JSON.stringify(r.result ?? r.error ?? r)}`);
    return r;
  });
}
async function steer(text, meta = { steering: { idleBehavior: 'promptRequired' } }) {
  note(`steering: ${text}`);
  const r = await request('_session/steering', { sessionId, prompt: [{ type: 'text', text }], ...(meta ? { _meta: meta } : {}) }, 60000);
  note(`steer answered: ${JSON.stringify(r.result ?? r.error ?? r)}`);
  return r;
}
/** Waits until no session/update has arrived for quietMs (or maxMs passed). */
async function quiet(quietMs, maxMs) {
  const start = Date.now();
  let last = Date.now();
  const l = (m) => { if (m.method === 'session/update') last = Date.now(); };
  listeners.add(l);
  while (Date.now() - start < maxMs && Date.now() - last < quietMs && !exited) await sleep(250);
  listeners.delete(l);
}
const isToolCall = (m, re) => upd(m)?.sessionUpdate === 'tool_call' &&
  re.test(JSON.stringify([upd(m)?._meta?.claudeCode?.toolName, upd(m)?.title, upd(m)?.kind, upd(m)?.rawInput])) ;

// Claude: picks the cheapest model through the session's model config option when one is there.
function pickCheapModel(sess, want) {
  const opt = (sess.configOptions ?? []).find((o) => o.category === 'model' || o.id === 'model');
  const values = (opt?.options ?? []).flatMap((o) => (o.options ? o.options : [o])).map((o) => o.value);
  note(`model option ${opt?.id} current=${opt?.currentValue} values=${JSON.stringify(values)}`);
  const v = values.find((x) => want.test(String(x)));
  return opt && v ? [opt.id, v] : null;
}

// ---------- scenarios ----------
const LONG_CMD = 'for i in $(seq 1 60); do echo tick $i; sleep 1; done; echo finished';
const scenarios = {
  async C1() {
    const sess = await setup();
    const m = pickCheapModel(sess, /haiku/i);
    if (m) await setConfig(...m);
    await setMode('bypassPermissions');
    const p = prompt(`Run exactly this Bash command in the FOREGROUND (do not set run_in_background) and then tell me the last line it printed:\n\n${LONG_CMD}`);
    const call = await waitFor((x) => isToolCall(x, /Bash/), 90000, 'Bash tool_call');
    if (!call) return;
    await sleep(6000);
    await steer('Quick side question while that runs: what is 2+2? Answer with just the number.');
    await Promise.race([p, sleep(240000)]);
    note('prompt settled; listening for the background command to end and any task-notification cycle (up to 120 s)');
    await waitFor((x) => upd(x)?.sessionUpdate === 'usage_update' && upd(x)?._meta?.['_claude/origin'] && upd(x)._meta['_claude/origin']?.kind !== 'human', 120000, 'non-human usage_update');
    await quiet(8000, 30000);
  },
  async C2() {
    const sess = await setup();
    const m = pickCheapModel(sess, /haiku/i);
    if (m) await setConfig(...m);
    await setMode('bypassPermissions');
    const p = prompt(`Use the Agent tool (subagent_type general-purpose, run_in_background false: wait for it) with this task: "Run this exact Bash command in the FOREGROUND (do not set run_in_background, do not use Monitor) and reply with the last line it printed: ${LONG_CMD}". Then tell me what the helper replied.`);
    // With clientCapabilities.subagents the adapter announces the helper as subagent_update, not as an Agent tool_call.
    const call = await waitFor((x) => upd(x)?.sessionUpdate === 'subagent_update' || isToolCall(x, /"(Agent|Task)"/), 90000, 'helper start');
    if (!call) return;
    // Wait until the helper's own Bash started, so the steer lands while the helper works.
    await waitFor((x) => isToolCall(x, /Bash/), 60000, 'helper Bash tool_call');
    await waitFor((x) => upd(x)?.sessionUpdate === 'tool_call_update' && upd(x)?.title?.includes('seq 1 60'), 20000, 'helper Bash running');
    await sleep(5000);
    await steer('Quick side question while the helper works: what is 3+3? Answer with just the number.');
    await Promise.race([p, sleep(240000)]);
    note('prompt settled; listening for the helper to end and any task-notification cycle (up to 120 s)');
    await waitFor((x) => upd(x)?.sessionUpdate === 'usage_update' && upd(x)?._meta?.['_claude/origin'] && upd(x)._meta['_claude/origin']?.kind !== 'human', 120000, 'non-human usage_update');
    await quiet(8000, 30000);
  },
  async C3() {
    const sess = await setup();
    const m = pickCheapModel(sess, /haiku/i);
    if (m) await setConfig(...m);
    await prompt('Say hi in one word.');
    await steer('And now say bye in one word.'); // just after the turn ended, with idleBehavior promptRequired
    await quiet(5000, 15000);
    note('control: steer with no _meta (the adapter default for idle)');
    await steer('Say ok in one word.', null);
    await quiet(8000, 60000);
  },
  async C4() {
    const sess = await setup();
    const m = pickCheapModel(sess, /haiku/i);
    if (m) await setConfig(...m);
    await setMode('default');
    permissionPolicy = 'hold';
    const p = prompt('Run exactly this Bash command: echo hello > note.txt   Then say done.');
    const perm = await waitFor((x) => x.method === 'session/request_permission', 90000, 'permission request');
    if (!perm) return;
    await sleep(2000);
    const steerP = steer('Also, what is 5+5? Answer with just the number.');
    // Does the steer answer while the card is open? Does the card get cancelled? Watch for 15 s.
    await Promise.race([steerP, sleep(15000)]);
    await sleep(8000);
    note(`answering the held permission now (allow); held=${heldPermissions.length}`);
    permissionPolicy = 'allow';
    for (const h of heldPermissions.splice(0)) respond(h.id, { outcome: { outcome: 'selected', optionId: allowOption(h.params) } });
    await Promise.race([p, sleep(120000)]);
    await steerP;
    await quiet(6000, 30000);
  },
  async X1() {
    const sess = await setup();
    const m = pickCheapModel(sess, /5.6-luna/i);
    if (m) await setConfig(...m);
    const modes = sess.modes?.availableModes?.map((x) => x.id) ?? [];
    const full = modes.find((x) => /full|never|bypass/i.test(x));
    if (full) await setMode(full);
    const p = prompt(`Run exactly this shell command and then tell me the last line it printed: powershell -NoProfile -Command "1..40 | % { Write-Output tick$_; Start-Sleep 1 }; Write-Output finished"`);
    const call = await waitFor((x) => upd(x)?.sessionUpdate === 'tool_call', 120000, 'tool_call');
    if (!call) return;
    await sleep(6000);
    await steer('Quick side question while that runs: what is 2+2? Answer with just the number.');
    await Promise.race([p, sleep(240000)]);
    note('prompt settled; listening up to 90 s for the command to end (its tool_call completed) and anything after it');
    await waitFor((x) => upd(x)?.sessionUpdate === 'tool_call_update' && upd(x)?.toolCallId === call.params.update.toolCallId && upd(x)?.status, 90000, 'command tool_call status change');
    await quiet(8000, 30000);
  },
  async X2() {
    const sess = await setup();
    const m = pickCheapModel(sess, /5.6-luna/i);
    if (m) await setConfig(...m);
    const p = prompt('Write a numbered list of 40 different fruits, one per line, no other text.');
    // Steer as soon as the final message starts streaming.
    const chunk = await waitFor((x) => upd(x)?.sessionUpdate === 'agent_message_chunk', 120000, 'first message chunk');
    if (!chunk) return;
    await sleep(300);
    await steer('Also add the word BANANAS-STEERED on its own line at the end.');
    await Promise.race([p, sleep(180000)]);
    await quiet(10000, 40000);
  },
  async X3() {
    // The drop window: the final message is done but the turn has not completed yet. Steer on the first usage_update that
    // follows a message chunk (Codex sends usage_update just before the thread goes idle).
    const sess = await setup();
    const m = pickCheapModel(sess, /5\.6-luna/i);
    if (m) await setConfig(...m);
    let sawChunk = false;
    const p = prompt('Say hi in one word.');
    const hit = await waitFor((x) => {
      if (upd(x)?.sessionUpdate === 'agent_message_chunk') sawChunk = true;
      return sawChunk && upd(x)?.sessionUpdate === 'usage_update';
    }, 120000, 'usage_update after the message');
    if (!hit) return;
    const st = steer('Now also say bye in one word.');
    await Promise.race([p, sleep(120000)]);
    await st;
    await quiet(10000, 40000);
  },
  async X4() {
    // Same as X3 but steer on the first chunk of a one-word reply: the model has finished generating, the turn has not.
    const sess = await setup();
    const m = pickCheapModel(sess, /5\.6-luna/i);
    if (m) await setConfig(...m);
    const p = prompt('Say hi in one word.');
    const hit = await waitFor((x) => upd(x)?.sessionUpdate === 'agent_message_chunk', 120000, 'first message chunk');
    if (!hit) return;
    const st = steer('Now also say bye in one word.');
    await Promise.race([p, sleep(120000)]);
    await st;
    await quiet(10000, 40000);
  },
  async O1() {
    const sess = await setup();
    const p = prompt(`Run exactly this shell command with your bash tool and then tell me the last line it printed: ${LONG_CMD}`);
    const call = await waitFor((x) => upd(x)?.sessionUpdate === 'tool_call', 120000, 'tool_call');
    if (!call) return;
    await sleep(6000);
    await steer('Quick side question while that runs: what is 2+2? Answer with just the number.');
    await Promise.race([p, sleep(240000)]);
    note('prompt settled; listening up to 75 s for the backgrounded job to finish and its follow-up');
    await waitFor((x) => upd(x)?.sessionUpdate === 'agent_message_chunk', 75000, 'follow-up message after the job ended');
    note('next prompt: does the job output reach the model at the next turn?');
    await prompt('Did the background job bg_1 finish? Reply with only the last line it printed, or "unknown".', 120000);
    await quiet(8000, 30000);
  },
  async O2() {
    const sess = await setup();
    permissionPolicy = 'hold';
    const p = prompt('Run exactly this shell command: echo hello > note.txt   Then say done.');
    const perm = await waitFor((x) => x.method === 'session/request_permission', 90000, 'permission request');
    if (!perm) return;
    await sleep(2000);
    const steerP = steer('Also, what is 5+5? Answer with just the number.');
    await Promise.race([steerP, sleep(15000)]);
    await sleep(8000);
    note(`answering the held permission now (allow); held=${heldPermissions.length}`);
    permissionPolicy = 'allow';
    for (const h of heldPermissions.splice(0)) respond(h.id, { outcome: { outcome: 'selected', optionId: allowOption(h.params) } });
    await Promise.race([p, sleep(120000)]);
    await quiet(6000, 30000);
  },
};

// ---------- run with a hard overall limit ----------
const HARD_LIMIT = Number(process.env.STEER_HARD_LIMIT_MS ?? 480000);
const hard = setTimeout(() => { note('HARD LIMIT reached'); finish(3); }, HARD_LIMIT);
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(hard);
  note('done; killing the agent tree we started');
  try { if (!exited && child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
  setTimeout(() => {
    out.end(() => {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']); }
      }
      console.log(fs.existsSync(root) ? `WARNING temp root left: ${root}` : 'temp root removed');
      process.exit(code);
    });
  }, 1500);
}
scenarios[scenario]().then(() => finish(0), (e) => { note(`error: ${e?.stack ?? e}`); finish(1); });
