/**
 * A puppet ACP agent for the steer-on-send tests (steer_*_test.ts): the TEST plays the agent. Run as
 * `deno run -A _steer_puppet.ts <port>`: it connects to the test on 127.0.0.1:<port> and relays every line AIB writes to its stdin to
 * the test, and every line the test sends to its stdout (to AIB). It replays nothing on its own, so a test can send exactly the shapes
 * the recordings (work/steer-recordings) show, in any order and timing.
 *
 * Lines from the test that start with '#' are commands for the puppet itself, answered on the socket only:
 *   #spawn <tag> [deep]   start a sleeping child process (deep: that child starts a sleeping grandchild too): `#spawned <tag> <pid>`
 *   #exit                 exit at once
 * Children are plain `deno eval` sleepers, so a background command and its processes are real and Stop can be tested on them.
 */
const port = Number(Deno.args[0]);
const conn = await Deno.connect({ hostname: '127.0.0.1', port });
const enc = new TextEncoder();
const dec = new TextDecoder();
const stdout = Deno.stdout.writable.getWriter();
let toTest = Promise.resolve();
async function writeAll(bytes: Uint8Array): Promise<void> {
  for (let off = 0; off < bytes.length;) off += await conn.write(bytes.subarray(off));
}
const send = (line: string) => (toTest = toTest.then(() => writeAll(enc.encode(line + '\n'))));

const SLEEP = 'setTimeout(() => {}, 600000)';
const DEEP = `new Deno.Command(Deno.execPath(), { args: ['eval', ${JSON.stringify(SLEEP)}], stdin: 'null', stdout: 'null', ` +
  `stderr: 'null' }).spawn(); ${SLEEP}`;

function command(line: string): void {
  const [verb, tag, mode] = line.slice(1).trim().split(/\s+/);
  if (verb === 'exit') Deno.exit(0);
  if (verb === 'spawn') {
    const child = new Deno.Command(Deno.execPath(), {
      args: ['eval', mode === 'deep' ? DEEP : SLEEP],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).spawn();
    send(`#spawned ${tag} ${child.pid}`);
  }
}

// AIB -> test
(async () => {
  for await (const chunk of Deno.stdin.readable) await (toTest = toTest.then(() => writeAll(chunk)));
  Deno.exit(0); // AIB closed our stdin: an ACP agent exits
})();

// test -> AIB (or the puppet)
let buffer = '';
for await (const chunk of conn.readable) {
  buffer += dec.decode(chunk, { stream: true });
  let at: number;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.startsWith('#')) command(line);
    else if (line.trim()) await stdout.write(enc.encode(line + '\n'));
  }
}
Deno.exit(0);
