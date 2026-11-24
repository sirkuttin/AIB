/**
 * Project delete inside a distro (docs/wsl/design.md section 8 item 10, phase 2): the folder goes to the distro's trash, never away
 * for good. The helper runs project_delete.ts's own refusals natively (home folder, root, a folder holding or inside another project,
 * AIB's data) with Linux rules, plus two of its own (a folder on a Windows drive, a top-level system folder), and then:
 *   1. `gio trash` when the distro has it (the desktop's trash, which also handles other disks), else
 *   2. the freedesktop.org trash spec by hand: $XDG_DATA_HOME/Trash (default ~/.local/share/Trash) with `files/`, `info/` and a
 *      .trashinfo that says where the folder came from, when the folder is on the same disk as that trash (one rename; nothing is
 *      ever copied), else
 *   3. a refusal that says why. There is no recursive remove in this file: a delete that cannot go to a trash does not happen.
 */
import * as osp from '../../platform/ospath.ts';
import { which } from '../../platform/pypath.ts';
import { type Guard, inspect, type Inspection, refusal, Refused, type TrashKind, type TrashLayer } from '../../desktop/project_delete.ts';

/** Where the freedesktop home trash is: $XDG_DATA_HOME/Trash, else <home>/.local/share/Trash. */
export function trashRoot(home: string, dataHome?: string): string {
  const base = dataHome && osp.isabs(dataHome) ? dataHome : osp.join(home, '.local', 'share');
  return osp.join(base, 'Trash');
}

/** The Path= value of a .trashinfo: the absolute path, percent-encoded per the spec (UTF-8 bytes, `/` kept). */
export function encodeTrashPath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

/** The text of a .trashinfo file (DeletionDate is local time, `YYYY-MM-DDThh:mm:ss`, as the spec says). */
export function trashInfo(path: string, when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}T${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())}`;
  return `[Trash Info]\nPath=${encodeTrashPath(path)}\nDeletionDate=${stamp}\n`;
}

const exists = (path: string): boolean => {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** The disk (device id) of the nearest folder that exists at or above `path`; null when the system does not say. */
function deviceOf(path: string): number | null {
  let dir = path;
  for (let i = 0; i < 64; i++) {
    try {
      const dev = Deno.statSync(dir).dev;
      return typeof dev === 'number' ? dev : null;
    } catch { /* not there yet */ }
    const up = osp.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** True when `path` is on the same disk as the home trash, so a rename (no copy) can move it there. */
export function sameDisk(path: string, trash: string): boolean {
  const a = deviceOf(path), b = deviceOf(trash);
  return a === null || b === null || a === b;
}

/**
 * Move `path` into the freedesktop home trash `trash`. The .trashinfo is created first with createNew (it reserves the name), then
 * the folder is renamed into files/; if the rename fails the .trashinfo is taken away again. Throws a readable Error; the folder is
 * either in the trash or untouched.
 */
export function xdgTrash(path: string, trash: string, now: () => Date = () => new Date()): string {
  const files = osp.join(trash, 'files'), info = osp.join(trash, 'info');
  Deno.mkdirSync(files, { recursive: true, mode: 0o700 });
  Deno.mkdirSync(info, { recursive: true, mode: 0o700 });
  const base = osp.basename(path);
  for (let n = 0; n < 1000; n++) {
    const name = n === 0 ? base : `${base}.${n}`;
    const target = osp.join(files, name), card = osp.join(info, name + '.trashinfo');
    if (exists(target)) continue;
    try {
      Deno.writeTextFileSync(card, trashInfo(path, now()), { createNew: true, mode: 0o600 });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) continue;
      throw new Error(`The trash could not be written: ${(error as Error).message}`);
    }
    try {
      Deno.renameSync(path, target);
    } catch (error) {
      try {
        Deno.removeSync(card);
      } catch { /* leave it: a stray .trashinfo only costs a line in the trash's list */ }
      throw new Error(`The folder could not be moved to the trash: ${(error as Error).message}`);
    }
    return target;
  }
  throw new Error('The trash already holds too many folders with this name');
}

export interface DistroTrashOptions {
  /** The distro user's home. */
  home: string;
  /** XDG_DATA_HOME override (tests put it inside their temp root, so the owner's own trash is never touched). */
  dataHome?: string;
  /** Tests: pretend `gio` is (not) there (undefined: look it up). */
  gio?: string | null;
}

/** The trash a distro offers: gio, the freedesktop trash on the same disk, or none ('permanent': the helper refuses it, see below). */
export function distroTrash(opts: DistroTrashOptions): TrashLayer {
  const trash = trashRoot(opts.home, opts.dataHome);
  const gio = () => opts.gio === undefined ? which('gio') : opts.gio;
  return {
    kind(path) {
      if (gio()) return Promise.resolve<TrashKind>('gio');
      return Promise.resolve<TrashKind>(sameDisk(path, trash) ? 'xdg' : 'permanent');
    },
    async trash(path, kind) {
      if (kind === 'gio') {
        const program = gio();
        if (program) {
          const env: Record<string, string> = opts.dataHome ? { XDG_DATA_HOME: opts.dataHome } : {};
          const out = await new Deno.Command(program, { args: ['trash', '--', path], stdin: 'null', stdout: 'null', stderr: 'piped', env }).output();
          if (out.success) return;
          if (!sameDisk(path, trash)) throw new Error(new TextDecoder().decode(out.stderr).trim() || 'gio trash failed');
          // gio could not (no trash service for this disk, a desktop-less distro): the spec's own trash, when it is on this disk
        }
      }
      if (!sameDisk(path, trash)) throw new Error('This folder is on another disk than your trash, and this distro has no `gio` to trash it there');
      xdgTrash(path, trash);
    },
  };
}

/** The refusals of a folder inside a distro: project_delete.ts's rules plus Linux ones. '' when it may go to the trash. */
export function distroRefusal(path: string, guard: Guard): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean); // (a Windows path only in tests)
  if (parts[0] === 'mnt' && parts[1] && parts[1].length === 1) return 'This folder is on a Windows drive. Delete it from Windows if you mean to.';
  if (parts.length < 2) return 'This is a top-level system folder. AIB will not delete it.';
  return refusal(path, guard);
}

/** What the dialog shows before it offers the trash. A folder with no trash here is refused (never permanent). */
export async function inspectInDistro(path: string, guard: Guard, layer: TrashLayer): Promise<Inspection> {
  const seen = await inspect(path, guard, layer);
  const refused = seen.exists ? distroRefusal(path, guard) || seen.refusal : '';
  const noTrash = seen.exists && !refused && seen.trash === 'permanent'
    ? 'This distro has no trash AIB can use for this folder (install `gio`, from libglib2.0-bin), so AIB will not delete it. Delete it in the distro if you mean to.'
    : '';
  return { ...seen, refusal: refused || noTrash };
}

/** Move the folder to the distro's trash: 'missing' when it is not there, else the kind used. Refused (Refused) says why not. */
export async function trashInDistro(path: string, guard: Guard, layer: TrashLayer): Promise<TrashKind | 'missing'> {
  const seen = await inspectInDistro(path, guard, layer);
  if (!seen.exists) return 'missing';
  if (seen.refusal) throw new Refused(seen.refusal);
  const real = Deno.realPathSync(path);
  await layer.trash(real, seen.trash);
  if (exists(real)) throw new Refused('The folder is still there: something may be using it. Nothing more was deleted.');
  return seen.trash;
}
