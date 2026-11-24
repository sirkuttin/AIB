// A fake Claude / Codex adapter for the sign-in tests. It never touches the network and never uses a real login.
//
// `fake_signin_agent.mjs --cli auth status --json`  prints the contents of FAKE_SIGNIN_STATUS_FILE (exit 1 when it says loggedIn false, like the real one).
// `fake_signin_agent.mjs --cli auth login ...`      FAKE_SIGNIN_LOGIN: ok (flips the status file to signed in, exit 0), fail (exit 3), nochange (exit 0, still signed out),
//                                                   hang (starts a grandchild, writes its pid to FAKE_SIGNIN_CHILD, then waits for ever).
// `fake_signin_agent.mjs` (no --cli) speaks ACP over stdio: initialize (authMethods from FAKE_SIGNIN_METHODS: claude | claude-custom | codex | none),
// authenticate (FAKE_SIGNIN_AUTH=fail makes it fail), session/new (recorded: a sign-in must never get here).
// Every call appends one JSON line to FAKE_SIGNIN_LOG.
import fs from 'node:fs';
import { exitAfterFlush, popen, pyDumps, sleepSync, sleeper } from './_py.mjs';

const env = process.env;
const LOG = env.FAKE_SIGNIN_LOG;
const STATUS = env.FAKE_SIGNIN_STATUS_FILE;

function log(kind, data) {
  if (LOG) fs.appendFileSync(LOG, pyDumps({ ...data, kind, pid: process.pid }) + '\n', 'utf8');
}

function cli(args) {
  log('cli', { args });
  if (args[0] === 'auth' && args[1] === 'status') {
    const text = STATUS && fs.existsSync(STATUS) ? fs.readFileSync(STATUS, 'utf8') : '{"loggedIn": false}';
    process.stdout.write(text);
    let signedIn = false;
    try {
      signedIn = JSON.parse(text).loggedIn === true;
    } catch { /* not JSON */ }
    return exitAfterFlush(signedIn ? 0 : 1);
  }
  if (args[0] === 'auth' && args[1] === 'login') {
    const mode = env.FAKE_SIGNIN_LOGIN ?? 'ok';
    if (mode === 'ok' && STATUS) fs.writeFileSync(STATUS, '{"loggedIn": true, "authMethod": "claude.ai", "email": "placeholder-account", "subscriptionType": "max"}', 'utf8');
    if (mode === 'fail') return exitAfterFlush(3);
    if (mode === 'hang') {
      const child = popen(process.execPath, ['-e', sleeper(300)], { stdio: 'inherit' });
      if (env.FAKE_SIGNIN_CHILD) fs.writeFileSync(env.FAKE_SIGNIN_CHILD, String(child.pid), 'utf8');
      sleepSync(300000);
    }
    return exitAfterFlush(0);
  }
  exitAfterFlush(2);
}

function methods(caps) {
  const mode = env.FAKE_SIGNIN_METHODS ?? 'claude';
  const terminalOk = !!(((caps || {}).auth || {}).terminal);
  if ((mode === 'claude' || mode === 'claude-custom') && terminalOk) {
    const extra = mode === 'claude-custom' ? ['--custom-flag'] : [];
    return [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai', ...extra] },
      { id: 'console-login', name: 'Anthropic Console', type: 'terminal', args: ['--cli', 'auth', 'login', '--console'] }];
  }
  if (mode === 'codex') {
    return [{ id: 'chatgpt', name: 'Login with ChatGPT', description: 'Use your ChatGPT login' },
      { type: 'env_var', id: 'codex-api-key', name: 'Use CODEX_API_KEY', vars: [{ name: 'CODEX_API_KEY' }] }];
  }
  return [];
}

function acp() {
  let buffer = '';
  const onLine = (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const name = message.method;
    const ident = message.id;
    const params = message.params || {};
    let reply;
    if (name === 'initialize') {
      log('initialize', { caps: params.clientCapabilities });
      reply = { protocolVersion: 1, agentCapabilities: {}, authMethods: methods(params.clientCapabilities) };
    } else if (name === 'authenticate') {
      log('authenticate', { methodId: params.methodId });
      if (env.FAKE_SIGNIN_AUTH === 'fail') {
        process.stdout.write(pyDumps({ jsonrpc: '2.0', id: ident, error: { code: -32000, message: 'login refused' } }) + '\n');
        return;
      }
      if (STATUS) fs.writeFileSync(STATUS, '{"loggedIn": true}', 'utf8');
      reply = {};
    } else if (['session/new', 'session/load', 'session/resume'].includes(name)) {
      log('session', { method: name });
      reply = { sessionId: 'fake' };
    } else return;
    process.stdout.write(pyDumps({ jsonrpc: '2.0', id: ident, result: reply }) + '\n');
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      onLine(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  });
  process.stdin.on('end', () => {
    if (buffer) onLine(buffer);
    return exitAfterFlush(0);
  });
}

if (process.argv.includes('--cli')) cli(process.argv.slice(2).filter((a) => a !== '--cli'));
else acp();
