/**
 * The one disk interface of the sync engine (files.ts; sync between PCs, slice V7). The engine never touches a file itself: every read,
 * write, delete, listing, bin move and git look goes through a SyncDisk, which sends small ops (diskops.ts) to
 *   - this PC's own disk (`localDisk`: DiskOps called in this process), for a Windows project, or
 *   - the project's WSL distro (`wslDisk`, wsl/pcsync.ts: the helper's `pcsync.fs` runs the same DiskOps natively there), for a WSL project.
 * Both run exactly the same ops, so the same engine, rules, conflict handling, guard, bin cap, case-clash handling and secret list
 * apply to both. A disk that cannot be reached right now (a distro that is not running) throws DiskDown; the engine then waits and
 * tries again later. Nothing here ever starts a distro.
 */
import { type DiskOp, DiskOps, type Json } from './diskops.ts';
import type { Area } from './frames.ts';

/** The disk cannot be reached now (a stopped distro): the message is the line the owner sees ("Waiting: Ubuntu is not running."). */
export class DiskDown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiskDown';
  }
}

/** An op the disk refused or could not do. */
export class DiskFailure extends Error {
  constructor(message: string, readonly code = 'failed') {
    super(message);
    this.name = 'DiskFailure';
  }
}

/** One answer per op: {ok: true, ...} or {ok: false, error, code}. A call that cannot be made at all throws DiskDown. */
export type Exec = (ops: DiskOp[]) => Promise<Json[]>;

export type WalkEntry = [path: string, kind: 'f' | 'd' | 'l' | 'o', size: number, mtime: number];
export interface FileStat {
  k: 'f' | 'd' | 'l' | 'o';
  size: number;
  mtime: number;
}

export interface DiskInfo {
  /** The Windows folder to watch for changes (a trigger only); null when the disk cannot be watched (a WSL project is polled). */
  watchRoot: string | null;
  /** '' while the disk can be reached, else why not (never starts anything). */
  available(): string;
}

const HASH_BATCH = 60;

export class SyncDisk {
  constructor(readonly exec: Exec, readonly info: DiskInfo) {}

  get watchRoot(): string | null {
    return this.info.watchRoot;
  }
  /** '' when the disk can be reached now, else the line to show. */
  available(): string {
    return this.info.available();
  }

  async batch(ops: DiskOp[]): Promise<Json[]> {
    if (!ops.length) return [];
    const why = this.available();
    if (why) throw new DiskDown(why);
    const out = await this.exec(ops);
    if (out.length !== ops.length) throw new DiskDown('The disk gave no answer.');
    return out;
  }

  /** One op; a refusal throws a DiskFailure with the op's own message. */
  async one(op: DiskOp): Promise<Json> {
    const [r] = await this.batch([op]);
    if (r.ok !== true) throw new DiskFailure(String(r.error ?? 'failed'), String(r.code ?? 'failed'));
    return r;
  }

  /** {reason} (why not), or {key}: an opaque id of the project's git folder. */
  async resolve(): Promise<{ reason: string } | { key: string }> {
    const r = await this.one({ op: 'resolve' });
    return typeof r.reason === 'string' ? { reason: r.reason } : { key: String(r.key ?? '') };
  }
  async rootKind(): Promise<'missing' | 'dir' | 'link' | 'file'> {
    return (await this.one({ op: 'rootKind' })).kind as 'missing' | 'dir' | 'link' | 'file';
  }
  async mkRoot(): Promise<void> {
    await this.one({ op: 'mkRoot' });
  }
  /** Every entry of the folder in one call (links listed, never followed). */
  async walk(): Promise<{ entries: WalkEntry[]; incomplete: boolean }> {
    const r = await this.one({ op: 'walk' });
    return { entries: (r.entries as WalkEntry[]) ?? [], incomplete: r.incomplete === true };
  }
  async stat(rel: string): Promise<FileStat | null> {
    return ((await this.one({ op: 'stat', rel })).st as FileStat | null) ?? null;
  }
  /** Throws unless the file's folders are real (never links); `create` makes the missing ones. */
  async safe(rel: string, create: boolean): Promise<void> {
    await this.one({ op: 'safe', rel, create });
  }
  /** The sha256 of each file; null: it changed while it was read, or could not be read (the next scan looks again). `failed`: could not be read. */
  async hashFiles(items: { rel: string; size: number; mtime: number }[]): Promise<{ hash: string | null; failed: boolean }[]> {
    const out: { hash: string | null; failed: boolean }[] = [];
    for (let i = 0; i < items.length; i += HASH_BATCH) {
      const part = items.slice(i, i + HASH_BATCH);
      const results = await this.batch(part.map((x) => ({ op: 'hash', rel: x.rel, size: x.size, mtime: x.mtime })));
      for (const r of results) out.push(r.ok !== true ? { hash: null, failed: true } : { hash: typeof r.hash === 'string' ? r.hash : null, failed: false });
    }
    return out;
  }
  /** A whole file (a doc), or null when it is not a plain file now. `size`/`mtime` of what it was when read. */
  async readAll(rel: string): Promise<{ bytes: Uint8Array; size: number; mtime: number } | null> {
    const r = await this.one({ op: 'read', rel });
    return r.gone === true ? null : { bytes: r.bytes as Uint8Array, size: Number(r.size), mtime: Number(r.mtime) };
  }
  /** One chunk for the other PC; null when the file is not what was announced (size and mtime) or ends early. */
  async readChunk(rel: string, offset: number, len: number, size: number, mtime: number): Promise<Uint8Array | null> {
    const r = await this.one({ op: 'read', rel, offset, len, size, mtime });
    return r.gone === true ? null : (r.bytes as Uint8Array);
  }
  async tmpClean(): Promise<void> {
    await this.one({ op: 'tmpClean' });
  }
  async tmpWrite(t: string, bytes: Uint8Array, first: boolean): Promise<void> {
    await this.one({ op: 'tmpWrite', t, bytes, first });
  }
  async tmpRead(t: string): Promise<Uint8Array> {
    return (await this.one({ op: 'tmpRead', t })).bytes as Uint8Array;
  }
  /** Never throws (a temp file that cannot be removed is cleaned at the next start). */
  tmpRemove(t: string): void {
    void this.one({ op: 'tmpRemove', t }).catch(() => {});
  }
  async install(t: string, rel: string, o: { bin?: boolean; mtime?: number; hash?: boolean } = {}): Promise<{ size: number; mtime: number; hash?: string; binned: number }> {
    const r = await this.one({ op: 'install', t, rel, ...(o.bin ? { bin: true } : {}), ...(o.mtime ? { mtime: o.mtime } : {}), ...(o.hash ? { hash: true } : {}) });
    return { size: Number(r.size), mtime: Number(r.mtime), binned: Number(r.binned) || 0, ...(typeof r.hash === 'string' ? { hash: r.hash } : {}) };
  }
  async copy(rel: string, to: string): Promise<{ size: number; mtime: number }> {
    const r = await this.one({ op: 'copy', rel, to });
    return { size: Number(r.size), mtime: Number(r.mtime) };
  }
  async copyToTmp(rel: string, t: string): Promise<void> {
    await this.one({ op: 'copyToTmp', rel, t });
  }
  /** Move or copy a file into the bin; the size that went in. */
  async bin(rel: string, move: boolean): Promise<number> {
    return Number((await this.one({ op: 'bin', rel, move })).size) || 0;
  }
  async capBin(max: number): Promise<void> {
    await this.one({ op: 'capBin', max });
  }
  /** The other PC deleted the file: it goes to the bin. `changed`: it changed since the scan, nothing was done. */
  async deleteFile(rel: string, size: number, mtime: number): Promise<{ changed: boolean; binned: number }> {
    const r = await this.one({ op: 'deleteFile', rel, size, mtime });
    return { changed: r.changed === true, binned: Number(r.binned) || 0 };
  }
  async binList(limit: number): Promise<{ id: string; path: string; at: string; size: number }[]> {
    return ((await this.one({ op: 'binList', limit })).entries as { id: string; path: string; at: string; size: number }[]) ?? [];
  }
  async binToTmp(id: string, t: string): Promise<void> {
    await this.one({ op: 'binToTmp', id, t });
  }
  async binPrune(days: number, max: number): Promise<void> {
    await this.one({ op: 'binPrune', days, max });
  }
  async caseInsensitive(): Promise<boolean> {
    return (await this.one({ op: 'caseTest' })).insensitive === true;
  }
  /** What git is doing in the project (a merge, a rebase...) and its branch. */
  async git(): Promise<{ busy: string | null; branch: string | null }> {
    const r = await this.one({ op: 'git' });
    return { busy: typeof r.busy === 'string' ? r.busy : null, branch: typeof r.branch === 'string' ? r.branch : null };
  }
}

/** The disk of a Windows (or Linux) project on this machine. */
export function localDisk(project: string, area: Area, sync: string): SyncDisk {
  const ops = new DiskOps(project, area, sync);
  return new SyncDisk(async (list) => {
    const out: Json[] = [];
    for (const op of list) {
      try {
        out.push({ ok: true, ...(await ops.run(op)) });
      } catch (error) {
        out.push({ ok: false, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? 'failed' });
      }
    }
    return out;
  }, { watchRoot: ops.root, available: () => '' });
}
