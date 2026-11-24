/**
 * Shut down what a finished subagent left running (no-stuck-processes, Slice 0, build steps 5 and 6; architect review S0-M4, M5).
 *
 * Every shell call a subagent made carried AIB_PROC=<chat>.<owner>.<call> (shell_tag.ts). When the subagent ends, ONE snapshot of the
 * processes that started after it began is read (proc_env.ts), and a process is killed only when ALL of this holds:
 *   - its AIB_PROC parses to exactly AIB's shape, and its chat and owner (and call, for one stopped call) EQUAL the request's;
 *   - it started at or after the call that tagged it (a PowerShell session reused across calls, or a process that was there before
 *     the call, can carry a cookie it did not earn), and after the request's `since`;
 *   - just before the kill it is still the same process: same pid, same start time, same cookie (a reused pid fails this).
 * What the matched processes started goes with them (their descendants in the snapshot, leaf first), and up to three passes run so a
 * process that spawned while the first was being killed goes too. A process without the exact cookie is never touched.
 */
import { COOKIE_SHAPE } from '../allow/aib_prefix.ts';
import { isDict } from '../core/py.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { killProcesses, type ProcId, START_SLACK } from '../platform/kill_verified.ts';
import { type ProcSource, realProcesses, type Seen, taggedSince } from '../platform/proc_env.ts';
import { parseCookie } from './shell_tag.ts';

export interface ReapRequest {
  chat: string;
  /** The subagent's id: only its processes. Absent: a call-only request (a stopped background call). */
  owner?: string;
  /** One call's processes only. */
  call?: string;
  /** Epoch seconds: nothing older than this is looked at. */
  since: number;
  /** When AIB tagged a call (epoch seconds), if it knows: a process older than its call is not that call's. */
  callTime?: (call: string) => number | undefined;
}

export interface ReapResult {
  /** Processes a kill was sent to (the tagged ones and what they started). */
  killed: number;
  /** The calls (tool_use_ids) whose processes were killed. */
  calls: string[];
}

const MAX_PASSES = 3;

export class ProcessReaper {
  constructor(
    private readonly source: ProcSource = realProcesses,
    private readonly kill: typeof killProcesses = killProcesses,
    private readonly slack: number = START_SLACK,
    private readonly settleMs = 250,
  ) {}

  async reap(req: ReapRequest): Promise<ReapResult> {
    const killedPids = new Set<number>();
    const calls = new Set<string>();
    if (!req.owner && !req.call) return { killed: 0, calls: [] }; // never "everything of the chat"
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const found = taggedSince(Math.max(0, req.since - this.slack), this.source);
      if (!found) break;
      const matched = found.tagged.filter((p) => this.#mine(p.cookie, p.started, req) && !killedPids.has(p.pid));
      if (!matched.length) break;
      // the checks again, just before the kill: the same process (pid and start time) with the same cookie
      const again = this.source.cookies(matched.map((p) => p.pid));
      const live = new Map(this.source.list(0)?.map((p) => [p.pid, p]) ?? []);
      const same = (p: { pid: number; started: number }) => {
        const now = live.get(p.pid);
        return !!now && Math.abs(now.started - p.started) <= this.slack;
      };
      const sure = matched.filter((p) => same(p) && again.get(p.pid) === p.cookie);
      if (!sure.length) break;
      const plan = this.#withDescendants(sure, found.all);
      for (const p of sure) {
        const parsed = parseCookie(p.cookie);
        if (parsed) calls.add(parsed.call);
      }
      const done = await this.kill(plan.map((p): ProcId => ({ pid: p.pid, started: p.started })), (t) => {
        const fresh = this.source.list(0)?.find((p) => p.pid === t.pid);
        return !!fresh && Math.abs(fresh.started - t.started) <= this.slack;
      });
      for (const t of done) killedPids.add(t.pid);
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    }
    return { killed: killedPids.size, calls: [...calls] };
  }

  #mine(cookie: string, started: number, req: ReapRequest): boolean {
    if (!COOKIE_SHAPE.test(cookie)) return false;
    const c = parseCookie(cookie);
    if (!c || c.chat !== req.chat) return false;
    if (req.owner && c.owner !== req.owner) return false;
    if (req.call && c.call !== req.call) return false;
    const tagged = req.callTime?.(c.call);
    return started >= (tagged ?? req.since) - this.slack;
  }

  /** The matched processes and everything below them in the snapshot (a child no older than its parent), deepest first. */
  #withDescendants(roots: Seen[], all: Seen[]): Seen[] {
    const children = new Map<number, Seen[]>();
    for (const p of all) {
      const list = children.get(p.parentPid);
      if (list) list.push(p);
      else children.set(p.parentPid, [p]);
    }
    const depth = new Map<number, number>();
    const byPid = new Map<number, Seen>();
    const walk: Seen[] = [];
    for (const r of roots) {
      depth.set(r.pid, 0);
      byPid.set(r.pid, r);
      walk.push(r);
    }
    while (walk.length) {
      const parent = walk.pop()!;
      for (const child of children.get(parent.pid) ?? []) {
        if (byPid.has(child.pid) || child.pid === parent.pid || child.started < parent.started - this.slack) continue;
        byPid.set(child.pid, child);
        depth.set(child.pid, depth.get(parent.pid)! + 1);
        walk.push(child);
      }
    }
    return [...byPid.values()].sort((a, b) => depth.get(b.pid)! - depth.get(a.pid)!);
  }
}

// ---- which calls' processes AIB shut down (the grey Activity rows) ----------------------------------------------------------------

const REAPED_FILE = 'subagent-reaped.json';
const REAPED_KEEP = 2000;

/** Remember that the processes of these calls (tool_use_ids) were shut down, and why ("subagent finished"). */
export function recordReaped(stateDir: string, calls: string[], why: string, at: number = Date.now() / 1000): void {
  if (!calls.length) return;
  const all = readReaped(stateDir);
  for (const call of calls) all[call] = { at, why };
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, REAPED_KEEP);
  saveJson(pathOf(stateDir, REAPED_FILE), { version: 1, calls: Object.fromEntries(keep) }, '.subagent-reaped-');
}

function readReaped(stateDir: string): Record<string, { at: number; why: string }> {
  try {
    const [status, raw] = readJsonFile(pathOf(stateDir, REAPED_FILE));
    return status === 'ok' && isDict(raw) && isDict(raw.calls) ? { ...(raw.calls as Record<string, { at: number; why: string }>) } : {};
  } catch {
    return {};
  }
}

/** Why a call's processes were shut down by AIB ('' when they were not): what an Activity row of that call reads (monitor.ts). */
export function reapedWhyIn(stateDir: string): (call: string) => string {
  return (call: string) => {
    const hit = readReaped(stateDir)[call];
    return hit && typeof hit.why === 'string' ? hit.why : '';
  };
}
