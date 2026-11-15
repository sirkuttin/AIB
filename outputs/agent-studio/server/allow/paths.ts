/**
 * Allow rules: path checks. The form of a path is checked before AIB touches the disk (architect review 2.6): UNC and device
 * paths, drive-relative paths, ":" anywhere but "X:\", tilde forms and 8.3-looking names ask without ever being resolved (just
 * resolving \\host\share makes Windows connect out and can leak the login hash). Only then is the path resolved (links followed)
 * and compared with the chat's folder, case-folded on Windows.
 */
import { isAbsolute, join, normalize, resolve } from 'node:path';

const WINDOWS = Deno.build.os === 'windows';

/** Folder names agents must never write into (hooks, agent configs): compared after case-folding and stripping dots/spaces. */
export const PROTECTED_NAMES = new Set(['.git', '.husky', '.claude', '.codex', '.gemini', '.cursor', '.githooks']);

/** One path segment as Windows really opens it: trailing dots and spaces stripped, case-folded. */
export function canonicalName(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

/** Git Bash /c/Users/... form to C:\Users\... (Windows only); other strings unchanged. */
export function fromGitBash(path: string): string {
  if (!WINDOWS) return path;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(path);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replaceAll('/', '\\')}` : path;
}

/** Why this path form can't be checked safely, or '' when it can. */
export function pathFormProblem(raw: string): string {
  if (!raw) return 'empty path';
  if (/[\x00-\x1f]/.test(raw)) return 'control characters in a path';
  if (raw.startsWith('\\\\') || raw.startsWith('//') || raw.startsWith('\\??\\')) return 'network or device path';
  if (raw.startsWith('~')) return 'home-folder path';
  const p = fromGitBash(raw);
  const colon = p.indexOf(':');
  if (colon >= 0) {
    if (!/^[A-Za-z]:[\\/]/.test(p)) return colon === 1 ? 'drive-relative path' : 'provider path or data stream';
    if (p.indexOf(':', 2) >= 0) return 'data stream';
  }
  for (const seg of p.split(/[\\/]/)) if (/~\d/.test(seg)) return 'short (8.3) file name';
  return '';
}

/** Absolute, normalised, with the longest existing part resolved through links. Null when it can't be resolved safely. */
export function realish(path: string, cwd: string): string | null {
  const p = fromGitBash(path);
  let full = normalize(isAbsolute(p) ? p : resolve(cwd, p));
  const tail: string[] = [];
  for (let n = 0; n < 64; n++) {
    try {
      const real = Deno.realPathSync(full);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) return null;
      const parent = resolve(full, '..');
      if (parent === full) return null;
      tail.push(full.slice(parent.length).replace(/^[\\/]/, ''));
      full = parent;
    }
  }
  return null;
}

const fold = (p: string) => (WINDOWS ? p.toLowerCase() : p).replace(/[\\/]+$/, '');

/** `child` is `root` or inside it (both absolute and resolved). */
export function inside(child: string, root: string): boolean {
  const c = fold(child), r = fold(root);
  if (!r) return false;
  return c === r || c.startsWith(r + (WINDOWS ? '\\' : '/')) || (WINDOWS && c.startsWith(r + '/'));
}

/** The segments of `child` below `root`, canonical (for protected-name checks). */
export function segmentsBelow(child: string, root: string): string[] {
  const rest = child.slice(root.replace(/[\\/]+$/, '').length);
  return rest.split(/[\\/]/).filter(Boolean).map(canonicalName);
}

export type PathVerdict = { ok: true; real: string } | { ok: false; reason: string; outside?: boolean };

/**
 * A path argument checked against the chat's folder: form first, then resolved. `write` also refuses protected folder names.
 * Globs: allowed only in the last segment, never one starting with "." (".*" can match "..").
 */
export function checkPath(raw: string, cwd: string, root: string, opts: { write?: boolean; glob?: boolean } = {}): PathVerdict {
  const form = pathFormProblem(raw);
  if (form) return { ok: false, reason: form };
  let path = raw;
  if (opts.glob) {
    const segs = raw.split(/[\\/]/);
    const last = segs.pop()!;
    if (segs.some((s) => /[*?[]/.test(s)) || last.startsWith('.') || last.startsWith('[')) return { ok: false, reason: 'glob that could match ..' };
    path = segs.length ? segs.join('/') : '.';
  }
  const real = realish(path, cwd);
  const realRoot = realish(root, root);
  if (!real || !realRoot) return { ok: false, reason: 'path could not be resolved' };
  if (!inside(real, realRoot)) return { ok: false, reason: 'outside the project', outside: true };
  if (opts.write && segmentsBelow(real, realRoot).some((s) => PROTECTED_NAMES.has(s))) {
    return { ok: false, reason: 'a protected folder (.git, .claude, hooks)' };
  }
  return { ok: true, real };
}

/** Names of files that hold secrets (floor when outside the project). */
export function looksSecret(path: string): boolean {
  const p = fromGitBash(path).replaceAll('\\', '/').toLowerCase();
  return /(^|\/)(\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker)(\/|$)/.test(p) ||
    /(^|\/)(\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|credentials(\.json)?|id_[a-z0-9]+|[^/]*\.pem|[^/]*\.key|\.env(\.[^/]*)?)$/.test(p) ||
    /\/(google\/chrome|microsoft\/edge|mozilla\/firefox|bravesoftware)\/.*(user data|profiles)/.test(p);
}
