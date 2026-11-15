/**
 * WSL projects: the frozen contract between the three build tracks (see docs/wsl/design.md, sections 2, 3, 10, 11).
 * Types and constants only: no behaviour, no imports. Changing a shape here needs the lead's say-so; additions are fine.
 */

/** Where a project lives. A WSL project is {distro, linuxPath}; its stored form is the canonical ref (see refOf in platform/location.ts). */
export type Loc = { kind: 'win' } | { kind: 'wsl'; distro: string; linuxPath: string };

/** Canonical ref: `wsl://<distro><linuxPath>`, e.g. `wsl://Ubuntu/home/u/app`. The distro is case-folded when the ref is built; the path is case-sensitive. Never URL-parse it. */
export const WSL_REF_PREFIX = 'wsl://';

/** What the rest of AIB sees of one distro. Track B implements it (wsl/hosts.ts); Track C builds against a FakeWslHost until then. */
export interface WslHost {
  readonly distro: string;
  readonly state: 'starting' | 'installing' | 'ready' | 'reconnecting' | 'stopped' | 'unavailable';
  /** Human line for the UI when state is not 'ready' (e.g. "Setting up AIB in Ubuntu (first time)", the failure reason). */
  readonly note: string;
  /** The Linux keeper link: agents, PTYs, the helper channel. Same KeeperLink API as the Windows keeper. */
  readonly link: unknown;
  /** Call a helper method. Rejects with WslHelperError. Throws if the helper does not list the method. */
  call<M extends keyof HelperMethods>(method: M, params: HelperMethods[M]['params'], opts?: { timeoutMs?: number }): Promise<HelperMethods[M]['result']>;
  /** The login environment of the distro, PATH without /mnt/*, BROWSER set to the aib-open shim. */
  env(): Promise<Record<string, string>>;
  /** Called when something inside the distro asks Windows to open a URL (BROWSER shim). */
  onOpenUrl(handler: (url: string) => void): () => void;
  /** Install if needed, connect, start the helper (idempotent; the first use of a host starts it). Rejects with the reason. */
  start(): Promise<void>;
  /** "Reconnect" on a stopped or failed distro: start again now; a ready host is left as it is. */
  reconnect(): Promise<void>;
  /** The running helper's version (helper.ready), null before it is ready (Settings > About). */
  readonly helperVersion: string | null;
}

export class WslHelperError extends Error {
  constructor(message: string, readonly code: string = 'helper_error') {
    super(message);
    this.name = 'WslHelperError';
  }
}

/** Helper protocol version, the first line on the helper channel is `helper.ready {helper, protocol, methods}`. Additions only. */
export const HELPER_PROTOCOL = 1;

/** Phase 1 helper methods. JSON-RPC 2.0 lines; bytes are base64. Result shapes of changes.*, files.* are exactly what worktrees/changes.ts and files.ts return today. */
export interface HelperMethods {
  'env.get': { params: Record<string, never>; result: { env: Record<string, string>; shell: string; home: string; arch: string } };
  'which': { params: { name: string }; result: { path: string | null } };
  'agents.detect': { params: { ids?: string[] }; result: { agents: { id: string; found: boolean; command?: string[]; version?: string; note?: string }[] } };
  'fs.stat': { params: { path: string }; result: { exists: boolean; isDir: boolean; isFile: boolean; size: number; mtimeMs: number } };
  'fs.listDirs': { params: { path: string; limit?: number }; result: { path: string; parent: string | null; dirs: { name: string; isGit: boolean }[]; truncated: boolean } };
  'folder.check': { params: { path: string }; result: { ok: boolean; reason?: string; isGit: boolean; realPath: string } };
  'folder.project': { params: { path: string; name?: string }; result: Record<string, unknown> };
  'folder.createProject': { params: { path: string; name?: string; gitInit?: boolean }; result: Record<string, unknown> };
  'git.init': { params: { path: string }; result: { ok: boolean; message?: string } };
  'files.list': { params: { root: string; rel?: string; offset?: number; limit?: number }; result: unknown };
  'files.search': { params: { root: string; query: string; limit?: number }; result: unknown };
  'files.read': { params: { root: string; rel: string; maxBytes?: number }; result: { bytesB64: string; size: number; truncated: boolean; mtimeMs: number } };
  /**
   * A file outside the project folder (worktrees/outside_files.ts, run natively: checkShape, resolveOutside, readOutside, folderLabel).
   * AIB has already checked that the chat named the path; the helper adds the shape rules and refuses its own data folder
   * (~/.aib-server). `bytesB64` is there for a picture or page that fits the 1 MB read cap and is not a peek.
   */
  'files.outside': { params: { path: string; peek?: boolean }; result: { read: Record<string, unknown>; outside: Record<string, unknown>; bytesB64?: string } };
  /** The newest Codex rate limits in the distro's ~/.codex session files (agents/codex_limits.ts latestRolloutLimits); `codexDir` wins (tests). */
  'codex.limits': { params: { codexDir?: string }; result: { found: { rateLimits: Record<string, unknown>; at: number } | null } };
  /**
   * Project delete inside the distro: `project.inspect` is what the dialog needs (project_delete.ts Inspection: exists, refusal, trash
   * 'gio' | 'xdg', worktreeOf), `project.trash` moves the folder to the distro's trash ('gio' | 'xdg' | 'missing'; error code
   * 'refused' with the reason). `projects` are the other projects' Linux paths in this distro; `dataHome` is XDG_DATA_HOME (tests); `viaGio: false` skips gio and uses the freedesktop trash (tests).
   * Never a permanent delete: with no usable trash it refuses.
   */
  'project.inspect': { params: { path: string; projects?: string[]; dataHome?: string; viaGio?: boolean }; result: { exists: boolean; refusal: string; trash: string; worktreeOf: string } };
  'project.trash': { params: { path: string; projects?: string[]; dataHome?: string; viaGio?: boolean }; result: { disk: 'gio' | 'xdg' | 'missing' } };
  'files.gitInfo': { params: { root: string }; result: unknown };
  'changes.get': { params: { folder: string; offset?: number; base?: string }; result: unknown };
  'changes.diff': { params: { folder: string; path: string; base?: string }; result: unknown };
  'changes.branchEntries': { params: { folder: string; base?: string }; result: unknown };
  'chat.repoBranch': { params: { folder: string }; result: { repo: string | null; branch: string | null } };
  /**
   * The worktree per chat of WSL projects (helper/worktrees.ts: worktrees/worktrees.ts Manager run natively, rooted at
   * `<data>/worktrees`, registry `<data>/studio-worktrees.json`). Linux paths only. Offered only by a helper started with `--data`.
   * Errors: 'fallback' (create: the chat works in place, the message says why), 'gone' (ensure: folder and branch are both gone).
   */
  'worktree.plan': { params: { project: string; kind?: 'chat' | 'helper'; key?: string }; result: { plan: WorktreePlanJson | null; reason: string } };
  'worktree.create': { params: { plan: WorktreePlanJson }; result: { note: string } };
  'worktree.discard': { params: { key: string }; result: { ok: boolean } };
  'worktree.setSession': { params: { key: string; provider: string; sessionId: string }; result: { ok: boolean } };
  'worktree.find': { params: { path?: string; session?: string }; result: { record: (Record<string, unknown> & { key: string }) | null } };
  'worktree.isRemoved': { params: { workspace: string; session?: string }; result: { removed: boolean } };
  'worktree.ensure': { params: { key: string }; result: { path: string } };
  'worktree.remove': { params: { key: string; confirmed?: boolean }; result: { outcome: 'removed' | 'pending' | 'gone' } };
  'worktree.hasChanges': { params: { key: string }; result: { changes: boolean } };
  /**
   * Saved sessions of the distro user's agents (~/.claude/projects, ~/.codex/sessions; CLAUDE_CONFIG_DIR / CODEX_HOME of the login
   * environment win), as transcripts/store.ts lists them on Windows: items with key, sessionId, cwd (a Linux path), title, mtime.
   */
  'transcripts.sessions': { params: { provider: 'claude' | 'codex'; limit?: number; claudeDir?: string }; result: { sessions: Record<string, unknown>[] } };
  /** A page of one saved session (key from transcripts.sessions; args: the page's limit, after, before, thinking, q, kind): the helper's /api/transcript answer. */
  'transcripts.read': {
    params: { provider: 'claude' | 'codex'; key: string; args?: Record<string, string>; claudeDir?: string };
    result: { status: number; body: unknown };
  };
}

/** A worktree plan on the helper channel (worktrees.ts Plan, Linux paths): `path` is always <data>/worktrees/<repo hash>/<slug>. */
export interface WorktreePlanJson {
  project: string;
  base: string;
  key: string;
  slug: string;
  branch: string;
  path: string;
  folderBranch: string;
  note: string;
}

/** Notification (no id) from the helper: a URL some process in the distro wants opened on Windows. http/https only, at most 2048 bytes. */
export interface HelperBrowserOpen {
  method: 'browser.open';
  params: { url: string };
}

/** Labels (first note / spawn label) of the channels AIB itself keeps in a keeper; studio rebuild and orphan cleanup must skip these. */
export const WSL_HOLD_LABEL = { aib: 'wsl-hold' } as const; // distro is added: {aib:'wsl-hold', distro}
export const WSL_HELPER_LABEL = { aib: 'wsl-helper' } as const; // version is added: {aib:'wsl-helper', v}

/** The one-line preamble `AIB-keeper bridge` writes before any keeper frame (after the BRIDGE_MAGIC line, which lets AIB skip wsl.exe notices). */
export const BRIDGE_MAGIC = 'AIB-BRIDGE-1';
export interface BridgePreamble {
  ev: 'bridge';
  bridge: 1;
  keeper: string;
  pid: number;
  token: string;
  home: string;
  uid: number;
  arch: string;
}

/** Linux-side layout, relative to $HOME (never passed with `~`). */
export const WSL_ROOT_DIR = '.aib-server'; // tests override with the AIB_WSL_ROOT env var (an absolute Linux path)
