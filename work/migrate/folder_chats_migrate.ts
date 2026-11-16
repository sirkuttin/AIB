/**
 * One-off folder-chats migration for the owner's machine (owner, 2026-11-16: "We don't need to complicate the application code for
 * these migrations ... we just need one off migration script for me to run on my machine").
 *
 * Before folder chats, an AIB chat could work in its own copy of the project (a git worktree AIB made, branch `studio/chat-...`).
 * Every chat now works in the project folder. This script, run once with AIB quit, moves the old copy chats there:
 *
 *   - Every old copy chat with no unmerged work is re-filed under its project folder, so it shows in `claude --resume`, VS Code and
 *     AIB's list for the project, and Continue opens it in the project folder:
 *       Claude Code: its `<id>.jsonl` (and `<id>/`) move from the copy's folder in ~/.claude/projects to the project's, with every
 *                    "cwd" line rewritten;
 *       Codex:       it is opened once in the project folder through the Codex ACP adapter (session/load, no prompt), so Codex
 *                    re-files it itself.
 *     The original transcript is first backed up to `<AIB data>\refiled\<provider>\` and that backup is kept forever. No transcript
 *     is ever deleted. AIB is told through `<AIB data>\studio-moved-chats.json` (the app only reads it).
 *   - Then those copies go, with their studio/* branches, refs/studio/*, git's worktree records and AIB's stash leftovers, using the
 *     app's own cleanup code (server/worktrees/cleanup.ts: only what THIS AIB install made; never unmerged work; never another
 *     install's items). Helpers' copies are left to the app.
 *   - Empty copy-named folders in ~/.claude/projects are removed with a plain, non-recursive rmdir (a folder with anything in it,
 *     e.g. memory/, stays).
 *   - Old copy chats WITH unmerged work are only listed, each with two ways on: ask the chat's agent to merge it (AIB has no Merge
 *     button any more: chat-first), or name it with `--discard "<chat title or id>"` to throw its unmerged work away here. A
 *     discarded chat's copy goes with its branch and refs (its work is gone for good), and the chat itself is re-filed under its
 *     project folder like the others (transcript backed up first), so it carries on there.
 *
 * Usage (from the repo folder; AIB and its keeper must be quit):
 *   deno run -A --config outputs/agent-studio/deno.json work/migrate/folder_chats_migrate.ts           dry run: prints the plan
 *   deno run -A --config outputs/agent-studio/deno.json work/migrate/folder_chats_migrate.ts --apply   does it
 *   ... --discard "Fix the login page" --discard claude:1234abcd [--apply]   also discards those chats' unmerged work
 * Safe to run again: whatever is done is skipped.
 *
 * Options: --data <AIB data folder> (default %LOCALAPPDATA%\AgentStudio; inside a WSL distro: required, the path the Windows run
 * prints), --claude-dir <dir> (default CLAUDE_CONFIG_DIR, else ~/.claude), --codex-home <dir> (default CODEX_HOME, else ~/.codex),
 * --codex-adapter <command as a JSON array> (default: the adapter AIB itself would start), --discard "<chat title or id>" (repeatable:
 * an old copy chat with unmerged work, by the title the dry run prints, or its id as provider:sessionId or just the sessionId; a title
 * two such chats share is refused, use the id).
 *
 * WSL projects: their copies, registry and transcripts live in the distro. The Windows run prints the command to run inside each
 * distro (it needs deno there); the script then does the same work natively in the distro.
 */
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import * as cleanup from '../../outputs/agent-studio/server/worktrees/cleanup.ts';
import { tryLockNow } from '../../outputs/agent-studio/server/platform/lock.ts';
import { LOCK_FILE } from '../../outputs/agent-studio/server/desktop/single_instance.ts';
import { keeperRunning } from '../../outputs/agent-studio/server/keeper/client.ts';
import { AddedProjects } from '../../outputs/agent-studio/server/desktop/added_projects.ts';
import { pathOf, userStateDir } from '../../outputs/agent-studio/server/state/paths.ts';
import { wslLocOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { dataDirName } from '../../outputs/agent-studio/server/wsl/install.ts';
import { WSL_ROOT_DIR } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { resolveCodex } from '../../outputs/agent-studio/server/agents/adapters.ts';
import { home, isdir, join } from '../../outputs/agent-studio/server/platform/ospath.ts';
import * as core from './refile_core.ts';

const WIN = Deno.build.os === 'windows';
/** A transcript written to this recently may be open in a terminal or VS Code: left for the next run. */
const BUSY_MS = 5 * 60_000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const say = (text = '') => console.log(text);

// ---- options -------------------------------------------------------------------------------------------------------------------
interface Options {
  apply: boolean;
  data: string;
  claudeProjects: string;
  codexHome: string;
  codexAdapter: string[] | null;
  /** --discard names: old copy chats whose unmerged work the owner throws away. */
  discard: string[];
}

function parseArgs(args: string[]): Options {
  const value = (name: string): string => {
    const at = args.indexOf(name);
    if (at < 0) return '';
    const v = args[at + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const known = new Set(['--apply', '--data', '--claude-dir', '--codex-home', '--codex-adapter', '--discard']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`unknown option ${args[i]}`);
    if (args[i] !== '--apply') i++;
  }
  const data = value('--data') || (WIN ? userStateDir() : '');
  if (!data) throw new Error('--data <AIB data folder> is needed here (the Windows run prints the command for each distro)');
  const claudeDir = value('--claude-dir') || Deno.env.get('CLAUDE_CONFIG_DIR') || join(home(), '.claude');
  const codexHome = value('--codex-home') || Deno.env.get('CODEX_HOME') || join(home(), '.codex');
  const adapter = value('--codex-adapter');
  const discard: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--discard') continue;
    const v = (args[i + 1] ?? '').trim();
    if (!v || args[i + 1].startsWith('--')) throw new Error('--discard needs a chat title or id');
    discard.push(v);
  }
  return {
    apply: args.includes('--apply'),
    data,
    claudeProjects: join(claudeDir, 'projects'),
    codexHome,
    codexAdapter: adapter ? JSON.parse(adapter) : null,
    discard,
  };
}

// ---- AIB must be quit ----------------------------------------------------------------------------------------------------------
/** '' when no AIB runs for this data folder, else what does. On success the data folder's lock is held until the script ends. */
async function refuseWhileRunning(data: string): Promise<string> {
  if (keeperRunning(data)) return "AIB's keeper is running for this data folder";
  if (!WIN) {
    // inside a distro: the Linux keeper and the WSL helper of this data folder
    try {
      for (const e of Deno.readDirSync('/proc')) {
        if (!/^\d+$/.test(e.name) || Number(e.name) === Deno.pid) continue;
        let cmd = '';
        try {
          cmd = Deno.readTextFileSync(`/proc/${e.name}/cmdline`).replaceAll('\0', ' ');
        } catch {
          continue;
        }
        if (/AIB-(keeper|wsl-helper)/.test(cmd) && cmd.includes(data)) return `an AIB process is running for this data folder (pid ${e.name})`;
      }
    } catch { /* no /proc */ }
  }
  try {
    // the lock every AIB holds on its data folder while it runs (desktop/single_instance.ts): taken here, AIB cannot start meanwhile
    held.push(await tryLockNow(pathOf(data, LOCK_FILE), true));
  } catch {
    return 'AIB is running (its data folder is locked)';
  }
  return '';
}
const held: Deno.FsFile[] = [];

// ---- what there is -------------------------------------------------------------------------------------------------------------
interface Chat {
  session: string;
  provider: string;
  sessionId: string;
  /** The copy folder it worked in. */
  from: string;
  project: string;
  /** The cleanup item id of its copy (null: the copy is already gone). */
  copyId: string | null;
  title: string;
}

function projectsOf(data: string, manager: wt.Manager): { local: string[]; wsl: Map<string, string[]> } {
  const all = new Map<string, string>();
  const add = (p: string) => {
    if (p) all.set(p.startsWith('wsl://') ? p : wt.norm(p), p);
  };
  try {
    for (const a of Object.values(new AddedProjects(data).public().added)) add(str((a as { path?: unknown }).path));
  } catch { /* no list */ }
  for (const r of Object.values(manager.registry.all())) add(str(r.project));
  for (const n of Object.values(manager.registry.removed())) add(str(n.project));
  const local: string[] = [];
  const wsl = new Map<string, string[]>();
  for (const p of all.values()) {
    const loc = p.startsWith('wsl://') ? wslLocOf(p) : null;
    if (loc) wsl.set(loc.distro, [...(wsl.get(loc.distro) ?? []), loc.linuxPath]);
    else if (!p.startsWith('wsl://')) local.push(p);
  }
  return { local, wsl };
}

const isHelperBranch = (branch: string) => branch.startsWith('studio/helper-');

function splitSession(session: string): [string, string] | null {
  const at = session.indexOf(':');
  return at > 0 ? [session.slice(0, at), session.slice(at + 1)] : null;
}

const recent = (file: string | null) => {
  if (!file) return false;
  try {
    const m = Deno.statSync(file).mtime;
    return !!m && Date.now() - m.getTime() < BUSY_MS;
  } catch {
    return false;
  }
};

// ---- Codex: open once in the project folder ------------------------------------------------------------------------------------
async function codexCommand(opts: Options): Promise<string[] | null> {
  if (opts.codexAdapter) return opts.codexAdapter;
  const row = await resolveCodex({ stateDir: opts.data });
  return row.found && row.argv.length ? row.argv : null;
}

/** ACP: initialize, session/load {sessionId, cwd: project} with no prompt, then close. Codex files the chat under `project` itself. */
export async function codexLoad(argv: string[], codexHome: string, sessionId: string, project: string): Promise<void> {
  const child = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'null',
    env: { CODEX_HOME: codexHome },
  }).spawn();
  const writer = child.stdin.getWriter();
  const enc = new TextEncoder();
  const send = (msg: unknown) => writer.write(enc.encode(JSON.stringify(msg) + '\n'));
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of child.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.method && m.id !== undefined) await send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } });
        else if (m.id !== undefined && waiting.has(Number(m.id))) waiting.get(Number(m.id))!(m);
      }
    }
  })();
  const call = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer in 90 s`)), 90_000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`));
        else resolve(m);
      });
      void send({ jsonrpc: '2.0', id, method, params });
    });
  try {
    await call(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    await call(2, 'session/load', { sessionId, cwd: project, mcpServers: [] });
  } finally {
    try {
      await writer.close();
    } catch { /* gone */ }
    try {
      child.kill();
    } catch { /* ended */ }
    await child.status;
    await reading.catch(() => {});
  }
}

// ---- one chat ------------------------------------------------------------------------------------------------------------------
interface ChatDone {
  ok: boolean;
  text: string;
}

async function refileChat(opts: Options, chat: Chat, codexArgv: () => Promise<string[] | null>): Promise<ChatDone> {
  const moved = core.readMoved(opts.data)[chat.session];
  const record = async (refiled: string, backup: string) =>
    await core.recordMoved(opts.data, chat.provider, chat.sessionId, {
      project: chat.project,
      from: chat.from,
      why: 'migrated',
      at: Date.now() / 1000,
      refiled,
      backup,
    });
  if (chat.provider === 'claude') {
    const src = core.findClaudeFile(opts.claudeProjects, chat.sessionId, chat.from);
    if (moved && !src) return { ok: true, text: 'already moved' };
    if (recent(src)) return { ok: false, text: 'its transcript changed in the last 5 minutes (open somewhere?): left for the next run' };
    if (!opts.apply) {
      return { ok: true, text: src ? `would move ${src} under the project (backup kept)` : 'no transcript found: nothing to move' };
    }
    const done = core.refileClaude({ stateDir: opts.data, projectsRoot: opts.claudeProjects, sessionId: chat.sessionId, from: chat.from, to: chat.project });
    if (done.outcome === 'moved' || done.outcome === 'already' || done.outcome === 'missing') {
      await record(done.path, done.backup || moved?.backup || '');
      const text = done.outcome === 'moved'
        ? `moved to ${done.path} (backup ${done.backup})`
        : done.outcome === 'already' ? 'already moved' : 'no transcript found: nothing to move';
      return { ok: true, text };
    }
    return { ok: false, text: `not moved: ${done.outcome}${done.message ? ` (${done.message})` : ''}` };
  }
  if (chat.provider === 'codex') {
    if (moved) return { ok: true, text: 'already moved' };
    const rollout = core.findCodexRollout(opts.codexHome, chat.sessionId);
    if (recent(rollout)) return { ok: false, text: 'its rollout changed in the last 5 minutes (open somewhere?): left for the next run' };
    if (!rollout) {
      if (opts.apply) await record('', '');
      return { ok: true, text: 'no rollout found: nothing to move' };
    }
    if (!opts.apply) return { ok: true, text: `would back up ${rollout} and open it once in the project folder (Codex re-files it)` };
    const argv = await codexArgv();
    if (!argv) return { ok: false, text: 'the Codex ACP adapter was not found (pass --codex-adapter): left for the next run' };
    const done = await core.refileCodex({
      stateDir: opts.data,
      codexHome: opts.codexHome,
      sessionId: chat.sessionId,
      load: () => codexLoad(argv, opts.codexHome, chat.sessionId, chat.project),
    });
    if (done.outcome !== 'moved') return { ok: false, text: `not moved: ${done.message}` };
    await record(done.path, done.backup);
    return { ok: true, text: `opened once in the project folder (backup ${done.backup})` };
  }
  // another agent: AIB opens it in the project folder; its own store is left as it is
  if (moved) return { ok: true, text: 'already moved' };
  if (opts.apply) await record('', '');
  return { ok: true, text: `${chat.provider}: AIB will open it in the project folder (its agent's files are not changed)` };
}

// ---- --discard -----------------------------------------------------------------------------------------------------------------
/** An old copy chat with unmerged work (not a helper's copy, not another install's). */
const unmergedChat = (i: cleanup.CleanupItem) => i.own && i.unmerged && i.kind === 'copy' && i.id.startsWith('copy:') && !!i.session && !i.helper;

/** Does a --discard name pick this chat: its title (any case), its provider:sessionId, or its sessionId. */
export function names(name: string, item: { title: string; session: string }): boolean {
  const n = name.trim();
  if (!n) return false;
  const parts = splitSession(item.session);
  return n === item.session || (!!parts && n === parts[1]) || (!!item.title && n.toLowerCase() === item.title.trim().toLowerCase());
}

/** What the dry run tells the owner to type for this chat: its title when that alone names it, else its id. */
function discardOption(item: cleanup.CleanupItem, all: cleanup.CleanupItem[]): string {
  const byTitle = item.title && !item.title.includes('"') && all.filter((o) => names(item.title, o)).length === 1;
  return `--discard "${byTitle ? item.title : item.session}"`;
}

interface Discards {
  /** Copy ids (copy:<key>) the owner named: their unmerged work goes. */
  ids: Set<string>;
  /** Every old copy chat with unmerged work, in every project (for the option text). */
  all: cleanup.CleanupItem[];
}

/** Matches the --discard names against every project's old copy chats with unmerged work; a name that matches none or several is said. */
async function resolveDiscards(opts: Options, projects: string[]): Promise<Discards> {
  const all: cleanup.CleanupItem[] = [];
  for (const project of projects) {
    if (!isdir(project)) continue;
    const scan = await cleanup.scanProject(opts.data, project, { live: [] });
    if (!scan.skipped) all.push(...scan.items.filter(unmergedChat));
  }
  const ids = new Set<string>();
  for (const name of opts.discard) {
    const hits = all.filter((i) => names(name, i));
    if (hits.length === 1) ids.add(hits[0].id);
    else if (!hits.length) say(`--discard "${name}": no old copy chat with unmerged work has that title or id (already done?): nothing to discard`);
    else {
      say(`--discard "${name}": ${hits.length} chats have that title, so none is discarded. Name one by its id:`);
      for (const h of hits) say(`   --discard "${h.session}"   (${h.path})`);
    }
  }
  return { ids, all };
}

// ---- one project ---------------------------------------------------------------------------------------------------------------
interface Totals {
  moved: number;
  removed: number;
  unmerged: number;
  discarded: number;
  failed: number;
}

async function migrateProject(
  opts: Options,
  manager: wt.Manager,
  project: string,
  totals: Totals,
  codexArgv: () => Promise<string[] | null>,
  discards: Discards,
) {
  say(`\n== ${project}`);
  if (!isdir(project)) {
    say('   the folder is gone: skipped');
    return;
  }
  const scan = await cleanup.scanProject(opts.data, project, { live: [] });
  if (scan.skipped) {
    say(`   skipped: ${scan.skipped}`);
    return;
  }
  const chats: Chat[] = [];
  const unmergedChats: cleanup.CleanupItem[] = [];
  const discardChats: cleanup.CleanupItem[] = [];
  const leftovers: cleanup.CleanupItem[] = [];
  const keptWork: cleanup.CleanupItem[] = [];
  const others: cleanup.CleanupItem[] = [];
  const seen = new Set<string>();
  for (const i of scan.items) {
    const chatCopy = i.kind === 'copy' && i.id.startsWith('copy:') && !!i.session && !i.helper;
    if (!i.own) others.push(i);
    else if (chatCopy) {
      seen.add(i.session);
      if (i.unmerged) (discards.ids.has(i.id) && unmergedChat(i) ? discardChats : unmergedChats).push(i);
      else {
        const parts = splitSession(i.session);
        if (parts) chats.push({ session: i.session, provider: parts[0], sessionId: parts[1], from: i.path, project, copyId: i.id, title: i.title });
      }
    } else if (i.kind === 'copy' && i.id.startsWith('copy:') && i.helper) continue; // helpers' copies: the app's own rules
    else if (i.unmerged) keptWork.push(i);
    else leftovers.push(i);
  }
  // chats whose copy is already gone (discarded, deleted, or removed by an earlier run): their removed-notes
  for (const [path, note] of Object.entries(manager.registry.removed())) {
    const session = str(note.session);
    if (!session || seen.has(session) || !wt.same(str(note.project), project) || isHelperBranch(str(note.branch))) continue;
    seen.add(session);
    const parts = splitSession(session);
    if (!parts) continue;
    chats.push({ session, provider: parts[0], sessionId: parts[1], from: str(note.path) || path, project, copyId: null, title: str(note.branch) });
  }

  const removeIds: string[] = [];
  for (const chat of chats) {
    const done = await refileChat(opts, chat, codexArgv);
    const what = `${chat.provider} chat ${chat.sessionId}${chat.title ? ` (${chat.title})` : ''}`;
    if (done.text === 'already moved' && !chat.copyId) continue; // nothing new: quiet on a rerun
    say(`   ${opts.apply ? (done.ok ? 'done' : 'LEFT') : 'plan'}: ${what}: ${done.text}`);
    if (!done.ok) totals.failed++;
    else if (done.text !== 'already moved') totals.moved++;
    if (done.ok && chat.copyId) {
      removeIds.push(chat.copyId);
      say(`         ${opts.apply ? 'and its copy goes' : 'then remove its copy'}: ${chat.from}`);
    }
  }
  // the chats the owner named with --discard: re-filed like the others, then their copy goes WITH its unmerged work (ticked)
  const discardIds: string[] = [];
  for (const i of discardChats) {
    const parts = splitSession(i.session)!;
    const chat: Chat = { session: i.session, provider: parts[0], sessionId: parts[1], from: i.path, project, copyId: i.id, title: i.title };
    const lost = `its unmerged work${i.files > 0 ? ` (${i.files} file${i.files === 1 ? '' : 's'})` : ''} in ${i.path}`;
    const done = await refileChat(opts, chat, codexArgv);
    say(`   ${opts.apply ? (done.ok ? 'done' : 'LEFT') : 'plan'}: discard chat "${i.title}" (${i.session}): ${done.text}`);
    if (!done.ok) {
      totals.failed++;
      say(`         its copy is kept (nothing discarded) until the chat can be moved`);
      continue;
    }
    if (done.text !== 'already moved') totals.moved++;
    removeIds.push(i.id);
    discardIds.push(i.id);
    say(`         ${opts.apply ? 'and its copy goes with' : 'then delete its copy with'} ${lost}, its branch ${i.branch} and refs`);
  }
  for (const i of leftovers) {
    removeIds.push(i.id);
    say(`   ${opts.apply ? 'remove' : 'plan: remove'} ${i.kind} ${i.title || i.path || i.branch} (nothing unmerged)`);
  }
  for (const i of unmergedChats) {
    totals.unmerged++;
    say(`   NOT TOUCHED: chat "${i.title}" (${i.session}) has unmerged work${i.files > 0 ? ` (${i.files} file${i.files === 1 ? '' : 's'})` : ''}` +
      ` in ${i.path}.`);
    say(`         to discard that work, run this again with: ${discardOption(i, discards.all)}`);
    say(`         or ask the chat's agent to merge it (open the chat in AIB), then run this again`);
  }
  for (const i of keptWork) {
    totals.unmerged++;
    say(`   NOT TOUCHED: ${i.kind} ${i.title || i.path} holds work that was never merged. Removing the project in AIB offers it.`);
  }
  if (others.length) say(`   left alone: ${others.length} item(s) made by another AIB install (a test build or the dev copy)`);
  if (!removeIds.length) return;
  if (!opts.apply) {
    totals.removed += removeIds.length;
    totals.discarded += discardIds.length;
    return;
  }
  const done = await cleanup.applyProject(opts.data, project, discardIds, { live: [], only: removeIds });
  totals.removed += done.removed.length;
  totals.discarded += discardIds.filter((id) => done.removed.includes(id)).length;
  for (const id of done.removed) cleanup.logLine(opts.data, `folder-chats migration: ${project}: removed ${id}`);
  for (const [id, why] of Object.entries(done.left)) {
    totals.failed++;
    say(`   LEFT ${id}: ${why}`);
    cleanup.logLine(opts.data, `folder-chats migration: ${project}: left ${id}: ${why}`);
  }
  for (const id of removeIds) if (!done.removed.includes(id) && !(id in done.left)) say(`   not removed now: ${id} (changed since the scan)`);
}

// ---- empty copy-named folders --------------------------------------------------------------------------------------------------
function emptyFolders(opts: Options, root: string, totals: Totals): void {
  if (!isdir(opts.claudeProjects)) return;
  if (opts.apply) {
    const [removed] = core.cleanEmptyCopyFolders(opts.claudeProjects, root);
    for (const dir of removed) say(`   removed empty folder ${dir}`);
    totals.removed += removed.length;
    return;
  }
  for (const e of Deno.readDirSync(opts.claudeProjects)) {
    if (!e.isDirectory || !core.isCopyNamed(e.name, root)) continue;
    const dir = join(opts.claudeProjects, e.name);
    if ([...Deno.readDirSync(dir)].length === 0) {
      say(`   plan: remove empty folder ${dir}`);
      totals.removed++;
    }
  }
}

// ---- main ----------------------------------------------------------------------------------------------------------------------
function linuxPathOf(windowsPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll('\\', '/')}` : windowsPath.replaceAll('\\', '/');
}

export async function main(args: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(args);
  } catch (error) {
    console.error(`folder_chats_migrate: ${error instanceof Error ? error.message : error}`);
    return 2;
  }
  if (!isdir(opts.data)) {
    console.error(`folder_chats_migrate: no AIB data folder at ${opts.data}`);
    return 2;
  }
  const running = await refuseWhileRunning(opts.data);
  if (running) {
    console.error(`folder_chats_migrate: ${running}. Quit AIB (and its keeper: tray > Quit) first, then run this again. Nothing was changed.`);
    return 3;
  }
  try {
    say(`AIB folder-chats migration: ${opts.apply ? 'APPLYING' : 'dry run (nothing is changed; add --apply to do it)'}`);
    say(`AIB data: ${opts.data}`);
    say(`Claude Code transcripts: ${opts.claudeProjects}`);
    say(`Codex home: ${opts.codexHome}`);
    const manager = new wt.Manager(opts.data);
    const { local, wsl } = projectsOf(opts.data, manager);
    const totals: Totals = { moved: 0, removed: 0, unmerged: 0, discarded: 0, failed: 0 };
    let argv: Promise<string[] | null> | null = null;
    const codexArgv = () => (argv ??= codexCommand(opts));
    const discards = await resolveDiscards(opts, local);
    for (const project of local) await migrateProject(opts, manager, project, totals, codexArgv, discards);
    say('\n== empty copy-named folders in Claude Code\'s projects folder');
    emptyFolders(opts, manager.registry.root, totals);
    say('\n== summary');
    const verb = opts.apply ? '' : 'to be ';
    say(`   chats ${verb}moved to their project folder: ${totals.moved}`);
    say(`   copies, branches, refs, stashes and folders ${verb}removed: ${totals.removed}`);
    if (opts.discard.length) say(`   chats whose unmerged work is ${opts.apply ? '' : 'to be '}discarded (--discard): ${totals.discarded}`);
    say(`   with unmerged work, not touched: ${totals.unmerged}${
      totals.unmerged ? " (ask each chat's agent to merge it, or discard it with the --discard shown above; then run this again)" : ''
    }`);
    if (totals.failed) say(`   left for the next run (see LEFT above): ${totals.failed}`);
    if (wsl.size && WIN) {
      const script = linuxPathOf(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      const config = linuxPathOf(join(new URL('../../outputs/agent-studio/deno.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
      say('\n== WSL projects: run this inside each distro too (needs deno there: curl -fsSL https://deno.land/install.sh | sh)');
      for (const [distro, paths] of wsl) {
        say(`   ${distro}: ${paths.join(', ')}`);
        say(`     wsl -d ${distro} -- bash -lc 'deno run -A --config ${config} ${script} --data "$HOME/${WSL_ROOT_DIR}/${dataDirName(opts.data)}"${opts.apply ? ' --apply' : ''}'`);
        if (opts.discard.length) say('     (add the same --discard options there; mind the quotes inside the bash -lc string)');
      }
    }
    if (!opts.apply) say('\nThis was a dry run. Run again with --apply to do it.');
    return 0;
  } finally {
    for (const lock of held) {
      try {
        lock.close();
      } catch { /* gone */ }
    }
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
