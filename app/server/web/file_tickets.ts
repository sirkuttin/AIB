/**
 * View tickets for the Files view's Page view and images (Deno only). AIB route that reads a file issues a random ticket for
 * that one file; the artifact origin (a separate, sandboxed origin that never sees AIB token) serves /f/<ticket>/<name> from
 * it, read only, with the artifact CSP. Nothing is copied and no artifact is registered. Tickets expire after TICKET_TTL_MS.
 */
export const TICKET_TTL_MS = 15 * 60_000;
export const MAX_TICKETS = 400;
export const TICKET_PATH = /^\/f\/([0-9a-f]{32})\/[^/\n]{1,255}$/;

/** A ticket's file: on this PC's disk (`path`), or, for a WSL project, the bytes the distro's helper sent (`bytes`; `path` is then its ref). */
type Ticket = { path: string; at: number; bytes?: Uint8Array };
const tickets = new Map<string, Ticket>();
/** The bytes of all WSL tickets together stay under this (each is at most the 1 MB read cap); the oldest go first. */
export const MAX_WSL_BYTES = 48 * 1024 * 1024;

function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A ticket for the file at `abs` (already checked to be inside its folder); the same file keeps one live ticket. */
export function issue(abs: string, now = Date.now()): string {
  for (const [id, t] of tickets) {
    if (now - t.at > TICKET_TTL_MS) tickets.delete(id);
    else if (t.path === abs) {
      t.at = now;
      return id;
    }
  }
  while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
  const id = newId();
  tickets.set(id, { path: abs, at: now });
  return id;
}

/**
 * A ticket for a file inside a distro (WSL project): the Files read already fetched its bytes through the helper, so the artifact
 * origin serves those and never reads a Windows path for it. `ref` (the project's ref plus the file) names it; the same file keeps
 * one live ticket, whose bytes are replaced.
 */
export function issueBytes(ref: string, bytes: Uint8Array, now = Date.now()): string {
  let held = 0;
  for (const [id, t] of tickets) {
    if (now - t.at > TICKET_TTL_MS) tickets.delete(id);
    else if (t.path === ref) {
      t.at = now;
      t.bytes = bytes;
      return id;
    } else held += t.bytes?.length ?? 0;
  }
  for (const [id, t] of tickets) {
    if (held + bytes.length <= MAX_WSL_BYTES) break;
    if (t.bytes) {
      held -= t.bytes.length;
      tickets.delete(id);
    }
  }
  while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
  const id = newId();
  tickets.set(id, { path: ref, at: now, bytes });
  return id;
}

/** The bytes a live WSL ticket holds, or null (a ticket for a file on this PC, an expired or unknown one). */
export function lookupBytes(id: string, now = Date.now()): Uint8Array | null {
  const t = tickets.get(id);
  return t && t.bytes && now - t.at <= TICKET_TTL_MS ? t.bytes : null;
}

/** The file of a live ticket, or null. */
export function lookup(id: string, now = Date.now()): string | null {
  const t = tickets.get(id);
  if (!t) return null;
  if (now - t.at > TICKET_TTL_MS) {
    tickets.delete(id);
    return null;
  }
  return t.path;
}

export const _tickets = tickets;
