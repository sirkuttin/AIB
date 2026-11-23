/**
 * The plain rules of the aib-shared file sync (sync between PCs, slice V4): limits, names that are never synced, the conflict copy's
 * name, which files get a line merge. No file access here.
 */

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_FOLDER_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FILES = 20_000;
/** A line merge reads three whole files: only small text files get one. */
export const MAX_MERGE_BYTES = 1024 * 1024;
/** The mass-delete guard: a batch of this many deletes or more is checked (a tiny folder is not "mass")... */
export const GUARD_MIN = 10;
/** ...and pauses when it is more than this share of the folder or more than this many files. */
export const GUARD_SHARE = 0.5;
export const GUARD_COUNT = 200;
export const BIN_DAYS = 30;

const SECRET = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.?credentials([._-].*)?$/i,
  /^\.netrc$/i,
];

/** True when any name in the path looks like a secret (`.env*`, `*.pem`, `*.key`, `id_rsa*`, credentials files): never synced. */
export function isSecretPath(path: string): boolean {
  return path.split('/').some((name) => SECRET.some((re) => re.test(name)));
}

export const CONFLICT_MARK = '.sync-conflict-';
export const isConflictCopy = (path: string): boolean => path.includes(CONFLICT_MARK);

/** `.md` and `.txt` files get a 3-way line merge before a conflict copy is made. */
export const isMergeable = (path: string): boolean => /\.(md|txt)$/i.test(path);

const two = (n: number) => String(n).padStart(2, '0');
/** `YYYYMMDD-HHMMSS` in local time (the conflict copy's stamp and the bin's folder names). */
export function stamp(date = new Date()): string {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${
    two(date.getSeconds())
  }`;
}

/** Syncthing's naming: `notes.md` becomes `notes.sync-conflict-20261123-143000-studio-pc.md`. `pc` is the PC whose version lost. */
export function conflictName(path: string, pc: string, date = new Date()): string {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash + 1);
  const file = slash < 0 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  let name = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  const tag = `${CONFLICT_MARK}${stamp(date)}-${pc.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 20) || 'pc'}`;
  name = name.slice(0, Math.max(1, 110 - tag.length - ext.length));
  return `${dir}${name}${tag}${ext}`;
}

/** How long ago a bin folder (named by `stamp`) was made, in days; -1 when the name is not a stamp (it is then never removed). */
export function binAgeDays(folder: string, now = new Date()): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(folder);
  if (!m) return -1;
  const made = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return (now.getTime() - made.getTime()) / 86_400_000;
}
