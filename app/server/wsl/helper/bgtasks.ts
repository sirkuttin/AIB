/**
 * Background tasks and the ownership check of WSL chats, run natively in the distro (docs/WSL.md "Background tasks and ownership").
 * The agents' transcripts, their task output and their processes are all inside the distro, so the modules AIB runs for a Windows
 * chat run here unchanged over Linux paths and the distro's /proc:
 *
 * - `transcripts.query`: transcripts/monitor.ts handleGet ('/api/agents', '/api/commands') and commandList + commandOutput
 *   ('/api/command') over the same Store as `transcripts.sessions` (methods.ts sessionStore).
 * - `ownership.check`, `ownership.hints`: ownership/probe.ts OwnershipProbe (transcript freshness, agent processes in the project folder,
 *   who holds the transcript open) and ownership.ts findExternalOwner (a `claude` or `omp` process whose command line names the session).
 *   The assessment carries `transcriptQuiet`, so AIB applies the same folder-only rule as for a Windows chat (probe.ts folderOnlyEvidence).
 *   Its process list is probe.ts fetchProcesses (/proc), with each process named the way the agent was started (see agentNamed). AIB's
 *   own agent channels in this distro (the pids AIB passes as `exclude`) and this helper's own process tree never count. There is no
 *   owner registry here: AIB adds its Windows one.
 * - `proc.tree`: platform/descendants.ts (/proc, read by `cat`) below the agents' pids, for the busy-children detection (wsl/procs.ts on Windows).
 * - `proc.stop`: platform/kill_verified.ts, Stop on a background row: only processes AIB was shown by `proc.tree` (pid and age),
 *   re-verified below the same agent with the same start time, and what they started since.
 *
 * Everything else is read-only: nothing but `proc.stop` signals or kills a process, nothing writes, and the only files read are the
 * session's transcripts, Claude Code's own task output files and /proc.
 */
import * as osp from '../../platform/ospath.ts';
import { commandList, commandOutput, handleGet } from '../../transcripts/monitor.ts';
import type { Store } from '../../transcripts/store.ts';
import { fetchProcesses, fetchProcessesPs, OwnershipProbe, ProcessSource, type ProcInfo } from '../../ownership/probe.ts';
import { findExternalOwner } from '../../ownership/ownership.ts';
import { holderOf, readRecords } from '../../ownership/claude_sessions.ts';
import { cliHolder, isThreadId, procLocksHolder, writerLockPath } from '../../ownership/codex_threads.ts';
import { appServers, ownClosure, parsePsTable } from '../../ownership/codex_apps.ts';
import { descendants, refreshDescendants } from '../../platform/descendants.ts';
import { type Killer, killVerified } from '../../platform/kill_verified.ts';
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

/** A fixed shell script run without a shell string (its inputs are "$@"); stdout, or null when it could not run. */
function sh(script: string, args: string[]): string | null {
  try {
    const done = new Deno.Command('/bin/sh', { args: ['-c', script, 'sh', ...args], stdin: 'null', stdout: 'piped', stderr: 'null' })
      .outputSync();
    return new TextDecoder().decode(done.stdout);
  } catch {
    return null;
  }
}

/**
 * The distro's processes as the ownership probe reads them, named by agentNamed. The compiled helper may not read /proc itself (Deno
 * wants --allow-all for /proc, and the helper is built without it: tools/build.ts helperCompileArgs), so this is probe.ts's `ps`
 * reader (fetchProcessesPs: names, and the command lines of agent-like programs) plus, for those, their folder from
 * /proc/<pid>/cwd read by `readlink` (one shell for all). In an unrestricted process (tests, `deno run -A`) /proc is read directly.
 */
export function distroProcesses(): ProcInfo[] {
  let procs: ProcInfo[];
  try {
    procs = fetchProcesses();
  } catch {
    procs = fetchProcessesPs();
    const wanted = procs.filter((p) => p.cmdline).map((p) => String(p.pid)).slice(0, 2000);
    const out = wanted.length ? sh('for p; do printf "%s\\t%s\\n" "$p" "$(readlink "/proc/$p/cwd" 2>/dev/null)"; done', wanted) : '';
    const cwd = new Map(
      (out ?? '').split('\n').map((l) => l.split('\t')).filter((x) => x.length === 2 && x[1]).map(([p, c]) => [Number(p), c]),
    );
    procs = procs.map((p) => (cwd.has(p.pid) ? { ...p, cwd: cwd.get(p.pid)! } : p));
  }
  return procs.map((p) => agentNamed(p));
}

/** `path` as a find(1) -lname pattern: the glob characters escaped. */
function globLiteral(path: string): string {
  return path.replace(/[\\*?[\]]/g, (c) => '\\' + c);
}

/**
 * [[pid, name]] of the processes of this user that have `path` open (a /proc/<pid>/fd link to it), or null when that cannot be read.
 * One `find` over /proc (see distroProcesses for why not Deno's own reads).
 */
export function openHolders(path: string): [number, string][] | null {
  const out = sh(
    'find /proc/[0-9]*/fd -maxdepth 1 -lname "$1" 2>/dev/null | while read -r f; do p=${f#/proc/}; p=${p%%/*}; printf "%s\\t%s\\n" "$p" "$(cat "/proc/$p/comm" 2>/dev/null)"; done',
    [globLiteral(path)],
  );
  if (out === null) return null;
  const seen = new Map<number, string>();
  for (const line of out.split('\n')) {
    const [pid, name] = line.split('\t');
    if (/^\d+$/.test(pid ?? '') && !seen.has(Number(pid))) seen.set(Number(pid), (name ?? '').trim() || 'a process');
  }
  return [...seen];
}

/** `ps` of the whole distro with each process's start time and full command line (C locale: lstart is English); null when it cannot run. */
export const PS_SCRIPT = 'LC_ALL=C ps -eww -o pid=,ppid=,lstart=,args=';
export function psText(): string | null {
  return sh(PS_SCRIPT, []);
}

/** The lock files' inodes ("inode<TAB>path"), a marker line, then /proc/locks. Its arguments are the lock files' paths. */
export const LOCK_SCRIPT =
  'for f; do printf "%s\\t%s\\n" "$(stat -c %i "$f" 2>/dev/null)" "$f"; done; echo @@@@; cat /proc/locks 2>/dev/null';

/** The inodes of the threads' writer lock files that exist, and /proc/locks (read by cat: the compiled helper may not read /proc). */
export function lockText(home: string, ids: string[]): { inodes: Map<string, number>; text: string } {
  const files = ids.map((id) => writerLockPath(home, id));
  return parseLockOutput(sh(LOCK_SCRIPT, files) ?? '', files, ids);
}

/** LOCK_SCRIPT's output for `files` (the lock files of `ids`, in order). */
export function parseLockOutput(out: string, files: string[], ids: string[]): { inodes: Map<string, number>; text: string } {
  const [head, ...rest] = out.split('@@@@\n');
  const inodes = new Map<string, number>();
  for (const line of head.split('\n')) {
    const [inode, path] = line.split('\t');
    const i = files.indexOf(path ?? '');
    if (i >= 0 && /^\d+$/.test(inode ?? '')) inodes.set(ids[i], Number(inode));
  }
  return { inodes, text: rest.join('@@@@\n') };
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
  /** Tests: `ps` text and the lock files' inodes with /proc/locks of `codex.scan` (default: run in the distro). */
  psText?: () => string | null;
  lockText?: (home: string, ids: string[]) => { inodes: Map<string, number>; text: string };
  /** Tests: the kill of one verified process in `proc.stop` (default: TERM, then KILL after 2 s). */
  killer?: Killer;
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
      if (!store) {
        return path === '/api/agents'
          ? { status: 200, body: { agents: [], now: Date.now() / 1000 } }
          : { status: 200, body: { commands: [], running: 0, total: 0 } };
      }
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
      if (!/^[a-z0-9_-]{1,32}$/.test(provider) || !sessionId || sessionId.length > 512) {
        throw new RpcError('provider and sessionId are needed', BAD_PARAMS);
      }
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
      // the strong check (Aib.#cmdlineOwner on Windows): a claude/omp process whose command line names this exact session
      const [snapshot] = probe.processes.get(0);
      let owner: number | null = null;
      if (snapshot) {
        const own = probe.ownProcessIds(snapshot);
        const rows = snapshot.filter((x) => x.cmdline).map((x) => ({ pid: x.pid, name: x.name, commandline: x.cmdline }));
        owner = findExternalOwner(rows, provider, sessionId, own);
      }
      const cwd = str(p, 'cwd', true), projectRoot = str(p, 'projectRoot', true);
      const assessment = probe.assess(provider, sessionId, {
        cwd: cwd || null,
        projectRoot: projectRoot || null,
        skipCmdline: true,
        fresh: false,
      });
      return { owner, assessment: { ...assessment } };
    },

    // open elsewhere (ownership/handoff.ts): which of these sessions a live Claude Code process here holds that is not AIB's own
    // (`exclude` and everything below them, this helper's tree), from Claude Code's session registry (<claude dir>/sessions/<pid>.json)
    'sessions.held': async (p) => {
      const ids = Array.isArray(p.sessionIds)
        ? p.sessionIds.filter((s): s is string => typeof s === 'string' && s.length <= 200).slice(0, 200)
        : [];
      if (!ids.length) return { held: {} };
      const exclude = pidList(p, 'exclude', MAX_EXCLUDE);
      const projects = claudeProjects(await ctx.env(), str(p, 'claudeDir', true));
      const probe = probeFor(projects);
      probe.ownPids = () => exclude;
      const [snapshot] = probe.processes.get(0);
      if (!snapshot) return { held: {} }; // liveness cannot be told: no evidence
      const running = new Set(snapshot.map((x) => x.pid));
      const own = probe.ownProcessIds(snapshot);
      const records = readRecords(osp.dirname(projects)).filter((r) =>
        running.has(r.pid) && (!r.pidDomain || r.pidDomain.startsWith('linux:'))
      );
      const held: Record<string, { pid: number; entrypoint: string; status: string }> = {};
      for (const sid of ids) {
        const h = holderOf(records, sid, own);
        if (h) held[sid] = { pid: h.pid, entrypoint: h.entrypoint, status: h.status };
      }
      return { held };
    },

    // open elsewhere for Codex chats (ownership/handoff.ts): a Codex CLI naming each thread, each thread's writer lock, and who
    // started the `codex app-server` processes here; AIB's own agents (`exclude` and everything below, this helper) never count
    'codex.scan': async (p) => {
      const ids = Array.isArray(p.sessionIds) ? p.sessionIds.filter((s): s is string => isThreadId(s)).slice(0, 200) : [];
      const exclude = pidList(p, 'exclude', MAX_EXCLUDE);
      const asked = str(p, 'codexHome', true);
      if (asked && (!osp.isabs(asked) || asked.length > 4096)) throw new RpcError('codexHome must be an absolute path', BAD_PARAMS);
      const login = await ctx.env();
      const home = asked || login.env.CODEX_HOME || osp.join(login.home || login.env.HOME || '/', '.codex');
      const text = (ctx.psText ?? psText)();
      if (text === null) return { cli: {}, locked: {}, appServers: [] }; // the processes cannot be listed: no evidence
      const rows = parsePsTable(text);
      const own = ownClosure(rows, [...exclude, Deno.pid]);
      const cli: Record<string, { pid: number }> = {};
      for (const id of ids) {
        const holder = cliHolder(rows, id, own);
        if (holder) cli[id] = { pid: holder.pid };
      }
      const locked: Record<string, { pid: number }> = {};
      const locks = (ctx.lockText ?? lockText)(home, ids);
      for (const id of ids) {
        const inode = locks.inodes.get(id);
        const pid = inode ? procLocksHolder(locks.text, inode) : 0;
        if (pid && !own.has(pid)) locked[id] = { pid };
      }
      return { cli, locked, appServers: appServers(rows, own).map((s) => ({ pid: s.pid, start: s.start, kind: s.kind, app: s.app })) };
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
      const found = roots.map((root) => descendants(root)); // one process list, read now
      const now = Date.now() / 1000; // after it: an age is never short (a start time never later than the real one)
      // ages to a hundredth of a second (/proc's start times): a process started just before a turn must not look newer than it
      const age = (d: { started: number | null }) => d.started === null ? null : Math.max(0, Math.ceil((now - d.started) * 100) / 100);
      const trees: Record<string, [number, number, number, number | null][] | null> = {};
      roots.forEach((root, i) => {
        trees[String(root)] = found[i]?.map((d) => [d.pid, d.parentPid, d.depth, age(d)]) ?? null;
      });
      return { trees };
    },

    'proc.stop': async (p) => {
      const root = p.root, targets = p.targets;
      if (!Number.isInteger(root) || (root as number) <= 1 || root === Deno.pid) {
        throw new RpcError('root must be an agent process id', BAD_PARAMS);
      }
      const valid = (t: unknown) =>
        Array.isArray(t) && t.length === 2 && Number.isInteger(t[0]) && t[0] > 1 && Number.isFinite(t[1]) && t[1] >= 0;
      if (!Array.isArray(targets) || !targets.length || targets.length > MAX_ROOTS || !targets.every(valid)) {
        throw new RpcError('targets must be a list of [pid, age]', BAD_PARAMS);
      }
      // ages to this clock's start times: killVerified checks each against `ps` here, so AIB's Windows clock never enters it
      const now = Date.now() / 1000;
      const result = await killVerified(
        root as number,
        (targets as [number, number][]).map(([pid, age]) => ({ pid, started: now - age })),
        ctx.killer,
      );
      if (!result) return { listed: false, killed: [], skipped: [] };
      const at = Date.now() / 1000;
      return { listed: true, killed: result.killed.map((k) => [k.pid, Math.max(0, at - k.started)]), skipped: result.skipped };
    },
  };
}
