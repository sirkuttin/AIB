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
  /** Called for the helper's other notifications (agents.installProgress). Optional: older hosts and fakes may not have it. */
  onNotify?(handler: (method: string, params: Record<string, unknown>) => void): () => void;
  /** Install if needed, connect, start the helper (idempotent; the first use of a host starts it). Rejects with the reason. */
  start(): Promise<void>;
  /** "Reconnect" on a stopped or failed distro: start again now; a ready host is left as it is. */
  reconnect(): Promise<void>;
  /** The running helper's version (helper.ready), null before it is ready (Settings > About). */
  readonly helperVersion: string | null;
  /**
   * Phase 2 MCP tunnel: what a WSL chat's `studio_artifact` entry runs (`<forwarder> mcp-forward --helper-socket <socket>`, both Linux
   * paths), or null when this helper has no tunnel (older helper, or its relay did not start: AIB falls back to the interop entry).
   */
  readonly mcpTunnel?: { forwarder: string; socket: string } | null;
  /** Called for each tool call an agent in the distro sends through the tunnel (HelperMcpRequest), once, never for a replayed one. */
  onMcpRequest?(handler: (request: HelperMcpRequest['params']) => void): () => void;
}

export class WslHelperError extends Error {
  constructor(message: string, readonly code: string = 'helper_error') {
    super(message);
    this.name = 'WslHelperError';
  }
}

/**
 * Helper protocol version, the first line on the helper channel is `helper.ready {helper, protocol, methods}`. Additions only.
 * 2: worktree.cleanupScan / worktree.cleanupApply (decision 6 cleanup, build plan 1b section 5). The helper ships with AIB (install.ts
 * puts each version's programs in their own folder), so an update brings a helper of the same protocol.
 * 3: was transcripts.refile / transcripts.cleanEmpty; both went again (old copy chats are moved by the owner's one-off migration
 * script, work/migrate/folder_chats_migrate.ts, not by AIB). Nothing calls them, so the number stays.
 */
export const HELPER_PROTOCOL = 3;

/** worktrees/cleanup.ts Scan as the channel carries it (items are CleanupItem; paths are Linux paths). */
export interface WslCleanupScan {
  project: string;
  skipped: string;
  items: Record<string, unknown>[];
}

/** Phase 1 helper methods. JSON-RPC 2.0 lines; bytes are base64. Result shapes of changes.*, files.* are exactly what worktrees/changes.ts and files.ts return today. */
export interface HelperMethods {
  'env.get': { params: Record<string, never>; result: { env: Record<string, string>; shell: string; home: string; arch: string } };
  'which': { params: { name: string }; result: { path: string | null } };
  /**
   * The agents the distro has, AIB's own install (<root>/agents/<id>/<version>) first. `source` is adapters.ts LaunchRow.source
   * ('studio' = AIB's own install); `signin` is Codex's own CLI as an argv (the one next to the adapter, else `codex` on PATH).
   * `bundledCli` (Claude Code and Codex rows; older helpers leave it out): the vendor program the adapter ships was found in the
   * adapter's own node_modules (Codex: @openai/codex/bin/codex.js; Claude Code: the SDK's cli.js or its platform `claude` binary).
   */
  'agents.detect': {
    params: { ids?: string[] };
    result: {
      agents: {
        id: string;
        found: boolean;
        command?: string[];
        version?: string;
        note?: string;
        source?: string;
        signin?: string[];
        bundledCli?: boolean;
      }[];
    };
  };
  /**
   * AIB-managed agent installs in the distro (helper/agent_install.ts: agents/installer.ts run natively into <root>/agents/<id>/<version>,
   * `npm ci` from AIB's lockfile, never `npm i -g`). Offered by a helper that knows its root. `entry` and `lock` are AIB's
   * agent_versions.json entry and lockfile text. installCheck: what is missing to install (code '' | 'node_missing' | 'node_broken' |
   * 'node_old' | 'npm_missing'); `force` reads the login PATH again first. install refuses with error code 'install_refused' (one plain
   * line) or a node code. Each saved job state also arrives as the notification `agents.installProgress` (WslInstallView).
   */
  'agents.installCheck': { params: { force?: boolean }; result: { code: string; node: string; nodeVersion: string; npm: boolean; minNode: number } };
  'agents.install': { params: WslInstallParams; result: WslInstallView & { attached?: boolean } };
  'agents.installStatus': { params: WslInstallParams; result: WslInstallView };
  'agents.installCancel': { params: WslInstallParams; result: WslInstallView };
  'fs.stat': { params: { path: string }; result: { exists: boolean; isDir: boolean; isFile: boolean; size: number; mtimeMs: number } };
  'fs.listDirs': { params: { path: string; limit?: number }; result: { path: string; parent: string | null; dirs: { name: string; isGit: boolean }[]; truncated: boolean } };
  'folder.check': { params: { path: string }; result: { ok: boolean; reason?: string; isGit: boolean; realPath: string } };
  /** Linking (WSL) phase 2 (docs/wsl/linking-design.md section 12). What the distro has for running agents; never installs anything. */
  'env.prereqs': { params: { force?: boolean }; result: EnvPrereqs };
  /** Remove one AIB-installed agent (<root>/agents/<id>/<ver>); refused while a chat runs from it. Never touches the user's own installs. */
  'agents.uninstall': { params: { id: string }; result: { ok: boolean; removed: string[]; message?: string; blocked?: string } };
  /** Is each agent signed in inside the distro (reads credential files' presence/validity only, never their content). */
  'agents.signinStatus': { params: { ids?: string[] }; result: { agents: { id: string; state: 'signed_in' | 'signed_out' | 'unknown'; account?: string; note?: string }[] } };
  /**
   * Linking (WSL) phase 3 (docs/wsl/linking-design.md section 13; helper/aib_remove.ts). `aib.usage`: what AIB takes in the distro
   * (read-only, a bounded walk that never follows a link; `partial` when it was cut short). `aib.remove`: 'check' lists what Remove
   * would delete and keep and every refusal, deleting nothing; 'apply' runs the refusals again and deletes this AIB's data folder
   * (all but its keeper/ and helper/ run folders, which the keeper and helper still use) and, only when nothing else uses them, the
   * shared parts. `final` (apply, an addition) says what AIB's last step may delete after the keeper and helper have ended.
   * Offered only by a helper started with `--data`.
   */
  'aib.usage': { params: Record<string, never>; result: AibUsage };
  'aib.remove': { params: { mode: 'check' | 'apply'; projects?: string[] }; result: AibRemoveResult };
  'folder.project': { params: { path: string; name?: string }; result: Record<string, unknown> };
  'folder.createProject': { params: { path: string; name?: string; gitInit?: boolean }; result: Record<string, unknown> };
  'git.init': { params: { path: string }; result: { ok: boolean; message?: string } };
  'files.list': { params: { root: string; rel?: string; offset?: number; limit?: number }; result: unknown };
  'files.search': { params: { root: string; query: string; limit?: number }; result: unknown };
  'files.read': { params: { root: string; rel: string; maxBytes?: number }; result: { bytesB64: string; size: number; truncated: boolean; mtimeMs: number; path?: string; abs?: string } };
  /**
   * A whole file's bytes for an artifact published by path from a WSL chat (helper/methods.ts, wsl/artifact_read.ts): `rel` inside
   * `root`, checked after links are resolved (code 'outside'); one piece of at most 1 MB at `offset` (`length`, default and cap 1 MB)
   * with the file's `size` and `mtimeMs`, so AIB reads a big file in pieces and notices a change between them. Refusals by code:
   * 'not_found', 'not_file' (a folder), 'too_large' (size over `maxBytes`, default 25 MB; nothing read), 'unreadable' (permission).
   */
  'files.readBytes': {
    params: { root: string; rel: string; offset?: number; length?: number; maxBytes?: number };
    result: { bytesB64: string; size: number; mtimeMs: number; offset: number; path: string; abs: string };
  };
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
  /**
   * The file editor's disk work in a WSL project (helper/editor.ts; files/wsl_disk.ts): `rel` inside `root` after links, the guard
   * (sign-in folders: code 'blocked'; AIB's own folders: 'worktree' | 'data'; .git and out of the project: FilesError codes). read:
   * settled with `settleMs`, pieces of at most 1 MB at `offset`, a file over 5 MB only its first 8 KB (`tooBig`). write: pieces into
   * `.aib-save-<token>.tmp` next to the real target, the last (`done`) checks the target's raw bytes against `expect` (code
   * 'changed'), keeps mode, owner and group (code 'owner') and renames. sweep: leftover temp files older than a minute.
   */
  'editor.read': {
    params: { root: string; rel: string; blocked?: string[]; settleMs?: number; offset?: number };
    result: {
      state: 'ok' | 'moving' | 'gone';
      real: string;
      rel: string;
      size?: number;
      mtimeMs?: number;
      mode?: number;
      offset?: number;
      tooBig?: boolean;
      bytesB64?: string;
    };
  };
  'editor.write': {
    params: { root: string; rel: string; blocked?: string[]; token: string; offset: number; bytesB64: string; done: boolean; expect?: string | null };
    result: { ok: boolean; offset?: number; real?: string; size?: number; mtimeMs?: number };
  };
  'editor.sweep': { params: { root: string; rel: string; blocked?: string[] }; result: { swept: number } };
  /**
   * The docs' file work of a WSL project (helper/docs.ts; docs/doc_fs.ts on Windows): AIB holds the open doc, the helper reads and
   * writes its files in <project>/aib-docs/ natively. Linux paths, only under some folder's aib-docs/ (real paths checked). One
   * result per op, in order: {ok: true, ...} or {ok: false, error, code}. read -> text (null: missing), stat -> stat (null), list ->
   * entries (null), writeNew -> created, trashKind -> kind, trash -> kind (code 'no_trash': none, nothing deleted). A big atomic write
   * is `chunk` ops ({path, token, text, first}) then `writeAtomic` {path, token}.
   */
  'docs.fs': { params: { ops: DocFsOp[] }; result: { results: Record<string, unknown>[] } };
  'changes.get': { params: { folder: string; offset?: number; base?: string }; result: unknown };
  'changes.diff': { params: { folder: string; path: string; base?: string }; result: unknown };
  /**
   * Several folders in one call (the project right panel's Changes: one answer for the project, one helper call, not one per folder).
   * One result per folder, in order: what changes.get answers (or only the numbers, `counts: true`: changes.ts getCounts), or
   * {error, code} for a folder that cannot be read.
   */
  'changes.many': { params: { folders: { folder: string; base?: string; offset?: number; counts?: boolean }[] }; result: { results: unknown[] } };
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
   * Decision 6 cleanup in the distro (worktrees/cleanup.ts run natively over the same `<data>`): `cleanupScan` lists what this AIB
   * made in the repo (and what another AIB install made there, own: false) and changes nothing; `cleanupApply` removes this AIB's
   * items without unmerged work plus the ids in `ticked` (`silentOnly`: none of those), never a copy of a running chat (`live`:
   * Linux worktree paths and provider:sessionId). Linux paths. Protocol 2.
   */
  'worktree.cleanupScan': { params: { project: string; live?: string[] }; result: { scan: WslCleanupScan } };
  'worktree.cleanupApply': {
    params: { project: string; ticked?: string[]; only?: string[]; live?: string[] };
    result: { scan: WslCleanupScan; removed: string[]; left: Record<string, string> };
  };
  /**
   * Merge of a WSL chat's worktree (helper/merge.ts: worktrees/merge.ts run natively over the same `<data>` as worktree.*; its repo
   * lock, worktree lock and clash records live there). Offered with worktree.*. AIB sends the chat's public state (`state`, its `cwd`
   * the worktree's Linux path) instead of being asked for it; what merge.ts would post to the chat (conflict prompts, the "Merged into"
   * note, the clash note and prompt, the Merge button's queued message) comes back in `actions`, in order, and AIB posts them.
   * A refusal is an answer, not an error: `refused` {message, code, status, extra} is merge.ts's Refused.
   */
  'merge.status': { params: { chat: string; state: Record<string, unknown> }; result: { result: Record<string, unknown> } };
  'merge.run': { params: { chat: string; state: Record<string, unknown>; title?: string; fromTool?: boolean }; result: WslMergeAnswer };
  'merge.resolveClash': { params: { chat: string; state: Record<string, unknown>; action: string; fromTool?: boolean }; result: WslMergeAnswer };
  'merge.clashStatus': { params: { project: string }; result: { result: Record<string, unknown> } };
  /**
   * Live sync of WSL chats' worktrees (helper/sync.ts: worktrees/sync.ts run natively over the same `<data>`, its folder watcher
   * inotify). Offered with worktree.*. `sync.chats` is the whole set of open WSL chats in their own copy (cwd: the worktree's Linux
   * path), sent in order; the helper keeps it in `<data>/wsl-sync-chats.json` and watches them again after a restart. The turn hooks
   * carry the chat's public state as merge.* do (an unknown chat is added). `context` is sync.ts contextFor's [text, token] or null.
   */
  'sync.chats': { params: { chats: { chat: string; cwd: string }[] }; result: { chats: number; added: string[]; removed: string[] } };
  'sync.turnStarted': { params: { chat: string; state: Record<string, unknown> }; result: { ok: boolean } };
  'sync.turnEnded': { params: { chat: string; state: Record<string, unknown> }; result: { ok: boolean } };
  'sync.contextFor': { params: { chat: string; state: Record<string, unknown> }; result: { context: [string, unknown] | null } };
  'sync.contextSent': { params: { chat: string; state: Record<string, unknown>; token: unknown }; result: { ok: boolean } };
  'sync.resume': { params: { project: string }; result: { resumed: boolean } };
  'sync.status': {
    params: Record<string, never>;
    result: { poll: number; chats: { chat: string; cwd: string }[]; projects: { project: string; watching: boolean; events: number }[] };
  };
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
  /**
   * Does one saved session's own transcript (and its subagents' files) name `path` (an absolute Linux path, matched by Linux rules,
   * worktrees/outside_files.ts mentions)? The outside-file guard of a saved WSL chat that is not running in AIB. Reads only the
   * transcripts, never `path`.
   */
  'transcripts.mentions': {
    params: { provider: 'claude' | 'codex'; sessionId: string; path: string; claudeDir?: string };
    result: { mentioned: boolean };
  };
  /**
   * The viewer's background-task reads of one saved session, answered by the helper's transcripts/monitor.ts handleGet (helper/
   * bgtasks.ts): `path` is '/api/agents' (the chat and its subagents, each with runningCommands), '/api/commands' (args.running '1':
   * only running ones) or '/api/command' (args.id; with the task's output, read only from Claude Code's own task folder under
   * `tempDir`, else the distro's `$TMPDIR/claude-<uid>` and `$TMPDIR/claude`). Keys and ids are the helper store's (no `wsl.` prefix).
   */
  'transcripts.query': {
    params: { provider: 'claude' | 'codex'; path: '/api/agents' | '/api/commands' | '/api/command'; key: string; args?: Record<string, string>; claudeDir?: string; tempDir?: string };
    result: { status: number; body: unknown };
  };
  /**
   * The ownership check of a saved session before AIB continues it (helper/bgtasks.ts: ownership/probe.ts OwnershipProbe and
   * ownership.ts findExternalOwner run natively over the distro's /proc and Claude transcripts). `owner`: the pid of a `claude`/`omp`
   * process whose command line names the session (the strong check AIB refuses with); `assessment`: probe.assess (skipCmdline, fresh)
   * without the owner registry, which AIB adds on Windows. `exclude`: pids of AIB's own agent channels in this distro (they and their
   * descendants never count; the helper's own process tree never does either). `releasedAgo`: seconds since AIB released the session
   * (its own transcript writes before then are not evidence).
   */
  'ownership.check': {
    params: { provider: string; sessionId: string; cwd?: string; projectRoot?: string; exclude?: number[]; claudeDir?: string; releasedAgo?: number };
    result: { owner: number | null; assessment: Record<string, unknown> };
  };
  /**
   * Open elsewhere (ownership/handoff.ts): of `sessionIds`, the ones a live Claude Code process in the distro holds per Claude Code's
   * session registry (<claudeDir>/sessions/<pid>.json), not counting `exclude` (AIB's own agent channels) and what runs below them.
   */
  'sessions.held': {
    params: { sessionIds: string[]; exclude?: number[]; claudeDir?: string };
    result: { held: Record<string, { pid: number; entrypoint: string; status: string }> };
  };
  /**
   * Open elsewhere for Codex chats in the distro (helper/bgtasks.ts, ownership/codex_threads.ts, codex_apps.ts), read-only: of
   * `sessionIds` (thread ids), `cli`: a Codex CLI process whose command line names the thread; `locked`: the thread's writer lock
   * (<codexHome>/thread-writer-locks/<id>.lock; codexHome: CODEX_HOME, else ~/.codex of the distro user) is held now (/proc/locks);
   * `appServers`: every `codex app-server` process classified by who started it ('own' = at or below `exclude`, AIB's agents;
   * 'vscode', 'desktop', 'unrelated'), `start` naming the process with its pid. Processes come from `ps`, locks from /proc/locks.
   */
  'codex.scan': {
    params: { sessionIds: string[]; exclude?: number[]; codexHome?: string };
    result: {
      cli: Record<string, { pid: number }>;
      locked: Record<string, { pid: number }>;
      appServers: { pid: number; start: string; kind: string; app: string }[];
    };
  };
  /** The conversation list's ownership hints of the distro's sessions (probe.hints, no registry) and its list certainty. */
  'ownership.hints': {
    params: { exclude?: number[]; claudeDir?: string };
    result: { hints: Record<string, { verdict: string; reasons: Record<string, unknown>[] }>; certainty: 'unknown' | 'checked' };
  };
  /**
   * The processes below each root pid (platform/descendants.ts run natively, /proc): busy-children detection of WSL chats (a background
   * shell still runs). Rows are [pid, parentPid, depth, age in seconds (to 0.01 s; whole seconds from an older helper) or null]; a root whose processes cannot be listed is null.
   */
  'proc.tree': { params: { roots: number[] }; result: { trees: Record<string, [number, number, number, number | null][] | null> } };
  /**
   * Stop on a WSL chat's background command (platform/kill_verified.ts run natively): `targets` are [pid, age in seconds] of the
   * processes AIB noted from `proc.tree` below the agent `root`. Each must still be `root`'s descendant with that start time (a reused
   * pid is not); those and what they started since get TERM, then KILL after 2 s, leaf first. Nothing else is signalled. `listed`
   * false: the processes could not be listed, nothing was sent. `killed`: [pid, age] of each process a TERM was sent to.
   */
  'proc.stop': {
    params: { root: number; targets: [number, number][] };
    result: { listed: boolean; killed: [number, number][]; skipped: number[] };
  };
  /**
   * The MCP tunnel (phase 2; helper/mcp_tunnel.ts, wsl/mcp_tunnel.ts). A forwarder's message arrives as the notification
   * HelperMcpRequest; AIB first takes it with `mcp.accept` (ok false: the helper already gave up on it, so AIB must not run it), runs it
   * on its HTTP tool endpoint's checks, and answers with `mcp.reply` (status as HTTP: 200 with body, 202 none, else an error; 503 with
   * `error`: AIB cannot take it, the forwarder says so at once). `mcp.closed` true: AIB was quit on purpose, so new messages are
   * answered "AIB is closed" at once; any other call from AIB clears it. Offered only when helper.ready carries `mcp: {socket}`.
   */
  /**
   * Local-only files of WSL projects (helper/local_only.ts: worktrees/local_only.ts, files.ts and local_backup.ts run natively). Linux
   * paths only. `main` is the project's main folder; `root` the folder Files shows (main itself, or a chat's copy, which must then be
   * inside the helper's `<data>/worktrees`). Answers are what files_routes.ts answers for a Windows project, with `localOnly.main`
   * the Linux main folder. `localOnly.ensure` sets the default `/aib-shared` up (ensureDefault); `localOnly.chat` is what a chat is told
   * (local_only.ts chatLocalOnly: entries, dirs, shared; it makes the main folder's aib-shared/ for a worktree chat). `localOnly.read`
   * reads like files.read, from `readRoot` (the main folder for a local-only path of a chat's copy). `localOnly.exclude` is POST
   * files/exclude ({status, body}); `localOnly.backup` the daily zip into `<data>/local-only-backups` of the given projects and of the
   * projects with chat copies (only with `--data`).
   */
  'localOnly.ensure': { params: { project: string }; result: { state: string } };
  /**
   * `ignored` (a chat in its own copy): also every other top-level folder and file git ignores in the main folder (worktrees/
   * ignored_overlay.ts ignoredTops: never .git, another worktree of the repo, or AIB's data folder), as `localOnly.ignored`.
   */
  'localOnly.chat': {
    params: { project: string; worktree: boolean; ignored?: boolean };
    result: { localOnly: { entries: string[]; dirs: string[]; shared: string; ignored?: { dirs: string[]; files: string[] } } | null };
  };
  'localOnly.list': { params: { root: string; main: string; dir?: string }; result: Record<string, unknown> };
  'localOnly.search': { params: { root: string; main: string; query: string }; result: Record<string, unknown> };
  'localOnly.read': {
    params: { root: string; main: string; rel: string; maxBytes?: number };
    result: { bytesB64: string; size: number; truncated: boolean; mtimeMs: number; readRoot: string; local?: boolean; from?: 'main' };
  };
  'localOnly.exclude': { params: { root: string; main: string; action: string; path?: string; undo?: string }; result: { status: number; body: Record<string, unknown> } };
  'localOnly.backup': { params: { projects?: string[] }; result: { results: Record<string, { status: string; files?: number }> } };
  /**
   * Allow rules in a WSL chat (helper/allow_facts.ts, allow/linux.ts; addition): what the matcher needs to know of the distro, read
   * only. `paths` (at most 64 absolute Linux paths, taken as given: never normalised first): each resolved as the kernel walks it
   * (links followed, `..` after a link physically, the missing tail kept; `real` null for a dangling or looping link, `..` in the
   * missing tail, or any error), `exists`/`isDir` with links followed. `scans` (at most 16 folders): true when the folder holds a link
   * among its entries, has over 5000 entries or can't be read. `pins` (at most 8): allow/pin.ts pinHash of project-script words in a
   * folder. `base`: the folders on PATH (`pathEnv` when given, else the login PATH) each with its resolved path, AIB's own folders in
   * the distro, and, with `claude`, Claude Code's settings facts (allow/agent_config.ts claudeFacts) read from `claude.dir` (else
   * CLAUDE_CONFIG_DIR or ~/.claude of the login environment) and the project's .claude folder.
   */
  'allow.facts': {
    params: {
      paths?: string[];
      scans?: string[];
      pins?: { words: string[]; cwd: string }[];
      base?: { pathEnv?: string; claude?: { cwd: string; dir?: string } };
    };
    result: {
      paths: { real: string | null; exists: boolean; isDir: boolean }[];
      scans: boolean[];
      pins: (string | null)[];
      base?: {
        pathDirs: { dir: string; real: string | null }[];
        own: string[];
        claude: { askPrograms: string[]; askTools: string[]; riskyEnv: string } | null;
      };
    };
  };
  'mcp.accept': { params: { rid: string }; result: { ok: boolean } };
  'mcp.reply': { params: { rid: string; status: number; body?: string; error?: string }; result: { ok: boolean } };
  'mcp.closed': { params: { closed: boolean }; result: { ok: boolean } };
}

/**
 * Notification (no id) from the helper: one MCP message from an agent's `mcp-forward --helper-socket` in the distro. `headers` are
 * the forwarder's MCP_FORWARD_HEADERS (the conversation id and its artifact key); `body` the JSON-RPC message text. `rid` names it in
 * `mcp.accept` and `mcp.reply`.
 */
export interface HelperMcpRequest {
  method: 'mcp.request';
  params: { rid: string; headers: Record<string, string>; body: string };
}

/** One docs.fs operation (helper/docs.ts). `path` is a Linux path inside a project's aib-docs/. */
export interface DocFsOp {
  op: 'read' | 'stat' | 'list' | 'mkdir' | 'writeNew' | 'write' | 'chunk' | 'writeAtomic' | 'rename' | 'copy' | 'remove' | 'trashKind' | 'trash';
  path: string;
  to?: string;
  text?: string;
  token?: string;
  first?: boolean;
  recursive?: boolean;
  kind?: string;
  /** read: the SHA-256 (hex, of the UTF-8 text) AIB holds; an unchanged file answers {same: true} without its text. */
  known?: string;
  /** trash, trashKind: XDG_DATA_HOME (tests: inside AIB_WSL_ROOT); viaGio false skips gio. */
  dataHome?: string;
  viaGio?: boolean;
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

/**
 * What a merge.* call did. `actions`: the live calls merge.ts made (op 'prompt' | 'worktree-note' | 'queue', payload as merge.ts built
 * it). `must`: AIB refuses with `fail` + the chat's error when the call is not accepted (the conflict prompts, as merge.ts does);
 * the others are posted as merge.ts posts them (a failure is only logged).
 */
export interface WslMergeAnswer {
  result?: Record<string, unknown>;
  refused?: { message: string; code: string; status: number; extra: Record<string, unknown> };
  actions: { op: string; payload: Record<string, unknown>; must?: boolean; fail?: string }[];
}

/** An agents.install* call: the agent, AIB's allow-list entry for it, and its lockfile text (null: none). */
export interface WslInstallParams {
  agent: string;
  entry: { package: string; version: string; packageBytes?: number; minFreeBytes?: number };
  lock?: string | null;
}

/** An install job's state (agents/installer.ts InstallView): state 'idle' | 'running' | 'failed' | 'done'. */
export interface WslInstallView {
  agent: string;
  state: string;
  stage: string;
  percent: number;
  message: string;
  version?: string;
  interrupted?: boolean;
}

/** Notification (no id) from the helper: an install job's state was saved (progress, done, failed). */
export interface HelperInstallProgress {
  method: 'agents.installProgress';
  params: WslInstallView;
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
  /** Keeper 1.6.0: its live channels had no client and stop at this time (Unix ms) unless one comes; absent otherwise. */
  orphanStopAt?: number;
}

/** Linux-side layout, relative to $HOME (never passed with `~`). */
export const WSL_ROOT_DIR = '.aib-server'; // tests override with the AIB_WSL_ROOT env var (an absolute Linux path)

/** What AIB takes in a distro (design section 13, GET /api/live/wsl/aib `usage`). Sizes are disk use in bytes. */
export interface AibUsage {
  root: string;
  totalBytes: number;
  /** This AIB's <ver> (the folder its helper and keeper run from). */
  current: string;
  parts: { key: 'versions' | 'agents' | 'npmCache' | 'data' | 'worktrees' | 'logs' | 'other'; label: string; bytes: number; path: string }[];
  versions: string[];
  agents: { id: string; versions: string[]; bytes: number }[];
  dataFolders: { name: string; mine: boolean; keeperAlive: boolean; bytes: number }[];
  /** dirty: chat copies with uncommitted changes, new (untracked) files included. */
  worktrees: { count: number; dirty: number };
  /** WSL chats of this AIB working now (AIB fills it in; the helper says 0). */
  chatsWorking: number;
  /** Addition: the walk was cut short (time or entry limit), so the sizes are at least these. */
  partial?: boolean;
}

/** The answer of `aib.remove` and POST /api/live/wsl/aib/remove (design section 13). */
export interface AibRemoveResult {
  ok: boolean;
  mode: 'check' | 'apply';
  /** Why Remove cannot run now, one plain line each (verbatim on the page). */
  blocked: string[];
  wouldRemove: { path: string; what: string; bytes: number }[];
  kept: { path: string; why: string }[];
  removed: string[];
  left: string[];
  message?: string;
  /**
   * Helper-only addition (never sent to the page): what AIB's last step (wsl/remove.ts FINAL_CLEANUP_SCRIPT) may delete after the
   * keeper and the helper have ended: the data folder's name, the current <ver> (null: kept) and whether the root may go when empty;
   * `copies`: the chat copies deleted (AIB remembers them, so their chats read as "workspace removed": wsl/removed.ts).
   */
  final?: { data: string; version: string | null; root: boolean; copies: { path: string; project: string; branch: string; session: string }[] };
}

/** The distro's prerequisites for AIB-managed agents (design section 12). */
export interface EnvPrereqs {
  /** Node.js >= 22.19 with npm is the one hard prerequisite. 'shim_unset': a version manager's shim (asdf/mise) with no version set. */
  node: {
    state: 'ok' | 'missing' | 'old' | 'shim_unset' | 'broken';
    version?: string;
    path?: string;
    manager?: 'asdf' | 'mise' | 'nvm' | 'system' | 'aib' | '';
    note?: string;
    /** Added after the freeze (optional): the asdf/mise version ('0.18.0'), so the page shows that generation's commands. */
    managerVersion?: string;
  };
  npm: { state: 'ok' | 'missing'; version?: string };
  git: { state: 'ok' | 'missing'; version?: string };
  curl: { state: 'ok' | 'missing' };
  /** Free space in the distro's home filesystem, MB (null: unknown). */
  diskFreeMB: number | null;
  arch: string;
  loginShell: string;
  /** How the login environment was captured: -lic, -lc, or not at all (a version manager in an interactive-only profile is then missed). */
  envMode: 'login-interactive' | 'login' | 'plain';
  /**
   * Added after the freeze (optional; older helpers leave it out, read as 'apt'): the distro's package manager family, from
   * /etc/os-release ID / ID_LIKE and the programs found, for the copy-only git and curl commands.
   */
  pkgManager?: 'apt' | 'dnf' | 'yum' | 'zypper' | 'pacman' | 'apk' | 'unknown';
  /** nvm is present in the user's home (so the Node install button can say it will use it). */
  nvm: { present: boolean };
  /** Whether AIB may offer the nvm install button (never when the node found is a shim, or nvm is blocked); the reason otherwise. */
  canInstallNode: boolean;
  nodeInstallBlocked?: string;
}
