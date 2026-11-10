/**
 * The few pathlib / shutil behaviours the ported stores rely on, so a value the Python server would store is stored the same:
 * Path.expanduser(), Path.is_absolute(), str(Path(...)) (separator and '.' normalisation), Path.is_file(), Path.resolve() of an
 * existing file, os.access(X_OK) and shutil.which() as Python 3.11 does them (Windows: current folder first, PATHEXT).
 */
const WIN = Deno.build.os === 'windows';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC';

function isSep(ch: string | undefined): boolean {
  return ch === '/' || (WIN && ch === '\\');
}

/** [drive, root, rest] as pathlib splits a path (Windows: 'C:' or '\\server\share' drives). */
function splitRoot(path: string): [string, string, string] {
  if (WIN) {
    const p = path.replaceAll('/', '\\');
    const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(p);
    if (unc) return [unc[0], '\\', p.slice(unc[0].length)];
    const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? '';
    const rest = p.slice(drive.length);
    return rest.startsWith('\\') ? [drive, '\\', rest] : [drive, '', rest];
  }
  if (path.startsWith('//') && !path.startsWith('///')) return ['', '//', path.slice(2)];
  return path.startsWith('/') ? ['', '/', path] : ['', '', path];
}

/** str(pathlib.Path(path)): one separator style, no empty or '.' parts, no trailing separator; '.' for an empty path. */
export function pathStr(path: string): string {
  const [drive, root, rest] = splitRoot(path);
  const parts = rest.split(WIN ? '\\' : '/').filter((part) => part !== '' && part !== '.');
  const text = drive + root + parts.join(WIN ? '\\' : '/');
  return text || '.';
}

/** pathlib.Path(path).is_absolute(): Windows needs a drive and a root. */
export function isAbsolute(path: string): boolean {
  const [drive, root] = splitRoot(path);
  return WIN ? !!drive && !!root : !!root;
}

function home(): string | undefined {
  if (WIN) {
    const profile = Deno.env.get('USERPROFILE');
    if (profile) return profile;
    const drive = Deno.env.get('HOMEDRIVE') ?? '';
    const homePath = Deno.env.get('HOMEPATH');
    return homePath ? drive + homePath : undefined;
  }
  return Deno.env.get('HOME');
}

/**
 * Path.expanduser(): a leading '~' (or '~user' on Windows, as ntpath does it) becomes the home folder. Python raises RuntimeError
 * when no home folder is known or for '~user' on POSIX (it looks the user up); here the path is then returned unchanged.
 */
export function expandUser(path: string): string {
  if (!path.startsWith('~')) return path;
  let end = 1;
  while (end < path.length && !isSep(path[end])) end++;
  let base = home();
  if (base === undefined) return path;
  if (end !== 1) {
    if (!WIN) return path;
    const user = path.slice(1, end);
    const separator = Math.max(base.lastIndexOf('\\'), base.lastIndexOf('/'));
    if (user !== base.slice(separator + 1)) base = base.slice(0, Math.max(separator, 0)) + '\\' + user;
  }
  return pathStr(base + path.slice(end));
}

/**
 * os.stat(path): follows links, except that on Windows a reparse point the system cannot follow (an app execution alias such as
 * WindowsApps\wt.exe, os error 1920) gives the link's own stat, as Python's os.stat does.
 */
export function pyStat(path: string): Deno.FileInfo {
  try {
    return Deno.statSync(path);
  } catch (error) {
    if (WIN && error instanceof Error && /\(os error 1920\)/.test(error.message)) return Deno.lstatSync(path);
    throw error;
  }
}

/** Path.is_file(): follows links, false on any error. */
export function isFile(path: string): boolean {
  try {
    return pyStat(path).isFile;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return pyStat(path).isDirectory;
  } catch {
    return false;
  }
}

/** os.access(path, os.X_OK): always true for an existing file on Windows; any execute bit elsewhere. */
export function executable(path: string): boolean {
  try {
    const info = pyStat(path);
    return WIN || ((info.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** str(Path(path).resolve()) for an existing path: the real path (links and '..' resolved, the case the file system stores). */
export function resolvePath(path: string): string {
  return Deno.realPathSync(path);
}

function ntJoin(dir: string, file: string): string {
  if (!dir) return file;
  if (WIN) return /[\\/]$/.test(dir) || /^[A-Za-z]:$/.test(dir) ? dir + file : `${dir}\\${file}`;
  return dir.endsWith('/') ? dir + file : `${dir}/${file}`;
}

/** shutil.which(cmd) of Python 3.11 (mode F_OK | X_OK). */
export function which(cmd: string): string | null {
  const access = (name: string) => executable(name) && !isDir(name);
  if (WIN ? /[\\/]|^[A-Za-z]:/.test(cmd) : cmd.includes('/')) { // os.path.dirname(cmd) is not empty
    return access(cmd) ? cmd : null;
  }
  const pathVar = Deno.env.get('PATH') ?? (WIN ? '.;C:\\bin' : '/bin:/usr/bin');
  if (!pathVar) return null;
  const dirs = pathVar.split(WIN ? ';' : ':');
  let files = [cmd];
  if (WIN) {
    if (!dirs.includes('.')) dirs.unshift('.');
    const pathext = (Deno.env.get('PATHEXT') || DEFAULT_PATHEXT).split(';').filter((ext) => ext);
    files = pathext.some((ext) => cmd.toLowerCase().endsWith(ext.toLowerCase())) ? [cmd] : pathext.map((ext) => cmd + ext);
  }
  const seen = new Set<string>();
  for (const dir of dirs) {
    const norm = WIN ? dir.replaceAll('/', '\\').toLowerCase() : dir;
    if (seen.has(norm)) continue;
    seen.add(norm);
    for (const file of files) {
      const name = ntJoin(dir, file);
      if (access(name)) return name;
    }
  }
  return null;
}
