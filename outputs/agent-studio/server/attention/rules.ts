/**
 * The notification rules the page uses (outputs/agent-studio/notify-rules.js), loaded into the server as they are: one file, so a
 * chat that would not notify on the page (archived, deleted, hidden or muted project, worktree or scratch folder, on hold for
 * "finished") does not notify from the server either. work/deno/attention_rules_test.ts checks the page's and the server's
 * reading of the same chats against each other.
 */
import '../../notify-rules.js';

export interface Flags {
  eligible: boolean;
  muted: boolean;
  held: boolean;
}

export interface ChatFacts {
  archived?: boolean;
  deleted?: boolean;
  held?: boolean;
  projectKey?: string;
  worktree?: boolean;
  scratch?: boolean;
}

export interface AppPrefs {
  desktop: boolean;
  sound: string;
  notifyFor: 'both' | 'needs';
}

export type Kind = 'needs' | 'turn';

export interface GroupEntry {
  key: string;
  title: string;
  kind: Kind;
  chat?: string;
}

export interface Group {
  startedAt: number;
  entries: GroupEntry[];
  sounded: string | null;
}

export interface Rules {
  GROUP_MS: number;
  TAG: string;
  PUSH_TAG: string;
  splitPath(cwd: unknown): { segments: string[]; windows: boolean };
  pathKey(cwd: unknown): string;
  isScratchPath(path: unknown): boolean;
  isWorktreePath(path: unknown): boolean;
  projectPref(prefs: unknown, key: string): { hidden: boolean; muted: boolean };
  flags(facts: ChatFacts, prefs: unknown): Flags;
  notifies(kind: Kind, flags: Flags): boolean;
  cleanPrefs(value: unknown, app: boolean): AppPrefs;
  appPrefs(text: unknown): AppPrefs;
  desktopWants(kind: Kind, prefs: AppPrefs): boolean;
  addToGroup(group: Group | null, items: GroupEntry[], now: number, windowMs?: number): { group: Group; sound: string | null };
  describe(group: Group): { tag: string; title: string; body: string; target: { type: 'chat'; key: string } | { type: 'inbox' } };
  pushText(group: Group): { title: string; body: string; tag: string; chat: string; sheet: boolean };
}

export const RULES: Rules = (globalThis as unknown as { AgentNotifyRules: Rules }).AgentNotifyRules;
