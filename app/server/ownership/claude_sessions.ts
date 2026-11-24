/**
 * Claude Code's live-session registry (aib-shared/designs/open-elsewhere/research.md): every running Claude Code process writes
 * `<CLAUDE_CONFIG_DIR or ~/.claude>/sessions/<pid>.json` with the session it holds, its entrypoint (`claude-vscode`, `cli`, `sdk-cli`,
 * `sdk-ts`, ...), its status and, on Windows, its creation FILETIME (`procStart`). VS Code's Claude extension and the ACP adapter read
 * the same files to tell "this conversation is open in another Claude process". The format is not documented, so everything here is
 * lenient: an unreadable or odd file is no evidence, unknown fields are fine, a record whose process is gone never counts.
 *
 * Read-only. Nothing here writes, locks or deletes a registry file (a stale one is the CLI's to clean up).
 */
import { join, WIN } from '../platform/ospath.ts';
import { processAlive, processStartTime } from '../platform/process_info.ts';
import { OwnershipConflict } from './ownership.ts';

export interface SessionRecord {
  pid: number;
  sessionId: string;
  entrypoint: string;
  status: string;
  /** Windows: the process creation FILETIME as a decimal string; elsewhere what the CLI wrote (or ''). */
  procStart: string;
  pidDomain: string;
  cwd: string;
  startedAt: number;
}

/** The registry folder of a Claude config folder. */
export function sessionsDir(configDir: string): string {
  return join(configDir, 'sessions');
}

/** One registry file's record, or null when it is not one (bad JSON, no pid or session id). */
export function parseRecord(text: string, fileName = ''): SessionRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const pid = typeof d.pid === 'number' && Number.isInteger(d.pid) && d.pid > 0
    ? d.pid
    : Number(/^(\d+)\.json$/.exec(fileName)?.[1] ?? NaN);
  const sessionId = typeof d.sessionId === 'string' ? d.sessionId : '';
  if (!Number.isInteger(pid) || pid <= 0 || !sessionId || sessionId.length > 200) return null;
  const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : typeof v === 'number' ? String(v) : '');
  return {
    pid,
    sessionId,
    entrypoint: s(d.entrypoint),
    status: s(d.status),
    procStart: s(d.procStart),
    pidDomain: s(d.pidDomain),
    cwd: s(d.cwd),
    startedAt: typeof d.startedAt === 'number' ? d.startedAt : 0,
  };
}

/** Every record in the folder (digits-only `<pid>.json` names, as the CLI and the adapter read them). [] when there is no folder. */
export function readRecords(configDir: string, limit = 500): SessionRecord[] {
  const dir = sessionsDir(configDir);
  const out: SessionRecord[] = [];
  let names: string[];
  try {
    names = [...Deno.readDirSync(dir)].filter((e) => e.isFile && /^\d+\.json$/.test(e.name)).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names.slice(0, limit)) {
    let text: string;
    try {
      text = Deno.readTextFileSync(join(dir, name));
    } catch {
      continue;
    }
    if (text.length > 64 * 1024) continue;
    const record = parseRecord(text, name);
    if (record) out.push(record);
  }
  return out;
}

/** A Windows FILETIME (100 ns since 1601) as epoch seconds; null when it is not one. */
export function filetimeSeconds(value: string): number | null {
  if (!/^\d{15,20}$/.test(value)) return null;
  return Number(BigInt(value)) / 10_000_000 - 11644473600;
}

let hostDomain: string | null = null;
function windowsDomain(): string {
  if (hostDomain === null) {
    try {
      hostDomain = `win32:${Deno.hostname()}`.toLowerCase();
    } catch {
      hostDomain = '';
    }
  }
  return hostDomain;
}

/**
 * Whether the record's process holds it now on this Windows computer: same pid domain (when the record names one), the process runs,
 * and its creation time matches `procStart` (a reused pid does not). Unknown liveness counts as alive (the record is fresh evidence).
 */
export function liveOnWindows(record: SessionRecord): boolean {
  if (record.pidDomain && windowsDomain() && record.pidDomain.toLowerCase() !== windowsDomain()) return false;
  if (record.pidDomain && !record.pidDomain.toLowerCase().startsWith('win32:')) return false;
  const alive = processAlive(record.pid);
  if (alive === false) return false;
  const expected = filetimeSeconds(record.procStart);
  if (expected !== null) {
    const started = processStartTime(record.pid);
    if (started !== null && Math.abs(started - expected) > 2) return false;
  }
  return true;
}

/** The records of live processes (Windows rules on Windows; elsewhere the caller checks liveness: see the WSL helper). */
export function liveRecords(configDir: string, alive: (r: SessionRecord) => boolean = WIN ? liveOnWindows : () => true): SessionRecord[] {
  return readRecords(configDir).filter((r) => {
    try {
      return alive(r);
    } catch {
      return false;
    }
  });
}

/** The app a record's entrypoint names, as the chat line says it: "VS Code", "a terminal", "Claude Desktop" or "another app". */
export function appName(entrypoint: string): string {
  const e = String(entrypoint || '').toLowerCase();
  if (e === 'claude-vscode' || e.includes('vscode')) return 'VS Code';
  if (e.includes('desktop')) return 'Claude Desktop';
  if (e === 'cli' || e === 'sdk-cli') return 'a terminal';
  return 'another app';
}

export interface Holder {
  pid: number;
  entrypoint: string;
  status: string;
  app: string;
}

/** The first live record for `sessionId` whose pid is not one of `own`, as a Holder; null when nobody else holds it. */
export function holderOf(records: SessionRecord[], sessionId: string, own: Set<number>): Holder | null {
  for (const r of records) {
    if (r.sessionId !== sessionId || own.has(r.pid)) continue;
    return { pid: r.pid, entrypoint: r.entrypoint, status: r.status, app: appName(r.entrypoint) };
  }
  return null;
}

/** A message to a chat another app still holds: nothing was sent; the chat shows Open here anyway (Studio answers 409). */
export class HeldElsewhere extends OwnershipConflict {
  override name = 'HeldElsewhere';
  readonly code = 'held_elsewhere';
  /** `singleWriter`: a Codex chat (no Open here anyway: Codex lets one app write a chat). */
  constructor(readonly app: string, singleWriter = false) {
    super(
      singleWriter
        ? `This chat is still open in ${app}, so nothing was sent. Close it there, then send again.`
        : `This chat is still open in ${app}, so nothing was sent. Close it there, or choose Open here anyway in the chat.`,
    );
  }
}
