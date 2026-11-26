/**
 * Snapshot and history-store constants of the Connection, and the lines-note size helper. Moved out of connection.ts (no change).
 */
import { type KeptLine } from '../history/lines.ts';
import { ENCODER } from './conn_util.ts';

/**
 * The format of a keeper `snapshot` note this code writes (its `sv`). 1: the whole event history inside the note (beta.8 and before;
 * still restored). 2: the note holds the chat's state without its history; each snapshot also stores only the events made since the
 * one before (in the note itself, or in `t: 'event'` chunk notes just before it when they do not fit), so a note stays small however
 * long the chat is, and the journal keeps the chunks the history still needs (truncate stops at the oldest of them).
 */
export const SNAPSHOT_VERSION = 2;
/** A snapshot note larger than this is not written (a note is at most 16 MiB); the replay then starts at the one before, or at 0. */
export const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
/** The `lines` note (AIB's kept lines a session/load puts back): the newest that fit. */
export const MAX_LINES_NOTE_BYTES = 8 * 1024 * 1024;

/** The newest lines whose JSON fits in `bytes`, oldest first. */
export function linesWithin(lines: KeptLine[], bytes: number): KeptLine[] {
  let used = 0;
  let i = lines.length;
  while (i > 0) {
    const size = ENCODER.encode(JSON.stringify(lines[i - 1])).length + 1;
    if (used + size > bytes) break;
    used += size;
    i--;
  }
  return lines.slice(i);
}

/** History store writes (history-loading design 3.1): queued events are committed this often (written_seq only). */
export const HISTORY_FLUSH_MS = 200;
/** Each live helper's newest events kept in RAM after a take-over (the rest are read from the store when asked). */
export const HISTORY_HELPER_TAIL = 200;
/**
 * The `aib-history-v2` switch, server side: ON by default (AIB_HISTORY_V2=0 turns it off, for one release). Off: new chats get no
 * store and snapshots carry the history in chunk notes as in beta.10 (a chat that already has a store keeps it: see
 * Aib.historyClient). On since fix/history-store-on: the mid-turn crash take-over (keeper_crash_e2e) holds under parallel load.
 */
export function historyV2(): boolean {
  try {
    return Deno.env.get('AIB_HISTORY_V2') !== '0';
  } catch {
    return false;
  }
}
/** Where a test stops the quiet-point checkpoint, to act out a crash right after that step (design 3.2). */
export type CheckpointStep = 'flush' | 'note' | 'commit';
/** Events per chunk note, in UTF-8 bytes (several chunks when a snapshot has more new events, e.g. after a session/load). */
export const EVENT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Why a keeper-run agent ended without being asked to: the keeper itself went away. */
export const KEEPER_LOST =
  'Interrupted: the keeper (the AIB process that holds running agents) stopped, so this agent stopped with it. Nothing was sent again.';

/** A time this late or later (ms after the scheduled time) counts as "sent late": AIB was not running at the time. */
export const SCHEDULE_LATE_MS = 90_000;
