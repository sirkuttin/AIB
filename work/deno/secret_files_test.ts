/**
 * Security item 7, "readable token files control agents": AIB's data folder is readable by every process of the user, the agents
 * AIB runs included. These tests play such an agent.
 *
 *   - The data-folder sweep: AIB fills a temp data folder the way it does at work (a real keeper with two chats whose session/new
 *     carries their MCP entry and whose note records it, a hook key in a chat's environment, the artifact key secret, the agent host
 *     file). Then every file is read like an agent's `cat` would, and the test fails if one holds, in a form usable without running
 *     code as the user, the keeper's token, the agent host's token, the artifact key secret, or another chat's artifact or hook key.
 *   - The keeper hand: a process the keeper runs (an agent) reads keeper.json and says hello with whatever token it finds; refused
 *     (Windows: the token is sealed with DPAPI, so it finds none; Linux: it carries the keeper's channel mark, keeper/peer_linux.go).
 *   - Unit cases for state/sealed.ts, the keeper.json and agent-host.json forms, and keyForForwarder.
 *
 * Linux: there is no DPAPI, so the artifact key secret and the per-chat keys stay plain in 0600 files (a residual, see the report);
 * the sweep there checks the keeper and host tokens' use only.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import {
  ensureKeeper,
  forwarderOf,
  forwarderOpensSealed,
  type KeeperClient,
  KeeperClient as Client,
  keyForForwarder,
  readKeeperInfo,
} from '../../outputs/agent-studio/server/keeper/client.ts';
import * as artifactKeys from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { FORWARD_FILE, forwardEntry } from '../../outputs/agent-studio/server/artifacts/mcp_http.ts';
import { HOST_FORMAT, pidAlive, readInfo, writeInfo } from '../../outputs/agent-studio/server/host/host_client.ts';
import { isSealedText, openText, SEALED_PREFIX, sealingOn, sealText } from '../../outputs/agent-studio/server/state/sealed.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const FAST = ['--exit-after', '2s', '--orphan-after', '30s'];
const join = (...parts: string[]) => parts.join(SEP);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) walk(path, out);
    else if (entry.isFile) out.push(path);
  }
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The agent's `cat`: every file of the folder, and which secret (by name) shows in it as is. */
function sweep(dir: string, needles: Record<string, Uint8Array[]>): string[] {
  const found: string[] = [];
  for (const file of walk(dir)) {
    let bytes: Uint8Array;
    try {
      bytes = Deno.readFileSync(file);
    } catch {
      continue; // locked right now (the keeper's lock file): not readable, so nothing found
    }
    for (const [name, forms] of Object.entries(needles)) {
      if (forms.some((f) => f.length >= 16 && indexOf(bytes, f) >= 0)) found.push(`${name} in ${file.slice(dir.length + 1)}`);
    }
  }
  return found;
}

/** What an agent's shell would run: read keeper.json as a file, dial, hello with the plain `token` it finds (if any). */
const THIEF = `
const [file] = Deno.args;
await new Promise((r) => setTimeout(r, 300));
const info = JSON.parse(Deno.readTextFileSync(file));
const conn = info.transport === 'unix'
  ? await Deno.connect({ transport: 'unix', path: info.address })
  : await Deno.connect({ hostname: '127.0.0.1', port: Number(String(info.address).split(':').pop()) });
const head = new TextEncoder().encode(JSON.stringify({ op: 'hello', id: 1, token: info.token ?? '', min: 1, max: 1, client: 'agent' }));
const frame = new Uint8Array(8 + head.length);
const view = new DataView(frame.buffer);
view.setUint32(0, head.length, true);
frame.set(head, 4);
await conn.write(frame);
const buf = new Uint8Array(65536);
let got = new Uint8Array(0);
while (true) {
  const n = await conn.read(buf);
  if (n === null) break;
  got = new Uint8Array([...got, ...buf.subarray(0, n)]);
  if (got.length >= 4 && got.length >= 4 + new DataView(got.buffer).getUint32(0, true)) break;
}
const size = got.length >= 4 ? new DataView(got.buffer).getUint32(0, true) : 0;
console.log(JSON.stringify({ stole: size ? JSON.parse(new TextDecoder().decode(got.subarray(4, 4 + size))) : null }));
`;
const SINK = `for await (const _ of Deno.stdin.readable) { /* an agent that reads its stdin */ }`;

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-secret-files-' }));
  readonly tools = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-secret-tools-' }));
  client: KeeperClient | null = null;

  async [Symbol.asyncDispose](): Promise<void> {
    artifactKeys.configure(null);
    const info = readKeeperInfo(this.dir);
    try {
      await this.client?.shutdown(true);
    } catch { /* gone */ }
    this.client?.close();
    if (info && pidAlive(info.pid)) await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
    for (const d of [this.dir, this.tools]) {
      for (let i = 0; i < 20; i++) {
        try {
          Deno.removeSync(d, { recursive: true });
          break;
        } catch {
          await pause(200);
        }
      }
    }
  }

  script(name: string, text: string): string {
    const path = join(this.tools, name);
    Deno.writeTextFileSync(path, text);
    return path;
  }
}

/** Run a Deno script as a keeper channel (an agent) and collect its stdout until `until` shows. */
async function runChannel(client: KeeperClient, channel: string, script: string, args: string[], env: Record<string, string>, cwd: string) {
  const spawned = await client.spawn({
    channel,
    command: Deno.execPath(),
    args: ['run', '-A', '--no-check', '--quiet', script, ...args],
    cwd,
    env: { ...Deno.env.toObject(), ...env },
  });
  let out = '';
  await client.attach(channel, 0, { record: (r) => (r.kind === 'out' ? (out += DEC.decode(r.body)) : undefined) });
  return { epoch: spawned.epoch, out: () => out };
}

Deno.test('an agent that reads the data folder finds nothing that controls the keeper or another chat', T, async () => {
  await using lab = new Lab();
  assert(artifactKeys.configure(lab.dir), 'artifact key secret');
  const hostToken = 'host-token-' + crypto.randomUUID().replaceAll('-', '');
  await writeInfo(lab.dir, { format: HOST_FORMAT, port: 1, token: hostToken, pid: Deno.pid, protocol: 4 });
  const client = lab.client = await ensureKeeper(lab.dir, { extraArgs: FAST });
  const keeperToken = readKeeperInfo(lab.dir)!.token;
  assertEquals(keeperToken.length, 64, 'AIB itself still reads the keeper token');
  const forwarder = (await forwarderOf(null, lab.dir))!;
  assert(forwarder, 'the keeper program answers mcp-forward --check');
  if (sealingOn()) assert(forwarderOpensSealed(forwarder), 'keeper 1.7.0 opens sealed keys');

  // Two chats as AIB runs them: the hook key in the agent's environment, the MCP entry in session/new (journaled) and the note.
  const sink = lab.script('sink.ts', SINK);
  const chats: Record<string, { key: string; hook: string }> = {};
  for (const name of ['a', 'b']) {
    const id = (name.repeat(32)).slice(0, 32);
    const key = artifactKeys.issue(id)!;
    const hook = artifactKeys.issueHookKey(id)!;
    chats[name] = { key, hook };
    const entry = forwardEntry(forwarder, join(lab.dir, FORWARD_FILE), key, id);
    const channel = `chat-${id}`;
    const { epoch } = await runChannel(client, channel, sink, [], {
      AIB_HOOK_KEY: keyForForwarder(forwarder, 'hook-key', hook),
      AIB_HOOK_CHAT: id,
    }, lab.tools);
    await client.note(channel, epoch, ENC.encode(JSON.stringify({ t: 'chat', mcpServers: [entry] })));
    const newSession = { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: lab.tools, mcpServers: [entry] } };
    await client.write(channel, epoch, ENC.encode(JSON.stringify(newSession) + '\n'));
  }
  await pause(500); // the keeper flushes its journals every 200 ms

  // Chat A's agent reads every file of the data folder.
  const secretFile = Deno.readFileSync(join(lab.dir, artifactKeys.SECRET_FILE));
  const secret = artifactKeys.secretOfFile(secretFile)!;
  const forms = (s: string) => [ENC.encode(s), ENC.encode(JSON.stringify(s).slice(1, -1))];
  const needles: Record<string, Uint8Array[]> = {
    'the keeper token': forms(keeperToken),
    'the agent host token': forms(hostToken),
    'the artifact key secret': [secret, ENC.encode(hex(secret)), ENC.encode(btoa(String.fromCharCode(...secret)))],
    "chat b's artifact key": forms(chats.b.key),
    "chat b's hook key": forms(chats.b.hook),
  };
  // Control: the sweep does see the journals (chat b's id is in its channel's records and the channel index).
  const control = sweep(lab.dir, { "chat b's id": [ENC.encode('b'.repeat(32))] });
  assert(control.some((f) => f.includes('channels')), `the sweep did not read the keeper's journals: ${control}`);
  const found = sweep(lab.dir, needles);
  if (sealingOn()) {
    assertEquals(found, [], 'a readable file gives an agent control');
    // ... and AIB's own ways in still work with the sealed forms
    assertEquals((await readInfo(lab.dir))?.token, hostToken);
    assert(isSealedText(JSON.parse(Deno.readTextFileSync(join(lab.dir, 'keeper', 'keeper.json'))).tokenSealed));
  } else {
    // No DPAPI: the keeper and host tokens sit in 0600 files; what guards the keeper is the peer check below. The per-chat keys
    // and the artifact secret are a known residual on Linux (see the report); listed so a change shows.
    console.log(`No DPAPI sealing here; readable as is (residual): ${found.join('; ') || 'nothing'}`);
  }

  // Chat A's agent tries the keeper with what it read; then again from a process that left its parent.
  const thief = lab.script('thief.ts', THIEF);
  const keeperJson = join(lab.dir, 'keeper', 'keeper.json');
  const run = await runChannel(client, `chat-${'a'.repeat(32)}-shell`, thief, [keeperJson], {}, lab.tools);
  await until(() => run.out().includes('"stole"'), 'the agent tried', 30);
  const answer = JSON.parse(run.out().trim().split('\n').pop()!).stole;
  assertEquals(answer?.ok, false, `the agent got the keeper: ${run.out()}`);
  assertEquals(answer?.error, Deno.build.os === 'linux' ? 'bad_peer' : 'bad_token', run.out());

  // AIB still gets in.
  const again = await Client.connect(readKeeperInfo(lab.dir)!);
  assert((await again.list()).length >= 3);
  again.close();
});

Deno.test('sealed values: round trip, purposes, plain values pass, damaged ones do not open', () => {
  if (!sealingOn()) {
    assertEquals(sealText('hook-key', 'k1'), 'k1', 'no DPAPI: plain');
    assertEquals(openText('hook-key', SEALED_PREFIX + 'AAAA'), null);
    return;
  }
  const s = sealText('hook-key', 'k1-secret');
  assert(s.startsWith(SEALED_PREFIX) && !s.includes('k1-secret'), s);
  assert(sealText('hook-key', 'k1-secret') !== s, 'randomised');
  assertEquals(openText('hook-key', s), 'k1-secret');
  assertEquals(openText('mcp-forward-headers', s), null, 'another purpose does not open it');
  assertEquals(openText('hook-key', 'plain'), 'plain', 'an older plain value passes');
  assertEquals(openText('hook-key', SEALED_PREFIX + btoa('junk junk junk junk')), null);
  const before = Deno.env.get('AIB_SEAL');
  Deno.env.set('AIB_SEAL', 'off');
  try {
    assertEquals(sealText('hook-key', 'k2'), 'k2', 'AIB_SEAL=off keeps the plain form');
    assertEquals(openText('hook-key', s), 'k1-secret', 'opening still works');
  } finally {
    if (before === undefined) Deno.env.delete('AIB_SEAL');
    else Deno.env.set('AIB_SEAL', before);
  }
});

Deno.test('agent-host.json: the token is sealed on Windows and read back; an older plain file still reads', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-host-info-' });
  try {
    await writeInfo(dir, { format: HOST_FORMAT, port: 4242, token: 'tok-' + 'x'.repeat(40), pid: Deno.pid });
    const text = Deno.readTextFileSync(join(dir, 'agent-host.json'));
    assertEquals(text.includes('tok-'), !sealingOn(), text);
    assertEquals((await readInfo(dir))?.token, 'tok-' + 'x'.repeat(40));
    Deno.writeTextFileSync(join(dir, 'agent-host.json'), JSON.stringify({ format: HOST_FORMAT, port: 4242, token: 'old-plain', pid: 1 }));
    assertEquals((await readInfo(dir))?.token, 'old-plain', 'an older host');
    if (sealingOn()) {
      Deno.writeTextFileSync(
        join(dir, 'agent-host.json'),
        JSON.stringify({ format: HOST_FORMAT, port: 1, tokenSealed: SEALED_PREFIX + 'AAAA', pid: 1 }),
      );
      assertEquals(await readInfo(dir), null, 'a token sealed for someone else: no host');
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("keeper.json: AIB reads a sealed token and an older keeper's plain one", () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-keeper-info-' });
  try {
    Deno.mkdirSync(join(dir, 'keeper'));
    const file = join(dir, 'keeper', 'keeper.json');
    const base = { pid: 1, protocol: 1, keeper: '1.6.0', transport: 'tcp', address: '127.0.0.1:1', started: 1, orphanCommand: null };
    Deno.writeTextFileSync(file, JSON.stringify({ ...base, token: 'p'.repeat(64) }));
    assertEquals(readKeeperInfo(dir)?.token, 'p'.repeat(64), 'keeper 1.6.0 and older');
    Deno.writeTextFileSync(file, JSON.stringify(base));
    assertEquals(readKeeperInfo(dir), null, 'no token at all');
    if (sealingOn()) {
      Deno.writeTextFileSync(file, JSON.stringify({ ...base, keeper: '1.7.0', tokenSealed: sealText('keeper-token', 's'.repeat(64)) }));
      assertEquals(readKeeperInfo(dir)?.token, 's'.repeat(64));
      Deno.writeTextFileSync(file, JSON.stringify({ ...base, tokenSealed: sealText('hook-key', 's'.repeat(64)) }));
      assertEquals(readKeeperInfo(dir), null, 'sealed for another purpose');
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('keyForForwarder seals only for a keeper program that says it opens sealed keys', T, async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-forwarder-' });
  try {
    const program = (await forwarderOf(null, dir))!;
    const sealed = keyForForwarder(program, 'hook-key', 'hk');
    assertEquals(isSealedText(sealed), sealingOn(), sealed);
    assertEquals(openText('hook-key', sealed), 'hk');
    assertEquals(keyForForwarder(join(dir, 'never-checked.exe'), 'hook-key', 'hk'), 'hk', 'an unknown (older) program: plain');
    const entry = forwardEntry(program, join(dir, FORWARD_FILE), 'the-key', 'c1') as { env: { name: string; value: string }[] };
    const value = entry.env[0].value;
    assertEquals(value.includes('the-key'), !sealingOn(), value);
    assertEquals(JSON.parse(openText('mcp-forward-headers', value)!)['X-Studio-Artifact-Key'], 'the-key');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
