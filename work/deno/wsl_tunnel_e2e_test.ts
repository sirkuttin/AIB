/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the AIB tools tunnel (docs/wsl/design.md sections 4, 6, 11; wsl/mcp_tunnel.ts).
 *   - A WSL chat's `studio_artifact` entry is the distro's own keeper program, `mcp-forward --helper-socket <data>/helper/mcp.sock`.
 *     Run inside the distro the way the agent runs it, a tools/list goes forwarder -> helper relay -> helper channel -> AIB's endpoint
 *     (with this chat's key) and the answer comes back: the WSL tool list (artifacts and docs, no helper chats).
 *   - The same with WSL interop switched off for the forwarder alone (`unshare -rm`: a user and mount namespace of its own with
 *     /run/WSL hidden and no WSL_INTEROP, so no Windows program can start in it; nothing outside that process changes), so the tunnel
 *     does not depend on interop; a wrong key is refused and nothing runs. This test's AIB has no Windows keeper, so it publishes no
 *     Windows address file: the interop path could not answer at all.
 *   - A helper without the tunnel (its keeper program missing): the chat falls back to the interop entry (the Windows forwarder as
 *     /mnt/c/...), which answers while interop is on and cannot start with interop off.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; the fake agent is work/fake_acp.py; never the owner's homes.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { wslToolsNotice } from '../../outputs/agent-studio/server/wsl/access.ts';
import type { WslInstall } from '../../outputs/agent-studio/server/wsl/install.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';

type Json = Record<string, unknown>;

function studioIn(state: string, keeper: KeeperLink | null = null): Studio {
  // the artifact tool is on (no noArtifactTool): the chat gets its studio_artifact entry
  const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null }, { keeper });
  studio.ownerProbe = () => null;
  studio.connectionFactory = (_command, cwd, provider, options) =>
    new Connection(['python3', `${ROOT}/fake_acp.py`, '--cancel-aware'], cwd, provider, {
      ...options,
      wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
    });
  return studio;
}

const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));

type Entry = { command: string; args: string[]; env: { name: string; value: string }[] };

const MESSAGES = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

/** sh that runs "$@" with WSL interop off for it alone: its own user and mount namespace, /run/WSL hidden, no WSL_INTEROP. */
const NO_INTEROP = `exec unshare -rm sh -c 'mount -t tmpfs none /run/WSL && unset WSL_INTEROP && exec "$@"' sh "$@"`;

/** Can this distro switch interop off for one process (unprivileged user namespaces), and is it then really off? */
async function interopOffWorks(): Promise<boolean> {
  const probe = await inDistro(`${NO_INTEROP.replace('exec unshare', 'unshare')}; echo "rc=$?"`, ['/mnt/c/Windows/System32/cmd.exe', '/c', 'exit 0']);
  const on = await inDistro('/mnt/c/Windows/System32/cmd.exe /c exit 0 </dev/null >/dev/null 2>&1; echo "rc=$?"');
  return on.out.includes('rc=0') && !probe.out.includes('rc=0');
}

/**
 * Run an MCP stdio entry inside the distro as an agent would (its env from the entry; the first stdin line is the headers, read by sh,
 * so no JSON goes through wsl.exe's command line), feed it MESSAGES and return its answers by id. `noInterop`: interop off for it.
 */
async function runEntry(entry: Entry, headers: string, noInterop = false): Promise<{ answers: Map<number, Json>; err: string; code: number }> {
  const wslenv = entry.env.find((e) => e.name === 'WSLENV')?.value ?? '';
  const script = `IFS= read -r h; export MCP_FORWARD_HEADERS="$h"; export WSLENV="${wslenv}"; ${noInterop ? NO_INTEROP : 'exec "$@"'}`;
  const stdin = new TextEncoder().encode([headers, ...MESSAGES.map((m) => JSON.stringify(m))].join('\n') + '\n');
  const run = await inDistro(script, [entry.command, ...entry.args], stdin);
  const answers = new Map<number, Json>();
  for (const line of run.out.split('\n').filter((l) => l.trim())) {
    const msg = JSON.parse(line) as Json;
    answers.set(Number(msg.id), msg);
  }
  return { answers, err: run.err, code: run.code };
}

const toolNames = (answer: Json | undefined) => (((answer?.result as Json)?.tools as Json[]) ?? []).map((t) => String(t.name));

Deno.test({
  name: 'wsl e2e tunnel: a tool call from inside the distro reaches AIB and the answer returns; with interop off too; a wrong key refused',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-tunnel-e2e-' });
    await prepareRoot();
    const studios: Studio[] = [];
    try {
      const host = await readyHost();
      const tunnel = host.mcpTunnel;
      assert(tunnel, 'the helper runs the tunnel');
      assert(tunnel.socket.startsWith(`${ROOT}/data-`) && tunnel.socket.endsWith('/helper/mcp.sock'), tunnel.socket);
      assert(tunnel.forwarder.startsWith(`${ROOT}/`) && tunnel.forwarder.endsWith('/AIB-keeper'), tunnel.forwarder);
      const socketMode = await inDistro('stat -c %a "$1"; stat -c %a "$(dirname "$1")"', [tunnel.socket]);
      assertEquals(socketMode.out.trim().split('\n'), ['600', '700']);

      const studio = studioIn(state);
      studios.push(studio);
      const c = await studio.connect('claude', refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` }));
      const entry = c.mcpServers[0] as unknown as Entry;
      assertEquals([entry.command, ...entry.args], [tunnel.forwarder, 'mcp-forward', '--helper-socket', tunnel.socket]);
      assert(!entry.env.some((e) => e.name === 'WSLENV'), 'nothing crosses interop');
      assert(notes(c).includes(wslToolsNotice()), notes(c).join(' | '));
      const headers = entry.env.find((e) => e.name === 'MCP_FORWARD_HEADERS')!.value;

      const run = await runEntry(entry, headers);
      assertEquals(run.code, 0, run.err);
      assertEquals(((run.answers.get(1)?.result as Json)?.serverInfo as Json)?.name, 'studio_artifact', JSON.stringify([...run.answers]));
      const names = toolNames(run.answers.get(2));
      assert(names.includes('publish') && names.includes('archive'), names.join());
      assert(names.includes('doc_create') && !names.includes('start_helper'), 'the doc tools are on in WSL; helper chats stay off');
      if (c.worktree) assert(names.includes('merge_into_project'), 'a chat in its own copy can merge');

      // interop off for the forwarder alone: no Windows program can start there, and the tunnel still answers
      if (await interopOffWorks()) {
        const off = await runEntry(entry, headers, true);
        assertEquals(off.code, 0, off.err);
        assert(toolNames(off.answers.get(2)).includes('publish'), `${JSON.stringify([...off.answers])} ${off.err}`);
      } else console.log('note: this distro cannot switch interop off for one process (no unprivileged namespaces); that part skipped');
      const elf = await inDistro('head -c 4 "$1" | od -An -c', [entry.command]);
      assert(elf.out.includes('E   L   F'), `the forwarder is a Linux program: ${elf.out}`);

      // a wrong key: AIB refuses, nothing runs
      const wrong = JSON.stringify({ ...JSON.parse(headers), 'X-Studio-Artifact-Key': 'not-the-key' });
      const refused = await runEntry(entry, wrong);
      const error = (refused.answers.get(2)?.error ?? {}) as Json;
      assert(String(error.message).includes('HTTP 401') && String(error.message).includes('refused the artifact key'), JSON.stringify(error));
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

Deno.test({
  name: 'wsl e2e tunnel: a helper without the tunnel falls back to the interop entry, which answers while interop is on',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-tunnel-fallback-e2e-' });
    // the helper is told a keeper program that is not there: it starts without the tunnel (as an older helper would)
    newAib({ helperCommand: (install: WslInstall) => ({ command: install.helper, args: ['--data', install.data, '--keeper', `${ROOT}/none/AIB-keeper`] }) });
    await prepareRoot();
    const studios: Studio[] = [];
    // a Windows keeper, as AIB always has: the interop forwarder finds AIB through the address file it publishes for the keeper
    const windows = new KeeperLink({ dataDir: state, orphan: null, extraArgs: ['--exit-after', '2s'] });
    try {
      const host = await readyHost();
      assertEquals(host.mcpTunnel ?? null, null);
      const studio = studioIn(state, windows);
      studios.push(studio);
      const c = await studio.connect('claude', refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` }));
      const entry = c.mcpServers[0] as unknown as Entry | undefined;
      assert(entry, `an entry, or the notice: ${notes(c).join(' | ')}`);
      assert(entry.command.startsWith('/mnt/') && /AIB-keeper\.exe$/i.test(entry.command), entry.command);
      assertEquals(entry.args[0], 'mcp-forward');
      assert(notes(c).includes(wslToolsNotice()), notes(c).join(' | '));
      const headers = entry.env.find((e) => e.name === 'MCP_FORWARD_HEADERS')!.value;
      const run = await runEntry(entry, headers);
      assert(toolNames(run.answers.get(2)).includes('publish'), `${JSON.stringify([...run.answers])} ${run.err}`);
      // with interop off this entry cannot start (the reason the tunnel exists): no answer comes back
      if (await interopOffWorks()) {
        const off = await runEntry(entry, headers, true);
        assertEquals(off.answers.size, 0, JSON.stringify([...off.answers]));
      }
    } finally {
      for (const s of studios) await s.close().catch(() => {});
      try {
        await (await windows.client(false))?.shutdown(true);
      } catch { /* not running */ }
      windows.disconnect();
      await cleanRoot();
      newAib();
      for (let i = 0; i < 20; i++) {
        try {
          Deno.removeSync(state, { recursive: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250)); // the keeper closing its log
        }
      }
    }
  },
});
