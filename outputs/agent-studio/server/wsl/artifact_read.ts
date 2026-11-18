/**
 * Publish by `path` from a WSL chat (the artifact tools' `publish` / `update`): AIB on Windows cannot open the distro's files, so it
 * reads the file's bytes through the distro's helper (`files.readBytes`, in pieces of at most 1 MB, over the helper channel inside
 * Windows: only the short path travels through the MCP tunnel) and publishes them exactly as it publishes a Windows file (same kinds,
 * name rules, versioning and `fromDoc`). The artifact is a snapshot of the bytes at publish time; a later `update` with the path reads
 * it again. AIB keeps no link to the Linux file: no watcher, and Delete never touches it.
 *
 * Where a path may point (publishRoots, the one place that lists them): the chat's folder, plus its project's main folder for a chat in
 * its own worktree (where the local-only files such as private/ live):
 *   - relative: against the chat's Linux folder; a file the chat's folder does not have is looked up in the project folder too;
 *   - absolute: only inside one of those folders;
 *   - `..` that climbs out, and links that lead out (the helper checks the real path in the distro), are refused.
 * Every refusal is one line that names the Linux path and says what to do.
 */
import { insideLinux, normLinuxPath, refOf } from '../platform/location.ts';
import { ValueError } from '../core/py.ts';
import { kindFor, MAX_FILE_BYTES } from '../artifacts/artifacts.ts';
import { WslHelperError, type WslHost } from './contract.ts';
import { distroName, hostWhenReady, wslLoc } from './access.ts';

/** The largest piece one helper call carries (helper/methods.ts READ_BYTES_CHUNK). */
export const READ_CHUNK = 1024 * 1024;
const CALL_TIMEOUT_MS = 30_000;
/** How long a publish waits for a distro that is still starting. */
const READY_TIMEOUT_MS = 60_000;

/** A refusal with the HTTP status the publish route answers (the agent's tool shows the message). */
export class WslReadError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'wsl_read') {
    super(message);
    this.name = 'WslReadError';
  }
}

export interface WslSnapshot {
  data: Uint8Array;
  /** The file's real Linux path (links resolved). */
  linuxPath: string;
  /** Its file name (decides the kind, as for a Windows file). */
  name: string;
}

export interface WslReadTarget {
  /** The distro as the user names it ("Ubuntu"), for the messages. */
  distroName: string;
  /** The chat's Linux folder (its worktree, or the project folder). */
  chatFolder: string;
  /** The project's main Linux folder; null or the same as chatFolder when the chat works in place. */
  projectFolder: string | null;
  /** The largest file published (artifacts.ts MAX_FILE_BYTES). */
  maxBytes: number;
  /** The kind check by file name (artifacts.ts kindFor): null when the file cannot be shown. */
  kindOf(name: string): string | null;
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

/**
 * The Linux folders a WSL chat may publish files from, in the order a path is matched: its own folder first, then its project's main
 * folder. The one place to add more (the project's local-only or ignored folders the chat can reach).
 */
export function publishRoots(chatFolder: string, projectFolder: string | null): string[] {
  const roots = [chatFolder];
  if (projectFolder && projectFolder !== chatFolder) roots.push(projectFolder);
  return roots;
}

/** A path as the agent gave it, made absolute (relative: against `base`) with `.` and `..` worked out; null when `..` climbs past '/'. */
export function absoluteLinux(raw: string, base: string): string | null {
  const parts: string[] = [];
  for (const part of (raw.startsWith('/') ? raw : `${base}/${raw}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return normLinuxPath('/' + parts.join('/'));
}

/** [root, rel] for an absolute Linux path inside one of the roots (the first that holds it), or null. */
function placeIn(path: string, roots: string[]): [string, string] | null {
  for (const root of roots) {
    if (path === root) return [root, ''];
    if (insideLinux(path, root)) return [root, path.slice(root === '/' ? 1 : root.length + 1)];
  }
  return null;
}

/** The refusal for a helper error about `shown` (the path as the agent will recognise it). */
function refusal(error: unknown, shown: string, target: WslReadTarget, where: string): WslReadError {
  if (error instanceof WslReadError) return error;
  const name = target.distroName;
  if (!(error instanceof WslHelperError)) {
    return new WslReadError(`AIB could not read ${shown} in ${name}: ${error instanceof Error ? error.message : String(error)}`, 500, 'read_failed');
  }
  switch (error.code) {
    case 'not_found':
      return new WslReadError(`File not found in ${name}: ${shown}. Check the path (relative paths start at ${where}).`, 404, 'not_found');
    case 'outside':
      return new WslReadError(
        `Refused: ${shown} leads outside ${where} through a link, and AIB publishes only files inside it. Copy the file into the folder and publish the copy.`,
        403,
        'outside_project',
      );
    case 'not_file':
      return new WslReadError(`${shown} is a folder, not a file: publish one file inside it.`, 400, 'not_file');
    case 'hidden':
      return new WslReadError(`Refused: ${shown} is inside .git, which AIB never publishes from.`, 403, 'hidden');
    case 'bad_path':
      return new WslReadError(`AIB cannot publish ${shown}: ${error.message}.`, 400, 'bad_path');
    case 'missing':
    case 'bad_root':
      return new WslReadError(`AIB cannot read ${shown}: ${where} is not there in ${name}.`, 404, 'not_found');
    case 'too_large': {
      const size = Number(/(\d+) bytes/.exec(error.message)?.[1] ?? NaN);
      const was = Number.isFinite(size) ? ` (${mb(size)})` : '';
      return new WslReadError(`${shown} is too large to publish${was}: the limit is ${mb(target.maxBytes)}.`, 413, 'too_large');
    }
    case 'unreadable':
      return new WslReadError(`AIB cannot read ${shown} in ${name}: permission denied. Make it readable for your Linux user, then publish again.`, 403, 'unreadable');
    case 'unknown_method':
    case 'no_method':
    case '-32601':
      return new WslReadError(
        `The AIB helper running in ${name} is older than this AIB and cannot read files for publish. Reconnect ${name} (Settings > AIB Linking) or restart AIB, then publish again; until then publish text by \`content\`.`,
        409,
        'helper_old',
      );
    case 'timeout':
    case 'helper_gone':
    case 'helper_exited':
    case 'helper_timeout':
    case 'stopped':
      return new WslReadError(`AIB lost its connection to ${name} while reading ${shown} (${error.message}). Try again in a moment.`, 503, 'wsl_unavailable');
    default:
      return new WslReadError(`AIB could not read ${shown} in ${name}: ${error.message}`, 400, error.code || 'read_failed');
  }
}

/**
 * Read the file a WSL chat's agent named, through the distro's helper. Throws WslReadError (one line naming the Linux path) for a
 * path outside the chat's folders, a missing file, a folder, a file over the limit, a kind AIB cannot show, or a read that failed.
 */
export async function readWslSnapshot(host: Pick<WslHost, 'call'>, target: WslReadTarget, raw: unknown): Promise<WslSnapshot> {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0') || raw.length > 4096) {
    throw new WslReadError('`path` must be a file path (relative to the chat folder, or absolute inside it)', 400, 'bad_path');
  }
  const given = raw.trim();
  const chat = normLinuxPath(target.chatFolder);
  if (!chat) throw new WslReadError("This chat's Linux folder is not known, so AIB cannot read files for it.", 404, 'unknown_folder');
  const project = target.projectFolder ? normLinuxPath(target.projectFolder) : null;
  const roots = publishRoots(chat, project);
  const where = roots.length > 1 ? `the chat's folder ${chat} (or its project folder ${roots.slice(1).join(', ')})` : `the chat's folder ${chat}`;
  if (given.startsWith('~')) {
    throw new WslReadError(`Give ${given} relative to the chat folder or as a full path: AIB publishes only files inside ${where}.`, 400, 'bad_path');
  }
  if (/^[A-Za-z]:[\\/]/.test(given) || given.startsWith('\\\\')) {
    throw new WslReadError(`${given} is a Windows path: in a WSL project give the file's Linux path inside ${where}.`, 400, 'bad_path');
  }
  const abs = absoluteLinux(given, chat);
  const place = abs ? placeIn(abs, roots) : null;
  if (!abs || !place) {
    throw new WslReadError(
      `Refused: ${abs ?? given} is outside ${where}. AIB publishes only files inside it; copy the file there first, or publish text by \`content\`.`,
      403,
      'outside_project',
    );
  }
  const name = abs.slice(abs.lastIndexOf('/') + 1);
  // checked once the helper said it is a file (a folder gets its own answer), before more than the first piece is read
  const kindOk = () => {
    if (target.kindOf(name) !== null) return;
    throw new WslReadError(
      `${abs} cannot be shown as an artifact: publish an .html, .svg, .md, .png, .jpg, .gif, .webp, .pdf, .csv, .json, .txt or .log file.`,
      400,
      'unsupported_kind',
    );
  };
  // a relative path the chat's own copy does not have: the project folder's file of that name (its local-only files)
  const tries: [string, string][] = [place];
  if (!given.startsWith('/') && place[0] === chat) {
    for (const root of roots.slice(1)) {
      const there = absoluteLinux(given, root);
      const other = there ? placeIn(there, [root]) : null;
      if (other) tries.push(other);
    }
  }
  let last: unknown = null;
  for (const [root, rel] of tries) {
    try {
      return await readWslBytes(host, root, rel, target.maxBytes, kindOk);
    } catch (error) {
      last = error;
      if (!(error instanceof WslHelperError && error.code === 'not_found')) break;
    }
  }
  throw refusal(last, abs, target, where);
}

/** The whole file in pieces; the size and mtime must stay the same from the first piece to the last. */
/** A whole file of a WSL folder through the helper (files.readBytes in 1 MB pieces; a change between pieces: WslReadError). */
export async function readWslBytes(host: Pick<WslHost, 'call'>, root: string, rel: string, maxBytes: number, kindOk: () => void): Promise<WslSnapshot> {
  const first = await host.call('files.readBytes', { root, rel, offset: 0, length: READ_CHUNK, maxBytes }, { timeoutMs: CALL_TIMEOUT_MS });
  kindOk();
  const size = first.size, mtime = first.mtimeMs;
  if (!Number.isInteger(size) || size < 0 || size > maxBytes) throw new WslHelperError(`Too large: ${size} bytes`, 'too_large');
  const shown = first.abs || `${root}/${rel}`;
  const changed = () => new WslReadError(`${shown} changed while AIB read it; publish again once it is written.`, 409, 'changed');
  const data = new Uint8Array(size);
  let at = put(data, 0, first.bytesB64, changed);
  while (at < size) {
    const piece = await host.call('files.readBytes', { root, rel, offset: at, length: READ_CHUNK, maxBytes }, { timeoutMs: CALL_TIMEOUT_MS });
    if (piece.size !== size || piece.mtimeMs !== mtime) throw changed();
    const next = put(data, at, piece.bytesB64, changed);
    if (next === at) break;
    at = next;
  }
  if (at !== size) throw changed();
  return { data, linuxPath: shown, name: shown.slice(shown.lastIndexOf('/') + 1) };
}

/** Decode a base64 piece into data at `at`; returns the new end (a piece that would overflow means the file grew). */
function put(data: Uint8Array, at: number, b64: string, changed: () => WslReadError): number {
  const text = atob(b64 || '');
  if (at + text.length > data.length) throw changed();
  for (let i = 0; i < text.length; i++) data[at + i] = text.charCodeAt(i);
  return at + text.length;
}

/** What the publish route hands artifacts.ts (under WSL_FILE_RESOLVED): the bytes, the file name, and the file's ref. */
export interface WslPublishFile {
  data: Uint8Array;
  name: string;
  /** wsl://<distro><real Linux path>: the same file published again is the same artifact. */
  ref: string;
  linuxPath: string;
}

/**
 * The publish route's step for a WSL chat that gave a `path`: `folderRef` is the chat's folder (a wsl:// ref), `projectRef` its
 * project's main folder when it works in its own worktree. Waits for the distro if it is starting; throws WslReadError.
 */
export async function wslPublishFile(
  folderRef: string,
  projectRef: string | null,
  raw: unknown,
  host?: Pick<WslHost, 'call'>,
): Promise<WslPublishFile> {
  const chat = wslLoc(folderRef);
  if (!chat) throw new WslReadError("This chat's Linux folder is not known, so AIB cannot read files for it.", 404, 'unknown_folder');
  const project = wslLoc(projectRef);
  const name = distroName(chat.distro);
  let reader = host;
  if (!reader) {
    try {
      reader = await hostWhenReady(chat.distro, READY_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof ValueError) && !(error instanceof WslHelperError)) throw error;
      throw new WslReadError(`AIB cannot read files in ${name} right now: ${error.message}`, 503, 'wsl_unavailable');
    }
  }
  const snapshot = await readWslSnapshot(reader, {
    distroName: name,
    chatFolder: chat.linuxPath,
    projectFolder: project && project.distro === chat.distro ? project.linuxPath : null,
    maxBytes: MAX_FILE_BYTES,
    kindOf: kindFor,
  }, raw);
  return { data: snapshot.data, name: snapshot.name, linuxPath: snapshot.linuxPath, ref: refOf({ kind: 'wsl', distro: chat.distro, linuxPath: snapshot.linuxPath }) };
}
