// A tiny ACP agent whose stdout and stderr bytes are awkward on purpose, for the Deno Connection parity test.
//
// The prompt "edge" writes: a multibyte character split across two writes, invalid UTF-8, CRLF and lone-CR line ends, a 3 MB line,
// a BOM line, a non-JSON line and an unknown notification; stderr gets trailing blanks, invalid UTF-8, an over-long line and more
// lines than Studio keeps. On stdin EOF it writes one last notification and half a UTF-8 character with no newline, then exits.
// Does not call a model or execute anything.
import fs from 'node:fs';
import { pyDumps, sleep } from './_py.mjs';

// Each write goes out whole and in order: wait for the pipe to take it.
const writeTo = (stream, data) => new Promise((resolve) => stream.write(data, () => resolve()));
const send = (data) => writeTo(process.stdout, data);
const dumps = (value) => Buffer.from(pyDumps(value, false, false), 'utf8'); // json.dumps(..., ensure_ascii=False).encode('utf-8')
const dumpsAscii = (value) => Buffer.from(pyDumps(value), 'utf8');
const NL = Buffer.from('\n');
const emit = (value) => send(Buffer.concat([dumps({ jsonrpc: '2.0', ...value }), NL]));
const update = (text) => ({ method: 'session/update', params: { sessionId: 'stream-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const latin = (text) => Buffer.from(text, 'latin1');

async function edge(key) {
  const line = Buffer.concat([dumps({ jsonrpc: '2.0', ...update('split € here') }), NL]);
  const cut = line.indexOf(Buffer.from('€', 'utf8')) + 1;
  await send(line.subarray(0, cut));
  await sleep(50);
  await send(line.subarray(cut));
  await send(latin('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"stream-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"bad \xff\xfe byte \xf0\x80\x80 end"}}}}\n'));
  await send(Buffer.concat([dumpsAscii({ jsonrpc: '2.0', ...update('crlf') }), Buffer.from('\r\n')]));
  await send(Buffer.concat([dumpsAscii({ jsonrpc: '2.0', ...update('lone cr') }), Buffer.from('\r'), dumpsAscii({ jsonrpc: '2.0', ...update('after cr') }), NL]));
  const big = dumpsAscii({ jsonrpc: '2.0', ...update('x'.repeat(3_000_000)) });
  for (let start = 0; start < big.length; start += 65536) await send(big.subarray(start, start + 65536));
  await send(NL);
  await send(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), dumpsAscii({ jsonrpc: '2.0', ...update('bom') }), NL]));
  await send(Buffer.from('this is not json\n\n   \n'));
  await emit({ method: 'x/whatever', params: { a: 1 } });
  const err = (data) => writeTo(process.stderr, data);
  await err(Buffer.concat([latin('warn line   \t \n\xfe bad bytes\n'), Buffer.from('y'.repeat(3000) + '\n')]));
  for (let index = 0; index < 35; index++) await err(Buffer.from(`stderr ${index}\n`));
  await err(Buffer.from('no newline at the end'));
  await emit({ id: key, result: { stopReason: 'end_turn' } });
}

async function onLine(raw) {
  const message = JSON.parse(raw);
  const method = message.method;
  const key = message.id;
  const params = message.params ?? {};
  if (method === 'initialize') await emit({ id: key, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (method === 'session/new') await emit({ id: key, result: { sessionId: 'stream-session' } });
  else if (method === 'session/prompt') {
    const text = (params.prompt ?? []).find((b) => b.type === 'text')?.text ?? '';
    if (text === 'edge') await edge(key);
    else {
      await emit(update('echo ' + text));
      await emit({ id: key, result: { stopReason: 'end_turn' } });
    }
  }
}

let chain = Promise.resolve();
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const raw = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    chain = chain.then(() => onLine(raw));
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) {
    const raw = buffer;
    buffer = '';
    chain = chain.then(() => onLine(raw));
  }
  chain.then(async () => {
    await send(Buffer.concat([dumpsAscii({ jsonrpc: '2.0', method: 'x/tail', params: {} }), Buffer.from([0x0a, 0xe2])]));
    process.exit(0);
  });
});
void fs;
