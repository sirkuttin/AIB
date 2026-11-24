/**
 * The file editor's disk work for WSL projects, natively in the distro (AIB 0.13.0; files/wsl_disk.ts is AIB's end, files/live_files.ts
 * holds the live text on Windows exactly as for a Windows file). Nothing goes through \\wsl$: every read and save is one of these
 * methods, run by the helper as the distro user.
 *
 * Where (every call): `rel` inside `root`, resolved in the distro after links (worktrees/files.ts resolveInside: no link or `..` out of
 * the project, nothing inside .git), so a save follows a symlink to its target inside the project. Then the guard, for every caller:
 *   - the agents' sign-in folders and the internal defaults under the distro user's home (path_guard.ts BLOCKED_HOME_DIRS / FILES, also
 *     by the /root and /home/<user> rule, linuxBlocked), the moved ones (CLAUDE_CONFIG_DIR, CODEX_HOME of the login environment) and
 *     the folders AIB names (`blocked`: under test, the agents' home inside AIB_WSL_ROOT): code 'blocked';
 *   - AIB's own folders in the distro (its data folder: 'worktree' for the chats' copies, else 'data'; its root and program folder:
 *     'data', except AIB's root under test, where the test projects live).
 *
 * editor.read: the file's bytes for the editor, settled as on Windows (live_files.ts readSettled): with `settleMs`, a stat, a pause, a
 * stat, the read and a stat must agree, else {state: 'moving'}. A file over 5 MB answers only its first 8 KB (`probe`). Pieces of at
 * most 1 MB (`offset`): every answer carries size and mtime, so AIB notices a change between pieces.
 * editor.write: a save, atomic in the distro. Pieces of at most 1 MB fill `.aib-save-<token>.tmp` next to the real target (the same
 * folder, so the same file system); the last one (`done`) flushes it, checks the target's raw bytes still hash to `expect` (null: the
 * file must not exist; 'size:<n>:<mtime>' for a file over 5 MB), gives the temp file the target's mode, owner and group (refused with
 * code 'owner' when the owner or group can't be kept) and renames it over the target. A crash leaves the old file or the new one;
 * a leftover temp file is swept by editor.sweep (older than a minute) when the file opens.
 */
import { createHash } from 'node:crypto';
import * as osp from '../../platform/ospath.ts';
import * as files from '../../worktrees/files.ts';
import { BLOCKED_HOME_DIRS, BLOCKED_HOME_FILES, linuxBlocked } from '../../remote/path_guard.ts';
import { BAD_PARAMS, type Handlers, int, RpcError, str } from './rpc.ts';
import { encodeBase64 } from './methods.ts';
import type { HelperContext } from './methods.ts';

/** The editable size (files/file_text.ts EDIT_LIMIT) and the probe of a bigger file. */
export const EDITOR_LIMIT = 5 * 1024 * 1024;
const PROBE = 8192;
/** The largest piece one call carries either way (a request line is at most 4 MiB, base64 included). */
export const EDITOR_CHUNK = 1024 * 1024;
const TOKEN = /^[0-9a-f]{8}$/;
const SAVE_TEMP = /^\.aib-save-[0-9a-f]{8}\.tmp$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (p: string) => osp.normpath(p).replace(/\\/g, '/');
const inside = (child: string, root: string) => {
  const c = norm(child), r = norm(root).replace(/\/+$/, '');
  return c === r || c.startsWith(r + '/');
};

function err(message: string, code: string, more: Record<string, unknown> = {}): RpcError {
  return new RpcError(message, undefined, { code, ...more });
}

interface Stat {
  size: number;
  mtimeMs: number;
}
function statOf(path: string): (Stat & { info: Deno.FileInfo }) | null {
  try {
    const info = Deno.statSync(path);
    return info.isFile ? { size: info.size, mtimeMs: info.mtime?.getTime() ?? 0, info } : null;
  } catch {
    return null;
  }
}
const same = (a: Stat | null, b: Stat | null) => (!a && !b) || (!!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs);

export interface EditorOptions {
  /** Tests on Windows: skip the owner check (Windows has no uid). Default: on where Deno.uid() answers. */
  owners?: boolean;
}

export function editorMethods(ctx: HelperContext, options: EditorOptions = {}): Handlers {
  const test = ctx.aibStart?.test ?? Deno.env.get('AIB_WSL_TEST') === '1';

  /** The folders nobody edits here, by code. */
  async function guardDirs(extra: unknown): Promise<{ blocked: string[]; blockedFiles: string[]; data: string[]; worktrees: string[] }> {
    const login = await ctx.env();
    const home = login.home || login.env.HOME || '';
    const blocked: string[] = [], blockedFiles: string[] = [];
    if (home && osp.isabs(home)) {
      for (const d of BLOCKED_HOME_DIRS) blocked.push(osp.join(home, d));
      for (const f of BLOCKED_HOME_FILES) blockedFiles.push(osp.join(home, f));
    }
    for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
      const v = (login.env[name] ?? '').trim();
      if (v && osp.isabs(v)) blocked.push(v);
    }
    if (Array.isArray(extra)) {
      for (const d of extra.slice(0, 64)) if (typeof d === 'string' && osp.isabs(d) && !d.includes('\0')) blocked.push(d);
    }
    const own = ctx.own?.length ? [...ctx.own] : [];
    const root = ctx.root ?? '';
    const data = own.filter((d) => d && !(test && root && norm(d) === norm(root)));
    const worktrees = ctx.data ? [osp.join(ctx.data, 'worktrees')] : [];
    return { blocked, blockedFiles, data, worktrees };
  }

  /** The real path of `rel` in `root` and whether it is there; refused by code as the header says. */
  async function place(p: Record<string, unknown>, mayBeGone: boolean): Promise<{ real: string; rel: string; root: string }> {
    const rootPath = str(p, 'root');
    if (!rootPath || rootPath.length > 4096 || !osp.isabs(rootPath)) throw new RpcError('root must be an absolute path', BAD_PARAMS);
    const relText = str(p, 'rel');
    const base = files.realRoot(rootPath);
    let real: string, rel: string;
    try {
      [real, rel] = files.resolveInside(base, relText);
    } catch (error) {
      if (!mayBeGone || !(error instanceof files.FilesError) || error.code !== 'not_found') throw error;
      // a deleted file (a save writes it back): its folder must still be there, inside the project
      const parts = files.safeParts(relText);
      const name = parts.pop() ?? '';
      if (!name || name === '.git') throw error;
      let dir: string;
      try {
        [dir] = files.resolveInside(base, parts.join('/'));
      } catch {
        throw err('Folder gone', 'folder_gone');
      }
      real = osp.join(dir, name);
      rel = [...parts, name].join('/');
    }
    if (!rel) throw new files.FilesError('Choose a file', 'not_file');
    const g = await guardDirs(p.blocked);
    const n = norm(real);
    if (linuxBlocked(n) || g.blocked.some((d) => inside(n, d)) || g.blockedFiles.some((f) => norm(f) === n)) {
      throw err('This folder holds sign-ins. Edit it outside AIB.', 'blocked');
    }
    if (g.worktrees.some((d) => inside(n, d))) throw err("A helper's or subagent's copy", 'worktree');
    if (g.data.some((d) => inside(n, d))) throw err("AIB's own data", 'data');
    if (SAVE_TEMP.test(osp.basename(n))) throw err("AIB's own data", 'data');
    return { real, rel, root: base };
  }

  return {
    'editor.read': async (p) => {
      const at = await place(p, true);
      const settle = Math.min(int(p, 'settleMs', 0), 5000);
      const offset = int(p, 'offset', 0);
      const a = statOf(at.real);
      if (settle && offset === 0) {
        await sleep(settle);
        if (!same(a, statOf(at.real))) return { state: 'moving', real: at.real, rel: at.rel };
      }
      if (!a) {
        let folder = false;
        try {
          folder = Deno.statSync(at.real).isDirectory;
        } catch { /* gone */ }
        if (folder) throw new files.FilesError('Not a file', 'not_file');
        return { state: 'gone', real: at.real, rel: at.rel };
      }
      const tooBig = a.size > EDITOR_LIMIT;
      const want = tooBig ? Math.min(PROBE, a.size) : Math.max(0, Math.min(EDITOR_CHUNK, a.size - offset));
      const buf = new Uint8Array(want);
      let got = 0;
      try {
        const f = Deno.openSync(at.real, { read: true });
        try {
          if (offset && !tooBig) f.seekSync(offset, Deno.SeekMode.Start);
          while (got < buf.length) {
            const n = f.readSync(buf.subarray(got));
            if (n === null) break;
            got += n;
          }
        } finally {
          f.close();
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return { state: 'moving', real: at.real, rel: at.rel };
        throw err(
          error instanceof Deno.errors.PermissionDenied ? 'Permission denied' : String((error as Error)?.message ?? error),
          'unreadable',
        );
      }
      const c = statOf(at.real);
      if (!same(a, c)) return { state: 'moving', real: at.real, rel: at.rel };
      return {
        state: 'ok',
        real: at.real,
        rel: at.rel,
        size: a.size,
        mtimeMs: a.mtimeMs,
        mode: (a.info.mode ?? 0) & 0o7777,
        offset: tooBig ? 0 : offset,
        tooBig,
        bytesB64: encodeBase64(buf.subarray(0, got)),
      };
    },

    'editor.write': async (p) => {
      const at = await place(p, true);
      const token = str(p, 'token');
      if (!TOKEN.test(token)) throw new RpcError('token must be 8 hex digits', BAD_PARAMS);
      const offset = int(p, 'offset', 0);
      const text = str(p, 'bytesB64', true);
      if (text.length > Math.ceil(EDITOR_CHUNK / 3) * 4 + 4) throw new RpcError('piece too big', BAD_PARAMS);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
      } catch {
        throw new RpcError('bytesB64 must be base64', BAD_PARAMS);
      }
      const dir = osp.dirname(at.real);
      const temp = osp.join(dir, `.aib-save-${token}.tmp`);
      const drop = () => {
        try {
          Deno.removeSync(temp);
        } catch { /* gone */ }
      };
      try {
        if (offset + bytes.length > EDITOR_LIMIT) throw err('Over 5 MB', 'too_big');
        const f = offset === 0
          ? Deno.openSync(temp, { write: true, createNew: true, mode: 0o600 })
          : Deno.openSync(temp, { write: true, append: true });
        try {
          if (offset !== 0 && f.statSync().size !== offset) throw err('A piece of the save went missing', 'write_failed');
          let w = 0;
          while (w < bytes.length) w += f.writeSync(bytes.subarray(w));
          if (p.done === true) f.syncSync();
        } finally {
          f.close();
        }
        if (p.done !== true) return { ok: true, offset: offset + bytes.length };
        // the raw-byte check, right before the rename
        const expect = p.expect === null || p.expect === undefined ? null : str(p, 'expect');
        const now = statOf(at.real);
        if (expect === null) {
          if (now) throw err('The file changed on disk', 'changed');
        } else if (!now) {
          throw err('The file changed on disk', 'changed');
        } else if (expect.startsWith('size:')) {
          if (expect !== `size:${now.size}:${now.mtimeMs}`) throw err('The file changed on disk', 'changed');
        } else if (createHash('sha256').update(Deno.readFileSync(at.real)).digest('hex') !== expect) {
          throw err('The file changed on disk', 'changed');
        }
        // the target's mode, owner and group
        if (now) {
          Deno.chmodSync(temp, (now.info.mode ?? 0o644) & 0o7777);
          const owners = options.owners ?? Deno.build.os !== 'windows';
          const uid = now.info.uid, gid = now.info.gid;
          if (owners && uid !== null && gid !== null) {
            const mine = Deno.statSync(temp);
            if (mine.uid !== uid || mine.gid !== gid) {
              try {
                Deno.chownSync(temp, uid, gid);
              } catch {
                throw err("AIB can't keep this file's owner or group: it belongs to another Linux user", 'owner');
              }
            }
          }
        } else {
          Deno.chmodSync(temp, 0o644);
        }
        Deno.renameSync(temp, at.real);
        const after = statOf(at.real);
        return { ok: true, real: at.real, size: after?.size ?? bytes.length, mtimeMs: after?.mtimeMs ?? Date.now() };
      } catch (error) {
        drop();
        if (error instanceof RpcError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        if (error instanceof Deno.errors.NotFound) throw err('Folder gone', 'folder_gone');
        if (/ENOSPC|No space left|os error 28/i.test(msg)) throw err('Disk full', 'disk_full');
        if (/EROFS|Read-only file system|os error 30/i.test(msg)) throw err('Read-only file system', 'read_only');
        if (error instanceof Deno.errors.PermissionDenied || /os error 1\b|os error 13\b/.test(msg)) {
          const st = statOf(at.real);
          if (st && ((st.info.mode ?? 0o644) & 0o222) === 0) throw err('Read-only file', 'read_only');
          throw err('Access denied', 'access_denied');
        }
        throw err('Could not save: ' + msg.slice(0, 160), 'write_failed');
      }
    },

    /** Leftover save temp files next to the file, older than a minute (a crash between write and rename). */
    'editor.sweep': async (p) => {
      const at = await place(p, true);
      const dir = osp.dirname(at.real);
      let swept = 0;
      try {
        for (const e of Deno.readDirSync(dir)) {
          if (!e.isFile || !SAVE_TEMP.test(e.name)) continue;
          const path = osp.join(dir, e.name);
          const st = Deno.statSync(path);
          if (st.mtime && Date.now() - st.mtime.getTime() > 60_000) {
            Deno.removeSync(path);
            swept++;
          }
        }
      } catch { /* nothing to sweep */ }
      return { swept };
    },
  };
}
