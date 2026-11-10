/**
 * The pathlib behaviour the transcript viewer relies on: PureWindowsPath / PurePosixPath parsing (str, parents, name, anchor),
 * and native-path helpers (join, resolve, relative_to, suffix/stem) that compare case-insensitively on Windows as pathlib does.
 */

export const WINDOWS = Deno.build.os === 'windows';
export const SEP = WINDOWS ? '\\' : '/';

export interface PurePath {
  drive: string;
  root: string;
  parts: string[]; // without the anchor
  windows: boolean;
}

function splitWindowsRoot(part: string): [string, string, string] {
  const sep = '\\';
  let prefix = '';
  let first = part.slice(0, 1);
  let second = part.slice(1, 2);
  if (second === sep && first === sep) {
    // \\?\ and \\.\ extended paths
    const ext = part.startsWith('\\\\?\\') ? '\\\\?\\' : '';
    if (ext) {
      prefix = ext;
      part = part.slice(4);
      if (part.slice(0, 4).toUpperCase() === 'UNC\\') {
        prefix += part.slice(0, 3);
        part = '\\' + part.slice(3);
      }
      first = part.slice(0, 1);
      second = part.slice(1, 2);
    }
  }
  const third = part.slice(2, 3);
  if (second === sep && first === sep && third !== sep) {
    const index = part.indexOf(sep, 2);
    if (index !== -1) {
      let index2 = part.indexOf(sep, index + 1);
      if (index2 !== index + 1) {
        if (index2 === -1) index2 = part.length;
        if (prefix) return [prefix + part.slice(1, index2), sep, part.slice(index2 + 1)];
        return [part.slice(0, index2), sep, part.slice(index2 + 1)];
      }
    }
  }
  let drv = '';
  let root = '';
  if (second === ':' && /^[A-Za-z]$/.test(first)) {
    drv = part.slice(0, 2);
    part = part.slice(2);
    first = third;
  }
  if (first === sep) {
    root = first;
    part = part.replace(/^\\+/, '');
  }
  return [prefix + drv, root, part];
}

/** PureWindowsPath(text) / PurePosixPath(text). */
export function purePath(text: string, windows: boolean): PurePath {
  if (windows) {
    const [drive, root, rest] = splitWindowsRoot(text.replaceAll('/', '\\'));
    return { drive, root, parts: rest.split('\\').filter((p) => p && p !== '.'), windows };
  }
  let root = '';
  let rest = text;
  if (text.startsWith('/')) {
    const stripped = text.replace(/^\/+/, '');
    root = text.length - stripped.length === 2 ? '//' : '/';
    rest = stripped;
  }
  return { drive: '', root, parts: rest.split('/').filter((p) => p && p !== '.'), windows };
}

export function pureStr(p: PurePath): string {
  const sep = p.windows ? '\\' : '/';
  const anchor = p.drive + p.root;
  if (anchor) return anchor + p.parts.join(sep);
  return p.parts.length ? p.parts.join(sep) : '.';
}

export function pureAnchor(p: PurePath): string {
  return p.drive + p.root;
}

/** path.parents, nearest first. */
export function pureParents(p: PurePath): PurePath[] {
  const out: PurePath[] = [];
  for (let n = p.parts.length - 1; n >= 0; n--) out.push({ ...p, parts: p.parts.slice(0, n) });
  return out;
}

export function pureName(p: PurePath): string {
  return p.parts.length ? p.parts[p.parts.length - 1] : '';
}

// ---- native paths (strings) -----------------------------------------------------------------

export function nativePath(text: string): PurePath {
  return purePath(text, WINDOWS);
}

/** Path(a) / b / c as a native string. */
export function join(base: string, ...more: string[]): string {
  let p = nativePath(base);
  for (const piece of more) {
    const q = nativePath(piece);
    if (q.root || q.drive) {
      if (WINDOWS && !q.drive) p = { ...q, drive: p.drive };
      else p = q;
    } else p = { ...p, parts: [...p.parts, ...q.parts] };
  }
  return pureStr(p);
}

export function name(path: string): string {
  return pureName(nativePath(path));
}

export function parent(path: string): string {
  const p = nativePath(path);
  return pureStr({ ...p, parts: p.parts.slice(0, -1) });
}

/** PurePath.suffix */
export function suffix(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 && i < fileName.length - 1 ? fileName.slice(i) : '';
}

/** PurePath.stem */
export function stem(fileName: string): string {
  const s = suffix(fileName);
  return s ? fileName.slice(0, -s.length) : fileName;
}

/** path.with_suffix('') */
export function withoutSuffix(path: string): string {
  const n = name(path);
  const s = suffix(n);
  return s ? path.slice(0, path.length - s.length) : path;
}

const fold = (part: string) => (WINDOWS ? part.toLowerCase() : part);

/** Parts of `path` below `root`, or null when it is not inside (pathlib.relative_to / is_relative_to). */
export function relativeParts(path: string, root: string): string[] | null {
  const a = nativePath(path);
  const b = nativePath(root);
  if (fold(a.drive) !== fold(b.drive) || a.root !== b.root || a.parts.length < b.parts.length) return null;
  for (let i = 0; i < b.parts.length; i++) if (fold(a.parts[i]) !== fold(b.parts[i])) return null;
  return a.parts.slice(b.parts.length);
}

export function isRelativeTo(path: string, root: string): boolean {
  return relativeParts(path, root) !== null;
}

/** Path equality (case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  const x = relativeParts(a, b);
  return x !== null && x.length === 0 && nativePath(a).parts.length === nativePath(b).parts.length;
}

function lexical(path: string): string {
  const p = nativePath(path);
  const parts: string[] = [];
  for (const part of p.parts) {
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!pureAnchor(p)) parts.push(part);
    } else parts.push(part);
  }
  return pureStr({ ...p, parts });
}

/** Path.resolve() for a path that exists; null when it does not. */
export async function resolve(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    try {
      return await Deno.realPath(lexical(path));
    } catch {
      return null;
    }
  }
}

/** Path.resolve() (strict=False): the real path when it exists, else the lexical absolute path. */
export async function resolveLoose(path: string): Promise<string> {
  const real = await resolve(path);
  if (real !== null) return real;
  const p = nativePath(path);
  return lexical(pureAnchor(p) ? path : join(Deno.cwd(), path));
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** fnmatch of '*' + tail (pathlib glob: case-insensitive on Windows). */
export function endsWithName(fileName: string, tail: string): boolean {
  return WINDOWS ? fileName.toLowerCase().endsWith(tail.toLowerCase()) : fileName.endsWith(tail);
}

/** folder.glob(pattern) for '*<tail>': entries of one folder whose names match, in directory order. */
export async function globTail(folder: string, tail: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(folder)) if (endsWithName(entry.name, tail)) out.push(join(folder, entry.name));
  } catch { /* not a folder */ }
  return out;
}

/** folder.rglob('*<tail>') as pathlib 3.11 walks it: matches in a folder, then its subfolders (not through symlinked folders). */
export async function rglobTail(folder: string, tail: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const subdirs: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (endsWithName(entry.name, tail)) out.push(join(dir, entry.name));
        if (entry.isDirectory && !entry.isSymlink) subdirs.push(join(dir, entry.name));
      }
    } catch {
      return;
    }
    for (const sub of subdirs) await walk(sub);
  };
  await walk(folder);
  return out;
}

/** (size, mtime_ns, st_mtime, st_ctime-or-birthtime) of a file, the values Python's os.stat gives (to the millisecond). */
export interface StatSig {
  size: number;
  mtimeNs: bigint;
  mtime: number;
  created: number;
  isFile: boolean;
  isDirectory: boolean;
}

function secondsOf(ms: number): number {
  const sec = Math.floor(ms / 1000);
  const nsec = (ms - sec * 1000) * 1e6;
  return sec + nsec * 1e-9;
}

export async function statSig(path: string): Promise<StatSig> {
  const info = await Deno.stat(path);
  const ms = info.mtime ? info.mtime.getTime() : 0;
  const birth = info.birthtime?.getTime() ?? info.ctime?.getTime() ?? ms;
  return {
    size: info.size,
    mtimeNs: BigInt(Math.floor(ms / 1000)) * 1_000_000_000n + BigInt((ms - Math.floor(ms / 1000) * 1000) * 1e6),
    mtime: secondsOf(ms),
    created: secondsOf(WINDOWS || Deno.build.os === 'darwin' ? birth : (info.ctime?.getTime() ?? birth)),
    isFile: info.isFile,
    isDirectory: info.isDirectory,
  };
}
