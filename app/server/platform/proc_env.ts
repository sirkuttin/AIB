/**
 * Which running processes carry AIB's shell cookie (no-stuck-processes, Slice 0, build step 5; subagents/shell_tag.ts).
 *
 * ONE snapshot of the processes that started at or after `since` (never a walk down from an agent: a process whose parent is gone, or
 * that the keeper's unnamed job holds, is not below anyone), then the AIB_PROC value of each one's environment:
 *   Windows  the PEB (process_info.ts processEnvironment); a process that can't be opened is skipped (untagged, never killed)
 *   Linux    /proc/<pid>/environ, same user only (read through `sh`/`tr`: the compiled WSL helper may not read /proc itself)
 *   other    nothing (no verified way here yet): every process reads as untagged
 * Never throws: null when the processes can't be listed.
 */
import { readTable, refreshDescendants } from './descendants.ts';
import { processEnvironment, processStartTime, processStrings } from './process_info.ts';

export interface Seen {
  pid: number;
  parentPid: number;
  /** Epoch seconds. */
  started: number;
}

export interface Tagged extends Seen {
  /** The process's AIB_PROC value, exactly as read. */
  cookie: string;
}

/** What the processes can be asked (replaceable by tests). */
export interface ProcSource {
  /** Every process that started at or after `since` (epoch seconds) with a known start time, or null when they can't be listed. */
  list(since: number): Seen[] | null;
  /** The AIB_PROC of each pid that has one. */
  cookies(pids: number[]): Map<number, string>;
  /** The current folder of each pid that can be read (absent: this source cannot tell). */
  cwds?(pids: number[]): Map<number, string>;
}

const NAME = 'AIB_PROC';

/** A PATH entry AIB added to a Git Bash command on Windows: `<anything>\aibproc\<cookie>` (allow/aib_prefix.ts BASH_FORM). */
const PATH_MARK = /(?:^|;)[^;]*[\\/]aibproc[\\/]([A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{1,200})(?=;|$)/g;

/**
 * The cookie among "NAME=value" entries, or null. Windows names are case-insensitive, and there an MSYS process (bash, sleep, ...) has
 * only PATH of AIB's tag in its environment block, so the cookie is also read from PATH's marker entry (the last one). When both are
 * there and differ the process is ambiguous and reads as untagged: it is never killed on a guess.
 */
export function cookieIn(entries: string[], windows: boolean = Deno.build.os === 'windows'): string | null {
  let named: string | null = null;
  let marked: string | null = null;
  for (const entry of entries) {
    const at = entry.indexOf('=');
    if (at < 0) continue;
    const name = entry.slice(0, at);
    if (windows ? name.toUpperCase() === NAME : name === NAME) named ??= entry.slice(at + 1);
    else if (windows && name.toUpperCase() === 'PATH') {
      for (const m of entry.slice(at + 1).matchAll(PATH_MARK)) marked = m[1];
    }
  }
  if (named !== null && marked !== null && named !== marked) return null;
  return named ?? marked;
}

function listProcesses(since: number): Seen[] | null {
  refreshDescendants();
  let table: ReturnType<typeof readTable>;
  try {
    table = readTable();
  } catch {
    return null;
  }
  if (!table) return null;
  const out: Seen[] = [];
  for (const row of table.values()) {
    if (row.pid === Deno.pid || row.pid <= 4) continue;
    let started = row.started ?? null;
    if (started === null || started === undefined) {
      if (Deno.build.os !== 'windows') continue;
      try {
        started = processStartTime(row.pid);
      } catch {
        started = null;
      }
    }
    if (started === null || started < since) continue;
    out.push({ pid: row.pid, parentPid: row.parentPid, started });
  }
  return out;
}

function readCookies(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  if (Deno.build.os === 'windows') {
    for (const pid of pids) {
      try {
        const entries = processEnvironment(pid);
        const cookie = entries ? cookieIn(entries) : null;
        if (cookie) out.set(pid, cookie);
      } catch { /* unreadable: untagged */ }
    }
    return out;
  }
  if (Deno.build.os !== 'linux') return out;
  // one shell for all of them: "<pid> <value>" per process that has the variable (same-user processes only: others can't be read)
  const script = 'for p in "$@"; do v=$(tr "\\0" "\\n" < /proc/$p/environ 2>/dev/null | grep -m1 "^' + NAME + '=") && echo "$p ${v#' + NAME + '=}"; done; true';
  try {
    const done = new Deno.Command('sh', { args: ['-c', script, 'sh', ...pids.map(String)], stdin: 'null', stdout: 'piped', stderr: 'null' })
      .outputSync();
    for (const line of new TextDecoder().decode(done.stdout).split('\n')) {
      const at = line.indexOf(' ');
      const pid = Number(line.slice(0, at));
      if (at > 0 && Number.isInteger(pid)) out.set(pid, line.slice(at + 1).trim());
    }
  } catch { /* none readable */ }
  return out;
}

function readCwds(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const pid of pids) {
    try {
      if (Deno.build.os === 'windows') {
        const cwd = processStrings(pid)?.cwd;
        if (cwd) out.set(pid, cwd);
      } else if (Deno.build.os === 'linux') {
        out.set(pid, Deno.readLinkSync(`/proc/${pid}/cwd`));
      }
    } catch { /* unreadable */ }
  }
  return out;
}

export const realProcesses: ProcSource = { list: listProcesses, cookies: readCookies, cwds: readCwds };

/** The processes that started at or after `since` and carry a cookie, from one snapshot; null when the processes can't be listed. */
export function taggedSince(since: number, source: ProcSource = realProcesses): { all: Seen[]; tagged: Tagged[] } | null {
  const all = source.list(since);
  if (!all) return null;
  const cookies = source.cookies(all.map((p) => p.pid));
  return { all, tagged: all.filter((p) => cookies.has(p.pid)).map((p) => ({ ...p, cookie: cookies.get(p.pid)! })) };
}
