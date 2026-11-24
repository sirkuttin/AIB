// A stand-in for the WSL helper (server/wsl/helper_main.ts, Track A) in work/deno/wsl_hosts_test.ts and the WSL e2e tests.
//
// Speaks the helper protocol of server/wsl/contract.ts: JSON-RPC 2.0 lines on stdin/stdout, first line `helper.ready`. Offers only
// env.get, which and fs.stat; `which` of the name "open-url" also sends a `browser.open` notification with params.url, the name
// "slow" is never answered, and fs.stat always fails with data.code "not_found". The version in helper.ready is argv[1] (or "fake").
// With argv[2] == "mcp" it also has the MCP tunnel: `mcp: {socket}` in helper.ready, the mcp.* methods (always ok), and `which` of the
// name "mcp-request" sends an `mcp.request` notification with params.rid. `which` of the name "flood" first sends about 4 MB of
// notifications AIB ignores (its ready line then leaves the keeper's 1 MiB record).
import { exitAfterFlush, pyDumps } from './_py.mjs';

const METHODS = ['env.get', 'which', 'fs.stat'];
const argv = process.argv.slice(1); // argv[0] is this script, as sys.argv[0] was
const send = (message) => process.stdout.write(pyDumps(message) + '\n');

const mcp = argv.length > 2 && argv[2] === 'mcp';
const ready = { helper: argv.length > 1 ? argv[1] : 'fake', protocol: 3, methods: [...METHODS, ...(mcp ? ['mcp.accept', 'mcp.reply', 'mcp.closed'] : [])] };
if (mcp) ready.mcp = { socket: '/tmp/aib-wsl-test/data-000000000000/helper/mcp.sock' };
send({ jsonrpc: '2.0', method: 'helper.ready', params: ready });

function onLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const rid = message.id;
  const method = message.method;
  const params = message.params || {};
  if (method === 'env.get') {
    send({ jsonrpc: '2.0', id: rid, result: { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/home/t' }, shell: '/bin/bash', home: '/home/t', arch: 'x86_64' } });
  } else if (method === 'which') {
    const name = String(params.name ?? '');
    if (name === 'slow') return;
    if (name === 'mcp-request') send({ jsonrpc: '2.0', method: 'mcp.request', params: { rid: params.rid ?? '', headers: { 'X-Studio-Conversation-Id': 'c' }, body: '{}' } });
    if (name === 'flood') for (let i = 0; i < 4000; i++) send({ jsonrpc: '2.0', method: 'noise', params: { x: 'x'.repeat(1000) } });
    if (name === 'open-url') send({ jsonrpc: '2.0', method: 'browser.open', params: { url: params.url ?? '' } });
    send({ jsonrpc: '2.0', id: rid, result: { path: '/usr/bin/' + name } });
  } else if (mcp && ['mcp.accept', 'mcp.reply', 'mcp.closed'].includes(method)) {
    send({ jsonrpc: '2.0', id: rid, result: { ok: true } });
  } else if (method === 'fs.stat') {
    send({ jsonrpc: '2.0', id: rid, error: { code: -32000, message: 'No such file', data: { code: 'not_found' } } });
  } else {
    send({ jsonrpc: '2.0', id: rid, error: { code: -32601, message: 'unknown method' } });
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
  exitAfterFlush(0);
});
