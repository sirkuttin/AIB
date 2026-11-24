/**
 * Local-only files of WSL projects (wsl/contract.ts `localOnly.*`): the files a project's git never commits that live only in its
 * MAIN folder (AIB's block of `.git/info/exclude`, worktrees/local_only.ts). A chat working in its own copy can't see them there
 * (git does not copy ignored files), so, as for a Windows project, AIB shows them from the main folder in Files and grants the
 * chat's agent the main folder's local-only folders. The same modules run here natively, with Linux paths and Linux git:
 *   localOnly.ensure      local_only.ensureDefault: the default `/aib-shared` line (idempotent; AIB only asks where a Windows project
 *                         would get it, wsl/local_only.ts wslDefaultsAllowed)
 *   localOnly.chat        local_only.chatLocalOnly: what the chat's agent is told and granted (absolute Linux paths of the main folder)
 *   localOnly.list|search|read  the bodies of files_routes.ts' list, search and read (listLocal, excludeHints, localFiles)
 *   localOnly.exclude     POST files/exclude: addEntry (moving a chat copy's file into the main folder first) and undoEntry
 *   localOnly.backup      local_backup.backupProject into `<data>/local-only-backups` (the safety net stays in the distro)
 *
 * `main` is any git folder AIB names (the project); a different `root` (a chat's copy) must be inside this helper's chat copies
 * (`<data>/worktrees`), so nothing from the channel can move files out of, or lay the main folder over, any other folder. Exclude
 * lines are only ever written to the exclude file of `main`'s own repository (git rev-parse in main), for a path inside main.
 */
import * as osp from '../../platform/ospath.ts';
import * as files from '../../worktrees/files.ts';
import * as local from '../../worktrees/local_only.ts';
import { backupProject, type BackupResult } from '../../worktrees/local_backup.ts';
import { Registry } from '../../worktrees/worktrees.ts';
import { ignoredInMain, ignoredTops, overlayIgnored } from '../../worktrees/ignored_overlay.ts';
import { BAD_PARAMS, type Handlers, int, RpcError, str } from './rpc.ts';

/** AIB's own folders in the distro (never granted to an agent): the folder above this AIB's data folder, and AIB_WSL_ROOT. */
function ownFolders(data: string | undefined): string[] {
  const out = data ? [osp.dirname(data)] : [];
  const root = Deno.env.get('AIB_WSL_ROOT');
  if (root && osp.isabs(root)) out.push(root);
  return out;
}
import { encodeBase64 } from './methods.ts';

function absPath(params: Record<string, unknown>, key: string): string {
  const path = str(params, key);
  if (!path || path.length > 4096 || path.includes('\0') || !osp.isabs(path)) throw new RpcError(`${key} must be an absolute path`, BAD_PARAMS);
  return osp.normpath(path);
}

const real = (p: string) => {
  try {
    return osp.realpath(p);
  } catch {
    return osp.normpath(p);
  }
};
const samePath = (a: string, b: string) => real(a) === real(b);

/** The Files scope {root, main}: root is main, or a chat copy inside `<data>/worktrees` (refused otherwise). */
function scopeOf(params: Record<string, unknown>, data: string | undefined): { root: string; main: string; same: boolean } {
  const root = absPath(params, 'root'), main = absPath(params, 'main');
  const same = samePath(root, main);
  if (!same) {
    const copies = data ? real(osp.join(data, 'worktrees')) : '';
    if (!copies || !files.within(real(root), copies) || real(root) === copies) {
      throw new RpcError("root must be the main folder or one of AIB's chat copies", BAD_PARAMS, { code: 'bad_root' });
    }
  }
  return { root, main, same };
}

const localPart = (main: string, lo: local.LocalOnly | null, sig = '') => ({
  main,
  entries: lo ? lo.entries : [],
  defaultState: lo ? lo.defaultState : 'no-git',
  sig,
});

/** files.read's raw answer: up to `cap` bytes of a file inside `root` (links resolved and checked by resolveInside). */
export function rawRead(root: string, rel: unknown, cap: number) {
  const [abs, path] = files.resolveInside(root, rel);
  if (!path) throw new files.FilesError('Choose a file', 'not_file');
  let st: Deno.FileInfo;
  try {
    st = Deno.statSync(abs);
  } catch {
    throw new files.FilesError('Not found', 'not_found', 404);
  }
  if (!st.isFile) throw new files.FilesError('Not a file', 'not_file');
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
  return { bytesB64: encodeBase64(buf.subarray(0, got)), size: st.size, truncated: st.size > got, mtimeMs: st.mtime?.getTime() ?? 0, path, abs };
}

export function localOnlyMethods(data?: string): Handlers {
  return {
    'localOnly.ensure': async (p) => {
      const lo = await local.ensureDefault(absPath(p, 'project'));
      return { state: lo ? lo.defaultState : 'no-git' };
    },

    'localOnly.chat': async (p) => {
      const project = absPath(p, 'project');
      const lo = await local.localOnlyOf(project);
      const told = lo ? local.chatLocalOnly(lo, p.worktree === true) : null;
      if (p.ignored !== true) return { localOnly: told };
      // a chat in its own copy: every other top-level folder and file git ignores in the main folder too (owner), never .git,
      // another worktree of the repo, or AIB's own folders in the distro
      // (a root that holds the project itself, as a test's /tmp/aib-wsl-test-* does, only keeps its data folder out)
      const own = [...(data ? [data] : []), ...ownFolders(data)].filter((r) => !files.within(real(project), real(r)));
      const tops = await ignoredTops(project, own);
      const given = new Set(told?.dirs ?? []);
      const ignored = { dirs: tops.dirs.filter((d) => !given.has(d)), files: tops.files };
      if (!told && !ignored.dirs.length && !ignored.files.length) return { localOnly: null };
      return { localOnly: { ...(told ?? { entries: [], dirs: [], shared: '' }), ignored } };
    },

    'localOnly.list': async (p) => {
      const { root, main, same } = scopeOf(p, data);
      const base = files.realRoot(root);
      const lo = await local.localOnlyOf(main);
      const dir = files.safeParts(str(p, 'dir', true)).join('/');
      let listing: (files.Listing & { sig: string }) | null = null;
      try {
        listing = await files.listLocal(base, main, lo, dir);
      } catch (error) {
        // a folder the copy lacks: overlayIgnored lists it from main when main ignores it
        if (same || !(error instanceof files.FilesError) || error.code !== 'not_found') throw error;
      }
      const sig = listing?.sig ?? '';
      const { sig: _sig, ...shown } = listing ?? { sig };
      // every ignored or excluded entry of main stays visible from a chat copy (from: 'main'); excluded ones in normal colour
      const out = await overlayIgnored(listing ? shown as files.Listing : null, base, main, dir, same);
      await files.excludeHints(main, lo, out, same);
      return { root: base, ...out, localOnly: localPart(main, lo, sig) };
    },

    'localOnly.search': async (p) => {
      const { root, main } = scopeOf(p, data);
      const base = files.realRoot(root);
      const lo = await local.localOnlyOf(main);
      const found = await files.search(base, str(p, 'query', true), '', files.localFiles(main, lo));
      return { root: base, ...found, localOnly: localPart(main, lo) };
    },

    'localOnly.read': async (p) => {
      const { root, main, same } = scopeOf(p, data);
      const rel = str(p, 'rel');
      const cap = Math.min(int(p, 'maxBytes', files.LIMITS.readBytes), files.LIMITS.readBytes);
      const lo = await local.localOnlyOf(main);
      const isLocal = !!lo && local.isLocalPath(lo, rel);
      if (isLocal && !same) {
        // a local-only file is the main folder's own (a copy's stray shows only while main has none)
        try {
          return { ...rawRead(main, rel, cap), readRoot: files.realRoot(main), local: true, from: 'main' };
        } catch (error) {
          if (!(error instanceof files.FilesError) || error.status !== 404) throw error;
        }
      }
      try {
        return { ...rawRead(root, rel, cap), readRoot: files.realRoot(root), ...(isLocal ? { local: true } : {}) };
      } catch (error) {
        // a file git ignores in the main folder (its copy never has it): read there
        if (same || !(error instanceof files.FilesError) || error.status !== 404 || !(await ignoredInMain(main, rel))) throw error;
        return { ...rawRead(main, rel, cap), readRoot: files.realRoot(main), from: 'main' };
      }
    },

    'localOnly.exclude': async (p) => {
      const { root, main, same } = scopeOf(p, data);
      const action = p.action === 'undo' ? 'undo' : p.action === 'add' ? 'add' : '';
      if (!action) return { status: 400, body: { error: 'Unknown action', code: 'bad_action' } };
      if (action === 'undo') {
        const done = await local.undoEntry(main, str(p, 'undo', true));
        return { status: 200, body: { ok: done, localOnly: localPart(main, await local.localOnlyOf(main)) } };
      }
      const path = local.cleanRel(p.path);
      if (path === null) return { status: 400, body: { error: 'Invalid path', code: 'bad_path' } };
      if (path) files.safeParts(path); // the same path rules as every Files request
      const result = await local.addEntry(main, path, same ? undefined : root);
      const localOnly = localPart(main, await local.localOnlyOf(main));
      return result.ok ? { status: 200, body: { ...result, path, localOnly } } : { status: 409, body: { ...result, localOnly } };
    },


    'localOnly.backup': async (p) => {
      if (!data) throw new RpcError('this helper has no data folder', undefined, { code: 'no_data' });
      const asked = Array.isArray(p.projects) ? p.projects.filter((x): x is string => typeof x === 'string' && osp.isabs(x)).slice(0, 500) : [];
      // the projects AIB names and the ones this helper keeps chat copies of (as main.ts does on Windows)
      const fromCopies = Object.values(new Registry(data).all()).map((r) => String(r.project ?? '')).filter((x) => osp.isabs(x));
      const results: Record<string, { status: string; files?: number }> = {};
      for (const project of new Set([...asked, ...fromCopies].map((x) => osp.normpath(x)))) {
        let done: BackupResult;
        try {
          done = await backupProject(data, project);
        } catch {
          done = { status: 'failed' };
        }
        results[project] = { status: done.status, ...(done.files !== undefined ? { files: done.files } : {}) };
      }
      return { results };
    },
  };
}
