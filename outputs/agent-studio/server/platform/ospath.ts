/**
 * os.path as Python 3.11 does it (ntpath on Windows, posixpath elsewhere), for the ported modules that compare, join and resolve
 * request paths the way the Python server does: normpath, normcase, isabs, splitdrive, dirname, basename, join, abspath, realpath
 * (non-strict: resolves what exists and keeps the missing tail), and the stat helpers that answer false instead of throwing.
 */
import { isAbsolute } from './pypath.ts';

export const WIN = Deno.build.os === 'windows';
export const SEP = WIN ? '\\' : '/';

function isSep(ch: string | undefined): boolean {
  return ch === '/' || (WIN && ch === '\\');
}

/** os.path.splitdrive: Windows 'C:' or '\\server\share'; '' elsewhere. */
export function splitdrive(path: string): [string, string] {
  if (!WIN) return ['', path];
  const p = path.replaceAll('/', '\\');
  if (p.startsWith('\\\\') && p[2] !== '\\') {
    const index = p.indexOf('\\', 2);
    if (index < 0) return [path, ''];
    let index2 = p.indexOf('\\', index + 1);
    if (index2 === index + 1) return ['', path];
    if (index2 < 0) index2 = p.length;
    return [path.slice(0, index2), path.slice(index2)];
  }
  if (p.length >= 2 && p[1] === ':') return [path.slice(0, 2), path.slice(2)];
  return ['', path];
}

/** os.path.isabs (Python 3.11 on Windows: needs a drive and a root, as pathlib). */
export function isabs(path: string): boolean {
  return isAbsolute(path);
}

/** os.path.normcase: lower case and backslashes on Windows; unchanged elsewhere. */
export function normcase(path: string): string {
  return WIN ? path.replaceAll('/', '\\').toLowerCase() : path;
}

/** os.path.normpath. */
export function normpath(path: string): string {
  if (WIN) {
    const p = path.replaceAll('/', '\\');
    const [drive, rest0] = splitdrive(p);
    let rest = rest0;
    let root = '';
    if (rest.startsWith('\\')) {
      root = '\\';
      rest = rest.replace(/^\\+/, '');
    }
    const parts: string[] = [];
    for (const part of rest.split('\\')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
        else if (!root) parts.push('..');
        continue;
      }
      parts.push(part);
    }
    const out = drive + root + parts.join('\\');
    return out || '.';
  }
  if (path === '') return '.';
  let initial = path.startsWith('/') ? 1 : 0;
  if (initial && path.startsWith('//') && !path.startsWith('///')) initial = 2;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..' || (!initial && !parts.length) || (parts.length && parts[parts.length - 1] === '..')) parts.push(part);
    else if (parts.length) parts.pop();
  }
  const out = '/'.repeat(initial) + parts.join('/');
  return out || '.';
}

/** os.path.split. */
export function split(path: string): [string, string] {
  const [drive, rest] = splitdrive(path);
  let i = rest.length;
  while (i && !isSep(rest[i - 1])) i--;
  const head = rest.slice(0, i);
  const tail = rest.slice(i);
  const stripped = head.replace(WIN ? /[\\/]+$/ : /\/+$/, '');
  return [drive + (stripped || head), tail];
}

export function dirname(path: string): string {
  return split(path)[0];
}

export function basename(path: string): string {
  return split(path)[1];
}

/** os.path.join. */
export function join(first: string, ...more: string[]): string {
  if (!WIN) {
    let out = first;
    for (const part of more) {
      if (part.startsWith('/')) out = part;
      else if (out === '' || out.endsWith('/')) out += part;
      else out += '/' + part;
    }
    return out;
  }
  let [resultDrive, resultPath] = splitdrive(first);
  for (const part of more) {
    const [drive, path] = splitdrive(part);
    if (path && isSep(path[0])) {
      if (drive || !resultDrive) resultDrive = drive;
      resultPath = path;
      continue;
    } else if (drive && drive !== resultDrive) {
      if (drive.toLowerCase() !== resultDrive.toLowerCase()) {
        resultDrive = drive;
        resultPath = path;
        continue;
      }
      resultDrive = drive;
    }
    if (resultPath && !isSep(resultPath[resultPath.length - 1])) resultPath += '\\';
    resultPath += path;
  }
  if (resultPath && !isSep(resultPath[0]) && resultDrive && resultDrive.slice(-1) !== ':') return resultDrive + '\\' + resultPath;
  return resultDrive + resultPath;
}

/** os.path.abspath. */
export function abspath(path: string): string {
  if (!isabs(path)) {
    if (WIN) {
      const [drive] = splitdrive(path);
      if (drive || path.startsWith('\\') || path.startsWith('/')) {
        // Drive-relative ('C:x') or root-relative ('\x'): GetFullPathName resolves against the current folder of that drive.
        const cwd = Deno.cwd();
        const [cwdDrive] = splitdrive(cwd);
        if (!drive) return normpath(cwdDrive + path);
        if (drive.toLowerCase() === cwdDrive.toLowerCase()) return normpath(join(cwd, path.slice(drive.length)));
        return normpath(drive + '\\' + path.slice(drive.length));
      }
    }
    path = join(Deno.cwd(), path);
  }
  return normpath(path);
}

/** os.path.realpath (strict=False): links resolved for the part that exists, the missing tail kept as written. */
export function realpath(path: string): string {
  const full = abspath(path);
  let head = full;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = Deno.realPathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const [parent, name] = split(head);
      if (parent === head || !name) return full;
      tail.push(name);
      head = parent;
    }
  }
}

function stat(path: string, follow = true): Deno.FileInfo | null {
  try {
    return follow ? Deno.statSync(path) : Deno.lstatSync(path);
  } catch {
    return null;
  }
}

export function exists(path: string): boolean {
  return stat(path) !== null;
}

export function isdir(path: string): boolean {
  return stat(path)?.isDirectory ?? false;
}

export function isfile(path: string): boolean {
  return stat(path)?.isFile ?? false;
}

export function islink(path: string): boolean {
  return stat(path, false)?.isSymlink ?? false;
}

/** os.path.getsize; throws like Python when the file is missing. */
export function getsize(path: string): number {
  return Deno.statSync(path).size;
}

/** os.path.commonpath for two absolute paths on the same drive (enough for an "is it inside" check); null when they differ. */
export function commonpath(a: string, b: string): string | null {
  const [da, ra] = splitdrive(a);
  const [db, rb] = splitdrive(b);
  if (normcase(da) !== normcase(db) || isSep(ra[0]) !== isSep(rb[0])) return null;
  const pa = ra.split(WIN ? /[\\/]/ : '/').filter((x) => x && x !== '.');
  const pb = rb.split(WIN ? /[\\/]/ : '/').filter((x) => x && x !== '.');
  const common: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (normcase(pa[i]) !== normcase(pb[i])) break;
    common.push(pa[i]);
  }
  return da + (isSep(ra[0]) ? SEP : '') + common.join(SEP);
}

/** Path.home(). */
export function home(): string {
  return (WIN ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME')) ?? Deno.cwd();
}
