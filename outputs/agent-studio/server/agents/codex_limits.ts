/**
 * Codex's subscription limits, read the two official-binary ways (owner decision: session files first, app-server as fallback).
 *
 * 1. Session files. Codex (and the app-server codex-acp runs) writes `token_count` events with `rate_limits` into
 *    <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl after each model response. The newest file's last such event is read; only
 *    the tail of the file is read, and nothing else in it is kept.
 * 2. App-server. When no session file has the numbers, the bundled `codex app-server` is started hidden for one documented request
 *    (initialize, then account/rateLimits/read) and ended. It costs one backend read and no quota; no thread or turn is started.
 */
import { getLogger } from '../core/log.ts';
import { guardRealAgent } from '../acp/connection.ts';

const log = getLogger('codex-limits');

type Json = Record<string, unknown>;
const isDict = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const join = (...parts: string[]) => parts.join(SEP);

export const TAIL_BYTES = 512 * 1024;
const MAX_DAY_FOLDERS = 7;
const MAX_FILES = 5;

/** <CODEX_HOME>, else ~/.codex. null when there is no home folder. */
export function codexHome(env: Record<string, string | undefined> | null = null): string | null {
  const set = (env?.CODEX_HOME ?? Deno.env.get('CODEX_HOME') ?? '').trim();
  if (set) return set;
  const home = Deno.build.os === 'windows' ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME');
  return home ? join(home, '.codex') : null;
}

function names(folder: string, dirs: boolean): string[] {
  try {
    return [...Deno.readDirSync(folder)].filter((e) => (dirs ? e.isDirectory : e.isFile)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The newest rollout files (by modified time) in the latest day folders, newest first. */
export function newestRollouts(home: string, limit = MAX_FILES): string[] {
  const sessions = join(home, 'sessions');
  const days: string[] = [];
  const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  outer: for (const y of names(sessions, true).filter((n) => /^\d{4}$/.test(n)).sort(desc)) {
    for (const m of names(join(sessions, y), true).filter((n) => /^\d{2}$/.test(n)).sort(desc)) {
      for (const d of names(join(sessions, y, m), true).filter((n) => /^\d{2}$/.test(n)).sort(desc)) {
        days.push(join(sessions, y, m, d));
        if (days.length >= MAX_DAY_FOLDERS) break outer;
      }
    }
  }
  const files: { path: string; mtime: number }[] = [];
  for (const day of days) {
    for (const name of names(day, false)) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const path = join(day, name);
      try {
        files.push({ path, mtime: Deno.statSync(path).mtime?.getTime() ?? 0 });
      } catch { /* gone meanwhile */ }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path);
}

function readTail(path: string, bytes = TAIL_BYTES): string {
  const file = Deno.openSync(path, { read: true });
  try {
    const size = file.statSync().size;
    const start = Math.max(0, size - bytes);
    file.seekSync(start, Deno.SeekMode.Start);
    const buffer = new Uint8Array(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = file.readSync(buffer.subarray(read));
      if (!n) break;
      read += n;
    }
    const textOut = new TextDecoder().decode(buffer.subarray(0, read));
    return start > 0 ? textOut.slice(textOut.indexOf('\n') + 1) : textOut; // drop the cut first line
  } finally {
    file.close();
  }
}

/** The last token_count rate_limits in one rollout file (and when it was written, seconds), or null. */
export function rolloutLimits(path: string): { rateLimits: Json; at: number } | null {
  let tail: string;
  try {
    tail = readTail(path);
  } catch {
    return null;
  }
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
    try {
      const record = JSON.parse(line);
      const payload = isDict(record) ? record.payload : null;
      if (!isDict(payload) || payload.type !== 'token_count' || !isDict(payload.rate_limits)) continue;
      const limitId = payload.rate_limits.limit_id;
      if (limitId !== undefined && limitId !== null && limitId !== 'codex') continue; // another bucket: the plan's comes later
      const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      let at = Number.isFinite(stamp) ? stamp / 1000 : 0;
      if (!at) at = (Deno.statSync(path).mtime?.getTime() ?? Date.now()) / 1000;
      return { rateLimits: payload.rate_limits, at };
    } catch { /* a line being written, or not JSON */ }
  }
  return null;
}

/** The newest rate_limits Codex wrote under this home, or null when no session file has them. */
export function latestRolloutLimits(home: string | null): { rateLimits: Json; at: number } | null {
  if (!home) return null;
  for (const path of newestRollouts(home)) {
    const found = rolloutLimits(path);
    if (found) return found;
  }
  return null;
}

/**
 * How to start the official app-server for this Codex chat: CODEX_PATH when set (codex-acp honours it), else the `@openai/codex`
 * package installed next to codex-acp, run with the same node. null when neither is found.
 */
export function appServerCommand(acpCommand: readonly string[], env: Record<string, string | undefined> | null = null): string[] | null {
  const pathSet = (env?.CODEX_PATH ?? Deno.env.get('CODEX_PATH') ?? '').trim();
  if (pathSet) return [pathSet, 'app-server'];
  const [node, entry] = acpCommand;
  if (!node || !entry) return null;
  const parts = entry.split(/[\\/]+/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return null;
  const script = [...parts.slice(0, at + 1), '@openai', 'codex', 'bin', 'codex.js'].join(SEP);
  try {
    if (!Deno.statSync(script).isFile) return null;
  } catch {
    return null;
  }
  return [node, script, 'app-server'];
}

/**
 * One account/rateLimits/read through a short-lived app-server: initialize, initialized, the read, then the process is ended.
 * Resolves to the result, or null on any failure or after `timeoutMs`. Under test only fixtures under work/ may be started.
 */
export async function appServerLimits(
  command: string[],
  env: Record<string, string> | null = null,
  timeoutMs = 15_000,
): Promise<unknown> {
  try {
    guardRealAgent(command);
  } catch (error) {
    log.warning(String(error));
    return null;
  }
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command[0], {
      args: command.slice(1),
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
      ...(env ? { env } : {}),
    }).spawn();
  } catch (error) {
    log.warning(`The Codex app-server could not start: ${error}`);
    return null;
  }
  const writer = child.stdin.getWriter();
  const send = (message: Json) => writer.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)));
  const work = (async () => {
    // The same handshake codex-acp makes, with AIB's name.
    await send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'aib', title: 'AIB', version: '1' }, capabilities: { experimentalApi: true } },
    });
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let asked = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isDict(message)) continue;
          if (message.id === 1 && !asked) {
            if (message.error) return null;
            asked = true;
            await send({ method: 'initialized' });
            await send({ id: 2, method: 'account/rateLimits/read' });
          } else if (message.id === 2) {
            return message.error ? null : message.result ?? null;
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  })().catch(() => null);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    try {
      await writer.close();
    } catch { /* already closed */ }
    try {
      child.kill();
    } catch { /* already ended */ }
    await child.status.catch(() => {});
  }
}
