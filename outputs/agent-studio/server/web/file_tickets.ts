/**
 * View tickets for the Files view's Page view and images (Deno only). The Studio route that reads a file issues a random ticket for
 * that one file; the artifact origin (a separate, sandboxed origin that never sees the Studio token) serves /f/<ticket>/<name> from
 * it, read only, with the artifact CSP. Nothing is copied and no artifact is registered. Tickets expire after TICKET_TTL_MS.
 */
export const TICKET_TTL_MS = 15 * 60_000;
export const MAX_TICKETS = 400;
export const TICKET_PATH = /^\/f\/([0-9a-f]{32})\/[^/\n]{1,255}$/;

const tickets = new Map<string, { path: string; at: number }>();

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
