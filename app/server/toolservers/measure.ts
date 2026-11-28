/**
 * What a tool server costs per chat, MEASURED from a real run: the processes of the server that sit below a chat's agent and their
 * working set (Windows: GetProcessMemoryInfo; Linux: /proc/<pid>/status, else `ps -o rss=`). A process belongs to a server when
 * its command line names the server's command and first arguments (the entry the agent's own config holds); the server's other
 * processes are the descendants of that one (an npx or uvx wrapper's children). Never throws; null when it can't tell.
 * A server that never ran in a chat has no measurement: the page labels that "estimate" (store.ts memory, view in service.ts).
 */
import { descendants as realDescendants } from '../platform/descendants.ts';
import { processStrings, processWorkingSetKb } from '../platform/process_info.ts';

export interface Proc {
  pid: number;
  parentPid: number;
  commandLine: string;
  kb: number;
}
export interface Measured {
  procs: number;
  mb: number;
}

/** What identifies a server's head process: its command and the first arguments that are not flags. */
export function headTokens(entry: Record<string, unknown>): string[] {
  const command = typeof entry.command === 'string'
    ? entry.command.replace(/\\/g, '/').split('/').pop()!.replace(/\.(exe|cmd|bat)$/i, '')
    : '';
  const args = Array.isArray(entry.args)
    ? entry.args.filter((a): a is string => typeof a === 'string' && !a.startsWith('-')).slice(0, 2)
    : [];
  const tokens = [...args.map((a) => a.replace(/\\/g, '/').toLowerCase())];
  if (!tokens.length && command) tokens.push(command.toLowerCase());
  return tokens;
}

/** The measurement of each server from a list of the agent's processes (every process below it, with command line and size). */
export function attribute(procs: Proc[], servers: { id: string; entry: Record<string, unknown> }[]): Record<string, Measured> {
  const byParent = new Map<number, Proc[]>();
  for (const p of procs) byParent.set(p.parentPid, [...(byParent.get(p.parentPid) ?? []), p]);
  const out: Record<string, Measured> = {};
  const taken = new Set<number>();
  for (const s of servers) {
    const tokens = headTokens(s.entry);
    if (!tokens.length) continue;
    const heads = procs.filter((p) =>
      !taken.has(p.pid) && tokens.every((t) => p.commandLine.replace(/\\/g, '/').toLowerCase().includes(t))
    );
    const mine = new Set<number>();
    const walk = (p: Proc) => {
      if (mine.has(p.pid) || taken.has(p.pid)) return;
      mine.add(p.pid);
      for (const child of byParent.get(p.pid) ?? []) walk(child);
    };
    // the outermost matching process of each chain: a wrapper that matches and its matching child count once
    for (const h of heads) if (!heads.some((o) => o !== h && isAncestor(o, h, procs))) walk(h);
    if (!mine.size) continue;
    for (const pid of mine) taken.add(pid);
    const kb = procs.filter((p) => mine.has(p.pid)).reduce((n, p) => n + p.kb, 0);
    out[s.id] = { procs: mine.size, mb: Math.round(kb / 1024) };
  }
  return out;
}

function isAncestor(a: Proc, b: Proc, procs: Proc[]): boolean {
  const index = new Map(procs.map((p) => [p.pid, p]));
  for (let p = index.get(b.parentPid), n = 0; p && n < 32; p = index.get(p.parentPid), n++) if (p.pid === a.pid) return true;
  return false;
}

/** A process's working set in KB (Windows: GetProcessMemoryInfo; elsewhere /proc/<pid>/status VmRSS, else `ps`), 0 when it can't be read. */
export function sizeKb(pid: number): number {
  try {
    if (Deno.build.os === 'windows') return processWorkingSetKb(pid) ?? 0;
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(Deno.readTextFileSync(`/proc/${pid}/status`));
      if (m) return Number(m[1]);
    } catch { /* no /proc */ }
    const done = new Deno.Command('ps', { args: ['-o', 'rss=', '-p', String(pid)], stdin: 'null', stdout: 'piped', stderr: 'null' })
      .outputSync();
    return done.success ? Number(new TextDecoder().decode(done.stdout).trim()) || 0 : 0;
  } catch {
    return 0;
  }
}

function commandLineOf(pid: number): string {
  try {
    if (Deno.build.os === 'windows') return processStrings(pid)?.commandLine ?? '';
    return Deno.readTextFileSync(`/proc/${pid}/cmdline`).replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

/** The processes below the agent `root`, with command line and size; null when they can't be listed. */
export function agentProcesses(
  root: number,
  below: (root: number) => { pid: number; parentPid: number }[] | null = realDescendants,
): Proc[] | null {
  const list = below(root);
  if (!list) return null;
  return list.map((d) => ({ pid: d.pid, parentPid: d.parentPid, commandLine: commandLineOf(d.pid), kb: sizeKb(d.pid) }));
}
