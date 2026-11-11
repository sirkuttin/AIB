/**
 * Files OUTSIDE a chat's folder (Deno only): a file the chat's own tool calls or messages name, for instance one an agent wrote in
 * another git worktree. The Files view shows it read only, labelled "Outside this project". Nothing here writes.
 *
 * The request names the chat and the absolute path. It is accepted only when the path appears in that chat's own record: the live
 * connection's events, or the saved transcript (and its subagents' transcripts) for a 'provider:sessionId' chat, which covers
 * chats AIB discovered and did not start. Always refused: UNC, network and device paths (\\?\, \\.\, CON, NUL, COM1 ...), relative
 * paths, `..` parts, alternate data streams, anything inside AIB's own data folder (before and after links are resolved), folders,
 * and files that are not there. Files over 1 MB or binary are answered with the same flags as the in-folder read (the page shows its
 * note and "Open in editor").
 */
import * as osp from '../platform/ospath.ts';
import { isNetworkPath } from '../web/security.ts';
import { repoBranch } from './chat_folders.ts';
import { worktreeParent } from '../desktop/folders.ts';
import { extOf, type FileRead, FilesError, IMAGE_EXT, LIMITS, PAGE_EXT, within } from './files.ts';

const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
export const MAX_SCAN_BYTES = 64 * 1024 * 1024; // transcript text searched per chat
export const MAX_AGENT_FILES = 200;

/** The request's absolute path, checked for shape (not yet for existence). Throws FilesError. */
export function checkShape(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\0')) throw new FilesError('Invalid path', 'bad_path');
  const text = path.trim();
  if (isNetworkPath(text)) throw new FilesError('Network and device paths are not supported', 'bad_path');
  const winAbs = /^[A-Za-z]:[\\/]/.test(text), posixAbs = !osp.WIN && text.startsWith('/');
  if (!winAbs && !posixAbs) throw new FilesError('Use a full path', 'bad_path');
  if (osp.WIN && !winAbs) throw new FilesError('Use a full path', 'bad_path');
  const parts = text.slice(winAbs ? 3 : 1).split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (!parts.length) throw new FilesError('Choose a file', 'not_file');
  for (const p of parts) {
    if (p === '..') throw new FilesError('Invalid path', 'bad_path');
    if (p.includes(':')) throw new FilesError('Invalid path', 'bad_path'); // an alternate data stream
    if (DEVICE.test(p.replace(/[ .]+$/, ''))) throw new FilesError('Network and device paths are not supported', 'bad_path');
    if (p.toLowerCase() === '.git') throw new FilesError('Not shown', 'hidden');
  }
  return text;
}

const realOr = (p: string): string => {
  try {
    const r = Deno.realPathSync(p);
    return r.startsWith('\\\\?\\') ? r.slice(4) : r;
  } catch {
    return p;
  }
};

/** True when `path` is AIB's own data folder or inside it. */
export function inDataFolder(path: string, dataDirs: (string | null | undefined)[]): boolean {
  for (const d of dataDirs) {
    if (!d || isNetworkPath(d)) continue;
    if (within(path, d) || within(path, realOr(d))) return true;
  }
  return false;
}

/** The resolved file behind a checked path; refuses folders, missing files, links out to the network and AIB's data folder. */
export function resolveOutside(path: string, dataDirs: (string | null | undefined)[]): string {
  const given = osp.normpath(checkShape(path));
  if (inDataFolder(given, dataDirs)) throw new FilesError('Not shown', 'hidden', 403);
  let real: string;
  try {
    real = Deno.realPathSync(given);
  } catch {
    throw new FilesError('Not found', 'not_found', 404);
  }
  if (real.startsWith('\\\\?\\')) real = real.slice(4);
  if (isNetworkPath(real)) throw new FilesError('Network and device paths are not supported', 'bad_path');
  if (inDataFolder(real, dataDirs)) throw new FilesError('Not shown', 'hidden', 403);
  let st: Deno.FileInfo;
  try {
    st = Deno.statSync(real);
  } catch {
    throw new FilesError('Not found', 'not_found', 404);
  }
  if (!st.isFile) throw new FilesError('Not a file', 'not_file');
  return real;
}

// ---- the transcript-mention guard -----------------------------------------------------------------------------------------------
/** Every spelling of `path` a record may hold: as given, with the other slash, and JSON-escaped. Lower case on Windows. */
export function spellings(path: string): string[] {
  const p = osp.normpath(path);
  const fwd = p.replaceAll('\\', '/'), back = p.replaceAll('/', '\\');
  const out = new Set([p, fwd, back, back.replaceAll('\\', '\\\\'), fwd.replaceAll('/', '\\/')]);
  return [...out].map((s) => (osp.WIN ? s.toLowerCase() : s));
}

/** True when one of `texts` names `path` as a whole path (not as the start of a longer name). */
export function mentions(texts: Iterable<string>, path: string): boolean {
  const wanted = spellings(path);
  for (const raw of texts) {
    const t = osp.WIN ? raw.toLowerCase() : raw;
    for (const w of wanted) {
      let at = t.indexOf(w);
      while (at >= 0) {
        const next = t.charAt(at + w.length);
        if (!/[\w.\-]/.test(next)) return true;
        at = t.indexOf(w, at + 1);
      }
    }
  }
  return false;
}

/** The text of a chat's own record: live events, then saved transcripts (main and subagents), bounded. */
export interface ChatRecordSource {
  liveState?: (id: string) => Promise<unknown>;
  sessionFile?: (provider: string, sessionId: string) => Promise<string | null>;
}

function* jsonlBelow(folder: string, budget: { files: number }): Generator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(folder)];
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.files <= 0) return;
    const full = osp.join(folder, e.name);
    if (e.isDirectory) yield* jsonlBelow(full, budget);
    else if (e.isFile && e.name.endsWith('.jsonl')) {
      budget.files--;
      yield full;
    }
  }
}

export async function chatTexts(source: ChatRecordSource, id: string): Promise<string[]> {
  const out: string[] = [];
  let provider = '', sessionId = '';
  if (source.liveState) {
    try {
      const state = await source.liveState(id);
      if (state && typeof state === 'object') {
        out.push(JSON.stringify(state));
        const s = state as Record<string, unknown>;
        if (typeof s.provider === 'string' && typeof s.sessionId === 'string') [provider, sessionId] = [s.provider, s.sessionId];
      }
    } catch { /* not a live chat */ }
  }
  const m = /^([a-z0-9_-]+):(.+)$/.exec(id);
  if (!sessionId && m) [provider, sessionId] = [m[1], m[2]];
  if (provider && sessionId && source.sessionFile) {
    let file: string | null = null;
    try {
      file = await source.sessionFile(provider, sessionId);
    } catch {
      file = null;
    }
    if (file) {
      let budget = MAX_SCAN_BYTES;
      const read = (p: string) => {
        if (budget <= 0) return;
        try {
          const size = Deno.statSync(p).size;
          if (size > budget) return;
          budget -= size;
          out.push(new TextDecoder().decode(Deno.readFileSync(p)));
        } catch { /* gone meanwhile */ }
      };
      read(file);
      const folder = file.replace(/\.jsonl$/i, '');
      for (const p of jsonlBelow(folder, { files: MAX_AGENT_FILES })) read(p);
    }
  }
  return out;
}

// ---- the folder label ---------------------------------------------------------------------------------------------------------
export interface FolderLabel {
  kind: 'worktree' | 'repo' | 'folder';
  folder: string; // the file's folder
  top: string; // the repository's folder ('' outside git)
  branch: string;
  repo: string; // the main checkout's folder name, for a worktree
  text: string; // "⎇ branch · git worktree of repo", "⎇ branch", or the folder path
}

/** What AIB can tell about the folder a file sits in, without running git. */
export function folderLabel(file: string): FolderLabel {
  const folder = osp.dirname(file);
  let dir = folder;
  for (let i = 0; i < 40; i++) {
    const marker = osp.join(dir, '.git');
    if (osp.isfile(marker)) {
      const parent = worktreeParent(dir);
      const branch = (parent && parent[1]) || repoBranch(dir);
      const repo = parent ? osp.basename(osp.normpath(parent[0])) : '';
      if (repo) {
        return {
          kind: 'worktree',
          folder,
          top: dir,
          branch,
          repo,
          text: (branch ? '⎇ ' + branch + ' · ' : '') + 'git worktree of ' + repo,
        };
      }
      if (branch) return { kind: 'repo', folder, top: dir, branch, repo: '', text: '⎇ ' + branch };
      break;
    }
    if (osp.isdir(marker)) {
      const branch = repoBranch(dir);
      if (branch) return { kind: 'repo', folder, top: dir, branch, repo: '', text: '⎇ ' + branch };
      break;
    }
    const up = osp.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { kind: 'folder', folder, top: '', branch: '', repo: '', text: folder };
}

// ---- read ---------------------------------------------------------------------------------------------------------------------
/** The in-folder FileRead shape for an outside file (`path` is the absolute path), text only when small and not binary. */
export function readOutside(real: string, peek = false): FileRead {
  const st = Deno.statSync(real);
  const name = osp.basename(real), ext = extOf(name);
  const out: FileRead = {
    path: real,
    abs: real,
    name,
    size: st.size,
    mtime: st.mtime ? st.mtime.getTime() / 1000 : 0,
    binary: false,
    tooBig: st.size > LIMITS.readBytes,
    image: IMAGE_EXT.has(ext),
    page: PAGE_EXT.has(ext),
    text: null,
    lines: 0,
  };
  if (peek) return out;
  const file = Deno.openSync(real, { read: true });
  try {
    const buf = new Uint8Array(Math.max(0, out.tooBig ? LIMITS.probe : st.size));
    let got = 0;
    while (got < buf.length) {
      const n = file.readSync(buf.subarray(got));
      if (n === null) break;
      got += n;
    }
    const data = buf.subarray(0, got);
    out.binary = data.subarray(0, LIMITS.probe).includes(0);
    if (!out.binary && !out.tooBig && !(out.image && ext !== '.svg')) {
      out.text = new TextDecoder().decode(data);
      out.lines = out.text ? out.text.split('\n').length - (out.text.endsWith('\n') ? 1 : 0) : 0;
    }
  } finally {
    file.close();
  }
  return out;
}
