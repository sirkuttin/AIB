/**
 * The WSL helper's phase 1 methods (wsl/contract.ts HelperMethods). Each one is the module AIB already runs for a Windows project,
 * here running natively in the distro: the Files view (worktrees/files.ts), Changes (worktrees/changes.ts), the folder checks
 * (desktop/folders.ts), agent detection (agents/adapters.ts) and the branch lookup (worktrees/chat_folders.ts). Results are what
 * those modules return, except files.read (raw bytes, base64) and the small fs.* answers for the folder browser.
 *
 * Paths are absolute Linux paths chosen by AIB from the project's ref; files.* and changes.* paths below a root are checked by the
 * modules themselves (resolveInside, safeRelpath).
 */
import * as osp from '../../platform/ospath.ts';
import { which } from '../../platform/pypath.ts';
import { branchEntries, commitExists, getChanges, getFileDiff, locate } from '../../worktrees/changes.ts';
import * as files from '../../worktrees/files.ts';
import { checkPath, createFolder, GIT_TIMEOUT, gitPath, runCommand } from '../../desktop/folders.ts';
import { repoBranch } from '../../worktrees/chat_folders.ts';
import { defaultOmpCommand, type LaunchRow, resolveClaude, resolveCodex, resolveOmp } from '../../agents/adapters.ts';
import { BAD_PARAMS, type Handlers, int, RpcError, str } from './rpc.ts';

export const LIST_DIRS_DEFAULT = 500, LIST_DIRS_MAX = 2000;
export const DEFAULT_AGENTS = ['claude', 'codex', 'omp'];

export interface HelperContext {
  /** The login environment (env.get), once captured. */
  env(): Promise<{ env: Record<string, string>; shell: string; home: string; arch: string }>;
}

/** An absolute path param, normalised; relative, NUL and over-long paths are refused. */
function absPath(params: Record<string, unknown>, key: string): string {
  const path = str(params, key);
  if (!path || path.length > 4096 || !osp.isabs(path)) throw new RpcError(`${key} must be an absolute path`, BAD_PARAMS);
  return osp.normpath(path);
}

export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function stat(path: string): Deno.FileInfo | null {
  try {
    return Deno.statSync(path);
  } catch {
    return null;
  }
}

/** Version of the npm package that holds `entry` (the nearest package.json above it), or undefined. */
function packageVersion(entry: string): string | undefined {
  let dir = osp.dirname(entry);
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(Deno.readTextFileSync(osp.join(dir, 'package.json')));
      if (typeof pkg?.version === 'string') return pkg.version;
    } catch { /* not here */ }
    const parent = osp.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function agentRow(id: string, row: LaunchRow): { id: string; found: boolean; command?: string[]; version?: string; note?: string } {
  const out: { id: string; found: boolean; command?: string[]; version?: string; note?: string } = { id, found: row.found };
  if (row.argv.length) out.command = row.argv;
  const version = row.found && row.path && row.source !== 'path' ? packageVersion(row.path) : undefined;
  if (version) out.version = version;
  const note = row.problem || row.text;
  if (note) out.note = note;
  return out;
}

/** Every method waits for the login environment first: until then PATH is wsl.exe's, with Windows' folders in it. */
export function makeMethods(ctx: HelperContext): Handlers {
  const methods = phaseOne(ctx);
  return Object.fromEntries(
    Object.entries(methods).map(([name, handler]) => [name, async (p: Record<string, unknown>) => {
      await ctx.env();
      return await handler(p);
    }]),
  );
}

function phaseOne(ctx: HelperContext): Handlers {
  return {
    'env.get': () => ctx.env(),

    'which': (p) => {
      const name = str(p, 'name');
      if (!name) throw new RpcError('name must not be empty', BAD_PARAMS);
      return { path: which(name) };
    },

    'agents.detect': async (p) => {
      const ids = p.ids === undefined ? DEFAULT_AGENTS : p.ids;
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new RpcError('ids must be a list of strings', BAD_PARAMS);
      const agents = [];
      for (const id of ids as string[]) {
        if (id === 'claude') agents.push(agentRow(id, await resolveClaude({})));
        else if (id === 'codex') agents.push(agentRow(id, await resolveCodex({})));
        else if (id === 'omp') agents.push(agentRow(id, resolveOmp(defaultOmpCommand())));
        else agents.push({ id, found: false, note: 'AIB does not look for this agent in WSL yet' });
      }
      return { agents };
    },

    'fs.stat': (p) => {
      const st = stat(absPath(p, 'path'));
      return {
        exists: st !== null,
        isDir: st?.isDirectory ?? false,
        isFile: st?.isFile ?? false,
        size: st?.size ?? 0,
        mtimeMs: st?.mtime?.getTime() ?? 0,
      };
    },

    'fs.listDirs': (p) => {
      const path = absPath(p, 'path');
      const limit = Math.min(Math.max(1, int(p, 'limit', LIST_DIRS_DEFAULT)), LIST_DIRS_MAX);
      let entries: Deno.DirEntry[];
      try {
        entries = [...Deno.readDirSync(path)];
      } catch (error) {
        throw new RpcError(error instanceof Deno.errors.NotFound ? 'That folder does not exist' : 'That folder cannot be read', undefined, {
          code: error instanceof Deno.errors.NotFound ? 'not_found' : 'unreadable',
        });
      }
      const names = entries.filter((e) => e.isDirectory || (e.isSymlink && stat(osp.join(path, e.name))?.isDirectory))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
      const dirs = names.slice(0, limit).map((name) => ({ name, isGit: stat(osp.join(path, name, '.git')) !== null }));
      const parent = osp.dirname(path);
      return { path, parent: parent === path ? null : parent, dirs, truncated: names.length > limit };
    },

    'folder.check': async (p) => {
      const path = str(p, 'path');
      const c = checkPath(path);
      const ok = c.valid;
      const isGit = ok && c.isDir ? (await locate(c.path)) !== null : false;
      return {
        ok,
        reason: c.reason,
        message: c.message,
        exists: c.exists,
        isDir: c.isDir,
        isGit,
        realPath: c.path ? osp.realpath(c.path) : '',
      };
    },

    'git.init': async (p) => {
      const path = absPath(p, 'path');
      const st = stat(path);
      if (!st) {
        const made = await createFolder(path, true);
        return made.git ? { ok: true } : { ok: false, message: made.gitError ?? 'git init failed' };
      }
      if (!st.isDirectory) return { ok: false, message: 'That is a file, not a folder' };
      const git = gitPath();
      if (!git) return { ok: false, message: 'git not found' };
      const done = await runCommand([git, 'init'], { cwd: path, timeout: GIT_TIMEOUT });
      return done.code === 0
        ? { ok: true }
        : { ok: false, message: (done.stderr || done.stdout || 'git init failed').trim().slice(0, 300) };
    },

    'files.list': async (p) => {
      const listing = await files.listDir(absPath(p, 'root'), str(p, 'rel', true));
      const offset = int(p, 'offset', 0), limit = int(p, 'limit', listing.entries.length);
      if (offset === 0 && limit >= listing.entries.length) return listing;
      const entries = listing.entries.slice(offset, offset + limit);
      return { ...listing, entries, truncated: listing.truncated || offset + entries.length < listing.entries.length };
    },

    'files.search': async (p) => {
      const found = await files.search(absPath(p, 'root'), str(p, 'query'));
      const limit = int(p, 'limit', found.matches.length);
      if (limit >= found.matches.length) return found;
      return { ...found, matches: found.matches.slice(0, limit), truncated: true };
    },

    'files.read': (p) => {
      const [abs, path] = files.resolveInside(absPath(p, 'root'), str(p, 'rel'));
      if (!path) throw new files.FilesError('Choose a file', 'not_file');
      const st = stat(abs);
      if (!st) throw new files.FilesError('Not found', 'not_found', 404);
      if (!st.isFile) throw new files.FilesError('Not a file', 'not_file');
      const cap = Math.min(int(p, 'maxBytes', files.LIMITS.readBytes), files.LIMITS.readBytes);
      const file = Deno.openSync(abs, { read: true });
      const buf = new Uint8Array(Math.min(cap, st.size));
      let got = 0;
      try {
        while (got < buf.length) {
          const n = file.readSync(buf.subarray(got));
          if (n === null) break;
          got += n;
        }
      } finally {
        file.close();
      }
      return {
        bytesB64: encodeBase64(buf.subarray(0, got)),
        size: st.size,
        truncated: st.size > got,
        mtimeMs: st.mtime?.getTime() ?? 0,
        path,
        abs,
      };
    },

    'files.gitInfo': async (p) => await files.gitInfo(absPath(p, 'root')),

    'changes.get': async (p) => await getChanges(absPath(p, 'folder'), str(p, 'base', true) || null, int(p, 'offset', 0)),

    'changes.diff': async (p) => await getFileDiff(absPath(p, 'folder'), p.path, str(p, 'base', true) || null),

    'changes.branchEntries': async (p) => {
      const found = await locate(absPath(p, 'folder'));
      if (!found) return { git: false };
      const [top, prefix, head] = found;
      const asked = str(p, 'base', true);
      const base = asked && await commitExists(top, asked) ? asked : head;
      const [entries, cut] = await branchEntries(top, prefix, base);
      return { git: true, root: top, prefix, base, entries, cut };
    },

    'chat.repoBranch': async (p) => {
      const folder = absPath(p, 'folder');
      const found = await locate(folder);
      return { repo: found ? found[0] : null, branch: repoBranch(folder) || null };
    },
  };
}
