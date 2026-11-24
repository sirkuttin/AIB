/**
 * A FakeWslHost for Track C's WSL tests (docs/wsl/design.md section 10: Track C builds against it until Track B's wsl/hosts.ts lands).
 * It is a real Windows keeper standing in for the distro's Linux keeper: the agent (work/fake_acp.py) and the shells run there, so a
 * test goes through the whole WSL path of AIB, Connection and the terminal sessions (the distro's env, the helper's `which`, the
 * Linux folder as the agent's cwd, the ref as AIB's key, records with `loc`), while the Linux paths AIB hands the keeper are mapped to
 * a temp Windows folder at the very last step (MappedKeeperLink.spawn). Helper calls answer from a small table the test can change.
 * Never a real distro, never the owner's homes: temp folders only.
 */
import { KeeperLink } from '../../app/server/keeper/link.ts';
import type { AibUsage, HelperMethods, WslHost } from '../../app/server/wsl/contract.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import { readKeeperInfo, KeeperClient } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import { type LinkFs, physicalRealish } from '../../app/server/allow/linux.ts';
import { pinHash } from '../../app/server/allow/pin.ts';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

/** A keeper link whose spawns run in a Windows folder standing in for the Linux one. */
export class MappedKeeperLink extends KeeperLink {
  constructor(dataDir: string, readonly map: (linuxPath: string) => string) {
    super({ dataDir, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
  }
  /** Every spawn spec as AIB sent it (before the cwd mapping). */
  readonly spawned: Json[] = [];
  /** Linux programs -> the Windows command line standing in for them (a login shell, a sign-in). */
  readonly programs = new Map<string, { command: string; args: string[] }>();
  override spawn(...args: Parameters<KeeperLink['spawn']>): ReturnType<KeeperLink['spawn']> {
    const [spec, ...rest] = args;
    this.spawned.push(structuredClone(spec) as unknown as Json);
    const program = this.programs.get(spec.command);
    const mapped = { ...spec, cwd: spec.cwd ? this.map(spec.cwd) : spec.cwd, ...(program ? { command: program.command, args: program.args } : {}) };
    return super.spawn(mapped, ...rest);
  }
}

type Handler = (params: Json) => unknown;

/** The fake helper's AIB folder (never a real one: the fake touches no distro). */
export const FAKE_AIB_ROOT = '/home/u/.aib-server';

/** The fake helper's `aib.usage` answer (contract.ts AibUsage). */
export function fakeAibUsage(): AibUsage {
  const root = FAKE_AIB_ROOT, data = `${root}/data-0123456789ab`;
  return {
    root,
    totalBytes: 600,
    current: '0.1.0-0123abcd',
    parts: [
      { key: 'versions', label: 'AIB helper and keeper', bytes: 100, path: root },
      { key: 'agents', label: 'Installed agents', bytes: 200, path: `${root}/agents` },
      { key: 'npmCache', label: 'npm cache', bytes: 50, path: `${root}/agents/.npm-cache` },
      { key: 'data', label: "This AIB's data", bytes: 50, path: data },
      { key: 'worktrees', label: 'Chat copies (worktrees)', bytes: 100, path: `${data}/worktrees` },
      { key: 'logs', label: 'Chat records and logs', bytes: 50, path: `${data}/keeper` },
      { key: 'other', label: 'Other AIB data folders and files', bytes: 50, path: root },
    ],
    versions: ['0.1.0-0123abcd'],
    agents: [{ id: 'claude', versions: ['0.102.0'], bytes: 200 }],
    dataFolders: [{ name: 'data-0123456789ab', mine: true, keeperAlive: true, bytes: 200 }, { name: 'data-ba9876543210', mine: false, keeperAlive: false, bytes: 50 }],
    worktrees: { count: 1, dirty: 0 },
    chatsWorking: 0,
  };
}

export class FakeWslHost implements WslHost {
  readonly distro: string;
  state: WslHost['state'] = 'ready';
  note = '';
  link: MappedKeeperLink;
  /** The distro's "login environment": a few Windows variables the fake agent needs to run, plus Linux-looking ones. */
  readonly loginEnv: Record<string, string>;
  readonly calls: [string, Json][] = [];
  readonly handlers: Partial<Record<keyof HelperMethods, Handler>> = {};
  /** Linux folder -> Windows folder standing in for it. */
  readonly folders = new Map<string, string>();
  #urls = new Set<(url: string) => void>();
  helperVersion: string | null = '0.0.0-fake';
  reconnects = 0;

  constructor(readonly dataDir: string, distro = 'Ubuntu', extraEnv: Record<string, string> = {}) {
    this.distro = distro;
    this.link = this.#newLink();
    const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'LOCALAPPDATA'];
    const env: Record<string, string> = {};
    for (const name of keep) {
      const value = Deno.env.get(name);
      if (value !== undefined) env[name] = value;
    }
    this.loginEnv = { ...env, HOME: '/home/u', SHELL: '/bin/bash', USER: 'u', AIB_FAKE_LINUX_ENV: '1', ...extraEnv };
  }

  #newLink(): MappedKeeperLink {
    return new MappedKeeperLink(this.dataDir, (linux) => this.windowsFor(linux));
  }

  /** A crashed AIB's next process gets a fresh link to the same Linux keeper (with the same program stand-ins). */
  renewLink(): MappedKeeperLink {
    const programs = this.link.programs;
    this.link = this.#newLink();
    for (const [k, v] of programs) this.link.programs.set(k, v);
    return this.link;
  }

  /** The Windows folder for a Linux path (the nearest mapped parent), else the path itself. */
  windowsFor(linux: string): string {
    let best = '';
    for (const key of this.folders.keys()) if ((linux === key || linux.startsWith(key + '/')) && key.length > best.length) best = key;
    if (!best) return linux;
    const rest = linux.slice(best.length).split('/').filter(Boolean);
    return [this.folders.get(best)!, ...rest].join(SEP);
  }

  start(): Promise<void> {
    return this.state === 'ready' ? Promise.resolve() : Promise.reject(new WslHelperError(this.note || 'not ready', 'stopped'));
  }

  reconnect(): Promise<void> {
    this.reconnects++;
    this.state = 'ready';
    this.note = '';
    return Promise.resolve();
  }

  env(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.loginEnv });
  }

  onOpenUrl(handler: (url: string) => void): () => void {
    this.#urls.add(handler);
    return () => this.#urls.delete(handler);
  }

  /** Something in the distro ran the BROWSER shim. */
  openUrl(url: string): void {
    for (const h of [...this.#urls]) h(url);
  }

  /** The helper's MCP tunnel (null: none, the interop entry is used); tests set it. */
  mcpTunnel: { forwarder: string; socket: string } | null = null;
  /** The same tunnel for subagent hooks (null: the helper lacks the subagent.* methods the hooks need). */
  hookTunnel: { forwarder: string; socket: string } | null = null;
  /** The helper of this build (it has subagent.reaps): its keeper knows hook 2, so a subagent's shell calls are tagged. */
  hookShellTag = false;
  #mcp = new Set<(request: { rid: string; headers: Record<string, string>; body: string }) => void>();

  onMcpRequest(handler: (request: { rid: string; headers: Record<string, string>; body: string }) => void): () => void {
    this.#mcp.add(handler);
    return () => this.#mcp.delete(handler);
  }

  /** An agent in the distro sent a tool call through the tunnel (the helper's mcp.request). */
  mcpRequest(request: { rid: string; headers: Record<string, string>; body: string }): void {
    for (const h of [...this.#mcp]) h(request);
  }

  call<M extends keyof HelperMethods>(method: M, params: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']> {
    this.calls.push([method, params as unknown as Json]);
    try {
      const own = this.handlers[method];
      if (own) return Promise.resolve(own(params as unknown as Json) as HelperMethods[M]['result']);
      return Promise.resolve(this.#default(method, params as unknown as Json) as HelperMethods[M]['result']);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #default(method: string, params: Json): unknown {
    if (method === 'env.get') return { env: { ...this.loginEnv }, shell: '/bin/bash', home: '/home/u', arch: 'x86_64' };
    if (method === 'which') {
      const name = String(params.name);
      return { path: name === 'missing' ? null : `/usr/bin/${name}` };
    }
    if (method === 'agents.detect') {
      return {
        agents: ['claude', 'codex'].map((id) =>
          id === 'claude'
            ? { id, found: true, command: ['node', '/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'], version: '1.0.0' }
            : { id, found: false }
        ),
      };
    }
    if (method === 'fs.stat') {
      const win = this.windowsFor(String(params.path));
      let info: Deno.FileInfo | null = null;
      try {
        info = win !== String(params.path) ? Deno.statSync(win) : null;
      } catch { /* missing */ }
      return { exists: !!info, isDir: !!info?.isDirectory, isFile: !!info?.isFile, size: info?.size ?? 0, mtimeMs: info?.mtime?.getTime() ?? 0 };
    }
    if (method === 'allow.facts') return this.#allowFacts(params);
    // Linking (WSL) phase 3: a small AIB folder and a Remove with nothing in the way (tests set handlers for other answers)
    if (method === 'aib.usage') return fakeAibUsage();
    if (method === 'aib.remove') {
      const apply = params.mode === 'apply';
      const data = `${FAKE_AIB_ROOT}/data-0123456789ab`;
      return {
        ok: true,
        mode: params.mode,
        blocked: [],
        wouldRemove: [{ path: data, what: "this AIB's data folder", bytes: 4096 }],
        kept: [{ path: '/home/u/.claude', why: "Claude Code's own settings and sign-in: AIB never touches them" }],
        removed: apply ? [`${data}/studio-worktrees.json`] : [],
        left: [],
        ...(apply ? { final: { data: 'data-0123456789ab', version: null, root: false, copies: [] } } : {}),
      };
    }
    throw new WslHelperError(`the fake helper has no ${method}`, 'no_method');
  }

  /** `allow.facts`' Claude settings facts (null: unreadable) and PATH folders; tests change them. */
  claudeFacts: { askPrograms: string[]; askTools: string[]; riskyEnv: string } | null = { askPrograms: [], askTools: [], riskyEnv: '' };
  pathDirs: { dir: string; real: string | null }[] = [{ dir: '/usr/local/bin', real: '/usr/local/bin' }, { dir: '/usr/bin', real: '/usr/bin' }];

  /** A Linux path the mapped folders stand in for: a parent of a mapped folder is a folder too. */
  #mapped(linux: string): { win: string | null; virtualDir: boolean } {
    const win = this.windowsFor(linux);
    if (win !== linux) return { win, virtualDir: false };
    const isParent = [...this.folders.keys()].some((k) => k.startsWith(linux === '/' ? '/' : linux + '/'));
    return { win: null, virtualDir: isParent || linux === '/' };
  }

  /** A Windows path back as the Linux path of the mapped folder that holds it, else as a path outside every project. */
  #linuxFor(win: string): string {
    const fold = (p: string) => p.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
    let best: [string, string] | null = null;
    for (const [linux, w] of this.folders) {
      let real = w;
      try {
        real = Deno.realPathSync(w);
      } catch { /* missing */ }
      const f = fold(real);
      if ((fold(win) === f || fold(win).startsWith(f + '\\')) && (!best || f.length > fold(best[1]).length)) best = [linux, real];
    }
    if (!best) return '/mnt/outside/' + win.replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter(Boolean).join('/');
    const rest = win.slice(best[1].replace(/[\\/]+$/, '').length).split(/[\\/]+/).filter(Boolean);
    return [best[0] === '/' ? '' : best[0], ...rest].join('/') || '/';
  }

  /** The fake helper's allow.facts: Linux paths resolved over the mapped Windows folders (helper/allow_facts.ts semantics). */
  #allowFacts(params: Json): unknown {
    const fs: LinkFs = {
      lstat: (linux) => {
        const m = this.#mapped(linux);
        if (!m.win) return m.virtualDir ? { link: false } : 'missing';
        try {
          return { link: Deno.lstatSync(m.win).isSymlink };
        } catch (error) {
          return error instanceof Deno.errors.NotFound ? 'missing' : 'error';
        }
      },
      realpath: (linux) => {
        const m = this.#mapped(linux);
        if (!m.win) return m.virtualDir ? linux : null;
        try {
          return this.#linuxFor(Deno.realPathSync(m.win));
        } catch {
          return null;
        }
      },
    };
    const stat = (linux: string) => {
      const m = this.#mapped(linux);
      if (!m.win) return { exists: m.virtualDir, isDir: m.virtualDir };
      try {
        const st = Deno.statSync(m.win);
        return { exists: true, isDir: st.isDirectory };
      } catch {
        return { exists: false, isDir: false };
      }
    };
    const paths = (params.paths as string[] | undefined ?? []).map((p) => ({ real: physicalRealish(p, fs), ...stat(p) }));
    const scans = (params.scans as string[] | undefined ?? []).map((d) => {
      const m = this.#mapped(d);
      if (!m.win) return !m.virtualDir;
      try {
        return [...Deno.readDirSync(m.win)].some((e) => e.isSymlink);
      } catch {
        return true;
      }
    });
    const pins = (params.pins as { words: string[]; cwd: string }[] | undefined ?? []).map((x) => pinHash(x.words, this.windowsFor(x.cwd)));
    const base = params.base ? { pathDirs: this.pathDirs, own: [FAKE_AIB_ROOT], claude: this.claudeFacts } : undefined;
    return { paths, scans, pins, ...(base ? { base } : {}) };
  }

  /** Stop the keeper this fake's links started (tests clean up). */
  async stopKeeper(): Promise<void> {
    this.link.disconnect();
    const info = readKeeperInfo(this.dataDir);
    if (info && pidAlive(info.pid)) {
      try {
        const client = await KeeperClient.connect(info);
        await client.shutdown(true).catch(() => {});
        client.close();
      } catch { /* gone */ }
      for (let i = 0; i < 100 && pidAlive(info.pid); i++) await new Promise((r) => setTimeout(r, 50));
      if (pidAlive(info.pid)) Deno.kill(info.pid, 'SIGKILL');
    }
  }
}
