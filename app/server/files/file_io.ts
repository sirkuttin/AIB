/**
 * Where the file editor's disk work happens (files/live_files.ts): a Windows file through Deno on this PC, a WSL project's file through
 * AIB's helper inside the distro (wsl/helper/editor.ts), never through \\wsl$. Both give the registry the same answers, so a WSL file
 * gets the same guarantees: the settled read, the raw-byte hash check, the atomic save, line endings, BOM and encoding kept (the bytes
 * are encoded and decoded by files/file_text.ts on Windows either way).
 *
 * WSL differences, all inside the distro: the hash check runs again right before the rename (a write between AIB's read and the save
 * is refused as 'changed': the save reads again and merges); the save keeps the target's mode, owner and group and refuses when it
 * can't; a distro that is not running answers 'away' (the poll skips it, never "deleted"; a save fails with code 'wsl_away').
 */
import * as osp from '../platform/ospath.ts';
import { decodeDisk, type DiskText, EDIT_LIMIT, readDisk } from './file_text.ts';
import { writeAtomicBytes } from '../worktrees/atomic.ts';
import { WslHelperError, type WslHost } from '../wsl/contract.ts';
import { distroName, hostWhenReady, peekWslHost, wslLoc, wslTestHomeEnv } from '../wsl/access.ts';
import { BLOCKED_HOME_DIRS } from '../remote/path_guard.ts';
import { FilesError } from '../worktrees/files.ts';

export interface Stat {
  size: number;
  mtime: number;
}
export interface Where {
  /** The real path (Windows) or the ref of the real Linux path (WSL). */
  abs: string;
  /** The project folder (Windows: resolved; WSL: its ref) and the path inside it. */
  root: string;
  rel: string;
}
export type Read = { disk: DiskText; mtime: number };
/** The distro is not reachable now: nothing is known about the file. */
export const AWAY = 'away' as const;

export interface FileIo {
  stat(at: Where): Promise<Stat | null | typeof AWAY>;
  /** Settled: a stat, `settleMs`, a stat, the read and a stat agree. */
  readSettled(at: Where, settleMs: number): Promise<Read | null | 'moving' | typeof AWAY>;
  /** One read, not settled. */
  readNow(at: Where): Promise<Read | null | 'moving' | typeof AWAY>;
  /** Atomic save; `expect` is the raw-byte sha the save compared (null: the file was deleted). Returns the new mtime. */
  write(at: Where, bytes: Uint8Array, expect: string | null): Promise<number>;
  sweep(at: Where): Promise<void>;
  /** The disk's bytes now (Compare), null when gone. */
  bytes(at: Where): Promise<Uint8Array | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SAVE_TEMP = /^\.aib-save-[0-9a-f]{8}\.tmp$/i;

export function statSync(abs: string): Stat | null {
  try {
    const st = Deno.statSync(abs);
    return st.isFile ? { size: st.size, mtime: st.mtime ? st.mtime.getTime() : 0 } : null;
  } catch {
    return null;
  }
}
export const sameStat = (a: Stat | null, b: Stat | null) => (!a && !b) || (!!a && !!b && a.size === b.size && a.mtime === b.mtime);

/** A file on this PC. */
export const winIo: FileIo = {
  stat: (at) => Promise.resolve(statSync(at.abs)),
  async readSettled(at, settleMs) {
    const abs = at.abs;
    const a = statSync(abs);
    await sleep(settleMs);
    const b = statSync(abs);
    if (!sameStat(a, b)) return 'moving';
    if (!b) return null;
    let bytes: Uint8Array;
    try {
      bytes = b.size > EDIT_LIMIT ? new Uint8Array() : Deno.readFileSync(abs);
    } catch {
      return 'moving';
    }
    const c = statSync(abs);
    if (!sameStat(b, c)) return 'moving';
    if (b.size > EDIT_LIMIT) {
      const { disk } = readDisk(abs);
      return { disk, mtime: b.mtime };
    }
    return { disk: decodeDisk(bytes), mtime: b.mtime };
  },
  readNow(at) {
    if (!statSync(at.abs)) return Promise.resolve(null);
    try {
      const { disk, mtime } = readDisk(at.abs);
      return Promise.resolve({ disk, mtime });
    } catch {
      return Promise.resolve('moving' as const);
    }
  },
  async write(at, bytes) {
    const abs = at.abs;
    if (!osp.isdir(osp.dirname(abs))) throw new Deno.errors.NotFound('folder gone');
    await writeAtomicBytes(abs, bytes, abs, { prefix: '.aib-save-', flush: true, mkdir: false });
    return statSync(abs)?.mtime ?? Date.now();
  },
  sweep(at) {
    try {
      const dir = osp.dirname(at.abs);
      for (const e of Deno.readDirSync(dir)) {
        if (!e.isFile || !SAVE_TEMP.test(e.name)) continue;
        const p = osp.join(dir, e.name);
        const st = Deno.statSync(p);
        if (st.mtime && Date.now() - st.mtime.getTime() > 60_000) Deno.removeSync(p);
      }
    } catch { /* nothing to sweep */ }
    return Promise.resolve();
  },
  bytes(at) {
    try {
      return Promise.resolve(Deno.readFileSync(at.abs));
    } catch {
      return Promise.resolve(null);
    }
  },
};

// ---- WSL ----------------------------------------------------------------------------------------------------------------------------

const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
function b64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
/** The largest piece one helper call carries (helper/editor.ts EDITOR_CHUNK). */
const CHUNK = 1024 * 1024;
const CALL_MS = 30_000;
/** How long an open or a save waits for a distro that is starting. */
const READY_MS = 20_000;

/** The helper's answer to an editor call that was refused by the guard or the place (code), as the registry reads it. */
export class WslEditRefused extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'WslEditRefused';
  }
}

/** Codes that mean the distro or its helper is away (nothing is known about the file). */
const AWAY_CODES = new Set([
  'stopped',
  'helper_gone',
  'helper_exited',
  'helper_restart',
  'helper_timeout',
  'not_installed',
  'unsupported',
  'timeout',
]);
export const isAway = (error: unknown) =>
  (error instanceof WslHelperError && AWAY_CODES.has(error.code)) || (error instanceof Error && error.name === 'ValueError');

/**
 * The folders the guard refuses on top of the helper's own list: under test, the agents' home inside AIB_WSL_ROOT (wsl/access.ts
 * wslTestHomeEnv), whose sign-in folders are the ones AIB's WSL agents use.
 */
export function extraBlocked(): string[] {
  let env: Record<string, string>;
  try {
    env = wslTestHomeEnv();
  } catch {
    env = {}; // under test without AIB_WSL_ROOT: no agent home in a distro
  }
  const out: string[] = [];
  if (env.HOME) { for (const d of BLOCKED_HOME_DIRS) out.push(`${env.HOME}/${d}`); }
  if (env.CLAUDE_CONFIG_DIR) out.push(env.CLAUDE_CONFIG_DIR);
  if (env.CODEX_HOME) out.push(env.CODEX_HOME);
  return out;
}

function linuxOf(ref: string): { distro: string; linuxPath: string } {
  const loc = wslLoc(ref);
  if (!loc) throw new FilesError('This folder cannot be shown', 'bad_root', 404);
  return loc;
}

/** The helper's answer to a refused place, as a FilesError (out of the project, .git, gone) or a WslEditRefused (the guard). */
export function placeError(error: unknown): Error {
  if (!(error instanceof WslHelperError)) return error as Error;
  if (['not_found', 'outside', 'hidden', 'not_file', 'bad_root', 'missing'].includes(error.code)) {
    return new FilesError(
      error.code === 'hidden' ? 'Not shown' : error.code === 'not_file' ? 'Not a file' : 'Not found',
      error.code,
      error.code === 'hidden' || error.code === 'not_file' ? 400 : 404,
    );
  }
  if (['blocked', 'worktree', 'data'].includes(error.code)) return new WslEditRefused(error.message, error.code);
  return error;
}

export interface WslRead extends Read {
  /** The real Linux path and the path inside the project, as the helper resolved them. */
  real: string;
  rel: string;
}

/** A WSL project's file: every call goes to the distro's helper. */
export class WslIo implements FileIo {
  /** Tests: how long an open or a save waits for the distro. */
  readyMs = READY_MS;

  /** The ready host, or AWAY. `start`: wait for a distro that is starting (an open, a save); the poll never waits. */
  async #host(ref: string, start: boolean): Promise<WslHost | typeof AWAY> {
    const { distro } = linuxOf(ref);
    if (!start) {
      const host = peekWslHost(distro);
      return host && host.state === 'ready' ? host : AWAY;
    }
    try {
      return await hostWhenReady(distro, this.readyMs);
    } catch {
      return AWAY;
    }
  }

  #params(at: Where) {
    return { root: linuxOf(at.root).linuxPath, rel: at.rel, blocked: extraBlocked() };
  }

  /** The distro's name for messages ("Ubuntu"). */
  distroOf(at: Where): string {
    return distroName(linuxOf(at.root).distro);
  }

  async stat(at: Where): Promise<Stat | null | typeof AWAY> {
    const host = await this.#host(at.root, false);
    if (host === AWAY) return AWAY;
    try {
      const st = await host.call('fs.stat', { path: linuxOf(at.abs).linuxPath }, { timeoutMs: CALL_MS });
      return st.exists && st.isFile ? { size: st.size, mtime: st.mtimeMs } : null;
    } catch {
      return AWAY;
    }
  }

  /** The whole read (pieces of 1 MB, each checked against the first one's size and mtime); throws placeError's errors. */
  async read(
    at: Where,
    settleMs: number,
    start: boolean,
  ): Promise<WslRead | { gone: true; real: string; rel: string } | 'moving' | typeof AWAY> {
    const host = await this.#host(at.root, start);
    if (host === AWAY) return AWAY;
    const params = this.#params(at);
    let first;
    try {
      first = await host.call('editor.read', { ...params, settleMs }, { timeoutMs: CALL_MS + settleMs });
    } catch (error) {
      if (isAway(error)) return AWAY;
      throw placeError(error);
    }
    if (first.state === 'moving') return 'moving';
    if (first.state === 'gone') return { gone: true, real: first.real, rel: first.rel };
    const size = first.size ?? 0, mtime = first.mtimeMs ?? 0;
    const head = unb64(first.bytesB64 ?? '');
    if (first.tooBig) {
      const disk = decodeDisk(head, size);
      return {
        disk: { ...disk, sha: `size:${size}:${mtime}`, reason: disk.reason || 'too_big', editable: false, text: null },
        mtime,
        real: first.real,
        rel: first.rel,
      };
    }
    const all = new Uint8Array(size);
    all.set(head.subarray(0, size), 0);
    let at2 = head.length;
    while (at2 < size) {
      let piece;
      try {
        piece = await host.call('editor.read', { ...params, offset: at2 }, { timeoutMs: CALL_MS });
      } catch (error) {
        if (isAway(error)) return AWAY;
        throw placeError(error);
      }
      if (piece.state !== 'ok' || piece.size !== size || piece.mtimeMs !== mtime) return 'moving';
      const bytes = unb64(piece.bytesB64 ?? '');
      if (!bytes.length) return 'moving';
      all.set(bytes.subarray(0, size - at2), at2);
      at2 += bytes.length;
    }
    return { disk: decodeDisk(all), mtime, real: first.real, rel: first.rel };
  }

  async #readQuiet(at: Where, settleMs: number): Promise<Read | null | 'moving' | typeof AWAY> {
    try {
      const got = await this.read(at, settleMs, false);
      if (got === 'moving' || got === AWAY) return got;
      return 'gone' in got ? null : { disk: got.disk, mtime: got.mtime };
    } catch (error) {
      // refused now (a link moved out, a folder became blocked): treat as gone for the poll; a save says why
      if (error instanceof FilesError && (error.code === 'not_found' || error.code === 'missing')) return null;
      return AWAY;
    }
  }

  readSettled(at: Where, settleMs: number) {
    return this.#readQuiet(at, settleMs);
  }

  readNow(at: Where) {
    return this.#readQuiet(at, 0);
  }

  async write(at: Where, bytes: Uint8Array, expect: string | null): Promise<number> {
    const host = await this.#host(at.root, true);
    if (host === AWAY) throw new WslHelperError(`${this.distroOf(at)} is not running`, 'stopped');
    const params = this.#params(at);
    const token = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    let offset = 0;
    try {
      do {
        const piece = bytes.subarray(offset, offset + CHUNK);
        const done = offset + piece.length >= bytes.length;
        const r = await host.call('editor.write', { ...params, token, offset, bytesB64: b64(piece), done, ...(done ? { expect } : {}) }, {
          timeoutMs: CALL_MS,
        });
        offset += piece.length;
        if (done) return r.mtimeMs ?? Date.now();
      } while (offset <= bytes.length);
    } catch (error) {
      throw placeError(error);
    }
    return Date.now();
  }

  async sweep(at: Where): Promise<void> {
    const host = await this.#host(at.root, false);
    if (host === AWAY) return;
    await host.call('editor.sweep', this.#params(at), { timeoutMs: CALL_MS }).catch(() => {});
  }

  async bytes(at: Where): Promise<Uint8Array | null> {
    // Compare: the whole file as the helper reads it, re-encoded is not needed; the raw bytes come back in pieces
    const host = await this.#host(at.root, true);
    if (host === AWAY) return null;
    const params = this.#params(at);
    try {
      const first = await host.call('editor.read', params, { timeoutMs: CALL_MS });
      if (first.state !== 'ok') return null;
      const size = first.size ?? 0;
      const head = unb64(first.bytesB64 ?? '');
      if (first.tooBig) return head;
      const all = new Uint8Array(size);
      all.set(head.subarray(0, size));
      let off = head.length;
      while (off < size) {
        const piece = await host.call('editor.read', { ...params, offset: off }, { timeoutMs: CALL_MS });
        const b = unb64(piece.bytesB64 ?? '');
        if (piece.state !== 'ok' || !b.length) return null;
        all.set(b.subarray(0, size - off), off);
        off += b.length;
      }
      return all;
    } catch {
      return null;
    }
  }
}

export const wslIo = new WslIo();

/** The io for a file: a WSL ref goes to the distro. */
export const ioOf = (abs: string): FileIo => (wslLoc(abs) ? wslIo : winIo);
