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

/** What a piece of news is about; `kind` stays binary (routing, sound rank, push words), the reason names it. */
export type Reason = 'approval' | 'question' | 'signin' | 'asks' | 'failed' | 'wake' | 'finished';

export interface GroupEntry {
  key: string;
  title: string;
  kind: Kind;
  reason?: Reason;
  chat?: string;
  /** The chat's project name (desktop notifications only; never a push). */
  project?: string;
  /** The request itself ("Run npm install stripe@18.0.0"); desktop notifications only, never a push. */
  what?: string;
}

export interface Group {
  startedAt: number;
  entries: GroupEntry[];
  sounded: string | null;
}

export interface Rules {
  GROUP_MS: number;
  TO_REVIEW: string;
  MAX_TITLE: number;
  MAX_BODY: number;
  clipText(text: unknown, n: number): string;
  isRisky(text: unknown): boolean;
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
  REASONS: Reason[];
  reasonFor(item: { kind?: string; reason?: string }): Reason | '';
  tally(list: { kind?: string; reason?: string }[]): string;
  addToGroup(group: Group | null, items: GroupEntry[], now: number, windowMs?: number): { group: Group; sound: string | null };
  describe(group: Group): {
    tag: string;
    title: string;
    body: string;
    target: { type: 'chat'; key: string } | { type: 'inbox'; key?: string };
    silent: boolean;
  };
  pushText(group: Group): { title: string; body: string; tag: string; chat: string; sheet: boolean; silent: boolean };
  route(
    kind: Kind,
    chat: string,
    view: { pcFocused: boolean; pcActive: boolean; phones: (string | null)[] },
  ): { desktop: boolean; push: boolean; banner: boolean; read: boolean };
}

export const RULES: Rules = (globalThis as unknown as { AgentNotifyRules: Rules }).AgentNotifyRules;
