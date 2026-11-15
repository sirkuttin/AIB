/**
 * Background tasks and the ownership check of WSL chats, run natively in the distro (docs/WSL.md "Background tasks and ownership").
 * The agents' transcripts, their task output and their processes are all inside the distro, so the modules AIB runs for a Windows
 * chat run here unchanged over Linux paths and the distro's /proc:
 *
 * - `transcripts.query`: transcripts/monitor.ts handleGet ('/api/agents', '/api/commands') and commandList + commandOutput
 *   ('/api/command') over the same Store as `transcripts.sessions` (methods.ts sessionStore).
 * - `ownership.check`, `ownership.hints`: ownership/probe.ts OwnershipProbe (transcript freshness, agent processes in the project folder,
 *   who holds the transcript open) and ownership.ts findExternalOwner (a `claude` or `omp` process whose command line names the session).
 *   Its process list is probe.ts fetchProcesses (/proc), with each process named the way the agent was started (see agentNamed). AIB's
 *   own agent channels in this distro (the pids AIB passes as `exclude`) and this helper's own process tree never count. There is no
 *   owner registry here: AIB adds its Windows one.
 * - `proc.tree`: platform/descendants.ts (`ps`) below the agents' pids, for the busy-children detection (wsl/procs.ts on Windows).
 *
 * Everything is read-only: nothing here signals, writes to or kills a process, and the only files read are the session's transcripts,
 * Claude Code's own task output files and /proc.
 */
import * as osp from '../../platform/ospath.ts';
import { commandList, commandOutput, handleGet } from '../../transcripts/monitor.ts';
import type { Store } from '../../transcripts/store.ts';
import { fetchProcesses, OwnershipProbe, type ProcInfo, ProcessSource } from '../../ownership/probe.ts';
import { findExternalOwner } from '../../ownership/ownership.ts';
import { descendants, refreshDescendants } from '../../platform/descendants.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';
import { ValueError } from '../../core/py.ts';

type Env = { env: Record<string, string>; home: string };
const QUERY_PATHS = new Set(['/api/agents', '/api/commands', '/api/command']);
const QUERY_ARGS = ['running', 'id'];
const AGENT_NAMES = ['claude', 'omp'];
const MAX_EXCLUDE = 500, MAX_ROOTS = 64;

/**
 * The name the probe classifies a process by. probe.ts names a Linux process by its /proc/<pid>/exe, which for Claude Code is `node`
 * (the npm install) or a version file (`~/.local/share/claude/versions/2.1.3`, the native install), so the command `claude` the user
 * started is found in its comm (the name it was started as, also what Node's process.title sets) or its argv[0] instead.
 */
export function agentNamed(proc: ProcInfo, comm: (pid: number) => string = readComm): ProcInfo {
  const candidates = [proc.name, comm(proc.pid), base(String(proc.cmdline ?? '').split(' ')[0] ?? '')].map((n) => n.toLowerCase());
  const agent = candidates.find((n) => AGENT_NAMES.includes(n));
  return agent && agent !== proc.name ? { ...proc, name: agent } : proc;
}

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function readComm(pid: number): string {
  try {
    return Deno.readTextFileSync(`/proc/${pid}/comm`).trim();
  } catch {
    return '';
  }
}

/** The distro's processes as the ownership probe reads them (probe.ts fetchProcesses over /proc), named by agentNamed. */
export function distroProcesses(): ProcInfo[] {
  return fetchProcesses().map((p) => agentNamed(p));
}

/** [[pid, name]] of the processes that have `path` open (their /proc/<pid>/fd links), or null when /proc cannot be read. */
export function openHolders(path: string): [number, string][] | null {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync('/proc')];
  } catch {
    return null;
  }
  const out: [number, string][] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    let fds: Deno.DirEntry[];
    try {
      fds = [...Deno.readDirSync(`/proc/${entry.name}/fd`)];
    } catch {
      continue; // another user's process, or it ended
    }
    for (const fd of fds) {
      let target = '';
      try {
        target = Deno.readLinkSync(`/proc/${entry.name}/fd/${fd.name}`);
      } catch {
        continue;
      }
      if (target === path) {
        out.push([Number(entry.name), readComm(Number(entry.name)) || 'a process']);
        break;
      }
    }
  }
  return out;
}

function pidList(params: Record<string, unknown>, key: string, max: number): number[] {
  const value = params[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((p) => !Number.isInteger(p) || p <= 0)) {
    throw new RpcError(`${key} must be a list of process ids`, BAD_PARAMS);
  }
  return value as number[];
}

function claudeProjects(login: Env, asked: string): string {
  if (asked && (!osp.isabs(asked) || asked.length > 4096)) throw new RpcError('claudeDir must be an absolute path', BAD_PARAMS);
  const dir = asked || login.env.CLAUDE_CONFIG_DIR || osp.join(login.home || login.env.HOME || '/', '.claude');
  return osp.join(osp.normpath(dir), 'projects');
}

export interface BgtaskContext {
  env(): Promise<Env>;
  /** The transcripts Store of a call's provider and claudeDir (methods.ts sessionStore); null for Codex (no saved list). */
  store(params: Record<string, unknown>): Promise<Store | null>;
  /** Tests: the process list and the open-file check (default: /proc). */
  processes?: () => ProcInfo[];
  holders?: (path: string) => [number, string][] | null;
}

export function bgtaskMethods(ctx: BgtaskContext): Handlers {
  /** One probe per Claude projects folder, kept for the helper's life (its transcript bookkeeping says how much a file grew). */
  const probes = new Map<string, OwnershipProbe>();
  const probeFor = (root: string): OwnershipProbe => {
    let probe = probes.get(root);
    if (!probe) {
      probe = new OwnershipProbe({
        claudeRoot: root,
        registry: null,
        processes: new ProcessSource(ctx.processes ?? distroProcesses),
        lockProbe: ctx.holders ?? openHolders,
      });
      probes.set(root, probe);
    }
    return probe;
  };

  return {
    'transcripts.query': async (p) => {
      const path = str(p, 'path');
      if (!QUERY_PATHS.has(path)) throw new RpcError('path must be /api/agents, /api/commands or /api/command', BAD_PARAMS);
      const key = str(p, 'key');
      const store = await ctx.store(p);
      if (!store) return path === '/api/agents' ? { status: 200, body: { agents: [], now: Date.now() / 1000 } } : { status: 200, body: { commands: [], running: 0, total: 0 } };
      const given = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args as Record<string, unknown> : {};
      const asked = str(p, 'tempDir', true);
      if (asked && !osp.isabs(asked)) throw new RpcError('tempDir must be an absolute path', BAD_PARAMS);
      if (path !== '/api/command') {
        const args = new URLSearchParams({ session: key });
        for (const name of QUERY_ARGS) if (typeof given[name] === 'string') args.set(name, given[name] as string);
        const reply = await handleGet(store, path, args.toString());
        return { status: reply.status, body: reply.body };
      }
      try {
        const task = (await commandList(store, key)).find((t) => t.id === given.id);
        if (task === undefined) throw new ValueError('Unknown background command');
        // Claude Code on Linux keeps a session's task output in $TMPDIR/claude-<uid>/<project folder>/<session>/tasks/<id>.output
        const login = await ctx.env();
        const tmp = asked || login.env.TMPDIR || '/tmp';
        const uid = Deno.uid();
        const folders = asked ? ['claude'] : [...(uid !== null ? [`claude-${uid}`] : []), 'claude'];
        return { status: 200, body: { ...task, output: await commandOutput(`claude/${key}`, task, tmp, folders) } };
      } catch (error) {
        if (error instanceof ValueError || error instanceof Deno.errors.NotFound || error instanceof Deno.errors.PermissionDenied) {
          return { status: 400, body: { error: (error as Error).message } };
        }
        throw error;
      }
    },

    'ownership.check': async (p) => {
      const provider = str(p, 'provider'), sessionId = str(p, 'sessionId');
      if (!/^[a-z0-9_-]{1,32}$/.test(provider) || !sessionId || sessionId.length > 512) throw new RpcError('provider and sessionId are needed', BAD_PARAMS);
      const exclude = pidList(p, 'exclude', MAX_EXCLUDE);
      const probe = probeFor(claudeProjects(await ctx.env(), str(p, 'claudeDir', true)));
      const ago = p.releasedAgo;
      if (typeof ago === 'number' && Number.isFinite(ago) && ago >= 0) {
        // AIB released the conversation `ago` seconds ago: its own transcript writes until then are not another app's
        const clock = probe.clock;
        probe.clock = () => clock() - ago;
        probe.noteReleased(provider, sessionId);
        probe.clock = clock;
      }
      probe.ownPids = () => exclude;
      // the strong check (Studio.#cmdlineOwner on Windows): a claude/omp process whose command line names this exact session
      const [snapshot] = probe.processes.get(0);
      let owner: number | null = null;
      if (snapshot) {
        const own = probe.ownProcessIds(snapshot);
        const rows = snapshot.filter((x) => x.cmdline).map((x) => ({ pid: x.pid, name: x.name, commandline: x.cmdline }));
        owner = findExternalOwner(rows, provider, sessionId, own);
      }
      const cwd = str(p, 'cwd', true), projectRoot = str(p, 'projectRoot', true);
      const assessment = probe.assess(provider, sessionId, { cwd: cwd || null, projectRoot: projectRoot || null, skipCmdline: true, fresh: false });
      return { owner, assessment: { ...assessment } };
    },

    'ownership.hints': async (p) => {
      const exclude = pidList(p, 'exclude', MAX_EXCLUDE);
      const probe = probeFor(claudeProjects(await ctx.env(), str(p, 'claudeDir', true)));
      probe.ownPids = () => exclude;
      probe.processes.get(); // hints() reads only a cached snapshot: take one when the last is older than its few seconds
      return { hints: probe.hints(), certainty: probe.listCertainty() };
    },

    'proc.tree': (p) => {
      const roots = pidList(p, 'roots', MAX_ROOTS);
      refreshDescendants();
      const now = Date.now() / 1000;
      const trees: Record<string, [number, number, number, number | null][] | null> = {};
      for (const root of roots) {
        const found = descendants(root);
        trees[String(root)] = found
          ? found.map((d) => [d.pid, d.parentPid, d.depth, d.started === null ? null : Math.max(0, Math.round(now - d.started))])
          : null;
      }
      return { trees };
    },
  };
}
