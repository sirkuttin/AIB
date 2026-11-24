/**
 * Where a project lives (docs/wsl/design.md sections 2 and 11): on this PC's own file system, or inside a WSL distro. A WSL project
 * is stored as its canonical ref `wsl://<distro><linuxPath>` (contract.ts WSL_REF_PREFIX), e.g. `wsl://ubuntu/home/u/app`: the distro
 * is case-folded when the ref is built, the Linux path stays case-sensitive. Everything here is pure string work: nothing reads the
 * disk, nothing opens `\\wsl$`, and a ref is never URL-parsed (`new URL` lowercases hosts and encodes spaces; a lint test checks it).
 *
 * The fail-closed rule: a "foreign" path (isForeignPath: a `wsl:` ref, or on Windows an absolute path without a drive such as
 * `/home/u`) never reaches Windows file APIs. Predicates answer false for one; only spawn, write and delete sites throw
 * (assertWindowsLocal). Without it `/home/u` on Windows would resolve to `C:\home\u`. Off Windows the drive rule does not apply
 * (the WSL helper imports the same modules and works with Linux paths natively).
 */
import { type Loc, WSL_REF_PREFIX } from '../wsl/contract.ts';

export type { Loc };
export type WslLoc = Extract<Loc, { kind: 'wsl' }>;

const WIN = Deno.build.os === 'windows';
const DISTRO = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_LINUX_PATH = 4096;
const WIN_LOC: Loc = Object.freeze({ kind: 'win' }) as Loc;

/**
 * A path AIB must not hand to this PC's file system: a `wsl:` ref (any case), or on Windows an absolute path with no drive
 * (`/home/u`; `//server` stays isNetworkPath's). Never throws.
 */
export function isForeignPath(value: unknown, windows = WIN): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (/^wsl:/i.test(text)) return true;
  return windows && text.startsWith('/') && text[1] !== '/' && text[1] !== '\\';
}

/** Throw unless `path` is a path of this PC (spawn, write and delete sites). A no-op off Windows except for `wsl:` refs. */
export function assertWindowsLocal(path: unknown, what = 'path'): void {
  if (isForeignPath(path)) throw new RangeError(`This ${what} is inside WSL and cannot be used with Windows tools: ${String(path)}`);
}

/** A distro name AIB accepts (`^[A-Za-z0-9._-]{1,64}$`); with `known`, it must also be one of them (case-insensitive: Lxss names). */
export function validDistro(name: unknown, known?: Iterable<string>): name is string {
  if (
    typeof name !== 'string' || !DISTRO.test(name) || name === '.' ||
    name === '..'
  ) return false;
  if (!known) return true;
  const folded = name.toLowerCase();
  for (const k of known) if (k.toLowerCase() === folded) return true;
  return false;
}

/** An absolute, normalised Linux path: starts with '/', no empty, '.' or '..' part, no trailing '/', no NUL, newline or backslash. */
export function validLinuxPath(path: unknown): path is string {
  if (
    typeof path !== 'string' || !path.startsWith('/') ||
    path.length > MAX_LINUX_PATH
  ) return false;
  if (/[\0\r\n\\]/.test(path)) return false;
  if (path === '/') return true;
  if (path.endsWith('/')) return false;
  return path.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** A Linux path tidied: repeated and trailing '/' and '.' parts dropped. null when it is not absolute or has a '..' part. */
export function normLinuxPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) return null;
  const out = '/' + parts.join('/');
  return validLinuxPath(out) ? out : null;
}

/** Is this text a WSL ref (the `wsl://` prefix, any case)? Says nothing about whether it is a valid one: see locOf. */
export function isWslRef(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith(WSL_REF_PREFIX);
}

/**
 * Where `text` (a stored project path) lives: `{kind:'wsl', distro, linuxPath}` for a valid ref (distro folded), `{kind:'win'}` for
 * anything of this PC's own file system, null for a foreign path that is not a valid ref (fail closed: treat as no folder).
 */
export function locOf(text: unknown): Loc | null {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!isForeignPath(value)) return WIN_LOC;
  if (!isWslRef(value)) return null;
  const rest = value.slice(WSL_REF_PREFIX.length);
  const slash = rest.indexOf('/');
  const distro = slash < 0 ? rest : rest.slice(0, slash);
  const linuxPath = slash < 0 ? '/' : rest.slice(slash);
  if (!validDistro(distro) || !validLinuxPath(linuxPath)) return null;
  return { kind: 'wsl', distro: distro.toLowerCase(), linuxPath };
}

/** The WSL part of `text`, or null (a Windows path, or not a valid ref). */
export function wslLocOf(text: unknown): WslLoc | null {
  const loc = locOf(text);
  return loc?.kind === 'wsl' ? loc : null;
}

/** The canonical ref of a WSL location (distro case-folded here, path as given). Throws on an invalid distro or path. */
export function refOf(loc: Loc): string {
  if (loc.kind !== 'wsl') throw new TypeError('refOf: a Windows location has no ref; use its path');
  if (!validDistro(loc.distro)) throw new RangeError(`Not a WSL distro name: ${loc.distro}`);
  if (!validLinuxPath(loc.linuxPath)) throw new RangeError(`Not an absolute Linux path: ${loc.linuxPath}`);
  return `${WSL_REF_PREFIX}${loc.distro.toLowerCase()}${loc.linuxPath}`;
}

/**
 * A folder-picker answer in the WSL share (`\\wsl$\<distro>\…`, `\\wsl.localhost\<distro>\…`, also with `\\?\UNC\` or '/') as a
 * WSL location. Pure string parsing: only those two hosts, the distro checked by validDistro (the caller also checks Lxss), the
 * path normalised and refused when it has a '..' part. null for anything else.
 */
export function fromWslUnc(text: unknown): WslLoc | null {
  if (typeof text !== 'string') return null;
  let value = text.trim().replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(value)) value = '\\\\' + value.slice(8);
  const m = /^\\\\(wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/i.exec(value);
  if (!m) return null;
  const distro = m[2];
  if (!validDistro(distro) || /[\0\r\n]/.test(value)) return null;
  const parts = (m[3] ?? '').split('\\').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..') || parts.some((part) => part.includes(':'))) return null;
  const linuxPath = '/' + parts.join('/');
  return validLinuxPath(linuxPath) ? { kind: 'wsl', distro: distro.toLowerCase(), linuxPath } : null;
}

/** `/mnt/<x>/…` (WSL's view of a Windows drive) as the Windows path `X:\…`; null for any other Linux path. */
export function mntToWindows(linuxPath: string): string | null {
  const m = /^\/mnt\/([A-Za-z])(\/.*)?$/.exec(linuxPath);
  if (!m) return null;
  const rest = (m[2] ?? '').split('/').filter((part) => part !== '');
  return `${m[1].toUpperCase()}:\\${rest.join('\\')}`;
}

/**
 * The stored project path for a location found in WSL: a Windows path when it is a Windows drive seen from WSL (`/mnt/c/x` is
 * `C:\x`, a Windows project), else the canonical ref.
 */
export function projectPathOf(loc: WslLoc): string {
  return mntToWindows(loc.linuxPath) ?? refOf(loc);
}

/**
 * A folder text from the picker or a request, made into the path AIB stores: a WSL share path or a ref becomes the canonical ref
 * (or the Windows path for /mnt/<x>); anything else is returned trimmed and unchanged. null for a foreign path that is not valid.
 */
export function canonicalFolder(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const unc = fromWslUnc(text);
  if (unc) return projectPathOf(unc);
  const loc = locOf(text);
  if (!loc) return null;
  return loc.kind === 'wsl' ? projectPathOf(loc) : text.trim();
}

/** A comparison key: WSL refs exactly (distro folded, path case-sensitive), Windows paths case-folded with '\'; others as given. */
export function locKey(text: unknown, windows = WIN): string {
  if (typeof text !== 'string') return '';
  const loc = locOf(text);
  if (loc?.kind === 'wsl') return refOf(loc);
  if (!loc) return text.trim();
  return windows ? text.trim().replaceAll('/', '\\').toLowerCase() : text.trim();
}

/** Join relative parts onto a WSL location's Linux path (POSIX rules, case kept); null when a part would climb out or is absolute. */
export function joinLinux(base: string, ...parts: string[]): string | null {
  const joined = [base, ...parts].join('/');
  if (parts.some((p) => p.startsWith('/') || p.split('/').includes('..'))) return null;
  return normLinuxPath(joined);
}

/** Is Linux path `child` the same as or inside `root` (case-sensitive, both normalised)? */
export function insideLinux(child: string, root: string): boolean {
  if (!validLinuxPath(child) || !validLinuxPath(root)) return false;
  return child === root || child.startsWith(root === '/' ? '/' : root + '/');
}
