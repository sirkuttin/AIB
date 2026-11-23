/**
 * The WSL helper's phase 1 methods (wsl/contract.ts HelperMethods). Each one is the module AIB already runs for a Windows project,
 * here running natively in the distro: the Files view (worktrees/files.ts), Changes (worktrees/changes.ts), the folder checks
 * (desktop/folders.ts), agent detection (agents/adapters.ts), the branch lookup (worktrees/chat_folders.ts) and the saved sessions
 * (transcripts/store.ts, transcripts/monitor.ts handleGet). Results are what those modules return, except files.read (raw bytes,
 * base64) and the small fs.* answers for the folder browser.
 *
 * Paths are absolute Linux paths chosen by AIB from the project's ref; files.* and changes.* paths below a root are checked by the
 * modules themselves (resolveInside, safeRelpath).
 */
import * as osp from '../../platform/ospath.ts';
import { isFile, which } from '../../platform/pypath.ts';
import { resolveBeta } from '../../agents/beta_agents.ts';
import { betaAgent } from '../../agents/beta_catalog.ts';
import { branchEntries, type ChangesResult, commitExists, getChanges, getCounts, getFileDiff, locate } from '../../worktrees/changes.ts';
import * as files from '../../worktrees/files.ts';
import * as outside from '../../worktrees/outside_files.ts';
import { checkPath, checkProject, createFolder, createProject, GIT_TIMEOUT, gitPath, runCommand } from '../../desktop/folders.ts';
import { repoBranch } from '../../worktrees/chat_folders.ts';
import { readRepoIdentity } from '../../pcsync/repo_id.ts';
import { type LaunchRow, resolveClaude, resolveCodex } from '../../agents/adapters.ts';
import { latestRolloutLimits } from '../../agents/codex_limits.ts';
import { findSessionFile, Store } from '../../transcripts/store.ts';
import { handleGet } from '../../transcripts/monitor.ts';
import { distroTrash, inspectInDistro, trashInDistro } from './trash.ts';
import { Refused } from '../../desktop/project_delete.ts';
import { BAD_PARAMS, type Handlers, int, RpcError, str } from './rpc.ts';
import { worktreeMethods } from './worktrees.ts';
import { mergeMethods } from './merge.ts';
import { HelperSync, syncMethods } from './sync.ts';
import { ProjectResolver } from '../../worktrees/worktrees.ts';
import { bundledClaudeCli, bundledCodexCli, findCodexCli } from '../../agents/signin.ts';
import { installMethods } from './agent_install.ts';
import { docsMethods } from './docs.ts';
import { docRows } from '../../docs/rows.ts';
import { bgtaskMethods } from './bgtasks.ts';
import { type EnvMode, envPrereqs, type PrereqDeps } from './prereqs.ts';
import { signinStatus } from './signin_status.ts';
import { aibMethods, type RemoveDeps } from './aib_remove.ts';
import { localOnlyMethods, rawRead } from './local_only.ts';
import { allowFactsMethods } from './allow_facts.ts';
import { editorMethods } from './editor.ts';

export const LIST_DIRS_DEFAULT = 500, LIST_DIRS_MAX = 2000;
export const SESSIONS_DEFAULT = 500, SESSIONS_MAX = 5000;
/** The /api/transcript arguments transcripts.read passes on (the page's paging; nothing else reaches handleGet). */
const TRANSCRIPT_ARGS = ['limit', 'after', 'before', 'thinking', 'q', 'kind'];
export const DEFAULT_AGENTS = ['claude', 'codex'];
/** files.readBytes: the largest piece per call (base64 keeps each answer line near 1.4 MB) and the default whole-file cap. */
export const READ_BYTES_CHUNK = 1024 * 1024;
export const READ_BYTES_MAX = 25 * 1024 * 1024;

export interface HelperContext {
  /** The login environment (env.get), once captured. */
  env(): Promise<{ env: Record<string, string>; shell: string; home: string; arch: string }>;
  /** AIB's own folders in the distro (its root, its data folder, the helper's folder): never shown or deleted. Default: ~/.aib-server. */
  own?: readonly string[];
  /**
   * The Linux keeper's data folder of this Windows AIB (`--data`): the worktree registry and root live there (helper/worktrees.ts).
   * Without it the helper offers no worktree.* method, and AIB keeps WSL chats in the project folder.
   */
  data?: string;
  /** Live sync of the WSL chats' worktrees over `data` (helper/sync.ts); made here when not given. Only with `data`. */
  sync?: HelperSync;
  /**
   * AIB's folder in the distro (~/.aib-server, or AIB_WSL_ROOT): agents.detect looks for AIB's own installs in <root>/agents first, and
   * the agents.install* methods (helper/agent_install.ts) are offered. Without it, only agents the user installed are found.
   */
  root?: string;
  /** Sends a notification line to AIB (agents.installProgress). */
  notify?(method: string, params: Record<string, unknown>): void;
  /** Reads the login shell's PATH again (a Node.js installed since the helper started). */
  refreshPath?(): Promise<void>;
  /** How the login environment was captured (env.prereqs envMode); 'plain' when not said. */
  envMode?(): EnvMode;
  /** Tests: env.prereqs' program runner and file checks (helper/prereqs.ts PrereqDeps). */
  prereqDeps?: Partial<PrereqDeps>;
  /** Tests: aib.usage / aib.remove's file system, process list and checks (helper/aib_remove.ts RemoveDeps). */
  aibDeps?: Partial<RemoveDeps>;
  /** The helper's start environment for aib.* (this AIB's <ver>, the test guard): read before the login environment replaces it. */
  aibStart?: { version?: string; test?: boolean };
}

/** AIB's own folders in the distro for the Files-outside and project-delete refusals. */
async function ownFolders(ctx: HelperContext): Promise<string[]> {
  if (ctx.own?.length) return [...ctx.own];
  const login = await ctx.env();
  const own = Deno.env.get('AIB_WSL_ROOT');
  return [own && own.startsWith('/') ? own : osp.join(login.home || login.env.HOME || '/', '.aib-server')];
}

/** One transcripts Store per folder, kept for the helper's life (its summary and transcript caches). */
const stores = new Map<string, Store>();

/**
 * The Claude Code projects folder of the distro user: `claudeDir` when AIB names it (tests: inside AIB_WSL_ROOT, never the user's
 * own), else CLAUDE_CONFIG_DIR of the login environment, else ~/.claude; then `/projects`. Codex keeps no saved-session list AIB
 * reads (as on Windows), so it has none.
 */
async function sessionStore(ctx: HelperContext, p: Record<string, unknown>): Promise<Store | null> {
  const provider = str(p, 'provider');
  if (provider !== 'claude' && provider !== 'codex') throw new RpcError('provider must be claude or codex', BAD_PARAMS);
  if (provider === 'codex') return null;
  const asked = str(p, 'claudeDir', true);
  if (asked && (!osp.isabs(asked) || asked.length > 4096)) throw new RpcError('claudeDir must be an absolute path', BAD_PARAMS);
  const login = await ctx.env();
  const dir = asked || login.env.CLAUDE_CONFIG_DIR || osp.join(login.home || login.env.HOME || '/', '.claude');
  const root = osp.join(osp.normpath(dir), 'projects');
  let store = stores.get(root);
  if (!store) {
    stores.set(root, store = await Store.open(root));
    // a chat that ran in its own worktree is filed under its project (projectRoot, worktree), as the Windows store does
    if (ctx.data) {
      const resolver = new ProjectResolver(ctx.data);
      store.projectResolver = (cwd: string) => resolver.resolve(cwd);
    }
  }
  return store;
}

/** The guard and the trash for a project delete: this user's home, AIB's folder in the distro, and the other projects' Linux paths. */
async function trashSetup(ctx: HelperContext, p: Record<string, unknown>) {
  const login = await ctx.env();
  const home = login.home || login.env.HOME || '/';
  const projects = Array.isArray(p.projects) ? p.projects.filter((x): x is string => typeof x === 'string' && osp.isabs(x)).slice(0, 500) : [];
  const dataHome = str(p, 'dataHome', true);
  if (dataHome && !osp.isabs(dataHome)) throw new RpcError('dataHome must be an absolute path', BAD_PARAMS);
  return {
    guard: { home, own: await ownFolders(ctx), projects },
    layer: distroTrash({ home, dataHome: dataHome || login.env.XDG_DATA_HOME || undefined, gio: p.viaGio === false ? null : undefined }),
  };
}

/** A doc's files show as one row "2 pages changed", as chat_folders.ts does for a Windows project (docs/rows.ts). */
function withDocs(result: ChangesResult): ChangesResult {
  if (result.git && Array.isArray(result.files)) {
    const docs = docRows(String(result.root), result.files.map((f) => f.path));
    if (docs.length) (result as unknown as Record<string, unknown>).docs = docs;
  }
  return result;
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

type AgentRow = {
  id: string;
  found: boolean;
  command?: string[];
  version?: string;
  note?: string;
  source?: string;
  signin?: string[];
  bundledCli?: boolean;
};

/**
 * Antigravity CLI in the distro (the one Beta agent AIB looks for in WSL so far): AIB's own install under <root>/agents first, then `agy`
 * on the login shell's PATH, then ~/.local/bin/agy (where Google's install.sh puts it, which a non-login PATH may lack).
 */
export async function resolveAntigravity(
  stateDir: string | null,
  login: { env: Record<string, string>; home: string },
): Promise<LaunchRow> {
  const row = await resolveBeta('antigravity', { stateDir, env: login.env, windows: false });
  if (row.found || !login.home) return row;
  const local = osp.join(login.home, '.local', 'bin', 'agy');
  if (!isFile(local)) return row;
  const args = betaAgent('antigravity')!.args;
  return { argv: [local, ...args], source: 'path', path: local, found: true, problem: '', text: local };
}

async function agentRow(id: string, row: LaunchRow): Promise<AgentRow> {
  const out: AgentRow = { id, found: row.found, source: row.source };
  if (row.argv.length) out.command = row.argv;
  // Codex signs in with its own CLI: the @openai/codex next to the adapter (AIB's install has it), else `codex` on PATH
  if (id === 'codex' && row.found) {
    const cli = await findCodexCli(row.argv);
    if (cli) out.signin = cli;
  }
  // the vendor's own program the adapter ships was found (the page then says the standalone command is not needed)
  if (id === 'codex') out.bundledCli = row.found && bundledCodexCli(row.argv) !== null;
  if (id === 'claude') out.bundledCli = row.found && bundledClaudeCli(row.argv) !== null;
  const version = row.found && row.path && row.source !== 'path' ? packageVersion(row.path) : undefined;
  if (version) out.version = version;
  const note = row.problem || row.text;
  if (note) out.note = note;
  return out;
}

/** Every method waits for the login environment first: until then PATH is wsl.exe's, with Windows' folders in it. */
export function makeMethods(ctx: HelperContext): Handlers {
  const data = ctx.data;
  const methods = {
    ...phaseOne(ctx),
    ...docsMethods(ctx), // the docs' file work in the project's aib-docs/ (helper/docs.ts)
    ...editorMethods(ctx), // the file editor's reads and atomic saves of a WSL project's files (helper/editor.ts)
    // background tasks, the ownership check and the agents' process trees (helper/bgtasks.ts)
    ...bgtaskMethods({ env: ctx.env, store: (p) => sessionStore(ctx, p) }),
    ...linkingMethods(ctx), // Linking (WSL) phase 2: env.prereqs, agents.signinStatus (agents.uninstall is in installMethods)
    // allow rules of WSL chats: what the matcher needs to know of the distro (helper/allow_facts.ts, read only)
    ...allowFactsMethods({ env: ctx.env, own: async () => [...await ownFolders(ctx), ...(data ? [data] : [])] }),
    ...localOnlyMethods(data), // local-only files from the main folder (helper/local_only.ts); chat copies only under <data>/worktrees
    ...(data ? { ...worktreeMethods(data), ...mergeMethods(data), ...syncMethods(ctx.sync ?? new HelperSync(data)) } : {}),
    ...(ctx.root ? installMethods({ root: ctx.root, notify: ctx.notify ?? (() => {}), refreshPath: ctx.refreshPath }) : {}),
    // Linking (WSL) phase 3: disk use and Remove AIB from this distro (helper/aib_remove.ts), only with both folders known
    ...(ctx.root && data
      ? aibMethods({ root: ctx.root, data, env: ctx.env, ...(ctx.aibStart ? { start: ctx.aibStart } : {}), ...(ctx.aibDeps ? { deps: ctx.aibDeps } : {}) })
      : {}),
  };
  return Object.fromEntries(
    Object.entries(methods).map(([name, handler]) => [name, async (p: Record<string, unknown>) => {
      await ctx.env();
      return await handler(p);
    }]),
  );
}

/** env.prereqs (helper/prereqs.ts) and agents.signinStatus (helper/signin_status.ts): read-only looks at the distro. */
function linkingMethods(ctx: HelperContext): Handlers {
  return {
    'env.prereqs': async (p) => {
      if (p.force === true && ctx.refreshPath) await ctx.refreshPath().catch(() => {});
      const login = await ctx.env();
      return {
        ...await envPrereqs({
          env: login.env,
          home: login.home || login.env.HOME || '',
          arch: login.arch,
          loginShell: login.shell,
          envMode: ctx.envMode?.() ?? 'plain',
          ...(ctx.root ? { root: ctx.root } : {}),
          ...ctx.prereqDeps,
        }),
      };
    },

    'agents.signinStatus': async (p) => {
      const ids = p.ids === undefined ? DEFAULT_AGENTS : p.ids;
      if (!Array.isArray(ids) || ids.length > 50 || ids.some((x) => typeof x !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(x))) {
        throw new RpcError('ids must be a list of agent ids', BAD_PARAMS);
      }
      const login = await ctx.env();
      return { agents: signinStatus(ids as string[], login.env, login.home || login.env.HOME || '') };
    },
  };
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
        // AIB's own install (<root>/agents/<id>/<version>, newest complete one) first, then one the user installed
        const stateDir = ctx.root ?? null;
        if (id === 'claude') agents.push(await agentRow(id, await resolveClaude({ stateDir })));
        else if (id === 'codex') agents.push(await agentRow(id, await resolveCodex({ stateDir })));
        else if (id === 'antigravity') agents.push(await agentRow(id, await resolveAntigravity(stateDir, await ctx.env())));
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

    // The New project dialog's check and create, run by the same functions a Windows project uses, here with Linux rules.
    'folder.project': (p) => ({ ...checkProject(str(p, 'path'), str(p, 'name', true), false) }),

    'folder.createProject': async (p) => {
      const path = str(p, 'path'), name = str(p, 'name', true), gitInit = p.gitInit === true;
      return { ...(name ? await createProject(path, name, gitInit) : await createFolder(path, gitInit)) };
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

    'files.read': (p) => rawRead(absPath(p, 'root'), str(p, 'rel'), Math.min(int(p, 'maxBytes', files.LIMITS.readBytes), files.LIMITS.readBytes)),

    // A whole file's bytes for an artifact published by path (wsl/artifact_read.ts), in pieces of at most READ_BYTES_CHUNK: the
    // same realpath check as files.read (no link or .. out of root), then size, mtime and the piece at `offset`. A file over
    // `maxBytes` is refused before anything is read.
    'files.readBytes': (p) => {
      const rel = str(p, 'rel');
      const [abs, path] = files.resolveInside(absPath(p, 'root'), rel);
      if (!path) throw new files.FilesError('Choose a file', 'not_file');
      const st = stat(abs);
      if (!st) throw new files.FilesError('Not found', 'not_found', 404);
      if (!st.isFile) throw new files.FilesError('Not a file', 'not_file');
      const maxBytes = int(p, 'maxBytes', READ_BYTES_MAX);
      if (st.size > maxBytes) throw new RpcError(`Too large: ${st.size} bytes`, undefined, { code: 'too_large', size: st.size, abs });
      const offset = int(p, 'offset', 0);
      const length = Math.min(int(p, 'length', READ_BYTES_CHUNK), READ_BYTES_CHUNK);
      let file: Deno.FsFile;
      try {
        file = Deno.openSync(abs, { read: true });
      } catch (error) {
        const denied = error instanceof Deno.errors.PermissionDenied;
        throw new RpcError(denied ? 'Permission denied' : error instanceof Error ? error.message : String(error), undefined, {
          code: denied ? 'unreadable' : 'read_failed',
          abs,
        });
      }
      const buf = new Uint8Array(Math.max(0, Math.min(length, st.size - offset)));
      let got = 0;
      try {
        if (offset) file.seekSync(offset, Deno.SeekMode.Start);
        while (got < buf.length) {
          const n = file.readSync(buf.subarray(got));
          if (n === null) break;
          got += n;
        }
      } finally {
        file.close();
      }
      return { bytesB64: encodeBase64(buf.subarray(0, got)), size: st.size, mtimeMs: st.mtime?.getTime() ?? 0, offset, path, abs };
    },

    'files.outside': async (p) => {
      // AIB's own folders in the distro (~/.aib-server, or AIB_WSL_ROOT under test) are never shown
      const peek = p.peek === true;
      const real = outside.resolveOutside(outside.checkShape(str(p, 'path')), await ownFolders(ctx));
      const read = outside.readOutside(real, peek);
      const viewable = !peek && !read.tooBig && (read.image || (read.page && !read.binary));
      return {
        read: { ...read },
        outside: { ...outside.folderLabel(real) },
        ...(viewable ? { bytesB64: encodeBase64(Deno.readFileSync(real)) } : {}),
      };
    },

    'codex.limits': async (p) => {
      const asked = str(p, 'codexDir', true);
      if (asked && (!osp.isabs(asked) || asked.length > 4096)) throw new RpcError('codexDir must be an absolute path', BAD_PARAMS);
      const login = await ctx.env();
      const dir = asked || login.env.CODEX_HOME || osp.join(login.home || login.env.HOME || '/', '.codex');
      return { found: latestRolloutLimits(osp.normpath(dir)) };
    },

    // Project delete in the distro: the same refusals as a Windows delete, then the distro's trash (gio, else the freedesktop trash).
    // Never a permanent delete: with no usable trash the answer is a refusal.
    'project.inspect': async (p) => {
      const { guard, layer } = await trashSetup(ctx, p);
      return { ...await inspectInDistro(absPath(p, 'path'), guard, layer) };
    },

    'project.trash': async (p) => {
      const { guard, layer } = await trashSetup(ctx, p);
      try {
        return { disk: await trashInDistro(absPath(p, 'path'), guard, layer) };
      } catch (error) {
        if (error instanceof Refused) throw new RpcError(error.message, undefined, { code: 'refused' });
        throw error;
      }
    },

    'files.gitInfo': async (p) => await files.gitInfo(absPath(p, 'root')),

    'changes.get': async (p) => {
      return withDocs(await getChanges(absPath(p, 'folder'), str(p, 'base', true) || null, int(p, 'offset', 0)));
    },

    'changes.diff': async (p) => await getFileDiff(absPath(p, 'folder'), p.path, str(p, 'base', true) || null),

    // several folders in one call, one after another (never in parallel), a folder that cannot be read answers {error, code}
    'changes.many': async (p) => {
      const folders = Array.isArray(p.folders) ? p.folders.slice(0, 40) : [];
      const results: unknown[] = [];
      for (const raw of folders) {
        const one = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        try {
          const folder = absPath(one, 'folder'), base = str(one, 'base', true) || null;
          if (one.counts === true) results.push(await getCounts(folder, base));
          else results.push(withDocs(await getChanges(folder, base, int(one, 'offset', 0))));
        } catch (error) {
          results.push({ error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? 'failed' });
        }
      }
      return { results };
    },

    'changes.branchEntries': async (p) => {
      const found = await locate(absPath(p, 'folder'));
      if (!found) return { git: false };
      const [top, prefix, head] = found;
      const asked = str(p, 'base', true);
      const base = asked && await commitExists(top, asked) ? asked : head;
      const [entries, cut] = await branchEntries(top, prefix, base);
      return { git: true, root: top, prefix, base, entries, cut };
    },

    'transcripts.sessions': async (p) => {
      const store = await sessionStore(ctx, p);
      if (!store) return { sessions: [] };
      const limit = Math.min(Math.max(1, int(p, 'limit', SESSIONS_DEFAULT)), SESSIONS_MAX);
      const sessions = (await store.sessions()).filter((s) => typeof s.cwd === 'string' && s.cwd.startsWith('/')).slice(0, limit);
      return { sessions };
    },

    'transcripts.read': async (p) => {
      const store = await sessionStore(ctx, p);
      const key = str(p, 'key');
      if (!store) return { status: 400, body: { error: 'Unknown transcript' } };
      const args = new URLSearchParams({ key });
      const given = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args as Record<string, unknown> : {};
      for (const name of TRANSCRIPT_ARGS) if (typeof given[name] === 'string') args.set(name, given[name] as string);
      const reply = await handleGet(store, '/api/transcript', args.toString());
      return { status: reply.status, body: reply.body };
    },

    // A saved chat's outside-file guard (Windows: files_routes.ts mentionedBy): does its own transcript (and its subagents') name
    // `path`, by Linux rules? Only the session file and the files below its folder are read, never the path itself.
    'transcripts.mentions': async (p) => {
      const path = str(p, 'path');
      if (!path.startsWith('/') || path.length > 4096 || path.includes('\0')) throw new RpcError('path must be an absolute Linux path', BAD_PARAMS);
      const provider = str(p, 'provider'), sessionId = str(p, 'sessionId');
      const store = await sessionStore(ctx, p);
      if (!store) return { mentioned: false };
      const texts = await outside.chatTexts({ sessionFile: (prov, sid) => findSessionFile(prov, store.root, sid) }, `${provider}:${sessionId}`);
      return { mentioned: outside.mentions(texts, path, true) };
    },

    'git.identity': async (p) => await readRepoIdentity(absPath(p, 'folder')),

    'chat.repoBranch': async (p) => {
      const folder = absPath(p, 'folder');
      const found = await locate(folder);
      return { repo: found ? found[0] : null, branch: repoBranch(folder) || null };
    },
  };
}
