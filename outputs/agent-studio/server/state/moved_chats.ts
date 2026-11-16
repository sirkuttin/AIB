/**
 * The moved-chat mapping, read only: `<AIB data>\studio-moved-chats.json`, {version, chats: {provider:sessionId: {project, ...}}}.
 *
 * Old "copy" chats (a chat that worked in its own worktree, before every chat worked in the project folder) are moved to their
 * project folder by the owner's one-off migration script (work/migrate/folder_chats_migrate.ts, run with AIB quit), which writes this
 * file. AIB only reads it, for two things the script cannot reach:
 *   - connect: a page or a link that still sends the old copy path opens the chat in the project folder (read before the
 *     "workspace removed" test, since the copy's removed-note stays);
 *   - the saved-chat list says `movedToFolder`, so a browser that remembered the chat as discarded (localStorage, chat.js) lets it
 *     continue.
 */
import { readJsonFile } from './json.ts';
import { pathOf } from './paths.ts';
import { isDict } from '../core/py.ts';

export const MOVED_FILE = 'studio-moved-chats.json';

export interface MovedChat {
  /** The project folder the chat now works in (a WSL chat: its distro ref). */
  project: string;
  /** The copy folder it worked in before. */
  from: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** {provider:sessionId: MovedChat}; anything malformed reads as empty. */
export function readMoved(stateDir: string): Record<string, MovedChat> {
  const [status, raw] = readJsonFile(pathOf(stateDir, MOVED_FILE));
  const out: Record<string, MovedChat> = {};
  const chats = status === 'ok' && isDict(raw) && isDict(raw.chats) ? raw.chats : {};
  for (const [k, v] of Object.entries(chats)) {
    if (!isDict(v) || !str(v.project)) continue;
    Object.defineProperty(out, k, { value: { project: str(v.project), from: str(v.from) }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The project folder a saved chat moved into (null: it did not move). */
export function movedTo(stateDir: string, provider: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const found = readMoved(stateDir)[`${provider}:${sessionId}`];
  return found ? found.project : null;
}
