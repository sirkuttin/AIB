// Scripted ACP agent for the scroll e2e tests (work/deno/scroll_e2e_test.ts). Node built-ins only, no model calls.
//
// A prompt whose first line is `script:<path>` starts a turn that follows the JSON-lines file <path>: the test appends one line per step and the agent
// sends it at once, so the test decides exactly what arrives and when. Lines:
//
//   {"u": {...}}                    a session/update for this chat (any ACP update body: agent_message_chunk, tool_call, ...)
//   {"u": {...}, "sid": "child-1"}  the same for another session id (a subagent's own messages)
//   {"ask": "title"}                a permission request (the approval card); the answer does not change the script; it is recorded in <script>.answers
//   {"elicit": "question"}          a question (form elicitation); answered like an approval, recorded in <script>.answers
//   {"end": "end_turn"}             the turn ends with that stopReason
//
// Any other prompt is answered with one line and ends at once. session/cancel ends the open turn. Studio starts the Claude launcher
// as `<node-command> <launcher> ...`, so extra arguments are accepted and ignored.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pyDumps, sleep, thread } from '../fakes/_py.mjs';

if (process.argv.slice(2).some((arg) => arg === '-h' || arg === '--help')) {
  process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n');
  process.exit(0);
}

let SESSION = 'scroll-' + crypto.randomBytes(6).toString('hex');
const turn = {};

const emit = (value) => process.stdout.write(pyDumps({ jsonrpc: '2.0', ...value }) + '\n');
const update = (body, sid = null) => emit({ method: 'session/update', params: { sessionId: sid || SESSION, update: body } });

function end(key, reason = 'end_turn') {
  if (turn.key === key) {
    delete turn.key;
    emit({ id: key, result: { stopReason: reason } });
  }
}

/** Send each line of the script as it is appended; give up after 15 minutes. */
async function follow(key, file) {
  const deadline = Date.now() + 900000;
  let pos = 0;
  let buf = '';
  let asks = 0;
  while (Date.now() < deadline && turn.key === key) {
    let chunk = '';
    try {
      const size = fs.statSync(file).size;
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        try {
          const data = Buffer.alloc(size - pos);
          fs.readSync(fd, data, 0, data.length, pos);
          chunk = data.toString('utf8');
          pos = size;
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch { /* not there yet */ }
    if (!chunk) {
      await sleep(10);
      continue;
    }
    buf += chunk;
    while (buf.includes('\n')) {
      const at = buf.indexOf('\n');
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (!line.trim()) continue;
      const step = JSON.parse(line);
      if ('u' in step) update(step.u, step.sid);
      else if ('ask' in step) {
        asks++;
        emit({ id: `scroll-ask-${asks}`, method: 'session/request_permission', params: {
          sessionId: SESSION, toolCall: { title: step.ask, toolCallId: `scroll-ask-${asks}` },
          options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
      } else if ('elicit' in step) {
        emit({ id: `scroll-elicit-${asks + 1}`, method: 'elicitation/create', params: {
          sessionId: SESSION, mode: 'form', message: step.elicit,
          requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } } } });
      } else if ('end' in step) {
        end(key, step.end);
        return;
      }
    }
  }
  end(key, 'cancelled');
}

function onLine(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const method = message.method;
  const key = message.id;
  const params = message.params || {};
  if (method === 'initialize') {
    emit({ id: key, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: false, audio: false } } } });
  } else if (['session/new', 'session/load', 'session/resume'].includes(method)) {
    if (method !== 'session/new' && params.sessionId) SESSION = params.sessionId;
    emit({ id: key, result: { sessionId: SESSION, modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] } } });
  } else if (method === 'session/prompt') {
    const text = ((params.prompt || []).find((b) => b.type === 'text' && !(b.text ?? '').startsWith('<studio-context>'))?.text ?? '').trim();
    if (text.startsWith('script:')) { // only the first line names the script: the rest is what a person typed under it
      turn.key = key;
      turn.path = text.split(/\r\n|\r|\n/)[0].slice(7).trim();
      thread(() => follow(key, turn.path));
    } else {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok: ' + Array.from(text).slice(0, 200).join('') } });
      emit({ id: key, result: { stopReason: 'end_turn' } });
    }
  } else if (method === 'session/cancel') {
    if ('key' in turn) end(turn.key, 'cancelled');
  } else if (['session/set_mode', 'session/set_config_option', 'session/close'].includes(method)) {
    emit({ id: key, result: {} });
  } else if (key !== undefined && key !== null && method) {
    emit({ id: key, error: { code: -32601, message: 'Method not found' } });
  } else if (method === undefined && key !== undefined && key !== null && turn.path) {
    // the answer to our own permission request: recorded next to the script (<script>.answers), so a test can see who answered what
    try {
      fs.appendFileSync(turn.path + '.answers', pyDumps({ id: key, result: message.result }) + '\n', 'utf8');
    } catch { /* not writable */ }
  }
}

let buffer = '';
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
  if (buffer.trim()) onLine(buffer);
  process.stdout.write('', () => process.exit(0));
});
