/**
 * The hand-off ledger (<state>/swarm-handoffs.json): which piece of unlanded work (a subagent's or a helper's copy that ended with work
 * that is not in main) was handed to which chat. Owner rule 2026-11-24: "the main agent should take care of 100% of this". The swarm
 * (service.ts #handOff) wakes the chat that started the work, or the project's main chat when that one is gone, with ONE plain line and
 * writes the entry here; an id with an entry is never told again, across restarts. The Changes tab reads it to say "Being handled by
 * <chat>" (project_changes.ts); the unlanded_work tool's land / diff / discard resolve the piece.
 */
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { isDict } from '../core/py.ts';

export const HANDOFF_FILE = 'swarm-handoffs.json';

export interface Handoff {
  /** The subagent record's id (sa_...) or the helper's id (h_...). */
  id: string;
  kind: 'subagent' | 'helper';
  title: string;
  /** The chat it was handed to (its lasting name `provider:sessionId` and the live id at that time) and its name when told. */
  to: { live: string; lasting: string; name: string };
  /** Why it was handed over: stopped / failed / kept / orphan / done. */
  why: string;
  files: number;
  at: number;
  /** After the main agent discarded it: the branch that keeps its work, and the reason it gave. */
  discarded?: { branch: string; reason: string; at: number };
}

type Doc = { version: 1; items: Record<string, Handoff> };

export function readHandoffs(stateDir: string): Record<string, Handoff> {
  if (!stateDir) return {};
  const [status, data] = readJsonFile(pathOf(stateDir, HANDOFF_FILE));
  if (status !== 'ok' || !isDict(data) || !isDict(data.items)) return {};
  const out: Record<string, Handoff> = {};
  for (const [id, v] of Object.entries(data.items)) if (isDict(v) && isDict(v.to)) out[id] = v as unknown as Handoff;
  return out;
}

/** Change the ledger in one step (synchronous: nothing else in this process can write in between). */
export function updateHandoffs(stateDir: string, change: (items: Record<string, Handoff>) => void): Record<string, Handoff> {
  const items = readHandoffs(stateDir);
  change(items);
  const doc: Doc = { version: 1, items };
  saveJson(pathOf(stateDir, HANDOFF_FILE), doc, '.swarm-handoffs-');
  return items;
}
