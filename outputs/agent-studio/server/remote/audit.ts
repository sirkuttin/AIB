/**
 * The phone activity log (<state>/remote-audit.jsonl): one line per pairing step, device change, phone action (answer, approve,
 * send, stop, queue) and refused phone request, with the time, the phone (id and name), the action, the chat id and the result.
 * A paired computer adds terminal opened and closed, file downloaded, file outside the project read, and project added and removed,
 * each with the path (never the content). Never message text, answers, commands, terminal input or codes. Kept small: at MAX_BYTES the file
 * moves to remote-audit.1.jsonl (one older file is kept) and a new one starts.
 */
import { inDir } from '../state/base.ts';

export interface AuditEntry {
  time: number;
  device: string;
  name: string;
  action: string;
  /** The chat a phone action was for ('' for pairing and device changes). */
  chat: string;
  result: string;
  /** A file or folder the action was about (a download, a file outside the project, a project added or removed): the path only,
   * never the content. */
  path?: string;
  /** Who made a change on the PC (a device's kind: "the PC page, Settings > Remote control (Chrome)"). */
  by?: string;
}

export const AUDIT_FILE = 'remote-audit.jsonl';
export const AUDIT_OLD = 'remote-audit.1.jsonl';
const MAX_BYTES = 256 * 1024;

export class Audit {
  readonly path: string | null;
  readonly old: string | null;
  constructor(stateDir: string | null, readonly maxBytes = MAX_BYTES, readonly clock: () => number = () => Date.now() / 1000) {
    this.path = stateDir ? inDir(stateDir, AUDIT_FILE) : null;
    this.old = stateDir ? inDir(stateDir, AUDIT_OLD) : null;
  }

  write(entry: { device?: string; name?: string; action: string; chat?: string; result: string; path?: string; by?: string }): void {
    if (this.path === null) return;
    const line: AuditEntry = {
      time: Math.round(this.clock()),
      device: String(entry.device ?? '').slice(0, 40),
      name: String(entry.name ?? '').slice(0, 40),
      action: entry.action.slice(0, 40),
      chat: String(entry.chat ?? '').slice(0, 100),
      result: entry.result.slice(0, 80),
      ...(entry.path ? { path: String(entry.path).slice(0, 400) } : {}),
      ...(entry.by ? { by: String(entry.by).slice(0, 80) } : {}),
    };
    try {
      let size = 0;
      try {
        size = Deno.statSync(this.path).size;
      } catch { /* none yet */ }
      if (size >= this.maxBytes) Deno.renameSync(this.path, this.old!);
      Deno.writeTextFileSync(this.path, JSON.stringify(line) + '\n', { append: true });
    } catch { /* the log never stops a request */ }
  }

  /** The newest `limit` entries, newest first. */
  tail(limit = 200): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (const file of [this.path, this.old]) {
      if (!file) continue;
      let text = '';
      try {
        text = Deno.readTextFileSync(file);
      } catch {
        continue;
      }
      const lines = text.split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        try {
          out.push(JSON.parse(line));
        } catch { /* a torn line */ }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
