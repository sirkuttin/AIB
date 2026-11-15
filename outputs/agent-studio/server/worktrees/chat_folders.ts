/** Folder and branch lookups for a chat: the Changes view's folder, the artifact folder, the repository branch (chat_folders.py). */
import { docRows } from '../docs/rows.ts';
import { clip, isDict, isStr, ValueError } from '../core/py.ts';
import { isNetworkPath, tokenMatches } from '../web/security.ts';
import { isForeignPath } from '../platform/location.ts';
import * as osp from '../platform/ospath.ts';
import * as changes from './changes.ts';
import * as worktrees from './worktrees.ts';
import { WslHelperError } from '../wsl/contract.ts';
import { notReady, wslHost, wslLoc } from '../wsl/access.ts';
import { parseWslSessionKey, wslSessionCwd } from '../wsl/transcripts.ts';

/** Name of the checked-out branch of the repository holding cwd, read from HEAD (no subprocess); '' when unknown. Detached: short id. */
export function repoBranch(cwd: unknown): string {
  // a UNC path would make Windows authenticate to that server; a WSL ref is read by its distro's helper (branchOf), never here
  if (!cwd || !isStr(cwd) || isNetworkPath(cwd) || isForeignPath(cwd) || wslLoc(cwd)) return '';
  try {
    const start = osp.realpath(cwd);
    const folders = [start];
    for (let current = start; folders.length < 13;) {
      const parent = osp.dirname(current);
      if (parent === current) break;
      folders.push(parent);
      current = parent;
    }
    for (const folder of folders) {
      const marker = osp.join(folder, '.git');
      let meta: string;
      if (osp.isfile(marker)) {
        const match = /^gitdir:\s*(.+)/.exec(readText(marker).trim());
        if (!match) return '';
        meta = match[1].trim();
        if (!osp.isabs(meta)) meta = osp.join(folder, meta);
      } else if (osp.isdir(marker)) {
        meta = marker;
      } else {
        continue;
      }
      const head = readText(osp.join(meta, 'HEAD')).trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref ? clip(ref[1], 80) : clip(head, 7);
    }
  } catch {
    return '';
  }
  return '';
}

/** repoBranch, and for a WSL project's ref the helper's `chat.repoBranch` in its distro ('' when unknown or the distro is not ready). */
export async function branchOf(cwd: unknown): Promise<string> {
  const wsl = wslLoc(cwd);
  if (!wsl) return repoBranch(cwd);
  const host = wslHost(wsl.distro);
  if (notReady(host, wsl.distro)) return '';
  try {
    const found = await host!.call('chat.repoBranch', { folder: wsl.linuxPath });
    return found.branch ? clip(found.branch, 80) : '';
  } catch {
    return '';
  }
}

function readText(path: string): string {
  return new TextDecoder().decode(Deno.readFileSync(path));
}

type Entries = Record<string, Record<string, unknown>> | Map<string, Record<string, unknown>>;

/** The parts of a Studio these lookups read. */
export interface ChatStudio {
  /** studio.live_state(ident, limit): a live connection's state ({cwd, ...}); {} or null for an unknown id. */
  liveState(ident: string, limit: number): unknown;
  conversations?: { entries?: Entries } | null;
  store?: { conversations?: Entries } | null;
  /** A Studio's own saved-transcript lookup: (provider, sessionId) -> project folder or ''. */
  savedCwd?: ((provider: string, sessionId: string) => string) | null;
  token?: string;
  stateDir?: string | null;
}

function entryOf(entries: Entries | undefined | null, key: string): Record<string, unknown> {
  if (!entries) return {};
  const value = entries instanceof Map ? entries.get(key) : Object.hasOwn(entries, key) ? entries[key] : undefined;
  return isDict(value) ? value : {};
}

/** Set by the server: (provider, sessionId) -> project folder of a saved transcript, or ''. */
export const defaults: { savedCwd: ((provider: string, sessionId: string) => string) | null } = { savedCwd: null };

/**
 * The folder behind a chat id for the Changes view: a live connection id, or a 'provider:sessionId' conversation key. Only folders
 * Studio already knows from its own connections and saved conversations qualify; nothing from the request is used as a path.
 */
export async function changesFolder(studio: ChatStudio, ident: unknown): Promise<string | null> {
  if (!isStr(ident) || !ident || ident.length > 600) throw new ValueError('Choose a chat');
  const state = await studio.liveState(ident, 10 ** 9);
  let cwd = isDict(state) && isStr(state.cwd) ? state.cwd : '';
  if (!cwd) {
    const fromMarks = entryOf(studio.conversations?.entries, ident).cwd;
    const fromStore = entryOf(studio.store?.conversations, ident).cwd;
    cwd = (isStr(fromMarks) && fromMarks) || (isStr(fromStore) && fromStore) || '';
  }
  const lookup = studio.savedCwd || defaults.savedCwd; // a Studio's own lookup, else the module default
  if (!cwd && lookup && /^[a-z0-9_-]+:/.test(ident)) {
    // A saved chat Studio only reads (not one it runs): the folder its transcript is filed under, as the chat list shows.
    const at = ident.indexOf(':');
    cwd = lookup(ident.slice(0, at), ident.slice(at + 1)) || '';
  }
  if (!cwd && /^(claude|codex):/.test(ident)) {
    // A saved chat of a WSL project: its transcript is inside the distro, so the Windows lookup above finds nothing
    const at = ident.indexOf(':');
    cwd = await wslSessionCwd(ident.slice(0, at), ident.slice(at + 1)).catch(() => '');
  }
  const keyed = !cwd ? parseWslSessionKey(ident) : null; // the same chat named by its transcript key (wsl.<distro>.<provider>/<key>)
  if (keyed) cwd = await wslSessionCwd(keyed.provider, keyed.key.replace(/\.jsonl$/, '').split('/').pop() ?? '').catch(() => '');
  if (!cwd) return null;
  if (wslLoc(cwd)) return cwd; // a WSL project's ref: its distro's helper checks the folder (Windows never stats it)
  if (!osp.isdir(cwd)) return null;
  return cwd;
}

/** Project folder of a chat for artifacts (same rule as the Changes view); null when unknown. */
export async function artifactFolder(studio: ChatStudio, ident: unknown): Promise<string | null> {
  try {
    const folder = await changesFolder(studio, ident);
    return folder && wslLoc(folder) ? null : folder; // phase 1: no artifacts from a WSL project's files
  } catch (error) {
    if (error instanceof ValueError) return null;
    throw error;
  }
}

type HeaderSource = Headers | Record<string, string | undefined>;

function header(headers: HeaderSource, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return (key !== undefined ? headers[key] : '') ?? '';
}

const first = (args: Record<string, string[] | undefined>, name: string, fallback: string) => args[name]?.[0] ?? fallback;

/**
 * GET /api/live/changes and /api/live/changes/file: [status, payload]. Needs the Studio token like a POST. `args` is the parsed
 * query string (name -> values, as parse_qs). Throws ValueError for a missing chat id (the route answers 400).
 */
export async function changesResponse(
  studio: ChatStudio,
  path: string,
  args: Record<string, string[] | undefined>,
  headers: HeaderSource,
): Promise<[number, unknown]> {
  if (!tokenMatches(header(headers, 'X-Studio-Token'), studio.token)) return [403, { error: 'Invalid local session token' }];
  const cwd = await changesFolder(studio, first(args, 'id', ''));
  if (cwd === null) return [404, { error: 'This chat has no known project folder.', code: 'unknown_folder' }];
  const scope = first(args, 'scope', 'uncommitted');
  if (scope !== 'uncommitted' && scope !== 'branch') {
    return [400, { error: 'Only the uncommitted and branch scopes exist.', code: 'bad_scope' }];
  }
  if (wslLoc(cwd)) return await wslChanges(cwd, path, scope, args);
  // A chat in its own Studio worktree always gets the branch view (its agent commits); every other chat keeps the uncommitted one.
  const record = worktrees.recordForPath(studio.stateDir ?? null, cwd);
  const base = worktrees.diffBase(record);
  if (scope === 'branch' && !base) return [400, { error: 'This chat has no branch of its own.', code: 'bad_scope' }];
  try {
    if (path === '/api/live/changes/file') return [200, await changes.getFileDiff(cwd, first(args, 'path', ''), base || null)];
    const offset = first(args, 'offset', '0');
    const result = await changes.getChanges(cwd, base || null, /^\d+$/.test(offset) ? Number(offset) : 0);
    if (record && result.git) result.worktree = { branch: isStr(record.branch) ? record.branch : '' }; // the page offers Discard
    if (result.git && Array.isArray(result.files)) {
      // a doc's files show as one row "2 pages changed" (docs/rows.ts); its paths are listed there, not as files
      const docs = docRows(String(result.root), (result.files as { path: string }[]).map((f) => f.path));
      if (docs.length) (result as unknown as Record<string, unknown>).docs = docs;
    }
    return [200, result];
  } catch (error) {
    if (error instanceof changes.ChangesError) return [400, { error: error.message, code: error.code }];
    throw error;
  }
}

/**
 * The Changes view of a WSL chat (design section 4): the same answers, from worktrees/changes.ts running in the distro's helper
 * (`changes.get`, `changes.diff`). A chat in its own worktree (its record is in the distro: `worktree.find`) gets the branch view
 * against its diff base, Discard and Merge, as on Windows (the merge runs in the helper too: wsl/merge.ts).
 */
async function wslChanges(ref: string, path: string, scope: string, args: Record<string, string[] | undefined>): Promise<[number, unknown]> {
  const wsl = wslLoc(ref)!;
  const host = wslHost(wsl.distro);
  const why = notReady(host, wsl.distro);
  if (why) return [409, { error: why, code: 'wsl_unavailable' }];
  let record: Record<string, unknown> | null = null;
  try {
    record = (await host!.call('worktree.find', { path: wsl.linuxPath })).record;
  } catch { /* a helper without worktrees: the chat works in place */ }
  const base = worktrees.diffBase(record);
  if (scope === 'branch' && !base) return [400, { error: 'This chat has no branch of its own.', code: 'bad_scope' }];
  try {
    if (path === '/api/live/changes/file') {
      return [200, await host!.call('changes.diff', { folder: wsl.linuxPath, path: first(args, 'path', ''), ...(base ? { base } : {}) })];
    }
    const offset = first(args, 'offset', '0');
    const result = await host!.call('changes.get', {
      folder: wsl.linuxPath,
      offset: /^\d+$/.test(offset) ? Number(offset) : 0,
      ...(base ? { base } : {}),
    }) as Record<string, unknown>;
    if (record && result && result.git) result.worktree = { branch: isStr(record.branch) ? record.branch : '' }; // Discard and Merge
    return [200, result];
  } catch (error) {
    if (error instanceof WslHelperError) return [400, { error: error.message, code: error.code }];
    throw error;
  }
}
