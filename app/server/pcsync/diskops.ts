/**
 * The file work of the sync engine (files.ts) on ONE disk, as a set of small operations (sync between PCs, slice V7). The same code
 * runs in two places, so a Windows project and a WSL project follow exactly the same rules:
 *   - on this PC, for a Windows project (disk.ts LocalDisk calls `DiskOps.run` directly);
 *   - inside a WSL distro, for a WSL project (wsl/helper/pcsync.ts, the `pcsync.fs` method group, calls it with Linux paths).
 *
 * An op is `{op, ...}` and answers a JSON-like object (bytes are a Uint8Array here; the helper wraps them as base64). A failed op
 * throws an Error with a `.code`. Everything is relative to the project's aib-shared/ or aib-docs/ (`rel`, checked by frames.ts
 * checkPath: no `..`, no absolute path, no drive, no backslash); links (symlinks, junctions) are never followed, listed, read or
 * written through: before any write every folder from the root to the file's parent is looked at with lstat. The sync's own
 * temp files and bin live in `<git dir>/aib-sync/` (never inside the synced folder); the git dir is whatever git says for the
 * project, never a value from the caller.
 */
import { createHash } from 'node:crypto';
import * as osp from '../platform/ospath.ts';
import { localOnlyOf } from '../worktrees/local_only.ts';
import { type Area, checkPath } from './frames.ts';
import { branchOf, gitBusy } from './gitstate.ts';
import { BIN_DAYS, binAgeDays, isDocsPath, stamp } from './rules.ts';

export type Json = Record<string, unknown>;
export interface DiskOp extends Json {
  op: string;
}

/** Entries one walk may list (the engine holds back what is over its own limits; this only keeps one answer a sane size). */
export const WALK_CAP = 60_000;
const MAX_DEPTH = 40;
/** The most one `read` of a whole file may return. */
export const MAX_READ = 16 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{1,48}$/;
const GIT_TTL = 20_000;

/** An op refused: `code` says why ('bad_path', 'link', 'no_git', ...). */
export class DiskError extends Error {
  constructor(message: string, readonly code = 'failed') {
    super(message);
    this.name = 'DiskError';
  }
}

export function toB64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export function fromB64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const lstat = (path: string): Deno.FileInfo | null => {
  try {
    return Deno.lstatSync(path);
  } catch {
    return null;
  }
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const segs = (rel: string) => rel.split('/');
const kindOf = (st: Deno.FileInfo): 'f' | 'd' | 'l' | 'o' => (st.isSymlink ? 'l' : st.isDirectory ? 'd' : st.isFile ? 'f' : 'o');

async function hashFile(path: string): Promise<string> {
  const hasher = createHash('sha256');
  const file = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(1 << 20);
    for (;;) {
      const n = await file.read(buf);
      if (n === null) break;
      hasher.update(buf.subarray(0, n));
    }
  } finally {
    file.close();
  }
  return hasher.digest('hex');
}

export class DiskOps {
  readonly label: string;
  #git: { dir: string; at: number } | null = null;

  /** `project` is the project's main folder as this machine sees it; `sync` names the project for the temp folder. */
  constructor(readonly project: string, readonly area: Area, readonly sync: string) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(sync)) throw new DiskError('bad project id', 'bad_params');
    this.label = area === 'docs' ? 'aib-docs' : 'aib-shared';
  }

  get root(): string {
    return osp.join(this.project, this.label);
  }

  /** The repository's git folder (where `.git/info/exclude` is), or '' when there is none. Cached for a while. */
  async #gitDir(): Promise<string> {
    if (this.#git && Date.now() - this.#git.at < GIT_TTL) return this.#git.dir;
    const lo = await localOnlyOf(this.project).catch(() => null);
    const dir = lo ? osp.dirname(osp.dirname(lo.excludeFile)) : '';
    this.#git = { dir: dir && osp.isdir(dir) ? dir : '', at: Date.now() };
    return this.#git.dir;
  }
  async #needGit(): Promise<string> {
    const dir = await this.#gitDir();
    if (!dir) throw new DiskError('The git folder of this project was not found.', 'no_git');
    return dir;
  }
  async #tmpDir(): Promise<string> {
    return osp.join(await this.#needGit(), 'aib-sync', 'tmp', this.sync);
  }
  async #binRoot(): Promise<string> {
    return osp.join(await this.#needGit(), 'aib-sync', 'bin');
  }
  /** The bin of one area: <git dir>/aib-sync/bin/<date-time>[-docs]/<path>. aib-shared and aib-docs never share a folder. */
  async #binDir(): Promise<string> {
    return osp.join(await this.#binRoot(), this.area === 'docs' ? `${stamp()}-docs` : stamp());
  }
  async #tmpPath(t: unknown): Promise<string> {
    if (typeof t !== 'string' || !TOKEN.test(t)) throw new DiskError('bad temp name', 'bad_params');
    return osp.join(await this.#tmpDir(), t);
  }

  #rel(value: unknown): string {
    const ok = checkPath(value, this.area);
    if (!ok.ok) throw new DiskError(`path refused: ${ok.error}`, 'bad_path');
    return ok.value;
  }

  /** Throws unless every folder from the root to the file's parent is a real folder (never a link), and the file is not a link or folder. */
  #safe(rel: string, mayCreate: boolean): string {
    const root = lstat(this.root);
    if (!root || root.isSymlink || !root.isDirectory) throw new DiskError(`the ${this.label} folder is not a real folder`, 'link');
    const parts = segs(rel);
    let cur = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = osp.join(cur, parts[i]);
      const st = lstat(cur);
      if (!st) {
        if (!mayCreate) return osp.join(this.root, ...parts);
        Deno.mkdirSync(cur);
      } else if (st.isSymlink || !st.isDirectory) throw new DiskError('a link or a file is in the way', 'link');
    }
    const abs = osp.join(this.root, ...parts);
    const st = lstat(abs);
    if (st && (st.isSymlink || st.isDirectory)) throw new DiskError('a link or a folder is in the way', 'link');
    return abs;
  }

  async #pruneBin(days: number, max: number): Promise<void> {
    const bin = await this.#binRoot();
    try {
      for (const e of Deno.readDirSync(bin)) {
        if (e.isDirectory && binAgeDays(e.name) > days) Deno.removeSync(osp.join(bin, e.name), { recursive: true });
      }
    } catch { /* no bin yet */ }
    await this.#capBin(max);
  }

  /** Delete the oldest bin folders until the whole bin (both areas) is under the cap. The newest folder always stays. */
  async #capBin(max: number): Promise<void> {
    try {
      const bin = await this.#binRoot();
      const sizeOf = (dir: string): number => {
        let n = 0;
        for (const e of Deno.readDirSync(dir)) {
          const full = osp.join(dir, e.name);
          if (e.isDirectory) n += sizeOf(full);
          else if (e.isFile) n += lstat(full)?.size ?? 0;
        }
        return n;
      };
      const dirs = [...Deno.readDirSync(bin)].filter((e) => e.isDirectory).map((e) => ({ name: e.name, size: sizeOf(osp.join(bin, e.name)) }));
      dirs.sort((a, b) => (a.name < b.name ? -1 : 1)); // the stamps sort by time
      let total = dirs.reduce((n, d) => n + d.size, 0);
      for (const d of dirs.slice(0, -1)) {
        if (total <= max) break;
        Deno.removeSync(osp.join(bin, d.name), { recursive: true });
        total -= d.size;
      }
    } catch { /* no bin yet */ }
  }

  /** Move or copy a file into the bin; the size of what went in. */
  async #toBin(rel: string, abs: string, move: boolean): Promise<number> {
    const first = osp.join(await this.#binDir(), ...segs(rel));
    Deno.mkdirSync(osp.dirname(first), { recursive: true });
    let dest = first;
    for (let i = 1; osp.exists(dest); i++) dest = `${first}.${i}`;
    const size = lstat(abs)?.size ?? 0;
    if (move) {
      try {
        Deno.renameSync(abs, dest);
      } catch {
        /* another volume or a busy file: copy, then remove */
        Deno.copyFileSync(abs, dest);
        Deno.removeSync(abs);
      }
    } else Deno.copyFileSync(abs, dest);
    return size;
  }

  async #rename(from: string, to: string): Promise<void> {
    for (let i = 0;; i++) {
      try {
        Deno.renameSync(from, to); // atomic over an existing file
        return;
      } catch (error) {
        if (i >= 20) throw error;
        await sleep(50); // a reader holds the file for a moment (Windows)
      }
    }
  }

  async run(op: DiskOp): Promise<Json> {
    switch (op.op) {
      case 'resolve': {
        const lo = await localOnlyOf(this.project).catch(() => null);
        if (!lo) return { reason: `This project is not a git project, so ${this.label} is not synced.` };
        if (this.area === 'shared') {
          if (lo.defaultState === 'tracked') return { reason: `Git already tracks ${this.label} in this project. It is not synced here.` };
          if (lo.defaultState !== 'on') return { reason: `${this.label} is not set to local-only in this project, so it is not synced.` };
        } // aib-docs may be tracked by git or not: the docs are synced either way
        const st = lstat(this.root);
        if (st?.isSymlink) return { reason: `${this.label} here is a link, not the real folder.` };
        if (st && !st.isDirectory) return { reason: `${this.label} here is a file, not a folder.` };
        const gitDir = osp.dirname(osp.dirname(lo.excludeFile));
        if (!osp.isdir(gitDir)) return { reason: 'The git folder of this project was not found.' };
        this.#git = { dir: gitDir, at: Date.now() };
        return { key: gitDir };
      }
      case 'rootKind': {
        const st = lstat(this.root);
        return { kind: !st ? 'missing' : st.isSymlink ? 'link' : st.isDirectory ? 'dir' : 'file' };
      }
      case 'mkRoot':
        Deno.mkdirSync(this.root, { recursive: true });
        return {};
      case 'walk': {
        const entries: [string, string, number, number][] = [];
        let incomplete = false;
        let seen = 0;
        const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
          const list: Deno.DirEntry[] = [];
          try {
            for await (const e of Deno.readDir(abs)) list.push(e);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) incomplete = true;
            return;
          }
          list.sort((a, b) => (a.name < b.name ? -1 : 1));
          for (const e of list) {
            const path = rel ? `${rel}/${e.name}` : e.name;
            if (++seen % 200 === 0) await tick();
            if (entries.length >= WALK_CAP) {
              incomplete = true;
              return;
            }
            if (!e.isSymlink && this.area === 'docs' && !isDocsPath(path, e.isDirectory)) continue; // the page copies and other files: not synced
            if (e.isSymlink) {
              entries.push([path, 'l', 0, 0]); // a link (junction or symlink) is listed as present, never followed or synced
              continue;
            }
            const full = osp.join(abs, e.name);
            if (e.isDirectory) {
              entries.push([path, 'd', 0, 0]);
              if (depth < MAX_DEPTH) await walk(full, path, depth + 1);
              else incomplete = true;
              continue;
            }
            if (!e.isFile) {
              entries.push([path, 'o', 0, 0]);
              continue;
            }
            const info = lstat(full);
            if (!info) {
              incomplete = true;
              continue;
            }
            entries.push([path, 'f', info.size, info.mtime?.getTime() ?? 0]);
          }
        };
        await walk(this.root, '', 0);
        return { entries, incomplete };
      }
      case 'stat': {
        const rel = this.#rel(op.rel);
        const abs = this.#safe(rel, false);
        const st = lstat(abs);
        return { st: st ? { k: kindOf(st), size: st.size, mtime: st.mtime?.getTime() ?? 0 } : null };
      }
      case 'safe':
        this.#safe(this.#rel(op.rel), op.create === true);
        return {};
      case 'hash': {
        // sha256 of the bytes; `changed` when the file was written while it was read (size or mtime differ from what the walk saw)
        const rel = this.#rel(op.rel);
        const abs = this.#safe(rel, false);
        const hash = await hashFile(abs);
        const after = lstat(abs);
        if (!after || after.size !== op.size || (after.mtime?.getTime() ?? 0) !== op.mtime) return { changed: true };
        return { hash };
      }
      case 'read': {
        // a whole file (docs), or `len` bytes from `offset` (serving a chunk); `size`/`mtime` say what the caller expects the file to be
        const rel = this.#rel(op.rel);
        const abs = this.#safe(rel, false);
        const st = lstat(abs);
        if (!st || !st.isFile) return { gone: true };
        const mtime = st.mtime?.getTime() ?? 0;
        if ((typeof op.size === 'number' && st.size !== op.size) || (typeof op.mtime === 'number' && mtime !== op.mtime)) return { gone: true, changed: true };
        if (typeof op.len !== 'number') {
          if (st.size > MAX_READ) throw new DiskError('the file is too big to read whole', 'too_big');
          return { bytes: await Deno.readFile(abs), size: st.size, mtime };
        }
        const offset = Number(op.offset) || 0;
        if (offset > st.size) return { gone: true };
        const file = await Deno.open(abs, { read: true });
        try {
          await file.seek(offset, Deno.SeekMode.Start);
          const buf = new Uint8Array(Math.min(op.len, st.size - offset));
          let got = 0;
          while (got < buf.length) {
            const n = await file.read(buf.subarray(got));
            if (n === null) break;
            got += n;
          }
          if (got < buf.length) return { gone: true };
          return { bytes: buf, size: st.size, mtime };
        } finally {
          file.close();
        }
      }
      case 'tmpClean': {
        const dir = await this.#tmpDir();
        Deno.mkdirSync(dir, { recursive: true });
        for (const e of Deno.readDirSync(dir)) if (e.isFile) Deno.removeSync(osp.join(dir, e.name));
        return {};
      }
      case 'tmpWrite': {
        const path = await this.#tmpPath(op.t);
        if (!(op.bytes instanceof Uint8Array)) throw new DiskError('bytes missing', 'bad_params');
        Deno.mkdirSync(osp.dirname(path), { recursive: true });
        Deno.writeFileSync(path, op.bytes, op.first === true ? { mode: 0o644 } : { append: true, create: true, mode: 0o644 });
        return {};
      }
      case 'tmpRead':
        return { bytes: await Deno.readFile(await this.#tmpPath(op.t)) };
      case 'tmpRemove':
        try {
          Deno.removeSync(await this.#tmpPath(op.t));
        } catch { /* none */ }
        return {};
      case 'install': {
        // the temp file replaces the file at `rel` (a rename, atomic); the old one goes to the bin first when `bin` is set
        const rel = this.#rel(op.rel);
        const tmp = await this.#tmpPath(op.t);
        const abs = this.#safe(rel, true);
        let binned = 0;
        if (op.bin === true && lstat(abs)) binned = await this.#toBin(rel, abs, false);
        await this.#rename(tmp, abs);
        const mtime = typeof op.mtime === 'number' ? op.mtime : 0;
        if (mtime > 0) {
          try {
            Deno.utimeSync(abs, new Date(), new Date(mtime));
          } catch { /* the time stays as written */ }
        }
        const info = Deno.lstatSync(abs);
        const out: Json = { size: info.size, mtime: info.mtime?.getTime() ?? 0, binned };
        if (op.hash === true) out.hash = createHash('sha256').update(Deno.readFileSync(abs)).digest('hex');
        return out;
      }
      case 'copy': {
        // a conflict copy: the file stays, a copy is made beside it
        const rel = this.#rel(op.rel), to = this.#rel(op.to);
        const from = this.#safe(rel, false);
        const dest = this.#safe(to, true);
        Deno.copyFileSync(from, dest);
        const info = Deno.lstatSync(dest);
        return { size: info.size, mtime: info.mtime?.getTime() ?? 0 };
      }
      case 'copyToTmp': {
        const from = this.#safe(this.#rel(op.rel), false);
        const st = lstat(from);
        if (!st || !st.isFile) throw new DiskError('The file is already gone.', 'not_found');
        const tmp = await this.#tmpPath(op.t);
        Deno.mkdirSync(osp.dirname(tmp), { recursive: true });
        Deno.copyFileSync(from, tmp);
        return {};
      }
      case 'bin': {
        const rel = this.#rel(op.rel);
        const abs = this.#safe(rel, false);
        return { size: lstat(abs) ? await this.#toBin(rel, abs, op.move === true) : 0 };
      }
      case 'capBin':
        await this.#capBin(Math.max(1, Number(op.max) || 1));
        return {};
      case 'deleteFile': {
        // the other PC deleted it: the file goes to the bin, empty folders above it go. `changed`: it changed since the scan (nothing done).
        const rel = this.#rel(op.rel);
        const abs = this.#safe(rel, false);
        const st = lstat(abs);
        if (st && (!st.isFile || st.size !== op.size || (st.mtime?.getTime() ?? 0) !== op.mtime)) return { changed: true };
        const binned = st ? await this.#toBin(rel, abs, true) : 0;
        for (let dir = osp.dirname(abs); dir.length > this.root.length; dir = osp.dirname(dir)) {
          try {
            Deno.removeSync(dir); // an empty folder only
          } catch {
            break;
          }
        }
        return { binned };
      }
      case 'binList': {
        const limit = Math.max(1, Math.min(200, Number(op.limit) || 40));
        const bin = await this.#binRoot();
        const out: { id: string; path: string; at: string; size: number }[] = [];
        try {
          const dirs = [...Deno.readDirSync(bin)].filter((e) => e.isDirectory && binAgeDays(e.name) >= 0).map((e) => e.name).sort().reverse();
          for (const name of dirs) {
            if ((name.endsWith('-docs') ? 'docs' : 'shared') !== this.area) continue;
            const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)!;
            const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
            const walk = (abs: string, rel: string) => {
              for (const e of Deno.readDirSync(abs)) {
                if (out.length >= limit) return;
                const path = rel ? `${rel}/${e.name}` : e.name;
                if (e.isDirectory) walk(osp.join(abs, e.name), path);
                else if (e.isFile) out.push({ id: `${name}/${path}`, path: path.replace(/\.\d+$/, ''), at, size: lstat(osp.join(abs, e.name))?.size ?? 0 });
              }
            };
            walk(osp.join(bin, name), '');
            if (out.length >= limit) break;
          }
        } catch { /* no bin yet */ }
        return { entries: out };
      }
      case 'binToTmp': {
        // Restore: a bin entry is copied to a temp file (then `install` puts it back)
        const id = String(op.id);
        const m = /^(\d{8}-\d{6}(?:-docs)?)\/(.+)$/.exec(id);
        if (!m || (m[1].endsWith('-docs') ? 'docs' : 'shared') !== this.area) throw new DiskError('That bin entry is not here.', 'not_found');
        const parts = segs(m[2]);
        if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new DiskError('That bin entry is not here.', 'not_found');
        const from = osp.join(await this.#binRoot(), m[1], ...parts);
        const st = lstat(from);
        if (!st || !st.isFile) throw new DiskError('That bin entry is gone.', 'not_found');
        const tmp = await this.#tmpPath(op.t);
        Deno.mkdirSync(osp.dirname(tmp), { recursive: true });
        Deno.copyFileSync(from, tmp);
        return {};
      }
      case 'binPrune':
        await this.#pruneBin(Number(op.days) || BIN_DAYS, Math.max(1, Number(op.max) || 1));
        return {};
      case 'caseTest': {
        // is this project's volume case-insensitive? A temp name in the sync temp folder (the same volume as the git dir)
        let result = Deno.build.os !== 'linux';
        try {
          const dir = await this.#tmpDir();
          Deno.mkdirSync(dir, { recursive: true });
          const name = `Case-${crypto.randomUUID().slice(0, 4)}`;
          const upper = osp.join(dir, name);
          Deno.writeFileSync(upper, new Uint8Array());
          try {
            result = !!lstat(osp.join(dir, name.toLowerCase()));
          } finally {
            Deno.removeSync(upper);
          }
        } catch { /* the OS default stands */ }
        return { insensitive: result };
      }
      case 'git': {
        // what git is doing here (docs wait while it merges or rebases) and the branch (the two PCs must be on the same one)
        const common = await this.#gitDir().catch(() => '');
        return { busy: gitBusy(this.project, common), branch: branchOf(this.project, common) };
      }
      default:
        throw new DiskError(`unknown disk op ${String(op.op)}`, 'bad_params');
    }
  }
}
