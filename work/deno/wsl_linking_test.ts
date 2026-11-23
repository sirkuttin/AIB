/**
 * Settings > AIB Linking (WSL), phase 1, server side (docs/wsl/linking-design.md section 11 items 1, 2, 4), with no distro:
 *   1. Peek mode: GET /api/live/wsl/agents?peek=1, the status poll and the WSL sign-in terminal never start a distro (a FakeWslHost
 *      counts start()); start=1 (the "Start Ubuntu and check" click) does.
 *   2. /api/live/wsl/status: wsl {exe, problem}, skipped [{name, why}], per-distro isDefault, every earlier field kept.
 *   3. Codex detection: the current package name @agentclientprotocol/codex-acp in the global lookup, an asdf shim / npm bin link of
 *      the adapter resolved to [real node, entry] so the bundled Codex CLI is found, bundledCli on agents.detect rows (Claude Code
 *      and Codex) and on /wsl/agents rows, and the install hints name packages AIB detects.
 * Temp folders only; nothing runs a real node, npm or agent. wsl_linking_e2e_test.ts checks the shim case in a real distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { setDistroSource, setWslHostResolver, WSL_INSTALL, wslOverview } from '../../outputs/agent-studio/server/wsl/access.ts';
import { wslRoutes, wslStatus } from '../../outputs/agent-studio/server/web/wsl_routes.ts';
import { wslSigninCommand } from '../../outputs/agent-studio/server/web/terminal_routes.ts';
import { urlGate } from '../../outputs/agent-studio/server/wsl/open_urls.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import * as adapters from '../../outputs/agent-studio/server/agents/adapters.ts';
import { bundledClaudeCli, bundledCodexCli, findCodexCli } from '../../outputs/agent-studio/server/agents/signin.ts';
import { makeMethods } from '../../outputs/agent-studio/server/wsl/helper/methods.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const join = (...parts: string[]) => parts.join(SEP);

/** A host the way wsl/hosts.ts makes it before anything asked it to start (`begun` false), counting every start(). */
class CountingHost extends FakeWslHost {
  starts = 0;
  begun = false;
  override start(): Promise<void> {
    this.starts++;
    this.begun = true;
    this.state = 'ready';
    this.note = '';
    return Promise.resolve();
  }
}

function withHost(host: FakeWslHost | null): void {
  setWslHostResolver((d) => (host && d === host.distro.toLowerCase() ? host : null));
}

async function agentsRoute(query: string): Promise<[number, Json]> {
  const handler = wslRoutes().get('GET /api/live/wsl/agents')!;
  const url = new URL(`http://127.0.0.1/api/live/wsl/agents?${query}`);
  const ctx = { token: 't', stateDir: null } as unknown as WebContext;
  const [status, body] = await handler(ctx, url, null, new Request(url, { headers: { 'X-Studio-Token': 't' } }));
  return [status, body as Json];
}

function write(path: string, text = ''): void {
  Deno.mkdirSync(path.slice(0, path.lastIndexOf(SEP)), { recursive: true });
  Deno.writeTextFileSync(path, text);
}

// ---- 1. peek mode ----------------------------------------------------------------------------------------------------------------

Deno.test({
  name: 'wsl linking: opening Settings (status poll, agents peek, sign-in) never starts a distro; start=1 does',
  ...T,
  async fn() {
    const host = new CountingHost('unused', 'Ubuntu');
    host.state = 'starting'; // what a host made but never started says; peek calls it 'off'
    withHost(host);
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, isDefault: true }]));
    urlGate.setForTests(() => {});
    try {
      const status = await wslStatus({ stateDir: null });
      const [one] = status.distros as Json[];
      assertEquals([one.state, one.line], ['off', '']);
      assertEquals(await agentsRoute('distro=Ubuntu&peek=1'), [200, { distro: 'ubuntu', name: 'Ubuntu', state: 'off', line: '', agents: [] }]);
      assertEquals(await agentsRoute('distro=ubuntu&peek=1&force=1'), [200, { distro: 'ubuntu', name: 'Ubuntu', state: 'off', line: '', agents: [] }]);
      const refused = await wslSigninCommand('codex', 'ubuntu');
      assertEquals(refused, 'Ubuntu is not running. Start it in Settings > AIB Linking (WSL), then sign in.');
      assertEquals(host.starts, 0, 'nothing started the distro');
      assertEquals(host.calls.filter(([m]) => m !== 'env.get').length, 0, 'no helper call either');

      // a distro that stopped: its state and line, still no start
      host.begun = true;
      host.state = 'stopped';
      host.note = 'Ubuntu stopped (Windows restart or `wsl --shutdown`).';
      assertEquals(await agentsRoute('distro=ubuntu&peek=1'), [200, { distro: 'ubuntu', name: 'Ubuntu', state: 'stopped', line: host.note, agents: [] }]);
      assertEquals(await wslSigninCommand('claude', 'ubuntu'), host.note);
      assertEquals(host.starts, 0);

      // "Start Ubuntu and check": start=1 starts it and answers the rows
      host.begun = false;
      host.state = 'starting';
      const [s1, started] = await agentsRoute('distro=ubuntu&peek=1&start=1');
      assertEquals([s1, started.state, started.line, (started.agents as Json[]).map((a) => a.id)], [200, 'ready', '', ['claude', 'codex']]);
      assertEquals(host.starts, 1);

      // ready: peek answers the rows (with state), and never starts again
      host.handlers['agents.detect'] = () => ({
        agents: [
          { id: 'claude', found: true, command: ['/usr/bin/node', '/x/node_modules/a/dist/index.js'], version: '1.0.0', bundledCli: true },
          { id: 'codex', found: false, bundledCli: false },
        ],
      });
      const [s2, ready] = await agentsRoute('distro=ubuntu&peek=1');
      assertEquals([s2, ready.state, ready.line], [200, 'ready', '']);
      const rows = ready.agents as Json[];
      assertEquals(rows.map((a) => [a.id, a.found, a.bundledCli]), [['claude', true, true], ['codex', false, false]]);
      assertEquals(rows[1].install, 'npm i -g @agentclientprotocol/codex-acp');
      assertEquals(host.starts, 1, 'peek on a ready distro starts nothing');

      // without peek (the agent picker of a WSL project) the answer keeps its old shape
      const [s3, picker] = await agentsRoute('distro=ubuntu');
      assertEquals([s3, Object.keys(picker)], [200, ['distro', 'name', 'agents']]);

      // the sign-in the user clicked may start it
      host.begun = false;
      host.state = 'starting';
      const signin = await wslSigninCommand('claude', 'ubuntu', [], true);
      assertEquals(typeof signin === 'string' ? signin : signin.file, '/usr/bin/node');
      assertEquals(host.starts, 2);
    } finally {
      setDistroSource(null);
      setWslHostResolver(null);
      urlGate.setForTests(null);
    }
  },
});

Deno.test({
  name: 'wsl linking: a distro with no host at all (AIB has not used WSL yet) peeks as off, without making or starting one',
  ...T,
  async fn() {
    withHost(null);
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2 }]));
    try {
      await wslOverview(); // the distro list the page polled (names)
      assertEquals(await agentsRoute('distro=ubuntu&peek=1'), [200, { distro: 'ubuntu', name: 'Ubuntu', state: 'off', line: '', agents: [] }]);
      assertEquals(await wslSigninCommand('codex', 'ubuntu'), 'Ubuntu is not running. Start it in Settings > AIB Linking (WSL), then sign in.');
    } finally {
      setDistroSource(null);
      setWslHostResolver(null);
    }
  },
});

// ---- 2. status fields --------------------------------------------------------------------------------------------------------------

Deno.test({
  name: 'wsl linking: status adds wsl {exe, problem}, skipped and isDefault, and keeps every earlier field',
  ...T,
  async fn() {
    const host = new FakeWslHost('unused', 'Ubuntu');
    withHost(host);
    urlGate.setForTests(() => {});
    setDistroSource(() =>
      Promise.resolve([{ name: 'Debian', version: 2 }, { name: 'Ubuntu', version: 2, isDefault: true }, { name: 'Legacy', version: 1 }])
    );
    try {
      const status = await wslStatus({ stateDir: null });
      assertEquals(Object.keys(status), ['available', 'distros', 'openRequests', 'wsl', 'skipped']);
      assertEquals(status.wsl, { exe: true, problem: '' });
      assertEquals(status.skipped, [{ name: 'Legacy', why: 'it is a WSL1 distro; convert it with `wsl --set-version <name> 2`' }]);
      const distros = status.distros as Json[];
      assertEquals(distros.map((d) => [d.name, d.isDefault]), [['Debian', false], ['Ubuntu', true]]);
      // phase 3 (linking-design section 13) adds `removed`
      assertEquals(Object.keys(distros[1]), ['name', 'key', 'state', 'line', 'home', 'helper', 'problem', 'alwaysAllow', 'isDefault', 'removed']);
      assertEquals(distros[1].removed, false);
      assertEquals([distros[1].state, distros[1].home, distros[1].helper], ['ready', '/home/u', '0.0.0-fake']);

      setDistroSource(() => Promise.resolve([{ name: 'Legacy', version: 1 }]));
      const none = await wslStatus({ stateDir: null });
      assertEquals([none.available, none.wsl], [false, { exe: true, problem: 'No WSL2 distro AIB can use' }]);
      setDistroSource(() => Promise.resolve([]));
      assertEquals((await wslOverview()).problem, 'No WSL distro');
    } finally {
      setDistroSource(null);
      setWslHostResolver(null);
      urlGate.setForTests(null);
    }
  },
});

// ---- 3. Codex detection --------------------------------------------------------------------------------------------------------

/** A global npm prefix (bin/node, lib/node_modules) in `root`, with the Codex adapter `pkg` and the CLI it ships. */
function prefixWithCodex(root: string, pkg: string, entry: string, withCli = true): { node: string; entry: string; cli: string } {
  const node = join(root, 'bin', 'node');
  write(node, '');
  const folder = join(root, 'lib', 'node_modules', ...pkg.split('/'));
  write(join(folder, 'package.json'), JSON.stringify({ name: pkg, version: '2.6.0', bin: { 'codex-acp': entry } }));
  write(join(folder, ...entry.split('/')), '');
  const cli = join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (withCli) write(cli, '');
  return { node, entry: join(folder, ...entry.split('/')), cli };
}

function resetHooks(): void {
  for (const key of Object.keys(adapters.adapterHooks)) delete (adapters.adapterHooks as Record<string, unknown>)[key];
  adapters.resetCache();
}

Deno.test({
  name: 'codex detection: the current package @agentclientprotocol/codex-acp is found as a global install; the old name still wins',
  ...T,
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-link-codex-' });
    try {
      const fresh = prefixWithCodex(join(dir, 'a'), '@agentclientprotocol/codex-acp', 'dist/index.js');
      adapters.adapterHooks.findNode = () => fresh.node;
      adapters.adapterHooks.globalRoots = () => [join(dir, 'a', 'lib', 'node_modules')];
      const row = await adapters.resolveCodex({ onPath: () => '', codexPresent: () => false });
      assertEquals([row.found, row.source, row.argv], [true, 'installed', [fresh.node, fresh.entry]]);
      assertEquals(await findCodexCli(row.argv, { which: () => null }), [fresh.node, fresh.cli]);
      assertEquals(bundledCodexCli(row.argv), [fresh.node, fresh.cli]);

      // both names installed: the old one, as before this change
      const old = prefixWithCodex(join(dir, 'a'), '@zed-industries/codex-acp', 'bin/codex-acp.js');
      const both = await adapters.resolveCodex({ onPath: () => '', codexPresent: () => false });
      assertEquals(both.argv, [fresh.node, old.entry]);
    } finally {
      resetHooks();
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: 'codex detection: an asdf shim on PATH is resolved to [real node, entry] and the bundled CLI is found through it',
  ...T,
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-link-shim-' });
    try {
      // ~/.asdf/shims/{node,codex-acp} (shell scripts, as asdf writes them) and ~/.asdf/installs/nodejs/24.0.0 (the real prefix)
      const shims = join(dir, '.asdf', 'shims');
      const shimNode = join(shims, 'node');
      write(shimNode, '#!/usr/bin/env bash\n# asdf-plugin: nodejs 24.0.0\nexec asdf exec "node" "$@"\n');
      const shim = join(shims, 'codex-acp');
      write(shim, '#!/usr/bin/env bash\n# asdf-plugin: nodejs 24.0.0\nexec asdf exec "codex-acp" "$@"\n');
      const real = prefixWithCodex(join(dir, '.asdf', 'installs', 'nodejs', '24.0.0'), '@agentclientprotocol/codex-acp', 'dist/index.js');
      const asked: string[] = [];
      adapters.adapterHooks.findNode = () => shimNode;
      adapters.adapterHooks.nodeExecPath = (node) => {
        asked.push(node);
        return Promise.resolve(node === shimNode ? real.node : '');
      };
      // the prefix layout next to the node it is asked about (no `npm root -g`, no machine folders)
      adapters.adapterHooks.globalRoots = (node) => node ? [join(node.slice(0, node.lastIndexOf(SEP, node.lastIndexOf(SEP) - 1)), 'lib', 'node_modules')] : [];

      assert(adapters.isVersionManagerShim(shim));
      assert(!adapters.isVersionManagerShim(real.entry), 'a package file is not a shim');
      const argv = await adapters.nodeScriptLaunch(shim, adapters.CODEX_GLOBAL_PACKAGES);
      assertEquals(argv, [real.node, real.entry]);
      assertEquals(asked, [shimNode]);
      assertEquals(bundledCodexCli(argv), [real.node, real.cli], 'findCodexCli can walk to the CLI the adapter ships');
      assertEquals(await findCodexCli([shim], { which: () => '/usr/bin/codex' }), ['/usr/bin/codex'], 'the one-item argv of before could not');

      // an npm bin link (nvm, a prefix install): its target is the entry file itself
      assertEquals(await adapters.nodeScriptLaunch(real.entry, adapters.CODEX_GLOBAL_PACKAGES), [real.node, real.entry]);
      // a script that is not a version manager's, or a shim whose node has no such package: left as it is (null)
      const other = join(dir, 'bin', 'codex-acp');
      write(other, '#!/bin/sh\nexec /opt/codex-acp "$@"\n');
      assertEquals(await adapters.nodeScriptLaunch(other, adapters.CODEX_GLOBAL_PACKAGES), null);
      adapters.adapterHooks.nodeExecPath = () => Promise.resolve('');
      assertEquals(await adapters.nodeScriptLaunch(shim, adapters.CODEX_GLOBAL_PACKAGES), null);

      if (Deno.build.os === 'windows') {
        // Windows never resolves shims: the row of before, byte for byte
        adapters.adapterHooks.globalRoots = () => [];
        const row = await adapters.resolveCodex({ onPath: () => shim });
        assertEquals([row.argv, row.source, row.text], [[shim], 'path', `codex-acp on PATH: ${shim}`]);
      }
    } finally {
      resetHooks();
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test('bundled Claude Code: the SDK platform binary or cli.js inside the adapter tree, nothing outside it', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-link-claude-' });
  try {
    const mods = join(dir, 'lib', 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
    const entry = join(mods, 'dist', 'index.js');
    write(entry, '');
    const argv = ['/usr/bin/node', entry];
    assertEquals(bundledClaudeCli(argv), null, 'no SDK');
    const sdk = join(mods, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    write(join(sdk, 'package.json'), '{}');
    assertEquals(bundledClaudeCli(argv), null, 'an SDK without its program');
    const binary = join(mods, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');
    write(binary, '');
    assertEquals(bundledClaudeCli(argv), binary);
    write(join(sdk, 'cli.js'), '');
    assertEquals(bundledClaudeCli(argv), join(sdk, 'cli.js'));
    assertEquals(bundledClaudeCli([entry]), null, 'a one-item argv has no entry to walk from');
    // an SDK beside the adapter's tree (another global package) is not the adapter's
    const lone = join(dir, 'other', 'index.js');
    write(lone, '');
    assertEquals(bundledClaudeCli(['/usr/bin/node', lone]), null);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: 'agents.detect: bundledCli on the Claude Code and Codex rows (true only when the vendor program was found), signin = the bundled CLI',
  ...T,
  async fn() {
    const root = Deno.makeTempDirSync({ prefix: 'aib-link-detect-' });
    try {
      const version = join(root, 'agents', 'codex', '2.6.0');
      write(join(version, '.complete'));
      const pkg = join(version, 'node_modules', '@agentclientprotocol', 'codex-acp');
      write(join(pkg, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', version: '2.6.0', bin: { 'codex-acp': 'dist/index.js' } }));
      write(join(pkg, 'dist', 'index.js'));
      const cli = join(version, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      write(cli);
      const node = join(root, 'node');
      write(node);
      adapters.adapterHooks.findNode = () => node;
      adapters.adapterHooks.globalRoots = () => [];
      adapters.adapterHooks.codexOnPath = () => '';
      adapters.adapterHooks.codexPresent = () => false;
      const methods = makeMethods({ env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home: root, arch: 'x86_64' }), root });
      const rows = (await methods['agents.detect']({ ids: ['claude', 'codex', 'omp'] }) as { agents: Json[] }).agents;
      const [claude, codex, omp] = rows;
      assertEquals([claude.found, claude.bundledCli], [false, false]);
      assertEquals([codex.found, codex.source, codex.bundledCli, codex.version], [true, 'studio', true, '2.6.0']);
      const signin = codex.signin as string[];
      assertEquals([signin.length, signin[0]], [2, node]);
      assert(signin[1].endsWith(join('agents', 'codex', '2.6.0', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')), signin[1]);
      assert(!('bundledCli' in omp), 'only Claude Code and Codex rows have it');

      Deno.removeSync(cli);
      const again = (await methods['agents.detect']({ ids: ['codex'] }) as { agents: Json[] }).agents[0];
      assertEquals([again.found, again.bundledCli], [true, false], 'no CLI next to the adapter: not bundled');
    } finally {
      resetHooks();
      Deno.removeSync(root, { recursive: true });
    }
  },
});

Deno.test('install hints: every package the WSL picker tells people to install is one AIB detects', () => {
  const detected: Record<string, string[]> = {
    claude: [adapters.CLAUDE_PACKAGE[0]],
    codex: adapters.CODEX_GLOBAL_PACKAGES.map(([name]) => name),
  };
  for (const [id, line] of Object.entries(WSL_INSTALL)) {
    const pkg = line.replace(/^npm i -g /, '');
    assert(detected[id]?.includes(pkg), `${id}: ${pkg} is not looked for`);
  }
  assertEquals(adapters.CODEX_INSTALL, WSL_INSTALL.codex);
});
