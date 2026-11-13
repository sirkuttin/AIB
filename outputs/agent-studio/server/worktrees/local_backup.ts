/**
 * The daily backup of local-only folders (Deno only, the web process). Local-only files (AIB's block of .git/info/exclude, see
 * local_only.ts) are never committed, so git holds no copy of them. Once a day each project's local-only files are zipped into
 *
 *     <state dir>/local-only-backups/<repoHash(project)>.zip     plus .json: project, time, signature, files, skipped files
 *
 * and only that one zip is kept (owner decision 7: one zip, replaced daily; Q1 b: no size cap, everything is zipped).
 *
 *   when      checked a little after start and then every hour; a project is backed up when it has no zip yet, or when its zip
 *             is 24 h old or more AND its files changed (paths, sizes, mtimes)
 *   how       written here (no tar.exe: no console window, and Linux has no zip-capable tar): deflate through CompressionStream,
 *             CRC-32, UTF-8 names (flag bit 11), ZIP64 records only when a size, offset or the file count needs them
 *   safety    written to `<hash>.zip.partial`, then renamed over the old zip; when that fails (the zip is open), the old zip stays
 *             and the next hour tries again. A file that can't be read (held open by another program) is skipped and listed in
 *             the .json. One FileLock per project, so two AIBs never write the same zip. node_modules and .git are skipped.
 */
import * as osp from '../platform/ospath.ts';
import { FileLock, LockTimeout } from '../platform/lock.ts';
import { getLogger } from '../core/log.ts';
import { localOnlyOf } from './local_only.ts';
import { repoHash } from './worktrees.ts';

const log = getLogger('local_backup');

export const FOLDER = 'local-only-backups';
export const DAY_MS = 24 * 3600 * 1000;
export const settings = { EVERY_MS: 3600 * 1000, FIRST_MS: 30 * 1000 };

export type BackupStatus = 'made' | 'recent' | 'unchanged' | 'none' | 'busy' | 'failed';
export interface BackupResult {
  status: BackupStatus;
  zip?: string;
  files?: number;
  skipped?: { path: string; reason: string }[];
}
interface Meta {
  project: string;
  time: number;
  date: string;
  sig: string;
  files: number;
  bytes: number;
  skipped: { path: string; reason: string }[];
}

// ---- the files ------------------------------------------------------------------------------------------------------------
interface Item {
  rel: string; // project-relative, forward slashes
  abs: string;
  size: number;
  mtime: number;
}

/** Every regular file under the project's existing local-only entries (symlinks not followed; node_modules and .git skipped). */
function itemsOf(project: string, existing: string[]): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  const walk = (abs: string, rel: string) => {
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(abs);
    } catch {
      return;
    }
    if (st.isFile) {
      const key = osp.normcase(abs);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ rel, abs, size: st.size, mtime: st.mtime?.getTime() ?? 0 });
      }
      return;
    }
    if (!st.isDirectory) return;
    let names: string[];
    try {
      names = [...Deno.readDirSync(abs)].map((e) => e.name).sort();
    } catch {
      return;
    }
    for (const name of names) if (name !== 'node_modules' && name !== '.git') walk(osp.join(abs, name), `${rel}/${name}`);
  };
  const top = osp.normpath(project);
  for (const abs of existing) {
    const norm = osp.normpath(abs);
    const rel = norm.slice(top.length).replace(/^[\\/]+/, '').replaceAll('\\', '/');
    if (rel) walk(norm, rel);
  }
  return out;
}

async function signatureOf(items: Item[]): Promise<string> {
  const text = JSON.stringify(items.map((i) => [i.rel, i.size, i.mtime]));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- the zip writer -------------------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(ms: number): [number, number] {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return [time & 0xffff, date & 0xffff];
}

const MAX32 = 0xffffffff;
const ZIP64_AT = 0xf0000000; // a file this big gets ZIP64 sizes in its local header (its compressed size is not known yet)

class Writer {
  pos = 0;
  constructor(readonly file: Deno.FsFile) {}
  async write(bytes: Uint8Array): Promise<void> {
    let at = 0;
    while (at < bytes.length) at += await this.file.write(bytes.subarray(at));
    this.pos += bytes.length;
  }
  async seek(pos: number): Promise<void> {
    await this.file.seek(pos, Deno.SeekMode.Start);
    this.pos = pos;
  }
}

class Bytes {
  #parts: number[] = [];
  u16(v: number) {
    this.#parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.u16(v & 0xffff).u16(Math.floor(v / 0x10000) & 0xffff);
    return this;
  }
  u64(v: number) {
    this.u32(v % 0x100000000).u32(Math.floor(v / 0x100000000));
    return this;
  }
  raw(b: Uint8Array) {
    for (const x of b) this.#parts.push(x);
    return this;
  }
  get bytes() {
    return new Uint8Array(this.#parts);
  }
}

interface Entry {
  name: Uint8Array;
  crc: number;
  comp: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** Appends one file (deflated) to the zip; throws when it can't be read (the caller rolls back to the entry's offset). */
async function addFile(w: Writer, item: Item, entries: Entry[]): Promise<void> {
  const src = await Deno.open(item.abs, { read: true });
  const name = new TextEncoder().encode(item.rel);
  const [time, date] = dosTime(item.mtime);
  const offset = w.pos;
  const big = item.size >= ZIP64_AT;
  const header = () =>
    new Bytes().u32(0x04034b50).u16(big ? 45 : 20).u16(0x0800).u16(8).u16(time).u16(date);
  // placeholders now, the real CRC and sizes once the data is written
  await w.write(header().u32(0).u32(big ? MAX32 : 0).u32(big ? MAX32 : 0).u16(name.length).u16(big ? 20 : 0).raw(name).bytes);
  if (big) await w.write(new Bytes().u16(0x0001).u16(16).u64(0).u64(0).bytes);
  const start = w.pos;
  let crc = 0, size = 0;
  const tap = new TransformStream<Uint8Array, BufferSource>({
    transform(chunk, out) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      out.enqueue(chunk as Uint8Array<ArrayBuffer>);
    },
  });
  for await (const chunk of src.readable.pipeThrough(tap).pipeThrough(new CompressionStream('deflate-raw'))) await w.write(chunk);
  const comp = w.pos - start;
  if (!big && (comp >= MAX32 || size >= MAX32)) throw new Error('grew past 4 GB while being read');
  const end = w.pos;
  await w.seek(offset + 14);
  await w.write(new Bytes().u32(crc).u32(big ? MAX32 : comp).u32(big ? MAX32 : size).bytes);
  if (big) {
    await w.seek(offset + 30 + name.length + 4);
    await w.write(new Bytes().u64(size).u64(comp).bytes);
  }
  await w.seek(end);
  entries.push({ name, crc, comp, size, offset, time, date });
}

async function finish(w: Writer, entries: Entry[]): Promise<void> {
  const cdStart = w.pos;
  for (const e of entries) {
    const needs = e.comp >= MAX32 || e.size >= MAX32 || e.offset >= MAX32;
    const extra = new Bytes();
    if (needs) {
      const fields = new Bytes();
      if (e.size >= MAX32) fields.u64(e.size);
      if (e.comp >= MAX32) fields.u64(e.comp);
      if (e.offset >= MAX32) fields.u64(e.offset);
      const body = fields.bytes;
      extra.u16(0x0001).u16(body.length).raw(body);
    }
    const ex = extra.bytes;
    await w.write(
      new Bytes().u32(0x02014b50).u16((needs ? 45 : 20) | (3 << 8)).u16(needs ? 45 : 20).u16(0x0800).u16(8).u16(e.time).u16(e.date)
        .u32(e.crc).u32(Math.min(e.comp, MAX32)).u32(Math.min(e.size, MAX32)).u16(e.name.length).u16(ex.length).u16(0).u16(0).u16(0)
        .u32(0).u32(Math.min(e.offset, MAX32)).raw(e.name).raw(ex).bytes,
    );
  }
  const cdSize = w.pos - cdStart;
  if (entries.length > 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
    const at = w.pos;
    await w.write(
      new Bytes().u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(entries.length).u64(entries.length).u64(cdSize).u64(cdStart)
        .bytes,
    );
    await w.write(new Bytes().u32(0x07064b50).u32(0).u64(at).u32(1).bytes);
  }
  const n = Math.min(entries.length, 0xffff);
  await w.write(new Bytes().u32(0x06054b50).u16(0).u16(0).u16(n).u16(n).u32(Math.min(cdSize, MAX32)).u32(Math.min(cdStart, MAX32)).u16(0).bytes);
}

/** Writes `items` into a new zip at `path`: the files that could not be read are returned (and left out). */
export async function writeZip(path: string, items: Item[]): Promise<{ path: string; reason: string }[]> {
  const skipped: { path: string; reason: string }[] = [];
  const file = await Deno.open(path, { write: true, create: true, truncate: true, read: true });
  try {
    const w = new Writer(file);
    const entries: Entry[] = [];
    for (const item of items) {
      const offset = w.pos;
      try {
        await addFile(w, item, entries);
      } catch (error) {
        skipped.push({ path: item.rel, reason: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error) });
        await w.seek(offset);
        await file.truncate(offset);
      }
    }
    await finish(w, entries);
  } finally {
    file.close();
  }
  return skipped;
}

// ---- one project ----------------------------------------------------------------------------------------------------------
export function backupFolder(stateDir: string): string {
  return osp.join(stateDir, FOLDER);
}

function readMeta(path: string): Meta | null {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(path));
    return raw && typeof raw === 'object' && typeof raw.time === 'number' && typeof raw.sig === 'string' ? raw as Meta : null;
  } catch {
    return null;
  }
}

/** Backs up one project's local-only files when it is due (see the header). `now` in ms (tests move it). */
export async function backupProject(stateDir: string, project: string, now = Date.now()): Promise<BackupResult> {
  if (!osp.isdir(project)) return { status: 'none' };
  const lo = await localOnlyOf(project);
  if (!lo || !lo.existing.length) return { status: 'none' };
  const folder = backupFolder(stateDir);
  const base = osp.join(folder, repoHash(project));
  const zip = base + '.zip', metaPath = base + '.json';
  const items = itemsOf(project, lo.existing);
  if (!items.length) return { status: 'none' };
  const sig = await signatureOf(items);
  const old = readMeta(metaPath);
  const hasZip = osp.isfile(zip);
  if (old && hasZip) {
    if (now - old.time < DAY_MS) return { status: 'recent', zip };
    if (old.sig === sig) return { status: 'unchanged', zip };
  }
  Deno.mkdirSync(folder, { recursive: true });
  const lock = new FileLock(base + '.lock', 2000);
  try {
    await lock.acquire();
  } catch (error) {
    if (error instanceof LockTimeout) return { status: 'busy' }; // another AIB is writing it
    throw error;
  }
  const partial = zip + '.partial';
  try {
    const skipped = await writeZip(partial, items);
    try {
      Deno.renameSync(partial, zip);
    } catch (error) {
      log.warning('Could not replace %s (%s); the old backup is kept and tried again in an hour', zip, error);
      return { status: 'busy', zip };
    }
    const meta: Meta = {
      project,
      time: now,
      date: new Date(now).toISOString(),
      sig,
      files: items.length - skipped.length,
      bytes: items.reduce((n, i) => n + i.size, 0),
      skipped,
    };
    const tmp = metaPath + '.tmp';
    Deno.writeTextFileSync(tmp, JSON.stringify(meta, null, 1));
    Deno.renameSync(tmp, metaPath);
    return { status: 'made', zip, files: meta.files, skipped };
  } catch (error) {
    log.exception(error, 'Backing up the local-only files of %s failed', project);
    return { status: 'failed' };
  } finally {
    try {
      Deno.removeSync(partial);
    } catch { /* renamed, or never written */ }
    lock.release();
  }
}

// ---- the schedule ---------------------------------------------------------------------------------------------------------
export interface Backups {
  runOnce(): Promise<Map<string, BackupResult>>;
  stop(): void;
}

/** Starts the hourly check (the first a little after start). `projects` lists the folders to look at; `now` is for tests. */
export function startLocalBackups(
  options: { stateDir: string; projects: () => string[] | Promise<string[]>; now?: () => number; schedule?: boolean },
): Backups {
  let running: Promise<Map<string, BackupResult>> | null = null;
  const timers: number[] = [];
  const keep = (t: unknown) => {
    Deno.unrefTimer(t as number);
    timers.push(t as number);
  };
  const runOnce = (): Promise<Map<string, BackupResult>> => {
    running ??= (async () => {
      const done = new Map<string, BackupResult>();
      try {
        const seen = new Set<string>();
        for (const project of await options.projects()) {
          const key = osp.normcase(osp.normpath(project));
          if (!project || seen.has(key)) continue;
          seen.add(key);
          try {
            done.set(project, await backupProject(options.stateDir, project, (options.now ?? Date.now)()));
          } catch (error) {
            log.exception(error, 'Backing up the local-only files of %s failed', project);
            done.set(project, { status: 'failed' });
          }
        }
      } finally {
        running = null;
      }
      return done;
    })();
    return running;
  };
  if (options.schedule !== false) {
    const first = setTimeout(() => {
      void runOnce();
      keep(setInterval(() => void runOnce(), settings.EVERY_MS));
    }, settings.FIRST_MS);
    keep(first);
  }
  return {
    runOnce,
    stop() {
      for (const t of timers.splice(0)) {
        clearTimeout(t);
        clearInterval(t);
      }
    },
  };
}
