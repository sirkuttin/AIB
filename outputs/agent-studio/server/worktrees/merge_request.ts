/**
 * "Merge into <base>" asks the agent: the one-shot merge permission and the fixed message the button sends.
 *
 * The page's Merge button (token-protected route) records a permission for the chat's worktree and sends the chat MERGE_REQUEST as
 * from the user. The agent's merge_into_project tool merges only with that permission: it is tied to what the chat had changed at
 * the click (a fingerprint of its own changes since the user base U, plus HEAD and tree for the record), used up by a merge that
 * lands, kept across the conflict-fixing rounds of that merge, and cleared when the user's next own message reaches the agent.
 * Text in the chat never grants it. Kept in a small JSON file in the state folder, so the web process (route, tool) and the host
 * process (turn start) share it.
 */
import { pathOf } from '../state/paths.ts';
import { entriesOf, readJsonFile, saveJson } from '../state/json.ts';
import { isDict } from '../core/py.ts';
import * as wt from './worktrees.ts';

export const PERMISSION_FILE = 'merge-permissions.json';
/** clientMessageId prefix of the button's message (merge.ts's own prompts use 'merge-' too): never clears the permission. */
export const REQUEST_ID_PREFIX = 'merge-request-';

/** The fixed message the Merge button sends the chat (base: the branch it merges into). */
export function mergeRequestText(base: string): string {
  const name = base || 'main';
  return `Merge this chat's work into ${name} with AIB's merge tool (merge_into_project). If ${name} has moved and there are ` +
    'conflicts, resolve them in this worktree and call it again. Then say in one line what landed.';
}

/** The whole (trimmed) text is the button's message: the page shows it as a "Merge requested" chip (StreamUI.wholeNote). */
export const MERGE_REQUEST =
  /^Merge this chat's work into (\S+) with AIB's merge tool \(merge_into_project\)\. If \1 has moved and there are conflicts, resolve them in this worktree and call it again\. Then say in one line what landed\.$/;

export function isMergeRequest(text: unknown): boolean {
  return typeof text === 'string' && MERGE_REQUEST.test(text.trim());
}

export interface Permission {
  /** The chat id the button was pressed for. */
  chat: string;
  /** Hash of the chat's own changes since U at the click (see merge.ts changeFingerprint). */
  fingerprint: string;
  head: string;
  tree: string;
  time: number;
  /** A merge started with this permission stopped at conflicts: the agent may change the worktree and call again. */
  rounds: boolean;
}

function filePath(stateDir: string): string {
  return pathOf(stateDir, PERMISSION_FILE);
}

function readAll(stateDir: string): Record<string, Permission> {
  const [status, raw] = readJsonFile(filePath(stateDir));
  const out: Record<string, Permission> = {};
  if (status === 'ok' && isDict(raw)) {
    for (const [key, value] of entriesOf(raw)) {
      if (isDict(value) && typeof value.fingerprint === 'string') out[key] = value as unknown as Permission;
    }
  }
  return out;
}

function writeAll(stateDir: string, items: Record<string, Permission>): void {
  saveJson(filePath(stateDir), items, '.studio-merge-perm-');
}

/** The permission for a worktree (registry key), or null. */
export function getPermission(stateDir: string, key: string): Permission | null {
  return readAll(stateDir)[key] ?? null;
}

export function setPermission(stateDir: string, key: string, permission: Permission): void {
  const items = readAll(stateDir);
  items[key] = permission;
  writeAll(stateDir, items);
}

export function dropPermission(stateDir: string, key: string): boolean {
  const items = readAll(stateDir);
  if (!Object.hasOwn(items, key)) return false;
  delete items[key];
  writeAll(stateDir, items);
  return true;
}

/**
 * The host's hook when a prompt reaches the agent: the user's own next message (not the button's, not AIB's merge prompts) ends
 * the permission of the chat that works in `cwd`. Never throws.
 */
export function userPrompted(stateDir: string | null | undefined, cwd: unknown, text: unknown, clientMessageId: unknown): boolean {
  if (!stateDir) return false;
  if (isMergeRequest(text)) return false;
  if (typeof clientMessageId === 'string' && clientMessageId.startsWith('merge-')) return false;
  try {
    const record = wt.recordForPath(stateDir, cwd);
    return record ? dropPermission(stateDir, record.key) : false;
  } catch {
    return false;
  }
}
