/**
 * The inbox rules the page uses (app/page/inbox-rules.js), loaded into the server as they are: one file decides what
 * a chat's phase is (needs you, failed, asks, working, your turn) and what counts toward the one number, for the page, the
 * server's notifications, the phone's home, both trays and the agent connection's own facts. work/test_inbox_rules.js pins it.
 */
import '../../page/inbox-rules.js';

export type Phase = 'needs_you' | 'failed' | 'asks' | 'stalled' | 'working' | 'your_turn' | 'idle' | 'opening' | 'closed';

export interface BaseFacts {
  closed?: boolean;
  ready?: boolean;
  busy?: boolean;
  needs?: number;
  failedAt?: number | string | null;
  asksAt?: number | string | null;
  helpers?: number;
  shells?: boolean;
  followUntil?: number | string | null;
}

/** A chat's facts for the server-built rows (inbox-rules.js rowsOf). */
export interface ChatFacts {
  key: string;
  id?: string;
  title?: string;
  project?: { key: string; name: string };
  provider?: string;
  agent?: string;
  attention?: unknown;
  mark?: unknown;
  live?: boolean;
  requestAt?: number;
  request?: { kind: 'permission' | 'question'; key: string; params: Record<string, unknown>; pcOnly?: boolean } | null;
  more?: number;
  elicitations?: number;
  auth?: boolean;
  lastText?: string;
  lastStep?: string;
}

export interface InboxAction {
  id: string;
  label?: string;
  default?: boolean;
  quiet?: boolean;
}

/** One server-built inbox row (inbox-rules.js rowOf). */
export interface InboxRow {
  key: string;
  id: string;
  section: 'needs' | 'review';
  kind: 'approval' | 'question' | 'signin' | 'asks' | 'failed' | 'stalled' | 'finished';
  what: string;
  whatCode: string;
  title: string;
  project: { key: string; name: string };
  provider: string;
  agent: string;
  since: number;
  at: number;
  needs: number;
  more: number;
  helpers: number;
  request: { kind: 'permission' | 'question'; key: string; params: Record<string, unknown>; pcOnly?: boolean } | null;
  ask: string;
  failKind?: string;
  stall?: { kind: string; lastStep: string; at: number };
  sig?: string;
  actions: InboxAction[];
}

export interface SnoozedRow {
  key: string;
  id: string;
  kind: string;
  what: string;
  title: string;
  project: { key: string; name: string };
  since: number;
  until: number;
}

export interface InboxRows {
  rows: InboxRow[];
  count: number;
  working: { chats: number; projects: number };
  snoozed: SnoozedRow[];
}

export interface InboxRules {
  QUIET_SECONDS: number;
  TOOL_CAP_SECONDS: number;
  CONTINUE_TEXT: string;
  STALL_ON: string[];
  requestWhat(req: unknown): { what: string; code: string };
  stallWhat(kind: string, step: string): string;
  stallOf(attention: unknown, mark: unknown): { kind: string; at: number; step: string } | null;
  snoozedOf(mark: unknown, sig: string, now: number): number;
  sigOf(row: unknown): string;
  snoozeChoices(nowMs: number): { id: string; label: string; until: number }[];
  tomorrowNine(nowMs: number): number;
  rowOf(chat: ChatFacts, now: number): InboxRow | null;
  rowsOf(chats: ChatFacts[], now: number, opts?: { open?: string[] }): InboxRows;
  workingText(w: { chats: number; projects: number }): string;
  FOLLOW_UP_SECONDS: number;
  SHELL_CAP_SECONDS: number;
  HELPER_CAP_SECONDS: number;
  ASK_MIN_CHARS: number;
  LONG_WAIT_SECONDS: number;
  secondsOf(v: unknown): number;
  asksOf(text: unknown): { asks: boolean; question: string };
  classifyError(text: unknown): '' | 'limit' | 'auth' | 'network' | 'crash' | 'other';
  basePhase(facts: BaseFacts, now: number): Phase;
  phaseOf(attention: unknown, mark: unknown, now: number): Phase;
  blocked(phase: string): boolean;
  waitingSince(phase: string, attention: unknown, requestAt?: number, mark?: unknown): number;
  reasonOf(phase: string, kinds?: unknown[]): string;
  reasonWord(reason: string): string;
  helpersLine(n: number): string;
  countBlocked(chats: { attention: unknown; mark?: unknown; key?: string }[], now: number, open?: string[]): number;
  openKeys(o: { selected?: unknown; panes?: unknown; visible?: boolean }): string[];
  isOpen(key: unknown, open: unknown): boolean;
}

export const INBOX: InboxRules = (globalThis as unknown as { AgentInboxRules: InboxRules }).AgentInboxRules;

/**
 * How many of these chats (a liveList's connections, or attention() of each) are blocked on you, with the marks file's entries.
 * open: the chats open in the AIB window (Presence.openOnPc): the desktop's count leaves them out.
 */
export function blockedCount(
  chats: { provider?: unknown; sessionId?: unknown; closed?: unknown; attention?: unknown }[],
  marks: Record<string, unknown>,
  now = Date.now() / 1000,
  open: string[] = [],
): number {
  // the server-built rows' own count (inbox-rules.js rowsOf): a snoozed chat is left out, a stalled one counts
  return INBOX.rowsOf(
    chats.map((c) => {
      const key = `${c.provider}:${c.sessionId}`;
      return { key, live: !c.closed, attention: c.attention, mark: marks[key] };
    }),
    now,
    { open },
  ).count;
}
