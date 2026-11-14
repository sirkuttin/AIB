/**
 * The processes an agent started, still running: what tells AIB that a Claude Code background shell (Bash with run_in_background)
 * still runs. Claude Code sends no update when such a shell ends to a client like AIB (only JetBrains AIR gets that lifecycle), so
 * AIB notes the agent's processes that started with the command and asks the OS whether they still run. Windows: a Toolhelp snapshot
 * (process_info.ts) and each process's creation time. POSIX: `ps -A -o pid=,ppid=,etime=`. One snapshot serves every call for a
 * second (Studio.busyList runs every second and asks each chat). Never throws: null when the processes cannot be listed.
 */
import { processList, processStartTime } from './process_info.ts';

export interface Descendant {
  pid: number;
  /** Epoch seconds the process started, or null when unknown. */
  started: number | null;
  /** Its parent (the root, or another descendant), and how far below the root it is (1: a child of the root). */
  parentPid: number;
  depth: number;
}

interface Row {
  pid: number;
  parentPid: number;
  started: number | null | undefined; // undefined: not read yet (Windows reads it only for an agent's descendants)
}

type Table = Map<number, Row>;

/** Reads the whole process list; replaceable by tests. */
export let readTable: () => Table | null = defaultTable;
let cached: { at: number; table: Table | null } | null = null;
const FRESH_MS = 1000;

/** Tests: read the process list with `reader` (null: the real one) and forget the cached snapshot. */
export function setTableReader(reader: (() => Table | null) | null): void {
  readTable = reader ?? defaultTable;
  cached = null;
}

/** Forget the cached snapshot (the next call reads the process list again). */
export function refreshDescendants(): void {
  cached = null;
}

function table(): Table | null {
  const now = Date.now();
  if (cached && now - cached.at < FRESH_MS) return cached.table;
  let t: Table | null = null;
  try {
    t = readTable();
  } catch {
    t = null;
  }
  cached = { at: now, table: t };
  return t;
}

function defaultTable(): Table | null {
  if (Deno.build.os === 'windows') {
    const t: Table = new Map();
    for (const p of processList()) t.set(p.pid, { pid: p.pid, parentPid: p.parentPid, started: undefined });
    return t;
  }
  const done = new Deno.Command('ps', { args: ['-A', '-o', 'pid=,ppid=,etime='], stdin: 'null', stdout: 'piped', stderr: 'null' })
    .outputSync();
  if (done.code !== 0) return null;
  const now = Date.now() / 1000;
  const t: Table = new Map();
  for (const line of new TextDecoder().decode(done.stdout).split('\n')) {
    const [pid, ppid, etime] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(ppid ?? '')) continue;
    const age = elapsed(etime ?? '');
    t.set(Number(pid), { pid: Number(pid), parentPid: Number(ppid), started: age === null ? null : now - age });
  }
  return t;
}

/** ps's etime, `[[dd-]hh:]mm:ss`, in seconds; null when not that. */
export function elapsed(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** Every process below `root` (not root itself) that runs now, or null when the processes cannot be listed. */
export function descendants(root: number): Descendant[] | null {
  if (!Number.isInteger(root) || root <= 0) return null;
  const t = table();
  if (!t) return null;
  const children = new Map<number, Row[]>();
  for (const row of t.values()) {
    if (row.pid === row.parentPid) continue;
    const list = children.get(row.parentPid);
    if (list) list.push(row);
    else children.set(row.parentPid, [row]);
  }
  const out: Descendant[] = [];
  const seen = new Set<number>([root]);
  const depthOf = new Map<number, number>([[root, 0]]);
  const walk = [root];
  while (walk.length) {
    const parent = walk.pop()!;
    const parentStarted = startOf(t.get(parent));
    const depth = depthOf.get(parent)! + 1;
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.pid)) continue;
      const started = startOf(row);
      // A Windows parent pid can name a process that ended long ago and whose pid was reused: a child older than its parent is not its.
      if (started !== null && parentStarted !== null && started < parentStarted - 1) continue;
      seen.add(row.pid);
      depthOf.set(row.pid, depth);
      out.push({ pid: row.pid, started, parentPid: parent, depth });
      walk.push(row.pid);
    }
  }
  return out;
}

function startOf(row: Row | undefined): number | null {
  if (!row) return null;
  if (row.started === undefined) {
    try {
      row.started = Deno.build.os === 'windows' ? processStartTime(row.pid) : null;
    } catch {
      row.started = null;
    }
  }
  return row.started;
}
