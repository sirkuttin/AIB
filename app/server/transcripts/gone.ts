/**
 * Activity's "Processes": a background command the agent's own transcript calls running may be dead (the owner or the lead killed it from
 * outside; the agent never says so). This asks the host which of the running rows have no process left and AIB marks those ended
 * ("Ended (process gone)", the look of every other ended row; transcripts/monitor.ts withGone).
 *
 * Cheap on purpose:
 *   - only rows the list shows as running, only those with a call id;
 *   - one batched host call per chat per `ttlMs` (default 10 s), whatever the number of polls and windows: in between the last answer is used;
 *   - a row once found gone stays gone (a dead process does not come back; a bounded memory);
 *   - a host that is slow (`waitMs`) or errors leaves every row as it was (nothing is guessed).
 * The host (host/aib.ts backgroundGone) answers from what AIB knows about the process: the chat's own pid-and-start-time check for the
 * main agent's commands, the AIB_PROC cookie scan for a subagent's (a WSL chat's in its distro). A command it cannot tell about is never
 * listed, so it stays as the agent reported it. The same for every agent.
 */
import type { Task } from './transcript.ts';

export type GoneCheck = (session: string, running: Task[]) => Promise<Set<string>>;

export interface GoneOptions {
  /** Minimum time between two host calls for one chat. */
  ttlMs?: number;
  /** The longest a request waits for the host. */
  waitMs?: number;
  now?: () => number;
}

/** The chat's saved-session id from its transcript key ("claude/<folder>/<sessionId>.jsonl"). */
export function sessionIdOf(session: string): string {
  const last = session.split('/').pop() ?? '';
  return last.replace(/\.jsonl$/, '');
}

const STICKY_MAX = 5000;

/** `ask(sessionId, calls)` -> the call ids with no process (the host's 'bg-gone' op). */
export function makeGoneCheck(
  ask: (sessionId: string, calls: { call: string; main: boolean }[]) => Promise<string[]>,
  options: GoneOptions = {},
): GoneCheck {
  const ttlMs = options.ttlMs ?? 10_000;
  const waitMs = options.waitMs ?? 3000;
  const now = options.now ?? Date.now;
  const gone = new Set<string>(); // task ids found gone (sticky)
  const asked = new Map<string, { at: number; run: Promise<void> | null }>();
  return async (session, running) => {
    if (!running.length) return new Set();
    const state = asked.get(session) ?? { at: 0, run: null };
    asked.set(session, state);
    if (!state.run && now() - state.at >= ttlMs) {
      state.at = now();
      const byCall = new Map<string, string[]>(); // call id -> task ids (the same call may be listed under more than one agent)
      const calls: { call: string; main: boolean }[] = [];
      for (const t of running) {
        if (gone.has(t.id as string) || typeof t.callId !== 'string' || !t.callId) continue;
        const ids = byCall.get(t.callId) ?? [];
        if (!ids.length) calls.push({ call: t.callId, main: t.agentKey === session || t.agent === 'Main conversation' });
        ids.push(t.id as string);
        byCall.set(t.callId, ids);
      }
      if (calls.length) {
        state.run = ask(sessionIdOf(session), calls.slice(0, 200)).then((done) => {
          for (const call of done) for (const id of byCall.get(call) ?? []) gone.add(id);
          while (gone.size > STICKY_MAX) gone.delete(gone.values().next().value!);
        }).catch(() => {/* the host is away: rows stay as they were */}).finally(() => {
          state.run = null;
        });
      }
    }
    if (state.run) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([state.run, new Promise((resolve) => timer = setTimeout(resolve, waitMs))]);
      clearTimeout(timer);
    }
    return new Set(running.map((t) => t.id as string).filter((id) => gone.has(id)));
  };
}

/**
 * The other half (2026-11-24, "Ashborne orchestrator part3"): a subagent's turn ended while the runs it started in the background (29 headless
 * game runs) still went on, and its rows read "Ended with the agent that started it" (transcripts/monitor.ts), so Activity showed it finished and
 * no processes. `ask(sessionId, calls)` -> the call ids that still have a tagged process (the host's 'bg-gone' answer `alive`). Asked for the
 * rows that read ended with their agent; the ones answered alive are running again, and the agent is waiting on them. Same cost rules as above
 * (one batched host call per chat per `ttlMs`; a slow or failing host revives nothing; a revived row whose process ends ends again).
 */
export function makeAliveCheck(
  ask: (sessionId: string, calls: { call: string; main: boolean }[]) => Promise<string[]>,
  options: GoneOptions = {},
): GoneCheck {
  const ttlMs = options.ttlMs ?? 10_000;
  const waitMs = options.waitMs ?? 3000;
  const now = options.now ?? Date.now;
  const asked = new Map<string, { at: number; run: Promise<void> | null; alive: Set<string> }>();
  return async (session, ended) => {
    if (!ended.length) return new Set();
    const state = asked.get(session) ?? { at: 0, run: null, alive: new Set<string>() };
    asked.set(session, state);
    if (!state.run && now() - state.at >= ttlMs) {
      state.at = now();
      const byCall = new Map<string, string[]>();
      const calls: { call: string; main: boolean }[] = [];
      for (const t of ended) {
        if (typeof t.callId !== 'string' || !t.callId) continue;
        const ids = byCall.get(t.callId) ?? [];
        if (!ids.length) calls.push({ call: t.callId, main: false });
        ids.push(t.id as string);
        byCall.set(t.callId, ids);
      }
      if (calls.length) {
        state.run = ask(sessionIdOf(session), calls.slice(0, 200)).then((alive) => {
          state.alive = new Set(alive.flatMap((call) => byCall.get(call) ?? []));
        }).catch(() => {/* the host is away: nothing is revived */}).finally(() => {
          state.run = null;
        });
      }
    }
    if (state.run) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([state.run, new Promise((resolve) => timer = setTimeout(resolve, waitMs))]);
      clearTimeout(timer);
    }
    return new Set(ended.map((t) => t.id as string).filter((id) => state.alive.has(id)));
  };
}
