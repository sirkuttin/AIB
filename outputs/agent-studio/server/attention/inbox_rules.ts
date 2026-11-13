/**
 * The inbox rules the page uses (outputs/agent-studio/inbox-rules.js), loaded into the server as they are: one file decides what
 * a chat's phase is (needs you, failed, asks, working, your turn) and what counts toward the one number, for the page, the
 * server's notifications, the phone's home, both trays and the agent connection's own facts. work/test_inbox_rules.js pins it.
 */
import '../../inbox-rules.js';

export type Phase = 'needs_you' | 'failed' | 'asks' | 'working' | 'your_turn' | 'idle' | 'opening' | 'closed';

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

export interface InboxRules {
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
  waitingSince(phase: string, attention: unknown, requestAt?: number): number;
  reasonOf(phase: string, kinds?: unknown[]): string;
  reasonWord(reason: string): string;
  helpersLine(n: number): string;
  countBlocked(chats: { attention: unknown; mark?: unknown }[], now: number): number;
}

export const INBOX: InboxRules = (globalThis as unknown as { AgentInboxRules: InboxRules }).AgentInboxRules;

/** How many of these chats (a liveList's connections, or attention() of each) are blocked on you, with the marks file's entries. */
export function blockedCount(
  chats: { provider?: unknown; sessionId?: unknown; closed?: unknown; attention?: unknown }[],
  marks: Record<string, unknown>,
  now = Date.now() / 1000,
): number {
  return INBOX.countBlocked(
    chats.filter((c) => !c.closed).map((c) => {
      const mark = marks[`${c.provider}:${c.sessionId}`] as { archivedAt?: number; deletedAt?: number } | undefined;
      return { attention: mark?.archivedAt || mark?.deletedAt ? { state: 'closed' } : c.attention, mark };
    }),
    now,
  );
}
