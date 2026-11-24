// A stand-in for `codex app-server` (server/agents/codex_limits.ts appServerLimits): answers initialize and
// account/rateLimits/read with fixed numbers, in the documented camelCase shape. Arguments are ignored except:
//   --fail      answer account/rateLimits/read with an error
//   --log FILE  append each received method to FILE (tests check the handshake and that only one read was made)
import fs from 'node:fs';
import { exitAfterFlush } from './_py.mjs';

const args = process.argv.slice(2);
const log = args.includes('--log') ? args[args.indexOf('--log') + 1] : null;

// json.dumps wrote the floats as 12.0 and 86.0
const send = (text) => process.stdout.write(text + '\n');
const head = (id) => `{"jsonrpc": "2.0", "id": ${JSON.stringify(id)}`;

function onLine(line) {
  const message = JSON.parse(line);
  const method = message.method;
  if (log) fs.appendFileSync(log, String(method) + '\n', 'utf8');
  const id = JSON.stringify(message.id);
  if (method === 'initialize') {
    send(`{"jsonrpc": "2.0", "id": ${id}, "result": {"userAgent": "fake", "codexHome": "/fake"}}`);
  } else if (method === 'account/rateLimits/read' && args.includes('--fail')) {
    send(`{"jsonrpc": "2.0", "id": ${id}, "error": {"code": -32603, "message": "not signed in"}}`);
  } else if (method === 'account/rateLimits/read') {
    const bucket = '{"limitId": "codex", "limitName": null, '
      + '"primary": {"usedPercent": 12.0, "windowDurationMins": 300, "resetsAt": 4000000000}, '
      + '"secondary": {"usedPercent": 86.0, "windowDurationMins": 10080, "resetsAt": 4000500000}, '
      + '"credits": {"hasCredits": false, "unlimited": false, "balance": "0"}, "planType": "plus"}';
    send(`{"jsonrpc": "2.0", "id": ${id}, "result": {"rateLimits": ${bucket}, "rateLimitsByLimitId": {"codex": ${bucket}}}}`);
  }
}

void head;
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
  exitAfterFlush(0);
});
