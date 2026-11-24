/**
 * The docs' file layer: every read and write the docs store (store.ts), charts (charts.ts) and drawings (drawing/assets.ts) make in
 * a project folder goes through here, picked by the path:
 *   - a path of this PC: `localFs`, Deno's file calls exactly as the store made them before this layer existed;
 *   - a WSL project's path (a `wsl://<distro>/…` ref): the remote layer wsl/docs.ts registers (setRemoteDocFs). Each call is one
 *     `docs.fs` call to the distro's helper, which does the file work natively there (atomic writes are a temp file and a rename in
 *     the distro). AIB's own state (the docs cache, history) stays on Windows and never comes here.
 * A remote layer answers "missing" (null) exactly like the local one, and throws DocRefusal `wsl_unavailable` when the distro cannot
 * be reached: a caller never mistakes "Ubuntu is not running" for "there is no such doc".
 */
import { isWslRef } from '../platform/location.ts';
import { DocRefusal } from './live_doc.ts';

const WIN = Deno.build.os === 'windows';

export interface DocFsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface DocFsStat {
  isFile: boolean;
  isDirectory: boolean;
  mtime: Date | null;
}

/** Where a folder goes on "Move doc to trash" (desktop/project_delete.ts TrashLayer, for one folder). */
export interface DocTrash {
  /** 'permanent': no trash for it (the caller refuses). */
  kind(path: string): Promise<string>;
  trash(path: string, kind: string): Promise<void>;
}

export interface DocFs {
  readonly sep: string;
  /** The text, or null when it cannot be read (missing, unreadable). */
  readText(path: string): Promise<string | null>;
  /** null when it is not there (or cannot be seen). */
  stat(path: string): Promise<DocFsStat | null>;
  /** The folder's entries, or null when it cannot be listed (missing). */
  readDir(path: string): Promise<DocFsEntry[] | null>;
  /** mkdir -p. */
  mkdir(path: string): Promise<void>;
  /** A new file only (createNew): false when one is there already. */
  writeNew(path: string, text: string): Promise<boolean>;
  /** A plain write (charts' pictures). */
  writeText(path: string, text: string): Promise<void>;
  /** Write through a temp file and a rename, after mkdir -p of its folder. */
  writeAtomic(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Throws when it fails (callers that do not care catch it). */
  remove(path: string, recursive?: boolean): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  /** The trash of a remote layer (a local doc uses the system trash: docs_routes.ts). */
  readonly trash?: DocTrash;
}

const localSep = WIN ? '\\' : '/';

/** This PC's own files: Deno's calls, with the store's own error handling (a failed read or stat is "not there"). */
export const localFs: DocFs = {
  sep: localSep,
  async readText(path) {
    try {
      return await Deno.readTextFile(path);
    } catch {
      return null;
    }
  },
  async stat(path) {
    try {
      const st = await Deno.stat(path);
      return { isFile: st.isFile, isDirectory: st.isDirectory, mtime: st.mtime };
    } catch {
      return null;
    }
  },
  async readDir(path) {
    try {
      const out: DocFsEntry[] = [];
      for await (const e of Deno.readDir(path)) out.push({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory });
      return out;
    } catch {
      return null;
    }
  },
  async mkdir(path) {
    await Deno.mkdir(path, { recursive: true });
  },
  async writeNew(path, text) {
    try {
      await Deno.writeTextFile(path, text, { createNew: true });
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) return false;
      throw error;
    }
  },
  async writeText(path, text) {
    await Deno.writeTextFile(path, text);
  },
  async writeAtomic(path, text) {
    await Deno.mkdir(path.slice(0, path.lastIndexOf(localSep)), { recursive: true });
    const tmp = `${path}.${Deno.pid}.tmp`;
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, path);
  },
  async rename(from, to) {
    await Deno.rename(from, to);
  },
  async remove(path, recursive = false) {
    await Deno.remove(path, recursive ? { recursive: true } : undefined);
  },
  async copyFile(from, to) {
    await Deno.copyFile(from, to);
  },
};

type Remote = (path: string) => DocFs | null;
let remote: Remote | null = null;

/** wsl/docs.ts (and tests): the layer for WSL refs (null: none, a WSL doc is refused). */
export function setRemoteDocFs(fn: Remote | null): void {
  remote = fn;
}

/** Is this path inside a WSL project (a ref)? Such a path is never handed to this PC's file calls. */
export function isRemotePath(path: string): boolean {
  return isWslRef(path);
}

/** The layer for a path. */
export function fsOf(path: string): DocFs {
  if (!isWslRef(path)) return localFs;
  const fs = remote?.(path) ?? null;
  if (!fs) throw new DocRefusal('wsl_unavailable', 'Docs of this WSL project cannot be reached from AIB right now.');
  return fs;
}

/** The separator joins under this path use: '/' in a WSL ref, else this PC's. */
export function sepOf(path: string): string {
  return isWslRef(path) ? '/' : localSep;
}

/** A path as a comparison key: Windows paths fold case; a WSL ref's Linux path is case-sensitive (its distro is folded already). */
export function pathKey(path: string): string {
  return WIN && !isWslRef(path) ? path.toLowerCase() : path;
}
