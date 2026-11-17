/**
 * Which agents a new chat can start with, and why the others cannot: the same rules as the PC's New chat (agent-choice.js
 * mergeRegistry, which a parity test holds this to), for the phone's New chat. From the agent rows Settings shows (settingsView
 * agents): the built-ins are always listed (on when a list omits them), Beta agents after the tested and added ones, malformed rows
 * skipped. An agent can start a chat when it is on, found (installed), and not "Needs sign-in" ("Not checked" counts as ready).
 * The server refuses a phone's new chat with an agent that cannot.
 */
type Json = Record<string, unknown>;

export const BUILTIN_AGENTS: readonly { id: string; name: string }[] = [
  { id: 'omp', name: 'OMP' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
];
/** agent-choice.js BETA_IDS. */
export const BETA_IDS: readonly string[] = ['copilot', 'opencode', 'gemini', 'qwen', 'cursor', 'goose', 'vibe', 'cline', 'kimi', 'kilo'];
const CUSTOM_ID = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Reason = '' | 'Not installed' | 'Needs sign-in' | 'Turned off in Settings';

export interface Eligible {
  id: string;
  name: string;
  beta: boolean;
  /** can start a new chat now */
  ok: boolean;
  /** why not ('' when ok) */
  reason: Reason;
}

const needsSignIn = (row: Json): boolean => {
  const s = row.signin && typeof row.signin === 'object' ? row.signin as Json : null;
  return !!s && s.state === 'signin';
};

/** One row's verdict (agent-choice.js: enabled, and the Beta agents' reason, given here for every agent). */
export function verdict(row: Json): { ok: boolean; reason: Reason } {
  const ok = row.enabled !== false && row.found !== false && !needsSignIn(row);
  if (ok) return { ok, reason: '' };
  const reason: Reason = row.found === false
    ? 'Not installed'
    : needsSignIn(row) && row.enabled !== false
    ? 'Needs sign-in'
    : row.enabled === false
    ? 'Turned off in Settings'
    : 'Needs sign-in';
  return { ok, reason };
}

const nameOf = (row: Json, id: string): string => String(row.name == null ? '' : row.name).trim().slice(0, 40) || id;

/** The agents in New chat's order: built-ins, the ones you added, then Beta. */
export function eligibleAgents(rows: unknown): Eligible[] {
  const all: Eligible[] = BUILTIN_AGENTS.map((a) => ({ ...a, beta: false, ok: true, reason: '' as Reason }));
  const beta: Eligible[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== 'object' || typeof (raw as Json).id !== 'string') continue;
    const row = raw as Json;
    const id = row.id as string;
    const at = all.findIndex((a) => a.id === id);
    if (row.beta === true && BETA_IDS.includes(id)) {
      if (beta.some((a) => a.id === id)) continue;
      beta.push({ id, name: nameOf(row, id), beta: true, ...verdict(row) });
      continue;
    }
    if (at >= 0) {
      if (BUILTIN_AGENTS.some((b) => b.id === id)) Object.assign(all[at], verdict(row));
      continue;
    }
    if (!CUSTOM_ID.test(id) || id.length > 48) continue;
    all.push({ id, name: nameOf(row, id), beta: false, ...verdict(row) });
  }
  return [...all, ...beta];
}

/** The words the phone shows under an agent that cannot start a chat. */
export function reasonWords(reason: Reason): string {
  if (reason === 'Not installed') return 'Not installed on your PC. Install it in AIB on your PC: Settings.';
  if (reason === 'Needs sign-in') return 'Needs sign-in. Sign in on your PC.';
  if (reason === 'Turned off in Settings') return 'Turned off in Settings on your PC.';
  return '';
}
