// stub: replaced by Track B on merge
/**
 * Where a project lives (docs/wsl/design.md section 2): a Windows folder, or a folder inside a WSL distro, stored as the canonical ref
 * `wsl://<distro><linuxPath>`. Track C's thin stand-in with exactly the names Track B exports; pure string work, no I/O.
 */
import { type Loc, WSL_REF_PREFIX } from '../wsl/contract.ts';

export type { Loc };

/** The location of a stored path or ref. Anything that is not a well-formed WSL ref is a Windows path. Never URL-parses. */
export function locOf(ref: string): Loc {
  const text = typeof ref === 'string' ? ref : '';
  if (!text.startsWith(WSL_REF_PREFIX)) return { kind: 'win' };
  const rest = text.slice(WSL_REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return { kind: 'win' };
  const distro = rest.slice(0, slash);
  const linuxPath = rest.slice(slash) || '/';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(distro) || linuxPath.includes('\0') || /[\r\n]/.test(linuxPath)) return { kind: 'win' };
  return { kind: 'wsl', distro: distro.toLowerCase(), linuxPath: normLinux(linuxPath) };
}

/** The canonical ref of a location (the distro case-folded, the path normalised); '' for a Windows location. */
export function refOf(loc: Loc): string {
  return loc.kind === 'wsl' ? `${WSL_REF_PREFIX}${loc.distro.toLowerCase()}${normLinux(loc.linuxPath)}` : '';
}

/** A path Windows file functions must never touch: a WSL ref, or (on Windows) an absolute path without a drive (`/home/u`). */
export function isForeignPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  if (path.startsWith('wsl:')) return true;
  return Deno.build.os === 'windows' && /^\/(?!\/)/.test(path);
}

function normLinux(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}
