/**
 * AIB's own lines of a conversation, kept by conversation (provider + session id), not by AIB chat id (owner rule, 2026-11-17):
 * the "turn finished" dividers and AIB's notes ("Merged subagent ...", "Didn't land ...") are history like the agent's messages.
 * The agent's transcript has none of them, so a chat rebuilt under a new chat id (a lost record, a reopen from the agent's
 * files, a keeper take-over that had to start again) would show the conversation without them. Every such line is appended
 * here when it happens; when a chat loads its session (session/load), connection.ts puts them back in the replayed history, each
 * after the turn it belongs to.
 *
 * One file per conversation: `<state>/conversation-lines/<provider>_<session>.jsonl`, one JSON object per line:
 *   { kind, data, time, after }   after: the anchor of the user message whose turn the line ended or came in (anchorOf).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The event kinds AIB makes itself that are kept per conversation. */
export const KEPT_KINDS = new Set(['turn_end', 'studio_note']);

export interface KeptLine {
  kind: string;
  data: unknown;
  time: number;
  after: string;
}

/** A user message's anchor: its first 160 characters, whitespace folded (the transcript and AIB's own copy agree on that much). */
export function anchorOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export class ConversationLines {
  constructor(readonly dir: string) {}

  path(provider: string, sessionId: string): string {
    return join(this.dir, `${provider}_${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  }

  /** Append one line. Never throws (a line that cannot be written is not worth stopping a chat for). */
  append(provider: string, sessionId: string, line: KeptLine): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path(provider, sessionId), JSON.stringify(line) + '\n');
    } catch { /* best effort */ }
  }

  /** Every line of a conversation, oldest first ([] when there are none). A torn last line is skipped. */
  read(provider: string, sessionId: string): KeptLine[] {
    let text = '';
    try {
      text = readFileSync(this.path(provider, sessionId), 'utf8');
    } catch {
      return [];
    }
    const out: KeptLine[] = [];
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        const line = JSON.parse(raw);
        if (line && typeof line.kind === 'string' && typeof line.after === 'string' && typeof line.time === 'number') out.push(line);
      } catch { /* torn */ }
    }
    return out;
  }
}

/**
 * Puts kept lines back into a replayed transcript: told about each replayed user message as it ends, it returns the lines of the
 * turn before it (those whose anchor is that message's), in order. Lines of turns the transcript no longer has (before a
 * compaction) are passed over.
 */
export class LineMerger {
  #i = 0;
  constructor(readonly lines: KeptLine[]) {}

  /** The lines that belong after the turn of the user message with this anchor (and move past them). */
  take(anchor: string): KeptLine[] {
    if (!anchor) return [];
    let j = this.#i;
    while (j < this.lines.length && this.lines[j].after !== anchor) j++;
    if (j >= this.lines.length) return [];
    const out: KeptLine[] = [];
    let ended = false; // one turn's lines: a second turn end with the same anchor is the next turn's (a repeated "continue")
    while (j < this.lines.length && this.lines[j].after === anchor && !(ended && this.lines[j].kind === 'turn_end')) {
      if (this.lines[j].kind === 'turn_end') ended = true;
      out.push(this.lines[j++]);
    }
    this.#i = j;
    return out;
  }
}
