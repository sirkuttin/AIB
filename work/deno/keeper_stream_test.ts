/**
 * keeper/client.ts KeeperStream (docs/wsl/design.md section 3): a KeeperClient over a child's pipes instead of a socket. The WSL
 * bridge's start is read first (wsl.exe notices, the BRIDGE_MAGIC line, the one-line preamble, in any chunking); the bytes past it
 * go to the frame reader before anything else; and a real keeper (built from keeper/ with Go) is driven over pipeStream. Temp data
 * folders only; the keeper started here is shut down.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import {
  encodeFrame,
  ensureKeeper,
  KeeperClient,
  KeeperError,
  type KeeperStream,
  pipeStream,
  readBridgePreamble,
  readKeeperInfo,
} from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { BRIDGE_MAGIC } from '../../outputs/agent-studio/server/wsl/contract.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const ENC = new TextEncoder();

/** A stream that hands out `chunks` one read at a time, then ends; writes are kept. */
function scripted(chunks: Uint8Array[]): KeeperStream & { written: Uint8Array[]; closed: boolean } {
  const queue = [...chunks];
  const self = {
    written: [] as Uint8Array[],
    closed: false,
    read(p: Uint8Array) {
      const next = queue.shift();
      if (!next) return Promise.resolve(null);
      if (next.length > p.length) {
        queue.unshift(next.subarray(p.length));
        p.set(next.subarray(0, p.length));
        return Promise.resolve(p.length);
      }
      p.set(next);
      return Promise.resolve(next.length);
    },
    write(p: Uint8Array) {
      self.written.push(p.slice());
      return Promise.resolve(p.length);
    },
    close() {
      self.closed = true;
    },
  };
  return self;
}

const PREAMBLE = {
  ev: 'bridge',
  bridge: 1,
  keeper: '1.4.0',
  pid: 77,
  token: 'tok',
  home: '/home/u',
  uid: 1000,
  arch: 'x86_64',
};

function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
  const all = parts.map((p) => (typeof p === 'string' ? ENC.encode(p) : p));
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function bridgeError(stream: KeeperStream, limit?: number): Promise<string> {
  try {
    await readBridgePreamble(stream, limit);
  } catch (error) {
    return error instanceof KeeperError ? error.code : 'other';
  }
  return '';
}

Deno.test('the bridge start: notices skipped, magic then preamble read in any chunking, the rest kept for the frames', async () => {
  const frame = encodeFrame({ ok: true, re: 1 });
  const all = bytes(
    'wsl: Failed to translate a path\r\nsome motd AIB-BRIDGE-1 not at a line start\n',
    BRIDGE_MAGIC,
    '\r\n',
    JSON.stringify(PREAMBLE),
    '\n',
    frame,
  );
  for (const size of [1, 2, 7, 64, all.length]) {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += size) chunks.push(all.subarray(i, i + size));
    const stream = scripted(chunks);
    const { preamble, rest, notices } = await readBridgePreamble(stream);
    assertEquals(preamble, PREAMBLE, `chunks of ${size}`);
    const after = [...rest]; // what was read past the preamble, then what the stream still has: exactly the frame
    for (const p = new Uint8Array(4096);;) {
      const n = await stream.read(p);
      if (n === null) break;
      after.push(...p.subarray(0, n));
    }
    assertEquals(after, [...frame], `chunks of ${size}`);
    assert(notices.startsWith('wsl: Failed to translate'), notices);
  }
  const plain = await readBridgePreamble(scripted([bytes(BRIDGE_MAGIC, '\n', JSON.stringify(PREAMBLE), '\n')]));
  assertEquals([plain.notices, plain.rest.length], ['', 0]);
});

Deno.test('the bridge start is refused: an end before it, too much before the magic line, a preamble that is not one', async () => {
  assertEquals(await bridgeError(scripted([bytes('just a notice\n')])), 'bad_bridge');
  assertEquals(await bridgeError(scripted([bytes('x'.repeat(5000))]), 1000), 'bad_bridge');
  assertEquals(await bridgeError(scripted([bytes(BRIDGE_MAGIC, '\nnot json\n')])), 'bad_bridge');
  assertEquals(await bridgeError(scripted([bytes(BRIDGE_MAGIC, '\n{"ev":"bridge","bridge":2,"token":"t"}\n')])), 'bad_bridge');
  assertEquals(await bridgeError(scripted([bytes(BRIDGE_MAGIC, '\n{"ev":"bridge","bridge":1}\n')])), 'bad_bridge', 'no token');
  assertEquals(
    await bridgeError(scripted([bytes(BRIDGE_MAGIC, 'X\n', JSON.stringify(PREAMBLE), '\n')])),
    'bad_bridge',
    'not the magic line',
  );
});

Deno.test('overStream: hello goes out with the preamble token, and bytes read past the preamble are the first frames', async () => {
  const stream = scripted([]);
  const initial = encodeFrame({
    ok: true,
    re: 1,
    keeper: '1.4.0',
    pid: 4242,
    features: ['notes', 'hold'],
  });
  const client = await KeeperClient.overStream(stream, 'tok', {
    initial,
    pid: 77,
  });
  assertEquals([client.keeperVersion, client.keeperPid, client.has('hold')], ['1.4.0', 4242, true]);
  const hello = new TextDecoder().decode(stream.written[0]);
  assert(hello.includes('"op":"hello"') && hello.includes('"token":"tok"'), hello);
  await client.done; // the scripted stream ends: the client closes
  assert(client.closed && stream.closed);
});

Deno.test('pipeStream: reads split a chunk across calls, writes copy, close ends both sides and tells the owner', async () => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const out = new TransformStream<Uint8Array, Uint8Array>();
  let told = 0;
  const stream = pipeStream(readable, out.writable, () => told++);
  const writer = writable.getWriter();
  void writer.write(ENC.encode('abcdef'));
  const small = new Uint8Array(4);
  assertEquals(await stream.read(small), 4);
  assertEquals(new TextDecoder().decode(small), 'abcd');
  assertEquals(await stream.read(small), 2);
  const reader = out.readable.getReader();
  const buffer = ENC.encode('xyz');
  const sent = stream.write(buffer);
  buffer[0] = 0;
  assertEquals(new TextDecoder().decode((await reader.read()).value), 'xyz');
  await sent;
  stream.close();
  stream.close();
  assertEquals(told, 1);
  let refused = '';
  await stream.write(ENC.encode('late')).catch((e) => (refused = (e as KeeperError).code));
  assertEquals(refused, 'closed');
  await writer.close().catch(() => {});
});

Deno.test({
  name: 'a real keeper driven over pipeStream (the shape of a WSL bridge child)',
  ...T,
  async fn() {
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-keeper-stream-' }));
    const first = await ensureKeeper(dir, {
      extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'],
    });
    const info = readKeeperInfo(dir)!;
    try {
      const at = info.address.lastIndexOf(':');
      const conn = await Deno.connect({
        hostname: info.address.slice(0, at),
        port: Number(info.address.slice(at + 1)),
      });
      const client = await KeeperClient.overStream(pipeStream(conn.readable, conn.writable), info.token, { client: 'stream test' });
      assert(client.has('labels'), client.features.join(','));
      assertEquals(await client.list(), []);
      const status = await client.status();
      assert(Array.isArray(status.clients) && (status.clients as string[]).includes('stream test'), JSON.stringify(status));
      client.close();
      await client.done;
      let refused = '';
      const other = await reconnect(info);
      try {
        await KeeperClient.overStream(pipeStream(other.readable, other.writable), 'wrong');
      } catch (error) {
        refused = (error as KeeperError).code;
      }
      assertEquals(refused, 'bad_token');
    } finally {
      try {
        await first.shutdown(true);
      } catch { /* gone */ }
      first.close();
      if (pidAlive(info.pid)) await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
      for (let i = 0; i < 20; i++) {
        try {
          Deno.removeSync(dir, { recursive: true });
          break;
        } catch {
          await pause(200);
        }
      }
    }
  },
});

function reconnect(info: { address: string }): Promise<Deno.TcpConn> {
  const at = info.address.lastIndexOf(':');
  return Deno.connect({
    hostname: info.address.slice(0, at),
    port: Number(info.address.slice(at + 1)),
  });
}
